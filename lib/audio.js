/**
 * media-senses — offline audio / music analysis engine.
 *
 * `analyzeAudio()` turns any file with an audio stream into a structured
 * "listening report" that a text-only model can reason about: tempo, key,
 * chords, sections, loudness (EBU R128), timbre, energy curve, heuristics for
 * vocals/mood, plus optional PNG artifacts. It is deliberately dependency-free:
 * ffmpeg/ffprobe do container work and this module does the DSP in JS.
 *
 * Robustness policy: the analysis degrades instead of throwing. A file with no
 * audio stream, a silent file, a 1-second clip or an unparsable loudness
 * measurement all return a full report with `warnings: [...]`. The only thrown
 * errors are "the input file cannot be read at all" and abort-signal errors.
 *
 * ASR is intentionally *not* implemented here: the plugin shell owns
 * `lib/asr.js` and merges the transcript afterwards. `options.asr` /
 * `options.language` / `options.whisperModelPath` are accepted for forward
 * compatibility and ignored; `transcript` is always `null` at this layer.
 *
 * All numbers in the result are finite and JSON-serializable (arrays are plain
 * arrays, no typed arrays / NaN / Infinity); seconds are rounded to 0.01,
 * Hz to 1, ratios to 3 decimals.
 */
import { copyFile, mkdir, open, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  artifactDir as resolveArtifactDir,
  probe,
  run,
  summariseProbe,
} from './ffmpeg.js'
import { writeHeatmap, writeLineChart } from './png.js'
import * as dsp from './dsp.js'

const DEFAULT_SAMPLE_RATE = 22050
const MAX_SAMPLE_RATE = 48000
const MAX_ARTIFACT_COLUMNS = 120
const MAX_ENERGY_POINTS = 240
const SILENT_PEAK = 1e-4 // ~ -80 dBFS: below this the file is treated as silence
const MIN_SECONDS_FOR_TEMPO = 4
const MIN_SECONDS_FOR_KEY = 2
const MIN_SECONDS_FOR_STRUCTURE = 8
const MIN_TEMPO_CONFIDENCE = 0.4
const MIN_TEMPO_ONSETS_PER_SECOND = 1.5
const MIN_KEY_CONFIDENCE = 0.15
const CHORD_ROOT_BONUS = 0.2
const N_FFT = 2048
const CHROMA_HOP = 512
const ONSET_HOP = 256
const TARGET_ARTIFACT_WIDTH = 960

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Analyse the soundtrack of an audio or video file.
 *
 * @param {{
 *   tools: {ffmpeg: string, ffprobe: string},
 *   file: string,
 *   workDir: string,
 *   options?: {
 *     start?: number, duration?: number, maxSeconds?: number,
 *     wantArtifacts?: boolean, wantChords?: boolean, wantStructure?: boolean,
 *     sampleRate?: number, artifactDir?: string,
 *     asr?: boolean, language?: string, whisperModelPath?: string|null,
 *   },
 *   signal?: AbortSignal,
 * }} params
 * @returns {Promise<object>} AudioAnalysis (see CONTRACT.md)
 */
export async function analyzeAudio({ tools, file, workDir, options = {}, signal } = {}) {
  if (typeof tools?.ffmpeg !== 'string' || typeof tools?.ffprobe !== 'string') {
    throw new Error('analyzeAudio: tools.ffmpeg and tools.ffprobe are required (use resolveTools())')
  }
  if (typeof file !== 'string' || file.length === 0) throw new Error('analyzeAudio: file is required')
  if (typeof workDir !== 'string' || workDir.length === 0) throw new Error('analyzeAudio: workDir is required')
  throwIfAborted(signal)
  await assertReadable(file)
  // The contract guarantees an existing scratch dir; creating it is a harmless
  // safety net for shell integrations that pass a fresh path.
  await mkdir(workDir, { recursive: true })

  const opts = normaliseOptions(options)
  const warnings = []

  // --- Container facts -----------------------------------------------------
  let summary = null
  try {
    summary = summariseProbe(await probe(tools, file, { signal }))
  } catch (error) {
    warnings.push(`无法读取容器元数据（${compactError(error)}），返回空报告。`)
    return emptyReport({
      duration: 0,
      format: { codec: 'unknown', container: 'unknown', bitRate: 0, channels: 0, sampleRate: 0 },
      sampleRate: opts.sampleRate,
      start: opts.start,
      warnings,
    })
  }

  const audioStreams = Array.isArray(summary.audio) ? summary.audio : []
  const containerDuration = Number.isFinite(summary.duration) && summary.duration > 0 ? summary.duration : 0
  const formatFacts = {
    codec: audioStreams[0]?.codec ?? 'unknown',
    container: summary.formatName || 'unknown',
    bitRate: audioStreams[0]?.bitRate || summary.bitRate || 0,
    channels: audioStreams[0]?.channels ?? 0,
    sampleRate: audioStreams[0]?.sampleRate ?? 0,
  }

  if (audioStreams.length === 0) {
    warnings.push('输入文件没有音频流，仅报告容器元数据。')
    return emptyReport({
      duration: containerDuration,
      format: formatFacts,
      sampleRate: opts.sampleRate,
      start: opts.start,
      warnings,
    })
  }

  // --- Choose and decode the analysis range --------------------------------
  // `start` and the analysis length are derived from ffprobe's (float) duration
  // when available. Files whose container has no duration (some raw/streamed
  // containers) fall back to decoding up to `maxSeconds` instead of giving up.
  let start
  let seconds
  if (containerDuration > 0) {
    start = clampNumber(opts.start, 0, Math.max(0, containerDuration - 0.01))
    seconds = Math.max(0, containerDuration - start)
    if (opts.duration !== null) seconds = Math.min(seconds, opts.duration)
  } else {
    start = Number.isFinite(opts.start) && opts.start > 0 ? opts.start : 0
    seconds = opts.duration !== null ? opts.duration : opts.maxSeconds
    warnings.push('容器时长未知，按 maxSeconds 上限解码分析。')
  }
  if (seconds > opts.maxSeconds) {
    warnings.push(`分析时长已限制为前 ${opts.maxSeconds} 秒（文件共 ${round2(containerDuration)} 秒，maxSeconds）。`)
    seconds = opts.maxSeconds
  }
  if (!(seconds > 0.05)) {
    warnings.push('请求的分析区间为空（起点已在音频结尾之后）。')
    return emptyReport({ duration: containerDuration, format: formatFacts, sampleRate: opts.sampleRate, start, warnings })
  }

  let decoded
  try {
    decoded = await decodePcm({ tools, file, workDir, start, seconds, sampleRate: opts.sampleRate, signal })
  } catch (error) {
    warnings.push(`无法解码音频流（${compactError(error)}），返回空报告。`)
    return emptyReport({ duration: containerDuration, format: formatFacts, sampleRate: opts.sampleRate, start, warnings })
  }
  throwIfAborted(signal)

  const { samples, sampleRate } = decoded
  const analyzedSeconds = samples.length / sampleRate
  if (!(analyzedSeconds > 0)) {
    warnings.push('解码后的音频为空，返回空报告。')
    return emptyReport({ duration: containerDuration, format: formatFacts, sampleRate, start, warnings })
  }

  const loudnessSample = measureSampleLoudness(samples, sampleRate)
  const r128 = await measureEbur128({ tools, file, start, seconds, workDir, signal })

  // A digitally silent track has no meaningful tempo/key/structure: report the
  // measured loudness and skip the spectral passes with an explicit warning.
  const silent = loudnessSample.peakDbfs <= -80 && loudnessSample.rmsDbfs <= -80
  if (silent) {
    warnings.push('音频为静音（采样峰值不高于 -80 dBFS），已跳过速度、调性、和弦与结构分析。')
  } else if (r128.lufsIntegrated === null) {
    warnings.push('无法测量 EBU R128 响度，LUFS 字段为 null，改用采样统计值。')
  }

  const analysis = silent
    ? buildSilentAnalysis({ samples, sampleRate, duration: analyzedSeconds })
    : await analyseSignal({ samples, sampleRate, analyzedSeconds, loudnessSample, opts, warnings, signal })

  // --- Loudness ------------------------------------------------------------
  // When ebur128 output was unusable the contract asks for an astats-derived
  // fallback; prefer those numbers over the raw decoded-sample statistics.
  const astats = r128.astats ?? null
  const loudness = {
    peakDbfs: roundTo(astats?.peakDbfs ?? loudnessSample.peakDbfs, 1),
    rmsDbfs: roundTo(astats?.rmsDbfs ?? loudnessSample.rmsDbfs, 1),
    lufsIntegrated: r128.lufsIntegrated === null ? null : roundTo(r128.lufsIntegrated, 1),
    loudnessRangeLu: r128.loudnessRangeLu === null ? null : roundTo(r128.loudnessRangeLu, 1),
    dynamicRangeDb: roundTo(loudnessSample.dynamicRangeDb, 1),
    clippingRatio: roundTo(loudnessSample.clippingRatio, 3),
    silenceRatio: roundTo(loudnessSample.silenceRatio, 3),
  }

  // --- Artifacts -----------------------------------------------------------
  let artifacts = {}
  if (opts.wantArtifacts) {
    artifacts = await renderArtifacts({
      tools,
      file,
      workDir,
      options: opts,
      start,
      seconds: analyzedSeconds,
      samples,
      sampleRate,
      chromaFrames: analysis.chromaFrames,
      energyCurve: analysis.energyCurve,
      signal,
      warnings,
    })
  }

  const report = {
    kind: 'audio',
    duration: round2(containerDuration),
    analyzed: {
      start: round2(start),
      seconds: round2(analyzedSeconds),
      sampleRate: Math.round(sampleRate),
    },
    format: {
      codec: String(formatFacts.codec || 'unknown'),
      container: String(formatFacts.container || 'unknown'),
      bitRate: Math.round(finiteNumber(formatFacts.bitRate)),
      channels: Math.round(finiteNumber(formatFacts.channels)),
      sampleRate: Math.round(finiteNumber(formatFacts.sampleRate)),
    },
    loudness,
    tempo: analysis.tempo,
    key: analysis.key,
    chroma: analysis.chroma,
    timbre: analysis.timbre,
    spectrum: analysis.spectrum,
    rhythm: analysis.rhythm,
    sections: analysis.sections,
    chords: analysis.chords,
    energyCurve: analysis.energyCurve,
    vocals: analysis.vocals,
    mood: analysis.mood,
    transcript: null,
    artifacts,
    warnings,
  }
  return scrubJson(report)
}

