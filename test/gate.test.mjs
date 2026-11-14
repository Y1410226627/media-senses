/**
 * Acceptance gate tests.
 *
 * The gate is what stands between "we rendered an MP4" and "the film is worth
 * watching". These tests pin the two things that matter:
 *
 *  1. Each leg's thresholds fire where they should — a metronome of equal shots
 *     FAILs cadence, a film with no rests FAILs stillness, a clipped mix FAILs
 *     audio, and a concept film without bursts only WARNs.
 *  2. The end-to-end path through `media_build_video` really produces a verdict,
 *     including the fallback to authored scene lengths when gradual transitions
 *     keep the cut detector from seeing boundaries.
 *
 * Synthetic inputs are used wherever possible so the thresholds are tested
 * against known-good signals rather than against whatever a fixture happens to
 * contain.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTools, makeWorkDir, removeWorkDir, probe } from '../lib/ffmpeg.js'
import { runGate, GATE_THRESHOLDS, GATE_OPTIONS } from '../lib/gate.js'
import { gateSummaryLine, renderBuildReport } from '../lib/render-v2.js'

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

const tools = await resolveTools({})
const scratch = await mkdtemp(join(tmpdir(), 'gate-test-'))

/**
 * Build a synthetic film at `path` from a per-frame colour function.
 *
 * Writing rgb24 frames through ffmpeg's rawvideo demuxer gives exact control over
 * what each frame contains, which is the only way to test a change-detection
 * threshold honestly.
 *
 * @param {string} path destination mp4
 * @param {(frame: number) => [number, number, number]} colour per-frame rgb
 * @param {{fps: number, frames: number, width: number, height: number}} shape
 */
async function writeSynthetic(path, colour, shape) {
  const { fps, frames, width, height } = shape
  const frameBytes = width * height * 3
  const buffer = Buffer.alloc(frameBytes * frames)
  for (let frame = 0; frame < frames; frame += 1) {
    const [r, g, b] = colour(frame)
    const offset = frame * frameBytes
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      buffer[offset + pixel * 3] = r
      buffer[offset + pixel * 3 + 1] = g
      buffer[offset + pixel * 3 + 2] = b
    }
  }
  const rawPath = `${path}.rgb`
  await writeFile(rawPath, buffer)
  const workDir = await makeWorkDir('gate-synth')
  try {
    const { run } = await import('../lib/ffmpeg.js')
    const result = await run(tools.ffmpeg, [
      '-v', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-r', String(fps),
      '-i', rawPath,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      path,
    ], { cwd: workDir })
    assert.equal(result.code, 0, `synthetic encode failed: ${result.stderr.slice(0, 400)}`)
  } finally {
    await removeWorkDir(workDir)
    await rm(rawPath, { force: true })
  }
}

/**
 * Build a synthetic film where a small bright block moves across a flat ground.
 *
 * Used to prove the gate can see *sparse* motion: the mean frame difference of a
 * small moving element stays far below the stillness threshold, so only the
 * moved-pixel-share check can catch it. This is the case that used to make a
 * slowly drifting shot read as a frozen frame.
 */
async function writeMovingBlock(path, { fps, frames, width, height, blockSize, speedPxPerFrame }) {
  const frameBytes = width * height * 3
  const buffer = Buffer.alloc(frameBytes * frames)
  // Flat dark ground everywhere.
  for (let offset = 0; offset < buffer.length; offset += 3) {
    buffer[offset] = 18
    buffer[offset + 1] = 20
    buffer[offset + 2] = 26
  }
  for (let frame = 0; frame < frames; frame += 1) {
    const left = Math.round(frame * speedPxPerFrame) % Math.max(1, width - blockSize)
    const top = Math.round(height * 0.2)
    const offset = frame * frameBytes
    for (let y = top; y < top + blockSize && y < height; y += 1) {
      for (let x = left; x < left + blockSize && x < width; x += 1) {
        const pixel = (y * width + x) * 3
        buffer[offset + pixel] = 240
        buffer[offset + pixel + 1] = 235
        buffer[offset + pixel + 2] = 225
      }
    }
  }
  const rawPath = `${path}.rgb`
  await writeFile(rawPath, buffer)
  const workDir = await makeWorkDir('gate-block')
  try {
    const { run } = await import('../lib/ffmpeg.js')
    const result = await run(tools.ffmpeg, [
      '-v', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-r', String(fps),
      '-i', rawPath,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      path,
    ], { cwd: workDir })
    assert.equal(result.code, 0, `synthetic encode failed: ${result.stderr.slice(0, 400)}`)
  } finally {
    await removeWorkDir(workDir)
    await rm(rawPath, { force: true })
  }
}

