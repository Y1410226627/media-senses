/**
 * RenderPlan -> finished MP4.
 *
 * This is the half of the plugin that actually *makes* a video after the model
 * has watched references and written a plan. A plan is a plain JSON document
 * (scenes with durations/transitions, optional captions, an optional music bed
 * and optional narration); this module turns it into one H.264/AAC MP4.
 *
 * Scene types: `text` (drawtext title/subtitle blocks), `image` (still with
 * optional Ken Burns / pan), `color`, `gradient`, and `video` — a pre-rendered
 * segment (code animation, stock clip, ...) that is scaled/trimmed into the
 * timeline exactly like every other scene. Video scenes never contribute audio:
 * the soundtrack is built only from `audio.music` + `audio.voiceover`.
 *
 * Rendering is deliberately staged, because mixing lavfi sources, still images,
 * zoom/pan animation and chained transitions in one filter graph is where ffmpeg
 * invocations explode:
 *
 *   stage 1  one intermediate clip per scene, same width/height/fps/pix_fmt and
 *            exactly `round(duration * fps)` frames, audio stripped (`-an`)
 *   stage 2  assembly: chain clips with `xfade` (`concat` at hard-cut
 *            boundaries), build the whole audio mix (anullsrc base + music +
 *            delayed voiceovers -> amix -> loudnorm) in the same pass, encode
 *            once
 *   stage 3  (only when captions exist) second pass over the assembled file,
 *            burning `drawtext` boxes with `enable='between(t,start,end)'` and
 *            copying the audio stream
 *
 * Timeline maths (also reported back so the model can trust the output):
 *
 *   end_i   = sum(scene.duration for 0..i) - sum(transitionDuration for 1..i)
 *   start_i = end_i - scene_i.duration
 *   total   = end_last
 *
 * `transitionIn: "cut"` contributes a transition duration of 0; it is rendered
 * with `concat` semantics instead of an `xfade` with duration 0 (which ffmpeg
 * rejects). Same plan -> same timeline arithmetic, and the final encode is cut
 * with `-t` at the computed total.
 *
 * Windows/ffmpeg rules enforced throughout (see CONTRACT-V2.md): filter graphs
 * never contain absolute paths. ffmpeg runs with `cwd = <workDir>/render-*`,
 * media is referenced by relative file name, fonts needed by `drawtext` are
 * COPIED into that directory (and referenced as bare `fontfile=font-msyh.ttc`
 * names), and narration text is written to UTF-8 files and read with
 * `textfile=` + `expansion=none` so Chinese never passes through command-line
 * quoting or filtergraph escaping.
 */
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { Canvas } from './png.js'
import { probe, run, tailLines } from './ffmpeg.js'
import { synthesizeSpeech } from './tts.js'

/** Contract: scenes are at least 0.2 s. */
const MIN_SCENE_SECONDS = 0.2
const MAX_DIMENSION = 7680
const MAX_FPS = 120
const DEFAULT_WIDTH = 1080
const DEFAULT_HEIGHT = 1920
const DEFAULT_FPS = 30
const DEFAULT_TRANSITION_SECONDS = 0.5
/** Text may not spill outside this share of the frame. */
const TEXT_MAX_WIDTH_SHARE = 0.86
const TEXT_MAX_HEIGHT_SHARE = 0.78
/** Captions keep an 8% margin from the frame edge (vertical and horizontal). */
const CAPTION_MARGIN_SHARE = 0.08

const SCENE_TYPES = new Set(['text', 'image', 'color', 'gradient', 'video'])
const ANIMATIONS = new Set(['none', 'fade', 'slide-up'])
const MOTIONS = new Set([
  'none',
  'kenburns-in', 'kenburns-out',
  'pan-left', 'pan-right', 'pan-up', 'pan-down',
  // The craft analyser reports tilts under these names; accepting them here means
  // a measured `tilt-up` can be handed straight back to the builder.
  'tilt-up', 'tilt-down',
])
const FITS = new Set(['cover', 'contain'])
const ALIGNS = new Set(['center', 'left', 'bottom'])
const CAPTION_POSITIONS = new Set(['bottom', 'top', 'center'])
/** xfade transitions the plan may name (all present in ffmpeg 9.0.2). */
const TRANSITIONS = new Set([
  'fade', 'fadeblack', 'fadewhite',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'circleopen', 'circleclose', 'dissolve', 'pixelize', 'radial',
  'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
  'horzopen', 'horzclose', 'vertopen', 'vertclose',
])
/** drawtext font variants -> Windows font file + the file name used in the work dir. */
const FONTS = new Map([
  ['msyh', { source: 'C:\\Windows\\Fonts\\msyh.ttc', file: 'font-msyh.ttc' }],
  ['msyhbd', { source: 'C:\\Windows\\Fonts\\msyhbd.ttc', file: 'font-msyhbd.ttc' }],
  ['arial', { source: 'C:\\Windows\\Fonts\\arial.ttf', file: 'font-arial.ttf' }],
  ['arialbd', { source: 'C:\\Windows\\Fonts\\arialbd.ttf', file: 'font-arialbd.ttf' }],
  ['simhei', { source: 'C:\\Windows\\Fonts\\simhei.ttf', file: 'font-simhei.ttf' }],
])
/** Preference order when a requested font is not installed. CJK-capable first. */
const FONT_FALLBACKS = ['msyh', 'simhei', 'arial', 'arialbd']
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif'])
/** Extensions inferred as `video` scenes when the plan omits `type`. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.ts'])

const VIDEO_PRESET = 'veryfast'
const VIDEO_CRF = '18'
const AUDIO_SAMPLE_RATE = 48_000
const AUDIO_BITRATE = '192k'

// ---------------------------------------------------------------------------
// small numeric / text helpers
// ---------------------------------------------------------------------------

/** Round to hundredths (contract: seconds rounded to 0.01). */
function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

/** Round to thousandths, used for internally reported scene durations. */
function round3(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0
}

/** Format a number for a filtergraph option without exponent notation. */
function fnum(value) {
  if (!Number.isFinite(value)) return '0'
  return String(Math.round(value * 10_000) / 10_000)
}

/** Coerce to a finite number, or NaN. */
function numberOrNaN(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim().length > 0) return Number(value)
  return Number.NaN
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    const error = new Error('buildVideo aborted')
    error.name = 'AbortError'
    throw error
  }
}

async function fileExists(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** True for a code point that renders roughly full-width (CJK, kana, fullwidth). */
function isWideChar(codePoint) {
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  )
}

/**
 * Width estimate in em units. drawtext does not wrap and we do not load font
 * metrics, so titles are laid out with this estimate and auto-shrunk until they
 * fit. Factors are tuned for 微软雅黑: CJK glyphs are ~1 em, ASCII averages ~0.55.
 */
function charWidthEm(codePoint) {
  if (codePoint <= 0x1f) return 0
  if (codePoint === 0x20) return 0.32
  if (isWideChar(codePoint)) return 1
  const char = String.fromCodePoint(codePoint)
  if ('il.,:;!|\''.includes(char)) return 0.3
  if ('mwMW@#%&'.includes(char)) return 0.84
  if (codePoint >= 0x41 && codePoint <= 0x5a) return 0.64
  return 0.56
}

function estimateTextWidth(text, fontSize) {
  let em = 0
  for (const char of text) em += charWidthEm(char.codePointAt(0))
  return em * fontSize * 1.02
}

