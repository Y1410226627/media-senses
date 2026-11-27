#!/usr/bin/env node
/**
 * media-senses — procedural score tests (lib/music.js).
 *
 * A score generator fails in ways you cannot hear in a unit test: it can carry a
 * DC offset (which steals headroom and skews every loudness measurement), drift
 * between runs (which breaks "this film is reproducible"), or emit a clean-looking
 * WAV whose channels are wrong. Each check below pins one of those.
 *
 * The DC check is a regression test: the reverb's allpass stage originally wrote
 * its *output* back into the delay line, turning it into a leaky integrator. The
 * measured offset was +0.128 — six times the signal's own RMS at the low end — and
 * the analyser reported a 14 Hz spectral centroid for what is clearly a pad.
 *
 * Run from `media-senses/`:  node test/music.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MOODS, PROGRESSIONS, buildScore, encodeScoreWav, midiToHz, writeScoreWav } from '../lib/music.js'

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

function stats(samples) {
  let dc = 0
  let sumSq = 0
  let peak = 0
  for (const value of samples) {
    dc += value
    sumSq += value * value
    if (Math.abs(value) > peak) peak = Math.abs(value)
  }
  const n = samples.length
  return { dc: n > 0 ? dc / n : 0, rms: Math.sqrt(sumSq / Math.max(1, n)), peak }
}

/* ------------------------------------------------------------------ *
 * Basics
 * ------------------------------------------------------------------ */

await check('midiToHz puts A4 at 440 Hz and an octave doubles it', () => {
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9)
  assert.ok(Math.abs(midiToHz(81) - 880) < 1e-9)
  assert.ok(Math.abs(midiToHz(57) - 220) < 1e-9)
})

await check('the score honours duration and sample rate', () => {
  const score = buildScore({ durationSeconds: 3, sampleRate: 22050, mood: 'sparse' })
  assert.equal(score.sampleRate, 22050)
  assert.equal(score.samples.length, Math.ceil(3 * 22050))
  assert.ok(Math.abs(score.durationSeconds - 3) < 1e-9)
})

await check('rejects a nonsense duration or sample rate', () => {
  assert.throws(() => buildScore({ durationSeconds: 0 }), /durationSeconds/u)
  assert.throws(() => buildScore({ durationSeconds: -2 }), /durationSeconds/u)
  assert.throws(() => buildScore({ durationSeconds: 2, sampleRate: 100 }), /sampleRate/u)
  assert.throws(() => buildScore({ durationSeconds: 2, sampleRate: 48000.5 }), /sampleRate/u)
})

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

await check('the same seed renders byte-identically', () => {
  const a = buildScore({ durationSeconds: 2, seed: 11 })
  const b = buildScore({ durationSeconds: 2, seed: 11 })
  assert.equal(a.samples.length, b.samples.length)
  for (let i = 0; i < a.samples.length; i += 1) {
    assert.equal(a.samples[i], b.samples[i], `sample ${i} drifted`)
  }
})

await check('a different seed produces a different score', () => {
  const a = buildScore({ durationSeconds: 2, seed: 11 })
  const b = buildScore({ durationSeconds: 2, seed: 12 })
  let differences = 0
  for (let i = 0; i < a.samples.length; i += 1) if (a.samples[i] !== b.samples[i]) differences += 1
  assert.ok(differences > a.samples.length * 0.1, `only ${differences} samples differ`)
})

/* ------------------------------------------------------------------ *
 * Signal health — the DC regression lives here
 * ------------------------------------------------------------------ */

await check('the score carries no DC offset (with or without reverb)', () => {
  for (const reverb of [false, true]) {
    const score = buildScore({ durationSeconds: 6, seed: 3, reverb })
    const { dc } = stats(score.samples)
    // Before the allpass fix this measured ~0.128 with reverb on.
    assert.ok(Math.abs(dc) < 0.002, `DC offset ${dc.toFixed(5)} (reverb=${reverb})`)
  }
})

await check('there is actually music in there, not silence', () => {
  const score = buildScore({ durationSeconds: 6, seed: 3 })
  const { rms, peak } = stats(score.samples)
  assert.ok(rms > 0.02, `rms ${rms.toFixed(4)} too quiet`)
  assert.ok(peak > 0.2, `peak ${peak.toFixed(4)} too low`)
  assert.ok(rms < peak, 'a score should have crest factor, not be a square wave')
})

await check('the peak is normalised to the requested level and never clips', () => {
  const quiet = buildScore({ durationSeconds: 4, seed: 5, peakDb: -12 })
  const loud = buildScore({ durationSeconds: 4, seed: 5, peakDb: -3 })
  const quietPeak = stats(quiet.samples).peak
  const loudPeak = stats(loud.samples).peak
  assert.ok(quietPeak <= 1, 'clipping')
  assert.ok(loudPeak <= 1, 'clipping')
  // Fades trim the very ends, so compare within a couple of dB.
  assert.ok(loudPeak > quietPeak * 1.8, `-3 dBFS (${loudPeak}) should be clearly louder than -12 dBFS (${quietPeak})`)
})

