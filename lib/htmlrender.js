/**
 * HTML animation rendering: drive the `code-animation-prompts` export contract
 * in headless Microsoft Edge / Google Chrome over the DevTools Protocol, capture
 * one PNG per frame, and encode the sequence to an H.264 MP4 with ffmpeg.
 *
 * The export contract (see the local skill, `references/rendering.md`):
 *
 *   window.renderAt = async function (t) { /* draw the whole frame at t seconds *\/ }
 *
 * The page is opened as `file:///...?export=1`; it must not start its own
 * requestAnimationFrame loop in that mode and must make all of its animation
 * state a pure function of `t`. This module sets the page to
 * `t = startTime + frame / fps`, captures the viewport, and encodes the frames.
 *
 * Why the DevTools Protocol and not `--screenshot`: `--screenshot` is fire-and-
 * forget and cannot set a per-frame time, so it is far too slow and offers no
 * control. Node.js 22+ ships a global `fetch` and `WebSocket`, which is all a
 * minimal CDP client needs (no npm packages).
 *
 * Pipeline:
 *   launch browser (`--headless=new`, fresh `--user-data-dir`)
 *   -> read the port from `<user-data-dir>/DevToolsActivePort` (stderr fallback)
 *   -> GET /json/list, connect the page target
 *   -> Page.enable / Runtime.enable / Emulation.setDeviceMetricsOverride
 *   -> install a determinism script (frozen Date.now/performance.now, reseeded
 *      Math.random per frame, rAF loops stopped) and navigate to
 *      `file:///...?export=1`
 *   -> per frame: Runtime.evaluate(`renderAt(t)`) -> 1x1 flush screenshot
 *      (forces WebGL/ANGLE canvases to be presented) -> PNG screenshot
 *   -> ffmpeg image2 -> H.264/yuv420p, verify with ffprobe, report real duration
 *
 * Frame-clock rules that this module learned the hard way:
 * - `HeadlessExperimental.beginFrame` no longer exists in Chromium 147+; plain
 *   `Page.captureScreenshot` is the only capture path on Edge 157.
 * - `Emulation.setVirtualTimePolicy` is unusable as a frame clock: with WebGL it
 *   takes seconds per step. `renderAt(t)` is the clock.
 * - `optimizeForSpeed: true` must not be used for PNG captures (it drops alpha);
 *   `captureBeyondViewport: true` plus an explicit full-viewport clip is needed
 *   so the compositor cannot round the viewport inward and crop the frame.
 * - A 1x1 JPEG flush capture before the PNG is what stops WebGL/ANGLE canvases
 *   from coming out black.
 *
 * Failure policy: a missing browser, missing `renderAt`, a crashed browser, a
 * zero-byte or wrong-sized frame, or a completely blank render throws an error
 * naming the file and the contract; suspicious-but-plausible frames (fade from
 * black, identical frames, non-repeatable frames) become warnings. The browser
 * process and its temporary profile are always torn down in `finally`.
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeWorkDir, probe, removeWorkDir, resolveTools, run, summariseProbe, tailLines } from './ffmpeg.js'

const IS_WINDOWS = process.platform === 'win32'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IHDR = 0x49484452
const X264_PRESETS = new Set([
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
  'medium', 'slow', 'slower', 'veryslow', 'placebo',
])

const DEFAULT_WIDTH = 1920
const DEFAULT_HEIGHT = 1080
const DEFAULT_FPS = 30
const DEFAULT_DURATION = 12
const DEFAULT_CRF = 20
const DEFAULT_PRESET = 'veryfast'
const DEFAULT_ANGLE = 'd3d11'
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000
const DEFAULT_READY_TIMEOUT_MS = 15_000
const DEFAULT_FRAME_TIMEOUT_MS = 120_000
const DEFAULT_SETTLE_TIMEOUT_MS = 250
const DEFAULT_ENCODE_TIMEOUT_MS = 30 * 60_000
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 60_000
const FLUSH_SCREENSHOT_TIMEOUT_MS = 20_000
/** PNGs below this size are almost certainly flat frames (black/one colour). */
const BLANK_FRAME_MIN_BYTES = 2048
/** Flat PNGs grow with height; scale the "looks blank" threshold with pixels. */
const BLANK_FRAME_BYTES_PER_PIXEL = 200
const MAX_PAGE_ERRORS = 12
const MAX_BROWSER_LOG_BYTES = 64 * 1024
const MAX_FRAME_CAPTURE_ATTEMPTS = 3
/** Fixed seed and epoch for the injected deterministic runtime. */
const DETERMINISM_SEED = 0x2f6e2b1
const VIRTUAL_EPOCH_MS = 1_704_067_200_000 // 2024-01-01T00:00:00Z

/* -------------------------------------------------------------------------- */
/* Pre-render source scan                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Nondeterminism sources worth naming *before* a slow render starts.
 *
 * The renderer injects a virtual clock and a seeded `Math.random`, so a page that
 * calls them still renders repeatably — but a page that reads `performance.now()`
 * or keeps state between frames produces frames that depend on wall-clock timing
 * and silently drift between runs. A ten-minute render is the wrong place to find
 * that out, so the source is scanned first and any hit becomes a named warning.
 *
 * Deliberately cheap and conservative: only literal call sites are reported, and
 * a hit is a warning (never an error) because the injection layer usually saves
 * the render anyway.
 */
