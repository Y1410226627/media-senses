/**
 * lib/aesthetic.js — machine-auditable aesthetic rules.
 *
 * Turns the 27 case-based aesthetic rules from `test/_research/aesthetic-rules.txt`
 * (R = 节奏, Q = 质感·运镜·构图, S = 声音, C = 文案, P = 流程) into data plus a
 * deterministic auditor. 11 rules can be checked from structured production data
 * (shot list, rendered-frame measurements, SFX anchor table, timeline cuts); the
 * other 16 need human/vision judgement, so they are declared `checkable: false`
 * with an explicit `whyZh` instead of silently passing. A skipped rule never
 * counts as a pass — `passRatio` only covers rules that produced a verdict.
 *
 * Why this module exists: the reproduction loop's final acceptance step used to be
 * a subjective "looks good"; the upstream project's rework history shows every
 * expensive failure was caught by a *rule with evidence*. This module makes those
 * rules addressable by id, so a report can say `R4 ✗(frames 302, 480)` and the
 * model gets a concrete fix instead of a vague score.
 *
 * Attribution: the 27 rule definitions come from the case-based aesthetic
 * guidelines of the video-shotcraft project (Vincentwei1021/video-shotcraft,
 * Apache-2.0, pinned commit 1266a3e, introduced via dsh-drawai). The checker
 * implementations, thresholds plumbing and Chinese copy in this file are written
 * for this repository; the case references are kept because they are the reason
 * each rule exists. See THIRD-PARTY.md.
 *
 * Design notes:
 * - Every checker accepts a partially-populated `input` and returns
 *   `{verdict:'pass'|'fail'|'warn'|'skip', evidenceZh, frames?}`. Missing data is
 *   always `skip` with a Chinese explanation of what is missing — never a fail.
 * - `input` shape (fields may be absent; the upper layer supplies what it has):
 *   { shots:[{id,durationSeconds,startSeconds?,isBrandMark?,hasHoldSeconds?,glintCount?,
 *             startFrame?,endFrame?}],
 *     frames:[{index,timeSeconds,texts:[{text,effectivePx,frameHeight,role?,mustRead?}],
 *              motionLevel}],
 *     audio:{sfxAnchors:[{designedFrame,measuredPeakFrame,outputOffsetFrames}], bpm?, beatSeconds?},
 *     timeline:{cuts:[{fromFrame,toFrame,techniqueId,materialId?,isProtagonist?}], totalSeconds?,
 *               captions?:[{start,end}]},
 *     captions?:[{start,end,text?}],
 *     effects:{fullFrameImpactCount?,fullFrameImpactFrames?:number[],fullFrameImpacts?:[{frame?|timeSeconds?}],
 *              glintSweepCount?,beatPumpRuns?} }
 * - `options` may override readability thresholds:
 *   { captionPx = 56, auxiliaryPx = 32, referenceHeight = 1080, defaultBpm = 120 }
 * - Pure functions, no I/O, zero dependencies, deterministic. Output is strictly
 *   JSON-serialisable.
 *
 * @module lib/aesthetic
 */

/** Rule families in display order. */
export const AESTHETIC_FAMILIES = Object.freeze([
  { id: 'R', nameZh: '节奏' },
  { id: 'Q', nameZh: '质感、运镜与构图' },
  { id: 'S', nameZh: '声音' },
  { id: 'C', nameZh: '文案' },
  { id: 'P', nameZh: '流程' },
])

/** Round to `digits`, non-finite → null. */
function round(value, digits) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function num(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stddev(values) {
  const average = mean(values)
  if (average === null) return null
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length)
}

function evidenceFor(ruleZh, detail) {
  return detail.length > 0 ? detail : ruleZh
}

const PASS = (evidenceZh = '', frames = []) => ({ verdict: 'pass', evidenceZh: evidenceZh || '', frames })
const FAIL = (evidenceZh, frames = []) => ({ verdict: 'fail', evidenceZh, frames })
const WARN = (evidenceZh, frames = []) => ({ verdict: 'warn', evidenceZh, frames })
const SKIP = (evidenceZh) => ({ verdict: 'skip', evidenceZh })

/* ------------------------------------------------------------------ *
 * Shared input helpers
 * ------------------------------------------------------------------ */

