# media-senses v2 — 仿制闭环契约

目标变了：从「单文件感知」升级为 **批量看片 → 提炼制作技法 → 自己动手仿制**。

本文件是 Lead 与两名引擎开发者的接口契约。先读 `lib/ffmpeg.js`、`lib/png.js`、`CONTRACT.md`
（v1 的引擎接口仍然有效），再动手。

## 硬性约束（与 v1 相同）

- ESM，零运行时依赖（只用 Node 内置 + `lib/ffmpeg.js` + `lib/png.js`），Node >= 20。
- 每个文件 `node --check` 通过；只写自己名下的文件。
- 所有 ffmpeg 调用：**绝不把 Windows 绝对路径放进 filtergraph 选项**（`-vf`/`-af`/`-filter_complex`）。
  统一做法：`run(bin, args, { cwd: workDir })` + filtergraph 内用**相对文件名**；`-i`/`-map` 可以用绝对路径。
  drawtext 的字形库用 `cwd=C:\Windows\Fonts` + `fontfile=msyh.ttc`（中文）/`arialbd.ttf`（英文）。
- 返回对象严格 JSON 可序列化、数值有限（无 NaN/Infinity），时间四舍五入到 0.01。
- 失败降级：坏文件/坏参数返回带 `warnings` 的结果或抛清晰错误，不许静默产出错视频。

## 机器事实（已验证）

- ffmpeg 9.0.2 full build：`xfade`（57 种转场）、`zoompan`、`drawtext`、`loudnorm`、`sidechaincompress`、
  `amix`、`apad`、`tpad`、`concat`、`fade`、`subtitles`、`overlay` 全可用。
- Windows SAPI 语音：`Microsoft Huihui Desktop`（zh-CN 女声）、`Microsoft Zira Desktop`（en-US 女声）。
- 系统字体：`C:\Windows\Fonts\msyh.ttc`（微软雅黑，中文）、`msyhbd.ttc`、`arialbd.ttf`、`simhei.ttf`。

---

## 模块 A — `lib/build.js`（owner: video-builder）

渲染计划 → MP4。这是模型「仿制」时真正调用的引擎。

```js
export async function buildVideo({ tools, plan, workDir, signal, options = {} })
  // tools: { ffmpeg, ffprobe }
  // plan: RenderPlan（见下）; workDir: 绝对临时目录（可写）
  // returns BuildResult
```

### RenderPlan（Lead 定稿，不要改字段名）

```jsonc
{
  "output": "D:/abs/out.mp4",            // 必填，绝对路径
  "width": 1080, "height": 1920, "fps": 30,
  "background": "#101018",                // 兜底底色
  "loudnessTarget": -16,                  // LUFS，null 表示不归一化
  "scenes": [                             // 必填，>=1
    {
      "type": "text",                     // text | image | color | gradient
      "duration": 2.5,                    // 秒，>=0.2
      "text": "标题", "subtitle": "副标题",
      "font": "msyh",                     // msyh | msyhbd | arial | arialbd | simhei
      "fontSize": 96,                     // 相对 1080 宽的像素；按 width/1080 缩放
      "color": "#ffffff", "background": "#120c2b",
      "align": "center",                  // center | left | bottom
      "animation": "none",                // none | fade | slide-up
      "transitionIn": "cut",              // cut | fade | slideleft | wipeleft | circleopen | dissolve
      "transitionDuration": 0.5
    },
    {
      "type": "image",
      "duration": 5,
      "src": "D:/abs/photo.jpg",          // 必填
      "motion": "kenburns-in",            // none | kenburns-in | kenburns-out | pan-left | pan-right | pan-up | pan-down | tilt-up | tilt-down
      "fit": "cover",                     // cover | contain
      "transitionIn": "fade", "transitionDuration": 0.6
    },
    { "type": "color", "duration": 1.2, "background": "#000000" },
    { "type": "gradient", "duration": 2, "gradient": ["#120c2b", "#2b1a4a"], "angle": 45 }
  ],
  "captions": [                           // 可选，烧在成片上
    { "start": 1.0, "end": 3.0, "text": "字幕内容", "position": "bottom", "fontSize": 44, "color": "#ffffff" }
  ],
  "audio": {
    "music": "D:/abs/music.mp3",          // 可选
    "musicStart": 0, "musicVolumeDb": -20, "musicFadeOut": 2,
    "voiceover": [                        // 可选，每段是一个音频文件或要合成的话术
      { "src": "D:/abs/voice.wav", "start": 0.4, "volumeDb": 0 },
      { "text": "旁白文字", "start": 6.5, "voice": "zh", "rate": 1.0 }   // 交给 lib/tts.js 合成
    ]
  }
}
```

