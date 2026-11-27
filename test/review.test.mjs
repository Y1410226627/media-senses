#!/usr/bin/env node
/**
 * 独立终检聚合测试（lib/review.js / CONTRACT-V4 §2.4）。
 *
 *   node test/review.test.mjs
 *
 * 纯聚合：所有引擎输入都是手写构造的对象，不跑 ffmpeg、不读文件、不联网。
 * 覆盖四类验收：
 *   1. 全绿输入 → pass，五节齐全、分数 100、没有 blocker；
 *   2. 任一引擎 fail → verdict 降级，且每条 blocker 都带帧号/秒证据；
 *   3. 没有时间引用的失败项被降级为提醒并标注「缺证据」，不能算 blocker；
 *   4. blind 模式移除主观形容词（词表见 SUBJECTIVE_WORDS_ZH），只留可验证陈述。
 */
import assert from 'node:assert/strict'
import {
  DISCLAIMER_ZH,
  REVIEW_SECTIONS,
  REVIEW_VERSION,
  SUBJECTIVE_WORDS_ZH,
  auditFilm,
  renderReviewReport,
} from '../lib/review.js'
import { hasTimeReference } from '../lib/rubric.js'

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

/* --------------------------------------------------------------- fixtures */

/** 一份"所有引擎都过"的输入：用来验证全绿 → pass。 */
const GREEN = {
  fps: 30,
  gate: {
    verdict: 'PASS',
    legs: [
      { id: 'cadence', state: 'PASS', detail: '镜头长 1.20–3.40s，变异系数 0.42（要求 ≥0.18），节奏有变化', value: { cv: 0.42, shortest: 1.2, longest: 3.4 } },
      { id: 'stillness', state: 'PASS', detail: '静帧占 12%（要求 ≥8%），最长一段静止 0.40s', value: { stillRatio: 0.12, longestSec: 0.4 } },
      { id: 'burst', state: 'PASS', detail: '有 2 处爆发（1.5s 内 ≥2 次大变化），首处约 1.50s', value: { bursts: 2, firstAt: 1.5 } },
      { id: 'dead-air', state: 'PASS', detail: '最长一段无变化 0.30s，从 2.20s 起', value: { longestSec: 0.3, at: 2.2 } },
    ],
    measurements: { duration: 7.7 },
    warnings: [],
  },
  continuity: {
    score: 0.82,
    considered: 3,
    carried: 2,
    anchored: 1,
    bare: 0,
    blindSpots: [],
    boundaries: [{ t: 2.2, kind: 'carried' }, { t: 5.0, kind: 'anchored' }],
  },
  aesthetic: {
    rows: [
      { id: 'R1', family: 'R', verdict: 'pass', evidenceZh: '第 36 帧（1.20s）品牌字标 hold 1.20s，要求 ≥1.0s' },
      { id: 'Q11', family: 'Q', verdict: 'pass', evidenceZh: '第 60 帧（2.00s）字幕有效像素 64px（要求 ≥56px）' },
    ],
    passRatio: 1,
    failures: 0,
    warnings: 0,
  },
  beatsync: {
    backtest: {
      rows: [{ designedFrame: 60, nearestBeatFrame: 60, errorFrames: 0, verdict: 'match' }],
      meanAbsFrames: 0,
      maxAbsFrames: 0,
      within3Ratio: 1,
      pass: true,
    },
    offset: { offsetFrames: 1.25, offsetSeconds: 0.0417, correlation: 0.992, pass: true },
    grid: { bpm: 120, t0: 0.04, period: 0.5, count: 16, residualMaxMs: 8, residualRmsMs: 4, pass: true },
  },
  audio: {
    duration: 7.7,
    loudness: { lufsIntegrated: -16, peakDbfs: -1.5, silenceRatio: 0.1, clippingRatio: 0 },
    sections: [
      { start: 0, end: 6.5, energy: 0.5, label: 'body' },
      { start: 6.5, end: 7.7, energy: 0.8, label: 'outro' },
    ],
    sfx: [
      { kind: 'whoosh', designedFrame: 60, measuredPeakFrame: 59, outputOffsetFrames: 1, peakDb: -6, durationSeconds: 0.8, durationInFrames: 24, license: { type: 'CC0', url: 'https://freesound.org/s/1', author: 'tester' } },
      { kind: 'impact', designedFrame: 180, measuredPeakFrame: 179, outputOffsetFrames: 1, peakDb: -3, durationSeconds: 1.2, durationInFrames: 36, license: { type: 'CC-BY-4.0', url: 'https://freesound.org/s/2', author: 'tester' } },
      { kind: 'sparkle', designedFrame: 210, measuredPeakFrame: 209, outputOffsetFrames: 1, peakDb: -8, durationSeconds: 0.6, durationInFrames: 18, license: { type: 'CC0', url: 'https://freesound.org/s/3', author: 'tester' } },
    ],
    bgm: { present: true, musicVolumeDb: -22 },
    versions: { withBgm: 'with-bgm.mp4', withoutBgm: 'no-bgm.mp4' },
  },
  plan: {
    fps: 30,
    width: 1080,
    height: 1920,
    scenes: [
      { type: 'text', duration: 2.2, transitionIn: 'cut' },
      { type: 'image', duration: 2.8, transitionIn: 'cut' },
      { type: 'text', duration: 2.7, transitionIn: 'cut' },
    ],
  },
  shots: [
    { index: 0, start: 0, end: 2.2, duration: 2.2 },
    { index: 1, start: 2.2, end: 5.0, duration: 2.8 },
    { index: 2, start: 5.0, end: 7.7, duration: 2.7 },
  ],
  lint: [],
  dataSafety: {
    policyZh: '演示数据为虚构：人名/邮箱/金额均已脱敏',
    sensitiveFindings: [],
    screenshotsReal: true,
    assetsLoaded: true,
    publicDataAuditable: true,
  },
  decisions: [{ requirementZh: '必须展示快捷键面板', landingZh: '第 2 场景（2.20–5.00s）画面出现快捷键浮层', frames: [80] }],
}

