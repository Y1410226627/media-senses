/**
 * Access to the local `code-animation-prompts` skill library.
 *
 * The skill ships 341 style prompts plus reference stills for generating
 * HTML/Canvas/CSS animations. The plugin treats it as a style catalogue: the
 * model searches for a style, reads its prompt, writes an HTML animation that
 * implements the skill's `window.renderAt(t)` contract, and renders it through
 * `media_animate` into a segment it can splice into `media_build_video`.
 */
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Default location of the skill inside the Harness home. */
export function defaultSkillDir() {
  return join(homedir(), '.dsh', 'skills', 'code-animation-prompts')
}

/** Resolve the configured skill directory, falling back to the default. */
export function resolveSkillDir(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    const value = configured.trim()
    return isAbsolute(value) ? value : join(homedir(), value)
  }
  return defaultSkillDir()
}

const catalogCache = new Map()

/**
 * Load and cache `references/catalog.json`.
 *
 * @param {string} skillDir
 * @returns {Promise<{total: number, withStill: number, series: Array<{id: string, name: string, count: number}>, entries: Array<object>}>}
 */
export async function loadCatalog(skillDir) {
  const cached = catalogCache.get(skillDir)
  if (cached !== undefined) return cached
  const path = join(skillDir, 'references', 'catalog.json')
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  const catalog = {
    total: Number(parsed.total) || entries.length,
    withStill: Number(parsed.with_still) || entries.filter((entry) => typeof entry.image === 'string').length,
    series: Array.isArray(parsed.series) ? parsed.series : [],
    entries: entries.map((entry) => ({
      id: String(entry.id ?? ''),
      name: String(entry.name ?? ''),
      series: String(entry.series ?? ''),
      category: String(entry.category ?? ''),
      description: String(entry.description ?? ''),
      fit: String(entry.fit ?? ''),
      tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
      file: typeof entry.file === 'string' ? entry.file : undefined,
      image: typeof entry.image === 'string' ? entry.image : undefined,
    })),
  }
  catalogCache.set(skillDir, catalog)
  return catalog
}

/** Score one entry against a free-text query. */
function scoreEntry(entry, terms) {
  const haystack = [entry.id, entry.name, entry.category, entry.description, entry.fit, ...entry.tags].join(' ').toLowerCase()
  let score = 0
  for (const term of terms) {
    if (term.length === 0) continue
    if (entry.id.toLowerCase() === term) score += 100
    else if (entry.id.toLowerCase().startsWith(term)) score += 40
    if (entry.name.toLowerCase() === term) score += 60
    if (entry.name.toLowerCase().includes(term)) score += 25
    if (entry.tags.some((tag) => tag.toLowerCase().includes(term))) score += 18
    // The category is the visual family ("A 字", "M 动态风格"); matching it is a
    // stronger signal than an incidental keyword hit in the prose body.
    if (entry.category.toLowerCase().includes(term)) score += 20
    if (haystack.includes(term)) score += 6
  }
  return score
}

/* ------------------------------------------------------------------ *
 * Style guidance: what may change, and what defines the style
 * ------------------------------------------------------------------ */

/**
 * Canonical L-series section names -> a short role key.
 *
 * The 341-entry library grew from several sources with different section layouts.
 * The Lemo series ships an 11-section `STYLE.md`; the mg-styles series ships a
 * different heading set. Both are mapped onto the same roles so downstream code
 * does not have to care which source a style came from.
 */
const SECTION_ROLES = Object.freeze([
  // A bare "# Style" heading is the mg-styles series' name for the essence.
  { role: 'essence', test: /^style$|essence|what it is not|本质|是什么/u },
  { role: 'signature', test: /signature features|signature moves|签名特征|签名动作/u },
  { role: 'materials', test: /materials?\s*&?\s*rendering|材料|材质|rendering/u },
  { role: 'colour', test: /colou?r logic|配色|色彩|colour|颜色/u },
  { role: 'type', test: /type\s*&?\s*subtitles|字体|字幕|排印/u },
  { role: 'motion', test: /motion quality|动效|运动|缓动|motion/u },
  { role: 'camera', test: /camera grammar|运镜|镜头/u },
  { role: 'sound', test: /sound palette|声音|配乐|音效/u },
  { role: 'moves', test: /native moves|动作库/u },
  { role: 'pitfalls', test: /pitfalls|坑|avoid|规则|rules|banned|禁用/u },
  { role: 'engine', test: /engine|技术路线|technical route|implementation/u },
  { role: 'variation', test: /variation space|变体|可替换|creative seed/u },
  { role: 'output', test: /output\b|固定规格|交付/u },
])

