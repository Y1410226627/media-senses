/**
 * 真实页面 2.5D 采集（page capture / PageCam 代码化）。
 *
 * 为什么需要这个模块：复刻「既有页面」时必须用真实截图，不能手搓 UI 复刻。
 * 盲路径只能拿到文字；视觉模型要的是「全页纹理 + 元素级抠图 + 布局坐标表」，
 * 才能把真实页面搬进 2.5D 构图（放大做特写、按坐标摆镜头）。
 *
 * 方法论来自上游 video-shotcraft（Vincentwei1021，经 dsh-drawai 固定提交 1266a3e）
 * 的 Q1/Q2/PageCam，Apache-2.0；本文件代码为本仓自写（Node 内置 + 本仓 lib）。
 * 三条必须落地的经验：
 *
 * 1) **布局尺寸要用 offsetWidth/offsetHeight，不是 getBoundingClientRect().width**。
 *    rect 返回的是被 CSS transform/zoom 缩放后的视觉尺寸，拿它做布局规划会把缩放
 *    算两遍。layout.json 两个都采，并给出 layoutScale 比例（=rect/offset）暴露这个坑。
 *
 * 2) **放大必须走 CSS `zoom`，不能用 `transform: scale`**。Chromium 会先把 3D
 *    合成层按 1920 布局宽栅格化，再交给 GPU 放大，文字于是发糊；`zoom` 是布局级
 *    缩放，浏览器会按 zoom 后的尺寸重新排版与栅格化，文字保持清晰。
 *
 * 3) **坐标换算 `Tx = 960/zoom − cx`（`Ty = 540/zoom − cy`）不能漏**。zoom 前的
 *    坐标系里做平移，屏幕位置 = zoom × (cx + Tx) = 960，目标点才落回画面中心；
 *    漏了换算就会「跑焦点」（上游用户为此追打三轮）。layoutToCamera 严格执行该式，
 *    并在 cssZoomZh 里把原因写清楚。
 *
 * 浏览器启动方式复用 lib/htmlrender.js 的 CDP 方案：htmlrender 只导出了
 * `findBrowser()`，其 launchBrowser/CdpClient 是模块私有的，所以本文件按同一实现
 * 模式内联了最小 CDP 客户端（同样的 Chromium flags：--headless=new、
 * --remote-debugging-port=0、独立 --user-data-dir、DevToolsActivePort 发现、
 * Page/Runtime/Emulation 域、Page.captureScreenshot），没有另造一套技术栈。
 * browser 查找直接调用 htmlrender.findBrowser()。
 *
 * 铁律：ESM、零依赖、离线（只采本地 file:// 页面，不做网络请求）。没有浏览器时
 * 抛可读错误并给出安装/指定路径的提示，绝不无声崩溃。
 */
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findBrowser } from './htmlrender.js'

const IS_WINDOWS = process.platform === 'win32'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IHDR = 0x49484452
const MAX_BROWSER_LOG_BYTES = 64 * 1024
const MAX_PAGE_TARGET_ATTEMPTS = 200

/**
 * 采集默认值。全部可被同名 options 覆盖；viewport 用 1920x1080 与上游 2.5D
 * 合成的「1920 布局宽」假设一致；全页 2x（deviceScaleFactor=2），hero 元素 4x。
 */
export const PAGE_CAPTURE_DEFAULTS = Object.freeze({
  viewportWidth: 1920,
  viewportHeight: 1080,
  deviceScaleFactor: 2,
  canvasWidth: 1920,
  canvasHeight: 1080,
  heroScale: 4,
  elementScale: 2,
  maxElements: 80,
  maxCutouts: 12,
  minCutoutPx: 16,
  settleMs: 150,
  launchTimeoutMs: 30_000,
  readyTimeoutMs: 25_000,
  screenshotTimeoutMs: 120_000,
  angle: 'd3d11',
  heroSelectors: Object.freeze(['[data-capture="hero"]', '.hero', 'header', '[role="banner"]', 'h1']),
  /** Page.captureScreenshot 在部分 GPU 上有单边纹理上限；超过就截断并 warning。 */
  maxScreenshotDeviceWidth: 16_384,
  maxScreenshotDeviceHeight: 16_384,
  maxFullPageDevicePixels: 60_000_000,
  maxCutoutDevicePixels: 32_000_000,
})

