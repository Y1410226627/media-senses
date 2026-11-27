/**
 * lib/sfx.js — 程序化音效合成（电影五词 + 拟音 + 设计音）。
 *
 * 为什么自己合成而不是下载素材：
 * - 离线可用、零 npm 依赖、没有素材许可风险；
 * - 参数化 → 同一个画面动作可以按镜头时长/亮度/重量微调，而不是"素材库里只有一条"；
 * - 确定性：同参数两次渲染得到逐字节相同的 WAV（种子化 mulberry32），
 *   于是成片可复现、可回归测试。
 *
 * 与上层（S5 音画对齐）的约定：
 *   const { samples, sampleRate } = synthesizeSfx('riser', { duration: 2.5 })
 *   const lag = measureSfxPeakLag(samples, sampleRate)
 *   // 很多音效的能量峰不在文件头（渐强攻击）。放置时应把音效提前：
 *   // from = 目标峰值帧 − lag.peakSeconds * fps − 输出偏移帧
 *   // 即音效的"峰值时刻"落在画面目标帧上，而不是文件头落在目标帧上。
 *
 * 归因：无上游。全部为自写 DSP（噪声整形、RBJ 双二阶滤波、加法合成、
 * 颗粒/门限调度），没有复制任何上游代码、参数表或素材。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { clamp, movingAverage } from './dsp.js'

/** 合成引擎统一采样率（契约要求 48 kHz 单声道）。 */
export const SFX_DEFAULT_SAMPLE_RATE = 48000

const MIN_SAMPLE_RATE = 8000
const MAX_SAMPLE_RATE = 192000
const DEFAULT_PEAK_DB = -1
const MAX_SEQUENCE_EVENTS = 64

// ---------------------------------------------------------------------------
// 确定性随机源（mulberry32）
// ---------------------------------------------------------------------------

/** FNV-1a 32 位哈希：把「音色 + 种子 + 采样率」折叠成整数种子。 */
function hashString(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * mulberry32：32 位状态的确定性 PRNG。
 * 只使用整数位运算，因此同一 seed 在任意 Node 版本上给出同一序列。
 */
function mulberry32(seed) {
  let state = seed >>> 0
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 从一个音色的参数环境派生独立随机源：同参数必得同序列。 */
function makeRandom(kind, opts, sampleRate) {
  const seedToken = opts && opts.seed !== undefined ? String(opts.seed) : '0'
  return mulberry32(hashString(`${kind}|${seedToken}|${sampleRate}`))
}

// ---------------------------------------------------------------------------
// 基础数学 / 包络 / 归一化
// ---------------------------------------------------------------------------

function dbToGain(db) {
  return 10 ** (db / 20)
}

function gainToDb(gain) {
  if (!(gain > 0)) return -120
  return 20 * Math.log10(gain)
}

function roundTo(value, digits = 3) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function smoothstep01(t) {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

/** 高斯包络：用于颗粒/扫频类音效的"哪一段最响"。 */
function gaussian(t, centre, width) {
  if (!(width > 0)) return 0
  const z = (t - centre) / width
  return Math.exp(-0.5 * z * z)
}

/** 指数滑音插值：频率按对数插值，听感上才是匀速的。 */
function glideFrequency(fromHz, toHz, progress) {
  const x = clamp(progress, 0, 1)
  return fromHz * (toHz / fromHz) ** x
}

function peakAbs(samples) {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i])
    if (value > peak) peak = value
  }
  return peak
}

/** 峰值归一化到目标 dBFS；目标被限制在 [−60, −0.1]，保证不削波。 */
function normalisePeak(samples, peakDb = DEFAULT_PEAK_DB) {
  const targetDb = clamp(Number.isFinite(peakDb) ? peakDb : DEFAULT_PEAK_DB, -60, -0.1)
  const peak = peakAbs(samples)
  if (!(peak > 1e-12)) return samples
  const gain = dbToGain(targetDb) / peak
  for (let i = 0; i < samples.length; i += 1) samples[i] *= gain
  return samples
}

/**
 * 文件首尾极短淡入淡出：避免 PCM 边界出现"咔"声。
 * 渐强类音效（riser/reverse-swell）的尾部本来就是能量峰，这里只做 2.5 ms
 * 收口，不会改变峰值位置。
 */
function applyEdgeFades(samples, sampleRate, fadeInMs = 0.4, fadeOutMs = 2.5) {
  const count = samples.length
  if (count === 0) return samples
  const fadeIn = Math.min(count, Math.max(0, Math.round((fadeInMs / 1000) * sampleRate)))
  const fadeOut = Math.min(count - fadeIn, Math.max(0, Math.round((fadeOutMs / 1000) * sampleRate)))
  for (let i = 0; i < fadeIn; i += 1) samples[i] *= smoothstep01(i / fadeIn)
  for (let i = 0; i < fadeOut; i += 1) samples[count - 1 - i] *= smoothstep01(i / fadeOut)
  return samples
}

// ---------------------------------------------------------------------------
// 滤波 / 合成基元
// ---------------------------------------------------------------------------

/** RBJ 带通系数（constant 0 dB peak gain）。 */
function bandpassCoefficients(cutoffHz, q, sampleRate) {
  const frequency = clamp(cutoffHz, 20, sampleRate * 0.45)
  const w0 = (2 * Math.PI * frequency) / sampleRate
  const alpha = Math.sin(w0) / (2 * clamp(q, 0.1, 12))
  const cosW = Math.cos(w0)
  const a0 = 1 + alpha
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosW) / a0,
    a2: (1 - alpha) / a0,
  }
}

/** RBJ 低通系数。 */
function lowpassCoefficients(cutoffHz, q, sampleRate) {
  const frequency = clamp(cutoffHz, 20, sampleRate * 0.45)
  const w0 = (2 * Math.PI * frequency) / sampleRate
  const alpha = Math.sin(w0) / (2 * clamp(q, 0.1, 12))
  const cosW = Math.cos(w0)
  const a0 = 1 + alpha
  const b0 = (1 - cosW) / 2 / a0
  return {
    b0,
    b1: (1 - cosW) / a0,
    b2: b0,
    a1: (-2 * cosW) / a0,
    a2: (1 - alpha) / a0,
  }
}

function createBiquadState() {
  return { z1: 0, z2: 0 }
}

/** 转置直接 II 型一步。 */
function biquadStep(state, coefficients, input) {
  const output = coefficients.b0 * input + state.z1
  state.z1 = coefficients.b1 * input - coefficients.a1 * output + state.z2
  state.z2 = coefficients.b2 * input - coefficients.a2 * output
  return output
}

/** 一阶低通（铺底噪声用，便宜且足够平滑）。 */
function onePoleLowpass(state, input, cutoffHz, sampleRate) {
  const frequency = clamp(cutoffHz, 10, sampleRate * 0.45)
  const alpha = 1 - Math.exp((-2 * Math.PI * frequency) / sampleRate)
  state.y += alpha * (input - state.y)
  return state.y
}

