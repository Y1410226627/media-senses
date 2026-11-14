/**
 * Acceptance gate — "would a stranger sit through this?"
 *
 * `media_compare` grades a replica against its reference on static metrics. This
 * module grades a *finished film* on the properties that make a cut read as a
 * film rather than a slideshow, using nothing but pixel and audio measurements:
 *
 *   - **stillness** — how much of the film is genuinely dead still. A cut with
 *     no rests is exhausting; a cut with nothing but rests is a slideshow.
 *   - **bursts** — short windows holding several large changes. Bursts are what
 *     make a film breathe; a metronome of equal shots reads as cards flipping.
 *   - **shot-length variety** — the coefficient of variation of shot lengths.
 *     Equal lengths are a metronome whatever the motion inside them.
 *   - **dead air** — a long stretch where nothing on screen changes.
 *   - **audio headroom** — peak, clipping and the share of genuinely quiet
 *     frames. A film that never goes quiet has no dynamics.
 *   - **text floor** — handled by `frontFrameChecks` for rendered HTML.
 *
 * Thresholds come from measured references, not taste:
 *   - cadence CV >= 0.25 and >= 25% still frames: onetake's `verify_promo.py`,
 *     calibrated against four rejected/accepted cuts where every rhythm leg
 *     passed both the rejected and the accepted film.
 *   - a burst = >= 3 large changes inside 1.5 s (same source).
 *   - peak <= -3 dBFS with zero clipped samples (same source).
 *   - dead air >= 3 s with nothing changing: hyperframes' `dead_stretch`.
 *
 * Design notes:
 * - ONE decode pass at a small raster produces everything (the same shape as
 *   `change.scoreVideo`), so the gate costs about as much as a thumbnail pass.
 * - Every leg reports PASS / WARN / FAIL plus the measured number. Only FAIL
 *   fails the verdict; WARN is "look at this and decide".
 * - When a reference film is supplied, legs that are only meaningful relative to
 *   a reference (burst presence) are judged against it instead of absolutely,
 *   because a concept film with one continuous move legitimately has no bursts.
 * - Nothing here is model-dependent: the gate is deterministic and can be run
 *   from a test.
 *
 * @module lib/gate
 */
import { stat } from 'node:fs/promises'
import { probe, run } from './ffmpeg.js'

/* ------------------------------------------------------------------ *
 * Public constants — the exact defaults reported to the model
 * ------------------------------------------------------------------ */

/** Gate thresholds. Every one of these is a measured reference, not taste. */
export const GATE_THRESHOLDS = Object.freeze({
  /** Shot-length coefficient of variation below this reads as a metronome. */
  cadenceCv: 0.25,
  /** Share of dead-still frames a film needs to breathe. */
  stillRatio: 0.25,
  /** Longest single still stretch required, in seconds. */
  stillStretchSec: 1,
  /** A burst: this many large changes… */
  burstChanges: 3,
  /** …inside this many seconds. */
  burstWindowSec: 1.5,
  /** Frame-to-frame score that counts as a "large change". */
  burstChangeScore: 8,
  /** Mean absolute difference (0-1) under which a frame pair is dead still. */
  stillDiff: 0.005,
  /**
   * A frame pair is still only if fewer than this share of pixels moved as well.
   * Sparse motion (thin strokes, slow drift) keeps the mean near zero, so the
   * moved-pixel share is the second, independent check.
   */
  stillMovedShare: 0.004,
  /** A stretch this long with nothing changing is dead air. */
  deadAirSec: 3,
  /** Peak above this (dBFS) leaves no headroom. */
  peakDb: -3,
  /** Share of 1/12 s windows that must be genuinely quiet. */
  quietRatio: 0.15,
  /** Window used for the quiet ratio, in seconds. */
  quietWindowSec: 1 / 12,
  /** Loudness under this (dBFS RMS) counts as quiet. */
  quietRmsDb: -40,
})

/** Defaults for the analysis raster and rate. */
export const GATE_OPTIONS = Object.freeze({
  /**
   * Analysis raster. 160x90 rather than 96x54: slow parallax drift over five
   * seconds moves only a couple of pixels here, and a coarser raster rounds that
   * away entirely and calls a moving shot static.
   */
  width: 160,
  height: 90,
  /** Sampling rate. Rhythm needs frame-accurate change; 12 fps is enough. */
  fps: 12,
  /** Hard cap so a long film cannot decode forever. */
  maxFrames: 5400,
})

