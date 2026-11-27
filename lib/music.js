/**
 * lib/music.js — procedural score generation (offline, deterministic, zero deps).
 *
 * The plugin could synthesise a *sound effect* but had no way to make *music*, so
 * any film that needed a bed had to borrow a file from somewhere — which drags in
 * licensing, and makes the film un-reproducible for anyone without that file.
 * This module writes the score instead: a few instrument voices, a chord
 * progression, and a section plan, rendered to 16-bit PCM.
 *
 * Design choices worth knowing:
 *
 * - **Karplus–Strong plucks** rather than sampled instruments. A plucked string is
 *   a delay line with a low-pass in the feedback path: a dozen lines of code, and it
 *   genuinely sounds like a string rather than a beep. It also decays by itself, so
 *   notes never need an explicit envelope release.
 * - **A minor / D minor with a i–VI–III–VII turn** for the "hope inside gravity"
 *   colour most science documentaries land on. The mood presets only change tempo,
 *   instrumentation and harmonic rhythm, not the underlying voice-leading, so the
 *   whole film stays in one tonal world.
 * - **Section plan over absolute time**: the caller says "0–40 s sparse, 40–120 s
 *   add pulse", and the renderer places events. That is what makes the score follow
 *   the edit instead of hoping a loop happens to fit.
 * - **No reverb unit.** A cheap Schroeder-style comb+allpass pair is included
 *   because dry plucks sound like a ringtone; the tail length is a parameter.
 *
 * Everything is a pure function of the options (seeded PRNG only), so the same
 * score renders byte-identically on any machine — which is the whole reason the
 * pipeline can claim a film is reproducible.
 *
 * @module lib/music
 */
import { writeFile } from 'node:fs/promises'

/* ------------------------------------------------------------------ *
 * Deterministic helpers
 * ------------------------------------------------------------------ */

/** mulberry32 — same seed, same sequence, everywhere. */
function makeRandom(seed) {
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 1) >>> 0
  if (state === 0) state = 0x9e3779b9
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value)
const lerp = (a, b, t) => a + (b - a) * t

/** MIDI note number → Hz (A4 = 69 = 440 Hz). */
export function midiToHz(note) {
  return 440 * 2 ** ((note - 69) / 12)
}

/* ------------------------------------------------------------------ *
 * Voices
 * ------------------------------------------------------------------ */

/**
 * Karplus–Strong plucked string.
 *
 * The delay length sets the pitch; the averaging filter in the feedback loop is
 * what turns an impulse into a decaying harmonic series. `damping` controls how
 * fast the highs go first, which is what makes it read as "string" rather than
 * "sine with an envelope".
 */
function pluck({ note, startSeconds, durationSeconds, amplitude, sampleRate, buffer, damping = 0.5, brightness = 0.5, random }) {
  const frequency = midiToHz(note)
  const period = Math.max(2, Math.round(sampleRate / frequency))
  const line = new Float32Array(period)
  // Excitation: a short burst of noise, low-passed by `brightness`. Bright
  // excitation = pick near the bridge; dark = soft finger.
  const exciteLength = Math.max(2, Math.round(period * (0.5 + brightness)))
  let previous = 0
  for (let i = 0; i < period; i += 1) {
    const noise = random() * 2 - 1
    previous = previous * (0.9 - brightness * 0.6) + noise * (0.1 + brightness * 0.6)
    line[i] = i < exciteLength ? previous : 0
  }
  const startSample = Math.round(startSeconds * sampleRate)
  const length = Math.round(durationSeconds * sampleRate)
  const feedback = 0.996 - damping * 0.02
  let index = 0
  for (let n = 0; n < length; n += 1) {
    const target = startSample + n
    if (target >= buffer.length) break
    const current = line[index]
    const next = line[(index + 1) % period]
    line[index] = (current + next) * 0.5 * feedback
    // Fade the tail so a clipped note never clicks.
    const fade = n > length - 64 ? (length - n) / 64 : 1
    buffer[target] += current * amplitude * fade
    index = (index + 1) % period
  }
}