/**
 * 带通噪声扫频：噪声过时变带通滤波器，是 whoosh/swoosh/riser 的主料。
 * 系数每 16 个样本更新一次——扫频本身是慢变量，省下的三角函数开销不明显。
 */
function mixBandpassedNoise(target, sampleRate, random, options) {
  const count = target.length
  const seconds = count / sampleRate
  const fromHz = options.fromHz
  const toHz = options.toHz
  const q = options.q ?? 1
  const gain = options.gain ?? 1
  const envelope = options.envelope ?? (() => 1)
  const glideCurve = options.glideCurve ?? ((progress) => progress)
  const state = createBiquadState()
  let coefficients = bandpassCoefficients(fromHz, q, sampleRate)
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate
    const progress = seconds > 0 ? clamp(t / seconds, 0, 1) : 1
    if (i % 16 === 0) coefficients = bandpassCoefficients(glideFrequency(fromHz, toHz, glideCurve(progress)), q, sampleRate)
    target[i] += gain * envelope(t, seconds) * biquadStep(state, coefficients, random() * 2 - 1)
  }
  return target
}

/** 低通噪声铺底（空气感/低频体积）。 */
function mixLowpassedNoise(target, sampleRate, random, options) {
  const count = target.length
  const seconds = count / sampleRate
  const envelope = options.envelope ?? (() => 1)
  const state = { y: 0 }
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate
    const value = onePoleLowpass(state, random() * 2 - 1, options.cutoffHz ?? 200, sampleRate)
    target[i] += (options.gain ?? 1) * envelope(t, seconds) * value
  }
  return target
}

/**
 * 滑音振荡器：频率按对数曲线从 fromHz 滑到 toHz，包络由调用方给。
 * 用于 impact 的低频下滑、sub-drop、pop 的气泡音、riser 的上行音。
 */
function mixToneGlide(target, sampleRate, options) {
  const count = target.length
  const seconds = count / sampleRate
  const fromHz = options.fromHz
  const toHz = options.toHz ?? options.fromHz
  const gain = options.gain ?? 1
  const envelope = options.envelope ?? (() => 1)
  const glideCurve = options.glideCurve ?? ((progress) => progress)
  const wave = options.wave ?? 'sine'
  const harmonics = options.harmonics ?? []
  let phase = 0
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate
    const progress = seconds > 0 ? clamp(t / seconds, 0, 1) : 1
    const frequency = glideFrequency(fromHz, toHz, glideCurve(progress))
    phase += (2 * Math.PI * frequency) / sampleRate
    if (phase > 2 * Math.PI) phase %= 2 * Math.PI
    let value = wave === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(phase)) : Math.sin(phase)
    for (const harmonic of harmonics) value += harmonic.amp * Math.sin(phase * harmonic.ratio)
    target[i] += gain * envelope(t, seconds) * value
  }
  return target
}

/** 单个正弦 ping（短促的金属/塑料共振、sparkle 颗粒）。 */
function addPing(target, sampleRate, options) {
  const start = clamp(Math.round((options.atSec ?? 0) * sampleRate), 0, target.length)
  const decaySeconds = Math.max(0.0005, options.decaySec ?? 0.05)
  const attackSeconds = Math.max(0.0002, options.attackSec ?? 0.001)
  const count = Math.min(target.length - start, Math.max(1, Math.round(decaySeconds * 4 * sampleRate)))
  const frequency = options.freqHz
  const gain = options.gain ?? 1
  const noiseMix = options.noiseMix ?? 0
  const random = options.random
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate
    const attack = Math.min(1, t / attackSeconds)
    const envelope = attack * Math.exp(-t / decaySeconds)
    let value = Math.sin(2 * Math.PI * frequency * t)
    if (noiseMix > 0 && random !== undefined) value += noiseMix * (random() * 2 - 1)
    target[start + i] += gain * envelope * value
  }
  return target
}

/** 单个噪声颗粒（拟音里的摩擦/纸张/胶片颗粒）。 */
function addNoiseGrain(target, sampleRate, random, options) {
  const start = clamp(Math.round((options.atSec ?? 0) * sampleRate), 0, target.length)
  const durationSeconds = Math.max(0.0003, options.durationSec ?? 0.01)
  const count = Math.min(target.length - start, Math.max(1, Math.round(durationSeconds * sampleRate)))
  const attackSeconds = Math.max(0.0002, options.attackSec ?? 0.0008)
  const state = createBiquadState()
  const coefficients = bandpassCoefficients(options.centerHz ?? 3000, options.q ?? 1, sampleRate)
  const gain = options.gain ?? 1
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate
    const envelope = Math.min(1, t / attackSeconds) * Math.exp(-t / (durationSeconds * 0.45))
    target[start + i] += gain * envelope * biquadStep(state, coefficients, random() * 2 - 1)
  }
  return target
}

// ---------------------------------------------------------------------------
// 调色板 —— 每个音色的身份、时长区间、适用画面动作、合成参数
// ---------------------------------------------------------------------------

/**
 * 音色表。`duration` 是合成时允许的时长区间（秒）；
 * `actionZh` 直接给模型读「这个音效配什么画面动作」；
 * `params` 是合成参数（`opts.params` 可覆盖），也是调音时的旋钮清单。
 */
