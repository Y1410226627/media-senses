/**
 * 卡点闭环：节拍网格拟合 → 倍频消歧 → 鼓件三分类 → 拍号编排 → 渲后回测 → 输出音轨偏移。
 *
 * 方法论来自 `music-beat-sync.md`（video-shotcraft / Vincentwei1021，经 dsh-drawai
 * 固定提交 1266a3ec4831289c4d893d42dd5102723658039a 收录，Apache-2.0）。
 * 本模块是**独立实现**（零依赖、纯 Node），只吸收方法与参数，不复制上游源码：
 *
 *  1. **不要相信 tempo 标量**。beat_track 返回的 BPM 实测可能偏 2%+，但 beat 时刻
 *     序列本身是好的——对 t_i = t0 + i*T 做最小二乘拟合，残差 ≤15ms 才 `pass`
 *     （机器鼓点）。这是全片时间的唯一事实源，下游一律用 `beatTime/beatFrame`。
 *  2. **2x/0.5x 歧义必查**。判据不是听感：2x 网格有一半拍落在拍间（命中率≈50%），
 *     0.5x 网格会漏掉一半瞬态（覆盖率≈50%），正确的 1x 两个指标都接近 100%。
 *     用「网格拍命中瞬态的比例（precision）+ 瞬态被网格覆盖的比例（recall）」投票。
 *  3. **鼓件三分类**：kick 40–160Hz → 冲击/slam；snare 150–500Hz 体 + 1–3kHz 打击面
 *     （两者都要有）→ 替换/闪切；hihat 6–14kHz → 微动密度。
 *  4. **渲后回测**：成片音轨重新拟合网格，逐切点比较「设计帧号 vs 最近测得拍帧号」；
 *     pass ≤3f、ideal ≤1.5f；误差表呈同向等量偏移时，先查输出音轨偏移，不要逐点手改。
 *  5. **输出音轨偏移**：归一化互相关测渲染链路固定滞后（AAC priming 48kHz 典型
 *     ≈1.28f@30fps）。源分析的 t0 是审计真值，渲染偏移单设常量、分开记账。
 *
 * 约定：
 *  - 所有时刻是**浮点秒**，只有 `beatFrame` / `planBeatLockedCuts` 才换算成帧；
 *  - 纯函数，无 I/O、无随机、无 Date/performance：同输入必然同输出；
 *  - 全部返回值为 JSON 安全（有限数字或 null），不抛错的地方返回 `warnings`。
 *
 * @module lib/beatsync
 */
import { clamp, frameMagnitudes, hann, mean, roundTo, spectralFlatness } from './dsp.js'

/* ------------------------------------------------------------------ *
 * 公开阈值（验收门槛，报告里可直接引用）
 * ------------------------------------------------------------------ */

/**
 * 网格拟合/验收门槛（来自 music-beat-sync §1/§3 的实测校准）：
 *  - residualMaxMs：机器鼓点网格的最大残差门槛（半帧内），超过说明有变速段；
 *  - match：网格拍命中真实瞬态的比例门槛；
 *  - meanAbsMs：命中拍的平均绝对对齐误差门槛；
 *  - driftMs：残差对时间线性回归后全曲累计漂移门槛。
 */
export const BEAT_GRID_THRESHOLDS = Object.freeze({
  residualMaxMs: 15,
  match: 0.98,
  meanAbsMs: 10,
  driftMs: 5,
})

/** 渲后回测门槛：切点误差 ≤3f 合格、≤1.5f 理想（感知阈值约 3f）。 */
export const BACKTEST_THRESHOLDS = Object.freeze({
  passFrames: 3,
  idealFrames: 1.5,
})

/**
 * 输出音轨偏移测量的判定：互相关峰值 ≥minCorrelation 且偏移在搜索范围内才算可信。
 * 偏移本身没有「正确值」——它是渲染链路的实测常量，交给上层记账。
 */
export const AUDIO_OFFSET_THRESHOLDS = Object.freeze({
  minCorrelation: 0.5,
  defaultMaxOffsetSeconds: 0.5,
})

/** 候选网格命中瞬态的容差（秒）；20ms ≈ 0.6f@30fps，远小于一个半拍。 */
const MATCH_TOLERANCE_MS = 20
/** 首拍有效性容差：网格 t0 必须落在真实攻击上。 */
const FIRST_BEAT_TOLERANCE_MS = 30

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 把任意样本容器转成 Float64Array（接受普通数组 / 各种 typed array）。 */
function toFloat64Array(samples) {
  if (samples === null || samples === undefined) return new Float64Array(0)
  if (samples instanceof Float64Array) return samples
  if (ArrayBuffer.isView(samples) || Array.isArray(samples)) return Float64Array.from(samples)
  return new Float64Array(0)
}

/** 取单声道：channels>1 时按通道平均（去交错）。 */
function toMonoSamples(samples, channels = 1) {
  const data = toFloat64Array(samples)
  const count = Math.max(1, Math.round(Number(channels) || 1))
  if (count === 1 || data.length < count) return data
  const frames = Math.floor(data.length / count)
  const mono = new Float64Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (let c = 0; c < count; c += 1) sum += data[i * count + c]
    mono[i] = sum / count
  }
  return mono
}

/** 最近邻二分查找：在升序帧号数组里找离 target 最近的值。 */
function nearestValue(sorted, target) {
  const n = sorted.length
  if (n === 0) return null
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < target) lo = mid + 1
    else hi = mid
  }
  let best = sorted[lo]
  if (lo - 1 >= 0 && Math.abs(sorted[lo - 1] - target) <= Math.abs(best - target)) best = sorted[lo - 1]
  return best
}

