#!/usr/bin/env node
/**
 * Acceptance tests for lib/timeline.js — editable delivery.
 *
 * Run: node test/timeline.test.mjs
 *
 * Three layers are verified:
 *  1. planToTimeline / timelineToPlan round-trip: the build-engine fixture shape
 *     (4 scenes, xfade transitions, captions, music, Chinese narration) plus an
 *     extended shape (video rate/hold, still + clip overlays, duck off, sfx).
 *     "Lossless" is asserted as a timeline fixed point: re-normalising the
 *     round-tripped plan yields the identical timeline, and the plan renders
 *     equivalently through lib/build.js (small real render).
 *  2. renderTimelineHtml: embedded JSON, no external URL, deterministic output,
 *     `<script>` escaping, and the editor is actually booted in a tiny DOM stub
 *     to prove its exported RenderPlan matches timelineToPlan() byte-for-byte.
 *  3. diffTimeline: detects text / duration / volume / clip / track / meta edits,
 *     ignores no-op edits, returns deterministic Chinese descriptions.
 *
 * Pure tests except the final render-equivalence check, which uses ffmpeg.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  TIMELINE_TRACK_KINDS,
  TIMELINE_VERSION,
  diffTimeline,
  planToTimeline,
  renderTimelineHtml,
  timelineDuration,
  timelineToPlan,
} from '../lib/timeline.js'
import { makeWorkDir, probe, removeWorkDir, resolveTools } from '../lib/ffmpeg.js'
import { buildVideo } from '../lib/build.js'

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

function assertJsonSafe(value, label) {
  assertFiniteTree(value, label)
  const roundTripped = JSON.parse(JSON.stringify(value))
  assert.deepEqual(roundTripped, value, `${label} does not survive a JSON round-trip unchanged`)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** The plan fixture shape used by test/build-engine.test.mjs (4 scenes + captions + audio). */
function buildFixturePlan() {
  return {
    output: 'D:/work/out/sample.mp4',
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
        src: 'D:/work/images/landscape.png',
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
      music: 'D:/work/audio/music.wav',
      musicStart: 0,
      musicVolumeDb: -20,
      musicFadeOut: 2,
      voiceover: [{ text: '欢迎来到我的频道，今天我们一起看一个视频。', start: 0.4, voice: 'zh', rate: 1.0 }],
    },
  }
}

/** Extended fixture: video rate/hold, both overlay kinds, duck off, sfx, src narration. */
function buildEdgePlan() {
  return {
    output: 'D:/work/out/two.mp4',
    width: 640,
    height: 360,
    fps: 25,
    background: '#0b0b14',
    loudnessTarget: null,
    scenes: [
      {
        type: 'video',
        duration: 2.5,
        src: 'D:/work/anim/seg.mp4',
        fit: 'contain',
        muted: true,
        rate: 1.25,
        hold: 0.5,
        transitionIn: 'cut',
      },
      { type: 'color', duration: 1, background: '#223344', transitionIn: 'fade', transitionDuration: 0.3 },
    ],
    overlays: [
      {
        src: 'D:/work/img/badge.png',
        start: 0.5,
        end: 2,
        width: 0.32,
        position: 'top-left',
        opacity: 0.8,
        fadeIn: 0.2,
        fadeOut: 0.1,
      },
      { src: 'D:/work/anim/logo.mp4', start: 1, end: 2.5, width: 0.2, position: 'bottom-right' },
    ],
    captions: [],
    audio: {
      music: 'D:/work/audio/bed.wav',
      musicStart: 1.5,
      musicVolumeDb: -14,
      musicFadeOut: 0.8,
      duck: false,
      duckDb: -12,
      voiceover: [{ src: 'D:/work/audio/vo.wav', start: 0.6, volumeDb: -3, voice: 'zh', rate: 0.9 }],
      sfx: [{ kind: 'whoosh', start: 1.2, duration: 0.4, volumeDb: -6 }],
    },
  }
}

/**
 * Boot the embedded HTML editor in a minimal DOM stub.
 *
 * The page script only needs getElementById/createElement/querySelector and a
 * handful of element methods; everything else is global. Compiling it with
 * `new Function` also proves the emitted JS is syntactically valid.
 */
