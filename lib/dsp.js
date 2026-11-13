/**
 * media-senses — pure DSP kernels used by the audio analysis engine.
 *
 * This module contains no I/O and no ffmpeg calls: every function is a
 * deterministic numeric transform on plain JS typed arrays, so it can be
 * unit-tested on its own (`test/audio-engine.test.mjs` does exactly that).
 *
 * Conventions:
 * - Spectra are stored as *power* (|X|^2) by default; functions that need
 *   magnitudes say so in their name.
 * - Chroma vectors are length-12 Float64Array, index 0 = C ... 11 = B.
 * - All public functions return plain numbers/typed arrays and never throw on
 *   degenerate input (they return zero-ish results instead); the only exception
 *   is `fft`, whose contract is a power-of-two input.
 */

export const PITCH_CLASS_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])

/**
 * Krumhansl-Kessler (1982) key profiles, rotated to start on the tonic.
 * These are the probe-tone ratings most key-finders use as a template.
 */
export const KRUMHANSL_MAJOR = Object.freeze([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
export const KRUMHANSL_MINOR = Object.freeze([6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

/**
 * Temperley's CBMS profiles (Temperley 2001, "The Cognition of Basic Musical
 * Structures"). Used only as a cross-check on the KK result: when both agree
 * the KK key confidence is left alone, when they disagree it is discounted.
 */
export const TEMPERLEY_MAJOR = Object.freeze([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0])
export const TEMPERLEY_MINOR = Object.freeze([5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0])

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

/** Clamp `value` into [min, max]; non-finite values fall back to `min`. */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return value < min ? min : value > max ? max : value
}

/** Round to `digits` decimal places, mapping non-finite input to 0. */
export function roundTo(value, digits = 3) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Return `value` when finite, otherwise `fallback`. */
export function finiteOr(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

/** Arithmetic mean (0 for an empty input). */
export function mean(values) {
  if (!values || values.length === 0) return 0
  let sum = 0
  for (let i = 0; i < values.length; i += 1) sum += values[i]
  return sum / values.length
}

/** Population standard deviation (0 for an empty input). */
export function stdDev(values) {
  if (!values || values.length < 2) return 0
  const mu = mean(values)
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    const d = values[i] - mu
    sum += d * d
  }
  return Math.sqrt(sum / values.length)
}

/** Median of a numeric array (0 for an empty input). */
export function median(values) {
  if (!values || values.length === 0) return 0
  const sorted = Array.from(values, (v) => (Number.isFinite(v) ? v : 0)).sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Linear-interpolated percentile; `p` in [0, 1]. */
export function percentile(values, p) {
  if (!values || values.length === 0) return 0
  const sorted = Array.from(values, (v) => (Number.isFinite(v) ? v : 0)).sort((a, b) => a - b)
  const pos = clamp(p, 0, 1) * (sorted.length - 1)
  const low = Math.floor(pos)
  const high = Math.min(sorted.length - 1, low + 1)
  const frac = pos - low
  return sorted[low] * (1 - frac) + sorted[high] * frac
}

/** Amplitude ratio -> dBFS, floored at `floorDb` so silence stays finite. */
export function amplitudeToDb(amplitude, floorDb = -120) {
  if (!Number.isFinite(amplitude) || amplitude <= 0) return floorDb
  return Math.max(floorDb, 20 * Math.log10(amplitude))
}

/** Energy ratio (0..1) -> dB, floored at `floorDb`. */
export function ratioToDb(ratio, floorDb = -120) {
  return amplitudeToDb(Math.sqrt(Math.max(0, finiteOr(ratio, 0))), floorDb)
}

/** Linear interpolation. */
export function lerp(a, b, t) {
  return a + (b - a) * t
}

/** Sample a numeric array at a fractional index with linear interpolation. */
export function sampleAt(values, position) {
  const n = values?.length ?? 0
  if (n === 0) return 0
  if (!Number.isFinite(position)) return 0
  if (position <= 0) return values[0]
  if (position >= n - 1) return values[n - 1]
  const i = Math.floor(position)
  const frac = position - i
  return values[i] * (1 - frac) + values[i + 1] * frac
}

/** Centred moving average; edges shrink the window instead of wrapping. */
export function movingAverage(values, windowSize) {
  const n = values?.length ?? 0
  const out = new Float64Array(n)
  if (n === 0) return out
  const half = Math.max(0, Math.floor((windowSize - 1) / 2))
  for (let i = 0; i < n; i += 1) {
    const start = Math.max(0, i - half)
    const end = Math.min(n - 1, i + half)
    let sum = 0
    for (let j = start; j <= end; j += 1) sum += values[j]
    out[i] = sum / (end - start + 1)
  }
  return out
}

/** L2-normalise a vector in place and return it (zero vector stays zero). */
export function normaliseVector(vector) {
  let sum = 0
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i]
  const norm = Math.sqrt(sum)
  if (norm > 1e-12) {
    for (let i = 0; i < vector.length; i += 1) vector[i] /= norm
  }
  return vector
}

// ---------------------------------------------------------------------------
// FFT / windows
// ---------------------------------------------------------------------------

/** Periodic Hann window (analysis window; `w[0] = 0`). */
export function hann(length) {
  const window = new Float64Array(Math.max(1, length))
  for (let i = 0; i < window.length; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / window.length)
  }
  return window
}

/**
 * In-place iterative radix-2 FFT (decimation in time, bit-reversal first).
 *
 * @param {Float64Array|number[]} real
 * @param {Float64Array|number[]} imag
 */
export function fft(real, imag) {
  const n = real.length
  if (n !== imag.length || n < 2 || (n & (n - 1)) !== 0) {
    throw new Error('fft: real/imag must have the same power-of-two length >= 2')
  }
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = real[i]
      real[i] = real[j]
      real[j] = tr
      const ti = imag[i]
      imag[i] = imag[j]
      imag[j] = ti
    }
  }
  // Butterfly stages; twiddles are accumulated by rotation (no trig per butterfly).
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < half; k += 1) {
        const aRe = real[i + k]
        const aIm = imag[i + k]
        const bRe = real[i + k + half] * curRe - imag[i + k + half] * curIm
        const bIm = real[i + k + half] * curIm + imag[i + k + half] * curRe
        real[i + k] = aRe + bRe
        imag[i + k] = aIm + bIm
        real[i + k + half] = aRe - bRe
        imag[i + k + half] = aIm - bIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

/** Smallest power of two >= n. */
export function nextPowerOfTwo(n) {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/**
 * Magnitude spectrum of one real frame.
 *
 * @param {Float64Array} frame  raw samples, length = nFft
 * @param {Float64Array} window pre-computed window of the same length
 * @param {{real?: Float64Array, imag?: Float64Array}} [scratch] reusable buffers
 * @returns {Float64Array} magnitudes for bins 0..nFft/2
 */
export function frameMagnitudes(frame, window, scratch = {}) {
  const n = frame.length
  const real = scratch.real ?? new Float64Array(n)
  const imag = scratch.imag ?? new Float64Array(n)
  real.fill(0)
  imag.fill(0)
  for (let i = 0; i < n; i += 1) real[i] = frame[i] * window[i]
  fft(real, imag)
  const half = n >> 1
  const magnitudes = new Float64Array(half + 1)
  for (let k = 0; k <= half; k += 1) magnitudes[k] = Math.hypot(real[k], imag[k])
  return magnitudes
}

// ---------------------------------------------------------------------------
// Mel bands and onset novelty
// ---------------------------------------------------------------------------

/** Hz -> mel (HTK formula). */
export function hzToMel(hz) {
  return 2595 * Math.log10(1 + Math.max(0, hz) / 700)
}

/** mel -> Hz. */
export function melToHz(mel) {
  return 700 * (10 ** (mel / 2595) - 1)
}

/**
 * Build a triangular mel filterbank over bins 0..nFft/2.
 *
 * @param {number} sampleRate
 * @param {number} nFft
 * @param {{bands?: number, fMin?: number, fMax?: number}} [options]
 * @returns {Array<{start: number, weights: Float64Array}>}
 */
export function melFilterbank(sampleRate, nFft, options = {}) {
  const bands = Math.max(1, options.bands ?? 40)
  const fMin = Math.max(0, options.fMin ?? 40)
  const fMax = Math.min(sampleRate / 2, options.fMax ?? 8000)
  const binCount = nFft / 2 + 1
  const melMin = hzToMel(fMin)
  const melMax = hzToMel(Math.max(fMin + 1, fMax))
  const edges = new Float64Array(bands + 2)
  for (let i = 0; i <= bands + 1; i += 1) edges[i] = melToHz(melMin + ((melMax - melMin) * i) / (bands + 1))
  const filters = []
  for (let b = 0; b < bands; b += 1) {
    const low = edges[b]
    const centre = edges[b + 1]
    const high = edges[b + 2]
    const firstBin = Math.max(0, Math.ceil((low * nFft) / sampleRate))
    const lastBin = Math.min(binCount - 1, Math.floor((high * nFft) / sampleRate))
    if (lastBin < firstBin) continue
    const weights = new Float64Array(lastBin - firstBin + 1)
    for (let k = firstBin; k <= lastBin; k += 1) {
      const freq = (k * sampleRate) / nFft
      const rise = centre > low ? (freq - low) / (centre - low) : 0
      const fall = high > centre ? (high - freq) / (high - centre) : 0
      weights[k - firstBin] = Math.max(0, Math.min(rise, fall))
    }
    filters.push({ start: firstBin, weights })
  }
  return filters
}

/**
 * Apply a mel filterbank to a power spectrum.
 *
 * @param {Float64Array} power  bins 0..nFft/2
 * @param {Array<{start: number, weights: Float64Array}>} filters
 * @returns {Float64Array} one energy value per band
 */
export function applyMelFilterbank(power, filters) {
  const out = new Float64Array(filters.length)
  for (let b = 0; b < filters.length; b += 1) {
    const { start, weights } = filters[b]
    let sum = 0
    for (let i = 0; i < weights.length; i += 1) sum += power[start + i] * weights[i]
    out[b] = sum
  }
  return out
}

/**
 * Half-wave rectified log-mel spectral flux (onset strength).
 *
 * @param {Float64Array} previousMel  log-mel energies of the previous frame
 * @param {Float64Array} currentMel   log-mel energies of the current frame
 * @returns {number} non-negative flux, averaged over bands
 */
export function spectralFlux(previousMel, currentMel) {
  const n = Math.min(previousMel.length, currentMel.length)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i += 1) {
    const delta = currentMel[i] - previousMel[i]
    if (delta > 0) sum += delta
  }
  return sum / n
}

// ---------------------------------------------------------------------------
// Pitch / chroma
// ---------------------------------------------------------------------------

/** Convert a frequency to a continuous MIDI note number (A4 = 69 = 440 Hz). */
export function frequencyToMidi(frequency, referenceHz = 440) {
  if (!(frequency > 0) || !(referenceHz > 0)) return -1
  return 69 + 12 * Math.log2(frequency / referenceHz)
}

/**
 * Accumulate spectral energy into a 1-cent-resolution pitch-class histogram.
 *
 * The histogram is indexed by `round(midi * 100) mod 1200`, so each entry is a
 * "cent of the octave"; `estimateTuning` folds it back to 12 chroma values.
 *
 * @param {Float64Array} magnitudes
 * @param {number} sampleRate
 * @param {number} nFft
 * @param {Float64Array} histogram  length-1200 accumulator (mutated)
 * @param {{minHz?: number, maxHz?: number}} [options]
 */
export function accumulatePitchHistogram(magnitudes, sampleRate, nFft, histogram, options = {}) {
  const minHz = options.minHz ?? 300
  const maxHz = options.maxHz ?? 4000
  const binCount = nFft / 2
  for (let k = 1; k <= binCount; k += 1) {
    const freq = (k * sampleRate) / nFft
    if (freq < minHz || freq > maxHz) continue
    const magnitude = magnitudes[k]
    if (!(magnitude > 0)) continue
    const cents = Math.round(frequencyToMidi(freq) * 100)
    const bin = ((cents % 1200) + 1200) % 1200
    histogram[bin] += magnitude
  }
  return histogram
}

/**
 * Estimate the tuning offset (cents, -50..50) of the recording from a
 * 1-cent pitch-class histogram.
 *
 * Each spectral peak contributes its deviation from the nearest equal-tempered
 * semitone. The weighted circular mean of those deviations is the tuning
 * offset. This is the aggregate form of "maximise chroma sharpness over
 * +/-50 cents": the histogram is already the superposition of all frames, so
 * the offset that concentrates it onto semitone centres is the one where the
 * mean deviation vanishes.
 */
export function estimateTuning(histogram) {
  let sumSin = 0
  let sumCos = 0
  let total = 0
  for (let bin = 0; bin < histogram.length; bin += 1) {
    const weight = histogram[bin]
    if (!(weight > 0)) continue
    const withinSemitone = bin % 100
    const deviation = withinSemitone >= 50 ? withinSemitone - 100 : withinSemitone
    const angle = (deviation / 100) * 2 * Math.PI
    sumSin += weight * Math.sin(angle)
    sumCos += weight * Math.cos(angle)
    total += weight
  }
  if (total <= 0) return 0
  const cents = (Math.atan2(sumSin, sumCos) / (2 * Math.PI)) * 100
  return clamp(cents, -50, 50)
}

/**
 * Map a magnitude spectrum to a 12-bin chroma vector.
 *
 * Bins outside [minHz, maxHz] are ignored (low bins in a 2048-point FFT at
 * 22.05 kHz cannot resolve semitones; high bins are mostly noise). Each bin is
 * split linearly between the two neighbouring pitch classes, which keeps the
 * vector continuous in the presence of a small tuning offset.
 *
 * @param {Float64Array} magnitudes
 * @param {number} sampleRate
 * @param {number} nFft
 * @param {{tuningCents?: number, minHz?: number, maxHz?: number}} [options]
 * @returns {Float64Array} length-12, unnormalised
 */
export function chromaFromSpectrum(magnitudes, sampleRate, nFft, options = {}) {
  const tuningCents = options.tuningCents ?? 0
  const minHz = options.minHz ?? 80
  const maxHz = options.maxHz ?? 5000
  const chroma = new Float64Array(12)
  const binCount = nFft / 2
  for (let k = 1; k <= binCount; k += 1) {
    const freq = (k * sampleRate) / nFft
    if (freq < minHz || freq > maxHz) continue
    const magnitude = magnitudes[k]
    if (!(magnitude > 0)) continue
    const midi = frequencyToMidi(freq) + tuningCents / 100
    const pcFloat = ((midi % 12) + 12) % 12
    const lower = Math.floor(pcFloat)
    const frac = pcFloat - lower
    chroma[lower % 12] += magnitude * (1 - frac)
    chroma[(lower + 1) % 12] += magnitude * frac
  }
  return chroma
}

/** Median filter of width 3 across a sequence of equal-length vectors. */
export function medianFilter3(frames) {
  const out = []
  const length = frames[0]?.length ?? 0
  const buffer = new Float64Array(3)
  for (let t = 0; t < frames.length; t += 1) {
    const filtered = new Float64Array(length)
    for (let b = 0; b < length; b += 1) {
      const count = t === 0 || t === frames.length - 1 ? 2 : 3
      if (count === 2) {
        buffer[0] = frames[t][b]
        buffer[1] = frames[t === 0 ? 1 : t - 1][b]
        filtered[b] = (buffer[0] + buffer[1]) / 2
      } else {
        buffer[0] = frames[t - 1][b]
        buffer[1] = frames[t][b]
        buffer[2] = frames[t + 1][b]
        // Three-element median via sorting the fixed-size buffer.
        const a = Math.min(buffer[0], buffer[1], buffer[2])
        const c = Math.max(buffer[0], buffer[1], buffer[2])
        filtered[b] = buffer[0] + buffer[1] + buffer[2] - a - c
      }
    }
    out.push(filtered)
  }
  return out
}

/** Element-wise mean of a sequence of vectors (returns Float64Array). */
export function meanVectors(frames, length = frames[0]?.length ?? 0) {
  const out = new Float64Array(length)
  if (frames.length === 0) return out
  for (const frame of frames) for (let i = 0; i < length; i += 1) out[i] += frame[i] ?? 0
  for (let i = 0; i < length; i += 1) out[i] /= frames.length
  return out
}

/**
 * Chroma concentration: sum of squares of an L2-normalised chroma vector.
 * 1/12 for flat noise, 1 for a single pure pitch class.
 */
export function chromaSharpness(chroma) {
  let sumSquares = 0
  let sum = 0
  for (let i = 0; i < chroma.length; i += 1) {
    sumSquares += chroma[i] * chroma[i]
    sum += chroma[i]
  }
  if (sum <= 1e-12) return 0
  return sumSquares / (sum * sum)
}

// ---------------------------------------------------------------------------
// Statistics & correlation
// ---------------------------------------------------------------------------

/** Pearson correlation of two equal-length sequences (0 when either is flat). */
export function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < n; i += 1) {
    meanA += a[i]
    meanB += b[i]
  }
  meanA /= n
  meanB /= n
  let num = 0
  let denA = 0
  let denB = 0
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    num += da * db
    denA += da * da
    denB += db * db
  }
  const den = Math.sqrt(denA * denB)
  if (!(den > 1e-12)) return 0
  return clamp(num / den, -1, 1)
}

