/**
 * test/sfx.test.mjs — 程序化音效合成（lib/sfx.js）验收测试。
 *
 * 覆盖四类风险：
 *  1. 调色板完整性：17 种音色的身份/时长区间/适用动作/合成参数是否齐全；
 *  2. 音频质量：确定性（逐字节可复现）、−1 dBFS 归一化、不削波、
 *     各音色的频谱特征（impact 的低频重量、sparkle 的高频颗粒、riser 的上行）；
 *  3. S5 音画对齐：measureSfxPeakLag 对已知延后峰值的信号是否算准；
 *  4. S2 防机枪感：sequenceSfx 的双样本交替、音量阶梯、间隔加速；
 *     以及 WAV 编码/写盘的字节级正确性。
 *
 * 跑法：node test/sfx.test.mjs   （全绿时退出码 0，否则 1）
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sfxDefault, {
  SFX_DEFAULT_SAMPLE_RATE,
  SFX_KINDS,
  SFX_PALETTE,
  encodeWav,
  measureSfxPeakLag,
  sequenceSfx,
  synthesizeSfx,
  writeSfxWav,
} from '../lib/sfx.js'
import { bandEnergy, frameMagnitudes, hann } from '../lib/dsp.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REQUIRED_KINDS = [
  'whoosh', 'impact', 'riser', 'sparkle', 'swoosh',
  'click', 'switch', 'paper', 'key', 'pop', 'shutter', 'glass', 'grain',
  'sub-drop', 'shimmer', 'reverse-swell', 'glitch',
]
const FAMILIES = new Set(['cinematic', 'foley', 'design'])

let passed = 0
const failures = []
const scratch = await mkdtemp(join(tmpdir(), 'sfx-test-'))

/** 逐项断言：失败只记一条，不中断后面的测试。 */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

function peakOf(samples) {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i])
    if (value > peak) peak = value
  }
  return peak
}

