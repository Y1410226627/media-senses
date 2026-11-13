/**
 * Model-facing report renderer.
 *
 * Everything the model "sees" and "hears" passes through this module: the raw
 * numeric analyses are compiled into dense Chinese prose, timelines, ASCII
 * luminance/hue renderings and follow-up instructions. Keeping the rendering
 * here (instead of inside the engines) means the engines stay pure JSON and the
 * presentation can be tuned without touching measurement code.
 */
import { formatBytes, formatTimecode } from './ffmpeg.js'

const BLOCKS = '▁▂▃▄▅▆▇█'
const LUMINANCE_RAMP = ' .:-=+*#%@'

/* ------------------------------------------------------------------ helpers */

/** Clamp a value into [min, max] with a fallback for non-finite input. */
function clamp(value, min, max, fallback = min) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Format a number with a fixed precision, returning '—' for missing values. */
function num(value, digits = 1, suffix = '') {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return `${number.toFixed(digits)}${suffix}`
}

/** Render a 0..1 value as a small block bar. */
function bar(value, width = 8) {
  const level = Math.round(clamp(value, 0, 1) * width)
  return `${'█'.repeat(level)}${'░'.repeat(Math.max(0, width - level))}`
}

/** Render a value as a percentage string. */
function pct(value, digits = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return `${(number * 100).toFixed(digits)}%`
}

/**
 * Format a tempo reading without ever claiming "extremely slow" for a missing
 * beat. The audio engine returns null (or 0) when the material has no stable
 * pulse, and a drone must not be described as a 0 BPM groove.
 */
function tempoDisplay(tempo) {
  if (tempo === null || typeof tempo !== 'object') return '节奏未测出'
  const bpm = Number(tempo.bpm)
  const confidence = Number(tempo.confidence)
  if (!Number.isFinite(bpm) || bpm <= 0) return '节奏未测出'
  if (Number.isFinite(confidence) && confidence < 0.25) return `BPM 约 ${bpm.toFixed(0)}（置信度低）`
  return `BPM ≈ ${bpm.toFixed(bpm < 100 ? 1 : 0)}（${tempoZh(bpm, confidence)}）`
}

/**
 * Translate the engine warnings that reach the model so a Chinese report does
 * not interleave English sentences. Unknown warnings pass through unchanged.
 */
const WARNING_ZH = [
  [/no scene changes detected;?\s*the density floor produced the reported shots/iu, '未检测到镜头切换；已按密度补帧生成镜头，实际接近一个长镜头'],
  [/static\/flat-frame span|freeze detection/iu, '检测到静止/冻帧区间（标题卡、幻灯片、截图或画面冻结属于正常现象）'],
  [/no audio stream/iu, '该文件没有音频流'],
  [/could not (?:be )?decoded|decode failed/iu, '部分数据无法解码'],
]

function warningZh(warning) {
  const text = String(warning ?? '')
  for (const [pattern, replacement] of WARNING_ZH) {
    if (pattern.test(text)) return replacement
  }
  return text
}


/**
 * Short-term dynamic range is meaningless on material that is mostly silence:
 * a silent tail pushes p10 towards the noise floor and the reading explodes.
 */
function dynamicRangeZh(loudness) {
  const value = Number(loudness?.dynamicRangeDb)
  if (!Number.isFinite(value) || value <= 0) return '—'
  const silence = Number(loudness?.silenceRatio)
  if (value > 60 && Number.isFinite(silence) && silence > 0.25) return `${value.toFixed(0)} dB（含大段静音，参考价值有限）`
  if (value > 60) return `${value.toFixed(0)} dB（冲击型动态）`
  return `${value.toFixed(1)} dB`
}
/** Chinese label for the engine's timbre brightness bucket. */
function timbreZh(brightness) {
  switch (String(brightness ?? '').toLowerCase()) {
    case 'bright':
      return '明亮尖锐'
    case 'dark':
      return '暗沉厚重'
    case 'warm':
      return '温暖柔和'
    case 'neutral':
      return '中性'
    default:
      return '未知音色'
  }
}

/** Describe the heuristic vocal judgment without overclaiming. */
function vocalZh(vocals) {
  if (vocals === null || typeof vocals !== 'object') return '未判断'
  const confidence = Number(vocals.confidence)
  if (!Number.isFinite(confidence)) return vocals.present === true ? '可能有人声' : '以器乐为主'
  if (confidence < 0.35) return '不确定（信号证据不足）'
  if (confidence < 0.6) return vocals.present === true ? '略倾向有人声' : '略倾向器乐'
  return vocals.present === true ? '可能有人声/主唱' : '以器乐或环境声为主'
}

/** Map a numeric series to a unicode sparkline. */
function sparkline(values, width = 48) {
  const list = Array.isArray(values) ? values.filter((v) => Number.isFinite(Number(v))) : []
  if (list.length === 0) return '(无数据)'
  const sampled = []
  for (let i = 0; i < width; i += 1) {
    const index = Math.min(list.length - 1, Math.round((i / Math.max(1, width - 1)) * (list.length - 1)))
    sampled.push(Number(list[index]))
  }
  const max = Math.max(...sampled)
  const min = Math.min(...sampled)
  const span = max - min || 1
  return sampled
    .map((value) => BLOCKS[clamp(Math.round(((value - min) / span) * (BLOCKS.length - 1)), 0, BLOCKS.length - 1, 0)])
    .join('')
}

