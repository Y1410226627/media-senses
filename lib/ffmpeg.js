/**
 * Shared ffmpeg/ffprobe plumbing for the media-senses plugin.
 *
 * Design notes:
 * - Binaries are discovered once (config override -> PATH -> well-known Windows
 *   install locations) and cached for the lifetime of the Host process.
 * - Every ffmpeg invocation that writes side files runs with `cwd` set to a
 *   private work directory and uses RELATIVE paths inside filtergraphs. This is
 *   required on Windows: a filter graph option such as
 *   `whisper=model=C:/x/y.bin` breaks at the drive-letter colon. Absolute paths
 *   remain fine for ordinary `-i` arguments.
 * - Metadata telemetry is written to a file (`metadata=print:file=...`) instead
 *   of a pipe so long videos cannot overflow a stdio buffer.
 */
import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { readdirSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path'
import { createHash } from 'node:crypto'

const isWindows = process.platform === 'win32'
const EXE = isWindows ? '.exe' : ''

/** Candidate directories that commonly hold a user-installed ffmpeg on Windows. */
function winCandidateDirs() {
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const userProfile = process.env.USERPROFILE ?? ''
  const dirs = []
  if (localAppData) {
    dirs.push(join(localAppData, 'Microsoft', 'WinGet', 'Links'))
    const packages = join(localAppData, 'Microsoft', 'WinGet', 'Packages')
    // Gyan.FFmpeg_* / BtbN.FFmpeg_* ship bin/{ffmpeg,ffprobe}.exe two levels down.
    try {
      // Synchronous enumeration keeps binary discovery a single async call site.
      const entries = readdirSync(packages, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!/ffmpeg/iu.test(entry.name)) continue
        dirs.push(join(packages, entry.name, 'ffmpeg', 'bin'))
        dirs.push(join(packages, entry.name, 'bin'))
      }
    } catch {
      // Package directory absent: keep the static fallbacks below.
    }
  }
  if (userProfile) {
    dirs.push(join(userProfile, 'scoop', 'shims'))
    dirs.push(join(userProfile, 'scoop', 'apps', 'ffmpeg', 'current', 'bin'))
  }
  dirs.push('C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin', 'C:\\ProgramData\\chocolatey\\bin')
  if (process.env.ProgramData) dirs.push(join(process.env.ProgramData, 'chocolatey', 'bin'))
  return dirs
}

/** Return true when `path` exists and is executable-ish. */
async function isFile(path) {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    if (!isWindows) await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Normalise a config-provided binary path to an absolute path when possible. */
function normaliseCandidate(value, cwd) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return isAbsolute(trimmed) ? trimmed : join(cwd, trimmed)
}

/**
 * Locate ffmpeg and ffprobe.
 *
 * @param {{ffmpegPath?: string, ffprobePath?: string, cwd?: string}} options
 * @returns {Promise<{ffmpeg: string, ffprobe: string, version: string, source: string}>}
 */
export async function resolveTools(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const explicitFfmpeg = normaliseCandidate(options.ffmpegPath, cwd)
  const explicitFfprobe = normaliseCandidate(options.ffprobePath, cwd)

  if (explicitFfmpeg !== undefined) {
    if (!(await isFile(explicitFfmpeg))) throw new Error(`ffmpegPath does not point to a file: ${explicitFfmpeg}`)
    const ffprobe = explicitFfprobe ?? join(dirname(explicitFfmpeg), `ffprobe${EXE}`)
    if (!(await isFile(ffprobe))) throw new Error(`ffprobe was not found next to ffmpeg (${ffprobe}); set ffprobePath in the plugin config`)
    return { ffmpeg: explicitFfmpeg, ffprobe, version: await versionOf(explicitFfmpeg), source: 'config' }
  }

  // Packaged fallbacks: some builds place ffprobe next to ffmpeg, others one level up.
  const dirs = (process.env.PATH ?? '').split(isWindows ? ';' : ':').filter(Boolean)
  if (isWindows) dirs.unshift(...winCandidateDirs())

  const seen = new Set()
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const ffmpeg = join(dir, `ffmpeg${EXE}`)
    const ffprobe = join(dir, `ffprobe${EXE}`)
    if ((await isFile(ffmpeg)) && (await isFile(ffprobe))) {
      return { ffmpeg, ffprobe, version: await versionOf(ffmpeg), source: dir }
    }
  }
  throw new Error(
    'ffmpeg/ffprobe were not found. Install FFmpeg and make sure ffmpeg.exe and ffprobe.exe are on PATH, ' +
      'or set ffmpegPath/ffprobePath in the media-senses plugin config.',
  )
}