/** Cosine similarity of two equal-length vectors (0 for zero vectors). */
export function cosineSimilarity(a, b) {
  const n = Math.min(a.length, b.length)
  let num = 0
  let denA = 0
  let denB = 0
  for (let i = 0; i < n; i += 1) {
    num += a[i] * b[i]
    denA += a[i] * a[i]
    denB += b[i] * b[i]
  }
  const den = Math.sqrt(denA * denB)
  if (!(den > 1e-12)) return 0
  return clamp(num / den, -1, 1)
}

// ---------------------------------------------------------------------------
// Key detection
// ---------------------------------------------------------------------------

/**
 * Estimate key from a mean chroma vector.
 *
 * Reports the best Krumhansl-Kessler correlation; `confidence` is the margin
 * over the runner-up mapped to 0..1 (discounted when the Temperley CBMS
 * profiles disagree, which catches relative-major/minor ambiguity).
 *
 * @param {Float64Array|number[]} chroma  12 values, any scale
 * @param {{tuningCents?: number}} [options]
 * @returns {{tonic: string, mode: 'major'|'minor', name: string, confidence: number,
 *            candidates: Array<{name: string, score: number}>, tuned: number}}
 */
export function detectKey(chroma, options = {}) {
  const vector = Array.from(chroma, (v) => finiteOr(v, 0))
  const profiles = [
    { mode: 'major', profile: KRUMHANSL_MAJOR, temperley: TEMPERLEY_MAJOR },
    { mode: 'minor', profile: KRUMHANSL_MINOR, temperley: TEMPERLEY_MINOR },
  ]
  const scored = []
  const temperleyScored = []
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const { mode, profile, temperley } of profiles) {
      const rotated = new Array(12)
      const rotatedTemperley = new Array(12)
      for (let degree = 0; degree < 12; degree += 1) {
        rotated[(tonic + degree) % 12] = profile[degree]
        rotatedTemperley[(tonic + degree) % 12] = temperley[degree]
      }
      scored.push({ tonic, mode, score: pearsonCorrelation(vector, rotated) })
      temperleyScored.push({ tonic, mode, score: pearsonCorrelation(vector, rotatedTemperley) })
    }
  }
  const byScore = [...scored].sort((a, b) => b.score - a.score)
  const best = byScore[0]
  const runnerUp = byScore[1] ?? { score: 0 }
  const bestTemperley = [...temperleyScored].sort((a, b) => b.score - a.score)[0]
  const temperleyAgrees = bestTemperley !== undefined && bestTemperley.tonic === best.tonic && bestTemperley.mode === best.mode
  const margin = Math.max(0, best.score - runnerUp.score)
  let confidence = clamp(margin / 0.12, 0, 0.99)
  if (!temperleyAgrees) confidence = clamp(confidence * 0.7, 0, 0.99)
  return {
    tonic: PITCH_CLASS_NAMES[best.tonic],
    mode: best.mode,
    name: `${PITCH_CLASS_NAMES[best.tonic]} ${best.mode}`,
    confidence: roundTo(confidence, 3),
    candidates: byScore.slice(0, 3).map((entry) => ({
      name: `${PITCH_CLASS_NAMES[entry.tonic]} ${entry.mode}`,
      score: roundTo(entry.score, 3),
    })),
    tuned: roundTo(clamp(options.tuningCents ?? 0, -50, 50), 1),
  }
}

