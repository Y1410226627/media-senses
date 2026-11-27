# CONTRACT-V4 — 复刻质量闭环（吸收 dsh-drawai / video-shotcraft / mg-styles-15）

> 起因：用户质疑「你确定他们能做到的我们也绝对能完美复刻？」
> 审计结论：**不能**。v0.6.0 有 9 项差距，其中 6 项为完全缺失。
> 本契约定义第 7 轮要补齐的 8 个模块，目标是让「看片 → 学到手法 → 复刻 → 验收」
> 闭环在**质量维度**上与 video-shotcraft 对齐，而不只是"能渲出一支片子"。

## 0. 差距基线（审计于 v0.6.0）

| # | 能力 | 上游 | 现状 | 本轮 |
|---|------|------|------|------|
| 1 | 音效/声音设计 | Freesound 选材 + 逐帧钉 + 两项偏移补偿 | 只有 shot 卡里的文字建议 | `lib/sfx.js` |
| 2 | 卡点闭环 | 网格拟合 + 三分类 + 渲后回测 ≤3f | 只有 BPM/节拍标量 | `lib/beatsync.js` |
| 3 | 镜头卡库 | 124 张 + demo 源码 + 调校参数 | 44 张，仅参数 | `lib/shots.js` |
| 4 | 判例式审美准则 | 20 条 R/Q/S/C/P 判例 | 无 | `lib/aesthetic.js` |
| 5 | 独立终检 | 干净上下文 subagent + 帧号证据 | rubric 自评 | `lib/review.js` |
| 6 | 像素级比对 | `pixelqa.js` | 数值 + 并排图 | `lib/pixelqa.js` |
| 7 | 可再编辑交付 | 剪映工程 + workbench | 无 | `lib/timeline.js` |
| 8 | 整片 MG 风格 | 15 套 + 参考帧 | 341 个单镜头风格 | `lib/mgstyles.js` |
| 9 | 真实页面 2.5D 采集 | capture-template + PageCam | 只有屏幕截图 | `lib/pagecapture.js` |

## 1. 通用铁律（所有模块）

1. **零依赖**：只用 Node 内置 + 本仓库 `lib/` 已有模块。不许 `npm i`。
2. **ESM**：`export function foo(){}` + 末尾 `export default { … }`，与现有 lib 一致。
3. **确定性**：渲染路径禁 `Math.random()` / `Date.now()` / `performance.now()`。
   需要随机一律 seeded `mulberry32`（`lib/easing.js` 或自写 `rand()` 种子从参数派生）。
4. **离线**：模块函数不许联网。可选下载必须显式 opt-in 且给出可读错误。
5. **纯函数优先**：能纯就纯；需要 ffmpeg 的放 `meta` 标记并由上层调用。
6. **注释中文**，说明「为什么」而不是复述代码。
7. **测试**：`test/<模块名>.test.mjs`，本地 `check(name, fn)` 辅助器（照抄
   `test/gate.test.mjs` 的骨架），最后打印 `N passed / M failed` 并在失败时
   `process.exitCode = 1`。跑法 `node test/<模块名>.test.mjs`。
8. **归因**：凡是内容/参数/方法论来自上游 Apache-2.0（video-shotcraft）的，
   在模块头部注释写明来源与许可，并在交付说明里列出需要加进
   `THIRD-PARTY.md` 的条目。不改上游 LICENSE 文本本身。

## 2. 交付物与接口

### 2.1 `lib/sfx.js` — 程序化音效合成（owner: audio-engine）

不下载任何素材，纯 DSP 合成，因此无许可风险、可离线、可复现。

必须导出：

```js
export const SFX_KINDS            // string[] 支持的音色名
export const SFX_PALETTE          // Record<kind, {zh, family, duration:[min,max], actionZh, params}>
export function synthesizeSfx(kind, opts) -> { samples: Float32Array, sampleRate, duration, meta }
export function measureSfxPeakLag(samples, sampleRate) -> { peakIndex, peakSeconds, peakFraction }
export function encodeWav(samples, sampleRate, opts) -> Buffer      // 16-bit PCM mono
export function writeSfxWav(filePath, samples, sampleRate, opts) -> Promise<{path, bytes, duration, peakDb}>
export function sequenceSfx(count, opts) -> Array<{index, kind, volume, offsetMs, atSeconds}>
export const SFX_DEFAULT_SAMPLE_RATE = 48000
export default { SFX_KINDS, SFX_PALETTE, synthesizeSfx, measureSfxPeakLag, encodeWav, writeSfxWav, sequenceSfx }
```