/** Split on `\n`, trim each line, drop empties. */
function splitLines(text) {
  if (typeof text !== 'string') return []
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Greedy wrap by estimated width; prefers breaking at spaces. */
function wrapText(text, fontSize, maxWidth, maxLines = 6) {
  const result = []
  for (const paragraph of splitLines(text)) {
    let current = ''
    let pendingBreak = -1
    for (const char of paragraph) {
      if (char === ' ') {
        if (current.length > 0) {
          current += char
          pendingBreak = current.length
        }
        continue
      }
      const next = current + char
      if (current.length > 0 && estimateTextWidth(next, fontSize) > maxWidth) {
        const cut = pendingBreak > 0 ? pendingBreak : current.length
        const line = current.slice(0, cut).trim()
        const rest = (current.slice(cut) + char).trim()
        if (line.length > 0) result.push(line)
        current = rest
        pendingBreak = -1
      } else {
        current = next
      }
      if (result.length >= maxLines) break
    }
    if (result.length >= maxLines) break
    const tail = current.trim()
    if (tail.length > 0) result.push(tail)
  }
  const kept = result.slice(0, maxLines)
  return kept.length > 0 ? kept : splitLines(text).slice(0, maxLines)
}

/** Shrink `size` until every line fits the width and the block fits the height. */
function fitFontSize(lines, baseSize, maxWidth, maxHeight, lineHeightFactor, minSize = 16) {
  if (lines.length === 0) return Math.max(minSize, Math.round(baseSize))
  let size = Math.max(minSize, Math.round(baseSize))
  for (;;) {
    const widest = lines.reduce((max, line) => Math.max(max, estimateTextWidth(line, size)), 0)
    const blockHeight = lines.length * Math.round(size * lineHeightFactor)
    if ((widest <= maxWidth && blockHeight <= maxHeight) || size <= minSize) return size
    size -= 1
  }
}

/** Ensure a positive even integer (yuv420p needs even dimensions). */
function even(value) {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded + 1
}

// ---------------------------------------------------------------------------
// colour helpers
// ---------------------------------------------------------------------------

/** Parse '#rgb' / '#rrggbb' / 'rrggbb' / '0xrrggbb' into '#rrggbb' or null. */
function parseHexColor(value) {
  if (typeof value !== 'string') return null
  let text = value.trim().toLowerCase()
  if (text.startsWith('#')) text = text.slice(1)
  else if (text.startsWith('0x')) text = text.slice(2)
  if (/^[0-9a-f]{3}$/u.test(text)) text = text.split('').map((char) => char + char).join('')
  if (!/^[0-9a-f]{6}$/u.test(text)) return null
  return `#${text}`
}

/** '#rrggbb' -> '0xRRGGBB' (the form ffmpeg's colour parser is happiest with). */
function ffColor(hex) {
  return `0x${hex.slice(1)}`
}

/** drawtext colour with optional alpha, e.g. `0xffffff@0.82`. */
function drawtextColor(hex, alpha = 1) {
  return alpha >= 1 ? ffColor(hex) : `${ffColor(hex)}@${fnum(alpha)}`
}

function hexToRgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

/** Blend two RGB triples. */
function blendRgb(from, to, amount) {
  const k = clamp(amount, 0, 1)
  return [
    Math.round(from[0] + (to[0] - from[0]) * k),
    Math.round(from[1] + (to[1] - from[1]) * k),
    Math.round(from[2] + (to[2] - from[2]) * k),
  ]
}

// ---------------------------------------------------------------------------
// plan validation / normalisation
// ---------------------------------------------------------------------------

/** Resolve an input path from the plan (absolute preferred; relative tolerated). */
function resolveInputPath(value, label, warnings) {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const trimmed = value.trim()
  if (isAbsolute(trimmed)) return trimmed
  const resolved = resolve(trimmed)
  warnings.push(`${label} is not an absolute path; resolved against the working directory as ${resolved}`)
  return resolved
}

function normaliseTransition(value, index, warnings) {
  if (index === 0) return 'cut'
  if (value === undefined || value === null) return 'cut'
  const name = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (name === '' || name === 'cut') return 'cut'
  if (TRANSITIONS.has(name)) return name
  warnings.push(`scenes[${index}].transitionIn "${String(value)}" is not supported; using "fade"`)
  return 'fade'
}

function normaliseFont(value, index, warnings) {
  if (value === undefined || value === null) return 'msyh'
  const name = String(value).trim().toLowerCase()
  if (FONTS.has(name)) return name
  warnings.push(`scenes[${index}].font "${String(value)}" is unknown; using "msyh"`)
  return 'msyh'
}

/**
 * Validate + normalise one scene. Throws on genuinely unusable input (missing
 * type-specific fields, non-positive duration), downgrades soft problems to
 * warnings (unknown font, unknown motion, ...).
 */
function normaliseScene(raw, index, planDefaults, warnings) {
  const at = `scenes[${index}]`
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`RenderPlan.${at} must be an object`)
  }
  const duration = numberOrNaN(raw.duration)

  let type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
  if (type === '') {
    if (typeof raw.text === 'string' && raw.text.trim().length > 0) type = 'text'
    else if (typeof raw.subtitle === 'string' && raw.subtitle.trim().length > 0) type = 'text'
    else if (typeof raw.src === 'string' && raw.src.trim().length > 0) {
      // A bare `src` without a type: video extensions become video scenes, the
      // rest is treated as an image (the renderer degrades gracefully for both).
      type = VIDEO_EXTENSIONS.has(extname(raw.src.trim()).toLowerCase()) ? 'video' : 'image'
    } else if (Array.isArray(raw.gradient)) type = 'gradient'
    else type = 'color'
  }
  if (!SCENE_TYPES.has(type)) {
    throw new Error(
      `RenderPlan.${at}.type "${String(raw.type)}" is not supported (expected text|image|color|gradient|video)`,
    )
  }

  // Video scenes splice in a pre-rendered segment, so any positive duration is
  // meaningful (`duration` must be > 0); the other scene types follow the 0.2 s
  // contract floor.
  const minDuration = type === 'video' ? 0 : MIN_SCENE_SECONDS
  if (!Number.isFinite(duration) || duration <= minDuration) {
    throw new Error(
      type === 'video'
        ? `RenderPlan.${at}.duration must be a positive number of seconds (got ${JSON.stringify(raw.duration)})`
        : `RenderPlan.${at}.duration must be a number >= ${MIN_SCENE_SECONDS} seconds (got ${JSON.stringify(raw.duration)})`,
    )
  }

  const scene = {
    index,
    type,
    duration: round3(duration),
    transitionIn: normaliseTransition(raw.transitionIn, index, warnings),
    transitionDuration: 0,
    font: normaliseFont(raw.font, index, warnings),
    fontSize: Number.isFinite(numberOrNaN(raw.fontSize)) && numberOrNaN(raw.fontSize) > 0
      ? clamp(numberOrNaN(raw.fontSize), 8, 400)
      : 96,
    color: parseHexColor(raw.color) ?? '#ffffff',
    background: parseHexColor(raw.background) ?? planDefaults.background,
    align: ALIGNS.has(String(raw.align ?? '').trim()) ? String(raw.align).trim() : 'center',
    animation: ANIMATIONS.has(String(raw.animation ?? '').trim()) ? String(raw.animation).trim() : 'none',
  }

  if (scene.transitionIn !== 'cut') {
    const requested = raw.transitionDuration === undefined || raw.transitionDuration === null
      ? DEFAULT_TRANSITION_SECONDS
      : numberOrNaN(raw.transitionDuration)
    scene.transitionDuration = Number.isFinite(requested) && requested > 0
      ? round3(requested)
      : DEFAULT_TRANSITION_SECONDS
  }

  if (scene.type === 'text') {
    const title = typeof raw.text === 'string' ? raw.text.trim() : ''
    const subtitle = typeof raw.subtitle === 'string' ? raw.subtitle.trim() : ''
    if (title.length === 0 && subtitle.length === 0) {
      warnings.push(`RenderPlan.${at} is a text scene without text; rendering it as a plain colour card`)
      scene.type = 'color'
    } else {
      scene.text = title
      scene.subtitle = subtitle
    }
  } else if (scene.type === 'image') {
    const src = resolveInputPath(raw.src, `RenderPlan.${at}.src`, warnings)
    if (src === null) throw new Error(`RenderPlan.${at}.src is required for image scenes`)
    scene.src = src
    const motion = String(raw.motion ?? '').trim().toLowerCase()
    if (motion === '' || motion === 'none') scene.motion = 'none'
    else if (MOTIONS.has(motion)) scene.motion = motion
    else {
      warnings.push(`RenderPlan.${at}.motion "${String(raw.motion)}" is unknown; using "none"`)
      scene.motion = 'none'
    }
    const fit = String(raw.fit ?? '').trim().toLowerCase()
    if (fit === '' || fit === 'cover') scene.fit = 'cover'
    else if (FITS.has(fit)) scene.fit = fit
    else {
      warnings.push(`RenderPlan.${at}.fit "${String(raw.fit)}" is unknown; using "cover"`)
      scene.fit = 'cover'
    }
  } else if (scene.type === 'gradient') {
    const rawColors = Array.isArray(raw.gradient) ? raw.gradient : []
    const colors = rawColors.map(parseHexColor).filter((color) => color !== null)
    if (colors.length < 2) {
      warnings.push(`RenderPlan.${at}.gradient needs at least two hex colours; using background + a lifted shade`)
      const base = hexToRgb(scene.background)
      const lifted = blendRgb(base, [255, 255, 255], 0.22)
      scene.gradient = [scene.background, `#${lifted.map((c) => c.toString(16).padStart(2, '0')).join('')}`]
    } else {
      scene.gradient = colors
    }
    const angle = numberOrNaN(raw.angle)
    scene.angle = Number.isFinite(angle) ? angle : 45
  } else if (scene.type === 'video') {
    // Pre-rendered segments (e.g. code-animation renders from renderAnimation)
    // are spliced into the timeline as normalised scene clips.
    const src = resolveInputPath(raw.src, `RenderPlan.${at}.src`, warnings)
    if (src === null) throw new Error(`RenderPlan.${at}.src is required for video scenes`)
    scene.src = src
    const fit = String(raw.fit ?? '').trim().toLowerCase()
    if (fit === '' || fit === 'cover') scene.fit = 'cover'
    else if (FITS.has(fit)) scene.fit = fit
    else {
      warnings.push(`RenderPlan.${at}.fit "${String(raw.fit)}" is unknown; using "cover"`)
      scene.fit = 'cover'
    }
    // Scene audio is never mixed into the soundtrack (the soundtrack is built
    // only from audio.music + audio.voiceover), so `muted` defaults to true.
    scene.muted = raw.muted === undefined || raw.muted === null ? true : raw.muted !== false
    if (scene.muted === false) {
      warnings.push(
        `RenderPlan.${at}.muted is false, but audio from video scenes is never mixed into the soundtrack; the source audio is dropped`,
      )
    }
  }

  if (!ALIGNS.has(scene.align)) {
    warnings.push(`RenderPlan.${at}.align "${String(raw.align)}" is unknown; using "center"`)
    scene.align = 'center'
  }
  if (!ANIMATIONS.has(scene.animation)) {
    warnings.push(`RenderPlan.${at}.animation "${String(raw.animation)}" is unknown; using "none"`)
    scene.animation = 'none'
  }
  return scene
}

