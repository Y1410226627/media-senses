#!/usr/bin/env node
/**
 * Acceptance tests for the M1 animation-runtime upgrade (`lib/htmlrender.js` +
 * `lib/animaudio.js`).
 *
 * Run: node test/anim-runtime.test.mjs
 *
 * Coverage:
 * - pure `animaudio` logic: HTML parsing, page-entry normalisation, ffmpeg
 *   adelay/amix argument generation;
 * - `lintAnimationSource` and its four violation classes;
 * - browser runtime: CSS @keyframes seek, `__timelines` seek/time/progress
 *   adapters, declarative clip visibility, auto-shim for pages without
 *   `window.renderAt`;
 * - motion blur produces genuinely intermediate pixels versus a sharp render;
 * - in-page `<audio>` clips are mixed into the finished MP4.
 *
 * Everything is written into a fresh temp directory and removed in `finally`;
 * the only repository files touched are `lib/htmlrender.js`, `lib/animaudio.js`
 * and this test.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBrowser, lintAnimationSource, openAnimationSession, renderAnimation } from '../lib/htmlrender.js'
import { buildAudioMixArgs, normalisePageAudio, parseAudioClips, parseSeconds } from '../lib/animaudio.js'
import { probe, resolveTools, summariseProbe } from '../lib/ffmpeg.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const HTMLRENDER = join(PLUGIN_ROOT, 'lib', 'htmlrender.js')
const ANIMAUDIO = join(PLUGIN_ROOT, 'lib', 'animaudio.js')
const THIS_FILE = fileURLToPath(import.meta.url)

let passed = 0
let failed = 0
let skipped = 0

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

/** Record a skipped block (no browser / no ffmpeg) without failing the run. */
function skip(name, reason) {
  skipped += 1
  console.log(`SKIP  ${name} (${reason})`)
}

/** True when `file` exists and is a regular file. */
async function exists(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** Read width/height out of a PNG IHDR chunk. */
function pngSize(buffer) {
  assert.ok(buffer.length >= 24, 'captured frame is too small to be a PNG')
  assert.equal(buffer.readUInt32BE(12), 0x49484452, 'captured frame has no IHDR chunk')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** Spawn ffmpeg, feed an optional stdin buffer, collect stdout bytes. */
function spawnCapture(binary, args, stdinBuffer) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout))
        return
      }
      const detail = Buffer.concat(stderr).toString('utf8').split(/\r?\n/u).slice(0, 4).join(' | ')
      reject(new Error(`ffmpeg exited ${code}: ${detail}`))
    })
    child.stdin.end(stdinBuffer ?? Buffer.alloc(0))
  })
}

/** Decode PNG bytes to raw rgb24. */
function decodePngRgb(tools, png) {
  return spawnCapture(tools.ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], png)
}

/** Decode one frame of a video to raw rgb24. */
function extractVideoFrameRgb(tools, file, index) {
  return spawnCapture(tools.ffmpeg, [
    '-v', 'error',
    '-i', file,
    '-vf', `select=eq(n\\,${index})`,
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ])
}

/** RGB triple at (x, y) of a raw rgb24 buffer. */
function pixelAt(raw, width, x, y) {
  const offset = (y * width + x) * 3
  return [raw[offset], raw[offset + 1], raw[offset + 2]]
}

/** Count grey-ish intermediate pixels (motion-blur smear evidence). */
function countSoftPixels(raw) {
  let count = 0
  for (let offset = 0; offset + 2 < raw.length; offset += 3) {
    const red = raw[offset]
    const green = raw[offset + 1]
    const blue = raw[offset + 2]
    if (red > 30 && red < 225 && Math.abs(red - green) <= 8 && Math.abs(green - blue) <= 8) count += 1
  }
  return count
}

/** Small 16-bit PCM mono WAV used as the in-page audio fixture. */
function makeWav({ seconds = 0.5, frequency = 440, sampleRate = 48_000 } = {}) {
  const sampleCount = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(sampleCount * 2)
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.35 * 32767)
    data.writeInt16LE(value, index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const CSS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
#box { position: absolute; top: 60px; left: 0; width: 60px; height: 60px; background: #ff0000;
       animation: slide 2s linear infinite; }
