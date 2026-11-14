/**
 * Reproduction quality rubric.
 *
 * The rubric exists so the model cannot answer "整体不错" and call it a review.
 * Every score must cite evidence that locates the problem in the produced video
 * (a timecode or a frame number) and a fix that contains actual numbers. Entries
 * without either are rejected with a Chinese explanation, because the whole point
 * of a reproduction loop is to turn vague taste into the next concrete edit.
 *
 * Seven dimensions, each scored 1–10, with anchors at 5–10:
 *   5 = 合格学生 / 6 = 模板级 / 7 = 扎实职业 /
 *   8 = 高端 agency / 9 = 奖项短名单 / 10 = 世界最好
 *
 * Zero dependencies, pure functions, deterministic output, all numbers finite.
 */

export const RUBRIC_MAX_SCORE = 10

/** The 1–10 ladder shared by every dimension. */
export const ANCHOR_LADDER_ZH = Object.freeze([
  { score: 5, labelZh: '合格学生' },
  { score: 6, labelZh: '模板级' },
  { score: 7, labelZh: '扎实职业' },
  { score: 8, labelZh: '高端 agency' },
  { score: 9, labelZh: '奖项短名单' },
  { score: 10, labelZh: '世界最好' },
])

/** Read this before scoring: no evidence, no score. */
export const EVIDENCE_RULE_ZH =
  '每条评分必须同时给出 evidence（时间码如 00:03.2 或帧号如 第 96 帧）与 fix（含具体数值的改法）。' +
  '禁止「整体不错」「感觉挺好」这类没有证据的评价——这种条目会被直接拒绝，不计入总分。'

/**
 * The seven rubric dimensions.
 *
 * `anchors` describes 5–10 for this dimension specifically; `lowZh` covers 1–4.
 *
 * @type {ReadonlyArray<{
 *   id: string,
 *   nameZh: string,
 *   questionZh: string,
 *   lowZh: string,
 *   anchors: Record<number, string>,
 * }>}
 */