// ---------------------------------------------------------------------------
// Autocorrelation, tempo and beats
// ---------------------------------------------------------------------------

/**
 * Normalised autocorrelation of a signal for lags 0..maxLag.
 *
 * r(l) = sum_t c[t] c[t+l] / sqrt(sum c[t]^2 * sum c[t+l]^2) with c the
 * mean-removed signal. Values are roughly -1..1; lag 0 is always 1.
 */
export function normalisedAutocorrelation(signal, maxLag) {
  const n = signal?.length ?? 0
  if (n < 3) return new Float64Array(1)
  const limit = Math.min(Math.max(1, maxLag), n - 2)
  let mu = 0
  for (let i = 0; i < n; i += 1) mu += signal[i]
  mu /= n
  const centred = new Float64Array(n)
  for (let i = 0; i < n; i += 1) centred[i] = signal[i] - mu
  // Suffix energy lets every lag share one O(n) denominator pass.
  const suffix = new Float64Array(n + 1)
  for (let i = n - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + centred[i] * centred[i]
  const out = new Float64Array(limit + 1)
  const total = suffix[0]
  for (let lag = 0; lag <= limit; lag += 1) {
    const den = Math.sqrt(total * suffix[lag])
    if (!(den > 1e-12)) {
      out[lag] = 0
      continue
    }
    let sum = 0
    for (let t = 0; t < n - lag; t += 1) sum += centred[t] * centred[t + lag]
    out[lag] = clamp(sum / den, -1, 1)
  }
  return out
}

/**
 * Fold a tempo into the perceptual range: repeatedly double/halve until it
 * lands inside [minBpm, maxBpm]. Classic octave-error correction.
 */
export function foldTempo(bpm, minBpm = 60, maxBpm = 190) {
  if (!(bpm > 0) || !Number.isFinite(bpm)) return null
  let folded = bpm
  for (let guard = 0; guard < 12 && folded > maxBpm; guard += 1) folded /= 2
  for (let guard = 0; guard < 12 && folded < minBpm; guard += 1) folded *= 2
  return folded >= minBpm && folded <= maxBpm ? folded : null
}

/** Pre-process an onset envelope: local baseline removal then unit variance. */
export function normaliseOnsetEnvelope(flux, windowSize = 16) {
  const n = flux?.length ?? 0
  const out = new Float64Array(n)
  if (n === 0) return out
  const baseline = movingAverage(flux, windowSize)
  let variance = 0
  for (let i = 0; i < n; i += 1) {
    const value = Math.max(0, flux[i] - baseline[i])
    out[i] = value
    variance += value * value
  }
  const scale = Math.sqrt(variance / n)
  if (scale > 1e-9) for (let i = 0; i < n; i += 1) out[i] /= scale
  return out
}

/**
 * Estimate tempo from an onset envelope by autocorrelation with a log-normal
 * tempo prior around 120 BPM (the prior suppresses the 2x/3x metrical
 * ambiguities that plain autocorrelation always has). The winning lag is
 * refined by parabolic interpolation, then octave-folded into [60, 190].
 *
 * @param {Float64Array} envelope  onset strength per frame
 * @param {number} frameRate       envelope frames per second
 * @param {{minBpm?: number, maxBpm?: number, priorBpm?: number, priorWidth?: number}} [options]
 * @returns {{bpm: number|null, bpmCandidates: number[], confidence: number, peakScore: number}}
 */
export function estimateTempo(envelope, frameRate, options = {}) {
  const minBpm = options.minBpm ?? 40
  const maxBpm = options.maxBpm ?? 200
  const priorBpm = options.priorBpm ?? 120
  const priorWidth = options.priorWidth ?? 0.32
  const empty = { bpm: null, bpmCandidates: [], confidence: 0, peakScore: 0 }
  const n = envelope?.length ?? 0
  if (!(frameRate > 0) || n < Math.max(16, frameRate * 2)) return empty
  const minLag = Math.max(2, Math.floor((frameRate * 60) / maxBpm))
  const maxLag = Math.min(n - 2, Math.ceil((frameRate * 60) / minBpm))
  if (maxLag <= minLag + 2) return empty
  const acf = normalisedAutocorrelation(envelope, maxLag)
  const priorOf = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / priorBpm) / priorWidth) ** 2)
  const bpmOfLag = (lag) => (60 * frameRate) / lag
  const scored = new Float64Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag += 1) scored[lag] = acf[lag] * priorOf(bpmOfLag(lag))
  // Local maxima of the prior-weighted curve.
  const peaks = []
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const previous = lag === minLag ? -Infinity : scored[lag - 1]
    const next = lag === maxLag ? -Infinity : scored[lag + 1]
    if (scored[lag] >= previous && scored[lag] >= next) peaks.push({ lag, score: scored[lag], acf: acf[lag] })
  }
  if (peaks.length === 0) return empty
  peaks.sort((a, b) => b.score - a.score)
  const best = peaks[0]
  // Parabolic interpolation on the prior-weighted peak for sub-frame lag accuracy.
  const prev = scored[best.lag - 1] ?? best.score
  const next = scored[best.lag + 1] ?? best.score
  const denominator = prev - 2 * best.score + next
  const delta = Math.abs(denominator) > 1e-12 ? clamp((0.5 * (prev - next)) / denominator, -0.5, 0.5) : 0
  const refinedLag = best.lag + delta
  const bpmRaw = bpmOfLag(refinedLag)
  const bpm = foldTempo(bpmRaw, 60, 190)
  const runnerUp = peaks[1] ?? { score: 0 }
  const margin = Math.max(0, best.score - runnerUp.score)
  const peakValue = clamp(best.acf, 0, 1)
  const coverage = clamp(n / (frameRate * 6), 0, 1) // 6 s of audio is enough to trust it
  const confidence = clamp((0.2 + 0.55 * peakValue + 1.6 * margin) * (0.5 + 0.5 * coverage), 0, 0.99)
  const candidates = peaks
    .slice(0, 3)
    .map((peak) => roundTo(bpmOfLag(peak.lag), 1))
    .filter((value) => value > 0)
  return {
    bpm: bpm === null ? null : roundTo(bpm, 1),
    bpmCandidates: candidates,
    confidence: roundTo(confidence, 3),
    peakScore: roundTo(peakValue, 3),
  }
}