/* -------------------------------------------------------------------------- */
/* 通用小工具                                                                  */
/* -------------------------------------------------------------------------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return clamp(number, min, max)
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return clamp(Math.round(number), min, max)
}

function finiteNumberOrNull(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(number) ? number : null
}

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function abortError() {
  const error = new Error('page capture 已被取消（AbortSignal）')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError()
}

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
}

function normaliseTextArray(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
}

function uniqueTag() {
  return `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`
}

function sanitiseName(value, fallback = 'cutout') {
  const text = String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return text.length > 0 ? text.slice(0, 48) : fallback
}

/** 读 PNG IHDR 尺寸；签名不对抛可读错误。 */
function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) {
    throw new Error(`浏览器返回的截图不是有效 PNG（只有 ${buffer?.length ?? 0} 字节）`)
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('浏览器返回的截图 PNG 签名不正确')
  if (buffer.readUInt32BE(12) !== IHDR) throw new Error('浏览器返回的截图 PNG 缺少 IHDR')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/* -------------------------------------------------------------------------- */
/* buildCaptureScript — 注入页面执行的布局采集 JS                              */
/* -------------------------------------------------------------------------- */

/**
 * 生成注入页面执行的采集脚本。
 *
 * 采集内容（全部 JSON 可序列化）：
 * - `elements: [{index, selector, tag, id, classes, text, role, ariaLabel, isHero,
 *   visible, rect, viewportRect, offset, layoutScale, style}]`
 *   - `rect`：页面坐标系（getBoundingClientRect + scrollX/Y），可能被 transform
 *     缩放——只代表「视觉位置/尺寸」；
 *   - `offset`：`offsetWidth/offsetHeight`，**这才是布局尺寸**（做缩放规划用它）；
 *   - `layoutScale.x/y = rect.width/offsetWidth`：不为 1 说明该元素被 transform
 *     或 zoom 缩放过，正是「拿 rect 当布局尺寸」会翻车的信号；
 *   - `style`：字族/字号/行高/字重/字距/颜色/背景/圆角/对齐/层级/透明度/transform 等 token。
 * - `tokens: {fonts, fontSizes, colors, backgrounds, radii, customProperties}`：
 *   页面实际用到的样式 token + `:root` 上声明的 CSS 自定义属性（--x），供复刻时直接取值。
 * - `deviceScaleFactor` / `devicePixelRatio` / `viewport` / `page`：像素比与页面尺寸。
 *
 * 脚本是 `(async () => { ... return {...}; })()` 形式，可直接被 CDP
 * `Runtime.evaluate({expression, awaitPromise:true, returnByValue:true})` 执行。
 * 纯函数：同样的 opts 生成同样的字符串（不含 Date.now / Math.random）。
 *
 * @param {object} [opts]
 * @param {string[]} [opts.selectors] 额外要采集的元素选择器
 * @param {string[]} [opts.heroSelectors] hero 元素选择器（默认见 PAGE_CAPTURE_DEFAULTS）
 * @param {number} [opts.maxElements=80] 最多采集多少个元素
 * @param {boolean} [opts.includeText=true] 是否采元素文本（前 200 字）
 * @param {boolean} [opts.includeStyles=true] 是否采 computed style token
 * @param {number} [opts.deviceScaleFactor=2] 设备像素比（写进 layout.json，供上层核对）
 * @returns {string} 可直接注入页面执行的 JavaScript 源码
 */
export function buildCaptureScript(opts = {}) {
  const settings = opts ?? {}
  const spec = {
    selectors: normaliseTextArray(settings.selectors),
    heroSelectors: normaliseTextArray(settings.heroSelectors).length > 0
      ? normaliseTextArray(settings.heroSelectors)
      : [...PAGE_CAPTURE_DEFAULTS.heroSelectors],
    maxElements: clampInt(settings.maxElements, PAGE_CAPTURE_DEFAULTS.maxElements, 1, 400),
    includeText: settings.includeText !== false,
    includeStyles: settings.includeStyles !== false,
    deviceScaleFactor: clampNumber(settings.deviceScaleFactor, PAGE_CAPTURE_DEFAULTS.deviceScaleFactor, 0.5, 8),
  }
  return captureScriptSource(spec)
}

/**
 * 脚本本体。注意：这里用普通字符串拼接而不是内嵌模板串，避免页面代码里的
 * `${}`/反引号与外层模板串互相干扰；`\\s` 在最终输出里是正则的 `\s`。
 */
function captureScriptSource(spec) {
  return `(async () => {
  'use strict';
  const SPEC = ${JSON.stringify(spec)};
  const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);
  const px = (value) => {
    if (value === null || value === undefined) return null;
    const number = typeof value === 'number' ? value : parseFloat(String(value));
    return Number.isFinite(number) ? round(number) : null;
  };
  const attr = (element, name) => {
    try {
      const value = element && element.getAttribute ? element.getAttribute(name) : null;
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch (error) { return null; }
  };
  const textOf = (element) => {
    if (!SPEC.includeText) return null;
    try {
      return String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
    } catch (error) { return ''; }
  };
  const selectorOf = (element) => {
    if (!element || !element.tagName) return 'unknown';
    const id = element.id ? String(element.id) : '';
    if (id.length > 0) return '#' + id;
    let tag = String(element.tagName).toLowerCase();
    if (element.classList && element.classList.length > 0) tag += '.' + String(element.classList[0]);
    let node = element.parentElement;
    let depth = 0;
    while (node && node.tagName && depth < 3) {
      const parentTag = String(node.tagName).toLowerCase();
      if (parentTag === 'html' || parentTag === 'body') { tag = parentTag + ' > ' + tag; break; }
      tag = parentTag + ' > ' + tag;
      node = node.parentElement;
      depth += 1;
    }
    return tag;
  };
  const styleOf = (element) => {
    if (!SPEC.includeStyles) return {};
    let computed = null;
    try { computed = getComputedStyle(element); } catch (error) { computed = null; }
    if (!computed) return {};
    return {
      display: computed.display || null,
      visibility: computed.visibility || null,
      position: computed.position || null,
      fontFamily: computed.fontFamily || null,
      fontSize: px(computed.fontSize),
      fontWeight: px(computed.fontWeight),
      lineHeight: px(computed.lineHeight),
      lineHeightRaw: computed.lineHeight || null,
      letterSpacing: px(computed.letterSpacing),
      color: computed.color || null,
      backgroundColor: computed.backgroundColor || null,
      borderRadius: px(computed.borderRadius),
      borderRadiusRaw: computed.borderRadius || null,
      textAlign: computed.textAlign || null,
      opacity: px(computed.opacity),
      zIndex: computed.zIndex || null,
      transform: computed.transform || null,
      boxShadow: computed.boxShadow && String(computed.boxShadow) !== 'none' ? String(computed.boxShadow).slice(0, 160) : null
    };
  };

  const entries = [];
  const seen = new Set();
  const push = (element, source, heroHint) => {
    if (!element || seen.has(element) || entries.length >= SPEC.maxElements) return;
    let rect = null;
    try { rect = element.getBoundingClientRect(); } catch (error) { rect = null; }
    if (!rect) return;
    const width = Number(rect.width) || 0;
    const height = Number(rect.height) || 0;
    const offsetWidth = Number(element.offsetWidth) || 0;
    const offsetHeight = Number(element.offsetHeight) || 0;
    const style = styleOf(element);
    const visible = width > 0 && height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    const scrollX = Number(window.scrollX) || 0;
    const scrollY = Number(window.scrollY) || 0;
    seen.add(element);
    entries.push({
      index: entries.length,
      selector: selectorOf(element),
      tag: element.tagName ? String(element.tagName).toLowerCase() : null,
      id: element.id ? String(element.id) : null,
      classes: element.classList ? Array.from(element.classList).slice(0, 8).map(String) : [],
      text: textOf(element),
      role: attr(element, 'role'),
      ariaLabel: attr(element, 'aria-label'),
      isHero: heroHint === true,
      heroFallback: false,
      source: source,
      visible: visible,
      rect: { x: round(Number(rect.x) + scrollX), y: round(Number(rect.y) + scrollY), width: round(width), height: round(height) },
      viewportRect: { x: round(Number(rect.x)), y: round(Number(rect.y)), width: round(width), height: round(height) },
      offset: { width: offsetWidth, height: offsetHeight },
      layoutScale: {
        x: width > 0 && offsetWidth > 0 ? round(width / offsetWidth, 3) : null,
        y: height > 0 && offsetHeight > 0 ? round(height / offsetHeight, 3) : null
      },
      style: style
    });
  };

  for (let h = 0; h < SPEC.heroSelectors.length; h += 1) {
    let list = [];
    try { list = document.querySelectorAll(SPEC.heroSelectors[h]); } catch (error) { list = []; }
    for (let i = 0; i < list.length && i < 3; i += 1) push(list[i], 'hero-selector', true);
  }
  if (SPEC.selectors.length === 0) {
    const semantic = ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer', 'h1', 'h2', 'h3', 'button', 'a', 'img', 'video', 'canvas', 'input', 'textarea'];
    for (let s = 0; s < semantic.length; s += 1) {
      let list = [];
      try { list = document.querySelectorAll(semantic[s]); } catch (error) { list = []; }
      for (let i = 0; i < list.length; i += 1) push(list[i], 'auto', false);
    }
    if (document.body && document.body.children) {
      // 顶层块 + 它们的直接子块：真实页面通常有 wrapper，只取 body.children 会漏掉
      // 结构内部的 section/card；再多一层足以覆盖常见版式，且被 maxElements 限住。
      const topLevel = document.body.children;
      for (let i = 0; i < topLevel.length; i += 1) {
        push(topLevel[i], 'auto', false);
        const children = topLevel[i] && topLevel[i].children;
        if (children) for (let c = 0; c < children.length; c += 1) push(children[c], 'auto', false);
      }
    }
  } else {
    for (let s = 0; s < SPEC.selectors.length; s += 1) {
      let list = [];
      try { list = document.querySelectorAll(SPEC.selectors[s]); } catch (error) { list = []; }
      for (let i = 0; i < list.length; i += 1) push(list[i], 'selector', false);
    }
  }

  let heroCount = 0;
  for (let i = 0; i < entries.length; i += 1) if (entries[i].isHero) heroCount += 1;
  if (heroCount === 0 && entries.length > 0) {
    let bestIndex = -1;
    let bestArea = 0;
    for (let i = 0; i < entries.length; i += 1) {
      if (!entries[i].visible) continue;
      const area = entries[i].rect.width * entries[i].rect.height;
      if (area > bestArea) { bestArea = area; bestIndex = i; }
    }
    if (bestIndex >= 0) {
      entries[bestIndex].isHero = true;
      entries[bestIndex].heroFallback = true;
    }
  }

  const fonts = [];
  const fontSizes = [];
  const colors = [];
  const backgrounds = [];
  const radii = [];
  const addUnique = (list, value, limit) => {
    if (value === null || value === undefined || value === '') return;
    if (list.length >= limit) return;
    if (list.indexOf(value) === -1) list.push(value);
  };
  for (let i = 0; i < entries.length; i += 1) {
    const style = entries[i].style || {};
    addUnique(fonts, style.fontFamily, 12);
    addUnique(fontSizes, style.fontSize, 12);
    addUnique(colors, style.color, 16);
    addUnique(backgrounds, style.backgroundColor, 16);
    addUnique(radii, style.borderRadiusRaw, 8);
  }
  fontSizes.sort((a, b) => a - b);

  const doc = document.documentElement || {};
  const body = document.body || {};
  const pageWidth = Math.max(Number(doc.scrollWidth) || 0, Number(doc.clientWidth) || 0, Number(body.scrollWidth) || 0, Number(window.innerWidth) || 0);
  const pageHeight = Math.max(Number(doc.scrollHeight) || 0, Number(doc.clientHeight) || 0, Number(body.scrollHeight) || 0, Number(window.innerHeight) || 0);

  const customProperties = {};
  let customCount = 0;
  try {
    const sheets = document.styleSheets || [];
    for (let s = 0; s < sheets.length && customCount < 80; s += 1) {
      let rules = null;
      try { rules = sheets[s].cssRules; } catch (error) { rules = null; }
      if (!rules) continue;
      for (let r = 0; r < rules.length && customCount < 80; r += 1) {
        const style = rules[r] && rules[r].style;
        if (!style) continue;
        for (let p = 0; p < style.length && customCount < 80; p += 1) {
          const name = style[p];
          if (typeof name === 'string' && name.indexOf('--') === 0) {
            const value = String(style.getPropertyValue(name) || '').trim().slice(0, 120);
            if (value.length > 0 && customProperties[name] === undefined) {
              customProperties[name] = value;
              customCount += 1;
            }
          }
        }
      }
    }
  } catch (error) { /* 跨域样式表取不到 cssRules 时忽略 */ }

  return {
    schema: 'media-senses.page-layout/v1',
    url: String(location.href || ''),
    title: String(document.title || ''),
    deviceScaleFactor: SPEC.deviceScaleFactor,
    devicePixelRatio: Number(window.devicePixelRatio) || null,
    viewport: {
      width: round(Number(window.innerWidth) || 0),
      height: round(Number(window.innerHeight) || 0),
      scrollX: round(Number(window.scrollX) || 0),
      scrollY: round(Number(window.scrollY) || 0)
    },
    page: { width: round(pageWidth), height: round(pageHeight) },
    elements: entries,
    tokens: { fonts: fonts, fontSizes: fontSizes, colors: colors, backgrounds: backgrounds, radii: radii, customProperties: customProperties }
  };
})()`
}

/* -------------------------------------------------------------------------- */
/* planElementCutouts — 元素级抠图规划                                          */
/* -------------------------------------------------------------------------- */

/**
 * 按 scale 规划元素级抠图。
 *
 * scale 的语义是「输出像素相对 CSS 像素的倍率」：hero 默认 4x（上游要求），普通
 * 元素 2x（跟全页 deviceScaleFactor 一致）。CDP 的 `Page.captureScreenshot` 在
 * deviceScaleFactor=D 下实际输出 = clip 尺寸 × D × clip.scale，所以这里同时给出
 * `clipScale = scale / deviceScaleFactor`，采集层直接喂给 CDP。
 * 例如 D=2、hero 4x → clipScale=2（输出 4 倍像素）；普通 2x → clipScale=1。
 *
 * 排序：hero 在前（面积降序），普通元素按面积降序，最多 maxCutouts 个；面积占页面
 * 92% 以上且不是 hero 的容器会被跳过（全页截图已经覆盖它）。
 *
 * @param {object} layout buildCaptureScript 的返回对象
 * @param {object} [opts]
 * @param {number} [opts.deviceScaleFactor] 默认取 layout.deviceScaleFactor
 * @param {number} [opts.heroScale=4] hero 元素输出倍率
 * @param {number} [opts.elementScale=2] 普通元素输出倍率
 * @param {number} [opts.maxCutouts=12]
 * @param {number} [opts.minCutoutPx=16] 小于该边长（CSS px）的元素不抠
 * @param {string[]} [opts.heroSelectors] 额外把 selector 命中这些值（前缀）的元素视作 hero
 * @returns {Array<{name: string, selector: string|null, rect: {x:number,y:number,width:number,height:number},
 *   scale: number, clipScale: number, pixelWidth: number, pixelHeight: number,
 *   isHero: boolean, index: number, tag: string|null}>}
 */
export function planElementCutouts(layout, opts = {}) {
  if (layout === null || typeof layout !== 'object' || !Array.isArray(layout.elements)) {
    throw new Error('planElementCutouts 需要 buildCaptureScript 返回的 layout 对象（缺少 elements 数组）')
  }
  const options = opts ?? {}
  const deviceScaleFactor = clampNumber(
    options.deviceScaleFactor ?? layout.deviceScaleFactor ?? PAGE_CAPTURE_DEFAULTS.deviceScaleFactor,
    PAGE_CAPTURE_DEFAULTS.deviceScaleFactor,
    0.5,
    4,
  )
  const heroScale = clampNumber(options.heroScale, PAGE_CAPTURE_DEFAULTS.heroScale, 0.5, 8)
  const elementScale = clampNumber(options.elementScale, PAGE_CAPTURE_DEFAULTS.elementScale, 0.5, 8)
  const minCutoutPx = clampNumber(options.minCutoutPx, PAGE_CAPTURE_DEFAULTS.minCutoutPx, 1, 4096)
  const maxCutouts = clampInt(options.maxCutouts, PAGE_CAPTURE_DEFAULTS.maxCutouts, 1, 64)
  const extraHeroSelectors = normaliseTextArray(options.heroSelectors)
  const pageArea = (finiteNumberOrNull(layout.page?.width) ?? 0) * (finiteNumberOrNull(layout.page?.height) ?? 0)

  const candidates = []
  layout.elements.forEach((element, index) => {
    if (element === null || typeof element !== 'object') return
    const rect = normaliseRect(element.rect)
    if (rect === null) return
    if (element.visible === false) return
    if (rect.width < minCutoutPx || rect.height < minCutoutPx) return
    const selector = typeof element.selector === 'string' ? element.selector : null
    const isHero = element.isHero === true
      || (selector !== null && extraHeroSelectors.some((pattern) => selector === pattern || selector.startsWith(pattern)))
    if (!isHero && pageArea > 0 && rect.width * rect.height > pageArea * 0.92) return
    candidates.push({ element, index, rect, isHero, area: rect.width * rect.height })
  })
  candidates.sort((a, b) => {
    if (a.isHero !== b.isHero) return a.isHero ? -1 : 1
    if (b.area !== a.area) return b.area - a.area
    return a.index - b.index
  })

  const usedNames = new Map()
  return candidates.slice(0, maxCutouts).map((candidate) => {
    const scale = candidate.isHero ? heroScale : elementScale
    const baseName = candidate.isHero
      ? 'hero'
      : sanitiseName(`el-${candidate.index}-${candidate.element.tag ?? 'node'}`, `el-${candidate.index}`)
    const seen = usedNames.get(baseName) ?? 0
    usedNames.set(baseName, seen + 1)
    const name = seen === 0 ? baseName : `${baseName}-${seen + 1}`
    return {
      name,
      selector: typeof candidate.element.selector === 'string' ? candidate.element.selector : null,
      rect: {
        x: round(candidate.rect.x),
        y: round(candidate.rect.y),
        width: round(candidate.rect.width),
        height: round(candidate.rect.height),
      },
      scale: round(scale, 3),
      clipScale: round(scale / deviceScaleFactor, 4),
      pixelWidth: Math.max(1, Math.round(candidate.rect.width * scale)),
      pixelHeight: Math.max(1, Math.round(candidate.rect.height * scale)),
      isHero: candidate.isHero,
      index: candidate.index,
      tag: typeof candidate.element.tag === 'string' ? candidate.element.tag : null,
    }
  })
}

function normaliseRect(rect) {
  if (rect === null || typeof rect !== 'object') return null
  const x = finiteNumberOrNull(rect.x)
  const y = finiteNumberOrNull(rect.y)
  const width = finiteNumberOrNull(rect.width)
  const height = finiteNumberOrNull(rect.height)
  if (x === null || y === null || width === null || height === null) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/* -------------------------------------------------------------------------- */
/* layoutToCamera — 2.5D 相机换算                                               */
/* -------------------------------------------------------------------------- */

/**
 * 由 layout 计算 2.5D 相机（画布尺寸 + zoom + tx/ty）。
 *
 * **为什么是 CSS zoom 而不是 transform: scale**：Chromium 对 3D 合成层的栅格化
 * 按布局宽（上游场景是 1920）进行，然后才把图层交给 GPU 放大；`transform: scale(4)`
 * 只是把 1x 栅格化的纹理放大 4 倍，文字边缘会糊。`zoom: 4` 是布局级缩放，浏览器
 * 会按放大后的实际尺寸重新排版并栅格化，文字仍是设备像素级清晰。
 *
 * **坐标换算必须用 `Tx = 960/zoom − cx`**（`Ty = 540/zoom − cy`，画布 1920x1080）。
 * 因为 zoom 作用在整个页面上，若先把目标中心 `(cx, cy)` 平移到视口中心再 zoom，
 * 最终屏幕位置会变成 `zoom × (cx + Tx)`；令它等于 960，就得到 `Tx = 960/zoom − cx`。
 * 漏掉这一步会「跑焦点」：放大后目标点飞出画面。
 *
 * 计算 zoom 用 **offset 布局尺寸**（`offset.width/height`），不用 rect：rect 已被
 * CSS transform 缩放，拿它算 zoom 会把缩放算两遍。目标中心仍用 rect（视觉位置）。
 *
 * @param {object} layout buildCaptureScript 的返回对象
 * @param {object} [opts]
 * @param {number} [opts.width=1920] 相机画布宽（CSS px）
 * @param {number} [opts.height=1080] 相机画布高
 * @param {string|number|object} [opts.target] 目标元素：selector / elements 下标 / {selector|index}
 * @param {number} [opts.padding=0] 目标在画面里保留的边距（CSS px），只影响 zoom
 * @param {number} [opts.minZoom=0.5]
 * @param {number} [opts.maxZoom=4]
 * @returns {{width: number, height: number, tx: number, ty: number, zoom: number,
 *   cssZoomZh: string, target: object|null, page: object}}
 */
export function layoutToCamera(layout, opts = {}) {
  if (layout === null || typeof layout !== 'object') {
    throw new Error('layoutToCamera 需要一个 layout 对象（buildCaptureScript 的返回值）')
  }
  const options = opts ?? {}
  const width = clampNumber(options.width, PAGE_CAPTURE_DEFAULTS.canvasWidth, 64, 8192)
  const height = clampNumber(options.height, PAGE_CAPTURE_DEFAULTS.canvasHeight, 64, 8192)
  const padding = clampNumber(options.padding, 0, 0, 4096)
  const minZoom = clampNumber(options.minZoom, 0.5, 0.01, 8)
  const maxZoom = clampNumber(options.maxZoom, PAGE_CAPTURE_DEFAULTS.heroScale, minZoom, 16)
  const elements = Array.isArray(layout.elements) ? layout.elements.filter((element) => element !== null && typeof element === 'object') : []
  const targetElement = pickCameraTarget(elements, options.target)

  let layoutWidth = PAGE_CAPTURE_DEFAULTS.canvasWidth
  let layoutHeight = PAGE_CAPTURE_DEFAULTS.canvasHeight
  let cx
  let cy
  let isHero = false
  let selector = null
  if (targetElement !== null) {
    const offset = targetElement.offset ?? {}
    const rect = normaliseRect(targetElement.rect) ?? normaliseRect(targetElement.viewportRect)
    layoutWidth = finiteNumberOrNull(offset.width) ?? (rect?.width ?? PAGE_CAPTURE_DEFAULTS.canvasWidth)
    layoutHeight = finiteNumberOrNull(offset.height) ?? (rect?.height ?? PAGE_CAPTURE_DEFAULTS.canvasHeight)
    // 目标中心用视觉 rect（页面坐标）：zoom 后它应该落在画布中心。
    cx = rect !== null ? rect.x + rect.width / 2 : 0
    cy = rect !== null ? rect.y + rect.height / 2 : 0
    isHero = targetElement.isHero === true
    selector = typeof targetElement.selector === 'string' ? targetElement.selector : null
  } else {
    const pageWidth = finiteNumberOrNull(layout.page?.width) ?? PAGE_CAPTURE_DEFAULTS.canvasWidth
    const pageHeight = finiteNumberOrNull(layout.page?.height) ?? PAGE_CAPTURE_DEFAULTS.canvasHeight
    layoutWidth = Math.max(1, pageWidth)
    layoutHeight = Math.max(1, pageHeight)
    cx = pageWidth / 2
    cy = pageHeight / 2
  }

  const availableWidth = Math.max(1, width - 2 * padding)
  const availableHeight = Math.max(1, height - 2 * padding)
  const fitZoom = Math.min(availableWidth / Math.max(1, layoutWidth), availableHeight / Math.max(1, layoutHeight))
  let zoom = clamp(Number.isFinite(fitZoom) ? fitZoom : 1, minZoom, maxZoom)
  zoom = round(clamp(zoom, 0.01, 16), 4)

  // Q2 核心换算：zoom 前坐标系中把 (cx, cy) 移到画布中心。
  const tx = round(width / 2 / zoom - cx, 4)
  const ty = round(height / 2 / zoom - cy, 4)
  const halfWidth = round(width / 2, 3)
  const halfHeight = round(height / 2, 3)
  const cssZoomZh =
    `用 CSS zoom=${zoom} 放大页面内容（布局与文字按 zoom 后的实际尺寸重新排版、重新栅格化），` +
    `不要用 transform: scale(${zoom})：Chromium 先把 3D 合成层按 1920 布局宽栅格化，再交给 GPU 放大，` +
    '文字会发糊（这是上游踩过的血泪判例）。相机平移量必须在 zoom 之前的坐标系里计算：' +
    `Tx = ${halfWidth}/zoom − cx = ${tx}，Ty = ${halfHeight}/zoom − cy = ${ty}；` +
    '漏掉这个换算（例如直接 translate(-cx,-cy) 再 zoom）就会跑焦点，画面里的目标点会飞出取景框。'
  return {
    width: round(width, 3),
    height: round(height, 3),
    tx,
    ty,
    zoom,
    cssZoomZh,
    target: targetElement === null ? null : { selector, cx: round(cx, 3), cy: round(cy, 3), layoutWidth: round(layoutWidth, 3), layoutHeight: round(layoutHeight, 3), isHero },
    page: {
      width: finiteNumberOrNull(layout.page?.width) ?? null,
      height: finiteNumberOrNull(layout.page?.height) ?? null,
    },
  }
}

/** target 支持 selector 字符串 / elements 下标 / {selector|index}；否则挑 hero 或最大元素。 */
function pickCameraTarget(elements, target) {
  if (elements.length === 0) return null
  if (typeof target === 'string') {
    const match = elements.find((element) => element.selector === target)
    if (match !== undefined) return match
  } else if (typeof target === 'number' && Number.isInteger(target)) {
    if (target >= 0 && target < elements.length) return elements[target]
  } else if (target !== null && typeof target === 'object') {
    if (typeof target.selector === 'string') {
      const match = elements.find((element) => element.selector === target.selector)
      if (match !== undefined) return match
    }
    if (Number.isInteger(target.index) && target.index >= 0 && target.index < elements.length) return elements[target.index]
  }
  const hero = elements.find((element) => element.isHero === true && normaliseRect(element.rect) !== null)
  if (hero !== undefined) return hero
  let best = null
  let bestArea = -1
  for (const element of elements) {
    const rect = normaliseRect(element.rect)
    if (rect === null) continue
    const area = rect.width * rect.height
    if (area > bestArea) {
      bestArea = area
      best = element
    }
  }
  return best
}

/* -------------------------------------------------------------------------- */
/* 浏览器启动 + 最小 CDP 客户端（与 lib/htmlrender.js 同一实现模式）            */
/* -------------------------------------------------------------------------- */

/**
 * 解析要用的浏览器：显式 browserPath 优先，否则复用 htmlrender.findBrowser()。
 * 找不到/路径不存在时给可读错误（含安装与配置提示），而不是让 spawn 抛 ENOENT。
 */
async function resolveCaptureBrowser(options = {}) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error(
      '当前 Node.js 进程没有全局 WebSocket API（Node 22+ 才有），无法驱动 CDP 做页面采集；' +
        '请升级 Node.js 后重试。',
    )
  }
  const explicit = typeof options.browserPath === 'string' && options.browserPath.trim().length > 0
    ? options.browserPath.trim()
    : undefined
  if (explicit !== undefined) {
    const absolute = isAbsolute(explicit) ? explicit : resolvePath(explicit)
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined || !info.isFile()) {
      throw new Error(
        `没有可用的无头浏览器：options.browserPath 指向的文件不存在（${absolute}）。` +
          '请检查路径，或省略 browserPath 让模块自动查找 Microsoft Edge / Google Chrome；' +
          '未安装浏览器时无法做真实页面采集。',
      )
    }
    return absolute
  }
  const found = await findBrowser()
  if (found === undefined) {
    throw new Error(
      '没有找到可用的无头浏览器（Microsoft Edge / Google Chrome）。capturePage 需要真实浏览器做页面栅格化：' +
        '请安装 Edge 或 Chrome，或通过 options.browserPath 指定 msedge.exe 路径' +
        '（例如 "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"）。',
    )
  }
  return found
}