@keyframes slide {
  from { transform: translateX(0px); background: #ff0000; }
  to   { transform: translateX(240px); background: #00ff00; }
}
</style></head><body><div id="box"></div></body></html>`

const TIMELINES_PAGE = `<!doctype html><html><head><style>
html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
.box { position: absolute; left: 0; width: 60px; height: 60px; }
</style></head><body>
<div id="seek-box" class="box" style="top: 0; background: #ff0000"></div>
<div id="time-box" class="box" style="top: 70px; background: #00ff00"></div>
<div id="progress-box" class="box" style="top: 140px; background: #0000ff"></div>
<script>
window.__timelines = {
  seekAdapter: { seek: function (t) {
    document.getElementById('seek-box').style.transform = 'translateX(' + (t * 100) + 'px)';
  } },
  timeAdapter: { time: function (t) {
    document.getElementById('time-box').style.transform = 'translateY(' + (t * 50) + 'px)';
  } },
  progressAdapter: { progress: function (t) {
    document.getElementById('progress-box').style.opacity = String(Math.min(1, t / 2));
  } }
};
</script></body></html>`

const CLIPS_PAGE = `<!doctype html><html><head><style>
html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
.clip { position: absolute; inset: 0; }
</style></head><body>
<div data-composition-id="main" data-duration="2" style="position: absolute; inset: 0">
  <div id="red" class="clip" data-start="0" data-duration="1" data-track-index="0" style="background: #ff0000"></div>
  <div id="blue" class="clip" data-start="1" data-duration="1" data-track-index="0" style="background: #0000ff"></div>
  <div id="hold" data-start="0" data-duration="0.1" data-hold
       style="position: absolute; left: 8px; top: 8px; width: 16px; height: 16px; background: #00ff00"></div>
</div>
</body></html>`

const CLIPS_NO_ROOT_PAGE = `<!doctype html><html><head><style>
html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
.clip { position: absolute; inset: 0; }
</style></head><body>
<div class="clip" data-start="0" data-duration="0.2" style="background: #00ff00"></div>
<div class="clip" data-start="0.2" data-duration="0.2" style="background: #0000ff"></div>
</body></html>`

const MOTION_PAGE = `<!doctype html><html><body style="margin: 0; background: #000; overflow: hidden">
<canvas id="c" style="display: block; width: 100vw; height: 100vh"></canvas>
<script>
const canvas = document.querySelector('#c');
const ctx = canvas.getContext('2d');
window.renderAt = (t) => {
  canvas.width = innerWidth; canvas.height = innerHeight;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  const x = 40 + t * 400;
  ctx.fillRect(x, Math.round(canvas.height * 0.4), 40, 40);
};
</script></body></html>`

const AUDIO_PAGE = `<!doctype html><html><body style="margin: 0; background: #000; overflow: hidden">
<audio data-start="0" data-duration="0.4" data-track-index="0" data-volume="0.6" src="tone.wav"></audio>
<canvas id="c" style="display: block; width: 100vw; height: 100vh"></canvas>
<script>
const canvas = document.querySelector('#c');
const ctx = canvas.getContext('2d');
window.renderAt = (t) => {
  canvas.width = innerWidth; canvas.height = innerHeight;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#5ec8ff';
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, 20 + t * 40, 0, Math.PI * 2);
  ctx.fill();
};
</script></body></html>`

const workDir = await mkdtemp(join(tmpdir(), 'media-senses-anim-runtime-test-'))
const cssPath = join(workDir, 'css.html')
const timelinesPath = join(workDir, 'timelines.html')
const clipsPath = join(workDir, 'clips.html')
const clipsNoRootPath = join(workDir, 'clips-no-root.html')
const motionPath = join(workDir, 'motion.html')
const audioPath = join(workDir, 'audio.html')
const tonePath = join(workDir, 'tone.wav')

let tools
let toolsError
try {
  tools = await resolveTools()
} catch (error) {
  toolsError = error
}
const browser = await findBrowser()
const canRender = tools !== undefined && browser !== undefined
const noRenderReason = tools === undefined ? 'ffmpeg unavailable' : 'no Edge/Chrome installed'

console.log(`workspace: ${workDir}`)
console.log(tools === undefined ? `ffmpeg unavailable: ${toolsError.message}` : `ffmpeg: ${tools.version}`)
console.log(`browser: ${browser ?? 'none found'}`)
console.log('')

await writeFile(cssPath, CSS_PAGE, 'utf8')
await writeFile(timelinesPath, TIMELINES_PAGE, 'utf8')
await writeFile(clipsPath, CLIPS_PAGE, 'utf8')
await writeFile(clipsNoRootPath, CLIPS_NO_ROOT_PAGE, 'utf8')
await writeFile(motionPath, MOTION_PAGE, 'utf8')
await writeFile(audioPath, AUDIO_PAGE, 'utf8')
await writeFile(tonePath, makeWav({ seconds: 0.5, frequency: 440 }))

try {
  // -------------------------------------------------------------------------
  // Static checks
  // -------------------------------------------------------------------------
  await check('node --check lib/htmlrender.js', () => {
    execFileSync(process.execPath, ['--check', HTMLRENDER], { stdio: 'pipe' })
  })
  await check('node --check lib/animaudio.js', () => {
    execFileSync(process.execPath, ['--check', ANIMAUDIO], { stdio: 'pipe' })
  })
  await check('node --check test/anim-runtime.test.mjs', () => {
    execFileSync(process.execPath, ['--check', THIS_FILE], { stdio: 'pipe' })
  })

  // -------------------------------------------------------------------------
  // animaudio: parsing + argument generation (pure, no browser)
  // -------------------------------------------------------------------------
  await check('parseSeconds accepts seconds, suffixed seconds and milliseconds', () => {
    assert.equal(parseSeconds('1.5'), 1.5)
    assert.equal(parseSeconds('1.5s'), 1.5)
    assert.equal(parseSeconds('1500ms'), 1.5)
    assert.equal(parseSeconds('-2'), -2)
    assert.equal(parseSeconds(2.25), 2.25)
    assert.equal(parseSeconds('nope'), null)
    assert.equal(parseSeconds(null), null)
    assert.equal(parseSeconds(''), null)
  })

  await check('parseAudioClips reads the declarative audio attributes', () => {
    const source = [
      '<audio data-start="1.5" data-duration="2" data-track-index="1" data-volume="0.5" src="bed.mp3"></audio>',
      '<audio data-start="0s" src="beep.wav"></audio>',
      '<audio src="no-start.wav"></audio>',
      '<audio data-start="2"><source src="nested.mp3"></audio>',
    ].join('\n')
    const { clips, warnings } = parseAudioClips(source)
    assert.equal(clips.length, 4, JSON.stringify(clips))
    assert.equal(clips[0].src, 'bed.mp3')
    assert.equal(clips[0].start, 1.5)
    assert.equal(clips[0].duration, 2)
    assert.equal(clips[0].trackIndex, 1)
    assert.equal(clips[0].volume, 0.5)
    assert.equal(clips[1].src, 'beep.wav')
    assert.equal(clips[1].start, 0)
    assert.equal(clips[2].src, 'no-start.wav')
    assert.equal(clips[2].hasStart, false)
    assert.equal(clips[3].src, 'nested.mp3')
    assert.ok(warnings.some((warning) => warning.code === 'missing-start'))
  })

  await check('normalisePageAudio resolves file URLs and keeps http URLs', () => {
    const fileEntry = { currentSrc: 'file:///C:/tmp/music%20bed.wav', src: 'music bed.wav', start: '1.5', duration: '2', trackIndex: '1', volume: '0.5' }
    const remoteEntry = { currentSrc: '', src: 'https://example.com/a.mp3', start: '0', duration: null, trackIndex: null, volume: null }
    const { clips, warnings } = normalisePageAudio([fileEntry, remoteEntry], { baseDir: 'C:\\tmp' })
    assert.equal(clips.length, 2, JSON.stringify(warnings))
    assert.equal(clips[0].source, 'C:\\tmp\\music bed.wav')
    assert.equal(clips[0].start, 1.5)
    assert.equal(clips[0].duration, 2)
    assert.equal(clips[0].volume, 0.5)
    assert.equal(clips[1].source, 'https://example.com/a.mp3')
    assert.equal(clips[1].duration, null)
    const rejected = normalisePageAudio([{ currentSrc: 'data:audio/wav;base64,AAAA', src: 'x' }])
    assert.equal(rejected.clips.length, 0)
    assert.ok(rejected.warnings.some((warning) => warning.code === 'unsupported-src'))
  })

  await check('buildAudioMixArgs generates adelay/amix/atrim/volume arguments', () => {
    const plan = buildAudioMixArgs({
      duration: 3,
      clips: [
        { source: 'C:\\audio\\one.mp3', label: 'one.mp3', start: 1.5, duration: 1, volume: 0.5 },
        { source: 'C:\\audio\\two.wav', label: 'two.wav', start: 0, duration: null, volume: 1 },
      ],
    })
    // Inputs: the silent video plus one -i per clip; absolute paths are allowed
    // as ordinary input arguments.
    assert.ok(plan.args.includes('render.mp4'))
    assert.ok(plan.args.includes('C:\\audio\\one.mp3'))
    assert.ok(plan.args.includes('C:\\audio\\two.wav'))
    assert.equal(plan.inputs.filter((value) => value === '-i').length, 3)
    assert.match(plan.filterComplex, /\[1:a\]atrim=0:1,asetpts=PTS-STARTPTS,adelay=1500:all=1,volume=0\.5\[a0\]/u)
    assert.match(plan.filterComplex, /\[2:a\]asetpts=PTS-STARTPTS,adelay=0:all=1\[a1\]/u)
    assert.match(plan.filterComplex, /amix=inputs=2:duration=longest:dropout_transition=0:normalize=0/u)
    assert.match(plan.filterComplex, /alimiter=limit=0\.95\[aout\]/u)
    assert.ok(plan.args.includes('-map') && plan.args.includes('0:v:0') && plan.args.includes('[aout]'))
    assert.equal(plan.args[plan.args.indexOf('-c:v') + 1], 'copy')
    assert.equal(plan.args[plan.args.indexOf('-t') + 1], '3')
    // Hard Windows rule: no drive-letter absolute path may appear in the filter graph.
    assert.ok(!/[A-Za-z]:[\\/]/u.test(plan.filterComplex), `filtergraph leaked a path: ${plan.filterComplex}`)
    assert.equal(plan.clips.length, 2)
    assert.equal(plan.outputName, 'render-audio.mp4')
  })

  await check('buildAudioMixArgs handles a single clip and skips clips outside the video', () => {
    const single = buildAudioMixArgs({ duration: 2, clips: [{ source: 'a.wav', start: 0.25 }] })
    assert.ok(!single.filterComplex.includes('amix='), 'a single clip should not need amix')
    assert.match(single.filterComplex, /adelay=250:all=1/u)
    assert.match(single.filterComplex, /\[a0\]alimiter=limit=0\.95\[aout\]/u)
    const skipped = buildAudioMixArgs({
      duration: 2,
      clips: [
        { source: 'a.wav', start: 0 },
        { source: 'late.wav', start: 5 },
      ],
    })
    assert.equal(skipped.clips.length, 1)
    assert.equal(skipped.skipped.length, 1)
    assert.equal(skipped.skipped[0].reason, 'starts-after-video')
    assert.throws(() => buildAudioMixArgs({ duration: 2, clips: [{ source: 'late.wav', start: 5 }] }), /no audio clip/u)
    assert.throws(() => buildAudioMixArgs({ duration: 0, clips: [] }), /duration/u)
  })

  // -------------------------------------------------------------------------
  // lintAnimationSource: four violation classes
  // -------------------------------------------------------------------------
  await check('lintAnimationSource accepts a well-formed composition', () => {
    const source = `<div data-composition-id="main" data-duration="10">
      <div data-start="0" data-duration="2"></div>
      <div data-start="3" data-duration="4" data-track-index="1"></div>
    </div>`
    assert.deepEqual(lintAnimationSource(source, { duration: 10 }), [])
  })

  await check('lintAnimationSource reports clips without a composition root', () => {
    const issues = lintAnimationSource('<div data-start="0" data-duration="2"></div>')
    const issue = issues.find((entry) => entry.code === 'missing-composition-root')
    assert.ok(issue !== undefined, JSON.stringify(issues))
    assert.equal(issue.severity, 'warn')
    assert.match(issue.message, /data-composition-id/u)
  })

  await check('lintAnimationSource reports per-track duration overflow', () => {
    const source = `<div data-composition-id="main" data-duration="3">
      <div data-start="0" data-duration="2"></div>
      <div data-start="2" data-duration="2"></div>
    </div>`
    const issues = lintAnimationSource(source)
    const issue = issues.find((entry) => entry.code === 'duration-overflow')
    assert.ok(issue !== undefined, JSON.stringify(issues))
    assert.match(issue.message, /track 0/u)
    assert.match(issue.message, /4s/u)
  })

  await check('lintAnimationSource reports overlapping clips on the same track', () => {
    const source = `<div data-composition-id="main" data-duration="10">
      <div data-start="0" data-duration="2" data-track-index="2"></div>
      <div data-start="1" data-duration="3" data-track-index="2"></div>
    </div>`
    const issues = lintAnimationSource(source, { duration: 10 })
    const issue = issues.find((entry) => entry.code === 'track-overlap')
    assert.ok(issue !== undefined, JSON.stringify(issues))
    assert.match(issue.message, /track 2/u)
  })

  await check('lintAnimationSource reports negative starts and is idempotent', () => {
    const source = `<div data-composition-id="main" data-duration="10">
      <div data-start="-1.5" data-duration="2"></div>
    </div>`
    const first = lintAnimationSource(source)
    const second = lintAnimationSource(source)
    const issue = first.find((entry) => entry.code === 'negative-start')
    assert.ok(issue !== undefined, JSON.stringify(first))
    assert.equal(issue.severity, 'warn')
    assert.deepEqual(first, second)
    assert.deepEqual(lintAnimationSource(''), [])
    assert.deepEqual(lintAnimationSource(undefined), [])
  })

  await check('invalid motionBlur settings are rejected before any browser starts', async () => {
    const cases = [
      [{ shutter: 400, samples: 4 }, /motionBlur\.shutter/u],
      [{ samples: 99 }, /motionBlur\.samples/u],
      ['on', /motionBlur/u],
    ]
    for (const [motionBlur, pattern] of cases) {
      const error = await renderAnimation({
        htmlPath: motionPath,
        output: join(workDir, 'bad-motion.mp4'),
        width: 320,
        height: 180,
        fps: 5,
        duration: 0.2,
        motionBlur,
      }).then(
        () => undefined,
        (rejected) => rejected,
      )
      assert.ok(error instanceof Error, `expected rejection for ${JSON.stringify(motionBlur)}`)
      assert.match(error.message, pattern)
    }
    assert.ok(!(await exists(join(workDir, 'bad-motion.mp4'))), 'failed validation must not create an output')
  })

  // -------------------------------------------------------------------------
  // Browser runtime tests
  // -------------------------------------------------------------------------
  if (!canRender) {
    for (const name of [
      'CSS @keyframes animations are paused and seeked by the runtime',
      '__timelines seek/time/progress adapters all drive the page',
      'declarative clips switch visibility on the composition timeline',
      'a page with declarative clips but no window.renderAt auto-shims and renders',
      'motion blur produces intermediate pixels the sharp render does not have',
      'in-page audio clips are mixed into the finished MP4',
    ]) {
      skip(name, noRenderReason)
    }
  } else {
    await check('CSS @keyframes animations are paused and seeked by the runtime', async () => {
      const session = await openAnimationSession({
        htmlPath: cssPath,
        width: 320,
        height: 180,
        workDir: join(workDir, 'work-css'),
      })
      try {
        assert.equal(session.contract.mode, 'auto-shim', JSON.stringify(session.contract))
        assert.ok(session.contract.animations >= 1, 'expected the CSS animation to be detected')
        const early = await session.capture(0.2)
        const late = await session.capture(1.2)
        assert.ok(!early.equals(late), 'CSS keyframes page produced identical frames at t=0.2 and t=1.2')
        const state = await session.evaluate(
          `document.getAnimations().map((animation) => ({ playState: animation.playState, currentTime: animation.currentTime }))`,
        )
        assert.ok(Array.isArray(state) && state.length >= 1, JSON.stringify(state))
        for (const animation of state) {
          assert.equal(animation.playState, 'paused', 'CSS animation was not paused')
          assert.ok(Math.abs(animation.currentTime - 1200) <= 1, `currentTime ${animation.currentTime} != 1200`)
        }
        const again = await session.capture(1.2)
        assert.ok(again.equals(late), 're-capturing t=1.2 was not byte-identical')
      } finally {
        await session.close()
      }
    })

    await check('__timelines seek/time/progress adapters all drive the page', async () => {
      const session = await openAnimationSession({
        htmlPath: timelinesPath,
        width: 320,
        height: 180,
        workDir: join(workDir, 'work-timelines'),
      })
      try {
        assert.equal(session.contract.mode, 'auto-shim')
        assert.equal(session.contract.timelines, 3, JSON.stringify(session.contract))
        const frameA = await session.capture(0.5)
        const stateA = await session.evaluate(`(() => ({
          seek: document.getElementById('seek-box').style.transform,
          time: document.getElementById('time-box').style.transform,
          progress: document.getElementById('progress-box').style.opacity
        }))()`)
        assert.equal(stateA.seek, 'translateX(50px)')
        assert.equal(stateA.time, 'translateY(25px)')
        assert.equal(Number(stateA.progress), 0.25)
        const frameB = await session.capture(1.5)
        assert.ok(!frameA.equals(frameB), 'timelines page produced identical frames at t=0.5 and t=1.5')
        const stateB = await session.evaluate(`(() => ({
          seek: document.getElementById('seek-box').style.transform,
          progress: document.getElementById('progress-box').style.opacity
        }))()`)
        assert.equal(stateB.seek, 'translateX(150px)')
        assert.equal(Number(stateB.progress), 0.75)
      } finally {
        await session.close()
      }
    })

    await check('declarative clips switch visibility on the composition timeline', async () => {
      const session = await openAnimationSession({
        htmlPath: clipsPath,
        width: 320,
        height: 180,
        workDir: join(workDir, 'work-clips'),
      })
      try {
        assert.equal(session.contract.mode, 'auto-shim')
        assert.equal(session.contract.compositionRoot, true)
        assert.equal(session.contract.clips, 3, JSON.stringify(session.contract))

        const early = await session.capture(0.5)
        const earlyState = await session.evaluate(`(() => ({
          red: getComputedStyle(document.getElementById('red')).display,
          blue: getComputedStyle(document.getElementById('blue')).display,
          hold: getComputedStyle(document.getElementById('hold')).display
        }))()`)
        assert.equal(earlyState.red, 'block')
        assert.equal(earlyState.blue, 'none')
        assert.equal(earlyState.hold, 'block')
        const earlyRgb = await decodePngRgb(tools, early)
        assert.deepEqual(pixelAt(earlyRgb, 320, 160, 90), [255, 0, 0], 'clip A should paint red')

        const late = await session.capture(1.5)
        const lateState = await session.evaluate(`(() => ({
          red: getComputedStyle(document.getElementById('red')).display,
          blue: getComputedStyle(document.getElementById('blue')).display,
          hold: getComputedStyle(document.getElementById('hold')).display
        }))()`)
        assert.equal(lateState.red, 'none')
        assert.equal(lateState.blue, 'block')
        assert.equal(lateState.hold, 'block', 'data-hold clips must stay visible outside their window')
        const lateRgb = await decodePngRgb(tools, late)
        assert.deepEqual(pixelAt(lateRgb, 320, 160, 90), [0, 0, 255], 'clip B should paint blue')
      } finally {
        await session.close()
      }
    })

    await check('a page with declarative clips but no window.renderAt auto-shims and renders', async () => {
      const output = join(workDir, 'clips-no-root.mp4')
      const result = await renderAnimation({
        tools,
        htmlPath: clipsNoRootPath,
        output,
        width: 320,
        height: 180,
        fps: 5,
        duration: 0.4,
        workDir: join(workDir, 'work-clips-render'),
      })
      assert.equal(result.ok, true)
      assert.equal(result.frames, 2)
      assert.equal(result.runtime.contract, 'auto-shim')
      assert.equal(result.runtime.shimmed, true)
      assert.ok(result.warnings.some((warning) => /运行时平权/u.test(warning)), JSON.stringify(result.warnings))
      assert.ok(
        result.warnings.some((warning) => /missing-composition-root/u.test(warning)),
        `expected a lint warning about the missing composition root: ${JSON.stringify(result.warnings)}`,
      )
      assert.ok(await exists(output), 'auto-shimmed render produced no MP4')
      assert.ok((await stat(output)).size > 1_000)
      const summary = summariseProbe(await probe(tools, output))
      assert.equal(summary.video[0]?.width, 320)
      assert.equal(summary.video[0]?.height, 180)
      assert.ok(Math.abs(summary.duration - 0.4) <= 0.1, `duration ${summary.duration}`)
    })

    await check('motion blur produces intermediate pixels the sharp render does not have', async () => {
      const sharpOutput = join(workDir, 'motion-sharp.mp4')
      const blurOutput = join(workDir, 'motion-blur.mp4')
      const sharp = await renderAnimation({
        tools,
        htmlPath: motionPath,
        output: sharpOutput,
        width: 320,
        height: 180,
        fps: 10,
        duration: 0.5,
        crf: 12,
        workDir: join(workDir, 'work-sharp'),
      })
      const blurred = await renderAnimation({
        tools,
        htmlPath: motionPath,
        output: blurOutput,
        width: 320,
        height: 180,
        fps: 10,
        duration: 0.5,
        crf: 12,
        motionBlur: { shutter: 180, samples: 4 },
        workDir: join(workDir, 'work-blur'),
      })
      assert.equal(sharp.frames, 5)
      assert.equal(blurred.frames, 5)
      assert.equal(sharp.motionBlur, null)
      assert.deepEqual(blurred.motionBlur, { shutter: 180, samples: 4, capturedFrames: 20 })
      assert.ok(blurred.warnings.some((warning) => /运动模糊/u.test(warning)))
      assert.ok(Math.abs(blurred.duration - 0.5) <= 0.1, `blurred duration ${blurred.duration}`)
      assert.ok(Math.abs(sharp.duration - 0.5) <= 0.1, `sharp duration ${sharp.duration}`)

      const sharpFrame = await extractVideoFrameRgb(tools, sharpOutput, 2)
      const blurFrame = await extractVideoFrameRgb(tools, blurOutput, 2)
      assert.equal(sharpFrame.length, 320 * 180 * 3)
      assert.equal(blurFrame.length, 320 * 180 * 3)
      const sharpSoft = countSoftPixels(sharpFrame)
      const blurSoft = countSoftPixels(blurFrame)
      console.log(`      soft (smeared) pixels: sharp=${sharpSoft}, motion-blur=${blurSoft}`)
      assert.ok(
        blurSoft > sharpSoft + 100,
        `motion blur should add intermediate pixels (sharp=${sharpSoft}, blur=${blurSoft})`,
      )
      const blurSummary = summariseProbe(await probe(tools, blurOutput))
      assert.ok(Math.abs(blurSummary.video[0].fps - 10) <= 0.01, `blur fps ${blurSummary.video[0].fps}`)
      assert.ok(Math.abs(blurSummary.duration - 0.5) <= 0.1, `blur probe duration ${blurSummary.duration}`)
    })

    await check('in-page audio clips are mixed into the finished MP4', async () => {
      const output = join(workDir, 'audio-mixed.mp4')
      const result = await renderAnimation({
        tools,
        htmlPath: audioPath,
        output,
        width: 320,
        height: 180,
        fps: 5,
        duration: 0.6,
        mixAudio: true,
        workDir: join(workDir, 'work-audio'),
      })
      assert.equal(result.ok, true)
      assert.equal(result.audio.clips, 1, `expected 1 audio clip, got ${JSON.stringify(result.audio)}`)
      assert.equal(result.audio.mixed, true, `audio was not mixed: ${JSON.stringify(result.warnings)}`)
      assert.ok(await exists(output), 'mixed render produced no MP4')
      const summary = summariseProbe(await probe(tools, output))
      assert.ok(summary.video[0] !== undefined, 'mixed MP4 lost its video stream')
      assert.equal(summary.audio.length, 1, `expected one audio stream, got ${summary.audio.length}`)
      assert.equal(summary.audio[0].codec, 'aac')
      assert.ok(
        !result.warnings.some((warning) => /混音失败/u.test(warning)),
        `audio mix reported a failure: ${JSON.stringify(result.warnings)}`,
      )
    })
  }
} finally {
  await rm(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined)
}

console.log('')
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exitCode = failed === 0 ? 0 : 1