/** 归一化时间数组：取有限正数，升序去重。 */
function normaliseTimes(values) {
  const list = Array.isArray(values) ? values : []
  const times = []
  for (const value of list) {
    const time = finiteNumber(value)
    if (time === null || time < 0) continue
    times.push(time)
  }
  times.sort((a, b) => a - b)
  const out = []
  for (const time of times) {
    if (out.length === 0 || time - out[out.length - 1] > 1e-9) out.push(time)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 1. 最小二乘等距网格拟合
 * ------------------------------------------------------------------ */

/**
 * 对 beat 时刻序列做最小二乘等距网格拟合 t_i = t0 + i*T。
 *
 * 为什么不用 tempo 标量：beat_track 的 BPM 实测可能偏 2%+，而 beat 序列的相位与
 * 周期信息完整；用整个序列拟合能把抖动平均掉，残差才是「这个网格可不可信」的证据。
 *
 * 入参必须是**连续**的 beat 序列（第 i 个元素 = 第 i 拍）。如果调用方喂进来的是稀疏
 * 子集（例如只有 kick，中间缺拍），拟合仍会给出一个看似正常的 period——所以残差
 * 超标时 `warnings` 会明确提示「可能是变速段或非连续 beat 序列」，`pass=false`
 * 与残差绑定，调用方不得把真实网格直接用于交付。
 *
 * @param {number[] | {beats?: number[], beatTimes?: number[]}} beatTimes 升序 beat 时刻（秒）
 * @returns {{bpm: number|null, t0: number|null, period: number|null, count: number,
 *            residualMaxMs: number|null, residualRmsMs: number|null, pass: boolean,
 *            warnings: string[]}}
 */
export function fitBeatGrid(beatTimes) {
  const list = Array.isArray(beatTimes)
    ? beatTimes
    : (beatTimes && typeof beatTimes === 'object'
      ? (Array.isArray(beatTimes.beats) ? beatTimes.beats : beatTimes.beatTimes)
      : null)
  const times = normaliseTimes(list)
  const count = times.length
  const empty = {
    bpm: null,
    t0: null,
    period: null,
    count,
    residualMaxMs: null,
    residualRmsMs: null,
    pass: false,
    warnings: [count < 2 ? `只有 ${count} 个 beat，无法拟合网格（至少需要 2 个）。` : '无法拟合等距网格：输入不是有效的升序 beat 序列。'],
  }
  if (count < 2) return empty

  // t_i ≈ t0 + i*T 的最小二乘闭式解（i 取 0..count-1，t0 即第 0 拍）。
  let sumIndex = 0
  let sumTime = 0
  for (let index = 0; index < count; index += 1) {
    sumIndex += index
    sumTime += times[index]
  }
  const meanIndex = sumIndex / count
  const meanTime = sumTime / count
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < count; index += 1) {
    const di = index - meanIndex
    numerator += di * (times[index] - meanTime)
    denominator += di * di
  }
  if (!(denominator > 0)) return empty
  const period = numerator / denominator
  // 时刻必须随拍号递增；周期非正说明输入不是 beat 序列。
  if (!(period > 0)) return empty
  const t0 = meanTime - period * meanIndex

  let maxAbs = 0
  let sumSquares = 0
  for (let index = 0; index < count; index += 1) {
    const residual = times[index] - (t0 + index * period)
    maxAbs = Math.max(maxAbs, Math.abs(residual))
    sumSquares += residual * residual
  }
  const residualMaxMs = roundTo(maxAbs * 1000, 2)
  const residualRmsMs = roundTo(Math.sqrt(sumSquares / count) * 1000, 2)
  const bpm = 60 / period
  const pass = residualMaxMs <= BEAT_GRID_THRESHOLDS.residualMaxMs
  const warnings = []
  if (!pass) {
    warnings.push(
      `残差 ${residualMaxMs}ms 超过 ${BEAT_GRID_THRESHOLDS.residualMaxMs}ms：` +
        '可能是变速段（需分段拟合）或非连续 beat 序列（缺拍/多拍），不要直接用于交付。',
    )
  }
  return {
    bpm: roundTo(bpm, 2),
    // t0 保留 4 位（0.1ms）、period 保留 6 位（µs 级）：两处舍入在 154 拍上累计
    // 仍 <0.01f@30fps，不会污染 beatFrame；不保留更多是为了 JSON 干净。
    t0: roundTo(t0, 4),
    period: roundTo(period, 6),
    count,
    residualMaxMs,
    residualRmsMs,
    pass,
    warnings,
  }
}

/* ------------------------------------------------------------------ *
 * 2. 2x/0.5x 歧义消解（瞬态覆盖率投票）
 * ------------------------------------------------------------------ */

/**
 * 把一个候选网格/拍序列展开成拍时刻列表。
 *
 * candidates 支持三种形态（都常见于分析管线）：
 *  - 拍时刻数组：`[0.224, 0.679, …]`；
 *  - fitBeatGrid 的结果：`{bpm, t0, period, count}` → 按 span（瞬态的时间范围）展开；
 *  - 带 `beats`/`beatTimes` 字段的对象 → 直接取用。
 */
function expandCandidateBeats(candidate, span) {
  if (Array.isArray(candidate)) return normaliseTimes(candidate)
  if (candidate === null || typeof candidate !== 'object') return []
  const explicit = candidate.beats ?? candidate.beatTimes
  if (Array.isArray(explicit)) return normaliseTimes(explicit)
  // 只有 bpm/t0/period 时按瞬态跨度展开；允许 n 为负（拍网格可能从画面开头之前开始）。
  const bpm = finiteNumber(candidate.bpm)
  const period = finiteNumber(candidate.period) ?? (bpm !== null && bpm > 0 ? 60 / bpm : null)
  const t0 = finiteNumber(candidate.t0)
  if (period === null || !(period > 0) || t0 === null) return []
  const from = span[0] - period
  const to = span[1] + period
  const firstIndex = Math.ceil((from - t0) / period) - 1
  const lastIndex = Math.floor((to - t0) / period) + 1
  const beats = []
  const guard = 100000
  for (let index = firstIndex; index <= lastIndex && beats.length < guard; index += 1) {
    const time = t0 + index * period
    if (time < -period) continue
    beats.push(time)
  }
  return normaliseTimes(beats)
}

/**
 * 评估一个候选网格对真实瞬态的覆盖率。
 *
 * 四个指标对应 music-beat-sync §3：
 *  - match（precision）= 网格拍命中真实瞬态的比例 —— 2x 网格会掉到 ~50%；
 *  - coverage（recall）= 瞬态被网格拍覆盖的比例 —— 0.5x 网格会掉到 ~50%；
 *  - meanAbsMs = 命中拍的 signed residual 绝对值均值（未命中的拍不参与，稀疏
 *    鼓点不会把正确网格误伤；漏掉的部分由 coverage 负责）；
 *  - driftMs = residual 对时间线性回归斜率 × 时间跨度（全曲累计漂移）。
 * 另外单独检查「首拍有效性」（网格第 0 拍必须落在真实攻击上）。
 */
function evaluateGridCandidate(beats, hits, index) {
  const grid = fitBeatGrid(beats)
  const tolerance = MATCH_TOLERANCE_MS / 1000
  // 只评估落在瞬态观测窗口内的网格拍：网格在观测区间之外多展开的拍（为了让 beatTime
  // 有定义而外扩的 ±period）不应拉低命中率，否则正确网格也会被误判为 reject。
  const spanLow = hits.length > 0 ? hits[0] - tolerance : Number.NEGATIVE_INFINITY
  const spanHigh = hits.length > 0 ? hits[hits.length - 1] + tolerance : Number.POSITIVE_INFINITY
  const beatsInSpan = beats.filter((beat) => beat >= spanLow && beat <= spanHigh)
  const beatCount = beatsInSpan.length
  const scoreBase = {
    index,
    bpm: grid.bpm,
    t0: grid.t0,
    period: grid.period,
    beatCount,
  }
  if (grid.bpm === null || beatCount < 2 || hits.length === 0) {
    return {
      ...scoreBase,
      match: 0,
      coverage: 0,
      meanAbsMs: null,
      driftMs: null,
      firstBeatValid: false,
      score: 0,
      verdict: 'reject',
    }
  }
  const residuals = []
  const matchedTimes = []
  let matched = 0
  for (const beat of beatsInSpan) {
    const nearest = nearestValue(hits, beat)
    if (nearest === null) continue
    const distance = beat - nearest
    if (Math.abs(distance) <= tolerance) {
      matched += 1
      residuals.push(distance)
      matchedTimes.push(beat)
    }
  }
  // 覆盖率：每个真实瞬态是否被某个网格拍覆盖（用网格拍做最近邻查找）。
  let coveredHits = 0
  for (const hit of hits) {
    const nearestBeat = nearestValue(beatsInSpan, hit)
    if (nearestBeat !== null && Math.abs(hit - nearestBeat) <= tolerance) coveredHits += 1
  }
  const match = beatCount > 0 ? matched / beatCount : 0
  const coverage = hits.length > 0 ? coveredHits / hits.length : 0
  const meanAbsMs = residuals.length > 0 ? mean(residuals.map(Math.abs)) * 1000 : null

  // 漂移：residual ≈ a + b*t 的斜率 b，乘时间跨度得到全曲累计毫秒。
  let driftMs = null
  if (residuals.length >= 2) {
    const meanTime = mean(matchedTimes)
    const meanResidual = mean(residuals)
    let numerator = 0
    let denominator = 0
    for (let i = 0; i < residuals.length; i += 1) {
      const dt = matchedTimes[i] - meanTime
      numerator += dt * (residuals[i] - meanResidual)
      denominator += dt * dt
    }
    if (denominator > 1e-12) {
      const span = matchedTimes[matchedTimes.length - 1] - matchedTimes[0]
      driftMs = Math.abs((numerator / denominator) * span) * 1000
    }
  }

  const firstBeat = beatsInSpan[0]
  const firstNearest = nearestValue(hits, firstBeat)
  const firstBeatValid = firstNearest !== null && Math.abs(firstNearest - firstBeat) <= FIRST_BEAT_TOLERANCE_MS / 1000

  // 分数：precision 为主（2x 消歧），recall 次之（0.5x 消歧），误差质量兜底。
  const errorScore = meanAbsMs === null ? 0 : Math.exp(-meanAbsMs / 8)
  let score = 0.5 * match + 0.25 * coverage + 0.25 * errorScore
  if (!firstBeatValid) score *= 0.85
  score = clamp(score, 0, 1)

  const verdict = match >= BEAT_GRID_THRESHOLDS.match &&
      meanAbsMs !== null && meanAbsMs < BEAT_GRID_THRESHOLDS.meanAbsMs &&
      driftMs !== null && driftMs < BEAT_GRID_THRESHOLDS.driftMs &&
      firstBeatValid
    ? 'accept'
    : 'reject'

  return {
    ...scoreBase,
    match: roundTo(match, 4),
    coverage: roundTo(coverage, 4),
    meanAbsMs: meanAbsMs === null ? null : roundTo(meanAbsMs, 2),
    driftMs: driftMs === null ? null : roundTo(driftMs, 2),
    firstBeatValid,
    score: roundTo(score, 4),
    verdict,
  }
}

/**
 * 只给 bpm（没有相位）的候选：用瞬态的循环相位估计 t0（圆均值）。
 * 真实分析管线里 `estimateTempo` 只给 bpm，这个兜底让 bpm 候选也能参与投票。
 */
function derivePhaseGrid(bpm, hits) {
  const period = 60 / bpm
  if (!(period > 0) || hits.length === 0) return null
  let sumSin = 0
  let sumCos = 0
  for (const time of hits) {
    const phase = ((time % period) + period) % period
    const angle = (2 * Math.PI * phase) / period
    sumSin += Math.sin(angle)
    sumCos += Math.cos(angle)
  }
  let phase = (Math.atan2(sumSin, sumCos) / (2 * Math.PI)) * period
  if (phase < 0) phase += period
  return { bpm, t0: phase, period }
}

/**
 * 在若干候选网格中选出一个（处理 2x/0.5x 歧义）。
 *
 * 判据不是听感而是鼓点数据：正确网格下 kick 主要落整数拍；2x 候选有一半拍落在
 * 拍间（match≈0.5），0.5x 候选漏掉一半瞬态（coverage≈0.5）。两者都会被正确网格
 * 压过。返回每个候选的完整指标，方便上层把「候选网格与获胜理由」写进分析产物。
 *
 * 候选形态：拍时刻数组；fitBeatGrid 结果（bpm/t0/period）；带 beats 的对象；
 * 或只给 bpm 的数字/对象（内部用瞬态循环相位补 t0）。
 *
 * @param {Array<number[]|number|{bpm?: number, t0?: number, period?: number, beats?: number[]}>} candidates
 * @param {number[]} transientTimes 真实鼓点瞬态时刻（秒），通常用 classifyTransients 的 kick/snare 合并
 * @returns {{winner: {bpm: number, t0: number, period: number, count: number, beats: number[]} | null,
 *            scores: Array<object>, reasonZh: string, winnerIndex: number|null, warnings: string[]}}
 */
export function acceptBeatGrid(candidates, transientTimes) {
  const warnings = []
  const list = Array.isArray(candidates) ? candidates : []
  const hits = normaliseTimes(transientTimes)
  if (hits.length === 0) {
    return {
      winner: null,
      scores: [],
      reasonZh: '没有可用鼓点瞬态，无法对候选网格投票（先跑 classifyTransients 或提供瞬态时刻）。',
      winnerIndex: null,
      warnings: ['transientTimes 为空'],
    }
  }
  if (list.length === 0) {
    return {
      winner: null,
      scores: [],
      reasonZh: '没有候选网格，无法消歧。',
      winnerIndex: null,
      warnings: ['candidates 为空'],
    }
  }

  const span = [hits[0], hits[hits.length - 1]]
  // 先把候选展开成拍序列；只有 bpm 的候选按瞬态循环相位补一个 t0 再展开。
  const resolved = list.map((candidate, index) => {
    let beats = expandCandidateBeats(candidate, span)
    let grid = candidate
    if (beats.length < 2) {
      const bpm = typeof candidate === 'number' ? finiteNumber(candidate) : finiteNumber(candidate?.bpm)
      if (bpm !== null && bpm > 0) {
        const phased = derivePhaseGrid(bpm, hits)
        if (phased !== null) {
          grid = phased
          beats = expandCandidateBeats(phased, span)
        }
      }
    }
    if (beats.length === 0) warnings.push(`第 ${index + 1} 个候选无法展开成拍序列，已跳过。`)
    return { grid, beats }
  })
  const scores = resolved.map((entry, index) => evaluateGridCandidate(entry.beats, hits, index))

  // 排序：分数优先；同分时优先 accepted；再同分保持输入顺序（确定性）。
  const ranked = scores
    .filter((entry) => entry.beatCount >= 2)
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const accepted = (entry) => (entry.verdict === 'accept' ? 1 : 0)
      if (accepted(b) !== accepted(a)) return accepted(b) - accepted(a)
      return a.index - b.index
    })
  if (ranked.length === 0) {
    return {
      winner: null,
      scores,
      reasonZh: '所有候选都没有展开出 ≥2 拍的序列，无法投票。',
      winnerIndex: null,
      warnings,
    }
  }
  const best = ranked[0]
  // winner.beats 只保留瞬态观测窗口内的拍，方便上层直接对照；t0/period 仍是全局网格。
  const tolerance = MATCH_TOLERANCE_MS / 1000
  const expanded = resolved[best.index].beats
  const bestBeats = expanded.filter((beat) => beat >= span[0] - tolerance && beat <= span[1] + tolerance)
  const winner = {
    bpm: best.bpm,
    t0: best.t0,
    period: best.period,
    count: best.beatCount,
    beats: bestBeats.length >= 2 ? bestBeats : expanded,
  }

  // 中文理由：写明获胜指标，并点名被淘汰的最强对手是倍频还是半频。
  const parts = [
    `选用 ${best.bpm} BPM 网格（第 ${best.index + 1} 个候选）：` +
      `命中率 ${(best.match * 100).toFixed(1)}%、覆盖率 ${(best.coverage * 100).toFixed(1)}%、` +
      `平均误差 ${best.meanAbsMs === null ? 'n/a' : `${best.meanAbsMs}ms`}、` +
      `漂移 ${best.driftMs === null ? 'n/a' : `${best.driftMs}ms`}` +
      `${best.firstBeatValid ? '、首拍有效' : '、首拍未落在攻击上'}`,
  ]
  const rivals = scores
    .filter((entry) => entry.index !== best.index && entry.beatCount >= 2)
    .sort((a, b) => b.score - a.score)
  for (const rival of rivals.slice(0, 2)) {
    if (rival.bpm === null || best.bpm === null) continue
    const ratio = rival.bpm / best.bpm
    let label = ''
    if (Math.abs(ratio - 2) <= 0.06) label = '2x 倍频歧义'
    else if (Math.abs(ratio - 0.5) <= 0.03) label = '0.5x 半频歧义'
    else label = '指标更低'
    parts.push(
      `${rival.bpm} BPM 候选被淘汰（${label}）：命中率 ${(rival.match * 100).toFixed(1)}%、` +
        `覆盖率 ${(rival.coverage * 100).toFixed(1)}%`,
    )
  }
  if (best.verdict !== 'accept') {
    parts.push('注意：最高分候选仍未达到全部验收门槛，网格不可直接用于交付，需先修分析或改拍号。')
  }
  return { winner, scores, reasonZh: parts.join('；') + '。', winnerIndex: best.index, warnings }
}

