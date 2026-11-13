#!/usr/bin/env node
/**
 * media-senses — audio engine test suite.
 *
 * Two layers:
 *  1. `selfTest()` exercises the pure DSP kernels in lib/dsp.js against known
 *     analytic answers (DFT brute force, synthetic key/tempo/chord inputs).
 *  2. Integration checks run `analyzeAudio()` on generated fixtures with known
 *     ground truth (120 BPM, C major, 24 s, 4/4, intro/verse/chorus) and on the
 *     degraded inputs the contract requires to survive: silence, a 1-second
 *     clip, a file with no audio stream, and unreadable input.
 *
 * Every assertion prints PASS or FAIL; the process exits non-zero on failure.
 *
 * Run from `media-senses/`:  node test/audio-engine.test.mjs
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { analyzeAudio } from '../lib/audio.js'
import * as dsp from '../lib/dsp.js'
import { resolveTools, run } from '../lib/ffmpeg.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const FIXTURE_MP3 = join(FIXTURES, 'tone-120bpm-c-major.mp3')
const FIXTURE_WAV = join(FIXTURES, 'tone-120bpm-c-major.wav')
const SILENT_WAV = join(FIXTURES, 'silence-2s.wav')
const SHORT_WAV = join(FIXTURES, 'short-1s.wav')
const NO_AUDIO_MP4 = join(FIXTURES, 'no-audio.mp4')

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const DENSITIES = new Set(['sparse', 'moderate', 'dense'])
const BRIGHTNESS = new Set(['dark', 'warm', 'neutral', 'bright'])
const SECTION_LABELS = new Set(['intro', 'verse', 'chorus', 'break', 'outro'])

let passed = 0
let failed = 0

/** Run one synchronous assertion. */
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name} -- ${error.message}`)
  }
}

/** Run one asynchronous assertion. */
async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name} -- ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — pure DSP self tests
// ---------------------------------------------------------------------------

/** Verify the dependency-free DSP kernels against analytic references. */
function selfTest() {
  check('dsp.fft: coincides with a brute-force DFT', () => {
    const n = 64
    const signal = new Float64Array(n)
    for (let i = 0; i < n; i += 1) signal[i] = Math.sin((2 * Math.PI * 7 * i) / n) + 0.5 * Math.cos((2 * Math.PI * 13 * i) / n)
    const real = Float64Array.from(signal)
    const imag = new Float64Array(n)
    dsp.fft(real, imag)
    let maxError = 0
    for (let k = 0; k < n; k += 1) {
      let sumReal = 0
      let sumImag = 0
      for (let t = 0; t < n; t += 1) {
        const angle = (-2 * Math.PI * k * t) / n
        sumReal += signal[t] * Math.cos(angle)
        sumImag += signal[t] * Math.sin(angle)
      }
      maxError = Math.max(maxError, Math.abs(sumReal - real[k]), Math.abs(sumImag - imag[k]))
    }
    assert.ok(maxError < 1e-9, `max DFT error ${maxError}`)
  })

  check('dsp.fft: rejects non power-of-two lengths', () => {
    assert.throws(() => dsp.fft(new Float64Array(6), new Float64Array(6)))
  })

  check('dsp.hann: periodic window shape', () => {
    const window = dsp.hann(1024)
    assert.equal(window.length, 1024)
    assert.equal(window[0], 0)
    assert.ok(Math.abs(window[512] - 1) < 1e-12)
    assert.ok(window[1023] > 0 && window[1023] < window[512])
  })

  check('dsp.melFilterbank: 40 triangular bands over all bins', () => {
    const filters = dsp.melFilterbank(22050, 2048, { bands: 40 })
    assert.ok(filters.length >= 30, `got ${filters.length} bands`)
    let previousStart = -1
    for (const filter of filters) {
      assert.ok(filter.weights.length > 0)
      assert.ok(filter.start >= previousStart, 'filter starts must increase')
      previousStart = filter.start
      for (const weight of filter.weights) assert.ok(weight >= 0 && weight <= 1)
    }
  })

  check('dsp.mel filterbank round-trips a single tone into one band', () => {
    const sampleRate = 22050
    const nFft = 2048
    const filters = dsp.melFilterbank(sampleRate, nFft, { bands: 40 })
    const power = new Float64Array(nFft / 2 + 1)
    const targetBin = Math.round((1000 * nFft) / sampleRate)
    power[targetBin] = 1
    const bands = dsp.applyMelFilterbank(power, filters)
    let maxIndex = 0
    for (let i = 1; i < bands.length; i += 1) if (bands[i] > bands[maxIndex]) maxIndex = i
    let expectedIndex = 0
    for (let i = 0; i < filters.length; i += 1) {
      if (filters[i].start <= targetBin && targetBin < filters[i].start + filters[i].weights.length) expectedIndex = i
    }
    assert.equal(maxIndex, expectedIndex)
  })

  check('dsp.hzToMel/melToHz: inverse pair', () => {
    for (const hz of [40, 440, 1000, 8000]) assert.ok(Math.abs(dsp.melToHz(dsp.hzToMel(hz)) - hz) < 1e-6)
  })

  check('dsp.frequencyToMidi: A4 = 69 and C4 = 60', () => {
    assert.ok(Math.abs(dsp.frequencyToMidi(440) - 69) < 1e-9)
    assert.ok(Math.abs(dsp.frequencyToMidi(261.6255653) - 60) < 1e-5)
  })

  check('dsp.chromaFromSpectrum: a 440 Hz tone centres on A', () => {
    const sampleRate = 22050
    const nFft = 2048
    const frame = new Float64Array(nFft)
    for (let i = 0; i < nFft; i += 1) frame[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate)
    const magnitudes = dsp.frameMagnitudes(frame, dsp.hann(nFft))
    const chroma = dsp.chromaFromSpectrum(magnitudes, sampleRate, nFft)
    let maxIndex = 0
    for (let i = 1; i < 12; i += 1) if (chroma[i] > chroma[maxIndex]) maxIndex = i
    assert.equal(maxIndex, 9, 'A has pitch-class index 9')
  })

  check('dsp.estimateTuning: recovers a synthetic +7 cent offset', () => {
    const histogram = new Float64Array(1200)
    for (let semitone = 1; semitone < 12; semitone += 1) {
      histogram[semitone * 100 + 7] = 1
      histogram[semitone * 100 + 8] = 0.2
    }
    const tuning = dsp.estimateTuning(histogram)
    assert.ok(Math.abs(tuning - 7) < 1.5, `estimated ${tuning.toFixed(2)} cents`)
  })

  check('dsp.estimateTuning: in-tune comb gives ~0 cents', () => {
    const histogram = new Float64Array(1200)
    for (let semitone = 0; semitone < 12; semitone += 1) histogram[semitone * 100] = 1
    assert.ok(Math.abs(dsp.estimateTuning(histogram)) < 0.5)
  })

  check('dsp.pearsonCorrelation: perfect and inverted linear relations', () => {
    const a = [1, 2, 3, 4, 5]
    assert.ok(Math.abs(dsp.pearsonCorrelation(a, a) - 1) < 1e-12)
    assert.ok(Math.abs(dsp.pearsonCorrelation(a, a.map((value) => -value)) + 1) < 1e-12)
    assert.equal(dsp.pearsonCorrelation([1, 1, 1], [1, 2, 3]), 0)
  })

  check('dsp.detectKey: a synthetic C-major chroma yields C major', () => {
    const chroma = new Float64Array(12)
    for (const pitchClass of [0, 4, 7]) chroma[pitchClass] = 1.3
    for (const pitchClass of [2, 5, 9, 11]) chroma[pitchClass] = 0.45
    const key = dsp.detectKey(chroma, { tuningCents: 0 })
    assert.equal(key.tonic, 'C')
    assert.equal(key.mode, 'major')
    assert.equal(key.name, 'C major')
    assert.ok(key.confidence > 0.3)
    assert.equal(key.candidates.length, 3)
  })

  check('dsp.normalisedAutocorrelation: impulse train peaks at its period', () => {
    const frameRate = 100
    const period = 50 // 120 BPM at 100 fps
    const signal = new Float64Array(500)
    for (let index = 0; index < signal.length; index += period) signal[index] = 1
    const acf = dsp.normalisedAutocorrelation(signal, 150)
    let maxLag = 1
    for (let lag = 2; lag < acf.length; lag += 1) if (acf[lag] > acf[maxLag]) maxLag = lag
    assert.ok(Math.abs(maxLag - period) <= 1, `peak lag ${maxLag}`)
  })

  check('dsp.estimateTempo: synthetic 120 BPM onset grid', () => {
    const frameRate = 86.1328125
    const envelope = new Float64Array(Math.round(24 * frameRate))
    for (let beat = 0; beat < 48; beat += 1) envelope[Math.round(beat * 0.5 * frameRate)] = 1
    const estimate = dsp.estimateTempo(dsp.normaliseOnsetEnvelope(envelope, 16), frameRate)
    assert.ok(estimate.bpm !== null && Math.abs(estimate.bpm - 120) <= 1.5, `bpm ${estimate.bpm}`)
    assert.ok(estimate.confidence > 0.5)
    assert.ok(estimate.bpmCandidates.length >= 1)
  })

  check('dsp.trackBeats: synthetic 120 BPM grid yields ~48 beats', () => {
    const frameRate = 86.1328125
    const envelope = new Float64Array(Math.round(24 * frameRate))
    for (let beat = 0; beat < 48; beat += 1) envelope[Math.round(beat * 0.5 * frameRate)] = 1
    const beats = dsp.trackBeats(dsp.normaliseOnsetEnvelope(envelope, 16), frameRate, 120)
    assert.ok(beats.beatCount >= 46 && beats.beatCount <= 50, `beatCount ${beats.beatCount}`)
    assert.ok(beats.beatTimes.every((time, index) => index === 0 || time > beats.beatTimes[index - 1]))
    assert.ok(beats.regularity > 0.8)
  })

  check('dsp.foldTempo: octave-folds into [60, 190]', () => {
    assert.ok(Math.abs(dsp.foldTempo(240) - 120) < 1e-9)
    assert.ok(Math.abs(dsp.foldTempo(30) - 60) < 1e-9)
    assert.ok(Math.abs(dsp.foldTempo(60) - 60) < 1e-9)
    assert.ok(Math.abs(dsp.foldTempo(200) - 100) < 1e-9)
    assert.equal(dsp.foldTempo(0), null)
  })

  check('dsp.peakPick: finds spaced local maxima', () => {
    const values = [0, 0.1, 0, 0.9, 0, 0.8, 0, 0.1, 0]
    assert.deepEqual(dsp.peakPick(values, { threshold: 0.3, minSpacing: 1 }), [3, 5])
    assert.deepEqual(dsp.peakPick(values, { threshold: 0.3, minSpacing: 3 }), [3])
  })

  check('dsp.checkerboardNovelty: detects a two-block boundary', () => {
    const features = []
    for (let i = 0; i < 10; i += 1) features.push(Float64Array.from([1, 0, 0, 0]))
    for (let i = 0; i < 10; i += 1) features.push(Float64Array.from([0, 1, 0, 0]))
    const matrix = dsp.selfSimilarityMatrix(features)
    const novelty = dsp.checkerboardNovelty(matrix, 3)
    let maxIndex = 0
    for (let i = 1; i < novelty.length; i += 1) if (novelty[i] > novelty[maxIndex]) maxIndex = i
    assert.ok(Math.abs(maxIndex - 10) <= 1, `novelty peak at ${maxIndex}`)
    assert.ok(novelty[maxIndex] > 0.3)
  })

  check('dsp.medianFilter3: removes a single-frame spike', () => {
    const frames = [Float64Array.from([1, 1]), Float64Array.from([9, 1]), Float64Array.from([1, 1])]
    const filtered = dsp.medianFilter3(frames)
    assert.deepEqual(Array.from(filtered[1]), [1, 1])
  })

  check('dsp.chordTemplates: 24 triads, C-major chroma matches C', () => {
    const templates = dsp.chordTemplates()
    assert.equal(templates.length, 24)
    assert.ok(templates.some((template) => template.name === 'C'))
    assert.ok(templates.some((template) => template.name === 'Am'))
    const chroma = new Float64Array(12)
    chroma[0] = 1
    chroma[4] = 0.9
    chroma[7] = 0.8
    const ranked = dsp.scoreChordTemplates(chroma, templates)
    assert.equal(ranked[0].name, 'C')
  })

  check('dsp.viterbiDecode: switches once between two preferred states', () => {
    const emissions = []
    for (let frame = 0; frame < 10; frame += 1) {
      emissions.push(Float64Array.from(frame < 5 ? [1, 0] : [0, 1]))
    }
    const path = dsp.viterbiDecode(emissions, 0.1)
    assert.deepEqual(path.slice(0, 5), [0, 0, 0, 0, 0])
    assert.deepEqual(path.slice(5), [1, 1, 1, 1, 1])
  })

  check('dsp.spectralFlatness: flat spectrum high, pure tone low', () => {
    const flat = new Float64Array(1025).fill(1)
    const tonal = new Float64Array(1025)
    tonal[100] = 1
    assert.ok(dsp.spectralFlatness(flat) > 0.9)
    assert.ok(dsp.spectralFlatness(tonal) < 0.2)
  })

  check('dsp.modulationEnergyShare: detects a 6 Hz amplitude modulation', () => {
    const frameRate = 86.1328125
    const count = Math.round(4 * frameRate)
    const fast = new Float64Array(count)
    const slow = new Float64Array(count)
    for (let i = 0; i < count; i += 1) {
      fast[i] = 1 + Math.sin((2 * Math.PI * 6 * i) / frameRate)
      slow[i] = 1 + Math.sin((2 * Math.PI * 1 * i) / frameRate)
    }
    assert.ok(dsp.modulationEnergyShare(fast, frameRate, 4, 8) > 0.35)
    assert.ok(dsp.modulationEnergyShare(slow, frameRate, 4, 8) < 0.05)
  })

  check('dsp helpers: percentile, median, dB, zero-crossing', () => {
    assert.equal(dsp.median([3, 1, 2]), 2)
    assert.ok(Math.abs(dsp.percentile([0, 1, 2, 3, 4], 0.5) - 2) < 1e-12)
    assert.equal(dsp.amplitudeToDb(1), 0)
    assert.equal(dsp.amplitudeToDb(0), -120)
    assert.ok(Math.abs(dsp.zeroCrossingRate(Float64Array.from([1, -1, 1, -1])) - 1) < 1e-12)
    assert.ok(Math.abs(dsp.cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-12)
    assert.ok(Math.abs(dsp.chromaSharpness(Float64Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) - 1) < 1e-12)
  })
}

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

/** Recursively assert every numeric leaf is a finite JS number. */
function assertFiniteNumbers(value, path = 'result') {
  if (value === null) return
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is not finite: ${value}`)
    return
  }
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertFiniteNumbers(entry, `${path}[${index}]`))
    return
  }
  assert.equal(typeof value, 'object', `${path} is not JSON-safe (${typeof value})`)
  for (const [key, entry] of Object.entries(value)) assertFiniteNumbers(entry, `${path}.${key}`)
}