### BuildResult

```jsonc
{
  "ok": true,
  "output": "D:/abs/out.mp4",
  "duration": 15.0, "width": 1080, "height": 1920, "fps": 30,
  "scenes": 4, "bytes": 1234567, "renderSeconds": 12.3,
  "audio": { "music": true, "voiceoverSegments": 2, "loudnessNormalized": true },
  "timeline": [{ "index": 0, "type": "text", "start": 0, "end": 2.4 }],
  "warnings": []
}
```

### 实现要求

1. **两阶段渲染**：先把每个场景渲染成 `workDir` 下的中间片（同尺寸/fps/pix_fmt/yuv420p），
   再用 `xfade` 链式拼接；`transitionIn: "cut"` 的场景用 concat 语义（transitionDuration=0）。
2. **时间线计算**：`offset_i = Σ duration(0..i) - Σ transitionDuration(0..i)`；
   成片总时长 = Σ duration − Σ transitionDuration。`timeline` 必须与画面一致（自测可断言）。
3. **文字场景**：`color=...` 打底 + `drawtext`；中文用 `msyh.ttc`；支持 `\n` 换行（拆成多行 drawtext 或
   `line_spacing`）；`animation: fade` → `fade=t=in:st=0:d=0.4`；`slide-up` → 用 `y` 表达式带 t 缓动。
   文字过长要自动缩短或缩字号（不许溢出画面）——按字符数估算宽度并降字号。
4. **图片场景**：`-loop 1 -t D -i img` + `scale=...:force_original_aspect_ratio=increase,crop=W:H`；
   `kenburns-in` 用 `zoompan=z='min(zoom+0.0008,1.15)'`，`pan-left/right` 用 `zoompan=x` 表达式，
   `pan-up/down`（等价 `tilt-up/down`）用 `zoompan=y` 表达式，四向平移共用同一套 0..1 归一化行程；
   注意 zoompan 需要 `fps` 与 `d` 正确设置，输出帧数 = duration*fps。
5. **音频**：总时长精确对齐成片；music 先 `atrim` 再 `afade`；voiceover 用 `adelay`；
   用 `amix=inputs=N:normalize=0` 混音（避免音量被均分）；最后 `loudnorm=I=<target>:TP=-1.5:LRA=11`。
   没有音轨时生成静音 `anullsrc`，保证成片始终有音轨。
6. **字幕**：成片二次 pass 烧 drawtext，`enable='between(t,start,end)'`，位置 bottom 时留 8% 安全边距。
7. 所有中间文件放 `workDir`；只写出 `plan.output` 一个最终文件（可额外写同名 `.json` sidecar？不要）。
8. 成片必须能被 `ffprobe` 读、能被 v1 的 `analyzeVideo` 分析（分辨率和时长对得上）。

### 自测（`test/build-engine.test.mjs`，你写）

用 `lib/png.js` 或 ffmpeg 生成 2 张测试图，渲染：
- 4 场景竖屏 1080x1920@30fps：text(2s, fade in) → image(3s, kenburns, transition fade 0.5) →
  gradient(1.5s, transition slideleft 0.4) → text(1.5s)；加 2 条字幕、一段 music（用 ffmpeg 合成
  的正弦+鼓点也可）和一段 `text` 旁白（zh）。
- 断言：产物存在且 > 100KB；ffprobe 的 width/height/fps 正确；成片时长 = 8 − 0.9 = 7.1s ±0.15；
  有 1 条音频流；`timeline` 与公式一致；对成片跑一次 `analyzeVideo`（若可用）确认能分析。