/**
 * Track beats on an onset envelope for a known tempo.
 *
 * Choice: a global phase search followed by bounded local-max snapping, not a
 * full dynamic-programme tracker. The material analysed here is usually a
 * produced song with a steady grid, so the phase+snap approach is both cheaper
 * and more stable; `regularity` exposes how well the tempo assumption held.
 *
 * `timeOffsetSeconds` converts envelope frame indices to the corresponding
 * physical time (e.g. half an STFT window for a frame-time=window-start
 * convention), so returned beat times stay close to the audible transients.
 *
 * @param {Float64Array} envelope
 * @param {number} frameRate
 * @param {number} bpm
 * @param {{maxBeats?: number, timeOffsetSeconds?: number}} [options]
 * @returns {{beatTimes: number[], beatIndices: number[], beatCount: number, regularity: number, period: number}}
 */
export function trackBeats(envelope, frameRate, bpm, options = {}) {
  const maxBeats = options.maxBeats ?? 100000
  const timeOffset = options.timeOffsetSeconds ?? 0
  const n = envelope?.length ?? 0
  const empty = { beatTimes: [], beatIndices: [], beatCount: 0, regularity: 0, period: 0 }
  if (!(bpm > 0) || !(frameRate > 0) || n < 4) return empty
  const period = ((60 / bpm) * frameRate) // frames per beat
  if (!(period > 1.5) || period > n) return empty
  const periodSeconds = 60 / bpm
  // Phase search: maximise the mean onset strength sampled on the beat grid.
  let bestPhase = 0
  let bestScore = -Infinity
  const phaseSteps = Math.max(16, Math.round(period * 4))
  for (let step = 0; step < phaseSteps; step += 1) {
    const phase = (step / phaseSteps) * period
    let score = 0
    let count = 0
    for (let position = phase; position <= n - 1; position += period) {
      score += sampleAt(envelope, position)
      count += 1
    }
    if (count === 0) continue
    const normalised = score / count
    if (normalised > bestScore) {
      bestScore = normalised
      bestPhase = phase
    }
  }
  const radius = Math.max(1, Math.round(period * 0.12))
  const snapIndex = (expected) => {
    const centre = Math.round(expected)
    let bestIndex = centre
    let bestValue = -Infinity
    for (let index = Math.max(0, centre - radius); index <= Math.min(n - 1, centre + radius); index += 1) {
      if (envelope[index] > bestValue) {
        bestValue = envelope[index]
        bestIndex = index
      }
    }
    return bestIndex
  }
  const indices = []
  for (let expected = bestPhase; expected <= n - 1 && indices.length < maxBeats; expected += period) {
    const index = snapIndex(expected)
    const time = index / frameRate + timeOffset
    if (indices.length === 0 || time - (indices[indices.length - 1] / frameRate + timeOffset) > 0.4 * periodSeconds) {
      indices.push(index)
    }
  }
  // If the first grid beat is late, extrapolate one beat backwards so a track
  // that starts on the downbeat reports a beat near 0 s.
  if (indices.length > 0 && indices.length < maxBeats) {
    const firstTime = indices[0] / frameRate + timeOffset
    if (firstTime > 0.55 * periodSeconds) {
      const expected = bestPhase - period
      const index = Math.max(0, snapIndex(expected))
      const time = index / frameRate + timeOffset
      if (time >= 0 && time < firstTime - 0.35 * periodSeconds) indices.unshift(index)
    }
  }
  const beatTimes = indices.map((index) => index / frameRate + timeOffset)
  const intervals = []
  for (let i = 1; i < beatTimes.length; i += 1) intervals.push(beatTimes[i] - beatTimes[i - 1])
  const medianInterval = median(intervals)
  let regularity = 0
  if (medianInterval > 0 && intervals.length > 0) {
    let deviation = 0
    for (const interval of intervals) deviation += Math.abs(interval - medianInterval)
    regularity = clamp(1 - deviation / intervals.length / medianInterval, 0, 1)
  }
  return { beatTimes, beatIndices: indices, beatCount: beatTimes.length, regularity: roundTo(regularity, 3), period: periodSeconds }
}

