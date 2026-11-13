/**
 * Production-craft analyzer for the media-senses plugin ("how was this made?").
 *
 * Input is a video that the v1 perception engine (`lib/video.js`) has already
 * described: shot boundaries, a 1 Hz brightness/saturation/motion timeline, the
 * stream facts and the reused `AudioAnalysis`. This module turns those facts plus
 * two cheap direct decodes into an executable recipe:
 *
 *   craft  — the measurable production technique (cut rhythm, transitions,
 *            camera motion per shot, colour grading, overlays, hook, beat sync,
 *            section roles, title card) in the exact `craft` shape of
 *            CONTRACT-V2.md module C.
 *   recipe — a `media-senses.recipe/v1` skeleton the model can hand to the
 *            video-building engine (`lib/build.js`) to reproduce the video, plus
 *            3–6 Chinese imperative reproduction notes written from the actual
 *            measurements (those notes are what the model learns from).
 *
 * Pipeline (two decodes for the whole file, never per shot):
 *
 *  1. ONE gray pass: `-vf fps=4,scale=80:45,format=gray -f rawvideo frames.gray`
 *     (relative output name, cwd = workDir). In JS: for every consecutive frame
 *     pair, search translations dx,dy ∈ [−6,6] that minimise SAD over the
 *     80×45 raster. Per shot the mean translation gives pan/tilt, the mean
 *     left-half vs right-half horizontal displacement gives zoom, sign flips /
 *     incoherent residual give handheld. The same pair differences (mean |Δ|)
 *     are the raw material for transition classification.
 *  2. ONE RGB pass: `-vf fps=<sampleFps>,scale=160:90,format=rgb24 -f rawvideo -`
 *     captured through a binary stdout pipe. ~30 frames for a minute of video
 *     (capped by `options.maxSamples`). From these frames: shadow/mid/highlight
 *     colour casts, saturation, contrast, signature tags, global palette, the
 *     top-12% / bottom-18% text bands and the title-card evidence.
 *
 * Everything degrades honestly: if a decode pass fails the affected metrics are
 * `null` plus a warning, never an exception. Only a missing input `analysis` or
 * unusable arguments throw.
 *
 * Windows filtergraph rule: the gray pass writes a RELATIVE file name from
 * `cwd = workDir`; the RGB pass writes to stdout (no path at all). Absolute paths
 * appear only in ordinary `-i` arguments. No `C:/...` ever enters a `-vf` graph.
 *
 * Conventions worth knowing when reading the measurements:
 *  - `dx` is the shift applied to the *next* frame to match the previous one:
 *    content drifting left (camera panning right) ⇒ dx < 0. Hence pan-right ⇔
 *    mean dx < 0. `dy` follows the same logic: camera tilting up ⇒ content moves
 *    down ⇒ dy > 0.
 *  - zoom-in shows up as opposite horizontal displacements on the two halves:
 *    left-half content moves left (dx < 0) while right-half content moves right
 *    (dx > 0) ⇒ rightDx − leftDx > 0. Integer search at an 80 px raster cannot
 *    resolve sub-pixel drift, so only fast zooms are detectable; slow Ken-Burns
 *    moves read as static and are documented as a limitation.
 *  - pan/tilt/handheld are camera *movements*; the reproduction notes use the
 *    same vocabulary as `RenderPlan.scenes[].motion` in lib/build.js.
 *
 * @module lib/craft
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { formatTimecode, makeWorkDir, probe, resolveTools, run, summariseProbe } from './ffmpeg.js'

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Recipe schema tag fixed by CONTRACT-V2. */
export const RECIPE_SCHEMA = 'media-senses.recipe/v1'

const GRAY_WIDTH = 80
const GRAY_HEIGHT = 45
const GRAY_FPS = 4
const GRAY_FRAME_BYTES = GRAY_WIDTH * GRAY_HEIGHT
const GRAY_FRAME_SECONDS = 1 / GRAY_FPS

const RGB_WIDTH = 160
const RGB_HEIGHT = 90
const RGB_FRAME_BYTES = RGB_WIDTH * RGB_HEIGHT * 3
/** ~30 frames for a one-minute clip; the pass is throttled for long inputs. */
const DEFAULT_SAMPLE_FPS = 0.5

const DEFAULT_MAX_SAMPLES = 240
/** Translation search radius in pixels on the 80×45 raster. */
const SEARCH_RADIUS = 6
/** Pixels this close to the border are never sampled (keeps every offset valid). */
const SEARCH_MARGIN = 6
const SEARCH_X0 = SEARCH_MARGIN
const SEARCH_X1 = GRAY_WIDTH - SEARCH_MARGIN
const SEARCH_Y0 = SEARCH_MARGIN
const SEARCH_Y1 = GRAY_HEIGHT - SEARCH_MARGIN
/** Hard cap on decoded frame pairs used for camera motion (long inputs are sampled). */
const MAX_CAMERA_PAIRS = 1500
/** Frame pairs closer than this (s) to a shot edge are ignored for camera motion. */
const PAIR_BOUNDARY_GUARD = 0.35

/** Mean |dx|,|dy| below this (px/pair) is "static". */
const STATIC_THRESHOLD = 0.3
/** Mean signed displacement needed for a definite pan/tilt. */
const DIRECTION_THRESHOLD = 0.5
/** Mean (rightDx − leftDx) needed for a definite zoom. */
const ZOOM_THRESHOLD = 1.0

/** A cut within this many ms of a beat counts as "on beat". */
const BEAT_TOLERANCE_MS = 120

/** Bands used for text detection, as fractions of the frame height. */
const TOP_BAND_SHARE = 0.12
const BOTTOM_BAND_SHARE = 0.18
const CENTRE_BAND_START = 0.30
const CENTRE_BAND_END = 0.70

/* ------------------------------------------------------------------ *
 * Small numeric / formatting helpers
 * ------------------------------------------------------------------ */

/** Round to `digits`; non-finite input becomes `null` (honest "not measured"). */
function roundTo(value, digits) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const round2 = (value) => roundTo(value, 2)
const round3 = (value) => roundTo(value, 3)
const round1 = (value) => roundTo(value, 1)

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Population standard deviation (documented choice: the shots are the population). */
function stddev(values) {
  const average = mean(values)
  if (average === null) return null
  let sum = 0
  for (const value of values) sum += (value - average) ** 2
  return Math.sqrt(sum / values.length)
}

/** Parse a metadata-ish value into a finite number, else null. */
function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function errorMessage(error) {
  if (error instanceof Error) return error.message.split(/\r?\n/u)[0]
  return String(error)
}

function firstLine(text) {
  if (typeof text !== 'string') return ''
  const line = text.split(/\r?\n/u).map((part) => part.trim()).find((part) => part.length > 0)
  return line ?? ''
}

function abortError() {
  const error = new Error('media-senses: craft analysis aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError()
}

function isAbort(error, signal) {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

/** Format measured seconds for Chinese reproduction notes. */
function describeSeconds(value) {
  const seconds = Number.isFinite(value) ? value : 0
  return `${round2(seconds)} 秒`
}

/* ------------------------------------------------------------------ *
 * Binary capture (raw RGB frames go to stdout, never through a file)
 * ------------------------------------------------------------------ */

/**
 * Run a binary and collect stdout as raw bytes. Used for the RGB sampling pass:
 * piping the frames avoids writing a large temporary file and keeps the filter
 * graph free of any path. Mirrors the pattern in lib/frame.js.
 */
function runBuffer(binary, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      binary,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 300_000,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        windowsHide: true,
        encoding: 'buffer',
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code === 'string' && error.code === 'ENOENT') {
          reject(new Error(`cannot execute ${binary}: ${error.message}`))
          return
        }
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolvePromise({
          code,
          killed: error !== null && error.killed === true,
          stdout: stdout ?? Buffer.alloc(0),
          stderr: (stderr ?? Buffer.alloc(0)).toString('utf8'),
        })
      },
    )
  })
}

/* ------------------------------------------------------------------ *
 * Input normalisation (the v1 VideoAnalysis shape is taken as given)
 * ------------------------------------------------------------------ */

function normaliseOptions(options) {
  const value = options !== null && typeof options === 'object' ? options : {}
  return {
    lowResFrames: value.lowResFrames !== false,
    maxSamples: Math.round(clamp(parseNumber(value.maxSamples) ?? DEFAULT_MAX_SAMPLES, 1, 2000)),
  }
}

function normalisePalette(raw) {
  if (!Array.isArray(raw)) return []
  const palette = []
  for (const entry of raw.slice(0, 4)) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.hex !== 'string' || !/^#[0-9a-fA-F]{6}$/u.test(entry.hex)) continue
    palette.push({ hex: entry.hex.toLowerCase(), share: round3(clamp(parseNumber(entry.share) ?? 0, 0, 1)) })
  }
  return palette
}

function normaliseIntervals(raw) {
  if (!Array.isArray(raw)) return []
  const intervals = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const start = parseNumber(entry.start)
    const end = parseNumber(entry.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    intervals.push({ start: round2(start), end: round2(end) })
  }
  return intervals
}

/**
 * Copy the pieces of the v1 report craft analysis needs into a defensive shape.
 * Bad entries are dropped (with warnings) so a partially broken report still
 * yields a measurable craft result instead of throwing.
 */
