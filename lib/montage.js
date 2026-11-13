/**
 * Vision-target montages: filmstrips, reference-vs-replica comparisons and
 * metric diffing for media-senses.
 *
 * Why this module exists: a text-only model needs the numbers (the blind path);
 * a vision model should get **images first** plus a compact index. This module
 * renders the two images that carry the most information per token:
 *
 *   - `buildFilmstrip`  — first/middle/last (or any requested) frames of a built
 *     video, one labelled 16:9 cell per frame, packed into one PNG;
 *   - `buildComparePair` — the reference video next to the produced replica
 *     (stacked or side by side), so "does my replica look like the reference?"
 *     can be answered by looking instead of by reading metrics;
 *   - `diffMetrics` — the blind complement: per-metric ref/built/delta rows with
 *     honest match/close/diverge/unknown verdicts, so the model can say *what*
 *     differs without guessing.
 *
 * Token arithmetic is shared with `lib/screen.js` (`tokenEstimateFor`): the host
 * bills vision tokens on a 14 px patch grid padded to 42 px cells, roughly
 * `rows x (cols + 1) + 2`, so every canvas width here is a multiple of 42 px
 * (798 / 1260 / 1596) rather than 800 / 1280 / 1600, which would pay for a
 * wholly padded column. Canvas height is content-fitted to the cell grid so no
 * empty patch row is billed.
 *
 * Labels: `lib/png.js` is a plain RGBA canvas with no font files and no drawtext,
 * so this module carries its own tiny 3x5 bitmap font (uppercase A-Z, 0-9 and a
 * few separators). Chinese labels (the default, e.g. ['参考', '成片']) cannot be
 * rendered with those glyphs, so the *burned-in* label is an ASCII fallback
 * ("REF"/"BUILT", or "#1" for frames) while the real Chinese label is carried in
 * the returned `cells[].label` metadata for the report/renderer. That keeps the
 * image readable without CJK font files and keeps the wording in the text layer.
 *
 * Hard rules: ESM, zero runtime dependencies, every ffmpeg call runs with
 * `cwd = workDir` and uses a RELATIVE output name inside the filtergraph output
 * path; absolute paths only ever appear in `-i` arguments. Degradation is
 * explicit: a frame that cannot be decoded is dropped with a warning and the
 * kept cells are renumbered consistently; if every frame fails we throw a clear
 * error instead of returning a blank image.
 */
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { Canvas } from './png.js'
import { formatTimecode, makeWorkDir, probe, resolveTools, run, summariseProbe, tailLines } from './ffmpeg.js'
import { tokenEstimateFor } from './screen.js'

/** Gap between cells (and outer margin) in the montage canvas. */
export const MONTAGE_GAP = 4
/** Cells are always 16:9; frames are scaled to cover and centre-cropped. */
const CELL_ASPECT = 9 / 16
/** A filmstrip is a preview, not a video browser: cap the requested frames. */
const MAX_FILMSTRIP_FRAMES = 24
/** Default canvas width per quality tier (all multiples of 42 px). */
export const QUALITY_WIDTHS = Object.freeze({
  low: 798,
  balanced: 1260,
  standard: 1260,
  high: 1596,
})
const DEFAULT_GAP = MONTAGE_GAP
const BACKGROUND = Object.freeze([10, 11, 16])
const BORDER = Object.freeze([44, 48, 58])
const PLACEHOLDER = Object.freeze([24, 26, 34])

let rawCounter = 0

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function stamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-')
}

function nextRawName(prefix) {
  rawCounter += 1
  return `${prefix}-${stamp()}-${rawCounter}.rgb`
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return clamp(Math.round(number), min, max)
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function positiveNumberOrNull(value) {
  const number = finiteNumber(value)
  return number !== null && number > 0 ? number : null
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Align a canvas width DOWN to a 42 px host token cell (never below one cell). */
function alignWidth(width) {
  const rounded = Math.round(Number(width))
  if (!Number.isFinite(rounded) || rounded <= 0) return 42
  return Math.max(42, Math.floor(rounded / 42) * 42)
}

function toAbsolutePath(path) {
  return isAbsolute(path) ? path : resolvePath(path)
}

function defaultOutputPath(prefix) {
  return join(tmpdir(), 'media-senses', 'montage', `${prefix}-${stamp()}.png`)
}

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
}

/**
 * Resolve the scratch directory: create it when the caller omitted one (and
 * remember to clean it up), otherwise use the provided directory as cwd for
 * every ffmpeg call. Absolute paths are required inside `cwd`.
 */
async function resolveWorkDir(workDir) {
  if (workDir === undefined) {
    return { workDir: await makeWorkDir('media-senses-montage'), ownsWorkDir: true }
  }
  const absolute = toAbsolutePath(workDir)
  await mkdir(absolute, { recursive: true })
  return { workDir: absolute, ownsWorkDir: false }
}

// ---------------------------------------------------------------------------
// 3x5 bitmap font (no font files, no drawtext) + badge rendering
// ---------------------------------------------------------------------------

/** Uppercase-only 3x5 glyphs; enough for "#1 12.5S", "REF", "BUILT", "N/A". */
const FONT = Object.freeze({
  ' ': ['000', '000', '000', '000', '000'],
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
  A: ['010', '101', '111', '101', '101'],
  B: ['110', '101', '110', '101', '110'],
  C: ['011', '100', '100', '100', '011'],
  D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'],
  F: ['111', '100', '110', '100', '100'],
  G: ['011', '100', '101', '101', '011'],
  H: ['101', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'],
  J: ['001', '001', '001', '101', '010'],
  K: ['101', '101', '110', '101', '101'],
  L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'],
  N: ['101', '111', '111', '111', '101'],
  O: ['010', '101', '101', '101', '010'],
  P: ['110', '101', '110', '100', '100'],
  Q: ['010', '101', '101', '110', '011'],
  R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'],
  T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'],
  V: ['101', '101', '101', '101', '010'],
  W: ['101', '101', '111', '111', '101'],
  X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'],
  Z: ['111', '001', '010', '100', '111'],
  '.': ['000', '000', '000', '000', '010'],
  ':': ['000', '010', '000', '010', '000'],
  '#': ['101', '111', '101', '111', '101'],
  '-': ['000', '000', '111', '000', '000'],
  '/': ['001', '001', '010', '100', '100'],
  '%': ['101', '001', '010', '100', '101'],
})

/** Return an uppercase ASCII string renderable by FONT, or null. */
function renderableText(value, maxChars = 10) {
  if (typeof value !== 'string') return null
  const text = value.trim().toUpperCase()
  if (text.length === 0) return null
  for (const character of text) {
    if (!Object.hasOwn(FONT, character)) return null
  }
  return text.slice(0, maxChars)
}

/** Short timecode for burning into an image: "0.5S", "12.4S", "1:05". */
function shortTimecode(seconds) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  if (safe < 60) return `${safe.toFixed(1)}S`
  const totalSeconds = Math.round(safe)
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60)
    const rest = totalSeconds % 60
    return `${minutes}:${String(rest).padStart(2, '0')}`
  }
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const rest = totalSeconds % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function textWidth(text, scale) {
  if (text.length === 0) return 0
  return text.length * 4 * scale - scale
}

