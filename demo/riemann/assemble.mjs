/**
 * 把 11 个镜头、原创配乐、音效合成一支成片。
 *
 * 全片无旁白：信息由镜头内烧进去的字幕承担（已在渲染时画好），
 * 所以这里只负责「视频段顺序 + 配乐 + 音效 + 响度」。
 *
 * 用法：
 *   node demo/riemann/assemble.mjs --score      # 只生成配乐
 *   node demo/riemann/assemble.mjs --plan       # 只打印时间线，不渲染
 *   node demo/riemann/assemble.mjs              # 生成配乐 + 渲染成片
 *   node demo/riemann/assemble.mjs --no-score   # 复用已有配乐
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeWorkDir, removeWorkDir, resolveTools } from '../../lib/ffmpeg.js'
import { buildVideo } from '../../lib/build.js'
import { buildScore, writeScoreWav } from '../../lib/music.js'
import { synthesizeSfx, writeSfxWav, measureSfxPeakLag } from '../../lib/sfx.js'
import { BEATS, TOTAL_SECONDS } from './beats.mjs'

const tools = await resolveTools({})
const outDir = resolve('demo/output/riemann')
const clipsDir = join(outDir, 'clips')
const assetsDir = join(outDir, 'assets')
await mkdir(assetsDir, { recursive: true })

const argv = process.argv.slice(2)
const scoreOnly = argv.includes('--score')
const planOnly = argv.includes('--plan')
const reuseScore = argv.includes('--no-score')

/* ------------------------------------------------------------------ *
 * 1. 时间线
 * ------------------------------------------------------------------ */

let cursor = 0
const timeline = BEATS.map((beat) => {
  const start = cursor
  cursor += beat.seconds
  return {
    id: beat.id,
    title: beat.title,
    clip: beat.clip,
    start: Math.round(start * 1000) / 1000,
    seconds: beat.seconds,
    end: Math.round(cursor * 1000) / 1000,
    mood: beat.mood,
    sfx: beat.sfx ?? [],
  }
})
const total = Math.round(cursor * 1000) / 1000

/** 情绪弧：整片的配乐按这张表走，不是随机铺。 */
const MOOD_BY_SEGMENT = {
  s00: 'intimate',
  s01: 'steady',
  s02: 'steady',
  s03: 'steady',
  s04: 'contemplative',
  s05: 'contemplative',
  s06: 'driving',
  s07: 'ascendant',
  s08: 'contemplative',
  s09: 'ascendant',
  s10: 'resolve',
}

console.log('时间线：')
for (const entry of timeline) {
  console.log(`  ${entry.id.padEnd(5)} ${String(entry.start).padStart(7)}s → ${String(entry.end).padStart(7)}s  ${String(entry.seconds).padStart(3)}s  ${entry.clip.padEnd(18)} ${MOOD_BY_SEGMENT[entry.id] ?? 'steady'}`)
}
console.log(`  合计 ${total}s = ${(total / 60).toFixed(1)} min`)
if (planOnly) process.exit(0)

/* ------------------------------------------------------------------ *
 * 2. 配乐（原创，程序化合成）
 * ------------------------------------------------------------------ */

const scorePath = join(assetsDir, 'score.wav')
if (!reuseScore) {
  const sections = timeline.map((entry) => ({
    fromSeconds: entry.start,
    toSeconds: entry.end,
    mood: MOOD_BY_SEGMENT[entry.id] ?? 'steady',
    gain: entry.id === 's00' ? 0.8 : entry.id === 's10' ? 0.9 : 1,
    labelZh: entry.title,
  }))
  console.log('\n生成配乐…')
  const started = Date.now()
  const written = await writeScoreWav(scorePath, {
    durationSeconds: total + 2,
    sections,
    progression: 'cinematic',
    tonicMidi: 57, // A3，A 小调
    seed: 20261120,
    peakDb: -8,
    reverbMix: 0.3,
  })
  console.log(`  配乐 ${(written.durationSeconds / 60).toFixed(1)} min · ${Math.round(written.bytes / 1024 / 1024 * 10) / 10} MB · ${((Date.now() - started) / 1000).toFixed(1)}s`)
} else {
  console.log('\n复用已有配乐')
}

/* ------------------------------------------------------------------ *
 * 3. 音效：按段合成，钉在段内相对时间上
 * ------------------------------------------------------------------ */

console.log('\n合成音效…')
const sfxEntries = []
let sfxSeed = 8000
for (const entry of timeline) {
  for (const item of entry.sfx) {
    const kind = item.kind
    const rendered = synthesizeSfx(kind, { seed: sfxSeed++ })
    const path = join(assetsDir, `sfx-${entry.id}-${kind}.wav`)
    const written = await writeSfxWav(path, rendered.samples, rendered.sampleRate, { peakDb: -3 })
    const lag = measureSfxPeakLag(rendered.samples, rendered.sampleRate)
    sfxEntries.push({
      src: written.path,
      at: Math.round((entry.start + item.at) * 1000) / 1000,
      gain: item.gain ?? 0.2,
      // 音效的能量峰常常不在文件头，按峰值对齐才不会晚到。
      peakLag: Math.round(lag.peakSeconds * 1000) / 1000,
    })
  }
}
console.log(`  ${sfxEntries.length} 条音效`)

/* ------------------------------------------------------------------ *
 * 4. 渲染计划
 * ------------------------------------------------------------------ */

const missing = timeline.filter((entry) => !existsSync(join(clipsDir, `${entry.clip}.mp4`)))
if (missing.length > 0) {
  console.log(`\n缺少 ${missing.length} 个镜头，先补齐：${missing.map((entry) => entry.clip).join(', ')}`)
  process.exitCode = 2
  process.exit(2)
}

const plan = {
  output: join(outDir, 'riemann-hypothesis.mp4'),
  width: 1920,
  height: 1080,
  fps: 30,
  background: '#05070d',
  loudnessTarget: -16,
  scenes: timeline.map((entry) => ({
    type: 'video',
    src: join(clipsDir, `${entry.clip}.mp4`),
    duration: entry.seconds,
    transitionIn: 'cut',
  })),
  audio: {
    music: scorePath,
    musicVolumeDb: -22,
    musicFadeOut: 4,
    duck: false, // 没有旁白，不需要闪避
    sfx: sfxEntries,
  },
}

const planPath = join(outDir, 'render-plan.json')
await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8')
console.log(`\n计划已写入 ${planPath}`)

if (argv.includes('--write-plan-only')) process.exit(0)

/* ------------------------------------------------------------------ *
 * 5. 渲染
 * ------------------------------------------------------------------ */

const workDir = await makeWorkDir('riemann-assemble')
const started = Date.now()
try {
  console.log('渲染成片…')
  const result = await buildVideo({ tools, plan, workDir })
  const minutes = (Date.now() - started) / 1000 / 60
  console.log(`\n成片：${result.output}`)
  console.log(`  ${result.duration.toFixed(1)}s · ${result.width}×${result.height} @ ${result.fps}fps · ${(result.bytes / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  渲染耗时 ${minutes.toFixed(1)} min`)
  if (result.warnings.length > 0) {
    console.log('  警告：')
    for (const warning of result.warnings.slice(0, 8)) console.log(`    - ${warning}`)
  }
} catch (error) {
  console.log(`\n渲染失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await removeWorkDir(workDir)
}
