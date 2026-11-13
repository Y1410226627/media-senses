/**
 * Corpus ingestion for remote media.
 *
 * The plugin does not crawl websites itself: it downloads direct media URLs and,
 * when `yt-dlp` is installed on the machine, delegates site-specific extraction
 * to it. The caller is responsible for the terms of service and copyright of
 * whatever it asks to download.
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probe, run, summariseProbe, tailLines } from './ffmpeg.js'

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi|flv|ts)$/iu

/** Directory of this module, used to locate the plugin-local `bin/`. */
const moduleDir = dirname(fileURLToPath(import.meta.url))

/** Look for yt-dlp: plugin-local `bin/`, PATH, then the usual Windows locations. */
export async function findYtDlp() {
  const candidates = []
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  // Shipping the binary next to the plugin keeps the machine untouched.
  candidates.push(join(moduleDir, '..', 'bin', exe))
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir.length === 0) continue
    candidates.push(join(dir, exe))
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (home.length > 0) {
    candidates.push(join(home, '.local', 'bin', exe))
    candidates.push(join(home, 'scoop', 'shims', exe))
    candidates.push(join(home, 'AppData', 'Local', 'Programs', 'Python', 'Scripts', exe))
  }
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe))
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => undefined)
    if (info !== undefined && info.isFile()) return candidate
  }
  return undefined
}

/** Pick a filename for a URL when the server gives us nothing better. */
function fileNameFor(url, index) {
  try {
    const parsed = new URL(url)
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
    const cleaned = last.replace(/[^\w.\-\u4e00-\u9fa5]+/gu, '_').slice(0, 80)
    if (/\.(mp4|mkv|webm|mov|m4v|avi|flv|ts)$/iu.test(cleaned)) return cleaned
    if (cleaned.length > 0) return `${cleaned}.mp4`
  } catch {
    // Fall through to a positional name.
  }
  return `download-${String(index + 1).padStart(3, '0')}.mp4`
}

/**
 * Download media URLs into a directory.
 *
 * @param {object} options
 * @param {{ffmpeg: string, ffprobe: string}} options.tools
 * @param {string[]} options.urls
 * @param {string} options.dir destination directory (created)
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs] per-URL timeout
 * @returns {Promise<{files: string[], downloaded: number, warnings: string[], tool: 'yt-dlp'|'ffmpeg'}>}
 */
export async function ingestUrls(options) {
  const { tools, urls, dir } = options
  await mkdir(dir, { recursive: true })
  const warnings = []
  const files = []
  const ytDlp = await findYtDlp()
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 900_000

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]
    const before = new Set((await readdir(dir).catch(() => [])).map((name) => name))
    try {
      if (ytDlp !== undefined) {
        const result = await run(ytDlp, [
          '--no-playlist', '--no-progress', '--newline',
          '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
          '--merge-output-format', 'mp4',
          '-o', '%(title).80s [%(id)s].%(ext)s',
          url,
        ], { cwd: dir, timeoutMs, signal: options.signal, maxBuffer: 64 * 1024 * 1024 })
        if (result.code !== 0) {
          warnings.push(`yt-dlp failed for ${url}: ${tailLines(result.stderr || result.stdout, 4)}`)
          continue
        }
      } else {
        const target = fileNameFor(url, index)
        const result = await run(tools.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', url, '-c', 'copy', target], {
          cwd: dir,
          timeoutMs,
          signal: options.signal,
        })
        if (result.code !== 0) {
          warnings.push(`download failed for ${url} (install yt-dlp for site-specific extraction): ${tailLines(result.stderr, 4)}`)
          continue
        }
      }
    } catch (error) {
      warnings.push(`download error for ${url}: ${error.message}`)
      continue
    }

    const after = (await readdir(dir).catch(() => [])).filter((name) => !before.has(name))
    const found = after.filter((name) => VIDEO_EXT.test(name))
    if (found.length === 0) {
      warnings.push(`no media file appeared for ${url}`)
      continue
    }
    for (const name of found) files.push(join(dir, name))
  }

  // Validate what we got; a half-downloaded file must not enter the corpus.
  const valid = []
  for (const file of files) {
    try {
      const summary = summariseProbe(await probe(tools, file))
      if (summary.duration <= 0) {
        warnings.push(`downloaded file has no duration: ${file}`)
        continue
      }
      valid.push(file)
    } catch (error) {
      warnings.push(`downloaded file is not readable: ${file} (${error.message})`)
    }
  }

  return { files: valid, downloaded: valid.length, warnings, tool: ytDlp === undefined ? 'ffmpeg' : 'yt-dlp' }
}

export default { ingestUrls, findYtDlp }