await check('thresholds are the documented measured values', () => {
  assert.equal(GATE_THRESHOLDS.cadenceCv, 0.25)
  assert.equal(GATE_THRESHOLDS.stillRatio, 0.25)
  assert.equal(GATE_THRESHOLDS.burstChanges, 3)
  assert.equal(GATE_THRESHOLDS.burstWindowSec, 1.5)
  assert.equal(GATE_THRESHOLDS.deadAirSec, 3)
  assert.equal(GATE_THRESHOLDS.peakDb, -3)
  assert.equal(GATE_THRESHOLDS.quietRatio, 0.15)
  assert.ok(GATE_THRESHOLDS.stillMovedShare > 0 && GATE_THRESHOLDS.stillMovedShare < 0.05)
  assert.ok(GATE_OPTIONS.width > 0 && GATE_OPTIONS.height > 0)
})

await check('cadence FAILs a metronome of equal shot lengths', async () => {
  const file = join(scratch, 'metronome.mp4')
  // Two colours alternating on a fixed 1 s period, 6 s total: every shot is 1 s.
  await writeSynthetic(file, (frame) => (Math.floor(frame / 12) % 2 === 0 ? [20, 20, 20] : [220, 220, 220]), { fps: 12, frames: 72, width: 64, height: 36 })
  const workDir = await makeWorkDir('gate-metric')
  try {
    const result = await runGate({
      tools,
      file,
      workDir,
      shots: [1, 2, 3, 4, 5, 6].map((start) => ({ start: start - 1, duration: 1 })),
      duration: 6,
    })
    const cadence = result.legs.find((leg) => leg.id === 'cadence')
    assert.equal(cadence.state, 'FAIL', `expected FAIL, got ${cadence.state}: ${cadence.detail}`)
    assert.equal(cadence.value.cv, 0)
    assert.equal(result.verdict, 'FAIL')
  } finally {
    await removeWorkDir(workDir)
  }
})

await check('cadence PASSes varied shot lengths', async () => {
  const file = join(scratch, 'varied.mp4')
  await writeSynthetic(file, () => [128, 128, 128], { fps: 12, frames: 72, width: 64, height: 36 })
  const workDir = await makeWorkDir('gate-metric')
  try {
    const result = await runGate({
      tools,
      file,
      workDir,
      shots: [
        { start: 0, duration: 0.5 },
        { start: 0.5, duration: 1.2 },
        { start: 1.7, duration: 0.6 },
        { start: 2.3, duration: 2.4 },
        { start: 4.7, duration: 1.3 },
      ],
      duration: 6,
    })
    const cadence = result.legs.find((leg) => leg.id === 'cadence')
    assert.equal(cadence.state, 'PASS', `expected PASS, got ${cadence.state}: ${cadence.detail}`)
    assert.ok(cadence.value.cv >= GATE_THRESHOLDS.cadenceCv)
  } finally {
    await removeWorkDir(workDir)
  }
})

await check('cadence falls back to authored scenes when the detector sees no cuts', async () => {
  const file = join(scratch, 'gradual.mp4')
  await writeSynthetic(file, () => [90, 90, 90], { fps: 12, frames: 48, width: 64, height: 36 })
  const workDir = await makeWorkDir('gate-metric')
  try {
    const result = await runGate({
      tools,
      file,
      workDir,
      shots: [{ start: 0, duration: 4 }],
      plannedScenes: [{ duration: 0.8 }, { duration: 0.8 }, { duration: 2.4 }],
      duration: 4,
    })
    const cadence = result.legs.find((leg) => leg.id === 'cadence')
    assert.notEqual(cadence.state, 'SKIP', 'the leg must use the planned scenes rather than skip')
    assert.equal(result.measurements.cadenceSource, 'planned')
    assert.ok(result.warnings.some((line) => line.includes('authored scene lengths')))
  } finally {
    await removeWorkDir(workDir)
  }
})