/** Sustained pad: stacked detuned partials with a slow attack and release. */
function pad({ note, startSeconds, durationSeconds, amplitude, sampleRate, buffer, attack = 1.2, release = 1.5, detune = 0.004 }) {
  const frequency = midiToHz(note)
  const startSample = Math.round(startSeconds * sampleRate)
  const length = Math.round(durationSeconds * sampleRate)
  const partials = [
    { ratio: 1, gain: 1 },
    { ratio: 2, gain: 0.28 },
    { ratio: 3, gain: 0.12 },
    { ratio: 1 + detune, gain: 0.5 },
    { ratio: 1 - detune, gain: 0.5 },
  ]
  for (let n = 0; n < length; n += 1) {
    const target = startSample + n
    if (target >= buffer.length) break
    const t = n / sampleRate
    const attackGain = attack <= 0 ? 1 : Math.min(1, t / attack)
    const releaseGain = release <= 0 ? 1 : Math.min(1, (durationSeconds - t) / release)
    const envelope = Math.max(0, Math.min(attackGain, releaseGain))
    if (envelope <= 0) continue
    // Slow amplitude drift keeps a long pad from sounding like a test tone.
    const drift = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.07 * t)
    let sample = 0
    for (const partial of partials) {
      sample += partial.gain * Math.sin(2 * Math.PI * frequency * partial.ratio * t)
    }
    buffer[target] += (sample / 3.2) * amplitude * envelope * drift
  }
}

/** Soft heartbeat kick: a pitched-down sine thump. */
function pulse({ startSeconds, amplitude, sampleRate, buffer, pitchHz = 55, decaySeconds = 0.32 }) {
  const startSample = Math.round(startSeconds * sampleRate)
  const length = Math.round(decaySeconds * sampleRate)
  for (let n = 0; n < length; n += 1) {
    const target = startSample + n
    if (target >= buffer.length) break
    const t = n / sampleRate
    const envelope = Math.exp(-t / (decaySeconds / 3.2))
    const sweep = pitchHz * (1 + 1.6 * Math.exp(-t / 0.03))
    buffer[target] += Math.sin(2 * Math.PI * sweep * t) * amplitude * envelope
  }
}

/** High shimmer: two detuned sines with a long fade, for the "wonder" beats. */
function shimmer({ note, startSeconds, durationSeconds, amplitude, sampleRate, buffer }) {
  const frequency = midiToHz(note)
  const startSample = Math.round(startSeconds * sampleRate)
  const length = Math.round(durationSeconds * sampleRate)
  for (let n = 0; n < length; n += 1) {
    const target = startSample + n
    if (target >= buffer.length) break
    const t = n / sampleRate
    const envelope = Math.sin(Math.PI * Math.min(1, t / durationSeconds)) ** 1.5
    const wobble = Math.sin(2 * Math.PI * 0.23 * t) * 0.5 + 0.5
    buffer[target] +=
      (Math.sin(2 * Math.PI * frequency * t) + 0.6 * Math.sin(2 * Math.PI * frequency * 1.005 * t)) *
      amplitude * envelope * (0.6 + 0.4 * wobble) * 0.5
  }
}

/* ------------------------------------------------------------------ *
 * Reverb (Schroeder: 4 combs + 1 allpass pair)
 * ------------------------------------------------------------------ */

function reverb(buffer, sampleRate, { mix = 0.22, decay = 0.72 } = {}) {
  if (mix <= 0) return buffer
  const combDelays = [0.0297, 0.0371, 0.0411, 0.0437].map((seconds) => Math.round(seconds * sampleRate))
  const allpassDelays = [0.005, 0.0017].map((seconds) => Math.round(seconds * sampleRate))
  const wet = new Float32Array(buffer.length)
  for (const delay of combDelays) {
    const line = new Float32Array(delay)
    let index = 0
    for (let n = 0; n < buffer.length; n += 1) {
      const delayed = line[index]
      line[index] = buffer[n] + delayed * decay
      wet[n] += delayed * 0.25
      index = (index + 1) % delay
    }
  }
  let current = wet
  for (const delay of allpassDelays) {
    // A real allpass needs two delay lines: one for x[n-M], one for y[n-M].
    // Writing the *output* back into a single line (y[n] = -g*x[n] + y[n-M])
    // creates a pole just inside the unit circle and accumulates DC — measured at
    // +0.128 DC offset, which then dominates every loudness measurement.
    const gain = 0.5
    const inputLine = new Float32Array(delay)
    const outputLine = new Float32Array(delay)
    const next = new Float32Array(current.length)
    let index = 0
    for (let n = 0; n < current.length; n += 1) {
      const x = current[n]
      const delayedInput = inputLine[index]
      const delayedOutput = outputLine[index]
      const y = -gain * x + delayedInput + gain * delayedOutput
      inputLine[index] = x
      outputLine[index] = y
      next[n] = y
      index = (index + 1) % delay
    }
    current = next
  }
  const out = new Float32Array(buffer.length)
  for (let n = 0; n < buffer.length; n += 1) out[n] = buffer[n] * (1 - mix) + current[n] * mix
  return out
}

