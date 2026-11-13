/**
 * media-senses — audio-visual senses and a reproduction loop for a text-only LLM.
 *
 * Perception tools (watch/listen/inspect):
 *   media_probe        container/stream facts for any media file
 *   media_watch_video  shots, keyframes, per-shot brightness/hue/motion, luminance
 *                      and hue art, health flags, soundtrack summary, transcript,
 *                      plus production-craft analysis and a reproduction recipe
 *   media_listen_audio BPM, key, chords, structure, loudness, timbre, mood, transcript
 *   media_frame        one zoomed-in moment (or a still image) as art + metrics
 *   media_whisper      local whisper model status / download / removal
 *
 * Learning + reproduction tools:
 *   media_corpus       analyse a whole folder (or URL list) once, then aggregate a
 *                      style profile: how this genre of video is made
 *   media_build_video  render a RenderPlan JSON into a finished MP4 (transitions,
 *                      titles, Ken Burns images, captions, music, narration)
 *   media_tts          synthesize narration with the local Windows voices
 *
 * Everything runs locally through ffmpeg (plus a ggml whisper model and the SAPI
 * text-to-speech voices); no network is used unless media or a whisper model must
 * be downloaded once.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { analyzeAudio } from './lib/audio.js'
import { analyzeVideo } from './lib/video.js'
import { analyzeFrame } from './lib/frame.js'
import { ensureAudioArtifacts } from './lib/artifacts.js'
import { asrBaseDir, ensureModel, modelInventory, transcribe, whisperSupport } from './lib/asr.js'
import { analyzeCorpus, expandSource, mediaId } from './lib/corpus.js'
import { ingestUrls } from './lib/ingest.js'
import { buildStyleProfile } from './lib/profile.js'
import { artifactDir, formatBytes, formatTimecode, makeWorkDir, probe, removeWorkDir, resolveTools, run, summariseProbe } from './lib/ffmpeg.js'
import { renderAudioReport, renderFrameReport, renderProbeReport, renderVideoReport } from './lib/render.js'
import { renderAnimateReport, renderBuildReport, renderChangeSection, renderCorpusReport, renderCraftSection, renderSeeReport, renderStylesReport, renderTtsReport } from './lib/render-v2.js'
import { getStyle, resolveSkillDir, searchStyles, seriesOverview, starterPath } from './lib/styles.js'

export const name = 'media-senses'
export const inject = ['tools']

const DEFAULTS = {
  ffmpegPath: '',
  ffprobePath: '',
  whisperModel: 'tiny',
  modelDir: '',
  asrMaxSeconds: 240,
  videoMaxSeconds: 1800,
  audioMaxSeconds: 900,
  maxKeyframes: 36,
  outputDir: '',
  detail: 'full',
  embedImages: true,
  skillDir: '',
  browserPath: '',
  animateMaxSeconds: 60,
  corpusDir: '',
  allowScreenCapture: true,
  screenQuality: 'low',
}

const TEXT_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

/**
 * Render a report and, when the plugin could attach images, the images too.
 *
 * The images are prepared during `execute` (which can await the attachments
 * service) and only materialised here, because `render` is synchronous.
 */
function renderTextAndImages(_args, value) {
  const blocks = [{ type: 'text', text: String(value?.report ?? '') }]
  if (Array.isArray(value?.images)) {
    for (const image of value.images) {
      if (image !== null && typeof image === 'object' && typeof image.attachmentId === 'string') {
        blocks.push({ type: 'image', attachment: image })
      }
    }
  }
  return blocks
}

/** Collapse the plugin config into resolved defaults. */
function resolveConfig(raw) {
  const config = { ...DEFAULTS, ...(raw !== null && typeof raw === 'object' ? raw : {}) }
  return config
}

/** True when the value is an object with at least one key. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Expand `~` and resolve a user-supplied path against the process cwd. */
function resolveInputPath(raw, config) {
  let input = String(raw ?? '').trim()
  if (input.length === 0) throw new Error('path 不能为空')
  if (input === '~') input = homedir()
  else if (input.startsWith('~/') || input.startsWith('~\\')) input = join(homedir(), input.slice(2))
  const candidates = isAbsolute(input) ? [input] : [resolve(process.cwd(), input), resolve(homedir(), input)]
  return candidates
}

/** Stat the first readable candidate path. */
async function locateInput(raw, config) {
  const candidates = resolveInputPath(raw, config)
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => undefined)
    if (info !== undefined && info.isFile()) return { path: candidate, sizeBytes: info.size }
  }
  throw new Error(`找不到文件: ${raw}（已尝试 ${candidates.join(' / ')}）；请提供绝对路径`)
}

/** Classify a probed file. */
function classify(summary) {
  if (Array.isArray(summary.video) && summary.video.length > 0) return 'video'
  if (Array.isArray(summary.audio) && summary.audio.length > 0) return 'audio'
  return 'unknown'
}

const IMAGE_FORMAT = /^(image2|png_pipe|jpeg_pipe|webp_pipe|gif|gif_pipe|bmp_pipe|tiff_pipe|jpe?g)/iu

function isImageLike(summary) {
  if (IMAGE_FORMAT.test(String(summary.formatName ?? ''))) return true
  const streams = Array.isArray(summary.video) ? summary.video : []
  return streams.length > 0 && (summary.duration === 0 || streams[0].fps === 0)
}

/** Merge transcript information into an analysis and collect notes for the report. */
function mergeTranscript(analysis, transcript, notes) {
  if (transcript === null) return
  const text = typeof transcript.text === 'string' ? transcript.text.trim() : ''
  if (transcript.truncated === true) notes.push(`转写只覆盖了前 ${Math.round(transcript.audioSeconds)} 秒（可用 start/duration 指定片段再转写）`)
  if (Array.isArray(transcript.warnings)) for (const warning of transcript.warnings) notes.push(warning)
  if (text.length === 0) return
  analysis.transcript = { text, audioSeconds: transcript.audioSeconds }
  if (analysis.kind === 'audio') {
    // AudioAnalysis carries the transcript at the top level.
    analysis.transcript = { text, audioSeconds: transcript.audioSeconds }
  }
  return text
}

