/**
 * Change-driven frame selection for media-senses.
 *
 * THE IDEA IS ADAPTED FROM `dsh-see-now` (https://github.com/SAOS-3624/dsh-see-now,
 * Apache-2.0): that project watches a screen by scoring every frame's *change*
 * against the previous one on a 64x36 HSV grid (0-255), then keeps only the
 * frames that changed enough to be worth looking at. This module lifts that
 * idea into the video pipeline:
 *
 *   scoreVideo(file)    -> one cheap 64x36 RGB decode pass -> per-frame change score
 *   scoreSequence(paths)-> same scoring for a captured PNG/JPEG frame sequence
 *   selectFrames(scores)-> spike (cut) + integration + fallback frame selection
 *
 * The upstream constants (64x36 grid, spike/integration/fallback rules, the
 * `4 x fps x 3 s` integration budget) are kept; the HSV weighting below is
 * documented and deliberately favours hue/saturation over brightness because
 * screen/UI/slide changes are usually layout-and-colour changes, not luma ones.
 *
 * ## Change score (0-255)
 *
 * Each frame is decoded at `gridWidth x gridHeight` (default 64x36) as rgb24.
 * For every grid cell the RGB triple is converted to HSV-ish (h in degrees,
 * s in [0,1], v in [0,1]). The score between two consecutive frames is the
 * weighted mean absolute difference over all cells, scaled to 0-255:
 *
 *   cellDiff = ( wH * dH + wS * dS + wV * dV ) / ( wH + wS + wV )
 *   score    = 255 * mean(cellDiff)
 *
 * with the defaults
 *
 *   wH (hue)        = 1.0    hue is the strongest signal for content changes
 *   wS (saturation) = 0.8    palette shifts / colour-coded UI states
 *   wV (value)      = 0.35   brightness alone is noisy (fades, vignettes)
 *
 * Normalisation details:
 *  - dH is the CIRCULAR hue distance: min(|h1-h2|, 360-|h1-h2|) / 180, so a
 *    350° -> 10° shift is 20°, not 340°, and a full 180° flip reaches 1.0.
 *  - hue is MEANINGLESS on greys, so the hue term takes part only when both
 *    cells have saturation >= 0.12; otherwise the denominator drops wH and the
 *    cell difference rests on S/V alone.
 *  - a maximal change of every cell (opposite saturated hues) therefore lands
 *    at 255; a full black->white flip lands at ~78 (S/V only), still far above
 *    the cut threshold of 12.
 *
 * The per-pair score is stored on the LATER frame (`frames[0].score = 0`, it has
 * no predecessor). The score loop runs directly over the raw Buffer offsets
 * with reusable typed arrays, no per-pixel object allocation (~0.2 ms/frame).
 *
 * ## Frame selection
 *
 *  - Cut (spike): `score >= cutAbs(12) && score > cutRatio(2.5) * max(1, prev, next)
 *    && time - lastCut >= minGapSec(0.4)`. The `max(1, ...)` floor keeps quiet
 *    low-motion content from producing spikes.
 *  - Integration: scores are accumulated; when the accumulator reaches
 *    `integratePoints(4) * fps * integrateWindowSec(3)` a frame is emitted and the
 *    accumulator resets. Slow pans / scrolling pages never spike but do add up.
 *  - Fallback: one frame per `fallbackSec(20)` boundary while the gap since the
 *    last selection is that large, so a completely static video still yields a
 *    frame (at t = start).
 *  - The result is capped at `maxFrames(24)` keeping cuts over integrated over
 *    fallback; when over the cap the OLDEST integrated frames are dropped.
 *    Times are returned ascending and deduplicated (at least one frame apart).
 *
 * ## One decode pass, Windows-safe
 *
 * `scoreVideo` runs ONE ffmpeg pass
 *   `-vf fps=<fps>,scale=64:36,format=rgb24 -f rawvideo <relative>.rgb`
 * with `cwd = workDir` and a RELATIVE output name. Absolute paths appear only
 * in ordinary `-i` arguments; no drive-letter colon ever enters a filtergraph.
 * `scoreSequence` does the same over an image sequence (image2 pattern when the
 * file names form one, otherwise a concat-demuxer list written inside workDir).
 *
 * ## Honest degradation
 *
 * Only unusable input throws a clear error (missing/unreadable file, no video
 * stream, undeterminable duration, a decode that yields zero frames). A very
 * short or completely static clip returns warnings instead of throwing. An
 * aborted `signal` rejects promptly with an AbortError.
 *
 * @module lib/change
 */
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { probe, run, tailLines } from './ffmpeg.js'

/* ------------------------------------------------------------------ *
 * Public constants (also the exact defaults reported to the model)
 * ------------------------------------------------------------------ */

/**
 * Per-cell difference weights. Hue is compared circularly and skipped on grey
 * cells; see the module docs for the derivation and normalisation.
 * Scores are normalised so a maximal change lands near 255.
 */
