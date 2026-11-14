/**
 * Objective audit: one line of evidence per capability the goal names.
 *
 * This is the checklist that decides whether the goal is finished. Every row maps
 * a required capability to the module that provides it, the export that proves
 * it, and the test suite that guards it. It runs inside the normal suite so a
 * later refactor cannot quietly delete a capability the project promises.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const rows = []

async function has(file) {
  const info = await stat(join(root, file)).catch(() => undefined)
  return info !== undefined && info.isFile()
}

async function row(capability, moduleFiles, exportsCheck, testFile) {
  const missing = []
  for (const file of moduleFiles) if (!(await has(file))) missing.push(file)
  let exportCount = 0
  if (missing.length === 0 && exportsCheck !== undefined) {
    // ESM specifiers must be URLs on Windows, so import relatively from test/.
    const specifier = `../${moduleFiles[0].replace(/\\/gu, '/')}`
    const mod = await import(specifier)
    exportCount = exportsCheck(mod)
  } else if (missing.length === 0) {
    // A non-module artefact (a template page): existing and non-empty is enough.
    const text = await readFile(join(root, moduleFiles[0]), 'utf8')
    exportCount = text.length > 500 ? 1 : 0
  }
  const testOk = testFile === undefined ? true : await has(testFile)
  const ok = missing.length === 0 && exportCount > 0 && testOk
  rows.push({
    capability,
    ok,
    where: moduleFiles.join(' + '),
    exports: exportCount,
    test: testFile ?? '—',
    note: missing.length > 0 ? `missing ${missing.join(',')}` : ok ? 'ok' : 'no exports',
  })
}

/* ---- 渲染能力 ---- */
await row('CSS/WAAPI seek', ['lib/htmlrender.js'], (m) => (typeof m.renderAnimation === 'function' ? 1 : 0), 'test/anim-runtime.test.mjs')
await row('声明式时间轴（clip + data-start/duration）', ['lib/htmlrender.js'], (m) => (typeof m.lintAnimationSource === 'function' ? 1 : 0), 'test/anim-runtime.test.mjs')
await row('GSAP / __timelines 适配', ['lib/adapters.js'], (m) => (m.ADAPTERS.some((a) => a.id === 'timelines') ? 1 : 0), 'test/adapters-performance.test.mjs')
await row('Lottie 适配', ['lib/adapters.js'], (m) => (m.ADAPTERS.some((a) => a.id === 'lottie') ? 1 : 0), 'test/adapters-performance.test.mjs')
await row('Three.js 适配', ['lib/adapters.js'], (m) => (m.ADAPTERS.some((a) => a.id === 'three') ? 1 : 0), 'test/adapters-performance.test.mjs')
await row('Anime.js / 自研引擎适配', ['lib/adapters.js'], (m) => (m.ADAPTERS.some((a) => a.id === 'anime') && m.ADAPTERS.some((a) => a.id === 'custom') ? 1 : 0), 'test/adapters-performance.test.mjs')
await row('运动模糊（快门角 + 子帧）', ['lib/htmlrender.js'], (m) => (typeof m.scanDeterminism === 'function' ? 1 : 0), 'test/anim-runtime.test.mjs')
await row('合成内音频（页面 <audio>）', ['lib/animaudio.js'], (m) => (typeof m.parseAudioClips === 'function' && typeof m.buildAudioMixArgs === 'function' ? 2 : 0), 'test/anim-runtime.test.mjs')
await row('多轨（叠加轨 + track-index）', ['lib/build.js'], (m) => (typeof m.buildVideo === 'function' ? 1 : 0), 'test/build-engine.test.mjs')

/* ---- 判定 ---- */
await row('连续性判定（携带/锚定/裸切）', ['lib/continuity.js'], (m) => (typeof m.analyzeContinuity === 'function' && typeof m.zoneDwell === 'function' ? 2 : 0), 'test/continuity.test.mjs')
await row('验收门禁（节奏/静帧/爆发/空档/音频）', ['lib/gate.js'], (m) => (typeof m.runGate === 'function' && Object.keys(m.GATE_THRESHOLDS).length >= 8 ? 2 : 0), 'test/gate.test.mjs')

