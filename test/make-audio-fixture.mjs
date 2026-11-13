#!/usr/bin/env node
/**
 * Generate the ground-truth audio fixtures for the media-senses audio engine.
 *
 * The main fixture is synthesized sample-by-sample in pure Node (no libraries)
 * and then encoded to MP3 with ffmpeg. Its musical content is fully known, so
 * the test suite can assert real measurements instead of golden numbers:
 *
 *   tempo 120 BPM, 4/4, key C major, 24 s = 12 bars of 2 s
 *   bars 0-3  intro : drums only (kick 1/3, snare 2/4, hats on 8ths)
 *   bars 4-7  verse : + bass (roots C G A F), soft triad pad, C-E-G melody
 *   bars 8-11 chorus: same material, louder, crash on the section downbeat
 *
 * Also emitted for robustness tests: `silence-2s.wav` (digital silence),
 * `short-1s.wav` (1 s of tone + clicks) and `no-audio.mp4` (video, -an).
 *
 * Run from `media-senses/`:  node test/make-audio-fixture.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveTools, run } from '../lib/ffmpeg.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const SAMPLE_RATE = 44100
const BPM = 120
const BEAT = 60 / BPM
const BAR = BEAT * 4 // 2 s
const BARS = 12
const DURATION = BAR * BARS // 24 s

/** Deterministic PRNG (mulberry32) so every generated fixture is identical. */
function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TAU = Math.PI * 2
const midiHz = (note) => 440 * 2 ** ((note - 69) / 12)

/** Add a shaped sine partial to the mix buffer. */
function addTone(samples, startSeconds, durationSeconds, frequency, amplitude, options = {}) {
  const start = Math.round(startSeconds * SAMPLE_RATE)
  const length = Math.round(durationSeconds * SAMPLE_RATE)
  const attack = options.attack ?? 0.005
  const release = options.release ?? 0.02
  const harmonics = options.harmonics ?? []
  const phase = options.phase ?? 0
  for (let i = 0; i < length; i += 1) {
    const index = start + i
    if (index < 0 || index >= samples.length) continue
    const t = i / SAMPLE_RATE
    // Linear attack, cosine release, exponential-ish body for plucked sounds.
    const attackGain = attack > 0 ? Math.min(1, t / attack) : 1
    const remaining = durationSeconds - t
    const releaseGain = release > 0 ? Math.min(1, remaining / release) : 1
    const body = options.decay ? Math.exp(-t / options.decay) : 1
    let value = Math.sin(TAU * frequency * t + phase)
    for (const harmonic of harmonics) {
      value += harmonic.amplitude * Math.sin(TAU * frequency * harmonic.ratio * t + phase)
    }
    samples[index] += amplitude * attackGain * Math.max(0, releaseGain) * body * value
  }
}

/** Add a decaying filtered-noise burst (snare / hats / crash). */
function addNoise(samples, random, startSeconds, durationSeconds, amplitude, options = {}) {
  const start = Math.round(startSeconds * SAMPLE_RATE)
  const length = Math.round(durationSeconds * SAMPLE_RATE)
  const decay = options.decay ?? 0.08
  const highPass = options.highPass ?? false
  const lowPass = options.lowPass ?? false
  let previousInput = 0
  let previousOutput = 0
  for (let i = 0; i < length; i += 1) {
    const index = start + i
    if (index < 0 || index >= samples.length) continue
    const t = i / SAMPLE_RATE
    let noise = random() * 2 - 1
    if (highPass) {
      // One-pole high-pass: removes the body, leaves cymbal-like air.
      const output = 0.92 * (previousOutput + noise - previousInput)
      previousInput = noise
      previousOutput = output
      noise = output
    }
    if (lowPass) {
      previousOutput = previousOutput + 0.12 * (noise - previousOutput)
      noise = previousOutput
    }
    const envelope = Math.exp(-t / decay) * Math.min(1, t / 0.002)
    samples[index] += amplitude * envelope * noise
  }
}

