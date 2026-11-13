/**
 * Offline video perception engine for the media-senses plugin.
 *
 * Turns a video file into a JSON-serialisable "storyboard" a text-only model can
 * reason about. The pipeline is deliberately cheap and deterministic:
 *
 *  1. ffprobe for stream/container facts (`probe` + `summariseProbe`).
 *  2. ONE telemetry pass: `scale=<h>:-2,signalstats,scdet=t=10,freezedetect,
 *     blackdetect` via `readFrameMetadata`. Gives per-frame brightness (YAVG),
 *     saturation (SATAVG), temporal difference (YDIF), motion (scd.mafd) and the
 *     freeze/black health events. Full-resolution frames are never decoded in JS.
 *  3. ONE scene-cut pass: `scale=<h>:-2,select='gt(scene,T)',metadata=print`.
 *     Hits are merged (0.5 s) and a density floor splits static stretches so a
 *     video without cuts still yields several keyframes.
 *  4. Per keyframe: one ffmpeg run writes a JPEG (longest side <= 640) and a
 *     44x20 RGB raw frame. The raw frame is rendered into luminance ASCII art,
 *     a hue-letter map, a 4-colour palette and a one-line layout description.
 *  5. One `tile` pass renders a content-sized contact sheet: fixed 480x270
 *     cells, `cols=min(4, n)` / `rows=ceil(n/cols)`, so there are no empty rows
 *     and every column is the same width. Timestamps are burned with drawtext
 *     when a font is available and skipped (with a warning) otherwise.
 *  6. The soundtrack is delegated to the injected `analyzeAudio`; this module
 *     never imports lib/audio.js itself (that would be a cycle). `transcript` is
 *     always null here — ASR/transcript merging belongs to the shell layer.
 *
 * Reading the art: ASCII uses the luminance ramp " .:-=+*#%@" (space darkest,
 * "@" brightest); the hue map uses R/O/Y/G/C/B/M for hue families and "." for
 * grey/black/white (matches the legend rendered by lib/render.js).
 *
 * Windows/filtergraph rule: side files and filtergraph arguments always use
 * paths relative to `cwd: workDir`; absolute paths appear only in ordinary
 * arguments such as `-i` and output file names. The one deliberate exception is
 * drawtext's `fontfile`, which needs an absolute font path escaped for BOTH the
 * filtergraph parser and drawtext's option parser (see `resolveFontArgument`).
 *
 * Robustness: every optional stage is wrapped so a missing audio stream, a
 * one-second clip, a static video, a corrupt-but-probeable file or a missing
 * audio engine degrades to `warnings: [...]`. Static/flat spans are reported as
 * a freeze *measurement* plus a warning that this is normal for title cards and
 * slides. Only a file that cannot be probed at all (or a non-video file) throws.
 */

import { access, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  artifactDir,
  escapeFilterPath,
  formatTimecode,
  probe,
  readFrameMetadata,
  run,
  summariseProbe,
} from './ffmpeg.js'

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Luminance ramp, darkest -> brightest. 10 levels keeps the art compact. */
const ASCII_RAMP = ' .:-=+*#%@'
const KEYFRAME_ART_WIDTH = 44
const KEYFRAME_ART_HEIGHT = 20
const KEYFRAME_RGB_BYTES = KEYFRAME_ART_WIDTH * KEYFRAME_ART_HEIGHT * 3
const SHEET_COLUMNS = 4
const SHEET_ROWS = 3
/** At most 12 cells per sheet (4x3). */
const SHEET_CELLS = SHEET_COLUMNS * SHEET_ROWS
/** Fixed contact-sheet cell size; every column ends up the same width. */
const SHEET_CELL_WIDTH = 480
const SHEET_CELL_HEIGHT = 270
/** Time in s below which two scene changes are considered the same event. */
const CUT_MERGE_SECONDS = 0.5
/** Shortest shot the engine is willing to report (merged into a neighbour). */
const MIN_SHOT_SECONDS = 0.4
/** Edge-density threshold for `likelyTextHeavy` (0..1 Sobel magnitude scale). */
const TEXT_HEAVY_EDGE_DENSITY = 0.02
/** Motion threshold for "almost still" footage (scd.mafd units, 0..100). */
const LOW_MOTION = 3

const HUE_FAMILIES = [
  { name: 'orange', min: 15, max: 45, hex: '#f08c00', letter: 'O' },
  { name: 'yellow', min: 45, max: 70, hex: '#f0c419', letter: 'Y' },
  { name: 'green', min: 70, max: 165, hex: '#2f9e44', letter: 'G' },
  { name: 'cyan', min: 165, max: 195, hex: '#15aabf', letter: 'C' },
  { name: 'blue', min: 195, max: 265, hex: '#1971c2', letter: 'B' },
  { name: 'magenta', min: 265, max: 345, hex: '#c2259e', letter: 'M' },
]
const RED_FAMILY = { name: 'red', hex: '#e03131', letter: 'R' }
// Grey/black/white pixels map to '.' in the hue map; lib/render.js documents
// exactly that legend (the contract wrote "M/P for grey", but the shell
// renderer's legend uses '.').
const GREY_FAMILY = { name: 'grey', hex: '#868e96', letter: '.' }

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/calibri.ttf',
]
let resolvedFontArgument

/* ------------------------------------------------------------------ *
 * Small numeric / formatting helpers
 * ------------------------------------------------------------------ */

