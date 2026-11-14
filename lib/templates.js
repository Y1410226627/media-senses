/**
 * Runnable animation templates: fill in the content, render, done.
 *
 * The vocabulary modules answer "what numbers should this effect use". That is
 * still a long way from a working HTML page: a model has to remember the
 * `renderAt(t)` contract, keep everything a pure function of `t`, avoid rAF,
 * and get the layering right. Each template here is a complete, already-working
 * page for one of the common effect families, parameterised by a small JSON
 * block so the caller only supplies content.
 *
 * Design notes:
 * - A template reads `window.__MS_TEMPLATE` (injected by {@link fillTemplate})
 *   and merges it over its own DEFAULTS, so every knob is overridable without
 *   touching the markup.
 * - Templates live in `assets/templates/*.html`, not in this module: they are
 *   page sources, and keeping them as files means a person can open one and see
 *   the whole thing.
 * - Every template must satisfy the same contract the renderer enforces:
 *   `window.renderAt(t)` is a pure function of `t`, no unseeded randomness, no
 *   timers, no rAF. The test suite renders each one and asserts the frames move.
 *
 * @module lib/templates
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = join(HERE, '..', 'assets', 'templates')

/**
 * Curated metadata. Kept beside the loader rather than inside the HTML so the
 * catalogue can be listed without reading every file.
 *
 * `useWhenZh` is the line a model actually needs: it is the decision rule for
 * picking this template rather than another one.
 */
export const TEMPLATES = Object.freeze([
  {
    id: 'kinetic-type',
    nameZh: '动态字冲击',
    useWhenZh: '一句短文案要砸进观众眼里：金句、副歌、开场三个词。不适合长句——字越多，逐字入场越躁。',
    params: ['words[]', 'tag', 'accent', 'bg', 'ink', 'heroSize', 'stagger', 'holdAt', 'overshoot'],
    seconds: [3, 6],
    energy: 'high',
    techniques: ['逐字入场', '过冲回落', '模糊清焦', '落定后完全静止'],
  },
  {
    id: 'mask-reveal',
    nameZh: '遮罩揭开标题',
    useWhenZh: '标题需要「被揭开」而不是「淡入」：品牌字标、章节卡。一块实色扫过去再退开，字本身不动。',
    params: ['text', 'bg', 'ink', 'accent', 'size', 'sweep', 'direction'],
    seconds: [3, 5],
    energy: 'medium',
    techniques: ['遮罩扫过', '边缘揭示', '横线自画'],
  },
  {
    id: 'hand-drawn-line',
    nameZh: '手绘描线',
    useWhenZh: '讲解类内容要有手绘感：一笔一笔画出房子/箭头/示意图。关键是描线 + 线条沸腾，不是「加个纸张纹理」。',
    params: ['caption', 'paper', 'ink', 'accent', 'strokeWidth', 'drawSeconds', 'boilHz', 'boilAmount'],
    seconds: [4, 10],
    energy: 'low',
    techniques: ['stroke-dasharray 描线', '线条沸腾（逐帧抖动）', '纸底'],
  },
  {
    id: 'data-bars',
    nameZh: '数据条增长',
    useWhenZh: '要展示几组可比的数字：条形图、进度对比。数字必须跟着条长一起长，不能先蹦出终值。',
    params: ['title', 'sub', 'rows[{label,value}]', 'accent', 'growSeconds', 'stagger', 'decimals'],
    seconds: [3, 8],
    energy: 'medium',
    techniques: ['错峰增长', '数字与形状同步', '末项强调色'],
  },
  {
    id: 'ui-entrance',
    nameZh: '界面卡片入场',
    useWhenZh: '产品功能/步骤展示：三张卡从下往上依次落定。入场有位移与清焦，落定后不再漂。',
    params: ['cards[{kicker,headline,meta}]', 'bg', 'card', 'ink', 'enter', 'stagger', 'rise'],
    seconds: [3, 7],
    energy: 'medium',
    techniques: ['错峰入场', 'ease-out 长尾', '清焦', '落定静止'],
  },
  {
    id: 'paper-collage',
    nameZh: '纸片拼贴 + 视差推镜',
    useWhenZh: '要一个不靠 3D 的纵深：四层纸片以不同速率漂移，一次慢推就能出空间感。适合叙事开场、地图、场景建立。',
    params: ['paper', 'sky', 'hills', 'town', 'ink', 'accent', 'driftX', 'driftY', 'cameraSeconds'],
    seconds: [5, 12],
    energy: 'low',
    techniques: ['多层视差', '按深度分速率', '纸纹与暗角', '近层微缩放'],
  },
])