function normaliseAnalysis(analysis, warnings) {
  if (analysis === null || typeof analysis !== 'object') {
    throw new Error('analyzeCraft: analysis (the v1 analyzeVideo result) is required')
  }
  const rawShots = Array.isArray(analysis.shots) ? analysis.shots : []
  const shots = []
  for (const raw of rawShots) {
    if (raw === null || typeof raw !== 'object') continue
    const start = parseNumber(raw.start)
    const end = parseNumber(raw.end)
    const durationRead = parseNumber(raw.duration)
    const duration = Number.isFinite(durationRead) && durationRead > 0
      ? durationRead
      : Number.isFinite(start) && Number.isFinite(end)
        ? end - start
        : null
    if (!Number.isFinite(start) || !(duration > 0)) continue
    shots.push({
      start: round2(Math.max(0, start)),
      end: round2(Math.max(0, start) + duration),
      duration: round2(duration),
      brightness: round3(clamp(parseNumber(raw.brightness) ?? 0, 0, 1)),
      saturation: round3(clamp(parseNumber(raw.saturation) ?? 0, 0, 1)),
      motion: round1(parseNumber(raw.motion) ?? 0),
      hueName: typeof raw.hueName === 'string' ? raw.hueName : null,
      layout: typeof raw.layout === 'string' ? raw.layout : null,
      palette: normalisePalette(raw.palette),
    })
  }
  shots.sort((a, b) => a.start - b.start)
  // They should be contiguous; drop duplicates/degenerate overlaps only.
  const cleanShots = []
  for (const shot of shots) {
    const previous = cleanShots[cleanShots.length - 1]
    if (previous !== undefined && shot.start < previous.end - 0.05) continue
    cleanShots.push(shot)
  }
  if (rawShots.length > 0 && cleanShots.length === 0) {
    warnings.push('craft: every shot in the supplied analysis was unusable; shot-dependent fields are null')
  }

  const durationRead = parseNumber(analysis.duration)
  const duration = Number.isFinite(durationRead) && durationRead > 0
    ? round2(durationRead)
    : cleanShots.length > 0
      ? round2(cleanShots[cleanShots.length - 1].end)
      : 0

  const timeline = []
  if (Array.isArray(analysis.timeline)) {
    for (const point of analysis.timeline) {
      if (point === null || typeof point !== 'object') continue
      const t = parseNumber(point.t)
      const brightness = parseNumber(point.brightness)
      const saturation = parseNumber(point.saturation)
      const motion = parseNumber(point.motion)
      if (!Number.isFinite(t)) continue
      timeline.push({
        t: round2(t),
        brightness: round3(clamp(brightness ?? 0, 0, 1)),
        saturation: round3(clamp(saturation ?? 0, 0, 1)),
        motion: round1(Math.max(0, motion ?? 0)),
      })
    }
    timeline.sort((a, b) => a.t - b.t)
  }

  const streamRead = analysis.stream !== null && typeof analysis.stream === 'object' ? analysis.stream : {}
  const stream = {
    codec: typeof streamRead.codec === 'string' ? streamRead.codec : 'unknown',
    width: Math.round(parseNumber(streamRead.width) ?? 0),
    height: Math.round(parseNumber(streamRead.height) ?? 0),
    fps: round2(parseNumber(streamRead.fps) ?? 0),
    rotation: Math.round(parseNumber(streamRead.rotation) ?? 0),
  }
  const globalRead = analysis.global !== null && typeof analysis.global === 'object' ? analysis.global : {}
  const flagsRead = analysis.flags !== null && typeof analysis.flags === 'object' ? analysis.flags : {}
  const audio = analysis.audio !== null && typeof analysis.audio === 'object' ? analysis.audio : null
  const transcript = analysis.transcript !== null && typeof analysis.transcript === 'object'
    ? typeof analysis.transcript.text === 'string'
      ? { text: analysis.transcript.text }
      : null
    : null

  return {
    shots: cleanShots,
    timeline,
    stream,
    duration,
    audio,
    transcript,
    flags: {
      black: normaliseIntervals(flagsRead.black),
    },
    aspect: typeof globalRead.aspectRatio === 'string' ? globalRead.aspectRatio : null,
    dominantHues: Array.isArray(globalRead.dominantHues)
      ? globalRead.dominantHues
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.hex === 'string')
        .map((entry) => ({ hex: entry.hex.toLowerCase(), share: round3(clamp(parseNumber(entry.share) ?? 0, 0, 1)) }))
      : [],
  }
}

/* ------------------------------------------------------------------ *
 * Stage 1 — one gray decode pass for camera motion + transitions
 * ------------------------------------------------------------------ */

/**
 * Decode the whole file at fps=4/80×45/gray into `frames.gray` (relative name,
 * cwd = workDir), then expose per-frame mean luma and raw pixel views.
 */
async function decodeGrayFrames({ tools, file, workDir, signal, warnings }) {
  const rawName = 'craft-frames.gray'
  try {
    const result = await run(
      tools.ffmpeg,
      ['-v', 'error', '-nostdin', '-y', '-i', file, '-an', '-vf', `fps=${GRAY_FPS},scale=${GRAY_WIDTH}:${GRAY_HEIGHT},format=gray`, '-f', 'rawvideo', rawName],
      { cwd: workDir, timeoutMs: 30 * 60 * 1000, signal },
    )
    let buffer = Buffer.alloc(0)
    try {
      buffer = await readFile(join(workDir, rawName))
    } catch {
      buffer = Buffer.alloc(0)
    }
    const count = Math.floor(buffer.length / GRAY_FRAME_BYTES)
    if (count === 0) {
      warnings.push(
        `craft: the low-resolution gray pass produced no frames${result.code !== 0 ? ` (${firstLine(result.stderr)})` : ''}; ` +
          'camera motion and visual transition classification fall back to the analysis timeline',
      )
      return { ok: false, frames: [], frameSeconds: GRAY_FRAME_SECONDS }
    }
    if (result.code !== 0) {
      warnings.push(
        `craft: the gray pass ended early after ${count} frames (${firstLine(result.stderr)}); the decoded part is used`,
      )
    }
    const frames = new Array(count)
    for (let index = 0; index < count; index += 1) {
      const offset = index * GRAY_FRAME_BYTES
      let total = 0
      for (let pixel = 0; pixel < GRAY_FRAME_BYTES; pixel += 1) total += buffer[offset + pixel]
      frames[index] = {
        index,
        time: round2(index * GRAY_FRAME_SECONDS),
        meanLuma: round3(total / GRAY_FRAME_BYTES / 255),
        pixels: buffer.subarray(offset, offset + GRAY_FRAME_BYTES),
      }
    }
    return { ok: true, frames, frameSeconds: GRAY_FRAME_SECONDS }
  } catch (error) {
    if (isAbort(error, signal)) throw abortError()
    warnings.push(
      `craft: the low-resolution gray pass failed (${errorMessage(error)}); ` +
        'camera motion and visual transition classification fall back to the analysis timeline',
    )
    return { ok: false, frames: [], frameSeconds: GRAY_FRAME_SECONDS }
  }
}

/** Sum of absolute differences at one integer translation (coarse 2-px lattice). */
function sadAt(previous, current, dx, dy, x0 = SEARCH_X0, x1 = SEARCH_X1) {
  let total = 0
  let count = 0
  for (let y = SEARCH_Y0; y < SEARCH_Y1; y += 2) {
    const row = y * GRAY_WIDTH
    const shiftedRow = (y + dy) * GRAY_WIDTH
    for (let x = x0; x < x1; x += 2) {
      total += Math.abs(previous[row + x] - current[shiftedRow + x + dx])
      count += 1
    }
  }
  return count === 0 ? Number.POSITIVE_INFINITY : total / count
}

/**
 * Search the best integer translation and the best dx of the left/right halves.
 * A tiny magnitude penalty keeps a flat pair on (0,0) instead of an arbitrary
 * offset (all offsets tie at SAD 0 for a flat colour field).
 */
function measurePair(previous, current) {
  if (sadAt(previous, current, 0, 0) <= 1e-9) {
    return { dx: 0, dy: 0, leftDx: 0, rightDx: 0, residual: 0 }
  }
  let bestDx = 0
  let bestDy = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy += 1) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 1) {
      const score = sadAt(previous, current, dx, dy) + 1e-6 * (Math.abs(dx) + Math.abs(dy))
      if (score < bestScore) {
        bestScore = score
        bestDx = dx
        bestDy = dy
      }
    }
  }
  let leftDx = bestDx
  let rightDx = bestDx
  if (bestScore > 0.25) {
    let leftScore = Number.POSITIVE_INFINITY
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 1) {
      const score = sadAt(previous, current, dx, bestDy, SEARCH_X0, Math.floor(GRAY_WIDTH / 2) - 2) + 1e-6 * Math.abs(dx)
      if (score < leftScore) {
        leftScore = score
        leftDx = dx
      }
    }
    let rightScore = Number.POSITIVE_INFINITY
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 1) {
      const score = sadAt(previous, current, dx, bestDy, Math.floor(GRAY_WIDTH / 2) + 2, SEARCH_X1) + 1e-6 * Math.abs(dx)
      if (score < rightScore) {
        rightScore = score
        rightDx = dx
      }
    }
  }
  return { dx: bestDx, dy: bestDy, leftDx, rightDx, residual: round3(bestScore) }
}

/** Mean absolute frame difference (0..1) — the "did the picture change" signal. */
function frameDifference(previous, current) {
  let total = 0
  let count = 0
  for (let y = 2; y < GRAY_HEIGHT - 2; y += 2) {
    const row = y * GRAY_WIDTH
    for (let x = 2; x < GRAY_WIDTH - 2; x += 2) {
      total += Math.abs(previous[row + x] - current[row + x])
      count += 1
    }
  }
  return count === 0 ? 0 : total / count / 255
}

/**
 * Decide which frame pairs to measure (within-shot pairs for camera motion,
 * ±0.5 s around every boundary for transitions) and measure each pair once.
 * Long inputs are sampled down to MAX_CAMERA_PAIRS camera pairs; every measured
 * pair is still a pair of *consecutive* frames.
 */