export const RUBRIC = Object.freeze([
  {
    id: 'style-fidelity',
    nameZh: '风格还原度',
    questionZh: '像不像参考？镜头语法、调色、材质、字体是否属于同一套语言，而不是另做了一条？',
    lowZh: '1–4：只是借了题材，视觉语言基本另一套；调色与镜头语法对不上。',
    anchors: {
      5: '合格学生：能看出参考的影子，但配色/镜头语法换了一半，细看是自创的。',
      6: '模板级：套了同款模板，整体气质对，换内容不会崩，但缺少参考的取舍。',
      7: '扎实职业：镜头、调色、字体都按参考语法执行，可直接商用交付。',
      8: '高端 agency：不只是像，还复刻了参考的取舍逻辑，每个镜头都有理由。',
      9: '奖项短名单：在还原之上有作者签名，个别镜头能被观众记住。',
      10: '世界最好：可以当这个风格的教科书案例，任意一帧都经得起暂停。',
    },
  },
  {
    id: 'content-narrative',
    nameZh: '内容与叙事',
    questionZh: '信息是否讲清楚、顺序是否成立？开头有没有钩子，结尾有没有落点？',
    lowZh: '1–4：信息缺失或顺序错乱，看完不知道要表达什么。',
    anchors: {
      5: '合格学生：信息齐了，但开头平淡、结尾仓促，需要旁白硬撑。',
      6: '模板级：结构完整（钩子-展开-收尾），但每段都是同一句式。',
      7: '扎实职业：信息有取舍，钩子与落点明确，观众不需要旁白也能跟上。',
      8: '高端 agency：叙事有节奏设计，信息按注意力曲线投放，删掉任何一段都会缺。',
      9: '奖项短名单：有一个能被复述的记忆点（一句台词/一个动作/一个反转）。',
      10: '世界最好：叙事本身值得被引用，换掉画面依然成立。',
    },
  },
  {
    id: 'motion-quality',
    nameZh: '运动质量',
    questionZh: '运动是否有意图、有缓动、有不抖？镜头之间的运动方向是否连续？',
    lowZh: '1–4：乱动、抖动、线性机械感明显，或该动的地方完全静止。',
    anchors: {
      5: '合格学生：能看到运镜，但缓动生硬、起止突兀，方向不统一。',
      6: '模板级：套了统一的缓动与运镜，安全但缺少层次，像模板库拼装。',
      7: '扎实职业：每种运动都符合物理直觉，缓动曲线正确，镜头之间方向连贯。',
      8: '高端 agency：运动有主次与呼吸，静止和运动都是设计过的。',
      9: '奖项短名单：有一两处运动本身成为记忆点（甩镜/停顿急推/视差）。',
      10: '世界最好：运动像被编排过的舞蹈，随便截一段都能看出节奏。',
    },
  },
  {
    id: 'typography-layout',
    nameZh: '排版与版式',
    questionZh: '文字是否安全、可读、有层级？字号/行距/安全边距/与字幕的关系是否成立？',
    lowZh: '1–4：文字溢出、字号过小、字幕与标题打架或遮挡主体。',
    anchors: {
      5: '合格学生：能读，但字号偏小/偏大、行距拥挤，小屏上吃力。',
      6: '模板级：版式规整、层级清楚，但每屏长得差不多，缺少版式变化。',
      7: '扎实职业：字号与安全距达标，标题/正文/字幕层级分明。',
      8: '高端 agency：版式跟着内容变化（大字/长文/图表各有解法），留白有意识。',
      9: '奖项短名单：排版本身传达语气，字体选择/字距成为风格的一部分。',
      10: '世界最好：版式经得起逐屏截图检查，任意一屏都能当海报。',
    },
  },
  {
    id: 'polish-texture',
    nameZh: '完成度与质感',
    questionZh: '有没有一眼 AI 味？材质、光影、边缘、过渡是否统一且克制？',
    lowZh: '1–4：模板味/噪点/AI 味明显（紫青渐变、粒子汤、滥用辉光），像未完成稿。',
    anchors: {
      5: '合格学生：整体完整，但能看到素材边缘破绽、光效滥用或风格不统一。',
      6: '模板级：干净但平面，像套了滤镜的通用素材。',
      7: '扎实职业：材质与光影统一，没有明显穿帮，质感可交付。',
      8: '高端 agency：质感有统一的世界观，细节（噪点、边缘、阴影）都在同一套语言里。',
      9: '奖项短名单：质感本身制造情绪，观众不会注意到技术，只记住感觉。',
      10: '世界最好：每一帧都能当宣传物料，放大到 4K 也不露怯。',
    },
  },
  {
    id: 'sound-sync',
    nameZh: '声音与卡点',
    questionZh: '音乐/音效是否服务于画面？切点与节拍是否对齐？旁白与画面是否同步？',
    lowZh: '1–4：音乐盖过旁白、切点完全脱拍，或全程无声像 PPT。',
    anchors: {
      5: '合格学生：有音乐有音效，但音量失衡或只在部分段落对拍。',
      6: '模板级：配乐与音效齐全，卡点大致对齐，但音色是通用素材库。',
      7: '扎实职业：响度达标（约 -16 LUFS）、切点卡在拍上、旁白清晰。',
      8: '高端 agency：声音有设计（J-cut/L-cut、留白、重音），卡点率高于 0.7。',
      9: '奖项短名单：声音能独立成立，闭眼听也能感到节奏与情绪。',
      10: '世界最好：声画是一体的，抽掉任何一个都不成立。',
    },
  },
  {
    id: 'technical-correctness',
    nameZh: '技术正确性',
    questionZh: '规格是否合规？有没有坏帧、黑帧、音画不同步、字体/编码问题？',
    lowZh: '1–4：爆帧、黑屏、音画不同步、字体缺失或分辨率不对等硬故障。',
    anchors: {
      5: '合格学生：能播，但有小瑕疵（单帧闪烁、字幕错位、结尾截断）。',
      6: '模板级：规格达标（分辨率/帧率/时长/响度），没有明显故障。',
      7: '扎实职业：所有技术指标一次过检，黑帧/卡帧/音画偏移都在可接受范围。',
      8: '高端 agency：技术完全隐形，多平台/多尺寸导出都正确。',
      9: '奖项短名单：在严格的技术标准下仍有余量（4K/HDR/多语言版本）。',
      10: '世界最好：零瑕疵，可作为交付标准范本。',
    },
  },
])