export const CHANGE_WEIGHTS = Object.freeze({
  /** Hue weight (circular distance / 180). */
  hue: 1.0,
  /** Saturation weight. */
  saturation: 0.8,
  /** Value (brightness) weight. */
  value: 0.35,
})

/** Cells below this saturation get no hue term (hue is meaningless on greys). */
export const HUE_SATURATION_FLOOR = 0.12

/** Score ceiling: a weighted difference of 1.0 maps to 255. */
export const SCORE_MAX = 255

/** Defaults for `scoreVideo` / `scoreSequence`. */
export const DEFAULT_SCORE_OPTIONS = Object.freeze({
  fps: 12,
  gridWidth: 64,
  gridHeight: 36,
  start: 0,
  maxFrames: 3600,
})

/** Defaults for `selectFrames` (the upstream constants). */
export const DEFAULT_SELECTION_OPTIONS = Object.freeze({
  fps: 12,
  cutAbs: 12,
  cutRatio: 2.5,
  minGapSec: 0.4,
  integratePoints: 4,
  integrateWindowSec: 3,
  maxFrames: 24,
  fallbackSec: 20,
})

const DEG_PER_RAD = 180 / Math.PI
const RAD_PER_DEG = Math.PI / 180
/** Selection reasons, higher = kept first when the cap is hit. */
const REASON_PRIORITY = Object.freeze({ cut: 3, integrated: 2, fallback: 1 })

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** An Error that satisfies `name === 'AbortError'` (matches Node conventions). */
function abortError() {
  const error = new Error('change analysis aborted')
  error.name = 'AbortError'
  return error
}

/** Throw an AbortError when the caller has already aborted. */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError()
}

/** First non-empty line of a stderr blob (for compact warnings). */
function firstLine(text) {
  const line = String(text ?? '')
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  return line ?? ''
}

/** Round to `digits`, mapping non-finite values to 0 (JSON must stay finite). */
function roundTo(value, digits) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const round1 = (value) => roundTo(value, 1)
const round2 = (value) => roundTo(value, 2)
const round3 = (value) => roundTo(value, 3)

/** Parse an optional numeric option, clamping to [min, max]; bad input -> fallback. */
function numberOption(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Normalise the `scoreVideo` options into concrete numbers. */
function normaliseScoreOptions(options) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const fps = round3(numberOption(source.fps, DEFAULT_SCORE_OPTIONS.fps, 0.1, 120))
  const gridWidth = Math.round(numberOption(source.gridWidth, DEFAULT_SCORE_OPTIONS.gridWidth, 4, 256))
  const gridHeight = Math.round(numberOption(source.gridHeight, DEFAULT_SCORE_OPTIONS.gridHeight, 4, 256))
  const start = numberOption(source.start, DEFAULT_SCORE_OPTIONS.start, 0, 24 * 3600)
  const maxFrames = Math.round(numberOption(source.maxFrames, DEFAULT_SCORE_OPTIONS.maxFrames, 2, 1_000_000))
  let duration
  if (source.duration !== undefined && source.duration !== null && source.duration !== '') {
    const value = Number(source.duration)
    if (Number.isFinite(value) && value > 0) duration = value
  }
  return { fps, gridWidth, gridHeight, start, duration, maxFrames }
}

/**
 * Durations for timecode warnings and for the effective-fps budget.
 */
