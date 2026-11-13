/**
 * Shell smoke test (Lead-owned): exercises the finished plumbing that does not
 * depend on the two analysis engines.
 *
 *   node test/shell-smoke.mjs
 *
 * Covers: binary discovery, ffprobe summarisation, single-frame analysis
 * (ASCII/hue art/palette/layout), PNG chart output, whisper capability probe and
 * the local whisper transcription path on a synthesized speech clip.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkDir, removeWorkDir, resolveTools, probe, summariseProbe, run } from '../lib/ffmpeg.js'
import { analyzeFrame } from '../lib/frame.js'
import { writeLineChart, writeHeatmap } from '../lib/png.js'
import { whisperSupport, ensureModel, transcribe } from '../lib/asr.js'

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

const root = await mkdtemp(join(tmpdir(), 'media-senses-smoke-'))
const tools = await resolveTools()
console.log(`ffmpeg: ${tools.ffmpeg}`)
console.log(`work:   ${root}`)

await check('ffmpeg probe reports a version line', () => {
  assert.match(tools.version, /ffmpeg version/u)
})

// --- fixture: 3 s colour video with a beep + synthesized speech ------------
const video = join(root, 'fixture.mp4')
await run(tools.ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=0x8B1A1A:s=320x180:d=3:r=25',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=44100',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  video,
], { cwd: root, timeoutMs: 120_000 })
await check('fixture video exists', async () => {
  const info = await stat(video)
  assert.ok(info.size > 1000, `fixture too small: ${info.size}`)
})

const summary = summariseProbe(await probe(tools, video))
await check('probe finds one video and one audio stream', () => {
  assert.equal(summary.video.length, 1)
  assert.equal(summary.audio.length, 1)
  assert.ok(summary.duration > 2.5 && summary.duration < 3.6, `duration ${summary.duration}`)
  assert.equal(summary.video[0].width, 320)
})

const workDir = await makeWorkDir('smoke-frame')
const frame = await analyzeFrame({ tools, file: video, time: 1.0, workDir, outputDir: join(root, 'artifacts'), isImage: false })
await check('frame ascii has the requested grid', () => {
  const rows = frame.ascii.split('\n')
  assert.ok(rows.length >= 20, `rows ${rows.length}`)
  assert.ok(rows[0].length >= 50, `columns ${rows[0].length}`)
})
await check('frame hue map marks the red field', () => {
  const letters = new Set(frame.hueMap.replace(/\n/gu, '').split(''))
  assert.ok(letters.has('R') || letters.has('M'), `letters: ${[...letters].join('')}`)
})
await check('frame reports a dark-ish red palette and a layout note', () => {
  assert.ok(frame.summary.brightness > 0.05 && frame.summary.brightness < 0.5, `brightness ${frame.summary.brightness}`)
  assert.ok(frame.summary.palette.length >= 1)
  assert.ok(typeof frame.summary.layout === 'string' && frame.summary.layout.length > 0)
})
await check('frame saved a viewable still', async () => {
  assert.ok(typeof frame.imagePath === 'string')
  const info = await stat(frame.imagePath)
  assert.ok(info.size > 300, `still too small: ${info.size}`)
})

// --- png charts -----------------------------------------------------------
const chart = await writeLineChart(join(root, 'chart.png'), {
  series: [{ values: [0, 1, 0.5, 0.25, 0.9], color: [94, 200, 255] }],
})
const heat = await writeHeatmap(join(root, 'heat.png'), { matrix: Array.from({ length: 32 }, () => Array.from({ length: 12 }, (_, i) => i / 12)) })
await check('line chart and heat map are valid PNGs', async () => {
  for (const path of [chart, heat]) {
    const info = await stat(path)
    assert.ok(info.size > 400, `${path} too small`)
  }
})

// --- whisper --------------------------------------------------------------
// The whisper model is ~74 MB and downloads from HuggingFace on first use. This
// test must not fail because the network is down: prefer the cached model in the
// Harness home, and skip (rather than fail) when it is absent and unreachable.
const support = await whisperSupport(tools)
console.log(`whisper filter: ${support.supported ? 'available' : support.reason}`)
if (support.supported) {
  const speech = join(root, 'speech.wav')
  await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "flite=text='The quick brown fox jumps over the lazy dog':voice=slt", '-ar', '16000', '-ac', '1', speech], { cwd: root, timeoutMs: 120_000 })
  let model
  try {
    model = await ensureModel({ size: 'tiny' })
  } catch (error) {
    console.log(`SKIP whisper transcription — model unavailable and could not be downloaded (${error.message})`)
    model = undefined
  }
  if (model !== undefined) {
    console.log(`whisper model: ${model.path} (${Math.round(model.bytes / 1048576)} MB, downloaded=${model.downloaded})`)
    const transcript = await transcribe({ tools, file: speech, modelPath: model.path, language: 'en', maxSeconds: 30 })
    await check('whisper transcribes synthesized speech', () => {
      assert.ok(transcript.text.length > 10, `transcript: "${transcript.text}"`)
      assert.match(transcript.text.toLowerCase(), /quick|brown|fox|dog|lazy/u)
    })
  }
}

await removeWorkDir(workDir)
await rm(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('ALL PASS')

