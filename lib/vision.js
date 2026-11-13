/**
 * Vision target support.
 *
 * The plugin was built for text-only models: reports carry ASCII luminance art,
 * verbal substitutes ("偏暗/高对比") and numeric tables. When the *current model
 * route* declares image input, that presentation is wasteful and arguably worse:
 * the model can look at the picture, so it needs an index and concrete questions,
 * not a description of the picture in text.
 *
 * This module owns the capability probe, the image budget, size clamping and the
 * attachment machinery. The renderers take a `target` flag and do the wording.
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { run } from './ffmpeg.js'

/**
 * Image presets. `sheetWidth` is a 42 px multiple (harness patch grid: 14 px
 * patches pad up to 42 px cells), so we never pay for a padded column.
 */
export const VISION_PROFILES = {
  balanced: { sheetWidth: 1260, filmstripWidth: 1260, columns: 3, detailWidth: 1260, maxImages: 4 },
  high: { sheetWidth: 1596, filmstripWidth: 1596, columns: 2, detailWidth: 1596, maxImages: 3 },
}

/** Default attachment limits when the deployment exposes none. */
const FALLBACK_LIMITS = {
  maxImageBytes: 5 * 1024 * 1024,
  maxImageDimension: 8000,
  maxImagePixels: 40_000_000,
  maxMessageImageBytes: 20 * 1024 * 1024,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
  maxImagesPerMessage: 8,
}

/** Resolve the requested vision mode into a concrete profile name. */
export function resolveProfile(name) {
  return VISION_PROFILES[name] === undefined ? 'balanced' : name
}

/** Read the model/profile config knob into a requested mode. */
function normaliseMode(value) {
  return value === 'blind' || value === 'vision' ? value : 'auto'
}

/**
 * Detect whether the current model route accepts images.
 *
 * Mirrors the gate of the built-in `read_image` tool: the route is resolved from
 * the session request header (falling back to agent options), then
 * `llm.resolveModelInfo` must explicitly declare `image` input.
 *
 * @param {object} options
 * @param {object} options.ctx Cordis context (optional services are read via ctx.get)
 * @param {object} [options.exec] tool run context
 * @param {object} [options.config] plugin config
 * @param {'auto'|'blind'|'vision'} [options.override] explicit tool argument
 * @returns {Promise<{active: boolean, requested: string, reason: string, profile: string, maxImages: number, limits: object}>}
 */
export async function detectVision(options = {}) {
  const config = options.config ?? {}
  const requested = normaliseMode(options.override ?? config.visionMode)
  const profile = resolveProfile(config.visionImageProfile ?? 'balanced')
  const preset = VISION_PROFILES[profile]
  const result = {
    active: false,
    requested,
    reason: 'unknown',
    profile,
    maxImages: preset.maxImages,
    limits: { ...FALLBACK_LIMITS },
  }

  if (requested === 'blind') {
    result.reason = 'mode=blind (forced by caller or config)'
    return result
  }

  const ctx = options.ctx
  const exec = options.exec
  if (ctx === undefined) {
    result.reason = 'no Cordis context available'
    return result
  }

  // Attachment limits decide what we may send at all.
  try {
    const attachments = ctx.get?.('attachments')
    const limits = attachments?.imageLimits
    if (limits !== undefined && limits !== null) {
      result.limits = {
        maxImageBytes: Number(limits.maxImageBytes) || FALLBACK_LIMITS.maxImageBytes,
        maxImageDimension: Number(limits.maxImageDimension) || FALLBACK_LIMITS.maxImageDimension,
        maxImagePixels: Number(limits.maxImagePixels) || FALLBACK_LIMITS.maxImagePixels,
        maxMessageImageBytes: Number(limits.maxMessageImageBytes) || FALLBACK_LIMITS.maxMessageImageBytes,
        mediaTypes: Array.isArray(limits.mediaTypes) && limits.mediaTypes.length > 0 ? limits.mediaTypes : FALLBACK_LIMITS.mediaTypes,
        maxImagesPerMessage: Number(limits.maxImagesPerMessage) || FALLBACK_LIMITS.maxImagesPerMessage,
      }
    } else {
      result.reason = 'no attachment service mounted'
    }
  } catch {
    // Keep fallback limits; the route check decides whether we send anything.
  }

  try {
    const llm = ctx.get?.('llm')
    if (llm === undefined) {
      result.reason = 'no llm service available'
      return result
    }
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (typeof provider !== 'string' || typeof model !== 'string') {
      result.reason = 'model route could not be resolved'
      return result
    }
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : []
    if (!modalities.includes('image')) {
      result.reason = `model "${model}" does not declare image input`
      return result
    }
    result.active = true
    result.reason = `model "${model}" declares image input`
    return result
  } catch (error) {
    result.reason = `vision probe failed: ${error instanceof Error ? error.message : String(error)}`
    return result
  }
}

