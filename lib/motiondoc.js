/**
 * lib/motiondoc.js — the reproduction contract ("what we keep, what we swap").
 *
 * Why this module exists: the loop could already *analyse* a reference and
 * *render* something like it, but it had no place to write down the one decision
 * that makes a reproduction a reproduction rather than an imitation —
 * **which creative decisions are inherited and which are replaced**. Without that
 * written down, a second revision silently re-litigates the whole film, and a
 * collaborator cannot tell a deliberate choice from an accident.
 *
 * The model is a nine-section handover document plus three mechanisms:
 *
 *  - `buildKeepReplaceTable` — per-shot "the technique kept / the content used",
 *    with a hard capacity limit per slot. This is the contract in its smallest form.
 *  - `buildClipMap` — source time is not output time. Keeping source 12–18 s at
 *    output 0–6 s means an event at source 15 s lands at output 3 s; subtitles and
 *    overlays have to be re-mapped, not shifted by a constant.
 *  - `planCheckpoints` — compare the reference and the replica **at the same
 *    named moments**, with an expectation for each, instead of comparing two
 *    arbitrary frames and arguing about the average.
 *
 * Epistemics: every statement carries `basis` — `observed` (measured on the
 * reference), `inferred` (a creative decision read out of the measurement) or
 * `changed` (a deliberate departure). Collapsing these three into one voice is how
 * a report starts sounding confident about things nobody checked.
 *
 * Attribution: the nine-section shape, the five evidence levels, the keep/replace
 * table, the "long copy is re-broken, never shrunk" rule and the paired-checkpoint
 * idea come from OpenMotion's Motion.md specification (nexu-io/openmotion,
 * Apache-2.0) via its `docs/motion-md.zh-CN.md` and `examples/reference-reveal/`.
 * The implementation, validators, Chinese copy and thresholds here are written for
 * this repository. See THIRD-PARTY.md.
 *
 * @module lib/motiondoc
 */

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/** The nine sections a handover document must carry, in reading order. */
export const MOTION_DOC_SECTIONS = Object.freeze([
  { id: 'identity', zh: '身份与来源', asksZh: '名称、版本、原作者/链接、原始片源版本、权限与验证状态' },
  { id: 'brandKit', zh: '品牌与素材事实', asksZh: '品牌身份、产品事实、Logo、配色、字体、语气与已确认素材' },
  { id: 'narrative', zh: '叙事语法', asksZh: '受众、钩子、揭示顺序、证据与收尾；每个镜头承担什么信息' },
  { id: 'visual', zh: '视觉层级', asksZh: '构图、字级、景深、对比、留白；每个停留点的视觉焦点' },
  { id: 'timing', zh: '时间与运动', asksZh: '镜头边界、停留、缓动、运镜路径、遮罩、转场与连续性' },
  { id: 'assets', zh: '素材与声音', asksZh: '哪些必须由用户提供、哪些可以生成；同步点与替代方案' },
  { id: 'keep', zh: '保持项', asksZh: '内容变化后仍应保留的创作决定（逐镜头写）' },
  { id: 'replace', zh: '可替换项', asksZh: '文案/人物/数据/品牌/画幅，以及容量上限与溢出处理' },
  { id: 'checks', zh: '检查与证据', asksZh: '同时刻对照、源码与产物身份、技术检查；写实际差距' },
])

/**
 * How much has actually been proved. Ordered weakest → strongest.
 *
 * The point of naming these is that "we reproduced it" is not one claim but four:
 * a description, a source file, a rendered output, and a reviewed comparison.
 */
export const EVIDENCE_LEVELS = Object.freeze([
  { id: 'reference', zh: '有参考', requiresZh: '参考片及可追溯来源' },
  { id: 'described', zh: '已描述风格', requiresZh: '本文档、观察/推断标记与替换意图' },
  { id: 'editable', zh: '可编辑示例', requiresZh: '真实源码、素材要求与已知限制' },
  { id: 'rendered', zh: '已渲染改编版', requiresZh: '实质变化的输入、实际产物与渲染身份' },
  { id: 'reviewed', zh: '已评审复刻', requiresZh: '与原作的对照、明确差距与人工接受范围' },
])

/** How a statement was arrived at. Never collapse these three. */
export const BASIS = Object.freeze([
  { id: 'observed', zh: '观察' },
  { id: 'inferred', zh: '推断' },
  { id: 'changed', zh: '主动改动' },
])

