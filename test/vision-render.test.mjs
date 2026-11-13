#!/usr/bin/env node
/**
 * Dual-target report test (CONTRACT-V3 module A, owner: vision-render).
 *
 *   node test/vision-render.test.mjs
 *
 * Pure rendering: every fixture below is a hand-constructed analysis object, so
 * no ffmpeg, no images and no model route are needed. The test pins down the two
 * presentation targets:
 *
 *   - blind (default / target:'blind') is byte-for-byte the v2 report: ASCII
 *     luminance + hue blocks, the "亮度图用字符密度…" paragraph, `版式:` lines and
 *     the adjective judgements (偏暗 / 低彩度 / 色彩浓烈 / 几乎静止 …).
 *   - vision (target:'vision') leads with `## 看图说明` + the 格号→时间码 index,
 *     keeps every numeric section, drops the ASCII substitute and the adjectives,
 *     and ends with `## 观察清单（用眼睛回答）` whose last line is the fixed
 *     citation line.
 *
 * `meta.imagePlan` is computed by the tool layer and passed in; this renderer only
 * phrases it. Empty / malformed plans must still render cleanly (no empty table,
 * no dangling heading).
 */
import assert from 'node:assert/strict'
import { renderFrameReport, renderVideoReport } from '../lib/render.js'
import { renderAnimateReport, renderBuildReport, renderChangeSection, renderSeeReport } from '../lib/render-v2.js'

let passed = 0
const failures = []

async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.log(`FAIL ${label} — ${error.message}`)
  }
}

/* ---------------------------------------------------------------- fixtures */

/** 20 rows × 44 columns of the luminance ramp: enough for a real code block. */
const LUMINANCE_ART = Array.from({ length: 20 }, (_, row) => ' .:-=+*#%@'.repeat(5).slice(row % 3, (row % 3) + 44)).join('\n')
/** Same shape, hue letters as the engine emits them. */
const HUE_ART = Array.from({ length: 20 }, (_, row) => 'RRGGBBYYCCMM..BBGG'.repeat(3).slice(row % 2, (row % 2) + 44)).join('\n')

const AUDIO = {
  format: { codec: 'aac', sampleRate: 44_100, channels: 2 },
  tempo: { bpm: 120, confidence: 0.9, beatCount: 12, timeSignatureGuess: 4 },
  key: { tonic: 'C', mode: 'major', confidence: 0.8, candidates: [{ name: 'C major', score: 0.8 }] },
  loudness: { peakDbfs: -1, rmsDbfs: -14, lufsIntegrated: -16, dynamicRangeDb: 8, silenceRatio: 0.05 },
  timbre: { brightness: 'warm', centroidHz: 1800, rolloffHz: 4200, flatness: 0.2 },
  spectrum: { lowRatio: 0.3, midRatio: 0.5, highRatio: 0.2 },
  vocals: { present: false, confidence: 0.7 },
  mood: { arousal: 0.6, valence: 0.5, labels: ['bright'] },
  sections: [{ start: 0, end: 6, label: 'section' }],
}