音色族（至少这些，`SFX_KINDS` 全集）：
- 电影系五词（S1 词汇表）：`whoosh`、`impact`、`riser`、`sparkle`、`swoosh`（transition）
- 拟音（S4）：`click`、`switch`、`paper`、`key`、`pop`、`shutter`、`glass`、`grain`、`sub-drop`、`shimmer`、`reverse-swell`、`glitch`

要点：
- `measureSfxPeakLag` 是 S5 的必需品：很多音效能量峰不在文件头（渐强攻击）。
  返回**峰值相对文件头的秒数/占比**，上层用它做
  `from = 目标峰值帧 − 峰值滞后帧 − 输出偏移帧`。
- `sequenceSfx` 实现 S2「防机枪感」：双样本交替（`alternate`）、音量阶梯递减
  （`volumeLadder`）、间隔按缓动加速（`interval` 支持 `[8,5,3]` 或 `{from,to,ease}`）。
- `impact` 要有低频重量（40–160 Hz sine 下滑 + 噪声尾），`sparkle` 要高频颗粒，
  `riser` 要能抵达落点（长度可配，`opts.duration`），`whoosh` 要带声像位移感。
- 全部 48 kHz 单声道，峰值默认归一化到 −1 dBFS（可配 `opts.peakDb`），不许削波。

测试 `test/sfx.test.mjs`（≥25 项）：确定性（同参两次同 bytes）、WAV 头合法、
时长在 palette 区间内、无削波、`measureSfxPeakLag` 对已知延后峰值信号能算准、
`sequenceSfx` 交替与递减正确、非法 kind 报错可读。

### 2.2 `lib/beatsync.js` — 卡点网格与渲后回测（owner: change-engine）

```js
export function fitBeatGrid(beatTimes) -> { bpm, t0, period, count, residualMaxMs, residualRmsMs, pass }
export function acceptBeatGrid(candidates, transientTimes) -> { winner, scores, reasonZh }
export function classifyTransients(samples, sampleRate, opts) -> { hits:[{t,strength,kind}], kick, snare, hihat }
export function beatTime(n, grid, outputOffsetSec) -> number           // 拍号 → 秒
export function beatFrame(n, grid, fps, outputOffsetSec) -> number     // 拍号 → 帧
export function planBeatLockedCuts(opts) -> [{ fromFrame, toFrame, beats }]
export function backtestAlignment(designedFrames, measuredBeatTimes, fps) -> {
  rows:[{designedFrame, nearestBeatFrame, errorFrames, verdict}],
  meanAbsFrames, maxAbsFrames, within3Ratio, pass, ideal, verdictZh }
export function measureOutputAudioOffset(originalSamples, renderedSamples, sampleRate) ->
  { offsetSamples, offsetSeconds, offsetFrames, correlation, pass }
export const BEAT_GRID_THRESHOLDS  // {match:0.98, meanAbsMs:10, driftMs:5}
export const BACKTEST_THRESHOLDS   // {passFrames:3, idealFrames:1.5}
export default { … }
```

要点（全部来自 music-beat-sync.md，实现时照做）：
- `fitBeatGrid` 用最小二乘拟合 `t_i = t0 + i*T`，**不要信 tempo 标量**。
  残差 ≤15ms 判 `pass`（机器鼓点）。
- `acceptBeatGrid` 必须处理 **2x/0.5x 歧义**：用「kick 是否主要落整数拍」投票，
  返回每个候选的 match/meanAbsMs/drift 与获胜理由（中文，供模型读）。
- `classifyTransients`：kick 40–160 Hz、snare 150–500 Hz 体 + 1–3 kHz 打击面、
  hihat 6–14 kHz。用 `lib/dsp.js` 的 `frameMagnitudes`/`fft`/`peakPick`。
- `backtestAlignment`：门槛 pass ≤3f、ideal ≤1.5f，逐点给 verdict。
- `measureOutputAudioOffset`：归一化交叉相关，求输出音轨相对源信号的固定滞后
  （AAC priming ≈1.28f@30fps）。残差一致才 `pass`。

