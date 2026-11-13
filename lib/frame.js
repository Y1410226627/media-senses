/**
 * Single-frame inspection.
 *
 * This is the model's "zoom lens": it decodes exactly one moment of a video (or
 * a still image) at a small raster, turns it into luminance art plus a hue-letter
 * map, and reports measurable visual properties. It is deliberately cheap so the
 * model can call it several times to resolve questions the storyboard raised.
 */
import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { formatTimecode, run, tailLines } from './ffmpeg.js'
const LUMINANCE_RAMP = ' .:-=+*#%@'

/** Decode a subprocess's stdout as raw bytes. */
function runBuffer(binary, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      binary,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'buffer', signal: options.signal },
      (error, stdout) => {
        if (error !== null && typeof error.code === 'string' && error.code === 'ENOENT') {
          reject(new Error(`cannot execute ${binary}: ${error.message}`))
          return
        }
        resolvePromise({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout: stdout ?? Buffer.alloc(0) })
      },
    )
  })
}

/** Convert RGB to HSL-ish descriptors (hue degrees, saturation, lightness). */
function rgbToHsl(r, g, b) {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const lightness = (max + min) / 2
  const delta = max - min
  let hue = 0
  let saturation = 0
  if (delta > 0.0001) {
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
    if (max === rn) hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60
    else if (max === gn) hue = ((bn - rn) / delta + 2) * 60
    else hue = ((rn - gn) / delta + 4) * 60
  }
  return { hue, saturation, lightness }
}

const HUE_BUCKETS = [
  { max: 15, name: 'red' },
  { max: 40, name: 'orange' },
  { max: 70, name: 'yellow' },
  { max: 160, name: 'green' },
  { max: 200, name: 'cyan' },
  { max: 260, name: 'blue' },
  { max: 300, name: 'purple' },
  { max: 340, name: 'magenta' },
  { max: 360, name: 'red' },
]

function hueName(degrees) {
  const value = ((Number(degrees) % 360) + 360) % 360
  for (const bucket of HUE_BUCKETS) if (value < bucket.max) return bucket.name
  return 'red'
}

function hueLetter(degrees) {
  const name = hueName(degrees)
  return { red: 'R', orange: 'O', yellow: 'Y', green: 'G', cyan: 'C', blue: 'B', purple: 'M', magenta: 'M' }[name] ?? 'R'
}

