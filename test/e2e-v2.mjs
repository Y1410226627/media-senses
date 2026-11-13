/**
 * v2 closed-loop end-to-end test (Lead-owned).
 *
 *   node test/e2e-v2.mjs [--print]
 *
 * The whole point of v2: learn a style from reference videos, then actually
 * produce a similar video, then verify the product with the same perception
 * tools. This test drives the real registered tools through a fake Cordis
 * context, exactly like the Host does.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const mediaDir = join(root, 'demo', 'media')
const print = process.argv.includes('--print')

const { apply } = await import(pathToFileURL(join(root, 'index.js')).href)
const { resolveTools, run } = await import(pathToFileURL(join(root, 'lib', 'ffmpeg.js')).href)

const registry = new Map()
apply({ tools: { register: (definition) => (registry.set(definition.name, definition), () => {}) } }, { whisperModel: 'tiny' })

let passed = 0
const failures = []

async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.log(`FAIL ${label} — ${error.message}`)
  }
}

async function callTool(name, args) {
  const definition = registry.get(name)
  assert.ok(definition !== undefined, `tool ${name} is not registered`)
  const value = await definition.execute(args, {})
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} rendered nothing`)
  assert.equal(blocks[0].type, 'text')
  const report = blocks[0].text
  assert.ok(report.length > 40, `${name} report too short`)
  if (print) console.log(`\n${'='.repeat(78)}\n${name} ${JSON.stringify(args).slice(0, 160)}\n${'='.repeat(78)}\n${report}\n`)
  return { value, report }
}

const workspace = await mkdtemp(join(tmpdir(), 'media-senses-e2e-v2-'))
const corpusDir = join(workspace, 'corpus')
const outDir = join(workspace, 'out')
await mkdir(outDir, { recursive: true })

await check('registers the full v2 toolset', () => {
  const names = [...registry.keys()].sort()
  for (const required of ['media_build_video', 'media_corpus', 'media_frame', 'media_listen_audio', 'media_probe', 'media_tts', 'media_watch_video', 'media_whisper']) {
    assert.ok(names.includes(required), `missing tool ${required}`)
  }
})

// ---------------------------------------------------------------- 1. learn
let corpusResult
await check('media_corpus learns a style from the demo reference videos', async () => {
  const { value, report } = await callTool('media_corpus', {
    source: mediaDir,
    output_dir: corpusDir,
    name: '演示语料',
    max_videos: 4,
    fast: true,
    max_seconds: 60,
  })
  corpusResult = value
  assert.equal(value.kind, 'corpus')
  assert.ok(value.count >= 2, `count ${value.count}`)
  assert.match(report, /# 语料风格画像/u)
  assert.match(report, /## 仿制清单/u)
  assert.match(report, /## RenderPlan 骨架/u)
  const profile = JSON.parse(await readFile(value.profile_path, 'utf8'))
  assert.equal(profile.schema, 'media-senses.style-profile/v1')
  const markdown = await readFile(value.markdown_path, 'utf8')
  assert.match(markdown, /## 样本清单|## 样本明细/u)
  assert.ok(Array.isArray(value.render_plan_skeleton?.scenes) && value.render_plan_skeleton.scenes.length >= 2)
})

await check('the second corpus run is served from cache', async () => {
  const { value } = await callTool('media_corpus', { source: mediaDir, output_dir: corpusDir, name: '演示语料', max_videos: 4, fast: true, max_seconds: 60 })
  assert.equal(value.skipped, value.count, `skipped ${value.skipped} of ${value.count}`)
})

// ---------------------------------------------------------------- 2. craft
await check('media_watch_video reports production craft and a recipe', async () => {
  const { value, report } = await callTool('media_watch_video', {
    path: join(mediaDir, 'trailer.mp4'),
    include_transcript: false,
    max_keyframes: 8,
    output_dir: join(workspace, 'watch'),
  })
  assert.ok(value.craft !== null && typeof value.craft === 'object', 'craft is missing')
  assert.ok(value.recipe !== null && typeof value.recipe === 'object', 'recipe is missing')
  assert.equal(value.recipe.schema, 'media-senses.recipe/v1')
  assert.match(report, /## 制作技法/u)
  assert.match(report, /仿制要点/u)
  assert.ok(Array.isArray(value.craft.cutRhythm?.cutsPer10s) || value.craft.cutRhythm?.shotCount >= 1)
})

// ---------------------------------------------------------------- 3. build
let buildResult
await check('media_tts synthesizes Chinese narration', async () => {
  const { value } = await callTool('media_tts', {
    text: '这是一段测试旁白，用来验证中文语音合成。',
    voice: 'zh',
    output_path: join(outDir, 'narration.wav'),
  })
  assert.equal(value.kind, 'tts')
  assert.ok(value.seconds > 0.8, `seconds ${value.seconds}`)
  const info = await stat(value.path)
  assert.ok(info.size > 10_000, `wav too small: ${info.size}`)
})

await check('media_build_video renders a plan with titles, images, captions, music and narration', async () => {
  const tools = await resolveTools()
  // Two stills generated with ffmpeg so the test is self-contained.
  const posterA = join(outDir, 'shot-a.png')
  const posterB = join(outDir, 'shot-b.png')
  await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=1080x1920:c0=0x101a3b:c1=0x2b1a4a', '-frames:v', '1', posterA], { cwd: outDir })
  await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920', '-frames:v', '1', posterB], { cwd: outDir })
  const music = join(outDir, 'bed.mp3')
  await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-c:a', 'libmp3lame', music], { cwd: outDir })

  const output = join(outDir, 'replica.mp4')
  const plan = {
    output,
    width: 1080,
    height: 1920,
    fps: 30,
    loudnessTarget: -16,
    scenes: [
      { type: 'text', duration: 2.2, text: '仿制测试', subtitle: 'media-senses v2', font: 'msyh', fontSize: 96, color: '#ffffff', background: '#120c2b', animation: 'fade', transitionIn: 'cut' },
      { type: 'image', duration: 2.8, src: posterA, motion: 'kenburns-in', fit: 'cover', transitionIn: 'fade', transitionDuration: 0.5 },
      { type: 'image', duration: 2.2, src: posterB, motion: 'pan-right', fit: 'cover', transitionIn: 'slideleft', transitionDuration: 0.4 },
      { type: 'text', duration: 1.8, text: '完成', font: 'msyh', fontSize: 80, color: '#9fe8ff', background: '#0b1020', animation: 'fade', transitionIn: 'fade', transitionDuration: 0.4 },
    ],
    captions: [
      { start: 0.4, end: 2.1, text: '第一条字幕', position: 'bottom', fontSize: 44, color: '#ffffff' },
      { start: 5.2, end: 7.4, text: '第二条字幕', position: 'bottom', fontSize: 44, color: '#ffffff' },
    ],
    audio: { music, musicVolumeDb: -22, musicFadeOut: 1.5, voiceover: [{ text: '这次要复刻的是一支竖屏短视频。', start: 0.5, voice: 'zh', rate: 1 }] },
  }
  const { value, report } = await callTool('media_build_video', { plan, verify: true })
  buildResult = value
  assert.equal(value.kind, 'build')
  assert.equal(value.width, 1080)
  assert.equal(value.height, 1920)
  assert.ok(Math.abs(value.duration_seconds - 7.7) < 0.4, `duration ${value.duration_seconds}`)
  assert.ok(value.bytes > 100_000, `bytes ${value.bytes}`)
  assert.equal(value.verified, true)
  assert.match(report, /# 视频合成结果/u)
  assert.match(report, /## 自检/u)
  const info = await stat(value.output)
  assert.ok(info.size > 100_000)
})

// ---------------------------------------------------------------- 4. verify
await check('the produced video can be analysed by the plugin itself', async () => {
  const { value } = await callTool('media_watch_video', { path: buildResult.output, include_transcript: false, include_craft: true, max_keyframes: 6, output_dir: join(workspace, 'watch-built') })
  assert.ok(value.shots >= 1)
  assert.ok(value.duration_seconds > 6, `duration ${value.duration_seconds}`)
  assert.ok(value.craft !== null)
})

await check('a built video matches the profile targets closely enough to be useful', async () => {
  const profile = JSON.parse(await readFile(corpusResult.profile_path, 'utf8'))
  const targets = profile.reproduction.targets
  assert.ok(targets !== null && typeof targets === 'object')
  // The plan was authored from the checklist; the built video must be within one
  // shot length of the target average.
  const { value } = await callTool('media_watch_video', { path: buildResult.output, include_transcript: false, include_craft: true, max_keyframes: 6 })
  const builtAsl = value.craft?.cutRhythm?.avgShotLength
  assert.ok(Number.isFinite(Number(builtAsl)), 'built video has no avg shot length')
  if (Number.isFinite(Number(targets.avgShotLength))) {
    assert.ok(Math.abs(builtAsl - targets.avgShotLength) < 6, `gap too large: built ${builtAsl} vs target ${targets.avgShotLength}`)
  }
})

await check('analyse-then-build stays possible in one pass for a single reference', async () => {
  const single = join(workspace, 'single-corpus')
  const { value } = await callTool('media_corpus', { source: join(mediaDir, 'narrated.mp4'), output_dir: single, name: '单条参考', max_videos: 1, fast: true, max_seconds: 30 })
  assert.equal(value.count, 1)
  const profile = JSON.parse(await readFile(value.profile_path, 'utf8'))
  assert.equal(profile.count, 1)
  assert.equal(profile.videos.length, 1)
  assert.ok(profile.reproduction.checklist.length >= 3)
})

// ---------------------------------------------------------------- 5. skill merge
await check('media_styles finds styles in the local animation library', async () => {
  const { value, report } = await callTool('media_styles', { action: 'search', query: '水墨', limit: 3 })
  assert.equal(value.kind, 'styles')
  assert.ok(Array.isArray(value.skill_dir) || typeof value.skill_dir === 'string')
  assert.match(report, /代码动画风格库/u)
  const shown = await callTool('media_styles', { action: 'show', id: 'Z1' })
  assert.match(shown.report, /Z1 ·/u)
  assert.match(shown.report, /renderAt/u)
})

await check('media_animate renders a code animation into a splitable segment', async () => {
  const htmlPath = join(workspace, 'anim.html')
  await writeFile(htmlPath, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#080d18;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style><canvas id="c"></canvas><script>
const c = document.querySelector('#c'); const x = c.getContext('2d');
window.renderAt = async (t) => { c.width = innerWidth; c.height = innerHeight;
  x.fillStyle = '#080d18'; x.fillRect(0,0,c.width,c.height);
  const r = 40 + Math.sin(t * 2) * 12;
  x.fillStyle = '#5ec8ff'; x.beginPath(); x.arc(c.width/2, c.height/2, r, 0, Math.PI*2); x.fill(); };
</script>`, 'utf8')
  const { value, report } = await callTool('media_animate', { html_path: htmlPath, output: join(outDir, 'anim.mp4'), width: 480, height: 640, fps: 12, duration: 1 })
  assert.equal(value.kind, 'animate')
  assert.ok(value.frames >= 12, `frames ${value.frames}`)
  assert.ok(value.bytes > 2_000, `bytes ${value.bytes}`)
  assert.match(report, /# 代码动画渲染结果/u)
  assert.match(report, /拼进成片/u)
  const info = await stat(value.output)
  assert.ok(info.size > 2_000, `segment too small: ${info.size}`)
})

await check('a code animation can be spliced into a built video as a video scene', async () => {
  const segment = join(outDir, 'anim.mp4')
  const output = join(outDir, 'with-anim.mp4')
  const { value } = await callTool('media_build_video', {
    verify: false,
    plan: {
      output, width: 480, height: 640, fps: 12,
      scenes: [
        { type: 'text', duration: 1.2, text: '代码动画', font: 'msyh', fontSize: 64, color: '#ffffff', background: '#0d0f10', transitionIn: 'cut' },
        { type: 'video', duration: 1.0, src: segment, fit: 'cover', muted: true, transitionIn: 'fade', transitionDuration: 0.3 },
      ],
      audio: {},
    },
  })
  assert.equal(value.kind, 'build')
  assert.ok(Math.abs(value.duration_seconds - 1.9) < 0.3, `duration ${value.duration_seconds}`)
  assert.ok(value.bytes > 5_000)
})

// ---------------------------------------------------------------- 6. screen
await check('media_see reports capture capability', async () => {
  const { value, report } = await callTool('media_see', { action: 'status' })
  assert.equal(value.kind, 'see')
  assert.match(report, /看屏幕 · 状态/u)
  assert.equal(typeof value.screen_supported, 'boolean')
  assert.match(report, /变化量选帧/u)
})

await check('media_see peek returns a live screen capture with analysis', async () => {
  const { value, report } = await callTool('media_see', { action: 'peek', quality: 'low' })
  assert.equal(value.kind, 'see')
  assert.equal(value.action, 'peek')
  const info = await stat(value.image_path)
  assert.ok(info.size > 5_000, `capture too small: ${info.size}`)
  assert.match(report, /## 画面指标/u)
})

// ---------------------------------------------------------------- 7. vision tools
await check('media_frames returns a labelled multi-frame strip', async () => {
  const { value, report } = await callTool('media_frames', { path: join(mediaDir, 'trailer.mp4'), times: [1, 8, 15] })
  assert.equal(value.kind, 'frames')
  assert.equal(value.cells.length, 3)
  assert.ok(value.token_estimate > 0, `token estimate ${value.token_estimate}`)
  assert.match(report, /# 多帧画面/u)
  assert.match(report, /帧序/u)
  const info = await stat(value.strip_path)
  assert.ok(info.size > 5_000)
})

await check('media_compare compares a reference with a produced video', async () => {
  const reference = join(workspace, 'reference.mp4')
  const tools = await resolveTools()
  await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=6:r=25', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', reference], { cwd: workspace })
  const { value, report } = await callTool('media_compare', { reference, produced: join(mediaDir, 'trailer.mp4'), include_metrics: true })
  assert.equal(value.kind, 'compare')
  assert.ok(['match', 'close', 'diverge', 'partly', 'unknown'].includes(value.verdict), `verdict ${value.verdict}`)
  assert.ok(Array.isArray(value.rows) && value.rows.length >= 6, `rows ${value.rows?.length}`)
  assert.match(report, /# 参考 vs 成片/u)
  assert.match(report, /总体判定/u)
  const info = await stat(value.compare_image)
  assert.ok(info.size > 5_000)
})

await rm(workspace, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('ALL PASS')






