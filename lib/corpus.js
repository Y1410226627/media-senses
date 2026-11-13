/**
 * Batch corpus analysis.
 *
 * The plugin's purpose is to let a model *learn how a genre of video is made* by
 * reading many examples, then reproduce one. This module turns a folder (or a
 * manifest, or a list of URLs) into a corpus: per-video analysis + craft report
 * + reproduction recipe, cached so re-analysis is cheap.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { artifactDir, formatTimecode, makeWorkDir, removeWorkDir, resolveTools } from './ffmpeg.js'

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.wmv', '.ts', '.m2ts', '.mpg', '.mpeg', '.3gp'])

/** True when the path looks like a video file by extension. */
export function looksLikeVideo(path) {
  return VIDEO_EXT.has(extname(path).toLowerCase())
}

/** A stable short id for a media path. */
export function mediaId(file) {
  const digest = createHash('sha1').update(file).digest('hex').slice(0, 10)
  const base = file.split(/[\\/]/u).pop() ?? 'media'
  const stem = base.replace(/\.[^.]+$/u, '').replace(/[^\w\u4e00-\u9fa5-]+/gu, '_').slice(0, 32)
  return `${stem}-${digest}`
}

/**
 * Expand a source description into a list of local media files.
 *
 * @param {string|string[]} source directory, manifest file (`*.txt` with one path/URL per line,
 *   or `*.json`/`*.jsonl`), or an explicit array of paths
 * @returns {Promise<{files: string[], urls: string[], warnings: string[]}>}
 */
export async function expandSource(source) {
  const files = []
  const urls = []
  const warnings = []
  const push = (value) => {
    const text = String(value ?? '').trim()
    if (text.length === 0 || text.startsWith('#')) return
    if (/^https?:\/\//iu.test(text)) urls.push(text)
    else files.push(text)
  }

  const sources = Array.isArray(source) ? source : [source]
  for (const entry of sources) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue
    const target = isAbsolute(entry) ? entry : resolve(process.cwd(), entry)
    const info = await stat(target).catch(() => undefined)
    if (info === undefined) {
      // A bare value that is not a path is treated as a URL when it parses as one.
      if (/^https?:\/\//iu.test(entry.trim())) urls.push(entry.trim())
      else warnings.push(`source not found: ${entry}`)
      continue
    }
    if (info.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true })
      const list = []
      for (const child of entries) {
        if (!child.isFile()) continue
        const path = join(target, child.name)
        if (looksLikeVideo(path)) list.push(path)
      }
      list.sort()
      files.push(...list)
      if (list.length === 0) warnings.push(`no video files in directory: ${target}`)
      continue
    }
    const extension = extname(target).toLowerCase()
    if (extension === '.txt') {
      const text = await readFile(target, 'utf8')
      for (const line of text.split(/\r?\n/u)) push(line)
      continue
    }
    if (extension === '.json' || extension === '.jsonl') {
      const text = await readFile(target, 'utf8')
      try {
        const parsed = extension === '.jsonl' ? text.split(/\r?\n/u).filter((l) => l.trim().length > 0).map((l) => JSON.parse(l)) : JSON.parse(text)
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.files) ? parsed.files : [parsed]
        for (const item of list) {
          if (typeof item === 'string') push(item)
          else if (item !== null && typeof item === 'object') push(item.path ?? item.url ?? item.file)
        }
      } catch (error) {
        warnings.push(`cannot parse manifest ${target}: ${error.message}`)
      }
      continue
    }
    push(target)
  }

  // De-duplicate while preserving order.
  return {
    files: [...new Set(files)],
    urls: [...new Set(urls)],
    warnings,
  }
}

/**
 * Copy or link local media into a corpus raw directory (keeps one canonical
 * location per corpus so later runs are reproducible).
 *
 * @param {{files: string[], root: string}} options
 */
export async function stageLocalFiles({ files, root }) {
  const rawDir = join(root, 'raw')
  await mkdir(rawDir, { recursive: true })
  const staged = []
  const warnings = []
  for (const file of files) {
    const info = await stat(file).catch(() => undefined)
    if (info === undefined || !info.isFile()) {
      warnings.push(`missing file: ${file}`)
      continue
    }
    staged.push({ path: file, bytes: info.size, origin: 'local' })
  }
  return { staged, warnings, rawDir }
}