function toHex(r, g, b) {
  const part = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/**
 * Decode one frame of a video or a still image into a small RGB raster.
 *
 * @param {object} options
 * @param {{ffmpeg: string}} options.tools
 * @param {string} options.file absolute path
 * @param {number} [options.time] seconds into the video (ignored for images)
 * @param {string} options.workDir scratch dir (used as cwd)
 * @param {string} options.rawName relative raw file name
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {boolean} [options.isImage]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{width: number, height: number, rgb: Buffer}>}
 */
export async function decodeSmallFrame(options) {
  const width = options.width ?? 60
  const height = options.height ?? 24
  const args = ['-v', 'error', '-nostdin', '-y']
  if (options.isImage !== true) args.push('-ss', String(Math.max(0, options.time ?? 0)))
  args.push('-i', options.file, '-frames:v', '1', '-an', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=disable,format=rgb24`, '-f', 'rawvideo')
  // A relative output name keeps the filter graph free of Windows drive colons.
  args.push(options.rawName)
  const result = await run(options.tools.ffmpeg, args, { cwd: options.workDir, timeoutMs: 120_000, signal: options.signal })
  if (result.code !== 0) throw new Error(`cannot decode a frame from "${options.file}":\n${tailLines(result.stderr, 6)}`)
  return readRawRgb(join(options.workDir, options.rawName), width, height)
}

async function readRawRgb(path, width, height) {
  const { readFile } = await import('node:fs/promises')
  const buffer = await readFile(path)
  if (buffer.length < width * height * 3) throw new Error('decoded frame is smaller than requested')
  return { width, height, rgb: buffer.subarray(0, width * height * 3) }
}

/**
 * Render luminance art, hue letters and statistics from an RGB raster.
 *
 * @param {{width: number, height: number, rgb: Buffer}} raster
 * @param {{artWidth?: number, artHeight?: number}} [options]
 */
export function describeRaster(raster, options = {}) {
  const { width, height, rgb } = raster
  const artWidth = options.artWidth ?? 56
  const artHeight = options.artHeight ?? 22
  const luminance = new Float32Array(width * height)
  let sum = 0
  let sumSq = 0
  let saturationAccumulator = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const r = rgb[offset]
      const g = rgb[offset + 1]
      const b = rgb[offset + 2]
      const value = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      luminance[y * width + x] = value
      sum += value
      sumSq += value * value
      saturationAccumulator += rgbToHsl(r, g, b).saturation
    }
  }
  const total = width * height
  const mean = sum / total
  const variance = Math.max(0, sumSq / total - mean * mean)
  const contrast = Math.sqrt(variance)
  const meanSaturation = saturationAccumulator / total

  // Circular mean of hue (avoids the red-wrap artefact).
  let hueMean = 0
  {
    let sinSum = 0
    let cosSum = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3
        const hsl = rgbToHsl(rgb[offset], rgb[offset + 1], rgb[offset + 2])
        if (hsl.saturation <= 0.12 || hsl.lightness <= 0.08 || hsl.lightness >= 0.96) continue
        const radians = (hsl.hue * Math.PI) / 180
        sinSum += Math.sin(radians)
        cosSum += Math.cos(radians)
      }
    }
    if (sinSum !== 0 || cosSum !== 0) hueMean = ((Math.atan2(sinSum, cosSum) * 180) / Math.PI + 360) % 360
  }

  // Edge density: mean absolute luminance gradient (Sobel-lite), normalised.
  let edgeSum = 0
  let edgeCount = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const left = luminance[y * width + x - 1]
      const right = luminance[y * width + x + 1]
      const up = luminance[(y - 1) * width + x]
      const down = luminance[(y + 1) * width + x]
      edgeSum += Math.abs(right - left) + Math.abs(down - up)
      edgeCount += 1
    }
  }
  const edgeDensity = edgeCount > 0 ? Math.min(1, edgeSum / edgeCount / 0.5) : 0

  // Palette: 3 bits per channel quantisation, top 4 buckets by share.
  const buckets = new Map()
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const key = ((rgb[offset] >> 5) << 6) | ((rgb[offset + 1] >> 5) << 3) | (rgb[offset + 2] >> 5)
      const entry = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
      entry.count += 1
      entry.r += rgb[offset]
      entry.g += rgb[offset + 1]
      entry.b += rgb[offset + 2]
      buckets.set(key, entry)
    }
  }
  const paletteEntries = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 4)
  const palette = paletteEntries.map((entry) => ({
    hex: toHex(entry.r / entry.count, entry.g / entry.count, entry.b / entry.count),
    share: Math.round((entry.count / total) * 1000) / 1000,
  }))
  // Name the frame colour after the dominant *saturated* region: a circular mean
  // over a multi-coloured image (colour bars, UI screenshots) is meaningless.
  let namedHue = hueMean
  for (const entry of paletteEntries) {
    const hsl = rgbToHsl(entry.r / entry.count, entry.g / entry.count, entry.b / entry.count)
    if (hsl.saturation > 0.15 && hsl.lightness > 0.06 && hsl.lightness < 0.97) {
      namedHue = hsl.hue
      break
    }
  }

  // Art rasters (downsample by area average so thin details survive).
  const artLum = []
  const artHue = []
  const blockWidth = width / artWidth
  const blockHeight = height / artHeight
  for (let ay = 0; ay < artHeight; ay += 1) {
    let lumRow = ''
    let hueRow = ''
    for (let ax = 0; ax < artWidth; ax += 1) {
      const x0 = Math.floor(ax * blockWidth)
      const x1 = Math.max(x0 + 1, Math.floor((ax + 1) * blockWidth))
      const y0 = Math.floor(ay * blockHeight)
      const y1 = Math.max(y0 + 1, Math.floor((ay + 1) * blockHeight))
      let blockLum = 0
      let blockCount = 0
      let blockR = 0
      let blockG = 0
      let blockB = 0
      for (let y = y0; y < Math.min(y1, height); y += 1) {
        for (let x = x0; x < Math.min(x1, width); x += 1) {
          blockLum += luminance[y * width + x]
          const offset = (y * width + x) * 3
          blockR += rgb[offset]
          blockG += rgb[offset + 1]
          blockB += rgb[offset + 2]
          blockCount += 1
        }
      }
      if (blockCount === 0) {
        lumRow += ' '
        hueRow += '.'
        continue
      }
      const value = blockLum / blockCount
      const index = Math.max(0, Math.min(LUMINANCE_RAMP.length - 1, Math.round(value * (LUMINANCE_RAMP.length - 1))))
      lumRow += LUMINANCE_RAMP[index]
      const hsl = rgbToHsl(blockR / blockCount, blockG / blockCount, blockB / blockCount)
      hueRow += hsl.saturation > 0.15 && hsl.lightness > 0.07 && hsl.lightness < 0.97 ? hueLetter(hsl.hue) : '.'
    }
    artLum.push(lumRow)
    artHue.push(hueRow)
  }

  // Layout description from a 3×3 luminance grid.
  const grid = Array.from({ length: 3 }, () => [0, 0, 0])
  const counts = Array.from({ length: 3 }, () => [0, 0, 0])
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(2, Math.floor((y / height) * 3))
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(2, Math.floor((x / width) * 3))
      grid[gy][gx] += luminance[y * width + x]
      counts[gy][gx] += 1
    }
  }
  for (let gy = 0; gy < 3; gy += 1) for (let gx = 0; gx < 3; gx += 1) grid[gy][gx] /= Math.max(1, counts[gy][gx])
  const rowMean = (index) => (grid[index][0] + grid[index][1] + grid[index][2]) / 3
  const colMean = (index) => (grid[0][index] + grid[1][index] + grid[2][index]) / 3
  const notes = []
  const layoutParts = []
  const verticalDelta = rowMean(0) - rowMean(2)
  if (Math.abs(verticalDelta) > 0.1) layoutParts.push(verticalDelta > 0 ? '上亮下暗' : '上暗下亮')
  const horizontalDelta = colMean(0) - colMean(2)
  if (Math.abs(horizontalDelta) > 0.1) layoutParts.push(horizontalDelta > 0 ? '左亮右暗' : '左暗右亮')
  const centre = grid[1][1]
  const border = (rowMean(0) + rowMean(2) + colMean(0) + colMean(2)) / 4
  if (centre - border > 0.12) layoutParts.push('中心亮、四周暗（主体居中）')
  else if (border - centre > 0.12) layoutParts.push('四周亮、中心暗（边框/暗角构图）')
  const layout = layoutParts.length > 0 ? layoutParts.join('，') : '亮度分布均匀'
  if (edgeDensity > 0.28) notes.push('细节密集，可能是文字、图表或复杂场景')
  else if (edgeDensity < 0.06) notes.push('画面高度简洁：大片纯色或严重虚化/失焦')
  if (contrast > 0.28) notes.push('高对比（强光暗对比或硬光造型）')
  else if (contrast < 0.08) notes.push('低对比，画面灰平（雾、低照度或低饱和设计）')
  if (meanSaturation < 0.1) notes.push('几乎无彩色：黑白/单色或去饱和度处理')
  if (meanSaturation > 0.6) notes.push('色彩浓烈，可能是动画、海报或高饱和大色块')
  if (mean > 0.85) notes.push('接近过曝的亮场')
  if (mean < 0.08) notes.push('接近全黑的暗场')

  return {
    summary: {
      brightness: round(mean, 3),
      contrast: round(contrast, 3),
      saturation: round(meanSaturation, 3),
      edgeDensity: round(edgeDensity, 3),
      hueDeg: Math.round(namedHue),
      hueName: hueName(namedHue),
      hueHex: dominantHex(palette, mean),
      layout,
      palette,
    },
    ascii: artLum.join('\n'),
    hueMap: artHue.join('\n'),
    notes,
  }
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function dominantHex(palette, mean) {
  if (Array.isArray(palette) && palette.length > 0) return palette[0].hex
  const level = Math.round(Math.max(0, Math.min(1, mean)) * 255)
  return toHex(level, level, level)
}

/**
 * Full single-frame analysis used by the `media_frame` tool.
 *
 * @param {object} options
 * @param {{ffmpeg: string, ffprobe: string}} options.tools
 * @param {string} options.file
 * @param {number} options.time
 * @param {string} options.workDir
 * @param {string} options.outputDir
 * @param {boolean} [options.isImage]
 * @param {AbortSignal} [options.signal]
 * @param {{maxWidth?: number}} [options.options]
 */
export async function analyzeFrame(options) {
  const { tools, file, workDir, outputDir } = options
  const time = Math.max(0, Number.isFinite(options.time) ? options.time : 0)
  const maxWidth = options.options?.maxWidth ?? 960
  const warnings = []

  // 1. Save a viewable still.
  const imagePath = join(outputDir, `frame-${String(Math.round(time * 1000)).padStart(8, '0')}ms.jpg`)
  await mkdir(outputDir, { recursive: true })
  const saveArgs = ['-v', 'error', '-nostdin', '-y']
  if (options.isImage !== true) saveArgs.push('-ss', String(time))
  saveArgs.push('-i', file, '-frames:v', '1', '-an', '-vf', `scale='min(${maxWidth},iw)':-2:flags=lanczos`, '-q:v', '3', imagePath)
  const saved = await run(tools.ffmpeg, saveArgs, { cwd: workDir, timeoutMs: 120_000, signal: options.signal })
  let storedImage = imagePath
  if (saved.code !== 0) {
    warnings.push(`could not save a still image: ${tailLines(saved.stderr, 4)}`)
    storedImage = undefined
  }

  // 2. Small raster for the text renderings.
  const raster = await decodeSmallFrame({
    tools,
    file,
    time,
    workDir,
    rawName: `frame-${Math.round(time * 1000)}.rgb`,
    width: 60,
    height: 24,
    isImage: options.isImage === true,
    signal: options.signal,
  })
  const described = describeRaster(raster)

  const statInfo = await stat(storedImage).catch(() => undefined)
  return {
    summary: described.summary,
    ascii: described.ascii,
    hueMap: described.hueMap,
    notes: described.notes,
    warnings,
    imagePath: storedImage,
    imageBytes: statInfo?.size ?? 0,
    time,
    timecode: formatTimecode(time),
  }
}

export { hueName, hueLetter, toHex }
