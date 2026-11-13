/**
 * End-to-end test (Lead-owned): boots the plugin against a fake Cordis context,
 * registers the real tools, executes them against the synthesized ground-truth
 * fixtures, and prints the rendered reports.
 *
 *   node test/e2e.mjs [--print]
 *
 * This is the same code path the Host runs (`ctx.tools.register` + `execute` +
 * `output.render`), minus the Cordis runtime.
 */
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const fixtures = join(here, 'fixtures')
const print = process.argv.includes('--print')

const { apply } = await import(pathToFileURL(join(root, 'index.js')).href)

/** Minimal stand-in for the Host tool registry. */
const registry = new Map()
const ctx = {
  tools: {
    register(definition) {
      registry.set(definition.name, definition)
      return () => registry.delete(definition.name)
    },
  },
}

apply(ctx, {
  // Use the tiny model already cached by other tests to keep e2e fast.
  whisperModel: 'tiny',
  asrMaxSeconds: 60,
})

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

/** Execute one registered tool and validate its declared output contract. */
async function callTool(name, args) {
  const definition = registry.get(name)
  assert.ok(definition !== undefined, `tool ${name} is not registered`)
  const value = await definition.execute(args, { signal: undefined })
  assert.equal(typeof value, 'object', `${name} returned a non-object`)
  const rendered = definition.output.render(args, value)
  assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} rendered no content blocks`)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.length > 50, `${name} report is suspiciously short`)
  if (print) {
    console.log(`\n${'='.repeat(78)}\n${name} ${JSON.stringify(args)}\n${'='.repeat(78)}\n${rendered[0].text}\n`)
  }
  return { value, report: rendered[0].text }
}

await check('registers the five core media tools', () => {
  const names = [...registry.keys()].sort()
  for (const required of ['media_frame', 'media_listen_audio', 'media_probe', 'media_watch_video', 'media_whisper']) {
    assert.ok(names.includes(required), `missing ${required}`)
  }
  for (const definition of registry.values()) {
    assert.equal(definition.parameters.type, 'object')
    assert.ok(typeof definition.description === 'string' && definition.description.length > 40)
    assert.ok(Number.isFinite(definition.timeoutMs))
  }
})

const videoFixture = join(fixtures, 'scenes.mp4')
const audioFixture = join(fixtures, 'tone-120bpm-c-major.wav')

await check('media_probe summarises the video fixture', async () => {
  const { value } = await callTool('media_probe', { path: videoFixture })
  assert.equal(value.kind, 'video')
  assert.ok(value.duration_seconds > 10 && value.duration_seconds < 14, `duration ${value.duration_seconds}`)
})

await check('media_watch_video reports shots and a transcript-capable soundtrack', async () => {
  const { value, report } = await callTool('media_watch_video', { path: videoFixture, include_transcript: false, max_keyframes: 12 })
  assert.equal(value.kind, 'video')
  assert.ok(value.shots >= 2, `shots ${value.shots}`)
  assert.match(report, /镜头时间线/u)
  assert.match(report, /画面结构/u)
  assert.ok(typeof value.artifacts?.contactSheet === 'string', 'no contact sheet')
  const info = await stat(value.artifacts.contactSheet)
  assert.ok(info.size > 5_000, `contact sheet too small: ${info.size}`)
})

await check('media_watch_video flags are coherent', async () => {
  const { report } = await callTool('media_watch_video', { path: videoFixture, include_transcript: false, detail: 'brief' })
  assert.match(report, /健康与内容判断/u)
  assert.match(report, /还可以问我/u)
})

await check('media_listen_audio measures the 120 BPM C-major fixture', async () => {
  const { value, report } = await callTool('media_listen_audio', { path: audioFixture })
  assert.equal(value.kind, 'audio')
  assert.ok(Math.abs(Number(value.bpm) - 120) <= 3, `bpm ${value.bpm}`)
  assert.match(String(value.key), /^C/u)
  assert.match(report, /调性与和声/u)
  assert.ok(typeof value.artifacts?.spectrogram === 'string')
  const info = await stat(value.artifacts.spectrogram)
  assert.ok(info.size > 1_000, `spectrogram too small: ${info.size}`)
})

await check('media_frame inspects a video moment', async () => {
  const { value, report } = await callTool('media_frame', { path: videoFixture, time: 1.5 })
  assert.equal(value.kind, 'video-frame')
  assert.ok(typeof value.image_path === 'string')
  const info = await stat(value.image_path)
  assert.ok(info.size > 1_000, `still too small: ${info.size}`)
  assert.match(report, /亮度图/u)
})

await check('media_frame also reads a still image', async () => {
  const { value } = await callTool('media_frame', { path: join(fixtures, 'poster.png') })
  assert.equal(value.kind, 'image')
})

await check('media_whisper reports model status without downloading', async () => {
  const { value, report } = await callTool('media_whisper', { action: 'status' })
  assert.equal(value.action, 'status')
  assert.match(report, /whisper/u)
})

await check('missing file fails with a helpful message', async () => {
  await assert.rejects(() => callTool('media_probe', { path: 'definitely-not-here.mp4' }), /找不到文件/u)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('ALL PASS')

