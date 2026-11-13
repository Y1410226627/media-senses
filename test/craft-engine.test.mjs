#!/usr/bin/env node
/**
 * Acceptance tests for the media-senses production-craft analyzer (lib/craft.js).
 *
 * Run: node test/craft-engine.test.mjs
 *
 * Prints PASS/FAIL per assertion and exits non-zero when anything fails.
 *
 * What is covered:
 *  1. End-to-end on the real fixtures: `analyzeVideo` (v1, real audio engine) then
 *     `analyzeCraft` on test/fixtures/scenes.mp4 (3 shots, cuts at 4 s / 8 s) and
 *     demo/media/trailer.mp4 (2 shots, cut at 5.76 s): shot counts, transition
 *     times within 0.3 s of the real boundaries, camera motion, grading,
 *     overlays, hook, sections, title card, recipe skeleton, JSON round-trip.
 *  2. Beat sync: a temp video that reuses the 120 BPM ground-truth tone fixture as
 *     its soundtrack. Cuts at 4 s / 8 s land exactly on the beat grid, so the
 *     measured `cutsOnBeatRatio` must be high and the BPM ≈ 120.
 *  3. A 1-second flat clip (test/fixtures/tiny-solid.mp4): must not throw, must
 *     carry warnings, must report degenerate-but-honest craft values.
 *  4. Transition classifier: temp cross-fade and dip-to-black clips with an
 *     analysis whose shot boundaries are pinned at the real transition midpoints.
 *     `fade` / `dip-to-black` must be distinguished from `cut`.
 *  5. Options: `lowResFrames: false` skips the RGB pass and degrades to nulls.
 *
 * Scratch files go to a private temp directory; nothing under the plugin tree is
 * written except (when missing) the shared fixtures built by the sibling tests.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWorkDir, removeWorkDir, resolveTools, run } from '../lib/ffmpeg.js'
import { analyzeVideo } from '../lib/video.js'
import { analyzeAudio } from '../lib/audio.js'
import { analyzeCraft, RECIPE_SCHEMA } from '../lib/craft.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const SCENES = join(FIXTURES, 'scenes.mp4')
const TINY = join(FIXTURES, 'tiny-solid.mp4')
const TONE = join(FIXTURES, 'tone-120bpm-c-major.wav')
const TRAILER = join(HERE, '..', 'demo', 'media', 'trailer.mp4')

const MOTION_KINDS = new Set(['static', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'zoom-in', 'zoom-out', 'handheld'])
const TRANSITION_KINDS = new Set(['cut', 'fade', 'dip-to-black', 'other'])
const TEMPERATURES = new Set(['warm', 'neutral', 'cool'])
const SHADOW_TINTS = new Set(['blue', 'teal', 'warm', 'neutral'])
const HIGHLIGHT_TINTS = new Set(['warm', 'neutral', 'cool'])
const SIGNATURE_TAGS = new Set(['high-contrast', 'low-contrast', 'desaturated', 'teal-orange', 'warm', 'cool', 'neutral'])
const SECTION_ROLES = new Set(['intro', 'body', 'outro'])
const SPEECH_KINDS = new Set(['narration', 'dialogue', 'none'])
/** Values accepted by RenderPlan.scenes[].transitionIn in CONTRACT-V2 module A. */
const BUILD_TRANSITIONS = new Set(['cut', 'fade', 'slideleft', 'wipeleft', 'circleopen', 'dissolve'])
const HEX_PATTERN = /^#[0-9a-f]{6}$/u
const CJK_PATTERN = /[\u4e00-\u9fa5]/u

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

/* ------------------------------------------------------------------ *
 * Shared assertion helpers
 * ------------------------------------------------------------------ */

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
  assert.deepEqual(roundTripped, result, 'result does not survive a JSON round-trip unchanged')
}

function assertRange(value, min, max, name) {
  assert.equal(typeof value, 'number', `${name} is not a number`)
  assert.ok(Number.isFinite(value), `${name} is not finite`)
  assert.ok(value >= min && value <= max, `${name}=${value} is outside [${min}, ${max}]`)
}

function assertNullableRange(value, min, max, name) {
  if (value === null) return
  assertRange(value, min, max, name)
}