function parseDuration(metadata) {
  const format = metadata?.format ?? {}
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
  const candidates = [format.duration, video?.duration]
  for (const candidate of candidates) {
    const value = Number.parseFloat(String(candidate ?? ''))
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

/* ------------------------------------------------------------------ *
 * The scoring core (shared by scoreVideo and scoreSequence)
 * ------------------------------------------------------------------ */

/**
 * Convert one rgb24 frame into per-cell hue/saturation/value typed arrays and
 * return the frame's mean HSV (hue is a saturation-weighted circular mean over
 * the saturated cells only).
 *
 * Allocation-free in the pixel loop: reads straight from the Buffer offsets.
 *
 * @param {Buffer} buffer      raw rgb24 frames
 * @param {number} frameOffset byte offset of this frame
 * @param {number} cellCount   gridWidth * gridHeight
 * @param {Float32Array} hue   out: hue degrees per cell
 * @param {Float32Array} saturation out: saturation per cell
 * @param {Float32Array} value out: value per cell
 * @returns {{h: number, s: number, v: number}}
 */
function convertFrameToHsv(buffer, frameOffset, cellCount, hue, saturation, value) {
  let saturationSum = 0
  let valueSum = 0
  let hueSinSum = 0
  let hueCosSum = 0
  let hueWeight = 0
  for (let cell = 0; cell < cellCount; cell += 1) {
    const offset = frameOffset + cell * 3
    const r = buffer[offset]
    const g = buffer[offset + 1]
    const b = buffer[offset + 2]
    let max = r
    if (g > max) max = g
    if (b > max) max = b
    let min = r
    if (g < min) min = g
    if (b < min) min = b
    const delta = max - min
    const cellValue = max / 255
    const cellSaturation = max === 0 ? 0 : delta / max
    let cellHue = 0
    if (delta !== 0) {
      if (max === r) cellHue = ((g - b) / delta + (g < b ? 6 : 0)) * 60
      else if (max === g) cellHue = ((b - r) / delta + 2) * 60
      else cellHue = ((r - g) / delta + 4) * 60
    }
    hue[cell] = cellHue
    saturation[cell] = cellSaturation
    value[cell] = cellValue
    saturationSum += cellSaturation
    valueSum += cellValue
    if (cellSaturation >= HUE_SATURATION_FLOOR) {
      const radians = cellHue * RAD_PER_DEG
      // Saturation-weighted circular sum: the dominant colourful region wins.
      hueSinSum += Math.sin(radians) * cellSaturation
      hueCosSum += Math.cos(radians) * cellSaturation
      hueWeight += cellSaturation
    }
  }
  const meanHue = hueWeight > 0 ? ((Math.atan2(hueSinSum, hueCosSum) * DEG_PER_RAD) % 360 + 360) % 360 : 0
  return { h: meanHue, s: saturationSum / cellCount, v: valueSum / cellCount }
}

/** Round a frame HSV summary to JSON-friendly precision (hue wraps to [0,360)). */
function roundHsv(summary) {
  return { h: round1(summary.h) % 360, s: round3(summary.s), v: round3(summary.v) }
}

/**
 * Weighted HSV-ish difference between two converted frames, on the 0-255 scale.
 * The inner loop is allocation-free; the weights are constants of the module.
 */
function frameDifference(previous, current, cellCount) {
  const wH = CHANGE_WEIGHTS.hue
  const wS = CHANGE_WEIGHTS.saturation
  const wV = CHANGE_WEIGHTS.value
  const baseDenominator = wS + wV
  const hueDenominator = baseDenominator + wH
  const hue = previous.h
  const saturation = previous.s
  const value = previous.v
  const nextHue = current.h
  const nextSaturation = current.s
  const nextValue = current.v
  let total = 0
  for (let cell = 0; cell < cellCount; cell += 1) {
    const s1 = saturation[cell]
    const s2 = nextSaturation[cell]
    let numerator = wS * Math.abs(s1 - s2) + wV * Math.abs(value[cell] - nextValue[cell])
    let denominator = baseDenominator
    // Hue is meaningless on greys: only compare it where BOTH cells are colourful.
    if (s1 >= HUE_SATURATION_FLOOR && s2 >= HUE_SATURATION_FLOOR) {
      let hueDelta = Math.abs(hue[cell] - nextHue[cell])
      if (hueDelta > 180) hueDelta = 360 - hueDelta
      numerator += wH * (hueDelta / 180)
      denominator = hueDenominator
    }
    total += numerator / denominator
  }
  return (total / cellCount) * SCORE_MAX
}

/** Mean/p95/max over the actual frame-to-frame scores (frame 0 has none). */
function summariseScores(frames) {
  const count = frames.length - 1
  if (count <= 0) return { mean: 0, p95: 0, max: 0 }
  let sum = 0
  let max = 0
  const values = new Array(count)
  for (let index = 1; index < frames.length; index += 1) {
    const score = frames[index].score
    sum += score
    if (score > max) max = score
    values[index - 1] = score
  }
  values.sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(0.95 * count))
  const p95 = values[Math.min(count - 1, rank - 1)]
  return { mean: round1(sum / count), p95: round1(p95), max: round1(max) }
}

/**
 * Score a decoded raw rgb24 buffer frame by frame.
 *
 * Two reusable typed-array triples (previous/current) are swapped instead of
 * allocating per frame; the score loop touches only Buffer offsets.
 *
 * @param {{buffer: Buffer, count: number, gridWidth: number, gridHeight: number, start: number, fps: number, warnings: string[]}} options
 * @returns {{frames: Array<{index: number, time: number, score: number, hsv: {h: number, s: number, v: number}}>, mean: number, p95: number, max: number}}
 */
function scoreDecodedFrames({ buffer, count, gridWidth, gridHeight, start, fps, warnings }) {
  const cellCount = gridWidth * gridHeight
  const frameBytes = cellCount * 3
  const previousHue = new Float32Array(cellCount)
  const previousSaturation = new Float32Array(cellCount)
  const previousValue = new Float32Array(cellCount)
  const currentHue = new Float32Array(cellCount)
  const currentSaturation = new Float32Array(cellCount)
  const currentValue = new Float32Array(cellCount)

  const firstSummary = convertFrameToHsv(buffer, 0, cellCount, previousHue, previousSaturation, previousValue)
  const frames = new Array(count)
  frames[0] = {
    index: 0,
    time: round2(start),
    // Frame 0 has no predecessor: by definition nothing changed yet.
    score: 0,
    hsv: roundHsv(firstSummary),
  }

  let previous = { h: previousHue, s: previousSaturation, v: previousValue }
  let current = { h: currentHue, s: currentSaturation, v: currentValue }
  for (let index = 1; index < count; index += 1) {
    const summary = convertFrameToHsv(buffer, index * frameBytes, cellCount, current.h, current.s, current.v)
    const score = round1(frameDifference(previous, current, cellCount))
    frames[index] = { index, time: round2(start + index / fps), score, hsv: roundHsv(summary) }
    const swapHue = previous.h
    const swapSaturation = previous.s
    const swapValue = previous.v
    previous = current
    current = { h: swapHue, s: swapSaturation, v: swapValue }
  }

  const statistics = summariseScores(frames)
  if (count >= 2 && statistics.max === 0) {
    warnings.push('change: every decoded frame is identical (static input); the change score is 0 throughout')
  }
  return { frames, ...statistics }
}

/* ------------------------------------------------------------------ *
 * scoreVideo — one ffmpeg pass over a video file
 * ------------------------------------------------------------------ */

/**
 * Score every sampled frame of a video by its change against the previous one.
 *
 * ONE ffmpeg decode pass at a small raster; see the module docs. A single
 * ffprobe call is used first to bound the pass for long files (unless the
 * caller supplies `options.duration`), so a two-hour video is not decoded at
 * 12 fps.
 *
 * @param {object} options
 * @param {{ffmpeg: string, ffprobe?: string}} options.tools
 * @param {string} options.file absolute path to a video file
 * @param {string} options.workDir scratch directory (used as cwd); the caller owns it
 * @param {{fps?: number, gridWidth?: number, gridHeight?: number, start?: number, duration?: number, maxFrames?: number}} [options.options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{fps: number, frames: Array<{index: number, time: number, score: number, hsv: {h: number, s: number, v: number}}>, mean: number, p95: number, max: number, warnings: string[]}>}
 */
export async function scoreVideo({ tools, file, workDir, options = {}, signal } = {}) {
  if (tools === null || typeof tools !== 'object' || typeof tools.ffmpeg !== 'string' || tools.ffmpeg.length === 0) {
    throw new Error('change.scoreVideo: tools.ffmpeg is required (run resolveTools() from lib/ffmpeg.js first)')
  }
  if (typeof file !== 'string' || file.trim().length === 0) throw new Error('change.scoreVideo: file must be a non-empty path string')
  if (typeof workDir !== 'string' || workDir.trim().length === 0) throw new Error('change.scoreVideo: workDir must be a non-empty path string')
  throwIfAborted(signal)

  const warnings = []
  const normalised = normaliseScoreOptions(options)

  // 1. Clear error for a missing/unreadable input (before spawning ffmpeg).
  let info
  try {
    info = await stat(file)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`change.scoreVideo: cannot read input video "${file}": ${reason}`)
  }
  if (!info.isFile()) throw new Error(`change.scoreVideo: input is not a regular file: "${file}"`)
  throwIfAborted(signal)

  // 2. Duration: explicit option, else one cheap ffprobe (also proves a video stream exists).
  let duration = normalised.duration
  if (duration === undefined) {
    let metadata
    try {
      metadata = await probe(tools, file, { signal })
    } catch (error) {
      if (signal?.aborted === true) throw abortError()
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`change.scoreVideo: cannot read media metadata for "${file}": ${reason}`)
    }
    throwIfAborted(signal)
    const streams = Array.isArray(metadata?.streams) ? metadata.streams : []
    const videoStream = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
    if (videoStream === undefined) throw new Error(`change.scoreVideo: "${file}" has no video stream to analyse`)
    duration = parseDuration(metadata)
    if (!(duration > 0)) {
      throw new Error(`change.scoreVideo: cannot determine the duration of "${file}"; pass options.duration to analyse it`)
    }
  }

  // 3. Never decode more frames than maxFrames: reduce the sampling rate for long input.
  let fps = normalised.fps
  const frameBudgetFps = normalised.maxFrames / duration
  if (frameBudgetFps < fps) {
    fps = Math.max(0.1, Math.floor(frameBudgetFps * 1000) / 1000)
    warnings.push(
      `change: ${normalised.maxFrames} frames over ${round2(duration)} s only allows ${fps} fps; ` +
        `the sampling rate was reduced from ${normalised.fps} fps to stay within the frame budget`,
    )
  }

  // 4. ONE decode pass: raw rgb24 grids into a RELATIVE file name from cwd = workDir.
  const rawName = `change-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}.rgb`
  const seek = Math.max(0, normalised.start)
  const decodeArgs = ['-v', 'error', '-nostdin', '-y']
  if (seek > 0) decodeArgs.push('-ss', String(seek))
  decodeArgs.push('-i', file, '-an', '-sn')
  if (normalised.duration !== undefined) decodeArgs.push('-t', String(normalised.duration))
  decodeArgs.push(
    '-vf',
    `fps=${fps},scale=${normalised.gridWidth}:${normalised.gridHeight},format=rgb24`,
    '-f',
    'rawvideo',
    rawName,
  )
  const timeoutMs = Math.min(30 * 60 * 1000, Math.max(120_000, Math.ceil(duration * 2000)))
  const result = await run(tools.ffmpeg, decodeArgs, { cwd: workDir, timeoutMs, signal })
  if (signal?.aborted === true) throw abortError()

  const rawPath = join(workDir, rawName)
  let buffer
  try {
    buffer = await readFile(rawPath)
  } catch {
    buffer = Buffer.alloc(0)
  }
  await rm(rawPath, { force: true }).catch(() => {})

  const frameBytes = normalised.gridWidth * normalised.gridHeight * 3
  const count = Math.floor(buffer.length / frameBytes)
  if (count === 0) {
    if (result.code !== 0) {
      throw new Error(
        `change.scoreVideo: ffmpeg could not decode any frame from "${file}"` +
          `${result.killed === true ? ' (timed out or aborted)' : ''}:\n${tailLines(result.stderr, 8)}`,
      )
    }
    warnings.push('change: the decode pass produced no frames; the input has no decodable video frames')
    return { fps, frames: [], mean: 0, p95: 0, max: 0, warnings }
  }
  if (result.code !== 0) {
    warnings.push(`change: the decode pass ended early after ${count} frame(s) (${firstLine(result.stderr)}); the decoded part is used`)
  }
  if (count < 2) {
    warnings.push(`change: "${file}" is a very short clip (${count} frame at ${fps} fps); there is no frame-to-frame change to measure`)
  } else if (count / fps < 0.5) {
    warnings.push(`change: only ${count} frames were decoded at ${fps} fps (about ${round2(count / fps)} s); the change scores are coarse`)
  }
  throwIfAborted(signal)

  const scored = scoreDecodedFrames({
    buffer,
    count,
    gridWidth: normalised.gridWidth,
    gridHeight: normalised.gridHeight,
    start: seek,
    fps,
    warnings,
  })
  return { fps, ...scored, warnings }
}

