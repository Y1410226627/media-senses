/**
 * Pre-render layout lint for the reproduction pipeline.
 *
 * The builder silently auto-shrinks over-long titles and silently drops invalid
 * captions, which is good for robustness but terrible for teaching a model how to
 * write a RenderPlan. This module does the check *before* rendering and returns
 * actionable Chinese findings, so the model can fix the plan (or the HTML source)
 * instead of discovering the problem after a 20-second encode.
 *
 * Two entry points:
 * - `lintPlan(plan, {width, height})`  -> RenderPlan (lib/build.js contract) checks
 * - `lintAnimationSource(source, {duration})` -> HTML/CSS/Canvas animation checks
 *   for the `window.renderAt(t)` / declarative-clip contract used by media_animate
 *
 * Everything is static: no ffmpeg, no randomness, no clock reads. The same input
 * always produces an identical violation list (same order, same messages), which
 * is what makes the model's retry loop testable.
 *
 * Width estimation is deliberately simple and conservative ("中文字宽≈1em、
 * 拉丁≈0.55em"), matching CONTRACT-V2's lint rule rather than the finer per-glyph
 * table in lib/build.js: lint only needs a stable estimate that errs on the safe
 * side.
 */

/** Text may not use more than this share of the frame width (CONTRACT-V2). */
export const TEXT_MAX_WIDTH_SHARE = 0.86
/** Text may not use more than this share of the frame height (CONTRACT-V2). */
export const TEXT_MAX_HEIGHT_SHARE = 0.78
/** A rendered glyph size below this share of the frame height is too small. */
export const MIN_FONT_HEIGHT_SHARE = 0.03
/** Inline font-size must reach this share of the composition short side. */
export const MIN_ANIMATION_FONT_SHARE = 0.026
/** Captions keep an 8% margin from the frame edge (lib/build.js). */
export const CAPTION_MARGIN_SHARE = 0.08

export const DEFAULT_WIDTH = 1080
export const DEFAULT_HEIGHT = 1920

/** Transition duration assumed when a plan omits it (lib/build.js default). */
const DEFAULT_TRANSITION_SECONDS = 0.5
/** lib/build.js derives subtitle size as 58% of the title size. */
const SUBTITLE_SIZE_RATIO = 0.58
/** lib/build.js line-height factors for titles / subtitles. */
const TITLE_LINE_HEIGHT = 1.3
const SUBTITLE_LINE_HEIGHT = 1.34
const CAPTION_LINE_HEIGHT = 1.3
/** Lower bound used when suggesting a smaller/less-wide title. */
const MIN_SUGGESTED_FONT = 12

const ENERGY = Object.freeze({ error: 'error', warn: 'warn' })
const SCENE_TYPES = new Set(['text', 'image', 'color', 'gradient', 'video'])

/* ------------------------------------------------------------------ *
 * shared helpers
 * ------------------------------------------------------------------ */

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function positiveNumber(value) {
  const number = finiteNumber(value)
  return number !== null && number > 0 ? number : null
}

function round(value) {
  return Math.round(value)
}