/** Round to `digits` decimals; non-finite input collapses to 0. */
function round(value, digits) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const round1 = (value) => round(value, 1)
const round2 = (value) => round(value, 2)
const round3 = (value) => round(value, 3)

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function mean(values) {
  if (values.length === 0) return 0
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

function stddev(values) {
  if (values.length === 0) return 0
  const average = mean(values)
  let sum = 0
  for (const value of values) sum += (value - average) ** 2
  return Math.sqrt(sum / values.length)
}

/** Parse a metadata string into a finite number, else null. */
function parseNumber(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function errorMessage(error) {
  if (error instanceof Error) return error.message.split(/\r?\n/u)[0]
  return String(error)
}

function abortError() {
  const error = new Error('media-senses: video analysis aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError()
}

function isAbort(error, signal) {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

/* ------------------------------------------------------------------ *
 * Colour helpers (shared by the hue map, palettes and global stats)
 * ------------------------------------------------------------------ */

/** Convert an average Y'UV triple to RGB (BT.601, limited->full range). */
function yuvToRgb(y, u, v) {
  const cb = u - 128
  const cr = v - 128
  return [
    clamp(y + 1.402 * cr, 0, 255),
    clamp(y - 0.344136 * cb - 0.714136 * cr, 0, 255),
    clamp(y + 1.772 * cb, 0, 255),
  ]
}

/** RGB -> {hue 0..360, saturation 0..1, value 0..1}. */
function rgbToHsv(red, green, blue) {
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const chroma = max - min
  const value = max / 255
  if (chroma === 0) return { hue: 0, saturation: 0, value }
  const saturation = max === 0 ? 0 : chroma / max
  let hue
  if (max === red) hue = ((green - blue) / chroma) % 6
  else if (max === green) hue = (blue - red) / chroma + 2
  else hue = (red - green) / chroma + 4
  hue *= 60
  if (hue < 0) hue += 360
  return { hue, saturation, value }
}

/**
 * Reconstruct a hue from the signalstats mean Y/U/V plane. Using the YUV means
 * is more reliable than the signalstats HUEMED angle, whose convention is not
 * the standard HSV wheel (red reports ~161 there).
 */
function hueFromYuv(y, u, v) {
  const [red, green, blue] = yuvToRgb(y, u, v)
  const { hue, saturation } = rgbToHsv(red, green, blue)
  if (saturation < 0.1) return null
  return { hue, saturation }
}

/** Circular (saturation-weighted) mean of hue entries, or null when empty. */
function circularHueMean(entries) {
  let x = 0
  let y = 0
  let total = 0
  for (const entry of entries) {
    if (entry.weight <= 0 || !Number.isFinite(entry.hue)) continue
    const radians = (entry.hue * Math.PI) / 180
    x += Math.cos(radians) * entry.weight
    y += Math.sin(radians) * entry.weight
    total += entry.weight
  }
  if (total <= 0) return null
  const degrees = (Math.atan2(y, x) * 180) / Math.PI
  return (degrees + 360) % 360
}

/** Classify a hue into one of the contract's hue families. */
function classifyHue(hue) {
  for (const family of HUE_FAMILIES) {
    if (hue >= family.min && hue < family.max) return family
  }
  return RED_FAMILY
}

function rgbHex(red, green, blue) {
  return `#${[red, green, blue]
    .map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, '0'))
    .join('')}`
}

/** HSL -> hex string (used for representative shot colours). */
function hueHex(hue, saturation = 0.68, lightness = 0.5) {
  const h = ((Number.isFinite(hue) ? hue : 0) % 360 + 360) % 360 / 360
  const s = clamp(saturation, 0, 1)
  const l = clamp(lightness, 0, 1)
  if (s === 0) {
    const grey = Math.round(l * 255)
    return rgbHex(grey, grey, grey)
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t) => {
    let temp = t
    if (temp < 0) temp += 1
    if (temp > 1) temp -= 1
    if (temp < 1 / 6) return p + (q - p) * 6 * temp
    if (temp < 1 / 2) return q
    if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6
    return p
  }
  return rgbHex(channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255)
}

/* ------------------------------------------------------------------ *
 * Options and analysis region
 * ------------------------------------------------------------------ */

function positiveNumber(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return clamp(parsed, min, max)
}

function normaliseOptions(options) {
  return {
    maxSeconds: positiveNumber(options.maxSeconds, 1800, 0.1, 86_400),
    start: Math.max(0, positiveNumber(options.start, 0, 0, 86_400)),
    sceneThreshold: positiveNumber(options.sceneThreshold, 0.3, 0.02, 0.95),
    maxKeyframes: Math.round(positiveNumber(options.maxKeyframes, 40, 1, 200)),
    analysisHeight: Math.round(positiveNumber(options.analysisHeight, 160, 32, 720)),
    densityFloorSeconds: positiveNumber(options.densityFloorSeconds, 25, 1, 3600),
    wantContactSheet: options.wantContactSheet !== false,
    wantFrames: options.wantFrames !== false,
    wantAudio: options.wantAudio !== false,
    artifactDir: typeof options.artifactDir === 'string' ? options.artifactDir : undefined,
  }
}

/**
 * Resolve the analysed time window. `duration` is the container duration when
 * known; otherwise the window is `maxSeconds` and ffmpeg stops at EOF.
 */
function resolveRegion(fileDuration, options, warnings) {
  const known = Number.isFinite(fileDuration) && fileDuration > 0
  let start = options.start
  if (known) {
    if (start >= fileDuration - 0.05) {
      warnings.push(
        `start=${round2(options.start)} s is at/after the end of the ${round2(fileDuration)} s file; the final moments are analysed instead`,
      )
      start = Math.max(0, fileDuration - 0.05)
    }
    start = Math.min(start, Math.max(0, fileDuration - 0.05))
    if (options.maxSeconds < fileDuration - start - 0.01) {
      warnings.push(`analysis limited to the first ${round2(options.maxSeconds)} s of the selected window (maxSeconds)`)
    }
  } else {
    warnings.push('container duration is unknown; the analysis window was capped at maxSeconds')
  }
  const available = known ? fileDuration - start : Number.POSITIVE_INFINITY
  return { start: round2(start), duration: round2(Math.max(0.04, Math.min(available, options.maxSeconds))) }
}

/** `-ss` / `-t` as INPUT options (placed before `-i`); timestamps restart at 0. */
function regionInputArgs(region) {
  const args = []
  if (region.start > 0) args.push('-ss', String(round2(region.start)))
  if (region.duration > 0) args.push('-t', String(round2(region.duration)))
  return args
}

/* ------------------------------------------------------------------ *
 * Telemetry, cuts and health events
 * ------------------------------------------------------------------ */

function telemetryFilter(height) {
  return [
    `scale=${height}:-2`,
    'signalstats',
    // Detect scene-change scores per frame; the score/mafd metadata is what we use.
    'scdet=t=10',
    'freezedetect=n=0.001:d=2',
    'blackdetect=d=2:pic_th=0.98:pix_th=0.10',
  ].join(',')
}

async function fetchTelemetry(tools, file, workDir, region, options, signal) {
  return readFrameMetadata(tools, file, {
    filter: telemetryFilter(options.analysisHeight),
    workDir,
    signal,
    extraInputArgs: regionInputArgs(region),
  })
}

async function fetchCutFrames(tools, file, workDir, region, threshold, options, signal) {
  return readFrameMetadata(tools, file, {
    filter: `scale=${options.analysisHeight}:-2,select='gt(scene,${threshold})'`,
    workDir,
    signal,
    extraInputArgs: regionInputArgs(region),
  })
}

/** Collapse raw telemetry into a per-frame sample with derived colour facts. */
function deriveSample(frame) {
  const meta = frame.meta
  const y = parseNumber(meta['lavfi.signalstats.YAVG'])
  const saturation = parseNumber(meta['lavfi.signalstats.SATAVG'])
  const u = parseNumber(meta['lavfi.signalstats.UAVG'])
  const v = parseNumber(meta['lavfi.signalstats.VAVG'])
  const hueInfo = y !== null && u !== null && v !== null ? hueFromYuv(y, u, v) : null
  return {
    t: Number.isFinite(frame.ptsTime) ? frame.ptsTime : 0,
    frame: Number.isFinite(frame.frame) ? frame.frame : 0,
    y: clamp(y ?? 0, 0, 255),
    sat: clamp(saturation ?? 0, 0, 255),
    ymin: parseNumber(meta['lavfi.signalstats.YMIN']) ?? 0,
    ymax: parseNumber(meta['lavfi.signalstats.YMAX']) ?? 0,
    ydif: Math.max(0, parseNumber(meta['lavfi.signalstats.YDIF']) ?? 0),
    mafd: clamp(parseNumber(meta['lavfi.scd.mafd']) ?? 0, 0, 100),
    hue: hueInfo === null ? null : hueInfo.hue,
    hueSat: hueInfo === null ? 0 : hueInfo.saturation,
  }
}

/** Merge scene-change hits within CUT_MERGE_SECONDS and keep their best score. */
function mergeCutTimes(cutFrames, duration) {
  const cuts = []
  for (const frame of cutFrames) {
    const time = frame.ptsTime
    if (!Number.isFinite(time) || time <= MIN_SHOT_SECONDS) continue
    if (time > duration - MIN_SHOT_SECONDS) continue
    const score = parseNumber(frame.meta['lavfi.scene_score']) ?? 0
    const previous = cuts[cuts.length - 1]
    if (previous !== undefined && time - previous.t < CUT_MERGE_SECONDS) {
      previous.score = Math.max(previous.score, round3(score))
      continue
    }
    cuts.push({ t: round2(time), score: round3(score) })
  }
  return cuts
}

/**
 * Turn cut times plus a density floor into shot intervals.
 *
 * The floor splits long stretches without cuts into <= densityFloorSeconds
 * chunks (raised when needed so a static video does not exceed maxKeyframes
 * shots). Shot boundaries closer than MIN_SHOT_SECONDS are collapsed.
 */
function buildShotIntervals(duration, cuts, options) {
  const safeDuration = Math.max(0.04, duration)
  const effectiveFloor = Math.max(options.densityFloorSeconds, safeDuration / options.maxKeyframes)
  const boundaries = [0]
  for (const cut of cuts) {
    if (cut.t > MIN_SHOT_SECONDS && cut.t < safeDuration - MIN_SHOT_SECONDS) boundaries.push(cut.t)
  }
  boundaries.push(safeDuration)
  boundaries.sort((a, b) => a - b)

  const collapsed = []
  for (const boundary of boundaries) {
    const previous = collapsed[collapsed.length - 1]
    if (previous === undefined || boundary - previous >= MIN_SHOT_SECONDS) collapsed.push(boundary)
  }
  if (collapsed.length > 1 && safeDuration - collapsed[collapsed.length - 1] < MIN_SHOT_SECONDS) {
    collapsed[collapsed.length - 1] = safeDuration
  }
  if (collapsed.length === 0) collapsed.push(0, safeDuration)

  const withFloor = [collapsed[0]]
  for (let index = 0; index < collapsed.length - 1; index += 1) {
    let cursor = collapsed[index] + effectiveFloor
    while (cursor < collapsed[index + 1] - MIN_SHOT_SECONDS) {
      withFloor.push(round2(cursor))
      cursor += effectiveFloor
    }
    withFloor.push(collapsed[index + 1])
  }

  const intervals = []
  for (let index = 0; index < withFloor.length - 1; index += 1) {
    const start = withFloor[index]
    const end = withFloor[index + 1]
    if (end - start >= MIN_SHOT_SECONDS / 2) intervals.push({ start, end })
  }
  if (intervals.length === 0) intervals.push({ start: 0, end: safeDuration })
  return intervals
}

/** Collect freeze/black intervals from the telemetry metadata events. */
function parseHealthEvents(frames, analysisStart, region) {
  const frozen = []
  const black = []
  let freezeStart = null
  let blackStart = null
  let lastTime = 0
  for (const frame of frames) {
    const meta = frame.meta
    const time = Number.isFinite(frame.ptsTime) ? frame.ptsTime : 0
    lastTime = Math.max(lastTime, time)
    const freezeStarted = parseNumber(meta['lavfi.freezedetect.freeze_start'])
    if (freezeStarted !== null) freezeStart = freezeStarted
    const freezeEnded = parseNumber(meta['lavfi.freezedetect.freeze_end'])
    if (freezeEnded !== null) {
      frozen.push({ start: freezeStart ?? freezeEnded, end: freezeEnded })
      freezeStart = null
    }
    const blackStarted = parseNumber(meta['lavfi.black_start'])
    if (blackStarted !== null) blackStart = blackStarted
    const blackEnded = parseNumber(meta['lavfi.black_end'])
    if (blackEnded !== null) {
      black.push({ start: blackStart ?? blackEnded, end: blackEnded })
      blackStart = null
    }
  }
  // An interval still open at EOF runs to the end of the analysed window.
  if (freezeStart !== null) frozen.push({ start: freezeStart, end: lastTime })
  if (blackStart !== null) black.push({ start: blackStart, end: lastTime })
  return {
    frozen: normaliseIntervals(frozen, analysisStart, region),
    black: normaliseIntervals(black, analysisStart, region),
  }
}

/** Clip to the analysis window, drop degenerate entries and merge neighbours. */
function normaliseIntervals(raw, analysisStart, region) {
  const clipped = []
  for (const interval of raw) {
    const start = clamp(interval.start, 0, region.duration)
    const end = clamp(interval.end, start, region.duration)
    if (end - start < 0.2) continue
    clipped.push({ start: round2(analysisStart + start), end: round2(analysisStart + end) })
  }
  clipped.sort((a, b) => a.start - b.start)
  const merged = []
  for (const interval of clipped) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && interval.start - previous.end <= 0.2) {
      previous.end = Math.max(previous.end, interval.end)
      continue
    }
    merged.push({ ...interval })
  }
  return merged
}

/* ------------------------------------------------------------------ *
 * Keyframe pixels: ASCII + hue map + palette + layout
 * ------------------------------------------------------------------ */

/** One keyframe's 44x20 RGB buffer -> all the text/colour perception fields. */
function analyseKeyframePixels(buffer) {
  const width = KEYFRAME_ART_WIDTH
  const height = KEYFRAME_ART_HEIGHT
  const count = width * height
  const red = new Float64Array(count)
  const green = new Float64Array(count)
  const blue = new Float64Array(count)
  const luma = new Float64Array(count)
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3
    const r = buffer[offset]
    const g = buffer[offset + 1]
    const b = buffer[offset + 2]
    red[index] = r
    green[index] = g
    blue[index] = b
    luma[index] = 0.299 * r + 0.587 * g + 0.114 * b
  }

  const asciiRows = []
  const hueRows = []
  for (let row = 0; row < height; row += 1) {
    let ascii = ''
    let hueMap = ''
    for (let column = 0; column < width; column += 1) {
      const index = row * width + column
      ascii += ASCII_RAMP[Math.min(ASCII_RAMP.length - 1, Math.floor((luma[index] / 255) * ASCII_RAMP.length))]
      const hsv = rgbToHsv(red[index], green[index], blue[index])
      hueMap += hsv.saturation < 0.15 || hsv.value < 0.08 ? GREY_FAMILY.letter : classifyHue(hsv.hue).letter
    }
    asciiRows.push(ascii.trimEnd())
    hueRows.push(hueMap)
  }

  const hueEntries = []
  const familyCounts = Object.create(null)
  let coloured = 0
  let saturationSum = 0
  for (let index = 0; index < count; index += 1) {
    const hsv = rgbToHsv(red[index], green[index], blue[index])
    saturationSum += hsv.saturation
    if (hsv.saturation < 0.15 || hsv.value < 0.08) continue
    const family = classifyHue(hsv.hue)
    familyCounts[family.name] = (familyCounts[family.name] ?? 0) + 1
    coloured += 1
    hueEntries.push({ hue: hsv.hue, weight: hsv.saturation * Math.max(0.1, hsv.value) })
  }

  return {
    ascii: asciiRows.join('\n'),
    hueMap: hueRows.join('\n'),
    palette: buildPalette(red, green, blue, count),
    layout: describeLayout(luma, width, height),
    edgeDensity: round3(sobelDensity(luma, width, height)),
    colorfulness: round1(haslerSusstrunk(red, green, blue, count)),
    meanHue: circularHueMean(hueEntries),
    meanSaturation: saturationSum / count,
    familyCounts,
    coloured,
  }
}

/**
 * Quantise to a 4x4x4 RGB cube, keep the heaviest buckets, merge visually close
 * ones and return at most four colours with their pixel shares.
 */
function buildPalette(red, green, blue, count) {
  const buckets = new Map()
  for (let index = 0; index < count; index += 1) {
    const key = ((red[index] >> 6) << 4) | ((green[index] >> 6) << 2) | (blue[index] >> 6)
    const bucket = buckets.get(key)
    if (bucket === undefined) {
      buckets.set(key, { count: 1, r: red[index], g: green[index], b: blue[index] })
    } else {
      bucket.count += 1
      bucket.r += red[index]
      bucket.g += green[index]
      bucket.b += blue[index]
    }
  }
  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count)
  const merged = []
  for (const bucket of sorted) {
    const colour = { r: bucket.r / bucket.count, g: bucket.g / bucket.count, b: bucket.b / bucket.count }
    let target = null
    for (const candidate of merged) {
      const distance = Math.hypot(candidate.r - colour.r, candidate.g - colour.g, candidate.b - colour.b)
      if (distance < 44) {
        target = candidate
        break
      }
    }
    if (target === null) {
      if (merged.length >= 4) continue
      merged.push({ ...colour, pixels: bucket.count })
      continue
    }
    const total = target.pixels + bucket.count
    target.r = (target.r * target.pixels + colour.r * bucket.count) / total
    target.g = (target.g * target.pixels + colour.g * bucket.count) / total
    target.b = (target.b * target.pixels + colour.b * bucket.count) / total
    target.pixels = total
  }
  return merged.map((entry) => ({
    hex: rgbHex(entry.r, entry.g, entry.b),
    share: round3(entry.pixels / count),
  }))
}

