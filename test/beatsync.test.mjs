#!/usr/bin/env node
/**
 * media-senses — beat-grid and backtest test suite.
 *
 * The beat-sync loop is the difference between "cut to a rhythm" and "cut to the
 * music", and every leg of it is a place where a quietly wrong answer looks fine:
 * a tempo scalar that is 2 % off, an octave-ambiguous grid, a cut list that drifts
 * two frames per shot, an output track that lags by an encoder's priming samples.
 * Each check below pins one of those against a fixture whose truth is known.
 *
 * Run from `media-senses/`:  node test/beatsync.test.mjs
 */
import assert from 'node:assert/strict'
import {
  acceptBeatGrid,
  backtestAlignment,
  beatFrame,
  beatTime,
  classifyTransients,
  fitBeatGrid,
  measureOutputAudioOffset,
  planBeatLockedCuts,
  BEAT_GRID_THRESHOLDS,
  BACKTEST_THRESHOLDS,
} from '../lib/beatsync.js'

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

const SR = 48000
const BPM = 131.97
const PERIOD = 60 / BPM
const T0 = 0.2244

/** Deterministic noise: never Math.random, so fixtures are stable across runs. */
function noiseAt(i) {
  const value = Math.sin(i * 12.9898 + 78.233) * 43758.5453
  return (value - Math.floor(value)) * 2 - 1
}

function addBurst(buffer, atSeconds, { hz, decay, amplitude, noiseShare = 0 }) {
  const start = Math.round(atSeconds * SR)
  const length = Math.round(decay * SR)
  for (let i = 0; i < length && start + i < buffer.length; i += 1) {
    const t = i / SR
    // ~1 ms attack then exponential decay: a plausible percussive envelope.
    const envelope = Math.min(1, t / 0.001) * Math.exp(-t / (decay / 3))
    const tone = Math.sin(2 * Math.PI * hz * t)
    buffer[start + i] += amplitude * envelope * ((1 - noiseShare) * tone + noiseShare * noiseAt(start + i))
  }
}

/** A drum track whose grid is known exactly. */
function drumTrack({ kick = 0, snare = 0, hihat = 0, beats = 16, spacing = 1 } = {}) {
  const buffer = new Float32Array(Math.ceil(SR * (T0 + beats * PERIOD * spacing + 1)))
  for (let n = 0; n < beats; n += 1) {
    const at = T0 + n * PERIOD * spacing
    if (kick > 0) addBurst(buffer, at, { hz: 55, decay: 0.2, amplitude: kick })
    if (snare > 0 && n % 4 === 2) {
      addBurst(buffer, at, { hz: 300, decay: 0.12, amplitude: snare })
      addBurst(buffer, at, { hz: 2000, decay: 0.1, amplitude: snare * 0.55, noiseShare: 0.8 })
    }
    if (hihat > 0) addBurst(buffer, at + PERIOD * spacing * 0.5, { hz: 9500, decay: 0.03, amplitude: hihat, noiseShare: 0.95 })
  }
  return buffer
}

/* ------------------------------------------------------------------ *
 * 1. Grid fitting — least squares over the beat sequence, not a tempo scalar
 * ------------------------------------------------------------------ */

check('fitBeatGrid recovers an exact 131.97 BPM grid', () => {
  const beats = Array.from({ length: 40 }, (_, n) => T0 + n * PERIOD)
  const grid = fitBeatGrid(beats)
  assert.ok(Math.abs(grid.bpm - BPM) < 0.05, `bpm ${grid.bpm}`)
  assert.ok(Math.abs(grid.period - PERIOD) < 0.001, `period ${grid.period}`)
  assert.ok(Math.abs(grid.t0 - T0) < 0.01, `t0 ${grid.t0}`)
  assert.equal(grid.count, 40)
  assert.equal(grid.pass, true)
  assert.ok(grid.residualMaxMs < 1, `residual ${grid.residualMaxMs}`)
})

check('fitBeatGrid averages out jitter instead of chasing it', () => {
  // ±8 ms of timing noise is normal for a real recording.
  const beats = Array.from({ length: 60 }, (_, n) => T0 + n * PERIOD + ((n * 7919) % 17 - 8) / 1000)
  const grid = fitBeatGrid(beats)
  assert.ok(Math.abs(grid.bpm - BPM) < 0.15, `bpm ${grid.bpm}`)
  assert.ok(grid.residualMaxMs <= 15, `residual ${grid.residualMaxMs} should stay inside the tolerance`)
  assert.equal(grid.pass, true)
})