/**
 * Roles that carry the style's *identity*: change one of these and it becomes a
 * different style. Everything else is a variable a new episode may swap.
 *
 * This split is the difference between "make another film in this style" and
 * "make a film that happens to use these colours". It comes from the Lemo
 * director's-manual convention (safe to change / changes its character / cannot
 * change), which is the one structural idea worth carrying over from that library.
 */
const INVARIANT_ROLES = Object.freeze(['essence', 'signature', 'materials', 'colour'])

/** Roles a caller may freely rewrite when making a new episode. */
const VARIABLE_ROLES = Object.freeze(['type', 'sound', 'variation', 'output'])

/**
 * Split a style prompt into named sections.
 *
 * Markdown headings are the only structure the library guarantees; a prompt with
 * no headings returns one `body` section rather than an empty result.
 *
 * @param {string} prompt the style prompt Markdown
 * @returns {Array<{level: number, heading: string, body: string, role: string|undefined}>}
 */
export function parseStyleSections(prompt) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return []
  const lines = prompt.split(/\r?\n/u)
  const sections = []
  let current = { level: 0, heading: '', body: [], role: 'body' }
  const flush = () => {
    const body = current.body.join('\n').trim()
    if (current.heading === '' && body === '') return
    sections.push({ level: current.level, heading: current.heading.trim(), body, role: current.role })
  }
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (match !== null) {
      flush()
      const level = match[1].length
      const heading = match[2].trim()
      current = { level, heading, body: [], role: roleForHeading(heading) }
      continue
    }
    current.body.push(line)
  }
  flush()
  return sections
}

/** Map a heading onto a role key (undefined when it does not look like a known section). */
function roleForHeading(heading) {
  const text = String(heading ?? '').toLowerCase()
  // A numbered prefix ("1. Essence") must not defeat the match.
  const cleaned = text.replace(/^\d+\s*[.)、]\s*/u, '')
  for (const { role, test } of SECTION_ROLES) {
    if (test.test(cleaned)) return role
  }
  return undefined
}

/**
 * Derive the "what defines this style vs what may change" split from a prompt.
 *
 * @param {string} prompt
 * @returns {{
 *   roles: string[],
 *   invariants: Array<{role: string, heading: string, body: string}>,
 *   variables: Array<{role: string, heading: string, body: string}>,
 *   banned: string[],
 *   hasStructure: boolean,
 * }}
 */
export function deriveGuidance(prompt) {
  const sections = parseStyleSections(prompt)
  // "Structured" means at least one heading was recognised as a real section role;
  // a prompt with only a "## 风格提示词" wrapper is still one prose blob.
  const hasStructure = sections.some((section) => section.role !== undefined && section.role !== 'body')
  const invariants = []
  const variables = []
  const banned = []
  for (const section of sections) {
    const entry = { role: section.role ?? 'body', heading: section.heading, body: section.body }
    if (INVARIANT_ROLES.includes(section.role)) invariants.push(entry)
    else if (VARIABLE_ROLES.includes(section.role)) variables.push(entry)
    if (section.role === 'pitfalls' || section.role === 'essence') {
      for (const line of section.body.split(/\r?\n/u)) {
        const text = line.trim().replace(/^[-*+]?\s*\d*[.)、]?\s*/u, '')
        if (text.length === 0) continue
        // "Not X", "never Y", "Banned: a, b" are the negative constraints that stop
        // a model from drifting into the generic look. Quote the *sentence* that
        // carries the constraint, not the whole paragraph around it.
        const sentence = sentenceWithConstraint(text)
        if (sentence !== undefined) banned.push(sentence.slice(0, 200))
      }
    }
  }
  return {
    roles: [...new Set(sections.map((section) => section.role).filter((role) => role !== undefined))],
    invariants,
    variables,
    banned: banned.slice(0, 12),
    hasStructure,
  }
}

/**
 * Return the sentence that carries a negative constraint, or undefined.
 *
 * Style prose mixes description and prohibition in one paragraph ("Real things on
 * it: cut-out photographs … never a generated image"). Quoting the whole line as a
 * ban is misleading; quoting the sentence that contains "never"/"not" is the
 * actual instruction.
 */