/**
 * Guess 3/4 vs 4/4 from the accent pattern of a beat-tracked envelope.
 *
 * The meter whose beat grouping yields the most uneven accent profile wins
 * (a waltz puts accents every third beat, common time every fourth).
 */
export function guessTimeSignature(envelope, beatIndices, frameRate) {
  const accents = beatIndices.map((index) => {
    const centre = Math.round(index)
    const radius = Math.max(1, Math.round(frameRate * 0.06))
    let sum = 0
    let count = 0
    for (let i = Math.max(0, centre - radius); i <= Math.min(envelope.length - 1, centre + radius); i += 1) {
      sum += envelope[i]
      count += 1
    }
    return count > 0 ? sum / count : 0
  })
  if (accents.length < 8) return 4
  const concentration = (meter) => {
    const sums = new Float64Array(meter)
    const counts = new Float64Array(meter)
    for (let i = 0; i < accents.length; i += 1) {
      sums[i % meter] += accents[i]
      counts[i % meter] += 1
    }
    const means = new Float64Array(meter)
    for (let i = 0; i < meter; i += 1) means[i] = counts[i] > 0 ? sums[i] / counts[i] : 0
    const mu = mean(means)
    if (!(mu > 1e-9)) return 0
    return stdDev(means) / mu
  }
  const score3 = concentration(3)
  const score4 = concentration(4)
  return score3 > score4 * 1.35 ? 3 : 4
}