/* ------------------------------------------------------------------ *
 * 3. 鼓件三分类（kick / snare / hihat）
 * ------------------------------------------------------------------ */

/** 三分类默认参数：1024 点窗（46.9Hz/bin@48k）、128 样本 hop（2.7ms@48k）。 */
const CLASSIFY_DEFAULTS = Object.freeze({
  nFft: 1024,
  hop: 128,
  channels: 1,
  minSpacingSeconds: 0.06,
  threshold: null,
  minConfidence: 0.25,
  maxHits: 2000,
  refineWindowSeconds: 0.06,
  adaptiveWindowSeconds: 0.75,
  bands: Object.freeze({
    kick: Object.freeze([40, 160]),
    snareBody: Object.freeze([150, 500]),
    snareCrack: Object.freeze([1000, 3000]),
    hihat: Object.freeze([6000, 14000]),
  }),
})

const BAND_KEYS = Object.freeze(['kick', 'snareBody', 'snareCrack', 'hihat'])

/** 把 nFft 规整为 >=512 的 2 的幂（FFT 的要求）。 */
function normaliseFftSize(value) {
  let size = Math.max(512, Math.round(Number(value) || CLASSIFY_DEFAULTS.nFft))
  let power = 1
  while (power < size) power <<= 1
  return power
}

/**
 * 在粗定位附近用短时能量包络找攻击起点。
 *
 * 长窗 FFT 的频率分辨率好但时间分辨率差：能量峰值可能滞后攻击 10–20ms。
 * 这里用 ~2.7ms 的短窗能量，取「首个超过局部峰值 30%」的位置作为 onset，
 * 把分类命中时刻拉回真实攻击点（回测误差因此能压进几毫秒）。
 */
