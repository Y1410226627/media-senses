/**
 * Artifact rendering that is not tied to one analysis engine.
 *
 * The audio engine may render its own waveform/spectrogram, but the plugin must
 * never depend on that: this module produces the two viewable images with plain
 * ffmpeg lavfi filters and is used as a guaranteed fallback (and to enrich the
 * soundtrack visuals of a video report).
 */
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { run, tailLines } from './ffmpeg.js'

/**
 * Build a stable, collision-free artifact name.
 *
 * @param {string} dir
 * @param {string} prefix
 * @param {string} suffix
 */
function artifactPath(dir, prefix, suffix) {
  return join(dir, `${prefix}-${suffix}.png`)
}

/**
 * Render a spectrogram image for the given media range.
 *
 * @param {object} options
 * @param {{ffmpeg: string}} options.tools
 * @param {string} options.file absolute media path
 * @param {string} options.outDir absolute destination directory
 * @param {string} [options.prefix]
 * @param {number} [options.start]
 * @param {number} [options.duration]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{path?: string, warning?: string}>}
 */
export async function renderSpectrogram(options) {
  const { tools, file, outDir } = options
  await mkdir(outDir, { recursive: true })
  const path = artifactPath(outDir, options.prefix ?? 'audio', 'spectrogram')
  const args = ['-v', 'error', '-nostdin', '-y']
  if (Number.isFinite(options.start) && options.start > 0) args.push('-ss', String(options.start))
  if (Number.isFinite(options.duration) && options.duration > 0) args.push('-t', String(options.duration))
  args.push('-i', file, '-lavfi', 'showspectrumpic=s=1000x320:legend=0:color=intensity:scale=log', '-frames:v', '1', path)
  const result = await run(tools.ffmpeg, args, { timeoutMs: 300_000, signal: options.signal })
  if (result.code !== 0) {
    const warning = `cannot render a spectrogram: ${tailLines(result.stderr, 4)}`
    return { warning }
  }
  return { path }
}

/**
 * Render a waveform image for the given media range.
 *
 * @param {object} options see {@link renderSpectrogram}
 * @returns {Promise<{path?: string, warning?: string}>}
 */
export async function renderWaveform(options) {
  const { tools, file, outDir } = options
  await mkdir(outDir, { recursive: true })
  const path = artifactPath(outDir, options.prefix ?? 'audio', 'waveform')
  const args = ['-v', 'error', '-nostdin', '-y']
  if (Number.isFinite(options.start) && options.start > 0) args.push('-ss', String(options.start))
  if (Number.isFinite(options.duration) && options.duration > 0) args.push('-t', String(options.duration))
  args.push('-i', file, '-lavfi', 'showwavespic=s=1000x220:split_channels=0:colors=#5ec8ff', '-frames:v', '1', path)
  const result = await run(tools.ffmpeg, args, { timeoutMs: 300_000, signal: options.signal })
  if (result.code !== 0) {
    const warning = `cannot render a waveform: ${tailLines(result.stderr, 4)}`
    return { warning }
  }
  return { path }
}

/**
 * Fill in the waveform/spectrogram artifacts that an analysis report is missing,
 * and verify that the paths it already carries still exist.
 *
 * @param {object} options
 * @param {{ffmpeg: string}} options.tools
 * @param {string} options.file
 * @param {string} options.outDir
 * @param {string} [options.prefix]
 * @param {number} [options.start]
 * @param {number} [options.duration]
 * @param {{waveform?: string, spectrogram?: string}} [options.existing]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{artifacts: object, warnings: string[]}>}
 */
export async function ensureAudioArtifacts(options) {
  const artifacts = { ...(options.existing ?? {}) }
  const warnings = []

  const present = async (path) => {
    if (typeof path !== 'string' || path.length === 0) return false
    const info = await stat(path).catch(() => undefined)
    return info !== undefined && info.size > 0
  }

  if (!(await present(artifacts.waveform))) {
    const rendered = await renderWaveform(options)
    if (rendered.path !== undefined) artifacts.waveform = rendered.path
    if (rendered.warning !== undefined) warnings.push(rendered.warning)
  }
  if (!(await present(artifacts.spectrogram))) {
    const rendered = await renderSpectrogram(options)
    if (rendered.path !== undefined) artifacts.spectrogram = rendered.path
    if (rendered.warning !== undefined) warnings.push(rendered.warning)
  }
  return { artifacts, warnings }
}

export default { ensureAudioArtifacts, renderSpectrogram, renderWaveform }