function drawBitmapText(canvas, x, y, text, scale, colour) {
  for (let index = 0; index < text.length; index += 1) {
    const glyph = FONT[text[index]]
    if (glyph === undefined) continue
    const glyphX = x + index * 4 * scale
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (glyph[row][column] === '1') {
          canvas.rect(glyphX + column * scale, y + row * scale, scale, scale, colour)
        }
      }
    }
  }
}

/**
 * Burn a label plate into the top-left corner of a cell.
 *
 * The plate is a translucent dark rectangle with light digits/letters, scaled to
 * roughly 1/36 of the cell height per font stroke (montage cells are much larger
 * than screen-capture thumbnails, so this stays unobtrusive rather than covering
 * a fifth of the frame). Unknown (e.g. Chinese) characters never reach here: the
 * caller supplies an ASCII fallback string.
 */
function drawLabelPlate(canvas, x, y, width, height, text) {
  const renderable = renderableText(text, 16)
  if (renderable === null) return
  const scale = clamp(Math.round(height / 36), 1, 12)
  const pad = 3
  const plateWidth = textWidth(renderable, scale) + 2 * pad
  const plateHeight = 5 * scale + 2 * pad
  let plateX = x + pad
  let plateY = y + pad
  if (plateX + plateWidth > x + width) plateX = Math.max(x, x + width - plateWidth)
  if (plateY + plateHeight > y + height) plateY = Math.max(y, y + height - plateHeight)
  canvas.rect(plateX, plateY, plateWidth, plateHeight, [6, 8, 12, 210])
  drawBitmapText(canvas, plateX + pad, plateY + pad, renderable, scale, [242, 246, 255, 255])
}

/** 1px cell border so adjacent dark frames stay visually separated. */
function drawCellBorder(canvas, x, y, width, height) {
  const colour = [...BORDER, 255]
  canvas.rect(x, y, width, 1, colour)
  canvas.rect(x, y + height - 1, width, 1, colour)
  canvas.rect(x, y, 1, height, colour)
  canvas.rect(x + width - 1, y, 1, height, colour)
}

// ---------------------------------------------------------------------------
// RGB blitting (frames are decoded at exactly the cell size; resample only when
// the layout had to shrink because requested frames were missing)
// ---------------------------------------------------------------------------

function blitExact(canvas, rgb, x, y, width, height) {
  const target = canvas.data
  for (let row = 0; row < height; row += 1) {
    let sourceOffset = row * width * 3
    let targetOffset = ((y + row) * canvas.width + x) * 4
    for (let column = 0; column < width; column += 1) {
      target[targetOffset] = rgb[sourceOffset]
      target[targetOffset + 1] = rgb[sourceOffset + 1]
      target[targetOffset + 2] = rgb[sourceOffset + 2]
      target[targetOffset + 3] = 255
      sourceOffset += 3
      targetOffset += 4
    }
  }
}

/** Bilinear resize into the canvas (used only for the rare renumbered layout). */
function blitResampled(canvas, rgb, sourceWidth, sourceHeight, x, y, width, height) {
  const xRatio = sourceWidth / width
  const yRatio = sourceHeight / height
  const target = canvas.data
  for (let row = 0; row < height; row += 1) {
    const sourceY = clamp((row + 0.5) * yRatio - 0.5, 0, sourceHeight - 1)
    const y0 = Math.floor(sourceY)
    const y1 = Math.min(sourceHeight - 1, y0 + 1)
    const fy = sourceY - y0
    for (let column = 0; column < width; column += 1) {
      const sourceX = clamp((column + 0.5) * xRatio - 0.5, 0, sourceWidth - 1)
      const x0 = Math.floor(sourceX)
      const x1 = Math.min(sourceWidth - 1, x0 + 1)
      const fx = sourceX - x0
      const topLeft = (y0 * sourceWidth + x0) * 3
      const topRight = (y0 * sourceWidth + x1) * 3
      const bottomLeft = (y1 * sourceWidth + x0) * 3
      const bottomRight = (y1 * sourceWidth + x1) * 3
      const targetOffset = ((y + row) * canvas.width + x + column) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const top = rgb[topLeft + channel] * (1 - fx) + rgb[topRight + channel] * fx
        const bottom = rgb[bottomLeft + channel] * (1 - fx) + rgb[bottomRight + channel] * fx
        target[targetOffset + channel] = Math.round(top * (1 - fy) + bottom * fy)
      }
      target[targetOffset + 3] = 255
    }
  }
}

// ---------------------------------------------------------------------------
// Probing and frame grabbing
// ---------------------------------------------------------------------------

/**
 * Probe a video or still image once: dimensions, duration, image/video kind.
 * The width/height are never used for scaling directly (cells are 16:9 cover
 * crops) but duration powers default timestamps and explicit-time clamping.
 */
async function probeMedia({ tools, file, signal }) {
  if (typeof file !== 'string' || file.trim().length === 0) throw new Error('a media file path is required')
  const absolute = toAbsolutePath(file.trim())
  let summary
  try {
    summary = summariseProbe(await probe(tools, absolute, { signal }))
  } catch (error) {
    throw new Error(`cannot read media "${absolute}": ${firstLine(error instanceof Error ? error.message : String(error))}`)
  }
  const stream = summary.video[0]
  if (stream === undefined || !(stream.width > 0) || !(stream.height > 0)) {
    throw new Error(`"${absolute}" has no usable video stream`)
  }
  const formatName = String(summary.formatName ?? '').toLowerCase()
  const isImage = /(?:^|,)image2(?:,|$)|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe/u.test(formatName)
    || (stream.frames === 1 && !(summary.duration > 0))
  const duration = positiveNumberOrNull(summary.duration) ?? positiveNumberOrNull(stream.duration) ?? 0
  return {
    file: absolute,
    isImage,
    width: stream.width,
    height: stream.height,
    duration,
    fps: stream.fps,
    formatName: summary.formatName,
  }
}

