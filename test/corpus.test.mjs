/**
 * Corpus + style-profile test (Lead-owned).
 *
 *   node test/corpus.test.mjs
 *
 * Exercises the "learn how this genre is made" half of the loop without needing
 * the synthesis engine: expand sources, batch-analyse a small corpus (with the
 * cache), aggregate a style profile, and check the generated reproduction brief
 * is a usable RenderPlan skeleton.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTools, run } from '../lib/ffmpeg.js'
import { analyzeCorpus, expandSource, looksLikeVideo, mediaId } from '../lib/corpus.js'
import { buildStyleProfile, distribution, median, mode, quantile, renderProfileMarkdown } from '../lib/profile.js'
import { findYtDlp } from '../lib/ingest.js'

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

const root = await mkdtemp(join(tmpdir(), 'media-senses-corpus-'))
const tools = await resolveTools()
const mediaDir = join(root, 'media')
await mkdir(mediaDir, { recursive: true })

// --- fixtures: two clips with a known shot structure -----------------------
const clipA = join(mediaDir, 'a-two-scenes.mp4')
const clipB = join(mediaDir, 'b-one-scene.mp4')
await run(tools.ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=0x1a2b8b:s=320x180:d=2:r=25',
  '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=2:r=25',
  '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
  '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clipA,
], { cwd: root, timeoutMs: 120_000 })
await run(tools.ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=0x8b1a1a:s=320x180:d=3:r=25',
  '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipB,
], { cwd: root, timeoutMs: 120_000 })

await check('looksLikeVideo accepts video extensions and rejects text', () => {
  assert.equal(looksLikeVideo('x/y/z.MP4'), true)
  assert.equal(looksLikeVideo('a.webm'), true)
  assert.equal(looksLikeVideo('a.txt'), false)
  assert.equal(looksLikeVideo('a'), false)
})

await check('mediaId is stable and filename-friendly', () => {
  const first = mediaId('D:/a/b.mp4')
  assert.equal(first, mediaId('D:/a/b.mp4'))
  assert.notEqual(first, mediaId('D:/a/c.mp4'))
  assert.match(first, /^b-[0-9a-f]{10}$/u)
})

await check('expandSource reads a directory of videos', async () => {
  const expanded = await expandSource(mediaDir)
  assert.equal(expanded.files.length, 2)
  assert.equal(expanded.urls.length, 0)
})

await check('expandSource reads a manifest with urls and comments', async () => {
  const manifest = join(root, 'manifest.txt')
  await writeFile(manifest, `${clipA}\n# a comment\nhttps://example.com/a.mp4\n\n${clipB}\n`, 'utf8')
  const expanded = await expandSource(manifest)
  assert.equal(expanded.files.length, 2)
  assert.equal(expanded.urls.length, 1)
})

await check('expandSource reads a json manifest', async () => {
  const manifest = join(root, 'manifest.json')
  await writeFile(manifest, JSON.stringify([{ path: clipA }, { url: 'https://example.com/b.mp4' }]), 'utf8')
  const expanded = await expandSource(manifest)
  assert.equal(expanded.files.length, 1)
  assert.equal(expanded.urls.length, 1)
})

await check('expandSource warns about missing paths instead of throwing', async () => {
  const expanded = await expandSource(join(root, 'does-not-exist'))
  assert.equal(expanded.files.length, 0)
  assert.ok(expanded.warnings.length >= 1)
})

const corpusRoot = join(root, 'corpus')
const firstRun = await analyzeCorpus({
  tools,
  root: corpusRoot,
  videos: [{ path: clipA }, { path: clipB }],
  maxVideos: 4,
  fast: true,
  maxSeconds: 30,
  concurrency: 2,
})

await check('corpus analysis produces two entries and a jsonl file', async () => {
  assert.equal(firstRun.entries.length, 2, `entries ${firstRun.entries.length}`)
  assert.equal(firstRun.failed, 0)
  assert.equal(firstRun.skipped, 0)
  const jsonl = await readFile(firstRun.corpusPath, 'utf8')
  assert.equal(jsonl.trim().split('\n').length, 2)
})

await check('corpus entries carry shots, duration and an analysis file', async () => {
  for (const entry of firstRun.entries) {
    assert.ok(entry.analysis.duration > 0, `${entry.id} duration`)
    assert.ok(Array.isArray(entry.analysis.shots) && entry.analysis.shots.length >= 1, `${entry.id} shots`)
    const stored = JSON.parse(await readFile(join(firstRun.analysisDir, `${entry.id}.json`), 'utf8'))
    assert.equal(stored.id, entry.id)
  }
})

await check('the two-scene clip yields two shots', async () => {
  const entry = firstRun.entries.find((item) => item.file === clipA)
  assert.equal(entry.analysis.shots.length, 2, `shots ${entry.analysis.shots.length}`)
})

let secondRun
await check('second run hits the cache instead of re-analysing', async () => {
  secondRun = await analyzeCorpus({
    tools,
    root: corpusRoot,
    videos: [{ path: clipA }, { path: clipB }],
    maxVideos: 4,
    fast: true,
    maxSeconds: 30,
    concurrency: 2,
  })
  assert.equal(secondRun.skipped, 2, `skipped ${secondRun.skipped}`)
})

await check('reuseCache:false forces a fresh analysis', async () => {
  const fresh = await analyzeCorpus({
    tools,
    root: corpusRoot,
    videos: [{ path: clipA }],
    maxVideos: 1,
    fast: true,
    maxSeconds: 30,
    reuseCache: false,
  })
  assert.equal(fresh.skipped, 0)
  assert.equal(fresh.entries.length, 1)
})

const { profile, markdown } = buildStyleProfile(firstRun.entries, { name: '测试语料' })

await check('profile aggregates the corpus', () => {
  assert.equal(profile.schema, 'media-senses.style-profile/v1')
  assert.equal(profile.count, 2)
  assert.ok(profile.totalSeconds > 3)
  assert.ok(['vertical', 'horizontal', 'square'].includes(profile.format.aspect))
  assert.ok(profile.videos.length === 2)
})

await check('profile has a reproduction checklist and a RenderPlan skeleton', () => {
  assert.ok(Array.isArray(profile.reproduction.checklist))
  assert.ok(profile.reproduction.checklist.length >= 4, `checklist ${profile.reproduction.checklist.length}`)
  const plan = profile.reproduction.brief.plan
  assert.ok(Number.isInteger(plan.width) && Number.isInteger(plan.height))
  assert.ok(Array.isArray(plan.scenes) && plan.scenes.length >= 2)
  for (const scene of plan.scenes) {
    assert.ok(['text', 'image', 'color', 'gradient'].includes(scene.type))
    assert.ok(scene.duration >= 1)
    if (scene.type === 'image') assert.ok(typeof scene.src === 'string' && scene.src.length > 0, 'image scene needs src')
    if (scene.type === 'text') assert.ok(typeof scene.text === 'string')
    assert.ok(['cut', 'fade'].includes(scene.transitionIn))
  }
  assert.ok(plan.output.length > 0)
})

await check('profile markdown renders all sections', () => {
  assert.equal(typeof markdown, 'string')
  for (const heading of ['# 风格画像', '## 一眼结论', '## 节奏与剪辑', '## 运镜', '## 调色', '## 声音', '## 仿制清单', '## 样本清单']) {
    assert.ok(markdown.includes(heading), `missing ${heading}`)
  }
  assert.equal(markdown, renderProfileMarkdown(profile, profile.name))
})

await check('profile is strictly JSON-serialisable with finite numbers', () => {
  const text = JSON.stringify(profile)
  assert.ok(text.length > 100)
  const walk = (value) => {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `non-finite ${value}`)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(profile)
  assert.deepEqual(JSON.parse(text), profile)
})

await check('statistics helpers behave', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), null)
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(mode(['a', 'b', 'b']), 'b')
  assert.deepEqual(distribution(['a', 'a', 'b']), { a: 0.667, b: 0.333 })
})

await check('yt-dlp detection returns a path or undefined without throwing', async () => {
  const found = await findYtDlp()
  assert.ok(found === undefined || typeof found === 'string')
})

await rm(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('ALL PASS')