/** Mean Sobel gradient magnitude normalised to 0..1; a cheap edge-density proxy. */
function sobelDensity(luma, width, height) {
  let total = 0
  let samples = 0
  const at = (x, y) => luma[y * width + x]
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
      total += Math.hypot(gx, gy) / 4
      samples += 1
    }
  }
  return samples === 0 ? 0 : total / samples / 255
}

/** Hasler-Süsstrunk "colorfulness" (0..~150, clamped to 0..100 for the report). */
function haslerSusstrunk(red, green, blue, count) {
  let rgSum = 0
  let ybSum = 0
  for (let index = 0; index < count; index += 1) {
    rgSum += red[index] - green[index]
    ybSum += 0.5 * (red[index] + green[index]) - blue[index]
  }
  const rgMean = rgSum / count
  const ybMean = ybSum / count
  let rgVar = 0
  let ybVar = 0
  for (let index = 0; index < count; index += 1) {
    const rg = red[index] - green[index] - rgMean
    const yb = 0.5 * (red[index] + green[index]) - blue[index] - ybMean
    rgVar += rg * rg
    ybVar += yb * yb
  }
  const rgStd = Math.sqrt(rgVar / count)
  const ybStd = Math.sqrt(ybVar / count)
  const metric = Math.hypot(rgStd, ybStd) + 0.3 * Math.hypot(rgMean, ybMean)
  return clamp(metric, 0, 100)
}

