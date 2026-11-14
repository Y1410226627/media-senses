/**
 * Runtime adapters + character performance.
 *
 * Two things are asserted here, and they are different in kind:
 *
 *  1. **Adapters** are page-side JavaScript. The only honest test is to evaluate
 *     the generated prelude in a sandbox with fake libraries and check that
 *     Lottie / Anime / Three / custom hooks are advanced to the right time.
 *  2. **Performance** is timing data. The tests pin the measured rules (blink
 *     shape, single-frame strike, bob and lean ranges) so a later edit cannot
 *     quietly turn a lively character into a puppet.
 */
import assert from 'node:assert/strict'
import { adapterPreludeSource, ADAPTERS, renderAdapterTable } from '../lib/adapters.js'
import {
  PERFORMANCE,
  EMOTIONS,
  actingBeat,
  actingBeatFrames,
  blinkAt,
  walkAt,
  poseAt,
  performancePreludeSource,
  emotionNames,
} from '../lib/performance.js'

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

/** Evaluate a generated prelude against a fake window and return it. */
function runPrelude(source) {
  const sandbox = { window: {} }
  const evaluate = new Function('window', source)
  evaluate(sandbox.window)
  return sandbox.window
}

/* ------------------------------------------------------------------ *
 * Adapters
 * ------------------------------------------------------------------ */

await check('the adapter catalogue documents every engine and which are automatic', () => {
  assert.ok(ADAPTERS.length >= 8)
  const ids = ADAPTERS.map((entry) => entry.id)
  for (const required of ['renderAt', 'css', 'timelines', 'clips', 'lottie', 'three', 'anime', 'custom']) {
    assert.ok(ids.includes(required), `missing adapter ${required}`)
  }
  // The four built-in contracts must need no registration.
  for (const automatic of ['renderAt', 'css', 'timelines', 'clips']) {
    assert.equal(ADAPTERS.find((entry) => entry.id === automatic).auto, true, `${automatic} should be automatic`)
  }
  // Engines that need a registration line must say so.
  for (const manual of ['lottie', 'three', 'anime', 'custom']) {
    assert.equal(ADAPTERS.find((entry) => entry.id === manual).auto, false, `${manual} must be opt-in`)
  }
  for (const entry of ADAPTERS) {
    assert.ok(entry.howZh.length > 20, `${entry.id} needs a concrete instruction`)
  }
  const table = renderAdapterTable()
  assert.match(table, /\| 引擎 \| 怎么让它跟着帧走 \|/)
})

await check('the prelude exposes the vocabulary curves and they match the module maths', () => {
  const { MS } = runPrelude(adapterPreludeSource())
  assert.equal(typeof MS.ease, 'function')
  assert.equal(typeof MS.spring, 'function')
  assert.equal(typeof MS.inertia, 'function')
  assert.equal(MS.inertia(0), 0)
  assert.equal(MS.inertia(1), 1)
  // A critically damped spring must not overshoot; an under-damped one must.
  assert.ok(MS.spring({ damping: 1, frequency: 1.6 }, 1) <= 1.0001)
  const underDamped = MS.spring({ damping: 0.35, frequency: 2 }, 0.18)
  assert.ok(underDamped > 1.02, `an under-damped spring should overshoot, got ${underDamped}`)
  // Endpoints are exact for every named curve.
  for (const name of MS.curves) {
    assert.ok(Math.abs(MS.ease(name, 0)) < 1e-6, `${name} must start at 0`)
    assert.ok(Math.abs(MS.ease(name, 1) - 1) < 1e-6, `${name} must end at 1`)
  }
})

await check('MS.onSeek is the generic extension point and runs every frame', () => {
  const { MS } = runPrelude(adapterPreludeSource())
  const seen = []
  MS.onSeek((t) => seen.push(t))
  MS.onSeek((t) => seen.push(t * 2))
  MS.seek(0.5)
  MS.seek(1.5)
  assert.deepEqual(seen, [0.5, 1, 1.5, 3])
  assert.equal(MS.time, 1.5)
})

await check('MS.lottie seeks by frame at the given fps', () => {
  const { MS } = runPrelude(adapterPreludeSource())
  const calls = []
  MS.lottie({ goToAndStop: (value, isFrame) => calls.push([value, isFrame]) }, 30)
  MS.seek(2)
  assert.deepEqual(calls, [[60, true]], 't=2s at 30fps is frame 60, seeked by frame')
  // A 24 fps animation must use its own rate, not 30.
  const slow = []
  MS.lottie({ goToAndStop: (value, isFrame) => slow.push([value, isFrame]) }, 24)
  MS.seek(2)
  assert.deepEqual(slow, [[48, true]])
})

