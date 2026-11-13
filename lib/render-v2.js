/**
 * Model-facing reports for the v2 "learn then reproduce" surface:
 *
 *  - `renderCraftSection`  appended to a single-video report: how it was made
 *  - `renderCorpusReport`  the whole style profile for a batch of references
 *  - `renderBuildReport`   what the builder produced and whether it matches
 *  - `renderTtsReport`     a synthesized narration take
 */
import { formatBytes, formatTimecode } from './ffmpeg.js'
import { bar, brightnessZh, fitArt, hueZh, num, pct, saturationZh, sparkline, tidy } from './render.js'

const MOTION_ZH = {
  static: '固定镜头',
  'pan-left': '左摇',
  'pan-right': '右摇',
  'tilt-up': '上摇',
  'tilt-down': '下摇',
  'zoom-in': '推镜',
  'zoom-out': '拉镜',
  handheld: '手持晃动',
}

const ROLE_ZH = { intro: '开场', body: '主体', outro: '结尾' }

const TRANSITION_ZH = { cut: '硬切', fade: '淡入淡出', 'dip-to-black': '黑场过渡', other: '其他' }

const SIGNATURE_ZH = {
  'high-contrast': '高对比',
  'low-contrast': '低对比',
  'teal-orange': '青橙调',
  desaturated: '低饱和',
  warm: '暖调',
  cool: '冷调',
  neutral: '中性',
}

function signatureZh(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return '—'
  return tags.map((tag) => SIGNATURE_ZH[tag] ?? tag).join('、')
}

function motionZh(motion) {
  return MOTION_ZH[motion] ?? motion ?? '—'
}

function roleZh(role) {
  return ROLE_ZH[role] ?? role ?? '—'
}

function distributionLine(map, translate = (key) => key) {
  const entries = Object.entries(map ?? {}).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return '—'
  return entries.map(([key, share]) => `${translate(key)} ${pct(share)}`).join(' / ')
}

/* ------------------------------------------------------------ vision target */

/**
 * Vision target (v3): for models that can see, the tool layer embeds pictures and
 * passes `target: 'vision'` (+ an `imagePlan`). The renderers then drop the ASCII
 * substitute / adjective judgements and point at the pictures instead. Opt-in
 * only, so the blind rendering stays byte-for-byte identical.
 */
function visionTarget(meta) {
  return meta !== null && typeof meta === 'object' && meta.target === 'vision'
}

/** The filmstrip entry of the plan (head / middle / tail frames), if any. */
function planFilmstripEntry(meta) {
  const plan = Array.isArray(meta?.imagePlan) ? meta.imagePlan : []
  return plan.find((entry) => entry !== null && typeof entry === 'object' && entry.kind === 'filmstrip')
}

/**
 * The one-line strip caption required by CONTRACT-V3 A4. The cell timecodes are
 * appended when the plan carries them, so the model can cite them directly.
 */
function filmstripNote(meta) {
  const entry = planFilmstripEntry(meta)
  if (entry === undefined) return undefined
  const cells = Array.isArray(entry.cells) ? entry.cells.filter((cell) => cell !== null && typeof cell === 'object') : []
  const times = cells
    .map((cell) => (typeof cell.timecode === 'string' && cell.timecode.trim().length > 0 ? cell.timecode.trim() : formatTimecode(cell.time)))
    .join(' / ')
  return times.length > 0
    ? `成片段（首/中/尾三帧，左→右）已内嵌 · 格号 ${times}`
    : '成片段（首/中/尾三帧，左→右）已内嵌'
}

/**
 * The "how was this made" block appended to a video report.
 *
 * @param {object} craft craft object from `lib/craft.js`
 * @param {object|null} recipe reproduction recipe
 */