/** Short English one-liner describing where the light/structure sits. */
function describeLayout(luma, width, height) {
  const meanRect = (x0, x1, y0, y1) => {
    let total = 0
    let count = 0
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        total += luma[y * width + x]
        count += 1
      }
    }
    return count === 0 ? 0 : total / count
  }
  const top = meanRect(0, width, 0, Math.round(height * 0.32))
  const bottom = meanRect(0, width, Math.round(height * 0.68), height)
  const left = meanRect(0, Math.round(width * 0.3), 0, height)
  const right = meanRect(Math.round(width * 0.7), width, 0, height)
  const centre = meanRect(
    Math.round(width * 0.28),
    Math.round(width * 0.72),
    Math.round(height * 0.2),
    Math.round(height * 0.8),
  )
  const whole = meanRect(0, width, 0, height)
  const centreArea = (Math.round(width * 0.72) - Math.round(width * 0.28)) *
    (Math.round(height * 0.8) - Math.round(height * 0.2))
  const border = (whole * width * height - centre * centreArea) / Math.max(1, width * height - centreArea)
  const spread = stddev(Array.from(luma))
  const clauses = []
  // A pure colour field has spread 0; a caption on a flat background lands
  // around 10-20, so "flat field" is reserved for genuinely textureless frames.
  if (spread >= 55) clauses.push('high contrast')
  else if (spread <= 10) clauses.push('flat field')
  else clauses.push('moderate contrast')
  const relative = (a, b) => (Math.max(a, b) <= 1 ? 0 : (b - a) / Math.max(a, b))
  const vertical = relative(top, bottom)
  if (vertical > 0.15) clauses.push('bottom brighter than top')
  else if (vertical < -0.15) clauses.push('top brighter than bottom')
  else clauses.push('even top-to-bottom')
  const horizontal = relative(left, right)
  if (horizontal > 0.15) clauses.push('right brighter than left')
  else if (horizontal < -0.15) clauses.push('left brighter than right')
  else clauses.push('even left-to-right')
  if (centre > border * 1.25) clauses.push('bright centre')
  else if (centre < border * 0.8) clauses.push('dark centre')
  return clauses.join(' / ')
}

/* ------------------------------------------------------------------ *
 * Keyframe + contact-sheet ffmpeg stages
 * ------------------------------------------------------------------ */

/** Long edge <= 640 without upscaling; 44x20 RGB for the text perception pass. */
const KEYFRAME_GRAPH =
  `[0:v]split=2[big][small];` +
  `[big]scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease[bigq];` +
  `[small]scale=${KEYFRAME_ART_WIDTH}:${KEYFRAME_ART_HEIGHT},format=rgb24[smallq]`

/**
 * Extract one JPEG + one raw RGB frame in a single ffmpeg run (two outputs of
 * one split input). Runs with cwd=workDir and only the JPEG output is absolute.
 */
async function extractKeyframe(tools, file, workDir, keyframesDir, shotIndex, time, options, signal) {
  const stem = `keyframe-${String(shotIndex).padStart(3, '0')}`
  const rgbName = `${stem}.rgb`
  const jpegPath = options.wantFrames ? join(keyframesDir, `${stem}.jpg`) : null
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(round2(time)),
    '-i', file,
    '-filter_complex', KEYFRAME_GRAPH,
  ]
  if (jpegPath !== null) args.push('-map', '[bigq]', '-frames:v', '1', '-q:v', '4', jpegPath)
  args.push('-map', '[smallq]', '-frames:v', '1', '-f', 'rawvideo', rgbName)
  const result = await run(tools.ffmpeg, args, { cwd: workDir, signal, timeoutMs: 120_000 })
  if (result.code !== 0) {
    throw new Error(`keyframe extraction failed at ${formatTimecode(time)}: ${errorMessage(result.stderr) || `exit ${result.code}`}`)
  }
  const buffer = await readFile(join(workDir, rgbName))
  if (buffer.length !== KEYFRAME_RGB_BYTES) {
    throw new Error(`keyframe decode returned ${buffer.length} bytes instead of ${KEYFRAME_RGB_BYTES}`)
  }
  let savedJpeg = null
  if (jpegPath !== null) {
    try {
      await access(jpegPath)
      savedJpeg = jpegPath
    } catch {
      savedJpeg = null
    }
  }
  return { buffer, jpegPath: savedJpeg }
}