const NONDETERMINISM_PATTERNS = Object.freeze([
  {
    pattern: /\bDate\.now\s*\(/gu,
    kind: 'Date.now',
    message: '页面调用了 Date.now()；渲染器会把它冻结成固定值，但如果这段代码据此决定动画进度，成片会与预期不同',
  },
  {
    pattern: /\bperformance\.now\s*\(/gu,
    kind: 'performance.now',
    message: '页面调用了 performance.now()；逐帧渲染时它不随 t 前进，动画会卡在同一点。用传入的 t 代替',
  },
  {
    pattern: /\bnew\s+Date\s*\(\s*\)/gu,
    kind: 'new Date',
    message: '页面用 new Date() 取当前时间；应改为由 t 推导',
  },
  {
    pattern: /\brequestAnimationFrame\s*\(/gu,
    kind: 'requestAnimationFrame',
    message: '页面用了 requestAnimationFrame 自播放；导出模式（?export=1）下必须停掉自播放循环，让 window.renderAt(t) 独占画面',
  },
  {
    pattern: /\bset(?:Interval|Timeout)\s*\(/gu,
    kind: 'timer',
    message: '页面用了定时器自驱动；导出模式下画面必须完全由 t 决定，定时器会导致帧与帧之间不可复现',
  },
])

/**
 * Scan an animation page's source for nondeterministic call sites.
 *
 * @param {string} source the HTML/JS source text
 * @returns {Array<{kind: string, line: number, column: number, excerpt: string, message: string}>}
 */
export function scanDeterminism(source) {
  if (typeof source !== 'string' || source.length === 0) return []
  const lines = source.split(/\r?\n/u)
  const hits = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const { pattern, kind, message } of NONDETERMINISM_PATTERNS) {
      // Every call site on the line, not just the first: a page that reads the
      // clock twice still deserves both line numbers.
      pattern.lastIndex = 0
      let match = pattern.exec(line)
      while (match !== null) {
        hits.push({
          kind,
          line: index + 1,
          column: match.index + 1,
          excerpt: line.trim().slice(0, 120),
          message,
        })
        match = pattern.exec(line)
      }
    }
  }
  return hits
}

/** Turn scan hits into at most three compact warning lines. */
function determinismWarnings(hits, htmlPath) {
  if (hits.length === 0) return []
  const byKind = new Map()
  for (const hit of hits) {
    if (!byKind.has(hit.kind)) byKind.set(hit.kind, [])
    byKind.get(hit.kind).push(hit)
  }
  const out = []
  for (const [kind, entries] of byKind) {
    const where = entries.slice(0, 3).map((entry) => `${entry.line}:${entry.column}`).join(', ')
    const more = entries.length > 3 ? ` 等 ${entries.length} 处` : ''
    out.push(`页面源码第 ${where} 行用了 ${kind}${more}——${entries[0].message}`)
  }
  out.push(`（源码扫描：${htmlPath}；这些通常会被确定性注入层兜住，但如果成片出现跳帧或循环不动，先查这里）`)
  return out
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Find a Chromium-family browser that can be driven headlessly.
 *
 * Search order: environment overrides (`MEDIA_SENSES_BROWSER_PATH`, `EDGE_PATH`,
 * `CHROME_PATH`, `CHROME_BIN`), the standard Windows install locations for
 * Microsoft Edge and Google Chrome (stable, beta and dev channels), the
 * well-known machine paths, then every directory on `PATH`.
 *
 * @returns {Promise<string|undefined>} absolute path to msedge.exe / chrome.exe
 */
export async function findBrowser() {
  const seen = new Set()
  for (const candidate of browserCandidatePaths()) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    if (await isFile(candidate)) return resolve(candidate)
  }
  return undefined
}

/**
 * Render an HTML animation page into an MP4.
 *
 * @param {object} options
 * @param {object} [options.tools] `resolveTools()` result; resolved automatically when omitted.
 * @param {string} options.htmlPath path to the animation HTML page.
 * @param {string} options.output absolute or cwd-relative output MP4 path.
 * @param {number} [options.width=1920] viewport width in pixels (must be even).
 * @param {number} [options.height=1080] viewport height in pixels (must be even).
 * @param {number} [options.fps=30] frames per second (also the time step of renderAt).
 * @param {number} [options.duration=12] length of the segment in seconds.
 * @param {number} [options.startTime=0] first render time in seconds.
 * @param {string} [options.browserPath] explicit msedge.exe/chrome.exe path.
 * @param {string} [options.angle='d3d11'] `--use-angle` value (`d3d11`, `swiftshader`, ...; 'default' omits the flag).
 * @param {string} [options.workDir] scratch directory (profile/frames); a temp dir by default.
 * @param {AbortSignal} [options.signal] aborts between frames and kills the browser.
 * @param {(progress: {frame: number, total: number, time: number, elapsedMs: number}) => void} [options.onProgress]
 *   called after every captured frame (best-effort: a throwing callback cannot break the render).
 * @param {number} [options.crf=20] libx264 quality (0-51, lower is better).
 * @param {string} [options.preset='veryfast'] libx264 preset.
 * @param {boolean} [options.injectDeterminism=true] freeze Date.now/performance.now, reseed Math.random, stop rAF loops in the page.
 * @param {boolean} [options.determinismCheck=true] render the first time point twice and warn if it differs.
 * @param {number} [options.settleFrames=0] extra real rAF frames awaited after renderAt before capture (0, 1 or 2).
 * @param {boolean} [options.keepFrames=false] keep the captured PNG sequence in workDir.
 * @param {number} [options.launchTimeoutMs] browser start timeout.
 * @param {number} [options.readyTimeoutMs] time allowed for the page to expose window.renderAt.
 * @param {number} [options.frameTimeoutMs] time allowed for one renderAt(t) to settle.
 * @param {number} [options.encodeTimeoutMs] ffmpeg encode timeout.
 * @returns {Promise<{
 *   ok: true, output: string, duration: number, width: number, height: number,
 *   fps: number, frames: number, bytes: number, renderSeconds: number,
 *   captureSeconds: number, browser: string,
 *   timings: {launchMs: number, readyMs: number, flushMs: number, screenshotMs: number, encodeSeconds: number},
 *   warnings: string[],
 * }>}
 */
export async function renderAnimation(options = {}) {
  const {
    tools,
    htmlPath,
    output,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    fps = DEFAULT_FPS,
    duration = DEFAULT_DURATION,
    startTime = 0,
    browserPath,
    angle = DEFAULT_ANGLE,
    workDir,
    signal,
    onProgress,
    crf = DEFAULT_CRF,
    preset = DEFAULT_PRESET,
    injectDeterminism = true,
    determinismCheck = true,
    settleFrames = 0,
    settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
    keepFrames = false,
    launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    frameTimeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
    encodeTimeoutMs,
  } = options

  const frameWidth = checkDimension('width', width)
  const frameHeight = checkDimension('height', height)
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) {
    throw new Error(`fps must be a number between 0 and 240 (got ${String(fps)})`)
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`duration must be a positive number of seconds (got ${String(duration)})`)
  }
  if (!Number.isFinite(startTime) || startTime < 0) {
    throw new Error(`startTime must be a non-negative number of seconds (got ${String(startTime)})`)
  }
  if (typeof output !== 'string' || output.trim().length === 0) {
    throw new Error('renderAnimation needs an output path for the encoded MP4')
  }
  if (!Number.isFinite(crf) || crf < 0 || crf > 51) {
    throw new Error(`crf must be a number between 0 and 51 (got ${String(crf)})`)
  }
  if (!X264_PRESETS.has(preset)) {
    throw new Error(`preset "${String(preset)}" is not an x264 preset (${[...X264_PRESETS].join(', ')})`)
  }
  checkAngle(angle)

  const ffmpegTools = tools ?? (await resolveTools())
  if (!ffmpegTools?.ffmpeg || !ffmpegTools?.ffprobe) {
    throw new Error('renderAnimation needs { tools } from resolveTools() with both ffmpeg and ffprobe')
  }

  const absHtml = await resolveAnimationFile(htmlPath)
  const absOutput = isAbsolute(output) ? output : resolve(process.cwd(), output)
  const totalFrames = frameCountFor(duration, fps)
  const expectedDuration = totalFrames / fps
  const warnings = []
  // Name nondeterministic call sites before spending minutes on a render.
  try {
    const source = await readFile(absHtml, 'utf8')
    warnings.push(...determinismWarnings(scanDeterminism(source), absHtml))
  } catch {
    // An unreadable file fails later with a better message from the page load.
  }
  const renderStartedAt = Date.now()

  let session
  let workDirPath = workDir ? resolve(workDir) : undefined
  let ownsWorkDir = false
  let framesDir

  try {
    throwIfAborted(signal)
    if (workDirPath !== undefined) {
      const existing = await stat(workDirPath).catch(() => undefined)
      if (existing !== undefined && !existing.isDirectory()) {
        throw new Error(`workDir points at an existing file, not a directory: ${workDirPath}`)
      }
      await mkdir(workDirPath, { recursive: true })
    } else {
      workDirPath = await makeWorkDir('media-senses-html-render')
      ownsWorkDir = true
    }

    framesDir = join(workDirPath, 'frames')
    await rm(framesDir, { recursive: true, force: true })
    await mkdir(framesDir, { recursive: true })

    session = await openAnimationSession({
      htmlPath: absHtml,
      width: frameWidth,
      height: frameHeight,
      browserPath,
      angle,
      workDir: workDirPath,
      signal,
      injectDeterminism,
      settleFrames,
      settleTimeoutMs,
      launchTimeoutMs,
      readyTimeoutMs,
      frameTimeoutMs,
    })
    warnings.push(...session.startupWarnings)
    if (session.webgl !== undefined && session.webgl.ok !== true) {
      warnings.push(
        'the browser could not create a WebGL context' +
          (session.webgl.reason ? ` (${session.webgl.reason})` : '') +
          '; Three.js/WebGL animations will render blank. Retry with angle: "swiftshader" if the page needs WebGL.',
      )
    }

    // Repeatability check: the skill requires frame N of two runs to be identical.
    if (determinismCheck) {
      const checkTime = roundTime(startTime)
      const first = await session.capture(checkTime)
      const second = await session.capture(checkTime)
      if (!first.equals(second)) {
        warnings.push(
          `frames are not repeatable: rendering t=${formatSeconds(checkTime)}s twice produced different PNGs ` +
            `(${first.length} vs ${second.length} bytes). The page may use entropy that the determinism injection ` +
            'does not control (crypto, Date constructor, CSS transitions, GPU state).',
        )
      }
    }

    const captureStartedAt = Date.now()
    const flatThreshold = Math.max(
      BLANK_FRAME_MIN_BYTES,
      Math.round((frameWidth * frameHeight) / BLANK_FRAME_BYTES_PER_PIXEL),
    )
    const uniqueHashes = new Set()
    let suspiciousFrames = 0
    let firstFrameSuspicious = false
    let firstFrameBytes = 0
    let totalPngBytes = 0

    for (let index = 0; index < totalFrames; index += 1) {
      throwIfAborted(signal)
      const time = roundTime(startTime + index / fps)
      const png = await session.capture(time)
      if (png.length === 0) {
        throw new Error(`the browser returned a zero-byte frame for t=${formatSeconds(time)}s; the frame cannot be encoded`)
      }
      if (index === 0) {
        firstFrameBytes = png.length
        firstFrameSuspicious = png.length < flatThreshold
      }
      if (png.length < flatThreshold) suspiciousFrames += 1
      totalPngBytes += png.length
      uniqueHashes.add(createHash('sha1').update(png).digest('hex'))
      await writeFile(join(framesDir, `f${String(index + 1).padStart(5, '0')}.png`), png)
      reportProgress(onProgress, {
        frame: index + 1,
        total: totalFrames,
        time,
        elapsedMs: Date.now() - renderStartedAt,
      })
      // Give the Host process a turn even when a full render takes minutes.
      await new Promise((resolveYield) => setImmediate(resolveYield))
    }
    const captureSeconds = (Date.now() - captureStartedAt) / 1000

    if (suspiciousFrames === totalFrames) {
      throw new Error(
        `all ${totalFrames} captured frame(s) look blank: every PNG was smaller than ${flatThreshold} bytes ` +
          `at ${frameWidth}x${frameHeight} (first frame was ${firstFrameBytes} bytes). ` +
          `The page did not paint. Check that window.renderAt(t) draws synchronously for t=${formatSeconds(startTime)}s ` +
          `and that the animation is not gated behind a requestAnimationFrame loop in ?export=1 mode: ${absHtml}` +
          (session.webgl?.ok === true
            ? ' If the page draws with WebGL/Three.js and the browser used ANGLE, retry with angle: "swiftshader".'
            : ''),
      )
    }
    if (suspiciousFrames > 0) {
      warnings.push(
        `${suspiciousFrames} of ${totalFrames} frame(s) look blank (PNG smaller than ${flatThreshold} bytes for ` +
          `${frameWidth}x${frameHeight}); this is expected for fades to or from black but may indicate a paint failure.`,
      )
      if (firstFrameSuspicious) {
        warnings.push(
          `the first frame (t=${formatSeconds(startTime)}s, ${firstFrameBytes} bytes) looks blank; ` +
            'if the animation should start with content, check window.renderAt(startTime) and the first-frame draw.',
        )
      }
    }
    if (totalFrames > 1 && uniqueHashes.size === 1) {
      warnings.push(
        `all ${totalFrames} frames are byte-identical; window.renderAt(t) may not depend on t, ` +
          'or the browser may be reusing a stale surface.',
      )
    }
    if (session.stats.flushFailures > 0) {
      warnings.push(
        `${session.stats.flushFailures} of ${totalFrames} 1x1 flush screenshot(s) failed; WebGL/ANGLE pages may ` +
          'produce a black frame at those time points.',
      )
    }

    const encoded = await encodeFrames({
      tools: ffmpegTools,
      workDir: workDirPath,
      fps,
      crf,
      preset,
      totalFrames,
      expectedDuration,
      timeoutMs: encodeTimeoutMs ?? Math.max(DEFAULT_ENCODE_TIMEOUT_MS, Math.ceil(expectedDuration) * 60_000),
      signal,
      warnings,
    })

    await mkdir(dirname(absOutput), { recursive: true })
    await moveFile(encoded.tempPath, absOutput)
    const outputInfo = await stat(absOutput)
    if (!outputInfo.isFile() || outputInfo.size === 0) {
      throw new Error(`the encoded MP4 is empty after moving it into place: ${absOutput}`)
    }

    const durationSeconds = encoded.probedDuration > 0 ? encoded.probedDuration : expectedDuration
    if (encoded.probedDuration > 0 && Math.abs(encoded.probedDuration - expectedDuration) > Math.max(0.05, 2 / fps)) {
      warnings.push(
        `the encoded duration ${encoded.probedDuration.toFixed(3)}s differs from ${expectedDuration.toFixed(3)}s ` +
          `(${totalFrames} frames at ${fps}fps); the file may have lost frames.`,
      )
    }
    if (session.pageErrors.length > 0) {
      warnings.push(
        `the page logged ${session.pageErrors.length} error(s) while rendering, e.g.: ` +
          session.pageErrors.slice(-2).join(' | '),
      )
    }

    return {
      ok: true,
      output: absOutput,
      duration: round3(durationSeconds),
      width: frameWidth,
      height: frameHeight,
      fps,
      frames: totalFrames,
      bytes: outputInfo.size,
      renderSeconds: round3((Date.now() - renderStartedAt) / 1000),
      captureSeconds: round3(captureSeconds),
      totalPngBytes,
      browser: session.browserPath,
      timings: {
        launchMs: session.timings.launchMs,
        readyMs: session.timings.readyMs,
        flushMs: Math.round(session.timings.flushMs),
        screenshotMs: Math.round(session.timings.screenshotMs),
        encodeSeconds: round3(encoded.encodeSeconds),
      },
      warnings,
    }
  } finally {
    if (session !== undefined) {
      try {
        await session.close()
      } catch {
        // Browser teardown is best-effort; the render error (if any) matters more.
      }
    }
    if (framesDir !== undefined && !keepFrames) {
      try {
        await rm(framesDir, { recursive: true, force: true })
      } catch {
        // Leftover frames are harmless and the caller's workDir may be locked.
      }
    }
    if (workDirPath !== undefined && ownsWorkDir) {
      await removeWorkDir(workDirPath)
    } else if (workDirPath !== undefined && !keepFrames) {
      try {
        await rm(join(workDirPath, 'render.mp4'), { force: true })
      } catch {
        // Ignore: the temp MP4 is either moved or already gone.
      }
    }
  }
}