/** Clamp transition durations so a short scene cannot be swallowed by fades. */
function clampTransitions(scenes, warnings) {
  for (let index = 1; index < scenes.length; index += 1) {
    const scene = scenes[index]
    if (scene.transitionDuration <= 0) continue
    const maxAllowed = 0.9 * Math.min(scene.duration, scenes[index - 1].duration)
    if (scene.transitionDuration > maxAllowed) {
      const clamped = round3(Math.max(0.05, maxAllowed))
      warnings.push(
        `scenes[${index}].transitionDuration ${scene.transitionDuration}s is too long for the neighbouring scenes; clamped to ${clamped}s`,
      )
      scene.transitionDuration = clamped
    }
  }
}

/** Contract timeline arithmetic. */
function computeTimeline(scenes) {
  const timeline = []
  let end = 0
  for (let index = 0; index < scenes.length; index += 1) {
    end += scenes[index].duration
    if (index > 0) end -= scenes[index].transitionDuration
    const start = end - scenes[index].duration
    timeline.push({
      index,
      type: scenes[index].type,
      start: round2(Math.max(0, start)),
      end: round2(end),
    })
  }
  return timeline
}

function normaliseCaptions(rawCaptions, plan, total, warnings) {
  if (rawCaptions === undefined || rawCaptions === null) return []
  if (!Array.isArray(rawCaptions)) {
    warnings.push('RenderPlan.captions is not an array; ignoring it')
    return []
  }
  const captions = []
  for (let index = 0; index < rawCaptions.length; index += 1) {
    const raw = rawCaptions[index]
    const at = `captions[${index}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push(`RenderPlan.${at} is not an object; skipping it`)
      continue
    }
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (text.length === 0) {
      warnings.push(`RenderPlan.${at}.text is empty; skipping the caption`)
      continue
    }
    const startRaw = numberOrNaN(raw.start ?? 0)
    const endRaw = numberOrNaN(raw.end)
    const start = Number.isFinite(startRaw) ? Math.max(0, startRaw) : 0
    if (!Number.isFinite(endRaw)) {
      warnings.push(`RenderPlan.${at}.end is not a finite number; skipping the caption`)
      continue
    }
    const end = Math.min(endRaw, total)
    if (end - start < 0.2 || end <= 0 || start >= total) {
      warnings.push(`RenderPlan.${at} lies outside the rendered timeline; skipping the caption`)
      continue
    }
    const position = CAPTION_POSITIONS.has(String(raw.position ?? '').trim())
      ? String(raw.position).trim()
      : 'bottom'
    captions.push({
      start: round3(start),
      end: round3(end),
      text,
      position,
      fontSize: Number.isFinite(numberOrNaN(raw.fontSize)) && numberOrNaN(raw.fontSize) > 0
        ? clamp(numberOrNaN(raw.fontSize), 8, 400)
        : 44,
      color: parseHexColor(raw.color) ?? '#ffffff',
    })
  }
  return captions
}

function normaliseAudio(rawAudio, warnings) {
  const audio = {
    music: null,
    musicStart: 0,
    musicVolumeDb: -20,
    musicFadeOut: 2,
    voiceover: [],
  }
  if (rawAudio === undefined || rawAudio === null) return audio
  if (typeof rawAudio !== 'object' || Array.isArray(rawAudio)) {
    warnings.push('RenderPlan.audio is not an object; building the video without sound')
    return audio
  }
  audio.music = resolveInputPath(rawAudio.music, 'RenderPlan.audio.music', warnings)
  const musicStart = numberOrNaN(rawAudio.musicStart)
  audio.musicStart = Number.isFinite(musicStart) ? Math.max(0, musicStart) : 0
  const volumeDb = numberOrNaN(rawAudio.musicVolumeDb)
  audio.musicVolumeDb = Number.isFinite(volumeDb) ? clamp(volumeDb, -60, 12) : -20
  const fadeOut = numberOrNaN(rawAudio.musicFadeOut)
  audio.musicFadeOut = Number.isFinite(fadeOut) ? clamp(fadeOut, 0, 60) : 2

  const rawVoiceover = rawAudio.voiceover
  if (rawVoiceover === undefined || rawVoiceover === null) return audio
  if (!Array.isArray(rawVoiceover)) {
    warnings.push('RenderPlan.audio.voiceover is not an array; ignoring narration')
    return audio
  }
  for (let index = 0; index < rawVoiceover.length; index += 1) {
    const raw = rawVoiceover[index]
    const at = `audio.voiceover[${index}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push(`RenderPlan.${at} is not an object; skipping it`)
      continue
    }
    const src = resolveInputPath(raw.src, `RenderPlan.${at}.src`, warnings)
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (src === null && text.length === 0) {
      warnings.push(`RenderPlan.${at} has neither src nor text; skipping it`)
      continue
    }
    const startRaw = numberOrNaN(raw.start ?? 0)
    const volumeDbRaw = numberOrNaN(raw.volumeDb ?? 0)
    const rateRaw = numberOrNaN(raw.rate ?? 1)
    audio.voiceover.push({
      src,
      text: src === null ? text : '',
      start: Number.isFinite(startRaw) ? Math.max(0, startRaw) : 0,
      volumeDb: Number.isFinite(volumeDbRaw) ? clamp(volumeDbRaw, -40, 12) : 0,
      voice: typeof raw.voice === 'string' && raw.voice.trim().length > 0 ? raw.voice.trim() : 'zh',
      rate: Number.isFinite(rateRaw) ? clamp(rateRaw, 0.5, 2) : 1,
    })
  }
  return audio
}