function computePairMeasurements({ gray, structure, warnings }) {
  const measurements = new Map()
  const cameraPairs = structure.shots.map(() => [])
  if (!gray.ok || gray.frames.length < 2) return { measurements, cameraPairs }
  const frameCount = gray.frames.length

  // Which shot owns each decoded frame (frame k has nominal time k/4 s).
  const shotOfFrame = new Int32Array(frameCount).fill(-1)
  for (let shotIndex = 0; shotIndex < structure.shots.length; shotIndex += 1) {
    const shot = structure.shots[shotIndex]
    const first = clamp(Math.ceil(shot.start / gray.frameSeconds - 1e-6), 0, frameCount - 1)
    const last = clamp(Math.ceil(shot.end / gray.frameSeconds - 1e-6) - 1, -1, frameCount - 1)
    for (let k = first; k <= last; k += 1) shotOfFrame[k] = shotIndex
  }

  const pairsByShot = structure.shots.map(() => [])
  for (let k = 1; k < frameCount; k += 1) {
    const shotIndex = shotOfFrame[k]
    if (shotIndex < 0 || shotOfFrame[k - 1] !== shotIndex) continue
    // Keep a guard band around the shot edges: the fps filter rounds each output
    // frame to the nearest source frame, so the pair straddling a boundary can be
    // nominally "inside" the shot while its second frame is already the next shot.
    // Such a pair reports a bogus ±6 px translation and must not pollute the
    // camera statistics.
    const shot = structure.shots[shotIndex]
    const pairStart = (k - 1) * gray.frameSeconds
    const pairEnd = k * gray.frameSeconds
    const guard = Math.min(PAIR_BOUNDARY_GUARD, shot.duration / 4)
    if (pairStart < shot.start + guard) continue
    if (pairEnd > shot.end - guard) continue
    pairsByShot[shotIndex].push(k)
  }

  const maxPerShot = Math.max(3, Math.floor(MAX_CAMERA_PAIRS / Math.max(1, structure.shots.length)))
  for (let shotIndex = 0; shotIndex < pairsByShot.length; shotIndex += 1) {
    const pairs = pairsByShot[shotIndex]
    if (pairs.length === 0) continue
    const step = Math.max(1, Math.ceil(pairs.length / maxPerShot))
    for (let index = 0; index < pairs.length; index += step) {
      const k = pairs[index]
      cameraPairs[shotIndex].push(k)
      measurements.set(k, null)
    }
  }

  // Transition windows: the crossing pair (frame at/after the boundary) ±2 pairs.
  for (let index = 1; index < structure.shots.length; index += 1) {
    const kCut = clamp(Math.round(structure.shots[index].start / gray.frameSeconds), 1, frameCount - 1)
    for (let k = Math.max(1, kCut - 2); k <= Math.min(frameCount - 1, kCut + 2); k += 1) {
      if (!measurements.has(k)) measurements.set(k, null)
    }
  }

  for (const k of measurements.keys()) {
    if (measurements.get(k) !== null) continue
    measurements.set(k, measurePair(gray.frames[k - 1].pixels, gray.frames[k].pixels))
  }
  if (cameraPairs.every((pairs) => pairs.length === 0)) {
    warnings.push('craft: too few low-resolution frames inside the shots to measure camera motion')
  }
  return { measurements, cameraPairs }
}

/* ------------------------------------------------------------------ *
 * Camera motion per shot
 * ------------------------------------------------------------------ */

const MOTION_ZH = {
  static: '固定机位',
  'pan-left': '向左摇镜',
  'pan-right': '向右摇镜',
  'tilt-up': '向上摇镜',
  'tilt-down': '向下摇镜',
  'zoom-in': '缓慢推近',
  'zoom-out': '缓慢拉远',
  handheld: '手持晃动',
}

/**
 * Turn one shot's pair measurements into {motion, intensity}.
 * Order matters: zoom is checked before static because a symmetric zoom has
 * (almost) zero global translation and would otherwise read as static.
 */
function summariseShotMotion(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null
  const dxs = pairs.map((pair) => pair.dx)
  const dys = pairs.map((pair) => pair.dy)
  const meanDx = mean(dxs)
  const meanDy = mean(dys)
  const meanAbsDx = mean(dxs.map((value) => Math.abs(value)))
  const meanAbsDy = mean(dys.map((value) => Math.abs(value)))
  const meanMagnitude = mean(pairs.map((pair) => Math.hypot(pair.dx, pair.dy)))
  const zoomSignal = mean(pairs.map((pair) => pair.rightDx - pair.leftDx))
  const jitterX = mean(dxs.map((value) => Math.abs(value - meanDx)))
  const jitterY = mean(dys.map((value) => Math.abs(value - meanDy)))
  let signFlips = 0
  for (let index = 1; index < dxs.length; index += 1) {
    if (dxs[index] === 0 || dxs[index - 1] === 0) continue
    if (Math.sign(dxs[index]) !== Math.sign(dxs[index - 1]) && Math.abs(dxs[index]) >= 1 && Math.abs(dxs[index - 1]) >= 1) {
      signFlips += 1
    }
  }
  const flipRatio = dxs.length > 1 ? signFlips / (dxs.length - 1) : 0
  // A coherent pan/tilt has |mean| close to mean|.|; an incoherent shake does not.
  const coherent = Math.abs(meanDx) <= 0.5 * meanAbsDx + 0.15 && Math.abs(meanDy) <= 0.5 * meanAbsDy + 0.15
  const zoomConsistency = Math.abs(zoomSignal) > 1e-9
    ? pairs.filter((pair) => Math.sign(pair.rightDx - pair.leftDx) === Math.sign(zoomSignal) && pair.rightDx !== pair.leftDx).length / pairs.length
    : 0
  const handholdFromFlips = pairs.length >= 4 && flipRatio >= 0.4 && meanAbsDx >= 0.8
  const handholdFromIncoherence = meanMagnitude >= 0.6 && coherent

  let motion = 'static'
  let intensity = meanMagnitude
  if (Math.abs(zoomSignal) >= ZOOM_THRESHOLD && zoomConsistency >= 0.6 && meanAbsDx < 1.5 && meanAbsDy < 1.5) {
    motion = zoomSignal > 0 ? 'zoom-in' : 'zoom-out'
    intensity = Math.min(1, Math.abs(zoomSignal) / 8)
  } else if (meanAbsDx < STATIC_THRESHOLD && meanAbsDy < STATIC_THRESHOLD) {
    motion = 'static'
    intensity = meanMagnitude
  } else if (handholdFromFlips || handholdFromIncoherence) {
    motion = 'handheld'
    intensity = Math.min(1, (meanMagnitude + jitterX + jitterY) / 6)
  } else if (Math.max(Math.abs(meanDx), Math.abs(meanDy)) >= DIRECTION_THRESHOLD) {
    if (Math.abs(meanDx) >= Math.abs(meanDy)) {
      motion = meanDx < 0 ? 'pan-right' : 'pan-left'
      intensity = Math.min(1, Math.abs(meanDx) / 6)
    } else {
      motion = meanDy > 0 ? 'tilt-up' : 'tilt-down'
      intensity = Math.min(1, Math.abs(meanDy) / 6)
    }
  } else {
    motion = 'handheld'
    intensity = Math.min(1, (meanMagnitude + jitterX + jitterY) / 6)
  }
  return {
    motion,
    intensity: round3(intensity),
    meanDx: round2(meanDx),
    meanDy: round2(meanDy),
    zoomSignal: round2(zoomSignal),
    pairCount: pairs.length,
  }
}

function analyseCameraMetrics({ structure, measurements, cameraPairs }) {
  return structure.shots.map((_shot, shotIndex) => {
    const pairs = cameraPairs[shotIndex].map((k) => measurements.get(k)).filter((pair) => pair !== null && pair !== undefined)
    return summariseShotMotion(pairs)
  })
}

function buildCameraEntries({ structure, cameraMetrics }) {
  return structure.shots.map((_shot, index) => {
    const metrics = cameraMetrics[index] ?? null
    if (metrics === null) return { shotIndex: index, motion: null, intensity: null }
    return { shotIndex: index, motion: metrics.motion, intensity: metrics.intensity }
  })
}

/* ------------------------------------------------------------------ *
 * Transition classification at every shot boundary
 * ------------------------------------------------------------------ */

/**
 * Classify a boundary from the 4 fps gray pair differences around it.
 * Hard cut = isolated one-pair difference spike; fade = elevated differences
 * across several pairs; dip-to-black = luma dips toward black between two
 * brighter sides (V shape, checked first).
 */
function classifyBoundaryFromFrames({ gray, at, diffAt, structure }) {
  const frames = gray.frames
  if (frames.length < 4) return { kind: 'other', confidence: 0.3 }
  const kCut = clamp(Math.round(at / gray.frameSeconds), 1, frames.length - 1)
  const kFirst = Math.max(1, kCut - 2)
  const kLast = Math.min(frames.length - 1, kCut + 2)
  const windowDiffs = []
  for (let k = kFirst; k <= kLast; k += 1) windowDiffs.push({ k, diff: diffAt(k) })
  const crossing = windowDiffs.find((entry) => entry.k === kCut) ?? windowDiffs[0]
  const otherDiffs = windowDiffs.filter((entry) => entry.k !== crossing.k).map((entry) => entry.diff)
  const noise = (median(otherDiffs) ?? 0) + 0.0025
  const signal = crossing.diff
  const ratio = noise > 0 ? signal / noise : 0

  const leftLuma = frames[Math.max(0, kCut - 3)].meanLuma
  const rightLuma = frames[Math.min(frames.length - 1, kCut + 3)].meanLuma
  let lumaMinimum = Number.POSITIVE_INFINITY
  for (let k = Math.max(0, kCut - 2); k <= Math.min(frames.length - 1, kCut + 2); k += 1) {
    lumaMinimum = Math.min(lumaMinimum, frames[k].meanLuma)
  }
  const dipStrength = Math.min(leftLuma - lumaMinimum, rightLuma - lumaMinimum)
  const nearBlackSpan = structure.flags.black.some(
    (span) => at >= span.start - 0.3 && at <= span.end + 0.3,
  )
  if ((lumaMinimum < 0.1 && dipStrength > 0.08) || nearBlackSpan) {
    return {
      kind: 'dip-to-black',
      confidence: clamp(0.62 + dipStrength, 0.62, 0.95),
    }
  }
  // An instantaneous cut is one isolated difference spike. A cross-fade raises
  // the difference of two consecutive pairs to a comparable level, so a spike
  // that is not alone on its own is evidence of a gradual transition.
  const elevatedThreshold = Math.max(0.004, 0.25 * signal)
  const elevated = windowDiffs.filter((entry) => entry.diff >= elevatedThreshold).length
  const neighbourMax = Math.max(
    windowDiffs.find((entry) => entry.k === kCut - 1)?.diff ?? 0,
    windowDiffs.find((entry) => entry.k === kCut + 1)?.diff ?? 0,
  )
  const isolatedSpike = signal >= 0.012 && ratio >= 2.2 && signal >= 2.5 * neighbourMax
  const sprayOfSpikes = elevated >= 2 && signal < 0.06
  if (isolatedSpike && !sprayOfSpikes) {
    return { kind: 'cut', confidence: clamp(0.55 + 0.45 * (1 - 1 / ratio), 0.5, 0.98) }
  }
  if (elevated >= 2 && signal >= 0.003) {
    return { kind: 'fade', confidence: clamp(0.5 + 0.12 * elevated, 0.5, 0.9) }
  }
  if (signal >= 0.012 && ratio >= 2.2) {
    return { kind: 'cut', confidence: clamp(0.5 + 0.4 * (1 - 1 / ratio), 0.5, 0.95) }
  }
  if (signal >= 0.006) return { kind: 'cut', confidence: 0.5 }
  return { kind: 'other', confidence: 0.4 }
}

