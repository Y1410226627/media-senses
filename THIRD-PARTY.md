# 第三方来源与许可 / Third-party attribution

`media-senses` 本体是 MIT 风格的本地插件（私有包，`@local/media-senses`）。它**不包含**任何
第三方代码的完整副本，也没有打包第三方素材；但吸收了以下开源项目的**算法、参数与工程结论**，
部分模块注释里也标注了来源。分发或修改时请一并保留本文件。

标注约定：

- **已落地** —— 该项目的方法/数字确实进入了本仓库代码，后面写了落在哪个文件。
- **只读过** —— 读了仓库但本轮没有采用，仅为记录，避免以后重复调研。
- **不可吸收** —— 许可不允许或明确禁止再分发，只当方法论读，代码与文本一律未取。

---

## 1. 上一轮吸收（已落地）

### 1.1 dsh-see-now — Apache License 2.0

- 仓库：https://github.com/SAOS-3624/dsh-see-now
- 作者：SAOS-3624
- 许可：Apache License 2.0（完整文本见上游 `LICENSE`，保留通知见上游 `NOTICE`）

| 本仓库位置 | 吸收内容 |
|---|---|
| `lib/change.js` | 「变化分」：64×36 网格上按加权 HSV 差给相邻帧打 0–255 分；切点判据 `score ≥ cutAbs 且 score > 2.5×邻居`、最小间隔 0.4 s；连续运动用积分阈值 `4 × fps × 3 秒` 攒帧；静止时按兜底秒数出一帧 |
| `lib/screen.js` | 多帧拼一张图与 **token 对齐**：画布宽度取 42 的倍数（798 / 1050 / 1260），避免为补齐的整列付费；token 估算 `rows × (cols + 1) + 2`；格子内烧帧号 |
| `media_see` | 屏幕采集（Windows `gdigrab` / `ddagrab`）+ 变化量选帧 + 拼图的产品形态 |

**未吸收**：悬浮窗、语音朗读、WASAPI 回环听声、Linux portal/GStreamer 采集、逐场景模式、
常驻唤醒循环与 profile 安装机制。

上述算法为**独立实现**（零依赖、Node 原生），没有逐行复制上游源码；若要沿用上游实现，
应按 Apache-2.0 保留 `LICENSE` / `NOTICE` 并注明修改。

### 1.2 code-animation-prompts — 本机技能素材库

- 位置：`~/.dsh/skills/code-animation-prompts`（本机技能，**不在本仓库内**）
- 内容：341 条风格提示词、196 张参考静帧、`window.renderAt(t)` 渲染契约

| 本仓库位置 | 吸收内容 |
|---|---|
| `lib/styles.js` | 读取 `references/catalog.json` 做检索；`show` 按节拆分提示词并给出「不可改 / 可替换」 |
| `media_animate` | `renderAt(t)` 契约、`?export=1` 停止自播、固定随机种子、逐帧确定性要求 |
| `test/htmlrender.test.mjs` | 其 `assets/starter/index.html` 作为渲染器夹具 |

该素材库的版权与其内声明的第三方许可（见技能内 `assets/library/第三方许可`、`许可与来源.md`）
仍然有效；本插件只读取，不复制、不修改其内容。

### 1.3 其他工程参考（已落地）