/** Re-encode a PNG so it satisfies the attachment limits. */
async function fitImage({ tools, path, workDir, limits }) {
  const info = await stat(path).catch(() => undefined)
  if (info === undefined) return { path, changed: false }
  const target = join(workDir, `fit-${Date.now()}-${path.split(/[\\/]/u).pop() ?? 'image.png'}`)
  // Keep the long side within the deployment dimension cap; `scale` with plain
  // numbers is safe inside a filtergraph (no drive letters involved).
  const maxDimension = Math.min(limits.maxImageDimension, 4096)
  const filter = `scale='min(${maxDimension},iw)':-2:flags=lanczos`
  const result = await run(tools.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', path, '-frames:v', '1', '-vf', filter, target], { timeoutMs: 120_000 })
  if (result.code !== 0) return { path, changed: false }
  const fitted = await stat(target).catch(() => undefined)
  if (fitted === undefined) return { path, changed: false }
  const original = await stat(path).catch(() => undefined)
  const better = fitted.size < (original?.size ?? Number.POSITIVE_INFINITY) || (fitted.size <= limits.maxImageBytes && (original?.size ?? 0) > limits.maxImageBytes)
  return better ? { path: target, changed: true } : { path, changed: false }
}

/**
 * Attach a list of images to the tool result when the route and the limits allow.
 *
 * Each entry is `{ path, name, kind? }`. Failures never throw: the entry is
 * skipped and a note is returned so the report can be honest about it.
 *
 * @param {object} options
 * @param {object} options.ctx
 * @param {object} [options.exec]
 * @param {{ffmpeg: string}} options.tools
 * @param {string} options.workDir scratch dir for re-encodes
 * @param {Array<{path?: string, name: string, kind?: string}>} options.entries
 * @param {object} options.vision result of {@link detectVision}
 * @returns {Promise<{images: object[], notes: string[], skipped: object[]}>}
 */
export async function attachImages(options) {
  const { ctx, exec, tools, workDir, vision } = options
  const entries = Array.isArray(options.entries) ? options.entries : []
  const images = []
  const notes = []
  const skipped = []
  if (vision.active !== true) return { images, notes, skipped }

  const attachments = ctx.get?.('attachments')
  const limits = vision.limits ?? FALLBACK_LIMITS
  if (attachments === undefined) {
    notes.push('附件服务不可用，本次只能给图片路径')
    return { images, notes, skipped }
  }

  const maxImages = Math.min(vision.maxImages ?? 4, Math.max(1, Number(limits.maxImagesPerMessage) || vision.maxImages || 4))
  let totalBytes = 0
  const budget = (Number(limits.maxMessageImageBytes) || FALLBACK_LIMITS.maxMessageImageBytes) * 0.85

  for (const entry of entries) {
    if (images.length >= maxImages) {
      skipped.push({ ...entry, reason: `图片张数上限 ${maxImages}` })
      continue
    }
    let path = typeof entry.path === 'string' && entry.path.length > 0 ? entry.path : undefined
    if (path === undefined || !isAbsolute(path)) {
      skipped.push({ ...entry, reason: 'no absolute image path' })
      continue
    }
    try {
      const original = await stat(path)
      let chosen = path
      const mustFitSize = original.size > limits.maxImageBytes || original.size + totalBytes > budget
      if (mustFitSize) {
        const fitted = await fitImage({ tools, path, workDir, limits })
        chosen = fitted.path
      }
      const data = await readFile(chosen)
      if (data.length > limits.maxImageBytes && chosen === path) {
        // One more attempt with a real downscale before giving up.
        const fitted = await fitImage({ tools, path, workDir, limits })
        if (fitted.changed === false) {
          skipped.push({ ...entry, reason: `图片过大且无法压缩（${data.length} bytes）` })
          continue
        }
        chosen = fitted.path
      }
      const mediaType = chosen.toLowerCase().endsWith('.jpg') || chosen.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
      if (Array.isArray(limits.mediaTypes) && !limits.mediaTypes.includes(mediaType)) {
        skipped.push({ ...entry, reason: `不支持的图片类型 ${mediaType}` })
        continue
      }
      const bytes = await readFile(chosen)
      if (bytes.length + totalBytes > budget) {
        skipped.push({ ...entry, reason: '本条消息的图片总预算已满' })
        continue
      }
      const ref = await attachments.saveImage({ data: bytes, mediaType, name: entry.name })
      images.push({
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
        kind: entry.kind,
      })
      totalBytes += bytes.length
      if (chosen !== path) notes.push(`${entry.name} 已压缩以适配附件上限（${Math.round(original.size / 1024)}KB → ${Math.round(bytes.length / 1024)}KB）`)
    } catch (error) {
      skipped.push({ ...entry, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { images, notes, skipped }
}

/**
 * Clamp a requested width to the profile and to the deployment limits.
 *
 * @param {string} profile
 * @param {'sheet'|'filmstrip'|'detail'} kind
 */
export function profileWidth(profile, kind = 'sheet') {
  const preset = VISION_PROFILES[resolveProfile(profile)]
  if (kind === 'detail') return preset.detailWidth
  if (kind === 'filmstrip') return preset.filmstripWidth
  return preset.sheetWidth
}

/** Pick `count` evenly spaced times inside [start, end], avoiding the edges. */
export function sampleTimes(start, end, count) {
  const from = Number.isFinite(start) ? start : 0
  const to = Number.isFinite(end) && end > from ? end : from + 1
  const n = Math.max(1, Math.min(Number.isInteger(count) ? count : 3, 8))
  const span = to - from
  const times = []
  for (let index = 0; index < n; index += 1) {
    // Skip the very first/last frame: decoders often need a few ms to settle.
    const ratio = n === 1 ? 0.5 : 0.08 + (index / (n - 1)) * 0.84
    times.push(Math.round((from + span * ratio) * 100) / 100)
  }
  return times
}

/** Format an image plan entry for the report renderers. */
export function planEntry(kind, caption, extra = {}) {
  return {
    kind,
    caption,
    ...extra,
  }
}

/** Human-readable summary of the image plan for the report header. */
export function describeImagePlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return ''
  return plan
    .map((entry) => `- 【${entry.kind}】${entry.caption ?? ''}${entry.note ? ` — ${entry.note}` : ''}`)
    .join('\n')
}

export { FALLBACK_LIMITS }

