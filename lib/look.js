/**
 * lib/look.js — appearance vocabulary.
 *
 * "Make it look like X" is the vaguest request a model receives. This module
 * turns 8 art-direction families into concrete render parameters — palette,
 * material shading, light rig, post-processing and frame rate — plus a CSS
 * custom-property exporter so a generated HTML page can adopt a look with one
 * style block, and a 15-item "obvious AI look" checklist with executable fixes.
 *
 * Deliberately standalone: zero dependencies and **no imports from the rest of
 * the plugin** (report renderers and the HTML renderer can import this file
 * without a cycle).
 *
 * Parameter conventions (all values are unitless where not stated):
 *   palette[5]   [background, ink/text, accent, midtone, highlight] as #rrggbb.
 *   materials.shading   one of 'pbr' | 'toon' | 'painterly' | 'clay' | 'paper' |
 *                       'flat' | 'ink' | 'vhs'; how surfaces are shaded.
 *   materials.steps     shading quantisation steps, 0 = continuous gradient,
 *                       2–3 = cel/toon banding.
 *   materials.roughness 0 = mirror, 1 = fully diffuse.
 *   light.*             a single key light + ambient: azimuth/elevation in degrees,
 *                       intensity multiplier, ambient fill 0..1, fog 0..1,
 *                       exposure in stops.
 *   post.saturation/contrast   1 = untouched; tone is a display-transform name.
 *   post.bloom/chromatic/outline/vignette/grain/scanline   0..1 effect strength
 *                       (chromatic = RGB-split amount, outline = ink/edge line).
 *   render.fps          output frame rate; render.hold = frames each pose is held
 *                       (1 = on ones, 2 = "on twos" stop-motion/anime cadence).
 *
 * These are *presets*, not laws: they are the starting values a director would
 * dial in, and every field is something a renderer can actually consume.
 *
 * @module lib/look
 */

/* ------------------------------------------------------------------ *
 * Look families (8)
 * ------------------------------------------------------------------ */

/**
 * The 8 look families. Each entry has exactly the five parameter groups from the
 * vocabulary contract plus `id`, `nameZh` and `oneLineZh` for model-facing text.
 */
