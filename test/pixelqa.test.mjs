/**
 * Pixel-level QA tests（像素级比对验收）.
 *
 * 所有素材都是内存里合成的图（no external media, no ffmpeg）：本模块是纯函数，
 * 所以测试也是纯函数——可重复、快、没有环境依赖。
 *
 * What is pinned here:
 *  1. PNG decoding: RGBA (lib/png.js Canvas output), RGB with all five row
 *     filters, palette PNGs, and readable errors for bad/16-bit/interlaced input.
 *  2. regionGrid: covers every pixel exactly once, no overlap, row-major index,
 *     oversized grids clamped instead of producing empty cells.
 *  3. comparePixels: identical frames (mae=0 / psnr=Infinity / ssim=1), a pure
 *     colour swap (ΔE00 = 100 for black↔white), an 8 px translation (PSNR must
 *     collapse), the three verdict tiers, Chinese worst-region attribution.
 *  4. Cross-resolution compare: 2× nearest upscale downsampled back is exact,
 *     independently-generated different-size gradients stay finite, mismatched
 *     aspect ratios do not throw.
 *  5. compareRegions: per-block match/diverge on a known quadrant, resampling,
 *     and readable errors for a bad grid.
 *
 * Attribution: no upstream code/data is used here; the upstream dsh-drawai
 * pixelqa.js is a different (banding/AA/font) checker. Metric formulas are
 * public standards, thresholds come from CONTRACT-V4 §2.5.
 */
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { Canvas } from '../lib/png.js'
import {
  decodePngPixels,
  comparePixels,
  regionGrid,
  compareRegions,
  PIXEL_QA_THRESHOLDS,
} from '../lib/pixelqa.js'

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

/* ------------------------------------------------------------------ *
 * Synthetic raster helpers
 * ------------------------------------------------------------------ */

function makeRgb(width, height, paint) {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colour = paint(x, y)
      const offset = (y * width + x) * 3
      data[offset] = colour[0]
      data[offset + 1] = colour[1]
      data[offset + 2] = colour[2]
    }
  }
  return { width, height, channels: 3, data }
}

function solidRgb(width, height, colour) {
  return makeRgb(width, height, () => colour)
}

/** Translate an RGB raster by whole pixels, filling the exposed band with `fill`. */
function shiftRgb(source, offsetX, offsetY, fill = [0, 0, 0]) {
  const { width, height, data } = source
  const out = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - offsetX
      const sourceY = y - offsetY
      const dst = (y * width + x) * 3
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) {
        out[dst] = fill[0]
        out[dst + 1] = fill[1]
        out[dst + 2] = fill[2]
        continue
      }
      const src = (sourceY * width + sourceX) * 3
      out[dst] = data[src]
      out[dst + 1] = data[src + 1]
      out[dst + 2] = data[src + 2]
    }
  }
  return { width, height, channels: 3, data: out }
}

/** Nearest-neighbour integer upscale (the inverse of the area average). */
function scaleNearest(source, factor) {
  const width = source.width * factor
  const height = source.height * factor
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.floor(y / factor)
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.floor(x / factor)
      const src = (sourceY * source.width + sourceX) * 3
      const dst = (y * width + x) * 3
      data[dst] = source.data[src]
      data[dst + 1] = source.data[src + 1]
      data[dst + 2] = source.data[src + 2]
    }
  }
  return { width, height, channels: 3, data }
}

/** Walk every numeric leaf of a result and hand it to `callback`. */
function walkNumbers(value, path, callback) {
  if (typeof value === 'number') {
    callback(value, path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkNumbers(item, `${path}[${index}]`, callback))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walkNumbers(item, `${path}.${key}`, callback)
  }
}