/**
 * Resolve drawtext's font file argument. The absolute font path must survive two
 * parser levels (filtergraph then drawtext option parser), hence the double
 * escaping: `C:/x/y.ttf` -> `C\:/x/y.ttf` (filtergraph) -> `C\\:/x/y.ttf`.
 */
async function resolveFontArgument() {
  if (resolvedFontArgument !== undefined) return resolvedFontArgument
  resolvedFontArgument = null
  for (const candidate of FONT_CANDIDATES) {
    try {
      await access(candidate)
      resolvedFontArgument = escapeFilterPath(candidate).replaceAll('\\', '\\\\')
      return resolvedFontArgument
    } catch {
      // Try the next font; a missing font only disables contact-sheet captions.
    }
  }
  return resolvedFontArgument
}

function drawtextFilter(fontArgument) {
  // `%{pts\:hms}` needs one backslash for drawtext while the surrounding single
  // quotes stop the filtergraph parser from splitting on the colon.
  return `drawtext=fontfile=${fontArgument}:text='%{pts\\:hms}':fontcolor=white:fontsize=22:` +
    'x=10:y=10:box=1:boxcolor=black@0.55:boxborderw=4'
}

/**
 * Render one contact sheet per <=12 keyframes.
 *
 * Cells have a FIXED 480x270 size (aspect preserved, padded black) so every
 * column has the same width, and the tile grid is sized to the content
 * (`cols=min(4, n)`, `rows=ceil(n/cols)`) so no empty rows are produced. Frames
 * are selected by their telemetry frame number, i.e. the same seek window as the
 * telemetry pass.
 */
async function renderContactSheets(tools, file, workDir, outDir, entries, region, warnings, signal) {
  if (entries.length === 0) return []
  const fontArgument = await resolveFontArgument()
  if (fontArgument === null) {
    warnings.push('no usable font found; contact sheet cells are ordered by shot without timestamps')
  }
  const base =
    `scale=${SHEET_CELL_WIDTH}:${SHEET_CELL_HEIGHT}:force_original_aspect_ratio=decrease,` +
    `pad=${SHEET_CELL_WIDTH}:${SHEET_CELL_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`
  // Telemetry timestamps restart at 0 after an input `-ss`; shift them back so
  // the burned clock reads the real position in the file.
  const timeShift = region.start > 0 ? `,setpts=PTS+${round2(region.start)}/TB` : ''
  const sheetCount = Math.ceil(entries.length / SHEET_CELLS)
  const paths = []
  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex += 1) {
    const sheetEntries = entries.slice(sheetIndex * SHEET_CELLS, (sheetIndex + 1) * SHEET_CELLS)
    const terms = sheetEntries
      .map((entry) => entry.frameNumber)
      .filter((frameNumber) => Number.isFinite(frameNumber))
      .map((frameNumber) => `eq(n,${Math.max(0, Math.round(frameNumber))})`)
    if (terms.length === 0) continue
    const columns = Math.min(SHEET_COLUMNS, sheetEntries.length)
    const rows = Math.ceil(sheetEntries.length / columns)
    const tile = `tile=${columns}x${rows}:padding=4:margin=4`
    const sheetName = sheetCount === 1 ? 'sheet.png' : `sheet-${sheetIndex + 1}.png`
    const sheetPath = join(outDir, sheetName)
    const select = `select='${terms.join('+')}'`
    const runSheet = async (filter) => {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        ...regionInputArgs(region),
        '-i', file,
        '-an',
        '-vf', filter,
        '-frames:v', '1',
        sheetPath,
      ]
      throwIfAborted(signal)
      const result = await run(tools.ffmpeg, args, { cwd: workDir, signal, timeoutMs: 180_000 })
      if (result.code !== 0) throw new Error(errorMessage(result.stderr) || `exit ${result.code}`)
    }
    try {
      await runSheet(`${select},${base}${timeShift},${drawtextFilter(fontArgument)},${tile}`)
      paths.push(sheetPath)
    } catch (error) {
      if (isAbort(error, signal)) throw abortError()
      try {
        await runSheet(`${select},${base},${tile}`)
        paths.push(sheetPath)
        warnings.push('contact sheet timestamps are disabled (drawtext failed)')
      } catch (fallbackError) {
        if (isAbort(fallbackError, signal)) throw abortError()
        warnings.push(`contact sheet rendering failed: ${errorMessage(fallbackError)}`)
      }
    }
  }
  return paths
}

/** `silencedetect` writes to stderr; parse its start/end pairs (relative to seek). */
async function detectSilence(tools, file, region, warnings, signal) {
  const args = [
    '-hide_banner', '-nostats',
    ...regionInputArgs(region),
    '-i', file,
    '-vn',
    '-af', 'silencedetect=n=-50dB:d=2',
    '-f', 'null', '-',
  ]
  let result
  try {
    result = await run(tools.ffmpeg, args, { signal, timeoutMs: 300_000 })
  } catch (error) {
    if (isAbort(error, signal)) throw abortError()
    warnings.push(`silence detection failed: ${errorMessage(error)}`)
    return []
  }
  if (result.code !== 0) {
    warnings.push(`silence detection failed: ${errorMessage(result.stderr) || `exit ${result.code}`}`)
    return []
  }
  const raw = []
  let start = null
  for (const line of result.stderr.split(/\r?\n/u)) {
    const startMatch = /silence_start:\s*(-?[\d.]+)/u.exec(line)
    if (startMatch !== null) {
      start = Number.parseFloat(startMatch[1])
      continue
    }
    const endMatch = /silence_end:\s*(-?[\d.]+)/u.exec(line)
    if (endMatch !== null) {
      const end = Number.parseFloat(endMatch[1])
      raw.push({ start: start ?? 0, end })
      start = null
    }
  }
  if (start !== null && Number.isFinite(start)) raw.push({ start, end: region.duration })
  return normaliseIntervals(raw, region.start, region)
}

/* ------------------------------------------------------------------ *
 * Report assembly
 * ------------------------------------------------------------------ */

/** Pick at most maxKeyframes shot indices, spread evenly over the timeline. */
function selectKeyframeIndices(shotCount, maxKeyframes) {
  if (shotCount <= maxKeyframes) return Array.from({ length: shotCount }, (_value, index) => index)
  const indices = new Set()
  for (let index = 0; index < maxKeyframes; index += 1) {
    indices.add(Math.round((index * (shotCount - 1)) / Math.max(1, maxKeyframes - 1)))
  }
  return [...indices].sort((a, b) => a - b)
}