/** Validate the whole plan and return the normalised object. Throws on fatal problems. */
function normalisePlan(rawPlan, warnings) {
  if (rawPlan === null || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    throw new Error('buildVideo requires a RenderPlan object')
  }
  const output = resolveInputPath(rawPlan.output, 'RenderPlan.output', warnings)
  if (output === null) throw new Error('RenderPlan.output is required (absolute path of the MP4 to write)')

  let width = Number.isFinite(numberOrNaN(rawPlan.width)) ? Math.round(numberOrNaN(rawPlan.width)) : DEFAULT_WIDTH
  let height = Number.isFinite(numberOrNaN(rawPlan.height)) ? Math.round(numberOrNaN(rawPlan.height)) : DEFAULT_HEIGHT
  let fps = Number.isFinite(numberOrNaN(rawPlan.fps)) ? Math.round(numberOrNaN(rawPlan.fps)) : DEFAULT_FPS
  width = clamp(width, 16, MAX_DIMENSION)
  height = clamp(height, 16, MAX_DIMENSION)
  fps = clamp(fps, 1, MAX_FPS)
  if (width % 2 !== 0) {
    width -= 1
    warnings.push(`RenderPlan.width was odd; using ${width} so the frame is yuv420p-compatible`)
  }
  if (height % 2 !== 0) {
    height -= 1
    warnings.push(`RenderPlan.height was odd; using ${height} so the frame is yuv420p-compatible`)
  }

  const background = parseHexColor(rawPlan.background) ?? '#101018'
  const loudnessTarget = rawPlan.loudnessTarget === null
    ? null
    : Number.isFinite(numberOrNaN(rawPlan.loudnessTarget))
      ? clamp(numberOrNaN(rawPlan.loudnessTarget), -40, 0)
      : -16

  if (!Array.isArray(rawPlan.scenes) || rawPlan.scenes.length === 0) {
    throw new Error('RenderPlan.scenes must be a non-empty array')
  }
  const scenes = rawPlan.scenes.map((scene, index) =>
    normaliseScene(scene, index, { background }, warnings),
  )
  clampTransitions(scenes, warnings)

  const timeline = computeTimeline(scenes)
  const total = timeline.length > 0 ? timeline[timeline.length - 1].end : 0
  if (!(total > 0.2)) {
    throw new Error(`RenderPlan produces a non-positive duration (${fnum(total)}s after transitions)`)
  }

  return {
    output,
    width,
    height,
    fps,
    background,
    loudnessTarget,
    scenes,
    captions: normaliseCaptions(rawPlan.captions, { width, height, fps }, total, warnings),
    audio: normaliseAudio(rawPlan.audio, warnings),
    total,
    timeline,
  }
}

// ---------------------------------------------------------------------------
// ffmpeg plumbing
// ---------------------------------------------------------------------------

/** Abort-aware wrapper around an ffmpeg run with a labelled error message. */
async function runFfmpeg({ tools, args, cwd, signal, stage, onCommand, timeoutMs = 900_000 }) {
  throwIfAborted(signal)
  if (typeof onCommand === 'function') {
    try {
      onCommand({ stage, binary: tools.ffmpeg, args: [...args], cwd })
    } catch {
      // Diagnostics hooks must never break a render.
    }
  }
  const result = await run(tools.ffmpeg, args, { cwd, signal, timeoutMs })
  if (result.code === 124 && signal?.aborted === true) {
    const error = new Error('buildVideo aborted')
    error.name = 'AbortError'
    throw error
  }
  if (result.code !== 0) {
    throw new Error(`${stage} failed (ffmpeg exit ${result.code}):\n${tailLines(result.stderr, 14)}`)
  }
  return result
}