/**
 * Open a headless browser, load one animation page, and expose a per-frame
 * capture function. This is the low-level half of {@link renderAnimation}; it is
 * exported because callers that render several segments from the same page (for
 * example a long video split into chunks) can reuse one browser, and because
 * tests use it to compare two captures of the same time point.
 *
 * One browser process = one tab: this session never opens extra targets. To
 * parallelise renders, open several sessions instead.
 *
 * @param {object} options
 * @param {string} options.htmlPath animation HTML page.
 * @param {number} [options.width=1920] viewport width (even).
 * @param {number} [options.height=1080] viewport height (even).
 * @param {string} [options.browserPath] explicit browser executable.
 * @param {string} [options.angle='d3d11'] `--use-angle` value; 'default' omits the flag.
 * @param {string} [options.workDir] scratch directory; a temp dir by default (removed on close).
 * @param {AbortSignal} [options.signal] abort signal checked before every capture.
 * @param {boolean} [options.injectDeterminism=true] freeze page clocks, seed Math.random, stop rAF loops.
 * @param {number} [options.settleFrames=0] extra real rAF frames awaited after renderAt before the screenshot.
 * @param {number} [options.launchTimeoutMs] browser start timeout.
 * @param {number} [options.readyTimeoutMs] time allowed for window.renderAt to appear.
 * @param {number} [options.frameTimeoutMs] time allowed for one renderAt(t) to settle.
 * @returns {Promise<{url: string, htmlPath: string, browserPath: string, width: number,
 *   height: number, readyMs: number, startupWarnings: string[],
 *   webgl: {ok: boolean, renderer?: string, reason?: string}|undefined,
 *   capture: (time: number) => Promise<Buffer>, close: () => Promise<void>,
 *   pageErrors: string[], stats: {frames: number, captureMs: number, flushMs: number,
 *   screenshotMs: number, flushFailures: number}}>}
 */
