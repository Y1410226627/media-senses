/**
 * Shot recipe cards for the reproduction workflow.
 *
 * A "shot card" is a small, executable recipe the model can search for and then
 * hand to either `media_build_video` (RenderPlan scenes) or `media_animate`
 * (HTML/CSS/Canvas pages). Cards are deliberately written in Chinese because the
 * model's planning notes and the user-facing reports are Chinese; identifiers,
 * keys and code stay English.
 *
 * Design rules for the data:
 * - `params[].feelZh` is the most valuable field: it explains which *direction*
 *   to turn a knob and what happens at each end ("push a little further and it
 *   becomes a real dolly shot, back it off and it is just breathing"). Never
 *   restate the number here — the `typical` column already carries that.
 * - `seconds` is a realistic on-screen duration range for the move, not the
 *   production time.
 * - `recipe` carries at least one runnable starting point (css / canvas / ffmpeg).
 * - Everything here is original writing based on common motion-design practice.
 *   No text is copied from any upstream card library or prompt repository.
 *
 * Zero dependencies; pure data + pure functions so the Lead can unit test it.
 */

/** The ten categories a card can belong to, in display order. */
export const SHOT_CATEGORIES = Object.freeze([
  {
    id: 'opening-brand',
    nameZh: '开场与品牌',
    oneLineZh: '前 3 秒抓住注意力：logo 出现、品牌色铺满、片头钩子。',
  },
  {
    id: 'camera',
    nameZh: '运镜',
    oneLineZh: '推、拉、摇、移、视差：让静态画面拥有呼吸与方向感。',
  },
  {
    id: 'transitions',
    nameZh: '转场',
    oneLineZh: '硬切与柔性过渡的取舍：让两句话之间不断气。',
  },
  {
    id: 'typography',
    nameZh: '字体动态',
    oneLineZh: '文字怎么进来、怎么换、怎么留住：排版即节奏。',
  },
  {
    id: 'ui-entrance',
    nameZh: 'UI 入场',
    oneLineZh: '卡片、列表、抽屉、网格的进入方式：界面演示的基础动作。',
  },
  {
    id: 'interaction',
    nameZh: '交互演示',
    oneLineZh: '光标、悬停、拖拽、滚动：把「用户会做什么」演出来。',
  },
  {
    id: 'data',
    nameZh: '数据可视化',
    oneLineZh: '数字滚动、条形生长、折线描画：让数据有过程而非只有结果。',
  },
  {
    id: 'light-emphasis',
    nameZh: '光影强调',
    oneLineZh: '光斑、辉光、暗角、闪白：用光把某一处推上前台。',
  },
  {
    id: 'rhythm',
    nameZh: '节奏卡点',
    oneLineZh: '卡点硬切、停顿急推、呼吸缩放：让画面和声音同呼吸。',
  },
  {
    id: 'outro',
    nameZh: '收尾与定版',
    oneLineZh: '行动号召、定版停留、logo 拼合：把注意力换成记忆。',
  },
])

/** Genre duration windows (seconds) used by `durationBudget`. */
export const GENRE_DURATION_RANGES = Object.freeze({
  opener: [15, 40],
  demo: [20, 60],
  kinetic: [10, 30],
  bumper: [3, 10],
  explainer: [30, 120],
})

/** Drawing-rate defaults for hand-made / whiteboard style work (strokes/sec). */
export const DEFAULT_SKETCH_STROKES_PER_SECOND = 3.9
export const DEFAULT_COLOR_STROKES_PER_SECOND = 6

/**
 * The card library. 44 cards across the ten categories; every card is original
 * writing. Search by Chinese or English keyword via `findShots`.
 *
 * @type {ReadonlyArray<object>}
 */