/** Fail fast on unusable inputs and drop optional media that is missing. */
async function preflightInputs(tools, plan, warnings) {
  for (const scene of plan.scenes) {
    if (scene.type === 'image') {
      if (!(await fileExists(scene.src))) {
        throw new Error(`scenes[${scene.index}].src file not found: ${scene.src}`)
      }
      continue
    }
    if (scene.type !== 'video') continue
    if (!(await fileExists(scene.src))) {
      throw new Error(`scenes[${scene.index}].src file not found: ${scene.src}`)
    }
    // Video scenes are spliced in as pre-rendered segments, so probe now: the
    // duration decides whether to trim or to freeze the last frame later.
    let probed = null
    try {
      probed = await probe(tools, scene.src)
    } catch (error) {
      throw new Error(
        `scenes[${scene.index}].src is not a readable video (${scene.src}): ${
          error instanceof Error ? error.message.split(/\r?\n/u)[0] : String(error)
        }`,
      )
    }
    const streams = Array.isArray(probed?.streams) ? probed.streams : []
    const videoStream = streams.find(
      (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
    )
    if (videoStream === undefined) {
      throw new Error(`scenes[${scene.index}].src has no video stream: ${scene.src}`)
    }
    const duration = Number.parseFloat(probed?.format?.duration ?? videoStream.duration ?? '0') || 0
    scene.source = {
      duration,
      width: Number(videoStream.width) || 0,
      height: Number(videoStream.height) || 0,
    }
    if (!(duration > 0)) {
      warnings.push(`scenes[${scene.index}].src has no measurable duration; its last frame will be frozen to fill the scene`)
    }
  }
  if (plan.audio.music !== null && !(await fileExists(plan.audio.music))) {
    warnings.push(`music file not found; rendering without a music bed: ${plan.audio.music}`)
    plan.audio.music = null
  }
  const kept = []
  for (let index = 0; index < plan.audio.voiceover.length; index += 1) {
    const entry = plan.audio.voiceover[index]
    if (entry.src !== null && !(await fileExists(entry.src))) {
      warnings.push(`audio.voiceover[${index}].src file not found; skipping it: ${entry.src}`)
      continue
    }
    kept.push(entry)
  }
  plan.audio.voiceover = kept
}

/**
 * Copy the fonts needed by drawtext into the working directory and return a
 * map of font key -> relative file name. Uses a fallback chain so a missing
 * 微软雅黑 does not silently produce tofu boxes.
 */
async function ensureFonts(plan, renderDir, warnings) {
  const needed = new Set()
  for (const scene of plan.scenes) {
    if (scene.type === 'text') needed.add(scene.font)
  }
  // Captions are always Chinese-capable text, so they force a CJK font too.
  if (plan.captions.length > 0) needed.add('msyh')
  const resolved = new Map()
  for (const key of needed) {
    const order = [key, ...FONT_FALLBACKS.filter((candidate) => candidate !== key)]
    let chosen = null
    for (const candidate of order) {
      const font = FONTS.get(candidate)
      if (font === undefined) continue
      const target = join(renderDir, font.file)
      if (await fileExists(target)) {
        chosen = font.file
        resolved.set(candidate, font.file)
        break
      }
      try {
        await copyFile(font.source, target)
        chosen = font.file
        resolved.set(candidate, font.file)
        break
      } catch {
        // Font not installed: try the next variant.
      }
    }
    if (chosen === null) {
      warnings.push(`no usable font file for "${key}"; text rendered in that font will be skipped`)
    } else {
      resolved.set(key, chosen)
    }
  }
  return resolved
}

// ---------------------------------------------------------------------------
// stage 1 — one intermediate clip per scene
// ---------------------------------------------------------------------------

/** Pixel dimensions for a still/image scene chain that keeps the aspect ratio. */
function fitChain(scene, plan) {
  const { width, height } = plan
  if (scene.fit === 'contain') {
    return (
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${ffColor(scene.background)},setsar=1`
    )
  }
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${width}:${height},setsar=1`
  )
}

/** zoompan chain for one of the still-image motions (input is pre-upscaled). */
function motionChain(scene, plan, frames) {
  const { width, height, fps } = plan
  const preWidth = even(width * 1.4)
  const preHeight = even(height * 1.4)
  const denom = Math.max(1, frames - 1)
  const zoomStep = frames > 1 ? 0.15 / frames : 0.15
  let zoom = ''
  let x = `iw/2-(iw/zoom/2)`
  let y = `ih/2-(ih/zoom/2)`
  if (scene.motion === 'kenburns-in') {
    zoom = `z='min(zoom+${fnum(zoomStep)},1.15)'`
  } else if (scene.motion === 'kenburns-out') {
    zoom = `z='if(lte(on,1),1.15,max(zoom-${fnum(zoomStep)},1.0))'`
  } else if (scene.motion === 'pan-left') {
    zoom = `z='1.12'`
    x = `'(iw-iw/zoom)*max(0,min(1-(on-1)/${denom},1))'`
  } else if (scene.motion === 'pan-right') {
    zoom = `z='1.12'`
    x = `'(iw-iw/zoom)*max(0,min((on-1)/${denom},1))'`
  } else if (scene.motion === 'pan-up' || scene.motion === 'tilt-up') {
    // Vertical travel has to be written on y and x pinned to centre; zoompan's
    // y expression uses the same normalised 0..1 travel as the horizontal pans.
    zoom = `z='1.12'`
    y = `'(ih-ih/zoom)*max(0,min(1-(on-1)/${denom},1))'`
  } else if (scene.motion === 'pan-down' || scene.motion === 'tilt-down') {
    zoom = `z='1.12'`
    y = `'(ih-ih/zoom)*max(0,min((on-1)/${denom},1))'`
  } else {
    zoom = `z='1.0'`
  }
  const pre = scene.fit === 'contain'
    ? `scale=${preWidth}:${preHeight}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${preWidth}:${preHeight}:(ow-iw)/2:(oh-ih)/2:color=${ffColor(scene.background)},setsar=1`
    : `scale=${preWidth}:${preHeight}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${preWidth}:${preHeight},setsar=1`
  const zoompan = `zoompan=${zoom}:x=${x}:y=${y}:d=${frames}:s=${width}x${height}:fps=${fps}`
  return `${pre},${zoompan},setsar=1`
}

/** Write one drawtext filter string using a text file (never inline text). */
function drawtextFilter({ fontFile, textFile, fontSize, color, x, y, extra = '' }) {
  const border = Math.max(2, Math.round(fontSize * 0.035))
  return (
    `drawtext=fontfile=${fontFile}:textfile=${textFile}:expansion=none:` +
    `fontcolor=${color}:fontsize=${fontSize}:x=${x}:y=${y}:` +
    `shadowcolor=0x000000@0.55:shadowx=${border}:shadowy=${border}${extra}`
  )
}

/**
 * Build the `-vf` chain (and the text files it references) for a text scene.
 * Titles/subtitles are split per line, auto-shrunk until they fit, then laid out
 * as a vertically centred block (or a lower-third for align: bottom).
 */
async function textSceneFilters(scene, plan, renderDir, fontFile, warnings) {
  const titleLines = splitLines(scene.text)
  const subtitleLines = splitLines(scene.subtitle)
  const maxWidth = plan.width * TEXT_MAX_WIDTH_SHARE
  const maxHeight = plan.height * TEXT_MAX_HEIGHT_SHARE
  const baseTitle = Math.round(scene.fontSize * (plan.width / 1080))
  const minTitle = 16

  let titleSize = Math.round(baseTitle)
  let subtitleSize = Math.max(20, Math.round(titleSize * 0.58))
  for (;;) {
    subtitleSize = subtitleLines.length > 0 ? Math.max(20, Math.round(titleSize * 0.58)) : 0
    const titleLineHeight = Math.round(titleSize * 1.3)
    const subtitleLineHeight = Math.round(subtitleSize * 1.34)
    const gap = subtitleLines.length > 0 ? Math.round(titleSize * 0.3) : 0
    const widest = Math.max(
      titleLines.reduce((max, line) => Math.max(max, estimateTextWidth(line, titleSize)), 0),
      subtitleLines.reduce((max, line) => Math.max(max, estimateTextWidth(line, subtitleSize)), 0),
    )
    const blockHeight =
      titleLines.length * titleLineHeight + gap + subtitleLines.length * subtitleLineHeight
    if ((widest <= maxWidth && blockHeight <= maxHeight) || titleSize <= minTitle) break
    titleSize -= 1
  }
  if (titleSize < baseTitle) {
    warnings.push(
      `scenes[${scene.index}] text was auto-shrunk from ${baseTitle}px to ${titleSize}px so it fits the frame`,
    )
  }

  const titleLineHeight = Math.round(titleSize * 1.3)
  const subtitleSizeFinal = subtitleLines.length > 0 ? Math.max(20, Math.round(titleSize * 0.58)) : 0
  const subtitleLineHeight = Math.round(subtitleSizeFinal * 1.34)
  const gap = subtitleLines.length > 0 ? Math.round(titleSize * 0.3) : 0
  const titleBlockHeight = titleLines.length * titleLineHeight
  const subtitleBlockHeight = subtitleLines.length * subtitleLineHeight
  const blockHeight = titleBlockHeight + gap + subtitleBlockHeight
  const blockTop = scene.align === 'bottom'
    ? Math.round(plan.height - plan.height * 0.12 - blockHeight)
    : Math.round((plan.height - blockHeight) / 2)
  const x = scene.align === 'left' ? String(Math.round(plan.width * 0.08)) : '(w-text_w)/2'
  const slideDistance = Math.round(plan.height * 0.035)
  const animatedY = (top) => {
    if (scene.animation !== 'slide-up') return String(top)
    return `'${top}+${slideDistance}*pow(max(0,1-t/0.45),2)'`
  }

  const filters = []
  let y = blockTop
  for (let lineIndex = 0; lineIndex < titleLines.length; lineIndex += 1) {
    const textFile = `scene-${scene.index}-title-${lineIndex}.txt`
    await writeFile(join(renderDir, textFile), titleLines[lineIndex], 'utf8')
    filters.push(
      drawtextFilter({
        fontFile,
        textFile,
        fontSize: titleSize,
        color: drawtextColor(scene.color),
        x,
        y: animatedY(y),
      }),
    )
    y += titleLineHeight
  }
  y += gap
  for (let lineIndex = 0; lineIndex < subtitleLines.length; lineIndex += 1) {
    const textFile = `scene-${scene.index}-subtitle-${lineIndex}.txt`
    await writeFile(join(renderDir, textFile), subtitleLines[lineIndex], 'utf8')
    filters.push(
      drawtextFilter({
        fontFile,
        textFile,
        fontSize: subtitleSizeFinal,
        color: drawtextColor(scene.color, 0.82),
        x,
        y: animatedY(y),
      }),
    )
    y += subtitleLineHeight
  }
  if (scene.animation === 'fade') filters.push('fade=t=in:st=0:d=0.4')
  return filters
}

/** Render a gradient canvas PNG for a gradient scene and return its relative name. */
async function renderGradientImage(scene, plan, renderDir) {
  const { width, height } = plan
  const colors = scene.gradient.map(hexToRgb)
  const canvas = new Canvas(width, height, [...colors[0], 255])
  const angle = (scene.angle * Math.PI) / 180
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const cx = width / 2
  const cy = height / 2
  let minProjection = Number.POSITIVE_INFINITY
  let maxProjection = Number.NEGATIVE_INFINITY
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
    const projection = (x - cx) * dx + (y - cy) * dy
    if (projection < minProjection) minProjection = projection
    if (projection > maxProjection) maxProjection = projection
  }
  const span = maxProjection - minProjection || 1
  const stops = colors.length
  for (let y = 0; y < height; y += 1) {
    const rowBase = (y - cy) * dy
    for (let x = 0; x < width; x += 1) {
      const t = clamp(((x - cx) * dx + rowBase - minProjection) / span, 0, 1)
      const position = t * (stops - 1)
      const fromIndex = Math.min(stops - 2, Math.floor(position))
      const local = position - fromIndex
      const rgb = blendRgb(colors[fromIndex], colors[fromIndex + 1], local)
      canvas.set(x, y, [rgb[0], rgb[1], rgb[2], 255])
    }
  }
  const fileName = `gradient-${scene.index}.png`
  await canvas.save(join(renderDir, fileName))
  return fileName
}

/**
 * Render one scene to `<renderDir>/scene-XX.mp4` and return the absolute path.
 *
 * All clips use the same geometry/fps/pixel format so stage 2 can mix `xfade`
 * and `concat` without re-scaling.
 */
async function renderSceneClip({ tools, plan, scene, renderDir, fonts, signal, warnings, onCommand }) {
  const frames = Math.max(1, Math.round(scene.duration * plan.fps))
  const sourceSeconds = fnum(frames / plan.fps)
  const outName = `scene-${String(scene.index).padStart(2, '0')}.mp4`
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  let filters = []

  if (scene.type === 'color' || scene.type === 'text') {
    args.push('-f', 'lavfi', '-i', `color=c=${ffColor(scene.background)}:s=${plan.width}x${plan.height}:r=${plan.fps}:d=${sourceSeconds}`)
    if (scene.type === 'text') {
      const fontFile = fonts.get(scene.font)
      if (fontFile === undefined) {
        warnings.push(`scenes[${scene.index}] has no font available; rendering the title as a plain colour card`)
      } else {
        filters = await textSceneFilters(scene, plan, renderDir, fontFile, warnings)
      }
    }
    filters.push('format=yuv420p', 'setsar=1')
  } else if (scene.type === 'gradient') {
    const fileName = await renderGradientImage(scene, plan, renderDir)
    args.push('-loop', '1', '-framerate', String(plan.fps), '-t', sourceSeconds, '-i', fileName)
    filters.push(`scale=${plan.width}:${plan.height}:flags=lanczos`, 'setsar=1', `fps=${plan.fps}`)
    filters.push('format=yuv420p')
  } else if (scene.type === 'video') {
    // Splice a pre-rendered segment (mp4/webm/mov...) into the timeline: scale to
    // the plan geometry (crop for cover, pad for contain), normalise the frame
    // rate, then trim or freeze the last frame so the clip is exactly `frames`.
    args.push('-i', scene.src)
    filters.push(fitChain(scene, plan), `fps=${plan.fps}`)
    const sourceDuration = scene.source?.duration ?? 0
    // Normalise to the scene's exact frame count: trim if the source is longer,
    // freeze the last frame with tpad if it is shorter. The frame-count compare
    // (not the raw seconds) avoids an unnecessary tpad for exact-length sources;
    // the small +0.05 s margin covers duration rounding at the source frame rate.
    const sourceFrames = Math.max(0, Math.round(sourceDuration * plan.fps))
    const missingFrames = frames - sourceFrames
    if (!(sourceDuration > 0) || missingFrames > 0) {
      const freezeSeconds = Math.max(0.05, missingFrames / plan.fps + 0.05)
      filters.push(`tpad=stop_mode=clone:stop_duration=${fnum(freezeSeconds)}`)
      scene.freezeSeconds = round3(Math.min(frames / plan.fps, freezeSeconds))
    }
    filters.push('format=yuv420p')
  } else if (scene.type === 'image') {
    const isStillImage = IMAGE_EXTENSIONS.has(extname(scene.src).toLowerCase())
    if (!isStillImage) {
      // A video file slipped into an image scene: use it as a moving backdrop.
      if (scene.motion !== 'none') {
        warnings.push(
          `scenes[${scene.index}].src is not a still image; ignoring motion "${scene.motion}" and using the clip as-is`,
        )
      }
      args.push('-i', scene.src)
      filters.push(fitChain(scene, plan), `fps=${plan.fps}`, 'format=yuv420p')
    } else if (scene.motion === 'none') {
      args.push('-loop', '1', '-framerate', String(plan.fps), '-t', sourceSeconds, '-i', scene.src)
      filters.push(fitChain(scene, plan), `fps=${plan.fps}`, 'format=yuv420p')
    } else {
      // zoompan wants a single frame and expands it into `frames` output frames.
      args.push('-i', scene.src)
      filters.push(motionChain(scene, plan, frames), 'format=yuv420p')
    }
  } else {
    throw new Error(`internal error: unsupported scene type "${scene.type}"`)
  }

  if (scene.type === 'video') args.push('-t', sourceSeconds)
  args.push(
    '-vf', filters.join(','),
    '-frames:v', String(frames),
    '-r', String(plan.fps),
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', VIDEO_PRESET,
    '-crf', VIDEO_CRF,
    '-an',
    outName,
  )
  await runFfmpeg({
    tools,
    args,
    cwd: renderDir,
    signal,
    stage: `scene ${scene.index} (${scene.type})`,
    onCommand,
  })
  return join(renderDir, outName)
}

// ---------------------------------------------------------------------------
// audio preparation
// ---------------------------------------------------------------------------

/** Synthesize narration segments and probe fixed voice files for their length. */
async function prepareVoiceovers({ tools, plan, renderDir, warnings, signal }) {
  const segments = []
  for (let index = 0; index < plan.audio.voiceover.length; index += 1) {
    const entry = plan.audio.voiceover[index]
    if (entry.src !== null) {
      let seconds = 0
      try {
        const probed = await probe(tools, entry.src, { signal })
        seconds = Number.parseFloat(probed?.format?.duration ?? '0') || 0
      } catch {
        warnings.push(`audio.voiceover[${index}] could not be probed; its length is unknown`)
      }
      segments.push({ ...entry, path: entry.src, seconds })
      continue
    }
    const outputPath = join(renderDir, `voice-${index}.wav`)
    const synthesized = await synthesizeSpeech({
      tools,
      text: entry.text,
      outputPath,
      voice: entry.voice,
      rate: entry.rate,
      volume: 1,
      workDir: renderDir,
      signal,
    })
    throwIfAborted(signal)
    if (!synthesized.ok) {
      warnings.push(`audio.voiceover[${index}] narration skipped: ${synthesized.warnings.join('; ') || 'speech synthesis failed'}`)
      continue
    }
    for (const warning of synthesized.warnings) warnings.push(`audio.voiceover[${index}]: ${warning}`)
    segments.push({ ...entry, path: synthesized.path, seconds: synthesized.seconds, voice: synthesized.voice })
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment.seconds > 0 && segment.start + segment.seconds > plan.total + 0.05) {
      warnings.push(
        `audio.voiceover[${index}] ends at ${fnum(segment.start + segment.seconds)}s but the video is ${fnum(plan.total)}s long; it will be cut off`,
      )
    }
  }
  return segments
}

