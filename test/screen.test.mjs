#!/usr/bin/env node
/**
 * Acceptance tests for media-senses screen capture + token-aligned sheet packing.
 *
 * Run: node test/screen.test.mjs
 *
 * Prints PASS/FAIL per assertion block and exits non-zero when anything fails.
 * The suite includes a REAL capture of the current Windows desktop, because the
 * whole point of this module is that "look at the screen now" actually works on
 * this machine (gdigrab), and because a locked/secure desktop shows up as a
 * uniformly black frame -- the tests prove we are not silently capturing black.
 *
 * Artifacts (a real captured still, a real 6-frame sheet, a synthetic sheet) are
 * written to test/fixtures/artifacts/screen/ and their paths are printed so a
 * human can open them.
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWorkDir, removeWorkDir, resolveTools } from '../lib/ffmpeg.js'
import { Canvas } from '../lib/png.js'
import {
  analyseRgb,
  buildSheet,
  captureFrames,
  listSources,
  planSheet,
  QUALITY_TIERS,
  TOKEN_CELL,
  tokenEstimateFor,
} from '../lib/screen.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODULE_ROOT = dirname(HERE)
const SCREEN_MODULE = join(MODULE_ROOT, 'lib', 'screen.js')
const ARTIFACTS = join(HERE, 'fixtures', 'artifacts', 'screen')
const SYNTHETIC_SHEET = join(ARTIFACTS, 'sheet-synthetic-6-frames.png')
const REAL_SHEET = join(ARTIFACTS, 'sheet-real-6-frames.png')

let passed = 0
let failed = 0
let tools
let workDir
let realStill
let realSheetSummary
const artifactNotes = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(`FAIL  ${name}`)
    console.log(`      ${message.split(/\r?\n/u).join('\n      ')}`)
  }
}

// ---------------------------------------------------------------------------
// Small independent helpers (the test does not trust the module's internals)
// ---------------------------------------------------------------------------

function pngDimensions(buffer) {
  assert.ok(buffer.length > 24, 'PNG buffer is too small to carry an IHDR')
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'file is not a PNG')
  assert.equal(buffer.subarray(12, 16).toString('latin1'), 'IHDR', 'PNG has no IHDR header')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

async function pngDimensionsOf(path) {
  return pngDimensions(await readFile(path))
}

function runBuffer(binary, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      binary,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`${binary} failed: ${stderr?.toString('utf8') ?? error.message}`))
          return
        }
        resolvePromise(stdout)
      },
    )
  })
}

/** Decode any image the way a model's read_image would see it: raw rgb24. */
async function decodeToRgb(path) {
  const dimensions = await pngDimensionsOf(path)
  const rgb = await runBuffer(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  assert.ok(rgb.length >= dimensions.width * dimensions.height * 3, 'decoded raster is smaller than its PNG header claims')
  return { rgb, width: dimensions.width, height: dimensions.height }
}

/** Independent pixel statistics: mean luminance, variance and distinct colours. */
function rgbStats({ rgb }) {
  const pixels = Math.floor(rgb.length / 3)
  const colours = new Set()
  let sum = 0
  let sumSq = 0
  for (let offset = 0; offset + 2 < rgb.length; offset += 3) {
    const r = rgb[offset]
    const g = rgb[offset + 1]
    const b = rgb[offset + 2]
    colours.add((r << 16) | (g << 8) | b)
    const luma = (r * 299 + g * 587 + b * 114) / 1000
    sum += luma
    sumSq += luma * luma
  }
  const mean = sum / pixels
  return { mean, variance: Math.max(0, sumSq / pixels - mean * mean), distinctColours: colours.size }
}

/** Mean of the three channels over a w x h rectangle of an rgb24 raster. */
function regionMean(raster, x, y, width, height) {
  let total = 0
  let count = 0
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = ((y + row) * raster.width + (x + column)) * 3
      total += raster.rgb[offset] + raster.rgb[offset + 1] + raster.rgb[offset + 2]
      count += 3
    }
  }
  return total / count
}

function regionHasWhitePixel(raster, x, y, width, height) {
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = ((y + row) * raster.width + (x + column)) * 3
      if (raster.rgb[offset] > 235 && raster.rgb[offset + 1] > 235 && raster.rgb[offset + 2] > 235) return true
    }
  }
  return false
}

