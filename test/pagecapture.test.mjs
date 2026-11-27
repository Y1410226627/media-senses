#!/usr/bin/env node
/**
 * Acceptance tests for the real-page 2.5D capture module (`lib/pagecapture.js`).
 *
 * Run: node test/pagecapture.test.mjs
 *
 * 合成输入为主（不依赖真实网站）：
 *   - buildCaptureScript：可执行 JS、确定性、含 deviceScaleFactor / offsetWidth /
 *     computed style token；在 vm 里用一个假 DOM 真跑一遍，断言 layout 表结构；
 *   - planElementCutouts：hero 4x、普通元素 2x、cdp clipScale、尺寸按 scale 算对、
 *     过滤小元素/整页容器、数量上限、命名去重、畸形输入可读报错；
 *   - layoutToCamera：严格断言 Tx = 960/zoom − cx（Ty 同理）、用 offset 布局尺寸
 *     而不是被 transform 缩放的 rect、zoom 夹取、无元素时回退页面中心、cssZoomZh 讲清
 *     “为什么不能 transform: scale”；
 *   - capturePage：缺页面/缺浏览器时给可读错误而不是崩；
 *   - 本机有 Edge/Chrome 时，对**本地 HTML 文件**真跑一次采集（全页 2x PNG +
 *     layout.json + 元素抠图），并把产物留在 test/fixtures/artifacts/pagecapture/。
 *
 * 若机器上没有浏览器，真实采集那几项会自动跳过（只跑合成与错误路径），
 * 合成测试仍必须全绿。
 */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeWorkDir, removeWorkDir } from '../lib/ffmpeg.js'
import { findBrowser } from '../lib/htmlrender.js'
import {
  PAGE_CAPTURE_DEFAULTS,
  buildCaptureScript,
  capturePage,
  layoutToCamera,
  planElementCutouts,
} from '../lib/pagecapture.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const MODULE_PATH = join(ROOT, 'lib', 'pagecapture.js')
const ARTIFACTS = join(HERE, 'fixtures', 'artifacts', 'pagecapture')
const PNG_MAGIC = '89504e470d0a1a0a'

let passed = 0
let failed = 0
let workDir
const artifactNotes = []

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

