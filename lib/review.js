/**
 * lib/review.js — 成片独立终检聚合（independent final review）
 *
 * 为什么需要它：制作者对自己的产出有确认偏差，首检不能交给用户。上游
 * video-shotcraft 的 final-review 要求由一个**干净上下文**的审查者按清单逐项
 * 检查，并给每条问题附帧号或截图；我们的 rubric 只有自评，没有证据链。
 * 本模块只做「聚合 + 判定 + 排序 + 出报告」，不自己跑 ffmpeg：上层把
 * gate / continuity / aesthetic / beatsync / audio / plan / shots / lint 的原始
 * 返回喂进来（允许为 null），这里统一成 A 音画 / B 节奏 / C 画面 / D 数据安全 /
 * E 一致性 五节，并把「没有帧号或秒」的失败项降级为提醒。
 *
 * 分节与上游验收清单（test/_research/final-review.txt）的对应关系写在
 * REVIEW_SECTIONS[].upstreamZh 里：
 *   A 音画      ← 上游 A1/A2/A5/A6/A8/A10（音频与节奏里的声音部分）
 *   B 节奏      ← 上游 A3/A4/A9 + 节奏起伏（B1/B3 的动效节奏）
 *   C 画面      ← 上游 V（视觉方向）/Q（视觉技术质量）/S4（卡片命门）/F3（页面状态）
 *   D 数据安全  ← 上游 D1–D5（数据与素材安全）
 *   E 一致性    ← 上游 P4/B1–B4（需求到执行、分镜一致性）+ 镜头承接
 *
 * 归因：分节结构、证据要求与「制作者的自检不作为证据」的审计立场来自
 * video-shotcraft (Vincentwei1021) via dsh-drawai 固定提交，Apache-2.0；
 * 判定规则、打分与中文文案为本仓自写。
 *
 * 约束：纯函数、确定性（不读时钟/不联网/不用随机数）、输出严格 JSON 可序列化。
 */
import { hasTimeReference } from './rubric.js'
import { continuityVerdict } from './continuity.js'

export const REVIEW_VERSION = 'media-senses.review/v1'

/** 报告头必须显式标注的独立审计声明。 */
export const DISCLAIMER_ZH = '本报告由独立审计生成，制作者的自检不作为证据。'

/** 证据规则：blocker 必须带帧号或秒，否则降级。 */
export const EVIDENCE_POLICY_ZH = '每条 blocker 必须带帧号或秒证据；没有时间引用的失败项降级为「提醒」并标注缺证据。'

/** 降级时追加在证据文本后的固定说明。 */
export const EVIDENCE_MISSING_ZH = '缺证据（没有帧号或秒引用）'

/** 给 THIRD-PARTY.md 用的归因行（与本文件顶部注释一致）。 */
export const REVIEW_ATTRIBUTION_ZH =
  'lib/review.js | video-shotcraft (Vincentwei1021) via dsh-drawai 固定提交 | Apache-2.0 | ' +
  '分节结构、证据要求与「制作者自检不作为证据」立场；判定规则/打分/中文文案为本仓自写'

/**
 * 五节定义。`upstreamZh` 是上游 final-review.txt 中对应的检查组，方便对照；
 * `questionZh` 只用于文档与上层提示，不直接进报告（避免主观措辞）。
 *
 * @type {ReadonlyArray<{id: string, zh: string, upstreamZh: string, questionZh: string}>}
 */
export const REVIEW_SECTIONS = Object.freeze([
  {
    id: 'A',
    zh: '音画',
    upstreamZh: 'A1/A2/A5/A6/A8/A10（音频与声音设计）',
    questionZh: '声音有没有设计：BGM 是否给 SFX/旁白留出空间，SFX 是否钉在动作关键帧，素材许可是否可交付。',
  },
  {
    id: 'B',
    zh: '节奏',
    upstreamZh: 'A3/A4/A9 + B1/B3（卡点、回测、镜头长度与留白节奏）',
    questionZh: '切点是否卡在拍上，卡点回测误差是否不超过 3 帧，镜头长度与静止留白有没有节奏。',
  },
  {
    id: 'C',
    zh: '画面',
    upstreamZh: 'V1–V4 / Q1–Q13 / S4 / F3（视觉方向、视觉技术质量、卡片命门、页面状态）',
    questionZh: '判例式审美准则与文字安全是否成立，画面技术质量是否可交付。',
  },
  {
    id: 'D',
    zh: '数据安全',
    upstreamZh: 'D1–D5（数据与素材安全）',
    questionZh: '真实/虚构/脱敏口径是否说明，是否暴露敏感信息，截图与素材是否可复核。',
  },
  {
    id: 'E',
    zh: '一致性',
    upstreamZh: 'P4/B1–B4（需求到执行、分镜一致性）+ 镜头承接',
    questionZh: '成片与计划是否对得上，每个需求是否有落地证据，切点有没有把东西带过去。',
  },
])

/** 报告里出现的判定词。 */
export const REVIEW_VERDICT_ZH = Object.freeze({ pass: '通过', warn: '有条件通过', fail: '未通过' })

/** 单条检查的判定符号（与上游报告格式 `P1 ✓ / F2 ✗` 对齐）。 */
export const ROW_MARK = Object.freeze({ pass: '✓', fail: '✗', warn: '⚠', skip: '—' })

/**
 * blind 模式要移除的主观形容词/评价词（判定、数字、帧号、秒、hex 均保留）。
 * 词表按最长优先替换，避免「高级感」被「高级」拆开留下「感」。
 */
export const SUBJECTIVE_WORDS_ZH = Object.freeze([
  '整体不错', '观感', '感觉', '挺好', '不错', '漂亮', '好看', '高级感', '高级', '廉价感', '廉价',
  '优雅', '自然', '流畅', '顺滑', '干净', '舒服', '惊艳', '大气', '精致', '细腻', '粗糙', '生硬',
  '突兀', '呆板', '杂乱', '拥挤', '和谐', '平衡', '有质感', '耐看', '俗气', 'AI 味', 'AI味',
  '冲击力', '呼吸感', '克制', '灵动', '稳重', '活泼', '保守', '时尚', '复古', '戏剧性', '张力',
  '氛围感', '记忆点', '讨喜', '勉强', '明显', '严重', '很好', '不好', '较差', '糟糕', '完美',
  '优美', '柔和', '硬朗', '轻盈', '厚重', '温暖', '冷峻',
])

const SORTED_SUBJECTIVE_WORDS = [...SUBJECTIVE_WORDS_ZH].sort((a, b) => b.length - a.length)

/* 打分权重：失败（且带证据）最重，提醒其次，无法验证只扣一点；无法验证的扣分有上限，
 * 因为缺输入时用户更需要的是"缺什么"，而不是一个被拉到底的分数。 */
const SCORE_BLOCKER = 20
const SCORE_WARN = 6
const SCORE_SKIP = 1
const SCORE_SKIP_CAP = 10

/** 每个 section 最多保留多少行（防止 lint/aesthetic 全量刷屏）。 */
const MAX_SECTION_ROWS = 40
/** 报告里 mustFix 最多列多少条。 */
const MAX_MUST_FIX = 5
/** 报告里提醒/无法验证明细最多列多少条。 */
const MAX_RENDER_LIST = 20

/** 卡点回测的验收阈值（帧）：与 CONTRACT-V4 §2.2 / music-beat-sync 一致。 */
const BACKTEST_PASS_FRAMES = 3
/** 拍点网格残差上限（ms），见 music-beat-sync。 */
const BEAT_GRID_MAX_RESIDUAL_MS = 15
/** SFX 钉点允许误差（帧），见 upstream A2 / sound-design §4.6。 */
const SFX_PIN_TOLERANCE_FRAMES = 0.5
/** 长样本阈值（秒）：超过它必须显式给 durationInFrames。 */
const LONG_SFX_SECONDS = 5

/* ------------------------------------------------------------------ helpers */

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function objectOrNull(value) {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : []
}

function percentText(value) {
  const number = finiteNumber(value)
  return number === undefined ? '—' : `${round(number * 100, 1)}%`
}

/** `8.00s（第 240 帧）`；没有 fps 时只给秒。 */
function secondsText(seconds, fps) {
  const value = finiteNumber(seconds)
  if (value === undefined) return ''
  const secondsPart = `${round(value, 2).toFixed(2)}s`
  return Number.isFinite(fps) && fps > 0 ? `${secondsPart}（第 ${Math.round(value * fps)} 帧）` : secondsPart
}

/** `第 240 帧（8.00s）`；没有 fps 时只给帧号。 */
function frameText(frame, fps) {
  const value = finiteNumber(frame)
  if (value === undefined) return ''
  const framePart = `第 ${Math.round(value)} 帧`
  return Number.isFinite(fps) && fps > 0 ? `${framePart}（${(value / fps).toFixed(2)}s）` : framePart
}

