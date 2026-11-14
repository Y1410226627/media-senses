#!/usr/bin/env node
/**
 * Acceptance tests for the M4+M5 assets:
 *   lib/shots.js  — shot recipe cards (searchable, executable)
 *   lib/lint.js   — pre-render layout lint (RenderPlan + animation source)
 *   lib/rubric.js — 7-dimension scoring rubric with mandatory evidence
 *
 * Run: node test/shots-lint.test.mjs
 *
 * Pure data / pure-function tests: no ffmpeg, no temp files, no network. Prints
 * PASS/FAIL per assertion and exits non-zero when anything fails.
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_COLOR_STROKES_PER_SECOND,
  DEFAULT_SKETCH_STROKES_PER_SECOND,
  GENRE_DURATION_RANGES,
  SHOT_CARDS,
  SHOT_CATEGORIES,
  durationBudget,
  findShots,
  getShot,
  renderShotCard,
} from '../lib/shots.js'
import {
  CAPTION_MARGIN_SHARE,
  MIN_ANIMATION_FONT_SHARE,
  MIN_FONT_HEIGHT_SHARE,
  TEXT_MAX_HEIGHT_SHARE,
  TEXT_MAX_WIDTH_SHARE,
  estimateLineWidthPx,
  lintAnimationSource,
  lintPlan,
  summariseLint,
} from '../lib/lint.js'
import {
  ANCHOR_LADDER_ZH,
  RUBRIC,
  RUBRIC_MAX_SCORE,
  hasTimeReference,
  renderRubricTemplate,
  scoreReport,
} from '../lib/rubric.js'

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

/** Assert a value survives a JSON round-trip unchanged (no NaN/Infinity/undefined). */
function assertJsonSafe(value, label) {
  const roundTripped = JSON.parse(JSON.stringify(value))
  assert.deepEqual(roundTripped, value, `${label} does not survive a JSON round-trip unchanged`)
}

const ENERGY_VALUES = new Set(['low', 'medium', 'high'])
const CARD_STRING_FIELDS = ['id', 'category', 'nameZh', 'oneLineZh', 'useWhenZh', 'intentZh', 'motionZh', 'soundZh', 'pitfallsZh']
const CARD_CATEGORY_IDS = [
  'opening-brand',
  'camera',
  'transitions',
  'typography',
  'ui-entrance',
  'interaction',
  'data',
  'light-emphasis',
  'rhythm',
  'outro',
]

/** A RenderPlan that should lint cleanly at 1080x1920. */
function cleanPlan() {
  return {
    output: 'D:/tmp/clean.mp4',
    width: 1080,
    height: 1920,
    fps: 30,
    background: '#101018',
    loudnessTarget: -16,
    scenes: [
      {
        type: 'text',
        duration: 2,
        text: '仿制视频',
        subtitle: 'REPRODUCED',
        font: 'msyhbd',
        fontSize: 96,
        color: '#ffffff',
        background: '#120c2b',
        align: 'center',
        animation: 'fade',
      },
      { type: 'gradient', duration: 1.5, gradient: ['#120c2b', '#2b1a4a'], angle: 45 },
      { type: 'color', duration: 1, background: '#000000', transitionIn: 'fade', transitionDuration: 0.4 },
    ],
    captions: [{ start: 0.4, end: 1.8, text: '这是字幕', position: 'bottom', fontSize: 64 }],
  }
}

/** Valid 7-dimension rubric entries. */
function validRubricEntries() {
  const scores = [5, 6, 7, 8, 9, 10, 7]
  return RUBRIC.map((dimension, index) => ({
    dimension: dimension.id,
    score: scores[index],
    evidence: `00:0${index + 1}.2 这一段的画面/节奏有问题`,
    fix: '把淡入从 1.5s 改成 0.4s，字号从 72 调到 96',
  }))
}