export const SFX_PALETTE = Object.freeze({
  // —— 电影转场五词 ——
  whoosh: {
    zh: '呼啸',
    family: 'cinematic',
    duration: [0.45, 2.2],
    actionZh: '镜头快速横移、场景硬切的过渡、画面被"划开"的擦拭转场',
    params: {
      defaultDuration: 0.9,
      sweepHz: [260, 4200],
      q: 1.05,
      rumbleHz: 110,
      attackMs: 120,
      tailMs: 320,
    },
  },
  swoosh: {
    zh: '疾掠',
    family: 'cinematic',
    duration: [0.25, 1.2],
    actionZh: '轻快的甩镜、滑块/卡片飞入飞出、短促的擦拭转场',
    params: { defaultDuration: 0.55, sweepHz: [700, 7200], q: 0.85, attackMs: 45, tailMs: 140 },
  },
  impact: {
    zh: '重击',
    family: 'cinematic',
    duration: [0.4, 2.0],
    actionZh: '标题砸入、Logo 落定、动作片打击点、章节切换的"锤"',
    params: { defaultDuration: 1.0, hitHz: [120, 42], subMs: 280, tailHz: 900, noiseDecayMs: 180 },
  },
  riser: {
    zh: '渐强',
    family: 'cinematic',
    duration: [1.0, 6.0],
    actionZh: '悬念蓄力、情绪爬升、转场前的加速、把观众推向落点的上行音',
    params: { defaultDuration: 2.5, sweepHz: [160, 9000], toneHz: [110, 880], curve: 2.0, q: 1.05 },
  },
  sparkle: {
    zh: '星芒',
    family: 'cinematic',
    duration: [0.4, 2.0],
    actionZh: '高光闪烁、粒子炸开、UI 成就提示、魔法/科技元素的点缀',
    params: { defaultDuration: 1.1, grains: 20, freqHz: [3200, 12000], decayMs: [22, 80] },
  },

  // —— 拟音（S4 词汇表） ——
  click: {
    zh: '点击',
    family: 'foley',
    duration: [0.03, 0.12],
    actionZh: '鼠标点击、按钮按下、UI 确认、表盘指针的小瞬态',
    params: { defaultDuration: 0.06, tickHz: 2800, bodyHz: 700, decayMs: 22 },
  },
  switch: {
    zh: '开关',
    family: 'foley',
    duration: [0.08, 0.3],
    actionZh: '拨动开关、机械档位切换、设备启停的塑料"哒"声',
    params: { defaultDuration: 0.14, firstHz: 1200, gapMs: 55, thunkHz: 120 },
  },
  paper: {
    zh: '纸张',
    family: 'foley',
    duration: [0.2, 1.0],
    actionZh: '翻页、撕纸、文件抽出、档案/剧本类画面的手感细节',
    params: { defaultDuration: 0.4, grains: 13, bandHz: [1200, 7000], grainMs: [8, 26] },
  },
  key: {
    zh: '按键',
    family: 'foley',
    duration: [0.04, 0.15],
    actionZh: '键盘敲击、打字机、机械键帽的特写',
    params: { defaultDuration: 0.08, tickHz: 2600, resonanceHz: [2400, 3800], decayMs: 28 },
  },
  pop: {
    zh: '气泡',
    family: 'foley',
    duration: [0.04, 0.18],
    actionZh: '气泡破裂、气泡弹出、轻松可爱的 UI 反馈',
    params: { defaultDuration: 0.08, fromHz: 220, toHz: 900, decayMs: 30 },
  },
  shutter: {
    zh: '快门',
    family: 'foley',
    duration: [0.12, 0.5],
    actionZh: '相机快门、镜头开合、拍照瞬间的机械双响',
    params: { defaultDuration: 0.22, clacks: 2, gapMs: 75, bandHz: [1800, 8000], resonanceHz: 1500 },
  },
  glass: {
    zh: '玻璃',
    family: 'foley',
    duration: [0.15, 0.9],
    actionZh: '玻璃轻碰/碎裂、水晶质感物体、清脆的撞击',
    params: { defaultDuration: 0.4, partials: [1, 1.53, 2.17, 2.91, 3.7], baseHz: 2100, decayMs: [60, 220] },
  },
  grain: {
    zh: '颗粒',
    family: 'foley',
    duration: [0.2, 1.2],
    actionZh: '胶片颗粒/沙砾/细碎噪点、质感铺底、老电影的氛围层',
    params: { defaultDuration: 0.5, grains: 34, bandHz: [3500, 11000], grainMs: [2, 6] },
  },

  // —— 设计音 ——
  'sub-drop': {
    zh: '低频下潜',
    family: 'design',
    duration: [0.6, 2.5],
    actionZh: '重物坠落、深潜/失重、暗场转场的低频托底',
    params: { defaultDuration: 1.3, fromHz: 72, toHz: 24, dropMs: 420, decayMs: 520 },
  },
  shimmer: {
    zh: '微光',
    family: 'design',
    duration: [0.6, 3.0],
    actionZh: '金属微光、魔法余韵、科技界面的高频闪烁铺底',
    params: { defaultDuration: 1.4, partials: 8, freqHz: [1200, 9000], tremHz: [4, 8] },
  },
  'reverse-swell': {
    zh: '反向渐强',
    family: 'design',
    duration: [0.5, 3.0],
    actionZh: '倒带式蓄力、揭示前的吸气、转场前的"反着来"',
    params: { defaultDuration: 1.2, sweepHz: [350, 6000], toneHz: [180, 1900], curve: 2.5 },
  },
  glitch: {
    zh: '故障',
    family: 'design',
    duration: [0.12, 0.8],
    actionZh: '数字故障、信号干扰、赛博/骇客画面、卡顿与撕裂',
    params: { defaultDuration: 0.35, segments: 14, bitDepth: 4, sampleHold: [2, 7], bandHz: [600, 12000] },
  },
})

/** 支持的音色全集（顺序即调色板声明顺序，界面/报告按此展示）。 */
export const SFX_KINDS = Object.freeze(Object.keys(SFX_PALETTE))

// ---------------------------------------------------------------------------
// 各音色渲染器（Float64 累加，最后统一归一化）
// ---------------------------------------------------------------------------

/** 呼啸：带通噪声三角扫频（升→降）+ 低频体积 + 错相第二层。 */
function renderWhoosh(target, sampleRate, random, params, seconds) {
  const peakAt = 0.46 * seconds
  mixBandpassedNoise(target, sampleRate, random, {
    fromHz: params.sweepHz[0],
    toHz: params.sweepHz[1],
    q: params.q,
    gain: 0.95,
    glideCurve: (progress) => (progress < 0.5 ? progress * 2 : (1 - progress) * 2),
    envelope: (t) => {
      const rise = smoothstep01(t / Math.max(0.02, peakAt))
      const fall = t <= peakAt ? 1 : Math.exp(-(t - peakAt) / (0.3 * seconds))
      return rise * fall
    },
  })
  mixLowpassedNoise(target, sampleRate, random, {
    cutoffHz: params.rumbleHz,
    gain: 0.22,
    envelope: (t) => gaussian(t, 0.42 * seconds, 0.3 * seconds),
  })
  // 第二层带通略晚于主轴、频带略窄：单声道下靠频谱移动制造"声像位移"感。
  mixBandpassedNoise(target, sampleRate, random, {
    fromHz: params.sweepHz[0] * 1.2,
    toHz: params.sweepHz[1] * 0.75,
    q: params.q * 1.6,
    gain: 0.4,
    glideCurve: (progress) => clamp((progress - 0.18) / 0.8, 0, 1),
    envelope: (t) => gaussian(t, 0.58 * seconds, 0.24 * seconds),
  })
}

/** 疾掠：更短更亮，快速高频扫频。 */
function renderSwoosh(target, sampleRate, random, params, seconds) {
  const peakAt = 0.4 * seconds
  mixBandpassedNoise(target, sampleRate, random, {
    fromHz: params.sweepHz[0],
    toHz: params.sweepHz[1],
    q: params.q,
    gain: 0.95,
    glideCurve: (progress) => (progress < 0.55 ? progress / 0.55 : (1 - progress) / 0.45),
    envelope: (t) => {
      const rise = smoothstep01(t / Math.max(0.012, peakAt * 0.7))
      const fall = t <= peakAt ? 1 : Math.exp(-(t - peakAt) / (0.18 * seconds))
      return rise * fall
    },
  })
  mixLowpassedNoise(target, sampleRate, random, {
    cutoffHz: 180,
    gain: 0.18,
    envelope: (t) => gaussian(t, 0.35 * seconds, 0.25 * seconds),
  })
}