/** 秒 → 帧证据数组（没有 fps 时返回空数组，交给 hasTimeReference 判证据）。 */
function framesFromSeconds(seconds, fps) {
  const value = finiteNumber(seconds)
  if (value === undefined || !Number.isFinite(fps) || fps <= 0) return []
  return [Math.round(value * fps)]
}

function normaliseFrames(list) {
  if (!Array.isArray(list)) return []
  const frames = []
  for (const item of list) {
    const value = Number(item)
    if (Number.isInteger(value) && value >= 0 && !frames.includes(value)) frames.push(value)
  }
  return frames
}

/** 构造一条检查结果；证据文本原样保留（最终由 auditFilm 的降级规则校验）。 */
function makeRow(options) {
  const row = {
    id: asText(options.id),
    titleZh: asText(options.titleZh),
    verdict: options.verdict,
    evidenceZh: asText(options.evidenceZh),
    frames: normaliseFrames(options.frames),
  }
  if (options.upstreamZh !== undefined && options.upstreamZh !== null) row.upstreamZh = asText(options.upstreamZh)
  if (asText(options.detailZh).length > 0) row.detailZh = asText(options.detailZh)
  if (asText(options.judgmentZh).length > 0) row.judgmentZh = asText(options.judgmentZh)
  if (asText(options.fixZh).length > 0) row.fixZh = asText(options.fixZh)
  return row
}

/** 一条结果是否真的定位到了画面：帧数组非空，或证据文本里有帧号/时间码/秒。 */
function hasRowEvidence(row) {
  return row.frames.length > 0 || hasTimeReference(row.evidenceZh)
}

/**
 * 契约要求：blocker 必须带帧号或秒。没有证据的失败项在这里降级为 `warn`，
 * 并保留 `evidenceMissing` 标记，报告里会单独解释为什么降级。
 */
function finaliseRow(row) {
  if (row.verdict !== 'fail' || hasRowEvidence(row)) return row
  const evidence = row.evidenceZh.length > 0 ? `${row.evidenceZh}｜${EVIDENCE_MISSING_ZH}` : EVIDENCE_MISSING_ZH
  return {
    ...row,
    verdict: 'warn',
    evidenceMissing: true,
    evidenceZh: `${evidence}：按契约降级为提醒`,
  }
}

function countRows(rows) {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 }
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1
  return { ...counts, total: rows.length }
}

function mapGateState(state) {
  if (state === 'PASS') return 'pass'
  if (state === 'FAIL') return 'fail'
  if (state === 'WARN') return 'warn'
  return 'skip'
}

function mapEngineVerdict(value) {
  if (value === 'pass') return 'pass'
  if (value === 'fail') return 'fail'
  if (value === 'warn') return 'warn'
  return 'skip'
}

/** 从 gate 的 legs 里找一条腿（runGate 返回 {verdict, legs, measurements}）。 */
function findGateLeg(gate, id) {
  const legs = arrayOrEmpty(gate?.legs)
  return legs.find((leg) => objectOrNull(leg)?.['id'] === id) ?? null
}

/* --------------------------------------------------- input normalisation */

/** 项目 fps：显式 fps > plan.fps > 30（不是分析采样 fps）。 */
function resolveFps(source, plan) {
  for (const candidate of [source?.fps, plan?.fps]) {
    const value = finiteNumber(candidate)
    if (value !== undefined && value > 0 && value <= 240) return value
  }
  return 30
}

/** 镜头列表：支持数组或 {shots:[…]}；只保留有正时长的条目。 */
function normaliseShots(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.shots) ? value.shots : []
  const shots = []
  for (const entry of list) {
    const shot = objectOrNull(entry)
    if (shot === null) continue
    const duration = finiteNumber(shot.duration) ?? (() => {
      const start = finiteNumber(shot.start)
      const end = finiteNumber(shot.end)
      return start !== undefined && end !== undefined && end > start ? end - start : undefined
    })()
    if (duration === undefined || duration <= 0) continue
    shots.push({ ...shot, duration })
  }
  return shots
}

/** 计划时长：与 lib/build.js 相同的时间线公式（渐变转场会让相邻场景重叠）。 */
function plannedDuration(plan) {
  const scenes = arrayOrEmpty(plan?.scenes)
  if (scenes.length === 0) return undefined
  let total = 0
  let hasDuration = false
  scenes.forEach((scene, index) => {
    const item = objectOrNull(scene) ?? {}
    const duration = finiteNumber(item.duration)
    if (duration !== undefined && duration > 0) {
      total += duration
      hasDuration = true
    }
    if (index === 0) return
    const transitionIn = asText(item.transitionIn).toLowerCase()
    if (transitionIn.length === 0 || transitionIn === 'cut') return
    const requested = finiteNumber(item.transitionDuration)
    total -= requested !== undefined && requested > 0 ? requested : 0.5
  })
  return hasDuration ? round(Math.max(0, total), 3) : undefined
}

/** 场景时间窗：与 lib/lint.js 的 computeSceneWindows 同一公式，用于把 lint 的场景号换算成帧号。 */
function sceneWindows(plan) {
  const scenes = arrayOrEmpty(plan?.scenes)
  const windows = []
  let end = 0
  scenes.forEach((scene, index) => {
    const item = objectOrNull(scene) ?? {}
    const duration = finiteNumber(item.duration)
    const safeDuration = duration !== undefined && duration > 0 ? duration : 0
    const transitionIn = asText(item.transitionIn).toLowerCase()
    const gradual = index > 0 && transitionIn.length > 0 && transitionIn !== 'cut'
    const requested = finiteNumber(item.transitionDuration)
    const transition = gradual ? (requested !== undefined && requested > 0 ? requested : 0.5) : 0
    end += safeDuration - transition
    windows.push({ start: Math.max(0, round(end - safeDuration, 3)), end: round(end, 3), index })
  })
  return windows
}

/** 实测总时长：gate 实测 > audio 时长 > 镜头时长之和 > 计划时长。 */
function resolveDuration(source, plan, shots) {
  const fromGate = finiteNumber(source?.gate?.measurements?.duration)
  if (fromGate !== undefined && fromGate > 0) return fromGate
  const fromAudio = finiteNumber(source?.audio?.duration)
  if (fromAudio !== undefined && fromAudio > 0) return fromAudio
  const shotSum = shots.reduce((sum, shot) => sum + (finiteNumber(shot.duration) ?? 0), 0)
  if (shotSum > 0) return round(shotSum, 3)
  return plannedDuration(plan)
}

/* ---------------------------------------------------- A 音画：声音设计 */

