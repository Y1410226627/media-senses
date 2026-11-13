/**
 * Style profile aggregation.
 *
 * Turns a corpus of per-video analyses into (a) a machine-readable profile,
 * (b) a Chinese "how this genre is made" document the model can learn from, and
 * (c) a concrete reproduction brief (a RenderPlan skeleton) it can adapt when it
 * calls the video builder.
 */
import { formatTimecode } from './ffmpeg.js'

/** Median of a numeric list (ignores non-finite values). */
export function median(values) {
  const list = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b)
  if (list.length === 0) return null
  const middle = Math.floor(list.length / 2)
  return list.length % 2 === 0 ? (list[middle - 1] + list[middle]) / 2 : list[middle]
}

/** Quantile via linear interpolation between order statistics. */
export function quantile(values, q) {
  const list = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b)
  if (list.length === 0) return null
  if (list.length === 1) return list[0]
  const position = (list.length - 1) * Math.min(1, Math.max(0, q))
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return list[lower]
  return list[lower] + (list[upper] - list[lower]) * (position - lower)
}

/** Most frequent value, or the first one on a tie. */
export function mode(values) {
  const counts = new Map()
  for (const value of values) {
    if (value === undefined || value === null) continue
    const key = String(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best = null
  let bestCount = -1
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  return best
}

/** Share of each value in a list. */
export function distribution(values) {
  const counts = new Map()
  let total = 0
  for (const value of values) {
    if (value === undefined || value === null) continue
    const key = String(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    total += 1
  }
  const out = {}
  for (const [key, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    out[key] = total === 0 ? 0 : Math.round((count / total) * 1000) / 1000
  }
  return out
}

function round(value, digits = 2) {
  if (value === null || value === undefined) return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const factor = 10 ** digits
  return Math.round(number * factor) / factor
}

/** Percentage label from a 0..1 share. */
function pct(value, digits = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return `${(number * 100).toFixed(digits)}%`
}

/** Number when finite, otherwise null (never 0 for a missing measurement). */
function finiteOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** Read one entry's useful numbers, tolerating partial reports. */
function entryFacts(entry) {
  const analysis = entry?.analysis ?? {}
  const craft = entry?.craft ?? {}
  const shots = Array.isArray(analysis.shots) ? analysis.shots : []
  const audio = analysis.audio ?? {}
  const stream = analysis.stream ?? {}
  const global = analysis.global ?? {}
  const cutRhythm = craft.cutRhythm ?? {}
  const grading = craft.grading ?? {}
  const duration = Number(analysis.duration) || 0
  const widths = Number(stream.width) || 0
  const heights = Number(stream.height) || 0
  const aspect = widths > 0 && heights > 0 ? (heights > widths ? `竖屏 ${round(widths / heights, 2)}:1` : widths === heights ? '方形 1:1' : `${round(widths / heights, 2)}:1`) : '未知'
  const aspectKey = heights > widths ? 'vertical' : widths === heights ? 'square' : 'horizontal'
  return {
    id: entry?.id ?? 'unknown',
    file: entry?.relative ?? entry?.file ?? 'unknown',
    duration,
    shots: shots.length,
    avgShotLength: Number(cutRhythm.avgShotLength) || (shots.length > 0 ? duration / shots.length : null),
    cutRatePerMin: Number(cutRhythm.cutRatePerMin) || (duration > 0 ? (Math.max(0, shots.length - 1) / duration) * 60 : null),
    width: widths,
    height: heights,
    aspect,
    aspectKey,
    fps: Number(stream.fps) || null,
    hardCutShare: finiteOrNull(craft.transitions?.hardCutShare),
    cameraMotions: Array.isArray(craft.camera) ? craft.camera.map((item) => item?.motion).filter(Boolean) : [],
    signatures: Array.isArray(grading.signature) ? grading.signature : [],
    temperature: grading.temperature ?? null,
    brightness: finiteOrNull(global.avgBrightness),
    saturation: finiteOrNull(global.avgSaturation),
    hasMusic: audio.tempo?.bpm !== null && audio.tempo?.bpm !== undefined,
    bpm: Number(audio.tempo?.bpm) || null,
    key: audio.key?.name ?? null,
    hasSpeech: audio.vocals?.present === true,
    loudness: finiteOrNull(audio.loudness?.lufsIntegrated),
    beatSync: finiteOrNull(craft.beatSync?.cutsOnBeatRatio),
    titleCard: craft.titleCard?.present === true || craft.overlays?.likelyTitleCard === true,
    subtitles: craft.overlays?.likelySubtitles === true,
    textDensity: finiteOrNull(craft.overlays?.textDensity),
    hookStrength: finiteOrNull(craft.hook?.hookStrength),
    hasEarlyCut: craft.hook?.hasEarlyCut === true,
    notes: Array.isArray(entry?.recipe?.reproductionNotes) ? entry.recipe.reproductionNotes : [],
    recipe: entry?.recipe ?? null,
  }
}

/**
 * Aggregate a corpus into a style profile.
 *
 * @param {Array<object>} entries corpus entries produced by `analyzeCorpus`
 * @param {{name?: string}} [meta]
 */
export function buildStyleProfile(entries, meta = {}) {
  const facts = (entries ?? []).filter((entry) => entry !== null && entry !== undefined).map(entryFacts)
  const usable = facts.filter((fact) => fact.duration > 0)
  const name = meta.name ?? '未命名语料'

  const durations = usable.map((fact) => fact.duration)
  const shotCounts = usable.map((fact) => fact.shots).filter((value) => value > 0)
  const avgShotLengths = usable.map((fact) => fact.avgShotLength).filter((value) => Number.isFinite(value))
  const cutRates = usable.map((fact) => fact.cutRatePerMin).filter((value) => Number.isFinite(value))
  const fpsList = usable.map((fact) => fact.fps).filter((value) => Number.isFinite(value) && value > 0)
  const bpmList = usable.map((fact) => fact.bpm).filter((value) => Number.isFinite(value) && value > 0)
  const loudnessList = usable.map((fact) => fact.loudness).filter((value) => Number.isFinite(value))
  const beatSyncList = usable.map((fact) => fact.beatSync).filter((value) => Number.isFinite(value))
  const hardCutList = usable.map((fact) => fact.hardCutShare).filter((value) => Number.isFinite(value))
  const hookList = usable.map((fact) => fact.hookStrength).filter((value) => Number.isFinite(value))
  const cameraMotions = usable.flatMap((fact) => fact.cameraMotions)
  const signatures = usable.flatMap((fact) => fact.signatures)

  const aspectDistribution = distribution(usable.map((fact) => fact.aspectKey))
  const resolutionMode = mode(usable.map((fact) => (fact.width > 0 && fact.height > 0 ? `${fact.width}x${fact.height}` : null)))
  const horizontal = aspectDistribution.horizontal ?? 0
  const vertical = aspectDistribution.vertical ?? 0
  const aspectKey = vertical > horizontal ? 'vertical' : horizontal > 0 ? 'horizontal' : 'vertical'

  const profile = {
    schema: 'media-senses.style-profile/v1',
    name,
    generatedAt: new Date().toISOString(),
    count: usable.length,
    totalSeconds: round(usable.reduce((sum, fact) => sum + fact.duration, 0), 1),
    duration: {
      median: round(median(durations), 2),
      min: round(Math.min(...durations.filter((value) => value > 0)), 2),
      max: round(Math.max(...durations), 2),
      p25: round(quantile(durations, 0.25), 2),
      p75: round(quantile(durations, 0.75), 2),
    },
    format: {
      aspect: aspectKey,
      aspectDistribution,
      resolutionMode,
      fpsMode: round(mode(fpsList.map((value) => String(value))), 2),
      resolutions: distribution(usable.map((fact) => `${fact.width}x${fact.height}`)),
    },
    pacing: {
      shotsMedian: round(median(shotCounts), 1),
      avgShotLengthMedian: round(median(avgShotLengths), 2),
      avgShotLengthP25: round(quantile(avgShotLengths, 0.25), 2),
      avgShotLengthP75: round(quantile(avgShotLengths, 0.75), 2),
      cutRateMedian: round(median(cutRates), 1),
    },
    transitions: {
      hardCutShareMedian: round(median(hardCutList), 2),
      dominant: (median(hardCutList) ?? 1) >= 0.6 ? 'hard-cut' : 'gradual-mix',
    },
    camera: distribution(cameraMotions),
    grading: {
      signatures: distribution(signatures),
      temperature: distribution(usable.map((fact) => fact.temperature)),
    },
    sound: {
      musicRate: usable.length === 0 ? 0 : round(usable.filter((fact) => fact.hasMusic).length / usable.length, 2),
      speechRate: usable.length === 0 ? 0 : round(usable.filter((fact) => fact.hasSpeech).length / usable.length, 2),
      bpmMedian: round(median(bpmList), 1),
      bpmMin: bpmList.length > 0 ? round(Math.min(...bpmList), 1) : null,
      bpmMax: bpmList.length > 0 ? round(Math.max(...bpmList), 1) : null,
      keyMode: mode(usable.map((fact) => fact.key)),
      loudnessMedian: round(median(loudnessList), 1),
      beatSyncMedian: round(median(beatSyncList), 2),
    },
    overlays: {
      titleCardRate: usable.length === 0 ? 0 : round(usable.filter((fact) => fact.titleCard).length / usable.length, 2),
      subtitleRate: usable.length === 0 ? 0 : round(usable.filter((fact) => fact.subtitles).length / usable.length, 2),
      textDensityMedian: round(median(usable.map((fact) => fact.textDensity)), 2),
    },
    hook: {
      earlyCutRate: usable.length === 0 ? 0 : round(usable.filter((fact) => fact.hasEarlyCut).length / usable.length, 2),
      titleFirst3sRate: profileTitleRate(usable),
      hookStrengthMedian: round(median(hookList), 2),
    },
    videos: facts.map((fact) => ({
      id: fact.id,
      file: fact.file,
      duration: round(fact.duration, 2),
      shots: fact.shots,
      avgShotLength: round(fact.avgShotLength, 2),
      aspect: fact.aspect,
      bpm: round(fact.bpm, 1),
      key: fact.key,
      grading: fact.signatures.slice(0, 3),
      titleCard: fact.titleCard,
      subtitles: fact.subtitles,
    })),
  }

  const checklist = buildChecklist(profile, facts)
  const brief = buildReproductionBrief(profile, facts, aspectKey)
  profile.reproduction = { checklist, brief, targets: brief.targets }

  return { profile, markdown: renderProfileMarkdown(profile, name), facts }
}

function profileTitleRate(facts) {
  const withTitle = facts.filter((fact) => fact.titleCard)
  return facts.length === 0 ? 0 : round(withTitle.length / facts.length, 2)
}

/**
 * Concrete, measurable instructions a model can follow to make another video in
 * the same style. These are derived from the aggregated profile, not invented.
 */
function buildChecklist(profile, facts) {
  const list = []
  const aspect = profile.format.aspect
  const resolution = profile.format.resolutionMode ?? (aspect === 'vertical' ? '1080x1920' : '1920x1080')
  const fps = profile.format.fpsMode ? `${Math.round(profile.format.fpsMode)}fps` : '30fps'
  list.push(`画幅用 ${aspect === 'vertical' ? '竖屏' : aspect === 'square' ? '方形' : '横屏'} ${resolution} @ ${fps}。`)

  const asl = profile.pacing.avgShotLengthMedian
  const singleShotShare = facts.length === 0 ? 0 : facts.filter((fact) => fact.shots <= 1).length / facts.length
  if (asl !== null) {
    const p25 = profile.pacing.avgShotLengthP25
    const p75 = profile.pacing.avgShotLengthP75
    const range = p25 !== null && p75 !== null && p75 > p25 ? `（多数落在 ${p25}–${p75} 秒）` : ''
    if (singleShotShare >= 0.6) {
      list.push(`样本以单镜头长镜头为主（${pct(singleShotShare)} 整条不切），平均长度 ${asl} 秒${range}；靠画面内运动和旁白推进，不要再加花哨转场。`)
    } else {
      list.push(`镜头平均 ${asl} 秒${range}，每分钟约 ${profile.pacing.cutRateMedian ?? '—'} 次剪辑；按这个节奏切分场景。`)
    }
  }

  const hardCut = profile.transitions.hardCutShareMedian
  if (hardCut !== null && singleShotShare < 0.6) {
    list.push(hardCut >= 0.6 ? `转场以硬切为主（约 ${pct(hardCut)}），只在段落之间用淡入淡出。` : `转场偏柔和：约 ${pct(1 - hardCut)} 的切换是淡入/滑动等渐变转场。`)
  } else if (singleShotShare >= 0.6) {
    list.push('没有可统计的镜头切换（多为单镜头素材），复刻时用一个长镜头即可。')
  }

  const cameraEntries = Object.entries(profile.camera).sort((a, b) => b[1] - a[1])
  if (cameraEntries.length > 0) {
    const [topMotion, share] = cameraEntries[0]
    const motionZh = { static: '固定镜头', 'pan-left': '左摇', 'pan-right': '右摇', 'tilt-up': '上摇', 'tilt-down': '下摇', 'zoom-in': '推镜', 'zoom-out': '拉镜', handheld: '手持晃动' }[topMotion] ?? topMotion
    list.push(`运镜以「${motionZh}」为主（${pct(share)}），需要运动时把强度控制在低幅度。`)
  }

  const signatures = Object.entries(profile.grading.signatures).sort((a, b) => b[1] - a[1]).slice(0, 2)
  const temperature = Object.entries(profile.grading.temperature).sort((a, b) => b[1] - a[1])[0]
  if (signatures.length > 0) {
    const tags = signatures.map(([tag, share]) => `${tag}（${pct(share)}）`).join('、')
    const tempZh = temperature === undefined ? '' : `，整体色温${temperature[0] === 'warm' ? '偏暖' : temperature[0] === 'cool' ? '偏冷' : '中性'}`
    list.push(`调色标签：${tags}${tempZh}；保持低饱和与统一冷暖关系。`)
  }

  if (profile.sound.musicRate > 0.5) {
    const bpmText = profile.sound.bpmMedian !== null ? `${profile.sound.bpmMedian} BPM（区间 ${profile.sound.bpmMin}–${profile.sound.bpmMax}）` : '有背景音乐'
    const beat = profile.sound.beatSyncMedian
    const beatText = beat !== null && beat > 0.35 ? `，切点尽量卡在拍点上（样本卡点率 ${pct(beat)}）` : ''
    list.push(`配 ${bpmText} 的音乐${beatText}。`)
  } else {
    list.push('以人声/环境声为主，音乐只做低音量铺底或不用。')
  }
  if (profile.sound.speechRate > 0.4) list.push(`样本中 ${pct(profile.sound.speechRate)} 含人声；用旁白推进叙事，并把混音响度归一化到 ${profile.sound.loudnessMedian ?? -16} LUFS 附近。`)

  if (profile.overlays.titleCardRate > 0.4) list.push(`开头发标题卡（${pct(profile.overlays.titleCardRate)} 的样本有）：前 2 秒内出现标题，深色底 + 居中白字。`)
  if (profile.overlays.subtitleRate > 0.4) list.push('全程烧字幕，位置固定在底部安全区内。')

  const hook = profile.hook
  if (hook.earlyCutRate > 0.4) list.push(`前 3 秒内出现第一次剪辑（${pct(hook.earlyCutRate)} 的样本如此），用快速信息密度抓住注意力。`)

  list.push('先生成完整分镜计划（每场景：类型/时长/文字/转场），再用 media_build_video 渲染；渲染后用 media_watch_video 复核节奏与调色是否落在上面的区间。')
  return list
}

/**
 * A RenderPlan-shaped starting point derived from the profile. The model is
 * expected to edit it (text, images, exact durations) rather than render it as is.
 */
function buildReproductionBrief(profile, facts, aspectKey) {
  const resolution = profile.format.resolutionMode ?? (aspectKey === 'vertical' ? '1080x1920' : '1920x1080')
  const [width, height] = resolution.split('x').map((value) => Number.parseInt(value, 10))
  const fps = Number.isFinite(profile.format.fpsMode) ? Math.round(profile.format.fpsMode) : 30
  const asl = profile.pacing.avgShotLengthMedian ?? 3
  const total = profile.duration.median ?? 15
  const sceneCount = Math.max(2, Math.min(12, Math.round(total / Math.max(1, asl))))
  const hookStrength = profile.hook.hookStrengthMedian ?? 0.3
  const scenes = []
  for (let index = 0; index < sceneCount; index += 1) {
    const duration = Math.max(1, Math.round((asl * (index === 0 ? 0.8 : index === sceneCount - 1 ? 1.2 : 1)) * 10) / 10)
    const isFirst = index === 0
    const usesTitleCard = isFirst && profile.overlays.titleCardRate > 0.3
    scenes.push({
      type: usesTitleCard ? 'text' : 'image',
      duration,
      ...(usesTitleCard
        ? { text: '（标题）', subtitle: '（副标题）', font: 'msyh', fontSize: 96, color: '#ffffff', background: '#120c2b', animation: 'fade' }
        : { src: '（填写你的素材图绝对路径）', motion: 'kenburns-in', fit: 'cover' }),
      transitionIn: index === 0 ? 'cut' : (profile.transitions.dominant === 'hard-cut' ? 'cut' : 'fade'),
      transitionDuration: index === 0 || profile.transitions.dominant === 'hard-cut' ? 0 : 0.5,
    })
  }
  return {
    note: '这是按样本统计自动生成的骨架：把（…）占位替换成真实内容/图片路径，时长可按需微调。',
    plan: {
      output: '（填写输出绝对路径，如 D:/out/replica.mp4）',
      width: Number.isFinite(width) ? width : 1080,
      height: Number.isFinite(height) ? height : 1920,
      fps,
      loudnessTarget: profile.sound.loudnessMedian ?? -16,
      scenes,
      captions: profile.overlays.subtitleRate > 0.4
        ? [{ start: 1, end: 3, text: '（字幕示例）', position: 'bottom', fontSize: 44, color: '#ffffff' }]
        : [],
      audio: {
        ...(profile.sound.musicRate > 0.5 ? { music: '（填写音乐文件绝对路径）', musicVolumeDb: -20, musicFadeOut: 2 } : {}),
        voiceover: profile.sound.speechRate > 0.4 ? [{ text: '（旁白文案）', start: 0.5, voice: 'zh', rate: 1 }] : [],
      },
    },
    targets: {
      avgShotLength: profile.pacing.avgShotLengthMedian,
      cutRatePerMin: profile.pacing.cutRateMedian,
      hardCutShare: profile.transitions.hardCutShareMedian,
      bpm: profile.sound.bpmMedian,
      beatSync: profile.sound.beatSyncMedian,
      hookStrength,
    },
  }
}

/** Render the model-facing Chinese style profile. */
export function renderProfileMarkdown(profile, name) {
  const lines = []
  lines.push(`# 风格画像 · ${name}`)
  lines.push('')
  lines.push(`样本 ${profile.count} 条，总时长 ${formatTimecode(profile.totalSeconds)}；单条时长中位数 ${profile.duration.median} 秒（${profile.duration.min}–${profile.duration.max} 秒）。`)
  lines.push('')

  lines.push('## 一眼结论')
  const aspectZh = profile.format.aspect === 'vertical' ? '竖屏' : profile.format.aspect === 'square' ? '方形' : '横屏'
  const parts = [
    `${aspectZh} ${profile.format.resolutionMode ?? '未知分辨率'} @ ${profile.format.fpsMode ? Math.round(profile.format.fpsMode) : '?'}fps`,
    `平均镜头 ${profile.pacing.avgShotLengthMedian ?? '—'} 秒`,
    `每分钟约 ${profile.pacing.cutRateMedian ?? '—'} 次剪辑`,
    profile.transitions.hardCutShareMedian !== null ? `${pct(profile.transitions.hardCutShareMedian)} 硬切` : null,
    profile.sound.bpmMedian !== null ? `${profile.sound.bpmMedian} BPM` : null,
    profile.sound.speechRate > 0.4 ? `${pct(profile.sound.speechRate)} 有人声` : null,
    profile.overlays.titleCardRate > 0.3 ? `${pct(profile.overlays.titleCardRate)} 有标题卡` : null,
  ].filter(Boolean)
  lines.push(parts.join(' · '))
  lines.push('')

  lines.push('## 画幅与规格')
  lines.push(`- 画幅分布：${Object.entries(profile.format.aspectDistribution).map(([key, share]) => `${key} ${pct(share)}`).join(' / ') || '—'}`)
  lines.push(`- 分辨率：${Object.entries(profile.format.resolutions).map(([key, share]) => `${key} ${pct(share)}`).join(' / ') || '—'}`)
  lines.push(`- 帧率：${profile.format.fpsMode ? `${Math.round(profile.format.fpsMode)} fps` : '—'}`)
  lines.push('')

  lines.push('## 节奏与剪辑')
  lines.push(`- 镜头数中位数 ${profile.pacing.shotsMedian ?? '—'}；平均镜头长度 ${profile.pacing.avgShotLengthMedian ?? '—'} 秒（四分位 ${profile.pacing.avgShotLengthP25 ?? '—'}–${profile.pacing.avgShotLengthP75 ?? '—'}）`)
  lines.push(`- 剪辑频率 ${profile.pacing.cutRateMedian ?? '—'} 次/分钟`)
  lines.push(`- 转场：硬切占 ${profile.transitions.hardCutShareMedian === null ? '—' : pct(profile.transitions.hardCutShareMedian)}，主导类型 ${profile.transitions.dominant === 'hard-cut' ? '硬切' : '渐变'}`)
  lines.push('')

  lines.push('## 运镜')
  const camEntries = Object.entries(profile.camera)
  if (camEntries.length === 0) lines.push('- 无数据（镜头过少或无法判定）')
  else for (const [motion, share] of camEntries) lines.push(`- ${motion}：${pct(share)}`)
  lines.push('')

  lines.push('## 调色')
  lines.push(`- 标签：${Object.entries(profile.grading.signatures).map(([tag, share]) => `${tag} ${pct(share)}`).join(' / ') || '—'}`)
  lines.push(`- 色温：${Object.entries(profile.grading.temperature).map(([tag, share]) => `${tag} ${pct(share)}`).join(' / ') || '—'}`)
  lines.push('')

  lines.push('## 声音')
  lines.push(`- 有音乐：${pct(profile.sound.musicRate)}；BPM 中位数 ${profile.sound.bpmMedian ?? '—'}（${profile.sound.bpmMin ?? '—'}–${profile.sound.bpmMax ?? '—'}）；常见调性 ${profile.sound.keyMode ?? '—'}`)
  lines.push(`- 有人声：${pct(profile.sound.speechRate)}；响度中位数 ${profile.sound.loudnessMedian ?? '—'} LUFS`)
  lines.push(`- 卡点率中位数：${profile.sound.beatSyncMedian === null ? '—' : pct(profile.sound.beatSyncMedian)}（切点落在拍点 ±120ms 内的比例）`)
  lines.push('')

  lines.push('## 文字与包装')
  lines.push(`- 标题卡出现率 ${pct(profile.overlays.titleCardRate)}；字幕出现率 ${pct(profile.overlays.subtitleRate)}；文字密度中位数 ${profile.overlays.textDensityMedian ?? '—'}`)
  lines.push(`- 开头钩子：前 3 秒内有剪辑 ${pct(profile.hook.earlyCutRate)}；钩子强度中位数 ${profile.hook.hookStrengthMedian ?? '—'}`)
  lines.push('')

  lines.push('## 仿制清单（照着做就像）')
  profile.reproduction.checklist.forEach((item, index) => lines.push(`${index + 1}. ${item}`))
  lines.push('')

  lines.push('## 样本清单')
  lines.push('| # | 文件 | 时长 | 镜头 | 平均镜头长 | 画幅 | BPM | 调性 | 调色 |')
  lines.push('|---|------|------|------|------------|------|-----|------|------|')
  profile.videos.forEach((video, index) => {
    lines.push(`| ${index + 1} | ${video.file} | ${video.duration}s | ${video.shots} | ${video.avgShotLength ?? '—'}s | ${video.aspect} | ${video.bpm ?? '—'} | ${video.key ?? '—'} | ${(video.grading ?? []).join('、') || '—'} |`)
  })
  lines.push('')
  lines.push('> 下一步：把上面的「仿制清单」写成分镜，用 `media_build_video` 渲染；渲染完再用 `media_watch_video` 复核，'
    + '把实测的镜头长度/调色/卡点率和本画像对比，差距大就调整再渲一次。')
  return lines.join('\n')
}

export default { buildStyleProfile, renderProfileMarkdown, median, quantile, mode, distribution }