/** Every transition sits on a reported shot boundary; the expected times are found. */
function assertBoundariesDetected(craft, analysis, expected, tolerance = 0.3) {
  const boundaryTimes = analysis.shots.slice(1).map((shot) => shot.start)
  assert.equal(craft.transitions.list.length, boundaryTimes.length, 'one transition per interior boundary')
  for (const entry of craft.transitions.list) {
    assert.ok(TRANSITION_KINDS.has(entry.kind), `unknown transition kind ${entry.kind}`)
    assertRange(entry.confidence, 0, 1, 'transition confidence')
    const nearest = Math.min(...boundaryTimes.map((time) => Math.abs(time - entry.at)))
    assert.ok(nearest <= 0.05, `transition at ${entry.at} is not a reported shot boundary`)
  }
  for (const expectedAt of expected) {
    assert.ok(
      craft.transitions.list.some((entry) => Math.abs(entry.at - expectedAt) <= tolerance),
      `no transition within ${tolerance} s of ${expectedAt}: got ${JSON.stringify(craft.transitions.list.map((entry) => entry.at))}`,
    )
  }
}

/** Structural validation of the `craft` object (contract module C shape). */
function assertCraftShape(craft, analysis) {
  const shotCount = analysis.shots.length
  assert.equal(typeof craft, 'object')
  for (const key of ['cutRhythm', 'transitions', 'camera', 'grading', 'overlays', 'hook', 'beatSync', 'sections', 'titleCard', 'warnings']) {
    assert.ok(key in craft, `craft.${key} is missing`)
  }

  const rhythm = craft.cutRhythm
  assert.equal(typeof rhythm.shotCount, 'number')
  assert.equal(rhythm.shotCount, shotCount, 'cutRhythm.shotCount must equal analysis.shots.length')
  assert.ok(Number.isInteger(rhythm.shotCount))
  for (const key of ['avgShotLength', 'medianShotLength', 'shortestShot', 'longestShot', 'stdDev', 'cutRatePerMin']) {
    assert.ok(key in rhythm, `craft.cutRhythm.${key} is missing`)
    if (rhythm[key] !== null) assert.ok(Number.isFinite(rhythm[key]), `craft.cutRhythm.${key} is not finite`)
  }
  if (shotCount > 0) {
    assert.ok(rhythm.avgShotLength > 0)
    assert.ok(rhythm.shortestShot <= rhythm.avgShotLength + 1e-9)
    assert.ok(rhythm.longestShot >= rhythm.avgShotLength - 1e-9)
  }
  assert.ok(Array.isArray(rhythm.cutsPer10s))
  for (const value of rhythm.cutsPer10s) assert.ok(Number.isInteger(value) && value >= 0, 'cutsPer10s entries are counts')

  assertNullableRange(craft.transitions.hardCutShare, 0, 1, 'transitions.hardCutShare')
  assertNullableRange(craft.transitions.gradualShare, 0, 1, 'transitions.gradualShare')
  assert.ok(Array.isArray(craft.transitions.list))

  assert.ok(Array.isArray(craft.camera))
  assert.equal(craft.camera.length, shotCount, 'camera must have one entry per shot')
  craft.camera.forEach((entry, index) => {
    assert.equal(entry.shotIndex, index)
    if (entry.motion !== null) assert.ok(MOTION_KINDS.has(entry.motion), `camera[${index}].motion=${entry.motion}`)
    assertNullableRange(entry.intensity, 0, 1, `camera[${index}].intensity`)
  })

  for (const key of ['contrast', 'saturation', 'temperature', 'shadowTint', 'highlightTint', 'signature']) {
    assert.ok(key in craft.grading, `craft.grading.${key} is missing`)
  }
  assertNullableRange(craft.grading.contrast, 0, 1, 'grading.contrast')
  assertNullableRange(craft.grading.saturation, 0, 1, 'grading.saturation')
  if (craft.grading.temperature !== null) assert.ok(TEMPERATURES.has(craft.grading.temperature))
  if (craft.grading.shadowTint !== null) assert.ok(SHADOW_TINTS.has(craft.grading.shadowTint))
  if (craft.grading.highlightTint !== null) assert.ok(HIGHLIGHT_TINTS.has(craft.grading.highlightTint))
  if (craft.grading.signature !== null) {
    assert.ok(Array.isArray(craft.grading.signature) && craft.grading.signature.length > 0, 'grading.signature must be non-empty or null')
    for (const tag of craft.grading.signature) assert.ok(SIGNATURE_TAGS.has(tag), `unknown grading tag ${tag}`)
  }

  for (const key of ['textDensity', 'likelySubtitles', 'likelyTitleCard', 'topBandDetail', 'bottomBandDetail']) {
    assert.ok(key in craft.overlays, `craft.overlays.${key} is missing`)
  }
  assertNullableRange(craft.overlays.textDensity, 0, 1, 'overlays.textDensity')
  assertNullableRange(craft.overlays.topBandDetail, 0, 1, 'overlays.topBandDetail')
  assertNullableRange(craft.overlays.bottomBandDetail, 0, 1, 'overlays.bottomBandDetail')
  for (const key of ['likelySubtitles', 'likelyTitleCard']) {
    assert.ok(craft.overlays[key] === null || typeof craft.overlays[key] === 'boolean')
  }

  const hook = craft.hook
  for (const key of ['hasEarlyCut', 'hasTitleInFirst3s', 'firstShotMotion', 'hookStrength']) assert.ok(key in hook, `craft.hook.${key} is missing`)
  for (const key of ['hasEarlyCut', 'hasTitleInFirst3s']) assert.ok(hook[key] === null || typeof hook[key] === 'boolean')
  if (hook.firstShotMotion !== null) assert.ok(MOTION_KINDS.has(hook.firstShotMotion))
  assertNullableRange(hook.hookStrength, 0, 1, 'hook.hookStrength')

  const beatSync = craft.beatSync
  for (const key of ['bpm', 'cutsOnBeatRatio', 'meanOffsetMs', 'note']) assert.ok(key in beatSync, `craft.beatSync.${key} is missing`)
  if (beatSync.bpm !== null) assertRange(beatSync.bpm, 20, 400, 'beatSync.bpm')
  assertNullableRange(beatSync.cutsOnBeatRatio, 0, 1, 'beatSync.cutsOnBeatRatio')
  if (beatSync.meanOffsetMs !== null) assert.ok(Number.isFinite(beatSync.meanOffsetMs))
  assert.ok(typeof beatSync.note === 'string' && beatSync.note.length > 0, 'beatSync.note must be a non-empty string')

  assert.ok(Array.isArray(craft.sections))
  if (shotCount > 0) {
    assert.ok(craft.sections.length >= 1, 'at least one section')
    let previousEnd = -1
    for (const section of craft.sections) {
      assert.ok(SECTION_ROLES.has(section.role), `unknown section role ${section.role}`)
      assert.ok(Number.isFinite(section.start) && Number.isFinite(section.end), 'section bounds must be finite')
      assert.ok(section.end > section.start, 'section end must exceed start')
      assert.ok(section.start >= previousEnd - 1e-6, 'sections must not overlap')
      assert.ok(Number.isFinite(section.avgShotLength) && section.avgShotLength > 0)
      previousEnd = section.end
    }
    assert.ok(Math.abs(craft.sections[0].start - analysis.shots[0].start) < 0.05)
    assert.ok(Math.abs(craft.sections[craft.sections.length - 1].end - analysis.shots[shotCount - 1].end) < 0.05)
    assert.equal(craft.sections[0].role, 'intro')
    if (shotCount >= 2) assert.equal(craft.sections[craft.sections.length - 1].role, 'outro')
  }

  const titleCard = craft.titleCard
  for (const key of ['present', 'at', 'duration', 'style']) assert.ok(key in titleCard, `craft.titleCard.${key} is missing`)
  assert.ok(titleCard.present === null || typeof titleCard.present === 'boolean')
  if (titleCard.present === true) {
    assert.ok(Number.isFinite(titleCard.at), 'titleCard.at must be finite when present')
    assert.ok(Number.isFinite(titleCard.duration) && titleCard.duration > 0)
    assert.ok(titleCard.style === null || typeof titleCard.style === 'string')
  }

  assert.ok(Array.isArray(craft.warnings))
  for (const warning of craft.warnings) assert.equal(typeof warning, 'string')
}

