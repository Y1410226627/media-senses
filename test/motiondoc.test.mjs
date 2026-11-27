#!/usr/bin/env node
/**
 * media-senses — reproduction-contract tests (lib/motiondoc.js).
 *
 * The contract exists to answer three questions that a reproduction cannot be
 * revised without: what was kept, what was replaced, and at which moments the two
 * versions are supposed to look the same. So the tests pin the failure modes that
 * make the document useless while still looking complete:
 *
 *  - a keep/replace row that names only one side;
 *  - "it doesn't fit, shrink the font" (the rule is re-break the shot);
 *  - a source→output mapping that silently overlaps or drops footage;
 *  - an evidence level that claims more than the artefacts support.
 *
 * Run from `media-senses/`:  node test/motiondoc.test.mjs
 */
import assert from 'node:assert/strict'
import {
  BASIS,
  CHECKPOINT_PASS_VERDICTS,
  EVIDENCE_LEVELS,
  MOTION_DOC_SECTIONS,
  OVERFLOW_POLICIES,
  buildClipMap,
  buildKeepReplaceTable,
  buildMotionDoc,
  inferEvidenceLevel,
  planCheckpoints,
  renderMotionDocMarkdown,
  validateMotionDoc,
} from '../lib/motiondoc.js'

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

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

check('the document has the nine sections, in order', () => {
  assert.equal(MOTION_DOC_SECTIONS.length, 9)
  assert.deepEqual(MOTION_DOC_SECTIONS.map((section) => section.id), [
    'identity', 'brandKit', 'narrative', 'visual', 'timing', 'assets', 'keep', 'replace', 'checks',
  ])
  for (const section of MOTION_DOC_SECTIONS) {
    assert.ok(section.zh.length > 1, `${section.id} needs a Chinese title`)
    assert.ok(section.asksZh.length > 5, `${section.id} needs a prompt`)
  }
})

check('evidence levels form a ladder and each names what it requires', () => {
  assert.equal(EVIDENCE_LEVELS.length, 5)
  assert.deepEqual(EVIDENCE_LEVELS.map((level) => level.id), ['reference', 'described', 'editable', 'rendered', 'reviewed'])
  for (const level of EVIDENCE_LEVELS) assert.ok(level.requiresZh.length > 4, `${level.id} needs a requirement`)
})

check('the three bases are separate and only three exist', () => {
  assert.deepEqual(BASIS.map((entry) => entry.id), ['observed', 'inferred', 'changed'])
  assert.ok(OVERFLOW_POLICIES.some((policy) => policy.id === 'shrink'))
  assert.deepEqual([...CHECKPOINT_PASS_VERDICTS], ['match', 'close'])
})

/* ------------------------------------------------------------------ *
 * Keep / replace table
 * ------------------------------------------------------------------ */

check('a row that names only one side is rejected', () => {
  const table = buildKeepReplaceTable([
    { fromSeconds: 0, toSeconds: 1, keepZh: '推近', useZh: '' },
    { fromSeconds: 1, toSeconds: 2, keepZh: '', useZh: '新标题' },
  ])
  assert.equal(table.errors.length, 2)
  assert.ok(table.errors.some((error) => error.includes('本片用什么内容')), table.errors.join(' | '))
  assert.ok(table.errors.some((error) => error.includes('保留的拍法')), table.errors.join(' | '))
})

check('overflow defaults to re-break and says what to do', () => {
  const table = buildKeepReplaceTable([
    { fromSeconds: 0, toSeconds: 2, keepZh: '标题砸入', useZh: '一句话很长很长很长很长很长', capacity: 8 },
  ])
  assert.equal(table.errors.length, 0)
  assert.equal(table.warnings.length, 1)
  assert.ok(table.warnings[0].includes('拆分/重排'))
  assert.equal(table.rows[0].overflow, null)
})

check('shrinking the font to fit is an error, not a preference', () => {
  const table = buildKeepReplaceTable([
    { fromSeconds: 0, toSeconds: 2, keepZh: '标题砸入', useZh: '一句话很长', capacity: 3, overflow: 'shrink' },
  ])
  assert.equal(table.errors.length, 1)
  assert.ok(table.errors[0].includes('缩小字号'))
})