/** 重击：40–160 Hz 下滑正弦 + 低通噪声尾 + 高频瞬态。 */
function renderImpact(target, sampleRate, random, params, seconds) {
  const subDecay = (params.subMs / 1000) * 0.55
  mixToneGlide(target, sampleRate, {
    fromHz: params.hitHz[0],
    toHz: params.hitHz[1],
    gain: 1,
    glideCurve: (progress) => clamp(progress * 2.2, 0, 1),
    envelope: (t) => Math.min(1, t / 0.0018) * Math.exp(-t / subDecay),
    harmonics: [{ ratio: 2, amp: 0.22 }],
  })
  mixLowpassedNoise(target, sampleRate, random, {
    cutoffHz: params.tailHz,
    gain: 0.55,
    envelope: (t) => Math.min(1, t / 0.0012) * Math.exp(-t / ((params.noiseDecayMs / 1000) * 0.6)),
  })
  mixBandpassedNoise(target, sampleRate, random, {
    fromHz: 1700,
    toHz: 3200,
    q: 0.7,
    gain: 0.4,
    glideCurve: (progress) => progress,
    envelope: (t) => Math.exp(-t / 0.005),
  })
}

/** 渐强：能量曲线 t²，带通扫频 + 上行三角波，峰值自然落在落点。 */
function renderRiser(target, sampleRate, random, params, seconds) {
  const envelope = (t) => clamp(t / seconds, 0, 1) ** params.curve
  mixBandpassedNoise(target, sampleRate, random, {
    fromHz: params.sweepHz[0],
    toHz: params.sweepHz[1],
    q: params.q,
    gain: 0.85,
    envelope,
  })
  mixToneGlide(target, sampleRate, {
    fromHz: params.toneHz[0],
    toHz: params.toneHz[1],
    gain: 0.26,
    wave: 'triangle',
    harmonics: [{ ratio: 2, amp: 0.28 }],
    envelope,
  })
  // 最后 60 ms 加一层向上"开"的高频，让落点更明确。
  mixBandpassedNoise(target, sampleRate, random, {
    fromHz: 6000,
    toHz: 10000,
    q: 0.6,
    gain: 0.22,
    envelope: (t) => (t > seconds - 0.06 ? smoothstep01((t - (seconds - 0.06)) / 0.06) : 0),
  })
}

/** 星芒：随机高频颗粒 + 高频空气层。 */
function renderSparkle(target, sampleRate, random, params) {
  const count = Math.max(1, Math.round(params.grains))
  for (let g = 0; g < count; g += 1) {
    const atSec = (0.05 + random() * 0.82) * (target.length / sampleRate)
    const frequency = glideFrequency(params.freqHz[0], params.freqHz[1], random())
    const decayMs = params.decayMs[0] + random() * (params.decayMs[1] - params.decayMs[0])
    addPing(target, sampleRate, {
      atSec,
      freqHz: frequency,
      decaySec: decayMs / 1000,
      gain: 0.12 + random() * 0.28,
      attackSec: 0.0006,
      noiseMix: 0.08,
      random,
    })
  }
  mixBandpassedNoise(target, sampleRate, random, {
    fromHz: 5000,
    toHz: 11000,
    q: 0.6,
    gain: 0.16,
    envelope: (t, seconds) => gaussian(t, 0.5 * seconds, 0.36 * seconds),
  })
}

/** 点击：几毫秒的高频 tick + 快速下滑的塑料 body。 */
function renderClick(target, sampleRate, random, params, seconds) {
  addNoiseGrain(target, sampleRate, random, {
    atSec: 0,
    durationSec: 0.006,
    centerHz: params.tickHz,
    q: 1.1,
    gain: 0.85,
  })
  mixToneGlide(target, sampleRate, {
    fromHz: params.tickHz,
    toHz: params.bodyHz,
    gain: 0.7,
    glideCurve: (progress) => clamp(progress / clamp(0.022 / seconds, 0.05, 1), 0, 1),
    envelope: (t) => Math.min(1, t / 0.0005) * Math.exp(-t / (params.decayMs / 1000)),
  })
}

/** 开关：两次机械 tick，中间夹一个塑料 thunk。 */
function renderSwitch(target, sampleRate, random, params, seconds) {
  addNoiseGrain(target, sampleRate, random, { atSec: 0, durationSec: 0.006, centerHz: 3200, q: 1.2, gain: 0.8 })
  addPing(target, sampleRate, { atSec: 0, freqHz: params.firstHz, decaySec: 0.009, gain: 0.5, attackSec: 0.0004 })
  const gapSeconds = params.gapMs / 1000
  mixToneGlide(target, sampleRate, {
    fromHz: params.thunkHz,
    toHz: params.thunkHz * 0.72,
    gain: 0.45,
    glideCurve: (progress) => clamp(progress * 3, 0, 1),
    envelope: (t) => gaussian(t, gapSeconds, 0.02) * Math.min(1, t / 0.002),
  })
  addNoiseGrain(target, sampleRate, random, {
    atSec: clamp(gapSeconds, 0, seconds - 0.005),
    durationSec: 0.007,
    centerHz: 2400,
    q: 1.1,
    gain: 0.55,
  })
}

/** 纸张：一批高通噪声颗粒 + 一层低频摩擦底。 */
function renderPaper(target, sampleRate, random, params) {
  const seconds = target.length / sampleRate
  const count = Math.max(1, Math.round(params.grains))
  for (let g = 0; g < count; g += 1) {
    addNoiseGrain(target, sampleRate, random, {
      atSec: random() * seconds * 0.88,
      durationSec: (params.grainMs[0] + random() * (params.grainMs[1] - params.grainMs[0])) / 1000,
      centerHz: glideFrequency(params.bandHz[0], params.bandHz[1], random()),
      q: 0.8,
      gain: 0.25 + random() * 0.5,
    })
  }
  mixBandpassedNoise(target, sampleRate, random, {
    fromHz: 1200,
    toHz: 4200,
    q: 0.55,
    gain: 0.14,
    envelope: (t, duration) => gaussian(t, 0.5 * duration, 0.3 * duration),
  })
}

/** 按键：极短 tick + 两个塑料共振。 */
function renderKey(target, sampleRate, random, params) {
  addNoiseGrain(target, sampleRate, random, {
    atSec: 0,
    durationSec: 0.005,
    centerHz: params.tickHz,
    q: 1.3,
    gain: 0.85,
  })
  for (let idx = 0; idx < params.resonanceHz.length; idx += 1) {
    addPing(target, sampleRate, {
      atSec: 0.0004 * idx,
      freqHz: params.resonanceHz[idx] * (0.98 + random() * 0.04),
      decaySec: (params.decayMs / 1000) * (1 - idx * 0.25),
      gain: 0.4 - idx * 0.14,
      attackSec: 0.0005,
    })
  }
  addPing(target, sampleRate, { atSec: 0, freqHz: 180, decaySec: 0.02, gain: 0.2, attackSec: 0.001 })
}

