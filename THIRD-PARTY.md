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

## 3. 其他算法与工程结论

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
