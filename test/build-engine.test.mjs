#!/usr/bin/env node
/**
 * Acceptance tests for the media-senses reproduction engine (RenderPlan -> MP4)
 * and the local SAPI speech synthesizer.
 *
 * Run: node test/build-engine.test.mjs
 *
 * The headline case renders exactly the plan described in CONTRACT-V2.md: four
 * portrait scenes (text fade-in -> Ken Burns image with a fade -> gradient with
 * slideleft -> text), two burned Chinese captions, a music bed and a Chinese
 * text voiceover. It then checks the produced file with ffprobe, re-derives the
 * timeline formula, samples frames (fade / title / caption evidence), measures
 * EBU R128 loudness, and inspects every captured ffmpeg command to prove no
 * Windows absolute path ever entered a filtergraph.
 *
 * Scratch files live in a fresh temp dir; the rendered sample is copied to a
 * stable temp path and printed so it can be inspected afterwards.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeWorkDir,
  probe,
  readFrameMetadata,
  removeWorkDir,
  resolveTools,
  run,
} from '../lib/ffmpeg.js'
import { Canvas } from '../lib/png.js'
import { buildVideo, duckGainExpression } from '../lib/build.js'
import { listVoices, synthesizeSpeech } from '../lib/tts.js'

// Target content of the contract's acceptance plan.
const BIG_SCENES = [
  { type: 'text', duration: 2 },
  { type: 'image', duration: 3, transitionIn: 'fade', transitionDuration: 0.5 },
  { type: 'gradient', duration: 1.5, transitionIn: 'slideleft', transitionDuration: 0.4 },
  { type: 'text', duration: 1.5 },
]
const BIG_TOTAL = 8 - 0.9 // 7.1 s: sum(durations) - sum(transition durations)

const SAMPLE_PATH = join(tmpdir(), 'media-senses-build-sample.mp4')

let passed = 0
let failed = 0

/** Run one assertion block, printing PASS/FAIL. */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(`FAIL  ${name}`)
    console.log(`      ${message.split(/\r?\n/u).join('\n      ')}`)
  }
}