/** A pixel counts as "moved" when its absolute RGB delta exceeds this (0-255). */
export const MOVED_PIXEL_THRESHOLD = 6

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Round to `digits`, mapping non-finite values to 0 (JSON must stay finite). */
function roundTo(value, digits) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const round1 = (value) => roundTo(value, 1)
const round2 = (value) => roundTo(value, 2)
const round3 = (value) => roundTo(value, 3)

/** An Error that satisfies `name === 'AbortError'`. */
function abortError() {
  const error = new Error('media-senses: gate aborted')
  error.name = 'AbortError'
  return error
}

/** Throw an AbortError when the caller has already aborted. */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError()
}

/** Mean absolute difference of two rgb24 frames, normalised to 0-1. */
function frameDiff(buffer, offsetA, offsetB, byteLength) {
  let total = 0
  for (let index = 0; index < byteLength; index += 1) {
    const delta = buffer[offsetA + index] - buffer[offsetB + index]
    total += delta < 0 ? -delta : delta
  }
  return total / byteLength / 255
}

/**
 * Share of pixels that visibly changed between two frames.
 *
 * Mean difference alone under-reads sparse movement: a thin line drawing itself
 * or a slow parallax drift touches a small share of the frame, so the mean stays
 * near zero even though a viewer clearly sees motion. Counting *moved pixels*
 * catches that without lowering the mean threshold (which would make noise count
 * as motion).
 *
 * @returns {number} 0..1 share of pixels whose absolute RGB delta exceeds the threshold
 */
function movedPixelShare(buffer, offsetA, offsetB, byteLength) {
  let moved = 0
  for (let index = 0; index < byteLength; index += 3) {
    const dr = Math.abs(buffer[offsetA + index] - buffer[offsetB + index])
    const dg = Math.abs(buffer[offsetA + index + 1] - buffer[offsetB + index + 1])
    const db = Math.abs(buffer[offsetA + index + 2] - buffer[offsetB + index + 2])
    if (dr + dg + db > MOVED_PIXEL_THRESHOLD * 3) moved += 1
  }
  return moved / (byteLength / 3)
}

/** Standard deviation of a numeric array. */
function stddev(values) {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/** Median of a numeric array (already sorted input not required). */
function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/* ------------------------------------------------------------------ *
 * Pass 1 — one decode produces the whole-picture rhythm signal
 * ------------------------------------------------------------------ */

/**
 * Decode a small raster and measure frame-to-frame change.
 *
 * @param {object} options
 * @param {{ffmpeg: string}} options.tools
 * @param {string} options.file absolute path
 * @param {string} options.workDir scratch cwd; the caller owns it
 * @param {number} [options.fps]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{fps: number, width: number, height: number, frameCount: number, diffs: number[], times: number[], duration: number, warnings: string[]}>}
 */
async function scanFrames({ tools, file, workDir, fps, signal }) {
  const warnings = []
  const rate = Number.isFinite(fps) && fps > 0 ? fps : GATE_OPTIONS.fps
  const width = GATE_OPTIONS.width
  const height = GATE_OPTIONS.height
  const rawName = 'gate-frames.rgb'

  // ffmpeg writes RELATIVE to cwd: a drive-letter colon inside a filtergraph
  // breaks the option parse on Windows.
  const decoded = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-nostdin', '-y',
      '-i', file,
      '-an', '-sn', '-dn',
      '-vf', `fps=${rate},scale=${width}:${height}:flags=area,format=rgb24`,
      '-frames:v', String(GATE_OPTIONS.maxFrames),
      '-f', 'rawvideo',
      rawName,
    ],
    { cwd: workDir, signal },
  )
  if (decoded.code !== 0 && decoded.stderr) {
    const first = String(decoded.stderr).split(/\r?\n/u).find((line) => line.trim().length > 0)
    warnings.push(`gate: decode reported: ${first ?? `exit ${decoded.code}`}`)
  }

  const { readFile } = await import('node:fs/promises')
  let buffer
  try {
    buffer = await readFile(`${workDir}/${rawName}`)
  } catch {
    return { fps: rate, width, height, frameCount: 0, diffs: [], times: [], duration: 0, warnings: [...warnings, 'gate: no frames were decoded; the rhythm legs are skipped'] }
  }

  const frameBytes = width * height * 3
  const frameCount = Math.floor(buffer.length / frameBytes)
  if (frameCount < 2) {
    return { fps: rate, width, height, frameCount, diffs: [], times: [], duration: frameCount / rate, warnings: [...warnings, 'gate: fewer than two frames decoded; the rhythm legs are skipped'] }
  }

  const diffs = new Array(frameCount - 1)
  const moved = new Array(frameCount - 1)
  const times = new Array(frameCount)
  times[0] = 0
  for (let index = 0; index < frameCount; index += 1) {
    times[index] = round3(index / rate)
    if (index === 0) continue
    const previousOffset = (index - 1) * frameBytes
    const currentOffset = index * frameBytes
    diffs[index - 1] = round3(frameDiff(buffer, previousOffset, currentOffset, frameBytes))
    moved[index - 1] = round3(movedPixelShare(buffer, previousOffset, currentOffset, frameBytes))
  }
  return { fps: rate, width, height, frameCount, diffs, moved, times, duration: frameCount / rate, warnings }
}