/** 气泡：220→900 Hz 快速上滑，短促圆润。 */
function renderPop(target, sampleRate) {
  mixToneGlide(target, sampleRate, {
    fromHz: 220,
    toHz: 900,
    gain: 1,
    glideCurve: (progress) => clamp(progress * 2.5, 0, 1),
    envelope: (t) => Math.min(1, t / 0.0015) * Math.exp(-t / 0.028),
    harmonics: [{ ratio: 2, amp: 0.08 }],
  })
}

/** 快门：两次机械 clack（开/合），第二次略轻。 */
function renderShutter(target, sampleRate, random, params) {
  for (let clack = 0; clack < params.clacks; clack += 1) {
    const atSec = (clack * params.gapMs) / 1000
    const gain = 1 - clack * 0.22
    addNoiseGrain(target, sampleRate, random, {
      atSec,
      durationSec: 0.008,
      centerHz: glideFrequency(params.bandHz[0], params.bandHz[1], random()),
      q: 0.9,
      gain: 0.6 * gain,
    })
    addPing(target, sampleRate, { atSec, freqHz: params.resonanceHz, decaySec: 0.022, gain: 0.4 * gain, attackSec: 0.0005 })
    if (clack === 0) addPing(target, sampleRate, { atSec, freqHz: 420, decaySec: 0.03, gain: 0.25, attackSec: 0.001 })
  }
}

/** 玻璃：非谐泛音簇 + 起始碰撞瞬态。 */
function renderGlass(target, sampleRate, random, params) {
  addNoiseGrain(target, sampleRate, random, { atSec: 0, durationSec: 0.005, centerHz: 4200, q: 0.9, gain: 0.6 })
  for (let idx = 0; idx < params.partials.length; idx += 1) {
    const detune = 1 + (random() - 0.5) * 0.012
    const decayMs = params.decayMs[0] + random() * (params.decayMs[1] - params.decayMs[0])
    addPing(target, sampleRate, {
      atSec: 0.0005 * idx,
      freqHz: params.baseHz * params.partials[idx] * detune,
      decaySec: decayMs / 1000,
      gain: 0.55 / (idx + 1),
      attackSec: 0.0006,
      noiseMix: 0.03,
      random,
    })
  }
}

/** 颗粒：大量极短高通颗粒，形成胶片/沙砾质感。 */
function renderGrain(target, sampleRate, random, params) {
  const seconds = target.length / sampleRate
  const count = Math.max(1, Math.round(params.grains))
  for (let g = 0; g < count; g += 1) {
    addNoiseGrain(target, sampleRate, random, {
      atSec: random() * seconds,
      durationSec: (params.grainMs[0] + random() * (params.grainMs[1] - params.grainMs[0])) / 1000,
      centerHz: glideFrequency(params.bandHz[0], params.bandHz[1], random()),
      q: 1.4,
      gain: 0.18 + random() * 0.5,
    })
  }
  mixBandpassedNoise(target, sampleRate, random, {
    fromHz: 6000,
    toHz: 9000,
    q: 0.5,
    gain: 0.06,
    envelope: () => 1,
  })
}

/** 低频下潜：72→24 Hz 下滑，长衰减 + 轻噪声尾。 */
function renderSubDrop(target, sampleRate, random, params, seconds) {
  const dropSeconds = params.dropMs / 1000
  const envelope = (t) => Math.min(1, t / 0.015) * Math.exp(-t / (params.decayMs / 1000))
  mixToneGlide(target, sampleRate, {
    fromHz: params.fromHz,
    toHz: params.toHz,
    gain: 1,
    glideCurve: (progress) => clamp(progress / clamp(dropSeconds / seconds, 0.05, 1), 0, 1),
    envelope,
    harmonics: [{ ratio: 2, amp: 0.16 }],
  })
  mixLowpassedNoise(target, sampleRate, random, {
    cutoffHz: 90,
    gain: 0.16,
    envelope: (t) => Math.exp(-t / (0.6 * seconds)),
  })
}

/** 微光：等音程分布的高频部分音 + 慢颤音，金属余韵。 */
function renderShimmer(target, sampleRate, random, params) {
  const count = Math.max(1, Math.round(params.partials))
  for (let idx = 0; idx < count; idx += 1) {
    const position = count > 1 ? idx / (count - 1) : 0.5
    const frequency = glideFrequency(params.freqHz[0], params.freqHz[1], clamp(position + (random() - 0.5) * 0.05, 0, 1))
    const tremoloHz = params.tremHz[0] + random() * (params.tremHz[1] - params.tremHz[0])
    const phase = random() * 2 * Math.PI
    const gain = (0.42 / (1 + idx * 0.35)) * (0.7 + random() * 0.5)
    mixToneGlide(target, sampleRate, {
      fromHz: frequency,
      toHz: frequency * 0.997,
      gain,
      envelope: (t, seconds) => {
        const attack = smoothstep01(t / 0.08)
        const decay = Math.exp(-t / (0.55 * seconds))
        const tremolo = 0.72 + 0.28 * Math.sin(2 * Math.PI * tremoloHz * t + phase)
        return attack * decay * tremolo
      },
    })
  }
  mixBandpassedNoise(target, sampleRate, random, {
    fromHz: 6000,
    toHz: 11000,
    q: 0.7,
    gain: 0.12,
    envelope: (t, seconds) => smoothstep01(t / 0.25) * Math.exp(-t / (0.6 * seconds)),
  })
}

/** 反向渐强：能量曲线 t^2.5，噪声扫频 + 上行音，峰在尾端。 */
function renderReverseSwell(target, sampleRate, random, params, seconds) {
  const envelope = (t) => clamp(t / seconds, 0, 1) ** params.curve
  mixBandpassedNoise(target, sampleRate, random, {
    fromHz: params.sweepHz[0],
    toHz: params.sweepHz[1],
    q: 0.9,
    gain: 0.95,
    envelope,
  })
  mixToneGlide(target, sampleRate, {
    fromHz: params.toneHz[0],
    toHz: params.toneHz[1],
    gain: 0.24,
    wave: 'triangle',
    envelope,
  })
}