function buildAudioRows(context) {
  const { source, plan, fps, duration } = context
  const rows = []
  const audio = objectOrNull(source.audio)
  const gateAudio = findGateLeg(objectOrNull(source.gate), 'audio')
  const sfx = Array.isArray(audio?.sfx) ? audio.sfx : Array.isArray(source.sfx) ? source.sfx : []
  const bgm = objectOrNull(audio?.bgm) ?? objectOrNull(plan?.audio) ?? {}
  const wholeFilm = duration !== undefined ? `全片 ${duration.toFixed(2)}s` : ''

  if (audio === null && gateAudio === null) {
    rows.push(makeRow({
      id: 'audio.missing',
      titleZh: '音频分析',
      verdict: 'skip',
      evidenceZh: '无法验证：未提供 audio 引擎输出（本次没有给通过结论）',
    }))
    return rows
  }

  // A1 — 响度与 BGM 给 SFX/旁白留空间的证据（数字来自 audio.loudness / plan.audio）。
  const lufs = finiteNumber(audio?.loudness?.lufsIntegrated)
  const musicDb = finiteNumber(bgm.musicVolumeDb) ?? finiteNumber(bgm.volumeDb)
  if (lufs !== undefined) {
    const inTargetRange = lufs >= -20 && lufs <= -12
    const parts = []
    if (wholeFilm.length > 0) parts.push(wholeFilm)
    parts.push(`积分响度 ${lufs.toFixed(1)} LUFS（目标 −16±4）`)
    if (musicDb !== undefined) parts.push(`BGM 增益 ${round(musicDb, 1)} dB`)
    if (finiteNumber(audio?.loudness?.silenceRatio) !== undefined) parts.push(`静音占比 ${percentText(audio.loudness.silenceRatio)}`)
    rows.push(makeRow({
      id: 'audio.loudness',
      titleZh: '响度与 BGM/SFX 音量空间',
      verdict: inTargetRange ? 'pass' : 'warn',
      evidenceZh: parts.join('，'),
      upstreamZh: 'A1',
      fixZh: inTargetRange ? undefined : '把积分响度调到 −16±4 LUFS（当前偏差见证据），并保证 BGM 不盖过 SFX/旁白',
    }))
  } else {
    rows.push(makeRow({
      id: 'audio.loudness',
      titleZh: '响度与 BGM/SFX 音量空间',
      verdict: 'skip',
      evidenceZh: '无法验证：audio.loudness.lufsIntegrated 缺失',
      upstreamZh: 'A1',
    }))
  }

  // A2 — SFX 钉点：|designedFrame − measuredPeakFrame − outputOffsetFrames| ≤ 0.5 帧。
  const pinned = sfx.filter((entry) => objectOrNull(entry) !== null
    && finiteNumber(entry.designedFrame) !== undefined
    && finiteNumber(entry.measuredPeakFrame) !== undefined)
  if (pinned.length > 0) {
    let worst = null
    pinned.forEach((entry) => {
      const offset = finiteNumber(entry.outputOffsetFrames) ?? 0
      const error = Math.abs(Number(entry.designedFrame) - Number(entry.measuredPeakFrame) - offset)
      if (worst === null || error > worst.error) worst = { entry, error, offset }
    })
    const pass = worst.error <= SFX_PIN_TOLERANCE_FRAMES
    rows.push(makeRow({
      id: 'audio.sfx-pin',
      titleZh: 'SFX 钉点误差',
      verdict: pass ? 'pass' : 'fail',
      evidenceZh: `${frameText(worst.entry.designedFrame, fps)}：实测峰值 ${frameText(worst.entry.measuredPeakFrame, fps)}，输出偏移 ${round(worst.offset, 2)} 帧，误差 ${round(worst.error, 2)} 帧（容差 ${SFX_PIN_TOLERANCE_FRAMES} 帧）`,
      frames: [worst.entry.designedFrame, worst.entry.measuredPeakFrame],
      upstreamZh: 'A2',
      fixZh: pass ? undefined : `把这条 SFX 的起点提前/延后 ${round(worst.error, 2)} 帧，使 |设计帧 − 实测峰值帧 − 输出偏移| ≤ ${SFX_PIN_TOLERANCE_FRAMES}`,
    }))
  } else {
    rows.push(makeRow({
      id: 'audio.sfx-pin',
      titleZh: 'SFX 钉点误差',
      verdict: 'skip',
      evidenceZh: '无法验证：没有提供 SFX 钉点数据（designedFrame / measuredPeakFrame）',
      upstreamZh: 'A2',
    }))
  }

  // A5 — 超过 5 秒的动作样本必须显式给时长，否则音效会拖到动作结束后。
  if (sfx.length > 0) {
    const longSamples = sfx.filter((entry) => (finiteNumber(entry?.durationSeconds) ?? 0) > LONG_SFX_SECONDS)
    const missingDuration = longSamples.filter((entry) => finiteNumber(entry?.durationInFrames) === undefined && entry.explicitDuration !== true)
    if (longSamples.length === 0) {
      rows.push(makeRow({
        id: 'audio.sfx-duration',
        titleZh: '长样本显式时长',
        verdict: 'pass',
        evidenceZh: `没有 >${LONG_SFX_SECONDS}s 的 SFX 样本（${sfx.length} 条样本最长 ${round(Math.max(...sfx.map((entry) => finiteNumber(entry?.durationSeconds) ?? 0)), 2)}s），无需显式 durationInFrames`,
        upstreamZh: 'A5',
      }))
    } else {
      const first = missingDuration[0]
      const hasTime = first !== undefined && finiteNumber(first.designedFrame) !== undefined
      rows.push(makeRow({
        id: 'audio.sfx-duration',
        titleZh: '长样本显式时长',
        verdict: missingDuration.length > 0 ? 'fail' : 'pass',
        evidenceZh: missingDuration.length > 0
          ? `${hasTime ? `${frameText(first.designedFrame, fps)}：` : ''}${missingDuration.length}/${longSamples.length} 条 >${LONG_SFX_SECONDS}s 的样本没有 durationInFrames，音效会拖到动作结束后`
          : `${longSamples.length} 条 >${LONG_SFX_SECONDS}s 样本都显式给了 durationInFrames`,
        frames: hasTime ? [first.designedFrame] : [],
        upstreamZh: 'A5',
        fixZh: missingDuration.length > 0 ? '给每条长样本补 durationInFrames（或显式标记 explicitDuration: true）' : undefined,
      }))
    }
  } else {
    rows.push(makeRow({
      id: 'audio.sfx-duration',
      titleZh: '长样本显式时长',
      verdict: 'skip',
      evidenceZh: '无法验证：未提供 SFX 样本清单',
      upstreamZh: 'A5',
    }))
  }

  // A6 — 渲染产物里真的听得见：峰值不能顶到 0，也不能有削波。
  const peakDb = finiteNumber(gateAudio?.value?.peakDb) ?? finiteNumber(audio?.loudness?.peakDbfs)
  const clipped = finiteNumber(gateAudio?.value?.clipped) ?? (finiteNumber(audio?.loudness?.clippingRatio) !== undefined
    ? (audio.loudness.clippingRatio > 0 ? 1 : 0)
    : undefined)
  if (peakDb !== undefined) {
    const pass = peakDb <= -1 && (clipped === undefined || clipped === 0)
    rows.push(makeRow({
      id: 'audio.headroom',
      titleZh: '可闻性与削波余量',
      verdict: pass ? 'pass' : 'fail',
      evidenceZh: `${wholeFilm.length > 0 ? `${wholeFilm}，` : ''}峰值 ${round(peakDb, 1)} dBFS${clipped !== undefined ? `，削波样本 ${clipped}` : ''}（要求峰值 ≤ −1 dBFS 且无削波）`,
      frames: duration !== undefined ? framesFromSeconds(duration, fps).map((frame) => Math.max(0, frame - 1)) : [],
      upstreamZh: 'A6',
      fixZh: pass ? undefined : '把峰值压到 −1 dBFS 以下并重新限幅；渲染后复测 max_volume 与削波数',
    }))
  } else {
    rows.push(makeRow({
      id: 'audio.headroom',
      titleZh: '可闻性与削波余量',
      verdict: 'skip',
      evidenceZh: '无法验证：没有峰值/削波数据（audio.loudness 或 gate audio 腿缺失）',
      upstreamZh: 'A6',
    }))
  }

  // A8 — 带 BGM / 无 BGM 两版是否来自同一时间线。
  const versions = objectOrNull(audio?.versions) ?? objectOrNull(source.versions)
  if (versions !== null) {
    const withBgm = asText(versions.withBgm) || (versions.withBgm === true ? '已提供' : '')
    const withoutBgm = asText(versions.withoutBgm) || (versions.withoutBgm === true ? '已提供' : '')
    const pass = withBgm.length > 0 && withoutBgm.length > 0
    rows.push(makeRow({
      id: 'audio.versions',
      titleZh: 'BGM/无 BGM 双版本',
      verdict: pass ? 'pass' : 'warn',
      evidenceZh: pass
        ? `带 BGM 版 \`${withBgm}\` · 无 BGM 版 \`${withoutBgm}\``
        : '只提供了单版本；若分镜要求交付两版，需用同一时间线再导一版',
      upstreamZh: 'A8',
      fixZh: pass ? undefined : '用同一时间线导出带 BGM 与无 BGM（保留 SFX）两版，并逐帧核对画面一致',
    }))
  } else {
    rows.push(makeRow({
      id: 'audio.versions',
      titleZh: 'BGM/无 BGM 双版本',
      verdict: 'skip',
      evidenceZh: '无法验证：未提供带 BGM/无 BGM 两版记录',
      upstreamZh: 'A8',
    }))
  }

  // A10 — 每个实际使用的 SFX 是否有可复核的许可记录。
  if (sfx.length > 0) {
    const unlicensed = sfx.filter((entry) => {
      const license = objectOrNull(entry?.license)
      return asText(license?.type).length === 0 && asText(entry?.licenseType).length === 0
    })
    const first = unlicensed[0]
    const hasTime = first !== undefined && finiteNumber(first.designedFrame) !== undefined
    rows.push(makeRow({
      id: 'audio.license',
      titleZh: 'SFX 素材许可',
      verdict: unlicensed.length > 0 ? 'fail' : 'pass',
      evidenceZh: unlicensed.length > 0
        ? `${hasTime ? `${frameText(first.designedFrame, fps)}：` : ''}${unlicensed.length}/${sfx.length} 条 SFX 没有许可记录（需要素材页 / 作者 / 许可 URL）`
        : `${sfx.length} 条 SFX 都有许可记录`,
      frames: hasTime ? [first.designedFrame] : [],
      upstreamZh: 'A10',
      fixZh: unlicensed.length > 0 ? '给每条 SFX 补 license {type, url, author}；未知/BY-NC 许可的素材换掉' : undefined,
    }))
  } else {
    rows.push(makeRow({
      id: 'audio.license',
      titleZh: 'SFX 素材许可',
      verdict: 'skip',
      evidenceZh: '无法验证：未提供 SFX 素材清单（若本轮没有用 SFX，本条不适用）',
      upstreamZh: 'A10',
    }))
  }

  return rows
}

/* -------------------------------------------------- B 节奏：卡点与起伏 */