export const DIMENSION_IDS = Object.freeze(RUBRIC.map((dimension) => dimension.id))

/** A timecode like 00:03.2 / 1:02.500 / 03.2s / 3 秒 / 帧 96 / frame 42. */
const TIME_REFERENCE_PATTERN =
  /(?:\d{1,2}:\d{2}(?:[.:]\d{1,3})?)|(?:(?:第\s*)?\d+\s*帧)|(?:frame\s*\d+)|(?:\d+(?:\.\d+)?\s*(?:s|秒|ms|毫秒))/iu

/** Vague, evidence-free phrases that the rubric explicitly refuses. */
const GENERIC_PHRASE_PATTERN =
  /整体(?:不错|还行|尚可|可以|挺好|还好)|感觉(?:不错|挺好|还行|一般)|挺好的|还不错|没问题|基本可以|无(?:明显)?问题|有待提升/iu

function round1(value) {
  return Math.round(value * 10) / 10
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/** True when the evidence text locates something in the video (timecode/frame). */
export function hasTimeReference(text) {
  return typeof text === 'string' && TIME_REFERENCE_PATTERN.test(text)
}

/** Resolve a dimension by id or by Chinese name (case-insensitive, trimmed). */
function resolveDimension(value) {
  if (typeof value !== 'string') return null
  const wanted = value.trim().toLowerCase()
  if (wanted.length === 0) return null
  return (
    RUBRIC.find((dimension) => dimension.id.toLowerCase() === wanted) ??
    RUBRIC.find((dimension) => dimension.nameZh.toLowerCase() === wanted) ??
    null
  )
}

/** Shape one rejection consistently. */
function rejection(entry, index, reasonZh) {
  return {
    index,
    dimension: typeof entry?.dimension === 'string' ? entry.dimension : null,
    reasonZh,
  }
}

/**
 * Validate and score a set of rubric entries.
 *
 * Accepted entry shape: `{dimension, score, evidence, fix}` where
 * - `dimension` is one of RUBRIC's ids or Chinese names;
 * - `score` is a finite number in [1, 10];
 * - `evidence` contains a timecode or frame number;
 * - `fix` contains at least one number (a concrete change).
 *
 * If ANY entry is invalid the whole report is rejected (`ok: false`) and every
 * rejection carries a Chinese reason — partial scoring would let a model sneak
 * unverifiable self-praise into the total.
 *
 * @param {Array<{dimension?: string, score?: number, evidence?: string, fix?: string}>} entries
 * @returns {object} JSON-serializable report
 */
export function scoreReport(entries) {
  const rejected = []
  const errors = []

  if (!Array.isArray(entries)) {
    return {
      ok: false,
      messageZh: 'scoreReport 需要条目数组：[{dimension, score, evidence, fix}]。',
      errors: [{ reasonZh: 'entry 不是数组' }],
      rejected: [],
      noteZh: EVIDENCE_RULE_ZH,
    }
  }
  if (entries.length === 0) {
    return {
      ok: false,
      messageZh: '没有任何评分条目：至少给出一个维度的评分，且带证据与改法。',
      errors: [{ reasonZh: 'entries 为空' }],
      rejected: [],
      noteZh: EVIDENCE_RULE_ZH,
    }
  }

  const scored = new Map()
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      rejected.push(rejection(entry, index, '条目不是对象：应为 {dimension, score, evidence, fix}。'))
      continue
    }
    const dimension = resolveDimension(entry.dimension)
    if (dimension === null) {
      rejected.push(
        rejection(
          entry,
          index,
          `未知维度 ${JSON.stringify(entry.dimension)}；可用维度：${RUBRIC.map((item) => item.nameZh).join('、')}。`,
        ),
      )
      continue
    }
    if (scored.has(dimension.id)) {
      rejected.push(rejection(entry, index, `维度「${dimension.nameZh}」重复评分：每个维度只允许一条。`))
      continue
    }
    const score = Number(entry.score)
    if (!Number.isFinite(score) || score < 1 || score > RUBRIC_MAX_SCORE) {
      rejected.push(
        rejection(
          entry,
          index,
          `「${dimension.nameZh}」的 score=${JSON.stringify(entry.score)} 不合法：必须是 1–10 的数字；拿不准就用 5，但必须给证据。`,
        ),
      )
      continue
    }
    const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim() : ''
    if (evidence.length === 0) {
      rejected.push(
        rejection(
          entry,
          index,
          `「${dimension.nameZh}」缺少 evidence：必须写时间码（如 00:03.2）或帧号（如 第 96 帧）。「整体不错」这类无证据评价会被拒绝。`,
        ),
      )
      continue
    }
    if (!hasTimeReference(evidence)) {
      rejected.push(
        rejection(
          entry,
          index,
          `「${dimension.nameZh}」的 evidence 里没有时间码/帧号：「${evidence.slice(0, 40)}」无法定位到画面。改写成「00:03.2 标题切入晚于重音」这种格式。「整体不错」这类评价不计数。`,
        ),
      )
      continue
    }
    const fix = typeof entry.fix === 'string' ? entry.fix.trim() : ''
    if (fix.length === 0) {
      rejected.push(
        rejection(
          entry,
          index,
          `「${dimension.nameZh}」缺少 fix：必须给具体改法，例如「字幕距底从 4% 调到 8%」。`,
        ),
      )
      continue
    }
    if (!/\d/u.test(fix)) {
      rejected.push(
        rejection(
          entry,
          index,
          `「${dimension.nameZh}」的 fix 没有数值：「${fix.slice(0, 40)}」不可执行。改成带数字的版本（例：把 1.5s 的淡入改成 0.4s）。`,
        ),
      )
      continue
    }
    scored.set(dimension.id, {
      dimension: dimension.id,
      nameZh: dimension.nameZh,
      score: round1(score),
      evidence: evidence.slice(0, 400),
      fix: fix.slice(0, 400),
    })
  }

  if (rejected.length > 0) {
    return {
      ok: false,
      messageZh: `评分被拒绝：${rejected.length} 条没有通过证据/改法校验。修好后再提交，不能让无证据的分数进入总分。`,
      errors: rejected,
      rejected,
      noteZh: EVIDENCE_RULE_ZH,
    }
  }

  const dimensions = RUBRIC.map((dimension) => scored.get(dimension.id)).filter((entry) => entry !== undefined)
  const total = round1(dimensions.reduce((sum, entry) => sum + entry.score, 0))
  const average = round2(total / dimensions.length)
  const maxTotal = dimensions.length * RUBRIC_MAX_SCORE
  const rubricOrder = new Map(RUBRIC.map((dimension, index) => [dimension.id, index]))
  const ranked = [...dimensions].sort(
    (a, b) => a.score - b.score || rubricOrder.get(a.dimension) - rubricOrder.get(b.dimension),
  )
  const weak = ranked.filter((entry) => entry.score < 8)
  const mustFix = ranked.slice(0, Math.min(3, ranked.length))
  const missing = RUBRIC.filter((dimension) => !scored.has(dimension.id)).map((dimension) => ({
    id: dimension.id,
    nameZh: dimension.nameZh,
  }))
  const warnings = []
  if (missing.length > 0) {
    warnings.push(
      `还有 ${missing.length} 个维度未评分（${missing.map((item) => item.nameZh).join('、')}）：总分只按已评分维度计算，但正式报告应覆盖全部 7 维。`,
    )
  }
  return {
    ok: true,
    dimensions,
    total,
    maxTotal,
    average,
    weak,
    mustFix,
    missingDimensions: missing,
    warnings,
    noteZh: EVIDENCE_RULE_ZH,
  }
}

