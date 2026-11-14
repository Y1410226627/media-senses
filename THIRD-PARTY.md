# 第三方来源与许可 / Third-party attribution

`media-senses` 本体是 MIT 风格的本地插件（私有包，`@local/media-senses`）。它**不包含**任何
第三方代码的完整副本，但吸收了以下开源项目的**算法、参数与工程结论**，其中部分模块的注释里
也标注了来源。分发或修改时请一并保留本文件。

## 1. dsh-see-now — Apache License 2.0

- 仓库：https://github.com/SAOS-3624/dsh-see-now
- 作者：SAOS-3624
- 许可：Apache License 2.0（完整许可文本见上游 `LICENSE`，保留通知见上游 `NOTICE`）

**吸收了什么**

| 本仓库位置 | 吸收内容 |
|---|---|
| `lib/change.js` | 「变化分」思路：在 64×36 网格上按加权 HSV 差给相邻帧打 0–255 分；切点（尖峰）判据 `score ≥ cutAbs 且 score > 2.5×邻居`、最小间隔 0.4 s；连续运动用积分阈值 `4 × fps × 3 秒` 攒帧；静止时按兜底秒数出一帧 |
| `lib/screen.js` | 「多帧拼进一张图」与 **token 对齐**：把画布宽度取 42 的倍数（798 / 1050 / 1260）而不是 800 / 1064 / 1280，避免为对齐补齐的整列付费；token 估算 `rows × (cols + 1) + 2`；格子内烧帧号 |
| `media_see` 工具 | 屏幕采集（Windows `gdigrab` / `ddagrab`）+ 变化量选帧 + 拼图的整体产品形态 |
| `README.md` | 该项目的实测数字（采集 CPU、变化分刻度、token 档位）作为我们参数选择的依据 |

**没有吸收**：其悬浮窗、语音朗读、WASAPI 回环听声、Linux portal/GStreamer 采集、逐场景模式、
常驻唤醒循环与 profile 安装机制——这些与本插件「视频语料 → 仿制」的定位无关。

我们**独立实现**了上述算法（零依赖、Node 原生），没有逐行复制上游源码；如需沿用上游实现，
应按 Apache-2.0 保留 `LICENSE` / `NOTICE` 并注明修改。

## 2. code-animation-prompts — 本地技能素材库

- 位置：`~/.dsh/skills/code-animation-prompts`（本机技能，不在本仓库内）
- 内容：341 条风格提示词、196 张参考静帧、`window.renderAt(t)` 渲染契约、原始示例

**吸收了什么**：`lib/styles.js` 读取其 `references/catalog.json` 做检索；`media_animate` 的
渲染契约、`?export=1` 停止自播、固定随机种子、逐帧确定性要求均来自该技能的
`references/rendering.md`；`assets/starter/index.html` 被用作渲染器测试夹具。

素材库的版权与其内声明的第三方许可（见该技能 `assets/library/第三方许可` 与
`许可与来源.md`）仍然有效，本插件只读取、不复制、不修改其内容。

## 3. 2026-11 吸收的第二批项目

这一批共 18 个仓库，全部真实存在并逐一读过 README / SKILL.md。**只吸收方法、阈值与工程结论，
不复制任何源码、提示词原文或参考帧**；许可上有传染性或禁止商用的一律只当方法论读。

### 3.1 可安全吸收（MIT / Apache-2.0）