// ---------------------------------------------------------------------------
// stage 2 — assemble scenes with xfade/concat + mix audio
// ---------------------------------------------------------------------------

/** Group scene indexes into "runs" separated by hard cuts. */
function splitRuns(scenes) {
  const runs = []
  let current = []
  for (let index = 0; index < scenes.length; index += 1) {
    if (index > 0 && (scenes[index].transitionIn === 'cut' || scenes[index].transitionDuration <= 0)) {
      runs.push(current)
      current = []
    }
    current.push(index)
  }
  runs.push(current)
  return runs
}

/** Build the video portion of the assembly filtergraph and return its output label. */
function buildVideoGraph(scenes, runs) {
  const parts = []
  for (let index = 0; index < scenes.length; index += 1) {
    parts.push(`[${index}:v]setpts=PTS-STARTPTS,settb=AVTB[s${index}]`)
  }
  runs.forEach((run, runIndex) => {
    if (run.length === 1) {
      parts.push(`[s${run[0]}]null[run${runIndex}]`)
      return
    }
    let previous = `[s${run[0]}]`
    let accumulated = scenes[run[0]].duration
    for (let step = 1; step < run.length; step += 1) {
      const index = run[step]
      const transition = scenes[index].transitionIn
      const duration = scenes[index].transitionDuration
      const offset = accumulated - duration
      const label = step === run.length - 1 ? `[run${runIndex}]` : `[x${runIndex}_${step}]`
      parts.push(
        `${previous}[s${index}]xfade=transition=${transition}:duration=${fnum(duration)}:offset=${fnum(offset)}${label}`,
      )
      accumulated = accumulated + scenes[index].duration - duration
      previous = label
    }
  })
  if (runs.length === 1) {
    parts.push('[run0]null[vc]')
  } else {
    parts.push(`${runs.map((_, index) => `[run${index}]`).join('')}concat=n=${runs.length}:v=1:a=0[vc]`)
  }
  return { parts, output: '[vc]' }
}