function rmsOf(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

function dbOf(value) {
  return value > 0 ? 20 * Math.log10(value) : -Infinity
}

/** 聚合一段音频的功率谱（用 Hann 窗、4096 点 FFT，多帧平均）。 */
function aggregatePower(samples, sampleRate, nFft = 4096, maxSeconds = 1e9) {
  const window = hann(nFft)
  const power = new Float64Array(nFft / 2 + 1)
  const limit = Math.min(samples.length, Math.round(maxSeconds * sampleRate))
  let frames = 0
  for (let start = 0; start + nFft <= limit; start += nFft / 2) {
    const frame = Float64Array.from(samples.subarray(start, start + nFft))
    const magnitudes = frameMagnitudes(frame, window)
    for (let k = 0; k < magnitudes.length; k += 1) power[k] += magnitudes[k] * magnitudes[k]
    frames += 1
  }
  if (frames > 1) for (let k = 0; k < power.length; k += 1) power[k] /= frames
  return { power, nFft }
}

/** 某频段能量占比。 */
function bandShare(samples, sampleRate, lowHz, highHz, maxSeconds = 1e9) {
  const { power, nFft } = aggregatePower(samples, sampleRate, 4096, maxSeconds)
  const { band, total } = bandEnergy(power, sampleRate, nFft, lowHz, highHz)
  return total > 1e-20 ? band / total : 0
}

/** 频谱质心（Hz）。 */
function centroidOf(samples, sampleRate, fromSec, toSec) {
  const nFft = 4096
  const window = hann(nFft)
  const power = new Float64Array(nFft / 2 + 1)
  const from = Math.max(0, Math.round(fromSec * sampleRate))
  const to = Math.min(samples.length, Math.round(toSec * sampleRate))
  let frames = 0
  for (let start = from; start + nFft <= to; start += nFft / 2) {
    const frame = Float64Array.from(samples.subarray(start, start + nFft))
    const magnitudes = frameMagnitudes(frame, window)
    for (let k = 0; k < magnitudes.length; k += 1) power[k] += magnitudes[k] * magnitudes[k]
    frames += 1
  }
  if (frames === 0) return 0
  let weighted = 0
  let total = 0
  for (let k = 1; k < power.length; k += 1) {
    const frequency = (k * sampleRate) / nFft
    weighted += frequency * power[k]
    total += power[k]
  }
  return total > 0 ? weighted / total : 0
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 生成已知峰值位置的高斯包络正弦：用来验证 measureSfxPeakLag 的精度。 */
function gaussianBurst({ sampleRate, seconds, peakAt, width, frequency }) {
  const samples = new Float32Array(Math.round(sampleRate * seconds))
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / sampleRate
    samples[i] = 0.5 * Math.sin(2 * Math.PI * frequency * t) * Math.exp(-0.5 * ((t - peakAt) / width) ** 2)
  }
  return samples
}

try {
  // -------------------------------------------------------------------------
  // 1. 调色板 / 导出面
  // -------------------------------------------------------------------------

  await check('SFX_KINDS 暴露契约要求的 17 种音色且无重复', () => {
    assert.ok(Array.isArray(SFX_KINDS))
    for (const kind of REQUIRED_KINDS) assert.ok(SFX_KINDS.includes(kind), `缺少音色 ${kind}`)
    assert.equal(new Set(SFX_KINDS).size, SFX_KINDS.length, '音色名有重复')
    assert.ok(SFX_KINDS.length >= 17, `只有 ${SFX_KINDS.length} 种`)
  })

  await check('SFX_PALETTE 每个音色字段完整、时长区间合法', () => {
    for (const kind of SFX_KINDS) {
      const entry = SFX_PALETTE[kind]
      assert.ok(entry !== undefined, `${kind} 缺调色板条目`)
      assert.equal(typeof entry.zh, 'string', `${kind}.zh`)
      assert.ok(entry.zh.length > 0, `${kind}.zh 为空`)
      assert.ok(FAMILIES.has(entry.family), `${kind}.family 非法: ${entry.family}`)
      assert.ok(Array.isArray(entry.duration) && entry.duration.length === 2, `${kind}.duration`)
      assert.ok(entry.duration[0] > 0 && entry.duration[1] > entry.duration[0], `${kind}.duration 区间非法`)
      assert.equal(typeof entry.actionZh, 'string', `${kind}.actionZh`)
      assert.ok(entry.actionZh.length >= 4, `${kind}.actionZh 太短`)
      assert.ok(entry.params && typeof entry.params === 'object', `${kind}.params`)
      assert.ok(entry.params.defaultDuration >= entry.duration[0] && entry.params.defaultDuration <= entry.duration[1], `${kind} 默认时长越界`)
    }
  })

  await check('电影五词与拟音两族齐全（cinematic + foley）', () => {
    const cinematic = SFX_KINDS.filter((kind) => SFX_PALETTE[kind].family === 'cinematic')
    const foley = SFX_KINDS.filter((kind) => SFX_PALETTE[kind].family === 'foley')
    for (const kind of ['whoosh', 'impact', 'riser', 'sparkle', 'swoosh']) assert.ok(cinematic.includes(kind))
    for (const kind of ['click', 'switch', 'paper', 'key', 'pop', 'shutter', 'glass', 'grain']) assert.ok(foley.includes(kind))
    assert.ok(SFX_KINDS.filter((kind) => SFX_PALETTE[kind].family === 'design').length >= 4)
  })

  await check('SFX_DEFAULT_SAMPLE_RATE = 48000', () => {
    assert.equal(SFX_DEFAULT_SAMPLE_RATE, 48000)
  })

  await check('default export 暴露契约列出的 7 个成员', () => {
    for (const key of ['SFX_KINDS', 'SFX_PALETTE', 'synthesizeSfx', 'measureSfxPeakLag', 'encodeWav', 'writeSfxWav', 'sequenceSfx']) {
      assert.ok(sfxDefault[key] !== undefined, `default export 缺 ${key}`)
    }
    assert.equal(typeof sfxDefault.synthesizeSfx, 'function')
  })

  // -------------------------------------------------------------------------
  // 2. 合成质量
  // -------------------------------------------------------------------------

  await check('synthesizeSfx：Float32Array / 48 kHz / 单声道样本数一致', () => {
    const result = synthesizeSfx('whoosh')
    assert.ok(result.samples instanceof Float32Array)
    assert.equal(result.sampleRate, 48000)
    assert.equal(result.samples.length, Math.round(result.duration * 48000))
    assert.ok(result.meta && result.meta.kind === 'whoosh')
    assert.equal(result.meta.sampleRate, 48000)
    assert.equal(typeof result.meta.deterministic, 'boolean')
  })

  await check('17 种音色全部可合成：无 NaN/Infinity、非静音、值域合法', () => {
    for (const kind of SFX_KINDS) {
      const { samples } = synthesizeSfx(kind)
      assert.ok(samples.length > 0, `${kind} 空音频`)
      let peak = 0
      let sum = 0
      for (let i = 0; i < samples.length; i += 1) {
        const value = samples[i]
        assert.ok(Number.isFinite(value), `${kind}[${i}] 非有限值`)
        assert.ok(Math.abs(value) <= 1, `${kind}[${i}] 超出 ±1`)
        peak = Math.max(peak, Math.abs(value))
        sum += value * value
      }
      const rms = Math.sqrt(sum / samples.length)
      assert.ok(peak > 0.5, `${kind} 峰值过低 ${peak}`)
      assert.ok(rms > 0.01, `${kind} 近似静音 rms=${rms}`)
    }
  })

  await check('默认时长落在 palette.duration 区间内', () => {
    for (const kind of SFX_KINDS) {
      const result = synthesizeSfx(kind)
      const [min, max] = SFX_PALETTE[kind].duration
      assert.ok(result.duration >= min - 0.001 && result.duration <= max + 0.001, `${kind} 时长 ${result.duration} 越界 [${min},${max}]`)
    }
  })

  await check('默认峰值归一化到 −1 dBFS（±0.15）且不削波（≤0.9）', () => {
    for (const kind of SFX_KINDS) {
      const { samples } = synthesizeSfx(kind)
      const peak = peakOf(samples)
      const db = dbOf(peak)
      assert.ok(Math.abs(db + 1) <= 0.15, `${kind} 峰值 ${db.toFixed(2)} dBFS`)
      assert.ok(peak <= 0.9, `${kind} 峰值 ${peak} 有削波风险`)
    }
  })

  await check('opts.peakDb=−6 生效', () => {
    const { samples } = synthesizeSfx('click', { peakDb: -6 })
    assert.ok(Math.abs(dbOf(peakOf(samples)) + 6) <= 0.15)
  })

  await check('opts.duration：riser 可配 3 s，越界被夹到 palette 区间', () => {
    const long = synthesizeSfx('riser', { duration: 3 })
    assert.ok(Math.abs(long.duration - 3) <= 0.01, `riser 3s -> ${long.duration}`)
    const capped = synthesizeSfx('click', { duration: 999 })
    assert.ok(capped.duration <= SFX_PALETTE.click.duration[1] + 0.001, `click 上限夹取失败: ${capped.duration}`)
    const floored = synthesizeSfx('whoosh', { duration: 0.001 })
    assert.ok(floored.duration >= SFX_PALETTE.whoosh.duration[0] - 0.001, `whoosh 下限夹取失败: ${floored.duration}`)
  })

  await check('opts.sampleRate=44100 生效且样本数一致', () => {
    const result = synthesizeSfx('impact', { sampleRate: 44100 })
    assert.equal(result.sampleRate, 44100)
    assert.equal(result.samples.length, Math.round(result.duration * 44100))
    assert.ok(Math.abs(result.duration - 1) <= 0.01)
  })

  await check('opts.params 覆盖生效（同音色不同参数波形不同）', () => {
    const a = synthesizeSfx('click')
    const b = synthesizeSfx('click', { params: { tickHz: 5200 } })
    assert.notEqual(Buffer.compare(Buffer.from(a.samples.buffer), Buffer.from(b.samples.buffer)), 0)
  })

  await check('非法音色报错可读（包含音色名与可用清单）', () => {
    assert.throws(() => synthesizeSfx('laser'), /laser/u)
    assert.throws(() => synthesizeSfx('laser'), /whoosh/u)
    assert.throws(() => synthesizeSfx(''), /音色名/u)
  })

  await check('opts.duration 非正数 / 非数字报错可读', () => {
    assert.throws(() => synthesizeSfx('click', { duration: 0 }), /duration/u)
    assert.throws(() => synthesizeSfx('click', { duration: -1 }), /duration/u)
    assert.throws(() => synthesizeSfx('click', { duration: Number.NaN }), /duration/u)
  })

  // -------------------------------------------------------------------------
  // 3. 确定性（可复现铁律）
  // -------------------------------------------------------------------------

  await check('确定性：同参数两次合成逐字节一致', () => {
    for (const kind of ['whoosh', 'sparkle', 'glitch', 'paper']) {
      const a = synthesizeSfx(kind, { seed: 7 })
      const b = synthesizeSfx(kind, { seed: 7 })
      assert.equal(Buffer.compare(Buffer.from(a.samples.buffer), Buffer.from(b.samples.buffer)), 0, `${kind} 两次结果不同`)
    }
  })

  await check('确定性：不同 seed 波形不同，同 seed 可复现', () => {
    const a = synthesizeSfx('sparkle', { seed: 1 })
    const b = synthesizeSfx('sparkle', { seed: 2 })
    const c = synthesizeSfx('sparkle', { seed: 2 })
    assert.notEqual(Buffer.compare(Buffer.from(a.samples.buffer), Buffer.from(b.samples.buffer)), 0, '不同 seed 居然一样')
    assert.equal(Buffer.compare(Buffer.from(b.samples.buffer), Buffer.from(c.samples.buffer)), 0, '同 seed 不可复现')
  })

  await check('源码不含全局随机 / 时间源（离线可复现铁律）', async () => {
    const source = await readFile(join(HERE, '../lib/sfx.js'), 'utf8')
    assert.ok(!/Math\.random\s*\(/u.test(source), '出现 Math.random')
    assert.ok(!/Date\.now\s*\(/u.test(source), '出现 Date.now')
    assert.ok(!/performance\.now\s*\(/u.test(source), '出现 performance.now')
    assert.ok(/mulberry32/u.test(source), '应使用 seeded mulberry32')
  })

  // -------------------------------------------------------------------------
  // 4. measureSfxPeakLag（S5 音画对齐的关键）
  // -------------------------------------------------------------------------

  await check('measureSfxPeakLag：已知 0.7 s 高斯包络峰，误差 < 8 ms', () => {
    const sampleRate = 48000
    const samples = gaussianBurst({ sampleRate, seconds: 2, peakAt: 0.7, width: 0.06, frequency: 440 })
    const lag = measureSfxPeakLag(samples, sampleRate)
    assert.ok(Math.abs(lag.peakSeconds - 0.7) < 0.008, `峰值 ${lag.peakSeconds}s，期望 0.7s`)
    assert.ok(Math.abs(lag.peakFraction - 0.7 / 2) < 0.005, `peakFraction ${lag.peakFraction}`)
    assert.ok(Number.isInteger(lag.peakIndex) && lag.peakIndex > 0)
    assert.ok(Math.abs(lag.peakIndex / sampleRate - lag.peakSeconds) < 1e-6)
  })

  await check('measureSfxPeakLag：impact/click 的能量峰在文件头', () => {
    for (const kind of ['impact', 'click', 'key', 'glass', 'sub-drop']) {
      const { samples, sampleRate } = synthesizeSfx(kind)
      const lag = measureSfxPeakLag(samples, sampleRate)
      assert.ok(lag.peakFraction < 0.2, `${kind} 峰值在 ${lag.peakFraction}（应在头部）`)
    }
  })

  await check('measureSfxPeakLag：riser 的能量峰在尾部（渐强攻击）', () => {
    const { samples, sampleRate } = synthesizeSfx('riser', { duration: 2 })
    const lag = measureSfxPeakLag(samples, sampleRate)
    assert.ok(lag.peakFraction > 0.9, `riser 峰值在 ${lag.peakFraction}（应在尾部）`)
    assert.ok(Math.abs(lag.peakSeconds - 2) < 0.05)
  })

  await check('measureSfxPeakLag：reverse-swell 的峰在尾部', () => {
    const { samples, sampleRate } = synthesizeSfx('reverse-swell')
    const lag = measureSfxPeakLag(samples, sampleRate)
    assert.ok(lag.peakFraction > 0.9, `reverse-swell 峰值在 ${lag.peakFraction}`)
  })

  await check('measureSfxPeakLag：whoosh 的能量峰落在中段', () => {
    const { samples, sampleRate } = synthesizeSfx('whoosh')
    const lag = measureSfxPeakLag(samples, sampleRate)
    assert.ok(lag.peakFraction > 0.2 && lag.peakFraction < 0.75, `whoosh 峰值在 ${lag.peakFraction}`)
  })

  await check('measureSfxPeakLag：空信号 / 静音返回有限零值', () => {
    const empty = measureSfxPeakLag(new Float32Array(0), 48000)
    assert.deepEqual({ ...empty }, { peakIndex: 0, peakSeconds: 0, peakFraction: 0 })
    const silent = measureSfxPeakLag(new Float32Array(4800), 48000)
    assert.deepEqual({ ...silent }, { peakIndex: 0, peakSeconds: 0, peakFraction: 0 })
    for (const value of Object.values(empty)) assert.ok(Number.isFinite(value))
  })

  await check('measureSfxPeakLag：96 kHz 采样率同样可用', () => {
    const sampleRate = 96000
    const samples = gaussianBurst({ sampleRate, seconds: 1.5, peakAt: 0.5, width: 0.05, frequency: 440 })
    const lag = measureSfxPeakLag(samples, sampleRate)
    assert.ok(Math.abs(lag.peakSeconds - 0.5) < 0.01, `峰值 ${lag.peakSeconds}s`)
    assert.ok(lag.peakFraction > 0.3 && lag.peakFraction < 0.4)
  })

  // -------------------------------------------------------------------------
  // 5. sequenceSfx（S2 防机枪感）
  // -------------------------------------------------------------------------

  await check('sequenceSfx：字段齐全、index 连续、atSeconds 与 offsetMs 一致', () => {
    const events = sequenceSfx(5)
    assert.equal(events.length, 5)
    events.forEach((event, index) => {
      assert.equal(event.index, index)
      assert.equal(typeof event.kind, 'string')
      assert.ok(SFX_KINDS.includes(event.kind), `未知音色 ${event.kind}`)
      assert.ok(event.volume >= 0 && event.volume <= 1)
      assert.ok(Number.isFinite(event.offsetMs) && event.offsetMs >= 0)
      assert.ok(Math.abs(event.atSeconds - event.offsetMs / 1000) < 1e-3)
    })
  })

  await check('sequenceSfx：双样本交替（click ↔ key）', () => {
    const events = sequenceSfx(6, { kind: 'click' })
    assert.equal(events[0].kind, 'click')
    assert.notEqual(events[1].kind, 'click', '第二个事件没有换样本')
    assert.equal(events[2].kind, events[0].kind)
    assert.equal(events[3].kind, events[1].kind)
    const single = sequenceSfx(3, { kind: 'click', alternate: false })
    assert.ok(single.every((event) => event.kind === 'click'))
    const explicit = sequenceSfx(4, { kind: 'whoosh', alternateKind: 'impact' })
    assert.deepEqual(explicit.map((event) => event.kind), ['whoosh', 'impact', 'whoosh', 'impact'])
  })

  await check('sequenceSfx：音量阶梯默认逐级递减', () => {
    const events = sequenceSfx(5, { kind: 'click' })
    const volumes = events.map((event) => event.volume)
    assert.equal(volumes[0], 1)
    for (let i = 1; i < volumes.length; i += 1) assert.ok(volumes[i] <= volumes[i - 1], `音量没有递减: ${volumes.join(',')}`)
    assert.ok(volumes[volumes.length - 1] < volumes[0])
  })

  await check('sequenceSfx：interval=[8,5,3] 加速且偏移正确', () => {
    const events = sequenceSfx(6, { kind: 'click', interval: [8, 5, 3] })
    const offsets = events.map((event) => event.offsetMs)
    assert.deepEqual(offsets.map((value) => Math.round(value)), [0, 8, 13, 16, 19, 22])
    const gaps = []
    for (let i = 1; i < offsets.length; i += 1) gaps.push(offsets[i] - offsets[i - 1])
    // 前三个间隔按数组走，之后重复末值 3
    assert.deepEqual(gaps.map((value) => Math.round(value)), [8, 5, 3, 3, 3])
    assert.ok(gaps[gaps.length - 1] < gaps[0], '连发没有加速')
  })

  await check('sequenceSfx：interval={from,to,ease} 单调加速', () => {
    const events = sequenceSfx(8, { kind: 'click', interval: { from: 120, to: 40, ease: 'easeInQuad' } })
    const gaps = []
    for (let i = 1; i < events.length; i += 1) gaps.push(events[i].offsetMs - events[i - 1].offsetMs)
    for (let i = 1; i < gaps.length; i += 1) assert.ok(gaps[i] <= gaps[i - 1] + 1e-6, `间隔未单调递减: ${gaps.join(',')}`)
    assert.ok(Math.abs(gaps[0] - 120) < 0.5)
    assert.ok(Math.abs(gaps[gaps.length - 1] - 40) < 0.5)
  })

  await check('sequenceSfx：startMs 与 volumeLadder 数组生效', () => {
    const delayed = sequenceSfx(3, { startMs: 250 })
    assert.equal(delayed[0].offsetMs, 250)
    assert.equal(delayed[1].offsetMs > 250, true)
    // 上层（media_sfx 的 start_seconds）用秒做绝对起点，必须等价于 ms。
    const inSeconds = sequenceSfx(3, { startSeconds: 1.5 })
    assert.equal(inSeconds[0].offsetMs, 1500)
    assert.equal(inSeconds[0].atSeconds, 1.5)
    assert.equal(inSeconds[1].offsetMs - inSeconds[0].offsetMs, delayed[1].offsetMs - delayed[0].offsetMs)
    const ladder = sequenceSfx(4, { volumeLadder: [1, 0.8, 0.6] })
    assert.deepEqual(ladder.map((event) => event.volume), [1, 0.8, 0.6, 0.6])
    const shaped = sequenceSfx(3, { volumeLadder: { from: 1, to: 0.4 } })
    assert.ok(Math.abs(shaped[0].volume - 1) < 1e-6 && Math.abs(shaped[2].volume - 0.4) < 1e-6)
  })

  await check('sequenceSfx：count 非法报错可读、count=1 正常', () => {
    assert.throws(() => sequenceSfx(0), /count/u)
    assert.throws(() => sequenceSfx(-2), /count/u)
    assert.throws(() => sequenceSfx(65), /count/u)
    assert.throws(() => sequenceSfx(1.5), /count/u)
    const single = sequenceSfx(1)
    assert.equal(single.length, 1)
    assert.equal(single[0].offsetMs, 0)
    assert.equal(single[0].atSeconds, 0)
    assert.throws(() => sequenceSfx(3, { kind: 'laser' }), /laser/u)
  })

  // -------------------------------------------------------------------------
  // 6. WAV 编码 / 写盘
  // -------------------------------------------------------------------------

  await check('encodeWav：RIFF/WAVE/fmt/data 头合法（PCM mono 16-bit）', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1])
    const buffer = encodeWav(samples, 48000)
    assert.equal(buffer.length, 44 + samples.length * 2)
    assert.equal(buffer.toString('latin1', 0, 4), 'RIFF')
    assert.equal(buffer.readUInt32LE(4), 36 + samples.length * 2)
    assert.equal(buffer.toString('latin1', 8, 12), 'WAVE')
    assert.equal(buffer.toString('latin1', 12, 16), 'fmt ')
    assert.equal(buffer.readUInt16LE(20), 1, '不是 PCM')
    assert.equal(buffer.readUInt16LE(22), 1, '不是单声道')
    assert.equal(buffer.readUInt32LE(24), 48000)
    assert.equal(buffer.readUInt32LE(28), 96000)
    assert.equal(buffer.readUInt16LE(32), 2)
    assert.equal(buffer.readUInt16LE(34), 16)
    assert.equal(buffer.toString('latin1', 36, 40), 'data')
    assert.equal(buffer.readUInt32LE(40), samples.length * 2)
  })

  await check('encodeWav：量化正确，超范围夹限不回卷', () => {
    const samples = new Float32Array([0, 0.25, -0.25, 1.5, -1.5, 0.999])
    const buffer = encodeWav(samples, 48000)
    const values = []
    for (let i = 0; i < samples.length; i += 1) values.push(buffer.readInt16LE(44 + i * 2))
    assert.equal(values[0], 0)
    assert.equal(values[1], Math.round(0.25 * 32767))
    assert.equal(values[2], Math.round(-0.25 * 32767))
    assert.equal(values[3], 32767, '正超限应削到满刻度')
    assert.equal(values[4], -32767, '负超限应削到满刻度')
    for (const value of values) assert.ok(value >= -32768 && value <= 32767, `PCM 值越界 ${value}`)
  })

  await check('encodeWav：非法 sampleRate 报错可读', () => {
    assert.throws(() => encodeWav(new Float32Array(10), 0), /sampleRate/u)
    assert.throws(() => encodeWav(new Float32Array(10), Number.NaN), /sampleRate/u)
    assert.throws(() => encodeWav(new Float32Array(10), 999999), /sampleRate/u)
  })

  await check('writeSfxWav：写盘返回 path/bytes/duration/peakDb 且文件头合法', async () => {
    const { samples, sampleRate } = synthesizeSfx('impact')
    // 嵌套目录应自动创建：上层常把音效写到 <workDir>/sfx/ 深一层。
    const path = join(scratch, 'nested', 'deeper', 'impact.wav')
    const info = await writeSfxWav(path, samples, sampleRate)
    assert.equal(info.path, path)
    assert.equal(info.bytes, 44 + samples.length * 2)
    assert.ok(Math.abs(info.duration - samples.length / sampleRate) < 1e-6)
    assert.ok(Math.abs(info.peakDb + 1) <= 0.1, `peakDb=${info.peakDb}`)
    const fileInfo = await stat(path)
    assert.equal(fileInfo.size, info.bytes)
    const buffer = await readFile(path)
    assert.equal(buffer.toString('latin1', 0, 4), 'RIFF')
    assert.equal(buffer.toString('latin1', 36, 40), 'data')
    const normalized = await writeSfxWav(join(scratch, 'impact-6db.wav'), samples, sampleRate, { peakDb: -6 })
    assert.ok(Math.abs(normalized.peakDb + 6) <= 0.1, `writeSfxWav peakDb=${normalized.peakDb}`)
    await writeFile(join(scratch, 'scratch-note.txt'), 'ok')
  })

  // -------------------------------------------------------------------------
  // 7. 频谱特征（契约点名的音色个性）
  // -------------------------------------------------------------------------

  await check('impact：40–160 Hz 低频能量占明显比重（低频重量）', () => {
    const { samples, sampleRate } = synthesizeSfx('impact')
    const share = bandShare(samples, sampleRate, 40, 160, 0.3)
    assert.ok(share > 0.25, `低频占比只有 ${(share * 100).toFixed(1)}%`)
  })

  await check('sparkle：4–16 kHz 高频能量占比高（高频颗粒）', () => {
    const { samples, sampleRate } = synthesizeSfx('sparkle')
    const share = bandShare(samples, sampleRate, 4000, 16000)
    assert.ok(share > 0.3, `高频占比只有 ${(share * 100).toFixed(1)}%`)
  })

  await check('riser：频谱质心随时间上升（能抵达落点）', () => {
    const { samples, sampleRate } = synthesizeSfx('riser', { duration: 2 })
    const early = centroidOf(samples, sampleRate, 0, 0.5)
    const late = centroidOf(samples, sampleRate, 1.5, 2)
    assert.ok(late > early * 1.8, `质心 ${early.toFixed(0)}Hz -> ${late.toFixed(0)}Hz`)
  })

  await check('sub-drop：能量集中在低频（下潜托底）', () => {
    const { samples, sampleRate } = synthesizeSfx('sub-drop')
    const share = bandShare(samples, sampleRate, 20, 160, 0.5)
    assert.ok(share > 0.4, `低频占比 ${(share * 100).toFixed(1)}%`)
  })

  await check('whoosh：频谱重心先升后降（单声道里的"位移感"）', () => {
    const { samples, sampleRate } = synthesizeSfx('whoosh')
    const duration = samples.length / sampleRate
    const early = centroidOf(samples, sampleRate, 0.05 * duration, 0.3 * duration)
    const mid = centroidOf(samples, sampleRate, 0.35 * duration, 0.65 * duration)
    const late = centroidOf(samples, sampleRate, 0.7 * duration, 0.95 * duration)
    assert.ok(mid > early * 1.8, `质心未上升: ${early.toFixed(0)} -> ${mid.toFixed(0)} Hz`)
    assert.ok(late < mid * 0.8, `质心未回落: ${mid.toFixed(0)} -> ${late.toFixed(0)} Hz`)
  })
} finally {
  await rm(scratch, { recursive: true, force: true })
}

console.log(`\n${passed} passed / ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error.message}`)
  process.exitCode = 1
}