function refineOnsetSeconds(mono, sampleRate, coarseSeconds, windowSeconds) {
  const win = Math.max(16, Math.round(sampleRate * 0.0027))
  const hop = Math.max(1, Math.round(win / 2))
  const from = Math.max(0, Math.round((coarseSeconds - windowSeconds) * sampleRate))
  const to = Math.min(mono.length - 1, Math.round((coarseSeconds + windowSeconds) * sampleRate))
  const energies = []
  const times = []
  for (let start = from; start <= to; start += hop) {
    let sum = 0
    let count = 0
    const end = Math.min(mono.length, start + win)
    for (let i = start; i < end; i += 1) {
      sum += mono[i] * mono[i]
      count += 1
    }
    energies.push(count > 0 ? sum / count : 0)
    times.push((start + win / 2) / sampleRate)
  }
  if (energies.length < 2) return coarseSeconds
  let maxEnergy = 0
  for (const energy of energies) maxEnergy = Math.max(maxEnergy, energy)
  if (!(maxEnergy > 0)) return coarseSeconds
  const threshold = maxEnergy * 0.3
  for (let i = 0; i < energies.length; i += 1) {
    if (energies[i] >= threshold) return times[i]
  }
  return coarseSeconds
}

/** 一维中值滤波（width 为奇数；边缘窗口收缩）。 */
function medianFilterScalar(values, width) {
  const n = values.length
  const out = new Float64Array(n)
  const half = Math.max(0, Math.floor(width / 2))
  for (let i = 0; i < n; i += 1) {
    const from = Math.max(0, i - half)
    const to = Math.min(n - 1, i + half)
    const length = to - from + 1
    const window = new Float64Array(length)
    for (let j = from; j <= to; j += 1) window[j - from] = values[j]
    window.sort()
    out[i] = window[length >> 1]
  }
  return out
}

/**
 * 单频段自适应瞬态检测：先找局部极大，再用「局部中位数 × 2（且不低于 floor，且
 * 不低于局部最大值的 45%）」判峰。局部中位数提供自适应基线（弱鼓件不会被强鼓件
 * 抬高的全局阈值吃掉），局部最大值提供**突出度**门限（鼓件衰减尾巴上的噪声起伏
 * 只是同一次攻击的余波，不该被拆成新的命中）。
 *
 * @param {Float64Array} envelope 已按自身 95 分位归一化的起音包络
 * @param {{minSpacingFrames: number, localHalfWindowFrames: number, floor: number}} options
 * @returns {Array<{f: number, value: number}>} 按帧号升序
 */
function detectBandPeaks(envelope, options) {
  const n = envelope.length
  const { minSpacingFrames, localHalfWindowFrames, floor } = options
  const candidates = []
  for (let f = 0; f < n; f += 1) {
    const value = envelope[f]
    if (!(value > floor * 0.5)) continue
    const prev = f > 0 ? envelope[f - 1] : 0
    const next = f < n - 1 ? envelope[f + 1] : 0
    if (value < prev || value < next) continue
    candidates.push({ f, value })
  }
  const significant = []
  for (const candidate of candidates) {
    const from = Math.max(0, candidate.f - localHalfWindowFrames)
    const to = Math.min(n - 1, candidate.f + localHalfWindowFrames)
    const length = to - from + 1
    if (length < 3) {
      significant.push(candidate)
      continue
    }
    const window = new Float64Array(length)
    for (let i = from; i <= to; i += 1) window[i - from] = envelope[i]
    window.sort()
    const localMedian = window[length >> 1]
    // localMax 用同一窗口：突出度门限压制衰减尾巴上的噪声峰。
    const localMax = window[length - 1]
    const threshold = Math.max(localMedian * 2, floor, localMax * 0.45)
    if (candidate.value >= threshold) significant.push(candidate)
  }
  // 按强度贪心降序，再按最小间隔去重（防止能量纹波把一次攻击拆成两个峰）。
  significant.sort((a, b) => b.value - a.value || a.f - b.f)
  const spaced = []
  for (const peak of significant) {
    if (spaced.every((entry) => Math.abs(entry.f - peak.f) >= minSpacingFrames)) spaced.push(peak)
  }
  return spaced
}

/**
 * 鼓件三分类。
 *
 * 分频段算能量变化率（半波整流），**每个频段各自**用局部中位数阈值找瞬态，再把
 * 扫描到的命中并集去重；最后按两类证据定类：
 *  - 先看**谱平坦度**：hihat/cymbal/shaker 是宽带噪声，各频段密度接近平直 → hihat；
 *  - 再看瞬态**之后** 40ms 的频段能量密度（不是起音那一帧）：鼓件的音色由本体决定，
 *    起音帧被幅度突变的宽带瞬态主导，按起音帧判类会把 300Hz 的军鼓判成 kick；
 *    kick = 40–160Hz 密度占优，snare = 150–500Hz 体与 1–3kHz 打击面同时成立。
 *
 * 已知边界（实测，不要当成 bug 修）：
 *  - 同一个瞬间叠在一起的 kick+hihat 只能报一个类别，报最强的那个；
 *  - 比 kick 低 16dB 以上的 hihat 在混音里可能检不出来（检测阈值挂在最响鼓件上）；
 *  - 同一击的起音峰与打击面峰相隔较远时会各报一次（snare 计数可能翻倍）。
 *    对「哪一拍是重音」这个用途足够；做逐个鼓件的精确转录不够。
 * 允许 `opts.channels` 做多声道平均。
 *
 * @param {ArrayLike<number>} samples 单声道样本（或 channels>1 的交错多声道）
 * @param {number} sampleRate 采样率
 * @param {{nFft?: number, hop?: number, channels?: number, minSpacingSeconds?: number,
 *          threshold?: number|null, minConfidence?: number, maxHits?: number,
 *          adaptiveWindowSeconds?: number, bands?: Record<string, [number, number]>}} [opts]
 * @returns {{hits: Array<{t: number, strength: number, kind: 'kick'|'snare'|'hihat'}>,
 *            kick: number[], snare: number[], hihat: number[], warnings: string[]}}
 */