await check('MS.anime converts seconds to milliseconds', () => {
  const { MS } = runPrelude(adapterPreludeSource())
  const calls = []
  MS.anime({ seek: (ms) => calls.push(ms) })
  MS.seek(1.25)
  assert.deepEqual(calls, [1250], 'Anime.js seeks in milliseconds')
})

await check('MS.three advances a mixer and re-renders', () => {
  const { MS } = runPrelude(adapterPreludeSource())
  const calls = []
  MS.three({
    mixer: { setTime: (t) => calls.push(['mixer', t]) },
    renderer: { render: () => calls.push(['render']) },
    scene: {},
    camera: {},
  })
  MS.seek(3)
  assert.deepEqual(calls, [['mixer', 3], ['render']])
  // A rig with only a mixer must not try to render.
  const mixerOnly = []
  MS.three({ mixer: { setTime: (t) => mixerOnly.push(t) } })
  MS.seek(4)
  assert.deepEqual(mixerOnly, [4])
})

await check('a throwing adapter cannot break the frame', () => {
  const { MS } = runPrelude(adapterPreludeSource())
  MS.onSeek(() => { throw new Error('boom') })
  const after = []
  MS.onSeek((t) => after.push(t))
  // Must not throw, and the later listener must still run.
  MS.seek(1)
  assert.deepEqual(after, [1])
})

await check('registering a non-animation is a no-op, not a crash', () => {
  const { MS } = runPrelude(adapterPreludeSource())
  MS.lottie(null, 30)
  MS.lottie({}, 30)
  MS.anime({})
  MS.three(null)
  MS.onSeek('not a function')
  MS.seek(1)
  assert.equal(MS.lottieAnimations.length, 0)
  assert.equal(MS.animeTimelines.length, 0)
  assert.equal(MS.threeRigs.length, 0)
  assert.equal(MS.seekers.length, 0)
})

/* ------------------------------------------------------------------ *
 * Performance
 * ------------------------------------------------------------------ */

await check('the measured rules are the documented values', () => {
  assert.deepEqual(PERFORMANCE.stepFrames, [9, 12])
  assert.deepEqual(PERFORMANCE.bobShare, [0.03, 0.07])
  assert.equal(PERFORMANCE.leanDeg.passing, 1)
  assert.deepEqual(PERFORMANCE.leanDeg.contact, [5, 7])
  assert.deepEqual(PERFORMANCE.blinkIntervalSec, [0.5, 2.3])
  assert.deepEqual(PERFORMANCE.blinkShape, [0.5, 1, 1, 0.5])
  assert.deepEqual(PERFORMANCE.anticipationFrames, [4, 7])
  assert.equal(PERFORMANCE.strikeFrames, 1, 'the strike must be exactly one frame')
  assert.deepEqual(PERFORMANCE.recoverFrames, [4, 5])
})

await check('the acting beat holds, strikes on exactly one frame, then overshoots on recovery', () => {
  const held = PERFORMANCE.anticipationFrames[1]
  const coil = PERFORMANCE.anticipationFrames[0]
  // Before the hold the pose ramps back, then holds fully coiled.
  assert.equal(actingBeat(0).phase, 'anticipation')
  assert.ok(actingBeat(coil - 1).pose < 0)
  assert.equal(actingBeat(coil).pose, -1)
  assert.equal(actingBeat(held - 1).pose, -1, 'the coil is held, not slid through')
  // Exactly one strike frame.
  assert.equal(actingBeat(held).phase, 'strike')
  assert.equal(actingBeat(held).pose, 1)
  assert.notEqual(actingBeat(held + 1).phase, 'strike', 'the strike must not last two frames')
  // Recovery leaves full extension, crosses neutral and swings back, then lands
  // exactly on zero. The swing has to happen mid-recovery to be visible.
  const recoveryStart = held + PERFORMANCE.strikeFrames
  const recoveryPoses = []
  for (let frame = recoveryStart; frame < recoveryStart + PERFORMANCE.recoverFrames[1]; frame += 1) {
    const step = actingBeat(frame)
    assert.equal(step.phase, 'recover')
    recoveryPoses.push(step.pose)
  }
  assert.ok(Math.min(...recoveryPoses) < -0.05, `recovery must overshoot before settling, got ${Math.min(...recoveryPoses)}`)
  assert.equal(actingBeat(performance_recoveryEnd()).phase, 'done')
  assert.equal(actingBeat(performance_recoveryEnd()).pose, 0)
})