测试 `test/beatsync.test.mjs`（≥25 项）：合成 131.97 BPM + 已知 t0 的点击轨 →
拟合出的 bpm/t0 误差在容差内；故意给 2x 错误候选 → 歧义消解器选对；
合成三段频段的 kick/snare/hihat → 分类不串；把 beat 整体平移 N 帧 →
`backtestAlignment` 报出 N；交叉相关能测出已知平移量。

### 2.3 `lib/shots.js` 扩到 ≥124 张 + `lib/aesthetic.js`（owner: craft-engine）

**(a) 扩卡**：`SHOT_CARDS` 从 44 → **≥124**，覆盖上游 shotcraft 的词汇广度。
本地素材已抓到 `test/_research/shots/<category>/*.md`（124 张，Apache-2.0，
上游 video-shotcraft，经 dsh-drawai 固定提交）。做法：
- 保留现有 44 张**一字不改**（有回归测试，`test/vocabulary.test.mjs`/`shots-lint.test.mjs` 会挂）。
- 按上游 10 个类目补足：`opening-brand`、`camera`、`transitions`、`typography`、
  `ui-entrance`、`interaction`、`data`、`light-emphasis`、`rhythm`、`outro`。
- 每张卡用**我们自己的** `SHOT_CARDS` schema（先读 `lib/shots.js` 现有字段，
  字段必须齐全：id/中文名/类目/能量/时长/参数表/`whatHappensZh`/`pitfallZh`/
  `soundZh` 等，以现有卡为准）。**参数数值与"已知坑/命门"必须忠实保留**——
  那是上游的调校积累，改写措辞可以，改数值不行。
- id 用小写连字（与上游卡名对应，如 `deck-deal-flyin`），不得与现有 44 张冲突。
- 头部注释注明来源与 Apache-2.0 许可。

**(b) `lib/aesthetic.js`** — 把 20 条判例式准则变成可机器审计的检查器：

```js
export const AESTHETIC_RULES   // [{id:'R1', family:'R', zh, checkable:boolean, whyZh, caseZh}]
export function auditAesthetic(input) -> {
  rows:[{id, family, verdict:'pass'|'fail'|'warn'|'skip', evidenceZh, frames?:[]}],
  passRatio, failures, warnings, summaryZh }
export default { AESTHETIC_RULES, auditAesthetic }
```

`input` 形状（上层会给，允许字段缺失 → 该条 `skip` 并说明缺什么）：
`{ shots:[{id,durationSeconds,isBrandMark,hasHoldSeconds,fullFrameImpact?,glintCount?}],
   frames:[{index,timeSeconds,texts:[{text,effectivePx,frameHeight}], motionLevel}],
   audio:{sfxAnchors:[{designedFrame,measuredPeakFrame,outputOffsetFrames}], bgmPresent},
   timeline:{cuts:[{fromFrame,toFrame,techniqueId}], totalSeconds},
   effects:{fullFrameImpactCount, glintSweepCount, beatPumpRuns} }`

必须实现且可测（其余条目标 `checkable:false` 但要有 `whyZh`）：
- **R1** 品牌字标 hold ≥1.0s；普通内容卡不要求 → fail 时给 shot id
- **R2** 匀速直线运动检测（用 `frames[].motionLevel` 方差；匀速=方差塌陷）
- **R3** 开场主体动作弧 ≥3s / 交互段速度
- **R4** 全画面级冲击 ≤3 处、相邻间隔 ≥16 拍
- **Q4** glint/sweep 每镜头 ≤1 次
- **Q11** 要读的文字有效像素高：字幕 ≥56px(1080p)、辅助 ≥32px
- **C1** 无 >3s 的无解说纯动画段落（有 `captions` 时）
- **P4** 同手法当主角重复 / 同素材重复 → 报重复对
- **S2/S5** SFX 钉点误差：`|designedFrame − measuredPeakFrame − outputOffset|` ≤0.5f
- **P1** 交付前有帧证据（`frames.length>0` 且覆盖每个 shot）

测试 `test/aesthetic.test.mjs`（≥30 项）：每条可测规则各造一 pass + 一 fail 用例。
`test/vocabulary.test.mjs` / `test/shots-lint.test.mjs` 必须仍然全绿。

### 2.4 `lib/review.js` — 独立终检聚合（owner: vision-render）

**纯聚合，不自己跑 ffmpeg**。上层把各引擎结果喂进来，本模块只负责判定、排序、
出带帧号证据的报告。