export function classifyTransients(samples, sampleRate, opts = {}) {
  const options = { ...CLASSIFY_DEFAULTS, ...(opts !== null && typeof opts === 'object' ? opts : {}) }
  const rate = Number(sampleRate)
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new TypeError('classifyTransients: sampleRate 必须是正数')
  }
  const warnings = []
  const mono = toMonoSamples(samples, options.channels)
  const minSamples = Math.min(512, Math.round(rate * 0.02))
  if (mono.length < Math.max(64, minSamples)) {
    return { hits: [], kick: [], snare: [], hihat: [], warnings: ['样本过短，无法做鼓点三分类。'] }
  }

  const nFft = normaliseFftSize(options.nFft)
  const hop = Math.max(1, Math.round(Number(options.hop) || CLASSIFY_DEFAULTS.hop))
  const half = nFft >> 1
  const binHz = rate / nFft
  const bands = { ...CLASSIFY_DEFAULTS.bands, ...(options.bands ?? {}) }
  const ranges = {}
  for (const key of BAND_KEYS) {
    const band = Array.isArray(bands[key]) ? bands[key] : CLASSIFY_DEFAULTS.bands[key]
    const lowHz = Math.max(0, Number(band[0]) || 0)
    const highHz = Math.max(lowHz, Number(band[1]) || lowHz)
    const loBin = Math.max(1, Math.ceil(lowHz / binHz))
    const hiBin = Math.min(half, Math.floor(highHz / binHz))
    ranges[key] = { loBin, hiBin }
  }

  const window = hann(nFft)
  const frameCount = Math.max(1, Math.ceil(mono.length / hop))
  const energies = {}
  for (const key of BAND_KEYS) energies[key] = new Float64Array(frameCount)
  const flatness = new Float64Array(frameCount)
  const frame = new Float64Array(nFft)
  const scratch = { real: new Float64Array(nFft), imag: new Float64Array(nFft) }
  for (let f = 0; f < frameCount; f += 1) {
    const start = f * hop
    for (let i = 0; i < nFft; i += 1) {
      const index = start + i
      frame[i] = index < mono.length ? mono[index] : 0
    }
    const magnitudes = frameMagnitudes(frame, window, scratch)
    for (const key of BAND_KEYS) {
      const { loBin, hiBin } = ranges[key]
      let energy = 0
      for (let k = loBin; k <= hiBin; k += 1) energy += magnitudes[k] * magnitudes[k]
      energies[key][f] = energy
    }
    // Spectral flatness per frame. A hi-hat / cymbal is broadband noise, whose
    // power is flat across the spectrum; a kick or a snare body is tonal-ish and
    // concentrated. Band *density* cannot tell them apart because the narrow bands
    // (3 bins for kick) have huge per-frame variance, so a pure hi-hat used to be
    // split into "kick / snare / hihat". Flatness answers the question directly.
    let powerSum = 0
    let logSum = 0
    for (let k = 1; k <= half; k += 1) {
      const power = magnitudes[k] * magnitudes[k]
      powerSum += power
      logSum += Math.log(power + 1e-12)
    }
    const arithmetic = powerSum / Math.max(1, half)
    const geometric = Math.exp(logSum / Math.max(1, half))
    flatness[f] = arithmetic > 1e-12 ? clamp(geometric / arithmetic, 0, 1) : 0
  }

  // 频段门控：只有「能量曾达到最响频段 0.5%」的频段参与检测与分类。否则安静的
  // 噪声频段会被它自己的 95 分位放大成假鼓点（实测：纯 60Hz kick 的高频泄漏会
  // 在 6–14kHz 段伪造出等间隔假峰，把每拍拆成两个命中）。
  const bandMaxEnergy = {}
  let loudestBandEnergy = 0
  for (const key of BAND_KEYS) {
    let maxEnergy = 0
    for (let f = 0; f < frameCount; f += 1) {
      if (energies[key][f] > maxEnergy) maxEnergy = energies[key][f]
    }
    bandMaxEnergy[key] = maxEnergy
    loudestBandEnergy = Math.max(loudestBandEnergy, maxEnergy)
  }
  const activeBands = BAND_KEYS.filter(
    (key) => bandMaxEnergy[key] > 1e-12 && bandMaxEnergy[key] >= loudestBandEnergy * 0.005,
  )
  if (activeBands.length === 0) {
    return { hits: [], kick: [], snare: [], hihat: [], warnings: ['四个频段都没有能量，无法做鼓点三分类。'] }
  }

  // 每个频段的起音强度 = 对数能量的半波整流变化率（对衰减尾巴上的噪声起伏不敏感，
  // 而线性能量差会把噪声抖动放大成假峰），再经 5 帧中值滤波去掉孤立尖峰，最后用
  // 95 分位稳健归一化。
  const onsets = {}
  for (const key of BAND_KEYS) {
    const normalised = new Float64Array(frameCount)
    if (activeBands.includes(key)) {
      const source = energies[key]
      const epsilon = Math.max(1e-12, bandMaxEnergy[key] * 1e-6)
      const raw = new Float64Array(frameCount)
      for (let f = 1; f < frameCount; f += 1) {
        const ratio = Math.log((source[f] + epsilon) / (source[f - 1] + epsilon))
        raw[f] = ratio > 0 ? ratio : 0
      }
      const filtered = medianFilterScalar(raw, 5)
      const sorted = Array.from(filtered).sort((a, b) => a - b)
      let scale = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
      if (!(scale > 1e-9)) scale = sorted[sorted.length - 1] ?? 0
      if (scale > 1e-9) for (let f = 0; f < frameCount; f += 1) normalised[f] = filtered[f] / scale
    }
    onsets[key] = normalised
  }

  // 三个检测器各自在自己的频段上找瞬态，再把命中取并集——不在求和包络上用一个
  // 全局阈值。原因：全混音里弱鼓件（比 kick 低 16dB 的 hihat 非常常见）的峰会
  // 被最响鼓件抬高的阈值吃掉，出现「16 个 offbeat hihat 只检出 2 个」。
  //  - kick：40–160Hz 频段；
  //  - snare：150–500Hz 体与 1–3kHz 打击面的起音强度的 min（两者同时出现才算）；
  //  - hihat：6–14kHz 频段。
  const minSpacingFrames = Math.max(
    1,
    Math.round((Number(options.minSpacingSeconds) || 0) * rate / hop),
  )
  const localHalfWindowFrames = Math.max(
    2,
    Math.round((rate * (Number(options.adaptiveWindowSeconds) || 0.75)) / hop),
  )
  const peakFloor = Number.isFinite(Number(options.threshold)) && options.threshold !== null
    ? Number(options.threshold)
    : 0.1
  const detectorEnvelopes = []
  if (activeBands.includes('kick')) detectorEnvelopes.push({ detector: 'kick', envelope: onsets.kick })
  if (activeBands.includes('snareBody') && activeBands.includes('snareCrack')) {
    const snareOnset = new Float64Array(frameCount)
    for (let f = 0; f < frameCount; f += 1) snareOnset[f] = Math.min(onsets.snareBody[f], onsets.snareCrack[f])
    detectorEnvelopes.push({ detector: 'snare', envelope: snareOnset })
  }
  if (activeBands.includes('hihat')) detectorEnvelopes.push({ detector: 'hihat', envelope: onsets.hihat })
  const detectorPeaks = []
  for (const entry of detectorEnvelopes) {
    for (const peak of detectBandPeaks(entry.envelope, {
      minSpacingFrames,
      localHalfWindowFrames,
      floor: peakFloor,
    })) {
      detectorPeaks.push({ f: peak.f, value: peak.value, detector: entry.detector })
    }
  }
  // 各检测器的命中并集：同一次攻击可能被多个频段同时触发，按强度 + 最小间隔合并。
  detectorPeaks.sort((a, b) => b.value - a.value || a.f - b.f)
  const chosen = []
  for (const candidate of detectorPeaks) {
    if (chosen.every((entry) => Math.abs(entry.f - candidate.f) >= minSpacingFrames)) chosen.push(candidate)
  }
  chosen.sort((a, b) => a.f - b.f)

  const minConfidence = clamp(Number(options.minConfidence) || CLASSIFY_DEFAULTS.minConfidence, 0, 1)
  const maxHits = Math.max(1, Math.round(Number(options.maxHits) || CLASSIFY_DEFAULTS.maxHits))
  // 频段宽度（bins 数）：判类用「能量密度」而不是原始能量。snare 的 1–3kHz 打击面
  // 只有 2000Hz 宽，hihat 频段有 8000Hz 宽；若直接比较原始能量，宽频段永远赢，
  // 只含 snare 的信号会被判成 hihat（实测踩到的第一个坑）。
  const binCounts = {}
  for (const key of BAND_KEYS) {
    const { loBin, hiBin } = ranges[key]
    binCounts[key] = hiBin >= loBin ? hiBin - loBin + 1 : 0
  }
  const candidateHits = []
  // Classification must look at the drum's **body**, not at its attack. The onset
  // frame is dominated by the broadband transient of the amplitude jump, which
  // makes every band look alike: a 300 Hz tone measured on the onset frame came
  // out as "kick", which is impossible. Averaging the bands over a short window
  // *after* the attack measures what the ear actually uses to tell drums apart.
  const bodyFrames = Math.max(1, Math.round((Number(options.bodyWindowSeconds) || 0.04) * rate / hop))
  const densityOfAt = (key, f) => {
    if (!activeBands.includes(key) || binCounts[key] === 0) return 0
    const from = Math.min(frameCount - 1, f)
    const to = Math.min(frameCount - 1, f + bodyFrames)
    let sum = 0
    for (let i = from; i <= to; i += 1) sum += energies[key][i]
    return sum / ((to - from + 1) * binCounts[key])
  }
  for (const peak of chosen) {
    const f = peak.f
    const kickDensity = densityOfAt('kick', f)
    const bodyDensity = densityOfAt('snareBody', f)
    const crackDensity = densityOfAt('snareCrack', f)
    const hihatDensity = densityOfAt('hihat', f)
    const totalDensity = kickDensity + bodyDensity + crackDensity + hihatDensity
    if (!(totalDensity > 1e-15)) continue
    const kickShare = kickDensity / totalDensity
    const bodyShare = bodyDensity / totalDensity
    const crackShare = crackDensity / totalDensity
    const hihatShare = hihatDensity / totalDensity
    const snarePair = bodyShare + crackShare
    const maxOther = Math.max(kickShare, hihatShare)
    const maxShare = Math.max(kickShare, bodyShare, crackShare, hihatShare)
    const minShare = Math.min(kickShare, bodyShare, crackShare, hihatShare)
    const spectralSpread = maxShare - minShare
    let kind
    // Broadband first: noise-like percussion (hi-hat, cymbal, shaker) reads as
    // hi-hat whatever the band densities happen to be on this particular hit.
    const flatnessHere = (() => {
      const from = Math.min(frameCount - 1, f)
      const to = Math.min(frameCount - 1, f + bodyFrames)
      let sum = 0
      for (let i = from; i <= to; i += 1) sum += flatness[i]
      return sum / (to - from + 1)
    })()
    if (flatnessHere >= (Number(options.broadbandFlatness) || 0.3)) {
      kind = 'hihat'
    } else if (spectralSpread <= 0.06) {
      // 四个频段的能量密度接近平直 = 宽带噪声类打击（cymbal/hihat 族）；真实 hihat
      // 经高通后会更偏 6–14kHz，这里仍归 hihat 而不是 snare。
      kind = 'hihat'
    } else if (bodyShare > 0.1 && crackShare > 0.1 && crackDensity > hihatDensity * 1.15 && snarePair >= maxOther) {
      // 打击面（1–3kHz）明显强于 hihat 频段：鼓面体 + 高频同时成立 = snare。
      kind = 'snare'
    } else if (hihatShare >= maxOther && hihatShare >= 0.3) {
      kind = 'hihat'
    } else if (kickShare >= maxOther && kickShare >= 0.3) {
      kind = 'kick'
    } else if (snarePair >= maxOther) {
      // snare 检测器已经要求「体 + 打击面同时出现」，这里用占比兜底判 snare。
      kind = 'snare'
    } else {
      kind = kickShare >= hihatShare ? 'kick' : 'hihat'
    }
    const kindShare = kind === 'snare' ? snarePair : kind === 'kick' ? kickShare : hihatShare
    if (!(kindShare >= minConfidence)) continue
    const coarseSeconds = (f * hop) / rate
    const refined = refineOnsetSeconds(mono, rate, coarseSeconds, Number(options.refineWindowSeconds) || 0.06)
    const t = roundTo(Math.max(0, refined), 4)
    const strength = roundTo(clamp(peak.value, 0, 1), 3)
    candidateHits.push({ t, strength, kind })
  }

  // 同一攻击可能被两个粗峰重复命中（平滑后仍有 16ms 间隔的双峰），细化会把它
  // 们拉到同一个 onset 上：按强度贪心合并，相距 < mergeTolerance 只保留最强。
  const mergeTolerance = Math.max(0.02, (Number(options.minSpacingSeconds) || 0.06) * 0.5)
  const strengthRanked = candidateHits.slice().sort((a, b) => b.strength - a.strength || a.t - b.t)
  const merged = []
  for (const hit of strengthRanked) {
    if (merged.every((entry) => Math.abs(entry.t - hit.t) >= mergeTolerance)) merged.push(hit)
  }
  merged.sort((a, b) => a.t - b.t)
  const hits = merged.slice(0, maxHits)
  const kick = hits.filter((hit) => hit.kind === 'kick').map((hit) => hit.t)
  const snare = hits.filter((hit) => hit.kind === 'snare').map((hit) => hit.t)
  const hihat = hits.filter((hit) => hit.kind === 'hihat').map((hit) => hit.t)
  if (hits.length === 0) warnings.push('没有检测到可分类的鼓点瞬态。')
  return { hits, kick, snare, hihat, warnings }
}

