#!/usr/bin/env node
/**
 * Acceptance tests for the media-senses video perception engine.
 *
 * Run: node test/video-engine.test.mjs
 *
 * Prints PASS/FAIL per assertion and exits non-zero when anything fails. The
 * fixtures are built by test/make-video-fixture.mjs; this script builds them
 * automatically when they are missing so the test is a single command.
 *
 * Audio: `lib/audio.js` is owned by another teammate, so `analyzeAudio` is
 * injected as a stub that returns a minimal valid AudioAnalysis and records the
 * call it received. When the real module exists the shell can re-run this test
 * with the real function without changing the video engine.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWorkDir, removeWorkDir, resolveTools } from '../lib/ffmpeg.js'
import { analyzeVideo } from '../lib/video.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const ARTIFACTS = join(FIXTURES, 'artifacts')
const SCENES = join(FIXTURES, 'scenes.mp4')
const TINY = join(FIXTURES, 'tiny-solid.mp4')
const MUTED = join(FIXTURES, 'muted-3s.mp4')
const STATIC = join(FIXTURES, 'static-30s.mp4')
const TRUNCATED = join(FIXTURES, 'truncated.mp4')

const HEX_PATTERN = /^#[0-9a-f]{6}$/u
// Hue-map letters: R/O/Y/G/C/B/M hue families, '.' for grey/black/white.
const HUE_LETTERS = new Set(['R', 'O', 'Y', 'G', 'C', 'B', 'M', '.'])
const SHEET_CELL_WIDTH = 480
const SHEET_CELL_HEIGHT = 270

let passed = 0
let failed = 0

/** Run one assertion block, printing PASS/FAIL. */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(`FAIL  ${name}`)
    console.log(`      ${message.split(/\r?\n/u).join('\n      ')}`)
  }
}