function green() {
  return structuredClone(GREEN)
}

/** 失败夹具：gate 静止空档 FAIL、卡点回测越界、审美判例 fail、lint error、数据敏感信息。 */
function failing() {
  const input = green()
  input.gate.verdict = 'FAIL'
  input.gate.legs = input.gate.legs.map((leg) => (leg.id === 'dead-air'
    ? { ...leg, state: 'FAIL', detail: '有 2.50s 完全没有变化（从 3.20s 起），观众会以为卡住了', value: { longestSec: 2.5, at: 3.2 } }
    : leg))
  input.beatsync.backtest = {
    rows: [{ designedFrame: 240, nearestBeatFrame: 251, errorFrames: 11, verdict: 'diverge' }],
    meanAbsFrames: 6.2,
    maxAbsFrames: 11,
    within3Ratio: 0.25,
    pass: false,
  }
  input.aesthetic = {
    ...input.aesthetic,
    rows: [
      ...input.aesthetic.rows,
      {
        id: 'R2',
        family: 'R',
        verdict: 'fail',
        evidenceZh: '第 240 帧（8.00s）匀速直线运动：方差 0.002 < 0.01，观感廉价，运动生硬',
        judgmentZh: '观感高级，节奏稳重',
      },
    ],
    failures: 1,
  }
  input.lint = [{ code: 'textOverflow', severity: 'error', messageZh: '文字超出安全区（宽 1.02 倍）', scene: 1, where: 'scenes[1].text' }]
  input.dataSafety = { ...input.dataSafety, sensitiveFindings: [{ frame: 120, whereZh: '结尾字幕', whatZh: '暴露客户手机号' }] }
  input.decisions = [{ requirementZh: '展示快捷键面板', landingZh: '', frames: [] }]
  return input
}

function rowsOf(report) {
  return report.sections.flatMap((section) => section.rows)
}

function findRow(report, id) {
  return rowsOf(report).find((row) => row.id === id)
}

function walkNumbers(value, visit) {
  if (typeof value === 'number') visit(value)
  else if (Array.isArray(value)) value.forEach((item) => walkNumbers(item, visit))
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((item) => walkNumbers(item, visit))
}