export function renderCraftSection(craft, recipe) {
  if (craft === null || typeof craft !== 'object') return ''
  const lines = []
  lines.push('## 制作技法（这条片子是怎么做出来的）')
  const rhythm = craft.cutRhythm ?? {}
  const transitions = craft.transitions ?? {}
  const grading = craft.grading ?? {}
  const overlays = craft.overlays ?? {}
  const hook = craft.hook ?? {}
  const beat = craft.beatSync ?? {}
  const titleCard = craft.titleCard ?? {}

  const cutParts = []
  if (Number.isFinite(Number(rhythm.shotCount))) cutParts.push(`${rhythm.shotCount} 个镜头`)
  if (Number.isFinite(Number(rhythm.avgShotLength))) cutParts.push(`平均镜头 ${num(rhythm.avgShotLength, 2)} 秒`)
  if (Number.isFinite(Number(rhythm.medianShotLength))) cutParts.push(`中位数 ${num(rhythm.medianShotLength, 2)} 秒`)
  if (Number.isFinite(Number(rhythm.cutRatePerMin))) cutParts.push(`每分钟 ${num(rhythm.cutRatePerMin, 1)} 次剪辑`)
  if (cutParts.length > 0) lines.push(`- 剪辑节奏：${cutParts.join(' · ')}`)

  const transitionParts = []
  if (Number.isFinite(Number(transitions.hardCutShare))) transitionParts.push(`硬切 ${pct(transitions.hardCutShare)}`)
  if (Number.isFinite(Number(transitions.gradualShare))) transitionParts.push(`渐变 ${pct(transitions.gradualShare)}`)
  if (Array.isArray(transitions.list) && transitions.list.length > 0) {
    transitionParts.push(`切换点 ${transitions.list.slice(0, 8).map((item) => `${formatTimecode(item.at)} ${TRANSITION_ZH[item.kind] ?? item.kind}`).join('、')}${transitions.list.length > 8 ? ' 等' : ''}`)
  }
  if (transitionParts.length > 0) lines.push(`- 转场：${transitionParts.join(' · ')}`)

  if (Array.isArray(craft.camera) && craft.camera.length > 0) {
    lines.push(`- 运镜：${craft.camera.map((item) => `镜头${(item.shotIndex ?? 0) + 1} ${motionZh(item.motion)}${Number.isFinite(Number(item.intensity)) ? `(${num(item.intensity, 2)})` : ''}`).join(' · ')}`)
  }

  const gradeParts = []
  if (Array.isArray(grading.signature) && grading.signature.length > 0) gradeParts.push(signatureZh(grading.signature))
  if (grading.temperature) gradeParts.push(`色温${grading.temperature === 'warm' ? '偏暖' : grading.temperature === 'cool' ? '偏冷' : '中性'}`)
  if (Number.isFinite(Number(grading.contrast))) gradeParts.push(`对比度 ${num(grading.contrast, 2)}`)
  if (Number.isFinite(Number(grading.saturation))) gradeParts.push(`饱和度 ${num(grading.saturation, 2)}`)
  if (gradeParts.length > 0) lines.push(`- 调色：${gradeParts.join(' · ')}`)

  const overlayParts = []
  if (Number.isFinite(Number(overlays.textDensity))) overlayParts.push(`文字密度 ${num(overlays.textDensity, 2)}`)
  if (overlays.likelySubtitles === true) overlayParts.push('疑似有字幕')
  if (overlays.likelyTitleCard === true) overlayParts.push('疑似有标题卡')
  if (overlayParts.length > 0) lines.push(`- 文字包装：${overlayParts.join(' · ')}`)

  const hookParts = []
  if (hook.hasEarlyCut === true) hookParts.push('前 3 秒内有第一次剪辑')
  if (hook.hasTitleInFirst3s === true) hookParts.push('前 3 秒出现标题')
  if (hook.firstShotMotion) hookParts.push(`首镜头${motionZh(hook.firstShotMotion)}`)
  if (Number.isFinite(Number(hook.hookStrength))) hookParts.push(`钩子强度 ${num(hook.hookStrength, 2)} ${bar(hook.hookStrength, 6)}`)
  if (hookParts.length > 0) lines.push(`- 开头钩子：${hookParts.join(' · ')}`)

  if (typeof beat.cutsOnBeatRatio === 'number' && Number.isFinite(beat.cutsOnBeatRatio)) {
    const offset = Number.isFinite(Number(beat.meanOffsetMs)) ? `，平均偏移 ${num(beat.meanOffsetMs, 0)} ms` : ''
    lines.push(`- 音乐卡点：${pct(beat.cutsOnBeatRatio)} 的切点落在拍点 ±120ms 内${offset}${beat.bpm ? `（BPM ${num(beat.bpm, 1)}）` : ''}`)
  }

  if (Array.isArray(craft.sections) && craft.sections.length > 0) {
    lines.push(`- 段落角色：${craft.sections.map((section) => `${formatTimecode(section.start)}–${formatTimecode(section.end)} ${roleZh(section.role)}（平均镜头 ${num(section.avgShotLength, 2)}s）`).join(' · ')}`)
  }
  if (titleCard.present === true) {
    lines.push(`- 标题卡：${formatTimecode(Number(titleCard.at) || 0)} 起约 ${num(titleCard.duration, 1)} 秒，样式 ${titleCard.style ?? '未知'}`)
  }
  lines.push('')

  if (recipe !== null && typeof recipe === 'object' && Array.isArray(recipe.reproductionNotes) && recipe.reproductionNotes.length > 0) {
    lines.push('### 仿制要点（模型可直接照做）')
    for (const note of recipe.reproductionNotes) lines.push(`- ${note}`)
    lines.push('')
    lines.push('> 需要复刻时：按上面的要点改写 `recipe`（或直接用下面的 shots/look/sound），调用 `media_build_video` 渲染，再用 `media_watch_video` 复核节奏与调色是否接近。')
    lines.push('> 运镜映射：`media_build_video` 的图片场景只支持 none / kenburns-in / kenburns-out / pan-left / pan-right；`zoom-in|zoom-out|handheld|tilt-*` 建议改用 `media_animate` 生成代码动画片段，或选最接近的 Ken Burns 运动代替。')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(compactRecipe(recipe), null, 1))
    lines.push('```')
  }
  if (Array.isArray(craft.warnings) && craft.warnings.length > 0) {
    lines.push('')
    for (const warning of craft.warnings) lines.push(`- ${warning}`)
  }
  return tidy(lines.join('\n'))
}