const BASIS_IDS = new Set(BASIS.map((entry) => entry.id))

/** What to do when replacement content does not fit its slot. */
export const OVERFLOW_POLICIES = Object.freeze([
  { id: 'rebreak', zh: '重排/拆分受影响镜头（唯一正确做法）' },
  { id: 'truncate', zh: '按字数截断并改写（可接受，须记录）' },
  { id: 'shrink', zh: '缩小字号硬塞（禁止：读不清等于没写）' },
])

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function round(value, digits) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function textLength(value) {
  // Count characters the way a reader sees them: code points, not UTF-16 units.
  return typeof value === 'string' ? [...value].length : 0
}

/* ------------------------------------------------------------------ *
 * 1. Keep / replace table — the contract in its smallest form
 * ------------------------------------------------------------------ */

/**
 * One row per shot: the technique inherited from the reference, and the content
 * that replaces the original's.
 *
 * A row is only usable if it names **both** sides. "Keeps the rhythm" with no
 * statement of what fills the shot is not a contract, it is a mood; and content
 * with no inherited technique is a new film wearing the reference's clothes.
 *
 * @param {Array<{fromSeconds?: number, toSeconds?: number, keepZh?: string,
 *   useZh?: string, capacity?: number, actual?: number,
 *   overflow?: 'rebreak'|'truncate'|'shrink', basis?: string}>} shots
 * @returns {{rows: Array<object>, errors: string[], warnings: string[]}}
 */
export function buildKeepReplaceTable(shots) {
  const rows = []
  const errors = []
  const warnings = []
  const list = asArray(shots)
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index]
    const label = `镜头 ${index + 1}`
    if (!isPlainObject(raw)) {
      errors.push(`${label} 不是一个对象`)
      continue
    }
    const from = Number(raw.fromSeconds)
    const to = Number(raw.toSeconds)
    const keepZh = typeof raw.keepZh === 'string' ? raw.keepZh.trim() : ''
    const useZh = typeof raw.useZh === 'string' ? raw.useZh.trim() : ''
    if (keepZh.length === 0) errors.push(`${label} 没写「保留的拍法」——这行等于没约定`)
    if (useZh.length === 0) errors.push(`${label} 没写「本片用什么内容」——这行等于没约定`)
    const capacity = Number.isFinite(Number(raw.capacity)) ? Number(raw.capacity) : null
    const actual = Number.isFinite(Number(raw.actual)) ? Number(raw.actual) : textLength(useZh)
    const overflow = typeof raw.overflow === 'string' ? raw.overflow : null
    if (capacity !== null && actual > capacity) {
      const policy = overflow ?? 'rebreak'
      if (policy === 'shrink') {
        errors.push(`${label} 内容 ${actual} 字超过容量 ${capacity}，却打算缩小字号硬塞——读不清等于没写，必须重排或截断改写`)
      } else if (policy === 'rebreak') {
        warnings.push(`${label} 内容 ${actual} 字超过容量 ${capacity}：按规则要拆分/重排受影响镜头，排时间线时把多出来的时长算进去`)
      } else {
        warnings.push(`${label} 内容 ${actual} 字超过容量 ${capacity}，选择截断改写——记得把改后的文案记回文档`)
      }
    }
    const basis = typeof raw.basis === 'string' && BASIS_IDS.has(raw.basis) ? raw.basis : 'inferred'
    rows.push({
      index,
      fromSeconds: Number.isFinite(from) ? round(from, 3) : null,
      toSeconds: Number.isFinite(to) ? round(to, 3) : null,
      keepZh,
      useZh,
      capacity,
      actual,
      overflow,
      basis,
    })
    if (basis === 'inferred' && keepZh.length > 0 && Number.isFinite(from) === false) {
      warnings.push(`${label} 只标了「推断」而没有时间区间：看不出它在片子哪一段，复审时无法核对`)
    }
  }
  return { rows, errors, warnings }
}

/* ------------------------------------------------------------------ *
 * 2. Clip map — source time is not output time
 * ------------------------------------------------------------------ */

