# media-senses v3 — 视觉模型适配（vision pipeline）

目标：同一套数据，**给盲模型和视觉模型两种呈现**。盲模型保持现状（字符图 + 形容词）；
视觉模型改为「图在前、文字只做索引与提问」，并提供局部裁剪、批量取帧、参考/成片对比。

本契约是 Lead 与两名 teammate 的接口。先读 `lib/ffmpeg.js`、`lib/png.js`、`CONTRACT-V2.md`
（build 引擎）、以及 `index.js` 里现有的 `inlineImage()` 与各工具注册。

## 硬性约束（与之前相同）

- ESM；零运行时依赖（Node 内置 + `lib/ffmpeg.js` + `lib/png.js`）；`node --check` 干净。
- ffmpeg 一律 `cwd = workDir` + filtergraph 内用相对文件名；绝对路径只能出现在 `-i`/`-map`/输出参数。
- 只写自己名下的文件；输出严格 JSON 可序列化、数值有限。
- **盲路径零回归**：所有新行为必须由 `target:'vision'` 或显式参数触发；默认（无 target / target:'blind'）
  的输出必须与现在一致，现有 231 项断言不许变红。

## 共享概念

Lead 会在工具层算好一个 **imagePlan** 传给渲染器（渲染器不做图像处理，只负责措辞/排版）：

```ts
type ImagePlanEntry = {
  kind: 'contact-sheet' | 'filmstrip' | 'detail' | 'spectrogram' | 'waveform' | 'compare' | 'preview'
  caption: string                 // 一句话：这是什么图
  path?: string                   // 仅用于报告里写路径（可省略）
  cells?: Array<{ index: number, time: number, timecode: string, label?: string }>
                                  // 格号→时间码映射（contact-sheet/filmstrip/compare 用）
  note?: string
}
```

## 模块 A — `render.js` + `render-v2.js` 双模式（owner: vision-render）

在现有导出上**追加** `meta.target?: 'blind' | 'vision'` 与 `meta.imagePlan?: ImagePlanEntry[]`，
默认 `'blind'`，行为与今天完全一致。

### A1. `renderVideoReport(analysis, meta)`

`target:'vision'` 时：

1. **开头**（标题/规格之后）先给「## 看图说明」：
   - 每张图一行：`- 【联系表】12 个镜头格，按左上→右下排列；格号→时间码见下表`
   - 若 `cells` 存在，输出一张紧凑映射表：`| 格 | 时间码 |`（每行最多 6 列的多列排版或普通两列表，
     ≤ 24 行；超过则只列每 2 格一次并注明）
   - 一句坐标系约定：`格号 A1 = 左上第一格；"第 3 格"指按行优先数的第 3 个画面`
2. **删除**（视觉模型自己看得到）：每个镜头的 `ascii` 代码块、`hueMap` 代码块、「亮度图用字符密度…」说明段、
   `layout`（`版式: …`）以及形容词式判断（`偏暗/低彩度/色彩浓烈/几乎静止`）——只保留**数字**：
   `| # | 时间码 | 时长 | 亮度 | 彩度 | 色调 hex | 运动 | 主色 hex |`
3. **保留**：镜头表数字、逐秒曲线（sparkline 仍保留，它是索引不是替代）、语音内容、声音特征、
   健康标记、变化量选帧节、仿制要点/recipe（若传入）
4. **结尾**新增「## 观察清单（用眼睛回答）」：8–10 条具体任务，措辞由数据生成但不给答案，例如
   - `逐格描述：每格的主体是什么、在做什么、场景类型（室内/室外/特写/全景）`
   - `比较第 1 格与最后一格：构图、景别、光线发生了什么变化`
   - `读出画面里出现的所有文字（标题/字幕/UI/水印），包括语言`
   - `判断每个镜头的景别与机位（平视/俯拍/仰拍），以及运动是推拉摇移还是固定`
   - `光线方向与色温（顺光/侧光/逆光；冷/暖）`
   - `如果某格看不清，用 media_frame 指定 time 与 region 取局部放大`
   - 结尾一行：`回答时请引用格号与时间码，不要重复上面的数字表。`
5. `target:'vision'` 时新增一行元信息：`呈现模式: vision（已内嵌 N 张图；文本不含字符图）`

`target:'blind'`（默认）：现有输出逐字不变。

### A2. `renderFrameReport(frame, meta)`

`target:'vision'`：删掉亮度图/色相图代码块与形容词；保留数字与配色 hex；
若有 `imagePlan`（内嵌原图/裁剪图）给一行图注：`原图已内嵌（{width}×{height}），需要更细可再取 region`。
`meta.region`（`"x,y,w,h"`）存在时写 `裁剪区域: x,y,w,h（原图像素）`。