/** 故障：分段的噪声门 / 方波 / 采样保持 / 丢帧，模拟数字信号损坏。 */
function renderGlitch(target, sampleRate, random, params) {
  const count = target.length
  const types = ['noise', 'tone', 'hold', 'drop']
  let position = 0
  let guard = 0
  while (position < count && guard < params.segments * 4) {
    guard += 1
    const length = Math.max(1, Math.round((0.008 + random() * 0.028) * sampleRate))
    const type = types[Math.floor(random() * types.length)]
    const gain = 0.25 + random() * 0.75
    if (type === 'noise') {
      for (let i = 0; i < length && position + i < count; i += 1) target[position + i] += gain * (random() * 2 - 1)
    } else if (type === 'tone') {
      const frequency = 180 + Math.floor(random() * 14) * 140
      for (let i = 0; i < length && position + i < count; i += 1) target[position + i] += gain * 0.5 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
    } else if (type === 'hold') {
      const holdLength = Math.max(2, Math.round(params.sampleHold[0] + random() * (params.sampleHold[1] - params.sampleHold[0])))
      const levels = 2 ** params.bitDepth
      let value = 0
      for (let i = 0; i < length && position + i < count; i += 1) {
        if (i % holdLength === 0) value = Math.round((random() * 2 - 1) * levels) / levels
        target[position + i] += gain * value
      }
    }
    // 'drop' 段故意留空：数字信号丢帧的"断"感。
    position += length + Math.round(random() * 0.012 * sampleRate)
  }
}

const RENDERERS = Object.freeze({
  whoosh: renderWhoosh,
  swoosh: renderSwoosh,
  impact: renderImpact,
  riser: renderRiser,
  sparkle: renderSparkle,
  click: renderClick,
  switch: renderSwitch,
  paper: renderPaper,
  key: renderKey,
  pop: renderPop,
  shutter: renderShutter,
  glass: renderGlass,
  grain: renderGrain,
  'sub-drop': renderSubDrop,
  shimmer: renderShimmer,
  'reverse-swell': renderReverseSwell,
  glitch: renderGlitch,
})

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

function normaliseKind(kind, caller) {
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new Error(`${caller}: 音色名必须是字符串；可用音色: ${SFX_KINDS.join(', ')}`)
  }
  if (!Object.prototype.hasOwnProperty.call(SFX_PALETTE, kind)) {
    throw new Error(`${caller}: 未知音色 "${kind}"；可用音色: ${SFX_KINDS.join(', ')}`)
  }
  return kind
}

function normaliseSampleRate(sampleRate, caller) {
  if (sampleRate === undefined || sampleRate === null) return SFX_DEFAULT_SAMPLE_RATE
  const value = Number(sampleRate)
  if (!Number.isFinite(value) || value < MIN_SAMPLE_RATE || value > MAX_SAMPLE_RATE) {
    throw new Error(`${caller}: sampleRate 必须是 ${MIN_SAMPLE_RATE}..${MAX_SAMPLE_RATE} 的有限数，收到 ${String(sampleRate)}`)
  }
  return Math.round(value)
}

// ---------------------------------------------------------------------------
// 合成入口
// ---------------------------------------------------------------------------

/**
 * 合成一个音效。
 *
 * @param {string} kind SFX_PALETTE 的键之一
 * @param {object} [opts]
 * @param {number} [opts.duration] 时长（秒），默认取 palette.params.defaultDuration，
 *        越界会被夹到 palette.duration 区间（riser 等允许长尾音效可按镜头配长）
 * @param {number} [opts.sampleRate] 默认 48000
 * @param {number} [opts.peakDb] 峰值归一化目标，默认 −1 dBFS；范围 [−60, −0.1]
 * @param {number|string} [opts.seed] 随机种子；同一 (kind, seed, sampleRate) 输出逐字节相同
 * @param {object} [opts.params] 覆盖 palette.params 里的合成参数
 * @returns {{samples: Float32Array, sampleRate: number, duration: number, meta: object}}
 */
export function synthesizeSfx(kind, opts = {}) {
  const resolvedKind = normaliseKind(kind, 'synthesizeSfx')
  const entry = SFX_PALETTE[resolvedKind]
  const sampleRate = normaliseSampleRate(opts.sampleRate, 'synthesizeSfx')
  const params = { ...entry.params, ...(opts.params ?? {}) }
  const [minDuration, maxDuration] = entry.duration

  if (opts.duration !== undefined && opts.duration !== null && !Number.isFinite(Number(opts.duration))) {
    throw new Error(`synthesizeSfx: opts.duration 必须是有限数，收到 ${String(opts.duration)}`)
  }
  const requested = Number.isFinite(Number(opts.duration)) ? Number(opts.duration) : params.defaultDuration ?? minDuration
  if (requested <= 0) throw new Error(`synthesizeSfx: opts.duration 必须为正数，收到 ${requested}`)
  const duration = clamp(requested, minDuration, maxDuration)
  const sampleCount = Math.max(1, Math.round(duration * sampleRate))
  const actualDuration = sampleCount / sampleRate

  const accumulator = new Float64Array(sampleCount)
  const random = makeRandom(resolvedKind, opts, sampleRate)
  RENDERERS[resolvedKind](accumulator, sampleRate, random, params, actualDuration)
  applyEdgeFades(accumulator, sampleRate)
  normalisePeak(accumulator, opts.peakDb)

  const samples = Float32Array.from(accumulator)
  const measuredPeak = peakAbs(samples)
  return {
    samples,
    sampleRate,
    duration: roundTo(actualDuration, 6),
    meta: {
      kind: resolvedKind,
      zh: entry.zh,
      family: entry.family,
      actionZh: entry.actionZh,
      params,
      seed: opts.seed ?? 0,
      sampleRate,
      peakDb: roundTo(gainToDb(measuredPeak), 2),
      normalizedPeakDb: roundTo(clamp(Number.isFinite(opts.peakDb) ? opts.peakDb : DEFAULT_PEAK_DB, -60, -0.1), 2),
      deterministic: true,
    },
  }
}

// ---------------------------------------------------------------------------
// 峰值滞后测量（S5 音画对齐）
// ---------------------------------------------------------------------------

/**
 * 测量音效的能量峰相对文件头的位置。
 *
 * 为什么需要它：impact/click 的峰在文件头，但 riser/reverse-swell 这类
 * 渐强音效的峰在尾部。若按"文件头对齐目标帧"放置，听感会整体提前。
 * 上层应当用 `from = 目标峰值帧 − peakSeconds*fps − 输出偏移帧` 放置。
 *
 * 算法：5 ms 窗口 / 1 ms 步长的短时能量包络，取最大窗口并做抛物插值，
 * 得到亚毫秒级的峰值位置（能量峰更贴近听感，比单采样点峰值稳定）。
 * 头部/尾部窗口都会参与，因此渐强音效的尾部峰不会被截掉。
 *
 * @param {ArrayLike<number>} samples
 * @param {number} [sampleRate]
 * @returns {{peakIndex: number, peakSeconds: number, peakFraction: number}}
 */
