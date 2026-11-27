/**
 * 整片 MG 风格系统（15 套）——media_styles 是「单镜头风格」，本模块补的是
 * 「整片视觉系统」：配色、字号层级、运动曲线倾向、质感/噪点、禁忌一次性给定，
 * 让模型写一支 10 秒整片时不必自己拍脑袋定视觉规范。
 *
 * 来源与许可（重要）：
 * - 风格清单与「运动语汇的事实」来自 mg-styles-15（Vincentwei1021，MIT，
 *   固定提交 49052d80bfaf9fa8412cc9710530e5e95a3b8d8c，经 dsh-drawai 收录）；
 *   其中 23-ink-wash 来自 huashu-art-motion（alchaincyf，MIT，见上游 origins 记录）。
 * - 本模块的 `zh/en/promptZh/typeZh/motionZh/textureZh/avoidZh` 全部由我们自行
 *   中文撰写/转写，是「换到 HTML + window.renderAt(t) 渲染栈之后的落地指令」，
 *   不是上游英文提示词的翻译或摘抄。
 * - 不收录 04-3d-render（上游用 Blender 离线渲 CGI，本插件没有等价物，硬凑只会更假）。
 * - 不 vendor 上游任何素材：纹理、照片、字体、视频、地图数据、demo 源码均未复制；
 *   模板里的图形全部由代码绘制，随机数用固定种子的 mulberry32，因此无第三方素材
 *   许可风险。上游 README 提到的颗粒/灰尘/胶带纹理属于「上游未逐项列明许可」的
 *   第三方素材，本模块不引用它们。
 *
 * 设计原则：
 * - 零依赖、纯数据 + 纯函数、可 JSON 序列化；
 * - promptZh 直接可用于「写一个实现 renderAt(t) 的 HTML」的模型指令；
 * - 所有颜色给 hex 并注明角色，所有运动给具体缓动/帧数/错峰，不写「有节奏感」这类空话。
 */

/** 家族清单：findMgStyles 的 family 过滤值与界面分组都用它。 */
export const MG_FAMILIES = Object.freeze([
  { id: 'flat', zh: '扁平解释' },
  { id: 'illustration', zh: '手绘线条' },
  { id: 'spatial', zh: '等轴空间' },
  { id: 'handmade', zh: '手工材质' },
  { id: 'organic', zh: '有机形变' },
  { id: 'graphic', zh: '几何构成' },
  { id: 'retro', zh: '复古媒介' },
  { id: 'soft-glow', zh: '光与玻璃' },
  { id: 'variety', zh: '综艺花字' },
  { id: 'explainer', zh: '信息科普' },
  { id: 'tech', zh: '科技界面' },
])

const FAMILY_ZH = new Map(MG_FAMILIES.map((family) => [family.id, family.zh]))
const ENERGY_VALUES = new Set(['low', 'medium', 'high'])

/** 把「一句话运动语汇」从 motionZh 里取出来（内部与报告用）。 */
function motionLine(style) {
  const first = style.motionZh.split('。')[0] ?? style.motionZh
  return first.replace(/^一句话：/u, '').trim()
}

/**
 * 拼 promptZh：固定顺序的 10 节，保证每一套都包含「判据 / 视觉 / 配色 / 字体 /
 * 运动 / 质感 / 结构 / 构图 / 确定性 / 禁忌」。这是给模型的完整施工指令，
 * 而不是风格介绍——所以每一节都写可执行参数。
 */
function buildPromptZh(style) {
  return [
    `你是整片 MG 的导演、动效设计师与前端工程师。请用纯 HTML + Canvas2D / SVG / CSS 写一支 10 秒的整片动画：` +
      `画面完全由 window.renderAt(t) 决定（t 为秒）。成片必须一眼被认出是「${style.zh}」（${style.en}）；` +
      '模板味即失败。',
    '',
    '【一眼认出的判据】',
    ...style.signatureZh.map((line) => `- ${line}`),
    '',
    `【视觉系统】${style.lookZh}`,
    '',
    '【配色（只许用这些 hex，按角色分配，禁止引入色板外的颜色）】',
    ...style.paletteRoles.map(([hex, role]) => `- ${hex}：${role}`),
    '',
    `【字体层级】${style.typeZh}`,
    '',
    `【运动语法】${style.motionZh}`,
    '',
    `【质感与噪点】${style.textureZh}`,
    '',
    '【10 秒结构（按实际时长等比缩放，不要平均切）】',
    ...style.structureZh.map((line) => `- ${line}`),
    '',
    `【构图】1920×1080；${style.gridZh}`,
    '',
    '【确定性与性能】',
    '- 禁 Math.random()、Date.now()、performance.now()、requestAnimationFrame 自播；需要随机用 mulberry32(固定 seed)，且只在初始化时生成；',
    '- 每帧是 t 的纯函数：同一个 t 必须渲染出完全相同的画面；',
    '- 内部按 1920×1080 绘制、外层 stage 等比缩放到视口；单帧绘制目标 ≤8ms；',
    '- 全部图形由代码绘制，禁外链字体/图片/脚本，离线必须能渲。',
    '',
    '【禁忌】',
    ...style.avoidZh.map((line) => `- ${line}`),
  ].join('\n')
}

/**
 * 定义一套风格：补齐 palette（从 paletteRoles 推导）、家族中文、一句话运动语汇、
 * promptZh，并冻结，防止调用方误改共享数据。
 */
function defineStyle(definition) {
  if (!ENERGY_VALUES.has(definition.energy)) {
    throw new Error(`MG 风格 ${definition.code}: energy 必须是 low/medium/high`)
  }
  if (!FAMILY_ZH.has(definition.family)) {
    throw new Error(`MG 风格 ${definition.code}: 未知 family ${definition.family}`)
  }
  const palette = definition.paletteRoles.map(([hex]) => hex)
  if (palette.length < 5) {
    throw new Error(`MG 风格 ${definition.code}: 至少需要 5 个颜色`)
  }
  const style = {
    id: definition.id,
    code: definition.code,
    zh: definition.zh,
    en: definition.en,
    energy: definition.energy,
    family: definition.family,
    familyZh: FAMILY_ZH.get(definition.family),
    palette,
    paletteRoles: definition.paletteRoles,
    typeZh: definition.typeZh,
    motionZh: definition.motionZh,
    motionLineZh: motionLine(definition),
    textureZh: definition.textureZh,
    lookZh: definition.lookZh,
    signatureZh: definition.signatureZh,
    structureZh: definition.structureZh,
    gridZh: definition.gridZh,
    avoidZh: definition.avoidZh,
    keywords: definition.keywords,
    promptZh: '',
  }
  style.promptZh = buildPromptZh(style)
  return Object.freeze(style)
}

/**
 * 15 套整片风格。顺序与上游 code 一致（跳过 04-3d-render）。
 * 每套的 zh / en / 运动参数 / 配色都是我们落地到 HTML 渲染栈后的表述。
 */