/** Chromium flags：与 lib/htmlrender.js 的 browserArguments 保持一致。 */
function browserArgumentsForCapture({ width, height, profileDir, angle }) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${width},${height}`,
    '--force-device-scale-factor=1',
    '--disable-features=CalculateNativeWinOcclusion',
    '--allow-file-access-from-files',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--force-color-profile=srgb',
    'about:blank',
  ]
  if (angle !== 'default') args.splice(args.length - 1, 0, `--use-angle=${angle}`)
  return args
}

/** 启动浏览器并等 DevToolsActivePort；失败/超时给可读错误。 */
async function launchCaptureBrowser({ browser, width, height, profileDir, angle, launchTimeoutMs, signal }) {
  await rm(profileDir, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
  await mkdir(profileDir, { recursive: true })
  let child
  try {
    child = spawn(browser, browserArgumentsForCapture({ width, height, profileDir, angle }), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    throw new Error(`无法启动无头浏览器（${browser}）：${error.message}`)
  }
  let stderrText = ''
  let exitInfo
  let launchError
  let endpoint
  const startedAt = Date.now()
  const exitPromise = new Promise((resolveExit) => {
    child.once('exit', (code, signalName) => {
      exitInfo = { code, signal: signalName }
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
    throwIfAborted(signal)
    if (launchError !== undefined) {
      throw new Error(`无法启动无头浏览器（${browser}）：${launchError.message}`)
    }
    endpoint = await readDevToolsActivePort(profileDir)
    if (endpoint !== undefined) break
    endpoint = extractStderrEndpoint(stderrText)
    if (endpoint !== undefined) break
    if (exitInfo !== undefined && exitInfo.code !== 0) {
      await taskkillTree(child.pid)
      throw new Error(
        `无头浏览器在暴露 DevTools 端口前就退出了（code ${String(exitInfo.code ?? 'null')}）` +
          browserStateSuffix(stderrText),
      )
    }
    await sleep(50)
  }
  if (endpoint === undefined) {
    await taskkillTree(child.pid)
    throw new Error(`无头浏览器在 ${launchTimeoutMs}ms 内没有暴露 DevTools 端口：${browser}${browserStateSuffix(stderrText)}`)
  }
  const host = '127.0.0.1'
  const browserWebSocketUrl = typeof endpoint.browserPath === 'string' && endpoint.browserPath.startsWith('/devtools/')
    ? `ws://${host}:${endpoint.port}${endpoint.browserPath}`
    : undefined
  return {
    child,
    browser,
    host,
    port: endpoint.port,
    browserWebSocketUrl,
    launchMs: Date.now() - startedAt,
    exitPromise,
    stderrTail: () => tailLines(stderrText, 12),
  }
}

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