check('truncation is allowed but recorded', () => {
  const table = buildKeepReplaceTable([
    { fromSeconds: 0, toSeconds: 2, keepZh: '标题', useZh: '一句话很长', capacity: 3, overflow: 'truncate' },
  ])
  assert.equal(table.errors.length, 0)
  assert.equal(table.warnings.length, 1)
  assert.ok(table.warnings[0].includes('截断'))
})

check('an inferred technique with no time range gets a warning', () => {
  const table = buildKeepReplaceTable([{ keepZh: '环绕运镜', useZh: '九个标签' }])
  assert.equal(table.errors.length, 0)
  assert.ok(table.warnings.some((warning) => warning.includes('推断')))
})

/* ------------------------------------------------------------------ *
 * Clip map — source time is not output time
 * ------------------------------------------------------------------ */

check('source time maps onto output time per segment', () => {
  const map = buildClipMap([
    { sourceIn: 12, sourceOut: 18, outputIn: 0 },
    { sourceIn: 21, sourceOut: 26, outputIn: 6 },
  ])
  assert.equal(map.errors.length, 0)
  // Source 15 s sits 3 s into the first segment, which starts at output 0.
  assert.equal(map.sourceToOutput(15), 3)
  // Source 23 s sits 2 s into the second segment, which starts at output 6.
  assert.equal(map.sourceToOutput(23), 8)
  assert.equal(map.sourceToOutput(19), null, 'a dropped source moment has no output time')
  // Output 7 s is 1 s into segment 2 (which starts at output 6), i.e. source 22 s.
  assert.equal(map.outputToSource(7), 22)
  assert.equal(map.outputToSource(20), null, 'an output moment past the last segment has no source')
})

check('overlapping output segments are an error', () => {
  const map = buildClipMap([
    { sourceIn: 0, sourceOut: 6, outputIn: 0 },
    { sourceIn: 10, sourceOut: 14, outputIn: 3 },
  ])
  assert.ok(map.errors.some((error) => error.includes('输出时间重叠')))
})

check('a gap in the output timeline is a warning, not an error', () => {
  const map = buildClipMap([
    { sourceIn: 0, sourceOut: 4, outputIn: 0 },
    { sourceIn: 10, sourceOut: 14, outputIn: 6 },
  ])
  assert.equal(map.errors.length, 0)
  assert.ok(map.warnings.some((warning) => warning.includes('空档')))
})

check('the same source footage cannot be used twice', () => {
  const map = buildClipMap([
    { sourceIn: 0, sourceOut: 6, outputIn: 0 },
    { sourceIn: 3, sourceOut: 9, outputIn: 6 },
  ])
  assert.ok(map.errors.some((error) => error.includes('源时间重叠')))
})

check('a backwards segment is rejected with the numbers', () => {
  const map = buildClipMap([{ sourceIn: 6, sourceOut: 4, outputIn: 0 }])
  assert.equal(map.errors.length, 1)
  assert.ok(map.errors[0].includes('sourceOut'))
})

check('subtitles are re-mapped through the cuts, not shifted by a constant', () => {
  const map = buildClipMap([
    { sourceIn: 12, sourceOut: 18, outputIn: 0 },
    { sourceIn: 21, sourceOut: 26, outputIn: 6 },
  ])
  const remapped = map.remapSubtitles([
    { start: 13, end: 15, text: '第一句' },
    { start: 17, end: 22, text: '跨切点的一句' },
    { start: 27, end: 28, text: '落在被剪掉的片段里' },
  ])
  assert.equal(remapped[0].start, 1)
  assert.equal(remapped[0].end, 3)
  assert.equal(remapped[0].split, false)
  // 17–18 in segment 1 (output 5–6) and 21–22 in segment 2 (output 6–7) → two cues.
  const spans = remapped.filter((cue) => cue.text === '跨切点的一句')
  assert.equal(spans.length, 2, `expected the straddling cue to split, got ${JSON.stringify(spans)}`)
  assert.equal(spans[0].start, 5)
  assert.equal(spans[1].start, 6)
  assert.ok(spans.every((cue) => cue.split === true))
  assert.ok(map.warnings.some((warning) => warning.includes('字幕')))
})

/* ------------------------------------------------------------------ *
 * Paired checkpoints
 * ------------------------------------------------------------------ */