export const LOOKS = [
  {
    id: 'cinematic-realistic',
    nameZh: '电影写实',
    oneLineZh: '自然光、真实材质、低饱和高动态范围，克制是最贵的效果',
    palette: ['#0b0f14', '#1c2530', '#c8a06a', '#8a7a63', '#f4efe6'],
    materials: { shading: 'pbr', steps: 0, roughness: 0.62 },
    light: { azimuthDeg: 35, elevationDeg: 22, intensity: 1.15, ambient: 0.32, fog: 0.08, exposure: 0.0 },
    post: { tone: 'filmic', saturation: 0.92, contrast: 1.06, bloom: 0.12, chromatic: 0.02, outline: 0.0, vignette: 0.24, grain: 0.06, scanline: 0.0 },
    render: { fps: 24, hold: 1 },
  },
  {
    id: 'anime-cel',
    nameZh: '日式赛璐璐动画',
    oneLineZh: '平涂色块 + 2–3 级阴影 + 硬描边，动作"拍二"（on twos）',
    palette: ['#1a2a4a', '#f2e6d0', '#ffd166', '#ef476f', '#8ecae6'],
    materials: { shading: 'toon', steps: 3, roughness: 0.15 },
    light: { azimuthDeg: 120, elevationDeg: 35, intensity: 1.2, ambient: 0.25, fog: 0.0, exposure: 0.05 },
    post: { tone: 'flat', saturation: 1.15, contrast: 1.1, bloom: 0.05, chromatic: 0.0, outline: 0.6, vignette: 0.05, grain: 0.0, scanline: 0.0 },
    render: { fps: 24, hold: 2 },
  },
  {
    id: 'pastel-storybook',
    nameZh: '粉彩绘本',
    oneLineZh: '低对比粉彩色、柔光、纸纹可见，像翻开一本睡前绘本',
    palette: ['#f7efe4', '#6b5b73', '#e8a0a8', '#b9cdbc', '#ffe3b3'],
    materials: { shading: 'painterly', steps: 0, roughness: 0.85 },
    light: { azimuthDeg: 210, elevationDeg: 40, intensity: 0.85, ambient: 0.55, fog: 0.15, exposure: 0.1 },
    post: { tone: 'soft', saturation: 0.8, contrast: 0.9, bloom: 0.2, chromatic: 0.0, outline: 0.1, vignette: 0.12, grain: 0.08, scanline: 0.0 },
    render: { fps: 24, hold: 2 },
  },
  {
    id: 'claymation',
    nameZh: '黏土定格',
    oneLineZh: '哑光橡皮泥质感、指纹与接缝可见、12 fps 定格步进',
    palette: ['#2b211c', '#f1e3cd', '#d4541f', '#e0a84f', '#7f9c6a'],
    materials: { shading: 'clay', steps: 0, roughness: 0.95 },
    light: { azimuthDeg: 45, elevationDeg: 50, intensity: 1.0, ambient: 0.3, fog: 0.05, exposure: 0.0 },
    post: { tone: 'warm', saturation: 0.95, contrast: 1.0, bloom: 0.08, chromatic: 0.02, outline: 0.0, vignette: 0.2, grain: 0.1, scanline: 0.0 },
    render: { fps: 12, hold: 2 },
  },
  {
    id: 'papercut-collage',
    nameZh: '剪纸拼贴',
    oneLineZh: '硬边纸片层、投影分离前后景、纸纹与撕边，不画渐变',
    palette: ['#f3ead8', '#2f2a26', '#c23b22', '#3f6c8e', '#e9c46a'],
    materials: { shading: 'paper', steps: 2, roughness: 0.9 },
    light: { azimuthDeg: 300, elevationDeg: 55, intensity: 0.9, ambient: 0.4, fog: 0.02, exposure: 0.05 },
    post: { tone: 'paper', saturation: 0.85, contrast: 1.0, bloom: 0.03, chromatic: 0.0, outline: 0.15, vignette: 0.1, grain: 0.05, scanline: 0.0 },
    render: { fps: 12, hold: 2 },
  },
  {
    id: 'retro-synthwave-vhs',
    nameZh: '复古合成波/VHS',
    oneLineZh: '洋红青霓虹、扫描线、色差与噪点，但只用一个光源符号',
    palette: ['#12051f', '#f7e7ff', '#ff2d95', '#00e5ff', '#ffb400'],
    materials: { shading: 'flat', steps: 0, roughness: 0.2 },
    light: { azimuthDeg: 250, elevationDeg: 15, intensity: 1.3, ambient: 0.2, fog: 0.3, exposure: -0.1 },
    post: { tone: 'vhs', saturation: 1.3, contrast: 1.15, bloom: 0.55, chromatic: 0.35, outline: 0.1, vignette: 0.45, grain: 0.18, scanline: 0.6 },
    render: { fps: 30, hold: 1 },
  },
  {
    id: 'glossy-commercial',
    nameZh: '高光商业广告',
    oneLineZh: '干净三点光、低粗糙度、轻微辉光，主体永远被光"托"起来',
    palette: ['#f5f6f8', '#141821', '#2f6fed', '#9aa4b2', '#ffffff'],
    materials: { shading: 'pbr', steps: 0, roughness: 0.25 },
    light: { azimuthDeg: 60, elevationDeg: 45, intensity: 1.5, ambient: 0.45, fog: 0.02, exposure: 0.2 },
    post: { tone: 'clean', saturation: 1.05, contrast: 1.05, bloom: 0.3, chromatic: 0.03, outline: 0.0, vignette: 0.15, grain: 0.02, scanline: 0.0 },
    render: { fps: 30, hold: 1 },
  },
  {
    id: 'handmade-ink',
    nameZh: '手绘水墨/钢笔',
    oneLineZh: '纸底、浓淡墨线、有限上色，留白比画面更重要',
    palette: ['#f4efe4', '#1d1a17', '#8c2f1b', '#5b6770', '#d9c8a9'],
    materials: { shading: 'ink', steps: 2, roughness: 0.7 },
    light: { azimuthDeg: 100, elevationDeg: 60, intensity: 0.8, ambient: 0.5, fog: 0.05, exposure: 0.0 },
    post: { tone: 'paper', saturation: 0.4, contrast: 1.25, bloom: 0.02, chromatic: 0.0, outline: 0.75, vignette: 0.2, grain: 0.12, scanline: 0.0 },
    render: { fps: 12, hold: 2 },
  },
]

/** `id -> look` lookup. */
export const LOOKS_BY_ID = Object.fromEntries(LOOKS.map((look) => [look.id, look]))

/** Look up a look by id (null when unknown). */
export function getLook(id) {
  if (typeof id !== 'string') return null
  return Object.prototype.hasOwnProperty.call(LOOKS_BY_ID, id) ? LOOKS_BY_ID[id] : null
}

/* ------------------------------------------------------------------ *
 * CSS custom properties
 * ------------------------------------------------------------------ */