function extractStderrEndpoint(text) {
  const match = /DevTools listening on ws:\/\/([^\s/:]+):(\d+)(\/\S*)?/u.exec(text)
  if (match === null) return undefined
  const port = Number.parseInt(match[2], 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { port, browserPath: match[3] }
}

function browserStateSuffix(stderrText) {
  const tail = tailLines(stderrText, 12)
  return tail.length > 0 ? `\n浏览器日志尾部：\n${tail}` : ''
}

function tailLines(text, count) {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-count)
    .join('\n')
}

/** 轮询 /json/list 拿页面 target（与 htmlrender 的 discoverPageTarget 同思路）。 */
async function discoverPageTarget(launched, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000
  const base = `http://${launched.host}:${launched.port}`
  const startedAt = Date.now()
  let createdFallback = false
  let lastError
  let attempts = 0
  while (Date.now() - startedAt < timeoutMs && attempts < MAX_PAGE_TARGET_ATTEMPTS) {
    throwIfAborted(options.signal)
    attempts += 1
    try {
      const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) })
      if (response.ok) {
        const targets = await response.json()
        const pages = Array.isArray(targets)
          ? targets.filter((target) => target?.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
          : []
        if (pages.length > 0) return pages.find((page) => page.url === 'about:blank') ?? pages[0]
      }
    } catch (error) {
      lastError = error
    }
    if (!createdFallback && Date.now() - startedAt > Math.min(5000, timeoutMs / 2)) {
      createdFallback = true
      try {
        await fetch(`${base}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(3000) })
      } catch {
        // 不同 Chromium 版本方法不同，下一轮 /json/list 决定。
      }
    }
    await sleep(100)
  }
  throw new Error(
    `无头浏览器在 ${timeoutMs}ms 内没有发布可用的页面 target` +
      (lastError !== undefined ? `（最后一次错误：${lastError.message}）` : '') +
      (launched?.stderrTail ? `\n浏览器日志尾部：\n${launched.stderrTail()}` : ''),
  )
}

class CdpError extends Error {}

function cdpError(method, detail) {
  const message = detail?.message ?? 'unknown DevTools error'
  const data = typeof detail?.data === 'string' && detail.data.length > 0 ? `: ${detail.data}` : ''
  const error = new CdpError(`${method} failed: ${message}${data}`)
  if (typeof detail?.code === 'number') error.code = detail.code
  return error
}

/** 最小 CDP 客户端（Node 全局 WebSocket；与 htmlrender 的 CdpClient 等价但更精简）。 */
class CdpClient {
  constructor(websocket, options = {}) {
    this.websocket = websocket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    this.closeDetail = ''
    this.closeHint = options.closeHint
    websocket.addEventListener('message', (event) => this.handleMessage(event))
    websocket.addEventListener('close', (event) => {
      const code = event?.code
      const reason = event?.reason
      this.handleClose(`DevTools WebSocket 已关闭${code ? `（code ${code}${reason ? `: ${reason}` : ''}）` : ''}`)
    })
    websocket.addEventListener('error', (event) => {
      this.handleClose(`DevTools WebSocket 出错${event?.message ? `：${event.message}` : ''}`)
    })
  }

  static connect(wsUrl, options = {}) {
    if (typeof globalThis.WebSocket !== 'function') {
      throw new Error('当前 Node.js 进程没有全局 WebSocket API（Node 22+ 才有），无法驱动 CDP')
    }
    const timeoutMs = options.timeoutMs ?? 15_000
    return new Promise((resolveConnect, rejectConnect) => {
      let socket
      try {
        socket = new globalThis.WebSocket(wsUrl)
      } catch (error) {
        rejectConnect(new Error(`无法打开 DevTools WebSocket（${wsUrl}）：${error.message}`))
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
        try { socket.close() } catch { /* ignore */ }
        finish(rejectConnect, new Error(`浏览器在 ${timeoutMs}ms 内没有接受 DevTools WebSocket（${wsUrl}）`))
      }, timeoutMs)
      socket.addEventListener('open', () => finish(resolveConnect, new CdpClient(socket, options)), { once: true })
      socket.addEventListener('error', (event) => {
        finish(rejectConnect, new Error(`无法连接 DevTools WebSocket（${wsUrl}）${event?.message ? `：${event.message}` : ''}`))
      }, { once: true })
      socket.addEventListener('close', (event) => {
        finish(rejectConnect, new Error(`DevTools WebSocket 在连接完成前关闭（code ${String(event?.code ?? 'unknown')}）`))
      }, { once: true })
    })
  }

  handleMessage(event) {
    let message
    try {
      const raw = typeof event?.data === 'string' ? event.data : Buffer.from(event?.data ?? '').toString('utf8')
      message = JSON.parse(raw)
    } catch {
      return
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
      try { handler(message.params ?? {}) } catch { /* listener 自身异常不影响协议循环 */ }
    }
  }

  handleClose(detail) {
    if (this.closed) return
    this.closed = true
    this.closeDetail = detail
    const hint = typeof this.closeHint === 'function' ? this.closeHint() : ''
    const error = new Error(`无头浏览器关闭了 DevTools 连接：${detail}${hint ? `\n${hint}` : ''}`)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.listeners.clear()
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) {
      return Promise.reject(new Error(`无法调用 ${method}：${this.closeDetail.length > 0 ? this.closeDetail : 'DevTools 连接已关闭'}`))
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        rejectSend(new Error(`浏览器在 ${timeoutMs}ms 内没有响应 ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer, method })
      try {
        this.websocket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        rejectSend(new Error(`无法向浏览器发送 ${method}：${error.message}`))
      }
    })
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) ?? new Set()
    this.listeners.set(method, handlers)
    handlers.add(handler)
    return () => handlers.delete(handler)
  }

  waitForEvent(method, timeoutMs = 15_000) {
    return new Promise((resolveWait, rejectWait) => {
      if (this.closed) {
        rejectWait(new Error(`DevTools 连接已关闭，无法等待 ${method}`))
        return
      }
      let done = false
      const handlers = this.listeners.get(method) ?? new Set()
      this.listeners.set(method, handlers)
      const handler = (params) => {
        if (done) return
        done = true
        clearTimeout(timer)
        handlers.delete(handler)
        resolveWait(params)
      }
      const timer = setTimeout(() => {
        if (done) return
        done = true
        handlers.delete(handler)
        rejectWait(new Error(`等待 ${method} 超过 ${timeoutMs}ms`))
      }, timeoutMs)
      handlers.add(handler)
    })
  }

  close() {
    if (this.closed) {
      try { this.websocket.close() } catch { /* ignore */ }
      return
    }
    this.closed = true
    this.closeDetail = 'DevTools 客户端被采集器关闭'
    try { this.websocket.close() } catch { /* ignore */ }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(this.closeDetail))
    }
    this.pending.clear()
    this.listeners.clear()
  }
}

function isProcessAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 关浏览器：先 Browser.close，再 taskkill /T /F 进程树；绝不抛。 */
async function stopCaptureBrowser(launched, client) {
  if (launched === undefined) return
  const child = launched.child
  const pid = typeof child?.pid === 'number' ? child.pid : undefined
  let graceful = false
  if (client !== undefined) {
    try {
      await client.send('Browser.close', {}, 1200)
      graceful = true
    } catch {
      // 部分 Chromium 构建不暴露 Browser.close。
    }
  }
  if (graceful && (await waitForExit(launched.exitPromise, 2500))) {
    try { client?.close() } catch { /* ignore */ }
    return
  }
  if (pid !== undefined) {
    await taskkillTree(pid)
    await waitForExit(launched.exitPromise, 2500)
  }
  if (typeof launched.browserWebSocketUrl === 'string' && (pid === undefined || !isProcessAlive(pid))) {
    let browserClient
    try {
      browserClient = await CdpClient.connect(launched.browserWebSocketUrl, { timeoutMs: 2500 })
      await browserClient.send('Browser.close', {}, 1200)
    } catch {
      // 浏览器已经退出或不可达。
    } finally {
      try { browserClient?.close() } catch { /* ignore */ }
    }
  }
  if (pid !== undefined && isProcessAlive(pid)) {
    await taskkillTree(pid)
    await waitForExit(launched.exitPromise, 2000)
  }
  try { client?.close() } catch { /* ignore */ }
}