/**
 * Decode one frame at `time`, scaled to COVER targetWidth x targetHeight and
 * centre-cropped to exactly that size (so every cell is 16:9).
 *
 * Returns `{ rgb: null, error }` instead of throwing for a single missing frame:
 * the caller decides whether to skip it (filmstrip) or draw a placeholder
 * (compare pair). ffmpeg runs with `cwd = workDir` and writes a RELATIVE raw
 * file; the filter graph contains only numbers, never a Windows path.
 */
async function grabFrameRgb({ tools, media, time, targetWidth, targetHeight, workDir, signal }) {
  const rawName = nextRawName('montage-frame')
  const rawPath = join(workDir, rawName)
  const seconds = Math.max(0, Number.isFinite(time) ? time : 0)
  const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y']
  // A still image has one frame; seeking is only meaningful for videos.
  if (!media.isImage) args.push('-ss', String(round(seconds, 3)))
  args.push(
    '-i', media.file,
    '-frames:v', '1',
    '-an',
    '-vf', `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${targetWidth}:${targetHeight}`,
    '-pix_fmt', 'rgb24',
    '-f', 'rawvideo',
    rawName,
  )
  try {
    const result = await run(tools.ffmpeg, args, { cwd: workDir, timeoutMs: 60_000, signal })
    if (result.code !== 0) {
      return { rgb: null, error: firstLine(tailLines(result.stderr, 4)) || `ffmpeg exited with code ${result.code}` }
    }
    const buffer = await readFile(rawPath).catch(() => null)
    const expected = targetWidth * targetHeight * 3
    if (buffer === null || buffer.length < expected) {
      return {
        rgb: null,
        error: buffer === null || buffer.length === 0
          ? 'ffmpeg produced no frame at this timestamp'
          : `decoded ${buffer.length} of ${expected} expected bytes`,
      }
    }
    return { rgb: buffer.subarray(0, expected), error: null }
  } catch (error) {
    return { rgb: null, error: firstLine(error instanceof Error ? error.message : String(error)) }
  } finally {
    await rm(rawPath, { force: true }).catch(() => {})
  }
}

/** Requested timestamps: explicit `times`, else first / middle / last frame. */
function defaultTimes(media) {
  if (media.isImage || !(media.duration > 0)) return [0]
  const middle = round(media.duration / 2, 3)
  const last = round(Math.max(0, media.duration - 0.05), 3)
  return [0, middle, last]
}

function normaliseQuality(quality) {
  if (typeof quality !== 'string' || quality.trim().length === 0) return 'balanced'
  return quality.trim().toLowerCase()
}

function resolveCanvasWidth({ width, quality, warnings }) {
  const explicit = positiveNumberOrNull(width)
  let requested
  if (explicit !== null) {
    requested = explicit
  } else {
    const key = normaliseQuality(quality)
    requested = QUALITY_WIDTHS[key] ?? QUALITY_WIDTHS.balanced
    if (!Object.hasOwn(QUALITY_WIDTHS, key)) warnings.push(`unknown quality "${quality}"; using the balanced width ${requested}px`)
  }
  const canvasWidth = alignWidth(requested)
  if (canvasWidth !== Math.round(requested)) {
    warnings.push(
      `canvas width ${Math.round(requested)}px aligned to ${canvasWidth}px (multiple of 42px) so the host does not bill a padded column`,
    )
  }
  return canvasWidth
}

// ---------------------------------------------------------------------------
// buildFilmstrip
// ---------------------------------------------------------------------------

/**
 * @typedef {{index: number, time: number, timecode: string, label?: string,
 *            x: number, y: number, width: number, height: number}} MontageCell
 */

/**
 * Build a filmstrip: one 16:9 labelled cell per requested timestamp.
 *
 * Used for the first/middle/last preview of a built video (`vision` target).
 * Cells are packed `columns` per row (the last row may be short), separated by
 * 4 px dark gaps, with a burned-in index + short timecode badge. The canvas
 * width is a multiple of 42 px and `tokenEstimate` is the shared host formula.
 *
 * Missing frames: a timestamp that cannot be decoded is skipped with a warning
 * and the kept cells are renumbered 1..N in row-major order ("consistent
 * renumbering"). If every requested timestamp fails, this throws.
 *
 * Chinese `labels` cannot be burned in (the compositor has no CJK glyphs):
 * the badge shows an ASCII fallback (`#1`, or `labelPrefix`+index when the
 * prefix is ASCII) while `cells[].label` carries the original label text.
 *
 * @param {{tools?: object, file: string, times?: number[], workDir: string,
 *          outputPath?: string, width?: number, columns?: number,
 *          labels?: string[], labelPrefix?: string, quality?: string,
 *          gap?: number, signal?: AbortSignal}} options
 * @returns {Promise<{path: string, width: number, height: number, columns: number,
 *                    rows: number, cellWidth: number, cellHeight: number,
 *                    cells: MontageCell[], tokenEstimate: number,
 *                    frameCount: number, requestedFrameCount: number,
 *                    missingFrameCount: number, file: string, quality: string,
 *                    gap: number, warnings: string[], elapsedMs: number}>}
 */