/** A recipe is easier to consume without the per-shot extras. */
function compactRecipe(recipe) {
  return {
    schema: recipe.schema,
    duration: recipe.duration,
    aspect: recipe.aspect,
    resolution: recipe.resolution,
    fps: recipe.fps,
    shots: (recipe.shots ?? []).map((shot) => ({
      index: shot.index,
      start: shot.start,
      end: shot.end,
      duration: shot.duration,
      camera: shot.camera,
      transitionIn: shot.transitionIn,
      palette: shot.palette,
    })),
    look: recipe.look,
    sound: recipe.sound,
    pacing: recipe.pacing,
  }
}

/**
 * The corpus-level "learn how this genre is made" report.
 *
 * @param {object} options
 * @param {object} options.profile style profile from `lib/profile.js`
 * @param {{count: number, skipped: number, failed: number, root: string, warnings: string[]}} options.corpus
 * @param {string} options.profilePath
 * @param {{tool?: string, downloaded?: number}} [options.ingest]
 */
export function renderCorpusReport(options) {
  const { profile, corpus, profilePath, ingest } = options
  const lines = []
  lines.push(`# 语料风格画像 · ${profile.name}`)
  lines.push('')
  lines.push(`语料目录: \`${corpus.root}\``)
  const counts = [`成功分析 ${profile.count} 条`]
  if (corpus.skipped > 0) counts.push(`命中缓存 ${corpus.skipped} 条`)
  if (corpus.failed > 0) counts.push(`失败 ${corpus.failed} 条`)
  if (ingest !== undefined) counts.push(`下载 ${ingest.downloaded ?? 0} 条（${ingest.tool}）`)
  lines.push(`规模: ${counts.join(' · ')} · 总时长 ${formatTimecode(profile.totalSeconds)}`)
  if (typeof profilePath === 'string') lines.push(`画像文件: \`${profilePath}\``)
  lines.push('')

  lines.push('## 学习结论（这个品类是怎么做的）')
  lines.push(...profileMarkdownSummary(profile))
  lines.push('')

  lines.push('## 仿制清单（照着做就像）')
  profile.reproduction.checklist.forEach((item, index) => lines.push(`${index + 1}. ${item}`))
  lines.push('')

  lines.push('## 执行顺序建议')
  lines.push('1. 把清单里的参数写成分镜（每个场景：类型/时长/文字或图片/转场）。')
  lines.push('2. 调用 `media_build_video` 渲染（RenderPlan JSON；可用下面的骨架起步）。')
  lines.push('3. 用 `media_watch_video` 复核成片：镜头长度、调色标签、卡点率是否落在画像区间。')
  lines.push('4. 差距大就改分镜重渲；确认接近后可批量产出同类视频。')
  lines.push('')

  lines.push('## RenderPlan 骨架（复制后替换（…）占位）')
  lines.push('```json')
  lines.push(JSON.stringify(profile.reproduction.brief.plan, null, 1))
  lines.push('```')
  lines.push('')
  lines.push(`> ${profile.reproduction.brief.note}`)
  lines.push('')

  lines.push('## 样本明细')
  lines.push('| # | 文件 | 时长 | 镜头 | 平均镜头长 | 画幅 | BPM | 调色 | 标题卡 | 字幕 |')
  lines.push('|---|------|------|------|------------|------|-----|------|--------|------|')
  profile.videos.forEach((video, index) => {
    lines.push(`| ${index + 1} | ${video.file} | ${video.duration}s | ${video.shots} | ${video.avgShotLength ?? '—'}s | ${video.aspect} | ${video.bpm ?? '—'} | ${signatureZh(video.grading)} | ${video.titleCard ? '是' : '否'} | ${video.subtitles ? '是' : '否'} |`)
  })
  lines.push('')

  const failed = Array.isArray(corpus.warnings) ? corpus.warnings.filter(Boolean) : []
  if (failed.length > 0) {
    lines.push('## 提示')
    for (const warning of failed.slice(0, 12)) lines.push(`- ${warning}`)
    if (failed.length > 12) lines.push(`- …另有 ${failed.length - 12} 条`)
  }
  return tidy(lines.join('\n'))
}