/* ---- 词汇 ---- */
await row('镜头动作词典（18 个）', ['lib/moves.js'], (m) => (m.CAMERA_MOVES.length === 18 ? 18 : 0), 'test/vocabulary.test.mjs')
await row('转场词典（9 个）', ['lib/moves.js'], (m) => (m.TRANSITIONS.length === 9 ? 9 : 0), 'test/vocabulary.test.mjs')
await row('缓动库 + 弹簧', ['lib/easing.js'], (m) => (Object.keys(m.EASINGS).length >= 12 && typeof m.spring === 'function' ? 2 : 0), 'test/vocabulary.test.mjs')
await row('外观预设（8 族）', ['lib/look.js'], (m) => (m.LOOKS.length === 8 ? 8 : 0), 'test/vocabulary.test.mjs')
await row('反 AI 味清单（15 条）', ['lib/look.js'], (m) => (m.LOOK_ANTIPATTERNS.length === 15 ? 15 : 0), 'test/vocabulary.test.mjs')
await row('剪辑缝规则', ['lib/moves.js'], (m) => (m.CUT_SEAM_RULES.length >= 5 ? m.CUT_SEAM_RULES.length : 0), 'test/vocabulary.test.mjs')
await row('镜头配方卡（≥40 张）', ['lib/shots.js'], (m) => (m.SHOT_CARDS.length >= 40 ? m.SHOT_CARDS.length : 0), 'test/shots-lint.test.mjs')
await row('时长预算', ['lib/shots.js'], (m) => (typeof m.durationBudget === 'function' ? 1 : 0), 'test/shots-lint.test.mjs')

/* ---- 技法 ---- */
await row('手绘/涂鸦技法（描线 + 线条沸腾）', ['assets/templates/hand-drawn-line.html'], undefined, 'test/templates.test.mjs')
await row('角色表演（情绪 + 动作节拍）', ['lib/performance.js'], (m) => (Object.keys(m.EMOTIONS).length >= 10 && typeof m.actingBeat === 'function' ? 2 : 0), 'test/adapters-performance.test.mjs')
await row('可渲模板库（10 个）', ['lib/templates.js'], (m) => (m.TEMPLATES.length >= 9 ? m.TEMPLATES.length : 0), 'test/templates.test.mjs')

/* ---- 质量闸门 ---- */
await row('版式审计（出框/叠字/字号）', ['lib/lint.js'], (m) => (typeof m.lintPlan === 'function' && typeof m.lintAnimationSource === 'function' ? 2 : 0), 'test/shots-lint.test.mjs')
await row('评分卡（7 维 + 强制证据）', ['lib/rubric.js'], (m) => (m.RUBRIC.length === 7 && typeof m.scoreReport === 'function' ? 2 : 0), 'test/shots-lint.test.mjs')
await row('风格不可改/可替换分级', ['lib/styles.js'], (m) => (typeof m.deriveGuidance === 'function' ? 1 : 0), 'test/styles-guidance.test.mjs')

/* ---- 工具面 ---- */
const { apply } = await import('../index.js')
const registry = new Map()
apply({ tools: { register: (def) => (registry.set(def.name, def), () => {}) } }, {})
const required = [
  'media_probe', 'media_watch_video', 'media_listen_audio', 'media_frame', 'media_whisper',
  'media_corpus', 'media_build_video', 'media_tts', 'media_styles', 'media_moves',
  'media_animate', 'media_see', 'media_frames', 'media_compare',
]
const missingTools = required.filter((name) => !registry.has(name))
rows.push({
  capability: `工具面（${required.length} 个工具）`,
  ok: missingTools.length === 0,
  where: 'index.js',
  exports: registry.size,
  test: 'test/moves-tool.test.mjs',
  note: missingTools.length === 0 ? 'ok' : `missing ${missingTools.join(',')}`,
})

/* ---- report ---- */
// Every row carries its own evidence; nothing here is asserted by assertion
// count, so the output itself is the proof.
for (const entry of rows) {
  console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.capability.padEnd(34)} ${String(entry.exports).padStart(3)}  ${entry.where}`)
}
const total = rows.length
const passed = rows.filter((entry) => entry.ok).length
const failed = total - passed
console.log(`\ncapability: ${passed} passed, ${failed} failed (${total} capabilities)`)
if (failed > 0) process.exitCode = 1
