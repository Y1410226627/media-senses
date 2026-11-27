/**
 * Editable delivery: RenderPlan <-> timeline JSON <-> offline HTML editor.
 *
 * Upstream ships a CapCut/JianYing project plus a motion workbench, so the user
 * can change a word, a duration or a volume in a GUI and re-export. We have no
 * JianYing dependency (`pyJianYingDraft` needs a Python environment), so this
 * module is the self-contained replacement:
 *
 *   planToTimeline(plan)      RenderPlan -> track/clip timeline (JSON)
 *   timelineToPlan(timeline)  timeline -> RenderPlan that lib/build.js re-renders
 *   renderTimelineHtml(tl)    one offline HTML file (embedded JSON) with text /
 *                             duration / volume editing and JSON export
 *   diffTimeline(a, b)        human-readable Chinese list of what changed
 *
 * Round-trip rule: `timelineToPlan(planToTimeline(p))` must be a RenderPlan that
 * renders the same video as `p`. All render-relevant plan fields live in the
 * timeline (`output`, `width`, `height`, `fps`, `background`, `loudnessTarget`,
 * scenes, overlays, captions, audio), and `planToTimeline` normalises defaults
 * exactly the way `lib/build.js` does, so re-normalising the round-tripped plan
 * gives back the identical timeline (a fixed point). The defaults below are
 * mirrored from lib/build.js (v0.8.0): keep them in sync if the RenderPlan
 * schema grows.
 *
 * Track mapping (one track per NLE concept; a scene's `type` stays on the clip):
 *   scenes           kind video   full-frame sequential scenes (text/image/color/
 *                                 gradient/video); xfade overlap is stored as
 *                                 start/end + transitionIn/transitionDuration
 *   captions         kind text    burned-in subtitles
 *   overlays-image   kind image   still picture overlays (PiP, corner logo)
 *   overlays-video   kind video   video overlays
 *   music            kind audio   the bed; clip.inPoint is musicStart
 *   voiceover        kind audio   narration (text clips have duration: null,
 *                                 since TTS decides their length at render time)
 *   sfx              kind sfx     optional plan.audio.sfx entries (pass-through)
 *
 * No upstream code is used here (the CapCut project format is not reproduced);
 * this is our own JSON design, so no THIRD-PARTY.md attribution entry is needed.
 * Pure functions only: no fs, no network, no Date.now/Math.random in render paths,
 * so the same plan always produces the same timeline and the same HTML.
 *
 * @module lib/timeline
 */

export const TIMELINE_VERSION = 'media-senses.timeline/v1'

/** Track kinds allowed by the delivery contract. */
export const TIMELINE_TRACK_KINDS = Object.freeze(['video', 'text', 'image', 'audio', 'sfx'])

// ---------------------------------------------------------------------------
// defaults mirrored from lib/build.js normalisePlan/normaliseScene
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 1080
const DEFAULT_HEIGHT = 1920
const DEFAULT_FPS = 30
const DEFAULT_BACKGROUND = '#101018'
const DEFAULT_LOUDNESS_TARGET = -16
const DEFAULT_TRANSITION_SECONDS = 0.5
const MIN_SCENE_SECONDS = 0.2
const MAX_DIMENSION = 7680
const MAX_FPS = 120

const SCENE_TYPES = new Set(['text', 'image', 'color', 'gradient', 'video'])
const ANIMATIONS = new Set(['none', 'fade', 'slide-up'])
const MOTIONS = new Set([
  'none',
  'kenburns-in', 'kenburns-out',
  'pan-left', 'pan-right', 'pan-up', 'pan-down',
  'tilt-up', 'tilt-down',
])
const FITS = new Set(['cover', 'contain'])
const ALIGNS = new Set(['center', 'left', 'bottom'])
const CAPTION_POSITIONS = new Set(['bottom', 'top', 'center'])
const OVERLAY_POSITIONS = new Set([
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
])
const TRANSITIONS = new Set([
  'fade', 'fadeblack', 'fadewhite',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'circleopen', 'circleclose', 'dissolve', 'pixelize', 'radial',
  'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
  'horzopen', 'horzclose', 'vertopen', 'vertclose',
])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.ts'])

const SCENE_TYPE_ZH = Object.freeze({
  text: '文字',
  image: '图片',
  color: '纯色',
  gradient: '渐变',
  video: '视频',
})
const TRACK_LABEL_ZH = Object.freeze({
  scenes: '画面',
  captions: '字幕',
  'overlays-image': '图片叠加',
  'overlays-video': '视频叠加',
  music: '背景音乐',
  voiceover: '旁白',
  sfx: '音效',
})

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

function round3(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0
}

function numberOrNaN(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim().length > 0) return Number(value)
  return Number.NaN
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** '#rgb' / '#rrggbb' / 'rrggbb' / '0xrrggbb' -> '#rrggbb' or null. */
function parseHexColor(value) {
  if (typeof value !== 'string') return null
  let text = value.trim().toLowerCase()
  if (text.startsWith('#')) text = text.slice(1)
  else if (text.startsWith('0x')) text = text.slice(2)
  if (/^[0-9a-f]{3}$/u.test(text)) text = text.split('').map((char) => char + char).join('')
  if (!/^[0-9a-f]{6}$/u.test(text)) return null
  return `#${text}`
}

function hexToRgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

function rgbToHex(rgb) {
  return `#${rgb.map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0')).join('')}`
}

function blendRgb(from, to, amount) {
  const k = clamp(amount, 0, 1)
  return [
    Math.round(from[0] + (to[0] - from[0]) * k),
    Math.round(from[1] + (to[1] - from[1]) * k),
    Math.round(from[2] + (to[2] - from[2]) * k),
  ]
}

function extensionOf(path) {
  const text = typeof path === 'string' ? path : ''
  const index = text.lastIndexOf('.')
  return index >= 0 ? text.slice(index).toLowerCase() : ''
}

function basenameOf(path) {
  const text = typeof path === 'string' ? path : ''
  const parts = text.split(/[\\/]/u)
  return parts[parts.length - 1] || text
}

// ---------------------------------------------------------------------------
// plan normalisation (mirrors lib/build.js; see the module header)
// ---------------------------------------------------------------------------

function normaliseTransition(value, index) {
  if (index === 0) return 'cut'
  if (value === undefined || value === null) return 'cut'
  const name = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (name === '' || name === 'cut') return 'cut'
  if (TRANSITIONS.has(name)) return name
  return 'fade'
}

function normaliseFont(value) {
  if (value === undefined || value === null) return 'msyh'
  const name = String(value).trim().toLowerCase()
  return ['msyh', 'msyhbd', 'arial', 'arialbd', 'simhei'].includes(name) ? name : 'msyh'
}

function normaliseScene(raw, index, planDefaults) {
  if (!isPlainObject(raw)) throw new Error(`RenderPlan.scenes[${index}] 必须是对象`)
  const duration = numberOrNaN(raw.duration)

  let type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
  if (type === '') {
    if (typeof raw.text === 'string' && raw.text.trim().length > 0) type = 'text'
    else if (typeof raw.subtitle === 'string' && raw.subtitle.trim().length > 0) type = 'text'
    else if (typeof raw.src === 'string' && raw.src.trim().length > 0) {
      type = VIDEO_EXTENSIONS.has(extensionOf(raw.src.trim())) ? 'video' : 'image'
    } else if (Array.isArray(raw.gradient)) type = 'gradient'
    else type = 'color'
  }
  if (!SCENE_TYPES.has(type)) {
    throw new Error(`RenderPlan.scenes[${index}].type "${String(raw.type)}" 不支持（text|image|color|gradient|video）`)
  }
  const minDuration = type === 'video' ? 0 : MIN_SCENE_SECONDS
  if (!Number.isFinite(duration) || duration <= minDuration) {
    throw new Error(
      type === 'video'
        ? `RenderPlan.scenes[${index}].duration 必须是正数（当前 ${JSON.stringify(raw.duration)}）`
        : `RenderPlan.scenes[${index}].duration 必须 >= ${MIN_SCENE_SECONDS} 秒（当前 ${JSON.stringify(raw.duration)}）`,
    )
  }

  const scene = {
    type,
    duration: round3(duration),
    transitionIn: normaliseTransition(raw.transitionIn, index),
    transitionDuration: 0,
    font: normaliseFont(raw.font),
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
      scene.type = 'color'
    } else {
      scene.text = title
      scene.subtitle = subtitle
    }
  } else if (scene.type === 'image') {
    if (typeof raw.src !== 'string' || raw.src.trim().length === 0) {
      throw new Error(`RenderPlan.scenes[${index}].src 是图片场景的必填项`)
    }
    scene.src = raw.src.trim()
    const motion = String(raw.motion ?? '').trim().toLowerCase()
    scene.motion = MOTIONS.has(motion) ? motion : 'none'
    const fit = String(raw.fit ?? '').trim().toLowerCase()
    scene.fit = FITS.has(fit) ? fit : 'cover'
  } else if (scene.type === 'gradient') {
    const colors = (Array.isArray(raw.gradient) ? raw.gradient : []).map(parseHexColor).filter((color) => color !== null)
    if (colors.length < 2) {
      const base = hexToRgb(scene.background)
      scene.gradient = [scene.background, rgbToHex(blendRgb(base, [255, 255, 255], 0.22))]
    } else {
      scene.gradient = colors
    }
    const angle = numberOrNaN(raw.angle)
    scene.angle = Number.isFinite(angle) ? angle : 45
  } else if (scene.type === 'video') {
    if (typeof raw.src !== 'string' || raw.src.trim().length === 0) {
      throw new Error(`RenderPlan.scenes[${index}].src 是视频场景的必填项`)
    }
    scene.src = raw.src.trim()
    const fit = String(raw.fit ?? '').trim().toLowerCase()
    scene.fit = FITS.has(fit) ? fit : 'cover'
    scene.muted = raw.muted === undefined || raw.muted === null ? true : raw.muted !== false
    const rate = numberOrNaN(raw.rate)
    scene.rate = Number.isFinite(rate) && rate > 0 ? round2(clamp(rate, 0.1, 10)) : 1
    const hold = numberOrNaN(raw.hold)
    if (Number.isFinite(hold) && hold > 0 && hold < scene.duration) scene.hold = round2(hold)
  }
  return scene
}

