#!/usr/bin/env node
/**
 * Acceptance tests for the HTML animation renderer (`lib/htmlrender.js`).
 *
 * Run: node test/htmlrender.test.mjs
 *
 * The primary fixture is the local `code-animation-prompts` skill's starter page
 * (`assets/starter/index.html`), copied into a temporary workspace. If the skill
 * is not installed, an identical inline replica of the contract is used so the
 * test still runs on a clean machine. The skill directory is never modified.
 *
 * Browser-dependent blocks are skipped (not failed) when neither Edge nor Chrome
 * is installed; the ffmpeg-dependent blocks are skipped when ffmpeg is absent.
 *
 * Everything this test writes goes into a fresh temp directory and is removed in
 * `finally`; the only repository files touched are `lib/htmlrender.js` and this
 * test file.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBrowser, openAnimationSession, renderAnimation } from '../lib/htmlrender.js'
import { probe, resolveTools, summariseProbe } from '../lib/ffmpeg.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const HTMLRENDER = join(PLUGIN_ROOT, 'lib', 'htmlrender.js')
const THIS_FILE = fileURLToPath(import.meta.url)
const SKILL_DIR = process.env.CODE_ANIMATION_SKILL_DIR ?? join(homedir(), '.dsh', 'skills', 'code-animation-prompts')
const SKILL_STARTER = join(SKILL_DIR, 'assets', 'starter', 'index.html')

/** Replica of the skill starter, used only when the skill itself is missing. */
const STARTER_FALLBACK = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Code Animation · 渲染接口示例</title>
<style>
  * { box-sizing: border-box; } html, body { margin: 0; background: #080d18; overflow: hidden; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style>
<canvas id="scene"></canvas>
<script>
const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d');
const config = {title: '让代码动起来', subtitle: 'CODE → MOTION', duration: 12};
function draw(t) {
  canvas.width = innerWidth; canvas.height = innerHeight;
  const w = canvas.width, h = canvas.height, scale = Math.min(w / 1280, h / 720);
  ctx.fillStyle = '#080d18'; ctx.fillRect(0, 0, w, h);
  ctx.save(); ctx.translate(w / 2, h / 2); ctx.scale(scale, scale);
  for (let i = 0; i < 120; i++) {
    const a = i * 2.399963 + t * 0.16;
    const r = 130 + Math.sqrt(i / 120) * 330;
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.57;
    ctx.fillStyle = i % 3 === 0 ? '#b8f777' : '#7f9fff';
    ctx.globalAlpha = 0.25 + 0.6 * (0.5 + 0.5 * Math.sin(t * 1.2 + i));
    ctx.beginPath(); ctx.arc(x, y, 1.5 + i % 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.fillStyle = '#b8f777';
  ctx.font = '18px Arial'; ctx.fillText(config.subtitle, 0, -54);
  ctx.fillStyle = '#f3f5fb'; ctx.font = 'bold 58px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText(config.title, 0, 24);
  ctx.fillStyle = '#8290aa'; ctx.font = '16px Arial';
  ctx.fillText('EDITABLE HTML  /  DETERMINISTIC FRAMES', 0, 72);
  ctx.fillStyle = '#b8f777'; ctx.fillRect(-160, 116, 320 * ((t % config.duration) / config.duration), 2);
  ctx.restore();
}
window.renderAt = t => draw(t);
const query = new URLSearchParams(location.search);
if (query.has('t')) draw(Number(query.get('t')) || 0);
else if (query.has('export')) draw(0);
else {
  const start = performance.now();
  function loop(now) { draw((now - start) / 1000); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
}
</script>
</html>
`

const NO_CONTRACT_PAGE = `<!doctype html>
<html><body style="margin:0;background:#123"><h1>This page has no export contract</h1>
<script>document.title = 'no renderAt';</script></body></html>
`

const BLANK_PAGE = `<!doctype html>
<html><body style="margin:0;background:#000">
<script>window.renderAt = function (t) { /* draws nothing on purpose */ };</script></body></html>
`

const RANDOM_PAGE = `<!doctype html>
<html><body style="margin:0;background:#111">
<canvas id="c"></canvas><script>
const canvas = document.querySelector('#c');
const ctx = canvas.getContext('2d');
window.renderAt = (t) => {
  canvas.width = innerWidth; canvas.height = innerHeight;
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = 'hsl(' + Math.floor(Math.random() * 360) + ',80%,55%)';
    ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 40, 40);
  }
  ctx.fillStyle = '#fff'; ctx.font = '30px Arial';
  ctx.fillText('t=' + t.toFixed(2) + ' rnd=' + Math.random().toFixed(4), 20, 50);
};
if (new URLSearchParams(location.search).has('export')) window.renderAt(0);
</script></body></html>
`

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

/** Record a skipped block (e.g. no browser installed) without failing the run. */
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

/** Frame rate of the first video stream as a number. */
function videoFps(summary) {
  return summary.video[0]?.fps ?? 0
}

// ---------------------------------------------------------------------------
// Setup: temp workspace, fixtures, tool discovery
// ---------------------------------------------------------------------------
const workDir = await mkdtemp(join(tmpdir(), 'media-senses-htmlrender-test-'))
const starterPath = join(workDir, 'starter.html')
const noContractPath = join(workDir, 'no-contract.html')
const blankPath = join(workDir, 'blank.html')
const randomPath = join(workDir, 'random.html')
const FULL_OUTPUT = join(workDir, 'starter-3s-24fps.mp4')
const FULL_FRAMES_DIR = join(workDir, 'work-full', 'frames')

let tools
let toolsError
try {
  tools = await resolveTools()
} catch (error) {
  toolsError = error
}
const browser = await findBrowser()

console.log(`workspace: ${workDir}`)
if (tools === undefined) console.log(`ffmpeg unavailable: ${toolsError.message}`)
else console.log(`ffmpeg: ${tools.version}`)
console.log(`browser: ${browser ?? 'none found'}`)
console.log('')

let starterSource
try {
  await copyFile(SKILL_STARTER, starterPath)
  starterSource = 'skill starter'
} catch {
  await writeFile(starterPath, STARTER_FALLBACK, 'utf8')
  starterSource = 'inline replica (skill not installed)'
}
await writeFile(noContractPath, NO_CONTRACT_PAGE, 'utf8')
await writeFile(blankPath, BLANK_PAGE, 'utf8')
await writeFile(randomPath, RANDOM_PAGE, 'utf8')

const canRender = tools !== undefined && browser !== undefined
const noRenderReason = tools === undefined ? 'ffmpeg unavailable' : 'no Edge/Chrome installed'

try {
  // -------------------------------------------------------------------------
  // Static checks: every deliverable must parse.
  // -------------------------------------------------------------------------
  await check('node --check lib/htmlrender.js', () => {
    execFileSync(process.execPath, ['--check', HTMLRENDER], { stdio: 'pipe' })
  })
  await check('node --check test/htmlrender.test.mjs', () => {
    execFileSync(process.execPath, ['--check', THIS_FILE], { stdio: 'pipe' })
  })

  // -------------------------------------------------------------------------
  // Argument validation (no browser needed).
  // -------------------------------------------------------------------------
  await check('rejects an odd output width before touching the browser', async () => {
    const error = await renderAnimation({
      htmlPath: starterPath,
      output: join(workDir, 'odd.mp4'),
      width: 641,
      height: 360,
      duration: 0.2,
      fps: 5,
    }).then(
      () => undefined,
      (rejected) => rejected,
    )
    assert.ok(error instanceof Error, 'expected renderAnimation to reject')
    assert.match(error.message, /even/u)
    assert.match(error.message, /641/u)
  })

  await check('rejects a non-positive duration', async () => {
    const error = await renderAnimation({
      htmlPath: starterPath,
      output: join(workDir, 'zero.mp4'),
      width: 320,
      height: 180,
      duration: 0,
      fps: 5,
    }).then(
      () => undefined,
      (rejected) => rejected,
    )
    assert.ok(error instanceof Error, 'expected renderAnimation to reject')
    assert.match(error.message, /duration/u)
  })

  await check('reports a missing animation HTML file by path', async () => {
    const missing = join(workDir, 'does-not-exist.html')
    const error = await renderAnimation({
      htmlPath: missing,
      output: join(workDir, 'missing.mp4'),
      width: 320,
      height: 180,
      duration: 0.2,
      fps: 5,
    }).then(
      () => undefined,
      (rejected) => rejected,
    )
    assert.ok(error instanceof Error, 'expected renderAnimation to reject')
    assert.match(error.message, /not found/u)
    assert.ok(error.message.includes('does-not-exist.html'), `error does not name the file: ${error.message}`)
  })

  if (canRender) {
    await check('reports a browserPath that does not exist as a browser problem', async () => {
      const error = await renderAnimation({
        tools,
        htmlPath: starterPath,
        output: join(workDir, 'no-browser.mp4'),
        width: 320,
        height: 180,
        duration: 0.2,
        fps: 5,
        browserPath: 'C:/nope.exe',
      }).then(
        () => undefined,
        (rejected) => rejected,
      )
      assert.ok(error instanceof Error, 'expected renderAnimation to reject')
      assert.match(error.message, /browserPath/iu)
      assert.ok(/nope\.exe/iu.test(error.message), `error does not name the bad binary: ${error.message}`)
      assert.ok(!(await exists(join(workDir, 'no-browser.mp4'))), 'a failed render must not leave an output file')
    })
  } else {
    skip('reports a browserPath that does not exist as a browser problem', noRenderReason)
  }

  // -------------------------------------------------------------------------
  // Main acceptance render: the skill starter, 3 s @ 24 fps @ 640x360.
  // -------------------------------------------------------------------------
  if (canRender) {
    const progress = []
    const renderStartedAt = Date.now()
    let result
    await check('renders the skill starter 3 s @ 24 fps at 640x360', async () => {
      result = await renderAnimation({
        tools,
        htmlPath: starterPath,
        output: FULL_OUTPUT,
        width: 640,
        height: 360,
        fps: 24,
        duration: 3,
        workDir: join(workDir, 'work-full'),
        onProgress: (info) => progress.push(info),
      })
      assert.equal(result.ok, true, 'renderAnimation did not report ok')
      assert.equal(result.output, FULL_OUTPUT)
      assert.equal(result.width, 640)
      assert.equal(result.height, 360)
      assert.equal(result.fps, 24)
      assert.equal(result.frames, 72, `frame count should be ceil(3 * 24) = 72, got ${result.frames}`)
      assert.ok(Number.isFinite(result.duration), 'result.duration is not a finite number')
      assert.ok(Math.abs(result.duration - 3) <= 0.15, `encoded duration ${result.duration}s is not within 3.0 ± 0.15 s`)
      assert.ok(Array.isArray(result.warnings), 'result.warnings must be an array')
      assert.ok(Number.isFinite(result.renderSeconds) && result.renderSeconds > 0, 'renderSeconds is not positive')
      assert.ok(Number.isFinite(result.captureSeconds) && result.captureSeconds > 0, 'captureSeconds is not positive')
      assert.ok(Number.isFinite(result.bytes) && result.bytes > 0, 'bytes is not positive')
      assert.ok(result.bytes > 20 * 1024, `encoded MP4 is only ${result.bytes} bytes; expected > 20 KB`)
      assert.ok(await exists(FULL_OUTPUT), 'output MP4 does not exist')
      const outputInfo = await stat(FULL_OUTPUT)
      assert.ok(outputInfo.size > 20 * 1024, `encoded MP4 is only ${outputInfo.size} bytes on disk`)
      // The page is deterministic and pure: the renderer must not have had to warn.
      assert.ok(
        !result.warnings.some((warning) => /not repeatable/iu.test(warning)),
        `determinism warning was emitted: ${JSON.stringify(result.warnings)}`,
      )
      const measuredSeconds = (Date.now() - renderStartedAt) / 1000
      console.log(
        `      measured ${measuredSeconds.toFixed(2)}s wall for 3 s @ 24 fps 640x360 ` +
          `(renderSeconds=${result.renderSeconds}, captureSeconds=${result.captureSeconds}, ` +
          `flush=${result.timings?.flushMs}ms, screenshot=${result.timings?.screenshotMs}ms, ` +
          `encode=${result.timings?.encodeSeconds}s), ${outputInfo.size} bytes`,
      )
    })

    await check('shows up as H.264 640x360 24 fps 3.0 s in ffprobe', async () => {
      assert.ok(await exists(FULL_OUTPUT), 'output MP4 does not exist')
      const summary = summariseProbe(await probe(tools, FULL_OUTPUT))
      const video = summary.video[0]
      assert.ok(video !== undefined, 'ffprobe found no video stream')
      assert.equal(video.codec, 'h264')
      assert.equal(video.width, 640, `ffprobe width ${video.width}`)
      assert.equal(video.height, 360, `ffprobe height ${video.height}`)
      assert.ok(Math.abs(videoFps(summary) - 24) <= 0.01, `ffprobe fps ${videoFps(summary)}`)
      assert.ok(Math.abs(summary.duration - 3) <= 0.15, `ffprobe duration ${summary.duration}s`)
    })

    await check('reports progress for every frame and cleans up its frames', async () => {
      assert.equal(progress.length, 72, `expected 72 onProgress calls, got ${progress.length}`)
      assert.deepEqual(progress[0]?.frame, 1)
      assert.deepEqual(progress.at(-1)?.frame, 72)
      assert.deepEqual(progress.at(-1)?.total, 72)
      assert.ok(progress.every((info) => Number.isFinite(info.time)), 'progress time is not finite')
      assert.ok(!(await exists(FULL_FRAMES_DIR)), 'temporary frames directory was not removed')
      assert.ok(!(await exists(join(workDir, 'work-full', 'profile'))), 'temporary browser profile was not removed')
      assert.ok(!(await exists(join(workDir, 'work-full', 'render.mp4'))), 'temporary MP4 was not removed')
    })

    // -----------------------------------------------------------------------
    // Determinism: two captures of the same time point must be byte-identical.
    // -----------------------------------------------------------------------
    await check('two captures of the same time point are byte-identical', async () => {
      const session = await openAnimationSession({
        htmlPath: starterPath,
        width: 640,
        height: 360,
        workDir: join(workDir, 'work-determinism'),
      })
      try {
        const first = await session.capture(1.25)
        const second = await session.capture(1.25)
        assert.ok(first.equals(second), `captures of t=1.25 differ (${first.length} vs ${second.length} bytes)`)
        const next = await session.capture(1.5)
        assert.ok(!first.equals(next), 'consecutive time points produced identical frames; the page is not animating')
        assert.equal(pngSize(first).width, 640)
        assert.equal(pngSize(first).height, 360)
        assert.ok(session.stats.frames >= 3)
      } finally {
        await session.close()
      }
      assert.ok(!(await exists(join(workDir, 'work-determinism', 'profile'))), 'session profile was not removed')
    })

    await check('injected runtime makes an unseeded Math.random page repeatable', async () => {
      const session = await openAnimationSession({
        htmlPath: randomPath,
        width: 320,
        height: 180,
        workDir: join(workDir, 'work-random'),
        injectDeterminism: true,
      })
      try {
        const first = await session.capture(0.5)
        const second = await session.capture(0.5)
        assert.ok(
          first.equals(second),
          `random page is not repeatable even with the injected runtime (${first.length} vs ${second.length} bytes)`,
        )
      } finally {
        await session.close()
      }
    })

    await check('emulated viewport matches the requested non-standard size', async () => {
      const session = await openAnimationSession({
        htmlPath: starterPath,
        width: 480,
        height: 270,
        workDir: join(workDir, 'work-viewport'),
      })
      try {
        const frame = await session.capture(0)
        const size = pngSize(frame)
        assert.equal(size.width, 480)
        assert.equal(size.height, 270)
        assert.equal(session.width, 480)
        assert.equal(session.height, 270)
      } finally {
        await session.close()
      }
    })

    // -----------------------------------------------------------------------
    // Degradation: contract and paint failures must be loud, never black video.
    // -----------------------------------------------------------------------
    await check('rejects a page without window.renderAt, naming the contract', async () => {
      const error = await renderAnimation({
        tools,
        htmlPath: noContractPath,
        output: join(workDir, 'no-contract.mp4'),
        width: 320,
        height: 180,
        fps: 5,
        duration: 0.2,
        readyTimeoutMs: 2500,
        workDir: join(workDir, 'work-no-contract'),
      }).then(
        () => undefined,
        (rejected) => rejected,
      )
      assert.ok(error instanceof Error, 'expected renderAnimation to reject')
      assert.match(error.message, /renderAt/u)
      assert.ok(
        error.message.includes('no-contract.html'),
        `error does not name the animation file: ${error.message}`,
      )
      assert.ok(
        !(await exists(join(workDir, 'no-contract.mp4'))),
        'a failed render must not leave an output file behind',
      )
    })

    await check('rejects an entirely blank render instead of producing black video', async () => {
      const error = await renderAnimation({
        tools,
        htmlPath: blankPath,
        output: join(workDir, 'blank.mp4'),
        width: 320,
        height: 180,
        fps: 5,
        duration: 0.4,
        workDir: join(workDir, 'work-blank'),
      }).then(
        () => undefined,
        (rejected) => rejected,
      )
      assert.ok(error instanceof Error, 'expected renderAnimation to reject')
      assert.match(error.message, /blank/iu)
      assert.ok(!(await exists(join(workDir, 'blank.mp4'))), 'blank render must not leave an output file behind')
    })
  } else {
    for (const name of [
      'renders the skill starter 3 s @ 24 fps at 640x360',
      'shows up as H.264 640x360 24 fps 3.0 s in ffprobe',
      'reports progress for every frame and cleans up its frames',
      'two captures of the same time point are byte-identical',
      'injected runtime makes an unseeded Math.random page repeatable',
      'emulated viewport matches the requested non-standard size',
      'rejects a page without window.renderAt, naming the contract',
      'rejects an entirely blank render instead of producing black video',
    ]) {
      skip(name, noRenderReason)
    }
  }
} finally {
  await rm(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined)
}

console.log('')
console.log(`starter fixture: ${starterSource}`)
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exitCode = failed === 0 ? 0 : 1