function assertFiniteTree(value, path) {
  if (value === null) return
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is not a finite number (${value})`)
    return
  }
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteTree(item, `${path}[${index}]`))
    return
  }
  assert.equal(typeof value, 'object', `${path} has unsupported type ${typeof value}`)
  assert.ok(!(value instanceof Date), `${path} is a Date`)
  assert.ok(!(value instanceof Map), `${path} is a Map`)
  for (const [key, item] of Object.entries(value)) {
    assert.notEqual(item, undefined, `${path}.${key} is undefined`)
    assertFiniteTree(item, `${path}.${key}`)
  }
}

function assertJsonSafe(result) {
  assertFiniteTree(result, 'result')
  const roundTripped = JSON.parse(JSON.stringify(result))
  assert.deepEqual(roundTripped, result, 'report does not survive a JSON round-trip unchanged')
}

function assertRange(value, min, max, name) {
  assert.equal(typeof value, 'number', `${name} is not a number`)
  assert.ok(Number.isFinite(value), `${name} is not finite`)
  assert.ok(value >= min && value <= max, `${name}=${value} is outside [${min}, ${max}]`)
}

function assertShotVisuals(shot) {
  assert.ok(typeof shot.ascii === 'string' && shot.ascii.trim().length > 0, `shot ${shot.index} ascii is empty`)
  assert.ok(typeof shot.hueMap === 'string' && shot.hueMap.length > 0, `shot ${shot.index} hueMap is empty`)
  assert.ok(Array.isArray(shot.palette) && shot.palette.length > 0, `shot ${shot.index} palette is empty`)
  const asciiRows = shot.ascii.split('\n')
  assert.ok(asciiRows.length <= 20, `shot ${shot.index} ascii has ${asciiRows.length} rows`)
  for (const row of asciiRows) assert.ok(row.length <= 44, `shot ${shot.index} ascii row is ${row.length} chars`)
  const hueRows = shot.hueMap.split('\n')
  assert.ok(hueRows.length <= 20, `shot ${shot.index} hueMap has ${hueRows.length} rows`)
  for (const row of hueRows) {
    for (const letter of row) assert.ok(HUE_LETTERS.has(letter), `shot ${shot.index} hueMap has invalid letter ${letter}`)
  }
  let shareSum = 0
  for (const entry of shot.palette) {
    assert.match(entry.hex, HEX_PATTERN, `shot ${shot.index} palette hex ${entry.hex}`)
    assertRange(entry.share, 0, 1, `shot ${shot.index} palette share`)
    shareSum += entry.share
  }
  assert.ok(shareSum <= 1.001, `shot ${shot.index} palette shares sum to ${shareSum}`)
  assert.ok(typeof shot.layout === 'string' && shot.layout.length > 0, `shot ${shot.index} layout is empty`)
}

function assertTimeline(timeline) {
  assert.ok(Array.isArray(timeline), 'timeline is not an array')
  assert.ok(timeline.length >= 1, 'timeline is empty')
  assert.ok(timeline.length <= 300, `timeline has ${timeline.length} points (> 300)`)
  let previousTime = -1
  for (const point of timeline) {
    assert.ok(point.t > previousTime, `timeline t=${point.t} is not increasing`)
    previousTime = point.t
    assertRange(point.brightness, 0, 1, `timeline brightness at ${point.t}`)
    assertRange(point.saturation, 0, 1, `timeline saturation at ${point.t}`)
    assert.ok(point.motion >= 0 && point.motion <= 100, `timeline motion at ${point.t}=${point.motion}`)
  }
}

/** Read a PNG's pixel dimensions from its IHDR header. */
async function pngSize(path) {
  const head = await readFile(path)
  assert.ok(head.length >= 24, `${path} is too small to be a PNG`)
  assert.equal(head.toString('latin1', 1, 4), 'PNG', `${path} is not a PNG`)
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

/**
 * Minimal but complete AudioAnalysis stand-in (contract shape).
 *
 * The vocals/timbre/spectrum numbers deliberately mirror what the REAL audio
 * engine measures on the fixture's 440 Hz sine: confident "vocals" from the
 * band-energy heuristic, spectral flatness 0 and all energy in the mid band.
 * That lets the test prove `likelyTalkingHead` is gated on real speech evidence
 * (broadband/flat spectrum) rather than on the vocal heuristic alone.
 */
function stubAudioReport() {
  return {
    kind: 'audio',
    duration: 12,
    analyzed: { start: 0, seconds: 12, sampleRate: 22050 },
    format: { codec: 'aac', container: 'mp4', bitRate: 128000, channels: 1, sampleRate: 44100 },
    loudness: {
      peakDbfs: -1.5,
      rmsDbfs: -14.2,
      lufsIntegrated: -15.1,
      loudnessRangeLu: 3.2,
      dynamicRangeDb: 6.4,
      clippingRatio: 0,
      silenceRatio: 0,
    },
    tempo: {
      bpm: 112.6,
      bpmCandidates: [112.6, 56.3, 225.2],
      confidence: 0.217,
      beatCount: 24,
      beatTimes: [0, 0.5, 1, 1.5],
      timeSignatureGuess: 4,
      regularity: 0.9,
    },
    key: null,
    chroma: { mean: Array.from({ length: 12 }, (_value, index) => 0.1 + index * 0.001), labels: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] },
    timbre: {
      centroidHz: 446,
      rolloffHz: 460,
      flatness: 0,
      zeroCrossRate: 0.04,
      brightness: 'dark',
      description: 'stub timbre for the video-engine test (pure 440 Hz sine)',
    },
    spectrum: { lowRatio: 0, midRatio: 1, highRatio: 0 },
    rhythm: { onsetRate: 0, onsetsPerSecond: 0, percussionDensity: 'sparse' },
    sections: [{ start: 0, end: 12, duration: 12, label: 'section 1', energy: 0.5, bpm: 112.6, note: 'stub section' }],
    chords: null,
    energyCurve: [{ t: 0, rms: 0.2, low: 0.2, high: 0.1 }],
    // Pure-tone vocal false positive, as measured from the real audio engine.
    vocals: { present: true, confidence: 0.855, note: 'stub: pure-tone vocal false positive' },
    mood: { arousal: 0.4, valence: 0.5, labels: ['calm'], note: 'stub mood' },
    transcript: null,
    artifacts: {},
    warnings: [],
  }
}

async function ensureFixtures() {
  const required = [SCENES, TINY, MUTED, STATIC, TRUNCATED]
  let missing = false
  for (const path of required) {
    try {
      await stat(path)
    } catch {
      missing = true
    }
  }
  if (!missing) return
  console.log('fixtures missing; building them with test/make-video-fixture.mjs ...')
  execFileSync(process.execPath, [join(HERE, 'make-video-fixture.mjs')], { stdio: 'inherit' })
}

function printShotTable(result) {
  console.log('      shot table (start-end  brightness  saturation  hue  motion):')
  for (const shot of result.shots) {
    const start = `${shot.start.toFixed(2)}-${shot.end.toFixed(2)}`
    console.log(
      `        #${shot.index} ${start.padEnd(15)} ${String(shot.brightness).padEnd(11)} ` +
        `${String(shot.saturation).padEnd(11)} ${shot.hueName.padEnd(8)} ${shot.motion}`,
    )
  }
}