/** Clamp transition durations so a short scene cannot be swallowed (same as build.js). */
function clampTransitions(scenes) {
  for (let index = 1; index < scenes.length; index += 1) {
    const scene = scenes[index]
    if (scene.transitionDuration <= 0) continue
    const maxAllowed = 0.9 * Math.min(scene.duration, scenes[index - 1].duration)
    if (scene.transitionDuration > maxAllowed) {
      scene.transitionDuration = round3(Math.max(0.05, maxAllowed))
    }
  }
}

/** start/end of every scene in the assembled (xfade-overlapped) timeline. */
function computeSceneWindows(scenes) {
  const windows = []
  let end = 0
  for (let index = 0; index < scenes.length; index += 1) {
    end += scenes[index].duration
    if (index > 0) end -= scenes[index].transitionDuration
    windows.push({ start: round3(Math.max(0, end - scenes[index].duration)), end: round3(end) })
  }
  return windows
}

function normaliseCaptions(rawCaptions, total) {
  if (!Array.isArray(rawCaptions)) return []
  const captions = []
  for (const raw of rawCaptions) {
    if (!isPlainObject(raw)) continue
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (text.length === 0) continue
    const startRaw = numberOrNaN(raw.start ?? 0)
    const endRaw = numberOrNaN(raw.end)
    const start = Number.isFinite(startRaw) ? Math.max(0, startRaw) : 0
    if (!Number.isFinite(endRaw)) continue
    const end = Math.min(endRaw, total)
    if (end - start < 0.2 || end <= 0 || start >= total) continue
    captions.push({
      start: round3(start),
      end: round3(end),
      text,
      position: CAPTION_POSITIONS.has(String(raw.position ?? '').trim()) ? String(raw.position).trim() : 'bottom',
      fontSize: Number.isFinite(numberOrNaN(raw.fontSize)) && numberOrNaN(raw.fontSize) > 0
        ? clamp(numberOrNaN(raw.fontSize), 8, 400)
        : 44,
      color: parseHexColor(raw.color) ?? '#ffffff',
    })
  }
  return captions
}

function normaliseOverlays(rawOverlays, plan) {
  if (!Array.isArray(rawOverlays)) return []
  const overlays = []
  for (let index = 0; index < rawOverlays.length; index += 1) {
    const raw = rawOverlays[index]
    if (!isPlainObject(raw)) continue
    const src = typeof raw.src === 'string' ? raw.src.trim() : ''
    if (src.length === 0) continue
    const startRaw = numberOrNaN(raw.start)
    const endRaw = numberOrNaN(raw.end)
    const start = Number.isFinite(startRaw) && startRaw >= 0 ? round3(startRaw) : 0
    const end = Number.isFinite(endRaw) && endRaw > start ? round3(Math.min(endRaw, plan.total)) : plan.total
    if (!(end > start)) continue
    const widthRaw = numberOrNaN(raw.width)
    const width = Number.isFinite(widthRaw) && widthRaw > 0 && widthRaw <= 1 ? round3(widthRaw) : 0.28
    const opacityRaw = numberOrNaN(raw.opacity)
    overlays.push({
      index,
      isStill: IMAGE_EXTENSIONS.has(extensionOf(src)),
      src,
      start,
      end,
      width,
      position: OVERLAY_POSITIONS.has(String(raw.position)) ? String(raw.position) : 'bottom-right',
      opacity: Number.isFinite(opacityRaw) ? round3(clamp(opacityRaw, 0, 1)) : 1,
      fadeIn: Math.max(0, Math.min(2, Number.isFinite(numberOrNaN(raw.fadeIn)) ? numberOrNaN(raw.fadeIn) : 0)),
      fadeOut: Math.max(0, Math.min(2, Number.isFinite(numberOrNaN(raw.fadeOut)) ? numberOrNaN(raw.fadeOut) : 0)),
    })
  }
  return overlays
}