/** First frame index after the acting beat finishes. */
function performance_recoveryEnd() {
  return PERFORMANCE.anticipationFrames[1] + PERFORMANCE.strikeFrames + PERFORMANCE.recoverFrames[1]
}

await check('actingBeatFrames covers the whole beat', () => {
  const frames = actingBeatFrames()
  const last = frames - 1
  const firstDone = PERFORMANCE.anticipationFrames[1] + PERFORMANCE.strikeFrames + PERFORMANCE.recoverFrames[1]
  assert.ok(frames >= firstDone, `beat ${frames} must cover the phases ${firstDone}`)
  assert.equal(actingBeat(last + 2).phase, 'done')
})

for (const [id, emotion] of Object.entries(EMOTIONS)) {
  await check(`emotion ${id}: every field is in range`, () => {
    assert.ok(typeof emotion.nameZh === 'string' && emotion.nameZh.length > 0)
    for (const key of ['brow', 'mouth']) {
      assert.ok(emotion[key] >= -1 && emotion[key] <= 1, `${id}.${key}=${emotion[key]} out of -1..1`)
    }
    assert.ok(emotion.eyeOpen > 0.3 && emotion.eyeOpen <= 1.5, `${id}.eyeOpen=${emotion.eyeOpen}`)
    assert.ok(Math.abs(emotion.lean) <= 10, `${id}.lean=${emotion.lean}`)
    assert.ok(emotion.energy >= 0 && emotion.energy <= 1, `${id}.energy=${emotion.energy}`)
  })
}

await check('emotionNames covers every preset including neutral', () => {
  const names = emotionNames()
  assert.equal(names.length, Object.keys(EMOTIONS).length)
  assert.ok(names.includes('neutral'))
  assert.ok(names.includes('surprised'))
})

await check('blinkAt follows the four-frame shape, and only there', () => {
  const fps = 24
  const interval = 1
  // Sample the first cycle frame by frame.
  const samples = []
  for (let frame = 0; frame < 6; frame += 1) samples.push(blinkAt(frame / fps, fps, { interval }))
  assert.deepEqual(samples.slice(0, 4), [0.5, 1, 1, 0.5], 'the lid is half, closed, closed, half')
  assert.equal(samples[4], 0, 'the eye is open after the blink')
  assert.equal(samples[5], 0)
  // Eye opens between blinks.
  let openSamples = 0
  for (let index = 0; index < 240; index += 1) {
    if (blinkAt(index / fps, fps, { interval }) === 0) openSamples += 1
  }
  assert.ok(openSamples > 180, `the eye should be open most of the time, got ${openSamples}/240 open`)
})

await check('blinkAt uses the measured interval range by default', () => {
  // Count blink *events* (rising edges) rather than sampling at whole seconds:
  // a blink lasts four frames, so a 1 Hz sample almost always misses it.
  const fps = 24
  let blinks = 0
  let wasBlinking = false
  for (let frame = 0; frame < 20 * fps; frame += 1) {
    const blinking = blinkAt(frame / fps, fps) > 0
    if (blinking && !wasBlinking) blinks += 1
    wasBlinking = blinking
  }
  // 20 s at the mid-band interval of ~1.4 s is about 14 blinks; allow a band.
  assert.ok(blinks >= 10 && blinks <= 18, `expected roughly 14 blinks in 20 s, got ${blinks}`)
})

await check('walkAt keeps the bob inside the measured share and leans at contact', () => {
  const height = 400
  let minBob = 0
  let maxBob = 0
  let sawContact = false
  let sawPassing = false
  for (let index = 0; index < 96; index += 1) {
    const pose = walkAt({ t: index / 24, fps: 24, height })
    if (pose.bobPx < minBob) minBob = pose.bobPx
    if (pose.bobPx > maxBob) maxBob = pose.bobPx
    if (pose.contact) { sawContact = true; assert.ok(pose.leanDeg >= PERFORMANCE.leanDeg.contact[0] - 0.01) }
    if (!pose.contact) sawPassing = true
  }
  assert.ok(sawContact && sawPassing, 'a walk cycle must include both contact and passing poses')
  const amplitude = Math.abs(minBob)
  const low = PERFORMANCE.bobShare[0] * height
  const high = PERFORMANCE.bobShare[1] * height * 1.2
  assert.ok(amplitude >= low && amplitude <= high, `bob ${amplitude.toFixed(1)}px outside ${low}-${high}px`)
})