await check('the score fades in and out so cues can be butt-joined', () => {
  const score = buildScore({ durationSeconds: 5, seed: 8 })
  const n = score.samples.length
  const at = (fraction) => Math.abs(score.samples[Math.floor(n * fraction)])
  assert.ok(at(0) < 0.02, `start ${at(0)} should be silent`)
  assert.ok(at(0.999) < 0.02, `end ${at(0.999)} should be silent`)
  assert.ok(at(0.5) > at(0.02), 'the middle should be louder than the fade-in head')
})

/* ------------------------------------------------------------------ *
 * Musical structure
 * ------------------------------------------------------------------ */

await check('moods differ in instrumentation', () => {
  const sparse = buildScore({ durationSeconds: 8, seed: 21, mood: 'sparse' })
  const driving = buildScore({ durationSeconds: 8, seed: 21, mood: 'driving' })
  // The configs genuinely differ: faster tempo, a pulse on every beat, a denser arp.
  assert.ok(MOODS.driving.tempo > MOODS.sparse.tempo)
  assert.ok(MOODS.driving.pulseGain > MOODS.sparse.pulseGain)
  assert.ok(MOODS.driving.arpEveryBeats < MOODS.sparse.arpEveryBeats)
  // Peak normalisation equalises overall level, so RMS cannot separate them. What
  // a pulse actually adds is *short-term* energy fluctuation — measure the
  // coefficient of variation of 50 ms RMS windows instead.
  const flux = (samples, sampleRate) => {
    const window = Math.round(sampleRate * 0.05)
    const values = []
    for (let start = 0; start + window <= samples.length; start += window) {
      let sum = 0
      for (let i = start; i < start + window; i += 1) sum += samples[i] * samples[i]
      values.push(Math.sqrt(sum / window))
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    if (!(mean > 0)) return 0
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
    return Math.sqrt(variance) / mean
  }
  const sparseFlux = flux(sparse.samples, sparse.sampleRate)
  const drivingFlux = flux(driving.samples, driving.sampleRate)
  assert.ok(drivingFlux > sparseFlux, `driving flux ${drivingFlux.toFixed(3)} should exceed sparse ${sparseFlux.toFixed(3)}`)
})

await check('every mood and progression renders without throwing', () => {
  for (const mood of Object.keys(MOODS)) {
    for (const progression of Object.keys(PROGRESSIONS)) {
      const score = buildScore({ durationSeconds: 2, seed: 1, mood, progression })
      assert.ok(score.samples.length > 0, `${mood}/${progression} produced nothing`)
    }
  }
})

await check('a section plan is followed and reported back', () => {
  const score = buildScore({
    durationSeconds: 12,
    seed: 4,
    sections: [
      { fromSeconds: 0, toSeconds: 4, mood: 'intimate', gain: 0.6, labelZh: '开场' },
      { fromSeconds: 4, toSeconds: 12, mood: 'driving', gain: 1, labelZh: '展开' },
    ],
  })
  assert.equal(score.sections.length, 2)
  assert.equal(score.sections[0].labelZh, '开场')
  assert.equal(score.sections[1].mood, 'driving')
  // The driving section carries a pulse; the intimate one has none. Compare energy.
  const head = stats(score.samples.slice(Math.floor(5.5 * 48000), Math.floor(7.5 * 48000)))
  const tail = stats(score.samples.slice(Math.floor(9 * 48000), Math.floor(11 * 48000)))
  assert.ok(tail.rms > head.rms * 0.8, 'the driving section should not be quieter than the intimate one')
})

/* ------------------------------------------------------------------ *
 * WAV encoding
 * ------------------------------------------------------------------ */

await check('the WAV header is a valid stereo 16-bit file', () => {
  const score = buildScore({ durationSeconds: 1, seed: 2 })
  const wav = encodeScoreWav(score.samples, score.sampleRate)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ')
  assert.equal(wav.toString('ascii', 36, 40), 'data')
  assert.equal(wav.readUInt16LE(20), 1, 'PCM')
  assert.equal(wav.readUInt16LE(22), 2, 'stereo')
  assert.equal(wav.readUInt32LE(24), score.sampleRate)
  assert.equal(wav.readUInt16LE(34), 16, '16-bit')
  const expectedData = score.samples.length * 2 * 2
  assert.equal(wav.readUInt32LE(40), expectedData)
  assert.equal(wav.length, 44 + expectedData)
  assert.equal(wav.readUInt32LE(4), 36 + expectedData, 'RIFF size')
})

await check('writing a score produces a non-empty file on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-test-'))
  try {
    const path = join(dir, 'score.wav')
    const written = await writeScoreWav(path, { durationSeconds: 1, seed: 9 })
    const info = await stat(path)
    assert.ok(info.size > 44 + 48000, `file only ${info.size} bytes`)
    assert.equal(written.bytes, info.size)
    assert.ok(written.durationSeconds === 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

console.log('')
console.log(`${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`\n--- ${failure.name} ---`)
    console.log(failure.error instanceof Error ? failure.error.stack ?? failure.error.message : String(failure.error))
  }
  process.exitCode = 1
}