/** Assert a value is JSON-serialisable with only finite numbers / plain data. */
function assertJsonSafe(value, label = 'value') {
  const walk = (item, path) => {
    if (item === null) return
    if (typeof item === 'number') {
      assert.ok(Number.isFinite(item), `${path} is not a finite number (${item})`)
      return
    }
    if (typeof item === 'string' || typeof item === 'boolean') return
    if (Buffer.isBuffer(item)) throw new Error(`${path} is a Buffer (not JSON-serialisable)`)
    if (Array.isArray(item)) {
      item.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      return
    }
    assert.equal(typeof item, 'object', `${path} has unsupported type ${typeof item}`)
    assert.ok(!(item instanceof Date) && !(item instanceof Map) && !(item instanceof Set), `${path} is not plain data`)
    for (const [key, entry] of Object.entries(item)) {
      assert.notEqual(entry, undefined, `${path}.${key} is undefined`)
      walk(entry, `${path}.${key}`)
    }
  }
  walk(value, label)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} does not survive a JSON round-trip unchanged`)
}

// ---------------------------------------------------------------------------
// Synthetic frame generation (rgb24 buffer + a white 3x5 digit in the middle)
// ---------------------------------------------------------------------------

const FRAME_COLOURS = [
  [214, 110, 40],
  [40, 170, 80],
  [50, 95, 210],
  [205, 60, 150],
  [225, 200, 55],
  [80, 210, 215],
]

const TEST_GLYPHS = {
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '.': ['000', '000', '000', '000', '010'],
}

function paintDigit(rgb, width, x0, y0, text, scale = 4, colour = [255, 255, 255]) {
  for (let index = 0; index < text.length; index += 1) {
    const glyph = TEST_GLYPHS[text[index]]
    if (glyph === undefined) continue
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (glyph[row][column] !== '1') continue
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = x0 + (index * 4 + column) * scale + dx
            const y = y0 + row * scale + dy
            const offset = (y * width + x) * 3
            rgb[offset] = colour[0]
            rgb[offset + 1] = colour[1]
            rgb[offset + 2] = colour[2]
          }
        }
      }
    }
  }
}

function syntheticFrame(index, width = 320, height = 180, label) {
  const colour = FRAME_COLOURS[index % FRAME_COLOURS.length]
  const rgb = Buffer.alloc(width * height * 3)
  for (let offset = 0; offset < rgb.length; offset += 3) {
    rgb[offset] = colour[0]
    rgb[offset + 1] = colour[1]
    rgb[offset + 2] = colour[2]
  }
  paintDigit(rgb, width, Math.floor(width / 2) - 10, Math.floor(height / 2) - 10, String(index + 1))
  const frame = { rgb, width, height }
  if (label !== undefined) frame.label = label
  return frame
}

async function saveRgbPng(path, rgb, width, height) {
  const canvas = new Canvas(width, height)
  for (let pixel = 0, offset = 0; pixel < width * height; pixel += 1, offset += 3) {
    const target = pixel * 4
    canvas.data[target] = rgb[offset]
    canvas.data[target + 1] = rgb[offset + 1]
    canvas.data[target + 2] = rgb[offset + 2]
    canvas.data[target + 3] = 255
  }
  await canvas.save(path)
  return path
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  tools = await resolveTools()
} catch (error) {
  console.error(`FAIL  cannot resolve ffmpeg/ffprobe: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
await mkdir(ARTIFACTS, { recursive: true })
// Each run writes a timestamped still; drop the previous run's stills so the
// artifacts directory stays reviewable (sheets are overwritten deterministically).
for (const entry of await readdir(ARTIFACTS)) {
  if (/^screen-.*\.png$/u.test(entry)) await rm(join(ARTIFACTS, entry), { force: true })
}
workDir = await makeWorkDir('media-senses-screen-test')