/** Pick the telemetry frame nearest the shot midpoint (best content sample). */
function representativeSample(samples, interval, frameSeconds) {
  if (samples.length === 0) return null
  const target = (interval.start + interval.end) / 2
  let best = samples[0]
  let bestDistance = Math.abs(best.t - target)
  for (const sample of samples) {
    const distance = Math.abs(sample.t - target)
    if (distance < bestDistance) {
      best = sample
      bestDistance = distance
    }
  }
  return bestDistance <= Math.max(1, frameSeconds * 2) ? best : null
}

function isNearCut(time, cutTimes) {
  for (const cutTime of cutTimes) {
    if (Math.abs(time - cutTime) < 0.06) return true
  }
  return false
}

/** Per-shot brightness/saturation/hue/motion from the telemetry samples. */
function summariseShotFrames(samples, interval, cutTimes) {
  let brightness = 0
  let saturation = 0
  let count = 0
  let motion = 0
  let motionCount = 0
  const hueEntries = []
  for (const sample of samples) {
    if (sample.t < interval.start - 1e-6) continue
    if (sample.t >= interval.end - 1e-6) continue
    count += 1
    brightness += sample.y
    saturation += sample.sat
    if (!isNearCut(sample.t, cutTimes)) {
      motion += sample.mafd
      motionCount += 1
    }
    if (sample.hue !== null) {
      hueEntries.push({ hue: sample.hue, weight: Math.max(0.05, sample.hueSat) * (sample.y / 255 + 0.1) })
    }
  }
  if (count === 0) return { brightness: 0, saturation: 0, motion: 0, hue: null }
  return {
    brightness: brightness / count / 255,
    saturation: saturation / count / 255,
    motion: motionCount === 0 ? 0 : motion / motionCount,
    hue: circularHueMean(hueEntries),
  }
}

const MAX_TIMELINE_POINTS = 300

/** Downsample the frame stream into <=300 (t, brightness, saturation, motion) points. */
function buildTimeline(samples, cutTimes, region) {
  const seconds = Math.max(0.001, region.duration)
  const pointCount = Math.max(1, Math.min(MAX_TIMELINE_POINTS, Math.ceil(seconds)))
  const bucketSize = seconds / pointCount
  const buckets = Array.from({ length: pointCount }, () => ({ y: 0, sat: 0, motion: 0, motionCount: 0, count: 0 }))
  for (const sample of samples) {
    const bucketIndex = Math.min(pointCount - 1, Math.max(0, Math.floor(sample.t / bucketSize)))
    const bucket = buckets[bucketIndex]
    bucket.count += 1
    bucket.y += sample.y
    bucket.sat += sample.sat
    if (!isNearCut(sample.t, cutTimes)) {
      bucket.motion += sample.mafd
      bucket.motionCount += 1
    }
  }
  let previous = null
  return buckets.map((bucket, index) => {
    const brightness = bucket.count === 0 ? previous?.brightness ?? 0 : bucket.y / bucket.count / 255
    const saturation = bucket.count === 0 ? previous?.saturation ?? 0 : bucket.sat / bucket.count / 255
    const motion = bucket.motionCount === 0 ? 0 : bucket.motion / bucket.motionCount
    const point = {
      t: round2(region.start + index * bucketSize),
      brightness: round3(brightness),
      saturation: round3(saturation),
      motion: round1(motion),
    }
    previous = point
    return point
  })
}

function aspectRatioOf(width, height, rotation) {
  const rotateSideways = rotation === 90 || rotation === 270
  const displayWidth = rotateSideways ? height : width
  const displayHeight = rotateSideways ? width : height
  if (!(displayWidth > 0) || !(displayHeight > 0)) return 'unknown'
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(Math.round(displayWidth), Math.round(displayHeight)) || 1
  const w = Math.round(displayWidth / divisor)
  const h = Math.round(displayHeight / divisor)
  // Very fine ratios read badly; fall back to a decimal approximation.
  if (w > 32 || h > 32) return `${round2(displayWidth / displayHeight)}:1`
  return `${w}:${h}`
}

/** Global summary built from frame samples + keyframe colour analyses. */
function summariseGlobal({ samples, shots, keyframeAnalyses, timeline, cuts, region, videoStream }) {
  const cutTimes = cuts.map((cut) => cut.t)
  let brightnessSum = 0
  let saturationSum = 0
  let motionSum = 0
  let motionCount = 0
  let peakMotion = 0
  for (const sample of samples) {
    brightnessSum += sample.y
    saturationSum += sample.sat
    // A frame on a scene cut reports a huge mafd; that is a cut, not motion, so
    // motion statistics ignore the boundary frame (same rule as per-shot stats).
    if (isNearCut(sample.t, cutTimes)) continue
    motionSum += sample.mafd
    motionCount += 1
    peakMotion = Math.max(peakMotion, sample.mafd)
  }
  const brightnessValues = timeline.map((point) => point.brightness)
  const familyCounts = Object.create(null)
  let coloured = 0
  let edgeDensity = 0
  let colorfulness = 0
  for (const analysis of keyframeAnalyses) {
    for (const [name, value] of Object.entries(analysis.familyCounts)) {
      familyCounts[name] = (familyCounts[name] ?? 0) + value
    }
    coloured += analysis.coloured
    edgeDensity += analysis.edgeDensity
    colorfulness += analysis.colorfulness
  }
  const keyframeCount = keyframeAnalyses.length

  let dominantHues = []
  if (keyframeCount > 0 && coloured > 0) {
    dominantHues = Object.entries(familyCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, value]) => {
        const family = [...HUE_FAMILIES, RED_FAMILY].find((entry) => entry.name === name) ?? GREY_FAMILY
        return { name, share: round3(value / coloured), hex: family.hex }
      })
  } else {
    // No decoded keyframe: fall back to the per-shot hue names (duration weighted).
    const weights = new Map()
    for (const shot of shots) {
      weights.set(shot.hueName, (weights.get(shot.hueName) ?? 0) + shot.duration)
    }
    const total = [...weights.values()].reduce((sum, value) => sum + value, 0) || 1
    dominantHues = [...weights.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, value]) => {
        const family = [...HUE_FAMILIES, RED_FAMILY].find((entry) => entry.name === name) ?? GREY_FAMILY
        return { name, share: round3(value / total), hex: family.hex }
      })
  }

  const shotCount = shots.length
  const minutes = Math.max(1e-6, region.duration / 60)
  return {
    shotCount,
    cutRate: round1(cuts.length / minutes),
    avgBrightness: round3(samples.length === 0 ? mean(brightnessValues) : brightnessSum / samples.length / 255),
    brightnessVariety: round3(clamp(stddev(brightnessValues), 0, 1)),
    avgSaturation: round3(samples.length === 0 ? 0 : saturationSum / samples.length / 255),
    colorfulness: round1(keyframeCount === 0 ? 0 : colorfulness / keyframeCount),
    dominantHues,
    avgMotion: round1(motionCount === 0 ? 0 : motionSum / motionCount),
    peakMotion: round1(peakMotion),
    aspectRatio: aspectRatioOf(videoStream.width, videoStream.height, videoStream.rotation),
    edgeDensity: round3(keyframeCount === 0 ? 0 : edgeDensity / keyframeCount),
  }
}

/* ------------------------------------------------------------------ *
 * Final JSON hygiene
 * ------------------------------------------------------------------ */

