#!/usr/bin/env node
/**
 * Acceptance tests for the change-score frame selector (lib/change.js).
 *
 * Run: node test/change.test.mjs
 *
 * The module absorbs the change-driven frame selection idea of `dsh-see-now`
 * (github.com/SAOS-3624/dsh-see-now, Apache-2.0): a 64x36 HSV change score per
 * frame, a spike (cut) detector, an integration detector for slow continuous
 * motion and a fallback for static content.
 *
 * Three fixtures are BUILT HERE with ffmpeg (nothing is shared with other
 * tests, so this file can run on its own):
 *
 *   (a) slideshow.mp4    12 s, four distinct solid-colour scenes of 3 s each
 *                        => cuts at 3 s / 6 s / 9 s
 *   (b) static.mp4       12 s of one flat colour => no cuts, fallback only
 *   (c) slow-motion.mp4  12 s of a slowly rotating high-contrast gradient
 *                        => continuous change, no spikes, integrated frames
 *
 * What is covered (PASS/FAIL per assertion):
 *   1. scoreVideo: frame count/fps, finite 0-255 scores and HSV summaries,
 *      mean/p95/max statistics.
 *   2. selectFrames on the slideshow: 3-4 cuts within 0.3 s of the true
 *      boundaries, ascending/deduplicated selected times, JSON round-trip.
 *   3. static clip: 0 cuts, at most 2 fallback frames, honest warning.
 *   4. slow motion: 2-4 integrated frames, 0 cuts, max score stays below cutAbs.
 *   5. selectFrames unit rules: spike ratio + minGap, integration accumulator
 *      formula, same-frame dedupe (cut wins), cap priority (cuts > integrated >
 *      fallback), static fallback, bare-number-array input.
 *   6. scoreSequence: a PNG sequence extracted from the slideshow gives the same
 *      cuts as scoreVideo (±1 frame); a non-`%04d` file list goes through the
 *      concat-demuxer fallback and produces the same scores.
 *   7. Robustness: unreadable file throws clearly, a very short clip returns
 *      warnings instead of throwing, an abort signal rejects with AbortError,
 *      and the maxFrames budget lowers the sampling rate.
 *   8. Runtime: scoreVideo on a 12 s clip at fps=12 finishes well under 3 s.
 */
import assert from 'node:assert/strict'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWorkDir, removeWorkDir, resolveTools, run } from '../lib/ffmpeg.js'
import {
  CHANGE_WEIGHTS,
  DEFAULT_SELECTION_OPTIONS,
  SCORE_MAX,
  scoreSequence,
  scoreVideo,
  selectFrames,
} from '../lib/change.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** True scene boundaries of the slideshow fixture (seconds). */
const SLIDESHOW_BOUNDARIES = [3, 6, 9]
/** Window used for the "slow motion" fixture assertions (count of integrated frames). */
const SLOW_INTEGRATED_MIN = 2
const SLOW_INTEGRATED_MAX = 4
/** Runtime budget from the acceptance criteria. */
const RUNTIME_BUDGET_MS = 3000

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
  const roundTripped = JSON.parse(JSON.stringify(value))
  assert.deepEqual(roundTripped, value, `${label} does not survive a JSON round-trip unchanged`)
}

function assertRange(value, min, max, name) {
  assert.equal(typeof value, 'number', `${name} is not a number`)
  assert.ok(Number.isFinite(value), `${name} is not finite`)
  assert.ok(value >= min && value <= max, `${name}=${value} is outside [${min}, ${max}]`)
}

/** Assert every frame of a score result is finite and in range. */
function assertScoreResultShape(result, label) {
  assert.equal(typeof result.fps, 'number', `${label}.fps is not a number`)
  assert.ok(Number.isFinite(result.fps) && result.fps > 0, `${label}.fps is not a positive finite number`)
  assert.ok(Array.isArray(result.frames), `${label}.frames is not an array`)
  assert.ok(Array.isArray(result.warnings), `${label}.warnings is not an array`)
  for (const warning of result.warnings) assert.equal(typeof warning, 'string', `${label}.warnings contains a non-string`)
  for (let index = 0; index < result.frames.length; index += 1) {
    const frame = result.frames[index]
    assert.equal(frame.index, index, `${label}.frames[${index}].index should be ${index}`)
    assertRange(frame.time, 0, 24 * 3600, `${label}.frames[${index}].time`)
    assertRange(frame.score, 0, SCORE_MAX, `${label}.frames[${index}].score`)
    assert.ok(frame.hsv !== null && typeof frame.hsv === 'object', `${label}.frames[${index}].hsv is missing`)
    assertRange(frame.hsv.h, 0, 360, `${label}.frames[${index}].hsv.h`)
    assertRange(frame.hsv.s, 0, 1, `${label}.frames[${index}].hsv.s`)
    assertRange(frame.hsv.v, 0, 1, `${label}.frames[${index}].hsv.v`)
  }
  assertRange(result.mean, 0, SCORE_MAX, `${label}.mean`)
  assertRange(result.p95, 0, SCORE_MAX, `${label}.p95`)
  assertRange(result.max, 0, SCORE_MAX, `${label}.max`)
  assert.ok(result.mean <= result.max, `${label}.mean should not exceed max`)
  assert.ok(result.p95 <= result.max, `${label}.p95 should not exceed max`)
}