/**
 * Share of the envelope's modulation energy that falls in [lowHz, highHz].
 * Used as a syllable/vibrato-rate cue for the vocal heuristic.
 */
export function modulationEnergyShare(envelope, frameRate, lowHz, highHz) {
  const n = envelope?.length ?? 0
  if (n < 16 || !(frameRate > 0)) return 0
  const size = nextPowerOfTwo(n)
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  let mu = 0
  for (let i = 0; i < n; i += 1) mu += envelope[i]
  mu /= n
  const window = hann(n)
  for (let i = 0; i < n; i += 1) real[i] = (envelope[i] - mu) * window[i]
  fft(real, imag)
  const nyquist = frameRate / 2
  const totalTop = Math.min(20, nyquist)
  let band = 0
  let total = 0
  for (let k = 1; k < size / 2; k += 1) {
    const freq = (k * frameRate) / size
    if (freq < 0.5 || freq > totalTop) continue
    const power = real[k] * real[k] + imag[k] * imag[k]
    total += power
    if (freq >= lowHz && freq <= highHz) band += power
  }
  if (!(total > 1e-12)) return 0
  return clamp(band / total, 0, 1)
}

// ---------------------------------------------------------------------------
// Structure (self-similarity + Foote novelty)
// ---------------------------------------------------------------------------