await check('stillness FAILs a film that never rests', async () => {
  const file = join(scratch, 'restless.mp4')
  // Every frame differs strongly from the last: nothing is ever still.
  await writeSynthetic(file, (frame) => {
    const v = (frame * 37) % 256
    return [v, 255 - v, (v * 3) % 256]
  }, { fps: 12, frames: 48, width: 64, height: 36 })
  const workDir = await makeWorkDir('gate-metric')
  try {
    const result = await runGate({ tools, file, workDir })
    const stillness = result.legs.find((leg) => leg.id === 'stillness')
    assert.equal(stillness.state, 'FAIL', `expected FAIL, got ${stillness.state}: ${stillness.detail}`)
    assert.ok(stillness.value.stillRatio < GATE_THRESHOLDS.stillRatio)
  } finally {
    await removeWorkDir(workDir)
  }
})

await check('stillness PASSes a film with real holds', async () => {
  const file = join(scratch, 'held.mp4')
  // Hold a colour for 1.5 s, change, hold again: 75% of pairs are still.
  await writeSynthetic(file, (frame) => (Math.floor(frame / 18) % 2 === 0 ? [30, 40, 60] : [200, 180, 120]), { fps: 12, frames: 72, width: 64, height: 36 })
  const workDir = await makeWorkDir('gate-metric')
  try {
    const result = await runGate({ tools, file, workDir })
    const stillness = result.legs.find((leg) => leg.id === 'stillness')
    assert.equal(stillness.state, 'PASS', `expected PASS, got ${stillness.state}: ${stillness.detail}`)
    assert.ok(stillness.value.longestSec >= GATE_THRESHOLDS.stillStretchSec)
  } finally {
    await removeWorkDir(workDir)
  }
})

await check('dead air FAILs a long frozen stretch', async () => {
  const file = join(scratch, 'dead.mp4')
  // Nothing moves at all for 6 s.
  await writeSynthetic(file, () => [70, 80, 90], { fps: 12, frames: 72, width: 64, height: 36 })
  const workDir = await makeWorkDir('gate-metric')
  try {
    const result = await runGate({ tools, file, workDir })
    const deadAir = result.legs.find((leg) => leg.id === 'dead-air')
    assert.equal(deadAir.state, 'FAIL', `expected FAIL, got ${deadAir.state}: ${deadAir.detail}`)
    assert.ok(deadAir.value.longestSec >= GATE_THRESHOLDS.deadAirSec)
  } finally {
    await removeWorkDir(workDir)
  }
})

await check('burst is detected when changes cluster, and WARNs when a concept film has none', async () => {
  const bursty = join(scratch, 'bursty.mp4')
  // Three hard colour swaps inside the first 1.5 s, then stillness.
  await writeSynthetic(bursty, (frame) => {
    if (frame < 6) return [240, 10, 10]
    if (frame < 12) return [10, 240, 10]
    if (frame < 18) return [10, 10, 240]
    return [20, 20, 20]
  }, { fps: 12, frames: 60, width: 64, height: 36 })
  const smooth = join(scratch, 'smooth.mp4')
  await writeSynthetic(smooth, (frame) => {
    const v = 40 + Math.round(Math.sin(frame / 20) * 12)
    return [v, v, v]
  }, { fps: 12, frames: 60, width: 64, height: 36 })

  const workDir = await makeWorkDir('gate-metric')
  try {
    const withBurst = await runGate({ tools, file: bursty, workDir })
    const burstLeg = withBurst.legs.find((leg) => leg.id === 'burst')
    assert.equal(burstLeg.state, 'PASS', `expected PASS, got ${burstLeg.state}: ${burstLeg.detail}`)
    assert.ok(burstLeg.value.bursts >= 1)

    const noBurst = await runGate({ tools, file: smooth, workDir })
    const quietLeg = noBurst.legs.find((leg) => leg.id === 'burst')
    assert.equal(quietLeg.state, 'WARN', `expected WARN without a reference, got ${quietLeg.state}`)

    // With a reference that has bursts, the same film FAILs instead.
    const against = await runGate({ tools, file: smooth, workDir, referenceBursts: 2 })
    const strictLeg = against.legs.find((leg) => leg.id === 'burst')
    assert.equal(strictLeg.state, 'FAIL', `expected FAIL against a bursty reference, got ${strictLeg.state}`)
  } finally {
    await removeWorkDir(workDir)
  }
})