export const MG_STYLES = Object.freeze([
  defineStyle({
    id: 'flat-vector',
    code: '01-flat-vector',
    zh: '扁平矢量',
    en: 'Flat Vector 2D Motion Graphics',
    energy: 'medium',
    family: 'flat',
    keywords: ['扁平', '矢量', 'flat', 'vector', 'explainer', 'google', 'material', '品牌', 'squash'],
    paletteRoles: [
      ['#2B2BFF', '主色：天空底色与大面积主形'],
      ['#FF5A4E', '强调：角色、提示气泡、logo 圆点'],
      ['#FFC62B', '高光：太阳、成功态、金币'],
      ['#2EE6A8', '辅助：植物、确认、生长'],
      ['#FFF6E9', '纸底：留白与反转底'],
      ['#151433', '墨色：文字、平涂阴影、五线'],
    ],
    lookZh:
      'Google Material / 企业 explainer 的经典形态：纯色几何、无描边或极细描边、大色块撞色、干净留白；' +
      '角色是几何拼装（3–5 头身），全部元素都是矢量形状，禁止任何渐变、照片与 3D 体积感。',
    signatureZh: [
      '全部图形是纯色矢量形状，禁止渐变、照片与高光材质',
      '几何人物用支点旋转做四肢，比例 3–5 头身',
      '同一时刻只允许一个主体在动，其余元素保持静止',
      '转场由元素飞出带走画面（shape wipe / 元素驱动），不用交叉淡化',
      '弹性入场三段式：预备 → 冲出 → 回弹，位移带约 10% 挤压拉伸',
    ],
    typeZh:
      '标题 900 字重黑体（"Microsoft YaHei", "SimHei", sans-serif）120–160px、行高 1.05、字距 -0.02em；' +
      '副标 40–52px / 700；正文与标签 28–34px / 500；品牌 wordmark 用 "Arial Black" 全大写；' +
      '中文标点用全角，标题每行不超过 12 字，正文行高 1.4。',
    motionZh:
      '一句话：弹性三段式 + 错峰 2–4 帧 + 元素驱动转场。入场统一 cubic-bezier(0.34,1.56,0.64,1)（过冲 8–12%），' +
      '退场 cubic-bezier(0.55,0,1,0.45)；主形下落按「预备上提 4 帧 → 加速下落 → 落地压扁 10% → 回弹 6 帧」；' +
      '群组入场按 2–4 帧错峰，单帧只允许一个 hero 移动；转场让一个色块或图标放大出画并带出下一场。',
    textureZh:
      '不加噪点、不加颗粒、不加模糊投影；层次只用第二层纯色与 4–6px 硬边偏移；' +
      '阴影用 0 模糊的平涂深色块、透明度 12–18%；圆角只用 0 或全圆两种。',
    structureZh: [
      '0–0.12：钩子 —— 纯色场里一颗饱和圆做「预备-下落-压扁-回弹」，落地即交代风格',
      '0.12–0.30：圆变成太阳，扁平城市按 2–4 帧错峰弹出，云滑过、鸟扇翅',
      '0.30–0.55：镜头推近一扇窗，几何角色在桌前动作，手机弹出通知气泡',
      '0.55–0.80：通知气泡放大成色块擦除，柱状图/对勾/心形/硬币按节拍逐个弹入',
      '0.80–1.00：所有元素飞向中心组成品牌 wordmark + 一句 tagline，弹性落定后定格微动',
    ],
    gridZh: '12 列网格、120px 主模数，主元素落在模数上；安全边距 96px/54px。',
    avoidZh: [
      '任何渐变、玻璃、辉光或 3D 体积感',
      '塑料拟物阴影与写实材质',
      '两个以上主体同时运动',
      '粒子汤 / 程序噪声背景',
      '默认字体居中黑底标题',
      '真实品牌 logo 与商标',
    ],
  }),

  defineStyle({
    id: 'line-art',
    code: '02-line-art',
    zh: '单线描画',
    en: 'Line Art / One Line Animation',
    energy: 'low',
    family: 'illustration',
    keywords: ['线条', '一笔画', 'line', 'one line', 'stroke', '奢华', '建筑', '极简'],
    paletteRoles: [
      ['#0B1320', '午夜底：画面 90% 的负空间'],
      ['#E9D7A5', '香槟金：唯一造型线'],
      ['#F5F1E8', '象牙白：字标与笔尖端高光'],
      ['#8FA3B8', '冷灰蓝：远处淡线/辅助信息'],
      ['#2A3A4D', '深板岩：线转面的填充暗部'],
    ],
    lookZh:
      '以一条等宽细线作为唯一造型语言，线条自我描绘、延伸、转折并变形为下一个图形，一笔连成整支片；' +
      '大量负空间、单色或双色、极简高级感；线转面只发生一次，从锚点向外填充。',
    signatureZh: [
      '全片只有一根连续线（或极少数分支），线宽恒定 2–4px',
      '上一图形的收笔就是下一图形的起笔，路径中间不许断',
      '线转面只允许一次，且从锚点向外扩张填充',
      '运镜是虚拟相机跟笔尖：轻微跟随，片尾拉远成一张海报',
      '相机离开后的旧线降到约 35% 透明度，形成层次',
    ],
    typeZh:
      '细字距衬线标题（"Noto Serif SC", "Songti SC", "SimSun", serif）48–64px、字距 0.24em；' +
      '品牌英文小号 20–24px、字距 0.4em；全片最多两行文字，行高 1.6；中文标题可竖排；' +
      '禁用粗黑与装饰字体。',
    motionZh:
      '一句话：描线生长 + 转角减速 + 片尾拉远。用 stroke-dashoffset 0→100%（或 Canvas 等弧长采样）驱动，' +
      '缓动 cubic-bezier(0.65,0,0.35,1)，转角前 2 帧减速；相机漂移 8–12px/s，片尾 1.2s dolly out 到全景；' +
      '线转面用 6–10 帧从锚点扩张填充。',
    textureZh:
      '纸底只留极轻的 2–3% 颗粒（feTurbulence 固定 seed、opacity 0.02），不加扫描线；' +
      '线条端点 round cap；笔尖端可带 1px 亮点但禁用外发光；线宽与透明度全片恒定。',
    structureZh: [
      '0–0.10：钩子 —— 一个亮点落下，第一笔从画面中心开始生长（不许白纸开场）',
      '0.10–0.35：种子 → 树苗 → 枝干长成建筑结构线',
      '0.35–0.60：建筑轮廓延伸成天际线，相机轻推到笔尖',
      '0.60–0.82：线转面，logo 从锚点被金色填满',
      '0.82–1.00：拉远成海报，细字距 wordmark 浮起并定格',
    ],
    gridZh: '中心对称构图，主体占画面 55–65%，四周 15% 留白；水平线只用于地平线与基线。',
    avoidZh: [
      '多彩色 / 粗描边 / 大面积填充',
      '线宽随速度变化',
      '匀速无加减速、无转角减速',
      '毛玻璃 / 霓虹 / 粒子背景',
      '照片或写实纹理',
      '花体字与超过两行的文案',
    ],
  }),

  defineStyle({
    id: 'isometric',
    code: '03-isometric',
    zh: '等轴 2.5D',
    en: 'Isometric 2.5D',
    energy: 'medium',
    family: 'spatial',
    keywords: ['等轴', '等距', '2.5D', 'isometric', '城市', 'city', '微缩', '建筑', '平行滑轨'],
    paletteRoles: [
      ['#EDE7FF', '淡紫：地面/岛体底色'],
      ['#B8F2E6', '薄荷：草地与建筑'],
      ['#FFD8C2', '蜜桃：屋顶与暖色块'],
      ['#BFD9FF', '天空蓝：远景与玻璃面'],
      ['#FFFFFF', '白：高光与云'],
      ['#3A3550', '墨色：文字、接触影、暗面'],
    ],
    lookZh:
      '30° 等轴投影的微缩城市 / 数据园区，无透视灭点，处处等比；粉彩工作室配色 + 平涂软阴影；' +
      '信息密度高但不乱，科技公司的架构图动画与 App 功能演示的标配。',
    signatureZh: [
      '严格 30° 等轴（2:1 斜率），全片没有透视灭点',
      '物体沿等轴网格运动，落点吸附网格顶点、整像素对齐',
      '建筑生长：底面先落 → 立面 scaleY 从 0 拉起 → 顶面延迟 2–3 帧盖上',
      '运镜只做整组平移、绝不旋转相机；前中后景按 1:0.8:0.6 视差',
      '软阴影 = 每个物体一个平涂深色菱形 + 椭圆接触影，方向统一',
    ],
    typeZh:
      '粗圆几何无衬线（"Arial Rounded MT Bold", "Microsoft YaHei", sans-serif）标题 72–96px / 800；' +
      '等轴标题卡把文字 skew(30°,-30°) 贴进等轴平面；数据标签 26–30px、字距 0.02em；' +
      '英文全大写，中文不超过 700 字重，避免衬线。',
    motionZh:
      '一句话：波浪落位 + 生长回弹 + 整组平移。地面砖按与中心的距离每砖延迟 1.5 帧落位' +
      '（cubic-bezier(0.34,1.56,0.64,1)）；立面 scaleY 0→1 用 12 帧、过冲 6%，顶面再延迟 2–3 帧；' +
      '相机平移 easeInOutCubic、整组 1:0.8:0.6 视差；片尾 1.5s 拉远 20%。',
    textureZh:
      '禁写实材质与渐变；三个面只用三档明度（顶 100% / 左 78% / 右 62%）；' +
      '阴影平涂 #3A3550、透明度 12%；可叠 2% 静态纸感颗粒统一画面（固定 seed）。',
    structureZh: [
      '0–0.15：钩子 —— 地面砖从中心波浪式翻起落下',
      '0.15–0.45：建筑按网格生长，树弹出、窗户逐栋点亮',
      '0.45–0.70：生活感 —— 小汽车沿路循环、无人机携包裹、数据流在城市间脉冲',
      '0.70–0.85：整组平行滑轨，前中后景视差',
      '0.85–1.00：拉远露出漂浮岛，等轴平面上的标题卡落定并微动',
    ],
    gridZh: '等轴网格 64×32px 一个单位；所有落点吸附单位网格；建筑高度取整数单位。',
    avoidZh: [
      '透视灭点 / 真实 3D 透视',
      '相机旋转或自由环绕',
      '阴影方向不一致',
      '材质渐变、金属反光',
      '穿模与图层前后错乱',
      '写实人物或照片贴图',
    ],
  }),

  defineStyle({
    id: 'cel-boil',
    code: '05-cel-boil',
    zh: '逐帧手绘 · 线条沸腾',
    en: 'Cel Animation / Frame-by-Frame & Line Boil',
    energy: 'medium',
    family: 'handmade',
    keywords: ['逐帧', '手绘', '线条沸腾', 'boil', 'cel', 'smear', '一拍二', '动画纸'],
    paletteRoles: [
      ['#F6E8CC', '暖纸底'],
      ['#1B1A17', '焦墨线稿'],
      ['#E8452C', '番茄红：主形与情绪'],
      ['#F2B705', '阳光黄：高光与火花'],
      ['#6B4A2F', '赭石：阴影与纸纤维'],
    ],
    lookZh:
      '暖纸底 + 焦墨勾线，线条每隔几帧轻微抖动，像画面在呼吸；填色比线稿错位 1–2px，' +
      '像手工套色；主体以「一拍二」为主，快动作切「一拍一」，静止镜头「一拍三」；' +
      'cel 特效（烟、火星、速度线）点缀在干净主体上。',
    signatureZh: [
      '线稿每 2 帧换一次微差（3–4 张循环），抖动幅度 1–2px',
      '主体 24fps 一拍二（等效 12fps），只有快动作才一拍一',
      '填色比线稿错位 1–2px，模拟手工套色不准',
      'cel FX（烟、火星、速度线）叠在干净主体上，不整体做旧',
      '纸纹 multiply 10–15%，全片有纤维感',
    ],
    typeZh:
      '手写感标题优先 "Microsoft YaHei" 900，再手动加 1.5° 旋转与 1–2px 错位；字号 130–170px；' +
      '字幕 34–40px 手写体感觉；笔画端点圆头、允许断开；禁用细体与规整衬线。',
    motionZh:
      '一句话：一拍二抖动 + smear 拖影 + 可控的 cel 节奏。所有位置先按 12fps 量化（每 2 帧才更新），' +
      '快动作瞬间插 1 帧 150–300% 拉伸的 smear；入场 3 帧预备 + 6 帧冲入；静止镜头降一拍三；' +
      'line boil 用固定 seed 的 4 套线稿微差循环，禁止逐帧随机。',
    textureZh:
      '纸纹用 feTurbulence（baseFrequency 0.008、numOctaves 3、固定 seed）multiply 12%；' +
      '纹理每帧相同、不许闪烁；可加 1–2 条 0.2 透明度的纸纤维线；焦墨用 #1B1A17 而非纯黑。',
    structureZh: [
      '0–0.12：钩子 —— 火柴擦燃（1 帧 smear），火焰精灵弹出',
      '0.12–0.35：精灵 anticipation + squash 后跳起舞（一拍二）',
      '0.35–0.60：炸成 cel FX：烟团、火花、星爆、速度线',
      '0.60–0.82：FX 重新聚成手写标题，标题持续 boil',
      '0.82–1.00：标题定格（一拍三），纸纹与套色错位保持呼吸感',
    ],
    gridZh: '手绘构图允许 2–3° 歪斜；安全边距 6%；主体不超过画面 70%，留手写批注空间。',
    avoidZh: [
      '平滑数字缓动与匀速插值',
      '过度抗锯齿的矢量边缘',
      '照片 / 3D / 写实材质',
      '全片同一张线稿不抖（boil 失效）',
      '纯白背景',
      '细体字与规整网格排版',
    ],
  }),

  defineStyle({
    id: 'collage',
    code: '06-collage',
    zh: '拼贴剪报',
    en: 'Collage / Cut-out Animation',
    energy: 'high',
    family: 'handmade',
    keywords: ['拼贴', '剪报', 'collage', 'cutout', '达达', '半调', '报纸', '构成主义'],
    paletteRoles: [
      ['#D8C7A8', '新闻纸底'],
      ['#111111', '墨黑：剪影与字'],
      ['#C8332E', '构成主义红'],
      ['#F4F1EA', '纸白：白描边与撕纸'],
      ['#4A5A6A', '旧蓝灰：远层纸片'],
    ],
    lookZh:
      '新闻纸/牛皮纸底，人物与物件像剪刀剪下来再拼装：粗白描边 2–4px、半调网点、报纸纹理；' +
      '达达式超现实、比例失衡、嘴巴与关节单独开合；12fps 定格式抽帧 + ±2px 手摆抖动；' +
      '构成主义红黑斜排大字收尾。',
    signatureZh: [
      '所有照片/物件剪影带 2–4px 粗糙白描边，像剪刀剪下',
      '半调网点与报纸纹理清晰可见',
      '主体运动降到 12fps，位置带 ±2px 手摆抖动',
      '比例失衡（大头小身），嘴巴与关节单独开合',
      '转场用「把元素拍上来」或整页翻纸',
    ],
    typeZh:
      '粗野构成主义标题：900 字重黑体（"Microsoft YaHei", "SimHei", sans-serif）斜排 -8°~12°，' +
      '字号 110–170px、可全大写断行；副标用打字机等宽（"Consolas", "Courier New", monospace）28–34px；' +
      '正文做白底黑字贴纸块；中英文允许 2–4px 错位。',
    motionZh:
      '一句话：12fps 抽帧 + 手摆抖动 + 拍上纸面。所有位移按 12fps 网格更新（30fps 下取整到每 2.5 帧），' +
      '叠加 ±2px 手持抖动；入场用 4–6 帧「从画外拍上来」+ cubic-bezier(0.2,1.6,0.4,1)；' +
      '嘴巴用 2–3 张替换帧；翻纸转场 8–10 帧、中间停 2 帧。',
    textureZh:
      '半调网点用 recurring radial-gradient（点径 2px、间隔 6px）叠 8–12%；' +
      '纸纹用 feTurbulence 固定 seed multiply 10%；整体 6% 褐色单色噪声；' +
      '可用 2–3 条胶带贴纸做图层装订，禁止平滑现代质感。',
    structureZh: [
      '0–0.12：钩子 —— 一张剪纸肖像被「拍」上画面，头顶像盖子翻开',
      '0.12–0.38：花朵、鸟、行星、手指、复古火箭从缺口里喷出',
      '0.38–0.62：下颌单独开合说话，手把元素逐个拍在纸上（12fps）',
      '0.62–0.82：红黑斜排大字拼贴上来，报纸纹理与半调网加压',
      '0.82–1.00：整页翻纸转场到定格海报，最后 3 帧轻微手摆',
    ],
    gridZh: '无严格网格，允许 3–8° 歪斜与重叠；主体群占画面 80%，四周留出 4% 纸边。',
    avoidZh: [
      '干净渐变、玻璃、霓虹等现代质感',
      '平滑缓动与 30fps 流畅运动',
      '无白描边的照片 / 图标',
      '规整居中对称排版',
      '高保真 3D',
      '全片只有两三种颜色的干净配色',
    ],
  }),

  defineStyle({
    id: 'liquid',
    code: '07-liquid',
    zh: '液态流动',
    en: 'Liquid Motion',
    energy: 'high',
    family: 'organic',
    keywords: ['液态', 'liquid', 'metaball', '流体', '滴落', '融合', '有机'],
    paletteRoles: [
      ['#2A0F3C', '深李紫底'],
      ['#FF6A00', '热橙：液体主体'],
      ['#FF3D8A', '粉：高光过渡'],
      ['#8A4BFF', '紫：暗部与次形'],
      ['#F9E7FF', '浅紫白：高光与文字'],
    ],
    lookZh:
      '深李紫底上的糖果液态：热橙→粉→紫，表面有高光斑与菲涅尔冷光，读作厚液体而不是平面色块；' +
      'metaball 融合、拉丝滴落、波浪边缘转场淹没画面；有机曲线永不直线，气质解压、高能量。',
    signatureZh: [
      '所有轮廓都是有机曲线，禁止直线与尖角',
      'metaball 融合：两球靠近先拉丝再粘连，断裂回弹 2–3 帧',
      '表面有高光斑与边缘冷光，读作厚液体',
      '次级液滴比主体晚 2–3 帧跟随（follow-through）',
      '转场是液体波浪前沿漫过画面，前沿带 3–5 个错相位凸起',
    ],
    typeZh:
      '厚润无衬线标题（"Microsoft YaHei" 900 或 "Arial Black"）96–140px、行高 0.95、字距 -0.03em；' +
      'logo 可用双色错位 + 3px 高光模拟液态金属；辅助文字 28–32px、字距 0.08em；禁用衬线。',
    motionZh:
      '一句话：甩出去 + 融合-拉丝-回弹 + 波浪转场。主形位移前快后慢 cubic-bezier(0.22,1,0.36,1)，禁止匀速；' +
      '融合用两个圆 6–8 帧靠近，Canvas 里靠多层同色圆 + 渐隐模拟；落点 squash 8–12%；' +
      '转场波浪前沿 1600px/s 扫过，凸起相位差 0.12s。',
    textureZh:
      '高光用 Canvas 径向渐变模拟（光源偏左上），边缘加 1–2px 亮边；背景加 3% 噪点防色带；' +
      '高斯模糊不超过 30px；高光必须随形变移动，不能是静态贴图。',
    structureZh: [
      '0–0.10：钩子 —— 一滴液体落下、落地压扁并溅起次级液滴',
      '0.10–0.35：液滴融合成更大的球，拉丝-断裂-回弹',
      '0.35–0.60：一泼液体以波浪前沿漫过画面转场',
      '0.60–0.82：液体聚合成 wordmark，最后滴下一滴',
      '0.82–1.00：logo 定格，表面高光缓慢流动',
    ],
    gridZh: '中心构图，主体占 60–75%；文字浮在液体之上，安全边距 8%。',
    avoidZh: [
      '直线、尖角、硬边几何',
      '匀速 / 线性缓动',
      '哑光平涂无高光',
      '粒子背景与星空',
      '超过 5 种主色',
      '衬线或细体文字',
    ],
  }),

  defineStyle({
    id: 'morph',
    code: '08-morph',
    zh: '形变叙事',
    en: 'Shape Morph / Morphing',
    energy: 'medium',
    family: 'organic',
    keywords: ['形变', 'morph', '变形', '图标', 'apple', 'keynote', '连续'],
    paletteRoles: [
      ['#F7F7F5', '纸白底'],
      ['#111111', '剪影墨色'],
      ['#FF5C49', '珊瑚：第一主色'],
      ['#2E7CF6', '蓝：第二主色'],
      ['#FFD84D', '黄：点睛'],
    ],
    lookZh:
      'Apple keynote 级的一形连续叙事：一个主角形连续变成 6–8 个有意义的形；轮廓过渡无跳变；' +
      '复杂 A→B 先收成中介简形（圆/胶囊）再展开；形变伴随位移旋转与 10–15% 挤压拉伸；' +
      '每次形变落点换一次背景色块（硬切，不做渐变过渡）。',
    signatureZh: [
      '全片只有一条主角路径：一个形连续变成 6–8 个有意义的形',
      '任何 A→B 先收成中介简形再展开，中点截图不许打结',
      '形变全程伴随旋转与 10–15% squash & stretch',
      '每次形变落点换一次背景色块，色块硬切',
      '每段起止各留 3 帧缓冲，中段速度最快',
    ],
    typeZh:
      '极简几何无衬线（"Arial", "Helvetica Neue", "Microsoft YaHei"）标题 88–120px / 700、字距 -0.02em；' +
      '一句 tagline 30–36px / 400；中文标题 64–84px / 600；品牌 wordmark 可用几何圆点做 i 的细节。',
    motionZh:
      '一句话：一形多段 + 中介形桥接 + 中段最快。每段形变 8–12 帧，速度曲线 cubic-bezier(0.7,0,0.3,1)' +
      '（中段最快、起止各 3 帧缓冲）；相邻形之间背景硬切；每段结束停 2–4 帧再开始下一段；' +
      'squash 峰值出现在中点。',
    textureZh:
      '保持干净：最多 1.5% 噪点防色带；形用纯色填充、边缘正常抗锯齿；' +
      '禁投影、描边、玻璃；背景色块之间硬切，不加过渡。',
    structureZh: [
      '0–0.10：钩子 —— 一个圆弹入画面并停住',
      '0.10–0.40：圆 → 咖啡杯 → 太阳 → 海鸥，每段先收圆再展开',
      '0.40–0.65：纸飞机 → 定位钉 → 心形，背景色块逐段硬切',
      '0.65–0.85：心形收圆后展开成品牌 logo + wordmark',
      '0.85–1.00：logo 定格 1s，只有一个 2px 级微动',
    ],
    gridZh: '中心单点构图，主角形始终在画面中心 ±8%；文字放下三分之一；安全边距 10%。',
    avoidZh: [
      '形变中点打结 / 自交',
      '直接 A→B 没有中介形',
      '多个元素同时形变',
      '渐变 / 阴影 / 发光',
      '形变时只变形状不变量级',
      '复杂写实图标',
    ],
  }),

  defineStyle({
    id: 'bauhaus',
    code: '09-bauhaus',
    zh: '几何构成 · 包豪斯',
    en: 'Geometric Bauhaus Motion',
    energy: 'high',
    family: 'graphic',
    keywords: ['包豪斯', 'bauhaus', '几何', '构成', '网格', '瑞士', '动态海报'],
    paletteRoles: [
      ['#F1E9DA', '奶油纸底'],
      ['#E03C31', '包豪斯红'],
      ['#F2B705', '包豪斯黄'],
      ['#1E4FA3', '包豪斯蓝'],
      ['#111111', '黑：文字与线'],
    ],
    lookZh:
      '圆、三角、矩形在严格模块网格上做精确平移/旋转/缩放，红黄蓝黑 + 奶油纸限定色板；' +
      '机械理性的秩序美，节拍驱动、一拍一个动作；最后冻结成一张完美动态海报，' +
      '瑞士国际主义排版收束（粗几何无衬线全大写）。',
    signatureZh: [
      '色板只有红黄蓝黑 + 奶油纸，总数 ≤5',
      '所有落点都在网格线上，位移是模数的整数倍',
      '旋转轴只在自身中心 / 边缘顶点 / 画面中心三者间切换',
      '一拍一个动作（120BPM = 0.5s/拍），动作瞬时完成',
      '全片禁用 overshoot 与弹性，机械感是特征不是缺陷',
    ],
    typeZh:
      '极简几何无衬线（"Arial", "Helvetica Neue", "Microsoft YaHei"）：标题竖排 120–180px / 900、字距 0.02em；' +
      '小字全大写 22–26px、字距 0.18em；数字用等宽 "Consolas"；中文用黑体、不倾斜不加粗过 700。',
    motionZh:
      '一句话：网格模数运动 + 一拍一动 + 禁用回弹。节拍 120BPM（0.5s/拍），每个节拍点元素瞬时到位；' +
      '缓动只用 linear 或 cubic-bezier(0.45,0,0.55,1)；位移距离 = 240px 网格整数倍；' +
      '旋转 90°/180° 用 8–10 帧；6–8s 做一次相位差级联波。',
    textureZh:
      '轻微印刷质感：纸纹 feTurbulence 固定 seed、opacity 3–4%；允许 0.5px 套印错位（红色偏移 1px）；' +
      '禁发光、渐变、圆角大于 0；黑用 #111111 不用纯黑。',
    structureZh: [
      '0–0.15：钩子 —— 网格线先画出，第一颗红圆落在网格交点',
      '0.15–0.40：第二拍起几何形逐个动作（旋转 90° / 平移一格 / 翻转）',
      '0.40–0.65：构成一张康定斯基式海报，元素持续占据网格',
      '0.65–0.85：相位差级联波横扫网格',
      '0.85–1.00：冻结成海报，竖排 "BAUHAUS" + 小字 "FORM · FARBE · FUNKTION"',
    ],
    gridZh: '240px 主模数、60px 次模数；12×5 网格；安全边距 120px；所有几何轴对齐网格。',
    avoidZh: [
      'overshoot / 回弹 / 弹性缓动',
      '非网格落点与任意角度旋转',
      '渐变、阴影、发光、玻璃',
      '超过 5 色的配色',
      '随机漂移与手绘抖动',
      '圆角与有机曲线',
    ],
  }),

  defineStyle({
    id: 'synthwave',
    code: '10-synthwave',
    zh: '复古合成波 · VHS',
    en: '80s Synthwave / VHS',
    energy: 'medium',
    family: 'retro',
    keywords: ['合成波', 'synthwave', 'vhs', '80s', '霓虹', '网格', '镀铬', 'retro'],
    paletteRoles: [
      ['#0B0217', '夜空底'],
      ['#2B0A4E', '深紫：远山与暗部'],
      ['#FF2E97', '霓虹品红：主光'],
      ['#00E5FF', '霓虹青：网格与描边'],
      ['#FFB44D', '日落橙金：太阳与镀铬高光'],
    ],
    lookZh:
      '80s synthwave 三件套：透视霓虹网格、条纹日落、镀铬字；再叠 VHS 做旧（扫描线、RGB 色偏、磁带噪声）；' +
      '棕榈与线框山影做前景负形；对特定年代媒介的整体引用，越"脏"越对。',
    signatureZh: [
      '一点透视霓虹网格向镜头滚动，地平线固定',
      '条纹日落球：品红→橙→黄水平切片，越靠下切片越宽',
      '镀铬字用 5 段以上金属渐变 + bevel 高光 + 星芒扫过',
      '全片叠 VHS：RGB 各偏 1–2px、2px 扫描线、每秒 1–2 次 glitch',
      '双层辉光：内层 4px 紧光 + 外层 30px 散光',
    ],
    typeZh:
      '镀铬标题用 "Arial Black" / "Impact" 全大写 140–200px、字距 0.02em + 金属渐变填充；' +
      '霓虹手写体 120–160px（"Brush Script MT" 兜底）；数据小字用 "Consolas" 24–28px；' +
      '中文字幕用 "Microsoft YaHei" 700、不加大面积辉光以免糊字。',
    motionZh:
      '一句话：低机位穿越网格 + 标题砸入 + 霓虹管书写。网格滚动 240–360px/s 恒定（机械感）；' +
      '相机 3 帧加速后稳定；标题 6 帧从 1.6 倍砸到 1 倍 + 4 帧轻抖；霓虹"书写"逐段点亮（每段 2 帧）+ 2 次闪烁；' +
      '关键段故意抽帧到 15fps。',
    textureZh:
      'VHS 链：扫描线用 repeating-linear-gradient（2px 间隔、10% 黑）；RGB 色偏用三层画面偏移 1–2px；' +
      'glitch 用固定 seed 的 8–12 条横向切片、每 0.5s 一次持续 2 帧；叠 4% 磁带噪点；禁干净现代质感。',
    structureZh: [
      '0–0.10：钩子 —— VHS 跟踪噪声 + PLAY 图标，网格开始滚动',
      '0.10–0.40：低机位穿越网格，条纹太阳升起，线框山与棕榈掠过',
      '0.40–0.60：镀铬主标题砸入 + 星芒扫过 + 镜头光晕',
      '0.60–0.78：粉色霓虹手写体像霓虹管一样逐段书写并闪烁',
      '0.78–1.00：持续骑行镜头 + VHS 做旧，停在英雄帧',
    ],
    gridZh: '一点透视，灭点在 (960, 520)；网格间距按透视等比；标题在画面中央偏上；安全边距 6%。',
    avoidZh: [
      '干净无质感的扁平矢量',
      '没有辉光与扫描线的现代 UI',
      '色偏过强导致文字发糊',
      '写实 3D 城市或照片',
      '超过 3 种霓虹主色',
      '圆角柔和的可爱风格',
    ],
  }),

  defineStyle({
    id: 'aurora-glass',
    code: '12-aurora-glass',
    zh: '极光玻璃拟态',
    en: 'Aurora & Glassmorphism',
    energy: 'low',
    family: 'soft-glow',
    keywords: ['极光', 'aurora', '玻璃', 'glass', 'glassmorphism', '弥散', '科技', '高级'],
    paletteRoles: [
      ['#070B1A', '深靛黑底'],
      ['#6C5CE7', '极光紫：主光斑'],
      ['#33C3F0', '极光青：次光斑'],
      ['#FF6BD6', '极光粉：点缀光斑'],
      ['#C9FFF4', '薄荷白：高光与文字'],
    ],
    lookZh:
      '深靛黑底 + 4–5 团邻近色极光缓慢漂移成 mesh gradient；磨砂玻璃卡片浮在上层' +
      '（backdrop blur 30px、白色 6% 填充、1px 白 30% 内高光、大圆角）；' +
      '一枚液体玻璃透镜扫过画面制造 wow；气质是「慢、透、贵」，快动作会立刻破坏它。',
    signatureZh: [
      '底层 4–5 个大色斑 blur 80–150px 沿贝塞尔路径漂移，融合成 mesh gradient',
      '玻璃卡片：blur 30px + 白 6% 填充 + 1px 白 30% 描边 + 32px 圆角',
      '邻近色 2–3 色（紫蓝青或橙粉红），禁止撞色',
      '全片只有慢动作：sine 呼吸缓动、单段 2–4s 起',
      '叠 3–5% 噪点防色带，透镜边缘有 1–2px 色散',
    ],
    typeZh:
      '轻量优雅无衬线（"Microsoft YaHei Light", "PingFang SC", "Helvetica Neue", sans-serif）' +
      '标题 64–84px / 300、字距 0.04em；副标 28–32px / 400；英文全大写、字距 0.2em；' +
      '禁粗黑与装饰字体。',
    motionZh:
      '一句话：慢呼吸 + 视差 + 透镜扫过。所有位移 2–4s 完成，缓动接近 sine（cubic-bezier(0.37,0,0.63,1)）；' +
      '文字入场只用 opacity + 8px 上移 / 400ms；卡片按深度 0.6/0.8/1 视差；' +
      '透镜 6–8s 横穿画面（中段略快），高光随位置移动；禁止快切与弹跳。',
    textureZh:
      '全局叠 3–5% 单色噪点（feTurbulence 固定 seed、opacity 0.04、mix-blend-mode:overlay）防色带；' +
      '玻璃高光用 1px 内描边 + 左上径向高光；透镜色散用 3 层错位 2px 的彩色描边；' +
      '背景色斑用多层径向渐变叠出，不用真实图片。',
    structureZh: [
      '0–0.15：钩子 —— 深底上第一团极光缓慢亮起',
      '0.15–0.40：四团光斑漂移成 mesh gradient，第一张玻璃卡片浮入',
      '0.40–0.65：2–3 张卡片按深度视差浮入，卡内微 UI 呼吸',
      '0.65–0.85：液体玻璃透镜横穿画面，放大极光与卡片（wow 时刻）',
      '0.85–1.00：产品标题淡入，整体呼吸定格',
    ],
    gridZh: '12 列网格，卡片宽 1/3–1/2 屏；安全边距 8%；所有元素圆角 ≥24px、无直角硬边。',
    avoidZh: [
      '快动作、硬切、弹跳与回弹',
      '高饱和撞色',
      '纯黑底无光斑',
      '扁平不透明色块',
      '粒子汤 / 星空 / 镜头光晕滥用',
      '粗黑体与密集排版',
    ],
  }),

  defineStyle({
    id: 'hanazi',
    code: '18-hanazi',
    zh: '综艺花字',
    en: 'Variety Show Kinetic Captions (Hanazi)',
    energy: 'high',
    family: 'variety',
    keywords: ['综艺', '花字', 'hanazi', '字幕', '弹跳', '描边', 'vlog', '萌宠'],
    paletteRoles: [
      ['#FF4FA3', '综艺粉：主情绪色'],
      ['#FFD400', '综艺黄：高光与强调'],
      ['#00D4FF', '综艺青：辅助撞色'],
      ['#FFFFFF', '白描边：所有花字必备'],
      ['#5A2A00', '深棕：硬投影'],
    ],
    lookZh:
      '综艺后期的情绪化装饰字幕：多层描边圆胖字、高饱和撞色、白边硬投影；' +
      '弹性 pop 入场、逐字错峰弹跳、到位后轻微 wiggle；' +
      '手绘装饰符号（爆炸框、汗滴、闪光、速度线）随情绪出现，永远比语音/笑点晚 2–3 帧。',
    signatureZh: [
      '字体三层：填充色 + 8–12px 粗白描边 + 彩色外描边/硬投影',
      '入场 scale 0→1.15→1.0 约 8 帧，逐字错峰 2 帧',
      '花字比触发点晚 2–3 帧出现，情绪过了就及时消失',
      '装饰符号手绘感：爆炸框、汗滴、闪光、速度线',
      '高饱和粉黄青 + 白描边，永远与背景强对比',
    ],
    typeZh:
      '圆胖黑体（"Microsoft YaHei" 900 / "SimHei"）：主花字 140–200px，用多层 text-shadow 模拟描边；' +
      '逐字排版、字距 0.02em；旁白小字 40–48px；每个字允许 -3°~3° 的固定种子旋转与 2–4px 错位；' +
      '英文兜底 "Arial Rounded MT Bold"。',
    motionZh:
      '一句话：pop 回弹 + 逐字抖 + 到位后呼吸。入场 8 帧 scale 0→1.15→1.0（cubic-bezier(0.34,1.56,0.64,1)），' +
      '逐字错峰 2 帧、每字额外 -4°→0° 旋转；驻留期 2–3px wiggle（周期 0.4s）；' +
      '退场 5 帧 scale→0.9 + 透明度归零；动作对齐音效而非语音起点。',
    textureZh:
      '无纸纹；可加 6% 细噪点防止大面积纯色生硬；投影用 4–6px 硬偏移深棕、不加模糊；' +
      '装饰符号用纯色 + 2px 白描边；全片保持高饱和与高对比。',
    structureZh: [
      '0–0.12：钩子 —— 主标题花字 pop 进画，逐字弹跳 + 白描边',
      '0.12–0.40：三个情绪花字（问号/震惊/小声）按音效点依次弹出',
      '0.40–0.65：爆炸框 + 速度线 + 汗滴 + 闪光符号配合高光时刻',
      '0.65–0.85：最后一句花字带胶带贴纸式出现，轻微抖动',
      '0.85–1.00：所有花字退场，只留一句定格 slogan 呼吸',
    ],
    gridZh: '花字围绕画面主体：上 1/3 或下 1/3，避免挡脸；安全边距 8%；元素间至少留 24px。',
    avoidZh: [
      '细体字 / 低饱和配色',
      '没有描边的扁平文字',
      '匀速入场、无回弹',
      '花字与语音/音效同帧出现',
      '文字铺满画面没有主次',
      '使用商业综艺原版字体文件',
    ],
  }),

  defineStyle({
    id: 'paperclip',
    code: '19-paperclip',
    zh: '贴纸科普',
    en: 'Bold-outline Sticker Explainer MG',
    energy: 'medium',
    family: 'explainer',
    keywords: ['贴纸', '科普', 'paperclip', '回形针', '知识', '信息图', '白描边', '图表'],
    paletteRoles: [
      ['#E9EEF2', '冷静蓝灰底'],
      ['#5B6B7A', '石板灰：辅助信息'],
      ['#FF5A36', '强调橙：唯一强调色'],
      ['#1C2733', '深墨：文字与图表'],
      ['#FFFFFF', '贴纸白边'],
    ],
    lookZh:
      '回形针式知识视频的标准包装：实拍素材被抠图+粗白描边变成贴纸，与扁平图标、精确图表一起铺在一张超大画布上；' +
      '镜头用长缓动平移缩放把信息点串成一条线；蓝灰/米白冷静底 + 一个强调色，气质像印出来的科普杂志。',
    signatureZh: [
      '所有素材统一成「贴纸」：白描边 8–12px + 2–4px 软投影',
      '蓝灰/米白底 + 2–3 色 + 单一强调色 #FF5A36',
      '图表严格按比例：柱高对应数值、数字滚动到真实值',
      '一条连续相机路径：平移/缩放缓动 0.8–1.5s，不跳切',
      '信息密度高：每 0.8–1.2s 引入一个新视觉元素',
    ],
    typeZh:
      '等线无衬线（"Microsoft YaHei", "PingFang SC", sans-serif）：标题 72–96px / 800、字距 0；' +
      '说明文字 30–36px / 400、行高 1.3；图表数字用 "Consolas" 等宽 40–56px；' +
      '中英文混排时英文用 "Arial" 保持等线；不用衬线、不用手写体。',
    motionZh:
      '一句话：相机长缓动串联信息 + 图表生长 + 数字滚动。相机 0.8–1.5s cubic-bezier(0.65,0,0.35,1) 平移/缩放，' +
      '信息点之间不硬切；柱状图 12–18 帧从 0 长出、过冲 2%；数字滚动 0.6–0.8s 到真实值；' +
      '贴纸入场 6 帧从 1.06 缩到 1 + 8px 位移。',
    textureZh:
      '贴纸投影用 0 4px 12px rgba(28,39,51,.14)；背景可加 2% 点阵；不叠重噪点；' +
      '图表线宽 2px、直角；整体保持印刷品干净，不加纸纹与做旧。',
    structureZh: [
      '0–0.12：钩子 —— 一张贴着白边的照片贴纸被「放」到画布上',
      '0.12–0.38：镜头平移到爆炸图贴纸 + 引线标签',
      '0.38–0.62：图表区：柱状图生长 + 数字滚动到真实值',
      '0.62–0.82：路径图/流程图逐段描边生长',
      '0.82–1.00：拉远成粗体大字标题卡（大数字 + 小注释），镜头停住',
    ],
    gridZh: '超大画布（如 6000×3000）布局，12 列网格、80px 边距；每屏至多 3 个信息层级；安全边距 6%。',
    avoidZh: [
      '花哨渐变 / 发光 / 玻璃',
      '色彩超过 3 色 + 强调色',
      '图表比例失真或数字与图形不符',
      '贴纸没有统一白描边',
      '快闪与强节奏剪辑',
      '手绘歪斜与有机曲线',
    ],
  }),

  defineStyle({
    id: 'pixel',
    code: '20-pixel',
    zh: '像素 8-bit',
    en: 'Pixel Art / 8-bit',
    energy: 'medium',
    family: 'retro',
    keywords: ['像素', 'pixel', '8bit', '游戏', 'retro', 'crt', 'sprite', '复古游戏'],
    paletteRoles: [
      ['#0F0F1B', '夜空深底'],
      ['#2CE8F5', '青：天空与 UI'],
      ['#FF004D', '红：主角与强调'],
      ['#FFEC27', '黄：金币与高光'],
      ['#00E436', '绿：草地与生命'],
      ['#1A1C2C', '深紫：轮廓与暗部'],
    ],
    lookZh:
      '内部 320×180 低分辨率、最近邻 ×6 放大；有限色板（16–32 色）、2×2 Bayer 抖动渐变；' +
      '三层整像素视差卷轴；精灵动画 8–12fps 阶梯更新；可选 CRT 扫描线与轻微桶形畸变，' +
      '但绝不把像素糊成插画。',
    signatureZh: [
      '内部 320×180，最近邻整数倍放大，绝不抗锯齿',
      '有限色板 ≤32 色，渐变用 2×2 Bayer 抖动而不是平滑渐变',
      '精灵动画 8–12fps 阶梯更新，位置吸附整数像素',
      '三层视差（天空/远山/近地）以不同整数速度滚动',
      'CRT 扫描线 + 轻微桶形畸变，但不糊掉像素',
    ],
    typeZh:
      '像素字用 Canvas 逐像素绘制（5×7 拉丁点阵、12×12 中文点阵），或 "Consolas" 全大写 24–32px + ' +
      'image-rendering: pixelated；标题字符宽 32–48px；对话每行 ≤20 字符；严禁系统矢量字体直接放大。',
    motionZh:
      '一句话：阶梯更新 + 整像素位移 + 卷轴视差。所有位置先取整再绘制；动画按 8–12fps 量化（每 2–3 帧才更新），' +
      '不使用平滑缓动；跳跃用 2 帧预备 + 4 帧上升 + 4 帧下落；视差层速度 1×/0.5×/0.25× 整像素；' +
      '金币闪烁用 6fps 三帧循环。',
    textureZh:
      'CRT 扫描线每 2px 一条 12% 黑线；可选 1% 磷光泛光（低分辨率叠加后再放大，保持像素硬边）；' +
      '所有绘制色先吸附到色板最近色，禁止色板外颜色；无高清纹理与照片。',
    structureZh: [
      '0–0.12：钩子 —— 像素标题 8fps 逐帧砸入，CRT 开机闪一下',
      '0.12–0.40：英雄精灵从左侧跑入，三层视差背景滚动，跳起吃金币',
      '0.40–0.62：踩中史莱姆 + 金币计数跳动，日落到夜晚调色切换',
      '0.62–0.82：宝箱开启，光柱爆开，像素 logo 从光里升起',
      '0.82–1.00：logo 定格，扫描线与磷光轻微呼吸',
    ],
    gridZh: '内部分辨率 320×180，精灵尺寸 16/24/32px 整数；瓦片 16×16；安全区 32px 边框。',
    avoidZh: [
      '任意倍率 / 非整数缩放与抗锯齿',
      '平滑渐变与大量颜色',
      '平滑缓动与 30fps 全帧动画',
      '高清写实纹理 / 照片',
      '3D 体积光与真实阴影',
      '系统字体直接放大当像素字',
    ],
  }),

  defineStyle({
    id: 'hud',
    code: '22-hud',
    zh: '赛博 HUD',
    en: 'Cyberpunk HUD / FUI (Fictional UI)',
    energy: 'high',
    family: 'tech',
    keywords: ['HUD', 'FUI', '赛博', 'cyberpunk', '界面', '锁定', '雷达', '科幻'],
    paletteRoles: [
      ['#020B0D', '深青黑底'],
      ['#00E5FF', '青色：线框主色'],
      ['#FF6A00', '橙色：警报态'],
      ['#9BFF3D', '绿色：数据与通过态'],
      ['#E8FFFF', '高亮白：即时读数'],
    ],
    lookZh:
      '模拟科幻电影/游戏抬头显示：青色霓虹线框 + 橙色警报两态；六边形网格、同心旋转刻度环、' +
      '雷达扫描、数据小字滚动、打字机状态行，中心是线框全息体；' +
      '锁定瞬间四角括号 snap 1.4→1.0，随后全屏切警报橙；密度高但有层级，克制不糊。',
    signatureZh: [
      '青色线框 + 橙色警报两态，颜色切换本身就是叙事',
      '元素按层级错帧生长：外环 → 刻度 → 数据 → 锁定框',
      '雷达扫描是 conic 扇区旋转 + 目标点闪烁',
      '数字先乱跳 3–5 帧再落定真实值；文字打字机 + 光标',
      '全片叠辉光 + 2px 扫描线 + 轻微 RGB 色差，克制不糊',
    ],
    typeZh:
      '等宽为骨（"Consolas", "Courier New", monospace）：数据/坐标 20–24px、字距 0.08em；' +
      '状态标题 32–40px 全大写；中文标签用 "Microsoft YaHei" 22–26px + letter-spacing 0.3em；' +
      '大标题 64–80px 细等线、字距 0.2em；允许 2–3px 字符错位。',
    motionZh:
      '一句话：线框生长 + 数据乱跳落定 + 锁定吸附。线框分段描边逐段出现（每段 2–3 帧、错峰 2 帧、easeOutCubic）；' +
      '数字滚动 3–5 帧乱跳后落定（固定种子哈希，不用 Math.random）；锁定框 8 帧 1.4→1.0' +
      '（cubic-bezier(0.16,1,0.3,1)）后闪 2 次；警报态 4Hz 呼吸脉冲、幅度 6%。',
    textureZh:
      '辉光：同色描边 3 层（1px/4px/16px，透明度 20%/10%/5%）；扫描线 repeating-linear-gradient 2px、12% 黑；' +
      '警报时 RGB 色差 1px；glitch 用固定 seed 的横向切片、每 0.8s 一次持续 2 帧；四周暗角 40%。',
    structureZh: [
      '0–0.15：钩子 —— 深底亮起，第一道青线从中心向外画出',
      '0.15–0.40：同心环与刻度逐层出现，雷达扫描开始，数据列滚动落定',
      '0.40–0.62：中心线框全息体建立，扫描线扫过，目标框出现',
      '0.62–0.82：锁定框 snap 1.4→1.0，全屏切警报橙，坐标打字机落定',
      '0.82–1.00：警报呼吸 + 微 glitch，最后 0.3s 稳定在锁定帧',
    ],
    gridZh: '以画面中心为原点、16×9 安全网格；环形元素同心；文字对齐四角与中心轴；安全边距 6%。',
    avoidZh: [
      '静态不动的界面（必须持续微动）',
      '所有元素同时出现',
      '没有层级、没有错帧的堆叠',
      '超过 3 种主色与糖果色',
      '干净无扫描线/辉光的现代 UI',
      '写实照片与地图数据',
    ],
  }),

  defineStyle({
    id: 'ink-wash',
    code: '23-ink-wash',
    zh: '水墨写意',
    en: 'Chinese Ink Wash / Xieyi',
    energy: 'low',
    family: 'illustration',
    keywords: ['水墨', '写意', 'ink', 'wash', '宣纸', '国风', '毛笔', '留白'],
    paletteRoles: [
      ['#EFE6D0', '宣纸底'],
      ['#100E0C', '焦墨：主体线'],
      ['#C47A3C', '赭石：猫与暖部'],
      ['#6F8AA0', '花青：衣与冷部'],
      ['#C4281E', '朱砂：朱日与钤印'],
    ],
    lookZh:
      '宣纸为底、墨分五色（焦/浓/重/淡/清），墨在纸上晕开；留白是构图主体，白色部分用纸色"挖"出来；' +
      '毛笔笔毛用多条连续折线制造飞白；一切从写出到晕染，最后钤印收尾；首帧不允许是白纸。',
    signatureZh: [
      '墨色分五档（焦浓重淡清），靠透明度与叠加出层次',
      '湿笔晕染：形状外再叠一层 blur 更大、透明度更低的墨',
      '留白用纸色挖出来，而不是画白色',
      '毛笔笔毛用多条连续折线制造飞白，不能分段圆头线拼接',
      '首帧不是白纸：第 0 帧已有 2–3 笔落下',
    ],
    typeZh:
      '书法/宋体标题（"Songti SC", "SimSun", "Noto Serif SC", serif）96–140px / 600、字距 0.08em；' +
      '可竖排；落款 28–34px 宋体；禁用粗黑、描边、发光；中文标点留白大；中英混排时英文用 "Times New Roman" 衬线。',
    motionZh:
      '一句话：写出 + 晕开 + 留白呼吸。笔触按 reveal 进度写出（cubic-bezier(0.65,0,0.35,1)，每笔 0.25–0.45s、' +
      '按物体顺序错峰 0.1–0.2s）；晕染 grow 从 0 到 1 用 1.2s，之后外晕持续变宽；' +
      '竹叶/水波用 sin 摆动（幅度 0.1–0.2、周期 2–3s）；雾带横移 150–270px/s；钤印 8 帧从 1.5 倍压到 1 倍。',
    textureZh:
      '宣纸：feTurbulence 固定 seed（baseFrequency 0.0025、numOctaves 4）+ 2600 根短纤维弧线' +
      '（一半褐 α0.05–0.13、一半亮 α0.12–0.27）+ 边缘径向暗角 α0.22；墨用 multiply 混合；' +
      '干笔飞白靠笔毛折线断开；纹理必须静态、不闪烁。',
    structureZh: [
      '0–0.15：钩子 —— 第 0 帧已有几笔落下，窗框/案几先写出',
      '0.15–0.40：竹枝与叶片写出，雾带横移，远山淡墨晕开',
      '0.40–0.62：猫的赭石晕染 + 焦墨勾线 + 白眼向天',
      '0.62–0.82：少女花青晕染 + 白描衣纹，热气游丝上升',
      '0.82–1.00：钤印压下，画面在留白里呼吸定格',
    ],
    gridZh: '散点构图（非对称），主体偏左下或右下，留白 ≥35%；题字在右上或左上；安全边距 10%。',
    avoidZh: [
      '纯白底 + 纯黑硬边矢量',
      '没有晕染、没有飞白的数字线条',
      '渐变发光 / 霓虹 / 3D',
      '西方漫画描边与高饱和色',
      '满画面构图、没有留白',
      '粗黑体与居中标题',
    ],
  }),
])