/**
 * First-order DC blocker.
 *
 * A synth that sums oscillators and feedback delays will always leave a little DC,
 * and a few millivolts of offset is enough to throw off LRUFS/peak measurement,
 * skew a spectral centroid toward 0 Hz, and steal headroom from the loudness
 * normaliser. This is the standard fix: a one-pole high-pass at ~20 Hz.
 */
function removeDc(samples, sampleRate) {
  const pole = 1 - (2 * Math.PI * 20) / sampleRate
  let previousInput = 0
  let previousOutput = 0
  for (let n = 0; n < samples.length; n += 1) {
    const input = samples[n]
    const output = input - previousInput + pole * previousOutput
    samples[n] = output
    previousInput = input
    previousOutput = output
  }
  return samples
}

/* ------------------------------------------------------------------ *
 * Harmony
 * ------------------------------------------------------------------ */

/**
 * Chord progressions, as scale degrees over a minor tonic.
 *
 * `i–VI–III–VII` is the "cinematic minor": resolves to relative major every four
 * bars, which is why it can carry both melancholy and forward motion. The other
 * presets stay in the same key world so two cues can sit back to back.
 */
export const PROGRESSIONS = Object.freeze({
  /** Gravity with hope — the default for a documentary that ends upward. */
  cinematic: Object.freeze([
    { degree: 0, quality: 'minor' },
    { degree: 8, quality: 'major' },
    { degree: 3, quality: 'major' },
    { degree: 10, quality: 'major' },
  ]),
  /** Slow, unresolved — for the long explanatory middle. */
  contemplative: Object.freeze([
    { degree: 0, quality: 'minor' },
    { degree: 3, quality: 'major' },
    { degree: 10, quality: 'major' },
    { degree: 8, quality: 'major' },
  ]),
  /** Rises at the fourth bar — for climaxes and reveals. */
  ascendant: Object.freeze([
    { degree: 0, quality: 'minor' },
    { degree: 5, quality: 'minor' },
    { degree: 8, quality: 'major' },
    { degree: 10, quality: 'major' },
  ]),
  /** Ends on the tonic — for the closing minute. */
  resolve: Object.freeze([
    { degree: 8, quality: 'major' },
    { degree: 10, quality: 'major' },
    { degree: 0, quality: 'minor' },
    { degree: 0, quality: 'minor' },
  ]),
})

/** Mood presets: tempo, register, which voices are on, and how busy the arpeggio is. */
export const MOODS = Object.freeze({
  /** Wide and empty: pad + sparse pluck. Use under narration that carries the scene. */
  sparse: Object.freeze({ tempo: 62, padGain: 0.5, pluckGain: 0.28, pulseGain: 0, shimmerGain: 0.1, arpEveryBeats: 4, register: 0 }),
  /** A pulse enters: "we are going somewhere". Main explanatory mode. */
  steady: Object.freeze({ tempo: 68, padGain: 0.42, pluckGain: 0.36, pulseGain: 0.22, shimmerGain: 0.12, arpEveryBeats: 2, register: 0 }),
  /** Full: pulse on every beat, arpeggio running, octave-up plucks. Reveals. */
  driving: Object.freeze({ tempo: 76, padGain: 0.38, pluckGain: 0.4, pulseGain: 0.34, shimmerGain: 0.16, arpEveryBeats: 1, register: 12 }),
  /** Thin and high: the "one person, one idea" moments. */
  intimate: Object.freeze({ tempo: 58, padGain: 0.46, pluckGain: 0.34, pulseGain: 0, shimmerGain: 0.2, arpEveryBeats: 3, register: 12 }),
})

/* ------------------------------------------------------------------ *
 * Score
 * ------------------------------------------------------------------ */

const DEFAULT_OPTIONS = Object.freeze({
  sampleRate: 48000,
  tonicMidi: 57, // A3
  progression: 'cinematic',
  mood: 'steady',
  seed: 1,
  reverbMix: 0.24,
  peakDb: -6,
})