/** A short prose version of the profile for the top of the corpus report. */
function profileMarkdownSummary(profile) {
  const lines = []
  const aspectZh = profile.format.aspect === 'vertical' ? '竖屏' : profile.format.aspect === 'square' ? '方形' : '横屏'
  lines.push(`- 规格：${aspectZh} ${profile.format.resolutionMode ?? '未知分辨率'} @ ${profile.format.fpsMode ? Math.round(profile.format.fpsMode) : '?'}fps；单条时长中位数 ${profile.duration.median ?? '—'} 秒（${profile.duration.min ?? '—'}–${profile.duration.max ?? '—'}）。`)
  lines.push(`- 节奏：平均镜头 ${profile.pacing.avgShotLengthMedian ?? '—'} 秒（四分位 ${profile.pacing.avgShotLengthP25 ?? '—'}–${profile.pacing.avgShotLengthP75 ?? '—'}），每分钟 ${profile.pacing.cutRateMedian ?? '—'} 次剪辑；硬切占 ${profile.transitions.hardCutShareMedian === null ? '—' : pct(profile.transitions.hardCutShareMedian)}。`)
  lines.push(`- 运镜：${distributionLine(profile.camera, motionZh)}。`)
  lines.push(`- 调色：${distributionLine(profile.grading.signatures, (key) => SIGNATURE_ZH[key] ?? key)}；色温 ${distributionLine(profile.grading.temperature, (key) => (key === 'warm' ? '暖' : key === 'cool' ? '冷' : '中性'))}。`)
  lines.push(`- 声音：音乐 ${pct(profile.sound.musicRate)}${profile.sound.bpmMedian !== null ? `（BPM 中位数 ${profile.sound.bpmMedian}，${profile.sound.bpmMin}–${profile.sound.bpmMax}）` : ''}；人声 ${pct(profile.sound.speechRate)}；卡点率中位数 ${profile.sound.beatSyncMedian === null ? '—' : pct(profile.sound.beatSyncMedian)}；响度中位数 ${profile.sound.loudnessMedian ?? '—'} LUFS。`)
  lines.push(`- 包装：标题卡 ${pct(profile.overlays.titleCardRate)}，字幕 ${pct(profile.overlays.subtitleRate)}；前 3 秒内有剪辑 ${pct(profile.hook.earlyCutRate)}。`)
  return lines
}

/**
 * What the builder produced, plus an optional verification pass measured with
 * the same analyzer used on the references.
 *
 * @param {object} result BuildResult from lib/build.js
 * @param {{plan?: object, verify?: object|null, verifyError?: string}} meta
 */