async function taskkillTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return
  if (!IS_WINDOWS) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    return
  }
  await new Promise((resolveKill) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolveKill())
  })
}

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

/** 删除目录（Chromium 子进程可能还占着句柄，重试几次）。 */
async function removeDirectory(dir, attempts = 10, delayMs = 200) {
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
/* capturePage                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 对本地 HTML 页面做真实 2.5D 采集：全页 2x 截图 + layout.json + 元素级抠图。
 *
 * 流程（全部走 CDP，和 htmlrender 起 Edge 的方式一致）：
 *   启动 headless 浏览器 → Emulation 设 viewport/deviceScaleFactor → 打开
 *   file:// 页面 → 等 fonts.ready + 2 帧 rAF + settleMs → 执行
 *   buildCaptureScript 采布局 → Page.getLayoutMetrics 取内容尺寸 →
 *   Page.captureScreenshot 全页（clip=内容尺寸，DSF=2 → 2x 像素）→
 *   按 planElementCutouts 逐个元素 clip 截图（hero 4x = clip.scale 2 @ DSF 2）→
 *   关浏览器、清 profile，返回产物路径。
 *
 * 只在本地 file:// 页面工作（离线铁律；传 http(s) 会得到可读错误）。
 * 元素截图失败会降级为 warning（不中断整次采集）；页面打不开、布局脚本失败、
 * 全页截图失败这类整体失败抛可读错误。没有浏览器时抛「没有找到可用的无头浏览器…」。
 *
 * @param {object} opts
 * @param {string} opts.htmlPath 本地 HTML 文件路径（必填）
 * @param {string} [opts.outDir] 产物目录（默认 tmp/media-senses/pagecapture/<tag>）
 * @param {string} [opts.workDir] 浏览器 profile 的临时工作目录（默认 mkdtemp）
 * @param {string} [opts.browserPath] 显式 msedge.exe/chrome.exe 路径
 * @param {number} [opts.viewportWidth=1920] CSS 视口宽
 * @param {number} [opts.viewportHeight=1080]
 * @param {number} [opts.deviceScaleFactor=2] 全页截图倍率
 * @param {number} [opts.heroScale=4] hero 元素抠图倍率
 * @param {number} [opts.elementScale=2] 普通元素抠图倍率
 * @param {number} [opts.maxElements=80] layout 采集上限
 * @param {number} [opts.maxCutouts=12] 抠图数量上限
 * @param {number} [opts.minCutoutPx=16] 小于该边长不抠
 * @param {number} [opts.settleMs=150] 布局稳定额外等待
 * @param {string} [opts.angle='d3d11'] --use-angle 参数（'default' 不传）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{fullPngPath: string, layoutPath: string,
 *   cutouts: Array<{name: string, selector: string|null, rect: object, scale: number,
 *     clipScale: number, pixelWidth: number, pixelHeight: number, pngPath: string, bytes: number, isHero: boolean}>,
 *   warnings: string[], browser: string, url: string,
 *   viewport: {width: number, height: number, deviceScaleFactor: number},
 *   page: {width: number, height: number},
 *   layoutSummary: {elementCount: number, heroCount: number, fonts: number, colors: number},
 *   timings: {launchMs: number, setupMs: number, captureMs: number, totalMs: number}}>}
 */
export async function capturePage(opts = {}) {
  const options = opts ?? {}
  const totalStartedAt = Date.now()
  const warnings = []

  const htmlPath = typeof options.htmlPath === 'string' ? options.htmlPath.trim() : ''
  if (htmlPath.length === 0) throw new Error('capturePage 需要 options.htmlPath 指向一个本地 HTML 文件')
  const absoluteHtml = isAbsolute(htmlPath) ? htmlPath : resolvePath(htmlPath)
  const htmlInfo = await stat(absoluteHtml).catch(() => undefined)
  if (htmlInfo === undefined || !htmlInfo.isFile()) {
    throw new Error(`页面文件不存在：${absoluteHtml}。capturePage 只接受本地 HTML 文件路径（离线铁律，不做网络抓取）`)
  }
  if (!/\.(?:html?|xhtml)$/iu.test(absoluteHtml)) {
    warnings.push(`输入文件不像 HTML（${basename(absoluteHtml)}），仍按页面尝试打开`)
  }
  const viewportWidth = clampInt(options.viewportWidth, PAGE_CAPTURE_DEFAULTS.viewportWidth, 320, 8192)
  const viewportHeight = clampInt(options.viewportHeight, PAGE_CAPTURE_DEFAULTS.viewportHeight, 240, 8192)
  const deviceScaleFactor = clampNumber(options.deviceScaleFactor, PAGE_CAPTURE_DEFAULTS.deviceScaleFactor, 1, 4)
  const heroScale = clampNumber(options.heroScale, PAGE_CAPTURE_DEFAULTS.heroScale, 1, 8)
  const elementScale = clampNumber(options.elementScale, PAGE_CAPTURE_DEFAULTS.elementScale, 1, 8)
  const maxElements = clampInt(options.maxElements, PAGE_CAPTURE_DEFAULTS.maxElements, 1, 400)
  const maxCutouts = clampInt(options.maxCutouts, PAGE_CAPTURE_DEFAULTS.maxCutouts, 0, 64)
  const minCutoutPx = clampNumber(options.minCutoutPx, PAGE_CAPTURE_DEFAULTS.minCutoutPx, 1, 4096)
  const settleMs = clampInt(options.settleMs, PAGE_CAPTURE_DEFAULTS.settleMs, 0, 5000)
  const launchTimeoutMs = clampInt(options.launchTimeoutMs, PAGE_CAPTURE_DEFAULTS.launchTimeoutMs, 5000, 120_000)
  const readyTimeoutMs = clampInt(options.readyTimeoutMs, PAGE_CAPTURE_DEFAULTS.readyTimeoutMs, 5000, 120_000)
  const screenshotTimeoutMs = clampInt(options.screenshotTimeoutMs, PAGE_CAPTURE_DEFAULTS.screenshotTimeoutMs, 10_000, 600_000)
  const angle = typeof options.angle === 'string' && options.angle.trim().length > 0 ? options.angle.trim() : PAGE_CAPTURE_DEFAULTS.angle
  const signal = options.signal
  throwIfAborted(signal)

  const browser = await resolveCaptureBrowser({ browserPath: options.browserPath })
  throwIfAborted(signal)

  const ownsWorkDir = typeof options.workDir !== 'string' || options.workDir.trim().length === 0
  const workDir = ownsWorkDir
    ? await mkdtemp(join(tmpdir(), 'media-senses-pagecapture-'))
    : resolvePath(options.workDir.trim())
  await mkdir(workDir, { recursive: true })
  const profileDir = join(workDir, 'profile')
  const outDir = typeof options.outDir === 'string' && options.outDir.trim().length > 0
    ? resolvePath(options.outDir.trim())
    : typeof options.outputDir === 'string' && options.outputDir.trim().length > 0
      ? resolvePath(options.outputDir.trim())
      : join(tmpdir(), 'media-senses', 'pagecapture', `page-${uniqueTag()}`)
  await mkdir(outDir, { recursive: true })
  const url = pathToFileURL(absoluteHtml).href
  if (/^https?:/iu.test(url)) throw new Error('capturePage 只支持本地 file:// 页面（离线铁律）')

  let launched
  let client
  const setupStartedAt = Date.now()
  try {
    launched = await launchCaptureBrowser({
      browser,
      width: viewportWidth,
      height: viewportHeight,
      profileDir,
      angle,
      launchTimeoutMs,
      signal,
    })
    throwIfAborted(signal)
    const pageTarget = await discoverPageTarget(launched, {
      timeoutMs: Math.min(20_000, Math.max(10_000, readyTimeoutMs)),
      signal,
    })
    client = await CdpClient.connect(pageTarget.webSocketDebuggerUrl, {
      timeoutMs: 15_000,
      closeHint: () => (launched?.stderrTail ? `浏览器日志尾部：\n${launched.stderrTail()}` : ''),
    })
    await client.send('Page.enable', {}, 10_000)
    await client.send('Runtime.enable', {}, 10_000)
    await client.send('Log.enable', {}, 10_000).catch(() => undefined)
    await client.send(
      'Emulation.setDeviceMetricsOverride',
      { width: viewportWidth, height: viewportHeight, deviceScaleFactor, mobile: false },
      10_000,
    )
    throwIfAborted(signal)

    const loadEvent = client.waitForEvent('Page.loadEventFired', readyTimeoutMs)
    const navigation = await client.send('Page.navigate', { url }, 20_000)
    if (navigation?.errorText) throw new Error(`页面加载失败（${url}）：${navigation.errorText}`)
    const loaded = await loadEvent.then(() => true).catch(() => false)
    if (!loaded) warnings.push(`页面 load 事件在 ${readyTimeoutMs}ms 内没有触发，继续按已渲染内容采集`)
    await evaluateValue(client, pagePrepareExpression(settleMs), { awaitPromise: true, timeoutMs: readyTimeoutMs + 5000 })
    await evaluateValue(client, '(() => { try { window.scrollTo(0, 0); } catch (error) {} return true; })()', { timeoutMs: 10_000 })
    throwIfAborted(signal)
    const setupMs = Date.now() - setupStartedAt

    const layoutValue = await evaluateValue(
      client,
      buildCaptureScript({
        deviceScaleFactor,
        maxElements,
        heroSelectors: options.heroSelectors,
        selectors: options.selectors,
        includeText: options.includeText,
        includeStyles: options.includeStyles,
      }),
      { awaitPromise: true, timeoutMs: 30_000 },
    )
    const layout = normaliseLayout(layoutValue, { url, viewportWidth, viewportHeight, deviceScaleFactor })
    const layoutPath = join(outDir, 'layout.json')
    await writeFile(layoutPath, `${JSON.stringify(layout, null, 2)}\n`, 'utf8')
    throwIfAborted(signal)

    // ---- 全页 2x 截图 ------------------------------------------------------
    const captureStartedAt = Date.now()
    const metrics = await client.send('Page.getLayoutMetrics', {}, 15_000)
    const contentSize = metrics?.cssContentSize ?? metrics?.contentSize ?? {}
    let pageWidth = Math.max(finiteNumberOrNull(contentSize.width) ?? 0, viewportWidth)
    let pageHeight = Math.max(finiteNumberOrNull(contentSize.height) ?? 0, viewportHeight)
    const plannedWidth = pageWidth
    const plannedHeight = pageHeight
    pageWidth = Math.min(pageWidth, Math.floor(PAGE_CAPTURE_DEFAULTS.maxScreenshotDeviceWidth / deviceScaleFactor))
    pageHeight = Math.min(pageHeight, Math.floor(PAGE_CAPTURE_DEFAULTS.maxScreenshotDeviceHeight / deviceScaleFactor))
    if (pageWidth !== plannedWidth || pageHeight !== plannedHeight) {
      warnings.push(
        `全页尺寸 ${Math.round(plannedWidth)}x${Math.round(plannedHeight)} CSS px 超过截图纹理上限，` +
          `已截断到 ${pageWidth}x${pageHeight}（deviceScaleFactor=${deviceScaleFactor}）`,
      )
    }
    const totalDevicePixels = pageWidth * pageHeight * deviceScaleFactor * deviceScaleFactor
    if (totalDevicePixels > PAGE_CAPTURE_DEFAULTS.maxFullPageDevicePixels) {
      const ratio = Math.sqrt(PAGE_CAPTURE_DEFAULTS.maxFullPageDevicePixels / totalDevicePixels)
      const cappedHeight = Math.max(240, Math.floor(pageHeight * ratio))
      warnings.push(
        `全页截图像素 ${Math.round(pageWidth * deviceScaleFactor)}x${Math.round(pageHeight * deviceScaleFactor)} 过大，` +
          `按内存上限截断到 ${Math.round(pageWidth * deviceScaleFactor)}x${Math.round(cappedHeight * deviceScaleFactor)}`,
      )
      pageHeight = cappedHeight
    }
    const fullPngPath = join(outDir, 'full-page.png')
    const fullScreenshot = await captureScreenshotBuffer(client, {
      clip: { x: 0, y: 0, width: round(pageWidth, 3), height: round(pageHeight, 3), scale: 1 },
      timeoutMs: screenshotTimeoutMs,
    })
    await writeFile(fullPngPath, fullScreenshot)
    const fullDimensions = pngDimensions(fullScreenshot)
    const expectedFullWidth = Math.max(1, Math.round(pageWidth * deviceScaleFactor))
    const expectedFullHeight = Math.max(1, Math.round(pageHeight * deviceScaleFactor))
    if (Math.abs(fullDimensions.width - expectedFullWidth) > 1 || Math.abs(fullDimensions.height - expectedFullHeight) > 1) {
      warnings.push(
        `全页截图尺寸 ${fullDimensions.width}x${fullDimensions.height} 与预期 ${expectedFullWidth}x${expectedFullHeight} 不一致` +
          '（页面可能自己改过视口，或截图被浏览器裁切）',
      )
    }
    throwIfAborted(signal)

    // ---- 元素级抠图 --------------------------------------------------------
    const plannedCutouts = planElementCutouts(layout, {
      deviceScaleFactor,
      heroScale,
      elementScale,
      maxCutouts,
      minCutoutPx,
      heroSelectors: options.heroSelectors,
    })
    const cutouts = []
    for (const planned of plannedCutouts) {
      throwIfAborted(signal)
      const clip = clampClipToPage(planned.rect, pageWidth, pageHeight)
      if (clip === null) {
        warnings.push(`元素 ${planned.name} 的 rect 不在页面内（${JSON.stringify(planned.rect)}），已跳过`)
        continue
      }
      const outputWidth = Math.max(1, Math.round(clip.width * planned.scale))
      const outputHeight = Math.max(1, Math.round(clip.height * planned.scale))
      const outputPixels = outputWidth * outputHeight
      let clipScale = planned.clipScale
      if (outputPixels > PAGE_CAPTURE_DEFAULTS.maxCutoutDevicePixels) {
        clipScale = round(clipScale * Math.sqrt(PAGE_CAPTURE_DEFAULTS.maxCutoutDevicePixels / outputPixels), 4)
        warnings.push(`元素 ${planned.name} 的 ${outputWidth}x${outputHeight} 抠图过大，已按内存上限降低倍率到 clipScale=${clipScale}`)
      }
      try {
        const png = await captureScreenshotBuffer(client, {
          clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clipScale },
          timeoutMs: screenshotTimeoutMs,
        })
        const dimensions = pngDimensions(png)
        const pngPath = join(outDir, `${planned.name}.png`)
        await writeFile(pngPath, png)
        cutouts.push({
          name: planned.name,
          selector: planned.selector,
          rect: clip,
          scale: planned.scale,
          clipScale,
          pixelWidth: dimensions.width,
          pixelHeight: dimensions.height,
          pngPath,
          bytes: png.length,
          isHero: planned.isHero,
        })
      } catch (error) {
        warnings.push(`元素 ${planned.name}（${planned.selector ?? 'unknown'}）抠图失败：${firstLine(error instanceof Error ? error.message : String(error))}`)
      }
    }
    const captureMs = Date.now() - captureStartedAt
    throwIfAborted(signal)

    const heroCount = layout.elements.filter((element) => element?.isHero === true).length
    return {
      fullPngPath,
      layoutPath,
      cutouts,
      warnings,
      browser,
      url,
      viewport: { width: viewportWidth, height: viewportHeight, deviceScaleFactor },
      page: { width: round(plannedWidth, 3), height: round(plannedHeight, 3) },
      layoutSummary: {
        elementCount: layout.elements.length,
        heroCount,
        fonts: layout.tokens.fonts.length,
        colors: layout.tokens.colors.length,
      },
      timings: {
        launchMs: launched.launchMs,
        setupMs,
        captureMs,
        totalMs: Date.now() - totalStartedAt,
      },
    }
  } finally {
    try {
      await stopCaptureBrowser(launched, client)
    } catch {
      // 清理失败不能掩盖原始错误。
    }
    await removeDirectory(profileDir)
    if (ownsWorkDir) await removeDirectory(workDir)
  }
}

