#!/usr/bin/env node
/**
 * media-senses — case-based aesthetic rule tests.
 *
 * The point of turning 27 written rules into an auditor is that each one becomes
 * addressable as `R4 ✗(frames 302, 480)` instead of "the rhythm feels off". These
 * checks therefore pin, for every machine-checkable rule, both directions: the
 * input that must pass and the input that must fail. A rule that only ever passes
 * is worse than no rule, because it launders a subjective opinion as a measurement.
 *
 * The other 16 rules must report `skip` with a reason — a skipped rule must never
 * be counted as a pass, or the pass ratio becomes a lie.
 *
 * Run from `media-senses/`:  node test/aesthetic.test.mjs
 */
import assert from 'node:assert/strict'
import { auditAesthetic, AESTHETIC_RULES, AESTHETIC_RULES_BY_ID, CHECKABLE_RULE_COUNT, getAestheticRule } from '../lib/aesthetic.js'

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

/** A production that passes every rule it can be given data for. */
function baseline() {
  return {
    shots: [
      { id: 's1', durationSeconds: 4, startFrame: 0, endFrame: 120, isBrandMark: true, hasHoldSeconds: 1.2, glintCount: 1 },
      { id: 's2', durationSeconds: 3, startFrame: 120, endFrame: 210, glintCount: 0 },
    ],
    timeline: {
      cuts: [
        { fromFrame: 0, toFrame: 120, techniqueId: 'a', isProtagonist: true },
        { fromFrame: 120, toFrame: 210, techniqueId: 'b' },
      ],
      totalSeconds: 7,
    },
    effects: { fullFrameImpactCount: 2, glintSweepCount: 1 },
    captions: [{ start: 0, end: 7 }],
    audio: { sfxAnchors: [{ designedFrame: 30 }], bpm: 120, beatSeconds: 0.5 },
    frames: [
      { index: 0, timeSeconds: 0, motionLevel: 0, texts: [{ text: '标题', effectivePx: 60, frameHeight: 1080 }] },
      { index: 1, timeSeconds: 1, motionLevel: 10, texts: [] },
      { index: 2, timeSeconds: 2, motionLevel: 20, texts: [] },
      { index: 3, timeSeconds: 3, motionLevel: 30, texts: [] },
      { index: 4, timeSeconds: 4, motionLevel: 40, texts: [] },
      { index: 5, timeSeconds: 5, motionLevel: 50, texts: [] },
      { index: 6, timeSeconds: 6, motionLevel: 60, texts: [] },
      { index: 7, timeSeconds: 7, motionLevel: 0, texts: [] },
    ],
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value))
const verdictOf = (input, id) => auditAesthetic(input).rows.find((row) => row.id === id)?.verdict

/* ------------------------------------------------------------------ *
 * Rule table
 * ------------------------------------------------------------------ */