/* ------------------------------------------------------------------ *
 * scoreSequence — the same scoring for a captured frame sequence
 * ------------------------------------------------------------------ */

/**
 * Score a captured image sequence (screen-capture output) exactly like a video.
 *
 * The caller passes ordered absolute PNG/JPEG paths. When the names follow a
 * single `%0Nd` numbering scheme (`frames/f0000.png`, `frames/f0001.png`, ...)
 * the pass feeds ffmpeg an image2 pattern; otherwise a concat-demuxer list is
 * written INSIDE workDir. Both inputs are ordinary `-i` arguments, so no path
 * ever enters a filtergraph.
 *
 * @param {object} options
 * @param {{ffmpeg: string}} options.tools
 * @param {string[]} options.frames ordered image paths (relative paths resolve against process.cwd())
 * @param {string} options.workDir scratch directory (used as cwd); the caller owns it
 * @param {number} [options.fps] sampling rate used to assign timestamps (default 12)
 * @param {number} [options.gridWidth]
 * @param {number} [options.gridHeight]
 * @param {number} [options.maxFrames] decode at most this many images (subsampled otherwise)
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{fps: number, frames: Array<{index: number, time: number, score: number, hsv: {h: number, s: number, v: number}}>, mean: number, p95: number, max: number, warnings: string[]}>}
 */