function normaliseAudio(rawAudio) {
  const audio = {
    music: null,
    musicStart: 0,
    musicVolumeDb: -20,
    musicFadeOut: 2,
    duck: true,
    duckDb: -9,
    voiceover: [],
  }
  if (!isPlainObject(rawAudio)) return audio
  audio.music = typeof rawAudio.music === 'string' && rawAudio.music.trim().length > 0 ? rawAudio.music.trim() : null
  const musicStart = numberOrNaN(rawAudio.musicStart)
  audio.musicStart = Number.isFinite(musicStart) ? Math.max(0, musicStart) : 0
  const musicVolumeDb = numberOrNaN(rawAudio.musicVolumeDb)
  audio.musicVolumeDb = Number.isFinite(musicVolumeDb) ? clamp(musicVolumeDb, -60, 12) : -20
  const musicFadeOut = numberOrNaN(rawAudio.musicFadeOut)
  audio.musicFadeOut = Number.isFinite(musicFadeOut) ? clamp(musicFadeOut, 0, 60) : 2
  audio.duck = rawAudio.duck !== false
  const duckDb = numberOrNaN(rawAudio.duckDb)
  audio.duckDb = Number.isFinite(duckDb) ? clamp(duckDb, -30, 0) : -9

  if (Array.isArray(rawAudio.voiceover)) {
    for (const raw of rawAudio.voiceover) {
      if (!isPlainObject(raw)) continue
      const src = typeof raw.src === 'string' && raw.src.trim().length > 0 ? raw.src.trim() : null
      const text = typeof raw.text === 'string' ? raw.text.trim() : ''
      if (src === null && text.length === 0) continue
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
  }

  if (Array.isArray(rawAudio.sfx)) {
    const sfx = []
    for (const raw of rawAudio.sfx) {
      if (!isPlainObject(raw)) continue
      const entry = { ...raw }
      const startRaw = numberOrNaN(raw.start ?? 0)
      entry.start = Number.isFinite(startRaw) ? Math.max(0, round3(startRaw)) : 0
      const volumeDbRaw = numberOrNaN(raw.volumeDb ?? 0)
      entry.volumeDb = Number.isFinite(volumeDbRaw) ? clamp(volumeDbRaw, -40, 12) : 0
      const durationRaw = numberOrNaN(raw.duration)
      entry.duration = Number.isFinite(durationRaw) && durationRaw > 0 ? round3(durationRaw) : null
      sfx.push(entry)
    }
    if (sfx.length > 0) audio.sfx = sfx
  }
  return audio
}

// ---------------------------------------------------------------------------
// markers / beat grid
// ---------------------------------------------------------------------------

function sceneMarkerLabel(clip, index) {
  const typeZh = SCENE_TYPE_ZH[clip.type] ?? clip.type ?? '场景'
  const snippet = typeof clip.text === 'string' && clip.text.trim().length > 0
    ? `「${clip.text.split(/\r?\n/u)[0].slice(0, 12)}」`
    : ''
  return `场景 ${index + 1} · ${typeZh}${snippet}`
}

function captionMarkerLabel(clip, index) {
  return `字幕 ${index + 1}「${String(clip.text ?? '').slice(0, 10)}」`
}

function compareMarkers(a, b) {
  if (a.timeSeconds !== b.timeSeconds) return a.timeSeconds - b.timeSeconds
  if (a.label === b.label) return 0
  return a.label < b.label ? -1 : 1
}

/** Build markers from tracks plus caller-supplied extra markers. beatGrid optional. */
function buildMarkers({ scenes, captions, overlays, music, voiceover, sfx }, opts, total) {
  const markers = []
  scenes.forEach((clip, index) => markers.push({ timeSeconds: round3(clip.start), label: sceneMarkerLabel(clip, index) }))
  captions.forEach((clip, index) => markers.push({ timeSeconds: round3(clip.start), label: captionMarkerLabel(clip, index) }))
  overlays.forEach((clip) => markers.push({ timeSeconds: round3(clip.start), label: `叠加层 · ${basenameOf(clip.src)}` }))
  if (music !== null) markers.push({ timeSeconds: 0, label: '背景音乐起点' })
  voiceover.forEach((clip, index) => markers.push({ timeSeconds: round3(clip.start), label: `旁白 ${index + 1}` }))
  sfx.forEach((clip, index) => markers.push({ timeSeconds: round3(clip.start), label: `音效 ${index + 1} · ${clip.kind ?? 'sfx'}` }))

  if (Array.isArray(opts.markers)) {
    for (const raw of opts.markers) {
      if (!isPlainObject(raw)) continue
      const time = numberOrNaN(raw.timeSeconds ?? raw.time)
      if (!Number.isFinite(time)) continue
      markers.push({ timeSeconds: round3(Math.max(0, Math.min(time, total))), label: String(raw.label ?? '标记') })
    }
  }

  const bpm = numberOrNaN(opts.bpm)
  const beatGrid = Number.isFinite(bpm) && bpm > 0 ? buildBeatGrid(bpm, opts, total) : null
  if (beatGrid !== null) {
    for (const marker of markers) {
      const offset = beatGrid.offsetSeconds
      const nearest = Math.round((marker.timeSeconds - offset) / beatGrid.secondsPerBeat)
      const beatTime = offset + nearest * beatGrid.secondsPerBeat
      if (Math.abs(marker.timeSeconds - beatTime) <= 0.06) marker.beat = true
    }
  }
  markers.sort(compareMarkers)
  return { markers, beatGrid }
}

function buildBeatGrid(bpm, opts, total) {
  const secondsPerBeat = 60 / bpm
  const offsetRaw = numberOrNaN(opts.beatOffsetSeconds)
  const offsetSeconds = Number.isFinite(offsetRaw) ? Math.max(0, round3(offsetRaw)) : 0
  const beatsPerBarRaw = numberOrNaN(opts.beatsPerBar)
  const beatsPerBar = Number.isFinite(beatsPerBarRaw) && beatsPerBarRaw >= 1 ? Math.round(beatsPerBarRaw) : 4
  const count = total > offsetSeconds
    ? Math.floor((total - offsetSeconds) / secondsPerBeat + 1e-9) + 1
    : 0
  return {
    bpm: round3(bpm),
    secondsPerBeat: Math.round(secondsPerBeat * 1e6) / 1e6,
    offsetSeconds,
    beatsPerBar,
    secondsPerBar: Math.round(secondsPerBeat * beatsPerBar * 1e6) / 1e6,
    count,
  }
}

// ---------------------------------------------------------------------------
// planToTimeline
// ---------------------------------------------------------------------------

/**
 * Flatten a RenderPlan into the editable timeline representation.
 *
 * @param {object} plan RenderPlan (lib/build.js contract)
 * @param {{output?: string, bpm?: number, beatsPerBar?: number, beatOffsetSeconds?: number,
 *          markers?: Array<{timeSeconds?: number, time?: number, label?: string}>}} [opts]
 * @returns {object} timeline JSON
 */
export function planToTimeline(plan, opts = {}) {
  if (!isPlainObject(plan)) throw new Error('planToTimeline 需要一个 RenderPlan 对象')
  const options = isPlainObject(opts) ? opts : {}
  const output = typeof options.output === 'string' && options.output.trim().length > 0
    ? options.output.trim()
    : typeof plan.output === 'string' && plan.output.trim().length > 0
      ? plan.output.trim()
      : null
  if (output === null) throw new Error('planToTimeline: RenderPlan.output 缺失（可用 opts.output 指定）')

  let width = Number.isFinite(numberOrNaN(plan.width)) ? Math.round(numberOrNaN(plan.width)) : DEFAULT_WIDTH
  let height = Number.isFinite(numberOrNaN(plan.height)) ? Math.round(numberOrNaN(plan.height)) : DEFAULT_HEIGHT
  let fps = Number.isFinite(numberOrNaN(plan.fps)) ? Math.round(numberOrNaN(plan.fps)) : DEFAULT_FPS
  width = clamp(width, 16, MAX_DIMENSION)
  height = clamp(height, 16, MAX_DIMENSION)
  fps = clamp(fps, 1, MAX_FPS)
  if (width % 2 !== 0) width -= 1
  if (height % 2 !== 0) height -= 1

  const background = parseHexColor(plan.background) ?? DEFAULT_BACKGROUND
  const loudnessTarget = plan.loudnessTarget === null
    ? null
    : Number.isFinite(numberOrNaN(plan.loudnessTarget))
      ? clamp(numberOrNaN(plan.loudnessTarget), -40, 0)
      : DEFAULT_LOUDNESS_TARGET

  if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
    throw new Error('RenderPlan.scenes 必须是非空数组')
  }
  const scenes = plan.scenes.map((scene, index) => normaliseScene(scene, index, { background }))
  clampTransitions(scenes)
  const windows = computeSceneWindows(scenes)
  const total = windows.length > 0 ? windows[windows.length - 1].end : 0
  const captionsPlan = normaliseCaptions(plan.captions, total)
  const overlaysPlan = normaliseOverlays(plan.overlays, { total, width, height, fps })
  const audio = normaliseAudio(plan.audio)

  const tracks = []

  tracks.push({
    id: 'scenes',
    kind: 'video',
    labelZh: TRACK_LABEL_ZH.scenes,
    clips: scenes.map((scene, index) => ({
      id: `scene-${index}`,
      start: windows[index].start,
      end: windows[index].end,
      duration: scene.duration,
      ...scene,
    })),
  })

  if (captionsPlan.length > 0) {
    tracks.push({
      id: 'captions',
      kind: 'text',
      labelZh: TRACK_LABEL_ZH.captions,
      clips: captionsPlan.map((caption, index) => ({
        id: `caption-${index}`,
        start: caption.start,
        end: caption.end,
        duration: round3(caption.end - caption.start),
        text: caption.text,
        position: caption.position,
        fontSize: caption.fontSize,
        color: caption.color,
      })),
    })
  }

  const stillOverlays = overlaysPlan.filter((overlay) => overlay.isStill)
  const clipOverlays = overlaysPlan.filter((overlay) => !overlay.isStill)
  const overlayClip = (overlay) => ({
    id: `overlay-${overlay.index}`,
    order: overlay.index,
    start: overlay.start,
    end: overlay.end,
    duration: round3(overlay.end - overlay.start),
    src: overlay.src,
    width: overlay.width,
    position: overlay.position,
    opacity: overlay.opacity,
    fadeIn: overlay.fadeIn,
    fadeOut: overlay.fadeOut,
  })
  if (stillOverlays.length > 0) {
    tracks.push({
      id: 'overlays-image',
      kind: 'image',
      labelZh: TRACK_LABEL_ZH['overlays-image'],
      clips: stillOverlays.map(overlayClip),
    })
  }
  if (clipOverlays.length > 0) {
    tracks.push({
      id: 'overlays-video',
      kind: 'video',
      labelZh: TRACK_LABEL_ZH['overlays-video'],
      clips: clipOverlays.map(overlayClip),
    })
  }

  if (audio.music !== null) {
    tracks.push({
      id: 'music',
      kind: 'audio',
      labelZh: TRACK_LABEL_ZH.music,
      duck: audio.duck,
      duckDb: audio.duckDb,
      clips: [{
        id: 'music-0',
        src: audio.music,
        start: 0,
        end: total,
        duration: total,
        inPoint: audio.musicStart,
        volumeDb: audio.musicVolumeDb,
        fadeOut: audio.musicFadeOut,
      }],
    })
  }

  if (audio.voiceover.length > 0) {
    tracks.push({
      id: 'voiceover',
      kind: 'audio',
      labelZh: TRACK_LABEL_ZH.voiceover,
      clips: audio.voiceover.map((voice, index) => ({
        id: `voice-${index}`,
        start: voice.start,
        end: null,
        duration: null,
        src: voice.src,
        text: voice.text,
        volumeDb: voice.volumeDb,
        voice: voice.voice,
        rate: voice.rate,
      })),
    })
  }

  if (Array.isArray(audio.sfx) && audio.sfx.length > 0) {
    tracks.push({
      id: 'sfx',
      kind: 'sfx',
      labelZh: TRACK_LABEL_ZH.sfx,
      clips: audio.sfx.map((sfx, index) => ({ id: `sfx-${index}`, ...sfx })),
    })
  }

  // Validate the track kinds once: a typo here would break every downstream tool.
  for (const track of tracks) {
    if (!TIMELINE_TRACK_KINDS.includes(track.kind)) {
      throw new Error(`internal error: unknown track kind "${track.kind}"`)
    }
  }

  const { markers, beatGrid } = buildMarkers({
    scenes: tracks[0].clips,
    captions: captionsPlan.map((caption, index) => ({ start: caption.start, text: caption.text, index })),
    overlays: overlaysPlan,
    music: audio.music,
    voiceover: audio.voiceover,
    sfx: Array.isArray(audio.sfx) ? audio.sfx : [],
  }, options, total)

  const timeline = {
    version: TIMELINE_VERSION,
    width,
    height,
    fps,
    duration: round3(total),
    output,
    background,
    loudnessTarget,
    tracks,
    markers,
  }
  if (beatGrid !== null) timeline.beatGrid = beatGrid
  return timeline
}

// ---------------------------------------------------------------------------
// timelineToPlan
// ---------------------------------------------------------------------------

function requireTimeline(timeline) {
  if (!isPlainObject(timeline)) throw new Error('timelineToPlan 需要 timeline 对象')
  if (timeline.version !== TIMELINE_VERSION) {
    throw new Error(`不支持的时间线版本 "${String(timeline.version)}"（期望 ${TIMELINE_VERSION}）`)
  }
  if (!Array.isArray(timeline.tracks) || timeline.tracks.length === 0) {
    throw new Error('timelineToPlan: 时间线缺少 tracks')
  }
}

function findTrack(timeline, id) {
  return timeline.tracks.find((track) => isPlainObject(track) && track.id === id) ?? null
}

/** Scene clip -> RenderPlan scene (structural clip fields dropped). */
function sceneFromClip(clip, index) {
  if (!isPlainObject(clip)) throw new Error(`timelineToPlan: scenes 轨道第 ${index + 1} 个片段无效`)
  const { id, start, end, ...scene } = clip
  void id
  void start
  void end
  const duration = numberOrNaN(scene.duration)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`timelineToPlan: 场景 ${index + 1} 的时长无效`)
  }
  const output = { ...scene, duration: round3(duration) }
  if (typeof output.transitionIn !== 'string' || output.transitionIn.length === 0) output.transitionIn = 'cut'
  if (output.transitionIn === 'cut' || output.transitionDuration === 0) delete output.transitionDuration
  return output
}

function overlayFromClip(clip) {
  const end = clip.duration === null || clip.duration === undefined
    ? clip.end
    : round3(clip.start + clip.duration)
  return {
    src: clip.src,
    start: round3(clip.start),
    end: round3(end),
    width: clip.width,
    position: clip.position,
    opacity: clip.opacity,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
  }
}

function captionFromClip(clip) {
  return {
    start: round3(clip.start),
    end: round3(clip.start + (Number.isFinite(clip.duration) ? clip.duration : 0)),
    text: clip.text,
    position: clip.position,
    fontSize: clip.fontSize,
    color: clip.color,
  }
}

/**
 * Rebuild a RenderPlan from a (possibly user-edited) timeline.
 *
 * The returned plan is a normalised RenderPlan: defaults are explicit and the
 * first scene is always a cut, so lib/build.js renders it directly.
 *
 * @param {object} timeline timeline JSON
 * @returns {object} RenderPlan
 */