/** 页面就绪表达式：等字体 + 两帧 rAF + 固定 settleMs，然后滚回顶部（坐标从 0 起算）。 */
function pagePrepareExpression(settleMs) {
  const wait = Math.max(0, Math.round(settleMs))
  return `(async () => {
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  } catch (error) {}
  try { window.scrollTo(0, 0); } catch (error) {}
  await new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(true); }); }); });
  await new Promise(function (resolve) { setTimeout(function () { resolve(true); }, ${wait}); });
  return true;
})()`
}

/** 执行页面表达式并返回 by-value 结果。 */
async function evaluateValue(client, expression, options = {}) {
  const response = await client.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: options.awaitPromise === true },
    options.timeoutMs ?? 30_000,
  )
  if (response?.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'unknown error'
    throw new Error(`页面执行采集脚本时抛错：${firstLine(detail)}`)
  }
  return response?.result?.value
}

/** Page.captureScreenshot + 校验 PNG 签名，返回 Buffer。 */
async function captureScreenshotBuffer(client, { clip, timeoutMs }) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const screenshot = await client.send(
        'Page.captureScreenshot',
        { format: 'png', fromSurface: true, captureBeyondViewport: true, optimizeForSpeed: false, clip },
        timeoutMs,
      )
      if (typeof screenshot?.data !== 'string' || screenshot.data.length === 0) {
        lastError = new Error('浏览器返回空截图')
      } else {
        return Buffer.from(screenshot.data, 'base64')
      }
    } catch (error) {
      lastError = error
      if (/关闭|closed|detached|crashed|not attached|target.*not found/iu.test(error.message)) break
    }
    await sleep(100 * (attempt + 1))
  }
  throw new Error(`截图失败：${lastError?.message ?? 'unknown error'}`)
}