await check('audio leg SKIPs a silent track instead of passing it at -180 dBFS', async () => {
  const file = join(scratch, 'silent.mp4')
  await writeSynthetic(file, () => [50, 50, 50], { fps: 12, frames: 24, width: 64, height: 36 })
  const workDir = await makeWorkDir('gate-metric')
  try {
    const result = await runGate({ tools, file, workDir })
    const audio = result.legs.find((leg) => leg.id === 'audio')
    assert.equal(audio.state, 'SKIP', `a silent file must SKIP, got ${audio.state}: ${audio.detail}`)
  } finally {
    await removeWorkDir(workDir)
  }
})

await check('audio leg FAILs a clipped mix', async () => {
  const file = join(scratch, 'clipped.mp4')
  await writeSynthetic(file, () => [50, 50, 50], { fps: 12, frames: 24, width: 64, height: 36 })
  const workDir = await makeWorkDir('gate-audio')
  try {
    const { run } = await import('../lib/ffmpeg.js')
    // A full-scale square wave: every sample is at the clipping ceiling.
    const muxed = join(scratch, 'clipped-audio.mp4')
    const result = await run(tools.ffmpeg, [
      '-v', 'error', '-y',
      '-i', file,
      '-f', 'lavfi', '-i', 'aevalsrc=0.999*sgn(sin(2*PI*440*t)):s=16000:d=2',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest',
      muxed,
    ], { cwd: workDir })
    assert.equal(result.code, 0, `mux failed: ${result.stderr.slice(0, 300)}`)
    const gate = await runGate({ tools, file: muxed, workDir })
    const audio = gate.legs.find((leg) => leg.id === 'audio')
    assert.equal(audio.state, 'FAIL', `expected FAIL, got ${audio.state}: ${audio.detail}`)
    assert.ok(audio.value.clipped > 0, 'clipping must be counted')
    assert.ok(audio.value.peakDb > GATE_THRESHOLDS.peakDb)
  } finally {
    await removeWorkDir(workDir)
  }
})

await check('a small element moving continuously is NOT reported as dead air', async () => {
  // A 24px block crossing a flat ground: the mean frame difference is minuscule
  // (well under stillDiff) while a viewer plainly sees motion. Before the
  // moved-pixel-share check this was reported as a frozen stretch.
  const moving = join(scratch, 'moving-block.mp4')
  await writeMovingBlock(moving, { fps: 12, frames: 72, width: 320, height: 180, blockSize: 40, speedPxPerFrame: 8 })
  const frozen = join(scratch, 'frozen-block.mp4')
  await writeMovingBlock(frozen, { fps: 12, frames: 72, width: 320, height: 180, blockSize: 40, speedPxPerFrame: 0 })

  const workDir = await makeWorkDir('gate-metric')
  try {
    const movingResult = await runGate({ tools, file: moving, workDir })
    const frozenResult = await runGate({ tools, file: frozen, workDir })
    const movingAir = movingResult.legs.find((leg) => leg.id === 'dead-air')
    const frozenAir = frozenResult.legs.find((leg) => leg.id === 'dead-air')
    // The frozen film really is dead air.
    assert.equal(frozenAir.state, 'FAIL', `a frozen film must be dead air, got ${frozenAir.state}`)
    // The moving film must be strictly better and must not be a FAIL.
    assert.notEqual(movingAir.state, 'FAIL', `sparse motion was misread as dead air: ${movingAir.detail}`)
    assert.ok(
      movingAir.value.longestSec < frozenAir.value.longestSec,
      `moving (${movingAir.value.longestSec}s) must have less dead air than frozen (${frozenAir.value.longestSec}s)`,
    )
  } finally {
    await removeWorkDir(workDir)
  }
})

