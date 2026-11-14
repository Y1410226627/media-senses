/**
 * In-page audio tracks for HTML animation rendering.
 *
 * Declarative animation pages may place audio clips on the composition timeline:
 *
 *   <audio data-start="2" data-duration="1.5" data-track-index="0"
 *          data-volume="0.8" src="music.mp3"></audio>
 *
 * The browser renderer reads those attributes over the DevTools Protocol (see
 * `audioCollectionExpression()` below), turns the raw entries into clip
 * descriptors with `normalisePageAudio()`, and after the silent video has been
 * encoded mixes the clips in with ffmpeg: `adelay` places each clip on the
 * timeline, `amix` sums the bus, `alimiter` catches the peaks.
 *
 * Everything in this module is pure Node logic (no browser, no ffmpeg process),
 * which keeps the argument generation and the HTML parsing unit-testable.
 * Paths that appear in ffmpeg *filtergraph* strings are never used here: clips
 * become ordinary `-i` inputs (absolute local paths or http(s) URLs are allowed
 * there), while the filtergraph only contains labels and numbers.
 */

import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_AUDIO_VOLUME = 1
export const DEFAULT_SAMPLE_RATE = 48_000
export const DEFAULT_AUDIO_BITRATE = '192k'
/** Clamp before ffmpeg: a runaway data-volume should not produce +60 dB. */
export const MAX_AUDIO_VOLUME = 4
const CLIP_EPSILON = 1e-6

/**
 * Decode the HTML entities that can legitimately appear in a `src` attribute.
 * Only a handful are needed for file names; numeric character references are
 * decoded as well so `&#39;` in a filename survives.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
  return text
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/giu, '"')
    .replace(/&apos;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&amp;/giu, '&')
}

/**
 * Parse a numeric seconds attribute.
 *
 * Accepts plain numbers ("1.5"), seconds with a suffix ("1.5s", "2 s") and
 * milliseconds ("1500ms"), because generated pages spell these differently.
 *
 * @param {unknown} value
 * @returns {number|null} seconds, or null when the value is absent/unparseable
 */
export function parseSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (text.length === 0) return null
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(ms|s)?$/u.exec(text)
  if (match === null) return null
  const number = Number.parseFloat(match[1])
  if (!Number.isFinite(number)) return null
  return match[2] === 'ms' ? number / 1000 : number
}

/**
 * Read one attribute from the attribute text of an HTML tag.
 * Supports double-quoted, single-quoted and unquoted values.
 *
 * @param {string} attributesText text between the tag name and `>`
 * @param {string} name attribute name (case-insensitive)
 * @returns {string|null}
 */
export function readHtmlAttribute(attributesText, name) {
  if (typeof attributesText !== 'string' || attributesText.length === 0) return null
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu')
  const match = pattern.exec(attributesText)
  if (match === null) return null
  return decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '')
}

/** Clamp a volume attribute into a sane linear-gain range. */
function normaliseVolume(raw, warnings, label) {
  if (raw === null || raw === undefined) return DEFAULT_AUDIO_VOLUME
  const number = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).trim())
  if (!Number.isFinite(number)) {
    warnings.push({ code: 'invalid-volume', message: `音频 ${label} 的 data-volume 不是数字，已按 1.0 处理` })
    return DEFAULT_AUDIO_VOLUME
  }
  return Math.min(MAX_AUDIO_VOLUME, Math.max(0, number))
}

/** Clamp a track index; it is metadata for overlap lint and ordering. */
function normaliseTrackIndex(raw) {
  if (raw === null || raw === undefined) return 0
  const number = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10)
  return Number.isInteger(number) && number >= 0 ? number : 0
}

/**
 * Parse `<audio>` elements out of animation HTML source text.
 *
 * This is the static/source view used by linting and tests; the renderer itself
 * reads the live attributes from the page over CDP because the DOM may be built
 * by script. Both views produce the same clip shape.
 *
 * @param {string} source HTML source
 * @returns {{clips: Array<{src: string, start: number, duration: number|null, trackIndex: number, volume: number, hasStart: boolean}>, warnings: Array<{code: string, message: string}>}}
 */