export async function openAnimationSession(options = {}) {
  if (typeof fetch !== 'function' || typeof globalThis.WebSocket !== 'function') {
    throw new Error(
      `HTML animation rendering needs Node.js 22+ for the global fetch/WebSocket APIs; this process is ` +
        `${process.version}. Upgrade Node.js or render with a newer Host process.`,
    )
  }
  const {
    htmlPath,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    browserPath,
    angle = DEFAULT_ANGLE,
    workDir,
    signal,
    injectDeterminism = true,
    settleFrames = 0,
    settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
    launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    frameTimeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
  } = options

  const frameWidth = checkDimension('width', width)
  const frameHeight = checkDimension('height', height)
  checkAngle(angle)
  const absHtml = await resolveAnimationFile(htmlPath)
  throwIfAborted(signal)
  const browser = await resolveBrowserPath(browserPath)

  const effectiveWorkDir = workDir ? resolve(workDir) : await makeWorkDir('media-senses-html-session')
  const ownsWorkDir = !workDir
  const profileDir = join(effectiveWorkDir, 'profile')
  const startupWarnings = []
  const captureStats = { frames: 0, captureMs: 0, flushMs: 0, screenshotMs: 0, flushFailures: 0 }
  const setupStartedAt = Date.now()

  let launched
  let client
  let closed = false

  /** Kill the browser process and delete its private profile. Never throws. */
  const shutdownBrowser = async () => {
    try {
      await stopBrowser(launched, client)
    } catch {
      // Kill failures must not mask the original error.
    }
    client = undefined
    launched = undefined
    await removeDirectory(profileDir)
  }

  /** Full teardown: browser, profile, and (when we created it) the work dir. */
  const cleanup = async () => {
    await shutdownBrowser()
    if (ownsWorkDir) await removeDirectory(effectiveWorkDir)
  }

  /**
   * One browser launch + page-attach + contract handshake. Split out of the
   * public function so a transient startup failure (profile lock, browser crash
   * during startup) can be retried with a brand-new browser process.
   */
  const setupSession = async () => {
    launched = await launchBrowser({
      browser,
      width: frameWidth,
      height: frameHeight,
      profileDir,
      angle,
      launchTimeoutMs,
    })
    throwIfAborted(signal)

    const pageTarget = await discoverPageTarget(launched, {
      timeoutMs: Math.min(20_000, Math.max(10_000, readyTimeoutMs)),
      signal,
    })
    client = await CdpClient.connect(pageTarget.webSocketDebuggerUrl, {
      timeoutMs: 15_000,
      closeHint: () => describeBrowserState(launched),
    })

    await client.send('Page.enable', {}, 10_000)
    await client.send('Runtime.enable', {}, 10_000)
    // Log domain carries browser-side ("net::ERR_*", CORS) diagnostics; it is
    // optional, so a browser that refuses it must not fail the render.
    await client.send('Log.enable', {}, 10_000).catch(() => undefined)
    const diagnostics = attachPageDiagnostics(client)
    attachJavaScriptDialogHandler(client)

    // Deterministic runtime: the page must see a clock that only moves when we
    // move it, and a Math.random stream that restarts on every frame. Without
    // this, CSS/JS timers race renderAt(t) and the repeatability check fails.
    if (injectDeterminism) {
      try {
        await client.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: determinismInjectionSource() },
          10_000,
        )
      } catch (error) {
        startupWarnings.push(
          `could not install the determinism script; frames may not be repeatable: ${error.message}`,
        )
      }
    }

    await client.send(
      'Emulation.setDeviceMetricsOverride',
      { width: frameWidth, height: frameHeight, deviceScaleFactor: 1, mobile: false },
      10_000,
    )

    const url = exportUrl(absHtml)
    const loadEvent = client.waitForEvent('Page.loadEventFired', Math.max(10_000, readyTimeoutMs))
    const navigation = await client.send('Page.navigate', { url }, 20_000)
    if (navigation?.errorText) {
      throw new Error(`the browser could not open the animation page (${navigation.errorText}): ${url}`)
    }
    const loadFired = await loadEvent.then(() => true).catch(() => false)
    if (!loadFired) {
      startupWarnings.push(
        `the page load event did not fire within ${Math.max(10_000, readyTimeoutMs)}ms; continuing because the ` +
          'export contract only requires window.renderAt(t)',
      )
    }

    await waitForRenderAt(client, {
      htmlPath: absHtml,
      url,
      timeoutMs: readyTimeoutMs,
      signal,
      diagnostics,
    })
    throwIfAborted(signal)

    const webgl = await probeWebgl(client)

    const session = {
      url,
      htmlPath: absHtml,
      browserPath: browser,
      width: frameWidth,
      height: frameHeight,
      readyMs: Date.now() - setupStartedAt,
      startupWarnings,
      webgl,
      timings: {
        launchMs: launched.launchMs,
        readyMs: Date.now() - setupStartedAt,
        get flushMs() {
          return captureStats.flushMs
        },
        get screenshotMs() {
          return captureStats.screenshotMs
        },
      },
      get pageErrors() {
        return diagnostics.errors.slice()
      },
      get stats() {
        return { ...captureStats }
      },
      async capture(time) {
        if (closed) throw new Error('the animation session is already closed')
        if (typeof time !== 'number' || !Number.isFinite(time)) {
          throw new Error(`capture time must be a finite number of seconds (got ${String(time)})`)
        }
        throwIfAborted(signal)
        const captureStartedAt = Date.now()
        const png = await captureFrame(client, {
          time,
          width: frameWidth,
          height: frameHeight,
          settleFrames,
          settleTimeoutMs,
          timeoutMs: frameTimeoutMs,
          stats: captureStats,
        })
        captureStats.frames += 1
        captureStats.captureMs += Date.now() - captureStartedAt
        return png
      },
      async close() {
        if (closed) return
        closed = true
        await cleanup()
      },
    }
    return session
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await setupSession()
    } catch (error) {
      await shutdownBrowser()
      // A browser that died or refused its DevTools socket during startup is
      // usually a transient host problem (profile lock, antivirus scan, GPU
      // process crash). Timeouts are not retried: they would just double the wait.
      if (attempt === 1 && isTransientSetupFailure(error)) {
        startupWarnings.push(
          `the first browser setup attempt failed (${oneLine(error.message)}); retrying with a fresh browser process`,
        )
        await sleep(250)
        continue
      }
      await cleanup()
      throw error
    }
  }
  await cleanup()
  throw new Error('the headless browser could not be started')
}

/* -------------------------------------------------------------------------- */
/* Browser discovery and launch                                                */
/* -------------------------------------------------------------------------- */

/**
 * Candidate browser executables, best first. Environment overrides come first so
 * a tests/CI setup can pin one binary; the hard-coded paths cover the documented
 * machine facts even when the environment variables are missing.
 *
 * @returns {string[]}
 */
function browserCandidatePaths() {
  const candidates = []
  const env = process.env
  const overrides = [env.MEDIA_SENSES_BROWSER_PATH, env.EDGE_PATH, env.CHROME_PATH, env.CHROME_BIN]
  for (const value of overrides) {
    if (typeof value === 'string' && value.trim().length > 0) candidates.push(value.trim())
  }

  if (!IS_WINDOWS) {
    for (const path of [
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]) {
      candidates.push(path)
    }
    for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
      for (const name of ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
        candidates.push(join(dir, name))
      }
    }
    return candidates
  }

  const edgeRelative = [
    'Microsoft\\Edge\\Application\\msedge.exe',
    'Microsoft\\Edge Beta\\Application\\msedge.exe',
    'Microsoft\\Edge Dev\\Application\\msedge.exe',
  ]
  const chromeRelative = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Google\\Chrome Beta\\Application\\chrome.exe',
    'Google\\Chrome Dev\\Application\\chrome.exe',
    'Google\\Chrome SxS\\Application\\chrome.exe',
  ]
  const programRoots = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.ProgramW6432].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
  for (const root of programRoots) {
    for (const relative of [...edgeRelative, ...chromeRelative]) candidates.push(join(root, relative))
  }
  if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0) {
    for (const relative of [...edgeRelative, ...chromeRelative]) candidates.push(join(env.LOCALAPPDATA, relative))
  }
  // Documented machine facts: these two paths exist on the target Windows host.
  candidates.push(
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  )
  for (const dir of (env.PATH ?? '').split(';').filter(Boolean)) {
    for (const name of ['msedge.exe', 'chrome.exe', 'chromium.exe']) candidates.push(join(dir, name))
  }
  return candidates
}

/**
 * Resolve and validate the browser executable to launch.
 *
 * @param {string|undefined} browserPath explicit override.
 * @returns {Promise<string>}
 */
async function resolveBrowserPath(browserPath) {
  if (typeof browserPath === 'string' && browserPath.trim().length > 0) {
    const trimmed = browserPath.trim()
    const absolute = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed)
    if (!(await isFile(absolute))) {
      throw new Error(
        `browserPath does not point to a browser executable: ${absolute}. ` +
          'Install Microsoft Edge or Google Chrome, or pass browserPath (for example ' +
          '"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe").',
      )
    }
    return absolute
  }
  const found = await findBrowser()
  if (found === undefined) {
    throw new Error(
      'no Microsoft Edge or Google Chrome installation was found. Install either browser, or pass ' +
        'browserPath (for example "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe").',
    )
  }
  return found
}

/**
 * Command-line flags for the headless render browser.
 *
 * `--use-angle=d3d11` is the default because it is the fastest path on Windows
 * desktop; if the host has no usable D3D11 device and frames come out black,
 * pass `angle: 'swiftshader'` (software, busy-spins a core, but works anywhere).
 */
function browserArguments({ width, height, profileDir, angle }) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    // The viewport is set with Emulation.setDeviceMetricsOverride; the window
    // size only keeps the browser from starting with a tiny default surface.
    `--window-size=${width},${height}`,
    '--force-device-scale-factor=1',
    '--disable-features=CalculateNativeWinOcclusion',
    // Animation pages normally live next to their assets (images, JS modules);
    // allow file:// pages to read their own directory without a local server.
    '--allow-file-access-from-files',
    // Keep the capture cadence independent of window-visibility heuristics.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // A fixed colour profile keeps two renders of the same page comparable.
    '--force-color-profile=srgb',
    'about:blank',
  ]
  if (angle !== 'default') args.splice(args.length - 1, 0, `--use-angle=${angle}`)
  return args
}

/**
 * Launch the browser with a private profile and discover its DevTools endpoint.
 *
 * The port is read from `<user-data-dir>/DevToolsActivePort` (first line), which
 * is written once the endpoint is listening and is more reliable than scraping
 * stderr. Parsing the "DevTools listening on ..." line remains as a fallback.
 *
 * @returns {Promise<{child: import('node:child_process').ChildProcess, browser: string,
 *   host: string, port: number, source: string, browserWebSocketUrl: string|undefined,
 *   launchMs: number, exitPromise: Promise<{code: number|null, signal: string|null}>,
 *   exitCode: number|null|undefined, stderrTail: () => string}>}
 */