/** Structural validation of the machine-usable recipe (contract module C shape). */
function assertRecipeShape(recipe, analysis, craft) {
  assert.equal(recipe.schema, RECIPE_SCHEMA)
  assert.equal(recipe.schema, 'media-senses.recipe/v1')
  if (analysis.duration > 0) {
    assert.ok(Math.abs(recipe.duration - analysis.duration) <= 0.05, `recipe.duration=${recipe.duration} vs analysis ${analysis.duration}`)
  }
  assert.equal(typeof recipe.aspect, 'string')
  assert.ok(Number.isInteger(recipe.resolution.width) && recipe.resolution.width > 0)
  assert.ok(Number.isInteger(recipe.resolution.height) && recipe.resolution.height > 0)
  assert.ok(Number.isFinite(recipe.fps) && recipe.fps > 0)

  assert.ok(Array.isArray(recipe.shots))
  assert.equal(recipe.shots.length, analysis.shots.length, 'recipe.shots must match the shot count')
  recipe.shots.forEach((shot, index) => {
    assert.equal(shot.index, index + 1, 'recipe shot indices are 1-based (CONTRACT-V2 example)')
    const source = analysis.shots[index]
    assert.ok(Math.abs(shot.start - source.start) <= 0.02, `shot ${index} start drifted`)
    assert.ok(Math.abs(shot.end - source.end) <= 0.02, `shot ${index} end drifted`)
    assert.ok(Math.abs(shot.duration - source.duration) <= 0.02, `shot ${index} duration drifted`)
    assert.ok(shot.camera === null || MOTION_KINDS.has(shot.camera), `shot ${index} camera=${shot.camera}`)
    assert.equal(shot.camera, craft.camera[index].motion, `shot ${index} camera disagrees with craft.camera`)
    assert.ok(Number.isFinite(shot.brightness) && shot.brightness >= 0 && shot.brightness <= 1)
    assert.ok(Array.isArray(shot.palette))
    for (const hex of shot.palette) assert.match(hex, HEX_PATTERN)
    assert.ok(BUILD_TRANSITIONS.has(shot.transitionIn), `shot ${index} transitionIn=${shot.transitionIn}`)
  })
  assert.equal(recipe.shots[0].transitionIn, 'cut')

  assert.equal(typeof recipe.look, 'object')
  assert.ok(Array.isArray(recipe.look.palette))
  for (const hex of recipe.look.palette) assert.match(hex, HEX_PATTERN)
  assert.deepEqual(recipe.look.grading, craft.grading.signature)
  assert.equal(recipe.look.temperature, craft.grading.temperature)
  assert.equal(recipe.look.textDensity, craft.overlays.textDensity)
  assert.equal(recipe.look.titleCard, craft.titleCard.present === true ? craft.titleCard.style : null)

  assert.equal(typeof recipe.sound, 'object')
  assert.ok(typeof recipe.sound.hasMusic === 'boolean')
  assert.ok(recipe.sound.bpm === null || Number.isFinite(recipe.sound.bpm))
  assert.equal(recipe.sound.bpm, craft.beatSync.bpm)
  assert.ok(recipe.sound.key === null || typeof recipe.sound.key === 'string')
  assert.ok(typeof recipe.sound.hasSpeech === 'boolean')
  assert.ok(SPEECH_KINDS.has(recipe.sound.speechKind), `speechKind=${recipe.sound.speechKind}`)
  assert.ok(recipe.sound.musicDb === null || Number.isFinite(recipe.sound.musicDb))

  assert.equal(typeof recipe.pacing, 'object')
  assert.equal(recipe.pacing.avgShotLength, craft.cutRhythm.avgShotLength)
  assert.equal(recipe.pacing.cutRatePerMin, craft.cutRhythm.cutRatePerMin)
  assert.equal(recipe.pacing.beatSync, craft.beatSync.cutsOnBeatRatio)

  assert.ok(Array.isArray(recipe.reproductionNotes), 'reproductionNotes must be an array')
  assert.ok(recipe.reproductionNotes.length >= 3 && recipe.reproductionNotes.length <= 6, `notes=${recipe.reproductionNotes.length}`)
  for (const note of recipe.reproductionNotes) {
    assert.equal(typeof note, 'string')
    assert.ok(note.trim().length > 4, 'note is too short to be actionable')
    assert.match(note, CJK_PATTERN, `note is not Chinese: ${note}`)
    assert.ok(note.endsWith('。'), `note does not end as a sentence: ${note}`)
  }
}