/**
 * Render a look as CSS custom properties, e.g.
 *   `--ms-bg: #0b0f14; --ms-ink: #1c2530; --ms-accent: #c8a06a; ...`
 *
 * Accepts a look object or a look id. Returns an empty string for unknown looks
 * so a template literal can embed it unconditionally without `undefined`
 * leaking into the page.
 *
 * @param {object|string} look a LOOKS entry or its id
 * @returns {string} semicolon-separated CSS declarations
 */
export function lookCssVars(look) {
  const entry = typeof look === 'string' ? getLook(look) : look
  if (entry === null || typeof entry !== 'object') return ''
  const {
    palette = [],
    materials = {},
    light = {},
    post = {},
    render = {},
  } = entry
  const [background = '#000000', ink = '#ffffff', accent = '#888888', midtone = '#555555', highlight = '#dddddd'] = palette
  const declarations = [
    `--ms-bg: ${background}`,
    `--ms-ink: ${ink}`,
    `--ms-accent: ${accent}`,
    `--ms-mid: ${midtone}`,
    `--ms-light: ${highlight}`,
    `--ms-shading: ${materials.shading}`,
    `--ms-shade-steps: ${materials.steps}`,
    `--ms-roughness: ${materials.roughness}`,
    `--ms-light-azimuth: ${light.azimuthDeg}deg`,
    `--ms-light-elevation: ${light.elevationDeg}deg`,
    `--ms-light-intensity: ${light.intensity}`,
    `--ms-ambient: ${light.ambient}`,
    `--ms-fog: ${light.fog}`,
    `--ms-exposure: ${light.exposure}`,
    `--ms-tone: ${post.tone}`,
    `--ms-saturation: ${post.saturation}`,
    `--ms-contrast: ${post.contrast}`,
    `--ms-bloom: ${post.bloom}`,
    `--ms-chromatic: ${post.chromatic}`,
    `--ms-outline: ${post.outline}`,
    `--ms-vignette: ${post.vignette}`,
    `--ms-grain: ${post.grain}`,
    `--ms-scanline: ${post.scanline}`,
    `--ms-fps: ${render.fps}`,
    `--ms-hold: ${render.hold}`,
  ]
  return declarations.join('; ')
}

/* ------------------------------------------------------------------ *
 * "Obvious AI look" antipattern checklist (15)
 * ------------------------------------------------------------------ */

/**
 * The 15 tells that make a generated video read as AI. Every item has
 * `tellZh` (what a viewer notices), `whyZh` (why it reads synthetic) and
 * `fixZh` (a concrete parameter change, with numbers, that fixes it).
 */