/** 把 rect 夹回页面范围；完全在页面外返回 null。 */
function clampClipToPage(rect, pageWidth, pageHeight) {
  const x = Math.max(0, Math.min(rect.x, pageWidth))
  const y = Math.max(0, Math.min(rect.y, pageHeight))
  const width = Math.min(rect.width, pageWidth - x)
  const height = Math.min(rect.height, pageHeight - y)
  if (width < 1 || height < 1) return null
  return { x: round(x, 3), y: round(y, 3), width: round(width, 3), height: round(height, 3) }
}

/** 校验并规整页面返回的 layout（页面数据不可信：只保留 JSON 形状字段）。 */
function normaliseLayout(value, meta) {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.elements)) {
    throw new Error('页面布局采集脚本没有返回合法 layout（缺少 elements 数组）；页面可能不是 HTML 或脚本被 CSP 拦截')
  }
  const elements = []
  for (const raw of value.elements.slice(0, 2000)) {
    if (raw === null || typeof raw !== 'object') continue
    const rect = normaliseRect(raw.rect)
    const offset = raw.offset !== null && typeof raw.offset === 'object'
      ? { width: Math.max(0, finiteNumberOrNull(raw.offset.width) ?? 0), height: Math.max(0, finiteNumberOrNull(raw.offset.height) ?? 0) }
      : { width: 0, height: 0 }
    elements.push({
      index: clampInt(raw.index, elements.length, 0, 100_000),
      selector: typeof raw.selector === 'string' ? raw.selector.slice(0, 300) : null,
      tag: typeof raw.tag === 'string' ? raw.tag.slice(0, 40) : null,
      id: typeof raw.id === 'string' ? raw.id.slice(0, 120) : null,
      classes: normaliseTextArray(raw.classes).slice(0, 12),
      text: typeof raw.text === 'string' ? raw.text.slice(0, 200) : null,
      role: typeof raw.role === 'string' ? raw.role.slice(0, 60) : null,
      ariaLabel: typeof raw.ariaLabel === 'string' ? raw.ariaLabel.slice(0, 120) : null,
      isHero: raw.isHero === true,
      heroFallback: raw.heroFallback === true,
      source: typeof raw.source === 'string' ? raw.source : null,
      visible: raw.visible !== false,
      rect: rect ?? { x: 0, y: 0, width: 0, height: 0 },
      viewportRect: normaliseRect(raw.viewportRect) ?? { x: 0, y: 0, width: 0, height: 0 },
      offset,
      layoutScale: {
        x: finiteNumberOrNull(raw.layoutScale?.x),
        y: finiteNumberOrNull(raw.layoutScale?.y),
      },
      style: normaliseStyle(raw.style),
    })
  }
  const tokensRaw = value.tokens !== null && typeof value.tokens === 'object' ? value.tokens : {}
  const customProperties = {}
  if (tokensRaw.customProperties !== null && typeof tokensRaw.customProperties === 'object') {
    for (const [name, val] of Object.entries(tokensRaw.customProperties).slice(0, 80)) {
      if (typeof name === 'string' && name.startsWith('--') && typeof val === 'string') customProperties[name] = val.slice(0, 120)
    }
  }
  return {
    schema: 'media-senses.page-layout/v1',
    url: typeof value.url === 'string' ? value.url : meta.url,
    title: typeof value.title === 'string' ? value.title.slice(0, 200) : '',
    deviceScaleFactor: finiteNumberOrNull(value.deviceScaleFactor) ?? meta.deviceScaleFactor,
    devicePixelRatio: finiteNumberOrNull(value.devicePixelRatio),
    viewport: {
      width: finiteNumberOrNull(value.viewport?.width) ?? meta.viewportWidth,
      height: finiteNumberOrNull(value.viewport?.height) ?? meta.viewportHeight,
      scrollX: finiteNumberOrNull(value.viewport?.scrollX) ?? 0,
      scrollY: finiteNumberOrNull(value.viewport?.scrollY) ?? 0,
    },
    page: {
      width: Math.max(1, finiteNumberOrNull(value.page?.width) ?? meta.viewportWidth),
      height: Math.max(1, finiteNumberOrNull(value.page?.height) ?? meta.viewportHeight),
    },
    elements,
    tokens: {
      fonts: normaliseTextArray(tokensRaw.fonts).slice(0, 12),
      fontSizes: Array.isArray(tokensRaw.fontSizes)
        ? tokensRaw.fontSizes.map((value) => finiteNumberOrNull(value)).filter((value) => value !== null).slice(0, 24)
        : [],
      colors: normaliseTextArray(tokensRaw.colors).slice(0, 24),
      backgrounds: normaliseTextArray(tokensRaw.backgrounds).slice(0, 24),
      radii: normaliseTextArray(tokensRaw.radii).slice(0, 12),
      customProperties,
    },
  }
}

function normaliseStyle(raw) {
  if (raw === null || typeof raw !== 'object') return {}
  const style = {}
  const stringKeys = ['display', 'visibility', 'position', 'fontFamily', 'lineHeightRaw', 'color', 'backgroundColor', 'borderRadiusRaw', 'textAlign', 'zIndex', 'transform', 'boxShadow']
  for (const key of stringKeys) {
    if (typeof raw[key] === 'string' && raw[key].length > 0) style[key] = raw[key].slice(0, 200)
  }
  const numberKeys = ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'borderRadius', 'opacity']
  for (const key of numberKeys) {
    const value = finiteNumberOrNull(raw[key])
    if (value !== null) style[key] = value
  }
  return style
}

export default {
  PAGE_CAPTURE_DEFAULTS,
  buildCaptureScript,
  planElementCutouts,
  layoutToCamera,
  capturePage,
}