/* ------------------------------------------------------------------ *
 * Minimal PNG writer for the decoder tests (CRC + all five row filters)
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function ihdr(width, height, { bitDepth = 8, colorType = 2, interlace = 0 } = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = bitDepth
  header[9] = colorType
  header[10] = 0
  header[11] = 0
  header[12] = interlace
  return header
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft
  const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)]
  if (distances[0] <= distances[1] && distances[0] <= distances[2]) return left
  if (distances[1] <= distances[2]) return up
  return upLeft
}

function encodePng({ width, height, channels = 3, data, filters = [0], colorType, interlace = 0, bitDepth = 8 }) {
  const type = colorType ?? (channels === 4 ? 6 : channels === 3 ? 2 : channels === 1 ? 0 : 2)
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const filter = filters[y % filters.length]
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x += 1) {
      const value = data[y * stride + x]
      const left = x >= channels ? data[y * stride + x - channels] : 0
      const up = y > 0 ? data[(y - 1) * stride + x] : 0
      const upLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels] : 0
      let filtered
      switch (filter) {
        case 0: filtered = value; break
        case 1: filtered = value - left; break
        case 2: filtered = value - up; break
        case 3: filtered = value - ((left + up) >> 1); break
        case 4: filtered = value - paethPredictor(left, up, upLeft); break
        default: throw new Error(`test helper: unsupported filter ${filter}`)
      }
      raw[y * (stride + 1) + 1 + x] = filtered & 0xff
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr(width, height, { bitDepth, colorType: type, interlace })),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function encodePalettePng(width, height, indices, palette) {
  const stride = width
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    for (let x = 0; x < width; x += 1) raw[y * (stride + 1) + 1 + x] = indices[y * width + x]
  }
  const flatPalette = Buffer.from(palette.flat())
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr(width, height, { colorType: 3 })),
    pngChunk('PLTE', flatPalette),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ *
 * A. PNG decoding
 * ------------------------------------------------------------------ */

await check('decodePngPixels decodes a lib/png.js Canvas PNG (RGBA)', () => {
  const canvas = new Canvas(4, 3, [10, 20, 30, 255])
  canvas.set(2, 1, [200, 100, 50, 255])
  const pixels = decodePngPixels(canvas.toPng())
  assert.equal(pixels.width, 4)
  assert.equal(pixels.height, 3)
  assert.equal(pixels.channels, 4)
  assert.equal(pixels.data.length, 4 * 3 * 4)
})

await check('decodePngPixels round-trips Canvas pixel values exactly', () => {
  const canvas = new Canvas(4, 3, [10, 20, 30, 255])
  canvas.set(2, 1, [200, 100, 50, 255])
  const pixels = decodePngPixels(canvas.toPng())
  const offset = (1 * 4 + 2) * 4
  assert.deepEqual([...pixels.data.subarray(offset, offset + 4)], [200, 100, 50, 255])
  assert.deepEqual([...pixels.data.subarray(0, 4)], [10, 20, 30, 255])
})

await check('decodePngPixels reverses all five PNG row filters (RGB)', () => {
  const width = 11
  const height = 6
  const data = new Uint8Array(width * height * 3)
  for (let index = 0; index < data.length; index += 1) data[index] = (index * 37 + 11) % 256
  const png = encodePng({ width, height, channels: 3, data, filters: [0, 1, 2, 3, 4] })
  const pixels = decodePngPixels(png)
  assert.equal(pixels.channels, 3)
  assert.deepEqual([...pixels.data], [...data])
})

await check('decodePngPixels expands palette PNGs to RGB', () => {
  const indices = [0, 1, 2, 0, 2, 1, 0, 2]
  const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255]]
  const pixels = decodePngPixels(encodePalettePng(4, 2, indices, palette))
  assert.equal(pixels.channels, 3)
  assert.deepEqual([...pixels.data.subarray(0, 6)], [255, 0, 0, 0, 255, 0])
  assert.deepEqual([...pixels.data.subarray(6, 9)], [0, 0, 255])
})

await check('decodePngPixels rejects non-PNG bytes with a readable error', () => {
  assert.throws(() => decodePngPixels(Buffer.from('this is not a png file')), /not a PNG/i)
})

await check('decodePngPixels rejects interlaced PNGs with a readable error', () => {
  const data = new Uint8Array(2 * 2 * 3)
  const png = encodePng({ width: 2, height: 2, channels: 3, data, interlace: 1 })
  assert.throws(() => decodePngPixels(png), /interlaced/i)
})

await check('decodePngPixels rejects 16-bit PNGs with a readable error', () => {
  const data = new Uint8Array(2 * 2 * 3)
  const png = encodePng({ width: 2, height: 2, channels: 3, data, bitDepth: 16 })
  assert.throws(() => decodePngPixels(png), /bit depth/i)
})

