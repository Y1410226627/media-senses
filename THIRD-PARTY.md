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
| [HyperFrames](https://github.com/heygen-com/hyperframes) | Apache-2.0 | 声明式 clip 契约（`data-composition-id`/`data-start`/`data-duration`/`data-track-index`）、`window.__timelines` 适配器思路、合成内 `<audio>` 多轨混音、渲染前 lint 的违规分类、运动模糊（快门角 + 子帧混合）、`check`/`review` 闭环（读不完的字、>3 s 无变化、首帧空白） | `lib/htmlrender.js`、`lib/animaudio.js`、`lib/gate.js` |
| [mg-styles-15](https://github.com/Vincentwei1021/mg-styles-15) | MIT | `document.getAnimations()` 逐帧 seek（让普通 CSS/WAAPI 动画可确定性渲染）、`tmix` 运动模糊分组、槽位锁与 per-worker 浏览器 | `lib/htmlrender.js` 的运行时注入与编码链 |
| [onetake](https://github.com/feitangyuan/onetake) | PolyForm Noncommercial 1.0.0（**仅学思路，未取代码**） | 边界承接判据：携带/锚定/裸切的定义与 0.5/0.7 门槛、burstable 豁免、已知盲区清单 | `lib/continuity.js` |
| [supervision](https://github.com/roboflow/supervision) | MIT | 「区域占用时长」作为一等指标 | `lib/continuity.js` 的 `zoneDwell` |
| [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft) | Apache-2.0（依赖的 Remotion 另有许可，**未打包**） | 镜头配方卡的六段式 schema 与「参数 | 典型值 | 调节手感」三列表、时长预算思路、卡点分位验收 | `lib/shots.js`、`lib/craft.js` |
| [cinecode](https://github.com/sarpstar/cinecode) | MIT | 速度词量化（缩放 %/s、扫掠 s/屏）、缓动词的 5 档语义、转场默认时长表、cut seam 硬规则、镜头动作词典 | `lib/moves.js` |
| [huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion) | MIT（角色素材不随 MIT，**未取**） | 反 PPT 门禁与「镜头事件不是 bug」的重分类思路、时长/笔数预算的量级 | `lib/gate.js`、`lib/shots.js` |
| [claude-animated-shorts](https://github.com/mromidev/claude-animated-shorts) | MIT（参考帧明确不可再分发，**未取图像**） | 黑场/白场/冻帧/跳变的成片自检阈值 | `lib/gate.js` |
| [lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) | 代码 MIT / 文档 CC BY-NC（**只借结构，未取文本**） | 「不可改 / 改变风格性格 / 可自由改」三分法、11 节 STYLE.md 的节名与顺序、8 套外观的参数分组（palette/materials/light/post/render） | `lib/styles.js`、`lib/look.js` |
| [sweety-handdraw-video](https://github.com/threerocks/sweety-handdraw-video) | MIT | 笔数预算（起形+马克笔 ≈3.9 笔/秒、按部位上色 ≈6 笔/秒）与体裁时长区间 | `lib/shots.js` 的 `durationBudget` |
| [bang-motion](https://github.com/bangtutorial/bang-motion) | MIT | 反 PPT 的六条可编程检查（无整段淡入/必须有持续主体/文字层级/转场多样性/背景有运动/字号下限） | `lib/gate.js`、`lib/lint.js` |
| [anidoodle](https://github.com/alexgreensh/anidoodle) | Apache-2.0 | 三层验收工具链（determinism / contract / dead air）的分层方式 | `lib/gate.js`、`lib/lint.js` |
| [cth9191/animate](https://github.com/cth9191/animate) | MIT | 交付期五项实测验收（卡点、故事弧响度、主体锚定、最响点、语速） | `lib/gate.js` |
| [awesome-opus5-5-videos](https://github.com/yihui-dev/awesome-opus5-5-videos) | MIT | 只作分类参考，未取条目内容 | — |

### 3.2 只读方法论、明确不吸收的

| 来源 | 许可 | 为什么不动 |
|---|---|---|
| [OpenMontage](https://github.com/calesthio/OpenMontage) | AGPL-3.0（有传染性） | 只参考了它的「slideshow risk」维度划分，未取任何代码 |
| [opus-video-prompts](https://github.com/joeseesun/opus-video-prompts) | 无许可、README 声明版权归原作者 | 提示词原文一个字都未入库 |
| [remotion-dev/skills](https://github.com/remotion-dev/skills) | 未声明 | 只参考了「一句 Use when + 一条示例调用」的描述形态 |
| [ClaudeAnimationBase](https://github.com/JohnHeibel/ClaudeAnimationBase) | MIT | 情绪表未在 README 中展开，且本轮不需要角色表演系统 |

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