check('explicit checkpoint pairs are kept as given', () => {
  const points = planCheckpoints({ pairs: [{ referenceAt: 0.8, whatZh: '读到改过的数字' }, { referenceAt: 2.65, builtAt: 3, whatZh: '两张卡在同一位置' }] })
  assert.equal(points.length, 2)
  assert.equal(points[0].referenceAt, 0.8)
  assert.equal(points[0].builtAt, 0.8, 'built defaults to the same moment')
  assert.equal(points[1].builtAt, 3)
})

check('checkpoints are derived from cuts and from the longest hold', () => {
  const points = planCheckpoints({
    shots: [
      { start: 0, duration: 2 },
      { start: 2, duration: 5 },
      { start: 7, duration: 1 },
    ],
  })
  assert.equal(points.length, 3, `got ${JSON.stringify(points)}`)
  // Two internal cuts, plus the midpoint of the longest shot (2 → 4.5 s).
  assert.deepEqual(points.map((point) => point.referenceAt), [2, 4.5, 7])
  assert.ok(points[1].whatZh.includes('最长镜头'))
})

check('checkpoints fall back to the duration when there is no shot list', () => {
  const points = planCheckpoints({ durationSeconds: 20 })
  assert.deepEqual(points.map((point) => point.referenceAt), [5, 10, 15])
  assert.equal(planCheckpoints({}).length, 0)
})

check('the checkpoint count is capped', () => {
  const shots = Array.from({ length: 20 }, (_, index) => ({ start: index, duration: 1 }))
  assert.equal(planCheckpoints({ shots, maxCheckpoints: 4 }).length, 4)
})

/* ------------------------------------------------------------------ *
 * Evidence levels
 * ------------------------------------------------------------------ */

check('the evidence level is inferred, and cannot be inflated', () => {
  assert.equal(inferEvidenceLevel({ identity: { sourceUrl: 'u' } }), 'reference')
  assert.equal(inferEvidenceLevel({ identity: { sourceUrl: 'u' }, claims: [{ textZh: 'a' }] }), 'described')
  assert.equal(inferEvidenceLevel({ identity: { sourceUrl: 'u' }, hasSource: true }), 'editable')
  assert.equal(inferEvidenceLevel({ identity: { sourceUrl: 'u' }, outputPath: 'a.mp4' }), 'rendered')
  assert.equal(inferEvidenceLevel({ identity: { sourceUrl: 'u' }, reviewed: true }), 'reviewed')
})

check('declaring a higher level than the artefacts support is an error', () => {
  const out = buildMotionDoc({
    identity: { name: 'T', sourceUrl: 'https://x/1', license: 'private' },
    keepReplace: [{ fromSeconds: 0, toSeconds: 1, keepZh: '推近', useZh: '新数字', capacity: 8 }],
    evidence: { level: 'reviewed', notesZh: '其实只写完了描述' },
  })
  assert.equal(out.level, 'described')
  assert.ok(out.errors.some((error) => error.includes('高于证据')))
})

check('an unknown evidence level is rejected', () => {
  const out = buildMotionDoc({
    identity: { name: 'T' },
    keepReplace: [{ fromSeconds: 0, toSeconds: 1, keepZh: 'a', useZh: 'b', capacity: 8 }],
    evidence: { level: 'certified' },
  })
  assert.ok(out.errors.some((error) => error.includes('不是已知等级')))
})

/* ------------------------------------------------------------------ *
 * Document assembly
 * ------------------------------------------------------------------ */