export async function scoreSequence({ tools, frames, workDir, fps, gridWidth, gridHeight, maxFrames, signal } = {}) {
  if (tools === null || typeof tools !== 'object' || typeof tools.ffmpeg !== 'string' || tools.ffmpeg.length === 0) {
    throw new Error('change.scoreSequence: tools.ffmpeg is required (run resolveTools() from lib/ffmpeg.js first)')
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('change.scoreSequence: frames must be a non-empty array of image paths')
  }
  if (frames.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error('change.scoreSequence: every entry in frames must be a non-empty path string')
  }
  if (typeof workDir !== 'string' || workDir.trim().length === 0) {
    throw new Error('change.scoreSequence: workDir must be a non-empty path string')
  }
  throwIfAborted(signal)

  const warnings = []
  const baseFps = round3(numberOption(fps, DEFAULT_SCORE_OPTIONS.fps, 0.1, 120))
  const width = Math.round(numberOption(gridWidth, DEFAULT_SCORE_OPTIONS.gridWidth, 4, 256))
  const height = Math.round(numberOption(gridHeight, DEFAULT_SCORE_OPTIONS.gridHeight, 4, 256))
  const budget = Math.round(numberOption(maxFrames, DEFAULT_SCORE_OPTIONS.maxFrames, 2, 1_000_000))

  const paths = frames.map((entry) => (isAbsolute(entry) ? entry : resolve(entry)))

  // 1. Clear error for a missing first/last image (middle files are reported by ffmpeg).
  for (const candidate of [paths[0], paths[paths.length - 1]]) {
    try {
      const info = await stat(candidate)
      if (!info.isFile()) throw new Error('not a regular file')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`change.scoreSequence: cannot read frame image "${candidate}": ${reason}`)
    }
  }
  throwIfAborted(signal)

  // 2. Respect the frame budget: keep every stride-th image and lower the effective fps.
  let selectedPaths = paths
  let effectiveFps = baseFps
  if (paths.length > budget) {
    const stride = Math.ceil(paths.length / budget)
    selectedPaths = paths.filter((_, index) => index % stride === 0)
    effectiveFps = round3(baseFps / stride)
    warnings.push(
      `change: ${paths.length} images exceed maxFrames=${budget}; every ${stride}th image was decoded ` +
        `(effective ${effectiveFps} fps)`,
    )
  }

  // 3. ONE decode pass: image2 pattern when the numbering allows it, else a concat list.
  const rawName = `change-seq-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}.rgb`
  const pattern = deriveSequencePattern(selectedPaths)
  const decodeArgs = ['-v', 'error', '-nostdin', '-y']
  let listName
  if (pattern !== undefined) {
    decodeArgs.push(
      '-framerate', String(effectiveFps),
      '-start_number', String(pattern.startNumber),
      '-i', pattern.pattern,
      '-frames:v', String(selectedPaths.length),
    )
  } else {
    listName = `change-seq-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.txt`
    const lines = ['ffconcat version 1.0']
    for (const path of selectedPaths) lines.push(`file '${escapeConcatPath(path)}'`)
    await writeFile(join(workDir, listName), `${lines.join('\n')}\n`, 'utf8')
    // The concat demuxer reads still images with a 1/25 s timebase, so a CFR
    // output would duplicate/drop frames and break the one-image-per-frame
    // mapping. Passthrough keeps exactly one decoded frame per listed image;
    // timestamps are recomputed from the frame index anyway.
    decodeArgs.push(
      '-f', 'concat', '-safe', '0', '-i', listName,
      '-frames:v', String(selectedPaths.length),
      '-fps_mode', 'passthrough',
    )
  }
  decodeArgs.push(
    '-vf',
    `scale=${width}:${height},format=rgb24`,
    '-f',
    'rawvideo',
    rawName,
  )
  const result = await run(tools.ffmpeg, decodeArgs, {
    cwd: workDir,
    timeoutMs: Math.min(30 * 60 * 1000, Math.max(120_000, selectedPaths.length * 250)),
    signal,
  })
  if (signal?.aborted === true) throw abortError()

  const rawPath = join(workDir, rawName)
  let buffer
  try {
    buffer = await readFile(rawPath)
  } catch {
    buffer = Buffer.alloc(0)
  }
  await rm(rawPath, { force: true }).catch(() => {})
  if (listName !== undefined) await rm(join(workDir, listName), { force: true }).catch(() => {})

  const frameBytes = width * height * 3
  const count = Math.floor(buffer.length / frameBytes)
  if (count === 0) {
    throw new Error(
      `change.scoreSequence: ffmpeg could not decode any image from the ${selectedPaths.length}-image sequence` +
        `${result.killed === true ? ' (timed out or aborted)' : ''}:\n${tailLines(result.stderr, 8)}`,
    )
  }
  if (result.code !== 0) {
    warnings.push(`change: the sequence decode pass ended early after ${count} image(s) (${firstLine(result.stderr)}); the decoded part is used`)
  }
  if (count !== selectedPaths.length) {
    warnings.push(`change: decoded ${count} of ${selectedPaths.length} images; the rest could not be read`)
  }
  if (count < 2) {
    warnings.push(`change: the sequence has only ${count} frame(s); there is no frame-to-frame change to measure`)
  }
  throwIfAborted(signal)

  const scored = scoreDecodedFrames({
    buffer,
    count,
    gridWidth: width,
    gridHeight: height,
    start: 0,
    fps: effectiveFps,
    warnings,
  })
  return { fps: effectiveFps, ...scored, warnings }
}