export const SHOT_CARDS = Object.freeze([
  /* --------------------------------------------------------- opening-brand */
  {
    id: 'opening-brand.logo-trace',
    category: 'opening-brand',
    nameZh: 'Logo 描边生长',
    oneLineZh: '先出现线稿轮廓，再一笔一笔「画」出 logo，最后填色落定。',
    useWhenZh: '品牌片头、课程开场、个人频道片头；观众还不认识你、需要 1 秒立住视觉签名时。',
    seconds: [1.5, 4],
    energy: 'medium',
    tags: ['logo', '描边', 'stroke-draw', 'svg', '片头'],
    intentZh: '让 logo 看起来是被「动手做出来」的，而不是贴上去的：先给结构，再给完成，观众会记住过程。',
    motionZh: '线条沿路径匀速或轻微 ease-out 生长，收笔后停顿半拍再填色，最后整体轻微上浮 2%。',
    params: [
      {
        name: '描边时长',
        typical: '0.6–1.2 秒',
        feelZh: '再长会像等待加载、观众开始看进度；再短就只剩闪现，描边的「手工感」消失',
      },
      {
        name: '描边宽度',
        typical: '字号级别的 2–3%',
        feelZh: '再粗会显得卡通、像马克笔草稿；再细在小屏上会直接看不见，缩略图里尤其亏',
      },
      {
        name: '填色延迟',
        typical: '描边完成后 0.1–0.2 秒',
        feelZh: '延迟太短会盖掉描边动作的余韵；延迟太长会让人怀疑画面卡住',
      },
    ],
    soundZh: '描边配极轻的纸笔沙沙或合成器单音，填色落定处给一个短促的「嗒」；不要把描边铺满整段音乐。',
    pitfallsZh: '同时做描边 + 3D 旋转 + 粒子；logo 本身太复杂导致线条生长像乱麻。',
    recipe: {
      css: "path{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:draw .9s ease-out forwards}@keyframes draw{to{stroke-dashoffset:0}}",
      canvas:
        "ctx.setLineDash([len,len]);ctx.lineDashOffset=len*(1-p);ctx.stroke();",
    },
  },
  {
    id: 'opening-brand.color-flood',
    category: 'opening-brand',
    nameZh: '品牌色漫延',
    oneLineZh: '品牌色从一个点或一条边扩散铺满画面，把观众拉进世界观。',
    useWhenZh: '章节之间的硬换场、卖点切换、需要强记品牌色的商业片。',
    seconds: [0.6, 2],
    energy: 'high',
    tags: ['品牌色', '漫延', 'color-flood', 'clip-path', '换场'],
    intentZh: '用一次完整的色彩覆盖把上一段「洗掉」，观众的注意力被颜色本身重置。',
    motionZh: '从一个视觉锚点（logo 中心/产品边缘）为圆心做圆形扩散，或从左下方斜切推进，速度前慢后快。',
    params: [
      {
        name: '扩散起点',
        typical: '上一镜主体的位置',
        feelZh: '起点贴着主体走，衔接像是被主体「带出来」；再往画面外挪就会显得突兀、像插播',
      },
      {
        name: '扩散曲线',
        typical: 'cubic-bezier(.7,0,.2,1)',
        feelZh: '改成线性会像幻灯片推拉；后段再加速会更有冲击，但太快会看不清新画面的第一帧',
      },
      {
        name: '覆盖终点',
        typical: '铺满 + 停留 2 帧',
        feelZh: '多停两帧能让人看清品牌色；一铺满就切走会把颜色浪费掉',
      },
    ],
    soundZh: '低频扫频（50–120 Hz）与扩散同步，末尾用一声短混响收住；避免用上升音效，否则容易变成购物广告。',
    pitfallsZh: '连续三次以上用同一方向漫延，会像模板套用；颜色饱和度过高叠加光效，会糊成一片。',
    recipe: {
      css: '@keyframes flood{from{clip-path:circle(0% at 50% 52%)}to{clip-path:circle(140% at 50% 52%)}}.brand{animation:flood .8s cubic-bezier(.7,0,.2,1) both}',
      ffmpeg: "xfade=transition=circleopen:duration=0.8:offset=2.0",
    },
  },
  {
    id: 'opening-brand.mask-slide',
    category: 'opening-brand',
    nameZh: '遮罩滑出字标',
    oneLineZh: '文字被一条移动的遮罩「推」出来，而不是淡入。',
    useWhenZh: '品牌名/标题第一次出现；想比淡入更利落、又不想用花哨运动时。',
    seconds: [1, 3],
    energy: 'medium',
    tags: ['字标', '遮罩', 'mask-reveal', 'sliding', '标题'],
    intentZh: '让文字像从某个实体里被抽出来，获得方向感与速度感，比透明度渐变更「有重量」。',
    motionZh: '遮罩边缘以 0.25–0.4 秒从左向右扫过，文字同步做 8–18px 的轻微反向位移，扫过后回正。',
    params: [
      {
        name: '遮罩宽度',
        typical: '字的 1.2 倍行高',
        feelZh: '再窄会像逐字扫描、显得碎；再宽就失去「推出来」的边缘感',
      },
      {
        name: '反向位移',
        typical: '0.6em',
        feelZh: '位移越大越有「被拽出」的力度，超过一行字高就会看到空出来的空隙，穿帮',
      },
      {
        name: '扫过速度',
        typical: '0.3 秒',
        feelZh: '再快像频道包装、可作 bumper；再慢适合品牌片，但观众可能提前猜到你只是遮罩',
      },
    ],
    soundZh: '一条短促的纸片滑动声，音高与滑入方向一致；字定住时不要加 ding，留给下一拍。',
    pitfallsZh: '遮罩方向与接下来的画面运动方向相反；文字在遮罩里换行导致边缘穿过字身。',
    recipe: {
      css: '.title{clip-path:inset(0 100% 0 0);animation:maskIn .4s cubic-bezier(.2,.8,.2,1) forwards}@keyframes maskIn{to{clip-path:inset(0 0 0 0)}}',
    },
  },
  {
    id: 'opening-brand.count-in',
    category: 'opening-brand',
    nameZh: '倒数开屏',
    oneLineZh: '3-2-1 或 01/02/03 的进度数字带着节拍出现，把开场变成倒计时。',
    useWhenZh: '发布会、活动回顾、教程分步开场；需要明确「马上开始」的仪式感时。',
    seconds: [2, 5],
    energy: 'high',
    tags: ['倒数', 'countdown', '数字', '仪式感', '开场'],
    intentZh: '倒计时天然制造期待；数字每跳一次，观众的注意力就被刷新一次。',
    motionZh: '数字以 8–12% 的缩放弹出、带轻微下坠回弹，换数瞬间旧数字向上淡出、新数字从下推入。',
    params: [
      {
        name: '每拍时长',
        typical: '0.6–0.8 秒',
        feelZh: '再快会像开奖倒计时的紧张版；再慢就失去倒数的推力，变成普通页码',
      },
      {
        name: '回弹幅度',
        typical: '超出 4–6% 再回正',
        feelZh: '回弹越多越活泼、越像综艺；完全无回弹则冷静偏高冷品牌',
      },
      {
        name: '数字对齐',
        typical: '等宽、居中',
        feelZh: '数字宽度不一会左右抖动，观众会误以为画面在晃；把字体换成等宽数字立刻稳，再调字号也不会跳动',
      },
    ],
    soundZh: '每跳一下配一声节拍器/木鱼/短鼓，最后一拍留给主画面；倒数声不要盖住后面要出现的第一句旁白。',
    pitfallsZh: '数字与真实时长不匹配（喊 3 秒却拖了 6 秒）；每拍都加不同音效导致嘈杂。',
    recipe: {
      css: '.num{animation:tick .7s cubic-bezier(.2,1.6,.4,1) both}@keyframes tick{0%{transform:scale(.9);opacity:0}30%{transform:scale(1.05);opacity:1}100%{transform:scale(1);opacity:1}}',
    },
  },

  /* ---------------------------------------------------------------- camera */
  {
    id: 'camera.push-in',
    category: 'camera',
    nameZh: '缓推建立注视',
    oneLineZh: '镜头以极慢的速度向主体靠近，把观众的注意力往里收。',
    useWhenZh: '标题卡、产品特写、需要「安静地重视」的段落开场；竖屏口播的强调镜也适用。',
    seconds: [2, 8],
    energy: 'medium',
    tags: ['推镜', 'push-in', 'dolly-in', '特写', '缓慢'],
    intentZh: '用最小幅度的运动制造「正在靠近」的生理暗示，让观众身体前倾，而不是看出镜头在动。',
    motionZh: '起始 1.0 倍，结束 1.06–1.12 倍，全程匀速偏 ease-out，主体始终保持在画面中轴。',
    params: [
      {
        name: '推进幅度',
        typical: '1.0 → 1.08',
        feelZh: '再大就会变成明显的推镜、观众开始注意镜头本身；再小只剩呼吸感，像画面在轻轻吸气',
      },
      {
        name: '推进时长',
        typical: '4–6 秒',
        feelZh: '再短会显得急促、像赶时间；再长观众会先注意到「一直没变」，悬念反而消失',
      },
      {
        name: '起步缓动',
        typical: 'ease-out 0.8 秒',
        feelZh: '把缓动改成线性会像机器云台；把尾巴拉得更长会更贵更慢，适合高端品牌片',
      },
    ],
    soundZh: '底噪保持住，只加一条极轻的低频上行（-30 dB 起），音量随画面推进缓慢抬 2 dB；不要加 whoosh，推镜配 whoosh 会显得廉价。',
    pitfallsZh: '同时推镜又叠加粒子、光斑、轻微晃动，运动信息过载；主体不在中轴时推镜会像「偷看」。',
    recipe: {
      css: '@keyframes pushIn{from{transform:scale(1)}to{transform:scale(1.08)}}.stage{animation:pushIn 5s cubic-bezier(.16,.84,.3,1) both}',
      ffmpeg:
        "zoompan=z='min(zoom+0.0004,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=150:s=1080x1920:fps=30",
    },
  },
  {
    id: 'camera.pull-out',
    category: 'camera',
    nameZh: '拉远揭示环境',
    oneLineZh: '从局部特写缓慢后退，让观众看见主体所处的完整环境。',
    useWhenZh: '段落收尾、悬念揭晓、「其实它在一片更大的东西里」的叙事反转。',
    seconds: [2, 6],
    energy: 'low',
    tags: ['拉镜', 'pull-out', 'dolly-out', '揭示', '收尾'],
    intentZh: '先给信息碎片再给全貌，观众的「原来如此」比一开始就全景更强烈。',
    motionZh: '起始 1.15 倍，结束 1.0 倍，前 60% 慢、最后略微减速停稳；主体随景别变化逐渐变小。',
    params: [
      {
        name: '起始倍率',
        typical: '1.12–1.18',
        feelZh: '再大开头会太像微距、观众认不出是什么；再小揭示感不足，像普通缩放',
      },
      {
        name: '结束停留',
        typical: '停稳后留 0.8 秒',
        feelZh: '停留越短越干脆，适合快节奏；停留越长越抒情，适合纪录片口吻',
      },
      {
        name: '焦点位置',
        typical: '画面下三分之一',
        feelZh: '焦点放偏高会显得在仰拍；放低一点更接近「弯腰看」的亲密感',
      },
    ],
    soundZh: '环境声随景别拉开逐渐变大（从近景干声到全景混响），让耳朵也「后退」。',
    pitfallsZh: '拉远后画面出现空白区域、边缘露出素材外框；同时叠加旋转会让观众晕。',
    recipe: {
      css: '@keyframes pullOut{from{transform:scale(1.15)}to{transform:scale(1)}}.stage{animation:pullOut 4s cubic-bezier(.3,0,.2,1) both}',
      ffmpeg:
        "zoompan=z='if(lte(on,1),1.15,max(zoom-0.0004,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=120:s=1080x1920:fps=30",
    },
  },
  {
    id: 'camera.pan-track',
    category: 'camera',
    nameZh: '横移跟拍',
    oneLineZh: '镜头水平匀速移动，像沿着一条线浏览场景或对比两样东西。',
    useWhenZh: '对比左右两个版本、展示长条形界面/时间线、列举多项内容。',
    seconds: [2, 8],
    energy: 'medium',
    tags: ['横移', 'pan', 'track', '对比', '水平'],
    intentZh: '用同一方向的速度把多个信息点串成一条叙事线，比逐个淡入更有连续性。',
    motionZh: '从左到右（或反向）匀速平移 8–20% 画幅，起点与终点各留半拍静止，避免撞边。',
    params: [
      {
        name: '平移距离',
        typical: '画幅的 12–18%',
        feelZh: '再远就变成两个镜头的事、观众会期待切镜；再近只是微动，容易被误认为手抖',
      },
      {
        name: '平移速度',
        typical: '0.06 画幅/秒',
        feelZh: '越快越像扫视、适合清单；越慢越像凝视、适合对比细节',
      },
      {
        name: '方向一致性',
        typical: '同一镜头内不换向',
        feelZh: '中途反向会立刻让人晕；把方向调回来时宁可硬切，别在半途掉头',
      },
    ],
    soundZh: '可选一层 30–40 dB 的持续低频移动感（像车厢），与平移同起同停；不配也成立。',
    pitfallsZh: '平移方向与接下来的转场方向相反造成「反弹」；画面两端没有安全区，主体被切掉。',
    recipe: {
      css: '@keyframes track{from{transform:translateX(-4%)}to{transform:translateX(4%)}}.stage{animation:track 5s linear both}',
      ffmpeg:
        "zoompan=z='1.12':x='(iw-iw/zoom)*max(0,min((on-1)/119,1))':y='ih/2-(ih/zoom/2)':d=120:s=1080x1920:fps=30",
    },
  },
  {
    id: 'camera.tilt-reveal',
    category: 'camera',
    nameZh: '竖移揭示',
    oneLineZh: '镜头从上往下（或从下往上）移动，像拉开一张卷轴。',
    useWhenZh: '长页面/长图展示、竖屏海报、身高或比例对比、排版类内容。',
    seconds: [1.5, 5],
    energy: 'medium',
    tags: ['竖移', 'tilt', 'reveal', '长图', '卷轴'],
    intentZh: '利用人类从上往下阅读的习惯，让信息按顺序自己出现，不需要旁白交代顺序。',
    motionZh: '自上而下匀速 5–15% 画幅，起步略缓、结尾略缓；竖屏内容做 20% 以上时要分段。',
    params: [
      {
        name: '移动方向',
        typical: '从上往下',
        feelZh: '往下调成反向会让人觉得在「倒回去」；只有收尾回到起点时才该反过来',
      },
      {
        name: '移动幅度',
        typical: '画幅的 8–12%',
        feelZh: '再大就会露出内容边界；再小看不出是运镜，以为是画面在抖',
      },
      {
        name: '两端缓动',
        typical: '0.5 秒 ease-in-out',
        feelZh: '没有缓动会像滚轮拖拽；缓动太长会显得犹豫、像鼠标没撒手',
      },
    ],
    soundZh: '纸张/卷轴类摩擦声随移动持续，音高轻微上行；电子界面内容配极轻的滚动 UI 音。',
    pitfallsZh: '竖屏 9:16 里做大幅竖移会立刻撞到内容上下边界；移动中同时换焦点，观众不知道该看哪。',
    recipe: {
      css: '@keyframes tiltDown{from{transform:translateY(-6%)}to{transform:translateY(6%)}}.stage{animation:tiltDown 4s ease-in-out both}',
      ffmpeg:
        "zoompan=z='1.12':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*max(0,min((on-1)/119,1))':d=120:s=1080x1920:fps=30",
    },
  },
  {
    id: 'camera.parallax-drift',
    category: 'camera',
    nameZh: '多层视差错动',
    oneLineZh: '前后景以不同速度移动，一层层拉开空间深度。',
    useWhenZh: '有前景/背景分层的插画、UI 页面、产品分解图；想用很低的成本换来「有景深」时。',
    seconds: [3, 10],
    energy: 'low',
    tags: ['视差', 'parallax', '景深', '分层', '深度'],
    intentZh: '给平面素材制造伪 3D 空间感，让长时间停留的画面不显死板。',
    motionZh: '背景层移动 1–2% 画幅，中景 4%，前景 8–10%；所有层方向一致、速度按深度递增。',
    params: [
      {
        name: '层间速度比',
        typical: '背景:中景:前景 = 1:2.5:5',
        feelZh: '比例拉大景深更夸张、像动画片；比例拉平就退回平面设计，失去空间',
      },
      {
        name: '总位移',
        typical: '前景 6–10% 画幅',
        feelZh: '再大前景会飞出画面、需要补素材；再小基本看不出来，等于白做',
      },
      {
        name: '视差方向',
        typical: '跟随主导运动',
        feelZh: '方向和主运动调反时会产生「镜头在倒车」的错觉；除非故意做眩晕，否则保持同向',
      },
    ],
    soundZh: '几乎不需要声音；如果用，只给极轻的空气感环境垫，不要盖过旁白。',
    pitfallsZh: '把所有元素都放进同一层导致没有视差；前景运动过快直接穿帮出画。',
    recipe: {
      css: '.bg{transform:translateX(calc(var(--p)*1%))}.mid{transform:translateX(calc(var(--p)*2.5%))}.fg{transform:translateX(calc(var(--p)*5%))}',
    },
  },

  /* ----------------------------------------------------------- transitions */
  {
    id: 'transitions.hard-cut',
    category: 'transitions',
    nameZh: '动作硬切',
    oneLineZh: '在动作最快的瞬间直接切换，让两段画面共用一次运动惯性。',
    useWhenZh: '节奏快的段落、列表快闪、需要「干脆」而非「温柔」的交接。',
    seconds: [0, 0.2],
    energy: 'high',
    tags: ['硬切', 'hard-cut', 'cut', '节奏', '干脆'],
    intentZh: '用切点本身传递速度：观众感觉不到「过渡」，只感觉到推进。',
    motionZh: '无过渡；切点选在运动矢量最大处，前后两镜的位移方向尽量一致。',
    params: [
      {
        name: '切点位置',
        typical: '动作峰值后 1–2 帧',
        feelZh: '切在峰值前会显得没做完就断了；切在峰值后 4 帧以上就变成「停一下再换」，冲劲消失',
      },
      {
        name: '方向匹配',
        typical: '前后同向',
        feelZh: '方向调反会读成「撞车」、产生回弹感；调成同向时观众会把两镜看成同一段运动',
      },
      {
        name: '切点密度',
        typical: '每 0.8–2 秒一刀',
        feelZh: '再密会累、信息来不及读；再疏就不是快节奏，应该改用渐变转场',
      },
    ],
    soundZh: '切点前后环境声保持连续、让画面先断；或者反过来让声音先断一下再回来，制造「抽气」感。',
    pitfallsZh: '连续硬切却每刀都换景别和方向，观众会晕；切点落在静止帧上，干脆感变成生硬。',
    recipe: {
      ffmpeg: '# 两个场景都设 transitionIn: "cut"；渲染器用 concat 语义拼接，不会产生重叠帧',
      css: '// 直接切换节点可见性；关键是让两段动画在切点处速度不为 0',
    },
  },
  {
    id: 'transitions.whip-pan',
    category: 'transitions',
    nameZh: '甩镜转场',
    oneLineZh: '画面高速横向甩出，用运动模糊糊掉中间过程，再甩出下一镜。',
    useWhenZh: '场景之间的空间跳跃、快节奏 vlog、把两个无关地点自然接起来。',
    seconds: [0.2, 0.5],
    energy: 'high',
    tags: ['甩镜', 'whip-pan', 'motion-blur', '快速转场', '空间跳跃'],
    intentZh: '用运动模糊「偷走」过渡的一瞬，观众只记得方向，不记得过程。',
    motionZh: '0.15 秒内加速横移出画（带 20–40px 方向模糊），切镜后同方向减速入画。',
    params: [
      {
        name: '甩动时长',
        typical: '0.18–0.25 秒',
        feelZh: '再长会变成慢速平移、能看清糊掉的内容；再短就只剩一帧糊，像掉帧',
      },
      {
        name: '模糊强度',
        typical: '方向模糊 24px',
        feelZh: '模糊调小会看到硬边、像贴图错位；模糊调过头会变成纯色闪屏，失去方向信息',
      },
      {
        name: '出画方向',
        typical: '与下一镜入画同向',
        feelZh: '出画方向调反时观众会感到镜头被「弹回来」；和入画同向才像一次真实的甩动',
      },
    ],
    soundZh: '一条短促 whoosh（0.2 秒）或布料甩动声，左右声像随方向移动；音量比旁白低 8 dB 以上。',
    pitfallsZh: '每个转场都用甩镜会显得廉价；甩动里夹着重要文字，观众根本读不到。',
    recipe: {
      css: '@keyframes whipOut{to{transform:translateX(-120%) skewX(-8deg);filter:blur(20px)}}.whip{animation:whipOut .2s ease-in both}',
    },
  },
  {
    id: 'transitions.match-cut',
    category: 'transitions',
    nameZh: '同构匹配切',
    oneLineZh: '让前后两镜里的两个不同物体占据同一位置与同一轮廓，然后切。',
    useWhenZh: '"A 变成 B" 的比喻、从实物到图标、从远景到地图上的同一点。',
    seconds: [0.1, 0.4],
    energy: 'medium',
    tags: ['匹配切', 'match-cut', '同构', '比喻', '图形'],
    intentZh: '用视觉形状的连续性骗过剪接点，让观众觉得「这本来就该是同一个东西」。',
    motionZh: '切点本身无运动；关键在于两镜中匹配物的中心点偏差 < 画幅 2%、尺寸接近、朝向一致。',
    params: [
      {
        name: '位置偏差',
        typical: '≤ 画幅 2%',
        feelZh: '再大观众会察觉跳了一下、匹配失效；完美对齐时切点会「消失」在运动里',
      },
      {
        name: '尺寸差',
        typical: '≤ 15%',
        feelZh: '尺寸差太大等于换物体，需要中间加一帧缩放桥接；差太小又不够明显、像重复',
      },
      {
        name: '轮廓清晰度',
        typical: '两个物体都高对比',
        feelZh: '低对比素材会让匹配点靠猜；描边或剪影化处理能显著提高成功率',
      },
    ],
    soundZh: '切点给上一段声音一个自然收尾，下一段声音从切点起（J-cut 也行），不要加转场音效。',
    pitfallsZh: '两个物体颜色差异过大、视线落点不一致；为了匹配把画面硬掰到变形。',
    recipe: {
      ffmpeg: '# 两场景都用 cut；在前一镜末尾与后一镜开头各留 2 帧静止，便于找到精确切点',
    },
  },
  {
    id: 'transitions.mask-wipe',
    category: 'transitions',
    nameZh: '图形遮罩擦除',
    oneLineZh: '用圆形、斜切或自定义形状做遮罩，把下一镜「刷」进来。',
    useWhenZh: '章节切换、需要一点仪式感但不想太慢的段落；品牌感强的商业片。',
    seconds: [0.3, 1.2],
    energy: 'medium',
    tags: ['遮罩', 'wipe', 'mask', '擦除', '章节'],
    intentZh: '让转场形状本身成为视觉语言（圆=聚焦、斜切=速度），而不是万能淡入淡出。',
    motionZh: '遮罩边缘 0.3–0.6 秒扫过，前慢后快或匀速；遮罩边缘可加 2–6px 羽化避免硬边。',
    params: [
      {
        name: '擦除方向',
        typical: '与阅读方向一致',
        feelZh: '逆阅读方向会顿一下；把方向调成同向，观众才觉得画面被「翻过去」',
      },
      {
        name: '边缘羽化',
        typical: '4–8px',
        feelZh: '羽化太少会看到锯齿、像抠图；羽化太大会变成模糊淡入，失去形状语言',
      },
      {
        name: '持续时间',
        typical: '0.4 秒',
        feelZh: '再慢会拖节奏；再快会让形状来不及被认出，等于白做设计',
      },
    ],
    soundZh: '一条与擦除同速的合成 swipe，加一帧短混响；形状有品牌含义时音效可呼应（圆=低频，斜切=高频）。',
    pitfallsZh: '每段换一种遮罩形状，语汇不统一；遮罩边缘穿过文字导致半个字被吃掉。',
    recipe: {
      css: '.next{clip-path:polygon(0 0,0 0,0 100%,0 100%);animation:wipe .5s ease-in-out forwards}@keyframes wipe{to{clip-path:polygon(0 0,100% 0,100% 100%,0 100%)}}',
      ffmpeg: 'xfade=transition=wipeleft:duration=0.5:offset=3.0',
    },
  },
  {
    id: 'transitions.blur-dissolve',
    category: 'transitions',
    nameZh: '模糊叠化',
    oneLineZh: '前一镜边模糊边淡出，后一镜从模糊中淡入，像一次呼吸。',
    useWhenZh: '情绪段落、时间流逝、回忆/梦境；需要「软」而不是「切」的地方。',
    seconds: [0.4, 1.2],
    energy: 'low',
    tags: ['叠化', 'dissolve', 'blur', '柔和', '情绪'],
    intentZh: '用焦点的丢失和恢复表达时间的滑过，而不是信息的中断。',
    motionZh: '0.6 秒内：A 镜模糊半径 0→8px 同时透明度 1→0，B 镜反向；两镜可叠加轻微缩放。',
    params: [
      {
        name: '叠化时长',
        typical: '0.6–0.8 秒',
        feelZh: '再长会明显拖节奏、像幻灯片切换；再短就变成不干净的硬切',
      },
      {
        name: '最大模糊',
        typical: '8–12px',
        feelZh: '模糊调小能看到两个画面打架；模糊调大过头会变成一坨色块，观众丢失方向',
      },
      {
        name: '是否同时缩放',
        typical: '各 2% 同向',
        feelZh: '同向慢缩放会让叠化更「流动」；反向缩放会产生眩晕，慎用',
      },
    ],
    soundZh: '一段反向混响/长音铺过转场，把两段的声音缝合；不要用硬切的打击音。',
    pitfallsZh: '高频语速旁白跨过叠化会显得拖沓；连续多用叠化会让整片没有支点。',
    recipe: {
      css: '.a{animation:out .7s ease both}.b{animation:in .7s ease both}@keyframes out{to{opacity:0;filter:blur(10px)}}@keyframes in{from{opacity:0;filter:blur(10px)}}',
      ffmpeg: 'xfade=transition=dissolve:duration=0.7:offset=2.5',
    },
  },

  /* ----------------------------------------------------------- typography */
  {
    id: 'typography.kinetic-stack',
    category: 'typography',
    nameZh: '字块逐行撞入',
    oneLineZh: '一行行大字从侧边或下方带惯性撞进画面，形成文字墙。',
    useWhenZh: '金句、观点输出、片名；需要「有音量」的文字而不是说明性文字时。',
    seconds: [1, 3],
    energy: 'high',
    tags: ['撞入', 'kinetic-type', '逐行', '大字', '金句'],
    intentZh: '让文字的到达拥有质量与速度，观众感觉是被「说」到脸上，而不是读到。',
    motionZh: '每行从 -6~-12% 画面位移处出发，0.35–0.5 秒 ease-out 撞入，行间错峰 0.08–0.14 秒。',
    params: [
      {
        name: '错峰间隔',
        typical: '2–4 帧',
        feelZh: '间隔太大变成逐行等待、速度掉下来；间隔太小会糊成一团同时出现，冲击力没了',
      },
      {
        name: '起始位移',
        typical: '0.08 画幅',
        feelZh: '再远会像从画面外飞进来、运动信息压过文字；再近就只是轻推、不够「撞」',
      },
      {
        name: '出字方向',
        typical: '与阅读方向相反',
        feelZh: '从右往左撞会制造「被推回来」的力度；顺着阅读方向则更平顺、适合温柔句',
      },
    ],
    soundZh: '每行配一记短促的低频「咚」或键盘重音，行间音高可微微上行；不要配旋律，会盖过文字本身。',
    pitfallsZh: '行数过多（>4）导致最后一行来不及读；错峰太快变成一团抖动。',
    recipe: {
      css: '.line{opacity:0;transform:translateY(40%);animation:stack .45s cubic-bezier(.2,.9,.2,1) forwards}.line:nth-child(2){animation-delay:.1s}@keyframes stack{to{opacity:1;transform:none}}',
    },
  },
  {
    id: 'typography.word-swap',
    category: 'typography',
    nameZh: '关键词替换',
    oneLineZh: '同一句话里只有一个词在换，其他文字保持不动。',
    useWhenZh: '强调变量（「这不是 A，是 B」）、功能对比、口播字幕的关键词高亮。',
    seconds: [1.5, 4],
    energy: 'medium',
    tags: ['关键词', 'word-swap', '替换', '对比', '字幕'],
    intentZh: '把观众的注意力锁在一个词上，用替换本身完成论证，画面其他部分保持稳定。',
    motionZh: '旧词向上淡出 0.18 秒，新词从下方 0.3 行高弹入并轻微放大 6% 回正；其余文字不动。',
    params: [
      {
        name: '切换节奏',
        typical: '每 0.8–1.2 秒一个',
        feelZh: '再快读者来不及读完整句；再慢会像在等待加载，节奏感消失',
      },
      {
        name: '位移幅度',
        typical: '0.3 行高',
        feelZh: '位移越大越有「翻牌」感；超过半行会让整句跳动，分散对句意的注意',
      },
      {
        name: '高亮色',
        typical: '只用于被替换词',
        feelZh: '高亮溢出到整句会让关键词失焦；完全不高亮则依赖运动，远处看不清',
      },
    ],
    soundZh: '每次替换配一个轻快短音（类似 UI 切换），音高固定；连续 3 次后停一拍，避免机械感。',
    pitfallsZh: '替换的词长度差别大导致整行重新居中、发生跳动；每个词都换，变成乱码动画。',
    recipe: {
      css: '.word{display:inline-block;animation:swap .3s ease both}@keyframes swap{from{transform:translateY(.4em);opacity:0}to{transform:none;opacity:1}}',
    },
  },
  {
    id: 'typography.type-on',
    category: 'typography',
    nameZh: '打字机逐字',
    oneLineZh: '文字一个字一个字出现，像正在被写下或被念出来。',
    useWhenZh: '代码/命令行/搜索演示、引语、需要「正在生成」感的界面镜头。',
    seconds: [0.8, 4],
    energy: 'low',
    tags: ['打字机', 'type-on', '逐字', '命令行', '引语'],
    intentZh: '把「阅读」变成「观看生成」，节奏由字数决定，天然与朗读同步。',
    motionZh: '按字/词步进出现，每秒 8–14 个汉字；光标可选闪烁 2 次后消失。',
    params: [
      {
        name: '出字速度',
        typical: '每秒 10 字',
        feelZh: '再快就接近直接出现，失去「正在写」的仪式；再慢会让人着急、像网卡',
      },
      {
        name: '是否等旁白',
        typical: '比旁白快 1–2 字',
        feelZh: '同步会造成旁白像在跟读；快一点让观众先读到，听感更从容',
      },
      {
        name: '光标',
        typical: '结束后再闪 2 次',
        feelZh: '光标闪太久像等待输入；没有光标则少了「可编辑」的暗示',
      },
    ],
    soundZh: '每 3–5 个字符配一声极轻的键盘/笔触，音量随文字密度自动降低；整段不要铺满机械音。',
    pitfallsZh: '长段落逐字出现导致观众失去耐心；中英混排时步进速度不一致。',
    recipe: {
      css: '.typed{width:0;overflow:hidden;white-space:nowrap;animation:typing 2s steps(24) forwards}@keyframes typing{to{width:100%}}',
      canvas: 'const shown=text.slice(0,Math.floor(t*charsPerSecond));ctx.fillText(shown,x,y);',
    },
  },
  {
    id: 'typography.outline-fill',
    category: 'typography',
    nameZh: '描边转实心',
    oneLineZh: '文字先是空心描边，再被颜色填满或反过来，形成一次「完成」的动作。',
    useWhenZh: '关键词强调、价格/数字揭示、版式型标题卡；需要比纯色渐变更「有步骤」时。',
    seconds: [0.8, 2.5],
    energy: 'medium',
    tags: ['描边', 'outline', '填色', 'text-stroke', '标题'],
    intentZh: '用「从结构到实体」的过程表达确定与落定，观众会感到信息被盖章。',
    motionZh: '描边透明度 0→1（0.2 秒）→ 描边收缩同时填充色从下往上灌满（0.35 秒）→ 停 0.4 秒。',
    params: [
      {
        name: '描边宽度',
        typical: '字号的 3–5%',
        feelZh: '再粗会糊成粗体块；再细在小屏上消失，尤其竖屏缩略图',
      },
      {
        name: '填色方向',
        typical: '从下往上',
        feelZh: '向上填读作「增长」；向下填会像「退出/删除」，除非你在表达崩坏',
      },
      {
        name: '完成停顿',
        typical: '0.4 秒',
        feelZh: '停太短观众没看清完成态；停太久会像卡住，需要用音效填满',
      },
    ],
    soundZh: '描边出现配笔触声，填满瞬间配一记结实的「盖章」低频；两者之间留 0.1 秒空隙。',
    pitfallsZh: '描边和填充同时进行导致两种状态都看不清；描边色与背景对比不足。',
    recipe: {
      css: '.word{color:transparent;-webkit-text-stroke:2px #fff;background:linear-gradient(#fff,#fff) no-repeat 0 100%/100% 0;background-clip:text;animation:fill .8s ease-out forwards}@keyframes fill{to{background-size:100% 100%}}',
    },
  },
  {
    id: 'typography.text-mask-reveal',
    category: 'typography',
    nameZh: '字内遮罩揭示',
    oneLineZh: '文字本身当遮罩，底下是流动的图片或渐变，字被「看见」的同时材质在动。',
    useWhenZh: '片名、章节标题、需要视觉质感的大字；想用一张图撑起整个版式时。',
    seconds: [1, 3],
    energy: 'medium',
    tags: ['文字遮罩', 'background-clip', '材质', '标题卡', '渐变'],
    intentZh: '让文字不只是颜色，而是一个「窗口」，把画面信息并进字里。',
    motionZh: '底图/渐变以 0.5 倍速度横向漂移，字本身做 1–2% 缩放；整体轻浮动避免死板。',
    params: [
      {
        name: '漂移速度',
        typical: '每秒 3–5% 宽度',
        feelZh: '再快字内画面会闪、文字可读性下降；再慢像静态图，浪费了这个技法',
      },
      {
        name: '材质对比',
        typical: '亮部与暗部都在字内',
        feelZh: '材质太均匀字会糊；对比过强会让部分笔画消失，需要换底图',
      },
      {
        name: '是否描边',
        typical: '1–2px 细描边',
        feelZh: '加描边能保证笔画边界；描边太粗会盖掉材质，变成普通空心字',
      },
    ],
    soundZh: '一段缓慢的氛围垫，随漂移轻微左右声像移动；文字定住时不要加冲击音，保持贵感。',
    pitfallsZh: '材质太花导致字难读；在多语言字幕上使用会显著降低可读性。',
    recipe: {
      css: '.title{background:url(scene.jpg) center/cover;background-clip:text;-webkit-background-clip:text;color:transparent;animation:pan 6s linear infinite}@keyframes pan{to{background-position:100% 50%}}',
    },
  },

  /* ----------------------------------------------------------- ui-entrance */
  {
    id: 'ui-entrance.card-pop',
    category: 'ui-entrance',
    nameZh: '卡片弹入',
    oneLineZh: '界面卡片从 90% 大小带轻微过冲弹出，落位时有一点点回弹。',
    useWhenZh: '功能卖点逐条出现、通知/消息演示、UI 截图的第一层入场。',
    seconds: [0.4, 1.2],
    energy: 'medium',
    tags: ['卡片', '弹入', 'pop', 'spring', 'UI'],
    intentZh: '用物理感的到达替代淡入，让界面看起来是「活的」，观众更容易理解层级关系。',
    motionZh: 'scale 0.9→1.02→1，透明度 0→1，0.28–0.4 秒；落位后阴影从 0 到正常值。',
    params: [
      {
        name: '过冲量',
        typical: '2–4%',
        feelZh: '再大就变活泼/玩具感；完全不过冲则显得机械、像 PPT 直接出现',
      },
      {
        name: '入场时长',
        typical: '0.32 秒',
        feelZh: '再长会像慢动作、观众会等它落位；再短会看不清卡片内容',
      },
      {
        name: '阴影变化',
        typical: '0 → 24px 模糊',
        feelZh: '阴影一起变会让卡片「浮起来」；阴影不动则像贴纸，缺重量',
      },
    ],
    soundZh: '一记轻快的 UI「啵」或短木鱼，音量低于旁白 10 dB；多张卡片连续弹入时音高依次升高半音。',
    pitfallsZh: '每张卡片都做大幅过冲导致画面躁动；弹入顺序与阅读顺序不一致。',
    recipe: {
      css: '.card{opacity:0;transform:scale(.9);animation:pop .34s cubic-bezier(.2,1.5,.4,1) forwards}@keyframes pop{60%{transform:scale(1.03)}to{opacity:1;transform:none}}',
    },
  },
  {
    id: 'ui-entrance.stagger-list',
    category: 'ui-entrance',
    nameZh: '列表错峰',
    oneLineZh: '一列项目按固定间隔依次出现，像被迅速点名。',
    useWhenZh: '功能清单、菜单项、聊天记录、搜索结果；需要表现「很多」但不拖时长时。',
    seconds: [0.8, 2.5],
    energy: 'low',
    tags: ['列表', 'stagger', '错峰', '逐项', 'UI'],
    intentZh: '用节奏把若干并列信息变成可数的序列，观众会自然跟着读，而不是一眼扫完。',
    motionZh: '每项从下方 8–14px 淡入上移，项间延迟 40–80ms，最后一项出现后整体停 0.3 秒。',
    params: [
      {
        name: '项间延迟',
        typical: '50ms',
        feelZh: '再大像逐条等待、节奏断；再小会糊成一片同时出现，看不出「很多项」',
      },
      {
        name: '总项数',
        typical: '4–7 项',
        feelZh: '超过 8 项时观众会开始跳读；这时应该改成分页或加滚动',
      },
      {
        name: '位移距离',
        typical: '12px',
        feelZh: '位移越大越像从下面被推上来；贴地移动（0–4px）更冷静、适合专业工具',
      },
    ],
    soundZh: '每项一个极轻的 tick，音量逐项递减；或者完全静音，让画面自己说明「很多」。',
    pitfallsZh: '列表项入场时布局在跳动（未预留高度）；最后一项被字幕或片尾压住。',
    recipe: {
      css: '.item{opacity:0;transform:translateY(12px);animation:rise .4s ease forwards}.item:nth-child(1){animation-delay:0s}.item:nth-child(2){animation-delay:.05s}.item:nth-child(3){animation-delay:.1s}@keyframes rise{to{opacity:1;transform:none}}',
    },
  },
  {
    id: 'ui-entrance.sheet-rise',
    category: 'ui-entrance',
    nameZh: '底部抽屉升起',
    oneLineZh: '一块面板从屏幕底部滑出，停在画面下半部，像手机里的 bottom sheet。',
    useWhenZh: '购物/点餐/设置类演示、需要把「第二层信息」展示出来时。',
    seconds: [0.5, 1.5],
    energy: 'medium',
    tags: ['抽屉', 'bottom-sheet', '升起', 'UI', '面板'],
    intentZh: '沿用观众对手机界面的肌肉记忆，看到抽屉升起就知道「有更多内容」。',
    motionZh: 'translateY 100%→0，0.4 秒 ease-out，落位时 2–3px 回弹；背景同时压暗 35%。',
    params: [
      {
        name: '升起时长',
        typical: '0.4 秒',
        feelZh: '再慢像系统卡顿；再快会糊掉面板内容，观众不知道弹出了什么',
      },
      {
        name: '停靠高度',
        typical: '屏高的 55–70%',
        feelZh: '太低信息装不下；太高会盖住主界面，观众忘了上下文',
      },
      {
        name: '背景压暗',
        typical: '35%',
        feelZh: '压太狠像切场景；完全不压暗则层级不清，主界面会抢注意力',
      },
    ],
    soundZh: '一声轻薄的「唰」加一记落位闷响；若在跟手机界面演示，可加系统弹层音。',
    pitfallsZh: '抽屉里内容比抽屉先动；升起过程中文字还在变，观众读不到。',
    recipe: {
      css: '.sheet{transform:translateY(100%);animation:rise .45s cubic-bezier(.2,.9,.2,1) forwards}@keyframes rise{to{transform:translateY(0)}}',
    },
  },
  {
    id: 'ui-entrance.grid-reflow',
    category: 'ui-entrance',
    nameZh: '网格重排',
    oneLineZh: '一排卡片重新排列成网格，元素带着位置记忆移动，而不是消失重建。',
    useWhenZh: '切换视图（列表→网格）、筛选结果更新、展示「整理」的能力。',
    seconds: [0.8, 2.5],
    energy: 'medium',
    tags: ['网格', 'reflow', 'FLIP', '重排', 'UI'],
    intentZh: '用元素的连续位移让观众理解「同一批东西换了组织方式」，比淡出重画更可读。',
    motionZh: '旧位置→新位置用 0.5 秒 ease-in-out 位移+缩放；分批错峰 30ms；期间不换内容。',
    params: [
      {
        name: '重排时长',
        typical: '0.5 秒',
        feelZh: '再长会像拖影、观众以为在加载；再短就看不清哪些元素去了哪',
      },
      {
        name: '错峰',
        typical: '每批 30ms',
        feelZh: '错峰会形成「流动感」；完全同时移动更像机械排序，适合工具类演示',
      },
      {
        name: '缩放差',
        typical: '高度变化 ≤ 20%',
        feelZh: '尺寸变化太大时观众会误以为换了内容；不变最安全',
      },
    ],
    soundZh: '可加极轻的「沙沙」重排声；数量多时用一层布料摩擦反而更自然。',
    pitfallsZh: '重排时元素被裁剪或溢出容器；新旧位置都可见导致重影。',
    recipe: {
      css: '// FLIP: 先记录旧 rect，改布局后 transform 回旧位置，再 rAF 里 transition 到 0',
      canvas: 'const p=easeInOut(min(1,t/dur));drawCard(lerp(from.x,to.x,p),lerp(from.y,to.y,p));',
    },
  },

  /* ----------------------------------------------------------- interaction */
  {
    id: 'interaction.cursor-focus',
    category: 'interaction',
    nameZh: '光标点击聚焦',
    oneLineZh: '系统光标移向目标、点击、以点击点为圆心放大或聚焦。',
    useWhenZh: '软件操作演示、教程、功能入口说明；观众需要知道「点哪里」。',
    seconds: [1.5, 4],
    energy: 'medium',
    tags: ['光标', '点击', 'focus', '教程', 'UI 演示'],
    intentZh: '把操作路径可视化，让观众的注意力先跟着光标走，再落到结果上。',
    motionZh: '光标 0.6 秒 ease-in-out 移向目标，到位后停 0.2 秒再点击；点击瞬间以点为圆心 1.6 倍放大 0.4 秒。',
    params: [
      {
        name: '移动时长',
        typical: '0.6–0.9 秒',
        feelZh: '再快观众跟不上轨迹；再慢会像光标卡顿、视频显得拖',
      },
      {
        name: '点击后停顿',
        typical: '0.2 秒',
        feelZh: '太短会错过「点了」的瞬间；太长会让节奏中断，像在等加载',
      },
      {
        name: '放大倍率',
        typical: '1.5–1.8 倍',
        feelZh: '再大观众会失去上下文、不知道放大了哪里；再小等于没放大',
      },
    ],
    soundZh: '一声轻柔的鼠标点击（不要机械键盘声）；放大部分可加一记短上扬音表示「进入」。',
    pitfallsZh: '光标移动得比真人快、没有加速度；点击特效太夸张像游戏 UI。',
    recipe: {
      css: '.cursor{animation:move .8s ease-in-out forwards}@keyframes move{to{transform:translate(240px,120px)}}.pulse{animation:pulse .4s ease-out}@keyframes pulse{from{transform:scale(.2);opacity:1}to{transform:scale(1.8);opacity:0}}',
    },
  },
  {
    id: 'interaction.hover-tilt',
    category: 'interaction',
    nameZh: '悬停倾斜',
    oneLineZh: '鼠标划过时卡片轻微 3D 倾斜，高光跟着鼠标方向移动。',
    useWhenZh: '展示卡片/产品图的质感、需要「可交互」暗示的界面镜头。',
    seconds: [1, 3],
    energy: 'low',
    tags: ['悬停', 'hover', '3D', 'tilt', '高光'],
    intentZh: '用微小的物理反馈传达「这个界面是活的」，但幅度必须克制，否则变成炫技。',
    motionZh: 'rotateX/Y 各 ±4–6°，透视 800px，高光径向渐变跟随鼠标在 0.15 秒内平滑移动。',
    params: [
      {
        name: '倾斜角度',
        typical: '±5°',
        feelZh: '再大就变成玩具展示、失去专业感；再小看不出交互，等于没做',
      },
      {
        name: '透视距离',
        typical: '800px',
        feelZh: '透视越近变形越夸张；越远越平，接近普通 2D 阴影',
      },
      {
        name: '回正速度',
        typical: '0.3 秒',
        feelZh: '回得太快像弹簧坏掉；太慢像鼠标黏住了',
      },
    ],
    soundZh: '通常不需要声音；如果做电商，可以加极轻的金属/纸张质感音，随机音高。',
    pitfallsZh: '全片每个卡片都倾斜，观众会晕；倾斜时文字被 3D 变形，可读性下降。',
    recipe: {
      css: '.card{transition:transform .3s ease;transform:perspective(800px) rotateX(var(--rx)) rotateY(var(--ry))}',
    },
  },
  {
    id: 'interaction.drag-drop',
    category: 'interaction',
    nameZh: '拖拽归位',
    oneLineZh: '一个元素被拖起、移动、松手后弹到目标位置。',
    useWhenZh: '看板/文件管理/上传演示；需要表达「整理、归档、完成」的动作时。',
    seconds: [1.5, 4],
    energy: 'medium',
    tags: ['拖拽', 'drag', 'drop', '归位', '整理'],
    intentZh: '把「操作成功」变成一个可见的物理过程，观众会跟着松一口气。',
    motionZh: '拖起时放大 1.05、阴影加深；拖动轨迹轻微抖动；松手后 0.25 秒弹到目标并回正。',
    params: [
      {
        name: '拖起缩放',
        typical: '1.05 倍',
        feelZh: '再大像拿起一个玩具；不变则缺少「被抓住」的反馈',
      },
      {
        name: '落位时长',
        typical: '0.25 秒',
        feelZh: '再慢让人等结果；再快会看不清落到了哪一格',
      },
      {
        name: '轨迹抖动',
        typical: '±2px',
        feelZh: '有一点手抖会像真人操作；抖动过大像信号不稳、显得廉价',
      },
    ],
    soundZh: '拿起一声轻「嗒」，落位一声更低沉的「咔」；两次音之间保持安静，让观众专注轨迹。',
    pitfallsZh: '拖拽路径穿过文字；落位后没有轻微回弹，像瞬移。',
    recipe: {
      css: '.drag{transition:transform .25s cubic-bezier(.2,1.4,.4,1)}.dragging{transform:scale(1.05);filter:drop-shadow(0 12px 18px rgba(0,0,0,.35))}',
    },
  },
  {
    id: 'interaction.scroll-reveal',
    category: 'interaction',
    nameZh: '滚动视差揭示',
    oneLineZh: '页面滚动时，背景慢、内容快，一层层把页面「展开」。',
    useWhenZh: '落地页/长页面展示、功能清单、需要模拟浏览网页的镜头。',
    seconds: [1.5, 5],
    energy: 'low',
    tags: ['滚动', 'scroll', '视差', '长页面', '网页'],
    intentZh: '让观众感觉自己在浏览，而不是在看一张固定截图；滚动本身建立阅读节奏。',
    motionZh: '内容层 translateY -40~-70% 屏高，背景层 -10~-20%；滚动速度前快后慢，末端停住。',
    params: [
      {
        name: '滚动距离',
        typical: '屏高的 1.5–2.5 倍',
        feelZh: '再长会拖节奏、需要更多内容填充；再短没有「浏览」感',
      },
      {
        name: '背景速度比',
        typical: '内容的 30%',
        feelZh: '比例过高会让背景抢运动；完全不动则失去纵深',
      },
      {
        name: '末端停留',
        typical: '0.6 秒',
        feelZh: '停得久让人看清最后一条信息；停留再短就像滑过头，观众会倒回去看',
      },
    ],
    soundZh: '可加极轻的滚动/滚轮声，节奏与滚动同步；信息类演示通常静音更专业。',
    pitfallsZh: '滚动速度与页面内容密度不匹配，信息一闪而过；文字在滚动中模糊（运动模糊过度）。',
    recipe: {
      css: '.content{transform:translateY(calc(var(--scroll)*-60%))}.bg{transform:translateY(calc(var(--scroll)*-18%))}',
    },
  },

  /* ------------------------------------------------------------------ data */
  {
    id: 'data.counter-roll',
    category: 'data',
    nameZh: '数字滚动',
    oneLineZh: '一个大数字从 0 快速滚动到目标值，最后一位略微减速停稳。',
    useWhenZh: '业绩、增长率、价格、粉丝数；需要一个「有分量」的数字结论时。',
    seconds: [1, 3],
    energy: 'medium',
    tags: ['数字', 'counter', '滚动', 'data', '结论'],
    intentZh: '把静态结论变成一次抵达，观众对「增长」的体感来自滚动过程而不是数字本身。',
    motionZh: '0→目标值，前 70% 时间完成 90% 的数值，最后 30% 缓慢落到精确值；数字等宽。',
    params: [
      {
        name: '滚动时长',
        typical: '1.2–1.8 秒',
        feelZh: '再长像老虎机、观众会怀疑真实性；再短来不及看清位数',
      },
      {
        name: '缓动形状',
        typical: 'ease-out 强',
        feelZh: '线性会像里程表、机械；尾部拖得越长越有「贵」感，但超过 0.8 秒会显得犹豫',
      },
      {
        name: '进制对齐',
        typical: '千分位/等宽',
        feelZh: '数字不定宽会在滚动时左右跳动；把字体换成等宽数字立刻稳，再多加两位也不会跳',
      },
    ],
    soundZh: '滚动过程配一串极轻的快速 tick，落定时一记低频确认音；tick 不要与旁白抢频率。',
    pitfallsZh: '滚动时间与旁白数字不同步；小数点后位数在滚动中乱跳。',
    recipe: {
      canvas: 'const v=Math.floor(target*(1-Math.pow(1-p,3)));ctx.fillText(v.toLocaleString(),x,y);',
      css: '// 用 requestAnimationFrame 更新 textContent，不要用 CSS 数字动画（不可控）',
    },
  },
  {
    id: 'data.bar-grow',
    category: 'data',
    nameZh: '条形生长',
    oneLineZh: '条形从基线向上（或向右）长出来，长度带着轻微的过冲停稳。',
    useWhenZh: '排行榜、对比数据、构成比例；观众需要比较长短时。',
    seconds: [0.8, 3],
    energy: 'medium',
    tags: ['条形', 'bar', '生长', '对比', '图表'],
    intentZh: '用生长的过程让观众感知「多和少」的差距，而不是直接读百分比。',
    motionZh: '从 0 到目标值 0.6 秒 ease-out，依次错峰 60ms；到顶后回弹 2% 再停。',
    params: [
      {
        name: '增长时长',
        typical: '0.6 秒',
        feelZh: '再长会让比较变成等待；再短就看不清差距的积累过程',
      },
      {
        name: '错峰间隔',
        typical: '60ms',
        feelZh: '错峰会形成「扫描」感；同时长出来更像一次整体脉冲，适合总量型数据',
      },
      {
        name: '坐标起点',
        typical: '固定基线',
        feelZh: '不从 0 开始时，视觉差距会被夸大，观众会觉得被误导',
      },
    ],
    soundZh: '每条生长配一声短音，音高随数值升高（映射到五声音阶更不刺耳）；最后最大值处可加一记强调。',
    pitfallsZh: '纵轴不从 0 开始导致比例失真；条形上数字与条长不同步。',
    recipe: {
      css: '.bar{transform-origin:bottom;transform:scaleY(0);animation:grow .6s cubic-bezier(.2,.8,.2,1) forwards}@keyframes grow{to{transform:scaleY(1)}}',
      canvas: 'ctx.fillRect(x,base-h*target*p,w,h*target*p);',
    },
  },
  {
    id: 'data.line-trace',
    category: 'data',
    nameZh: '折线描画',
    oneLineZh: '折线沿时间轴一笔画出，前端带一个发光点，画完再落数据点。',
    useWhenZh: '趋势、增长曲线、用户旅程；需要表现「随时间变化」的叙事。',
    seconds: [1.5, 5],
    energy: 'low',
    tags: ['折线', 'line-chart', '描画', '趋势', 'data'],
    intentZh: '让趋势的「方向」通过笔触被强调：观众看到曲线往上走，比读结论更有说服力。',
    motionZh: '0.8–1.6 秒匀速描画，前端亮点沿路径移动；画完后每个数据点依次弹出（间隔 50ms）。',
    params: [
      {
        name: '描画速度',
        typical: '1.2 秒画完',
        feelZh: '再慢观众会盯着点看、失去叙事；再快像加载完成的图表，少了过程感',
      },
      {
        name: '是否匀速',
        typical: '接近匀速',
        feelZh: '缓动会让线段速度忽快忽慢，读数据时产生歧义；匀速最像「真实时间」',
      },
      {
        name: '端点强调',
        typical: '只标最后一点',
        feelZh: '全部标记会显得像统计图；只留终点更聚焦结论',
      },
    ],
    soundZh: '一条持续的细线音随描画延伸，音高可随曲线上升；数据点配极轻的 tick。',
    pitfallsZh: '曲线画完才显示坐标轴，观众不知道尺度；描画速度与旁白不同步。',
    recipe: {
      canvas: 'ctx.setLineDash([len,len]);ctx.lineDashOffset=len*(1-p);ctx.stroke();ctx.setLineDash([]);',
    },
  },
  {
    id: 'data.donut-fill',
    category: 'data',
    nameZh: '环形填充',
    oneLineZh: '圆环从 12 点方向顺时针填满到目标比例，中心数字同步跳动。',
    useWhenZh: '完成度、满意度、占比（单一数字）；需要一个「圆」作为视觉锚点时。',
    seconds: [1, 3],
    energy: 'medium',
    tags: ['环形', 'donut', '进度', '占比', 'data'],
    intentZh: '圆环天然表达「整体中的一部分」，填充过程让比例变成可感知的旅程。',
    motionZh: '从 12 点开始顺时针，0.8 秒 ease-out 填到目标弧长；中心数字与弧长同步，先快后慢。',
    params: [
      {
        name: '起始角度',
        typical: '12 点方向',
        feelZh: '从 6 点开始逆时针会让人读成「减少」；12 点顺时针最符合直觉',
      },
      {
        name: '环宽',
        typical: '半径的 12–18%',
        feelZh: '太细像装饰线、数字抢镜；太粗像甜甜圈、中心数字被压缩',
      },
      {
        name: '填充时长',
        typical: '0.8 秒',
        feelZh: '再长像等待加载；再短观众看不到「从零开始」的过程，只有结果',
      },
    ],
    soundZh: '填充配一条随时间上升的柔和音，中心数字用 tick；到达目标时加一记干净的小和弦。',
    pitfallsZh: '环的填充与中心数字不同步；多个圆环同时填充导致注意力分散。',
    recipe: {
      canvas: 'ctx.beginPath();ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+Math.PI*2*p);ctx.lineWidth=w;ctx.stroke();',
    },
  },

  /* --------------------------------------------------------- light-emphasis */
  {
    id: 'light-emphasis.spotlight-sweep',
    category: 'light-emphasis',
    nameZh: '光斑扫过',
    oneLineZh: '一束柔和光斑从左到右扫过画面，提亮经过的区域。',
    useWhenZh: '金属/玻璃材质、品牌 logo 收尾、需要「崭新」质感的镜头。',
    seconds: [0.6, 2],
    energy: 'medium',
    tags: ['光斑', 'spotlight', 'sweep', '光泽', '质感'],
    intentZh: '光是「新」和「贵」的通用语言；扫过一次就能让材质从平面变成有表面。',
    motionZh: '径向渐变光斑（宽 30–45% 画面）以 0.2–0.35 画幅/秒横扫，边缘 40% 羽化，峰值不透明度 25–35%。',
    params: [
      {
        name: '光斑宽度',
        typical: '画幅的 35%',
        feelZh: '再宽会变成整体提亮、失去「扫过」的方向；再窄像一道激光、较硬',
      },
      {
        name: '扫过速度',
        typical: '0.9 秒扫完',
        feelZh: '越快越脆、适合 logo；越慢越润、适合奢侈品；超过 2 秒像卡住',
      },
      {
        name: '峰值不透明度',
        typical: '30%',
        feelZh: '再亮会过曝洗掉细节；再暗观众注意不到，白做',
      },
    ],
    soundZh: '一条非常轻的高频 shimmer，随光斑移动；音量低于音乐 12 dB，宁可不加也别盖过对白。',
    pitfallsZh: '光斑扫过文字导致可读性瞬间下降；多个光斑叠加变成「一束光特效合集」。',
    recipe: {
      css: '.sheen{position:absolute;inset:0;background:radial-gradient(ellipse 35% 80% at 0% 50%,rgba(255,255,255,.35),transparent 60%);animation:sweep .9s ease-in-out both}@keyframes sweep{to{transform:translateX(120%)}}',
    },
  },
  {
    id: 'light-emphasis.bloom-flash',
    category: 'light-emphasis',
    nameZh: '闪白强调',
    oneLineZh: '在切换/落点的一瞬间全屏闪白一下，快速衰减。',
    useWhenZh: '重音、产品亮相、转场冲击；需要「一记重拍」的瞬间。',
    seconds: [0.15, 0.6],
    energy: 'high',
    tags: ['闪白', 'flash', 'bloom', '重音', '强调'],
    intentZh: '用亮度的瞬时过载把注意力钉在一个点上，相当于视觉的重音符号。',
    motionZh: '白场 0→70% 不透明度 2 帧，然后 12–18 帧指数衰减回 0；可叠加轻微径向渐变。',
    params: [
      {
        name: '闪白时长',
        typical: '0.15–0.25 秒',
        feelZh: '再长会像过曝事故、观众眨眼；再短就察觉不到，只剩一次跳帧',
      },
      {
        name: '峰值亮度',
        typical: '70%',
        feelZh: '再高会全白、丢失落点画面；再低则像普通淡入',
      },
      {
        name: '衰减曲线',
        typical: '指数衰减',
        feelZh: '线性衰减会显得假；指数衰减像真实闪光灯的余辉',
      },
    ],
    soundZh: '与闪白同帧给一记高频冲击（白噪/镲），后面 0.3 秒安静；这是全片少数值得「大声」的地方。',
    pitfallsZh: '每 3 秒闪一次白光，观众会生理不适；闪白与音频重音错开一帧，冲击力减半。',
    recipe: {
      css: '.flash{position:fixed;inset:0;background:#fff;opacity:0;animation:flash .2s ease-out}@keyframes flash{0%{opacity:.7}100%{opacity:0}}',
      ffmpeg: 'fade=t=in:st=1.0:d=0.12:color=white,fade=t=out:st=1.12:d=0.2',
    },
  },
  {
    id: 'light-emphasis.vignette-focus',
    category: 'light-emphasis',
    nameZh: '暗角聚焦',
    oneLineZh: '四周压暗，只留中心一块亮，把视线硬拉回主体。',
    useWhenZh: '信息密度高的画面、界面截图中有重点、需要「聚光灯」但不想真的打光时。',
    seconds: [1, 4],
    energy: 'low',
    tags: ['暗角', 'vignette', '聚焦', '压暗', '主体'],
    intentZh: '用亮度差做层级：没有运动也能让观众知道该看哪里。',
    motionZh: '径向渐变遮罩在 0.5 秒内从 0 加深到 45–60% 不透明度，中心保留 55–70% 亮度。',
    params: [
      {
        name: '暗角强度',
        typical: '55% 不透明度',
        feelZh: '再深会把内容压没、像坏了；再浅观众还会分心去看四周',
      },
      {
        name: '中心范围',
        typical: '画幅短边的 45%',
        feelZh: '范围越小越像聚光灯、戏剧化；越大越像常规调色暗角',
      },
      {
        name: '压暗时长',
        typical: '0.5 秒',
        feelZh: '太快像电压不稳；太慢观众会先读完四周再被拉回来',
      },
    ],
    soundZh: '通常不需要声音；如需，可加极轻的低频下潜，暗示「注意力收拢」。',
    pitfallsZh: '暗角压到正文文字导致不可读；整片都加暗角会显得「廉价电影感」。',
    recipe: {
      css: '.vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 40%,rgba(0,0,0,.6) 100%);animation:dim .5s ease both}@keyframes dim{from{opacity:0}to{opacity:1}}',
      ffmpeg: "vignette=angle=PI/4:mode=forward",
    },
  },
  {
    id: 'light-emphasis.rim-glow',
    category: 'light-emphasis',
    nameZh: '边缘辉光',
    oneLineZh: '主体边缘出现一圈细亮光，主体看起来被背后光源勾出来。',
    useWhenZh: '深色背景上的产品/人物/图标；需要「高级感」、又不想打真实灯时。',
    seconds: [0.8, 3],
    energy: 'low',
    tags: ['辉光', 'rim-light', 'glow', '边缘光', '高级感'],
    intentZh: '在低对比背景上制造一条高对比轮廓，让主体从背景里「浮」出来。',
    motionZh: '辉光从 0 到峰值 0.6 秒，随后保持；可加极轻呼吸（±10%）避免死板。',
    params: [
      {
        name: '辉光半径',
        typical: '1–2% 画幅',
        feelZh: '再大就成霓虹灯、廉价；再细看不出效果，像屏幕脏了',
      },
      {
        name: '颜色选择',
        typical: '同色系提亮一档',
        feelZh: '把颜色调成互补色会变成赛博风；调成品牌色能强化识别，但别和背景太接近',
      },
      {
        name: '呼吸幅度',
        typical: '±8%',
        feelZh: '幅度大像霓虹招牌闪烁；没有呼吸则像贴图，少了生命感',
      },
    ],
    soundZh: '一般静音；品牌片中可加一层暖垫音，音色与辉光颜色对应（暖色=中低频）。',
    pitfallsZh: '所有元素都加辉光，重点消失；辉光盖住主体细节（尤其小字）。',
    recipe: {
      css: '.subject{filter:drop-shadow(0 0 6px rgba(120,220,255,.8)) drop-shadow(0 0 18px rgba(120,220,255,.35))}',
      canvas: 'ctx.shadowColor=color;ctx.shadowBlur=18;ctx.fill();',
    },
  },

  /* ---------------------------------------------------------------- rhythm */
  {
    id: 'rhythm.beat-cut',
    category: 'rhythm',
    nameZh: '卡点硬切',
    oneLineZh: '每个重拍切一次画面，甚至一个重拍切两次（前后半拍各一刀）。',
    useWhenZh: 'music-driven 剪辑、产品快闪、节奏型 vlog；音乐本身有明确鼓点时。',
    seconds: [0.5, 2],
    energy: 'high',
    tags: ['卡点', 'beat', 'hard-cut', '音乐', '节奏'],
    intentZh: '让画面的更替成为音乐的一部分；观众会「听到」剪辑。',
    motionZh: '切点对齐鼓点（允许 -2 帧提前量），每刀的画面运动方向尽量与上一刀呼应。',
    params: [
      {
        name: '切点提前量',
        typical: '提前 1–2 帧',
        feelZh: '正好卡在帧上会显得乏力；提前一点会有「抢」的冲劲，提前太多就脱拍了',
      },
      {
        name: '镜头长度',
        typical: '1–2 个拍点',
        feelZh: '每拍都切会累、适合高能段落；两拍一刀是更可持续的节奏',
      },
      {
        name: '画面与新拍同步',
        typical: '重拍=大画面变化',
        feelZh: '重拍却只换小细节，观众会觉得没卡上；轻重音要对应变化幅度',
      },
    ],
    soundZh: '音乐本身负责节奏；不要给每刀都加打击音，会变成噪音；只在空拍处补短音。',
    pitfallsZh: '卡点卡得太密导致信息不可读；音乐被剪得不见首尾，情绪断裂。',
    recipe: {
      ffmpeg: '// 计算 BPM → 每拍秒数 60/bpm；把场景 duration 设成拍的整数倍，transitionIn:"cut"',
      css: '// 用 WebAudio 的 beatTime 驱动时间轴，而不是 setInterval',
    },
  },
  {
    id: 'rhythm.hold-snap',
    category: 'rhythm',
    nameZh: '停顿急推',
    oneLineZh: '画面先静止一拍（或缓缓移动），然后在瞬间急推/急缩。',
    useWhenZh: '揭示结论、punchline、反转；需要「安静之后炸一下」的段落。',
    seconds: [1.2, 3],
    energy: 'high',
    tags: ['停顿', '急推', 'snap', '反差', '节奏'],
    intentZh: '用动静对比制造体感落差：停顿越长，急推越有力量。',
    motionZh: '0.5–1 秒几乎静止（1–2% 缓慢漂移），随后 0.15 秒内缩放 1.25–1.6 倍，末尾硬停或轻微回弹。',
    params: [
      {
        name: '停顿长度',
        typical: '0.6–1 秒',
        feelZh: '再长会让人以为视频卡住；再短就没有对比，急推的力量出不来',
      },
      {
        name: '急推幅度',
        typical: '1.3 倍',
        feelZh: '再大画面会糊、观众失去方向；再小像普通推镜，浪费了停顿',
      },
      {
        name: '急推时长',
        typical: '0.15 秒',
        feelZh: '再慢就变成推镜头；再快会跳帧，必须配运动模糊才顺',
      },
    ],
    soundZh: '停顿段几乎静音（留底噪），急推瞬间给一记全频冲击，然后立刻收干净。',
    pitfallsZh: '停顿期间画面完全静止又没有声音，被误认成加载；每次揭示都用同一招，观众免疫。',
    recipe: {
      css: '.stage{animation:hold 1s linear both,snap .15s ease-in .9s both}@keyframes snap{to{transform:scale(1.3)}}',
      ffmpeg: "zoompan=z='if(lt(on,28),1.01,pow(1.35,min(1,(on-28)/4)))':d=40:s=1080x1920:fps=30",
    },
  },
  {
    id: 'rhythm.pulse-zoom',
    category: 'rhythm',
    nameZh: '呼吸缩放',
    oneLineZh: '画面随音乐节拍做极小幅度的呼吸式缩放（1–3%）。',
    useWhenZh: '音乐氛围段、口播强调、静态素材需要活过来；不要影响阅读时。',
    seconds: [1.5, 5],
    energy: 'medium',
    tags: ['呼吸', 'pulse', '缩放', '节拍', '氛围'],
    intentZh: '让静止画面与音乐同频，观众会感到「画面在呼吸」，但说不出发生了什么。',
    motionZh: '每次重拍缩放 1.02–1.03 倍再回 1.0，0.25 秒完成；弱拍只做 1.005。',
    params: [
      {
        name: '缩放幅度',
        typical: '2%',
        feelZh: '再大会让人注意到「画面在抽动」；再小只有潜意识效果，适合长时间停留',
      },
      {
        name: '跟随拍点',
        typical: '重拍',
        feelZh: '逐拍都呼吸会晕；只跟重拍、且每 4 拍停一拍，最像「有呼吸节奏」',
      },
      {
        name: '回弹曲线',
        typical: 'ease-in-out',
        feelZh: '线性回弹会像机械泵；带回弹更有生命力，但幅度必须小',
      },
    ],
    soundZh: '音乐已经提供节拍；不要额外加音效，否则呼吸感变成「打点器」。',
    pitfallsZh: '呼吸幅度过大导致文字边缘抖动；与卡点硬切同时使用，运动信息过载。',
    recipe: {
      css: '.stage{animation:breathe 2s ease-in-out infinite}@keyframes breathe{0%,100%{transform:scale(1)}20%{transform:scale(1.02)}}',
      ffmpeg: "zoompan=z='1+0.02*sin(2*PI*on/20)':d=200:s=1080x1920:fps=30",
    },
  },
  {
    id: 'rhythm.strobe-mask',
    category: 'rhythm',
    nameZh: '频闪遮罩',
    oneLineZh: '用 2–4 帧的明暗/颜色切换制造频闪，配合重音。',
    useWhenZh: '高能段落、电子乐、游戏/潮牌；需要「刺激」且能承受视觉冲击时。',
    seconds: [0.4, 2],
    energy: 'high',
    tags: ['频闪', 'strobe', '剪切', '高能', '重音'],
    intentZh: '用快速的明暗/内容切换直接刺激视觉，制造肾上腺素；本质上是视觉的鼓点。',
    motionZh: '每 2–4 帧切换一次亮场/暗场或 A/B 画面；只在重音附近持续 0.3–0.6 秒，之后回到正常。',
    params: [
      {
        name: '切换频率',
        typical: '每 3 帧一次',
        feelZh: '更快会接近频闪灯、有光敏风险；更慢则变成普通快切，刺激感不足',
      },
      {
        name: '持续时长',
        typical: '0.3–0.6 秒',
        feelZh: '再长会让人不适；再短只是闪一下，起不到段落标记作用',
      },
      {
        name: '明暗对比',
        typical: '两档亮度差 ≥50%',
        feelZh: '对比调小就只是画面在抖；调大对比才有「打光」的冲击',
      },
    ],
    soundZh: '频闪必须与音频重音严格同步；音效可用失真鼓点或白噪，结束后立刻收静。',
    pitfallsZh: '长时间频闪有光敏性癫痫风险，必须控制时长；与逐帧文字同时出现会完全不可读。',
    recipe: {
      css: '@keyframes strobe{0%,49%{opacity:1}50%,100%{opacity:.25}}.flash{animation:strobe .12s steps(1) 4}',
      ffmpeg: "fps=30,select='not(eq(mod(n\\,3)\\,2))',setpts=N/30/TB",
    },
  },

  /* ------------------------------------------------------------------ outro */
  {
    id: 'outro.cta-pop',
    category: 'outro',
    nameZh: '行动号召弹出',
    oneLineZh: '订阅/购买按钮带着轻微弹跳出现，旁边配一个指向它的动效。',
    useWhenZh: '视频结尾、转化点；需要观众「现在做一件事」时。',
    seconds: [1, 3],
    energy: 'high',
    tags: ['CTA', '按钮', '弹出', '转化', '结尾'],
    intentZh: '把动词变成可点击的物体：观众看到按钮弹出来的动作，会产生「可点」的直觉。',
    motionZh: '按钮 scale 0.8→1.04→1，0.35 秒；箭头从右向左点一下（0.5 秒）然后回到按钮旁。',
    params: [
      {
        name: '弹出延迟',
        typical: '文案落定后 0.3 秒',
        feelZh: '太早会抢文案注意力；太晚观众已经准备划走',
      },
      {
        name: '按钮尺寸',
        typical: '画面宽度的 30–45%',
        feelZh: '再小在手机上不好点、也不像 CTA；再大会压掉其他信息',
      },
      {
        name: '动效幅度',
        typical: '箭头位移 8–12px',
        feelZh: '太大像闹钟提醒；太小观众注意不到，等于没有引导',
      },
    ],
    soundZh: '弹出配一记干净的 UI pop，箭头点一下配一声轻 tick；不要配「订阅铃」这类陈词音效，除非风格就是复古。',
    pitfallsZh: 'CTA 出现太早，观众还没被说服；屏幕上同时出现 3 个 CTA，等于没有 CTA。',
    recipe: {
      css: '.cta{opacity:0;transform:scale(.8);animation:cta .4s cubic-bezier(.2,1.5,.4,1) .3s forwards}@keyframes cta{60%{transform:scale(1.04)}to{opacity:1;transform:scale(1)}}',
    },
  },
  {
    id: 'outro.end-card-hold',
    category: 'outro',
    nameZh: '定版停留',
    oneLineZh: '最后 1.5–3 秒画面几乎不动，只留 logo、标语和必要信息。',
    useWhenZh: '所有视频的结尾；尤其需要观众记住品牌或保存视频时。',
    seconds: [2, 6],
    energy: 'low',
    tags: ['定版', 'end-card', '停留', '结尾', '品牌'],
    intentZh: '给观众一个「可以离开」的稳定落点；运动停止=叙事结束。',
    motionZh: '前 0.4 秒完成最后 1% 的微调，之后保持静止；可加极轻的时间码式微光。',
    params: [
      {
        name: '停留时长',
        typical: '2–3 秒',
        feelZh: '再短观众看不清信息；再长会被划走，划走时记住的是「拖沓」',
      },
      {
        name: '画面信息量',
        typical: '≤3 个元素',
        feelZh: '元素越多越没重点；只留 logo+一句标语时记忆率最高',
      },
      {
        name: '最后微动',
        typical: '≤1%',
        feelZh: '完全静止像截图；把微动调到 1% 会被读成「视频还没结束」，再多就假',
      },
    ],
    soundZh: '音乐在定版前 0.5 秒开始衰减，定版时只留混响尾巴；最后 0.3 秒静音，给观众「结束」信号。',
    pitfallsZh: '定版上还放链接/二维码小字，手机端根本扫不到；停留太长导致完播率下降。',
    recipe: {
      ffmpeg: '// 最后一个场景 duration 设 2–3 秒，animation:"none"，配合音频 afade 收尾',
      css: '.end{animation:settle .4s ease-out both}@keyframes settle{from{transform:scale(1.01);opacity:.9}to{transform:none;opacity:1}}',
    },
  },
  {
    id: 'outro.logo-lockup',
    category: 'outro',
    nameZh: 'Logo 定版拼合',
    oneLineZh: '散开的元素飞回各自位置，拼成最终 logo + 标语的锁定版式。',
    useWhenZh: '品牌片收尾、系列视频统一片尾；需要「组装完成」的仪式感时。',
    seconds: [1.2, 4],
    energy: 'medium',
    tags: ['定版', 'lockup', '拼合', 'logo', '结尾'],
    intentZh: '用「拼合」重复品牌的构成逻辑，观众看完会记住各元素的空间关系。',
    motionZh: '各元素从 8–15% 偏移处用 0.5 秒 ease-out 归位，按 60ms 错峰；最后整体轻微上浮 1%。',
    params: [
      {
        name: '归位时长',
        typical: '0.5 秒',
        feelZh: '再长像加载动画；再短会看不清元素从哪来，拼合逻辑丢失',
      },
      {
        name: '错峰间隔',
        typical: '60ms',
        feelZh: '错峰形成「组装」节奏；同时归位更像整体滑入，少了机械精密感',
      },
      {
        name: '归位过冲',
        typical: '≤2%',
        feelZh: '过冲调小到 1–2% 显得有装配感；完全去掉过冲更像 UI 直接切换',
      },
    ],
    soundZh: '每个元素归位一声轻「咔」，最后一声更结实；整体像机械表装配声，比音乐更有效。',
    pitfallsZh: '归位路径互相穿插导致混乱；元素太多（>5）时拼合时间超过 1.5 秒。',
    recipe: {
      css: '.part{transition:transform .5s cubic-bezier(.2,.9,.2,1)}.part:nth-child(2){transition-delay:.06s}.part:nth-child(3){transition-delay:.12s}',
    },
  },
  {
    id: 'outro.fade-to-brand',
    category: 'outro',
    nameZh: '渐隐到品牌色',
    oneLineZh: '画面先轻微失焦，再整体渐隐到一个纯品牌色底，只留 logo 或一句标语。',
    useWhenZh: '氛围型结尾、系列片统一收尾；不想用硬定版时。',
    seconds: [0.8, 3],
    energy: 'low',
    tags: ['渐隐', 'fade', '品牌色', '收尾', '氛围'],
    intentZh: '用颜色的「收束」表达章节结束，观众的视觉从复杂回到单一，情绪自然落地。',
    motionZh: '0.6 秒内模糊 0→6px 同时透明度 1→0，露出品牌色底；logo 在 0.3 秒后以 20% 透明度浮现。',
    params: [
      {
        name: '渐隐时长',
        typical: '0.6–0.9 秒',
        feelZh: '再快像断片；再慢观众会在黑屏里等待，注意力流失',
      },
      {
        name: '模糊量',
        typical: '6px',
        feelZh: '模糊太多像信号丢失；完全没有模糊则渐变生硬',
      },
      {
        name: '残留元素',
        typical: '只有 logo',
        feelZh: '留越多越像普通淡出；只留 logo 时品牌色的「吸收感」最强',
      },
    ],
    soundZh: '音乐余响自然衰减，可加一记极轻的低频落定；不要突然静音，会显得被切断。',
    pitfallsZh: '品牌色与前面主色调冲突；渐隐后没有留定版时间，视频戛然而止。',
    recipe: {
      css: '.outro{animation:toBrand .8s ease-in forwards}@keyframes toBrand{to{opacity:0;filter:blur(6px);background:#0e2a4a}}',
      ffmpeg: 'fade=t=out:st=6.4:d=0.8',
    },
  },
  {
    id: 'outro.subscribe-sting',
    category: 'outro',
    nameZh: '订阅铃动效',
    oneLineZh: '一个铃铛/按钮图标先静止，然后被「敲」一下，抖动两下并亮起。',
    useWhenZh: 'YouTube/自媒体片尾、需要轻松口吻的提醒；品牌人格偏年轻活泼时。',
    seconds: [0.8, 2.5],
    energy: 'high',
    tags: ['订阅', '铃铛', '铃动效', '片尾', '社媒'],
    intentZh: '把「订阅」这个抽象动作变成一次敲击，观众的镜像神经元会跟着做。',
    motionZh: '静止 0.3 秒→钟摆式抖动（±12°衰减 3 次，0.5 秒）→铃铛变亮并轻微放大；旁边按钮同时高亮。',
    params: [
      {
        name: '抖动衰减',
        typical: '3 次递减',
        feelZh: '衰减次数越多越像真实铃铛；只抖一次像 UI 报错',
      },
      {
        name: '亮起延迟',
        typical: '抖动结束后 0.1 秒',
        feelZh: '太早亮会抢掉抖动的注意力；太晚观众已经移开视线',
      },
      {
        name: '振幅',
        typical: '12°',
        feelZh: '太小像卡顿；太大会变成卡通片，与严肃内容不搭',
      },
    ],
    soundZh: '一段真实的铃声采样（带混响）是最佳选择；合成「叮」容易显得廉价，加一点噪声尾更真。',
    pitfallsZh: '铃铛动效过大、时间过长，显得乞求；在严肃内容里使用会破坏基调。',
    recipe: {
      css: '@keyframes ring{0%,100%{transform:rotate(0)}20%{transform:rotate(12deg)}40%{transform:rotate(-9deg)}60%{transform:rotate(6deg)}80%{transform:rotate(-3deg)}}.bell{animation:ring .5s ease-in-out .3s}',
    },
  },
])

