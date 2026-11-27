/**
 * 把镜头库渲染成 mp4。
 *
 * 用法：
 *   node demo/riemann/build-clips.mjs                 # 渲染全部
 *   node demo/riemann/build-clips.mjs money-explicit  # 只渲指定镜头
 *   node demo/riemann/build-clips.mjs --list          # 列出镜头与时长
 *
 * 产物：demo/output/riemann/clips/<id>.mp4 + manifest.json
 * 分辨率/帧率：1920×1080 @ 30fps（与最终成片一致，避免二次缩放）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeWorkDir, removeWorkDir, resolveTools } from '../../lib/ffmpeg.js'
import { renderAnimation } from '../../lib/htmlrender.js'
import { buildHtml } from './kit.mjs'
import { CLIPS as CORE_CLIPS } from './clips.mjs'
import { BEATS, scheduleCards } from './beats.mjs'

/**
 * 镜头来源：clips.mjs（核心）+ 各批次的 clips-batch-*.mjs（并行生产）。
 * 同名键以后加载的为准，方便单人覆盖某个镜头而不改别人的文件。
 */
const CLIPS = { ...CORE_CLIPS }
for (const batch of ['a', 'b', 'c', 'd']) {
  const file = `./clips-batch-${batch}.mjs`
  if (!existsSync(join(import.meta.dirname, `clips-batch-${batch}.mjs`))) continue
  try {
    const mod = await import(file)
    Object.assign(CLIPS, mod.CLIPS ?? mod.default ?? {})
  } catch (error) {
    console.log(`  batch ${batch} skipped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

const WIDTH = 1920
const HEIGHT = 1080
const FPS = 30

const tools = await resolveTools({})
const outDir = resolve('demo/output/riemann/clips')
await mkdir(outDir, { recursive: true })

/**
 * 渲染锁：headless Edge + CDP 一次只适合跑一个渲染实例。
 *
 * 实测教训：4 个渲染并发时累积出 70 个 msedge 进程，渲染卡住不动。
 * 这里用「原子创建锁文件」做互斥，进程退出时释放；锁过期（20 分钟）视为崩溃残留。
 */
const LOCK_PATH = join(outDir, '.render.lock')
const LOCK_TIMEOUT_MS = 20 * 60 * 1000
async function acquireLock() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      await writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = await readFile(LOCK_PATH, 'utf8').catch(() => '')
      let stale = false
      try {
        const parsed = JSON.parse(info)
        stale = Date.now() - Number(parsed.at) > LOCK_TIMEOUT_MS
      } catch {
        stale = true
      }
      if (stale) {
        await writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() })).catch(() => {})
        return true
      }
      if (attempt === 0) console.log('  另一个渲染正在进行，排队等待…')
      await new Promise((done) => setTimeout(done, 2000))
    }
  }
  return false
}
async function releaseLock() {
  const { rm } = await import('node:fs/promises')
  await rm(LOCK_PATH, { force: true }).catch(() => {})
}
const args = process.argv.slice(2)
if (args.includes('--list')) {
  for (const [id, clip] of Object.entries(CLIPS)) {
    console.log(`${id.padEnd(24)} ${String(clip.seconds).padStart(5)}s  ${String(Math.round(clip.seconds * FPS)).padStart(5)} frames`)
  }
  process.exit(0)
}

// 拿到渲染锁之后才允许启动 headless Edge。`--no-lock` 供 Lead 手动串行调度时跳过。
if (!args.includes('--no-lock')) {
  const got = await acquireLock()
  if (!got) throw new Error('等锁超时：请确认没有卡住的渲染进程')
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      releaseLock().finally(() => process.exit(130))
    })
  }
}

const wanted = args.filter((value) => !value.startsWith('--'))
const ids = wanted.length > 0 ? wanted : Object.keys(CLIPS)
const missing = ids.filter((id) => CLIPS[id] === undefined)
if (missing.length > 0) throw new Error(`未知镜头：${missing.join(', ')}`)

const manifestPath = join(outDir, 'manifest.json')
const manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {}

const startedAll = Date.now()
for (const id of ids) {
  const clip = CLIPS[id]
  const beat = BEATS.find((entry) => entry.clip === id)
  if (beat === undefined) {
    console.log(`${id.padEnd(24)} WARN: beats.mjs 里没有镜头 ${id} 对应的段落，将不带字幕渲染`)
  }
  const cards = beat === undefined ? [] : scheduleCards(beat.cards, beat.seconds)
  const htmlPath = join(outDir, `${id}.html`)
  const output = join(outDir, `${id}.mp4`)
  await writeFile(htmlPath, buildHtml(clip.code, { title: id, cards }), 'utf8')

  const workDir = await makeWorkDir(`riemann-${id}`)
  const started = Date.now()
  try {
    const result = await renderAnimation({
      tools,
      htmlPath,
      output,
      workDir,
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      duration: clip.seconds,
    })
    const seconds = (Date.now() - started) / 1000
    manifest[id] = {
      id,
      seconds: clip.seconds,
      frames: result.frames,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      bytes: result.bytes,
      renderSeconds: Math.round(seconds * 10) / 10,
      path: output,
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    console.log(
      `${id.padEnd(24)} ${String(clip.seconds).padStart(5)}s  ` +
        `${String(result.frames).padStart(5)}f  ${seconds.toFixed(1)}s render  ` +
        `${(seconds / Math.max(1, result.frames)).toFixed(3)}s/frame`,
    )
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      for (const warning of result.warnings.slice(0, 3)) console.log(`    warn: ${warning}`)
    }
  } catch (error) {
    console.log(`${id.padEnd(24)} FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    await removeWorkDir(workDir)
  }
}
console.log(`\ntotal render time: ${((Date.now() - startedAll) / 1000 / 60).toFixed(1)} min`)
await releaseLock()
