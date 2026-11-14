#!/usr/bin/env node
/**
 * Acceptance tests for the continuity analyser (lib/continuity.js) and the
 * additive continuity block in lib/montage.js.
 *
 * Run: node test/continuity.test.mjs
 *
 * The M2 acceptance criteria this file covers:
 *  1. continuity across a boundary: a subject translating over a static
 *     backdrop and a continuously panning camera both read as `carried`; a
 *     hard cut between two unrelated colour blocks reads as `bare`, and the
 *     carry score ordering is right;
 *  2. a completely static clip (and a single-shot input) returns zero
 *     boundaries / considered === 0 / score null with blind spots, no throw;
 *  3. the score formula is (carried + anchored / 2) / considered, and anchored
 *     (big static survivor) yields 0.5 on a static pair;
 *  4. cut bursts (>= 3 cuts within 1.5 s) and the last 1.2 s are exempt;
 *  5. `zoneDwell` finds a persistent top title (top.seconds non-zero) and stays
 *     at zero on a static clip; a timed title bar is measured within ~0.5 s;
 *  6. `diffMetrics` keeps its historical 11-row contract and only adds the
 *     `continuity` field when continuity data is supplied; its section
 *     renderers produce Markdown without touching the blind report;
 *  7. `node test/montage.test.mjs` keeps passing (the 11-row contract is
 *     enforced by running that suite separately; this file checks the shape).
 *
 * Every fixture is built here with ffmpeg, so this test is self-contained.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWorkDir, removeWorkDir, resolveTools, run } from '../lib/ffmpeg.js'
import {
  analyzeContinuity,
  CONTINUITY_BLIND_SPOTS,
  CONTINUITY_THRESHOLDS,
  continuityVerdict,
  zoneDwell,
} from '../lib/continuity.js'
import {
  CONTINUITY_DIFF_THRESHOLDS,
  diffMetrics,
  renderChangeSection,
  renderContinuitySection,
  renderZoneDwellSection,
} from '../lib/montage.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = join(HERE, '..', 'lib', 'continuity.js')
const MONTAGE_PATH = join(HERE, '..', 'lib', 'montage.js')
const FPS = 30
const WIDTH = 320
const HEIGHT = 180

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
 * Assertion helpers
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

function assertJsonSafe(value, label) {
  assertFiniteTree(value, label)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} does not survive a JSON round-trip unchanged`)
}

function assertRange(value, min, max, name) {
  assert.equal(typeof value, 'number', `${name} is not a number`)
  assert.ok(Number.isFinite(value), `${name} is not finite`)
  assert.ok(value >= min && value <= max, `${name}=${value} is outside [${min}, ${max}]`)
}

/** Shape check for one analyzeContinuity result. */
function assertContinuityShape(result, label) {
  assert.ok(Array.isArray(result.boundaries), `${label}.boundaries is not an array`)
  for (const boundary of result.boundaries) {
    assertRange(boundary.t, 0, 24 * 3600, `${label}.boundaries[].t`)
    assert.ok(['carried', 'anchored', 'bare'].includes(boundary.kind), `${label}: bad kind ${boundary.kind}`)
    assertRange(boundary.survivorShare, 0, 1, `${label}.boundaries[].survivorShare`)
    assertRange(boundary.displacement, 0, 2, `${label}.boundaries[].displacement`)
    assertRange(boundary.scaleDelta, -0.99, 5, `${label}.boundaries[].scaleDelta`)
    assert.equal(typeof boundary.exempt, 'boolean', `${label}.boundaries[].exempt must be boolean`)
  }
  assert.ok(result.score === null || (Number.isFinite(result.score) && result.score >= 0 && result.score <= 1), `${label}.score`)
  for (const key of ['considered', 'carried', 'anchored', 'bare']) {
    assert.ok(Number.isInteger(result[key]) && result[key] >= 0, `${label}.${key} must be a non-negative integer`)
  }
  assert.ok(Array.isArray(result.blindSpots), `${label}.blindSpots is not an array`)
  for (const spot of result.blindSpots) assert.equal(typeof spot, 'string', `${label}.blindSpots contains a non-string`)
}