const ANALYSIS = {
  duration: 6,
  stream: { width: 1280, height: 720, fps: 25, codec: 'h264' },
  format: { container: 'mov,mp4', sizeBytes: 1_234_567 },
  global: {
    shotCount: 3,
    cutRate: 20,
    avgBrightness: 0.42,
    avgSaturation: 0.18,
    avgMotion: 6.4,
    dominantHues: [{ name: 'blue', share: 0.4 }, { name: 'cyan', share: 0.25 }],
    aspectRatio: '16:9',
  },
  shots: [
    {
      index: 0,
      start: 0,
      end: 2,
      duration: 2,
      brightness: 0.12,
      saturation: 0.05,
      hueName: 'blue',
      hueHex: '#1a2b8b',
      motion: 0.4,
      palette: [{ hex: '#101a3b', share: 0.5 }, { hex: '#2b1a4a', share: 0.3 }],
      ascii: LUMINANCE_ART,
      hueMap: HUE_ART,
      layout: 'high contrast / centre brighter than edges',
      keyframe: 'keyframes/keyframe-000.jpg',
    },
    {
      index: 1,
      start: 2,
      end: 4.5,
      duration: 2.5,
      brightness: 0.63,
      saturation: 0.34,
      hueName: 'orange',
      hueHex: '#c46a2b',
      motion: 12.5,
      palette: [{ hex: '#3b2410', share: 0.42 }, { hex: '#c46a2b', share: 0.31 }],
      ascii: LUMINANCE_ART,
      hueMap: HUE_ART,
      layout: 'bottom brighter than top',
      keyframe: 'keyframes/keyframe-001.jpg',
    },
    {
      index: 2,
      start: 4.5,
      end: 6,
      duration: 1.5,
      brightness: 0.88,
      saturation: 0.62,
      hueName: 'yellow',
      hueHex: '#e8c33a',
      motion: 3,
      palette: [{ hex: '#e8c33a', share: 0.55 }, { hex: '#fff2b0', share: 0.2 }],
      ascii: LUMINANCE_ART,
      hueMap: HUE_ART,
      layout: 'uniform brightness',
      keyframe: 'keyframes/keyframe-002.jpg',
    },
  ],
  timeline: [
    { t: 0, brightness: 0.1, saturation: 0.05, motion: 0.2 },
    { t: 1, brightness: 0.2, saturation: 0.08, motion: 0.6 },
    { t: 2, brightness: 0.63, saturation: 0.34, motion: 12.5 },
    { t: 4.5, brightness: 0.88, saturation: 0.62, motion: 3 },
  ],
  flags: { frozen: [{ start: 1, end: 1.5 }], black: [], silent: [] },
  audio: AUDIO,
  warnings: [],
}

/**
 * The tool layer makes contact-sheet cells 1-based and filmstrip cells 0-based;
 * both must render as 1/2/3 in the index table.
 */
const IMAGE_PLAN = [
  {
    kind: 'contact-sheet',
    caption: '联系表：3 个镜头格，按左上→右下排列，格内带时间码水印',
    cells: [
      { index: 1, time: 0, timecode: '0:00.000' },
      { index: 2, time: 2, timecode: '0:02.000' },
      { index: 3, time: 4.5, timecode: '0:04.500' },
    ],
  },
  {
    kind: 'filmstrip',
    caption: '时间条：首/中/尾三帧，从左到右推进',
    cells: [
      { index: 0, time: 0, timecode: '0:00.000' },
      { index: 1, time: 3, timecode: '0:03.000' },
      { index: 2, time: 5.9, timecode: '0:05.900' },
    ],
  },
]

const VIDEO_META = {
  file: 'C:/media/demo.mp4',
  detail: 'full',
  transcript: '这是测试旁白，说明片子开始。',
  asrNotes: [],
}

const ADJECTIVE_WORDS = ['偏暗', '低彩度', '色彩浓烈', '几乎静止', '很暗', '很亮', '中等亮度', '高对比', '偏亮', '中等彩度', '几乎全黑']

/* ------------------------------------------------- video: blind regression */

const blindReport = renderVideoReport(ANALYSIS, { ...VIDEO_META, target: 'blind' })
const defaultReport = renderVideoReport(ANALYSIS, VIDEO_META)

await check('blind default output is byte-for-byte the explicit blind output', () => {
  assert.equal(defaultReport, blindReport)
})