/** Collapse blank lines and strip trailing spaces from a rendered report. */
function tidy(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

const HUE_ZH = {
  red: '红',
  scarlet: '猩红',
  orange: '橙',
  amber: '琥珀',
  yellow: '黄',
  lime: '黄绿',
  green: '绿',
  emerald: '翠绿',
  cyan: '青',
  teal: '青绿',
  blue: '蓝',
  azure: '天蓝',
  purple: '紫',
  violet: '紫罗兰',
  magenta: '洋红',
  pink: '粉',
  grey: '灰',
  gray: '灰',
  black: '黑',
  white: '白',
}

function hueZh(name) {
  if (typeof name !== 'string' || name.length === 0) return '未知色'
  return HUE_ZH[name.toLowerCase()] ?? name
}

const BRIGHTNESS_ZH = [
  [0.2, '几乎全黑'],
  [0.32, '很暗'],
  [0.45, '偏暗'],
  [0.62, '中等亮度'],
  [0.78, '偏亮'],
  [1.01, '很亮'],
]

function brightnessZh(value) {
  const v = clamp(value, 0, 1, 0.5)
  for (const [limit, label] of BRIGHTNESS_ZH) if (v < limit) return label
  return '很亮'
}

/**
 * Saturation thresholds are deliberately split: a keyframe's HSL saturation
 * (media_frame) and a video track's `signalstats` SATAVG live on different
 * scales, and a single set of thresholds mislabels ordinary footage.
 */
function saturationZh(value) {
  const v = clamp(value, 0, 1, 0.5)
  if (v < 0.12) return '近乎黑白'
  if (v < 0.3) return '低彩度'
  if (v < 0.55) return '中等彩度'
  if (v < 0.78) return '高彩度'
  return '色彩浓烈'
}

/** Video-track saturation (ffmpeg signalstats SATAVG) uses smaller numbers. */
function saturationZhVideo(value) {
  const v = clamp(value, 0, 1, 0.2)
  if (v < 0.04) return '近乎黑白'
  if (v < 0.12) return '低彩度'
  if (v < 0.25) return '中等彩度'
  if (v < 0.45) return '高彩度'
  return '色彩浓烈'
}

function motionZh(value) {
  const v = clamp(value, 0, 100, 0)
  if (v < 1.5) return '几乎静止'
  if (v < 4) return '轻微运动'
  if (v < 10) return '中等运动'
  if (v < 24) return '较大运动'
  return '剧烈运动'
}

function tempoZh(bpm, confidence) {
  const v = Number(bpm)
  if (!Number.isFinite(v)) return '节奏不明'
  if (Number.isFinite(Number(confidence)) && Number(confidence) < 0.25) return '节奏感不明显'
  if (v < 60) return '极慢'
  if (v < 80) return '慢速'
  if (v < 105) return '中慢'
  if (v < 130) return '中速'
  if (v < 155) return '中快'
  if (v < 180) return '快速'
  return '极快'
}

const SECTION_ZH = {
  intro: '前奏',
  verse: '主歌',
  chorus: '副歌',
  'pre-chorus': '预副歌',
  bridge: '桥段',
  break: '间奏',
  drop: '高点/掉落',
  outro: '尾奏',
  build: '铺垫',
  section: '段落',
}

function sectionZh(label, index) {
  if (typeof label !== 'string' || label.length === 0) return `第 ${index + 1} 段`
  const lower = label.toLowerCase()
  const numeric = /^section[\s_-]*(\d+)$/u.exec(lower)
  if (numeric !== null) return `第 ${numeric[1]} 段`
  return SECTION_ZH[lower] ?? label
}

const MOOD_ZH = {
  energetic: '有能量',
  bright: '明亮',
  happy: '愉快',
  joyful: '欢快',
  warm: '温暖',
  calm: '平静',
  chill: '松弛',
  relaxing: '放松',
  dark: '阴暗',
  aggressive: '激烈',
  tense: '紧张',
  sad: '悲伤',
  melancholic: '忧郁',
  romantic: '浪漫',
  dreamy: '梦幻',
  danceable: '适合舞动',
  acoustic: '原声',
  electronic: '电子',
  orchestral: '管弦',
  vocal: '人声主导',
  instrumental: '器乐',
  steady: '律动稳定',
  groovy: '有律动感',
  driving: '推进感强',
  uplifting: '上扬',
  mellow: '醇厚',
  spacious: '空间感',
  intimate: '亲密',
  epic: '史诗感',
  'lo-fi': '低保真',
  uplifting_beat: '上扬节拍',
  unknown: '未判定',
}

/** Translate the video engine's English `layout` clause into Chinese. */
const LAYOUT_ZH = [
  [/high contrast/giu, '高对比'],
  [/low contrast/giu, '低对比'],
  [/top brighter than bottom/giu, '上亮下暗'],
  [/bottom brighter than top/giu, '上暗下亮'],
  [/left brighter than right/giu, '左亮右暗'],
  [/right brighter than left/giu, '左暗右亮'],
  [/centre brighter than edges/giu, '中心亮、四周暗（主体居中）'],
  [/center brighter than edges/giu, '中心亮、四周暗（主体居中）'],
  [/edges brighter than cent(?:re|er)/giu, '四周亮、中心暗（暗角构图）'],
  [/dark cent(?:re|er)/giu, '中心偏暗'],
  [/bright cent(?:re|er)/giu, '中心偏亮'],
  [/uniform(?:ly)? (?:lit|brightness)?/giu, '亮度分布均匀'],
  [/mostly (?:flat|uniform)/giu, '大面积纯色'],
  [/high detail/giu, '细节密集'],
  [/low detail/giu, '细节稀疏'],
]

function layoutZh(layout) {
  if (typeof layout !== 'string' || layout.trim().length === 0) return '—'
  const parts = layout.split(/\s*[/;]\s*|\s*,\s*/u).filter((part) => part.length > 0)
  return parts
    .map((part) => {
      let translated = part
      for (const [pattern, replacement] of LAYOUT_ZH) translated = translated.replace(pattern, replacement)
      return translated
    })
    .join('、')
}

/**
 * Whisper emits bracketed sound events such as `(upbeat music)` for non-speech
 * audio. Those are not dialogue and must not be presented as a transcript.
 */
function isOnlySoundEvents(text) {
  if (typeof text !== 'string') return true
  const stripped = text.replace(/\s+/gu, ' ').trim()
  if (stripped.length === 0) return true
  return /^(\([^()]{0,60}\))+[.!。]?$/u.test(stripped) || /^\[[^\[\]]{0,60}\]$/u.test(stripped)
}

function moodZh(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return '—'
  return labels.map((label) => MOOD_ZH[String(label).toLowerCase()] ?? String(label)).join('、')
}

/** Chinese name for a pitch class index (0 = C). */
const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function keyZh(key) {
  if (key === null || typeof key !== 'object') return '调性不明'
  const confidence = Number(key.confidence)
  if (Number.isFinite(confidence) && confidence < 0.15) return '调性不明（置信极低）'
  const tonic = typeof key.tonic === 'string' && key.tonic.length > 0 ? key.tonic : PITCH_NAMES[0]
  const mode = key.mode === 'minor' ? '小调' : '大调'
  return `${tonic} ${mode}`
}

/** Downsample an ASCII block to a target size, keeping the character grid crisp. */
function fitArt(art, width, height) {
  if (typeof art !== 'string' || art.trim().length === 0) return ''
  const rows = art.replace(/\r/gu, '').split('\n').filter((row) => row.length > 0)
  if (rows.length === 0) return ''
  const columns = Math.max(...rows.map((row) => row.length))
  const padded = rows.map((row) => row.padEnd(columns, ' '))
  const out = []
  for (let y = 0; y < height; y += 1) {
    const sourceRow = padded[clamp(Math.round((y / Math.max(1, height - 1)) * (padded.length - 1)), 0, padded.length - 1, 0)]
    let line = ''
    for (let x = 0; x < width; x += 1) {
      const sourceX = clamp(Math.round((x / Math.max(1, width - 1)) * (columns - 1)), 0, columns - 1, 0)
      line += sourceRow[sourceX] ?? ' '
    }
    out.push(line)
  }
  return out.join('\n')
}

/** Render a shot's luminance art at inline size (luminance) and full size. */
function inlineLuminance(shot) {
  const full = fitArt(shot?.ascii, 44, 15)
  if (full.length === 0) {
    // Without engine art, synthesise a brightness gradient placeholder so the
    // report never shows an empty frame.
    const level = clamp(shot?.brightness, 0, 1, 0.5)
    const char = LUMINANCE_RAMP[clamp(Math.round(level * (LUMINANCE_RAMP.length - 1)), 0, LUMINANCE_RAMP.length - 1, 5)]
    return char.repeat(44)
  }
  return full
}

/* ------------------------------------------------------------ vision target */

/**
 * Vision target (v3): when the current model can see images, the Lead embeds the
 * pictures and passes an `imagePlan`; the report then only phrases that plan,
 * gives a 格号→时间码 index and concrete questions, and drops the ASCII art and
 * adjective judgements that exist purely for blind models.
 *
 * Every helper here only runs when `meta.target === 'vision'`, so the default
 * (blind) report stays byte-for-byte identical.
 */
const IMAGE_KIND_ZH = {
  'contact-sheet': '联系表',
  filmstrip: '时间条',
  detail: '局部细节',
  spectrogram: '频谱图',
  waveform: '波形图',
  compare: '对比图',
  preview: '预览帧',
}

function imageKindZh(kind) {
  return IMAGE_KIND_ZH[String(kind ?? '')] ?? '图像'
}

/** Opt-in only: a missing/unknown target keeps the blind rendering. */
function isVisionMode(meta) {
  return meta !== null && typeof meta === 'object' && meta.target === 'vision'
}

/** Normalise `meta.imagePlan` into the entries this renderer can phrase. */
function imagePlanOf(meta) {
  return Array.isArray(meta?.imagePlan)
    ? meta.imagePlan.filter((entry) => entry !== null && typeof entry === 'object')
    : []
}

/** One-line "what this image is", without repeating its own kind label twice. */
function imageCaptionText(entry) {
  const label = imageKindZh(entry.kind)
  let caption = typeof entry.caption === 'string' ? entry.caption.trim() : ''
  if (caption.startsWith(label)) caption = caption.slice(label.length).replace(/^[:：\s]+/u, '')
  if (caption.length === 0) caption = `${label}已内嵌`
  if (typeof entry.note === 'string' && entry.note.trim().length > 0) caption += `（${entry.note.trim()}）`
  return caption
}

/** Non-empty cells of one imagePlan entry (the sheet's 格号→时间码 index). */
function planCells(entry) {
  return Array.isArray(entry?.cells) ? entry.cells.filter((cell) => cell !== null && typeof cell === 'object') : []
}

/** 1-based 格号 of a cell, tolerating 0-based engine indices and burned labels. */
function cellLabel(cells, index) {
  const cell = cells[index]
  if (typeof cell.label === 'string' && cell.label.trim().length > 0) return cell.label.trim()
  const value = Number(cell.index)
  if (!Number.isFinite(value)) return String(index + 1)
  const zeroBased = cells.some((item) => Number(item.index) === 0)
  return String(zeroBased ? value + 1 : value)
}

function cellTimecode(cell) {
  if (typeof cell.timecode === 'string' && cell.timecode.trim().length > 0) return cell.timecode.trim()
  return formatTimecode(cell.time)
}

/** Compact 格号→时间码 table; more than 24 cells list every second cell only. */
function mappingTableLines(entry) {
  const cells = planCells(entry)
  if (cells.length === 0) return []
  const stride = cells.length > 24 ? 2 : 1
  const lines = [`**【${imageKindZh(entry.kind)}】格号 → 时间码**`, '', '| 格 | 时间码 |', '|----|--------|']
  for (let index = 0; index < cells.length; index += stride) {
    lines.push(`| ${cellLabel(cells, index)} | ${cellTimecode(cells[index])} |`)
  }
  if (stride > 1) lines.push('', `> 共 ${cells.length} 格，上表每 2 格只列 1 格；格号=按行优先数的画面序号。`)
  return lines
}

/** `## 看图说明`: one bullet per embedded image plus the index it refers to. */
function visionOverviewLines(imagePlan) {
  const lines = ['## 看图说明']
  const sheets = []
  for (const entry of imagePlan) {
    const cells = planCells(entry)
    const suffix = cells.length > 0 ? '；格号→时间码见下表' : ''
    lines.push(`- 【${imageKindZh(entry.kind)}】${imageCaptionText(entry)}${suffix}`)
    if (cells.length > 0) sheets.push(entry)
  }
  if (sheets.length > 0) {
    lines.push('')
    for (const entry of sheets) {
      lines.push(...mappingTableLines(entry))
      lines.push('')
    }
    lines.push('坐标约定: 格号 A1 = 左上第一格；"第 3 格"指按行优先数的第 3 个画面。')
  }
  return lines
}

/**
 * `## 观察清单（用眼睛回答）`: 8–10 concrete questions generated from the numbers
 * already in the report — never their answers, never an ASCII substitute.
 */
function observationChecklistLines(context) {
  const { shots, flags, audio, transcript, imagePlan } = context
  const tasks = []
  const sheet = imagePlan
    .filter((entry) => planCells(entry).length > 0)
    .sort((a, b) => planCells(b).length - planCells(a).length)[0]
  const cells = sheet === undefined ? [] : planCells(sheet)
  const ends = cells.length > 0
    ? `第 1 格（${cellTimecode(cells[0])}）与最后一格（${cellTimecode(cells[cells.length - 1])}）`
    : '开头与结尾'

  if (cells.length > 0) {
    tasks.push(`逐格描述（共 ${cells.length} 格）：每格的主体是什么、在做什么、场景类型（室内/室外/特写/全景）。`)
  } else {
    tasks.push('按时间码逐段描述：每一段的主体是什么、在做什么、场景类型（室内/室外/特写/全景）。')
  }
  tasks.push(`比较${ends}：构图、景别、光线发生了什么变化。`)
  const hasTranscript = typeof transcript === 'string' && transcript.trim().length > 0
  tasks.push(`读出画面里出现的所有文字（标题/字幕/UI/水印），注明语言与位置${hasTranscript ? '，并与上面的语音内容对照是否一致' : ''}。`)
  tasks.push(`判断每个镜头的景别（特写/近景/中景/全景）与机位（平视/俯拍/仰拍），以及运动是推、拉、摇、移还是固定${shots.length > 0 ? `（共 ${shots.length} 个镜头，见上表时间码）` : ''}。`)
  tasks.push('光线方向与色温：顺光/侧光/逆光、冷/暖，与上表主色 hex 对照。')

  const measurable = shots.filter((shot) => Number.isFinite(Number(shot.brightness)))
  if (measurable.length >= 2) {
    const darkest = measurable.reduce((a, b) => (Number(a.brightness) <= Number(b.brightness) ? a : b))
    const brightest = measurable.reduce((a, b) => (Number(a.brightness) >= Number(b.brightness) ? a : b))
    if (darkest !== brightest) {
      const label = (shot) => `#${(Number(shot.index) || 0) + 1} ${formatTimecode(shot.start)}，亮度 ${num(shot.brightness, 2)}`
      tasks.push(`对比最暗的镜头（${label(darkest)}）与最亮的镜头（${label(brightest)}）：两者各拍的是什么？`)
    }
  }

  const moving = shots.filter((shot) => Number.isFinite(Number(shot.motion)))
  if (moving.length > 0) {
    const busiest = moving.reduce((a, b) => (Number(a.motion) >= Number(b.motion) ? a : b))
    tasks.push(`运动量最大的是 #${(Number(busiest.index) || 0) + 1}（${formatTimecode(busiest.start)}，运动 ${num(busiest.motion, 1)} / 100）：画面里具体是什么在动？`)
  }

  const frozen = Array.isArray(flags.frozen) ? flags.frozen : []
  const black = Array.isArray(flags.black) ? flags.black : []
  const spanText = (list) => list.slice(0, 3).map((item) => `${formatTimecode(item.start)}–${formatTimecode(item.end)}`).join('、')
  if (frozen.length > 0) tasks.push(`冻帧区间（${spanText(frozen)}）里画面到底是什么：静止画面、标题卡，还是卡帧？`)
  if (black.length > 0) tasks.push(`黑场区间（${spanText(black)}）是转场留白还是漏帧？`)
  if (frozen.length === 0 && black.length === 0) tasks.push('画面里哪些元素在重复出现（人物/产品/logo/场景）？')

  tasks.push('如果某格看不清细节，用 `media_frame` 指定 `time` 与 `region`（"x,y,w,h" 原图像素）取局部放大。')
  if (audio !== null && typeof audio === 'object') {
    const bpm = Number(audio.tempo?.bpm)
    const pulse = Number.isFinite(bpm) && bpm > 0 ? ` ${Math.round(bpm)} BPM 的拍点` : '声音的段落边界'
    tasks.push(`视觉与声音是否同步：把镜头切换点（见上表时间码）与${pulse}对照，指出哪几处切换正好落在拍点上。`)
  }
  const extras = [
    '画面里是否有人物/动物/车辆？描述数量、朝向与所处环境。',
    '判断这条片子是实拍、动画/图表还是文字卡，依据是哪几格。',
    '有没有明显的 logo、水印或品牌元素？描述位置与大小。',
  ]
  while (tasks.length < 8 && extras.length > 0) tasks.push(extras.shift())

  const lines = ['## 观察清单（用眼睛回答）']
  tasks.slice(0, 10).forEach((task, index) => lines.push(`${index + 1}. ${task}`))
  lines.push('')
  lines.push('回答时请引用格号与时间码，不要重复上面的数字表。')
  return lines
}

/* ------------------------------------------------------------- probe report */

/**
 * Render a container/stream summary for `media_probe`.
 *
 * @param {object} summary result of `summariseProbe`
 * @param {string} file absolute path
 * @param {object} extra additional facts (e.g. `kind: 'video'`)
 */
export function renderProbeReport(summary, file, extra = {}) {
  const lines = []
  lines.push(`# 媒体探测 · ${basenameOf(file)}`)
  lines.push('')
  lines.push(`文件: \`${file}\``)
  lines.push(`容器: ${summary.formatLongName ?? '未知'} (${summary.formatName ?? '?'}) · ${formatBytes(summary.sizeBytes)} · 码率 ${summary.bitRate > 0 ? `${Math.round(summary.bitRate / 1000)} kbps` : '未知'}`)
  lines.push(`时长: ${formatTimecode(summary.duration)} (${num(summary.duration, 2, ' 秒')})`)

  const video = Array.isArray(summary.video) ? summary.video : []
  if (video.length > 0) {
    lines.push('')
    lines.push('## 视频流')
    for (const stream of video) {
      const rotation = stream.rotation > 0 ? ` · 旋转 ${stream.rotation}°` : ''
      lines.push(`- #${stream.index} ${stream.codec} ${stream.width}×${stream.height} @ ${num(stream.fps, 3, ' fps')}${rotation} · ${stream.pixFmt ?? '?'}${stream.profile ? ` · ${stream.profile}` : ''}`)
    }
  }

  const audio = Array.isArray(summary.audio) ? summary.audio : []
  if (audio.length > 0) {
    lines.push('')
    lines.push('## 音频流')
    for (const stream of audio) {
      lines.push(`- #${stream.index} ${stream.codec} ${stream.sampleRate} Hz · ${stream.channels ?? '?'} 声道 (${stream.channelLayout ?? '未知布局'}) · ${stream.bitRate > 0 ? `${Math.round(stream.bitRate / 1000)} kbps` : '码率未知'}`)
    }
  }

  const subtitles = Array.isArray(summary.subtitles) ? summary.subtitles : []
  if (subtitles.length > 0) {
    lines.push('')
    lines.push('## 字幕轨')
    for (const stream of subtitles) {
      lines.push(`- #${stream.index} ${stream.codec} 语言 ${stream.language ?? '未知'}${stream.title ? ` 「${stream.title}」` : ''}${stream.forced ? ' (强制)' : ''}`)
    }
    lines.push('> 提示：字幕轨是理解对白的捷径，可用 ffmpeg 抽取为 srt 后阅读。')
  }

  const chapters = Array.isArray(summary.chapters) ? summary.chapters : []
  if (chapters.length > 0) {
    lines.push('')
    lines.push('## 章节')
    for (const chapter of chapters) {
      lines.push(`- ${formatTimecode(chapter.start)}–${formatTimecode(chapter.end)} ${chapter.title || '(未命名)'}`)
    }
  }

  const kind = extra.kind ?? (video.length > 0 ? 'video' : audio.length > 0 ? 'audio' : 'unknown')
  lines.push('')
  lines.push('## 下一步')
  if (kind === 'video') {
    lines.push('- `media_watch_video`：抽取镜头、关键帧、画面明暗/色相/运动、缩略亮度图，并可本地转写语音。')
  } else if (kind === 'audio') {
    lines.push('- `media_listen_audio`：测定 BPM、调性、和弦、曲式结构、响度、音色与情绪倾向。')
  } else {
    lines.push('- 该文件既没有可识别的视频流也没有音频流。')
  }
  if (summary.duration > 1800) lines.push(`- 时长 ${formatTimecode(summary.duration)}，分析会默认截取前 30 分钟以保证响应时间（可用 start/duration 指定片段）。`)
  if (extra.note) lines.push(`- ${extra.note}`)
  return tidy(lines.join('\n'))
}

function basenameOf(path) {
  const parts = String(path).split(/[\\/]/u)
  return parts[parts.length - 1] || String(path)
}

/* ------------------------------------------------------------ video report */

/**
 * Render the full video perception report.
 *
 * `meta.target: 'vision'` switches to the image-first presentation (see
 * CONTRACT-V3 A1): the Lead embeds pictures, hands over the `imagePlan`, and this
 * function only phrases it. Optional `meta.appendix` lets the tool layer pass
 * extra markdown sections (craft / change selection) that must still come before
 * the closing `## 观察清单（用眼睛回答）`.
 *
 * @param {object} analysis VideoAnalysis
 * @param {{file: string, detail?: 'brief'|'full', transcript?: string|null, asrNotes?: string[], target?: 'blind'|'vision', imagePlan?: object[], appendix?: string[]}} meta
 */
export function renderVideoReport(analysis, meta) {
  const video = analysis ?? {}
  const stream = video.stream ?? {}
  const format = video.format ?? {}
  const global = video.global ?? {}
  const shots = Array.isArray(video.shots) ? video.shots : []
  const timeline = Array.isArray(video.timeline) ? video.timeline : []
  const detail = meta.detail === 'brief' ? 'brief' : 'full'
  const vision = isVisionMode(meta)
  const imagePlan = vision ? imagePlanOf(meta) : []
  const lines = []

  lines.push(`# 视频感知报告 · ${basenameOf(meta.file)}`)
  lines.push('')
  lines.push(`文件: \`${meta.file}\``)
  lines.push(
    `规格: ${formatTimecode(video.duration)} · ${stream.width ?? '?'}×${stream.height ?? '?'} @ ${num(stream.fps, 3, ' fps')} · ${stream.codec ?? '?'} · ${global.aspectRatio ?? '?'} · ${formatBytes(format.sizeBytes)} · ${format.container ?? '?'}`,
  )
  const audio = video.audio
  if (audio !== null && typeof audio === 'object') {
    lines.push(`音轨: ${audio.format?.codec ?? '?'} ${audio.format?.sampleRate ?? '?'} Hz · ${audio.format?.channels ?? '?'} 声道 · ${tempoDisplay(audio.tempo)} · ${keyZh(audio.key)}`)
  } else {
    lines.push('音轨: 无（静帧/无声视频）')
  }
  // Vision mode: say how many pictures are embedded so the model knows to look.
  if (vision) lines.push(`呈现模式: vision（已内嵌 ${imagePlan.length} 张图；文本不含字符图）`)
  lines.push('')

  // Vision mode leads with the image index; the blind report has no such block.
  if (vision && imagePlan.length > 0) {
    lines.push(...visionOverviewLines(imagePlan))
    lines.push('')
  }

  // --- one-line overview ---------------------------------------------------
  const topHues = Array.isArray(global.dominantHues)
    ? global.dominantHues.slice(0, 3).map((hue) => `${hueZh(hue.name)}${hue.share > 0 ? `(${pct(hue.share)})` : ''}`).join('、')
    : '未知'
  lines.push('## 一句话概览')
  const shotSummary = shots.length > 0
    ? `共 ${shots.length} 个镜头（平均 ${num(video.duration / shots.length, 1)} 秒/镜，切换率 ${num(global.cutRate, 1)} 次/分）`
    : '未检测到明确镜头切换（可能是单镜头或极短片段）'
  if (vision) {
    // Keep every number, drop the adjective judgement: the model can see colour.
    lines.push(
      `${shotSummary}；平均亮度 ${num(global.avgBrightness, 2)}、平均彩度 ${num(global.avgSaturation, 2)}、平均运动量 ${num(global.avgMotion, 1)} / 100；主色调 ${topHues}。`,
    )
  } else {
    lines.push(
      `${shotSummary}；画面整体${brightnessZh(global.avgBrightness)}（亮度 ${num(global.avgBrightness, 2)}）、${saturationZhVideo(global.avgSaturation)}（彩度 ${num(global.avgSaturation, 2)}），主色调 ${topHues}；${motionZh(global.avgMotion)}（平均运动量 ${num(global.avgMotion, 1)} / 100）。`,
    )
  }
  const flow = shots.slice(0, 8).map((shot) => vision
    ? `${formatTimecode(shot.start)} ${hueZh(shot.hueName)}`
    : `${formatTimecode(shot.start)} ${hueZh(shot.hueName)}·${brightnessZh(shot.brightness)}`).join(' → ')
  if (flow.length > 0) lines.push('画面演进: ' + flow + (shots.length > 8 ? ` → …（共 ${shots.length} 镜）` : ''))
  if (typeof meta.transcript === 'string' && meta.transcript.trim().length > 0 && !isOnlySoundEvents(meta.transcript)) {
    lines.push(`对白要点: ${firstSentence(meta.transcript, 120)}`)
  } else if (typeof meta.transcript === 'string' && meta.transcript.trim().length > 0) {
    lines.push('对白: 未检测到人声内容（音轨以音乐/环境声为主，转录只得到音效标记）')
  }
  if (audio !== null && typeof audio === 'object') {
    lines.push(
      `声音: ${tempoDisplay(audio.tempo)} · ${keyZh(audio.key)} · 响度 ${num(audio.loudness?.lufsIntegrated, 1, ' LUFS')} · 能量${energyWord(audio.mood?.arousal)} · 人声${vocalZh(audio.vocals)}`,
    )
  }
  lines.push('')

  // --- shot table ----------------------------------------------------------
  if (shots.length > 0) {
    lines.push('## 镜头时间线')
    lines.push('| # | 时间码 | 时长 | 亮度 | 彩度 | 色调 | 运动 | 主要颜色 |')
    lines.push('|---|--------|------|------|------|------|------|----------|')
    const limit = detail === 'brief' ? Math.min(shots.length, 40) : Math.min(shots.length, 60)
    for (const shot of shots.slice(0, limit)) {
      const palette = Array.isArray(shot.palette) && shot.palette.length > 0
        ? shot.palette.slice(0, 3).map((entry) => `${entry.hex}${Number.isFinite(Number(entry.share)) ? `(${pct(entry.share)})` : ''}`).join(' ')
        : '—'
      lines.push(
        `| ${(shot.index ?? 0) + 1} | ${formatTimecode(shot.start)}–${formatTimecode(shot.end)} | ${num(shot.duration, 2, 's')} | ${num(shot.brightness, 2)}${vision ? '' : ` ${brightnessZh(shot.brightness)}`} | ${num(shot.saturation, 2)} | ${hueZh(shot.hueName)} ${shot.hueHex ?? ''} | ${num(shot.motion, 1)}${vision ? '' : ` ${motionZh(shot.motion)}`} | ${palette} |`,
      )
    }
    if (shots.length > limit) lines.push(`| … | 省略 ${shots.length - limit} 个镜头 | | | | | | |`)
    lines.push('')

    if (!vision) {
      // --- visual structure -----------------------------------------------
      lines.push('## 画面结构（亮度图 + 色相图）')
      lines.push('亮度图用字符密度表示明暗（空格最暗，`@` 最亮，横轴=左→右，纵轴=上→下）；色相图用字母表示颜色：R红 O橙 Y黄 G绿 C青 B蓝 M洋红，`.` 表示灰/黑/白。')
      const artShots = shots.slice(0, detail === 'brief' ? Math.min(shots.length, 10) : Math.min(shots.length, 24))
      for (const shot of artShots) {
        lines.push('')
        lines.push(`### 镜头 ${(shot.index ?? 0) + 1} · ${formatTimecode(shot.start)}–${formatTimecode(shot.end)} · ${hueZh(shot.hueName)} · ${brightnessZh(shot.brightness)} · ${motionZh(shot.motion)}`)
        const art = inlineLuminance(shot)
        if (art.includes('\n')) {
          lines.push('```')
          lines.push(art)
          lines.push('```')
        }
        const hueMap = fitArt(shot.hueMap, 44, 15)
        if (hueMap.includes('\n')) {
          lines.push('色相图:')
          lines.push('```')
          lines.push(hueMap)
          lines.push('```')
        }
        const facts = []
        if (typeof shot.layout === 'string' && shot.layout.length > 0) facts.push(`版式: ${layoutZh(shot.layout)}`)
        if (Array.isArray(shot.palette) && shot.palette.length > 0) {
          facts.push(`配色: ${shot.palette.slice(0, 4).map((entry) => `${entry.hex}${Number.isFinite(Number(entry.share)) ? ` ${pct(entry.share)}` : ''}`).join(' / ')}`)
        }
        if (typeof shot.keyframe === 'string') facts.push(`关键帧: \`${shot.keyframe}\``)
        if (facts.length > 0) lines.push(facts.join(' | '))
      }
      if (shots.length > artShots.length) {
        lines.push('')
        lines.push(`> 其余 ${shots.length - artShots.length} 个镜头未展开；需要对某一时刻细看时调用 \`media_frame\`（参数 path + time）。`)
      }
      lines.push('')
    }
  }

  // --- curves --------------------------------------------------------------
  if (timeline.length > 0) {
    lines.push('## 逐秒曲线（低→高）')
    lines.push(`亮度 ${sparkline(timeline.map((point) => point.brightness), 60)}`)
    lines.push(`运动 ${sparkline(timeline.map((point) => point.motion), 60)}`)
    lines.push(`彩度 ${sparkline(timeline.map((point) => point.saturation), 60)}`)
    lines.push('')
  }

  // --- transcript ----------------------------------------------------------
  const transcript = typeof meta.transcript === 'string' ? meta.transcript.trim() : ''
  lines.push('## 语音内容')
  if (transcript.length > 0 && !isOnlySoundEvents(transcript)) {
    lines.push('> 本地 whisper 转写，可能有少量错字；时间是全片范围。')
    lines.push('')
    lines.push(transcript.length > 6000 ? `${transcript.slice(0, 6000)}\n…（转写过长已截断）` : transcript)
  } else if (transcript.length > 0) {
    lines.push(`没有可用的对白：whisper 只识别出音效/音乐标记（${transcript.slice(0, 80)}），说明音轨以音乐或环境声为主。`)
  } else {
    lines.push(video.audio === null ? '无音轨，无语音内容。' : '未检测到可转写语音（纯音乐/环境声，或转录未启用）。')
  }
  lines.push('')

  // --- audio summary -------------------------------------------------------
  if (audio !== null && typeof audio === 'object') {
    lines.push(...audioDigestLines(audio))
    lines.push('')
  }

  // --- flags ---------------------------------------------------------------
  const flags = video.flags ?? {}
  const flagLines = []
  const spans = (list, name) => {
    if (!Array.isArray(list) || list.length === 0) return `${name}: 无`
    return `${name}: ${list.slice(0, 6).map((item) => `${formatTimecode(item.start)}–${formatTimecode(item.end)}`).join('、')}${list.length > 6 ? ` 等 ${list.length} 段` : ''}`
  }
  flagLines.push(spans(flags.frozen, '冻帧'))
  flagLines.push(spans(flags.black, '黑场'))
  flagLines.push(spans(flags.silent, '静音'))
  if (flags.likelyTextHeavy === true) flagLines.push('画面细节密集且运动少：可能是幻灯片/字幕/图表，也可能是纹理丰富的静物或风景')
  if (flags.likelyTalkingHead === true && transcript.length > 0) flagLines.push('疑似口播/人物讲话（低运动 + 检测到语音）')
  if (flagLines.length > 0) {
    lines.push('## 健康与内容判断')
    lines.push(flagLines.join(' · '))
    lines.push('')
  }

  // --- artifacts -----------------------------------------------------------
  const artifacts = video.artifacts ?? {}
  const artifactLines = []
  if (typeof artifacts.contactSheet === 'string') artifactLines.push(`- 联系表（缩略图网格）: \`${artifacts.contactSheet}\` — 可用 \`read_image\` 直接查看`)
  if (typeof artifacts.keyframesDir === 'string') artifactLines.push(`- 关键帧目录: \`${artifacts.keyframesDir}\``)
  if (typeof artifacts.waveform === 'string') artifactLines.push(`- 波形图: \`${artifacts.waveform}\``)
  if (typeof artifacts.spectrogram === 'string') artifactLines.push(`- 频谱图: \`${artifacts.spectrogram}\``)
  if (artifactLines.length > 0) {
    lines.push('## 生成的图像文件')
    lines.push(...artifactLines)
    lines.push('')
  }

  // --- follow-ups ----------------------------------------------------------
  lines.push('## 还可以问我')
  lines.push(vision
    ? '- 想看清某一刻或某一块：`media_frame`，参数 `path` + `time`（秒），可选 `region`（"x,y,w,h" 原图像素）取局部放大。'
    : '- 想看清某一刻的画面：`media_frame`，参数 `path` + `time`（秒），会返回该帧原图路径和更大尺寸的亮度图。')
  lines.push('- 想听这段配乐的风格/结构：`media_listen_audio`，参数 `path`，会给出 BPM、调性、和弦、曲式与情绪。')
  lines.push('- 想核对容器/编码细节：`media_probe`，参数 `path`。')
  if (Array.isArray(meta.asrNotes) && meta.asrNotes.length > 0) {
    lines.push('')
    lines.push('## 提示与限制')
    for (const note of meta.asrNotes) lines.push(`- ${note}`)
  }
  if (Array.isArray(video.warnings) && video.warnings.length > 0) {
    if (!Array.isArray(meta.asrNotes) || meta.asrNotes.length === 0) lines.push('')
    if (Array.isArray(meta.asrNotes) && meta.asrNotes.length === 0) lines.push('## 提示与限制')
    for (const warning of video.warnings) lines.push(`- ${warningZh(warning)}`)
  }
  // Vision mode ends with the questions to answer from the pictures themselves,
  // so any extra sections (craft / change selection) go before that checklist.
  if (vision) {
    if (Array.isArray(meta.appendix)) {
      for (const section of meta.appendix) {
        const text = typeof section === 'string' ? section.trim() : ''
        if (text.length === 0) continue
        lines.push('')
        lines.push(text)
      }
    }
    lines.push('')
    lines.push(...observationChecklistLines({ shots, flags, audio, transcript, imagePlan }))
  }
  return tidy(lines.join('\n'))
}

function firstSentence(text, limit) {
  const clean = String(text).replace(/\s+/gu, ' ').trim()
  if (clean.length <= limit) return clean
  const window = clean.slice(0, limit)
  const boundary = Math.max(window.lastIndexOf(' '), window.lastIndexOf('，'), window.lastIndexOf('。'), window.lastIndexOf(','))
  return `${(boundary > limit * 0.5 ? window.slice(0, boundary) : window).trim()}…`
}

function energyWord(arousal) {
  const value = Number(arousal)
  if (!Number.isFinite(value)) return '不明'
  if (value < 0.3) return '低'
  if (value < 0.5) return '中低'
  if (value < 0.7) return '中'
  if (value < 0.85) return '高'
  return '极高'
}

/** Compact audio block reused inside the video report. */
function audioDigestLines(audio) {
  const lines = ['## 声音特征（同一文件音轨）']
  lines.push(`- 节奏: ${tempoDisplay(audio.tempo)}（置信 ${num(audio.tempo?.confidence, 2)}）· 拍数 ${num(audio.tempo?.beatCount, 0)} · ${audio.tempo?.timeSignatureGuess ?? 4}/4 拍`)
  lines.push(`- 调性: ${keyZh(audio.key)}（置信 ${num(audio.key?.confidence, 2)}）${Array.isArray(audio.key?.candidates) && audio.key.candidates.length > 1 ? ` · 备选 ${audio.key.candidates.slice(1, 3).map((c) => c.name).join(' / ')}` : ''}`)
  const loud = audio.loudness ?? {}
  lines.push(`- 响度: 峰值 ${num(loud.peakDbfs, 1, ' dBFS')} · RMS ${num(loud.rmsDbfs, 1, ' dBFS')} · 积分响度 ${num(loud.lufsIntegrated, 1, ' LUFS')} · 动态范围 ${dynamicRangeZh(loud)} · 静音占比 ${pct(loud.silenceRatio)}`)
  const timbre = audio.timbre ?? {}
  lines.push(`- 音色: ${timbreZh(timbre.brightness)}（质心 ${num(timbre.centroidHz, 0, ' Hz')}，rolloff ${num(timbre.rolloffHz, 0, ' Hz')}，flatness ${num(timbre.flatness, 3)}）${timbre.description ? ` — ${timbre.description}` : ''}`)
  const spectrum = audio.spectrum ?? {}
  lines.push(`- 频段占比: 低频 ${pct(spectrum.lowRatio)} / 中频 ${pct(spectrum.midRatio)} / 高频 ${pct(spectrum.highRatio)}`)
  if (audio.vocals !== undefined) lines.push(`- 人声: ${vocalZh(audio.vocals)}（启发式，置信 ${num(audio.vocals?.confidence, 2)}）${audio.vocals?.note ? ` — ${audio.vocals.note}` : ''}`)
  const mood = audio.mood ?? {}
  lines.push(`- 情绪（启发式）: 唤醒度 ${num(mood.arousal, 2)} / 效价 ${num(mood.valence, 2)} · ${moodZh(mood.labels)}`)
  if (Array.isArray(audio.sections) && audio.sections.length > 0) {
    lines.push(`- 段落: ${audio.sections.map((section, index) => `${formatTimecode(section.start)}–${formatTimecode(section.end)} ${sectionZh(section.label, index)}`).join(' / ')}`)
  }
  return lines
}

/* ------------------------------------------------------------ audio report */

/**
 * Render the full music/audio perception report.
 *
 * @param {object} analysis AudioAnalysis
 * @param {{file: string, detail?: 'brief'|'full', transcript?: string|null, asrNotes?: string[]}} meta
 */
export function renderAudioReport(analysis, meta) {
  const audio = analysis ?? {}
  const format = audio.format ?? {}
  const loudness = audio.loudness ?? {}
  const tempo = audio.tempo ?? {}
  const key = audio.key
  const timbre = audio.timbre ?? {}
  const spectrum = audio.spectrum ?? {}
  const rhythm = audio.rhythm ?? {}
  const mood = audio.mood ?? {}
  const detail = meta.detail === 'brief' ? 'brief' : 'full'
  const lines = []

  lines.push(`# 音乐/音频感知报告 · ${basenameOf(meta.file)}`)
  lines.push('')
  lines.push(`文件: \`${meta.file}\``)
  lines.push(`规格: ${formatTimecode(audio.duration)} · ${format.container ?? '?'} · ${format.codec ?? '?'} · ${format.sampleRate ?? '?'} Hz · ${format.channels ?? '?'} 声道 · ${format.bitRate > 0 ? `${Math.round(format.bitRate / 1000)} kbps` : '码率未知'}`)
  if (audio.analyzed !== undefined) {
    lines.push(`分析区间: ${formatTimecode(audio.analyzed.start)} 起 ${num(audio.analyzed.seconds, 1, ' 秒')}（重采样 ${audio.analyzed.sampleRate} Hz 单声道）`)
  }
  lines.push('')

  lines.push('## 一句话概览')
  const keyText = key === null ? '调性不明' : `${keyZh(key)}（置信 ${num(key.confidence, 2)}）`
  const chordText = audio.chords !== null && typeof audio.chords === 'object' && Array.isArray(audio.chords.uniqueNames) && audio.chords.uniqueNames.length > 0
    ? `，和声走向 ${audio.chords.uniqueNames.join(' → ')}`
    : ''
  lines.push(
    `${tempoDisplay(tempo)}（${tempo.timeSignatureGuess ?? 4}/4 拍，置信 ${num(tempo.confidence, 2)}），${keyText}${chordText}；${timbre.brightness === 'bright' ? '音色明亮' : timbre.brightness === 'dark' ? '音色偏暗' : '音色中性'}、${spectrum.lowRatio !== undefined && spectrum.lowRatio > 0.45 ? '低频厚重' : spectrum.highRatio !== undefined && spectrum.highRatio > 0.3 ? '高频突出' : '频段均衡'}；情绪上${moodZh(mood.labels)}（唤醒 ${num(mood.arousal, 2)} / 效价 ${num(mood.valence, 2)}）。`,
  )
  if (Array.isArray(audio.sections) && audio.sections.length > 0) {
    lines.push(`曲式: ${audio.sections.map((section, index) => `${formatTimecode(section.start)}–${formatTimecode(section.end)} ${sectionZh(section.label, index)}`).join(' → ')}`)
  }
  lines.push('')

  // --- rhythm --------------------------------------------------------------
  lines.push('## 节奏')
  lines.push(`- BPM：${tempoDisplay(tempo)}${Array.isArray(tempo.bpmCandidates) && tempo.bpmCandidates.length > 1 ? ` · 自动相关候选 ${tempo.bpmCandidates.map((value) => num(value, 1)).join(' / ')}` : ''}`)
  lines.push(`- 拍数：${num(tempo.beatCount, 0)} · 节拍规律性 ${num(tempo.regularity, 2)} · 起音密度 ${num(rhythm.onsetsPerSecond, 2)} 个/秒（${rhythm.percussionDensity === 'dense' ? '密集' : rhythm.percussionDensity === 'sparse' ? '稀疏' : '中等'}）`)
  if (Array.isArray(tempo.beatTimes) && tempo.beatTimes.length > 0) {
    lines.push(`- 前 ${Math.min(16, tempo.beatTimes.length)} 个拍点：${tempo.beatTimes.slice(0, 16).map((t) => formatTimecode(t)).join(' ')}`)
  }
  lines.push('')

  // --- key & harmony -------------------------------------------------------
  lines.push('## 调性与和声')
  if (key === null) {
    lines.push('- 未能确定调性（无调性/打击乐为主/短片段）。')
  } else {
    const candidates = Array.isArray(key.candidates) ? key.candidates : []
    const topScore = Number.isFinite(Number(candidates[0]?.score)) ? `，相关度 ${num(candidates[0].score, 2)}` : ''
    lines.push(`- 主调：${keyZh(key)}（置信 ${num(key.confidence, 2)}${topScore}，调音偏移 ${num(key.tuned, 0, ' 音分')}）`)
    if (candidates.length > 1) {
      lines.push(`- 备选：${candidates.slice(1, 3).map((candidate) => `${candidate.name}（${num(candidate.score, 2)}）`).join(' / ')}${Number(key.confidence) < 0.3 ? ' — 候选之间差距很小，调性仅供参考' : ''}`)
    }
  }
  if (Array.isArray(audio.chroma?.mean) && audio.chroma.mean.length === 12) {
    const labels = Array.isArray(audio.chroma.labels) && audio.chroma.labels.length === 12 ? audio.chroma.labels : PITCH_NAMES
    const peaks = audio.chroma.mean
      .map((value, index) => ({ label: labels[index], value: Number(value) || 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
    lines.push(`- 平均音级能量（强弱排序）：${peaks.map((peak) => `${peak.label} ${num(peak.value, 2)}`).join(' / ')}`)
  }
  if (audio.chords !== null && typeof audio.chords === 'object') {
    const progression = Array.isArray(audio.chords.progression) ? audio.chords.progression : []
    if (progression.length > 0) {
      lines.push(`- 和弦进行（按拍识别，共 ${progression.length} 段，变化率 ${num(audio.chords.rate, 2)} 段/秒）：`)
      lines.push('')
      lines.push('| 起始 | 结束 | 和弦 | 置信 |')
      lines.push('|------|------|------|------|')
      const limit = detail === 'brief' ? 16 : 40
      for (const chord of progression.slice(0, limit)) {
        lines.push(`| ${formatTimecode(chord.start)} | ${formatTimecode(chord.end)} | ${chord.name} | ${num(chord.confidence, 2)} |`)
      }
      if (progression.length > limit) lines.push(`| … | … | 省略 ${progression.length - limit} 段 | |`)
      lines.push('')
    }
  }
  lines.push('')

  // --- structure -----------------------------------------------------------
  if (Array.isArray(audio.sections) && audio.sections.length > 0) {
    lines.push('## 曲式结构')
    lines.push('| 段 | 时间码 | 时长 | 相对能量 | BPM | 描述 |')
    lines.push('|----|--------|------|----------|-----|------|')
    audio.sections.forEach((section, index) => {
      lines.push(
        `| ${sectionZh(section.label, index)} | ${formatTimecode(section.start)}–${formatTimecode(section.end)} | ${num(section.duration, 1, 's')} | ${num(section.energy, 2)} ${bar(section.energy, 6)} | ${num(section.bpm, 0)} | ${section.note ?? '—'} |`,
      )
    })
    lines.push('')
  }

  // --- energy curve --------------------------------------------------------
  if (Array.isArray(audio.energyCurve) && audio.energyCurve.length > 0) {
    lines.push('## 能量曲线（低→高）')
    lines.push(`整体 ${sparkline(audio.energyCurve.map((point) => point.rms), 60)}`)
    lines.push(`低频 ${sparkline(audio.energyCurve.map((point) => point.low), 60)}`)
    lines.push(`高频 ${sparkline(audio.energyCurve.map((point) => point.high), 60)}`)
    lines.push('')
  }

  // --- loudness ------------------------------------------------------------
  lines.push('## 响度与动态')
  lines.push(`- 峰值 ${num(loudness.peakDbfs, 1, ' dBFS')} · RMS ${num(loudness.rmsDbfs, 1, ' dBFS')} · 积分响度 ${num(loudness.lufsIntegrated, 1, ' LUFS')} · 响度范围 LRA ${num(loudness.loudnessRangeLu, 1, ' LU')}`)
  lines.push(`- 动态范围 ${dynamicRangeZh(loudness)} · 削波占比 ${pct(loudness.clippingRatio, 2)} · 静音占比 ${pct(loudness.silenceRatio, 1)}`)
  const loudWords = []
  if (Number.isFinite(Number(loudness.lufsIntegrated))) {
    const lufs = Number(loudness.lufsIntegrated)
    if (lufs > -9) loudWords.push('母带电平偏高（响度战争式压缩）')
    else if (lufs > -14) loudWords.push('接近流媒体标准响度')
    else if (lufs > -20) loudWords.push('响度适中偏低')
    else loudWords.push('非常安静，动态保留充分')
  }
  if (Number(loudness.clippingRatio) > 0.001) loudWords.push('存在可闻削波')
  if (Number(loudness.silenceRatio) > 0.3) loudWords.push('静音/留白较多')
  if (loudWords.length > 0) lines.push(`- 判断：${loudWords.join('；')}`)
  lines.push('')

  // --- timbre --------------------------------------------------------------
  lines.push('## 音色与频段')
  lines.push(`- 质心 ${num(timbre.centroidHz, 0, ' Hz')} · rolloff ${num(timbre.rolloffHz, 0, ' Hz')} · 谱平坦度 ${num(timbre.flatness, 3)} · 过零率 ${num(timbre.zeroCrossRate, 3)} → ${timbreZh(timbre.brightness)}${timbre.description ? `（${timbre.description}）` : ''}`)
  lines.push(`- 频段占比：低频(<200Hz) ${pct(spectrum.lowRatio)} / 中频(200–2k) ${pct(spectrum.midRatio)} / 高频(>2k) ${pct(spectrum.highRatio)}`)
  lines.push('')

  // --- vocal ---------------------------------------------------------------
  lines.push('## 人声判断')
  lines.push(`- ${vocalZh(audio.vocals)}（启发式，置信 ${num(audio.vocals?.confidence, 2)}；纯音或强失真乐器容易误判）${audio.vocals?.note ? ` — ${audio.vocals.note}` : ''}`)
  lines.push('')

  // --- mood ----------------------------------------------------------------
  lines.push('## 情绪倾向（启发式，非确定结论）')
  lines.push(`- 唤醒度（能量/紧张感）${num(mood.arousal, 2)} ${bar(mood.arousal, 10)}`)
  lines.push(`- 效价（正向/愉悦感）${num(mood.valence, 2)} ${bar(mood.valence, 10)}`)
  lines.push(`- 标签：${moodZh(mood.labels)}`)
  if (mood.note) lines.push(`- 说明：${mood.note}`)
  lines.push('')

  // --- transcript ----------------------------------------------------------
  const transcript = typeof meta.transcript === 'string' ? meta.transcript.trim() : ''
  if (transcript.length > 0) {
    lines.push('## 语音/歌词转写（本地 whisper）')
    lines.push(transcript.length > 6000 ? `${transcript.slice(0, 6000)}\n…（转写过长已截断）` : transcript)
    lines.push('')
  }

  // --- artifacts -----------------------------------------------------------
  const artifacts = audio.artifacts ?? {}
  const artifactLines = []
  if (typeof artifacts.waveform === 'string') artifactLines.push(`- 波形图: \`${artifacts.waveform}\``)
  if (typeof artifacts.spectrogram === 'string') artifactLines.push(`- 频谱图: \`${artifacts.spectrogram}\``)
  if (typeof artifacts.chromaChart === 'string') artifactLines.push(`- 音级热力图: \`${artifacts.chromaChart}\``)
  if (typeof artifacts.energyChart === 'string') artifactLines.push(`- 能量曲线图: \`${artifacts.energyChart}\``)
  if (artifactLines.length > 0) {
    lines.push('## 生成的图像文件（可用 `read_image` 查看）')
    lines.push(...artifactLines)
    lines.push('')
  }

  lines.push('## 还可以问我')
  lines.push('- 想知道某个时间点在发生什么（和弦/能量/段落）：直接问，我按时间码引用上面的表格。')
  lines.push('- 如果是带画面的视频：`media_watch_video`，参数 `path`，会给出镜头表、关键帧亮度图和转写。')
  lines.push('- 想确认容器/编码：`media_probe`，参数 `path`。')

  const notes = Array.isArray(meta.asrNotes) ? meta.asrNotes.filter(Boolean) : []
  const warnings = Array.isArray(audio.warnings) ? audio.warnings : []
  if (notes.length > 0 || warnings.length > 0) {
    lines.push('')
    lines.push('## 提示与限制')
    for (const note of notes) lines.push(`- ${note}`)
    for (const warning of warnings) lines.push(`- ${warningZh(warning)}`)
  }
  return tidy(lines.join('\n'))
}

/* ------------------------------------------------------------ frame report */

/** Pixel size of the embedded still, from whichever field the tool layer set. */
function imagePixelSize(frame, meta) {
  const candidates = [
    [meta?.imageWidth, meta?.imageHeight],
    [meta?.width, meta?.height],
    [frame?.imageWidth, frame?.imageHeight],
    [frame?.width, frame?.height],
  ]
  for (const [width, height] of candidates) {
    if (Number.isFinite(Number(width)) && Number.isFinite(Number(height)) && Number(width) > 0 && Number(height) > 0) {
      return { width: Math.round(Number(width)), height: Math.round(Number(height)) }
    }
  }
  return undefined
}

/**
 * Vision-mode caption for one still: what got embedded, which crop was used and
 * how to ask for a tighter `region` crop. Blind mode keeps its ASCII art and
 * needs none of this.
 */
function frameVisionCaptionLines(frame, meta, imagePlan) {
  const lines = []
  const hasImage = typeof meta.imagePath === 'string' && meta.imagePath.length > 0
  if (hasImage || imagePlan.length > 0) {
    const size = imagePixelSize(frame, meta)
    lines.push(hasImage
      ? `图像: 原图已内嵌${size === undefined ? '' : `（${size.width}×${size.height}）`}，需要更细可再取 region（"x,y,w,h" 原图像素）。`
      : '图像: 本次未能内嵌画面（保存失败），请用 `media_frame` 重试，或按上面的路径自行读取。')
  }
  const region = typeof meta.region === 'string' && meta.region.trim().length > 0 ? meta.region.trim() : undefined
  if (region !== undefined) {
    lines.push(`裁剪区域: ${region}（原图像素）`)
  } else if (frame?.crop?.kind === 'region') {
    lines.push(`裁剪区域: ${frame.crop.x},${frame.crop.y},${frame.crop.width},${frame.crop.height}（原图像素）`)
  } else if (frame?.crop?.kind === 'zoom') {
    lines.push(`中心放大: ${num(Number(frame.crop.factor), 2)}×`)
  }
  return lines
}

/**
 * Render a single-frame inspection.
 *
 * @param {object} frame result of the frame analysis
 * @param {{file: string, time: number, imagePath?: string, isImage?: boolean, target?: 'blind'|'vision', imagePlan?: object[], region?: string}} meta
 */
export function renderFrameReport(frame, meta) {
  const vision = isVisionMode(meta)
  const imagePlan = vision ? imagePlanOf(meta) : []
  const lines = []
  lines.push(`# ${meta.isImage === true ? '图像感知' : '单帧感知'} · ${basenameOf(meta.file)}`)
  lines.push('')
  lines.push(`来源: \`${meta.file}\`${meta.isImage === true ? '' : ` · 时间点 ${formatTimecode(meta.time)}`}`)
  if (typeof meta.imagePath === 'string') {
    lines.push(vision
      ? `画面文件: \`${meta.imagePath}\`（已内嵌，可直接看）`
      : `画面文件: \`${meta.imagePath}\` — 可用 \`read_image\` 直接查看`)
  }
  if (vision) lines.push(...frameVisionCaptionLines(frame, meta, imagePlan))
  lines.push('')

  const summary = frame?.summary ?? {}
  lines.push('## 画面指标')
  if (vision) {
    // Numbers and hex only: the model can judge colour and composition itself.
    lines.push(`- 亮度 ${num(summary.brightness, 2)} · 彩度 ${num(summary.saturation, 2)} · 主色 ${hueZh(summary.hueName)} ${summary.hueHex ?? ''}`)
    lines.push(`- 对比度 ${num(summary.contrast, 2)} · 边缘密度 ${num(summary.edgeDensity, 2)}`)
  } else {
    lines.push(`- 亮度 ${num(summary.brightness, 2)}（${brightnessZh(summary.brightness)}）· 彩度 ${num(summary.saturation, 2)}（${saturationZh(summary.saturation)}）· 主色 ${hueZh(summary.hueName)} ${summary.hueHex ?? ''}`)
    lines.push(`- 对比度 ${num(summary.contrast, 2)} · 边缘密度 ${num(summary.edgeDensity, 2)}（${summary.edgeDensity > 0.45 ? '纹理极密集' : summary.edgeDensity > 0.25 ? '细节较多（文字、图表或高频纹理）' : summary.edgeDensity > 0.1 ? '细节适中' : '画面简洁/大片纯色'}）`)
    lines.push(`- 版式判断: ${summary.layout ?? '—'}`)
  }
  lines.push('')

  if (Array.isArray(summary.palette) && summary.palette.length > 0) {
    lines.push('## 配色')
    lines.push(summary.palette.map((entry) => `${entry.hex} ${pct(entry.share)}`).join(' · '))
    lines.push('')
  }

  if (!vision) {
    const art = fitArt(frame?.ascii, 56, 22)
    if (art.length > 0) {
      lines.push('## 亮度图（空格最暗，`@` 最亮；纵轴=上→下，横轴=左→右）')
      lines.push('```')
      lines.push(art)
      lines.push('```')
      lines.push('')
    }
    const hueMap = fitArt(frame?.hueMap, 56, 22)
    if (hueMap.length > 0) {
      lines.push('## 色相图（R红 O橙 Y黄 G绿 C青 B蓝 M洋红，`.`=灰/黑/白）')
      lines.push('```')
      lines.push(hueMap)
      lines.push('```')
      lines.push('')
    }
    if (Array.isArray(frame?.notes) && frame.notes.length > 0) {
      lines.push('## 观察')
      for (const note of frame.notes) lines.push(`- ${note}`)
      lines.push('')
    }
  }
  if (Array.isArray(frame?.warnings) && frame.warnings.length > 0) {
    lines.push('## 提示')
    for (const warning of frame.warnings) lines.push(`- ${warning}`)
  }
  return tidy(lines.join('\n'))
}

/* --------------------------------------------------------- helper exports */

export { fitArt, sparkline, bar, pct, num, hueZh, brightnessZh, saturationZh, saturationZhVideo, motionZh, tempoZh, sectionZh, moodZh, vocalZh, tidy, layoutZh }