check('fitBeatGrid refuses input that is not a beat sequence', () => {
  const empty = fitBeatGrid([])
  assert.equal(empty.bpm, null)
  assert.equal(empty.pass, false)
  const one = fitBeatGrid([1])
  assert.equal(one.period, null)
  // Unsorted input is sorted first, which is deliberate: the caller may well hand
  // over detections in frame-decode order. What must NOT happen is a non-positive
  // period slipping through.
  const backwards = fitBeatGrid([5, 4, 3, 2])
  assert.ok(Math.abs(backwards.bpm - 60) < 0.01, `bpm ${backwards.bpm}`)
  assert.equal(fitBeatGrid([2, 2]).period, null, 'a zero-length period is not a grid')
})

check('fitBeatGrid accepts the {beats: [...]} object form', () => {
  const beats = Array.from({ length: 20 }, (_, n) => n * 0.5)
  const grid = fitBeatGrid({ beats })
  assert.ok(Math.abs(grid.bpm - 120) < 0.01, `bpm ${grid.bpm}`)
  assert.equal(grid.count, 20)
})

/* ------------------------------------------------------------------ *
 * 2. Octave disambiguation — the 2x/0.5x trap
 * ------------------------------------------------------------------ */

check('acceptBeatGrid resolves the octave using the drum evidence', () => {
  const beats = Array.from({ length: 32 }, (_, n) => T0 + n * PERIOD)
  const fitted = fitBeatGrid(beats)
  const candidates = [0.5, 1, 2].map((factor) => ({
    ...fitted,
    bpm: fitted.bpm * factor,
    period: fitted.period / factor,
  }))
  const resolved = acceptBeatGrid(candidates, beats)
  assert.ok(resolved.winner, 'a winner is required')
  assert.ok(Math.abs(resolved.winner.bpm - BPM) < 1, `winner ${resolved.winner.bpm}`)
  assert.equal(resolved.winnerIndex, 1)
  assert.ok(typeof resolved.reasonZh === 'string' && resolved.reasonZh.length > 10, 'the reason must be readable')
  // Every candidate is scored, so the caller can write the vote into an artifact.
  assert.equal(resolved.scores.length, 3)
  for (const score of resolved.scores) {
    assert.ok(Number.isFinite(score.match) && score.match >= 0 && score.match <= 1, `match ${score.match}`)
    assert.ok(Number.isFinite(score.coverage), `coverage ${score.coverage}`)
    assert.ok(['accept', 'reject'].includes(score.verdict), `verdict ${score.verdict}`)
  }
  // The doubled candidate must lose on precision: half its beats fall between hits.
  const doubled = resolved.scores[2]
  assert.ok(doubled.match < 0.6, `2x candidate match ${doubled.match} should be about a half`)
})

check('acceptBeatGrid reports a usable reason when there is nothing to vote on', () => {
  const resolved = acceptBeatGrid([120], [])
  assert.equal(resolved.winner, null)
  assert.ok(resolved.reasonZh.includes('瞬态'))
  assert.deepEqual(resolved.scores, [])
})

/* ------------------------------------------------------------------ *
 * 3. Drum classification — band evidence, judged on the body
 * ------------------------------------------------------------------ */

check('classifyTransients calls an isolated kick a kick', () => {
  const out = classifyTransients(drumTrack({ kick: 0.9 }), SR, {})
  assert.ok(out.hits.length >= 12, `hits ${out.hits.length}`)
  assert.equal(out.kick.length, out.hits.length, 'every hit should be a kick')
  assert.equal(out.snare.length + out.hihat.length, 0)
})

check('classifyTransients calls an isolated 300 Hz drum a snare, not a kick', () => {
  // The regression this pins: measured on the onset frame alone, a 300 Hz body
  // came out as "kick" because the amplitude jump is broadband. It has to be
  // judged after the attack.
  const out = classifyTransients(drumTrack({ snare: 0.9 }), SR, {})
  assert.ok(out.hits.length >= 3, `hits ${out.hits.length}`)
  assert.equal(out.kick.length, 0, `300Hz body must not read as kick: ${JSON.stringify(out.kick)}`)
  assert.equal(out.snare.length, out.hits.length, `expected all snare, got ${JSON.stringify(out.hits.map((hit) => hit.kind))}`)
})