/**
 * Detect an image2-style `%0Nd` numbering scheme in an ordered path list.
 *
 * `[.../f0000.png, .../f0001.png]` -> `{ pattern: '.../f%04d.png', startNumber: 0 }`.
 * Returns undefined when the names are not a single consecutive numbering run,
 * in which case `scoreSequence` uses a concat-demuxer list instead.
 *
 * @param {readonly string[]} paths
 * @returns {{pattern: string, startNumber: number} | undefined}
 */
function deriveSequencePattern(paths) {
  if (paths.length === 0) return undefined
  const match = /^(.*?)(\d+)(\.[^./\\]+)$/u.exec(paths[0])
  if (match === null) return undefined
  const head = match[1]
  const digits = match[2]
  const extension = match[3]
  const width = digits.length
  const startNumber = Number.parseInt(digits, 10)
  if (!Number.isSafeInteger(startNumber)) return undefined
  for (let index = 0; index < paths.length; index += 1) {
    const expected = `${head}${String(startNumber + index).padStart(width, '0')}${extension}`
    if (paths[index] !== expected) return undefined
  }
  return { pattern: `${head}%0${width}d${extension}`, startNumber }
}

/** Quote a path for a concat-demuxer `file` directive (forward slashes, escaped quotes). */
function escapeConcatPath(path) {
  return path.replaceAll('\\', '/').replaceAll("'", "'\\''")
}

/* ------------------------------------------------------------------ *
 * selectFrames — spike + integration + fallback selection
 * ------------------------------------------------------------------ */