export function renderBuildReport(result, meta = {}) {
  const lines = []
  lines.push('# 视频合成结果')
  lines.push('')
  lines.push(`输出文件: \`${result.output}\``)
  lines.push(`规格: ${formatTimecode(result.duration)} · ${result.width}×${result.height} @ ${num(result.fps, 0, ' fps')} · ${result.scenes ?? (meta.plan?.scenes?.length ?? 0)} 个场景 · ${formatBytes(result.bytes)}`)
  lines.push(`渲染耗时: ${num(result.renderSeconds, 1)} 秒`)
  const audio = result.audio ?? {}
  const audioParts = []
  if (audio.music === true) audioParts.push('背景音乐')
  if (Number.isFinite(Number(audio.voiceoverSegments)) && audio.voiceoverSegments > 0) audioParts.push(`旁白 ${audio.voiceoverSegments} 段`)
  if (audio.loudnessNormalized === true) audioParts.push('响度已归一化')
  lines.push(`音频: ${audioParts.length > 0 ? audioParts.join(' · ') : '静音轨'}`)
  // Vision mode: point at the embedded head/middle/tail strip before the numbers.
  const vision = visionTarget(meta)
  const stripNote = vision ? filmstripNote(meta) : undefined
  if (stripNote !== undefined) lines.push(stripNote)
  lines.push('')

  if (Array.isArray(result.timeline) && result.timeline.length > 0) {
    lines.push('## 时间线')
    lines.push('| # | 类型 | 起 | 止 | 时长 |')
    lines.push('|---|------|----|----|------|')
    for (const segment of result.timeline) {
      lines.push(`| ${(segment.index ?? 0) + 1} | ${segment.type ?? '—'} | ${formatTimecode(segment.start)} | ${formatTimecode(segment.end)} | ${num((segment.end ?? 0) - (segment.start ?? 0), 2, 's')} |`)
    }
    lines.push('')
  }

  const verify = meta.verify
  if (verify !== null && typeof verify === 'object') {
    lines.push('## 自检（用同一套感知工具复核成片）')
    const craft = verify.craft ?? {}
    const rhythm = craft.cutRhythm ?? {}
    lines.push(`- 镜头数 ${verify.shots ?? '—'} · 平均镜头 ${num(rhythm.avgShotLength, 2)} 秒 · 每分钟 ${num(rhythm.cutRatePerMin, 1)} 次剪辑`)
    // The grading signature is an adjective judgement; a vision model reads the
    // colours off the strip itself, so vision mode keeps only the numbers.
    if (stripNote === undefined && Array.isArray(craft.grading?.signature)) lines.push(`- 调色标签：${signatureZh(craft.grading.signature)}`)
    if (typeof craft.beatSync?.cutsOnBeatRatio === 'number' && Number.isFinite(craft.beatSync.cutsOnBeatRatio)) lines.push(`- 卡点率：${pct(craft.beatSync.cutsOnBeatRatio)}`)
    if (Number.isFinite(Number(verify.brightness))) lines.push(`- 平均亮度 ${num(verify.brightness, 2)} · 平均运动量 ${num(verify.motion, 1)} / 100`)
    const plannedScenes = Array.isArray(meta.plan?.scenes) ? meta.plan.scenes.length : 0
    const measuredShots = Number(verify.shots) || 0
    if (plannedScenes > 1 && measuredShots < plannedScenes) {
      lines.push(`- 说明：分镜有 ${plannedScenes} 个场景，感知统计到 ${measuredShots} 个镜头——因为成片用淡入/滑动等渐变转场衔接，硬切检测不会把渐变算成切点。想要更强的「镜头切换感」，把对应场景的 transitionIn 改成 cut。`)
    }
    const targets = meta.targets
    if (targets !== null && typeof targets === 'object') {
      const diffs = []
      if (Number.isFinite(Number(targets.avgShotLength)) && Number.isFinite(Number(rhythm.avgShotLength))) {
        diffs.push(`目标镜头长 ${targets.avgShotLength}s vs 实测 ${num(rhythm.avgShotLength, 2)}s`)
      }
      if (Number.isFinite(Number(targets.bpm)) && Number.isFinite(Number(verify.bpm))) {
        diffs.push(`目标 BPM ${targets.bpm} vs 实测 ${num(verify.bpm, 1)}`)
      }
      if (diffs.length > 0) lines.push(`- 与目标对比：${diffs.join(' · ')}`)
    }
    lines.push('')
  } else if (typeof meta.verifyError === 'string') {
    lines.push('## 自检')
    lines.push(`- 自检未完成：${meta.verifyError}`)
    lines.push('')
  }

  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    lines.push('## 提示')
    for (const warning of result.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }

  lines.push('## 下一步')
  lines.push('- 想确认「像不像」：把成片 `path` 传给 `media_watch_video`，对比镜头长度/调色/卡点率与参考画像。')
  lines.push('- 想批量产出：把同一 RenderPlan 换掉文字与素材，重复调用 `media_build_video`。')
  return tidy(lines.join('\n'))
}

/**
 * A synthesized narration take.
 *
 * @param {{path: string, seconds: number, voice: string, ok: boolean, warnings?: string[]}} info
 * @param {{text: string}} meta
 */
export function renderTtsReport(info, meta) {
  const lines = []
  lines.push('# 旁白合成')
  lines.push('')
  lines.push(`文本: ${String(meta.text ?? '').slice(0, 300)}`)
  lines.push(`音频: \`${info.path}\``)
  lines.push(`时长: ${num(info.seconds, 2, ' 秒')} · 声部: ${info.voice}`)
  if (Array.isArray(info.warnings) && info.warnings.length > 0) {
    lines.push('')
    lines.push('## 提示')
    for (const warning of info.warnings) lines.push(`- ${warning}`)
  }
  lines.push('')
  lines.push('可以直接把这个 wav 作为 `media_build_video` 的 `audio.voiceover[].src`，或者用 `text` 让渲染器自己合成。')
  return tidy(lines.join('\n'))
}

export { signatureZh, motionZh }

/* ----------------------------------------------------------- style library */

/**
 * Style catalogue listing / search / detail.
 *
 * @param {object} payload
 * @param {'search'|'show'|'list'} payload.action
 * @param {Array<object>} [payload.entries]
 * @param {object} [payload.style]
 * @param {Array<object>} [payload.series]
 * @param {string} [payload.skillDir]
 * @param {string} [payload.query]
 */