```js
export const REVIEW_SECTIONS   // A 音画 / B 节奏 / C 画面 / D 数据安全 / E 一致性
export function auditFilm(input) -> {
  verdict:'pass'|'warn'|'fail', score, sections:[{id,zh,rows:[{id,verdict,evidenceZh,frames}]}],
  blockers:[], mustFix:[], summaryZh }
export function renderReviewReport(report, opts) -> string   // Markdown；opts.blind 时不加主观形容词
export default { REVIEW_SECTIONS, auditFilm, renderReviewReport }
```

`input` = `{ gate, continuity, aesthetic, beatsync, audio, plan, shots, lint }` 各引擎原始
返回（允许 `null`）。要点：
- **首检不能交给用户**：报告必须显式标注「本报告由独立审计生成，制作者的自检不作为证据」。
- 每条 blocker 必须带**帧号或秒**证据（照 `rubric.js` 的 `hasTimeReference` 思路校验），
  无证据的提升为 `warn` 并注明"缺证据"。
- 盲/视觉双模式与现有 `lib/render-vision.js` 约定一致：`blind` 版去掉主观形容词，
  只留可验证陈述。

测试 `test/review.test.mjs`（≥20 项）：全绿 → pass；某引擎 fail → verdict 降级且
blocker 带帧号；无证据条目被降级；`blind` 模式不出现形容词表里的词。

### 2.5 `lib/pixelqa.js` — 像素级比对（owner: video-engine）

```js
export function decodePngPixels(buffer) -> { width, height, channels, data }   // 复用 lib/png.js
export function comparePixels(a, b, opts) -> { mae, rmse, psnr, ssim, deltaE00, worstRegions:[…], verdict }
export function regionGrid(width, height, cols, rows) -> [{x,y,w,h,index}]
export function compareRegions(pixelsA, pixelsB, grid) -> [{index, mae, psnr, deltaE00, verdict}]
export const PIXEL_QA_THRESHOLDS   // psnr≥28 match, ≥22 close, else diverge; ssim≥0.92 …
export default { … }
```

要求：跨分辨率比对（参考 1920×1080 vs 成片 1280×720）先最近邻/面积平均缩放到同一尺寸；
`deltaE00` 用 sRGB→Lab→CIEDE2000（可以简化到 CIE76 但要在注释里说明取哪种）；
`worstRegions` 按 region 的 psnr 升序取前 N 并给中文描述（"左上角"这类方位词）。

测试 `test/pixelqa.test.mjs`（≥18 项）：同图 → mae=0/psnr=Infinity/ssim≈1；
纯色差图 → deltaE 可预期；平移 8px → psnr 显著下降；缩放比对不炸；
`regionGrid` 覆盖整图无重叠；跨尺寸比对返回有限值。

### 2.6 `lib/timeline.js` — 可再编辑交付（owner: video-builder）

交付物不是死视频，而是**可再编辑的时间线**：

```js
export function planToTimeline(plan, opts) -> {
  version, width, height, fps, duration,
  tracks:[{id, kind:'video'|'text'|'image'|'audio'|'sfx', clips:[…]}],
  markers:[{timeSeconds,label,beat?}], beatGrid? }
export function timelineToPlan(timeline) -> plan        // 往返：改完能重渲
export function renderTimelineHtml(timeline, opts) -> string   // 自包含可编辑 HTML（拖时间条/改文案后导出 JSON）
export function diffTimeline(a, b) -> [{trackId, clipId, changeZh}]
export default { … }
```

要点：`planToTimeline` / `timelineToPlan` 必须**无损往返**（`timelineToPlan(planToTimeline(p))`
与 `p` 语义等价，字段可以归一化但要能重渲）。HTML 版零依赖、离线可开、内嵌 JSON，
支持改文字/改时长/调音量并导出新 JSON。这是给用户"进剪映/自己再改"的替代品
（真剪映工程导出需要 `pyJianYingDraft`，本轮不做）。

测试 `test/timeline.test.mjs`（≥20 项）：往返等价（用 build-engine 现有 plan 夹具形状）、
轨道/片段计数正确、音频轨带 volume、HTML 含 JSON 且不含外部 URL、diff 能识别改动。

### 2.7 `lib/mgstyles.js` — 15 套整片 MG 风格（owner: html-renderer）

上游 mg-styles-15（经 dsh-drawai）有 15 套**整片**动效风格，每套带提示词与样片。
我们现有 `media_styles` 是 341 个**单镜头**风格，缺"整片视觉系统"这层。