async function launchBrowser({ browser, width, height, profileDir, angle, launchTimeoutMs }) {
  // A stale profile from a crashed previous run carries a stale
  // DevToolsActivePort; start from a clean directory every time.
  await rm(profileDir, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
  await mkdir(profileDir, { recursive: true })
  let child
  try {
    child = spawn(browser, browserArguments({ width, height, profileDir, angle }), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    throw new Error(`could not start the browser (${browser}): ${error.message}`)
  }

  let stderrText = ''
  let exitInfo
  let launchError
  let endpoint
  const startedAt = Date.now()
  const exitPromise = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal }
      resolveExit(exitInfo)
    })
  })
  child.once('error', (error) => {
    launchError = error
  })
  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString('utf8')
    if (stderrText.length > MAX_BROWSER_LOG_BYTES) stderrText = stderrText.slice(-MAX_BROWSER_LOG_BYTES)
  })
  child.stderr.on('error', () => undefined)

  const deadline = startedAt + launchTimeoutMs
  while (Date.now() < deadline) {
    if (launchError !== undefined) {
      throw new Error(`could not start the browser (${browser}): ${launchError.message}`)
    }
    const active = await readDevToolsActivePort(profileDir)
    if (active !== undefined) {
      endpoint = { port: active.port, browserPath: active.browserPath, source: 'DevToolsActivePort' }
      break
    }
    const fromStderr = extractStderrEndpoint(stderrText)
    if (fromStderr !== undefined) {
      endpoint = { ...fromStderr, source: 'stderr' }
      break
    }
    if (exitInfo !== undefined && exitInfo.code !== 0) {
      throw new Error(
        `the browser exited before it exposed a DevTools endpoint (code ${String(exitInfo.code ?? 'null')}` +
          `${exitInfo.signal ? `, signal ${exitInfo.signal}` : ''})${describeBrowserState({ stderrTail: () => tailLines(stderrText, 12) })}`,
      )
    }
    await sleep(50)
  }
  if (endpoint === undefined) {
    try {
      child.kill()
    } catch {
      // Ignore: the browser failed to start anyway.
    }
    throw new Error(
      `the browser did not expose a DevTools endpoint within ${launchTimeoutMs}ms: ${browser}` +
        describeBrowserState({ stderrTail: () => tailLines(stderrText, 12) }),
    )
  }

  const host = '127.0.0.1'
  const browserWebSocketUrl =
    typeof endpoint.browserPath === 'string' && endpoint.browserPath.startsWith('/devtools/')
      ? `ws://${host}:${endpoint.port}${endpoint.browserPath}`
      : undefined

  return {
    child,
    browser,
    host,
    port: endpoint.port,
    source: endpoint.source,
    browserWebSocketUrl,
    launchMs: Date.now() - startedAt,
    exitPromise,
    get exitCode() {
      return exitInfo?.code
    },
    stderrTail: () => tailLines(stderrText, 12),
  }
}

/** Read the port the browser wrote into its user-data-dir. */
async function readDevToolsActivePort(profileDir) {
  try {
    const text = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')
    const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0)
    const port = Number.parseInt(lines[0] ?? '', 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
    return { port, browserPath: lines[1]?.trim() }
  } catch {
    return undefined
  }
}

/** Parse the "DevTools listening on ws://host:port/..." stderr fallback. */
function extractStderrEndpoint(text) {
  const match = /DevTools listening on ws:\/\/([^\s/:]+):(\d+)(\/\S*)?/u.exec(text)
  if (match === null) return undefined
  const port = Number.parseInt(match[2], 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { port, browserPath: match[3] }
}

/** Best-effort browser log suffix for error messages. */
function describeBrowserState(launched) {
  const tail = launched?.stderrTail?.()
  return tail && tail.length > 0 ? `\nBrowser log tail:\n${tail}` : ''
}

/**
 * Poll the DevTools HTTP endpoint until a page target is published.
 *
 * @returns {Promise<{webSocketDebuggerUrl: string, url?: string}>}
 */
async function discoverPageTarget(launched, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000
  const base = `http://${launched.host}:${launched.port}`
  const startedAt = Date.now()
  let createdFallback = false
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(options.signal)
    try {
      const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) })
      if (response.ok) {
        const targets = await response.json()
        const pages = Array.isArray(targets)
          ? targets.filter((target) => target?.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
          : []
        if (pages.length > 0) {
          // Prefer the blank tab the browser was started with over any popup.
          return pages.find((page) => page.url === 'about:blank') ?? pages[0]
        }
      }
    } catch (error) {
      lastError = error
    }
    // Some builds start without a tab; ask for one before giving up.
    if (!createdFallback && Date.now() - startedAt > Math.min(5000, timeoutMs / 2)) {
      createdFallback = true
      try {
        await fetch(`${base}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(3000) })
      } catch {
        // Older/newer Chromium differ on the verb; the next /json/list poll decides.
      }
    }
    await sleep(100)
  }
  throw new Error(
    `the headless browser did not publish a page target within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${lastError.message})` : '') +
      describeBrowserState(launched),
  )
}

/* -------------------------------------------------------------------------- */
/* Deterministic page runtime (injected before the page's own scripts)         */
/* -------------------------------------------------------------------------- */

/**
 * Source for `Page.addScriptToEvaluateOnNewDocument`.
 *
 * Installs, in the page's main world and before any page script runs:
 * - a virtual clock: `Date.now()` and `performance.now()` only move through
 *   `window.__dshSetTime(t)`, which the renderer calls once per frame;
 * - a reseeded mulberry32 `Math.random` (reseeded by `__dshSetTime`), so the
 *   same `t` produces the same random stream;
 * - a requestAnimationFrame that does not advance with the compositor: the first
 *   callback runs on a microtask (so `await new Promise(r => rAF(r))` inside a
 *   page's renderAt resolves instead of hanging), but chained callbacks are
 *   dropped, which stops a page's own animation loop after one step;
 * - CSS animations/transitions already present at DOMContentLoaded are paused at
 *   time 0, so a page that forgot to stop self-playing CSS still exports
 *   deterministically (renderAt may still set animation.currentTime).
 *
 * The renderer keeps a reference to the real rAF as `window.__dshRealRaf` so its
 * own compositor settle logic is unaffected by the stub.
 *
 * @returns {string}
 */
function determinismInjectionSource() {
  return `;(() => {
  'use strict';
  try {
    var SEED = ${DETERMINISM_SEED} >>> 0;
    var EPOCH = ${VIRTUAL_EPOCH_MS};
    var virtualMs = EPOCH;
    var randomState = SEED >>> 0;
    function reseed() { randomState = SEED >>> 0; }
    function nextRandom() {
      randomState = (randomState + 0x6D2B79F5) >>> 0;
      var t = randomState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    Object.defineProperty(window, '__dshSetTime', {
      configurable: true,
      writable: true,
      value: function (seconds) {
        var numeric = Number(seconds);
        if (!isFinite(numeric)) numeric = 0;
        virtualMs = EPOCH + Math.round(numeric * 1000);
        reseed();
      },
    });
    Object.defineProperty(window, '__dshNow', {
      configurable: true,
      writable: true,
      value: function () { return virtualMs; },
    });
    try { Date.now = function () { return virtualMs; }; } catch (error) {}
    try {
      if (window.performance && typeof window.performance.now === 'function') {
        window.performance.now = function () { return virtualMs - EPOCH; };
      }
    } catch (error) {}
    try { Math.random = nextRandom; } catch (error) {}
    var realRaf = null;
    try {
      if (typeof window.requestAnimationFrame === 'function') {
        realRaf = window.requestAnimationFrame.bind(window);
      }
    } catch (error) {}
    Object.defineProperty(window, '__dshRealRaf', {
      configurable: true,
      writable: true,
      value: realRaf,
    });
    if (realRaf !== null) {
      var rafDepth = 0;
      try {
        window.requestAnimationFrame = function (callback) {
          if (typeof callback !== 'function') return 0;
          if (rafDepth > 0) return 0;
          rafDepth += 1;
          queueMicrotask(function () {
            try { callback(virtualMs - EPOCH); } catch (error) {} finally { rafDepth -= 1; }
          });
          return 1;
        };
        window.cancelAnimationFrame = function () {};
      } catch (error) {}
    }
    function pauseCssAnimations() {
      try {
        if (typeof document.getAnimations !== 'function') return;
        var animations = document.getAnimations();
        for (var index = 0; index < animations.length; index += 1) {
          try {
            animations[index].pause();
            animations[index].currentTime = 0;
          } catch (error) {}
        }
      } catch (error) {}
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', pauseCssAnimations, { once: true });
    } else {
      pauseCssAnimations();
    }
  } catch (error) {}
})();`
}

/* -------------------------------------------------------------------------- */
/* Minimal DevTools Protocol client                                            */
/* -------------------------------------------------------------------------- */

/**
 * A tiny CDP client over Node's global WebSocket: request ids, pending promises,
 * event listeners, timeouts, and close propagation. Deliberately no sessions or
 * domains beyond what the renderer needs.
 */
class CdpClient {
  /**
   * @param {WebSocket} websocket an already-open socket.
   * @param {{closeHint?: () => string}} [options]
   */
  constructor(websocket, options = {}) {
    this.websocket = websocket
    this.nextId = 1
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout, method: string}>} */
    this.pending = new Map()
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map()
    /** @type {Set<Function>} */
    this.closeHooks = new Set()
    this.closed = false
    this.closeDetail = ''
    this.closeHint = options.closeHint
    this.onMessage = (event) => this.handleMessage(event)
    this.onClose = (event) => {
      const code = event?.code
      const reason = event?.reason
      this.handleClose(`DevTools WebSocket closed${code ? ` (code ${code}${reason ? `: ${reason}` : ''})` : ''}`)
    }
    this.onError = (event) => {
      this.handleClose(`DevTools WebSocket error${event?.message ? `: ${event.message}` : ''}`)
    }
    websocket.addEventListener('message', this.onMessage)
    websocket.addEventListener('close', this.onClose)
    websocket.addEventListener('error', this.onError)
  }

  /**
   * Connect to a DevTools WebSocket URL.
   *
   * @param {string} wsUrl
   * @param {{timeoutMs?: number, closeHint?: () => string}} [options]
   * @returns {Promise<CdpClient>}
   */
  static connect(wsUrl, options = {}) {
    if (typeof globalThis.WebSocket !== 'function') {
      throw new Error('the global WebSocket API is unavailable in this Node.js process')
    }
    const timeoutMs = options.timeoutMs ?? 15_000
    return new Promise((resolveConnect, rejectConnect) => {
      let socket
      try {
        socket = new globalThis.WebSocket(wsUrl)
      } catch (error) {
        rejectConnect(new Error(`could not open the DevTools WebSocket (${wsUrl}): ${error.message}`))
        return
      }
      let settled = false
      const finish = (settle, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        settle(value)
      }
      const timer = setTimeout(() => {
        try {
          socket.close()
        } catch {
          // Ignore: we are abandoning the socket.
        }
        finish(rejectConnect, new Error(`the browser did not accept a DevTools WebSocket within ${timeoutMs}ms (${wsUrl})`))
      }, timeoutMs)
      socket.addEventListener(
        'open',
        () => finish(resolveConnect, new CdpClient(socket, options)),
        { once: true },
      )
      socket.addEventListener(
        'error',
        (event) =>
          finish(
            rejectConnect,
            new Error(`could not connect to the DevTools WebSocket (${wsUrl})${event?.message ? `: ${event.message}` : ''}`),
          ),
        { once: true },
      )
      socket.addEventListener(
        'close',
        (event) =>
          finish(
            rejectConnect,
            new Error(`the DevTools WebSocket closed before connecting (code ${String(event?.code ?? 'unknown')})`),
          ),
        { once: true },
      )
    })
  }

  /** Dispatch one CDP message: settle a request or fan out an event. */
  handleMessage(event) {
    let message
    try {
      const raw = typeof event?.data === 'string' ? event.data : Buffer.from(event?.data ?? '').toString('utf8')
      message = JSON.parse(raw)
    } catch {
      return // Ignore malformed frames rather than breaking the render.
    }
    if (message?.id !== undefined && message?.id !== null) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(cdpError(pending.method, message.error))
      else pending.resolve(message.result ?? {})
      return
    }
    if (typeof message?.method !== 'string') return
    const handlers = this.listeners.get(message.method)
    if (handlers === undefined) return
    for (const handler of [...handlers]) {
      try {
        handler(message.params ?? {})
      } catch {
        // A broken listener must not take down the protocol loop.
      }
    }
  }

  /** Fail everything that is waiting when the socket goes away. */
  handleClose(detail) {
    if (this.closed) return
    this.closed = true
    this.closeDetail = detail
    const hint = typeof this.closeHint === 'function' ? this.safeCloseHint() : ''
    const error = new Error(`the headless browser closed the DevTools connection: ${detail}${hint}`)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const hook of [...this.closeHooks]) {
      try {
        hook(error)
      } catch {
        // Ignore broken close hooks.
      }
    }
    this.closeHooks.clear()
    this.listeners.clear()
  }

  /** Call the close hint callback without letting it throw. */
  safeCloseHint() {
    try {
      return this.closeHint() ?? ''
    } catch {
      return ''
    }
  }

  /** Send one CDP request and resolve with its result object. */
  send(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) {
      return Promise.reject(
        new Error(`cannot call ${method}: ${this.closeDetail.length > 0 ? this.closeDetail : 'the DevTools connection is closed'}`),
      )
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        rejectSend(new Error(`the browser did not answer ${method} within ${timeoutMs}ms${this.safeCloseHint()}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer, method })
      try {
        this.websocket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        rejectSend(new Error(`could not send ${method} to the browser: ${error.message}`))
      }
    })
  }

  /** Register a protocol event listener; returns an unsubscribe function. */
  on(method, handler) {
    const handlers = this.listeners.get(method) ?? new Set()
    this.listeners.set(method, handlers)
    handlers.add(handler)
    return () => handlers.delete(handler)
  }

  /** Resolve with the params of the next occurrence of `method`. */
  waitForEvent(method, timeoutMs = 15_000) {
    return new Promise((resolveWait, rejectWait) => {
      if (this.closed) {
        rejectWait(new Error(`DevTools connection is closed; cannot wait for ${method}`))
        return
      }
      const handlers = this.listeners.get(method) ?? new Set()
      this.listeners.set(method, handlers)
      let done = false
      const cleanup = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        handlers.delete(handler)
        this.closeHooks.delete(onClose)
      }
      const timer = setTimeout(() => {
        cleanup()
        rejectWait(new Error(`timed out after ${timeoutMs}ms waiting for ${method}`))
      }, timeoutMs)
      const handler = (params) => {
        cleanup()
        resolveWait(params)
      }
      const onClose = (error) => {
        cleanup()
        rejectWait(error)
      }
      handlers.add(handler)
      this.closeHooks.add(onClose)
    })
  }

  /** Close the socket and fail anything still in flight. */
  close() {
    if (this.closed) {
      try {
        this.websocket.close()
      } catch {
        // Already gone.
      }
      return
    }
    this.closed = true
    this.closeDetail = 'DevTools client closed by the renderer'
    try {
      this.websocket.close()
    } catch {
      // Ignore.
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('DevTools client closed by the renderer'))
    }
    this.pending.clear()
    for (const hook of [...this.closeHooks]) {
      try {
        hook(new Error('DevTools client closed by the renderer'))
      } catch {
        // Ignore.
      }
    }
    this.closeHooks.clear()
  }
}