/** Assert selected times ascend and are deduplicated (at least one frame apart). */
function assertSelectedOrdering(selection, fps, label) {
  const times = selection.selected.map((entry) => entry.time)
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(times[index] >= times[index - 1], `${label}: selected times are not ascending (${times.join(', ')})`)
    assert.ok(
      Math.round((times[index] - times[index - 1]) * fps) >= 1,
      `${label}: selected times ${times[index - 1]} and ${times[index]} are on the same frame`,
    )
  }
  const reasons = new Set(selection.selected.map((entry) => entry.reason))
  for (const reason of reasons) assert.ok(['cut', 'integrated', 'fallback'].includes(reason), `${label}: bad reason ${reason}`)
  return times
}

/** Print a compact score/selection summary for the report. */
function printSummary(label, scored, selection) {
  const cuts = selection.cuts.map((time) => time.toFixed(2)).join(', ') || '(none)'
  const integrated = selection.selected.filter((entry) => entry.reason === 'integrated').map((entry) => entry.time.toFixed(2))
  const fallback = selection.selected.filter((entry) => entry.reason === 'fallback').map((entry) => entry.time.toFixed(2))
  console.log(
    `      ${label}: frames=${scored.frames.length} fps=${scored.fps} ` +
      `mean=${scored.mean} p95=${scored.p95} max=${scored.max}`,
  )
  console.log(`        cuts=[${cuts}] integrated=[${integrated.join(', ')}] fallback=[${fallback.join(', ')}]`)
  if (scored.warnings.length > 0) console.log(`        warnings=${JSON.stringify(scored.warnings)}`)
}

/* ------------------------------------------------------------------ *
 * Fixture builders (all built inside the test, nothing is shared)
 * ------------------------------------------------------------------ */

/** (a) 12 s slideshow: four 3 s solid-colour scenes => cuts at 3 s / 6 s / 9 s. */
async function buildSlideshowFixture(tools, directory) {
  const output = join(directory, 'slideshow.mp4')
  const colors = ['0x8a1010', '0x1040c0', '0x1e7a2e', '0xc8a018']
  const args = ['-v', 'error', '-y']
  for (const color of colors) args.push('-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=12:d=3`)
  args.push(
    '-filter_complex',
    '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-r',
    '12',
    output,
  )
  const result = await run(tools.ffmpeg, args, { cwd: directory, timeoutMs: 120_000 })
  assert.equal(result.code, 0, `could not build the slideshow fixture: ${result.stderr.slice(0, 300)}`)
  return output
}

/** (b) 12 s of one flat colour => a completely static clip. */
async function buildStaticFixture(tools, directory) {
  const output = join(directory, 'static.mp4')
  const result = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x203040:s=320x180:r=12:d=12',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', '12',
      output,
    ],
    { cwd: directory, timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `could not build the static fixture: ${result.stderr.slice(0, 300)}`)
  return output
}

/**
 * (c) 12 s of a slowly rotating high-contrast gradient: continuous slow motion
 * with no spikes (a drifting gradient / scrolling-page analogue). `seed` pins
 * the gradient so the fixture is deterministic run to run.
 */
async function buildSlowMotionFixture(tools, directory) {
  const output = join(directory, 'slow-motion.mp4')
  const result = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'gradients=s=320x180:c0=0x101a3b:c1=0xf0d060:r=12:d=12:speed=0.07:seed=1',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', '12',
      output,
    ],
    { cwd: directory, timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `could not build the slow-motion fixture: ${result.stderr.slice(0, 300)}`)
  return output
}