export const MG_STYLE_COUNT = MG_STYLES.length

/**
 * 按 id / 完整 code / 数字前缀 / 中文名查一套风格。
 * 例如 'hud'、'22-hud'、'22'、'赛博 HUD' 都返回同一套；找不到返回 undefined。
 */
export function getMgStyle(idOrCode) {
  if (typeof idOrCode !== 'string') return undefined
  const key = idOrCode.trim().toLowerCase()
  if (key.length === 0) return undefined
  for (const style of MG_STYLES) {
    const numeric = style.code.split('-')[0]
    if (
      key === style.id ||
      key === style.code ||
      key === numeric ||
      key === style.zh.toLowerCase() ||
      key === style.en.toLowerCase()
    ) {
      return style
    }
  }
  // 允许输入「01-flat-vector」之外的宽松写法：数字 + 英文名部分匹配。
  const loose = MG_STYLES.find(
    (style) => key === style.code.replace(/^0+/u, '') || key.replace(/^0+/u, '') === style.code,
  )
  return loose
}

/** 内部：把一套风格压成可检索的小写长文本。 */
function haystack(style) {
  return [
    style.id,
    style.code,
    style.zh,
    style.en,
    style.family,
    style.familyZh,
    style.energy,
    style.lookZh,
    style.motionZh,
    style.typeZh,
    style.textureZh,
    style.keywords.join(' '),
    style.signatureZh.join(' '),
    style.avoidZh.join(' '),
  ]
    .join(' ')
    .toLowerCase()
}