/** Build the audio portion of the assembly filtergraph and return its output label. */
function buildAudioGraph({ plan, voiceSegments, musicIndex, voiceIndices, baseIndex, hasLoudnorm }) {
  const parts = []
  const mixInputs = []
  const total = plan.total

  parts.push(`[${baseIndex}:a]atrim=0:${fnum(total)},asetpts=PTS-STARTPTS[abase]`)
  mixInputs.push('[abase]')

  if (musicIndex !== null) {
    const fadeOut = Math.min(plan.audio.musicFadeOut, plan.total)
    const fadeStart = Math.max(0, plan.total - fadeOut)
    const fade = fadeOut > 0 ? `,afade=t=out:st=${fnum(fadeStart)}:d=${fnum(fadeOut)}` : ''
    parts.push(
      `[${musicIndex}:a]atrim=start=${fnum(plan.audio.musicStart)}:duration=${fnum(total)},asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,` +
        `volume=${fnum(plan.audio.musicVolumeDb)}dB${fade},apad=whole_dur=${fnum(total)}[amus]`,
    )
    mixInputs.push('[amus]')
  }

  voiceIndices.forEach((inputIndex, index) => {
    const segment = voiceSegments[index]
    const delayMs = Math.round(Math.max(0, segment.start) * 1000)
    parts.push(
      `[${inputIndex}:a]aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,` +
        `volume=${fnum(segment.volumeDb)}dB,adelay=${delayMs}|${delayMs},` +
        `apad=whole_dur=${fnum(total)}[avo${index}]`,
    )
    mixInputs.push(`[avo${index}]`)
  })

  let chain =
    `amix=inputs=${mixInputs.length}:normalize=0:duration=longest` +
    (hasLoudnorm ? `,loudnorm=I=${fnum(plan.loudnessTarget)}:TP=-1.5:LRA=11` : '') +
    `,atrim=0:${fnum(total)},asetpts=PTS-STARTPTS[aout]`
  parts.push(`${mixInputs.join('')}${chain}`)
  return { parts, output: '[aout]' }
}

/**
 * Assemble all scene clips (xfade chain / concat) and the full audio mix in one
 * ffmpeg pass, producing `<renderDir>/assembled.mp4` with exactly one AAC track.
 */
async function assembleVideo({ tools, plan, sceneClips, voiceSegments, renderDir, signal, onCommand }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  let inputCount = 0
  for (const clipPath of sceneClips) {
    args.push('-i', clipPath)
    inputCount += 1
  }
  let musicIndex = null
  if (plan.audio.music !== null) {
    // Loop a short music bed so it covers the whole video; it is trimmed below.
    args.push('-stream_loop', '-1', '-i', plan.audio.music)
    musicIndex = inputCount
    inputCount += 1
  }
  const voiceIndices = []
  for (const segment of voiceSegments) {
    args.push('-i', segment.path)
    voiceIndices.push(inputCount)
    inputCount += 1
  }
  // Base silence of exactly the target duration: guarantees one audio stream even
  // when the plan asked for no sound at all.
  args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE}`)
  const baseIndex = inputCount
  inputCount += 1

  const runs = splitRuns(plan.scenes)
  const video = buildVideoGraph(plan.scenes, runs)
  const hasLoudnorm = plan.loudnessTarget !== null && (musicIndex !== null || voiceSegments.length > 0)
  const audio = buildAudioGraph({ plan, voiceSegments, musicIndex, voiceIndices, baseIndex, hasLoudnorm })
  const filterGraph = [...video.parts, ...audio.parts].join(';')

  args.push(
    '-filter_complex', filterGraph,
    '-map', video.output,
    '-map', audio.output,
    '-r', String(plan.fps),
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', VIDEO_PRESET,
    '-crf', VIDEO_CRF,
    '-c:a', 'aac',
    '-b:a', AUDIO_BITRATE,
    '-ar', String(AUDIO_SAMPLE_RATE),
    '-ac', '2',
    '-t', fnum(plan.total),
    '-movflags', '+faststart',
    'assembled.mp4',
  )
  await runFfmpeg({ tools, args, cwd: renderDir, signal, stage: 'assembly', onCommand })
  return join(renderDir, 'assembled.mp4')
}

// ---------------------------------------------------------------------------
// stage 3 — burn captions
// ---------------------------------------------------------------------------

/** Build the drawtext chain for all captions (one filter per wrapped line). */
async function captionFilters(plan, renderDir, fontFile, warnings) {
  const filters = []
  const maxWidth = plan.width * (1 - 2 * CAPTION_MARGIN_SHARE)
  const verticalMargin = Math.round(plan.height * CAPTION_MARGIN_SHARE)
  for (let index = 0; index < plan.captions.length; index += 1) {
    const caption = plan.captions[index]
    let fontSize = Math.round(caption.fontSize * (plan.width / 1080))
    let lines = wrapText(caption.text, fontSize, maxWidth, 3)
    while (lines.length > 3 && fontSize > 20) {
      fontSize -= 2
      lines = wrapText(caption.text, fontSize, maxWidth, 3)
    }
    if (lines.length > 3) {
      warnings.push(`captions[${index}] was longer than three lines at a readable size; it is truncated`)
      lines = lines.slice(0, 3)
    }
    const lineHeight = Math.round(fontSize * 1.3)
    const blockHeight = lines.length * lineHeight
    let blockTop
    if (caption.position === 'top') blockTop = verticalMargin
    else if (caption.position === 'center') blockTop = Math.round((plan.height - blockHeight) / 2)
    else blockTop = plan.height - verticalMargin - blockHeight
    const boxBorder = Math.max(6, Math.round(fontSize * 0.3))
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const textFile = `caption-${index}-${lineIndex}.txt`
      await writeFile(join(renderDir, textFile), lines[lineIndex], 'utf8')
      filters.push(
        `drawtext=fontfile=${fontFile}:textfile=${textFile}:expansion=none:` +
          `fontcolor=${drawtextColor(caption.color)}:fontsize=${fontSize}:` +
          `x=(w-text_w)/2:y=${blockTop + lineIndex * lineHeight}:` +
          `box=1:boxcolor=0x000000@0.42:boxborderw=${boxBorder}:` +
          `enable='between(t,${fnum(caption.start)},${fnum(caption.end)})'`,
      )
    }
  }
  return filters
}

/** Second pass: burn captions onto the assembled video, copying the audio track. */
async function burnCaptions({ tools, plan, assembledPath, renderDir, fonts, signal, warnings, onCommand }) {
  const fontFile = fonts.get('msyh') ?? fonts.values().next().value
  if (fontFile === undefined) {
    warnings.push('captions were requested but no font is available; skipping the caption pass')
    return assembledPath
  }
  const filters = await captionFilters(plan, renderDir, fontFile, warnings)
  if (filters.length === 0) return assembledPath
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', assembledPath,
    '-vf', filters.join(','),
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-r', String(plan.fps),
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', VIDEO_PRESET,
    '-crf', VIDEO_CRF,
    '-c:a', 'copy',
    '-t', fnum(plan.total),
    '-movflags', '+faststart',
    'captioned.mp4',
  ]
  try {
    await runFfmpeg({ tools, args, cwd: renderDir, signal, stage: 'caption burn', onCommand })
    return join(renderDir, 'captioned.mp4')
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    warnings.push(`caption pass failed; the video is delivered without burned captions: ${error instanceof Error ? error.message.split(/\r?\n/u)[0] : String(error)}`)
    return assembledPath
  }
}

// ---------------------------------------------------------------------------
// output commit + verification
// ---------------------------------------------------------------------------

/** Move the rendered file to the plan output path, creating parent directories. */
async function commitOutput(tempPath, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true })
  try {
    await rename(tempPath, outputPath)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      // Windows rename can fail when the destination exists/locked; fall back to copy.
    }
  }
  try {
    await copyFile(tempPath, outputPath)
  } catch (error) {
    throw new Error(`cannot write the output file "${outputPath}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Probe the delivered file and verify the contract invariants. */