export function renderStylesReport(payload) {
  const lines = []
  const action = payload.action ?? 'search'
  lines.push('# 代码动画风格库 · code-animation-prompts')
  lines.push('')
  lines.push(`技能目录: \`${payload.skillDir}\``)
  lines.push('')

  if (action === 'list') {
    lines.push('## 系列总览')
    lines.push('| 系列 | 名称 | 条目数 | 带参考静帧 |')
    lines.push('|------|------|--------|------------|')
    for (const series of payload.series ?? []) {
      lines.push(`| ${series.id} | ${series.name || '—'} | ${series.count} | ${series.withImage ?? '—'} |`)
    }
    lines.push('')
    lines.push('用 `media_styles` 的 `query` 搜索气质（如「水墨」「粒子」「赛博」「极简」），或直接用 `id` 精确取用。')
    return tidy(lines.join('\n'))
  }

  if (action === 'show') {
    const style = payload.style
    if (style === undefined || style === null) {
      lines.push(`未找到风格 ${payload.query ?? ''}。用 \`media_styles\` 先搜索。`)
      return tidy(lines.join('\n'))
    }
    const entry = style.entry ?? {}
    lines.push(`## ${entry.id} · ${entry.name}`)
    lines.push('')
    lines.push(`系列 ${entry.series ?? '—'} · 分类 ${entry.category ?? '—'} · 标签 ${(entry.tags ?? []).join('、') || '—'}`)
    if (entry.description) lines.push(`气质：${entry.description}`)
    if (entry.fit) lines.push(`适合：${entry.fit}`)
    if (style.imagePath) lines.push(`参考静帧: \`${style.imagePath}\`${style.imageBytes ? `（${Math.round(style.imageBytes / 1024)} KB）` : ''}`)
    lines.push('')
    lines.push('## 风格提示词（原文）')
    lines.push('```markdown')
    lines.push(String(style.prompt ?? '').slice(0, 6000))
    lines.push('```')
    lines.push('')
    lines.push('## 落地方式')
    lines.push('1. 按提示词写一个 HTML 动画，必须实现 `window.renderAt(t)`：画面完全由秒数 t 决定，`?export=1` 时关闭 rAF/CSS 自播放，随机数用固定种子。')
    lines.push('2. 用 `media_animate` 把 HTML 渲染成 MP4 片段：`{ html_path, duration, fps, width, height, output }`。')
    lines.push('3. 用 `media_build_video` 把片段作为 `{ "type": "video", "src": "<片段路径>", "duration": 4 }` 场景拼进成片。')
    lines.push('')
    lines.push('> 也可以直接复制技能里的 `assets/starter/index.html` 作为骨架（它演示了 renderAt 接口，但不是这 341 个风格之一）。')
    return tidy(lines.join('\n'))
  }

  lines.push(`## 搜索结果${payload.query ? ` · ${payload.query}` : ''}`)
  lines.push('')
  const entries = payload.entries ?? []
  if (entries.length === 0) {
    lines.push('没有匹配的风格；换一个气质词（如「粒子」「水墨」「霓虹」「纸张」「极简」）或直接列系列。')
    return tidy(lines.join('\n'))
  }
  lines.push('| 编号 | 名称 | 系列 | 气质 | 适合 |')
  lines.push('|------|------|------|------|------|')
  for (const entry of entries) {
    lines.push(`| ${entry.id} | ${entry.name} | ${entry.series} | ${entry.description ?? '—'} | ${entry.fit ?? '—'} |`)
  }
  lines.push('')
  lines.push('下一步：用 `media_styles { action: "show", id: "<编号>" }` 读取完整提示词与参考静帧。')
  return tidy(lines.join('\n'))
}

/**
 * HTML animation render result.
 *
 * @param {object} result renderAnimation() output
 * @param {{styleId?: string, htmlPath: string, previewPath?: string}} meta
 */
export function renderAnimateReport(result, meta) {
  const lines = []
  lines.push('# 代码动画渲染结果')
  lines.push('')
  lines.push(`输出: \`${result.output}\``)
  lines.push(`规格: ${formatTimecode(result.duration)} · ${result.width}×${result.height} @ ${num(result.fps, 0, ' fps')} · ${result.frames ?? '—'} 帧 · ${formatBytes(result.bytes)}`)
  lines.push(`渲染耗时: ${num(result.renderSeconds, 1)} 秒`)
  if (meta.styleId) lines.push(`风格编号: ${meta.styleId}`)
  lines.push(`HTML: \`${meta.htmlPath}\``)
  if (meta.previewPath) lines.push(`预览帧: \`${meta.previewPath}\``)
  // Vision mode: the head/middle/tail strip is the thing to look at first.
  const stripNote = visionTarget(meta) ? filmstripNote(meta) : undefined
  if (stripNote !== undefined) lines.push(stripNote)
  lines.push('')
  lines.push('## 拼进成片')
  lines.push('把这段作为场景交给 `media_build_video`：')
  lines.push('```json')
  lines.push(JSON.stringify({ type: 'video', duration: Math.round((result.duration ?? 0) * 10) / 10, src: result.output, fit: 'cover', muted: true, transitionIn: 'fade', transitionDuration: 0.5 }, null, 1))
  lines.push('```')
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    lines.push('')
    lines.push('## 提示')
    for (const warning of result.warnings) lines.push(`- ${warning}`)
  }
  return tidy(lines.join('\n'))
}


