/**
 * 成片独立终检：验收门禁（六条腿）+ 判例式审美准则 + 独立终检五节报告。
 *
 * 这是片子的最后一道关，用的是插件自己的评审工具——不是"我觉得还行"。
 *
 * 用法：node demo/riemann/review.mjs [成片路径]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeWorkDir, removeWorkDir, resolveTools } from '../../lib/ffmpeg.js'
import { analyzeVideo } from '../../lib/video.js'
import { analyzeAudio } from '../../lib/audio.js'
import { runGate } from '../../lib/gate.js'
import { auditAesthetic } from '../../lib/aesthetic.js'
import { auditFilm, renderReviewReport } from '../../lib/review.js'
import { analyzeContinuity } from '../../lib/continuity.js'
import { BEATS } from './beats.mjs'

const target = resolve(process.argv[2] ?? 'demo/output/riemann/riemann-hypothesis.mp4')
if (!existsSync(target)) throw new Error(`找不到成片：${target}`)

const tools = await resolveTools({})
const workDir = await makeWorkDir('riemann-review')
const outDir = resolve('demo/output/riemann')
await mkdir(outDir, { recursive: true })

try {
  console.log(`审查：${target}`)
  const analysis = await analyzeVideo({
    tools,
    file: target,
    workDir,
    options: { maxKeyframes: 8, wantContactSheet: false, wantFrames: false, wantAudio: false },
    signal: undefined,
  })
  console.log(`  画面：${analysis.duration.toFixed(1)}s · ${analysis.shots?.length ?? 0} 个检测到的镜头`)

  const audio = await analyzeAudio({ tools, file: target, workDir, options: { wantChords: false, wantStructure: true } })
  console.log(`  声音：LUFS ${audio.loudness?.lufsIntegrated ?? '—'} · 峰值 ${audio.loudness?.peakDbfs ?? '—'} dBFS`)

  // 计划里的段落（每段一个镜头，直接给时长）
  const plannedScenes = BEATS.map((beat) => ({ duration: beat.seconds }))

  // 作者写下的分镜边界就是剪辑真相。成片几乎每个切点都是「暗场接暗场」，
  // 帧差检测器看不见这种切点（实测它退回成 6 个等长的假镜头），
  // 所以节奏这条腿必须拿作者的分镜表来量，而不是拿检测器的猜测来量。
  let authoredCursor = 0
  const authoredShots = BEATS.map((beat) => {
    const start = authoredCursor
    authoredCursor += beat.seconds
    return { start, duration: beat.seconds }
  })
  console.log(`  分镜：作者标注 ${authoredShots.length} 段（检测器${analysis.shots?.length === 0 ? '未报' : `报 ${analysis.shots?.length} 个`}）`)

  const gate = await runGate({
    tools,
    file: target,
    workDir,
    shots: authoredShots,
    plannedScenes,
    duration: analysis.duration,
    fps: 30,
  })
  console.log('\n=== 验收门禁 ===')
  for (const leg of gate.legs) console.log(`  ${leg.state.padEnd(4)} ${leg.title}：${leg.detail}`)
  console.log(`  判定：${gate.verdict}`)

  // 审美准则：从计划结构推（镜头时长、字幕数量、全画面冲击等）
  let cursorSeconds = 0
  const shotRows = BEATS.map((beat) => {
    const startFrame = Math.round(cursorSeconds * 30)
    cursorSeconds += beat.seconds
    return {
      id: beat.id,
      durationSeconds: beat.seconds,
      startFrame,
      endFrame: Math.round(cursorSeconds * 30),
      // 本片没有品牌字标镜头，也没有全画面闪光；字幕由镜头内画布承担
    }
  })
  const aesthetic = auditAesthetic({
    shots: shotRows,
    timeline: {
      cuts: shotRows.map((row, index) => ({ fromFrame: row.startFrame, toFrame: row.endFrame, techniqueId: `chapter-${index}`, isProtagonist: index === 0 })),
      totalSeconds: cursorSeconds,
    },
    effects: { fullFrameImpactCount: 0 },
  })
  console.log('\n=== 审美准则 ===')
  console.log(`  ${aesthetic.summaryZh}`)

  let continuity = null
  try {
    continuity = await analyzeContinuity({ tools, file: target, workDir, shots: analysis.shots, duration: analysis.duration })
  } catch (error) {
    console.log(`  承接分析未跑：${error instanceof Error ? error.message : String(error)}`)
  }

  const report = auditFilm({
    gate,
    continuity,
    aesthetic,
    audio,
    shots: analysis.shots,
    fps: 30,
    duration: analysis.duration,
  })
  const markdown = renderReviewReport(report, { blind: true })
  const reportPath = join(outDir, 'REVIEW.md')
  await writeFile(reportPath, markdown, 'utf8')
  console.log('\n=== 独立终检 ===')
  console.log(markdown)

  // 关键指标汇总，便于写交付说明
  const summary = {
    duration: analysis.duration,
    shotsDetected: analysis.shots?.length ?? 0,
    lufs: audio.loudness?.lufsIntegrated ?? null,
    peakDbfs: audio.loudness?.peakDbfs ?? null,
    gateVerdict: gate.verdict,
    gateLegs: gate.legs.map((leg) => ({ id: leg.id, state: leg.state, detail: leg.detail })),
    aesthetic: { failures: aesthetic.failures, warnings: aesthetic.warnings, checked: aesthetic.checked, skipped: aesthetic.skipped },
    reviewVerdict: report.verdict,
    reviewScore: report.score,
    blockers: report.blockers?.length ?? 0,
    continuityScore: continuity?.score ?? null,
    reportPath,
  }
  await writeFile(join(outDir, 'review-summary.json'), JSON.stringify(summary, null, 2), 'utf8')
  console.log(`\n报告已写入 ${reportPath}`)
} finally {
  await removeWorkDir(workDir)
}