await check('poseAt merges emotion, blink and walk without leaving valid ranges', () => {
  const pose = poseAt({ emotion: 'happy', t: 0.1, fps: 24, height: 400, walking: true })
  assert.ok(pose.eyeOpen >= 0 && pose.eyeOpen <= 1.5)
  assert.ok(pose.energy >= 0 && pose.energy <= 1.5)
  assert.ok(Number.isFinite(pose.bobPx) && Number.isFinite(pose.leanDeg))
  // Unknown emotion falls back to neutral instead of throwing.
  const fallback = poseAt({ emotion: 'no-such-emotion', t: 0 })
  assert.equal(fallback.brow, EMOTIONS.neutral.brow)
})

await check('the performance prelude gives the page the same answers', () => {
  const { MS } = runPrelude(performancePreludeSource())
  assert.equal(typeof MS.poseAt, 'function')
  assert.equal(typeof MS.blinkAt, 'function')
  assert.equal(typeof MS.actingBeat, 'function')
  assert.ok(MS.emotions.happy !== undefined)
  // Same blink shape as the module.
  const moduleSamples = [0, 1, 2, 3].map((frame) => blinkAt(frame / 24, 24, { interval: 1 }))
  const pageSamples = [0, 1, 2, 3].map((frame) => MS.blinkAt(frame / 24, 24, 1))
  assert.deepEqual(pageSamples, moduleSamples)
  // Same beat phases.
  const held = PERFORMANCE.anticipationFrames[1]
  assert.equal(MS.actingBeat(held).phase, actingBeat(held).phase)
  assert.equal(MS.actingBeat(held).pose, actingBeat(held).pose)
})

await check('both preludes coexist on one window without clobbering each other', () => {
  const window = {}
  new Function('window', adapterPreludeSource())(window)
  new Function('window', performancePreludeSource())(window)
  assert.equal(typeof window.MS.ease, 'function', 'the adapter prelude must survive')
  assert.equal(typeof window.MS.poseAt, 'function', 'the performance prelude must be added')
})

/* ------------------------------------------------------------------ *
 * One real render: a page whose ONLY contract is an MS.onSeek listener.
 * ------------------------------------------------------------------ */

const { findBrowser, renderAnimation } = await import('../lib/htmlrender.js')
const { resolveTools, makeWorkDir, removeWorkDir, run } = await import('../lib/ffmpeg.js')
const { writeFile, readFile } = await import('node:fs/promises')
const { join } = await import('node:path')

const browser = await findBrowser()
if (browser === undefined) {
  console.log('  skip a page driven only by MS.onSeek renders and moves (no Edge/Chrome)')
} else {
  await check('a page driven only by MS.onSeek renders and moves', async () => {
    const tools = await resolveTools({})
    const workDir = await makeWorkDir('adapter-test')
    try {
      const page = `<!doctype html><html><body style="margin:0;background:#0b0d12">
<canvas id="c" width="320" height="180"></canvas>
<script>
const ctx = document.getElementById('c').getContext('2d')
MS.onSeek(function (t) {
  const p = MS.ease('expo.out', Math.min(1, t / 1.2))
  ctx.fillStyle = '#0b0d12'
  ctx.fillRect(0, 0, 320, 180)
  ctx.fillStyle = '#f4f1ea'
  ctx.fillRect(10, 20, Math.round(p * 280) + 4, 30)
  ctx.fillStyle = 'hsl(' + ((t * 90) % 360) + ',70%,52%)'
  ctx.fillRect(10, 90, 120, 60)
})
</script></body></html>`
      const htmlPath = join(workDir, 'page.html')
      await writeFile(htmlPath, page, 'utf8')
      const result = await renderAnimation({
        tools,
        htmlPath,
        output: join(workDir, 'out.mp4'),
        width: 320,
        height: 180,
        fps: 10,
        duration: 2,
        workDir: join(workDir, 'w'),
      })
      assert.equal(result.runtime?.contract, 'auto-shim', `expected the adapter shim, got ${result.runtime?.contract}`)
      assert.ok(result.frames >= 15)
      const grab = async (time, name) => {
        await run(tools.ffmpeg, ['-v', 'error', '-y', '-ss', String(time), '-i', result.output, '-frames:v', '1', '-vf', 'scale=40:23,format=gray', '-f', 'rawvideo', name], { cwd: workDir })
        return readFile(join(workDir, name))
      }
      const a = await grab(0.1, 'a.raw')
      const b = await grab(1.4, 'b.raw')
      let delta = 0
      for (let index = 0; index < a.length; index += 1) delta += Math.abs(a[index] - b[index])
      assert.ok(delta / a.length > 1.5, `MS adapter did not drive the frames (mean |delta| ${(delta / a.length).toFixed(2)})`)
    } finally {
      await removeWorkDir(workDir).catch(() => undefined)
    }
  })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`\n${name}\n${error.stack}`)
  process.exitCode = 1
}