/* --------------------------------------------------------- change selection */

/**
 * "Where did the picture actually change" block appended to a video report.
 *
 * The optional `meta.target` only changes the follow-up line: in vision mode a
 * brightness/hue art does not exist any more, so it points at `region` crops.
 *
 * @param {{selected: Array<{time:number, reason:string, score:number}>, cuts: number[], mean: number, p95: number, fps?: number, scoreCurve?: number[]}} change
 * @param {{target?: 'blind'|'vision'}} [meta]
 */
export function renderChangeSection(change, meta = {}) {
  if (change === null || typeof change !== 'object') return ''
  const vision = visionTarget(meta)
  const selected = Array.isArray(change.selected) ? change.selected : []
  const lines = []
  lines.push('## 画面变化（按信息量选帧）')
  const stats = []
  if (Number.isFinite(Number(change.mean))) stats.push(`平均变化分 ${num(change.mean, 1)}`)
  if (Number.isFinite(Number(change.p95))) stats.push(`P95 ${num(change.p95, 1)}`)
  if (Number.isFinite(Number(change.p95)) || Number.isFinite(Number(change.mean))) stats.push('（0–255，静止画面接近 0）')
  if (stats.length > 0) lines.push(`- 统计：${stats.join(' · ')}`)
  if (Array.isArray(change.cuts) && change.cuts.length > 0) lines.push(`- 硬切换（尖峰）：${change.cuts.slice(0, 12).map((t) => formatTimecode(t)).join('、')}${change.cuts.length > 12 ? ` 等 ${change.cuts.length} 处` : ''}`)
  if (selected.length > 0) {
    const reasonZh = { cut: '硬切', integrated: '累积运动', fallback: '兜底' }
    lines.push(`- 建议细看的时间点（${selected.length} 个，按信息量挑选）：${selected.slice(0, 14).map((item) => `${formatTimecode(item.time)}(${reasonZh[item.reason] ?? item.reason}${Number.isFinite(Number(item.score)) ? ` ${num(item.score, 0)}` : ''})`).join(' · ')}`)
    lines.push(vision
      ? '> 想细看某一刻：用 `media_frame` 指定 `time`，可选 `region`（"x,y,w,h" 原图像素）取局部放大。'
      : '> 对其中任一时刻用 `media_frame` 可以看高清原图与更细的亮度/色相图。')
  } else {
    lines.push('- 这段时间几乎没有变化（静止画面），没有额外的变化点。')
  }
  if (Array.isArray(change.scoreCurve) && change.scoreCurve.length > 3) {
    lines.push(`- 变化曲线：${sparkline(change.scoreCurve, 60)}`)
  }
  return tidy(lines.join('\n'))
}

/* --------------------------------------------------------------- media_see */

/**
 * Report for the live-screen tools.
 *
 * @param {object} payload
 */