/** Read the first version line printed by an ffmpeg-like binary. */
async function versionOf(binary) {
  try {
    const { stdout, stderr } = await run(binary, ['-hide_banner', '-version'], { timeoutMs: 20_000 })
    const line = `${stdout}\n${stderr}`.split(/\r?\n/u).find((l) => /^ff(?:mpeg|probe) version/u.test(l))
    return line?.trim() ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Run a binary and collect stdout/stderr as UTF-8 strings.
 *
 * @param {string} binary
 * @param {readonly string[]} args
 * @param {{cwd?: string, timeoutMs?: number, signal?: AbortSignal, maxBuffer?: number}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function run(binary, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      binary,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 0,
        maxBuffer: options.maxBuffer ?? 512 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code === 'string' && error.code === 'ENOENT') {
          reject(new Error(`cannot execute ${binary}: ${error.message}`))
          return
        }
        if (error !== null && error.killed === true && Number(error.code) !== 0) {
          // A timeout/abort shows up as a killed child; keep stdout so callers can
          // still salvage partial telemetry.
          resolvePromise({ code: 124, stdout: stdout ?? '', stderr: stderr ?? '', killed: true })
          return
        }
        const code = error !== null && typeof error.code === 'number' ? error.code : error === null ? 0 : 1
        resolvePromise({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}

/** Run a binary and throw with its stderr when it fails. */
export async function runOrThrow(binary, args, options = {}) {
  const result = await run(binary, args, options)
  if (result.code !== 0) {
    const tail = tailLines(result.stderr, 12)
    throw new Error(`${basename(binary)} exited with code ${result.code}${tail.length > 0 ? `:\n${tail}` : ''}`)
  }
  return result
}

/** Keep only the last `count` non-empty lines of a text blob. */
export function tailLines(text, count) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-count)
    .join('\n')
}

/**
 * Probe a media file with ffprobe and return its raw JSON document.
 *
 * @returns {Promise<any>}
 */
export async function probe(tools, file, options = {}) {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    ...(options.extra ?? []),
    file,
  ]
  const result = await run(tools.ffprobe, args, { timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal })
  if (result.code !== 0) throw new Error(`cannot probe "${file}":\n${tailLines(result.stderr, 8)}`)
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`cannot parse ffprobe output for "${file}": ${error.message}`)
  }
}

/**
 * Describe the first video/audio/subtitle stream in a compact, model-friendly way.
 *
 * @param {any} probeJson
 */