/**
 * Map source-footage time onto output-timeline time.
 *
 * Keeping source 12–18 s at output 0–6 s means the event at source 15 s sits at
 * output 3 s. Subtitles and overlays written against the source therefore have to
 * be **re-mapped**, not shifted by a constant — a constant shift is only correct
 * when there is exactly one segment.
 *
 * Segments must be monotonic and must not overlap in either domain; a gap in the
 * output means black/silence, and a gap in the source means dropped footage.
 *
 * @param {Array<{sourceIn: number, sourceOut: number, outputIn: number, labelZh?: string}>} segments
 * @returns {{segments: Array<object>, errors: string[], warnings: string[],
 *   sourceToOutput: (t: number) => number|null, outputToSource: (t: number) => number|null,
 *   remapSubtitles: (cues: Array<object>) => Array<object>}}
 */
export function buildClipMap(segments) {
  const rows = []
  const errors = []
  const warnings = []
  const list = asArray(segments)
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index]
    const label = `片段 ${index + 1}`
    if (!isPlainObject(raw)) {
      errors.push(`${label} 不是一个对象`)
      continue
    }
    const sourceIn = Number(raw.sourceIn)
    const sourceOut = Number(raw.sourceOut)
    const outputIn = Number(raw.outputIn)
    if (!Number.isFinite(sourceIn) || !Number.isFinite(sourceOut) || !Number.isFinite(outputIn)) {
      errors.push(`${label} 需要 sourceIn / sourceOut / outputIn 三个有限数字`)
      continue
    }
    if (!(sourceOut > sourceIn)) {
      errors.push(`${label} 的 sourceOut (${sourceOut}) 必须大于 sourceIn (${sourceIn})`)
      continue
    }
    rows.push({
      index,
      sourceIn: round(sourceIn, 3),
      sourceOut: round(sourceOut, 3),
      outputIn: round(outputIn, 3),
      outputOut: round(outputIn + (sourceOut - sourceIn), 3),
      durationSeconds: round(sourceOut - sourceIn, 3),
      labelZh: typeof raw.labelZh === 'string' ? raw.labelZh.trim() : '',
    })
  }

  rows.sort((a, b) => a.outputIn - b.outputIn)
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]
    const current = rows[index]
    if (current.outputIn < previous.outputOut - 1e-6) {
      errors.push(`输出时间重叠：片段 ${previous.index + 1} 到 ${previous.outputOut}s，片段 ${current.index + 1} 从 ${current.outputIn}s 开始`)
    } else if (current.outputIn > previous.outputOut + 1e-6) {
      warnings.push(`输出时间有空档：${previous.outputOut}s–${current.outputIn}s 之间没有素材（黑场或留白，确认是有意的）`)
    }
    if (current.sourceIn < previous.sourceOut - 1e-6) {
      errors.push(`源时间重叠：片段 ${previous.index + 1} 与片段 ${current.index + 1} 用了同一段源素材`)
    }
  }

  const sourceToOutput = (time) => {
    const value = Number(time)
    if (!Number.isFinite(value)) return null
    for (const row of rows) {
      if (value >= row.sourceIn - 1e-6 && value <= row.sourceOut + 1e-6) {
        return round(row.outputIn + (value - row.sourceIn), 3)
      }
    }
    return null
  }
  const outputToSource = (time) => {
    const value = Number(time)
    if (!Number.isFinite(value)) return null
    for (const row of rows) {
      if (value >= row.outputIn - 1e-6 && value <= row.outputOut + 1e-6) {
        return round(row.sourceIn + (value - row.outputIn), 3)
      }
    }
    return null
  }

  /**
   * Re-map subtitle cues written against the **source** clock onto the output
   * clock. A cue that straddles a cut is split; a cue wholly inside a dropped
   * segment is reported rather than silently deleted.
   */
  const remapSubtitles = (cues) => {
    const out = []
    const dropped = []
    for (const cue of asArray(cues)) {
      const start = Number(cue?.start)
      const end = Number(cue?.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      let produced = false
      for (const row of rows) {
        const overlapStart = Math.max(start, row.sourceIn)
        const overlapEnd = Math.min(end, row.sourceOut)
        if (!(overlapEnd > overlapStart)) continue
        out.push({
          start: round(row.outputIn + (overlapStart - row.sourceIn), 3),
          end: round(row.outputIn + (overlapEnd - row.sourceIn), 3),
          text: typeof cue.text === 'string' ? cue.text : '',
          split: overlapEnd - overlapStart < end - start - 1e-6,
          sourceSegment: row.index,
        })
        produced = true
      }
      if (!produced) dropped.push({ start, end, text: typeof cue.text === 'string' ? cue.text : '' })
    }
    out.sort((a, b) => a.start - b.start)
    if (dropped.length > 0) {
      warnings.push(`${dropped.length} 条字幕落在被剪掉的源片段里，已丢弃（确认它们本来就不该出现）`)
    }
    return out
  }

  return { segments: rows, errors, warnings, sourceToOutput, outputToSource, remapSubtitles }
}