/** Extract one PNG per sampling tick, named `f0001.png` (image2 numbering). */
async function extractPngSequence(tools, file, directory, fps) {
  const framesDir = join(directory, 'frames')
  await mkdir(framesDir, { recursive: true })
  const result = await run(
    tools.ffmpeg,
    ['-v', 'error', '-y', '-i', file, '-vf', `fps=${fps}`, join(framesDir, 'f%04d.png')],
    { cwd: directory, timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `could not extract the PNG sequence: ${result.stderr.slice(0, 300)}`)
  const names = (await readdir(framesDir)).filter((name) => name.endsWith('.png')).sort()
  assert.ok(names.length > 0, 'the extracted PNG sequence is empty')
  return { directory: framesDir, paths: names.map((name) => join(framesDir, name)) }
}

/** Build synthetic per-frame scores for the deterministic selectFrames unit tests. */
function syntheticScores(count, overrides = {}) {
  const scores = new Array(count).fill(0)
  for (const [index, value] of Object.entries(overrides)) scores[Number(index)] = value
  return scores
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

async function main() {
  const root = await makeWorkDir('media-senses-change-test')
  const fixturesDir = join(root, 'fixtures')
  await mkdir(fixturesDir, { recursive: true })
  await mkdir(join(root, 'work'), { recursive: true })
  const tools = await resolveTools()
  const workDir = join(root, 'work')
  const fps = 12

  try {
    const slideshowFile = await buildSlideshowFixture(tools, fixturesDir)
    const staticFile = await buildStaticFixture(tools, fixturesDir)
    const slowMotionFile = await buildSlowMotionFixture(tools, fixturesDir)

    console.log('change-engine test fixtures: slideshow.mp4, static.mp4, slow-motion.mp4 (12 s each)')

    /* ---------- (1) scoreVideo on the slideshow ---------- */
    const scoredSlideshow = await scoreVideo({ tools, file: slideshowFile, workDir })
    const slideshowSelection = selectFrames(scoredSlideshow)

    await check('slideshow: 12 s at fps=12 decodes 144 frames with a valid score result shape', () => {
      assert.equal(scoredSlideshow.fps, fps, `expected ${fps} fps, got ${scoredSlideshow.fps}`)
      assert.equal(scoredSlideshow.frames.length, 144, 'expected 144 sampled frames')
      assertScoreResultShape(scoredSlideshow, 'slideshow')
      // The four scene colours are far apart, so at least one real spike must exist.
      assert.ok(scoredSlideshow.max >= 40, `a hard slideshow cut should score >= 40, got max=${scoredSlideshow.max}`)
      // Most frames are identical scene frames, so the typical score stays tiny.
      assert.ok(scoredSlideshow.mean < 10, `a mostly-static slideshow should have a small mean, got ${scoredSlideshow.mean}`)
    })

    await check('slideshow: 3-4 cuts land within 0.3 s of the true boundaries (3 s / 6 s / 9 s)', () => {
      const { cuts } = slideshowSelection
      assert.ok(cuts.length >= 3 && cuts.length <= 4, `expected 3-4 cuts, got ${JSON.stringify(cuts)}`)
      for (const boundary of SLIDESHOW_BOUNDARIES) {
        const closest = cuts.reduce((best, time) => Math.min(best, Math.abs(time - boundary)), Number.POSITIVE_INFINITY)
        assert.ok(
          closest <= 0.3,
          `true boundary ${boundary}s was not matched within 0.3 s (cuts=${JSON.stringify(cuts)})`,
        )
      }
      printSummary('slideshow.mp4', scoredSlideshow, slideshowSelection)
    })

    await check('slideshow: selected frames are ascending, deduplicated and JSON-safe', () => {
      const times = assertSelectedOrdering(slideshowSelection, fps, 'slideshow')
      assert.ok(times.length >= 3, `expected at least 3 selected frames, got ${times.length}`)
      assert.ok(times.length <= DEFAULT_SELECTION_OPTIONS.maxFrames, 'selection exceeded maxFrames')
      assertJsonSafe({ scored: scoredSlideshow, selection: slideshowSelection }, 'slideshow result')
    })

    await check('CHANGE_WEIGHTS favours hue over saturation over value and is normalised to 255', () => {
      assert.ok(CHANGE_WEIGHTS.hue > CHANGE_WEIGHTS.saturation, 'hue should outweigh saturation')
      assert.ok(CHANGE_WEIGHTS.saturation > CHANGE_WEIGHTS.value, 'saturation should outweigh value')
      assert.ok(CHANGE_WEIGHTS.value > 0 && CHANGE_WEIGHTS.hue <= 1, 'weights should be positive and hue-normalised')
      assert.equal(SCORE_MAX, 255)
    })

    /* ---------- (2) static clip ---------- */
    const scoredStatic = await scoreVideo({ tools, file: staticFile, workDir })
    const staticSelection = selectFrames(scoredStatic)

    await check('static: no cuts, scores all zero, honest warning instead of a throw', () => {
      assertScoreResultShape(scoredStatic, 'static')
      assert.equal(scoredStatic.frames.length, 144)
      assert.equal(scoredStatic.max, 0, 'a completely static clip must score 0 everywhere')
      assert.equal(scoredStatic.mean, 0)
      assert.equal(staticSelection.cuts.length, 0, 'a static clip must not produce cuts')
      assert.ok(scoredStatic.warnings.length >= 1, 'a static clip should carry a warning')
      const fallbackFrames = staticSelection.selected.filter((entry) => entry.reason === 'fallback')
      assert.ok(fallbackFrames.length >= 1, 'a static clip must still yield one fallback frame')
      assert.ok(fallbackFrames.length <= 2, `a static 12 s clip should yield at most 2 fallback frames, got ${fallbackFrames.length}`)
      assert.ok(fallbackFrames[0].time <= 0.5, `the fallback frame should be near the start, got ${fallbackFrames[0].time}`)
      printSummary('static.mp4', scoredStatic, staticSelection)
    })

    /* ---------- (3) slow continuous motion ---------- */
    const scoredSlow = await scoreVideo({ tools, file: slowMotionFile, workDir })
    const slowSelection = selectFrames(scoredSlow)

    await check(`slow motion: ${SLOW_INTEGRATED_MIN}-${SLOW_INTEGRATED_MAX} integrated frames and 0 cuts`, () => {
      assertScoreResultShape(scoredSlow, 'slow-motion')
      assert.equal(scoredSlow.frames.length, 144)
      assert.equal(slowSelection.cuts.length, 0, `slow continuous motion must not spike, got cuts=${JSON.stringify(slowSelection.cuts)}`)
      const integrated = slowSelection.selected.filter((entry) => entry.reason === 'integrated')
      assert.ok(
        integrated.length >= SLOW_INTEGRATED_MIN && integrated.length <= SLOW_INTEGRATED_MAX,
        `expected ${SLOW_INTEGRATED_MIN}-${SLOW_INTEGRATED_MAX} integrated frames, got ${integrated.length}`,
      )
      // Continuous change accumulates but never crosses the absolute cut threshold.
      assert.ok(
        scoredSlow.max < DEFAULT_SELECTION_OPTIONS.cutAbs,
        `slow motion should stay below cutAbs=${DEFAULT_SELECTION_OPTIONS.cutAbs}, got max=${scoredSlow.max}`,
      )
      assertJsonSafe({ scored: scoredSlow, selection: slowSelection }, 'slow-motion result')
      printSummary('slow-motion.mp4', scoredSlow, slowSelection)
    })

    /* ---------- (4) selectFrames unit rules ---------- */
    await check('selectFrames: a spike is a cut only when it also beats its neighbours by cutRatio', () => {
      const scores = syntheticScores(145, { 36: 50, 72: 50, 108: 80 })
      const selection = selectFrames(scores, { fps })
      assert.deepEqual(selection.cuts, [3, 6, 9], `expected cuts at 3/6/9, got ${JSON.stringify(selection.cuts)}`)
      for (const cut of selection.selected.filter((entry) => entry.reason === 'cut')) {
        assert.equal(cut.score, scores[Math.round(cut.time * fps)], 'the cut entry should carry the frame score')
      }
    })

    await check('selectFrames: integration accumulates score and emits per integratePoints x fps x integrateWindowSec', () => {
      // constant 4/frame at 12 fps: 36 frames to reach 4 * 12 * 3 = 144 points.
      const scores = new Array(145).fill(4)
      const selection = selectFrames(scores, { fps })
      const integratedTimes = selection.selected
        .filter((entry) => entry.reason === 'integrated')
        .map((entry) => entry.time)
      assert.deepEqual(integratedTimes, [3, 6, 9, 12], `expected integrated frames at 3/6/9/12 s, got ${JSON.stringify(integratedTimes)}`)
      assert.equal(selection.cuts.length, 0)
    })

    await check('selectFrames: a cut and an integrated frame on the same frame collapse to the cut', () => {
      // 150 points in one spike: both the spike and the integration budget fire on frame 36.
      const scores = syntheticScores(145, { 36: 150 })
      const selection = selectFrames(scores, { fps })
      const atThreeSeconds = selection.selected.filter((entry) => Math.abs(entry.time - 3) < 0.02)
      assert.equal(atThreeSeconds.length, 1, `expected one selection at 3 s, got ${atThreeSeconds.length}`)
      assert.equal(atThreeSeconds[0].reason, 'cut', 'the cut must win over the integrated frame')
    })

    await check('selectFrames: maxFrames keeps cuts over integrated over fallback and drops the oldest integrated', () => {
      // 12 points/frame => 12 integrated frames; cap 4 keeps the 4 newest.
      const scores = new Array(145).fill(12)
      const selection = selectFrames(scores, { fps, maxFrames: 4 })
      assert.equal(selection.selected.length, 4, `expected 4 selected frames, got ${selection.selected.length}`)
      assert.ok(selection.selected.every((entry) => entry.reason === 'integrated'), 'newest integrated frames should fill the cap')
      assert.deepEqual(
        selection.selected.map((entry) => entry.time),
        [9, 10, 11, 12],
        `expected the newest integrated frames 9-12 s, got ${JSON.stringify(selection.selected.map((entry) => entry.time))}`,
      )
      assert.ok(
        selection.warnings.some((warning) => /oldest integrated/u.test(warning)),
        `expected an "oldest integrated" warning, got ${JSON.stringify(selection.warnings)}`,
      )
    })

    await check('selectFrames: a static score series yields exactly one fallback frame and a warning', () => {
      const selection = selectFrames(new Array(145).fill(0), { fps })
      assert.equal(selection.selected.length, 1, `expected one frame, got ${JSON.stringify(selection.selected)}`)
      assert.equal(selection.selected[0].reason, 'fallback')
      assert.ok(selection.warnings.some((warning) => /static/u.test(warning)), 'a static series should warn')
    })

    await check('selectFrames accepts the scoreVideo result object and a bare number array equivalently', () => {
      const fromObject = selectFrames(scoredSlideshow)
      const fromNumbers = selectFrames(scoredSlideshow.frames.map((frame) => frame.score), { fps: scoredSlideshow.fps })
      assert.deepEqual(fromNumbers.selected, fromObject.selected, 'both input forms should select the same frames')
      assert.deepEqual(fromNumbers.cuts, slideshowSelection.cuts, 'the cuts list should match too')
    })

    /* ---------- (5) scoreSequence ---------- */
    const sequence = await extractPngSequence(tools, slideshowFile, root, fps)
    const scoredSequence = await scoreSequence({ tools, frames: sequence.paths, workDir, fps })
    const sequenceSelection = selectFrames(scoredSequence)

    await check('scoreSequence: a PNG sequence gives the same cuts as scoreVideo (±1 frame)', () => {
      assertScoreResultShape(scoredSequence, 'sequence')
      assert.equal(scoredSequence.frames.length, 144, 'expected 144 sequence frames')
      assert.equal(scoredSequence.fps, fps)
      assert.equal(sequenceSelection.cuts.length, slideshowSelection.cuts.length, 'cut counts differ between video and sequence')
      for (let index = 0; index < sequenceSelection.cuts.length; index += 1) {
        const difference = Math.abs(sequenceSelection.cuts[index] - slideshowSelection.cuts[index])
        assert.ok(difference <= 1 / fps + 0.02, `sequence cut ${sequenceSelection.cuts[index]} deviates ${difference}s from the video cut ${slideshowSelection.cuts[index]}`)
      }
      assertJsonSafe({ scored: scoredSequence, selection: sequenceSelection }, 'sequence result')
      printSummary('slideshow PNG sequence', scoredSequence, sequenceSelection)
    })

    await check('scoreSequence: a non-%04d file list goes through the concat fallback with identical scores', async () => {
      // Use frames 30..53 (crossing the 3 s scene boundary) so alignment matters.
      const sourcePaths = sequence.paths.slice(30, 54)
      const oddDir = join(root, 'odd-names')
      await mkdir(oddDir, { recursive: true })
      const oddPaths = []
      for (let index = 0; index < sourcePaths.length; index += 1) {
        const target = join(oddDir, `page-${String(index * 7).padStart(3, '0')}-capture.png`)
        await copyFile(sourcePaths[index], target)
        oddPaths.push(target)
      }
      const oddScored = await scoreSequence({ tools, frames: oddPaths, workDir, fps })
      assert.equal(oddScored.frames.length, sourcePaths.length, 'the concat fallback should decode exactly one frame per image')
      const patternSlice = await scoreSequence({ tools, frames: sourcePaths, workDir, fps })
      assert.equal(patternSlice.frames.length, sourcePaths.length)
      const maxDifference = Math.max(
        ...oddScored.frames.map((frame, index) => Math.abs(frame.score - patternSlice.frames[index].score)),
      )
      assert.ok(maxDifference <= 0.1, `concat fallback scores differ from the image2 pattern by ${maxDifference}`)
      const oddCuts = selectFrames(oddScored).cuts
      const patternCuts = selectFrames(patternSlice).cuts
      assert.deepEqual(oddCuts, patternCuts, `concat fallback cuts ${JSON.stringify(oddCuts)} differ from pattern cuts ${JSON.stringify(patternCuts)}`)
      assert.ok(oddCuts.length >= 1, 'frames 30-53 cross a scene boundary and should contain one cut')
    })

    /* ---------- (6) robustness ---------- */
    await check('unreadable input throws a clear error', async () => {
      await assert.rejects(
        () => scoreVideo({ tools, file: join(fixturesDir, 'does-not-exist.mp4'), workDir }),
        /cannot read input video/u,
      )
    })

    await check('a very short clip returns warnings instead of throwing', async () => {
      const scored = await scoreVideo({ tools, file: staticFile, workDir, options: { duration: 0.2 } })
      assertScoreResultShape(scored, 'very-short')
      assert.ok(scored.frames.length >= 1, 'a 0.2 s clip should still decode at least one frame')
      assert.ok(scored.frames.length <= 3, `a 0.2 s clip at 12 fps should decode at most 3 frames, got ${scored.frames.length}`)
      assert.ok(scored.warnings.length >= 1, 'a very short clip should carry a warning')
      assertJsonSafe(scored, 'very-short result')
    })

    await check('an abort signal rejects with AbortError (pre-aborted and mid-flight)', async () => {
      const preAborted = new AbortController()
      preAborted.abort()
      const start = Date.now()
      await assert.rejects(
        () => scoreVideo({ tools, file: slideshowFile, workDir, signal: preAborted.signal }),
        (error) => error instanceof Error && error.name === 'AbortError',
        'a pre-aborted signal should reject with AbortError',
      )
      const preAbortMs = Date.now() - start
      assert.ok(preAbortMs < 1000, `a pre-aborted signal should reject immediately (${preAbortMs} ms)`)

      const midFlight = new AbortController()
      setTimeout(() => midFlight.abort(), 5)
      await assert.rejects(
        () => scoreVideo({ tools, file: slideshowFile, workDir, signal: midFlight.signal }),
        (error) => error instanceof Error && error.name === 'AbortError',
        'a mid-flight abort should reject with AbortError',
      )
    })

    await check('the maxFrames budget lowers the sampling rate for long input', async () => {
      const scored = await scoreVideo({ tools, file: slideshowFile, workDir, options: { duration: 12, maxFrames: 60 } })
      assert.equal(scored.fps, 5, `60 frames over 12 s should sample at 5 fps, got ${scored.fps}`)
      assert.equal(scored.frames.length, 60, 'the frame budget should cap the decoded frames')
      assert.ok(
        scored.warnings.some((warning) => /frame budget|maxFrames/u.test(warning)),
        `expected a budget warning, got ${JSON.stringify(scored.warnings)}`,
      )
      assertJsonSafe(scored, 'budget result')
    })

    /* ---------- (7) runtime ---------- */
    await check('runtime: scoreVideo on a 12 s clip at fps=12 finishes in under 3 s', async () => {
      const started = performance.now()
      const scored = await scoreVideo({ tools, file: slideshowFile, workDir })
      const elapsedMs = performance.now() - started
      assert.equal(scored.frames.length, 144)
      assert.ok(elapsedMs < RUNTIME_BUDGET_MS, `scoreVideo took ${Math.round(elapsedMs)} ms (budget ${RUNTIME_BUDGET_MS} ms)`)
      console.log(`      measured runtime: ${Math.round(elapsedMs)} ms for 144 frames (${(elapsedMs / 144).toFixed(2)} ms/frame incl. ffmpeg)`)
    })
  } finally {
    await removeWorkDir(root)
  }

  console.log('')
  console.log(`change-engine: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

await main()
