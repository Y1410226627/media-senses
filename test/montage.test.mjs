#!/usr/bin/env node
/**
 * Acceptance tests for the vision-target montage module (`lib/montage.js`).
 *
 * Run: node test/montage.test.mjs
 *
 * Builds two synthetic 6 s, three-scene videos with ffmpeg (a "reference" and a
 * differently-coloured "replica"), analyses them with the real `analyzeVideo`,
 * and then asserts:
 *   - the filmstrip's cell count / 16:9 cells / 4 px gaps / 42 px canvas width /
 *     token formula, burned-in labels and row-major order;
 *   - both compare layouts (`stack`, `side`), their exact geometry and that the
 *     decoded PNG really contains the reference and replica frames;
 *   - degradation: a missing timestamp is skipped with a warning and consistent
 *     renumbering; all-missing throws; one-sided compare degrades to a
 *     placeholder while both-missing throws;
 *   - `diffMetrics` near-identical -> all-match rows and 'close', very different
 *     -> 'diverge', missing data -> 'unknown' (never 'match'), with the documented
 *     thresholds asserted directly;
 *   - every result is plain JSON (finite numbers, no Buffers/Dates/undefined).
 *
 * The test also leaves two sample images on disk for a human to open:
 *   test/fixtures/artifacts/montage/filmstrip-3frames.png
 *   test/fixtures/artifacts/montage/compare-stack.png
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWorkDir, removeWorkDir, resolveTools, run } from '../lib/ffmpeg.js'
import { Canvas } from '../lib/png.js'
import { analyzeVideo } from '../lib/video.js'
import { buildFilmstrip, buildComparePair, diffMetrics, DIFF_THRESHOLDS, MONTAGE_GAP, QUALITY_WIDTHS } from '../lib/montage.js'
import { tokenEstimateFor } from '../lib/screen.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const MODULE_PATH = join(ROOT, 'lib', 'montage.js')
const ARTIFACTS = join(HERE, 'fixtures', 'artifacts', 'montage')
const FILMSTRIP_SAMPLE = join(ARTIFACTS, 'filmstrip-3frames.png')
const COMPARE_SAMPLE = join(ARTIFACTS, 'compare-stack.png')
const PNG_MAGIC = '89504e470d0a1a0a'

let passed = 0
let failed = 0
let tools
let workDir
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
// Independent helpers (the test does not trust the module's internals)
// ---------------------------------------------------------------------------

function pngDimensions(buffer) {
  assert.ok(buffer.length > 24, 'PNG is too small to carry an IHDR')
  assert.equal(buffer.subarray(0, 8).toString('hex'), PNG_MAGIC, 'file is not a PNG')
  assert.equal(buffer.subarray(12, 16).toString('latin1'), 'IHDR', 'PNG has no IHDR header')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

async function pngDimensionsOf(path) {
  return pngDimensions(await readFile(path))
}

/** Independent re-implementation of the host's vision-token formula. */
function tokenFormula(width, height) {
  return Math.ceil(height / 42) * (Math.ceil(width / 42) + 1) + 2
}

function runBuffer(binary, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      binary,
      args,
      { cwd: options.cwd, timeout: 120_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
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

/** Decode an image to raw rgb24: exactly what a vision model would see. */
async function decodeToRgb(path) {
  const dimensions = await pngDimensionsOf(path)
  const rgb = await runBuffer(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  assert.ok(rgb.length >= dimensions.width * dimensions.height * 3, 'decoded raster is smaller than the PNG header claims')
  return { rgb, width: dimensions.width, height: dimensions.height }
}

function rgbStats({ rgb }) {
  const pixels = Math.floor(rgb.length / 3)
  const colours = new Set()
  let sum = 0
  let sumSq = 0
  for (let offset = 0; offset + 2 < rgb.length; offset += 3) {
    colours.add((rgb[offset] << 16) | (rgb[offset + 1] << 8) | rgb[offset + 2])
    const luma = (rgb[offset] * 299 + rgb[offset + 1] * 587 + rgb[offset + 2] * 114) / 1000
    sum += luma
    sumSq += luma * luma
  }
  const mean = sum / pixels
  return { mean, variance: Math.max(0, sumSq / pixels - mean * mean), distinctColours: colours.size }
}

function regionMean(image, x, y, width, height) {
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = ((y + row) * image.width + x + column) * 3
      r += image.rgb[offset]
      g += image.rgb[offset + 1]
      b += image.rgb[offset + 2]
      count += 1
    }
  }
  return { r: r / count, g: g / count, b: b / count }
}

function regionHasWhitePixel(image, x, y, width, height) {
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = ((y + row) * image.width + x + column) * 3
      if (image.rgb[offset] > 235 && image.rgb[offset + 1] > 235 && image.rgb[offset + 2] > 235) return true
    }
  }
  return false
}