export function measureSfxPeakLag(samples, sampleRate = SFX_DEFAULT_SAMPLE_RATE) {
  const count = samples?.length ?? 0
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Number(sampleRate) : SFX_DEFAULT_SAMPLE_RATE
  if (count === 0) return { peakIndex: 0, peakSeconds: 0, peakFraction: 0 }

  // 前缀平方和 → O(n) 得到任意窗口能量，避免逐窗 O(n·window)。
  const prefix = new Float64Array(count + 1)
  for (let i = 0; i < count; i += 1) {
    const value = Number.isFinite(samples[i]) ? samples[i] : 0
    prefix[i + 1] = prefix[i] + value * value
  }
  if (!(prefix[count] > 1e-12)) return { peakIndex: 0, peakSeconds: 0, peakFraction: 0 }

  const windowSize = Math.max(8, Math.min(count, Math.round(rate * 0.005)))
  const hop = Math.max(1, Math.round(rate * 0.001))
  const starts = []
  const energies = []
  for (let start = 0; start + windowSize <= count; start += hop) {
    starts.push(start)
    energies.push(prefix[start + windowSize] - prefix[start])
  }
  // 补一个贴住文件尾的窗口：渐强音效的峰就在最后几毫秒。
  const lastStart = starts.length > 0 ? starts[starts.length - 1] : -1
  if (count > windowSize && lastStart + windowSize < count) {
    starts.push(count - windowSize)
    energies.push(prefix[count] - prefix[count - windowSize])
  }

  let best = 0
  for (let i = 1; i < energies.length; i += 1) if (energies[i] > energies[best]) best = i
  // 噪声颗粒类音效的短时能量有抖动，3 点滑动平均让峰值位置更稳定。
  const smoothed = movingAverage(Float64Array.from(energies), 3)
  best = 0
  for (let i = 1; i < smoothed.length; i += 1) if (smoothed[i] > smoothed[best]) best = i
  let offset = 0
  if (best > 0 && best < smoothed.length - 1) {
    const before = smoothed[best - 1]
    const centre = smoothed[best]
    const after = smoothed[best + 1]
    const denominator = before - 2 * centre + after
    if (Math.abs(denominator) > 1e-18) offset = clamp((0.5 * (before - after)) / denominator, -1, 1)
  }
  const refined = clamp(starts[best] + windowSize / 2 + offset * hop, 0, count - 1)
  // 抛物插值只用来选样本：三个返回值统一以同一个样本索引为准，保证
  // peakSeconds / peakFraction 与 peakIndex 完全自洽（采样精度已远高于帧精度）。
  const peakIndex = Math.round(refined)
  return {
    peakIndex,
    peakSeconds: roundTo(peakIndex / rate, 6),
    peakFraction: roundTo(count > 1 ? peakIndex / count : 0, 6),
  }
}

// ---------------------------------------------------------------------------
// WAV 编码 / 写盘
// ---------------------------------------------------------------------------

/**
 * 16-bit PCM 单声道 WAV 编码器。
 *
 * 采样先夹到 [−1, 1] 再乘 32767：超范围输入只会被削成满刻度，不会回卷成
 * 反向爆音。`opts.gainDb` 可在编码前施加一个增益（仍会夹限）。
 *
 * @param {ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {{gainDb?: number}} [opts]
 * @returns {Buffer}
 */
export function encodeWav(samples, sampleRate, opts = {}) {
  const rate = normaliseSampleRate(sampleRate, 'encodeWav')
  const list = samples ?? []
  const count = list.length ?? 0
  const gain = dbToGain(Number.isFinite(opts.gainDb) ? clamp(opts.gainDb, -60, 60) : 0)
  const dataBytes = count * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'latin1')
  buffer.write('fmt ', 12, 'latin1')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28) // byte rate = rate * blockAlign
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36, 'latin1')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < count; i += 1) {
    const raw = Number.isFinite(list[i]) ? list[i] * gain : 0
    const clamped = raw < -1 ? -1 : raw > 1 ? 1 : raw
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2)
  }
  return buffer
}

/**
 * 把样本写成一个 16-bit PCM 单声道 WAV。
 *
 * opts.peakDb 给出时，会先复制一份并归一化到该峰值（默认不重新归一化：
 * synthesizeSfx 的输出已经按 −1 dBFS 归一化过）。返回的 peakDb 是实际
 * 写入文件的峰值，便于上层做混音增益决策。
 *
 * @param {string} filePath
 * @param {ArrayLike<number>} samples
 * @param {number} [sampleRate]
 * @param {{peakDb?: number, gainDb?: number}} [opts]
 * @returns {Promise<{path: string, bytes: number, duration: number, peakDb: number}>}
 */
export async function writeSfxWav(filePath, samples, sampleRate, opts = {}) {
  const rate = normaliseSampleRate(sampleRate, 'writeSfxWav')
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('writeSfxWav: filePath 必须是非空字符串')
  }
  const list = samples ?? []
  let payload = list
  if (Number.isFinite(opts.peakDb)) {
    const copy = Float64Array.from(list, (value) => (Number.isFinite(value) ? value : 0))
    normalisePeak(copy, opts.peakDb)
    payload = copy
  }
  const buffer = encodeWav(payload, rate, { gainDb: opts.gainDb })
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, buffer)
  const peak = peakAbs(payload)
  return {
    path: filePath,
    bytes: buffer.length,
    duration: roundTo((payload.length ?? 0) / rate, 6),
    peakDb: roundTo(gainToDb(peak), 2),
  }
}

// ---------------------------------------------------------------------------
// 连发调度（S2 防机枪感）
// ---------------------------------------------------------------------------

/** 双样本交替的默认配对：同一质感但音高/材质不同，避免听感重复。 */
const ALTERNATE_KIND = Object.freeze({
  whoosh: 'swoosh',
  swoosh: 'whoosh',
  impact: 'sub-drop',
  'sub-drop': 'impact',
  riser: 'reverse-swell',
  'reverse-swell': 'riser',
  sparkle: 'shimmer',
  shimmer: 'sparkle',
  click: 'key',
  key: 'click',
  switch: 'click',
  paper: 'grain',
  grain: 'paper',
  pop: 'click',
  shutter: 'switch',
  glass: 'sparkle',
  glitch: 'grain',
})