export function timelineToPlan(timeline) {
  requireTimeline(timeline)
  const output = typeof timeline.output === 'string' && timeline.output.trim().length > 0
    ? timeline.output.trim()
    : null
  if (output === null) throw new Error('timelineToPlan: timeline.output 缺失，无法确定成片路径')

  const width = Number.isFinite(numberOrNaN(timeline.width)) ? Math.round(numberOrNaN(timeline.width)) : DEFAULT_WIDTH
  const height = Number.isFinite(numberOrNaN(timeline.height)) ? Math.round(numberOrNaN(timeline.height)) : DEFAULT_HEIGHT
  const fps = Number.isFinite(numberOrNaN(timeline.fps)) ? Math.round(numberOrNaN(timeline.fps)) : DEFAULT_FPS
  const background = parseHexColor(timeline.background) ?? DEFAULT_BACKGROUND
  const loudnessTarget = timeline.loudnessTarget === null
    ? null
    : Number.isFinite(numberOrNaN(timeline.loudnessTarget))
      ? clamp(numberOrNaN(timeline.loudnessTarget), -40, 0)
      : DEFAULT_LOUDNESS_TARGET

  const scenesTrack = findTrack(timeline, 'scenes')
  if (scenesTrack === null || !Array.isArray(scenesTrack.clips) || scenesTrack.clips.length === 0) {
    throw new Error('timelineToPlan: 缺少 scenes 轨道或其中没有场景片段')
  }
  const scenes = scenesTrack.clips.map((clip, index) => sceneFromClip(clip, index))

  const captionsTrack = findTrack(timeline, 'captions')
  const captions = captionsTrack !== null && Array.isArray(captionsTrack.clips)
    ? captionsTrack.clips.map(captionFromClip)
    : []

  const overlayClips = timeline.tracks
    .filter((track) => isPlainObject(track) && typeof track.id === 'string' && track.id.startsWith('overlays'))
    .flatMap((track) => (Array.isArray(track.clips) ? track.clips : []))
    .sort((a, b) => (numberOrNaN(a.order) || 0) - (numberOrNaN(b.order) || 0))
  const overlays = overlayClips.map(overlayFromClip)

  const musicTrack = findTrack(timeline, 'music')
  const musicClip = musicTrack !== null && Array.isArray(musicTrack.clips) && isPlainObject(musicTrack.clips[0])
    ? musicTrack.clips[0]
    : null
  const voiceTrack = findTrack(timeline, 'voiceover')
  const voiceClips = voiceTrack !== null && Array.isArray(voiceTrack.clips) ? voiceTrack.clips : []
  const audio = {
    music: musicClip !== null && typeof musicClip.src === 'string' ? musicClip.src : null,
    musicStart: musicClip !== null && Number.isFinite(numberOrNaN(musicClip.inPoint)) ? Math.max(0, numberOrNaN(musicClip.inPoint)) : 0,
    musicVolumeDb: musicClip !== null && Number.isFinite(numberOrNaN(musicClip.volumeDb)) ? numberOrNaN(musicClip.volumeDb) : -20,
    musicFadeOut: musicClip !== null && Number.isFinite(numberOrNaN(musicClip.fadeOut)) ? numberOrNaN(musicClip.fadeOut) : 2,
    duck: musicTrack !== null ? musicTrack.duck !== false : true,
    duckDb: musicTrack !== null && Number.isFinite(numberOrNaN(musicTrack.duckDb)) ? numberOrNaN(musicTrack.duckDb) : -9,
    voiceover: voiceClips.map((clip) => ({
      src: typeof clip.src === 'string' && clip.src.length > 0 ? clip.src : null,
      text: typeof clip.text === 'string' ? clip.text : '',
      start: Number.isFinite(numberOrNaN(clip.start)) ? Math.max(0, numberOrNaN(clip.start)) : 0,
      volumeDb: Number.isFinite(numberOrNaN(clip.volumeDb)) ? numberOrNaN(clip.volumeDb) : 0,
      voice: typeof clip.voice === 'string' && clip.voice.length > 0 ? clip.voice : 'zh',
      rate: Number.isFinite(numberOrNaN(clip.rate)) ? numberOrNaN(clip.rate) : 1,
    })),
  }
  const sfxTrack = findTrack(timeline, 'sfx')
  if (sfxTrack !== null && Array.isArray(sfxTrack.clips) && sfxTrack.clips.length > 0) {
    audio.sfx = sfxTrack.clips.map((clip) => {
      const { id, ...rest } = clip
      void id
      return rest
    })
  }

  return {
    output,
    width,
    height,
    fps,
    background,
    loudnessTarget,
    scenes,
    overlays,
    captions,
    audio,
  }
}

/**
 * Recompute the assembled duration from the scene track (editors call this after
 * changing a scene duration; it is the same arithmetic as lib/build.js).
 *
 * @param {object} timeline
 * @returns {number} seconds
 */
export function timelineDuration(timeline) {
  if (!isPlainObject(timeline)) throw new Error('timelineDuration 需要 timeline 对象')
  const scenesTrack = findTrack(timeline, 'scenes')
  if (scenesTrack === null || !Array.isArray(scenesTrack.clips)) return 0
  let end = 0
  scenesTrack.clips.forEach((clip, index) => {
    const duration = numberOrNaN(clip.duration)
    if (!Number.isFinite(duration) || duration <= 0) return
    const transition = index > 0 && clip.transitionIn !== 'cut' && Number.isFinite(numberOrNaN(clip.transitionDuration))
      ? Math.max(0, numberOrNaN(clip.transitionDuration))
      : 0
    end += duration - transition
  })
  return round3(Math.max(0, end))
}

// ---------------------------------------------------------------------------
// diffTimeline
// ---------------------------------------------------------------------------

const FIELD_LABELS_ZH = Object.freeze({
  type: '类型',
  duration: '时长',
  start: '起始',
  text: '文案',
  subtitle: '副标题',
  src: '素材',
  motion: '运镜',
  fit: '适配',
  rate: '倍速',
  hold: '定格',
  muted: '静音',
  font: '字体',
  fontSize: '字号',
  color: '颜色',
  background: '背景色',
  align: '对齐',
  animation: '动画',
  transitionIn: '转场',
  transitionDuration: '转场时长',
  gradient: '渐变配色',
  angle: '角度',
  position: '位置',
  width: '宽度',
  opacity: '不透明度',
  fadeIn: '淡入',
  fadeOut: '淡出',
  inPoint: '素材起点',
  volumeDb: '音量',
  voice: '声部',
  kind: '音效类型',
  duck: '自动闪避',
  duckDb: '闪避深度',
})

const META_LABELS_ZH = Object.freeze({
  width: '画幅宽度',
  height: '画幅高度',
  fps: '帧率',
  duration: '总时长',
  background: '背景色',
  loudnessTarget: '响度目标',
  output: '输出路径',
})

const TRACK_FIELD_LABELS_ZH = Object.freeze({
  kind: '轨道类型',
  labelZh: '轨道名',
  duck: '自动闪避',
  duckDb: '闪避深度',
})

/** Fields that are structural (derived) and therefore never diffed as content. */
const STRUCTURAL_CLIP_FIELDS = new Set(['id', 'order', 'end'])

function formatSeconds(value) {
  return `${round2(value).toFixed(2)}s`
}

function formatValue(field, value, mode = 'clip') {
  if (value === null || value === undefined) return '无'
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (mode === 'meta' && (field === 'width' || field === 'height')) return `${Math.round(value)}px`
    switch (field) {
      case 'duration':
      case 'start':
      case 'end':
      case 'transitionDuration':
      case 'fadeIn':
      case 'fadeOut':
      case 'inPoint':
      case 'hold':
        return formatSeconds(value)
      case 'volumeDb':
      case 'duckDb':
        return `${round2(value)}dB`
      case 'fontSize':
        return `${Math.round(value)}px`
      case 'width':
        return `${Math.round(value * 100)}%`
      case 'opacity':
        return `${Math.round(value * 100)}%`
      case 'angle':
        return `${round2(value)}°`
      case 'rate':
        return `${round2(value)}x`
      case 'fps':
        return `${value}fps`
      case 'loudnessTarget':
        return `${round2(value)} LUFS`
      default:
        return String(round3(value))
    }
  }
  return String(value)
}

function formatTextValue(value) {
  const text = String(value ?? '')
  const single = text.replace(/\s+/gu, ' ').trim()
  if (single.length > 24) return `「${single.slice(0, 24)}…」`
  return `「${single}」`
}

function formatChange(field, before, after, mode = 'clip') {
  if (field === 'text' || field === 'subtitle' || field === 'src' || field === 'output') {
    return `${formatTextValue(before)} → ${formatTextValue(after)}`
  }
  // `width` means a percentage on an overlay clip and a pixel count on the
  // timeline itself, so the meta diff must not reuse the clip interpretation —
  // that bug printed a 1280px canvas as "128000%".
  return `${formatValue(field, before, mode)} → ${formatValue(field, after, mode)}`
}

function clipDisplayLabel(track, clip, index) {
  if (track.id === 'scenes') {
    const snippet = typeof clip.text === 'string' && clip.text.trim().length > 0
      ? `「${clip.text.split(/\r?\n/u)[0].slice(0, 10)}」`
      : typeof clip.src === 'string' && clip.src.length > 0
        ? `「${basenameOf(clip.src)}」`
        : ''
    return `场景 ${index + 1} · ${SCENE_TYPE_ZH[clip.type] ?? clip.type ?? '场景'}${snippet}`
  }
  if (track.id === 'captions') return `字幕 ${index + 1}`
  if (track.id === 'overlays-image' || track.id === 'overlays-video') {
    return `${track.labelZh ?? '叠加'} ${(numberOrNaN(clip.order) || index) + 1}「${basenameOf(clip.src)}」`
  }
  if (track.id === 'voiceover') return `旁白 ${index + 1}`
  if (track.id === 'music') return '背景音乐'
  if (track.id === 'sfx') return `音效 ${index + 1}`
  return `${track.labelZh ?? track.id} ${index + 1}`
}

function trackDisplayLabel(track) {
  return `${track.labelZh ?? track.id}（${track.id}）`
}

/**
 * Human-readable Chinese diff between two timelines.
 *
 * One entry per change: `{trackId, clipId, changeZh}`. Track- and plan-level
 * changes use `trackId`/`clipId` null. Ordering is deterministic (plan meta,
 * track add/remove/field changes, then clips in track order), so the same pair of
 * timelines always yields the same list — suitable for reports and tests.
 *
 * @param {object} a before timeline
 * @param {object} b after timeline
 * @returns {Array<{trackId: string|null, clipId: string|null, changeZh: string}>}
 */