export function parseAudioClips(source) {
  const clips = []
  const warnings = []
  if (typeof source !== 'string' || source.length === 0) return { clips, warnings }
  const openTag = /<audio\b([^>]*?)\/?>/giu
  let match = openTag.exec(source)
  while (match !== null) {
    const attributes = match[1]
    let src = readHtmlAttribute(attributes, 'src')
    if (src === null || src.trim().length === 0) {
      // Fall back to a nested <source src="..."> as browsers do.
      const tail = source.slice(match.index + match[0].length, match.index + match[0].length + 800)
      const nested = /<source\b([^>]*?)\/?>/iu.exec(tail)
      src = nested === null ? null : readHtmlAttribute(nested[1], 'src')
    }
    if (src === null || src.trim().length === 0) {
      warnings.push({ code: 'missing-src', message: '页面里的 <audio> 没有 src（已跳过该音频）' })
      match = openTag.exec(source)
      continue
    }
    const label = src.trim()
    const startRaw = readHtmlAttribute(attributes, 'data-start')
    const start = parseSeconds(startRaw)
    if (start === null) {
      warnings.push({ code: 'missing-start', message: `音频 ${label} 缺少 data-start，已按 0 秒处理` })
    }
    if (start !== null && start < 0) {
      warnings.push({ code: 'negative-start', message: `音频 ${label} 的 data-start 为负数（${start}s）` })
    }
    const durationRaw = readHtmlAttribute(attributes, 'data-duration')
    const duration = parseSeconds(durationRaw)
    if (durationRaw !== null && duration === null) {
      warnings.push({ code: 'invalid-duration', message: `音频 ${label} 的 data-duration 不是时间值（已按素材自然长度处理）` })
    }
    clips.push({
      src: label,
      start: start ?? 0,
      duration: duration === null ? null : Math.max(0, duration),
      trackIndex: normaliseTrackIndex(readHtmlAttribute(attributes, 'data-track-index')),
      volume: normaliseVolume(readHtmlAttribute(attributes, 'data-volume'), warnings, label),
      hasStart: start !== null,
    })
    match = openTag.exec(source)
  }
  return { clips, warnings }
}

/**
 * JavaScript expression evaluated inside the animation page to collect the live
 * `<audio>` attributes. `element.currentSrc` is the browser-resolved URL (the
 * page's own URL as base), which is what the renderer needs to find the file on
 * disk even when the page uses relative paths.
 *
 * @returns {string}
 */
export function audioCollectionExpression() {
  return `(() => {
  try {
    const nodes = document.querySelectorAll('audio');
    const entries = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const element = nodes[index];
      let currentSrc = '';
      try { currentSrc = element.currentSrc || ''; } catch (error) {}
      if (!currentSrc) {
        const sourceElement = element.querySelector('source[src]');
        if (sourceElement !== null) {
          try { currentSrc = sourceElement.src || ''; } catch (error) {}
        }
      }
      if (!currentSrc) {
        const attributeSrc = element.getAttribute('src') || '';
        if (attributeSrc.length > 0) {
          try { currentSrc = new URL(attributeSrc, document.baseURI).href; } catch (error) { currentSrc = attributeSrc; }
        }
      }
      entries.push({
        src: element.getAttribute('src') || '',
        currentSrc,
        start: element.getAttribute('data-start'),
        duration: element.getAttribute('data-duration'),
        trackIndex: element.getAttribute('data-track-index'),
        volume: element.getAttribute('data-volume'),
      });
    }
    return entries;
  } catch (error) {
    return [];
  }
})()`
}

/**
 * Turn the browser-collected `<audio>` entries into clip descriptors.
 *
 * File URLs are converted to local paths (the page is opened from `file://`);
 * http(s) URLs are passed through to ffmpeg; `data:` URLs are rejected with a
 * warning because the pure module cannot materialise them.
 *
 * @param {Array<object>} entries raw entries from `audioCollectionExpression()`
 * @param {{baseDir?: string}} [options] fallback base for relative srcs (the HTML's directory)
 * @returns {{clips: Array<{source: string, label: string, start: number, duration: number|null, trackIndex: number, volume: number}>, warnings: Array<{code: string, message: string}>}}
 */