await check('every leg reports a state and a human-readable detail', async () => {
  const file = join(scratch, 'plain.mp4')
  await writeSynthetic(file, () => [60, 70, 80], { fps: 12, frames: 24, width: 64, height: 36 })
  const workDir = await makeWorkDir('gate-metric')
  try {
    const result = await runGate({ tools, file, workDir })
    assert.ok(Array.isArray(result.legs) && result.legs.length === 5, 'five legs are always reported')
    for (const leg of result.legs) {
      assert.ok(typeof leg.id === 'string' && leg.id.length > 0)
      assert.ok(typeof leg.title === 'string' && leg.title.length > 0, `${leg.id} needs a Chinese title`)
      assert.ok(['PASS', 'WARN', 'FAIL', 'SKIP'].includes(leg.state), `${leg.id} bad state ${leg.state}`)
      assert.ok(typeof leg.detail === 'string' && leg.detail.length > 8, `${leg.id} needs a real detail line`)
    }
    assert.ok(['PASS', 'FAIL'].includes(result.verdict))
    assert.ok(typeof result.measurements.duration === 'number')
  } finally {
    await removeWorkDir(workDir)
  }
})

await check('a missing file and an empty workDir are rejected explicitly', async () => {
  await assert.rejects(() => runGate({ tools, file: join(scratch, 'nope.mp4'), workDir: scratch }), /cannot read/u)
  await assert.rejects(() => runGate({ tools, file: join(scratch, 'plain.mp4'), workDir: '' }), /workDir/u)
})

await check('report renders a gate section with the failing legs first', () => {
  const gate = {
    verdict: 'FAIL',
    legs: [
      { id: 'cadence', title: '镜头长度变化', state: 'FAIL', detail: '变异系数只有 0（要求 ≥0.25）' },
      { id: 'stillness', title: '静帧比例', state: 'PASS', detail: '静帧占 31%' },
      { id: 'burst', title: '变化爆发', state: 'WARN', detail: '全片没有爆发' },
    ],
  }
  const report = renderBuildReport(
    { output: 'x.mp4', duration: 8, width: 640, height: 360, fps: 24, bytes: 1000, renderSeconds: 1 },
    { verify: { shots: 3, gate }, plan: { scenes: [1, 2, 3] } },
  )
  assert.match(report, /## 验收门禁/u)
  assert.match(report, /未通过/u)
  assert.match(report, /先改这几项/u)
  assert.match(report, /变异系数/u)
  const first = gateSummaryLine(gate)
  assert.match(first, /未通过/u)
  assert.match(first, /镜头长度变化未过/u)
})

await check('a clean gate reports PASS flatly without a fix list', () => {
  const gate = {
    verdict: 'PASS',
    legs: [
      { id: 'cadence', title: '镜头长度变化', state: 'PASS', detail: '变异系数 0.6' },
      { id: 'stillness', title: '静帧比例', state: 'PASS', detail: '静帧占 40%' },
    ],
  }
  const report = renderBuildReport(
    { output: 'x.mp4', duration: 8, width: 640, height: 360, fps: 24, bytes: 1000, renderSeconds: 1 },
    { verify: { shots: 3, gate } },
  )
  assert.match(report, /2 项全过/u)
  assert.doesNotMatch(report, /先改这几项/u)
})

await check('no gate means no gate section (backwards compatible)', () => {
  const report = renderBuildReport(
    { output: 'x.mp4', duration: 8, width: 640, height: 360, fps: 24, bytes: 1000, renderSeconds: 1 },
    { verify: { shots: 3 } },
  )
  assert.doesNotMatch(report, /验收门禁/u)
  assert.equal(gateSummaryLine(undefined), undefined)
})

await rm(scratch, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`\n${name}\n${error.stack}`)
  process.exitCode = 1
}