/** Fallback when the gray pass is unavailable: use the 1 Hz analysis timeline. */
function classifyBoundaryFromTimeline(at, structure) {
  const timeline = structure.timeline
  if (timeline.length === 0) return { kind: 'other', confidence: 0.3 }
  let before = timeline[0]
  for (const point of timeline) if (point.t <= at - 0.2) before = point
  let after = timeline[timeline.length - 1]
  for (let index = timeline.length - 1; index >= 0; index -= 1) if (timeline[index].t >= at + 0.2) after = timeline[index]
  const near = timeline.filter((point) => Math.abs(point.t - at) <= 0.9)
  const brightnessValues = [...near.map((point) => point.brightness), before.brightness, after.brightness]
  const minimum = Math.min(...brightnessValues)
  const maximum = Math.max(...brightnessValues)
  const dip = minimum < 0.06 && before.brightness - minimum > 0.08 && after.brightness - minimum > 0.08
  const intermediate = near.some((point) => point.brightness > minimum + 0.03 && point.brightness < maximum - 0.03)
  const motionNear = near.length > 0 ? Math.max(...near.map((point) => point.motion)) : 0
  const step = Math.abs(after.brightness - before.brightness)
  if (dip) return { kind: 'dip-to-black', confidence: 0.6 }
  if (intermediate) return { kind: 'fade', confidence: 0.55 }
  if (step >= 0.08 || motionNear >= 5) return { kind: 'cut', confidence: 0.6 }
  return { kind: 'other', confidence: 0.35 }
}

function classifyTransitions({ gray, structure, measurements, warnings }) {
  const shots = structure.shots
  if (shots.length < 2) {
    if (shots.length === 1) warnings.push('craft: only one shot was detected, so there are no shot boundaries to classify')
    return { hardCutShare: 0, gradualShare: 0, list: [] }
  }
  const diffCache = new Map()
  const diffAt = (k) => {
    if (!diffCache.has(k)) {
      diffCache.set(k, frameDifference(gray.frames[k - 1].pixels, gray.frames[k].pixels))
    }
    return diffCache.get(k)
  }
  const list = []
  const undetected = []
  for (let index = 1; index < shots.length; index += 1) {
    const at = shots[index].start
    const entry = gray.ok && measurements instanceof Map
      ? classifyBoundaryFromFrames({ gray, at, diffAt, structure })
      : classifyBoundaryFromTimeline(at, structure)
    list.push({ at: round2(at), kind: entry.kind, confidence: round3(entry.confidence) })
    if (entry.kind === 'other') undetected.push(at)
  }
  const total = list.length
  const hardCuts = list.filter((entry) => entry.kind === 'cut').length
  const gradual = list.filter((entry) => entry.kind === 'fade' || entry.kind === 'dip-to-black').length
  if (undetected.length > 0) {
    const shown = undetected.slice(0, 3).map((at) => formatTimecode(at)).join(', ')
    warnings.push(
      `craft: no visual change was detectable at ${undetected.length} shot boundar${undetected.length === 1 ? 'y' : 'ies'} ` +
        `(${shown}${undetected.length > 3 ? ', ...' : ''}); these are likely density-floor splits rather than real cuts`,
    )
  }
  return {
    hardCutShare: total === 0 ? 0 : round3(hardCuts / total),
    gradualShare: total === 0 ? 0 : round3(gradual / total),
    list,
  }
}

/* ------------------------------------------------------------------ *
 * Stage 2 — one RGB sample pass for grading, overlays and title style
 * ------------------------------------------------------------------ */

/** Throttle the sampling rate so a long file still yields <= maxSamples frames. */
function computeSampleFps(duration, maxSamples) {
  const seconds = Number.isFinite(duration) && duration > 0 ? duration : 0
  const wanted = seconds > 0 ? maxSamples / seconds : DEFAULT_SAMPLE_FPS
  return Math.min(DEFAULT_SAMPLE_FPS, Math.max(1 / 120, Math.round(wanted * 1000) / 1000))
}