await check('blind keeps the ASCII structure section and code blocks', () => {
  assert.match(blindReport, /## 画面结构（亮度图 \+ 色相图）/u)
  assert.match(blindReport, /亮度图用字符密度表示明暗/u)
  assert.match(blindReport, /```/u)
  assert.match(blindReport, /色相图:/u)
  assert.match(blindReport, /版式: 高对比、中心亮、四周暗（主体居中）/u)
})

await check('blind keeps the adjective judgements', () => {
  assert.match(blindReport, /几乎静止/u)
  assert.match(blindReport, /几乎全黑/u)
  assert.match(blindReport, /中等彩度/u)
})

await check('blind has no vision blocks', () => {
  assert.ok(!blindReport.includes('## 看图说明'), 'blind must not show 看图说明')
  assert.ok(!blindReport.includes('## 观察清单'), 'blind must not show 观察清单')
  assert.ok(!blindReport.includes('呈现模式'), 'blind must not show 呈现模式')
})

/* --------------------------------------------------- video: vision target */

const visionReport = renderVideoReport(ANALYSIS, { ...VIDEO_META, target: 'vision', imagePlan: IMAGE_PLAN })

await check('vision opens with 看图说明 per-image captions', () => {
  assert.match(visionReport, /## 看图说明/u)
  assert.match(visionReport, /- 【联系表】3 个镜头格，按左上→右下排列，格内带时间码水印；格号→时间码见下表/u)
  assert.match(visionReport, /- 【时间条】首\/中\/尾三帧，从左到右推进；格号→时间码见下表/u)
  assert.match(visionReport, /坐标约定: 格号 A1 = 左上第一格/u)
})

await check('vision index table carries the exact cell timecodes', () => {
  assert.match(visionReport, /格号 → 时间码/u)
  assert.match(visionReport, /\| 格 \| 时间码 \|/u)
  for (const timecode of ['0:00.000', '0:02.000', '0:04.500', '0:03.000', '0:05.900']) {
    assert.ok(visionReport.includes(timecode), `missing timecode ${timecode}`)
  }
  // 1-based contact-sheet indices and 0-based filmstrip indices both render as 1/2/3.
  assert.match(visionReport, /\| 1 \| 0:00\.000 \|/u)
  assert.match(visionReport, /\| 3 \| 0:04\.500 \|/u)
})

await check('vision prints the presentation-mode metadata line', () => {
  assert.match(visionReport, /呈现模式: vision（已内嵌 2 张图；文本不含字符图）/u)
  assert.ok(!blindReport.includes('呈现模式: vision'))
})

await check('vision drops every ASCII substitute and 版式 line', () => {
  assert.ok(!visionReport.includes('画面结构'), '画面结构 survived')
  assert.ok(!visionReport.includes('亮度图'), '亮度图 explanation survived')
  assert.ok(!visionReport.includes('```'), 'code block survived')
  assert.ok(!visionReport.includes('版式'), '版式 survived')
  assert.ok(!visionReport.includes('色相图'), '色相图 survived')
  assert.ok(!visionReport.includes('关键帧: `'), 'per-shot keyframe line survived')
})

await check('vision contains no adjective judgement words', () => {
  for (const word of ADJECTIVE_WORDS) {
    assert.ok(!visionReport.includes(word), `adjective ${word} survived in vision report`)
  }
})

await check('vision keeps the numeric shot table (no adjective suffix)', () => {
  assert.match(visionReport, /## 镜头时间线/u)
  assert.match(visionReport, /\| # \| 时间码 \| 时长 \| 亮度 \| 彩度 \| 色调 \| 运动 \| 主要颜色 \|/u)
  assert.match(visionReport, /\| 1 \| 0:00\.000–0:02\.000 \| 2\.00s \| 0\.12 \| 0\.05 \| 蓝 #1a2b8b \| 0\.4 \| #101a3b\(50%\) #2b1a4a\(30%\) \|/u)
  assert.match(visionReport, /\| 3 \| 0:04\.500–0:06\.000 \| 1\.50s \| 0\.88 \| 0\.62 \| 黄 #e8c33a \| 3\.0 \|/u)
})

await check('vision keeps curves / transcript / audio digest / flags', () => {
  assert.match(visionReport, /## 逐秒曲线（低→高）/u)
  assert.match(visionReport, /## 语音内容/u)
  assert.match(visionReport, /这是测试旁白/u)
  assert.match(visionReport, /## 声音特征（同一文件音轨）/u)
  assert.match(visionReport, /BPM ≈ 120/u)
  assert.match(visionReport, /## 健康与内容判断/u)
  assert.match(visionReport, /冻帧: 0:01\.000–0:01\.500/u)
})

await check('vision ends with 观察清单 and the exact citation line', () => {
  assert.match(visionReport, /## 观察清单（用眼睛回答）/u)
  const lines = visionReport.split('\n')
  assert.equal(lines[lines.length - 1], '回答时请引用格号与时间码，不要重复上面的数字表。')
  const start = lines.findIndex((line) => line.includes('## 观察清单'))
  assert.ok(start > 0, 'no 观察清单 heading')
  const tasks = lines.slice(start).filter((line) => /^\d+\. /u.test(line))
  assert.ok(tasks.length >= 8 && tasks.length <= 10, `tasks ${tasks.length}`)
  assert.ok(tasks.some((task) => task.includes('逐格描述（共 3 格）')), 'no per-cell description task')
  assert.ok(tasks.some((task) => task.includes('media_frame') && task.includes('region')), 'no region crop task')
  assert.ok(tasks.some((task) => task.includes('最暗的镜头') && task.includes('最亮的镜头')), 'no darkest/brightest task')
})

await check('vision is shorter than blind while keeping the numbers', () => {
  assert.ok(visionReport.length < blindReport.length, `vision ${visionReport.length} vs blind ${blindReport.length}`)
  assert.ok(blindReport.length - visionReport.length > 1000, `only saved ${blindReport.length - visionReport.length} chars`)
  for (const token of ['0.12', '0.88', '#1a2b8b', '#e8c33a', '0:04.500', '-16.0 LUFS']) {
    assert.ok(visionReport.includes(token), `vision lost numeric token ${token}`)
    assert.ok(blindReport.includes(token), `blind lost numeric token ${token}`)
  }
  console.log(`\n  blind ${blindReport.length} chars vs vision ${visionReport.length} chars (same analysis)`)
})

await check('empty imagePlan still renders cleanly with no dangling table', () => {
  const empty = renderVideoReport(ANALYSIS, { ...VIDEO_META, target: 'vision', imagePlan: [] })
  assert.match(empty, /呈现模式: vision（已内嵌 0 张图；文本不含字符图）/u)
  assert.ok(!empty.includes('## 看图说明'), 'empty plan must not emit 看图说明')
  assert.ok(!empty.includes('| 格 | 时间码 |'), 'empty plan must not emit a mapping table')
  assert.ok(!empty.includes('画面结构'), 'vision must stay blind-art free')
  assert.match(empty, /## 观察清单（用眼睛回答）/u)
  assert.equal(empty.split('\n').at(-1), '回答时请引用格号与时间码，不要重复上面的数字表。')
})

await check('vision tolerates malformed imagePlan entries', () => {
  const weird = renderVideoReport(ANALYSIS, {
    ...VIDEO_META,
    target: 'vision',
    imagePlan: [null, {}, { kind: 'spectrogram', caption: '', cells: [] }],
  })
  assert.match(weird, /- 【频谱图】频谱图已内嵌/u)
  assert.ok(!weird.includes('| 格 | 时间码 |'))
})

await check('vision appendix sections land before 观察清单 (checklist stays last)', () => {
  const appendix = ['## 制作技法（这条片子是怎么做出来的）', '- 剪辑节奏：3 个镜头 · 平均镜头 2.00 秒']
  const withAppendix = renderVideoReport(ANALYSIS, { ...VIDEO_META, target: 'vision', imagePlan: IMAGE_PLAN, appendix })
  const craftAt = withAppendix.indexOf('## 制作技法')
  const checklistAt = withAppendix.indexOf('## 观察清单')
  assert.ok(craftAt > 0, 'appendix section missing')
  assert.ok(checklistAt > craftAt, '观察清单 must come after the appendix')
  assert.equal(withAppendix.split('\n').at(-1), '回答时请引用格号与时间码，不要重复上面的数字表。')
  // Blind mode must ignore the appendix (byte-for-byte blind output).
  assert.equal(renderVideoReport(ANALYSIS, { ...VIDEO_META, appendix }), blindReport)
})

await check('vision samples the index when a sheet has more than 24 cells', () => {
  const cells = Array.from({ length: 30 }, (_, index) => ({ index: index + 1, time: index * 0.5 }))
  const report = renderVideoReport(ANALYSIS, {
    ...VIDEO_META,
    target: 'vision',
    imagePlan: [{ kind: 'contact-sheet', caption: '联系表：30 个镜头格', cells }],
  })
  assert.match(report, /共 30 格，上表每 2 格只列 1 格/u)
  const indexRows = report.split('\n').filter((line) => /^\| \d+ \| \d+:\d+\.\d+ \|$/u.test(line))
  assert.equal(indexRows.length, 15, `index rows ${indexRows.length}`)
  assert.ok(indexRows.some((line) => line.includes('| 29 |')), 'last sampled cell missing')
  assert.ok(report.split('\n').at(-1) === '回答时请引用格号与时间码，不要重复上面的数字表。')
})

/* --------------------------------------------------------- frame report */

const FRAME = {
  summary: {
    brightness: 0.31,
    saturation: 0.17,
    hueName: 'blue',
    hueHex: '#2b4a8b',
    contrast: 0.22,
    edgeDensity: 0.4,
    layout: '上亮下暗，中心亮、四周暗（主体居中）',
    palette: [{ hex: '#101a3b', share: 0.5 }, { hex: '#2b1a4a', share: 0.3 }],
  },
  ascii: LUMINANCE_ART,
  hueMap: HUE_ART,
  notes: ['细节密集，可能是文字、图表或复杂场景', '低对比，画面灰平'],
  warnings: [],
  crop: { kind: 'region', x: 10, y: 20, width: 300, height: 200 },
}

const frameBlind = renderFrameReport(FRAME, { file: 'C:/media/poster.png', time: 0, imagePath: 'C:/out/frame.jpg', isImage: true })
const frameVision = renderFrameReport(FRAME, {
  file: 'C:/media/poster.png',
  time: 0,
  imagePath: 'C:/out/frame.jpg',
  isImage: true,
  target: 'vision',
  imagePlan: [{ kind: 'detail', caption: '原图已内嵌（可再用 region 取局部）' }],
  region: '10,20,300,200',
  width: 1920,
  height: 1080,
})

await check('frame blind keeps ASCII, hue art and the layout judgement', () => {
  assert.match(frameBlind, /## 亮度图/u)
  assert.match(frameBlind, /## 色相图/u)
  assert.match(frameBlind, /版式判断: 上亮下暗/u)
  assert.match(frameBlind, /## 观察/u)
  assert.match(frameBlind, /低对比/u)
})

await check('frame vision substitutes the embedded-image caption + region hint', () => {
  assert.match(frameVision, /图像: 原图已内嵌（1920×1080），需要更细可再取 region（"x,y,w,h" 原图像素）。/u)
  assert.match(frameVision, /裁剪区域: 10,20,300,200（原图像素）/u)
  assert.match(frameVision, /内嵌/u)
  assert.ok(!frameVision.includes('亮度图'), 'frame vision kept 亮度图')
  assert.ok(!frameVision.includes('色相图'), 'frame vision kept 色相图')
  assert.ok(!frameVision.includes('版式判断'), 'frame vision kept 版式判断')
  assert.ok(!frameVision.includes('```'), 'frame vision kept an ASCII fence')
  assert.ok(!frameVision.includes('## 观察'), 'frame vision kept adjective notes')
  assert.ok(!frameVision.includes('细节密集'), 'frame vision kept adjective note text')
})

await check('frame vision keeps numbers and palette hex', () => {
  assert.match(frameVision, /- 亮度 0\.31 · 彩度 0\.17 · 主色 蓝 #2b4a8b/u)
  assert.match(frameVision, /- 对比度 0\.22 · 边缘密度 0\.40/u)
  assert.match(frameVision, /## 配色/u)
  assert.match(frameVision, /#101a3b 50%/u)
})

await check('frame vision admits a failed still instead of claiming an image', () => {
  const failed = renderFrameReport(FRAME, { file: 'C:/media/poster.png', time: 0, isImage: true, target: 'vision', imagePlan: [{ kind: 'detail', caption: '画面已内嵌' }] })
  assert.match(failed, /本次未能内嵌画面/u)
  assert.ok(!failed.includes('原图已内嵌'), 'claimed an embedded image that does not exist')
})

/* ------------------------------------------------------ see (screen) report */

const SEE_SUMMARY = { brightness: 0.42, saturation: 0.2, hueName: 'grey', hueHex: '#6b7280', contrast: 0.3, edgeDensity: 0.34, layout: '上亮下暗' }
const seePeek = (extra = {}) => renderSeeReport({
  action: 'peek',
  engine: 'desktop',
  width: 1920,
  height: 1080,
  elapsedMs: 120,
  summary: SEE_SUMMARY,
  ascii: LUMINANCE_ART,
  layout: '上亮下暗',
  ...extra,
})
const seeWatch = (extra = {}) => renderSeeReport({
  action: 'watch',
  seconds: 6,
  engine: 'desktop',
  width: 1920,
  height: 1080,
  elapsedMs: 800,
  frameCount: 72,
  kept: 3,
  selectionRule: '变化分',
  tokenEstimate: 300,
  columns: 2,
  rows: 2,
  sheetWidth: 840,
  sheetHeight: 840,
  shots: [
    { time: 0, score: 0, reason: 'fallback' },
    { time: 2, score: 24.5, reason: 'cut' },
    { time: 4.5, score: 8.2, reason: 'integrated' },
  ],
  changes: ['0:02.000 · 画面切换 · 变化分 25'],
  ...extra,
})

await check('see peek blind keeps the ASCII art and layout line', () => {
  const report = seePeek()
  assert.match(report, /## 亮度图/u)
  assert.match(report, /版式：上亮下暗/u)
  assert.match(report, /这条结果末尾已附带当前屏幕的截图/u)
})

await check('see peek vision is the one-liner + observation list, no ASCII', () => {
  const report = seePeek({ target: 'vision' })
  assert.match(report, /截图已内嵌，请直接读出屏幕上的文字与关键 UI 元素/u)
  assert.match(report, /## 观察清单（用眼睛回答）/u)
  assert.match(report, /- 亮度 0\.42 · 彩度 0\.20 · 主色 灰 #6b7280/u)
  assert.ok(!report.includes('亮度图'), 'see peek vision kept 亮度图')
  assert.ok(!report.includes('版式'), 'see peek vision kept 版式')
  assert.match(report, /region/u)
  const tasks = report.split('\n').filter((line) => /^\d+\. /u.test(line))
  assert.ok(tasks.length >= 3 && tasks.length <= 5, `see tasks ${tasks.length}`)
})

await check('see watch keeps the grid table in both targets', () => {
  assert.match(seeWatch(), /\| # \| 时间 \| 变化分 \| 原因 \|/u)
  assert.match(seeWatch({ target: 'vision' }), /\| # \| 时间 \| 变化分 \| 原因 \|/u)
  assert.match(seeWatch({ target: 'vision' }), /\| 2 \| 0:02\.000 \| 24\.5 \| 画面切换 \|/u)
})

await check('see watch vision explains frame order and drops the change log', () => {
  const blind = seeWatch()
  const vision = seeWatch({ target: 'vision' })
  assert.match(blind, /## 这期间屏幕怎么动的/u)
  assert.ok(!vision.includes('这期间屏幕怎么动的'), 'vision kept the verbal change log')
  assert.match(vision, /图注: 每格是一次界面变化，按行优先（左上→右下）逐行排列/u)
  assert.match(vision, /逐行排列/u)
  assert.match(vision, /捕获 72 帧 → 按变化量保留 3 帧/u)
})

/* ------------------------------------------------ build / animate reports */

const BUILD_RESULT = {
  output: 'C:/out/replica.mp4',
  duration: 7.7,
  width: 1080,
  height: 1920,
  fps: 30,
  bytes: 1_234_567,
  scenes: 4,
  renderSeconds: 12.3,
  audio: { music: true, voiceoverSegments: 1, loudnessNormalized: true },
  timeline: [
    { index: 0, type: 'text', start: 0, end: 2.2 },
    { index: 1, type: 'image', start: 2.2, end: 5 },
  ],
  warnings: [],
}
const BUILD_VERIFY = {
  shots: 4,
  brightness: 0.44,
  motion: 5.2,
  bpm: 100,
  craft: {
    cutRhythm: { avgShotLength: 1.9, cutRatePerMin: 31.2 },
    grading: { signature: ['high-contrast', 'warm'] },
    beatSync: { cutsOnBeatRatio: 0.75 },
  },
}
const BUILD_META = {
  plan: { scenes: [{}, {}, {}, {}] },
  verify: BUILD_VERIFY,
  targets: { avgShotLength: 2, bpm: 100 },
}
const BUILD_FILMSTRIP = [{
  kind: 'filmstrip',
  caption: '成片段：首/中/尾三帧，从左到右',
  cells: [
    { index: 0, time: 0, timecode: '0:00.000' },
    { index: 1, time: 3.85, timecode: '0:03.850' },
    { index: 2, time: 7.7, timecode: '0:07.700' },
  ],
}]

await check('build blind keeps the adjective grading label and no strip note', () => {
  const report = renderBuildReport(BUILD_RESULT, { ...BUILD_META, target: 'blind' })
  assert.match(report, /调色标签：高对比、暖调/u)
  assert.ok(!report.includes('成片段'), 'blind build claimed an embedded strip')
})

await check('build vision points at the strip and strips 自检 adjectives', () => {
  const report = renderBuildReport(BUILD_RESULT, { ...BUILD_META, target: 'vision', imagePlan: BUILD_FILMSTRIP })
  assert.match(report, /成片段（首\/中\/尾三帧，左→右）已内嵌/u)
  assert.match(report, /0:03\.850/u)
  assert.match(report, /## 时间线/u)
  assert.ok(!report.includes('调色标签'), 'vision kept the adjective grading label')
  assert.match(report, /- 镜头数 4 · 平均镜头 1\.90 秒 · 每分钟 31\.2 次剪辑/u)
  assert.match(report, /- 平均亮度 0\.44 · 平均运动量 5\.2 \/ 100/u)
  assert.match(report, /目标镜头长 2s vs 实测 1\.90s/u)
})

await check('build vision without a filmstrip leaves the blind body alone', () => {
  const report = renderBuildReport(BUILD_RESULT, { ...BUILD_META, target: 'vision', imagePlan: [] })
  assert.ok(!report.includes('成片段'), 'no strip plan must not claim an embedded strip')
  assert.match(report, /调色标签：高对比、暖调/u)
})

const ANIMATE_RESULT = { output: 'C:/out/anim.mp4', duration: 1, width: 480, height: 640, fps: 12, frames: 12, bytes: 3400, renderSeconds: 1.2, warnings: [] }
const ANIMATE_META = { styleId: 'Z1', htmlPath: 'C:/w/anim.html', previewPath: 'C:/w/preview.jpg' }

await check('animate vision mentions the embedded strip, blind does not', () => {
  const blind = renderAnimateReport(ANIMATE_RESULT, { ...ANIMATE_META, target: 'blind' })
  const vision = renderAnimateReport(ANIMATE_RESULT, {
    ...ANIMATE_META,
    target: 'vision',
    imagePlan: [{ kind: 'filmstrip', caption: '动画首/中/尾三帧，从左到右' }],
  })
  assert.ok(!blind.includes('成片段'), 'animate blind claimed an embedded strip')
  assert.match(vision, /成片段（首\/中\/尾三帧，左→右）已内嵌/u)
  assert.match(vision, /## 拼进成片/u)
  assert.match(vision, /"src": "C:\/out\/anim\.mp4"/u)
})

await check('animate vision without a filmstrip only posts the preview', () => {
  const report = renderAnimateReport(ANIMATE_RESULT, { ...ANIMATE_META, target: 'vision', imagePlan: [{ kind: 'preview', caption: '单帧预览' }] })
  assert.ok(!report.includes('成片段'), 'no filmstrip plan must not claim a strip')
  assert.match(report, /预览帧: `C:\/w\/preview\.jpg`/u)
})

await check('change-selection section keeps blind wording and stops advertising hue art in vision', () => {
  const change = { mean: 4.2, p95: 20, cuts: [1, 2], selected: [{ time: 1, reason: 'cut', score: 20 }], scoreCurve: [1, 2, 3, 4, 5] }
  const blind = renderChangeSection(change)
  const vision = renderChangeSection(change, { target: 'vision' })
  assert.match(blind, /更细的亮度\/色相图/u)
  assert.match(vision, /region/u)
  assert.ok(!vision.includes('亮度/色相图'), 'vision still advertises deleted ASCII art')
  assert.match(vision, /## 画面变化（按信息量选帧）/u)
  assert.match(vision, /平均变化分 4\.2/u)
})

/* --------------------------------------------------------------- summary */

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('ALL PASS')