try {
  // -------------------------------------------------------------------------
  // planSheet: token arithmetic + geometry invariants
  // -------------------------------------------------------------------------
  await check('planSheet canvas widths are exact multiples of the 42 px token cell for 1/4/8 frames at every tier', async () => {
    for (const quality of Object.keys(QUALITY_TIERS)) {
      for (const frameCount of [1, 4, 8]) {
        const plan = planSheet({ frameCount, sourceWidth: 3072, sourceHeight: 1920, quality })
        assert.equal(plan.canvasWidth, QUALITY_TIERS[quality].width, `${quality}/${frameCount}: unexpected tier width`)
        assert.equal(plan.canvasWidth % TOKEN_CELL, 0, `${quality}/${frameCount}: ${plan.canvasWidth} is not a multiple of 42`)
        assert.ok(Number.isInteger(plan.canvasHeight) && plan.canvasHeight > 0, 'canvasHeight must be a positive integer')
        assert.ok(Number.isInteger(plan.cellWidth) && plan.cellWidth > 0, 'cellWidth must be a positive integer')
        assert.ok(Number.isInteger(plan.cellHeight) && plan.cellHeight > 0, 'cellHeight must be a positive integer')
      }
    }
  })

  await check('planSheet grid covers frameCount and rows/columns agree', async () => {
    for (const quality of Object.keys(QUALITY_TIERS)) {
      for (const frameCount of [1, 2, 4, 5, 6, 8, 9, 12]) {
        const plan = planSheet({ frameCount, sourceWidth: 3072, sourceHeight: 1920, quality })
        assert.ok(plan.columns * plan.rows >= frameCount, `grid ${plan.columns}x${plan.rows} cannot hold ${frameCount}`)
        assert.equal(plan.columns, Math.min(frameCount, Math.ceil(Math.sqrt(frameCount))), 'unexpected column policy')
        assert.equal(plan.rows, Math.ceil(frameCount / plan.columns), 'rows must be ceil(frameCount / columns)')
        assert.equal(
          plan.canvasHeight,
          plan.rows * plan.cellHeight + (plan.rows + 1) * plan.gap,
          'canvasHeight must exactly fit rows * cellHeight plus the gaps',
        )
        assert.ok(plan.columns * plan.cellWidth + (plan.columns + 1) * plan.gap <= plan.canvasWidth, 'grid must fit the canvas width')
      }
    }
  })

  await check('planSheet preserves the source aspect ratio within 1 px per cell', async () => {
    const sources = [
      [3072, 1920],
      [1920, 1080],
      [1080, 1920],
      [1024, 1024],
    ]
    for (const quality of Object.keys(QUALITY_TIERS)) {
      for (const frameCount of [1, 4, 8]) {
        for (const [sourceWidth, sourceHeight] of sources) {
          const plan = planSheet({ frameCount, sourceWidth, sourceHeight, quality })
          const idealCellHeight = (plan.cellWidth * sourceHeight) / sourceWidth
          assert.ok(
            Math.abs(plan.cellHeight - idealCellHeight) <= 1,
            `${quality}/${frameCount}/${sourceWidth}x${sourceHeight}: cell ${plan.cellWidth}x${plan.cellHeight} ` +
              `breaks aspect (ideal height ${idealCellHeight.toFixed(2)})`,
          )
        }
      }
    }
  })

  await check('planSheet tokenEstimate matches rows x (cols + 1) + 2 and reproduces the upstream documented numbers', async () => {
    assert.equal(tokenEstimateFor(798, 462), 222, '798x462 should be 222 tokens (19 cols x 11 rows)')
    assert.equal(tokenEstimateFor(1050, 630), 392, '1050x630 should be 392 tokens (25 cols x 15 rows)')
    assert.equal(tokenEstimateFor(1260, 756), 560, '1260x756 should be 560 tokens (30 cols x 18 rows)')
    assert.equal(tokenEstimateFor(1596, 924), 860, '1596x924 should be 860 tokens (38 cols x 22 rows)')
    for (const quality of Object.keys(QUALITY_TIERS)) {
      for (const frameCount of [1, 4, 8]) {
        const plan = planSheet({ frameCount, sourceWidth: 3072, sourceHeight: 1920, quality })
        const columns = Math.ceil(plan.canvasWidth / TOKEN_CELL)
        const rows = Math.ceil(plan.canvasHeight / TOKEN_CELL)
        assert.equal(plan.tokenEstimate, rows * (columns + 1) + 2, 'tokenEstimate does not match the formula')
        assert.ok(Number.isInteger(plan.tokenEstimate) && Number.isFinite(plan.tokenEstimate))
      }
    }
  })

  await check('planSheet documents the 6-frame low sheet: 798x334, 3x2 cells of 263x164, 162 tokens', async () => {
    const plan = planSheet({ frameCount: 6, sourceWidth: 3072, sourceHeight: 1920, quality: 'low' })
    assert.equal(plan.canvasWidth, 798)
    assert.equal(plan.canvasHeight, 334)
    assert.equal(plan.columns, 3)
    assert.equal(plan.rows, 2)
    assert.equal(plan.cellWidth, 263)
    assert.equal(plan.cellHeight, 164)
    assert.equal(plan.tokenEstimate, 162)
    assert.equal(plan.canvasWidth % 42, 0)
    // Documented arithmetic: 798 / 42 = 19 columns, 334 -> 8 rows, 8 * 20 + 2 = 162.
    assert.equal(Math.ceil(plan.canvasHeight / 42) * (Math.ceil(plan.canvasWidth / 42) + 1) + 2, plan.tokenEstimate)
  })

  await check('planSheet assumes a 16:9 source when dimensions are omitted, and rejects impossible frame counts', async () => {
    const plan = planSheet({ frameCount: 4, quality: 'standard' })
    assert.equal(plan.sourceAssumed, true)
    assert.equal(plan.sourceWidth, 1920)
    assert.equal(plan.sourceHeight, 1080)
    assert.equal(plan.canvasWidth % 42, 0)
    assert.throws(() => planSheet({ frameCount: 0 }), /frameCount >= 1/u)
    assert.throws(() => planSheet({ frameCount: -3 }), /frameCount >= 1/u)
    assert.throws(() => planSheet({ frameCount: 4, quality: 'impossible' }), /unknown quality/u)
  })

  await check('0 frames are rejected with a clear error', async () => {
    await assert.rejects(() => buildSheet({ frames: [] }), /at least one frame/u)
    await assert.rejects(() => buildSheet({}), /at least one frame/u)
    await assert.rejects(() => buildSheet({ frames: undefined }), /at least one frame/u)
  })

  // -------------------------------------------------------------------------
  // buildSheet: synthetic frames -> one token-aligned PNG
  // -------------------------------------------------------------------------
  const synthetic = Array.from({ length: 6 }, (_, index) => syntheticFrame(index))
  const syntheticPlan = planSheet({ frameCount: 6, sourceWidth: 320, sourceHeight: 180, quality: 'low' })
  let syntheticSheet

  await check('synthetic frame plan is deterministic (798x302, 3x2, 263x148 cells)', async () => {
    assert.equal(syntheticPlan.canvasWidth, 798)
    assert.equal(syntheticPlan.canvasHeight, 302)
    assert.equal(syntheticPlan.columns, 3)
    assert.equal(syntheticPlan.rows, 2)
    assert.equal(syntheticPlan.cellWidth, 263)
    assert.equal(syntheticPlan.cellHeight, 148)
    assert.equal(syntheticPlan.tokenEstimate, 162)
  })

  await check('buildSheet packs 6 frames into ONE PNG with the planned size, cells and token estimate', async () => {
    syntheticSheet = await buildSheet({
      frames: synthetic,
      width: syntheticPlan.canvasWidth,
      height: syntheticPlan.canvasHeight,
      columns: syntheticPlan.columns,
      outputPath: SYNTHETIC_SHEET,
    })
    assert.ok(Buffer.isBuffer(syntheticSheet.buffer), 'buildSheet must return the PNG buffer')
    assert.equal(syntheticSheet.pngPath, SYNTHETIC_SHEET)
    assert.equal(syntheticSheet.width, 798)
    assert.equal(syntheticSheet.width % 42, 0, 'sheet width must be a multiple of 42')
    assert.equal(syntheticSheet.height, 302)
    assert.equal(syntheticSheet.columns, 3)
    assert.equal(syntheticSheet.rows, 2)
    assert.equal(syntheticSheet.frameCount, 6)
    assert.equal(syntheticSheet.cells.length, 6)
    assert.equal(syntheticSheet.tokenEstimate, 162)
    assert.equal(syntheticSheet.tokenEstimate, tokenEstimateFor(syntheticSheet.width, syntheticSheet.height))
    const info = await stat(SYNTHETIC_SHEET)
    assert.equal(info.size, syntheticSheet.buffer.length, 'saved sheet bytes must equal the returned buffer')
    const header = pngDimensions(syntheticSheet.buffer)
    assert.deepEqual(header, { width: 798, height: 302 })
    assert.deepEqual(pngDimensions(await readFile(SYNTHETIC_SHEET)), header)
    assert.ok(!syntheticSheet.warnings.some((warning) => /not a multiple/u.test(warning)), 'planned dims should not need width alignment')
  })

  await check('cells are reported in row-major order with one badge per cell', async () => {
    assert.deepEqual(
      syntheticSheet.cells.map((cell) => `${cell.row},${cell.column}`),
      ['0,0', '0,1', '0,2', '1,0', '1,1', '1,2'],
      'cells must be row-major',
    )
    assert.deepEqual(syntheticSheet.cells.map((cell) => cell.index), [1, 2, 3, 4, 5, 6])
    assert.deepEqual(syntheticSheet.cells.map((cell) => cell.label), ['1', '2', '3', '4', '5', '6'])
    for (const cell of syntheticSheet.cells) {
      assert.ok(cell.x >= 0 && cell.y >= 0, 'cell origin must be inside the canvas')
      assert.ok(cell.x + cell.width <= syntheticSheet.width, 'cell must not overflow horizontally')
      assert.ok(cell.y + cell.height <= syntheticSheet.height, 'cell must not overflow vertically')
    }
    assert.equal(syntheticSheet.cells[1].x - syntheticSheet.cells[0].x, 265, 'column pitch should be cellWidth + gap')
    assert.equal(syntheticSheet.cells[3].y - syntheticSheet.cells[0].y, 150, 'row pitch should be cellHeight + gap')
  })

  await check('decoded sheet contains every frame colour and the burned-in badge is visibly dark with light digits', async () => {
    const raster = await decodeToRgb(SYNTHETIC_SHEET)
    assert.deepEqual({ width: raster.width, height: raster.height }, { width: 798, height: 302 })
    const stats = rgbStats(raster)
    assert.ok(stats.distinctColours >= 6, `sheet should contain the 6 frame colours, found ${stats.distinctColours} colours`)
    assert.ok(stats.variance > 100, `sheet should have visual variance, got ${stats.variance.toFixed(1)}`)
    const cell = syntheticSheet.cells[0]
    // Sample 6x6 inside the top-left badge plate: for label "1" the glyph's
    // first row is 010, so this corner is plate-only (dark).
    const badgeMean = regionMean(raster, cell.x + 3, cell.y + 3, 6, 6)
    const backgroundMean = regionMean(raster, cell.x + cell.width - 20, cell.y + cell.height - 20, 6, 6)
    assert.ok(
      badgeMean < backgroundMean * 0.7,
      `badge area (${badgeMean.toFixed(1)}) should be much darker than the frame background (${backgroundMean.toFixed(1)})`,
    )
    assert.ok(
      regionHasWhitePixel(raster, cell.x + 2, cell.y + 2, 40, 40),
      'badge digits should render as light pixels at the top-left of the cell',
    )
  })

  await check('buildSheet accepts { path } frames (decoded through ffmpeg) and labels containing a decimal point', async () => {
    const paths = []
    for (let index = 0; index < 6; index += 1) {
      paths.push(await saveRgbPng(join(workDir, `synthetic-${index}.png`), synthetic[index].rgb, 320, 180))
    }
    const fromPaths = await buildSheet({
      frames: paths.map((path, index) => ({ path, time: index * 0.5, label: `${index + 1}.0` })),
      width: syntheticPlan.canvasWidth,
      height: syntheticPlan.canvasHeight,
      columns: syntheticPlan.columns,
      outputPath: join(ARTIFACTS, 'sheet-from-paths.png'),
    })
    assert.equal(fromPaths.frameCount, 6)
    assert.equal(fromPaths.cells.length, 6)
    assert.equal(fromPaths.width, 798)
    assert.equal(fromPaths.width % 42, 0)
    assert.deepEqual(fromPaths.cells.map((cell) => cell.label), ['1.0', '2.0', '3.0', '4.0', '5.0', '6.0'])
    assert.deepEqual(fromPaths.cells.map((cell) => cell.time), [0, 0.5, 1, 1.5, 2, 2.5])
    assert.ok((await stat(fromPaths.pngPath)).size > 1000, 'path-based sheet PNG should be written')
  })

  await check('mismatched frame sizes are scaled into the cells without throwing', async () => {
    const mixed = []
    for (let index = 0; index < 6; index += 1) {
      mixed.push(index % 2 === 0 ? syntheticFrame(index, 320, 180) : syntheticFrame(index, 160, 90))
    }
    const sheet = await buildSheet({
      frames: mixed,
      width: syntheticPlan.canvasWidth,
      height: syntheticPlan.canvasHeight,
      columns: syntheticPlan.columns,
      outputPath: join(ARTIFACTS, 'sheet-mismatched.png'),
    })
    assert.equal(sheet.cells.length, 6)
    for (const cell of sheet.cells) {
      assert.ok(cell.width <= syntheticPlan.cellWidth && cell.height <= syntheticPlan.cellHeight, 'cell content must fit its box')
      // Aspect preserved: 320x180 -> ~263x148.
      assert.ok(Math.abs(cell.width * 180 - cell.height * 320) / 320 <= 1, 'mismatched frame lost its aspect ratio')
    }
    const raster = await decodeToRgb(sheet.pngPath)
    assert.deepEqual({ width: raster.width, height: raster.height }, { width: 798, height: 302 })
    assert.ok(rgbStats(raster).distinctColours >= 6, 'mismatched sheet should still show all frames')
  })

  await check('buildSheet aligns an unaligned canvas width down to a 42 px boundary and says so', async () => {
    const sheet = await buildSheet({
      frames: synthetic.slice(0, 2),
      width: 800,
      height: 300,
      columns: 2,
      outputPath: join(ARTIFACTS, 'sheet-aligned-800.png'),
    })
    assert.equal(sheet.width, 798, '800 px should align down to 798 px (19 columns)')
    assert.equal(sheet.width % 42, 0)
    assert.ok(sheet.warnings.some((warning) => /not a multiple of 42/u.test(warning)), 'alignment must be explained in warnings')
    assert.equal(sheet.tokenEstimate, tokenEstimateFor(sheet.width, sheet.height))
  })

  await check('buildSheet derives width/height/columns from planSheet when omitted, and its result is JSON-safe apart from the buffer', async () => {
    const sheet = await buildSheet({ frames: synthetic, outputPath: join(ARTIFACTS, 'sheet-defaults.png') })
    assert.equal(sheet.width, syntheticPlan.canvasWidth)
    assert.equal(sheet.height, syntheticPlan.canvasHeight)
    assert.equal(sheet.columns, syntheticPlan.columns)
    assert.equal(sheet.tokenEstimate, syntheticPlan.tokenEstimate)
    const { buffer, ...jsonPart } = sheet
    assert.ok(Buffer.isBuffer(buffer))
    assertJsonSafe(jsonPart, 'buildSheet result')
  })

  await check('analyseRgb flags a uniformly black frame so capture can report it instead of silently returning black', async () => {
    const black = analyseRgb(Buffer.alloc(120 * 80 * 3))
    assert.equal(black.uniform, true)
    assert.equal(black.meanLuminance, 0)
    assert.equal(black.dominantColour, '#000000')
    assert.equal(black.distinctColours, 1)
    const flat = analyseRgb(Buffer.from(Array.from({ length: 10 * 10 * 3 }, () => 77)))
    assert.equal(flat.uniform, true)
    assert.ok(flat.meanLuminance > 0)
    const real = analyseRgb(Buffer.from(Array.from({ length: 120 * 80 * 3 }, (_, index) => (index * 37) % 256)))
    assert.equal(real.uniform, false)
    assert.ok(real.distinctColours > 2)
  })

  // -------------------------------------------------------------------------
  // Real screen capture (this machine's actual desktop)
  // -------------------------------------------------------------------------
  await check('listSources reports a usable Windows capture engine (gdigrab is preferred)', async () => {
    const sources = await listSources({ tools })
    assert.equal(sources.screen, true, 'screen capture must be available on this machine')
    assert.equal(sources.platform, 'win32')
    assert.ok(Array.isArray(sources.engines) && sources.engines.length > 0, 'at least one engine must be reported')
    assert.ok(sources.engines.includes('gdigrab'), `gdigrab should be available (got ${sources.engines.join(', ')})`)
    assert.ok(sources.engines.includes('ddagrab'), `ddagrab should be listed too (got ${sources.engines.join(', ')})`)
    assert.equal(sources.engines[0], 'gdigrab', 'gdigrab must be tried first')
    assertJsonSafe(sources, 'listSources result')
  })

  await check('REAL ddagrab desktop-duplication path also captures a valid one-shot frame', async () => {
    // Exercises the fallback capture args end-to-end (captureFrames would use
    // ddagrab automatically when gdigrab is unavailable).
    const capture = await captureFrames({
      tools,
      workDir,
      outputDir: join(workDir, 'ddagrab'),
      options: { width: 400, engine: 'ddagrab' },
    })
    assert.equal(capture.engine, 'ddagrab')
    assert.equal(capture.frames.length, 1)
    const dimensions = await pngDimensionsOf(capture.frames[0].path)
    assert.equal(Math.max(dimensions.width, dimensions.height), 400, 'ddagrab long side should be scaled to 400')
    const stats = rgbStats(await decodeToRgb(capture.frames[0].path))
    assert.ok(stats.distinctColours >= 64, `ddagrab frame should have many colours, got ${stats.distinctColours}`)
    assert.ok(stats.variance > 20, 'ddagrab frame should not be a flat surface')
    assertJsonSafe(capture, 'ddagrab capture result')
  })

  await check('REAL one-shot capture at width 800: PNG exists, decodes, and is not black/uniform', async () => {
    realStill = await captureFrames({ tools, workDir, outputDir: ARTIFACTS, options: { width: 800 } })
    assert.equal(realStill.frames.length, 1, 'a one-shot capture must return exactly one frame')
    assert.equal(realStill.frames[0].time, 0)
    const path = realStill.frames[0].path
    const info = await stat(path)
    assert.ok(info.size > 1000, `captured PNG is suspiciously small (${info.size} bytes)`)
    assert.equal(realStill.engine, 'gdigrab', 'this machine should capture through gdigrab')
    const dimensions = await pngDimensionsOf(path)
    assert.equal(realStill.width, dimensions.width)
    assert.equal(realStill.height, dimensions.height)
    assert.equal(Math.max(dimensions.width, dimensions.height), 800, 'the long side should be scaled to the requested width')
    assert.equal(realStill.seconds, 0)
    assert.ok(realStill.elapsedMs > 0 && realStill.elapsedMs < 30_000, 'one-shot capture must stay bounded')
    assert.ok(realStill.captureMs > 0 && realStill.captureMs <= realStill.elapsedMs, 'captureMs should be part of elapsedMs')
    assert.ok(!realStill.warnings.some((warning) => /uniformly black/u.test(warning)), 'capture must not be black')
    const raster = await decodeToRgb(path)
    const stats = rgbStats(raster)
    assert.ok(stats.distinctColours >= 64, `real desktop frame should have many colours, got ${stats.distinctColours}`)
    assert.ok(stats.variance > 50, `real desktop frame should have pixel variance, got ${stats.variance.toFixed(1)}`)
    assert.ok(stats.mean > 2, `real desktop frame should not be black (mean luminance ${stats.mean.toFixed(1)})`)
    assertJsonSafe(realStill, 'captureFrames one-shot result')
    artifactNotes.push(`REAL one-shot desktop frame: ${path}`)
    // The mission's sizing check: a 6-frame low sheet from the REAL desktop
    // dimensions must be 42 px aligned and carry a documented token estimate.
    const realPlan = planSheet({ frameCount: 6, sourceWidth: realStill.width, sourceHeight: realStill.height, quality: 'low' })
    assert.equal(realPlan.canvasWidth % 42, 0, `6-frame low sheet width ${realPlan.canvasWidth} is not 42 px aligned`)
    assert.equal(realPlan.canvasWidth, 798)
    assert.equal(realPlan.tokenEstimate, 162, '6-frame low sheet should cost 162 tokens (798x334 -> 8 rows x 20 cols)')
  })

  await check('REAL region capture honours x,y,w,h and keeps the region aspect ratio', async () => {
    const region = await captureFrames({ tools, workDir, outputDir: join(workDir, 'region'), options: { width: 400, region: '0,0,640,400' } })
    assert.equal(region.frames.length, 1)
    assert.deepEqual(region.region, { x: 0, y: 0, width: 640, height: 400 })
    const dimensions = await pngDimensionsOf(region.frames[0].path)
    assert.equal(Math.max(dimensions.width, dimensions.height), 400, 'region frame long side should be 400')
    assert.ok(Math.abs(dimensions.width / dimensions.height - 1.6) < 0.02, 'region aspect ratio should be 640:400 = 1.6')
    assert.equal(region.width, dimensions.width)
    assert.equal(region.height, dimensions.height)
  })

  await check('captureFrames rejects bad options instead of capturing something surprising', async () => {
    await assert.rejects(
      () => captureFrames({ tools, workDir, options: { width: 400, region: 'not-a-region' } }),
      /region/u,
    )
    await assert.rejects(() => captureFrames({ tools, workDir, options: { source: 'window' } }), /only supports source/u)
    await assert.rejects(() => captureFrames({ tools, workDir, options: { engine: 'x11grab' } }), /not available/u)
    assert.throws(() => planSheet({ frameCount: 4, quality: 'ultra' }), /unknown quality/u)
  })

  await check('REAL bounded clip capture: 1 s at 6 fps -> split PNG frames with monotonic timestamps, then one sheet', async () => {
    const oneShotAspect = realStill.width / realStill.height
    const clipPlan = planSheet({ frameCount: 6, sourceWidth: realStill.width, sourceHeight: realStill.height, quality: 'low' })
    const clip = await captureFrames({
      tools,
      workDir,
      outputDir: join(workDir, 'clip'),
      options: { seconds: 1, fps: 6, width: clipPlan.cellWidth },
    })
    assert.ok(clip.frames.length >= 2 && clip.frames.length <= 10, `expected a handful of frames, got ${clip.frames.length}`)
    assert.ok(clip.captureMs < 20_000, 'clip capture must stay bounded')
    for (let index = 0; index < clip.frames.length; index += 1) {
      const frame = clip.frames[index]
      assert.equal(frame.index, index)
      assert.ok(Math.abs(frame.time - index / 6) < 0.05, `frame ${index} timestamp ${frame.time} should be about ${(index / 6).toFixed(3)}`)
      const dimensions = await pngDimensionsOf(frame.path)
      assert.equal(Math.max(dimensions.width, dimensions.height), clipPlan.cellWidth, 'frames should be captured at the planned cell long side')
      assert.ok(
        Math.abs(dimensions.width / dimensions.height - oneShotAspect) < 0.02,
        'clip frame aspect should match the desktop aspect',
      )
    }
    assert.equal(clip.width, (await pngDimensionsOf(clip.frames[0].path)).width)
    assert.equal(clip.height, (await pngDimensionsOf(clip.frames[0].path)).height)
    assertJsonSafe(clip, 'captureFrames clip result')

    const realPlan = planSheet({ frameCount: clip.frames.length, sourceWidth: clip.width, sourceHeight: clip.height, quality: 'low' })
    realSheetSummary = await buildSheet({
      frames: clip.frames,
      width: realPlan.canvasWidth,
      height: realPlan.canvasHeight,
      columns: realPlan.columns,
      outputPath: REAL_SHEET,
    })
    assert.equal(realSheetSummary.frameCount, clip.frames.length)
    assert.equal(realSheetSummary.width, realPlan.canvasWidth)
    assert.equal(realSheetSummary.width % 42, 0)
    assert.equal(realSheetSummary.tokenEstimate, realPlan.tokenEstimate)
    assert.equal(realSheetSummary.cells.length, clip.frames.length)
    assert.ok((await stat(REAL_SHEET)).size > 1000)
    const raster = await decodeToRgb(REAL_SHEET)
    assert.equal(raster.width, realSheetSummary.width)
    assert.equal(raster.height, realSheetSummary.height)
    assert.ok(rgbStats(raster).distinctColours >= 32, 'real sheet should contain actual screen content')
    artifactNotes.push(`REAL ${clip.frames.length}-frame sheet: ${REAL_SHEET}`)
  })

  await check('module hygiene: ESM, zero runtime dependencies, Apache-2.0 credit, and node --check clean', async () => {
    const source = await readFile(SCREEN_MODULE, 'utf8')
    assert.match(source, /dsh-see-now/u, 'header must credit the upstream dsh-see-now project')
    assert.match(source, /SAOS-3624/u)
    assert.match(source, /Apache-2\.0/u)
    assert.match(source, /42/u, 'header must document the 42 px token alignment')
    const importSpecifiers = [...source.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gmu)].map((match) => match[1])
    assert.ok(importSpecifiers.length > 0, 'screen.js should import its helpers')
    for (const specifier of importSpecifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `screen.js must only import Node builtins and local helpers, found "${specifier}"`,
      )
    }
    assert.doesNotMatch(source, /from\s+'(?!node:|\.)/u, 'no bare package imports are allowed')
    execFileSync(process.execPath, ['--check', SCREEN_MODULE], { stdio: 'pipe' })
    execFileSync(process.execPath, ['--check', fileURLToPath(import.meta.url)], { stdio: 'pipe' })
    for (const name of ['listSources', 'captureFrames', 'buildSheet', 'planSheet']) {
      assert.equal(typeof (await import('../lib/screen.js'))[name], 'function', `${name} must be exported`)
    }
  })
} finally {
  if (workDir !== undefined) await removeWorkDir(workDir)
}

console.log('')
for (const note of artifactNotes) console.log(note)
console.log(`\n${passed} passed, ${failed} failed (${passed + failed} assertion blocks)`)
process.exit(failed === 0 ? 0 : 1)
