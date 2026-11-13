/**
 * Vision layer test (Lead-owned): capability probe, image budget, cropping, and
 * the two vision-only reports.
 *
 *   node test/vision.test.mjs
 *
 * No real model route or attachment service is needed: the Cordis context is
 * faked, which is exactly the shape production code sees through `ctx.get(...)`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachImages, detectVision, profileWidth, sampleTimes, VISION_PROFILES } from '../lib/vision.js'
import { cropFilter, parseRegion } from '../lib/frame.js'
import { renderCompareReport, renderFramesReport } from '../lib/render-vision.js'
import { Canvas } from '../lib/png.js'

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

const workDir = await mkdtemp(join(tmpdir(), 'media-senses-vision-'))

/** A tiny fake Cordis context with the two optional services we read. */
function makeCtx({ imageModalities = ['text', 'image'], limits, llm = true, attachments = true } = {}) {
  const saved = []
  const fakeLlm = llm
    ? { resolveModelInfo: async () => ({ inputModalities: imageModalities }) }
    : undefined
  const fakeAttachments = attachments
    ? {
        imageLimits: limits ?? {
          maxImageBytes: 5 * 1024 * 1024,
          maxImageDimension: 8000,
          maxImagePixels: 40_000_000,
          maxMessageImageBytes: 20 * 1024 * 1024,
          maxImagesPerMessage: 8,
          mediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
        },
        saveImage: async ({ data, mediaType, name }) => {
          saved.push({ name, bytes: data.length })
          return { attachmentId: `att-${saved.length}`, mediaType, bytes: data.length, width: 64, height: 36, name }
        },
      }
    : undefined
  const ctx = {
    get: (name) => (name === 'llm' ? fakeLlm : name === 'attachments' ? fakeAttachments : undefined),
  }
  return { ctx, saved }
}

const fakeExec = { agent: { session: { requestHeader: () => ({ config: { provider: 'fake', model: 'fake-vision' } }) }, options: {} } }

const tools = { ffmpeg: 'unused', ffprobe: 'unused' }

/** Write a PNG of the given size with the given pixel function. */
async function writePng(path, width, height, painter) {
  const canvas = new Canvas(width, height, [20, 24, 32])
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) canvas.set(x, y, painter(x, y))
  await writeFile(path, canvas.toPng())
}

// --- capability probe ------------------------------------------------------
await check('detectVision activates when the route declares image input', async () => {
  const { ctx } = makeCtx()
  const vision = await detectVision({ ctx, exec: fakeExec, config: {} })
  assert.equal(vision.active, true)
  assert.equal(vision.requested, 'auto')
  assert.match(vision.reason, /image input/u)
})

await check('detectVision stays inactive for a text-only route', async () => {
  const { ctx } = makeCtx({ imageModalities: ['text'] })
  const vision = await detectVision({ ctx, exec: fakeExec, config: {} })
  assert.equal(vision.active, false)
  assert.match(vision.reason, /does not declare image input/u)
})

await check('mode=blind forces the blind path', async () => {
  const { ctx } = makeCtx()
  const vision = await detectVision({ ctx, exec: fakeExec, config: {}, override: 'blind' })
  assert.equal(vision.active, false)
  assert.equal(vision.requested, 'blind')
})

await check('a forced vision mode still needs a route to resolve', async () => {
  const { ctx } = makeCtx()
  const vision = await detectVision({ ctx, exec: {}, config: {}, override: 'vision' })
  assert.equal(vision.active, false)
  assert.match(vision.reason, /route could not be resolved/u)
})

await check('missing services degrade to an explanatory reason', async () => {
  const { ctx } = makeCtx({ llm: false })
  const idle = await detectVision({ ctx, exec: fakeExec, config: {} })
  assert.equal(idle.active, false)
  assert.match(idle.reason, /no llm service/u)
  const noCtx = await detectVision({ exec: fakeExec, config: {} })
  assert.equal(noCtx.active, false)
  assert.match(noCtx.reason, /no Cordis context/u)
})