/** 从 beatsync 输入里取回测/偏移/网格，支持直接给某一项或给 {backtest, offset, grid} 聚合。 */
function readBeatsync(beatsync) {
  const source = objectOrNull(beatsync)
  if (source === null) return { backtest: null, offset: null, grid: null }
  const looksBacktest = (value) => objectOrNull(value) !== null
    && (Array.isArray(value.rows) || finiteNumber(value.meanAbsFrames) !== undefined || finiteNumber(value.within3Ratio) !== undefined)
  const looksOffset = (value) => objectOrNull(value) !== null
    && (finiteNumber(value.offsetFrames) !== undefined || finiteNumber(value.offsetSeconds) !== undefined || finiteNumber(value.offsetSamples) !== undefined)
  const looksGrid = (value) => objectOrNull(value) !== null
    && (finiteNumber(value.residualMaxMs) !== undefined || finiteNumber(value.residualRmsMs) !== undefined || finiteNumber(value.period) !== undefined)

  const backtest = [source.backtest, source.backtestAlignment, source.alignment, source.rows !== undefined ? source : null].find(looksBacktest) ?? null
  const offset = [source.offset, source.outputOffset, source.audioOffset, looksOffset(source) ? source : null].find(looksOffset) ?? null
  const grid = [source.grid, source.beatGrid, source.fit, looksGrid(source) ? source : null].find(looksGrid) ?? null
  return { backtest, offset, grid }
}

function buildRhythmRows(context) {
  const { source, fps, duration } = context
  const rows = []
  const gate = objectOrNull(source.gate)
  const legRows = [
    { id: 'cadence', titleZh: '镜头长度变化', upstreamZh: 'B1', evidence: (value) => `镜头长 ${round(value.shortest, 2)}–${round(value.longest, 2)}s，变异系数 ${round(value.cv, 3)}` },
    { id: 'burst', titleZh: '变化爆发', upstreamZh: 'A4', evidence: (value) => `共 ${value.bursts} 处爆发${finiteNumber(value.firstAt) !== undefined ? `，首处 ${secondsText(value.firstAt, fps)}` : ''}` },
    { id: 'dead-air', titleZh: '静止空档', upstreamZh: 'B3', evidence: (value) => `最长静止段 ${round(value.longestSec, 2)}s${finiteNumber(value.at) !== undefined ? `，从 ${secondsText(value.at, fps)}起` : ''}` },
    { id: 'stillness', titleZh: '静帧比例', upstreamZh: 'B3', evidence: (value) => `静帧占 ${percentText(value.stillRatio)}，最长一段静止 ${round(value.longestSec, 2)}s` },
  ]
  if (gate === null) {
    rows.push(makeRow({ id: 'gate.missing', titleZh: '验收门禁', verdict: 'skip', evidenceZh: '无法验证：未提供 gate 引擎输出' }))
  } else {
    for (const definition of legRows) {
      const leg = findGateLeg(gate, definition.id)
      if (leg === null) {
        rows.push(makeRow({ id: `gate.${definition.id}`, titleZh: definition.titleZh, verdict: 'skip', evidenceZh: `无法验证：gate 没有返回 ${definition.id} 腿`, upstreamZh: definition.upstreamZh }))
        continue
      }
      const value = objectOrNull(leg.value) ?? {}
      const evidence = asText(leg.detail).length > 0 && Object.keys(value).length === 0
        ? leg.detail
        : definition.evidence(value)
      rows.push(makeRow({
        id: `gate.${definition.id}`,
        titleZh: definition.titleZh,
        verdict: mapGateState(leg.state),
        evidenceZh: evidence,
        frames: finiteNumber(value.at) !== undefined ? framesFromSeconds(value.at, fps) : finiteNumber(value.firstAt) !== undefined ? framesFromSeconds(value.firstAt, fps) : [],
        upstreamZh: definition.upstreamZh,
      }))
    }
    if (gate.verdict === 'FAIL' && !arrayOrEmpty(gate.legs).some((leg) => objectOrNull(leg)?.state === 'FAIL')) {
      rows.push(makeRow({ id: 'gate.inconsistent', titleZh: '门禁结论自洽', verdict: 'warn', evidenceZh: 'gate 判定 FAIL 但没有 FAIL 腿：门禁输入不一致，需复核', upstreamZh: 'B1' }))
    }
  }

  const beatsync = readBeatsync(source.beatsync)
  const providedBeatsync = beatsync.backtest !== null || beatsync.offset !== null || beatsync.grid !== null

  // A3 — 卡点回测：误差 ≤3 帧。
  if (beatsync.backtest !== null) {
    const backtest = beatsync.backtest
    const rowsList = arrayOrEmpty(backtest.rows)
    let worst = null
    for (const entry of rowsList) {
      const item = objectOrNull(entry)
      if (item === null) continue
      const error = finiteNumber(item.errorFrames)
      if (error === undefined) continue
      const abs = Math.abs(error)
      if (worst === null || abs > worst.abs) worst = { item, abs, error }
    }
    const mean = finiteNumber(backtest.meanAbsFrames)
    const max = finiteNumber(backtest.maxAbsFrames)
    const within = finiteNumber(backtest.within3Ratio)
    const pass = backtest.pass === true || (worst !== null && worst.abs <= BACKTEST_PASS_FRAMES) || (mean !== undefined && mean <= BACKTEST_PASS_FRAMES && max !== undefined && max <= BACKTEST_PASS_FRAMES)
    const frames = []
    let evidence
    if (worst !== null) {
      const designed = finiteNumber(worst.item.designedFrame) ?? finiteNumber(worst.item.frame)
      const nearest = finiteNumber(worst.item.nearestBeatFrame)
      if (designed !== undefined) frames.push(designed)
      if (nearest !== undefined) frames.push(nearest)
      evidence = `${frameText(designed, fps)}：卡点误差 ${round(worst.error, 2)} 帧${nearest !== undefined ? `（最近拍：${frameText(nearest, fps)}）` : ''}`
      if (mean !== undefined) evidence += `；平均 ${round(mean, 2)} 帧 · 最大 ${round(max ?? worst.abs, 2)} 帧 · ≤3 帧占比 ${percentText(within)}`
    } else {
      evidence = `平均误差 ${round(mean, 2)} 帧 · 最大 ${round(max, 2)} 帧 · ≤3 帧占比 ${percentText(within)}（阈值 ${BACKTEST_PASS_FRAMES} 帧）`
    }
    rows.push(makeRow({
      id: 'beatsync.backtest',
      titleZh: '卡点回测误差',
      verdict: pass ? 'pass' : 'fail',
      evidenceZh: evidence,
      frames,
      upstreamZh: 'A3',
      fixZh: pass ? undefined : `把切点对齐到最近拍（逐点误差表见 beatsync.rows），目标最大误差 ≤${BACKTEST_PASS_FRAMES} 帧`,
    }))
  } else {
    rows.push(makeRow({ id: 'beatsync.backtest', titleZh: '卡点回测误差', verdict: 'skip', evidenceZh: '无法验证：未提供卡点回测（backtestAlignment）结果', upstreamZh: 'A3' }))
  }

  // A9 — 输出音轨偏移有没有实测并补偿。
  if (beatsync.offset !== null) {
    const offset = beatsync.offset
    const offsetFrames = finiteNumber(offset.offsetFrames)
    const offsetSeconds = finiteNumber(offset.offsetSeconds)
    const correlation = finiteNumber(offset.correlation)
    const pass = offset.pass === true || (correlation !== undefined && correlation >= 0.9)
    rows.push(makeRow({
      id: 'beatsync.offset',
      titleZh: '输出音轨偏移',
      verdict: pass ? 'pass' : 'fail',
      evidenceZh: `实测偏移 ${offsetFrames !== undefined ? `${round(offsetFrames, 2)} 帧` : '—'}${offsetSeconds !== undefined ? `（${round(offsetSeconds, 4)}s）` : ''}${correlation !== undefined ? `，相关系数 ${round(correlation, 3)}` : ''}`,
      frames: offsetFrames !== undefined ? [Math.round(Math.abs(offsetFrames))] : [],
      upstreamZh: 'A9',
      fixZh: pass ? undefined : '先测输出音轨相对源信号的固定滞后，再把它作为补偿常数写回时间线（SOURCE_BEAT0 不要被污染）',
    }))
  } else {
    rows.push(makeRow({ id: 'beatsync.offset', titleZh: '输出音轨偏移', verdict: 'skip', evidenceZh: '无法验证：未提供输出音轨偏移实测结果', upstreamZh: 'A9' }))
  }

  // 节拍网格拟合残差（A3 的前提）：≤15ms。
  if (beatsync.grid !== null) {
    const grid = beatsync.grid
    const residualMax = finiteNumber(grid.residualMaxMs)
    const residualRms = finiteNumber(grid.residualRmsMs)
    const bpm = finiteNumber(grid.bpm)
    const pass = grid.pass === true || (residualMax !== undefined && residualMax <= BEAT_GRID_MAX_RESIDUAL_MS)
    rows.push(makeRow({
      id: 'beatsync.grid',
      titleZh: '节拍网格拟合',
      verdict: pass ? 'pass' : 'warn',
      evidenceZh: `${bpm !== undefined ? `BPM ${round(bpm, 2)}，` : ''}网格残差最大 ${residualMax !== undefined ? `${round(residualMax, 2)}ms` : '—'} · RMS ${residualRms !== undefined ? `${round(residualRms, 2)}ms` : '—'}（阈值 ${BEAT_GRID_MAX_RESIDUAL_MS}ms）`,
      upstreamZh: 'A3',
    }))
  } else if (providedBeatsync) {
    rows.push(makeRow({ id: 'beatsync.grid', titleZh: '节拍网格拟合', verdict: 'skip', evidenceZh: '无法验证：没有网格拟合残差数据', upstreamZh: 'A3' }))
  }

  // A4 — 结尾能量句法（riser→impact→sparkle 或结尾能量不低于峰值）。
  const sections = arrayOrEmpty(objectOrNull(source.audio)?.sections)
  const energies = sections.map((section) => finiteNumber(section?.energy)).filter((value) => value !== undefined)
  if (sections.length >= 2 && energies.length >= 2) {
    const last = sections[sections.length - 1]
    const maxEnergy = Math.max(...energies)
    const lastEnergy = finiteNumber(last?.energy) ?? 0
    const pass = lastEnergy >= maxEnergy * 0.6
    const lastStart = finiteNumber(last?.start)
    const lastEnd = finiteNumber(last?.end) ?? duration
    rows.push(makeRow({
      id: 'audio.ending',
      titleZh: '结尾能量',
      verdict: pass ? 'pass' : 'warn',
      evidenceZh: `结尾段 ${secondsText(lastStart, fps)}–${lastEnd !== undefined ? `${round(lastEnd, 2).toFixed(2)}s` : '—'} 相对能量 ${round(lastEnergy, 2)}（全片峰值 ${round(maxEnergy, 2)}，要求 ≥60% 峰值）`,
      frames: framesFromSeconds(lastStart, fps),
      upstreamZh: 'A4',
    }))
  } else {
    rows.push(makeRow({ id: 'audio.ending', titleZh: '结尾能量', verdict: 'skip', evidenceZh: '无法验证：没有曲式段落能量数据', upstreamZh: 'A4' }))
  }

  return rows
}