function completeInput() {
  return {
    identity: { name: '产品发布复刻', version: '0.1.0', author: 'ops', sourceUrl: 'https://x/status/1', sourceVersion: '2026-11', license: '参考片私研；成片素材自制' },
    brandKit: { productZh: 'Media Senses', palette: ['#101828', '#38bdf8'], fontZh: '微软雅黑', toneZh: '克制', logoPath: 'assets/logo.svg' },
    narrative: { hookZh: '一个数字占住画面', revealZh: '数字→环绕→收拢', endingZh: '左输入右输出' },
    visual: { hierarchyZh: '单主体居中', typeScaleZh: '标题 120px / 副标 40px', contrastZh: '深底亮字' },
    timing: { cutZh: '0–1.5 / 1.5–4 / 4–5 秒', holdZh: '落定 ≥1s', easingZh: 'cubic-bezier(0.34,1.56,0.64,1)', cameraZh: '推近 8%' },
    assets: { mustProvide: ['Logo', '产品截图'], canGenerate: ['音效', '转场'], syncPoints: [{ atSeconds: 1.5, zh: '数字揭开' }] },
    keepReplace: [
      { fromSeconds: 0, toSeconds: 1.5, keepZh: '推近大数字，逐位揭开', useZh: '00:00:20', capacity: 24 },
      { fromSeconds: 1.5, toSeconds: 4, keepZh: '卡片形成圆环', useZh: '九个标签围绕标志', capacity: 18 },
      { fromSeconds: 4, toSeconds: 5, keepZh: '收拢到片尾', useZh: 'Motion MD → MP4', capacity: 20 },
    ],
    clipMap: [{ sourceIn: 12, sourceOut: 18, outputIn: 0 }],
    checkpoints: [{ referenceAt: 0.8, whatZh: '能读到改过的数字' }, { referenceAt: 2.65, whatZh: '两张卡在同一位置' }],
    claims: [
      { textZh: '切点落在 8 拍上', basis: 'observed' },
      { textZh: '观众会先看中央标志', basis: 'inferred' },
      { textZh: '开场数字从 20 秒改成 15 秒', basis: 'changed' },
    ],
    evidence: { notesZh: '还没渲，先出描述版' },
  }
}

check('a complete input produces a document with no errors', () => {
  const out = buildMotionDoc(completeInput())
  assert.deepEqual(out.errors, [], `errors: ${out.errors.join(' | ')}`)
  assert.equal(out.level, 'described')
  assert.equal(out.doc.keepReplace.length, 3)
  assert.equal(out.doc.clipMap.length, 1)
  assert.equal(out.doc.checkpoints.length, 2)
  assert.equal(out.doc.claims.length, 3)
})

check('an empty input is rejected rather than producing a plausible blank', () => {
  const out = buildMotionDoc({})
  assert.ok(out.errors.some((error) => error.includes('name')))
  assert.ok(out.errors.some((error) => error.includes('保持项')))
})

check('claims default to inferred, never to observed', () => {
  const out = buildMotionDoc({
    ...completeInput(),
    claims: [{ textZh: '没有标依据的一句' }],
  })
  assert.equal(out.doc.claims[0].basis, 'inferred')
})

check('the markdown carries the tables a reader acts on', () => {
  const markdown = renderMotionDocMarkdown(buildMotionDoc(completeInput()).doc)
  assert.ok(markdown.includes('# 产品发布复刻 · MOTION.md'))
  assert.ok(markdown.includes('| 时段 | 保留的拍法 | 本片用的内容 | 容量 | 依据 |'))
  assert.ok(markdown.includes('### 源时间 → 输出时间'))
  assert.ok(markdown.includes('| # | 时刻 | 看什么 |'))
  assert.ok(markdown.includes('**观察**'), 'the basis labels must survive into the markdown')
  assert.ok(markdown.includes('**推断**'))
  assert.ok(markdown.includes('**主动改动**'))
  assert.ok(markdown.includes('缩小字号硬塞是禁止的'))
  assert.ok(!markdown.includes('undefined'), 'no undefined may leak into the document')
  assert.ok(!/\n{3,}/u.test(markdown), 'no triple blank lines')
})

check('the markdown is deterministic', () => {
  const a = renderMotionDocMarkdown(buildMotionDoc(completeInput()).doc)
  const b = renderMotionDocMarkdown(buildMotionDoc(completeInput()).doc)
  assert.equal(a, b)
})

/* ------------------------------------------------------------------ *
 * Validating a document read back from disk
 * ------------------------------------------------------------------ */

check('validateMotionDoc reports missing sections and bad tables', () => {
  const report = validateMotionDoc({ keepReplace: [], clipMap: [] })
  assert.ok(report.errors.some((error) => error.includes('身份与来源')))
  assert.ok(report.errors.some((error) => error.includes('保持项')))
  assert.ok(report.warnings.some((warning) => warning.includes('证据等级')))
  assert.ok(report.warnings.some((warning) => warning.includes('检查点')))
})

check('a document round-trips through JSON and still validates', () => {
  const { doc } = buildMotionDoc(completeInput())
  const back = JSON.parse(JSON.stringify(doc))
  const report = validateMotionDoc(back)
  assert.deepEqual(report.errors, [], `errors: ${report.errors.join(' | ')}`)
  assert.equal(report.level, 'described')
})

check('validateMotionDoc refuses a non-object', () => {
  assert.throws(() => validateMotionDoc(null), /需要/u)
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