/**
 * 模糊检索整片风格。
 *
 * @param {string} query 关键词（中文/英文/风格名/技法名均可；空白返回全部）
 * @param {{family?: string, energy?: 'low'|'medium'|'high', limit?: number}} [opts]
 * @returns {Array<object>} 按相关度降序、同分保持上游 code 顺序
 */
export function findMgStyles(query, opts = {}) {
  const text = typeof query === 'string' ? query.trim().toLowerCase() : ''
  const tokens = text.split(/\s+/u).filter((token) => token.length > 0)
  const family = typeof opts.family === 'string' ? opts.family.trim().toLowerCase() : ''
  const energy = typeof opts.energy === 'string' ? opts.energy.trim().toLowerCase() : ''
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, MG_STYLES.length) : MG_STYLES.length
  const scored = []
  MG_STYLES.forEach((style, index) => {
    if (family.length > 0 && style.family !== family && style.familyZh !== opts.family) return
    if (energy.length > 0 && style.energy !== energy) return
    const hay = haystack(style)
    if (!tokens.every((token) => hay.includes(token))) return
    let score = 0
    if (tokens.length === 0) score = 1
    for (const token of tokens) {
      if (token === style.id || token === style.code) score += 100
      else if (style.code.includes(token) || style.id.includes(token)) score += 50
      else if (style.zh.toLowerCase().includes(token)) score += 40
      else if (style.en.toLowerCase().includes(token)) score += 30
      else if (style.keywords.some((keyword) => keyword.toLowerCase() === token)) score += 25
      else if (style.family === token || style.familyZh === token) score += 20
      else score += 10
    }
    scored.push({ style, score, index })
  })
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  return scored.slice(0, limit).map((entry) => entry.style)
}