/** Normalise the `selectFrames` options into concrete numbers. */
function normaliseSelectionOptions(options, fps) {
  const source = options !== null && typeof options === 'object' ? options : {}
  return {
    fps,
    cutAbs: numberOption(source.cutAbs, DEFAULT_SELECTION_OPTIONS.cutAbs, 0.1, SCORE_MAX),
    cutRatio: numberOption(source.cutRatio, DEFAULT_SELECTION_OPTIONS.cutRatio, 1, 100),
    minGapSec: numberOption(source.minGapSec, DEFAULT_SELECTION_OPTIONS.minGapSec, 0, 600),
    integratePoints: numberOption(source.integratePoints, DEFAULT_SELECTION_OPTIONS.integratePoints, 0.1, 1_000_000),
    integrateWindowSec: numberOption(
      source.integrateWindowSec,
      DEFAULT_SELECTION_OPTIONS.integrateWindowSec,
      0.1,
      86_400,
    ),
    maxFrames: Math.round(numberOption(source.maxFrames, DEFAULT_SELECTION_OPTIONS.maxFrames, 1, 1_000_000)),
    fallbackSec: numberOption(source.fallbackSec, DEFAULT_SELECTION_OPTIONS.fallbackSec, 0.1, 86_400),
  }
}

/**
 * Accept either the `scoreVideo`/`scoreSequence` result object, an array of
 * frame objects, or a bare array of numbers (scores), and return a uniform
 * ascending `[{index, time, score}]` list.
 */
function normaliseScoreInput(scores, fps, warnings) {
  let rawFrames
  if (Array.isArray(scores)) rawFrames = scores
  else if (scores !== null && typeof scores === 'object' && Array.isArray(scores.frames)) rawFrames = scores.frames
  else {
    warnings.push('change.selectFrames: no frame scores were provided')
    return []
  }
  const frames = new Array(rawFrames.length)
  for (let position = 0; position < rawFrames.length; position += 1) {
    const entry = rawFrames[position]
    if (typeof entry === 'number') {
      const score = Number.isFinite(entry) ? Math.max(0, Math.min(SCORE_MAX, entry)) : 0
      frames[position] = { index: position, time: round2(position / fps), score: round1(score) }
      continue
    }
    if (entry !== null && typeof entry === 'object') {
      const index = Number.isInteger(entry.index) && entry.index >= 0 ? entry.index : position
      let time = Number(entry.time)
      if (!Number.isFinite(time) || time < 0) time = index / fps
      const score = Number(entry.score)
      frames[position] = {
        index,
        time: round2(time),
        score: round1(Number.isFinite(score) ? Math.max(0, Math.min(SCORE_MAX, score)) : 0),
      }
      continue
    }
    frames[position] = { index: position, time: round2(position / fps), score: 0 }
  }
  // Keep the input order but make times monotonic enough for gap/fallback logic.
  frames.sort((a, b) => a.time - b.time || a.index - b.index)
  return frames
}

/**
 * Select the frames worth keeping from a change-score series.
 *
 * @param {Array<{index?: number, time?: number, score: number}> | number[] | {fps: number, frames: Array}} scores
 *   the `scoreVideo`/`scoreSequence` result, its `frames` array, or plain scores
 * @param {{fps?: number, cutAbs?: number, cutRatio?: number, minGapSec?: number, integratePoints?: number, integrateWindowSec?: number, maxFrames?: number, fallbackSec?: number}} [options]
 * @returns {{selected: Array<{time: number, index: number, reason: 'cut' | 'integrated' | 'fallback', score: number}>, cuts: number[], warnings: string[]}}
 */