/* ------------------------------------------------------------ 1. 契约面 */

await check('REVIEW_SECTIONS 是五节 A 音画 / B 节奏 / C 画面 / D 数据安全 / E 一致性', () => {
  assert.equal(REVIEW_SECTIONS.length, 5)
  assert.deepEqual(REVIEW_SECTIONS.map((section) => section.id), ['A', 'B', 'C', 'D', 'E'])
  assert.deepEqual(REVIEW_SECTIONS.map((section) => section.zh), ['音画', '节奏', '画面', '数据安全', '一致性'])
  assert.ok(Object.isFrozen(REVIEW_SECTIONS))
  for (const section of REVIEW_SECTIONS) {
    assert.equal(typeof section.upstreamZh, 'string')
    assert.ok(section.upstreamZh.length > 0)
  }
})

await check('REVIEW_VERSION 与形容词词表已导出', () => {
  assert.equal(REVIEW_VERSION, 'media-senses.review/v1')
  assert.ok(Array.isArray(SUBJECTIVE_WORDS_ZH))
  assert.ok(SUBJECTIVE_WORDS_ZH.length >= 20, `words ${SUBJECTIVE_WORDS_ZH.length}`)
  for (const word of SUBJECTIVE_WORDS_ZH) assert.ok(typeof word === 'string' && word.length > 0)
})

/* --------------------------------------------------- 2. 全绿 → pass */

const greenReport = auditFilm(green())

await check('全绿输入 → verdict pass / score 100 / 无 blocker', () => {
  assert.equal(greenReport.verdict, 'pass')
  assert.equal(greenReport.score, 100)
  assert.deepEqual(greenReport.blockers, [])
  assert.deepEqual(greenReport.mustFix, [])
  assert.deepEqual(greenReport.warnings, [])
  assert.deepEqual(greenReport.cannotVerify, [])
  assert.equal(greenReport.rowCounts.fail, 0)
  assert.equal(greenReport.rowCounts.pass, greenReport.rowCounts.total)
  assert.match(greenReport.summaryZh, /通过/u)
})

await check('五节都产出检查行与计数，且行结构符合契约', () => {
  assert.equal(greenReport.sections.length, 5)
  for (const section of greenReport.sections) {
    assert.ok(section.rows.length > 0, `${section.id} 没有行`)
    assert.equal(section.counts.total, section.rows.length)
    for (const row of section.rows) {
      assert.equal(typeof row.id, 'string')
      assert.ok(['pass', 'fail', 'warn', 'skip'].includes(row.verdict))
      assert.equal(typeof row.evidenceZh, 'string')
      assert.ok(Array.isArray(row.frames))
      assert.equal(row.sectionId, section.id)
    }
  }
  assert.ok(greenReport.rowCounts.total >= 20, `rows ${greenReport.rowCounts.total}`)
})

await check('全绿报告带独立审计声明与证据规则', () => {
  assert.equal(greenReport.independent, true)
  assert.equal(greenReport.disclaimerZh, DISCLAIMER_ZH)
  assert.ok(greenReport.evidencePolicyZh.includes('帧号或秒'))
  assert.match(greenReport.summaryZh, /独立终检/u)
})

/* ---------------------------------------------- 3. fail → 降级 + 证据 */

const failingReport = auditFilm(failing())
const blockers = failingReport.blockers

await check('任一引擎 fail → verdict fail 且分数下降', () => {
  assert.equal(failingReport.verdict, 'fail')
  assert.ok(failingReport.score < 100, `score ${failingReport.score}`)
  assert.ok(blockers.length >= 5, `blockers ${blockers.length}`)
  assert.equal(failingReport.rowCounts.fail, blockers.length)
})

await check('每条 blocker 都带帧号或秒证据', () => {
  for (const blocker of blockers) {
    const evidence = `${blocker.evidenceZh} ${breakerEvidence(blocker)}`
    assert.ok(blocker.frames.length > 0 || hasTimeReference(evidence), `blocker ${blocker.id} 没有时间证据：${blocker.evidenceZh}`)
  }
})