/* ------------------------------------------------------------------ *
 * 4. 拍号 ↔ 秒/帧
 * ------------------------------------------------------------------ */

/** 取网格的 t0/period（允许只给 bpm）。 */
function gridTiming(grid) {
  if (grid === null || typeof grid !== 'object') {
    throw new TypeError('需要网格对象 { bpm?, t0, period? }')
  }
  const t0 = finiteNumber(grid.t0)
  const bpm = finiteNumber(grid.bpm)
  const period = finiteNumber(grid.period) ?? (bpm !== null && bpm > 0 ? 60 / bpm : null)
  if (t0 === null || period === null || !(period > 0)) {
    throw new TypeError('网格必须有有限的 t0 与正的 period（或 bpm）')
  }
  return { t0, period }
}

/**
 * 拍号 → 秒。渲染偏移（输出音轨偏移）作为独立参数相加，**不写回网格 t0**：
 * t0 是源音乐的分析真值/审计基准，混入渲染偏移会在换 codec 或重分析时二次补偿。
 *
 * @param {number} n 拍号（可为小数，如 49.5）
 * @param {{bpm?: number, t0: number, period?: number}} grid 网格
 * @param {number} [outputOffsetSec=0] 渲染链路实测的输出音轨偏移（秒）
 * @returns {number} 浮点秒（不预取整）
 */
export function beatTime(n, grid, outputOffsetSec = 0) {
  const beat = finiteNumber(n)
  if (beat === null) throw new TypeError('beatTime: n 必须是有限拍号')
  const { t0, period } = gridTiming(grid)
  const offset = finiteNumber(outputOffsetSec) ?? 0
  return roundTo(t0 + beat * period + offset, 6)
}

/**
 * 拍号 → 帧号。取整只发生在这里（research §0：提前取整会让误差在管线里滚雪球）。
 *
 * @param {number} n 拍号
 * @param {{bpm?: number, t0: number, period?: number}} grid 网格
 * @param {number} fps 输出帧率
 * @param {number} [outputOffsetSec=0] 输出音轨偏移（秒）
 * @returns {number} 整数帧号
 */
export function beatFrame(n, grid, fps, outputOffsetSec = 0) {
  const rate = Number(fps)
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError('beatFrame: fps 必须是正数')
  return Math.round(beatTime(n, grid, outputOffsetSec) * rate)
}

/* ------------------------------------------------------------------ *
 * 5. 拍号编排：把镜头边界钉到拍上
 * ------------------------------------------------------------------ */

/**
 * 生成「按拍号锁定」的镜头切点表。
 *
 * 支持两种输入（二选一，均可混合 `startBeat`/`totalBeats`）：
 *  - `cutBeats`：每个切点的拍号，例如 [8, 16, 24]（加速段可以是小数 [48, 49.5, 50.5]）；
 *  - `shotBeats`：每个镜头的拍长，例如 [8, 8, 4]，自动累加成切点。
 * 也可传 `shots:[{beats|durationBeats}]`（上层 RenderPlan 的形状）。
 *
 * 每行 `{fromFrame, toFrame, beats, fromBeat, toBeat}`：beats 是该镜头占几拍
 * （可为小数）；帧号是 `beatFrame` 的结果，取整误差逐行记录在设计帧号里。
 *
 * @param {{grid: object, fps?: number, outputOffsetSec?: number, startBeat?: number,
 *          cutBeats?: number[], beats?: number[], shotBeats?: number[], durationsBeats?: number[],
 *          shots?: Array<{beats?: number, durationBeats?: number, durationSeconds?: number}>,
 *          totalBeats?: number, endBeat?: number, minFrames?: number}} opts
 * @returns {Array<{fromFrame: number, toFrame: number, beats: number, fromBeat: number, toBeat: number}>}
 */