/* ------------------------------------------------------------------ *
 * Fixture / scratch helpers
 * ------------------------------------------------------------------ */

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function ensureFixtures() {
  if (!(await exists(SCENES)) || !(await exists(TINY))) {
    console.log('video fixtures missing; building them with test/make-video-fixture.mjs ...')
    execFileSync(process.execPath, [join(HERE, 'make-video-fixture.mjs')], { stdio: 'inherit' })
  }
  if (!(await exists(TONE))) {
    console.log('audio fixture missing; building it with test/make-audio-fixture.mjs ...')
    execFileSync(process.execPath, [join(HERE, 'make-audio-fixture.mjs')], { stdio: 'inherit' })
  }
}

/** Probe-then-analyse one video with the real v1 engine and real audio engine. */
async function analyseVideoFile(tools, file, workDir, artifactDir) {
  return analyzeVideo({
    tools,
    file,
    workDir,
    options: { artifactDir, wantContactSheet: false, wantFrames: false },
    analyzeAudio,
  })
}

/** Absolute-time analysis window re-split at a known transition midpoint. */
function splitAnalysisAt(analysis, boundary) {
  const duration = analysis.duration
  const second = Math.round((duration - boundary) * 100) / 100
  return {
    ...analysis,
    shots: [
      { index: 0, start: 0, end: boundary, duration: boundary },
      { index: 1, start: boundary, end: duration, duration: second },
    ],
  }
}