export function diffTimeline(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) throw new Error('diffTimeline 需要两个 timeline 对象')
  const changes = []
  const push = (trackId, clipId, changeZh) => changes.push({ trackId, clipId, changeZh })

  for (const field of Object.keys(META_LABELS_ZH)) {
    const before = a[field]
    const after = b[field]
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    push(null, null, `时间线${META_LABELS_ZH[field]}：${formatChange(field, before, after, 'meta')}`)
  }

  const aTracks = Array.isArray(a.tracks) ? a.tracks : []
  const bTracks = Array.isArray(b.tracks) ? b.tracks : []
  const aById = new Map()
  for (const track of aTracks) if (isPlainObject(track) && typeof track.id === 'string') aById.set(track.id, track)
  const bById = new Map()
  for (const track of bTracks) if (isPlainObject(track) && typeof track.id === 'string') bById.set(track.id, track)

  for (const track of aTracks) {
    if (!isPlainObject(track)) continue
    if (!bById.has(track.id)) {
      push(track.id, null, `删除轨道「${trackDisplayLabel(track)}」`)
    }
  }
  const orderedTrackIds = [
    ...aTracks.map((track) => (isPlainObject(track) ? track.id : undefined)).filter((id) => typeof id === 'string'),
    ...bTracks.map((track) => (isPlainObject(track) ? track.id : undefined)).filter((id) => typeof id === 'string' && !aById.has(id)),
  ]
  const seenTracks = new Set()
  for (const trackId of orderedTrackIds) {
    if (seenTracks.has(trackId)) continue
    seenTracks.add(trackId)
    const beforeTrack = aById.get(trackId)
    const afterTrack = bById.get(trackId)
    if (beforeTrack === undefined) {
      push(trackId, null, `新增轨道「${trackDisplayLabel(afterTrack)}」`)
      continue
    }
    if (afterTrack === undefined) continue // already reported as removed

    for (const field of Object.keys(TRACK_FIELD_LABELS_ZH)) {
      if (JSON.stringify(beforeTrack[field]) === JSON.stringify(afterTrack[field])) continue
      push(trackId, null, `轨道「${trackDisplayLabel(afterTrack)}」${TRACK_FIELD_LABELS_ZH[field]}：${formatValue(field, beforeTrack[field])} → ${formatValue(field, afterTrack[field])}`)
    }

    const beforeClips = Array.isArray(beforeTrack.clips) ? beforeTrack.clips : []
    const afterClips = Array.isArray(afterTrack.clips) ? afterTrack.clips : []
    const beforeClipById = new Map()
    beforeClips.forEach((clip, index) => {
      if (isPlainObject(clip)) beforeClipById.set(clip.id ?? `#${index}`, clip)
    })
    const afterClipById = new Map()
    afterClips.forEach((clip, index) => {
      if (isPlainObject(clip)) afterClipById.set(clip.id ?? `#${index}`, clip)
    })

    beforeClips.forEach((clip, index) => {
      if (!isPlainObject(clip)) return
      const key = clip.id ?? `#${index}`
      if (afterClipById.has(key)) return
      push(trackId, clip.id ?? null, `删除片段「${clipDisplayLabel(beforeTrack, clip, index)}」`)
    })

    afterClips.forEach((clip, index) => {
      if (!isPlainObject(clip)) return
      const key = clip.id ?? `#${index}`
      const beforeClip = beforeClipById.get(key)
      if (beforeClip === undefined) {
        const durationText = Number.isFinite(clip.duration) ? `，时长 ${formatSeconds(clip.duration)}` : ''
        const startText = Number.isFinite(clip.start) ? `（${formatSeconds(clip.start)} 起${durationText}）` : ''
        // Describe an addition by its own content. The track/index label only says
        // "字幕 2", which hides what was actually inserted, and on an addition the
        // content is the one thing the reader needs.
        const ownText = typeof clip.text === 'string' && clip.text.trim().length > 0
          ? `「${clip.text.trim().split(/\r?\n/u)[0].slice(0, 12)}」`
          : `「${clipDisplayLabel(afterTrack, clip, index)}」`
        push(trackId, clip.id ?? null, `新增片段${ownText}${startText}`)
        return
      }
      const fields = new Set([...Object.keys(beforeClip), ...Object.keys(clip)])
      for (const field of fields) {
        if (STRUCTURAL_CLIP_FIELDS.has(field)) continue
        // On the scenes track, start/end are derived from durations + transitions;
        // reporting them would bury the real edit under ripple noise.
        if (trackId === 'scenes' && field === 'start') continue
        const oldValue = beforeClip[field]
        const newValue = clip[field]
        if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue
        const label = FIELD_LABELS_ZH[field] ?? field
        push(trackId, clip.id ?? null, `片段「${clipDisplayLabel(afterTrack, clip, index)}」${label}：${formatChange(field, oldValue, newValue)}`)
      }
    })
  }
  return changes
}

// ---------------------------------------------------------------------------
// renderTimelineHtml — offline editor
// ---------------------------------------------------------------------------

/** JSON that is safe inside <script type="application/json"> (escapes '<'). */
function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Render a single self-contained HTML file that edits the timeline offline.
 *
 * The page embeds the timeline JSON, draws one row per track, and lets the user
 * click a clip to edit its text / start / duration / volume. Scene duration
 * edits ripple the later scenes (because the renderer re-derives the xfade
 * timeline), and dragging a clip's right edge resizes it. "导出 RenderPlan JSON"
 * produces a plan that can be handed straight back to `media_build_video`.
 *
 * No network is used: no external scripts, styles, fonts, images or URLs. The
 * background note in the page header says so explicitly, because "offline, open
 * the file directly" is part of the delivery promise.
 *
 * @param {object} timeline timeline JSON (planToTimeline output or an edited one)
 * @param {{title?: string, noteZh?: string, filename?: string}} [opts]
 * @returns {string} HTML document
 */