await check('attachment limits are propagated and clamped to a known shape', async () => {
  const { ctx } = makeCtx({ limits: { maxImageBytes: 1234, maxImageDimension: 999, maxImagePixels: 100, maxMessageImageBytes: 5678, mediaTypes: ['image/png'] } })
  const vision = await detectVision({ ctx, exec: fakeExec, config: {} })
  assert.equal(vision.limits.maxImageBytes, 1234)
  assert.equal(vision.limits.maxImageDimension, 999)
  assert.deepEqual(vision.limits.mediaTypes, ['image/png'])
})

await check('profiles pick widths and image caps', () => {
  assert.equal(profileWidth('balanced', 'sheet'), 1260)
  assert.equal(profileWidth('high', 'sheet'), 1596)
  assert.equal(profileWidth('high', 'detail'), 1596)
  assert.equal(profileWidth('nonsense', 'filmstrip'), VISION_PROFILES.balanced.filmstripWidth)
  assert.equal(profileWidth('balanced', 'sheet') % 42, 0)
  assert.equal(profileWidth('high', 'sheet') % 42, 0)
})

await check('sampleTimes returns ascending times inside the range', () => {
  const times = sampleTimes(0, 10, 3)
  assert.equal(times.length, 3)
  assert.ok(times[0] >= 0 && times[2] <= 10)
  assert.ok(times[0] < times[1] && times[1] < times[2])
  const single = sampleTimes(4, 4, 1)
  assert.equal(single.length, 1)
  const clamped = sampleTimes(0, 10, 99)
  assert.equal(clamped.length, 8)
})

// --- attaching images ------------------------------------------------------
const smallA = join(workDir, 'a.png')
const smallB = join(workDir, 'b.png')
const smallC = join(workDir, 'c.png')
await writePng(smallA, 120, 68, (x, y) => [x % 255, y % 255, 128, 255])
await writePng(smallB, 120, 68, (x, y) => [200, x % 255, y % 255, 255])
await writePng(smallC, 120, 68, () => [10, 200, 40, 255])

const activeVision = await detectVision({ ctx: makeCtx().ctx, exec: fakeExec, config: {} })

await check('attachImages attaches a png for a capable route', async () => {
  const { ctx, saved } = makeCtx()
  const result = await attachImages({
    ctx,
    exec: fakeExec,
    tools,
    workDir,
    entries: [{ path: smallA, name: 'a.png', kind: 'detail' }],
    vision: activeVision,
  })
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].kind, 'detail')
  assert.equal(saved.length, 1)
  assert.ok(result.images[0].attachmentId.startsWith('att-'))
})

await check('attachImages skips an inactive vision route', async () => {
  const { ctx } = makeCtx()
  const blind = await detectVision({ ctx, exec: fakeExec, config: {}, override: 'blind' })
  const result = await attachImages({ ctx, exec: fakeExec, tools, workDir, entries: [{ path: smallA, name: 'a.png' }], vision: blind })
  assert.equal(result.images.length, 0)
})

await check('attachImages reports bad paths instead of throwing', async () => {
  const { ctx } = makeCtx()
  const result = await attachImages({
    ctx,
    exec: fakeExec,
    tools,
    workDir,
    entries: [{ path: 'not-absolute.png', name: 'x.png' }, { path: join(workDir, 'missing.png'), name: 'y.png' }],
    vision: activeVision,
  })
  assert.equal(result.images.length, 0)
  assert.ok(result.skipped.length === 2, `skipped ${result.skipped.length}`)
  assert.match(String(result.skipped[0].reason), /absolute/u)
})

await check('attachImages enforces the per-message image cap', async () => {
  const { ctx } = makeCtx({ limits: { maxImageBytes: 5_000_000, maxImageDimension: 8000, maxImagePixels: 40_000_000, maxMessageImageBytes: 20_000_000, maxImagesPerMessage: 2, mediaTypes: ['image/png'] } })
  const vision = await detectVision({ ctx, exec: fakeExec, config: {} })
  const result = await attachImages({
    ctx,
    exec: fakeExec,
    tools,
    workDir,
    entries: [{ path: smallA, name: 'a.png' }, { path: smallB, name: 'b.png' }, { path: smallC, name: 'c.png' }],
    vision,
  })
  assert.equal(result.images.length, 2)
  assert.ok(result.skipped.length >= 1)
  assert.match(String(result.skipped[0].reason), /上限/u)
})