export function normalisePageAudio(entries, options = {}) {
  const clips = []
  const warnings = []
  if (!Array.isArray(entries)) {
    return { clips, warnings: [{ code: 'invalid-page-audio', message: '页面音频属性读取失败（已按无声处理）' }] }
  }
  const baseDir = typeof options.baseDir === 'string' && options.baseDir.length > 0 ? options.baseDir : undefined
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === null || typeof entry !== 'object') continue
    const preferred = typeof entry.currentSrc === 'string' && entry.currentSrc.length > 0 ? entry.currentSrc : entry.src
    const rawSrc = String(preferred ?? '').trim()
    if (rawSrc.length === 0) {
      warnings.push({ code: 'missing-src', message: `页面第 ${index + 1} 个 <audio> 没有可解析的 src（已跳过）` })
      continue
    }
    let source
    if (/^data:/iu.test(rawSrc)) {
      warnings.push({ code: 'unsupported-src', message: `页面音频使用 data: URL，渲染器无法作为 ffmpeg 输入（已跳过）：${rawSrc.slice(0, 60)}` })
      continue
    }
    if (/^file:/iu.test(rawSrc)) {
      try {
        source = fileURLToPath(rawSrc)
      } catch (error) {
        warnings.push({ code: 'invalid-src', message: `页面音频的 file: URL 无法解析（已跳过）：${rawSrc}（${error.message}）` })
        continue
      }
    } else if (/^(?:https?|ftp):/iu.test(rawSrc)) {
      source = rawSrc
    } else if (baseDir !== undefined) {
      source = isAbsolute(rawSrc) ? rawSrc : resolve(baseDir, rawSrc)
    } else {
      warnings.push({ code: 'unresolved-src', message: `页面音频是相对路径且无法解析（已跳过）：${rawSrc}` })
      continue
    }
    const label = typeof entry.src === 'string' && entry.src.length > 0 ? entry.src : source
    const start = parseSeconds(entry.start)
    if (start === null) {
      warnings.push({ code: 'missing-start', message: `页面音频 ${label} 缺少 data-start，已按 0 秒处理` })
    } else if (start < 0) {
      warnings.push({ code: 'negative-start', message: `页面音频 ${label} 的 data-start 为负数（${start}s，已截到 0）` })
    }
    const duration = parseSeconds(entry.duration)
    clips.push({
      source,
      label,
      start: start === null ? 0 : Math.max(0, start),
      duration: duration === null ? null : Math.max(0, duration),
      trackIndex: normaliseTrackIndex(entry.trackIndex),
      volume: normaliseVolume(entry.volume, warnings, label),
    })
  }
  return { clips, warnings }
}