export function planBeatLockedCuts(opts = {}) {
  if (opts === null || typeof opts !== 'object') {
    throw new TypeError('planBeatLockedCuts: 需要参数对象 { grid, cutBeats | shotBeats | shots, fps }')
  }
  const fps = Number(opts.fps ?? 30)
  if (!Number.isFinite(fps) || fps <= 0) throw new TypeError('planBeatLockedCuts: fps 必须是正数')
  const outputOffsetSec = finiteNumber(opts.outputOffsetSec) ?? 0
  const startBeat = finiteNumber(opts.startBeat) ?? 0
  const minFrames = Math.max(1, Math.round(finiteNumber(opts.minFrames) ?? 1))
  gridTiming(opts.grid) // 提前校验，错误信息更直接

  let boundaries = null
  if (Array.isArray(opts.cutBeats)) boundaries = opts.cutBeats.map((value) => finiteNumber(value))
  else if (Array.isArray(opts.beats)) boundaries = opts.beats.map((value) => finiteNumber(value))
  else if (Array.isArray(opts.cuts)) boundaries = opts.cuts.map((value) => finiteNumber(value))
  else if (Array.isArray(opts.boundaries)) boundaries = opts.boundaries.map((value) => finiteNumber(value))
  else {
    let lengths = null
    if (Array.isArray(opts.shotBeats)) lengths = opts.shotBeats.map((value) => finiteNumber(value))
    else if (Array.isArray(opts.durationsBeats)) lengths = opts.durationsBeats.map((value) => finiteNumber(value))
    else if (Array.isArray(opts.shots)) {
      const bpm = finiteNumber(opts.grid?.bpm) ?? (finiteNumber(opts.grid?.period) ? 60 / Number(opts.grid.period) : null)
      lengths = opts.shots.map((shot) => {
        // 允许 shots 直接给数字（= 该镜头占几拍），或给 RenderPlan 形状的对象。
        if (typeof shot === 'number') return finiteNumber(shot)
        const beats = finiteNumber(shot?.beats ?? shot?.durationBeats)
        if (beats !== null) return beats
        const seconds = finiteNumber(shot?.durationSeconds)
        if (seconds !== null && bpm !== null && bpm > 0) return (seconds * bpm) / 60
        return null
      })
    }
    if (lengths === null) {
      throw new TypeError('planBeatLockedCuts: 需要 cutBeats / beats / cuts / shotBeats / durationsBeats / shots 之一')
    }
    boundaries = []
    let cursor = startBeat
    for (const length of lengths) {
      if (length === null || !(length > 0)) throw new RangeError('planBeatLockedCuts: 每个镜头拍长必须是正数')
      cursor += length
      boundaries.push(cursor)
    }
  }
  if (boundaries === null || boundaries.length === 0) {
    throw new RangeError('planBeatLockedCuts: 切点列表不能为空')
  }
  const points = [startBeat]
  for (const boundary of boundaries) {
    if (boundary === null || !Number.isFinite(boundary)) throw new TypeError('planBeatLockedCuts: 切点拍号必须是有限数字')
    if (!(boundary > points[points.length - 1])) {
      throw new RangeError(`planBeatLockedCuts: 切点必须严格递增（遇到 ${boundary} ≤ ${points[points.length - 1]}）`)
    }
    points.push(boundary)
  }
  const endBeat = finiteNumber(opts.totalBeats) ?? finiteNumber(opts.endBeat)
  if (endBeat !== null) {
    const lastBoundary = points[points.length - 1]
    if (endBeat > lastBoundary + 1e-9) points.push(endBeat)
    else if (Math.abs(endBeat - lastBoundary) > 1e-9) {
      throw new RangeError(`planBeatLockedCuts: totalBeats/endBeat 必须大于最后一个切点（${lastBoundary}）`)
    }
  }

  const rows = []
  for (let index = 1; index < points.length; index += 1) {
    const fromBeat = points[index - 1]
    const toBeat = points[index]
    const fromFrame = beatFrame(fromBeat, opts.grid, fps, outputOffsetSec)
    let toFrame = beatFrame(toBeat, opts.grid, fps, outputOffsetSec)
    // 拍长太短时至少保留 minFrames，避免输出 0 帧镜头（帧号单调仍是硬约束）。
    if (toFrame - fromFrame < minFrames) toFrame = fromFrame + minFrames
    rows.push({
      fromFrame,
      toFrame,
      beats: roundTo(toBeat - fromBeat, 4),
      fromBeat: roundTo(fromBeat, 4),
      toBeat: roundTo(toBeat, 4),
    })
  }
  return rows
}

/* ------------------------------------------------------------------ *
 * 6. 渲后回测
 * ------------------------------------------------------------------ */

/**
 * 渲后回测：设计切点帧号 vs 最近测得的拍帧号。
 *
 * 门槛（BACKTEST_THRESHOLDS）：|误差| ≤3f 合格、≤1.5f 理想；任何一点 >3f 即整体
 * fail。误差表若呈同向等量偏移，`systematicOffsetFrames` 会给出中位偏移，并在
 * `verdictZh` 里提示先查输出音轨偏移（measureOutputAudioOffset）而不是逐点手改。
 *
 * @param {number[]} designedFrames 设计切点帧号（整数，来自 beatFrame/planBeatLockedCuts）
 * @param {number[]} measuredBeatTimes 成片音轨重跑网格拟合得到的真实拍时刻（秒）
 * @param {number} fps 成片帧率
 * @returns {{rows: Array<{designedFrame: number, nearestBeatFrame: number|null,
 *            errorFrames: number|null, verdict: 'ideal'|'pass'|'fail'}>,
 *            meanAbsFrames: number|null, maxAbsFrames: number|null, within3Ratio: number,
 *            pass: boolean, ideal: boolean, verdictZh: string, systematicOffsetFrames: number|null}}
 */
export function backtestAlignment(designedFrames, measuredBeatTimes, fps) {
  const rate = Number(fps)
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError('backtestAlignment: fps 必须是正数')
  const designed = (Array.isArray(designedFrames) ? designedFrames : [])
    .map((value) => finiteNumber(value))
    .filter((value) => value !== null)
  const measured = normaliseTimes(measuredBeatTimes)
  const measuredFrames = measured.map((time) => Math.round(time * rate))

  const passFrames = BACKTEST_THRESHOLDS.passFrames
  const idealFrames = BACKTEST_THRESHOLDS.idealFrames
  const rows = []
  for (const designedFrame of designed) {
    const nearestBeatFrame = nearestValue(measuredFrames, designedFrame)
    const errorFrames = nearestBeatFrame === null ? null : nearestBeatFrame - designedFrame
    const abs = errorFrames === null ? Infinity : Math.abs(errorFrames)
    const verdict = errorFrames === null ? 'fail' : abs <= idealFrames ? 'ideal' : abs <= passFrames ? 'pass' : 'fail'
    rows.push({ designedFrame, nearestBeatFrame, errorFrames, verdict })
  }
  const matched = rows.filter((row) => row.errorFrames !== null)
  const errors = matched.map((row) => row.errorFrames)
  const absErrors = errors.map((error) => Math.abs(error))
  const meanAbsFrames = absErrors.length > 0 ? roundTo(mean(absErrors), 3) : null
  const maxAbsFrames = absErrors.length > 0 ? roundTo(Math.max(...absErrors), 3) : null
  const within3Ratio = rows.length > 0
    ? roundTo(rows.filter((row) => row.errorFrames !== null && Math.abs(row.errorFrames) <= passFrames).length / rows.length, 4)
    : 0

  // 系统性同向偏移：所有误差同号且极差 ≤1 帧，基本可判定为渲染链路固定滞后。
  let systematicOffsetFrames = null
  if (errors.length >= 2) {
    const allPositive = errors.every((error) => error > 0)
    const allNegative = errors.every((error) => error < 0)
    const spread = Math.max(...errors) - Math.min(...errors)
    if ((allPositive || allNegative) && spread <= 1) {
      const sorted = errors.slice().sort((a, b) => a - b)
      const mid = sorted.length >> 1
      systematicOffsetFrames = roundTo(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, 2)
    }
  }

  const pass = rows.length > 0 && matched.length === rows.length && maxAbsFrames !== null && maxAbsFrames <= passFrames
  const ideal = pass && maxAbsFrames !== null && maxAbsFrames <= idealFrames
  let verdictZh
  if (rows.length === 0) {
    verdictZh = '没有设计切点，无法回测。'
  } else if (matched.length === 0) {
    verdictZh = '没有测得节拍，无法回测（先对成片音轨重跑网格拟合）。'
  } else if (!pass) {
    const failures = rows
      .filter((row) => row.verdict === 'fail' || row.errorFrames === null)
      .slice(0, 5)
      .map((row) => (row.errorFrames === null
        ? `设计帧 ${row.designedFrame} 无对应拍`
        : `设计帧 ${row.designedFrame} → 最近拍帧 ${row.nearestBeatFrame}（${row.errorFrames > 0 ? '+' : ''}${row.errorFrames}f）`))
    verdictZh = `${failures.length > 0 ? failures.join('；') : '部分切点'}；` +
      `${rows.filter((row) => row.verdict === 'fail').length} 个切点超过 ${passFrames} 帧，必修。` +
      (systematicOffsetFrames !== null
        ? `误差呈同向等量偏移（中位 ${systematicOffsetFrames > 0 ? '+' : ''}${systematicOffsetFrames}f）：先查输出音轨偏移（measureOutputAudioOffset），不要逐点手改。`
        : '')
  } else if (ideal) {
    verdictZh = `全部切点误差 ≤${idealFrames} 帧（理想）。` +
      (systematicOffsetFrames !== null ? `存在系统性偏移 ${systematicOffsetFrames > 0 ? '+' : ''}${systematicOffsetFrames}f，交付前可归因到输出音轨偏移。` : '')
  } else {
    verdictZh = `全部切点误差 ≤${passFrames} 帧（合格），未达 ≤${idealFrames} 帧理想线。` +
      (systematicOffsetFrames !== null ? `误差中位 ${systematicOffsetFrames > 0 ? '+' : ''}${systematicOffsetFrames}f，疑似输出音轨偏移。` : '')
  }

  return {
    rows,
    meanAbsFrames,
    maxAbsFrames,
    within3Ratio,
    pass,
    ideal,
    verdictZh,
    systematicOffsetFrames,
  }
}