/** Normalise a search term list: lowercase, split on spaces/punctuation. */
function queryTerms(query) {
  if (typeof query !== 'string') return []
  return query
    .toLowerCase()
    .split(/[\s,，、/|+]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
}

/** Score one card against the query terms (deterministic, additive). */
function scoreCard(card, terms) {
  const id = card.id.toLowerCase()
  const name = card.nameZh.toLowerCase()
  const oneLine = card.oneLineZh.toLowerCase()
  const tags = card.tags.map((tag) => tag.toLowerCase())
  const haystack = [
    id,
    name,
    oneLine,
    card.useWhenZh,
    card.intentZh,
    card.motionZh,
    card.soundZh,
    card.pitfallsZh,
    ...tags,
    ...card.params.flatMap((param) => [param.name, param.typical, param.feelZh]),
  ]
    .join(' ')
    .toLowerCase()
  let score = 0
  for (const term of terms) {
    if (id === term) score += 120
    else if (id.includes(term)) score += 60
    if (name === term) score += 80
    else if (name.includes(term)) score += 40
    if (tags.some((tag) => tag === term)) score += 24
    else if (tags.some((tag) => tag.includes(term))) score += 18
    if (oneLine.includes(term)) score += 12
    if (haystack.includes(term)) score += 6
  }
  return score
}

/** Keep only valid category / energy filters; unknown values are ignored. */
function normaliseFilters(options) {
  const category = typeof options.category === 'string' ? options.category.trim() : ''
  const energy = typeof options.energy === 'string' ? options.energy.trim() : ''
  const validCategory = SHOT_CATEGORIES.some((item) => item.id === category) ? category : undefined
  const validEnergy = ['low', 'medium', 'high'].includes(energy) ? energy : undefined
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 50) : 8
  return { category: validCategory, energy: validEnergy, limit }
}