export async function buildFilmstrip(options = {}) {
  const started = Date.now()
  const tools = options.tools ?? (await resolveTools())
  const warnings = []
  const { workDir, ownsWorkDir } = await resolveWorkDir(options.workDir)
  try {
    const media = await probeMedia({ tools, file: options.file, signal: options.signal })
    const gap = clampInt(options.gap, DEFAULT_GAP, 0, 32)
    const quality = normaliseQuality(options.quality)
    const canvasWidth = resolveCanvasWidth({ width: options.width, quality, warnings })
    const labels = Array.isArray(options.labels) ? options.labels : null
    const labelPrefix = typeof options.labelPrefix === 'string' ? options.labelPrefix : ''

    let requestedTimes = Array.isArray(options.times) && options.times.length > 0
      ? options.times
      : defaultTimes(media)
    if (requestedTimes.length > MAX_FILMSTRIP_FRAMES) {
      warnings.push(`filmstrip is capped at ${MAX_FILMSTRIP_FRAMES} frames; ${requestedTimes.length - MAX_FILMSTRIP_FRAMES} requested times were dropped`)
      requestedTimes = requestedTimes.slice(0, MAX_FILMSTRIP_FRAMES)
    }
    const requestedCount = requestedTimes.length
    const requestedColumns = clampInt(options.columns, Math.min(3, requestedCount), 1, Math.max(1, requestedCount))
    const provisional = filmstripGeometry({ columns: requestedColumns, canvasWidth, gap })

    // Grab frames at the provisional cell size. If too many are missing the
    // final layout can only get LARGER columns-wise, and the rare rescale is
    // handled at draw time.
    const kept = []
    for (let originalIndex = 0; originalIndex < requestedCount; originalIndex += 1) {
      const rawTime = requestedTimes[originalIndex]
      const time = finiteNumber(rawTime)
      if (time === null || time < 0) {
        warnings.push(`frame ${originalIndex + 1}: timestamp ${JSON.stringify(rawTime)} is not a valid non-negative number; skipped`)
        continue
      }
      const grabbed = await grabFrameRgb({
        tools,
        media,
        time,
        targetWidth: provisional.cellWidth,
        targetHeight: provisional.cellHeight,
        workDir,
        signal: options.signal,
      })
      if (grabbed.rgb === null) {
        warnings.push(`frame ${originalIndex + 1} at ${formatTimecode(time)} could not be decoded: ${grabbed.error}`)
        continue
      }
      const label = labels !== null && typeof labels[originalIndex] === 'string' && labels[originalIndex].length > 0
        ? labels[originalIndex]
        : undefined
      kept.push({ originalIndex, time, rgb: grabbed.rgb, label })
    }
    if (kept.length === 0) {
      throw new Error(
        `buildFilmstrip: no frames could be decoded from "${media.file}" at any requested timestamp ` +
          `(${requestedTimes.map((time) => JSON.stringify(time)).join(', ')})`,
      )
    }

    const columns = Math.min(requestedColumns, kept.length)
    const geometry = filmstripGeometry({ columns, canvasWidth, gap })
    const rows = Math.ceil(kept.length / columns)
    const canvasHeight = rows * geometry.cellHeight + (rows + 1) * gap
    const canvas = new Canvas(canvasWidth, canvasHeight, [...BACKGROUND, 255])

    const cells = []
    for (let order = 0; order < kept.length; order += 1) {
      const entry = kept[order]
      const column = order % columns
      const row = Math.floor(order / columns)
      const x = geometry.offsetX + gap + column * (geometry.cellWidth + gap)
      const y = gap + row * (geometry.cellHeight + gap)
      if (geometry.cellWidth === provisional.cellWidth && geometry.cellHeight === provisional.cellHeight) {
        blitExact(canvas, entry.rgb, x, y, geometry.cellWidth, geometry.cellHeight)
      } else {
        blitResampled(canvas, entry.rgb, provisional.cellWidth, provisional.cellHeight, x, y, geometry.cellWidth, geometry.cellHeight)
      }
      drawCellBorder(canvas, x, y, geometry.cellWidth, geometry.cellHeight)
      const index = order + 1
      const customLabel = renderableText(entry.label, 8)
      const prefix = renderableText(labelPrefix, 4)
      const primary = customLabel ?? (prefix !== null ? `${prefix}${index}` : `#${index}`)
      drawLabelPlate(canvas, x, y, geometry.cellWidth, geometry.cellHeight, `${primary} ${shortTimecode(entry.time)}`)
      const cell = {
        index,
        time: round(entry.time, 3),
        timecode: formatTimecode(entry.time),
        x,
        y,
        width: geometry.cellWidth,
        height: geometry.cellHeight,
      }
      if (entry.label !== undefined) cell.label = entry.label
      cells.push(cell)
    }

    const outputPath = options.outputPath !== undefined
      ? toAbsolutePath(options.outputPath)
      : defaultOutputPath('filmstrip')
    await mkdir(dirname(outputPath), { recursive: true })
    await canvas.save(outputPath)

    return {
      path: outputPath,
      width: canvasWidth,
      height: canvasHeight,
      columns,
      rows,
      cellWidth: geometry.cellWidth,
      cellHeight: geometry.cellHeight,
      cells,
      tokenEstimate: tokenEstimateFor(canvasWidth, canvasHeight),
      frameCount: cells.length,
      requestedFrameCount: requestedCount,
      missingFrameCount: requestedCount - cells.length,
      file: media.file,
      quality,
      gap,
      warnings,
      elapsedMs: Date.now() - started,
    }
  } finally {
    if (ownsWorkDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Cell geometry for a filmstrip; width is already 42 px aligned. */
function filmstripGeometry({ columns, canvasWidth, gap }) {
  const cellWidth = Math.max(2, Math.floor((canvasWidth - (columns + 1) * gap) / columns))
  const cellHeight = Math.max(2, Math.round(cellWidth * CELL_ASPECT))
  const gridWidth = columns * cellWidth + (columns + 1) * gap
  return {
    cellWidth,
    cellHeight,
    gridWidth,
    offsetX: Math.floor((canvasWidth - gridWidth) / 2),
  }
}

// ---------------------------------------------------------------------------
// buildComparePair
// ---------------------------------------------------------------------------

function compareGeometry({ mode, requestedWidth, gap }) {
  const canvasWidth = alignWidth(requestedWidth)
  if (mode === 'side') {
    const cellWidth = Math.floor((canvasWidth - 3 * gap) / 2)
    if (cellWidth < 2) throw new Error(`canvas width ${canvasWidth}px is too narrow for two side-by-side cells`)
    const cellHeight = Math.max(2, Math.round(cellWidth * CELL_ASPECT))
    const gridWidth = 2 * cellWidth + 3 * gap
    const canvasHeight = cellHeight + 2 * gap
    const offsetX = Math.floor((canvasWidth - gridWidth) / 2)
    return {
      canvasWidth,
      canvasHeight,
      cellWidth,
      cellHeight,
      positions: [
        { x: offsetX + gap, y: gap },
        { x: offsetX + gap + cellWidth + gap, y: gap },
      ],
    }
  }
  const cellWidth = Math.max(2, canvasWidth - 2 * gap)
  const cellHeight = Math.max(2, Math.round(cellWidth * CELL_ASPECT))
  const canvasHeight = 2 * cellHeight + 3 * gap
  return {
    canvasWidth,
    canvasHeight,
    cellWidth,
    cellHeight,
    positions: [
      { x: gap, y: gap },
      { x: gap, y: gap + cellHeight + gap },
    ],
  }
}

/**
 * Render the reference next to the replica, one 16:9 cell each, same size.
 *
 * `mode: 'stack'` puts them one above the other (wide, detailed — the default),
 * `mode: 'side'` puts them left/right (compact, cheaper: ~281 vs ~1056 tokens at
 * 1260 px). Labels are burned in with the ASCII fallback ("REF"/"BUILT" when the
 * caller's labels are Chinese) while `cells[].label` carries the real text.
 *
 * A missing frame degrades to a dark placeholder cell with a warning; if BOTH
 * frames are missing the function throws (a compare image of two placeholders
 * is worthless).
 *
 * @param {{tools?: object, refFile: string, builtFile: string, workDir: string,
 *          outputPath?: string, refTime?: number, builtTime?: number,
 *          width?: number, labels?: [string, string], mode?: 'stack'|'side',
 *          gap?: number, signal?: AbortSignal}} options
 * @returns {Promise<{path: string, width: number, height: number,
 *                    mode: 'stack'|'side', cellWidth: number, cellHeight: number,
 *                    cells: MontageCell[], tokenEstimate: number,
 *                    labels: string[], times: {ref: number, built: number},
 *                    refFile: string, builtFile: string,
 *                    warnings: string[], elapsedMs: number}>}
 */
export async function buildComparePair(options = {}) {
  const started = Date.now()
  const tools = options.tools ?? (await resolveTools())
  const warnings = []
  const { workDir, ownsWorkDir } = await resolveWorkDir(options.workDir)
  try {
    const mode = typeof options.mode === 'string' && options.mode.trim().length > 0 ? options.mode.trim().toLowerCase() : 'stack'
    if (mode !== 'stack' && mode !== 'side') {
      throw new Error(`buildComparePair: mode must be "stack" or "side" (got ${JSON.stringify(options.mode)})`)
    }
    const [refMedia, builtMedia] = await Promise.all([
      probeMedia({ tools, file: options.refFile, signal: options.signal }),
      probeMedia({ tools, file: options.builtFile, signal: options.signal }),
    ])
    const gap = clampInt(options.gap, DEFAULT_GAP, 0, 32)
    const canvasWidth = resolveCanvasWidth({ width: options.width, quality: 'balanced', warnings })
    const geometry = compareGeometry({ mode, requestedWidth: canvasWidth, gap })

    const refTime = resolveCompareTime(options.refTime, refMedia)
    const builtTime = resolveCompareTime(options.builtTime, builtMedia)
    const labels = normaliseCompareLabels(options.labels)

    const [refFrame, builtFrame] = await Promise.all([
      grabFrameRgb({
        tools,
        media: refMedia,
        time: refTime,
        targetWidth: geometry.cellWidth,
        targetHeight: geometry.cellHeight,
        workDir,
        signal: options.signal,
      }),
      grabFrameRgb({
        tools,
        media: builtMedia,
        time: builtTime,
        targetWidth: geometry.cellWidth,
        targetHeight: geometry.cellHeight,
        workDir,
        signal: options.signal,
      }),
    ])
    const missing = { ref: refFrame.rgb === null, built: builtFrame.rgb === null }
    if (missing.ref && missing.built) {
      throw new Error(
        `buildComparePair: neither reference (${formatTimecode(refTime)}) nor built (${formatTimecode(builtTime)}) frame could be decoded: ` +
          `ref=${refFrame.error}; built=${builtFrame.error}`,
      )
    }
    if (missing.ref) warnings.push(`reference frame at ${formatTimecode(refTime)} could not be decoded: ${refFrame.error}`)
    if (missing.built) warnings.push(`built frame at ${formatTimecode(builtTime)} could not be decoded: ${builtFrame.error}`)

    const canvas = new Canvas(geometry.canvasWidth, geometry.canvasHeight, [...BACKGROUND, 255])
    const entries = [
      { role: 'ref', frame: refFrame, time: refTime, label: labels[0], fallback: 'REF', position: geometry.positions[0] },
      { role: 'built', frame: builtFrame, time: builtTime, label: labels[1], fallback: 'BUILT', position: geometry.positions[1] },
    ]
    const cells = []
    for (const entry of entries) {
      const { x, y } = entry.position
      if (entry.frame.rgb !== null) {
        blitExact(canvas, entry.frame.rgb, x, y, geometry.cellWidth, geometry.cellHeight)
      } else {
        canvas.rect(x, y, geometry.cellWidth, geometry.cellHeight, [...PLACEHOLDER, 255])
      }
      drawCellBorder(canvas, x, y, geometry.cellWidth, geometry.cellHeight)
      const custom = renderableText(entry.label, 8)
      const burned = custom ?? entry.fallback
      drawLabelPlate(
        canvas,
        x,
        y,
        geometry.cellWidth,
        geometry.cellHeight,
        entry.frame.rgb === null ? `${burned} N/A` : `${burned} ${shortTimecode(entry.time)}`,
      )
      const cell = {
        index: cells.length + 1,
        role: entry.role,
        label: entry.label,
        time: round(entry.time, 3),
        timecode: formatTimecode(entry.time),
        x,
        y,
        width: geometry.cellWidth,
        height: geometry.cellHeight,
      }
      if (entry.frame.rgb === null) cell.missing = true
      cells.push(cell)
    }

    const outputPath = options.outputPath !== undefined
      ? toAbsolutePath(options.outputPath)
      : defaultOutputPath('compare')
    await mkdir(dirname(outputPath), { recursive: true })
    await canvas.save(outputPath)

    return {
      path: outputPath,
      width: geometry.canvasWidth,
      height: geometry.canvasHeight,
      mode,
      cellWidth: geometry.cellWidth,
      cellHeight: geometry.cellHeight,
      cells,
      tokenEstimate: tokenEstimateFor(geometry.canvasWidth, geometry.canvasHeight),
      labels,
      times: { ref: round(refTime, 3), built: round(builtTime, 3) },
      refFile: refMedia.file,
      builtFile: builtMedia.file,
      warnings,
      elapsedMs: Date.now() - started,
    }
  } finally {
    if (ownsWorkDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Default compare timestamps: middle of each video (or 0 for stills). */
function resolveCompareTime(value, media) {
  const explicit = finiteNumber(value)
  if (explicit !== null) return Math.max(0, explicit)
  if (media.isImage || !(media.duration > 0)) return 0
  return Math.round(media.duration / 2 * 1000) / 1000
}

/** Two labels; Chinese is preserved in metadata, ASCII fallback is burned. */
function normaliseCompareLabels(value) {
  const defaults = ['参考', '成片']
  if (!Array.isArray(value) || value.length < 2) return defaults
  return [0, 1].map((index) => (typeof value[index] === 'string' && value[index].trim().length > 0 ? value[index].trim() : defaults[index]))
}

// ---------------------------------------------------------------------------
// diffMetrics
//
// Thresholds (documented here and exported as DIFF_THRESHOLDS; the test suite
// asserts several of them):
//
//   duration       relative to ref (|Δ| / ref): ≤2% match, ≤10% close
//   shotCount      exact equal match; |Δ| ≤ max(1, 20% of ref) close
//   avgShotLength  relative to ref: ≤20% match, ≤50% close   (contract's example band)
//   cutRate        absolute cuts/minute: ≤0.5 match, ≤2.0 close
//   avgBrightness  absolute (0..1 scale): ≤0.05 match, ≤0.15 close
//   avgSaturation  absolute (0..1 scale): ≤0.05 match, ≤0.15 close
//   bpm            octave-tolerant relative: ≤3% match, ≤8% close
//   key            same name match; same tonic other mode close; else diverge
//   hardCutShare   absolute (0..1): ≤0.10 match, ≤0.25 close
//   beatSyncRatio  absolute (0..1): ≤0.10 match, ≤0.25 close
//   colourSignature same dominant hue + colorfulness Δ≤12 match; same hue Δ≤25
//                   close; different hue diverge
//
// Any metric whose ref OR built value is missing (null/undefined/NaN, e.g. no
// audio stream for bpm/key, no craft analysis for hardCutShare) is verdict
// 'unknown' — never 'match'. Overall verdict: 'close' when at least 70% of the
// comparable metrics match and none diverge; 'diverge' when diverge > match or
// over a third of comparable rows diverge; 'partly' otherwise. With no
// comparable rows at all the overall verdict is 'partly' (we cannot tell).
// ---------------------------------------------------------------------------

/** Documented diff thresholds; exported so callers/tests can quote them. */
export const DIFF_THRESHOLDS = Object.freeze({
  duration: Object.freeze({ match: 0.02, close: 0.10 }),
  shotCount: Object.freeze({ closeAbsolute: 1, closeRelative: 0.20 }),
  avgShotLength: Object.freeze({ match: 0.20, close: 0.50 }),
  cutRate: Object.freeze({ match: 0.5, close: 2.0 }),
  avgBrightness: Object.freeze({ match: 0.05, close: 0.15 }),
  avgSaturation: Object.freeze({ match: 0.05, close: 0.15 }),
  bpm: Object.freeze({ match: 0.03, close: 0.08 }),
  hardCutShare: Object.freeze({ match: 0.10, close: 0.25 }),
  beatSyncRatio: Object.freeze({ match: 0.10, close: 0.25 }),
  colourSignature: Object.freeze({ colorfulnessMatch: 12, colorfulnessClose: 25 }),
  beatToleranceSeconds: 0.15,
})

const METRIC_NAMES = Object.freeze([
  '时长',
  '镜头数',
  '平均镜头长',
  '切点率',
  '平均亮度',
  '平均彩度',
  'BPM',
  '调性',
  '硬切占比',
  '卡点率',
  '调色签名',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function meanOf(values) {
  const list = values.map((value) => finiteNumber(value)).filter((value) => value !== null)
  if (list.length === 0) return null
  return list.reduce((sum, value) => sum + value, 0) / list.length
}

/** Shared video metrics extracted defensively from a VideoAnalysis-shaped object. */
function extractVideoFacts(analysis) {
  const global = isPlainObject(analysis.global) ? analysis.global : {}
  const shots = Array.isArray(analysis.shots) ? analysis.shots : []
  const timeline = Array.isArray(analysis.timeline) ? analysis.timeline : []
  const audio = isPlainObject(analysis.audio) ? analysis.audio : null
  const tempo = audio !== null && isPlainObject(audio.tempo) ? audio.tempo : null
  const key = audio !== null && isPlainObject(audio.key) ? audio.key : null

  const duration = positiveNumberOrNull(analysis.duration)
  const shotCount = finiteNumber(global.shotCount) !== null
    ? Math.round(finiteNumber(global.shotCount))
    : (shots.length > 0 ? shots.length : null)

  let avgShotLength = null
  const shotDurations = shots.map((shot) => finiteNumber(shot?.duration)).filter((value) => value !== null && value > 0)
  if (shotDurations.length > 0) {
    avgShotLength = shotDurations.reduce((sum, value) => sum + value, 0) / shotDurations.length
  } else if (duration !== null && shotCount !== null && shotCount > 0) {
    avgShotLength = duration / shotCount
  }

  let cutRate = finiteNumber(global.cutRate)
  if (cutRate === null && duration !== null && shotCount !== null && shotCount > 0) {
    cutRate = Math.max(0, shotCount - 1) / (duration / 60)
  }

  let avgBrightness = finiteNumber(global.avgBrightness)
  if (avgBrightness === null) avgBrightness = meanOf(timeline.map((point) => point?.brightness))
  let avgSaturation = finiteNumber(global.avgSaturation)
  if (avgSaturation === null) avgSaturation = meanOf(timeline.map((point) => point?.saturation))

  const bpm = finiteNumber(tempo?.bpm)
  const keyName = typeof key?.name === 'string' && key.name.trim().length > 0
    ? key.name.trim()
    : (typeof key?.tonic === 'string' && key.tonic.trim().length > 0
      ? `${key.tonic.trim()}${typeof key?.mode === 'string' && key.mode.trim().length > 0 ? ` ${key.mode.trim()}` : ''}`
      : null)

  const hardCutCandidates = [
    analysis.craft?.cutRhythm?.hardCutShare,
    analysis.craft?.transitions?.hardCutShare,
    analysis.craft?.transitions?.hardCutRatio,
    global.hardCutShare,
    analysis.hardCutShare,
  ]
  let hardCutShare = null
  for (const candidate of hardCutCandidates) {
    const value = finiteNumber(candidate)
    if (value !== null) {
      hardCutShare = clamp(value, 0, 1)
      break
    }
  }

  // Beat-sync ratio: prefer a precomputed craft value (both the craft-engine's
  // `cutsOnBeatRatio` and a plain `ratio` are accepted), else derive it from the
  // beat grid and shot starts (share of shot starts within 150 ms of a beat).
  const precomputedBeatSync = [
    analysis.craft?.beatSync?.cutsOnBeatRatio,
    analysis.craft?.beatSync?.ratio,
    analysis.craft?.beatSync?.onBeatRatio,
    global.beatSyncRatio,
    analysis.beatSyncRatio,
  ]
  let beatSyncRatio = null
  for (const candidate of precomputedBeatSync) {
    const value = finiteNumber(candidate)
    if (value !== null) {
      beatSyncRatio = value
      break
    }
  }
  if (beatSyncRatio === null) {
    const beatTimes = Array.isArray(tempo?.beatTimes)
      ? tempo.beatTimes.map((value) => finiteNumber(value)).filter((value) => value !== null)
      : []
    const starts = shots.map((shot) => finiteNumber(shot?.start)).filter((value) => value !== null)
    if (beatTimes.length > 0 && starts.length > 0) {
      const tolerance = DIFF_THRESHOLDS.beatToleranceSeconds
      const onBeat = starts.filter((start) => beatTimes.some((beat) => Math.abs(start - beat) <= tolerance)).length
      beatSyncRatio = onBeat / starts.length
    }
  }
  if (beatSyncRatio !== null) beatSyncRatio = clamp(beatSyncRatio, 0, 1)

  // Colour signature: a craft grading signature (string or list of tags) wins,
  // else the dominant hue + colorfulness bucket. A craft grading signature from
  // lib/craft.js is an array of tags such as ['cool', 'high-contrast'].
  let colourSignature = null
  const craftSignature = analysis.craft?.grading?.signature
  if (typeof craftSignature === 'string' && craftSignature.trim().length > 0) {
    colourSignature = { kind: 'grading', label: craftSignature.trim().toLowerCase() }
  } else if (Array.isArray(craftSignature)) {
    const tags = craftSignature
      .filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
      .map((tag) => tag.trim().toLowerCase())
    if (tags.length > 0) colourSignature = { kind: 'grading', label: tags.join('|') }
  }
  if (colourSignature === null && Array.isArray(global.dominantHues)) {
    const hue = global.dominantHues.find((entry) => typeof entry?.name === 'string' && entry.name.trim().length > 0)
    if (hue !== undefined) {
      colourSignature = {
        kind: 'hue',
        label: hue.name.trim().toLowerCase(),
        hex: typeof hue.hex === 'string' ? hue.hex : null,
        colorfulness: finiteNumber(global.colorfulness),
      }
    }
  }

  return {
    duration,
    shotCount,
    avgShotLength,
    cutRate,
    avgBrightness,
    avgSaturation,
    bpm,
    keyName,
    hardCutShare,
    beatSyncRatio,
    colourSignature,
  }
}

function metricRow(metric, refValue, builtValue, delta, verdict) {
  const row = { metric, ref: refValue, built: builtValue }
  row.delta = verdict === 'unknown' ? null : (Number.isFinite(delta) ? round(delta, 4) : null)
  row.verdict = verdict
  return row
}

function relativeVerdict(refValue, builtValue, thresholds) {
  if (refValue === null || builtValue === null) return 'unknown'
  // Relative to the REFERENCE value: "the replica's average shot is 70% longer"
  // is 70%, not 41% (dividing by max would understate large increases).
  const denominator = Math.max(Math.abs(refValue), 1e-9)
  const difference = Math.abs(builtValue - refValue) / denominator
  if (difference <= thresholds.match) return 'match'
  if (difference <= thresholds.close) return 'close'
  return 'diverge'
}

function absoluteVerdict(refValue, builtValue, thresholds) {
  if (refValue === null || builtValue === null) return 'unknown'
  const difference = Math.abs(builtValue - refValue)
  if (difference <= thresholds.match) return 'match'
  if (difference <= thresholds.close) return 'close'
  return 'diverge'
}

function normaliseKeyName(name) {
  if (typeof name !== 'string') return null
  const match = /^([A-Ga-g][#b]?)\s*([A-Za-z]*)$/u.exec(name.trim())
  if (match === null) return { text: name.trim().toLowerCase(), tonic: null, mode: null }
  return { text: name.trim().toLowerCase(), tonic: match[1].toUpperCase(), mode: match[2].toLowerCase() }
}

function keyVerdict(refKey, builtKey) {
  if (refKey === null || builtKey === null) return 'unknown'
  const ref = normaliseKeyName(refKey)
  const built = normaliseKeyName(builtKey)
  if (ref.text === built.text) return 'match'
  if (ref.tonic !== null && ref.tonic === built.tonic) return 'close'
  return 'diverge'
}

/** Minimum relative tempo distance, octave-folded (120 vs 60 is a match). */
function bpmDistancePercent(refBpm, builtBpm) {
  const candidates = [builtBpm, builtBpm * 2, builtBpm / 2]
  return Math.min(...candidates.map((candidate) => Math.abs(candidate - refBpm) / refBpm))
}

function bpmVerdict(refBpm, builtBpm) {
  if (refBpm === null || builtBpm === null || refBpm <= 0 || builtBpm <= 0) return 'unknown'
  const distance = bpmDistancePercent(refBpm, builtBpm)
  if (distance <= DIFF_THRESHOLDS.bpm.match) return 'match'
  if (distance <= DIFF_THRESHOLDS.bpm.close) return 'close'
  return 'diverge'
}

function colourSignatureText(signature) {
  if (signature === null) return null
  if (signature.kind === 'grading') return signature.label
  const colorfulness = signature.colorfulness === null || signature.colorfulness === undefined
    ? null
    : Math.round(signature.colorfulness)
  return colorfulness === null ? signature.label : `${signature.label} (colorfulness ${colorfulness})`
}

function colourSignatureVerdict(refSignature, builtSignature) {
  if (refSignature === null || builtSignature === null) return 'unknown'
  if (refSignature.kind !== builtSignature.kind) return 'unknown'
  if (refSignature.kind === 'grading') return refSignature.label === builtSignature.label ? 'match' : 'diverge'
  if (refSignature.label !== builtSignature.label) return 'diverge'
  const refColorfulness = finiteNumber(refSignature.colorfulness)
  const builtColorfulness = finiteNumber(builtSignature.colorfulness)
  if (refColorfulness === null || builtColorfulness === null) return 'match'
  const difference = Math.abs(builtColorfulness - refColorfulness)
  const thresholds = DIFF_THRESHOLDS.colourSignature
  if (difference <= thresholds.colorfulnessMatch) return 'match'
  if (difference <= thresholds.colorfulnessClose) return 'close'
  return 'diverge'
}

/**
 * Compare two `analyzeVideo` results (or trimmed subsets of the same shape).
 *
 * Pure function: no I/O, never mutates its inputs. Always returns eleven rows in
 * the documented order so a report can be rendered in a stable layout; metrics
 * with missing data carry verdict 'unknown' (never 'match').
 *
 * @param {object} ref  an analyzeVideo result
 * @param {object} built  an analyzeVideo result of the produced replica
 * @returns {{rows: Array<{metric: string, ref: any, built: any, delta: number|null,
 *            verdict: 'match'|'close'|'diverge'|'unknown'}>,
 *           summary: {match: number, close: number, diverge: number, unknown: number, comparable: number},
 *           verdict: 'close'|'partly'|'diverge',
 *           thresholds: object}}
 */
export function diffMetrics(ref, built) {
  if (!isPlainObject(ref) || !isPlainObject(built)) {
    throw new TypeError('diffMetrics needs two analyzeVideo result objects')
  }
  const refFacts = extractVideoFacts(ref)
  const builtFacts = extractVideoFacts(built)

  const rows = []
  rows.push(metricRow(
    METRIC_NAMES[0],
    refFacts.duration,
    builtFacts.duration,
    refFacts.duration !== null && builtFacts.duration !== null ? builtFacts.duration - refFacts.duration : null,
    relativeVerdict(refFacts.duration, builtFacts.duration, DIFF_THRESHOLDS.duration),
  ))

  let shotCountVerdict = 'unknown'
  if (refFacts.shotCount !== null && builtFacts.shotCount !== null) {
    const difference = Math.abs(builtFacts.shotCount - refFacts.shotCount)
    const allowance = Math.max(
      DIFF_THRESHOLDS.shotCount.closeAbsolute,
      Math.ceil(refFacts.shotCount * DIFF_THRESHOLDS.shotCount.closeRelative),
    )
    shotCountVerdict = difference === 0 ? 'match' : difference <= allowance ? 'close' : 'diverge'
  }
  rows.push(metricRow(
    METRIC_NAMES[1],
    refFacts.shotCount,
    builtFacts.shotCount,
    refFacts.shotCount !== null && builtFacts.shotCount !== null ? builtFacts.shotCount - refFacts.shotCount : null,
    shotCountVerdict,
  ))

  rows.push(metricRow(
    METRIC_NAMES[2],
    refFacts.avgShotLength === null ? null : round(refFacts.avgShotLength, 3),
    builtFacts.avgShotLength === null ? null : round(builtFacts.avgShotLength, 3),
    refFacts.avgShotLength !== null && builtFacts.avgShotLength !== null ? builtFacts.avgShotLength - refFacts.avgShotLength : null,
    relativeVerdict(refFacts.avgShotLength, builtFacts.avgShotLength, DIFF_THRESHOLDS.avgShotLength),
  ))

  rows.push(metricRow(
    METRIC_NAMES[3],
    refFacts.cutRate === null ? null : round(refFacts.cutRate, 2),
    builtFacts.cutRate === null ? null : round(builtFacts.cutRate, 2),
    refFacts.cutRate !== null && builtFacts.cutRate !== null ? builtFacts.cutRate - refFacts.cutRate : null,
    absoluteVerdict(refFacts.cutRate, builtFacts.cutRate, DIFF_THRESHOLDS.cutRate),
  ))

  rows.push(metricRow(
    METRIC_NAMES[4],
    refFacts.avgBrightness === null ? null : round(refFacts.avgBrightness, 3),
    builtFacts.avgBrightness === null ? null : round(builtFacts.avgBrightness, 3),
    refFacts.avgBrightness !== null && builtFacts.avgBrightness !== null ? builtFacts.avgBrightness - refFacts.avgBrightness : null,
    absoluteVerdict(refFacts.avgBrightness, builtFacts.avgBrightness, DIFF_THRESHOLDS.avgBrightness),
  ))

  rows.push(metricRow(
    METRIC_NAMES[5],
    refFacts.avgSaturation === null ? null : round(refFacts.avgSaturation, 3),
    builtFacts.avgSaturation === null ? null : round(builtFacts.avgSaturation, 3),
    refFacts.avgSaturation !== null && builtFacts.avgSaturation !== null ? builtFacts.avgSaturation - refFacts.avgSaturation : null,
    absoluteVerdict(refFacts.avgSaturation, builtFacts.avgSaturation, DIFF_THRESHOLDS.avgSaturation),
  ))

  rows.push(metricRow(
    METRIC_NAMES[6],
    refFacts.bpm,
    builtFacts.bpm,
    refFacts.bpm !== null && builtFacts.bpm !== null ? builtFacts.bpm - refFacts.bpm : null,
    bpmVerdict(refFacts.bpm, builtFacts.bpm),
  ))

  rows.push(metricRow(
    METRIC_NAMES[7],
    refFacts.keyName,
    builtFacts.keyName,
    null,
    keyVerdict(refFacts.keyName, builtFacts.keyName),
  ))

  rows.push(metricRow(
    METRIC_NAMES[8],
    refFacts.hardCutShare === null ? null : round(refFacts.hardCutShare, 3),
    builtFacts.hardCutShare === null ? null : round(builtFacts.hardCutShare, 3),
    refFacts.hardCutShare !== null && builtFacts.hardCutShare !== null ? builtFacts.hardCutShare - refFacts.hardCutShare : null,
    absoluteVerdict(refFacts.hardCutShare, builtFacts.hardCutShare, DIFF_THRESHOLDS.hardCutShare),
  ))

  rows.push(metricRow(
    METRIC_NAMES[9],
    refFacts.beatSyncRatio === null ? null : round(refFacts.beatSyncRatio, 3),
    builtFacts.beatSyncRatio === null ? null : round(builtFacts.beatSyncRatio, 3),
    refFacts.beatSyncRatio !== null && builtFacts.beatSyncRatio !== null ? builtFacts.beatSyncRatio - refFacts.beatSyncRatio : null,
    absoluteVerdict(refFacts.beatSyncRatio, builtFacts.beatSyncRatio, DIFF_THRESHOLDS.beatSyncRatio),
  ))

  rows.push(metricRow(
    METRIC_NAMES[10],
    colourSignatureText(refFacts.colourSignature),
    colourSignatureText(builtFacts.colourSignature),
    null,
    colourSignatureVerdict(refFacts.colourSignature, builtFacts.colourSignature),
  ))

  const summary = { match: 0, close: 0, diverge: 0, unknown: 0, comparable: 0 }
  for (const row of rows) {
    summary[row.verdict] += 1
    if (row.verdict !== 'unknown') summary.comparable += 1
  }
  let verdict
  if (summary.comparable === 0) {
    verdict = 'partly'
  } else if (summary.diverge === 0 && summary.match >= Math.ceil(summary.comparable * 0.7)) {
    verdict = 'close'
  } else if (summary.diverge > summary.match || summary.diverge / summary.comparable > 0.35) {
    verdict = 'diverge'
  } else {
    verdict = 'partly'
  }

  return { rows, summary, verdict, thresholds: DIFF_THRESHOLDS }
}

export default {
  buildFilmstrip,
  buildComparePair,
  diffMetrics,
  tokenEstimateFor,
  QUALITY_WIDTHS,
  DIFF_THRESHOLDS,
  MONTAGE_GAP,
}