```js
export const MG_STYLES        // [{id, code:'01-flat-vector', zh, en, energy, family,
                              //   palette:[hex…], typeZh, motionZh, textureZh,
                              //   promptZh（可直接喂给写 HTML 的模型）, avoidZh:[…]}]
export function getMgStyle(idOrCode)
export function findMgStyles(query, opts)
export function mgStylePrompt(id, opts) -> string    // 生成 "用这套风格写 window.renderAt(t)" 的完整指令
export const MG_STYLE_COUNT
export default { MG_STYLES, getMgStyle, findMgStyles, mgStylePrompt, MG_STYLE_COUNT }
```

15 套（上游代码 → 中文名自拟，但运动语汇要忠实）：`01-flat-vector` `02-line-art`
`03-isometric` `05-cel-boil` `06-collage` `07-liquid` `08-morph` `09-bauhaus`
`10-synthwave` `12-aurora-glass` `18-hanazi` `19-paperclip` `20-pixel` `22-hud`
`23-ink-wash`。
本地素材：`test/_research/mgstyles-readme.txt`、`test/_research/mgstyles-manifest.txt`；
需要更多细节可以再抓
`https://raw.githubusercontent.com/fourzkw/dsh-drawai/master/src/motion/mgstyles/upstream/prompts/<code>.md`。
`promptZh` 要能直接指导写出可渲染的 HTML（含配色、字号层级、运动曲线倾向、质感/噪点、
禁忌）。**不要**照抄上游英文提示词，转写成我们自己的中文可执行指令。

另加 3 个可运行模板放 `assets/mgstyles/`：至少 `flat-vector.html`、`isometric.html`、
`hud.html`，实现 `window.renderAt(t)`，1920×1080，纯内联（无外链），可被
`media_animate` 直接渲染。

测试 `test/mgstyles.test.mjs`（≥20 项）：15 套齐全、字段完整、配色合法 hex、
`findMgStyles` 检索命中、`mgStylePrompt` 含该风格关键指令、模板文件存在且含
`renderAt`、模板不含 `http://`/`https://` 外链。

### 2.8 `lib/pagecapture.js` — 真实页面 2.5D 采集（owner: screen-capture）

上游 Q1/Q2/PageCam 的代码化：把"复刻既有页面必须用真实截图"变成工具。

```js
export function buildCaptureScript(opts) -> string        // 注入页面执行的 JS（取 layout + 元素框）
export function planElementCutouts(layout, opts) -> [{name, selector, rect, scale}]
export function layoutToCamera(layout, opts) -> { width, height, tx, ty, zoom, cssZoomZh }
export async function capturePage(opts) -> { fullPngPath, layoutPath, cutouts:[…], warnings }
export const PAGE_CAPTURE_DEFAULTS
export default { … }
```

要点（照 aesthetic-rules Q2 落地）：
- 全页 `deviceScaleFactor: 2` 截图；hero 元素单独 `4x` 元素级截图（元素级抠图）。
- 采 `layout.json`：元素坐标表（`getBoundingClientRect` + `offsetWidth`，注意后者
  才是布局尺寸）+ computed style token（字体/字号/行高/圆角/配色）。
- **放大走 CSS `zoom` 而不是 `transform: scale`**，并把坐标换算
  `Tx = 960/zoom − cx` 写进 `layoutToCamera`（Q2 的根因就是这个换算漏了）。
- 复用 `lib/htmlrender.js` 的 CDP 启动方式（读它怎么起 Edge，别另造一套）；
  离线、失败给可读错误。

测试 `test/pagecapture.test.mjs`（≥15 项）：`planElementCutouts` 按 scale 算尺寸正确；
`layoutToCamera` 的 tx/ty 换算与 Q2 公式一致；`buildCaptureScript` 是可执行 JS 且
含 deviceScaleFactor；无浏览器时 `capturePage` 抛可读错误而不是崩。

## 3. 写作用域（互不重叠，越界即冲突）