/** Shape check for one zoneDwell result. */
function assertZoneShape(zone, label) {
  for (const band of ['top', 'centre', 'bottom']) {
    assert.ok(zone[band] !== null && typeof zone[band] === 'object', `${label}.${band} missing`)
    assertRange(zone[band].seconds, 0, 24 * 3600, `${label}.${band}.seconds`)
    assertRange(zone[band].ratio, 0, 1, `${label}.${band}.ratio`)
  }
  assertRange(zone.occupiedSeconds, 0, 24 * 3600, `${label}.occupiedSeconds`)
  assert.ok(zone.occupiedSeconds <= zone.top.seconds + zone.centre.seconds + zone.bottom.seconds + 1e-9, 'union cannot exceed the sum')
}

function printBoundaries(label, result) {
  const parts = result.boundaries.map(
    (boundary) =>
      `${boundary.t}s ${boundary.kind}` +
      `${boundary.exempt ? '(exempt)' : ''} survivor=${boundary.survivorShare} ` +
      `move=${boundary.displacement}${boundary.scaleDelta !== 0 ? ` scale=${boundary.scaleDelta}` : ''}`,
  )
  console.log(`      ${label}: score=${result.score} considered=${result.considered} ` +
    `carried=${result.carried} anchored=${result.anchored} bare=${result.bare}`)
  console.log(`        boundaries: ${parts.join(' | ') || '(none)'}`)
  if (result.blindSpots.length > 0) console.log(`        blindSpots=${result.blindSpots.length}`)
}

/** Minimal analyzeVideo-shaped object accepted by diffMetrics. */
function minimalAnalysis(continuityResult) {
  const analysis = {
    duration: 6,
    global: {
      shotCount: 2,
      cutRate: 10,
      avgBrightness: 0.4,
      avgSaturation: 0.5,
      colorfulness: 40,
      dominantHues: [{ name: 'red', share: 0.6, hex: '#e03131' }],
    },
    shots: [
      { index: 0, start: 0, end: 3, duration: 3 },
      { index: 1, start: 3, end: 6, duration: 3 },
    ],
    craft: { cutRhythm: { hardCutShare: 1 }, beatSync: { ratio: 0.5 }, grading: null },
  }
  if (continuityResult !== undefined) analysis.continuity = continuityResult
  return analysis
}

/* ------------------------------------------------------------------ *
 * Fixtures (ffmpeg only, built inside the test)
 * ------------------------------------------------------------------ */

/** A continuously panning textured backdrop (no real cut): fake boundary at 3 s should be `carried`. */
async function buildPanFixture(tools, directory) {
  const output = join(directory, 'pan.mp4')
  const result = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'gradients=s=960x180:c0=0x101a3b:c1=0xd06020:r=30:d=6:speed=0:seed=1',
      '-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:r=30:d=6`,
      '-filter_complex',
      // Draw the texture on the scrolling source, then pan it 20 px/s: the
      // 0.4 s comparison pair is therefore displaced by exactly 8 raster px.
      "[0:v]drawgrid=w=24:h=24:t=3:c=0xffffff@0.45[g];" +
        "[1:v][g]overlay=x='-t*20':y=0:shortest=1:eval=frame,format=yuv420p[v]",
      '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', '30',
      output,
    ],
    { cwd: directory, timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `could not build the pan fixture: ${result.stderr.slice(0, 300)}`)
  return output
}

/**
 * "The same subject translates": a static textured backdrop plus a 60x60 solid
 * subject sliding right at 20 px/s (8 raster px across the 0.4 s pair). The
 * backdrop is the dominant survivor, so this fixture proves that a *coherent
 * moving survivor cluster* is detected even when it is not the largest one.
 */
async function buildSubjectMotionFixture(tools, directory) {
  const output = join(directory, 'subject-motion.mp4')
  const result = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'gradients=s=320x180:c0=0x101a3b:c1=0x30506a:r=30:d=6:speed=0:seed=1',
      '-f', 'lavfi', '-i', 'color=c=0xf0d060:s=60x60:r=30:d=6',
      '-filter_complex',
      "[0:v]drawgrid=w=24:h=24:t=3:c=0xffffff@0.45[bg];" +
        "[bg][1:v]overlay=x='40+t*20':y=60:shortest=1:eval=frame,format=yuv420p[v]",
      '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', '30',
      output,
    ],
    { cwd: directory, timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `could not build the subject-motion fixture: ${result.stderr.slice(0, 300)}`)
  return output
}