function percent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`
}

/** Split on `\n`, trim, drop empty lines (same semantics as lib/build.js). */
function splitLines(text) {
  if (typeof text !== 'string') return []
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** CJK / kana / fullwidth ranges render at roughly one em. */
function isWideChar(codePoint) {
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  )
}

/** Width in em units: CJK=1, space≈0.28, Latin≈0.55 (contract rule). */
function charWidthEm(codePoint) {
  if (codePoint <= 0x1f) return 0
  if (codePoint === 0x20) return 0.28
  if (isWideChar(codePoint)) return 1
  return 0.55
}

/** Estimated rendered width in pixels for one line at `fontSize` px. */
export function estimateLineWidthPx(text, fontSize) {
  if (typeof text !== 'string' || !(Number.isFinite(fontSize) && fontSize > 0)) return 0
  let em = 0
  for (const char of text) em += charWidthEm(char.codePointAt(0))
  // 1.02 covers the letter-spacing the renderer adds implicitly; erring high is
  // safe for a pre-render lint.
  return em * fontSize * 1.02
}

/** Greedy character wrap by estimated pixel width (used for caption bands only). */
function wrapByWidth(text, fontSize, maxWidth) {
  const lines = []
  for (const paragraph of splitLines(text)) {
    let current = ''
    for (const char of paragraph) {
      const next = current + char
      if (current.length > 0 && estimateLineWidthPx(next, fontSize) > maxWidth) {
        lines.push(current)
        current = char
      } else {
        current = next
      }
    }
    if (current.length > 0) lines.push(current)
  }
  return lines.length > 0 ? lines : [' ']
}

/** Infer a scene type the same way lib/build.js does when `type` is missing. */
function inferSceneType(scene) {
  const explicit = typeof scene.type === 'string' ? scene.type.trim().toLowerCase() : ''
  if (SCENE_TYPES.has(explicit)) return explicit
  if (typeof scene.text === 'string' && scene.text.trim().length > 0) return 'text'
  if (typeof scene.subtitle === 'string' && scene.subtitle.trim().length > 0) return 'text'
  if (typeof scene.src === 'string' && scene.src.trim().length > 0) return 'image'
  if (Array.isArray(scene.gradient)) return 'gradient'
  return 'color'
}

/** Build one violation record with the contract shape. */
function violation(code, severity, messageZh, scene = null, where = 'plan') {
  return {
    code,
    severity: ENERGY[severity] ?? 'warn',
    messageZh,
    scene,
    where,
  }
}

/**
 * Contract timeline arithmetic (identical to lib/build.js::computeTimeline).
 *
 * @param {Array<object>} scenes
 * @returns {Array<{start: number, end: number}>}
 */
function computeSceneWindows(scenes) {
  const windows = []
  let end = 0
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index] ?? {}
    const duration = finiteNumber(scene.duration)
    const safeDuration = duration !== null && duration > 0 ? duration : 0
    const gradual = index > 0 &&
      typeof scene.transitionIn === 'string' &&
      scene.transitionIn.trim().toLowerCase() !== 'cut' &&
      scene.transitionIn.trim().length > 0
    const requested = finiteNumber(scene.transitionDuration)
    const transition = gradual ? (requested !== null && requested > 0 ? requested : DEFAULT_TRANSITION_SECONDS) : 0
    end += safeDuration - transition
    windows.push({ start: Math.max(0, end - safeDuration), end })
  }
  return windows
}

/** Geometry of a scene's title/subtitle block, mirroring lib/build.js layout. */
function textBlockGeometry(scene, width, height) {
  const lines = splitLines(scene.text)
  const subtitleLines = splitLines(scene.subtitle)
  const scale = width / DEFAULT_WIDTH
  const requestedFontSize = positiveNumber(scene.fontSize)
  const planFontSize = requestedFontSize ?? 96
  const titlePx = Math.round(planFontSize * scale)
  const titleLineHeight = round(titlePx * TITLE_LINE_HEIGHT)
  const subtitlePx = Math.round(titlePx * SUBTITLE_SIZE_RATIO)
  const subtitleLineHeight = round(subtitlePx * SUBTITLE_LINE_HEIGHT)
  const gap = subtitleLines.length > 0 ? round(titlePx * 0.3) : 0
  const blockHeight = lines.length * titleLineHeight + gap + subtitleLines.length * subtitleLineHeight
  const align = typeof scene.align === 'string' ? scene.align.trim().toLowerCase() : 'center'
  const top = align === 'bottom'
    ? round(height - height * 0.12 - blockHeight)
    : round((height - blockHeight) / 2)
  const widestTitle = lines.reduce((max, line) => Math.max(max, estimateLineWidthPx(line, titlePx)), 0)
  const widestSubtitle = subtitleLines.reduce((max, line) => Math.max(max, estimateLineWidthPx(line, subtitlePx)), 0)
  return {
    planFontSize,
    titlePx,
    subtitlePx,
    titleLineHeight,
    subtitleLineHeight,
    lineCount: lines.length,
    subtitleLineCount: subtitleLines.length,
    blockHeight,
    top,
    bottom: top + blockHeight,
    widest: Math.max(widestTitle, widestSubtitle),
    hasSubtitle: subtitleLines.length > 0,
  }
}

/** Geometry of one caption block (wrapped lines inside the safe width). */
function captionBlockGeometry(caption, width, height) {
  const scale = width / DEFAULT_WIDTH
  const requested = positiveNumber(caption.fontSize)
  const planFontSize = requested ?? 44
  const fontSizePx = round(planFontSize * scale)
  const maxWidth = width * (1 - 2 * CAPTION_MARGIN_SHARE)
  const lines = wrapByWidth(typeof caption.text === 'string' ? caption.text : '', fontSizePx, maxWidth)
  const lineHeight = round(fontSizePx * CAPTION_LINE_HEIGHT)
  const blockHeight = lines.length * lineHeight
  const margin = round(height * CAPTION_MARGIN_SHARE)
  const position = typeof caption.position === 'string' ? caption.position.trim().toLowerCase() : 'bottom'
  let top
  if (position === 'top') top = margin
  else if (position === 'center') top = round((height - blockHeight) / 2)
  else top = height - margin - blockHeight
  return { planFontSize, fontSizePx, lines, lineHeight, blockHeight, top, bottom: top + blockHeight }
}

/* ------------------------------------------------------------------ *
 * RenderPlan lint
 * ------------------------------------------------------------------ */

/**
 * Lint a RenderPlan before rendering.
 *
 * Rules (CONTRACT-V2 / M4+M5):
 * - `emptyPlan`            no scenes to render (error)
 * - `badDuration`          a scene duration is not a positive number (error)
 * - `badScene`             a scene entry is not an object (error)
 * - `tooSmall`             rendered title/caption size < 3% of frame height (warn)
 * - `textWidthOverflow`    estimated line width > 0.86 * width (error)
 * - `textHeightOverflow`   estimated text block height > 0.78 * height (error)
 * - `overlap`              a caption overlaps a text scene in time AND in y-band (warn)
 * - `badCaption`           a caption entry is unusable / its time window is invalid (warn)
 *
 * @param {object} plan RenderPlan
 * @param {{width?: number, height?: number}} [options] frame size override
 * @returns {Array<{code: string, severity: 'error'|'warn', messageZh: string, scene: number|null, where: string}>}
 */
export function lintPlan(plan, options = {}) {
  const violations = []
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    return [
      violation(
        'emptyPlan',
        'error',
        '没有拿到 RenderPlan 对象：先写出 {output, width, height, scenes}，再用 media_build_video 渲染。',
        null,
        'plan',
      ),
    ]
  }

  const width = positiveNumber(options.width) ?? positiveNumber(plan.width) ?? DEFAULT_WIDTH
  const height = positiveNumber(options.height) ?? positiveNumber(plan.height) ?? DEFAULT_HEIGHT
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : []
  if (scenes.length === 0) {
    violations.push(
      violation(
        'emptyPlan',
        'error',
        'scenes 为空：至少需要一个场景（text/image/color/gradient/video）才能渲染。',
        null,
        'plan.scenes',
      ),
    )
    return violations
  }

  const windows = computeSceneWindows(scenes)
  const sceneBands = []

  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index]
    const at = `scenes[${index}]`
    if (scene === null || typeof scene !== 'object' || Array.isArray(scene)) {
      violations.push(
        violation('badScene', 'error', `场景 ${index + 1} 不是对象：每个场景至少要写 {type, duration}。`, index, at),
      )
      continue
    }
    const duration = finiteNumber(scene.duration)
    if (duration === null || duration <= 0) {
      violations.push(
        violation(
          'badDuration',
          'error',
          `场景 ${index + 1} 的 duration=${JSON.stringify(scene.duration)} 不是正数：渲染会直接失败，改成 > 0 的秒数（推荐 ≥ 0.2）。`,
          index,
          `${at}.duration`,
        ),
      )
    }

    const type = inferSceneType(scene)
    if (type !== 'text') continue

    const geometry = textBlockGeometry(scene, width, height)
    const safeWidth = width * TEXT_MAX_WIDTH_SHARE
    const safeHeight = height * TEXT_MAX_HEIGHT_SHARE

    // tooSmall: the declared title size, after scaling to the actual width.
    if (geometry.titlePx / height < MIN_FONT_HEIGHT_SHARE) {
      const minPlanFont = Math.ceil((MIN_FONT_HEIGHT_SHARE * height * DEFAULT_WIDTH) / width - 1e-9)
      violations.push(
        violation(
          'tooSmall',
          'warn',
          `场景 ${index + 1} 的标题实际字号约 ${geometry.titlePx}px（占画面高度 ${percent(geometry.titlePx / height)}），低于 ${percent(MIN_FONT_HEIGHT_SHARE)} 安全线：小屏和缩略图会看不清。建议把 fontSize 从 ${geometry.planFontSize} 提到 ≥ ${minPlanFont}（相对 1080 宽）。`,
          index,
          `${at}.fontSize`,
        ),
      )
    }

    if (geometry.widest > safeWidth) {
      const suggestedFont = Math.max(
        MIN_SUGGESTED_FONT,
        Math.floor((geometry.planFontSize * safeWidth) / geometry.widest),
      )
      violations.push(
        violation(
          'textWidthOverflow',
          'error',
          `场景 ${index + 1} 的文字最宽约 ${round(geometry.widest)}px，超过安全宽度 ${round(safeWidth)}px（${TEXT_MAX_WIDTH_SHARE}×${width}）：会被裁掉或强制缩字号。建议把 fontSize 从 ${geometry.planFontSize} 降到 ≤ ${suggestedFont}，或在文本里用 \\n 主动换行。`,
          index,
          `${at}.text`,
        ),
      )
    }

    if (geometry.blockHeight > safeHeight) {
      const suggestedLines = Math.max(
        1,
        Math.floor(safeHeight / Math.max(1, geometry.titleLineHeight)),
      )
      violations.push(
        violation(
          'textHeightOverflow',
          'error',
          `场景 ${index + 1} 的文字块高约 ${round(geometry.blockHeight)}px，超过安全高度 ${round(safeHeight)}px（${TEXT_MAX_HEIGHT_SHARE}×${height}）：标题+副标题会溢出。建议把行数压到 ≤ ${suggestedLines} 行或缩小字号（当前 ${geometry.titlePx}px）。`,
          index,
          `${at}.text`,
        ),
      )
    }

    sceneBands.push({ index, band: { top: geometry.top, bottom: geometry.bottom }, window: windows[index] })
  }

  // Captions: individual checks first, then the time-and-space overlap rule.
  const captions = Array.isArray(plan.captions) ? plan.captions : []
  const validCaptions = []
  for (let index = 0; index < captions.length; index += 1) {
    const caption = captions[index]
    const at = `captions[${index}]`
    if (caption === null || typeof caption !== 'object' || Array.isArray(caption)) {
      violations.push(
        violation('badCaption', 'warn', `字幕 ${index + 1} 不是对象：应为 {start, end, text}。`, null, at),
      )
      continue
    }
    const start = finiteNumber(caption.start)
    const end = finiteNumber(caption.end)
    if (start === null || end === null || end <= start) {
      violations.push(
        violation(
          'badDuration',
          'warn',
          `字幕 ${index + 1} 的时间窗无效（start=${JSON.stringify(caption.start)}, end=${JSON.stringify(caption.end)}）：buildVideo 会丢弃它。改成 end > start 的秒数。`,
          null,
          `${at}.start`,
        ),
      )
      continue
    }
    if (typeof caption.text !== 'string' || caption.text.trim().length === 0) {
      violations.push(violation('badCaption', 'warn', `字幕 ${index + 1} 没有文字：会被丢弃。`, null, `${at}.text`))
      continue
    }
    const geometry = captionBlockGeometry(caption, width, height)
    if (geometry.fontSizePx / height < MIN_FONT_HEIGHT_SHARE) {
      const minPlanFont = Math.ceil((MIN_FONT_HEIGHT_SHARE * height * DEFAULT_WIDTH) / width - 1e-9)
      violations.push(
        violation(
          'tooSmall',
          'warn',
          `字幕 ${index + 1} 实际字号约 ${geometry.fontSizePx}px（占画面高度 ${percent(geometry.fontSizePx / height)}），低于 ${percent(MIN_FONT_HEIGHT_SHARE)} 安全线。建议把 fontSize 从 ${geometry.planFontSize} 提到 ≥ ${minPlanFont}。`,
          null,
          `${at}.fontSize`,
        ),
      )
    }
    validCaptions.push({ index, caption, start, end, band: { top: geometry.top, bottom: geometry.bottom } })
  }

  for (const entry of validCaptions) {
    for (const sceneBand of sceneBands) {
      const sceneWindow = sceneBand.window ?? { start: 0, end: 0 }
      const timeOverlap = entry.start < sceneWindow.end - 1e-9 && entry.end > sceneWindow.start + 1e-9
      if (!timeOverlap) continue
      const verticalOverlap =
        entry.band.top < sceneBand.band.bottom - 1e-9 && entry.band.bottom > sceneBand.band.top + 1e-9
      if (!verticalOverlap) continue
      const position = typeof entry.caption.position === 'string' ? entry.caption.position : 'bottom'
      violations.push(
        violation(
          'overlap',
          'warn',
          `字幕 ${entry.index + 1}（${entry.start.toFixed(1)}–${entry.end.toFixed(1)}s，${position}）与场景 ${sceneBand.index + 1} 的标题区在时间（${sceneBand.window.start.toFixed(1)}–${sceneBand.window.end.toFixed(1)}s）和画面上都重叠：两段文字会挤在一起。建议把字幕 start 挪到 ${sceneBand.window.end.toFixed(1)}s 之后，或把 position 改成不冲突的位置。`,
          sceneBand.index,
          `captions[${entry.index}]`,
        ),
      )
    }
  }

  return violations
}

/* ------------------------------------------------------------------ *
 * HTML / CSS / Canvas animation source lint
 * ------------------------------------------------------------------ */

/** Detect the renderAt export contract in any of its common spellings. */
function hasRenderAtContract(source) {
  const patterns = [
    /(?:window\s*\.\s*)?\brenderAt\s*=/u,
    /\bfunction\s+renderAt\s*\(/u,
    /\brenderAt\s*:\s*(?:async\s*)?(?:function|\(|async)/u,
  ]
  return patterns.some((pattern) => pattern.test(source))
}

/** Declarative clips need both a composition root and per-clip start times. */
function hasDeclarativeClips(source) {
  return /data-composition-id/u.test(source) && /data-start/u.test(source)
}

/** Resolve composition dimensions for the tiny-font check; null = cannot estimate. */
function resolveAnimationDimensions(source, options) {
  const optionWidth = positiveNumber(options.width)
  const optionHeight = positiveNumber(options.height)
  if (optionWidth !== null && optionHeight !== null) return { width: optionWidth, height: optionHeight }
  const dataWidth = /data-width\s*=\s*["']?(\d+(?:\.\d+)?)/iu.exec(source)
  const dataHeight = /data-height\s*=\s*["']?(\d+(?:\.\d+)?)/iu.exec(source)
  if (dataWidth !== null && dataHeight !== null) {
    const width = Number.parseFloat(dataWidth[1])
    const height = Number.parseFloat(dataHeight[1])
    if (width > 0 && height > 0) return { width, height }
  }
  // Literal CSS width/height (also matches `style="width:1080px;..."` where the
  // value starts right after the attribute quote, not after ';' or '{').
  const cssWidth = /(?:^|[;{\s"'])width\s*:\s*(\d{2,5})px/iu.exec(source)
  const cssHeight = /(?:^|[;{\s"'])height\s*:\s*(\d{2,5})px/iu.exec(source)
  if (cssWidth !== null && cssHeight !== null) {
    const width = Number.parseFloat(cssWidth[1])
    const height = Number.parseFloat(cssHeight[1])
    if (width > 0 && height > 0) return { width, height }
  }
  return null
}

/** 1-based line number of a character offset, for stable `where` labels. */
function lineNumberAt(source, offset) {
  let line = 1
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10 /* \n */) line += 1
  }
  return line
}

/**
 * Lint an HTML/CSS/Canvas animation source before handing it to `media_animate`.
 *
 * Rules (M4+M5):
 * - `noContract`      neither window.renderAt, declarative clips, nor __timelines
 * - `mediaNoStart`    <audio>/<video> without data-start
 * - `tinyFont`        inline literal font-size < 2.6% of the composition short side
 *
 * The tiny-font rule only fires when the composition size can be estimated
 * (options.width/height, data-width/data-height, or literal CSS width/height in
 * px). When the size is unknowable it stays silent — a false positive here would
 * make the model "fix" a font that was fine.
 *
 * @param {string} source animation source text
 * @param {{duration?: number, width?: number, height?: number}} [options]
 * @returns {Array<{code: string, severity: 'error'|'warn', messageZh: string, scene: null, where: string}>}
 */
export function lintAnimationSource(source, options = {}) {
  const text = typeof source === 'string' ? source : ''
  if (text.trim().length === 0) {
    return [
      violation(
        'noContract',
        'error',
        '源码为空：media_animate 需要一段实现 window.renderAt(t) 的 HTML（或带 data-composition-id/data-start 的声明式 clip）。',
        null,
        'source',
      ),
    ]
  }
  const violations = []
  const renderAt = hasRenderAtContract(text)
  const declarative = hasDeclarativeClips(text)
  const timelines = /__timelines/u.test(text)
  if (!renderAt && !declarative && !timelines) {
    violations.push(
      violation(
        'noContract',
        'error',
        '没有找到渲染契约：页面既没有 window.renderAt(t)，也没有 [data-composition-id] + [data-start] 声明式 clip，也没有 window.__timelines。media_animate 无法逐帧定位，会渲染失败。二选一补上：① window.renderAt = t => draw(t)；② 给根节点加 data-composition-id 并给 clip 加 data-start/data-duration。',
        null,
        'source',
      ),
    )
  }

  // Media elements must declare when they start; otherwise their audio either
  // plays from 0 or is ignored by the compositor.
  const mediaPattern = /<(audio|video)\b([^>]*)>/giu
  let mediaMatch
  const seenMedia = []
  while ((mediaMatch = mediaPattern.exec(text)) !== null) {
    const tag = mediaMatch[1].toLowerCase()
    const attributes = mediaMatch[2] ?? ''
    seenMedia.push(tag)
    if (/data-start\s*=/iu.test(attributes)) continue
    violations.push(
      violation(
        'mediaNoStart',
        'warn',
        `<${tag}> 没有 data-start：合成内音频不知道从第几秒开始，会被忽略或从 0 秒全部叠上。补上 data-start="1.2"（以及 data-duration）。`,
        null,
        `line:${lineNumberAt(text, mediaMatch.index)}`,
      ),
    )
  }

  // Tiny inline fonts: only literal px values, only when the composition size is
  // known. Values like clamp()/vw/%/em cannot be resolved statically -> skip.
  const dimensions = resolveAnimationDimensions(text, options)
  if (dimensions !== null) {
    const shortSide = Math.min(dimensions.width, dimensions.height)
    const threshold = shortSide * MIN_ANIMATION_FONT_SHARE
    const stylePattern = /style\s*=\s*(["'])(.*?)\1/gisu
    let styleMatch
    const tinyFonts = new Map()
    while ((styleMatch = stylePattern.exec(text)) !== null) {
      const styleText = styleMatch[2] ?? ''
      const fontPattern = /font-size\s*:\s*(\d+(?:\.\d+)?)px/giu
      let fontMatch
      while ((fontMatch = fontPattern.exec(styleText)) !== null) {
        const px = Number.parseFloat(fontMatch[1])
        if (!Number.isFinite(px) || px >= threshold) continue
        const key = String(px)
        const current = tinyFonts.get(key) ?? { px, count: 0, where: `line:${lineNumberAt(text, styleMatch.index)}` }
        current.count += 1
        tinyFonts.set(key, current)
      }
    }
    const minPlanPx = Math.ceil(threshold * 10) / 10
    for (const entry of [...tinyFonts.values()].sort((a, b) => a.px - b.px)) {
      violations.push(
        violation(
          'tinyFont',
          'warn',
          `内联 font-size:${entry.px}px 只有合成短边 ${shortSide}px 的 ${percent(entry.px / shortSide, 2)}，低于 ${percent(MIN_ANIMATION_FONT_SHARE, 1)}：成片里小字会糊成噪点。建议 ≥ ${minPlanPx}px（${entry.count} 处命中）。`,
          null,
          entry.where,
        ),
      )
    }
  }

  return violations
}

/**
 * Convenience summary for tool reports.
 *
 * @param {Array<object>} violations
 * @returns {{ok: boolean, errors: number, warnings: number, codes: string[]}}
 */
export function summariseLint(violations) {
  const list = Array.isArray(violations) ? violations : []
  const errors = list.filter((item) => item.severity === 'error').length
  const warnings = list.filter((item) => item.severity === 'warn').length
  const codes = [...new Set(list.map((item) => item.code))]
  return { ok: errors === 0, errors, warnings, codes }
}

export default {
  TEXT_MAX_WIDTH_SHARE,
  TEXT_MAX_HEIGHT_SHARE,
  MIN_FONT_HEIGHT_SHARE,
  MIN_ANIMATION_FONT_SHARE,
  CAPTION_MARGIN_SHARE,
  estimateLineWidthPx,
  lintPlan,
  lintAnimationSource,
  summariseLint,
}