// ---------------------------------------------------------------------------
// Decoding and loudness
// ---------------------------------------------------------------------------

/**
 * Decode the selected range to mono float32 at `sampleRate`.
 *
 * The ffmpeg process runs with `cwd = workDir` and writes a RELATIVE file name:
 * Windows filter/argument escaping is the reason the contract forbids absolute
 * paths in filter options, so every side file here is kept relative.
 */
async function decodePcm({ tools, file, workDir, start, seconds, sampleRate, signal }) {
  const pcmName = 'ms-audio-pcm.f32'
  const args = [
    '-hide_banner', '-nostats', '-v', 'error', '-y',
    '-ss', startArg(start), '-t', secondsArg(seconds),
    '-i', file,
    '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', pcmName,
  ]
  const result = await run(tools.ffmpeg, args, {
    cwd: workDir,
    timeoutMs: childTimeoutMs(seconds, 1000, 60_000),
    signal,
  })
  if (result.code !== 0) throw new Error(tailText(result.stderr, 6) || `ffmpeg exited with code ${result.code}`)
  const pcmPath = join(workDir, pcmName)
  const info = await stat(pcmPath)
  const expectedSamples = Math.ceil(seconds * sampleRate) + sampleRate // small decoder padding allowance
  const maxBytes = Math.min(info.size, expectedSamples * 4)
  if (!(maxBytes >= 4)) return { samples: new Float32Array(0), sampleRate }
  // Read with a hard size cap: a broken container must not make the host read GBs.
  const handle = await open(pcmPath, 'r')
  let buffer
  try {
    buffer = Buffer.alloc(maxBytes - (maxBytes % 4))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead <= 0) break
      offset += bytesRead
    }
    buffer = buffer.subarray(0, offset - (offset % 4))
  } finally {
    await handle.close()
  }
  const count = Math.floor(buffer.length / 4)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i += 1) samples[i] = buffer.readFloatLE(i * 4)
  return { samples, sampleRate }
}

/**
 * Sample-domain loudness statistics from the decoded mono stream.
 * `dynamicRangeDb` is p95 - p10 of 3-second RMS windows (a short-term loudness
 * proxy; ebur128's LRA is reported separately).
 */
function measureSampleLoudness(samples, sampleRate) {
  const count = samples.length
  const windowSize = Math.max(1, Math.round(sampleRate))
  const secondCount = Math.max(1, Math.ceil(count / windowSize))
  const secondSums = new Float64Array(secondCount)
  const secondLengths = new Float64Array(secondCount)
  let peak = 0
  let sumSquares = 0
  let clipped = 0
  for (let i = 0; i < count; i += 1) {
    const value = samples[i]
    const magnitude = value < 0 ? -value : value
    if (magnitude > peak) peak = magnitude
    if (magnitude >= 0.999) clipped += 1
    const square = value * value
    sumSquares += square
    const second = Math.min(secondCount - 1, Math.floor(i / windowSize))
    secondSums[second] += square
    secondLengths[second] += 1
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, count))
  const perSecondRms = new Float64Array(secondCount)
  let silentWindows = 0
  let loudWindows = 0
  for (let s = 0; s < secondCount; s += 1) {
    const length = Math.max(1, secondLengths[s])
    const value = Math.sqrt(secondSums[s] / length)
    perSecondRms[s] = value
    const db = dsp.amplitudeToDb(value)
    if (db < -50) silentWindows += 1
    else loudWindows += 1
  }
  const shortTermDb = []
  for (let s = 0; s + 3 <= secondCount; s += 1) {
    const length = secondLengths[s] + secondLengths[s + 1] + secondLengths[s + 2]
    if (!(length > 0)) continue
    const value = Math.sqrt((secondSums[s] + secondSums[s + 1] + secondSums[s + 2]) / length)
    shortTermDb.push(dsp.amplitudeToDb(value))
  }
  let dynamicRangeDb = 0
  if (shortTermDb.length >= 2) {
    dynamicRangeDb = Math.max(0, dsp.percentile(shortTermDb, 0.95) - dsp.percentile(shortTermDb, 0.1))
  }
  return {
    peakDbfs: dsp.amplitudeToDb(peak),
    rmsDbfs: dsp.amplitudeToDb(rms),
    clippingRatio: count > 0 ? clipped / count : 0,
    silenceRatio: secondCount > 0 ? silentWindows / secondCount : 0,
    dynamicRangeDb,
    perSecondRms,
    loudWindows,
  }
}

/**
 * Read EBU R128 integrated loudness / loudness range / true peak from ffmpeg.
 * Returns `{lufsIntegrated: null, ...}` when the summary cannot be parsed, so
 * the caller can fall back to sample statistics without failing the analysis.
 */