function assertFiniteTree(value, path) {
  if (value === null) return
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is not a finite number (${value})`)
    return
  }
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteTree(item, `${path}[${index}]`))
    return
  }
  assert.equal(typeof value, 'object', `${path} has unsupported type ${typeof value}`)
  for (const [key, item] of Object.entries(value)) {
    assert.notEqual(item, undefined, `${path}.${key} is undefined`)
    assertFiniteTree(item, `${path}.${key}`)
  }
}

function assertJsonSafe(result) {
  assertFiniteTree(result, 'result')
  const roundTripped = JSON.parse(JSON.stringify(result))
  assert.deepEqual(roundTripped, result, 'report does not survive a JSON round-trip unchanged')
}

/** Expected contract timeline for a scene list with cut/xfade transitions. */
function expectedTimeline(scenes) {
  const timeline = []
  let end = 0
  scenes.forEach((scene, index) => {
    const gradual = index > 0 &&
      typeof scene.transitionIn === 'string' &&
      scene.transitionIn.trim().toLowerCase() !== 'cut'
    const transition = gradual ? scene.transitionDuration ?? 0.5 : 0
    end += scene.duration - transition
    timeline.push({ start: round2(end - scene.duration), end: round2(end) })
  })
  return timeline
}

function round2(value) {
  return Math.round(value * 100) / 100
}

async function fileSize(path) {
  return (await stat(path)).size
}

async function fileExists(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** Hand-built test stills so the test does not depend on network fixtures. */
async function makeTestImages(dir) {
  const landscape = new Canvas(1200, 900, [22, 46, 94, 255])
  for (let i = 0; i < 6; i += 1) {
    landscape.rect(60 + i * 180, 90 + i * 48, 140, 250, [225 - i * 22, 90 + i * 22, 70, 255])
  }
  landscape.line(0, 899, 1199, 0, [255, 224, 120, 255], 4)
  const landscapePath = join(dir, 'photo-landscape.png')
  await landscape.save(landscapePath)

  const portrait = new Canvas(900, 1400, [44, 16, 64, 255])
  for (let i = 0; i < 8; i += 1) {
    portrait.rect(80, 110 + i * 150, 740 - i * 70, 92, [86 + i * 18, 58, 140 + i * 10, 255])
  }
  const portraitPath = join(dir, 'photo-portrait.png')
  await portrait.save(portraitPath)

  return { landscapePath, portraitPath }
}

/** Synthesize a 12 s music bed with ffmpeg (no external assets needed). */
async function makeMusic(tools, dir) {
  const musicPath = join(dir, 'music-bed.wav')
  const result = await run(
    tools.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=12',
      '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,volume=-10dB[out]',
      '-map', '[out]', '-c:a', 'pcm_s16le',
      musicPath,
    ],
    { timeoutMs: 60_000 },
  )
  assert.equal(result.code, 0, `music fixture synthesis failed: ${result.stderr.slice(-400)}`)
  return musicPath
}

/**
 * Synthesize a 1.5 s "animation segment" the way a renderer would emit one:
 * H.264 / yuv420p MP4 at a fixed frame rate (no audio).
 */
async function makeAnimationSegment(tools, dir) {
  const segmentPath = join(dir, 'animation-segment.mp4')
  const result = await run(
    tools.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=25:duration=1.5',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an',
      segmentPath,
    ],
    { timeoutMs: 120_000 },
  )
  assert.equal(result.code, 0, `animation segment fixture failed: ${result.stderr.slice(-400)}`)
  return segmentPath
}

// ---------------------------------------------------------------------------
// shared analysis helpers
// ---------------------------------------------------------------------------

/** Per-frame signalstats (YAVG/YMAX/YMIN) at one timestamp. */
async function frameStats(state, file, time) {
  const frames = await readFrameMetadata(state.tools, file, {
    filter: 'signalstats',
    workDir: state.analysisDir,
    extraInputArgs: ['-ss', String(time)],
  })
  assert.ok(frames.length > 0, `no frame telemetry at t=${time}`)
  const meta = frames[0].meta
  const number = (key) => {
    const value = Number.parseFloat(meta[`lavfi.signalstats.${key}`] ?? '0')
    return Number.isFinite(value) ? value : 0
  }
  return { yavg: number('YAVG'), ymax: number('YMAX'), ymin: number('YMIN') }
}

/**
 * Decode one cropped frame into a tiny 54x36 grayscale buffer and report the
 * share of bright pixels plus an ASCII art preview (used as the "text is really
 * drawn here" evidence, including CJK glyphs).
 */
async function bandBrightness(state, file, time, crop, threshold = 190) {
  const rawName = `band-${time.toFixed(2).replace('.', '_')}-${crop.replaceAll(':', '_')}.gray`
  const result = await run(
    state.tools.ffmpeg,
    [
      '-hide_banner', '-v', 'error', '-y',
      '-ss', String(time), '-i', file,
      '-vf', `crop=${crop},scale=54:36,format=gray`,
      '-frames:v', '1', '-f', 'rawvideo', rawName,
    ],
    { cwd: state.analysisDir, timeoutMs: 60_000 },
  )
  assert.equal(result.code, 0, `frame crop failed: ${result.stderr.slice(-300)}`)
  const buffer = await readFile(join(state.analysisDir, rawName))
  assert.equal(buffer.length, 54 * 36, `unexpected raw frame size ${buffer.length}`)
  let bright = 0
  const rows = []
  for (let y = 0; y < 36; y += 1) {
    let row = ''
    for (let x = 0; x < 54; x += 1) {
      const value = buffer[y * 54 + x]
      if (value > threshold) bright += 1
      row += value > 200 ? '#' : value > 140 ? '+' : value > 60 ? '.' : ' '
    }
    rows.push(row)
  }
  return { ratio: bright / (54 * 36), ascii: rows.join('\n') }
}

/** Integrated loudness (LUFS) via ffmpeg's EBU R128 meter. */
async function measureLoudness(state, file) {
  const result = await run(
    state.tools.ffmpeg,
    ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { timeoutMs: 120_000 },
  )
  const matches = [...`${result.stderr}`.matchAll(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/gu)]
  assert.ok(matches.length > 0, 'ebur128 did not report an integrated loudness value')
  return Number.parseFloat(matches[matches.length - 1][1])
}

/** Assert every captured filtergraph uses relative paths only. */
function stagesOf(commands) {
  return commands.map((command) => command.stage)
}

/** Assert every captured filtergraph uses relative paths only. */
function assertFiltergraphsAreRelative(commands) {
  const graphOptions = new Set(['-vf', '-af', '-filter_complex', '-filter:v', '-filter:a'])
  const graphsSeen = []
  for (const command of commands) {
    command.args.forEach((argument, index) => {
      if (!graphOptions.has(argument)) return
      const graph = command.args[index + 1]
      assert.equal(typeof graph, 'string', `${command.stage}: ${argument} has no value`)
      graphsSeen.push(graph)
      assert.ok(
        !/[A-Za-z]:[\\/]/u.test(graph),
        `${command.stage}: ${argument} contains a Windows absolute path:\n${graph.slice(0, 300)}`,
      )
      assert.ok(
        !graph.includes('/tmp/') && !graph.includes('\\\\'),
        `${command.stage}: ${argument} contains an absolute POSIX/UNC path:\n${graph.slice(0, 300)}`,
      )
      for (const match of graph.matchAll(/fontfile=([^:'"]+)/gu)) {
        assert.ok(
          !match[1].includes(':') && !match[1].includes('/'),
          `${command.stage}: fontfile is not a bare work-dir file name (${match[1]})`,
        )
      }
      for (const match of graph.matchAll(/textfile=([^:'"]+)/gu)) {
        assert.ok(
          !match[1].includes(':') && !match[1].includes('/'),
          `${command.stage}: textfile is not a bare work-dir file name (${match[1]})`,
        )
      }
    })
  }
  assert.ok(graphsSeen.length > 0, 'no filtergraph commands were captured')
  return graphsSeen
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const state = {
  tools: null,
  workDir: null,
  analysisDir: null,
  images: null,
  musicPath: null,
  segmentPath: null,
  big: null,
  bigPlan: null,
  bigCommands: [],
}

async function main() {
  await check('setup: ffmpeg/ffprobe resolve and a scratch dir is available', async () => {
    state.tools = await resolveTools()
    assert.ok(typeof state.tools.ffmpeg === 'string' && state.tools.ffmpeg.length > 0)
    assert.ok(typeof state.tools.ffprobe === 'string' && state.tools.ffprobe.length > 0)
    state.workDir = await makeWorkDir('media-senses-build')
    state.analysisDir = join(state.workDir, 'analysis')
    await mkdir(state.analysisDir, { recursive: true })
    state.images = await makeTestImages(state.workDir)
    state.musicPath = await makeMusic(state.tools, state.workDir)
    state.segmentPath = await makeAnimationSegment(state.tools, state.workDir)
    assert.ok(await fileExists(state.images.landscapePath))
    assert.ok(await fileExists(state.musicPath))
    assert.ok(await fileExists(state.segmentPath))
  })

  // --- headline render -----------------------------------------------------
  await check('build: renders the contract 4-scene 1080x1920@30 plan', async () => {
    const plan = {
      output: join(state.workDir, 'out', 'sample.mp4'),
      width: 1080,
      height: 1920,
      fps: 30,
      background: '#101018',
      loudnessTarget: -16,
      scenes: [
        {
          type: 'text',
          duration: 2,
          text: '仿制视频\n第一幕',
          subtitle: '观看 · 学习 · 复刻',
          font: 'msyhbd',
          fontSize: 96,
          color: '#ffffff',
          background: '#120c2b',
          align: 'center',
          animation: 'fade',
          transitionIn: 'cut',
        },
        {
          type: 'image',
          duration: 3,
          src: state.images.landscapePath,
          motion: 'kenburns-in',
          fit: 'cover',
          transitionIn: 'fade',
          transitionDuration: 0.5,
        },
        {
          type: 'gradient',
          duration: 1.5,
          gradient: ['#120c2b', '#2b1a4a'],
          angle: 45,
          transitionIn: 'slideleft',
          transitionDuration: 0.4,
        },
        {
          type: 'text',
          duration: 1.5,
          text: '谢谢观看',
          subtitle: 'SUBSCRIBE',
          font: 'msyh',
          fontSize: 88,
          color: '#ffffff',
          background: '#0b0b14',
          align: 'center',
          animation: 'slide-up',
          transitionIn: 'cut',
        },
      ],
      captions: [
        { start: 1.0, end: 3.0, text: '这是第一条中文字幕', position: 'bottom', fontSize: 44, color: '#ffffff' },
        { start: 4.0, end: 6.5, text: '第二条字幕 mixed with English', position: 'bottom', fontSize: 44, color: '#ffe9a8' },
      ],
      audio: {
        music: state.musicPath,
        musicStart: 0,
        musicVolumeDb: -20,
        musicFadeOut: 2,
        voiceover: [{ text: '欢迎来到我的频道，今天我们一起看一个视频。', start: 0.4, voice: 'zh', rate: 1.0 }],
      },
    }
    state.bigPlan = plan
    state.bigCommands = []
    const result = await buildVideo({
      tools: state.tools,
      plan,
      workDir: state.workDir,
      options: { onCommand: (command) => state.bigCommands.push(command) },
    })
    state.big = result
    assert.equal(result.ok, true)
    assert.equal(result.output, plan.output)
    assert.equal(result.scenes, 4)
    assert.equal(result.width, 1080)
    assert.equal(result.height, 1920)
    assert.equal(result.fps, 30)
    assert.ok(result.bytes > 0)
    assert.ok(result.renderSeconds > 0)
  })

  await check('build: output exists and is larger than 100 KB', async () => {
    assert.ok(await fileExists(state.big.output), `missing output ${state.big.output}`)
    const size = await fileSize(state.big.output)
    assert.ok(size > 100 * 1024, `output is only ${size} bytes`)
    assert.equal(size, state.big.bytes)
  })

  await check('build: ffprobe reports h264 1080x1920 @30 fps', async () => {
    const probed = await probe(state.tools, state.big.output)
    const video = probed.streams.filter((stream) => stream.codec_type === 'video')
    assert.equal(video.length, 1)
    assert.equal(video[0].codec_name, 'h264')
    assert.equal(video[0].width, 1080)
    assert.equal(video[0].height, 1920)
    assert.equal(video[0].avg_frame_rate, '30/1')
    assert.equal(video[0].pix_fmt, 'yuv420p')
  })

  await check('build: duration is 8 - 0.9 = 7.1 s within 0.15 s', async () => {
    const probed = await probe(state.tools, state.big.output)
    const measured = Number.parseFloat(probed.format.duration)
    assert.ok(Number.isFinite(measured), 'ffprobe reported no duration')
    assert.ok(Math.abs(measured - BIG_TOTAL) <= 0.15, `measured ${measured}s, expected ${BIG_TOTAL}s ±0.15`)
    assert.equal(state.big.duration, BIG_TOTAL)
    assert.ok(
      Math.abs(state.big.measuredDuration - BIG_TOTAL) <= 0.15,
      `result.measuredDuration ${state.big.measuredDuration} is off`,
    )
  })

  await check('build: exactly one audio stream (aac, 48 kHz stereo)', async () => {
    const probed = await probe(state.tools, state.big.output)
    const audio = probed.streams.filter((stream) => stream.codec_type === 'audio')
    assert.equal(audio.length, 1, `expected one audio stream, found ${audio.length}`)
    assert.equal(audio[0].codec_name, 'aac')
    assert.equal(Number(audio[0].sample_rate), 48_000)
    assert.equal(Number(audio[0].channels), 2)
    assert.equal(state.big.audio.voiceoverSegments, 1)
    assert.equal(state.big.audio.music, true)
    assert.equal(state.big.audio.loudnessNormalized, true)
  })

  await check('build: timeline matches the offset formula', async () => {
    const timeline = state.big.timeline
    assert.deepEqual(
      timeline.map((entry) => [entry.index, entry.type]),
      [[0, 'text'], [1, 'image'], [2, 'gradient'], [3, 'text']],
    )
    const expected = expectedTimeline(BIG_SCENES)
    assert.equal(expected[expected.length - 1].end, BIG_TOTAL)
    timeline.forEach((entry, index) => {
      assert.ok(
        Math.abs(entry.start - expected[index].start) <= 0.01,
        `timeline[${index}].start ${entry.start} != ${expected[index].start}`,
      )
      assert.ok(
        Math.abs(entry.end - expected[index].end) <= 0.01,
        `timeline[${index}].end ${entry.end} != ${expected[index].end}`,
      )
    })
    // Xfade overlap: scene 1 starts before scene 0 ends by exactly 0.5 s.
    assert.equal(round2(timeline[0].end - timeline[1].start), 0.5)
    assert.equal(round2(timeline[1].end - timeline[2].start), 0.4)
    assert.equal(round2(timeline[2].end - timeline[3].start), 0)
  })

  await check('build: frame at t≈1.5 shows the Chinese title in the centre', async () => {
    const stats = await frameStats(state, state.big.output, 1.5)
    assert.ok(stats.ymax > 180, `center-frame YMAX ${stats.ymax} is too low (text may be missing)`)
    assert.ok(stats.yavg > 25, `center-frame YAVG ${stats.yavg} is too low`)
    const band = await bandBrightness(state, state.big.output, 1.5, '1080:520:0:700', 150)
    assert.ok(
      band.ratio > 0.02 && band.ratio < 0.5,
      `title band bright-pixel ratio ${band.ratio.toFixed(3)} is outside [0.02, 0.5]:\n${band.ascii}`,
    )
    const linesWithInk = band.ascii.split('\n').filter((line) => /[#+]/.test(line)).length
    assert.ok(linesWithInk >= 4, `expected several text rows, got ${linesWithInk}:\n${band.ascii}`)
  })

  await check('build: caption is burned into the bottom band inside its time window', async () => {
    const inWindow = await bandBrightness(state, state.big.output, 1.5, '1080:220:0:1640', 120)
    const outOfWindow = await bandBrightness(state, state.big.output, 3.6, '1080:220:0:1640', 120)
    assert.ok(inWindow.ratio > 0.01, `caption band at t=1.5 has no bright pixels:\n${inWindow.ascii}`)
    assert.ok(
      inWindow.ratio > outOfWindow.ratio * 2,
      `caption evidence at t=1.5 (${inWindow.ratio.toFixed(3)}) is not clearly stronger than at t=3.6 (${outOfWindow.ratio.toFixed(3)})`,
    )
  })

  await check('build: text fade-in starts dark and reaches full brightness', async () => {
    const early = await frameStats(state, state.big.output, 0.03)
    const later = await frameStats(state, state.big.output, 1.2)
    assert.ok(early.yavg < later.yavg * 0.7, `fade-in missing: YAVG ${early.yavg} vs ${later.yavg}`)
  })

  await check('build: loudness is normalized near -16 LUFS', async () => {
    const loudness = await measureLoudness(state, state.big.output)
    assert.ok(
      Math.abs(loudness + 16) <= 2.5,
      `integrated loudness ${loudness} LUFS is not within ±2.5 LU of -16`,
    )
  })

  await check('build: no absolute path ever enters a filtergraph', async () => {
    const stages = state.bigCommands.map((command) => command.stage)
    assert.ok(stages.some((stage) => stage.startsWith('scene 0')), `scene 0 not captured: ${stages.join(', ')}`)
    assert.ok(stages.some((stage) => stage.startsWith('scene 1')))
    assert.ok(stages.some((stage) => stage.startsWith('scene 2')))
    assert.ok(stages.some((stage) => stage.startsWith('scene 3')))
    assert.ok(stages.includes('assembly'))
    assert.ok(stages.includes('caption burn'))
    const graphs = assertFiltergraphsAreRelative(state.bigCommands)
    assert.ok(graphs.some((graph) => graph.includes('xfade=transition=fade')))
    assert.ok(graphs.some((graph) => graph.includes('xfade=transition=slideleft')))
    assert.ok(graphs.some((graph) => graph.includes('concat=n=2')))
    assert.ok(graphs.some((graph) => graph.includes('loudnorm=I=-16')))
  })

  await check('build: result is JSON-serializable with finite numbers', async () => {
    assertJsonSafe(state.big)
    assert.ok(Array.isArray(state.big.warnings))
    for (const warning of state.big.warnings) assert.equal(typeof warning, 'string')
  })

  // --- narration -----------------------------------------------------------
  await check('tts: listVoices reports installed SAPI voices', async () => {
    const voices = await listVoices()
    assert.ok(Array.isArray(voices) && voices.length > 0, 'no SAPI voices reported')
    for (const voice of voices) {
      assert.equal(typeof voice.name, 'string')
      assert.equal(typeof voice.culture, 'string')
      assert.equal(typeof voice.gender, 'string')
    }
    assert.ok(voices.some((voice) => voice.culture.toLowerCase().startsWith('zh')), `no zh voice in ${JSON.stringify(voices)}`)
    assert.ok(voices.some((voice) => voice.culture.toLowerCase().startsWith('en')), `no en voice in ${JSON.stringify(voices)}`)
  })

  await check('tts: Chinese narration is a readable 16 kHz mono wav >1 s', async () => {
    const outputPath = join(state.workDir, 'tts', 'zh.wav')
    const result = await synthesizeSpeech({
      tools: state.tools,
      text: '欢迎来到我的频道，今天我们一起看一个视频。',
      outputPath,
      voice: 'zh',
      rate: 1.0,
      workDir: state.workDir,
    })
    assert.equal(result.ok, true, `synthesis failed: ${result.warnings.join('; ')}`)
    assert.equal(result.path, outputPath)
    assert.ok(await fileExists(outputPath))
    assert.ok((await fileSize(outputPath)) > 5 * 1024, 'wav is smaller than 5 KB')
    assert.ok(result.seconds > 1, `duration ${result.seconds}s is not > 1s`)
    assert.ok(result.voice !== null && result.voice.length > 0)
    const probed = await probe(state.tools, outputPath)
    const audio = probed.streams.filter((stream) => stream.codec_type === 'audio')[0]
    assert.equal(audio.codec_name, 'pcm_s16le')
    assert.equal(Number(audio.sample_rate), 16_000)
    assert.equal(Number(audio.channels), 1)
    assert.ok(Math.abs(Number.parseFloat(probed.format.duration) - result.seconds) <= 0.06)
    assertJsonSafe(result)
  })

  await check('tts: English narration picks the en-US voice', async () => {
    const outputPath = join(state.workDir, 'tts', 'en.wav')
    const result = await synthesizeSpeech({
      tools: state.tools,
      text: 'Welcome to my channel. Today we rebuild a reference video.',
      outputPath,
      voice: 'en',
      rate: 1.0,
      workDir: state.workDir,
    })
    assert.equal(result.ok, true, `synthesis failed: ${result.warnings.join('; ')}`)
    const voices = await listVoices()
    const englishVoice = voices.find((voice) => voice.culture.toLowerCase().startsWith('en'))
    assert.ok(englishVoice !== undefined, 'no en-US voice installed')
    assert.equal(result.voice, englishVoice.name)
    assert.ok((await fileSize(outputPath)) > 5 * 1024)
    assert.ok(result.seconds > 1)
  })

  await check('tts: empty text returns ok:false instead of throwing', async () => {
    const result = await synthesizeSpeech({
      tools: state.tools,
      text: '   ',
      outputPath: join(state.workDir, 'tts', 'empty.wav'),
      workDir: state.workDir,
    })
    assert.equal(result.ok, false)
    assert.ok(result.warnings.length > 0)
    assertJsonSafe(result)
  })

  // --- degenerate plans ----------------------------------------------------
  await check('degenerate: empty scene list is rejected with a clear error', async () => {
    const plan = { ...state.bigPlan, output: join(state.workDir, 'bad', 'empty.mp4'), scenes: [] }
    await assert.rejects(
      () => buildVideo({ tools: state.tools, plan, workDir: state.workDir }),
      (error) => error instanceof Error && /scenes must be a non-empty array/u.test(error.message),
    )
    assert.equal(await fileExists(plan.output), false, 'a half-written MP4 was produced')
  })

  await check('degenerate: missing image file is rejected before rendering', async () => {
    const plan = {
      output: join(state.workDir, 'bad', 'missing-image.mp4'),
      width: 540,
      height: 960,
      fps: 30,
      scenes: [
        { type: 'image', duration: 2, src: join(state.workDir, 'does-not-exist.png') },
      ],
    }
    await assert.rejects(
      () => buildVideo({ tools: state.tools, plan, workDir: state.workDir }),
      (error) => error instanceof Error && /not found/u.test(error.message),
    )
    assert.equal(await fileExists(plan.output), false, 'a half-written MP4 was produced')
  })

  await check('degenerate: scene duration below 0.2 s is rejected', async () => {
    const plan = {
      output: join(state.workDir, 'bad', 'too-short.mp4'),
      width: 1080,
      height: 1920,
      fps: 30,
      scenes: [{ type: 'color', duration: 0.05 }],
    }
    await assert.rejects(
      () => buildVideo({ tools: state.tools, plan, workDir: state.workDir }),
      (error) => error instanceof Error && /duration must be a number >= 0\.2/u.test(error.message),
    )
    assert.equal(await fileExists(plan.output), false, 'a half-written MP4 was produced')
  })

  await check('degenerate: non-object plan and missing output are rejected', async () => {
    await assert.rejects(
      () => buildVideo({ tools: state.tools, plan: null, workDir: state.workDir }),
      /RenderPlan object/u,
    )
    await assert.rejects(
      () => buildVideo({ tools: state.tools, plan: { scenes: [] }, workDir: state.workDir }),
      /output is required/u,
    )
  })

  await check('abort: a pre-aborted signal fails fast without writing output', async () => {
    const controller = new AbortController()
    controller.abort()
    const plan = { ...state.bigPlan, output: join(state.workDir, 'bad', 'aborted.mp4') }
    await assert.rejects(
      () => buildVideo({ tools: state.tools, plan, workDir: state.workDir, signal: controller.signal }),
      (error) => error instanceof Error && error.name === 'AbortError',
    )
    assert.equal(await fileExists(plan.output), false)
  })

  // --- silent / caption-less plans + determinism ---------------------------
  const silentPlan = () => ({
    output: join(state.workDir, 'silent', 'out.mp4'),
    width: 320,
    height: 568,
    fps: 25,
    background: '#0b0b14',
    loudnessTarget: -16,
    scenes: [
      { type: 'color', duration: 1, background: '#141428' },
      {
        type: 'gradient',
        duration: 1.2,
        gradient: ['#141428', '#4a2b6a'],
        angle: 120,
        transitionIn: 'fade',
        transitionDuration: 0.3,
      },
      { type: 'text', duration: 0.8, text: '你好', fontSize: 64, color: '#ffffff', background: '#101020' },
    ],
    captions: [],
  })

  await check('build: plan without audio or captions still yields one audio stream', async () => {
    const plan = silentPlan()
    const commands = []
    const result = await buildVideo({
      tools: state.tools,
      plan,
      workDir: state.workDir,
      options: { onCommand: (command) => commands.push(command) },
    })
    assert.equal(result.ok, true)
    assert.equal(result.audio.music, false)
    assert.equal(result.audio.voiceoverSegments, 0)
    assert.equal(result.audio.loudnessNormalized, false)
    const probed = await probe(state.tools, result.output)
    assert.equal(probed.streams.filter((stream) => stream.codec_type === 'audio').length, 1)
    assert.ok(Math.abs(Number.parseFloat(probed.format.duration) - 2.7) <= 0.15)
    assert.deepEqual(
      result.timeline.map((entry) => entry.end),
      [1, 1.9, 2.7],
    )
    assert.ok(!commands.some((command) => command.stage === 'caption burn'), 'caption pass ran for an empty caption list')
    assertFiltergraphsAreRelative(commands)
    assert.equal(result.warnings.length, 0, `unexpected warnings: ${result.warnings.join(' | ')}`)
  })

  await check('build: same plan twice produces the same timeline and duration', async () => {
    const first = await buildVideo({ tools: state.tools, plan: silentPlan(), workDir: state.workDir })
    const second = await buildVideo({ tools: state.tools, plan: silentPlan(), workDir: state.workDir })
    assert.deepEqual(second.timeline, first.timeline)
    assert.equal(second.duration, first.duration)
    assert.equal(second.width, first.width)
    assert.equal(second.height, first.height)
    const firstProbe = await probe(state.tools, first.output)
    const secondProbe = await probe(state.tools, second.output)
    assert.ok(
      Math.abs(Number.parseFloat(firstProbe.format.duration) - Number.parseFloat(secondProbe.format.duration)) <= 1 / 25 + 1e-6,
      'two runs of the same plan differ by more than one frame',
    )
  })

  await check('build: missing music file degrades to a warning, not a failure', async () => {
    const plan = {
      ...silentPlan(),
      output: join(state.workDir, 'missing-music', 'out.mp4'),
      audio: { music: join(state.workDir, 'nope-music.mp3'), musicVolumeDb: -18, musicFadeOut: 1 },
    }
    const result = await buildVideo({ tools: state.tools, plan, workDir: state.workDir })
    assert.equal(result.ok, true)
    assert.equal(result.audio.music, false)
    assert.ok(
      result.warnings.some((warning) => /music file not found/u.test(warning)),
      `expected a missing-music warning, got ${JSON.stringify(result.warnings)}`,
    )
  })

  // --- full schema coverage (motions / transitions / caption positions) ----
  await check('build: supports video/pan/contain/wipe/circle/dissolve and top captions', async () => {
    const plan = {
      output: join(state.workDir, 'variants', 'out.mp4'),
      width: 320,
      height: 568,
      fps: 25,
      background: '#08080f',
      loudnessTarget: null,
      scenes: [
        { type: 'color', duration: 1, background: '#101020', transitionIn: 'cut' },
        {
          type: 'video',
          duration: 1.2,
          src: state.segmentPath,
          fit: 'contain',
          muted: false,
          transitionIn: 'wipeleft',
          transitionDuration: 0.3,
        },
        {
          type: 'image',
          duration: 1.2,
          src: state.images.portraitPath,
          motion: 'pan-left',
          fit: 'contain',
          transitionIn: 'circleopen',
          transitionDuration: 0.3,
        },
        {
          type: 'gradient',
          duration: 1,
          gradient: ['#0a1a2a', '#2a0a1a'],
          angle: 0,
          transitionIn: 'dissolve',
          transitionDuration: 0.3,
        },
        {
          type: 'text',
          duration: 0.8,
          text: '左对齐',
          align: 'left',
          fontSize: 60,
          color: '#ffe9a8',
          background: '#000000',
          transitionIn: 'fade',
          transitionDuration: 0.3,
        },
      ],
      captions: [
        {
          start: 0.5,
          end: 2.0,
          text: '这是一条很长的字幕用来测试自动换行功能是否正常工作并且不会溢出画面',
          position: 'top',
          fontSize: 40,
        },
      ],
      audio: { music: state.musicPath, musicVolumeDb: -14, musicFadeOut: 1 },
    }
    const commands = []
    const result = await buildVideo({
      tools: state.tools,
      plan,
      workDir: state.workDir,
      options: { onCommand: (command) => commands.push(command) },
    })
    assert.equal(result.ok, true, `warnings: ${result.warnings.join(' | ')}`)
    assert.equal(result.audio.music, true)
    assert.equal(result.audio.loudnessNormalized, false, 'loudnessTarget:null must skip loudnorm')
    const expected = expectedTimeline(plan.scenes)
    result.timeline.forEach((entry, index) => {
      assert.ok(Math.abs(entry.start - expected[index].start) <= 0.01, `variants timeline[${index}].start`)
      assert.ok(Math.abs(entry.end - expected[index].end) <= 0.01, `variants timeline[${index}].end`)
    })
    assert.deepEqual(
      result.timeline.map((entry) => entry.type),
      ['color', 'video', 'image', 'gradient', 'text'],
    )
    const probed = await probe(state.tools, result.output)
    assert.ok(
      Math.abs(Number.parseFloat(probed.format.duration) - (5.2 - 1.2)) <= 0.15,
      `variants duration ${probed.format.duration} != 4.0`,
    )
    // Video scenes never contribute audio, and saying muted:false must warn.
    assert.ok(
      result.warnings.some((warning) => /audio from video scenes is never mixed/u.test(warning)),
      `expected a video-scene audio warning, got ${JSON.stringify(result.warnings)}`,
    )
    const graphs = assertFiltergraphsAreRelative(commands)
    assert.ok(stagesOf(commands).includes('scene 1 (video)'), 'video scene clip was not rendered')
    assert.ok(graphs.some((graph) => graph.includes('zoompan=')))
    assert.ok(graphs.some((graph) => graph.includes('pad=320:568')), 'video contain fit should pad to the frame')
    assert.ok(graphs.some((graph) => graph.includes('pad=448:796')), 'motion contain fit should pad the 1.4x canvas')
    assert.ok(graphs.some((graph) => graph.includes('transition=wipeleft')))
    assert.ok(graphs.some((graph) => graph.includes('transition=circleopen')))
    assert.ok(graphs.some((graph) => graph.includes('transition=dissolve')))
    assert.ok(graphs.some((graph) => graph.includes("enable='between(t,0.5,2)'")))
    assert.ok(!graphs.some((graph) => graph.includes('loudnorm')), 'loudnorm ran despite loudnessTarget:null')
  })

  await check('build: video scene shorter than its duration freezes the last frame', async () => {
    const plan = {
      output: join(state.workDir, 'video-freeze', 'out.mp4'),
      width: 320,
      height: 568,
      fps: 25,
      background: '#08080f',
      scenes: [
        { type: 'video', duration: 2, src: state.segmentPath, fit: 'cover' },
      ],
    }
    const commands = []
    const result = await buildVideo({
      tools: state.tools,
      plan,
      workDir: state.workDir,
      options: { onCommand: (command) => commands.push(command) },
    })
    assert.equal(result.ok, true, `warnings: ${result.warnings.join(' | ')}`)
    assert.equal(result.duration, 2)
    assert.deepEqual(result.timeline, [{ index: 0, type: 'video', start: 0, end: 2 }])
    const probed = await probe(state.tools, result.output)
    assert.ok(Math.abs(Number.parseFloat(probed.format.duration) - 2) <= 0.15)
    const graphs = assertFiltergraphsAreRelative(commands)
    assert.ok(
      graphs.some((graph) => graph.includes('tpad=stop_mode=clone')),
      'expected the last frame to be frozen with tpad',
    )
    // The source is 1.5 s; both samples land in the frozen tail and must match.
    const frozenA = await frameStats(state, result.output, 1.7)
    const frozenB = await frameStats(state, result.output, 1.95)
    assert.ok(Math.abs(frozenA.yavg - frozenB.yavg) < 2, `frozen tail changed brightness: ${frozenA.yavg} vs ${frozenB.yavg}`)
    assert.ok(Math.abs(frozenA.ymax - frozenB.ymax) < 4, `frozen tail changed content: ${frozenA.ymax} vs ${frozenB.ymax}`)
  })

  await check('build: video scene plays at a different rate without changing the slot length', async () => {
    const slowPlan = {
      output: join(state.workDir, 'rate', 'slow.mp4'),
      width: 320,
      height: 568,
      fps: 25,
      scenes: [{ type: 'video', duration: 1, src: state.segmentPath, fit: 'cover', rate: 0.5 }],
    }
    const commands = []
    const result = await buildVideo({
      tools: state.tools,
      plan: slowPlan,
      workDir: state.workDir,
      options: { onCommand: (command) => commands.push(command) },
    })
    assert.equal(result.ok, true, `warnings: ${result.warnings.join(' | ')}`)
    // The slot length is the authored duration, not the source length.
    assert.equal(result.duration, 1, `rate must not change the timeline, got ${result.duration}`)
    const graphs = assertFiltergraphsAreRelative(commands)
    assert.ok(
      graphs.some((graph) => graph.includes('setpts=PTS/0.5')),
      'expected a setpts speed change in the scene filtergraph',
    )
  })

  await check('build: hold freezes the tail of a video scene inside its own slot', async () => {
    const plan = {
      output: join(state.workDir, 'hold', 'out.mp4'),
      width: 320,
      height: 568,
      fps: 25,
      scenes: [{ type: 'video', duration: 2, src: state.segmentPath, fit: 'cover', hold: 0.6 }],
    }
    const result = await buildVideo({ tools: state.tools, plan, workDir: state.workDir })
    assert.equal(result.ok, true, `warnings: ${result.warnings.join(' | ')}`)
    assert.equal(result.duration, 2, 'hold must not lengthen the timeline')
    // The last 0.6 s is a still frame: two samples inside it must match.
    const a = await frameStats(state, result.output, 1.6)
    const b = await frameStats(state, result.output, 1.95)
    assert.ok(Math.abs(a.yavg - b.yavg) < 2, `hold tail changed: ${a.yavg} vs ${b.yavg}`)
    assert.ok(Math.abs(a.ymax - b.ymax) < 4, `hold tail content changed: ${a.ymax} vs ${b.ymax}`)
  })

  await check('build: an overlay appears only inside its window', async () => {
    // A solid red badge over a black base: presence is a pixel fact, not a guess.
    const badge = join(state.workDir, 'overlay-badge.png')
    await run(state.tools.ffmpeg, [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff3355:s=240x140:d=1',
      '-frames:v', '1', 'overlay-badge.png',
    ], { cwd: state.workDir })
    const plan = {
      output: join(state.workDir, 'overlay', 'out.mp4'),
      width: 320,
      height: 180,
      fps: 10,
      scenes: [{ type: 'color', duration: 4, background: '#000000' }],
      overlays: [{ src: badge, start: 1, end: 3, position: 'bottom-right', width: 0.3, opacity: 1 }],
    }
    const result = await buildVideo({ tools: state.tools, plan, workDir: state.workDir })
    assert.equal(result.ok, true, `warnings: ${result.warnings.join(' | ')}`)
    assert.equal(result.duration, 4, 'overlays are a separate track and must not change the timeline')

    // Sample the bottom-right quadrant on a small raster.
    const quadrantMaxRed = async (time) => {
      await run(state.tools.ffmpeg, [
        '-v', 'error', '-y', '-ss', String(time), '-i', result.output,
        '-frames:v', '1', '-vf', 'scale=32:18,format=rgb24', '-f', 'rawvideo', 'q.raw',
      ], { cwd: state.workDir })
      const buffer = await readFile(join(state.workDir, 'q.raw'))
      let max = 0
      for (let y = 12; y < 18; y += 1) {
        for (let x = 21; x < 32; x += 1) {
          const value = buffer[(y * 32 + x) * 3]
          if (value > max) max = value
        }
      }
      return max
    }
    assert.ok(await quadrantMaxRed(2) > 120, 'the overlay must be visible inside [1s, 3s]')
    assert.ok(await quadrantMaxRed(0.3) < 40, 'the overlay must be absent before its window')
    assert.ok(await quadrantMaxRed(3.6) < 40, 'the overlay must be absent after its window')
  })

  await check('build: a top-left overlay lands top-left, not by accident', async () => {
    const badge = join(state.workDir, 'overlay-corner.png')
    await run(state.tools.ffmpeg, [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x33ff55:s=200x120:d=1',
      '-frames:v', '1', 'overlay-corner.png',
    ], { cwd: state.workDir })
    const plan = {
      output: join(state.workDir, 'corner', 'out.mp4'),
      width: 320,
      height: 180,
      fps: 10,
      scenes: [{ type: 'color', duration: 2, background: '#000000' }],
      overlays: [{ src: badge, start: 0, end: 2, position: 'top-left', width: 0.3 }],
    }
    const result = await buildVideo({ tools: state.tools, plan, workDir: state.workDir })
    assert.equal(result.ok, true, `warnings: ${result.warnings.join(' | ')}`)
    await run(state.tools.ffmpeg, [
      '-v', 'error', '-y', '-ss', '1', '-i', result.output,
      '-frames:v', '1', '-vf', 'scale=32:18,format=rgb24', '-f', 'rawvideo', 'c.raw',
    ], { cwd: state.workDir })
    const buffer = await readFile(join(state.workDir, 'c.raw'))
    const greenAt = (x, y) => buffer[(y * 32 + x) * 3 + 1]
    // ffmpeg's overlay variables are W/H = main and w/h = overlay; a mix-up puts
    // every overlay in the corner, so both corners are asserted explicitly.
    assert.ok(greenAt(1, 1) > 120, `top-left should hold the badge, got green=${greenAt(1, 1)}`)
    assert.ok(greenAt(30, 16) < 60, `bottom-right should stay empty, got green=${greenAt(30, 16)}`)
  })

  await check('build: music ducks under narration by the requested amount, and only there', async () => {
    const music = join(state.workDir, 'duck-music.wav')
    await run(state.tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'pcm_s16le', 'duck-music.wav'], { cwd: state.workDir })
    // A silent narration file: the schedule exists so ducking fires, but the voice
    // adds no level, which isolates the bed's attenuation from the voice.
    await run(state.tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1.5', '-c:a', 'pcm_s16le', 'duck-voice.wav'], { cwd: state.workDir })

    const planFor = (duck) => ({
      output: join(state.workDir, 'duck', `out-${duck ? 'on' : 'off'}.mp4`),
      width: 160,
      height: 90,
      fps: 10,
      loudnessTarget: null,
      scenes: [{ type: 'color', duration: 6, background: '#101010' }],
      audio: {
        music,
        musicVolumeDb: -6,
        musicFadeOut: 0,
        duck,
        duckDb: -12,
        voiceover: [{ src: join(state.workDir, 'duck-voice.wav'), start: 2 }],
      },
    })
    const rms = (file, from, to) => {
      const result = spawnSync(state.tools.ffmpeg, ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-af', 'astats', '-f', 'null', '-'], { encoding: 'utf8' })
      const match = /RMS level dB:\s*(-?\d+(?:\.\d+)?)/u.exec(result.stderr)
      assert.ok(match !== null, 'astats must report an RMS level')
      return Number.parseFloat(match[1])
    }

    const off = await buildVideo({ tools: state.tools, plan: planFor(false), workDir: state.workDir })
    const on = await buildVideo({ tools: state.tools, plan: planFor(true), workDir: state.workDir })
    assert.equal(on.ok, true, `warnings: ${on.warnings.join(' | ')}`)
    // Outside the narration window the two mixes must be identical.
    const beforeOff = rms(off.output, 0.5, 1.3)
    const beforeOn = rms(on.output, 0.5, 1.3)
    assert.ok(Math.abs(beforeOff - beforeOn) < 0.5, `ducking must not touch the bed outside narration: ${beforeOff} vs ${beforeOn}`)
    // Inside the window the bed must drop by roughly duckDb.
    const drop = rms(off.output, 2.3, 3.2) - rms(on.output, 2.3, 3.2)
    assert.ok(drop > 8, `expected the bed to drop ~12 dB under narration, measured ${drop.toFixed(2)} dB`)
    assert.ok(drop < 18, `ducking over-attenuated: ${drop.toFixed(2)} dB`)
  })

  await check('build: duckGainExpression is empty without narration and sums overlapping lines', () => {
    assert.equal(duckGainExpression([], -12, 10), undefined)
    assert.equal(duckGainExpression(undefined, -12, 10), undefined)
    const one = duckGainExpression([{ start: 2, end: 4 }], -12, 10)
    assert.ok(typeof one === 'string' && one.startsWith('1+'), one)
    // Two overlapping lines must not multiply into a deeper dip.
    const two = duckGainExpression([{ start: 2, end: 4 }, { start: 3, end: 5 }], -12, 10)
    const depthOf = (expression) => Number.parseFloat(/-?0\.\d+/u.exec(expression)?.[0] ?? '0')
    assert.ok(
      Math.abs(depthOf(two) - depthOf(one)) < 0.001,
      `overlap changed the depth: ${depthOf(one)} vs ${depthOf(two)}`,
    )
  })

  await check('degenerate: missing video source is rejected with a clear error', async () => {
    const plan = {
      output: join(state.workDir, 'bad', 'missing-video.mp4'),
      width: 320,
      height: 568,
      fps: 25,
      scenes: [{ type: 'video', duration: 2, src: join(state.workDir, 'nope-segment.mp4') }],
    }
    await assert.rejects(
      () => buildVideo({ tools: state.tools, plan, workDir: state.workDir }),
      (error) => error instanceof Error && /file not found/u.test(error.message),
    )
    assert.equal(await fileExists(plan.output), false, 'a half-written MP4 was produced')
  })

  // --- keep a copy of the sample for manual inspection ---------------------
  await check('deliverable: rendered sample copied to a stable temp path', async () => {
    await copyFile(state.big.output, SAMPLE_PATH)
    assert.ok(await fileSize(SAMPLE_PATH) > 100 * 1024)
    const probed = await probe(state.tools, SAMPLE_PATH)
    const seconds = Number.parseFloat(probed.format.duration)
    const megabytes = ((await fileSize(SAMPLE_PATH)) / (1024 * 1024)).toFixed(2)
    console.log(`      sample: ${SAMPLE_PATH}`)
    console.log(`      sample: ${megabytes} MB, ${seconds.toFixed(2)} s, loudness ${state.big.audio.loudnessNormalized ? '-16 LUFS target' : 'raw'}`)
    console.log(`      render: ${state.big.renderSeconds}s, warnings: ${state.big.warnings.length}`)
  })

  await removeWorkDir(state.workDir)
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exitCode = 1
})