/** Turn a protocol error object into a readable Error. */
function cdpError(method, detail) {
  const message = detail?.message ?? 'unknown DevTools error'
  const data = typeof detail?.data === 'string' && detail.data.length > 0 ? `: ${detail.data}` : ''
  const error = new Error(`${method} failed: ${message}${data}`)
  if (typeof detail?.code === 'number') error.code = detail.code
  return error
}

/* -------------------------------------------------------------------------- */
/* Page setup and frame capture                                                */
/* -------------------------------------------------------------------------- */

/** Build the `file:///...?export=1` URL for an animation page. */
function exportUrl(htmlPath) {
  const url = pathToFileURL(htmlPath)
  url.search = '?export=1'
  return url.href
}

/**
 * Poll `typeof window.renderAt` until the page exposes the export contract.
 * A page that loads but never defines it must fail with a message that names
 * the file and the missing function.
 */
async function waitForRenderAt(client, options) {
  const { htmlPath, url, timeoutMs, signal, diagnostics } = options
  const startedAt = Date.now()
  let lastError
  for (;;) {
    throwIfAborted(signal)
    const remaining = timeoutMs - (Date.now() - startedAt)
    if (remaining <= 0) break
    try {
      const value = await evaluateValue(client, 'typeof window.renderAt', {
        timeoutMs: Math.min(10_000, Math.max(1000, remaining)),
      })
      if (value === 'function') return
    } catch (error) {
      // "Execution context was destroyed" during navigation is expected here.
      lastError = error
    }
    await sleep(Math.min(100, Math.max(10, remaining)))
  }
  throw contractError({ htmlPath, url, timeoutMs, diagnostics, lastError })
}

/** Error used when the animation page never exposes window.renderAt(t). */
function contractError({ htmlPath, url, timeoutMs, diagnostics, lastError }) {
  const pageErrorLines = diagnostics.summary()
  const lines = [
    `animation page did not expose window.renderAt(t) within ${timeoutMs}ms: ${htmlPath}`,
    `opened as ${url}`,
    'the export contract requires the page to define `window.renderAt = async function (t) { ... }` ' +
      'and to stay idle (no requestAnimationFrame loop) when loaded with ?export=1',
  ]
  if (pageErrorLines.length > 0) {
    lines.push(`page errors:\n- ${pageErrorLines.join('\n- ')}`)
  } else {
    lines.push('the page reported no console errors; check that the inline script actually runs in this mode')
  }
  if (lastError !== undefined) lines.push(`last DevTools error: ${lastError.message}`)
  return new Error(lines.join('\n'))
}

/**
 * Capture one frame: set the page to `time`, flush the compositor, then
 * screenshot the viewport.
 *
 * @returns {Promise<Buffer>} PNG bytes.
 */
