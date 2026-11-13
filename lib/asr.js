/**
 * Local speech-to-text through ffmpeg's built-in whisper filter.
 *
 * The Gyan/BtbN Windows builds of FFmpeg 8+ compile with `--enable-whisper`, so a
 * ggml model file is all that is missing. Models are cached under the Harness home
 * and downloaded on first use; nothing leaves the machine after that.
 *
 * Windows gotcha (verified on this machine): a filtergraph option value cannot
 * contain a drive-letter colon. Every run therefore happens with `cwd` set to a
 * private work directory and the model/transcript paths are relative to it, with
 * the model directory sitting as a sibling of the work directory.
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { run, tailLines } from './ffmpeg.js'

/** Model file sizes, used for the progress-free sanity check after a download. */
const MODEL_BYTES = {
  tiny: 77_691_713,
  base: 147_951_465,
  small: 487_601_967,
}

/** Minimum plausible size; a truncated download must not be accepted. */
const MIN_MODEL_BYTES = 40 * 1024 * 1024

const MODEL_URL = (size) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${size}.bin`

/** Root directory for cached models and ASR scratch space. */
export function asrBaseDir(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh', 'media-senses')
}

/** In-process cache so concurrent tool calls share one download. */
const modelPromises = new Map()

/** In-process capability probe for the `whisper` filter. */
let whisperFilterSupport

/**
 * Check whether the configured ffmpeg exposes the whisper filter.
 *
 * @param {{ffmpeg: string}} tools
 * @returns {Promise<{supported: boolean, reason?: string}>}
 */
export async function whisperSupport(tools) {
  if (whisperFilterSupport !== undefined) return whisperFilterSupport
  try {
    const result = await run(tools.ffmpeg, ['-hide_banner', '-h', 'filter=whisper'], { timeoutMs: 20_000 })
    const text = `${result.stdout}\n${result.stderr}`
    whisperFilterSupport = text.includes('Transcribe audio using whisper')
      ? { supported: true }
      : { supported: false, reason: 'this ffmpeg build has no whisper filter (needs FFmpeg 8+ built with --enable-whisper)' }
  } catch (error) {
    whisperFilterSupport = { supported: false, reason: `cannot probe ffmpeg filters: ${error.message}` }
  }
  return whisperFilterSupport
}

/**
 * Ensure a ggml whisper model exists locally, downloading it once when missing.
 *
 * @param {object} options
 * @param {'tiny'|'base'|'small'} [options.size]
 * @param {string} [options.baseDir]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{path: string, size: string, downloaded: boolean, bytes: number}>}
 */
export async function ensureModel(options = {}) {
  const size = options.size ?? 'tiny'
  if (!(size in MODEL_BYTES)) throw new Error(`unsupported whisper model "${size}"; use tiny, base or small`)
  const baseDir = asrBaseDir(options.baseDir)
  const modelDir = join(baseDir, 'models')
  const target = join(modelDir, `ggml-${size}.bin`)
  const key = target
  const cached = modelPromises.get(key)
  if (cached !== undefined) return cached

  const promise = (async () => {
    const existing = await stat(target).catch(() => undefined)
    if (existing !== undefined && existing.size >= MIN_MODEL_BYTES) {
      return { path: target, size, downloaded: false, bytes: existing.size }
    }
    if (existing !== undefined) await unlink(target).catch(() => undefined)
    await mkdir(modelDir, { recursive: true })
    const partial = `${target}.partial-${process.pid}-${Date.now()}`
    const url = MODEL_URL(size)
    const response = await fetch(url, { redirect: 'follow', signal: options.signal })
    if (!response.ok || response.body === null) {
      throw new Error(`cannot download whisper model (${url}): HTTP ${response.status} ${response.statusText}`)
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
    const written = await stat(partial)
    if (written.size < MIN_MODEL_BYTES) {
      await unlink(partial).catch(() => undefined)
      throw new Error(`whisper model download looks truncated (${written.size} bytes); expected about ${MODEL_BYTES[size]}`)
    }
    await rename(partial, target)
    return { path: target, size, downloaded: true, bytes: written.size }
  })()

  modelPromises.set(key, promise)
  try {
    return await promise
  } catch (error) {
    modelPromises.delete(key)
    throw error
  }
}

/** Map a user/model-supplied language to the token whisper expects. */
function normaliseLanguage(language) {
  if (typeof language !== 'string' || language.trim().length === 0) return 'auto'
  const value = language.trim().toLowerCase()
  const aliases = { zh: 'zh', 'zh-cn': 'zh', 'zh-tw': 'zh', cmn: 'zh', mandarin: 'zh', chinese: 'zh', en: 'en', english: 'en', ja: 'ja', japanese: 'ja', ko: 'ko', korean: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru' }
  return aliases[value] ?? value
}

/**
 * Transcribe the audio track of a media file on the local machine.
 *
 * @param {object} options
 * @param {{ffmpeg: string, ffprobe: string}} options.tools
 * @param {string} options.file absolute media path
 * @param {string} options.modelPath absolute ggml model path
 * @param {string} [options.baseDir]
 * @param {string} [options.language]
 * @param {number} [options.start] seconds into the media
 * @param {number} [options.duration] seconds to transcribe (capped by maxSeconds)
 * @param {number} [options.maxSeconds]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{text: string, audioSeconds: number, language: string, truncated: boolean, warnings: string[]}>}
 */
export async function transcribe(options) {
  const tools = options.tools
  const warnings = []
  const support = await whisperSupport(tools)
  if (!support.supported) {
    return { text: '', audioSeconds: 0, language: 'auto', truncated: false, warnings: [support.reason ?? 'whisper is unavailable'] }
  }

  const baseDir = asrBaseDir(options.baseDir)
  // The ASR work directory is a SIBLING of models/ so the model path stays a
  // short relative path without a drive letter.
  const workDir = join(baseDir, 'asr-work')
  await mkdir(workDir, { recursive: true })

  const language = normaliseLanguage(options.language)
  const start = Number.isFinite(options.start) ? Math.max(0, options.start) : 0
  const maxSeconds = Number.isFinite(options.maxSeconds) ? Math.max(1, options.maxSeconds) : 300
  const requested = Number.isFinite(options.duration) && options.duration > 0 ? options.duration : maxSeconds
  const duration = Math.min(requested, maxSeconds)
  const truncated = requested > duration

  const modelRelative = relative(workDir, options.modelPath).replaceAll('\\', '/')
  if (modelRelative.includes(':')) {
    // A different volume cannot be referenced relatively; whisper needs a path
    // without a drive-letter colon inside the filter graph.
    throw new Error(`whisper model must live on the same drive as ${workDir} (got ${options.modelPath}); set modelDir in the plugin config`)
  }

  const audioName = 'speech.wav'
  const transcriptName = 'transcript.txt'
  const audioPath = join(workDir, audioName)
  const transcriptPath = join(workDir, transcriptName)
  await unlink(audioPath).catch(() => undefined)
  await unlink(transcriptPath).catch(() => undefined)
  await writeFile(transcriptPath, '')

  // Trim only leading silence before transcription. Trimming silence throughout
  // would glue separated utterances together (whisper then mis-segments them),
  // and trimming the tail is not worth it either — the timestamp mapping stays
  // honest when the audio is left intact.
  const trimSilence = 'silenceremove=start_periods=1:start_silence=0.12:start_threshold=-45dB'
  const extractArgs = ['-v', 'error', '-nostdin', '-y', '-ss', String(start), '-t', String(duration), '-i', options.file, '-vn', '-ac', '1', '-ar', '16000', '-af', trimSilence, '-c:a', 'pcm_s16le', audioName]
  const extracted = await run(tools.ffmpeg, extractArgs, { cwd: workDir, timeoutMs: 300_000, signal: options.signal })
  if (extracted.code !== 0) {
    return { text: '', audioSeconds: 0, language, truncated, warnings: [`cannot extract audio for transcription:\n${tailLines(extracted.stderr, 6)}`] }
  }

  const filter = `whisper=model=${modelRelative}:language=${language}:use_gpu=0:format=text:destination=${transcriptName}`
  const whisperArgs = ['-v', 'error', '-nostdin', '-y', '-i', audioName, '-af', filter, '-f', 'null', '-']
  const started = Date.now()
  const result = await run(tools.ffmpeg, whisperArgs, { cwd: workDir, timeoutMs: 1_800_000, signal: options.signal })
  const inferenceSeconds = Math.round((Date.now() - started) / 100) / 10

  let text = ''
  try {
    text = (await readFile(transcriptPath, 'utf8')).trim()
  } catch {
    // Missing transcript file: reported through warnings below.
  }
  if (result.code !== 0) {
    warnings.push(`whisper transcription failed:\n${tailLines(result.stderr, 6)}`)
  } else if (text.length === 0) {
    warnings.push('whisper produced an empty transcript (no speech detected, or the audio is music only)')
  }
  if (truncated) warnings.push(`transcription covered only the first ${Math.round(duration)}s of the requested range`)

  await unlink(audioPath).catch(() => undefined)

  return {
    text,
    audioSeconds: Math.round(duration * 100) / 100,
    language,
    truncated,
    inferenceSeconds,
    warnings,
  }
}

/** Delete a cached model (used by the settings surface / tests). */
export async function removeModel(size, baseDir) {
  const target = join(asrBaseDir(baseDir), 'models', `ggml-${size}.bin`)
  await unlink(target).catch(() => undefined)
  modelPromises.delete(target)
}

/** Report the cached model inventory without downloading anything. */
export async function modelInventory(baseDir) {
  const dir = join(asrBaseDir(baseDir), 'models')
  const out = []
  for (const size of Object.keys(MODEL_BYTES)) {
    const info = await stat(join(dir, `ggml-${size}.bin`)).catch(() => undefined)
    out.push({ size, path: join(dir, `ggml-${size}.bin`), present: info !== undefined, bytes: info?.size ?? 0 })
  }
  return out
}

export { MODEL_URL }