/** 把 hex 转成 CSS 字符串清单，mgStylePrompt 里给模型看。 */
function paletteLines(style) {
  return style.paletteRoles.map(([hex, role]) => `- ${hex}：${role}`).join('\n')
}

/**
 * 生成「用这套风格写一个 window.renderAt(t) 页面」的完整指令。
 *
 * @param {string} id 风格 id / code / 数字前缀
 * @param {object} [opts]
 * @param {number} [opts.duration=10] 时长（秒）
 * @param {number} [opts.fps=30] 帧率
 * @param {number} [opts.width=1920] 宽
 * @param {number} [opts.height=1080] 高
 * @param {boolean} [opts.vertical=false] 为 true 时强制 1080×1920（会覆盖 width/height）
 * @param {string} [opts.content] 主题/故事（缺省让模型自拟）
 * @param {string} [opts.brand] 虚构品牌名
 * @param {string} [opts.text] 必须出现的文案
 * @param {string} [opts.language='zh'] 文案语言
 * @param {string} [opts.extra] 追加要求
 * @returns {string}
 */
export function mgStylePrompt(id, opts = {}) {
  const style = getMgStyle(id)
  if (style === undefined) {
    throw new Error(
      `未知的整片 MG 风格 "${String(id)}"；可用风格：${MG_STYLES.map((entry) => `${entry.code}（${entry.zh}）`).join('、')}`,
    )
  }
  const duration = Number.isFinite(opts.duration) && opts.duration > 0 ? Number(opts.duration) : 10
  const fps = Number.isInteger(opts.fps) && opts.fps > 0 ? opts.fps : 30
  let width = Number.isInteger(opts.width) && opts.width > 0 ? opts.width : 1920
  let height = Number.isInteger(opts.height) && opts.height > 0 ? opts.height : 1080
  if (opts.vertical === true) {
    width = 1080
    height = 1920
  }
  const frames = Math.max(1, Math.round(duration * fps))
  const content =
    typeof opts.content === 'string' && opts.content.trim().length > 0
      ? opts.content.trim()
      : `自拟一个 ${duration} 秒主题（产品/概念/故事任选），主题要能用画面讲清楚，不依赖旁白`
  const brand =
    typeof opts.brand === 'string' && opts.brand.trim().length > 0
      ? opts.brand.trim()
      : '自拟一个虚构品牌名（禁止真实商标）'
  const text =
    typeof opts.text === 'string' && opts.text.trim().length > 0
      ? opts.text.trim()
      : '至少一个中文主标题 + 一个副标题/tagline'
  const language = typeof opts.language === 'string' && opts.language.trim().length > 0 ? opts.language.trim() : 'zh'
  const safe = opts.vertical === true ? '竖屏安全区：上下各留 8%，主要信息在中间 84%' : '横屏安全区：四周各留 5%'

  return [
    `# 用「${style.zh}」整片风格写一支 ${duration} 秒 MG 动画`,
    '',
    `风格编号：${style.code} ｜ 家族：${style.familyZh} ｜ 能量：${style.energy} ｜ 一句话运动语汇：${style.motionLineZh}`,
    '',
    `你是整片 MG 的导演、动效设计师与前端工程师。请交付一个可直接渲染的 HTML 文件：纯 HTML + Canvas2D/SVG/CSS，` +
      '单文件内联、零外部依赖（不许外链字体/图片/脚本）、不联网；画面完全由 window.renderAt(t) 决定（t 为秒）。',
    '',
    '## 风格系统（必须逐条落实）',
    style.promptZh,
    '',
    '## 本次内容',
    `- 主题/故事：${content}`,
    `- 品牌名：${brand}`,
    `- 必须出现的文案：${text}`,
    `- 时长 ${duration}s ｜ ${fps}fps（${frames} 帧）｜ 画幅 ${width}×${height} ｜ 语言：${language}`,
    `- ${safe}`,
    '',
    '## 技术契约（必须遵守）',
    '- 页面实现 `window.renderAt = async function (t) { ... }`；带 `?export=1` 打开时不得启动自己的 rAF 循环。',
    '- 确定性：禁 `Math.random()` / `Date.now()` / `performance.now()`；需要随机用 `mulberry32(固定 seed)`，且只在初始化时生成。',
    '- 同一个 t 渲染两次必须像素级一致；每帧只依赖 t，不保留跨帧动画状态。',
    '- 内部按设计分辨率绘制（Canvas 设 width/height），外层用 `transform: scale()` 等比适配视口；不要用 window 尺寸计算动画进度。',
    '- 字体只用系统字体栈（见上面【字体层级】），禁止 @font-face 外链；所有图形由代码绘制。',
    opts.extra !== undefined && String(opts.extra).trim().length > 0 ? `- 额外要求：${String(opts.extra).trim()}` : '',
    '',
    '## 配色速查（只许用这些）',
    paletteLines(style),
    '',
    '## 交付与自检',
    `1. 输出一个 .html 文件（建议文件名 \`${style.id}.html\`），无外部 URL、无 console 报错。`,
    '2. 先写 10 秒结构（钩子/建立/主段/收束/定格）再写代码；先做静帧，再加运动。',
    `3. 自检：t=0、${(duration * 0.25).toFixed(1)}、${(duration * 0.5).toFixed(1)}、${(duration * 0.75).toFixed(1)}、${(duration * 0.98).toFixed(1)} 五帧截图必须明显不同；同一 t 连拍两次 PNG 必须一致；文字不出安全边距；首帧不许黑场。`,
    '4. 交付时用一句话说明：每一条【一眼认出的判据】落在哪个时间段。',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export default {
  MG_STYLES,
  MG_STYLE_COUNT,
  MG_FAMILIES,
  getMgStyle,
  findMgStyles,
  mgStylePrompt,
}