async function captureFrame(client, options) {
  const { time, width, height, settleFrames, settleTimeoutMs, timeoutMs, stats } = options
  const expression = frameExpression(time, settleFrames, settleTimeoutMs)
  let response
  try {
    response = await client.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: false },
      timeoutMs,
    )
  } catch (error) {
    throw new Error(
      `the browser did not finish window.renderAt(${formatSeconds(time)}) within ${timeoutMs}ms: ${error.message}`,
    )
  }
  if (response?.exceptionDetails) throw renderAtError(time, response.exceptionDetails)

  // 1x1 JPEG flush: forces the compositor to present the frame that renderAt just
  // drew. Without it, WebGL/ANGLE canvases are frequently captured black because
  // the drawing buffer has not been committed to the surface yet. Measured cost is
  // ~25-35ms per frame at 640x360/1080p (about a third of the per-frame capture
  // time), but it is kept because a black WebGL frame is a silent failure.
  const flushStartedAt = Date.now()
  try {
    await client.send(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } },
      FLUSH_SCREENSHOT_TIMEOUT_MS,
    )
  } catch (error) {
    stats.flushFailures += 1
    if (/closed|destroyed|detached|crashed|not attached|target.*not found/iu.test(error.message)) {
      throw new Error(`the page became unavailable while flushing t=${formatSeconds(time)}s: ${error.message}`)
    }
  }
  stats.flushMs += Date.now() - flushStartedAt

  // Real capture: full viewport clip with captureBeyondViewport so the compositor
  // cannot round the viewport inward and crop the bottom/right edge. PNG must not
  // use optimizeForSpeed (it drops alpha); it is set explicitly to false.
  const screenshotStartedAt = Date.now()
  let screenshot
  let lastError
  for (let attempt = 0; attempt < MAX_FRAME_CAPTURE_ATTEMPTS; attempt += 1) {
    try {
      screenshot = await client.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: true,
          optimizeForSpeed: false,
          clip: { x: 0, y: 0, width: width, height: height, scale: 1 },
        },
        DEFAULT_SCREENSHOT_TIMEOUT_MS,
      )
      if (typeof screenshot?.data === 'string' && screenshot.data.length > 0) break
      lastError = new Error('the browser returned an empty screenshot payload')
    } catch (error) {
      lastError = error
      if (/closed|destroyed|detached|crashed|not attached|target.*not found/iu.test(error.message)) {
        throw new Error(`the page became unavailable while capturing t=${formatSeconds(time)}s: ${error.message}`)
      }
    }
    await sleep(100 * (attempt + 1))
  }
  stats.screenshotMs += Date.now() - screenshotStartedAt
  if (typeof screenshot?.data !== 'string' || screenshot.data.length === 0) {
    throw new Error(`could not capture a frame at t=${formatSeconds(time)}s: ${lastError?.message ?? 'unknown error'}`)
  }
  const png = Buffer.from(screenshot.data, 'base64')
  if (png.length === 0) {
    throw new Error(`the browser returned a zero-byte frame for t=${formatSeconds(time)}s`)
  }
  const header = readPngHeader(png)
  if (header.width !== width || header.height !== height) {
    throw new Error(
      `the browser captured a ${header.width}x${header.height} frame but the renderer asked for ${width}x${height}; ` +
        'the page may override the viewport (Emulation.setDeviceMetricsOverride) or resize itself during render',
    )
  }
  return png
}

/**
 * The in-page expression for one frame:
 *   1. advance the injected virtual clock (Date.now/performance.now, Math.random
 *      reseed) to `t`;
 *   2. await `window.renderAt(t)` (the contract allows it to be async);
 *   3. optionally wait for 1-2 *real* requestAnimationFrame ticks (the injected
 *      stub must not be used here) as extra compositor insurance.
 */
function frameExpression(time, settleFrames, settleTimeoutMs) {
  const settleFramesCount = settleFrames >= 2 ? 2 : settleFrames === 1 ? 1 : 0
  const timeLiteral = String(time)
  const settle =
    settleFramesCount === 0
      ? ''
      : `await Promise.race([${
          settleFramesCount === 1
            ? 'new Promise((resolve) => realRaf(() => resolve()))'
            : 'new Promise((resolve) => realRaf(() => realRaf(() => resolve())))'
        }, new Promise((resolve) => setTimeout(resolve, ${settleTimeoutMs}))]);`
  return (
    '(async () => {' +
    " if (typeof window.renderAt !== 'function') throw new Error(" +
    "'window.renderAt is not a function: the code-animation-prompts export contract is missing');" +
    ' if (typeof window.__dshSetTime === \'function\') window.__dshSetTime(' + timeLiteral + ');' +
    ' const realRaf = (typeof window.__dshRealRaf === \'function\')' +
    ' ? window.__dshRealRaf : (window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null);' +
    ` await window.renderAt(${timeLiteral});` +
    ` ${settle}` +
    ' return true })()'
  )
}

/** Convert a renderAt exceptionDetails payload into a readable error. */
function renderAtError(time, exceptionDetails) {
  const description =
    exceptionDetails?.exception?.description ??
    exceptionDetails?.exception?.value ??
    exceptionDetails?.text ??
    'unknown page error'
  const lines = String(description)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const summary = lines[0] ?? 'unknown page error'
  const detail = lines.slice(0, 6).join('\n')
  return new Error(
    `window.renderAt(${formatSeconds(time)}) threw at t=${formatSeconds(time)}s: ${summary}` +
      (lines.length > 1 ? `\n${detail}` : ''),
  )
}

/** Validate the PNG signature and read the frame dimensions from IHDR. */
function readPngHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) {
    throw new Error(`the browser returned ${buffer?.length ?? 0} bytes where a PNG frame was expected`)
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('the browser returned a screenshot that is not a PNG (bad signature); it cannot be encoded')
  }
  if (buffer.readUInt32BE(12) !== IHDR) {
    throw new Error('the browser returned a PNG without a valid IHDR chunk; it cannot be encoded')
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** Evaluate an expression and return its by-value result. */
async function evaluateValue(client, expression, options = {}) {
  const response = await client.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: options.awaitPromise === true },
    options.timeoutMs ?? 30_000,
  )
  if (response?.exceptionDetails) {
    throw new Error(
      `the page threw while evaluating ${oneLine(expression)}: ` +
        oneLine(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'unknown error'),
    )
  }
  return response?.result?.value
}

/**
 * Check whether the page can create a WebGL context at all, and report the
 * renderer string for diagnostics. A Three.js page on a broken ANGLE backend
 * would otherwise fail as a confusing all-black render.
 */
async function probeWebgl(client) {
  try {
    const value = await evaluateValue(
      client,
      `(() => {
        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          if (!gl) return { ok: false, reason: 'no WebGL context' };
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unknown';
          // Release the probe context so a WebGL-heavy page keeps its context slots.
          const lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
          return { ok: true, renderer };
        } catch (error) {
          return { ok: false, reason: String((error && error.message) || error) };
        }
      })()`,
      { timeoutMs: 10_000 },
    )
    if (value !== null && typeof value === 'object') return value
    return undefined
  } catch {
    return undefined
  }
}

/** Collect page-side errors for the "no renderAt" diagnosis. */
function attachPageDiagnostics(client) {
  const errors = []
  const push = (text) => {
    const line = oneLine(text)
    if (line.length === 0) return
    errors.push(line)
    if (errors.length > MAX_PAGE_ERRORS) errors.shift()
  }
  client.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails
    push(details?.exception?.description ?? details?.text ?? 'page exception')
  })
  client.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error' && params.type !== 'assert') return
    const args = Array.isArray(params.args) ? params.args : []
    push(args.map((arg) => arg?.value ?? arg?.description ?? arg?.type ?? '').join(' '))
  })
  client.on('Log.entryAdded', (params) => {
    if (params.entry?.level === 'error') push(params.entry.text)
  })
  return { errors, summary: () => errors.slice(-3) }
}

/**
 * Dismiss alert/confirm/prompt dialogs. A stray `alert()` in an animation page
 * would otherwise block the renderer's main thread forever.
 */
function attachJavaScriptDialogHandler(client) {
  client.on('Page.javascriptDialogOpening', () => {
    client.send('Page.handleJavaScriptDialog', { accept: true }, 5000).catch(() => undefined)
  })
}

/* -------------------------------------------------------------------------- */
/* Encoding and verification                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Encode the captured PNG sequence into an H.264 MP4 inside the work directory.
 * The temp file is verified before the caller moves it to its final location, so
 * a failed render never leaves a plausible-looking output behind.
 */