/* ------------------------------------------- C 画面：审美判例与文字安全 */

function buildVisualRows(context) {
  const { source, plan, fps } = context
  const rows = []
  const aesthetic = objectOrNull(source.aesthetic)
  if (aesthetic === null) {
    rows.push(makeRow({ id: 'aesthetic.missing', titleZh: '审美判例', verdict: 'skip', evidenceZh: '无法验证：未提供 aesthetic 引擎输出', upstreamZh: 'V/Q' }))
  } else {
    const list = arrayOrEmpty(aesthetic.rows)
    if (list.length === 0) {
      rows.push(makeRow({ id: 'aesthetic.empty', titleZh: '审美判例', verdict: 'skip', evidenceZh: '无法验证：aesthetic 返回 0 行判例', upstreamZh: 'V/Q' }))
    }
    list.forEach((entry, index) => {
      const item = objectOrNull(entry)
      if (item === null) return
      const ruleId = asText(item.id) || `rule-${index + 1}`
      const verdict = mapEngineVerdict(item.verdict)
      const frames = normaliseFrames(item.frames)
      rows.push(makeRow({
        id: `aesthetic.${ruleId}`,
        titleZh: asText(item.titleZh) || asText(item.nameZh) || `判例 ${ruleId}`,
        verdict,
        evidenceZh: asText(item.evidenceZh) || asText(item.evidence) || '该判例没有给出证据文本',
        frames,
        upstreamZh: asText(item.family) || ruleId,
        judgmentZh: asText(item.judgmentZh) || asText(item.descriptionZh),
        detailZh: asText(item.detailZh),
      }))
    })
    // 引擎自己的失败计数若大于逐条失败行数，说明摘要与明细不一致，必须提示而不是吞掉。
    const failures = finiteNumber(aesthetic.failures)
    const warningCount = finiteNumber(aesthetic.warnings)
    const explicitFails = list.filter((entry) => objectOrNull(entry)?.verdict === 'fail').length
    if (failures !== undefined && failures > explicitFails) {
      rows.push(makeRow({
        id: 'aesthetic.failures-mismatch',
        titleZh: '审美判例失败计数',
        verdict: 'warn',
        evidenceZh: `aesthetic 摘要报告 ${failures} 条失败，但逐条明细只有 ${explicitFails} 条 fail：缺明细的失败无法定位，按提醒处理`,
        upstreamZh: 'V/Q',
      }))
    }
    if (warningCount !== undefined && warningCount > 0 && list.every((entry) => objectOrNull(entry)?.verdict !== 'warn')) {
      rows.push(makeRow({
        id: 'aesthetic.warnings-mismatch',
        titleZh: '审美判例提醒计数',
        verdict: 'warn',
        evidenceZh: `aesthetic 摘要报告 ${warningCount} 条提醒，但明细里没有 warn 行`,
        upstreamZh: 'V/Q',
      }))
    }
  }

  // lint：文字出框/字号过小等 plan 级问题 → 用场景时间窗换算成帧号证据。
  const lint = normaliseLint(source.lint)
  if (lint === null) {
    rows.push(makeRow({ id: 'lint.missing', titleZh: '排版与文字安全', verdict: 'skip', evidenceZh: '无法验证：未提供 lint 结果', upstreamZh: 'Q11' }))
  } else if (lint.summaryOnly !== null) {
    const summary = lint.summaryOnly
    const errors = finiteNumber(summary.errors) ?? 0
    const warnings = finiteNumber(summary.warnings) ?? 0
    rows.push(makeRow({
      id: 'lint.summary',
      titleZh: '排版与文字安全',
      verdict: errors > 0 ? 'warn' : warnings > 0 ? 'warn' : 'pass',
      evidenceZh: `lint 摘要：error ${errors} 条 · warn ${warnings} 条${Array.isArray(summary.codes) && summary.codes.length > 0 ? ` · codes ${summary.codes.join(',')}` : ''}`,
      upstreamZh: 'Q11',
      detailZh: errors > 0 ? '只有摘要没有明细，无法定位到帧；要升级为 blocker 需要逐条 violation' : undefined,
    }))
  } else if (lint.violations.length === 0) {
    rows.push(makeRow({ id: 'lint.clean', titleZh: '排版与文字安全', verdict: 'pass', evidenceZh: '0 条 lint 违规（plan/scenes 检查通过）', upstreamZh: 'Q11' }))
  } else {
    const windows = sceneWindows(plan)
    const listed = lint.violations.slice(0, MAX_SECTION_ROWS - rows.length)
    for (const violation of listed) {
      const item = objectOrNull(violation)
      if (item === null) continue
      const code = asText(item.code) || 'rule'
      const sceneIndex = Number.isInteger(item.scene) ? item.scene : undefined
      const window = sceneIndex !== undefined ? windows[sceneIndex] : undefined
      const message = asText(item.messageZh) || `${code} 违规`
      const evidence = window !== undefined ? `场景 ${sceneIndex + 1}（${secondsText(window.start, fps)} 起）：${message}` : message
      rows.push(makeRow({
        id: `lint.${code}`,
        titleZh: `排版：${code}`,
        verdict: item.severity === 'error' ? 'fail' : 'warn',
        evidenceZh: evidence,
        frames: window !== undefined ? framesFromSeconds(window.start, fps) : [],
        upstreamZh: 'Q11',
        detailZh: asText(item.where),
      }))
    }
    if (lint.violations.length > listed.length) {
      rows.push(makeRow({
        id: 'lint.overflow',
        titleZh: '排版：其余违规',
        verdict: 'warn',
        evidenceZh: `另有 ${lint.violations.length - listed.length} 条 lint 违规未展开（共 ${lint.violations.length} 条）`,
        upstreamZh: 'Q11',
      }))
    }
  }
  return rows
}

/** lint 输入：数组 / {violations} / summariseLint() 的摘要对象。 */
function normaliseLint(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return { violations: value, summaryOnly: null }
  const object = objectOrNull(value)
  if (object === null) return null
  if (Array.isArray(object.violations)) return { violations: object.violations, summaryOnly: null }
  if (finiteNumber(object.errors) !== undefined || finiteNumber(object.warnings) !== undefined) {
    return { violations: [], summaryOnly: object }
  }
  return { violations: [], summaryOnly: null }
}

/* ------------------------------------------------ D 数据安全：数据与素材 */

