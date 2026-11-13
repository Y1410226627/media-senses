/**
 * Screen capture + token-aligned frame sheets for media-senses.
 *
 * Absorbed (re-implemented with zero dependencies) from `dsh-see-now`
 * <https://github.com/SAOS-3624/dsh-see-now> by SAOS-3624, Apache-2.0:
 *
 *   - the "change-driven sheet" idea: capture a short burst, keep the frames
 *     that actually changed, and pack several frames into ONE image so the
 *     fixed per-image cost is amortised over frames instead of paid per frame;
 *   - the 42 px token alignment: the host bills images on a 14 px patch grid
 *     that pads up to 42 px cells (roughly `rows x (cols + 1) + 2` vision
 *     tokens). A canvas whose width is an exact multiple of 42 therefore never
 *     pays for a partially filled padded column: 798 (19 columns) instead of
 *     800 (padded to 20), 1050 instead of 1066, 1260 instead of 1280. The area
 *     saved is ~0.25 %, the cost saved is a whole column per delivered image.
 *
 * This module only composes: `listSources` (platform/engine detection),
 * `captureFrames` (bounded ffmpeg capture of the Windows desktop),
 * `planSheet` (decide canvas geometry before capture so frames are captured at
 * exactly their cell size) and `buildSheet` (compose the PNG sheet with a
 * built-in 3x5 bitmap font, no drawtext, no font files, no image libraries).
 *
 * Windows capture notes:
 *   - `gdigrab` is the primary engine (it is a *demuxer*: `-f gdigrab -i
 *     desktop`), `ddagrab` (Desktop Duplication API, a *source filter* driven
 *     through lavfi) is the fallback. ddagrab needs a working interactive
 *     desktop-duplication session; on headless/remote sessions it fails while
 *     gdigrab still works.
 *   - every ffmpeg call runs with `cwd` = a private work directory, so filter
 *     graphs never contain a Windows absolute path (a drive-letter colon breaks
 *     filter graph parsing). Absolute paths are only used for `-i` / output
 *     file arguments, where they are safe.
 *   - one-shot stills use `-framerate 30` rather than the nominal `-framerate
 *     1`: with this ffmpeg build (9.0.2) `-framerate 1 -frames:v 1` spends
 *     ~1.9 s idle before delivering the first frame (measured: 2184 ms at 1 fps
 *     vs 356 ms at 30 fps), which is not acceptable for "look at the screen
 *     now". The first grabbed frame is identical either way.
 */
import { execFile } from 'node:child_process'
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { Canvas } from './png.js'
import { makeWorkDir, resolveTools, run, tailLines } from './ffmpeg.js'

/** Host vision billing cell: 14 px patches pad up to 42 px cells. */
export const TOKEN_CELL = 42
/** Raw patch size the 42 px cell is computed from (kept for documentation). */
export const TOKEN_PATCH = 14

/**
 * Quality tiers: the sheet canvas width is the only thing that changes between
 * tiers; every width is a multiple of 42 (19 / 25 / 30 patch columns). These are
 * the upstream `dsh-see-now` widths, which are deliberately *not* 800/1066/1280.
 */
export const QUALITY_TIERS = Object.freeze({
  low: Object.freeze({ width: 798, patchColumns: 19 }),
  standard: Object.freeze({ width: 1050, patchColumns: 25 }),
  high: Object.freeze({ width: 1260, patchColumns: 30 }),
})

const DEFAULT_QUALITY = 'low'
const DEFAULT_GAP = 2
const DEFAULT_BACKGROUND = [16, 18, 26]
const DEFAULT_FPS = 12
const DEFAULT_WIDTH = 1280
/** One-shot stills trade the nominal 1 fps for latency (see header note). */
const ONE_SHOT_FRAMERATE = 30
/** Hard bounds: a capture may never block the host for longer than this. */
const MAX_CAPTURE_SECONDS = 30
const MAX_CAPTURE_FRAMES = 400
/**
 * Raw-video byte budget for a clip (`width x height x 3 x frames`). This is a
 * second, memory/disk-safety bound on top of the frame count: 400 frames of a
 * 1260-wide still would be > 1 GB of intermediate data. Frames are streamed off
 * disk one at a time, so RAM stays at one frame; this budget bounds the file.
 */
const MAX_RAW_BYTES = 384 * 1024 * 1024
const MAX_CAPTURE_WIDTH = 4096
const MIN_CAPTURE_WIDTH = 16
const ONE_SHOT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let captureCounter = 0

function stamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-')
}