const META_BY_ID = new Map(TEMPLATES.map((entry) => [entry.id, entry]))

/** Absolute path of one template file. */
export function templatePath(id) {
  const meta = META_BY_ID.get(id)
  if (meta === undefined) {
    const available = TEMPLATES.map((entry) => entry.id).join(', ')
    throw new Error(`no such template "${id}"; available: ${available}`)
  }
  return join(TEMPLATE_DIR, `${meta.id}.html`)
}

/**
 * Read a template's source.
 *
 * @param {string} id
 * @returns {Promise<{meta: object, html: string, path: string}>}
 */
export async function getTemplate(id) {
  const meta = META_BY_ID.get(id)
  if (meta === undefined) templatePath(id) // throws with the available list
  const path = templatePath(id)
  const html = await readFile(path, 'utf8')
  return { meta, html, path }
}

/** Read every template (used by the tests and by a "list all" action). */
export async function loadTemplates() {
  const loaded = []
  for (const meta of TEMPLATES) {
    const html = await readFile(templatePath(meta.id), 'utf8')
    loaded.push({ meta, html })
  }
  return loaded
}

/**
 * Fill a template's configuration.
 *
 * The parameters are injected as a JSON assignment **before** the template's own
 * script runs, so the template can read them at parse time. Values are escaped so
 * a caption containing `</script>` cannot break out.
 *
 * @param {string} html template source
 * @param {object} [params] values merged over the template's DEFAULTS
 * @param {{duration?: number}} [options]
 * @returns {string} the page source to render
 */
export function fillTemplate(html, params = {}, options = {}) {
  if (typeof html !== 'string' || html.length === 0) throw new Error('fillTemplate: html must be a non-empty string')
  const payload = JSON.stringify(params ?? {})
    // `</script>` inside a string would close the tag early; JSON cannot express
    // the sequence safely, so escape the slash.
    .replace(/<\//gu, '<\\/')
  const duration = Number(options.duration)
  const injected =
    `<script>window.__MS_TEMPLATE = ${payload};` +
    (Number.isFinite(duration) && duration > 0 ? `window.__MS_DURATION = ${duration};` : '') +
    `</script>`
  // Inject right after <body> so document.getElementById works in the page script,
  // and before the template's own <script>.
  const bodyAt = html.indexOf('<body')
  if (bodyAt === -1) return `${injected}\n${html}`
  const bodyEnd = html.indexOf('>', bodyAt)
  if (bodyEnd === -1) return `${injected}\n${html}`
  return `${html.slice(0, bodyEnd + 1)}\n${injected}\n${html.slice(bodyEnd + 1)}`
}

/**
 * List the catalogue, optionally filtered by a free-text query.
 *
 * @param {object} [options]
 * @param {string} [options.query]
 * @param {number} [options.limit]
 */
export function listTemplates(options = {}) {
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 50) : 20
  if (query.length === 0) return TEMPLATES.slice(0, limit)
  const terms = query.split(/[\s,，、]+/u).filter(Boolean)
  const scored = []
  for (const meta of TEMPLATES) {
    const haystack = [meta.id, meta.nameZh, meta.useWhenZh, ...(meta.params ?? []), ...(meta.techniques ?? [])]
      .join(' ')
      .toLowerCase()
    let score = 0
    for (const term of terms) {
      if (meta.id.toLowerCase().includes(term)) score += 40
      if (meta.nameZh.includes(term)) score += 30
      if ((meta.techniques ?? []).some((item) => item.toLowerCase().includes(term))) score += 18
      if (haystack.includes(term)) score += 6
    }
    if (score > 0) scored.push({ meta, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((entry) => entry.meta)
}

/** Render a template catalogue entry as Markdown for the report. */
export function renderTemplateCard(meta) {
  const lines = []
  lines.push(`## ${meta.nameZh}`)
  lines.push('')
  lines.push(`\`${meta.id}\` · 建议 ${meta.seconds[0]}–${meta.seconds[1]} 秒 · 能量 ${meta.energy}`)
  lines.push('')
  lines.push(meta.useWhenZh)
  lines.push('')
  if (Array.isArray(meta.techniques) && meta.techniques.length > 0) {
    lines.push(`技法：${meta.techniques.join(' · ')}`)
    lines.push('')
  }
  lines.push(`可调参数：\`${(meta.params ?? []).join('`, `')}\``)
  return lines.join('\n')
}

export default { TEMPLATES, templatePath, getTemplate, loadTemplates, fillTemplate, listTemplates, renderTemplateCard }