/* ------------------------------------------------------------------ *
 * B. regionGrid
 * ------------------------------------------------------------------ */

await check('regionGrid covers every pixel exactly once without overlap', () => {
  const width = 37
  const height = 23
  const grid = regionGrid(width, height, 4, 3)
  assert.equal(grid.length, 12)
  const coverage = new Uint8Array(width * height)
  for (const cell of grid) {
    assert.ok(cell.w > 0 && cell.h > 0, `cell ${cell.index} is empty`)
    for (let y = cell.y; y < cell.y + cell.h; y += 1) {
      for (let x = cell.x; x < cell.x + cell.w; x += 1) coverage[y * width + x] += 1
    }
  }
  assert.ok(coverage.every((count) => count === 1), 'some pixels are covered 0 or 2+ times')
  const area = grid.reduce((sum, cell) => sum + cell.w * cell.h, 0)
  assert.equal(area, width * height)
})

await check('regionGrid indices are row-major and start at the top-left', () => {
  const grid = regionGrid(90, 90, 3, 3)
  assert.equal(grid.length, 9)
  assert.deepEqual(grid.map((cell) => cell.index), [0, 1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(
    { x: grid[0].x, y: grid[0].y, w: grid[0].w, h: grid[0].h },
    { x: 0, y: 0, w: 30, h: 30 },
  )
  assert.deepEqual(
    { x: grid[8].x, y: grid[8].y, w: grid[8].w, h: grid[8].h },
    { x: 60, y: 60, w: 30, h: 30 },
  )
})

await check('regionGrid clamps oversized grids to the image size (no empty cells)', () => {
  const grid = regionGrid(3, 2, 10, 10)
  assert.equal(grid.length, 6)
  for (const cell of grid) assert.deepEqual({ w: cell.w, h: cell.h }, { w: 1, h: 1 })
  assert.throws(() => regionGrid(0, 10), /positive integers/i)
})

/* ------------------------------------------------------------------ *
 * C. comparePixels
 * ------------------------------------------------------------------ */

await check('identical frames: mae=0, psnr=Infinity, ssim=1, deltaE00=0, verdict match', () => {
  const image = makeRgb(64, 48, (x, y) => [x * 3, y * 4, (x + y) % 256])
  const result = comparePixels(image, image)
  assert.equal(result.mae, 0)
  assert.equal(result.rmse, 0)
  assert.equal(result.psnr, Infinity)
  assert.equal(result.ssim, 1)
  assert.equal(result.deltaE00, 0)
  assert.equal(result.verdict, 'match')
  assert.deepEqual(result.worstRegions, [])
})

await check('identical PNG buffers also compare as match (PNG bytes accepted directly)', () => {
  const canvas = new Canvas(8, 8, [12, 34, 56, 255])
  canvas.rect(1, 1, 3, 3, [200, 10, 90, 255])
  const png = canvas.toPng()
  const result = comparePixels(png, Buffer.from(png))
  assert.equal(result.psnr, Infinity)
  assert.equal(result.verdict, 'match')
})

await check('black vs white: mae=255, deltaE00=100, ssim~0, verdict diverge', () => {
  const black = solidRgb(32, 24, [0, 0, 0])
  const white = solidRgb(32, 24, [255, 255, 255])
  const result = comparePixels(black, white)
  assert.equal(result.mae, 255)
  assert.equal(result.rmse, 255)
  assert.equal(result.psnr, 0)
  assert.ok(Math.abs(result.deltaE00 - 100) < 0.05, `deltaE00=${result.deltaE00}, expected 100`)
  assert.ok(result.ssim < 0.01, `ssim=${result.ssim}, expected ~0`)
  assert.equal(result.verdict, 'diverge')
})

await check('small uniform colour shift stays in the match tier', () => {
  const base = solidRgb(24, 16, [128, 128, 128])
  const shifted = solidRgb(24, 16, [130, 130, 130])
  const result = comparePixels(base, shifted)
  assert.equal(result.mae, 2)
  assert.ok(result.psnr > 40, `psnr=${result.psnr}`)
  assert.equal(result.verdict, 'match')
})

await check('verdict tiers follow the metric thresholds (match / close / diverge)', () => {
  const base = solidRgb(24, 16, [128, 128, 128])
  const match = comparePixels(base, solidRgb(24, 16, [130, 130, 130]))
  const close = comparePixels(base, solidRgb(24, 16, [140, 140, 140]))
  const diverge = comparePixels(base, solidRgb(24, 16, [158, 158, 158]))
  assert.equal(match.verdict, 'match')
  assert.equal(close.verdict, 'close')
  assert.equal(diverge.verdict, 'diverge')
  assert.ok(close.psnr < PIXEL_QA_THRESHOLDS.match.psnr && close.psnr >= PIXEL_QA_THRESHOLDS.close.psnr, `close psnr=${close.psnr}`)
  assert.ok(diverge.psnr < PIXEL_QA_THRESHOLDS.close.psnr, `diverge psnr=${diverge.psnr}`)
})

await check('an 8 px translation collapses PSNR and demotes the verdict', () => {
  const base = makeRgb(64, 64, (x, y) => ((Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0 ? [20, 20, 20] : [235, 235, 235]))
  const shifted = shiftRgb(base, 8, 0)
  const perfect = comparePixels(base, base)
  const result = comparePixels(base, shifted)
  assert.equal(perfect.psnr, Infinity)
  assert.ok(Number.isFinite(result.psnr), 'shifted comparison should produce a finite PSNR')
  assert.ok(result.psnr < PIXEL_QA_THRESHOLDS.close.psnr, `psnr=${result.psnr}, expected a significant drop`)
  assert.ok(result.ssim < PIXEL_QA_THRESHOLDS.match.ssim, `ssim=${result.ssim}`)
  assert.equal(result.verdict, 'diverge')
})

await check('worstRegions names the mismatch position in Chinese (右下角) and only differing cells', () => {
  const reference = solidRgb(96, 96, [10, 10, 10])
  const replica = makeRgb(96, 96, (x, y) => (x >= 64 && y >= 64 ? [255, 255, 255] : [10, 10, 10]))
  const result = comparePixels(reference, replica)
  assert.ok(result.worstRegions.length >= 1)
  const worst = result.worstRegions[0]
  assert.equal(worst.directionZh, '右下角')
  assert.deepEqual({ x: worst.x, y: worst.y, w: worst.w, h: worst.h }, { x: 64, y: 64, w: 32, h: 32 })
  assert.equal(worst.verdict, 'diverge')
  assert.ok(worst.mae > 200, `region mae=${worst.mae}`)
  assert.ok(worst.psnr < PIXEL_QA_THRESHOLDS.close.psnr)
  // Only the changed cell differs; identical cells are never listed as "worst".
  assert.equal(result.worstRegions.length, 1)
})

await check('worstRegions are sorted worst-first when two cells differ by different amounts', () => {
  const reference = solidRgb(96, 96, [128, 128, 128])
  const replica = makeRgb(96, 96, (x, y) => {
    let value = 128
    if (x < 32 && y < 32) value += 10 // top-left: mild
    if (x >= 64 && y >= 64) value += 60 // bottom-right: severe
    return [value, value, value]
  })
  const result = comparePixels(reference, replica)
  assert.ok(result.worstRegions.length >= 2, `worstRegions=${JSON.stringify(result.worstRegions)}`)
  assert.equal(result.worstRegions[0].directionZh, '右下角')
  assert.equal(result.worstRegions[1].directionZh, '左上角')
  assert.ok(result.worstRegions[0].psnr < result.worstRegions[1].psnr)
})

await check('maxWorstRegions caps the list (and 0 disables it)', () => {
  const black = solidRgb(48, 48, [0, 0, 0])
  const white = solidRgb(48, 48, [255, 255, 255])
  assert.equal(comparePixels(black, white, { maxWorstRegions: 2 }).worstRegions.length, 2)
  assert.equal(comparePixels(black, white, { maxWorstRegions: 0 }).worstRegions.length, 0)
  assert.equal(comparePixels(black, white).worstRegions.length, 3)
})

await check('custom thresholds can override the exported defaults', () => {
  const base = solidRgb(24, 16, [128, 128, 128])
  const shifted = solidRgb(24, 16, [130, 130, 130])
  const strict = comparePixels(base, shifted, { thresholds: { match: { psnr: 60 } } })
  assert.equal(strict.verdict, 'close')
  const impossible = comparePixels(base, shifted, { thresholds: { match: { psnr: 60 }, close: { psnr: 90 } } })
  assert.equal(impossible.verdict, 'diverge')
})

await check('cross-resolution: an exact 2x nearest upscale downsamples back to identical pixels', () => {
  const base = makeRgb(60, 40, (x, y) => [(x >> 2) * 17, (y >> 3) * 31, ((x + y) >> 2) * 13].map((value) => value % 256))
  const upscaled = scaleNearest(base, 2)
  const result = comparePixels(upscaled, base)
  assert.equal(result.mae, 0)
  assert.equal(result.psnr, Infinity)
  assert.equal(result.verdict, 'match')
})

await check('cross-resolution: independently generated 320x180 vs 160x90 gradients return finite values', () => {
  const large = makeRgb(320, 180, (x, y) => [Math.round((x * 255) / 319), Math.round((y * 255) / 179), 128])
  const small = makeRgb(160, 90, (x, y) => [Math.round((x * 255) / 159), Math.round((y * 255) / 89), 128])
  const result = comparePixels(large, small)
  assert.ok(Number.isFinite(result.mae) && result.mae < 2, `mae=${result.mae}`)
  assert.ok(Number.isFinite(result.rmse), 'rmse must be finite')
  assert.ok(Number.isFinite(result.psnr), 'psnr must be finite for a resampled compare')
  assert.ok(Number.isFinite(result.ssim), 'ssim must be finite')
  assert.ok(Number.isFinite(result.deltaE00), 'deltaE00 must be finite')
  assert.equal(result.verdict, 'match')
  const swapped = comparePixels(small, large)
  assert.ok(Math.abs(swapped.mae - result.mae) < 1e-9, 'compare must be symmetric under argument order')
})

await check('cross-resolution: mismatched aspect ratios compare without throwing', () => {
  const landscape = solidRgb(160, 90, [200, 100, 50])
  const portrait = solidRgb(90, 160, [120, 140, 60])
  const result = comparePixels(landscape, portrait)
  assert.ok(Number.isFinite(result.mae) && result.mae > 0, `mae=${result.mae}`)
  assert.ok(Number.isFinite(result.psnr))
  assert.ok(Number.isFinite(result.deltaE00))
  assert.equal(result.verdict, 'diverge')
})

await check('a raw raster without an explicit channel count is accepted (3 channels inferred)', () => {
  const base = solidRgb(16, 12, [1, 2, 3])
  const inferred = { width: 16, height: 12, data: base.data }
  const result = comparePixels(inferred, base)
  assert.equal(result.psnr, Infinity)
  assert.equal(result.verdict, 'match')
})

/* ------------------------------------------------------------------ *
 * D. compareRegions
 * ------------------------------------------------------------------ */

await check('compareRegions marks every block as match on identical frames', () => {
  const image = makeRgb(16, 16, (x, y) => [x * 10, y * 10, 128])
  const grid = regionGrid(16, 16, 2, 2)
  const rows = compareRegions(image, image, grid)
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map((row) => row.index), [0, 1, 2, 3])
  for (const row of rows) {
    assert.equal(row.verdict, 'match')
    assert.equal(row.mae, 0)
    assert.equal(row.psnr, Infinity)
    assert.equal(row.deltaE00, 0)
  }
})

await check('compareRegions localises a changed quadrant to the correct block', () => {
  const reference = solidRgb(16, 16, [10, 10, 10])
  const replica = makeRgb(16, 16, (x, y) => (x >= 8 && y >= 8 ? [255, 255, 255] : [10, 10, 10]))
  const rows = compareRegions(reference, replica, regionGrid(16, 16, 2, 2))
  assert.deepEqual(rows.map((row) => row.verdict), ['match', 'match', 'match', 'diverge'])
  assert.equal(rows[3].index, 3)
  assert.ok(rows[3].mae > 200)
  assert.ok(rows[3].psnr < PIXEL_QA_THRESHOLDS.close.psnr)
})

await check('compareRegions resamples a differently sized replica instead of throwing', () => {
  const reference = solidRgb(16, 16, [100, 100, 100])
  const replica = solidRgb(8, 8, [102, 102, 102])
  const rows = compareRegions(reference, replica, regionGrid(16, 16, 2, 2))
  assert.equal(rows.length, 4)
  for (const row of rows) {
    assert.equal(row.mae, 2)
    assert.ok(Number.isFinite(row.psnr) && Number.isFinite(row.deltaE00))
  }
})

await check('compareRegions rejects an empty or out-of-bounds grid with readable errors', () => {
  const image = solidRgb(16, 16, [0, 0, 0])
  assert.throws(() => compareRegions(image, image, []), /non-empty/i)
  assert.throws(
    () => compareRegions(image, image, [{ x: 10, y: 10, w: 8, h: 8, index: 0 }]),
    /exceeds/i,
  )
})

/* ------------------------------------------------------------------ *
 * E. Thresholds / determinism / output hygiene
 * ------------------------------------------------------------------ */

await check('PIXEL_QA_THRESHOLDS has the documented three-tier values', () => {
  assert.equal(PIXEL_QA_THRESHOLDS.match.psnr, 28)
  assert.equal(PIXEL_QA_THRESHOLDS.close.psnr, 22)
  assert.equal(PIXEL_QA_THRESHOLDS.match.ssim, 0.92)
  assert.equal(PIXEL_QA_THRESHOLDS.match.deltaE00, 3)
  assert.ok(PIXEL_QA_THRESHOLDS.close.ssim < PIXEL_QA_THRESHOLDS.match.ssim)
  assert.ok(PIXEL_QA_THRESHOLDS.match.psnr > PIXEL_QA_THRESHOLDS.close.psnr)
  assert.ok(Object.isFrozen(PIXEL_QA_THRESHOLDS))
  assert.ok(Object.isFrozen(PIXEL_QA_THRESHOLDS.match))
})

await check('comparePixels result is deterministic and JSON-serialisable (finite or ≤∞)', () => {
  const reference = solidRgb(32, 32, [90, 90, 90])
  const replica = makeRgb(32, 32, (x, y) => (x < 16 ? [90, 90, 90] : [140, 110, 70]))
  const first = comparePixels(reference, replica)
  const second = comparePixels(reference, replica)
  assert.deepEqual(first, second)
  assert.deepEqual(Object.keys(first).sort(), ['deltaE00', 'mae', 'psnr', 'rmse', 'ssim', 'verdict', 'worstRegions'])
  walkNumbers(first, 'result', (value, path) => {
    if (path === 'result.psnr') return // Infinity is the documented identity signal
    assert.ok(Number.isFinite(value), `${path} must be finite (got ${value})`)
  })
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first)
})

await check('all metric fields are finite for a diverging pair', () => {
  const black = solidRgb(24, 24, [0, 0, 0])
  const white = solidRgb(24, 24, [255, 255, 255])
  const result = comparePixels(black, white)
  walkNumbers(result, 'result', (value, path) => {
    assert.ok(Number.isFinite(value), `${path} must be finite (got ${value})`)
  })
})

await check('sub-window images (smaller than the SSIM window) still compare', () => {
  const black = solidRgb(2, 2, [0, 0, 0])
  const white = solidRgb(2, 2, [255, 255, 255])
  const result = comparePixels(black, white)
  assert.equal(result.verdict, 'diverge')
  assert.ok(Number.isFinite(result.ssim) && result.ssim < 0.01, `ssim=${result.ssim}`)
  assert.ok(result.worstRegions.length >= 1, 'tiny images should still produce worst regions')
  // regionGrid clamps a 3x3 request to the 2x2 image (no empty cells).
  assert.equal(regionGrid(2, 2).length, 4)
})

await check('comparePixels rejects malformed rasters with readable errors', () => {
  const good = solidRgb(8, 8, [1, 2, 3])
  assert.throws(() => comparePixels(good, { width: 8, height: 8, data: new Uint8Array(8) }), /cannot|shorter|required/i)
  assert.throws(() => comparePixels(good, { width: 0, height: 8, data: new Uint8Array(0) }), /positive integers/i)
  assert.throws(() => comparePixels(good, { width: 8, height: 8, channels: 5, data: new Uint8Array(8 * 8 * 5) }), /channels/i)
})

/* ------------------------------------------------------------------ *
 * Summary (gate.test.mjs skeleton)
 * ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`\n${name}\n${error.stack}`)
  process.exitCode = 1
}
