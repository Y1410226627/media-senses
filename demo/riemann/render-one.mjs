/**
 * 单个镜头渲染器（带进度输出，供 Lead 手动串行调度）。
 *
 * 与 build-clips.mjs 的区别：直接渲染、不排队、不吞输出，每 10% 打一行，
 * 出错立刻打印完整堆栈。用来排查「卡住但没有任何输出」的情况。
 *
 * 用法：node demo/riemann/render-one.mjs <clipId> [--keep] [--no-determinism]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { makeWorkDir, removeWorkDir, resolveTools } from '../../lib/ffmpeg.js'
import { renderAnimation } from '../../lib/htmlrender.js'
import { buildHtml } from './kit.mjs'
import { CLIPS as CORE } from './clips.mjs'
import { BEATS, scheduleCards } from './beats.mjs'

const argv = process.argv.slice(2)
const id = argv.find((value) => !value.startsWith('--'))
if (!id) throw new Error('用法: node demo/riemann/render-one.mjs <clipId>')

const CLIPS = { ...CORE }
for (const batch of ['a', 'b', 'c', 'd']) {
  try {
    const mod = await import(`./clips-batch-${batch}.mjs`)
    Object.assign(CLIPS, mod.CLIPS ?? mod.default ?? {})
  } catch {
    /* 该批次不存在 */
  }
}
const clip = CLIPS[id]
if (clip === undefined) throw new Error(`没有镜头 ${id}`)

const beat = BEATS.find((entry) => entry.clip === id)
const cards = beat === undefined ? [] : scheduleCards(beat.cards, beat.seconds)

const outDir = resolve('demo/output/riemann/clips')
await mkdir(outDir, { recursive: true })
const htmlPath = join(outDir, `${id}.html`)
const output = join(outDir, `${id}.mp4`)
await writeFile(htmlPath, buildHtml(clip.code, { title: id, cards }), 'utf8')
console.log(`[${id}] html ${(clip.code.length / 1024).toFixed(1)} KB, cards ${cards.length}, duration ${clip.seconds}s`)

const tools = await resolveTools({})
console.log(`[${id}] browser: ffmpeg ok`)

const workDir = await makeWorkDir(`one-${id}`)
const started = Date.now()
let lastTick = 0
// 每 15 秒打一行心跳，确认进程还活着（渲染器没有进度回调）
const heartbeat = setInterval(() => {
  const elapsed = (Date.now() - started) / 1000
  console.log(`  …${elapsed.toFixed(0)}s 仍在渲染（预计 ${(clip.seconds * 0.12).toFixed(0)}s 左右）`)
}, 15000)
try {
  const result = await renderAnimation({
    tools,
    htmlPath,
    output,
    workDir,
    width: 1920,
    height: 1080,
    fps: 30,
    duration: clip.seconds,
    keepFrames: argv.includes('--keep'),
    determinismCheck: !argv.includes('--no-determinism'),
  })
  const seconds = (Date.now() - started) / 1000
  console.log(
    `[${id}] OK ${result.frames} frames in ${seconds.toFixed(1)}s ` +
      `(${(seconds / result.frames).toFixed(3)} s/frame) · ${(result.bytes / 1024 / 1024).toFixed(2)} MB`,
  )
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    console.log(`[${id}] warnings:`)
    for (const warning of result.warnings.slice(0, 6)) console.log(`   - ${warning}`)
  }
  const manifestPath = join(outDir, 'manifest.json')
  const manifest = await import('node:fs/promises')
    .then((fs) => fs.readFile(manifestPath, 'utf8').catch(() => '{}'))
    .then((text) => JSON.parse(text))
  manifest[id] = {
    id,
    seconds: clip.seconds,
    frames: result.frames,
    fps: 30,
    width: 1920,
    height: 1080,
    bytes: result.bytes,
    renderSeconds: Math.round(seconds * 10) / 10,
    path: output,
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
} catch (error) {
  console.log(`[${id}] FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
} finally {
  clearInterval(heartbeat)
  await removeWorkDir(workDir)
}