function list(value) {
  return Array.isArray(value) ? value : []
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Frames that carry a numeric motionLevel. */
function motionFrames(input) {
  return list(input.frames)
    .filter((frame) => frame !== null && typeof frame === 'object')
    .map((frame) => ({
      index: Number.isInteger(frame.index) ? frame.index : null,
      timeSeconds: num(frame.timeSeconds),
      motionLevel: num(frame.motionLevel),
    }))
    .filter((frame) => frame.motionLevel !== null && frame.motionLevel >= 0)
}

/** Frames that carry any usable index (evidence coverage). */
function indexedFrames(input) {
  return list(input.frames).filter((frame) => frame !== null && typeof frame === 'object')
}

/**
 * Compute the frame range that belongs to a shot.
 * Uses explicit startFrame/endFrame when present, else startSeconds/endSeconds,
 * else cumulative durations of the (contiguous) shot list.
 */
function shotFrameRange(input, shotIndex) {
  const shots = list(input.shots)
  const shot = object(shots[shotIndex])
  const frames = indexedFrames(input)
  const indexes = frames.map((frame) => frame.index).filter((value) => Number.isInteger(value))
  if (indexes.length === 0) return []
  const minIndex = Math.min(...indexes)
  const maxIndex = Math.max(...indexes)
  if (Number.isInteger(shot.startFrame) || Number.isInteger(shot.endFrame)) {
    const start = Number.isInteger(shot.startFrame) ? shot.startFrame : minIndex
    const end = Number.isInteger(shot.endFrame) ? shot.endFrame : start
    return indexes.filter((value) => value >= start && value <= end)
  }
  // Convert the shot to a [startSeconds, endSeconds) window.
  let startSeconds = num(shot.startSeconds)
  let endSeconds = num(shot.endSeconds)
  if (startSeconds === null || endSeconds === null) {
    let cursor = 0
    for (let index = 0; index < shotIndex; index += 1) cursor += num(object(shots[index]).durationSeconds) ?? 0
    startSeconds = cursor
    endSeconds = cursor + (num(shot.durationSeconds) ?? 0)
  }
  if (!(endSeconds > startSeconds)) return []
  const times = frames
    .map((frame) => ({ index: frame.index, timeSeconds: num(frame.timeSeconds) }))
    .filter((entry) => Number.isInteger(entry.index) && entry.timeSeconds !== null)
  if (times.length > 0) {
    return times
      .filter((entry) => entry.timeSeconds >= startSeconds && entry.timeSeconds < endSeconds)
      .map((entry) => entry.index)
  }
  // Last resort: split the frame index range proportionally by cumulative duration.
  const total = list(input.shots).reduce((sum, item) => sum + (num(object(item).durationSeconds) ?? 0), 0)
  if (!(total > 0)) return []
  let before = 0
  for (let index = 0; index < shotIndex; index += 1) before += num(object(shots[index]).durationSeconds) ?? 0
  const span = maxIndex - minIndex
  const start = minIndex + Math.floor((before / total) * span)
  const end = minIndex + Math.floor(((before + (num(shot.durationSeconds) ?? 0)) / total) * span)
  return indexes.filter((value) => value >= start && value <= end)
}

/* ------------------------------------------------------------------ *
 * Machine-checkable rules (11)
 * ------------------------------------------------------------------ */

/** R1 — brand wordmark holds for ≥1.0 s; ordinary content cards need no hold. */
function auditR1(input) {
  const shots = list(input.shots)
  if (shots.length === 0) return SKIP('缺少 shots 数据，无法检查品牌字标 hold')
  const brandShots = shots.map((shot, index) => ({ shot: object(shot), index })).filter((entry) => entry.shot.isBrandMark === true)
  if (brandShots.length === 0) return SKIP('shots 中没有标记 isBrandMark 的品牌镜头，规则不适用')
  const bad = []
  const frames = []
  for (const entry of brandShots) {
    const hold = num(entry.shot.hasHoldSeconds)
    if (hold === null || hold < 1) {
      bad.push(`${entry.shot.id ?? `shot#${entry.index}`} hold=${hold === null ? '未知' : `${round(hold, 2)}s`}`)
      frames.push(...shotFrameRange(input, entry.index))
    }
  }
  if (bad.length > 0) {
    return FAIL(`品牌字标 hold 不足 1.0s：${bad.join('、')}；普通内容卡不受此约束`, frames)
  }
  const summary = brandShots
    .map((entry) => `${entry.shot.id ?? `shot#${entry.index}`} hold ${round(num(entry.shot.hasHoldSeconds), 2)}s`)
    .join('、')
  return PASS(`品牌字标 hold 达标：${summary}`, brandShots.flatMap((entry) => shotFrameRange(input, entry.index)))
}

/** R2 — speed must come from acceleration; a long uniform motion reads as cheap PPT. */
function auditR2(input) {
  const frames = motionFrames(input)
  if (frames.length < 8) return SKIP('运动帧数不足 8，无法判断匀速/加速度')
  const values = frames.map((frame) => frame.motionLevel)
  const average = mean(values)
  if (average === null || average <= 0.5) {
    return PASS('全段运动量均值 ≤0.5，基本静止；不存在匀速直线运动')
  }
  const deviation = stddev(values)
  const cv = deviation / average
  const tailWindow = 0.5
  const lastTime = frames[frames.length - 1].timeSeconds
  let tailNote = ''
  let tailFrames = []
  if (lastTime !== null) {
    tailFrames = frames.filter((frame) => frame.timeSeconds !== null && frame.timeSeconds >= lastTime - tailWindow)
    const tailMean = mean(tailFrames.map((frame) => frame.motionLevel))
    if (tailMean !== null && tailMean > average * 0.25) {
      tailNote = `；尾段 ${tailWindow}s 运动量仍有均值的 ${Math.round((tailMean / average) * 100)}%，缺少静止呼吸`
    }
  }
  const framesEvidence = frames.slice(0, 60).map((frame) => frame.index).filter((value) => Number.isInteger(value))
  if (cv < 0.12) {
    return FAIL(
      `运动量方差塌陷（CV=${round(cv, 3)}，均值 ${round(average, 2)}）：连续段读作匀速直线运动，需改为非线性缓动 + 非均匀错峰${tailNote}`,
      framesEvidence,
    )
  }
  if (cv < 0.2) {
    return WARN(`运动量变化偏平（CV=${round(cv, 3)}）：接近匀速，建议加一段加速/急停制造速度感${tailNote}`, framesEvidence)
  }
  if (tailNote.length > 0) {
    return WARN(`运动有明显加速度（CV=${round(cv, 3)}）${tailNote}`, framesEvidence)
  }
  return PASS(`运动有加速度变化（CV=${round(cv, 3)}），末段有静止呼吸`, framesEvidence)
}

/** R3 — the opening action arc should last ≥3 s (interaction demos use human speed). */
function auditR3(input) {
  const frames = motionFrames(input).filter((frame) => frame.timeSeconds !== null)
  const shots = list(input.shots)
  let span = null
  let source = ''
  if (frames.length >= 2) {
    const active = frames.filter((frame) => frame.motionLevel > 0.2)
    if (active.length >= 2) {
      span = active[active.length - 1].timeSeconds - active[0].timeSeconds
      source = `运动帧 ${active[0].index ?? '?'}–${active[active.length - 1].index ?? '?'}`
    }
  }
  if (span === null && shots.length > 0) {
    const opening = object(shots[0])
    const duration = num(opening.durationSeconds)
    if (duration !== null) {
      span = duration
      source = `首镜头 ${opening.id ?? 'shot#0'} 时长`
    }
  }
  if (span === null) return SKIP('缺少运动帧与开场镜头时长，无法测量开场主体动作弧')
  const evidence = `开场动作弧约 ${round(span, 2)}s（${source}）`
  const framesEvidence = frames.slice(0, 60).map((frame) => frame.index).filter((value) => Number.isInteger(value))
  if (span >= 3) return PASS(`${evidence} ≥3s；交互段落请按真人操作速度排时间线`, framesEvidence)
  return FAIL(`${evidence} <3s：初版几乎总是偏快，先放慢一档到 ≥3s`, framesEvidence)
}

/** R4 — whole-frame impacts ≤3 per film, ≥16 beats apart; beat pumps ≤1 run. */
function collectImpactEntries(input) {
  const effects = object(input.effects)
  const entries = []
  for (const frame of list(effects.fullFrameImpactFrames)) {
    const value = num(frame)
    if (value !== null) entries.push({ frame: value })
  }
  for (const entry of list(effects.fullFrameImpacts)) {
    const item = object(entry)
    entries.push({ frame: num(item.frame), timeSeconds: num(item.timeSeconds) })
  }
  return entries
}

function auditR4(input, options) {
  const effects = object(input.effects)
  const declaredCount = num(effects.fullFrameImpactCount)
  const impacts = collectImpactEntries(input).filter((entry) => entry.frame !== null || entry.timeSeconds !== null)
  if (declaredCount === null && impacts.length === 0) {
    return SKIP('缺少全画面冲击次数/帧数据（effects.fullFrameImpactCount 或 fullFrameImpactFrames）')
  }
  const total = declaredCount ?? impacts.length
  const frames = impacts.map((entry) => entry.frame).filter((value) => Number.isInteger(value))
  if (total > 3) {
    return FAIL(`全画面/相机级冲击 ${total} 处 > 3 处：只保留钉最强 hit 的三处，其余拍点改到主角元素层`, frames)
  }
  const pumpRuns = num(effects.beatPumpRuns)
  if (pumpRuns !== null && pumpRuns > 1) {
    return FAIL(`节拍泵连打 ${pumpRuns} 次 > 1 次：踢鼓命中表是候选池不是触发器`, frames)
  }
  const audio = object(input.audio)
  const beatSeconds = num(audio.beatSeconds) ?? (num(audio.bpm) !== null && num(audio.bpm) > 0 ? 60 / num(audio.bpm) : null)
  const assumed = beatSeconds === null
  const effectiveBeat = beatSeconds ?? 60 / (num(options.defaultBpm) ?? 120)
  const times = impacts
    .map((entry) => entry.timeSeconds)
    .filter((value) => value !== null)
    .sort((a, b) => a - b)
  if (times.length >= 2) {
    let minGap = Number.POSITIVE_INFINITY
    for (let index = 1; index < times.length; index += 1) minGap = Math.min(minGap, times[index] - times[index - 1])
    const requiredGap = 16 * effectiveBeat
    if (minGap < requiredGap - 1e-9) {
      const message = `相邻全画面冲击最小间隔 ${round(minGap, 2)}s < 16 拍 ${round(requiredGap, 2)}s${assumed ? '（缺 BPM，按 120 BPM 假设）' : ''}`
      if (assumed) return WARN(`${message}；请提供 BPM 复核`, frames)
      return FAIL(message, frames)
    }
  } else if (total > 1 && impacts.length >= 1) {
    return WARN(`共 ${total} 处全画面冲击，但缺相邻冲击的秒/帧时间，间隔是否 ≥16 拍无法验证`, frames)
  }
  return PASS(`全画面级冲击 ${total} 处 ≤3，未触发节拍泵连打`, frames)
}

/** Q4 — at most one glint/sweep per shot, aimed at the protagonist. */
function auditQ4(input) {
  const shots = list(input.shots)
  if (shots.length === 0) return SKIP('缺少 shots 数据，无法逐镜头统计 glint/sweep')
  const withCounts = shots
    .map((shot, index) => ({ shot: object(shot), index }))
    .filter((entry) => num(entry.shot.glintCount) !== null)
  if (withCounts.length === 0) {
    return SKIP('shots 未提供 glintCount，无法逐镜头验证光效次数；圆角裁剪需人工看帧')
  }
  const bad = []
  const frames = []
  for (const entry of withCounts) {
    const count = num(entry.shot.glintCount)
    if (count > 1) {
      bad.push(`${entry.shot.id ?? `shot#${entry.index}`} 出现 ${count} 次`)
      frames.push(...shotFrameRange(input, entry.index))
    }
  }
  if (bad.length > 0) {
    return FAIL(`glint/sweep 单镜头超过 1 次：${bad.join('、')}；光效应只给主角并裁进圆角`, frames)
  }
  const max = Math.max(...withCounts.map((entry) => num(entry.shot.glintCount)))
  return PASS(`光效单镜头最多 ${max} 次；注意抽查渲染帧确认光溢出圆角`, withCounts.flatMap((entry) => shotFrameRange(input, entry.index)))
}

function collectReadableTexts(input) {
  const entries = []
  for (const frame of list(input.frames)) {
    const item = object(frame)
    for (const text of list(item.texts)) {
      const entry = object(text)
      const effectivePx = num(entry.effectivePx)
      if (effectivePx === null) continue
      entries.push({
        text: typeof entry.text === 'string' ? entry.text : '',
        effectivePx,
        frameHeight: num(entry.frameHeight),
        role: typeof entry.role === 'string' ? entry.role.toLowerCase() : 'caption',
        mustRead: entry.mustRead !== false,
        frameIndex: Number.isInteger(item.index) ? item.index : null,
      })
    }
  }
  return entries
}

/** Q11 — readable text keeps a minimum effective pixel height (1080p: caption 56px, aux 32px). */
function auditQ11(input, options) {
  const texts = collectReadableTexts(input)
  if (texts.length === 0) return SKIP('frames[].texts 为空，无法量有效字高')
  const captionPx = num(options.captionPx) ?? 56
  const auxiliaryPx = num(options.auxiliaryPx) ?? 32
  const referenceHeight = num(options.referenceHeight) ?? 1080
  const failures = []
  const frames = []
  const minimums = []
  for (const entry of texts) {
    if (entry.mustRead === false) continue
    const scale = entry.frameHeight !== null && entry.frameHeight > 0 ? entry.frameHeight / referenceHeight : 1
    const isAuxiliary = entry.role === 'aux' || entry.role === 'auxiliary' || entry.role === 'secondary' || entry.role === 'subtitle'
    const threshold = (isAuxiliary ? auxiliaryPx : captionPx) * scale
    minimums.push(`${entry.role}/${entry.effectivePx}px`)
    if (entry.effectivePx < threshold - 1e-9) {
      const label = entry.text.length > 0 ? `「${entry.text.slice(0, 16)}」` : `frame#${entry.frameIndex ?? '?'}`
      failures.push(`${label} ${entry.role} 有效字高 ${round(entry.effectivePx, 1)}px < ${round(threshold, 1)}px`)
      if (Number.isInteger(entry.frameIndex)) frames.push(entry.frameIndex)
    }
  }
  if (failures.length > 0) {
    return FAIL(`要读的文字低于最低有效字高：${failures.join('；')}`, [...new Set(frames)])
  }
  return PASS(`要读文字全部达标（${minimums.slice(0, 6).join('、')}${minimums.length > 6 ? '…' : ''}）`, [...new Set(frames)])
}

function collectCaptionWindows(input) {
  const candidates = [
    ...list(input.captions),
    ...list(object(input.timeline).captions),
    ...list(object(input.audio).captions),
  ]
  const windows = []
  for (const item of candidates) {
    const entry = object(item)
    const start = num(entry.start) ?? num(entry.startSeconds)
    const end = num(entry.end) ?? num(entry.endSeconds)
    if (start === null || end === null || end <= start) continue
    windows.push({ start, end })
  }
  return windows.sort((a, b) => a.start - b.start)
}

/** C1 — no animation-only stretch longer than 3 s without narration (brand outros exempt). */
function auditC1(input) {
  const windows = collectCaptionWindows(input)
  if (windows.length === 0) return SKIP('未提供 captions/解说窗口，无法判断 >3s 的无解说动画段')
  const shots = list(input.shots)
  const timeline = object(input.timeline)
  let total = num(timeline.totalSeconds)
  if (total === null) {
    total = list(input.frames).reduce((max, frame) => Math.max(max, num(object(frame).timeSeconds) ?? 0), 0)
  }
  if (total === null || total <= 0) {
    const durations = shots.reduce((sum, shot) => sum + (num(object(shot).durationSeconds) ?? 0), 0)
    total = durations > 0 ? durations : null
  }
  if (total === null) return SKIP('缺少总时长/帧时间，无法计算无解说间隙')
  const brandWindows = []
  let cursor = 0
  for (const shot of shots) {
    const item = object(shot)
    const duration = num(item.durationSeconds) ?? 0
    if (item.isBrandMark === true) brandWindows.push({ start: cursor, end: cursor + duration })
    cursor += duration
  }
  const gaps = []
  let position = 0
  for (const window of windows) {
    if (window.start > position) gaps.push({ start: position, end: Math.min(window.start, total) })
    position = Math.max(position, window.end)
  }
  if (position < total) gaps.push({ start: position, end: total })
  const longGaps = gaps.filter((gap) => gap.end - gap.start > 3)
  const exempt = longGaps.filter((gap) => brandWindows.some((brand) => gap.start >= brand.start - 1e-9 && gap.end <= brand.end + 1e-9))
  const bad = longGaps.filter((gap) => !exempt.includes(gap))
  const frameEvidence = bad
    .map((gap) => {
      const first = list(input.frames).find((frame) => (num(object(frame).timeSeconds) ?? -1) >= gap.start)
      return first !== undefined ? object(first).index : null
    })
    .filter((value) => Number.isInteger(value))
  if (bad.length > 0) {
    const detail = bad
      .map((gap) => `${round(gap.start, 2)}–${round(gap.end, 2)}s（${round(gap.end - gap.start, 2)}s）`)
      .join('、')
    return FAIL(`存在 >3s 的无解说动画段：${detail}；动画段也要配短解说 caption（品牌收尾除外）`, frameEvidence)
  }
  return PASS(
    `无解说间隙全部 ≤3s（共 ${windows.length} 段解说）${exempt.length > 0 ? `；${exempt.length} 处品牌收尾段已豁免` : ''}`,
    frameEvidence,
  )
}

/** P4 — one technique may be the protagonist only once; duplicate shot/material gets reported. */
function auditP4(input) {
  const cuts = list(object(input.timeline).cuts)
  const repeatPairs = list(object(input.timeline).repeatPairs)
  if (repeatPairs.length > 0) {
    const frames = repeatPairs
      .map((pair) => num(object(pair).fromFrame))
      .filter((value) => Number.isInteger(value))
    return FAIL(`timeline.repeatPairs 显式报告了 ${repeatPairs.length} 组重复：${repeatPairs
      .slice(0, 4)
      .map((pair) => `${object(pair).techniqueId ?? '?'}`)
      .join('、')}；重复镜头/信息一律删`, frames)
  }
  if (cuts.length === 0) return SKIP('缺少 timeline.cuts，无法检查手法/素材重复')
  const normalized = cuts.map((cut, index) => ({ cut: object(cut), index }))
  const protagonists = normalized.filter((entry) => entry.cut.isProtagonist === true)
  if (protagonists.length > 0) {
    const groups = new Map()
    for (const entry of protagonists) {
      const technique = String(entry.cut.techniqueId ?? `cut#${entry.index}`)
      groups.set(technique, [...(groups.get(technique) ?? []), entry])
    }
    const duplicateGroups = [...groups.entries()].filter(([, entries]) => entries.length > 1)
    if (duplicateGroups.length > 0) {
      const frames = duplicateGroups.flatMap(([, entries]) =>
        entries.map((entry) => num(entry.cut.fromFrame)).filter((value) => Number.isInteger(value)),
      )
      const detail = duplicateGroups.map(([technique, entries]) => `${technique} ×${entries.length}`).join('、')
      return FAIL(`同一手法重复当主角：${detail}；一种手法全片只当一次主角`, frames)
    }
    return PASS(`主角手法互不重复：${[...groups.keys()].join('、')}`)
  }
  // No explicit protagonist marks: report same-technique + same-material pairs as dupes.
  const pairs = new Map()
  for (const entry of normalized) {
    const technique = String(entry.cut.techniqueId ?? '')
    if (technique.length === 0) continue
    const material = String(entry.cut.materialId ?? '')
    const key = `${technique}|${material}`
    pairs.set(key, [...(pairs.get(key) ?? []), entry])
  }
  const duplicatePairs = [...pairs.entries()].filter(([key, entries]) => key.endsWith('|') === false && entries.length > 1)
  if (duplicatePairs.length > 0) {
    const frames = duplicatePairs.flatMap(([, entries]) =>
      entries.map((entry) => num(entry.cut.fromFrame)).filter((value) => Number.isInteger(value)),
    )
    const detail = duplicatePairs.map(([key, entries]) => `${key.replace('|', ' + ')} ×${entries.length}`).join('、')
    return FAIL(`同手法 + 同素材重复：${detail}；同一素材/信息全片只出现一次`, frames)
  }
  const techniqueGroups = new Map()
  for (const entry of normalized) {
    const technique = String(entry.cut.techniqueId ?? '')
    if (technique.length === 0) continue
    techniqueGroups.set(technique, (techniqueGroups.get(technique) ?? 0) + 1)
  }
  const repeated = [...techniqueGroups.entries()].filter(([, count]) => count > 1)
  if (repeated.length > 0) {
    return WARN(
      `同一手法出现多次，但缺少 isProtagonist/materialId 无法判定是否重复当主角：${repeated
        .map(([technique, count]) => `${technique} ×${count}`)
        .join('、')}`,
    )
  }
  return PASS(`手法均只出现一次（${[...techniqueGroups.keys()].slice(0, 6).join('、')}）`)
}

function sfxRows(input) {
  const anchors = list(object(input.audio).sfxAnchors)
  return anchors
    .map((anchor, index) => {
      const entry = object(anchor)
      const designed = num(entry.designedFrame)
      const measured = num(entry.measuredPeakFrame)
      const offset = num(entry.outputOffsetFrames)
      const error = designed !== null && measured !== null && offset !== null ? designed - measured - offset : null
      return { index, designed, measured, offset, error }
    })
}

const SFX_TOLERANCE_FRAMES = 0.5

/** S2 — every SFX is pinned to a frame and its correction lands within 0.5 f. */
function auditS2(input) {
  const rows = sfxRows(input)
  if (rows.length === 0) return SKIP('audio.sfxAnchors 为空，无法验证 SFX 钉点')
  // `measuredPeakFrame` only exists after the film is rendered and its audio is
  // measured. Auditing the plan is therefore a legitimate pre-render state, not a
  // failure: report what cannot be verified instead of blocking a correct plan.
  if (rows.every((row) => row.measured === null)) {
    return SKIP('SFX 都有 designedFrame，但还没有 measuredPeakFrame（需渲后测峰值），本次不判定')
  }
  const unmanaged = rows.filter((row) => row.designed === null || row.measured === null)
  if (unmanaged.length > 0) {
    return FAIL(`SFX 缺少钉帧管理字段：${unmanaged.map((row) => `anchor#${row.index}`).join('、')}；每条 SFX 需要 designedFrame 与 measuredPeakFrame`)
  }
  const bad = rows.filter((row) => row.error === null || Math.abs(row.error) > SFX_TOLERANCE_FRAMES + 1e-9)
  const frames = bad.map((row) => row.designed).filter((value) => Number.isInteger(value))
  if (bad.length > 0) {
    const detail = bad
      .slice(0, 6)
      .map((row) => `anchor#${row.index} 误差 ${row.error === null ? '未知' : `${round(row.error, 2)}f`}`)
      .join('、')
    return FAIL(`SFX 钉点误差 >0.5f：${detail}；连发段落用双样本交替 + 音量阶梯递减 + 间隔加速`, frames)
  }
  const worst = Math.max(...rows.map((row) => Math.abs(row.error)))
  return PASS(`${rows.length} 条 SFX 钉点误差全部 ≤0.5f（最大 ${round(worst, 2)}f）`, frames)
}

/** S5 — output-track offset and per-file peak lag are both compensated. */
function auditS5(input) {
  const rows = sfxRows(input)
  if (rows.length === 0) return SKIP('audio.sfxAnchors 为空，无法验证音画偏移补偿')
  // The offset is measured per render pipeline by cross-correlation after a render;
  // before that there is nothing to verify, so the rule reports itself as skipped.
  if (rows.every((row) => row.offset === null)) {
    return SKIP('还没有实测输出音轨偏移（需渲后交叉相关测量），本次不判定')
  }
  const missingOffset = rows.filter((row) => row.offset === null)
  if (missingOffset.length > 0) {
    return FAIL(`缺少输出音轨偏移：${missingOffset.map((row) => `anchor#${row.index}`).join('、')}；需按渲染管线实测并统一扣除`)
  }
  const bad = rows.filter((row) => row.error === null || Math.abs(row.error) > SFX_TOLERANCE_FRAMES + 1e-9)
  const frames = bad.map((row) => row.designed).filter((value) => Number.isInteger(value))
  if (bad.length > 0) {
    const detail = bad
      .slice(0, 6)
      .map((row) => `anchor#${row.index} 误差 ${row.error === null ? '未知' : `${round(row.error, 2)}f`}`)
      .join('、')
    return FAIL(`两项偏移补偿后仍有 >0.5f 误差：${detail}；公式 from = 目标峰值帧 − 峰值滞后 − 输出偏移`, frames)
  }
  const offsets = [...new Set(rows.map((row) => round(row.offset, 2)))]
  if (offsets.length > 1) {
    return WARN(`输出偏移在 ${offsets.length} 个值间波动（${offsets.join('/')}），请确认是同一渲染管线的实测常数`)
  }
  return PASS(`${rows.length} 条音效的两项偏移已补偿（输出偏移 ${offsets[0]}f），残差 ≤0.5f`, frames)
}

/** P1 — frame evidence exists and covers every shot. */
function auditP1(input) {
  const frames = indexedFrames(input)
  // Auditing a plan has no rendered frames by definition; that is a "not yet",
  // not a delivery violation. Only a *rendered-film* review can fail this rule.
  if (frames.length === 0) {
    const shots = list(input.shots)
    if (shots.length > 0) return SKIP('还没有渲染帧证据（计划阶段审计）；渲后用 media_review 复核这一条')
    return FAIL('没有任何渲染帧证据：交付前必须自己渲染截帧逐一检查，再交用户')
  }
  const shots = list(input.shots)
  if (shots.length === 0) {
    return WARN(`有 ${frames.length} 帧证据，但缺少 shots 无法验证「每个镜头都有帧证据」`)
  }
  const uncovered = []
  const evidence = []
  for (let index = 0; index < shots.length; index += 1) {
    const range = shotFrameRange(input, index)
    if (range.length === 0) uncovered.push(object(shots[index]).id ?? `shot#${index}`)
    evidence.push(...range.slice(0, 2))
  }
  if (uncovered.length > 0) {
    return FAIL(`以下镜头没有帧证据：${uncovered.join('、')}；每个 shot 至少留一张关键帧截图`, [...new Set(evidence)])
  }
  return PASS(`${frames.length} 帧证据覆盖全部 ${shots.length} 个镜头`, [...new Set(evidence)].slice(0, 40))
}

/* ------------------------------------------------------------------ *
 * The 27 rules
 * ------------------------------------------------------------------ */

const CHECKERS = {
  R1: auditR1,
  R2: auditR2,
  R3: auditR3,
  R4: auditR4,
  Q4: auditQ4,
  Q11: auditQ11,
  S2: auditS2,
  S5: auditS5,
  C1: auditC1,
  P1: auditP1,
  P4: auditP4,
}

/**
 * The rule catalogue: `{ id, family, zh, checkable, whyZh, caseZh, selfCheckZh }`.
 * `whyZh` explains what the automated check looks at, or — for `checkable:false` —
 * exactly why the rule needs human/vision judgement. `caseZh` is the upstream
 * rework case that created the rule.
 */
export const AESTHETIC_RULES = Object.freeze([
  {
    id: 'R1',
    family: 'R',
    zh: '关键信息落定后必须呼吸，品牌字标 hold 满 1 秒',
    checkable: true,
    whyZh: '可检查：shots[].isBrandMark + hasHoldSeconds ≥ 1.0 秒；普通内容卡不受约束。',
    caseZh: '开头/结尾 wordmark 各 hold 满 1 秒；先停错对象、revert 后重做定案。',
    selfCheckZh: '每个「想让观众记住的画面」是否有完整静止时刻？停顿给的是品牌还是随手给了普通元素？',
  },
  {
    id: 'R2',
    family: 'R',
    zh: '速度感来自加速度而非匀速快；群体运动挂物理隐喻，收尾留 0.5 秒停顿',
    checkable: true,
    whyZh: '可检查：用 frames[].motionLevel 的变异系数判断匀速塌陷，并看末 0.5 秒是否仍有运动。',
    caseZh: '卡片堆叠「越来越快」+ 末尾停 0.5 秒；抽象 flood 五轮不收敛，换发牌隐喻一轮通过。',
    selfCheckZh: '有没有任何元素在做匀速直线运动？批量入场是否越来越快、末尾有无静止呼吸？',
  },
  {
    id: 'R3',
    family: 'R',
    zh: '节奏宁慢勿快：开场主体动作弧 ≥3 秒，交互演示按真人速度',
    checkable: true,
    whyZh: '可检查：用 frames[].motionLevel > 0 的起止跨度（或首镜头时长）量开场动作弧是否 ≥3 秒；交互速度仍需分镜表佐证。',
    caseZh: '六次独立反馈全部指向「放慢/停留」，开场放慢到 3 秒、交互改成不慌不忙。',
    selfCheckZh: '把每个镜头当第一次看：哪里没看清？交互段落自己能不能跟着操作一遍？',
  },
  {
    id: 'R4',
    family: 'R',
    zh: '卡点约束时机不放大幅度：全画面级冲击全片 ≤3 处、间隔 ≥16 拍',
    checkable: true,
    whyZh: '可检查：effects 里的全画面冲击计数与帧时间 + BPM 换算 16 拍间隔；节拍泵连打次数同样可数。',
    caseZh: '逐拍全画面泵让画面随音乐抖动；改为冲击只作用于整画面层 ≤3 处、其余拍点只动主角元素层。',
    selfCheckZh: '任取连续 8 拍回放：整画面是否逐拍脉冲？全片整画面冲击数得清吗？每处对得上最强 hit 清单吗？',
  },
  {
    id: 'Q1',
    family: 'Q',
    zh: '复刻既有页面必须真实截图；手搓 UI 仅限非复刻场景且质量、表达达标',
    checkable: false,
    whyZh: '不可机器判定：需要知道素材来源（真实截图/手搓）、产品简报的数据口径与敏感信息授权，成片帧无法反推这些元数据。',
    caseZh: '手搓纹理复刻 dashboard 一下午作废；后收窄为「不用手搓复刻既有页面」，手搓件须过出版级质量门槛。',
    selfCheckZh: '每块 UI：在复刻既有页面吗？手搓件的质感和表达能过 Q10 级审视吗？数据是否已脱敏/确认口径？',
  },
  {
    id: 'Q2',
    family: 'Q',
    zh: '3D 透视下 UI 纹理按原生尺寸栅格化后缩小；文字发糊先查分辨率链路',
    checkable: false,
    whyZh: '不可机器判定：要读页面/资产实现（截图倍率、CSS zoom、纹理源分辨率）；成片帧只能看到模糊结果，不能证明栅格化链路。',
    caseZh: '三轮追打文字发糊，先调 DoF 治标无效，改原生 4x rasterize + CSS zoom 后根治。',
    selfCheckZh: '放大/透视镜头逐帧截图看文字边缘：有像素方块吗？纹理源分辨率是否 ≥ 显示尺寸 2 倍？',
  },
  {
    id: 'Q3',
    family: 'Q',
    zh: '镜头要稳：产品宣传片默认不加手持抖动',
    checkable: false,
    whyZh: '不可机器判定：输入只有每帧运动量，无法区分叙事运镜与相机噪声抖动，需要光流/相机轨迹数据或视觉复核。',
    caseZh: '去掉 handheld shake 后抖动零投诉；暗场氛围片保留 0.02 未被投诉，边界由此划定。',
    selfCheckZh: '逐镜头看渲染帧：有没有任何非叙事意图的相机抖动？',
  },
  {
    id: 'Q4',
    family: 'Q',
    zh: '高光/扫光特效宁缺毋滥：一个镜头最多给主角一次，且必须裁进圆角边界',
    checkable: true,
    whyZh: '可检查：shots[].glintCount ≤ 1；圆角裁剪需人工抽查渲染帧（检查器会在证据里提醒）。',
    caseZh: '逐卡 glint 与泛光划过被两次否决，光效裁进圆角后以更高实现标准重试通过。',
    selfCheckZh: '数全片 glint/sweep：有没有超过「主角元素一次」？每处光效是否被圆角裁剪？留下的每处自己觉得好看吗？',
  },
  {
    id: 'Q5',
    family: 'Q',
    zh: '开场只给一个主角：单主体 + 完整动作弧，胜过群体群舞',
    checkable: false,
    whyZh: '不可机器判定：「是不是一个主角、动作弧是否完整」是构图语义判断，需要画面理解；输入只有镜头时长与运动量。',
    caseZh: '开场推倒六次，单卡结构定型后直到成片未再动结构。',
    selfCheckZh: '开场镜头有几个「想让观众看」的东西？主角的动作弧是否完整（起-承-落）？',
  },
  {
    id: 'Q6',
    family: 'Q',
    zh: '机位服务可读性：信息密集镜头正视，文字特写侧向水平，倾斜逐镜头验证',
    checkable: false,
    whyZh: '不可机器判定：需要知道每个镜头的机位角度与主体类型；纯数值输入没有相机姿态/画面语义，需要视觉模型看帧。',
    caseZh: '全片统一倾斜被否回滚，列表页改回正视；hero 卡改为从左侧而非下方拍摄。',
    selfCheckZh: '每个倾斜机位：斜的理由是什么？画面里的文字在这个角度还读得清吗？',
  },
  {
    id: 'Q7',
    family: 'Q',
    zh: '物件特写四件套：侧面倾斜角 + 可感知高度 + orbit 环绕 + 反差深色材质背景',
    checkable: false,
    whyZh: '不可机器判定：需要材质、光照、空间高度与相机轨迹判断；当前输入没有相机轨迹与材质信息。',
    caseZh: 'pile 特写从初版做到暗色拉丝金属背景 + 更高堆叠 + 环绕运镜。',
    selfCheckZh: '特写主体有没有体积感和环境反差？相机是死机位还是有环绕/拉远？',
  },
  {
    id: 'Q8',
    family: 'Q',
    zh: '结尾做成「发布会合影」：全片元素四方飞入围住字标，能量推到峰值',
    checkable: false,
    whyZh: '不可机器判定：「能量是否峰值」「每个功能是否有代表元素」需要功能清单与画面语义理解。',
    caseZh: '从合影式组装做到发布会级别——crane 运镜、舞台光、金粉。',
    selfCheckZh: '结尾是不是全片能量最高点？合影里是否每个已展示功能都有代表元素？',
  },
  {
    id: 'Q9',
    family: 'Q',
    zh: '飞入终点必须是页面布局里的真实槽位，元素不悬浮在页面上方',
    checkable: false,
    whyZh: '不可机器判定：需要页面布局坐标/真实槽位数据；成片帧无法证明元素落点是否属于布局。',
    caseZh: '研究 list 改为飞入并嵌入 dashboard、随滚动延展，近整文件重写。',
    selfCheckZh: '每个飞入元素落定后，它在页面布局里有真实坐标吗？有没有元素永久浮在页面之上？',
  },
  {
    id: 'Q10',
    family: 'Q',
    zh: '文档类镜头的 mock 内容要出版级：原生排版、文字铺满、版式完整入镜',
    checkable: false,
    whyZh: '不可机器判定：「读起来像真的吗、版式完整吗」是内容与排版质量判断，需要视觉模型读画面。',
    caseZh: '「贴图+标语」级假文档整镜头重做，改原生排版全量 mock、双栏完整入镜。',
    selfCheckZh: '暂停在文档镜头任意一帧：内容读起来像真的吗？版式（侧栏/评论/页眉）完整吗？',
  },
  {
    id: 'Q11',
    family: 'Q',
    zh: '要被读的文字有最低有效字高：字幕 ≥56px、辅助 ≥32px @1080p',
    checkable: true,
    whyZh: '可检查：frames[].texts[].effectivePx 与帧高一起换算（字幕 56px / 辅助 32px @1080p），按最终渲染像素而非 fontSize。',
    caseZh: 'S1/S2/S4 字幕 38–40px、收尾 URL 25px 全部低线，统一提到 60/40/34px 档后整改通过。',
    selfCheckZh: '抽每个含字幕镜头缩到 480px 宽：每句还读得清吗？逐帧量「要读」文字实际像素高了吗？',
  },
  {
    id: 'S1',
    family: 'S',
    zh: '配乐与音效按片种选：强鼓点电子底 + 电影系 SFX 词汇，禁游戏音包音色',
    checkable: false,
    whyZh: '不可机器判定：音色是否像游戏包需要听觉判断与素材来源标注；输入只有 SFX 锚点，没有音频素材元数据。',
    caseZh: '整批替换 Kenney 游戏音为 Mixkit tech-house + whoosh/impact/riser/sparkle；禁音色不禁动作。',
    selfCheckZh: '闭眼只听音轨：像产品发布会预告还是手机游戏？BGM 是在成片里试听后选的吗？',
  },
  {
    id: 'S2',
    family: 'S',
    zh: 'SFX 逐拍钉帧管理；连发做双样本交替 + 音量阶梯递减 + 间隔加速',
    checkable: true,
    whyZh: '可检查：audio.sfxAnchors[] 的 designedFrame/measuredPeakFrame 误差 ≤0.5f；交替/递减/加速策略需看锚点表实现。',
    caseZh: '周报侧栏六连发 pop 做 0.40→0.25 阶梯递减、间隔 8→3f 加速，声音数得出节奏。',
    selfCheckZh: '每条 SFX 是否钉在具体帧号并注释了对应动作？连发段落是「数得出来的节奏」还是机械复读？',
  },
  {
    id: 'S3',
    family: 'S',
    zh: '声音在画面锁定后做；时间线一动，SFX 全表重钉',
    checkable: false,
    whyZh: '不可机器判定：这是流程纪律，需要版本历史与时间线变更记录；成片数据无法证明重钉是否发生。',
    caseZh: '画面大改两次导致全表重钉；教训链：首版钉完 11 小时后返工。',
    selfCheckZh: '本轮有没有镜头时长/顺序变化？变了的话 SFX 表逐条重对过了吗？',
  },
  {
    id: 'S4',
    family: 'S',
    zh: '拟音优先于装饰音：画面动作配真实声音、音频裁到与动作等长',
    checkable: false,
    whyZh: '不可机器判定：需要音频素材、音效时长与画面动作的对应关系；输入只有锚点帧，没有音效时长/素材元数据。',
    caseZh: '文档页揭示配打字机音，keyboard.mp3 按语境裁 24f/44f 两个用途。',
    selfCheckZh: '每个有辨识度的画面动作有没有自己的拟音？音效有没有拖到动作结束之后？轻音素材听得见吗？',
  },
  {
    id: 'S5',
    family: 'S',
    zh: '音画对齐补两项偏移：输出音轨偏移统一扣、音源峰值滞后逐文件量',
    checkable: true,
    whyZh: '可检查：audio.sfxAnchors[].outputOffsetFrames 必须存在，且 |designedFrame−measuredPeakFrame−outputOffsetFrames| ≤0.5f。',
    caseZh: '实测 click 滞后 2032 samples、impact 2066 samples（≈1.27–1.29f），与 AAC priming 指纹吻合；常数不可跨管线搬运。',
    selfCheckZh: '本管线的输出音轨偏移实测过吗？补偿是 from 计算式统一扣还是散在帧号里？峰值滞后量过了吗？',
  },
  {
    id: 'C1',
    family: 'C',
    zh: '文案在画面锁定后重写；纯动画段落也配解说，不留 >3 秒哑巴段',
    checkable: true,
    whyZh: '可检查：captions/解说窗口并集之外若存在 >3 秒间隙则失败；品牌收尾镜头（isBrandMark）豁免。',
    caseZh: '按成片重写文案，并给实拍/动画镜头补 caption 解说。',
    selfCheckZh: '逐句对照：每句文案和它所在的画面匹配吗？有没有超过 3 秒的无解说动画段落？',
  },
  {
    id: 'C2',
    family: 'C',
    zh: '标语写「团队 + 产品功能名 + 具体收益」，抽象隐喻词一律具体化',
    checkable: false,
    whyZh: '不可机器判定：文案语义质量需要语言理解与产品简报；结构化输入里没有功能名与收益清单可对照。',
    caseZh: '逐字改稿：「All your research, one board」→「All team\'s research, one place to go」；重要功能前加引导字卡。',
    selfCheckZh: '每句标语里有没有具体的功能名/收益词？有没有只靠隐喻撑着的句子？',
  },
  {
    id: 'C3',
    family: 'C',
    zh: '3D 镜头里的注记文字活在同一 3D 空间：page-space、同透视、斜拍、大衬线 + highlight',
    checkable: false,
    whyZh: '不可机器判定：需要 3D 场景与文字层级数据；成片帧无法证明文字是否在同一相机空间（平面叠字与 3D 悬空在单帧上可能相同）。',
    caseZh: '第一版平面字卡被否，改为把注记放进 3D——页面坐标系斜视、马克笔 highlight。',
    selfCheckZh: '3D 镜头里每块文字：跟着场景相机动吗，还是贴在屏幕玻璃上？',
  },
  {
    id: 'P1',
    family: 'P',
    zh: '交付前必须自己渲染截帧逐一检查，不把首检交给用户',
    checkable: true,
    whyZh: '可检查：frames 非空且每个 shot 至少覆盖一到两帧（用帧号或时间码映射）。',
    caseZh: '用户第一次看片即质问「你自己有截图检查质量吗」；此后管线长出 crop/diff/measure 自检与逐版本静帧归档。',
    selfCheckZh: '这一版交出去之前，我自己看过哪些帧？关键镜头有没有截图证据？',
  },
  {
    id: 'P2',
    family: 'P',
    zh: '参考素材先逐帧拆解成手法清单，再逐镜头判断适配性，不全局套用',
    checkable: false,
    whyZh: '不可机器判定：需要参考片、motion breakdown 清单与逐镜头适配决策；成片里没有这些流程产物。',
    caseZh: '参考片抽帧写进 spec 后连续放行；三张参考图被全局套用为统一倾斜机位，被否回滚后逐镜头重做。',
    selfCheckZh: '参考素材的每个手法有没有「采用/弃用」的显式决定？有没有把一张参考图当成全片风格令？',
  },
  {
    id: 'P3',
    family: 'P',
    zh: '指代含糊的反馈先确认对象；改错整 commit 干净 revert，不在错误版本上打补丁',
    checkable: false,
    whyZh: '不可机器判定：是协作流程纪律，输入没有对话与版本历史。',
    caseZh: '「不是第一个字卡」先理解错、hold 了 card1，8 分钟内干净 revert 再对正确对象重做通过。',
    selfCheckZh: '这条反馈的指代对象我确定吗？当前 commit 粒度出了错能一键回滚吗？',
  },
  {
    id: 'P4',
    family: 'P',
    zh: '先列功能清单逐一对应镜头；一种手法全片只当一次主角，重复镜头/信息一律删',
    checkable: true,
    whyZh: '可检查：timeline.cuts 的 isProtagonist/techniqueId/materialId 组合重复对；无标记时同手法多次只给 warn。',
    caseZh: '补上周报功能镜头；删掉重复的项目卡片概览镜头、去重收尾标语。',
    selfCheckZh: '功能清单每项都有对应镜头吗？有没有两个镜头在用同一种手法当主角、或讲同一件事？',
  },
])

export const AESTHETIC_RULES_BY_ID = Object.freeze(
  Object.fromEntries(AESTHETIC_RULES.map((rule) => [rule.id, rule])),
)

/** Look up one rule by id (null when unknown). */
export function getAestheticRule(id) {
  if (typeof id !== 'string') return null
  return Object.prototype.hasOwnProperty.call(AESTHETIC_RULES_BY_ID, id) ? AESTHETIC_RULES_BY_ID[id] : null
}

/** Number of rules that can be machine-checked. */
export const CHECKABLE_RULE_COUNT = AESTHETIC_RULES.filter((rule) => rule.checkable).length

/* ------------------------------------------------------------------ *
 * Public auditor
 * ------------------------------------------------------------------ */

const VERDICT_ZH = { pass: '通过', fail: '失败', warn: '提醒', skip: '跳过' }

/**
 * Audit a production against the case-based aesthetic rules.
 *
 * @param {object} input
 *   { shots?, frames?, audio?, timeline?, captions?, effects? } — see the module
 *   header for the full shape. Missing sub-objects cause the affected rules to
 *   `skip` with an explanation; nothing throws for partial data.
 * @param {object} [options]
 *   { captionPx=56, auxiliaryPx=32, referenceHeight=1080, defaultBpm=120 }
 * @returns {{
 *   rows: Array<{id:string, family:string, verdict:'pass'|'fail'|'warn'|'skip', evidenceZh:string, frames?:number[]}>,
 *   passRatio: number|null, failures: number, warnings: number,
 *   summaryZh: string, checked: number, skipped: number,
 * }}
 */
export function auditAesthetic(input, options = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('auditAesthetic(input) requires an input object with shots/frames/audio/timeline/effects')
  }
  const settings = options !== null && typeof options === 'object' ? options : {}
  const rows = []
  for (const rule of AESTHETIC_RULES) {
    let outcome
    if (!rule.checkable) {
      // Each rule's own `whyZh` already starts with 不可机器判定, so prefixing
      // again here produced "不可机器判定：不可机器判定：…" in every skip row.
      outcome = SKIP(rule.whyZh)
    } else {
      const checker = CHECKERS[rule.id]
      try {
        outcome = checker(input, settings)
      } catch (error) {
        outcome = SKIP(`检查器异常（${error instanceof Error ? error.message : String(error)}），请人工复核`)
      }
    }
    const verdict = ['pass', 'fail', 'warn', 'skip'].includes(outcome.verdict) ? outcome.verdict : 'skip'
    const row = {
      id: rule.id,
      family: rule.family,
      verdict,
      evidenceZh: evidenceFor(rule.zh, typeof outcome.evidenceZh === 'string' ? outcome.evidenceZh : ''),
    }
    if (Array.isArray(outcome.frames)) {
      const frames = [...new Set(outcome.frames.filter((value) => Number.isInteger(value) && value >= 0))]
      if (frames.length > 0) row.frames = frames.slice(0, 50)
    }
    rows.push(row)
  }
  const passed = rows.filter((row) => row.verdict === 'pass').length
  const failed = rows.filter((row) => row.verdict === 'fail').length
  const warned = rows.filter((row) => row.verdict === 'warn').length
  const skipped = rows.filter((row) => row.verdict === 'skip').length
  const checked = passed + failed + warned
  const passRatio = checked === 0 ? null : round(passed / checked, 3)
  const failedIds = rows.filter((row) => row.verdict === 'fail').map((row) => row.id)
  const warnedIds = rows.filter((row) => row.verdict === 'warn').map((row) => row.id)
  const summaryParts = [`共 ${rows.length} 条准则：通过 ${passed}、失败 ${failed}、提醒 ${warned}、跳过 ${skipped}`]
  if (failedIds.length > 0) summaryParts.push(`失败：${failedIds.join('、')}`)
  if (warnedIds.length > 0) summaryParts.push(`提醒：${warnedIds.join('、')}`)
  if (checked === 0) summaryParts.push('没有任何可机器判定的数据，请先提供 shots/frames/audio/timeline/effects')
  return {
    rows,
    passRatio,
    failures: failed,
    warnings: warned,
    summaryZh: `${summaryParts.join('；')}。`,
    checked,
    skipped,
  }
}

export default { AESTHETIC_FAMILIES, AESTHETIC_RULES, CHECKABLE_RULE_COUNT, auditAesthetic, getAestheticRule }