/**
 * Deep-copy a report into strictly JSON-serialisable data: non-finite numbers
 * become 0, `undefined` and non-plain runtime objects are dropped. This is a
 * last line of defence; every producer above already rounds and guards.
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
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'object') {
    if (value instanceof Date || value instanceof Map || value instanceof Set) return null
    const object = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') continue
      const clean = sanitise(item)
      if (clean !== undefined) object[key] = clean
    }
    return object
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined
  return value
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Acoustic speech gate for `likelyTalkingHead`.
 *
 * The transcript is merged by the shell layer after this engine returns, so the
 * only speech signal here is the audio engine's heuristic `vocals` block. That
 * heuristic is band-energy based and reports a confident "vocals" for a pure
 * sine tone, so this gate additionally requires broadband content: spectral
 * flatness above 0.05 (a sine is ~0) and a mid-band share below 0.92 (a pure
 * tone puts all energy in one band). Documented heuristic only — not speech
 * recognition.
 */
function hasSpeechEvidence(audio) {
  if (audio === null || typeof audio !== 'object') return false
  const vocals = audio.vocals
  if (vocals === null || typeof vocals !== 'object' || vocals.present !== true) return false
  if (!(Number(vocals.confidence) >= 0.6)) return false
  const timbre = audio.timbre
  if (timbre === null || typeof timbre !== 'object' || !(Number(timbre.flatness) > 0.05)) return false
  const spectrum = audio.spectrum
  if (spectrum === null || typeof spectrum !== 'object' || !(Number(spectrum.midRatio) <= 0.92)) return false
  const analyzed = audio.analyzed
  if (analyzed === null || typeof analyzed !== 'object' || !(Number(analyzed.seconds) >= 3)) return false
  return true
}

/**
 * Analyse one video file and return a `VideoAnalysis` object.
 *
 * @param {object} params
 * @param {{ffmpeg: string, ffprobe: string}} params.tools  from resolveTools()
 * @param {string} params.file       absolute input path
 * @param {string} params.workDir    absolute scratch directory (exists, writable)
 * @param {object} [params.options]  see CONTRACT.md Module 2
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.analyzeAudio]  injected audio engine (import cycle avoidance)
 * @returns {Promise<object>} VideoAnalysis (strictly JSON-serialisable)
 */