/**
 * Render a score.
 *
 * @param {object} options
 * @param {number} options.durationSeconds total length
 * @param {string} [options.mood] one of MOODS
 * @param {string} [options.progression] one of PROGRESSIONS
 * @param {Array<{fromSeconds: number, toSeconds: number, mood?: string, gain?: number, labelZh?: string}>} [options.sections]
 *   section plan; each section scales its own voices and may switch mood
 * @param {number} [options.tonicMidi] MIDI note of the tonic (default A3 = 57)
 * @param {number} [options.sampleRate]
 * @param {number} [options.seed]
 * @param {boolean} [options.reverb]
 * @returns {{samples: Float32Array, sampleRate: number, durationSeconds: number, sections: Array<object>, peak: number}}
 */
export function buildScore(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...(options !== null && typeof options === 'object' ? options : {}) }
  const durationSeconds = Number(config.durationSeconds)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('buildScore: durationSeconds 必须是正数')
  }
  const sampleRate = Number(config.sampleRate)
  if (!Number.isInteger(sampleRate) || sampleRate < 8000) {
    throw new Error('buildScore: sampleRate 必须是 >= 8000 的整数')
  }
  const random = makeRandom(config.seed)
  const totalSamples = Math.ceil(durationSeconds * sampleRate)
  const buffer = new Float32Array(totalSamples)

  const progression = PROGRESSIONS[config.progression] ?? PROGRESSIONS.cinematic
  const baseMood = MOODS[config.mood] ?? MOODS.steady

  // The section plan defaults to one section covering the whole film.
  const sections = Array.isArray(config.sections) && config.sections.length > 0
    ? config.sections.map((section, index) => ({
        index,
        fromSeconds: clamp(Number(section.fromSeconds) || 0, 0, durationSeconds),
        toSeconds: clamp(Number(section.toSeconds) || durationSeconds, 0, durationSeconds),
        mood: typeof section.mood === 'string' && MOODS[section.mood] ? section.mood : config.mood,
        gain: Number.isFinite(Number(section.gain)) ? clamp(Number(section.gain), 0, 2) : 1,
        labelZh: typeof section.labelZh === 'string' ? section.labelZh : '',
      })).sort((a, b) => a.fromSeconds - b.fromSeconds)
    : [{ index: 0, fromSeconds: 0, toSeconds: durationSeconds, mood: config.mood, gain: 1, labelZh: '' }]

  const tonic = Number.isFinite(config.tonicMidi) ? config.tonicMidi : DEFAULT_OPTIONS.tonicMidi
  const chordNotes = (chord) => {
    const root = tonic + chord.degree
    return chord.quality === 'minor' ? [root, root + 3, root + 7, root + 12] : [root, root + 4, root + 7, root + 12]
  }

  for (const section of sections) {
    const mood = MOODS[section.mood] ?? baseMood
    const beatSeconds = 60 / mood.tempo
    const barSeconds = beatSeconds * 4
    const length = section.toSeconds - section.fromSeconds
    if (length <= 0) continue
    const bars = Math.max(1, Math.ceil(length / barSeconds))

    for (let bar = 0; bar < bars; bar += 1) {
      const barStart = section.fromSeconds + bar * barSeconds
      if (barStart >= section.toSeconds) break
      const chord = progression[bar % progression.length]
      const notes = chordNotes(chord)
      const gain = section.gain * (0.9 + random() * 0.2)

      // Pad bed: one long chord per bar, overlapping the next by a little.
      const padLength = Math.min(barSeconds * 1.12, section.toSeconds - barStart)
      if (padLength > 0.2) {
        for (const note of notes.slice(0, 3)) {
          pad({
            note,
            startSeconds: barStart,
            durationSeconds: padLength,
            amplitude: mood.padGain * gain * 0.28,
            sampleRate,
            buffer,
            attack: barSeconds * 0.5,
            release: barSeconds * 0.6,
          })
        }
      }

      // Pluck pattern: root on the downbeat, then chord tones on the arpeggio grid.
      const eventsPerBar = 4 / mood.arpEveryBeats
      for (let step = 0; step < eventsPerBar * 2; step += 1) {
        const at = barStart + (step / (eventsPerBar * 2)) * barSeconds
        if (at >= section.toSeconds) break
        // Leave the first half of the first bar of a section empty sometimes, so
        // sections breathe instead of every one starting with a full flourish.
        if (bar === 0 && step === 0 && random() < 0.35) continue
        const noteIndex = step % notes.length
        const note = notes[noteIndex] + mood.register + (step % 2 === 1 ? 12 : 0)
        const jitter = (random() - 0.5) * 0.012
        pluck({
          note,
          startSeconds: Math.max(0, at + jitter),
          durationSeconds: Math.min(2.6, section.toSeconds - at + 0.5),
          amplitude: mood.pluckGain * gain * (step === 0 ? 0.9 : 0.6) * (0.85 + random() * 0.3),
          sampleRate,
          buffer,
          damping: 0.45 + random() * 0.2,
          brightness: 0.3 + random() * 0.3,
          random,
        })
      }

      // Pulse: every beat in driving sections, every other beat otherwise.
      if (mood.pulseGain > 0) {
        for (let beat = 0; beat < 4; beat += 1) {
          const at = barStart + beat * beatSeconds
          if (at >= section.toSeconds) break
          const strength = beat === 0 ? 1 : beat === 2 ? 0.7 : 0.45
          pulse({
            startSeconds: at,
            amplitude: mood.pulseGain * gain * strength * 0.24,
            sampleRate,
            buffer,
            pitchHz: 46 + random() * 6,
          })
        }
      }

      // Shimmer: on the last bar of a section, mark the lift.
      if (mood.shimmerGain > 0 && bar === bars - 1) {
        shimmer({
          note: notes[2] + 12 + mood.register,
          startSeconds: barStart + barSeconds * 0.25,
          durationSeconds: Math.min(3.5, section.toSeconds - barStart),
          amplitude: mood.shimmerGain * gain * 0.1,
          sampleRate,
          buffer,
        })
      }
    }
  }

  const processed = removeDc(config.reverb === false ? buffer : reverb(buffer, sampleRate, { mix: config.reverbMix }), sampleRate)

  // Normalise to the requested peak, then a global fade in/out so a cue can be
  // butt-joined to the next one without a click.
  let peak = 0
  for (const value of processed) peak = Math.max(peak, Math.abs(value))
  const targetPeak = 10 ** (clamp(Number(config.peakDb) || -6, -30, -0.5) / 20)
  const scale = peak > 1e-9 ? targetPeak / peak : 0
  const fadeIn = Math.min(2, durationSeconds * 0.1)
  const fadeOut = Math.min(3.5, durationSeconds * 0.15)
  for (let n = 0; n < processed.length; n += 1) {
    const t = n / sampleRate
    const inGain = fadeIn <= 0 ? 1 : Math.min(1, t / fadeIn)
    const outGain = fadeOut <= 0 ? 1 : Math.min(1, (durationSeconds - t) / fadeOut)
    processed[n] *= scale * Math.max(0, Math.min(inGain, outGain))
  }

  return { samples: processed, sampleRate, durationSeconds, sections, peak: Number(targetPeak.toFixed(4)) }
}