/** Build a cosine self-similarity matrix from a list of feature vectors. */
export function selfSimilarityMatrix(features) {
  const count = features.length
  const matrix = []
  for (let i = 0; i < count; i += 1) {
    const row = new Float64Array(count)
    for (let j = 0; j < count; j += 1) row[j] = cosineSimilarity(features[i], features[j])
    matrix.push(row)
  }
  return matrix
}

/**
 * Foote checkerboard novelty from a self-similarity matrix.
 *
 * A Gaussian-tapered checkerboard kernel is correlated along the matrix
 * diagonal: high values mean "the material before sounds unlike the material
 * after", i.e. a section boundary.
 *
 * @param {Float64Array[]} matrix
 * @param {number} kernelHalf  half kernel width in frames (>=1)
 * @returns {Float64Array}
 */
export function checkerboardNovelty(matrix, kernelHalf) {
  const count = matrix.length
  const out = new Float64Array(count)
  if (count < 3) return out
  const half = Math.max(1, Math.min(kernelHalf, Math.floor((count - 1) / 2)))
  // Gaussian taper, evaluated once per offset.
  const taper = new Float64Array(2 * half + 1)
  const sigma = Math.max(0.5, half / 2)
  for (let u = -half; u <= half; u += 1) taper[u + half] = Math.exp(-0.5 * (u / sigma) ** 2)
  // Normalise by the absolute kernel mass (sign(u)*sign(v) is zero on the axes,
  // so those cells contribute nothing and are excluded from the mass).
  let axisMass = 0
  for (let u = -half; u <= half; u += 1) if (u !== 0) axisMass += taper[u + half]
  const norm = axisMass * axisMass
  if (!(norm > 0)) return out
  for (let i = 0; i < count; i += 1) {
    let sum = 0
    for (let u = -half; u <= half; u += 1) {
      const row = i + u
      if (row < 0 || row >= count) continue
      for (let v = -half; v <= half; v += 1) {
        const column = i + v
        if (column < 0 || column >= count) continue
        const sign = Math.sign(u) * Math.sign(v)
        if (sign === 0) continue
        sum += sign * taper[u + half] * taper[v + half] * matrix[row][column]
      }
    }
    out[i] = sum / norm
  }
  return out
}

/**
 * Greedy peak picker with a minimum spacing.
 *
 * @param {ArrayLike<number>} values
 * @param {{minSpacing?: number, threshold?: number, includeEdges?: boolean}} [options]
 * @returns {number[]} peak indices, ascending
 */