/** Build a video by muxing the scenes video with the 120 BPM ground-truth audio. */
async function buildBeatSyncFixture(tools, scratchDir) {
  const output = join(scratchDir, 'beatsync.mp4')
  const result = await run(
    tools.ffmpeg,
    ['-v', 'error', '-y', '-i', SCENES, '-i', TONE, '-map', '0:v', '-map', '1:a', '-t', '12', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', output],
    { timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `could not build the beat-sync fixture: ${result.stderr.slice(0, 300)}`)
  return output
}

/** Build a two-colour cross-fade clip (transition midpoint ≈ 3.0 s). */
async function buildCrossfadeFixture(tools, scratchDir) {
  const output = join(scratchDir, 'crossfade.mp4')
  const result = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x8a1010:s=640x360:r=25:d=3',
      '-f', 'lavfi', '-i', 'color=c=0x1040c0:s=640x360:r=25:d=3',
      '-filter_complex', '[0:v][1:v]xfade=transition=fade:duration=0.6:offset=2.7,format=yuv420p[v]',
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', output,
    ],
    { timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `could not build the cross-fade fixture: ${result.stderr.slice(0, 300)}`)
  return output
}

/** Build a clip that fades to black then in again (dip midpoint = 2.5 s). */
async function buildDipToBlackFixture(tools, scratchDir) {
  const output = join(scratchDir, 'dip-to-black.mp4')
  const result = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x8a1010:s=640x360:r=25:d=2.5',
      '-f', 'lavfi', '-i', 'color=c=0x1040c0:s=640x360:r=25:d=2.5',
      '-filter_complex',
      '[0:v]fade=t=out:st=2:d=0.5,format=yuv420p[a];[1:v]fade=t=in:st=0:d=0.5,format=yuv420p[b];[a][b]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', output,
    ],
    { timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `could not build the dip-to-black fixture: ${result.stderr.slice(0, 300)}`)
  return output
}