async function decodeRgbSamples({ tools, file, workDir, duration, options, signal, warnings }) {
  const sampleFps = computeSampleFps(duration, options.maxSamples)
  const expectedBytes = (options.maxSamples + 8) * RGB_FRAME_BYTES
  const maxBuffer = Math.min(256 * 1024 * 1024, Math.max(8 * 1024 * 1024, expectedBytes))
  try {
    const result = await runBuffer(
      tools.ffmpeg,
      ['-v', 'error', '-nostdin', '-i', file, '-an', '-vf', `fps=${sampleFps},scale=${RGB_WIDTH}:${RGB_HEIGHT},format=rgb24`, '-f', 'rawvideo', '-'],
      { cwd: workDir, timeoutMs: 10 * 60 * 1000, maxBuffer, signal },
    )
    const available = Math.floor(result.stdout.length / RGB_FRAME_BYTES)
    const count = Math.min(options.maxSamples, available)
    if (count === 0) {
      warnings.push(
        `craft: the RGB sample pass produced no frames (${firstLine(result.stderr) || `exit code ${result.code}`}); ` +
          'colour grading, overlay and title-card analysis are unavailable',
      )
      return null
    }
    if (result.code !== 0) {
      warnings.push(`craft: the RGB sample pass ended early after ${count} frames (${firstLine(result.stderr)}); the decoded part is used`)
    }
    const samples = []
    for (let index = 0; index < count; index += 1) {
      const offset = index * RGB_FRAME_BYTES
      samples.push({
        index,
        time: round2(index / sampleFps),
        rgb: result.stdout.subarray(offset, offset + RGB_FRAME_BYTES),
      })
    }
    return {
      samples,
      sampleFps,
      width: RGB_WIDTH,
      height: RGB_HEIGHT,
    }
  } catch (error) {
    if (isAbort(error, signal)) throw abortError()
    warnings.push(`craft: the RGB sample pass failed (${errorMessage(error)}); colour grading, overlay and title-card analysis are unavailable`)
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Colour grading
 * ------------------------------------------------------------------ */

const TINT_ZH = { blue: '蓝', teal: '青', warm: '暖', neutral: '中性', cool: '冷' }

/** Classify a (r−b, g−b) mean offset into the contract tint vocabulary. */
function tintFromOffsets({ rMinusB, gMinusB, allowTeal }) {
  if (rMinusB > 0.02) return 'warm'
  if (-rMinusB > 0.02) {
    if (!allowTeal) return 'cool'
    const coolness = -rMinusB
    // Teal keeps green near blue; blue is bluer than green.
    return gMinusB < -0.15 * coolness ? 'blue' : 'teal'
  }
  return 'neutral'
}

/**
 * Measure global contrast/saturation/temperature, the shadow and highlight
 * casts, the signature tags and a 4-colour global palette from sampled frames.
 */
function analyseGrading(rgbData, warnings) {
  const empty = {
    metrics: {
      contrast: null,
      saturation: null,
      temperature: null,
      shadowTint: null,
      highlightTint: null,
      signature: null,
    },
    palette: [],
  }
  if (rgbData === null || rgbData.samples.length === 0) {
    warnings.push('craft: no RGB frames were sampled, so colour grading could not be measured')
    return empty
  }
  const samples = rgbData.samples
  let totalPixels = 0
  let sumLuma = 0
  let sumLumaSquared = 0
  let sumSaturation = 0
  let sumR = 0
  let sumG = 0
  let sumB = 0
  const bands = {
    shadow: { count: 0, r: 0, g: 0, b: 0 },
    mid: { count: 0, r: 0, g: 0, b: 0 },
    highlight: { count: 0, r: 0, g: 0, b: 0 },
  }
  const paletteBuckets = new Map()

  for (const sample of samples) {
    const rgb = sample.rgb
    for (let index = 0; index < RGB_FRAME_BYTES; index += 3) {
      const r = rgb[index] / 255
      const g = rgb[index + 1] / 255
      const b = rgb[index + 2] / 255
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
      totalPixels += 1
      sumLuma += luma
      sumLumaSquared += luma * luma
      sumR += r
      sumG += g
      sumB += b
      const maximum = Math.max(r, g, b)
      const minimum = Math.min(r, g, b)
      if (maximum > 0.0001) sumSaturation += (maximum - minimum) / maximum
      const band = luma < 0.3 ? bands.shadow : luma > 0.65 ? bands.highlight : bands.mid
      band.count += 1
      band.r += r
      band.g += g
      band.b += b
      // 3 bits per channel palette (same quantisation as the perception engine).
      const key = ((rgb[index] >> 5) << 6) | ((rgb[index + 1] >> 5) << 3) | (rgb[index + 2] >> 5)
      const bucket = paletteBuckets.get(key)
      if (bucket === undefined) {
        paletteBuckets.set(key, { count: 1, r: rgb[index], g: rgb[index + 1], b: rgb[index + 2] })
      } else {
        bucket.count += 1
        bucket.r += rgb[index]
        bucket.g += rgb[index + 1]
        bucket.b += rgb[index + 2]
      }
    }
  }

  const meanLuma = sumLuma / totalPixels
  const contrast = Math.sqrt(Math.max(0, sumLumaSquared / totalPixels - meanLuma * meanLuma))
  const saturation = sumSaturation / totalPixels
  const rMinusB = (sumR - sumB) / totalPixels
  const shadowRMinusB = bands.shadow.count > 0 ? (bands.shadow.r - bands.shadow.b) / bands.shadow.count : null
  const shadowGMinusB = bands.shadow.count > 0 ? (bands.shadow.g - bands.shadow.b) / bands.shadow.count : null
  const highlightRMinusB = bands.highlight.count > 0 ? (bands.highlight.r - bands.highlight.b) / bands.highlight.count : null
  const highlightGMinusB = bands.highlight.count > 0 ? (bands.highlight.g - bands.highlight.b) / bands.highlight.count : null

  const shadowTint = shadowRMinusB === null ? null : tintFromOffsets({ rMinusB: shadowRMinusB, gMinusB: shadowGMinusB, allowTeal: true })
  const highlightTint = highlightRMinusB === null ? null : tintFromOffsets({ rMinusB: highlightRMinusB, gMinusB: highlightGMinusB, allowTeal: false })
  const temperature = rMinusB > 0.02 ? 'warm' : rMinusB < -0.02 ? 'cool' : 'neutral'

  const signature = []
  if (contrast > 0.25) signature.push('high-contrast')
  else if (contrast < 0.08) signature.push('low-contrast')
  if (shadowTint !== null && highlightTint !== null && (shadowTint === 'blue' || shadowTint === 'teal') && highlightTint === 'warm') {
    signature.push('teal-orange')
  }
  if (saturation < 0.12) signature.push('desaturated')
  signature.push(temperature)

  const palette = [...paletteBuckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map((bucket) => `#${toHexPart(bucket.r / bucket.count)}${toHexPart(bucket.g / bucket.count)}${toHexPart(bucket.b / bucket.count)}`)

  return {
    metrics: {
      contrast: round3(contrast),
      saturation: round3(saturation),
      temperature,
      shadowTint,
      highlightTint,
      signature,
    },
    palette,
  }
}

function toHexPart(value) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

/* ------------------------------------------------------------------ *
 * RGB raster helpers (gradients, luma, hue naming)
 * ------------------------------------------------------------------ */

/** Rec.709 luma raster (0..1) for one 160×90 RGB frame. */
function frameLuma(rgb) {
  const luma = new Float32Array(RGB_WIDTH * RGB_HEIGHT)
  for (let index = 0; index < luma.length; index += 1) {
    const offset = index * 3
    luma[index] = (0.2126 * rgb[offset] + 0.7152 * rgb[offset + 1] + 0.0722 * rgb[offset + 2]) / 255
  }
  return luma
}

/** Mean absolute luminance gradient over a row band, normalised to 0..1. */
function gradientDensity(luma, rowStart, rowEnd) {
  const y0 = clamp(Math.round(rowStart), 0, RGB_HEIGHT - 1)
  const y1 = clamp(Math.round(rowEnd), y0 + 1, RGB_HEIGHT)
  let total = 0
  let count = 0
  for (let y = y0; y < y1 - 1; y += 1) {
    const row = y * RGB_WIDTH
    const nextRow = row + RGB_WIDTH
    for (let x = 0; x < RGB_WIDTH - 1; x += 1) {
      total += Math.abs(luma[row + x + 1] - luma[row + x]) + Math.abs(luma[nextRow + x] - luma[row + x])
      count += 1
    }
  }
  return count === 0 ? 0 : Math.min(1, total / count / 0.5)
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

function hueNameOf(degrees) {
  const value = ((degrees % 360) + 360) % 360
  for (const bucket of HUE_BUCKETS) if (value < bucket.max) return bucket.name
  return 'red'
}

function hueFromRgb(r, g, b) {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const maximum = Math.max(rn, gn, bn)
  const minimum = Math.min(rn, gn, bn)
  const delta = maximum - minimum
  if (delta <= 1e-6) return null
  let hue
  if (maximum === rn) hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60
  else if (maximum === gn) hue = ((bn - rn) / delta + 2) * 60
  else hue = ((rn - gn) / delta + 4) * 60
  return hue % 360
}

/** Nearest measured pair magnitude to a sample time (null when further than 0.75 s). */
function buildMotionLookup({ gray, measurements }) {
  const pairs = measurements instanceof Map ? measurements : new Map()
  if (!gray.ok || pairs.size === 0) return () => null
  const entries = [...pairs.entries()]
    .map(([k, pair]) => ({ t: k * gray.frameSeconds, magnitude: Math.hypot(pair.dx, pair.dy) }))
    .sort((a, b) => a.t - b.t)
  return (time) => {
    let low = 0
    let high = entries.length - 1
    while (low < high) {
      const middle = (low + high) >> 1
      if (entries[middle].t < time) low = middle + 1
      else high = middle
    }
    let best = entries[low]
    if (low > 0 && Math.abs(entries[low - 1].t - time) <= Math.abs(best.t - time)) best = entries[low - 1]
    return Math.abs(best.t - time) <= 0.75 ? best.magnitude : null
  }
}

/* ------------------------------------------------------------------ *
 * Overlays (top/bottom text bands) and title card
 * ------------------------------------------------------------------ */

function analyseOverlays({ rgbData, gray, measurements, warnings }) {
  const empty = {
    textDensity: null,
    likelySubtitles: null,
    likelyTitleCard: null,
    topBandDetail: null,
    bottomBandDetail: null,
  }
  if (rgbData === null || rgbData.samples.length === 0) {
    warnings.push('craft: no RGB frames were sampled, so overlay/text-band analysis is unavailable')
    return empty
  }
  const motionAt = buildMotionLookup({ gray, measurements })
  const topRows = Math.max(2, Math.round(RGB_HEIGHT * TOP_BAND_SHARE))
  const bottomRows = Math.max(2, Math.round(RGB_HEIGHT * BOTTOM_BAND_SHARE))
  let topTotal = 0
  let bottomTotal = 0
  let flaggedFrames = 0
  let subtitleFrames = 0
  let titleFrames = 0
  for (const sample of rgbData.samples) {
    const luma = frameLuma(sample.rgb)
    const overall = gradientDensity(luma, 0, RGB_HEIGHT)
    const top = gradientDensity(luma, 0, topRows)
    const bottom = gradientDensity(luma, RGB_HEIGHT - bottomRows, RGB_HEIGHT)
    const centre = gradientDensity(luma, RGB_HEIGHT * CENTRE_BAND_START, RGB_HEIGHT * CENTRE_BAND_END)
    const motion = motionAt(sample.time)
    const still = motion === null || motion < 2
    // Subtitles: a sharp, dense band at the bottom well above the frame's own
    // texture. Textiles/sand/foliage raise the bottom band only mildly (ratio
    // ~1.5-1.7 in the reference fixtures), so the ratio threshold is 1.8.
    const subtitleLike = still && bottom >= 0.07 && bottom >= 1.8 * overall
    // Title cards: a dense centred band (text on a flat field) or a dense top
    // band. Both must stand out from the whole-frame texture.
    const titleLike = still && ((top >= 0.06 && top >= 1.8 * overall) || (centre >= 0.05 && centre >= 1.5 * overall))
    topTotal += top
    bottomTotal += bottom
    if (subtitleLike) subtitleFrames += 1
    if (titleLike) titleFrames += 1
    if (subtitleLike || titleLike) flaggedFrames += 1
  }
  const count = rgbData.samples.length
  return {
    textDensity: round3(flaggedFrames / count),
    likelySubtitles: subtitleFrames / count >= 0.3,
    likelyTitleCard: titleFrames / count >= 0.2,
    topBandDetail: round3(topTotal / count),
    bottomBandDetail: round3(bottomTotal / count),
  }
}

/**
 * Infer a human-readable title-card style from the brightest (text) pixels inside
 * the centre region and from the overall background luma.
 */
function inferTitleStyle(sample) {
  if (sample === null || sample === undefined) return null
  const rgb = sample.rgb
  const luma = frameLuma(rgb)
  let sumLuma = 0
  for (let index = 0; index < luma.length; index += 1) sumLuma += luma[index]
  const backgroundLuma = sumLuma / luma.length
  const rowStart = Math.round(RGB_HEIGHT * CENTRE_BAND_START)
  const rowEnd = Math.round(RGB_HEIGHT * CENTRE_BAND_END)
  const columnStart = Math.round(RGB_WIDTH * 0.12)
  const columnEnd = Math.round(RGB_WIDTH * 0.88)
  const centreLumas = []
  for (let y = rowStart; y < rowEnd; y += 1) {
    for (let x = columnStart; x < columnEnd; x += 1) centreLumas.push(luma[y * RGB_WIDTH + x])
  }
  if (centreLumas.length === 0) return null
  centreLumas.sort((a, b) => a - b)
  const quantile = centreLumas[Math.min(centreLumas.length - 1, Math.floor(centreLumas.length * 0.97))]
  const threshold = Math.max(0.55, quantile)
  let count = 0
  let red = 0
  let green = 0
  let blue = 0
  let textLuma = 0
  for (let y = rowStart; y < rowEnd; y += 1) {
    for (let x = columnStart; x < columnEnd; x += 1) {
      const index = y * RGB_WIDTH + x
      if (luma[index] < threshold) continue
      const offset = index * 3
      count += 1
      red += rgb[offset]
      green += rgb[offset + 1]
      blue += rgb[offset + 2]
      textLuma += luma[index]
    }
  }
  if (count < 8) return null
  const textR = red / count
  const textG = green / count
  const textB = blue / count
  const maximum = Math.max(textR, textG, textB) / 255
  const minimum = Math.min(textR, textG, textB) / 255
  const saturation = maximum > 0.0001 ? (maximum - minimum) / maximum : 0
  let textName
  if (textLuma / count >= 0.65 && saturation <= 0.25) {
    textName = 'white'
  } else {
    const hue = hueFromRgb(textR, textG, textB)
    textName = hue === null ? 'white' : hueNameOf(hue)
  }
  const background = backgroundLuma < 0.35 ? 'dark' : backgroundLuma > 0.6 ? 'bright' : 'flat'
  return `centered-${textName}-on-${background}`
}

/** Best-effort title card detection for the opening shot. */
function analyseTitleCard({ structure, rgbData, camera, warnings }) {
  const shots = structure.shots
  if (shots.length === 0) {
    return { present: null, at: null, duration: null, style: null }
  }
  const first = shots[0]
  const firstCamera = camera.length > 0 ? camera[0] : null
  const lowMotion = firstCamera !== null && firstCamera.motion !== null
    ? firstCamera.motion === 'static' || (Number.isFinite(firstCamera.intensity) && firstCamera.intensity < 0.35)
    : null
  const layoutTitle = typeof first.layout === 'string' && /bright cent(?:re|er)/iu.test(first.layout)
  const firstShotSamples = rgbData === null
    ? []
    : rgbData.samples.filter((sample) => sample.time >= first.start - 0.01 && sample.time < first.end - 0.01)
  let centreEvidence = null
  for (const sample of firstShotSamples) {
    const luma = frameLuma(sample.rgb)
    const overall = gradientDensity(luma, 0, RGB_HEIGHT)
    const centre = gradientDensity(luma, RGB_HEIGHT * CENTRE_BAND_START, RGB_HEIGHT * CENTRE_BAND_END)
    if (centre >= 0.05 && centre >= 1.5 * overall) centreEvidence = true
    else if (centreEvidence === null) centreEvidence = false
  }
  const titleEvidence = layoutTitle || centreEvidence === true
  let present = null
  if (lowMotion !== null || rgbData !== null) {
    if (first.duration < 0.8) present = false
    else if (lowMotion === false) present = false
    else present = titleEvidence
  }
  if (present !== true) {
    return { present, at: null, duration: null, style: null }
  }
  const style = firstShotSamples.length > 0 ? inferTitleStyle(firstShotSamples[0]) : null
  return { present: true, at: round2(first.start), duration: round2(first.duration), style }
}

/* ------------------------------------------------------------------ *
 * Hook, beat sync, sections, cut rhythm, sound role
 * ------------------------------------------------------------------ */

function computeHook({ structure, camera, transitions, titleCard }) {
  if (structure.shots.length === 0) {
    return { hasEarlyCut: null, hasTitleInFirst3s: null, firstShotMotion: null, hookStrength: null }
  }
  const hasTitleInFirst3s = titleCard.present === null
    ? null
    : titleCard.present === true && titleCard.at !== null && titleCard.at < 3
  const hasEarlyCut = transitions.list.some((entry) => entry.at > 0.3 && entry.at <= 3)
  const firstShotMotion = camera.length > 0 ? camera[0].motion : null
  const activeCamera = firstShotMotion !== null && firstShotMotion !== 'static'
  const titleComponent = hasTitleInFirst3s === true ? 0.4 : 0
  const cutComponent = hasEarlyCut ? 0.35 : 0
  const motionComponent = activeCamera ? 0.25 : 0
  return {
    hasEarlyCut,
    hasTitleInFirst3s,
    firstShotMotion,
    hookStrength: round3(Math.min(1, titleComponent + cutComponent + motionComponent)),
  }
}

/** Signed distance in ms from a cut to the nearest beat (binary search). */
function nearestBeatOffsetMs(cutTime, beatTimes) {
  let low = 0
  let high = beatTimes.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (beatTimes[middle] < cutTime) low = middle + 1
    else high = middle
  }
  let best = beatTimes[low]
  if (low > 0 && Math.abs(beatTimes[low - 1] - cutTime) <= Math.abs(best - cutTime)) best = beatTimes[low - 1]
  return (cutTime - best) * 1000
}

function computeBeatSync({ structure, transitions }) {
  const result = {
    bpm: null,
    cutsOnBeatRatio: null,
    meanOffsetMs: null,
    note: 'no soundtrack was supplied, so cut-to-beat sync cannot be measured',
  }
  const audio = structure.audio
  if (audio === null) return result
  const tempo = audio.tempo !== null && typeof audio.tempo === 'object' ? audio.tempo : {}
  const bpm = parseNumber(tempo.bpm)
  if (bpm !== null && bpm > 0) result.bpm = round1(bpm)
  const beatTimes = Array.isArray(tempo.beatTimes)
    ? tempo.beatTimes.map((value) => parseNumber(value)).filter((value) => value !== null && value >= 0).sort((a, b) => a - b)
    : []
  if (beatTimes.length < 4) {
    result.note = beatTimes.length === 0
      ? `cut-to-beat sync is not measurable: no reliable beat grid was detected${result.bpm === null ? '' : ` (tempo estimate ${result.bpm} BPM)`}`
      : `cut-to-beat sync is not measurable: only ${beatTimes.length} beat times were reported${result.bpm === null ? '' : ` (tempo estimate ${result.bpm} BPM)`}`
    return result
  }
  const cutTimes = transitions.list.map((entry) => entry.at)
  if (cutTimes.length === 0) {
    result.note = 'there are no shot boundaries to align with the beat grid'
    return result
  }
  const offsets = cutTimes.map((cutTime) => nearestBeatOffsetMs(cutTime, beatTimes))
  const onBeat = offsets.filter((offset) => Math.abs(offset) <= BEAT_TOLERANCE_MS).length
  result.cutsOnBeatRatio = round3(onBeat / offsets.length)
  result.meanOffsetMs = round1(mean(offsets))
  result.note = `${onBeat} of ${offsets.length} cuts land within ${BEAT_TOLERANCE_MS} ms of a beat (mean signed offset ${result.meanOffsetMs} ms)`
  return result
}

const ROLE_ZH = { intro: '开场', body: '主体', outro: '结尾' }

function computeSections({ structure, titleCard }) {
  const shots = structure.shots
  if (shots.length === 0) return []
  const sections = []
  let introEnd = shots[0].end
  if (titleCard.present === true && titleCard.at !== null && Number.isFinite(titleCard.duration)) {
    const titleEnd = titleCard.at + titleCard.duration
    if (titleEnd > introEnd + 0.05) introEnd = round2(Math.min(structure.duration > 0 ? structure.duration : titleEnd, titleEnd))
  }
  const introShots = shots.filter((shot) => shot.start < introEnd - 1e-6)
  sections.push({
    start: round2(shots[0].start),
    end: round2(introEnd),
    role: 'intro',
    avgShotLength: round2(mean(introShots.map((shot) => shot.duration)) ?? introEnd - shots[0].start),
  })
  if (shots.length >= 3) {
    const bodyShots = shots.slice(1, -1)
    sections.push({
      start: round2(bodyShots[0].start),
      end: round2(bodyShots[bodyShots.length - 1].end),
      role: 'body',
      avgShotLength: round2(mean(bodyShots.map((shot) => shot.duration))),
    })
  }
  if (shots.length >= 2) {
    const last = shots[shots.length - 1]
    sections.push({
      start: round2(last.start),
      end: round2(last.end),
      role: 'outro',
      avgShotLength: round2(last.duration),
    })
  }
  return sections
}

function computeCutRhythm(structure) {
  const shots = structure.shots
  if (shots.length === 0) {
    return {
      shotCount: 0,
      avgShotLength: null,
      medianShotLength: null,
      shortestShot: null,
      longestShot: null,
      stdDev: null,
      cutRatePerMin: null,
      cutsPer10s: [],
    }
  }
  const lengths = shots.map((shot) => shot.duration).filter((value) => Number.isFinite(value) && value > 0)
  const totalDuration = structure.duration > 0 ? structure.duration : lengths.reduce((sum, value) => sum + value, 0)
  const boundaries = shots.slice(1).map((shot) => shot.start)
  const minutes = totalDuration / 60
  const binCount = Math.max(1, Math.min(600, Math.ceil(totalDuration / 10 - 1e-9)))
  const cutsPer10s = new Array(binCount).fill(0)
  for (const at of boundaries) cutsPer10s[clamp(Math.floor(at / 10), 0, binCount - 1)] += 1
  return {
    shotCount: shots.length,
    avgShotLength: round2(mean(lengths)),
    medianShotLength: round2(median(lengths)),
    shortestShot: round2(Math.min(...lengths)),
    longestShot: round2(Math.max(...lengths)),
    stdDev: round2(stddev(lengths)),
    cutRatePerMin: minutes > 0 ? round2(Math.max(0, shots.length - 1) / minutes) : null,
    cutsPer10s,
  }
}

/**
 * Decide the soundtrack role from the v1 audio report. Documented heuristics:
 * "rhythmic" = a confident beat grid; "speech" = the audio engine's vocal
 * heuristic or a supplied transcript. Without ASR the two cannot be separated
 * acoustically, so the result is a heuristic (said so in a warning).
 */
function determineSound({ structure, beatSync, warnings }) {
  const audio = structure.audio
  if (audio === null) {
    return { hasMusic: false, bpm: null, key: null, hasSpeech: false, speechKind: 'none', musicDb: null }
  }
  const loudness = audio.loudness !== null && typeof audio.loudness === 'object' ? audio.loudness : {}
  const tempo = audio.tempo !== null && typeof audio.tempo === 'object' ? audio.tempo : {}
  const vocals = audio.vocals !== null && typeof audio.vocals === 'object' ? audio.vocals : {}
  const lufs = parseNumber(loudness.lufsIntegrated)
  const rms = parseNumber(loudness.rmsDbfs)
  const silenceRatio = parseNumber(loudness.silenceRatio) ?? 0
  const level = lufs !== null ? lufs : rms
  const audible = level !== null ? level > -50 : silenceRatio < 0.9
  const rhythmic = (parseNumber(tempo.beatCount) ?? 0) >= 4 && (parseNumber(tempo.confidence) ?? 0) >= 0.3
  const transcriptText = structure.transcript !== null && typeof structure.transcript.text === 'string'
    ? structure.transcript.text.trim()
    : ''
  const speechFromVocals = vocals.present === true && (parseNumber(vocals.confidence) ?? 0) >= 0.6
  const hasSpeech = audible && (transcriptText.length > 0 || speechFromVocals)
  const hasMusic = audible && (rhythmic || !hasSpeech)
  if (hasSpeech && transcriptText.length === 0) {
    warnings.push('craft: speech detection comes from the acoustic vocal heuristic (the analysis carries no transcript); verify before reproducing dialogue/narration')
  }
  return {
    hasMusic,
    bpm: beatSync.bpm,
    key: audio.key !== null && typeof audio.key === 'object' && typeof audio.key.name === 'string' ? audio.key.name : null,
    hasSpeech,
    speechKind: hasSpeech ? 'narration' : 'none',
    musicDb: hasMusic ? round1(level) : null,
  }
}

/* ------------------------------------------------------------------ *
 * Recipe + Chinese reproduction notes
 * ------------------------------------------------------------------ */

function aspectRatioOf(width, height, rotation) {
  const sideways = rotation === 90 || rotation === 270
  const displayWidth = sideways ? height : width
  const displayHeight = sideways ? width : height
  if (!(displayWidth > 0) || !(displayHeight > 0)) return null
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(Math.round(displayWidth), Math.round(displayHeight)) || 1
  const w = Math.round(displayWidth / divisor)
  const h = Math.round(displayHeight / divisor)
  if (w > 32 || h > 32) return `${round2(displayWidth / displayHeight)}:1`
  return `${w}:${h}`
}

function displayDimensions(structure) {
  const sideways = structure.stream.rotation === 90 || structure.stream.rotation === 270
  return {
    width: sideways ? structure.stream.height : structure.stream.width,
    height: sideways ? structure.stream.width : structure.stream.height,
  }
}

function transitionInFor(kind) {
  if (kind === 'fade' || kind === 'dip-to-black') return 'fade'
  // 'cut' and 'other' both map to a hard cut: the builder's "cut" is the no-op
  // transition, which is the honest reproduction of a density-floor split.
  return 'cut'
}

function buildRecipe({ structure, craft, cameraMetrics, grading, palette, sound, notes }) {
  const dimensions = displayDimensions(structure)
  const aspect = structure.aspect ?? aspectRatioOf(dimensions.width, dimensions.height, 0)
  const shots = structure.shots.map((shot, index) => ({
    index: index + 1, // 1-based, matching the CONTRACT-V2 recipe example
    start: shot.start,
    end: shot.end,
    duration: shot.duration,
    camera: cameraMetrics[index] !== null && cameraMetrics[index] !== undefined ? cameraMetrics[index].motion : null,
    brightness: shot.brightness,
    palette: shot.palette.slice(0, 3).map((entry) => entry.hex),
    transitionIn: index === 0 ? 'cut' : transitionInFor(craft.transitions.list[index - 1]?.kind),
  }))
  const lookPalette = palette.length > 0
    ? palette
    : structure.dominantHues.map((entry) => entry.hex)
  return {
    schema: RECIPE_SCHEMA,
    duration: structure.duration > 0 ? structure.duration : null,
    aspect,
    resolution: { width: dimensions.width, height: dimensions.height },
    fps: structure.stream.fps > 0 ? structure.stream.fps : null,
    shots,
    look: {
      palette: lookPalette,
      grading: grading.signature,
      temperature: grading.temperature,
      textDensity: craft.overlays.textDensity,
      titleCard: craft.titleCard.present === true ? craft.titleCard.style : null,
    },
    sound,
    pacing: {
      avgShotLength: craft.cutRhythm.avgShotLength,
      cutRatePerMin: craft.cutRhythm.cutRatePerMin,
      beatSync: craft.beatSync.cutsOnBeatRatio,
    },
    reproductionNotes: notes,
  }
}

const STYLE_ZH = {
  'centered-white-on-dark': '居中白字压深色底',
  'centered-white-on-bright': '居中白字压亮色底',
  'centered-white-on-flat': '居中白字压纯色底',
}

function describeOrientation(aspect, width, height) {
  if (!(width > 0) || !(height > 0)) return '画幅'
  const ratio = width / height
  const label = aspect ?? '未知画幅'
  if (ratio >= 1.45) return `横屏 ${label}`
  if (ratio <= 0.85) return `竖屏 ${label}`
  return `近方形 ${label}`
}

/**
 * 3–6 executable Chinese notes derived from the actual measurements. This is the
 * text the model learns the technique from, so every sentence quotes the numbers
 * that were measured instead of generic advice.
 */
function buildReproductionNotes({ structure, craft, cameraMetrics, grading, palette, sound, titleCard }) {
  const notes = []
  const shots = structure.shots
  const shotCount = shots.length
  const rhythm = craft.cutRhythm
  const transitions = craft.transitions
  const overlays = craft.overlays
  const beatSync = craft.beatSync
  const dimensions = displayDimensions(structure)
  const aspect = structure.aspect ?? aspectRatioOf(dimensions.width, dimensions.height, 0)
  const fps = structure.stream.fps
  const duration = structure.duration

  /* 1. Cut rhythm. */
  const shortest = rhythm.shortestShot ?? 1
  const longest = rhythm.longestShot ?? shortest
  const spread = longest - shortest
  if (shotCount === 0) {
    notes.push(`成片时长对齐原片的 ${describeSeconds(duration)}，用单张图或单色场铺满，不做切点。`)
  } else if (shotCount === 1) {
    notes.push(`用 1 个镜头撑满 ${describeSeconds(duration)}（镜头长约 ${describeSeconds(shots[0].duration)}），中间不要切。`)
  } else if (rhythm.avgShotLength !== null && spread < 0.5) {
    notes.push(
      `每 ${describeSeconds(rhythm.avgShotLength)}左右硬切一次，全片 ${shotCount} 个镜头等长，约 ${rhythm.cutRatePerMin} 次/分。`,
    )
  } else if (rhythm.avgShotLength !== null && rhythm.avgShotLength <= 4) {
    notes.push(
      `每 ${Math.max(1, round2(shortest))}–${round2(longest)} 秒切一次，全片 ${shotCount} 个镜头，保持约 ${rhythm.cutRatePerMin} 次/分的切换密度。`,
    )
  } else if (rhythm.avgShotLength !== null) {
    notes.push(`慢节奏：全片 ${shotCount} 个镜头、平均每镜 ${describeSeconds(rhythm.avgShotLength)}，镜头尽量拉长，整片只切 ${Math.max(0, shotCount - 1)} 刀。`)
  }

  /* 2. Camera motion. */
  const measuredCameras = cameraMetrics.filter((metrics) => metrics !== null && metrics !== undefined)
  if (measuredCameras.length > 0) {
    const active = measuredCameras
      .map((metrics, index) => ({ ...metrics, shotIndex: index }))
      .filter((metrics) => metrics.motion !== 'static')
    if (active.length === 0) {
      notes.push('所有镜头都用固定机位，画面几乎不动（全局位移小于 0.3 像素/帧），不要加推拉摇移。')
    } else {
      const described = active
        .slice(0, 3)
        .map((metrics) => `镜头 ${metrics.shotIndex + 1} ${MOTION_ZH[metrics.motion] ?? metrics.motion}（强度 ${metrics.intensity}）`)
        .join('、')
      notes.push(`${described}；其余镜头保持固定机位。`)
    }
  }

  /* 3. Transition style. */
  if (transitions.list.length > 0) {
    const kinds = transitions.list.map((entry) => entry.kind)
    const hardCuts = kinds.filter((kind) => kind === 'cut').length
    const dips = kinds.filter((kind) => kind === 'dip-to-black').length
    const fades = kinds.filter((kind) => kind === 'fade').length
    if (hardCuts === kinds.length) {
      notes.push('镜头之间全部用硬切，不加淡入淡出或其他转场。')
    } else if (dips > 0) {
      const at = transitions.list.find((entry) => entry.kind === 'dip-to-black')?.at
      notes.push(`在 ${formatTimecode(at)} 附近用约 0.3–0.5 秒的黑场淡出淡入接镜头，其余 ${hardCuts} 处硬切。`)
    } else if (fades > 0) {
      notes.push(`有 ${fades} 处用约 0.4–0.6 秒的交叉淡化转场，其余镜头硬切。`)
    } else {
      notes.push(`转场以 ${transitions.list[0].kind} 为主，硬切 ${hardCuts} 处。`)
    }
  }

  /* 4. Colour grading. */
  if (grading.contrast !== null) {
    const traits = []
    if (grading.signature?.includes('high-contrast')) traits.push('高对比')
    else if (grading.signature?.includes('low-contrast')) traits.push('低对比、灰平')
    if (grading.signature?.includes('desaturated')) traits.push('低饱和')
    if (grading.signature?.includes('teal-orange')) traits.push('青橙互补')
    if (grading.temperature === 'warm') traits.push('整体偏暖')
    else if (grading.temperature === 'cool') traits.push('整体偏冷')
    const tints = []
    if (grading.shadowTint !== null && grading.shadowTint !== 'neutral') tints.push(`阴影偏${TINT_ZH[grading.shadowTint]}`)
    if (grading.highlightTint !== null && grading.highlightTint !== 'neutral') tints.push(`高光偏${TINT_ZH[grading.highlightTint]}`)
    notes.push(
      `按原片调色：${traits.length > 0 ? traits.join('、') : '自然中性色'}（对比度 ${grading.contrast}、饱和度 ${grading.saturation}` +
        `${tints.length > 0 ? `，${tints.join('、')}` : ''}）。`,
    )
  } else {
    notes.push('调色按原片关键帧取色，保持统一白平衡和整体色调。')
  }

  /* 5. Beat sync. */
  if (beatSync.cutsOnBeatRatio !== null && beatSync.cutsOnBeatRatio >= 0.6 && beatSync.bpm !== null) {
    notes.push(
      `按 ${beatSync.bpm} BPM 卡点：${Math.round(beatSync.cutsOnBeatRatio * 100)}% 的切点落在拍点上（平均偏差 ${beatSync.meanOffsetMs} ms）。`,
    )
  } else if (beatSync.bpm !== null) {
    notes.push(`配乐约 ${beatSync.bpm} BPM，但切点不刻意卡拍，按叙事节奏剪。`)
  } else if (sound.hasMusic) {
    notes.push('配乐没有稳定节拍，不要卡点，按画面和叙事节奏切。')
  }

  /* 6. Title card. */
  if (titleCard.present === true) {
    const style = titleCard.style !== null ? STYLE_ZH[titleCard.style] ?? `版式 ${titleCard.style}` : '居中大字标题'
    notes.push(`开场先放标题卡：${style}，持续约 ${describeSeconds(titleCard.duration)}，随后硬切进正片。`)
  }

  /* 7. Sound role. */
  if (sound.hasSpeech && sound.hasMusic) {
    notes.push(`人声/旁白在前，配乐只做背景（约 ${sound.musicDb ?? -20} dBFS），混音时压低音乐、不要盖住人声。`)
  } else if (sound.hasSpeech) {
    notes.push('全程以人声/旁白推进，不加配乐或只垫很轻的环境声。')
  } else if (sound.hasMusic) {
    notes.push(`用一条配乐铺满全片，音量约 ${sound.musicDb ?? -20} dBFS，让音乐承担情绪。`)
  } else if (structure.audio !== null) {
    notes.push('保留环境声即可，不要强行加音乐或旁白。')
  }

  /* 8. Overlay / subtitle layer. */
  if (overlays.textDensity !== null && overlays.textDensity >= 0.25) {
    notes.push(`保留画面文字层：约 ${Math.round(overlays.textDensity * 100)}% 的采样帧在上/下文字条检出内容，标题居中、字幕贴底。`)
  }

  /* 9. Output format. */
  notes.push(
    `成片按 ${describeOrientation(aspect, dimensions.width, dimensions.height)}、${dimensions.width}×${dimensions.height}` +
      `${fps > 0 ? `、${fps} fps` : ''} 输出，画幅比例对齐原片。`,
  )

  /* 10. Structure. */
  if (craft.sections.length >= 2) {
    const journey = craft.sections
      .map((section) => `${ROLE_ZH[section.role] ?? section.role} ${formatTimecode(section.start)}–${formatTimecode(section.end)}`)
      .join(' → ')
    notes.push(`按原片结构复刻：${journey}。`)
  }

  /* Keep 3–6 notes: the list above is ordered by importance. */
  const fallbacks = [
    `全片 ${describeSeconds(duration)}、${shotCount === 0 ? 1 : shotCount} 个镜头，复刻时先对齐总时长和镜头数。`,
    '按原片关键帧配色生成每个镜头的画面，整体色调保持一致。',
    '标题居中、字幕贴底，文字不要压到画面主体。',
  ]
  let index = 0
  while (notes.length < 3 && index < fallbacks.length) {
    notes.push(fallbacks[index])
    index += 1
  }
  return notes.slice(0, 6)
}

/* ------------------------------------------------------------------ *
 * Final JSON hygiene
 * ------------------------------------------------------------------ */

/**
 * Deep-copy into strictly JSON-safe data: non-finite numbers become `null`,
 * `undefined`/function entries are dropped. Every producer above already rounds
 * its numbers; this is the last line of defence against NaN/Infinity leaking out.
 */
function sanitise(value) {
  if (value === null) return null
  if (Array.isArray(value)) {
    const array = []
    for (const item of value) {
      const clean = sanitise(item)
      if (clean !== undefined) array.push(clean)
    }
    return array
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'object') {
    const object = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') continue
      const clean = sanitise(item)
      if (clean !== undefined) object[key] = clean
    }
    return object
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Analyse how a video was produced, from its v1 `VideoAnalysis`.
 *
 * @param {object} params
 * @param {{ffmpeg: string, ffprobe: string}} [params.tools]  from resolveTools(); resolved when omitted
 * @param {string} params.file       absolute input path
 * @param {string} [params.workDir]  absolute scratch dir; a private temp dir is created when omitted
 * @param {object} params.analysis   the v1 analyzeVideo() return value
 * @param {string} [params.artifactDir]  optional dir for the `craft.json` snapshot
 * @param {{lowResFrames?: boolean, maxSamples?: number}} [params.options]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{craft: object, recipe: object}>} strictly JSON-serialisable
 */
export async function analyzeCraft({ tools, file, workDir, analysis, artifactDir, options = {}, signal } = {}) {
  throwIfAborted(signal)
  const opts = normaliseOptions(options)
  const warnings = []

  /* 0. Arguments: a missing analysis is fatal, everything else is normalised. */
  if (typeof file !== 'string' || file.trim().length === 0) {
    throw new Error('analyzeCraft: file path is required')
  }
  const inputPath = resolve(file.trim())
  let resolvedTools = tools
  if (resolvedTools === null || typeof resolvedTools !== 'object' || typeof resolvedTools.ffmpeg !== 'string' || typeof resolvedTools.ffprobe !== 'string') {
    resolvedTools = await resolveTools()
  }
  let workRoot = workDir
  if (typeof workRoot !== 'string' || workRoot.trim().length === 0) {
    workRoot = await makeWorkDir('ms-craft')
  }
  workRoot = resolve(workRoot.trim())
  try {
    await mkdir(workRoot, { recursive: true })
  } catch (error) {
    throw new Error(`analyzeCraft: workDir is not usable (${errorMessage(error)})`)
  }

  const structure = normaliseAnalysis(analysis, warnings)

  /* 0b. Fill a missing duration / resolution from a cheap probe. */
  if (structure.duration <= 0 || structure.stream.width <= 0) {
    try {
      const info = summariseProbe(await probe(resolvedTools, inputPath, { signal }))
      if (structure.duration <= 0 && info.duration > 0) structure.duration = round2(info.duration)
      if (structure.stream.width <= 0 && info.video.length > 0) {
        structure.stream.width = Math.round(info.video[0].width)
        structure.stream.height = Math.round(info.video[0].height)
        if (structure.stream.fps <= 0) structure.stream.fps = round2(info.video[0].fps)
        structure.stream.rotation = Math.round(info.video[0].rotation)
      }
    } catch (error) {
      if (isAbort(error, signal)) throw abortError()
      warnings.push(`craft: could not probe the input to fill missing stream facts (${errorMessage(error)})`)
    }
  }
  if (structure.audio === null) {
    warnings.push('craft: the analysis carries no audio report, so beat sync and soundtrack role fields are null')
  }
  if (structure.duration > 0 && structure.duration < 2) {
    warnings.push(`craft: the clip is only ${describeSeconds(structure.duration)} long; cut rhythm, transition and camera statistics are weak`)
  }
  if (structure.shots.length === 0) {
    warnings.push('craft: the analysis reported no shots; shot-dependent craft fields are null')
  } else if (structure.shots.length === 1) {
    warnings.push('craft: only one shot was detected; transition and section statistics are degenerate')
  }
  throwIfAborted(signal)

  /* 1. One gray decode pass -> camera motion + transition evidence. */
  const gray = await decodeGrayFrames({ tools: resolvedTools, file: inputPath, workDir: workRoot, signal, warnings })

  /* 1b. Frame-pair measurements, shared by camera motion, transitions and overlays. */
  const { measurements, cameraPairs } = computePairMeasurements({ gray, structure, warnings })
  const cameraMetrics = analyseCameraMetrics({ structure, measurements, cameraPairs })
  const camera = buildCameraEntries({ structure, cameraMetrics })
  const transitions = classifyTransitions({ gray, structure, measurements, warnings })
  throwIfAborted(signal)

  /* 2. One RGB pass -> grading, overlays, title-card style. */
  let rgbData = null
  if (opts.lowResFrames) {
    rgbData = await decodeRgbSamples({
      tools: resolvedTools,
      file: inputPath,
      workDir: workRoot,
      duration: structure.duration,
      options: opts,
      signal,
      warnings,
    })
    if (rgbData !== null && rgbData.samples.length < 3) {
      warnings.push(`craft: only ${rgbData.samples.length} RGB frame(s) were sampled; grading and overlay statistics are based on very little data`)
    }
  } else {
    warnings.push('craft: options.lowResFrames=false skipped the RGB pass; grading and overlay analysis are null')
  }
  const gradingResult = analyseGrading(rgbData, warnings)
  const overlays = analyseOverlays({ rgbData, gray, measurements, warnings })
  const titleCard = analyseTitleCard({ structure, rgbData, camera, warnings })
  throwIfAborted(signal)

  /* 3. Derived production facts. */
  const craftCore = {
    cutRhythm: computeCutRhythm(structure),
    transitions,
    camera,
    grading: gradingResult.metrics,
    overlays,
    hook: computeHook({ structure, camera, transitions, titleCard }),
    beatSync: computeBeatSync({ structure, transitions }),
    sections: computeSections({ structure, titleCard }),
    titleCard,
  }
  const sound = determineSound({ structure, beatSync: craftCore.beatSync, warnings })
  const notes = buildReproductionNotes({
    structure,
    craft: craftCore,
    cameraMetrics,
    grading: gradingResult.metrics,
    palette: gradingResult.palette,
    sound,
    titleCard,
  })
  const recipe = buildRecipe({
    structure,
    craft: craftCore,
    cameraMetrics,
    grading: gradingResult.metrics,
    palette: gradingResult.palette,
    sound,
    notes,
  })

  /* 4. Optional artifact snapshot: the craft report next to the other artifacts. */
  if (typeof artifactDir === 'string' && artifactDir.trim().length > 0) {
    try {
      const directory = resolve(artifactDir.trim())
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'craft.json'), `${JSON.stringify({ craft: { ...craftCore, warnings: [...warnings] }, recipe }, null, 2)}\n`, 'utf8')
    } catch (error) {
      warnings.push(`craft: could not write the craft.json artifact (${errorMessage(error)})`)
    }
  }

  const craft = sanitise({ ...craftCore, warnings: [...warnings] })
  return { craft, recipe: sanitise(recipe) }
}

export default { analyzeCraft }