| owner | 可写 |
|---|---|
| audio-engine | `lib/sfx.js`、`test/sfx.test.mjs` |
| change-engine | `lib/beatsync.js`、`test/beatsync.test.mjs` |
| craft-engine | `lib/shots.js`、`lib/aesthetic.js`、`test/aesthetic.test.mjs`、`test/vocabulary.test.mjs`、`test/shots-lint.test.mjs` |
| vision-render | `lib/review.js`、`test/review.test.mjs` |
| video-engine | `lib/pixelqa.js`、`test/pixelqa.test.mjs` |
| video-builder | `lib/timeline.js`、`test/timeline.test.mjs` |
| html-renderer | `lib/mgstyles.js`、`assets/mgstyles/*`、`test/mgstyles.test.mjs` |
| screen-capture | `lib/pagecapture.js`、`test/pagecapture.test.mjs` |
| **lead** | `index.js`、`lib/build.js`、`lib/render*.js`、`lib/gate.js`、`lib/lint.js`、README/CONTRACT/THIRD-PARTY、其余所有文件 |

**不要动 `index.js` / `lib/build.js` / `lib/gate.js`**：工具注册与成片管线由 Lead 统一接线。
需要上层传什么，在交付说明里写清「期望的上层调用形状」即可。

## 4. 归因要求

凡是内容/参数/方法论来自上游的，交付说明里给出这样一行，Lead 会汇总进 `THIRD-PARTY.md`：

```
模块 | 上游 | 许可 | 吸收方式（数据/参数/方法论/代码）
lib/shots.js | video-shotcraft (Vincentwei1021) via dsh-drawai 固定提交 1266a3e | Apache-2.0 | 词汇与调校参数，schema 与文案为本仓自写
```

## 5. 验收

- 每个模块自己的 `node test/<m>.test.mjs` 全绿，并在交付说明里给出 **实际跑出来的
  通过项数**（不许估）。
- 现有 25 个套件仍然全绿（Lead 会统一跑）。
- 不新增 npm 依赖（`package.json` 的 `dependencies` 保持不存在）。

## 6. 交付状态（2026-11 收口）

8 个模块全部落地并接线，30 个套件 / 739 项断言全绿。

| 模块 | 行数 | 自有测试 | 实测通过项 |
|---|---|---|---|
| `lib/sfx.js` | 1197 | `test/sfx.test.mjs` | 41 |
| `lib/beatsync.js` | 1330 | `test/beatsync.test.mjs` | 22 |
| `lib/shots.js` 扩卡 | — | `test/shots-lint.test.mjs` | 39（168 张卡）|
| `lib/aesthetic.js` | 980 | `test/aesthetic.test.mjs` | 18 |
| `lib/review.js` | 1238 | `test/review.test.mjs` | 33 |
| `lib/pixelqa.js` | 911 | `test/pixelqa.test.mjs` | 33 |
| `lib/timeline.js` | 1886 | `test/timeline.test.mjs` | 30 |
| `lib/mgstyles.js` + 3 模板 | 1113 | `test/mgstyles.test.mjs` | 12 |
| `lib/pagecapture.js` | 1499 | `test/pagecapture.test.mjs` | 20 |
| 端到端音频链路 | — | `test/audio-chain.test.mjs` | 9 |

**交付过程中被独立验证抓出并修掉的真问题**（记在这里，因为这些正是「自测通过≠能用」的证据）：

1. `classifyTransients` 在**起音帧**上判类：幅度突变的宽带瞬态让 300Hz 的军鼓被判成 kick。
   改为在瞬态**之后 40ms** 的窗口上量频段能量密度。
2. 同一处，hihat 的宽频噪声被窄频段（kick 只有 3 个 bin）的方差带偏，拆成 kick/snare/hihat。
   改为先用**谱平坦度**判宽带，再谈频段占比。
3. `S2`/`S5`/`P1` 在计划阶段（还没有渲后测量值）报 FAIL，把「还没测」当成「不合格」。
   改为 SKIP 并说明缺什么。
4. `formatValue` 把画幅宽度按叠加层的百分比语义格式化，打出「128000%」；改按 meta 语义给 px。
5. `auditS2/S5` 的 skip 文案把「不可机器判定：」前缀拼了两遍。
6. `index.js` 的 `notes` 在其 `const` 声明之前被使用（TDZ），真渲一次就会崩。
7. `acceptBeatGrid` 里 0 分的候选仍可能当 winner（原因串会警告，但不该静默）——
   已在卡点腿里改成「最差点决定判定」，不再让均值掩盖单点超差。

**上一轮遗留、本轮未解决的**：真剪映工程导出（需 `pyJianYingDraft`）、
鼓件分类在同一瞬间叠打与弱 hihat 上的边界（已在 README 局限第 12 条写明）。