/** Tiny concurrency pool (ffmpeg is CPU bound; two workers is already plenty). */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Read a JSON file, returning undefined when absent or malformed. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Keep the analysis small enough to store one per video without bloat. */
function summariseAnalysis(analysis) {
  if (analysis === null || typeof analysis !== 'object') return null
  const shots = Array.isArray(analysis.shots) ? analysis.shots : []
  return {
    duration: analysis.duration,
    stream: analysis.stream,
    format: analysis.format,
    global: analysis.global,
    shots: shots.map((shot) => ({
      index: shot.index,
      start: shot.start,
      end: shot.end,
      duration: shot.duration,
      brightness: shot.brightness,
      saturation: shot.saturation,
      hueName: shot.hueName,
      hueHex: shot.hueHex,
      motion: shot.motion,
      palette: shot.palette,
      layout: shot.layout,
    })),
    timeline: Array.isArray(analysis.timeline) ? analysis.timeline.filter((_, index) => index % 2 === 0) : [],
    flags: analysis.flags,
    audio: analysis.audio === null || analysis.audio === undefined
      ? null
      : {
          format: analysis.audio.format,
          tempo: analysis.audio.tempo,
          key: analysis.audio.key,
          loudness: analysis.audio.loudness,
          timbre: analysis.audio.timbre,
          spectrum: analysis.audio.spectrum,
          rhythm: analysis.audio.rhythm,
          sections: analysis.audio.sections,
          vocals: analysis.audio.vocals,
          mood: analysis.audio.mood,
        },
    warnings: analysis.warnings ?? [],
  }
}

/**
 * Analyse every video in a corpus.
 *
 * @param {object} options
 * @param {{ffmpeg: string, ffprobe: string}} [options.tools]
 * @param {string} options.root corpus directory (holds `raw/`, `analysis/`, `cache.json`)
 * @param {Array<{path: string, origin?: string}>} options.videos absolute video paths
 * @param {number} [options.maxVideos]
 * @param {boolean} [options.fast] fewer keyframes / no contact sheets
 * @param {boolean} [options.includeTranscript]
 * @param {number} [options.maxSeconds] per-video analysis cap
 * @param {number} [options.concurrency]
 * @param {boolean} [options.reuseCache]
 * @param {string} [options.language]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: {done: number, total: number, id: string, status: string}) => void} [options.onProgress]
 */