/** Escape a Markdown table cell. */
function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

const TOTAL_LINE_ZH = '总分'

/**
 * Render the rubric as a Markdown table for the model to fill in, or as a filled
 * report when a `scoreReport` result is passed.
 *
 * @param {object} [result] output of `scoreReport`
 * @returns {string} Markdown
 */
export function renderRubricTemplate(result) {
  const lines = []
  lines.push('# 视频评分卡 · 7 维自评')
  lines.push('')
  lines.push(`> ${EVIDENCE_RULE_ZH}`)
  lines.push('')
  lines.push(
    `锚点速查：${ANCHOR_LADDER_ZH.map((anchor) => `${anchor.score}=${anchor.labelZh}`).join(' · ')}`,
  )
  lines.push('')

  const isFilled = result !== null && typeof result === 'object' && result.ok === true
  const isRejected = result !== null && typeof result === 'object' && result.ok === false

  if (isFilled) {
    lines.push('| 维度 | 分数 | 5 分锚点 | 证据 | 改法 |')
    lines.push('|---|---|---|---|---|')
    const byId = new Map((result.dimensions ?? []).map((entry) => [entry.dimension, entry]))
    for (const dimension of RUBRIC) {
      const entry = byId.get(dimension.id)
      const scoreText = entry === undefined ? '—' : String(entry.score)
      const evidenceText = entry === undefined ? '（未评分）' : cell(entry.evidence)
      const fixText = entry === undefined ? '—' : cell(entry.fix)
      lines.push(`| ${dimension.nameZh} | ${scoreText} | ${cell(dimension.anchors[5])} | ${evidenceText} | ${fixText} |`)
    }
    lines.push('')
    lines.push(`## ${TOTAL_LINE_ZH}`)
    lines.push('')
    lines.push(
      `${TOTAL_LINE_ZH}：**${result.total} / ${result.maxTotal}** · 平均 **${result.average} / ${RUBRIC_MAX_SCORE}**`,
    )
    lines.push('')
    if (Array.isArray(result.weak) && result.weak.length > 0) {
      lines.push('## 弱项（从低到高）')
      lines.push('')
      for (const entry of result.weak) {
        lines.push(`- **${entry.nameZh} ${entry.score} 分** —— ${cell(entry.evidence)}`)
      }
      lines.push('')
    }
    if (Array.isArray(result.mustFix) && result.mustFix.length > 0) {
      lines.push('## 必须修的 3 条')
      lines.push('')
      result.mustFix.forEach((entry, index) => {
        lines.push(`${index + 1}. **${entry.nameZh}**：${cell(entry.fix)}`)
      })
      lines.push('')
    }
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      lines.push('## 提示')
      lines.push('')
      for (const warning of result.warnings) lines.push(`- ${warning}`)
      lines.push('')
    }
    return lines.join('\n').trim()
  }

  if (isRejected) {
    lines.push('## 评分被拒绝')
    lines.push('')
    lines.push(result.messageZh ?? '有评分条目没有通过证据校验。')
    lines.push('')
    const errors = Array.isArray(result.errors) ? result.errors : []
    for (const error of errors) {
      lines.push(`- ${error.reasonZh ?? JSON.stringify(error)}`)
    }
    lines.push('')
  }

  lines.push('| 维度 | 分数(1–10) | 5 分锚点（合格学生） | 证据（时间码/帧号） | 改法（含数值） |')
  lines.push('|---|---|---|---|---|')
  for (const dimension of RUBRIC) {
    lines.push(`| ${dimension.nameZh} |  | ${cell(dimension.anchors[5])} |  |  |`)
  }
  lines.push('')
  lines.push('## 评分说明')
  lines.push('')
  lines.push(`- 每个维度 1–${RUBRIC_MAX_SCORE} 分；${ANCHOR_LADDER_ZH.map((anchor) => `${anchor.score}=${anchor.labelZh}`).join('，')}。`)
  lines.push('- 低分不等于失败：5 分也合格，但要写清「差在哪、下一版改哪个数」。')
  lines.push('- 「整体不错」「感觉挺好」这类没有时间码/帧号的评价会被直接拒绝。')
  return lines.join('\n').trim()
}

export default {
  RUBRIC,
  RUBRIC_MAX_SCORE,
  ANCHOR_LADDER_ZH,
  EVIDENCE_RULE_ZH,
  DIMENSION_IDS,
  hasTimeReference,
  scoreReport,
  renderRubricTemplate,
}