async function verifyOutput(tools, outputPath, expected) {
  const probed = await probe(tools, outputPath)
  const streams = Array.isArray(probed?.streams) ? probed.streams : []
  const videoStreams = streams.filter((stream) => stream.codec_type === 'video')
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio')
  if (videoStreams.length === 0) throw new Error('rendered file has no video stream')
  if (audioStreams.length !== 1) {
    throw new Error(`rendered file has ${audioStreams.length} audio streams, expected exactly 1`)
  }
  const video = videoStreams[0]
  if (Number(video.width) !== expected.width || Number(video.height) !== expected.height) {
    throw new Error(
      `rendered resolution is ${video.width}x${video.height}, expected ${expected.width}x${expected.height}`,
    )
  }
  const measured = Number.parseFloat(probed?.format?.duration ?? '0') || 0
  return { measured, streams: streams.length }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Render a RenderPlan to a finished MP4.
 *
 * @param {{
 *   tools: {ffmpeg: string, ffprobe: string},
 *   plan: object,
 *   workDir: string,
 *   signal?: AbortSignal,
 *   options?: {keepWorkDir?: boolean, onCommand?: (info: object) => void},
 * }} input
 * @returns {Promise<{
 *   ok: true, output: string, duration: number, width: number, height: number, fps: number,
 *   scenes: number, bytes: number, renderSeconds: number,
 *   audio: {music: boolean, voiceoverSegments: number, loudnessNormalized: boolean},
 *   timeline: Array<{index: number, type: string, start: number, end: number}>,
 *   warnings: string[],
 * }>}
 */
export async function buildVideo({ tools, plan, workDir, signal, options = {} } = {}) {
  if (tools === null || typeof tools !== 'object' || typeof tools.ffmpeg !== 'string' || typeof tools.ffprobe !== 'string') {
    throw new Error('buildVideo requires tools = {ffmpeg, ffprobe} (use resolveTools() from lib/ffmpeg.js)')
  }
  if (typeof workDir !== 'string' || workDir.trim().length === 0) {
    throw new Error('buildVideo requires an absolute workDir for intermediate files')
  }
  const startedAt = Date.now()
  const warnings = []
  const absoluteWorkDir = resolve(workDir.trim())
  await mkdir(absoluteWorkDir, { recursive: true })

  const normalised = normalisePlan(plan, warnings)
  throwIfAborted(signal)

  const renderDir = join(
    absoluteWorkDir,
    `render-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
  )
  await mkdir(renderDir, { recursive: true })
  const onCommand = typeof options.onCommand === 'function' ? options.onCommand : null

  try {
    await preflightInputs(tools, normalised, warnings)
    const fonts = await ensureFonts(normalised, renderDir, warnings)

    // Stage 1: one intermediate clip per scene, all identical geometry.
    const sceneClips = []
    for (const scene of normalised.scenes) {
      throwIfAborted(signal)
      const clipPath = await renderSceneClip({
        tools,
        plan: normalised,
        scene,
        renderDir,
        fonts,
        signal,
        warnings,
        onCommand,
      })
      sceneClips.push(clipPath)
    }

    // Narration (SAPI) — failures degrade to "no voiceover" with a warning.
    const voiceSegments = await prepareVoiceovers({
      tools,
      plan: normalised,
      renderDir,
      warnings,
      signal,
    })

    // Stage 2: xfade/concat assembly + whole audio mix in a single encode.
    const assembledPath = await assembleVideo({
      tools,
      plan: normalised,
      sceneClips,
      voiceSegments,
      renderDir,
      signal,
      onCommand,
    })

    // Stage 3: burn captions (second pass over the assembled file).
    let deliverable = assembledPath
    if (normalised.captions.length > 0) {
      deliverable = await burnCaptions({
        tools,
        plan: normalised,
        assembledPath,
        renderDir,
        fonts,
        signal,
        warnings,
        onCommand,
      })
    }

    await commitOutput(deliverable, normalised.output)
    const verified = await verifyOutput(tools, normalised.output, normalised)
    const bytes = (await stat(normalised.output)).size
    const duration = round2(normalised.total)
    if (Math.abs(verified.measured - duration) > 0.2) {
      warnings.push(
        `rendered duration ${verified.measured.toFixed(2)}s differs from the planned ${duration.toFixed(2)}s by more than 0.2s`,
      )
    }
    return {
      ok: true,
      output: normalised.output,
      duration,
      measuredDuration: round2(verified.measured),
      width: normalised.width,
      height: normalised.height,
      fps: normalised.fps,
      scenes: normalised.scenes.length,
      bytes,
      renderSeconds: round2((Date.now() - startedAt) / 1000),
      audio: {
        music: normalised.audio.music !== null,
        voiceoverSegments: voiceSegments.length,
        loudnessNormalized: normalised.loudnessTarget !== null && (normalised.audio.music !== null || voiceSegments.length > 0),
      },
      timeline: normalised.timeline,
      warnings,
    }
  } finally {
    if (options.keepWorkDir !== true) {
      await rm(renderDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Exposed for tests/debugging: the contract timeline arithmetic. */
export function planTimeline(scenes) {
  let end = 0
  return scenes.map((scene, index) => {
    const duration = Number.isFinite(numberOrNaN(scene.duration)) ? numberOrNaN(scene.duration) : 0
    const cut = typeof scene.transitionIn === 'string' && scene.transitionIn.trim().toLowerCase() === 'cut'
    const transitionDuration = index > 0 && !cut && Number.isFinite(numberOrNaN(scene.transitionDuration))
      ? Math.max(0, numberOrNaN(scene.transitionDuration))
      : 0
    end += duration - transitionDuration
    return {
      index,
      type: typeof scene.type === 'string' ? scene.type : 'color',
      start: round2(Math.max(0, end - duration)),
      end: round2(end),
    }
  })
}

export default { buildVideo, planTimeline }