- 退化用例：非法场景列表、缺失图片、空 captions、无音频 —— 报清晰错误或 warnings，不产出半成品。

---

## 模块 B — `lib/tts.js`（owner: video-builder）

```js
export async function listVoices({ tools })        // -> [{ name, culture, gender }]
export async function synthesizeSpeech({ tools, text, outputPath, voice = 'zh', rate = 1.0, volume = 1.0, workDir })
  // voice: 'zh' | 'en' | 完整 SAPI 名称（如 'Microsoft Huihui Desktop'）
  // returns { ok, path, seconds, voice, warnings }
```

要求：用 PowerShell 调 `System.Speech.Synthesis.SpeechSynthesizer`；**文本写到 UTF-8 临时文件再读**，
避免命令行引号/中文编码问题；输出 16-bit 16kHz 单声道 wav；用 ffprobe 取时长；
找不到中文声部时回退 en 并给 warning；`synthesizeSpeech` 失败要返回 `ok:false` 而不是抛（`buildVideo`
里要能降级成无旁白）。`voice:'zh'` 优先选 culture 以 `zh` 开头的声部。

自测：合成一句中文 + 一句英文，断言 wav 存在、>5KB、时长 >1s、ffprobe 可读。

---

## 模块 C — `lib/craft.js`（owner: craft-engine）

分析一个**已由 v1 视频引擎分析过**的视频，提炼「它是怎么做的」。

```js
export async function analyzeCraft({ tools, file, workDir, analysis, artifactDir, options = {}, signal })
  // analysis: v1 `analyzeVideo` 的返回值（含 shots/timeline/stream/global/audio）
  // options: { lowResFrames?: boolean = true, maxSamples?: number = 240 }
  // returns { craft, recipe }        // 两个都可 JSON 序列化
```

### `craft` 字段（全部必填，缺失用 null，但结构要在）

```jsonc
{
  "cutRhythm": {
    "shotCount": 3, "avgShotLength": 3.2, "medianShotLength": 3.0,
    "shortestShot": 1.2, "longestShot": 5.0, "stdDev": 1.1,
    "cutRatePerMin": 18.75, "cutsPer10s": [2, 3, 1]       // 10 秒分箱
  },
  "transitions": {
    "hardCutShare": 0.8, "gradualShare": 0.2,
    "list": [{ "at": 5.76, "kind": "cut" | "fade" | "dip-to-black" | "other", "confidence": 0.9 }]
  },
  "camera": [ { "shotIndex": 0, "motion": "static" | "pan-left" | "pan-right" | "tilt-up" | "tilt-down" | "zoom-in" | "zoom-out" | "handheld", "intensity": 0.0 } ],
  "grading": {
    "contrast": 0.25, "saturation": 0.4,
    "temperature": "warm" | "neutral" | "cool",
    "shadowTint": "blue" | "teal" | "warm" | "neutral",
    "highlightTint": "warm" | "neutral" | "cool",
    "signature": ["high-contrast", "teal-orange", "desaturated", "warm", "cool", "low-contrast", "neutral"]
  },
  "overlays": { "textDensity": 0.0, "likelySubtitles": false, "likelyTitleCard": true, "topBandDetail": 0.1, "bottomBandDetail": 0.2 },
  "hook": { "hasEarlyCut": false, "hasTitleInFirst3s": true, "firstShotMotion": "static", "hookStrength": 0.4 },
  "beatSync": { "bpm": 100.3, "cutsOnBeatRatio": 0.6, "meanOffsetMs": 80, "note": "cuts land within 120 ms of a beat" },
  "sections": [ { "start": 0, "end": 5.76, "role": "intro" | "body" | "outro", "avgShotLength": 5.76 } ],
  "titleCard": { "present": true, "at": 0.0, "duration": 2.0, "style": "centered-white-on-dark" },
  "warnings": []
}
```

### `recipe` 字段（这是模型仿制时的输入骨架，字段名固定）