function nextTag() {
  captureCounter += 1
  return `${stamp()}-${captureCounter}`
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return clamp(Math.round(number), min, max)
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function abortError() {
  const error = new Error('screen capture was aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError()
}

function hexOf(r, g, b) {
  const part = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/** Run a binary and keep stdout as raw bytes (decoding images to rgb24). */
function runBuffer(binary, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      binary,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024 * 1024,
        windowsHide: true,
        encoding: 'buffer',
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code === 'string' && error.code === 'ENOENT') {
          reject(new Error(`cannot execute ${binary}: ${error.message}`))
          return
        }
        resolvePromise({
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
        })
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Token arithmetic
// ---------------------------------------------------------------------------

/**
 * Vision-token cost of a canvas, using the host's patch grid arithmetic.
 *
 * The host pads the image to whole 14 px patches, which pad up to 42 px cells,
 * and charges approximately `rows x (cols + 1) + 2` tokens. So a canvas width
 * that is a multiple of 42 has zero width padding and never pays for a column
 * that only exists as padding.
 *
 * The upstream `dsh-see-now` README numbers reproduce exactly:
 *   798 x 462 -> 19 cols, 11 rows -> 11*(19+1)+2 = 222  (low, 16:9 + audio bar)
 *   1050 x 630 -> 25 cols, 15 rows -> 392              (standard)
 *   1260 x 756 -> 30 cols, 18 rows -> 560              (high)
 *   1596 x 924 -> 38 cols, 22 rows -> 860              (ultra)
 *
 * This module keeps the formula but fits the canvas height to the grid it
 * actually places (there is no audio bar yet), so e.g. six 3x2 frames at `low`
 * cost 798 x 334 -> 8 rows -> 8*(19+1)+2 = 162 tokens.
 *
 * @param {number} canvasWidth  canvas width in px
 * @param {number} canvasHeight canvas height in px
 * @returns {number} estimated vision tokens (finite, >= 2)
 */
export function tokenEstimateFor(canvasWidth, canvasHeight) {
  const width = Number(canvasWidth)
  const height = Number(canvasHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`tokenEstimateFor needs a positive width/height (got ${canvasWidth}x${canvasHeight})`)
  }
  const columns = Math.ceil(width / TOKEN_CELL)
  const rows = Math.ceil(height / TOKEN_CELL)
  return rows * (columns + 1) + 2
}

// ---------------------------------------------------------------------------
// planSheet: decide canvas geometry before capturing
// ---------------------------------------------------------------------------

function normaliseQuality(quality) {
  const key = typeof quality === 'string' && quality.trim().length > 0 ? quality.trim().toLowerCase() : DEFAULT_QUALITY
  if (!Object.hasOwn(QUALITY_TIERS, key)) {
    throw new Error(`unknown quality "${quality}"; expected one of ${Object.keys(QUALITY_TIERS).join(', ')}`)
  }
  return key
}

function normaliseGap(gap) {
  const number = Number(gap)
  if (!Number.isFinite(number)) return DEFAULT_GAP
  return clamp(Math.round(number), 0, 16)
}

function normaliseColour(value, fallback = DEFAULT_BACKGROUND) {
  if (!Array.isArray(value) || value.length < 3) return [...fallback]
  const channels = value.slice(0, 3).map((channel) => {
    const number = Number(channel)
    return Number.isFinite(number) ? clamp(Math.round(number), 0, 255) : 0
  })
  return channels
}

/**
 * Plan the cell grid and canvas size for a sheet.
 *
 * Grid policy (mirrors upstream's "tier k" cell sizing): the grid has
 * `columns = ceil(sqrt(frameCount))` (capped at frameCount) columns, so each
 * cell is roughly 1/k of the tier width and the sheet stays close to square-ish.
 * Quality only changes the canvas WIDTH; the frame count changes the cell size
 * and therefore the height. Because tokens are billed per 42 px row, what
 * actually drives cost is how many rows the grid needs: the reported
 * `tokenEstimate` is that bill.
 *
 * Cell aspect tracks `sourceWidth / sourceHeight` within one pixel; the captured
 * frames should be scaled to `cellWidth x cellHeight` long side <= tier width,
 * which is what `captureFrames({ width: cellWidth })` does.
 *
 * @param {{frameCount?: number, sourceWidth?: number, sourceHeight?: number,
 *          quality?: 'low'|'standard'|'high', gap?: number}} [options]
 * @returns {{canvasWidth: number, canvasHeight: number, columns: number, rows: number,
 *            cellWidth: number, cellHeight: number, tokenEstimate: number,
 *            quality: string, gap: number, frameCount: number,
 *            sourceWidth: number, sourceHeight: number, sourceAssumed: boolean}}
 */
export function planSheet(options = {}) {
  const frameCount = Number(options.frameCount)
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new Error(`planSheet needs an integer frameCount >= 1 (got ${JSON.stringify(options.frameCount)})`)
  }
  const quality = normaliseQuality(options.quality)
  const tier = QUALITY_TIERS[quality]
  const gap = normaliseGap(options.gap)

  const givenWidth = Number(options.sourceWidth)
  const givenHeight = Number(options.sourceHeight)
  const sourceAssumed = !(Number.isFinite(givenWidth) && givenWidth > 0 && Number.isFinite(givenHeight) && givenHeight > 0)
  // Default to a 16:9 frame when the caller does not know the source yet; the
  // token estimate is barely sensitive to it (a 16:10 desktop lands in the same
  // 42 px row band as 16:9 for typical frame counts).
  const sourceWidth = sourceAssumed ? 1920 : givenWidth
  const sourceHeight = sourceAssumed ? 1080 : givenHeight

  const tierColumns = Math.ceil(Math.sqrt(frameCount))
  const columns = Math.max(1, Math.min(frameCount, tierColumns))
  const rows = Math.ceil(frameCount / columns)
  // Outer padding counts as one gap per side so the cell boxes stay centred.
  const cellWidth = Math.max(1, Math.floor((tier.width - (columns + 1) * gap) / columns))
  const cellHeight = Math.max(1, Math.round((cellWidth * sourceHeight) / sourceWidth))
  const canvasWidth = tier.width // already a multiple of 42 by construction
  const canvasHeight = rows * cellHeight + (rows + 1) * gap
  if (canvasHeight > 16_384) {
    throw new Error(
      `planSheet: a ${sourceWidth}x${sourceHeight} source needs a ${canvasWidth}x${canvasHeight} canvas, ` +
        'which is unreasonably tall for a sheet; pass wider frames / fewer frames / a wider quality tier',
    )
  }
  return {
    canvasWidth,
    canvasHeight,
    columns,
    rows,
    cellWidth,
    cellHeight,
    tokenEstimate: tokenEstimateFor(canvasWidth, canvasHeight),
    quality,
    gap,
    frameCount,
    sourceWidth,
    sourceHeight,
    sourceAssumed,
  }
}

// ---------------------------------------------------------------------------
// listSources: platform / engine detection
// ---------------------------------------------------------------------------

const engineCache = new Map()

async function detectEngines(tools, signal) {
  const key = tools.ffmpeg
  if (!engineCache.has(key)) {
    const pending = (async () => {
      const devices = await run(tools.ffmpeg, ['-hide_banner', '-devices'], { timeoutMs: 20_000, signal })
      const filters = await run(tools.ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 20_000, signal })
      const text = [devices.stdout, devices.stderr, filters.stdout, filters.stderr].join('\n')
      return {
        gdigrab: /\bgdigrab\b/u.test(text),
        ddagrab: /\bddagrab\b/u.test(text),
      }
    })().catch((error) => {
      engineCache.delete(key)
      throw error
    })
    engineCache.set(key, pending)
  }
  return engineCache.get(key)
}

/**
 * Report which screen-capture engines ffmpeg exposes on this machine.
 *
 * Windows only: `gdigrab` is preferred (it works on plain GDI desktops and in
 * remote/headless sessions), `ddagrab` is reported when the filter exists but is
 * only tried at capture time (it needs a usable Desktop Duplication session).
 *
 * @param {{tools?: object, signal?: AbortSignal}} [options]
 * @returns {Promise<{screen: boolean, engines: string[], platform: string, source: string, warnings: string[]}>}
 */