/* ------------------------------------------------------------------ *
 * Pass 2 — audio headroom (raw PCM, no filtergraph paths)
 * ------------------------------------------------------------------ */

/**
 * Measure peak, clipping and the quiet share of the soundtrack.
 *
 * Decoding to raw PCM avoids the loudness filtergraph and any Windows path
 * quoting problem; the metrics are deliberately simple enough to be verified by
 * hand.
 *
 * @returns {Promise<{peakDb: number, clipped: number, quietRatio: number, rmsDb: number}|null>}
 */
async function scanAudio({ tools, file, workDir, signal }) {
  const rawName = 'gate-audio.s16'
  const result = await run(
    tools.ffmpeg,
    ['-v', 'error', '-nostdin', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', rawName],
    { cwd: workDir, signal },
  )
  if (result.code !== 0) return null
  const { readFile } = await import('node:fs/promises')
  let buffer
  try {
    buffer = await readFile(`${workDir}/${rawName}`)
  } catch {
    return null
  }
  const sampleCount = Math.floor(buffer.length / 2)
  if (sampleCount < 1600) return null

  let peak = 0
  let clipped = 0
  let squares = 0
  for (let index = 0; index < sampleCount; index += 1) {
    const value = buffer.readInt16LE(index * 2) / 32768
    const magnitude = value < 0 ? -value : value
    if (magnitude > peak) peak = magnitude
    if (magnitude >= 0.999) clipped += 1
    squares += value * value
  }
  const rate = 16000
  const windowSamples = Math.max(1, Math.round(rate * GATE_THRESHOLDS.quietWindowSec))
  let quietWindows = 0
  let windowCount = 0
  for (let start = 0; start + windowSamples <= sampleCount; start += windowSamples) {
    let windowSquares = 0
    for (let index = start; index < start + windowSamples; index += 1) {
      const value = buffer.readInt16LE(index * 2) / 32768
      windowSquares += value * value
    }
    const rms = Math.sqrt(windowSquares / windowSamples)
    if (20 * Math.log10(rms + 1e-9) < GATE_THRESHOLDS.quietRmsDb) quietWindows += 1
    windowCount += 1
  }
  const rmsAll = Math.sqrt(squares / sampleCount)
  const rmsDb = round1(20 * Math.log10(rmsAll + 1e-9))
  // A digitally silent track (or a muxed-but-empty one) cannot be judged for
  // dynamics: report "no audio" rather than a misleading PASS at -180 dBFS.
  if (rmsDb < -80 && 20 * Math.log10(peak + 1e-9) < -80) return null
  return {
    peakDb: round1(20 * Math.log10(peak + 1e-9)),
    rmsDb,
    clipped,
    quietRatio: windowCount === 0 ? 0 : round3(quietWindows / windowCount),
  }
}

/* ------------------------------------------------------------------ *
 * The legs
 * ------------------------------------------------------------------ */

/** Build one leg result. `state` is PASS / WARN / FAIL / SKIP. */
function leg(id, titleZh, state, detailZh, value) {
  return { id, title: titleZh, state, detail: detailZh, value: value ?? null }
}

/**
 * Stillness: the share of dead-still frame pairs and the longest still stretch.
 *
 * A pair counts as still only when it is quiet *both* ways: the mean difference is
 * tiny **and** almost no pixel moved. The second condition is what stops a slow
 * parallax drift or a line drawing itself from being reported as "nothing
 * happened".
 */
function legStillness(scan) {
  const { diffs, moved, fps } = scan
  if (diffs.length === 0) return leg('stillness', '静帧比例', 'SKIP', '没有可用的帧序列', null)
  const isStill = (index) => diffs[index] < GATE_THRESHOLDS.stillDiff && (moved[index] ?? 0) < GATE_THRESHOLDS.stillMovedShare
  let stillFrames = 0
  let longest = 0
  let run = 0
  for (let index = 0; index < diffs.length; index += 1) {
    if (isStill(index)) {
      stillFrames += 1
      run += 1
      if (run > longest) longest = run
    } else {
      run = 0
    }
  }
  const stillRatio = round3(stillFrames / diffs.length)
  const longestSec = round2(longest / fps)
  const ok = stillRatio >= GATE_THRESHOLDS.stillRatio && longestSec >= GATE_THRESHOLDS.stillStretchSec
  const state = ok ? 'PASS' : stillRatio < GATE_THRESHOLDS.stillRatio * 0.5 ? 'FAIL' : 'WARN'
  const detail = stillRatio < GATE_THRESHOLDS.stillRatio
    ? `静帧只占 ${Math.round(stillRatio * 100)}%，全片几乎没有停顿（要求 ≥${Math.round(GATE_THRESHOLDS.stillRatio * 100)}%）；最长一段静止 ${longestSec}s`
    : `静帧占 ${Math.round(stillRatio * 100)}%（要求 ≥${Math.round(GATE_THRESHOLDS.stillRatio * 100)}%），最长一段静止 ${longestSec}s${longestSec < GATE_THRESHOLDS.stillStretchSec ? `（要求 ≥${GATE_THRESHOLDS.stillStretchSec}s）` : ''}`
  return leg('stillness', '静帧比例', state, detail, { stillRatio, longestSec })
}

/**
 * Bursts: a window of `burstWindowSec` holding at least `burstChanges` large
 * changes. Judged absolutely only when no reference is supplied.
 */
function legBurst(scan, referenceBursts) {
  const { diffs, fps } = scan
  if (diffs.length === 0) return leg('burst', '变化爆发', 'SKIP', '没有可用的帧序列', null)
  const windowFrames = Math.max(1, Math.round(GATE_THRESHOLDS.burstWindowSec * fps))
  const large = diffs.map((diff) => diff >= GATE_THRESHOLDS.burstChangeScore / 255)
  let bursts = 0
  let at = null
  for (let start = 0; start + windowFrames <= large.length; start += 1) {
    let count = 0
    for (let index = start; index < start + windowFrames; index += 1) {
      if (large[index]) count += 1
      if (count >= GATE_THRESHOLDS.burstChanges) break
    }
    if (count >= GATE_THRESHOLDS.burstChanges) {
      if (at === null) at = round2(start / fps)
      bursts += 1
    }
  }
  // Group overlapping windows into distinct bursts.
  const distinct = bursts === 0 ? 0 : Math.max(1, Math.round(bursts / Math.max(1, Math.round(windowFrames / 2))))
  let state
  let detail
  if (distinct > 0) {
    state = 'PASS'
    detail = `有 ${distinct} 处爆发（${GATE_THRESHOLDS.burstWindowSec}s 内 ≥${GATE_THRESHOLDS.burstChanges} 次大变化），首处约 ${at}s`
  } else if (referenceBursts !== undefined && referenceBursts !== null && referenceBursts > 0) {
    state = 'FAIL'
    detail = `全片没有爆发，但参考片有 ${referenceBursts} 处；仿制时至少要在一个段落里连续加速`
  } else {
    state = 'WARN'
    detail = '全片没有爆发。若作品本身是一条连续运镜/单个元素变形，这是合理的；否则读起来像卡片翻页'
  }
  return leg('burst', '变化爆发', state, detail, { bursts: distinct, firstAt: at })
}

/**
 * Cadence: shot-length coefficient of variation and the min/max spread.
 *
 * Shot boundaries come from the cut list. `media_build_video` renders gradual
 * transitions (fade, slide, wipe) that a hard-cut detector legitimately cannot
 * see, so a plan-derived scene list is the honest fallback there: the *authored*
 * rhythm is what the film was cut to, whether or not the detector agrees.
 */
function legCadence(shots, duration) {
  if (!Array.isArray(shots) || shots.length < 2 || !(duration > 0)) {
    return leg('cadence', '镜头长度变化', 'SKIP', '需要至少 2 个镜头与总时长', null)
  }
  const lengths = []
  for (const shot of shots) {
    const value = Number(shot?.duration)
    if (Number.isFinite(value) && value > 0) lengths.push(value)
  }
  if (lengths.length < 2) return leg('cadence', '镜头长度变化', 'SKIP', '可用镜头不足', null)
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length
  const cv = mean === 0 ? 0 : round3(stddev(lengths) / mean)
  const shortest = round2(Math.min(...lengths))
  const longest = round2(Math.max(...lengths))
  const state = cv >= GATE_THRESHOLDS.cadenceCv ? 'PASS' : cv >= GATE_THRESHOLDS.cadenceCv * 0.6 ? 'WARN' : 'FAIL'
  const detail = cv >= GATE_THRESHOLDS.cadenceCv
    ? `镜头长 ${shortest}–${longest}s，变异系数 ${cv}（要求 ≥${GATE_THRESHOLDS.cadenceCv}），节奏有变化`
    : `镜头长 ${shortest}–${longest}s，变异系数只有 ${cv}（要求 ≥${GATE_THRESHOLDS.cadenceCv}）——等长的镜头就是节拍器，哪怕每个镜头内部在动`
  return leg('cadence', '镜头长度变化', state, detail, { cv, shortest, longest })
}

/** Dead air: the longest stretch with nothing changing. */
function legDeadAir(scan) {
  const { diffs, moved, fps } = scan
  if (diffs.length === 0) return leg('dead-air', '静止空档', 'SKIP', '没有可用的帧序列', null)
  // "Nothing changing" is looser than "dead still": a slow drift still reads as
  // dead air, so the threshold is twice the stillness one — but it must also be
  // true that almost no pixel moved, otherwise a subtle continuous move (a slow
  // parallax drift) would be reported as a frozen frame.
  const quietLimit = GATE_THRESHOLDS.stillDiff * 2
  const movedLimit = GATE_THRESHOLDS.stillMovedShare * 2
  const isQuiet = (index) => diffs[index] < quietLimit && (moved[index] ?? 0) < movedLimit
  let longest = 0
  let run = 0
  let longestAt = 0
  for (let index = 0; index < diffs.length; index += 1) {
    if (isQuiet(index)) {
      run += 1
      if (run > longest) {
        longest = run
        longestAt = (index - run + 1) / fps
      }
    } else {
      run = 0
    }
  }
  const longestSec = round2(longest / fps)
  const state = longestSec >= GATE_THRESHOLDS.deadAirSec ? 'FAIL' : longestSec >= GATE_THRESHOLDS.deadAirSec * 0.66 ? 'WARN' : 'PASS'
  const detail = longestSec >= GATE_THRESHOLDS.deadAirSec
    ? `有 ${longestSec}s 完全没有变化（从 ${round2(longestAt)}s 起），观众会以为卡住了；要么删短，要么让它动起来`
    : `最长一段无变化 ${longestSec}s${longestSec >= GATE_THRESHOLDS.deadAirSec * 0.66 ? '，已接近上限，注意别让画面停太久' : ''}`
  return leg('dead-air', '静止空档', state, detail, { longestSec, at: round2(longestAt) })
}

/** Audio headroom and dynamics. */
function legAudio(audio) {
  if (audio === null || audio === undefined) {
    return leg('audio', '音频动态', 'SKIP', '没有音轨或音频无法解码', null)
  }
  const overPeak = audio.peakDb > GATE_THRESHOLDS.peakDb
  const clipped = audio.clipped > 0
  const tooDense = audio.quietRatio < GATE_THRESHOLDS.quietRatio
  const state = clipped || overPeak ? 'FAIL' : tooDense ? 'WARN' : 'PASS'
  const parts = [`峰值 ${audio.peakDb} dBFS`, `响度 ${audio.rmsDb} dBFS`]
  if (clipped) parts.push(`${audio.clipped} 个削波采样`)
  parts.push(`安静片段占 ${Math.round(audio.quietRatio * 100)}%（要求 ≥${Math.round(GATE_THRESHOLDS.quietRatio * 100)}%）`)
  let advice = ''
  if (clipped) advice = '——有削波，先把响度降下来并重新限幅'
  else if (overPeak) advice = `——峰值超过 ${GATE_THRESHOLDS.peakDb} dBFS，没有余量`
  else if (tooDense) advice = '——全片一直很响，没有安静段落就听不出重点'
  return leg('audio', '音频动态', state, parts.join('，') + advice, audio)
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Run the acceptance gate on a finished film.
 *
 * @param {object} options
 * @param {{ffmpeg: string, ffprobe?: string}} options.tools
 * @param {string} options.file absolute path to the finished video
 * @param {string} options.workDir scratch cwd; the caller owns and removes it
 * @param {Array<{start: number, duration: number}>} [options.shots] shot list from the analyser
 * @param {Array<{duration: number}>} [options.plannedScenes] authored scenes, used when the
 *   measured shot list is too sparse (gradual transitions hide cuts from the detector)
 * @param {number} [options.referenceBursts] burst count of the reference film
 * @param {number} [options.duration] total duration; probed when omitted
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{verdict: 'PASS'|'FAIL', legs: Array<object>, measurements: object, warnings: string[]}>}
 */
export async function runGate({
  tools,
  file,
  workDir,
  shots,
  plannedScenes,
  referenceBursts,
  duration,
  signal,
} = {}) {
  if (tools === null || typeof tools !== 'object' || typeof tools.ffmpeg !== 'string') {
    throw new Error('gate.runGate: tools.ffmpeg is required')
  }
  if (typeof file !== 'string' || file.trim().length === 0) throw new Error('gate.runGate: file must be a non-empty path string')
  if (typeof workDir !== 'string' || workDir.trim().length === 0) throw new Error('gate.runGate: workDir must be a non-empty path string')
  throwIfAborted(signal)

  const info = await stat(file).catch(() => undefined)
  if (info === undefined || !info.isFile()) throw new Error(`gate.runGate: cannot read "${file}"`)

  let total = Number.isFinite(duration) && duration > 0 ? duration : 0
  if (total === 0) {
    const metadata = await probe(tools, file, { signal }).catch(() => undefined)
    const value = Number.parseFloat(String(metadata?.format?.duration ?? ''))
    if (Number.isFinite(value) && value > 0) total = value
  }

  const scan = await scanFrames({ tools, file, workDir, fps: GATE_OPTIONS.fps, signal })
  throwIfAborted(signal)
  const audio = await scanAudio({ tools, file, workDir, signal }).catch(() => null)
  throwIfAborted(signal)

  const warnings = [...scan.warnings]
  // Prefer the measured shot list; fall back to the authored scenes when the
  // detector found too few boundaries (a plan built from gradual transitions).
  let cadenceShots = shots
  let cadenceSource = 'measured'
  if ((!Array.isArray(cadenceShots) || cadenceShots.length < 2) && Array.isArray(plannedScenes) && plannedScenes.length >= 2) {
    cadenceShots = plannedScenes
    cadenceSource = 'planned'
    warnings.push('gate: the cut detector found fewer than two shots (gradual transitions hide hard cuts), so the cadence leg uses the authored scene lengths')
  }
  const legs = [
    legCadence(cadenceShots, total || scan.duration),
    legStillness(scan),
    legBurst(scan, referenceBursts),
    legDeadAir(scan),
    legAudio(audio),
  ]

  const measurements = {
    duration: round2(total || scan.duration),
    sampledFps: scan.fps,
    frames: scan.frameCount,
    cadenceSource,
    meanChange: scan.diffs.length === 0 ? 0 : round3(scan.diffs.reduce((sum, value) => sum + value, 0) / scan.diffs.length),
    medianChange: scan.diffs.length === 0 ? 0 : round3(median(scan.diffs) ?? 0),
    maxChange: scan.diffs.length === 0 ? 0 : round3(Math.max(...scan.diffs)),
    audio,
  }

  // Only FAIL fails the verdict; WARN is a decision the model must make and say
  // out loud (a concept film without bursts is legitimate).
  const failed = legs.filter((entry) => entry.state === 'FAIL')
  return {
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    legs,
    measurements,
    warnings,
  }
}

export default { runGate, GATE_THRESHOLDS, GATE_OPTIONS }