/* ------------------------------------------------------------------ *
 * 3. Paired checkpoints — compare at the same named moments
 * ------------------------------------------------------------------ */

/**
 * Compare a replica against its reference at **named moments**, not at a random
 * frame. "At 2.65 s the cards should be in the same place" is checkable; "the
 * average difference is 12" is not a statement anyone can act on.
 *
 * Default checkpoints are derived from the cuts: every shot boundary plus the
 * midpoint of the longest shot, which is where a hold or a reveal settles.
 *
 * @param {{durationSeconds?: number, shots?: Array<{start: number, duration?: number}>,
 *   pairs?: Array<{referenceAt: number, builtAt?: number, whatZh: string}>,
 *   maxCheckpoints?: number}} [options]
 * @returns {Array<{index: number, referenceAt: number, builtAt: number, whatZh: string}>}
 */
export function planCheckpoints(options = {}) {
  const settings = isPlainObject(options) ? options : {}
  const explicit = asArray(settings.pairs)
  if (explicit.length > 0) {
    return explicit.map((pair, index) => {
      const referenceAt = Number(pair?.referenceAt)
      const builtAt = Number.isFinite(Number(pair?.builtAt)) ? Number(pair.builtAt) : referenceAt
      return {
        index,
        referenceAt: Number.isFinite(referenceAt) ? round(referenceAt, 3) : 0,
        builtAt: Number.isFinite(builtAt) ? round(builtAt, 3) : 0,
        whatZh: typeof pair?.whatZh === 'string' ? pair.whatZh : '对照这一刻',
      }
    })
  }

  const duration = Number(settings.durationSeconds)
  const shots = asArray(settings.shots).filter((shot) => Number.isFinite(Number(shot?.start)))
  const limit = Number.isFinite(Number(settings.maxCheckpoints)) ? Math.max(1, Math.round(Number(settings.maxCheckpoints))) : 6
  const points = []

  for (let index = 1; index < shots.length; index += 1) {
    const at = Number(shots[index].start)
    points.push({ at, whatZh: `第 ${index} 个切点刚过（切点本身是黑场交界，往后退 2 帧再看）` })
  }
  if (shots.length > 0) {
    // The midpoint of the longest shot is where a hold or a reveal settles.
    let longest = shots[0]
    for (const shot of shots) {
      if (Number(shot?.duration) > Number(longest?.duration)) longest = shot
    }
    if (Number.isFinite(Number(longest?.start)) && Number.isFinite(Number(longest?.duration))) {
      points.push({ at: Number(longest.start) + Number(longest.duration) / 2, whatZh: '最长镜头的停留点：主体落定、文字可读' })
    }
  }
  if (points.length === 0 && Number.isFinite(duration) && duration > 0) {
    for (const fraction of [0.25, 0.5, 0.75]) points.push({ at: duration * fraction, whatZh: `全片 ${Math.round(fraction * 100)}% 处` })
  }

  points.sort((a, b) => a.at - b.at)
  // Nudge cut checkpoints 2 frames past the boundary: exactly on the cut is
  // usually a transition frame, which compares badly for reasons that are not a
  // reproduction failure.
  return points.slice(0, limit).map((point, index) => ({
    index,
    referenceAt: round(point.at, 3),
    builtAt: round(point.at, 3),
    whatZh: point.whatZh,
  }))
}

/** Pixel verdicts that count as a checkpoint pass. */
export const CHECKPOINT_PASS_VERDICTS = Object.freeze(['match', 'close'])

/* ------------------------------------------------------------------ *
 * 4. The handover document
 * ------------------------------------------------------------------ */

/**
 * Section id → the field that actually carries it.
 *
 * `keep` and `replace` live in one table (`keepReplace`) because a row that names
 * only one side is not a contract; `checks` lives in `checkpoints` + `evidence`.
 * Checking the literal section ids against the document keys would report false
 * "missing section" errors forever.
 */
const SECTION_FIELDS = Object.freeze({
  identity: 'identity',
  brandKit: 'brandKit',
  narrative: 'narrative',
  visual: 'visual',
  timing: 'timing',
  assets: 'assets',
  keep: 'keepReplace',
  replace: 'keepReplace',
  checks: 'checkpoints',
})