async function encodeFrames(options) {
  const { tools, workDir, fps, crf, preset, totalFrames, expectedDuration, timeoutMs, signal, warnings } = options
  const outputName = 'render.mp4'
  // Filtergraph options cannot hold Windows drive-letter colons, so ffmpeg runs
  // with `cwd` in the work directory and relative paths. A UNC work directory
  // cannot be a child-process cwd, so fall back to ordinary absolute arguments
  // (allowed for -i/output: only filtergraph values are colon-sensitive).
  const useAbsolute = IS_WINDOWS && workDir.startsWith('\\\\')
  const inputPattern = useAbsolute ? join(workDir, 'frames', 'f%05d.png') : 'frames/f%05d.png'
  const outputPath = useAbsolute ? join(workDir, outputName) : outputName
  const args = [
    '-hide_banner',
    '-nostats',
    '-loglevel', 'error',
    '-y',
    '-framerate', String(fps),
    '-start_number', '1',
    '-i', inputPattern,
    '-an',
    '-c:v', 'libx264',
    '-preset', preset,
    '-pix_fmt', 'yuv420p',
    '-crf', String(crf),
    '-movflags', '+faststart',
    outputPath,
  ]
  const startedAt = Date.now()
  const result = await run(tools.ffmpeg, args, { cwd: workDir, timeoutMs, signal, maxBuffer: 32 * 1024 * 1024 })
  throwIfAborted(signal)
  if (result.code === 124) {
    throw new Error(
      `ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s while encoding ${totalFrames} PNG frames ` +
        `(${Math.round(expectedDuration)}s at ${fps}fps)`,
    )
  }
  if (result.code !== 0) {
    const detail = tailLines(result.stderr, 12)
    throw new Error(
      `ffmpeg could not encode ${totalFrames} captured frames into H.264 (exit code ${result.code})` +
        (detail.length > 0 ? `:\n${detail}` : ''),
    )
  }
  const tempPath = join(workDir, outputName)
  const info = await stat(tempPath).catch(() => undefined)
  if (info === undefined || !info.isFile() || info.size === 0) {
    throw new Error(`ffmpeg reported success but produced no usable MP4 at ${tempPath}`)
  }
  const encodeSeconds = (Date.now() - startedAt) / 1000

  // Verify with ffprobe before declaring success: a video with the wrong size or
  // no video stream must never be reported as a finished segment.
  let probedDuration = 0
  let probedVideo
  try {
    const probed = summariseProbe(await probe(tools, tempPath, { signal }))
    probedVideo = probed.video[0]
    probedDuration = probed.duration > 0 ? probed.duration : (probedVideo?.duration ?? 0)
    if (probedVideo === undefined) {
      warnings.push('ffprobe found no video stream in the encoded MP4; the file may be unplayable')
    } else {
      if (probedVideo.width !== undefined && (probedVideo.width <= 0 || probedVideo.height <= 0)) {
        warnings.push(`ffprobe reported an unusual frame size ${probedVideo.width}x${probedVideo.height}`)
      }
      if (typeof probedVideo.fps === 'number' && Math.abs(probedVideo.fps - fps) > 0.05) {
        warnings.push(`the encoded video runs at ${probedVideo.fps}fps but ${fps}fps was requested`)
      }
    }
  } catch (error) {
    warnings.push(`could not verify the encoded file with ffprobe: ${error.message}`)
  }

  return { tempPath, probedDuration, probedVideo, encodeSeconds }
}

/* -------------------------------------------------------------------------- */
/* Teardown                                                                    */
/* -------------------------------------------------------------------------- */

/** Close the browser cleanly, then forcibly if needed. Never throws. */
async function stopBrowser(launched, client) {
  if (launched === undefined) return
  const child = launched.child
  let closeRequested = false
  if (client !== undefined) {
    try {
      await client.send('Browser.close', {}, 1500)
      closeRequested = true
    } catch {
      // Not every Chromium build exposes Browser.close on a page connection.
    }
  }
  if (closeRequested && (await waitForExit(launched.exitPromise, 4000))) {
    try {
      client?.close()
    } catch {
      // Ignore.
    }
    return
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill()
    } catch {
      // Ignore.
    }
    if (!(await waitForExit(launched.exitPromise, 4000))) {
      await taskkillTree(child.pid)
      await waitForExit(launched.exitPromise, 2000)
    }
    try {
      client?.close()
    } catch {
      // Ignore.
    }
    return
  }
  // The spawned process is gone (some builds use a launcher) but the browser may
  // still be running under the same user-data-dir: close it over the browser
  // WebSocket so the profile can be deleted and no process leaks.
  if (closeRequested === false && typeof launched.browserWebSocketUrl === 'string') {
    let browserClient
    try {
      browserClient = await CdpClient.connect(launched.browserWebSocketUrl, { timeoutMs: 3000 })
      await browserClient.send('Browser.close', {}, 1500)
    } catch {
      // Browser already gone or unreachable.
    } finally {
      try {
        browserClient?.close()
      } catch {
        // Ignore.
      }
    }
  }
  try {
    client?.close()
  } catch {
    // Ignore.
  }
}

/** Kill a Windows process tree (renderer/GPU children) as a last resort. */
async function taskkillTree(pid) {
  if (!IS_WINDOWS || typeof pid !== 'number' || pid <= 0) return
  await new Promise((resolveKill) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolveKill())
  })
}

/** Resolve true when the process exits within the timeout. */
function waitForExit(exitPromise, timeoutMs) {
  return new Promise((resolveExit) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolveExit(false)
    }, timeoutMs)
    exitPromise.then(() => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveExit(true)
    })
  })
}

/**
 * Delete a directory, retrying while Chromium child processes release their file
 * handles. Best-effort: returns false instead of throwing.
 */
async function removeDirectory(dir, options = {}) {
  const attempts = options.attempts ?? 10
  const delayMs = options.delayMs ?? 200
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 0 })
      return true
    } catch {
      if (attempt === attempts - 1) return false
      await sleep(delayMs)
    }
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* Misc helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Validate an even, positive pixel dimension (H.264/yuv420p needs even sizes). */
function checkDimension(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of pixels (got ${String(value)})`)
  }
  if (value % 2 !== 0) {
    throw new Error(`${name} must be even for H.264/yuv420p output (got ${value})`)
  }
  return value
}

/** Validate the ANGLE backend string passed to --use-angle. */
function checkAngle(angle) {
  if (typeof angle !== 'string' || angle.trim().length === 0) {
    throw new Error(`angle must be a non-empty --use-angle value (got ${String(angle)})`)
  }
  if (!/^[a-z0-9_-]+$/iu.test(angle)) {
    throw new Error(`angle "${angle}" is not a valid --use-angle value`)
  }
  return angle
}

/** Frame count for a duration, with a float guard: ceil(duration * fps). */
function frameCountFor(duration, fps) {
  const exact = duration * fps
  return Math.max(1, Math.ceil(exact - 1e-9))
}

/** Resolve and validate the animation HTML file. */
async function resolveAnimationFile(htmlPath) {
  if (typeof htmlPath !== 'string' || htmlPath.trim().length === 0) {
    throw new Error('renderAnimation needs the path of the animation HTML page (htmlPath)')
  }
  const trimmed = htmlPath.trim()
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed)
  if (!(await isFile(absolute))) {
    throw new Error(`animation HTML page not found: ${absolute}`)
  }
  return absolute
}

/** True when `file` exists and is a regular file. */
async function isFile(file) {
  try {
    const info = await stat(file)
    return info.isFile()
  } catch {
    return false
  }
}

/** Round a time in seconds to microseconds so renderAt gets stable literals. */
function roundTime(seconds) {
  return Math.round(seconds * 1e6) / 1e6
}

/** Format a time for error messages without trailing float noise. */
function formatSeconds(seconds) {
  return String(roundTime(seconds))
}

/** Round to milliseconds for report fields. */
function round3(value) {
  return Math.round(value * 1000) / 1000
}

/** Collapse arbitrary page output to one short line. */
function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300)
}

/** Invoke a user progress callback without letting it break the render. */
function reportProgress(onProgress, info) {
  if (typeof onProgress !== 'function') return
  try {
    onProgress(info)
  } catch {
    // A throwing progress callback is the caller's bug, not the render's.
  }
}

/** True when a setup failure is likely transient and worth one retry. */
function isTransientSetupFailure(error) {
  const message = String(error?.message ?? '')
  // Timeouts mean the host/browser is not coming back on its own: do not retry.
  if (/within \d+ms/iu.test(message)) return false
  return (
    /could not start the browser|browser exited before|closed the DevTools connection|did not accept a DevTools WebSocket|could not connect to the DevTools WebSocket/iu.test(
      message,
    )
  )
}

/** Throw the caller's abort reason (or a clean AbortError) when aborted. */
function throwIfAborted(signal) {
  if (signal?.aborted !== true) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  const error = new Error(typeof reason === 'string' && reason.length > 0 ? reason : 'HTML animation render aborted')
  error.name = 'AbortError'
  throw error
}

/** Sleep for a few milliseconds. */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

/**
 * Move a finished MP4 into place. `rename` fails across volumes; fall back to
 * copy+unlink so a work directory on another drive still works.
 */
async function moveFile(source, destination) {
  try {
    await rename(source, destination)
    return
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error
  }
  await copyFile(source, destination)
  await rm(source, { force: true })
}