function printCraftSummary(label, craft, recipe) {
  const transitions = craft.transitions.list.map((entry) => `${entry.at}s ${entry.kind}`).join(', ')
  const camera = craft.camera.map((entry) => entry.motion ?? 'n/a').join(', ')
  const notes = recipe.reproductionNotes.map((note) => `        · ${note}`).join('\n')
  console.log(`      ${label}: shots=${craft.cutRhythm.shotCount} avg=${craft.cutRhythm.avgShotLength}s ` +
    `cutRate=${craft.cutRhythm.cutRatePerMin}/min`)
  console.log(`        transitions: ${transitions || '(none)'}`)
  console.log(`        camera: ${camera}`)
  console.log(`        grading: ${JSON.stringify(craft.grading)}`)
  console.log(`        beatSync: ${JSON.stringify(craft.beatSync)}`)
  console.log(`        notes:\n${notes}`)
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  await ensureFixtures()
  const tools = await resolveTools()
  console.log(`ffmpeg: ${tools.version}`)
  const scratchRoot = await mkdtemp(join(tmpdir(), 'ms-craft-test-'))
  const workDir = await makeWorkDir('ms-craft-work')
  console.log(`scratch: ${scratchRoot}`)

  try {
    /* ---------------- scenes.mp4: 3 shots, hard cuts at 4 s / 8 s ---------------- */
    let scenesAnalysis = null
    let scenesCraft = null
    let scenesRecipe = null
    await check('analyzeVideo + analyzeCraft run end-to-end on test/fixtures/scenes.mp4', async () => {
      const caseDir = join(workDir, 'scenes')
      await mkdir(caseDir, { recursive: true })
      scenesAnalysis = await analyseVideoFile(tools, SCENES, caseDir, join(scratchRoot, 'scenes', 'video'))
      const result = await analyzeCraft({
        tools,
        file: SCENES,
        workDir: join(caseDir, 'craft'),
        analysis: scenesAnalysis,
        artifactDir: join(scratchRoot, 'scenes', 'craft'),
      })
      scenesCraft = result.craft
      scenesRecipe = result.recipe
      assert.equal(scenesAnalysis.shots.length, 3, `fixture should have 3 shots, got ${scenesAnalysis.shots.length}`)
      assert.equal(scenesCraft.cutRhythm.shotCount, scenesAnalysis.shots.length)
      printCraftSummary('scenes.mp4', scenesCraft, scenesRecipe)
    })

    await check('scenes.mp4: craft matches the contract shape', async () => {
      assertCraftShape(scenesCraft, scenesAnalysis)
    })

    await check('scenes.mp4: hard cuts are detected at the real 4 s / 8 s boundaries', async () => {
      assertBoundariesDetected(scenesCraft, scenesAnalysis, [4, 8])
      assert.equal(scenesCraft.transitions.hardCutShare, 1)
      assert.equal(scenesCraft.transitions.gradualShare, 0)
      for (const entry of scenesCraft.transitions.list) assert.equal(entry.kind, 'cut')
    })

    await check('scenes.mp4: flat title scenes are static, the motion scene is not', async () => {
      assert.equal(scenesCraft.camera[0].motion, 'static')
      assert.equal(scenesCraft.camera[1].motion, 'static')
      assert.ok(scenesCraft.camera[2].motion !== 'static', 'testsrc2 should not read as a static camera')
      for (const entry of scenesCraft.camera) assertRange(entry.intensity, 0, 1, 'camera intensity')
    })

    await check('scenes.mp4: grading, overlays, hook and title card are measured', async () => {
      const grading = scenesCraft.grading
      assert.ok(grading.contrast > 0.2, `contrast=${grading.contrast}`)
      assert.equal(grading.signature.includes('high-contrast'), true)
      assert.ok(grading.saturation > 0.5, `saturation=${grading.saturation}`)
      assert.equal(scenesCraft.overlays.textDensity > 0.5, true)
      assert.equal(scenesCraft.overlays.likelyTitleCard, true)
      assert.equal(scenesCraft.titleCard.present, true)
      assert.equal(scenesCraft.titleCard.at, 0)
      assert.ok(scenesCraft.titleCard.style === null || scenesCraft.titleCard.style.startsWith('centered-'))
      assert.equal(scenesCraft.hook.hasTitleInFirst3s, true)
      assert.ok(scenesCraft.hook.hookStrength >= 0.4)
    })

    await check('scenes.mp4: sections cover intro / body / outro', async () => {
      assert.deepEqual(scenesCraft.sections.map((section) => section.role), ['intro', 'body', 'outro'])
      assert.equal(scenesCraft.sections[0].avgShotLength, 4)
      assert.ok(Math.abs(scenesCraft.sections[2].end - scenesAnalysis.duration) < 0.05)
    })

    await check('scenes.mp4: recipe is a usable media-senses.recipe/v1 skeleton', async () => {
      assertRecipeShape(scenesRecipe, scenesAnalysis, scenesCraft)
      assert.equal(scenesRecipe.resolution.width, 640)
      assert.equal(scenesRecipe.resolution.height, 360)
      assert.equal(scenesRecipe.fps, 25)
      assert.equal(scenesRecipe.aspect, '16:9')
      assert.equal(scenesRecipe.shots.length, 3)
      assert.deepEqual(scenesRecipe.look.grading, ['high-contrast', 'cool'])
    })

    await check('scenes.mp4: craft + recipe are strictly JSON-serialisable', async () => {
      assertJsonSafe({ craft: scenesCraft, recipe: scenesRecipe })
    })

    await check('scenes.mp4: craft.json artifact was written for the caller', async () => {
      const info = await stat(join(scratchRoot, 'scenes', 'craft', 'craft.json'))
      assert.ok(info.size > 500, `craft.json is only ${info.size} bytes`)
    })

    await check('scenes.mp4 with lowResFrames=false degrades to null grading/overlays with warnings', async () => {
      const result = await analyzeCraft({
        tools,
        file: SCENES,
        workDir: join(workDir, 'scenes', 'craft-lowres'),
        analysis: scenesAnalysis,
        options: { lowResFrames: false },
      })
      assert.equal(result.craft.grading.contrast, null)
      assert.equal(result.craft.grading.signature, null)
      assert.equal(result.craft.overlays.textDensity, null)
      assert.ok(result.craft.warnings.some((warning) => /lowResFrames/u.test(warning)))
      assertRecipeShape(result.recipe, scenesAnalysis, result.craft)
      assertJsonSafe(result)
    })

    /* ---------------- trailer.mp4: 2 shots, hard cut at 5.76 s ---------------- */
    let trailerAnalysis = null
    await check('analyzeVideo + analyzeCraft run end-to-end on demo/media/trailer.mp4', async () => {
      const caseDir = join(workDir, 'trailer')
      await mkdir(caseDir, { recursive: true })
      trailerAnalysis = await analyseVideoFile(tools, TRAILER, caseDir, join(scratchRoot, 'trailer', 'video'))
      const { craft, recipe } = await analyzeCraft({
        tools,
        file: TRAILER,
        workDir: join(caseDir, 'craft'),
        analysis: trailerAnalysis,
      })
      printCraftSummary('trailer.mp4', craft, recipe)
      assert.equal(trailerAnalysis.shots.length, 2, `fixture should have 2 shots, got ${trailerAnalysis.shots.length}`)
      assert.equal(craft.cutRhythm.shotCount, trailerAnalysis.shots.length)
      assertCraftShape(craft, trailerAnalysis)
      assertRecipeShape(recipe, trailerAnalysis, craft)
      assertJsonSafe({ craft, recipe })
    })

    await check('trailer.mp4: the single hard cut at 5.76 s is detected', async () => {
      const { craft } = await analyzeCraft({
        tools,
        file: TRAILER,
        workDir: join(workDir, 'trailer', 'craft2'),
        analysis: trailerAnalysis,
      })
      assertBoundariesDetected(craft, trailerAnalysis, [5.76])
      assert.equal(craft.transitions.list.length, 1)
      assert.equal(craft.transitions.list[0].kind, 'cut')
      assert.equal(craft.cutRhythm.avgShotLength, 9.58)
      assert.equal(craft.cutRhythm.shortestShot, 5.76)
      assert.equal(craft.cutRhythm.longestShot, 13.4)
    })

    await check('trailer.mp4: slow nature footage is static, no overlay/title card false positives', async () => {
      const { craft } = await analyzeCraft({
        tools,
        file: TRAILER,
        workDir: join(workDir, 'trailer', 'craft3'),
        analysis: trailerAnalysis,
      })
      for (const entry of craft.camera) assert.equal(entry.motion, 'static', `camera ${entry.shotIndex} is ${entry.motion}`)
      assert.equal(craft.titleCard.present, false)
      assert.equal(craft.overlays.likelySubtitles, false)
      assert.equal(craft.overlays.textDensity, 0)
      assert.equal(craft.transitions.hardCutShare, 1)
    })

    /* ---------------- beat sync: 120 BPM soundtrack over the scenes video ---------------- */
    await check('beat sync: cuts at 4 s / 8 s land on the 120 BPM grid', async () => {
      const file = await buildBeatSyncFixture(tools, scratchRoot)
      const caseDir = join(workDir, 'beatsync')
      await mkdir(caseDir, { recursive: true })
      const analysis = await analyseVideoFile(tools, file, caseDir, join(scratchRoot, 'beatsync', 'video'))
      const { craft, recipe } = await analyzeCraft({
        tools,
        file,
        workDir: join(caseDir, 'craft'),
        analysis,
      })
      printCraftSummary('beatsync.mp4', craft, recipe)
      assert.ok(craft.beatSync.bpm !== null, 'BPM should be measured from the tone fixture')
      assert.ok(Math.abs(craft.beatSync.bpm - 120) <= 3, `bpm=${craft.beatSync.bpm}`)
      assert.ok(craft.beatSync.cutsOnBeatRatio !== null, 'cutsOnBeatRatio should be measurable')
      assert.ok(craft.beatSync.cutsOnBeatRatio >= 0.5, `cutsOnBeatRatio=${craft.beatSync.cutsOnBeatRatio}`)
      assert.ok(Math.abs(craft.beatSync.meanOffsetMs) <= 120, `meanOffsetMs=${craft.beatSync.meanOffsetMs}`)
      assert.match(craft.beatSync.note, /beat/u)
      assert.equal(recipe.pacing.beatSync, craft.beatSync.cutsOnBeatRatio)
      assert.equal(recipe.sound.bpm, craft.beatSync.bpm)
      assert.equal(recipe.sound.hasMusic, true)
      assert.ok(recipe.reproductionNotes.some((note) => /BPM/u.test(note)), 'reproduction notes should mention the measured BPM')
      assertJsonSafe({ craft, recipe })
    })

    /* ---------------- transition classifier: cross-fade vs dip-to-black ---------------- */
    await check('transition classifier: a cross-fade is not a hard cut', async () => {
      const file = await buildCrossfadeFixture(tools, scratchRoot)
      const caseDir = join(workDir, 'crossfade')
      await mkdir(caseDir, { recursive: true })
      const real = await analyseVideoFile(tools, file, caseDir, join(scratchRoot, 'crossfade', 'video'))
      // video.js deliberately does not report gradual transitions; pin the
      // boundary in the analysis so the classifier itself is under test.
      const analysis = splitAnalysisAt(real, 3)
      const { craft } = await analyzeCraft({ tools, file, workDir: join(caseDir, 'craft'), analysis })
      console.log(`      crossfade transitions: ${JSON.stringify(craft.transitions)}`)
      assert.equal(craft.transitions.list.length, 1)
      assert.equal(craft.transitions.list[0].kind, 'fade', `expected fade, got ${craft.transitions.list[0].kind}`)
      assertRange(craft.transitions.list[0].confidence, 0.4, 1, 'fade confidence')
      assertJsonSafe({ craft })
    })

    await check('transition classifier: a dip to black is detected via the luma V shape', async () => {
      const file = await buildDipToBlackFixture(tools, scratchRoot)
      const caseDir = join(workDir, 'dip')
      await mkdir(caseDir, { recursive: true })
      const real = await analyseVideoFile(tools, file, caseDir, join(scratchRoot, 'dip', 'video'))
      const analysis = splitAnalysisAt(real, 2.5)
      const { craft } = await analyzeCraft({ tools, file, workDir: join(caseDir, 'craft'), analysis })
      console.log(`      dip transitions: ${JSON.stringify(craft.transitions)}`)
      assert.equal(craft.transitions.list.length, 1)
      assert.equal(craft.transitions.list[0].kind, 'dip-to-black', `expected dip-to-black, got ${craft.transitions.list[0].kind}`)
      assert.equal(craft.transitions.gradualShare, 1)
      assertJsonSafe({ craft })
    })

    /* ---------------- degenerate input: 1-second flat clip ---------------- */
    await check('1-second flat clip: no throw, warnings present, honest nulls', async () => {
      const caseDir = join(workDir, 'tiny')
      await mkdir(caseDir, { recursive: true })
      const analysis = await analyseVideoFile(tools, TINY, caseDir, join(scratchRoot, 'tiny', 'video'))
      const { craft, recipe } = await analyzeCraft({ tools, file: TINY, workDir: join(caseDir, 'craft'), analysis })
      printCraftSummary('tiny-solid.mp4', craft, recipe)
      assert.ok(craft.warnings.length >= 1, 'a 1 s clip must carry warnings')
      assert.equal(craft.cutRhythm.shotCount, 1)
      assert.ok(Array.isArray(craft.transitions.list))
      assert.equal(craft.transitions.list.length, 0)
      assert.ok(craft.transitions.hardCutShare === 0 || craft.transitions.hardCutShare === null)
      assert.equal(craft.camera.length, 1)
      assert.equal(craft.titleCard.present, false)
      assert.equal(recipe.shots.length, 1)
      assert.equal(recipe.reproductionNotes.length >= 3, true)
      assertCraftShape(craft, analysis)
      assertRecipeShape(recipe, analysis, craft)
      assertJsonSafe({ craft, recipe })
    })

    await check('missing analysis throws a clear error', async () => {
      await assert.rejects(
        () => analyzeCraft({ tools, file: SCENES, workDir: join(workDir, 'invalid'), analysis: null }),
        /analysis/u,
      )
    })

    await check('a metadata-free analysis degrades instead of throwing', async () => {
      const { craft, recipe } = await analyzeCraft({
        tools,
        file: SCENES,
        workDir: join(workDir, 'empty-analysis'),
        analysis: { kind: 'video', duration: 0, shots: [], timeline: [], stream: {}, audio: null, flags: {} },
      })
      assert.equal(craft.cutRhythm.shotCount, 0)
      assert.equal(craft.cutRhythm.avgShotLength, null)
      assert.deepEqual(craft.sections, [])
      assert.ok(craft.warnings.length >= 2)
      assert.equal(recipe.reproductionNotes.length >= 3, true)
      assertJsonSafe({ craft, recipe })
    })
  } finally {
    await removeWorkDir(workDir)
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => {})
  }

  console.log('')
  console.log(`craft-engine: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