/**
 * Fuzzy-search the shot card library.
 *
 * Matching is additive and deterministic: id/name hits weigh most, then tags,
 * then free text from the prose fields. Chinese and English keywords both work
 * because every card carries bilingual tags.
 *
 * @param {string} [query]
 * @param {{category?: string, energy?: 'low'|'medium'|'high', limit?: number}} [options]
 * @returns {Array<object>} cards sorted by relevance, then id
 */
export function findShots(query, options = {}) {
  const { category, energy, limit } = normaliseFilters(options ?? {})
  let candidates = SHOT_CARDS
  if (category !== undefined) candidates = candidates.filter((card) => card.category === category)
  if (energy !== undefined) candidates = candidates.filter((card) => card.energy === energy)
  const terms = queryTerms(query)
  if (terms.length === 0) {
    return [...candidates].sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit)
  }
  const scored = candidates
    .map((card) => ({ card, score: scoreCard(card, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id))
    .slice(0, limit)
  return scored.map((item) => item.card)
}

/**
 * Look up one card by its exact id (case-insensitive).
 *
 * @param {string} id
 * @returns {object|null}
 */
export function getShot(id) {
  if (typeof id !== 'string' || id.trim().length === 0) return null
  const wanted = id.trim().toLowerCase()
  return SHOT_CARDS.find((card) => card.id.toLowerCase() === wanted) ?? null
}

/** Escape a value for a Markdown table cell. */
function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

const ENERGY_ZH = Object.freeze({ low: '低能量', medium: '中能量', high: '高能量' })

/**
 * Render one card as a Markdown block for the model / tool report.
 *
 * @param {object} card
 * @returns {string}
 */
export function renderShotCard(card) {
  if (card === null || typeof card !== 'object') throw new Error('renderShotCard(card) requires a card object')
  const category = SHOT_CATEGORIES.find((item) => item.id === card.category)
  const seconds = Array.isArray(card.seconds) ? card.seconds : [0, 0]
  const lines = []
  lines.push(`## ${card.nameZh}`)
  lines.push('')
  lines.push(
    `\`${card.id}\` · ${category?.nameZh ?? card.category} · ${ENERGY_ZH[card.energy] ?? card.energy} · 建议 ${seconds[0]}–${seconds[1]} 秒`,
  )
  lines.push('')
  lines.push(`> ${card.oneLineZh}`)
  lines.push('')
  lines.push(`**什么时候用**：${cell(card.useWhenZh)}`)
  lines.push('')
  lines.push(`**意图**：${cell(card.intentZh)}`)
  lines.push('')
  lines.push(`**运动**：${cell(card.motionZh)}`)
  lines.push('')
  lines.push(`**标签**：${(card.tags ?? []).map((tag) => `\`${tag}\``).join(' ')}`)
  lines.push('')
  lines.push('| 参数 | 典型值 | 往哪调会怎样 |')
  lines.push('|---|---|---|')
  for (const param of card.params ?? []) {
    lines.push(`| ${cell(param.name)} | ${cell(param.typical)} | ${cell(param.feelZh)} |`)
  }
  lines.push('')
  lines.push(`**声音**：${cell(card.soundZh)}`)
  lines.push('')
  lines.push(`**常见坑**：${cell(card.pitfallsZh)}`)
  lines.push('')
  lines.push('**配方**')
  lines.push('')
  const recipe = card.recipe ?? {}
  let recipes = 0
  for (const key of ['css', 'canvas', 'ffmpeg']) {
    if (typeof recipe[key] !== 'string' || recipe[key].length === 0) continue
    recipes += 1
    const language = key === 'css' ? 'css' : key === 'canvas' ? 'js' : 'ffmpeg'
    lines.push('```' + language)
    lines.push(recipe[key])
    lines.push('```')
    lines.push('')
  }
  if (recipes === 0) {
    lines.push('（该卡片没有附带代码配方）')
    lines.push('')
  }
  return lines.join('\n').trim()
}