/** 把帧数组也拼进证据文本，模拟"帧号也是证据"的判定方式。 */
function breakerEvidence(blocker) {
  return blocker.frames.map((frame) => `第 ${frame} 帧`).join(' ')
}

await check('gate 静止空档 FAIL 用秒证据成为 blocker', () => {
  const blocker = blockers.find((row) => row.id === 'gate.dead-air')
  assert.ok(blocker !== undefined, 'gate.dead-air 不在 blockers 里')
  assert.equal(blocker.verdict, 'fail')
  assert.match(blocker.evidenceZh, /3\.20s/u)
  assert.ok(blocker.frames.includes(96), `frames ${JSON.stringify(blocker.frames)}`)
})

await check('卡点回测超限用帧号证据成为 blocker', () => {
  const blocker = blockers.find((row) => row.id === 'beatsync.backtest')
  assert.ok(blocker !== undefined, 'beatsync.backtest 不在 blockers 里')
  assert.match(blocker.evidenceZh, /第 240 帧/u)
  assert.match(blocker.evidenceZh, /误差 11 帧/u)
  assert.ok(blocker.frames.includes(240) && blocker.frames.includes(251))
})

await check('审美判例 fail 带帧号证据成为 blocker', () => {
  const blocker = blockers.find((row) => row.id === 'aesthetic.R2')
  assert.ok(blocker !== undefined, 'aesthetic.R2 不在 blockers 里')
  assert.match(blocker.evidenceZh, /第 240 帧/u)
})

await check('lint error 被换算成场景帧号证据（第 66 帧）', () => {
  const blocker = blockers.find((row) => row.id === 'lint.textOverflow')
  assert.ok(blocker !== undefined, 'lint.textOverflow 不在 blockers 里')
  assert.match(blocker.evidenceZh, /场景 2/u)
  assert.match(blocker.evidenceZh, /2\.20s/u)
  assert.match(blocker.evidenceZh, /第 66 帧/u)
})

await check('数据敏感信息带帧号成为 blocker', () => {
  const blocker = blockers.find((row) => row.id === 'data.sensitive')
  assert.ok(blocker !== undefined, 'data.sensitive 不在 blockers 里')
  assert.match(blocker.evidenceZh, /第 120 帧/u)
  assert.match(blocker.evidenceZh, /客户手机号/u)
})

await check('blockers 按 A→E 节顺序排列，mustFix 带改法', () => {
  const order = REVIEW_SECTIONS.map((section) => section.id)
  const indexes = blockers.map((row) => order.indexOf(row.sectionId))
  const sorted = [...indexes].sort((a, b) => a - b)
  assert.deepEqual(indexes, sorted)
  assert.ok(failingReport.mustFix.length <= 5 && failingReport.mustFix.length === Math.min(5, blockers.length))
  for (const item of failingReport.mustFix) {
    assert.equal(typeof item.sectionId, 'string')
    assert.equal(typeof item.evidenceZh, 'string')
    assert.ok(Array.isArray(item.frames))
    assert.ok(item.fixZh.length > 5, `fixZh 过短：${item.fixZh}`)
  }
})

await check('失败输入的分数仍在 0–100 且是有限数', () => {
  assert.ok(Number.isFinite(failingReport.score))
  assert.ok(failingReport.score >= 0 && failingReport.score <= 100)
})

/* ------------------------------- 4. 无时间证据的失败项 → 降级为提醒 */

const unevidenced = auditFilm({
  gate: {
    verdict: 'FAIL',
    legs: [{ id: 'audio', state: 'FAIL', detail: '峰值爆表', value: { peakDb: 0.5, clipped: 2 } }],
    measurements: {},
    warnings: [],
  },
})

await check('没有帧号/秒的失败项被降级为提醒并标注缺证据', () => {
  const row = findRow(unevidenced, 'audio.headroom')
  assert.ok(row !== undefined, 'audio.headroom 行缺失')
  assert.equal(row.verdict, 'warn')
  assert.equal(row.evidenceMissing, true)
  assert.match(row.evidenceZh, /缺证据/u)
  assert.match(row.evidenceZh, /降级为提醒/u)
  assert.equal(unevidenced.blockers.length, 0)
  assert.equal(unevidenced.downgraded.length, 1)
  assert.equal(unevidenced.verdict, 'warn')
})