check('the rule table carries all 27 rules with unique ids', () => {
  assert.equal(AESTHETIC_RULES.length, 27)
  const ids = AESTHETIC_RULES.map((rule) => rule.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate rule id')
  const families = new Set(AESTHETIC_RULES.map((rule) => rule.family))
  assert.deepEqual([...families].sort(), ['C', 'P', 'Q', 'R', 'S'])
})

check('exactly 11 rules are machine-checkable', () => {
  assert.equal(CHECKABLE_RULE_COUNT, 11)
  assert.equal(AESTHETIC_RULES.filter((rule) => rule.checkable).length, 11)
})

check('every rule explains itself and its case', () => {
  for (const rule of AESTHETIC_RULES) {
    assert.ok(typeof rule.zh === 'string' && rule.zh.length > 8, `${rule.id} needs a rule sentence`)
    assert.ok(typeof rule.whyZh === 'string' && rule.whyZh.length > 10, `${rule.id} needs a why`)
    assert.ok(typeof rule.caseZh === 'string' && rule.caseZh.length > 5, `${rule.id} needs a case reference`)
    assert.ok(typeof rule.selfCheckZh === 'string' && rule.selfCheckZh.length > 5, `${rule.id} needs a self-check question`)
  }
})

check('getAestheticRule looks up by id and refuses unknown ids', () => {
  assert.equal(getAestheticRule('R4').family, 'R')
  assert.equal(getAestheticRule('nope'), null)
  assert.equal(getAestheticRule(42), null)
  assert.equal(AESTHETIC_RULES_BY_ID.R1.id, 'R1')
})

/* ------------------------------------------------------------------ *
 * R — rhythm
 * ------------------------------------------------------------------ */

check('R1 fails a brand mark that does not hold a second', () => {
  assert.equal(verdictOf(baseline(), 'R1'), 'pass')
  const broken = baseline()
  broken.shots[0].hasHoldSeconds = 0.2
  assert.equal(verdictOf(broken, 'R1'), 'fail')
  // A hold that is long enough but on an ordinary card is not a failure — but a
  // production with no brand mark at all has nothing for this rule to judge, so it
  // must skip rather than quietly pass.
  const ordinary = baseline()
  ordinary.shots[0].isBrandMark = false
  ordinary.shots[0].hasHoldSeconds = 0
  assert.equal(verdictOf(ordinary, 'R1'), 'skip')
})

check('R2 fails a wall of identical motion and passes accelerating motion', () => {
  const flat = baseline()
  for (const frame of flat.frames) frame.motionLevel = 10
  assert.equal(verdictOf(flat, 'R2'), 'fail')
  // The baseline ramps 0 → 60, which is acceleration, so it never fails.
  assert.notEqual(verdictOf(baseline(), 'R2'), 'fail')
})

check('R3 fails an opening action arc shorter than three seconds', () => {
  const short = {
    shots: [{ id: 's1', durationSeconds: 1.5, startFrame: 0, endFrame: 45 }],
    timeline: { cuts: [{ fromFrame: 0, toFrame: 45, techniqueId: 'a' }] },
  }
  assert.equal(verdictOf(short, 'R3'), 'fail')
  assert.equal(verdictOf(baseline(), 'R3'), 'pass')
})

check('R4 fails more than three full-frame impacts', () => {
  assert.equal(verdictOf(baseline(), 'R4'), 'pass')
  const broken = baseline()
  broken.effects.fullFrameImpactCount = 5
  assert.equal(verdictOf(broken, 'R4'), 'fail')
  // Exactly three is the ceiling, not a violation.
  const atLimit = baseline()
  atLimit.effects.fullFrameImpactCount = 3
  assert.equal(verdictOf(atLimit, 'R4'), 'pass')
})

/* ------------------------------------------------------------------ *
 * Q — texture, camera, composition
 * ------------------------------------------------------------------ */

check('Q4 fails a per-shot glint sweep that repeats', () => {
  const broken = baseline()
  broken.shots[0].glintCount = 3
  assert.equal(verdictOf(broken, 'Q4'), 'fail')
  assert.equal(verdictOf(baseline(), 'Q4'), 'pass')
})

check('Q11 fails text that is too small to read', () => {
  const broken = baseline()
  broken.frames[0].texts[0].effectivePx = 20
  const row = auditAesthetic(broken).rows.find((entry) => entry.id === 'Q11')
  assert.equal(row.verdict, 'fail')
  assert.ok(row.evidenceZh.includes('56'), 'the evidence must name the threshold')
  assert.equal(verdictOf(baseline(), 'Q11'), 'pass')
})

/* ------------------------------------------------------------------ *
 * C — copy
 * ------------------------------------------------------------------ */

check('C1 passes when narration covers the gap and skips without it', () => {
  assert.equal(verdictOf(baseline(), 'C1'), 'pass')
  const noCaptions = baseline()
  delete noCaptions.captions
  // Skipping is the honest answer: the data to judge it is absent, not empty.
  assert.equal(verdictOf(noCaptions, 'C1'), 'skip')
})

/* ------------------------------------------------------------------ *
 * P — process
 * ------------------------------------------------------------------ */

check('P1 skips before a render and fails when a shot has no frame evidence', () => {
  const noFrames = baseline()
  delete noFrames.frames
  assert.equal(verdictOf(noFrames, 'P1'), 'skip')
  // With frames present but one shot uncovered, it is a real failure with evidence.
  const partial = baseline()
  partial.frames = partial.frames.slice(0, 4)
  const row = auditAesthetic(partial).rows.find((entry) => entry.id === 'P1')
  assert.equal(row.verdict, 'fail')
  assert.ok(Array.isArray(row.frames) && row.frames.length > 0, 'a failure must carry frame evidence')
})

check('P4 fails the same technique used as the protagonist twice', () => {
  assert.equal(verdictOf(baseline(), 'P4'), 'pass')
  const broken = baseline()
  broken.timeline.cuts[1].techniqueId = 'a'
  broken.timeline.cuts[1].isProtagonist = true
  assert.equal(verdictOf(broken, 'P4'), 'fail')
})

/* ------------------------------------------------------------------ *
 * S — sound (only measurable after a render)
 * ------------------------------------------------------------------ */

check('S2 and S5 skip until the post-render measurements exist', () => {
  // Pre-render there is no measured peak and no measured pipeline offset, so both
  // rules must skip rather than fail a correct plan.
  assert.equal(verdictOf(baseline(), 'S2'), 'skip')
  assert.equal(verdictOf(baseline(), 'S5'), 'skip')
})

/* ------------------------------------------------------------------ *
 * Aggregate behaviour
 * ------------------------------------------------------------------ */

check('a skipped rule is never counted as a pass', () => {
  // No checkable data at all: the ratio must be absent, not zero — a 0 would read
  // as "every check failed", which is a different and much worse statement.
  const report = auditAesthetic({ shots: [{ id: 's1' }] })
  assert.equal(report.checked, 0)
  assert.equal(report.passRatio, null)
  assert.equal(report.skipped, 27)
  assert.equal(report.failures, 0)
  // On any report, `checked` must equal the rows that produced a verdict.
  const full = auditAesthetic(baseline())
  assert.equal(full.checked, full.rows.filter((row) => row.verdict !== 'skip').length)
})

check('the aggregate counts match the rows', () => {
  const broken = baseline()
  broken.effects.fullFrameImpactCount = 5
  broken.frames[0].texts[0].effectivePx = 20
  const report = auditAesthetic(broken)
  const fails = report.rows.filter((row) => row.verdict === 'fail').length
  const warns = report.rows.filter((row) => row.verdict === 'warn').length
  const skips = report.rows.filter((row) => row.verdict === 'skip').length
  assert.equal(report.failures, fails)
  assert.equal(report.warnings, warns)
  assert.equal(report.skipped, skips)
  assert.equal(report.rows.length, 27)
  assert.ok(typeof report.summaryZh === 'string' && report.summaryZh.length > 10)
})

check('the audit is deterministic and JSON-safe', () => {
  const a = auditAesthetic(baseline())
  const b = auditAesthetic(baseline())
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  for (const row of a.rows) {
    for (const frame of row.frames ?? []) assert.ok(Number.isFinite(frame))
  }
})

check('a non-object input is rejected loudly', () => {
  assert.throws(() => auditAesthetic(null), /auditAesthetic/u)
  assert.throws(() => auditAesthetic([]), /auditAesthetic/u)
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
