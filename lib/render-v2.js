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
import { renderAdapterTable } from './adapters.js'

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

/**
 * A Chinese label for a style section role, falling back to the raw heading.
 *
 * The library's headings are English in the Lemo series and Chinese elsewhere;
 * a stable Chinese label reads better in a Chinese report and does not depend on
 * which source the style came from.
 */
const ROLE_ZH_LABELS = {
  essence: '本质',
  signature: '签名特征',
  materials: '材质与渲染',
  colour: '配色逻辑',
  type: '字体与字幕',
  motion: '运动质量',
  camera: '镜头语法',
  sound: '声音调色板',
  moves: '签名动作',
  pitfalls: '常见坑',
  engine: '实现路线',
  variation: '可变空间',
  output: '输出规格',
}

function headingLabel(heading, role) {
  const label = ROLE_ZH_LABELS[role]
  if (label !== undefined) return label
  const cleaned = String(heading ?? '').replace(/^\d+\s*[.)、]\s*/u, '').trim()
  return cleaned.length > 0 ? cleaned : (role ?? '其他')
}

/**
 * Collapse a Markdown block into one readable line for a bullet.
 *
 * Style sections run to paragraphs; a bullet that carries the first meaningful
 * sentence is far more useful to a model than 400 characters of table syntax.
 */