/** Assert the value is a plain JSON structure and survives a round trip. */
function assertJsonRoundTrip(value) {
  const text = JSON.stringify(value)
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 100, 'serialized result is suspiciously small')
  assert.deepEqual(JSON.parse(text), value)
}

/** Assert the four chart/spectrogram artifact files are real PNGs. */
async function assertPng(path, label, minimumBytes = 500) {
  const info = await stat(path)
  assert.ok(info.isFile(), `${label} is not a file`)
  assert.ok(info.size >= minimumBytes, `${label} is only ${info.size} bytes`)
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(8)
    await handle.read(header, 0, 8, 0)
    assert.deepEqual([...header], PNG_SIGNATURE, `${label} is not a PNG`)
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------
// Layer 2 — integration tests
// ---------------------------------------------------------------------------

/** Generate the fixtures on first run (the script is idempotent). */
async function ensureFixtures() {
  try {
    const info = await stat(FIXTURE_MP3)
    if (info.size > 1000) return
  } catch {
    // Fall through to generation.
  }
  await execFileAsync(process.execPath, [join(HERE, 'make-audio-fixture.mjs')], { cwd: dirname(HERE) })
}

async function makeScratchWorkDir(root, name) {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  return dir
}

async function main() {
  selfTest()

  await ensureFixtures()
  const tools = await resolveTools()
  const scratch = await mkdtemp(join(tmpdir(), 'media-senses-audio-test-'))
  try {
    const artifactRoot = join(scratch, 'artifacts')
    const fixtureWork = await makeScratchWorkDir(scratch, 'work-fixture')
    let result
    await checkAsync('analyzeAudio: analyses the 24 s fixture without throwing', async () => {
      result = await analyzeAudio({
        tools,
        file: FIXTURE_MP3,
        workDir: fixtureWork,
        options: { artifactDir: artifactRoot, sampleRate: 22050 },
      })
    })

    check('fixture: shape, kind and duration', () => {
      assert.equal(result.kind, 'audio')
      assert.ok(Math.abs(result.duration - 24) <= 0.6, `duration ${result.duration}`)
      assert.ok(result.analyzed.seconds >= 23.5 && result.analyzed.seconds <= 24.5)
      assert.equal(result.analyzed.start, 0)
      assert.equal(result.analyzed.sampleRate, 22050)
      assert.equal(result.format.codec, 'mp3')
      assert.equal(result.format.container, 'mp3')
      assert.ok(result.format.bitRate > 0)
      assert.equal(result.format.channels, 1)
      assert.equal(result.format.sampleRate, 44100)
    })

    check('fixture: BPM within 3 of 120', () => {
      assert.ok(result.tempo.bpm !== null, 'bpm is null')
      assert.ok(Math.abs(result.tempo.bpm - 120) <= 3, `bpm ${result.tempo.bpm}`)
      assert.ok(result.tempo.confidence > 0.4, `confidence ${result.tempo.confidence}`)
      assert.ok(result.tempo.bpmCandidates.length >= 1)
      for (let i = 1; i < result.tempo.bpmCandidates.length; i += 1) {
        assert.ok(result.tempo.bpmCandidates[i - 1] > 0)
      }
    })

    check('fixture: 48 beats with 4/4 and a regular grid', () => {
      assert.ok(result.tempo.beatCount >= 30, `beatCount ${result.tempo.beatCount}`)
      assert.ok(Math.abs(result.tempo.beatCount - 48) <= 2, `expected ~48 beats, got ${result.tempo.beatCount}`)
      assert.equal(result.tempo.timeSignatureGuess, 4)
      assert.ok(result.tempo.regularity > 0.7, `regularity ${result.tempo.regularity}`)
      assert.ok(result.tempo.beatTimes.length <= 64)
      assert.ok(result.tempo.beatTimes.length >= 30)
      for (let i = 1; i < result.tempo.beatTimes.length; i += 1) {
        assert.ok(result.tempo.beatTimes[i] > result.tempo.beatTimes[i - 1], 'beat times must increase')
      }
      assert.ok(result.tempo.beatTimes[0] < 0.5, 'first beat should be near the start')
    })

    check('fixture: key is C major', () => {
      assert.ok(result.key !== null, 'key is null')
      assert.equal(result.key.tonic, 'C')
      assert.equal(result.key.mode, 'major')
      assert.equal(result.key.name, 'C major')
      assert.ok(result.key.confidence > 0.4, `confidence ${result.key.confidence}`)
      assert.ok(Math.abs(result.key.tuned) <= 50)
      assert.equal(result.key.candidates.length, 3)
      for (const candidate of result.key.candidates) {
        assert.ok(Number.isFinite(candidate.score))
        assert.ok(typeof candidate.name === 'string')
      }
      for (let i = 1; i < result.key.candidates.length; i += 1) {
        assert.ok(result.key.candidates[i - 1].score >= result.key.candidates[i].score, 'candidates must be score-sorted')
      }
    })

    check('fixture: chroma has 12 values peaking at C, E and G', () => {
      assert.equal(result.chroma.mean.length, 12)
      assert.deepEqual(result.chroma.labels, ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])
      for (const value of result.chroma.mean) assert.ok(value >= 0 && value <= 1)
      assert.equal(result.chroma.mean[0], 1, 'C should be the strongest pitch class')
      const ranked = result.chroma.mean
        .map((value, index) => ({ value, index }))
        .sort((a, b) => b.value - a.value)
      assert.deepEqual([...new Set(ranked.slice(0, 3).map((entry) => entry.index))].sort((a, b) => a - b), [0, 4, 7])
    })

    check('fixture: at least 3 contiguous sections with labels and notes', () => {
      assert.ok(result.sections.length >= 3, `sections ${result.sections.length}`)
      assert.equal(result.sections[0].start, 0)
      for (let i = 0; i < result.sections.length; i += 1) {
        const section = result.sections[i]
        assert.ok(section.end > section.start)
        assert.ok(Math.abs(section.duration - (section.end - section.start)) < 0.02)
        assert.ok(section.energy >= 0 && section.energy <= 1)
        assert.ok(typeof section.note === 'string' && section.note.length > 0)
        assert.ok(typeof section.label === 'string' && section.label.length > 0)
        assert.ok(section.label === `section ${i + 1}` || SECTION_LABELS.has(section.label), `unexpected label ${section.label}`)
        assert.ok(section.bpm === null || Number.isFinite(section.bpm))
        if (i > 0) assert.ok(Math.abs(section.start - result.sections[i - 1].end) < 0.05, 'sections must be contiguous')
      }
      assert.ok(Math.abs(result.sections[result.sections.length - 1].end - result.analyzed.seconds) < 0.05)
      assert.ok(result.sections.some((section) => section.label === 'chorus'))
    })

    check('fixture: loudness numbers are finite and plausible', () => {
      const loudness = result.loudness
      for (const key of ['peakDbfs', 'rmsDbfs', 'dynamicRangeDb', 'clippingRatio', 'silenceRatio']) {
        assert.ok(Number.isFinite(loudness[key]), `${key} is not finite`)
      }
      assert.ok(loudness.peakDbfs <= 0 && loudness.peakDbfs > -30, `peak ${loudness.peakDbfs}`)
      assert.ok(loudness.rmsDbfs < 0 && loudness.rmsDbfs > -40, `rms ${loudness.rmsDbfs}`)
      assert.ok(loudness.lufsIntegrated !== null && Number.isFinite(loudness.lufsIntegrated))
      assert.ok(loudness.lufsIntegrated < 0 && loudness.lufsIntegrated > -40)
      assert.ok(loudness.loudnessRangeLu !== null && loudness.loudnessRangeLu >= 0)
      assert.ok(loudness.dynamicRangeDb >= 0)
      assert.ok(loudness.clippingRatio >= 0 && loudness.clippingRatio <= 1)
      assert.ok(loudness.silenceRatio >= 0 && loudness.silenceRatio <= 1)
    })

    check('fixture: timbre, spectrum and rhythm fields are valid', () => {
      const { timbre, spectrum, rhythm } = result
      assert.ok(timbre.centroidHz > 0 && timbre.centroidHz < 22050)
      assert.ok(timbre.rolloffHz > 0 && timbre.rolloffHz <= 11025)
      assert.ok(timbre.flatness >= 0 && timbre.flatness <= 1)
      assert.ok(timbre.zeroCrossRate >= 0 && timbre.zeroCrossRate <= 1)
      assert.ok(BRIGHTNESS.has(timbre.brightness))
      assert.ok(typeof timbre.description === 'string' && timbre.description.length > 0)
      const spectrumSum = spectrum.lowRatio + spectrum.midRatio + spectrum.highRatio
      assert.ok(Math.abs(spectrumSum - 1) < 0.02, `spectrum ratios sum to ${spectrumSum}`)
      for (const key of ['lowRatio', 'midRatio', 'highRatio']) assert.ok(spectrum[key] >= 0 && spectrum[key] <= 1)
      assert.ok(rhythm.onsetsPerSecond > 0)
      assert.ok(DENSITIES.has(rhythm.percussionDensity))
    })

    check('fixture: energy curve has <= 240 finite points', () => {
      assert.ok(result.energyCurve.length >= 10)
      assert.ok(result.energyCurve.length <= 240)
      for (const point of result.energyCurve) {
        assert.ok(Number.isFinite(point.t) && point.t >= 0)
        for (const key of ['rms', 'low', 'high']) assert.ok(point[key] >= 0 && point[key] <= 1, `${key}=${point[key]}`)
      }
      for (let i = 1; i < result.energyCurve.length; i += 1) {
        assert.ok(result.energyCurve[i].t >= result.energyCurve[i - 1].t)
      }
    })

    check('fixture: chord progression is a valid beat-synchronous list', () => {
      assert.ok(result.chords !== null, 'chords are null')
      const progression = result.chords.progression
      assert.ok(progression.length >= 3, `progression length ${progression.length}`)
      for (const entry of progression) {
        assert.ok(entry.end > entry.start, 'chord segments must have positive length')
        assert.ok(typeof entry.name === 'string' && entry.name.length >= 1)
        assert.ok(entry.confidence >= 0 && entry.confidence <= 1)
      }
      for (let i = 1; i < progression.length; i += 1) {
        assert.ok(progression[i].start >= progression[i - 1].start - 0.01)
      }
      assert.ok(result.chords.uniqueNames.length >= 2)
      assert.ok(result.chords.uniqueNames.includes('C'), `unique chords: ${result.chords.uniqueNames.join(',')}`)
      assert.ok(result.chords.rate >= 0)
    })

    check('fixture: vocals/mood heuristics stay inside their ranges', () => {
      assert.equal(typeof result.vocals.present, 'boolean')
      assert.ok(result.vocals.confidence >= 0 && result.vocals.confidence <= 1)
      assert.ok(typeof result.vocals.note === 'string' && result.vocals.note.length > 0)
      assert.ok(result.mood.arousal >= 0 && result.mood.arousal <= 1)
      assert.ok(result.mood.valence >= 0 && result.mood.valence <= 1)
      assert.ok(Array.isArray(result.mood.labels) && result.mood.labels.length >= 1)
      assert.ok(result.mood.labels.every((label) => typeof label === 'string'))
      assert.ok(typeof result.mood.note === 'string' && result.mood.note.length > 0)
    })

    check('fixture: transcript is null (ASR is owned by the plugin shell)', () => {
      assert.equal(result.transcript, null)
    })

    await checkAsync('fixture: all four PNG artifacts exist and are valid PNGs', async () => {
      for (const key of ['waveform', 'spectrogram', 'chromaChart', 'energyChart']) {
        assert.equal(typeof result.artifacts[key], 'string', `${key} artifact missing`)
        assert.ok(result.artifacts[key].startsWith(artifactRoot), `${key} is not inside options.artifactDir`)
        await assertPng(result.artifacts[key], key)
      }
    })

    check('fixture: warnings is an array of strings', () => {
      assert.ok(Array.isArray(result.warnings))
      assert.ok(result.warnings.every((warning) => typeof warning === 'string'))
    })

    check('fixture: every numeric leaf is finite', () => {
      assertFiniteNumbers(result)
    })

    check('fixture: result round-trips through JSON.stringify', () => {
      assertJsonRoundTrip(result)
    })

    // --- Degraded inputs -------------------------------------------------
    await checkAsync('silent file: warns instead of throwing', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-silent')
      const silent = await analyzeAudio({ tools, file: SILENT_WAV, workDir: work, options: { wantArtifacts: false } })
      assert.equal(silent.kind, 'audio')
      assert.ok(silent.warnings.length > 0)
      assert.ok(silent.warnings.some((warning) => warning.includes('静音')))
      assert.equal(silent.tempo.bpm, null)
      assert.equal(silent.tempo.beatCount, 0)
      assert.equal(silent.key, null)
      assert.equal(silent.chords, null)
      assert.deepEqual(silent.sections, [])
      assert.equal(silent.transcript, null)
      assertFiniteNumbers(silent, 'silent')
      assertJsonRoundTrip(silent)
    })

    await checkAsync('1 second clip: warns instead of throwing', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-short')
      const short = await analyzeAudio({ tools, file: SHORT_WAV, workDir: work, options: { wantArtifacts: false } })
      assert.equal(short.kind, 'audio')
      assert.ok(short.warnings.length > 0)
      assert.ok(Math.abs(short.analyzed.seconds - 1) < 0.35)
      assert.equal(short.tempo.bpm, null)
      assert.ok(Number.isFinite(short.loudness.peakDbfs))
      assertFiniteNumbers(short, 'short')
      assertJsonRoundTrip(short)
    })

    await checkAsync('file with no audio stream: warns instead of throwing', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-noaudio')
      const noAudio = await analyzeAudio({ tools, file: NO_AUDIO_MP4, workDir: work, options: { wantArtifacts: false } })
      assert.equal(noAudio.kind, 'audio')
      assert.ok(noAudio.warnings.length > 0)
      assert.ok(noAudio.warnings.some((warning) => warning.includes('没有音频流')))
      assert.equal(noAudio.analyzed.seconds, 0)
      assert.equal(noAudio.key, null)
      assert.equal(noAudio.chords, null)
      assert.deepEqual(noAudio.chroma.mean, new Array(12).fill(0))
      assertFiniteNumbers(noAudio, 'noAudio')
      assertJsonRoundTrip(noAudio)
    })

    await checkAsync('unreadable input: throws (the one fatal case)', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-missing')
      await assert.rejects(
        () => analyzeAudio({ tools, file: join(FIXTURES, 'this-file-does-not-exist.mp3'), workDir: work }),
        /not readable/u,
      )
    })

    // --- Options ---------------------------------------------------------
    await checkAsync('options: asr flags are accepted and ignored (transcript stays null)', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-asr')
      const asr = await analyzeAudio({
        tools,
        file: FIXTURE_MP3,
        workDir: work,
        options: { asr: true, language: 'en', whisperModelPath: 'C:/does/not/exist.bin', wantArtifacts: false },
      })
      assert.equal(asr.transcript, null)
      assert.ok(Math.abs(asr.tempo.bpm - 120) <= 3)
      assertFiniteNumbers(asr, 'asr')
    })

    await checkAsync('options: start/duration select a sub-range', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-range')
      const ranged = await analyzeAudio({
        tools,
        file: FIXTURE_MP3,
        workDir: work,
        options: { start: 8, duration: 8, wantArtifacts: false },
      })
      assert.equal(ranged.analyzed.start, 8)
      assert.ok(Math.abs(ranged.analyzed.seconds - 8) <= 0.2, `seconds ${ranged.analyzed.seconds}`)
      assert.ok(ranged.tempo.bpm !== null && Math.abs(ranged.tempo.bpm - 120) <= 3)
      assert.equal(ranged.duration, result.duration)
    })

    await checkAsync('options: sampleRate is honoured', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-rate')
      const resampled = await analyzeAudio({
        tools,
        file: FIXTURE_MP3,
        workDir: work,
        options: { sampleRate: 16000, wantArtifacts: false },
      })
      assert.equal(resampled.analyzed.sampleRate, 16000)
      assert.equal(resampled.format.sampleRate, 44100)
      assert.ok(resampled.tempo.bpm !== null && Math.abs(resampled.tempo.bpm - 120) <= 3)
    })

    await checkAsync('options: wantArtifacts=false returns no artifact paths', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-noart')
      const noArtifacts = await analyzeAudio({
        tools,
        file: FIXTURE_MP3,
        workDir: work,
        options: { wantArtifacts: false },
      })
      assert.deepEqual(noArtifacts.artifacts, {})
      assertJsonRoundTrip(noArtifacts)
    })

    await checkAsync('regression: omitted options.duration decodes non-integer container lengths', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-float-duration')
      const generated = join(scratch, 'tone-3.331s.wav')
      const made = await run(
        tools.ffmpeg,
        ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3.331', '-ac', '1', '-ar', '22050', generated],
        { cwd: work, timeoutMs: 60_000 },
      )
      assert.equal(made.code, 0, made.stderr)
      const res = await analyzeAudio({ tools, file: generated, workDir: work, options: { wantArtifacts: false } })
      // Regression: a float duration used to produce a float child_process
      // timeout, which made Node throw and the audio decode return 0 seconds.
      assert.ok(res.analyzed.seconds > 3, `decoded only ${res.analyzed.seconds}s`)
      assert.ok(!res.warnings.some((warning) => warning.includes('无法解码')), JSON.stringify(res.warnings))
      const capped = await analyzeAudio({
        tools,
        file: generated,
        workDir: work,
        options: { maxSeconds: 2.37, wantArtifacts: false },
      })
      assert.ok(Math.abs(capped.analyzed.seconds - 2.37) < 0.15, `maxSeconds gave ${capped.analyzed.seconds}s`)
      assert.ok(capped.analyzed.seconds > 0)
      assertFiniteNumbers(capped, 'capped')
    })

    await checkAsync('WAV decode path: the ground-truth fixture also analyses from PCM', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-wav')
      const wav = await analyzeAudio({ tools, file: FIXTURE_WAV, workDir: work, options: { wantArtifacts: false } })
      assert.equal(wav.format.codec, 'pcm_s16le')
      assert.ok(Math.abs(wav.tempo.bpm - 120) <= 3)
      assert.equal(wav.key.name, 'C major')
      assert.ok(wav.sections.length >= 3)
    })

    await checkAsync('deterministic: two runs produce identical JSON', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-determinism')
      const again = await analyzeAudio({ tools, file: FIXTURE_MP3, workDir: work, options: { wantArtifacts: false } })
      const first = await analyzeAudio({ tools, file: FIXTURE_MP3, workDir: work, options: { wantArtifacts: false } })
      assert.equal(JSON.stringify(first), JSON.stringify(again))
    })

    await checkAsync('readable but corrupt media: warns instead of throwing', async () => {
      const corrupt = join(scratch, 'corrupt.mp3')
      await writeFile(corrupt, 'this is definitely not an mp3 file')
      const work = await makeScratchWorkDir(scratch, 'work-corrupt')
      const degraded = await analyzeAudio({ tools, file: corrupt, workDir: work, options: { wantArtifacts: false } })
      assert.equal(degraded.kind, 'audio')
      assert.ok(degraded.warnings.length > 0)
      assert.equal(degraded.analyzed.seconds, 0)
      assertFiniteNumbers(degraded, 'corrupt')
      assertJsonRoundTrip(degraded)
    })

    await checkAsync('abort signal: analysis rejects with AbortError', async () => {
      const work = await makeScratchWorkDir(scratch, 'work-abort')
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        () => analyzeAudio({ tools, file: FIXTURE_MP3, workDir: work, signal: controller.signal }),
        (error) => error.name === 'AbortError',
      )
    })

    // --- Loudness parser unit test --------------------------------------
    await checkAsync('parseEbur128Loudness: parses an ffmpeg summary block', async () => {
      const { parseEbur128Loudness } = await import('../lib/audio.js')
      const text = [
        '  Integrated loudness:',
        '    I:         -15.8 LUFS',
        '    Threshold: -25.8 LUFS',
        '  Loudness range:',
        '    LRA:        13.1 LU',
        '  True peak:',
        '    Peak:       -1.2 dBFS',
      ].join('\n')
      const parsed = parseEbur128Loudness(text)
      assert.ok(Math.abs(parsed.lufsIntegrated + 15.8) < 1e-9)
      assert.ok(Math.abs(parsed.loudnessRangeLu - 13.1) < 1e-9)
      assert.ok(Math.abs(parsed.truePeakDbfs + 1.2) < 1e-9)
      assert.equal(parseEbur128Loudness('').lufsIntegrated, null)
    })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exitCode = 1
  })
  .catch((error) => {
    console.error(`FATAL ${error.stack ?? error.message}`)
    process.exitCode = 1
  })
