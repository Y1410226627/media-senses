/**
 * Round-7 demo: a beat-locked film with sound design, then the gate and the
 * independent review on the finished result.
 *
 * This is the answer to "can you actually do what they do?" rendered as one
 * artefact: shot boundaries written in *beat numbers*, a riser→impact→sparkle
 * sound sentence synthesised from nothing, and the same acceptance machinery that
 * grades every other render.
 *
 * Shot lengths deliberately vary (8 / 6 / 10 / 8 beats): equal-length shots would
 * be a metronome and the gate would — correctly — fail the cadence leg.
 */
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildVideo } from '../lib/build.js'
import { resolveTools, makeWorkDir, removeWorkDir } from '../lib/ffmpeg.js'
import { runGate } from '../lib/gate.js'
import { analyzeVideo } from '../lib/video.js'
import { analyzeAudio } from '../lib/audio.js'
import { synthesizeSfx, writeSfxWav, measureSfxPeakLag } from '../lib/sfx.js'
import { fitBeatGrid, acceptBeatGrid, beatTime, beatFrame } from '../lib/beatsync.js'
import { auditAesthetic } from '../lib/aesthetic.js'
import { auditFilm, renderReviewReport } from '../lib/review.js'

const tools = await resolveTools({})
const outDir = resolve('demo/output')
await mkdir(outDir, { recursive: true })
const output = join(outDir, 'round7-beatlocked-demo.mp4')
const music = resolve('test/fixtures/tone-120bpm-c-major.mp3')
if (!existsSync(music)) throw new Error(`missing fixture bed: ${music}`)

const FPS = 30
const SHOT_BEATS = [10, 4, 6, 8] // varies on purpose — equal shots are a metronome

/* ---- 1. measure the bed, then write the timeline in beats ---- */
const measureWork = await makeWorkDir('demo-measure')
let grid
try {
  const audio = await analyzeAudio({ tools, file: music, workDir: measureWork, options: { wantChords: false, sampleRate: 22050 } })
  const beats = audio.tempo?.beatTimes ?? []
  const fitted = fitBeatGrid(beats)
  const candidates = [0.5, 1, 2].map((factor) => ({ ...fitted, bpm: fitted.bpm * factor, period: fitted.period / factor }))
  const resolved = acceptBeatGrid(candidates, beats)
  const winner = resolved.winner ?? fitted
  grid = { bpm: winner.bpm, t0: winner.t0, period: winner.period, outputOffsetSeconds: 0 }
  console.log(`bed: ${Number(grid.bpm).toFixed(2)} BPM, first beat ${Number(grid.t0).toFixed(3)}s, residual ${Number(fitted.residualMaxMs).toFixed(1)}ms`)
} finally {
  await removeWorkDir(measureWork)
}

/* ---- 2. sound design: one sentence per shot ---- */
const sfxWork = await makeWorkDir('demo-sfx')
async function effect(kind, beat, gain, seed, duration) {
  const rendered = synthesizeSfx(kind, { seed, duration })
  const path = join(sfxWork, `${kind}-${seed}.wav`)
  const written = await writeSfxWav(path, rendered.samples, rendered.sampleRate, { peakDb: -1 })
  const lag = measureSfxPeakLag(rendered.samples, rendered.sampleRate)
  return { src: written.path, beat, gain, peakLag: lag.peakSeconds }
}
const sfx = []
let cursorBeat = 0
for (let index = 0; index < SHOT_BEATS.length; index += 1) {
  sfx.push(await effect('riser', cursorBeat - 4, 0.18, 100 + index, 1.8))
  sfx.push(await effect('impact', cursorBeat, 0.34, 200 + index))
  sfx.push(await effect('sparkle', cursorBeat + 1, 0.2, 300 + index))
  cursorBeat += SHOT_BEATS[index]
}