export async function analyzeCorpus(options) {
  const tools = options.tools ?? (await resolveTools())
  const root = options.root
  const analysisDir = join(root, 'analysis')
  const cachePath = join(root, 'cache.json')
  await mkdir(analysisDir, { recursive: true })

  const maxVideos = Number.isInteger(options.maxVideos) && options.maxVideos > 0 ? options.maxVideos : 24
  const videos = (options.videos ?? []).slice(0, maxVideos)
  const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0 ? Math.min(options.concurrency, 4) : 2
  const maxSeconds = Number.isFinite(options.maxSeconds) ? options.maxSeconds : 180
  const reuseCache = options.reuseCache !== false
  const warnings = []

  // Lazy imports: the engine modules are optional at wiring time and must not
  // break a corpus run if one of them is unavailable.
  let analyzeVideo
  let analyzeAudioEngine
  try {
    ;({ analyzeVideo } = await import('./video.js'))
    ;({ analyzeAudio: analyzeAudioEngine } = await import('./audio.js'))
  } catch (error) {
    throw new Error(`video/audio engine unavailable: ${error.message}`)
  }
  let analyzeCraft
  try {
    ;({ analyzeCraft } = await import('./craft.js'))
  } catch {
    analyzeCraft = undefined
  }
  let transcribe
  try {
    ;({ transcribe } = await import('./asr.js'))
  } catch {
    transcribe = undefined
  }

  const cache = reuseCache ? (await readJson(cachePath)) ?? {} : {}
  const nextCache = { ...cache }
  const entries = []
  let skipped = 0
  let failed = 0
  let done = 0

  const workers = await mapLimit(videos, concurrency, async (video) => {
    const file = video.path
    const info = await stat(file).catch(() => undefined)
    if (info === undefined) {
      failed += 1
      return { id: mediaId(file), file, status: 'missing', warnings: [`file disappeared: ${file}`] }
    }
    const id = mediaId(file)
    const cacheKey = `${file}|${info.size}|${Math.round(info.mtimeMs)}`
    const cached = reuseCache ? cache[cacheKey] : undefined
    if (cached !== undefined && typeof cached.id === 'string') {
      const stored = await readJson(join(analysisDir, `${cached.id}.json`))
      if (stored !== undefined) {
        skipped += 1
        done += 1
        options.onProgress?.({ done, total: videos.length, id, status: 'cached' })
        return stored
      }
    }

    const workDir = await makeWorkDir(`media-senses-corpus-${id}`)
    const outDir = join(root, 'artifacts', id)
    try {
      const analysis = await analyzeVideo({
        tools,
        file,
        workDir,
        options: {
          maxSeconds,
          maxKeyframes: options.fast === false ? 24 : 8,
          wantContactSheet: options.fast === false,
          wantFrames: true,
          wantAudio: true,
          artifactDir: outDir,
          sceneThreshold: 0.3,
          densityFloorSeconds: 25,
          analyzeAudio: true,
        },
        signal: options.signal,
        analyzeAudio: analyzeAudioEngine,
      })

      let craft = null
      if (typeof analyzeCraft === 'function') {
        try {
          const crafted = await analyzeCraft({
            tools,
            file,
            workDir,
            analysis,
            artifactDir: outDir,
            options: {},
            signal: options.signal,
          })
          craft = crafted?.craft ?? null
          const recipe = crafted?.recipe ?? null
          const entry = {
            id,
            file,
            relative: relative(root, file) || file,
            bytes: info.size,
            status: 'ok',
            analyzedAt: new Date().toISOString(),
            analysis: summariseAnalysis(analysis),
            craft,
            recipe,
            transcript: null,
            warnings: [],
          }
          if (options.includeTranscript === true && typeof transcribe === 'function' && analysis.audio !== null && analysis.audio !== undefined) {
            // Transcripts are opt-in: they dominate runtime on a large corpus.
            try {
              const { ensureModel } = await import('./asr.js')
              const model = await ensureModel({ size: options.whisperModel ?? 'tiny', baseDir: options.modelDir })
              const transcript = await transcribe({
                tools,
                file,
                modelPath: model.path,
                baseDir: options.modelDir,
                language: options.language,
                start: 0,
                duration: 120,
                maxSeconds: 120,
                signal: options.signal,
              })
              entry.transcript = { text: transcript.text, audioSeconds: transcript.audioSeconds }
            } catch (error) {
              entry.warnings.push(`transcript failed: ${error.message}`)
            }
          }
          await writeFile(join(analysisDir, `${id}.json`), JSON.stringify(entry, undefined, 2), 'utf8')
          nextCache[cacheKey] = { id, at: entry.analyzedAt }
          done += 1
          options.onProgress?.({ done, total: videos.length, id, status: 'ok' })
          return entry
        } catch (error) {
          warnings.push(`${id}: craft analysis failed (${error.message}); keeping the base analysis`)
        }
      }

      const entry = {
        id,
        file,
        relative: relative(root, file) || file,
        bytes: info.size,
        status: 'ok',
        analyzedAt: new Date().toISOString(),
        analysis: summariseAnalysis(analysis),
        craft,
        recipe: null,
        transcript: null,
        warnings: [],
      }
      await writeFile(join(analysisDir, `${id}.json`), JSON.stringify(entry, undefined, 2), 'utf8')
      nextCache[cacheKey] = { id, at: entry.analyzedAt }
      done += 1
      options.onProgress?.({ done, total: videos.length, id, status: 'ok' })
      return entry
    } catch (error) {
      failed += 1
      done += 1
      options.onProgress?.({ done, total: videos.length, id, status: 'failed' })
      return { id, file, status: 'failed', warnings: [`analysis failed: ${error.message}`] }
    } finally {
      await removeWorkDir(workDir)
    }
  })

  for (const worker of workers) if (worker !== undefined && worker !== null) entries.push(worker)

  await writeFile(cachePath, JSON.stringify(nextCache, undefined, 2), 'utf8')
  // Append-only view for external tools / the model.
  await writeFile(join(root, 'corpus.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf8')

  return {
    root,
    entries: entries.filter((entry) => entry.status === 'ok'),
    all: entries,
    skipped,
    failed,
    warnings,
    analysisDir,
    cachePath,
    corpusPath: join(root, 'corpus.jsonl'),
  }
}

export { formatTimecode, artifactDir }
