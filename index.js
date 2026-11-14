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
import { renderAudioReport, renderFrameReport, renderProbeReport, renderVideoReport, tidy } from './lib/render.js'
import { renderAnimateReport, renderBuildReport, renderChangeSection, renderCorpusReport, renderCraftSection, renderSeeReport, renderStylesReport, renderTtsReport, renderVocabularyReport } from './lib/render-v2.js'
import { getStyle, resolveSkillDir, searchStyles, seriesOverview, starterPath } from './lib/styles.js'
import { attachImages, detectVision, profileWidth, sampleTimes, VISION_PROFILES } from './lib/vision.js'
import { renderCompareReport, renderFramesReport } from './lib/render-vision.js'

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
  visionMode: 'auto',
  visionImageProfile: 'balanced',
  visionMaxImages: 4,
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
        mode: { type: 'string', enum: ['auto', 'blind', 'vision'], description: '呈现模式：auto 按当前模型能力自动选择（默认）；blind 只给文本；vision 以图为主。' },
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

        // Vision target: when the current model can see, lead with pictures and an
        // index instead of ASCII art. The filmstrip gives temporal order that a
        // contact sheet loses; the contact sheet still shows every shot.
        const vision = await visionFor(exec, args)
        const target = targetOf(vision)
        const imagePlan = []
        const imageEntries = []
        const shotsForPlan = Array.isArray(analysis.shots) ? analysis.shots : []
        if (target === 'vision' && shotsForPlan.length > 0) {
          imagePlan.push({
            kind: 'contact-sheet',
            caption: `联系表：${shotsForPlan.length} 个镜头格，按左上→右下排列，格内带时间码水印`,
            cells: shotsForPlan.map((shot, index) => ({ index: index + 1, time: Math.round(Number(shot.start ?? 0) * 100) / 100, timecode: formatTimecode(Number(shot.start ?? 0)) })),
          })
          imageEntries.push({ path: analysis.artifacts?.contactSheet, name: 'media-senses-contact-sheet.png', kind: 'contact-sheet' })
          if (shotsForPlan.length > 1) {
            try {
              const { buildFilmstrip } = await import('./lib/montage.js')
              const times = sampleTimes(Number(analysis.duration ?? 0) > 0 ? 0 : 0, Number(analysis.duration ?? 0) || 1, 3)
              const strip = await buildFilmstrip({
                tools: resolved,
                file: input.path,
                times,
                workDir,
                outputPath: join(outDir, 'filmstrip-video.png'),
                width: profileWidth(vision.profile, 'filmstrip'),
                columns: 3,
              })
              imagePlan.push({
                kind: 'filmstrip',
                caption: '时间条：首/中/尾三帧，从左到右推进',
                cells: (strip.cells ?? []).map((cell) => ({ index: cell.index, time: cell.time, timecode: cell.timecode })),
              })
              imageEntries.push({ path: strip.path, name: 'media-senses-filmstrip.png', kind: 'filmstrip' })
            } catch (error) {
              notes.push(`时间条生成失败（${error instanceof Error ? error.message : String(error)}）`)
            }
          }
        } else {
          imageEntries.push({ path: analysis.artifacts?.contactSheet, name: 'media-senses-contact-sheet.png', kind: 'contact-sheet' })
        }

        // Report assembly: in vision mode the craft/change blocks go into the
        // renderer's appendix so the observation checklist stays the final section.
        const craftSection = craft !== null ? renderCraftSection(craft, recipe) : ''
        const changeSection = change !== null ? renderChangeSection(change, { target }) : ''
        let report = renderVideoReport(analysis, {
          file: input.path,
          detail: detailOf(args),
          transcript: analysis.transcript?.text ?? null,
          asrNotes: notes,
          target,
          imagePlan,
          ...(target === 'vision' ? { appendix: [craftSection, changeSection].filter((part) => part.length > 0) } : {}),
        })
        if (target !== 'vision') {
          if (craftSection.length > 0) report += `\n\n${craftSection}`
          if (changeSection.length > 0) report += `\n\n${changeSection}`
        }
        const attached = await attachFor(exec, imageEntries, vision)
        const images = attached.images
        for (const noteText of attached.notes) notes.push(noteText)
        // In vision mode the renderer already announced the embedded images; a
        // trailing note would break its contract that the checklist comes last.
        const note = images.length > 0 && target !== 'vision'
          ? '\n\n> 本次结果末尾已直接附带**联系表图像**（按镜头顺序排列、带时间码水印）。直接看图即可复核上面的镜头表；需要某一刻的高清原图时再调 `media_frame`。'
          : ''
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
          vision: { active: vision.active, target, profile: vision.profile, reason: vision.reason, images: images.length },
          image_plan: imagePlan,
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
        mode: { type: 'string', enum: ['auto', 'blind', 'vision'], description: '呈现模式：auto 按当前模型能力自动选择（默认）；blind 只给文本；vision 以图为主。' },
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

        const vision = await visionFor(exec, args)
        const target = targetOf(vision)
        const imagePlan = target === 'vision'
          ? [
              { kind: 'spectrogram', caption: '频谱图：横轴时间、纵轴频率，颜色越亮能量越强；低频节奏与高频泛音都看得出来' },
              ...(analysis.artifacts?.waveform ? [{ kind: 'waveform', caption: '波形图：整体响度包络与段落能量变化' }] : []),
            ]
          : []
        const report = renderAudioReport(analysis, { file: input.path, detail: detailOf(args), transcript: transcript?.text ?? null, asrNotes: notes, target, imagePlan })
        const attached = await attachFor(exec, [
          { path: analysis.artifacts?.spectrogram, name: 'media-senses-spectrogram.png', kind: 'spectrogram' },
          { path: analysis.artifacts?.waveform, name: 'media-senses-waveform.png', kind: 'waveform' },
        ], vision)
        const images = attached.images
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
          vision: { active: vision.active, target, profile: vision.profile, reason: vision.reason },
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
        mode: { type: 'string', enum: ['auto', 'blind', 'vision'], description: '呈现模式：auto 按当前模型能力自动选择（默认）；blind 只给文本；vision 以图为主。' },
        region: { type: 'string', description: '只截取一块区域（原图像素），格式 "x,y,w,h"；与 zoom 二选一。' },
        zoom: { type: 'number', description: '中心放大倍数 1–8；看不清细节时用。' },
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
      const vision = await visionFor(exec, args)
      const target = targetOf(vision)
      const region = typeof args.region === 'string' ? args.region : undefined
      const zoom = Number.isFinite(args.zoom) ? args.zoom : undefined
      try {
        const frame = await analyzeFrame({
          tools: resolved,
          file: input.path,
          time,
          workDir,
          outputDir: outDir,
          isImage: imageLike,
          region,
          zoom,
          signal: exec?.signal,
          options: { maxWidth: Math.min(Math.max(Number.isInteger(args.max_width) ? args.max_width : (target === 'vision' ? 1600 : 960), 240), 2400) },
        })
        const imagePlan = target === 'vision'
          ? [{
              kind: 'detail',
              caption: imageLike ? '原图已内嵌（可再用 region 取局部）' : `画面已内嵌${frame.crop?.kind === 'region' ? '（裁剪区域）' : frame.crop?.kind === 'zoom' ? '（中心放大）' : ''}`,
              note: frame.imagePath ? undefined : '图片保存失败，只能给路径',
            }]
          : []
        const report = renderFrameReport(frame, {
          file: input.path,
          time,
          imagePath: frame.imagePath,
          isImage: imageLike,
          target,
          imagePlan,
          region,
          zoom,
        })
        const attached = await attachFor(exec, [{ path: frame.imagePath, name: imageLike ? 'media-senses-image.jpg' : 'media-senses-frame.jpg', kind: 'detail' }], vision)
        const images = attached.images
        return {
          kind: imageLike ? 'image' : 'video-frame',
          file: input.path,
          time_seconds: time,
          image_path: frame.imagePath ?? null,
          image_bytes: frame.imageBytes ?? 0,
          brightness: frame.summary?.brightness ?? null,
          saturation: frame.summary?.saturation ?? null,
          edge_density: frame.summary?.edgeDensity ?? null,
          crop: frame.crop ?? null,
          images,
          vision: { active: vision.active, target, profile: vision.profile, reason: vision.reason },
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
        gate: { type: 'boolean', description: '渲染后跑验收门禁（节奏/静帧/爆发/空档/音频动态五项判定），默认 true，随 verify 一起跑。' },
        lint: { type: 'boolean', description: '渲染前做版式体检（文字出框/标题与字幕打架/字号过小），默认 true。' },
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

      // Pre-render layout audit: text overflow, caption/title collisions, type
      // below the legibility floor. Catching these before a render is the whole
      // point — a 1080p render with clipped text is minutes wasted.
      let lint = null
      if (args.lint !== false) {
        try {
          const { lintPlan, summariseLint } = await import('./lib/lint.js')
          const violations = lintPlan(plan)
          lint = { violations, summary: summariseLint(violations) }
        } catch (error) {
          plan.warnings = plan.warnings ?? []
        }
      }

      const { buildVideo } = await import('./lib/build.js')
      const workDir = await makeWorkDir('media-senses-build')
      const startedAt = Date.now()
      try {
        const result = await buildVideo({ tools: resolved, plan, workDir, signal: exec?.signal })
        const notes = []
        if (lint !== null && lint.violations.length > 0) {
          const errors = lint.violations.filter((violation) => violation.severity === 'error')
          if (errors.length > 0) notes.push(`版式体检发现 ${errors.length} 处会明显出错的问题（见报告「版式体检」一节）`)
        }
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
              // The acceptance gate answers "would someone sit through this?" with
              // measured legs instead of raw numbers. It reuses the shot list the
              // analyser already produced, so it costs one small decode pass.
              let gate = null
              if (args.gate !== false) {
                try {
                  const { runGate } = await import('./lib/gate.js')
                  gate = await runGate({
                    tools: resolved,
                    file: result.output,
                    workDir: verifyWorkDir,
                    shots: analysis.shots,
                    plannedScenes: Array.isArray(plan.scenes) ? plan.scenes : undefined,
                    duration: analysis.duration,
                    signal: exec?.signal,
                  })
                } catch (error) {
                  notes.push(`验收门禁未跑：${error instanceof Error ? error.message : String(error)}`)
                }
              }
              verify = {
                shots: analysis.shots?.length ?? 0,
                duration: analysis.duration,
                brightness: analysis.global?.avgBrightness,
                motion: analysis.global?.avgMotion,
                bpm: analysis.audio?.tempo?.bpm ?? null,
                craft,
                gate,
              }
            } finally {
              await removeWorkDir(verifyWorkDir)
            }
          } catch (error) {
            verifyError = error instanceof Error ? error.message : String(error)
          }
        }
        // Vision target: a three-frame strip (head / middle / tail) lets the model
        // judge the produced video with its own eyes instead of trusting numbers.
        const vision = await visionFor(exec, args)
        const target = targetOf(vision)
        const imagePlan = []
        const imageEntries = []
        if (target === 'vision' && Number(result.duration) > 0) {
          try {
            const { buildFilmstrip } = await import('./lib/montage.js')
            const times = sampleTimes(0, Number(result.duration), 3)
            const strip = await buildFilmstrip({
              tools: resolved,
              file: result.output,
              times,
              workDir,
              outputPath: join(workDir, 'preview-strip.png'),
              width: profileWidth(vision.profile, 'filmstrip'),
              columns: 3,
            })
            imagePlan.push({
              kind: 'filmstrip',
              caption: '成片段：首/中/尾三帧，从左到右',
              cells: (strip.cells ?? []).map((cell) => ({ index: cell.index, time: cell.time, timecode: cell.timecode })),
            })
            imageEntries.push({ path: strip.path, name: 'media-senses-build-strip.png', kind: 'filmstrip' })
          } catch (error) {
            notes.push(`成片预览条生成失败（${error instanceof Error ? error.message : String(error)}）`)
          }
        }
        const report = renderBuildReport(result, { plan, verify, verifyError, targets: args.targets, target, imagePlan, lint })
        const attached = await attachFor(exec, imageEntries, vision)
        const images = attached.images
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
          gate: verify?.gate ?? null,
          gate_verdict: verify?.gate?.verdict ?? null,
          lint: lint === null ? null : { ok: lint.summary.ok, errors: lint.summary.errors, warnings: lint.summary.warnings, violations: lint.violations },
          images,
          vision: { active: vision.active, target, profile: vision.profile, reason: vision.reason },
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
      const guidance = payload.style?.guidance
      return {
        kind: 'styles',
        action,
        skill_dir: skillDir,
        count: Array.isArray(payload.entries) ? payload.entries.length : payload.style === undefined ? 0 : 1,
        starter: starterPath(skillDir),
        images,
        // What defines the style vs what a new episode may swap. Only present for
        // styles whose prompt actually has section structure.
        guidance: guidance === undefined
          ? undefined
          : {
              structured: guidance.hasStructure,
              invariants: guidance.invariants.map((section) => section.role),
              variables: guidance.variables.map((section) => section.role),
              banned: guidance.banned.length,
            },
        report,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Style library ${args.action ?? 'search'}`, kind: 'read' }
    },
  })

  /* ---------------------------------------------------------------- media_moves */

  ctx.tools.register({
    name: 'media_moves',
    description:
      '导演词典：把「缓推一下」「用硬切」「活泼一点」「高级感」这类说法换成确定数值。包含 18 个运镜（带 ffmpeg motion 映射）、' +
      '9 个转场（带 xfade 映射与声音处理）、12 条缓动曲线与弹簧阻尼语义、8 套外观参数预设、15 条「一眼 AI 味」自查、7 条剪辑缝规则，' +
      '另有 44 张镜头配方卡（每张带参数表、「往哪调会怎样」、常见坑与可运行配方）和时长预算（这个时长最多画多少笔）。' +
      '写分镜前先查这里，不要凭感觉编。\n' +
      'The director\'s vocabulary: 18 camera moves with ffmpeg mappings, 9 transitions with xfade mappings and sound handling, ' +
      '12 easing curves plus spring damping semantics, 8 look parameter presets, 15 "looks AI-generated" antipatterns, 7 cut-seam rules, ' +
      '44 shot recipe cards (with a params table, "what happens if you turn this knob", pitfalls and runnable recipes) and a duration budget. ' +
      'Look here before authoring a storyboard instead of guessing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['moves', 'transitions', 'easing', 'looks', 'antipatterns', 'rules', 'cards', 'budget', 'show'],
          description: 'moves 运镜 / transitions 转场 / easing 缓动与弹簧 / looks 外观预设 / antipatterns 反 AI 味 / rules 剪辑缝 / cards 镜头配方卡 / budget 时长预算 / show 取单项详情。默认 moves。',
        },
        query: { type: 'string', description: 'cards 时的检索词（如「标题」「数据」「转场」「stagger」）；show 时也可用 id。' },
        id: { type: 'string', description: 'show 时的 id（运镜/转场/外观/镜头卡 id，如 push-in / dissolve / anime-cel / camera.push-in）。' },
        category: { type: 'string', description: 'cards 时的类目筛选：opening-brand / camera / transitions / typography / ui-entrance / interaction / data / light-emphasis / rhythm / outro。' },
        energy: { type: 'string', enum: ['low', 'medium', 'high'], description: 'cards 时的能量筛选。' },
        seconds: { type: 'number', description: 'budget 时的目标时长（秒）。' },
        kind: { type: 'string', description: 'budget 时的体裁：opener / demo / kinetic / bumper / explainer。' },
        limit: { type: 'integer', description: '返回条数上限（默认 8，最多 50）。' },
      },
    },
    output: { schema: TEXT_OUTPUT_SCHEMA, render: renderTextAndImages },
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : 'moves'
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 8
      let payload
      let report

      if (action === 'moves') {
        const { CAMERA_MOVES } = await import('./lib/moves.js')
        payload = { action, moves: CAMERA_MOVES }
        report = renderVocabularyReport(payload)
      } else if (action === 'transitions') {
        const { TRANSITIONS } = await import('./lib/moves.js')
        payload = { action, transitions: TRANSITIONS }
        report = renderVocabularyReport(payload)
      } else if (action === 'easing') {
        const { EASINGS, EASE_ROLES, EASE_ROLE_NOTES, SPRING_FEEL } = await import('./lib/easing.js')
        // Functions cannot cross the tool boundary: keep the descriptive fields
        // only, so the value stays JSON-safe.
        const curves = {}
        for (const [name, entry] of Object.entries(EASINGS)) {
          curves[name] = {
            css: entry.css,
            nameZh: entry.nameZh,
            feelZh: entry.feelZh,
            monotonic: entry.monotonic,
            cssExact: entry.cssExact,
          }
        }
        payload = { action, easings: { curves, roles: EASE_ROLES, roleNotes: EASE_ROLE_NOTES, spring: SPRING_FEEL } }
        report = renderVocabularyReport(payload)
      } else if (action === 'looks') {
        const { LOOKS } = await import('./lib/look.js')
        payload = { action, looks: LOOKS }
        report = renderVocabularyReport(payload)
      } else if (action === 'antipatterns') {
        const { LOOK_ANTIPATTERNS } = await import('./lib/look.js')
        payload = { action, antipatterns: LOOK_ANTIPATTERNS }
        report = renderVocabularyReport(payload)
      } else if (action === 'rules') {
        const { CUT_SEAM_RULES } = await import('./lib/moves.js')
        payload = { action, rules: CUT_SEAM_RULES }
        report = renderVocabularyReport(payload)
      } else if (action === 'budget') {
        const { durationBudget } = await import('./lib/shots.js')
        const budget = durationBudget({
          seconds: Number.isFinite(args.seconds) ? args.seconds : undefined,
          kind: typeof args.kind === 'string' ? args.kind : undefined,
        })
        payload = { action, budget }
        const lines = ['# 时长预算', '']
        if (budget.seconds !== null && budget.seconds !== undefined) {
          lines.push(`- 目标时长 ${budget.seconds}s：最多约 **${budget.maxStrokes}** 笔（起形+马克笔，${budget.strokesPerSecond} 笔/秒）`)
          lines.push(`- 若按部位上色：约 **${budget.maxColorStrokes}** 笔（${budget.colorStrokesPerSecond} 笔/秒）`)
        }
        if (budget.genreRange !== null && budget.genreRange !== undefined) {
          lines.push(`- ${budget.kind} 体裁的常见区间：${budget.genreRange.min}–${budget.genreRange.max}s${budget.withinGenreRange === false ? '（当前时长不在区间内）' : ''}`)
        }
        if (budget.recommendedSeconds !== null && budget.recommendedSeconds !== undefined) {
          lines.push(`- 建议时长：${budget.recommendedSeconds}s`)
        }
        if (typeof budget.adviceZh === 'string' && budget.adviceZh.length > 0) lines.push('', budget.adviceZh)
        for (const warning of budget.warnings ?? []) lines.push(`- ${warning}`)
        report = tidy(lines.join('\n'))
      } else if (action === 'cards') {
        const { findShots, renderShotCard } = await import('./lib/shots.js')
        const cards = findShots(typeof args.query === 'string' ? args.query : '', {
          category: typeof args.category === 'string' ? args.category : undefined,
          energy: typeof args.energy === 'string' ? args.energy : undefined,
          limit,
        })
        payload = { action, entries: cards.map((card) => ({ id: card.id, nameZh: card.nameZh, category: card.category, energy: card.energy, oneLineZh: card.oneLineZh })) }
        const lines = [`# 镜头配方卡${typeof args.query === 'string' && args.query.length > 0 ? ` · ${args.query}` : ''}`, '']
        if (cards.length === 0) {
          lines.push('没有匹配的配方卡；换一个词（「标题」「入场」「数据」「转场」「收尾」）或去掉类目筛选。')
        }
        for (const card of cards) {
          lines.push(renderShotCard(card))
          lines.push('')
        }
        report = tidy(lines.join('\n'))
      } else {
        // show: try a camera move, a transition, a look, then a shot card.
        const wanted = String(typeof args.id === 'string' ? args.id : args.query ?? '').trim()
        if (wanted.length === 0) throw new Error('show 需要 id（如 push-in / dissolve / anime-cel / camera.push-in）')
        const { getMove, getTransition } = await import('./lib/moves.js')
        const { getLook } = await import('./lib/look.js')
        const { getShot } = await import('./lib/shots.js')
        const move = getMove(wanted)
        const transition = move === null ? getTransition(wanted) : null
        const look = move === null && transition === null ? getLook(wanted) : null
        const shot = move === null && transition === null && look === null ? getShot(wanted) : null
        if (move === null && transition === null && look === null && shot === null) {
          throw new Error(`词典里没有「${wanted}」；先用 action:"moves" / "looks" / "cards" 找 id。`)
        }
        payload = { action: 'show', move, transition, look, shot }
        const { renderShotCard } = await import('./lib/shots.js')
        if (shot !== null) {
          report = tidy(`# 镜头配方卡\n\n${renderShotCard(shot)}`)
        } else {
          report = renderVocabularyReport({ action: 'show', move: move ?? undefined, transition: transition ?? undefined, look: look ?? undefined })
        }
      }

      return {
        kind: 'moves',
        action,
        count: Array.isArray(payload.moves)
          ? payload.moves.length
          : Array.isArray(payload.transitions)
            ? payload.transitions.length
            : Array.isArray(payload.looks)
              ? payload.looks.length
              : Array.isArray(payload.antipatterns)
                ? payload.antipatterns.length
                : Array.isArray(payload.entries)
                  ? payload.entries.length
                  : payload.budget === undefined ? 1 : 0,
        data: payload,
        report,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Director vocabulary ${args.action ?? 'moves'}`, kind: 'read' }
    },
  })

  /* -------------------------------------------------------------- media_animate */

  ctx.tools.register({
    name: 'media_animate',
    description:
      '把一段代码动画（HTML + Canvas/SVG/CSS/Three.js/WebGL）逐帧渲染成 MP4 片段。' +
      '两种页面契约都支持：① 实现 `window.renderAt(t)`（画面完全由秒数 t 决定）；② 普通 HTML——CSS @keyframes / WAAPI / GSAP 时间轴（`window.__timelines`）/ ' +
      '声明式 clip（`data-composition-id` + `data-start`/`data-duration`）会被自动 seek 到每帧。可选打开运动模糊（按快门角多次采样后混合）与页面内 `<audio>` 混音。' +
      '用本机 headless Edge + CDP 逐帧截图后用 ffmpeg 编码，无需安装 Playwright。渲染出的片段可以交给 media_build_video 作为 video 场景拼接。\n' +
      'Render an HTML/Canvas/CSS/Three.js/WebGL animation into an MP4 segment frame-by-frame. Two contracts are supported: ' +
      '(1) the page implements `window.renderAt(t)`; (2) plain HTML — CSS @keyframes / WAAPI / GSAP timelines (`window.__timelines`) / ' +
      'declarative clips (`data-composition-id` + `data-start`/`data-duration`) are seeks to each frame automatically. ' +
      'Optional shutter-angle motion blur (multiple sub-samples blended) and in-page `<audio>` mixing. ' +
      'Drives headless Edge over CDP and encodes with ffmpeg — no Playwright install needed. The segment can be spliced ' +
      'into media_build_video as a video scene.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        html_path: { type: 'string', description: '动画 HTML 文件路径（绝对路径）。' },
        html: { type: 'string', description: '也可以直接给 HTML 源码（会写到临时文件后渲染）。' },
        output: { type: 'string', description: '输出 MP4 路径；省略时写到 ~/.dsh/media-senses/output。' },
        width: { type: 'integer', description: '宽（偶数），默认 1920。' },
        height: { type: 'integer', description: '高（偶数），默认 1080。' },
        fps: { type: 'integer', description: '帧率，默认 30。' },
        duration: { type: 'number', description: '时长（秒），默认 12，上限由配置 animateMaxSeconds 决定。' },
        motion_blur: { type: 'integer', description: '运动模糊子帧数（1=关闭，2–16）。快速运镜/甩镜要开，静止画面不用；成本约为 samples 倍抓帧。' },
        shutter_angle: { type: 'number', description: '快门角（0–360，默认 180）。180°＝电影常规，360°＝更强拖影。' },
        mix_audio: { type: 'boolean', description: '是否把页面内 `<audio data-start data-duration data-volume src>` 混进输出，默认 true。' },
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
        const samples = Number.isInteger(args.motion_blur) ? Math.min(Math.max(args.motion_blur, 1), 16) : 1
        const shutter = Number.isFinite(args.shutter_angle) ? Math.min(Math.max(args.shutter_angle, 0), 360) : 180
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
          motionBlur: samples > 1 ? { samples, shutter: shutter > 0 ? shutter : 180 } : undefined,
          mixAudio: args.mix_audio !== false,
          signal: exec?.signal,
        })
        // A preview strip (head / middle / tail) makes the generation loop visual:
        // the model sees the motion arc instead of a single frozen frame.
        const vision = await visionFor(exec, args)
        const target = targetOf(vision)
        previewPath = join(workDir, 'preview.jpg')
        await run(resolved.ffmpeg, ['-v', 'error', '-y', '-ss', String(Math.max(0, duration * 0.4)), '-i', output, '-frames:v', '1', '-q:v', '3', previewPath], { cwd: workDir })
        const imagePlan = []
        const imageEntries = [{ path: previewPath, name: 'animation-preview.jpg', kind: 'preview' }]
        if (target === 'vision' && Number(result.duration) > 0) {
          try {
            const { buildFilmstrip } = await import('./lib/montage.js')
            const strip = await buildFilmstrip({
              tools: resolved,
              file: output,
              times: sampleTimes(0, Number(result.duration), 3),
              workDir,
              outputPath: join(workDir, 'anim-strip.png'),
              width: profileWidth(vision.profile, 'filmstrip'),
              columns: 3,
            })
            imagePlan.push({ kind: 'filmstrip', caption: '动画首/中/尾三帧，从左到右', cells: (strip.cells ?? []).map((cell) => ({ index: cell.index, time: cell.time, timecode: cell.timecode })) })
            imageEntries.unshift({ path: strip.path, name: 'media-senses-anim-strip.png', kind: 'filmstrip' })
          } catch (error) {
            imagePlan.push({ kind: 'preview', caption: `单帧预览${error instanceof Error ? `（三帧条失败：${error.message}）` : ''}` })
          }
        }
        const attached = await attachFor(exec, imageEntries, vision)
        const images = attached.images
        const report = renderAnimateReport(result, { styleId: args.style_id, htmlPath, previewPath, target, imagePlan })
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
          runtime: result.runtime ?? null,
          motion_blur: result.motionBlur ?? null,
          audio: result.audio ?? null,
          warnings: result.warnings ?? [],
          images,
          vision: { active: vision.active, target, profile: vision.profile, reason: vision.reason },
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
      const vision = await visionFor(exec, args)
      const target = targetOf(vision)
      // A vision model reads text better from a bigger capture; a blind model only
      // needs the 800 px raster for its ASCII rendering.
      const captureWidth = target === 'vision' ? Math.max(longEdge, profileWidth(vision.profile, 'detail')) : longEdge
      let imagePath
      try {
        if (action === 'peek') {
          const captured = await screenMod.captureFrames({ tools: resolved, workDir, options: { seconds: 0, width: captureWidth, region: args.region, source: 'screen', outputDir: outDir }, signal: exec?.signal })
          const framePath = captured.frames?.[0]?.path
          if (typeof framePath !== 'string') throw new Error('屏幕采集没有产出画面（可能是锁屏 / UAC 安全桌面 / 远程桌面）')
          const frame = await analyzeFrame({ tools: resolved, file: framePath, time: 0, workDir, outputDir: outDir, isImage: true, signal: exec?.signal })
          imagePath = frame.imagePath ?? framePath
          const attached = await attachFor(exec, [{ path: imagePath, name: 'media-senses-screen.png', kind: 'detail' }], vision)
          const images = attached.images
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
            target,
            imagePlan: target === 'vision' ? [{ kind: 'detail', caption: '当前屏幕截图已内嵌' }] : [],
          })
          return { kind: 'see', action, image_path: imagePath, images, vision: { active: vision.active, target, profile: vision.profile, reason: vision.reason }, report }
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
        const attached = imagePath === undefined
          ? { images: [], notes: [] }
          : await attachFor(exec, [{ path: imagePath, name: 'media-senses-screen-sheet.png', kind: 'contact-sheet' }], vision)
        const images = attached.images
        const report = renderSeeReport({
          action: 'watch',
          seconds,
          engine: captured.engine,
          width: captured.width,
          height: captured.height,
          elapsedMs: captured.elapsedMs,
          region: args.region,
          target,
          imagePlan: target === 'vision'
            ? [{
                kind: 'contact-sheet',
                caption: `屏幕变化拼图：${selected.length} 帧，按左上→右下排列`,
                cells: selected.map((item, index) => ({ index: index + 1, time: Math.round((item.sourceTime ?? item.time) * 100) / 100, timecode: formatTimecode(item.sourceTime ?? item.time) })),
              }]
            : [],
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

  /* ------------------------------------------------------------ media_frames */

  ctx.tools.register({
    name: 'media_frames',
    description:
      '一次取多个时间点的画面，拼成一条带帧号与时间码的横条（首/中/尾或任意时刻）。' +
      '用于比较「这几秒里画面怎么变」；比逐个调 media_frame 少几次往返，视觉模型会直接拿到这张拼图。\n' +
      'Grab several moments of one video at once and return them as a single labelled strip (head/middle/tail or any ' +
      'timestamps) — for comparing how the picture changes over time. Fewer round-trips than calling media_frame ' +
      'repeatedly; a vision model gets the strip directly.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '视频或图片文件绝对路径。' },
        times: { type: 'array', items: { type: 'number' }, description: '要取的时间点（秒），最多 6 个；省略时在片长上均匀取 3 个。' },
        mode: { type: 'string', enum: ['auto', 'blind', 'vision'], description: '呈现模式：auto 按当前模型能力自动选择（默认）。' },
        width: { type: 'integer', description: '拼图宽度像素（默认按视觉档位 1260）。' },
      },
      required: ['path'],
    },
    output: { schema: TEXT_OUTPUT_SCHEMA, render: renderTextAndImages },
    isConcurrencySafe: () => true,
    timeoutMs: 240_000,
    async execute(args, exec) {
      const resolved = await tools()
      const input = await locateInput(args.path, config)
      const probed = await probe(resolved, input.path)
      const summary = summariseProbe(probed)
      const imageLike = isImageLike(summary)
      if (!imageLike && classify(summary) !== 'video') throw new Error(`${args.path} 既不是视频也不是图片，无法取帧。`)
      const duration = imageLike ? 0 : Number(summary.duration ?? 0)
      const requested = Array.isArray(args.times)
        ? args.times.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0).slice(0, 6)
        : []
      const times = requested.length > 0 ? requested : sampleTimes(0, duration || 1, imageLike ? 1 : 3)
      const vision = await visionFor(exec, args)
      const target = targetOf(vision)
      const outDir = await artifactDir(input.path, config.outputDir)
      const workDir = await makeWorkDir('media-senses-frames')
      try {
        const { buildFilmstrip } = await import('./lib/montage.js')
        const strip = await buildFilmstrip({
          tools: resolved,
          file: input.path,
          times,
          workDir,
          outputPath: join(outDir, `strip-${Date.now()}.png`),
          width: Math.min(Math.max(Number.isInteger(args.width) ? args.width : profileWidth(vision.profile, 'filmstrip'), 420), 2400),
          columns: Math.min(times.length, 3),
        })
        const attached = await attachFor(exec, [{ path: strip.path, name: 'media-senses-frames-strip.png', kind: 'filmstrip' }], vision)
        const report = renderFramesReport({
          file: input.path,
          cells: strip.cells ?? times.map((time, index) => ({ index: index + 1, time, timecode: formatTimecode(time) })),
          width: strip.width,
          height: strip.height,
          tokenEstimate: strip.tokenEstimate,
          target,
        })
        return {
          kind: 'frames',
          file: input.path,
          times,
          cells: strip.cells ?? [],
          strip_path: strip.path ?? null,
          token_estimate: strip.tokenEstimate ?? null,
          images: attached.images,
          vision: { active: vision.active, target, profile: vision.profile, reason: vision.reason },
          report,
        }
      } finally {
        await removeWorkDir(workDir)
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Frames of ${args.path}`, kind: 'read', locations: [{ path: String(args.path) }] }
    },
  })

  /* ----------------------------------------------------------- media_compare */

  ctx.tools.register({
    name: 'media_compare',
    description:
      '把「参考片」和「仿制成片」放在同一张对比图上（上下或左右），并给出逐项数值差异与判定。' +
      '视觉模型可以据此回答「像不像、下一版改哪里」。这是仿制闭环的验收工具。\n' +
      'Put a reference video and a produced copy side by side (stacked or side-by-side) and report per-metric ' +
      'differences with match/close/diverge verdicts, so a vision model can judge "does it look like the reference, ' +
      'and what should change next". This is the acceptance tool of the reproduction loop.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reference: { type: 'string', description: '参考片绝对路径。' },
        produced: { type: 'string', description: '仿制成片绝对路径。' },
        ref_time: { type: 'number', description: '参考片取帧时间点（默认取 50% 处）。' },
        built_time: { type: 'number', description: '成片取帧时间点（默认取 50% 处）。' },
        layout: { type: 'string', enum: ['stack', 'side'], description: 'stack=上参考下成片（默认）；side=左参考右成片。' },
        include_metrics: { type: 'boolean', description: '是否跑完整数值对比（需要分析两边，稍慢；默认 true）。' },
        include_continuity: { type: 'boolean', description: '是否判定镜头承接（切点有没有把东西带过去、像不像 PPT；默认 true，比数值对比更快）。' },
        rubric: { type: 'boolean', description: '是否附上 7 维评分卡空白表，让模型自评并给出带时间码证据的改法（默认 false）。' },
        mode: { type: 'string', enum: ['auto', 'blind', 'vision'], description: '呈现模式：auto 按当前模型能力自动选择（默认）。' },
      },
      required: ['reference', 'produced'],
    },
    output: { schema: TEXT_OUTPUT_SCHEMA, render: renderTextAndImages },
    isConcurrencySafe: () => false,
    timeoutMs: 600_000,
    async execute(args, exec) {
      const resolved = await tools()
      const reference = await locateInput(args.reference, config)
      const produced = await locateInput(args.produced, config)
      for (const item of [reference, produced]) {
        const summary = summariseProbe(await probe(resolved, item.path))
        if (classify(summary) !== 'video') throw new Error(`${item.path} 不是视频，无法对比。`)
      }
      const vision = await visionFor(exec, args)
      const target = targetOf(vision)
      const outDir = await artifactDir(reference.path, args.output_dir ?? config.outputDir)
      const workDir = await makeWorkDir('media-senses-compare')
      try {
        const { buildComparePair, diffMetrics } = await import('./lib/montage.js')
        let diff = { rows: [], summary: { match: 0, close: 0, diverge: 0, unknown: 0 }, verdict: 'unknown' }
        let analysed = null
        if (args.include_metrics !== false) {
          try {
            const refAnalysis = await analyzeVideo({
              tools: resolved,
              file: reference.path,
              workDir,
              options: { maxKeyframes: 6, wantContactSheet: false, wantFrames: true, wantAudio: true, artifactDir: join(workDir, 'ref') },
              signal: exec?.signal,
              analyzeAudio,
            })
            const builtAnalysis = await analyzeVideo({
              tools: resolved,
              file: produced.path,
              workDir,
              options: { maxKeyframes: 6, wantContactSheet: false, wantFrames: true, wantAudio: true, artifactDir: join(workDir, 'built') },
              signal: exec?.signal,
              analyzeAudio,
            })
            // Continuity: is anything carried across each cut, or is every shot a
            // new picture? The numeric table cannot see this failure at all.
            if (args.include_continuity !== false) {
              try {
                const { analyzeContinuity } = await import('./lib/continuity.js')
                refAnalysis.continuity = await analyzeContinuity({
                  tools: resolved,
                  file: reference.path,
                  workDir,
                  shots: refAnalysis.shots,
                  duration: refAnalysis.duration,
                  signal: exec?.signal,
                })
                builtAnalysis.continuity = await analyzeContinuity({
                  tools: resolved,
                  file: produced.path,
                  workDir,
                  shots: builtAnalysis.shots,
                  duration: builtAnalysis.duration,
                  signal: exec?.signal,
                })
              } catch (error) {
                if (error?.name === 'AbortError') throw error
                // Continuity is an extra signal, never a reason to fail a compare.
              }
            }
            diff = diffMetrics(refAnalysis, builtAnalysis)
            analysed = { refDuration: refAnalysis.duration, builtDuration: builtAnalysis.duration }
          } catch (error) {
            diff = { rows: [], summary: { match: 0, close: 0, diverge: 0, unknown: 0 }, verdict: 'unknown', warning: error instanceof Error ? error.message : String(error) }
          }
        }
        const refDuration = Number(analysed?.refDuration ?? 0)
        const builtDuration = Number(analysed?.builtDuration ?? 0)
        const refTime = Number.isFinite(args.ref_time) ? Math.max(0, args.ref_time) : (refDuration > 0 ? refDuration * 0.5 : 0)
        const builtTime = Number.isFinite(args.built_time) ? Math.max(0, args.built_time) : (builtDuration > 0 ? builtDuration * 0.5 : 0)
        const compare = await buildComparePair({
          tools: resolved,
          refFile: reference.path,
          builtFile: produced.path,
          refTime,
          builtTime,
          workDir,
          outputPath: join(outDir, `compare-${Date.now()}.png`),
          width: profileWidth(vision.profile, 'detail'),
          labels: ['参考', '成片'],
          mode: args.layout === 'side' ? 'side' : 'stack',
        })
        const attached = await attachFor(exec, [{ path: compare.path, name: 'media-senses-compare.png', kind: 'compare' }], vision)
        const compareReport = renderCompareReport({
          reference: reference.path,
          produced: produced.path,
          diff,
          compareImage: { path: compare.path, width: compare.width, height: compare.height, mode: compare.mode, tokenEstimate: compare.tokenEstimate },
          target,
        })
        // A self-assessment card turns "looks close" into seven scored dimensions
        // that each need a timecode and a numeric fix, which is what makes the
        // next revision actionable.
        let report = compareReport
        let rubric = null
        if (args.rubric === true) {
          try {
            const { renderRubricTemplate } = await import('./lib/rubric.js')
            report = `${compareReport}\n\n${renderRubricTemplate()}`
            rubric = { attached: true }
          } catch (error) {
            rubric = { attached: false, error: error instanceof Error ? error.message : String(error) }
          }
        }
        return {
          kind: 'compare',
          reference: reference.path,
          produced: produced.path,
          verdict: diff.verdict ?? 'unknown',
          summary: diff.summary ?? {},
          rows: diff.rows ?? [],
          continuity: diff.continuity ?? null,
          rubric,
          compare_image: compare.path ?? null,
          images: attached.images,
          vision: { active: vision.active, target, profile: vision.profile, reason: vision.reason },
          report,
        }
      } finally {
        await removeWorkDir(workDir)
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Compare ${args.reference} vs ${args.produced}`, kind: 'read' }
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
   * Vision capability for one tool call (cached per exec object).
   *
   * Resolves once per tool invocation: which model route is active, whether it
   * accepts images, what the attachment limits are, and the image profile.
   *
   * @param {object|undefined} exec tool run context
   * @param {{mode?: string}} [args] tool arguments (an explicit `mode` overrides config)
   */
  const visionCache = new WeakMap()
  async function visionFor(exec, args) {
    const override = typeof args?.mode === 'string' ? args.mode : undefined
    if (override === undefined && exec !== null && typeof exec === 'object' && visionCache.has(exec)) {
      return visionCache.get(exec)
    }
    const result = await detectVision({ ctx, exec, config, override })
    if (override === undefined && exec !== null && typeof exec === 'object') visionCache.set(exec, result)
    return result
  }

  /** The report rendering target derived from the vision decision. */
  function targetOf(vision) {
    return vision?.active === true ? 'vision' : 'blind'
  }

  /**
   * Attach images for this tool result (capability + limits handled by lib/vision).
   *
   * @param {object|undefined} exec
   * @param {Array<{path?: string, name: string, kind?: string}>} entries
   * @param {object} [vision] pre-resolved vision decision (avoids a second probe)
   * @returns {Promise<{images: object[], notes: string[]}>}
   */
  async function attachFor(exec, entries, vision) {
    if (config.embedImages === false) return { images: [], notes: [] }
    const decision = vision ?? (await visionFor(exec))
    if (decision?.active !== true) return { images: [], notes: [] }
    const resolved = await tools()
    const visionWorkDir = await makeWorkDir('media-senses-vision')
    try {
      const attached = await attachImages({ ctx, exec, tools: resolved, workDir: visionWorkDir, entries, vision: decision })
      const notes = [...attached.notes]
      for (const skip of attached.skipped) notes.push(`未内嵌 ${skip.name ?? skip.path ?? '图片'}：${skip.reason}`)
      return { images: attached.images, notes }
    } catch (error) {
      return { images: [], notes: [`图片内嵌失败：${error instanceof Error ? error.message : String(error)}`] }
    } finally {
      await removeWorkDir(visionWorkDir)
    }
  }

  /** Backwards-compatible list form used by the tool bodies. */
  async function inlineImages(exec, entries, vision) {
    const attached = await attachFor(exec, entries, vision)
    return attached.images
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