export function summariseProbe(probeJson) {
  const format = probeJson?.format ?? {}
  const streams = Array.isArray(probeJson?.streams) ? probeJson.streams : []
  const video = streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  const audio = streams.filter((s) => s.codec_type === 'audio')
  const subtitles = streams.filter((s) => s.codec_type === 'subtitle')
  const chapters = Array.isArray(probeJson?.chapters) ? probeJson.chapters : []
  const duration = Number.parseFloat(format.duration ?? video[0]?.duration ?? audio[0]?.duration ?? '0') || 0
  return {
    duration,
    formatName: format.format_name ?? 'unknown',
    formatLongName: format.format_long_name ?? 'unknown',
    sizeBytes: Number.parseInt(format.size ?? '0', 10) || 0,
    bitRate: Number.parseInt(format.bit_rate ?? '0', 10) || 0,
    tags: format.tags ?? {},
    video: video.map((s) => ({
      index: s.index,
      codec: s.codec_name,
      width: s.width,
      height: s.height,
      fps: parseRate(s.avg_frame_rate ?? s.r_frame_rate),
      bitRate: Number.parseInt(s.bit_rate ?? '0', 10) || 0,
      pixFmt: s.pix_fmt,
      profile: s.profile,
      rotation: rotationOf(s),
      duration: Number.parseFloat(s.duration ?? '0') || duration,
      frames: Number.parseInt(s.nb_frames ?? '0', 10) || 0,
    })),
    audio: audio.map((s) => ({
      index: s.index,
      codec: s.codec_name,
      sampleRate: Number.parseInt(s.sample_rate ?? '0', 10) || 0,
      channels: s.channels,
      channelLayout: s.channel_layout,
      bitRate: Number.parseInt(s.bit_rate ?? '0', 10) || 0,
      duration: Number.parseFloat(s.duration ?? '0') || duration,
    })),
    subtitles: subtitles.map((s) => ({
      index: s.index,
      codec: s.codec_name,
      language: s.tags?.language,
      title: s.tags?.title,
      forced: s.disposition?.forced === 1,
    })),
    chapters: chapters.map((c) => ({
      start: Number.parseFloat(c.start_time ?? '0') || 0,
      end: Number.parseFloat(c.end_time ?? '0') || 0,
      title: c.tags?.title ?? '',
    })),
  }
}

/** Parse a rational frame rate such as "30000/1001". */
function parseRate(value) {
  if (typeof value !== 'string' || value.length === 0) return 0
  const [num, den] = value.split('/')
  const n = Number.parseFloat(num)
  const d = den === undefined ? 1 : Number.parseFloat(den)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0
  return Math.round((n / d) * 1000) / 1000
}

/** Extract a normalised rotation from stream side data. */
function rotationOf(stream) {
  const side = Array.isArray(stream.side_data_list) ? stream.side_data_list : []
  for (const item of side) {
    if (typeof item?.rotation === 'number') return Math.abs(item.rotation) % 360
  }
  const tagged = Number.parseInt(stream.tags?.rotate ?? '', 10)
  return Number.isFinite(tagged) ? Math.abs(tagged) % 360 : 0
}

/**
 * Run one filter chain that emits frame metadata and return the parsed series.
 *
 * The chain is expected to end in `metadata=print:file=<relative>`; this helper
 * appends it, points ffmpeg at `-f null -`, and parses the printed blocks.
 *
 * @param {object} tools
 * @param {string} file
 * @param {{filter: string, workDir: string, audio?: boolean, timeoutMs?: number, signal?: AbortSignal, extraInputArgs?: string[], map?: string}} options
 * @returns {Promise<Array<{frame: number, pts: number, ptsTime: number, meta: Record<string, string>}>>}
 */