/**
 * 16-bit PCM WAV, stereo, with a gentle stereo width (the pad is duplicated with
 * a few-hundred-sample offset so it does not collapse to the centre).
 */
export function encodeScoreWav(samples, sampleRate, options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const width = Number.isFinite(Number(settings.stereoWidthMs)) ? clamp(Number(settings.stereoWidthMs), 0, 30) : 8
  const offset = Math.round((width / 1000) * sampleRate)
  const channels = 2
  const dataBytes = samples.length * channels * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * 2, 28)
  buffer.writeUInt16LE(channels * 2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  let cursor = 44
  for (let n = 0; n < samples.length; n += 1) {
    const left = samples[n]
    const rightIndex = n + offset < samples.length ? n + offset : n
    const right = samples[rightIndex]
    buffer.writeInt16LE(Math.round(clamp(left, -1, 1) * 32767), cursor)
    buffer.writeInt16LE(Math.round(clamp(right, -1, 1) * 32767), cursor + 2)
    cursor += 4
  }
  return buffer
}

/** Render a score and write it as a WAV file. */
export async function writeScoreWav(filePath, options = {}) {
  const score = buildScore(options)
  const wav = encodeScoreWav(score.samples, score.sampleRate, options)
  await writeFile(filePath, wav)
  return { path: filePath, bytes: wav.length, durationSeconds: score.durationSeconds, sections: score.sections, peak: score.peak }
}

export default {
  buildScore,
  encodeScoreWav,
  writeScoreWav,
  midiToHz,
  PROGRESSIONS,
  MOODS,
}