export function selectFrames(scores, options = {}) {
  const warnings = []
  const source = options !== null && typeof options === 'object' ? options : {}
  let inputFps
  if (source.fps === undefined && scores !== null && typeof scores === 'object' && !Array.isArray(scores)) {
    const value = Number(scores.fps)
    if (Number.isFinite(value) && value > 0) inputFps = value
  }
  const fps = round3(numberOption(source.fps, inputFps ?? DEFAULT_SELECTION_OPTIONS.fps, 0.1, 120))
  const normalised = normaliseSelectionOptions(source, fps)
  const frames = normaliseScoreInput(scores, fps, warnings)
  if (frames.length === 0) return { selected: [], cuts: [], warnings }
  if (frames.length < 2) {
    warnings.push('change.selectFrames: fewer than 2 scored frames; there is nothing to select from')
  }

  // --- Spike (cut) detector -------------------------------------------------
  const cuts = []
  let lastCutTime = Number.NEGATIVE_INFINITY
  for (let position = 1; position < frames.length; position += 1) {
    const frame = frames[position]
    if (frame.score < normalised.cutAbs) continue
    const previous = frames[position - 1].score
    const next = position + 1 < frames.length ? frames[position + 1].score : 0
    // max(1, ...) is the low-motion floor: in a nearly static clip any change
    // would otherwise be an infinite ratio spike.
    const localPeak = Math.max(1, previous, next)
    if (frame.score <= normalised.cutRatio * localPeak) continue
    if (frame.time - lastCutTime < normalised.minGapSec) continue
    cuts.push({ time: frame.time, index: frame.index, reason: 'cut', score: frame.score })
    lastCutTime = frame.time
  }

  // --- Integration detector -------------------------------------------------
  // Slow pans and scrolling pages never spike, but every frame adds a little
  // change; emit one frame per integrated window (upstream: 4 x fps x 3 s).
  const integrationThreshold = normalised.integratePoints * fps * normalised.integrateWindowSec
  const integrated = []
  let accumulator = 0
  for (let position = 1; position < frames.length; position += 1) {
    accumulator += frames[position].score
    if (accumulator < integrationThreshold) continue
    const frame = frames[position]
    integrated.push({ time: frame.time, index: frame.index, reason: 'integrated', score: frame.score })
    accumulator = 0
  }

  // --- Fallback detector ----------------------------------------------------
  // One frame per fallbackSec boundary, but only when the gap since the last
  // emitted frame is actually that large: a fully static clip yields one frame
  // at the start of the analysed window.
  const firstTime = frames[0].time
  const lastTime = frames[frames.length - 1].time
  const anchors = [...cuts, ...integrated].sort((a, b) => a.time - b.time)
  const fallback = []
  let lastEmitted = Number.NEGATIVE_INFINITY
  let anchorIndex = 0
  for (let boundary = 0; ; boundary += 1) {
    const time = round2(firstTime + boundary * normalised.fallbackSec)
    if (time > lastTime + 0.005) break
    while (anchorIndex < anchors.length && anchors[anchorIndex].time <= time + 1e-9) {
      lastEmitted = anchors[anchorIndex].time
      anchorIndex += 1
    }
    if (time - lastEmitted < normalised.fallbackSec - 0.005) continue
    const frameIndex = Math.max(0, Math.min(frames.length - 1, Math.round((time - firstTime) * fps)))
    fallback.push({ time, index: frames[frameIndex].index, reason: 'fallback', score: frames[frameIndex].score })
    lastEmitted = time
  }

  // --- Hard cap: cuts over integrated over fallback -------------------------
  const cap = normalised.maxFrames
  let keptCuts = cuts
  if (keptCuts.length > cap) {
    warnings.push(`change.selectFrames: ${keptCuts.length} cuts exceed maxFrames=${cap}; the ${cap} strongest were kept`)
    keptCuts = keptCuts
      .slice()
      .sort((a, b) => b.score - a.score || a.time - b.time)
      .slice(0, cap)
      .sort((a, b) => a.time - b.time)
  }
  let room = cap - keptCuts.length
  let keptIntegrated = integrated
  if (keptIntegrated.length > room) {
    const dropped = keptIntegrated.length - Math.max(0, room)
    warnings.push(`change.selectFrames: dropping the ${dropped} oldest integrated frame(s) to respect maxFrames=${cap}`)
    // Keep the newest integrated frames (the old ones are the stale ones).
    keptIntegrated = keptIntegrated
      .slice()
      .sort((a, b) => b.time - a.time)
      .slice(0, Math.max(0, room))
      .sort((a, b) => a.time - b.time)
  }
  room = cap - keptCuts.length - keptIntegrated.length
  let keptFallback = fallback
  if (keptFallback.length > room) {
    warnings.push(`change.selectFrames: ${keptFallback.length - room} fallback frame(s) dropped to respect maxFrames=${cap}`)
    keptFallback = keptFallback.slice(0, Math.max(0, room))
  }

  // --- Merge, sort, deduplicate --------------------------------------------
  const merged = [...keptCuts, ...keptIntegrated, ...keptFallback]
  merged.sort((a, b) => a.time - b.time || REASON_PRIORITY[b.reason] - REASON_PRIORITY[a.reason] || b.score - a.score)
  const selected = []
  for (const entry of merged) {
    const last = selected[selected.length - 1]
    // Two selections on the same sampled frame are one selection: keep the
    // stronger reason (cut > integrated > fallback). Frames at least one
    // sampling interval apart are distinct and both kept.
    if (last !== undefined && Math.round((entry.time - last.time) * fps) < 1) {
      const betterReason = REASON_PRIORITY[entry.reason] > REASON_PRIORITY[last.reason]
      const betterScore = REASON_PRIORITY[entry.reason] === REASON_PRIORITY[last.reason] && entry.score > last.score
      if (betterReason || betterScore) selected[selected.length - 1] = entry
      continue
    }
    selected.push(entry)
  }

  if (selected.length === 0) {
    warnings.push('change.selectFrames: no frame was selected')
  } else if (cuts.length === 0 && integrated.length === 0) {
    warnings.push(
      'change.selectFrames: no scene cut and no accumulated change were detected ' +
        '(static or near-static input); only fallback frames were selected',
    )
  }

  return {
    selected,
    cuts: selected.filter((entry) => entry.reason === 'cut').map((entry) => entry.time),
    warnings,
  }
}