```jsonc
{
  "schema": "media-senses.recipe/v1",
  "duration": 19.16, "aspect": "16:9",
  "resolution": { "width": 640, "height": 360 }, "fps": 25,
  "shots": [ { "index": 1, "start": 0, "end": 5.76, "duration": 5.76, "camera": "static",
               "brightness": 0.38, "palette": ["#122913", "#375629"], "transitionIn": "cut" } ],
  "look": { "palette": ["#122913"], "grading": ["high-contrast"], "temperature": "neutral",
            "textDensity": 0.0, "titleCard": "centered-white-on-dark" },
  "sound": { "hasMusic": true, "bpm": 100.3, "key": "C major", "hasSpeech": true,
             "speechKind": "narration" | "dialogue" | "none", "musicDb": -20 },
  "pacing": { "avgShotLength": 9.6, "cutRatePerMin": 3.1, "beatSync": 0.0 },
  "reproductionNotes": ["两个长镜头，几乎静止，靠旁白推进", "低彩度自然色，冷调沙滩/暖调树林"]
}
```

### 实现要点

1. **相机运动**：一次 ffmpeg pass 把整片解码成低分辨率帧序列（`fps=4,scale=80:45,format=gray`,
   `-f rawvideo` 写相对文件名），在 JS 里对相邻帧做 ±6px 的平移搜索（SAD 最小），逐镜头统计
   全局位移的均值来判定 pan/tilt；`zoom` 用中心-边缘的位移比；高频抖动 → handheld。
   一个 pass 拿全片，别按镜头重复 decode。
2. **转场**：硬切 vs 渐变，用 `analysis.timeline` 的 `motion`/`brightness` 与镜头边界处的
   亮度下探（dip-to-black）判断；渐变转场表现为边界前后 ±0.5s 亮度/差异度连续爬升。
3. **调色**：用拍到的低分辨率 RGB 帧（可复用上面 gray pass 再取一次 RGB 小帧，或在 craft 中单独
   用 `scale=160:90,format=rgb24` 采样 30 帧）→ 阴影/中间调/高光的平均色偏 + 全局饱和度/对比度。
4. **钩子**：前 3 秒是否有切点、是否有标题卡（高边缘密度+低运动+居中）、首镜头运动。
5. **卡点**：有 `analysis.audio.tempo.beatTimes` 时，算每个切点到最近拍点的距离 → 卡点率。
6. **章节**：intro = 首镜头；outro = 末镜头；其余 body。若首镜头同时是标题卡则 intro 更确定。
7. `reproductionNotes` 用**中文**，3–6 条，是可执行的制作建议（例如「每 2–3 秒硬切一次」
   「竖屏 9:16，字幕距底 8%」）。这是模型学习「怎么拍」的主要文本。

### 自测（`test/craft-engine.test.mjs`）

用 `test/fixtures/scenes.mp4`（3 场景，已知切点 4s/8s）+ `demo/media/trailer.mp4`（2 场景，
已知切点 5.76s）跑：断言 `craft.cutRhythm.shotCount` 与 `analysis.shots.length` 一致、
`transitions.list` 里切点时间与镜头边界误差 < 0.3s、`recipe.shots.length` 与镜头数一致、
`beatSync.cutsOnBeatRatio` 在 [0,1]、所有数值有限、JSON 往返一致、`reproductionNotes` 非空。
另造一个 1 秒纯色视频（无切点）→ 不崩、`hardCutShare` 为 0 或 null、有 warning。

---

## 模块 D — `lib/corpus.js` + `lib/profile.js`（owner: Lead，不用碰）

Lead 负责：批量扫描/下载、并发分析、缓存、聚合出 `STYLE-PROFILE.md`、以及 `media_corpus` /
`media_build_video` / `media_tts` 三个工具的注册与报告渲染。

## 测试与交付

```text
node test/build-engine.test.mjs    # 你写
node test/craft-engine.test.mjs    # 你写
node --check <你的每个文件>
```

报告：文件清单、导出面、测试 PASS/FAIL 统计、实测数据（成片时长/尺寸/音量、
craft 在 fixtures 上的切点与运动判定）、偏差说明、任务是否 completed。