await check('降级项出现在提醒列表与渲染文本里', () => {
  assert.ok(unevidenced.warnings.some((row) => row.id === 'audio.headroom'))
  const rendered = renderReviewReport(unevidenced)
  assert.match(rendered, /## 提醒/u)
  assert.match(rendered, /缺证据/u)
})

await check('无帧证据的数据敏感信息同样降级，不能算 blocker', () => {
  const report = auditFilm({
    dataSafety: { policyZh: '演示数据已脱敏', sensitiveFindings: [{ whatZh: '暴露内部地址' }] },
  })
  const row = findRow(report, 'data.sensitive')
  assert.ok(row !== undefined)
  assert.equal(row.verdict, 'warn')
  assert.equal(row.evidenceMissing, true)
  assert.equal(report.blockers.length, 0)
})

/* ------------------------------------------------- 5. 缺输入/健壮性 */

await check('空输入 → warn，五节全部无法验证，没有编造通过', () => {
  const report = auditFilm()
  assert.equal(report.verdict, 'warn')
  assert.equal(report.blockers.length, 0)
  assert.equal(report.rowCounts.pass, 0)
  assert.ok(report.rowCounts.skip > 0)
  assert.match(report.summaryZh, /无法验证/u)
  assert.equal(report.sections.length, 5)
})

await check('混合 null 输入不崩：只给 gate 也能出报告', () => {
  const report = auditFilm({ gate: green().gate })
  assert.equal(report.sections.length, 5)
  assert.ok(report.rowCounts.total > 0)
  const rendered = renderReviewReport(report)
  assert.match(rendered, /独立终检报告/u)
})

await check('lint 摘要（只有 errors/warnings 计数）不会被当成全绿', () => {
  const report = auditFilm({
    plan: green().plan,
    lint: { ok: false, errors: 2, warnings: 1, codes: ['textOverflow', 'fontTooSmall'] },
  })
  const row = findRow(report, 'lint.summary')
  assert.ok(row !== undefined, 'lint.summary 行缺失')
  assert.equal(row.verdict, 'warn')
  assert.match(row.evidenceZh, /error 2/u)
})

await check('beatsync 允许直接传入某一项原始返回', () => {
  const report = auditFilm({
    beatsync: {
      rows: [{ designedFrame: 90, nearestBeatFrame: 91, errorFrames: 1, verdict: 'close' }],
      meanAbsFrames: 1,
      maxAbsFrames: 2,
      within3Ratio: 1,
      pass: true,
    },
  })
  const row = findRow(report, 'beatsync.backtest')
  assert.ok(row !== undefined)
  assert.equal(row.verdict, 'pass')
  assert.ok(row.frames.includes(90))
})

await check('continuity 同时支持 analyzeContinuity 与 {ref,built} 对比形状', () => {
  const report = auditFilm({
    continuity: {
      ref: { score: 0.8 },
      built: { score: 0.2, boundaries: [{ t: 2.2, kind: 'bare' }] },
      delta: -0.6,
      verdict: 'diverge',
    },
  })
  const row = findRow(report, 'continuity.carry')
  assert.ok(row !== undefined, 'continuity.carry 行缺失')
  assert.equal(row.verdict, 'fail')
  assert.ok(row.evidenceZh.includes('2.20s'), `证据里没有秒引用：${row.evidenceZh}`)
  assert.ok(report.blockers.some((blocker) => blocker.id === 'continuity.carry'))
})

await check('报告确定性：同参两次结果一致，且数字全部有限、可 JSON 序列化', () => {
  const first = auditFilm(failing())
  const second = auditFilm(failing())
  assert.deepEqual(first, second)
  walkNumbers(first, (value) => assert.ok(Number.isFinite(value), `非有限数字 ${value}`))
  const roundTrip = JSON.parse(JSON.stringify(first))
  assert.equal(roundTrip.verdict, first.verdict)
  assert.equal(roundTrip.score, first.score)
  assert.equal(roundTrip.sections.length, 5)
})

/* ------------------------------------------------------ 6. 渲染（Markdown） */

await check('渲染头显式标注「独立审计、自检不作为证据」', () => {
  const rendered = renderReviewReport(failingReport)
  assert.match(rendered, /^# 独立终检报告/u)
  assert.ok(rendered.includes(DISCLAIMER_ZH), '缺少独立审计声明')
  assert.match(rendered, /判定：未通过/u)
  assert.match(rendered, /分数：\d+\/100/u)
})

await check('渲染按 A→E 五节顺序展开，并保留帧号证据', () => {
  const rendered = renderReviewReport(failingReport)
  const order = REVIEW_SECTIONS.map((section) => `## ${section.id} ${section.zh}`)
  let cursor = -1
  for (const heading of order) {
    const at = rendered.indexOf(heading)
    assert.ok(at > cursor, `标题顺序错误：${heading}`)
    cursor = at
  }
  assert.match(rendered, /## 必须修复/u)
  assert.match(rendered, /第 240 帧/u)
  assert.match(rendered, /3\.20s/u)
  assert.match(rendered, /## 报告说明/u)
  assert.match(rendered, /video-shotcraft/u)
  assert.match(rendered, /Apache-2\.0/u)
})

await check('全绿报告不出现必须修复/提醒/无法验证空节', () => {
  const rendered = renderReviewReport(greenReport)
  assert.doesNotMatch(rendered, /## 必须修复/u)
  assert.doesNotMatch(rendered, /## 提醒/u)
  assert.doesNotMatch(rendered, /## 无法验证/u)
  assert.match(rendered, /判定：通过/u)
})

/* -------------------------------------------------------- 7. blind 模式 */

const fullText = renderReviewReport(failingReport)
const blindText = renderReviewReport(failingReport, { blind: true })

await check('非盲模式保留主观判断（对照组）', () => {
  assert.match(fullText, /观感廉价/u)
  assert.match(fullText, /判断：观感高级/u)
})

await check('blind 模式移除词表里的全部主观形容词', () => {
  for (const word of SUBJECTIVE_WORDS_ZH) {
    assert.ok(!blindText.includes(word), `blind 输出仍包含主观词「${word}」`)
  }
})

await check('blind 模式不再渲染 judgment 字段', () => {
  assert.ok(!blindText.includes('判断：'), 'blind 输出仍带“判断：”段')
  assert.ok(blindText.includes('主观看法的形容词已移除') || blindText.includes('盲模式'))
})

await check('blind 模式保留可验证陈述（判定/分数/帧号/秒/计数）', () => {
  assert.match(blindText, /判定：fail/u)
  assert.match(blindText, /分数：\d+\/100/u)
  assert.match(blindText, /第 240 帧/u)
  assert.match(blindText, /3\.20s/u)
  assert.match(blindText, /## A 音画/u)
  assert.match(blindText, /## E 一致性/u)
  assert.ok(blindText.includes('✓') || blindText.includes('✗'))
  assert.ok(blindText.includes(DISCLAIMER_ZH))
})

await check('renderReviewReport 支持 target:"blind" 别名', () => {
  const viaTarget = renderReviewReport(failingReport, { target: 'blind' })
  assert.equal(viaTarget, blindText)
})

/* ------------------------------------------------------ 8. 渲染健壮性 */

await check('report 为 null 时给可读兜底而不是崩溃', () => {
  const rendered = renderReviewReport(null)
  assert.match(rendered, /独立终检报告/u)
  assert.ok(rendered.includes(DISCLAIMER_ZH))
  assert.match(rendered, /无法给出终检结论/u)
})

await check('字段不全的 report 也能渲染（sections/score 缺失）', () => {
  const rendered = renderReviewReport({ verdict: 'pass' })
  assert.match(rendered, /独立终检报告/u)
  assert.match(rendered, /判定：通过/u)
  assert.match(rendered, /## 报告说明/u)
})

/* -------------------------------------------------------------- summary */

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`\n${name}\n${error.stack}`)
  process.exitCode = 1
}