/** Clamp and round helper for the duration budget. */
function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * Duration budget for hand-made content (whiteboard / marker / per-part colouring)
 * and for the common genres.
 *
 * Two independent questions are answered:
 *   1. "At this drawing rate, how many strokes fit in N seconds?"  -> maxStrokes
 *   2. "What length does this genre normally want?"                -> genreRange
 * `recommendedSeconds` is the caller's duration clamped into the genre window
 * (or the window midpoint when no duration was supplied).
 *
 * @param {{strokesPerSecond?: number, seconds?: number, kind?: string}} [options]
 * @returns {{
 *   kind: string|null,
 *   seconds: number|null,
 *   strokesPerSecond: number,
 *   colorStrokesPerSecond: number,
 *   maxStrokes: number|null,
 *   maxColorStrokes: number|null,
 *   genreRange: {min: number, max: number}|null,
 *   recommendedSeconds: number|null,
 *   withinGenreRange: boolean|null,
 *   adviceZh: string,
 *   warnings: string[],
 * }}
 */
export function durationBudget(options = {}) {
  const warnings = []
  const strokeRate = Number.isFinite(Number(options.strokesPerSecond)) && Number(options.strokesPerSecond) > 0
    ? Number(options.strokesPerSecond)
    : DEFAULT_SKETCH_STROKES_PER_SECOND
  const colorRate = DEFAULT_COLOR_STROKES_PER_SECOND
  const secondsGiven = Number.isFinite(Number(options.seconds)) ? Number(options.seconds) : null
  const seconds = secondsGiven !== null && secondsGiven > 0 ? round2(secondsGiven) : null
  if (secondsGiven !== null && seconds === null) {
    warnings.push(`seconds=${JSON.stringify(options.seconds)} 不是正数，已按「未提供时长」处理`)
  }
  const kind = typeof options.kind === 'string' && options.kind.trim().length > 0
    ? options.kind.trim().toLowerCase()
    : null
  const range = kind !== null ? GENRE_DURATION_RANGES[kind] ?? null : null
  if (kind !== null && range === null) {
    warnings.push(`未知体裁 "${kind}"；可用体裁：${Object.keys(GENRE_DURATION_RANGES).join('/')}`)
  }

  // +1e-9 avoids the classic 10 * 3.9 = 38.999… floor to 38 surprise.
  const maxStrokes = seconds !== null ? Math.floor(seconds * strokeRate + 1e-9) : null
  const maxColorStrokes = seconds !== null ? Math.floor(seconds * colorRate + 1e-9) : null
  const genreRange = range !== null ? { min: range[0], max: range[1] } : null
  const recommendedSeconds = range !== null
    ? seconds !== null
      ? round2(clampNumber(seconds, range[0], range[1]))
      : round2((range[0] + range[1]) / 2)
    : seconds
  const withinGenreRange = range !== null && seconds !== null
    ? seconds >= range[0] && seconds <= range[1]
    : null

  const adviceParts = []
  if (seconds !== null) {
    adviceParts.push(`按 ${round2(strokeRate)} 笔/秒，${seconds} 秒最多画 ${maxStrokes} 笔（起形+马克笔）；按部位上色按 ${colorRate} 笔/秒可上 ${maxColorStrokes} 笔。`)
  } else {
    adviceParts.push(`没有提供时长：起形+马克笔按 ${round2(strokeRate)} 笔/秒估算，按部位上色按 ${colorRate} 笔/秒估算。`)
  }
  if (genreRange !== null) {
    adviceParts.push(`体裁 ${kind} 的常见时长是 ${genreRange.min}–${genreRange.max} 秒。`)
    if (withinGenreRange === false && seconds !== null) {
      adviceParts.push(seconds > genreRange.max
        ? `当前 ${seconds} 秒偏长，建议压到 ${genreRange.max} 秒以内，否则观众会在中段流失。`
        : `当前 ${seconds} 秒偏短，建议至少 ${genreRange.min} 秒，否则信息来不及展开。`)
    } else if (withinGenreRange === true) {
      adviceParts.push('当前时长落在该体裁的舒适区。')
    }
  } else if (kind === null) {
    adviceParts.push('未指定体裁，未给出体裁时长建议。')
  }
  return {
    kind,
    seconds,
    strokesPerSecond: round2(strokeRate),
    colorStrokesPerSecond: colorRate,
    maxStrokes,
    maxColorStrokes,
    genreRange,
    recommendedSeconds,
    withinGenreRange,
    adviceZh: adviceParts.join(''),
    warnings,
  }
}

export default {
  SHOT_CATEGORIES,
  SHOT_CARDS,
  GENRE_DURATION_RANGES,
  DEFAULT_SKETCH_STROKES_PER_SECOND,
  DEFAULT_COLOR_STROKES_PER_SECOND,
  findShots,
  getShot,
  renderShotCard,
  durationBudget,
}