/** Four-on-the-floor style kick: pitch sweep 140 Hz -> 50 Hz with fast decay. */
function addKick(samples, startSeconds, amplitude) {
  const start = Math.round(startSeconds * SAMPLE_RATE)
  const length = Math.round(0.4 * SAMPLE_RATE)
  let phase = 0
  for (let i = 0; i < length; i += 1) {
    const index = start + i
    if (index < 0 || index >= samples.length) continue
    const t = i / SAMPLE_RATE
    const frequency = 50 + 90 * Math.exp(-t / 0.028)
    phase += (TAU * frequency) / SAMPLE_RATE
    const envelope = Math.exp(-t / 0.11) * Math.min(1, t / 0.002)
    samples[index] += amplitude * envelope * Math.sin(phase)
  }
}

/** Snare: mid-tone thump plus broadband noise. */
function addSnare(samples, random, startSeconds, amplitude) {
  const start = Math.round(startSeconds * SAMPLE_RATE)
  const length = Math.round(0.25 * SAMPLE_RATE)
  let phase = 0
  for (let i = 0; i < length; i += 1) {
    const index = start + i
    if (index < 0 || index >= samples.length) continue
    const t = i / SAMPLE_RATE
    phase += (TAU * 185) / SAMPLE_RATE
    const toneEnvelope = Math.exp(-t / 0.05) * Math.min(1, t / 0.002)
    const noiseEnvelope = Math.exp(-t / 0.09) * Math.min(1, t / 0.001)
    samples[index] += amplitude * (0.55 * toneEnvelope * Math.sin(phase) + 0.75 * noiseEnvelope * (random() * 2 - 1))
  }
}

/**
 * Synthesize the C-major / 120 BPM / 24 s fixture.
 * @returns {Float32Array} mono samples in [-1, 1]
 */
function synthesizeFixture() {
  const samples = new Float32Array(Math.round(DURATION * SAMPLE_RATE))
  const random = makeRandom(0x5eed)

  // Chord pad voicings, all diatonic to C major. Bass root per bar: C G A F.
  const PROGRESSION = [
    { root: 36, chord: [60, 64, 67] }, // C  (C2 bass, C4 E4 G4)
    { root: 43, chord: [55, 59, 62] }, // G  (G2 bass, G3 B3 D4)
    { root: 45, chord: [57, 60, 64] }, // Am (A2 bass, A3 C4 E4)
    { root: 41, chord: [53, 57, 60] }, // F  (F2 bass, F3 A3 C4)
  ]
  const MELODY = [72, 76, 79, 76, 72, 76, 79, 72] // C5 E5 G5 E5 C5 E5 G5 C5

  for (let bar = 0; bar < BARS; bar += 1) {
    const barStart = bar * BAR
    const section = bar < 4 ? 'intro' : bar < 8 ? 'verse' : 'chorus'
    const gain = section === 'intro' ? 0.75 : section === 'verse' ? 0.92 : 1
    const step = PROGRESSION[bar % 4]

    // --- drums (every section) -------------------------------------------
    for (const beat of [0, 2]) addKick(samples, barStart + beat * BEAT, 0.52 * gain)
    for (const beat of [1, 3]) addSnare(samples, random, barStart + beat * BEAT, 0.34 * gain)
    for (let eighth = 0; eighth < 8; eighth += 1) {
      addNoise(samples, random, barStart + eighth * BEAT * 0.5, 0.07, 0.1 * gain, { decay: 0.018, highPass: true })
    }
    if (bar === 8) addNoise(samples, random, barStart, 1.2, 0.16, { decay: 0.45, highPass: true })

    // --- tonal arrangement (verse + chorus only) -------------------------
    if (section === 'intro') continue
    const tonalGain = section === 'verse' ? 1 : 1.25

    // Bass: two half notes per bar on the chord root (plus its octave).
    for (const offset of [0, 1]) {
      addTone(samples, barStart + offset * BEAT * 2, BEAT * 1.9, midiHz(step.root), 0.26 * tonalGain, {
        attack: 0.01,
        release: 0.08,
        harmonics: [{ ratio: 2, amplitude: 0.3 }],
      })
    }

    // Pad: sustained triad for the whole bar.
    for (const note of step.chord) {
      addTone(samples, barStart, BAR, midiHz(note), 0.05 * tonalGain, { attack: 0.18, release: 0.3 })
    }

    // Melody: eight eighth notes per bar, exclusively C-E-G (the fixture spec).
    for (let eighth = 0; eighth < MELODY.length; eighth += 1) {
      const noteStart = barStart + eighth * BEAT * 0.5
      addTone(samples, noteStart, BEAT * 0.46, midiHz(MELODY[eighth]), 0.2 * tonalGain, {
        attack: 0.008,
        release: 0.05,
        decay: 0.4,
        harmonics: [{ ratio: 2, amplitude: 0.15 }],
      })
    }

    // Chorus extra: octave-doubled melody + open hats on every beat. This makes
    // the final section timbrally (not just dynamically) distinct, which is what
    // the self-similarity structure detector is looking for.
    if (section === 'chorus') {
      for (let eighth = 0; eighth < MELODY.length; eighth += 1) {
        const noteStart = barStart + eighth * BEAT * 0.5
        addTone(samples, noteStart, BEAT * 0.44, midiHz(MELODY[eighth] + 12), 0.06, {
          attack: 0.01,
          release: 0.05,
          decay: 0.4,
        })
      }
      for (const beat of [0, 1, 2, 3]) {
        addNoise(samples, random, barStart + beat * BEAT, 0.16, 0.06, { decay: 0.07, highPass: true })
      }
    }
  }

  // Normalise to a comfortable peak so MP3 encoding does not clip.
  let peak = 0
  for (const value of samples) peak = Math.max(peak, Math.abs(value))
  const scale = peak > 0 ? 0.89 / peak : 0
  for (let i = 0; i < samples.length; i += 1) samples[i] *= scale
  return samples
}

