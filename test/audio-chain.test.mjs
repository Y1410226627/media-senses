/**
 * End-to-end proof of the round-7 audio chain.
 *
 * Renders the same 16-second plan twice — once with no effects, once with a
 * synthesised sound-effect track placed by beat number — then checks the three
 * things the wiring is supposed to guarantee:
 *
 *  1. the effects actually reach the mix (measured on the rendered audio, not
 *     inferred from the ffmpeg arguments);
 *  2. each hit lands near its designed time;
 *  3. the gate's alignment leg passes a beat-locked cut list and catches a
 *     deliberately shifted one.
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVideo } from '../lib/build.js'
import { resolveTools, run, makeWorkDir, removeWorkDir } from '../lib/ffmpeg.js'
import { runGate } from '../lib/gate.js'
import { synthesizeSfx, writeSfxWav, measureSfxPeakLag } from '../lib/sfx.js'

const tools = await resolveTools({})
const scratch = await mkdtemp(join(tmpdir(), 'e2e-sfx-'))
const SR = 48000

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  ok   ${name}`) }
  else { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures += 1 }
}

/** 120 BPM with the first beat at 0.5 s — the grid the fixture actually measures. */
const beatGrid = { bpm: 120, t0: 0.5, period: 0.5, outputOffsetSeconds: 0 }

const scenes = ['#101828', '#1d2939', '#2a1a3e', '#0f2027'].map((background, index) => ({
  type: 'text',
  text: `镜头 ${index + 1}`,
  duration: 4,
  background,
  color: '#ffffff',
  fontSize: 96,
}))

const basePlan = { width: 640, height: 360, fps: 30, background: '#000000', loudnessTarget: null, scenes, beatGrid }

async function writeEffect(kind, beat, gain, seed) {
  const rendered = synthesizeSfx(kind, { seed })
  const path = join(scratch, `${kind}-${seed}.wav`)
  const written = await writeSfxWav(path, rendered.samples, rendered.sampleRate, { peakDb: -1 })
  const lag = measureSfxPeakLag(rendered.samples, rendered.sampleRate)
  return { src: written.path, beat, gain, peakLag: lag.peakSeconds, seconds: written.duration }
}

/** RMS (dBFS) of a short window of the rendered file. */
async function loudnessAt(file, workDir, atSeconds, windowSeconds = 0.06) {
  await run(tools.ffmpeg, [
    '-v', 'error', '-nostdin', '-y',
    '-ss', String(Math.max(0, atSeconds - windowSeconds / 2)), '-t', String(windowSeconds),
    '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'probe.f32',
  ], { cwd: workDir })
  const buffer = await readFile(join(workDir, 'probe.f32'))
  const count = Math.floor(buffer.length / 4)
  let sum = 0
  for (let i = 0; i < count; i += 1) {
    const value = buffer.readFloatLE(i * 4)
    sum += value * value
  }
  return 20 * Math.log10(Math.sqrt(sum / Math.max(1, count)) || 1e-9)
}

// impact on beat 0 (t = 0.5 s), a riser building into beat 7 (t = 4.0 s) and a
// sparkle on beat 16 (t = 8.5 s). A riser peaks at the END of its file, so this is
// also the case that proves peak-lag alignment matters.
const sfx = [
  await writeEffect('impact', 0, 0.55, 11),
  await writeEffect('riser', 7, 0.35, 12),
  await writeEffect('sparkle', 16, 0.4, 13),
]

const silentWork = await makeWorkDir('e2e-silent')
const sfxWork = await makeWorkDir('e2e-sfx')
const silentPath = join(scratch, 'silent.mp4')
const sfxPath = join(scratch, 'sfx.mp4')

try {
  console.log('rendering the control (no audio)…')
  await buildVideo({ tools, workDir: silentWork, plan: { ...basePlan, output: silentPath } })
  console.log('rendering the sound-effect version…')
  const withSfx = await buildVideo({ tools, workDir: sfxWork, plan: { ...basePlan, output: sfxPath, audio: { sfx } } })
  console.log(`  warnings: ${withSfx.warnings.length === 0 ? 'none' : withSfx.warnings.join(' | ')}`)

  console.log('\n1) the effects reached the mix')
  for (const probe of [
    { label: 'impact @ beat 0 (0.50 s)', at: 0.5 },
    { label: 'riser landing @ beat 7 (4.00 s)', at: 4.0 },
    { label: 'sparkle @ beat 16 (8.50 s)', at: 8.5 },
  ]) {
    const silent = await loudnessAt(silentPath, silentWork, probe.at)
    const loud = await loudnessAt(sfxPath, sfxWork, probe.at)
    check(`${probe.label} is audible above the control`, loud - silent > 6, `delta ${(loud - silent).toFixed(1)} dB (control ${silent.toFixed(1)}, sfx ${loud.toFixed(1)})`)
  }
  const quietSilent = await loudnessAt(silentPath, silentWork, 6.2)
  const quietSfx = await loudnessAt(sfxPath, sfxWork, 6.2)
  check('an unplanned window stays as quiet as the control', quietSfx - quietSilent < 6, `delta ${(quietSfx - quietSilent).toFixed(1)} dB`)

  console.log('\n2) the gate alignment leg')
  const shotList = scenes.map((_scene, index) => ({ start: index * 4, duration: 4 }))
  const aligned = await runGate({ tools, file: sfxPath, workDir: sfxWork, shots: shotList, plannedScenes: scenes, duration: 16, beatGrid, fps: 30 })
  const alignedLeg = aligned.legs.find((leg) => leg.id === 'alignment')
  console.log(`  cuts at ${shotList.slice(1).map((shot) => shot.start).join(', ')} s → ${alignedLeg.state} — ${alignedLeg.detail}`)
  check('beat-locked cuts pass the alignment leg', alignedLeg.state === 'PASS', alignedLeg.detail)

  const shifted = shotList.map((shot) => ({ ...shot, start: shot.start + 7 / 30 }))
  const shiftedGate = await runGate({ tools, file: sfxPath, workDir: sfxWork, shots: shifted, duration: 16 + 7 / 30, beatGrid, fps: 30 })
  const shiftedLeg = shiftedGate.legs.find((leg) => leg.id === 'alignment')
  console.log(`  same cuts shifted 7 frames → ${shiftedLeg.state} — ${shiftedLeg.detail}`)
  check('a 7-frame shift is caught', shiftedLeg.state !== 'PASS', shiftedLeg.detail)

  console.log('\n3) without a beat grid the leg skips rather than silently passing')
  const noGrid = await runGate({ tools, file: sfxPath, workDir: sfxWork, shots: shotList, duration: 16 })
  check('alignment is SKIP without a grid', noGrid.legs.find((leg) => leg.id === 'alignment').state === 'SKIP')
} finally {
  await removeWorkDir(silentWork)
  await removeWorkDir(sfxWork)
  await rm(scratch, { recursive: true, force: true })
}

console.log('')
console.log(`${passed} passed, ${failures} failed${failures === 0 ? ' (end-to-end: real renders, measured audio)' : ''}`)
process.exitCode = failures === 0 ? 0 : 1