export async function readFrameMetadata(tools, file, options) {
  const outName = `meta-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  const filter = `${options.filter},metadata=print:file=${outName}`
  const args = ['-hide_banner', '-nostats', '-loglevel', 'error', ...(options.extraInputArgs ?? []), '-i', file]
  if (options.audio === true) {
    args.push('-vn', '-af', filter, '-f', 'null', '-')
  } else {
    args.push('-an', '-vf', filter, '-f', 'null', '-')
  }
  const result = await run(tools.ffmpeg, args, {
    cwd: options.workDir,
    timeoutMs: options.timeoutMs ?? 900_000,
    signal: options.signal,
  })
  const outPath = join(options.workDir, outName)
  let text = ''
  try {
    text = await readFile(outPath, 'utf8')
  } catch {
    if (result.code !== 0) throw new Error(`ffmpeg telemetry failed:\n${tailLines(result.stderr, 10)}`)
    throw new Error('ffmpeg produced no frame metadata (the filter chain may not have matched any frame)')
  }
  const frames = parseMetadataPrint(text)
  if (result.code !== 0 && frames.length === 0) {
    throw new Error(`ffmpeg telemetry failed:\n${tailLines(result.stderr, 10)}`)
  }
  return frames
}

/**
 * Parse the `metadata=print` text format:
 *
 *   frame:12   pts:12   pts_time:0.48
 *   lavfi.signalstats.YAVG=64.31
 *   lavfi.scd.mafd=1.24
 *
 * @param {string} text
 */
export function parseMetadataPrint(text) {
  const frames = []
  let current = null
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line.startsWith('frame:')) {
      const frame = Number.parseInt(/frame:(\d+)/u.exec(line)?.[1] ?? '-1', 10)
      const pts = Number.parseFloat(/pts:(-?\d+)/u.exec(line)?.[1] ?? '0')
      const ptsTime = Number.parseFloat(/pts_time:(-?[\d.]+)/u.exec(line)?.[1] ?? '0')
      current = { frame, pts, ptsTime: Number.isFinite(ptsTime) ? ptsTime : 0, meta: {} }
      frames.push(current)
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (value.length === 0) continue
    if (current === null) {
      current = { frame: -1, pts: 0, ptsTime: 0, meta: {} }
      frames.push(current)
    }
    current.meta[key] = value
  }
  return frames
}

/** Create a private scratch directory for one analysis run. */
export async function makeWorkDir(prefix = 'media-senses') {
  await mkdir(tmpdir(), { recursive: true })
  return mkdtemp(join(tmpdir(), `${prefix}-`))
}

/** Remove a scratch directory, ignoring failures. */
export async function removeWorkDir(dir) {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    // Scratch cleanup is best-effort: a locked file must not fail the tool.
  }
}

/**
 * Resolve an artifact directory for one input file.
 *
 * @param {string} file  absolute input path
 * @param {string|undefined} configured  explicit output directory from config/args
 * @returns {Promise<string>} absolute directory that exists
 */
export async function artifactDir(file, configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    const target = isAbsolute(configured) ? configured : join(process.cwd(), configured)
    await mkdir(target, { recursive: true })
    return target
  }
  const digest = createHash('sha1').update(file).digest('hex').slice(0, 8)
  const stem = basename(file, extname(file)).replace(/[^\w\u4e00-\u9fa5.-]+/gu, '_').slice(0, 48) || 'media'
  const target = join(tmpdir(), 'media-senses', `${stem}-${digest}`)
  await mkdir(target, { recursive: true })
  return target
}

/** Format seconds as H:MM:SS.mmm (or MM:SS.mmm under an hour). */
export function formatTimecode(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const totalMs = Math.round(safe * 1000)
  const ms = totalMs % 1000
  const totalSeconds = (totalMs - ms) / 1000
  const s = totalSeconds % 60
  const totalMinutes = (totalSeconds - s) / 60
  const m = totalMinutes % 60
  const h = (totalMinutes - m) / 60
  const msPart = String(ms).padStart(3, '0').slice(0, 3)
  const sPart = String(s).padStart(2, '0')
  const mPart = h > 0 ? String(m).padStart(2, '0') : String(m)
  return h > 0 ? `${h}:${mPart}:${sPart}.${msPart}` : `${mPart}:${sPart}.${msPart}`
}

/** Format a byte count for display. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/**
 * Escape a Windows absolute path for use *inside* a filtergraph option value.
 * Prefer relative paths with `cwd`; this is the fallback for cases where an
 * absolute path cannot be avoided (e.g. a model file outside the work dir).
 */
export function escapeFilterPath(path) {
  return path
    .replaceAll('\\', '/')
    .replaceAll(':', '\\:')
    .replaceAll(',', '\\,')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll("'", "\\'")
}

/** Quote one Windows command-line argument the way ffmpeg expects it. */
export function quoteArg(value) {
  if (value.length === 0) return '""'
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
}

/** List files in a directory (non-recursive). */
export async function listFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

/** Read a small text file, returning '' when absent. */
export async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/** Write a text file (used by tests and whisper transcripts). */
export async function writeText(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

export { isWindows, sep as pathSep }