/** Encode mono Float32 samples as a 16-bit PCM WAV buffer. */
function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const dataBytes = samples.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'latin1')
  buffer.write('fmt ', 12, 'latin1')
  buffer.writeUInt32LE(16, 16) // fmt chunk size
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36, 'latin1')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2)
  }
  return buffer
}

/** 1 s test clip: a C5 tone with two clicks so the short-clip path is exercised. */
function synthesizeShortClip() {
  const samples = new Float32Array(Math.round(1 * SAMPLE_RATE))
  addTone(samples, 0, 0.9, midiHz(72), 0.35, { attack: 0.01, release: 0.1 })
  addNoise(samples, makeRandom(7), 0.05, 0.05, 0.2, { decay: 0.02 })
  addNoise(samples, makeRandom(9), 0.55, 0.05, 0.2, { decay: 0.02 })
  return samples
}

async function main() {
  await mkdir(FIXTURES, { recursive: true })
  const tools = await resolveTools()

  const fixtureName = 'tone-120bpm-c-major'
  const wavPath = join(FIXTURES, `${fixtureName}.wav`)
  const mp3Path = join(FIXTURES, `${fixtureName}.mp3`)
  const samples = synthesizeFixture()
  await writeFile(wavPath, encodeWav(samples))
  console.log(`wrote ${basename(wavPath)} (${(samples.length / SAMPLE_RATE).toFixed(2)} s, 120 BPM, C major)`)

  // Encode to MP3. Output name is relative and cwd is the fixtures directory:
  // absolute paths must never appear inside an ffmpeg filter option on Windows,
  // and keeping every output relative is the safest blanket rule.
  const mp3 = await run(
    tools.ffmpeg,
    ['-hide_banner', '-v', 'error', '-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '192k', `${fixtureName}.mp3`],
    { cwd: FIXTURES },
  )
  if (mp3.code !== 0) throw new Error(`MP3 encode failed:\n${mp3.stderr}`)
  console.log(`wrote ${basename(mp3Path)} (192 kbps mp3)`)

  await writeFile(join(FIXTURES, 'silence-2s.wav'), encodeWav(new Float32Array(2 * SAMPLE_RATE)))
  console.log('wrote silence-2s.wav')

  await writeFile(join(FIXTURES, 'short-1s.wav'), encodeWav(synthesizeShortClip()))
  console.log('wrote short-1s.wav')

  // A real video stream with no audio stream, for the "no audio stream" case.
  const video = await run(
    tools.ffmpeg,
    [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=2',
      '-an', '-c:v', 'mpeg4', '-q:v', '5', 'no-audio.mp4',
    ],
    { cwd: FIXTURES },
  )
  if (video.code !== 0) throw new Error(`no-audio.mp4 creation failed:\n${video.stderr}`)
  console.log('wrote no-audio.mp4 (video-only, no audio stream)')
  console.log('fixtures ready:', FIXTURES)
}

main().catch((error) => {
  console.error(`FAIL fixture generation: ${error.message}`)
  process.exitCode = 1
})