| 来源 | 许可 | 用在哪 |
|---|---|---|
| [FFmpeg](https://ffmpeg.org/) | LGPL/GPL（按构建） | 全部解码编码与滤镜（signalstats/scdet/ebur128/xfade/zoompan/loudnorm/whisper） |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT | ggml 模型格式与权重（推理由 ffmpeg 的 `whisper` 滤镜完成） |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | BSD-3 | 场景切点阈值与「邻域比值」抑制镜头晃动误判 |
| [librosa](https://github.com/librosa/librosa) | ISC | onset 包络、自相关 tempo、色度、自相似矩阵 / Foote novelty |
| [Essentia](https://essentia.upf.edu/) | AGPL-3（仅参考字段命名） | 描述符字段组织（bpm / key / loudness_ebu128 等） |
| [chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface) | MIT | 极简 CDP 客户端结构（id→promise、会话路由）；本插件用 Node 全局 WebSocket 手写 |
| [Remotion](https://github.com/remotion-dev/remotion) / [Motion Canvas](https://github.com/motion-canvas/motion-canvas) | 各自许可 | 「代码即视频」范式与逐帧导出流程 |
| [editly](https://github.com/mifi/editly) | MIT | 「JSON 时间线 → ffmpeg 参数构建器」的思路 |
| [claude-real-video](https://github.com/HUANGCHIHHUNGLeo/claude-real-video) | 见上游 | 「场景切点 + 密度补帧 + 去重 + 联系表 + MANIFEST」的多模态喂帧架构 |
| [vidmcp](https://github.com/ethnn-b/vidmcp) | 见上游 | MCP 视频工具的参数设计、按 token 预算限制帧数的经验 |
| [ASCIIEval](https://arxiv.org/abs/2410.01733) | 论文 | 「小尺寸 ASCII 图 LLM 能读」的证据，因此字符图保持小而密 |
| [MCP 规范](https://modelcontextprotocol.io/) | 规范 | 工具结果可携带图像块；本插件用「存图 + 路径 + attachment」等价实现 |

---

## 2. 2026-11 第二批：18 个仓库

这一批 18 个仓库全部真实存在并逐一读过 README / SKILL.md。**只吸收方法、阈值与工程结论，
不复制任何源码、提示词原文或参考帧。** 下表按许可分层，并如实标注是否落地。

### 2.1 已吸收并落地（15 个）

| # | 来源 | 许可 | 吸收了什么 | 落在哪 |
|---|---|---|---|---|
| 1 | [HyperFrames](https://github.com/heygen-com/hyperframes) | Apache-2.0 | 声明式 clip 契约（`data-composition-id` / `data-start` / `data-duration` / `data-track-index`）、`window.__timelines` 适配器、合成内 `<audio>` 多轨混音、渲染前 lint 的违规分类、快门角运动模糊、`check`/`review` 闭环（读不完的字、>3 s 无变化、首帧空白）；此外还有 CDP 逐帧导出的工程细节（`Page.captureScreenshot` 路径、1×1 flush 防黑帧、PNG 禁用 optimizeForSpeed） | `lib/htmlrender.js`、`lib/animaudio.js`、`lib/gate.js` |
| 2 | [mg-styles-15](https://github.com/Vincentwei1021/mg-styles-15) | MIT | `document.getAnimations()` 逐帧 `pause()` + `currentTime`（让普通 CSS/WAAPI 可确定性渲染）、`tmix` 分组做运动模糊 | `lib/htmlrender.js` 运行时注入与编码链 |
| 3 | [onetake](https://github.com/feitangyuan/onetake) | PolyForm Noncommercial 1.0.0（**仅学思路**） | 边界承接判据：携带 / 锚定 / 裸切定义与 0.5、0.7 门槛；爆发段与片尾豁免；已知盲区清单 | `lib/continuity.js` |
| 4 | [supervision](https://github.com/roboflow/supervision) | MIT | 「区域占用时长」当一等指标 | `lib/continuity.js` 的 `zoneDwell` |
| 5 | [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft) | Apache-2.0（依赖的 Remotion 另有许可，未打包） | 镜头配方卡的六段式 schema 与「参数 / 典型值 / 调节手感」三列表；时长预算思路；卡点用分位数而非均值、3 帧容差 | `lib/shots.js`、`lib/craft.js` |
| 6 | [cinecode](https://github.com/sarpstar/cinecode) | MIT | 速度词量化（缩放 %/s、扫掠 s/屏）、缓动词的 5 档语义、转场默认时长表、cut seam 硬规则、镜头动作词典 | `lib/moves.js` |
| 7 | [huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion) | MIT（角色素材不随 MIT，**未取**） | 反 PPT 门禁；「镜头事件不是 bug」的重分类；笔数/时长预算的量级 | `lib/gate.js`、`lib/shots.js` |
| 8 | [claude-animated-shorts](https://github.com/mromidev/claude-animated-shorts) | MIT（参考帧明确不可再分发，**未取图像**） | 黑场 / 白场 / 冻帧 / 无计划跳变的成片自检阈值；角色表演的量化（步频、身体起伏、眨眼形状、蓄力-击出-回收） | `lib/gate.js`、`lib/performance.js` |
| 9 | [lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) | 代码 MIT / 文档 CC BY-NC（**只借结构，未取文本**） | 「不可改 / 改变风格性格 / 可自由改」三分法；11 节 STYLE.md 的节名与顺序；8 套外观的参数分组（palette / materials / light / post / render） | `lib/styles.js`、`lib/look.js` |
| 10 | [sweety-handdraw-video](https://github.com/threerocks/sweety-handdraw-video) | MIT | 笔数预算（起形+马克笔 ≈3.9 笔/秒、按部位上色 ≈6 笔/秒）与体裁时长区间；「按部位描线」的顺序 | `lib/shots.js` 的 `durationBudget`、`assets/templates/hand-drawn-line.html` |
| 11 | [bang-motion](https://github.com/bangtutorial/bang-motion) | MIT | 反 PPT 的可编程检查（无整段淡入 / 必须有持续主体 / 文字层级 / 转场多样性 / 背景有运动 / 字号下限） | `lib/gate.js`、`lib/lint.js` |
| 12 | [anidoodle](https://github.com/alexgreensh/anidoodle) | Apache-2.0 | 三层验收工具链（determinism / contract / dead air）的分层方式；逐帧抖动（line boil）作为手绘感来源 | `lib/gate.js`、`lib/lint.js`、`assets/templates/hand-drawn-line.html` |
| 13 | [cth9191/animate](https://github.com/cth9191/animate) | MIT | 交付期实测验收（卡点、故事弧响度、主体锚定、最响点、旁白语速） | `lib/gate.js` |
| 14 | [ClaudeAnimationBase](https://github.com/JohnHeibel/ClaudeAnimationBase) | MIT | 情绪用「命名姿态 + 面部状态」参数化、且须在每个视角可读的建模方式 | `lib/performance.js`（10 个情绪预设与表演节拍） |
| 15 | [awesome-opus5-5-videos](https://github.com/yihui-dev/awesome-opus5-5-videos) | MIT | 只作分类参考；其「渲染器 / 动画库 / 素材来源 / 交互性」四 facet 标签方式未采用 | 仅阅读，无代码落地 |

### 2.2 读过但未采用（3 个）

| # | 来源 | 许可 | 为什么没动 |
|---|---|---|---|
| 16 | [OpenMontage](https://github.com/calesthio/OpenMontage) | AGPL-3.0（传染性） | 参考了它「slideshow risk」的维度划分思路，但未实现其评分模型，也未取任何代码 |
| 17 | [opus-video-prompts](https://github.com/joeseesun/opus-video-prompts) | 无许可；README 声明版权归原作者 | 提示词原文一个字都未入库 |
| 18 | [remotion-dev/skills](https://github.com/remotion-dev/skills) | README 未声明许可 | 参考了「一句 Use when + 一条示例调用」的技能描述形态，未采用其技能文件 |

### 2.3 许可红线汇总

| 项目 | 约束 | 我们怎么做的 |
|---|---|---|
| onetake | PolyForm Noncommercial：禁止商用 | 只取判据阈值与盲区经验，代码一行未取 |
| OpenMontage | AGPL-3.0：传染 | 只读，未取代码 |
| lemo-opuscar | 代码 MIT / 文档 CC BY-NC | 只借章节结构与三分法（不受版权保护的思想/方法），**未复制任何 STYLE.md 文本** |
| video-shotcraft | Apache-2.0，但依赖 Remotion（商业需付费许可） | 未打包 Remotion，也未复制其卡片文本 |
| opus-video-prompts | 无许可 | 完全未用 |
| claude-animated-shorts | 参考帧 / 报告标注 private study only | 只取阈值数字，**未转存任何参考帧或报告原文** |
| huashu-art-motion | 角色形象不随 MIT、Clawd 属 Anthropic | 未取任何角色素材或样片 |
| code-animation-prompts | 各风格条目有独立许可 | 只读取、不复制、不修改 |

---

## 2.4 2026-11 第三批：dsh-drawai 及其上游（第 7 轮）

[dsh-drawai](https://github.com/fourzkw/dsh-drawai)（MIT）是一个 DSH 画布插件，它 vendor 了
§2.1 已入册的第 5 行 video-shotcraft（Apache-2.0，固定提交
`1266a3ec4831289c4d893d42dd5102723658039a`）以及第 2 行的整片 MG 风格库
（固定提交 `49052d80`）。第 7 轮从这一批里补的是**质量闭环**：声音设计、卡点回测、像素比对、
独立终检、可再编辑交付。

| 模块 | 上游 | 许可 | 吸收方式 |
|---|---|---|---|
| `lib/sfx.js` | 无上游 | — | 纯自写 DSP（噪声整形、RBJ 双二阶滤波、加法合成、颗粒/门限调度），无第三方代码、参数表或素材 |
| `lib/beatsync.js` | video-shotcraft（经 dsh-drawai 固定提交 1266a3e） | Apache-2.0 | 方法论：最小二乘拍网格拟合、2x/0.5x 消歧、鼓件三分类、渲后回测 ≤3f、输出音轨偏移交叉相关实测；实现与阈值管线为本仓自写 |
| `lib/shots.js`（44 → 168 张） | 同上 | Apache-2.0 | 词汇表、参数数值与「已知坑」忠实保留；schema、中文文案与措辞为本仓自写。上游 124 张卡 + 本仓原 44 张 |
| `lib/aesthetic.js` | 同上 | Apache-2.0 | 27 条判例式准则的规则文本与判例索引；检查器实现、阈值管线与中文文案为本仓自写 |
| `lib/review.js` | 同上 | Apache-2.0 | 五节结构与「制作者自检不作为证据」立场；判定规则、打分与中文文案为本仓自写 |
| `lib/mgstyles.js` + `assets/mgstyles/` | mg-styles-15（经 dsh-drawai 固定提交 49052d80） | 上游 README 声明为素材整理项目，**提示词与文档部分未逐项列明许可** | 只取 15 套风格的**运动语汇、配色结构与禁忌方向**，中文提示词与 3 个可运行 HTML 模板均为本仓自写；**未转存上游任何图片、纹理、字体或视频** |
| `lib/pagecapture.js` | video-shotcraft | Apache-2.0 | 方法论：全页 2x 截图 + hero 4x 元素级抠图 + layout.json 坐标/样式 token + CSS `zoom` 2.5D 放大与 `Tx = 960/zoom − cx` 换算；代码为本仓自写，浏览器发现复用 `lib/htmlrender.js` |
| `lib/pixelqa.js` | 无上游吸收 | — | PSNR / SSIM / CIEDE2000 为公开标准公式自写；`dsh-drawai/src/motion/pixelqa.js` 经审阅是色带/抗锯齿/字体检查，与配对帧比对是不同问题，未取 |
| `lib/timeline.js` | 无上游吸收 | — | 自写的 RenderPlan ↔ 时间线往返与离线 HTML 编辑器；真剪映工程导出需 `pyJianYingDraft`，本轮未做 |

**许可红线（第 7 轮新增）**

| 项目 | 约束 | 我们怎么做的 |
|---|---|---|
| video-shotcraft | Apache-2.0，**依赖 Remotion**（个人免费、公司可能需付费） | 未引入 Remotion、未复制 demo 的 TSX 源码；只吸收 Apache-2.0 允许的方法论与参数数值，并在此处署名 |
| mg-styles-15 | 上游部分纹理「未逐项列明作者与许可」 | **未转存任何素材文件**；只取运动/配色方向，写出本仓自己的提示词与模板 |
| dsh-drawai 自身 | MIT | 只读其架构与文档，未取代码；本项目与它是不同定位（它做画布编辑，本项目做感知与复刻） |
| 上游字体与音乐 | 各自独立许可 | 未打包；运行时只用本机系统字体与本机 ffmpeg / TTS |

---

## 3. 运行期依赖（不随本仓库分发）

本插件本身**零 npm 依赖**，但以下东西在运行时由本机提供或被渲染页面自行加载：

| 依赖 | 形态 | 说明 |
|---|---|---|
| FFmpeg / ffprobe | 本机安装 | 必需；建议 full build（`signalstats` / `scdet` / `ebur128` / `xfade` / `zoompan` / `whisper`） |
| Microsoft Edge / Chrome | 本机安装 | 仅 `media_animate` 需要；headless + CDP |
| whisper ggml 模型 | 首次自动下载 | 默认 tiny（约 74 MB），存于 `~/.dsh/media-senses/models/` |
| Windows SAPI 声部 | 操作系统自带 | 中文「Microsoft Huihui Desktop」、英文 Zira |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 由 `bin/README.md` 指导下载 | Unlicense；用于站点批量下载 |
| **页面内可选的动画库** | **由渲染页面自行通过 CDN 引入** | [GSAP](https://gsap.com/) / [Lottie](https://airbnb.io/lottie/) / [Three.js](https://threejs.org/) / [Anime.js](https://animejs.com/) 均**不由本仓库打包**，许可与版本由使用方自行负责 |
| Windows 系统字体 | 操作系统自带 | `media_build_video` 渲染时会把 `msyh.ttc` / `simhei.ttf` / `arial.ttf` 复制到临时目录供 drawtext 使用；这些字体**不在本仓库内**，随片分发前请自行确认字体授权 |
| `demo/media/` 示例素材 | 仓库内（仅演示） | 来源见 [demo/media/README.md](demo/media/README.md) |

---

## 4. 我们的代码

`index.js`、`lib/*.js`、`assets/templates/*.html`、`test/*.mjs` 均为本项目原创，
以 **MIT** 发布（见 [LICENSE](LICENSE)）。上面列出的第三方项目仅提供思路、阈值与工程结论；
如发现任何段落与上游文本雷同，属于疏漏，请提 issue 指出，我们会立即改写并补充署名。
