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
    if (haystack.includes(term)) score += 6
  }
  return score
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
  return { entry: decorated, prompt, promptPath: decorated.filePath, imagePath: decorated.imagePath, imageBytes }
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

export default { loadCatalog, searchStyles, getStyle, starterPath, listSeries, seriesOverview, resolveSkillDir, defaultSkillDir }
