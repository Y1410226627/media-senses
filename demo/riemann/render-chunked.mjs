/**
 * 分块渲染器：把每个镜头切成 ≤25 秒的块单独渲染，再用 ffmpeg 无损拼接。
 *
 * 为什么分块：headless Edge + CDP 的单次渲染实测在 ~1000 帧附近会卡死
 * （队友在 s01 的 t≈34s / 约 1022 帧断连，重建会话后正常）。分块把每次
 * 渲染压到 750 帧以内，代价是多一次浏览器启动，换来的是可观测、可重试。
 *
 * 块的「时间偏移」通过注入 OFFSET 实现：页面里 renderAt(t) 收到的是块内时间，
 * 真实时间 T = t + OFFSET，所以动画与字幕在拼接后仍然连续。
 *
 * 用法：
 *   node demo/riemann/render-chunked.mjs                # 渲染全部缺失/过旧的镜头
 *   node demo/riemann/render-chunked.mjs sieve          # 只渲指定镜头
 *   node demo/riemann/render-chunked.mjs --force sieve  # 强制重渲
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeWorkDir, removeWorkDir, resolveTools, run } from '../../lib/ffmpeg.js'
import { renderAnimation } from '../../lib/htmlrender.js'
import { buildHtml } from './kit.mjs'
import { CLIPS as CORE } from './clips.mjs'
import { BEATS, scheduleCards } from './beats.mjs'

const CHUNK_SECONDS = 8
const WIDTH = 1280
const HEIGHT = 720
const FPS = 30

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const wanted = argv.filter((value) => !value.startsWith('--'))

const CLIPS = { ...CORE }
for (const batch of ['a', 'b', 'c', 'd']) {
  try {
    const mod = await import(`./clips-batch-${batch}.mjs`)
    Object.assign(CLIPS, mod.CLIPS ?? mod.default ?? {})
  } catch {
    /* 批次不存在 */
  }
}

const tools = await resolveTools({})
const outDir = resolve('demo/output/riemann/clips')
const chunkDir = resolve('demo/output/riemann/chunks')
await mkdir(outDir, { recursive: true })
await mkdir(chunkDir, { recursive: true })

const ids = wanted.length > 0 ? wanted : Object.keys(CLIPS)
const startedAll = Date.now()
const summary = []

for (const id of ids) {
  const clip = CLIPS[id]
  if (clip === undefined) {
    console.log(`${id}: 未知镜头`)
    continue
  }
  const output = join(outDir, `${id}.mp4`)
  if (!force && existsSync(output)) {
    console.log(`${id.padEnd(16)} 已存在，跳过（--force 可强制重渲）`)
    continue
  }

  const beat = BEATS.find((entry) => entry.clip === id)
  const cards = beat === undefined ? [] : scheduleCards(beat.cards, beat.seconds)
  const chunks = Math.ceil(clip.seconds / CHUNK_SECONDS)
  console.log(`\n${id}  ${clip.seconds}s → ${chunks} 块（每块 ≤${CHUNK_SECONDS}s）`)

  const chunkFiles = []
  let failed = null
  for (let index = 0; index < chunks; index += 1) {
    const offset = index * CHUNK_SECONDS
    const duration = Math.min(CHUNK_SECONDS, clip.seconds - offset)
    const htmlPath = join(chunkDir, `${id}-c${index}.html`)
    const chunkMp4 = join(chunkDir, `${id}-c${index}.mp4`)
    // 注入 OFFSET：页面内 t 是块内时间，真实时间 = t + offset
    const wrapped = `const T = t + ${offset};\n  t = T;\n${clip.code}`
    await writeFile(htmlPath, buildHtml(wrapped, { title: `${id}-${index}`, cards, width: WIDTH, height: HEIGHT }), 'utf8')

    const workDir = await makeWorkDir(`chunk-${id}-${index}`)
    const t0 = Date.now()
    try {
      const result = await renderAnimation({
        tools,
        htmlPath,
        output: chunkMp4,
        workDir,
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        duration,
        keepFrames: false,
        determinismCheck: false, // 画布用了渐变/高光，GPU 光栅化逐帧并非逐位一致；确定性靠固定种子与无随机 API 保证
      })
      const seconds = (Date.now() - t0) / 1000
      console.log(
        `  块 ${String(index + 1).padStart(2)}/${chunks}  ${offset}–${offset + duration}s  ` +
          `${result.frames}f  ${seconds.toFixed(1)}s  ${(seconds / result.frames).toFixed(3)} s/f`,
      )
      if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        for (const warning of result.warnings.slice(0, 2)) console.log(`       warn: ${warning}`)
      }
      chunkFiles.push(chunkMp4)
    } catch (error) {
      failed = `块 ${index} 失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
      console.log(`  ${failed}`)
      break
    } finally {
      await removeWorkDir(workDir)
      await rm(htmlPath, { force: true }).catch(() => {})
    }
  }

  if (failed !== null || chunkFiles.length !== chunks) {
    console.log(`  ${id} 未完成，跳过拼接`)
    process.exitCode = 1
    summary.push({ id, ok: false })
    continue
  }

  // 无损拼接：所有块同分辨率/帧率/编码参数，用 concat demuxer + 重编码保证时间基一致
  const listPath = join(chunkDir, `${id}-list.txt`)
  await writeFile(listPath, chunkFiles.map((file) => `file '${file.replace(/\\/g, '/')}'`).join('\n'), 'utf8')
  const concatArgs = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', `${id}-list.txt`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), `${id}.mp4`,
  ]
  await run(tools.ffmpeg, concatArgs, { cwd: chunkDir, timeoutMs: 900_000 })
  // 拼接产物写在 chunks/ 里，必须搬到 clips/ 才是镜头成品。
  // （曾经忘搬：日志打印「✓ xxx.mp4」但 clips/ 里没有文件。）
  const concatenated = join(chunkDir, `${id}.mp4`)
  await cp(concatenated, output)
  await rm(concatenated, { force: true }).catch(() => {})
  await rm(listPath, { force: true }).catch(() => {})
  for (const file of chunkFiles) await rm(file, { force: true }).catch(() => {})

  const probe = await run(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'default=nw=1', output], { cwd: chunkDir })
  const duration = Number(/duration=([\d.]+)/u.exec(probe.stdout)?.[1] ?? 0)
  const size = Number(/size=(\d+)/u.exec(probe.stdout)?.[1] ?? 0)
  console.log(`  ✓ ${id}.mp4  ${duration.toFixed(2)}s  ${(size / 1024 / 1024).toFixed(1)} MB`)

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{}'))
  manifest[id] = { id, seconds: clip.seconds, renderedSeconds: duration, frames: Math.round(duration * FPS), fps: FPS, width: WIDTH, height: HEIGHT, bytes: size, chunks, path: output }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  summary.push({ id, ok: true, seconds: duration })
}

console.log(`\n合计耗时 ${((Date.now() - startedAll) / 1000 / 60).toFixed(1)} min`)
const bad = summary.filter((entry) => !entry.ok)
console.log(`完成 ${summary.length - bad.length}/${summary.length}${bad.length > 0 ? ` · 失败：${bad.map((entry) => entry.id).join(', ')}` : ''}`)