check('classifyTransients calls broadband noise a hi-hat', () => {
  const out = classifyTransients(drumTrack({ hihat: 0.3 }), SR, {})
  assert.ok(out.hits.length >= 3, `hits ${out.hits.length}`)
  assert.equal(out.kick.length + out.snare.length, 0, `noise must not read as a drum: ${JSON.stringify(out.hits.map((hit) => hit.kind))}`)
  assert.ok(out.hihat.length === out.hits.length)
})

check('classifyTransients survives silence and absurd input', () => {
  const silent = classifyTransients(new Float32Array(SR), SR, {})
  assert.deepEqual(silent.hits, [])
  assert.ok(silent.warnings.length > 0)
  const tiny = classifyTransients(new Float32Array(16), SR, {})
  assert.deepEqual(tiny.hits, [])
  assert.throws(() => classifyTransients(new Float32Array(64), 0, {}), /sampleRate/u)
})

check('classifyTransients is deterministic', () => {
  const track = drumTrack({ kick: 0.9, hihat: 0.3 })
  const a = classifyTransients(track, SR, {})
  const b = classifyTransients(track, SR, {})
  assert.deepEqual(a.hits, b.hits)
})

/* ------------------------------------------------------------------ *
 * 4. Beat numbering — seconds and frames
 * ------------------------------------------------------------------ */

check('beatTime / beatFrame map beat numbers to time and frames', () => {
  const grid = { bpm: 120, t0: 0.5, period: 0.5 }
  assert.ok(Math.abs(beatTime(0, grid) - 0.5) < 1e-9)
  assert.ok(Math.abs(beatTime(4, grid) - 2.5) < 1e-9)
  const frame = beatFrame(4, grid, 30, 0)
  assert.equal(frame, Math.round(2.5 * 30))
})

check('the output-audio offset shifts beat times without touching the grid', () => {
  const grid = { bpm: 120, t0: 0.5, period: 0.5 }
  const offset = 2 / 30
  const shifted = beatTime(4, grid, offset)
  // beatTime rounds to six decimals, so compare at that resolution.
  assert.ok(Math.abs(shifted - (2.5 + offset)) < 1e-5, `shifted ${shifted}`)
  // The measured grid values must stay untouched: only the offset moves.
  assert.equal(grid.t0, 0.5)
  assert.equal(beatFrame(4, grid, 30, offset), Math.round((2.5 + offset) * 30))
})

/* ------------------------------------------------------------------ *
 * 5. Beat-locked cuts
 * ------------------------------------------------------------------ */

check('planBeatLockedCuts puts every boundary on a beat', () => {
  const grid = fitBeatGrid(Array.from({ length: 40 }, (_, n) => T0 + n * PERIOD))
  const cuts = planBeatLockedCuts({ grid, fps: 30, shotBeats: [8, 8, 8, 4], startBeat: 0 })
  assert.equal(cuts.length, 4)
  for (const row of cuts) {
    const beat = (row.toFrame / 30 - grid.t0) / grid.period
    assert.ok(Math.abs(beat - Math.round(beat)) * grid.period < 0.5 / 30, `boundary at beat ${beat}`)
  }
  const total = cuts.reduce((sum, row) => sum + row.beats, 0)
  assert.equal(total, 28)
})

check('planBeatLockedCuts accepts an explicit cut list', () => {
  const grid = { bpm: 120, t0: 0, period: 0.5 }
  const cuts = planBeatLockedCuts({ grid, fps: 30, cutBeats: [8, 16, 24] })
  assert.equal(cuts.length, 3)
  assert.equal(cuts[0].fromFrame, 0)
  assert.equal(cuts[2].toFrame, Math.round(12 * 30))
})

check('planBeatLockedCuts rejects a plan it cannot interpret', () => {
  const grid = { bpm: 120, t0: 0, period: 0.5 }
  assert.throws(() => planBeatLockedCuts({ grid, fps: 30 }), /cutBeats|shotBeats|shots/u)
  assert.throws(() => planBeatLockedCuts({ grid, fps: 0, cutBeats: [4] }), /fps/u)
})