export async function analyzeVideo({ tools, file, workDir, options = {}, signal, analyzeAudio } = {}) {
  throwIfAborted(signal)
  if (tools === null || typeof tools !== 'object' || typeof tools.ffmpeg !== 'string' || typeof tools.ffprobe !== 'string') {
    throw new Error('analyzeVideo: tools {ffmpeg, ffprobe} are required')
  }
  if (typeof file !== 'string' || file.length === 0) throw new Error('analyzeVideo: file path is required')
  if (typeof workDir !== 'string' || workDir.length === 0) throw new Error('analyzeVideo: workDir is required')
  const opts = normaliseOptions(options)
  const warnings = []

  /* 1. Probe: the only genuinely fatal stage. */
  let probeJson
  try {
    probeJson = await probe(tools, file, { signal })
  } catch (error) {
    if (isAbort(error, signal)) throw abortError()
    throw new Error(`cannot read video "${file}": ${errorMessage(error)}`)
  }
  throwIfAborted(signal)
  const info = summariseProbe(probeJson)
  const videoStream = info.video[0]
  if (videoStream === undefined) throw new Error(`"${file}" has no video stream`)
  if (!(videoStream.width > 0) || !(videoStream.height > 0)) {
    warnings.push('the video stream reports no usable dimensions; visual analysis may be unreliable')
  }
  const fps = videoStream.fps > 0 ? videoStream.fps : 25
  const frameSeconds = 1 / fps
  const outDir = await artifactDir(file, opts.artifactDir)
  const keyframesDir = join(outDir, 'keyframes')
  const region = resolveRegion(info.duration, opts, warnings)
  const analysisStart = region.start

  /* 2. Telemetry: brightness/saturation/hue/motion for every analysed frame. */
  let rawFrames = []
  try {
    rawFrames = await fetchTelemetry(tools, file, workDir, region, opts, signal)
  } catch (error) {
    if (isAbort(error, signal)) throw abortError()
    warnings.push(`frame telemetry failed (${errorMessage(error)}); the report falls back to placeholder frame data`)
  }
  const samples = rawFrames
    .map(deriveSample)
    .filter((sample) => Number.isFinite(sample.t))
    .sort((a, b) => a.t - b.t)
  if (samples.length === 0) {
    warnings.push('no decodable video frames were found in the analysis window')
  } else {
    const lastTime = samples[samples.length - 1].t
    if (info.duration > 0 && lastTime < region.duration - Math.max(1, frameSeconds * 2)) {
      const plannedDuration = region.duration
      region.duration = Math.max(0.05, round2(lastTime + frameSeconds))
      warnings.push(
        `the video stream ended early after ${round2(region.duration)} s of the planned ${round2(plannedDuration)} s analysis window ` +
          '(the file may be truncated or corrupt)',
      )
    }
  }

  /* 3. Scene cuts (separate select pass), then the density floor. */
  let cuts = []
  if (samples.length > 0) {
    try {
      const cutFrames = await fetchCutFrames(tools, file, workDir, region, opts.sceneThreshold, opts, signal)
      cuts = mergeCutTimes(cutFrames, region.duration)
    } catch (error) {
      if (isAbort(error, signal)) throw abortError()
      warnings.push(`scene-change detection failed (${errorMessage(error)}); shots come from the density floor only`)
    }
  }
  if (cuts.length === 0 && region.duration > 0.5) {
    warnings.push('no scene changes detected; the density floor produced the reported shots')
  }
  const cutTimes = cuts.map((cut) => cut.t)
  const intervals = buildShotIntervals(region.duration, cuts, opts)

  /* 4. Health events parsed from the same telemetry metadata. */
  const health = parseHealthEvents(rawFrames, analysisStart, region)
  if (health.frozen.length > 0) {
    // The detector cannot tell "broken/frozen video" from "title card", so the
    // report keeps the measurement and the warning states the benign reading.
    const spans = health.frozen.slice(0, 3).map((span) => `${span.start.toFixed(2)}-${span.end.toFixed(2)} s`).join(', ')
    warnings.push(
      `static/flat-frame span (freeze detection): ${spans}${health.frozen.length > 3 ? ', ...' : ''} — ` +
        'normal for title cards, slides, screenshots and frozen video',
    )
  }
  if (health.black.length > 0) {
    const spans = health.black.slice(0, 3).map((span) => `${span.start.toFixed(2)}-${span.end.toFixed(2)} s`).join(', ')
    warnings.push(`black-frame span detected: ${spans}${health.black.length > 3 ? ', ...' : ''}`)
  }

  /* 5. Keyframes: one JPEG + one 44x20 RGB decode per selected shot. */
  const selectedIndices = selectKeyframeIndices(intervals.length, opts.maxKeyframes)
  const keyframeData = new Map()
  let keyframeFailures = 0
  if (opts.wantFrames) {
    try {
      await mkdir(keyframesDir, { recursive: true })
    } catch (error) {
      warnings.push(`could not create the keyframes directory: ${errorMessage(error)}`)
    }
  }
  for (const shotIndex of selectedIndices) {
    throwIfAborted(signal)
    const interval = intervals[shotIndex]
    const representative = representativeSample(samples, interval, frameSeconds)
    const relativeTime = representative === null ? (interval.start + interval.end) / 2 : representative.t
    try {
      const extracted = await extractKeyframe(tools, file, workDir, keyframesDir, shotIndex, analysisStart + relativeTime, opts, signal)
      const analysis = analyseKeyframePixels(extracted.buffer)
      keyframeData.set(shotIndex, {
        ...analysis,
        jpegPath: extracted.jpegPath,
        frameNumber: representative === null ? Math.round(relativeTime * fps) : representative.frame,
      })
    } catch (error) {
      if (isAbort(error, signal)) throw abortError()
      keyframeFailures += 1
    }
  }
  if (keyframeFailures > 0) {
    warnings.push(`keyframe extraction failed for ${keyframeFailures} of ${selectedIndices.length} selected shots`)
  }

  /* 6. Shot reports: telemetry stats + keyframe perception fields. */
  const shots = intervals.map((interval, index) => {
    const stats = summariseShotFrames(samples, interval, cutTimes)
    const keyframe = keyframeData.get(index)
    const hue = keyframe?.meanHue ?? stats.hue
    const family = hue === null || hue === undefined ? GREY_FAMILY : classifyHue(hue)
    const palette = keyframe !== undefined && keyframe.palette.length > 0
      ? keyframe.palette
      : hue === null || hue === undefined
        ? []
        : [{ hex: hueHex(hue), share: 1 }]
    const report = {
      index,
      start: round2(analysisStart + interval.start),
      end: round2(analysisStart + interval.end),
      duration: round2(interval.end - interval.start),
      brightness: round3(stats.brightness),
      saturation: round3(stats.saturation),
      hueName: family.name,
      hueHex: hue === null || hue === undefined ? family.hex : hueHex(hue),
      motion: round1(stats.motion),
      palette,
    }
    if (keyframe?.jpegPath != null) report.keyframe = keyframe.jpegPath
    if (keyframe !== undefined) {
      report.ascii = keyframe.ascii
      report.hueMap = keyframe.hueMap
      report.layout = keyframe.layout
    }
    return report
  })

  /* 7. Timeline + global aggregates. */
  const timeline = buildTimeline(samples, cutTimes, region)
  const keyframeAnalyses = [...keyframeData.values()]
  const global = summariseGlobal({ samples, shots, keyframeAnalyses, timeline, cuts, region, videoStream })

  /* 8. Audio: delegate to the injected engine; never surface its transcript. */
  const hasAudioStream = info.audio.length > 0
  let audio = null
  if (!hasAudioStream) {
    warnings.push('the file has no audio stream; the soundtrack was skipped')
  } else if (opts.wantAudio) {
    if (typeof analyzeAudio === 'function') {
      const audioWorkDir = join(workDir, 'audio')
      try {
        await mkdir(audioWorkDir, { recursive: true })
        throwIfAborted(signal)
        const audioReport = await analyzeAudio({
          tools,
          file,
          workDir: audioWorkDir,
          // ASR/transcript ownership lives in the shell layer, so it is not requested here.
          options: { asr: false, wantArtifacts: true },
          signal,
        })
        if (audioReport !== null && typeof audioReport === 'object') audio = audioReport
        else warnings.push('the audio engine returned no report; the soundtrack was skipped')
      } catch (error) {
        if (isAbort(error, signal)) throw abortError()
        warnings.push(`audio analysis failed: ${errorMessage(error)}`)
      }
    } else {
      warnings.push('the audio analysis engine is not available; the soundtrack was skipped')
    }
  }
  const silent = hasAudioStream ? await detectSilence(tools, file, region, warnings, signal) : []

  /* 9. Flags.
   * `likelyTextHeavy` = edge-dense (Sobel proxy over keyframes) AND low motion:
   * slides/screen recordings. `likelyTalkingHead` additionally requires acoustic
   * speech evidence; a transcript is owned by the shell layer, so the audio
   * engine's vocal heuristic is the only speech signal available here. A pure
   * tone fools a band-energy vocal detector, so the gate also demands broadband
   * content (spectral flatness > 0) and rejects mid-band-only energy.
   */
  const likelyTextHeavy = Boolean(
    global.edgeDensity > TEXT_HEAVY_EDGE_DENSITY && global.avgMotion < LOW_MOTION && shots.length > 0,
  )
  const likelyTalkingHead = Boolean(global.avgMotion < LOW_MOTION && hasSpeechEvidence(audio) && shots.length > 0)
  const flags = {
    frozen: health.frozen,
    black: health.black,
    silent,
    likelyTextHeavy,
    likelyTalkingHead,
  }

  /* 10. Artifacts. */
  const artifacts = {}
  if (opts.wantContactSheet && keyframeData.size > 0) {
    const entries = [...keyframeData.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([shotIndex, data]) => ({ shotIndex, frameNumber: data.frameNumber }))
    const sheets = await renderContactSheets(tools, file, workDir, outDir, entries, region, warnings, signal)
    if (sheets.length > 0) artifacts.contactSheet = sheets.join(', ')
  }
  if (opts.wantFrames && keyframeData.size > 0) artifacts.keyframesDir = keyframesDir
  if (audio !== null && typeof audio.artifacts === 'object' && audio.artifacts !== null) {
    if (typeof audio.artifacts.waveform === 'string' && audio.artifacts.waveform.length > 0) artifacts.waveform = audio.artifacts.waveform
    if (typeof audio.artifacts.spectrogram === 'string' && audio.artifacts.spectrogram.length > 0) artifacts.spectrogram = audio.artifacts.spectrogram
  }

  /* 11. Assemble the contract object, sanitised to strict JSON. */
  return sanitise({
    kind: 'video',
    duration: round2(info.duration > 0 ? info.duration : analysisStart + region.duration),
    stream: {
      codec: typeof videoStream.codec === 'string' ? videoStream.codec : 'unknown',
      width: Math.round(videoStream.width) || 0,
      height: Math.round(videoStream.height) || 0,
      fps: round2(fps),
      bitRate: Math.round(videoStream.bitRate) || 0,
      rotation: Math.round(videoStream.rotation) || 0,
      pixelFormat: typeof videoStream.pixFmt === 'string' ? videoStream.pixFmt : 'unknown',
    },
    format: {
      container: typeof info.formatName === 'string' ? info.formatName : 'unknown',
      bitRate: Math.round(info.bitRate) || 0,
      sizeBytes: Math.round(info.sizeBytes) || 0,
    },
    global: {
      shotCount: global.shotCount,
      cutRate: global.cutRate,
      avgBrightness: global.avgBrightness,
      brightnessVariety: global.brightnessVariety,
      avgSaturation: global.avgSaturation,
      colorfulness: global.colorfulness,
      dominantHues: global.dominantHues,
      avgMotion: global.avgMotion,
      peakMotion: global.peakMotion,
      aspectRatio: global.aspectRatio,
    },
    shots,
    timeline,
    audio,
    transcript: null,
    flags,
    artifacts,
    warnings,
  })
}

export default { analyzeVideo }