export function renderTimelineHtml(timeline, opts = {}) {
  if (!isPlainObject(timeline) || !Array.isArray(timeline.tracks)) {
    throw new Error('renderTimelineHtml 需要一个 timeline 对象（先用 planToTimeline 生成）')
  }
  const options = isPlainObject(opts) ? opts : {}
  const title = typeof options.title === 'string' && options.title.trim().length > 0 ? options.title.trim() : '可编辑时间线'
  const noteZh = typeof options.noteZh === 'string' && options.noteZh.trim().length > 0
    ? options.noteZh.trim()
    : '离线可编辑：改文案 / 拖时长 / 调音量后，点「导出 RenderPlan JSON」，把 JSON 交给 media_build_video 重新渲染。'
  const filename = typeof options.filename === 'string' && options.filename.trim().length > 0 ? options.filename.trim() : 'timeline'
  const embedded = safeJsonForScript(timeline)
  const metaLine = `${timeline.width ?? '?'}×${timeline.height ?? '?'} @ ${timeline.fps ?? '?'} fps · 时长 ${round2(Number(timeline.duration) || 0).toFixed(2)}s · ${Array.isArray(timeline.tracks) ? timeline.tracks.length : 0} 条轨道`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #0f1117;
    --panel: #171a23;
    --panel-2: #1e222d;
    --line: #2a3040;
    --text: #e6e9f2;
    --muted: #8b93a7;
    --accent: #5ec8ff;
    --accent-2: #b48cff;
    --warn: #ffcf6e;
    --ok: #7ee787;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body { font: 14px/1.55 "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif; padding: 18px 22px 40px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 18px 0 8px; color: var(--muted); font-weight: 600; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 12px; }
  .meta { color: var(--muted); font-size: 12px; margin: 2px 0 0; }
  .note { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  button {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 6px; padding: 7px 12px; cursor: pointer; font-size: 13px;
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: #123048; border-color: #1d5c86; color: #cdeaff; }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 16px; margin-top: 16px; align-items: start; }
  @media (max-width: 980px) { main { grid-template-columns: 1fr; } }
  .timeline { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px 14px; overflow-x: auto; }
  .ruler { position: relative; height: 22px; margin-left: 118px; border-bottom: 1px solid var(--line); }
  .ruler .tick { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--line); font-size: 10px; color: var(--muted); padding: 2px 0 0 3px; }
  .track-row { display: flex; align-items: stretch; min-height: 46px; border-bottom: 1px solid #20242f; }
  .track-label { width: 118px; flex: 0 0 118px; font-size: 12px; color: var(--muted); padding: 8px 8px 0 0; }
  .track-label .kind { display: block; font-size: 10px; color: #5a6379; }
  .lane { position: relative; flex: 1 1 auto; min-height: 44px; }
  .clip {
    position: absolute; top: 6px; height: 32px; border-radius: 5px; border: 1px solid #33506b;
    background: linear-gradient(180deg, #1d3b53, #17293a); color: #d6ecff; font-size: 11px;
    padding: 7px 24px 0 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer;
  }
  .clip.kind-text { background: linear-gradient(180deg, #3d2f56, #2a2140); border-color: #5c4a80; color: #eadcff; }
  .clip.kind-image { background: linear-gradient(180deg, #3a3a22, #2a2a18); border-color: #6a6a3a; color: #f4f0c8; }
  .clip.kind-audio { background: linear-gradient(180deg, #1c4436, #15302a); border-color: #2f6e58; color: #ccf3e4; }
  .clip.kind-sfx { background: linear-gradient(180deg, #4a2a2a, #341d1d); border-color: #7c4444; color: #ffd9d9; }
  .clip.selected { outline: 2px solid var(--accent); outline-offset: 1px; }
  .clip .handle { position: absolute; top: 0; right: 0; width: 12px; height: 100%; cursor: ew-resize; background: rgba(255, 255, 255, 0.08); }
  .clip .handle::after { content: "⋮"; position: absolute; right: 2px; top: 8px; color: #9fb3c8; font-size: 10px; }
  .clip.voice { border-style: dashed; }
  .inspector { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; position: sticky; top: 12px; }
  .inspector .hint { color: var(--muted); font-size: 12px; }
  .inspector .clip-title { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
  .inspector .clip-sub { font-size: 11px; color: var(--muted); margin-bottom: 10px; }
  label.field { display: block; margin: 8px 0; font-size: 12px; color: var(--muted); }
  label.field input, label.field select, label.field textarea {
    display: block; width: 100%; margin-top: 3px; background: #11141c; color: var(--text);
    border: 1px solid var(--line); border-radius: 5px; padding: 5px 7px; font: inherit; font-size: 13px;
  }
  label.field textarea { min-height: 52px; resize: vertical; }
  label.field.inline { display: flex; align-items: center; gap: 8px; }
  label.field.inline input { width: auto; margin: 0; }
  .value-note { color: var(--warn); font-size: 11px; margin-top: 6px; }
  .preview { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin-top: 16px; }
  .preview pre { margin: 0; padding: 10px 14px; max-height: 260px; overflow: auto; font-size: 11px; color: #a9b7d0; }
  .status { color: var(--ok); font-size: 12px; min-height: 18px; margin-top: 8px; }
  .ruler .tick span { pointer-events: none; }
  .track-row:hover .track-label { color: var(--text); }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">${escapeHtml(metaLine)} · 文件 ${escapeHtml(filename)}</p>
  <p class="note">${escapeHtml(noteZh)}</p>
  <div class="toolbar">
    <button id="exportPlan" class="primary">导出 RenderPlan JSON</button>
    <button id="exportTimeline">导出时间线 JSON</button>
    <button id="copyJson">复制当前 JSON</button>
    <button id="resetAll">重置为原始时间线</button>
  </div>
  <div class="status" id="status"></div>
</header>
<main>
  <section class="timeline">
    <div class="ruler" id="ruler"></div>
    <div id="tracks"></div>
  </section>
  <aside class="inspector" id="inspector">
    <p class="hint">点一个片段开始编辑；拖片段右边缘可改时长。</p>
  </aside>
</main>
<section class="preview">
  <h2 style="margin:10px 0 0 14px;">当前时间线 JSON（实时）</h2>
  <pre id="previewJson"></pre>
</section>
<script id="timeline-data" type="application/json">${embedded}</script>
<script>
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('timeline-data').textContent);
  var tl = JSON.parse(JSON.stringify(DATA));
  var selected = null;
  var statusTimer = null;

  var SCENE_ZH = { text: '文字', image: '图片', color: '纯色', gradient: '渐变', video: '视频' };
  var ALIGN_ZH = { center: '居中', left: '左对齐', bottom: '底部' };
  var ANIM_ZH = { none: '无', fade: '淡入', 'slide-up': '上滑' };
  var POSITION_ZH = { bottom: '底部', top: '顶部', center: '居中' };
  var OVERLAY_POSITIONS = ['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'];
  var TRANSITIONS = ['cut', 'fade', 'fadeblack', 'fadewhite', 'slideleft', 'slideright', 'slideup', 'slidedown', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'circleopen', 'circleclose', 'dissolve', 'pixelize', 'radial'];
  var MOTIONS = ['none', 'kenburns-in', 'kenburns-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down', 'tilt-up', 'tilt-down'];

  function $(id) { return document.getElementById(id); }
  function round(n) { return Math.round(Number(n) * 1000) / 1000; }
  function num(v, fallback) { var n = Number(v); return isFinite(n) ? n : fallback; }
  function fmt(t) {
    t = Math.max(0, num(t, 0));
    var m = Math.floor(t / 60);
    var s = t - m * 60;
    return m > 0 ? m + ':' + (s < 10 ? '0' : '') + s.toFixed(1) : s.toFixed(1) + 's';
  }
  function esc(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function findTrack(id) {
    for (var i = 0; i < tl.tracks.length; i++) if (tl.tracks[i].id === id) return tl.tracks[i];
    return null;
  }
  function findClip(trackId, clipId) {
    var track = findTrack(trackId);
    if (!track) return null;
    for (var i = 0; i < track.clips.length; i++) if (track.clips[i].id === clipId) return track.clips[i];
    return null;
  }
  function scenesTrack() { return findTrack('scenes'); }

  function lastPathPart(path) {
    var parts = String(path || '').split(/[\\\\/]/);
    return parts[parts.length - 1] || '';
  }

  function recompute() {
    var track = scenesTrack();
    if (track && track.clips.length > 0) {
      var end = 0;
      for (var i = 0; i < track.clips.length; i++) {
        var clip = track.clips[i];
        var duration = Math.max(0, num(clip.duration, 0));
        var transition = i > 0 && clip.transitionIn !== 'cut' ? Math.max(0, num(clip.transitionDuration, 0)) : 0;
        end += duration - transition;
        clip.start = round(end - duration);
        clip.end = round(end);
      }
      tl.duration = round(end);
    }
    tl.markers = buildMarkers();
  }

  // Marker labels/order are kept byte-identical to lib/timeline.js so an editor
  // round-trip does not rewrite them.
  function buildMarkers() {
    var markers = [];
    function push(time, label) { markers.push({ timeSeconds: round(time), label: label }); }
    for (var t = 0; t < tl.tracks.length; t++) {
      var track = tl.tracks[t];
      for (var i = 0; i < (track.clips || []).length; i++) {
        var clip = track.clips[i];
        if (track.id === 'scenes') {
          var snippet = clip.text ? '「' + String(clip.text).split(/\\r?\\n/)[0].slice(0, 12) + '」' : '';
          push(clip.start, '场景 ' + (i + 1) + ' · ' + (SCENE_ZH[clip.type] || clip.type || '场景') + snippet);
        } else if (track.id === 'captions') {
          push(clip.start, '字幕 ' + (i + 1) + '「' + String(clip.text || '').slice(0, 10) + '」');
        } else if (track.id === 'voiceover') {
          push(clip.start, '旁白 ' + (i + 1));
        } else if (track.id === 'sfx') {
          push(clip.start, '音效 ' + (i + 1) + ' · ' + (clip.kind || 'sfx'));
        } else if (track.id.indexOf('overlays') === 0) {
          push(clip.start, '叠加层 · ' + lastPathPart(clip.src));
        } else if (track.id === 'music') {
          push(0, '背景音乐起点');
        }
      }
    }
    if (tl.beatGrid && num(tl.beatGrid.secondsPerBeat, 0) > 0) {
      for (var m = 0; m < markers.length; m++) {
        var beatGrid = tl.beatGrid;
        var nearest = Math.round((markers[m].timeSeconds - num(beatGrid.offsetSeconds, 0)) / num(beatGrid.secondsPerBeat, 0));
        var beatTime = num(beatGrid.offsetSeconds, 0) + nearest * num(beatGrid.secondsPerBeat, 0);
        if (Math.abs(markers[m].timeSeconds - beatTime) <= 0.06) markers[m].beat = true;
      }
    }
    markers.sort(function (a, b) {
      if (a.timeSeconds !== b.timeSeconds) return a.timeSeconds - b.timeSeconds;
      if (a.label === b.label) return 0;
      return a.label < b.label ? -1 : 1;
    });
    return markers;
  }

  function selectedClip() {
    if (!selected) return null;
    return findClip(selected.trackId, selected.clipId);
  }

  function setStatus(text) {
    var el = $('status');
    if (!el) return;
    el.textContent = text || '';
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { el.textContent = ''; }, 3500);
  }

  function trackClass(track) {
    if (track.id === 'scenes') return 'kind-video';
    return 'kind-' + track.kind;
  }

  function renderMeta() {
    var meta = document.querySelector('.meta');
    if (meta) meta.textContent = tl.width + '×' + tl.height + ' @ ' + tl.fps + 'fps · 时长 ' + num(tl.duration, 0).toFixed(2) + 's · ' + tl.tracks.length + ' 条轨道 · 文件 ' + tl.output;
  }

  function renderRuler() {
    var ruler = $('ruler');
    if (!ruler) return;
    ruler.innerHTML = '';
    var duration = Math.max(0.1, num(tl.duration, 0));
    var step = duration <= 6 ? 0.5 : duration <= 15 ? 1 : duration <= 40 ? 2 : 5;
    for (var t = 0; t <= duration + 1e-9; t += step) {
      var tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = (t / duration * 100) + '%';
      var label = document.createElement('span');
      label.textContent = fmt(t);
      tick.appendChild(label);
      ruler.appendChild(tick);
    }
  }

  function renderTracks() {
    var host = $('tracks');
    if (!host) return;
    host.innerHTML = '';
    var duration = Math.max(0.1, num(tl.duration, 0));
    for (var t = 0; t < tl.tracks.length; t++) {
      var track = tl.tracks[t];
      var row = document.createElement('div');
      row.className = 'track-row';
      var label = document.createElement('div');
      label.className = 'track-label';
      label.innerHTML = esc(track.labelZh || track.id) + '<span class="kind">' + esc(track.kind) + ' · ' + (track.clips || []).length + '</span>';
      row.appendChild(label);
      var lane = document.createElement('div');
      lane.className = 'lane';
      for (var i = 0; i < (track.clips || []).length; i++) {
        var clip = track.clips[i];
        var block = document.createElement('div');
        block.className = 'clip ' + trackClass(track);
        if (selected && selected.trackId === track.id && selected.clipId === clip.id) block.className += ' selected';
        if (track.id === 'voiceover') block.className += ' voice';
        var start = Math.max(0, num(clip.start, 0));
        var widthSeconds = clip.duration === null || clip.duration === undefined ? Math.min(2, duration - start) : Math.max(0.05, num(clip.duration, 0));
        block.style.left = (start / duration * 100) + '%';
        block.style.width = Math.max(1.5, (widthSeconds / duration * 100)) + '%';
        block.setAttribute('data-track', track.id);
        block.setAttribute('data-clip', clip.id);
        block.title = clipDescription(track, clip);
        block.textContent = clipLabel(track, clip, i);
        if (block.textContent.length > 26) block.textContent = block.textContent.slice(0, 25) + '…';
        var handle = document.createElement('div');
        handle.className = 'handle';
        handle.setAttribute('data-track', track.id);
        handle.setAttribute('data-clip', clip.id);
        block.appendChild(handle);
        lane.appendChild(block);
      }
      row.appendChild(lane);
      host.appendChild(row);
    }
  }

  function clipLabel(track, clip, index) {
    if (track.id === 'scenes') return '场景 ' + (index + 1) + ' · ' + (SCENE_ZH[clip.type] || clip.type);
    if (track.id === 'captions') return '字幕 ' + (index + 1) + (clip.text ? '「' + String(clip.text).slice(0, 8) + '」' : '');
    if (track.id === 'music') return '背景音乐' + (clip.src ? ' · ' + String(clip.src).split(/[\\\\/]/).pop() : '');
    if (track.id === 'voiceover') return '旁白 ' + (index + 1) + (clip.text ? '「' + String(clip.text).slice(0, 8) + '」' : '');
    if (track.id === 'sfx') return '音效 ' + (index + 1) + ' · ' + (clip.kind || 'sfx');
    return (track.labelZh || track.id) + ' ' + (index + 1);
  }

  function clipDescription(track, clip) {
    var parts = ['起始 ' + num(clip.start, 0).toFixed(2) + 's'];
    if (clip.duration !== null && clip.duration !== undefined) parts.push('时长 ' + num(clip.duration, 0).toFixed(2) + 's');
    if (clip.volumeDb !== undefined) parts.push('音量 ' + num(clip.volumeDb, 0) + 'dB');
    return parts.join(' · ');
  }

  function selectHtml(field, label, value, options) {
    var html = '<label class="field">' + esc(label) + '<select data-field="' + esc(field) + '" data-kind="select">';
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      var optionValue = typeof option === 'string' ? option : option.value;
      var optionText = typeof option === 'string' ? option : option.text;
      html += '<option value="' + esc(optionValue) + '"' + (String(optionValue) === String(value) ? ' selected' : '') + '>' + esc(optionText) + '</option>';
    }
    return html + '</select></label>';
  }

  function numberHtml(field, label, value, step, min, max) {
    var extra = ' step="' + esc(step || 0.1) + '"';
    if (min !== undefined) extra += ' min="' + esc(min) + '"';
    if (max !== undefined) extra += ' max="' + esc(max) + '"';
    return '<label class="field">' + esc(label) + '<input type="number" data-field="' + esc(field) + '" data-kind="number"' + extra + ' value="' + esc(value) + '"></label>';
  }

  function textHtml(field, label, value, placeholder) {
    return '<label class="field">' + esc(label) + '<input type="text" data-field="' + esc(field) + '" data-kind="text" value="' + esc(value === null || value === undefined ? '' : value) + '" placeholder="' + esc(placeholder || '') + '"></label>';
  }

  function textareaHtml(field, label, value) {
    return '<label class="field">' + esc(label) + '<textarea data-field="' + esc(field) + '" data-kind="text">' + esc(value === null || value === undefined ? '' : value) + '</textarea></label>';
  }

  function colorHtml(field, label, value) {
    return '<label class="field">' + esc(label) + '<input type="color" data-field="' + esc(field) + '" data-kind="text" value="' + esc(value || '#ffffff') + '"></label>';
  }

  function checkboxHtml(field, label, checked) {
    return '<label class="field inline"><input type="checkbox" data-field="' + esc(field) + '" data-kind="boolean"' + (checked ? ' checked' : '') + '> ' + esc(label) + '</label>';
  }

  function renderInspector() {
    var host = $('inspector');
    if (!host) return;
    if (!selected) {
      host.innerHTML = '<p class="hint">点一个片段开始编辑；拖片段右边缘可改时长。</p>';
      return;
    }
    var track = findTrack(selected.trackId);
    var clip = selectedClip();
    if (!track || !clip) {
      selected = null;
      host.innerHTML = '<p class="hint">片段已不存在。</p>';
      return;
    }
    var clipIndex = 0;
    for (var i = 0; i < track.clips.length; i++) {
      if (track.clips[i].id === clip.id) { clipIndex = i; break; }
    }
    var html = '<p class="clip-title">' + esc(clipLabel(track, clip, clipIndex)) + '</p>';
    html += '<p class="clip-sub">轨道「' + esc(track.labelZh || track.id) + '」（' + esc(track.kind) + '）· 片段 ' + esc(clip.id) + '</p>';

    if (track.id === 'scenes') {
      html += numberHtml('duration', '时长（秒，改后后续场景自动顺延）', clip.duration, 0.1, 0.1);
      html += selectHtml('transitionIn', '入场转场', clip.transitionIn || 'cut', TRANSITIONS);
      if (clip.transitionIn && clip.transitionIn !== 'cut') html += numberHtml('transitionDuration', '转场时长（秒）', clip.transitionDuration, 0.1, 0);
      if (clip.type === 'text') {
        html += textareaHtml('text', '标题（\\\\n 可换行）', clip.text);
        html += textareaHtml('subtitle', '副标题', clip.subtitle);
        html += numberHtml('fontSize', '字号（相对 1080 宽）', clip.fontSize, 1, 8, 400);
        html += colorHtml('color', '文字颜色', clip.color);
        html += selectHtml('align', '对齐', clip.align || 'center', Object.keys(ALIGN_ZH).map(function (key) { return { value: key, text: ALIGN_ZH[key] }; }));
        html += selectHtml('animation', '动画', clip.animation || 'none', Object.keys(ANIM_ZH).map(function (key) { return { value: key, text: ANIM_ZH[key] }; }));
        html += colorHtml('background', '背景色', clip.background);
      } else if (clip.type === 'image') {
        html += textHtml('src', '图片路径', clip.src);
        html += selectHtml('motion', '运镜', clip.motion || 'none', MOTIONS.map(function (motion) { return { value: motion, text: motion }; }));
        html += selectHtml('fit', '适配', clip.fit || 'cover', ['cover', 'contain']);
        html += colorHtml('background', '留白背景色', clip.background);
      } else if (clip.type === 'gradient') {
        html += textareaHtml('gradientCsv', '渐变颜色（逗号分隔）', (clip.gradient || []).join(', '));
        html += numberHtml('angle', '角度（度）', clip.angle, 5);
      } else if (clip.type === 'color') {
        html += colorHtml('background', '背景色', clip.background);
      } else if (clip.type === 'video') {
        html += textHtml('src', '视频路径', clip.src);
        html += selectHtml('fit', '适配', clip.fit || 'cover', ['cover', 'contain']);
        html += numberHtml('rate', '倍速（1=原速）', clip.rate, 0.05, 0.1, 10);
        html += numberHtml('hold', '尾部定格（秒）', clip.hold === undefined ? '' : clip.hold, 0.1, 0);
        html += checkboxHtml('muted', '静音（视频场景音轨默认不混入）', clip.muted !== false);
      }
    } else if (track.id === 'captions') {
      html += numberHtml('start', '起始（秒）', clip.start, 0.1, 0);
      html += numberHtml('duration', '时长（秒）', clip.duration, 0.1, 0.2);
      html += textareaHtml('text', '字幕文案', clip.text);
      html += selectHtml('position', '位置', clip.position || 'bottom', Object.keys(POSITION_ZH).map(function (key) { return { value: key, text: POSITION_ZH[key] }; }));
      html += numberHtml('fontSize', '字号（相对 1080 宽）', clip.fontSize, 1, 8, 400);
      html += colorHtml('color', '颜色', clip.color);
    } else if (track.id.indexOf('overlays') === 0) {
      html += textHtml('src', '素材路径', clip.src);
      html += numberHtml('start', '起始（秒）', clip.start, 0.1, 0);
      html += numberHtml('duration', '时长（秒）', clip.duration, 0.1, 0.1);
      html += numberHtml('width', '宽度（占画幅比例）', clip.width, 0.01, 0.02, 1);
      html += selectHtml('position', '位置', clip.position || 'bottom-right', OVERLAY_POSITIONS);
      html += numberHtml('opacity', '不透明度（0-1）', clip.opacity, 0.05, 0, 1);
      html += numberHtml('fadeIn', '淡入（秒）', clip.fadeIn, 0.1, 0, 2);
      html += numberHtml('fadeOut', '淡出（秒）', clip.fadeOut, 0.1, 0, 2);
    } else if (track.id === 'music') {
      html += textHtml('src', '音乐路径', clip.src);
      html += numberHtml('inPoint', '音乐起点（秒）', clip.inPoint, 0.1, 0);
      html += numberHtml('volumeDb', '音量（dB）', clip.volumeDb, 1, -60, 12);
      html += numberHtml('fadeOut', '结尾淡出（秒）', clip.fadeOut, 0.1, 0, 60);
      html += checkboxHtml('__trackDuck', '旁白出现时自动闪避', track.duck !== false);
      html += numberHtml('__trackDuckDb', '闪避深度（dB）', track.duckDb, 1, -30, 0);
    } else if (track.id === 'voiceover') {
      if (clip.src) html += textHtml('src', '旁白音频路径', clip.src);
      else html += textareaHtml('text', '旁白文案（由 TTS 合成）', clip.text);
      html += numberHtml('start', '起始（秒）', clip.start, 0.1, 0);
      html += numberHtml('volumeDb', '音量（dB）', clip.volumeDb, 1, -40, 12);
      html += textHtml('voice', '声部（zh/en/完整 SAPI 名）', clip.voice);
      html += numberHtml('rate', '语速（1=正常）', clip.rate, 0.05, 0.5, 2);
      html += '<p class="value-note">旁白时长由 TTS / 音频文件决定，编辑器不改时长。</p>';
    } else if (track.id === 'sfx') {
      html += textHtml('kind', '音效类型', clip.kind);
      html += textHtml('src', '音效文件（可选）', clip.src);
      html += numberHtml('start', '起始（秒）', clip.start, 0.1, 0);
      html += numberHtml('volumeDb', '音量（dB）', clip.volumeDb, 1, -40, 12);
    }
    host.innerHTML = html;
  }

  function updatePreview() {
    var pre = $('previewJson');
    if (pre) pre.textContent = JSON.stringify(tl, null, 2);
  }

  function render() {
    renderMeta();
    renderRuler();
    renderTracks();
    renderInspector();
    updatePreview();
  }

  function applyEdit(field, rawValue) {
    if (!selected) return;
    var track = findTrack(selected.trackId);
    var clip = selectedClip();
    if (!track || !clip) return;

    // Track-level controls (music ducking) are stored on the track, not the clip.
    if (field === '__trackDuck') {
      track.duck = rawValue === true || rawValue === 'true';
      updatePreview();
      return;
    }
    if (field === '__trackDuckDb') {
      var duckDb = Number(rawValue);
      if (isFinite(duckDb)) track.duckDb = round(duckDb);
      updatePreview();
      return;
    }

    var target = clip;
    var key = field;
    if (key === 'gradientCsv') {
      clip.gradient = String(rawValue).split(/[,，]/).map(function (part) { return part.trim(); }).filter(Boolean);
    } else if (field === 'transitionIn') {
      clip.transitionIn = String(rawValue);
      if (clip.transitionIn === 'cut') clip.transitionDuration = 0;
      else if (!clip.transitionDuration) clip.transitionDuration = 0.5;
    } else if (field === 'kind' || field === 'text' || field === 'subtitle' || field === 'src' || field === 'voice' || field === 'position' || field === 'align' || field === 'animation' || field === 'motion' || field === 'fit') {
      target[key] = String(rawValue);
    } else if (field === 'muted') {
      clip.muted = rawValue === true || rawValue === 'true';
    } else {
      if (rawValue === '' || rawValue === null || rawValue === undefined) return;
      var value = Number(rawValue);
      if (isFinite(value)) {
        if (key === 'fontSize' || key === 'fps') value = Math.round(value);
        if (key === 'duration') value = Math.max(0.1, value);
        if (key === 'start') value = Math.max(0, value);
        target[key] = round(value);
      }
    }
    if (track.id === 'scenes' && (field === 'duration' || field === 'transitionIn' || field === 'transitionDuration')) recompute();
    if (track.id === 'captions' || track.id.indexOf('overlays') === 0) {
      if (clip.start !== undefined && clip.duration !== undefined && clip.duration !== null) clip.end = round(clip.start + clip.duration);
    }
    if (track.id === 'music') {
      clip.duration = tl.duration;
      clip.end = tl.duration;
      clip.start = 0;
    }
    renderTracks();
    renderRuler();
    updatePreview();
  }

  document.addEventListener('input', function (event) {
    var el = event.target;
    if (!el || !el.getAttribute) return;
    var field = el.getAttribute('data-field');
    if (!field) return;
    var value = el.type === 'checkbox' ? el.checked : el.value;
    applyEdit(field, value);
  });

  document.addEventListener('change', function (event) {
    var el = event.target;
    if (!el || !el.getAttribute) return;
    if (el.getAttribute('data-field') === 'transitionIn') applyEdit('transitionIn', el.value);
  });

  function selectClip(trackId, clipId) {
    selected = { trackId: trackId, clipId: clipId };
    renderInspector();
    renderTracks();
  }

  document.addEventListener('pointerdown', function (event) {
    var el = event.target;
    if (!el || !el.getAttribute) return;
    var trackId = el.getAttribute('data-track');
    var clipId = el.getAttribute('data-clip');
    if (!trackId || !clipId) return;
    selectClip(trackId, clipId);
    var isHandle = String(el.className || '').split(/\\s+/).indexOf('handle') !== -1;
    if (!isHandle) return;
    var track = findTrack(trackId);
    var clip = findClip(trackId, clipId);
    if (!track || !clip) return;
    event.preventDefault();
    var lane = el.parentNode && el.parentNode.parentNode;
    var laneWidth = lane ? lane.clientWidth : 600;
    var duration = Math.max(0.1, num(tl.duration, 1));
    var origDuration = clip.duration === null ? 1 : num(clip.duration, 0);
    var startX = event.clientX;
    function onMove(moveEvent) {
      var secondsDelta = (moveEvent.clientX - startX) / Math.max(1, laneWidth) * duration;
      if (track.id === 'scenes') {
        clip.duration = Math.max(0.1, round(origDuration + secondsDelta));
        recompute();
      } else if (track.id === 'music') {
        clip.duration = tl.duration;
        clip.end = tl.duration;
      } else {
        clip.duration = Math.max(0.05, round(origDuration + secondsDelta));
        clip.end = round(num(clip.start, 0) + clip.duration);
      }
      renderTracks();
      updatePreview();
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      renderInspector();
      updatePreview();
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });

  function toPlan() {
    var out = {
      output: tl.output,
      width: tl.width,
      height: tl.height,
      fps: tl.fps,
      background: tl.background,
      loudnessTarget: tl.loudnessTarget,
      scenes: [],
      overlays: [],
      captions: [],
      audio: {
        music: null,
        musicStart: 0,
        musicVolumeDb: -20,
        musicFadeOut: 2,
        duck: true,
        duckDb: -9,
        voiceover: []
      }
    };
    var scenesTrackNode = findTrack('scenes');
    if (!scenesTrackNode) return out;
    function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
    out.scenes = scenesTrackNode.clips.map(function (clip) {
      var scene = clone(clip);
      delete scene.id; delete scene.start; delete scene.end;
      delete scene.order;
      scene.duration = round(num(scene.duration, 0));
      if (!scene.transitionIn) scene.transitionIn = 'cut';
      if (scene.transitionIn === 'cut' || scene.transitionDuration === 0) delete scene.transitionDuration;
      return scene;
    });
    var captionsTrack = findTrack('captions');
    if (captionsTrack) {
      out.captions = captionsTrack.clips.map(function (clip) {
        return { start: round(num(clip.start, 0)), end: round(num(clip.start, 0) + num(clip.duration, 0)), text: clip.text, position: clip.position, fontSize: clip.fontSize, color: clip.color };
      });
    }
    var overlayTracks = tl.tracks.filter(function (track) { return track.id.indexOf('overlays') === 0; });
    var overlayClips = [];
    overlayTracks.forEach(function (track) { overlayClips = overlayClips.concat(track.clips || []); });
    overlayClips.sort(function (a, b) { return num(a.order, 0) - num(b.order, 0); });
    out.overlays = overlayClips.map(function (clip) {
      return { src: clip.src, start: round(num(clip.start, 0)), end: round(num(clip.start, 0) + num(clip.duration, 0)), width: clip.width, position: clip.position, opacity: clip.opacity, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut };
    });
    var musicTrack = findTrack('music');
    if (musicTrack && musicTrack.clips.length > 0) {
      var musicClip = musicTrack.clips[0];
      out.audio.music = musicClip.src;
      out.audio.musicStart = num(musicClip.inPoint, 0);
      out.audio.musicVolumeDb = num(musicClip.volumeDb, -20);
      out.audio.musicFadeOut = num(musicClip.fadeOut, 2);
      out.audio.duck = musicTrack.duck !== false;
      out.audio.duckDb = num(musicTrack.duckDb, -9);
    }
    var voiceTrack = findTrack('voiceover');
    if (voiceTrack) {
      out.audio.voiceover = voiceTrack.clips.map(function (clip) {
        return {
          src: typeof clip.src === 'string' && clip.src.length > 0 ? clip.src : null,
          text: typeof clip.text === 'string' ? clip.text : '',
          start: num(clip.start, 0),
          volumeDb: num(clip.volumeDb, 0),
          voice: clip.voice || 'zh',
          rate: num(clip.rate, 1)
        };
      });
    }
    var sfxTrack = findTrack('sfx');
    if (sfxTrack) {
      out.audio.sfx = sfxTrack.clips.map(function (clip) {
        var copy = clone(clip); delete copy.id; return copy;
      });
    }
    return out;
  }

  function download(name, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  }

  function baseName() {
    var parts = String(tl.output || 'timeline').split(/[\\\\/]/);
    var last = parts[parts.length - 1] || 'timeline';
    return last.replace(/\\.[^.]+$/, '');
  }

  function bind(id, handler) {
    var el = $(id);
    if (el) el.onclick = handler;
  }

  bind('exportPlan', function () {
    recompute();
    download(baseName() + '.plan.json', JSON.stringify(toPlan(), null, 2));
    setStatus('已导出 ' + baseName() + '.plan.json（可直接交给 media_build_video）');
  });
  bind('exportTimeline', function () {
    recompute();
    download(baseName() + '.timeline.json', JSON.stringify(tl, null, 2));
    setStatus('已导出 ' + baseName() + '.timeline.json');
  });
  bind('copyJson', function () {
    recompute();
    var text = JSON.stringify(tl, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { setStatus('已复制时间线 JSON'); }, function () { setStatus('复制失败，请手动选择下方 JSON'); });
    } else {
      setStatus('已更新下方 JSON，请手动复制');
    }
    updatePreview();
  });
  bind('resetAll', function () {
    tl = JSON.parse(JSON.stringify(DATA));
    selected = null;
    recompute();
    render();
    setStatus('已重置为原始时间线');
  });

  // Small programmatic surface for tooling/tests: read the live model, replace it,
  // and convert to a RenderPlan with exactly the same rules as timelineToPlan().
  window.__MS_TIMELINE_EDITOR__ = {
    version: tl.version,
    getTimeline: function () { return tl; },
    setTimeline: function (next) { tl = JSON.parse(JSON.stringify(next)); selected = null; recompute(); render(); },
    recompute: recompute,
    exportPlan: toPlan,
    exportTimelineJson: function () { recompute(); return JSON.stringify(tl, null, 2); }
  };

  recompute();
  render();
})();
</script>
</body>
</html>
`
}

export default {
  TIMELINE_VERSION,
  TIMELINE_TRACK_KINDS,
  planToTimeline,
  timelineToPlan,
  renderTimelineHtml,
  diffTimeline,
  timelineDuration,
}