function sentenceWithConstraint(text) {
  const marker = /\b(?:never|avoid|banned|do not|don't|must not)\b/iu
  const parts = text.split(/(?<=[.!?。！？；;])\s+/u).filter((part) => part.trim().length > 0)
  for (const part of parts) {
    if (marker.test(part) || /^not\b/iu.test(part.trim())) return part.trim()
  }
  // No sentence break: only treat the whole line as a constraint when it *starts*
  // with the negation, which is the "Not **X** (a …)" idiom this library uses.
  const trimmed = text.trim()
  if (/^(?:not|never|avoid|don't|do not)\b/iu.test(trimmed)) return trimmed
  return undefined
}

/**
 * Search the style catalogue.
 *
 * @param {object} options
 * @param {string} options.skillDir
 * @param {string} [options.query] free text or an exact id (e.g. "B3", "粒子")
 * @param {string} [options.series] series id filter (AG/M/K/Z/H/L/V/X/O/R)
 * @param {number} [options.limit]
 * @returns {Promise<Array<object>>} entries with absolute file/image paths
 */
export async function searchStyles(options) {
  const catalog = await loadCatalog(options.skillDir)
  const query = typeof options.query === 'string' ? options.query.trim() : ''
  const terms = query.toLowerCase().split(/[\s,，、]+/u).filter(Boolean)
  const series = typeof options.series === 'string' && options.series.trim().length > 0 ? options.series.trim().toUpperCase() : undefined
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 50) : 8

  let candidates = catalog.entries
  if (series !== undefined) candidates = candidates.filter((entry) => entry.series.toUpperCase() === series)
  if (terms.length === 0) {
    return candidates.slice(0, limit).map((entry) => decorate(options.skillDir, entry))
  }
  const scored = candidates
    .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return scored.map((item) => ({ ...decorate(options.skillDir, item.entry), score: item.score }))
}

/** Attach absolute paths to a catalogue entry (empty fields stay undefined). */
function decorate(skillDir, entry) {
  const hasFile = typeof entry.file === 'string' && entry.file.trim().length > 0
  const hasImage = typeof entry.image === 'string' && entry.image.trim().length > 0
  return {
    ...entry,
    filePath: hasFile ? join(skillDir, entry.file) : undefined,
    imagePath: hasImage ? join(skillDir, entry.image) : undefined,
  }
}

/**
 * Read one style's prompt Markdown and reference still.
 *
 * @param {string} skillDir
 * @param {string} id exact style id (case-insensitive)
 * @returns {Promise<{entry: object, prompt: string, promptPath: string, imagePath?: string, imageBytes?: number}|undefined>}
 */
export async function getStyle(skillDir, id) {
  const catalog = await loadCatalog(skillDir)
  const wanted = String(id ?? '').trim().toLowerCase()
  if (wanted.length === 0) return undefined
  const entry = catalog.entries.find((item) => item.id.toLowerCase() === wanted)
  if (entry === undefined) return undefined
  const decorated = decorate(skillDir, entry)
  let prompt = ''
  try {
    prompt = await readFile(decorated.filePath, 'utf8')
  } catch {
    prompt = ''
  }
  let imageBytes
  if (decorated.imagePath !== undefined) {
    const info = await stat(decorated.imagePath).catch(() => undefined)
    imageBytes = info?.size
  }
  // The split between "this defines the style" and "this is a variable" is the
  // single most useful thing to hand a model that is about to rewrite a prompt.
  const guidance = deriveGuidance(prompt)
  return { entry: decorated, prompt, promptPath: decorated.filePath, imagePath: decorated.imagePath, imageBytes, guidance }
}

/** Path to the skill's starter template (the reference implementation of renderAt). */
export function starterPath(skillDir) {
  return join(skillDir, 'assets', 'starter', 'index.html')
}

/** Series list for the picker UI. */
export async function listSeries(skillDir) {
  const catalog = await loadCatalog(skillDir)
  return catalog.series
}

/** Style counts by series for a compact overview. */
export async function seriesOverview(skillDir) {
  const catalog = await loadCatalog(skillDir)
  const counts = new Map()
  for (const entry of catalog.entries) {
    const key = entry.series || '?'
    const current = counts.get(key) ?? { id: key, name: '', count: 0, withImage: 0 }
    current.count += 1
    if (entry.image !== undefined) current.withImage += 1
    counts.set(key, current)
  }
  for (const series of catalog.series) {
    const current = counts.get(series.id)
    if (current !== undefined) current.name = series.name
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

export default {
  loadCatalog,
  searchStyles,
  getStyle,
  starterPath,
  listSeries,
  seriesOverview,
  resolveSkillDir,
  defaultSkillDir,
  parseStyleSections,
  deriveGuidance,
}