### A3. `renderSeeReport(payload)`（render-v2.js）

`target:'vision'`：peek 时删掉亮度字符图，改为一行 `截图已内嵌，请直接读出屏幕上的文字与关键 UI 元素` +
观察清单（3–5 条：当前在哪个应用、有哪些可读文字、是否有报错/弹窗/进度）；watch 时保留格表，
删掉形容词，图注说明「每格是一次界面变化，按行优先」。

### A4. `renderBuildReport` / `renderAnimateReport`（render-v2.js）

`target:'vision'` 且 `imagePlan` 有 `filmstrip`（首/中/尾三帧）时：在开头给一行图注
`成片段（首/中/尾三帧，左→右）已内嵌`，并把「## 自检」里的形容词删掉只留数字。

### A5. 测试 `test/vision-render.test.mjs`

用**构造的 analysis 对象**（不跑 ffmpeg，纯渲染）断言：
- blind 输出包含 `画面结构`、代码块、`版式:`；vision 输出**不包含**这些，也不含 `亮度图`
- vision 输出包含 `## 看图说明`、`## 观察清单`、`格` 映射表、且 `cells` 的时间码正确
- 同一 analysis 下 blind 与 vision 的差异只出现在允许删改的段落（可用行数/关键字检查）
- `imagePlan` 为空时 vision 仍能渲染（不崩、不给空表）
- 帧报告/看屏报告/合成报告的 vision 分支各 3 条断言
- ≥ 18 项断言，PASS/FAIL 行，`node --check` 干净

## 模块 B — `lib/montage.js` 拼图与对比（owner: vision-compare）

```js
export async function buildFilmstrip({ tools, file, times, workDir, outputPath, width = 1260, columns = 3, labels, labelPrefix = '', quality = 'balanced' })
  // 从同一个视频（或图片）取 times 处的帧，横向拼成 columns 列（不足一行按实际数量）、
  // 每格保持 16:9、格间 4px 深色间隙、左上角烧「序号 + 时间码」标注（用 lib/png.js 的 3x5 字体或自带小字模，
  // 不要用 drawtext 依赖字体文件）。
  // -> { path, width, height, columns, rows, cells: [{ index, time, timecode }], tokenEstimate }
```

```js
export async function buildComparePair({ tools, refFile, builtFile, workDir, outputPath, refTime, builtTime, width = 1260, labels = ['参考', '成片'], mode = 'stack' })
  // 两张图上下（stack）或左右（side）并排，同尺寸、等比裁切；顶部各烧一个标签；
  // -> { path, width, height, mode, cells: [{ label, time, timecode }], tokenEstimate }
```

```js
export function diffMetrics(ref, built)
  // ref/built 是 analyzeVideo 的结果（或精简子集）。纯函数，输出：
  // { rows: [{ metric, ref, built, delta, verdict: 'match'|'close'|'diverge' }],
  //   summary: { match: n, close: n, diverge: n }, verdict: 'close'|'partly'|'diverge' }
  // 指标：时长、镜头数、平均镜头长、切点率、平均亮度、平均彩度、BPM、调性、硬切占比、卡点率、调色签名
  // 判定阈值写进注释并在测试里断言（例如 avgShotLength 相差 <20% 为 match，<50% 为 close）
```

要求：
- 复用 `lib/ffmpeg.js` 取帧（一次调用取一帧即可，times ≤ 6），用 `lib/png.js` Canvas 合成与烧字。
- 尺寸按 42 的倍数对齐（token 估算 `rows × (cols + 1) + 2`），沿用 `lib/screen.js` 的 `tokenEstimateFor`（可 import）。
- 降级：某个 time 取帧失败 → 跳过该格并 warning；全部失败 → 抛清晰错误。
- 测试 `test/montage.test.mjs`：用 ffmpeg 造 2 个不同颜色的 6 秒视频做 ref/built；
  断言 filmstrip 的 cells/尺寸/42 对齐/token 公式、compare 的 stack 与 side 两种排版尺寸、
  取帧失败降级、`diffMetrics` 对「几乎相同」与「差异很大」两组数据给出 match/diverge 判定、
  输出 JSON 有限。≥ 14 项断言。

## 模块 C — `lib/vision.js` + 工具层（owner: Lead）

Lead 负责：能力探测与 limits 夹取、imagePlan 组装、各工具 `mode` 参数、`region`/`zoom` 裁剪、
`media_frames`、`media_compare` 工具注册、README/配置文档、e2e。

## 交付与验收

```text
node test/vision-render.test.mjs   # A
node test/montage.test.mjs         # B
node test/e2e.mjs                  # 现有 231 项不许变红
```

报告：文件清单、导出面、测试 PASS/FAIL、blind/vision 报告字数对比、偏差说明、任务是否 completed。