/** Sections whose absence is an error rather than a note. */
const REQUIRED_SECTIONS = Object.freeze(['identity', 'keep', 'replace'])

/**
 * Assemble a nine-section handover document.
 *
 * @param {object} input
 * @param {{name?: string, version?: string, author?: string, sourceUrl?: string,
 *   sourceVersion?: string, license?: string}} [input.identity]
 * @param {object} [input.brandKit]
 * @param {object} [input.narrative]
 * @param {object} [input.visual]
 * @param {object} [input.timing]
 * @param {object} [input.assets]
 * @param {Array<object>} [input.keepReplace] rows or raw shots for the table
 * @param {Array<object>} [input.clipMap] segments for the source→output map
 * @param {Array<object>} [input.checkpoints]
 * @param {{level?: string, notesZh?: string, artifacts?: string[]}} [input.evidence]
 * @param {Array<{textZh: string, basis?: string}>} [input.claims]
 * @returns {{doc: object, markdown: string, errors: string[], warnings: string[], level: string}}
 */
export function buildMotionDoc(input = {}) {
  const source = isPlainObject(input) ? input : {}
  const errors = []
  const warnings = []

  const identity = isPlainObject(source.identity) ? { ...source.identity } : {}
  if (typeof identity.name !== 'string' || identity.name.trim().length === 0) errors.push('身份与来源缺 name')
  if (typeof identity.sourceUrl !== 'string' || identity.sourceUrl.trim().length === 0) {
    warnings.push('没记原始片源链接：将来无法追溯这一版是从哪支参考片来的')
  }
  if (typeof identity.license !== 'string' || identity.license.trim().length === 0) {
    warnings.push('没记许可：代码、字体、图片、音乐、素材可能各有各的条款，需要逐项记')
  }

  const table = buildKeepReplaceTable(
    asArray(source.keepReplace).map((row) => (row && typeof row === 'object' && 'keepZh' in row ? row : row)),
  )
  errors.push(...table.errors)
  warnings.push(...table.warnings)
  if (table.rows.length === 0) errors.push('保持项/可替换项为空：这份文档没有约定任何东西')

  const clipMap = buildClipMap(asArray(source.clipMap))
  errors.push(...clipMap.errors)
  warnings.push(...clipMap.warnings)

  const checkpoints = Array.isArray(source.checkpoints)
    ? planCheckpoints({ pairs: source.checkpoints })
    : planCheckpoints({ durationSeconds: source.durationSeconds, shots: source.shots })

  const claims = asArray(source.claims)
    .filter((claim) => isPlainObject(claim) && typeof claim.textZh === 'string' && claim.textZh.trim().length > 0)
    .map((claim) => ({
      textZh: claim.textZh.trim(),
      basis: typeof claim.basis === 'string' && BASIS_IDS.has(claim.basis) ? claim.basis : 'inferred',
    }))

  const evidence = isPlainObject(source.evidence) ? { ...source.evidence } : {}
  const level = inferEvidenceLevel({ ...source, clipMap: clipMap.segments, checkpoints, evidence })
  const declared = typeof evidence.level === 'string' ? evidence.level : null
  if (declared !== null && !EVIDENCE_LEVELS.some((entry) => entry.id === declared)) {
    errors.push(`evidence.level「${declared}」不是已知等级（${EVIDENCE_LEVELS.map((entry) => entry.id).join(' / ')}）`)
  }
  if (declared !== null) {
    const declaredIndex = EVIDENCE_LEVELS.findIndex((entry) => entry.id === declared)
    const inferredIndex = EVIDENCE_LEVELS.findIndex((entry) => entry.id === level)
    if (declaredIndex > inferredIndex) {
      errors.push(`声称的等级「${declared}」高于证据能支撑的「${level}」——等级只能由证据推出来，不能自己填`)
    }
  }

  const doc = {
    version: 'motiondoc/1',
    sections: MOTION_DOC_SECTIONS.map((section) => section.id),
    identity,
    brandKit: isPlainObject(source.brandKit) ? source.brandKit : {},
    narrative: isPlainObject(source.narrative) ? source.narrative : {},
    visual: isPlainObject(source.visual) ? source.visual : {},
    timing: isPlainObject(source.timing) ? source.timing : {},
    assets: isPlainObject(source.assets) ? source.assets : {},
    keepReplace: table.rows,
    clipMap: clipMap.segments,
    checkpoints,
    claims,
    evidence: { ...evidence, level },
  }

  for (const id of REQUIRED_SECTIONS) {
    const field = SECTION_FIELDS[id]
    const value = doc[field]
    const empty = Array.isArray(value) ? value.length === 0 : !isPlainObject(value) || Object.keys(value).length === 0
    if (empty) errors.push(`缺少必需章节「${MOTION_DOC_SECTIONS.find((section) => section.id === id)?.zh ?? id}」`)
  }
  if (!Array.isArray(doc.checkpoints) || doc.checkpoints.length === 0) {
    warnings.push('没有对照检查点：只能靠"感觉像"，出问题也说不清在哪一刻')
  }

  return { doc, markdown: renderMotionDocMarkdown(doc), errors, warnings, level }
}