export const LOOK_ANTIPATTERNS = [
  {
    id: 'purple-teal-gradient',
    tellZh: '每个画面都是紫→青渐变背景，像套了同一个滤镜',
    whyZh: '紫青渐变是早期 AI 生图模型的默认审美，出现即暴露来源',
    fixZh: '把背景换成片子的叙事环境（真实墙面/天空/纸张），或把渐变改为同色相 2 级明度差（ΔL ≤15%）',
  },
  {
    id: 'particle-soup',
    tellZh: '满屏漂浮粒子/光点，没有一片静止区域',
    whyZh: '粒子是"廉价的动感"，不承载信息，只证明"你看我在动"',
    fixZh: '粒子只保留 1 层、覆盖面积 ≤8%，且只在转场 0.4 s 内出现；主画面留出 ≥60% 的安静区域',
  },
  {
    id: 'lens-flare-abuse',
    tellZh: '镜头光晕（lens flare）横穿画面，甚至每个镜头都有',
    whyZh: '光晕本应来自画面内的真实光源；无光源的光晕等于承认合成',
    fixZh: '每个片子最多 1 次光晕，且必须画出一个可见光源；其余镜头用 0.1 强度的 bloom 代替',
  },
  {
    id: 'rgb-split-every-cut',
    tellZh: '每次切换都 RGB 分离，像故障艺术或老式 3D 眼镜',
    whyZh: '色差被当作"高级感"滥用，会让画面发糊、文字难读',
    fixZh: '色差只在 2–3 帧的冲击点使用，强度 ≤0.3；正文和大字号数字上色差必须为 0',
  },
  {
    id: 'neon-overload',
    tellZh: '处处霓虹、每个元素都在发光，没有明暗层次',
    whyZh: '全亮 = 全不亮；霓虹需要暗部对比才成立',
    fixZh: '发光元素不超过画面 15% 面积，保留 1 个霓虹主色 + 1 个中性色；暗部亮度压到 ≤0.15',
  },
  {
    id: 'bouncy-easing',
    tellZh: '每个元素入场都回弹一下（back/elastic），连字幕都在弹',
    whyZh: '回弹是强调手段；处处强调 = 没有重点，而且廉价',
    fixZh: '每 10 秒最多 1 个回弹（damping ≤0.5）；其余入场用 expo.out，位移 ≤40 px、时长 0.3–0.5 s',
  },
  {
    id: 'slowmo-everything',
    tellZh: '全片慢动作/慢速漂移，没有正常速度的片段',
    whyZh: '慢动作是情绪重音；连续慢 = 没有节奏，只显得拖沓',
    fixZh: '慢动作段落 ≤全片 20%，且每个慢段前要有一个正常速度的对照镜头；其余镜头用 1.0–1.2 倍速',
  },
  {
    id: 'centered-black-title',
    tellZh: '开篇必是"黑底+居中白字大标题"，字体还是默认无衬线',
    whyZh: '这是模板封面，不是设计；没有版式信息，也没有风格承诺',
    fixZh: '标题改为与内容有关的构图：三分线对齐、加 1 个视觉锚点（图形/实拍/纹理），字号按画面宽度 8–12% 取值',
  },
  {
    id: 'same-framing-speed',
    tellZh: '相邻两个镜头景别相同、运动速度相同，像复制粘贴',
    whyZh: '景别和速度必须有变化，否则眼睛分不清"换镜头了"',
    fixZh: '相邻镜头景别至少差 1 级（如 WS→MS），运动速度差 ≥1.5 倍；或一个动一个静',
  },
  {
    id: 'teal-orange-default',
    tellZh: '无脑青橙调：阴影死青、肤色橘到发光',
    whyZh: '青橙本是为肤色-环境分离服务的工具色；滥用后所有片子长得一样',
    fixZh: '阴影青偏移 ≤-8（a*/b* 单位），高光暖偏移 ≤+10；先确定一个主色相，再让青橙只出现在互补位置',
  },
  {
    id: 'noise-nebula',
    tellZh: '用程序噪声做星云/烟雾/流体，纹理没有方向、看起来像 screensaver',
    whyZh: '噪声纹理缺少受光逻辑和尺度关系，一眼就是 shader 默认输出',
    fixZh: '噪声只作为 5–10% 透明度的叠加层；主体纹理改用 2–3 层有方向性的手绘/纸纹贴图',
  },
  {
    id: 'floating-glass-cards',
    tellZh: '一堆浮空玻璃拟态卡片，直角悬空、阴影模糊一片',
    whyZh: '玻璃卡片没有接触面也没有光源方向，像后处理堆出来的 UI',
    fixZh: '卡片要么有承托（地面/桌面/阴影接触点），要么干脆不要；最多 2 张卡，间距 ≥卡片宽的 40%',
  },
  {
    id: 'default-fonts',
    tellZh: '全片只有系统默认无衬线（Arial/思源默认字重），文字不参与设计',
    whyZh: '字体是风格的第一信号；默认字体等于没做美术',
    fixZh: '标题用一个有性格的字体 + 字重对比（如 700 vs 300），正文与标题字重差 ≥2 级；中文标题字号 ≥画面宽 6%',
  },
  {
    id: 'bloom-everywhere',
    tellZh: '整个画面都在发光，高光糊成一片，细节丢失',
    whyZh: 'bloom 是镜头缺陷模拟；全屏 bloom 让对比度和文字锐度一起消失',
    fixZh: 'bloom 只给最亮的 2–3 个元素（荧光灯/太阳/屏幕），强度 ≤0.3；文字层 bloom 必须为 0',
  },
  {
    id: 'unmotivated-drift',
    tellZh: '画面一直在缓慢漂移/缩放，但没有任何叙事理由',
    whyZh: '无动机的运镜像"手抖"，会分散注意力并让观众晕',
    fixZh: '静止镜头就真正静止（位移 ≤1 px/s）；要运镜就给出方向性目标（推近=强调，拉远=揭示），速度按 slow 档 ≥6 s 过画',
  },
]

/** `id -> antipattern` lookup. */
export const LOOK_ANTIPATTERNS_BY_ID = Object.fromEntries(LOOK_ANTIPATTERNS.map((entry) => [entry.id, entry]))

/** Look up one antipattern by id (null when unknown). */
export function getAntipattern(id) {
  if (typeof id !== 'string') return null
  return Object.prototype.hasOwnProperty.call(LOOK_ANTIPATTERNS_BY_ID, id) ? LOOK_ANTIPATTERNS_BY_ID[id] : null
}

export default {
  LOOKS,
  LOOKS_BY_ID,
  getLook,
  lookCssVars,
  LOOK_ANTIPATTERNS,
  LOOK_ANTIPATTERNS_BY_ID,
  getAntipattern,
}