function bootEditor(html) {
  const dataMatch = /<script id="timeline-data" type="application\/json">([\s\S]*?)<\/script>/u.exec(html)
  assert.ok(dataMatch, 'timeline-data script block missing')
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1])
  assert.equal(inlineScripts.length, 1, 'expected exactly one inline editor script')
  assert.doesNotThrow(() => new Function(inlineScripts[0]), 'editor JS has a syntax error')

  const elements = new Map()
  const makeEl = (id) => ({
    id,
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    children: [],
    clientWidth: 600,
    onclick: null,
    appendChild(child) {
      this.children.push(child)
      return child
    },
    removeChild() {},
    setAttribute() {},
    getAttribute() {
      return null
    },
    classList: { contains() { return false } },
  })
  const document = {
    getElementById(id) {
      if (id === 'timeline-data') return { textContent: dataMatch[1] }
      if (!elements.has(id)) elements.set(id, makeEl(id))
      return elements.get(id)
    },
    querySelector: () => makeEl('query'),
    createElement: () => makeEl('created'),
    addEventListener() {},
    body: { appendChild() {}, removeChild() {} },
  }
  const window = {}
  class BlobStub {
    constructor(parts) {
      this.parts = parts
    }
  }
  const urlStub = { createObjectURL: () => 'blob:stub', revokeObjectURL() {} }
  const runner = new Function(
    'document',
    'window',
    'navigator',
    'URL',
    'Blob',
    'setTimeout',
    'clearTimeout',
    inlineScripts[0],
  )
  runner(document, window, {}, urlStub, BlobStub, setTimeout, clearTimeout)
  assert.ok(window.__MS_TIMELINE_EDITOR__, 'editor did not expose window.__MS_TIMELINE_EDITOR__')
  return window.__MS_TIMELINE_EDITOR__
}