const LOCAL_EASINGS = Object.freeze({
  linear: (t) => t,
  ease: (t) => t * t * (3 - 2 * t),
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  easeInCubic: (t) => t ** 3,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - 4 * (1 - t) ** 3),
  easeInQuart: (t) => t ** 4,
  easeOutQuart: (t) => 1 - (1 - t) ** 4,
  easeInExpo: (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  easeOutExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  'ease-in': (t) => t * t,
  'ease-out': (t) => 1 - (1 - t) * (1 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  'power2.in': (t) => t * t,
  'power2.out': (t) => 1 - (1 - t) * (1 - t),
  'power2.inOut': (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  'power3.in': (t) => t ** 3,
  'power3.out': (t) => 1 - (1 - t) ** 3,
  'expo.in': (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  'expo.out': (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
})

function resolveEasing(name) {
  if (typeof name === 'function') return name
  if (typeof name !== 'string') return LOCAL_EASINGS.easeInQuad
  return LOCAL_EASINGS[name] ?? LOCAL_EASINGS.easeInQuad
}

/** 音量阶梯：数字=每级递减量；数组=逐级取值；对象={from,to}；缺省 −0.12/级。 */
function buildVolumes(count, ladder) {
  const volumes = []
  if (Array.isArray(ladder) && ladder.length > 0) {
    for (let i = 0; i < count; i += 1) volumes.push(clamp(Number(ladder[Math.min(i, ladder.length - 1)]) || 0, 0, 1))
    return volumes
  }
  if (ladder && typeof ladder === 'object') {
    const from = clamp(Number.isFinite(ladder.from) ? ladder.from : 1, 0, 1)
    const to = clamp(Number.isFinite(ladder.to) ? ladder.to : 0.4, 0, 1)
    const easing = resolveEasing(ladder.ease)
    for (let i = 0; i < count; i += 1) {
      const progress = count > 1 ? i / (count - 1) : 0
      volumes.push(roundTo(clamp(from + (to - from) * easing(progress), 0, 1), 3))
    }
    return volumes
  }
  if (Number.isFinite(ladder) && ladder > 0) {
    for (let i = 0; i < count; i += 1) volumes.push(roundTo(clamp(1 - i * ladder, 0.05, 1), 3))
    return volumes
  }
  for (let i = 0; i < count; i += 1) volumes.push(roundTo(clamp(1 - i * 0.12, 0.35, 1), 3))
  return volumes
}

/**
 * 间隔序列：数组=[8,5,3] 逐条取（用尽后重复末值）；对象={from,to,ease} 按缓动
 * 从 from 加速到 to；数字=固定间隔；缺省 88→30 ms 的 easeInQuad（越来越密）。
 */
function buildGaps(count, interval, easeName) {
  const gapCount = Math.max(0, count - 1)
  const gaps = []
  if (Array.isArray(interval) && interval.length > 0) {
    for (let i = 0; i < gapCount; i += 1) gaps.push(Math.max(1, Number(interval[Math.min(i, interval.length - 1)]) || 1))
    return gaps
  }
  if (interval && typeof interval === 'object') {
    const from = Math.max(1, Number.isFinite(interval.from) ? interval.from : 90)
    const to = Math.max(1, Number.isFinite(interval.to) ? interval.to : 30)
    const easing = resolveEasing(interval.ease ?? easeName)
    for (let i = 0; i < gapCount; i += 1) {
      const progress = gapCount > 1 ? i / (gapCount - 1) : 0
      gaps.push(Math.max(1, from + (to - from) * easing(progress)))
    }
    return gaps
  }
  if (Number.isFinite(interval) && interval > 0) {
    for (let i = 0; i < gapCount; i += 1) gaps.push(interval)
    return gaps
  }
  const easing = resolveEasing(easeName ?? 'easeInQuad')
  for (let i = 0; i < gapCount; i += 1) {
    const progress = gapCount > 1 ? i / (gapCount - 1) : 0
    gaps.push(Math.max(1, 88 + (30 - 88) * easing(progress)))
  }
  return gaps
}

/**
 * 生成一串"连发"音效的调度表（S2 防机枪感）。
 *
 * 三个手段一起用，避免同一个音效密集重复时的机械感：
 * 1. 双样本交替：`kind` 与一个同质感、不同音色的伙伴交替（如 click/key）；
 * 2. 音量阶梯递减：越往后越轻（默认每级 −0.12，最低 0.35）；
 * 3. 间隔缓动加速：默认 88→30 ms 的 easeInQuad，形成"哒-哒哒-哒哒哒"的加速。
 *
 * @param {number} count 事件数，1..64
 * @param {object} [opts]
 * @param {string} [opts.kind='click'] 主音色
 * @param {boolean} [opts.alternate=true] 是否双样本交替
 * @param {string} [opts.alternateKind] 指定交替音色（否则用内置配对表）
 * @param {string[]} [opts.kinds] 直接给出轮换序列（优先于 kind/alternate）
 * @param {number} [opts.startMs=0] 第一个事件的偏移（毫秒）
 * @param {number} [opts.startSeconds] 第一个事件的偏移（秒）；给出时优先于 startMs，
 *        便于上层直接把调度表对上时间线（media_sfx 的 start_seconds 走这里）
 * @param {number|number[]|{from:number,to:number,ease?:string}} [opts.interval] 间隔
 * @param {number|number[]|{from:number,to:number}} [opts.volumeLadder] 音量阶梯
 * @param {string} [opts.ease] 默认缓动名（供 interval 使用）
 * @param {number|string} [opts.seed] 保留字段：本函数纯确定，不消费随机数
 * @returns {Array<{index: number, kind: string, volume: number, offsetMs: number, atSeconds: number}>}
 */
export function sequenceSfx(count, opts = {}) {
  const total = Number(count)
  if (!Number.isInteger(total) || total < 1 || total > MAX_SEQUENCE_EVENTS) {
    throw new Error(`sequenceSfx: count 必须为 1..${MAX_SEQUENCE_EVENTS} 的整数，收到 ${String(count)}`)
  }
  let kinds
  if (Array.isArray(opts.kinds) && opts.kinds.length > 0) {
    kinds = opts.kinds.map((kind) => normaliseKind(kind, 'sequenceSfx'))
  } else {
    const primary = normaliseKind(opts.kind ?? 'click', 'sequenceSfx')
    if (opts.alternate === false) {
      kinds = [primary]
    } else {
      const alternate = opts.alternateKind !== undefined ? normaliseKind(opts.alternateKind, 'sequenceSfx') : ALTERNATE_KIND[primary] ?? primary
      kinds = [primary, alternate]
    }
  }
  const startMs = Number.isFinite(opts.startSeconds)
    ? Math.max(0, Number(opts.startSeconds) * 1000)
    : Math.max(0, Number.isFinite(opts.startMs) ? opts.startMs : 0)
  const volumes = buildVolumes(total, opts.volumeLadder)
  const gaps = buildGaps(total, opts.interval, opts.ease)

  const events = []
  let offsetMs = startMs
  for (let i = 0; i < total; i += 1) {
    const roundedOffset = roundTo(offsetMs, 2)
    events.push({
      index: i,
      kind: kinds[i % kinds.length],
      volume: volumes[i],
      offsetMs: roundedOffset,
      atSeconds: roundTo(roundedOffset / 1000, 4),
    })
    if (i < total - 1) offsetMs += gaps[i]
  }
  return events
}

export default {
  SFX_KINDS,
  SFX_PALETTE,
  synthesizeSfx,
  measureSfxPeakLag,
  encodeWav,
  writeSfxWav,
  sequenceSfx,
}