/* ------------------------------------------------------------------ *
 * 6. Post-render backtest
 * ------------------------------------------------------------------ */

check('backtestAlignment passes a perfectly aligned cut list', () => {
  const designed = [0, 120, 240, 360]
  const result = backtestAlignment(designed, designed.map((frame) => frame / 30), 30)
  assert.equal(result.pass, true)
  assert.equal(result.ideal, true)
  assert.equal(result.maxAbsFrames, 0)
  assert.equal(result.within3Ratio, 1)
})

check('backtestAlignment catches one cut that is five frames late', () => {
  const designed = [0, 120, 240, 360]
  const measured = designed.map((frame, index) => (index === 2 ? (frame + 5) / 30 : frame / 30))
  const result = backtestAlignment(designed, measured, 30)
  assert.equal(result.pass, false)
  assert.ok(result.maxAbsFrames >= 4.9, `max ${result.maxAbsFrames}`)
  // The offending cut has to be identifiable, not just "something is off".
  const flagged = result.rows.filter((row) => Math.abs(row.errorFrames) >= 4.9)
  assert.equal(flagged.length, 1)
  assert.equal(flagged[0].designedFrame, 240)
})

check('backtest thresholds are the perceptual ones', () => {
  assert.equal(BACKTEST_THRESHOLDS.passFrames, 3)
  assert.equal(BACKTEST_THRESHOLDS.idealFrames, 1.5)
  assert.equal(BEAT_GRID_THRESHOLDS.meanAbsMs, 10)
})

/* ------------------------------------------------------------------ *
 * 7. Output-track lag by cross-correlation
 * ------------------------------------------------------------------ */

check('measureOutputAudioOffset finds a known delay', () => {
  // A non-periodic probe. A looped drum pattern has equally good correlation at
  // every period multiple, so it would test the alias tie-break, not the lag.
  const original = new Float32Array(SR * 3)
  for (let i = 0; i < original.length; i += 1) {
    original[i] = noiseAt(i) * 0.5 * Math.exp(-(i % SR) / (SR * 0.4))
  }
  const lag = 2048
  const rendered = new Float32Array(original.length + lag)
  rendered.set(original, lag) // the rendered content arrives later
  const measured = measureOutputAudioOffset(original, rendered, SR)
  assert.ok(Math.abs(Math.abs(measured.offsetSamples) - lag) <= 64, `offset ${measured.offsetSamples}`)
  assert.ok(measured.correlation > 0.9, `correlation ${measured.correlation}`)
  // 2048 samples at 48 kHz is ~42.7 ms, i.e. the AAC-priming scale of ~1.28 f@30.
  assert.ok(Math.abs(measured.offsetFrames - 1.28) < 0.1, `frames ${measured.offsetFrames}`)
})

check('measureOutputAudioOffset stays honest on a looping pattern', () => {
  // On an exactly periodic source the answer is ambiguous by whole periods; the
  // contract is that whatever it returns is a real correlation peak, not that it
  // magically disambiguates. This pins "still a peak" so a future change cannot
  // silently return noise.
  const source = drumTrack({ kick: 0.9 })
  const original = source.slice(0, SR * 4)
  const lag = 2048
  const rendered = new Float32Array(original.length + lag)
  rendered.set(original, lag)
  const measured = measureOutputAudioOffset(original, rendered, SR)
  assert.ok(Math.abs(measured.correlation) > 0.9, `correlation ${measured.correlation}`)
  assert.equal(measured.pass, true)
})

check('measureOutputAudioOffset does not invent a lag for identical signals', () => {
  const source = drumTrack({ kick: 0.9 }).slice(0, SR * 2)
  const measured = measureOutputAudioOffset(source, source, SR)
  assert.ok(Math.abs(measured.offsetSamples) <= 8, `offset ${measured.offsetSamples}`)
})

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log('')
console.log(`${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`\n--- ${failure.name} ---`)
    console.log(failure.error instanceof Error ? failure.error.stack ?? failure.error.message : String(failure.error))
  }
  process.exitCode = 1
}