| 来源 | 许可 | 吸收了什么 | 落在哪 |
|---|---|---|---|
| [onetake](https://github.com/feitangyuan/onetake) | PolyForm Noncommercial 1.0.0（**仅学思路，未取代码**） | 「像 PPT」的量化判据：镜头长变异系数 ≥0.25、静帧占比 ≥25%、1.5 s 内 ≥3 次大变化算一处爆发；静音轨不能判成 PASS | `lib/gate.js` 的阈值与五条腿 |
| [claude-animated-shorts](https://github.com/mromidev/claude-animated-shorts) | MIT（参考帧明确不可再分发，**未取图像**） | 黑场 <0.04 / 白场 >0.93 / 冻帧 / 无计划跳变的成片自检阈值 | `lib/gate.js`（dead-air 与静帧判定） |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | Apache-2.0 | `check`/`review` 闭环：把可测量的工艺问题（读不完的字、>3 s 无变化、首帧空白、无声片）做成渲染前的判定而非事后看片 | `lib/gate.js`（dead-air 3 s）、`lib/htmlrender.js`（渲染前源码扫描） |
| [mg-styles-15](https://github.com/Vincentwei1021/mg-styles-15) | MIT | 提示词四段式与「签名特征必须可检验」；`document.getAnimations()` 可 seek 的思路 | `lib/styles.js` 的分节解析 |
| [lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) | 代码 MIT / 文档 CC BY-NC（**只借结构，未取文本**） | 「不可改 / 改变风格性格 / 可自由改」的三分法；11 节 STYLE.md 的节名 | `lib/styles.js` 的 invariants / variables |
| [huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion) | MIT（角色素材不随 MIT，**未取**） | 反 PPT 门禁与「镜头事件不是 bug」的重分类思路 | `lib/gate.js` |
| [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft) | Apache-2.0（依赖的 Remotion 另有许可，**未打包**） | 卡点验收用分位数而非均值、3 帧容差；镜头时长必须有变化 | `lib/craft.js` 的 `medianAbsOffsetMs` / `p80AbsOffsetMs` / `withinThreeFramesRatio` |
| [supervision](https://github.com/roboflow/supervision) | MIT | 「区域占用时长」作为一等指标的概念 | `lib/gate.js` 的静帧段落统计 |
| [awesome-opus5-5-videos](https://github.com/yihui-dev/awesome-opus5-5-videos) | MIT | 只作分类参考，未取条目内容 | — |

### 3.2 只读方法论、明确不吸收的

| 来源 | 许可 | 为什么不动 |
|---|---|---|
| [OpenMontage](https://github.com/calesthio/OpenMontage) | AGPL-3.0（有传染性） | 只参考了它的「slideshow risk」维度划分，未取任何代码 |
| [opus-video-prompts](https://github.com/joeseesun/opus-video-prompts) | 无许可、README 声明版权归原作者 | 提示词原文一个字都未入库 |
| [remotion-dev/skills](https://github.com/remotion-dev/skills) | 未声明 | 只参考了「一句 Use when + 一条示例调用」的描述形态 |
| [cinecode](https://github.com/sarpstar/cinecode) / [anidoodle](https://github.com/alexgreensh/anidoodle) / [sweety-handdraw-video](https://github.com/threerocks/sweety-handdraw-video) / [bang-motion](https://github.com/bangtutorial/bang-motion) / [cth9191/animate](https://github.com/cth9191/animate) / [ClaudeAnimationBase](https://github.com/JohnHeibel/ClaudeAnimationBase) | MIT | 读过后判断其增量（镜头动作词典、笔刷参数、情绪表）与本项目现有能力重叠，本轮不取 |

## 4. 其他算法与工程结论

| 来源 | 许可 | 用途 |
|---|---|---|
| [FFmpeg](https://ffmpeg.org/) | LGPL/GPL（按构建） | 全部解码编码、滤镜（signalstats/scdet/ebur128/xfade/zoompan/loudnorm/whisper） |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT | ggml 模型权重格式与模型文件（推理在 ffmpeg 内） |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | BSD-3 | 场景切点阈值与自适应判据的思路 |
| [librosa](https://github.com/librosa/librosa) | ISC | onset 包络、自相关 tempo、色度、自相似矩阵/Foote novelty 的算法参考 |
| [Essentia](https://essentia.upf.edu/) | AGPL-3（仅参考字段组织） | 描述符字段命名 |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | Apache-2.0 | 无 `beginFrame` 时用 `Page.captureScreenshot` 逐帧导出；1×1 flush 防黑帧；PNG 禁用 optimizeForSpeed |
| [chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface) | MIT | CDP 客户端结构（id→promise 映射、会话路由），本项目按其思路用 Node 全局 WebSocket 手写 |
| [Remotion](https://github.com/remotion-dev/remotion) / [Motion Canvas](https://github.com/motion-canvas/motion-canvas) | 各自许可 | 「代码即视频」的工程范式 |
| [ASCIIEval](https://arxiv.org/abs/2410.01733) | — | 字符图可读性证据 |
| [MCP 规范](https://modelcontextprotocol.io/) | — | 工具结果携带图像块的设计 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | `bin/yt-dlp.exe`（下载器，本地分发副本） |

`bin/yt-dlp.exe` 是 yt-dlp 官方发布的 Windows 独立构建（Unlicense，公共领域），随插件分发时
请保留其原始来源说明。