async function measureEbur128({ tools, file, start, seconds, workDir, signal }) {
  const nulls = { lufsIntegrated: null, loudnessRangeLu: null, truePeakDbfs: null }
  const args = [
    '-hide_banner', '-nostats', '-v', 'info',
    '-ss', startArg(start), '-t', secondsArg(seconds),
    '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ]
  let stderr = ''
  try {
    const result = await run(tools.ffmpeg, args, {
      cwd: workDir,
      timeoutMs: childTimeoutMs(seconds, 1200, 60_000),
      signal,
      maxBuffer: 64 * 1024 * 1024,
    })
    stderr = result.stderr ?? ''
  } catch {
    return nulls
  }
  const parsed = parseEbur128(stderr)
  if (parsed.lufsIntegrated === null) {
    // Secondary fallback per the contract: astats sample levels (RMS/peak only).
    const astats = await runAstats({ tools, file, start, seconds, workDir, signal })
    if (astats !== null) parsed.astats = astats
  }
  return parsed
}

/** Parse the final `Summary:` block emitted by the ebur128 filter. */
export function parseEbur128(text) {
  const empty = { lufsIntegrated: null, loudnessRangeLu: null, truePeakDbfs: null }
  if (typeof text !== 'string' || text.length === 0) return empty
  const lastValue = (pattern) => {
    let match = null
    for (const candidate of text.matchAll(pattern)) match = candidate
    if (match === null) return null
    const value = Number.parseFloat(match[1])
    return Number.isFinite(value) ? value : null
  }
  return {
    lufsIntegrated: lastValue(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/gu),
    loudnessRangeLu: lastValue(/\bLRA:\s*(-?\d+(?:\.\d+)?)\s*LU/gu),
    truePeakDbfs: lastValue(/\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/gu),
  }
}

/** astats fallback for peak/RMS levels when ebur128 output is unusable. */
async function runAstats({ tools, file, start, seconds, workDir, signal }) {
  const args = [
    '-hide_banner', '-nostats', '-v', 'info',
    '-ss', startArg(start), '-t', secondsArg(seconds),
    '-i', file, '-vn', '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-',
  ]
  try {
    const result = await run(tools.ffmpeg, args, {
      cwd: workDir,
      timeoutMs: childTimeoutMs(seconds, 800, 60_000),
      signal,
      maxBuffer: 32 * 1024 * 1024,
    })
    const text = result.stderr ?? ''
    let peak = null
    let rms = null
    for (const match of text.matchAll(/Peak level dB:\s*(-?\d+(?:\.\d+)?)/gu)) peak = Number.parseFloat(match[1])
    for (const match of text.matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/gu)) rms = Number.parseFloat(match[1])
    return { peakDbfs: Number.isFinite(peak) ? peak : null, rmsDbfs: Number.isFinite(rms) ? rms : null }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Spectral analysis passes
// ---------------------------------------------------------------------------

/**
 * Pass A: onset envelope (log-mel spectral flux), pitch histogram for tuning,
 * and a 300-3400 Hz band envelope for the vocal modulation cue.
 *
 * n_fft = 2048 with hop 256 keeps the onset frame rate at ~86 Hz, which makes
 * autocorrelation lag quantisation small relative to the 120 BPM period.
 */
function analyseOnsets(samples, sampleRate, signal) {
  const frameRate = sampleRate / ONSET_HOP
  const frameCount = frameCountFor(samples.length, N_FFT, ONSET_HOP)
  const window = dsp.hann(N_FFT)
  const filters = dsp.melFilterbank(sampleRate, N_FFT, { bands: 40, fMin: 40, fMax: Math.min(11000, sampleRate / 2) })
  const flux = new Float64Array(frameCount)
  const bandEnvelope = new Float64Array(frameCount)
  const pitchHistogram = new Float64Array(1200)
  const real = new Float64Array(N_FFT)
  const imag = new Float64Array(N_FFT)
  const magnitudes = new Float64Array(N_FFT / 2 + 1)
  const logMel = new Float64Array(filters.length)
  let previousLogMel = null
  const binCount = N_FFT / 2
  for (let t = 0; t < frameCount; t += 1) {
    if ((t & 63) === 0) throwIfAborted(signal)
    const offset = t * ONSET_HOP
    real.fill(0)
    imag.fill(0)
    for (let i = 0; i < N_FFT; i += 1) real[i] = (samples[offset + i] ?? 0) * window[i]
    dsp.fft(real, imag)
    for (let k = 0; k <= binCount; k += 1) magnitudes[k] = Math.hypot(real[k], imag[k])
    // Mel energies + log compression (log1p is the usual perceptual compression).
    for (let b = 0; b < filters.length; b += 1) {
      const filter = filters[b]
      let energy = 0
      for (let i = 0; i < filter.weights.length; i += 1) {
        const magnitude = magnitudes[filter.start + i]
        energy += magnitude * magnitude * filter.weights[i]
      }
      logMel[b] = Math.log1p(energy)
    }
    if (t === 0) {
      flux[0] = 0
      previousLogMel = new Float64Array(filters.length)
    } else {
      flux[t] = dsp.spectralFlux(previousLogMel, logMel)
    }
    previousLogMel.set(logMel)
    // 300-3400 Hz band energy drives the 4-8 Hz vocal modulation cue.
    let bandEnergy = 0
    for (let k = 1; k <= binCount; k += 1) {
      const frequency = (k * sampleRate) / N_FFT
      if (frequency < 300 || frequency > 3400) continue
      bandEnergy += magnitudes[k] * magnitudes[k]
    }
    bandEnvelope[t] = Math.log1p(bandEnergy)
    dsp.accumulatePitchHistogram(magnitudes, sampleRate, N_FFT, pitchHistogram, { minHz: 300, maxHz: 4000 })
  }
  return { flux, bandEnvelope, pitchHistogram, frameRate, frameCount }
}

/**
 * Pass B: chroma frames at the contract's 2048/512 STFT plus aggregate spectral
 * shape features and per-second band statistics used by timbre, energy and
 * structure code.
 */
function analyseSpectra(samples, sampleRate, tuningCents, analyzedSeconds, signal) {
  const frameRate = sampleRate / CHROMA_HOP
  const frameCount = frameCountFor(samples.length, N_FFT, CHROMA_HOP)
  const secCount = Math.max(1, Math.floor(analyzedSeconds))
  const window = dsp.hann(N_FFT)
  const chromaFlat = new Float32Array(frameCount * 12)
  const bassChromaFlat = new Float32Array(frameCount * 12)
  const aggregatePower = new Float64Array(N_FFT / 2 + 1)
  const secLow = new Float64Array(secCount)
  const secMid = new Float64Array(secCount)
  const secHigh = new Float64Array(secCount)
  const secCentroidNumerator = new Float64Array(secCount)
  const secCentroidDenominator = new Float64Array(secCount)
  const secFrames = new Float64Array(secCount)
  const real = new Float64Array(N_FFT)
  const imag = new Float64Array(N_FFT)
  const magnitudes = new Float64Array(N_FFT / 2 + 1)
  const power = new Float64Array(N_FFT / 2 + 1)
  const binCount = N_FFT / 2
  let lowTotal = 0
  let midTotal = 0
  let highTotal = 0
  let centroidSum = 0
  let rolloffSum = 0
  let flatnessSum = 0
  let weightSum = 0
  for (let t = 0; t < frameCount; t += 1) {
    if ((t & 63) === 0) throwIfAborted(signal)
    const offset = t * CHROMA_HOP
    real.fill(0)
    imag.fill(0)
    for (let i = 0; i < N_FFT; i += 1) real[i] = (samples[offset + i] ?? 0) * window[i]
    dsp.fft(real, imag)
    let frameEnergy = 0
    let low = 0
    let mid = 0
    let high = 0
    let centroidNumerator = 0
    let magnitudeSum = 0
    let logPowerSum = 0
    for (let k = 1; k <= binCount; k += 1) {
      const magnitude = Math.hypot(real[k], imag[k])
      magnitudes[k] = magnitude
      const binPower = magnitude * magnitude
      power[k] = binPower
      aggregatePower[k] += binPower
      const frequency = (k * sampleRate) / N_FFT
      frameEnergy += binPower
      centroidNumerator += magnitude * frequency
      magnitudeSum += magnitude
      logPowerSum += Math.log(binPower + 1e-20)
      if (frequency < 200) low += binPower
      else if (frequency < 2000) mid += binPower
      else high += binPower
    }
    lowTotal += low
    midTotal += mid
    highTotal += high
    // Energy-weighted averages avoid letting near-silent frames dominate timbre.
    if (frameEnergy > 1e-12 && magnitudeSum > 1e-12) {
      const centroid = centroidNumerator / magnitudeSum
      let cumulative = 0
      let rolloff = sampleRate / 2
      const target = magnitudeSum * 0.85
      for (let k = 1; k <= binCount; k += 1) {
        cumulative += magnitudes[k]
        if (cumulative >= target) {
          rolloff = (k * sampleRate) / N_FFT
          break
        }
      }
      const geometric = Math.exp(logPowerSum / binCount)
      const arithmetic = frameEnergy / binCount
      const flatness = arithmetic > 1e-20 ? dsp.clamp(geometric / arithmetic, 0, 1) : 0
      centroidSum += centroid * frameEnergy
      rolloffSum += rolloff * frameEnergy
      flatnessSum += flatness * frameEnergy
      weightSum += frameEnergy
    }
    // Chroma: normalise per frame, then median-filter across time afterwards.
    // 55 Hz floor keeps the bass fundamentals (C2 = 65 Hz) symmetric with the
    // other chord roots; the bass-range chroma feeds the chord-root cue.
    const chroma = dsp.chromaFromSpectrum(magnitudes, sampleRate, N_FFT, { tuningCents, minHz: 55, maxHz: 5000 })
    dsp.normaliseVector(chroma)
    chromaFlat.set(chroma, t * 12)
    const bassChroma = dsp.chromaFromSpectrum(magnitudes, sampleRate, N_FFT, { tuningCents, minHz: 58, maxHz: 320 })
    dsp.normaliseVector(bassChroma)
    bassChromaFlat.set(bassChroma, t * 12)
    // Per-second bucket accumulators (structure features / energy curve).
    const centreTime = (offset + N_FFT / 2) / sampleRate
    const second = clampNumber(Math.floor(centreTime), 0, secCount - 1)
    secLow[second] += low
    secMid[second] += mid
    secHigh[second] += high
    secCentroidNumerator[second] += centroidNumerator
    secCentroidDenominator[second] += magnitudeSum
    secFrames[second] += 1
  }
  return {
    chromaFlat,
    bassChromaFlat,
    frameCount,
    frameRate,
    aggregatePower,
    secLow,
    secMid,
    secHigh,
    secCentroidNumerator,
    secCentroidDenominator,
    secFrames,
    lowTotal,
    midTotal,
    highTotal,
    centroidHz: weightSum > 0 ? centroidSum / weightSum : 0,
    rolloffHz: weightSum > 0 ? rolloffSum / weightSum : 0,
    flatness: weightSum > 0 ? flatnessSum / weightSum : 0,
  }
}

/**
 * Frame times of the chroma pass (window centre in seconds).
 */
function chromaFrameTimes(frameCount, sampleRate) {
  const times = new Float64Array(frameCount)
  for (let t = 0; t < frameCount; t += 1) times[t] = (t * CHROMA_HOP + N_FFT / 2) / sampleRate
  return times
}

/**
 * Median-filter (width 3) a flat frame-major chroma matrix and re-normalise.
 * Returns plain Float64Array frames so the dsp helpers can consume them.
 */
function smoothChromaFrames(chromaFlat, frameCount) {
  const frames = new Array(frameCount)
  const previous = new Float64Array(12)
  const current = new Float64Array(12)
  const next = new Float64Array(12)
  for (let t = 0; t < frameCount; t += 1) {
    for (let b = 0; b < 12; b += 1) {
      previous[b] = t > 0 ? chromaFlat[(t - 1) * 12 + b] : chromaFlat[t * 12 + b]
      current[b] = chromaFlat[t * 12 + b]
      next[b] = t < frameCount - 1 ? chromaFlat[(t + 1) * 12 + b] : chromaFlat[t * 12 + b]
    }
    const filtered = new Float64Array(12)
    for (let b = 0; b < 12; b += 1) {
      const a = Math.min(previous[b], current[b], next[b])
      const c = Math.max(previous[b], current[b], next[b])
      filtered[b] = previous[b] + current[b] + next[b] - a - c
    }
    dsp.normaliseVector(filtered)
    frames[t] = filtered
  }
  return frames
}

// ---------------------------------------------------------------------------
// Full signal analysis (non-silent path)
// ---------------------------------------------------------------------------

/**
 * Run every measurement that needs actual samples and assemble the report
 * fields other than loudness/artifacts. Pure CPU; the only async work is none.
 */
async function analyseSignal({ samples, sampleRate, analyzedSeconds, loudnessSample, opts, warnings, signal }) {
  // --- Pass A ------------------------------------------------------------
  const onset = analyseOnsets(samples, sampleRate, signal)
  const onsetEnvelope = dsp.normaliseOnsetEnvelope(onset.flux, 16)
  const tuningCents = dsp.estimateTuning(onset.pitchHistogram)

  // --- Pass B ------------------------------------------------------------
  const spectral = analyseSpectra(samples, sampleRate, tuningCents, analyzedSeconds, signal)
  const chromaFrames = smoothChromaFrames(spectral.chromaFlat, spectral.frameCount)
  const frameTimes = chromaFrameTimes(spectral.frameCount, sampleRate)
  const meanChroma = dsp.normaliseVector(dsp.meanVectors(chromaFrames))
  const chromaReport = buildChromaReport(meanChroma)

  // --- Key ---------------------------------------------------------------
  let key = null
  if (analyzedSeconds >= MIN_SECONDS_FOR_KEY) {
    const detected = dsp.detectKey(meanChroma, { tuningCents })
    // A flat chroma (no tonal content) correlates weakly with every profile;
    // refuse to report a key in that case instead of inventing one.
    if (detected && detected.confidence >= MIN_KEY_CONFIDENCE && Math.abs(detected.candidates[0]?.score ?? 0) >= 0.12) {
      key = detected
    }
  }
  if (key === null) warnings.push('无法可靠估计调性（音频过短、缺少稳定音高内容或置信度过低）。')

  // --- Rhythm / onset events --------------------------------------------
  const onsetEvents = detectOnsetEvents(onsetEnvelope, onset.frameRate)
  const onsetsPerSecond = analyzedSeconds > 0 ? onsetEvents.length / analyzedSeconds : 0
  const rhythm = buildRhythmReport({ onsetsPerSecond })

  // --- Tempo + beats -----------------------------------------------------
  let rawTempo = { bpm: null, bpmCandidates: [], confidence: 0 }
  if (analyzedSeconds >= MIN_SECONDS_FOR_TEMPO) {
    rawTempo = dsp.estimateTempo(onsetEnvelope, onset.frameRate)
  }
  // A tempo below the confidence floor (e.g. steady drones, free-time material)
  // or material without enough rhythmic onsets is not reported as a number: the
  // candidates stay visible for diagnostics.
  const enoughOnsets = onsetsPerSecond >= MIN_TEMPO_ONSETS_PER_SECOND
  const bpm = rawTempo.bpm !== null && rawTempo.confidence >= MIN_TEMPO_CONFIDENCE && enoughOnsets ? rawTempo.bpm : null
  // Onset-envelope frame times use the window-start convention, so shift beat
  // times by half an STFT window to get close to the audible transients.
  const frameTimeOffset = N_FFT / (2 * sampleRate)
  const beats = bpm === null
    ? null
    : dsp.trackBeats(onsetEnvelope, onset.frameRate, bpm, { timeOffsetSeconds: frameTimeOffset })
  const beatTimes = beats?.beatTimes ?? []
  const beatIndices = beats?.beatIndices ?? []
  const timeSignatureGuess = beatTimes.length >= 8 ? dsp.guessTimeSignature(onsetEnvelope, beatIndices, onset.frameRate) : 4
  if (bpm === null) {
    if (analyzedSeconds < MIN_SECONDS_FOR_TEMPO) {
      warnings.push(`音频仅 ${round2(analyzedSeconds)} 秒，速度、节拍与和弦分析至少需要 ${MIN_SECONDS_FOR_TEMPO} 秒。`)
    } else if (!enoughOnsets) {
      warnings.push('节奏性起音过少，无法可靠估计速度（bpm 为 null）。')
    } else if (rawTempo.bpm !== null) {
      warnings.push('速度估计置信度过低，速度与节拍字段为 null。')
    } else {
      warnings.push('无法可靠估计速度，速度字段为 null。')
    }
  }
  const tempo = {
    bpm: bpm === null ? null : roundTo(bpm, 1),
    bpmCandidates: rawTempo.bpmCandidates.map((value) => roundTo(value, 1)),
    confidence: roundTo(rawTempo.confidence, 3),
    beatCount: beatTimes.length,
    beatTimes: beatTimes.slice(0, 64).map((time) => round2(time)),
    timeSignatureGuess,
    regularity: beats === null ? 0 : roundTo(beats.regularity, 3),
  }

  // --- Chords ------------------------------------------------------------
  const chords = opts.wantChords
    ? buildChordReport({
      chromaFrames,
      bassChromaFlat: spectral.bassChromaFlat,
      frameTimes,
      beatTimes,
      samples,
      sampleRate,
      seconds: analyzedSeconds,
      bpm,
    })
    : null

  // --- Structure ---------------------------------------------------------
  const structure = buildStructureReport({
    chromaFrames,
    frameTimes,
    onsetEnvelope,
    onsetFrameRate: onset.frameRate,
    onsetsPerSecond,
    spectral,
    samples,
    sampleRate,
    seconds: analyzedSeconds,
    globalBpm: bpm,
    key,
    wantStructure: opts.wantStructure,
    warnings,
    signal,
  })

  // --- Timbre / spectrum / energy curve ---------------------------------
  const timbre = buildTimbreReport({
    centroidHz: spectral.centroidHz,
    rolloffHz: spectral.rolloffHz,
    flatness: spectral.flatness,
    zeroCrossRate: dsp.zeroCrossingRate(samples),
  })
  const energyTotal = spectral.lowTotal + spectral.midTotal + spectral.highTotal
  const spectrum = {
    lowRatio: roundTo(energyTotal > 0 ? spectral.lowTotal / energyTotal : 0, 3),
    midRatio: roundTo(energyTotal > 0 ? spectral.midTotal / energyTotal : 0, 3),
    highRatio: roundTo(energyTotal > 0 ? spectral.highTotal / energyTotal : 0, 3),
  }
  const energyCurve = buildEnergyCurve({
    samples,
    sampleRate,
    seconds: analyzedSeconds,
    spectral,
  })

  // --- Heuristics: vocals + mood ----------------------------------------
  const midBand = dsp.bandEnergy(spectral.aggregatePower, sampleRate, N_FFT, 300, 3400)
  const midBandShare = midBand.total > 1e-20 ? dsp.clamp(midBand.band / midBand.total, 0, 1) : 0
  const meanSharpness = dsp.mean(chromaFrames.map((frame) => dsp.chromaSharpness(frame)))
  const tonalScore = dsp.clamp((meanSharpness - 1 / 12) / (1 - 1 / 12), 0, 1)
  const modulationShare = dsp.modulationEnergyShare(onset.bandEnvelope, onset.frameRate, 4, 8)
  const vocals = buildVocalsReport({ midBandShare, tonalScore, modulationShare, onsetsPerSecond })
  const mood = buildMoodReport({
    bpm,
    rmsDbfs: loudnessSample.rmsDbfs,
    onsetsPerSecond,
    key,
    centroidHz: spectral.centroidHz,
    flatness: spectral.flatness,
  })

  return {
    chromaFrames,
    chroma: chromaReport,
    key,
    tempo,
    rhythm,
    chords,
    sections: structure.sections,
    timbre,
    spectrum,
    energyCurve,
    vocals,
    mood,
  }
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

function buildChromaReport(meanChroma) {
  const max = Math.max(...meanChroma, 1e-9)
  const values = Array.from(meanChroma, (value) => roundTo(dsp.clamp(value / max, 0, 1), 3))
  return { mean: values, labels: [...dsp.PITCH_CLASS_NAMES] }
}

function buildRhythmReport({ onsetsPerSecond }) {
  const density = onsetsPerSecond < 1.5 ? 'sparse' : onsetsPerSecond < 4 ? 'moderate' : 'dense'
  return {
    // onsetRate is kept as an alias of onsetsPerSecond for contract compatibility.
    onsetRate: roundTo(onsetsPerSecond, 3),
    onsetsPerSecond: roundTo(onsetsPerSecond, 3),
    percussionDensity: density,
  }
}

function buildTimbreReport({ centroidHz, rolloffHz, flatness, zeroCrossRate }) {
  const cent = finiteNumber(centroidHz)
  const brightness = cent < 800 ? 'dark' : cent < 2000 ? 'warm' : cent < 4000 ? 'neutral' : 'bright'
  const brightnessText = {
    dark: '低沉偏暗',
    warm: '温暖',
    neutral: '中性',
    bright: '明亮',
  }[brightness]
  const noisiness = flatness > 0.45 ? '噪声型' : flatness > 0.25 ? '略带纹理的' : '谐波型'
  return {
    centroidHz: Math.round(cent),
    rolloffHz: Math.round(finiteNumber(rolloffHz)),
    flatness: roundTo(flatness, 3),
    zeroCrossRate: roundTo(zeroCrossRate, 3),
    brightness,
    description: `${brightnessText}、${noisiness}音色（频谱质心约 ${Math.round(cent)} Hz）。`,
  }
}

/**
 * Energy curve: one point per second (or ≤240 points for long files) with
 * normalised RMS plus low (<200 Hz) and high (>2 kHz) energy shares.
 */
function buildEnergyCurve({ samples, sampleRate, seconds, spectral }) {
  const secondCount = Math.max(1, Math.floor(seconds))
  const pointCount = Math.min(MAX_ENERGY_POINTS, secondCount)
  const groupSize = secondCount / pointCount
  const perSecondRms = new Float64Array(secondCount)
  const windowSize = Math.max(1, Math.round(sampleRate))
  const sums = new Float64Array(secondCount)
  const lengths = new Float64Array(secondCount)
  for (let i = 0; i < samples.length; i += 1) {
    const second = Math.min(secondCount - 1, Math.floor(i / windowSize))
    sums[second] += samples[i] * samples[i]
    lengths[second] += 1
  }
  let maxRms = 0
  for (let s = 0; s < secondCount; s += 1) {
    perSecondRms[s] = Math.sqrt(sums[s] / Math.max(1, lengths[s]))
    if (perSecondRms[s] > maxRms) maxRms = perSecondRms[s]
  }
  const points = []
  for (let point = 0; point < pointCount; point += 1) {
    const startSecond = Math.floor(point * groupSize)
    const endSecond = Math.max(startSecond + 1, Math.floor((point + 1) * groupSize))
    let rms = 0
    let low = 0
    let mid = 0
    let high = 0
    let count = 0
    for (let s = startSecond; s < Math.min(secondCount, endSecond); s += 1) {
      rms += perSecondRms[s]
      low += spectral.secLow[s]
      mid += spectral.secMid[s]
      high += spectral.secHigh[s]
      count += 1
    }
    const bandTotal = low + mid + high
    points.push({
      t: round2(startSecond),
      rms: roundTo(maxRms > 0 ? rms / count / maxRms : 0, 3),
      low: roundTo(bandTotal > 0 ? low / bandTotal : 0, 3),
      high: roundTo(bandTotal > 0 ? high / bandTotal : 0, 3),
    })
  }
  return points
}

/** Heuristic vocal presence (band energy + 4-8 Hz modulation + harmonicity). */
function buildVocalsReport({ midBandShare, tonalScore, modulationShare, onsetsPerSecond }) {
  const bandScore = dsp.clamp((midBandShare - 0.25) / 0.45, 0, 1)
  const modulationScore = dsp.clamp((modulationShare - 0.05) / 0.3, 0, 1)
  const densityPenalty = dsp.clamp((onsetsPerSecond - 6) / 4, 0, 1) * 0.25
  const score = dsp.clamp(0.42 * bandScore + 0.33 * tonalScore + 0.25 * modulationScore - densityPenalty, 0, 1)
  const present = score >= 0.55
  const confidence = present ? dsp.clamp(0.4 + 0.55 * score, 0, 0.95) : dsp.clamp(0.45 + 0.45 * (1 - score), 0, 0.95)
  return {
    present,
    confidence: roundTo(confidence, 3),
    note: present
      ? '启发式判断：中频能量、4-8 Hz 调制与谐波结构提示人声较突出。'
      : '启发式判断：人声线索不明显（4-8 Hz 调制偏弱，或中频主要被打击乐占据）。',
  }
}

/** Mood: arousal from tempo/level/onset density, valence from mode/brightness. */
function buildMoodReport({ bpm, rmsDbfs, onsetsPerSecond, key, centroidHz, flatness }) {
  const bpmScore = dsp.clamp(((bpm ?? 100) - 60) / 90, 0, 1)
  const rmsScore = dsp.clamp((finiteNumber(rmsDbfs) + 30) / 25, 0, 1)
  const onsetScore = dsp.clamp(onsetsPerSecond / 6, 0, 1)
  const arousal = dsp.clamp(0.45 * bpmScore + 0.3 * rmsScore + 0.25 * onsetScore, 0, 1)
  const modeBias = key === null ? 0 : key.mode === 'major' ? 0.18 : -0.14
  const brightnessScore = dsp.clamp(finiteNumber(centroidHz) / 4000, 0, 1)
  const noiseScore = dsp.clamp(flatness * 2, 0, 1)
  const valence = dsp.clamp(0.5 + modeBias + 0.28 * (brightnessScore - 0.5) - 0.08 * noiseScore, 0, 1)
  const energyLabels = arousal < 0.34 ? ['calm', 'mellow', 'quiet'] : arousal < 0.66 ? ['steady', 'moderate', 'groovy'] : ['energetic', 'driving', 'intense']
  const moodLabels = valence < 0.4 ? ['dark', 'melancholic', 'tense'] : valence < 0.6 ? ['neutral', 'bittersweet', 'reflective'] : ['bright', 'happy', 'uplifting']
  const labels = [...new Set([energyLabels[0], moodLabels[0], energyLabels[2]])]
  const tempoText = bpm === null ? '速度不明' : bpm >= 130 ? '偏快' : bpm >= 95 ? '中速' : '偏慢'
  const modeText = key === null ? '调性不明' : key.mode === 'major' ? '大调色彩' : '小调色彩'
  const levelText = rmsScore > 0.66 ? '响度较高' : rmsScore > 0.33 ? '响度中等' : '响度偏低'
  const moodEnergyText = arousal < 0.34 ? '平静' : arousal < 0.66 ? '舒展' : '活跃'
  const moodValenceText = valence < 0.4 ? '阴郁' : valence < 0.6 ? '中性' : '明快'
  return {
    arousal: roundTo(arousal, 3),
    valence: roundTo(valence, 3),
    labels: labels.slice(0, 3),
    note: `${tempoText}、${levelText}、${modeText}，整体听感偏${moodEnergyText}、${moodValenceText}。`,
  }
}

/**
 * Beat-synchronous chord estimation: 24 triad cosine templates + Viterbi.
 *
 * Two practical refinements over raw template matching keep the output musical:
 * - Beats whose RMS is far below the median (intros, drum breaks) are treated as
 *   "no chord" and left out of the progression instead of forcing a triad from
 *   percussive noise.
 * - The bass-register chroma (58-320 Hz, sampled after the beat transient) adds
 *   a root-support bonus, which disambiguates relative chords such as C vs Am
 *   and C vs G when the melody shares notes with several triads.
 */
function buildChordReport({ chromaFrames, bassChromaFlat, frameTimes, beatTimes, samples, sampleRate, seconds, bpm }) {
  if (!(bpm > 0) || beatTimes.length < 4 || frameTimes.length === 0) return null
  const beatPeriod = 60 / bpm
  const templates = dsp.chordTemplates()
  const beats = []
  let frameIndex = 0
  for (let beat = 0; beat < beatTimes.length; beat += 1) {
    const start = beatTimes[beat]
    const end = beat + 1 < beatTimes.length ? beatTimes[beat + 1] : Math.min(seconds, start + beatPeriod)
    while (frameIndex < frameTimes.length && frameTimes[frameIndex] < start) frameIndex += 1
    let scan = frameIndex
    const chroma = new Float64Array(12)
    const bass = new Float64Array(12)
    let count = 0
    while (scan < frameTimes.length && frameTimes[scan] < end) {
      for (let b = 0; b < 12; b += 1) chroma[b] += chromaFrames[scan][b]
      // Skip the first 45% of the beat so the kick/snare transient does not
      // dominate the low-register root estimate.
      if (frameTimes[scan] >= start + 0.45 * (end - start)) {
        for (let b = 0; b < 12; b += 1) bass[b] += bassChromaFlat[scan * 12 + b]
      }
      count += 1
      scan += 1
    }
    if (count === 0) {
      // Very tight beat window: fall back to the nearest single frame.
      const nearest = clampNumber(Math.round((start / Math.max(seconds, 1e-6)) * (frameTimes.length - 1)), 0, frameTimes.length - 1)
      for (let b = 0; b < 12; b += 1) {
        chroma[b] = chromaFrames[nearest][b]
        bass[b] = bassChromaFlat[nearest * 12 + b]
      }
    }
    dsp.normaliseVector(chroma)
    dsp.normaliseVector(bass)
    let root = 0
    for (let b = 1; b < 12; b += 1) if (bass[b] > bass[root]) root = b
    beats.push({ time: start, end, chroma, root, rootShare: bass[root], rms: rmsOfRange(samples, sampleRate, start, end) })
  }
  // Gate out non-tonal beats (silence, drums-only intros, breaks).
  const sortedRms = beats.map((beat) => beat.rms).sort((a, b) => a - b)
  const medianRms = sortedRms.length > 0 ? dsp.percentile(sortedRms, 0.5) : 0
  const gate = Math.max(0.01, medianRms * 0.42)
  const tonalBeats = beats.filter((beat) => beat.rms >= gate)
  if (tonalBeats.length < 4) return null
  const rootBonusOf = (templateIndex, beat) => (templates[templateIndex].root === beat.root ? CHORD_ROOT_BONUS * beat.rootShare : 0)
  const emissions = tonalBeats.map((beat) => {
    const emission = new Float64Array(templates.length)
    for (const entry of dsp.scoreChordTemplates(beat.chroma, templates)) {
      emission[entry.index] = entry.score + rootBonusOf(entry.index, beat)
    }
    return emission
  })
  const states = dsp.viterbiDecode(emissions, 0.08)
  const segments = []
  for (let index = 0; index < states.length; index += 1) {
    const state = states[index]
    const beat = tonalBeats[index]
    const last = segments[segments.length - 1]
    const confidence = emissions[index][state] - rootBonusOf(state, beat)
    if (last !== undefined && last.state === state) {
      last.end = beat.end
      last.scores.push(confidence)
      continue
    }
    segments.push({ state, start: beat.time, end: beat.end, scores: [confidence] })
  }
  const progression = segments.map((segment) => ({
    start: round2(segment.start),
    end: round2(Math.min(seconds, segment.end)),
    name: templates[segment.state].name,
    confidence: roundTo(dsp.clamp(dsp.mean(segment.scores), 0, 1), 3),
  }))
  const uniqueNames = [...new Set(progression.map((entry) => entry.name))]
  const progressionSeconds = Math.max(0, progression[progression.length - 1].end - progression[0].start)
  return {
    progression,
    uniqueNames,
    // Chord changes per second across the analysed progression.
    rate: roundTo(progression.length / Math.max(progressionSeconds, 1e-6), 3),
  }
}

/**
 * Structure: 1 Hz feature frames -> cosine self-similarity -> Foote checkerboard
 * novelty -> peak picking with a minimum spacing. Falls back to energy change
 * points (and finally even thirds) when the novelty curve is inconclusive.
 */
function buildStructureReport({
  chromaFrames,
  frameTimes,
  onsetEnvelope,
  onsetFrameRate,
  onsetsPerSecond,
  spectral,
  samples,
  sampleRate,
  seconds,
  globalBpm,
  wantStructure,
  warnings,
  signal,
}) {
  if (!(wantStructure && seconds >= MIN_SECONDS_FOR_STRUCTURE)) {
    return { sections: [singleSection({ seconds, samples, sampleRate, bpm: globalBpm, onsetsPerSecond, spectral })] }
  }
  const secCount = Math.max(1, Math.floor(seconds))
  const chromaPerSecond = Array.from({ length: secCount }, () => new Float64Array(12))
  const chromaCounts = new Float64Array(secCount)
  for (let t = 0; t < frameTimes.length; t += 1) {
    const second = clampNumber(Math.floor(frameTimes[t]), 0, secCount - 1)
    for (let b = 0; b < 12; b += 1) chromaPerSecond[second][b] += chromaFrames[t][b]
    chromaCounts[second] += 1
  }
  // Onset flux per second (pass A frames are at a different hop).
  const fluxPerSecond = new Float64Array(secCount)
  for (let t = 0; t < onsetEnvelope.length; t += 1) {
    const centre = (t * ONSET_HOP + N_FFT / 2) / sampleRate
    const second = clampNumber(Math.floor(centre), 0, secCount - 1)
    fluxPerSecond[second] += onsetEnvelope[t]
  }
  const rmsPerSecond = new Float64Array(secCount)
  const windowSize = Math.max(1, Math.round(sampleRate))
  const sums = new Float64Array(secCount)
  for (let i = 0; i < samples.length; i += 1) {
    sums[clampNumber(Math.floor(i / windowSize), 0, secCount - 1)] += samples[i] * samples[i]
  }
  let maxRms = 0
  for (let s = 0; s < secCount; s += 1) {
    rmsPerSecond[s] = Math.sqrt(sums[s] / windowSize)
    maxRms = Math.max(maxRms, rmsPerSecond[s])
  }
  let maxFlux = 0
  for (let s = 0; s < secCount; s += 1) maxFlux = Math.max(maxFlux, fluxPerSecond[s])
  const features = []
  for (let s = 0; s < secCount; s += 1) {
    const feature = new Float64Array(17)
    const chromaSum = new Float64Array(12)
    if (chromaCounts[s] > 0) {
      for (let b = 0; b < 12; b += 1) chromaSum[b] = chromaPerSecond[s][b] / chromaCounts[s]
    }
    dsp.normaliseVector(chromaSum)
    for (let b = 0; b < 12; b += 1) feature[b] = chromaSum[b] * 1.1
    feature[12] = maxRms > 0 ? (rmsPerSecond[s] / maxRms) * 1.4 : 0
    feature[13] = maxFlux > 0 ? (fluxPerSecond[s] / maxFlux) * 1 : 0
    const bandTotal = spectral.secLow[s] + spectral.secMid[s] + spectral.secHigh[s]
    feature[14] = bandTotal > 0 ? (spectral.secLow[s] / bandTotal) * 0.7 : 0
    feature[15] = bandTotal > 0 ? (spectral.secHigh[s] / bandTotal) * 0.7 : 0
    const centroid = spectral.secCentroidDenominator[s] > 0 ? spectral.secCentroidNumerator[s] / spectral.secCentroidDenominator[s] : 0
    feature[16] = dsp.clamp(centroid / 4000, 0, 1) * 0.7
    dsp.normaliseVector(feature)
    features.push(feature)
  }
  const matrix = dsp.selfSimilarityMatrix(features)
  const kernelHalf = dsp.clamp(Math.round(secCount / 8), 2, 8)
  const novelty = dsp.checkerboardNovelty(matrix, kernelHalf)
  // Ignore novelty at the very edges: a section needs at least a few seconds.
  const edge = 2
  for (let i = 0; i < novelty.length; i += 1) if (i < edge || i > secCount - 1 - edge) novelty[i] = 0
  const threshold = dsp.mean(novelty) + 0.6 * dsp.stdDev(novelty)
  const noveltyPeaks = dsp.peakPick(novelty, { minSpacing: Math.max(3, Math.round(secCount / 8)), threshold })
  // Foote novelty tracks timbre/harmony change; a sustained loudness step is
  // also a real section boundary (e.g. a chorus that only gets bigger). Rank
  // both candidate lists together, then keep the strongest boundaries subject
  // to a minimum section length and an average-section-length prior.
  const boundaries = selectSectionBoundaries({
    noveltyPeaks,
    novelty,
    levelCandidates: detectLevelChangeBoundaries(rmsPerSecond),
    seconds,
    secCount,
  })
  if (boundaries.length === 0) {
    // Uniform material: report one honest section instead of inventing splits.
    warnings.push('未检测到明显的段落或响度变化，整个片段按单一段落处理。')
    return { sections: [wholeClipSection({ seconds, onsetDensity: onsetsPerSecond, spectral, bpm: globalBpm })] }
  }
  const sections = []
  const starts = [0, ...boundaries.filter((value) => value > 0.5 && value < seconds - 0.5), seconds]
  const sectionRms = []
  for (let i = 0; i < starts.length - 1; i += 1) {
    throwIfAborted(signal)
    const sectionStart = starts[i]
    const sectionEnd = starts[i + 1]
    const rms = rmsOfRange(samples, sampleRate, sectionStart, sectionEnd)
    sectionRms.push(rms)
    const beatsInSection = Math.max(0, Math.round((sectionEnd - sectionStart) / (globalBpm ? 60 / globalBpm : 0.5)))
    const sectionBpm = estimateSectionTempo(onsetEnvelope, onsetFrameRate, sectionStart, sectionEnd, globalBpm)
    const centroid = averageCentroidForRange(spectral, sectionStart, sectionEnd)
    const onsetDensity = onsetsPerSecond
    sections.push({
      start: round2(sectionStart),
      end: round2(sectionEnd),
      duration: round2(sectionEnd - sectionStart),
      label: 'section',
      energy: 0,
      bpm: sectionBpm === null ? null : roundTo(sectionBpm, 1),
      note: '',
      beats: beatsInSection,
      brightness: Math.round(centroid),
    })
  }
  const maxSectionRms = Math.max(...sectionRms, 1e-12)
  sections.forEach((section, index) => {
    section.energy = roundTo(sectionRms[index] / maxSectionRms, 3)
  })
  labelSections(sections)
  for (const section of sections) {
    section.note = sectionNote({
      energyRel: section.energy,
      onsetsPerSecond,
      centroidHz: section.brightness,
      hasChords: section.energy > 0.35,
    })
    delete section.brightness
    delete section.beats
  }
  return { sections }
}

/** A single fallback section covering the whole analysed clip. */
function singleSection({ seconds, samples, sampleRate, bpm, onsetsPerSecond, spectral }) {
  const rms = rmsOfRange(samples, sampleRate, 0, seconds)
  const centroid = averageCentroidForRange(spectral, 0, seconds)
  return {
    start: 0,
    end: round2(seconds),
    duration: round2(seconds),
    label: 'section 1',
    energy: 1,
    bpm: bpm === null ? null : roundTo(bpm, 1),
    note: `片段过短，未做段落结构分析；${onsetsPerSecond > 2.5 ? '节奏较活跃' : '节奏稀疏'}，音色${centroid > 2000 ? '偏明亮' : '偏暗沉'}。`,
  }
}

/**
 * Section boundaries from sustained loudness steps: compare the mean level of
 * the 3 s before and after each second, in dB. A >= 1.5 dB step is a structural
 * change even when harmony/timbre stay similar (quiet intro -> full band, or a
 * chorus that mainly gets louder).
 *
 * @returns {Array<{index: number, score: number}>} unmerged candidates
 */
function detectLevelChangeBoundaries(rmsPerSecond) {
  const count = rmsPerSecond.length
  const candidates = []
  if (count < 8) return candidates
  const db = new Float64Array(count)
  for (let s = 0; s < count; s += 1) db[s] = dsp.amplitudeToDb(rmsPerSecond[s], -90)
  for (let i = 3; i <= count - 3; i += 1) {
    const before = (db[i - 3] + db[i - 2] + db[i - 1]) / 3
    const after = (db[i] + db[i + 1] + db[i + 2]) / 3
    const change = after - before
    if (Math.abs(change) >= 1.5) candidates.push({ index: i, score: Math.abs(change) })
  }
  // A single step produces several overlapping candidates (the 3 s window
  // slides across it); keep only the strongest one per neighbourhood.
  candidates.sort((a, b) => b.score - a.score)
  const minSpacing = Math.max(3, Math.round(count / 8))
  const kept = []
  for (const candidate of candidates) {
    if (kept.every((entry) => Math.abs(entry.index - candidate.index) >= minSpacing)) kept.push(candidate)
  }
  return kept.sort((a, b) => a.index - b.index)
}

/**
 * Fuse Foote novelty peaks with loudness-change candidates, then keep the
 * strongest boundaries under two musicality constraints:
 * - every section is at least ~(duration/6, capped at 6) s long;
 * - on average a section is at least ~6 s long (a 20 s excerpt cannot
 *   meaningfully contain five sections).
 *
 * @returns {number[]} ascending boundary indices (seconds)
 */
function selectSectionBoundaries({ noveltyPeaks, novelty, levelCandidates, seconds, secCount }) {
  const maxNovelty = Math.max(1e-9, ...novelty)
  const maxLevel = Math.max(1e-9, ...levelCandidates.map((candidate) => candidate.score))
  const candidates = noveltyPeaks.map((index) => ({ index, score: dsp.clamp(novelty[index] / maxNovelty, 0, 1) }))
  for (const level of levelCandidates) {
    const near = candidates.find((candidate) => Math.abs(candidate.index - level.index) <= 2)
    const score = dsp.clamp(level.score / maxLevel, 0, 1)
    if (near !== undefined) {
      near.index = level.index // a level step is a sharper locator than a novelty peak
      near.score = Math.max(near.score, score)
    } else {
      candidates.push({ index: level.index, score })
    }
  }
  const minSection = Math.max(2, Math.min(6, seconds / 6))
  const minSpacing = Math.max(3, Math.round(secCount / 8))
  const maxBoundaries = Math.min(12, Math.max(1, Math.floor(seconds / 6) - 1))
  candidates.sort((a, b) => b.score - a.score)
  const chosen = []
  for (const candidate of candidates) {
    if (chosen.length >= maxBoundaries) break
    if (candidate.index < minSection || candidate.index > seconds - minSection) continue
    if (chosen.every((index) => Math.abs(index - candidate.index) >= minSpacing)) chosen.push(candidate.index)
  }
  return chosen.sort((a, b) => a - b)
}

/** Whole-clip section used when no internal boundary can be justified. */
function wholeClipSection({ seconds, onsetDensity, spectral, bpm }) {
  const centroid = averageCentroidForRange(spectral, 0, seconds)
  return {
    start: 0,
    end: round2(seconds),
    duration: round2(seconds),
    label: 'section 1',
    energy: 1,
    bpm: bpm === null || bpm === undefined ? null : roundTo(bpm, 1),
    note: `段落变化不明显；${onsetDensity > 2.5 ? '节奏较活跃' : '节奏稀疏'}，音色${centroid > 2000 ? '偏明亮' : '偏暗沉'}。`,
  }
}

/** Tempo for one section: re-estimate from its slice of the onset envelope. */
function estimateSectionTempo(onsetEnvelope, frameRate, startSeconds, endSeconds, globalBpm) {
  if (endSeconds - startSeconds < MIN_SECONDS_FOR_TEMPO) return globalBpm ?? null
  const startFrame = Math.max(0, Math.round(startSeconds * frameRate))
  const endFrame = Math.min(onsetEnvelope.length, Math.round(endSeconds * frameRate))
  if (endFrame - startFrame < frameRate * 3) return globalBpm ?? null
  const slice = onsetEnvelope.subarray(startFrame, endFrame)
  const estimate = dsp.estimateTempo(slice, frameRate)
  if (estimate.bpm !== null && estimate.confidence >= 0.2) return estimate.bpm
  return globalBpm ?? null
}

/**
 * Assign intro/verse/chorus/break/outro by relative energy and position.
 * When every section has nearly the same energy the functional label cannot be
 * justified, so the neutral `section N` labels are kept.
 */
function labelSections(sections) {
  if (sections.length === 0) return
  const energies = sections.map((section) => section.energy)
  const maxEnergy = Math.max(...energies, 1e-9)
  const spread = Math.max(...energies) - Math.min(...energies)
  if (sections.length > 1 && spread < 0.12) {
    sections.forEach((section, index) => {
      section.label = `section ${index + 1}`
    })
    return
  }
  sections.forEach((section, index) => {
    const isFirst = index === 0
    const isLast = index === sections.length - 1
    if (isFirst && sections.length > 1 && section.energy < 0.85 * maxEnergy) {
      section.label = 'intro'
    } else if (isLast && sections.length > 1 && section.energy < 0.85 * maxEnergy) {
      section.label = 'outro'
    } else if (section.energy >= 0.92 * maxEnergy) {
      section.label = 'chorus'
    } else if (section.energy < 0.5 * maxEnergy && !isFirst) {
      section.label = 'break'
    } else {
      section.label = 'verse'
    }
  })
}

function sectionNote({ energyRel, onsetsPerSecond, centroidHz, hasChords }) {
  const energyWord = energyRel > 0.88 ? '全能量' : energyRel > 0.65 ? '高能量' : energyRel > 0.4 ? '中等能量' : '低能量'
  const drumWord = onsetsPerSecond > 5 ? '鼓点密集' : onsetsPerSecond > 2.5 ? '鼓点稳定' : '鼓点稀疏'
  const toneWord = centroidHz > 3000 ? '高频明亮' : centroidHz > 1200 ? '中频均衡' : '低频厚重'
  const harmonyWord = hasChords ? '有和声进行' : '和声变化少'
  return `${energyWord}段落：${drumWord}、${toneWord}，${harmonyWord}。`
}

// ---------------------------------------------------------------------------
// Onset events / misc measurement helpers
// ---------------------------------------------------------------------------

/** Peak-pick onset events on the normalised onset envelope. */
function detectOnsetEvents(envelope, frameRate) {
  if (envelope.length === 0) return []
  const mean = dsp.mean(envelope)
  const deviation = dsp.stdDev(envelope)
  const threshold = mean + 0.8 * deviation
  const minSpacing = Math.max(1, Math.round(frameRate * 0.07))
  return dsp.peakPick(envelope, { minSpacing, threshold })
}

function rmsOfRange(samples, sampleRate, startSeconds, endSeconds) {
  const startIndex = clampNumber(Math.round(startSeconds * sampleRate), 0, samples.length)
  const endIndex = clampNumber(Math.round(endSeconds * sampleRate), startIndex, samples.length)
  let sum = 0
  for (let i = startIndex; i < endIndex; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, endIndex - startIndex))
}

function averageCentroidForRange(spectral, startSeconds, endSeconds) {
  const count = spectral.secCentroidDenominator.length
  const start = clampNumber(Math.floor(startSeconds), 0, count - 1)
  const end = clampNumber(Math.ceil(endSeconds), start + 1, count)
  let numerator = 0
  let denominator = 0
  for (let s = start; s < end; s += 1) {
    numerator += spectral.secCentroidNumerator[s]
    denominator += spectral.secCentroidDenominator[s]
  }
  return denominator > 0 ? numerator / denominator : 0
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/**
 * Render waveform + spectrogram with ffmpeg and chroma/energy charts with the
 * dependency-free PNG writer.
 *
 * ffmpeg side: the process runs with `cwd = workDir`, writes a RELATIVE file
 * name, and uses `-lavfi` (filter_complex) because a plain `-vf` cannot create a
 * video stream out of an audio-only input. Outputs are copied to the artifact
 * directory. `waveform` and `spectrogram` keys are always present: when ffmpeg
 * cannot produce them a JS chart fallback is written instead.
 */
async function renderArtifacts({ tools, file, workDir, options, start, seconds, samples, sampleRate, chromaFrames, energyCurve, signal, warnings }) {
  let targetDir
  try {
    targetDir = options.artifactDir ?? (await resolveArtifactDir(file))
    await mkdir(targetDir, { recursive: true })
  } catch (error) {
    warnings.push(`无法创建图表目录（${compactError(error)}），图表已跳过。`)
    return {}
  }
  const artifacts = {}
  const renderImage = async (name, lavfiFilter, fileName) => {
    const result = await run(
      tools.ffmpeg,
      [
        '-hide_banner', '-nostats', '-v', 'error', '-y',
        '-ss', startArg(start), '-t', secondsArg(seconds),
        '-i', file, '-vn', '-lavfi', lavfiFilter, '-frames:v', '1', fileName,
      ],
      { cwd: workDir, timeoutMs: 120_000, signal },
    )
    if (result.code !== 0 || !(await fileExists(join(workDir, fileName)))) {
      warnings.push(`无法渲染 ${name}（${tailText(result.stderr, 2) || `ffmpeg code ${result.code}`}）。`)
      return null
    }
    const target = join(targetDir, `${name}.png`)
    try {
      await copyFile(join(workDir, fileName), target)
      return target
    } catch (error) {
      warnings.push(`无法保存 ${name}（${compactError(error)}）。`)
      return null
    }
  }
  // Waveform: showwavespic PNG; on failure, a JS peak-envelope line chart.
  let waveform = null
  try {
    waveform = await renderImage('audio-waveform', 'showwavespic=s=1000x220:split_channels=0:colors=#5ec8ff', 'ms-waveform.png')
  } catch (error) {
    warnings.push(`波形图渲染失败（${compactError(error)}）。`)
  }
  if (waveform === null) {
    try {
      waveform = await writeWaveformFallback(join(targetDir, 'audio-waveform.png'), samples, sampleRate)
      warnings.push('波形图由 ffmpeg 回退为内置 PNG 折线图。')
    } catch (error) {
      warnings.push(`波形图回退失败（${compactError(error)}）。`)
    }
  }
  // Spectrogram: showspectrumpic PNG; on failure, a chroma-based heat map.
  let spectrogram = null
  try {
    spectrogram = await renderImage('audio-spectrogram', 'showspectrumpic=s=1000x320:legend=0:color=intensity', 'ms-spectrogram.png')
  } catch (error) {
    warnings.push(`频谱图渲染失败（${compactError(error)}）。`)
  }
  if (spectrogram === null) {
    try {
      spectrogram = await writeChromaFallback(join(targetDir, 'audio-spectrogram.png'), chromaFrames, 320)
      warnings.push('频谱图由 ffmpeg 回退为内置 PNG 色图（基于 chroma 能量）。')
    } catch (error) {
      warnings.push(`频谱图回退失败（${compactError(error)}）。`)
    }
  }
  if (waveform !== null) artifacts.waveform = waveform
  if (spectrogram !== null) artifacts.spectrogram = spectrogram
  // JS charts from the analysis itself.
  try {
    if (chromaFrames.length > 0) {
      const path = join(targetDir, 'audio-chroma.png')
      await writeChromaFallback(path, chromaFrames, 180)
      artifacts.chromaChart = path
    }
    if (energyCurve.length > 0) {
      const path = join(targetDir, 'audio-energy.png')
      await writeLineChart(path, {
        width: TARGET_ARTIFACT_WIDTH,
        height: 200,
        series: [
          { values: energyCurve.map((point) => point.rms), color: [94, 200, 255], min: 0, max: 1 },
          { values: energyCurve.map((point) => point.low), color: [255, 176, 84], min: 0, max: 1 },
          { values: energyCurve.map((point) => point.high), color: [196, 120, 255], min: 0, max: 1 },
        ],
      })
      artifacts.energyChart = path
    }
  } catch (error) {
    warnings.push(`曲线图渲染失败（${compactError(error)}）。`)
  }
  return JSON.parse(JSON.stringify(artifacts))
}

/** Chroma frames -> heat-map PNG (used for chromaChart and the spectrogram fallback). */
async function writeChromaFallback(path, chromaFrames, height) {
  const columns = Math.floor(TARGET_ARTIFACT_WIDTH / 8)
  const matrix = []
  for (let column = 0; column < columns; column += 1) {
    const from = chromaFrames.length > 0 ? Math.floor((column / columns) * chromaFrames.length) : 0
    const to = chromaFrames.length > 0 ? Math.max(from + 1, Math.floor(((column + 1) / columns) * chromaFrames.length)) : 0
    const mean = new Float64Array(12)
    for (let t = from; t < Math.min(to, chromaFrames.length); t += 1) {
      for (let b = 0; b < 12; b += 1) mean[b] += chromaFrames[t][b]
    }
    for (let b = 0; b < 12; b += 1) mean[b] /= Math.max(1, to - from)
    matrix.push(Array.from(mean))
  }
  const peak = Math.max(1e-9, ...matrix.flat())
  await writeHeatmap(path, {
    matrix: matrix.map((row) => row.map((value) => value / peak)),
    rows: 12,
    width: TARGET_ARTIFACT_WIDTH,
    height,
  })
  return path
}

/** Decoded samples -> normalised peak-envelope line chart PNG. */
async function writeWaveformFallback(path, samples, sampleRate) {
  const points = 1000
  const block = Math.max(1, Math.floor(samples.length / points))
  const values = []
  for (let i = 0; i < samples.length; i += block) {
    let peak = 0
    for (let j = i; j < Math.min(i + block, samples.length); j += 1) {
      const magnitude = Math.abs(samples[j])
      if (magnitude > peak) peak = magnitude
    }
    values.push(peak)
  }
  const max = Math.max(1e-9, ...values)
  await writeLineChart(path, {
    width: TARGET_ARTIFACT_WIDTH,
    height: 220,
    series: [{ values: values.map((value) => value / max), color: [94, 200, 255], min: 0, max: 1 }],
  })
  return path
}

/** Best-effort file existence check (artifact copy guard). */
async function fileExists(path) {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Silent / empty reports
// ---------------------------------------------------------------------------

/** Report for digitally silent audio: measured loudness, no tonal analysis. */
function buildSilentAnalysis({ samples, sampleRate, duration }) {
  const chroma = buildChromaReport(new Float64Array(12))
  const energyCurve = buildEnergyCurve({
    samples,
    sampleRate,
    seconds: duration,
    spectral: {
      secLow: new Float64Array(Math.max(1, Math.floor(duration))),
      secMid: new Float64Array(Math.max(1, Math.floor(duration))),
      secHigh: new Float64Array(Math.max(1, Math.floor(duration))),
    },
  })
  return {
    chromaFrames: [],
    chroma,
    key: null,
    tempo: {
      bpm: null,
      bpmCandidates: [],
      confidence: 0,
      beatCount: 0,
      beatTimes: [],
      timeSignatureGuess: 4,
      regularity: 0,
    },
    rhythm: { onsetRate: 0, onsetsPerSecond: 0, percussionDensity: 'sparse' },
    chords: null,
    sections: [],
    timbre: {
      centroidHz: 0,
      rolloffHz: 0,
      flatness: 0,
      zeroCrossRate: 0,
      brightness: 'dark',
      description: '无信号：解码后的音频为静音。',
    },
    spectrum: { lowRatio: 0, midRatio: 0, highRatio: 0 },
    energyCurve,
    vocals: { present: false, confidence: 0.9, note: '启发式判断：静音音频不含人声。' },
    mood: {
      arousal: 0,
      valence: 0.5,
      labels: ['silent', 'neutral', 'quiet'],
      note: '静音音频：没有速度、音色或情绪线索。',
    },
  }
}

/** Fully degraded report used when there is no audio stream / nothing decodable. */
function emptyReport({ duration, format, sampleRate, start, warnings }) {
  return scrubJson({
    kind: 'audio',
    duration: round2(finiteNumber(duration)),
    analyzed: { start: round2(finiteNumber(start)), seconds: 0, sampleRate: Math.round(finiteNumber(sampleRate)) },
    format: {
      codec: String(format.codec || 'unknown'),
      container: String(format.container || 'unknown'),
      bitRate: Math.round(finiteNumber(format.bitRate)),
      channels: Math.round(finiteNumber(format.channels)),
      sampleRate: Math.round(finiteNumber(format.sampleRate)),
    },
    loudness: {
      peakDbfs: -120,
      rmsDbfs: -120,
      lufsIntegrated: null,
      loudnessRangeLu: null,
      dynamicRangeDb: 0,
      clippingRatio: 0,
      silenceRatio: 1,
    },
    tempo: {
      bpm: null,
      bpmCandidates: [],
      confidence: 0,
      beatCount: 0,
      beatTimes: [],
      timeSignatureGuess: 4,
      regularity: 0,
    },
    key: null,
    chroma: buildChromaReport(new Float64Array(12)),
    timbre: {
      centroidHz: 0,
      rolloffHz: 0,
      flatness: 0,
      zeroCrossRate: 0,
      brightness: 'dark',
      description: '没有可分析的音频。',
    },
    spectrum: { lowRatio: 0, midRatio: 0, highRatio: 0 },
    rhythm: { onsetRate: 0, onsetsPerSecond: 0, percussionDensity: 'sparse' },
    sections: [],
    chords: null,
    energyCurve: [],
    vocals: { present: false, confidence: 0, note: '没有可分析的音频。' },
    mood: { arousal: 0, valence: 0.5, labels: ['unknown'], note: '没有可分析的音频。' },
    transcript: null,
    artifacts: {},
    warnings,
  })
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Normalise user options with contract defaults and safety clamps. */
function normaliseOptions(options) {
  const requestedRate = Number.isFinite(options.sampleRate) ? Math.round(options.sampleRate) : DEFAULT_SAMPLE_RATE
  return {
    start: Number.isFinite(options.start) && options.start > 0 ? options.start : 0,
    duration: Number.isFinite(options.duration) && options.duration > 0 ? options.duration : null,
    maxSeconds: Number.isFinite(options.maxSeconds) && options.maxSeconds > 0 ? options.maxSeconds : 900,
    wantArtifacts: options.wantArtifacts !== false,
    wantChords: options.wantChords !== false,
    wantStructure: options.wantStructure !== false,
    sampleRate: dsp.clamp(requestedRate, 8000, MAX_SAMPLE_RATE),
    artifactDir: typeof options.artifactDir === 'string' && options.artifactDir.length > 0 ? options.artifactDir : null,
    // asr/language/whisperModelPath accepted but unused: lib/asr.js owns ASR.
  }
}

function frameCountFor(sampleCount, nFft, hop) {
  if (sampleCount <= 0) return 0
  return Math.max(1, Math.floor((sampleCount - nFft) / hop) + 1)
}

/** Throw if the input file cannot be stat'ed at all (the only fatal case). */
async function assertReadable(file) {
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a regular file')
  } catch (error) {
    throw new Error(`analyzeAudio: input file is not readable: ${file} (${error.message})`)
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('audio analysis aborted')
    error.name = 'AbortError'
    throw error
  }
}

function clampNumber(value, min, max) {
  const number = Number.isFinite(value) ? value : min
  return number < min ? min : number > max ? max : number
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function roundTo(value, digits) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function round2(value) {
  return roundTo(finiteNumber(value), 2)
}

/** Integer millisecond timeout for child processes. */
function childTimeoutMs(seconds, msPerSecond, baseMs) {
  // Node's child_process validates `timeout` as an integer; durations derived
  // from a media file are floats, so round here before they reach execFile.
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  return Math.min(900_000, Math.max(10_000, Math.round(baseMs + safeSeconds * msPerSecond)))
}

/** Safe `-ss seconds` argument: finite, non-negative, fixed-point string. */
function startArg(value) {
  const safe = Number.isFinite(value) && value > 0 ? Math.min(value, 86_400) : 0
  return safe.toFixed(3)
}

/** Safe `-t seconds` argument: finite, positive, clamped, fixed-point string. */
function secondsArg(value) {
  const safe = Number.isFinite(value) && value > 0 ? Math.min(value, 86_400) : 0.05
  return safe.toFixed(3)
}

function compactError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/gu, ' ').slice(0, 180)
}

function tailText(text, lines) {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-lines)
    .join(' | ')
    .slice(0, 200)
}

/**
 * Defensive JSON-safety pass: converts any non-finite number to 0 and drops
 * non-plain values. The builders above already produce finite numbers; this is
 * the last line of defence so the model-facing tool result is always clean.
 */
function scrubJson(value) {
  if (value === null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((entry) => scrubJson(entry))
  if (value instanceof Float64Array || value instanceof Float32Array || value instanceof Int16Array) {
    return Array.from(value, (entry) => scrubJson(entry))
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      out[key] = scrubJson(entry)
    }
    return out
  }
  return null
}

// Re-exported for the test suite / Lead-owned renderer to unit test the parser.
export { parseEbur128 as parseEbur128Loudness }
export default { analyzeAudio, parseEbur128 }