/** A hard cut between two completely different colour blocks: should be `bare`. */
async function buildHardCutFixture(tools, directory) {
  const output = join(directory, 'hard-cut.mp4')
  const result = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x8a1010:s=320x180:r=30:d=3',
      '-f', 'lavfi', '-i', 'color=c=0x1040c0:s=320x180:r=30:d=3',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]',
      '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', '30',
      output,
    ],
    { cwd: directory, timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `could not build the hard-cut fixture: ${result.stderr.slice(0, 300)}`)
  return output
}

/** A completely static 3 s colour clip. */
async function buildStaticFixture(tools, directory) {
  const output = join(directory, 'static.mp4')
  const result = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x203040:s=320x180:r=30:d=3',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', '30',
      output,
    ],
    { cwd: directory, timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `could not build the static fixture: ${result.stderr.slice(0, 300)}`)
  return output
}

/**
 * 8 s clip: flat background plus a white title bar with three dark "text"
 * blocks in the top band. `window` = [from, to] seconds the title is visible
 * (null = the whole clip, i.e. a persistent title).
 */
async function buildTitleFixture(tools, directory, name, window) {
  const output = join(directory, name)
  const enable = window === null ? '' : `:enable='between(t,${window[0]},${window[1]})'`
  const result = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x233042:s=320x180:r=30:d=8',
      '-f', 'lavfi', '-i', 'color=c=white:s=320x36:r=30:d=8',
      '-filter_complex',
      '[1:v]drawbox=x=20:y=8:w=50:h=20:c=black:t=fill,' +
        'drawbox=x=80:y=8:w=30:h=20:c=black:t=fill,' +
        `drawbox=x=120:y=8:w=70:h=20:c=black:t=fill[title];` +
        `[0:v][title]overlay=x=0:y=0${enable}[v]`,
      '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', '30',
      output,
    ],
    { cwd: directory, timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `could not build ${name}: ${result.stderr.slice(0, 300)}`)
  return output
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const root = await makeWorkDir('media-senses-continuity-test')
  const fixturesDir = join(root, 'fixtures')
  const workDir = join(root, 'work')
  await mkdir(fixturesDir, { recursive: true })
  await mkdir(workDir, { recursive: true })
  let tools
  try {
    tools = await resolveTools()
  } catch (error) {
    console.log(`FAIL  cannot resolve ffmpeg/ffprobe: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    await removeWorkDir(root)
    return
  }

  try {
    const panFile = await buildPanFixture(tools, fixturesDir)
    const subjectFile = await buildSubjectMotionFixture(tools, fixturesDir)
    const cutFile = await buildHardCutFixture(tools, fixturesDir)
    const staticFile = await buildStaticFixture(tools, fixturesDir)
    const titleFullFile = await buildTitleFixture(tools, fixturesDir, 'title-full.mp4', null)
    const titleTimedFile = await buildTitleFixture(tools, fixturesDir, 'title-timed.mp4', [2, 6])
    console.log('continuity test fixtures: pan.mp4, subject-motion.mp4, hard-cut.mp4, static.mp4, title-full.mp4, title-timed.mp4')

    const twoShotList = [
      { index: 0, start: 0, end: 3, duration: 3 },
      { index: 1, start: 3, end: 6, duration: 3 },
    ]

    /* ---------- (1) carried vs bare ---------- */
    const panResult = await analyzeContinuity({ tools, file: panFile, workDir, shots: twoShotList })
    const subjectResult = await analyzeContinuity({ tools, file: subjectFile, workDir, shots: twoShotList, duration: 6 })
    const cutResult = await analyzeContinuity({ tools, file: cutFile, workDir, shots: twoShotList, duration: 6 })

    await check('pan across a fake boundary reads as carried (moving survivor)', () => {
      assertContinuityShape(panResult, 'pan')
      assert.equal(panResult.boundaries.length, 1)
      const boundary = panResult.boundaries[0]
      assert.equal(boundary.kind, 'carried', `pan should be carried, got ${boundary.kind} (survivorShare=${boundary.survivorShare}, move=${boundary.displacement})`)
      assert.ok(boundary.survivorShare >= 0.5, `a pan should keep most of the frame alive, got ${boundary.survivorShare}`)
      assert.ok(boundary.displacement >= CONTINUITY_THRESHOLDS.carriedMoveShare, `displacement ${boundary.displacement} should reach ${CONTINUITY_THRESHOLDS.carriedMoveShare}`)
      assert.ok(Math.abs(boundary.scaleDelta) < CONTINUITY_THRESHOLDS.carriedScaleShare, 'a pure pan must not read as a scale change')
      assert.equal(panResult.score, 1, `one carried boundary must score 1, got ${panResult.score}`)
      assert.equal(panResult.considered, 1)
      assert.equal(panResult.carried, 1)
      printBoundaries('pan.mp4', panResult)
    })

    await check('the same subject translating over a static backdrop reads as carried', () => {
      assertContinuityShape(subjectResult, 'subject-motion')
      assert.equal(subjectResult.boundaries.length, 1)
      const boundary = subjectResult.boundaries[0]
      // The backdrop is the dominant (static) survivor; the subject is only a
      // small coherent moving cluster. It must still classify as carried.
      assert.ok(boundary.survivorShare >= 0.8, `static backdrop should survive, got ${boundary.survivorShare}`)
      assert.equal(boundary.kind, 'carried', `translating subject should be carried, got ${boundary.kind} (move=${boundary.displacement})`)
      assert.ok(
        boundary.displacement >= CONTINUITY_THRESHOLDS.carriedMoveShare,
        `subject displacement ${boundary.displacement} should reach ${CONTINUITY_THRESHOLDS.carriedMoveShare}`,
      )
      assert.equal(subjectResult.score, 1)
      assertJsonSafe(subjectResult, 'subject-motion continuity')
      printBoundaries('subject-motion.mp4', subjectResult)
    })

    await check('hard cut between unrelated colour blocks reads as bare', () => {
      assertContinuityShape(cutResult, 'hard-cut')
      assert.equal(cutResult.boundaries.length, 1)
      const boundary = cutResult.boundaries[0]
      assert.equal(boundary.kind, 'bare', `hard cut should be bare, got ${boundary.kind}`)
      assert.ok(boundary.survivorShare <= 0.04, `nothing should survive, got survivorShare=${boundary.survivorShare}`)
      assert.equal(cutResult.score, 0)
      assert.equal(cutResult.bare, 1)
      printBoundaries('hard-cut.mp4', cutResult)
    })

    await check('carry score ordering: carried scores are higher than the hard-cut score', () => {
      assert.ok(panResult.score > cutResult.score, `expected pan ${panResult.score} > cut ${cutResult.score}`)
      assert.ok(subjectResult.score > cutResult.score, `expected subject ${subjectResult.score} > cut ${cutResult.score}`)
    })

    await check('continuity output is JSON-safe and always carries the documented blind spots', () => {
      assertJsonSafe(panResult, 'pan continuity')
      assertJsonSafe(cutResult, 'hard-cut continuity')
      assert.ok(panResult.blindSpots.length >= CONTINUITY_BLIND_SPOTS.length)
      assert.ok(panResult.blindSpots.some((spot) => /暗底/u.test(spot)), 'dark-detail blind spot missing')
      assert.ok(panResult.blindSpots.some((spot) => /边界数/u.test(spot)), 'boundary-count blind spot missing')
    })

    await check('a plain number list of boundary times is accepted as shots', async () => {
      const result = await analyzeContinuity({ tools, file: panFile, workDir, shots: [3], duration: 6 })
      assert.equal(result.boundaries.length, 1)
      assert.equal(result.boundaries[0].kind, 'carried')
    })

    /* ---------- (2) static / single-shot degradation ---------- */
    const staticResult = await analyzeContinuity({ tools, file: staticFile, workDir, shots: [{ start: 0, end: 3, duration: 3 }], duration: 3 })
    const staticFakeBoundary = await analyzeContinuity({
      tools,
      file: staticFile,
      workDir,
      shots: [{ start: 0 }, { start: 1.5 }],
      duration: 3,
    })

    await check('full-static single-shot input: 0 boundaries, considered 0, score null, blind spots, no throw', () => {
      assertContinuityShape(staticResult, 'static')
      assert.equal(staticResult.boundaries.length, 0)
      assert.equal(staticResult.considered, 0)
      assert.equal(staticResult.score, null)
      assert.ok(staticResult.blindSpots.some((spot) => /无法判断|单镜头/u.test(spot)), 'static input must explain the blind spot')
      assertJsonSafe(staticResult, 'static continuity')
      printBoundaries('static.mp4 (single shot)', staticResult)
    })

    await check('missing shots / empty shots also degrade to considered 0 (never throw)', async () => {
      for (const shots of [undefined, null, []]) {
        const result = await analyzeContinuity({ tools, file: staticFile, workDir, shots, duration: 3 })
        assert.equal(result.boundaries.length, 0)
        assert.equal(result.considered, 0)
        assert.equal(result.score, null)
        assert.ok(result.blindSpots.length >= 2)
      }
    })

    await check('anchored: a big static survivor on a flat pair scores 0.5', () => {
      assertContinuityShape(staticFakeBoundary, 'static-fake-boundary')
      assert.equal(staticFakeBoundary.boundaries.length, 1)
      const boundary = staticFakeBoundary.boundaries[0]
      assert.equal(boundary.kind, 'anchored', `flat static pair should be anchored, got ${boundary.kind}`)
      assert.equal(boundary.displacement, 0)
      assert.equal(staticFakeBoundary.score, 0.5, `(0 carried + 1/2 anchored) / 1 = 0.5, got ${staticFakeBoundary.score}`)
    })

    /* ---------- (3) exemptions ---------- */
    const denseResult = await analyzeContinuity({
      tools,
      file: panFile,
      workDir,
      shots: [{ start: 0 }, { start: 1.0 }, { start: 1.2 }, { start: 1.4 }, { start: 3.0 }, { start: 5.2 }],
      duration: 6,
    })

    await check('cut burst (3 cuts in 1.5 s) and the last 1.2 s are exempt from the score', () => {
      assertContinuityShape(denseResult, 'dense')
      const byTime = new Map(denseResult.boundaries.map((boundary) => [boundary.t, boundary]))
      for (const burstTime of [1.0, 1.2, 1.4]) {
        assert.equal(byTime.get(burstTime)?.exempt, true, `boundary ${burstTime}s should be exempt (burst)`)
      }
      assert.equal(byTime.get(3.0)?.exempt, false, 'an isolated boundary must be scored')
      assert.equal(byTime.get(5.2)?.exempt, true, 'boundary inside the last 1.2 s should be exempt')
      assert.equal(denseResult.considered, 1, `only the 3 s boundary should be scored, got ${denseResult.considered}`)
      assert.equal(denseResult.score, 1)
      assert.ok(denseResult.blindSpots.some((spot) => /豁免/u.test(spot)), 'exemption count should be reported')
      printBoundaries('pan.mp4 (dense)', denseResult)
    })

    /* ---------- (4) zoneDwell ---------- */
    const zoneFull = await zoneDwell({ tools, file: titleFullFile, workDir })
    const zoneTimed = await zoneDwell({ tools, file: titleTimedFile, workDir })
    const zoneStatic = await zoneDwell({ tools, file: staticFile, workDir })

    await check('zoneDwell: a persistent top title makes top.seconds non-zero (and bottom stays empty)', () => {
      assertZoneShape(zoneFull, 'title-full')
      assert.ok(zoneFull.top.seconds > 0, `top title should be detected, got ${zoneFull.top.seconds}`)
      assert.ok(zoneFull.top.ratio >= 0.9, `a title present for the whole clip should occupy ~100% of it, got ${zoneFull.top.ratio}`)
      assert.equal(zoneFull.bottom.seconds, 0, 'the flat bottom band must not read as occupied')
      assert.equal(zoneFull.occupiedSeconds, zoneFull.top.seconds)
      assertJsonSafe(zoneFull, 'title-full zone')
      console.log(`      title-full zone: ${JSON.stringify(zoneFull)}`)
    })

    await check('zoneDwell: a title shown for 2-6 s of 8 s is measured within 0.5 s', () => {
      assertZoneShape(zoneTimed, 'title-timed')
      assert.ok(zoneTimed.top.seconds > 0, 'the timed title must be detected')
      assert.ok(
        Math.abs(zoneTimed.top.seconds - 4) <= 0.5,
        `expected ~4 s of top occupancy, got ${zoneTimed.top.seconds}`,
      )
      assert.equal(zoneTimed.bottom.seconds, 0)
      console.log(`      title-timed zone: ${JSON.stringify(zoneTimed)}`)
    })

    await check('zoneDwell: a static flat clip has no occupied zone', () => {
      assertZoneShape(zoneStatic, 'zone-static')
      assert.equal(zoneStatic.top.seconds, 0)
      assert.equal(zoneStatic.centre.seconds, 0)
      assert.equal(zoneStatic.bottom.seconds, 0)
      assert.equal(zoneStatic.occupiedSeconds, 0)
      assertJsonSafe(zoneStatic, 'static zone')
    })

    /* ---------- (5) diffMetrics continuity block (additive only) ---------- */
    const refAnalysis = minimalAnalysis(panResult)
    const builtAnalysis = minimalAnalysis(cutResult)
    const plainDiff = diffMetrics(minimalAnalysis(), minimalAnalysis())

    await check('diffMetrics: historical 11-row contract unchanged, no continuity field when absent', () => {
      assert.equal(plainDiff.rows.length, 11, 'diffMetrics must always return 11 rows')
      assert.deepEqual(
        plainDiff.rows.map((row) => row.metric),
        ['时长', '镜头数', '平均镜头长', '切点率', '平均亮度', '平均彩度', 'BPM', '调性', '硬切占比', '卡点率', '调色签名'],
      )
      assert.equal('continuity' in plainDiff, false, 'continuity must be omitted when no continuity data is supplied')
      assertJsonSafe(plainDiff, 'plain diff')
    })

    await check('diffMetrics: ref.continuity / built.continuity attach an additive continuity block', () => {
      const diff = diffMetrics(refAnalysis, builtAnalysis)
      assert.equal(diff.rows.length, 11, 'continuity must not change the row count')
      assert.ok(diff.continuity !== null && typeof diff.continuity === 'object', 'continuity block missing')
      assert.equal(diff.continuity.ref.score, 1, `ref carry score should be 1, got ${diff.continuity.ref.score}`)
      assert.equal(diff.continuity.built.score, 0, `built carry score should be 0, got ${diff.continuity.built.score}`)
      assert.equal(diff.continuity.delta, -1)
      assert.equal(diff.continuity.verdict, 'diverge')
      assert.equal(diff.continuity.ref.verdict, 'ok')
      assert.equal(diff.continuity.built.verdict, 'ppt')
      assert.equal(diff.continuity.thresholds.match, CONTINUITY_DIFF_THRESHOLDS.match)
      assertJsonSafe(diff, 'diff with continuity')
    })

    await check('diffMetrics: continuity accepts options and positional forms; rows stay identical', () => {
      const fromFields = diffMetrics(refAnalysis, builtAnalysis)
      const fromOptions = diffMetrics(minimalAnalysis(), minimalAnalysis(), { continuity: { ref: panResult, built: cutResult } })
      const fromPositional = diffMetrics(minimalAnalysis(), minimalAnalysis(), panResult, cutResult)
      assert.deepEqual(fromOptions.continuity, fromFields.continuity)
      assert.deepEqual(fromPositional.continuity, fromFields.continuity)
      assert.deepEqual(fromFields.rows, plainDiff.rows, 'adding continuity must leave the metric rows byte-identical')
    })

    /* ---------- (6) section renderers ---------- */
    await check('renderContinuitySection: explains the PPT verdict, the blind spots and accepts raw input', () => {
      const diff = diffMetrics(refAnalysis, builtAnalysis)
      const markdown = renderContinuitySection(diff)
      assert.match(markdown, /## 镜头承接/u)
      assert.match(markdown, /参考/u)
      assert.match(markdown, /成片/u)
      assert.match(markdown, /像 PPT/u)
      assert.match(markdown, /盲区/u)
      assert.match(markdown, /承接分 1\.00/u)
      // A single raw analyzeContinuity result renders too.
      const single = renderContinuitySection(panResult)
      assert.match(single, /承接分 1\.00/u)
      assert.doesNotMatch(single, /成片/u)
      // And the documented alias delegates.
      assert.equal(renderChangeSection(diff), markdown)
      // Unknown input degrades to a note instead of throwing.
      assert.match(renderContinuitySection(null), /无数据/u)
    })

    await check('renderZoneDwellSection: renders a per-band seconds/ratio table', () => {
      const markdown = renderZoneDwellSection(zoneTimed)
      assert.match(markdown, /## 区域停留/u)
      assert.match(markdown, /\| 顶部 \|/u)
      assert.match(markdown, /\| 中部 \|/u)
      assert.match(markdown, /\| 底部 \|/u)
      assert.match(markdown, /4\.00 s/u)
      assert.match(renderZoneDwellSection(null), /无数据/u)
    })

    /* ---------- (7) robustness ---------- */
    await check('unreadable input throws a clear error', async () => {
      await assert.rejects(
        () => analyzeContinuity({ tools, file: join(fixturesDir, 'does-not-exist.mp4'), workDir, shots: twoShotList }),
        /cannot read input video/u,
      )
      await assert.rejects(() => zoneDwell({ tools, file: join(fixturesDir, 'nope.mp4'), workDir }), /cannot read input video/u)
    })

    await check('an abort signal rejects with AbortError', async () => {
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        () => analyzeContinuity({ tools, file: panFile, workDir, shots: twoShotList, signal: controller.signal }),
        (error) => error instanceof Error && error.name === 'AbortError',
      )
      await assert.rejects(
        () => zoneDwell({ tools, file: panFile, workDir, signal: controller.signal }),
        (error) => error instanceof Error && error.name === 'AbortError',
      )
    })

    /* ---------- (8) constants / hygiene ---------- */
    await check('the calibrated constants are exported and the PPT/remind thresholds read correctly', () => {
      assert.equal(CONTINUITY_THRESHOLDS.carriedMoveShare, 0.02)
      assert.equal(CONTINUITY_THRESHOLDS.anchoredMinComponentShare, 0.03)
      assert.equal(CONTINUITY_THRESHOLDS.pptScore, 0.5)
      assert.equal(CONTINUITY_THRESHOLDS.remindScore, 0.7)
      assert.equal(CONTINUITY_THRESHOLDS.windowSeconds, 0.4)
      assert.equal(CONTINUITY_THRESHOLDS.decodeFps, 2.5)
      assert.equal(CONTINUITY_THRESHOLDS.gridColumns, 12)
      assert.equal(CONTINUITY_THRESHOLDS.gridRows, 9)
      assert.equal(CONTINUITY_THRESHOLDS.burstWindowSeconds, 1.5)
      assert.equal(CONTINUITY_THRESHOLDS.burstMinCuts, 3)
      assert.equal(CONTINUITY_THRESHOLDS.tailExemptSeconds, 1.2)
      assert.equal(CONTINUITY_THRESHOLDS.survivorSad, 22)
      assert.equal(CONTINUITY_THRESHOLDS.motionClusterMinBlocks, 3)
      assert.equal(continuityVerdict(0.3), 'ppt')
      assert.equal(continuityVerdict(0.6), 'warning')
      assert.equal(continuityVerdict(0.8), 'ok')
      assert.equal(continuityVerdict(null), 'unknown')
      assert.ok(CONTINUITY_BLIND_SPOTS.length >= 2)
    })

    await check('module hygiene: ESM, node --check clean, only Node/local imports, expected exports', async () => {
      const { execFileSync } = await import('node:child_process')
      const { readFile } = await import('node:fs/promises')
      execFileSync(process.execPath, ['--check', MODULE_PATH], { stdio: 'pipe' })
      execFileSync(process.execPath, ['--check', MONTAGE_PATH], { stdio: 'pipe' })
      execFileSync(process.execPath, ['--check', fileURLToPath(import.meta.url)], { stdio: 'pipe' })
      const source = await readFile(MODULE_PATH, 'utf8')
      const imports = [...source.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gmu)].map((match) => match[1])
      assert.ok(imports.length > 0, 'continuity.js should import its helpers')
      for (const specifier of imports) {
        assert.ok(
          specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
          `continuity.js must only import Node builtins and local helpers, found "${specifier}"`,
        )
      }
      assert.doesNotMatch(source, /drawtext=/u, 'continuity.js must not use drawtext')
      const module = await import('../lib/continuity.js')
      for (const name of ['analyzeContinuity', 'zoneDwell', 'continuityVerdict', 'CONTINUITY_THRESHOLDS', 'CONTINUITY_BLIND_SPOTS']) {
        assert.ok(module[name] !== undefined, `continuity.js must export ${name}`)
      }
    })
  } finally {
    await removeWorkDir(root)
  }

  console.log('')
  console.log(`continuity: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

await main()