function oneLine(text, limit = 160) {
  const flat = String(text ?? '')
    .replace(/\r?\n+/gu, ' ')
    // Strip Markdown list bullets and heading hashes so a bullet does not start
    // with "- " or contain "## ".
    .replace(/(?:^|\s)[-*+]\s+/gu, ' ')
    .replace(/[|#`>]/gu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim()
  if (flat.length === 0) return '—'
  if (flat.length <= limit) return flat
  // Prefer cutting at a sentence boundary so the excerpt still reads.
  const head = flat.slice(0, limit)
  const stop = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('. '))
  return stop > limit * 0.5 ? `${head.slice(0, stop + 1)}…` : `${head}…`
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
    lines.push('> 运镜映射：`media_build_video` 的图片场景支持 none / kenburns-in / kenburns-out / pan-left / pan-right / pan-up / pan-down（`tilt-up|tilt-down` 与 pan-up/down 等价）；`zoom-in|zoom-out|handheld` 改用 `media_animate` 生成代码动画片段，或用最接近的 kenburns/pan 代替。')
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
 * Pre-render layout audit: what will look broken before any pixel is rendered.
 *
 * Errors are things that visibly break (clipped text, overflowing blocks);
 * warnings are judgement calls (small type, a caption near a title). The section
 * is skipped entirely when the audit is clean, so a good plan reads cleanly.
 */
function renderLintSection(lines, lint) {
  if (lint === null || lint === undefined || typeof lint !== 'object') return
  const violations = Array.isArray(lint.violations) ? lint.violations : []
  if (violations.length === 0) return
  const errors = violations.filter((violation) => violation.severity === 'error')
  const warnings = violations.filter((violation) => violation.severity !== 'error')
  lines.push('## 版式体检（渲染前静态检查）')
  lines.push('')
  lines.push(`**${errors.length === 0 ? '没有会明显出错的问题' : `${errors.length} 处会明显出错`}**${warnings.length > 0 ? ` · ${warnings.length} 处建议改` : ''}`)
  lines.push('')
  lines.push('| 级别 | 位置 | 问题 |')
  lines.push('|------|------|------|')
  const label = { error: '错误', warn: '建议' }
  for (const violation of violations.slice(0, 12)) {
    lines.push(`| ${label[violation.severity] ?? violation.severity} | ${violation.where ?? violation.scene ?? '—'} | ${violation.messageZh} |`)
  }
  if (violations.length > 12) lines.push(`| … | | 另有 ${violations.length - 12} 条 |`)
  lines.push('')
}

/**
 * The case-based aesthetic audit, rendered on the plan before the render.
 *
 * Only rules that produced a verdict are listed: the 16 rules that need human or
 * vision judgement are counted in one line rather than padded out with "skipped",
 * because a wall of skips teaches the reader to ignore the section. Every failure
 * carries its frame evidence — `R4 ✗(frames 302, 480)` is actionable, "节奏不好"
 * is not.
 */
function renderAestheticSection(lines, aesthetic) {
  if (aesthetic === null || aesthetic === undefined || typeof aesthetic !== 'object') return
  const rows = Array.isArray(aesthetic.rows) ? aesthetic.rows : []
  const failures = rows.filter((row) => row.verdict === 'fail')
  const warnings = rows.filter((row) => row.verdict === 'warn')
  const passes = rows.filter((row) => row.verdict === 'pass')
  const skipped = rows.filter((row) => row.verdict === 'skip')
  if (failures.length === 0 && warnings.length === 0) {
    lines.push('## 审美准则（渲染前审计）')
    lines.push('')
    lines.push(`可机器判定的 ${passes.length} 条全部通过；另有 ${skipped.length} 条需要人/视觉判断，本次不判定（不是通过）。`)
    lines.push('')
    return
  }
  lines.push('## 审美准则（渲染前审计）')
  lines.push('')
  lines.push(`**${failures.length} 条失败** · ${warnings.length} 条提醒 · ${passes.length} 条通过 · ${skipped.length} 条不可机器判定`)
  lines.push('')
  lines.push('| 规则 | 判定 | 证据 |')
  lines.push('|------|------|------|')
  for (const row of [...failures, ...warnings].slice(0, 10)) {
    const mark = row.verdict === 'fail' ? '✗' : '!'
    const framePart = Array.isArray(row.frames) && row.frames.length > 0 ? `（帧 ${row.frames.join(', ')}）` : ''
    lines.push(`| ${row.id} ${mark} | ${row.verdict === 'fail' ? '失败' : '提醒'} | ${String(row.evidenceZh ?? '').slice(0, 160)}${framePart} |`)
  }
  if (failures.length + warnings.length > 10) lines.push(`| … | | 另有 ${failures.length + warnings.length - 10} 条 |`)
  lines.push('')
  lines.push('失败项在成片里会真的看得出来，建议改完计划再渲；提醒项是取舍，可以保留但要能说出理由。')
  lines.push('')
}

/**
 * The acceptance gate: does this cut read as a film, or as cards flipping?
 *
 * Placed after the self-check numbers because it is the *verdict* on them. PASS
 * is stated once and flatly; anything else gets the measured number and the one
 * change that would fix it, because a gate that only says "FAIL" teaches nothing.
 */
function renderGateSection(lines, gate) {
  if (gate === null || gate === undefined || typeof gate !== 'object') return
  const legs = Array.isArray(gate.legs) ? gate.legs : []
  if (legs.length === 0) return
  const failed = legs.filter((leg) => leg.state === 'FAIL')
  const warned = legs.filter((leg) => leg.state === 'WARN')
  lines.push('## 验收门禁（它像片，还是像 PPT）')
  if (gate.verdict === 'PASS' && warned.length === 0) {
    lines.push(`**通过**：${legs.filter((leg) => leg.state === 'PASS').length} 项全过——节奏有变化、有停顿、有爆发、音频有余量。`)
    lines.push('')
    return
  }
  lines.push(`**判定：${gate.verdict === 'PASS' ? '通过（有提醒）' : '未通过'}** —— ${legs.filter((leg) => leg.state === 'PASS').length} 过 · ${warned.length} 提醒 · ${failed.length} 未过`)
  lines.push('')
  lines.push('| 项 | 结果 | 实测 |')
  lines.push('|----|------|------|')
  const stateZh = { PASS: '通过', WARN: '提醒', FAIL: '未过', SKIP: '跳过' }
  for (const leg of legs) lines.push(`| ${leg.title ?? leg.id} | ${stateZh[leg.state] ?? leg.state} | ${leg.detail} |`)
  lines.push('')
  if (failed.length > 0) {
    lines.push('**先改这几项**：')
    for (const leg of failed.slice(0, 4)) lines.push(`- ${leg.title}：${leg.detail}`)
    lines.push('')
  }
  if (warned.length > 0 && failed.length === 0) {
    lines.push('**可以保留，但要知道代价**：')
    for (const leg of warned.slice(0, 4)) lines.push(`- ${leg.title}：${leg.detail}`)
    lines.push('')
  }
}

/** Flat one-line gate verdict for tool results (no Markdown table). */
export function gateSummaryLine(gate) {
  if (gate === null || gate === undefined || typeof gate !== 'object') return undefined
  const legs = Array.isArray(gate.legs) ? gate.legs : []
  if (legs.length === 0) return undefined
  const stateZh = { PASS: '通过', WARN: '提醒', FAIL: '未过', SKIP: '跳过' }
  const parts = legs.map((leg) => `${leg.title}${stateZh[leg.state] ?? leg.state}`)
  const verdict = gate.verdict === 'PASS' ? '通过' : '未通过'
  return `验收门禁${verdict}：${parts.join(' · ')}`
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

  renderLintSection(lines, meta.lint)
  renderAestheticSection(lines, meta.aesthetic)
  renderGateSection(lines, verify?.gate)

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

/* --------------------------------------------------------------- sound design */

/**
 * The sound-effect palette, a single synthesized effect, or a rapid-fire plan.
 *
 * The report always leads with *where the peak sits* rather than where the file
 * starts, because that is the number that decides whether a hit lands on the
 * action: an impact whose energy peak is 80 ms in, placed by file head, arrives
 * as a late thud. Every line that mentions placement says so.
 *
 * @param {object} payload
 * @param {'list'|'render'|'sequence'} payload.action
 * @param {Array<object>} [payload.palette]
 * @param {object} [payload.info] render result
 * @param {Array<object>} [payload.schedule] sequence result
 * @param {object} [payload.request]
 */
export function renderSfxReport(payload) {
  const lines = []
  const action = payload.action ?? 'list'

  if (action === 'list') {
    lines.push('# 音效调色板（程序化合成，离线、确定性、零依赖）')
    lines.push('')
    lines.push('| 音色 | 族 | 时长 | 该配什么画面 |')
    lines.push('|---|---|---|---|')
    for (const entry of payload.palette ?? []) {
      const span = Array.isArray(entry.duration) ? `${entry.duration[0]}–${entry.duration[1]}s` : '—'
      lines.push(`| \`${entry.kind}\` | ${entry.family ?? '—'} | ${span} | ${entry.actionZh ?? '—'} |`)
    }
    lines.push('')
    lines.push('**怎么用**：给 `media_build_video` 的 `audio.sfx` 写 `{kind, beat}` 或 `{kind, at}`，渲染器会现场合成、')
    lines.push('按能量峰值对齐（不是按文件头对齐），并自动扣掉渲染管线的音轨偏移。也可以先用本工具的 `render`')
    lines.push('导出 wav 试听，再自己指定 `src`。')
    return tidy(lines.join('\n'))
  }

  if (action === 'render') {
    const info = payload.info ?? {}
    lines.push('# 音效合成')
    lines.push('')
    lines.push(`音色: \`${info.kind}\``)
    if (typeof info.path === 'string') lines.push(`文件: \`${info.path}\``)
    lines.push(`时长: ${num(info.duration, 3, ' 秒')} · 采样率: ${num(info.sampleRate, 0, ' Hz')} · 峰值: ${num(info.peakDb, 1, ' dBFS')}`)
    if (Number.isFinite(info.peakSeconds)) {
      lines.push(`能量峰值: ${num(info.peakSeconds, 3, ' 秒')}（占全长 ${Math.round((info.peakFraction ?? 0) * 100)}%）`)
      lines.push('')
      lines.push('**放置方式**：把峰值对上画面动作，不是把文件头对上动作。')
      lines.push('也就是 `起始时刻 = 目标峰值时刻 − 上面这个峰值滞后`；渲染器拿到 `kind` 时会自动做这件事。')
    }
    return tidy(lines.join('\n'))
  }

  lines.push('# 连发音效计划（防机枪感）')
  lines.push('')
  lines.push('| # | 音色 | 音量 | 相对起点 | 绝对起点 |')
  lines.push('|---|---|---|---|---|')
  for (const entry of payload.schedule ?? []) {
    lines.push(
      `| ${entry.index + 1} | \`${entry.kind}\` | ${num(entry.volume, 2)} | ${num(entry.offsetMs, 0, ' ms')} | ${num(entry.atSeconds, 3, ' s')} |`,
    )
  }
  lines.push('')
  lines.push('连发靠三件事避免机械复读：**双样本交替**（同音色不同种子）、**音量阶梯递减**、**间隔按动画曲线加速**。')
  lines.push('密到听不清时应该收成一条 swoosh 或淡出，而不是继续叠料。')
  return tidy(lines.join('\n'))
}

/* ---------------------------------------------------------------- beat grid */

/**
 * Round to `digits` and keep it a **number**.
 *
 * `num()` from render.js is for display and returns a string, which is right in
 * prose but wrong inside a JSON snippet the model is meant to copy verbatim — a
 * quoted `"120.04"` would arrive as a string in the plan.
 */
function rounded(value, digits) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const factor = 10 ** digits
  return Math.round(number * factor) / factor
}

/**
 * The measured beat grid, in the shape a RenderPlan can consume verbatim.
 *
 * The whole point of this section is that the model should never have to compute
 * frame numbers from a BPM: it copies `plan.beatGrid` and then writes every cut
 * and every sound effect in *beat numbers*. That is also what makes re-timing a
 * film cheap — change one constant and the whole timeline re-locks.
 *
 * The residual is printed before anything the reader could act on, because an
 * unqualified grid is worse than no grid: a cut placed on a wrong grid is
 * confidently wrong.
 *
 * @param {object} grid
 * @param {number} [grid.bpm]
 * @param {number} [grid.t0]
 * @param {number} [grid.period]
 * @param {number} [grid.count]
 * @param {number} [grid.residualMaxMs]
 * @param {number} [grid.residualRmsMs]
 * @param {boolean} [grid.pass]
 * @param {string} [grid.reasonZh]
 * @param {Array<object>} [grid.candidates]
 * @param {number} [opts.fps]
 */
export function renderBeatGridSection(grid, opts = {}) {
  const fps = Number.isFinite(opts.fps) && opts.fps > 0 ? opts.fps : 30
  const lines = []
  lines.push('## 卡点网格（可直接写进 RenderPlan）')
  lines.push('')
  if (grid === null || grid === undefined || !Number.isFinite(Number(grid.period))) {
    lines.push('没有测出可用的节拍网格（音频里没有稳定鼓点，或分析片段太短）。')
    lines.push('这种情况下按内容节奏剪辑即可，不要强行卡点。')
    return tidy(lines.join('\n'))
  }
  const residual = Number(grid.residualMaxMs)
  const rms = Number(grid.residualRmsMs)
  lines.push(
    `BPM（最小二乘拟合，不是 tempo 标量）: ${num(grid.bpm, 2)} · 拍长 ${num(grid.period, 5, ' s')} · ` +
      `第 0 拍在 ${num(grid.t0, 4, ' s')} · ${num(grid.count, 0, ' 拍')}`,
  )
  lines.push(`网格残差: 最大 ${num(residual, 2, ' ms')} / RMS ${num(rms, 2, ' ms')}（≤15 ms 才算机器鼓点）`)
  if (Number.isFinite(residual) && residual > 15) {
    lines.push('')
    lines.push(`**这条网格没过验收**：残差 ${num(residual, 2, ' ms')} 超过 ±15 ms，说明曲子在变速，或拍序列不连续。`)
    lines.push('要么分段各自拟合（每段一套 t0/period），要么按内容节奏剪——按这条网格卡点会把误差一起写进成片。')
  }
  if (typeof grid.reasonZh === 'string' && grid.reasonZh.length > 0) {
    lines.push('')
    lines.push(`候选消歧: ${grid.reasonZh}`)
  }
  lines.push('')
  lines.push('### 复制这个进计划')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify({
    beatGrid: {
      bpm: rounded(grid.bpm, 2),
      t0: rounded(grid.t0, 4),
      period: rounded(grid.period, 5),
      outputOffsetSeconds: 0,
    },
  }, null, 2))
  lines.push('```')
  lines.push('')
  lines.push('`outputOffsetSeconds` 先填 0：它是**渲染管线**的音轨偏移，不是音乐本身的属性。真要用在卡点片上时，')
  lines.push('渲一遍、抽音轨和源文件做归一化交叉相关量出实际值再填，不要预设常数（不同编码器差得多）。')
  lines.push('')
  lines.push(`### 拍 → 帧（${fps}fps）`)
  lines.push('')
  lines.push('| 拍 | 秒 | 帧 |')
  lines.push('|---|---|---|')
  for (let n = 0; n < 9; n += 1) {
    const seconds = Number(grid.t0) + Number(grid.period) * n
    lines.push(`| ${n} | ${num(seconds, 3)} | ${Math.round(seconds * fps)} |`)
  }
  lines.push('')
  lines.push('### 怎么用（这是「卡点」和「跟着音乐抖」的分界线）')
  lines.push('')
  lines.push('- 切点和镜头时长**写拍号**（`{beat: 8}`、`shotBeats: [8,8,4]`），不写帧号；换曲只改 `beatGrid` 一处。')
  lines.push('- 全画面级冲击（整画面缩放泵/震屏/闪帧）**全片 ≤3 处**，钉在最强的几拍上，相邻两处间隔 ≥16 拍。')
  lines.push('- 其余拍点只动主角元素层（卡片/标题/数字），不要每拍都打画面——那是画面抖动，不是卡点。')
  lines.push('- SFX 用 `{kind, beat}` 写位置，渲染器会按能量峰值对齐并自动扣掉管线偏移。')
  return tidy(lines.join('\n'))
}

/* ---------------------------------------------------------------- pixel qa */

/** PSNR renders as "∞" when two frames are identical; JSON cannot carry it. */
function psnrText(value) {
  if (!Number.isFinite(Number(value))) return '∞ dB（完全一致）'
  return `${Number(value).toFixed(1)} dB`
}

const PIXEL_VERDICT_ZH = { match: '一致', close: '接近', diverge: '不同' }

/**
 * Pixel-level evidence for one sampled instant.
 *
 * Deliberately presented as **single-frame evidence**, not as a verdict on the
 * whole film: two films can differ completely at one instant and still be a good
 * reproduction, and vice versa. The whole-film verdict belongs to the numeric
 * diff above; this section answers a different question — *where* on the frame do
 * they differ, and by how much.
 *
 * @param {object} qa result of comparePixels plus refTime/builtTime/sizes
 */
export function renderPixelQaSection(qa) {
  const lines = []
  lines.push('## 像素级比对（取样时刻的单帧证据）')
  lines.push('')
  const refTime = Number(qa.refTime)
  const builtTime = Number(qa.builtTime)
  lines.push(
    `取帧：参考 ${formatTimecode(Number.isFinite(refTime) ? refTime : 0)}（${qa.refSize ?? '—'}）` +
      ` / 成片 ${formatTimecode(Number.isFinite(builtTime) ? builtTime : 0)}（${qa.builtSize ?? '—'}）`,
  )
  if (qa.refSize !== qa.builtSize) {
    lines.push(`分辨率不同，已按面积平均缩到较小帧再比（所以坐标都相对于 ${qa.builtSize ?? '较小帧'}）。`)
  }
  lines.push('')
  lines.push(
    `MAE ${num(qa.mae, 2)} · RMSE ${num(qa.rmse, 2)} · PSNR ${psnrText(qa.psnr)} · ` +
      `SSIM ${num(qa.ssim, 3)} · ΔE00 ${num(qa.deltaE00, 2)}`,
  )
  lines.push('')
  lines.push(`**判定：${PIXEL_VERDICT_ZH[qa.verdict] ?? qa.verdict}**（一致需 PSNR≥28 且 SSIM≥0.92 且 ΔE00≤3；接近需 PSNR≥22 且 SSIM≥0.80 且 ΔE00≤8）`)
  const regions = Array.isArray(qa.worstRegions) ? qa.worstRegions : []
  if (regions.length === 0) {
    lines.push('')
    lines.push('没有明显差异区块。')
    return tidy(lines.join('\n'))
  }
  lines.push('')
  lines.push('差异最大的区块：')
  lines.push('')
  lines.push('| 位置 | PSNR | ΔE00 | 判定 |')
  lines.push('|------|------|------|------|')
  for (const region of regions) {
    lines.push(`| ${region.directionZh ?? `块 ${region.index}`} | ${psnrText(region.psnr)} | ${num(region.deltaE00, 2)} | ${PIXEL_VERDICT_ZH[region.verdict] ?? region.verdict} |`)
  }
  lines.push('')
  lines.push('改的时候按区块改：位置说得出来，就说明改的是构图/配色而不是「整体感觉」。')
  return tidy(lines.join('\n'))
}

/* --------------------------------------------------------- whole-film styles */

/**
 * The 15 whole-film motion-graphics styles.
 *
 * These are a different layer from the 341 single-shot style prompts: a shot
 * style tells you how one effect moves, a whole-film style fixes the palette,
 * type scale, easing family, texture and the list of things the film must never
 * do — all at once, so ten shots read as one film instead of ten demos.
 *
 * @param {object} payload
 * @param {'list'|'show'|'search'} payload.action
 * @param {Array<object>} [payload.styles]
 * @param {object} [payload.style]
 * @param {Array<object>} [payload.entries]
 * @param {string} [payload.prompt]
 * @param {string} [payload.query]
 */
export function renderMgStylesReport(payload) {
  const lines = []
  const action = payload.action ?? 'list'
  if (action === 'list') {
    lines.push('# 整片 MG 风格（15 套）')
    lines.push('')
    lines.push('一套风格 = 配色 + 字号层级 + 运动曲线倾向 + 质感/噪点 + 禁忌清单，一次性给全，这样十个镜头才像同一支片子。')
    lines.push('单镜头风格请用 `source:"code"`（341 个），这里的是**整片视觉系统**。')
    lines.push('')
    lines.push('| 编号 | 中文名 | 能量 | 族 | 主色 |')
    lines.push('|---|---|---|---|---|')
    for (const style of payload.styles ?? []) {
      const palette = Array.isArray(style.palette) ? style.palette.slice(0, 3).join(' ') : '—'
      lines.push(`| \`${style.id}\` | ${style.zh} | ${style.energy ?? '—'} | ${style.familyZh ?? style.family ?? '—'} | ${palette} |`)
    }
    lines.push('')
    lines.push('用 `action:"show"` + `id` 取某一套的完整提示词，直接喂给写 HTML 的模型，然后 `media_animate` 渲成片段。')
    return tidy(lines.join('\n'))
  }
  if (action === 'search') {
    const entries = payload.entries ?? []
    lines.push('# 整片风格检索')
    lines.push('')
    if (entries.length === 0) {
      lines.push(`没有匹配「${payload.query ?? ''}」的整片风格；可以 \`action:"list"\` 看全部 15 套。`)
      return tidy(lines.join('\n'))
    }
    lines.push(`匹配「${payload.query ?? ''}」的 ${entries.length} 套：`)
    lines.push('')
    for (const style of entries) {
      lines.push(`- \`${style.id}\` ${style.zh}（${style.en ?? ''}）— ${String(style.motionLineZh ?? style.motionZh ?? '').slice(0, 90)}`)
    }
    return tidy(lines.join('\n'))
  }
  const style = payload.style ?? {}
  lines.push(`# 整片风格：${style.zh ?? style.id}`)
  lines.push('')
  lines.push(`${style.en ?? ''} · 能量 ${style.energy ?? '—'} · 族 ${style.familyZh ?? style.family ?? '—'}`)
  if (Array.isArray(style.paletteRoles) && style.paletteRoles.length > 0) {
    lines.push('')
    lines.push(`**配色**：${style.paletteRoles.map(([hex, role]) => `\`${hex}\` ${role}`).join(' · ')}`)
  } else if (Array.isArray(style.palette)) {
    lines.push('')
    lines.push(`**配色**：${style.palette.map((hex) => `\`${hex}\``).join(' ')}`)
  }
  if (typeof style.typeZh === 'string') {
    lines.push('')
    lines.push(`**字号层级**：${style.typeZh}`)
  }
  if (typeof style.motionZh === 'string') {
    lines.push('')
    lines.push(`**运动语汇**：${style.motionZh}`)
  }
  if (typeof style.textureZh === 'string') {
    lines.push('')
    lines.push(`**质感**：${style.textureZh}`)
  }
  if (Array.isArray(style.avoidZh) && style.avoidZh.length > 0) {
    lines.push('')
    lines.push('**禁忌**：')
    for (const item of style.avoidZh) lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push('## 可以直接喂给写 HTML 的模型')
  lines.push('')
  lines.push('```text')
  lines.push(payload.prompt ?? style.promptZh ?? '')
  lines.push('```')
  return tidy(lines.join('\n'))
}

/* ------------------------------------------------------------ checkpoints */

/**
 * Per-checkpoint comparison of a replica against its reference.
 *
 * A checkpoint is a *claim about one moment*: "at 2.65 s both cards sit in the
 * same place". Presenting it as a row keeps the claim visible next to its verdict,
 * so a `diverge` row can be answered with "not built yet" or "changed on purpose"
 * instead of being averaged away into a single number.
 *
 * @param {Array<{index:number, referenceAt:number, builtAt:number, whatZh:string,
 *   verdict:string, psnr:number|null, ssim:number, deltaE00:number, worst:string|null}>} rows
 */
export function renderCheckpointSection(rows) {
  const lines = []
  lines.push('## 对照检查点（同一时刻逐点比对）')
  lines.push('')
  lines.push('参考片和仿制版在**同一个时刻**各取一帧比较，而不是各取一帧比平均——后者对不上任何具体的改法。')
  lines.push('')
  lines.push('| # | 时刻 | 看什么 | 判定 | PSNR | SSIM | ΔE00 | 最差区块 |')
  lines.push('|---|---|---|---|---|---|---|---|')
  const verdictZh = { match: '一致', close: '接近', diverge: '不同' }
  for (const row of rows) {
    const moment = row.referenceAt === row.builtAt
      ? `${formatTimecode(row.referenceAt)}`
      : `参考 ${formatTimecode(row.referenceAt)} / 成片 ${formatTimecode(row.builtAt)}`
    lines.push(
      `| ${row.index + 1} | ${moment} | ${String(row.whatZh ?? '').slice(0, 40)} | ${verdictZh[row.verdict] ?? row.verdict} | ` +
        `${Number.isFinite(row.psnr) ? num(row.psnr, 1) : '∞'} | ${num(row.ssim, 3)} | ${num(row.deltaE00, 2)} | ${row.worst ?? '—'} |`,
    )
  }
  const matched = rows.filter((row) => row.verdict === 'match' || row.verdict === 'close').length
  lines.push('')
  lines.push(`**${matched}/${rows.length} 个检查点通过**（一致或接近）。不同的检查点要逐条回答：是还没做完，还是有意改的？`)
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
    const guidance = style.guidance
    if (guidance !== undefined && guidance !== null && guidance.hasStructure === true) {
      lines.push('## 改哪里 · 保哪里（改这一版时先看这段）')
      lines.push('')
      if (guidance.invariants.length > 0) {
        lines.push('**不可改（改了就是另一种风格）**')
        for (const section of guidance.invariants) {
          lines.push(`- ${headingLabel(section.heading, section.role)}：${oneLine(section.body, 160)}`)
        }
        lines.push('')
      }
      if (guidance.variables.length > 0) {
        lines.push('**可替换（换本集内容时改这些）**')
        for (const section of guidance.variables) {
          lines.push(`- ${headingLabel(section.heading, section.role)}：${oneLine(section.body, 160)}`)
        }
        lines.push('')
      }
      if (guidance.banned.length > 0) {
        lines.push('**必须避免（这条风格自己点名不要的）**')
        for (const item of guidance.banned.slice(0, 8)) lines.push(`- ${oneLine(item, 180)}`)
        lines.push('')
      }
      if (guidance.invariants.length === 0 && guidance.variables.length === 0) {
        lines.push('> 这条风格的结构不是分节写的，上面「原文」就是全部；改写时保留它点名的材质、配色与运动方式。')
        lines.push('')
      }
    } else {
      lines.push('> 这条风格的提示词是整段散文（没有分节），改写时保留它点名的材质、配色与运动方式，只替换内容。')
      lines.push('')
    }
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
 * The director's vocabulary: how to say "push in slowly" and get numbers back.
 *
 * @param {object} payload
 * @param {'moves'|'transitions'|'easing'|'looks'|'antipatterns'|'rules'|'show'} payload.action
 * @param {object} [payload.move]
 * @param {object} [payload.transition]
 * @param {object} [payload.look]
 * @param {Array<object>} [payload.moves]
 * @param {Array<object>} [payload.transitions]
 * @param {Array<object>} [payload.looks]
 * @param {Array<object>} [payload.antipatterns]
 * @param {Array<object>} [payload.rules]
 * @param {object} [payload.easings]
 */
export function renderVocabularyReport(payload) {
  const lines = []
  const action = payload.action ?? 'moves'

  if (action === 'moves') {
    lines.push('# 运镜词典（18 个）')
    lines.push('')
    lines.push('「推近一点、摇过去、手持一点」这类说法在这里都有确定数值。`ffmpeg` 一列可以直接写进 `media_build_video` 的 `scene.motion`；写 `—` 的必须用 `media_animate` 做代码动画。')
    lines.push('')
    lines.push('| id | 名称 | 时长 | 速度 | 景别 | ffmpeg motion | 什么时候用 |')
    lines.push('|----|------|------|------|------|---------------|------------|')
    for (const move of payload.moves ?? []) {
      lines.push(
        `| ${move.id} | ${move.nameZh} | ${move.seconds[0]}–${move.seconds[1]}s | ${move.speed} | ${move.framing ?? '—'} | ` +
          `\`${move.ffmpegMotion ?? '—'}\` | ${move.whyZh ?? '—'} |`,
      )
    }
    lines.push('')
    lines.push('> 速度词是量化的：缩放类 slow ≤10%/s、medium 10–25%/s、fast >25%/s；扫掠类 slow ≥6s 过画、medium 3–6s、fast 1.5–3s，再快就是 `whip-pan`。')
    return tidy(lines.join('\n'))
  }

  if (action === 'transitions') {
    lines.push('# 转场词典（9 个）')
    lines.push('')
    lines.push('| id | 名称 | 默认时长 | xfade | 声音怎么处理 | 什么时候用 |')
    lines.push('|----|------|----------|-------|--------------|------------|')
    for (const transition of payload.transitions ?? []) {
      lines.push(
        `| ${transition.id} | ${transition.nameZh} | ${transition.defaultSeconds === 0 ? '0（硬切）' : `${transition.defaultSeconds}s`} | ` +
          `${transition.ffmpeg ? `\`${transition.ffmpeg}\`` : '需代码动画'} | ${transition.soundZh ?? '—'} | ${transition.whenZh ?? '—'} |`,
      )
    }
    lines.push('')
    lines.push('> `ffmpeg` 列有值的可以直接写进 `scene.transitionIn`；`J-cut` / `L-cut` / `match-cut` / `whip` 是"声音与画面的错位"，用 `audio.voiceover[].start` 提前或延后实现。')
    return tidy(lines.join('\n'))
  }

  if (action === 'easing') {
    lines.push('# 缓动词典')
    lines.push('')
    lines.push('按**角色**选曲线，而不是全片用一个 `ease`——同一个 `power2.out` 用在所有地方正是"一眼 AI"的来源。')
    lines.push('')
    lines.push('| 角色 | 曲线 | 用在哪 |')
    lines.push('|------|------|--------|')
    const notes = payload.easings?.roleNotes ?? {}
    for (const [role, name] of Object.entries(payload.easings?.roles ?? {})) {
      lines.push(`| ${role} | \`${name}\` | ${notes[role] ?? '—'} |`)
    }
    lines.push('')
    lines.push('## 命名曲线')
    lines.push('')
    lines.push('| 名字 | CSS | 说明 |')
    lines.push('|------|-----|------|')
    for (const [name, entry] of Object.entries(payload.easings?.curves ?? {})) {
      lines.push(`| \`${name}\` | \`${entry.css ?? '—'}\` | ${entry.cssExact === false ? 'CSS 只能近似，真实回弹用 MS.spring' : '精确' } |`)
    }
    lines.push('')
    lines.push('## 弹簧：用阻尼比描述"高级感"')
    lines.push('')
    lines.push('| 阻尼比 | 读起来 |')
    lines.push('|--------|--------|')
    for (const item of payload.easings?.spring ?? []) lines.push(`| ${item.damping} | ${item.feelZh} |`)
    lines.push('')
    lines.push('> 在 `media_animate` 的页面里可以直接用注入的 `MS.spring({damping, frequency, t})`，不用自己写公式。')
    return tidy(lines.join('\n'))
  }

  if (action === 'looks') {
    lines.push('# 外观参数预设（8 族）')
    lines.push('')
    for (const look of payload.looks ?? []) {
      lines.push(`## ${look.id} · ${look.nameZh ?? look.id}`)
      lines.push('')
      lines.push(`- 配色：${(look.palette ?? []).join(' / ')}`)
      lines.push(`- 材质：${look.materials?.shading} · ${look.materials?.steps} 阶 · 粗糙度 ${look.materials?.roughness}`)
      lines.push(`- 光线：方位 ${look.light?.azimuthDeg}° · 高度 ${look.light?.elevationDeg}° · 强度 ${look.light?.intensity} · 环境 ${look.light?.ambient} · 曝光 ${look.light?.exposure}`)
      lines.push(`- 后期：${look.post?.tone} · 饱和 ${look.post?.saturation} · 对比 ${look.post?.contrast} · 颗粒 ${look.post?.grain} · 暗角 ${look.post?.vignette}`)
      lines.push(`- 渲染：${look.render?.fps}fps · 一拍 ${look.render?.hold}`)
      lines.push('')
    }
    lines.push('在 HTML 动画里用 `lookCssVars` 注入的 `--ms-*` 变量即可保持同一个外观。')
    return tidy(lines.join('\n'))
  }

  if (action === 'antipatterns') {
    lines.push('# 一眼 AI 味：15 条自查')
    lines.push('')
    lines.push('发布前逐条对照；命中就改，不要解释。')
    lines.push('')
    lines.push('| # | 表现 | 为什么露馅 | 怎么改 |')
    lines.push('|---|------|------------|--------|')
    for (const [index, item] of (payload.antipatterns ?? []).entries()) {
      lines.push(`| ${index + 1} | ${item.tellZh} | ${item.whyZh} | ${item.fixZh} |`)
    }
    return tidy(lines.join('\n'))
  }

  if (action === 'rules') {
    lines.push('# 剪辑缝规则（切点放在哪）')
    lines.push('')
    lines.push('| # | 规则 | 量 | 阈值 | 怎么改 |')
    lines.push('|---|------|----|------|--------|')
    for (const [index, rule] of (payload.rules ?? []).entries()) {
      lines.push(`| ${index + 1} | ${rule.ruleZh} | ${rule.metric ?? '—'} | ${rule.threshold ?? '—'} | ${rule.fixZh ?? '—'} |`)
    }
    return tidy(lines.join('\n'))
  }

  // show: one move / transition / look in full.
  const item = payload.move ?? payload.transition ?? payload.look
  if (item === null || item === undefined) {
    lines.push('没有找到这一项；先用 `action: "moves"` 或 `action: "looks"` 列出可用的 id。')
    return tidy(lines.join('\n'))
  }
  lines.push(`# ${item.nameZh ?? item.id}`)
  lines.push('')
  lines.push(`id: \`${item.id}\``)
  for (const [key, value] of Object.entries(item)) {
    if (key === 'id' || key === 'nameZh') continue
    if (value === null || value === undefined) continue
    const shown = typeof value === 'object' ? JSON.stringify(value) : String(value)
    lines.push(`- ${key}: ${shown}`)
  }
  return tidy(lines.join('\n'))
}

/**
 * The director's vocabulary: how to say "push in slowly" and get numbers back.
 *
 * @param {object} payload
 * @param {'moves'|'transitions'|'easing'|'looks'|'antipatterns'|'rules'|'show'} payload.action
 */

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
  // Which contract the page used, and the two render features that change the
  // look: motion blur and in-page audio.
  const runtime = result.runtime ?? null
  if (runtime !== null && typeof runtime === 'object') {
    const modeZh = runtime.mode === 'auto-shim'
      ? `普通 HTML（自动 seek：${runtime.clips ?? 0} 个声明式 clip · ${runtime.timelines ?? 0} 条时间轴 · ${runtime.animations ?? 0} 个 CSS/WAAPI 动画）`
      : 'window.renderAt(t)'
    lines.push(`页面契约: ${modeZh}`)
  }
  const blur = result.motionBlur ?? null
  if (blur !== null && typeof blur === 'object' && Number(blur.samples) > 1) {
    lines.push(`运动模糊: ${blur.samples} 子帧 · 快门 ${num(blur.shutter, 0, '°')}`)
  }
  const audio = result.audio ?? null
  if (audio !== null && typeof audio === 'object') {
    lines.push(`页面内音频: ${audio.mixed === true ? `${audio.clips ?? 0} 段已混入` : '未混入'}${Array.isArray(audio.warnings) && audio.warnings.length > 0 ? `（${audio.warnings.length} 条提示）` : ''}`)
  }
  // Vision mode: the head/middle/tail strip is the thing to look at first.
  const stripNote = visionTarget(meta) ? filmstripNote(meta) : undefined
  if (stripNote !== undefined) lines.push(stripNote)
  lines.push('')
  lines.push('## 拼进成片')
  lines.push('把这段作为场景交给 `media_build_video`：')
  lines.push('```json')
  lines.push(JSON.stringify({ type: 'video', duration: Math.round((result.duration ?? 0) * 10) / 10, src: result.output, fit: 'cover', muted: true, transitionIn: 'fade', transitionDuration: 0.5 }, null, 1))
  lines.push('```')
  // Only offer the engine table when the page had to be shimmed or used an
  // adapter: for a plain renderAt page it is noise.
  if (meta.showAdapters === true) {
    lines.push('')
    lines.push('## 引擎怎么跟着帧走')
    lines.push('')
    lines.push(renderAdapterTable())
    lines.push('')
    lines.push('> 页面里可以直接用注入的 `MS.ease(name, t)`、`MS.spring({damping, frequency}, t)`、`MS.poseAt({emotion, t})`（角色眨眼/情绪），不必自己推导曲线。')
  }
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