export function renderSeeReport(payload) {
  const lines = []
  const vision = visionTarget(payload)
  if (payload.action === 'status') {
    lines.push('# 看屏幕 · 状态')
    lines.push('')
    lines.push(`- 平台采集：${payload.screenSupported ? '可用' : '不可用'}`)
    if (Array.isArray(payload.engines) && payload.engines.length > 0) lines.push(`- 采集引擎：${payload.engines.join(' / ')}`)
    lines.push(`- 默认档位：${payload.quality ?? 'low'}（画面长边 ${payload.longEdge ?? '—'}px）`)
    lines.push(`- 变化量选帧：${payload.changeAvailable ? '可用' : '不可用'}`)
    lines.push(`- 拼图 token 估算：每张约 ${payload.tokenEstimate ?? '—'} token（42px 对齐）`)
    if (Array.isArray(payload.warnings) && payload.warnings.length > 0) {
      lines.push('')
      for (const warning of payload.warnings) lines.push(`- ${warning}`)
    }
    return tidy(lines.join('\n'))
  }

  lines.push(`# 看屏幕 · ${payload.action === 'peek' ? '当前画面' : `最近 ${num(payload.seconds, 1)} 秒`}`)
  lines.push('')
  lines.push(`采集：${payload.engine ?? '未知引擎'} · ${payload.width ?? '?'}×${payload.height ?? '?'} · 耗时 ${num(payload.elapsedMs, 0, ' ms')}`)
  if (payload.region) lines.push(`区域：${payload.region}`)
  lines.push('')

  if (payload.action === 'peek') {
    const summary = payload.summary ?? {}
    lines.push('## 画面指标')
    if (vision) {
      // Numbers only: the screenshot carries layout and colour now.
      lines.push(`- 亮度 ${num(summary.brightness, 2)} · 彩度 ${num(summary.saturation, 2)} · 主色 ${hueZh(summary.hueName)} ${summary.hueHex ?? ''}`)
      lines.push(`- 对比度 ${num(summary.contrast, 2)} · 边缘密度 ${num(summary.edgeDensity, 2)}`)
      lines.push('')
      lines.push('截图已内嵌，请直接读出屏幕上的文字与关键 UI 元素')
      lines.push('')
      lines.push('## 观察清单（用眼睛回答）')
      const tasks = [
        '当前在哪个应用/页面？标题栏、标签页与地址栏写的是什么？',
        '读出屏幕上所有可读文字（菜单、按钮、输入框、正文、悬浮提示），并注明语言。',
        '有没有报错、警告、弹窗、进度条或加载中状态？内容是什么？',
        '当前焦点在哪个控件上？界面是空闲、编辑中还是等待确认？',
        '如果文字太小看不清，用 `media_frame` 带 `region`（"x,y,w,h" 屏幕像素）取局部放大。',
      ]
      tasks.forEach((task, index) => lines.push(`${index + 1}. ${task}`))
      return tidy(lines.join('\n'))
    }
    lines.push(`- 亮度 ${num(summary.brightness, 2)}（${brightnessZh(summary.brightness)}）· 彩度 ${num(summary.saturation, 2)}（${saturationZh(summary.saturation)}）· 主色 ${hueZh(summary.hueName)} ${summary.hueHex ?? ''}`)
    lines.push(`- 对比度 ${num(summary.contrast, 2)} · 边缘密度 ${num(summary.edgeDensity, 2)}（${summary.edgeDensity > 0.45 ? '纹理极密集' : summary.edgeDensity > 0.25 ? '文字/细节很多' : summary.edgeDensity > 0.1 ? '细节适中' : '画面简洁'}）`)
    lines.push(`- 版式：${payload.layout ?? summary.layout ?? '—'}`)
    lines.push('')
    if (typeof payload.ascii === 'string' && payload.ascii.length > 0) {
      const art = fitArt(payload.ascii, 56, 18)
      if (art.includes('\n')) {
        lines.push('## 亮度图（空格最暗，`@` 最亮）')
        lines.push('```')
        lines.push(art)
        lines.push('```')
        lines.push('')
      }
    }
    lines.push('> 这条结果末尾已附带当前屏幕的截图（模型支持图片时直接可看）。')
    return tidy(lines.join('\n'))
  }

  // watch
  if (Number.isFinite(Number(payload.frameCount))) lines.push(`捕获 ${payload.frameCount} 帧 → 按变化量保留 ${payload.kept ?? 0} 帧（${payload.selectionRule ?? '变化分'}）`)
  if (Number.isFinite(Number(payload.tokenEstimate))) lines.push(`拼图：${payload.columns ?? '?'}×${payload.rows ?? '?'} 格 · ${payload.sheetWidth ?? '?'}×${payload.sheetHeight ?? '?'} · 约 ${payload.tokenEstimate} token`)
  lines.push('')
  if (Array.isArray(payload.shots)) {
    lines.push('## 保留的画面（按时间）')
    lines.push('| # | 时间 | 变化分 | 原因 |')
    lines.push('|---|------|--------|------|')
    const reasonZh = { cut: '画面切换', integrated: '持续运动', fallback: '兜底采样' }
    payload.shots.forEach((shot, index) => {
      const scoreText = shot.score === null || shot.score === undefined ? '—' : num(shot.score, 1)
      lines.push(`| ${index + 1} | ${formatTimecode(shot.time ?? 0)} | ${scoreText} | ${reasonZh[shot.reason] ?? shot.reason ?? '—'} |`)
    })
    lines.push('')
  }
  if (typeof payload.changeError === 'string' && payload.changeError.length > 0) {
    lines.push(`> 变化量选帧不可用，已退回均匀采样：${payload.changeError}`)
    lines.push('')
  }
  if (Array.isArray(payload.changes) && payload.changes.length > 0 && !vision) {
    lines.push('## 这期间屏幕怎么动的')
    for (const entry of payload.changes.slice(0, 12)) lines.push(`- ${entry}`)
    lines.push('')
  }
  lines.push(vision
    ? '> 图注: 每格是一次界面变化，按行优先（左上→右下）逐行排列，与上表顺序一致。'
    : '> 拼图按左上→右下、逐行排列，与上表顺序一致；末尾附带了这张拼图。')
  return tidy(lines.join('\n'))
}