export async function listSources(options = {}) {
  const tools = options.tools ?? (await resolveTools())
  if (process.platform !== 'win32') {
    return {
      screen: false,
      engines: [],
      platform: process.platform,
      source: 'unsupported-platform',
      warnings: [
        `screen capture is only implemented for Windows in this build (platform: ${process.platform}); ` +
          'use a video/image file source instead',
      ],
    }
  }
  let detected
  try {
    detected = await detectEngines(tools, options.signal)
  } catch (error) {
    if (options.signal?.aborted === true) throw abortError()
    return {
      screen: false,
      engines: [],
      platform: process.platform,
      source: 'detection-failed',
      warnings: [`could not inspect the ffmpeg build for capture engines: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
  const warnings = []
  const engines = []
  if (detected.gdigrab) engines.push('gdigrab')
  if (detected.ddagrab) engines.push('ddagrab')
  if (engines.length === 0) {
    warnings.push('ffmpeg exposes neither gdigrab nor ddagrab; screen capture is unavailable on this machine')
  } else if (engines[0] === 'gdigrab' && detected.ddagrab) {
    warnings.push('both gdigrab and ddagrab are available; gdigrab is the primary engine and ddagrab is used as fallback when it fails')
  } else if (!detected.gdigrab) {
    warnings.push('gdigrab is not available; falling back to ddagrab (Desktop Duplication API)')
  }
  return { screen: engines.length > 0, engines, platform: process.platform, source: 'windows-desktop', warnings }
}

// ---------------------------------------------------------------------------
// RGB analysis (black-screen honesty)
// ---------------------------------------------------------------------------

/**
 * Measure an rgb24 raster: luminance mean/variance, capped distinct colours and
 * whether the frame is uniformly one colour. A locked screen or the secure
 * desktop looks exactly like a uniformly black frame, so capture results say so
 * instead of silently returning black.
 *
 * @param {Uint8Array|Buffer} rgb
 * @param {{maxDistinct?: number}} [options]
 */
export function analyseRgb(rgb, options = {}) {
  if (!(rgb instanceof Uint8Array)) throw new TypeError('analyseRgb expects a Uint8Array/Buffer of rgb24 pixels')
  const pixelCount = Math.floor(rgb.length / 3)
  if (pixelCount === 0) throw new Error('analyseRgb received an empty buffer')
  const maxDistinct = clampInt(options.maxDistinct, 4096, 2, 1 << 20)
  const seen = new Set()
  let sum = 0
  let sumSq = 0
  let min = 255
  let max = 0
  for (let offset = 0; offset + 2 < rgb.length; offset += 3) {
    const r = rgb[offset]
    const g = rgb[offset + 1]
    const b = rgb[offset + 2]
    if (seen.size < maxDistinct) seen.add((r << 16) | (g << 8) | b)
    const luma = (r * 299 + g * 587 + b * 114) / 1000
    sum += luma
    sumSq += luma * luma
    if (luma < min) min = luma
    if (luma > max) max = luma
  }
  const mean = sum / pixelCount
  const variance = Math.max(0, sumSq / pixelCount - mean * mean)
  return {
    pixels: pixelCount,
    distinctColours: seen.size,
    cappedDistinct: seen.size >= maxDistinct,
    uniform: seen.size === 1,
    dominantColour: seen.size > 0 ? hexOf(rgb[0], rgb[1], rgb[2]) : '#000000',
    meanLuminance: round(mean, 2),
    variance: round(variance, 2),
    standardDeviation: round(Math.sqrt(variance), 2),
    minLuminance: round(min, 2),
    maxLuminance: round(max, 2),
  }
}

/** Fast early-exit uniform check (used per frame while splitting a clip). */
function isUniformRgb(rgb) {
  const r0 = rgb[0]
  const g0 = rgb[1]
  const b0 = rgb[2]
  for (let offset = 3; offset + 2 < rgb.length; offset += 3) {
    if (rgb[offset] !== r0 || rgb[offset + 1] !== g0 || rgb[offset + 2] !== b0) return false
  }
  return true
}

function flatFrameWarnings(stats, where) {
  if (!stats.uniform) return []
  if (stats.meanLuminance <= 4) {
    return [
      `${where} is uniformly black (${stats.dominantColour}); the desktop may be locked, the secure desktop (UAC) ` +
        'may be showing, the display may be off, or the capture engine grabbed an empty surface',
    ]
  }
  return [`${where} is a single flat colour (${stats.dominantColour}); the captured surface may be empty or blocked`]
}

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

/** Parse "x,y,w,h" (or {x,y,width,height}) into positive integers. */
function parseRegion(value) {
  if (value === undefined || value === null || value === '') return null
  let x
  let y
  let width
  let height
  if (typeof value === 'string') {
    const parts = value.split(',').map((part) => part.trim())
    if (parts.length !== 4) throw new Error(`region must be "x,y,w,h" in physical pixels (got ${JSON.stringify(value)})`)
    ;[x, y, width, height] = parts.map((part) => Number(part))
  } else if (typeof value === 'object') {
    x = Number(value.x ?? 0)
    y = Number(value.y ?? 0)
    width = Number(value.width ?? value.w)
    height = Number(value.height ?? value.h)
  } else {
    throw new Error(`region must be "x,y,w,h" or {x,y,width,height} (got ${typeof value})`)
  }
  if (![x, y, width, height].every((number) => Number.isFinite(number))) {
    throw new Error(`region has non-numeric parts (got ${JSON.stringify(value)})`)
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`region coordinates must be integers in physical pixels (got ${JSON.stringify(value)})`)
  }
  if (width < 1 || height < 1) throw new Error(`region needs width/height >= 1 (got ${width}x${height})`)
  return { x, y, width, height }
}

/** ffmpeg wants a rational frame rate; 12.5 would not parse. */
function rateString(fps) {
  const value = Number(fps)
  if (!Number.isFinite(value) || value <= 0) return String(DEFAULT_FPS)
  if (Number.isInteger(value)) return String(value)
  return `${Math.round(value * 1000)}/1000`
}

/** gdigrab private input options (must precede `-i desktop`). */
function gdigrabInputArgs(region, framerate) {
  const args = ['-f', 'gdigrab', '-framerate', rateString(framerate)]
  if (region !== null) {
    args.push(
      '-offset_x',
      String(region.x),
      '-offset_y',
      String(region.y),
      '-video_size',
      `${region.width}x${region.height}`,
    )
  }
  return args
}

/** lavfi source expression for ddagrab (no path, so no filtergraph escaping). */
function ddagrabInput(region, framerate) {
  let expression = `ddagrab=output_idx=0:framerate=${rateString(framerate)}`
  if (region !== null) {
    expression += `:video_size=${region.width}x${region.height}:offset_x=${region.x}:offset_y=${region.y}`
  }
  return expression
}

/**
 * Aspect-preserving scale expression; the long side is normalised to `width`
 * (the planned cell size), so every captured frame matches the planned grid.
 */
function scaleExpression(width) {
  return `scale=${width}:${width}:force_original_aspect_ratio=decrease:flags=lanczos`
}

function oneShotArgs(engine, { width, region, outputPath }) {
  if (engine === 'ddagrab') {
    return [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      ddagrabInput(region, ONE_SHOT_FRAMERATE),
      '-frames:v',
      '1',
      '-vf',
      `hwdownload,format=bgra,${scaleExpression(width)}`,
      outputPath,
    ]
  }
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...gdigrabInputArgs(region, ONE_SHOT_FRAMERATE),
    '-i',
    'desktop',
    '-frames:v',
    '1',
    '-vf',
    scaleExpression(width),
    outputPath,
  ]
}

function clipArgs(engine, { fps, seconds, targetWidth, targetHeight, rawName, region }) {
  const scale = `scale=${targetWidth}:${targetHeight}:flags=lanczos`
  if (engine === 'ddagrab') {
    return [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      ddagrabInput(region, fps),
      '-t',
      String(seconds),
      '-vf',
      `hwdownload,format=bgra,${scale}`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      rawName,
    ]
  }
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...gdigrabInputArgs(region, fps),
    '-i',
    'desktop',
    '-t',
    String(seconds),
    '-vf',
    scale,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    rawName,
  ]
}

/** Read the PNG IHDR dimensions; returns undefined when the file is not a PNG. */
async function pngDimensions(path) {
  let handle
  try {
    handle = await open(path, 'r')
    const header = Buffer.alloc(24)
    const { bytesRead } = await handle.read(header, 0, 24, 0)
    if (bytesRead < 24) return undefined
    const signature = header.subarray(0, 8).toString('hex')
    if (signature !== '89504e470d0a1a0a') return undefined
    if (header.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Decode any ffmpeg-readable image to a strict rgb24 buffer. */
async function decodeImageToRgb(tools, file, dimensions, options = {}) {
  const result = await runBuffer(
    tools.ffmpeg,
    ['-hide_banner', '-v', 'error', '-nostdin', '-i', file, '-frames:v', '1', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { cwd: options.workDir, timeoutMs: 60_000, signal: options.signal },
  )
  if (result.code !== 0) {
    throw new Error(`cannot decode "${file}" to rgb24:\n${tailLines(result.stderr, 6)}`)
  }
  const expected = dimensions.width * dimensions.height * 3
  if (result.stdout.length < expected) {
    throw new Error(
      `decoding "${file}" produced ${result.stdout.length} bytes, expected ${expected} ` +
        `for ${dimensions.width}x${dimensions.height} rgb24`,
    )
  }
  return result.stdout.subarray(0, expected)
}

/** Resolve the source aspect ratio without grabbing a full frame when possible. */
async function sourceAspectRatio({ tools, engine, region, workDir, signal }) {
  if (region !== null) return region.width / region.height
  if (engine === 'gdigrab') {
    const probe = await run(
      tools.ffprobe,
      ['-hide_banner', '-v', 'error', '-f', 'gdigrab', '-i', 'desktop', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'],
      { timeoutMs: 20_000, signal },
    )
    if (probe.code === 0) {
      const match = /(\d+)\s*,\s*(\d+)/u.exec(probe.stdout.trim())
      if (match) return Number(match[1]) / Number(match[2])
    }
  }
  // Fallback: a tiny still tells us the aspect ratio even when ffprobe cannot
  // open the capture device (e.g. ddagrab).
  const probePath = join(workDir, `aspect-${nextTag()}.png`)
  const result = await run(tools.ffmpeg, oneShotArgs(engine, { width: 64, region, outputPath: probePath }), {
    cwd: workDir,
    timeoutMs: ONE_SHOT_TIMEOUT_MS,
    signal,
  })
  try {
    if (result.code !== 0) throw new Error(`cannot probe the capture aspect: ${tailLines(result.stderr, 6)}`)
    const dimensions = await pngDimensions(probePath)
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new Error('aspect probe PNG is unreadable')
    return dimensions.width / dimensions.height
  } finally {
    await rm(probePath, { force: true }).catch(() => {})
  }
}

/** Target frame dimensions: long side == width, aspect preserved, both >= 2. */
function targetDimensions(width, aspect) {
  const longSide = Math.max(2, Math.round(Number(width)))
  const ratio = Number(aspect)
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(`invalid source aspect ratio ${aspect}`)
  if (ratio >= 1) return { width: longSide, height: Math.max(2, Math.round(longSide / ratio)) }
  return { width: Math.max(2, Math.round(longSide * ratio)), height: longSide }
}

/** Write one raw rgb24 frame as a PNG via lib/png.js. */
async function writeRgbPng(path, rgb, width, height) {
  const canvas = new Canvas(width, height)
  const target = canvas.data
  const pixels = width * height
  for (let i = 0, source = 0, targetIndex = 0; i < pixels; i += 1, source += 3, targetIndex += 4) {
    target[targetIndex] = rgb[source]
    target[targetIndex + 1] = rgb[source + 1]
    target[targetIndex + 2] = rgb[source + 2]
    target[targetIndex + 3] = 255
  }
  await canvas.save(path)
}

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
}

// ---------------------------------------------------------------------------
// captureFrames
// ---------------------------------------------------------------------------

async function captureStill({ tools, engine, width, region, outputDir, workDir, signal }) {
  const outputPath = join(outputDir, `screen-${nextTag()}.png`)
  const started = Date.now()
  const result = await run(tools.ffmpeg, oneShotArgs(engine, { width, region, outputPath }), {
    cwd: workDir,
    timeoutMs: ONE_SHOT_TIMEOUT_MS,
    signal,
  })
  const captureMs = Date.now() - started
  throwIfAborted(signal)
  if (result.code !== 0) {
    throw new Error(`ffmpeg ${engine} exited with code ${result.code}:\n${tailLines(result.stderr, 8)}`)
  }
  const info = await stat(outputPath).catch(() => undefined)
  if (info === undefined || info.size === 0) throw new Error(`ffmpeg ${engine} produced no frame file`)
  const dimensions = await pngDimensions(outputPath)
  if (dimensions === undefined) throw new Error(`ffmpeg ${engine} produced a file that is not a readable PNG`)
  const rgb = await decodeImageToRgb(tools, outputPath, dimensions, { workDir, signal })
  const stats = analyseRgb(rgb)
  return {
    frames: [{ index: 0, path: outputPath, time: 0 }],
    width: dimensions.width,
    height: dimensions.height,
    stats,
    captureMs,
    warnings: flatFrameWarnings(stats, `captured frame (${dimensions.width}x${dimensions.height})`),
  }
}

async function captureClip({ tools, engine, width, fps, seconds, region, outputDir, workDir, signal, warnings }) {
  const aspect = await sourceAspectRatio({ tools, engine, region, workDir, signal })
  throwIfAborted(signal)
  const dimensions = targetDimensions(width, aspect)
  const frameBytes = dimensions.width * dimensions.height * 3
  // Byte budget: shrink the requested duration so the raw intermediate cannot
  // fill the disk (frames are streamed later, so RAM stays at one frame).
  let effectiveSeconds = seconds
  const maxFramesByBytes = Math.max(1, Math.floor(MAX_RAW_BYTES / frameBytes))
  const frameBudget = Math.min(MAX_CAPTURE_FRAMES, maxFramesByBytes)
  const maxSecondsForBudget = frameBudget / fps
  if (effectiveSeconds > maxSecondsForBudget) {
    warnings.push(
      `clip is bounded to ~${Math.floor(MAX_RAW_BYTES / (1024 * 1024))} MiB of raw frames ` +
        `(${frameBudget} frames at ${dimensions.width}x${dimensions.height}); recording ${round(maxSecondsForBudget, 2)}s ` +
        `instead of ${round(effectiveSeconds, 2)}s`,
    )
    effectiveSeconds = maxSecondsForBudget
  }
  const rawName = `frames-${nextTag()}.rgb`
  const rawPath = join(workDir, rawName)
  const expectedFrames = Math.max(1, Math.round(effectiveSeconds * fps))
  const started = Date.now()
  const result = await run(tools.ffmpeg, clipArgs(engine, {
    fps,
    seconds: effectiveSeconds,
    targetWidth: dimensions.width,
    targetHeight: dimensions.height,
    rawName,
    region,
  }), {
    cwd: workDir,
    timeoutMs: Math.ceil((effectiveSeconds + 20) * 1000),
    signal,
    maxBuffer: 16 * 1024 * 1024,
  })
  const captureMs = Date.now() - started
  throwIfAborted(signal)
  if (result.code !== 0) {
    throw new Error(`ffmpeg ${engine} exited with code ${result.code}:\n${tailLines(result.stderr, 8)}`)
  }
  const rawInfo = await stat(rawPath).catch(() => undefined)
  if (rawInfo === undefined || rawInfo.size === 0) throw new Error(`ffmpeg ${engine} wrote no raw frames`)
  const frameCount = Math.min(MAX_CAPTURE_FRAMES, Math.floor(rawInfo.size / frameBytes))
  if (rawInfo.size % frameBytes !== 0) {
    warnings.push(`raw capture ended mid-frame (${rawInfo.size} bytes); the last partial frame was dropped`)
  }
  if (frameCount === 0) {
    throw new Error(`ffmpeg ${engine} wrote ${rawInfo.size} bytes, fewer than one ${frameBytes}-byte frame`)
  }
  if (Math.abs(frameCount - expectedFrames) > 1) {
    warnings.push(
      `requested about ${expectedFrames} frames (${round(effectiveSeconds, 2)}s at ${fps} fps) but ffmpeg delivered ${frameCount}; ` +
        'screen capture is wall-clock bound and may drop frames on a busy machine',
    )
  }

  const frames = []
  let firstStats
  let uniformFrames = 0
  const handle = await open(rawPath, 'r')
  try {
    const frameBuffer = Buffer.allocUnsafe(frameBytes)
    for (let index = 0; index < frameCount; index += 1) {
      throwIfAborted(signal)
      const { bytesRead } = await handle.read(frameBuffer, 0, frameBytes, index * frameBytes)
      if (bytesRead < frameBytes) {
        warnings.push(`raw capture ended after ${index} complete frames; the rest was dropped`)
        break
      }
      // `frameBuffer` is reused for the next frame, so everything that needs the
      // pixels (stats + PNG encode) must happen before the next read.
      if (index === 0) {
        firstStats = analyseRgb(frameBuffer)
        if (firstStats.uniform) uniformFrames += 1
      } else if (isUniformRgb(frameBuffer)) {
        uniformFrames += 1
      }
      const framePath = join(outputDir, `frame-${String(index).padStart(4, '0')}.png`)
      await writeRgbPng(framePath, frameBuffer, dimensions.width, dimensions.height)
      frames.push({ index, path: framePath, time: round(index / fps, 3) })
    }
  } finally {
    await handle.close().catch(() => {})
    await rm(rawPath, { force: true }).catch(() => {})
  }
  const frameWarnings = flatFrameWarnings(firstStats, 'the first captured frame')
  if (uniformFrames > 1) {
    frameWarnings.push(
      `${uniformFrames} of the ${frames.length} captured frames are uniformly one colour ` +
        '(the screen may be locked, the secure desktop may be showing, or nothing is changing)',
    )
  }
  return {
    frames,
    width: dimensions.width,
    height: dimensions.height,
    stats: firstStats,
    seconds: effectiveSeconds,
    captureMs,
    warnings: frameWarnings,
  }
}

/**
 * Capture the Windows desktop once, or record a short bounded clip and split it
 * into PNG frames.
 *
 * One-shot (`seconds === 0`) captures a single still and verifies it by decoding
 * the PNG back to rgb24; uniformly black/flat frames are reported in `warnings`
 * rather than silently returned (a locked screen looks exactly like that).
 *
 * A clip (`seconds > 0`) is bounded to 30 s, 400 frames and a 384 MiB raw-frame
 * budget, records raw rgb24 into a relative file under `workDir`, then streams
 * that file into PNGs (one frame of RAM) with `lib/png.js`. The raw intermediate
 * is deleted afterwards; ffmpeg is killed on abort via the `signal`.
 *
 * @param {{tools?: object, workDir?: string, outputDir?: string,
 *          options?: {seconds?: number, fps?: number, width?: number,
 *                     region?: string|{x:number,y:number,width:number,height:number},
 *                     source?: 'screen', engine?: 'gdigrab'|'ddagrab'},
 *          signal?: AbortSignal}} [options]
 * @returns {Promise<{frames: Array<{index:number,path:string,time:number}>, width:number,
 *                    height:number, elapsedMs:number, captureMs:number, engine:string,
 *                    fps:number, seconds:number, region:object|null, outputDir:string,
 *                    stats:object, platform:string, source:string, warnings:string[]}>}
 */
export async function captureFrames(options = {}) {
  const started = Date.now()
  const tools = options.tools ?? (await resolveTools())
  const signal = options.signal
  throwIfAborted(signal)
  const settings = options.options ?? {}

  const requestedSource = settings.source ?? 'screen'
  if (requestedSource !== 'screen') {
    throw new Error(`captureFrames only supports source "screen" in this build (got ${JSON.stringify(requestedSource)})`)
  }

  const sourcesInfo = await listSources({ tools, signal })
  if (!sourcesInfo.screen) {
    throw new Error(`screen capture is not available on this machine: ${sourcesInfo.warnings.join('; ') || 'no capture engine'}`)
  }

  const workDir = options.workDir !== undefined
    ? (isAbsolute(options.workDir) ? options.workDir : resolvePath(options.workDir))
    : await makeWorkDir('media-senses-screen')
  await mkdir(workDir, { recursive: true })
  throwIfAborted(signal)

  const outputDir = options.outputDir !== undefined
    ? (isAbsolute(options.outputDir) ? options.outputDir : resolvePath(options.outputDir))
    : join(workDir, `screen-${nextTag()}`)
  await mkdir(outputDir, { recursive: true })

  const warnings = []
  let seconds = Number(settings.seconds ?? 0)
  if (!Number.isFinite(seconds) || seconds < 0) {
    warnings.push(`seconds ${JSON.stringify(settings.seconds)} is not a positive number; using 0 (one-shot capture)`)
    seconds = 0
  }
  if (seconds > MAX_CAPTURE_SECONDS) {
    warnings.push(`clip capture is bounded to ${MAX_CAPTURE_SECONDS}s; requested ${seconds}s`)
    seconds = MAX_CAPTURE_SECONDS
  }
  const fps = clamp(Number.isFinite(Number(settings.fps)) ? Number(settings.fps) : DEFAULT_FPS, 1, 60)
  const requestedWidth = Number.isFinite(Number(settings.width)) ? Math.round(Number(settings.width)) : DEFAULT_WIDTH
  const width = clamp(requestedWidth, MIN_CAPTURE_WIDTH, MAX_CAPTURE_WIDTH)
  if (width !== requestedWidth) {
    warnings.push(`capture width ${requestedWidth}px is outside the supported ${MIN_CAPTURE_WIDTH}..${MAX_CAPTURE_WIDTH}px range; using ${width}px`)
  }
  if (seconds > 0) {
    const maxSecondsByFrames = MAX_CAPTURE_FRAMES / fps
    if (seconds > maxSecondsByFrames) {
      warnings.push(
        `clip capture is bounded to ${MAX_CAPTURE_FRAMES} frames; ${seconds}s at ${fps} fps would be ` +
          `${Math.ceil(seconds * fps)} frames, recording ${round(maxSecondsByFrames, 2)}s instead`,
      )
      seconds = maxSecondsByFrames
    }
  }
  const region = parseRegion(settings.region)
  // Diagnostic/verification override: force one engine instead of the default
  // gdigrab -> ddagrab preference order (used by the tests to exercise ddagrab).
  const forcedEngine = typeof settings.engine === 'string' && settings.engine.trim().length > 0
    ? settings.engine.trim().toLowerCase()
    : undefined
  if (forcedEngine !== undefined && !sourcesInfo.engines.includes(forcedEngine)) {
    throw new Error(
      `requested capture engine "${settings.engine}" is not available on this machine ` +
        `(available: ${sourcesInfo.engines.join(', ') || 'none'})`,
    )
  }
  const candidateEngines = forcedEngine !== undefined ? [forcedEngine] : sourcesInfo.engines

  const attemptErrors = []
  for (const engine of candidateEngines) {
    throwIfAborted(signal)
    try {
      const captured = seconds > 0
        ? await captureClip({ tools, engine, width, fps, seconds, region, outputDir, workDir, signal })
        : await captureStill({ tools, engine, width, region, outputDir, workDir, signal })
      return {
        frames: captured.frames,
        width: captured.width,
        height: captured.height,
        elapsedMs: Date.now() - started,
        captureMs: captured.captureMs,
        engine,
        fps: seconds > 0 ? fps : 1,
        seconds: captured.seconds ?? seconds,
        region,
        outputDir,
        stats: captured.stats,
        platform: process.platform,
        source: 'screen',
        warnings: [...warnings, ...captured.warnings],
      }
    } catch (error) {
      if (signal?.aborted === true || error?.name === 'AbortError') throw abortError()
      const message = firstLine(error instanceof Error ? error.message : String(error))
      attemptErrors.push(`${engine}: ${message}`)
      warnings.push(`${engine} capture failed, trying the next engine: ${message}`)
    }
  }
  throw new Error(
    `screen capture failed on every available engine (${candidateEngines.join(', ')}):\n${attemptErrors.join('\n')}`,
  )
}

// ---------------------------------------------------------------------------
// Sheet composition (buildSheet)
// ---------------------------------------------------------------------------

/**
 * 3x5 bitmap font: digits 0-9 plus '.', which is enough to label a cell with an
 * index (1..400) or a seconds value such as "12.5". No font files, no drawtext.
 */
const BITMAP_FONT = Object.freeze({
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '.': ['000', '000', '000', '000', '010'],
})

/** 1-based index (or a caller-provided label) burned into a cell's top-left. */
function drawCellBadge(canvas, x, y, width, height, label) {
  const text = String(label).replace(/[^0-9.]/gu, '').slice(0, 5)
  if (text.length === 0) return
  // Badge strokes scale with the cell: the 3x5 font gets ~1/24th of the cell
  // height per stroke, never below 1 px.
  const scale = Math.max(1, Math.round(height / 24))
  const pad = 2
  const advance = 4 * scale
  const textWidth = text.length * advance - scale
  const textHeight = 5 * scale
  const badgeWidth = textWidth + 2 * pad
  const badgeHeight = textHeight + 2 * pad
  let badgeX = x + pad
  let badgeY = y + pad
  if (badgeX + badgeWidth > x + width) badgeX = Math.max(x, x + width - badgeWidth)
  if (badgeY + badgeHeight > y + height) badgeY = Math.max(y, y + height - badgeHeight)
  // Translucent dark plate so the light digits read on any frame content.
  canvas.rect(badgeX, badgeY, badgeWidth, badgeHeight, [8, 10, 16, 205])
  for (let character = 0; character < text.length; character += 1) {
    const glyph = BITMAP_FONT[text[character]]
    if (glyph === undefined) continue
    const glyphX = badgeX + pad + character * advance
    const glyphY = badgeY + pad
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (glyph[row][column] === '1') {
          canvas.rect(glyphX + column * scale, glyphY + row * scale, scale, scale, [242, 246, 255, 255])
        }
      }
    }
  }
}

/** 1px cell frame in a slightly lighter tone than the sheet background. */
function drawCellBorder(canvas, x, y, width, height, colour) {
  canvas.rect(x, y, width, 1, colour)
  canvas.rect(x, y + height - 1, width, 1, colour)
  canvas.rect(x, y, 1, height, colour)
  canvas.rect(x + width - 1, y, 1, height, colour)
}

/** Precompute source-pixel contributions for an area-average downscale. */
function areaContributions(sourceLength, targetLength) {
  const ratio = sourceLength / targetLength
  const contributions = new Array(targetLength)
  for (let target = 0; target < targetLength; target += 1) {
    const start = target * ratio
    const end = Math.min(sourceLength, (target + 1) * ratio)
    const first = Math.floor(start)
    const last = Math.min(sourceLength - 1, Math.ceil(end) - 1)
    const indices = []
    const weights = []
    let total = 0
    for (let source = first; source <= last; source += 1) {
      const overlap = Math.min(end, source + 1) - Math.max(start, source)
      if (overlap <= 0) continue
      indices.push(source)
      weights.push(overlap)
      total += overlap
    }
    if (indices.length === 0) {
      indices.push(clampInt(Math.round(start), 0, 0, sourceLength - 1))
      weights.push(1)
      total = 1
    }
    contributions[target] = { indices, weights, total }
  }
  return contributions
}

/** Copy an rgb24 frame into the canvas, scaling to dw x dh (area / bilinear). */
function blitScaled(canvas, frame, dx, dy, dw, dh) {
  const source = frame.rgb
  const sourceWidth = frame.width
  const sourceHeight = frame.height
  const target = canvas.data
  if (dw === sourceWidth && dh === sourceHeight) {
    for (let y = 0; y < dh; y += 1) {
      let sourceOffset = y * sourceWidth * 3
      let targetOffset = ((dy + y) * canvas.width + dx) * 4
      for (let x = 0; x < dw; x += 1) {
        target[targetOffset] = source[sourceOffset]
        target[targetOffset + 1] = source[sourceOffset + 1]
        target[targetOffset + 2] = source[sourceOffset + 2]
        target[targetOffset + 3] = 255
        sourceOffset += 3
        targetOffset += 4
      }
    }
    return
  }
  const downscale = sourceWidth > dw || sourceHeight > dh
  if (downscale) {
    const xContrib = areaContributions(sourceWidth, dw)
    const yContrib = areaContributions(sourceHeight, dh)
    for (let y = 0; y < dh; y += 1) {
      const yEntry = yContrib[y]
      for (let x = 0; x < dw; x += 1) {
        const xEntry = xContrib[x]
        let r = 0
        let g = 0
        let b = 0
        for (let yi = 0; yi < yEntry.indices.length; yi += 1) {
          const sourceRow = yEntry.indices[yi] * sourceWidth * 3
          const yWeight = yEntry.weights[yi]
          for (let xi = 0; xi < xEntry.indices.length; xi += 1) {
            const weight = yWeight * xEntry.weights[xi]
            const offset = sourceRow + xEntry.indices[xi] * 3
            r += source[offset] * weight
            g += source[offset + 1] * weight
            b += source[offset + 2] * weight
          }
        }
        const normaliser = yEntry.total * xEntry.total
        const targetOffset = ((dy + y) * canvas.width + dx + x) * 4
        target[targetOffset] = Math.round(r / normaliser)
        target[targetOffset + 1] = Math.round(g / normaliser)
        target[targetOffset + 2] = Math.round(b / normaliser)
        target[targetOffset + 3] = 255
      }
    }
    return
  }
  // Upscale: bilinear sampling keeps the synthetic/mismatched test frames smooth.
  const xRatio = sourceWidth / dw
  const yRatio = sourceHeight / dh
  for (let y = 0; y < dh; y += 1) {
    const sy = (y + 0.5) * yRatio - 0.5
    const y0 = clamp(Math.floor(sy), 0, sourceHeight - 1)
    const y1 = Math.min(sourceHeight - 1, y0 + 1)
    const fy = clamp(sy - y0, 0, 1)
    for (let x = 0; x < dw; x += 1) {
      const sx = (x + 0.5) * xRatio - 0.5
      const x0 = clamp(Math.floor(sx), 0, sourceWidth - 1)
      const x1 = Math.min(sourceWidth - 1, x0 + 1)
      const fx = clamp(sx - x0, 0, 1)
      const topLeft = (y0 * sourceWidth + x0) * 3
      const topRight = (y0 * sourceWidth + x1) * 3
      const bottomLeft = (y1 * sourceWidth + x0) * 3
      const bottomRight = (y1 * sourceWidth + x1) * 3
      const targetOffset = ((dy + y) * canvas.width + dx + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const top = source[topLeft + channel] * (1 - fx) + source[topRight + channel] * fx
        const bottom = source[bottomLeft + channel] * (1 - fx) + source[bottomRight + channel] * fx
        target[targetOffset + channel] = Math.round(top * (1 - fy) + bottom * fy)
      }
      target[targetOffset + 3] = 255
    }
  }
}

/** A frame is addressable either in memory (rgb + dimensions) or by image path. */
function isInMemoryFrame(frame) {
  return frame !== null && typeof frame === 'object' && (frame.rgb instanceof Uint8Array) && Number.isFinite(frame.width) && Number.isFinite(frame.height)
}

async function resolveSheetFrames(rawFrames, tools, warnings) {
  const resolved = []
  for (let index = 0; index < rawFrames.length; index += 1) {
    const frame = rawFrames[index]
    if (isInMemoryFrame(frame)) {
      const width = Math.round(Number(frame.width))
      const height = Math.round(Number(frame.height))
      if (width < 1 || height < 1) throw new Error(`frames[${index}] has invalid dimensions ${frame.width}x${frame.height}`)
      const rgb = Buffer.isBuffer(frame.rgb)
        ? frame.rgb
        : Buffer.from(frame.rgb.buffer, frame.rgb.byteOffset, frame.rgb.byteLength)
      if (rgb.length < width * height * 3) {
        throw new Error(`frames[${index}].rgb has ${rgb.length} bytes, expected ${width * height * 3} for ${width}x${height}`)
      }
      resolved.push({ rgb, width, height, label: frame.label, time: frame.time, path: frame.path })
      continue
    }
    if (frame === null || typeof frame !== 'object' || typeof frame.path !== 'string' || frame.path.length === 0) {
      throw new Error(
        `frames[${index}] must be { rgb, width, height } or { path } pointing at an image ` +
          `(got ${frame === null ? 'null' : typeof frame})`,
      )
    }
    const file = isAbsolute(frame.path) ? frame.path : resolvePath(frame.path)
    let dimensions = await pngDimensions(file)
    if (dimensions === undefined) {
      const probe = await run(
        tools.ffprobe,
        ['-hide_banner', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', file],
        { timeoutMs: 60_000 },
      )
      const match = probe.code === 0 ? /(\d+)\s*x\s*(\d+)/u.exec(probe.stdout) : null
      if (match === null) throw new Error(`cannot read the dimensions of frames[${index}] "${file}":\n${tailLines(probe.stderr, 4)}`)
      dimensions = { width: Number(match[1]), height: Number(match[2]) }
    }
    const rgb = await decodeImageToRgb(tools, file, dimensions)
    resolved.push({ rgb, width: dimensions.width, height: dimensions.height, label: frame.label, time: frame.time, path: file })
    if (Number.isFinite(frame.width) && Number.isFinite(frame.height) && (frame.width !== dimensions.width || frame.height !== dimensions.height)) {
      warnings.push(`frames[${index}] declared ${frame.width}x${frame.height} but "${file}" is ${dimensions.width}x${dimensions.height}; using the decoded size`)
    }
  }
  return resolved
}

/**
 * Compose several frames into ONE token-aligned PNG sheet.
 *
 * Each frame is scaled (aspect preserved) into its grid cell; a 2 px gap, a 1 px
 * cell border and a translucent badge with the frame's 1-based index (or its
 * `label`, e.g. a seconds value) are burned in with the built-in 3x5 font. Cells
 * are returned in row-major order so the caller can map cell -> timestamp.
 *
 * The canvas width is aligned DOWN to a multiple of 42 px (the host's token
 * cell), so an accidental 800 becomes 798 and the sheet does not pay for a
 * padded column. Pass `planSheet()` dimensions to avoid the rounding warning.
 *
 * @param {{frames?: Array<{rgb?: Uint8Array, width?: number, height?: number, path?: string,
 *                          label?: string, time?: number}>,
 *          width?: number, height?: number, columns?: number, gap?: number,
 *          background?: number[], quality?: string, outputPath?: string,
 *          tools?: object}} [options]
 * @returns {Promise<{pngPath: string, buffer: Buffer, width: number, height: number,
 *                    columns: number, rows: number, cellWidth: number, cellHeight: number,
 *                    tokenEstimate: number, frameCount: number, cells: object[],
 *                    warnings: string[], elapsedMs: number}>}
 */
export async function buildSheet(options = {}) {
  const started = Date.now()
  const rawFrames = options.frames
  if (!Array.isArray(rawFrames) || rawFrames.length === 0) {
    throw new Error('buildSheet needs at least one frame; got 0 frames (captureFrames returned nothing, or `frames` was not an array)')
  }
  const warnings = []
  const needsDecode = rawFrames.some((frame) => !isInMemoryFrame(frame))
  const tools = options.tools ?? (needsDecode ? await resolveTools() : undefined)
  const frames = await resolveSheetFrames(rawFrames, tools, warnings)
  const frameCount = frames.length
  const gap = normaliseGap(options.gap)
  const background = normaliseColour(options.background)

  let columns = Number(options.columns)
  if (!Number.isFinite(columns) || columns < 1) columns = Math.min(frameCount, Math.max(1, Math.ceil(Math.sqrt(frameCount))))
  columns = clamp(Math.round(columns), 1, frameCount)
  const rows = Math.ceil(frameCount / columns)

  const providedWidth = Number(options.width)
  const providedHeight = Number(options.height)
  const hasWidth = Number.isFinite(providedWidth) && providedWidth > 0
  const hasHeight = Number.isFinite(providedHeight) && providedHeight > 0
  if (hasWidth !== hasHeight) {
    throw new Error('buildSheet needs both width and height (or neither, to derive both from planSheet)')
  }
  let requestedWidth
  let requestedHeight
  if (hasWidth) {
    requestedWidth = Math.round(providedWidth)
    requestedHeight = Math.round(providedHeight)
  } else {
    const plan = planSheet({
      frameCount,
      sourceWidth: frames[0].width,
      sourceHeight: frames[0].height,
      quality: options.quality,
      gap,
    })
    requestedWidth = plan.canvasWidth
    requestedHeight = plan.canvasHeight
  }
  if (requestedHeight < 1) throw new Error(`buildSheet needs a positive height (got ${requestedHeight})`)
  const canvasWidth = Math.max(TOKEN_CELL, Math.floor(requestedWidth / TOKEN_CELL) * TOKEN_CELL)
  if (canvasWidth !== requestedWidth) {
    warnings.push(
      `canvas width ${requestedWidth}px is not a multiple of ${TOKEN_CELL}px; aligned down to ${canvasWidth}px ` +
        'so the host does not bill a padded column (use planSheet() for aligned geometry)',
    )
  }
  const canvasHeight = requestedHeight

  const cellWidth = Math.floor((canvasWidth - (columns + 1) * gap) / columns)
  const cellHeight = Math.floor((canvasHeight - (rows + 1) * gap) / rows)
  if (cellWidth < 2 || cellHeight < 2) {
    throw new Error(
      `buildSheet: a ${canvasWidth}x${canvasHeight} canvas cannot hold ${columns}x${rows} cells with a ${gap}px gap ` +
        `(cell ${cellWidth}x${cellHeight}); capture smaller frames, fewer frames, or plan a larger sheet`,
    )
  }
  const gridWidth = columns * cellWidth + (columns + 1) * gap
  const gridHeight = rows * cellHeight + (rows + 1) * gap
  const offsetX = Math.floor((canvasWidth - gridWidth) / 2)
  const offsetY = Math.floor((canvasHeight - gridHeight) / 2)
  const canvas = new Canvas(canvasWidth, canvasHeight, [...background, 255])
  const borderColour = [...background.map((channel) => Math.min(255, channel + 48)), 255]

  const cells = []
  for (let index = 0; index < frameCount; index += 1) {
    const frame = frames[index]
    const column = index % columns
    const rowIndex = Math.floor(index / columns)
    const boxX = offsetX + gap + column * (cellWidth + gap)
    const boxY = offsetY + gap + rowIndex * (cellHeight + gap)
    const fit = Math.min(cellWidth / frame.width, cellHeight / frame.height)
    const drawWidth = Math.max(1, Math.min(cellWidth, Math.round(frame.width * fit)))
    const drawHeight = Math.max(1, Math.min(cellHeight, Math.round(frame.height * fit)))
    const drawX = boxX + Math.floor((cellWidth - drawWidth) / 2)
    const drawY = boxY + Math.floor((cellHeight - drawHeight) / 2)
    blitScaled(canvas, frame, drawX, drawY, drawWidth, drawHeight)
    drawCellBorder(canvas, drawX, drawY, drawWidth, drawHeight, borderColour)
    const defaultLabel = String(index + 1)
    const badgeText = frame.label !== undefined ? String(frame.label) : defaultLabel
    drawCellBadge(canvas, drawX, drawY, drawWidth, drawHeight, badgeText)
    const cell = {
      index: index + 1,
      row: rowIndex,
      column,
      x: drawX,
      y: drawY,
      width: drawWidth,
      height: drawHeight,
      label: badgeText.replace(/[^0-9.]/gu, '').slice(0, 5) || defaultLabel,
    }
    if (Number.isFinite(frame.time)) cell.time = frame.time
    if (typeof frame.path === 'string') cell.path = frame.path
    cells.push(cell)
  }

  const buffer = canvas.toPng()
  const outputPath = options.outputPath !== undefined
    ? (isAbsolute(options.outputPath) ? options.outputPath : resolvePath(options.outputPath))
    : join(tmpdir(), 'media-senses', 'sheets', `sheet-${nextTag()}.png`)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, buffer)

  const firstFrameUniform = frames.length > 0 && isUniformRgb(frames[0].rgb)
  if (firstFrameUniform) {
    warnings.push('the first frame in this sheet is uniformly one colour; the source capture may be locked/empty')
  }

  return {
    pngPath: outputPath,
    buffer,
    width: canvasWidth,
    height: canvasHeight,
    columns,
    rows,
    cellWidth,
    cellHeight,
    tokenEstimate: tokenEstimateFor(canvasWidth, canvasHeight),
    frameCount,
    cells,
    warnings,
    elapsedMs: Date.now() - started,
  }
}