function pngDimensions(buffer) {
  assert.ok(buffer.length > 33, 'PNG too small')
  assert.equal(buffer.subarray(0, 8).toString('hex'), PNG_MAGIC, 'not a PNG')
  assert.equal(buffer.subarray(12, 16).toString('latin1'), 'IHDR', 'PNG has no IHDR')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function assertJsonSafe(value, label = 'value') {
  const walk = (item, path) => {
    if (item === null) return
    if (typeof item === 'number') {
      assert.ok(Number.isFinite(item), `${path} is not a finite number (${item})`)
      return
    }
    if (typeof item === 'string' || typeof item === 'boolean') return
    if (Array.isArray(item)) {
      item.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      return
    }
    assert.equal(typeof item, 'object', `${path} has unsupported type ${typeof item}`)
    assert.ok(!(item instanceof Date) && !(item instanceof Map) && !(item instanceof Set), `${path} is not plain data`)
    for (const [key, entry] of Object.entries(item)) {
      assert.notEqual(entry, undefined, `${path}.${key} is undefined`)
      walk(entry, `${path}.${key}`)
    }
  }
  walk(value, label)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} does not survive a JSON round-trip unchanged`)
}

// ---------------------------------------------------------------------------
// Fake DOM used to really execute buildCaptureScript (no jsdom dependency).
// ---------------------------------------------------------------------------

function makeFakeElement(overrides = {}) {
  const element = {
    id: 'hero',
    tagName: 'DIV',
    classList: ['hero'],
    textContent: 'Hero title',
    children: [],
    parentElement: null,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 100, y: 400, width: 300, height: 200 }),
    offsetWidth: 300,
    offsetHeight: 200,
    ...overrides,
  }
  return element
}

function makeFakeComputedStyle() {
  return {
    display: 'block',
    visibility: 'visible',
    position: 'relative',
    fontFamily: 'Arial, sans-serif',
    fontSize: '44px',
    fontWeight: '400',
    lineHeight: '54px',
    letterSpacing: 'normal',
    color: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(255, 51, 102)',
    borderRadius: '18px',
    textAlign: 'left',
    opacity: '1',
    zIndex: 'auto',
    transform: 'none',
    boxShadow: 'none',
  }
}

function makeFakeSandbox(hero, options = {}) {
  const heroList = options.heroList ?? [hero]
  const querySelectorAll = (selector) => {
    if (selector === '.hero' || selector === 'header' || selector === '[role="banner"]') return heroList
    if (selector === 'h1') return []
    return []
  }
  const bodyChildren = options.bodyChildren ?? [hero]
  const documentFake = {
    title: 'Fake test page',
    documentElement: { scrollWidth: 1920, scrollHeight: 2400, clientWidth: 1920, clientHeight: 1080 },
    body: { children: bodyChildren, scrollWidth: 1920, scrollHeight: 2400 },
    styleSheets: [],
    querySelectorAll,
    querySelector: (selector) => querySelectorAll(selector)[0] ?? null,
  }
  const locationFake = { href: 'file:///fake/test-page.html' }
  return {
    window: { innerWidth: 1920, innerHeight: 1080, scrollX: 0, scrollY: 0, devicePixelRatio: 2 },
    document: documentFake,
    location: locationFake,
    getComputedStyle: () => makeFakeComputedStyle(),
    console,
  }
}

async function runCaptureScriptInFakeDom(options = {}) {
  const script = buildCaptureScript({ deviceScaleFactor: 2, ...options.scriptOptions })
  const sandbox = options.sandbox ?? makeFakeSandbox(makeFakeElement())
  const raw = await vm.runInNewContext(script, sandbox, { timeout: 10_000 })
  // vm 里创建的对象是另一个 realm，Node 的 strict deepEqual 会因原型不同判不等；
  // 采集结果本来就要求 JSON 可序列化，先往返一次得到本 realm 的普通对象。
  return { script, result: JSON.parse(JSON.stringify(raw)) }
}

// ---------------------------------------------------------------------------
// Synthetic layout fixtures
// ---------------------------------------------------------------------------

function makeSyntheticLayout() {
  return {
    schema: 'media-senses.page-layout/v1',
    url: 'file:///fake/index.html',
    title: 'Synthetic page',
    deviceScaleFactor: 2,
    devicePixelRatio: 2,
    viewport: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 },
    page: { width: 1920, height: 2400 },
    elements: [
      {
        index: 0,
        selector: '#hero',
        tag: 'div',
        isHero: true,
        visible: true,
        rect: { x: 100, y: 400, width: 300, height: 200 },
        viewportRect: { x: 100, y: 400, width: 300, height: 200 },
        offset: { width: 300, height: 200 },
        style: { fontSize: 44, fontFamily: 'Arial', color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(255, 51, 102)' },
      },
      {
        index: 1,
        selector: '#card',
        tag: 'div',
        isHero: false,
        visible: true,
        rect: { x: 500, y: 800, width: 480, height: 260 },
        viewportRect: { x: 500, y: 800, width: 480, height: 260 },
        offset: { width: 480, height: 260 },
        style: { fontSize: 20 },
      },
    ],
    tokens: { fonts: ['Arial'], fontSizes: [20, 44], colors: ['rgb(255, 255, 255)'], backgrounds: [], radii: [], customProperties: {} },
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await mkdir(ARTIFACTS, { recursive: true })
for (const entry of await readdir(ARTIFACTS)) {
  if (entry.endsWith('.png') || entry.endsWith('.json')) await rm(join(ARTIFACTS, entry), { force: true })
}
workDir = await makeWorkDir('media-senses-pagecapture-test')

try {
  // -------------------------------------------------------------------------
  // buildCaptureScript
  // -------------------------------------------------------------------------
  await check('buildCaptureScript returns an executable, deterministic, self-invoking script', async () => {
    const script = buildCaptureScript({ deviceScaleFactor: 2 })
    assert.equal(typeof script, 'string')
    assert.ok(script.startsWith('(async () =>'), 'script should be a self-invoking async expression')
    assert.ok(script.length > 2000, `script is suspiciously short (${script.length} chars)`)
    // "可执行"：语法层面能作为表达式求值（vm 里还会真跑一次）。
    assert.doesNotThrow(() => new Function(`return (${script})`))
    assert.equal(buildCaptureScript({ deviceScaleFactor: 2 }), script, 'same options must produce the same script')
    assert.doesNotMatch(script, /Date\.now\(/u, 'capture script must not read the wall clock')
    assert.doesNotMatch(script, /Math\.random\(/u, 'capture script must be deterministic')
  })

  await check('buildCaptureScript embeds deviceScaleFactor, layout probes and style-token probes', async () => {
    const script = buildCaptureScript({
      deviceScaleFactor: 3,
      maxElements: 12,
      selectors: ['#hero', 'section.card'],
      heroSelectors: ['[data-capture="hero"]'],
    })
    for (const needle of ['deviceScaleFactor', 'getBoundingClientRect', 'offsetWidth', 'offsetHeight', 'fontFamily', 'fontSize', 'lineHeight', 'borderRadius', 'backgroundColor']) {
      assert.ok(script.includes(needle), `script should contain "${needle}"`)
    }
    assert.ok(script.includes('"deviceScaleFactor":3'), 'script should embed the requested deviceScaleFactor')
    assert.ok(script.includes('"maxElements":12'))
    assert.ok(script.includes('section.card'), 'custom selectors should be embedded')
    assert.ok(script.includes('[data-capture=\\"hero\\"]'), 'custom hero selectors should be embedded')
  })

  await check('buildCaptureScript really executes in a DOM and returns the layout table', async () => {
    const { result } = await runCaptureScriptInFakeDom()
    assert.equal(result.schema, 'media-senses.page-layout/v1')
    assert.equal(result.deviceScaleFactor, 2)
    assert.equal(result.devicePixelRatio, 2)
    assert.deepEqual(result.page, { width: 1920, height: 2400 })
    assert.equal(result.elements.length, 1)
    const hero = result.elements[0]
    assert.equal(hero.selector, '#hero')
    assert.equal(hero.tag, 'div')
    assert.equal(hero.isHero, true)
    assert.deepEqual(hero.rect, { x: 100, y: 400, width: 300, height: 200 })
    assert.deepEqual(hero.offset, { width: 300, height: 200 }, 'offsetWidth/offsetHeight must be captured (layout size)')
    assert.deepEqual(hero.layoutScale, { x: 1, y: 1 })
    assert.equal(hero.style.fontSize, 44)
    assert.equal(hero.style.borderRadius, 18)
    assert.ok(result.tokens.fonts.includes('Arial, sans-serif'))
    assert.ok(result.tokens.fontSizes.includes(44))
    assert.ok(result.tokens.colors.length >= 1)
    assertJsonSafe(result, 'capture script layout')
  })

  await check('buildCaptureScript honours includeText=false / includeStyles=false', async () => {
    const { result } = await runCaptureScriptInFakeDom({ scriptOptions: { includeText: false, includeStyles: false } })
    assert.equal(result.elements[0].text, null)
    assert.deepEqual(result.elements[0].style, {})
  })

  await check('buildCaptureScript marks a hero fallback (largest element) when no hero selector matches', async () => {
    const hero = makeFakeElement()
    const sandbox = makeFakeSandbox(hero)
    const script = buildCaptureScript({ heroSelectors: ['#definitely-not-on-the-page'], deviceScaleFactor: 2 })
    const raw = await vm.runInNewContext(script, sandbox, { timeout: 10_000 })
    const result = JSON.parse(JSON.stringify(raw))
    assert.equal(result.elements.length, 1)
    assert.equal(result.elements[0].isHero, true, 'the largest element should become the hero fallback')
    assert.equal(result.elements[0].heroFallback, true)
  })

  // -------------------------------------------------------------------------
  // planElementCutouts
  // -------------------------------------------------------------------------
  await check('planElementCutouts plans hero 4x and normal 2x, with CDP clipScale for deviceScaleFactor 2', async () => {
    const cutouts = planElementCutouts(makeSyntheticLayout(), {})
    assert.equal(cutouts.length, 2)
    const hero = cutouts[0]
    const card = cutouts[1]
    assert.equal(hero.name, 'hero')
    assert.equal(hero.isHero, true, 'hero must be planned first and flagged')
    assert.equal(hero.scale, 4, 'hero is captured at 4x')
    assert.equal(hero.clipScale, 2, 'CDP clip.scale = 4 / deviceScaleFactor 2')
    assert.equal(hero.pixelWidth, 1200)
    assert.equal(hero.pixelHeight, 800)
    assert.deepEqual(hero.rect, { x: 100, y: 400, width: 300, height: 200 })
    assert.equal(card.scale, 2, 'regular elements are captured at the full-page 2x')
    assert.equal(card.clipScale, 1)
    assert.equal(card.pixelWidth, 960)
    assert.equal(card.pixelHeight, 520)
    assert.equal(hero.selector, '#hero')
    assertJsonSafe(cutouts, 'cutout plan')
  })

  await check('planElementCutouts respects custom heroScale/elementScale/deviceScaleFactor', async () => {
    const cutouts = planElementCutouts(makeSyntheticLayout(), { deviceScaleFactor: 3, heroScale: 6, elementScale: 3 })
    assert.equal(cutouts[0].scale, 6)
    assert.equal(cutouts[0].clipScale, 2, '6x output at DSF 3 -> clip.scale 2')
    assert.equal(cutouts[0].pixelWidth, 1800)
    assert.equal(cutouts[1].scale, 3)
    assert.equal(cutouts[1].clipScale, 1)
    assert.equal(cutouts[1].pixelWidth, 1440)
    assert.equal(cutouts[1].pixelHeight, 780)
  })

  await check('planElementCutouts filters tiny/full-page elements, caps count and de-duplicates names', async () => {
    const layout = makeSyntheticLayout()
    layout.elements = [
      { index: 0, selector: '#hero', tag: 'div', isHero: true, visible: true, rect: { x: 100, y: 100, width: 300, height: 200 }, offset: { width: 300, height: 200 } },
      { index: 1, selector: '#page', tag: 'div', isHero: false, visible: true, rect: { x: 0, y: 0, width: 1920, height: 2400 }, offset: { width: 1920, height: 2400 } },
      { index: 2, selector: '#tiny', tag: 'span', isHero: false, visible: true, rect: { x: 10, y: 10, width: 8, height: 8 }, offset: { width: 8, height: 8 } },
      { index: 3, selector: '.a', tag: 'div', isHero: false, visible: true, rect: { x: 0, y: 300, width: 600, height: 300 }, offset: { width: 600, height: 300 } },
      { index: 4, selector: '.b', tag: 'div', isHero: false, visible: true, rect: { x: 0, y: 700, width: 500, height: 250 }, offset: { width: 500, height: 250 } },
    ]
    const cutouts = planElementCutouts(layout, { maxCutouts: 2 })
    assert.equal(cutouts.length, 2, 'maxCutouts must cap the plan')
    assert.equal(cutouts[0].name, 'hero')
    assert.equal(cutouts[1].rect.width, 600, 'the largest remaining element comes next')
    assert.ok(!cutouts.some((cutout) => cutout.selector === '#tiny'), 'elements below minCutoutPx are skipped')
    assert.ok(!cutouts.some((cutout) => cutout.selector === '#page'), 'full-page containers are covered by the full screenshot')
    const names = cutouts.map((cutout) => cutout.name)
    assert.equal(new Set(names).size, names.length, 'cutout names must be unique')
  })

  await check('planElementCutouts handles empty layouts and rejects malformed ones with a readable error', () => {
    assert.deepEqual(planElementCutouts({ elements: [] }, {}), [])
    assert.deepEqual(planElementCutouts({ elements: [], page: { width: 0, height: 0 } }, {}), [])
    assert.throws(() => planElementCutouts({ nope: true }, {}), /elements/u)
    assert.throws(() => planElementCutouts(null, {}), /elements/u)
  })

  // -------------------------------------------------------------------------
  // layoutToCamera
  // -------------------------------------------------------------------------
  await check('layoutToCamera implements Tx = 960/zoom − cx and Ty = 540/zoom − cy', async () => {
    const camera = layoutToCamera(makeSyntheticLayout(), {})
    assert.equal(camera.width, 1920)
    assert.equal(camera.height, 1080)
    // hero: rect centre (250, 500), layout size 300x200 -> fit zoom 5.4, clamped by maxZoom 4.
    assert.equal(camera.zoom, 4)
    const cx = 100 + 300 / 2
    const cy = 400 + 200 / 2
    assert.ok(Math.abs(camera.tx - (1920 / 2 / camera.zoom - cx)) < 1e-3, `tx=${camera.tx} does not match Tx = 960/zoom − cx`)
    assert.ok(Math.abs(camera.ty - (1080 / 2 / camera.zoom - cy)) < 1e-3, `ty=${camera.ty} does not match Ty = 540/zoom − cy`)
    assert.equal(camera.tx, -10)
    assert.equal(camera.ty, -365)
    assert.deepEqual(camera.target, { selector: '#hero', cx: 250, cy: 500, layoutWidth: 300, layoutHeight: 200, isHero: true })
    assertJsonSafe(camera, 'camera')
  })

  await check('layoutToCamera uses offset layout size, not the transform-scaled rect size', async () => {
    const layout = makeSyntheticLayout()
    // rect is 2x bigger than offset => the element is visually scaled by transform.
    layout.elements[0].rect = { x: 0, y: 0, width: 1600, height: 1200 }
    layout.elements[0].offset = { width: 800, height: 600 }
    const camera = layoutToCamera(layout, {})
    // offset-based fit: min(1920/800, 1080/600) = 1.8 (rect-based would be 1.2/0.9).
    assert.ok(Math.abs(camera.zoom - 1.8) < 1e-6, `zoom ${camera.zoom} should come from offsetWidth/offsetHeight (1.8)`)
    const cx = 800
    const cy = 600
    assert.ok(Math.abs(camera.tx - (960 / camera.zoom - cx)) < 1e-3)
    assert.ok(Math.abs(camera.ty - (540 / camera.zoom - cy)) < 1e-3)
  })

  await check('layoutToCamera clamps zoom, honours explicit targets and falls back to the page centre', async () => {
    const layout = makeSyntheticLayout()
    const tiny = layoutToCamera(layout, { target: { selector: '#card' } })
    assert.equal(tiny.target.selector, '#card')
    assert.equal(tiny.zoom, 4, 'a small card is clamped to maxZoom')
    const byIndex = layoutToCamera(layout, { target: 0 })
    assert.equal(byIndex.target.selector, '#hero')
    const noTarget = layoutToCamera(layout, { target: '#missing' })
    assert.equal(noTarget.target.selector, '#hero', 'unknown target falls back to the hero')

    const empty = layoutToCamera({ page: { width: 1000, height: 800 }, elements: [] }, {})
    assert.equal(empty.target, null)
    assert.ok(Math.abs(empty.zoom - Math.min(1920 / 1000, 1080 / 800)) < 1e-3)
    assert.ok(Math.abs(empty.tx - (960 / empty.zoom - 500)) < 1e-3)
    assert.ok(Math.abs(empty.ty - (540 / empty.zoom - 400)) < 1e-3)

    const zoomed = layoutToCamera(layout, { maxZoom: 2 })
    assert.equal(zoomed.zoom, 2)
    const huge = layoutToCamera(layout, { target: 0, maxZoom: 8, minZoom: 0.5 })
    assert.ok(huge.zoom > 0 && huge.zoom <= 8)
  })

  await check('layoutToCamera explains CSS zoom vs transform: scale and the coordinate conversion', async () => {
    const camera = layoutToCamera(makeSyntheticLayout(), {})
    const explanation = camera.cssZoomZh
    assert.ok(explanation.includes('CSS zoom'), 'cssZoomZh should name CSS zoom')
    assert.ok(explanation.includes('transform: scale'), 'cssZoomZh should warn against transform: scale')
    assert.ok(explanation.includes('Chromium'), 'cssZoomZh should name the rasterization cause')
    assert.ok(explanation.includes('1920'), 'cssZoomZh should mention the 1920 layout width')
    assert.ok(explanation.includes('Tx = 960/zoom − cx'), 'cssZoomZh should document Tx = 960/zoom − cx')
    assert.ok(explanation.includes('跑焦点'), 'cssZoomZh should mention the lost-focus consequence')
    assertJsonSafe(layoutToCamera(makeSyntheticLayout(), { width: 1280, height: 720 }), 'camera 1280')
  })

  // -------------------------------------------------------------------------
  // capturePage error paths (no browser needed / browser missing)
  // -------------------------------------------------------------------------
  await check('capturePage rejects a missing page file with a readable error, before starting a browser', async () => {
    await assert.rejects(() => capturePage({ htmlPath: join(workDir, 'does-not-exist.html') }), /页面文件不存在/u)
    await assert.rejects(() => capturePage({}), /htmlPath/u)
  })

  await check('capturePage rejects an unavailable browser with a readable error instead of crashing', async () => {
    const htmlPath = join(workDir, 'tiny-page.html')
    await writeFile(htmlPath, '<!doctype html><html><body><h1>Hi</h1></body></html>', 'utf8')
    const missingBrowser = join(workDir, 'missing-browser', 'msedge.exe')
    await assert.rejects(
      () => capturePage({ htmlPath, outDir: join(workDir, 'out'), browserPath: missingBrowser }),
      (error) => /没有可用的无头浏览器|browserPath/u.test(error.message) && /浏览器|browserPath|Edge/u.test(error.message),
    )
  })

  // -------------------------------------------------------------------------
  // REAL capture of a local HTML page (skipped only when no browser exists)
  // -------------------------------------------------------------------------
  const realBrowser = await findBrowser().catch(() => undefined)
  if (realBrowser === undefined) {
    console.log('SKIP  real browser capture (no Microsoft Edge / Google Chrome found on this machine)')
  } else {
    const htmlPath = join(workDir, 'real-page.html')
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { width: 1920px; background: #0b1220; font-family: Arial, sans-serif; }
  .page { position: relative; width: 1920px; height: 1600px; }
  .hero { position: absolute; left: 160px; top: 240px; width: 480px; height: 270px; background: #ff3366;
          border-radius: 24px; color: #fff; font-size: 64px; line-height: 76px; padding: 24px; }
  .card { position: absolute; left: 900px; top: 520px; width: 600px; height: 300px; background: #2266ff;
          border-radius: 12px; color: #fff; font-size: 28px; line-height: 36px; padding: 20px; }
  :root { --accent: #ff3366; --page-pad: 32px; }
</style></head><body><div class="page">
  <div class="hero" id="hero" data-capture="hero">真实页面 Hero</div>
  <div class="card" id="card">A real card with text content</div>
</div></body></html>`
    await writeFile(htmlPath, html, 'utf8')
    let capture
    let layoutFile
    let heroCutout
    let cardCutout

    await check('REAL capturePage: full-page 2x PNG + layout.json + element cutouts from a local HTML page', async () => {
      capture = await capturePage({
        htmlPath,
        outDir: ARTIFACTS,
        settleMs: 80,
        viewportWidth: 1920,
        viewportHeight: 1080,
        deviceScaleFactor: 2,
        heroScale: 4,
        elementScale: 2,
      })
      assert.equal(capture.browser, realBrowser)
      assert.equal(capture.url, pathToFileURL(htmlPath).href)
      assert.equal(capture.viewport.deviceScaleFactor, 2)
      assert.equal(capture.page.width, 1920)
      assert.equal(capture.page.height, 1600)
      const fullInfo = await stat(capture.fullPngPath)
      assert.ok(fullInfo.size > 10_000, `full-page PNG too small (${fullInfo.size} bytes)`)
      const fullPng = pngDimensions(await readFile(capture.fullPngPath))
      assert.equal(fullPng.width, 3840, 'full page is captured at 2x device pixels')
      assert.equal(fullPng.height, 3200, 'full page is captured at 2x device pixels')
      const layoutInfo = await stat(capture.layoutPath)
      assert.ok(layoutInfo.size > 500)
      assertJsonSafe(capture, 'capturePage result')
    })

    await check('REAL capturePage: layout.json contains the element coordinate table and style tokens', async () => {
      layoutFile = JSON.parse(await readFile(capture.layoutPath, 'utf8'))
      assert.equal(layoutFile.schema, 'media-senses.page-layout/v1')
      assert.equal(layoutFile.deviceScaleFactor, 2)
      assert.equal(layoutFile.page.width, 1920)
      assert.equal(layoutFile.page.height, 1600)
      assert.ok(layoutFile.elements.length >= 3, `expected hero + page + card, got ${layoutFile.elements.length}`)
      const hero = layoutFile.elements.find((element) => element.isHero === true)
      assert.ok(hero !== undefined, 'a hero element should be flagged')
      assert.equal(hero.selector, '#hero')
      assert.deepEqual(hero.rect, { x: 160, y: 240, width: 480, height: 270 })
      assert.deepEqual(hero.offset, { width: 480, height: 270 }, 'offsetWidth/offsetHeight is the layout size')
      assert.equal(hero.layoutScale.x, 1, 'no transform scaling on the hero')
      assert.equal(hero.style.fontSize, 64)
      assert.equal(hero.style.borderRadius, 24)
      assert.ok(layoutFile.tokens.fonts.length >= 1)
      assert.ok(layoutFile.tokens.fontSizes.includes(64))
      assert.ok(layoutFile.tokens.colors.length >= 1)
      assert.equal(layoutFile.tokens.customProperties['--accent'], '#ff3366', 'CSS custom properties should be captured')
      assertJsonSafe(layoutFile, 'layout.json')
    })

    await check('REAL capturePage: hero is cut out at 4x and the regular card at 2x, with real pixel dimensions', async () => {
      heroCutout = capture.cutouts.find((cutout) => cutout.isHero === true)
      cardCutout = capture.cutouts.find((cutout) => cutout.isHero === false && cutout.rect.width === 600)
      assert.ok(heroCutout !== undefined, 'a hero cutout should be produced')
      assert.ok(cardCutout !== undefined, 'the nested card cutout should be produced')
      assert.equal(heroCutout.scale, 4)
      assert.equal(heroCutout.clipScale, 2)
      assert.deepEqual(heroCutout.rect, { x: 160, y: 240, width: 480, height: 270 })
      assert.equal(heroCutout.pixelWidth, 1920)
      assert.equal(heroCutout.pixelHeight, 1080)
      assert.equal(cardCutout.scale, 2)
      assert.equal(cardCutout.pixelWidth, 1200)
      assert.equal(cardCutout.pixelHeight, 600)
      const heroPng = pngDimensions(await readFile(heroCutout.pngPath))
      assert.deepEqual(heroPng, { width: 1920, height: 1080 })
      const cardPng = pngDimensions(await readFile(cardCutout.pngPath))
      assert.deepEqual(cardPng, { width: 1200, height: 600 })
      assert.ok((await stat(cardCutout.pngPath)).size > 1000)
    })

    await check('REAL capturePage: the captured layout drives layoutToCamera with the documented formula', async () => {
      const camera = layoutToCamera(layoutFile, {})
      assert.ok(camera.zoom > 0)
      assert.equal(camera.target.selector, '#hero')
      const cx = camera.target.cx
      const cy = camera.target.cy
      assert.ok(Math.abs(camera.tx - (960 / camera.zoom - cx)) < 1e-3)
      assert.ok(Math.abs(camera.ty - (540 / camera.zoom - cy)) < 1e-3)
      assert.ok(camera.cssZoomZh.includes('Tx = 960/zoom − cx'))
      assertJsonSafe(camera, 'real camera')
      artifactNotes.push(`full-page 2x screenshot: ${capture.fullPngPath} (3840x3200)`)
      artifactNotes.push(`layout.json: ${capture.layoutPath}`)
      artifactNotes.push(`hero 4x cutout: ${heroCutout.pngPath} (1920x1080)`)
      artifactNotes.push(`card 2x cutout: ${cardCutout.pngPath} (1200x600)`)
    })
  }

  // -------------------------------------------------------------------------
  // Module hygiene
  // -------------------------------------------------------------------------
  await check('module hygiene: ESM, zero deps, node --check clean, expected exports, reuses htmlrender browser discovery', async () => {
    const source = await readFile(MODULE_PATH, 'utf8')
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gmu)].map((match) => match[1])
    assert.ok(imports.length > 0)
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `pagecapture.js must only import Node builtins and local helpers, found "${specifier}"`,
      )
    }
    assert.match(source, /from '\.\/htmlrender\.js'/u, 'browser discovery must be reused from lib/htmlrender.js')
    assert.match(source, /findBrowser/u)
    assert.doesNotMatch(source, /require\(/u, 'ESM only')
    execFileSync(process.execPath, ['--check', MODULE_PATH], { stdio: 'pipe' })
    execFileSync(process.execPath, ['--check', fileURLToPath(import.meta.url)], { stdio: 'pipe' })
    const module = await import('../lib/pagecapture.js')
    for (const name of ['buildCaptureScript', 'planElementCutouts', 'layoutToCamera', 'capturePage']) {
      assert.equal(typeof module[name], 'function', `${name} must be exported`)
    }
    assert.ok(Object.isFrozen(PAGE_CAPTURE_DEFAULTS), 'PAGE_CAPTURE_DEFAULTS should be frozen')
    assert.equal(PAGE_CAPTURE_DEFAULTS.deviceScaleFactor, 2)
    assert.equal(PAGE_CAPTURE_DEFAULTS.heroScale, 4)
  })
} finally {
  if (workDir !== undefined) await removeWorkDir(workDir)
}

console.log('')
for (const note of artifactNotes) console.log(note)
console.log(`\n${passed} passed, ${failed} failed (${passed + failed} assertion blocks)`)
process.exitCode = failed === 0 ? 0 : 1