/* ---- 3. the film: every shot starts on a beat boundary ---- */
const palette = [
  { background: '#101828' },
  { background: '#1d1b3a' },
  { background: '#0f2027' },
  { background: '#2a1216' },
]
const titles = ['一拍一切', '声音先行', '门禁验收', '可再编辑']
const scenes = SHOT_BEATS.map((beats, index) => ({
  type: 'text',
  text: titles[index],
  duration: Number((beats * grid.period).toFixed(4)),
  background: palette[index].background,
  color: '#ffffff',
  fontSize: 120,
}))

const captions = []
let captionBeat = 1
for (let index = 0; index < SHOT_BEATS.length; index += 1) {
  const text = ['切点写拍号，不写帧号', '音效按能量峰值对齐，不是文件头', '门禁逐切点量离拍几帧', '交付还带一份可编辑时间线'][index]
  captions.push({ start: beatTime(captionBeat, grid), end: beatTime(captionBeat + Math.min(5, SHOT_BEATS[index] - 2), grid), text, position: 'bottom', fontSize: 40 })
  captionBeat += SHOT_BEATS[index]
}

const plan = {
  output,
  width: 1280,
  height: 720,
  fps: FPS,
  background: '#000000',
  loudnessTarget: -18,
  beatGrid: grid,
  scenes,
  captions,
  audio: { music, musicVolumeDb: -26, musicFadeOut: 1.5, duck: true, duckDb: -8, sfx },
}

console.log(`plan: ${SHOT_BEATS.join('/')} 拍 → ${scenes.map((scene) => scene.duration).join('/')} 秒`)
console.log('rendering…')
const renderWork = await makeWorkDir('demo-render')
let result
try {
  result = await buildVideo({ tools, plan, workDir: renderWork })
} finally {
  await removeWorkDir(renderWork)
}
await removeWorkDir(sfxWork)
console.log(`rendered ${result.output} (${(result.bytes / 1024 / 1024).toFixed(2)} MB, ${result.duration.toFixed(2)}s, ${result.renderSeconds.toFixed(1)}s)`)

/* ---- 4. acceptance: gate + aesthetic + independent review ---- */
const reviewWork = await makeWorkDir('demo-review')
try {
  const analysis = await analyzeVideo({ tools, file: result.output, workDir: reviewWork, options: { maxKeyframes: 8, wantContactSheet: false, wantFrames: false, wantAudio: false } })
  const audio = await analyzeAudio({ tools, file: result.output, workDir: reviewWork, options: { wantChords: false, wantStructure: true } })
  const gate = await runGate({
    tools,
    file: result.output,
    workDir: reviewWork,
    shots: analysis.shots,
    plannedScenes: scenes,
    duration: analysis.duration,
    beatGrid: grid,
    fps: FPS,
  })

  let frameCursor = 0
  const shotRows = scenes.map((scene, index) => {
    const fromFrame = Math.round(frameCursor * FPS)
    frameCursor += scene.duration
    return { id: `s${index + 1}`, durationSeconds: scene.duration, startFrame: fromFrame, endFrame: Math.round(frameCursor * FPS) }
  })
  const aesthetic = auditAesthetic({
    shots: shotRows,
    timeline: { cuts: shotRows.map((row, index) => ({ fromFrame: row.startFrame, toFrame: row.endFrame, techniqueId: 'text-card', isProtagonist: index === 0 })) },
    captions,
    audio: { bpm: grid.bpm, beatSeconds: grid.period },
    effects: { fullFrameImpactCount: 0 },
  })

  const alignment = gate.legs.find((leg) => leg.id === 'alignment')?.value ?? null
  const review = auditFilm({ gate, aesthetic, audio, plan, shots: analysis.shots, beatsync: { grid, alignment }, fps: FPS, duration: analysis.duration })

  console.log('\n=== GATE ===')
  for (const leg of gate.legs) console.log(`  ${leg.state.padEnd(4)} ${leg.title}: ${leg.detail}`)
  console.log(`  verdict: ${gate.verdict}`)
  console.log('\n=== AESTHETIC ===')
  console.log(`  ${aesthetic.summaryZh}`)
  console.log('\n=== REVIEW ===')
  console.log(renderReviewReport(review, { blind: true }))
} finally {
  await removeWorkDir(reviewWork)
}

console.log(`\nDEMO OK -> ${result.output}`)