/** True when any pixel's mean channel value is below `maxMean` (dark plate). */
function regionHasDarkPixel(image, x, y, width, height, maxMean) {
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = ((y + row) * image.width + x + column) * 3
      const mean = (image.rgb[offset] + image.rgb[offset + 1] + image.rgb[offset + 2]) / 3
      if (mean < maxMean) return true
    }
  }
  return false
}

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

/** Two 6 s scene videos (3 x 2 s solid colours), generated purely with ffmpeg. */
async function createSceneVideo(path, colours) {
  const inputs = colours.flatMap((colour) => ['-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:r=25:d=2`])
  const filter = `${colours.map((_, index) => `[${index}:v]`).join('')}concat=n=${colours.length}:v=1:a=0,format=yuv420p`
  const result = await run(
    tools.ffmpeg,
    ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-c:v', 'libx264', '-preset', 'ultrafast', path],
    { timeoutMs: 120_000 },
  )
  if (result.code !== 0) throw new Error(`cannot build fixture ${path}: ${result.stderr.slice(0, 400)}`)
}

/** A small still image fixture for the "media can be an image" path. */
async function createStillImage(path) {
  const canvas = new Canvas(320, 180, [32, 200, 210, 255])
  canvas.rect(40, 40, 100, 100, [240, 60, 90, 255])
  await canvas.save(path)
}

// ---------------------------------------------------------------------------
// Constructed VideoAnalysis-shaped objects for the diffMetrics unit checks
// ---------------------------------------------------------------------------

function baseAnalysis() {
  return {
    kind: 'video',
    duration: 6,
    stream: { codec: 'h264', width: 320, height: 180, fps: 25, bitRate: 0, rotation: 0, pixelFormat: 'yuv420p' },
    format: { container: 'mp4', bitRate: 0, sizeBytes: 0 },
    global: {
      shotCount: 3,
      cutRate: 20,
      avgBrightness: 0.35,
      brightnessVariety: 0.1,
      avgSaturation: 0.45,
      colorfulness: 42,
      dominantHues: [{ name: 'red', share: 0.6, hex: '#e03131' }],
      avgMotion: 5,
      peakMotion: 20,
      aspectRatio: '16:9',
    },
    shots: [
      { index: 0, start: 0, end: 2, duration: 2, brightness: 0.3, saturation: 0.5, hueName: 'red', hueHex: '#e03131', motion: 4, palette: [] },
      { index: 1, start: 2, end: 4, duration: 2, brightness: 0.4, saturation: 0.5, hueName: 'green', hueHex: '#2f9e44', motion: 4, palette: [] },
      { index: 2, start: 4, end: 6, duration: 2, brightness: 0.35, saturation: 0.4, hueName: 'blue', hueHex: '#1971c2', motion: 4, palette: [] },
    ],
    timeline: [
      { t: 0, brightness: 0.3, saturation: 0.5, motion: 1 },
      { t: 1, brightness: 0.35, saturation: 0.45, motion: 1 },
    ],
    audio: {
      kind: 'audio',
      analyzed: { start: 0, seconds: 6, sampleRate: 22050 },
      tempo: { bpm: 120, beatTimes: [0, 0.5, 1, 1.5, 2, 2.5], confidence: 0.8, beatCount: 12 },
      key: { tonic: 'C', mode: 'major', name: 'C major', confidence: 0.8, candidates: [], tuned: 0 },
      loudness: {},
      warnings: [],
    },
    transcript: null,
    flags: { frozen: [], black: [], silent: [], likelyTextHeavy: false, likelyTalkingHead: false },
    artifacts: {},
    warnings: [],
    craft: { cutRhythm: { hardCutShare: 0.85 }, beatSync: { ratio: 0.8 }, grading: null },
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function rowOf(result, metric) {
  const row = result.rows.find((entry) => entry.metric === metric)
  assert.ok(row !== undefined, `diffMetrics did not return the "${metric}" row`)
  return row
}

function assertSafeDelta(rows) {
  for (const row of rows) {
    if (row.verdict === 'unknown') assert.equal(row.delta, null)
    else assert.ok(row.delta === null || Number.isFinite(row.delta), `delta for ${row.metric} must be finite or null`)
  }
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
// Keep the artifacts directory reviewable: drop the previous run's images.
for (const entry of await readdir(ARTIFACTS)) {
  if (entry.endsWith('.png')) await rm(join(ARTIFACTS, entry), { force: true })
}
workDir = await makeWorkDir('media-senses-montage-test')
const REF = join(workDir, 'reference.mp4')
const BUILT = join(workDir, 'replica.mp4')
const STILL = join(workDir, 'still.png')
const REF_WORK = join(workDir, 'analysis-ref')
const BUILT_WORK = join(workDir, 'analysis-built')

try {
  await mkdir(REF_WORK, { recursive: true })
  await mkdir(BUILT_WORK, { recursive: true })
  await createSceneVideo(REF, ['red', 'lime', 'blue'])
  await createSceneVideo(BUILT, ['orange', 'teal', 'purple'])
  await createStillImage(STILL)

  const refAnalysis = await analyzeVideo({
    tools,
    file: REF,
    workDir: REF_WORK,
    options: { artifactDir: join(workDir, 'artifacts-ref'), wantContactSheet: false, wantFrames: false },
  })
  const builtAnalysis = await analyzeVideo({
    tools,
    file: BUILT,
    workDir: BUILT_WORK,
    options: { artifactDir: join(workDir, 'artifacts-built'), wantContactSheet: false, wantFrames: false },
  })

  // -------------------------------------------------------------------------
  // buildFilmstrip
  // -------------------------------------------------------------------------
  let strip
  await check('filmstrip: 3 frames -> one 42px-aligned PNG with 16:9 cells, documented dims and token estimate', async () => {
    strip = await buildFilmstrip({
      tools,
      file: REF,
      times: [0.5, 3, 5.5],
      workDir,
      outputPath: FILMSTRIP_SAMPLE,
      width: 1260,
      columns: 3,
      labels: ['首', '中', '尾'],
    })
    const info = await stat(FILMSTRIP_SAMPLE)
    assert.ok(info.size > 1000, `filmstrip PNG is suspiciously small (${info.size} bytes)`)
    assert.deepEqual(await pngDimensionsOf(FILMSTRIP_SAMPLE), { width: 1260, height: 241 })
    assert.equal(strip.path, FILMSTRIP_SAMPLE)
    assert.equal(strip.width, 1260)
    assert.equal(strip.width % 42, 0, 'canvas width must be a multiple of 42 px')
    assert.equal(strip.height, 241)
    assert.equal(strip.columns, 3)
    assert.equal(strip.rows, 1)
    assert.equal(strip.cellWidth, 414)
    assert.equal(strip.cellHeight, 233)
    assert.equal(MONTAGE_GAP, 4)
    assert.equal(strip.tokenEstimate, 188)
    assert.equal(strip.tokenEstimate, tokenFormula(strip.width, strip.height))
    assert.equal(strip.tokenEstimate, tokenEstimateFor(strip.width, strip.height), 'must reuse screen.js token arithmetic')
    assert.equal(strip.cells.length, 3)
    assert.deepEqual(strip.cells.map((cell) => cell.index), [1, 2, 3])
    assert.deepEqual(strip.cells.map((cell) => cell.time), [0.5, 3, 5.5])
    assert.deepEqual(strip.cells.map((cell) => cell.timecode), ['0:00.500', '0:03.000', '0:05.500'])
    assert.deepEqual(strip.cells.map((cell) => cell.label), ['首', '中', '尾'], 'Chinese labels must survive in metadata')
    for (const cell of strip.cells) {
      assert.ok(cell.x >= 0 && cell.y >= 0, 'cell origin must be inside the canvas')
      assert.ok(cell.x + cell.width <= strip.width, 'cell must not overflow horizontally')
      assert.ok(cell.y + cell.height <= strip.height, 'cell must not overflow vertically')
      assert.ok(Math.abs(cell.height - (cell.width * 9) / 16) <= 1, 'cells must be 16:9 within one pixel')
    }
    assert.deepEqual(strip.warnings, [])
    assertJsonSafe(strip, 'filmstrip result')
    artifactNotes.push(`filmstrip sample: ${FILMSTRIP_SAMPLE} (${strip.width}x${strip.height}, ${strip.tokenEstimate} tokens)`)
  })

  await check('filmstrip: decoding the PNG proves the right frames were burned and the label plate is readable', async () => {
    const image = await decodeToRgb(FILMSTRIP_SAMPLE)
    assert.deepEqual({ width: image.width, height: image.height }, { width: 1260, height: 241 })
    const stats = rgbStats(image)
    assert.ok(stats.distinctColours >= 3, `expected at least 3 distinct colours, found ${stats.distinctColours}`)
    assert.ok(stats.variance > 100, 'a filmstrip of three scenes should have clear visual variance')
    // Times 0.5 / 3 / 5.5 fall into the red / green / blue scenes.
    const red = regionMean(image, strip.cells[0].x + 150, strip.cells[0].y + 120, 24, 24)
    const green = regionMean(image, strip.cells[1].x + 150, strip.cells[1].y + 120, 24, 24)
    const blue = regionMean(image, strip.cells[2].x + 150, strip.cells[2].y + 120, 24, 24)
    assert.ok(red.r > 200 && red.g < 60 && red.b < 60, `cell 1 should be the red scene, got ${JSON.stringify(red)}`)
    assert.ok(green.g > 150 && green.r < 60 && green.b < 60, `cell 2 should be the green scene, got ${JSON.stringify(green)}`)
    assert.ok(blue.b > 150 && blue.r < 60 && blue.g < 60, `cell 3 should be the blue scene, got ${JSON.stringify(blue)}`)
    // Burned-in badge: a dark translucent plate with light glyphs top-left.
    const cell = strip.cells[0]
    const content = regionMean(image, cell.x + cell.width - 40, cell.y + cell.height - 40, 8, 8)
    const contentMean = (content.r + content.g + content.b) / 3
    assert.ok(
      regionHasDarkPixel(image, cell.x + 2, cell.y + 2, 180, 60, Math.max(8, contentMean * 0.5)),
      'the label plate should contain clearly dark pixels (translucent dark plate over a bright frame)',
    )
    assert.ok(regionHasWhitePixel(image, cell.x + 2, cell.y + 2, 90, 50), 'badge glyphs should be light pixels')
  })

  await check('filmstrip: 6 frames wrap onto a second row with the expected height and tokens', async () => {
    const six = await buildFilmstrip({
      tools,
      file: REF,
      times: [0.2, 1, 2.2, 3, 4.2, 5],
      workDir,
      outputPath: join(ARTIFACTS, 'filmstrip-6frames.png'),
      width: 1260,
      columns: 3,
    })
    assert.equal(six.cells.length, 6)
    assert.equal(six.columns, 3)
    assert.equal(six.rows, 2)
    assert.equal(six.width, 1260)
    assert.equal(six.height, 478)
    assert.equal(six.cellWidth, 414)
    assert.equal(six.cellHeight, 233)
    assert.equal(six.tokenEstimate, 374)
    assert.equal(six.tokenEstimate, tokenFormula(six.width, six.height))
    assert.deepEqual(six.cells.map((cell) => cell.index), [1, 2, 3, 4, 5, 6])
    // Row-major order: first three share a row, next three start a new row.
    assert.ok(six.cells[0].x < six.cells[1].x && six.cells[1].x < six.cells[2].x)
    assert.equal(six.cells[3].x, six.cells[0].x)
    assert.ok(six.cells[3].y > six.cells[0].y)
    assert.deepEqual(await pngDimensionsOf(six.path), { width: 1260, height: 478 })
  })

  await check('filmstrip: explicit width/columns and quality presets keep the canvas 42-aligned', async () => {
    const narrow = await buildFilmstrip({
      tools,
      file: REF,
      times: [0.5, 3, 5.5],
      workDir,
      outputPath: join(ARTIFACTS, 'filmstrip-798.png'),
      width: 798,
      columns: 2,
    })
    assert.equal(narrow.width, 798)
    assert.equal(narrow.width % 42, 0)
    assert.equal(narrow.columns, 2)
    assert.equal(narrow.rows, 2)
    assert.equal(narrow.cellWidth, 393)
    assert.equal(narrow.cellHeight, 221)
    assert.equal(narrow.height, 454)
    assert.equal(narrow.tokenEstimate, 222)
    assert.equal(narrow.tokenEstimate, tokenFormula(narrow.width, narrow.height))

    const preset = await buildFilmstrip({
      tools,
      file: REF,
      times: [0.5, 3],
      workDir,
      outputPath: join(ARTIFACTS, 'filmstrip-low.png'),
      quality: 'low',
    })
    assert.equal(preset.width, QUALITY_WIDTHS.low)
    assert.equal(preset.width % 42, 0)
    assert.equal(preset.tokenEstimate, tokenFormula(preset.width, preset.height))

    const rounded = await buildFilmstrip({
      tools,
      file: REF,
      times: [0.5],
      workDir,
      outputPath: join(ARTIFACTS, 'filmstrip-800-aligned.png'),
      width: 800,
    })
    assert.equal(rounded.width, 798, '800 px should align down to 798 px (19 token columns)')
    assert.ok(rounded.warnings.some((warning) => /42/u.test(warning)), 'width alignment must be explained in warnings')
  })

  await check('filmstrip: a missing timestamp is skipped with a warning and the kept cells are renumbered', async () => {
    const degraded = await buildFilmstrip({
      tools,
      file: REF,
      times: [0.5, 99, 3],
      labels: ['A', 'B', 'C'],
      workDir,
      outputPath: join(ARTIFACTS, 'filmstrip-degraded.png'),
      width: 1260,
      columns: 3,
    })
    assert.equal(degraded.cells.length, 2)
    assert.equal(degraded.requestedFrameCount, 3)
    assert.equal(degraded.missingFrameCount, 1)
    assert.deepEqual(degraded.cells.map((cell) => cell.index), [1, 2], 'indices must be renumbered 1..N')
    assert.deepEqual(degraded.cells.map((cell) => cell.time), [0.5, 3])
    assert.deepEqual(degraded.cells.map((cell) => cell.label), ['A', 'C'], 'labels follow their original timestamps')
    assert.equal(degraded.warnings.length, 1)
    assert.match(degraded.warnings[0], /could not be decoded/u)
    assert.equal(degraded.columns, 2, 'columns shrink to the kept frame count')
    assert.equal(degraded.width, 1260)
    assert.equal(degraded.height, 359)
    assert.ok((await stat(degraded.path)).size > 1000)
    assertJsonSafe(degraded, 'degraded filmstrip result')
  })

  await check('filmstrip: every requested timestamp failing throws a clear error', async () => {
    await assert.rejects(
      () => buildFilmstrip({ tools, file: REF, times: [99, 120], workDir, outputPath: join(workDir, 'never.png') }),
      /no frames could be decoded/u,
    )
    await assert.rejects(
      () => buildFilmstrip({ tools, file: join(workDir, 'does-not-exist.mp4'), times: [0], workDir }),
      /cannot read media/u,
    )
  })

  await check('filmstrip: works on a still image (no seeking, one cell) and auto-times choose first/middle/last', async () => {
    const still = await buildFilmstrip({ tools, file: STILL, times: [0], workDir, outputPath: join(ARTIFACTS, 'filmstrip-still.png'), width: 798 })
    assert.equal(still.cells.length, 1)
    assert.equal(still.width, 798)
    assert.equal(still.cells[0].time, 0)
    const auto = await buildFilmstrip({ tools, file: REF, workDir, outputPath: join(ARTIFACTS, 'filmstrip-auto.png'), width: 798 })
    assert.equal(auto.cells.length, 3, 'a video with unknown times should get first/middle/last')
    assert.deepEqual(auto.cells.map((cell) => Math.round(cell.time * 100) / 100), [0, 3, 5.95])
  })

  // -------------------------------------------------------------------------
  // buildComparePair
  // -------------------------------------------------------------------------
  let stack
  await check('compare stack: reference and replica stacked, exact dims, token estimate and Chinese labels in metadata', async () => {
    stack = await buildComparePair({
      tools,
      refFile: REF,
      builtFile: BUILT,
      refTime: 0.5,
      builtTime: 3.5,
      workDir,
      outputPath: COMPARE_SAMPLE,
    })
    const info = await stat(COMPARE_SAMPLE)
    assert.ok(info.size > 1000, `compare PNG is suspiciously small (${info.size} bytes)`)
    assert.deepEqual(await pngDimensionsOf(COMPARE_SAMPLE), { width: 1260, height: 1420 })
    assert.equal(stack.path, COMPARE_SAMPLE)
    assert.equal(stack.mode, 'stack')
    assert.equal(stack.width, 1260)
    assert.equal(stack.width % 42, 0)
    assert.equal(stack.height, 1420)
    assert.equal(stack.cellWidth, 1252)
    assert.equal(stack.cellHeight, 704)
    assert.equal(stack.tokenEstimate, 1056)
    assert.equal(stack.tokenEstimate, tokenFormula(stack.width, stack.height))
    assert.equal(stack.cells.length, 2)
    assert.deepEqual(stack.cells.map((cell) => cell.role), ['ref', 'built'])
    assert.deepEqual(stack.cells.map((cell) => cell.label), ['参考', '成片'], 'Chinese labels must survive in metadata')
    assert.deepEqual(stack.labels, ['参考', '成片'])
    assert.deepEqual(stack.times, { ref: 0.5, built: 3.5 })
    assert.equal(stack.cells[0].timecode, '0:00.500')
    assert.equal(stack.cells[1].timecode, '0:03.500')
    assert.ok(stack.cells[1].y > stack.cells[0].y, 'stack mode must place the replica below the reference')
    assert.equal(stack.cells[1].x, stack.cells[0].x)
    assert.deepEqual(stack.warnings, [])
    assertJsonSafe(stack, 'compare stack result')
    artifactNotes.push(`compare sample: ${COMPARE_SAMPLE} (${stack.width}x${stack.height}, ${stack.tokenEstimate} tokens)`)
  })

  await check('compare stack: decoded image really contains the reference frame and the replica frame', async () => {
    const image = await decodeToRgb(COMPARE_SAMPLE)
    assert.deepEqual({ width: image.width, height: image.height }, { width: 1260, height: 1420 })
    assert.ok(rgbStats(image).distinctColours >= 3)
    const ref = regionMean(image, stack.cells[0].x + 500, stack.cells[0].y + 350, 24, 24)
    const built = regionMean(image, stack.cells[1].x + 500, stack.cells[1].y + 350, 24, 24)
    assert.ok(ref.r > 200 && ref.b < 60, `reference cell should be the red scene, got ${JSON.stringify(ref)}`)
    assert.ok(built.g > 100 && built.b > 100 && built.r < 60, `replica cell should be the teal scene, got ${JSON.stringify(built)}`)
    // ASCII fallback labels (REF / BUILT) are burned when labels are Chinese.
    assert.ok(regionHasWhitePixel(image, stack.cells[0].x + 2, stack.cells[0].y + 2, 260, 90), 'REF label should be burned in')
    assert.ok(regionHasWhitePixel(image, stack.cells[1].x + 2, stack.cells[1].y + 2, 340, 90), 'BUILT label should be burned in')
  })

  await check('compare side: left/right layout uses the exact documented dims and stays 42-aligned', async () => {
    const side = await buildComparePair({
      tools,
      refFile: REF,
      builtFile: BUILT,
      refTime: 0.5,
      builtTime: 3.5,
      workDir,
      outputPath: join(ARTIFACTS, 'compare-side.png'),
      mode: 'side',
      width: 1260,
    })
    assert.equal(side.mode, 'side')
    assert.equal(side.width, 1260)
    assert.equal(side.width % 42, 0)
    assert.equal(side.height, 359)
    assert.equal(side.cellWidth, 624)
    assert.equal(side.cellHeight, 351)
    assert.equal(side.tokenEstimate, 281)
    assert.equal(side.tokenEstimate, tokenFormula(side.width, side.height))
    assert.equal(side.cells.length, 2)
    assert.ok(side.cells[1].x > side.cells[0].x, 'side mode must place the replica to the right')
    assert.equal(side.cells[1].y, side.cells[0].y)
    const image = await decodeToRgb(side.path)
    assert.deepEqual({ width: image.width, height: image.height }, { width: 1260, height: 359 })
    const ref = regionMean(image, side.cells[0].x + 250, side.cells[0].y + 150, 20, 20)
    const built = regionMean(image, side.cells[1].x + 250, side.cells[1].y + 150, 20, 20)
    assert.ok(ref.r > 200 && ref.b < 60, 'left cell should be the reference scene')
    assert.ok(built.g > 100 && built.b > 100 && built.r < 60, 'right cell should be the replica scene')
  })

  await check('compare: default mode is stack, ASCII labels are burned directly and preserved in cells', async () => {
    const asciiPair = await buildComparePair({
      tools,
      refFile: REF,
      builtFile: BUILT,
      refTime: 1,
      builtTime: 1,
      workDir,
      outputPath: join(ARTIFACTS, 'compare-ascii-labels.png'),
      width: 798,
      labels: ['BEFORE', 'AFTER'],
    })
    assert.equal(asciiPair.mode, 'stack')
    assert.equal(asciiPair.width, 798)
    assert.deepEqual(asciiPair.cells.map((cell) => cell.label), ['BEFORE', 'AFTER'])
    assert.deepEqual(asciiPair.labels, ['BEFORE', 'AFTER'])
    assert.ok((await stat(asciiPair.path)).size > 1000)
  })

  await check('compare: one missing frame degrades to a placeholder, both missing throws, bad mode throws', async () => {
    const degraded = await buildComparePair({
      tools,
      refFile: REF,
      builtFile: BUILT,
      refTime: 99,
      builtTime: 3.5,
      workDir,
      outputPath: join(ARTIFACTS, 'compare-one-missing.png'),
    })
    assert.equal(degraded.cells.length, 2)
    assert.equal(degraded.cells[0].missing, true, 'the missing reference cell must be marked')
    assert.equal(degraded.cells[1].missing, undefined)
    assert.equal(degraded.warnings.length, 1)
    assert.match(degraded.warnings[0], /reference frame/u)
    assert.ok((await stat(degraded.path)).size > 1000)
    assertJsonSafe(degraded, 'degraded compare result')

    await assert.rejects(
      () => buildComparePair({ tools, refFile: REF, builtFile: BUILT, refTime: 99, builtTime: 99, workDir, outputPath: join(workDir, 'never.png') }),
      /neither reference/u,
    )
    await assert.rejects(
      () => buildComparePair({ tools, refFile: REF, builtFile: BUILT, workDir, outputPath: join(workDir, 'never.png'), mode: 'diagonal' }),
      /mode must be/u,
    )
  })

  // -------------------------------------------------------------------------
  // diffMetrics — pure thresholds / verdicts
  // -------------------------------------------------------------------------
  await check('diffMetrics: near-identical analyses produce 11 match rows and overall "close"', async () => {
    const ref = baseAnalysis()
    const near = cloneJson(ref)
    near.duration = 6.05
    near.global.cutRate = 20.2
    near.global.avgBrightness = 0.36
    near.global.avgSaturation = 0.455
    near.global.colorfulness = 44
    near.audio.tempo.bpm = 120.5
    near.craft.cutRhythm.hardCutShare = 0.84
    near.craft.beatSync.ratio = 0.79
    for (const shot of near.shots) shot.duration = 2.01
    const result = diffMetrics(ref, near)
    assert.equal(result.rows.length, 11, 'always one row per documented metric')
    assert.deepEqual(
      result.rows.map((row) => row.metric),
      ['时长', '镜头数', '平均镜头长', '切点率', '平均亮度', '平均彩度', 'BPM', '调性', '硬切占比', '卡点率', '调色签名'],
    )
    assert.equal(result.summary.match, 11)
    assert.equal(result.summary.close, 0)
    assert.equal(result.summary.diverge, 0)
    assert.equal(result.summary.unknown, 0)
    assert.equal(result.summary.comparable, 11)
    assert.equal(result.verdict, 'close')
    assert.ok(result.rows.every((row) => row.verdict === 'match'))
    assertJsonSafe(result, 'diffMetrics near result')
  })

  await check('diffMetrics: very different analyses produce many diverge rows and overall "diverge"', async () => {
    const ref = baseAnalysis()
    const far = baseAnalysis()
    far.duration = 12
    far.global.shotCount = 8
    far.global.cutRate = 0
    far.global.avgBrightness = 0.85
    far.global.avgSaturation = 0.1
    far.global.colorfulness = 10
    far.global.dominantHues = [{ name: 'blue', share: 0.8, hex: '#1971c2' }]
    far.shots = Array.from({ length: 8 }, (_, index) => ({
      index,
      start: index * 1.5,
      end: index * 1.5 + 1.5,
      duration: 1.5,
      brightness: 0.85,
      saturation: 0.1,
      hueName: 'blue',
      hueHex: '#1971c2',
      motion: 1,
      palette: [],
    }))
    far.timeline = [{ t: 0, brightness: 0.85, saturation: 0.1, motion: 0 }]
    far.audio.tempo.bpm = 90
    far.audio.tempo.beatTimes = [0, 0.66, 1.33]
    far.audio.key = { tonic: 'A', mode: 'minor', name: 'A minor', confidence: 0.6, candidates: [], tuned: 0 }
    far.craft.cutRhythm.hardCutShare = 0.2
    far.craft.beatSync.ratio = 0.1
    const result = diffMetrics(ref, far)
    assert.ok(result.summary.diverge >= 6, `expected at least 6 diverge rows, got ${result.summary.diverge}`)
    assert.ok(result.summary.diverge > result.summary.match)
    assert.equal(result.verdict, 'diverge')
    for (const metric of ['时长', '平均亮度', 'BPM', '调性', '调色签名']) {
      assert.equal(rowOf(result, metric).verdict, 'diverge', `"${metric}" should diverge`)
    }
    assertSafeDelta(result.rows)
    assertJsonSafe(result, 'diffMetrics far result')
  })

  await check('diffMetrics: missing values are "unknown", never "match" (audio-less / craft-less analyses)', async () => {
    const ref = cloneJson(baseAnalysis())
    const built = cloneJson(baseAnalysis())
    ref.audio = null
    built.audio = null
    delete ref.craft
    delete built.craft
    const result = diffMetrics(ref, built)
    for (const metric of ['BPM', '调性', '硬切占比', '卡点率']) {
      const row = rowOf(result, metric)
      assert.equal(row.verdict, 'unknown', `"${metric}" must be unknown when its inputs are missing`)
      assert.equal(row.delta, null)
    }
    assert.equal(result.summary.unknown, 4)
    assert.equal(result.summary.comparable, 7)
    assert.equal(result.verdict, 'close', 'the seven comparable metrics all match, so overall close')

    // One side missing is still unknown, never a match.
    const oneSided = diffMetrics(baseAnalysis(), cloneJson({ ...baseAnalysis(), audio: null }))
    assert.equal(rowOf(oneSided, 'BPM').verdict, 'unknown')
    assert.equal(rowOf(oneSided, '调性').verdict, 'unknown')

    // No comparable rows at all -> partly (cannot tell), not diverge/match.
    const empty = diffMetrics({ duration: null }, {})
    assert.equal(empty.rows.length, 11)
    assert.equal(empty.summary.comparable, 0)
    assert.ok(empty.rows.every((row) => row.verdict === 'unknown'))
    assert.equal(empty.verdict, 'partly')
    assert.throws(() => diffMetrics(null, {}), TypeError)
  })

  await check('diffMetrics: documented thresholds behave as promised (avgShotLength, brightness, BPM octave)', async () => {
    const ref = baseAnalysis()
    ref.global.avgBrightness = 0.5
    const make = (mutate) => {
      const value = cloneJson(ref)
      mutate(value)
      return value
    }
    const shotLengthRow = (durations) => rowOf(diffMetrics(ref, make((value) => {
      value.shots = durations.map((duration, index) => ({ index, start: index * duration, end: (index + 1) * duration, duration }))
    })), '平均镜头长')
    // Reference average shot length is 2.0 s.
    assert.equal(shotLengthRow([2.3, 2.3, 2.3]).verdict, 'match', '15% longer is a match (<=20%)')
    assert.equal(shotLengthRow([2.7, 2.7, 2.7]).verdict, 'close', '35% longer is close (<=50%)')
    assert.equal(shotLengthRow([3.4, 3.4, 3.4]).verdict, 'diverge', '70% longer diverges (>50%)')

    const brightnessRow = (brightness) => rowOf(diffMetrics(ref, make((value) => { value.global.avgBrightness = brightness })), '平均亮度')
    assert.equal(brightnessRow(0.53).verdict, 'match', 'Δ0.03 brightness is a match (<=0.05)')
    assert.equal(brightnessRow(0.62).verdict, 'close', 'Δ0.12 brightness is close (<=0.15)')
    assert.equal(brightnessRow(0.9).verdict, 'diverge', 'Δ0.40 brightness diverges (>0.15)')

    const bpmRow = (bpm) => rowOf(diffMetrics(ref, make((value) => { value.audio.tempo.bpm = bpm })), 'BPM')
    assert.equal(bpmRow(120).verdict, 'match')
    assert.equal(bpmRow(60).verdict, 'match', 'octave-folded tempo (60 vs 120) must match')
    assert.equal(bpmRow(124).verdict, 'close', '3.3% tempo drift is close (<=8%)')
    assert.equal(bpmRow(90).verdict, 'diverge', '25% tempo drift diverges')
    assert.equal(DIFF_THRESHOLDS.avgShotLength.match, 0.2)
    assert.equal(DIFF_THRESHOLDS.avgShotLength.close, 0.5)
    assert.equal(DIFF_THRESHOLDS.avgBrightness.match, 0.05)
  })

  await check('diffMetrics: real analyzeVideo results are accepted; audio-less rows stay unknown and output is JSON-safe', async () => {
    const result = diffMetrics(refAnalysis, builtAnalysis)
    assert.equal(result.rows.length, 11)
    assert.equal(rowOf(result, '时长').verdict, 'match', 'both fixtures are exactly 6 s')
    const shotCountRow = rowOf(result, '镜头数')
    assert.ok(['match', 'close'].includes(shotCountRow.verdict), `both fixtures have 3 scenes, got ${shotCountRow.verdict}`)
    // The fixtures have no audio stream, so bpm/key must be unknown, not match.
    assert.equal(rowOf(result, 'BPM').verdict, 'unknown')
    assert.equal(rowOf(result, '调性').verdict, 'unknown')
    // The dominant hue differs (red vs orange-family), so the signature must not match.
    const signature = rowOf(result, '调色签名')
    assert.ok(typeof signature.ref === 'string' && typeof signature.built === 'string')
    assert.notEqual(signature.verdict, 'match')
    assert.ok(['close', 'partly', 'diverge'].includes(result.verdict))
    assertJsonSafe(result, 'diffMetrics real result')
  })

  // -------------------------------------------------------------------------
  // Module hygiene + deliverables
  // -------------------------------------------------------------------------
  await check('module hygiene: ESM, zero runtime dependencies, node --check clean, expected exports', async () => {
    const source = await readFile(MODULE_PATH, 'utf8')
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gmu)].map((match) => match[1])
    assert.ok(imports.length > 0, 'montage.js should import its helpers')
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `montage.js must only import Node builtins and local helpers, found "${specifier}"`,
      )
    }
    assert.match(source, /tokenEstimateFor/u, 'montage.js must reuse screen.js token arithmetic')
    assert.doesNotMatch(source, /drawtext=/u, 'labels must be composed with lib/png.js, not drawtext')
    execFileSync(process.execPath, ['--check', MODULE_PATH], { stdio: 'pipe' })
    execFileSync(process.execPath, ['--check', fileURLToPath(import.meta.url)], { stdio: 'pipe' })
    const module = await import('../lib/montage.js')
    for (const name of ['buildFilmstrip', 'buildComparePair', 'diffMetrics']) {
      assert.equal(typeof module[name], 'function', `${name} must be exported`)
    }
  })

  await check('deliverables: two sample images are valid PNGs on disk for the Lead to open', async () => {
    for (const sample of [FILMSTRIP_SAMPLE, COMPARE_SAMPLE]) {
      const buffer = await readFile(sample)
      assert.equal(buffer.subarray(0, 8).toString('hex'), PNG_MAGIC, `${sample} is not a PNG`)
      pngDimensions(buffer)
      assert.ok(buffer.length > 1000, `${sample} is too small to be a real image`)
    }
    assert.deepEqual(await pngDimensionsOf(FILMSTRIP_SAMPLE), { width: 1260, height: 241 })
    assert.deepEqual(await pngDimensionsOf(COMPARE_SAMPLE), { width: 1260, height: 1420 })
  })
} finally {
  if (workDir !== undefined) await removeWorkDir(workDir)
}

console.log('')
for (const note of artifactNotes) console.log(note)
console.log(`\n${passed} passed, ${failed} failed (${passed + failed} assertion blocks)`)
process.exit(failed === 0 ? 0 : 1)