/**
 * Plugin entry point.
 *
 * @param {object} ctx Cordis context (needs `tools`)
 * @param {object} rawConfig Loader row config
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  /** Lazily resolved ffmpeg/ffprobe pair. */
  let toolsPromise

  const tools = () => {
    toolsPromise ??= resolveTools({ ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath }).catch((error) => {
      toolsPromise = undefined
      throw error
    })
    return toolsPromise
  }

  const detailOf = (args) => (args?.detail === 'brief' ? 'brief' : args?.detail === 'full' ? 'full' : config.detail)

  /* ------------------------------------------------------------ media_probe */

  ctx.tools.register({
    name: 'media_probe',
    description:
      '探测任意音视频/图片文件的容器与流信息：时长、分辨率、帧率、编码、码率、音轨、字幕轨、章节。' +
      '用它先判断文件是什么、能不能分析、有没有字幕轨或音轨。\n' +
      'Probe any media file (video/audio/image) for container and stream facts: duration, resolution, fps, codecs, bitrate, ' +
      'audio/subtitle streams, chapters. Cheap and fast; call it before deeper analysis when a file is unfamiliar.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '媒体文件的绝对路径（也接受相对当前工作目录的路径）。' },
      },
      required: ['path'],
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderTextAndImages,
    },
    isConcurrencySafe: () => true,
    timeoutMs: 120_000,
    async execute(args) {
      const resolved = await tools()
      const input = await locateInput(args.path, config)
      const probed = await probe(resolved, input.path)
      const summary = summariseProbe(probed)
      const kind = isImageLike(summary) ? 'image' : classify(summary)
      const report = renderProbeReport(summary, input.path, { kind })
      return {
        kind,
        file: input.path,
        duration_seconds: Math.round(summary.duration * 100) / 100,
        format: summary.formatName,
        size_bytes: input.sizeBytes,
        report,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Probe ${args.path}`, kind: 'read', locations: [{ path: String(args.path) }] }
    },
  })

  /* ------------------------------------------------------ media_watch_video */

  ctx.tools.register({
    name: 'media_watch_video',
    description:
      '“看”一个视频：切分镜头并按时间码给出每个镜头的亮度/彩度/色调/运动量、主色板，生成缩略亮度图（ASCII）与色相图，' +
      '还会给出逐秒曲线、黑场/冻帧/静音检查、配乐节奏调性与对白转写，并保存联系表(keyframe 网格)和关键帧原图。\n' +
      'Watch a video: shot segmentation with timecoded brightness/saturation/hue/motion, palettes, luminance and hue ASCII art ' +
      'of every keyframe, per-second curves, black/frozen/silent flags, soundtrack analysis and a local whisper transcript. ' +
      'Saves a contact sheet and keyframe JPEGs you can open with read_image. Use it whenever the question is about what happens ' +
      'in a video or what it looks like.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '视频文件绝对路径。' },
        start: { type: 'number', description: '从第几秒开始分析（默认 0）。' },
        duration: { type: 'number', description: '只分析这一段时长（秒），默认全片，上限由配置 videoMaxSeconds 决定。' },
        max_keyframes: { type: 'integer', description: '最多抽取多少个关键帧/镜头明细（默认 36，上限 60）。' },
        include_transcript: { type: 'boolean', description: '是否用本地 whisper 转写语音（默认 true；首次会下载约 74MB 模型，纯音乐视频可设 false 更快）。' },
        language: { type: 'string', description: '语音转写语种，如 zh / en / auto（默认 auto）。' },
        output_dir: { type: 'string', description: '保存联系表与关键帧的目录；省略时写入系统临时目录。' },
        detail: { type: 'string', enum: ['brief', 'full'], description: 'brief 只展开前若干镜头的画面结构；full 展开更多。' },
        include_craft: { type: 'boolean', description: '是否分析「制作技法」（剪辑节奏/转场/运镜/调色/卡点/钩子）并生成仿制配方，默认 true。' },
        include_change: { type: 'boolean', description: '是否用「变化量选帧」补一份信息量时间线（硬切尖峰 + 持续运动积分，适合录屏/幻灯片），默认 true。' },
      },
      required: ['path'],
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderTextAndImages,
    },
    isConcurrencySafe: () => true,
    timeoutMs: 900_000,
    async execute(args, exec) {
      const resolved = await tools()
      const input = await locateInput(args.path, config)
      const probed = await probe(resolved, input.path)
      const summary = summariseProbe(probed)
      if (isImageLike(summary)) throw new Error(`${args.path} 看起来是静态图片，不是视频；请改用 media_frame 看这一张图。`)
      if (classify(summary) !== 'video') throw new Error(`${args.path} 没有可分析的视频流；请改用 media_listen_audio 分析音频。`)

      const outDir = await artifactDir(input.path, args.output_dir ?? config.outputDir)
      const workDir = await makeWorkDir('media-senses-video')
      const notes = []
      const startedAt = Date.now()
      try {
        const analysis = await analyzeVideo({
          tools: resolved,
          file: input.path,
          workDir,
          options: {
            start: Number.isFinite(args.start) ? Math.max(0, args.start) : 0,
            maxSeconds: Math.min(Number.isFinite(args.duration) && args.duration > 0 ? args.duration : config.videoMaxSeconds, config.videoMaxSeconds),
            maxKeyframes: Math.min(Math.max(Number.isInteger(args.max_keyframes) ? args.max_keyframes : config.maxKeyframes, 1), 60),
            wantAudio: true,
            wantContactSheet: true,
            wantFrames: true,
            artifactDir: outDir,
            sceneThreshold: 0.3,
            densityFloorSeconds: 25,
            analyzeAudio: true,
          },
          signal: exec?.signal,
          analyzeAudio,
        })

        const audio = analysis.audio !== null && typeof analysis.audio === 'object' ? analysis.audio : null
        if (audio !== null) {
          // The audio engine may have written its visuals into its own scratch
          // cache; regenerate them next to the video artifacts unless the paths
          // it returned already live in the requested directory.
          const inOutDir = (path) => typeof path === 'string' && path.startsWith(outDir)
          const ensured = await ensureAudioArtifacts({
            tools: resolved,
            file: input.path,
            outDir,
            prefix: 'soundtrack',
            start: Number.isFinite(args.start) ? Math.max(0, args.start) : 0,
            duration: Number.isFinite(args.duration) && args.duration > 0 ? args.duration : undefined,
            existing: {
              ...(inOutDir(analysis.artifacts?.waveform) ? { waveform: analysis.artifacts.waveform } : {}),
              ...(inOutDir(analysis.artifacts?.spectrogram) ? { spectrogram: analysis.artifacts.spectrogram } : {}),
            },
            signal: exec?.signal,
          })
          analysis.artifacts = { ...(analysis.artifacts ?? {}), ...ensured.artifacts }
          for (const warning of ensured.warnings) notes.push(warning)
        }
        let transcript = null
        if (args.include_transcript !== false && audio !== null && config.whisperModel !== 'off') {
          transcript = await maybeTranscribe({
            resolved,
            config,
            file: input.path,
            start: Number.isFinite(args.start) ? Math.max(0, args.start) : 0,
            language: args.language,
            signal: exec?.signal,
            notes,
          })
        }
        mergeTranscript(analysis, transcript, notes)

        // Production-craft analysis: how this video was actually made. Optional,
        // because the craft engine may be unavailable and perception must not
        // depend on it.
        let craft = null
        let recipe = null
        if (args.include_craft !== false) {
          try {
            const { analyzeCraft } = await import('./lib/craft.js')
            const crafted = await analyzeCraft({
              tools: resolved,
              file: input.path,
              workDir,
              analysis,
              artifactDir: outDir,
              options: {},
              signal: exec?.signal,
            })
            craft = crafted?.craft ?? null
            recipe = crafted?.recipe ?? null
          } catch (error) {
            notes.push(`制作技法分析不可用（${error instanceof Error ? error.message : String(error)}），本次只给出感知报告`)
          }
        }

        // Change-driven frame selection (absorbed from dsh-see-now): gives an
        // "information budget" view of the video — spikes are hard cuts, slow
        // motion accumulates — which the shot detector alone can miss.
        let change = null
        if (args.include_change !== false) {
          try {
            const { scoreVideo, selectFrames } = await import('./lib/change.js')
            const scored = await scoreVideo({
              tools: resolved,
              file: input.path,
              workDir,
              options: { fps: 12, start: Number.isFinite(args.start) ? Math.max(0, args.start) : 0, duration: Number.isFinite(args.duration) && args.duration > 0 ? args.duration : undefined },
              signal: exec?.signal,
            })
            const picked = selectFrames(scored.frames, { fps: scored.fps, maxFrames: 16 })
            change = {
              mean: scored.mean,
              p95: scored.p95,
              cuts: picked.cuts,
              selected: picked.selected,
              scoreCurve: scored.frames.map((frame) => frame.score),
              fps: scored.fps,
            }
          } catch (error) {
            notes.push(`变化量选帧不可用（${error instanceof Error ? error.message : String(error)}）`)
          }
        }

        let report = renderVideoReport(analysis, { file: input.path, detail: detailOf(args), transcript: analysis.transcript?.text ?? null, asrNotes: notes })
        if (craft !== null) report += `\n\n${renderCraftSection(craft, recipe)}`
        if (change !== null) report += `\n\n${renderChangeSection(change)}`
        const images = await inlineImages(exec, [{ path: analysis.artifacts?.contactSheet, name: 'media-senses-contact-sheet.png' }])
        const note = images.length > 0 ? '\n\n> 本次结果末尾已直接附带**联系表图像**（按镜头顺序排列、带时间码水印）。直接看图即可复核上面的镜头表；需要某一刻的高清原图时再调 `media_frame`。' : ''
        const elapsed = Math.round((Date.now() - startedAt) / 100) / 10
        return {
          kind: 'video',
          file: input.path,
          duration_seconds: Math.round(Number(analysis.duration ?? 0) * 100) / 100,
          shots: analysis.shots?.length ?? 0,
          has_audio: audio !== null,
          transcript_chars: analysis.transcript?.text?.length ?? 0,
          artifacts: analysis.artifacts ?? {},
          elapsed_seconds: elapsed,
          images,
          craft,
          recipe,
          change,
          report: report + note,
        }
      } finally {
        await removeWorkDir(workDir)
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Watch ${args.path}`, kind: 'read', locations: [{ path: String(args.path) }] }
    },
  })

  /* ----------------------------------------------------- media_listen_audio */

  ctx.tools.register({
    name: 'media_listen_audio',
    description:
      '“听”一段音乐或音频：测定 BPM/节拍、调性（Krumhansl）、和弦进行、曲式分段、响度(LUFS/峰值/动态范围)、' +
      '音色与频段占比、人声可能性、情绪倾向（唤醒度/效价），并生成波形图、频谱图与音级热力图。\n' +
      'Listen to music/audio: tempo and beat grid, key, chord progression, structural sections, loudness (LUFS/peak/dynamic range), ' +
      'timbre and band balance, vocal likelihood, heuristic mood, plus waveform/spectrogram/chroma images. ' +
      'Use it for any question about a song, a soundtrack, a voice recording or any audio file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '音频（或带音轨的视频）文件的绝对路径。' },
        start: { type: 'number', description: '从第几秒开始分析（默认 0）。' },
        duration: { type: 'number', description: '分析时长（秒），默认全曲，上限由配置 audioMaxSeconds 决定。' },
        include_chords: { type: 'boolean', description: '是否做和弦识别（默认 true）。' },
        include_transcript: { type: 'boolean', description: '是否用本地 whisper 转写人声/歌词（默认 false，因为会明显增加耗时）。' },
        language: { type: 'string', description: '转写语种，如 zh / en / auto。' },
        output_dir: { type: 'string', description: '保存图像文件的目录；省略时写入系统临时目录。' },
        detail: { type: 'string', enum: ['brief', 'full'], description: 'brief 精简和弦表，full 展开更多。' },
      },
      required: ['path'],
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderTextAndImages,
    },
    isConcurrencySafe: () => true,
    timeoutMs: 900_000,
    async execute(args, exec) {
      const resolved = await tools()
      const input = await locateInput(args.path, config)
      const probed = await probe(resolved, input.path)
      const summary = summariseProbe(probed)
      if (isImageLike(summary)) throw new Error(`${args.path} 是图片，没有音频内容。`)
      if (!Array.isArray(summary.audio) || summary.audio.length === 0) throw new Error(`${args.path} 没有音频流，无法分析声音。`)

      const outDir = await artifactDir(input.path, args.output_dir ?? config.outputDir)
      const workDir = await makeWorkDir('media-senses-audio')
      const notes = []
      const startedAt = Date.now()
      try {
        const analysis = await analyzeAudio({
          tools: resolved,
          file: input.path,
          workDir,
          options: {
            start: Number.isFinite(args.start) ? Math.max(0, args.start) : 0,
            duration: Number.isFinite(args.duration) && args.duration > 0 ? args.duration : undefined,
            maxSeconds: config.audioMaxSeconds,
            wantArtifacts: true,
            wantChords: args.include_chords !== false,
            wantStructure: true,
            artifactDir: outDir,
          },
          signal: exec?.signal,
        })

        const ensured = await ensureAudioArtifacts({
          tools: resolved,
          file: input.path,
          outDir,
          start: Number.isFinite(args.start) ? Math.max(0, args.start) : 0,
          duration: Number.isFinite(args.duration) && args.duration > 0 ? args.duration : undefined,
          existing: analysis.artifacts ?? {},
          signal: exec?.signal,
        })
        analysis.artifacts = ensured.artifacts
        for (const warning of ensured.warnings) notes.push(warning)

        let transcript = null
        if (args.include_transcript === true && config.whisperModel !== 'off') {
          transcript = await maybeTranscribe({
            resolved,
            config,
            file: input.path,
            start: Number.isFinite(args.start) ? Math.max(0, args.start) : 0,
            language: args.language,
            signal: exec?.signal,
            notes,
          })
        }
        mergeTranscript(analysis, transcript, notes)

        const report = renderAudioReport(analysis, { file: input.path, detail: detailOf(args), transcript: transcript?.text ?? null, asrNotes: notes })
        const images = await inlineImages(exec, [
          { path: analysis.artifacts?.spectrogram, name: 'media-senses-spectrogram.png' },
          { path: analysis.artifacts?.waveform, name: 'media-senses-waveform.png' },
        ])
        const elapsed = Math.round((Date.now() - startedAt) / 100) / 10
        return {
          kind: 'audio',
          file: input.path,
          duration_seconds: Math.round(Number(analysis.duration ?? 0) * 100) / 100,
          bpm: analysis.tempo?.bpm ?? null,
          key: analysis.key?.name ?? null,
          sections: analysis.sections?.length ?? 0,
          artifacts: analysis.artifacts ?? {},
          elapsed_seconds: elapsed,
          images,
          report,
        }
      } finally {
        await removeWorkDir(workDir)
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Listen to ${args.path}`, kind: 'read', locations: [{ path: String(args.path) }] }
    },
  })

  /* ------------------------------------------------------------ media_frame */

  ctx.tools.register({
    name: 'media_frame',
    description:
      '细看某一刻的画面（或一张静态图片）：导出该帧原图，并给出 56×22 的亮度图、色相字母图、配色、对比度、边缘密度与构图判断。' +
      '当你需要确认“这一秒屏幕上到底是什么”“字幕写的什么颜色/版式”“这个镜头里主体在哪个位置”时用它。\n' +
      'Zoom into one moment of a video (or inspect a still image): exports the full frame and returns luminance art, a hue-letter ' +
      'map, palette, contrast, edge density and composition notes. Use it to resolve specific visual questions raised by a ' +
      'storyboard, or to look at a picture/screenshot. Cheap enough to call several times.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '视频或图片文件的绝对路径。' },
        time: { type: 'number', description: '时间点（秒）；图片文件可省略。' },
        output_dir: { type: 'string', description: '保存原图的目录；省略时写入系统临时目录。' },
        max_width: { type: 'integer', description: '导出原图的最大宽度像素（默认 960）。' },
      },
      required: ['path'],
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderTextAndImages,
    },
    isConcurrencySafe: () => true,
    timeoutMs: 180_000,
    async execute(args, exec) {
      const resolved = await tools()
      const input = await locateInput(args.path, config)
      const probed = await probe(resolved, input.path)
      const summary = summariseProbe(probed)
      const imageLike = isImageLike(summary)
      if (!imageLike && classify(summary) !== 'video') throw new Error(`${args.path} 既不是视频也不是图片，无法取帧。`)

      const time = imageLike ? 0 : Math.max(0, Number.isFinite(args.time) ? args.time : 0)
      if (!imageLike && Number.isFinite(summary.duration) && time > summary.duration) {
        throw new Error(`时间点 ${formatTimecode(time)} 超出视频时长 ${formatTimecode(summary.duration)}`)
      }

      const outDir = await artifactDir(input.path, args.output_dir ?? config.outputDir)
      const workDir = await makeWorkDir('media-senses-frame')
      try {
        const frame = await analyzeFrame({
          tools: resolved,
          file: input.path,
          time,
          workDir,
          outputDir: outDir,
          isImage: imageLike,
          signal: exec?.signal,
          options: { maxWidth: Math.min(Math.max(Number.isInteger(args.max_width) ? args.max_width : 960, 240), 1920) },
        })
        const report = renderFrameReport(frame, { file: input.path, time, imagePath: frame.imagePath, isImage: imageLike })
        const images = await inlineImages(exec, [{ path: frame.imagePath, name: imageLike ? 'media-senses-image.jpg' : 'media-senses-frame.jpg' }])
        return {
          kind: imageLike ? 'image' : 'video-frame',
          file: input.path,
          time_seconds: time,
          image_path: frame.imagePath ?? null,
          image_bytes: frame.imageBytes ?? 0,
          brightness: frame.summary?.brightness ?? null,
          saturation: frame.summary?.saturation ?? null,
          edge_density: frame.summary?.edgeDensity ?? null,
          images,
          report,
        }
      } finally {
        await removeWorkDir(workDir)
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Inspect frame of ${args.path}`, kind: 'read', locations: [{ path: String(args.path) }] }
    },
  })

  /* ---------------------------------------------------------- media_whisper */

  ctx.tools.register({
    name: 'media_whisper',
    description:
      '管理本地语音转写模型（ffmpeg 内置 whisper）：查看状态、下载模型、删除模型。' +
      '媒体分析默认用 tiny 模型（约 74MB，首次自动下载）；想更准可下载 base（约 141MB）或 small（约 466MB）。\n' +
      'Manage the local whisper speech model used by the video/audio tools: status, download, remove. ' +
      'tiny is the default (~74MB); base/small are more accurate but slower.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'download', 'remove'], description: 'status 查看，download 下载，remove 删除。' },
        size: { type: 'string', enum: ['tiny', 'base', 'small'], description: '模型规格，默认取插件配置（tiny）。' },
      },
      required: ['action'],
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderTextAndImages,
    },
    isConcurrencySafe: () => false,
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      const resolved = await tools()
      const size = args.size ?? config.whisperModel ?? 'tiny'
      if (size === 'off') throw new Error('插件配置里 whisperModel=off，本地转写已关闭；如需转写请把配置改为 tiny/base/small。')
      const support = await whisperSupport(resolved)
      const lines = []
      if (args.action === 'status') {
        const inventory = await modelInventory(config.modelDir)
        lines.push('# 本地语音转写模型状态')
        lines.push('')
        lines.push(`ffmpeg whisper 滤镜: ${support.supported ? '可用' : `不可用（${support.reason}）`}`)
        lines.push(`模型目录: \`${join(asrBaseDir(config.modelDir), 'models')}\``)
        lines.push('')
        for (const entry of inventory) {
          lines.push(`- ${entry.size}: ${entry.present ? `已下载 ${formatBytes(entry.bytes)}` : '未下载'} (\`${entry.path}\`)`)
        }
        const note = support.supported ? '可直接分析并转写语音。' : '当前 ffmpeg 缺少 whisper 滤镜，转写会被跳过。'
        lines.push('')
        lines.push(note)
        return { action: 'status', supported: support.supported, models: inventory, report: lines.join('\n') }
      }
      if (args.action === 'download') {
        const startedAt = Date.now()
        const model = await ensureModel({ size, baseDir: config.modelDir, signal: exec?.signal })
        const seconds = Math.round((Date.now() - startedAt) / 100) / 10
        lines.push(`# 已${model.downloaded ? '下载' : '确认存在'} whisper ${size} 模型`)
        lines.push('')
        lines.push(`- 路径: \`${model.path}\``)
        lines.push(`- 大小: ${formatBytes(model.bytes)}`)
        lines.push(`- 耗时: ${seconds} 秒`)
        return { action: 'download', size, path: model.path, bytes: model.bytes, downloaded: model.downloaded, report: lines.join('\n') }
      }
      const { removeModel } = await import('./lib/asr.js')
      await removeModel(size, config.modelDir)
      return { action: 'remove', size, report: `已删除 whisper ${size} 模型缓存。` }
    },
    presentCall(args) {
      return { card: 'generic', title: `Whisper model ${args.action}`, kind: 'execute' }
    },
  })

  /* ----------------------------------------------------------- media_corpus */

  ctx.tools.register({
    name: 'media_corpus',
    description:
      '批量看片并提炼「这个品类是怎么做的」：给一个文件夹/清单/URL 列表，逐条分析镜头节奏、转场、运镜、调色、卡点、钩子与声音，' +
      '再聚合出风格画像（STYLE-PROFILE.md）、仿制清单和一份可直接改写的 RenderPlan 骨架。带缓存，重复跑只会分析新文件。\n' +
      'Learn a genre from many reference videos: analyse a folder, manifest or URL list, then aggregate a style profile ' +
      '(cut rhythm, transitions, camera motion, grading, beat sync, hooks, sound) plus a concrete reproduction checklist and a ' +
      'RenderPlan skeleton you can adapt. Results are cached per file, so re-runs only analyse new videos. Use this before ' +
      'media_build_video when the goal is "make more videos like these".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: '文件夹路径、清单文件（.txt 每行一条 / .json / .jsonl）或单个视频路径。' },
        paths: { type: 'array', items: { type: 'string' }, description: '额外的本地视频路径列表。' },
        urls: { type: 'array', items: { type: 'string' }, description: '要下载的媒体 URL（直链；装了 yt-dlp 时支持站点链接）。请自行确认版权与站点条款。' },
        output_dir: { type: 'string', description: '语料目录（缓存/分析结果/画像都写这里）；默认 ~/.dsh/media-senses/corpus。' },
        name: { type: 'string', description: '这批语料的名字，用于画像标题。' },
        max_videos: { type: 'integer', description: '最多分析多少条（默认 24，越大越慢）。' },
        fast: { type: 'boolean', description: '快速模式（少抽关键帧、不生成联系表），默认 true。' },
        include_transcript: { type: 'boolean', description: '是否逐条语音转写（很慢，默认 false）。' },
        language: { type: 'string', description: '转写语种。' },
        reuse_cache: { type: 'boolean', description: '复用已分析过的文件（按路径+大小+mtime），默认 true。' },
        max_seconds: { type: 'number', description: '单条视频最多分析多少秒（默认 180）。' },
      },
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderTextAndImages,
    },
    isConcurrencySafe: () => false,
    timeoutMs: 2_400_000,
    async execute(args, exec) {
      const resolved = await tools()
      const startedAt = Date.now()
      const notes = []
      const corpusDir = isAbsolute(args.output_dir ?? '')
        ? args.output_dir
        : args.output_dir !== undefined
          ? resolve(process.cwd(), args.output_dir)
          : join(asrBaseDir(config.modelDir), 'corpus')
      await mkdir(corpusDir, { recursive: true })

      // 1. Resolve local files and remote URLs.
      const sources = []
      if (typeof args.source === 'string' && args.source.trim().length > 0) sources.push(args.source.trim())
      if (Array.isArray(args.paths)) sources.push(...args.paths.filter((value) => typeof value === 'string'))
      let expanded = { files: [], urls: [], warnings: [] }
      if (sources.length > 0) expanded = await expandSource(sources)
      const urls = [...expanded.urls]
      if (Array.isArray(args.urls)) urls.push(...args.urls.filter((value) => typeof value === 'string' && value.trim().length > 0))

      let ingest
      if (urls.length > 0) {
        ingest = await ingestUrls({ tools: resolved, urls, dir: join(corpusDir, 'raw'), signal: exec?.signal })
        for (const warning of ingest.warnings) notes.push(warning)
      }

      const videoPaths = [...expanded.files, ...(ingest?.files ?? [])]
      if (videoPaths.length === 0) {
        throw new Error('没有找到可分析的视频：请提供 source（文件夹/清单）、paths 或 urls；报告里的 warnings 会说明哪些路径无效。')
      }

      // 2. Analyse every video (cached).
      const corpus = await analyzeCorpus({
        tools: resolved,
        root: corpusDir,
        videos: videoPaths.map((path) => ({ path })),
        maxVideos: Number.isInteger(args.max_videos) ? args.max_videos : 24,
        fast: args.fast !== false,
        includeTranscript: args.include_transcript === true,
        language: args.language,
        maxSeconds: Number.isFinite(args.max_seconds) ? args.max_seconds : 180,
        reuseCache: args.reuse_cache !== false,
        whisperModel: config.whisperModel,
        modelDir: config.modelDir,
        signal: exec?.signal,
        onProgress: (progress) => {
          if (progress.done === progress.total) console.log(`[media-senses] corpus ${progress.done}/${progress.total}`)
        },
      })

      if (corpus.entries.length === 0) {
        throw new Error(`所有候选视频都分析失败了。${[...notes, ...corpus.warnings].slice(0, 6).join('；')}`)
      }

      // 3. Aggregate the style profile.
      for (const warning of corpus.warnings) notes.push(warning)
      const profileName = typeof args.name === 'string' && args.name.trim().length > 0 ? args.name.trim() : (corpusDir.split(/[\\/]/u).pop() || '语料')
      const { profile } = buildStyleProfile(corpus.entries, { name: profileName })
      const profileJsonPath = join(corpusDir, 'style-profile.json')
      await writeFile(profileJsonPath, JSON.stringify(profile, undefined, 2), 'utf8')
      const profileMdPath = join(corpusDir, 'STYLE-PROFILE.md')
      const report = renderCorpusReport({
        profile,
        corpus: { ...corpus, warnings: [...corpus.warnings, ...notes] },
        profilePath: profileMdPath,
        ingest,
      })
      await writeFile(profileMdPath, report, 'utf8')

      const elapsed = Math.round((Date.now() - startedAt) / 100) / 10
      return {
        kind: 'corpus',
        corpus_dir: corpusDir,
        count: profile.count,
        skipped: corpus.skipped,
        failed: corpus.failed,
        total_seconds: profile.totalSeconds,
        profile_path: profileJsonPath,
        markdown_path: profileMdPath,
        render_plan_skeleton: profile.reproduction?.brief?.plan ?? null,
        elapsed_seconds: elapsed,
        report,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Learn corpus ${args.name ?? args.source ?? ''}`, kind: 'read' }
    },
  })

  /* ------------------------------------------------------ media_build_video */

  ctx.tools.register({
    name: 'media_build_video',
    description:
      '按 JSON 渲染计划（RenderPlan）合成一支视频：文字卡（中文字体/淡入）、图片 Ken Burns 推拉、渐变/纯色场景、' +
      'xfade 转场、烧字幕、背景音乐、旁白（可直接给文字让它用本地 TTS 念）、EBU R128 响度归一化。这是「仿制」的执行器。\n' +
      'Render a finished MP4 from a JSON RenderPlan: text cards (Chinese fonts, fade-in), Ken Burns image moves, gradient/colour ' +
      'scenes, xfade transitions, burned captions, music bed, narration (either audio files or plain text synthesized locally) and ' +
      'EBU R128 loudness normalisation. This is the tool that actually produces the video when you are reproducing a style.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: { type: 'object', description: 'RenderPlan 对象（字段见 media_corpus 返回的骨架）。' },
        plan_path: { type: 'string', description: '或者给一个包含 RenderPlan 的 JSON 文件路径。' },
        output: { type: 'string', description: '覆盖计划里的输出路径（建议绝对路径）。' },
        verify: { type: 'boolean', description: '渲染后自动用 media_watch_video 的同一套分析复核成片，默认 true。' },
        targets: { type: 'object', description: '可选的对照目标（如 style-profile.json 里的 reproduction.targets），用于报告里对比差距。' },
      },
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderTextAndImages,
    },
    isConcurrencySafe: () => false,
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      const resolved = await tools()
      let plan = args.plan
      if ((plan === undefined || plan === null) && typeof args.plan_path === 'string') {
        const planPath = isAbsolute(args.plan_path) ? args.plan_path : resolve(process.cwd(), args.plan_path)
        plan = JSON.parse(await readFile(planPath, 'utf8'))
      }
      if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
        throw new Error('缺少渲染计划：请提供 plan（对象）或 plan_path（JSON 文件路径）')
      }
      plan = { ...plan }
      if (typeof args.output === 'string' && args.output.trim().length > 0) plan.output = args.output.trim()
      if (typeof plan.output !== 'string' || plan.output.trim().length === 0) {
        plan.output = join(asrBaseDir(config.modelDir), 'output', `media-${Date.now()}.mp4`)
      } else if (!isAbsolute(plan.output)) {
        plan.output = resolve(process.cwd(), plan.output)
      }
      if (Array.isArray(plan.scenes) && plan.scenes.length === 0) throw new Error('RenderPlan.scenes 为空，至少需要一个场景')

      const { buildVideo } = await import('./lib/build.js')
      const workDir = await makeWorkDir('media-senses-build')
      const startedAt = Date.now()
      try {
        const result = await buildVideo({ tools: resolved, plan, workDir, signal: exec?.signal })
        const notes = []
        let verify = null
        let verifyError
        if (args.verify !== false) {
          try {
            const verifyWorkDir = await makeWorkDir('media-senses-verify')
            try {
              const analysis = await analyzeVideo({
                tools: resolved,
                file: result.output,
                workDir: verifyWorkDir,
                options: { maxKeyframes: 8, wantContactSheet: false, wantFrames: true, wantAudio: true, artifactDir: join(workDir, 'verify') },
                signal: exec?.signal,
                analyzeAudio,
              })
              let craft = null
              try {
                const { analyzeCraft } = await import('./lib/craft.js')
                craft = (await analyzeCraft({ tools: resolved, file: result.output, workDir: verifyWorkDir, analysis, artifactDir: join(workDir, 'verify'), options: {}, signal: exec?.signal }))?.craft ?? null
              } catch (error) {
                notes.push(`技法复核不可用：${error instanceof Error ? error.message : String(error)}`)
              }
              verify = {
                shots: analysis.shots?.length ?? 0,
                duration: analysis.duration,
                brightness: analysis.global?.avgBrightness,
                motion: analysis.global?.avgMotion,
                bpm: analysis.audio?.tempo?.bpm ?? null,
                craft,
              }
            } finally {
              await removeWorkDir(verifyWorkDir)
            }
          } catch (error) {
            verifyError = error instanceof Error ? error.message : String(error)
          }
        }
        const report = renderBuildReport(result, { plan, verify, verifyError, targets: args.targets })
        return {
          kind: 'build',
          output: result.output,
          duration_seconds: result.duration,
          width: result.width,
          height: result.height,
          fps: result.fps,
          bytes: result.bytes,
          render_seconds: result.renderSeconds,
          verified: verify !== null,
          verify,
          elapsed_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
          report,
        }
      } finally {
        await removeWorkDir(workDir)
      }
    },
    presentCall(args) {
      return { card: 'generic', title: 'Build video from RenderPlan', kind: 'execute' }
    },
  })

  /* ---------------------------------------------------------------- media_tts */

  ctx.tools.register({
    name: 'media_tts',
    description:
      '用本机 Windows 语音（zh-CN 女声「Microsoft Huihui」/ en-US「Microsoft Zira」）把文字合成为 wav 旁白，' +
      '可调语速。用于给仿制视频配音，也可以直接交给 media_build_video 的 audio.voiceover。\n' +
      'Synthesize narration locally with the Windows SAPI voices (zh-CN Huihui, en-US Zira) into a wav file, with adjustable rate. ' +
      'Use it for voiceover in a reproduced video, or pass the resulting file to media_build_video.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要朗读的文本（支持中文）。' },
        voice: { type: 'string', description: "zh / en / 'auto' 或完整声部名，默认 zh。" },
        rate: { type: 'number', description: '语速倍率 0.5–2.0，默认 1.0。' },
        output_path: { type: 'string', description: 'wav 输出路径；省略时写到 ~/.dsh/media-senses/output。' },
      },
      required: ['text'],
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderTextAndImages,
    },
    isConcurrencySafe: () => true,
    timeoutMs: 240_000,
    async execute(args, exec) {
      const resolved = await tools()
      const text = String(args.text ?? '').trim()
      if (text.length === 0) throw new Error('text 不能为空')
      const { synthesizeSpeech } = await import('./lib/tts.js')
      const outputPath = typeof args.output_path === 'string' && args.output_path.trim().length > 0
        ? (isAbsolute(args.output_path) ? args.output_path : resolve(process.cwd(), args.output_path))
        : join(asrBaseDir(config.modelDir), 'output', `tts-${Date.now()}.wav`)
      await mkdir(dirname(outputPath), { recursive: true })
      const info = await synthesizeSpeech({
        tools: resolved,
        text,
        outputPath,
        voice: typeof args.voice === 'string' && args.voice.trim().length > 0 ? args.voice.trim() : 'zh',
        rate: Number.isFinite(args.rate) ? args.rate : 1,
        workDir: join(asrBaseDir(config.modelDir), 'tts-work'),
        signal: exec?.signal,
      })
      if (info.ok !== true) throw new Error(`旁白合成失败：${(info.warnings ?? []).join('；') || '未知原因'}`)
      const report = renderTtsReport(info, { text })
      return { kind: 'tts', path: info.path, seconds: info.seconds, voice: info.voice, images: [], report }
    },
    presentCall(args) {
      return { card: 'generic', title: `Synthesize narration`, kind: 'execute' }
    },
  })

  /* --------------------------------------------------------------- media_styles */

  ctx.tools.register({
    name: 'media_styles',
    description:
      '检索本机的代码动画风格库（code-animation-prompts 技能：341 个风格、196 张参考静帧）。' +
      '可以按气质搜索（水墨/粒子/霓虹/极简/赛博…）、按系列筛选、或直接按编号取用完整提示词与参考静帧。' +
      '拿到提示词后写一个实现 `window.renderAt(t)` 的 HTML，再用 media_animate 渲成片段。\n' +
      'Search the local code-animation style library (341 style prompts, 196 reference stills): free-text mood search, ' +
      'series filter, or fetch one style by id including its full prompt and reference still. Then author an HTML animation ' +
      'implementing window.renderAt(t) and render it with media_animate.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['search', 'show', 'list'], description: 'search 搜索 / show 取某个编号的完整提示词 / list 列出系列。默认 search。' },
        query: { type: 'string', description: '气质词或编号（如「水墨」「粒子」「B3」）。' },
        id: { type: 'string', description: 'show 时精确指定的风格编号（如 A1）。' },
        series: { type: 'string', description: '系列筛选：AG / M / K / Z / H / L / V / X / O / R。' },
        limit: { type: 'integer', description: '返回条数上限（默认 8，最多 50）。' },
      },
    },
    output: { schema: TEXT_OUTPUT_SCHEMA, render: renderTextAndImages },
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const skillDir = resolveSkillDir(config.skillDir)
      const action = args.action === 'show' || args.action === 'list' ? args.action : 'search'
      let payload
      let images = []
      if (action === 'list') {
        payload = { action, skillDir, series: await seriesOverview(skillDir) }
      } else if (action === 'show') {
        const id = typeof args.id === 'string' && args.id.trim().length > 0 ? args.id.trim() : String(args.query ?? '').trim()
        const style = await getStyle(skillDir, id)
        if (style === undefined) throw new Error(`风格库中没有编号「${id}」；先用 action:"search" 找编号，或 action:"list" 看系列。`)
        payload = { action, skillDir, style, query: id }
        if (typeof style.imagePath === 'string') images = await inlineImages(exec, [{ path: style.imagePath, name: `style-${style.entry.id ?? id}.jpg` }])
      } else {
        payload = {
          action,
          skillDir,
          query: args.query,
          entries: await searchStyles({ skillDir, query: args.query, series: args.series, limit: args.limit }),
        }
      }
      const report = renderStylesReport(payload)
      return {
        kind: 'styles',
        action,
        skill_dir: skillDir,
        count: Array.isArray(payload.entries) ? payload.entries.length : payload.style === undefined ? 0 : 1,
        starter: starterPath(skillDir),
        images,
        report,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Style library ${args.action ?? 'search'}`, kind: 'read' }
    },
  })

  /* -------------------------------------------------------------- media_animate */

  ctx.tools.register({
    name: 'media_animate',
    description:
      '把一段代码动画（HTML + Canvas/SVG/CSS/Three.js）逐帧渲染成 MP4 片段。页面必须实现 `window.renderAt(t)`：' +
      '画面完全由秒数 t 决定，`?export=1` 时停止自己的 rAF/CSS 自播放，随机数用固定种子。' +
      '用本机 headless Edge + CDP 逐帧截图后用 ffmpeg 编码，无需安装 Playwright。渲染出的片段可以交给 media_build_video 作为 video 场景拼接。\n' +
      'Render an HTML/Canvas/CSS/Three.js animation into an MP4 segment frame-by-frame. The page must implement ' +
      '`window.renderAt(t)` (deterministic from t, no self-driven rAF when loaded with ?export=1, seeded randomness). ' +
      'Drives headless Edge over CDP and encodes with ffmpeg — no Playwright install needed. The segment can be spliced ' +
      'into media_build_video as a video scene.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        html_path: { type: 'string', description: '实现 renderAt 的 HTML 文件路径（绝对路径）。' },
        html: { type: 'string', description: '也可以直接给 HTML 源码（会写到临时文件后渲染）。' },
        output: { type: 'string', description: '输出 MP4 路径；省略时写到 ~/.dsh/media-senses/output。' },
        width: { type: 'integer', description: '宽（偶数），默认 1920。' },
        height: { type: 'integer', description: '高（偶数），默认 1080。' },
        fps: { type: 'integer', description: '帧率，默认 30。' },
        duration: { type: 'number', description: '时长（秒），默认 12，上限由配置 animateMaxSeconds 决定。' },
        style_id: { type: 'string', description: '可选：所用的风格编号，写进报告便于追溯。' },
      },
    },
    output: { schema: TEXT_OUTPUT_SCHEMA, render: renderTextAndImages },
    isConcurrencySafe: () => false,
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      const resolved = await tools()
      const { renderAnimation } = await import('./lib/htmlrender.js')
      const workDir = await makeWorkDir('media-senses-animate')
      let previewPath
      try {
        let htmlPath
        if (typeof args.html_path === 'string' && args.html_path.trim().length > 0) {
          htmlPath = isAbsolute(args.html_path) ? args.html_path : resolve(process.cwd(), args.html_path)
        } else if (typeof args.html === 'string' && args.html.trim().length > 0) {
          htmlPath = join(workDir, 'animation.html')
          await writeFile(htmlPath, args.html, 'utf8')
        } else {
          throw new Error('需要 html_path 或 html；HTML 必须实现 window.renderAt(t)')
        }
        const output = typeof args.output === 'string' && args.output.trim().length > 0
          ? (isAbsolute(args.output) ? args.output : resolve(process.cwd(), args.output))
          : join(asrBaseDir(config.modelDir), 'output', `anim-${Date.now()}.mp4`)
        await mkdir(dirname(output), { recursive: true })
        const width = Number.isInteger(args.width) ? args.width : 1920
        const height = Number.isInteger(args.height) ? args.height : 1080
        const fps = Number.isInteger(args.fps) ? Math.min(Math.max(args.fps, 10), 60) : 30
        const duration = Math.min(
          Number.isFinite(args.duration) ? Math.max(0.5, args.duration) : 12,
          config.animateMaxSeconds,
        )
        const result = await renderAnimation({
          tools: resolved,
          htmlPath,
          output,
          width,
          height,
          fps,
          duration,
          workDir,
          browserPath: config.browserPath,
          signal: exec?.signal,
        })
        // A preview still makes the generation loop visual: the model can look at
        // a representative frame immediately instead of opening the mp4.
        previewPath = join(workDir, 'preview.jpg')
        await run(resolved.ffmpeg, ['-v', 'error', '-y', '-ss', String(Math.max(0, duration * 0.4)), '-i', output, '-frames:v', '1', '-q:v', '3', previewPath], { cwd: workDir })
        const images = await inlineImages(exec, [{ path: previewPath, name: 'animation-preview.jpg' }])
        const report = renderAnimateReport(result, { styleId: args.style_id, htmlPath, previewPath })
        return {
          kind: 'animate',
          output: result.output,
          duration_seconds: result.duration,
          width: result.width,
          height: result.height,
          fps: result.fps,
          frames: result.frames,
          bytes: result.bytes,
          render_seconds: result.renderSeconds,
          images,
          report,
        }
      } finally {
        await removeWorkDir(workDir)
      }
    },
    presentCall(args) {
      return { card: 'generic', title: 'Render HTML animation to MP4', kind: 'execute' }
    },
  })

  /* ------------------------------------------------------------- media_see */

  ctx.tools.register({
    name: 'media_see',
    description:
      '「看屏幕」：抓取当前屏幕（或指定区域）给你看。peek = 截一张当下画面并给出亮度/色相图与构图判断；' +
      'watch = 采几秒钟，用「变化量」筛选出真正值得看的几帧（切画面/持续滚动/兜底），拼成一张 token 友好的拼图，' +
      '并列出每帧的时间与变化分。用于「帮我看看现在屏幕上是什么」「跟着我操作」「检查界面有没有报错」。\n' +
      'Look at the live screen: `peek` captures the current screen and reports luminance/hue art and composition; ' +
      '`watch` samples a few seconds, keeps only the frames whose picture actually changed (cuts / accumulated motion / ' +
      'fallback), and packs them into one token-efficient sheet with per-frame timestamps and change scores. ' +
      'Use it for "what is on my screen", "follow along while I work", "did the UI throw an error".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['peek', 'watch', 'status'], description: 'peek 截一张 / watch 采几秒并按变化挑帧 / status 查采集能力。默认 peek。' },
        seconds: { type: 'number', description: 'watch 的采样时长（秒，默认 6，最多 20）。' },
        fps: { type: 'integer', description: '采样帧率（默认 12）。' },
        quality: { type: 'string', enum: ['low', 'standard', 'high'], description: '画质档：low≈800px / standard≈1050 / high≈1260 长边。' },
        region: { type: 'string', description: '只看一块：屏幕物理像素 "x,y,w,h"，或 "off" 取消。' },
        max_frames: { type: 'integer', description: 'watch 最多保留几帧（默认 6，最多 12）。' },
        output_dir: { type: 'string', description: '截图与拼图的输出目录。' },
      },
    },
    output: { schema: TEXT_OUTPUT_SCHEMA, render: renderTextAndImages },
    isConcurrencySafe: () => false,
    timeoutMs: 180_000,
    async execute(args, exec) {
      if (config.allowScreenCapture === false) throw new Error('插件配置里 allowScreenCapture=false，屏幕采集已关闭')
      const action = args.action === 'watch' || args.action === 'status' ? args.action : 'peek'
      const resolved = await tools()
      const longEdge = { low: 800, standard: 1050, high: 1260 }[args.quality ?? config.screenQuality] ?? 800
      const outDir = isAbsolute(args.output_dir ?? '') ? args.output_dir : join(asrBaseDir(config.modelDir), 'screen')

      const screenMod = await import('./lib/screen.js').catch(() => undefined)
      if (screenMod === undefined) throw new Error('屏幕采集模块不可用（lib/screen.js 未安装）')

      if (action === 'status') {
        const sources = await screenMod.listSources({ tools: resolved }).catch((error) => ({ screen: false, engines: [], warnings: [error.message] }))
        const plan = screenMod.planSheet({ frameCount: 6, sourceWidth: 16, sourceHeight: 9, quality: args.quality ?? config.screenQuality })
        const changeMod = await import('./lib/change.js').catch(() => undefined)
        const report = renderSeeReport({
          action: 'status',
          screenSupported: sources.screen === true,
          engines: sources.engines,
          quality: args.quality ?? config.screenQuality,
          longEdge,
          changeAvailable: changeMod !== undefined,
          tokenEstimate: plan?.tokenEstimate,
          warnings: sources.warnings,
        })
        return { kind: 'see', action, screen_supported: sources.screen === true, report }
      }

      await mkdir(outDir, { recursive: true })
      const workDir = await makeWorkDir('media-senses-see')
      let imagePath
      try {
        if (action === 'peek') {
          const captured = await screenMod.captureFrames({ tools: resolved, workDir, options: { seconds: 0, width: longEdge, region: args.region, source: 'screen', outputDir: outDir }, signal: exec?.signal })
          const framePath = captured.frames?.[0]?.path
          if (typeof framePath !== 'string') throw new Error('屏幕采集没有产出画面（可能是锁屏 / UAC 安全桌面 / 远程桌面）')
          const frame = await analyzeFrame({ tools: resolved, file: framePath, time: 0, workDir, outputDir: outDir, isImage: true, signal: exec?.signal })
          imagePath = frame.imagePath ?? framePath
          const images = await inlineImages(exec, [{ path: imagePath, name: 'media-senses-screen.png' }])
          const report = renderSeeReport({
            action: 'peek',
            engine: captured.engine,
            width: captured.width ?? frame.summary?.width,
            height: captured.height ?? frame.summary?.height,
            elapsedMs: captured.elapsedMs,
            region: args.region,
            summary: frame.summary,
            ascii: frame.ascii,
            layout: frame.summary?.layout,
          })
          return { kind: 'see', action, image_path: imagePath, images, report }
        }

        // watch: sample → change-score → keep the informative frames → pack.
        const seconds = Math.min(Number.isFinite(args.seconds) ? Math.max(1, args.seconds) : 6, 20)
        const fps = Math.min(Math.max(Number.isInteger(args.fps) ? args.fps : 12, 2), 20)
        const captured = await screenMod.captureFrames({ tools: resolved, workDir, options: { seconds, fps, width: longEdge, region: args.region, source: 'screen', outputDir: join(workDir, 'frames') }, signal: exec?.signal })
        const ordered = Array.isArray(captured.frames) ? captured.frames : []
        if (ordered.length === 0) throw new Error('屏幕采集没有产出任何帧')

        let selected = []
        let scored
        let scoreError
        const changeMod = await import('./lib/change.js').catch(() => undefined)
        if (changeMod !== undefined) {
          scored = await changeMod.scoreVideo({
            tools: resolved,
            file: await encodeFrameSequence(resolved, ordered.map((frame) => frame.path), workDir, fps),
            workDir,
            options: { fps },
            signal: exec?.signal,
          }).catch((error) => {
            scoreError = error instanceof Error ? error.message : String(error)
            return undefined
          })
          if (scored !== undefined) {
            const picked = changeMod.selectFrames(scored.frames, { fps: scored.fps, maxFrames: Math.min(Number.isInteger(args.max_frames) ? args.max_frames : 6, 12) })
            selected = picked.selected.map((item) => ({ ...item, path: ordered[item.index]?.path, sourceTime: ordered[item.index]?.time ?? item.time })).filter((item) => typeof item.path === 'string')
          }
        }
        if (selected.length === 0) {
          // Fallback: evenly spaced frames from what was captured.
          const budget = Math.min(Number.isInteger(args.max_frames) ? args.max_frames : 6, ordered.length)
          const step = Math.max(1, Math.floor(ordered.length / budget))
          selected = ordered.filter((_, index) => index % step === 0).slice(0, budget).map((frame, index) => ({ index, time: frame.time ?? 0, reason: 'fallback', score: null, path: frame.path }))
        }

        const plan = screenMod.planSheet({ frameCount: selected.length, sourceWidth: captured.width ?? 16, sourceHeight: captured.height ?? 9, quality: args.quality ?? config.screenQuality })
        const sheet = await screenMod.buildSheet({
          frames: selected.map((item) => ({ path: item.path })),
          width: plan.canvasWidth,
          height: plan.canvasHeight,
          columns: plan.columns,
          outputPath: join(outDir, `sheet-${Date.now()}.png`),
        })
        imagePath = sheet.pngPath ?? sheet.path
        const images = imagePath === undefined ? [] : await inlineImages(exec, [{ path: imagePath, name: 'media-senses-screen-sheet.png' }])
        const report = renderSeeReport({
          action: 'watch',
          seconds,
          engine: captured.engine,
          width: captured.width,
          height: captured.height,
          elapsedMs: captured.elapsedMs,
          region: args.region,
          frameCount: ordered.length,
          kept: selected.length,
          selectionRule: scored === undefined ? '均匀采样' : '变化量（切点 + 积分）',
          changeError: scoreError,
          columns: plan.columns,
          rows: plan.rows,
          sheetWidth: plan.canvasWidth,
          sheetHeight: plan.canvasHeight,
          tokenEstimate: plan.tokenEstimate,
          shots: selected.map((item) => ({ time: item.sourceTime ?? item.time, score: item.score, reason: item.reason })),
          changes: scored === undefined ? [] : summarizeChangeLog(selected),
        })
        return {
          kind: 'see',
          action,
          frame_count: ordered.length,
          kept: selected.length,
          sheet_path: imagePath ?? null,
          token_estimate: plan.tokenEstimate,
          shots: selected.map((item) => ({ time: Math.round((item.sourceTime ?? item.time) * 100) / 100, score: item.score, reason: item.reason })),
          images,
          report,
        }
      } finally {
        await removeWorkDir(workDir)
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `See ${args.action ?? 'peek'}`, kind: 'read' }
    },
  })

  /* --------------------------------------------------------------- helpers */

  /**
   * Encode an ordered PNG sequence into a small MP4 so the change scorer can
   * read it in one pass (it takes a media file, not a frame list).
   */
  async function encodeFrameSequence(resolved, paths, workDir, fps) {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('no frames to encode')
    const staging = join(workDir, 'seq')
    await mkdir(staging, { recursive: true })
    for (let index = 0; index < paths.length; index += 1) {
      const target = join(staging, `f${String(index).padStart(5, '0')}.png`)
      await copyFile(paths[index], target)
    }
    const output = join(workDir, 'seq.mp4')
    await run(resolved.ffmpeg, ['-v', 'error', '-y', '-framerate', String(fps), '-i', 'f%05d.png', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', output], { cwd: staging, timeoutMs: 240_000 })
    return output
  }

  /** Human-readable "what changed" lines for the kept frames. */
  function summarizeChangeLog(selected) {
    const reasonZh = { cut: '画面切换', integrated: '持续运动', fallback: '兜底采样' }
    return selected
      .filter((item) => item.reason !== 'fallback')
      .slice(0, 12)
      .map((item) => `${formatTimecode(item.sourceTime ?? item.time)} · ${reasonZh[item.reason] ?? item.reason}${Number.isFinite(Number(item.score)) ? ` · 变化分 ${Math.round(item.score)}` : ''}`)
  }


  /**
   * Attach a rendered image to the tool result when the *current model route*
   * declares image input.
   *
   * This mirrors the capability gate of the built-in `read_image` tool: the
   * plugin must never emit an image block for a text-only route. Any failure
   * (no attachment store, no llm service, unsupported media type, oversized
   * image) simply degrades to "the file path is in the report".
   *
   * @param {object} exec tool run context
   * @param {string|undefined} filePath absolute image path
   * @param {string} name attachment display name
   * @returns {Promise<object|undefined>} an attachment reference usable as an image block
   */
  async function inlineImage(exec, filePath, name) {
    if (config.embedImages === false) return undefined
    if (typeof filePath !== 'string' || filePath.length === 0) return undefined
    try {
      const attachments = ctx.get('attachments')
      const llm = ctx.get('llm')
      if (attachments === undefined || llm === undefined) return undefined
      const routed = exec?.agent?.session?.requestHeader?.()?.config
      const provider = routed?.provider ?? exec?.agent?.options?.provider
      const model = routed?.model ?? exec?.agent?.options?.model
      if (typeof provider !== 'string' || typeof model !== 'string') return undefined
      const info = await llm.resolveModelInfo(provider, model, exec?.signal)
      if (!Array.isArray(info?.inputModalities) || !info.inputModalities.includes('image')) return undefined
      const data = await readFile(filePath)
      const limits = attachments.imageLimits
      if (typeof limits?.maxImageBytes === 'number' && data.length > limits.maxImageBytes) return undefined
      if (Array.isArray(limits?.mediaTypes) && !limits.mediaTypes.includes('image/png')) return undefined
      const ref = await attachments.saveImage({ data, mediaType: 'image/png', name })
      return {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      }
    } catch {
      // Attaching an image is a bonus; never fail the analysis because of it.
      return undefined
    }
  }

  /** Collect the attachment references for a list of artifact paths. */
  async function inlineImages(exec, entries) {
    const images = []
    for (const entry of entries) {
      const ref = await inlineImage(exec, entry.path, entry.name)
      if (ref !== undefined) images.push(ref)
    }
    return images
  }

  /**
   * Lazily obtain a transcript, downloading the model on first use.
   * Never throws: transcription problems become report notes.
   */
  async function maybeTranscribe(options) {
    const { notes } = options
    try {
      const support = await whisperSupport(options.resolved)
      if (!support.supported) {
        notes.push(support.reason ?? 'whisper 不可用，已跳过语音转写')
        return null
      }
      const size = config.whisperModel === 'off' ? 'tiny' : config.whisperModel
      const model = await ensureModel({ size, baseDir: config.modelDir, signal: options.signal })
      if (model.downloaded === true) notes.push(`首次使用已下载 whisper ${size} 模型（${formatBytes(model.bytes)}，缓存于 ${model.path}）`)
      const transcript = await transcribe({
        tools: options.resolved,
        file: options.file,
        modelPath: model.path,
        baseDir: config.modelDir,
        language: options.language,
        start: options.start,
        duration: config.asrMaxSeconds,
        maxSeconds: config.asrMaxSeconds,
        signal: options.signal,
      })
      if (Array.isArray(transcript.warnings)) for (const warning of transcript.warnings) notes.push(warning)
      return transcript
    } catch (error) {
      notes.push(`语音转写失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
}