async function main() {
  await ensureFixtures()
  await rm(ARTIFACTS, { recursive: true, force: true })
  await mkdir(ARTIFACTS, { recursive: true })
  const tools = await resolveTools()
  console.log(`ffmpeg: ${tools.version}`)
  const workDir = await makeWorkDir('ms-video-test')
  const audioCalls = []
  const stubAnalyzeAudio = async (payload) => {
    audioCalls.push(payload)
    return stubAudioReport()
  }

  let scenes = null
  try {
    /* ---------------- main 3-scene fixture ---------------- */
    await check('analyzeVideo returns a kind=video report on the 3-scene fixture', async () => {
      scenes = await analyzeVideo({
        tools,
        file: SCENES,
        workDir,
        options: { artifactDir: join(ARTIFACTS, 'scenes') },
        analyzeAudio: stubAnalyzeAudio,
      })
      assert.equal(scenes.kind, 'video')
      assert.ok(Array.isArray(scenes.warnings))
      for (const warning of scenes.warnings) assert.equal(typeof warning, 'string')
    })
    printShotTable(scenes)
    console.log(`      warnings: ${JSON.stringify(scenes.warnings)}`)

    await check('duration is approximately 12 s', async () => {
      assert.ok(Math.abs(scenes.duration - 12) <= 0.5, `duration=${scenes.duration}`)
    })

    await check('shots.length is 3 (+/-1) and shots are contiguous', async () => {
      assert.ok(scenes.shots.length >= 2 && scenes.shots.length <= 4, `shots.length=${scenes.shots.length}`)
      let previousEnd = 0
      for (const shot of scenes.shots) {
        assert.ok(shot.duration > 0.3, `shot ${shot.index} duration=${shot.duration}`)
        assert.ok(Math.abs(shot.start - previousEnd) < 0.05, `shot ${shot.index} starts at ${shot.start}, previous ended at ${previousEnd}`)
        assert.ok(Math.abs(shot.end - shot.start - shot.duration) < 0.02, `shot ${shot.index} duration is inconsistent`)
        previousEnd = shot.end
      }
      assert.ok(Math.abs(previousEnd - 12) <= 0.6, `last shot ends at ${previousEnd}`)
    })

    await check('scene 1 is clearly darker than scene 2', async () => {
      const [first, second] = scenes.shots
      assert.ok(first.brightness < second.brightness - 0.05, `brightness ${first.brightness} vs ${second.brightness}`)
    })

    await check('scene 1 is less saturated than scene 2', async () => {
      const [first, second] = scenes.shots
      assert.ok(first.saturation < second.saturation, `saturation ${first.saturation} vs ${second.saturation}`)
    })

    await check('scene 1 reads as red and scene 2 reads as blue', async () => {
      assert.equal(scenes.shots[0].hueName, 'red')
      assert.equal(scenes.shots[1].hueName, 'blue')
    })

    await check('the motion scene is measurably more active than the static scenes', async () => {
      const [first, , third] = scenes.shots
      assert.ok(third.motion > first.motion + 0.3, `motion ${third.motion} vs ${first.motion}`)
      assert.ok(scenes.global.peakMotion >= scenes.global.avgMotion, 'peakMotion < avgMotion')
    })

    await check('every shot has a saved keyframe JPEG larger than 1 KB', async () => {
      for (const shot of scenes.shots) {
        assert.ok(typeof shot.keyframe === 'string' && shot.keyframe.length > 0, `shot ${shot.index} has no keyframe path`)
        const info = await stat(shot.keyframe)
        assert.ok(info.size > 1024, `shot ${shot.index} keyframe is only ${info.size} bytes`)
      }
      const files = await readdir(scenes.artifacts.keyframesDir)
      assert.ok(files.filter((name) => name.endsWith('.jpg')).length >= scenes.shots.length, 'not every shot has a JPEG on disk')
    })

    await check('every shot has non-empty ascii + hueMap + palette + layout', async () => {
      for (const shot of scenes.shots) assertShotVisuals(shot)
    })

    await check('contact sheet is a content-sized PNG with equal fixed-width cells', async () => {
      assert.equal(typeof scenes.artifacts.contactSheet, 'string')
      const sheets = scenes.artifacts.contactSheet.split(', ').filter(Boolean)
      assert.equal(sheets.length, 1, '3 keyframes should fit on one sheet')
      for (const sheet of sheets) {
        const info = await stat(sheet)
        assert.ok(info.size > 5 * 1024, `${sheet} is only ${info.size} bytes`)
        const size = await pngSize(sheet)
        // 3 cells in a 3x1 grid: no empty rows below the keyframes.
        assert.ok(size.height <= SHEET_CELL_HEIGHT + 16, `sheet has empty rows (${size.width}x${size.height})`)
        assert.ok(size.width >= 3 * SHEET_CELL_WIDTH, `sheet cells are too narrow (${size.width}px wide)`)
      }
    })

    await check('the soundtrack is present via the injected audio engine', async () => {
      assert.ok(scenes.audio !== null && typeof scenes.audio === 'object', 'audio is null')
      assert.equal(scenes.audio.kind, 'audio')
      assert.equal(scenes.transcript, null, 'the video engine must not surface a transcript (Lead owns ASR)')
      assert.equal(audioCalls.length, 1, `analyzeAudio was called ${audioCalls.length} times`)
      const call = audioCalls[0]
      assert.equal(call.file, SCENES)
      assert.ok(call.workDir.startsWith(workDir) && call.workDir !== workDir, 'audio engine must get its own sub-directory')
      assert.equal(call.options.wantArtifacts, true)
      assert.equal(call.options.asr, false, 'the video engine must not request ASR')
    })

    await check('timeline is downsampled to <= 300 points with sane values', async () => {
      assertTimeline(scenes.timeline)
      assert.ok(scenes.timeline.length >= 10 && scenes.timeline.length <= 13, `timeline has ${scenes.timeline.length} points`)
    })

    await check('stream and format facts match the fixture', async () => {
      assert.equal(scenes.stream.codec, 'h264')
      assert.equal(scenes.stream.width, 640)
      assert.equal(scenes.stream.height, 360)
      assert.equal(scenes.stream.fps, 25)
      assert.equal(scenes.stream.pixelFormat, 'yuv420p')
      assert.equal(scenes.global.aspectRatio, '16:9')
      const fileInfo = await stat(SCENES)
      assert.equal(scenes.format.sizeBytes, fileInfo.size)
      assert.ok(scenes.format.bitRate > 0)
    })

    await check('global perception metrics are in range', async () => {
      assert.equal(scenes.global.shotCount, scenes.shots.length)
      assertRange(scenes.global.avgBrightness, 0, 1, 'avgBrightness')
      assertRange(scenes.global.avgSaturation, 0, 1, 'avgSaturation')
      assertRange(scenes.global.brightnessVariety, 0, 1, 'brightnessVariety')
      assertRange(scenes.global.colorfulness, 0, 100, 'colorfulness')
      assertRange(scenes.global.avgMotion, 0, 100, 'avgMotion')
      assertRange(scenes.global.peakMotion, 0, 100, 'peakMotion')
      assert.ok(scenes.global.cutRate >= 0, 'cutRate is negative')
      assert.ok(scenes.global.dominantHues.length >= 1 && scenes.global.dominantHues.length <= 3)
      for (const hue of scenes.global.dominantHues) {
        assert.equal(typeof hue.name, 'string')
        assertRange(hue.share, 0, 1, `dominant hue ${hue.name} share`)
        assert.match(hue.hex, HEX_PATTERN)
      }
    })

    await check('health flags are well formed and not false-positive on the sine soundtrack', async () => {
      for (const key of ['frozen', 'black', 'silent']) {
        assert.ok(Array.isArray(scenes.flags[key]), `flags.${key} is not an array`)
        for (const interval of scenes.flags[key]) {
          assert.ok(interval.start >= 0 && interval.end > interval.start, `flags.${key} interval is invalid`)
          assert.ok(interval.end <= scenes.duration + 0.01, `flags.${key} interval ends after the video`)
        }
      }
      assert.equal(typeof scenes.flags.likelyTextHeavy, 'boolean')
      assert.equal(typeof scenes.flags.likelyTalkingHead, 'boolean')
      // The fixture has two 4 s static caption slides, so freeze detection must fire...
      assert.ok(scenes.flags.frozen.length >= 1, 'the static slides were not flagged as frozen')
      // ...and the warning must explain that a static span is normal, not a defect.
      assert.ok(
        scenes.warnings.some((warning) => /static\/flat-frame span/iu.test(warning)),
        JSON.stringify(scenes.warnings),
      )
      assert.equal(scenes.flags.black.length, 0, 'the fixture has no black frames')
      assert.equal(scenes.flags.silent.length, 0, 'the sine soundtrack never goes silent')
      // 2 of 3 shots are static caption slides: edge-dense + still.
      assert.equal(scenes.flags.likelyTextHeavy, true, 'caption slides should read as text heavy')
      // The audio stub reports the real engine's pure-tone vocal false positive;
      // the speech gate must still reject it.
      assert.equal(scenes.flags.likelyTalkingHead, false, 'a pure sine must not be flagged as a talking head')
    })

    await check('report is strictly JSON-serialisable with finite numbers', async () => {
      assertJsonSafe(scenes)
    })

    /* ---------------- degenerate: 1 s single colour ---------------- */
    await check('1 s single-colour clip returns a warning-laden report instead of throwing', async () => {
      const tiny = await analyzeVideo({
        tools,
        file: TINY,
        workDir,
        options: { artifactDir: join(ARTIFACTS, 'tiny') },
        analyzeAudio: stubAnalyzeAudio,
      })
      assertJsonSafe(tiny)
      assert.ok(Math.abs(tiny.duration - 1) <= 0.2, `duration=${tiny.duration}`)
      assert.ok(tiny.shots.length >= 1)
      assert.ok(tiny.warnings.length >= 1, 'a 1 s clip should report at least one warning')
      assert.ok(tiny.warnings.some((warning) => /no scene changes|density floor|short/iu.test(warning)), JSON.stringify(tiny.warnings))
      assert.ok(tiny.timeline.length <= 300)
      assertShotVisuals(tiny.shots[0])
      assert.ok(tiny.audio !== null, 'the 1 s clip has audio and a stub engine, so audio should not be null')
      assert.equal(tiny.transcript, null)
    })

    /* ---------------- degenerate: no audio stream ---------------- */
    await check('video without an audio stream reports audio: null and a warning', async () => {
      const muted = await analyzeVideo({
        tools,
        file: MUTED,
        workDir,
        options: { artifactDir: join(ARTIFACTS, 'no-audio') },
        analyzeAudio: stubAnalyzeAudio,
      })
      assertJsonSafe(muted)
      assert.equal(muted.audio, null)
      assert.ok(muted.warnings.some((warning) => /no audio stream/iu.test(warning)), JSON.stringify(muted.warnings))
      assert.ok(muted.shots.length >= 1)
      assert.ok(muted.shots.every((shot) => Number.isFinite(shot.brightness)))
      assertTimeline(muted.timeline)
    })

    /* ---------------- degenerate: corrupt but probeable ---------------- */
    await check('corrupt-but-probeable file degrades to warnings without throwing', async () => {
      const broken = await analyzeVideo({
        tools,
        file: TRUNCATED,
        workDir,
        options: { artifactDir: join(ARTIFACTS, 'truncated') },
        analyzeAudio: stubAnalyzeAudio,
      })
      assertJsonSafe(broken)
      assert.ok(Math.abs(broken.duration - 12) <= 0.5, `container duration=${broken.duration}`)
      assert.ok(broken.shots.length >= 1, 'no shots were produced')
      assert.ok(broken.warnings.some((warning) => /ended early|truncat|corrupt/iu.test(warning)), JSON.stringify(broken.warnings))
      assert.ok(broken.shots[0].start >= 0)
    })

    /* ---------------- zero cuts: density floor + multi-sheet + silent/frozen ---------------- */
    await check('static 30 s clip: density-floor shots, frozen+silent flags and a multi-sheet contact sheet', async () => {
      const still = await analyzeVideo({
        tools,
        file: STATIC,
        workDir,
        options: {
          artifactDir: join(ARTIFACTS, 'static'),
          densityFloorSeconds: 2,
          maxKeyframes: 15,
          wantArtifacts: true,
        },
        analyzeAudio: stubAnalyzeAudio,
      })
      assertJsonSafe(still)
      assert.ok(Math.abs(still.duration - 30) <= 0.5, `duration=${still.duration}`)
      // A cut every 2 s on a 30 s static clip -> ~15 shots from the density floor.
      assert.ok(still.shots.length >= 10 && still.shots.length <= 18, `density floor gave ${still.shots.length} shots`)
      assert.ok(still.warnings.some((warning) => /no scene changes/iu.test(warning)), JSON.stringify(still.warnings))
      for (const shot of still.shots) assertShotVisuals(shot)
      assert.equal(still.global.avgMotion, 0, 'a flat static clip must have zero motion')
      assert.equal(still.flags.likelyTextHeavy, false, 'a flat single-colour clip is not text heavy')
      assert.equal(still.flags.likelyTalkingHead, false)
      // Freeze detector: the whole clip is static.
      assert.ok(still.flags.frozen.length >= 1, 'static clip was not flagged as frozen')
      assert.ok(still.warnings.some((warning) => /static\/flat-frame span/iu.test(warning)), JSON.stringify(still.warnings))
      // Silence detector: the soundtrack is digital silence for the whole clip.
      assert.ok(still.flags.silent.length >= 1, 'silent soundtrack was not detected')
      const silentSpan = still.flags.silent[0]
      assert.ok(silentSpan.start <= 1 && silentSpan.end >= 25, `silent span ${JSON.stringify(still.flags.silent)}`)
      // 15 keyframes -> 2 sheets (12 + 3).
      const sheets = still.artifacts.contactSheet.split(', ').filter(Boolean)
      assert.equal(sheets.length, 2, `expected 2 contact sheets for 15 keyframes, got ${sheets.length}`)
      for (const sheet of sheets) assert.ok((await stat(sheet)).size > 5 * 1024, `${sheet} is too small`)
      const firstSheet = await pngSize(sheets[0])
      const secondSheet = await pngSize(sheets[1])
      assert.ok(firstSheet.height <= 3 * SHEET_CELL_HEIGHT + 16, `first sheet has empty rows (${firstSheet.height}px)`)
      assert.ok(secondSheet.height <= SHEET_CELL_HEIGHT + 16, `second sheet has empty rows (${secondSheet.height}px)`)
      assertTimeline(still.timeline)
    })

    /* ---------------- options: maxKeyframes cap ---------------- */
    await check('maxKeyframes caps extracted keyframes while all shots stay in the report', async () => {
      const capped = await analyzeVideo({
        tools,
        file: SCENES,
        workDir,
        options: { artifactDir: join(ARTIFACTS, 'capped'), maxKeyframes: 2 },
        analyzeAudio: stubAnalyzeAudio,
      })
      assertJsonSafe(capped)
      assert.equal(capped.shots.length, scenes.shots.length, 'the shot list must not shrink with maxKeyframes')
      const withKeyframe = capped.shots.filter((shot) => typeof shot.keyframe === 'string')
      assert.equal(withKeyframe.length, 2, `expected 2 keyframes with maxKeyframes=2, got ${withKeyframe.length}`)
      assert.ok(capped.shots.some((shot) => typeof shot.ascii !== 'string'), 'capped-away shots should not carry ascii')
      const files = await readdir(capped.artifacts.keyframesDir)
      assert.ok(files.filter((name) => name.endsWith('.jpg')).length <= 2, 'more JPEGs were written than maxKeyframes allows')
      const sheets = capped.artifacts.contactSheet.split(', ').filter(Boolean)
      assert.equal(sheets.length, 1, '2 keyframes fit on a single sheet')
    })

    /* ---------------- options: start + maxSeconds ---------------- */
    await check('start/maxSeconds select the requested window', async () => {
      const windowed = await analyzeVideo({
        tools,
        file: SCENES,
        workDir,
        options: { start: 4, maxSeconds: 4, artifactDir: join(ARTIFACTS, 'window') },
        analyzeAudio: stubAnalyzeAudio,
      })
      assertJsonSafe(windowed)
      assert.ok(windowed.shots.length >= 1)
      for (const shot of windowed.shots) {
        assert.ok(shot.start >= 3.9, `windowed shot starts at ${shot.start}, expected >= 4`)
        assert.ok(shot.end <= 8.6, `windowed shot ends at ${shot.end}, expected <= 8`)
      }
      assert.ok(windowed.timeline.length <= 5, `windowed timeline has ${windowed.timeline.length} points`)
      assert.ok(Math.abs(windowed.duration - 12) <= 0.5, 'container duration should still be the full file duration')
    })

    /* ---------------- abort ---------------- */
    await check('an aborted signal rejects instead of returning a partial report', async () => {
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        () => analyzeVideo({ tools, file: SCENES, workDir, signal: controller.signal, analyzeAudio: stubAnalyzeAudio }),
        (error) => error instanceof Error && error.name === 'AbortError',
      )
    })
  } finally {
    await removeWorkDir(workDir)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    process.exitCode = 1
    console.log('FAIL')
  } else {
    console.log('PASS')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