/** Format a number for an ffmpeg argument without exponent notation or float noise. */
function formatNumber(value) {
  const rounded = Math.round(value * 1e6) / 1e6
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

/**
 * Build the ffmpeg invocation that mixes the page's audio clips into the already
 * encoded video.
 *
 * The video stream is stream-copied (`-c:v copy`), so the silent render is not
 * re-encoded and stays byte-for-byte identical in the picture. Output duration
 * is trimmed to the video duration with `-t`.
 *
 * Filtergraph shape (one chain per clip):
 *   [1:a]atrim=0:<dur>,asetpts=PTS-STARTPTS,adelay=<ms>:all=1,volume=<v>[a0]; ...
 *   [a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]
 *
 * `normalize=0` keeps the authored levels instead of dividing by the input
 * count; `alimiter` catches sums above full scale.
 *
 * @param {object} options
 * @param {string} [options.videoInput='render.mp4'] silent video name/path (relative to cwd is preferred)
 * @param {string} [options.outputName='render-audio.mp4'] output name (relative to cwd is preferred)
 * @param {number} options.duration video duration in seconds
 * @param {Array<{source: string, start: number, duration?: number|null, volume?: number, label?: string}>} options.clips
 * @param {number} [options.sampleRate=48000]
 * @param {string} [options.bitrate='192k']
 * @returns {{args: string[], filterComplex: string, inputs: string[], outputName: string, clips: Array<object>, skipped: Array<object>}}
 */
export function buildAudioMixArgs(options = {}) {
  const videoInput = typeof options.videoInput === 'string' && options.videoInput.length > 0 ? options.videoInput : 'render.mp4'
  const outputName = typeof options.outputName === 'string' && options.outputName.length > 0 ? options.outputName : 'render-audio.mp4'
  const duration = typeof options.duration === 'number' ? options.duration : Number(options.duration)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('buildAudioMixArgs needs the positive video duration in seconds')
  }
  const inputClips = Array.isArray(options.clips) ? options.clips : []
  const skipped = []
  const usable = []
  for (const clip of inputClips) {
    if (clip === null || typeof clip !== 'object') continue
    const source = typeof clip.source === 'string' ? clip.source.trim() : ''
    const start = typeof clip.start === 'number' ? clip.start : Number.NaN
    if (source.length === 0 || !Number.isFinite(start)) {
      skipped.push({ reason: 'invalid-clip', clip })
      continue
    }
    if (start >= duration - CLIP_EPSILON) {
      skipped.push({ reason: 'starts-after-video', clip })
      continue
    }
    usable.push({
      source,
      label: typeof clip.label === 'string' ? clip.label : source,
      start: Math.max(0, start),
      duration: Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : null,
      volume: Number.isFinite(clip.volume) ? Math.min(MAX_AUDIO_VOLUME, Math.max(0, clip.volume)) : DEFAULT_AUDIO_VOLUME,
    })
  }
  if (usable.length === 0) {
    throw new Error('buildAudioMixArgs found no audio clip that starts inside the video')
  }

  const sampleRate = Number.isInteger(options.sampleRate) ? options.sampleRate : DEFAULT_SAMPLE_RATE
  const bitrate = typeof options.bitrate === 'string' && options.bitrate.length > 0 ? options.bitrate : DEFAULT_AUDIO_BITRATE

  const inputArgs = ['-i', videoInput]
  for (const clip of usable) inputArgs.push('-i', clip.source)

  const chains = []
  usable.forEach((clip, index) => {
    const inputIndex = index + 1
    const filterParts = []
    if (clip.duration !== null) filterParts.push(`atrim=0:${formatNumber(clip.duration)}`)
    filterParts.push('asetpts=PTS-STARTPTS')
    const delayMs = Math.max(0, Math.round(clip.start * 1000))
    filterParts.push(`adelay=${delayMs}:all=1`)
    if (Math.abs(clip.volume - DEFAULT_AUDIO_VOLUME) > 1e-6) filterParts.push(`volume=${formatNumber(clip.volume)}`)
    chains.push(`[${inputIndex}:a]${filterParts.join(',')}[a${index}]`)
  })
  const labels = usable.map((_, index) => `[a${index}]`).join('')
  const mixChain =
    usable.length === 1
      ? `${labels}alimiter=limit=0.95[aout]`
      : `${labels}amix=inputs=${usable.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`

  const filterComplex = `${chains.join(';')};${mixChain}`
  const args = [
    '-hide_banner',
    '-nostats',
    '-loglevel', 'error',
    '-y',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '0:v:0',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', bitrate,
    '-ar', String(sampleRate),
    '-t', formatNumber(duration),
    '-movflags', '+faststart',
    outputName,
  ]
  return { args, filterComplex, inputs: inputArgs, outputName, clips: usable, skipped }
}

export default {
  DEFAULT_AUDIO_VOLUME,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_AUDIO_BITRATE,
  MAX_AUDIO_VOLUME,
  parseSeconds,
  readHtmlAttribute,
  parseAudioClips,
  audioCollectionExpression,
  normalisePageAudio,
  buildAudioMixArgs,
}