async function main() {
  const fixture = buildFixturePlan()
  const timeline = planToTimeline(fixture)
  const roundTrippedPlan = timelineToPlan(timeline)
  const edgePlan = buildEdgePlan()
  const edgeTimeline = planToTimeline(edgePlan)

  /* ------------------------------------------------- timeline structure */

  await check('planToTimeline: version, canvas meta, duration and output survive', () => {
    assert.equal(timeline.version, TIMELINE_VERSION)
    assert.equal(timeline.width, 1080)
    assert.equal(timeline.height, 1920)
    assert.equal(timeline.fps, 30)
    assert.equal(timeline.duration, 7.1)
    assert.equal(timeline.output, fixture.output)
    assert.equal(timeline.background, '#101018')
    assert.equal(timeline.loudnessTarget, -16)
    assert.deepEqual(TIMELINE_TRACK_KINDS, ['video', 'text', 'image', 'audio', 'sfx'])
  })

  await check('planToTimeline: one track per NLE concept with correct kinds and clip counts', () => {
    assert.deepEqual(
      timeline.tracks.map((track) => [track.id, track.kind, track.clips.length]),
      [
        ['scenes', 'video', 4],
        ['captions', 'text', 2],
        ['music', 'audio', 1],
        ['voiceover', 'audio', 1],
      ],
    )
    for (const track of timeline.tracks) {
      assert.ok(TIMELINE_TRACK_KINDS.includes(track.kind), `bad kind ${track.kind}`)
    }
  })

  await check('planToTimeline: scene clips carry absolute start/end for the xfade overlap', () => {
    const scenes = timeline.tracks[0].clips
    assert.deepEqual(
      scenes.map((clip) => [clip.id, clip.start, clip.end]),
      [
        ['scene-0', 0, 2],
        ['scene-1', 1.5, 4.5],
        ['scene-2', 4.1, 5.6],
        ['scene-3', 5.6, 7.1],
      ],
    )
    // 2 + 3 + 1.5 + 1.5 - 0.5 - 0.4 = 7.1, and the overlaps are exactly the transitions.
    assert.equal(timelineDuration(timeline), 7.1)
  })

  await check('planToTimeline: scene content and transitions are preserved verbatim', () => {
    const scenes = timeline.tracks[0].clips
    assert.equal(scenes[0].type, 'text')
    assert.equal(scenes[0].text, '仿制视频\n第一幕')
    assert.equal(scenes[0].subtitle, '观看 · 学习 · 复刻')
    assert.equal(scenes[0].font, 'msyhbd')
    assert.equal(scenes[0].fontSize, 96)
    assert.equal(scenes[0].animation, 'fade')
    assert.equal(scenes[0].transitionIn, 'cut')
    assert.equal(scenes[0].transitionDuration, 0)
    assert.equal(scenes[1].type, 'image')
    assert.equal(scenes[1].src, 'D:/work/images/landscape.png')
    assert.equal(scenes[1].motion, 'kenburns-in')
    assert.equal(scenes[1].transitionIn, 'fade')
    assert.equal(scenes[1].transitionDuration, 0.5)
    assert.equal(scenes[2].type, 'gradient')
    assert.deepEqual(scenes[2].gradient, ['#120c2b', '#2b1a4a'])
    assert.equal(scenes[2].angle, 45)
    assert.equal(scenes[2].transitionIn, 'slideleft')
    assert.equal(scenes[2].transitionDuration, 0.4)
    assert.equal(scenes[3].text, '谢谢观看')
    assert.equal(scenes[3].animation, 'slide-up')
  })

  await check('planToTimeline: captions become text-track clips with duration and style', () => {
    const captions = timeline.tracks[1].clips
    assert.equal(captions[0].id, 'caption-0')
    assert.equal(captions[0].start, 1)
    assert.equal(captions[0].end, 3)
    assert.equal(captions[0].duration, 2)
    assert.equal(captions[0].text, '这是第一条中文字幕')
    assert.equal(captions[0].position, 'bottom')
    assert.equal(captions[0].fontSize, 44)
    assert.equal(captions[0].color, '#ffffff')
    assert.equal(captions[1].start, 4)
    assert.equal(captions[1].duration, 2.5)
    assert.equal(captions[1].color, '#ffe9a8')
  })

  await check('planToTimeline: audio tracks carry volume, in-point, fade and duck settings', () => {
    const musicTrack = timeline.tracks.find((track) => track.id === 'music')
    const musicClip = musicTrack.clips[0]
    assert.equal(musicClip.src, 'D:/work/audio/music.wav')
    assert.equal(musicClip.start, 0)
    assert.equal(musicClip.duration, 7.1)
    assert.equal(musicClip.inPoint, 0)
    assert.equal(musicClip.volumeDb, -20)
    assert.equal(musicClip.fadeOut, 2)
    assert.equal(musicTrack.duck, true)
    assert.equal(musicTrack.duckDb, -9)
    const voiceClip = timeline.tracks.find((track) => track.id === 'voiceover').clips[0]
    assert.equal(voiceClip.text, '欢迎来到我的频道，今天我们一起看一个视频。')
    assert.equal(voiceClip.start, 0.4)
    assert.equal(voiceClip.volumeDb, 0)
    assert.equal(voiceClip.voice, 'zh')
    assert.equal(voiceClip.rate, 1)
    assert.equal(voiceClip.duration, null, 'TTS voiceover length is unknown until render')
  })

  await check('planToTimeline: markers cover scenes/captions/audio and are sorted by time', () => {
    assert.equal(timeline.markers.length, 8) // 4 scenes + 2 captions + music + voiceover
    for (let index = 1; index < timeline.markers.length; index += 1) {
      assert.ok(
        timeline.markers[index - 1].timeSeconds <= timeline.markers[index].timeSeconds,
        'markers are not sorted',
      )
    }
    const labels = timeline.markers.map((marker) => marker.label)
    for (const expected of ['场景 1', '场景 4', '字幕 1', '字幕 2', '背景音乐起点', '旁白 1']) {
      assert.ok(labels.some((label) => label.includes(expected)), `marker "${expected}" missing: ${labels.join(' | ')}`)
    }
    assert.equal(timeline.beatGrid, undefined, 'no bpm -> no beat grid')
  })

  await check('planToTimeline(opts.bpm): beat grid and marker beat flags', () => {
    const withBeats = planToTimeline(fixture, { bpm: 120 })
    assert.equal(withBeats.beatGrid.bpm, 120)
    assert.equal(withBeats.beatGrid.secondsPerBeat, 0.5)
    assert.equal(withBeats.beatGrid.count, 15)
    assert.equal(withBeats.beatGrid.secondsPerBar, 2)
    const onBeat = withBeats.markers.filter((marker) => marker.beat === true).map((marker) => marker.timeSeconds)
    assert.deepEqual(onBeat, [0, 0, 1, 1.5, 4])
    const offBeat = withBeats.markers.find((marker) => marker.label.startsWith('场景 3'))
    assert.equal(offBeat.timeSeconds, 4.1)
    assert.equal(offBeat.beat, undefined, '4.1s is not on a 0.5s grid')
  })

  await check('planToTimeline: deterministic and strictly JSON-serializable', () => {
    assert.deepEqual(planToTimeline(fixture), timeline)
    assertJsonSafe(timeline, 'timeline')
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(timeline))), JSON.stringify(timeline))
  })

  /* -------------------------------------------------------- round trip */

  await check('round-trip: planToTimeline(timelineToPlan(tl)) is the identical timeline', () => {
    assert.deepEqual(planToTimeline(roundTrippedPlan), timeline)
  })

  await check('round-trip: plan fields have explicit normalised defaults', () => {
    assert.equal(roundTrippedPlan.output, fixture.output)
    assert.equal(roundTrippedPlan.width, 1080)
    assert.equal(roundTrippedPlan.height, 1920)
    assert.equal(roundTrippedPlan.fps, 30)
    assert.equal(roundTrippedPlan.background, '#101018')
    assert.equal(roundTrippedPlan.loudnessTarget, -16)
    assert.equal(roundTrippedPlan.scenes.length, 4)
    assert.deepEqual(roundTrippedPlan.overlays, [])
    // build.js normalises these even on non-text scenes; the round-trip keeps them.
    assert.equal(roundTrippedPlan.scenes[1].font, 'msyh')
    assert.equal(roundTrippedPlan.scenes[1].fontSize, 96)
    assert.equal(roundTrippedPlan.scenes[1].background, '#101018')
    assert.equal(roundTrippedPlan.scenes[1].animation, 'none')
    assert.equal(roundTrippedPlan.scenes[1].transitionDuration, 0.5)
    assert.equal(roundTrippedPlan.audio.duck, true)
    assert.equal(roundTrippedPlan.audio.duckDb, -9)
    assert.equal(roundTrippedPlan.audio.voiceover[0].src, null)
    assert.equal(roundTrippedPlan.audio.voiceover[0].volumeDb, 0)
    assert.deepEqual(roundTrippedPlan.captions[0], fixture.captions[0])
  })

  await check('round-trip: extended plan (video rate/hold, overlays, sfx, duck off) is a fixed point', () => {
    const tracks = edgeTimeline.tracks.map((track) => [track.id, track.kind, track.clips.length])
    assert.deepEqual(tracks, [
      ['scenes', 'video', 2],
      ['overlays-image', 'image', 1],
      ['overlays-video', 'video', 1],
      ['music', 'audio', 1],
      ['voiceover', 'audio', 1],
      ['sfx', 'sfx', 1],
    ])
    const roundTripped = timelineToPlan(edgeTimeline)
    assert.deepEqual(planToTimeline(roundTripped), edgeTimeline)
    assert.equal(roundTripped.scenes[0].rate, 1.25)
    assert.equal(roundTripped.scenes[0].hold, 0.5)
    assert.equal(roundTripped.scenes[0].muted, true)
    assert.equal(roundTripped.loudnessTarget, null)
    assert.equal(roundTripped.overlays.length, 2)
    assert.equal(roundTripped.overlays[0].width, 0.32)
    assert.equal(roundTripped.overlays[1].src, 'D:/work/anim/logo.mp4')
    assert.equal(roundTripped.audio.duck, false)
    assert.equal(roundTripped.audio.duckDb, -12)
    assert.equal(roundTripped.audio.musicStart, 1.5)
    assert.equal(roundTripped.audio.voiceover[0].src, 'D:/work/audio/vo.wav')
    assert.equal(roundTripped.audio.voiceover[0].rate, 0.9)
    assert.deepEqual(roundTripped.audio.sfx, edgePlan.audio.sfx)
  })

  await check('round-trip: a scenes-only plan still round-trips (default tracks appear on demand)', () => {
    const minimal = {
      output: 'D:/work/out/minimal.mp4',
      scenes: [
        { type: 'color', duration: 1, background: '#000000' },
        { type: 'color', duration: 1, background: '#ffffff', transitionIn: 'dissolve', transitionDuration: 0.25 },
      ],
    }
    const minimalTimeline = planToTimeline(minimal)
    assert.deepEqual(minimalTimeline.tracks.map((track) => track.id), ['scenes'])
    const minimalPlan = timelineToPlan(minimalTimeline)
    assert.deepEqual(planToTimeline(minimalPlan), minimalTimeline)
    assert.equal(minimalPlan.audio.music, null)
    assert.equal(minimalPlan.audio.voiceover.length, 0)
    assert.equal(minimalTimeline.duration, 1.75)
  })

  await check('planToTimeline: rejects unusable plans with clear errors; opts.output overrides', () => {
    assert.throws(() => planToTimeline(null), /RenderPlan/)
    assert.throws(() => planToTimeline({ output: 'x.mp4', scenes: [] }), /scenes/)
    assert.throws(() => planToTimeline({ scenes: [{ type: 'color', duration: 1 }] }), /output/)
    assert.throws(
      () => planToTimeline({ output: 'x.mp4', scenes: [{ type: 'color', duration: 0 }] }),
      /duration/,
    )
    assert.throws(
      () => planToTimeline({ output: 'x.mp4', scenes: [{ type: 'nope', duration: 1 }] }),
      /type/,
    )
    const withOutput = planToTimeline({ width: 640, height: 360, scenes: [{ type: 'color', duration: 1 }] }, { output: 'D:/work/out/from-opts.mp4' })
    assert.equal(withOutput.output, 'D:/work/out/from-opts.mp4')
    assert.equal(withOutput.width, 640)
  })

  await check('timelineToPlan: rejects corrupt timelines with clear errors', () => {
    assert.throws(() => timelineToPlan(null), /timeline/)
    assert.throws(() => timelineToPlan({ version: 'capcut/v1', tracks: [] }), /版本/)
    assert.throws(() => timelineToPlan({ version: TIMELINE_VERSION, tracks: [] }), /tracks/)
    const broken = clone(timeline)
    broken.tracks = broken.tracks.filter((track) => track.id !== 'scenes')
    assert.throws(() => timelineToPlan(broken), /scenes/)
    const noOutput = clone(timeline)
    noOutput.output = null
    assert.throws(() => timelineToPlan(noOutput), /output/)
  })

  await check('timelineDuration: recomputes after a scene duration edit', () => {
    const edited = clone(timeline)
    edited.tracks[0].clips[0].duration = 3
    assert.equal(timelineDuration(edited), 8.1)
    edited.tracks[0].clips[1].transitionDuration = 1
    assert.equal(timelineDuration(edited), 7.6)
  })

  /* ----------------------------------------------------------- HTML editor */

  const html = renderTimelineHtml(timeline, { title: '可编辑时间线测试' })

  await check('renderTimelineHtml: self-contained document with the embedded JSON', () => {
    assert.equal(typeof html, 'string')
    assert.ok(html.startsWith('<!doctype html>'))
    assert.ok(html.includes('<title>可编辑时间线测试</title>'))
    assert.ok(html.includes('1080×1920'))
    const dataMatch = /<script id="timeline-data" type="application\/json">([\s\S]*?)<\/script>/u.exec(html)
    assert.ok(dataMatch, 'timeline-data block missing')
    assert.deepEqual(JSON.parse(dataMatch[1]), timeline)
  })

  await check('renderTimelineHtml: offline only — no external URL, script src or link tag', () => {
    assert.ok(!/https?:\/\//iu.test(html), 'html contains an external URL')
    assert.ok(!/<script[^>]+src=/iu.test(html), 'html loads an external script')
    assert.ok(!/<link\b/iu.test(html), 'html loads an external stylesheet')
    assert.ok(!/@import/iu.test(html), 'css imports something')
    assert.ok(!/xmlns=/iu.test(html), 'svg/xml namespace URL leaked in')
  })

  await check('renderTimelineHtml: exposes the editing affordances (text/duration/volume/export)', () => {
    assert.ok(html.includes('导出 RenderPlan JSON'))
    assert.ok(html.includes('导出时间线 JSON'))
    assert.ok(html.includes('音量'))
    assert.ok(html.includes('字幕文案'))
    assert.ok(html.includes('pointerdown'), 'clip dragging is not wired')
    assert.ok(html.includes('download'), 'no download helper')
    assert.ok(html.includes('__MS_TIMELINE_EDITOR__'))
  })

  await check('renderTimelineHtml: deterministic output (same input twice)', () => {
    assert.equal(renderTimelineHtml(timeline, { title: '可编辑时间线测试' }), html)
  })

  await check('renderTimelineHtml: escapes </script> in user text and still parses back', () => {
    const evil = clone(timeline)
    const payload = '</script><script>alert(1)</script>'
    evil.tracks.find((track) => track.id === 'captions').clips[0].text = payload
    const evilHtml = renderTimelineHtml(evil)
    assert.equal((evilHtml.match(/<\/script>/gu) ?? []).length, 2, 'inline <script> injection broke the page')
    const dataMatch = /<script id="timeline-data" type="application\/json">([\s\S]*?)<\/script>/u.exec(evilHtml)
    assert.ok(dataMatch)
    assert.equal(JSON.parse(dataMatch[1]).tracks.find((track) => track.id === 'captions').clips[0].text, payload)
  })

  await check('renderTimelineHtml: editor boots, loads the model and exports the same plan', () => {
    const editor = bootEditor(html)
    assert.equal(editor.version, TIMELINE_VERSION)
    assert.deepEqual(clone(editor.getTimeline()), timeline)
    assert.deepEqual(editor.exportPlan(), timelineToPlan(timeline))
  })

  await check('renderTimelineHtml: editing text/duration/volume ripples like the module does', () => {
    const editor = bootEditor(html)
    const model = editor.getTimeline()
    model.tracks.find((track) => track.id === 'captions').clips[0].text = '改过的字幕'
    model.tracks.find((track) => track.id === 'scenes').clips[0].duration = 3
    const musicTrack = model.tracks.find((track) => track.id === 'music')
    musicTrack.clips[0].volumeDb = -12
    musicTrack.duck = false
    editor.recompute()
    assert.equal(model.duration, 8.1)
    assert.equal(model.tracks[0].clips[1].start, 2.5, 'later scenes must ripple after a duration edit')
    const editedPlan = editor.exportPlan()
    assert.deepEqual(editedPlan, timelineToPlan(model))
    assert.equal(editedPlan.audio.musicVolumeDb, -12)
    assert.equal(editedPlan.audio.duck, false)
    assert.equal(editedPlan.captions[0].text, '改过的字幕')
    assert.equal(editedPlan.scenes[0].duration, 3)
  })

  await check('renderTimelineHtml: rejects non-timeline input', () => {
    assert.throws(() => renderTimelineHtml(null), /timeline/)
    assert.throws(() => renderTimelineHtml({ version: TIMELINE_VERSION }), /timeline/)
  })

  /* ------------------------------------------------------------- diff */

  await check('diffTimeline: identical timelines produce no changes', () => {
    assert.deepEqual(diffTimeline(timeline, clone(timeline)), [])
  })

  await check('diffTimeline: text, duration and volume edits are described in Chinese', () => {
    const edited = clone(timeline)
    edited.tracks.find((track) => track.id === 'captions').clips[0].text = '改过的字幕'
    edited.tracks.find((track) => track.id === 'scenes').clips[0].duration = 3
    edited.tracks.find((track) => track.id === 'music').clips[0].volumeDb = -12
    const changes = diffTimeline(timeline, edited)
    // Three edits, three changes: caption text, scene duration, music volume. The
    // timeline's own `duration` field is not recomputed here, so no fourth
    // meta-level entry is expected — a diff reports what the file says, not what a
    // future re-render would imply.
    assert.equal(changes.length, 3)
    const textChange = changes.find((change) => change.trackId === 'captions' && change.clipId === 'caption-0')
    assert.ok(textChange, 'caption text change missing')
    assert.ok(textChange.changeZh.includes('文案'))
    assert.ok(textChange.changeZh.includes('这是第一条中文字幕'))
    assert.ok(textChange.changeZh.includes('改过的字幕'))
    const durationChange = changes.find((change) => change.trackId === 'scenes' && change.clipId === 'scene-0')
    assert.ok(durationChange.changeZh.includes('时长'))
    assert.ok(durationChange.changeZh.includes('3.00s'))
    const volumeChange = changes.find((change) => change.trackId === 'music' && change.clipId === 'music-0')
    assert.ok(volumeChange.changeZh.includes('音量'))
    assert.ok(volumeChange.changeZh.includes('-12dB'))
    for (const change of changes) {
      assert.deepEqual(Object.keys(change).sort(), ['changeZh', 'clipId', 'trackId'])
    }
  })

  await check('diffTimeline: added/removed clips and tracks are reported', () => {
    const edited = clone(timeline)
    edited.tracks.find((track) => track.id === 'captions').clips.pop() // remove caption-1
    const addedClip = { id: 'caption-2', start: 5, end: 6, duration: 1, text: '新增字幕', position: 'top', fontSize: 44, color: '#ffffff' }
    edited.tracks.find((track) => track.id === 'captions').clips.push(addedClip)
    const changes = diffTimeline(timeline, edited)
    assert.ok(changes.some((change) => change.changeZh.includes('删除片段「字幕 2」')), 'removal not reported')
    assert.ok(changes.some((change) => change.changeZh.includes('新增片段') && change.changeZh.includes('新增字幕')), 'addition not reported')

    const withoutVoice = clone(timeline)
    withoutVoice.tracks = withoutVoice.tracks.filter((track) => track.id !== 'voiceover')
    const trackChanges = diffTimeline(timeline, withoutVoice)
    assert.ok(trackChanges.some((change) => change.trackId === 'voiceover' && change.changeZh.includes('删除轨道')))
  })

  await check('diffTimeline: plan-level meta edits use null ids and a readable label', () => {
    const edited = clone(timeline)
    edited.width = 1920
    edited.fps = 25
    edited.output = 'D:/work/out/other.mp4'
    const changes = diffTimeline(timeline, edited)
    assert.ok(changes.length >= 3)
    for (const change of changes) {
      assert.equal(change.trackId, null)
      assert.equal(change.clipId, null)
      assert.ok(change.changeZh.includes('时间线'))
    }
    assert.ok(changes.some((change) => change.changeZh.includes('画幅宽度') && change.changeZh.includes('1920px')))
    assert.ok(changes.some((change) => change.changeZh.includes('帧率')))
    assert.ok(changes.some((change) => change.changeZh.includes('输出路径')))
  })

  await check('diffTimeline: deterministic, JSON-safe, and throws on non-timelines', () => {
    const edited = clone(timeline)
    edited.tracks.find((track) => track.id === 'music').clips[0].fadeOut = 1
    const first = diffTimeline(timeline, edited)
    assert.deepEqual(diffTimeline(timeline, edited), first)
    assertJsonSafe(first, 'diff')
    assert.throws(() => diffTimeline(null, timeline), /timeline/)
    assert.throws(() => diffTimeline(timeline, 'x'), /timeline/)
  })

  /* --------------------------------------------- re-render equivalence */

  await check('re-render: original plan and round-tripped plan render equivalently', async () => {
    const tools = await resolveTools()
    const workDir = await makeWorkDir('media-senses-timeline')
    try {
      const tinyPlan = {
        output: join(workDir, 'orig', 'out.mp4'),
        width: 320,
        height: 568,
        fps: 25,
        background: '#0b0b14',
        loudnessTarget: null,
        scenes: [
          { type: 'color', duration: 1, background: '#123456' },
          { type: 'gradient', duration: 1.2, gradient: ['#120c2b', '#2b1a4a'], transitionIn: 'fade', transitionDuration: 0.3 },
        ],
        captions: [{ start: 0.2, end: 1.0, text: '等价性测试', position: 'bottom', fontSize: 48 }],
      }
      const tinyTimeline = planToTimeline(tinyPlan)
      const rebuilt = timelineToPlan(tinyTimeline)
      rebuilt.output = join(workDir, 'rebuilt', 'out.mp4')
      const first = await buildVideo({ tools, plan: tinyPlan, workDir: join(workDir, 'render-a') })
      const second = await buildVideo({ tools, plan: rebuilt, workDir: join(workDir, 'render-b') })
      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      assert.equal(first.duration, second.duration)
      assert.equal(first.width, second.width)
      assert.equal(first.height, second.height)
      assert.equal(first.fps, second.fps)
      assert.deepEqual(first.timeline, second.timeline)
      const probeA = await probe(tools, first.output)
      const probeB = await probe(tools, second.output)
      const durationA = Number.parseFloat(probeA.format.duration)
      const durationB = Number.parseFloat(probeB.format.duration)
      assert.ok(Math.abs(durationA - durationB) <= 1 / 25 + 1e-6, `rendered durations differ: ${durationA} vs ${durationB}`)
      assert.ok(Math.abs(durationA - 1.9) <= 0.15, `unexpected duration ${durationA}`)
      for (const probed of [probeA, probeB]) {
        assert.equal(probed.streams.filter((stream) => stream.codec_type === 'audio').length, 1)
      }
    } finally {
      await removeWorkDir(workDir)
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exitCode = 1
})