function buildSafetyRows(context) {
  const { source, plan, fps } = context
  const rows = []
  const safety = objectOrNull(source.dataSafety) ?? objectOrNull(source.data) ?? null
  if (safety === null) {
    rows.push(makeRow({
      id: 'data.missing',
      titleZh: '数据与素材合规',
      verdict: 'skip',
      evidenceZh: '无法验证：未提供数据合规口径（D1–D5）；独立审计不据此给通过结论',
      upstreamZh: 'D1–D5',
    }))
    return rows
  }

  // D1 — 真实/虚构/脱敏口径是否被说明。
  const declaration = asText(safety.policyZh) || asText(safety.declarationZh) || asText(safety.policy)
  rows.push(makeRow({
    id: 'data.policy',
    titleZh: '数据口径说明',
    verdict: declaration.length > 0 ? 'pass' : 'warn',
    evidenceZh: declaration.length > 0 ? declaration : '没有提供数据口径说明（真实数据/虚构数据/脱敏）',
    upstreamZh: 'D1',
    fixZh: declaration.length > 0 ? undefined : '在交付说明里写明真实/虚构/脱敏口径，并逐项标注演示数据来源',
  }))

  // D2 — 敏感信息暴露。
  const findings = arrayOrEmpty(safety.sensitiveFindings)
  if (findings.length > 0) {
    for (const finding of findings) {
      const item = objectOrNull(finding)
      const what = item === null ? asText(finding) : asText(item.whatZh) || asText(item.text)
      const frame = item === null ? undefined : finiteNumber(item.frame)
      const where = item === null ? '' : asText(item.whereZh) || asText(item.where)
      const evidence = `${frame !== undefined ? `${frameText(frame, fps)}：` : ''}${where.length > 0 ? `${where}：` : ''}${what.length > 0 ? what : '发现敏感信息'}`
      rows.push(makeRow({
        id: 'data.sensitive',
        titleZh: '敏感信息',
        verdict: 'fail',
        evidenceZh: evidence,
        frames: frame !== undefined ? [frame] : [],
        upstreamZh: 'D2',
        fixZh: '虚构/脱敏/冻结该数据后重新截图与重渲，并在交付说明里记录替换关系',
      }))
    }
  } else {
    rows.push(makeRow({
      id: 'data.sensitive',
      titleZh: '敏感信息',
      verdict: 'pass',
      evidenceZh: '按提供的检查清单未发现客户/个人/密钥/内部地址等敏感信息',
      upstreamZh: 'D2',
    }))
  }

  // D3 — 真实产品页面要用真实截图。
  const screenshotsReal = safety.screenshotsReal ?? safety.realScreenshots
  if (screenshotsReal !== undefined) {
    rows.push(makeRow({
      id: 'data.screenshot',
      titleZh: '真实截图口径',
      verdict: screenshotsReal === true || screenshotsReal === 'pass' ? 'pass' : 'fail',
      evidenceZh: screenshotsReal === true || screenshotsReal === 'pass'
        ? '产品页面使用真实截图（不是手工复刻）'
        : '声明了没有使用真实截图：产品页面需要真实截图而不是手搓复刻',
      upstreamZh: 'D3',
      fixZh: '用真实页面截图（可用 pagecapture）替换手工复刻，并在报告中给出截图来源',
    }))
  } else {
    rows.push(makeRow({ id: 'data.screenshot', titleZh: '真实截图口径', verdict: 'skip', evidenceZh: '无法验证：未提供截图来源声明', upstreamZh: 'D3' }))
  }

  // D4 — 截图状态/字体/图片/动态数据是否完整加载。
  const assetsLoaded = safety.assetsLoaded ?? safety.assetsComplete
  if (assetsLoaded !== undefined) {
    rows.push(makeRow({
      id: 'data.assets',
      titleZh: '素材完整加载',
      verdict: assetsLoaded === true ? 'pass' : 'fail',
      evidenceZh: assetsLoaded === true
        ? '截图状态、字体、图片与动态数据均声明为完整加载'
        : '声明了存在未完整加载的素材（字体/图片/动态数据）',
      upstreamZh: 'D4',
      fixZh: '等字体与图片加载完成后再截图：字体 ready、图片 complete、数据请求返回后再采',
    }))
  } else {
    rows.push(makeRow({ id: 'data.assets', titleZh: '素材完整加载', verdict: 'skip', evidenceZh: '无法验证：未提供资源加载状态', upstreamZh: 'D4' }))
  }

  // D5 — 公开演示数据是否可复核。
  const publicData = safety.publicDataAuditable ?? safety.publicData
  if (publicData !== undefined) {
    rows.push(makeRow({
      id: 'data.public',
      titleZh: '公开数据可复核',
      verdict: publicData === true ? 'pass' : 'warn',
      evidenceZh: publicData === true ? '公开演示数据有可复核的公开属性' : '公开演示数据缺少可复核说明（来源/时间/版本）',
      upstreamZh: 'D5',
    }))
  } else {
    rows.push(makeRow({ id: 'data.public', titleZh: '公开数据可复核', verdict: 'skip', evidenceZh: '无法验证：未提供公开数据说明', upstreamZh: 'D5' }))
  }

  // 额外的可机检项：plan 里出现远程 URL 时，素材不可复现且可能涉及许可。
  const remoteSources = arrayOrEmpty(plan?.scenes)
    .map((scene, index) => ({ scene: objectOrNull(scene), index }))
    .filter(({ scene }) => scene !== null && /^https?:\/\//iu.test(asText(scene.src)))
  if (remoteSources.length > 0) {
    const windows = sceneWindows(plan)
    const first = remoteSources[0]
    rows.push(makeRow({
      id: 'data.remote-assets',
      titleZh: '远程素材可复现性',
      verdict: 'warn',
      evidenceZh: `场景 ${first.index + 1}（${secondsText(windows[first.index]?.start, fps)} 起）使用了远程素材 URL：${asText(first.scene.src).slice(0, 80)}`,
      frames: windows[first.index] !== undefined ? framesFromSeconds(windows[first.index].start, fps) : [],
      upstreamZh: 'D4',
    }))
  }

  return rows
}

/* ----------------------------------------- E 一致性：计划、承接与需求落地 */

function buildConsistencyRows(context) {
  const { source, plan, fps, duration, shots } = context
  const rows = []

  // E1 — 计划时长 vs 实测时长（与 build.js 的 offset 公式对齐）。
  const planned = plannedDuration(plan)
  if (planned !== undefined && duration !== undefined) {
    const diff = Math.abs(planned - duration)
    const tolerance = Math.max(0.15, round(planned * 0.01, 3))
    const pass = diff <= tolerance
    rows.push(makeRow({
      id: 'plan.duration',
      titleZh: '计划时长 vs 实测时长',
      verdict: pass ? 'pass' : 'fail',
      evidenceZh: `计划 ${planned.toFixed(2)}s · 实测 ${duration.toFixed(2)}s · 差 ${diff.toFixed(2)}s（容差 ${tolerance.toFixed(2)}s）`,
      frames: framesFromSeconds(duration, fps),
      upstreamZh: 'B1',
      fixZh: pass ? undefined : '检查场景 duration 与 transitionDuration：成片时长必须等于 场景时长 − 转场重叠，偏差 >容差 说明渲染掉帧或时间线被改过',
    }))
  } else {
    rows.push(makeRow({ id: 'plan.duration', titleZh: '计划时长 vs 实测时长', verdict: 'skip', evidenceZh: '无法验证：缺少 plan 或实测时长', upstreamZh: 'B1' }))
  }

  // E2 — 分镜数 vs 实测镜头数（渐变转场会让硬切检测漏切，差异本身不判失败）。
  const scenes = arrayOrEmpty(plan?.scenes)
  if (scenes.length > 0 && shots.length > 0) {
    const pass = scenes.length === shots.length
    rows.push(makeRow({
      id: 'plan.shots',
      titleZh: '分镜数与实测镜头数',
      verdict: pass ? 'pass' : 'warn',
      evidenceZh: `分镜 ${scenes.length} 场 · 镜头检测 ${shots.length} 个${pass ? '' : '（渐变转场会让硬切检测漏切；若分镜确实被改过要在这条里说明）'}`,
      upstreamZh: 'B4',
    }))
  } else {
    rows.push(makeRow({ id: 'plan.shots', titleZh: '分镜数与实测镜头数', verdict: 'skip', evidenceZh: '无法验证：缺少 plan.scenes 或实测镜头列表', upstreamZh: 'B4' }))
  }

  // E3 — 镜头承接：切点有没有把东西带过去（像不像 PPT）。
  const continuity = objectOrNull(source.continuity)
  if (continuity !== null) {
    const score = finiteNumber(continuity.score) ?? finiteNumber(continuity.built?.score)
    const label = continuityVerdict(score)
    const boundaries = arrayOrEmpty(continuity.boundaries).length > 0 ? continuity.boundaries : arrayOrEmpty(continuity.built?.boundaries)
    const bare = boundaries.filter((entry) => objectOrNull(entry)?.kind === 'bare' && entry.exempt !== true)
    const bareTimes = bare.map((entry) => finiteNumber(entry.t) ?? finiteNumber(entry.time)).filter((value) => value !== undefined)
    const verdict = label === 'ok' ? 'pass' : label === 'ppt' ? 'fail' : label === 'warning' ? 'warn' : 'skip'
    const frames = bareTimes.flatMap((time) => framesFromSeconds(time, fps))
    const parts = []
    if (score !== undefined) parts.push(`承接分 ${round(score, 2)}（判定 ${label}）`)
    if (finiteNumber(continuity.considered) !== undefined) parts.push(`计分边界 ${continuity.considered}`)
    if (bareTimes.length > 0) parts.push(`裸切 ${bareTimes.length} 处：${bareTimes.slice(0, 6).map((time) => secondsText(time, fps)).join('、')}`)
    const blindSpots = arrayOrEmpty(continuity.blindSpots)
    rows.push(makeRow({
      id: 'continuity.carry',
      titleZh: '镜头承接',
      verdict,
      evidenceZh: parts.length > 0 ? parts.join(' · ') : '无法验证：continuity 没有返回承接分',
      frames,
      upstreamZh: 'B2',
      detailZh: blindSpots.length > 0 ? `判定盲区：${blindSpots.slice(0, 2).join('；')}` : undefined,
      fixZh: verdict === 'fail' ? '给裸切补承接元素（同一主体/图形/颜色跨过切点），否则会读成 PPT' : undefined,
    }))
  } else {
    rows.push(makeRow({ id: 'continuity.carry', titleZh: '镜头承接', verdict: 'skip', evidenceZh: '无法验证：未提供 continuity 引擎输出', upstreamZh: 'B2' }))
  }

  // E4 — 需求到执行决策表：每条需求都要有落地证据（P4）。
  const decisions = Array.isArray(source.decisions)
    ? source.decisions
    : Array.isArray(source.decisionTable)
      ? source.decisionTable
      : Array.isArray(source.plan?.decisions)
        ? source.plan.decisions
        : null
  if (decisions === null) {
    rows.push(makeRow({ id: 'plan.decisions', titleZh: '需求到执行落地', verdict: 'skip', evidenceZh: '无法验证：未提供需求到执行决策表（P4）', upstreamZh: 'P4' }))
  } else if (decisions.length === 0) {
    rows.push(makeRow({ id: 'plan.decisions', titleZh: '需求到执行落地', verdict: 'skip', evidenceZh: '无法验证：需求到执行决策表为空', upstreamZh: 'P4' }))
  } else {
    decisions.slice(0, 10).forEach((entry, index) => {
      const item = objectOrNull(entry) ?? {}
      const requirement = asText(item.requirementZh) || asText(item.requirement) || `需求 ${index + 1}`
      const landing = asText(item.landingZh) || asText(item.landing) || asText(item.howZh)
      const frames = normaliseFrames(item.frames)
      if (frames.length === 0 && finiteNumber(item.frame) !== undefined) frames.push(Number(item.frame))
      if (frames.length === 0 && finiteNumber(item.timeSeconds) !== undefined) frames.push(...framesFromSeconds(item.timeSeconds, fps))
      rows.push(makeRow({
        id: `plan.decision-${index + 1}`,
        titleZh: `落地：${requirement.slice(0, 40)}`,
        verdict: landing.length > 0 ? 'pass' : 'warn',
        evidenceZh: landing.length > 0 ? landing : '这条需求在决策表里没有对应的执行落地说明',
        frames,
        upstreamZh: 'P4',
        fixZh: landing.length > 0 ? undefined : '补上需求 → 分镜/文案/页面状态/音频/素材的对应落地，并给帧号',
      }))
    })
    if (decisions.length > 10) {
      rows.push(makeRow({ id: 'plan.decisions-overflow', titleZh: '其余需求', verdict: 'warn', evidenceZh: `另有 ${decisions.length - 10} 条需求未展开（共 ${decisions.length} 条）`, upstreamZh: 'P4' }))
    }
  }

  return rows
}

/* ------------------------------------------------------------ audit film */

function buildCoverage(source, shots) {
  const engines = {
    gate: objectOrNull(source.gate) !== null,
    continuity: objectOrNull(source.continuity) !== null,
    aesthetic: objectOrNull(source.aesthetic) !== null,
    beatsync: objectOrNull(source.beatsync) !== null,
    audio: objectOrNull(source.audio) !== null,
    plan: objectOrNull(source.plan) !== null,
    shots: shots.length > 0,
    lint: source.lint !== null && source.lint !== undefined,
  }
  const missing = Object.keys(engines).filter((key) => engines[key] !== true)
  return { engines, missing }
}

function summaryZhFor(result) {
  const { verdict, score, rowCounts, blockers, warnings, downgraded, missingEngines } = result
  const parts = []
  parts.push(`独立终检判定 ${REVIEW_VERDICT_ZH[verdict]}（${verdict}），分数 ${score}/100。`)
  parts.push(`五节共 ${rowCounts.total} 项：通过 ${rowCounts.pass} / 失败 ${rowCounts.fail} / 提醒 ${rowCounts.warn} / 无法验证 ${rowCounts.skip}。`)
  if (blockers.length > 0) {
    const listed = blockers.slice(0, 3).map((blocker) => `${blocker.sectionId}/${blocker.id}`)
    parts.push(`必须修复 ${blockers.length} 条（全部带帧号或秒证据）：${listed.join('、')}${blockers.length > 3 ? ' 等' : ''}。`)
  }
  if (downgraded.length > 0) parts.push(`${downgraded.length} 条失败项因没有帧号或秒引用，已降级为提醒。`)
  if (missingEngines.length > 0) parts.push(`缺少引擎输入：${missingEngines.join('、')}；相关条目标记为无法验证，没有给通过结论。`)
  else if (warnings.length > 0) parts.push(`存在 ${warnings.length} 条提醒项，结论为有条件通过。`)
  else if (rowCounts.skip > 0) parts.push(`${rowCounts.skip} 条检查无法验证，未计入通过。`)
  if (verdict === 'pass') parts.push('所有可验证条目通过。')
  return parts.join('')
}

/**
 * 聚合各引擎结果，产出独立终检报告。
 *
 * 输入（全部可选，允许 null）：
 * - `gate`        runGate() 的返回
 * - `continuity`  analyzeContinuity() 的返回（或 {ref,built,delta,verdict} 对比形状）
 * - `aesthetic`   auditAesthetic() 的返回 {rows, passRatio, failures, warnings, summaryZh}
 * - `beatsync`    {backtest, offset, grid} 聚合，或其中任一项直接给出
 * - `audio`       analyzeAudio() 的返回；可选带 `sfx`、`bgm`、`versions`
 * - `plan`        RenderPlan
 * - `shots`       镜头列表（数组或 {shots:[…]}）
 * - `lint`        lintPlan() 的违规数组，或 {violations}，或 summariseLint() 的摘要
 * - `dataSafety`  {policyZh, sensitiveFindings, screenshotsReal, assetsLoaded, publicDataAuditable}
 * - `decisions`   需求到执行决策表 [{requirementZh, landingZh, frames}]
 * - `fps`         项目帧率（缺省取 plan.fps，再缺省 30）
 *
 * @param {object} [input]
 * @returns {object} JSON 可序列化报告
 */
export function auditFilm(input = {}) {
  const source = objectOrNull(input) ?? {}
  const plan = objectOrNull(source.plan)
  const fps = resolveFps(source, plan)
  const shots = normaliseShots(source.shots)
  const duration = resolveDuration(source, plan, shots)
  const context = { source, plan, fps, duration, shots }

  const builders = {
    A: buildAudioRows,
    B: buildRhythmRows,
    C: buildVisualRows,
    D: buildSafetyRows,
    E: buildConsistencyRows,
  }

  const sections = REVIEW_SECTIONS.map((definition) => {
    const built = builders[definition.id](context)
    const rows = built.slice(0, MAX_SECTION_ROWS).map((row) => ({ ...finaliseRow(row), sectionId: definition.id, sectionZh: definition.zh }))
    return {
      id: definition.id,
      zh: definition.zh,
      upstreamZh: definition.upstreamZh,
      rows,
      counts: countRows(rows),
    }
  })

  const allRows = sections.flatMap((section) => section.rows)
  const rowCounts = countRows(allRows)
  const blockers = allRows.filter((row) => row.verdict === 'fail')
  const warnings = allRows.filter((row) => row.verdict === 'warn')
  const cannotVerify = allRows.filter((row) => row.verdict === 'skip')
  const downgraded = allRows.filter((row) => row.evidenceMissing === true)
  const coverage = buildCoverage(source, shots)

  const verified = rowCounts.pass + rowCounts.fail + rowCounts.warn
  const verifiedRatio = verified + rowCounts.skip === 0 ? 0 : verified / (verified + rowCounts.skip)
  let verdict = 'pass'
  if (blockers.length > 0) verdict = 'fail'
  else if (warnings.length > 0) verdict = 'warn'
  else if (verified === 0) verdict = 'warn'
  else if (verifiedRatio < 0.5) verdict = 'warn'

  // 分数是 0–100：从 100 扣分，失败（blocker）最重、提醒其次、无法验证只扣一点且设上限。
  const penalty = blockers.length * SCORE_BLOCKER + warnings.length * SCORE_WARN + Math.min(rowCounts.skip * SCORE_SKIP, SCORE_SKIP_CAP)
  const score = clamp(Math.round(100 - penalty), 0, 100)

  const mustFix = blockers.slice(0, MAX_MUST_FIX).map((blocker) => ({
    sectionId: blocker.sectionId,
    sectionZh: blocker.sectionZh,
    id: blocker.id,
    titleZh: blocker.titleZh,
    evidenceZh: blocker.evidenceZh,
    frames: [...blocker.frames],
    fixZh: blocker.fixZh ?? `按证据定位修改后重渲，再跑同一检查（${blocker.sectionZh}/${blocker.id}）`,
  }))

  const report = {
    version: REVIEW_VERSION,
    independent: true,
    disclaimerZh: DISCLAIMER_ZH,
    evidencePolicyZh: EVIDENCE_POLICY_ZH,
    attributionZh: REVIEW_ATTRIBUTION_ZH,
    verdict,
    score,
    scoreWeights: { blocker: SCORE_BLOCKER, warn: SCORE_WARN, skip: SCORE_SKIP },
    fps,
    duration: duration ?? null,
    sections,
    rowCounts,
    blockers,
    mustFix,
    warnings,
    cannotVerify,
    downgraded,
    coverage,
    summaryZh: '',
  }
  report.summaryZh = summaryZhFor({
    verdict,
    score,
    rowCounts,
    blockers,
    warnings,
    downgraded,
    missingEngines: coverage.missing,
  })
  return report
}

/* -------------------------------------------------------- render (Markdown) */

/** blind 模式：移除主观形容词，只留可验证陈述；连引用里的评价词也一并清掉。 */
function blindText(value) {
  let out = asText(value)
  if (out.length === 0) return ''
  for (const word of SORTED_SUBJECTIVE_WORDS) {
    if (out.includes(word)) out = out.split(word).join('')
  }
  out = out.replace(/（\s*）/gu, '')
  out = out.replace(/[（(]\s*[）)]/gu, '')
  out = out.replace(/([，,、；;：:])\s*(?=[，,、；;：:])/gu, '')
  out = out.replace(/:{2,}/gu, '：')
  out = out.replace(/\s{2,}/gu, ' ')
  out = out.replace(/^[\s，,、；;：:]+/u, '')
  out = out.replace(/[\s，,、；;：:]+$/u, '')
  return out.trim()
}

function rowLine(row, blind) {
  const mark = ROW_MARK[row.verdict] ?? '·'
  const title = asText(row.titleZh)
  const evidence = blind ? blindText(row.evidenceZh) : row.evidenceZh
  let line = `- ${row.id} ${mark} ${title.length > 0 ? `${title}：` : ''}${evidence.length > 0 ? evidence : '（无证据文本）'}`
  if (!blind) {
    if (asText(row.detailZh).length > 0) line += `（${row.detailZh}）`
    if (asText(row.judgmentZh).length > 0) line += `｜判断：${row.judgmentZh}`
  }
  return line
}

function fixLine(entry, index, blind) {
  const sanitize = (value) => (blind ? blindText(value) : asText(value))
  const evidence = sanitize(entry.evidenceZh)
  const fix = sanitize(entry.fixZh)
  const mark = ROW_MARK.fail
  return `${index + 1}. **${entry.sectionId}/${entry.id}** ${mark} ${evidence.length > 0 ? evidence : '（无证据文本）'}｜改法：${fix.length > 0 ? fix : '按证据定位修改后重渲并复检'}`
}

/**
 * 渲染独立终检报告。
 *
 * `opts.blind === true`（或 `opts.target === 'blind'`）时进入盲模式：去掉主观
 * 形容词，只保留判定、数字、帧号、秒与 hex；与 media-senses 既有的
 * blind/vision 双模式约定一致（见 lib/render-vision.js）。
 *
 * @param {object} report auditFilm() 的返回
 * @param {{blind?: boolean, target?: 'blind'|'vision', maxRows?: number}} [opts]
 * @returns {string} Markdown
 */
export function renderReviewReport(report, opts = {}) {
  const options = objectOrNull(opts) ?? {}
  const blind = options.blind === true || options.target === 'blind'
  const data = objectOrNull(report)
  const lines = []

  lines.push(`# 独立终检报告${data?.verdict !== undefined ? ` · ${REVIEW_VERDICT_ZH[data.verdict] ?? data.verdict}` : ''}`)
  lines.push('')
  lines.push(`> ${asText(data?.disclaimerZh) || DISCLAIMER_ZH}`)
  lines.push('')

  if (data === null) {
    lines.push('没有可渲染的审计结果（report 为 null）：无法给出终检结论。')
    lines.push('')
    lines.push('## 证据规则')
    lines.push(`> ${EVIDENCE_POLICY_ZH}`)
    return lines.join('\n').trim()
  }

  const score = finiteNumber(data.score)
  const verdictText = blind
    ? `${data.verdict ?? '—'}`
    : `${REVIEW_VERDICT_ZH[data.verdict] ?? '—'}（${data.verdict ?? '—'}）`
  lines.push(`判定：${verdictText} · 分数：${score !== undefined ? `${score}/100` : '—'} · 检查项：${finiteNumber(data.rowCounts?.total) ?? 0}`)
  const engines = objectOrNull(data.coverage?.engines) ?? {}
  const provided = Object.keys(engines).filter((key) => engines[key] === true)
  const missing = Object.keys(engines).filter((key) => engines[key] !== true)
  lines.push(`引擎输入：${provided.length > 0 ? provided.join(' / ') : '无'}${missing.length > 0 ? `；缺少 ${missing.join(' / ')}` : ''}`)
  if (blind) {
    lines.push(`> 盲模式：只保留判定、数字、帧号与秒；主观看法的形容词已移除。`)
  }
  lines.push('')

  lines.push('## 总结')
  lines.push('')
  lines.push(blind ? blindText(data.summaryZh) : asText(data.summaryZh) || '（没有总结文本）')
  lines.push('')

  for (const section of arrayOrEmpty(data.sections)) {
    const rows = arrayOrEmpty(section?.rows)
    const counts = objectOrNull(section?.counts) ?? countRows(rows)
    lines.push(`## ${section?.id ?? '?'} ${section?.zh ?? ''}（通过 ${counts.pass} · 失败 ${counts.fail} · 提醒 ${counts.warn} · 无法验证 ${counts.skip}）`)
    lines.push('')
    for (const row of rows) lines.push(rowLine(row, blind))
    lines.push('')
  }

  const maxRows = Number.isInteger(options.maxRows) && options.maxRows > 0 ? options.maxRows : MAX_RENDER_LIST
  const blockers = arrayOrEmpty(data.blockers).length > 0 ? data.blockers : arrayOrEmpty(data.mustFix)
  if (blockers.length > 0) {
    lines.push(`## 必须修复（${blockers.length} 条，带帧号/秒证据）`)
    lines.push('')
    blockers.forEach((entry, index) => lines.push(fixLine(entry, index, blind)))
    lines.push('')
  }

  const warnings = arrayOrEmpty(data.warnings)
  if (warnings.length > 0) {
    lines.push(`## 提醒（${warnings.length} 条）`)
    lines.push('')
    for (const row of warnings.slice(0, maxRows)) lines.push(rowLine(row, blind))
    if (warnings.length > maxRows) lines.push(`- 另有 ${warnings.length - maxRows} 条提醒未展开`)
    lines.push('')
  }

  const cannotVerify = arrayOrEmpty(data.cannotVerify)
  if (cannotVerify.length > 0) {
    lines.push(`## 无法验证（${cannotVerify.length} 条）`)
    lines.push('')
    for (const row of cannotVerify.slice(0, maxRows)) lines.push(rowLine(row, blind))
    if (cannotVerify.length > maxRows) lines.push(`- 另有 ${cannotVerify.length - maxRows} 条无法验证项未展开`)
    lines.push('')
  }

  lines.push('## 报告说明')
  lines.push('')
  lines.push(`> 证据规则：${EVIDENCE_POLICY_ZH}`)
  lines.push('')
  lines.push(`> 归因：${REVIEW_ATTRIBUTION_ZH}`)
  return lines.join('\n').trim()
}

export default {
  REVIEW_SECTIONS,
  REVIEW_VERSION,
  REVIEW_VERDICT_ZH,
  ROW_MARK,
  SUBJECTIVE_WORDS_ZH,
  DISCLAIMER_ZH,
  EVIDENCE_POLICY_ZH,
  EVIDENCE_MISSING_ZH,
  REVIEW_ATTRIBUTION_ZH,
  auditFilm,
  renderReviewReport,
}