export function peakPick(values, options = {}) {
  const n = values?.length ?? 0
  if (n === 0) return []
  const minSpacing = Math.max(1, options.minSpacing ?? 1)
  const threshold = options.threshold ?? mean(values) + 0.5 * stdDev(values)
  const candidates = []
  for (let i = 0; i < n; i += 1) {
    if (!(values[i] > threshold)) continue
    const left = i === 0 ? -Infinity : values[i - 1]
    const right = i === n - 1 ? -Infinity : values[i + 1]
    if (values[i] >= left && values[i] >= right) candidates.push({ index: i, value: values[i] })
  }
  candidates.sort((a, b) => b.value - a.value)
  const chosen = []
  for (const candidate of candidates) {
    if (chosen.every((index) => Math.abs(index - candidate.index) >= minSpacing)) chosen.push(candidate.index)
  }
  return chosen.sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Chords (24 major/minor triads + Viterbi smoothing)
// ---------------------------------------------------------------------------

/**
 * Build the 24 triad templates. Root, third and fifth get descending weights
 * so a chroma with a noisy third still matches its root reliably.
 */
export function chordTemplates() {
  const templates = []
  const intervals = [
    { quality: 'major', offsets: [0, 4, 7], weights: [1, 0.9, 0.8] },
    { quality: 'minor', offsets: [0, 3, 7], weights: [1, 0.9, 0.8] },
  ]
  for (const { quality, offsets, weights } of intervals) {
    for (let root = 0; root < 12; root += 1) {
      const template = new Float64Array(12)
      for (let i = 0; i < offsets.length; i += 1) template[(root + offsets[i]) % 12] = weights[i]
      templates.push({
        name: `${PITCH_CLASS_NAMES[root]}${quality === 'minor' ? 'm' : ''}`,
        root,
        quality,
        template,
      })
    }
  }
  return templates
}

/**
 * Cosine-match a chroma vector against all 24 triads.
 *
 * @returns {Array<{index: number, name: string, root: number, quality: string, score: number}>}
 *          sorted by descending score (24 entries)
 */
export function scoreChordTemplates(chroma, templates = chordTemplates()) {
  const results = templates.map((entry, index) => ({
    index,
    name: entry.name,
    root: entry.root,
    quality: entry.quality,
    score: cosineSimilarity(chroma, entry.template),
  }))
  results.sort((a, b) => b.score - a.score)
  return results
}

/**
 * Viterbi decode a sequence of chord emission scores with a fixed switch cost,
 * which removes the frame-to-frame flicker of raw template matching.
 *
 * @param {Array<ArrayLike<number>>} emissions  frames x states scores
 * @param {number} transitionCost               cost of changing state (score units)
 * @returns {number[]} most likely state index per frame
 */
export function viterbiDecode(emissions, transitionCost = 0.08) {
  const frames = emissions.length
  if (frames === 0) return []
  const stateCount = emissions[0].length
  if (stateCount === 0) return []
  const previous = new Float64Array(stateCount)
  const current = new Float64Array(stateCount)
  const back = new Int16Array(frames * stateCount)
  for (let state = 0; state < stateCount; state += 1) previous[state] = emissions[0][state]
  for (let t = 1; t < frames; t += 1) {
    for (let state = 0; state < stateCount; state += 1) {
      let best = -Infinity
      let bestPrevious = state
      for (let candidate = 0; candidate < stateCount; candidate += 1) {
        const value = previous[candidate] - (candidate === state ? 0 : transitionCost)
        if (value > best) {
          best = value
          bestPrevious = candidate
        }
      }
      current[state] = emissions[t][state] + best
      back[t * stateCount + state] = bestPrevious
    }
    previous.set(current)
  }
  const path = new Array(frames)
  let bestLast = 0
  let bestValue = -Infinity
  for (let state = 0; state < stateCount; state += 1) {
    if (previous[state] > bestValue) {
      bestValue = previous[state]
      bestLast = state
    }
  }
  path[frames - 1] = bestLast
  for (let t = frames - 1; t > 0; t -= 1) path[t - 1] = back[t * stateCount + path[t]]
  return path
}

// ---------------------------------------------------------------------------
// Spectral shape helpers (timbre / spectrum)
// ---------------------------------------------------------------------------

/** Spectral centroid in Hz from a magnitude spectrum. */
export function spectralCentroid(magnitudes, sampleRate, nFft) {
  const binCount = nFft / 2
  let weighted = 0
  let total = 0
  for (let k = 1; k <= binCount; k += 1) {
    const magnitude = magnitudes[k]
    weighted += magnitude * ((k * sampleRate) / nFft)
    total += magnitude
  }
  return total > 1e-12 ? weighted / total : 0
}

/** Spectral roll-off in Hz: frequency below which `fraction` of the energy lies. */
export function spectralRolloff(magnitudes, sampleRate, nFft, fraction = 0.85) {
  const binCount = nFft / 2
  let total = 0
  for (let k = 1; k <= binCount; k += 1) total += magnitudes[k]
  if (!(total > 1e-12)) return 0
  const target = total * clamp(fraction, 0, 1)
  let running = 0
  for (let k = 1; k <= binCount; k += 1) {
    running += magnitudes[k]
    if (running >= target) return (k * sampleRate) / nFft
  }
  return sampleRate / 2
}

/** Spectral flatness (geometric / arithmetic mean of the power spectrum), 0..1. */
export function spectralFlatness(power) {
  const binCount = (power.length - 1) | 0
  if (binCount < 2) return 0
  let logSum = 0
  let sum = 0
  for (let k = 1; k <= binCount; k += 1) {
    const value = power[k]
    logSum += Math.log(value + 1e-12)
    sum += value
  }
  const geometric = Math.exp(logSum / binCount)
  const arithmetic = sum / binCount
  if (!(arithmetic > 1e-12)) return 0
  return clamp(geometric / arithmetic, 0, 1)
}

/**
 * Energy share of the power spectrum inside [lowHz, highHz).
 * Also returns the total energy so callers can aggregate over frames.
 */
export function bandEnergy(power, sampleRate, nFft, lowHz, highHz) {
  const binCount = nFft / 2
  let band = 0
  let total = 0
  for (let k = 1; k <= binCount; k += 1) {
    const freq = (k * sampleRate) / nFft
    const value = power[k]
    total += value
    if (freq >= lowHz && freq < highHz) band += value
  }
  return { band, total }
}

/** Fraction of sign changes between consecutive samples (0..1). */
export function zeroCrossingRate(samples) {
  const n = samples?.length ?? 0
  if (n < 2) return 0
  let changes = 0
  for (let i = 1; i < n; i += 1) {
    if ((samples[i - 1] >= 0) !== (samples[i] >= 0)) changes += 1
  }
  return changes / (n - 1)
}

export default {
  PITCH_CLASS_NAMES,
  KRUMHANSL_MAJOR,
  KRUMHANSL_MINOR,
  TEMPERLEY_MAJOR,
  TEMPERLEY_MINOR,
  clamp,
  roundTo,
  finiteOr,
  mean,
  stdDev,
  median,
  percentile,
  amplitudeToDb,
  ratioToDb,
  lerp,
  sampleAt,
  movingAverage,
  normaliseVector,
  hann,
  fft,
  nextPowerOfTwo,
  frameMagnitudes,
  hzToMel,
  melToHz,
  melFilterbank,
  applyMelFilterbank,
  spectralFlux,
  frequencyToMidi,
  accumulatePitchHistogram,
  estimateTuning,
  chromaFromSpectrum,
  medianFilter3,
  meanVectors,
  chromaSharpness,
  pearsonCorrelation,
  cosineSimilarity,
  detectKey,
  normalisedAutocorrelation,
  foldTempo,
  normaliseOnsetEnvelope,
  estimateTempo,
  trackBeats,
  guessTimeSignature,
  modulationEnergyShare,
  selfSimilarityMatrix,
  checkerboardNovelty,
  peakPick,
  chordTemplates,
  scoreChordTemplates,
  viterbiDecode,
  spectralCentroid,
  spectralRolloff,
  spectralFlatness,
  bandEnergy,
  zeroCrossingRate,
}