/**
 * Highest evidence level the inputs can actually support.
 *
 * Deliberately conservative: "I have a source file" is not "I rendered it", and
 * "I rendered it" is not "someone reviewed the comparison".
 */
export function inferEvidenceLevel(input) {
  const source = isPlainObject(input) ? input : {}
  const hasReference = typeof source.identity?.sourceUrl === 'string' || source.hasReference === true
  const hasDescription = asArray(source.keepReplace).length > 0 || asArray(source.claims).length > 0
  const hasSource = source.hasSource === true || source.hasEditableSource === true
  const hasRender = source.hasRender === true || typeof source.outputPath === 'string'
  const hasReview = source.hasReview === true || source.reviewed === true
  if (hasReview) return 'reviewed'
  if (hasRender) return 'rendered'
  if (hasSource) return 'editable'
  if (hasReference && hasDescription) return 'described'
  if (hasReference) return 'reference'
  return 'reference'
}

/**
 * Validate a handover document that already exists (e.g. read back from a file).
 *
 * @param {object} doc
 * @returns {{errors: string[], warnings: string[], level: string|null}}
 */
export function validateMotionDoc(doc) {
  if (!isPlainObject(doc)) throw new Error('validateMotionDoc(doc) 需要一个对象')
  const errors = []
  const warnings = []
  for (const section of MOTION_DOC_SECTIONS) {
    // Check the *field* that carries the section, not the section id: `keep` and
    // `replace` share `keepReplace`, and `checks` lives in `checkpoints`.
    const field = SECTION_FIELDS[section.id] ?? section.id
    if (!(field in doc)) errors.push(`缺少章节「${section.zh}」`)
  }
  const table = buildKeepReplaceTable(doc.keepReplace)
  errors.push(...table.errors)
  warnings.push(...table.warnings)
  // A present-but-empty table is not a document: it commits to nothing.
  if (table.rows.length === 0) errors.push('保持项/可替换项为空：这份文档没有约定任何东西')
  const clipMap = buildClipMap(doc.clipMap)
  errors.push(...clipMap.errors)
  warnings.push(...clipMap.warnings)
  const level = typeof doc.evidence?.level === 'string' ? doc.evidence.level : null
  if (level === null) warnings.push('没写证据等级：读者无法判断这是描述、源码还是真的渲过')
  if (!Array.isArray(doc.checkpoints) || doc.checkpoints.length === 0) {
    warnings.push('没有对照检查点：只能靠"感觉像"，出问题也说不清在哪一刻')
  }
  return { errors, warnings, level }
}

/* ------------------------------------------------------------------ *
 * 5. Markdown
 * ------------------------------------------------------------------ */

function tableRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? '').trim() || '—').join(' | ')} |`
}

/**
 * Render the document as Markdown.
 *
 * Written to be readable by a human reviewer *and* pasteable to a model: the
 * keep/replace table and the checkpoint table are the two things that get acted on.
 */
export function renderMotionDocMarkdown(doc) {
  const lines = []
  const identity = doc.identity ?? {}
  const levelZh = EVIDENCE_LEVELS.find((entry) => entry.id === doc.evidence?.level)?.zh ?? '未评级'
  lines.push(`# ${identity.name ?? '复刻交接文档'} · MOTION.md`)
  lines.push('')
  lines.push('> 这份文档约定「**保留什么拍法、换成什么内容**」。没有它，第二版会把整支片子重新吵一遍，')
  lines.push('> 协作者也分不清哪些是刻意的选择、哪些是意外。')
  lines.push('')

  /* 1 identity */
  lines.push(`## 1. ${MOTION_DOC_SECTIONS[0].zh}`)
  lines.push('')
  lines.push(tableRow(['项', '值']).replace('| 项 | 值 |', '| 项 | 值 |') )
  lines.push('|---|---|')
  const identityRows = [
    ['名称', identity.name],
    ['版本', identity.version],
    ['作者', identity.author],
    ['原始片源', identity.sourceUrl],
    ['片源版本', identity.sourceVersion],
    ['许可', identity.license],
    ['证据等级', `${levelZh}${doc.evidence?.level ? `（${doc.evidence.level}）` : ''}`],
  ]
  for (const [key, value] of identityRows) lines.push(tableRow([key, value]))
  lines.push('')

  /* 2 brand kit */
  lines.push(`## 2. ${MOTION_DOC_SECTIONS[1].zh}`)
  lines.push('')
  const brandKit = doc.brandKit ?? {}
  const brandParts = []
  if (brandKit.productZh) brandParts.push(`产品：${brandKit.productZh}`)
  if (brandKit.audienceZh) brandParts.push(`受众：${brandKit.audienceZh}`)
  if (Array.isArray(brandKit.palette) && brandKit.palette.length > 0) brandParts.push(`配色：${brandKit.palette.join(' ')}`)
  if (brandKit.fontZh) brandParts.push(`字体：${brandKit.fontZh}`)
  if (brandKit.toneZh) brandParts.push(`语气：${brandKit.toneZh}`)
  if (brandKit.logoPath) brandParts.push(`Logo：${brandKit.logoPath}`)
  lines.push(brandParts.length > 0 ? brandParts.join(' · ') : '（未填：换成自己的产品前先把产品事实、Logo、配色与语气补齐）')
  lines.push('')

  /* 3 narrative */
  lines.push(`## 3. ${MOTION_DOC_SECTIONS[2].zh}`)
  lines.push('')
  const narrative = doc.narrative ?? {}
  if (narrative.hookZh) lines.push(`- 钩子：${narrative.hookZh}`)
  if (narrative.revealZh) lines.push(`- 揭示顺序：${narrative.revealZh}`)
  if (narrative.evidenceZh) lines.push(`- 证据：${narrative.evidenceZh}`)
  if (narrative.endingZh) lines.push(`- 收尾：${narrative.endingZh}`)
  if (lines[lines.length - 1] === '') lines.push('（未填）')
  lines.push('')

  /* 4 visual */
  lines.push(`## 4. ${MOTION_DOC_SECTIONS[3].zh}`)
  lines.push('')
  const visual = doc.visual ?? {}
  if (visual.hierarchyZh) lines.push(`- 视觉焦点：${visual.hierarchyZh}`)
  if (visual.typeScaleZh) lines.push(`- 字级：${visual.typeScaleZh}`)
  if (visual.contrastZh) lines.push(`- 对比与留白：${visual.contrastZh}`)
  if (lines[lines.length - 1] === '') lines.push('（未填）')
  lines.push('')

  /* 5 timing */
  lines.push(`## 5. ${MOTION_DOC_SECTIONS[4].zh}`)
  lines.push('')
  const timing = doc.timing ?? {}
  if (timing.cutZh) lines.push(`- 镜头边界：${timing.cutZh}`)
  if (timing.holdZh) lines.push(`- 停留：${timing.holdZh}`)
  if (timing.easingZh) lines.push(`- 缓动：${timing.easingZh}`)
  if (timing.cameraZh) lines.push(`- 运镜：${timing.cameraZh}`)
  if (lines[lines.length - 1] === '') lines.push('（未填）')
  lines.push('')

  /* 6 assets */
  lines.push(`## 6. ${MOTION_DOC_SECTIONS[5].zh}`)
  lines.push('')
  const assets = doc.assets ?? {}
  if (Array.isArray(assets.mustProvide) && assets.mustProvide.length > 0) {
    lines.push(`- **必须用户提供**：${assets.mustProvide.join('、')}`)
  }
  if (Array.isArray(assets.canGenerate) && assets.canGenerate.length > 0) {
    lines.push(`- 可以由工具生成：${assets.canGenerate.join('、')}`)
  }
  if (Array.isArray(assets.syncPoints) && assets.syncPoints.length > 0) {
    lines.push(`- 声画同步点：${assets.syncPoints.map((point) => `${point.atSeconds ?? point.at}s ${point.zh ?? ''}`.trim()).join('、')}`)
  }
  if (lines[lines.length - 1] === '') lines.push('（未填）')
  lines.push('')

  /* 7 keep / replace */
  lines.push(`## 7–8. 保持项与可替换项`)
  lines.push('')
  lines.push('| 时段 | 保留的拍法 | 本片用的内容 | 容量 | 依据 |')
  lines.push('|---|---|---|---|---|')
  for (const row of doc.keepReplace ?? []) {
    const range = Number.isFinite(row.fromSeconds) && Number.isFinite(row.toSeconds)
      ? `${row.fromSeconds}–${row.toSeconds}s`
      : '—'
    const capacity = row.capacity === null || row.capacity === undefined
      ? '—'
      : `${row.actual ?? 0}/${row.capacity}${row.overflow ? `（${row.overflow}）` : ''}`
    const basisZh = BASIS.find((entry) => entry.id === row.basis)?.zh ?? row.basis ?? '—'
    lines.push(tableRow([range, row.keepZh, row.useZh, capacity, basisZh]))
  }
  lines.push('')
  lines.push('**溢出规则**：内容超出容量时只能**拆分/重排受影响镜头**（并把多出来的时长算进时间线），')
  lines.push('或截断改写并记回文档；**缩小字号硬塞是禁止的**——读不清等于没写。')
  lines.push('')

  /* clip map */
  if (Array.isArray(doc.clipMap) && doc.clipMap.length > 0) {
    lines.push('### 源时间 → 输出时间')
    lines.push('')
    lines.push('源素材时间和输出时间不是一回事：把源片 12–18 秒保留到输出 0–6 秒，源片第 15 秒的事件就落在输出第 3 秒。')
    lines.push('字幕和叠层必须按这张表**重建**，不能整体平移。')
    lines.push('')
    lines.push('| 片段 | 源入点 | 源出点 | 输出入点 | 输出出点 | 时长 |')
    lines.push('|---|---|---|---|---|---|')
    for (const row of doc.clipMap) {
      lines.push(tableRow([row.index + 1, `${row.sourceIn}s`, `${row.sourceOut}s`, `${row.outputIn}s`, `${row.outputOut}s`, `${row.durationSeconds}s`]))
    }
    lines.push('')
  }

  /* 8 claims */
  if (Array.isArray(doc.claims) && doc.claims.length > 0) {
    lines.push(`## 8. 观察 / 推断 / 主动改动`)
    lines.push('')
    lines.push('把这三类分开写，是避免"报告听起来很确定、但其实没人量过"的唯一办法。')
    lines.push('')
    for (const claim of doc.claims) {
      const basisZh = BASIS.find((entry) => entry.id === claim.basis)?.zh ?? claim.basis
      lines.push(`- **${basisZh}**：${claim.textZh}`)
    }
    lines.push('')
  }

  /* 9 checks */
  lines.push(`## 9. ${MOTION_DOC_SECTIONS[8].zh}`)
  lines.push('')
  if (Array.isArray(doc.checkpoints) && doc.checkpoints.length > 0) {
    lines.push('对照检查点（参考片和仿制版在**同一时刻**比较，而不是各取一帧比平均）：')
    lines.push('')
    lines.push('| # | 时刻 | 看什么 |')
    lines.push('|---|---|---|')
    for (const point of doc.checkpoints) {
      lines.push(tableRow([point.index + 1, `${point.referenceAt}s`, point.whatZh]))
    }
    lines.push('')
    lines.push(`判定：像素比对落在 ${CHECKPOINT_PASS_VERDICTS.join(' / ')} 档才算过；diverge 必须说明是"还没做完"还是"有意改的"。`)
  } else {
    lines.push('（没有对照检查点）')
  }
  if (typeof doc.evidence?.notesZh === 'string' && doc.evidence.notesZh.trim().length > 0) {
    lines.push('')
    lines.push(`**已知差距**：${doc.evidence.notesZh}`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`证据等级：**${levelZh}**。等级只能由证据推出来——`)
  for (const level of EVIDENCE_LEVELS) {
    lines.push(`- ${level.zh}：需要${level.requiresZh}`)
  }
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()}\n`
}

export default {
  MOTION_DOC_SECTIONS,
  EVIDENCE_LEVELS,
  BASIS,
  OVERFLOW_POLICIES,
  CHECKPOINT_PASS_VERDICTS,
  buildKeepReplaceTable,
  buildClipMap,
  planCheckpoints,
  buildMotionDoc,
  inferEvidenceLevel,
  validateMotionDoc,
  renderMotionDocMarkdown,
}