await check('attachImages enforces the aggregate byte budget', async () => {
  const { ctx } = makeCtx({ limits: { maxImageBytes: 5_000_000, maxImageDimension: 8000, maxImagePixels: 40_000_000, maxMessageImageBytes: 10, maxImagesPerMessage: 8, mediaTypes: ['image/png'] } })
  const vision = await detectVision({ ctx, exec: fakeExec, config: {} })
  const result = await attachImages({ ctx, exec: fakeExec, tools, workDir, entries: [{ path: smallA, name: 'a.png' }], vision })
  assert.equal(result.images.length, 0)
  assert.ok(result.skipped.length === 1)
})

// --- cropping --------------------------------------------------------------
await check('parseRegion normalises to even dimensions', () => {
  assert.deepEqual(parseRegion('100,50,640,360'), { x: 100, y: 50, width: 640, height: 360 })
  const odd = parseRegion('10,11,641,361')
  assert.equal(odd.width, 640)
  assert.equal(odd.height, 360)
  assert.equal(parseRegion('off'), undefined)
  assert.equal(parseRegion('1,2,3'), undefined)
  assert.equal(parseRegion('0,0,-5,10'), undefined)
})

await check('cropFilter builds a region crop or a centre zoom', () => {
  const region = cropFilter({ region: '10,20,300,200' })
  assert.equal(region.filter, 'crop=300:200:10:20')
  assert.equal(region.crop.kind, 'region')
  const zoom = cropFilter({ zoom: 3 })
  assert.match(zoom.filter, /crop=trunc\(iw\/3\/2\)\*2/u)
  assert.equal(zoom.crop.factor, 3)
  assert.equal(cropFilter({}).filter, '')
})

// --- vision-only reports ---------------------------------------------------
await check('frames report lists cells and asks concrete questions', () => {
  const report = renderFramesReport({
    file: 'C:/media/demo.mp4',
    cells: [{ index: 1, time: 0.5, timecode: '0:00.500' }, { index: 2, time: 3, timecode: '0:03.000' }],
    width: 1260,
    height: 420,
    tokenEstimate: 262,
    target: 'vision',
  })
  assert.match(report, /# 多帧画面/u)
  assert.match(report, /## 帧序（左上→右下）/u)
  assert.match(report, /0:00\.500/u)
  assert.match(report, /## 用眼睛回答/u)
  assert.match(report, /region/u)
})

await check('blind frames report does not claim embedded images', () => {
  const report = renderFramesReport({ file: 'x.mp4', cells: [{ index: 1, time: 0, timecode: '0:00.000' }], target: 'blind' })
  assert.ok(!report.includes('用眼睛回答'))
  assert.match(report, /media_frame/u)
})

await check('compare report renders the verdict table', () => {
  const report = renderCompareReport({
    reference: 'C:/media/ref.mp4',
    produced: 'C:/media/out.mp4',
    diff: {
      rows: [
        { metric: '时长', ref: 19.16, built: 11.6, delta: -7.56, verdict: 'diverge' },
        { metric: 'BPM', ref: 100.3, built: 101.0, delta: 0.7, verdict: 'match' },
      ],
      summary: { match: 1, close: 0, diverge: 1, unknown: 0 },
      verdict: 'diverge',
    },
    compareImage: { path: 'C:/media/cmp.png', width: 1260, height: 720, mode: 'stack', tokenEstimate: 428 },
    target: 'vision',
  })
  assert.match(report, /# 参考 vs 成片 · 对比/u)
  assert.match(report, /总体判定：偏差大/u)
  assert.match(report, /\| 时长 \|/u)
  assert.match(report, /## 用眼睛判断/u)
})

await check('compare report tolerates an empty diff', () => {
  const report = renderCompareReport({ reference: 'a.mp4', produced: 'b.mp4', diff: { rows: [], summary: {}, verdict: 'unknown' }, target: 'blind' })
  assert.match(report, /总体判定：无数据/u)
  assert.match(report, /media_build_video/u)
})

await rm(workDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('ALL PASS')