async function main() {
  /* ---------------------------------------------------- shot card library */

  await check('shots: SHOT_CATEGORIES has the ten required categories in order', () => {
    assert.equal(SHOT_CATEGORIES.length, 10)
    assert.deepEqual(
      SHOT_CATEGORIES.map((category) => category.id),
      CARD_CATEGORY_IDS,
    )
    for (const category of SHOT_CATEGORIES) {
      assert.equal(typeof category.nameZh, 'string')
      assert.ok(category.nameZh.length > 0)
      assert.equal(typeof category.oneLineZh, 'string')
      assert.ok(category.oneLineZh.length > 0)
    }
  })

  await check('shots: SHOT_CARDS has at least 40 cards with unique ids', () => {
    assert.ok(SHOT_CARDS.length >= 40, `only ${SHOT_CARDS.length} cards`)
    const ids = SHOT_CARDS.map((card) => card.id)
    assert.equal(new Set(ids).size, ids.length, 'duplicate card ids found')
  })

  await check('shots: every category has at least 3 cards', () => {
    const counts = new Map()
    for (const card of SHOT_CARDS) counts.set(card.category, (counts.get(card.category) ?? 0) + 1)
    for (const categoryId of CARD_CATEGORY_IDS) {
      assert.ok((counts.get(categoryId) ?? 0) >= 3, `category ${categoryId} has only ${counts.get(categoryId) ?? 0} cards`)
    }
  })

  await check('shots: every card has the full schema with the right types', () => {
    for (const card of SHOT_CARDS) {
      for (const field of CARD_STRING_FIELDS) {
        assert.equal(typeof card[field], 'string', `${card.id}.${field} is not a string`)
        assert.ok(card[field].trim().length > 0, `${card.id}.${field} is empty`)
      }
      assert.ok(CARD_CATEGORY_IDS.includes(card.category), `${card.id} has unknown category ${card.category}`)
      assert.ok(ENERGY_VALUES.has(card.energy), `${card.id} has unknown energy ${card.energy}`)
      assert.ok(Array.isArray(card.seconds) && card.seconds.length === 2, `${card.id}.seconds is not [min,max]`)
      const [min, max] = card.seconds
      assert.ok(Number.isFinite(min) && Number.isFinite(max) && min >= 0 && min < max, `${card.id}.seconds is invalid`)
      assert.ok(Array.isArray(card.tags) && card.tags.length >= 2, `${card.id}.tags needs >= 2 tags`)
      for (const tag of card.tags) assert.ok(typeof tag === 'string' && tag.trim().length > 0)
      assert.ok(Array.isArray(card.params) && card.params.length >= 1, `${card.id}.params is empty`)
    }
  })

  await check('shots: every params row has three non-empty columns and a feelZh that is not the number again', () => {
    const DIRECTIONAL = /[再调越更加减提降低高大小长短快慢多少轻重缓急疏密亮暗深浅偏太]/u
    for (const card of SHOT_CARDS) {
      for (const param of card.params) {
        assert.equal(typeof param.name, 'string', `${card.id} param.name missing`)
        assert.equal(typeof param.typical, 'string', `${card.id} param.typical missing`)
        assert.equal(typeof param.feelZh, 'string', `${card.id}.${param.name} param.feelZh missing`)
        assert.ok(param.name.trim().length > 0)
        assert.ok(param.typical.trim().length > 0)
        assert.ok(param.feelZh.trim().length >= 10, `${card.id}.${param.name} feelZh is too short to explain a direction`)
        assert.notEqual(param.feelZh.trim(), param.typical.trim(), `${card.id}.${param.name} feelZh just repeats typical`)
        assert.ok(
          DIRECTIONAL.test(param.feelZh),
          `${card.id}.${param.name} feelZh does not say which way to turn the knob: ${param.feelZh}`,
        )
        assert.ok(!/^[\d.]+/u.test(param.feelZh.trim()), `${card.id}.${param.name} feelZh starts with a number`)
      }
    }
  })

  await check('shots: every card ships at least one runnable recipe (css/canvas/ffmpeg)', () => {
    for (const card of SHOT_CARDS) {
      assert.equal(typeof card.recipe, 'object', `${card.id}.recipe missing`)
      const keys = ['css', 'canvas', 'ffmpeg'].filter(
        (key) => typeof card.recipe[key] === 'string' && card.recipe[key].trim().length > 0,
      )
      assert.ok(keys.length >= 1, `${card.id} has no recipe body`)
    }
  })

  const pushIn = getShot('camera.push-in')
  await check('shots: getShot resolves exact ids (case-insensitive) and returns null otherwise', () => {
    assert.ok(pushIn !== null && pushIn.id === 'camera.push-in')
    assert.equal(getShot('CAMERA.PUSH-IN'), pushIn)
    assert.equal(getShot('camera.does-not-exist'), null)
    assert.equal(getShot(''), null)
    assert.equal(getShot(null), null)
  })

  await check('shots: findShots hits the expected card for Chinese and English queries', () => {
    assert.equal(findShots('推镜')[0]?.id, 'camera.push-in')
    assert.equal(findShots('stagger')[0]?.id, 'ui-entrance.stagger-list')
    assert.equal(findShots('卡点')[0]?.id, 'rhythm.beat-cut')
    assert.ok(findShots('无此关键词xyz').length === 0)
  })

  await check('shots: findShots honors category/energy filters and the limit', () => {
    const cameraCards = findShots('', { category: 'camera', limit: 50 })
    assert.ok(cameraCards.length >= 3)
    for (const card of cameraCards) assert.equal(card.category, 'camera')

    const highEnergy = findShots('', { energy: 'high', limit: 50 })
    assert.ok(highEnergy.length > 0)
    for (const card of highEnergy) assert.equal(card.energy, 'high')

    const limited = findShots('', { limit: 5 })
    assert.equal(limited.length, 5)
    const defaultLimit = findShots('')
    assert.ok(defaultLimit.length <= 8)
  })

  await check('shots: renderShotCard emits a Markdown card with the feelZh table and recipe', () => {
    const markdown = renderShotCard(pushIn)
    assert.ok(markdown.startsWith('## '), 'card should start with a level-2 heading')
    assert.ok(markdown.includes('缓推建立注视'))
    assert.ok(markdown.includes('往哪调会怎样'))
    assert.ok(markdown.includes('再大就会变成明显的推镜'), 'feelZh text missing from Markdown')
    assert.ok(markdown.includes('```css') && markdown.includes('```ffmpeg'))
    assert.ok(markdown.includes('camera.push-in'))
    assert.throws(() => renderShotCard(null))
  })

  /* ------------------------------------------------------- duration budget */

  await check('durationBudget: default rates match the whiteboard model (3.9 / 6 strokes per second)', () => {
    assert.equal(DEFAULT_SKETCH_STROKES_PER_SECOND, 3.9)
    assert.equal(DEFAULT_COLOR_STROKES_PER_SECOND, 6)
    const budget = durationBudget({ seconds: 20 })
    assert.equal(budget.strokesPerSecond, 3.9)
    assert.equal(budget.colorStrokesPerSecond, 6)
    assert.equal(budget.maxStrokes, 78)
    assert.equal(budget.maxColorStrokes, 120)
  })

  await check('durationBudget: float floor does not lose a stroke (10s * 3.9 = 39, not 38)', () => {
    assert.equal(durationBudget({ seconds: 10 }).maxStrokes, 39)
    assert.equal(durationBudget({ seconds: 5, strokesPerSecond: 3.9 }).maxStrokes, 19)
    assert.equal(durationBudget({ seconds: 20, strokesPerSecond: 5 }).maxStrokes, 100)
  })

  await check('durationBudget: genre boundaries (bumper 3–10s) behave on both sides', () => {
    assert.deepEqual(GENRE_DURATION_RANGES.bumper, [3, 10])
    assert.deepEqual(GENRE_DURATION_RANGES.explainer, [30, 120])

    const tooLong = durationBudget({ seconds: 20, kind: 'bumper' })
    assert.deepEqual(tooLong.genreRange, { min: 3, max: 10 })
    assert.equal(tooLong.withinGenreRange, false)
    assert.equal(tooLong.recommendedSeconds, 10)
    assert.ok(tooLong.adviceZh.includes('偏长'))

    const inRange = durationBudget({ seconds: 8, kind: 'bumper' })
    assert.equal(inRange.withinGenreRange, true)
    assert.equal(inRange.recommendedSeconds, 8)

    const tooShort = durationBudget({ seconds: 1, kind: 'opener' })
    assert.equal(tooShort.withinGenreRange, false)
    assert.equal(tooShort.recommendedSeconds, 15)
    assert.ok(tooShort.adviceZh.includes('偏短'))
  })

  await check('durationBudget: missing seconds returns the genre midpoint and no stroke count', () => {
    const budget = durationBudget({ kind: 'explainer' })
    assert.equal(budget.seconds, null)
    assert.equal(budget.maxStrokes, null)
    assert.equal(budget.recommendedSeconds, 75)
    assert.equal(budget.withinGenreRange, null)
  })

  await check('durationBudget: unknown kind / invalid seconds degrade with warnings', () => {
    const unknown = durationBudget({ seconds: 12, kind: 'podcast' })
    assert.equal(unknown.genreRange, null)
    assert.equal(unknown.recommendedSeconds, 12)
    assert.ok(unknown.warnings.some((warning) => warning.includes('未知体裁')))

    const invalid = durationBudget({ seconds: -3, kind: 'bumper' })
    assert.equal(invalid.seconds, null)
    assert.equal(invalid.maxStrokes, null)
    assert.ok(invalid.warnings.length > 0)
    assertJsonSafe(unknown, 'durationBudget')
  })

  /* ------------------------------------------------------------- lintPlan */

  await check('lintPlan: a clean plan produces no violations and stable JSON', () => {
    const violations = lintPlan(cleanPlan())
    assert.deepEqual(violations, [])
    assertJsonSafe(violations, 'lintPlan([])')
  })

  await check('lintPlan: empty/non-object plan -> emptyPlan error', () => {
    const empty = lintPlan({ output: 'x.mp4', scenes: [] })
    assert.equal(empty.length, 1)
    assert.equal(empty[0].code, 'emptyPlan')
    assert.equal(empty[0].severity, 'error')
    const nullPlan = lintPlan(null)
    assert.equal(nullPlan[0].code, 'emptyPlan')
  })

  await check('lintPlan: duration 0 -> badDuration error with the scene index', () => {
    const plan = cleanPlan()
    plan.scenes = [{ type: 'color', duration: 0 }]
    const violations = lintPlan(plan)
    const bad = violations.find((item) => item.code === 'badDuration')
    assert.ok(bad !== undefined, 'badDuration not reported')
    assert.equal(bad.severity, 'error')
    assert.equal(bad.scene, 0)
    assert.equal(bad.where, 'scenes[0].duration')
  })

  await check('lintPlan: tiny fontSize -> tooSmall warn with a suggested minimum', () => {
    const plan = cleanPlan()
    plan.scenes = [{ type: 'text', duration: 2, text: '你好', fontSize: 20 }]
    const violations = lintPlan(plan)
    const small = violations.find((item) => item.code === 'tooSmall')
    assert.ok(small !== undefined, 'tooSmall not reported')
    assert.equal(small.severity, 'warn')
    assert.ok(/20px/u.test(small.messageZh), `message should quote the size: ${small.messageZh}`)
    assert.ok(/fontSize/u.test(small.messageZh))
  })

  await check('lintPlan: over-wide Chinese title -> textWidthOverflow error with a number fix', () => {
    const plan = cleanPlan()
    plan.scenes = [{ type: 'text', duration: 2, text: '这是一个非常非常长的标题文字用来测试宽度溢出', fontSize: 96 }]
    const violations = lintPlan(plan)
    const wide = violations.find((item) => item.code === 'textWidthOverflow')
    assert.ok(wide !== undefined, 'textWidthOverflow not reported')
    assert.equal(wide.severity, 'error')
    assert.ok(wide.messageZh.includes('0.86'), `message should cite the 0.86 rule: ${wide.messageZh}`)
    assert.ok(/降到 ≤ \d+/u.test(wide.messageZh), `message should suggest a numeric font size: ${wide.messageZh}`)
  })

  await check('lintPlan: too many lines -> textHeightOverflow error', () => {
    const plan = cleanPlan()
    plan.scenes = [{ type: 'text', duration: 2, text: Array(12).fill('很长的一行标题').join('\n'), fontSize: 150 }]
    const violations = lintPlan(plan)
    assert.ok(violations.some((item) => item.code === 'textHeightOverflow'), 'textHeightOverflow not reported')
    assert.ok(violations.some((item) => item.code === 'textWidthOverflow'), 'long lines should also overflow in width')
  })

  await check('lintPlan: text/caption overlapping in time and space -> overlap warn', () => {
    const plan = cleanPlan()
    plan.scenes = [{ type: 'text', duration: 3, text: '标题', fontSize: 160 }]
    plan.captions = [{ start: 1, end: 2, text: '字幕', position: 'center', fontSize: 64 }]
    const violations = lintPlan(plan)
    const overlap = violations.find((item) => item.code === 'overlap')
    assert.ok(overlap !== undefined, `overlap not reported: ${violations.map((item) => item.code).join(',')}`)
    assert.equal(overlap.severity, 'warn')
    assert.equal(overlap.scene, 0)
    assert.equal(overlap.where, 'captions[0]')
  })

  await check('lintPlan: caption outside the scene time OR outside its y-band -> no overlap', () => {
    const plan = cleanPlan()
    plan.scenes = [{ type: 'text', duration: 3, text: '标题', fontSize: 96 }]
    // Bottom caption with centred title is not vertically intersecting.
    plan.captions = [{ start: 1, end: 2, text: '字幕', position: 'bottom', fontSize: 64 }]
    assert.ok(!lintPlan(plan).some((item) => item.code === 'overlap'), 'bottom caption should not overlap a centred title')
    // Same caption but after the scene window.
    plan.captions = [{ start: 4, end: 5, text: '字幕', position: 'center', fontSize: 64 }]
    assert.ok(!lintPlan(plan).some((item) => item.code === 'overlap'), 'caption after the scene should not overlap')
  })

  await check('lintPlan: caption with an invalid window and a tiny caption are both reported', () => {
    const plan = cleanPlan()
    plan.captions = [
      { start: 2, end: 1, text: '倒着的时间', position: 'bottom', fontSize: 64 },
      { start: 0.5, end: 1.5, text: '小字幕', position: 'bottom', fontSize: 12 },
    ]
    const violations = lintPlan(plan)
    const badDuration = violations.find((item) => item.code === 'badDuration')
    assert.ok(badDuration !== undefined, 'caption badDuration not reported')
    assert.equal(badDuration.severity, 'warn')
    assert.equal(badDuration.where, 'captions[0].start')
    assert.ok(violations.some((item) => item.code === 'tooSmall' && item.where === 'captions[1].fontSize'))
  })

  await check('lintPlan: idempotent (same input twice -> identical output) and summarisable', () => {
    const plan = cleanPlan()
    plan.scenes = [
      { type: 'text', duration: 2, text: '这是一个非常非常长的标题文字用来测试宽度溢出', fontSize: 96 },
      { type: 'text', duration: 2, text: '你好', fontSize: 20 },
    ]
    const first = lintPlan(plan)
    const second = lintPlan(plan)
    assert.deepEqual(second, first)
    assert.equal(JSON.stringify(second), JSON.stringify(first))
    assertJsonSafe(first, 'lintPlan')
    const summary = summariseLint(first)
    assert.equal(summary.errors + summary.warnings, first.length)
    assert.equal(summary.ok, summary.errors === 0)
    assert.ok(summary.codes.includes('textWidthOverflow'))
    assert.ok(summary.codes.includes('tooSmall'))
  })

  await check('lintPlan: constants and the width estimate match the contract', () => {
    assert.equal(TEXT_MAX_WIDTH_SHARE, 0.86)
    assert.equal(TEXT_MAX_HEIGHT_SHARE, 0.78)
    assert.equal(MIN_FONT_HEIGHT_SHARE, 0.03)
    assert.equal(MIN_ANIMATION_FONT_SHARE, 0.026)
    assert.equal(CAPTION_MARGIN_SHARE, 0.08)
    const cjkWidth = estimateLineWidthPx('中文测试', 100)
    const latinWidth = estimateLineWidthPx('test', 100)
    assert.equal(cjkWidth, 4 * 1 * 100 * 1.02)
    assert.equal(latinWidth, 4 * 0.55 * 100 * 1.02)
    assert.ok(cjkWidth > latinWidth * 1.5, `CJK estimate ${cjkWidth} should be clearly wider than Latin ${latinWidth}`)
  })

  /* --------------------------------------------------- animation source lint */

  await check('lintAnimationSource: source without any render contract -> noContract error', () => {
    const violations = lintAnimationSource('<html><body><div>hello</div></body></html>')
    assert.equal(violations.length, 1)
    assert.equal(violations[0].code, 'noContract')
    assert.equal(violations[0].severity, 'error')
    assert.ok(violations[0].messageZh.includes('renderAt'))
    const empty = lintAnimationSource('   ')
    assert.equal(empty[0].code, 'noContract')
  })

  await check('lintAnimationSource: each known contract form is accepted', () => {
    assert.ok(!lintAnimationSource('<script>window.renderAt = t => draw(t)</script>').some((v) => v.code === 'noContract'))
    assert.ok(!lintAnimationSource('<script>function renderAt(t){draw(t)}</script>').some((v) => v.code === 'noContract'))
    assert.ok(!lintAnimationSource('<div data-composition-id="root" data-start="0"></div>').some((v) => v.code === 'noContract'))
    assert.ok(!lintAnimationSource('<script>window.__timelines = {main:{seek(t){}}}</script>').some((v) => v.code === 'noContract'))
  })

  await check('lintAnimationSource: <audio>/<video> without data-start warn; with data-start they pass', () => {
    const missing = lintAnimationSource(
      '<script>window.renderAt=t=>draw(t)</script><audio src="a.mp3"></audio><video src="v.mp4"></video>',
    )
    const media = missing.filter((item) => item.code === 'mediaNoStart')
    assert.equal(media.length, 2)
    assert.equal(media[0].severity, 'warn')
    assert.ok(media[0].where.startsWith('line:'), `where should carry a line number: ${media[0].where}`)

    const ok = lintAnimationSource(
      '<script>window.renderAt=t=>draw(t)</script><audio src="a.mp3" data-start="1.2"></audio><video src="v.mp4" data-start="0"></video>',
    )
    assert.ok(!ok.some((item) => item.code === 'mediaNoStart'))
  })

  await check('lintAnimationSource: tiny inline literal font is caught, non-literals and unknown sizes are skipped', () => {
    const tiny = lintAnimationSource(
      '<div data-composition-id="root" data-start="0" style="font-size:9px">x</div>' +
        '<div style="width:1080px;height:1920px"></div>' +
        '<script>window.renderAt=t=>draw(t)</script>',
    )
    const tinyFont = tiny.find((item) => item.code === 'tinyFont')
    assert.ok(tinyFont !== undefined, `tinyFont not reported: ${tiny.map((item) => item.code).join(',')}`)
    assert.equal(tinyFont.severity, 'warn')
    assert.ok(tinyFont.messageZh.includes('9px'))

    const nonLiteral = lintAnimationSource(
      '<div data-composition-id="root" data-start="0" style="font-size:3vw">x</div>' +
        '<div style="width:1080px;height:1920px"></div><script>window.renderAt=t=>draw(t)</script>',
    )
    assert.ok(!nonLiteral.some((item) => item.code === 'tinyFont'), 'non-literal font-size must not be guessed')

    // No size information at all -> skip the check instead of guessing.
    const unknownSize = lintAnimationSource(
      '<div data-composition-id="root" data-start="0" style="font-size:9px">x</div><script>window.renderAt=t=>draw(t)</script>',
    )
    assert.ok(!unknownSize.some((item) => item.code === 'tinyFont'), 'unknown composition size must not produce a tinyFont')

    const large = lintAnimationSource(
      '<div data-composition-id="root" data-start="0" data-width="1080" data-height="1920" style="font-size:48px">x</div>' +
        '<script>window.renderAt=t=>draw(t)</script>',
    )
    assert.ok(!large.some((item) => item.code === 'tinyFont'))
  })

  await check('lintAnimationSource: idempotent and JSON-safe', () => {
    const source =
      '<div data-composition-id="root" data-start="0" data-width="1080" data-height="1920">' +
      '<audio src="a.mp3"></audio><span style="font-size:10px">x</span></div>'
    const first = lintAnimationSource(source)
    assert.deepEqual(lintAnimationSource(source), first)
    assertJsonSafe(first, 'lintAnimationSource')
    const summary = summariseLint(first)
    assert.ok(summary.codes.includes('mediaNoStart'))
    assert.ok(summary.codes.includes('tinyFont'))
  })

  /* --------------------------------------------------------------- rubric */

  await check('rubric: RUBRIC has the seven dimensions with 5–10 anchors', () => {
    assert.equal(RUBRIC.length, 7)
    assert.deepEqual(
      RUBRIC.map((dimension) => dimension.nameZh),
      ['风格还原度', '内容与叙事', '运动质量', '排版与版式', '完成度与质感', '声音与卡点', '技术正确性'],
    )
    assert.equal(RUBRIC_MAX_SCORE, 10)
    for (const dimension of RUBRIC) {
      assert.ok(typeof dimension.id === 'string' && dimension.id.length > 0)
      assert.ok(typeof dimension.questionZh === 'string' && dimension.questionZh.length > 0)
      assert.ok(typeof dimension.lowZh === 'string' && dimension.lowZh.length > 0)
      for (const score of [5, 6, 7, 8, 9, 10]) {
        assert.equal(typeof dimension.anchors[score], 'string', `${dimension.id} missing anchor ${score}`)
        assert.ok(dimension.anchors[score].length > 4)
      }
    }
    assert.deepEqual(
      ANCHOR_LADDER_ZH.map((anchor) => anchor.score),
      [5, 6, 7, 8, 9, 10],
    )
  })

  await check('rubric: hasTimeReference accepts timecodes/frames and rejects vague prose', () => {
    assert.equal(hasTimeReference('00:03.2 标题切入太慢'), true)
    assert.equal(hasTimeReference('第 96 帧开始闪白'), true)
    assert.equal(hasTimeReference('3.5s 处音乐断掉'), true)
    assert.equal(hasTimeReference('整体不错'), false)
    assert.equal(hasTimeReference(''), false)
  })

  await check('rubric: scoreReport accepts 7 valid entries and computes total/weak/mustFix', () => {
    const report = scoreReport(validRubricEntries())
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.equal(report.dimensions.length, 7)
    assert.equal(report.total, 52)
    assert.equal(report.maxTotal, 70)
    assert.equal(report.average, 7.43)
    assert.ok(report.weak.length >= 3)
    for (let index = 1; index < report.weak.length; index += 1) {
      assert.ok(report.weak[index - 1].score <= report.weak[index].score, 'weak list is not sorted ascending')
    }
    assert.equal(report.mustFix.length, 3)
    assert.equal(report.mustFix[0].score, 5)
    for (const entry of report.mustFix) assert.ok(/\d/u.test(entry.fix), 'mustFix entry has no numeric fix')
    assert.deepEqual(report.missingDimensions, [])
    assertJsonSafe(report, 'scoreReport')
  })

  await check('rubric: scoreReport rejects missing evidence, evidence without a timecode, and generic praise', () => {
    const missingEvidence = scoreReport([
      { dimension: '风格还原度', score: 6, fix: '把 1.5s 改成 0.4s' },
    ])
    assert.equal(missingEvidence.ok, false)
    assert.ok(missingEvidence.errors[0].reasonZh.includes('evidence'))

    const generic = scoreReport([
      { dimension: '风格还原度', score: 6, evidence: '整体不错', fix: '把 1.5s 改成 0.4s' },
    ])
    assert.equal(generic.ok, false)
    assert.ok(/时间码|帧号/u.test(generic.errors[0].reasonZh))

    const genericOnly = scoreReport([
      { dimension: '风格还原度', score: 6, evidence: '感觉挺好', fix: '整体不错' },
    ])
    assert.equal(genericOnly.ok, false)
    assert.equal(genericOnly.rejected.length, 1)
  })

  await check('rubric: scoreReport rejects a missing fix / non-numeric fix / bad score / unknown or duplicate dimension', () => {
    const cases = [
      [{ dimension: '风格还原度', score: 6, evidence: '00:01.2 太慢' }],
      [{ dimension: '风格还原度', score: 6, evidence: '00:01.2 太慢', fix: '整体不错' }],
      [{ dimension: '风格还原度', score: 11, evidence: '00:01.2 太慢', fix: '把 1.5s 改成 0.4s' }],
      [{ dimension: '画风', score: 6, evidence: '00:01.2 太慢', fix: '把 1.5s 改成 0.4s' }],
      [
        { dimension: '风格还原度', score: 6, evidence: '00:01.2 太慢', fix: '把 1.5s 改成 0.4s' },
        { dimension: 'style-fidelity', score: 7, evidence: '00:02.2 太快', fix: '把 0.4s 改成 1.5s' },
      ],
    ]
    for (const entries of cases) {
      const report = scoreReport(entries)
      assert.equal(report.ok, false, `expected rejection for ${JSON.stringify(entries)}`)
      assert.ok(report.rejected.length >= 1)
      assert.ok(report.errors.every((error) => typeof error.reasonZh === 'string'))
    }
    assert.equal(scoreReport('not an array').ok, false)
    assert.equal(scoreReport([]).ok, false)
  })

  await check('rubric: a mixed valid+invalid set is rejected as a whole (no partial total)', () => {
    const entries = validRubricEntries()
    entries[3] = { dimension: '排版与版式', score: 9 }
    const report = scoreReport(entries)
    assert.equal(report.ok, false)
    assert.equal(report.total, undefined)
    assert.ok(report.messageZh.includes('拒绝'))
  })

  await check('rubric: partial coverage is allowed but flagged as missing dimensions', () => {
    const entries = validRubricEntries().slice(0, 3)
    const report = scoreReport(entries)
    assert.equal(report.ok, true)
    assert.equal(report.dimensions.length, 3)
    assert.equal(report.maxTotal, 30)
    assert.equal(report.missingDimensions.length, 4)
    assert.ok(report.warnings.some((warning) => warning.includes('未评分')))
  })

  await check('rubric: renderRubricTemplate renders a blank fill-in table and a filled report', () => {
    const blank = renderRubricTemplate()
    assert.ok(blank.includes('| 维度 | 分数(1–10) |'), 'blank table header missing')
    assert.ok(blank.includes('锚点速查'))
    for (const dimension of RUBRIC) assert.ok(blank.includes(`| ${dimension.nameZh} |`), `${dimension.nameZh} row missing`)
    assert.ok(blank.includes('整体不错'), 'blank template must warn against evidence-free praise')

    const filled = renderRubricTemplate(scoreReport(validRubricEntries()))
    assert.ok(filled.includes('总分'))
    assert.ok(filled.includes('52 / 70'))
    assert.ok(filled.includes('弱项'))
    assert.ok(filled.includes('必须修的 3 条'))
    assert.ok(filled.includes('00:01.2'), 'filled table should carry evidence text')
    assert.ok(filled.includes('把淡入从 1.5s 改成 0.4s'), 'filled table should carry the fix text')

    const rejected = renderRubricTemplate(scoreReport([{ dimension: '风格还原度', score: 6 }]))
    assert.ok(rejected.includes('评分被拒绝'))
    assert.ok(rejected.includes('evidence'))
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exitCode = 1
})