/* ------------------------------------------------------------------ *
 * 7. 输出音轨偏移（归一化互相关）
 * ------------------------------------------------------------------ */

/** 按 factor 做块平均降采样（粗搜索用，降低 O(n·lag) 的常数）。 */
function decimateByMean(samples, factor) {
  if (factor <= 1) return samples
  const length = Math.floor(samples.length / factor)
  const out = new Float64Array(length)
  for (let i = 0; i < length; i += 1) {
    let sum = 0
    for (let j = 0; j < factor; j += 1) sum += samples[i * factor + j]
    out[i] = sum / factor
  }
  return out
}

/**
 * 在给定 lag 上计算两段信号的零均值归一化互相关。
 * lag > 0 表示 b 比 a 晚（b[i+lag] ≈ a[i]）。
 */
function normalisedCorrelation(a, b, lag, maxA, maxB) {
  const start = Math.max(0, -lag)
  const end = Math.min(maxA, maxB - lag)
  const count = end - start
  if (count < 8) return { correlation: -1, count: 0 }
  let sumA = 0
  let sumB = 0
  let sumAA = 0
  let sumBB = 0
  let sumAB = 0
  for (let i = start; i < end; i += 1) {
    const x = a[i]
    const y = b[i + lag]
    sumA += x
    sumB += y
    sumAA += x * x
    sumBB += y * y
    sumAB += x * y
  }
  const meanA = sumA / count
  const meanB = sumB / count
  const varianceA = sumAA / count - meanA * meanA
  const varianceB = sumBB / count - meanB * meanB
  const covariance = sumAB / count - meanA * meanB
  const denominator = Math.sqrt(Math.max(varianceA, 0) * Math.max(varianceB, 0))
  return { correlation: denominator > 1e-12 ? clamp(covariance / denominator, -1, 1) : 0, count }
}

/**
 * 测量「成片音轨」相对「源信号」的固定滞后（渲染链路偏移）。
 *
 * 机制：AAC/封装环节会给音轨加固定 priming（48kHz 典型 ≈1.28f@30fps）。这属于
 * 渲染链路常量，不是节拍分析错——所以单独测、单独记账，不写回网格 t0。
 * 实现：先按 ~2kHz 块平均降采样做 ±maxOffsetSeconds 的粗搜索，再回到全采样率
 * 在粗解附近细化，保证 O(n·lag) 可控（长音频也不会卡住）。
 * 周期性强的素材（click 轨）会有多个等高峰：同分时优先 |lag| 更小的解。
 *
 * @param {ArrayLike<number>} originalSamples 源 BGM 单声道样本
 * @param {ArrayLike<number>} renderedSamples 成片抽出的音轨单声道样本
 * @param {number} sampleRate 采样率
 * @param {{fps?: number, maxOffsetSeconds?: number, minCorrelation?: number}} [options]
 *   fps 只用于把秒换算成帧（默认 30）；minCorrelation 默认 AUDIO_OFFSET_THRESHOLDS。
 * @returns {{offsetSamples: number, offsetSeconds: number, offsetFrames: number,
 *            correlation: number, pass: boolean, warnings: string[]}}
 */
export function measureOutputAudioOffset(originalSamples, renderedSamples, sampleRate, options = {}) {
  const rate = Number(sampleRate)
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError('measureOutputAudioOffset: sampleRate 必须是正数')
  const settings = options !== null && typeof options === 'object' ? options : {}
  const fps = Number.isFinite(Number(settings.fps)) && Number(settings.fps) > 0 ? Number(settings.fps) : 30
  const maxOffsetSeconds = Number.isFinite(Number(settings.maxOffsetSeconds)) && Number(settings.maxOffsetSeconds) >= 0
    ? Number(settings.maxOffsetSeconds)
    : AUDIO_OFFSET_THRESHOLDS.defaultMaxOffsetSeconds
  const minCorrelation = Number.isFinite(Number(settings.minCorrelation))
    ? Number(settings.minCorrelation)
    : AUDIO_OFFSET_THRESHOLDS.minCorrelation

  const warnings = []
  const original = toMonoSamples(originalSamples, settings.channels)
  const rendered = toMonoSamples(renderedSamples, settings.channels)
  const fallback = {
    offsetSamples: 0,
    offsetSeconds: 0,
    offsetFrames: 0,
    correlation: 0,
    pass: false,
    warnings,
  }
  if (original.length < 64 || rendered.length < 64) {
    warnings.push('样本过短，无法测量输出音轨偏移。')
    return fallback
  }

  // 粗搜索：降到 ~2kHz，限制在 ±maxOffset，使用前 min(6s, 长度) 的窗口。
  const decim = Math.max(1, Math.round(rate / 2000))
  const coarseRate = rate / decim
  const coarseA = decimateByMean(original, decim)
  const coarseB = decimateByMean(rendered, decim)
  const coarseWindow = Math.min(coarseA.length, coarseB.length, Math.round(coarseRate * 6))
  const coarseAWindow = coarseA.subarray(0, coarseWindow)
  const maxCoarseLag = Math.min(
    Math.round(maxOffsetSeconds * coarseRate),
    Math.max(1, Math.min(coarseA.length, coarseB.length) - 1),
  )
  let bestCoarseLag = 0
  let bestCoarseCorrelation = -2
  for (let lag = -maxCoarseLag; lag <= maxCoarseLag; lag += 1) {
    const { correlation } = normalisedCorrelation(coarseAWindow, coarseB, lag, coarseAWindow.length, coarseB.length)
    if (correlation > bestCoarseCorrelation + 1e-9 ||
      (Math.abs(correlation - bestCoarseCorrelation) <= 1e-9 && Math.abs(lag) < Math.abs(bestCoarseLag))) {
      bestCoarseCorrelation = correlation
      bestCoarseLag = lag
    }
  }

  // 细化：回到全采样率，在粗解 ±(decim*2) 内细搜（用前 min(4s) 窗口控制开销）。
  const fullWindow = Math.min(original.length, rendered.length, Math.round(rate * 4))
  const fullAWindow = original.subarray(0, fullWindow)
  const centreLag = bestCoarseLag * decim
  const refineRadius = decim * 2 + 2
  const maxFullLag = Math.min(
    Math.round(maxOffsetSeconds * rate),
    Math.max(1, Math.min(original.length, rendered.length) - 1),
  )
  let bestLag = centreLag
  let bestCorrelation = -2
  for (let lag = Math.max(-maxFullLag, centreLag - refineRadius); lag <= Math.min(maxFullLag, centreLag + refineRadius); lag += 1) {
    const { correlation } = normalisedCorrelation(fullAWindow, rendered, lag, fullAWindow.length, rendered.length)
    if (correlation > bestCorrelation + 1e-9 ||
      (Math.abs(correlation - bestCorrelation) <= 1e-9 && Math.abs(lag) < Math.abs(bestLag))) {
      bestCorrelation = correlation
      bestLag = lag
    }
  }

  const offsetSamples = bestLag
  const offsetSeconds = roundTo(offsetSamples / rate, 6)
  const offsetFrames = roundTo(offsetSeconds * fps, 2)
  const correlation = roundTo(clamp(bestCorrelation, -1, 1), 4)
  const pass = correlation >= minCorrelation
  if (!pass) warnings.push(`互相关峰值 ${correlation} 低于 ${minCorrelation}，偏移测量不可信。`)
  return { offsetSamples, offsetSeconds, offsetFrames, correlation, pass, warnings }
}

export default {
  fitBeatGrid,
  acceptBeatGrid,
  classifyTransients,
  beatTime,
  beatFrame,
  planBeatLockedCuts,
  backtestAlignment,
  measureOutputAudioOffset,
  BEAT_GRID_THRESHOLDS,
  BACKTEST_THRESHOLDS,
  AUDIO_OFFSET_THRESHOLDS,
}
