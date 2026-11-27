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
 *
 * Attribution: the first 44 cards are original writing based on common
 * motion-design practice. The other 124 cards are derived from the
 * video-shotcraft recipe library (Vincentwei1021/video-shotcraft, Apache-2.0,
 * pinned commit 1266a3e, introduced via dsh-drawai): their vocabulary breadth,
 * tuning parameters in `params[].typical` and the known-pitfall content are kept
 * faithful to upstream, while every Chinese sentence, the tag sets, the schema
 * mapping and the code recipes are rewritten for this repository. See
 * THIRD-PARTY.md for the license notice.
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
 * The card library: 44 hand-written cards plus 124 cards derived from the Apache-2.0
 * video-shotcraft library (see `test/_research/shots/` and THIRD-PARTY.md).
 * Upstream tuning parameters and known pitfalls are preserved; all Chinese copy,
 * tags, schema mapping and code recipes are written for this repository.
 * Search by Chinese or English keyword via `findShots`.
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
  // 3D 空间卡片巡游（上游  → camera）
  {
    id: "basic-3d-scene",
    category: "camera",
    nameZh: "3D 空间卡片巡游",
    oneLineZh: "卡片带着各自的位置与旋转散布在 3D 空间里，相机逐站取卡片姿态的逆变换飞行对齐，末站拉到总览。",
    useWhenZh: "概念、路线图、三步法的空间化讲述；需要让「每一步」换一个空间视角而不是换一页时。",
    seconds: [5.4, 9.6],
    energy: "medium",
    tags: ["camera","运镜","basic","scene","3D 空间卡片巡游"],
    intentZh: "把翻页变成在想法空间里旅行：每站的空间姿态变化本身就是「进入新章节」的仪式感。",
    motionZh: "每站只写卡片的 pose，相机按 scale/rotate/translate 的逆变换飞行对齐，三段飞行 28–32f；站间额外拉远 30% 露出空间里的其他卡，末站 1/2.7 拉到总览。",
    params: [
      { name: "站点姿态", typical: "每站至少一个新变换维度", feelZh: "只挪 x/y 是平移幻灯片；rz 站（画框旋转）是记忆点，一支片用一次；再往大或往小调都会改变手感" },
      { name: "飞行时长", typical: "28–32f", feelZh: "有旋转的段别短于 28f，观众需要时间理解\"世界在转\"" },
      { name: "停留时长", typical: "≥30f", feelZh: "读卡位；卡内文字多时优先加停留而不是减飞行" },
      { name: "hop 拉远", typical: "30%", feelZh: "调大或调小：0 = 贴着卡面平移，看不到空间；>50% 每段都像总览；再往大或往小调都会改变手感" },
      { name: "OVERVIEW 缩放", typical: "s=2.7", feelZh: "值越大总览越\"高空\"；先定总览海报构图，再反解各站世界坐标" },
      { name: "聚焦衰减", typical: "opacity 0.22 底 + blur 7px 峰", feelZh: "底值别低于 0.2——离焦卡要\"在场\"，纯黑会丢空间感" },
      { name: "perspective", typical: "2600px", feelZh: "手感：2600px 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "运镜段铺一条连续 whoosh，速度越快声像位移越大；落定时收干净，不要有尾巴。音效密度与画面节拍一致即可。",
    pitfallsZh: "逆变换的旋转顺序（Z→Y→X 反着正变换的 X→Y→Z）不能乱——乱序在单轴旋转时看不出来，多轴复合站会歪；卡片 pose 写在卡自身 transform 和相机公式两处消费，加站只改 POSES 表，两处 transform 字符串别动；rz90° 站的卡内文字会跟着躺倒，相机转正后才可读——这是设计（转正瞬间\"啊看懂了\"），但该站文案要短；落版挂在世界里时，最后一段飞行中它是斜的：显影要晚（飞行过半再淡入），逐字揭示等落位前 6f 再开始；OVERVIEW 后无返程，作段落收尾用；要循环回 STEP01 就在末尾加一段 fly back（cam 再 lerp 回 POSES[0]）",
    recipe: {
      canvas: "// 6s 镜头机动：每帧算出 p 后套同一条缓动，再乘在这个容器上\nconst p = easeInOut((t % 6) / 6);\nctx.setTransform(1 + 28 * 0.001 * p, 0, 0, 1 + 28 * 0.001 * p, -28 * p, 0);",
    },
  },
  // 急推冲击（上游  → camera）
  {
    id: "crash-zoom-punch",
    category: "camera",
    nameZh: "急推冲击",
    oneLineZh: "全景在一拍之内砸到目标特写，落位可选弹性回弹或撞停震屏。",
    useWhenZh: "功能段的「点名」镜头：把视线按到目标卡或目标模块上；强调级用撞停款。",
    seconds: [0.36, 0.64],
    energy: "high",
    tags: ["camera","运镜","effects","crash","zoom","punch"],
    intentZh: "慢推是「请看」，急推是「看这个！」——一拍之内不给视线任何选择余地。",
    motionZh: "6f ease-in 急推（zoom 1→2.6）并同步把中心收到目标点；回弹款过冲后 5f 回收 3–6%，撞停款在到位帧起以 14px 振幅、τ≈1.8f 指数衰减震屏。",
    params: [
      { name: "急推时长", typical: "6f（4–8f）", feelZh: ">10f 读作普通推近，冲击感消失；再往大或往小调都会改变手感" },
      { name: "目标 zoom", typical: "2.4–2.8", feelZh: "终点构图以目标卡占画面 60–75% 为准；再往大或往小调都会改变手感" },
      { name: "回弹幅度", typical: "zoom 的 3–6%", feelZh: "手感：zoom 的 3–6% 只是起点，再往大或往小调都会改变节奏与力度" },
      { name: "震屏包络", typical: "14px·e^(−t/1.8)", feelZh: "幅度须过肉眼阈值（可感性判例），>20px 读作故障；再往大或往小调都会改变手感" },
    ],
    soundZh: "运镜段铺一条连续 whoosh，速度越快声像位移越大；落定时收干净，不要有尾巴。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "终点必须是高清纹理槽位（card4-hires 级）——急推后全程特写它， 低倍截图糊字（Q2）；终点先按 Q2 的高分辨率栅格化技法处理；两款别混用：回弹后再震屏读作穿帮；一支片急推 ≤2 次（P4 手法去重精神）；参数经占位素材调校转正，非实战定稿，首次实战后回验",
    recipe: {
      canvas: "// 0.5s 镜头机动：每帧算出 p 后套同一条缓动，再乘在这个容器上\nconst p = easeInOut((t % 0.5) / 0.5);\nctx.setTransform(1 + 6 * 0.001 * p, 0, 0, 1 + 6 * 0.001 * p, -6 * p, 0);",
    },
  },
  // 光标导览巡游（上游  → camera）
  {
    id: "cursor-flyover",
    category: "camera",
    nameZh: "光标导览巡游",
    oneLineZh: "整页俯瞰后相机依次飞到四个功能区特写，SVG 光标先一步到位指点并点击触发响应。",
    useWhenZh: "单页产品的功能巡览：一镜带观众看完多个功能区，省掉四段剪辑时。",
    seconds: [5.76, 10.24],
    energy: "medium",
    tags: ["camera","运镜","cursor","flyover","光标导览巡游"],
    intentZh: "一个连续相机把功能角串成参观动线，光标当观众的注意力代理——它点到哪观众就看哪。",
    motionZh: "相机查表步进：俯瞰 s=0.66 → 四个模块特写 s=1.3，x/y/s 三通道用不对称 in-out；光标领先 2f，点击缩到 0.84 回弹并留下涟漪。",
    params: [
      { name: "特写倍率", typical: "s=1.3（俯瞰 0.66）", feelZh: "世界原生排版，倍率按\"要读的字 ≥40px 屏幕字高\"反推，>1.6 时模块出画" },
      { name: "步进节奏", typical: "飞行 20f / 停留 24f", feelZh: "停留是读功能位，短于 15f 变\"扫过\"没有\"参观\"" },
      { name: "光标领先", typical: "起步早 2f、到位早 6f", feelZh: "调大或调小：0 = 光标被相机拖着走（像录屏）；>10f 观众先看光标再找画面" },
      { name: "点击涟漪", typical: "18f，scale 0.3→1.5", feelZh: "涟漪是节拍器，四次点击等距（每 44f）——配 SFX click 四连；再往大或往小调都会改变手感" },
      { name: "巡览顺序", typical: "左上→右上→右下→左下", feelZh: "改 CAMS / TARGETS 表即换路线；保持相邻模块相邻访问，对角跳跃会晕；再往大或往小调都会改变手感" },
      { name: "收尾拉回", typical: "smooth 24f 回俯瞰", feelZh: "不拉回就停在最后一个模块；拉回让四处状态同框成海报；再往大或往小调都会改变手感" },
    ],
    soundZh: "运镜段铺一条连续 whoosh，速度越快声像位移越大；落定时收干净，不要有尾巴。音效密度与画面节拍一致即可。",
    pitfallsZh: "用真实产品截图时，TARGETS 落点要重新标到截图里控件的中心；截图要 ≥1.3 倍特写倍率的原生分辨率（Q2）；相机表的 x/y 是世界 px 坐标，世界画布宽高比变了（如换竖屏）需整表重标；光标与相机已解耦（各自一张表），但两者的起步/到位帧差要成对改，否则点击时相机还在动、界面响应会被运动模糊吃掉；运动模糊别给太多：亮场 UI 在 hop 末段仍高速时，amount > 0.12 会读作\"失焦\"而不是\"运动\"",
    recipe: {
      canvas: "// 6s 镜头机动：每帧算出 p 后套同一条缓动，再乘在这个容器上\nconst p = easeInOut((t % 6) / 6);\nctx.setTransform(1 + 1.3 * 0.001 * p, 0, 0, 1 + 1.3 * 0.001 * p, -1.3 * p, 0);",
    },
  },
  // 分层视差滑轨（上游  → camera）
  {
    id: "depth-layer-moves",
    category: "camera",
    nameZh: "分层视差滑轨",
    oneLineZh: "同一条横移位移乘三层速度系数带出纵深，滑轨落定时主角从层里浮起。",
    useWhenZh: "平面截图要「有厚度」的段落：卡组、列表、整页的横向巡览。",
    seconds: [3.96, 7.04],
    energy: "medium",
    tags: ["camera","运镜","depth","layer","moves","分层视差滑轨"],
    intentZh: "整页平移是「看页面」，分层视差是「在页面的空间里」——多平面摄影机原理把截图变成有深度的场景。",
    motionZh: "远景整页 0.35x、中景卡组 0.7x、近景浮块 1.4x 共用一条 drive；不对称 in-out 130f 落地，主角浮起 elevation 6→26、放大约 3.5%，滞后位置收敛约 8f。",
    params: [
      { name: "视差层系数", typical: "0.35 / 0.7 / 1.4（+ 0x 字层）", feelZh: "梯度 ≥2 倍层间才可辨；层数 ≤4 防过载；再往大或往小调都会改变手感" },
      { name: "层次锚", typical: "前后景 blur + 背景降饱和 + 空气薄雾", feelZh: "没有 blur/饱和锚，读作\"贴片乱飞\"；再往大或往小调都会改变手感" },
      { name: "滑轨终点", typical: "drive 反算到主角居中", feelZh: "没终点的匀速横移读作屏保；落定后给主角一拍浮起；再往大或往小调都会改变手感" },
    ],
    soundZh: "运镜段铺一条连续 whoosh，速度越快声像位移越大；落定时收干净，不要有尾巴。音效密度与画面节拍一致即可。",
    pitfallsZh: "主阅读层必须高清纹理且无 blur——观众在读它；整层全屏实时 filter: blur() 每帧变化很贵（实测可差 3 倍以上渲染时长）：模糊挂在层内的小元素上，别挂在铺满画面的层容器上；视差与 PageCam rot 3D 的组合（斜拍视差）未验证，实战先渲 still 确认；参数经占位素材调校转正，非实战定稿，首次实战后回验",
    recipe: {
      canvas: "// 5.5s 镜头机动：每帧算出 p 后套同一条缓动，再乘在这个容器上\nconst p = easeInOut((t % 5.5) / 5.5);\nctx.setTransform(1 + 0.35 * 0.001 * p, 0, 0, 1 + 0.35 * 0.001 * p, -0.35 * p, 0);",
    },
  },
  // 贴面地景巡游（上游  → camera）
  {
    id: "graze-face-tour",
    category: "camera",
    nameZh: "贴面地景巡游",
    oneLineZh: "大倾角镜头贴着 UI 表面低飞，文字悬在界面上空投下软影，随镜头经过先后加速贴落。",
    useWhenZh: "功能区巡礼（把 UI 当地景飞掠）、暗场霓虹的产品「内部世界」段落。",
    seconds: [3.6, 6.4],
    energy: "high",
    tags: ["camera","运镜","ui-entrance","graze","face","tour"],
    intentZh: "把 UI 拍成地形，戏眼是文字空中贴落——观众看见界面在镜头经过时「完成自己」。",
    motionZh: "perspective 加 rotateX/rotateY 大倾角推进，浅景深让远处渐糊；元素先抬高 120–180px，同形软影随高度收敛，按镜头行进方向错峰贴落。",
    params: [
      { name: "悬浮高度", typical: "120–180px", feelZh: "<80px 影子和位移都读不出；>250px 落地砸得太重" },
      { name: "影子参数", typical: "blur/offset/opacity 随高度线性收敛", feelZh: "影子恒定不随高度变＝贴纸感；落地影必须归零" },
      { name: "贴落错峰", typical: "按镜头行进方向 0.2→0.85 归一化排布", feelZh: "同帧齐落读作开关；乱序落读作 bug；错峰=错开起点但下落过程重叠并行，串行等待（一个落完另一个才开始）被裁" },
      { name: "下落曲线", typical: "easeFall 加速+软着陆", feelZh: "ease-out 下落读作气球飘落，重力感靠加速" },
      { name: "段间接力", typical: "相邻段交叉淡化 ≥8f", feelZh: "透明度窗口不搭接会黑闪（返工判例 f100 纯黑帧）；再往大或往小调都会改变手感" },
      { name: "景深", typical: "远处 blur 渐强", feelZh: "全清晰读作平面滚动，浅景深才有\"贴面\"体感" },
    ],
    soundZh: "运镜段铺一条连续 whoosh，速度越快声像位移越大；落定时收干净，不要有尾巴。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；悬空元素别被环境压黑带吞掉：空中元素 需追光/提亮 ~1.3x，否则悬浮状态不可感等于没做；与 space-camera-moves/tension-camera-moves 分工：那两张是相机 语言本身；本卡=贴面机位 + 元素贴落 的组合签名，缺一半就 改用相机卡；贴落节奏语义判例（与 neon-frame-orbit-drop 互为反例）： 本卡巡礼镜=错峰并行；整体登场镜必须全体同帧齐落（那张卡的 错峰版被裁）。选错语法两边都会被裁；原片（clickup-30）是一条连续上行长镜；复刻用三段接力，段落 切换藏在交叉淡化里——实战若做真单长镜，路径规划成本高得多",
    recipe: {
      canvas: "// 5s 镜头机动：每帧算出 p 后套同一条缓动，再乘在这个容器上\nconst p = easeInOut((t % 5) / 5);\nctx.setTransform(1 + 120 * 0.001 * p, 0, 0, 1 + 120 * 0.001 * p, -120 * p, 0);",
    },
  },
  // 俯拍揭示两式（上游  → camera）
  {
    id: "overhead-camera-moves",
    category: "camera",
    nameZh: "俯拍揭示两式",
    oneLineZh: "用俯仰角讲故事：整页平躺后抬正揭示，或桌面卡阵横滑巡视后俯冲扎入。",
    useWhenZh: "俯拍开场或转场：单页 establishing 用 A，多页巡视后择一扎入用 B。",
    seconds: [4, 4.7],
    energy: "medium",
    tags: ["camera","运镜","opening","transition","overhead","moves"],
    intentZh: "让俯仰角本身承担叙事：A 是掀开图纸的揭示，B 是「巡视一圈，就选这张」。",
    motionZh: "A 整页绕下沿 rotateX 86°→0° 抬正（过冲 −2.2° 再软回），角度/缩放/透视共用一条进度；B 卡阵平躺 62° 只横移巡视，58–86f 角度/缩放/位移三通道同跑俯冲落版。",
    params: [
      { name: "A 俯角", typical: "rotateX 86°（f0–20 极缓 creep 到 83°）→ −2.2°（f60，速度归零）→ 0°（f70），主段 EASE.swift 不对称 in-out、过冲回落 smooth，transformOrigin 50% 100%（下沿铰链）", feelZh: "首版 −55° 太弱：f0 仍见半页，无\"窄带\"悬念（实渲判例）；视点低于页面平面会看到背面（窄带里的字上下颠倒，实渲判例）——视点要在页面上方；分段各用 out-cubic 会在接缝处速度突变" },
      { name: "A 联动", typical: "perspective 700→1500、视点 y 从铰链上方 300px → 画面中心；scale 2.5→0.84（落定留边看见舞台）、铰链 y 600→935；背景光池与浮尘反向视差下移 150px", feelZh: "perspective 不联动则俯角初始见不到\"只露一条\"；背景不视差读作页面在转、不是相机抬头；再往大或往小调都会改变手感" },
      { name: "A 收尾", typical: "机位 f70 落定；38–82 面积图折线描出、80f 终点光点亮起；70–120 极缓推近 1→1.018", feelZh: "过冲幅度 ≤3°，再大读作弹簧不是机位；69f 纯静止太长（> 1s 死帧），hold 段要有极缓推近" },
      { name: "B pan 段", typical: "0–50f 只改 translateX +760→−360（smooth），角度不动；50–58 停 8f 选定（目标稿离桌 16px、它的顶灯亮、另两盏暗到 35%）", feelZh: "pan 段动角度 = 两段职责糊掉（判例：pan 巡视、drop 表态）；没有选定那一拍，扎入读作随机；再往大或往小调都会改变手感" },
      { name: "B drop 段", typical: "58–86f 三通道同跑：rotateX 62→−1.6→0.5→0（零速起步的不对称曲线 + smooth 回落过冲）、scale 1→2.04→2.0（起步带 ~5% 预备回缩）、translateX −360→0", feelZh: "三通道必须同跑；分先后读作两个动作；pan 静止后直接 out-cubic 起跳是速度突变；再往大或往小调都会改变手感" },
      { name: "B 卡阵", typical: "卡片 996×560（16:9 精确比），落版 scale 2.0 恰满屏正视；transform 顺序 translateX→rotateX→scale", feelZh: "顺序错了 pan 会带出弧线轨迹；再往大或往小调都会改变手感" },
      { name: "B 地板", typical: "深石墨台面 + 发丝网格 + 每张稿一盏顶灯光池/体积光束 + 稿下印刷标签（01 SHOTS…）", feelZh: "无地板参照，横滑段读不出\"相机在动\"；暗桌白稿的反差就是层次" },
      { name: "B 收尾", typical: "机位 f94 落版；98–118 页面内金色镜头块滑入分镜板空槽（一次过冲）；94–140 极缓推近 1→1.012", feelZh: "落版后完全静止 47f 偏死；页面内给一个小动作收尾" },
    ],
    soundZh: "运镜段铺一条连续 whoosh，速度越快声像位移越大；落定时收干净，不要有尾巴。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；大角度透视下卡片必须 backfaceVisibility hidden + translateZ(4px) 兜底，否则个别帧背面/深度穿帮；A 与 crane-rise-reveal 同片二选一——都是开场揭示，两个\"揭示开场\" 等于没有揭示；B pan 段角度锁死是命门（两段职责分离判例）：巡视归巡视、扎入归 扎入，混着动观众不知道相机想干嘛；两式都是\"相机大动作\"，与 space-camera/crane-rise 同屏段落互斥， 一个段落只能有一个持镜人",
    recipe: {
      canvas: "// 4.35s 镜头机动：每帧算出 p 后套同一条缓动，再乘在这个容器上\nconst p = easeInOut((t % 4.35) / 4.35);\nctx.setTransform(1 + 86 * 0.001 * p, 0, 0, 1 + 86 * 0.001 * p, -86 * p, 0);",
    },
  },
  // 3D 实体运镜两式（上游  → camera）
  {
    id: "space-camera-moves",
    category: "camera",
    nameZh: "3D 实体运镜两式",
    oneLineZh: "把整页当成 3D 实体：构件沿法线爆炸分解再合体，或无人机式俯冲降落到主角。",
    useWhenZh: "把平面页面当 3D 实体拍的高光段落；两式都是大动作，一支片合计不超过 2 次。",
    seconds: [3.5, 5.7],
    energy: "high",
    tags: ["camera","运镜","space","moves","3D 实体运镜两式"],
    intentZh: "A 说「看看它由什么组成」，C 说「从全局俯瞰砸到主角」——两式各占一格叙事语义。",
    motionZh: "A 整页 3/4 轴测平躺，构件沿页面法线错峰炸开悬停、一拍后逆序合体收口；C 近垂直俯角悬停→猛扎俯冲→气垫减速停在 hero 特写。",
    params: [
      { name: "A 空间基座", typical: "perspective 2400 + translate·scale·rotateX(54°)·rotateZ(−34°) 轴测 + preserve-3d；炸开时机位拉远 0.56→0.47 并下移给层堆留画面；悬停期环绕 rotateZ +10°、俯角收 4°", feelZh: "正面微倾（18°/−12°）只读作\"浮起\"，轴测平躺才像爆炸图；悬停环绕让层间视差读出深度" },
      { name: "A 炸开", typical: "5 层 translateZ 150/270/400/520/640，弹簧（damping 15、stiffness 120）错峰 5f", feelZh: "页面上越靠远端（顶部）的层要越高，否则低处的层升起后挡住上方层；深度全同读作整页浮起" },
      { name: "A 合体", typical: "标注先撤（ease-in 8f），层逆序 ease-in 14f、错峰 3f；落座帧整组下沉 8px 阻尼回弹 + 台面接触影一紧，随后一道扫光掠过整页", feelZh: "落锤必须有——没有它合体读作软趴趴的淡入；但不用抖屏（Q3），下沉回弹 + 影子收紧同样有\"咔\"；再往大或往小调都会改变手感" },
      { name: "A 深度锚", typical: "各层投到底板的影随高度下移变虚变淡 + 每层背后一片厚度边 + 底板露出构件虚线插槽", feelZh: "三个线索缺一层间关系就糊；再往大或往小调都会改变手感" },
      { name: "A 标注", typical: "锚点 = 层外缘中点的 3D 投影（与 CSS 同一套矩阵手算），左右两栏、水平引线到栏前一折；标题 44px + 说明 30px，描线 8f + 升起 12f，错峰 6f", feelZh: "引线从层中间拉出会穿过别的层；标注字 <32px 读不清；再往大或往小调都会改变手感" },
      { name: "C 行程", typical: "同一条 p 驱动 rotateX 72°→0 + scale 0.42→1.35 + translate 收拢；origin 钉死 hero 卡中心（如 518,335）；页面按终点倍率 1.35 布局 + CSS zoom 栅格化再缩回，特写文字不糊", feelZh: "一条 p = 一台相机一次机动；分开驱动读作三个动画打架；再往大或往小调都会改变手感" },
      { name: "C 速度曲线", typical: "0–24f 上帝视角建立 + 上提预备（行程倒退 2.5%）→ 主俯冲 25f Easing.in(cubic) 吃 82% 行程 → 气垫 20f Easing.out(poly(5)) 走 18% → 落定 hold 36f", feelZh: "切换帧速度骤降 = 气垫顶住的体感；82/18 比例比帧数更关键" },
      { name: "C 氛围", typical: "场景包 CameraMotionBlur(shutterAngle 220, samples 12)，背景与颗粒放在模糊之外；页面悬停在同一 3D 世界的点阵地面上方（起始 lift 150），俯冲时点阵向镜头涌来；地面同形接触影随降落收紧变实、触地前淡到 0；落定后 hero 外一圈轻压暗收焦", feelZh: "软影卖\"悬空高度\"；blur 卖速度，缺一维就假；大面积渐变放进多重采样会量化出色环，背景留在模糊外" },
    ],
    soundZh: "运镜段铺一条连续 whoosh，速度越快声像位移越大；落定时收干净，不要有尾巴。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；两式都吃真实截图分层/高清纹理：A 需页面按构件切块截图（顶栏/侧栏/ 卡各自独立成图，整页一张图炸不开）；C 终点是特写，素材先按 审美准则 Q2 的高分辨率栅格化技法处理；C 式易错：Remotion 无 Easing.quint，写 Easing.poly(5)（本批实渲踩坑）；A 式构件布局要绝对定位复刻原页面网格（demo 里 5 层：侧栏/图表/助手/指标/命令栏）， 流式布局做不了 per-构件 translateZ",
    recipe: {
      canvas: "// 4.6s 镜头机动：每帧算出 p 后套同一条缓动，再乘在这个容器上\nconst p = easeInOut((t % 4.6) / 4.6);\nctx.setTransform(1 + 2400 * 0.001 * p, 0, 0, 1 + 2400 * 0.001 * p, -2400 * p, 0);",
    },
  },
  // 斜墙侧掠（上游  → camera）
  {
    id: "steep-tilt-glide",
    category: "camera",
    nameZh: "斜墙侧掠",
    oneLineZh: "镜头钉死不动，页面以 60° 强透视侧立并沿自身平面滑移掠过，带三层速度重影。",
    useWhenZh: "长页面、多区块 UI 的炫技巡览；暗场霓虹调性；与贴面运镜互补的「侧掠」机位。",
    seconds: [2.88, 5.12],
    energy: "high",
    tags: ["camera","运镜","ui-entrance","steep","tilt","glide"],
    intentZh: "命门是物动镜不动：镜头一动就沦为运镜炫技，这里的戏是「页面在自我展示」。",
    motionZh: "perspective 1100、rotateY −60° 全程不变，超宽页面局部 translateX +60→−4100，近匀速且尾段斜率不归零；拖尾重影取过去 1.6/3.2/4.8 帧位置，元素悬空 230–280px 错峰贴落。",
    params: [
      { name: "倾斜角", typical: "rotateY -60°（用户精确定值）", feelZh: "-45° 被裁\"角度不对\"、-53°\"再大一点\"；>-70° 内容读不清" },
      { name: "运动模型", typical: "镜头全常数、页面自移", feelZh: "命门——镜头横移版被裁\"镜头是固定的，页面本身往其3d空间的横面方向移动\"；再往大或往小调都会改变手感" },
      { name: "滑移曲线", typical: "尾段斜率不归零的 bezier", feelZh: "中途停死被抓（v4 返工）；全 linear 少了起步呼吸" },
      { name: "重影", typical: "透明度∝速度，三层 f-1.6/-3.2/-4.8", feelZh: "恒定重影读作重像故障" },
      { name: "页面宽度", typical: "≥3 屏内容", feelZh: "太窄滑两秒就完，撑不起一镜" },
      { name: "悬空贴落", typical: "错峰（巡礼语法）+ 影随高度", feelZh: "语义判例见 graze-face-tour/orbit-drop 三卡族；再往大或往小调都会改变手感" },
    ],
    soundZh: "运镜段铺一条连续 whoosh，速度越快声像位移越大；落定时收干净，不要有尾巴。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；角度判例：透视角是本卡身份，实战微调范围建议 55–65°，出这个 区间等于换手法；与 graze-face-tour 分工：那张镜头动（贴面游走）、页面静；本卡 镜头静、页面动。同段落二选一；超宽页面手绘成本高；实战可用真实长截图代替（滑移逻辑不变）",
    recipe: {
      canvas: "// 4s 镜头机动：每帧算出 p 后套同一条缓动，再乘在这个容器上\nconst p = easeInOut((t % 4) / 4);\nctx.setTransform(1 + 60 * 0.001 * p, 0, 0, 1 + 60 * 0.001 * p, -60 * p, 0);",
    },
  },
  // 情绪运镜两式（上游  → camera）
  {
    id: "tension-camera-moves",
    category: "camera",
    nameZh: "情绪运镜两式",
    oneLineZh: "动作小、情绪重：冻住时间让相机绕行审视，或后拉让周围逐层熄灭只剩一点。",
    useWhenZh: "情绪节点（震撼或收束）的运镜语言；与炫技大动作互补。",
    seconds: [4.32, 7.68],
    energy: "high",
    tags: ["camera","运镜","tension","moves","情绪运镜两式"],
    intentZh: "相机替观众去「感受」而不是「看」：A 说这一刻值得停表，B 说最后只剩这一件事。",
    motionZh: "A 冻结图表生长与柱顶火花，相机在真 3D 场景里绕面板 rotateY 扫 52° 再回，时间恢复后继续长完；B 从发光主卡特写后拉，8 张兄弟卡按距离错峰熄灭、背景沉黑。",
    params: [
      { name: "A 双时钟", typical: "内容动画吃 eff（速度坡道积分：8f smooth 刹停 → 冻结 52f → 8f 恢复），相机吃真实 f", feelZh: "命门：冻结期内容必须肉眼可见地完全静止，相机却在动——两个时钟各管各的；硬停硬起没有子弹时间的变速感；再往大或往小调都会改变手感" },
      { name: "A 环绕", typical: "perspective 1800 的 preserve-3d 场景（面板 / 带 z 深度的火花 / 网格地面 / 远处点阵墙）：rotateY 0→-52°（26f smooth）→ 顶点慢漂 12f → 回 0（22f swift），同步 rotateX 抬 6°、推近 160px", feelZh: "调大或调小：50–55° 是\"绕到侧面看\"的下限；>70° 面板变纸片穿帮；没有深度参照物（单面板 + 纯色底）读不出是相机在绕" },
      { name: "A 冻住的运动", typical: "火花拖尾长度、计数器滚动模糊都按内容时钟的速度算", feelZh: "冻结时它们保持\"运动中\"的形态——冻住的是瞬间，不是静物；再往大或往小调都会改变手感" },
      { name: "B 后拉", typical: "scale 2.2→0.62 / 110f Easing.out(cubic)，origin 锁主卡中心，按 2.2× CSS zoom 布局再缩小", feelZh: "前 20f 主卡仍占满画面，开场即特写不需要另加 hold；transform 放大的特写字会糊（Q2）" },
      { name: "B 熄灭", typical: "兄弟卡按 hypot 距离排序，帧 30 起每 8f 一张，16f 内 opacity→0（EASE.out）+ brightness→0.3 + 失焦 5px + 下沉 0.97；背景 60–110f 从亮柔光底交叉沉入带色相深场", feelZh: "由近到远熄灭 = \"世界向外塌暗\"；乱序熄灭读作故障" },
      { name: "B 光晕", typical: "主卡两层冷白 box-shadow 60–100f 淡入，受光上沿同步浮现", feelZh: "光晕是\"只剩它\"的视觉证词，与沉黑同步才成立；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "两式动作完毕 hold ≥30f（A 只留光的极缓呼吸；B 110–150f 真静止）", feelZh: "R1；B 式是全片句号，静止给足 40f+，可在屏幕空间加一句结语" },
    ],
    soundZh: "运镜段铺一条连续 whoosh，速度越快声像位移越大；落定时收干净，不要有尾巴。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；A 式与 speed-ramp-freeze/impact-feedback 同为时间操纵，同一镜头别叠用 （帧 remap 互相打架）；A 的冻结是\"停给你看\"+相机动，speed-ramp-freeze 的 定格是\"停下来标注\"——选语义不选形似；B 式放结尾时后接 outro-group-photo-launch 会打架（一收一放），二选一",
    recipe: {
      canvas: "// 6s 镜头机动：每帧算出 p 后套同一条缓动，再乘在这个容器上\nconst p = easeInOut((t % 6) / 6);\nctx.setTransform(1 + 8 * 0.001 * p, 0, 0, 1 + 8 * 0.001 * p, -8 * p, 0);",
    },
  },
  // 终端空间三站（上游  → camera）
  {
    id: "terminal-3d",
    category: "camera",
    nameZh: "终端空间三站",
    oneLineZh: "三个终端窗散布在 3D 空间，相机窗间飞行，每到一窗打字敲命令、结果逐行滑出。",
    useWhenZh: "开发者产品的 CLI 或工作流演示：把「三步命令」拍成三站空间旅程。",
    seconds: [3, 8.2],
    energy: "medium",
    tags: ["camera","运镜","terminal","终端空间三站"],
    intentZh: "把天生平面的终端输出空间化：每条命令占一个实体窗口，相机像穿过机房一样逐窗拜访。",
    motionZh: "每窗写 pose，相机按逆变换飞行，两段 30f 飞行途中 sin 鼓包拉远 1250px 让三窗同框；落定 1:1 栅格化避免文字发糊，打字与输出按站推进。",
    params: [
      { name: "拉远鼓包", typical: "sin(π·u^0.85)×1250px", feelZh: "砍掉后飞行是\"平移\"没有\"起降\"；<800 时飞行中只看得见两窗，全貌感没了" },
      { name: "飞行/停留", typical: "飞 30f，站内 ~60–90f", feelZh: "停留必须容下打字 ~20f + 输出 ~20f + 读秒 ≥14f；再往大或往小调都会改变手感" },
      { name: "侧视角", typical: "8–10°（VIEW 表）", feelZh: "调大或调小：0° 退化成平面截图；>18° 等宽字被透视压扁读不清（Q6）；再往大或往小调都会改变手感" },
      { name: "景深", typical: "blur ≤3px，拉远时 ×(1−0.45)", feelZh: "离焦太狠时飞行全程一片糊，空间关系读不出" },
      { name: "打字节奏", typical: "0.75–1.65f/字 + 空格 +0.6f", feelZh: "匀速逐字读作机器回放；>2.5f/字 观众等得不耐烦；再往大或往小调都会改变手感" },
      { name: "输出打印", typical: "6f snappy、行距 4f", feelZh: "终端是\"吐\"出来的，慢滑入（>12f）读作 PPT" },
      { name: "窗口姿态", typical: "x 间距 ~1500px，z −220~+260，ry ±14–28°", feelZh: "角度差与前后错落是\"空间散布感\"来源；全部朝正前会退化成平面轮播；再往大或往小调都会改变手感" },
    ],
    soundZh: "运镜段铺一条连续 whoosh，速度越快声像位移越大；落定时收干净，不要有尾巴。音效密度与画面节拍一致即可。",
    pitfallsZh: "相机是逆变换实现，窗口 transform、world transform、地面/背光的 project() 三处必须同构——改姿态只改 POSES / VIEW 数据，改相机链就三处一起改，否则地面网格和窗口会\"滑\"；命令/输出文案是示意的 video-shotcraft 出片流程（shotcraft init / render / export：搭分镜 → 渲染 → 混音导出），换项目真实命令时保持\"命令短、输出 3–5 行\"的信息结构；光标闪烁按帧取模（8f 半周期），改时长不影响；\"打字中常亮、待机慢闪\"的对比要保留；第三窗 READY 行在 ~220f 弹出，之后至少留 ~24f hold，否则尾帧没有落定；光标必须紧贴已打出的字符：未打出的字符不要用 opacity 0 占位（会把光标顶到行尾空处悬着）",
    recipe: {
      canvas: "// 5.6s 镜头机动：每帧算出 p 后套同一条缓动，再乘在这个容器上\nconst p = easeInOut((t % 5.6) / 5.6);\nctx.setTransform(1 + 0.85 * 0.001 * p, 0, 0, 1 + 0.85 * 0.001 * p, -0.85 * p, 0);",
    },
  },
  // 前后对比拉杆（上游  → data）
  {
    id: "before-after-slider-scrub",
    category: "data",
    nameZh: "前后对比拉杆",
    oneLineZh: "「处理前/后」两版叠放，分割杆先猛甩过冲再慢扫回来，杆过处新版显影。",
    useWhenZh: "AI 增强、优化、重构类功能的效果对比段落：一镜讲清「用前 vs 用后」。",
    seconds: [3.6, 6.4],
    energy: "medium",
    tags: ["data","数据可视化","interaction","before","after","slider"],
    intentZh: "快甩宣告「变了」，慢扫证明「变在哪」——速度对比本身就是节奏。",
    motionZh: "杆先向左预备回拉到 6.5%，再用 12f cubic-out 从 8% 甩到 76% 过冲、12f 回弹到 70%，停顿约 18f 后再以约 1/5 的速度慢扫回来。",
    params: [
      { name: "速度比", typical: "快甩 12f vs 慢扫 48f，约 5:1", feelZh: "比例 <3:1 节奏对比不可感；再往大或往小调都会改变手感" },
      { name: "揭示", typical: "after 层 clip-path inset 右边界跟随杆 x", feelZh: "杆和揭示边界错位即穿帮；再往大或往小调都会改变手感" },
      { name: "手柄", typical: "圆形手柄 + 速度差分驱动 scaleX 微拉伸（峰值 1.18），静止自动归 1", feelZh: "拉伸给手柄\"被甩\"的重量感" },
      { name: "before 处理", typical: "低对比灰蒙版", feelZh: "before 太难看是自黑，\"差\"要可信（真实旧版/未优化态）" },
      { name: "角标", typical: "BEFORE/AFTER 角标放内容区", feelZh: "demo 判例：初版压住侧栏/头像穿帮；再往大或往小调都会改变手感" },
    ],
    soundZh: "数据增长段配一条持续上行音阶或计数 tick，终值落定钉一记确认音；随机尖峰处加一声短 alert。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；两版必须同布局同机位——布局不同读作两个页面，对比失效 （theme-switch-moves 同款约束）；实战 before/after 都用真实截图（Q1）：before 是注入旧数据/关闭 功能的真实态，不手搓\"故意丑\"的假 before；慢扫终点停 40% 而非 0%——留一段 after 在画面上定格（结论可见）；声音：快甩一声 whoosh + 回弹轻 tick，慢扫无声或极轻摩擦音（S4）",
    recipe: {
      canvas: "// 5s 数值增长：p 用 ease-out，读数与绘图共用同一个 p\nfunction drawData(p){const v = max * easeOut(p); ctx.clearRect(0,0,w,h); drawBar(v)}",
    },
  },
  // 活体图表三式（上游  → data）
  {
    id: "chart-live-moves",
    category: "data",
    nameZh: "活体图表三式",
    oneLineZh: "示波流线实时写入、点阵三幕重组、轴爆表重标——让图表本身成为剧情。",
    useWhenZh: "数据叙事段落：分别讲「实时性」「每个数字是一个人」「增长装不下」。",
    seconds: [4.61, 8.19],
    energy: "high",
    tags: ["data","数据可视化","chart","live","moves","活体图表三式"],
    intentZh: "图表不是插图而是剧情，前提必须是真坐标轴、真数据、真文案，占位灰条测不出表达力。",
    motionZh: "A 采样窗 8px/f 平移，中途一次振幅 2.2× 的高斯尖峰；B 320 个点按 spring 错峰（stiffness 150、damping 13）聚成三簇再拼数字；C 冲天花板 226px，刻度/网格/旧线三联动重标并震 10px。",
    params: [
      { name: "真语境", typical: "真标题/真轴标/真单位/真读数", feelZh: "入库前提：灰阶版三条全数被裁，换真语境后全过" },
      { name: "主角色", typical: "强调色标事件/主角（demo：A 珊瑚红尖峰、B 钴蓝 Launch film 簇、C 赤陶爆表段）", feelZh: "全灰读不出\"哪里是重点\"" },
      { name: "A 流速", typical: "8px/f", feelZh: "调大或调小：5.5 已可感，8 更明确；波形纯函数禁随机" },
      { name: "B 点数/点径", typical: "320 / 直径 20px（迁徙中按速度拉成胶囊，封顶 +20px）", feelZh: "点太少拼不出数字，太小看不见个体；拉伸过长会糊成一片" },
      { name: "C 冲出幅度", typical: "天花板规线外 226px", feelZh: "调大或调小：80px 版不够\"爆\"；真的插进标题区才是事故感；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "三式都要 ≥36f 真静止", feelZh: "数据图表尾漂读作还没播完；再往大或往小调都会改变手感" },
    ],
    soundZh: "数据增长段配一条持续上行音阶或计数 tick，终值落定钉一记确认音；随机尖峰处加一声短 alert。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 以 video-shotcraft 的示意渲染数据调校（A 深蓝示波屏·渲染农场 fps、B 瓷白信息图·按片型分的渲染量、 C 沙色瑞士海报·月度渲染量），数值是示意——参数是调校起点非实战定稿，首次实战须以真实素材回验；三式的读数 / 刻度 / 标签都按成片字号做（≥32px，主读数 120–176px）；图表撑满画面而不是缩在卡片里；三式是三种独立手法不是套餐——同片用两式以上时各 ≤1 次且错开段落；A 的尖峰事件、C 的重标只能发生一次；重复即廉价；B 终幕数字字形要预先手算（点数=位点数用满才整齐；参考实现用单线骨架等弧长采样、法向双排，恰好 320 颗无重叠）",
    recipe: {
      canvas: "// 6s 数值增长：p 用 ease-out，读数与绘图共用同一个 p\nfunction drawData(p){const v = max * easeOut(p); ctx.clearRect(0,0,w,h); drawBar(v)}",
    },
  },
  // 仪表读数两式（上游  → data）
  {
    id: "gauge-readout-moves",
    category: "data",
    nameZh: "仪表读数两式",
    oneLineZh: "满弧扫针自检后回落真值，或刻度带整体滚过定针、冲刺后弹簧刹车。",
    useWhenZh: "dashboard 开场仪式、性能指标揭晓；A 多表盘开机感，B 单指标大跳变。",
    seconds: [4.7, 5],
    energy: "high",
    tags: ["data","数据可视化","gauge","readout","moves","仪表读数两式"],
    intentZh: "把报数值做成仪表的身体动作：先亮量程再报数，把数字变成仪式。",
    motionZh: "A 指针 12f ease-out 甩满 270° 弧、24f 内弹簧回落并过冲约 8°，三表错峰 4f；B 刻度带慢爬顶住旧上限后预备回拉，22f 冲刺（峰值约 100px/f）再 spring 刹车回摆。",
    params: [
      { name: "A 甩弧幅度", typical: "满量程 270°，到顶即回程", feelZh: "只甩到真值=没有自检仪式感；满弧再回落才是\"先亮量程\"；去程扫过的刻度（含红区）依次点亮" },
      { name: "A 过冲", typical: "回落带 ~8° 回摆（按行程反算弹簧阻尼）", feelZh: "无过冲读作电子表；过冲=机械指针的质量；再往大或往小调都会改变手感" },
      { name: "A 错峰", typical: "4f/表（左→中→右）", feelZh: "齐甩读作复制粘贴；错峰成波浪；再往大或往小调都会改变手感" },
      { name: "B 冲刺速度", typical: "5px/单位、峰值 ~100px/f（大跳变段）", feelZh: "慢了读作匀速爬升，\"世界动\"不成立；带子越长越大，越要配纵向运动模糊" },
      { name: "B 刹车", typical: "spring 过冲（冲过头再弹回停位）", feelZh: "词汇原案的回摆是\"哐\"的来源，直停可惜；再往大或往小调都会改变手感" },
      { name: "真静止", typical: "停位后 ≥30f 全锁死（A 末表落定 ~66f、B 110f 锁常数）", feelZh: "手感：停位后 ≥30f 全锁死（A 末表落定 ~66f、B 110f 锁常数） 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "数据增长段配一条持续上行音阶或计数 tick，终值落定钉一记确认音；随机尖峰处加一声短 alert。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；同批 ring-close-overfill（合环过盈）改改再看无附言——环形进度类 待重做，别急着当第三式并入；A 的表盘是自绘 SVG（弧刻度+指针），实战贴真 dashboard 时优先找 页面里现成的 gauge 组件特写，没有再造；声音：A 甩针一声\"唰\"+落定\"嗒\"（多表错峰各一声）；B 冲刺段 低频滚动声、刹车一声闷\"哐\"",
    recipe: {
      canvas: "// 4.85s 数值增长：p 用 ease-out，读数与绘图共用同一个 p\nfunction drawData(p){const v = max * easeOut(p); ctx.clearRect(0,0,w,h); drawBar(v)}",
    },
  },
  // 长卷急刹两式（上游  → data）
  {
    id: "scroll-brake-moves",
    category: "data",
    nameZh: "长卷急刹两式",
    oneLineZh: "高速长卷指数减速精准停在目标行，或急刹同帧四面角标飞入咬合锁定。",
    useWhenZh: "changelog、发布史、长列表段落：「一直在发货，今天这条最大」。",
    seconds: [5, 5.3],
    energy: "high",
    tags: ["data","数据可视化","rhythm","scroll","brake","moves"],
    intentZh: "密度感讲「一直在发货」，急停讲「今天这条最大」；组合款要把急刹的「哐」和咬合的「咔」叠在同一帧。",
    motionZh: "translateY 扫约 2400px，cubic-bezier(.45,0,.06,1) 共 50f 先拉满速再长尾指数减速；方向性 blur 由帧间位移驱动、封顶 30px，停稳清零，停点行 1.04 倍抬升高亮。",
    params: [
      { name: "减速曲线", typical: "A 快起步 + 长尾减速（bezier .45,0,.06,1）；B 加\"冲过头 30px 回弹\"", feelZh: "匀速滚读作跑马灯；B 的过头回弹是\"哐\"的来源；再往大或往小调都会改变手感" },
      { name: "blur 驱动", typical: "帧间位移差分", feelZh: "p(f)-p(f-1)；再往大或往小调都会改变手感" },
      { name: "行高节奏", typical: "72/94/116 三档错落", feelZh: "等高行高速掠过时色带无节奏" },
      { name: "停位", typical: "目标行停画面纵向正中", feelZh: "手感：目标行停画面纵向正中 只是起点，再往大或往小调都会改变节奏与力度" },
      { name: "B 共振帧", typical: "角标挂载起跳帧 = 列表首次停住帧（严格同帧）", feelZh: "组合命门，错 2f 以上就散；再往大或往小调都会改变手感" },
    ],
    soundZh: "数据增长段配一条持续上行音阶或计数 tick，终值落定钉一记确认音；随机尖峰处加一声短 alert。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 timeline-travel 分工：本卡纵向列表急刹停\"最新\"， 那卡横向时间轴旅行看\"历史\"——同片双用时先后错开且各 ≤1 次；高速段条目内容不用真实可读文本——反正糊成色带，占位灰块即可； 停点条目必须出版级真内容（Q10）；停点后其余行退暗 0.38 是构图动作：别退到 0（上下文消失）；声音：高速段低频 riser 铺垫，急刹一声 impact；B 咬合帧 再叠一声\"咔\"（与 impact 同帧不同声部）",
    recipe: {
      canvas: "// 5.15s 数值增长：p 用 ease-out，读数与绘图共用同一个 p\nfunction drawData(p){const v = max * easeOut(p); ctx.clearRect(0,0,w,h); drawBar(v)}",
    },
  },
  // 时间轴旅行（上游  → data）
  {
    id: "timeline-travel",
    category: "data",
    nameZh: "时间轴旅行",
    oneLineZh: "沿水平刻度轴缓起、冲刺、急刹，每过一格卡片从刻度线弹立，末格推近定格。",
    useWhenZh: "changelog、里程碑、发展史段落：速度讲「发展快」，急停讲「现在最重要」。",
    seconds: [3.6, 6.4],
    energy: "high",
    tags: ["data","数据可视化","camera","timeline","travel","时间轴旅行"],
    intentZh: "把版本史拍成一次沿时间轴的旅行：历史在窗外闪过去，急停在今天并推近。",
    motionZh: "世界层 translateX 缓起→冲刺→末 12% 急刹，掠过刻度前 6f 卡片以底边为轴 spring 弹立（ damping 约 11 明显过冲）；急停后 10f scale 1→1.28 推近末刻度，接静止至少 30f。",
    params: [
      { name: "变速曲线", typical: "输入断点 [0,0.15,0.88,1]→输出 [0,0.055,0.9,1]", feelZh: "中段不够快就没有\"旅行感\"；全程匀速即廉价 PPT" },
      { name: "弹立时机", typical: "相机到达刻度前 6f 起弹，由 camXAt 反查", feelZh: "到了才弹观众已经错过；早太多读作预告" },
      { name: "刻度密度", typical: "主刻度 3–5 个 + 次刻度小点若干", feelZh: "次刻度点是速度感的参照物，删掉就感觉不到快" },
      { name: "急停推近", typical: "1→1.28 / 10f", feelZh: "不推近急停就只是\"停了\"，推近才是\"到了\"" },
    ],
    soundZh: "数据增长段配一条持续上行音阶或计数 tick，终值落定钉一记确认音；随机尖峰处加一声短 alert。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；中段冲刺快到卡片糊时可叠 CameraMotionBlur（只包快速段，轮 #8 判例）；急停后静止预算前置：demo 首版静止只有 25f 不达标，急停帧前移才够 ——排时间线时先给末段留 ≥30f 再倒推行程；每张弹立卡片是信息位：实战放真实版本亮点截图/一句话， 掠过速度要保证至少末两张能读（Q6 同源）；声音：每次弹立一声轻打点，急停一声 impact（S2 同源）",
    recipe: {
      canvas: "// 5s 数值增长：p 用 ease-out，读数与绘图共用同一个 p\nfunction drawData(p){const v = max * easeOut(p); ctx.clearRect(0,0,w,h); drawBar(v)}",
    },
  },
  // 骨架先行·文字后至（上游  → light-emphasis）
  {
    id: "assemble-then-type-flyin",
    category: "light-emphasis",
    nameZh: "骨架先行·文字后至",
    oneLineZh: "空网格上无字骨架先从四面八方飞入贴合，紧接着文字逐字从 3D 空间旋转飞来落位，页面自己长出来。",
    useWhenZh: "页面或海报「自己长出来」的开场；排版类产品的能力展示；从骨架到成稿的两段式叙事。",
    seconds: [4.03, 7.17],
    energy: "high",
    tags: ["effects","光影强调","assemble","then","type","flyin"],
    intentZh: "把生成拆成两段语义：先立骨架再填文字，两段运动维度不同，观众才读得出「这是第二步」。",
    motionZh: "10 个骨架件按 6–44f 依次飞入（16f overshoot，位移 120–420px、旋转 ±7°），19 个文字块 58–114f 逐字 3D 旋转落位：大标题最先、按钮与指标随后、mono 小标注最后。",
    params: [
      { name: "骨架时序", typical: "10 件，起飞帧 6→44（间隔 4–5f）", feelZh: "骨架段占前 30%；压缩到 20f 内就和文字段糊在一起；再往大或往小调都会改变手感" },
      { name: "骨架飞入", typical: "overshoot、16f、位移 120–420px + ±7°", feelZh: "与 scanline-assemble-flyin 同一手法，去掉扫描线后靠时序读顺序；再往大或往小调都会改变手感" },
      { name: "骨架残影", typical: "方向性运动模糊，按速度 ×0.32、封顶 18px", feelZh: "只在快速段出现；常驻模糊读作失焦" },
      { name: "两段断点", typical: "骨架齐（f50）→ 文字起（f58）留 8f，参考线同期退淡", feelZh: "没有这半拍观众读不出\"这是第二步\"；再往大或往小调都会改变手感" },
      { name: "文字起点", typical: "大标题 58/66，小标注 104→114", feelZh: "大字先落是可读性要求：小字先落观众会去读小字" },
      { name: "逐字位移", typical: "dx ±260 / dy ±200 / dz −200→−760", feelZh: "dz 是\"从远处来\"的主力；只给 dx/dy 就成了平面散入；再往大或往小调都会改变手感" },
      { name: "逐字旋转", typical: "rotateX/Y/Z 各 ±120°–190°", feelZh: "大角度才有\"翻着飞\"的手感；±30° 只像抖动" },
      { name: "perspective", typical: "900px（写在每个字符自己的 transform 里）", feelZh: "调大或调小：112px 大字配 600px 会过度畸变；1400px 以上 3D 感基本消失" },
      { name: "字间隔", typical: "clamp((128−start−16)/n, 0.35, 1.6) 帧", feelZh: "上限 1.6f 是\"逐字可辨\"的下限速度；再往大或往小调都会改变手感" },
      { name: "落位清零", typical: "a>=1 → transform:'none'", feelZh: "不清零会留下 19 个块的合成层，长片会掉帧" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "字符 span 走正常排版流（display:inline-block），动画只动 transform—— 不要用绝对定位逐字摆位，换文案就全乱；空格字符必须显式塞成不换行空格（代码里用 ch === ' ' ? '\\u00a0' : ch）， 否则 inline-block 的空 span 宽度归零，词间距消失；start 是手写的 19 个数值，换文案（尤其字符数变化大时）要回看 最后一块是否仍在 f128 前落完；step 只保证块内，不保证块间；内容是 video-shotcraft 的示例发布页（标题 / 指标 / 色轮标注），落地换成项目自己的； GOLD（graphite 的 accent2 #e4c58a）为强调色槽位，CTA 字色随通电由金转深要一起换；与 scanline-assemble-flyin 的区别是没有扫描线：那张靠扫描线 解释顺序，这张靠\"先骨架后文字\"的两段式解释顺序，两者不要混用",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 5.6s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 极光底翻黑（上游  → light-emphasis）
  {
    id: "aurora-bloom-bg-flip",
    category: "light-emphasis",
    nameZh: "极光底翻黑",
    oneLineZh: "浅灰底升起紫橙柔焦 blob，随后整屏在 0.36s 内压暗到近黑，文案 blur 换句并留空档。",
    useWhenZh: "叙事转折点、品牌片从铺垫拉到重音的一拍、深浅色系之间的段落切换。",
    seconds: [3.74, 6.66],
    energy: "medium",
    tags: ["effects","光影强调","aurora","bloom","flip","极光底翻黑"],
    intentZh: "把底色反转当重音符号：不到 0.4s 压黑，比任何缩放或闪白都更像「翻页」。",
    motionZh: "三层 blur(60px) blob 从底部升起（translateY 32%→−6%、scale 1→1.25），第 0.57–0.64 段用 inOutQuad 翻成近黑、blob 降到 0.4；橙核以 2.2 周期左右漂移 ±8%，换句之间留空档不做 cross-fade。",
    params: [
      { name: "blob 模糊/尺寸", typical: "blur(60px)，主层 90%×85%，容器 inset −10%", feelZh: "模糊小于 40px 就看得出是圆，成了\"色球\"不是\"光\"" },
      { name: "升起", typical: "translateY 32%→−6% + scale 1→1.25，t 0.04→0.56 outCubic", feelZh: "占掉一半以上时长是故意的：酝酿越长，反转越有分量" },
      { name: "反转时长", typical: "t 0.57→0.64 inOutQuad ≈ 0.36s", feelZh: "命门：拉到 1s 就不是重音而是渐变过场" },
      { name: "底色", typical: "#ececec → #0a0a12（不是纯黑）", feelZh: "纯黑会让余晖 blob 边缘出现色阶断层；再往大或往小调都会改变手感" },
      { name: "blob 压暗", typical: "opacity 1→0.4，白色融边层同步归零", feelZh: "不压暗 blob，暗场里紫橙会过曝糊成一团" },
      { name: "橙核漂移", typical: "translateX ±8%，2.2 周期/全片", feelZh: "幅度到 15% 就看得出是\"一个球在动\"；再往大或往小调都会改变手感" },
      { name: "A 句 blur-out", typical: "逐词 stagger 0.04、各 0.10、inQuad、blur→8px", feelZh: "inQuad 让消失是加速的，读作\"被光吞掉\"" },
      { name: "B 句 blur-in", typical: "逐词 stagger 0.05、各 0.11 outQuint + 0.09 内紫→白", feelZh: "收色比入场晚一点，落定瞬间才转白，是\"定稿\"的信号；再往大或往小调都会改变手感" },
      { name: "换句空档", typical: "A 收完 t≈0.58 → B 起 0.70（≈0.6s 无字）", feelZh: "cross-fade 会把两句糊在一起，空档才读出\"翻篇\"；再往大或往小调都会改变手感" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。音效密度与画面节拍一致即可。",
    pitfallsZh: "白色融边层（blobC）只在浅底成立，反转时必须 1−flip 收掉， 否则暗场里留一团灰雾；DEEPP/PURPLE 是这个效果的本体光色，不是品牌色槽位；要换成项目色 必须 blob 三层 + B 句文字色整组一起换，只换文字色会和背景脱节；demo 文案是 video-shotcraft 的叙事转折（\"Promos took weeks\" / \"Meet video-shotcraft\"， 词数与字长贴近原片的 \"For many years\" / \"everything changed\"），逐词 stagger 的节奏依赖词数与字长，换句要回调 0.04/0.06 两个间隔；底色用 JS 逐帧写 background（mix() 出实色），不要用 CSS transition， 否则 seek 到任意帧时颜色不确定",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 5.2s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 品牌画框翻色（上游  → light-emphasis）
  {
    id: "brand-frame-snap",
    category: "light-emphasis",
    nameZh: "品牌画框翻色",
    oneLineZh: "粗品牌色画框先于内容长出包住录屏，模式切换时整圈画框同帧硬翻色、窗内布局同帧换。",
    useWhenZh: "双模式、双章节产品片的全片包装层；真实录屏素材的品牌化包裹。",
    seconds: [3.38, 6.02],
    energy: "high",
    tags: ["effects","光影强调","transition","brand","frame","snap"],
    intentZh: "用一圈画框把录屏装裱起来，画框颜色成为全片的语义编码——颜色硬切就是换挡声效的视觉等价物。",
    motionZh: "4 条实体色带 19f snappy 长到 60px（第 2 帧就可见），产品窗用 spring(damping 15、stiffness 115) 从下方 660px、前倾 18° 落进框内；翻色帧同一帧换画框色、换布局、换角标。",
    params: [
      { name: "画框厚度", typical: "60px（1080p），角标 30px 粗体全大写", feelZh: "太薄读作描边、角标也放不下可读字号；>64px 开始吃内容区" },
      { name: "画框生长", typical: "19f snappy，先于窗口 10f", feelZh: "画框必须先立——内容先到画框后包读作补救；再往大或往小调都会改变手感" },
      { name: "窗口落位", typical: "spring(damping 15, stiffness 115)，y 660→0 + rotateX 18°→0 + scale 0.88→1", feelZh: "落进\"框内\"是语义关键，落点必须完全在框带内侧；再往大或往小调都会改变手感" },
      { name: "翻色时刻", typical: "demo 84f（光标松开帧）；停一拍（窗口落定后 ≥30f）再翻", feelZh: "落定没坐稳就翻，观众还没建立\"蓝=当前模式\"的编码；再往大或往小调都会改变手感" },
      { name: "白闪脉冲", typical: "3f，0.6→0.2 阶梯，径向（框带处最亮）", feelZh: "帮眼睛登记\"这一帧变了\"；>4f 读作底色频闪，抢了翻色的戏；再往大或往小调都会改变手感" },
      { name: "厚度弹跳", typical: "exp 衰减 cos，初幅 12px", feelZh: "纯硬切略干；弹跳是\"挡位卡进去\"的机械回馈；再往大或往小调都会改变手感" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 用手搓的设计工具窗口调校通过（框带角标是 video-shotcraft 标志 + 字标，画布上是一张 video-shotcraft 推广卡）——参数是调校起点非实战定稿， 首次实战须以真实素材回验；翻色必须真同帧：画框、窗内布局、角标文字三者错开哪怕 2f，\"换挡\"就散成三个小动画；颜色编码要全片守约：蓝框段落里不许出现绿色主 UI 元素，编码被稀释后翻色就只是换色；画框是包装层不是主角：全片翻色 ≤2 次，翻多了读作霓虹灯（P4 克制原则）；两个模式的品牌色对比度要够（demo 钴蓝 #2F55FF / 橘红 #FF5B1F，色相对冲 + 明度差）；同明度邻近色翻了等于没翻",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 4.7s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // FUI 准星咬合（上游  → light-emphasis）
  {
    id: "fui-hud-moves",
    category: "light-emphasis",
    nameZh: "FUI 准星咬合",
    oneLineZh: "四个 L 形角标从画外飞入、超调回弹后「咔」地咬合锁定目标，并弹出一枚小标签。",
    useWhenZh: "任何「看这里」的目标点名：替代箭头圈红，而且不冻结画面。",
    seconds: [2.16, 3.84],
    energy: "high",
    tags: ["effects","光影强调","ui-entrance","fui","hud","moves"],
    intentZh: "把科幻界面里的捕获母题中性化：在运动中点名，和冻结画面标注互补。",
    motionZh: "四个 L 角飞入 10f out-cubic 与收缩 2.2×→0.94×→1 解耦；咬合帧目标微亮、标签 back 弹出，并在音效重拍上落锁。",
    params: [
      { name: "飞入行程", typical: "画外 ≥1000px 冲入", feelZh: "行程短读作\"角标出现\"不是\"扑过来\"" },
      { name: "超调", typical: "收缩过头到 0.94× 再回弹 1", feelZh: "无超调没有\"咔\"的咬合感" },
      { name: "咬合帧", typical: "目标白 overlay 快闪 0.55→停 0.28 + 标签同帧弹出", feelZh: "微亮与标签错帧就散了" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；一支片 ≤2 次：连用读作军事模板；两次锁定目标必须不同；声音：咬合帧一声\"咔\"（机械 click 而非游戏 UI 音，S1 边界内）",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 3s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 暗场光斑飞线三式（上游  → light-emphasis）
  {
    id: "glow-flyline-moves",
    category: "light-emphasis",
    nameZh: "暗场光斑飞线三式",
    oneLineZh: "光斑底噪、飞线连接、同帧共振组合——暗场里的氛围呼吸与数据流向。",
    useWhenZh: "全片唯一暗场段落的氛围与数据叙事：铺底噪用 A、讲数据流向用 B、要背景给前景搭腔用 C。",
    seconds: [4.7, 5.7],
    energy: "low",
    tags: ["effects","光影强调","data","glow","flyline","moves"],
    intentZh: "要玩光先去暗场：A 是空间的呼吸，B 是数据的动词，C 让背景光斑与前景节点在同一帧搭腔。",
    motionZh: "A 三团 760–1200px 径向光斑双正弦漂移，卡缘辉光按光斑距离 240–760px 加权；B 卡心到卡心 bezier 22f out-cubic 生长，光头领跑、彗尾按离头距离渐隐；C 光斑 surge 与节点点亮共用落点帧常量，涨亮 1+1.6×surge 并放大 12%。",
    params: [
      { name: "A 光斑", typical: "潮青 / 深海蓝 / 珊瑚，峰值 0.55/0.5/0.42；漂移振幅 280–300px、周期 96–150f 交叉不等", feelZh: "同周期漂移读作整体晃动不是\"有机\"；再往大或往小调都会改变手感" },
      { name: "A 玻璃卡", typical: "backdrop blur 44px + saturate 1.5；祖先不能带 filter / opacity<1", feelZh: "祖先成为 backdrop root 时玻璃里看不到光斑（入场淡入放在玻璃层自身）；再往大或往小调都会改变手感" },
      { name: "A 卡缘辉光", typical: "box-shadow 0→90px 主导光斑色 0.32 + 1.5px 定向渐变轮廓光", feelZh: "无辉光光斑与卡互不认识；再往大或往小调都会改变手感" },
      { name: "A 收敛", typical: "115–145f out-sine 收敛冻结（振幅 60/π，起始斜率 = 1 速度连续），末 25f 真静止", feelZh: "硬停一帧读作卡死；缓动收敛才有真静止" },
      { name: "B 线体", typical: "暗场版（demo）：白芯 3.5px butt 分段 + 7px/18px 两层靛蓝辉光；浅底版：白线 4.5px + 9px 深色衬底", feelZh: "浅底无衬底白线直接消失（判例）；分段用圆头会在渐隐尾叠出珠串" },
      { name: "B 光头", typical: "白点 r7 + r40 halo + 9 点彗尾，仅生长期条件挂载", feelZh: "opacity 到 0 不算摘罩，永不真静止；再往大或往小调都会改变手感" },
      { name: "B 脉冲", typical: "描边扩散 out-cubic 6f / 消散 12f 到残余 0.25；暗场版提亮（强调色描边 + 外辉光 + 极淡卡面提亮）+ 14f 冲击环；f86 后全静止", feelZh: "白底禁提亮——浅底版用加深罩 0.16 替代" },
      { name: "C 共振", typical: "落点帧同帧起 surge（同一常量 LIT_B / LIT_C）；节点 8f 亮到 1 + 描边脉冲残余 0.35 + 20f 冲击环", feelZh: "错 2f 以上共振读不出\"搭腔\"；再往大或往小调都会改变手感" },
      { name: "C 时间轴", typical: "动作 f98 前结束、光斑 110–140f 收敛冻结，末 25f 真静止", feelZh: "氛围层最后冻，事件层先收；再往大或往小调都会改变手感" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；暗场段与纸墨浅底主视觉切换成本高——全片暗场段 ≤1 段，进出 用 shot-transitions 藏切族垫，别生切明暗；光斑漂移末段必须缓动收敛到静止再冻结——匀速漂移直接 clamp 是一次可见的急刹（A 式 out-sine 收敛判例）；实战品牌色版：光斑用品牌色对（如蓝紫），灰阶参数只保证明度关系， 色相对比要重调；B 接力线 ≥3 条时改用 C——纯飞线连打读作大屏模板，共振才有作者感",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 5.2s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 图标表演弹跳（上游  → light-emphasis）
  {
    id: "icon-performance-moves",
    category: "light-emphasis",
    nameZh: "图标表演弹跳",
    oneLineZh: "图标原地连跳一次比一次高、落地压扁带涟漪，邻居失焦、镜头被吸引轻推。",
    useWhenZh: "半屏级 icon 特写段落；新功能引出。",
    seconds: [3.74, 6.66],
    energy: "medium",
    tags: ["effects","光影强调","interaction","icon","performance","moves"],
    intentZh: "把 icon 当镜头前表演者而不是 UI 角落的微交互：连跳拉注意力，镜头再跟上去看它打开面板。",
    motionZh: "抛体弹跳时长 ∝√高度，连跳 4 次（0.35→1.2 倍 icon 高），每次落地 2f 挤压（宽 1.2×高 0.8）加涟漪；邻居 rack focus 失焦，峰值镜头 scale 1.08 轻推。",
    params: [
      { name: "icon 尺寸", typical: "360–400px 高（半屏特写；demo 图标 360）", feelZh: "角落小图标做表演没人看见——表演者必须占 C 位" },
      { name: "递增弹跳", typical: "4 跳 0.35→0.6→0.85→1.2 倍 icon 高，空中 14/18/22/26f（∝ √高度）", feelZh: "等高连跳读作 loading；递增才是\"越喊越大声\"；时长不随高度变读作失重" },
      { name: "落地挤压", typical: "接触 2f，压扁量 0.1→0.2 递增（末跳宽 1.2x 高 0.8x），末跳阻尼余弦回稳", feelZh: "squash 缺席=没有重量" },
      { name: "镜头推近", typical: "末跳 72–90f smooth 推 8%；邻居 30–96f 失焦到 7px、降饱和 30%", feelZh: "镜头动作把\"被吸引\"的观众视角演出来；再往大或往小调都会改变手感" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；同批 bell-swing-alert（铃铛甩摆）淘汰无附言——挂点摆动型 icon 表演相性存疑，做新 icon 表演优先弹跳/爆发型；首版曾出画框（末跳最高点顶出），弹跳高度与画面上留白先算像素 （demo：地面 960、图标 360、末跳顶点 168px，推近 8% 后约 119px）；声音：每次落地一声\"duk\"音调递升，面板弹出一声轻\"叮\"",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 5.2s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 命中反馈两式（上游  → light-emphasis）
  {
    id: "impact-feedback",
    category: "light-emphasis",
    nameZh: "命中反馈两式",
    oneLineZh: "落位瞬间加游戏级反馈：连招顿帧叠伤害数字，或过一帧动漫负片集中线。",
    useWhenZh: "元素砸入或撞停的「命中一瞬」，按强度阶梯选式。",
    seconds: [1, 4],
    energy: "high",
    tags: ["effects","光影强调","impact","feedback","命中反馈两式"],
    intentZh: "元素到位却没有「砸到了」的一瞬，落位就读成 PPT 飞入；命中的几帧要把时间咬住，冲量才传到观众手上。",
    motionZh: "B 每次命中顿帧 2f 并上浮伤害数字、×N 计数逐次加码，数字飘走后落进卡片页脚；C 在撞停处用 3f 整幅负片反色加放射集中线、红青色散，第 4f 全撤。",
    params: [
      { name: "B 节奏", typical: "三卡各隔 28f（动画时间 30/58/86），命中前 10f ease-in(quad) 砸落；每命中全局冻结 2f（背景斜纹滚动也一起冻）", feelZh: "间隔均匀才有\"连招\"节拍感；再往大或往小调都会改变手感" },
      { name: "B 伤害数字", typical: "打在卡面中下部，scale 1.45→1 + 上浮 150px 出卡沿，4f 后 12f 渐隐；字号逐击 88/104/124px，黄色斜体 + 硬投影", feelZh: "渐隐 >16f 拖泥带水，遮住下一击；从卡顶上方起跳会撞上角落计数器；再往大或往小调都会改变手感" },
      { name: "B 计数器", typical: "脉冲峰值 1.3/1.45/1.6、rotate −2/−4/−6°、字号 140/166/196px，exp(−t/2.4) 回落；三格热度条逐格点亮", feelZh: "逐次加码是命门——三次一样大读不出\"越打越狠\"" },
      { name: "C 急推撞停", typical: "先 6f 预备回拉到 0.985，再 crash-zoom 6f ease-in(cubic) 推到 2.25x（卡高 454×2.25≈画高 95%，描边不被画框切半），卡心收敛到画面正中；飞行帧做时间采样运动模糊 + 中心锐利副本", feelZh: "急推参数走 crash-zoom-punch 卡" },
      { name: "C 冲击帧", typical: "撞停起 3f：invert(1) grayscale(1) contrast(1.45) + 34 粗楔 + 22 细针集中线（每帧换形态，内端被径向渐隐吃掉留出焦点）+ 红/青负片副本 screen 叠加 ±8px 错位；第 4f 全撤，卡外页面压暗一拍", feelZh: "调大或调小：3f 是甜点——4f 起观众开始\"看清\"负片，魔术就穿帮；再往大或往小调都会改变手感" },
      { name: "C 恢复震屏", typical: "第 4f 起 6px 指数衰减（τ≈2.2f），~12f 收干", feelZh: "幅度须过肉眼阈值（可感性判例）；再往大或往小调都会改变手感" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；B 式顿帧必须全局——背景滚动也要一起冻，否则读不出\"时间被 咬住\"，只像那张卡掉帧。demo 用统一 remap 帧 df 驱动所有层是命门； 唯闪白等\"冻结期间也要发生\"的效果用真实帧 f 驱动；帧 remap 与 speed-ramp-freeze 同技术根，同一镜头别叠用两卡—— 两套 remap 互相打架，节奏读作故障；C 式负片帧在纸墨审美的片子里非常抢戏——限高潮一次，且必须与 impact 音效同帧落地（拟音走 sound-design），无声的负片帧读作闪坏；B 式游戏化语言浓（伤害数字/combo 是明晃晃的游戏梗），产品调性 偏严肃时慎用",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 2.5s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 光效两式（上游  → light-emphasis）
  {
    id: "light-play-moves",
    category: "light-emphasis",
    nameZh: "光效两式",
    oneLineZh: "锥形聚光像钟摆扫亮暗场标题，或让深墨主角卡上一道 45° 高光带缓缓扫过加冕。",
    useWhenZh: "把光当另一种笔触：暗场标题揭示用 A，主角卡加冕用 B。",
    seconds: [5, 5.7],
    energy: "low",
    tags: ["effects","光影强调","typography","light","play","moves"],
    intentZh: "光是笔触：A 是扫、B 是擦；白底上提亮不可见是整张卡的地基。",
    motionZh: "A 用双层同文本，暗版 0.07 常驻、亮版 radial mask 随光斑钟摆追光两个半来回后阻尼停在正中，最后 iris 张开全亮定格；B 卡转向光源时 115° 高光带扫一次，被圆角 overflow 裁住。",
    params: [
      { name: "A 反差", typical: "暗版 0.07 vs 全亮 1.0；demo 为暖白 #f8efe2 衬线字对酒红黑天鹅绒幕布（#1a0a0d→#070203），幕布本身也只在光斑里被照亮", feelZh: "反差是本式全部；暗版 >0.15 就没有\"点亮\"了" },
      { name: "A 光斑", typical: "ellipse 360px（硬芯+长软边），钟摆：x = 960+600·sin θ·env，θ 从 −π/2（最左）起、周期 50f、走 2.25 个周期至 f121；y 走下凹弧（中心最低 44px）；env 第一来回后 smooth 收到 0，x 与速度在 f121 同时归零（纯 sin 会在中心最快时急刹）；开灯 4–10f 钨丝预热闪两下", feelZh: "f121–141 iris 张开 360→1080px 全亮（out-cubic）、光锥线性收成柔和顶光（扩散/消散解耦判例）" },
      { name: "B 高光带", typical: "宽 2×卡宽，115° 渐变：宽柔光 0.14 + 窄亮芯 0.5（暖白，screen），58–90f swift 扫一次；同段卡 rotateY 21°→14°（转向光源 = 扫光的物理动机）；光带下拉丝纹与蚀刻字的亮版副本被同一遮罩揭开", feelZh: "调大或调小：0.5 芯在钛黑上足够响又不糊；双向 clamp + 条件挂载保证只扫一次；再往大或往小调都会改变手感" },
      { name: "摘罩", typical: "扫光（B）条件挂载，扫完即卸载；A 光锥收成常驻柔和顶光", feelZh: "opacity 0 残留层照样每帧合成——不用的光效层直接卸载；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "A ~30f / B ~55f hold；hold 段只留极缓运动（A 浮尘与顶光呼吸、B 卡 rotateY 再转 1.5°）", feelZh: "不加手持抖动（Q3）" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；全片光效合计 ≤2 次——光是最快掉价的手法，每个卡都闪一下 等于廉价模板；B 式是高标准重试通过：旧否决（2026-07-13 判例）针对当时实现不好看， 非路径不可行；四约束 = 单点+主角+圆角裁剪+只扫一次，违反任何 一条回到否决区；深底是地基：两式全部依赖深底/深主角，白底上做光效直接跳过本卡；A 与 spotlight-hero-card 同片二选一，都是\"聚光\"语汇",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 5.35s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 同心圆呼吸产品全景（上游  → light-emphasis）
  {
    id: "radial-ripple-phone-chips",
    category: "light-emphasis",
    nameZh: "同心圆呼吸产品全景",
    oneLineZh: "暖沙底四层同心圆错相呼吸如水波，中央手机里的 feed 自动缓滚，两侧 chip 先后 spring 入场悬浮。",
    useWhenZh: "移动端产品的定格镜头、功能点分列两侧的介绍段、片头或片尾的产品全景。",
    seconds: [4.03, 7.17],
    energy: "low",
    tags: ["effects","光影强调","radial","ripple","phone","chips"],
    intentZh: "用最少的动作让手机「活着」：圆环负责氛围呼吸、屏内滚屏证明内容在跑、两侧 chip 点出功能名。",
    motionZh: "4 层同心圆各自 scale 1±0.06、全片走 1.5 个正弦周期，相邻层相位差 1.7 rad；手机 0–26f 从下方 90px 升起、投影随落位收紧，两侧 chip 先后 spring pop 并悬浮。",
    params: [
      { name: "同心圆层数/尺寸", typical: "4 层 2240/1760/1280/840px（1080p）", feelZh: "调大或调小：3 层撑不满画面；最外层要出画，否则读作一块圆形色板；再往大或往小调都会改变手感" },
      { name: "呼吸幅度", typical: "scale 1±0.06，1.5 周期/全片", feelZh: "调大或调小：0.06 已是上限；到 0.1 就读作\"脉冲动画\"而非水波；再往大或往小调都会改变手感" },
      { name: "相位差", typical: "相邻层 1.7 rad", feelZh: "相位全同 = 整块放大缩小；差 1.7 才有波从中心荡开的错觉" },
      { name: "手机投影", typical: "贴近实影 0 4px 10px + 远影 0 40px 80px -20px + 环境影 0 90px 140px -40px（sand.shadow 带色相）", feelZh: "投影是手机\"浮在波上\"的唯一依据，去掉就贴平了；再往大或往小调都会改变手感" },
      { name: "自动滚屏", typical: "translateY 0→−560px，t 0.08→0.98 匀速", feelZh: "加 ease 立刻读作\"有人在滑\"；匀速才是自动播放" },
      { name: "chip pop", typical: "spring damping 13 / stiffness 190，scale 0.8→1，外移 28px", feelZh: "过冲量是\"弹出\"的全部质感，damping >20 就平了；再往大或往小调都会改变手感" },
      { name: "chip 时序", typical: "左 37f / 右 67f（1s 差）", feelZh: "同时出现读作两个标签；错开才有\"一个一个说\"的节奏；再往大或往小调都会改变手感" },
      { name: "chip 悬浮", typical: "±8px、2 周期，pop 后 18f 起 24f 渐入", feelZh: "幅度超过 ~12px 就和同心圆的呼吸抢戏；再往大或往小调都会改变手感" },
      { name: "chip 字号", typical: "36px / 600 字重 + 60px 强调色图标圆", feelZh: "调大或调小：1080p 下 chip 是要读的字，别回到 12–20px 的贴纸尺寸；再往大或往小调都会改变手感" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "chip 用 right: 1920 − PX + CHIP_GAP / left: PX + PW + CHIP_GAP 贴着手机外缘定位； 改手机宽度 PW 后两侧 chip 自动跟随，但要确认长文案 chip 的外缘仍在 96px 安全边距内；屏内 feed 是假条目的占位内容，落地换真实截图时总高必须 大于「560px + 屏高」，否则滚到底露白；手机屏只有 ~390px 宽：单集卡标题控制在 ~18 个字符、元信息 nowrap + ellipsis，否则折行把卡片撑高；同心圆是实色叠放（不是描边圆环），层序必须由大到小 append， 顺序反了就只看得见最大那层；ACCENT（默认 sand 的赤陶 #c4552d）作用于屏内封面/进度条/播放键与 chip 图标， 换项目品牌色只改这一个变量即可换肤",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 5.6s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // Riso 套印冲击（上游  → light-emphasis）
  {
    id: "riso-print-hits",
    category: "light-emphasis",
    nameZh: "Riso 套印冲击",
    oneLineZh: "标题撞停瞬间裂成双色印版、抖两下后「啪」地套准，纸墨审美版的故障闪。",
    useWhenZh: "标题或卡片的命中强调；全片 1–2 次的单发高潮。",
    seconds: [2.88, 5.12],
    energy: "high",
    tags: ["effects","光影强调","typography","riso","print","hits"],
    intentZh: "RGB 色散是荧光屏语言、与纸墨调性相克；换成双色 riso 印版的 multiply 油墨感，冲击力一样但介质想象全变。",
    motionZh: "标题 8f 撞入撞停后裂成两版反向错位约 40px，44f 衰减震荡后硬切套准，接 scale 脉冲并盖下「ON REGISTER」圆章。",
    params: [
      { name: "双版", typical: "两色 riso 油墨：荧光粉 #ff4fa3 + 蓝 #1f5fc4（套准叠成深紫）。mix-blend-mode: multiply 叠在再生纸（#f3eee2 + 静态纸纤维/油墨颗粒）上，位移反向；套准即两版归零重合", feelZh: "multiply 叠出的重影就是\"油墨没对准\"；screen 叠加立刻变荧光故障；两版选互补色相、套准后叠成近黑最好，别用纯灰（读作阴影）" },
      { name: "错位包络", typical: "offset = A·cos(2πt/18)·exp(-t/60)，A=(20,8)px 两版反向（300px 标题）；帧 72 硬切归零", feelZh: "命门：套准是硬切跳变不是渐收——衰减到 ~11px 残余时啪地归零才有\"啪\"；纯渐收读不出套准一拍" },
      { name: "撞入", typical: "8f Easing.in(cubic) 从画外撞停，命中帧即裂版", feelZh: "裂版必须与撞停同帧——晚 2f 就读作两件事；再往大或往小调都会改变手感" },
      { name: "套准脉冲", typical: "归零帧 4f scale 1.03→1；同帧圆章 scale 1.5→1 盖下；命中帧整页 1.2% 顿挫 10f 回落", feelZh: "盖章的一拍；省略则套准无重量" },
      { name: "作用域", typical: "错版只作用标题，背景（太阳 / 版记 / 信息栏）保持套准", feelZh: "整画面全裂读作故障而非印刷；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "套准后 ≥40f 真静止", feelZh: "手感：套准后 ≥40f 真静止 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；错位幅度可感性判例（本批实渲）：词汇表原案 ±5px 在 1920 宽画面 正常速度下肉眼几乎不可见——单版 16px/总分离 32px 起步才可感（200–300px 大标题按 20px/40px）； 幅度存疑时做极端版给用户看（可感性优先）；本卡与 impact-feedback C（负片冲击帧）语义重叠——纸墨调性片子用本卡、 游戏/动漫调性用 C 式，同片不并用（P4）；错位方向一横一纵混合（x 为主 y 少量）更像没对准版；纯横向读作 左右晃动；300px 大字配 −0.045em 负字距时，相邻字形的横笔可能恰好相接（如 CRAFT 的 F→T 顶横）， 两边抗锯齿叠出一条发丝亮缝——给前一个字单独再收 ~0.01em 让两笔重叠即可",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 4s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 取景括号扫描（上游  → light-emphasis）
  {
    id: "scan-bracket-sweep",
    category: "light-emphasis",
    nameZh: "取景括号扫描",
    oneLineZh: "文档弹到画面中央、四角落下 L 形括号，一条扫描光带拖着渐变尾迹往复扫 5 趟。",
    useWhenZh: "「正在解析／校验这份内容」的过程镜头；文档类产品的能力演示。",
    seconds: [3.6, 6.4],
    energy: "low",
    tags: ["effects","光影强调","scan","bracket","sweep","取景括号扫描"],
    intentZh: "括号先框住检查对象，光带再往复宣布检查过程；命门是文档完全静止，一动就分不清是被检查还是在加载。",
    motionZh: "文档在 0–0.11 段从 scale 0.86 弹到 1，四角 34px 括号按 i*0.022 stagger 落位、带 8px 对角位移轻过冲；扫描在 t 0.17–0.95 严格 linear 切成 5 趟，趟内 inOutSine、末尾留 12% 停顿。",
    params: [
      { name: "文档弹入", typical: "scale 0.86→1，t 0→0.11 outCubic", feelZh: "起始值低于 0.8 就成了\"从远处飞来\"，弹入要小幅度才像 UI" },
      { name: "取景括号", typical: "臂长 34px、圆头描边 1.6px、外扩 −7px；stagger 0.022 / 各 0.055", feelZh: "四角同时出现读作静态边框；差 0.022 就够读出\"依次落下\"；再往大或往小调都会改变手感" },
      { name: "扫描趟数", typical: "PASSES=5，窗口 t 0.17→0.95 linear", feelZh: "调大或调小：3 趟不够读作\"往复\"，7 趟以上在 5s 内每趟太快" },
      { name: "趟内缓动", typical: "inOutSine + 末尾 12% 停顿", feelZh: "停顿是\"看清了这一趟\"的换气位；去掉就成了匀速来回摆；再往大或往小调都会改变手感" },
      { name: "光带", typical: "1.2px 光芯 + 柔辉 + ≤82px 拖尾 SCAN .2→0（multiply）", feelZh: "线太粗（>4px）读作遮罩边缘而不是光；拖尾用黑灰会读成脏污" },
      { name: "拖尾方向", typical: "下行 top:−tail / 上行 top:0，渐变一并翻转；tail 随速度", feelZh: "只翻其一 → 拖尾跑到运动前方，读作\"光在往回吸\"；定长拖尾换向时会整块跳到另一侧" },
      { name: "裁切层", typical: "与文档同 10px 圆角 overflow:hidden", feelZh: "漏到文档外就是\"扫画面\"不是\"扫文档\"；再往大或往小调都会改变手感" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "光带必须裁在文档 bbox 内，且圆角与文档一致——漏出一点就丢掉\"扫描 这份文档\"的语义；拖尾的 top 和 gradient 方向是两处独立写法，改扫描方向时必须同改， 漏一处就出现\"尾迹在前\"的反物理观感；括号的 34px 臂长与 −7px 外扩是按 300×178 的文档尺寸配的；换真实截图 要按新尺寸重算，臂长超过短边 1/4 就压住内容；两个颜色变量：INK（括号 + 正文）与 SCAN（光芯 + 柔辉 + 拖尾 + 行照亮），换肤只改这两个",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 5s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 扫描线逐块标注（上游  → light-emphasis）
  {
    id: "scanline-annotate-focus",
    category: "light-emphasis",
    nameZh: "扫描线逐块标注",
    oneLineZh: "扫描线自上而下匀速掠过页面，越过哪块下缘哪块就被取景框收拢对准，并贴出打字机标签。",
    useWhenZh: "「AI 正在读你的页面／品牌」的分析镜头；设计系统或品牌规范的拆解介绍。",
    seconds: [3.6, 6.4],
    energy: "medium",
    tags: ["effects","光影强调","scanline","annotate","focus","扫描线逐块标注"],
    intentZh: "把分析做成可见因果链：先扫到再弹框，顺序一旦错乱就变成预先编排的动画。",
    motionZh: "扫描线 6–80f 严格匀速走窗内 y −20→860（3px 光芯 + 140px 渐隐淡蓝洗色），触发帧由 bbox 下缘反算并按 4f 最小间隔钳制；框从外扩处弹簧收拢、一次约 8% 过冲，机器标签逐字打出。",
    params: [
      { name: "扫描线", typical: "74f 匀速，窗内 y −20→860", feelZh: "零缓动：加 ease 就读作\"有人在拖进度条\"；60f 以下标签来不及打完就扎堆" },
      { name: "触发换算", typical: "ft = SCAN0 + (y+h−Y0)/(Y1−Y0)·(SCAN1−SCAN0)", feelZh: "改扫描窗口只改 SCAN0/SCAN1/Y0/Y1 四个常量，触发自动跟随；再往大或往小调都会改变手感" },
      { name: "最小间隔", typical: "prev + 4f", feelZh: "同一行的 LOGO / NAV 会同帧弹；钳制后才逐个读得清；再往大或往小调都会改变手感" },
      { name: "取景框收拢", typical: "外扩 76px → 0，spring damping 15", feelZh: "按像素外扩而非按比例缩放：大小目标收拢量一致；外扩 <40px 看不出\"对准\"动作" },
      { name: "角标", typical: "臂长 40→26px、描边 3.5px", feelZh: "臂长超过目标短边 1/3 就变成完整边框，丢掉\"取景\"语义" },
      { name: "对焦闪", typical: "填充峰值 0.075", feelZh: "超过 0.12 在亮底上成一块灰盒，读作\"选中高亮\"而非对焦确认" },
      { name: "标签", typical: "ft+5 起、~2.2 字/帧、32px 等宽", feelZh: "滞后 5f 是\"框稳了才命名\"的因果；签条一次性画满宽再打字会露出空蓝条" },
      { name: "计数行", typical: "按 fired 实时统计，30px 等宽", feelZh: "写死时间轴的计数一改 bbox 就对不上；必须实时数；再往大或往小调都会改变手感" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。音效密度与画面节拍一致即可。",
    pitfallsZh: "扫描线触发时刻与目标 bbox 强绑定：换页面内容后 targets 的 x/y/w/h 要重测， bbox 是手动量的（不是自动量元素），留边约 12–16px；标签放置四选一（right / above / below / belowRight），宽度按等宽字数估算 CHAR_W = 0.6em； 词变长先查会不会压到相邻模块或顶出窗外——H1 这类宽目标标签放上方，右上角目标的标签右对齐放下方；亮场页面上扫描线和角标要用深而饱和的机器色；浅色辉光线在亮底上几乎不可见；与 scanline-assemble-flyin 分工：那张是\"扫到即装配\"（页面从空到有）， 本卡是\"扫到即标注\"（页面已存在，只做分析）",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 5s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 扫描驱动装配（上游  → light-emphasis）
  {
    id: "scanline-assemble-flyin",
    category: "light-emphasis",
    nameZh: "扫描驱动装配",
    oneLineZh: "蓝图画板上扫描线掠过，扫到哪个槽位哪件组件就从画外飞入过冲贴合，扫完整页恰好装完。",
    useWhenZh: "「页面自己生成」的开场；AI 建站、自动排版类产品的核心演示。",
    seconds: [3.74, 6.66],
    energy: "high",
    tags: ["effects","光影强调","scanline","assemble","flyin","扫描驱动装配"],
    intentZh: "扫描线是施工进度条、组件飞入是施工动作；扫完那一刻恰好装完最后一块，「扫描驱动装配」的因果才成立。",
    motionZh: "首帧就给出完整施工图与虚线槽位；扫描线 8–92f 匀速走板，落位帧由槽位下缘反算并按 4f 最小间隔钳制，组件提前 14f 起飞、与扫描线同时到位，overshoot 约 8% 贴合、旋转 ±2–7° 归零。",
    params: [
      { name: "扫描线", typical: "84f 匀速，画板 y −20→880", feelZh: "收工时刻要略晚于最后一块落位，才读作\"扫完即装完\"；再往大或往小调都会改变手感" },
      { name: "触发换算", typical: "land = SCAN0 + (y+h−Y0)/(Y1−Y0)·(SCAN1−SCAN0)", feelZh: "改扫描窗口只改四个常量；飞行时长 FLIGHT 是提前起飞量，去掉就变成\"扫过之后才动\"" },
      { name: "最小间隔", typical: "prev + 4f", feelZh: "下缘接近的 MEDIA / CTA 会同时落；钳制后才有\"一块一块\"的密度" },
      { name: "飞入位移", typical: "画外 260–980px，按组件所在方位定", feelZh: "位移小于 200px 读作\"抖一下就位\"，不是从画外来" },
      { name: "飞入旋转", typical: "±2–7°", feelZh: "超过 12° 就读作\"翻滚\"，贴合时不服帖；再往大或往小调都会改变手感" },
      { name: "飞入缓动", typical: "EASE.overshoot，14f", feelZh: "过冲是\"吸附贴合\"的手感；纯 ease-out 就成了滑入；再往大或往小调都会改变手感" },
      { name: "残影模糊", typical: "方向性 SpeedBlur 0.32×速度、≤18px，落定清零", feelZh: "各向同性 blur 读作失焦而不是速度；不清零会留一层永久糊；再往大或往小调都会改变手感" },
      { name: "落位角标", typical: "外扩 20→10px、臂长 22px，3f 亮 / 9f 落", feelZh: "角标是\"咬合\"的听觉替代品；整圈描边闪框读作调试框、且 7 次群发违反 Q4" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "触发时刻与 PLAN 里的槽位 box 绑定：换页面模板后每个组件的 box 要重测，否则组件在扫描线到达前就飞入；组件在 Fly 里以槽位为原点绝对定位；角标层是组件内部的 SVG（overflow:visible）， 组件自身若 overflow:hidden 会把外扩角标裁掉——媒体卡的裁切放在内层；页面底色\"刷出\"用的是画板表面的 linear-gradient mask（跟扫描线 y），蓝图网格是另一层； 两层都随扫描线走，别把网格也 mask 掉，否则扫描线下方会变成死黑；与 scanline-annotate-focus 共用\"扫描线即因果\"的逻辑；两张卡可以串联（先装配、后分析）， 但扫描线要换向或留空档，否则读作重复；页面内容为 video-shotcraft 的落地页（镜刻标志 + 字标导航、「Shoot the / launch film.」H1、样片镜头卡），强调色（电光蓝 / 青）取自 LOOKS.midnight，换肤改 L 即可",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 5.2s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 高能砸入三式（上游  → light-emphasis）
  {
    id: "slam-entrance-moves",
    category: "light-emphasis",
    nameZh: "高能砸入三式",
    oneLineZh: "金田透视急停、比分砸落、落点冲击波及邻卡——入场本身就是冲击。",
    useWhenZh: "主角卡或 KPI 卡的重拳入场；impact-feedback 管落位后的反馈，这张卡管入场的冲击。",
    seconds: [0.53, 4.67],
    energy: "high",
    tags: ["effects","光影强调","ui-entrance","slam","entrance","moves"],
    intentZh: "补齐力度上限：A 是方向感、B 是重量感、C 是传导感，三档口味按强调级选。",
    motionZh: "A perspective 260→1800px、rotate3d 62°→0、scale 1.8→1 甩入 18f，末 5f 过冲 +6° 弹簧弹平；B 卡从镜头前 scale 2.6、5° 六帧 ease-in 砸落，冲击环/火花/震屏/白闪同帧；C 冲击波按半径精算扫过邻卡，邻卡外推 34px、旋转 ±3.5° 阻尼弹回。",
    params: [
      { name: "A 甩入", typical: "18f：translateX −1350→0 走 EASE.snappy（急停），透视/扭转/缩放走晚收曲线 bezier(.62,0,.3,1) 16f——卡片\"扭着\"冲到位、最后几帧才拍平；按 x 速度给水平 SpeedBlur（0.2×速度、≤26px）+ 身后 7 条速度线", feelZh: "快于 12f 读不到鱼眼畸变，慢于 24f 泄劲；姿态与位移同曲线同时收，到位前几帧就已经平了，鱼眼感只剩第一帧" },
      { name: "A 落定", typical: "rotateY 15–20f 冲到 +6°，20f 起 spring(damping 16) 回 0 + 8px 震屏 2f + 48 道集中线 9f 向外退散 + 斜长影收正；卡内文字晚 3f 落定（片名 −10° skew 收正）", feelZh: "\"啪\"在过冲回弹那一下，不在位移结束；集中线超过 10f 读作特效贴纸；再往大或往小调都会改变手感" },
      { name: "B 砸落", typical: "0–9f 悬在镜头前（2.75→2.6、虚化 10px、半透看得见背景）→ 9–15f ease-in(quad) 砸到 0.965 → spring(damping 14) 回 1", feelZh: "ease-out 落地是\"放下\"，ease-in 才是\"砸\"；再往大或往小调都会改变手感" },
      { name: "B 三件套", typical: "冲击环直径 120→1500px/16f（白芯 9→1.5px + 金色柔辉）+ 14 片多边形玻璃/金箔碎片飞 280–580px（+16 道火花）+ 震屏 18px 指数衰减 5f（偏竖向）+ 2f 白闪", feelZh: "原案(720px/10px 尘/8px 震)全档不可感，实渲已 ×1.5–2；实黑粗环/黑方块尘读作\"贴纸\"；再往大或往小调都会改变手感" },
      { name: "B 解耦命门", typical: "环/尘的\"扩散\"用 out-cubic、\"消散\"用线性帧时间", feelZh: "同用 out-cubic 前段跑太快，刚扩开就淡没" },
      { name: "C 波及帧", typical: "前沿过邻卡中心距反解（环半径 100→1100/16f，514px 距 ≈ 落点后 3f）；包络 cos(t/2)·e^(−t/8)，40f 硬钳 0；推开瞬间按速度给水平拖影", feelZh: "邻卡与主卡同帧动读作整版抖动，晚 3f 才是\"被波及\"；再往大或往小调都会改变手感" },
      { name: "C 悬停蓄力", typical: "0–16f 主卡悬在空槽上方：上提 20px、scale 1.55→1.6（smooth）、槽内接触影随高度变实，再 16–22f ease-in(cubic) 砸进槽", feelZh: "悬停段死停读作\"卡住了\"；蓄力幅度大于 30px 就成了另一个动作" },
      { name: "景深", typical: "B/C 离镜头近（scale 大）时按高度给虚化（B ≤10px、C ≤7px），落地清晰", feelZh: "近镜头元素锐利反而读不出\"从镜头前砸下来\"；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "全部余波归零后真静止 ≥45f", feelZh: "重拳 hold 按平常两倍给（同 beat-cut A 判例）" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 用 video-shotcraft 的宣传内容调校（A 发布片首映卡 / B「Shotcraft vs Keyframes」终场比分 / C 成片规格页 Launch film 卡）——参数是调校起点非实战定稿， 首次实战须以真实素材回验；亮场（C）上冲击环要配一层白色压力盘打底、环本身用饱和强调色，暗场（A/B）用白芯 + 色辉； 亮底上的白环 / 暗底上的黑环都几乎不可见；三式都带震屏，震屏族（impact-feedback）同一镜头 只能有一个震源；三式互相之间同镜头也只能选一；声音强依赖：A 的\"啪\"、B/C 的音爆必须同帧钉（sound-design §4.5）， 无声版 B/C 的三件套读作\"卡在抽搐\"；C 式邻卡必须先驻场稳定 ≥15f 再被波及——邻卡自己还在入场时被推开， 因果链读不出来",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 2.6s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 暗场聚光显影三式（上游  → light-emphasis）
  {
    id: "spotlight-sweep-moves",
    category: "light-emphasis",
    nameZh: "暗场聚光显影三式",
    oneLineZh: "光到即亮、光走即暗：扫过、贴边泛光横摇、角落径向显影三种暗场显影。",
    useWhenZh: "暗色调品牌片里逐个介绍 UI 面板、黑场开场点亮界面、段落之间的光转场。",
    seconds: [3.24, 5.76],
    energy: "low",
    tags: ["effects","光影强调","ui-entrance","transition","spotlight","sweep"],
    intentZh: "黑场里聚光既是照明也是运镜和剪辑；命门是匀速——缓动会让光有「意图」，匀速才读作探照灯的机械扫掠。",
    motionZh: "三式共用贴边紫色辉光：A 光斑扫过时被照到的内容亮起、光走即暗；B 紫光贴边渗入并匀速横移；C 径向聚光从角落匀速扩张点亮全屏，移动与扩张严格 linear、半径终值不能前 1/4 就饱和。",
    params: [
      { name: "聚光移动/扩张", typical: "全程 linear、零缓动", feelZh: "匀速是命门——全程零缓动；加 ease 读作光有主观意图" },
      { name: "C 式半径终值", typical: "恰好在片尾覆盖全屏（1300@1080p/100f）", feelZh: "终值过大＝提前饱和假匀速：亮度采样须全程平滑爬升（实测 8/46/101/…/238）" },
      { name: "贴边光线辉光", typical: "3–4 层（blur26+blur9+亮芯+粉偏移）", feelZh: "层少读作细线描边；辉光要够亮够糊才是\"光\"" },
      { name: "光线锚定", typical: "严格贴 UI 边缘/顶边/logo", feelZh: "光线脱离边缘漂浮＝失去\"抚摸界面\"语义（A 式返工判例：定位丢失紫光跑到底边）；再往大或往小调都会改变手感" },
      { name: "显影罩", typical: "radial 渐变硬边略糊（feather ~15%）", feelZh: "边太硬像圆形遮罩；太糊没有\"照到/照不到\"的界线" },
    ],
    soundZh: "光效段铺 shimmer/sparkle 高频颗粒并压低中频让光可听；点亮瞬间用 reverse-swell 收到 impact。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 light-play-moves 分工：那张是元素/文字上的 光泽戏（sheen/辉光呼吸）；本卡光是运镜和剪辑（显影/谢幕/转场）， 光决定观众看什么；三式重做判例：聚光扫过必须带贴边光线同行（v1 只有显影罩被裁 \"改改再看\"——裸聚光没有身份，贴边紫光才是这个手法的签名）；原片（clickup-30）光线转角有一瞬彩虹色散，demo 未做；实战可 在转角帧加 1–2f 色散层提质感",
    recipe: {
      css: ".ms-glow{background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 62%);mix-blend-mode:screen;animation:ms-glow 4.5s ease-in-out infinite alternate}@keyframes ms-glow{from{opacity:.45;transform:scale(.96)}to{opacity:.85;transform:scale(1.04)}}",
    },
  },
  // 间距拨盘驱动布局（上游  → interaction）
  {
    id: "autolayout-gap-dial",
    category: "interaction",
    nameZh: "间距拨盘驱动布局",
    oneLineZh: "间距徽章逐格跳动，一排链接块同帧被推开、测量线实时拉长——一个参数驱动整套布局的可视化。",
    useWhenZh: "设计工具或低代码产品「改一个数、界面跟着动」的卖点镜头；需要设计工具语感的品类包装。",
    seconds: [3.6, 6.4],
    energy: "medium",
    tags: ["interaction","交互演示","autolayout","gap","dial","间距拨盘驱动布局"],
    intentZh: "把「参数改了、UI 变了」的因果拍成连续镜头：数字是缰绳、布局是马，而不是剪掉因果的前后对比。",
    motionZh: "gap 一个参数重算块位置、测量线宽、徽章中心与顶部刻度尺；先预备回收 12→6（10f），去程 6→104 走 34f 不对称 in-out，屏息 20f，回程用 spring(damping 9、stiffness 80、mass 1.1) 故意过冲到起点以下再回稳。",
    params: [
      { name: "gap 幅度", typical: "12→104px（原片 20→24，demo 按裁决加大）", feelZh: "原片幅度肉眼几乎不可感——可感性判例：看不出就加大做极端版；实战至少 4–5 倍行程" },
      { name: "预备", typical: "12→6，10f swift", feelZh: "先收后放给主动作蓄力；回收 >30% 读作数值抖动；再往大或往小调都会改变手感" },
      { name: "去程时长", typical: "34f swift", feelZh: "快了读作抽搐；慢过 60f 数字跳动和位移的绑定感松掉" },
      { name: "屏息 hold", typical: "20f", feelZh: "让观众读清\"最松\"的那一帧；<12f 读不到峰值；再往大或往小调都会改变手感" },
      { name: "回程弹簧", typical: "damping 9 → 过冲到起点以下再回稳（过冲段 ×0.45，最紧约 7px）", feelZh: "过冲是\"松手回弹\"的手感来源；damping ≥13 直落可惜；再往大或往小调都会改变手感" },
      { name: "数字步进", typical: "步进 2 + 跳数 scale 脉冲 0.06 × 速度门限", feelZh: "逐 1 跳太碎读作毫秒表；步进是\"拨盘咔哒\"的颗粒感" },
      { name: "运动模糊", typical: "横向 stdDeviation = min(9,", feelZh: "手感：横向 stdDeviation = min(9, 只是起点，再往大或往小调都会改变节奏与力度" },
      { name: "标注几何", typical: "延长线 58px、测量线钉块底 +74px、徽章钉缝隙中心", feelZh: "标注必须随 gap 实时重算——任何一处滞后即穿帮" },
      { name: "块宽", typical: "不等宽（252/206/278/268/220，高 120）", feelZh: "等宽读作示意图；不等宽才像真导航；再往大或往小调都会改变手感" },
    ],
    soundZh: "交互反馈用真实感的 click/switch/pop，点击帧卡在动作最紧处；悬停与滚动只留很轻的 UI 底噪。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；数字与位移必须同源同帧：徽章显示值和块坐标都从同一个 gap 派生，分开动画哪怕差 1f，\"参数驱动\"的信任即碎；demo 顶部大读数 + 拨盘刻度尺与布局同源同帧，实战里若画面已有真实工具面板（检查器数值框）就删掉大读数，别双重报数；同族扩展：gap 只是一维，radius/padding/rotation 同语法可换参数——但一镜只拨一个参数，两个以上读作乱调；框选描边+手柄是\"设计工具语义\"借用（figma/framer 母语），非设计工具受众的片子慎用，读不懂框选就只剩块在挪",
    recipe: {
      css: ".ms-hit{transition:transform .12s cubic-bezier(.34,1.56,.64,1),background-color .2s ease}.ms-hit:active{transform:scale(.86)}.ms-hit.is-selected{transform:scale(1.04)}",
    },
  },
  // 内容物化上画布两式（上游  → interaction）
  {
    id: "canvas-materialize-moves",
    category: "interaction",
    nameZh: "内容物化上画布两式",
    oneLineZh: "面板表格行沿上抛弧线飞出、跨容器变形成画布卡片，或 prompt 打字后节点逐层弹出、连线先于节点生长。",
    useWhenZh: "AI 或协作工具「生成结果落到画布上」的叙事段落：A 讲已有内容换存在形态，B 讲从一句话长出一棵结构。",
    seconds: [5, 6],
    energy: "medium",
    tags: ["interaction","交互演示","ui-entrance","canvas","materialize","moves"],
    intentZh: "补上「内容离开容器、在开放画布上物化成新实体」的词汇：画布是舞台，生成物是登台的演员。",
    motionZh: "A 光标逐个打勾、按钮按下后三行先拔起再沿上抛弧线错峰飞出，行与卡两形态在一条 spring 上同步插值（位置/宽高/圆角/内容布局），落位带倾角与压扁；B prompt 逐字敲完后滴线接根，2 子→4 孙逐层从端口拉出，折角连线带彗星头先行 10f，相机从特写拉远揭示全树。",
    params: [
      { name: "A 打勾", typical: "14/24/34f 逐个（光标 swift 弧线逐个点中），spring(damping 11, stiffness 300) pop + 勾线 7f 描出", feelZh: "打勾是\"预告\"，全删观众不知道要飞谁；同帧齐勾读作静态已选；再往大或往小调都会改变手感" },
      { name: "A 起飞错峰", typical: "按钮 52f 按下，三行 56/62/68f 拔起（4f：放大 2% + 阴影加深）后起飞（错峰 6f）", feelZh: "同帧齐飞读作复制粘贴；错峰 >12f 尾行像掉队；不拔起直接飞读作被删除；再往大或往小调都会改变手感" },
      { name: "A 飞行插值", typical: "spring(damping 17, stiffness 95, mass 0.9)；位置走二次贝塞尔，中点上抬 220px；宽高晚 3f 收敛", feelZh: "直线飞读作平移不读作\"倒出来\"；中点抬 <100px 弧线感消失；尺寸与位置同步则少了\"父先子后\"的重量" },
      { name: "A 形态迁移", typical: "行 626×104 → 卡 486×300，圆角 18→24，rowOp 在 us 0.08→0.4 灭、cardOp 在 0.5→0.8 亮", feelZh: "两套内容交叉淡化必须错开——中段两态同显即穿帮；再往大或往小调都会改变手感" },
      { name: "A 落位倾角", typical: "−2.5 / 1.8 / −1.2°，落地 6f scaleY 0.97 压扁回弹", feelZh: "全正读作网格排版；>4° 读作散落故障；再往大或往小调都会改变手感" },
      { name: "A 速度模糊", typical: "SpeedBlur amount 0.32、max 14（按弧线速度方向）", feelZh: "只在飞行段；落定后归零；再往大或往小调都会改变手感" },
      { name: "B 打字", typical: "每字 0.95–1.2f 不均匀、空格停 1.7f；敲完 prompt 条描边转紫确认，+4f 按下提交键", feelZh: "匀速打字读作机器；无确认态则\"敲完\"与\"开始生成\"之间没有因果扣；再往大或往小调都会改变手感" },
      { name: "B 相机", typical: "开场 1.3× 推近 prompt 居中；提交后 72f smooth 拉远到 1.0", feelZh: "不推近则前 2s 画面下半空着；拉远要与级联同时进行，树长在镜头\"退\"出来的空间里" },
      { name: "B 级联时序", typical: "根 = 提交 +14f，层间隔 22f、同层兄弟错峰 5f；节点 spring(damping 14, stiffness 190)，缩放原点 = 顶边中点（从端口拉出）", feelZh: "层间隔 <12f 读作一次性全出；兄弟同帧读作复制；中心缩放读作弹窗；再往大或往小调都会改变手感" },
      { name: "B 连线先行", typical: "SVG 圆弧折角 path（父底端口→中线→子顶端口）描线 16f ease-out，比子节点早 10f；线头一颗彗星光点", feelZh: "\"线牵出节点\"是因果感来源；线晚于节点就成了补笔；再往大或往小调都会改变手感" },
      { name: "B 收尾呼吸", typical: "末节点 +22f 起，以树心为原点 scale 1→1.03→1（smooth，28f），背后极光同步亮一档", feelZh: "呼吸是\"成树\"的句号；>1.06 读作缩放故障；再往大或往小调都会改变手感" },
    ],
    soundZh: "交互反馈用真实感的 click/switch/pop，点击帧卡在动作最紧处；悬停与滚动只留很轻的 UI 底噪。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 chart-live-moves 分工：那卡是数据图表自身的活性（流线/点阵/爆轴）， B 式是结构图的诞生过程——图活着≠图正在被生成，别拿 B 式去演已有图表；A 式行槽必须塌陷成虚线留白——行飞走后原位完好如初，\"迁移\"就退化成 \"复制\"，语义全失；A 式交叉淡化窗口（rowOp 灭于 u≈0.45 前、cardOp 亮于其后）是防穿帮的 命门；spring 有过冲，u 可能短暂 >1，内容 opacity 都要 clamp；B 式呼吸原点必须是树的视觉重心（demo 960,620）而非画面中心， 不然读作整屏 zoom",
    recipe: {
      css: ".ms-hit{transition:transform .12s cubic-bezier(.34,1.56,.64,1),background-color .2s ease}.ms-hit:active{transform:scale(.86)}.ms-hit.is-selected{transform:scale(1.04)}",
    },
  },
  // 单选灰闪反黑（上游  → interaction）
  {
    id: "chip-grid-single-select-blackout",
    category: "interaction",
    nameZh: "单选灰闪反黑",
    oneLineZh: "五个 chip 逐个淡入，选中帧先插一帧灰闪、数帧内反黑，其余 chip 降到 18% 但位置锁死。",
    useWhenZh: "单选、套餐、档位选择的交互演示；「选了它之后会怎样」的因果镜头；价格结算链路。",
    seconds: [3.96, 7.04],
    energy: "low",
    tags: ["interaction","交互演示","chip","grid","single","select"],
    intentZh: "把真实 UI 的 :active→:selected 两级状态拆开演：观众看到手指按下、系统确认，而不是一次渐变。",
    motionZh: "5 个 chip 分 3+2 两行、按 3f 间隔 snappy 升起；光标 26–54f 走弧线移到目标、56f 按下，仅该帧盖 rgba(120,128,146,.5) 灰闪；57–62f linear 反黑并长出对勾，黑 chip 做 1→1.04→1 极轻回弹、随后上移收窄并升起结算价。",
    params: [
      { name: "入场", typical: "8f 起、间隔 3f、各 16f snappy", feelZh: "调大或调小：5 个 chip 在 1s 内铺完，把时间留给选中段；再往大或往小调都会改变手感" },
      { name: "选中时刻", typical: "FS = 56f（约全片 1/3）", feelZh: "前段读题、后段看结果；早于 40f 观众还没读完选项；再往大或往小调都会改变手感" },
      { name: "灰闪", typical: "1 帧，rgba(120,128,146,.5)", feelZh: "就一帧：给 2 帧以上就读作 hover 高亮，不是按下" },
      { name: "反黑", typical: "57→62f linear（5f）", feelZh: "linear 是故意的：加 ease 会让\"变黑\"这件事有过程感，太软" },
      { name: "按压回弹", typical: "1 + sin(pr·π)·0.04，跨 9f", feelZh: "调大或调小：0.04 是极轻；到 0.1 就成了弹跳按钮，抢戏" },
      { name: "余项降级", typical: "降到 18%，位置 transform:none", feelZh: "位置锁死是命门：降到 18% 仍在原位，才读作\"没被选中\"而非\"消失了\"" },
      { name: "收束时刻", typical: "101f（选中后≈1.5s）起，18f smooth in-out", feelZh: "调大或调小：1.5s 是让观众看清选中态的最短驻留；缩到 0.5s 就赶" },
      { name: "上移收窄", typical: "到 y=330、scale→0.88，横向补回中线", feelZh: "不补中线的话上移后会偏在左边，读作\"被拖走\"；缩过 0.85 字低于 32px" },
      { name: "结算顺序", typical: "原价 → 划线 → 现价 → 省额胶囊，间隔 8–10f", feelZh: "先给旧价再划掉，观众才读得到\"变便宜了\"的因果" },
    ],
    soundZh: "交互反馈用真实感的 click/switch/pop，点击帧卡在动作最紧处；悬停与滚动只留很轻的 UI 底噪。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "选中 chip 的回中线位移由固定 chip 宽算出（不运行时测量 offsetWidth）——改文案时要同步改宽度表， 否则字溢出或上移后偏离中线；其余 chip 的 transform 必须显式写 'none'，不能靠 flex 自动重排，否则余项归零时会横向滑动；占位内容：5 条计费周期选项名（Annual billing … Nonprofit rate）+ 结算「$42.00 → $34.44/mo、Save 18%」， 落地全部替换；选项名过长会撑破固定宽（第三条 \"Two-year commitment\" 是长名压力测试）",
    recipe: {
      css: ".ms-hit{transition:transform .12s cubic-bezier(.34,1.56,.64,1),background-color .2s ease}.ms-hit:active{transform:scale(.86)}.ms-hit.is-selected{transform:scale(1.04)}",
    },
  },
  // 协作光标群演（上游  → interaction）
  {
    id: "collab-cursor-moves",
    category: "interaction",
    nameZh: "协作光标群演",
    oneLineZh: "五枚具名彩色光标错峰飞入后双频漂移，其中一枚停下打字，结尾全员聚拢围观。",
    useWhenZh: "协作、多人主题的画布场景：给画面铺一层「团队在场」的温度。",
    seconds: [3.74, 6.66],
    energy: "low",
    tags: ["interaction","交互演示","collab","cursor","moves","协作光标群演"],
    intentZh: "把带名牌的协作光标从「操作工具」升格成演员：SVG 加名牌成本极低，却是「协作」主题最便宜的视觉论证。",
    motionZh: "5 枚光标错峰 spring 飞入白板，双频正弦漂移驻场，其中一枚挂在插入点打出简报卡标题做 cameo，结尾全员 smooth 聚拢围观；头像组同帧弹出、便签带作者色。",
    params: [
      { name: "A 入场", typical: "5 枚 delay 2/7/11/16/22f 错峰，spring(damping 15, stiffness 80)；名牌晚 10f 淡入+上浮 12px；右上头像组同帧弹出（槽宽随弹出长）", feelZh: "名牌跟光标同帧出现读作贴纸；随减速淡入才是\"人到了自报家门\"" },
      { name: "A 漂移", typical: "双频正弦叠加（0.055/0.021 rad/f，每枚相位不同），幅度 ±40/26px", feelZh: "单频正弦读作钟摆；双频不同相才是\"人手的随机\"；再往大或往小调都会改变手感" },
      { name: "A 打字 cameo", typical: "48–104f 打 29 字（1.6–2.4f/字确定性抖动，空格后多停 0.9f）；光标箭头挂在行内插入点锚点上，换行也跟着走；打字时手稳（漂移压到 0）", feelZh: "箭头和插入点分开算位置必错位；行内零宽锚点让浏览器排版替你算；再往大或往小调都会改变手感" },
      { name: "A 聚拢", typical: "98f 起 28f smooth 到卡片四周围观位（不压标题和眉题），漂移幅度衰减到 25% 保留", feelZh: "聚拢后漂移不能归零——完全静止的光标群读作死机；再往大或往小调都会改变手感" },
    ],
    soundZh: "交互反馈用真实感的 click/switch/pop，点击帧卡在动作最紧处；悬停与滚动只留很轻的 UI 底噪。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 在手搓画面上调校通过（瓷白白板 + 便签 + 简报卡，板名挂 video-shotcraft 标志，标题 \"Ship a launch film by Friday.\"）——参数是调校起点非实战定稿， 首次实战须以真实素材回验；名牌颜色=身份编码，全片必须一致（蓝=Designer 就一直蓝）；中途换色观众会以为换了人；换标题文案时保持字数与空格数，打字节奏（每字抖动按下标取、空格多停）与收尾帧才不变；漂移光标永远不许盖住正在阅读的主内容——氛围层要让戏，漂移范围避开主体安全区；与 cursor-flyover 分工：那是光标\"操作 UI\"（点击有 payload），本卡光标\"表演给你看\"（位移即剧情）；光标要点东西时回那张卡",
    recipe: {
      css: ".ms-hit{transition:transform .12s cubic-bezier(.34,1.56,.64,1),background-color .2s ease}.ms-hit:active{transform:scale(.86)}.ms-hit.is-selected{transform:scale(1.04)}",
    },
  },
  // 玻璃胶囊听写（上游  → interaction）
  {
    id: "glass-pill-dictation-typing",
    category: "interaction",
    nameZh: "玻璃胶囊听写",
    oneLineZh: "定宽玻璃胶囊略大弹出后缓落，内部左淡右浓铺一层暖光；光标先走，打字时暖光随进度退去。",
    useWhenZh: "语音或 AI 输入框的登场；「跟它说话」的交互提示；高能段之间的一个安静过渡拍。",
    seconds: [2.38, 4.22],
    energy: "low",
    tags: ["interaction","交互演示","glass","pill","dictation","typing"],
    intentZh: "用「光随输入熄灭」讲一件小事：待命时它发光等你说话，你一开口它就把光让给文字。",
    motionZh: "胶囊 1240×132 定宽不随打字伸缩，scale 1.25→1 用 20f 强 ease-out 落位、opacity 前 2f 就满、落位前 14f 带 6px→0 景深虚化；56px 听写字匀速打出，内嵌暖光与环境光随进度渐渐退成中性磨砂。",
    params: [
      { name: "胶囊定宽", typical: "1240px（≈整句宽度 1.8 倍）", feelZh: "定宽是关键：随字伸缩会读作 chip 而不是输入条；再往大或往小调都会改变手感" },
      { name: "出场缩放", typical: "scale 1.25→1，snappy 20f", feelZh: "调大或调小：1.25 倍是\"从观众面前落回去\"的量；1.5 倍就成了 pop 弹窗；再往大或往小调都会改变手感" },
      { name: "opacity 时序", typical: "前 2f 跳满（早于缩放落位）", feelZh: "同步淡入会让它像\"渐渐出现\"，失掉那一下轻微的实感" },
      { name: "内嵌光", typical: "90deg、0 → .18@38% → .62@78% → .95@100%", feelZh: "光必须在胶囊内部；改成外 glow 就成了\"待通知\"而不是\"待输入\"；再往大或往小调都会改变手感" },
      { name: "打字", typical: "28 字符，f8 起 2f/字匀速", feelZh: "加 ease 就读作\"有人在犹豫\"；听写是匀速的" },
      { name: "光熄灭", typical: "1 → 0，f10→f72 smooth", feelZh: "与打字同窗口是全片唯一的因果：光让位给文字；再往大或往小调都会改变手感" },
      { name: "环境光跟随", typical: "背后暖光 0.15+0.6g、地面反光 0.22g", feelZh: "只熄胶囊、环境不变，亮场里\"光退\"会读不出来" },
      { name: "声波竖条", typical: "5 根、±2.4px", feelZh: "幅度到 6px 就成了\"正在录音\"的活跃态，与\"待命\"矛盾；再往大或往小调都会改变手感" },
      { name: "光标", typical: "f2 先行、f66–74 撤", feelZh: "光标先于文字出现，是\"输入框已就绪\"的信号；再往大或往小调都会改变手感" },
    ],
    soundZh: "交互反馈用真实感的 click/switch/pop，点击帧卡在动作最紧处；悬停与滚动只留很轻的 UI 底噪。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "backdrop-filter 只晕它背后的层：暖色光斑必须放在胶囊之下（同一层叠上下文里先画）， 光斑离胶囊太远时磨砂看起来就是一块平白板；亮场里光的明暗对比远小于暗场：内嵌光要给到杏色 .95 的饱和度，并让背后环境光一起退，否则\"光退\"不成立； 要做暗场版，把舞台换回近黑、光色降饱和即可，曲线不用动；声波竖条是持续呼吸（不受 g 控制），首尾帧高度不同——用作 loop 素材时把频率调成 2π/时长 的整数倍；打字进度 floor(p·len + 1e-6)，那个 epsilon 是防止末字符在整点因浮点误差不出现，别删；WARM / APRICOT 两个变量是内嵌光、外泛光、环境光、按钮共用的品牌色，换项目只改这两个",
    recipe: {
      css: ".ms-hit{transition:transform .12s cubic-bezier(.34,1.56,.64,1),background-color .2s ease}.ms-hit:active{transform:scale(.86)}.ms-hit.is-selected{transform:scale(1.04)}",
    },
  },
  // 话题词实体化（上游  → interaction）
  {
    id: "hashtag-to-pill-materialize",
    category: "interaction",
    nameZh: "话题词实体化",
    oneLineZh: "居中打出 #word，1 帧硬切变成胶囊标签，hold 后缩小左移归位，再 1 帧硬切揭示成品页。",
    useWhenZh: "标签、分类、关键词功能的演示段；「输入→变成 UI 实体→归位到成品」的三段式叙事。",
    seconds: [1.2, 21.5],
    energy: "medium",
    tags: ["interaction","交互演示","typography","hashtag","pill","materialize"],
    intentZh: "实体化用 1 帧硬切而不是 morph：硬切给「啪，成了」的确定感，任何渐变都会把实体软化成特效。",
    motionZh: "打字 4–6f/字带确定性抖动、实心光标恒亮不闪；实体化是 1 帧硬切（文字与光标整层消失、同帧出现等大胶囊），仅允许 3f 1.03→1 微落定；胶囊 hold 约 0.6s 后同曲线缩小左移（约 0.55x、14f）落到标签位，再 1 帧硬切揭示成品页。",
    params: [
      { name: "打字节奏", typical: "4–6f/字（原片 ~6 字/秒），mulberry32 抖动", feelZh: "均匀间隔读作机打；光标必须恒亮（原片实测不闪烁）" },
      { name: "实体化", typical: "1 帧硬切（原片帧级实测无任何过渡）+ 3f 1.03→1 微落定", feelZh: "加淡入/展开立刻降级成普通 morph；微落定 >4f 读作弹跳" },
      { name: "胶囊几何", typical: "740×236@1920（原片实测 493×157@720p ×1.5），无描边", feelZh: "胶囊要\"宽大过头\"才有实体感；加描边读作按钮" },
      { name: "hold", typical: "~18f（0.6s，原片实测）", feelZh: "<12f 观众没看清胶囊长啥样就飞了" },
      { name: "缩移", typical: "~0.55x（原片实测 273/493）、14f、bezier(0.5,0,0.25,1)", feelZh: "缩放与位移必须同曲线；分开调会读作两个动画" },
      { name: "揭示", typical: "落位 +3f 再 1 帧硬切全页", feelZh: "揭示若做转场，第二记硬切没了，骨架塌一半；再往大或往小调都会改变手感" },
    ],
    soundZh: "交互反馈用真实感的 click/switch/pop，点击帧卡在动作最紧处；悬停与滚动只留很轻的 UI 底噪。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 typewriter-moves（打字呈现）、ui-to-brand-morph（渐变变形成形） 撞领域：本卡命门是硬切实体化非渐变变形——只要你想加过渡， 就该去用那两张卡而不是改这张；早期版本曾杜撰\"胶囊飞入下方滑入笔记卡\"段，原片对照证伪已砍； 别复活飞行段；transformOrigin 默认 50% 50% 会让缩放落位中心漂移 (1−s)×半宽， 必须 origin 0 0 + translate 到目标中心再 scale（demo 内注释）；与原片残余差距：Futura 回退字重、揭示帧正文间距 ~10px 级别偏差； 节奏与硬切时点已密帧对齐。demo 内容已换成 video-shotcraft 的世界 （原片 \"#music\" + 音符 → \"#shots\" + 场记板图标，成品页 \"My favorite shots\"）， 话题词与原词等长，胶囊几何不变",
    recipe: {
      css: ".ms-hit{transition:transform .12s cubic-bezier(.34,1.56,.64,1),background-color .2s ease}.ms-hit:active{transform:scale(.86)}.ms-hit.is-selected{transform:scale(1.04)}",
    },
  },
  // 滚轮选择器（上游  → interaction）
  {
    id: "picker-carousel-feature-cycle",
    category: "interaction",
    nameZh: "滚轮选择器",
    oneLineZh: "焦点药丸不动、内容从它背后穿过，每项 outQuint 减速吸附后完全静止，距离分层控制透明度、字号与灰度。",
    useWhenZh: "逐个念出功能名或场景名的列表镜头；「选一个」的交互演示；移动端 picker 控件展示。",
    seconds: [2.59, 4.61],
    energy: "medium",
    tags: ["interaction","交互演示","picker","carousel","feature","cycle"],
    intentZh: "把「选择」的物理感做出来：焦点框固定、内容在滚动并被吸住，停稳几帧才读作「这一项被选中了」。",
    motionZh: "视口 300×170、焦点药丸固定第 3 行；全片切成 5 步匀速推进，步内 outQuint、HOLD=5/14 尾段完全不动（每步约 0.65s=走位 0.42s+静止 0.23s）；透明度、字号、灰度按与中心距离三通道同时衰减。",
    params: [
      { name: "行高/可见行数", typical: "rowH 34px × 5 行，焦点在第 3 行", feelZh: "可见行数必须是奇数，否则焦点行不在视觉正中；再往大或往小调都会改变手感" },
      { name: "步数", typical: "STEPS=5，窗口 t 0.05→0.95 匀速", feelZh: "调大或调小：5 拍是 3.6s 的舒适上限；7 拍每拍就压到 0.46s 读不清；再往大或往小调都会改变手感" },
      { name: "HOLD", typical: "5/14 ≈ 0.357（每步尾段静止≈0.23s）", feelZh: "命门：HOLD 归零就变成匀速滚动，完全丢掉\"吸附\"语义；再往大或往小调都会改变手感" },
      { name: "吸附缓动", typical: "outQuint（作用在 local/(1−HOLD) 上）", feelZh: "outQuint 的急减速就是\"被磁铁吸住\"的手感，outCubic 太软" },
      { name: "opacity 衰减", typical: "1 → 0.55（d≤1）→ 0.18（d≤2）", feelZh: "相邻行留 0.55 是让观众感知\"上下还有内容\"；降到 0.3 就孤立了" },
      { name: "fontSize 衰减", typical: "17→14px，按 min(1, d/2)", feelZh: "字号差是第二重景深；只做透明度会显得扁" },
      { name: "图标可见性", typical: "max(0, 1 − d·1.6)", feelZh: "只有焦点行带图标，是\"当前项\"的额外标记；再往大或往小调都会改变手感" },
      { name: "药丸呼吸", typical: "scaleY 1→1.06→1，落定后 0.6·HOLD 内走完", feelZh: "调大或调小：0.06 已到上限；再大就读作药丸自己在动，抢了内容的戏" },
    ],
    soundZh: "交互反馈用真实感的 click/switch/pop，点击帧卡在动作最紧处；悬停与滚动只留很轻的 UI 底噪。音效密度与画面节拍一致即可。",
    pitfallsZh: "药丸必须是 translateY 零位移的固定层，scaleY 呼吸也不能带 位移，否则焦点框漂移，\"内容穿过焦点\"的语义立刻失效；距离衰减写在 fontSize 上会触发逐帧重排（行高固定所以布局不跳）， 行高若改成 auto 就会抖；rowH 必须写死；渐隐用 mask-image 做 alpha 遮罩，不要叠纸色色块：底色一旦是渐变/有光斑，色块遮罩就会露出矩形边界带；左外侧 24×24 的方形 app 图标（深底 + video-shotcraft 标志反白版）用 margin:-12px 0 0 -186px 相对画面中心定位；改视口宽度必须同改 186px；ITEMS 是 video-shotcraft 的 7 条功能名（\"Shot recipe cards\" 等），换成别的功能名时 字长变化会影响居中观感——单行超过 300px 就要缩字号而不是换行",
    recipe: {
      css: ".ms-hit{transition:transform .12s cubic-bezier(.34,1.56,.64,1),background-color .2s ease}.ms-hit:active{transform:scale(.86)}.ms-hit.is-selected{transform:scale(1.04)}",
    },
  },
  // 分段控件特写（上游  → interaction）
  {
    id: "segmented-thumb-hero",
    category: "interaction",
    nameZh: "分段控件特写",
    oneLineZh: "超大胶囊分段控件弹簧浮入，描边光标滑入按下，thumb 用 8f 滑到另一端，新图标 spring 弹出。",
    useWhenZh: "「模式切换、二选一」功能的宣告镜头；用一个 UI 微交互撑满一整镜的特写拍法。",
    seconds: [2.52, 4.48],
    energy: "medium",
    tags: ["interaction","交互演示","segmented","thumb","hero","分段控件特写"],
    intentZh: "把 segmented control 放大到 1080px 拍特写：thumb 那 8 帧位移本身就是「我们从 A 走到了 B」。",
    motionZh: "控件 1080×220 从下方 200px 弹簧浮入（damping 14、stiffness 120），阴影随落位从 24px 收到 12px；130px 描边光标 24f 滑入、按下做 0.86 回弹；thumb 严格 8f out-cubic，到位同帧新图标 spring(damping 10、stiffness 220) 过冲弹出、旧图标 6f 塌缩且宽度归零。",
    params: [
      { name: "控件尺寸", typical: "1080×220，thumb 内缩 16px", feelZh: "缩到 <600px 宽就不是特写了，thumb 位移读不出重量" },
      { name: "thumb 时长", typical: "8f Easing.out(cubic)", feelZh: ">14f 读作慢动作演示视频；<5f 读作瞬移，\"滑\"没了" },
      { name: "光标滑入", typical: "24f 从画外，ease-out", feelZh: "linear 或 <14f 读作光标被扔进来；起点必须画外；再往大或往小调都会改变手感" },
      { name: "按下", typical: "scale 0.86 + 涟漪 12f", feelZh: "无按下直接滑 thumb，因果链断，读作自动播放；再往大或往小调都会改变手感" },
      { name: "图标弹出", typical: "spring damping 10/stiffness 220", feelZh: "damping <8 弹三下抢 thumb 的戏；旧图标不收起文字会挤出控件；再往大或往小调都会改变手感" },
      { name: "收尾 hold", typical: "新态静置 ≥30f", feelZh: "切换完立刻切镜，\"新模式\"没被看清；再往大或往小调都会改变手感" },
    ],
    soundZh: "交互反馈用真实感的 click/switch/pop，点击帧卡在动作最紧处；悬停与滚动只留很轻的 UI 底噪。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 cursor-flyover 分工：那张是光标在完整页面里 点击推近（有上下文），本卡是控件脱离页面拍无背景特写——同片可共存， 但同一次点击别既拍页面版又拍特写版；图标塌缩用 width 归零而不是只 scale——只 scale 会留空位，文字不回流， 控件内出现\"幽灵缝\"（demo 里 width 与 scale 同步驱动）；二段以上（3+ 段）控件慎用：thumb 跨多段滑行 8f 太快读不出停靠， 拉长又破手感——本卡吃\"二选一\"最顺；涟漪圆环要 zIndex 压在 thumb 之上、圆心锁点击点——跟着 thumb 走 就成了 thumb 的拖尾，语义变错",
    recipe: {
      css: ".ms-hit{transition:transform .12s cubic-bezier(.34,1.56,.64,1),background-color .2s ease}.ms-hit:active{transform:scale(.86)}.ms-hit.is-selected{transform:scale(1.04)}",
    },
  },
  // 主题切换两式（上游  → interaction）
  {
    id: "theme-switch-moves",
    category: "interaction",
    nameZh: "主题切换两式",
    oneLineZh: "15° 斜向边界带扫过、经过处就地换肤，或命令面板收缩成亮点、涟漪从点荡开换肤。",
    useWhenZh: "深色模式、主题功能的叙事段落：让同一个 UI 在你眼前变色，而不是切到新场景。",
    seconds: [4.7, 5.2],
    energy: "high",
    tags: ["interaction","交互演示","theme","switch","moves","主题切换两式"],
    intentZh: "两种拍法：A 让同布局双主题共存一瞬，读作「同一个 UI 换肤」；B 让「命令引发换肤」的因果链完整可读。",
    motionZh: "A 从开关所在的右侧用 clip-path 15° 斜边 64f 扫过（bezier(.3,0,.35,1)），边界处浅色就地变深色，同时相机 30f 拉回全景；B 面板 CRT 关机式先纵向压成亮线再收成亮点、钉住 5f，圆形 clip 半径 6→1260px 强 ease-out 荡开，3px 白热环配珊瑚外辉、晚 4f 回声。",
    params: [
      { name: "深色版制作", typical: "对色板逐键手工映射（bg/card/border 各自定深色值）", feelZh: "滤镜反转出来的深色是错的（图像/头像全反）" },
      { name: "A 斜边超扫", typical: "斜线在世界坐标外扩 400px 计算多边形，终点越过左下角", feelZh: "不超扫角落残留浅色三角" },
      { name: "A 因果", typical: "扫场起点紧贴开关、按下后 ~6f 边界就扫过开关；相机从开关特写拉开", feelZh: "边界从远处出现或晚 10f 以上，读不出\"是这个开关引起的\"；再往大或往小调都会改变手感" },
      { name: "A 海报帧", typical: "相机全景到位（40f）早于晨昏线过中线（~44–50f）", feelZh: "拉开太晚 → 全景里看不到昼夜同屏，手法只剩特写" },
      { name: "A 坐实", typical: "扫完后夜里才有的光依次亮起（今日胶囊 / 此刻线 / 窗口轮廓光）", feelZh: "比 scale 0.99 更有语义；不要再叠全屏闪白" },
      { name: "B 因果钉扎", typical: "亮点在收缩点挂 5f（+ 横向余辉），涟漪圆心=该点坐标、起始帧=亮点结束帧", feelZh: "圆心错位/错帧就断了\"命令→换肤\"因果（组合命门）；再往大或往小调都会改变手感" },
      { name: "B 涟漪半径", typical: "终值 ≈ 圆心到最远角距离 × 1.1（demo 1260px）", feelZh: "终值给太大（如 2000+）曲线前段一闪而过，圆形读不出来" },
      { name: "B 浅色层", typical: "扫场完成后条件卸载", feelZh: "手感：扫场完成后条件卸载 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "交互反馈用真实感的 click/switch/pop，点击帧卡在动作最紧处；悬停与滚动只留很轻的 UI 底噪。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在为镜头设计的 video-shotcraft UI（A 发布周制作排期 / B 样片画廊）上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；两版布局必须逐像素一致——布局有出入就读作\"切换到另一个页面\"， 手法即失效；真实页面实战：深浅两版分别真实截图（Q1），不做滤镜假深色；一支片主题切换 ≤1 次：它是功能叙事不是转场，反复切读作演示事故；声音：A 扫场一声长 whoosh；B 回车一声确认 + 涟漪荡开接 whoosh （S4 拟音优先）",
    recipe: {
      css: ".ms-hit{transition:transform .12s cubic-bezier(.34,1.56,.64,1),background-color .2s ease}.ms-hit:active{transform:scale(.86)}.ms-hit.is-selected{transform:scale(1.04)}",
    },
  },
  // 打字筛选进详情（上游  → interaction）
  {
    id: "type-and-filter",
    category: "interaction",
    nameZh: "打字筛选进详情",
    oneLineZh: "在真实 UI 上逐字打字搜索，网格错峰收敛成一张卡，再点击穿透进详情页。",
    useWhenZh: "功能演示的「操作叙事」段；搜索、筛选、进入详情的任何交互链路。",
    seconds: [1.8, 3.2],
    energy: "medium",
    tags: ["interaction","交互演示","type","and","filter","打字筛选进详情"],
    intentZh: "让观众跟着做一遍：看清输入了什么、页面怎么响应、点了哪里；节奏必须像人手，不能像脚本。",
    motionZh: "相机贴近搜索框（zoom 2.0，输入字有效高约 30px）逐字符打字、光标常亮后闪烁；打完留一口气拉开到全景看网格收敛，非目标卡按阅读序错峰淡出下沉，目标卡滑到首行并浮起，指针滑到目标卡做双圈强调 ripple 点击，随后相机推进穿透进详情。",
    params: [
      { name: "打字速度", typical: "3f/字符（TYPE_START=128，\"nano-lab\" 8 字符 ≈149 收尾）", feelZh: "初版嫌快返工后的定稿值（\"unhurried\"）；交互演示按真人操作速度走（R3）" },
      { name: "呼吸位", typical: "打完到过滤 FILTER_START=160，留 ~11f（0.37s）", feelZh: "打完立刻过滤读作机器自动，观众跟不上因果；再往大或往小调都会改变手感" },
      { name: "光标", typical: "打字时常亮，之后 8f 周期闪烁；点击 176f，光标 185f 消失", feelZh: "打字中闪烁会读作卡顿；常亮→闪烁的切换本身就是\"打完了\"的信号" },
      { name: "过滤退场", typical: "25 张非目标卡按阅读序 0.4f 间隔错峰，各 5f 淡出+下沉 8px", feelZh: "同时消失读作页面崩溃；错峰哪怕只差 0.4f 也够；再往大或往小调都会改变手感" },
      { name: "目标卡滑位", typical: "10f 滑到首行槽位，bezier(0.35,0,0.2,1)，途中 sin 浮起 z 18px、scale +0.02、阴影随浮起变宽", feelZh: "终点必须是布局真实槽位（Q9），滑到画面中央悬停就假了；再往大或往小调都会改变手感" },
      { name: "点击确认", typical: "两圈同心强调色 ripple（起点差 3f、各 10f、半径 14→54/78）+ 3px 描边 + 40px 辉光，随后相机 16f 推进 zoom 2.2", feelZh: "单圈 ripple 太轻看不见；推进交棒给 flash-cut 盖住换页硬切（组件见 assets/lib/FlashCut.tsx，用法：from = 切点 − 5，跨骑硬切两侧各 5f）" },
      { name: "搜索框", typical: "页面底色补丁盖掉纹理里的 placeholder（保留放大镜图标），文字层叠上去打", feelZh: "直接在截图纹理上叠字会和烤入的 placeholder 重影" },
    ],
    soundZh: "打字段钉 keyboard.mp3 并按 Sequence 截 24f 与动作严格等长（S4）；点击钉 click-camera（全片最响 vol 0.6，S2 响度分层）；网格飞走钉 whoosh-fast。",
    pitfallsZh: "初版打字+过滤\"太快了\"被返工（R3）——交互镜头的第一版几乎总是偏快，起稿就按 3f/字符；过滤后目标卡若不归位到真实槽位、悬浮在网格上方，读作假（Q9，曾因此近乎整文件重写）",
    recipe: {
      css: ".ms-hit{transition:transform .12s cubic-bezier(.34,1.56,.64,1),background-color .2s ease}.ms-hit:active{transform:scale(.86)}.ms-hit.is-selected{transform:scale(1.04)}",
    },
  },
  // 录音胶囊声纹（上游  → interaction）
  {
    id: "voice-waveform-live",
    category: "interaction",
    nameZh: "录音胶囊声纹",
    oneLineZh: "64 根细竖条随说话起伏、停顿缩成点线，波形从右往左滚动，最后按钮回弹、波形塌缩提交。",
    useWhenZh: "语音输入或 AI 助手「正在听你说」的功能镜头；没有 UI 内容但需要持续活性撑画面的段落。",
    seconds: [0.7, 5.7],
    energy: "medium",
    tags: ["interaction","交互演示","voice","waveform","live","录音胶囊声纹"],
    intentZh: "功能性声纹：波形跟用户说话跳、是产品功能本身而不是 BGM 装饰，一段画面全靠这份活性撑住。",
    motionZh: "第 i 条采样时刻 = f−(N−1−i)·1.6，最右条是「现在」、历史从右侧滚出；条高 = 说话包络（说/停两档+音节噪声）×中部空间权重 sin^0.8×逐条 jitter，静默钳到 6px 点线；提交时按钮 3f 压缩回弹、波形 12f ease-in 塌缩到 0.06，麦克风呼吸环随包络外扩。",
    params: [
      { name: "条数/间隙", typical: "64 条，gap 5px（1240px 宽胶囊，声纹区 ≈820px）", feelZh: "少于 40 条读作均衡器；密过 90 条单条读不出起伏" },
      { name: "滚动速率", typical: "1.6 帧/采样点", feelZh: "快了历史刷太快像故障；慢了\"滚动感\"消失变成原地抖" },
      { name: "说停包络", typical: "seg 梯形 rise 5f / fall 7f；demo 说 15–57f、停 80–124f", feelZh: "停顿段必须真的塌成点线——没有\"停\"的对比，\"说\"就不成立；再往大或往小调都会改变手感" },
      { name: "音节噪声", typical: "0.55+0.45·noiseAt(t/4.5)", feelZh: "去掉音节层波形是平滑山丘，读不出\"一句话的顿挫\"；再往大或往小调都会改变手感" },
      { name: "中部权重", typical: "sin^0.8 空间包络", feelZh: "无权重全场等高像均衡器；指数 >1.5 中间独秀像单根跳" },
      { name: "静默钳位", typical: "max 6px 点线（点线用中性弱色，说话条用强调色渐变）", feelZh: "钳 0 波形消失读作断线；点线是\"在听但你没说\"；再往大或往小调都会改变手感" },
      { name: "提交塌缩", typical: "12f ease-in 到 0.06 + 按钮压缩回弹 3f", feelZh: "塌缩是\"这段话被收走了\"；淡出读不出提交语义" },
      { name: "转写节奏", typical: "词出现帧 = 该词音节起点（包络 rise 段内），8f 由虚到实", feelZh: "词比波形早出读作字幕先于声音；晚 10f 以上读作延迟识别；再往大或往小调都会改变手感" },
      { name: "收进气泡", typical: "22f EASE.swift 上移 + 缩到 0.72，气泡底 / 白字 10f 跟进", feelZh: "只淡出转写读不出\"发出去了\"；再往大或往小调都会改变手感" },
    ],
    soundZh: "交互反馈用真实感的 click/switch/pop，点击帧卡在动作最紧处；悬停与滚动只留很轻的 UI 底噪。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在 video-shotcraft 语音口述分镜（\"Shotcraft is listening\"）的暖色亮场上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；有音轨时波形必须跟人声走：片子若配了真旁白/人声，包络的说停段要对齐音轨的说停，错位一秒就穿帮；无人声配乐片才可用纯合成包络；demo 是亮场暖白实底胶囊（顶部 1.5px 内高光 + 两层落地影）；暗场片子换成 1.5px 渐变边玻璃胶囊即可，声纹参数不变；麦克风已是 SVG 线性图标（早期 emoji + grayscale 占位已换掉），实战按品牌图标库替换即可；声音：本卡画面就是\"声音的形状\"，配人声最顺；提交钮一声轻 pop + 塌缩配短促下滑音",
    recipe: {
      css: ".ms-hit{transition:transform .12s cubic-bezier(.34,1.56,.64,1),background-color .2s ease}.ms-hit:active{transform:scale(.86)}.ms-hit.is-selected{transform:scale(1.04)}",
    },
  },
  // 墨线品牌开场（上游  → opening-brand）
  {
    id: "brand-ink-open",
    category: "opening-brand",
    nameZh: "墨线品牌开场",
    oneLineZh: "十字准星墨线先描画，字标逐字压印、副标打字机敲出，完整静止满一秒后上浮消散。",
    useWhenZh: "品牌开场；任何「先立名号再进产品」的片头。",
    seconds: [2.02, 3.58],
    energy: "medium",
    tags: ["opening","开场与品牌","typography","brand","ink","open"],
    intentZh: "第一拍先给品牌记忆点：产品画面出现之前，观众先看清并记住名字，安静纸墨质感还要留一个完整静止时刻。",
    motionZh: "SVG 十字准星用 pathLength 描画（先竖后横）再淡出；字标逐字 letterpress：从大压到 1、blur→0，字底强调色短划闪过；kicker 打字机逐字出现、块状光标周期闪烁；lockup 静止满 1 秒后整体上浮缩小淡出，交棒下一镜。",
    params: [
      { name: "准星描画", typical: "竖线 0→9f、横线 8→18f，24→34f 淡出", feelZh: "描画完必须淡出，残留准星会和字标抢焦点；再往大或往小调都会改变手感" },
      { name: "字标逐字", typical: "第 i 字 delay=10+i·3、12f；scale 1.6→1（origin center bottom）+ blur 6px→0", feelZh: "\"opacity+位移/scale+blur→0\"是全片入场三件套定式，缺 blur 会显得硬；再往大或往小调都会改变手感" },
      { name: "kicker 打字机", typical: "0.7f/字符（28 起 ~43.4 完），光标 2f 周期闪、74f 停闪", feelZh: "调大或调小：0.7f/字符只适用于装饰性小字；正文交互打字要 3f/字符（对照 type-and-filter，用户嫌快返工过）" },
      { name: "品牌 hold", typical: "46→76 帧整整 1 秒", feelZh: "硬底线：用户两轮点名\"出现后延长停留1秒\"（R1）；短于 1s 必返工" },
      { name: "退场", typical: "7f 上浮 40px + 缩 12% + 淡出", feelZh: "退场快于入场——观众已读完，拖长反而泄气" },
    ],
    soundZh: "品牌落定钉 transition-soft（模板片钉在 f12），brand→dashboard 运镜钉 whoosh-fast（f78）。SFX 逐拍钉帧、声明式表管理（S2）；音色走电影系词汇，不用游戏 UI tap（S1）。",
    pitfallsZh: "hold 要给的是 wordmark 落定时刻，不是普通字卡/内容卡（R1）——曾把 hold 错加给普通内容卡后很快回滚；指代含糊的\"停留\"反馈先确认对象再动手（P3）；开场能量必须低起步：全片能量曲线低开→中段推进→outro 峰值，开场炫技会压死后面的爬升（对照 Q8 的能量曲线要求）",
    recipe: {
      css: "@keyframes ms-enter{from{opacity:0;transform:scale(1.08);filter:blur(6px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-enter{animation:ms-enter 2.8s cubic-bezier(.16,1,.3,1) both}",
    },
  },
  // 升降臂拉升揭示（上游  → opening-brand）
  {
    id: "crane-rise-reveal",
    category: "opening-brand",
    nameZh: "升降臂拉升揭示",
    oneLineZh: "开场怼在一行数据特写，相机沿 Y 轴减速升起后拉，行行涌入直到整面 dashboard 铺满全幅。",
    useWhenZh: "「从细节到全局」的开场定场；与从全局砸进单点的俯冲镜头互为镜像，两卡同片只用一方向。",
    seconds: [3.96, 7.04],
    energy: "high",
    tags: ["opening","开场与品牌","camera","data","crane","rise"],
    intentZh: "先让观众看清「这一行是什么」，再拉升揭示它只是整面墙的一格，用体量讲产品的丰富度。",
    motionZh: "transform-origin 固定左上，translate = 屏幕中心 − 对准点×scale；对准点与 scale 3.0→1.0 共用一条不对称缓动 bezier(0.2,0,0.25,1)，零速起步、19% 处达峰、临顶缓停。特写 hold 时只留被追踪一行实焦、其余压到 38%，起吊后约 26f 回满，逐行洗光与相机可见区上缘同帧触发。",
    params: [
      { name: "起点特写", typical: "scale 3.0，对准追踪行左段（镜头号 / 转场 63px 大字；取景下缘停在窗口底边上方，不露窗外）", feelZh: "hold ≥20f 让\"这是一行数据\"可读再起飞" },
      { name: "拉升", typical: "102f bezier(0.2,0,0.25,1)，scale 3.0→1.0", feelZh: "快于 80f 行洗光追不上；慢于 130f 中段拖" },
      { name: "对焦", typical: "非追踪行 38% → 100%，起吊后 26f", feelZh: "不压暗时特写里每行同权，观众不知道看哪一行" },
      { name: "行洗光", typical: "越线触发，强调色从行首掠过 + 细描边，~24f", feelZh: "洗光跟不上相机（固定间隔触发）立刻穿帮；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "满幅后不再补推，靠状态翻转让 hold 活着，静止 ≥30f", feelZh: "R1；满幅帧即标准构图；再往大或往小调都会改变手感" },
    ],
    soundZh: "入场用一条低频上行垫底，落定帧钉一记 impact；品牌 hold 段留白，不要铺满音乐。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在虚构数据的手搓产品窗口（video-shotcraft 渲染队列）上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；起点特写 = 一行内容被放大 3.2 倍盯着看，真实素材先过 审美准则 Q2 的高分辨率栅格化技法，低倍截图开场即糊；快速拉升段可包 CameraMotionBlur（参数见 deck-deal-flyin 运动模糊行）， 但只包前半程快速段——临顶慢速段包了会抹软文字（轮 #8 判例）； 半透明洗光叠层别放进 CameraMotionBlur（多重采样叠加出竖条伪影），单独一层同相机；与 drone-dive-landing 同片不并用（一升一降互为镜像，观众读作同一招）； 与 crane 语义最近的 tilt-reveal 未入库，别混称",
    recipe: {
      css: "@keyframes ms-enter{from{opacity:0;transform:scale(1.08);filter:blur(6px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-enter{animation:ms-enter 5.5s cubic-bezier(.16,1,.3,1) both}",
    },
  },
  // 数据地景开场（上游  → opening-brand）
  {
    id: "dataviz-landscape-open",
    category: "opening-brand",
    nameZh: "数据地景开场",
    oneLineZh: "暗场里多条支流线束汇入主干、虚构 ID 标签浮在线上，相机带重景深低速飞越。",
    useWhenZh: "品牌级抽象开场（数据宇宙隐喻），接亮场产品段或字标；与段落内的飞线连线叙事分工。",
    seconds: [5.76, 10.24],
    energy: "medium",
    tags: ["opening","开场与品牌","data","camera","dataviz","landscape"],
    intentZh: "把产品背后的数据世界拍成一片地景：支流线束汇入主干，暗示无数工作流汇成一个产品；真实感来自虚构标签与重景深。",
    motionZh: "主干由近及远 36f out-cubic 生长到消失点，支流从两侧画外错峰 4–6f 切向汇入；相机低空沿河道前飞并横向缓移，标签 f44–96 非均匀错峰立起，生长完的线上有脉冲流向汇点；末尾消失点亮起强调色光并落一行大标题，相机减速缓停 hold≥30f。",
    params: [
      { name: "线束规模", typical: "支流 8–14 条汇入 1 条主干（demo 11 条，含 1 条贴镜头掠过的近景支流）", feelZh: "超过 ~16 条读作屏保/科技模板；主干必须唯一（单主角原则的地景版）；再往大或往小调都会改变手感" },
      { name: "地景投影", typical: "线画在真透视地平面上：针孔投影 sx = 960 + F·(X−camX)/Z'、sy = 地平线 + F·camH/Z'，F 1100、相机高 220、地平线 0.39 帧高", feelZh: "平面 SVG 横移要手工凑三层视差；真投影的近大远小、视差、汇聚全部白给" },
      { name: "汇流拓扑", typical: "支流以 bezier 切向汇入主干（汇入点切线 = 主干切线），主干走向让消失点落在画面右 1/3", feelZh: "垂直相交读作电路图不是水系；消失点居中构图死板；再往大或往小调都会改变手感" },
      { name: "景深", typical: "按投影深度逐段分层：Z' <~1000 进模糊层（blur 11px、线宽 ×1.3）、中景锐利、Z' >2600 起雾化变淡；线宽 = 世界线宽·F/Z'", feelZh: "近景不虚焦则读作线框图；远景不雾化会在地平线挤成一团亮" },
      { name: "相机飞越", typical: "前飞 950 世界单位 / 180f，bezier(0.3,0.3,0.55,1)：开场即在飞、尾段减速缓停；叠横向缓移 −140→110", feelZh: "快了变追逐镜头（那是 crash-zoom 的活）；只前推不横移时远近错动弱" },
      { name: "线段绘制", typical: "每条线按弧长等距采样后逐段画（逐段线宽/透明度），butt 端帽", feelZh: "round 端帽在半透明线上每个接缝叠一圈，整条线读成串珠；再往大或往小调都会改变手感" },
      { name: "流动感", typical: "生长完成后沿线窄峰亮脉冲低速漂向汇点，只在中远景显形（近处一段在屏上很长，逐段明暗读成台阶）", feelZh: "生长期结束后无流动元素，后半段退化成\"路线图飞越\"不是\"数据流\"" },
      { name: "标签", typical: "中景 5–9 枚（demo 6）：强调色方块图钉落在线上 + 短立杆 + 等宽 ID 胶囊，按 1500/Z' 透视缩放（钳 0.7–1.7）；远的先画近的后画", feelZh: "立杆世界高度要远低于相机高度——杆高≈相机高时所有标签都投影到地平线上挤成一排；位置要逐帧投影核过起止两端都不叠" },
      { name: "生长节奏", typical: "主干 30–40f out-cubic 先行，支流每条错峰 3–6f", feelZh: "全部同帧生长读作 loading 动画" },
      { name: "收尾", typical: "交棒帧前 ≥15f 标签停止新增、相机减速不急刹；标题（眉题 + 两行 108px）逐词升起", feelZh: "氛围段急刹是一次可见的顿挫（glow-orb 收敛判例同源）" },
    ],
    soundZh: "入场用一条低频上行垫底，落定帧钉一记 impact；品牌 hold 段留白，不要铺满音乐。音效密度与画面节拍一致即可。",
    pitfallsZh: "借鉴来源：Linear Releases 开场（进化轮 #3 breakdown #7），单例样本 ——参数给区间不给教条，首次实战以真实素材回验；与 glow-flyline-moves 别混用在相邻段落：两卡都是\"暗场发光线\"， 背靠背出现读作全片只会一招；同片都要用时中间隔 ≥2 个亮场镜头；暗场进出成本同 glow 卡：接亮场产品段用 shot-transitions 藏切族垫， 别生切明暗；线条纯白全亮会糊成蛛网——亮度按层拉开（见参数表），中景才是主角层； 主干/支流给 1–2px 微辉光（soft glow）压出\"发光线\"氛围，全无辉光读作线框图（Q4 单点光效许可内）；标签字号在目标画幅下 ≥18px 等效，否则\"可读\"沦为装饰噪点（Q6 同源）",
    recipe: {
      css: "@keyframes ms-enter{from{opacity:0;transform:scale(1.08);filter:blur(6px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-enter{animation:ms-enter 6s cubic-bezier(.16,1,.3,1) both}",
    },
  },
  // 碎片聚合成海报（上游  → opening-brand）
  {
    id: "fracture",
    category: "opening-brand",
    nameZh: "碎片聚合成海报",
    oneLineZh: "5×5 瓦片从 3D 碎片态按中心波纹逐圈聚合成整面海报，停一拍亮字后再整体炸散飞出。",
    useWhenZh: "开场第一镜「从混沌到成形」的品牌或海报揭示；倒放或只取后半可当硬转场。",
    seconds: [1, 5.2],
    energy: "high",
    tags: ["opening","开场与品牌","fracture","碎片聚合成海报"],
    intentZh: "把成形拍成物理事件：碎片带着旋转从三维空间飞回原位，观众看着完整画面从无序中长出来；进出对称，一支素材可正反两用。",
    motionZh: "25 块瓦片各持有确定性伪随机的初始姿态（位移 ±450/±300/±490px + 三轴 ±180° 旋转），按曼哈顿距离波纹 stagger：delay=(|r-2|+|c-2|)*0.045，每块 0.34 duration 走 bezier(0.42,0,0.3,1)（落位前长减速），落位后约 10f 一次 ≤2.5° 的 rotateX 阻尼小摆。",
    params: [
      { name: "网格", typical: "5×5，380×230px，perspective 900px", feelZh: "瓦片更多波纹更细腻但单块存在感下降；persp <700 透视夸张易穿帮" },
      { name: "初始散布", typical: "dx±450 / dy±300 / dz −210~+490", feelZh: "放大散布开场更混沌，但聚合路径变长需同步加 delay 窗口" },
      { name: "波纹间隔", typical: "0.045/环（曼哈顿距离）", feelZh: ">0.07 波纹感变\"逐圈点名\"；<0.03 全体近同时到位失去波纹；再往大或往小调都会改变手感" },
      { name: "入场时长", typical: "每块 0.34（inOutCubic）", feelZh: "缩短更\"啪\"地成形；配合波纹间隔保证末块 ≤0.6 就位" },
      { name: "退场窗口", typical: "0.70 + delay×0.5 起飞，0.18 时长（inCubic）", feelZh: "窗口必须收在 t≈0.97 前：曾因 0.72+delay×0.7/0.26 导致角瓦片出画不完、卡在画框边一秒（判例 2026-08-05）；再往大或往小调都会改变手感" },
      { name: "退场距离", typical: "620–880px（背离中心 + 随机抖动）", feelZh: "距离不足会残留在画框边；中心瓦片方向随机（无\"背离\"可言）；再往大或往小调都会改变手感" },
      { name: "海报配色", typical: "ACCENT_HUE=218 派生整张海报（冷色深场 + 左上柔光 + 底部发光地平线弧）", feelZh: "改一个色相常量整面换色；拼缝 0.5 设计 px，再宽会把字切缺笔" },
    ],
    soundZh: "入场用一条低频上行垫底，落定帧钉一记 impact；品牌 hold 段留白，不要铺满音乐。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "退场用位移出画而非 opacity 淡出——淡出会读作\"消失\"而非\"飞走\"，物理感尽失；改参数时保持 opacity = min(1, tin*2.5) 不挂退场项；所有随机量必须走确定性 rand(seed)（等价 Remotion random()），真随机会渲染间抖动；hold 段（t≈0.6–0.7）是唯一读字窗口，加长文案要同步拉开 label 淡出与首块起飞的间隔，否则字还没读完瓦片已散；标志别跨拼缝：拼缝会把标志切出一条细缝/残边，读作坏图。demo 把字标中心对准第 3 行瓦片中心、字号定 22 让标志整个落在第 2 列瓦片里，碎片飞散时标志随一块瓦片完整飞走；换标志尺寸或网格时同步重算；用作转场时建议只取 t=0.7–1 的飞散段倒放/正放各半，两侧素材分别贴在瓦片面上需另做纹理映射",
    recipe: {
      css: "@keyframes ms-enter{from{opacity:0;transform:scale(1.08);filter:blur(6px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-enter{animation:ms-enter 3.1s cubic-bezier(.16,1,.3,1) both}",
    },
  },
  // 灰阶图标场翻色（上游  → opening-brand）
  {
    id: "icon-field-colorize",
    category: "opening-brand",
    nameZh: "灰阶图标场翻色",
    oneLineZh: "上百个灰阶小图标错峰浮现铺满全屏，停一拍后多道品牌色横带极快向下扫翻全场。",
    useWhenZh: "开场铺陈产品能力面再一举打上品牌色；功能集合页、生态规模展示、片头 logo 前的垫场。",
    seconds: [1, 6],
    energy: "medium",
    tags: ["opening","开场与品牌","ui-entrance","outro","icon","field"],
    intentZh: "先用灰阶把「多」摆足，再用品牌色波把灰世界一瞬间点亮；命门是翻色必须是约 0.5s 内多道色波依次扫过，同帧硬翻只会读作换了张图。",
    motionZh: "150–200 个图标按网格排布（行间半格错位），灰阶 3–4 档由 mulberry32 定分组、灰度与形状；浮现分 10 批错峰淡入（批间 4.4f、批内 ≤3f 抖动），每个带 0.6→1.06→1 微弹与上浮 10px；静置一拍约 18f 后整场压暗 12% 蓄力，多道品牌色横带依次向下扫过（蓝先覆盖全场，橙/绿/红覆盖更低行带）。",
    params: [
      { name: "图标数", typical: "170（17×10 @1080p，格距 108×106，键帽 66px）", feelZh: "<100 读不出\"原野\"；>250 单个太小翻色 pop 看不见" },
      { name: "浮现总长", typical: "~48f（10 批 × 4.4f + 尾批淡入 7f）", feelZh: "太快读作闪现；>60f 观众等不及爆点" },
      { name: "翻色总长", typical: "原片 ~12f 全场完成；demo ~30f", feelZh: "越快越爆；教学/慢节奏场合才拉长" },
      { name: "波数与色", typical: "4 道，同色系日出渐变（金 → 琥珀 → 橙 → 珊瑚红）", feelZh: "调大或调小：1 道=单色点亮也成立；四色跨色相（蓝/橙/绿/红）读作彩虹，同色系分段更像品牌" },
      { name: "行差", typical: "1.4f/行 + 列 0.25f 微倾", feelZh: "行差 >3f 波读作逐行扫描仪；0 = 硬翻；再往大或往小调都会改变手感" },
      { name: "翻色 pop", typical: "1.22x 正弦 4f + clip 灌满", feelZh: "无 pop 波前沿读不出来；>1.4x 图标互相打架；再往大或往小调都会改变手感" },
    ],
    soundZh: "入场用一条低频上行垫底，落定帧钉一记 impact；品牌 hold 段留白，不要铺满音乐。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在手绘简笔图标上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；翻色别用透明度交叉淡入：暖色半透明叠在暗底上会过一段橄榄/灰泥色（判例），用 clip 擦入； 白闪也要等新色盖满后再起，否则半透明叠层上的白闪发灰；翻色不许同帧硬翻——原片密帧核实为多道波纹快扫（bear-app 25fps 密帧：蓝→橙/绿/红约 0.5s 内完成），硬翻读作换图无\"点亮\"感；图标需可辨认的实心简笔形（心/星/闪电/对勾…）；抽象色块读不出 \"功能宇宙\"语义；与 theme-switch-moves 分工：那张是 UI 界面明暗主题切换；本卡 是装饰性图标场的品牌色点亮，不承载界面语义",
    recipe: {
      css: "@keyframes ms-enter{from{opacity:0;transform:scale(1.08);filter:blur(6px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-enter{animation:ms-enter 3.5s cubic-bezier(.16,1,.3,1) both}",
    },
  },
  // 大字距字标结晶（上游  → opening-brand）
  {
    id: "letterspace-materialize",
    category: "opening-brand",
    nameZh: "大字距字标结晶",
    oneLineZh: "大字距字标全部字符同帧起笔、笔画连续生长，同一瞬间齐收成词。",
    useWhenZh: "片头或片尾品牌字标登场；章节题字；需要静谧高级感的收束帧。",
    seconds: [2.88, 5.12],
    energy: "low",
    tags: ["opening","开场与品牌","typography","outro","letterspace","materialize"],
    intentZh: "字标不是淡入也不是打字机，而是「结晶」：全部字母同帧起笔同时写完；逐字错峰会变成打字机语义，整词一体才是仪式感。",
    motionZh: "每个字符用骨架笔画 SVG path，pathLength 归一并让 strokeDashoffset 从 1→0 连续描画；全字符共享同一进度 p，同帧起笔同帧齐收（不做 per-char delay/jitter）；描画曲线整体 ease-in-out，中段略快、首尾略缓。",
    params: [
      { name: "描画时长", typical: "~50f（f16 起 f68 收 @30fps）", feelZh: "<30f 读不出\"画\"的过程；>80f 拖；再往大或往小调都会改变手感" },
      { name: "同步性", typical: "全字符同帧起收、零错峰", feelZh: "判例：逐字错峰版被裁\"所有字母是在同一个时间完成书写\"；再往大或往小调都会改变手感" },
      { name: "连续性", typical: "pathLength 连续生长、无分段跳变", feelZh: "判例：遮罩分段版被裁\"应该是连续的笔画画出来\"；再往大或往小调都会改变手感" },
      { name: "字形", typical: "骨架单线、字面宽高比 ~1.07、笔画细", feelZh: "竖长（比 <0.8）被裁；粗笔画丢结晶感" },
      { name: "字距", typical: "~0.6em", feelZh: "大字距是本卡身份；<0.3em 改用普通描画卡" },
      { name: "终态静置", typical: "≥30f", feelZh: "结晶完成后必须让观众读一次整词；再往大或往小调都会改变手感" },
    ],
    soundZh: "入场用一条低频上行垫底，落定帧钉一记 impact；品牌 hold 段留白，不要铺满音乐。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 draw-svg-trace 分工：那张是通用描画（图标/插画/单元素）； 本卡命门是全字符同步的整词结晶仪式，且限品牌字标语境；与 type-assembly-moves 分工：那张是字块组装（位移拼合）； 本卡笔画从无到有生长，字符不位移；骨架字形需手绘 path（现成字体轮廓是双线勾边，描画观感不同）； demo 的 13 个小写字形（v i d e o - s h t c r a f）每个带自己的宽度 w， 实战优先复用 demo 里的字形库；多子笔画字母（i 的点、t/f 的横）按 描画顺序排在路径末尾，pathLength 归一后仍同帧齐收；原片（superhuman-promo）底景是实拍暮色山景+水面倒影；demo 为 渐变近似，实战建议用实拍/AI 生成空镜",
    recipe: {
      css: "@keyframes ms-enter{from{opacity:0;transform:scale(1.08);filter:blur(6px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-enter{animation:ms-enter 4s cubic-bezier(.16,1,.3,1) both}",
    },
  },
  // 魔术卡牌登场（上游  → opening-brand）
  {
    id: "magician-card-flourish",
    category: "opening-brand",
    nameZh: "魔术卡牌登场",
    oneLineZh: "暗场蓝色星芒闪现 0.3s，卡片从光里极速自旋弧线飞向镜头，到达瞬间硬定格成近满幅。",
    useWhenZh: "单张卡片、海报、封面的魔术性登场（片头主视觉、产品卡揭晓）；纯黑暗场。",
    seconds: [0.3, 5.2],
    energy: "high",
    tags: ["opening","开场与品牌","ui-entrance","effects","magician","card"],
    intentZh: "三个魔术感命门：闪光先行当仪式、慢起蓄力→急加速踢出→弧线减速抵达的弹射节奏、到达瞬间硬定格（无减速尾巴无回弹）。",
    motionZh: "X 形对角针状光束（起始 −38°/52°）在 0.3s 内整体旋转 90°（easeInOut），长轴 840、短轴 420、每轴三层辉光，中心是极小亮点加一圈长短相间放射短线；卡片从中心远点弹射、自旋随靠近衰减，定格尺寸为卡高 86%，随后光脉冲与 sheen 扫光，右侧文案逐行揭示。",
    params: [
      { name: "闪光时长", typical: "9f（0.3s，用户精确定值；曾 1.5s→0.8s→0.5s 逐轮压短）", feelZh: "光是仪式不是主角；>15f 抢卡片的戏；再往大或往小调都会改变手感" },
      { name: "星芒旋转", typical: "闪光期间动态转 90°（判例：静态摆角被裁\"没看到旋转\"）", feelZh: "旋转要逐帧可见；>120° 读作螺旋桨；再往大或往小调都会改变手感" },
      { name: "光束颜色", typical: "纯饱和蓝贯穿全长", feelZh: "白段过长/衰减过快被裁\"不够还原\"；青蓝偏灰被裁\"要蓝色的\"" },
      { name: "中心", typical: "小亮点+辉光+放射短刺", feelZh: "白色圆球被裁——中心是光学辉光不是实体球；再往大或往小调都会改变手感" },
      { name: "弹射曲线", typical: "slow-in 14%→burst→减速弧线", feelZh: "直接匀速/纯 easeOut 没有\"弹射\"的蓄力感；再往大或往小调都会改变手感" },
      { name: "自旋衰减", typical: "后 60% 行程 2.4 次幂减速", feelZh: "匀速到底被裁\"靠近镜头时应随距离衰减\"；整圈数=定格正面的保证" },
      { name: "定格尺寸", typical: "卡高 86% 画面高（右侧留给文案）", feelZh: "初版 1.0x 被裁\"更近更大基本靠近上下界\"；单卡居中无文案时可回到 94%" },
      { name: "硬定格", typical: "全量冻结零回弹", feelZh: "魔术感=瞬间静止；回弹读作物理玩具；再往大或往小调都会改变手感" },
    ],
    soundZh: "入场用一条低频上行垫底，落定帧钉一记 impact；品牌 hold 段留白，不要铺满音乐。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；光效质感判例链（本卡贡献的全局方法论）：几何色块被裁\"5毛 特效\"→光学实感重做→游戏感+真实→用户给参考图一轮收敛。 质感类意见文字损耗大，主动请用户丢参考图；工程坑：细针光束不能放进 CameraMotionBlur——旋转被模糊采样 拆成条纹分身（\"廉价感\"的隐性来源）；闪光层独立于运动模糊渲染；工程坑：星芒 SVG viewBox 要 ≥ 光束长+旋转扫掠半径，否则端点 被裁出直边；与 card-flip-reveal/deck-deal-flyin 分工：那两张是翻牌/发牌的 多卡节奏戏；本卡是单卡\"变出来\"的魔术仪式，一次只变一张",
    recipe: {
      css: "@keyframes ms-enter{from{opacity:0;transform:scale(1.08);filter:blur(6px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-enter{animation:ms-enter 2.75s cubic-bezier(.16,1,.3,1) both}",
    },
  },
  // 环形巡回标题（上游  → opening-brand）
  {
    id: "orbit-ring-title-open",
    category: "opening-brand",
    nameZh: "环形巡回标题",
    oneLineZh: "石墨暗场八张 16:9 卡沿 720×380 椭圆匀速公转，卡身永不倾斜，居中标题逐字落定、马克块横扫铺满。",
    useWhenZh: "开场第一镜想说「这个产品有一整套东西」；素材库、模板库、功能矩阵、案例集的门面拍。",
    seconds: [2.9, 5],
    energy: "medium",
    tags: ["opening","开场与品牌","ui-entrance","orbit","ring","title"],
    intentZh: "把静止九宫格改成环形巡回：永远有卡在进画、有卡在出画，画面自带「还有更多」的暗示，而标题稳稳钉在正中；卡内容要真的在播，才从轮播图变成「产品在工作」。",
    motionZh: "θ=−π/2+i·2π/8+t·0.3，x=960+cosθ·RX·ringScale、y=540+sinθ·RY·ringScale，RY/RX≈0.53 才读作俯视的环；卡只跟着 θ 换位置、自身零旋转，纵深由 sinθ 给 ±12% 缩放与 z 序；环 f0–24 用 expo-out 把 ringScale 从 0.62 撑到 1，第 24 帧八张卡一起从冻结首帧开播。",
    params: [
      { name: "椭圆半径", typical: "RX=720 / RY=380（卡 400×225）", feelZh: "RY/RX≈0.53 是\"俯视环\"的甜点；比值 →1 读作正圆转盘，→0.3 卡会在上下缘挤成一条；再往大或往小调都会改变手感" },
      { name: "卡数", typical: "8（方位角间隔 45°）", feelZh: "调大或调小：8 张在这个半径上任意转角互不遮挡；≥10 张必须同步加大 RX/RY，否则近处卡压边" },
      { name: "公转速度", typical: "0.3 rad/s（5s 转约 86°）", feelZh: "别因为\"看起来慢\"就调快：>0.5 rad/s 时卡扫过画面边缘会有频闪感，且喧宾夺主" },
      { name: "环入场", typical: "f0–24，scale .62→1，expo-out", feelZh: "<15f 像弹窗；>30f 标题起手时环还在长，两件事互相盖" },
      { name: "逐卡淡入", typical: "第 i 张 2+1.5i 帧起 11f", feelZh: "步长 1.5f 刚够读出\"依次\"；>3f 最后一张会晚到标题之后" },
      { name: "开播帧", typical: "PLAY_START=24f", feelZh: "必须 ≥ 环撑开结束帧；提前会让八个动效在入场期一起抢戏" },
      { name: "纵深", typical: "缩放 ±12%，远处失焦 ≤1.6px + 压暗", feelZh: "缩放 >15% 顶部卡会缩成图标，环读作\"透视隧道\"；失焦 >3px 远处卡读作脏；再往大或往小调都会改变手感" },
      { name: "标题", typical: "上行 64px/500 灰 + 下行 156px/600 白", feelZh: "环一直在动，主角行必须够大够重才压得住；两行同字号会失去层级" },
      { name: "逐字节奏", typical: "上行错峰 1f/单字 27f；下行错峰 2f/单字 32f", feelZh: "错峰 1–2f 是\"整体解糊\"的手感；≥3f 会读成逐字打字机；再往大或往小调都会改变手感" },
      { name: "马克块", typical: "f50 起，spring damping 20，荧光黄绿 #c6f432", feelZh: "damping <14 会回弹出色块边缘；暗场里它是唯一高饱和色块，别给第二处" },
      { name: "副行", typical: "video-shotcraft 标志 + 小写字标 30px + mono 26px「SHOT RECIPE CARDS」（字距 0.2em），f60 起 16f 浮出", feelZh: "大字距 mono 是\"产品代号\"的读法；跟标题同字体会读作第二行标题；别写卡片数这类会过时的数字" },
      { name: "退场（可选）", typical: "f118–128，blur 0→6.5px", feelZh: "整行统一失焦；逐字退场会读作第二次入场；再往大或往小调都会改变手感" },
    ],
    soundZh: "入场用一条低频上行垫底，落定帧钉一记 impact；品牌 hold 段留白，不要铺满音乐。音效密度与画面节拍一致即可。",
    pitfallsZh: "卡不能跟着 θ 倾斜。给卡加 rotate(θ) 后环立刻从\"陈列\"变成\"过山车\"，而且卡内 文字会歪，可读性直接归零。卡只换位置，不换角度；卡内容首帧必须自带静态骨架（底色/边框/标签/暗底轨迹）。冻结期显示的就是第 0 帧， 如果卡的动效是\"从零画出来\"，入场那 24f 就是八张空白卡。demo 里每个占位卡都补了 暗底 sparkline / 淡稿线 / 常驻提示符，就是为了让首帧不空；zIndex 必须跟着 depth 走。只做缩放不排 z 序时，DOM 顺序会让后面的卡压住前面的， 近大远小的立体感当场作废；马克色块和字的层级是一对：色块 zIndex:0 + 字 position:relative; zIndex:1。漏掉 字上的 relative，色块会盖住字（stacking context 里 static 元素排在 positioned 之后）；标题 white-space: nowrap 是马克块的前提——块的左右外扩 0.14em 与反白裁切都假设高亮 词组在同一行盒里。换行后色块会跨行断裂成两截。改了高亮词的字数要同步改前沿换算里的 W",
    recipe: {
      css: "@keyframes ms-enter{from{opacity:0;transform:scale(1.08);filter:blur(6px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-enter{animation:ms-enter 3.95s cubic-bezier(.16,1,.3,1) both}",
    },
  },
  // 聚光灯主角卡（上游  → opening-brand）
  {
    id: "spotlight-hero-card",
    category: "opening-brand",
    nameZh: "聚光灯主角卡",
    oneLineZh: "关灯剧场里一束带体积光柱的钨丝聚光扫过页面锁定一张卡，斜侧推进后卡片弹起悬浮、轮廓光束扫两圈再贴回原位。",
    useWhenZh: "「单一主角」式产品开场：把一个核心对象（卡片、条目、模块）立成全片主角。",
    seconds: [4.1, 7.3],
    energy: "medium",
    tags: ["opening","开场与品牌","effects","camera","spotlight","hero"],
    intentZh: "开场只讲一件事：这一张卡就是产品的原子单位；聚光灯替观众做视线引导，弹起悬浮给它体积和重量，最后贴回原位表示它属于这个页面。",
    motionZh: "整页以 multiply 压到约 6–14% 亮度，光池用近高斯多段 stop 并游走三个中间站后锁定卡心（锁定瞬间 6% 脉冲）；相机从全页正视推进到斜侧特写、焦点左移让卡落在画面偏右，动作弧与 3D 注记配合，轮廓光束沿外形扫两圈后贴回，30f 真静止 hold。",
    params: [
      { name: "选卡", typical: "cards[3]，中心 x 恰为 960（页面中心）", feelZh: "主角卡先按\"推进后构图\"选，不是随便挑一张；再往大或往小调都会改变手感" },
      { name: "相机", typical: "静止全页 zoom 0.8（0–40f）→ 18f 推进 zoom 2.6；rotY 34° 主导 + rotX 仅 8°，persp 1200；焦点取卡心左移 105px、上移 10px；推进后锁死到尾", feelZh: "侧向水平机位读感优于俯拍（\"从左侧拍摄而不是从下方\"，Q6）；收尾禁用 zoom 2.6→2.58 一类尾漂，呼吸交给光而不是相机（R1）；再往大或往小调都会改变手感" },
      { name: "关灯", typical: "光池外 multiply 0.90→0.94（≈6–10% 亮度）", feelZh: "<0.8 读作\"调暗的页面\"不是剧场；>0.96 邻卡完全消失、失去\"在页面里\"的上下文" },
      { name: "聚光灯", typical: "3 个中间站（4→28f），光池半径 400→300，锁定 +6% 脉冲；soft-light 暖白 0.24；锁定后换成卡形光", feelZh: "圆光池罩卡会两头落暗、中间打爆（\"手电筒照页面\"）——主角卡要用卡形软孔从边到边打亮；中间站让\"随机照射\"可信" },
      { name: "体积光柱", typical: "光源 (pool.x+420, −720)，柱宽 0.6×光池；screen 0.34→0.06 纵向渐变", feelZh: "光源太近读作手电筒；柱太宽会和光池糊成一团" },
      { name: "动作弧", typical: "rise 10f（bezier(0.2,1.25,0.3,1) 过冲）→ 悬停 58f（sin bob 振幅 4px 周期 40f，z=110px·lift）→ reseat 18f，落地 press 0.997", feelZh: "锁定→落地 ≈108f≈3.6s——质感镜头要\"放慢到 3 秒\"（R3），初版几乎总是偏快" },
      { name: "轮廓光束", typical: "lap1 68→82f（strokeWidth 5+2.5 双层）、lap2 88→108f（3.5+1.75、整体 opacity 0.62）；strokeDasharray \"0.16 1\" 走 dashoffset", feelZh: "两圈快慢有别才读作\"持续扫描\"，一圈是眨眼；光束只给主角一次（Q4）" },
      { name: "双层影", typical: "偏左下 -10·lift, 10·lift …, -36·lift 48·lift 90·lift 随高度生长", feelZh: "影子不随高度长，悬浮就不成立；方向要和光源一致" },
    ],
    soundZh: "开灯推闸钉一记低沉的 light-clunk（f2），弹起钉 whoosh-big（本 demo f56；模板片钉在 f127），光束扫描钉 sparkle（f68），reseat 钉 transition-snap（f142）——弹起/光效/落定各有专属音（S2、S4）。",
    pitfallsZh: "开场多卡群舞撑不起第一印象（Q5）——开场曾反复推倒多次才收敛到单卡；直接从单主角+完整动作弧起稿；推进特写下卡上文字会糊，根因是纹理栅格化分辨率不是 DoF——配套技法展开见审美准则 Q2；逐卡 glint 闪烁被两次否决（\"不需要每个卡片都闪烁一下\"，Q4），光效严格只给主角；卡形光的暗场必须在页面空间（PageCam 内、translateZ 介于页面与卡之间），屏幕空间的遮罩跟不上透视与卡的抬升；卡 translateZ 至少 +2px，reseat 后才不会和暗场共面闪烁；注记的暗色衬底右缘要止于卡左缘之前，否则会在卡面左侧压出一道暗楔",
    recipe: {
      css: "@keyframes ms-enter{from{opacity:0;transform:scale(1.08);filter:blur(6px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-enter{animation:ms-enter 5.7s cubic-bezier(.16,1,.3,1) both}",
    },
  },
  // 断笔成字（上游  → opening-brand）
  {
    id: "stroke-segment-build",
    category: "opening-brand",
    nameZh: "断笔成字",
    oneLineZh: "标题拆成十几段互不相连的笔画乱序逐段点亮，前 70% 不可读，末段落位瞬间语义「啪」地成立。",
    useWhenZh: "开场吊悬念的产品名或大数字揭晓；一支片最多 1 次；与「看着字被组装」的卡片分工。",
    seconds: [2, 5.5],
    energy: "low",
    tags: ["opening","开场与品牌","typography","stroke","segment","build"],
    intentZh: "《异形》片头逻辑：标题不是被画出来的，是「显影」出来的；「认出的那一刻」就是钩子，强度取决于不可读期撑多久、钥匙段压多晚。",
    motionZh: "f12–72 前 13 段起点按 ease-out 分布乱序点亮（间隔 9f 越来越密到 3f），每段 7f 霓虹起辉抖闪（亮—灭—亮—半亮—亮）后以 0.58 亮度稳住；f72–86 屏息 14f 不新增任何段，f86/f93/f99 三拍落下钥匙段，每段落位给整字一次脉冲。",
    params: [
      { name: "拆段粒度", typical: "4 字母 16 段（单线几何字 260×400/字，灯管线宽 30，圆端帽，两端各留 4% 电极缝）", feelZh: "段太少悬念期短；太碎读作噪点。S 拆成两段反向弧各 3 段" },
      { name: "乱序表", typical: "手工排：跨字母乱跳，\"可读性钥匙段\"（S 下脊 / H 中横 / P 碗底）压到最后 3 段", feelZh: "顺序点亮 = 没有悬念；钥匙段早出 = 提前泄底" },
      { name: "点亮节奏", typical: "疏→密（9f→3f，stagger(.., EASE.out)）→ 屏息 14f → 三拍 7f/6f", feelZh: "匀速等间隔没有张力；屏息 <8f 感觉不到，>20f 读作卡住；再往大或往小调都会改变手感" },
      { name: "不可读期", typical: "前 13 段（约 60% 时长）读不出字", feelZh: "QA 抽中段帧自问\"能猜出来吗\"，能猜出就重排" },
      { name: "半亮 → 满亮", typical: "悬念期 0.58，揭晓 1.0 + 涌起 1.25", feelZh: "悬念期太亮（>0.8）揭晓就没有\"通电\"的对比" },
      { name: "落位脉冲", typical: "scale 1.02 + 光的涌起", feelZh: "霓虹是挂在墙上的物件，大幅缩放会假；冲击交给光" },
      { name: "墙面受光", typical: "环境光 = 0.12 + 0.5×已亮段占比 + 揭晓/涌起", feelZh: "灯越多墙越亮，物理上可信；常量墙光会让点亮失去分量" },
      { name: "地面倒影", typical: "沿地面交线镜像、blur 5px、opacity 0.42、离地越远越淡", feelZh: "遮罩写在镜像前的本地坐标里，交线以上必须全透明；再往大或往小调都会改变手感" },
      { name: "未亮段", typical: "条件不渲染（非 opacity 0）", feelZh: "收尾真静止与\"不泄底\"的前提" },
    ],
    soundZh: "入场用一条低频上行垫底，落定帧钉一记 impact；品牌 hold 段留白，不要铺满音乐。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 是霓虹灯牌版（aurora 暗场）；换别的材质（LED 段码、发光描边）时起辉曲线与半亮值要重调；暗底上的辅助文字用亮灰——demo 首版顶部标题深灰压深底不可见（P1 自检抓到）；揭晓泛光别另画一团径向光斑——会在字中间形成一个脏亮点；让灯牌自己的宽泛光（形状就是字）涌起一次；倒影是整块灯牌渲染两遍（每遍两层 SVG 高斯模糊），单镜头渲染成本翻倍；性能吃紧时先砍倒影；字数上限：4–6 字母词最佳；长词不可读期难控制，段数爆炸",
    recipe: {
      css: "@keyframes ms-enter{from{opacity:0;transform:scale(1.08);filter:blur(6px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-enter{animation:ms-enter 3.75s cubic-bezier(.16,1,.3,1) both}",
    },
  },
  // 文字视频遮罩（上游  → opening-brand）
  {
    id: "text-as-mask",
    category: "opening-brand",
    nameZh: "文字视频遮罩",
    oneLineZh: "瓷白舞台上切出超粗大标题字，字内部透出缓慢平移的暗色产品面板，结尾字腔吸气后指数冲入放大、产品接管全屏。",
    useWhenZh: "品牌词或口号与产品画面二合一的开场或章节卡；字是门、产品在门里。",
    seconds: [0.27, 5.5],
    energy: "high",
    tags: ["opening","开场与品牌","typography","text","mask","文字视频遮罩"],
    intentZh: "让标题和产品同体：字形就是遮罩，观众同时读到词与画面质感；结尾字形胀开溢出画幅，产品自然接管全屏——从品牌词走进产品，一条镜头说完。",
    motionZh: "SVG 白字黑底 data-URI 交给 CSS mask-image 套住产品画面，字形下垫一层同形、带色相的模糊投影；遮罩从基线向上擦出 16f + 1.04→1 落定，产品层 scale 1.32 并 translateX +150→−150（f18–96、bezier(0.3,0,0.7,1)）在字内漂移；结尾吸气 8f 后字形指数冲入放大 46 倍溢出画幅。",
    params: [
      { name: "字号/字重", typical: "470px / 900（system-ui Black，字距 −22）", feelZh: "笔画就是视口——细字重等于把产品塞进门缝；字宽占画幅 ~72%" },
      { name: "漂移速度", typical: "~3.8px/f（300px/78f）", feelZh: "快了字内画面读不清；漂移方向选画面信息密的轴" },
      { name: "吸气", typical: "8f，1→0.965", feelZh: "没有吸气的冲入读作\"突然胀开\"；>0.94 读作字在缩小退场" },
      { name: "放大倍率", typical: "46×（按竖笔宽/画幅比配：88px 竖笔需 ≥24× 才撑满）", feelZh: "不足则接管帧还看得到字边残影；再往大或往小调都会改变手感" },
      { name: "冲入曲线", typical: "对数空间 t^1.8，24f", feelZh: "线性对数 = 匀速冲入；指数 >2.5 前半段几乎不动、最后 3f 猛胀；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "接管后 hold ≥30f", feelZh: "R1；接管完成帧产品应落在标准构图；再往大或往小调都会改变手感" },
    ],
    soundZh: "入场用一条低频上行垫底，落定帧钉一记 impact；品牌 hold 段留白，不要铺满音乐。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 用的是为镜头设计的 video-shotcraft 渲染看板（Render throughput，侧栏是品牌标志）——实战换真实截图时先看笔画里透出的是不是大块色与亮线， 浅色页面要先调暗或换暗色主题，否则字读不出\"窗\"；别给字形做描边高光：system-ui 等可变字体的字形由重叠轮廓拼成，描边会画出 A 的横杠/顶角等内部轮廓线；字内透出的产品画面全程被特写盯着看——真实素材先过 审美准则 Q2 的高分辨率栅格化技法，低倍截图在笔画里糊成一片；换词/换字体后 origin 手推值必失效——渲后看放大方向，洞不对中就微调 origin（同 transition-travel A 字腔穿越的腔心漂移坑）；与 transition-travel A 字腔穿越同片不并用——同为\"字里长出世界\"， 观众读作同一招使两次（P4）",
    recipe: {
      css: "@keyframes ms-enter{from{opacity:0;transform:scale(1.08);filter:blur(6px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-enter{animation:ms-enter 2.89s cubic-bezier(.16,1,.3,1) both}",
    },
  },
  // 颗粒解体重组（上游  → outro）
  {
    id: "grain-dissolve",
    category: "outro",
    nameZh: "颗粒解体重组",
    oneLineZh: "整行字爆裂成沸腾颗粒噪点并浮出斜纹选区框，噪点云急速凝聚成更大号发光短字标。",
    useWhenZh: "收尾「XX. Now Live」式上线宣告；把长句信息压缩成品牌短标的能量聚合拍。",
    seconds: [0.56, 2],
    energy: "high",
    tags: ["outro","收尾与定版","grain","dissolve","颗粒解体重组"],
    intentZh: "把「一句话浓缩成一个词」拍成物理事件：句子先失稳沸腾成颗粒（信息解体），选区框暗示正在选中提取，然后所有能量向中心坍缩成更亮短标。",
    motionZh: "滤镜链是唯一引擎：feTurbulence（baseFrequency 0.9→1.3）+ feDisplacementMap（scale 0→52）+ feGaussianBlur（0→1.1px）由同一条 burst 曲线（t=0.13–0.28，outCubic）驱动；噪点沸腾靠 seed=floor(t*46) 逐帧换种子；t=0.60–0.71 在最沸腾时交叉淡化换字，lock 曲线把 displacement 与 blur 拉回 0 让颗粒凝固成清晰字形。",
    params: [
      { name: "displacement scale", typical: "峰值 52", feelZh: "<30 只是\"轻微毛边\"；>80 颗粒散到认不出轮廓，\"隐约可辨\"是砂化质感的底线" },
      { name: "baseFrequency", typical: "0.9 → +0.4", feelZh: "越高颗粒越细；低于 0.5 变成大块扭曲不是\"砂\"" },
      { name: "seed 换帧率", typical: "floor(t*46)，2s 内 46 次", feelZh: "降低会看出噪声图重复；保持 ≥20 次/秒的换图率" },
      { name: "砂化窗口", typical: "0.13–0.28（outCubic）", feelZh: "前 0.13 的干净字停留是\"失稳前的常态\"，砍掉则没有对比；再往大或往小调都会改变手感" },
      { name: "凝聚交叉", typical: "0.60–0.71（inOutCubic）", feelZh: "必须落在最沸腾段内完成换字；提前会穿帮看到两行字叠影" },
      { name: "辉光包络", typical: "burst·0.3 + cond·0.7 − settle·0.45", feelZh: "凝聚冲高是卡点位，压 BGM 重音；回落别到 0，留柔光\"余温\"" },
    ],
    soundZh: "收尾用一次收束感的 riser 落 impact，定版后留 1s 静场再出音效；不要用音乐硬收。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 的文案是 { video-shotcraft. Now Live } → 凝聚成 video-shotcraft 字标（全小写）；换项目短标时两行 <text> 都要改：整行句式 { XX. Now Live } 与短标 XX 必须指同一对象，否则叙事断裂；短标变长（>6 字符）需同步缩字号或加宽选区框 bw，否则凝聚后超出框位视觉重心偏移——demo 的 15 字符品牌名把整行字从 33px 缩到 26px、短标从 54px 缩到 44px，游离砂粒的落点范围同步放宽到字标字面；feDisplacementMap 在 Safari 上性能较差，这张卡是 2s 短拍可接受；拉长时长需实测帧率；选区框撤场（0.55–0.64）必须早于凝聚完成（0.71）——框留到凝固后会读作\"还没选完\"，语义反了",
    recipe: {
      css: "@keyframes ms-lock{from{opacity:0;transform:scale(1.6);filter:blur(8px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-lock{animation:ms-lock 1.28s cubic-bezier(.22,1,.36,1) both}",
    },
  },
  // Logo 收束定版（上游  → outro）
  {
    id: "logo-shrink-wordmark-lockup",
    category: "outro",
    nameZh: "Logo 收束定版",
    oneLineZh: "满屏霓虹切口大环快速收束成中央实心小白 O，过冲刹车时换成品牌标志，图标左移让位、字标字母逐个滑入、标语收尾。",
    useWhenZh: "片尾品牌定妆：从满屏图形能量收束到「图标+字标+标语」的标准 lockup。",
    seconds: [1.2, 4.4],
    energy: "medium",
    tags: ["outro","收尾与定版","logo","shrink","wordmark","lockup"],
    intentZh: "片尾的盖章动作：品牌从动态里站定——满屏霓虹坍缩成小图标、愈合缺口转为纯白，再按 lockup 规范一步步落位。",
    motionZh: "收束主曲线 scale 5.4→1（t=0.02–0.28，inOutCubic），t=0.26–0.37 叠 sin(π)*0.06 过冲刹车（到位胀 6% 再回落）；缺口愈合、描边变色与收束同轨完成；t=0.24–0.32 交叉换成反白标志，t=0.34–0.47 图标整体左移 −90.5px 让位，字标字母 stagger 滑入、标语押尾。",
    params: [
      { name: "收束幅度", typical: "scale 5.4→1", feelZh: "起始倍率决定\"从多满收到多小\"；<3 冲击力不足，>7 初始态糊出画" },
      { name: "刹车过冲", typical: "+6%，sin 包络 0.26–0.37", feelZh: "砍掉读作硬冻结；>10% 变果冻；再往大或往小调都会改变手感" },
      { name: "愈合窗口", typical: "0.10–0.28（与收束同步）", feelZh: "愈合必须在落位前完成——落位后还在变色读作\"没准备好\"；再往大或往小调都会改变手感" },
      { name: "左移让位", typical: "−90.5px（由 WORD_W/GAP/ICON 推出），0.34–0.47", feelZh: "与字母首入（0.46）几乎无缝衔接，拉开间隔会有\"空等\"感；再往大或往小调都会改变手感" },
      { name: "字母 stagger", typical: "(0.7-0.46)/n（15 字符 = 0.016/字），各 0.10 时长", feelZh: "调大或调小：5 字母的短词可放宽到 0.035/字；字多时按 (0.7-0.46)/n 反算间隔保证 0.7 前全部起跑" },
      { name: "标语入场", typical: "0.72–0.84 整行淡入", feelZh: "有意不逐字：标语是注脚不是主角；ACCENT 常量换项目色；再往大或往小调都会改变手感" },
    ],
    soundZh: "收尾用一次收束感的 riser 落 impact，定版后留 1s 静场再出音效；不要用音乐硬收。音效密度与画面节拍一致即可。",
    pitfallsZh: "WORDMARK = BRAND.name，标语 = PITCH.en.motto；换品牌词时字母 stagger 节奏依赖字数（已按字数自动反算），标语字符数变化时同步调字距，否则宽字距排版会溢出或过疏；图标是\"演出态→标准态\"两层结构：SVG 双弧切口环（辉光/彩色）愈合成白 O，刹车时再交叉换成 video-shotcraft 标志（纯净态，不加辉光）；换别的 logo 时同样别让 logo 跟着环一起旋转；左移量与字标宽度耦合：WORD_W 是字标行实测宽（换字体/字号要重新量），SHIFT 与字母行左缘 ROW_LEFT 都由它推出，让 lockup 整体在画面居中；收尾后无循环回位设计，作 outro 最后一镜使用；需要循环时在 t=1 后接 1s 静帧",
    recipe: {
      css: "@keyframes ms-lock{from{opacity:0;transform:scale(1.27);filter:blur(8px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-lock{animation:ms-lock 2.8s cubic-bezier(.22,1,.36,1) both}",
    },
  },
  // 三行霓虹跑马灯（上游  → outro）
  {
    id: "neon-triple-marquee",
    category: "outro",
    nameZh: "三行霓虹跑马灯",
    oneLineZh: "三连词空心霓虹灯管巨字排满一面斜拍砖墙，奇偶行反向匀速横滚，三行按 1/3 相位轮流点亮。",
    useWhenZh: "片尾主题词复读机段落；三连词口号的余韵拍法；音乐段无旁白铺陈。",
    seconds: [3.6, 6.4],
    energy: "high",
    tags: ["outro","收尾与定版","typography","neon","triple","marquee"],
    intentZh: "一行 marquee 只是装饰，三行叠起来、奇偶反向、亮度按相位轮流走，主题词就在观众眼前列队巡游；三行全亮是灯牌事故，轮流亮才是 recap。",
    motionZh: "副本按固定 unitW 等距绝对定位，(frame*speed)%unitW 取模平移保持匀速 linear；空心灯管三层：暗态玻璃管→通电彩色管体（描边 6→10px + 三层 drop-shadow 辉光 9/36/90px）→近白热芯（2→3.8px）。轮唱周期 42f、每行一个 14f 槽（槽长 16f 与下一行重叠 2f），槽内前 2 帧启辉闪烁、3f 升满、末 5f ease-in 熄灭。",
    params: [
      { name: "字号/行距", typical: "286px 窄体，行距 290px 排满墙面", feelZh: "行间留白 >80px 读作三条横幅广告而非一面词墙；再往大或往小调都会改变手感" },
      { name: "滚速", typical: "9/11/9 px/f，中行反向", feelZh: "窄体字更密，比宽体慢一档；>20 读不清词只见光带；三行同速同向读作整版平移" },
      { name: "脉冲周期", typical: "42f，每行 14f 槽 + 2f 交接重叠", feelZh: "周期 <30f 三行抢闪读作故障；>70f 轮唱感断掉；不留重叠会每 14f 出现一次全暗空拍" },
      { name: "亮度区间", typical: "暗态玻璃 0.3 + 通电描边 6→10px + 三层辉光", feelZh: "暗态 <0.2 暗行消失，\"三行\"结构丢了" },
      { name: "辉光", typical: "三层 drop-shadow，亮态 9/36/90px + 墙面溢光 0.55", feelZh: "单层或 <20px 读作普通描边字不读作霓虹；没有墙面溢光读作\"屏上的字\"不是\"墙上的灯\"；再往大或往小调都会改变手感" },
      { name: "斜拍", typical: "rotateY −17°→−9°，perspective 1700", feelZh: ">25° 远端词挤成一团读不清；0° 回到平铺，失去纵深" },
      { name: "上电/断电", typical: "入：逐行错峰 5f 点火；出：124f 起逐行错峰 6f 断电", feelZh: "硬切进出读作素材没铺满；整组同时淡出没有\"关灯\"的仪式感；再往大或往小调都会改变手感" },
    ],
    soundZh: "收尾用一次收束感的 riser 落 impact，定版后留 1s 静场再出音效；不要用音乐硬收。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 page-waterfall-wall 分工：那卡是页面截图纵向瀑布做\"内容体量感\"， 本卡是文字行横向对滚做\"主题词余韵\"——素材是词不是页，位置在片尾不在中段；与 outro-group-photo-launch 分工：全家福是峰值终镜（元素合影+发布会收场）， 本卡是终镜前的 recap 铺垫或低成本备选终镜，两者可串（本卡→淡出→全家福）不可叠；副本数按 ceil(1920/unitW)+3 留冗余——短词（≤4 字符）unitW 小， 副本不足会在回绕瞬间露右侧空缺；实战品牌色版：三行可统一品牌色靠明暗区分，但辉光对比须 ≥ demo 的 暗态 0.3 → 通电满亮 + 三层辉光的幅度，不然轮唱读不出来",
    recipe: {
      css: "@keyframes ms-lock{from{opacity:0;transform:scale(1.6);filter:blur(8px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-lock{animation:ms-lock 5s cubic-bezier(.22,1,.36,1) both}",
    },
  },
  // 全家福收尾（上游  → outro）
  {
    id: "outro-group-photo-launch",
    category: "outro",
    nameZh: "全家福收尾",
    oneLineZh: "全片元素从四面八方飞来围住字标合影，crane 落机位、舞台光与金尘做成发布会收场。",
    useWhenZh: "outro 或品牌收尾；多功能产品的「全家福」式终镜。",
    seconds: [3.46, 6.14],
    energy: "high",
    tags: ["outro","收尾与定版","group","photo","launch","全家福收尾"],
    intentZh: "把看过的每个功能各抽一个代表元素叫回来合影，字标压轴登场——观众离场前最后记住的是「这些东西属于同一个产品」。",
    motionZh: "9 个页面元素从四方带旋转飞入、飞行段按速度做方向性运动模糊，落地压实（接触影收紧 + 1.5% 轻压、不逐个发光）；字标 letterpress 逐字登场、全员退后排让主角，rule 长出并射出延长线；合影层整体 rotateX 4°→0 + scale 落下后缓推，配光带扫过、舞台光、金尘上飘。",
    params: [
      { name: "元素飞入", typical: "9 元素 cue 从 4 起每 3f 一个，各飞 12f；起点偏移 ±360–500px；渲染顺序=cue 顺序，后到者叠上", feelZh: "每个已展示过的功能都要有代表元素（Q8 自检项），缺谁观众都会察觉；再往大或往小调都会改变手感" },
      { name: "飞入缓动", typical: "bezier(0.34,1.4,0.44,1)", feelZh: "代码注释点名教训：旧 bezier(0.25,0.9,0.3,1) \"never crossed 1\" 没有真过冲——落地要弹 y1 必须 >1；再往大或往小调都会改变手感" },
      { name: "飞行姿态", typical: "飞行中 rot×2→settled rot（±5° 内）、scale ×1.12→1；按屏幕速度的方向性运动模糊（0.3×px/帧，封顶 22）；落地 cue+9→16f 接触影收紧 + 1.5% 轻压", feelZh: "落定角度收进 ±5° 内——合影要整齐但不刻板；再往大或往小调都会改变手感" },
      { name: "退后排", typical: "字标登场时 42–50f 全员 opacity −12%、saturate −8%", feelZh: "主角登场配角必须让位，不让位字标压不住 9 个元素；再往大或往小调都会改变手感" },
      { name: "crane 运镜", typical: "perspective(1400px) rotateX(4°→0) scale(1.06→1) 前 40f 落下，之后缓推 +0.035（36f 起 in-out 零速起步，接 crane 不突变）", feelZh: "crane 幅度就这么小（4°）已经够\"落机位\"读感，大了会晕（推测）" },
      { name: "氛围三件套", typical: "光带 2–14f（600px 宽 overlay 峰值 opacity 0.12）；舞台光 42→50→58f 0→0.5→0.25；金尘 20 颗 2.4–4.2px 带暖光晕、opacity 0.35–0.7 微闪 + 6 颗前景失焦光斑、全参数 index 派生确定性", feelZh: "粒子/光效参数必须确定性派生（硬规则：渲染必须可复现）；金尘超过 30 颗开始像雪（推测）；再往大或往小调都会改变手感" },
      { name: "字标", typical: "demo 为 video-shotcraft 标志 + 全小写字标（品牌字体 118px）：标志 38f 先压，字母 delay=42+i·1.8、8f，同一套 letterpress；rule 58→70f 长出、两端 190px 延长线 8f 射出 6f 淡去；字距 62–66f 呼吸；背景页 24f 内 blur 0→14；落定后 sign-off …", feelZh: "字标落定 hold 满 1 秒（R1 定案）；outro 不加解说 caption 保持干净（C1 例外项）" },
    ],
    soundZh: "固定三拍句式：riser-cine 铺进组装（模板片钉在 f945）→ impact-deep-whoosh 钉字标 stamp（f980，vol 0.55 全片峰值）→ sparkle 点 rule（f1005）。这是模板片定稿后唯一从未改动的段落句式（S2；详见 sound-design 4.3）。",
    pitfallsZh: "初版收尾几乎总是偏保守（Q8：安静签名式→合影→发布会三级加码）——起稿就按\"像一个产品发布\"的规格给足 crane/舞台光/粒子；结构先于特效：先有\"四方飞入合影\"结构再加码氛围；直接堆特效没有骨架；outro tagline 与字标下方文案查重（P4 dedupe 判例），同一句话全片只出现一次",
    recipe: {
      css: "@keyframes ms-lock{from{opacity:0;transform:scale(1.45);filter:blur(8px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-lock{animation:ms-lock 4.8s cubic-bezier(.22,1,.36,1) both}",
    },
  },
  // 减法式收尾（上游  → outro）
  {
    id: "ui-strip-away-outro",
    category: "outro",
    nameZh: "减法式收尾",
    oneLineZh: "点击 Publish 后整个编辑器 UI 从外围到中心层层错峰蒸发，黑场只剩那颗按钮滑到屏心放大，再淡出交棒字标。",
    useWhenZh: "「发布/完成」语义的 outro；想讲「一键之后一切复杂性消失」的产品收尾。",
    seconds: [1, 4.8],
    energy: "medium",
    tags: ["outro","收尾与定版","strip","away","减法式收尾"],
    intentZh: "库里唯一的减法路线：点击引爆全 UI 退场，只留语义焦点（被点的按钮），把「发布=复杂性归零」翻译成动效叙事。",
    motionZh: "6 个蒸发层从侧栏→属性面板→画布卡→工具条两端→画布底→工具条中段，点击后 +4f 起每 4f 一层，每层 14f Easing.in(quad) 离场加速（fade + 方向性位移 + 0→7px 蒸发模糊）；画布内 4 张卡再错峰 3f 左右交替，背景随之压黑到 #111110；按钮 spring(damping 12、stiffness 220) 压缩脉冲并滑向屏心、scale×1.5、白晕 30→70px。",
    params: [
      { name: "层间错峰", typical: "4f × 6 层", feelZh: "同帧齐灭读作断电；>8f 拖成慢拆迁，仪式感散" },
      { name: "单层时长", typical: "14f，ease-in 加速", feelZh: "ease-out 离场读作\"飘走\"不读作\"蒸发\"；>20f 黏；再往大或往小调都会改变手感" },
      { name: "蒸发顺序", typical: "外围 → 中心，按钮所在层最后", feelZh: "中心先空读作故障；按钮层先走全卡崩塌；再往大或往小调都会改变手感" },
      { name: "位移幅度", typical: "50–140px，方向各自向画外", feelZh: "无位移纯 fade 读作调透明度；同方向读作整屏平移" },
      { name: "按钮迁移", typical: "18f 滑到屏心 + scale ×1.5 + 晕光增强", feelZh: "不迁移则黑场上一颗角落小钮，读作漏删；先迁后灭顺序不可反" },
      { name: "字标接棒", typical: "按钮淡出后 ~10f 进，spring 定版", feelZh: "与按钮同屏抢戏；黑场空窗 >20f 像放完了；再往大或往小调都会改变手感" },
    ],
    soundZh: "收尾用一次收束感的 riser 落 impact，定版后留 1s 静场再出音效；不要用音乐硬收。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 outro-group-photo-launch 分工：全家福是\"加法\"峰值终镜（多功能 产品全员谢幕），本卡是\"减法\"收尾（单一动作语义、越走越静）——按 产品气质二选一，不可同片双收尾；蒸发的每层必须是语义完整的 UI 区块（侧栏/面板/工具条），按 像素区域切层会在错峰时露出结构不合理的残缺态；按钮迁移全程 zIndex 压最顶——任何蒸发层从按钮前面飘过都是穿帮；触发动作必须是\"终结性\"语义（Publish/Ship/Done）；拿 Save 或普通 确认触发全 UI 蒸发，语义配不上排场",
    recipe: {
      css: "@keyframes ms-lock{from{opacity:0;transform:scale(1.2);filter:blur(8px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-lock{animation:ms-lock 2.9s cubic-bezier(.22,1,.36,1) both}",
    },
  },
  // UI 变形为品牌两式（上游  → outro）
  {
    id: "ui-to-brand-morph",
    category: "outro",
    nameZh: "UI 变形为品牌两式",
    oneLineZh: "图标 Y 轴翻扁成竖线再撑开成品牌标志，或输入框收缩成取景框竖笔、三块图元落进槽位拼成标志。",
    useWhenZh: "品牌收尾或 outro 前的最后一拍；「你每天用的那个 UI 就是这个品牌」的视觉论证。",
    seconds: [4.3, 5.6],
    energy: "high",
    tags: ["outro","收尾与定版","brand","morph","UI 变形为品牌两式"],
    intentZh: "补第三条品牌收尾路线：产品 UI 元素自己变形成品牌符号——观众看到的不是「logo 出现了」，而是「刚才用的东西原来就是它」。",
    motionZh: "A 图标 anticipation 晃两下→Y 轴 scaleX 压扁成竖线（双层拖影+blur）→最薄处实体交换、标志按过冲 spring 从竖线撑开、琥珀斜切随后沿 45° 划入→mark 左移让位、wordmark 逐字落定；B 发送后文字飞走、标志墨色从发送键漫开灌满输入框，x/y/w/h/r 五量 spring 收成取景框竖笔，上横/下横/琥珀斜切错峰落进虚线槽位拼合。",
    params: [
      { name: "A anticipation", typical: "12–34f 倾斜 -12°/+14°/-18°→0°，inOut(sin)，transformOrigin 钉底部 78%；接地软影随倾斜偏移、翻扁时收窄", feelZh: "幅度递增才读作\"蓄力\"；只晃一下读不出预备动作；再往大或往小调都会改变手感" },
      { name: "A 翻扁", typical: "34–46f Easing.in(cubic)，scaleX 1→0.04；两层残影 opacity 0.22/0.14 + blur 6px 滞后 0.12/0.24", feelZh: "加速入是\"甩\"的关键；匀速翻读作 flip 卡片。0.04 是最薄处，实体交换在这帧做" },
      { name: "A 撑开", typical: "46f 起 spring(damping 11, stiffness 130) 驱动标志 scaleX 0.04→1（带过冲）；53f 起斜切 spring(damping 16, stiffness 170) 沿 45° 划入（cutProgress 0→1）", feelZh: "标志从闭合竖线撑开才接得住\"翻过最薄处\"；直接 scale 整个标志会断因果。斜切晚 7f 是第二拍，与取景框同时出现读不出\"刻\"；再往大或往小调都会改变手感" },
      { name: "A wordmark", typical: "mark 64–82f 左移 -471px 让位（字标起点 mark+187，整组居中）；逐字 2.6f 错峰、每字 12f：scale 1.9→1 + blur 14→0（snappy），原点钉基线；字标 112px 品牌字体 700、+0.03em（标志高 ≈ 字号 2.1 倍）", feelZh: "对照原片：各字母由大变小落位，大的时候模糊、落位时清晰（scale+blur 联动逐字落定），不是横向扫出；错峰 <2.4f 每字的\"由大变小\"读不清" },
      { name: "B 发送反馈", typical: "光标 20f 移入按下 scale 0.84 + 按钮闪白 6f；文字 11f ease-in 加速右上飞出（+760,-420）+ rotate -9° + 拖影", feelZh: "飞走必须加速——匀速飞读作平移不读作\"发出去了\"" },
      { name: "B 灌色", typical: "28–40f 标志墨色从发送键位置圆形 clip-path 漫开灌满输入框（全程实色）", feelZh: "用 opacity 渐变填色会经过一段发灰的半透明态；文字要先飞离再灌色，否则深字压在墨上" },
      { name: "B morph", typical: "30f 起 spring(damping 15, stiffness 95)，1040×132 r34 → 89×330 直角（取景框竖笔，横条直接挤成竖条）五量同步，按 spring 速度加 ≤3px 拖影；输入框投影随 morph 收掉", feelZh: "五量必须同一个 spring 驱动，分开插值会中途散架；再往大或往小调都会改变手感" },
      { name: "B 三块落下", typical: "上横 / 下横 / 琥珀斜切 58/72/86f 错峰 14f，各自 spring(damping 13) 从画外 -760px 落到槽位；落前 10f 槽位先沿轮廓画出虚线构造框（外扩 10px），落定 14f 后淡出；按速度拉伸 / 回弹压扁（原点钉底部），空中带落影、落定即平", feelZh: "错峰是\"集结\"的节奏感；齐落读作下雨；没有槽位预示，落点读作随机；再往大或往小调都会改变手感" },
      { name: "B 落定", typical: "108f 起 mark 20f 左移让位并收到 0.7（给 15 字符字标腾地方）、构造网格退场，字标 110px 逐字（1.5f 错峰）从基线升起、口号逐词；124f 起整组极缓推近 2%", feelZh: "落定后整段不动即死帧；逐拍 scale 呼吸容易读作抖动；再往大或往小调都会改变手感" },
    ],
    soundZh: "收尾用一次收束感的 riser 落 impact，定版后留 1s 静场再出音效；不要用音乐硬收。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 终点 logo 是 video-shotcraft「镜刻」标志（A：柔光亮场 + 琥珀斜切；B：瑞士网格亮场 + 钴蓝构造线）—— 参数是调校起点非实战定稿，首次实战须以真实素材回验；A 式实体交换必须发生在 scaleX ≤0.05 的最薄帧——提前换观众看见两个图形叠影，魔术穿帮；A 式 wordmark 已改为逐字 scale+blur 落定，错峰 2.2→2.6f；换更长的字标时按可感性判例正常速度看片再定间隔；B 式把标志拆成竖笔（= 输入框）+ 上横 + 下横 + 斜切四块——实战换成自家 logo 的图元分解，图元数 3–4 粒为宜，多了读作粒子不读作拼装；B 式同色图元叠合处抗锯齿会叠加（边缘那一行像素更深），拼缝出 1px 台阶；拼齐后（108f）把竖笔 + 上下横换成同几何的单一取景框路径",
    recipe: {
      css: "@keyframes ms-lock{from{opacity:0;transform:scale(1.6);filter:blur(8px)}to{opacity:1;transform:scale(1);filter:blur(0)}}.ms-lock{animation:ms-lock 4.95s cubic-bezier(.22,1,.36,1) both}",
    },
  },
  // 快门连闪硬切（上游  → rhythm）
  {
    id: "beat-cut-moves",
    category: "rhythm",
    nameZh: "快门连闪硬切",
    oneLineZh: "三次白闪各硬切同一画面的一个裁切（全景→卡片→特写），切点间隔渐紧，最后停在特写。",
    useWhenZh: "高光段落把「切」本身打成鼓点；颁奖连拍式的仪式感、关键信息加冕。",
    seconds: [3.38, 6.02],
    energy: "high",
    tags: ["rhythm","transition","beat","cut","moves","快门连闪硬切"],
    intentZh: "硬切不做任何过渡，切点间隔本身就是乐谱；切串结束必须接足量 hold 把呼吸还回去。",
    motionZh: "三次白闪各硬切同一素材的不同裁切（全景→卡片特写→标题特写），闪前对焦框锁定下一张裁切；切点 0/9/18f 起步后间隔渐紧（22f→18f），快门余韵沉降，第三闪停在特写收束。",
    params: [
      { name: "三闪切点", typical: "30/52/70（间隔 22f→18f 渐紧），闪前 30f 慢推\"活素材\"（背板上别家相机的小闪光）衬托闪后定格", feelZh: "闪前必须是活的，全片死素材三闪读不出\"定格\"；再往大或往小调都会改变手感" },
      { name: "白闪层", typical: "每闪 opacity 0.95→0 走 4f ease-out 衰减；闪帧 ±2px seed 哈希全屏抖动", feelZh: "调大或调小：0.95 起步才有闪光灯的爆点；衰减 >6f 变柔光转场，失去快门感" },
      { name: "快门余韵", typical: "切入视图 scale 1.03→1 走 6f ease-out 回落 + −16px 沉降归零", feelZh: "余韵是\"被拍到晃了一下\"；去掉后三闪读作幻灯片翻页；再往大或往小调都会改变手感" },
      { name: "三裁切", typical: "同一画面换 CSS zoom 焦点：1.0 全景 / 1.6 卡片 / 2.8 特写（「Take 1」）", feelZh: "层层逼近有叙事方向；乱序（特写→全景→特写）读作剪错；裁切边缘别切到半行字；再往大或往小调都会改变手感" },
      { name: "对焦预备", typical: "下一闪前 8f 对焦框从 1.3 倍收到下一张裁切范围（屏幕坐标投影），闪前 3f 转香槟色锁定", feelZh: "这是\"预备拍\"：观众提前知道下一张拍哪里，闪光才像被按下的快门" },
      { name: "末段收束", typical: "第三闪后特写 hold 70f，只有 1→1.015 极缓推近 + HUD「SAVED」淡入", feelZh: "三闪是重击，hold 要给足平常两倍以上；定格是照片，不加画内运动" },
    ],
    soundZh: "拍点处 impact 与画面同帧，间隔越密音量越低；黑场静默段真静音，不要用底噪填满。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；声音强依赖手法：切点必须钉在音轨拍点上，每闪一声快门咔嚓， 无声版只剩画面乱跳；钉帧走 sound-design.md §4.5 相对 shot 起点，不钉绝对帧；三个裁切要是\"同一画面的层层逼近\"而非三个无关画面——观众要在连闪 中始终认得这是谁；跨产品/跨场景的素材别用这式；切串全片 ≤1 次（P4 克制原则）：这是全片最响的一记，第二次出现 第一次就白打了；节奏偏好判例是单向\"放慢\"，本卡是刻意例外——切完的 hold（70f） 是底线不是建议，宁多勿少",
    recipe: {
      ffmpeg: "# 每一拍硬切一次：先按 BPM 算拍长，再用 select 取每拍首帧\n-vf \"select='not(mod(n,30))',setpts=N/(fps*TB)\"",
    },
  },
  // 三通道节拍器（上游  → rhythm）
  {
    id: "beat-step-list-theme-cycle",
    category: "rhythm",
    nameZh: "三通道节拍器",
    oneLineZh: "形容词列表逐拍上移一行，中央胶囊接住下一个词并换色，整场底色同拍跟换。",
    useWhenZh: "「同一产品多种气质、多主题」展示段落；全片节奏最密的一段；音乐段对拍。",
    seconds: [3.38, 6.02],
    energy: "high",
    tags: ["rhythm","typography","beat","step","list","theme"],
    intentZh: "换一次主题色是功能演示；0.6 秒换一次、连换三次，选中行、胶囊色、全场底色三件事同帧齐跳，就成了节拍器。",
    motionZh: "胶囊固定在视口中央行不动、列表 translateY 逐拍步进；拍长 18f（约 100BPM），跳变只占拍头 6f 用 snap(t)=1-(1-x)^3.2（陡 ease-out），其余 12f 完全静置；列表位移、胶囊与底色的逐通道 cross-mix、胶囊 squash 由同一个 tInBeat 驱动。",
    params: [
      { name: "拍长", typical: "18f（BEAT_LEN，改它即改 BPM 对音轨）", feelZh: "<12f 观众来不及读词只见闪色；>26f 拍感散成逐个展示；再往大或往小调都会改变手感" },
      { name: "跳变窗", typical: "拍头 6f，ease-out 指数 3.2", feelZh: "窗 >10f 或缓曲线，\"跳\"变\"滑\"，节拍器塌成滚动列表" },
      { name: "拍数", typical: "3–4 拍", feelZh: "调大或调小：5+ 拍观众适应了节奏开始走神；1–2 拍立不起\"节拍器\"人设；再往大或往小调都会改变手感" },
      { name: "squash", typical: "竖 1.14→0.96→1 / 横反相 0.97→1.01→1", feelZh: "去掉它胶囊像贴图换色；>1.2 弹跳抢了换色的戏；再往大或往小调都会改变手感" },
      { name: "底色跨度", typical: "相邻主题底色须同明度不同色相（都深色）", feelZh: "明度跳变（深→浅）会读作闪屏而非换肤" },
      { name: "铺垫/收尾", typical: "前 30f 静置；末拍后 hold ≥30f", feelZh: "没铺垫第一拍读作 bug；末拍即切没有\"停在最终色\"的确认；再往大或往小调都会改变手感" },
    ],
    soundZh: "拍点处 impact 与画面同帧，间隔越密音量越低；黑场静默段真静音，不要用底噪填满。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 theme-switch-moves 分工：那卡是单次换肤的仪式（扫场/涟漪，换一次 讲一次故事），本卡是连续多次换肤当节拍用——讲\"深色模式功能\"用那卡， 讲\"多气质/多主题体量\"用本卡；声音强依赖：拍点对齐鼓点（换 BEAT_LEN 对 BPM），无声版三通道 齐跳读作界面抽风；词表长度 ≥ 拍数+2——列表底部要留未选中的词垫着，最后一拍就停在 列表末行会露出\"下面没了\"；选中态别用\"整数拍判定反白\"：跳变 6f 里新词还在胶囊下方就先变黑，读作穿帮。 demo 用胶囊透镜（裁切副本）——字色 / 字体由几何边界决定，颜色仍跟 tInBeat 小数走",
    recipe: {
      ffmpeg: "# 每一拍硬切一次：先按 BPM 算拍长，再用 select 取每拍首帧\n-vf \"select='not(mod(n,18))',setpts=N/(fps*TB)\"",
    },
  },
  // 漫画斜格劈屏（上游  → rhythm）
  {
    id: "panel-grid-moves",
    category: "rhythm",
    nameZh: "漫画斜格劈屏",
    oneLineZh: "漫画斜格把同一主体劈成三个机位同时定格，咔咔咔三刀之后末格斜边吃屏成海报。",
    useWhenZh: "把「格子」当节奏器：同主体多机位定格并列，逐格踩拍劈出；吃拍点。",
    seconds: [3.74, 6.66],
    energy: "medium",
    tags: ["rhythm","ui-entrance","panel","grid","moves","漫画斜格劈屏"],
    intentZh: "分格发生在节拍上，格变即鼓点：同一产品三种机位同时定格，Scott Pilgrim 式的分屏语言。",
    motionZh: "全屏 3/4 侧拍 20f 后，三刀 12° 斜缝每 4f 一刀从上往下劈出，对应格硬切弹入（5f scale 1.07→1 + 白闪）；三格为全身、局部特写、微距，定格 29f 靠主体自身动作保活，末格 2f 反向回拉 + 14f 扫屏吃掉全屏。",
    params: [
      { name: "A 斜缝", typical: "SVG 双线：墨边 + 奶油纸芯（总宽 18px），12° 斜角，每刀 3f 从上往下画出", feelZh: "斜缝纸芯是漫画感命门；直缝读作分屏工具；再往大或往小调都会改变手感" },
      { name: "A 保活", typical: "定格期主体自己在动：对焦环转 26°、光圈叶片收拢、全身格极缓推近", feelZh: "三格全静读作截图拼贴；\"镜头在工作\"比缓推更有内容" },
      { name: "A 旁白框", typical: "奶油底 + 4px 墨描边 + 7px 硬投影，-2° 歪斜盖章弹入，活在格子里随格被盖掉", feelZh: "漫画语言的第二个锚点；浮在格子上方会穿帮；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "最后一行字揭示完后 ~50f 海报 hold（只留 1.5% 极缓推近）", feelZh: "R1；摘罩帧与吞屏终值逐像素对齐防跳变；再往大或往小调都会改变手感" },
    ],
    soundZh: "拍点处 impact 与画面同帧，间隔越密音量越低；黑场静默段真静音，不要用底噪填满。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在虚构内容（矢量镜头）上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；三格必须是同一主体的不同机位——三格塞不同内容读作 bento 排版不是漫画分格，语义就散了；吃拍点、声音强依赖：逐格咔咔三声（sound-design §4.5）；不踩拍的分格只是布局动画；主体用 SVG 矢量画（或高分辨率素材）：三格机位最高放大 2.45x， 位图截图放大会糊（Q2）；同片分格系 ≤1 段——格子语言辨识度太强，两段就撞",
    recipe: {
      ffmpeg: "# 每一拍硬切一次：先按 BPM 算拍长，再用 select 取每拍首帧\n-vf \"select='not(mod(n,18))',setpts=N/(fps*TB)\"",
    },
  },
  // 四宫格并行轰炸（上游  → rhythm）
  {
    id: "quad-split-parallel-scenes",
    category: "rhythm",
    nameZh: "四宫格并行轰炸",
    oneLineZh: "画面硬切 2×2 四宫格，四个象限并行跑各自的微场景，关键节拍错开 3–6 帧制造信息轰炸。",
    useWhenZh: "节奏段「功能很多、同时发生」的蒙太奇；预告片中段的密度峰值。",
    seconds: [2.16, 3.84],
    energy: "high",
    tags: ["rhythm","quad","split","parallel","scenes","四宫格并行轰炸"],
    intentZh: "用并行密度替代顺序展示：观众来不及逐一细读，但每 3–6 帧就有一个象限动一下，扫视节奏被牢牢钉住——错拍编排才是配方。",
    motionZh: "四象限独立场景（tab 弹入+地址栏打字、终端输出+急推、逐词、点击交互链），任意相邻重事件间隔 ≥3 帧：TL tab 6/11/16/21、页面 44，TR 输出 27/33、急推 37，BL 词 14/30/49，BR 点击 25/变色 27/点击 52/通知 56；两处光标闪烁周期错开（16f vs 14f+5 相位）；四格明度棋盘交错、8px 暖黑缝 + 20px 圆角分格。",
    params: [
      { name: "错拍间隔", typical: "相邻重事件 3–6 帧", feelZh: "<2 帧读作同拍（齐动=呆板）；>8 帧密度散掉，轰炸感消失" },
      { name: "TL 慢推", typical: "inQuad 1→1.1，origin 50% 90%", feelZh: "全程缓慢加速的\"底噪运动\"，让静格也不静；过大窗口会顶到角标" },
      { name: "TR 急推", typical: "37–47f，scale 1.85 + blur 峰值 5px，旧行淡到 8%", feelZh: "这是全卡最重的一拍，压 BGM 重音；blur 包络必须 sin（进出对称）" },
      { name: "打字速度", typical: "TL 20 字符 / 0–40f，TR 19 字符 / 0–24f", feelZh: "换文案保持字符数近似，否则打字节奏与其他象限错拍关系漂移；再往大或往小调都会改变手感" },
      { name: "BR 交互链", typical: "滑入 4→巡游 14→点击 25→变色 27→二段巡游 38→点击 52→通知 56", feelZh: "环环相扣，改任何一步需顺延后续；通知 overshoot 弹出是链尾重音" },
      { name: "底色", typical: "浅 / 深 / 强调 / 浅 棋盘交错", feelZh: "换项目主题色时保持相邻格明度差 ≥15%，否则格线感消失；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "62f 后终态 hold 28f", feelZh: "并行轰炸后必须给一拍让四格同时被读到；再往大或往小调都会改变手感" },
    ],
    soundZh: "拍点处 impact 与画面同帧，间隔越密音量越低；黑场静默段真静音，不要用底噪填满。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "这是手法卡：四格内容整体可换（产品截图/录屏/其他动效卡），但错拍表必须重排——新内容的关键帧继承原时刻表，否则四格变四个独立视频拼贴；轰炸段 ~2.1s 是密度上限，再拉长需给每象限加第二轮事件，否则后半段\"没东西动\"；收尾 hold 另算；光标闪烁按帧号计算（周期 16f / 14f+5），改时间表后重新核对两个光标的错相位；四格同时打字/同时弹入是最常见的退化写法——检查方式：逐帧过一遍，任何一帧不应有两个象限同时发生\"重事件\"",
    recipe: {
      ffmpeg: "# 每一拍硬切一次：先按 BPM 算拍长，再用 select 取每拍首帧\n-vf \"select='not(mod(n,3))',setpts=N/(fps*TB)\"",
    },
  },
  // 跳切推近（上游  → rhythm）
  {
    id: "rhythm-interrupt-moves",
    category: "rhythm",
    nameZh: "跳切推近",
    oneLineZh: "同构图三次无补间硬跳放大（1x→1.6x→2.6x），逐级逼近目标。",
    useWhenZh: "用「打断连续性」当节奏器：强制聚焦指标；与切点排布类互补。",
    seconds: [3.24, 5.76],
    energy: "medium",
    tags: ["rhythm","interrupt","moves","跳切推近"],
    intentZh: "观众预期连续、你偏打断，打断方式即表达：戈达尔式跳切比连续推近更有「看这里、再近点、就是它」的指令感。",
    motionZh: "transform-origin 钉在目标中心，三档 scale 阶梯跳变（完全零补间），每跳 2f 加深一次脉冲当 tick，逐级逼近核心指标。",
    params: [
      { name: "A 跳挡", typical: "1.0→1.6→2.6，各 hold ≥35f", feelZh: "挡差 <1.5× 读作画面抖了一下；再往大或往小调都会改变手感" },
      { name: "A tick", typical: "跳变帧起 2f brightness 0.92 全画面脉冲", feelZh: "无 tick 的跳切读作丢帧；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "末挡 ≥45f 真静止", feelZh: "打断系事后 hold 从重给" },
    ],
    soundZh: "拍点处 impact 与画面同帧，间隔越密音量越低；黑场静默段真静音，不要用底噪填满。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 speed-ramp-freeze 都动\"时间轴\"，同一镜头只能有一个时间 操纵者；三挡构图必须同 origin（钉死目标中心）——每挡重新构图就是 三个镜头，不是跳切；声音强依赖：每跳一声 tick（sound-design §4.5）",
    recipe: {
      ffmpeg: "# 每一拍硬切一次：先按 BPM 算拍长，再用 select 取每拍首帧\n-vf \"select='not(mod(n,1))',setpts=N/(fps*TB)\"",
    },
  },
  // 一拍三转一拍一（上游  → rhythm）
  {
    id: "sakuga-timing-shift",
    category: "rhythm",
    nameZh: "一拍三转一拍一",
    oneLineZh: "元素先以每 3 帧一步的手翻书顿挫移动，高潮瞬间切到逐帧丝滑冲刺——帧率量化的突变本身就是看点。",
    useWhenZh: "单元素的强调性位移（卡片入场、指标冲线）；需要「手工感→高潮爆发」反差的段落。",
    seconds: [3.6, 6.4],
    energy: "medium",
    tags: ["rhythm","ui-entrance","sakuga","timing","shift","一拍三转一拍一"],
    intentZh: "改的不是速度而是帧率本身：一拍三的钝与一拍一的滑同屏对切，是日式作画的拍数演出（shooting on 3s / on 1s）。",
    motionZh: "顿挫段用驱动帧 q=floor(f/3)*3，位置线性 140→1180、16 张原画每步约 69px，姿势随 q 冻结（sin(q) 旋转 ±5° + 0.97/1.035 挤压/拉伸 + 一高一低小跳 −18/−2px）；f48 两帧反相冲击帧作高潮标记后改原始帧连续驱动，Easing.out(poly(4)) 高初速冲刺折返中央 + 过冲 40px + 6f 回弹，落地 scaleX 0.92 / scaleY 1.07，身后 9 条速度线长度 ∝ 速度。",
    params: [
      { name: "拍数", typical: "顿挫段 floor(f/3)（一拍三）", feelZh: "/2 顿感不足、/4 以上读作播放器卡死；再往大或往小调都会改变手感" },
      { name: "每步位移", typical: "≈69px（总程 1040 ÷ 15 步倒推）", feelZh: "<30px 读作卡顿掉帧不是顿挫——命门；再往大或往小调都会改变手感" },
      { name: "步间姿势", typical: "sin(q) rotate ±5° + 挤压/拉伸交替 + 一高一低小跳", feelZh: "无姿势变化的纯位移顿挫像 bug 不像手翻书；再往大或往小调都会改变手感" },
      { name: "切换帧", typical: "f48（顿挫:冲刺 ≈ 3:2）", feelZh: "切换必须一帧完成，任何补间都毁掉\"换拍\"感；再往大或往小调都会改变手感" },
      { name: "冲刺缓动", typical: "Easing.out(poly(4)) + 过冲 40px + 6f 回弹", feelZh: "初速要猛，与顿挫段拉满反差；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "落位后 hold 70f（只留 2% 极缓推进），角标沸腾 f108 冻结", feelZh: "沸腾残留毁真静止（feTurbulence 摘罩判例同族）；再往大或往小调都会改变手感" },
    ],
    soundZh: "拍点处 impact 与画面同帧，间隔越密音量越低；黑场静默段真静音，不要用底噪填满。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 用手搓作画纸 + 赛璐珞卡调校——参数是调校起点非实战定稿， 首次实战须以真实素材回验；冲击帧是全画面级冲击（R4 计数），一个镜头只给切换点这一次，且只给 2f；同一镜头单一时间操纵者判例：与 speed-ramp-freeze / hit-counter 顿帧 互斥，一个镜头只能有一个人动时间轴；顿挫段每步位移 ≥30px 才读得出\"顿\"——微步顿挫读作渲染掉帧， 这是本卡命门；步幅不够就缩短总时长换大步幅；切换点必须有标注（角标 \"ON 3s\"→\"ON 1s\"、摄影表格子或一声打点， sound-design §4.5）——无标注观众只觉得\"变快了\"，读不出\"换拍\"",
    recipe: {
      ffmpeg: "# 每一拍硬切一次：先按 BPM 算拍长，再用 select 取每拍首帧\n-vf \"select='not(mod(n,3))',setpts=N/(fps*TB)\"",
    },
  },
  // 流动定格圈注（上游  → rhythm）
  {
    id: "speed-ramp-freeze",
    category: "rhythm",
    nameZh: "流动定格圈注",
    oneLineZh: "流动画面突然定格、快门白闪、四角取景框弹入、马克笔圈出重点，然后再解冻继续流动。",
    useWhenZh: "卡片流或长横移里把一个重点「停下给人看」；教学解说、评审语境。",
    seconds: [3.82, 6.78],
    energy: "high",
    tags: ["rhythm","speed","ramp","freeze","流动定格圈注"],
    intentZh: "匀速流读作 PPT、全程快流观众抓不住重点；定格标注在一条运动里干脆停下来，马克笔圈出重点再走，语义是「停课划重点」。",
    motionZh: "输出帧对源帧做非线性 remap（斜率即速率）：流动段 26px/源帧 → 定格段斜率 0（瞬时切换、无缓入）→ 解冻段 smootherstep；定格帧快门白闪 3f、四角取景框弹入、时间码从 LIVE 切 PAUSED 并停住；强调色马克笔 10f 描边 1.08 圈、收笔不闭合，再加箭杆 6。",
    params: [
      { name: "定格时长", typical: "≥45f", feelZh: "短了凝视不成立（R3 宁慢勿快）" },
      { name: "解冻补偿", typical: "smootherstep 22f 走完一张卡（平均斜率 >1）", feelZh: "解冻太慢全片拖沓；不补偿则定格吃掉的时间读作冷场" },
      { name: "圈注描边", typical: "10f 划完 + 抖动 scale 6", feelZh: "太慢像加载动画；无抖动像机械标注" },
      { name: "暂停信号", typical: "快门白闪 3f + 取景框四角 + 时间码 PAUSED", feelZh: "无信号时观众分不清\"定格\"和\"卡顿\"；再往大或往小调都会改变手感" },
    ],
    soundZh: "拍点处 impact 与画面同帧，间隔越密音量越低；黑场静默段真静音，不要用底噪填满。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "SFX 钉帧跟输出帧不跟源帧（画面动作在输出时间轴上发生）； 拟音槽位：定格配马克笔沙沙声（S4），本卡转正时未配、实战补；定格标注一支 30s 片 ≤2 次（克制原则）；参数经占位素材调校转正，非实战定稿，首次实战后回验",
    recipe: {
      ffmpeg: "# 每一拍硬切一次：先按 BPM 算拍长，再用 select 取每拍首帧\n-vf \"select='not(mod(n,45))',setpts=N/(fps*TB)\"",
    },
  },
  // 预告片开场钩（上游  → rhythm）
  {
    id: "trailer-grammar-moves",
    category: "rhythm",
    nameZh: "预告片开场钩",
    oneLineZh: "正片前先塞三个 9f 速剪的最抓眼镜头，黑场静默一拍后再出开场标题。",
    useWhenZh: "预告片的 cold open：正片前先给三个最抓眼的镜头，再静默一拍正式开场。",
    seconds: [3.38, 6.02],
    energy: "high",
    tags: ["rhythm","opening","transition","trailer","grammar","moves"],
    intentZh: "不是某个镜头怎么动，而是整片的关节怎么接：0.9 秒速剪钩子加黑场静默一拍，这是预告片的「预告」。",
    motionZh: "三镜头各 9f 等长硬切（0/9/18），每镜内部 scale 1→1.04 微推保活；27–33f 纯黑静默，33f 起标题 16f 淡入 + 44px out-cubic 微升。",
    params: [
      { name: "A 速剪", typical: "三镜等长 9f，零过渡；镜头 3 对焦中列 Top pages 卡放大 2.2x 怼脸特写（CSS zoom，字不糊）", feelZh: "节拍感靠等长；三镜构图必须明显不同" },
      { name: "A 微推", typical: "每镜内部 scale 1→1.04 线性", feelZh: "静帧三连读作幻灯片——命门；再往大或往小调都会改变手感" },
      { name: "A 黑场", typical: "27–33f 纯黑 #000 空 div，6f", feelZh: "黑场里放任何东西都毁掉\"静默一拍\"；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "A 静止 77f（≥40f）", feelZh: "字距收拢完（63f）后整帧冻结，真静止；再往大或往小调都会改变手感" },
    ],
    soundZh: "拍点处 impact 与画面同帧，间隔越密音量越低；黑场静默段真静音，不要用底噪填满。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；A 黑场必须纯黑无物（drop-blackout 判例同族）——黑场是喘息， 不是又一张字卡；A 三连切每切一声打点、黑场全消音（sound-design §4.5）",
    recipe: {
      ffmpeg: "# 每一拍硬切一次：先按 BPM 算拍长，再用 select 取每拍首帧\n-vf \"select='not(mod(n,9))',setpts=N/(fps*TB)\"",
    },
  },
  // 底边上推换章（上游  → transitions）
  {
    id: "bottom-push-stack-wipe",
    category: "transitions",
    nameZh: "底边上推换章",
    oneLineZh: "新场景连底色整屏从底边向上推入，把旧场景物理顶出画外，连推数章各配一种饱和底色。",
    useWhenZh: "多章节产品片的换章骨架（每章一个卖点一种底色）；需要「翻页节奏感」贯穿全片的段落切换。",
    seconds: [1.2, 5.7],
    energy: "medium",
    tags: ["transition","转场","bottom","push","stack","wipe"],
    intentZh: "第三种物性：新章把旧章顶出去，两屏刚性接触、同速同向位移，像自动售货机压栈；命门是底色+窗口卡+装饰条焊成一块整料一起走。",
    motionZh: "每章一个整屏层，translateY 从 +1080 推到 0，旧章同步被顶到 −1080——两层位移严格同步同缓动，任何速差都读作滑动穿模；推入用重 ease-out cubic-bezier(0.12,0.9,0.2,1) 共 26f（约 12f 已到 95%），新章上缘带 56px 渐变接缝阴影 + 2px 受光边，落定后归零。",
    params: [
      { name: "推入时长", typical: "26f，重 ease-out", feelZh: "<20f 读作闪切；线性匀速读作卷帘门，\"哐\"感全无；再往大或往小调都会改变手感" },
      { name: "章间 hold", typical: "~18f 静止 + 推入尾段，章内总停留 ~44f", feelZh: "章内是内容表演区，<25f 观众没看清就被顶走；再往大或往小调都会改变手感" },
      { name: "接缝阴影", typical: "上缘 56px，章色深档 0.42 渐变 + 2px 受光边", feelZh: "去掉后两屏像叠影滑动；>80px 读作新章自带黑边；再往大或往小调都会改变手感" },
      { name: "底色", typical: "每章一种饱和色，相邻章色相拉开", feelZh: "相邻章同色系则\"换章\"读作\"微调\"；灰阶章只能当第 0 章" },
      { name: "内容钉死", typical: "窗口卡/装饰条用章内绝对坐标", feelZh: "内容若相对视口定位就会\"漂\"在推入动画上，穿帮；再往大或往小调都会改变手感" },
      { name: "连推次数", typical: "2–4 章", feelZh: "调大或调小：1 次不成节奏；>4 次观众开始数底色，疲劳；再往大或往小调都会改变手感" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 wipe-transitions 分工：那卡新旧页都不动、一条几何边界扫过交接 （中性、哪儿都能用）；本卡两页都在动、刚性顶出（有物性、自带章节 节奏）——单次接缝用那卡，全片骨架用本卡；与 shot-transitions 三式同层选型：本卡能量中档、方向固定向上， 需要能量落差大的接缝（如进 outro）让位给流白；方向统一是骨架感的来源：全片所有章都从底边推，中途换成左推/顶推 节拍器就散了——要变方向就别当骨架用；推入进行中两章同屏，都是满屏层——章内动画（卡片入场等）避开推入 的 26f 窗口（至少等到 95% 落位），不然两章都在动，视线没有锚点",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.15:offset=3.45[v]\"",
    },
  },
  // 功能卡 3D 翻面（上游  → transitions）
  {
    id: "card-flip-reveal",
    category: "transitions",
    nameZh: "功能卡 3D 翻面",
    oneLineZh: "卡片沿 Y 轴翻 180°，正面 UI 在侧棱最薄处掠过一道随角度移动的受光，背面揭出大号结论数字。",
    useWhenZh: "「功能→成果」的成对叙事：一排功能卡逐张翻出各自的指标；元素级转场。",
    seconds: [3.6, 6.4],
    energy: "medium",
    tags: ["transition","转场","data","card","flip","reveal"],
    intentZh: "一张卡的正反两面是一对因果：正面是功能界面、背面是数字结论，翻面动作本身就是「所以呢？」的回答。",
    motionZh: "perspective 1600px + preserve-3d，双面各自 backface hidden；翻转三段：4f 预备反向后仰 −10° → 16f bezier(0.55,0,0.3,1) 加速翻到 194°（14° 过冲）→ spring(damping 15) 回落 180°，翻转中 translateZ 抬起 60px（sin 包络）；侧棱 56°→124° 区间一道受光带随角度从卡左扫到右、90° 最薄处达峰。",
    params: [
      { name: "翻转时长", typical: "4f 预备 + 16f 翻 + ~10f 弹簧", feelZh: "<14f 看不到侧棱瞬间；>28f 读作慢慢转；砍掉预备读作被弹开而不是\"翻\"" },
      { name: "过冲", typical: "194°→180°（14°），spring damping 15", feelZh: "无过冲落定读作生硬停表；damping <12 回弹两次读作果冻；再往大或往小调都会改变手感" },
      { name: "受光", typical: "面压暗 ≤0.55 + 侧棱窄带峰值 @90°", feelZh: "峰值错开 90° 读作贴图错误；只有扫光没有面压暗读作贴了一道白条" },
      { name: "错峰", typical: "12f/卡，≤4 卡", feelZh: "同时翻读作整墙翻面，\"成果连报\"的逐张节奏就没了；再往大或往小调都会改变手感" },
      { name: "背面内容", typical: "大号数字（150–170px 级）+ 一行标签 + 至多一组对照条", feelZh: "背面塞完整 UI 读不完——翻面后只有一拍注意力；数字超 160px 时 \"−41%\" 这类宽字会顶出卡边；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "末卡落定真静止 ≥40f", feelZh: "手感：末卡落定真静止 ≥40f 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；正反两面必须语义成对（界面→它的成果）；翻出无关内容，翻面就 只是花哨的换图；真实素材正面用截图时注意 backface 渲染开销，三卡以上分 Sequence；声音候选位：每卡翻停帧一声轻\"啪\"（sound-design §4.5），三连啪 节奏感翻倍",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.2:offset=5[v]\"",
    },
  },
  // 卡群翻飞收束（上游  → transitions）
  {
    id: "card-flock-tumble",
    category: "transitions",
    nameZh: "卡群翻飞收束",
    oneLineZh: "三张页卡从侧棱薄边 3D 翻飞成阶梯站定、保持慢转，再被吸入中心炸出烟雾环、巨字横贯收场。",
    useWhenZh: "能量高潮段（功能页群→品牌口号的爆点转场）；霓虹或极光暗场调性；多页面能力收束成一句话。",
    seconds: [0.3, 4.5],
    energy: "high",
    tags: ["transition","转场","card","flock","tumble","卡群翻飞收束"],
    intentZh: "能力展示→能量坍缩→口号爆发一气呵成；命门是样条丝滑、站定后不许停、全程清晰。",
    motionZh: "三卡各自 k0（近 90° 侧棱）→k1（翻飞中段）→k2（阶梯站定）走 Catmull-Rom 样条，Easing.out(cubic) 驱动约 44f；站定后保持慢转 ry +0.34°/f、rx −0.1°/f、rz +0.05°/f；收束 10f Easing.in(quad) 加速吸入中心，到点同帧白热核 + 全屏 12% 微曝 6f 指数衰减，烟雾环从闪核里长出。",
    params: [
      { name: "三卡间距/大小", typical: "大幅重叠成一叠阶梯、scale 1.6–1.74", feelZh: "两轮加码判例：\"再靠近一些，再大些\"——阶梯要读作一组不是三张" },
      { name: "站定慢转", typical: "ry ~0.34°/f 连续", feelZh: "不许静止（判例）；>1°/f 读作还没站定；再往大或往小调都会改变手感" },
      { name: "收束时长", typical: "10f ease-in", feelZh: "调大或调小：22f 版被裁\"要快\"；透明度早退=吸入不可读（返工判例）" },
      { name: "烟雾环", typical: "单圈、湍流絮边、衰减极慢", feelZh: "多圈被裁；平滑霓虹圈/粒子版被裁——对照原片密帧做湍流质感" },
      { name: "模糊", typical: "全程零 blur", feelZh: "翻飞/收束加 blur 均被裁" },
      { name: "样条", typical: "一条 Catmull-Rom 贯穿", feelZh: "分段 lerp 有速度台阶，\"丝滑流畅\"是裁决原话；再往大或往小调都会改变手感" },
      { name: "巨字入场", typical: "收束到点后 4f、14f snappy 1.22→1 + 字距收拢", feelZh: "原版等 14f 才出字，中间一段只有小环的黑场，高潮断气；慢放大（0.7→1 / 34f）读作淡入而不是砸" },
      { name: "闪核", typical: "径向白热核 + 全屏 12% 微曝，6f 衰减", feelZh: "去掉后环像凭空冒出；加描边亮环立刻廉价（判例同烟雾环）" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；烟雾环质感判例：干净图形环（描边圆/同心波）三轮被裁，最终版 feTurbulence 湍流絮边对照原片密帧逐格校——\"要一样\"；残余差距 是噪声场静态（整体旋转+长大），无逐帧湍流滚动，极近看流动感弱；烟雾环是能量坍缩的余波，不是庆祝打击点——禁加粒子礼花",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=0.8:offset=2.4[v]\"",
    },
  },
  // 圆心匹配光圈切（上游  → transitions）
  {
    id: "circle-match-iris",
    category: "transitions",
    nameZh: "圆心匹配光圈切",
    oneLineZh: "光圈从页面上一个圆形元素的圆心炸开，圈内新页的圆形图表接在同一个圆上——匹配剪辑给光圈一个语义锚点。",
    useWhenZh: "前景有圆形元素（头像、图标、圆钮）而后景有圆形主体（donut 图、圆环进度）的接缝。",
    seconds: [3.96, 7.04],
    energy: "medium",
    tags: ["transition","转场","circle","match","iris","圆心匹配光圈切"],
    intentZh: "普通 iris 只读作换页；圆心匹配让圆形本身完成叙事：头像的圆变成图表的圆，这个人→这个人的数据。",
    motionZh: "两景圆严格同心是命门：锚点圆心写死为一组常量，头像、涟漪、clip-path、新景圆环、刻度盘全引用同一组常量；40–47f 头像收到 0.9 做预备，开圈瞬间新景圆环描边宽 = 直径（看似实心头像），28f 内半径 36→300、描边收到 44px（expo-out），光圈再于 54–84f 用 ease-in 加速外扩 2400px。",
    params: [
      { name: "锚点脉冲", typical: "2 次 scale 1→1.16 + 光环扩两道（18f / 30f 起，各 22f）", feelZh: "没有定睛引导，开圈瞬间观众找不到圆心；再往大或往小调都会改变手感" },
      { name: "接圆", typical: "实心盘→圆环：r 36→300、描边 72→44px / 28f expo-out", feelZh: "圆环与光圈各长各的，\"头像变成图表\"就读不出来" },
      { name: "光圈扩张", typical: "圆环外沿 + 0→2400px / 30f bezier(.62,0,.32,1)", feelZh: "快于 20f 接圆读不到；圆心偏移 >10px 一眼穿帮" },
      { name: "旧页推远", typical: "scale 1.03→1.22 + 亮度 1→0.45 / 34f ease-in", feelZh: "旧页不动，新景像贴在上面的圆形贴纸；再往大或往小调都会改变手感" },
      { name: "sweep", typical: "60–118f 到 87%，bezier(.4,0,.12,1)，数字同步计数", feelZh: "数字与 sweep 异步读作两个动画；太快（<40f）数字读不出在爬" },
      { name: "收尾", typical: "sweep 完成后静止 47f（只留刻度盘 0.06°/f 慢转 + 弧光呼吸）", feelZh: "手感：sweep 完成后静止 47f（只留刻度盘 0.06°/f 慢转 + 弧光呼吸） 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 是手搓的 video-shotcraft 出片周榜（暗场荧光绿；景 A 创作者排行 → 景 B 本周出片目标圆环）——参数是调校起点非实战定稿， 首次实战须以真实素材回验；真实素材上锚点坐标从截图量测（devtools/标尺），量到的是元素盒不是 视觉圆心——带内边距的头像取内容圆心；量完渲一帧对不齐就调常量， 别信第一次量的数（同 transition-travel A 字腔穿越的腔心判例）；前景锚点必须是真圆：圆角方块（border-radius < 50%）当锚点， 开圈瞬间方圆错型一眼假；真实截图里锚点是圆角方块时，先用同色补丁盖住再叠真圆；语义要成对：头像→个人数据、产品图标→产品指标——圆对圆只是形， \"这个圆的内容变成它的展开\"才是匹配剪辑成立的因；一缝一式规矩同 shot-transitions；本卡自带图表生长段，圈内新景 别再叠入场动效",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.2:offset=5.5[v]\"",
    },
  },
  // 渐变背景变奏（上游  → transitions）
  {
    id: "gradient-transition",
    category: "transitions",
    nameZh: "渐变背景变奏",
    oneLineZh: "背景在 linear、radial、conic 三类 CSS 渐变之间平滑过渡，角度、色标、中心、半径逐参数插值。",
    useWhenZh: "氛围底或章节底色的连续变奏；给静态排版段落提供一层「活着」的背景。",
    seconds: [2.3, 6.7],
    energy: "low",
    tags: ["transition","转场","gradient","渐变背景变奏"],
    intentZh: "渐变不是静态贴图而是可动画的参数集：同类型内部逐参数插值，跨类型用 12–14f 的窄窗口交叉淡化衔接。",
    motionZh: "三层各持一种渐变类型、同一时刻只有一层主导；linear 0–68f 角度 18°→198°、三档明度色标在 HSL 三通道插值；radial 56–132f 圆心 (24%,72%)→(68%,38%)、半径 48%→80%；conic 118–200f 三色环 from 0→250° 慢起长尾越转越慢落定，圆心放在主体右后方 (64%,54%)。",
    params: [
      { name: "段窗口重叠", typical: "相邻段起点比前段终点早 12f", feelZh: "重叠保证淡化时两层都在动；无重叠会看到\"接管瞬间静止\"" },
      { name: "交叉淡化", typical: "56–68f / 118–132f（smooth in-out）", feelZh: "拉宽会同屏看到两种渐变结构打架；窄淡化 + 参数同动是\"换类型不换气\"的关键；再往大或往小调都会改变手感" },
      { name: "HSL 插值", typical: "h/s/l 三通道独立 lerp", feelZh: "色相差 >180° 时会绕远路（如 340→160），需要短路径时给起点 +360" },
      { name: "色标明度差", typical: "linear 亮 64 / 中 40 / 暗 7", feelZh: "明度差 <20 时角度扫过读不出来，只剩一块在变色的平底；再往大或往小调都会改变手感" },
      { name: "radial 迁移", typical: "中心对角走位 + 半径 48%→80%", feelZh: "中心不动只扩半径会读作\"呼吸\"不是\"游走\"；再往大或往小调都会改变手感" },
      { name: "conic 旋转", typical: "from 0→250°（不满一圈，ease-out 长尾）", feelZh: "转满 360° 收尾与开头同帧，接循环时用；单次播放留缺口避免\"回到原点\"感；再往大或往小调都会改变手感" },
      { name: "色标组", typical: "三段同一组紫 / 品红 / 冰蓝", feelZh: "换项目色时保持\"亮色+暗色\"配对结构，radial 外圈必须暗（光斑成立的前提）" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "这是背景卡：前景放排版/UI 时在文字一侧叠暗色 scrim（demo 左侧线性压暗 + 外圈暗角），否则 conic 段的亮色会吃掉前景对比度；radial-gradient(circle R …) 的 R 只接受长度：写成 circle 45% 整条渐变失效、该段渲成纯黑——百分比半径要么换算成 px（demo 以小画布宽 480px 为 100%），要么改用 ellipse X% Y%；CSS 渐变字符串每帧重写触发 repaint 而非 composite——大画幅 + 低端设备需实测；Remotion 服务端渲染无此顾虑；conic 段用三色循环（A→B→C→A）；七段彩虹色环是\"演出\"性质，品牌化场景别用；三段各自独立可拆用：只要 linear 段（0–68f 重归一化）就是一张\"角度扫过\"的极简底",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.2:offset=4.5[v]\"",
    },
  },
  // 线条接力横移（上游  → transitions）
  {
    id: "line-carry-transition",
    category: "transitions",
    nameZh: "线条接力横移",
    oneLineZh: "场景 A 的进度条延伸出画，镜头跟着线横移，线在移动中拐直角围出场景 B 的卡框，全程无剪切。",
    useWhenZh: "两个有图形亲缘的场景之间（进度条→卡框、下划线→图表轴）；一支片子的招牌转场位。",
    seconds: [4.54, 8.06],
    energy: "medium",
    tags: ["transition","转场","camera","line","carry","线条接力横移"],
    intentZh: "根本不换：一条线牵着你走过去，图形连续性本身就是转场——观众的眼睛从头到尾没离开过这条线。",
    motionZh: "3840 宽世界容器 translateX 当镜头，56–112f 移 1920px（smooth in-out bezier .65,0,.35,1）；一条手写折线 path（进度条 648 + 冲出段 + 直角 + 720×480 矩形框）全程 dasharray evolve；命门是横移段 drawn=1144+cam 让笔头钉在画面 x≈1480、永不出画也不落后；交接处两端零速：进度条 ease-out 到零速→满格停 6f（翻成完成、对勾弹出）→冲出段 swift 零速→镜头 in-out 零速起步→收框 in-out 接住落点。",
    params: [
      { name: "线体", typical: "8px 墨色实线，方头 + 直角 miter", feelZh: "太细横移中读丢；虚线读作未完成态" },
      { name: "横移配比", typical: "1920px / 56f（均速 34px/f）", feelZh: "更远的横移等比拉长时长，别提速——峰速 >80px/f 笔头开始跟丢" },
      { name: "笔头位置", typical: "画面 x≈1480（约 77% 处偏右）", feelZh: "居中读作\"线追镜头\"；贴边一颤就出画；再往大或往小调都会改变手感" },
      { name: "拐角", typical: "直角硬拐，不倒圆", feelZh: "圆角软拐丢掉制图感，Saul Bass 味就没了；再往大或往小调都会改变手感" },
      { name: "框闭合", typical: "闭合帧起框内内容再出", feelZh: "框没闭合内容先出，线的悬念白搭；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "海报长完后 ≥24f 真静止", feelZh: "笔头墨点必须条件卸载，残留即毁静止；再往大或往小调都会改变手感" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 是手搓的 video-shotcraft 渲染场景（米色纸 + 墨 + 赤陶；A 渲染发布片进度卡 → B 这支片的海报）——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 draw-svg-trace 的关系：那是元素级描边点名（线属于元素），这是 场景级线条接力（线属于镜头）——同片可共存，但线的语义要一致： 同为 ink 8px 几何硬线，或同为手绘感，混用读作两套美术；全片 ≤1 次——这是招牌转场不是常规转场，第二次出现魔法就穿帮；起点必须是已有图形构件的自然延伸（进度条走满、下划线画完）， 凭空起线读作屏保；声音：线生长一声持续笔擦、框闭合一声轻叩（sound-design §4.5）",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.2:offset=6[v]\"",
    },
  },
  // 马赛克重排版（上游  → transitions）
  {
    id: "mosaic-reframe",
    category: "transitions",
    nameZh: "马赛克重排版",
    oneLineZh: "12 张瓦片在规则网格、feature mosaic、对角瀑布三种排版间连续变形，位置宽高各自插值、逐片微错峰。",
    useWhenZh: "「同一批内容多种看法」的陈列转场：作品集、模板库、相册产品的布局能力展示。",
    seconds: [5.11, 9.09],
    energy: "medium",
    tags: ["transition","转场","mosaic","reframe","马赛克重排版"],
    intentZh: "让观众看见「布局本身在思考」：同样 12 张内容从整齐档案态变成有主次的策展态，再变成有态度的动态态。",
    motionZh: "三套布局按 1920×1080 原生像素硬编码坐标表（A=4×3 规则网格间距 24；B=6×4 单元格 mosaic 首片占 3×2 大位间距 16；C=竖幅对角瀑布）；位置与宽高各自插值、逐片微错峰，A→B 56–92f、B→C 132–176f，段间留 hold。",
    params: [
      { name: "段时长 / hold", typical: "A→B 26f、B→C 30f；hold A 30f、B 36f、C 34f", feelZh: "hold 是读版面的呼吸位，压到 <20f 三段糊成一段；再往大或往小调都会改变手感" },
      { name: "控件→瓦片滞后", typical: "4f", feelZh: "调大或调小：0 = 读不出因果；>8f 像控件失灵；再往大或往小调都会改变手感" },
      { name: "错峰跨度", typical: "A→B 10f、B→C 14f", feelZh: "调大或调小：0 = 整版机械闪变；>24f 波浪抢过版面本身；再往大或往小调都会改变手感" },
      { name: "瀑布参数", typical: "相纸 300×372，中心间距约 (79,65)px，rot −15°+3°/片", feelZh: "旋转递增是\"串\"的灵魂；等角会退化成斜排网格；再往大或往小调都会改变手感" },
      { name: "mosaic 大位", typical: "首片 3×2 单元格", feelZh: "换 slots 表可重排主次；保证有一块 ≥2×2 的锚点位" },
      { name: "抬起包络", typical: "scale +3.5%、阴影 elevation 6→40", feelZh: "太大像弹窗乱飞，0 读作平面滑块" },
      { name: "瓦片内容", typical: "SVG 程序照片（viewBox + slice ≈ cover，八式暖调胶片风）", feelZh: "换真实照片时保留 overflow:hidden 圆角容器 + object-fit: cover；再往大或往小调都会改变手感" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。音效密度与画面节拍一致即可。",
    pitfallsZh: "中心/宽高独立插值意味着不能换成 transform: scale——宽高动画会引发子元素重排，图片要用 object-fit: cover；C 段末片有意越出画框底边，画框裁切是构图的一部分；C 的对角线要避开左上字标和右上控件，左下留给标题；竖幅相纸会把横幅照片裁成中间一条：照片主体放画面水平中心附近；主图的太阳偏右，给左下图注让位；叠放次序只能在\"无重叠\"的态切换（B→C 起跳帧），在重叠中途换 zIndex 会看到瓦片跳层；段窗口 + 错峰 + 滞后叠加后末片 B→C 约 176f 才落定，再加段落需压缩前段而不是顺延",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.2:offset=6[v]\"",
    },
  },
  // 对开门换页（上游  → transitions）
  {
    id: "page-turn-transitions",
    category: "transitions",
    nameZh: "对开门换页",
    oneLineZh: "旧页从正中撕开成两半滑出、新页从底下带着曝光束迎上，章节级换页的翻篇仪式。",
    useWhenZh: "章节级换页：新旧交替的两个大段落之间的「翻篇」仪式，不是镜头级交棒。",
    seconds: [3.6, 6.4],
    energy: "medium",
    tags: ["transition","转场","page","turn","transitions","对开门换页"],
    intentZh: "把页面当实体：有厚度、有重量、会裂开；对开门是「旧的让位」，专管新旧取代关系。",
    motionZh: "旧页两个 960px overflow 容器对位拼合，同时向外 ease-in 加速滑出画外（按速度挂横向运动模糊）；裂缝里透出新页的光——门内缘 10px 切面被照亮、门面近缝处被光染暖，新页带一次过曝光束 scale 1.08→1 迎上。",
    params: [
      { name: "预告", typical: "裂前中缝一条发丝亮线（带泛光）自中点向上下描出（20–30f），30–40f 裂缝 ease-in 撑开 0→16px 成一道光缝", feelZh: "直接裂开观众没看到裂点在哪；硬开关闪线读作渲染故障；再往大或往小调都会改变手感" },
      { name: "滑出", typical: "各 translateX ∓1000px / 24f，bezier(0.42,0,0.8,0.25) 加速", feelZh: "ease-out 滑出是\"被推走\"，ease-in 才是\"让位\"；quart-in 太猛会读作\"停住→最后一帧消失\"" },
      { name: "新页迎上", typical: "scale 1.08→1（snappy 36f，晚门 2f 起跳），过曝光束随门远去 ~30f 衰减；新旧两页同版式同槽位", feelZh: "新旧页版式不同就读不出\"取代\"；再往大或往小调都会改变手感" },
      { name: "撕裂边", typical: "内边缘 10px 受光切面（亮→强调色→暗）+ 门面近缝 620px 光染（screen），门不向新页投影", feelZh: "无边线两半读作普通左右擦除；门往缝里投影会把光压灰；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "新页落定后跟随动作（数据滚动 / 清单打勾）+ hold ≥30f，hold 段相机极缓推近 1.5–2%", feelZh: "手感：新页落定后跟随动作（数据滚动 / 清单打勾）+ hold ≥30f，hold 段相机极缓推近 1.5–2% 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在为镜头手搓的页面上调校——参数是调校起点非实战定稿， 首次实战须以真实素材回验；一缝一式规矩同 shot-transitions；体块转场比镜头交棒更重， 全片 ≤2 次，连续两缝都用体块读作 PPT 翻页；两半必须对位拼合无缝（右半内层 translateX(−960px)）—— 静止时看出接缝就穿帮；真实截图注意奇数宽度取整；转场前后两页都要有 ≥30f 静止建立/收尾——两端都在动，体块感被 运动淹没",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.2:offset=5[v]\"",
    },
  },
  // 墨渗揭示（上游  → transitions）
  {
    id: "print-texture-transitions",
    category: "transitions",
    nameZh: "墨渗揭示",
    oneLineZh: "新画面透过须状渗边的有机圆形遮罩从落墨点洇开，快慢不匀地吃掉旧景。",
    useWhenZh: "换景接缝的纸墨审美款；与交棒式、穿越式并列的「介质显影」型转场。",
    seconds: [3.24, 5.76],
    energy: "medium",
    tags: ["transition","转场","print","texture","transitions","墨渗揭示"],
    intentZh: "新画面不是「到来」而是「印染」出来的：像一滴墨落在宣纸上洇开，有机、书写感。",
    motionZh: "新页透过须状渗边的有机圆形遮罩从落墨点洇开，洇开段 55–80f、快慢不匀地吃掉旧景；墨边有吸收与渗出的层次，收尾静止 ≥30f。",
    params: [
      { name: "渗边", typical: "SVG mask 白圆挂 feTurbulence(fractalNoise, baseFrequency 0.02, octaves 3, seed 固定) + feDisplacementMap scale 60→160 随帧涨", feelZh: "filter 只揉遮罩形状、内容始终清晰；seed 必须写死（确定性）；再往大或往小调都会改变手感" },
      { name: "洇开", typical: "半径 [20,98f]→[0,1450px] Easing.out(quad)，乘 1+0.08·sin(0.32f)·env 快慢不匀扰动（env 末 20f 衰减归零）", feelZh: "匀速圆扩张读作普通 iris——扰动即\"墨的脾气\"；再往大或往小调都会改变手感" },
      { name: "墨边", typical: "两层遮罩圆领先新景 20–42px：外沿 0.42 不透明 + 3.2px 羽化、内芯 0.86 + 1px 羽化，再外一圈 +110px 重羽化湿晕（0.12）；14–22f 先落一个小墨点", feelZh: "无墨边读作普通 iris 擦除；墨边太宽太实读作烧纸洞" },
      { name: "显影", typical: "新景在遮罩内 scale 1.035→1（20–100f ease-out），摘罩前精确回到 1", feelZh: "不收会在摘罩帧跳一下；再往大或往小调都会改变手感" },
      { name: "收尾摘罩", typical: "洇满后（帧 ~100）摘掉 SVG mask 直接铺新景", feelZh: "feTurbulence 有亚像素抖动，不摘则结尾永不真静止（本批实渲判例）；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "新景就位后真静止 ≥30f", feelZh: "手感：新景就位后真静止 ≥30f 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；一缝一式规矩同 shot-transitions：介质转场不与白闪/震屏叠加； 本式与 light-leak-burn 介质系同片合计 ≤2 次，多了片子读作印刷厂宣传；洇开中段旧景内容会透过噪声孔洞碎片式短暂露出——读作墨渍肌理 属可接受有机效果，但旧景若是人脸/logo 等高辨识元素会读作故障，避开；慢转场（55–80f 动作段），高节奏连打段落别用——那里去 shot-transitions B 式甩镜",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.2:offset=4.5[v]\"",
    },
  },
  // 镜头交棒三式（上游  → transitions）
  {
    id: "shot-transitions",
    category: "transitions",
    nameZh: "镜头交棒三式",
    oneLineZh: "推进流白、甩镜急刹、穿窗纵深三式，按能量落差与接缝语义选型。",
    useWhenZh: "任何两镜衔接处（技法卡：分镜排完镜头后逐个接缝选一式）。",
    seconds: [1, 4],
    energy: "medium",
    tags: ["transition","转场","shot","transitions","镜头交棒三式"],
    intentZh: "镜与镜怎么接一直没有词汇，接缝裸切会把逐镜攒出的电影感一次漏光；三式共同点是给接缝一个「障眼物」。",
    motionZh: "A 推进流白 flash-cut：前镜相机推进，切点跨骑一层白闪盖住换页（交互穿透、能量相近的页面→页面）；B 甩镜急刹款：机位一拍横甩、中段运动模糊糊到不可辨，落点前急刹长尾滑入；C 穿窗纵深款：页面内真实元素放大成全屏窗口，新场景从窗内长出接管（功能总览→该功能详情）。",
    params: [
      { name: "A flash-cut", typical: "assets/lib/FlashCut.tsx，from = 切点 − 5，两侧各 5f", feelZh: "用法详见 type-and-filter 卡；白闪只盖硬切，不当装饰光效（Q4）；再往大或往小调都会改变手感" },
      { name: "B 甩镜急刹款", typical: "起点 hold ≥20f → 前 70% 路程用 30% 时间（糊段，峰值 ~300px/f）→ 后 30% 路程 ease-out 长尾 ~48f 滑入落位；用一条连续速度曲线（3f 起步 + 指数衰减）积分出位移，别分段各套 ease-out（分段处速度会二次起跳）；按瞬时速度做方向性运动模糊（_fixtures/Polish 的 SpeedBlur，…", feelZh: "适合落点是\"要读内容\"的镜头——长尾给观众视线一个追上的坡；长尾 >60f 偷走后镜入场，宁短勿长；跨度按\"峰值速度 ≥300px/f\"配，不足则糊不透露出换景穿帮；两景同一水平线上拼接（页面空间同 y）；CameraMotionBlur 子帧叠加在 8bit 下会整片偏黄、拖影呈一格格回波，亮场 UI 甩镜别用" },
      { name: "C 穿窗纵深款 portal-wipe", typical: "目标卡先悬浮抬起作预备（−10px、1.03×，邻卡退暗）→ 窗放大 40f 用 bezier(0.7,0,0.3,1) 先慢后快，窗内新景从 ~0.42 缩放反向补偿长到 1（与窗几何同一个 t），卡面在前 ~28% 行程内渐隐（opacity 1−t·3.6，再慢会被拉成满屏巨字残影）；窗内只 2 层视差（远景面板系数 0.08 + 近景 2 卡 0.…", feelZh: "窗几何与窗内景必须同步驱动，异步读作穿帮；层数/散开是可读性命门——3 层+0.85 散开+blur 版被裁，收敛后过；穿完必须真停，视差飘着不停偷走后镜阅读；再往大或往小调都会改变手感" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。音效密度与画面节拍一致即可。",
    pitfallsZh: "分镜表阶段就逐接缝标注转场式（写进\"关键动效\"列），逐镜头阶段才补 等于全线挪帧——转场占用的帧从相邻镜头预算划走，规矩同 hold 预算（R3）；转场不叠加：一个接缝只用一式；甩镜糊段、穿窗途中再加 flash 白闪读作穿帮；B/C 式参数经占位素材调校+真实素材转正，非用户 实战判例——单例判例，与判例冲突时判例优先；C 式窗内新景语义应是被点开元素的\"详情世界\"（实战接真实详情页 截图）——窗里塞无关场景语义断裂，沦为花哨擦除；被放大元素用高清纹理（Q2，全程被特写）；C 纵深款参数系手搓占位 UI（video-shotcraft Workspace / 观看量预测世界）调校起点、未经真实截图验证； 参考实现 demos/transition/shot-transitions/PortalWipeV2.tsx",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=0.83:offset=2.5[v]\"",
    },
  },
  // 条带撕裂（上游  → transitions）
  {
    id: "tear-streak-transitions",
    category: "transitions",
    nameZh: "条带撕裂",
    oneLineZh: "16 条不等高水平条带错位抖动、叠双色剪影重影，在满幅抖动中硬切到下一页，再抖 6f 归位。",
    useWhenZh: "高能换页：数字故障或断裂语义；页面完整性不破、能量拉满的条带级撕裂。",
    seconds: [3.24, 5.76],
    energy: "high",
    tags: ["transition","转场","effects","tear","streak","transitions"],
    intentZh: "反复裁决的品味分界：碎块读作「页面被破坏」，条带读作「页面在高速运动」——完整性不破、能量拉满。",
    motionZh: "16 条不等高水平条带（外层裁剪 + 内层整页 translateY 对位），每条 translateX 由 h(i*31+f*7) 驱动 ±70px 抖动，叠双色剪影重影 + 扫描亮线；54f 满幅抖动中硬切 B 页，再抖 6f 至 60f 归位。",
    params: [
      { name: "抖幅", typical: "±70px，按条分能量（约两成不动 / 三成满幅 / 其余轻颤），位移过指数 0.6 推向两端；底层垫完整页防露底缝", feelZh: "峰值帧条带错位必须肉眼明显——±12px 级读不出撕裂；全员同幅乱抖像水波；再往大或往小调都会改变手感" },
      { name: "包络", typical: "44–47f out-cubic 冲起 → 平台 → 54–60f 线性消散", feelZh: "冲击判例：扩散 out-cubic、消散线性；再往大或往小调都会改变手感" },
      { name: "重影", typical: "±12px 双色剪影（页面内容的强调色单色副本，screen 叠加，随条一起错位，只给错位大的条）", feelZh: "无重影只是抖不是 glitch；剪影只画内容不画底，暗场上才不发灰" },
      { name: "切边 / 扫描线", typical: "错位 >25px 的条上沿 1.5px 亮线、下沿 3px 暗渐变；每帧 2 根随机高度全宽扫描亮线", feelZh: "每条都画亮边会读成横格纸——只给重撕条" },
      { name: "切点掩护", typical: "54f 曝光 1.28 / 55f 1.12 + 整屏 1.6% 冲击放大 6f 收回；30–31f 两条细条 ±12px 前兆", feelZh: "前兆是预备：观众先\"感到不对\"再撕" },
      { name: "摘罩", typical: "60f 起条带、重影、扫描线、filter 全部条件卸载直出裸 B", feelZh: "opacity 0 不算摘；滤镜残留毁真静止；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "75f（余波 40f：区域格青绿波、计数、指标升起 + hold 35f）", feelZh: "R1；余波只在页面内容层，不再有撕裂元素" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在程序绘制的暗场控制台页（midnight look）上调校——参数是调校起点非实战定稿， 首次实战须以真实素材回验；亮底页面上剪影重影改 multiply 才看得见；条带不碎块——后续同类手法一律做条带：横条各自完整， 绝不裂成方块/砖块/独立坠落物（三连否判例，见意图）；高能转场，与 whip-pan/crash 系同片注意能量预算—— 高能转场挤在一起互相稀释；硬切藏在满幅抖动中（54f 切、60f 归位）——切点暴露在静止帧上 就失去了 glitch 的掩护；条带页必须自带不透明底（渐变 + 点阵），暗角与颗粒只在最上层画一次—— 透明条带会和底层整页叠影，暗角跟着条带错位会露馅",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.2:offset=4.5[v]\"",
    },
  },
  // 藏切三式（上游  → transitions）
  {
    id: "transition-hidden-cut",
    category: "transitions",
    nameZh: "藏切三式",
    oneLineZh: "前景遮挡隐形切、对撞开屏、暖色漏光——把硬切藏进遮挡、撞击或光峰的 1–3 帧里，观众看不见剪刀。",
    useWhenZh: "两镜衔接处需要「无痕换景」或「仪式感开屏」时；与交棒三式同层选型。",
    seconds: [1, 4],
    energy: "medium",
    tags: ["transition","转场","hidden","cut","藏切三式"],
    intentZh: "魔术误导：观众眼睛被大动作或强光吸走的那 1–3 帧里完成硬切，回过神来景已经换了。",
    motionZh: "A 前景遮挡隐形切：一块贴着镜头掠过的失焦前景物（超画幅、软边 = 失焦+运动模糊）横扫，盖满全屏的遮挡帧内背景 A→B 硬切、前景扫出；B 对撞开屏：左右两半屏（两张对比海报）带斜切边从画外加速对冲撞合，撞击帧白闪 + 震屏 + VS 盖章，切点就是撞击本身；C 暖色漏光：三段色温的暖色漏光沿对角线斜扫，光峰帧吞掉旧画面七成以上时硬切，光退散时新画面已就位。",
    params: [
      { name: "A 遮挡物", typical: "纯渐变绘制的深棕失焦前景：实心核 2600px + 两侧 340px 软边（总宽 3280），前缘一道赤陶轮廓光；右→左 14f（32–46f），bezier(0.3,0,0.7,1)；切点 = 实心核盖满 0..1920 的那一帧（demo 里 f39，前后各一帧由软边盖住）", feelZh: "软边渐变本身就是失焦+运动模糊，不必 CameraMotionBlur（12 倍采样太贵）；遮挡物上的明暗叠层要用 mask 限在实心区，否则在透明软边上画出硬边" },
      { name: "A 近物遮光", typical: "遮挡物前方 640px 软投影（0→0.38→0.5）随之扫过页面", feelZh: "卖\"贴着镜头掠过\"的距离感；再往大或往小调都会改变手感" },
      { name: "A 一条 take", typical: "全程内容慢横移 +40→−40px（smooth）贯穿切点；切前 A 被拖左 28px（ease-in），切后 B 从右 28px 14f 回稳（ease-out）；B 页排版整体右移 40px 抵消横移终点", feelZh: "卖\"同一镜被风带了一下\"的错觉，是无痕感的一半功劳；横移会吃安全边，终点要预留；再往大或往小调都会改变手感" },
      { name: "A 因果", typical: "24f 按下 Render（0.96 缩放 + 压暗 + Rendering… 转圈）→ 扫过 → B「That's a wrap.」渲染完成票根 + 印章弹簧落座、对勾描画", feelZh: "遮挡前给一个动作，切后给结果，观众读成\"一晃就办好了\"；再往大或往小调都会改变手感" },
      { name: "B 斜缝几何", typical: "clip-path polygon 斜边约 78°（缝顶 x=1075→缝底 x=845）；两半屏从 ±1240px 以 ease-in(cubic) 10f 对冲到位（18–28f），按速度横向运动模糊（封顶 36px）", feelZh: "ease-in 加速才有\"砸\"感；垂直缝读作 PPT 分屏" },
      { name: "B 撞击三件套", typical: "撞击帧（28f）同发：纸白闪 0.85→0 共 3f + 整机 shake 16px·e^(−t/1.7) 约 5f 收干 + VS 圆章弹簧压出（damping 12 / stiffness 260，scale 1.9→1，一次可见过冲）；另加冲击环 16f + 12 根放射速度线 7f", feelZh: "三件必须同帧起跑，错开一帧就散；震屏幅度须过肉眼阈值（可感性判例）；再往大或往小调都会改变手感" },
      { name: "B 版式", typical: "两方做成色块海报：墨黑「The old way」vs 朱红「With video-shotcraft」，各一个 340px 大数字（14 days / 1 prompt）+ 44px 说明 + 32px 清单；撞后数字 1.05→1 回弹（晚 2f），说明左先右后错峰；54f 起底部结论条（镜刻标志 + 品牌口号）压在斜缝上", feelZh: "数字本身就是对比结论；建立段放一句设问，墨线预示斜缝（字带处留空不划字）；再往大或往小调都会改变手感" },
      { name: "C 光层", typical: "3 团沿对角线拉长（1.35:1、转 −34°）的径向渐变椭圆（#c2311a / #ff5a1f / #ffb347，长径 3000/2300/1700px，screen，不用 blur 滤镜）+ 右上缘片门溢光线性光带，沿右上→左下扫 71f", feelZh: "光团偏移沿扫掠方向拖尾排布，避免完美同心的\"手电筒感\"；渐变本身就软，省掉 90px 大模糊" },
      { name: "C 光强包络", typical: "ease-in（t²）爬升 28f（24–52，蓄力）→ 峰值帧藏切 → ease-out 收敛 43f（余温）；峰值叠 40% 全屏暖罩 + 近白热核（opacity=intensity³）+ 切点 2f 轻抬", feelZh: "爬升慢收敛快会读作故障闪光；热核只在临近峰值烧起来" },
      { name: "C 冲淡", typical: "峰值时页面 filter：brightness 抬 85%、contrast 降 50%、saturate 降 25%；旧画面标题随光强淡到 ~25%", feelZh: "这是\"烧穿\"感的来源——光只叠不冲淡，读作贴了张贴纸；标题不跟着烧淡，切点会看到字突然换掉；再往大或往小调都会改变手感" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在程序绘制的画面上调校（A 暖沙 video-shotcraft 渲染页 / B 纸面对比海报 / C 暗场 video-shotcraft 取景器夜→黄昏， 品牌短句「Frame motion. / Craft the shot.」被光峰切成两半）—— 参数是调校起点非实战定稿，首次实战须以真实素材回验；C 式是 Q4 光效判例解封后首个入库光效手法——严守 Q4 三约束： 单点使用（一支片一处，不群发）、正常速度回放自检好看才算过、 光效服务切点而非装饰；与 flash-cut 同片混用算两次光效藏切；A 式遮挡物必须真的全遮：demo 里实心核 2600px 才留出约 1 帧的全遮窗口 （中段速度 ~530px/帧）——改扫掠时长或宽度后先逐帧算/看切点帧有没有露出背景边缘， 露一条缝整个魔术就穿帮；B 式 VS 字块语义仅适配\"对比/对阵\"内容——没有两方对峙关系时 别当通用转场用；去掉 VS 只留对撞则退化为一款斜缝 wipe，语义要求同降；转场不叠加（规矩同 shot-transitions）：一个接缝只用一式； 这三式与 shot-transitions 三式同层选型，同片同类接缝别既用 flash-cut 又用 C 式",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=0.83:offset=2.5[v]\"",
    },
  },
  // 字腔穿越（上游  → transitions）
  {
    id: "transition-travel",
    category: "transitions",
    nameZh: "字腔穿越",
    oneLineZh: "巨型章节标题的字形就是一扇窗，镜头做一条连续空间运动钻进笔画完成换景。",
    useWhenZh: "前后两镜存在「元素或容器」级空间关系的接缝；章节标题→正文的高能量款。",
    seconds: [1.73, 5],
    energy: "medium",
    tags: ["transition","转场","camera","travel","字腔穿越"],
    intentZh: "后景在前景画面里以真实元素存在（字形洞），观众从头到尾跟着同一个物体，没有交棒瞬间——标题即是门。",
    motionZh: "巨型标题字形用 SVG mask 挖洞透出新页，镜头指数推进穿洞；洞撑满瞬间新页接管、残余笔画甩出画外；洞内只给光不给字，后景做视差。",
    params: [
      { name: "A 穿腔主推", typical: "盖板 SVG mask（白底+黑字 900 字重）挖洞，transform-origin 对准字形笔画（洞）中心——锚在字腔里推到底撑满的是盖板不是洞（demo：「EDITS」560px 的 I 竖笔中心 973,515，竖笔 107px×30 > 画宽；选词时让 I 竖笔落在画面中线附近，洞才从正中撑开）；scale=30^u，u 52f bezier(…", feelZh: "ZOOM_MAX 按\"洞撑满画面\"配，笔画越细倍数越大；慢起段留给观众看清\"洞里有东西\"" },
      { name: "A 洞里有东西", typical: "盖板暗、洞里亮：暖黑盖板 vs 熔金渐变 video-shotcraft 发布页，洞里的卡片也做成亮面（奶白磨砂）；字缘一圈模糊橙色描边只画在盖板区域（光从洞里漏出来）+ 1.5px 暖白切口边", feelZh: "洞里有深色块时那几个字母读作\"实心字\"，穿洞的悬念就没了" },
      { name: "A 洞里只给光不给字", typical: "字卡 hold 期页面的文字/卡片层完全隐去，洞里只透出暖色渐变 + 柔光形（卡片位一团奶白光、标题位一抹暗赤）；主推中段 64–90f 内容层由 18px 失焦淡入合焦（EASE.out），接管时已清晰", feelZh: "洞里能读到页面标题时，两层可读文字互相抢，标题字读作\"杂乱\"而不是一个干净的镂空；再往大或往小调都会改变手感" },
      { name: "A 撤场与拖影", typical: "scale∈[14,26] 盖板 opacity 1→0；u>0.35 起期望模糊 0→20px（除以 scale 写进 blur）+ 四层更早 0.8–3.2 帧的半透明盖板残影叠成径向变焦拖尾；接管瞬间页面 brightness +12% 一闪回落", feelZh: "blur 不除 scale 会被放大成糊墙；只用两层残影会读成硬边半透明色块，四层才连成拖尾" },
      { name: "A 后景视差", typical: "页面只推 1→1.08（主推期 0.7·u，接管后 quint-out 补完，交接处速度连续）+ 0–100f 向左漂 28px；接管后渲染卡上的镜头计数 0→12、时长条错峰填满、DONE 标签弹出", feelZh: "后景不动则洞里是张死图；后景推太多会和盖板同速，纵深消失" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。音效密度与画面节拍一致即可。",
    pitfallsZh: "推进锚点要按渲染帧实测（demo 的竖笔坐标是从静帧量出来的），换字体/换词/渲染器字距 不同都会漂——渲后看推进方向，洞不居中就微调 origin，别信字宽 em 值手推的数； 锚点笔画离画面中线太远（如「FILM」的 I 在 x≈726）时，洞偏在一侧撑开、另一侧盖板久久不退，换词让竖笔居中；后景页面推到 1.08 时四周会被裁掉 4%：版面安全边距要按\"推完后\"留（demo 左右 200/230、顶 122）；字腔穿越与交棒三式同一接缝不叠加，一缝一式；穿越式已自带高能量， 再包白闪/震屏读作穿帮（规矩同 shot-transitions）",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.12:offset=3.37[v]\"",
    },
  },
  // 白闪降维定妆（上游  → transitions）
  {
    id: "white-flash-logo-simplify-cut",
    category: "transitions",
    nameZh: "白闪降维定妆",
    oneLineZh: "彩色液态金属词标静置流光，蓄力后从字心炸出一记白闪过曝，曝光回落时同一位置已是扁平版字标。",
    useWhenZh: "品牌段落收束（华丽演绎→干净定妆）；情绪从炫技切换到正式宣告的转场拍。",
    seconds: [2.88, 5.12],
    energy: "high",
    tags: ["transition","转场","white","flash","logo","simplify"],
    intentZh: "降维是修辞：从感性质感切到理性识别；两版同字号同位置，读作「同一个字标被净化」而不是换了张图。",
    motionZh: "蓄力 34–46f 用 EASE.exit 越来越快（brightness 1→1.7、bloom 加强），一条横向变形眩光从字心拉开；冲白 44–50f 径向白团半径 80→1580px 二次 ease-in，50–54f 纯白 hold 并在全白时换场；曝光回落 54–76f 用 quint-out 把白层 1→0，底下扁平字标只做 1.03→1 对焦收束。",
    params: [
      { name: "冲白窗口", typical: "44–50f 径向撑满（t² ease-in）+ 50–54f 纯白", feelZh: "冲白必须\"快进\"；整屏均匀淡入读作剪辑软切，从字心炸出才读作\"字在发光过曝\"" },
      { name: "蓄力", typical: "34–46f，brightness ×1.7 + 横向眩光", feelZh: "砍掉蓄力则白闪没有预兆、像丢帧；眩光核加 box-shadow 会带一圈暗边（实测）" },
      { name: "曝光回落", typical: "54–76f，白层 quint-out 退去", feelZh: "用扁平字标淡入代替回落，会出现\"白底上浮出一个字\"的二次动作；回落让字标\"一直在那儿\"；再往大或往小调都会改变手感" },
      { name: "扁平入场", typical: "1.03→1（snappy，52–78f）", feelZh: ">1.06 读作字标弹出；同时做淡入就和回落叠成两次揭示；再往大或往小调都会改变手感" },
      { name: "字标尺寸", typical: "液态 / 扁平同为 190px、同中心（15 字符字标按画宽压的字号；4 字母短词可放到 300px）", feelZh: "两版位置或字号不同，读作换皮不换人；再往大或往小调都会改变手感" },
      { name: "品牌常量", typical: "PAPER / FLAT_INK / FLAT_ACCENT（块顶定义；demo 已收编为 video-shotcraft 的剪辑纸 / 片场墨 / 镜琥珀）", feelZh: "换成项目品牌色即完成收编；液态层虹彩一般保留（它是\"演出\"不是品牌）；标志只在扁平段出现、不上液态质感（品牌规范禁渐变/发光）；再往大或往小调都会改变手感" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "换场发生在 50f 全白帧（暗场与纸面二选一渲染），白层不能在 50f 前退——否则两场同时可见；WORD = BRAND.name（15 字符），换词需同步调字号 FS；液态层 / bloom / 倒影 / 扁平层四处共用 wordStyle 与 wordText；字标带 +0.03em 字距时「ft」两道横笔恰好相接，大字号下接缝露出一条抗锯齿亮线——demo 让 f 后字距归零、两笔重叠；冲白配 SFX 是必选项（impact/whoosh-bright 类），无声的白闪读作素材丢帧；高光必须裁进字形（background-clip:text）——做成盖在字上的径向光斑会溢出字形、在黑底上糊成白雾（Q4 光溢出）",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.2:offset=4[v]\"",
    },
  },
  // 百叶窗几何擦除（上游  → transitions）
  {
    id: "wipe-transitions",
    category: "transitions",
    nameZh: "百叶窗几何擦除",
    oneLineZh: "12 根 3D 叶片错峰翻面成波，波扫过后整页由 A 换成 B——不依赖构图元素的通用几何擦除。",
    useWhenZh: "新旧页都不动、一条几何边界扫过完成交接的通用转场；不依赖构图里有合适元素，哪儿都能用。",
    seconds: [3.17, 5.63],
    energy: "medium",
    tags: ["transition","转场","wipe","transitions","百叶窗几何擦除"],
    intentZh: "第四族几何擦除：新旧页都不动、一条几何边界扫过完成交接，擦除的形状即语义；通用性即定位。",
    motionZh: "12 根 160px 真 3D 叶片（preserve-3d 双面板：正面 A 切片、背面预转 180° 的 B 切片、backface hidden）共享 1900px 透视绕自身竖轴 rotateY 0→180°，错峰成波；侧立时露出叶后暗槽，叶面受光随角度变化。",
    params: [
      { name: "波", typical: "24f 起，叶 i 起跳 = 24 + 28·(i/11)^0.78（间隔 3.4f→2.1f，越翻越快）；每叶物理弹簧 damping 13 / stiffness 75（~13f 到 180°、≈5° 过冲回落）", feelZh: "同时 4–5 叶在转才读作\"波\"；EASE.out 错峰首间隔 9f，第一叶之后空等，波显得拖；再往大或往小调都会改变手感" },
      { name: "叶面受光", typical: "转离主光的面按 0.5·sin θ 变暗（沿叶宽渐变），转向主光的面 ~35° 掠过一道 screen 高光，叶缘 2px 受光细线 ∝ sin θ；侧立时露出的暗槽 #1d1712→#120d0a 就是边界线", feelZh: "真 3D 的暗槽 + 受光本身就是擦除边界的\"亮线\"，不必再叠 SVG 缝线" },
      { name: "摘罩", typical: "最后一叶弹簧收敛（", feelZh: "手感：最后一叶弹簧收敛（ 只是起点，再往大或往小调都会改变节奏与力度" },
      { name: "收尾", typical: "摘罩后 ≈50f 落定（≥40f；刊头细线重画一遍、相机 1.02 落回 1）", feelZh: "手感：摘罩后 ≈50f 落定（≥40f；刊头细线重画一遍、相机 1.02 落回 1） 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "接缝处用 whoosh 或短促 impact 盖住切点，能量越高音量越靠前；不要叠加两种转场音。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；擦除边界必须带亮线/高光——无亮线的 wipe 读作 PPT 转场，命门； 本式靠叶片侧立露出的暗槽 + 叶缘受光细线当边界；几何擦除全片 ≤2 次，别同片连用（两次\"边界扫过\"读作模板感）；摘罩必须等最后一叶弹簧收敛（≈80f）再做，早一帧卸载就是叶片跳位穿帮；两页反差要大（demo：暖白纸 vs 整版朱红；两页是 video-shotcraft 刊物的连续两页，刊头为 video-shotcraft 字标， 巨字「Frame.」→「Craft.」），且版面网格最好与叶宽同构（12 栏 × 160px）——同色系两页翻起来只看得到暗槽",
    recipe: {
      ffmpeg: "-filter_complex \"[0:v][1:v]xfade=transition=dissolve:duration=1.2:offset=4.4[v]\"",
    },
  },
  // 词从虚焦浮出（上游  → typography）
  {
    id: "blur-slide",
    category: "typography",
    nameZh: "词从虚焦浮出",
    oneLineZh: "标题逐词入场，y 位移、blur、opacity 三个通道共用同一条 ease-out 同步收敛，词间隔约 4f。",
    useWhenZh: "几乎所有标题与副标题成对出现的场合；产品页首屏文案、章节小标题；需要「专业但不抢戏」的默认文字 reveal。",
    seconds: [2.88, 5.12],
    energy: "low",
    tags: ["typography","字体动态","blur","slide","词从虚焦浮出"],
    intentZh: "专业感全来自一件事：三个通道共用同一个进度、同一条缓动，词是「从虚焦里浮出来」而不是「滑进来顺便淡一下」。",
    motionZh: "每词进度 p=ramp(frame,start,dur,EASE.out)（quint-out 级），opacity=p、translateY=(1-p)·dy、blur=(1-p)·Bpx 全绑同一个 p；主标题每词 22f、词间 4f、dy=64px、B=18px；副标题 34f 起手、词间 2.4f、每词 20f、dy=26px、B=9px；两段有 26f 重叠——错峰而非排队。",
    params: [
      { name: "词间 stagger", typical: "主 4f / 副 2.4f", feelZh: "调大或调小：3–4f 是\"逐词\"的甜点；<2f 整行齐入没有 stagger，>8f 观众开始一个个数词；再往大或往小调都会改变手感" },
      { name: "单词入场窗", typical: "主 22f（主角词 30f）/ 副 20f，EASE.out", feelZh: "<10f 读作硬弹；>30f 每个词都在慢慢浮，整句拖沓" },
      { name: "y 位移", typical: "主 64px（≈0.38em）/ 副 26px", feelZh: "主副不等幅是层级来源；<0.15em 位移无感，>0.6em 词从画外飞进来变成滑入；再往大或往小调都会改变手感" },
      { name: "blur 通道", typical: "主 (1-p)·18px / 副 (1-p)·9px", feelZh: "这一通道就是\"专业感\"，删了退化成普通淡入上移；超过字号的 ~12% 中间帧糊成色块；再往大或往小调都会改变手感" },
      { name: "主副错峰", typical: "主 10f–60f / 副 34f–80f", feelZh: "重叠 ~26f 是\"一句话\"；副标题起点推到主标题收完之后就读成两拍" },
      { name: "字号字重", typical: "170px 衬线 400 对 46px 无衬线 400", feelZh: "差 2 倍以上才有主副关系；字重相同时靠字体家族区分，副标题上 600+ 字重会和主标打架" },
      { name: "收尾 hold", typical: "副标题 80f 收完，尾部约 40f（只剩极缓推近与刊脚收尾）", feelZh: "静置 <8f 观众还没读完就切了；再往大或往小调都会改变手感" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 在占位文案上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；占位文案是主 5 词（两行）/ 副 9 词，换项目文案时词数要贴近：stagger 总长 = gap × 词数，词数翻倍末词起点就往后挪一倍，末词的入场会被挤到收尾 hold ——超过 8 词就该同步把 gap 压到 2–2.5f；三通道必须共用同一个 p：分开写三条缓动（哪怕曲线相同）就会出现 \"位移到了但还糊着\"的错位，柔和感立刻散掉；词级拆分对中文文案要手动切：split(' ') 在中文上得到一整块， 须自己按语义分段成 3–5 个 span，别退化成逐字；每行是绝对定位的 flex 行（左对齐 168px 网格），词距靠 gap 而非空格； 换文案时注意第一行不要超过 ~1450px 宽（170px 衬线约 17 个字符），否则撞右侧刊号后景",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 4s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(4px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 花括号开幕（上游  → typography）
  {
    id: "brace-expand",
    category: "typography",
    nameZh: "花括号开幕",
    oneLineZh: "一对紧贴的小花括号先在正中出现，随即带一次过冲向左右弹开并放大到标题级，文字宽度严格绑括号内缘像拉开幕布。",
    useWhenZh: "开发者或技术产品的标题字卡；章节开场；需要「一个符号完成揭示」的极简一拍。",
    seconds: [2.88, 5.12],
    energy: "high",
    tags: ["typography","字体动态","brace","expand","花括号开幕"],
    intentZh: "标题揭示里最省的一招：不做遮罩条、不做逐字，只让一对括号往两边走，文字被「括出来」；命门是 clip 宽度必须严格绑括号位置。",
    motionZh: "第 0 帧是闪烁的输入光标，6f 被一对 0.4 倍、内缘相贴的「{}」硬切替换（不淡入）并静置 8f；弹开用 springAt(damping 14、stiffness 130)，约 8f 到位、11f 过冲峰约 9%、24f 收敛；位移与缩放相乘（HALF=676、INNER=64），文字 clip.width=2x 并带 14px 羽化，羽化随 clip 变窄而收。",
    params: [
      { name: "括号出现", typical: "6f 硬切替换光标", feelZh: "硬切是对的（符号\"啪\"地在那儿）；改淡入就少了\"先看清括号\"的那几帧，弹开显得突然" },
      { name: "弹开", typical: "14f 起弹簧 damping 14 / stiffness 130（≈9% 过冲）", feelZh: "过冲是全片唯一峰值；damping ≥18 读作滑开，没有\"撑\"的力道；<12 回弹两次读作果冻；再往大或往小调都会改变手感" },
      { name: "半距", typical: "HALF = 676px（括号中心）、INNER = 64px（括号中心到内缘）", feelZh: "决定标题可容纳的宽度：内腔 = 2·(HALF−INNER) = 1224px；再往大或往小调都会改变手感" },
      { name: "缩放", typical: "mix(0.4, 1, ex)，括号 300px / 字 164px", feelZh: "调大或调小：0.4 起点是\"小字号\"的量；起点 >0.8 看不出放大，<0.3 括号一开始小得像标点" },
      { name: "文案宽度", typical: "「video-shotcraft」164px 落定实测 ≈1130px（内腔 1224px 减两侧羽化）", feelZh: "字比内腔窄太多，括号还没到位字就露全了，幕布感变弱；比内腔宽则两头被裁" },
      { name: "字距松弛", typical: "−0.05 → −0.03em，40–64f smooth", feelZh: "这一下是\"落定后的呼吸\"；松弛后字会变宽，要留在内腔内；再往大或往小调都会改变手感" },
      { name: "运动模糊", typical: "SpeedBlur amount 0.22 / max 16", feelZh: "amount 0.35 时峰值帧括号糊成三道横线，认不出是括号；再往大或往小调都会改变手感" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "文案长度必须与 HALF 匹配：clip 只做裁切不做缩放——换成长标题时字会被括号裁掉两头， 必须同步加大 HALF（或减小字号）；中文标题字宽约为英文两倍，6 个汉字就接近上限；clip 宽度是从 0 长起来的，所以文字总是从中间往两边露：文案的 视觉重心要在中央（居中单行短句最佳），左右不对称的长短句会露得别扭；括号与文字必须共用同一个 sc：分别写两条缩放曲线（哪怕数值相同） 会在过冲那几帧出现括号已经到位、字还在长的错位；过冲只此一次：全片其他运动都无过冲，这是把注意力压在\"撑开\"这一 动作上；再叠别的 back / 弹簧过冲就贬值了；clip 框高度写死 220px（标题 164px 留上下余量），字号大改时要同步——不然上下被切",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 4s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(6px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 倒计时弧盘（上游  → typography）
  {
    id: "countdown-arc-scatter",
    category: "typography",
    nameZh: "倒计时弧盘",
    oneLineZh: "纸面表盘 9 个数字沿大弧切向排布，整盘扫过 96° 后减速急停，「5」停在弧顶随即平移落位成标题首字符。",
    useWhenZh: "倒计时或时长承诺类文案；数据揭晓的一拍；需要仪表盘语汇的浅底短镜。",
    seconds: [2.38, 4.22],
    energy: "high",
    tags: ["typography","字体动态","countdown","arc","scatter","倒计时弧盘"],
    intentZh: "把「5 分钟装完」放进一个量程里：45/35/28/22/17/10 一路扫过去停在 5，观众看到的是从很多降到很少；停下后「5」平移变成标题首字符，一个元素完成从仪表到文案的身份切换。",
    motionZh: "9 个数字挂同一圆心（圆心 (960,1150)、R=700、弧顶 y=450），ang=(i-6)·24° 切向排布、自身再 rotate(位置角)；先 5f 反向蓄力 +3°，再物理弹簧 99°→0°（damping 12、stiffness 60，约 24f 冲过 0° 约 2°、34f 落定）；i=6 的「5」在落定前 2f 起飞，20f 不对称 in-out 平移到标题首槽，同曲线做 112→150px 放大与自转回正；可见性用角度算 op=clamp((70-|pa|)/22)，不用遮罩。",
    params: [
      { name: "数列", typical: "[45,35,28,22,17,10,5,4,3]，间距 24°", feelZh: "递减不等距（45→35→28…）才像真量程，等差数列读作刻度尺；\"5\" 必须在 i=6 位（前 6 个扫过、后 2 个预留）" },
      { name: "弧半径", typical: "R=700px，圆心在画面下方（弧顶 y≈450）", feelZh: "半径决定弧的曲度：<R/3 帧宽数字挤成小圈，弧近乎直线时表盘感消失；整条可视弧应横跨画面 60–70%" },
      { name: "扫动", typical: "蓄力 +3° 5f → 弹簧 99°→0°（damping 12 / stiffness 60，~2° 过冲）", feelZh: "过冲 >4° 读作弹簧玩具；无过冲的 inOut 缓停没有仪表的干脆" },
      { name: "可视角窗", typical: "(70-", feelZh: "手感：(70- 只是起点，再往大或往小调都会改变节奏与力度" },
      { name: "\"5\" 落位", typical: "32→52f（20f，EASE.swift），112→150px，同步回正", feelZh: "落位紧接扫停，中间不留静置——留了就断成两个动作；落点必须是标题首字符槽（固定槽宽保证对齐）；再往大或往小调都会改变手感" },
      { name: "其余淡出", typical: "28→44f + blur(out·6)", feelZh: "淡出早于 \"5\" 起飞起手，先让路；blur 让散去像失焦而非消失；再往大或往小调都会改变手感" },
      { name: "刻度差速", typical: "指针 rot·0.35；标题逐词窗重叠约 10f、blur (1-p)·10px", feelZh: "差速是\"盘 vs 指针\"的层次来源，1.0（同速）读作一整块贴图在转；逐词窗重叠才是\"一句话\"，排队读作三个词各自出场" },
      { name: "末词染色", typical: "64→76f → 强调色", feelZh: "全片唯一的颜色事件，落在最后一个词上就是句子的落点；再往大或往小调都会改变手感" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；33f 是极限压缩（motion-lab 原稿：扫动 17f、\"5\" 落位 6f、三词淡入各约 5f），信息密度远高于可读上限； demo 已拉到 100f。再改时长时把各时间窗按同一比例缩放（比例关系是调校过的），别只拉扫动段；换文案时要重估标题宽度：demo 用 TITLE_EM（按字宽估算的整行 em 宽）把标题居中，\"5\" 的落点 由固定 0.6em 首槽推出——文案变了只改 WORDS 与 TITLE_EM，落点自动对齐，但整行居中要重估；盘面数字必须等大同字重（demo 112px/700）：大小不一读作数据可视化， 不是仪表盘扫过；\"5\" 的角度设计（i=6 → ang=0）是本卡的地基：改数列长度或改哪个数字 是主角，都必须让主角的 ang 算出来正好是 0，否则扫停时它不在弧顶",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 3.3s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(45px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 文档自写（上游  → typography）
  {
    id: "document-typewriter-reveal",
    category: "typography",
    nameZh: "文档自写",
    oneLineZh: "悬浮在暗场的整页真排版文档在光标后自己「写」出来、侧栏跟进、历史条目逐个落入轨道，相机从标题特写后撤到全窗。",
    useWhenZh: "文档、报告、笔记类功能镜头；信息密度最高的一拍。",
    seconds: [3.6, 6.4],
    energy: "low",
    tags: ["typography","字体动态","ui-entrance","document","typewriter","reveal"],
    intentZh: "观众会读清屏幕上每个字，说服力全在「文档是真的」：打字机式写入把静态页面变成正在被写出来的文档，历史条目补上持续产出的时间纵深。",
    motionZh: "内容块两两一对按节拍写入：页面底色遮罩右锚左→右收窄，强调色 caret 骑在揭示前沿；人名 @-mention 在 wipe 完成后长出强调色底色；左右双栏靠底色补丁自上而下收走入场，内缘细线随揭示生长后淡去；尾段 6 条历史条目从上方逐个落入侧栏轨道，每落一条配一声 pop。",
    params: [
      { name: "写入节拍", typical: "20 块两两一对，第 g 对 cue = 8 + g·4.4，每块 wipe 9f，最后一对 ~57f 完成（赶在 64f 全窗 settle 前）", feelZh: "逐块写会超预算——\"块数×节拍要先对预算\"是这卡的核心算术，先算再写" },
      { name: "写入手法", typical: "底色遮罩 width 100%→0，bezier(0.4,0,0.6,1)，遮罩色取纹理纸面实测色、右侧多盖（标题 120px——块测量宽度短于粗体实际字宽，否则尾词漏出）；强调色 caret 3px（深一档的极光紫 + 同色柔光）只跟最新块、只骑在实际文字宽度内，写完 2f 淡出；首块开写前 8f 笔尖在标题起点闪烁待命", feelZh: "caret 同时出现多个立刻穿帮；永远只有一个\"笔尖\"" },
      { name: "li 圆点", typical: "遮罩向左多盖 28px（::marker 在文本左 ~22px）", feelZh: "不多盖圆点会提前穿帮——截图纹理里烤入的排版细节都要这样排查" },
      { name: "@-mention", typical: "wipe 完成后 4f 起、8f 长出强调色底（极光紫 0.4）、mix-blend-mode: multiply（底色盖在纹理字上方，normal 混合会把人名洗浅）；跳过非人名标题", feelZh: "高亮晚于写入才读作\"重点被标出\"；同帧出现读作贴图" },
      { name: "双栏入场", typical: "左栏 cue 54 / 右栏 cue 62，底色补丁上→下 10f 收走 + 内缘 2px 强调色线随揭示生长、24f 淡去", feelZh: "双栏与正文错开节拍，同时入场会互相抢视线；再往大或往小调都会改变手感" },
      { name: "历史条目落入", typical: "6 条，cue = 66 + i·5（排在侧栏 wipe 完成 64f 后），每条 9f 落下；起点 −48px，bezier(0.2,1.15,0.3,1) 轻弹跳，空中影 0 12·air px 24·air px", feelZh: "条目几何紧贴烤入纹理已有条目的下方、行高对齐——DOM 重绘条目必须和纹理里的活条目严格对齐" },
      { name: "舞台", typical: "aurora 暗场：窗口背后一圈强调色背光（页面空间 translateZ −40，随窗口透视）、四周 0 0 0 1.5px 亮边 + 70px 长投影、顶沿一道高光；收尾标语 84px 两段（第二段强调色）左对齐窗口左缘", feelZh: "暖白纸面放进冷暗场里像一盏灯——舞台和窗口要同一套光向，背光别盖过纸面" },
      { name: "相机", typical: "自写 3D 窗口相机（布局级 CSS zoom，Q2），单调三次 Hermite 样条逐帧展开：f0 zoom 1.42 / rotY −18° / rotX 8°（窗口左上角与舞台光同时入画）→ f26 1.24 → f64 全窗 0.86 → f104 0.74 + rotX 9° + 上移 78px（底部让给标语）→ f150 0.746", feelZh: "开场太近（>1.6x）整屏只剩纸面，暗场与窗口边都看不见，读作原版平铺页面；全窗时双栏必须都入画（Q10）" },
    ],
    soundZh: "写入段钉 keyboard.mp3 修剪到 ~50f（8→57f）盖住书写段（拟音与动作严格等长，S4）；历史条目 6 连 pop 每 5f 一发、音量 0.40→0.25 阶梯递减做距离衰减（S2）。",
    pitfallsZh: "mock 内容必须出版级：产品原生排版、文字铺满、侧栏完整入镜（Q10）——\"贴图+标语\"级的敷衍文档会导致整镜头重做；数据合规：mock 内容里绝不出现客户/成员真名（Q1）；素材页面是活数据源（协作文档类）时，全量重采会刷掉已定稿纹理——用增量脚本只刷单页单键；强调色示例（caret/@-mention/内缘线）在模板片中为琥珀色，适配新品牌时统一换成目标品牌强调色",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 5s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(20px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 词语隧道（上游  → typography）
  {
    id: "flying-words",
    category: "typography",
    nameZh: "词语隧道",
    oneLineZh: "22 个关键词按黄金角铺在扁椭圆截面上，沿 z 轴从远处飞到相机前擦身而过，跑满两整圈首尾无缝。",
    useWhenZh: "关键词云或能力清单的动态背景；片头片尾的「信息量」垫底层；需要纵深穿越感的转场。",
    seconds: [4.32, 7.68],
    energy: "high",
    tags: ["typography","字体动态","flying","words","词语隧道"],
    intentZh: "把同一批词摊到时间轴上：远处生成、由小变大、擦过镜头消失，观众永远只在读三五个词，主观感受却是「词很多」。",
    motionZh: "perspective 1100px，词沿 z 从 −1750→800px 线性推进（正值即穿过相机平面），投影手算 s=P/(P−z)；铺位用黄金角 a=i·2.39996+rand(i·7+1)·0.8、半径 r=82+rand·165、y 半径再 ×0.6 压成扁椭圆，避开正中；生命曲线 OP=[0,1,0.5,0.2,0] @ OT=[0,0.25,0.6,0.85,1]；向外散开 drift=0.5+u·1.35，越近越往画外甩。",
    params: [
      { name: "词表", typical: "22 词，字号 20 + rand·16px（20–36；原生 64–120），700 字重 + 6 个衬线斜体词", feelZh: "词数与相位 i/N 绑定：<12 词画面稀，>30 词近处糊成一片；字号随机是层次感来源，全同号读作贴图；再往大或往小调都会改变手感" },
      { name: "纵深行程", typical: "z −1750 → +800px，perspective 1100（原生 ×4）", feelZh: "起点更远（−2500+）词太小认不出；终点不过 0 就没有\"穿过去\"只有\"飞到脸前停住\"" },
      { name: "散开系数", typical: "drift = 0.5 + u·1.35", feelZh: "系数 <1 词全从正中喷出像爆炸；>2 早早飞出画外，隧道变喷泉；再往大或往小调都会改变手感" },
      { name: "生命曲线", typical: "[0,1,0.5,0.2,0] @ [0,0.25,0.6,0.85,1]", feelZh: "中段那个 0.5 是给前景让位的；改成一路满亮就抢主角，改成早早归零隧道变空" },
      { name: "循环圈数", typical: "CYCLES = 2（必须整数）", feelZh: "非整数 → t=1 与 t=0 不接，loop 处一跳；圈数越多单词过镜越快" },
      { name: "近端模糊", typical: "u>0.86 起线性失焦 + 速度向方向拖尾", feelZh: "阈值提到 0.95 巨大词硬边扎眼；系数 >40 末段成色斑" },
      { name: "配色", typical: "demo（midnight）：冷白三阶 #f2f5ff/#c3cbe2/#8a95b5 + 4 个电光蓝强调词 #86a8ff（只有强调词带泛光），中心光晕电光蓝", feelZh: "深底浅字发光是身份证，白底套本卡直接失效——要浅底得整套重配" },
      { name: "中心光晕", typical: "~1040×720 径向渐变、呼吸 2 次/片", feelZh: "删了隧道尽头没有焦点，词像随机乱飞；呼吸频率跟 CYCLES 对齐才不打拍；再往大或往小调都会改变手感" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；词表替换要保持词数与字长量级（demo 22 词、单词 4–9 字母）：相位是 i/N 均分的，词数一变密度整体缩放；中文词字宽是英文的两倍以上， 换中文关键词须同步下调字号否则近处直接占满画面；CYCLES 必须是整数，否则首尾不接——这是本卡\"可无缝 loop\"的唯一前提， 想调过镜速度就整数加减，别改小数；只做背景层：中段生命曲线压到 0.5 就是为了给前景让位，把它当主角 （拉满亮度）反而读作杂乱；深底专用：text-shadow 发光 + 径向暗角是效果的一半，浅底上词会糊成 脏点；22 个词元素全程挂在 DOM 里（不销毁重建）只改 transform/opacity， 移植 Remotion 时保持这个结构，别改成按帧增删节点",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 6s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(22px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 状态轮播故障（上游  → typography）
  {
    id: "glitch-cycle",
    category: "typography",
    nameZh: "状态轮播故障",
    oneLineZh: "同一行等宽槽位循环轮播状态短语，每条头尾全乱码、中段偶发单字抖动，切换瞬间叠 RGB 分离与整行位移。",
    useWhenZh: "加载、构建、部署过程的状态播报；技术型片头的「系统自述」。",
    seconds: [4.03, 7.17],
    energy: "high",
    tags: ["typography","字体动态","glitch","cycle","状态轮播故障"],
    intentZh: "把四条文案压进一个槽位：短语头尾用乱码「熔断」再「凝固」、中段几乎干净只偶尔抽一下，观众读到的是系统在一步步推进——乱码浓度就是语法。",
    motionZh: "槽位按最长短语预建 MAXCH 个 span（min-width 0.66em 固定槽宽），短短语左右对称填空格，字符只换内容、整行永不重排；SLOT=38f、p=(frame−slot·SLOT)/SLOT；glitch 概率关键帧 KF=[1,0,0,0.1,0,0,1] 按 p 线性插值（开头全乱、中段干净、约 p=0.5 偶发抽字、结尾熔进下一条），末条用 KF_LAST 把结尾概率归零；底部进度条把四拍串成一条时间线。",
    params: [
      { name: "短语表", typical: "4 条，最长 17 字符（demo LOCKING BEAT GRID）", feelZh: "每条 42f 是\"读得完一个状态\"的下限；5 条以上单条不足 34f 观众只看到闪；再往大或往小调都会改变手感" },
      { name: "概率关键帧", typical: "[1,0,0,0.1,0,0,1]（6 段）", feelZh: "中间那个 0.1 是\"活着\"的证据，删了短语中段死板；把 0 段调到 0.3+ 全片糊成故障" },
      { name: "重掷频率", typical: "每 2 帧（floor(frame/2)）", feelZh: "调大或调小：1 帧一换糊成灰带；4 帧以上乱码看得清是\"另一个词\"，不像噪声；再往大或往小调都会改变手感" },
      { name: "抖动幅度", typical: "x ±g·10 / y ±g·4px（480 坐标；1920 原生约 ×3.6）", feelZh: "x 大于 y 是横向撕裂的关键（等比抖动读作地震）；超过 ~2 个字宽整行跳出槽位" },
      { name: "RGB 分离", typical: "左红右青各 g·3px，阈值 g>0.04", feelZh: "这是\"电子故障\"的身份证；无阈值时中段那 0.1 的概率会让字常年带毛边；再往大或往小调都会改变手感" },
      { name: "槽宽字体", typical: "SF Mono 26px（480 坐标；demo 原生 104px）、槽 0.64–0.66em", feelZh: "等宽 + 固定槽宽是刚需；字距 3px 让乱码之间有呼吸，挤在一起读作乱码块；再往大或往小调都会改变手感" },
      { name: "进度条", typical: "150×2px（demo 原生 1100×4px），强调色渐变填充，线性 + 四拍刻度", feelZh: "唯一的线性元素，给四拍噪声一个稳定参照；删了轮播读不出\"在推进\"；再往大或往小调都会改变手感" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；换项目文案时四条短语字符数要接近（demo 12–17 字符）：槽位数按最长 短语一次建好，短短语靠右填空格——如果一条只有 4 字符、另一条 30 字符， 短的那条在 30 格里孤零零居左，行宽全程被最长条撑着，节奏读作漂移；概率关键帧是 6 段等分映射到短语内进度：短语条数变了单条时长跟着变， 但关键帧形状不变——所以条数越多，\"全乱码\"那两段的绝对时长越短， 切换感越弱，超过 5 条就该把首尾的 1.0 段拉宽；末条必须用 KF_LAST（结尾收 0）：用普通 KF 会让 t=1 停在满乱码上， 接下一镜时读作没渲染完；深底专用：深色底 + 冷/艳色噪声是整套配色的地基（demo 用 aurora 深紫黑 + 粉 / 冰蓝分离），浅底上 RGB 分离 几乎不可见；声音也强依赖——四个切换点天然是四个节奏点，实战必须配 电子故障/开关音； 配法纪律见 sound-design.md（同类元素同音，连发交替双样本防机枪感）",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 5.6s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(4px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 关键词充能（上游  → typography）
  {
    id: "gradient-word-sweep",
    category: "typography",
    nameZh: "关键词充能",
    oneLineZh: "黑底标语里关键词被渐变彩光从左到右快速扫过「充能」，波前字符最亮、填满后字符间跳细闪电、整词稳态泛光呼吸。",
    useWhenZh: "标语里给单个动词或卖点词充能；能量高潮段的文字戏；黑场品牌片的口号帧。",
    seconds: [2, 3.5],
    energy: "high",
    tags: ["typography","字体动态","effects","gradient","word","sweep"],
    intentZh: "整句白字里只有关键词被「通电」：扫过的瞬间最亮、随后衰减到稳态；三个命门是快（扫充 15–20f）、波前最亮、辉光克制。",
    motionZh: "关键词做双层文字，彩层用从左到右推进的 mask 揭开，斜切边缘约 8% 词宽模糊；跟随 mask 前沿一条约 34% 词宽的增亮带，波前处辉光最强向后衰减，填充结束后约 10f 淡出到稳态；4 层泛光稳态 opacity 0.55–0.72；填满后字符间出现紫红三层描边的细闪电，用 mulberry32 种子稀疏跳闪，不是持续电弧。",
    params: [
      { name: "扫充时长", typical: "15–20f", feelZh: "原片\"速度很快\"；>28f 读作进度条" },
      { name: "波前增亮带", typical: "~34% 词宽，波前最亮向后衰减", feelZh: "无梯度＝静态渐变；带太宽＝整词一起亮没有\"注入\"感" },
      { name: "稳态泛光", typical: "4 层 opacity 0.55/0.55/0.62/0.72", feelZh: "调大或调小：0.75+ 档被裁太强；辉光层数<3 读作纯色" },
      { name: "闪电线宽", typical: "外 6/中 2.4/核 1.4 @1080p", feelZh: "加倍即被裁\"粗\"；颜色偏紫红（magenta 216,60,190 系）" },
      { name: "闪电频率", typical: "稀疏零星（同屏 ≤2 道，间歇 >8f；demo 排期 7 次、同屏 1 道、间隔 ≥4–11f）", feelZh: "手感：稀疏零星（同屏 ≤2 道，间歇 >8f；demo 排期 7 次、同屏 1 道、间隔 ≥4–11f） 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；判例三条（用户逐字意见沉淀）：①填充过程禁跟随光点；②闪电 必须紫红+细；③泛光宁弱勿强，波前梯度补足冲击力；与 type-rhythm-sync 分工：那张是节拍； 本卡是单词\"充能\"的能量语义，词必须是句中卖点词；关键词外的正文保持纯白静止——全句都动就没有\"只有它通电\"的戏",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 2.75s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(15px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 首词组句（上游  → typography）
  {
    id: "lead-word-zoom-assemble",
    category: "typography",
    nameZh: "首词组句",
    oneLineZh: "首词以 2.3 倍字号占满画面并继续推近 6%，再用一条曲线同时缩回终字号与整行左滑归位，后续词从槽位右侧被推进来补齐句子。",
    useWhenZh: "品牌名或产品名的 Introducing 字卡；发布会式开场第二镜；一句话主张需要先让一个词占满画面的场合。",
    seconds: [2.02, 3.58],
    energy: "high",
    tags: ["typography","字体动态","opening","lead","word","zoom"],
    intentZh: "把阅读顺序做成物理顺序：先只给一个词、大到占满画面、还在朝观众推近，观众被迫先读它；然后它退回句中位置，整句围绕它长出来，落定时观众已读过两遍主词。",
    motionZh: "两段缩放叠成一条 scale：0–12f 从 2.3 推到 2.3·1.06（PUSH_EASE），12–24f 缩回 1；缩回与左滑共用 ZOOM_EASE（cubic-bezier(.5,0,.05,1)，重 ease-in-out 零回弹），translate 在 12–36f 从 slideDistance→0；slideDistance=lineWidth·(0.5−leadRatio)，支点横向钉首词中心、纵向钉基线；整行上移的同一时窗副行浮出，静止 26f 后末 12f crash-zoom 推近失焦交棒。",
    params: [
      { name: "首词起手倍数", typical: "initialScale 2.3", feelZh: "调大或调小：2.3 让首词横向溢出画面一点点（读作\"太大了装不下\"）；<1.8 只是\"稍大的字\"，冲击消失" },
      { name: "推近", typical: "pushScale 1.06，占满 hold 12f", feelZh: "调大或调小：6% 是\"还在朝观众来\"的最小可感量；>1.15 会在缩回时读作反向弹跳" },
      { name: "hold", typical: "12f", feelZh: "首词独占画面的时长；<8f 观众读不完一个长单词，>20f 整句节奏塌" },
      { name: "缩回", typical: "12f，ZOOM_EASE", feelZh: "与左滑同曲线；单独给缩回一条更快的曲线会让整行\"先缩完再滑\"，断成两拍" },
      { name: "左滑", typical: "assembleDuration 24f", feelZh: "比缩回长一倍：字号已经落定、位置还在走，这段\"滑行尾巴\"是电影感的来源" },
      { name: "后续词延迟", typical: "wordDelay 6f（缩回起点之后）", feelZh: "首词开始缩回才放后续词；同帧放会挤在一起看不清谁在动；再往大或往小调都会改变手感" },
      { name: "词间错峰", typical: "wordStagger 4f", feelZh: "调大或调小：4f 读作\"依次被推进\"；0 则整段后缀一起进，回到\"整句淡入\"；再往大或往小调都会改变手感" },
      { name: "单词推入", typical: "wordDuration 12f，wordPush 0.5em", feelZh: "调大或调小：0.5em 是\"刚从槽位外面\"；>1em 会读作从画外飞入，与首词的收束方向打架；再往大或往小调都会改变手感" },
      { name: "词淡入", typical: "wordFade 2f", feelZh: "刻意极短。>6f 词会读作\"浮现\"，推入的力学感消失" },
      { name: "字号/字重/字距", typical: "96px / 600 / −0.03em", feelZh: "负字距在放大 2.3 倍时才不会散架；正字距的大字会读作\"标语横幅\"" },
      { name: "上移 + 副行", typical: "f34–50，−56px，副行同窗", feelZh: "两件事必须同窗：先上移再出副行会多出一个空当拍" },
      { name: "静止", typical: "22f", feelZh: "落定后的可读时间，低于 15f 观众来不及读副行" },
      { name: "crash", typical: "末 12f，scale→1.2，blur→9px", feelZh: "这是转场的前半，动机要和下一镜的第一帧对上；单独播时看起来像\"没结束\"是正常的；再往大或往小调都会改变手感" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "支点错了就抖基线。transform-origin 必须是「首词中心 % + 基线 px」这一对。 取行盒中心（默认 50% 50%）时缩放与左滑互相拉扯，末尾几帧基线肉眼可见地跳；基线别估算。lineHeight × 0.8 这类经验值在不同字体上差几像素，放大 2.3 倍后就是 十几像素的抖动。零尺寸 inline-block 尺子的 offsetTop 是唯一可靠的读法；delayRender 期间整行 opacity: 0——必须如此。否则未量到支点的第一帧会闪一下 错位的大字，成片里就是一帧脏帧；布局是挂载时实测的，所以结果随渲染环境的字体而变：跨平台字体回退不同时整行宽度 会整体漂移（首词占比也跟着变）。介意的话把量到的三个值写死成常量；scale / translate 用的是独立 CSS 属性（不是 transform 简写）。混用会让其中一个 被覆盖；要合并成 transform 就必须自己保证 translate → scale 的顺序",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 2.8s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(2px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 马克笔划线（上游  → typography）
  {
    id: "marker-underline-title",
    category: "typography",
    nameZh: "马克笔划线",
    oneLineZh: "大标题落定后，关键词下方马克笔下划线从左到右 8–12f 快速描画——变宽笔形、毛糙边缘、微上斜跟随斜体字势。",
    useWhenZh: "标题里强调单个关键词；手写感或人味的品牌调性；正文标注式强调。",
    seconds: [1.08, 1.92],
    energy: "low",
    tags: ["typography","字体动态","marker","underline","title","马克笔划线"],
    intentZh: "用材质反差把一个词从排版里拎出来，像人拿笔在海报上圈重点；三个命门：快（8–12f 一笔呵成）、近（贴字底）、跟字势（斜体词必须左低右高微上斜）。",
    motionZh: "SVG path 描画从左到右 8–12f，ease-out 微收尾（起笔快、收笔略缓＝手劲）；笔形中段最宽、边缘毛糙、首尾略细；位置贴字底（bottom 偏移约 −0.1em）并微上斜跟随斜体字势；标题完全落定后 +4~8f 起笔，与标题同动会抢戏。",
    params: [
      { name: "划线时长", typical: "10f（原片实测节奏；14f 版被裁偏慢）", feelZh: ">14f 读作进度条；<6f 看不见笔迹方向；再往大或往小调都会改变手感" },
      { name: "字底距离", typical: "≈-0.1em（从 -40 收到 -20@1080p 才贴住字势）", feelZh: "离远读作分隔线；碰到字底降部又乱" },
      { name: "斜向", typical: "左低右高微上斜（跟斜体）", feelZh: "画反（左高右低）一眼假——返工判例" },
      { name: "笔宽", typical: "中段 ~0.12em，首尾 ~0.6x", feelZh: "等宽读作机器线；差异>2x 读作书法；再往大或往小调都会改变手感" },
      { name: "毛糙度", typical: "边缘轻噪声", feelZh: "太糙读作故障；全平滑读作 CSS border" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 draw-svg-trace 撞领域（有意单列为两卡）：那张是通用 SVG 描画（图标/插画/任意线稿）；本卡专做文字强调的马克笔 质感（变宽+毛糙+跟字势），做图形描画去用那张；斜向判例：v1 左高右低被比对环节抓出——划线斜向必须跟字势， 正体字则水平微抖；残余差距：原片（notion-ai）笔头飞白颗粒感更细碎，实战可加 更细的笔刷噪点",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 1.5s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(10px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 空心字瞬时点亮（上游  → typography）
  {
    id: "outline-word-fill",
    category: "typography",
    nameZh: "空心字瞬时点亮",
    oneLineZh: "空心词从 3.2 倍急缓收缩落位，虚线大圆收缩自转、水平虚线内伸，描边微亮后实心白热字在一帧内硬切点亮。",
    useWhenZh: "单词式利益点或口号的重锤一拍；节奏卡点上的「钉子」镜；深底品牌片的强调帧。",
    seconds: [2.16, 3.84],
    energy: "high",
    tags: ["typography","字体动态","outline","word","fill","空心字瞬时点亮"],
    intentZh: "一个词要打成钉子靠两次落定：先是尺寸的落定（3.2 倍急缓收缩），再是质感的落定（一帧内变实心）；中间约 1.5s 的虚线圆与水平虚线是「瞄准」过程，填充必须瞬时。",
    motionZh: "空心字 scale=mix(3.2,1,ramp(f,2,11,EASE.snappy))、2–8f 淡入，按 scale 速度给瞬时失焦（停稳归零）；双层字：outline（color transparent + -webkit-text-stroke 2px 暖灰、220px/500 字重）与 solid（#fff5ee、初始 opacity 0）叠放；虚线大圆 r=410、dasharray 22 18，内圈 72 格刻度环，8–18f 淡入后 scale 2.8→1 在 8–52f 慢收 44f（全片最慢曲线），主圈 0.22°/f 自转、点亮刹那刹停；左右水平虚线 28–46f 从画框边缘内伸到圆边外 28px，线端带准星点。",
    params: [
      { name: "收缩", typical: "scale 3.2 → 1，窗 11f，snappy", feelZh: "调大或调小：3.2 倍是\"从脸前退开\"的量；<2 倍读作普通缩放；窗 >20f 就成了缓慢 zoom，冲击全失" },
      { name: "字重字号", typical: "220px / 500，占画宽约三分之一", feelZh: "空心字上 700+ 会让细描边包住一大块空白，读作气球字；500 是空心字的甜点" },
      { name: "描边", typical: "2px 暖灰（138,118,104），点亮前预热到亮橙白", feelZh: "细描边是\"制图\"语汇；>4px 变涂鸦；预热那一档删了硬切显得没由来；再往大或往小调都会改变手感" },
      { name: "虚线圆", typical: "r=410、dash 22 18、scale 2.8→1（44f）、0.22°/f 自转，点亮时刹停", feelZh: "调大或调小：44f 慢收缩是全片的\"呼吸\"，与 11f 的字收缩形成快慢对比；窗压到 20f 两者撞在一起" },
      { name: "水平虚线", typical: "dash 14 12，28–46f 内伸到圆边外 28px", feelZh: "内伸终点要停在圆边外（不进圆内）；伸满全宽读作十字准星，过头了；再往大或往小调都会改变手感" },
      { name: "瞬时填充", typical: "第 54 帧硬切（按帧判断，不用归一化时间窗）", feelZh: "这一下是全卡的目的：任何形式的慢扫（>3f）都会把钉子降级成美化动画" },
      { name: "辉光", typical: "白 14px + 橙 60px，8f 衰完；冲击环 14f", feelZh: "一闪即逝才像\"点亮\"；持续辉光读作发光字体，质感立刻廉价" },
      { name: "时长", typical: "90f（3.0s）：点亮后 hold 36f", feelZh: "点亮后 <20f 观众来不及读副行与读数" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；只适合单个短词（demo Faster，6 字母）：字号 220 与虚线圆 r=410 是写死的 一组坐标，字一长就顶穿圆、水平虚线内伸终点也会压到字上——换成 两个词或中文四字须同步调 SIZE / R / 内伸终点三处；-webkit-text-stroke 是前缀属性，Chromium/WebKit 才生效；Firefox 下 outline 层是全透明（词直到点亮帧才突然出现）。Remotion 走 Chromium 无碍；瞬时填充必须按帧硬切（demo frame >= POP）。早期版本用归一化时间窗 seg(0.742, 0.762)， 片长一拉长这个窗就会变成几帧的可见渐变——改时长时只挪 POP 帧号；深底专用：暖黑底 + 细描边 + 辉光是效果的全部；浅底上空心字 几乎不可见，需整套重配",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 3s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(3px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 纸感字卡（上游  → typography）
  {
    id: "paper-title-card",
    category: "typography",
    nameZh: "纸感字卡",
    oneLineZh: "一句话逐词压印上纸、一个词标强调色斜体、短划线收束的呼吸位字卡。",
    useWhenZh: "章节转场或价值主张字卡；重要功能出场前的引导卡；全片呼吸位。",
    seconds: [1.3, 2.3],
    energy: "low",
    tags: ["typography","字体动态","transition","rhythm","paper","title"],
    intentZh: "在两段产品画面之间给观众一句话的喘息：说清「接下来看什么、它值什么」；letterpress 压印质感让字卡与纸墨风格的产品画面同属一个世界。",
    motionZh: "单句文案逐词入场：scale 从大压到 1 + blur→0 + opacity（letterpress 压印配方）；每句恰好一个重点词用 italic + 强调色；强调色短下划线 scaleX 0→1 收束；尾部整卡淡出交棒，可挂 mono 小字副行与数字。",
    params: [
      { name: "逐词入场", typical: "第 i 词 delay = 4 + i·4、9f，bezier(0.2,0.75,0.3,1)；scale 1.28→1 + blur 7px→0 + opacity", feelZh: "scale 起点 1.28 是\"压印\"读感的甜点——对照暗场版 TitleCard 用 40px 上移+blur 10，同配方明暗两版" },
      { name: "重点词", typical: "italic + 强调色 oklch(52% 0.115 65)，一句恰好一个 accent", feelZh: "两个 accent 等于没有 accent；重点词选功能名/收益词（C2）" },
      { name: "下划线", typical: "16→34f scaleX 0→1，220×6px 强调色", feelZh: "下划线是收束信号，出现即预告本卡快结束" },
      { name: "时长", typical: "全片 4 张字卡均 50–55f（≈1.8s）", feelZh: "字卡时长定式化——观众读一句话的时间，长了拖节奏短了读不完" },
      { name: "版式", typical: "字号 116/serif；纸底 oklch(97.5% 0.008 82) + 中心暖光 radial；尾部 8f 淡出", feelZh: "纸底+暖光与产品画面同色系，字卡才不像广告插播；再往大或往小调都会改变手感" },
      { name: "副行", typical: "mono 小字 + DigitRoll（demo \"12 shots rendered today\"）；digit-roll 参数见 list-stack-press 卡计数器行", feelZh: "副行给具体数字最有说服力；数字滚动必须在本卡淡出前落定（教训）——排节拍从本卡淡出帧倒推；再往大或往小调都会改变手感" },
    ],
    soundZh: "字卡出场统一钉 swoosh-quick（模板片四张字卡钉在 f220/565/725/885 同音）——同类元素同音是词汇表纪律（S2）；字卡本身无落地重音，能量留给前后镜头。",
    pitfallsZh: "文案要具体：带产品功能名+具体收益，抽象隐喻词被用户逐字改掉（C2——\"one board\"→\"one place to go\"、加 \"Paper Radar\"）；文案在画面锁定后按最终镜头重写一遍（C1）；重要功能出场前要有引导字卡（C2 判例：文档镜头前应加一句引导，如 \"Every project, linked to your weekly report\"）——字卡不是装饰，是章节路标",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 1.8s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(4px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 胶囊伸缩轮换（上游  → typography）
  {
    id: "pill-chip-slot-cycle-handled",
    category: "typography",
    nameZh: "胶囊伸缩轮换",
    oneLineZh: "句式里深色胶囊内词竖向滚轮轮换，胶囊宽度按预量文本宽平滑伸缩、两侧文字被自然挤开，胶囊上下露出灰色幽灵项。",
    useWhenZh: "「我们替你搞定 ___」这类句式卖点；SaaS 功能列举的一句话收口；浅底品牌片主视觉。",
    seconds: [3.6, 6.4],
    energy: "medium",
    tags: ["typography","字体动态","pill","chip","slot","cycle"],
    intentZh: "让句子接受变化而不是躲开它：胶囊撑宽、两侧文字被自然挤开，句子读起来是活的；上下露出的灰色幽灵项明示「这是个可以滚的列表」。",
    motionZh: "setup 期用隐藏 span 逐词量 offsetWidth、各加 74px 内边距存成 widths[]；切换点 [0.25,0.47,0.69]、每窗 0.12（约 18f）用 E.inOutCubic，内列 colIn 竖移 −pos·48px（行高 48=胶囊高）；胶囊宽度取 widths 插值、帧内插值保证伸缩连续；幽灵项在胶囊外上 −38px/下 58px，随滚动半速视差 (pos−near)·48·0.5。",
    params: [
      { name: "词表", typical: "4 词 + emoji（Shots/Camera/Sound/Renders——video-shotcraft 包办的镜头/运镜/音效/渲染），3 次切换", feelZh: "词长差决定挤开幅度的观感：demo 最短 5 字母最长 7 字母；差 >2 倍胶囊跳变太猛，句子重心左右甩" },
      { name: "切换点", typical: "[0.25, 0.47, 0.69]，窗 0.12（≈18f）", feelZh: "段间约 0.10（≈15f）静置读词；起手 0.25 前的静置让观众先认出句式；再往大或往小调都会改变手感" },
      { name: "缓动", typical: "E.inOutCubic", feelZh: "两头缓才像滚轮起停；outCubic（只后缓）读作被甩上来，胶囊宽度也会跟着突变" },
      { name: "胶囊", typical: "高 48px、圆角 99、#1a1c24、宽 = 文本宽 + 74", feelZh: "+74 是左右内边距 + emoji 位；<50 词贴边，>100 胶囊胖成按钮；再往大或往小调都会改变手感" },
      { name: "幽灵项", typical: "上 -38 / 下 58px，基础透明度 0.13", feelZh: "调大或调小：0.13 是\"看得见但不抢\"的甜点；>0.25 读作三行并列文字，不是幽灵；删了列表暗示就没了" },
      { name: "幽灵视差", typical: "(pos-near)·48·0.5（半速）", feelZh: "半速是\"外圈更远\"的立体感来源；同速则三行像一整块滑动，幽灵失去意义" },
      { name: "句子字号", typical: "两侧 30px/800、胶囊内 22px/700", feelZh: "胶囊内比句子小是正确层级（徽章依附句子）；等大或更大就读作两个标题打架" },
      { name: "配色", typical: "底 #fbfbfd、句子 #15171d、胶囊白字", feelZh: "浅底 + 单一深色块是本卡的身份证；深底版会让胶囊消失，需整套重配" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；宽度靠 setup 期 offsetWidth 实测：字体没加载完时量到的是回退字体 的宽度，胶囊会偏窄或偏宽——移植时须确保 webfont 就绪后再量，或改用 离屏 canvas measureText；length·13 那条兜底只保证不崩，不保证准；词长差要控制在 2 倍内：宽度自适应是本卡的卖点也是风险， 5→8 字母（如 Sales→Workflow）这一跳已经是可接受上限，再大句子两侧甩得晃眼；两侧文字必须 flex:none：不然 flex 会去压缩它们而不是移动它们， \"挤开\"变成\"字被压扁\"；幽灵项文本取 round(pos) 的邻居，所以在切换的正中间（pos=x.5）会 跳一次文本——被 settle 压到最淡时发生，肉眼基本不可察；但若把 透明度调高到 0.25+，这一跳就会露出来",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 5s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(4px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 句尾词槽轮换（上游  → typography）
  {
    id: "pill-slot-cycle",
    category: "typography",
    nameZh: "句尾词槽轮换",
    oneLineZh: "句干钉死不动，句尾 pill 徽章每约 0.7s 老虎机滚一格，旧词上飞加速淡出、新词从下带模糊滑入。",
    useWhenZh: "「功能列举」类文案的最优雅解法；一句话卖点配多个动词短语的段落。",
    seconds: [4.82, 8.58],
    energy: "high",
    tags: ["typography","字体动态","pill","slot","cycle","句尾词槽轮换"],
    intentZh: "把六个功能塞进一句话的一个槽位：句干是承诺、槽位是变量；静置段是给观众读词的，读不完的拍子等于没换。",
    motionZh: "句干绝对定位左端锚死（不能用 flex 居中，pill 宽度变化会带着句干重排）；每拍 21f，前 8f 完成换位、后 13f 静置；入场 translateY 120→0 + blur 14→4→0（Easing.out(cubic)），离场 translateY 0→−130 + blur 0→10（Easing.in(cubic) 加速飞出）；槽内用隐形占位 pill 撑宽度，新旧两枚绝对定位叠放。",
    params: [
      { name: "拍长", typical: "21f/词，5–7 词", feelZh: "<16f 读不完短语；>28f 节拍器感散掉；8+ 词观众开始数数" },
      { name: "换位窗", typical: "拍内前 8f", feelZh: "拉长到 12f+ 新旧同屏太久，读作两个 pill 打架" },
      { name: "飞行距离", typical: "入 +120 / 出 -130px", feelZh: "<80px 读作原地闪换；入出不对称（出略远）让离场更决绝" },
      { name: "运动模糊", typical: "入 ≤14 / 出 ≤12px 竖向 blur，按真实速度计算（静止为 0）；入 rotateX -38°→0、出 0→34° 绕滚筒翻页", feelZh: "去掉 blur 换位读作硬弹；>20px 中间帧糊成色块；再往大或往小调都会改变手感" },
      { name: "收束过冲", typical: "Easing.back(1.4)，14f", feelZh: ">2 结论落位像卡通；无过冲结论与列举没有档次差；再往大或往小调都会改变手感" },
      { name: "收尾 hold", typical: "完整句静置 ≥45f", feelZh: "这句话是全段目的，不 hold 等于白列举；再往大或往小调都会改变手感" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；本卡是整词级 pill 轮换且嵌在活句子里（不是字符/数位级机械滚动）——文案是 \"句干+动词短语\"结构才用本卡，纯数字/纯标题词别硬套；与 typewriter-moves 分工：打字机是\"一个字一个字造句\"，本卡是 \"句子造好了换零件\"——同片可共存但别在同一句文案上连用；与 type-rhythm-sync 分工：那是既有文字随音轨变属性（不换内容）， 本卡换内容——绑音轨时本卡拍点对鼓点即可，别再叠字重脉冲；pill 短语长度要接近（demo 最长 \"Capture the page\" / \"Design the sound\"）——长短差 >2 倍 槽宽跳变太猛，句子重心左右甩",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 6s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(21px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 双词对峙合拢（上游  → typography）
  {
    id: "text-column-converge",
    category: "typography",
    nameZh: "双词对峙合拢",
    oneLineZh: "左「NEW」右特性词钉死在等屏边距两侧硬切轮换、全程零收缩，换到最后一词才唯一一次 ease-in-out 滑到居中咬合成短语。",
    useWhenZh: "特性清单收束到产品名或口号的段落；发布会式 recap、版本号揭晓。",
    seconds: [4.32, 7.68],
    energy: "low",
    tags: ["typography","字体动态","outro","text","column","converge"],
    intentZh: "两词分踞左右像目录页对峙，直到最后一词停稳观众才发现左右其实是同一句话的两半；命门是钉死——轮换期一像素不动、合拢只许一次。",
    motionZh: "左词左缘、右词右缘各自钉死在等屏边距（原片实测 412/413@1280，×1.5→618/1302@1920）；词轮换纯硬切、停留 16/12/9/8/7/8/10/12f，全程间距零收缩；末词停稳约 10f 后，36f ease-in-out 连续滑动到以屏幕中线居中；终点按等宽字体实际步进算（0.6em+letterSpacing×字符数），两词恰好一空格咬合；无 stamp 缩放、无二次补偿移动。",
    params: [
      { name: "屏边距", typical: "618px@1920（原片实测 412/413@1280 ×1.5）", feelZh: "左右差 >2px 读作没对齐；边距是本卡身份，别改成黄金分割；再往大或往小调都会改变手感" },
      { name: "词停留", typical: "7–16f 不均", feelZh: "均匀停留读作节拍器；<7f 读不完词；再往大或往小调都会改变手感" },
      { name: "合拢触发", typical: "末词停稳 +10f（原片 32.4→32.7s 实测）", feelZh: "停稳期太短，观众没意识到\"这词不换了\"就开始滑" },
      { name: "合拢时长", typical: "36f ease-in-out cubic（原片实测 ~1.2s 连续滑动）", feelZh: "<24f 读作弹跳归位；>50f 读作拖；再往大或往小调都会改变手感" },
      { name: "咬合步进", typical: "0.6em+letterSpacing/字符，等宽字体", feelZh: "非等宽字体步进不可预测，会重叠或漏缝" },
      { name: "字号", typical: "42@1080p（原片实测字高 ~20/720）", feelZh: "这段是小字规格清单气质，放大到 60+ 就成了砸字（单词重锤去用 outline-word-fill）" },
      { name: "小字浮现", typical: "定格 +18f，4f 快淡零位移（原片 34.4→34.6s 间直接出现）", feelZh: "加滑入/长淡入就抢了合拢的戏" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 type-rhythm-sync（字属性节拍）/beat-cut-moves（硬切节拍）撞 领域：那两张是\"轮换本身即内容\"；本卡命门是位置钉死 + 末次合拢 的收尾揭晓，轮换只是铺垫。若段落没有\"合拢揭晓\"就别用本卡；合拢只许一次——每切一词收一档的渐进收缩版已被原片对照证伪并 删除，别复活；必须等宽字体（demo 用 SF Mono）；比例字体下咬合终点算不准；原片词换瞬间带 1 帧亮度闪烁（打字机换行感），demo 已加回 1f 提亮； 闪烁 >1f 会读作故障",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 6s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(64px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 标题降格为标签（上游  → typography）
  {
    id: "title-demote-to-label",
    category: "typography",
    nameZh: "标题降格为标签",
    oneLineZh: "大标题居中显影站稳一拍照后连续缩小 0.3x 平移到左上角落成小节标签，内容区在其下生长。",
    useWhenZh: "章节开场（标题先当主角再让位给内容）；教程或功能演示片的小节交接。",
    seconds: [3.7, 4.5],
    energy: "low",
    tags: ["typography","字体动态","transition","title","demote","label"],
    intentZh: "让标题降格而不退场：观众获得免费的空间记忆——刚才那个大词就是现在左上角那个小词，本节讲的就是它；内容骨架在降格进行中就开始生长，交接零空档。",
    motionZh: "降格是单次连续补间 26f 不对称 in-out（bezier(0.6,0,0.18,1)：起步果断、落点很软）：scale 1→0.22 + 位置 (960,540)→(216,196) 同一条曲线，transform-origin 左中、居中修正量 translate(-50%) 随补间同步归零；登场时标题逐字从遮罩线下升起（16f/字、1.6f 错峰），显影后必须站稳 ≥18f（demo 20f，期间 1.5% 极缓推近）再降格，眉题随起飞 6f 淡出。",
    params: [
      { name: "降格补间", typical: "26f 不对称 in-out，scale→0.22（落成 ≈48px）", feelZh: "<14f 读作标题被弹走；终点 >0.45 标签太大压内容；标签 <40px 不可读" },
      { name: "站稳拍", typical: "显影后 ≥18f 静置", feelZh: "省掉这拍，观众没读完标题它就跑了，降格白做" },
      { name: "内容错峰", typical: "先密后疏，块 18–22f，宽 0.3→1", feelZh: "全部同时长出读作页面刷新而非\"生长\"" },
      { name: "生长起点", typical: "降格开始后 +12f", feelZh: "等标题完全落位才生长会空 8f 冷场" },
      { name: "选中高亮", typical: "扫入 10f / hold 10f / 撤 8f，强调色 20% 透明", feelZh: "高亮 hold <5f 读作闪烁 bug；不撤干净就降格，色块跟着飞很脏" },
      { name: "两节交接", typical: "旧内容 exit 12f 上移退场；旧标签 16f 上移一行变灰", feelZh: "旧标签不让位，新标签落在它身上 = 标签坟场；再往大或往小调都会改变手感" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与\"标题钉进 3D 空间随相机透视变形\"的场景锁定拍法（已退役）分工 （空间型），本卡是 2D 版式层级的连续降格（版式型）——要\"标题住进 产品空间\"用那卡，要\"标题变栏目名\"用本卡，同片选一；降格路径上不许有其他元素动——标题飞行是全屏唯一焦点，骨架生长 在它落点下方不抢（起点错开），但弹窗/光标类同帧入场必抢；多节连用（每节一次降格）时左上角标签要换行不叠放：新标签落位 旧标签上移让位，否则第二节起左上角变成标签坟场；B 式的选中高亮是\"文字可被选中\"的产品暗示，非编辑器/文档类产品 用了语义空转，别为了好看加",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 4.1s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(26px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 文字集结三式（上游  → typography）
  {
    id: "type-assembly-moves",
    category: "typography",
    nameZh: "文字集结三式",
    oneLineZh: "逐字裂升、漂移合拢、沿线流入——字符从别处汇聚成标题，运动轨迹本身有戏。",
    useWhenZh: "大标题或标语的入场；与打字机、坠落系同属标题入场大品类，全片 ≤2 种。",
    seconds: [3.96, 7.04],
    energy: "medium",
    tags: ["typography","字体动态","type","assembly","moves","文字集结三式"],
    intentZh: "标题入场补「集结系」：字符从别处汇聚，轨迹本身有戏——A 理性利落最通用、B 品牌片头仪式感、C 曲线可带语义（增长线/流程线）。",
    motionZh: "A 每字在 overflow 盒内 translateY 115%→0 带 10% 过冲、delay i×2f，基线同步生长；B 字符按 seed 方向漂入 ±260–360px + blur 8px + 旋转 ±24° + 纵深 1.22，错峰归位、锁定帧加深脉冲，合体后整词呼吸 1.04；C 整串字按真实步进沿弧长刚性推进（末字领跑、切线角旋转、行进中可读），到达后逐字沿弧线抬升到左上标题位。",
    params: [
      { name: "A 过冲", typical: "10%（14f out-cubic 升到 −10% 再 6f 回落；原案 6% 可测不可感，实渲加码）", feelZh: "正常速度要看得见回落那一下；升起快段按竖向速度加 y 向模糊" },
      { name: "B 锁定脉冲", typical: "字色深到 #000 + 描边 0→3px→0 / 8f", feelZh: "白底上加深+描边，不用发光（判例）" },
      { name: "B 漂移绑定", typical: "位移 (1−p)、旋转、纵深缩放、blur 8(1−p)、opacity 0.35→1 共用一条 p（Easing.out(cubic)，每字 45f、错峰 3f）", feelZh: "分曲线走，字会\"到了还糊着\"；再往大或往小调都会改变手感" },
      { name: "C 摆正", typical: "到达停 8f 再从左到右 1.1f 错峰、18f 抬升：y 用带 ~4% 过冲的快曲线、x 用 in-out、旋转晚 2f 收敛 → 轨迹是弧；终位按实测字宽排版", feelZh: "不摆正就永远是\"挂在线上\"，读不出标题；抬升行程大时过冲 >5% 会顶进眉题" },
      { name: "C 曲线", typical: "evolve（dashoffset 按弧长比例）随车头字符同步生长；demo 做成图表增长线（电光蓝 5px 描边 + 外发光 + 线下渐变面积 + 青色车头光点与到顶脉冲 + 网格刻度 + 季度标记）", feelZh: "曲线先画完字再走，读作两个动画" },
      { name: "收尾", typical: "全员落定真静止 ≥30f", feelZh: "手感：全员落定真静止 ≥30f 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；标题入场大品类现已五式（本卡三式 + type-entrance-moves + document-typewriter-reveal）， 同片 ≤2 种（P4）铁律不变；B 式与 C 式都是高注意力入场，别再叠相机动作——字在飞的时候镜头必须稳；C 式别让字符各自起跑：后面的字要追越前面的字，曲线低段必然挤成一团（原版踩过）； 按弧长刚性推进、字间距取真实步进才读得出整句；字号 >80px 时曲线拐弯处字会互相啃角， 大字改用更平缓的曲线或减字数",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 5.5s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(10px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 字符坠落（上游  → typography）
  {
    id: "type-entrance-moves",
    category: "typography",
    nameZh: "字符坠落",
    oneLineZh: "字符错峰从顶砸落、重力加速加两次衰减弹跳、落地歪斜站定，最后一拍集体立正归位。",
    useWhenZh: "大标题或章节字卡的入场；轻松调性的开场破冰。",
    seconds: [3.6, 6.4],
    energy: "high",
    tags: ["typography","字体动态","type","entrance","moves","字符坠落"],
    intentZh: "补物理喜剧感：字符从天而降、砸地弹跳、歪歪扭扭站定，最后一拍集体立正归位，适合轻松调性的开场破冰。",
    motionZh: "字符错峰从顶部砸落，重力加速 + 两次衰减弹跳 + 落地歪斜站定，最后一拍全体齐整回正；副标题随归位一拍浮出。",
    params: [
      { name: "坠落", typical: "第 i 字符帧 4+36·(1−(1−i/(n−1))^1.5) 起跳（首末字固定在 4f / 40f，间隔越来越密；demo 9 字符 6.5→1.6f）；y = −DROP + DROP·(t/24)²（重力）→ 4u(1−u) 抛物线弹跳 30% → 二跳 9%", feelZh: "弹跳衰减比 30%/9% 是\"有弹性但不闹\"的甜点；三跳以上读作果冻" },
      { name: "歪斜", typical: "落地瞬间 rotate 到 seed hash ±6° 并保持", feelZh: "歪角是\"物理感\"的一半；全体笔直落地读作普通位移入场；再往大或往小调都会改变手感" },
      { name: "归位一拍", typical: "全员落定后（如帧 110）6f ease-out 集体 rotate→0 + scale 1.06→1", feelZh: "集体归位是句号——错峰归位会把\"立正\"的仪式感拆散；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "动作完毕真静止 ≥20f", feelZh: "R1：静止期所有属性锁死（含歪角归零后）；再往大或往小调都会改变手感" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；落地砸声是声音强依赖候选位（sound-design §4.5）：逐字钉帧会让重量感翻倍， 无声版也成立但少一半劲；字符间不做真实碰撞（demo 为各字符独立轨迹）——字距排开即可； 想要\"互相撞歪\"需预烘焙轨迹，成本高收益薄；选词避开带下行笔画的字母（g/j/p/q/y）或按字形单独校地面——demo 按基线贴地， 下行笔画会\"插进\"地面；标题入场自带高注意力——别和其他高能量入场同帧抢戏",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 5s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(4px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 文字随声同步两式（上游  → typography）
  {
    id: "type-rhythm-sync",
    category: "typography",
    nameZh: "文字随声同步两式",
    oneLineZh: "字重随鼓点脉冲变粗弹回，或卡拉 OK 式随旁白逐词填色点亮。",
    useWhenZh: "标题或标语与音轨强绑定的段落：A 绑节拍（鼓点），B 绑语音（旁白逐词）。",
    seconds: [0.43, 5.5],
    energy: "high",
    tags: ["typography","字体动态","rhythm","type","sync","文字随声同步两式"],
    intentZh: "补「在场的字怎么跟着声音活」：字不动、属性动——没有位移和入退场，纯粹是字重或颜色在声音的拍点上呼吸。",
    motionZh: "A 命中帧细体字瞬间撑成黑体（可变字重连续插值）、9–13f 衰减弹回，重音拍额外撑宽 6%，第 2 小节长出上下描边回声行跟拍，drop 拍落定成粗体渐变海报；B 每词从左到右柔边填亮、进度跟语速，正在读的词填强调色、读完退成主墨色并保持，活跃词下带读指下划线。",
    params: [
      { name: "A 脉冲包络", typical: "env=(1−t/D)^0.8（t=命中后帧数；demo 逐字中心 9f→边缘 13f 错开回弹，≥D 精确归 0）；fontWeight 250+650·env 连续插值（SF Pro 可变字重）；每个字钉在 900 字重排好的槽位里——静止时细体字间留缝、命中时笔画撑满槽位\"合拢\"，整行不重排；无可变字体时退回 env>0.15 窗口 300↔900 …", feelZh: "槽位按最粗字重排是关键：按常规字重排，峰值时字会互相挤压重叠" },
      { name: "A 节拍", typical: "128 BPM 每 14f 一拍（16/30/…/114）+ 第 9 拍 drop（128f）；每小节第 1 拍重音 scaleX = 1+0.06·env 并染粉；drop 冲到 900 后不回细，~16f 回落定格在 780 字重 + 紫→粉逐字渐变 + 一道横向光带", feelZh: "拍距必须 > 最长衰减窗（14>13），两拍重叠读作抽搐" },
      { name: "A 回声行", typical: "第 2 小节起上下各一行 2px 描边同字，晚 2f 跟拍脉冲、每拍被推开 26px（drop 推开 60px 后归位）", feelZh: "递进靠\"加层\"而不是加大幅度；第 1 小节就上回声，后面没牌可打" },
      { name: "A 节拍参照物", typical: "画面下方 8+1 格步进音序器（两小节 + DROP 格），命中哪拍哪格亮起放大 12%，已过的格保留暗亮", feelZh: "静音环境（预览/静帧）没有这排格子就读不出\"在跟拍\"；只让格子和字动，不做整画面逐拍泵；再往大或往小调都会改变手感" },
      { name: "B 词级时间表", typical: "逐词 [start,end] 帧区间，词内 linear 填充；词间留 4–10f 停顿（换气）", feelZh: "时间戳实战来自旁白打点表；均匀分配读作机器朗读；再往大或往小调都会改变手感" },
      { name: "B 词级时间表（demo）", typical: "FRAME 20–38、MOTION 42–75（长词慢读）、CRAFT 85–103、SHOTS 107–130；0–19f 预备、130–149f 真静止", feelZh: "长词给更长的读窗，读作真人语速" },
      { name: "B 填色实现", typical: "每词双层同文本叠放：底层浅灰（13% 透明墨色）+ 上层按进度揭开：mask-image: linear-gradient(90deg, #000 e−4%, transparent e+4%)，e=p·108−4（±4% 柔边前沿；硬切可用 clipPath: inset(0 (1−p)·100% 0 0)）；正在读的词填强调色，读完 10f 退成主墨色", feelZh: "逐词独立叠层免量测词宽占比；整行单层 clip 需精确像素表、易漂；再往大或往小调都会改变手感" },
      { name: "B 读指", typical: "活跃词下 8px 圆角下划线（demo 用强调色），宽度 = p·100%；读完 6f 从左往右收掉", feelZh: "调大或调小：4px 浅灰在 1080p 缩略下不可见（本批实渲踩坑）；读完的词不留线" },
      { name: "B 旁白参照物", typical: "标语下方 48 根竖条旁白波形：读词处起伏、换气处回落，已播部分染强调色", feelZh: "静音预览/静帧没有这条波形就读不出\"在跟读\"；再往大或往小调都会改变手感" },
      { name: "收尾", typical: "A 末拍衰减归零后 / B 末词填完后真静止 ≥20f", feelZh: "手感：A 末拍衰减归零后 / B 末词填完后真静止 ≥20f 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；两式都是声音强依赖手法：A 命中帧必须与鼓点同帧、B 填色区间必须 跟旁白词边界（钉帧走 sound-design §4.5 相对起点）——无声上片则 A 读作 抽风、B 读作莫名变色，别在无音轨段落用；A 式依赖系统可变字体（macOS SF Pro）做 wght 连续插值；换字体或在无可变字体的渲染机上 会退成几档跳变，先确认字体加载与渲染器支持，不行就走 stroke+跳变兜底；A 式全片 ≤1 段（P4）——标题蹦迪是抢戏大户，两段同片互相拆台；B 式词数 ≤6/屏：更多词时填色进度读不过来，拆行或拆镜",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 2.97s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(1px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 打字机改口（上游  → typography）
  {
    id: "typewriter-moves",
    category: "typography",
    nameZh: "打字机改口",
    oneLineZh: "逐字打出平庸词、犹豫后退格删掉、再更快打出卖点词的「改口」三幕剧。",
    useWhenZh: "slogan 或卖点字卡、否定式文案；文字自带时间性的入场。",
    seconds: [3.82, 6.78],
    energy: "medium",
    tags: ["typography","字体动态","opening","typewriter","moves","打字机改口"],
    intentZh: "打字是唯一自带时间性的文字入场，字符一个个到来本身就是节奏，不需要额外动效；犹豫-否定-宣言的戏全在三档速度差里。",
    motionZh: "打 2f/字符 → 停顿 16f 光标闪两下 → 退格 1.5f/字符 → 重打 1.5f/字符无犹豫；光标打删时常亮、只在停顿才闪。",
    params: [
      { name: "字符节奏", typical: "substring(0, floor((f-起点)/步长))，帧确定无插值", feelZh: "任何缓动打字都读作加载动画" },
      { name: "三档速度", typical: "打 2f/字符、删 1.5f、重打 1.5f 且零犹豫", feelZh: "三档差必须可感——等速改口读作 bug 不是戏，命门；再往大或往小调都会改变手感" },
      { name: "光标三态", typical: "打删常亮＝果断；停顿 4f 半周期闪两下＝犹豫；完稿闪两下后条件摘除", feelZh: "光标就是演员的脸，全程等速闪就没有\"犹豫\"；再往大或往小调都会改变手感" },
      { name: "排版", typical: "逐字符固定宽 span（60px 等宽槽），左缘锚定", feelZh: "变宽字体/整串测宽会逐帧重排抖动" },
      { name: "收尾", typical: "静止 ≥50f", feelZh: "光标残留 0.05 opacity 都毁真静止；再往大或往小调都会改变手感" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；声音强依赖：键击声逐字符对齐、退格音调更低（sound-design §4.5）——无声打字机只剩字幕机；全片 ≤1 次——改口是一次性的戏剧转折，改两次口是口吃；等宽字体或逐字符 span 二选一必须占一个，否则字符到来时 整行重排，打字变成抽搐",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 5.3s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(2px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 竖向滚轮换词（上游  → typography）
  {
    id: "vertical-word-roll-blur-cycle",
    category: "typography",
    nameZh: "竖向滚轮换词",
    oneLineZh: "句尾词换成竖向滚轮，3 次换词各 0.55s，相邻行带上垂直 blur 与灰度，中心词落定瞬间从灰染成强调色。",
    useWhenZh: "「Crafted for ___」「Built for ___」这类句干加受众列举的一句话卖点；浅底品牌片的干净一拍。",
    seconds: [3.6, 6.4],
    energy: "high",
    tags: ["typography","字体动态","vertical","word","roll","blur"],
    intentZh: "句尾换词的最优解是滚轮而不是淡入淡出：滚轮自带方向（往上翻页），观众知道还有下一个；句干全程纹丝不动，眼睛钉在滚轮上。",
    motionZh: "位置量 p 由 3 段窗累加，STEPS=[0.16,0.36,0.56]、每段窗 0.11（约 16f/0.55s）、段间留 0.09 静置给观众读词；缓动为混合曲线 0.7·outQuint(u)+0.3·outBack(u)；reel 定位 translateY(ROW−p·ROW)、ROW=44px，mask 高 ROW·3=132px 只露三行；相邻行按距离 d=|i−p| 上垂直 blur 与灰度，中心词落定瞬间从灰染成强调色。",
    params: [
      { name: "词表", typical: "4 词（Launches→Demos→Promos→Every Shot），3 次换词", feelZh: "末词是结论（最宽那个词），前三个是例子；>5 词观众开始数，<3 词读不出\"列举\"；再往大或往小调都会改变手感" },
      { name: "拍点", typical: "[0.16, 0.36, 0.56]，窗 0.11（≈16f）", feelZh: "段间 0.09（≈13f）静置是给读词的，读不完的拍子等于没换；窗 >0.18 新旧同屏太久" },
      { name: "缓动配方", typical: "0.7·outQuint + 0.3·outBack", feelZh: "outQuint 是机械减速的来源；outBack 那三成给落定\"咔\"一下，纯 outQuint 读作电子屏滑动" },
      { name: "行高/视窗", typical: "ROW 44px、mask 44×3px、词宽 190px", feelZh: "露三行才有滚筒感（露一行读作淡入淡出）；宽度写死 190 是为不挤句干，词更长要同步加" },
      { name: "相邻行 blur", typical: "邻行 3px，最远 5px，仅垂直向感知", feelZh: "blur 是\"滚筒景深\"的身份证，删了退化成词条平移；>8px 邻行糊成灰条看不出是字" },
      { name: "落定染色", typical: "1 - 2.4d 映射 ACCENT_DIM→ACCENT", feelZh: "系数 2.4 让染色只发生在落定瞬间；<1.5 滚动中途就上色，答案感散掉；再往大或往小调都会改变手感" },
      { name: "字号字重", typical: "句干与滚轮同为 30px/800、letter-spacing:-.5px", feelZh: "必须完全一致——滚轮词比句干大就读作两个元素，不是一句话" },
      { name: "收尾淡出", typical: "seg(t, 0.9, 0.985) 整组", feelZh: "末词落定后约 40f 静置再淡出；不 hold 等于白列举" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；mask 宽度写死 190px：换词表时最长词（demo Every Shot，带空格的词组要 white-space: nowrap）必须能装进去， 否则被裁字；反之词都很短则右侧留大片空白，句子重心偏左——换词表必须 重量一次宽度；词长差别不宜过大：mask 宽度是固定的（本卡不做宽度自适应，那是 pill-chip-slot-cycle-handled 的活），词长差 >2 倍时短词在框里显得孤立；句干必须钉死：demo 用 flex + gap:14px 是因为 mask 宽度恒定不会推挤 句干——一旦改成宽度自适应的滚轮，就必须换成绝对定位锚左端， 否则句干随词宽左右甩；p 是三段窗累加出来的，所以三段窗不能重叠：重叠会让 p 在一帧内 跨越一整行，滚轮\"跳格\"",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 5s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(4px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 胶片接力换词（上游  → typography）
  {
    id: "word-relay-filmstrip",
    category: "typography",
    nameZh: "胶片接力换词",
    oneLineZh: "左列黑白相间等高页面卡步进滚动（焦点卡全亮、邻卡离焦压暗），右侧衬线大词原位接力——切词瞬间才滚动一格。",
    useWhenZh: "「一个主体 × 多种能力」的枚举段；作品集或案例流展示；产品多场景巡礼。",
    seconds: [2, 6],
    energy: "low",
    tags: ["typography","字体动态","ui-entrance","word","relay","filmstrip"],
    intentZh: "左边是证据、右边是论点：动词换一次胶片就步进一格给出新证据；命门是步进制（平时完全静止）与像素级垂直对齐。",
    motionZh: "左列等高页面卡（940×530、间距 105）纵向排列、黑白强制相间；切词窗口内 18f 不对称 in-out 滚动恰好一卡高，其余时间零位移，快段叠纵向运动模糊；邻卡按 dist=|卡顶−275|/635 压暗 0.68·dist、缩到 0.94、虚化 ≤3px；右侧衬线词块垂直中心与当前页面卡中点精确对齐，旧词 10f 灰化、8f ease-in 先出，新词切点 +7f 起逐字母从遮罩下沿升起（1.2f 错峰、后进，不许叠影），金色引线在切词起 6f 收回、+10f 后 16f 重画。",
    params: [
      { name: "页面卡", typical: "等高（530px@1080p）、黑白相间、约半屏宽", feelZh: "不等高/同色系读不出步进；卡太窄失去\"证据\"分量" },
      { name: "词期", typical: "~45–60f/词", feelZh: "<40f 读不完词+胶片看不清；词期不必均匀；再往大或往小调都会改变手感" },
      { name: "滚动窗口", typical: "~16–18f 不对称 in-out，恰一卡高", feelZh: "持续滚动=命门违例；滚过头/不足读作机械故障；再往大或往小调都会改变手感" },
      { name: "词接力", typical: "旧词灰化后 8f 升出 → 切点 +7f 新词逐字母升起（16f/字母，1.2f 错峰）", feelZh: "同帧交叉必叠影；间隙 >10f 读作断片；再往大或往小调都会改变手感" },
      { name: "垂直对齐", typical: "词块中心=当前卡中点（像素级）", feelZh: "用户单点意见\"文字高度和中间的页面中点要对齐\"；差 >8px 可感" },
      { name: "字体", typical: "衬线 Didot 类、动词斜体白字 / 名词正体次级墨", feelZh: "无衬线会丢\"编辑部\"气质；动词要比名词亮，它才是换的那一个" },
      { name: "邻卡离焦", typical: "压暗 0.68·dist、缩 6%、虚化 ≤3px", feelZh: "不压暗则邻卡和焦点卡抢戏；虚化 >5px 读不出是页面" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 text-column-converge 分工：那张是左右对峙合拢的揭晓戏； 本卡是纵向证据流+原位接力，无合拢无揭晓；与 pill-slot-cycle 分工：那张是胶囊槽位轮换 UI 元素； 本卡是版式级的图文对位系统；实战素材：页面卡应使用真实截图（demo 为手搓假页面——分镜脚本 / 渲染流水线 / 成片 PR 评审，每个动词停在 与之对应的证据卡上，残余差距已知）；截图亮度要人工分档保证相间可读",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 4s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(64px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 几何接力三词（上游  → typography）
  {
    id: "word-relay-geometry",
    category: "typography",
    nameZh: "几何接力三词",
    oneLineZh: "三个利益词各带一套专属几何接力：虚线大圆减速自转加彗星弧、三实线圆 trim 生长收拢咬紧、镀铬 sheen 扫过后一拍收成纯白。",
    useWhenZh: "三点式利益陈述（更快/更好/更强）；品牌价值观段落；需要「一词一世界」的中段推进。",
    seconds: [4.32, 7.68],
    energy: "high",
    tags: ["typography","字体动态","word","relay","geometry","几何接力三词"],
    intentZh: "给每个词配一套只属于它的几何，几何本身替形容词做论证：圆在转＝快、三圆咬合＝紧、金属扫光＝强；第三个词留升格待遇因为它是结论。",
    motionZh: "三段按帧排：Faster 2–62、Tighter 56–122、Stronger 116–180；每段入场 14f（snappy，scale 1.06→1 + 10px 去虚）、出场 10f（exit 强 ease-in，scale 1→0.86 + 12px 退焦），交接重叠 6f；每词三层文字（230px/800，outline 层 text-stroke 2px + 透明填充、fill 层纯白），描边先到位、填充后以 ±7% 柔边 mask 横向擦入 18f；Faster 的虚线大圆 r=400、dash 10 16，外圈 120 格刻度环反向慢转，入场 22f 从 0.4 长到 1 并多转 160° 减速刹住，彗星弧 16 段渐隐以 7.5°/帧飞跑；Tighter 的 trim 依次生长后收拢咬紧；Stronger 的镀铬 sheen 扫过后收成纯白。",
    params: [
      { name: "三段时段", typical: "各 ≈60f，重叠 6f", feelZh: "每词约 2s 是\"读词 + 看几何\"的下限；重叠 <3f 读作硬切，>12f 两词同屏打架" },
      { name: "入/出场窗", typical: "入 14f snappy / 出 10f exit", feelZh: "出场比入场短是对的（退场要决绝）；出场用 out 曲线会读作\"舍不得走\"" },
      { name: "outline→fill", typical: "18f swift，±7% 柔边，outline 留 0.2", feelZh: "留一点描边做重影是质感来源，降到 0 字变扁；窗 >30f 擦入慢得像加载条" },
      { name: "虚线圆", typical: "r=400、dash 10 16、scale 0.4→1、入场多转 160° 刹住", feelZh: "刹车是\"快\"的第一证据；scale 起点 >0.7 就没有\"长出来\"" },
      { name: "彗星弧", typical: "7.5°/帧、16 段渐隐", feelZh: "比环快 8 倍以上才读得出\"速度差\"；段数 <8 尾巴断成虚线" },
      { name: "trim 生长", typical: "延迟 6f/圆、各 22f", feelZh: "相位差是\"依次相扣\"的关键，同时生长读作三个独立圆" },
      { name: "收拢", typical: "间距 340→300（14f swift）+ 交点铆钉", feelZh: "收拢量 <20px 看不出动作；>60px 三圆挤成一坨；再往大或往小调都会改变手感" },
      { name: "sheen 扫光", typical: "100deg、background-size:300%、24f smooth", feelZh: "调大或调小：300% 保证白带只占字宽一小段（=金属高光）；镀铬底层不能省，否则扫光前是一块灰字" },
      { name: "收白", typical: "12f + 泛光脉冲 + 脚下光带", feelZh: "这一下是全片唯一的\"结论\"待遇；删了三个词就是平级，第三点没有落点；再往大或往小调都会改变手感" },
      { name: "字号配色", typical: "词 230px/800、副句 40px、几何 rgba(236,238,244,.42)、graphite 暗场", feelZh: "几何比字暗一档是层级，几何比字亮就抢主角" },
    ],
    soundZh: "文字入场配极轻的纸笔沙沙或合成器单音，重点词落定处钉一个短促 tick；不要每个词都配音。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；三个词必须是同一句法的三点（demo 都是比较级单词，6–8 字母）： 时段是等长的，词长差大时几何（圆半径、间距）都是写死的坐标， 长词会顶出虚线圆或压到相扣圆上——换词表要同步调 r 与收拢间距；-webkit-text-stroke 是前缀属性：Chromium/WebKit 才有，Firefox 下描边层 直接是透明（词消失）。Remotion 渲染走 Chromium 无碍，但预览环境要注意；SVG trim 用的 pathLength=1 归一化在部分老版本浏览器上对 <circle> 支持不全，退化表现是圆一次性全画出（丢生长感）——移植时先在目标 渲染器上验一帧；出场 trim 是\"入场 trim 减出场 seg\"直接相减：两段窗若靠得太近 （段长 <40f）会出现还没长完就开始收，圆只画出一小段",
    recipe: {
      css: "/* 逐词入场：delay = index * stagger */\n.ms-word{animation:ms-word 6s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i) * 0.12s)}@keyframes ms-word{from{opacity:0;transform:translateY(60px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    },
  },
  // 头像队列轮换（上游  → ui-entrance）
  {
    id: "avatar-bracket-carousel",
    category: "ui-entrance",
    nameZh: "头像队列轮换",
    oneLineZh: "「Your ___ agent」填空排版，四角对焦框钉在句中不动，头像队列在框内垂直 spring 轮换三次。",
    useWhenZh: "「一个位置，多种角色」的能力枚举；团队、身份、预设、人格类产品的核心一句话镜头。",
    seconds: [3.74, 6.66],
    energy: "medium",
    tags: ["ui-entrance","UI 入场","avatar","bracket","carousel","头像队列轮换"],
    intentZh: "把四行角色清单塞进一句话的一个槽位：句子不动、只有槽里的人换来换去；对焦框不参与轮换，却把观众眼睛钉死在那 92×92 的方框里。",
    motionZh: "位置量 pos 是三段 spring 的累加（切换点 0.24/0.46/0.68，每段 0.14）；距离 d=|k−pos| 驱动 scale=max(0.5,1−d·0.38)、opacity=max(0,1−d·0.62)、blur=min(3,d·2.4)、translateY=(k−pos)·76，四个属性同源于一个距离量；每张头像按 0.03 错峰在开场 0.15 内入场，切换瞬间对焦框呼吸 7%。",
    params: [
      { name: "切换点", typical: "0.24 / 0.46 / 0.68，间隔 0.22（≈34f / 1.14s）", feelZh: "间隔就是\"读得完一个角色\"的时长；<0.12 观众来不及看标签，>0.3 节拍器感散掉" },
      { name: "切换行程", typical: "窗 0.14（≈22f），E.spring(k, 0.25)", feelZh: "行程占间隔的 64% → 静置时间约 12f；阻尼 0.25 是明确一次回弹，调小会抖两下与相邻切换互相干扰" },
      { name: "步距", typical: "STEP=76px（框 92px、头像 58px）", feelZh: "步距必须大于头像直径否则相邻两张会咬边；76/92 意味着出框的头像仍露出一角，队列的存在被暗示" },
      { name: "缩放衰减", typical: "1 - d*0.38，下限 0.5", feelZh: "一格距离缩到 0.62；斜率调大出框更决绝，但下限 0.5 会更早触顶，队列变成\"两档尺寸\"" },
      { name: "透明度衰减", typical: "1 - d*0.62", feelZh: "调大或调小：1.6 格距离外完全消失 → 画面里始终有约 3 张可见；斜率降到 0.3 会看到整列四张都在，取景框的\"锁定\"语义被削弱" },
      { name: "模糊衰减", typical: "d*2.4，上限 3px", feelZh: "模糊是景深暗示，2.4 的斜率让邻位约 2.4px；>4px 邻位糊成色块，队列读不出是头像" },
      { name: "标签衰减", typical: "1 - d*2.2", feelZh: "斜率必须显著大于头像的 0.62——标签是文字，两句同时半透明叠着最难读" },
      { name: "框脉冲", typical: "窗 0.1，sin(·π) × 0.07", feelZh: "调大或调小：7% 是\"咬合了一下\"的量；>15% 框自己变成主角，抢过头像更换" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。音效密度与画面节拍一致即可。",
    pitfallsZh: "四张头像对三次切换：pos 最终停在 3，正好是末位。加第五张必须加第四次切换（且 末次切换要在 0.86 之前结束才有静置时间），否则队列末尾永远进不了框；切换点是硬编码数组，出现两处（pos 累加与 breath 累加）。改节拍必须同时改两处， 漏改一处会出现\"框脉冲和头像换位错开\"；入场 stagger 与首次切换的间隔只有 0.09（入场末 0.15 → 切换 0.24）。加头像数会推后 入场结束点（0.12+k*0.03），5 张以上就要把首次切换往后挪；头像是白色线性图标 + 中性灰阶受光渐变圆（灰度分层仅用于区分队列项），强调色只用在对焦框的 四个 SVG 角标上（及标签 chip 的一粒圆点）——落地换成真实头像后仍应保持这个分工，头像本身别抢色；对焦框 SVG 的四条 path 与 92×92 viewBox 是写死的坐标（M4,26 L4,4 L26,4 等）。改 框尺寸要整套重标，只改容器宽高会让角标缩放失真",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(0px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 5.2s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 贝塞尔汇聚吞并（上游  → ui-entrance）
  {
    id: "bezier-source-converge-merge",
    category: "ui-entrance",
    nameZh: "贝塞尔汇聚吞并",
    oneLineZh: "四个来源节点各有一条细贝塞尔曲线连向同一汇聚点，曲线错峰 draw-on 后节点沿曲线滑入汇聚点、三段式加速缩小消失，最后只留品牌标志。",
    useWhenZh: "「多源整合、统一接入、数据汇聚」的核心机制镜头；集成、聚合、单一入口类产品的说明段落。",
    seconds: [4.03, 7.17],
    energy: "medium",
    tags: ["ui-entrance","UI 入场","bezier","source","converge","merge"],
    intentZh: "把「我们把四个来源统一了」变成可看的物理过程：先建立四条通路（连上了），再让来源真的顺着通路走进同一个点被吸进去（吞并），最后擦掉通路只留品牌标志（现在只有一个）。",
    motionZh: "四条路径 d=\"M -22,y L 74,y C 186,y 214,120 332,120\" 只差起始 y（36/92/148/204），曲率与汇入角天然不同；draw-on 用 stroke-dasharray=len、dashoffset=len*(1−draw)，seg(t,0.04+i*0.045,+0.17,E.outQuad) 依次接通；节点用 getPointAtLength 定位，f0=96/len 标定、frac=f0+(1−f0)*conv，conv=seg(t,0.34,0.74,E.inOutCubic)；三段式缩小：conv<0.75 时 44→15px 缓慢瘦身、conv≥0.75 时 15→0px（后 1/4 行程掉光）；强调色数据包全程沿路径滑行，汇聚后曲线从左端反向擦除，徽标一次脉冲。",
    params: [
      { name: "来源数", typical: "4 条（y=36/92/148/204，间距 56）", feelZh: "调大或调小：4 条是曲率差异明显又不打结的甜点；>6 条中间几条的贝塞尔几乎重合，汇入角读不出区别" },
      { name: "draw-on", typical: "起点 0.04+i*0.045，窗 0.17，outQuad", feelZh: "调大或调小：0.045 的错峰约 7f；归零会读作四条线一起刷出，失去\"逐路接通\"的语义；再往大或往小调都会改变手感" },
      { name: "汇聚窗", typical: "0.34→0.74（inOutCubic）", feelZh: "占全片 40%，是主段落；inOut 的缓起是\"启动\"、缓收是\"到位\"，换 linear 立刻变成匀速传送带" },
      { name: "三段缩小", typical: "44→15px（前 75%）→ 0（后 25%）", feelZh: "拐点 0.75 越靠后吸入越突然；把它挪到 0.5 会变成\"一路缩小\"，吞并的那一下就没了" },
      { name: "数据包周期", typical: "2 个整数周期（0.1→0.74 线性）", feelZh: "必须是整数周期，否则末帧包停在半路；周期加密到 4 会读作数据流很急，也更容易和节点重叠" },
      { name: "包相位偏移", typical: "i*0.13", feelZh: "错开四路的包，避免它们排成一行同时汇入；0 会看到四个包整齐并进，像一次发车；再往大或往小调都会改变手感" },
      { name: "擦除", typical: "0.78→0.9，dashoffset 取负", feelZh: "调大或调小：12f 完成；擦除必须在节点全部消失（conv=0.74 结束、节点 0.92 前淡完）之后，否则线先没了节点悬在空中；再往大或往小调都会改变手感" },
      { name: "徽标脉冲", typical: "outBack +12%（0.7→0.78）→ 回落（0.78→0.86）", feelZh: "调大或调小：12% 是\"接收到了\"的量级；>25% 会抢过汇聚本身的注意力；再往大或往小调都会改变手感" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。音效密度与画面节拍一致即可。",
    pitfallsZh: "getTotalLength / getPointAtLength 必须在 SVG 已挂到文档且完成布局之后才有效， 代码用 ready 标志在首帧 prime() 里做——移植到 Remotion 时首帧渲染可能拿不到 长度（fallback 写了 || 380）。稳妥做法是在 useEffect/layout 后再算，或预先算好 常量表，否则首帧会出现一次错位跳变；f0 直接按直线段长 96 标定（96/len）。旧版用 40 步线性扫描，精度只有 1/40，节点驻留位 会偏离 74、四个节点排不成一列——改路径（尤其直线段长度）后要同步改这个标定；节点 opacity 在 conv > 0.92 后才开始淡出，而 conv 在 t=0.74 就到 1，所以节点是在 尺寸缩到 0 时消失而不是淡出消失。这是有意的（被吸进去不该淡出），但如果把三段式 拐点改晚，会看到节点在有尺寸时突然消失；节点是灰阶线性图标（demo：页面截图/镜头卡/代码/声音四种素材）的白瓷占位圆（灰度分层仅用于区分四路），落地可换成真实来源 logo；强调色只留给数据包与涟漪，不要给节点上色，否则汇聚点的视觉主体被夺走。汇聚点的标志要托在一枚不透明的 圆片上——曲线终点与数据包都落在汇聚点中心，开口形标志（如镜刻取景框）直接放上去会从缺口里露出线头；汇聚点 (332,120) 与 SVG 视口 440×240、overflow:visible 是绑定的一组坐标。改画布 比例要整套重标，路径起点 -22 依赖 overflow:visible 才能露出画框外的一截",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(4px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 5.6s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 卡堆弹入展开（上游  → ui-entrance）
  {
    id: "card-stack",
    category: "ui-entrance",
    nameZh: "卡堆弹入展开",
    oneLineZh: "一组模板卡从屏幕下方逐张 spring 弹入、越落越快叠成一摞，全员落位后整摞一次性展成扇面，最后中心卡被抽出。",
    useWhenZh: "需要交代「我们有一组东西」的产品段落；卡片墙、模板库、方案列表的建立镜头，也能当 logo 前的一拍蓄势。",
    seconds: [3.6, 6.4],
    energy: "high",
    tags: ["ui-entrance","UI 入场","card","stack","卡堆弹入展开"],
    intentZh: "一摞卡先聚成一个物体、再摊开成一组物体：观众第一眼记住有分量的一摞（数量感），第二眼才看清每张不一样（多样性）；展开留到最后一次性完成，不和入场节拍打架。",
    motionZh: "入场起跳帧 2+stagger(i,9,40,EASE.out)（间隔先大后小、越来越快），每张 springAt(damping 13、stiffness 150) 从 y=820px 抬到 0；每张落座时整摞被压低 5px（sin 包络 9f），成摞时确定性 ±3.2°/±11px 错位；展开前 62–72f 整摞收紧 2% 预备，扇形用 springAt(damping 20、stiffness 95) 唯一时钟，终态 k=i−4、rot=k·6.5°、tx=k·138px，transform-origin 50% 130%。",
    params: [
      { name: "卡数", typical: "N=9（奇数，中心卡独占中位）", feelZh: "调大或调小：9 张 × 6.5° = 52° 总张角是舒适上限；>11 张要把每张角度降到 4–5°，否则两端卡飞出画框" },
      { name: "入场 stagger", typical: "40f 跨度，EASE.out 分布", feelZh: "越来越快是\"一串\"的手感；等差分布读作逐张点名，<20f 读作一团一起冒" },
      { name: "入场行程", typical: "y 820→0，spring damping 13", feelZh: "起点必须在画框外；damping <10 回弹两次以上，成组时抖动互相干扰；再往大或往小调都会改变手感" },
      { name: "落座下压", typical: "5px，sin 9f", feelZh: "这是\"有分量\"的来源；>10px 整摞像弹簧床；再往大或往小调都会改变手感" },
      { name: "展开弹簧", typical: "damping 20 / stiffness 95", feelZh: "一次轻微过冲像手腕甩开；damping >26 无过冲读作机械展开，<16 扇面来回晃" },
      { name: "扇形张角", typical: "k*6.5°，横移 k*138px", feelZh: "角度与横移要同比调：只加角度不加横移，卡会互相穿插" },
      { name: "深度", typical: "tz = i*2，perspective 1800px", feelZh: "只做叠压的暗示；深度主要靠叠压次序 + 两层软阴影" },
      { name: "旋转轴", typical: "transform-origin: 50% 130%", feelZh: "调大或调小：130% 决定\"扇柄\"离卡多远；改成 50% 50% 立刻退化成风车式散开" },
      { name: "抽卡", typical: "72px overshoot + 描边 + 扫光", feelZh: "只给中心卡一次；抽出量 <40px 看不出\"被选中\"，>120px 卡与标题打架；再往大或往小调都会改变手感" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "两段时间窗刚好首尾相接：末张 42f 起跳、≈62f 落座，62f 预备、68f 展开。 加卡数或加大 stagger 会让入场吃进展开段，出现\"还在飞就开始转\"的浑浊——加卡必须 同步把预备与展开起点往后推；卡数为偶数时 k 取半整数（±0.5, ±1.5…），没有中心卡，结尾\"抽出主角\"会偏在一侧； demo 用 9 张。若改用\"中间压两边\"的 zIndex，要注意成摞→扇面时顶牌会跳变；卡片 320×440 以 left = CX-CW/2, top = CY-CH/2 居中，扇柄位置随 CH 变；改尺寸要同步检查 两端卡是否出安全边距（相机 0.88 时最外卡角距画边约 100px）；卡面是手搓的模板封面占位（生成式封面图 + 标题 + mono 元信息），落地应换成真实页面切片； 封面只用钴蓝 / 青绿 / 墨三色的浅色调，只有中心卡用钴蓝实色——真实素材里也要留一张「主角」；展开同段（64→106f）相机拉远到 0.88，保证两端卡不出画；要接下一镜可在抽卡落定（≈120f）后切，别让扇面白停太久",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(9px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 5s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 3D 环形轮播（上游  → ui-entrance）
  {
    id: "carousel-3d",
    category: "ui-entrance",
    nameZh: "3D 环形轮播",
    oneLineZh: "8 张卡排成圆环整环自转一圈（匀速底加每 45° 一次停靠），每卡只绕 Y 公转、自身 billboard 朝外，正前卡点亮、环下字幕换字。",
    useWhenZh: "作品集、模板库、集成清单的循环展示；需要无缝 loop 的背景拍或落地页 hero。",
    seconds: [4.03, 7.17],
    energy: "medium",
    tags: ["ui-entrance","UI 入场","carousel","3D 环形轮播"],
    intentZh: "排成一排横滑有起点和终点，环形天然循环；真正要解决的是环形 carousel 最容易翻车的卡片背面——双面同向贴图，任何时刻都正立不倒置。",
    motionZh: "环上定位只有一行：transform: rotateY(i*360/N) translateZ(RADIUS)，同时完成排布与 billboard（卡法向天然朝外）；正前方卡沿法向多推出 44px（只平移不旋转）读作被选中；整环自转靠父层 ring.transform=rotateY(−spin)，卡自身永不绕 X/Z 转；turn=0.5·f/168+0.5·stepPart(f)，每 21f 一步（8f 停靠+13f smooth 换位），8 步×21f=168f 正好一圈；front 与 back 用同一份卡面、back 额外 rotateY(180deg)、两层都设 backface-visibility hidden。",
    params: [
      { name: "卡数", typical: "N=8（方位角间隔 45°）", feelZh: "调大或调小：8 张在 700px 半径上前后互不遮挡；>12 张卡会互相压边，需要同步加大 RADIUS" },
      { name: "半径", typical: "RADIUS=700px（卡 340×460）", feelZh: "半径/卡宽 ≈2 是疏密甜点；<1.5 倍时环背面的卡从正面卡的缝里挤出来，画面变乱" },
      { name: "转速构成", typical: "50% 匀速 + 50% 分步（21f/步，停靠 8f）", feelZh: "分步比例 >70% 停靠时整环几乎停住，loop 读出\"卡顿\"；<30% 停靠感消失，又回到平的匀速；再往大或往小调都会改变手感" },
      { name: "圈数", typical: "全片 1 圈（8 步）", feelZh: "圈数与步数都必须是整数才能 loop；非整数则末帧跳变；再往大或往小调都会改变手感" },
      { name: "透视", typical: "perspective: 2200px", feelZh: "相对 700 半径是较平的透视；调到 1200 以下近处卡会夸张放大，读作鱼眼" },
      { name: "相机俯角", typical: "rotateX(-9deg)", feelZh: "只是\"略微俯视\"，刚好露出地面盘与刻度环；>-20° 环会压扁成椭圆；再往大或往小调都会改变手感" },
      { name: "点亮窗", typical: "方位角 ±26°", feelZh: "窗太宽相邻两张同时半亮，主角不明确；太窄换位途中整环全灰" },
      { name: "倒影", typical: "8% 透明度，62% 起渐隐", feelZh: ">15% 倒影里的文字可读，会和下方字幕打架；再往大或往小调都会改变手感" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。音效密度与画面节拍一致即可。",
    pitfallsZh: "稳态循环是这张卡的特性也是限制：它没有开头也没有结尾。分步停靠给了节拍，但当主镜用 仍偏平，适合当背景层、loop 素材或与前景文字/相机运动叠加使用；每帧都重设了 8 张卡的 transform（rotateY(i*45) translateZ(RADIUS + 44·hl)）——旋转分量恒定， 只有沿法向的外推随点亮变化。这让\"卡自身不参与旋转\"在代码里显式可见；不要把外推挂到旋转上；backface-visibility:hidden 在部分 WebKit 下需要 -webkit- 前缀（代码里已双写）。 漏掉前缀会看到两层 face 同时可见，卡片内容叠成一团；卡面是手搓的镜头配方卡占位（mono 编号 + 生成式图形 + 大数字 + 名称），落地要换成真实截图， 且 front/back 必须换成同一份内容，否则双面同向的前提被破坏；环转到背面时卡是\"背对观众的正面\"（看的是 back 层），所以内容始终可读——但也意味着 没有\"翻面揭示\"的余地。要做翻面必须放弃 backface-hidden 方案，另起一套",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(8px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 5.6s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 克隆纵深队列（上游  → ui-entrance）
  {
    id: "cloner-depth-echo",
    category: "ui-entrance",
    nameZh: "克隆纵深队列",
    oneLineZh: "主卡瞬间「复印」出 7 个半透明分身沿斜向纵深排开成队，停一拍后全体加速吸回本体合一并弹跳。",
    useWhenZh: "「多副本、多租户、规模感、批量处理」卖点；一镜讲完「一个=很多」。",
    seconds: [3.31, 5.89],
    energy: "medium",
    tags: ["ui-entrance","UI 入场","cloner","depth","echo","克隆纵深队列"],
    intentZh: "Cloner 语汇的 UI 翻译：一张主卡「啪」地复印出 7 个克隆体沿 Z 轴等距排开，先让观众数得清有很多个，再全体吸回合体，把「一个=很多」落到具体卖点上。",
    motionZh: "主卡复印出 7 个克隆体沿 Z 轴向后等距排开（间隔 250px、透明度 100%→28% 递减、越远越只剩轮廓），错峰弹出成纵队；停约 32f 让观众数清后，全体 ease-in 加速吸回本体合一，合体瞬间本体弹 1.06x 收束。",
    params: [
      { name: "纵深排布", typical: "真 3D 透视 perspective 1500，消失点放在左上（360,120）；克隆体 translateZ = −250·idx，再叠 dx=−58·idx / dy=−6·idx", feelZh: "命门：纯 translateZ 且消失点在正中时克隆体全被本体挡住（不可感）；把消失点挪到画面一角，后退本身就把纵队排向那一角；再往大或往小调都会改变手感" },
      { name: "克隆数/间隔", typical: "7 个 / 250px", feelZh: "少于 5 读不出\"队\"，多于 9 尾部糊成一团" },
      { name: "衰减", typical: "透明度 100%→28% 线性；填充褪掉只留强调色描边；越远附加 0→1.6px 景深虚化", feelZh: "越远越淡、越\"只剩轮廓\"=纵深证据；克隆体只留顶栏 + 折线 + 镜头号，别重复大读数（叠成一团乱码）" },
      { name: "排开/吸回", typical: "spring 错峰 2.2f/个（damping 15，一次轻过冲）；吸回强 ease-in 10f 全体同步，按纵深速度加拖影模糊", feelZh: "排开要错峰（复印感），吸回要同步（收束感）——节奏不对称是设计；再往大或往小调都会改变手感" },
      { name: "停留", typical: "32f，期间相机极缓推近 2% + 纵队轻微视差漂移", feelZh: "停太短数不清\"有很多个\"，完全静止又是死帧" },
      { name: "合体", typical: "主卡 sin 单脉冲 1.06x + 一次强调色描边光（14f 衰减）；同帧镜头位全亮、计数器回弹", feelZh: "吸回无弹跳读作淡出；弹跳=质量证据；再往大或往小调都会改变手感" },
      { name: "计数", typical: "左下 260px「×N」，每弹出一个克隆滚一格（5f，出场格上移淡出 + 速度竖向虚化）", feelZh: "计数让\"规模\"从画面变成数字；滚动格不要 overflow 裁切，会把泛光裁出方框；再往大或往小调都会改变手感" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 用手搓的 video-shotcraft 渲染卡（lime 暗场）调校——参数是调校起点非实战定稿， 首次实战须以真实素材回验；克隆体必须从后往前渲染保证遮挡正确；透明度 ≤0.005 条件卸载；同批 3D 渠道另两条（厚板转台淘汰、走廊改改再看）——纯陈列型 3D 运镜相性存疑，本卡过墙靠的是\"排开-吸回\"的叙事动作， 实战别退化成静态纵队陈列；声音：排开一串细\"啪\"错峰，吸回一声上扬 whoosh，合体一声实\"咚\"",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(3px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 4.6s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 发牌式卡片飞入（上游  → ui-entrance）
  {
    id: "deck-deal-flyin",
    category: "ui-entrance",
    nameZh: "发牌式卡片飞入",
    oneLineZh: "暗色石墨桌面上的实体牌堆特写环绕开局，一摞卡像发牌一样硬加速甩进网格，相机追着发牌升起后仰、落在满板跑道式俯瞰上定格。",
    useWhenZh: "展示「内容量大、源源不断汇入」的列表页与卡片墙；建立信息密度的第一印象。",
    seconds: [3.6, 6.4],
    energy: "high",
    tags: ["ui-entrance","UI 入场","deck","deal","flyin","发牌式卡片飞入"],
    intentZh: "先给悬念（这一摞是什么），再给答案（几十个项目自己飞进页面各就各位）；观众要感受到东西源源不断地涌进来，每张卡带着急迫感砸到位。",
    motionZh: "前半牌堆特写环绕、顶光只打牌堆，拉远时灯从牌堆以柔边光圈照亮页面板；预备拍只做段落级一次——首张出牌前牌堆整体下压 48px、顶卡向反方向回拉 30px（幅度必须过肉眼阈值），不逐卡加；26 张卡从牌堆按阅读序发向网格，第 k 张 cue=36+4k−0.0792·k(k−1)、出牌间隔从 4f 硬加速收缩到 0.2f；单卡飞行 8f（bezier(0.3,0,0.2,1)、z 弧顶 +110px、scale 峰值 1.06）+settle 4f（轻过冲）+press 0.996→1 回弹 2f；相机追发牌升起后仰、落在跑道式俯瞰，满板后静止 hold（>0.5s 只留 1.5% 极缓推近）；收尾各层拖拽错帧 2–4f：卡体先锁、阴影收敛滞后、残影最后消散。",
    params: [
      { name: "orbit 环绕", typical: "相机关键帧走单调三次 Hermite 样条逐帧展开（关键帧处速度连续，无顿挫）。帧 0→30，rotX 48/rotY −30/rotZ 9/zoom 1.9 绕到 rotX 42/rotY 24/rotZ −6/zoom 1.8，persp 1100", feelZh: "特写四件套缺一不可：侧面倾斜角+可感知高度+orbit+反差深色材质（Q7，用户逐项点名）" },
      { name: "堆叠高度", typical: "STACK_STEP=3px 物理层高 × 26 张 → 顶卡 z≈78px；姿态抖动 px/py 按 (((k*7)%9)−4)*2 确定性公式 ±8px、rotZ ±3°", feelZh: "抖动必须确定性伪随机（硬规则：渲染必须可复现），真随机会渲染间抖动；再往大或往小调都会改变手感" },
      { name: "石墨桌面", typical: "4 层叠加：随拉远扩大的顶光 radial + 104deg 宽幅镜面高光带 + 确定性 feTurbulence 各向异性拉丝纹小图平铺（baseFrequency 0.0018×0.62，alpha 0.4）+ 115deg 冷灰渐变；平面向外扩 4000px、远处柔边隐进暗场。页面板（截图内容区 x 352–1568 + 纸面延长）开场被 0.88 …", feelZh: "别再整层淡出金属换成全屏白纸——暗/亮反差是这镜的质感来源；拉丝纹在 0.5x 俯瞰下对比要压低，否则出摩尔纹" },
      { name: "预备拍", typical: "首发 cue 前 10f（26→36）：牌堆整体下压 48px（约堆高六成）+ 顶卡向出牌反方向回拉 30px，缓动 easeOut，首发瞬间释放", feelZh: "幅度必须过肉眼阈值：4px/2px 初版用户实测完全无感，放大 12 倍（48/30px）才裁决通过（判例 2026-07-09 进化轮 #2）——渲染后自查\"不逐帧能否看出蓄力\"，看不出等于没做；帧预算从 orbit 尾段挪，不挤占发牌段" },
      { name: "发牌节拍", typical: "第 k 张 cue = 36 + 4k − 0.0792·k(k−1)，间隔 4f 收缩到 0.2f", feelZh: "均匀间隔立刻显得机械；匀加速不够狠也被否——要\"hard-accelerating\"级别（R2/B3）" },
      { name: "卡量", typical: "10 真卡 + 16 extras = 26 张；网格向下扩 5 行、纸面延长 2036px", feelZh: "卡不够多涌入感不成立——宁多勿少；extras 落进真实扩展格位，不悬浮（Q9）" },
      { name: "单卡飞行", typical: "deal 8f（bezier(0.3,0,0.2,1)，z 弧顶 +110px sin、scale 峰值 1.06）+ settle 4f（bezier(0.3,0,0.25,1.15) 轻过冲）+ press 0.996→1 回弹 2f", feelZh: "落地要弹必须 y1>1 的 bezier；settle+press 合计 6f ≈ 飞行 8f 的 30%——快停配足缓冲（法则 5 比例）；落定后强制 identity transform 防斜板亚像素漂移" },
      { name: "收尾拖拽层级", typical: "rest 段内分层停稳：卡体 press 回弹结束即锁定，落地阴影 0 32px→0 2px 收敛滞后卡体 2–4f，飞行残影 opacity 尾梢再拖 3–5f 消散", feelZh: "借鉴法则 5 的 drag hierarchy（根→主→次级错帧 2–4f）；0.5s rest 静止判例不变——层级错帧发生在 rest 段头部，rest 末端全部锁死（模式已沉为 assets/lib/helpers/motion.ts lagged）；再往大或往小调都会改变手感" },
      { name: "运动模糊（单卡）", typical: "飞行中 5% 路径滞后 blur(6px) 残影，opacity 0.25·(1−t)", feelZh: "ghost 残影比真 motion blur 便宜且够用——单卡层面维持此方案；再往大或往小调都会改变手感" },
      { name: "运动模糊（相机）", typical: "追逐 scroll 等 ≥30px/f 的快速运镜段用 @remotion/motion-blur 的 <CameraMotionBlur shutterAngle={180} samples={10}> 包镜；用 <Sequence> 把包裹范围切到快速段起点，慢速特写段（<10px/f）不包", feelZh: "调大或调小：30fps 下相机每帧跳 50–70px 会频闪，快摇拖影是电影摄像机的物理本能；shutterAngle 越大拖影越长（>270 发糊），samples 按渲染预算调（每 +1 约 +1 倍渲染时间）；整镜全包会把慢速 orbit 段的 1px 级细纹理（拉丝金属）采样抹软——只包快速段；借鉴 Remotion 官方生态非用户判例（2026-07-11 进化轮 #8）" },
      { name: "追逐 + 升起", typical: "锚点 f62 正视板顶（zoom 0.8，rotX 22）→ f86 板中（zoom 0.56，rotX 38，rotZ −10）→ f110 跑道俯瞰（zoom 0.5，rotX 52，rotY −6，rotZ −26，persp 3300，屏幕右移 300px 给左下标语让位）→ f150 zoom 0.508", feelZh: "persp 要随后仰同步加大（1100→3300），否则近端越过相机平面穿帮；满板后静止是用户逐字要求（R2），hold 只许极缓推近" },
    ],
    soundZh: "orbit 拉远+首批发牌钉 whoosh-big（模板片钉在 f308），发牌加速段钉 whoosh-fast（f340/356）。连发落位音防机枪感三招：双样本交替、音量阶梯递减、间隔跟随动画曲线加速——密到糊成一片时让声音淡出成一条 swoosh，不逐卡配音（S2）。",
    pitfallsZh: "抽象 flood 式多轮不收敛，换\"发牌\"物理隐喻一轮通过（R2/B3）——群体运动先找物理隐喻再写代码；卡纹理必须真实页面元素切片（Q1），手搓假卡一眼假；extras 复用真卡切片错位摆放；全部同时飞读作爆炸，错峰递加速是灵魂；前半 orbit 若砍掉，发牌起点要另给\"牌堆从哪来\"的交代；anticipation/follow-through 手法借鉴自迪士尼 12 法则（pixel2motion skill 内置提炼版）；预备拍幅度已有用户判例（2026-07-09：\"OK能看出来了\"，此前两档小幅度均无感）；拖拽层级错帧仍是默认建议——与 R2 判例冲突时（如用户要求更快更硬）判例优先；教科书比例（预备 = 主动作 20–30%）在拉远机位下产出的像素位移过小——先算像素再算比例，宣传片观众看的是全景不是特写",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(3px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 5s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 文档驻留·药丸发牌（上游  → ui-entrance）
  {
    id: "doc-park-left-pill-deal",
    category: "ui-entrance",
    nameZh: "文档驻留·药丸发牌",
    oneLineZh: "文档向左滑出只露约 35% 宽并微缩，右侧按旁白节奏慢速发牌三张白底描边药丸，左侧文档全程极缓慢自动滚动保持「正在被读」。",
    useWhenZh: "旁白驱动的「分析结论逐条给出」段落；文档理解、推荐理由、审阅意见类产品的核心说明镜头。",
    seconds: [4.18, 7.42],
    energy: "low",
    tags: ["ui-entrance","UI 入场","doc","park","left","pill"],
    intentZh: "结论要一条一条给，但来源文档不能淡出——让来源留在画面里（还在缓慢滚动，说明正在被读），右侧每条结论都是从这份文档里长出来的。",
    motionZh: "驻留不是淡出：seg(t,0.06,0.24,E.inOutCubic) 驱动 translateX(0→−55%) scale(1→0.92)，transform-origin 0% 50% 让缩放以左边缘为锚，最终只露约 35% 宽；常驻自动滚动 translateY(−t*120) 连续匀速（约 0.7px/f），不用取模回跳；三张药丸起点写死 T0=[0.26,0.48,0.70]（间隔约 38f/1.27s，是一句短旁白的长度）；每张两条曲线并行：o=seg(t,f,f+0.035,E.outQuad) 管透明度（约 6f），b=seg(t,f,f+0.062,E.outBack) 管 translateY(14→0)+scale(0.94→1)（约 11f 带过冲）——先看见、再落定。",
    params: [
      { name: "发牌起点", typical: "T0 = [0.26, 0.48, 0.70]，间隔 0.22（≈38f）", feelZh: "间隔就是旁白句长；压到 0.12 以下字幕的\"逐词加深\"来不及走完，读作字幕闪一下就没了" },
      { name: "驻留窗", typical: "0.06→0.24（inOutCubic）", feelZh: "必须在首张药丸（0.26）之前收住；重叠会出现\"文档还在滑、药丸已在发\"的浑浊" },
      { name: "驻留幅度", typical: "translateX -55% + scale 0.92，露约 35%", feelZh: "露太少（<25%）文档变成装饰失去\"来源\"语义；露太多右侧放不下 172px 宽的药丸" },
      { name: "药丸透明度窗", typical: "0.035（≈6f，outQuad）", feelZh: "比位移窗短是有意的——先实后稳；两窗等长会读作普通淡入" },
      { name: "药丸位移窗", typical: "0.062（≈11f，outBack），y 14→0、scale 0.94→1", feelZh: "outBack 的过冲是\"发牌落桌\"的手感；换 outCubic 会变成平淡的浮上来；再往大或往小调都会改变手感" },
      { name: "字幕延迟", typical: "cs = f + 0.05（≈9f）", feelZh: "药丸落定（0.062）之后才起字幕；提前会出现字幕先于结论出现" },
      { name: "字幕加深行程", typical: "(ce-cs)*0.7", feelZh: "占该句可见时长的 70%，末 30% 是全实态的静置阅读时间；调到 1.0 则字幕刚读完就被淡出" },
      { name: "自动滚动", typical: "-t × 120px 连续匀速", feelZh: "调大或调小：5.8s 上约 0.7px/f，是\"正在读\"的暗示级速度；>3px/f 会抢注意力变成滚动展示" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "自动滚动是连续位移而非取模循环（取模只有在内容本身严格周期时才不回跳）；改时长或 行程时要保证文档内容比容器长出至少整段行程，否则末段会滚出空白；末张字幕的 ce = 0.98 意味着它在 0.93→0.98 淡出，末帧只剩三张药丸没有字幕。若要 末句留到底，把末张的 ce 改成 >1 并去掉 out；药丸位置写死为 left:214px, top:54+k*48、宽 172px，是 480 宽画布下与驻留后文档 （露出约 87px）配套的一组数字。改文档驻留幅度必须同步改 PX，否则两者重叠；三条药丸文案（demo 里是 video-shotcraft 宣传片简报推荐的三张镜头卡 Crash Zoom / Deck Deal / Logo Sting）与三句字幕都是示意，且字幕 长度直接影响\"逐词加深\"读起来快慢——换真实文案后要按新句长重调 inn 行程；药丸数写死为 3（T0 的长度）。加到 4 条时间就不够：末张起点会超过 0.9，字幕根本 走不完；4 条以上应考虑缩短单句而不是硬塞",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(0px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 5.8s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 描边生长圈注（上游  → ui-entrance）
  {
    id: "draw-svg-trace",
    category: "ui-entrance",
    nameZh: "描边生长圈注",
    oneLineZh: "一条带笔头的墨线沿元素轮廓跑一圈把它「画」出来，闭合瞬间闪黑交棒、内容淡入；同一套路还能给标题画下划线。",
    useWhenZh: "单个卡片、图表、标题的被点名入场；元素级手法；标题下划线生长的短版也用它。",
    seconds: [3.17, 5.63],
    energy: "medium",
    tags: ["ui-entrance","UI 入场","typography","draw","svg","trace"],
    intentZh: "「画出来」是纸墨审美里最顺手的入场隐喻：元素不是飞进来也不是淡进来，而是被一支看不见的笔当场描出来，笔头可见、方向可读。",
    motionZh: "SVG rect/path 设 pathLength=1、strokeDasharray=1、dashoffset 1→0（40f Easing.inOut(cubic)），免测周长；同一路径再叠三段渐细短 dash 作笔头（0.04/6.4px→0.024/8px→0.011/9.6px），dashoffset=笔头长−p 天然跑在最前，另加按圆角矩形弧长精确定位的实心笔尖带落影；开场 0–12f 四角先长出裁切标记（错峰 2f）与中心清晰的绘图纸点阵；闭合 50–52f 描边冲纯黑并加粗 6→11px、52–58f out 回落；标题下划线版 18f 短版。",
    params: [
      { name: "描边速度", typical: "一整圈 40f（10→50f，inOut cubic 起收有呼吸）", feelZh: "<28f 读不出\"在画\"，>60f 读作加载中" },
      { name: "主线 / 笔头", typical: "主线 6px；笔头三段渐细最粗 9.6px、笔尖 r 7.5", feelZh: "笔头≤主线粗细就消失在主线里；再往大或往小调都会改变手感" },
      { name: "闭合闪", typical: "2f 冲黑 + 加粗到 11px，6f 回落", feelZh: "没有这一下，\"画完\"没有句号；再往大或往小调都会改变手感" },
      { name: "主体尺寸", typical: "1120×660、圆角 28（描边 rx 同值）", feelZh: "主体占画宽 ~58%，描边一圈才有\"画了一个大东西\"的分量；描边 rx 必须等于卡片圆角" },
      { name: "下划线版", typical: "18f out cubic 单向生长，12px 朱红、路径带 ±5px 手绘弧度，画完常驻", feelZh: "用在单个重点词；一屏 ≥2 条读作装饰线" },
      { name: "收尾", typical: "交棒完成后 hold 40f（92→132f），只留 0.9% 极缓推近", feelZh: "手感：交棒完成后 hold 40f（92→132f），只留 0.9% 极缓推近 只是起点，再往大或往小调都会改变节奏与力度" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 用手搓的 video-shotcraft 渲染报告卡（paper 纸墨 look，「Cuts on the beat / 100%」+ 逐镜头能量柱 + 标志字标署名）调校——参数是调校起点非实战定稿， 首次实战须以真实素材回验；与 wall-reveal-moves B 式（整页蓝图描线）同族互斥：同片二选一， 都上读作重复报幕；描边路径必须与元素真实轮廓吻合（圆角 rx 一致）——线画的是 14px 圆角、元素是 8px，交棒瞬间错型穿帮；真实素材上内容淡入别抢在闭合前：线还没画完内容先出来，\"画\"的 因果就断了；一次点名画一个主体；同屏多元素排队各画一圈读作加载动画",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(40px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 4.4s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 接触阴影离面抬升（上游  → ui-entrance）
  {
    id: "element-body-moves",
    category: "ui-entrance",
    nameZh: "接触阴影离面抬升",
    oneLineZh: "卡片抬起时正下方的接触阴影同步放大、变虚、变淡并向背光侧偏移——纸片离桌被阴影证明。",
    useWhenZh: "给「位置在变」之外补「身体在变」：卡片点名给悬浮证据；配 2.5D 运镜与逐张点名。",
    seconds: [3.6, 6.4],
    energy: "low",
    tags: ["ui-entrance","UI 入场","element","body","moves","接触阴影离面抬升"],
    intentZh: "库内运动卡都在管位置，这一式管身体：给悬浮一个可信的物理证据——阴影同步变化；快门拖影是相机的事，离面抬升是身体的事。",
    motionZh: "斜俯拍桌面（rotateX 24°→20°）上卡沿法线 translateZ 96px + scale 1.05；阴影是躺在桌面 z=0 的两层独立实体（接触核+环境影），随抬升变大、变虚、变淡并向背光侧偏移；点名卡落回用 8f in-cubic + 2。",
    params: [
      { name: "A 抬升幅度", typical: "2D：−28px + scale 1.08；2.5D 斜俯拍：translateZ 96px + scale 1.05（屏幕可见位移 40–50px）", feelZh: "判例锁死：屏幕可见位移 <12px 禁用（见已知坑）；再往大或往小调都会改变手感" },
      { name: "A 阴影", typical: "独立 div（2D 用椭圆径向渐变；2.5D 用与卡同形的圆角矩形 + blur）：接触核 α 0.32→0.14、blur 3→25px；环境影 α 0.09→0.22、blur 14→54px、向右下偏移；卡本体不带外阴影", feelZh: "box-shadow 跟卡走，给不出\"影子留在桌上\"；再往大或往小调都会改变手感" },
      { name: "A 落地", typical: "scale 0.99 卡壳 2f 再 5f 回弹到 1", feelZh: "无微压读作飘落，没有重量" },
      { name: "收尾", typical: "末张选定后悬停 ~50f", feelZh: "若要循环，把末张改成同样落回；再往大或往小调都会改变手感" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；A 微幅加码判例：原案 8px 抬升不可感，加码到 28px 才过——实战禁回调到 12px 以下，宁可不用不可用弱；A 一次只抬一张——两张同时离桌，观众找不到被点名的是谁（P4）；声音：抬起轻吸/落回轻放（sound-design §4.5）",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(2px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 5s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 快翻中枢接入（上游  → ui-entrance）
  {
    id: "integration-hub-map",
    category: "ui-entrance",
    nameZh: "快翻中枢接入",
    oneLineZh: "旧页面一次性完整快翻 180° 落成新中枢页，五个集成图标同帧弹现、五条彩虹光管同帧齐连，光管内输送脉冲持续流动。",
    useWhenZh: "集成/生态能力段（一个产品连一切）；版本翻新叙事（旧页翻成新页）；暗场霓虹调性的功能高潮。",
    seconds: [0.5, 5],
    energy: "high",
    tags: ["ui-entrance","UI 入场","effects","integration","hub","map"],
    intentZh: "翻面是「换时代」：必须是完整翻面而不是转个角度，快翻加尾段减速一口气完成；接入是两拍制——图标齐现（第一拍）、光管齐连（第二拍），齐才读作「生态一次到位」。",
    motionZh: "rotateY 0→180° 共 35f，Easing.out(cubic)（前 41% 时间完成 80% 角度、尾段长减速缓着陆），双面卡正面旧页/背面新页；约 90° 侧棱时刻 2f bloom 脉冲（0→1→0.25→0，4f 内归零）；五图标在翻面落定+3f 同帧弹现，+10f 五管同帧起画、9f 齐长全亮；输送脉冲沿图标→中枢方向循环（约 4.6px/f，各管相位错开），全连通后中枢页轻呼吸。",
    params: [
      { name: "翻面时长", typical: "35f（曾 70f 被裁\"再快1倍\"）", feelZh: "<24f 读不出双面；尾段减速比例 ~60% 时间走 20% 角度" },
      { name: "翻面曲线", typical: "ease-out 单调无停顿", feelZh: "侧棱停顿/分段被裁；严格 linear 起停生硬也被裁——快翻尾缓" },
      { name: "侧棱闪", typical: "2f 脉冲、4f 归零", feelZh: "长光晕平台被裁\"闪一下就行\"" },
      { name: "接入节奏", typical: "两拍制：图标同帧 → +10f 光管同帧", feelZh: "错峰逐连两轮被裁\"同时出现，然后同时连接\"；两拍间隔 <6f 读作一拍；再往大或往小调都会改变手感" },
      { name: "光管生长", typical: "9f 齐长", feelZh: "调大或调小：18f 版偏慢；各管长度不同但同帧到达（按各自 len 归一）" },
      { name: "输送脉冲", typical: "~4.6px/f 循环、相位错开", feelZh: "静态连线=没有\"输送的感觉\"（判例）；同相位读作闪烁；再往大或往小调都会改变手感" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；时序判例链完整记录在案：错峰连入 ×2 被裁 → 管齐图标错峰被裁 → 两拍制过关。\"同时\"是这张卡的节奏身份；与 glow-flyline-moves 分工：那张是飞线本身的光效戏；本卡是 翻面+两拍接入+输送的叙事结构，光管只是元素；与 canvas-materialize-moves 分工：那张是画布元素实体化；本卡 核心是\"旧页翻成新页\"的换代语义；双面卡实现：水平/垂直线 bbox=0 会使 SVG filter/渐变失效（三管 消失判例），管线渐变用 userSpaceOnUse 每管独立定义",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(35px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 2.75s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.28s)}",
    },
  },
  // 列表逐项找位（上游  → ui-entrance）
  {
    id: "list-reveal",
    category: "ui-entrance",
    nameZh: "列表逐项找位",
    oneLineZh: "垂直菜单 6 项按 10f 间隔依次 scale 找位、软 back 轻微过冲落定，同时整个列表容器全程匀速上移——两层运动互不相干。",
    useWhenZh: "导航、侧边栏、设置面板的入场；任何「界面自己长出来」的 UI 段落；旁白铺垫时的低能量底。",
    seconds: [2.88, 5.12],
    energy: "low",
    tags: ["ui-entrance","UI 入场","list","reveal","列表逐项找位"],
    intentZh: "逐项淡入最容易死板：每项动完就停，画面在两项之间完全静止；解法是给容器加一层与逐项无关的慢速漂移——局部在「找位」、整体在「呼吸」。",
    motionZh: "两层完全解耦：容器 translateY(DRIFT/2−DRIFT·f/(N−1)) 只吃全局帧、匀速漂移（1920 坐标下总 96px，约 0.8px/f）；每项只吃自己的局部窗口，起点 2+i·10f、窗口 24f（窗口是 stagger 的 2.4 倍，相邻 2–3 项同时在动）；找位以 scale 主导（0.82→1 + translateY 44→0 + blur 8→0），软过冲 bezier(0.3,1.18,0.5,1) 约 1.5%——把落位那一帧从「停」变成「扣住」。",
    params: [
      { name: "项数", typical: "6（Home…Sign out）", feelZh: "末项 52f 起、76f 落定，尾部留 ~44f 给观众收尾；>8 项必须压 stagger，否则末项吃到收尾；再往大或往小调都会改变手感" },
      { name: "stagger", typical: "10f/项", feelZh: "调大或调小：10f 是\"逐项读得完\"；压到 4f 变成一次铺开（另一种手法），拉到 16f 以上节拍会散；再往大或往小调都会改变手感" },
      { name: "单项窗口", typical: "24f", feelZh: "窗口比 stagger 长 2.4 倍 → 相邻项重叠；两者相等会变成一项一项硬接" },
      { name: "起始 scale", typical: "0.82", feelZh: "\"已经能认出是个条目\"的尺度；<0.5 读作从零弹出，和 pop 类手法混淆；再往大或往小调都会改变手感" },
      { name: "起始位移 / 模糊", typical: "44px / 8px", feelZh: "位移必须小于行距（92px 行高 + 14px 间距），否则项与项之间穿插" },
      { name: "过冲", typical: "软 back ~1.5%", feelZh: "要小到几乎读不出来；换 spring 或加大过冲，6 项连续抖会显得廉价" },
      { name: "容器漂移", typical: "全程匀速 96px（≈0.8px/f）", feelZh: "总量是单项位移的 2 倍、速度慢一个数量级——读作\"画面在呼吸\"；速度接近单项入场速度时两层运动混为一件事" },
      { name: "透明度斜率", typical: "min(1, lin·2.2)", feelZh: "降到 1 会看到半透明项叠在背景上，暗场下尤其脏" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。这一段是呼吸位，音效要少而轻，把空间留给旁白。",
    pitfallsZh: "容器漂移是匀速且贯穿全程，末帧停在 −48px 而不是 0——这个动效末帧不回位。 要循环播放或与后一镜对齐位置，得把漂移换成收束曲线，或在末段补一个反向缓收；项数变化必须重算 stagger：末项起点 2 + (n−1)·10f，再加 24f 窗口，要给收尾留 ≥30f；行宽 700px、标签 nowrap——中文或更长的英文标签会顶到右侧快捷键，换文案要同步加宽； 列表总高 ~644px，加项前先算漂移后首末项是否仍在安全区内（demo 漂移范围 y 188–928）；漂移方向（向上）与逐项位移方向（44px→0，也是向上）同向。这是有意的（同向叠加更顺）， 但两者速度量级必须保持一个数量级差距，否则读作\"一起往上飘\"而非两层；右侧标题要等列表铺到一半（46f）才进：开场只给列表一个主角（Q5），不然观众在两处之间来回找",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(6px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 4s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 列表堆叠压感（上游  → ui-entrance）
  {
    id: "list-stack-press",
    category: "ui-entrance",
    nameZh: "列表堆叠压感",
    oneLineZh: "列表卡从画面底部逐张飞上摞起，每张落地压弹整摞、计数器同步跳一格。",
    useWhenZh: "feed、雷达、收件箱类「每天有新东西」的镜头；强调持续积累的资产列表。",
    seconds: [2.16, 3.84],
    energy: "medium",
    tags: ["ui-entrance","UI 入场","list","stack","press","列表堆叠压感"],
    intentZh: "「堆叠有重量」：每张新卡落上来，已落定的整摞被压下再弹回，观众从物理反馈里读出「这是实打实攒下来的东西」；计数器同步跳格把数量感钉死。",
    motionZh: "首张升入前给一拍段落级预备：计数器先于首卡 4–6f 亮起归零并 scale 0.96→1，把视线引到堆叠区；卡从画面下方升入、交替微倾收平、等距节拍逐张摞起；每张到场压下整摞 6px、8f 弹回（stackPress 脉冲），把新卡动能传给整摞再缓冲耗散；落地后按拖拽层级依次收尾：卡体先停→整摞弹回→高亮条再长出（滞后 2–4f）。",
    params: [
      { name: "节拍", typical: "CUES=[18,30,42,54,66]（12f 等距），每张飞 22f，bezier(0.45,0.05,0.25,1.12) 末端过冲", feelZh: "少量卡（5 张）可以等距；大批量入场才需要递加速（对照 deck-deal 的 R2）" },
      { name: "入场", typical: "从下方 600px 升入，交替 ±2° tilt 收平，scale 1.06→1", feelZh: "交替倾斜打破对称；同向倾斜读作复制粘贴；再往大或往小调都会改变手感" },
      { name: "堆叠压感", typical: "后一张到场时整摞压下 6px、8f 弹回（脉冲 [cue,cue+4,cue+8]→[0,6,0]）", feelZh: "这是\"有重量\"的关键一笔，砍掉后堆叠变成简单排版" },
      { name: "阴影", typical: "两层 softShadow 随离地高度变化：空中 elevation≈56、落定 3（被压时更贴地）；飞行段按速度加纵向运动模糊", feelZh: "阴影随高度收敛，和 deck-deal/spotlight 同一套语言" },
      { name: "联动高亮", typical: "落地后滞后 2–4f 在项目名那一行（截图实测卡内 y156–176）长出与项目名等宽的强调色（模板片为琥珀）荧光笔底色，multiply 叠在字下（7f 长 + 5f 淡）；最后一张离切点仅 ~12f，压到 5f 长 + 4f 淡", feelZh: "高亮是次级动作（法则 5/8）：在主动作（落地压弹）之后跟进，不与之同帧抢戏；末尾元素的节拍要按剩余帧预算压缩，不能照抄前面的" },
      { name: "glaze 扫光", typical: "360px 宽、rotate 14°、mixBlendMode soft-light，最后一张落定后帧 74→87 从 −500 扫到 2300，裁进每张卡的圆角内", feelZh: "扫光全镜头只此一次、扫整摞不逐卡（Q4）；再往大或往小调都会改变手感" },
      { name: "计数器（digit-roll 手法）", typical: "连续里程计位置 pos：每张卡落地让 pos 沿数字带 +1 格，单格 8f 滚定，bezier(0.25,0.8,0.25,1)；滚动量=pos·lineH 沿双份 0-9 带连续下滚", feelZh: "计数与落地不同步立刻穿帮；单格滚动必须短于落卡间距（12f）且尾格在镜头收尾前滚定——以 count 为 key 重挂重滚的写法每次都要从 0 滚 22f，12f 节拍下前一次永远滚不完、尾帧停在 4（PR #40 判例）；数字带双份拼接+overflow hidden+tabular-nums（不开 tabular 会横向抖）" },
      { name: "相机", typical: "zoom 1.35→0.86 一条连续曲线跟随堆叠向下（逐帧喂给 PageCam2D，避免分段关键帧处速度归零）", feelZh: "正视机位（见已知坑），相机只做纵向跟随；再往大或往小调都会改变手感" },
    ],
    soundZh: "每张落地不逐张配长音；计数落定钉 click-camera（模板片钉在 f648）、段落切入钉 transition-soft（f623）。若逐张配 pop 参照 S2 三招防机枪。",
    pitfallsZh: "堆叠/列表信息镜头必须正视（Q6）——全片倾斜化时本镜头曾被单独回滚回正视；风格化机位逐镜头验证，不全局套用；逐卡 glint 高亮扫过被否两次（Q4），高亮用静态强调色底色条即可，动感交给压弹；与 history-list-stack（document-typewriter-reveal 卡尾段）是同一动作词汇——全片同一手法只当一次主角（P4），两处并用时一处必须降为配角；anticipation/拖拽层级参数借鉴自迪士尼 12 法则（pixel2motion skill 内置提炼版），非用户判例——是默认建议不是令；与判例冲突时判例优先；预备动作幅度必须过肉眼阈值（deck-deal 判例 2026-07-09：小幅度用户完全无感，放大 12 倍才通过）——渲染后自查\"不逐帧能否看出蓄力\"",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(18px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 3s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 霓虹框先行（上游  → ui-entrance）
  {
    id: "neon-frame-forerun",
    category: "ui-entrance",
    nameZh: "霓虹框先行",
    oneLineZh: "强透视直角霓虹框自左缘两头奔画先成型，页面在框内由暗转亮，组件从 3D 上空带同形软影错峰贴落，背景霓虹群终段熄灭让位。",
    useWhenZh: "暗场品牌片里给 UI 面板做「登场仪式」（框先到、内容后落）；功能区首次亮相；霓虹或赛博调性的段落开场。",
    seconds: [0.7, 4.7],
    energy: "high",
    tags: ["ui-entrance","UI 入场","effects","neon","frame","forerun"],
    intentZh: "先立框后填肉：霓虹线框像跑道灯一样圈出位置、宣告「这里要出现东西」，页面在框内由暗转亮的同时组件从空中带影贴落——观众看见界面被「安放」进框里。",
    motionZh: "强透视直角框自左缘中点两颗白热亮头上下分头奔画（20f，swift 起步快、右缘中点制动相撞并闪一下），灯管用四层描边叠辉光（宽软晕/中晕/色芯/白热芯），不用模糊滤镜；框合拢后页面才从黑里浮出（16–30f）、再由暗转亮（24–84f smooth），冷紫暗罩自左缘向右退去；真 3D 悬空组件 translateZ 120–170px，面板上落同形剪影软影（越高越大越虚越淡、偏向右下），每件 24f，亮度用叶子节点 brightness（不在 3D 父级加 filter/opacity，会把 3D 压平）；背景同框 5 层纵深回声组成霓虹隧道，框合拢后由近到远逐层打火，终段中段先熄、两端后熄（94–118f）。",
    params: [
      { name: "框奔画", typical: "20f 两头对奔（swift）", feelZh: "单头描画读作画图；>30f 观众等不及内容；再往大或往小调都会改变手感" },
      { name: "悬浮高度", typical: "translateZ 120–170px、影随高度收敛", feelZh: "判例：高度过小+启动过早=影子不可感（v3 第 1 轮返工加大 1.7x 并延后）" },
      { name: "贴落窗口", typical: "每件 24f；落点 54→104f，比点亮晚 ~20f 收尾", feelZh: "贴落先于点亮完＝黑屋子里落家具；滞后太多读作两段戏" },
      { name: "错峰", typical: "错开起点、下落重叠并行（EASE.out 分布，先密后疏）", feelZh: "串行等待被裁（掉落节奏通用判例）；再往大或往小调都会改变手感" },
      { name: "背景熄灭", typical: "中亮尾熄，每层 6f 闪烁熄灭、层间隔 7f", feelZh: "不熄灭主角不突出；同帧全熄读作断电；再往大或往小调都会改变手感" },
      { name: "贴落粒度", typical: "卡/行级（品牌、4 项导航、问候、3 张数字卡、4 行任务）", feelZh: "粒度越细越贵；元素越少每件越大越好读" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；悬空贴落=clickup 语言核心签名（已验证的口味信号），本卡 与 graze-face-tour 共用 FloatWrap 模式——影子不可感等于没做；与 brand-frame-snap 分工：那张是品牌框咔哒定位的 节拍戏；本卡是框先行+内容贴落的登场仪式，框只是序幕；衍生方向备忘：视角旋转变体（镜头左→右弧线旋转+同时贴落） 曾被裁\"改改再看\"（要求所有组件同时贴落），已收敛进 neon-frame-orbit-drop 卡",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(20px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 2.7s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.27s)}",
    },
  },
  // 霓虹框绕行贴落（上游  → ui-entrance）
  {
    id: "neon-frame-orbit-drop",
    category: "ui-entrance",
    nameZh: "霓虹框绕行贴落",
    oneLineZh: "霓虹框描框后镜头绕页面左→右弧线旋转，页面全部组件与文字同帧从空中贴落、同形软影同步收敛。",
    useWhenZh: "单页 UI 的一次性隆重登场（与巡礼、逐区亮相相对）；暗场霓虹调性段落的主视觉揭幕。",
    seconds: [0.5, 4.7],
    energy: "high",
    tags: ["ui-entrance","UI 入场","effects","camera","neon","frame"],
    intentZh: "整体登场式的框内安放：命门是同时贴合——所有组件和文字同帧起落、同帧贴合、软影同步消失；错峰贴落属于巡礼镜，一页一次性亮相必须齐。",
    motionZh: "霓虹描框约 14f 奔画成型；视角弧线 rotateY +38°→−26° 连续弧线（透视原点 30%→64% 随动，近似相机环绕）贯穿全片；全部元素统一 LAND 时刻（归一化约 0.52）——同帧离地悬空、同帧空中下降、同帧贴合，FloatWrap 同形软影（blur/offset/opacity 随高度）全体同步收敛；背景霓虹管框群衬场，主面板落定后让位。",
    params: [
      { name: "贴落同时性", typical: "全元素同帧起落（零错峰）", feelZh: "命门；任何错峰都会读成巡礼语法（判例裁决原话见上）；再往大或往小调都会改变手感" },
      { name: "视角弧线", typical: "rotateY +38°→-26°、透视原点随动", feelZh: "弧度小读作抖动；只转不落=空转" },
      { name: "旋转×贴落耦合", typical: "贴落窗口居中于旋转行程", feelZh: "旋转完才落=两段戏；落完还在转=收不了尾；再往大或往小调都会改变手感" },
      { name: "悬浮高度/软影", typical: "同 graze-face-tour（100–180px、影随高度）", feelZh: "影不可感=没做（累计判例）；再往大或往小调都会改变手感" },
      { name: "描框", typical: "~14f 奔画", feelZh: "同 neon-frame-forerun；再往大或往小调都会改变手感" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "参数经占位素材两轮调校通过，非实战定稿，首次实战须以真实素材回验；贴落节奏语义判例（本卡与 graze-face-tour 互为反例）： 巡礼镜=错开起点+重叠并行下落；整体登场镜=全体同帧。选错语法 两边都会被裁；与 neon-frame-forerun 分工：那张镜头固定、错峰贴落+页面点亮 三层咬合；本卡镜头旋转+同帧齐落。同段落二选一，别连用（同框 语言重复）；弧线旋转是透视原点近似而非真实 3D 相机环绕，极端角度下框辉光 形变略平——实战若需大角度环绕考虑真 3D 场景",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(38px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 2.6s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.26s)}",
    },
  },
  // 页面瀑布墙（上游  → ui-entrance）
  {
    id: "page-waterfall-wall",
    category: "ui-entrance",
    nameZh: "页面瀑布墙",
    oneLineZh: "真实页面截图切成 3–4 列在 3D 后仰墙面上差速反向无限滚动，视差加镜头缓推做「内容多到流不完」的一览。",
    useWhenZh: "「多页面、多功能、多模板」体量感段落；montage 中段铺陈或 intro 后的产品广度镜头。",
    seconds: [4.32, 7.68],
    energy: "medium",
    tags: ["ui-entrance","UI 入场","page","waterfall","wall","页面瀑布墙"],
    intentZh: "流动式一览：让观众在几秒内看到很多页面流过，读感是体量而非细节；与聚拢式一览分工——那个语义是「属于同一产品」，这个是「还有很多没给你看完」。",
    motionZh: "父层 perspective(1000px) rotateX(20°) scale(1.2) 后仰成墙；每列 [...items,...items] 翻倍 + progress 取模 translateY 0→−50% 无缝循环；差速反向是视差命门：3 列 loop 时长错开（如 12/9/14s）、中列反向，等速同向读作一张大图在滚；镜头缓推寄生在外层（scale 1→1.06 线性铺满全镜），墙自身循环、镜头单向，两个运动源方向不同不打架；素材用真实页面截图切块（卡片级比整页长图更易辨识）。",
    params: [
      { name: "列数", typical: "3（1080p）/ 4（超宽）", feelZh: "调大或调小：2 列读不出\"墙\"，5 列单列过窄纹理糊；再往大或往小调都会改变手感" },
      { name: "loop 时长", typical: "相邻列差 ≥25%（12/9/14s）", feelZh: "差速太小视差读不出；最快列 <7s 开始读作\"刷屏\"" },
      { name: "方向", typical: "中列反向（-1,1,-1 或交替）", feelZh: "全同向=一张大图；反向列是\"独立列\"的最强证据" },
      { name: "倾角/透视", typical: "rotateX 20° / perspective 1000px", feelZh: ">25° 顶部行文字透视压糊（Q2）；<12° 读不出墙面后仰；再往大或往小调都会改变手感" },
      { name: "scale", typical: "1.2 基础 + 缓推至 ~1.26", feelZh: "调大或调小：1.2 是补透视收缩的底值，低于它四角露底；demo 把放大与缓推放到外层 CSS zoom（布局级缩放），切片文字不被放大发软（Q2）" },
      { name: "遮罩高度", typical: "200px", feelZh: "太矮行硬进硬出；太高可视区剩不下 2 行" },
      { name: "循环周期", typical: "-50% 位移必须恰等于单副本周期（内容高+n·gap）", feelZh: "lib 已用 marginBottom 保证；自写实现用 flex gap 会差 gap/2 跳帧；再往大或往小调都会改变手感" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。音效密度与画面节拍一致即可。",
    pitfallsZh: "参数借鉴自外部实现（remotion-3d-ticker），非实战定稿； 首次实战须以真实素材回验；每列 items 总高必须 ≥ 视口有效高（否则同屏见同一切片两次，穿帮）； 列间切片不要复用同一张图，同图同时出现在两列读作素材穷；本卡是氛围/铺陈镜头不是信息镜头：切片上文字只求\"看得出是真页面\" 不求读完；想让观众读某一块，交棒 spotlight-hero-card 单主角处理；P4 去重：与 outro 合影同片共存没问题（一流动一聚拢），但全片 瀑布墙只出现一次，二次出现读作凑时长",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(3px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 6s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 详情卡逐字段自建（上游  → ui-entrance）
  {
    id: "product-card-progressive-assemble",
    category: "ui-entrance",
    nameZh: "详情卡逐字段自建",
    oneLineZh: "详情卡像被逐字段抓取般自建：填充光标领先跳格，图、标题、pill、价格（划线降级+新价 spring）、正文、色卡、按钮依次落位。",
    useWhenZh: "商品或条目详情页的能力展示；「结构化抽取」「自动填充」「数据自己长出来」类叙事的主镜头。",
    seconds: [4.1, 7.3],
    energy: "medium",
    tags: ["ui-entrance","UI 入场","product","card","progressive","assemble"],
    intentZh: "逐字段落位把一张卡变成一份正在被填写的表单：注意力被牵着走一遍卡的信息结构——图在哪、标题在哪、价格在哪；价格划线降级是全片唯一的语义事件（不是出现而是改变），所以安排在中段最显眼的位置。",
    motionZh: "字段时间表用 30fps 帧号：光标到达 图 8/标题 20/pill 30/价格 42/正文 76/色卡 96/按钮 114，字段在光标到达后 2f 开始落位，同组内部间隔 3f、跨组 10–20f；填充光标钴蓝 2.5px 描边框 + 外圈 6px 淡光 + AUTOFILL 小签，在相邻字段框之间用 6f 不对称 in-out（cubic-bezier(.4,0,.2,1)）同时插值位置与宽高，最后收进按钮（ease-in 8f 淡出）；落位前槽位是浅灰骨架条、随进度淡出；大件用 rise（上移 10–26px + 6px→0 失焦，expo-out 14f），小件用 pop（spring damping 13，scale 0.4→1 一次可见过冲）；整卡全程极慢 scale 前推。",
    params: [
      { name: "字段时间表", typical: "光标 8/20/30/42/76/96/114，落位 +2f", feelZh: "同类字段间隔 3 帧、跨类间隔 10–20 帧；全部改成等间隔会读作机械点名；再往大或往小调都会改变手感" },
      { name: "光标跳格", typical: "6f，swift in-out，框形同步变形", feelZh: "<4f 读作闪现；>10f 光标拖在字段后面，\"领先抓取\"变成\"事后框选\"；再往大或往小调都会改变手感" },
      { name: "单字段行程", typical: "14f expo-out", feelZh: "行程远大于组内间隔 → 同组几个字段同时在动，画面是\"涌\"而非\"点\"" },
      { name: "rise 位移", typical: "10–26px（按字号）", feelZh: "大标题位移大、小字位移小；>40px 会与整卡前推的方向感打架" },
      { name: "pop", typical: "弹簧 damping 13，0.4→1", feelZh: "pill 与色卡尺寸小，过冲不会撞到邻居，大件用 pop 就会显得廉价" },
      { name: "价格降级点", typical: "f62（价格落位后 hold 18f）", feelZh: "必须留出\"先看清原价\"的时间，紧贴落位会读作从来就是打折价；再往大或往小调都会改变手感" },
      { name: "新价 spring", typical: "damping 14，1.18→1", feelZh: "全片唯一的放大回弹事件；阻尼调小会抖两下，与旁边的划线动作抢注意力" },
      { name: "高亮刷过", typical: "6f，scaleX 从左", feelZh: "调大或调小：5–6f 是马克笔速度；>12f 读作背景色渐变而不是划线；再往大或往小调都会改变手感" },
      { name: "整卡前推", typical: "scale 1→1.035，0–132f", feelZh: "摊在 4.4s 上是纯呼吸；>8% 卡会撞到画框；再往大或往小调都会改变手感" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。音效密度与画面节拍一致即可。",
    pitfallsZh: "字段框（光标落点）是写死的绝对坐标：改字号或文案后要同步改 F 表里的 box，否则光标框不住字段；最后一个字段在 ~f128 落定，之后 ~1.3s 只有极缓前推——给观众通读整卡的时间，别当成 bug 砍掉；三行正文 white-space: nowrap 写死不换行（34px，行宽 ≤ 700px）。换更长文案或中文时会溢出卡边， 落地必须重新配字号与行长；新价与折扣 chip 是绝对定位（按 112px 粗体数字宽度估的 x），换价格位数要重排，否则 chip 压字；内容是 video-shotcraft 的示例填法（$449 划掉→Free、卖点文案、品牌四色色卡；$449 只是示意原价），字段结构本身才是可复用的部分。 换成真实商品数据后字段数量往往变化，时间表要按新的字段分组重排间隔",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(8px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 5.7s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 圆点阵列上电（上游  → ui-entrance）
  {
    id: "radial-wave",
    category: "ui-entrance",
    nameZh: "圆点阵列上电",
    oneLineZh: "17×9 圆点阵列按到波源的欧氏距离错峰点亮，每点 scale 过冲到 1.5 再落回常亮，第一道波扫完后第二道亮蓝脉冲从外圈反向收拢回中心。",
    useWhenZh: "产品/品牌开场的「系统上电」一拍；数据网格、节点地图、覆盖范围类叙事的建立镜头。",
    seconds: [2.74, 4.86],
    energy: "high",
    tags: ["ui-entrance","UI 入场","radial","wave","圆点阵列上电"],
    intentZh: "把「很多点同时存在」的静态事实改写成「能量从一个源头扩散到全体」：观众看到的不是点阵图而是一次通电——中心先亮、亮度像水波推过去、走完留在常亮态；第二道反向波是回执，告诉观众系统会回应。",
    motionZh: "阵列 17×9 共 153 点，dot 用百分比定位（left:(c+0.5)/COLS），每点预存归一化距离 dist=hypot(c−cx,r−cy)/maxD（maxD=hypot(8,4)）；第一道波 seg(t,dist*0.35,dist*0.35+0.18,E.outCubic)——起点由距离线性推迟（最外圈延后 0.35）、单点行程恒 0.18，是起点错峰而不是变速；每点 scale=w1*(1+0.5*sin(w1*π))，中途鼓到约 1.5 再收回 1，正弦包络让过冲发生在行程正中而非落位时；第二道波 seg(t,0.62+(1−dist)*0.25,+0.15) 把偏移量反号（外圈先动），取 sin(w2*π) 做纯脉冲、叠加 0.8 的 scale 增量与 0.25 的透明度增量，走完不留状态。",
    params: [
      { name: "阵列规模", typical: "COLS=17 / ROWS=9（153 点）", feelZh: "点数决定波前的\"分辨率\"；<8 列时距离分档太粗，波读作三四圈同心环在跳" },
      { name: "波速系数", typical: "dist*0.35", feelZh: "这个 0.35 就是波速倒数：调大波走得慢、拖尾长；>0.5 时最外圈要等到全片过半才亮" },
      { name: "单点行程", typical: "0.18（≈21f）", feelZh: "决定波前的厚度；<0.1 波前锐利像扫描线，>0.3 全场几乎同时亮，扩散感消失" },
      { name: "过冲幅度", typical: "1+0.5*sin(w1*π) → 峰值 1.5", feelZh: "系数 0.5 是\"弹一下\"的量；去掉正弦项就是平淡的 0→1 淡入，>0.8 点会互相咬边；再往大或往小调都会改变手感" },
      { name: "第二道波", typical: "起点 0.62+(1-dist)*0.25，窗 0.15，幅度 0.8", feelZh: "调大或调小：0.62 是两波之间的呼吸；提前到 0.5 以下会和第一道波尾巴叠在一起读作一团乱闪" },
      { name: "常亮底", typical: "opacity = 0.25 + w1*0.5 + pulse2*0.25", feelZh: "调大或调小：0.25 是未点亮点的存在感；调到 0 则波前之外一片黑，阵列的\"规模\"交代不出来" },
      { name: "高亮阈值", typical: "pulse2 > 0.3 切色 + 光晕", feelZh: "阈值越低发光段越长；这是硬切不是渐变，阈值贴近 0 时会看到明显的开关跳变" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "波源写死在几何中心（cx=(COLS-1)/2, cy=(ROWS-1)/2）。要改成从角落或某个\"节点\"起波， 必须同时改 cx/cy 与 maxD，否则归一化距离 >1，最外圈的起点会被推到 t=1 之外永不点亮；末帧不完全静止：中心点（dist=0）的第二道波窗是 0.87→1.02，t=1 时才走到 87%， pulse2≈0.41 仍在高亮。要做循环或干净收尾，得把第二道波起点压到 0.85 以内；dot 的 width:10px 与 margin:-5px 是绑定的一对（靠负 margin 居中），改点径必须同步改 margin，否则整阵列会朝右下偏半个点径；颜色只有两档（常色 #6c8cff / 峰值 #b9f2ff），换品牌色要改这两处加光晕色共三处； 背景 #0a0b10 是发光的前提，白底上这套亮度脉冲基本看不见",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(17px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 3.8s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 论文卡流水叠压（上游  → ui-entrance）
  {
    id: "research-card-stack-scroll",
    category: "ui-entrance",
    nameZh: "论文卡流水叠压",
    oneLineZh: "深色论文卡每 12 帧一张沿右下轴线飞入中心叠压，落位带 1 帧压缩，只有最上一张全清晰，下方按堆积深度递增模糊变暗，背景 grid 同步下移做速度参照。",
    useWhenZh: "「读了大量资料、处理了海量文档」的量级交代；研究、检索、批处理类产品的能力镜头。",
    seconds: [3.46, 6.14],
    energy: "high",
    tags: ["ui-entrance","UI 入场","research","card","stack","scroll"],
    intentZh: "要说的是数量，但一次给 13 张会读成一堵墙；改成流水线——卡一张一张进、每张都被读过（最上一张永远是全文渲染的那张），读完就沉进堆里变模糊，观众感受到的是持续吞吐量。",
    motionZh: "内部 F=144，每张卡本地时间 e=t*144−i*12，一切编排以 PER=12 帧为节拍单位；入场是 6 帧短促动作 seg(clamp((e+6)/6),0,1,E.outCubic)——起点 e=−6，卡在自己的节拍到达前 6 帧就开始飞，translateY(−40→0)+scale(0.94→1)；落位 squash 只在 e∈[0,1.6) 把 y 轴 scale 额外乘 0.97（短到读不出变形，只读作砸实了）；落位后 drift=e/12*30 每节拍向下 30px、向右 XOFF=9px，形成微微向右下的轴线，让 13 张卡不是同心叠放而是有厚度的一叠。",
    params: [
      { name: "节拍", typical: "PER=12 帧/张，13 张", feelZh: "调大或调小：12f 是\"紧但看得清\"的下限；<8f 标题来不及读，>20f 量级感垮掉变成逐张展示；再往大或往小调都会改变手感" },
      { name: "入场行程", typical: "6 帧（outCubic），提前量 -6 帧", feelZh: "行程只有节拍的一半 → 每张在下一张来之前已经落定；行程 ≥ PER 时会有两张同时在飞；再往大或往小调都会改变手感" },
      { name: "入场位移/缩放", typical: "translateY(-40→0)、scale 0.94→1", feelZh: "调大或调小：40px 相对 96px 卡高是小幅——卡是\"落进去\"不是\"飞进来\"；缩放差只有 0.06，再大就读作弹窗" },
      { name: "落位压缩", typical: "1.6 帧，y 轴 ×0.97", feelZh: "调大或调小：3% 是刚好能感知的量；>6% 或时长 >3f 会看出橡皮变形" },
      { name: "堆积轴线", typical: "每节拍 y+30px、x+9px", feelZh: "调大或调小：9/30 的比值决定轴线斜度；x 归零会变成正下方同心叠压，厚度感消失；再往大或往小调都会改变手感" },
      { name: "深度衰减", typical: "depth = drift/90，blur 0→4px、brightness 1→0.75", feelZh: "调大或调小：90px（3 个节拍）内衰减完 → 画面里始终只有约 3 张是\"半清晰\"的；衰减距离拉长会让下方糊卡堆太厚，画面变脏" },
      { name: "回收窗", typical: "drift > 96px 起淡出，48px 内到 0", feelZh: "回收太早会看到卡在画面中央消失；太晚 13 张全在场，DOM 与 blur 开销都上去" },
      { name: "内容坐标系", typical: "逻辑 420×250，整体 scale(min(W/420, H/250))", feelZh: "所有像素值写在逻辑坐标系里，改画布尺寸不用重排；卡 296×96、字号 9.5px 都是逻辑值" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "卡数与节拍是绑定的：13 张 × 12 帧 = 156 帧 > F=144，末两张在 t=1 时仍在入场途中， 末帧不是干净的静态。要做定格结尾，把卡数压到 F/PER - 1 以内（12 帧节拍下 ≤11 张）；focus = floor(f/12) 会超出卡数上界（f=144 时 focus=12，正好是最后一张）——加卡数 或改节拍后要确认 focus 不会长期指向不存在的索引，否则出现\"没有任何一张是清晰的\"；全部时间常量都写死在 144 帧的假设上（F=144, fr=f/F）。改时长必须同时改 F， 否则节拍会随时长伸缩，12 帧的紧凑感丢失；标题是 13 条真实感的论文标题占位、preprint:24xx 编号由索引生成，落地要换成项目 真实文档标题；rand(i*5+k) 生成的摘要骨架条宽度是确定性伪随机，不要换成 Math.random；深色卡（INK 底 + #2A2A2A 描边）压在 #FAFAFA 浅底上是这套对比度的前提；卡色 改浅后 brightness(0.75) 的深度衰减几乎看不出来，需要改用 opacity 或灰度衰减",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(12px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 4.8s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 内容行嵌入（上游  → ui-entrance）
  {
    id: "row-embed",
    category: "ui-entrance",
    nameZh: "内容行嵌入",
    oneLineZh: "内容行像卡片一样从空中降下、rotateX 收平，嵌入瞬间底边亮起一道强调色的缝。",
    useWhenZh: "「结构化数据长进页面」的详情页或列表镜头；行级内容的批量入场。",
    seconds: [1.44, 2.56],
    energy: "medium",
    tags: ["ui-entrance","UI 入场","row","embed","内容行嵌入"],
    intentZh: "详情页的行不是「显示出来」而是「长进去」：每一行从空中降下并严丝合缝嵌入布局，嵌入瞬间的强调色缝是「咔哒」扣上的视觉拟音。",
    motionZh: "行按越落越快的节拍逐条从上空飞入（末段带速度砸进槽位 + 纵向运动模糊），rotateX 从仰角收平、scale 略过冲后 press 回弹；行位先盖页面真实底色补丁 + 极淡虚线槽位框占位，落地后补丁消失让纹理透出、槽位接触影随行接近收紧变实；嵌入瞬间行底边一道 2px 强调色缝从中心向两侧展开后淡出；相机同时缓缓下摇并微推近，取景全程被页面铺满。",
    params: [
      { name: "节拍", typical: "cue = 12/22/31/39/46（间隔 10→7 递减），飞行 12f，最后一行 58f 落地、强调色缝 66f 收尾 ≤ 镜头 68f 预算", feelZh: "先算\"最后一行何时落地\"再定 cue 间隔——节拍×行数要对预算（同 document-typewriter-reveal 卡的核心算术）" },
      { name: "飞行姿态", typical: "perspective(900px) translateY(−120·air) rotateX(16°·air)，进度缓动 bezier(.5,0,.8,.75)（末段仍有速度），scale 1.06→0.995 再 4f press-bounce 回 1", feelZh: "rotateX 收平是\"嵌入\"的关键读感；纯垂直下落读作贴纸；再往大或往小调都会改变手感" },
      { name: "飞行体", typical: "backgroundImage 取整页截图、backgroundPosition 负偏移裁出该行", feelZh: "纹理裁片不重绘内容（Q1）——重绘的行和页面字体渲染有肉眼可见差异" },
      { name: "空槽补丁", typical: "行位先盖页面真实底色 #f9f6f1 patch（逐像素采样，偏白会读成一整块白板）+ 20% 虚线槽位框，落地后 2f 消失", feelZh: "无补丁时纹理里烤入的行会先透出来，飞入变成\"重影\"" },
      { name: "嵌入闪光", typical: "底边 2px 强调色缝（两端羽化）从中心向两侧 5f 展开（Easing.out cubic）、8f 淡出，带 7px 辉光", feelZh: "缝只在底边、只闪一次；四边都闪读作选中框；再往大或往小调都会改变手感" },
      { name: "相机", typical: "cy 500→740、zoom 1.12→1.25，68f 缓动下摇 + 微推", feelZh: "运镜与行雨并行制造\"边看边长\"的感觉；相机若等行落完再动，镜头会拖；起止两端都要让页面铺满画框，露出页顶/页底外就是空白死区" },
    ],
    soundZh: "段落切入钉 transition-soft（模板片钉在 f475）；行落地不逐条配音——行数多、间隔匀时逐条 pop 会机枪化，靠画面的强调色缝做\"视觉拟音\"即可（S2 反面自检）。",
    pitfallsZh: "飞入终点必须是页面布局真实槽位、落地即嵌入（Q9）——要\"从空中飞入，嵌入 dashboard\"；悬浮其上不落地会显得假；强调色缝等光效必须裁进承载元素圆角边界内（Q4 判例），光溢出圆角是廉价感典型来源",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(12px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 2s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.2s)}",
    },
  },
  // 渐变数值错峰（上游  → ui-entrance）
  {
    id: "value-stagger-gradient",
    category: "ui-entrance",
    nameZh: "渐变数值错峰",
    oneLineZh: "16 根柱入场时 delay 是时间错峰，同时高度、色相、位移、模糊四个属性各自铺成从首到末的数值梯度；第二拍把错峰原点换成中心重新铺开。",
    useWhenZh: "技法演示与参数化能力的展示镜头；也可直接当数据、频谱、均衡器类界面的入场。",
    seconds: [3.6, 6.4],
    energy: "high",
    tags: ["ui-entrance","UI 入场","value","gradient","渐变数值错峰"],
    intentZh: "stagger 不只错开时间还能错开值：同一个索引既决定「什么时候动」也决定「动到多少」；两拍是一组对照实验——第一拍原点在首位（梯度从左到右单调铺开），第二拍原点换到中心（梯度以中轴对称铺开）。",
    motionZh: "核心工具是 staggerVal(i,n,a,b,ease)：k=i/(n−1) 再 lerp(k,a,b)，等价 anime.js 的 stagger([a,b]) 值模式；静态梯度在 setup 里一次算完（色相 200→320、最大高度 92→32），动态梯度每帧用（位移 46→14、模糊 8→2）；第一拍时间错峰 d=i*0.02、e=seg(t,0.06+d,0.28+d,E.outCubic)，从首位起 16 根摊在 0.3 的窗上，opacity=e、blur=(1−e)*b0、translateY=(1−e)*y0、高度 hMax*e；第二拍把错峰原点换成中心，脉冲幅度以中心为最大重新铺开。",
    params: [
      { name: "柱数", typical: "N=16（left: 8+i*5.4%，宽 3.4%）", feelZh: "调大或调小：16 根让梯度有足够分档；<8 根梯度读作\"每根都不一样\"而非一道斜坡，>24 根柱间距要重算" },
      { name: "时间错峰", typical: "d = i*0.02（≈3f/根，总 0.3）", feelZh: "调大或调小：3f 是连绵的铺开；>0.05 会变成逐根点名，梯度的\"整体感\"丢失；再往大或往小调都会改变手感" },
      { name: "单柱行程", typical: "窗 0.22（≈33f，outCubic）", feelZh: "行程是总错峰的 0.73 倍 → 大部分时间十来根同时在动；行程 < 错峰总量时变成一根接一根" },
      { name: "高度梯度", typical: "stagger([92, 32])px", feelZh: "首末 2.9 倍差是明确斜坡；比值 <1.5 读不出梯度，>4 末端柱矮到看不见；再往大或往小调都会改变手感" },
      { name: "色相梯度", typical: "stagger([200, 320])", feelZh: "调大或调小：120° 跨度（蓝→紫）；跨度 <40° 时色相白给，>200° 会绕回红色让斜坡读作环形；再往大或往小调都会改变手感" },
      { name: "位移/模糊梯度", typical: "stagger([46,14])px / stagger([8,2])px", feelZh: "这两条是本卡的\"值 stagger\"主证据——把它们改成常量，动效立刻退化成普通的 stagger 入场；再往大或往小调都会改变手感" },
      { name: "第二拍原点", typical: "from:'center'，distC*0.13", feelZh: "调大或调小：0.13 是从中心到端点的传播延迟（≈4f）；归零则整排同时脉冲，from 参数就没有意义了；再往大或往小调都会改变手感" },
      { name: "脉冲幅度梯度", typical: "lerp(1-distC, 0.06, 0.42)", feelZh: "中心 42% / 端点 6% 是 7 倍差，波形明显；两端也给大幅度会读作整排一起鼓，中心原点看不出" },
      { name: "亮度脉冲", typical: "brightness(1 + pulse*0.55)", feelZh: "调大或调小：55% 提亮让脉冲在暗底上可读；这一项没做梯度（全柱同幅），是有意的——太多梯度叠一起观众读不清哪个是主角" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。这一段是全片能量高点，音效可以更密、更响。",
    pitfallsZh: "第一拍与第二拍首尾相接：末柱入场结束于 0.28+15*0.02 = 0.58，而中心柱的脉冲在 0.56 就起。加柱数或加大时间错峰会让入场吃进脉冲段，两拍糊成一件事——加柱必须把 0.56 后推；端点柱的第二拍窗口是 0.69→0.87，之后到 t=1 有约 0.13（20f）的完全静止。这是给 观众看清\"终态梯度\"的时间，不是空白；distC 的分母 C=(N-1)/2 在 N=1 时会除零；staggerVal 里已用 n<=1 ? 0 兜住， 但 distC 没有——柱数改成 1 会 NaN；柱位 left: 8+i*5.4% 与宽 3.4% 是为 N=16 手配的（末柱右缘 8+15*5.4+3.4 = 92.4%）。 改柱数必须重算这两个百分比，否则柱会溢出或挤在左半边；字幕是 anime.js 的 API 调用字符串，本质是技法说明而不是内容。用在真实成片里 要么换成有语义的标题，要么去掉——否则观众读到的是代码",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(16px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 5s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
    },
  },
  // 整墙批量显形两式（上游  → ui-entrance）
  {
    id: "wall-reveal-moves",
    category: "ui-entrance",
    nameZh: "整墙批量显形两式",
    oneLineZh: "bento 逐格点亮、蓝图描线成形——元素全部原位显形、不做位移，与飞入位移型互补成品类矩阵。",
    useWhenZh: "功能墙、卡片墙、整页界面的整体亮相；内容已在原位、要「显形」而非「涌入」的段落。",
    seconds: [3.6, 6.4],
    energy: "medium",
    tags: ["ui-entrance","UI 入场","wall","reveal","moves","整墙批量显形两式"],
    intentZh: "不是每面墙都该「涌进来」：品牌段要庄重、「从设计到实物」要讲工序；两式共同点是非位移批量入场，版式第一帧就成立，观众看的是状态变化的波前扫过一面墙。",
    motionZh: "A bento-light-up 逐格点亮：暗场 3×2 bento 墙（两行宽窄互补 600/420/420 ↔ 420/420/600，暗色卡面）压暗待命，强调色彗星流光逐格描边一圈、内容随即提亮上浮，全亮后镜头缓推收住；B wireframe-draw-on 蓝图描线成形：界面先以 SVG 细线蓝图分组描画，再一条强调色发光竖线左→右扫过，扫过处线框实体化成真实界面。",
    params: [
      { name: "A 节拍", typical: "hold 20f → 每格间隔 12f 依次激活（六格 ~96f 全亮）→ scale 1→1.04 缓推 25f（bezier 0.33,0,0.2,1）→ 静止收尾", feelZh: "调大或调小：12f 级联是\"逐格可辨\"与\"整墙拖沓\"的平衡点；格数增多可压到 8–10f，但间隔均匀本身就是这一式的庄重感来源，别学发牌加速" },
      { name: "A 单格", typical: "暗态 opacity 0.18 + translateY 20px；SVG rect pathLength=100 描边 8f：22% 周长的彗星段（#e8b45e 6px 高斯辉光 + #ffe3ae 2.5px 亮芯）领跑，身后留 1.5px 细边；描边过半（+6f）内容 back-out(0.3,1.4,0.5,1) 弹出 8f 提亮归位；描完 +1…", feelZh: "描边与内容弹出要接力不同步——同帧起读作整格闪现；点亮中段辉光脉冲用 lit·(1−lit)·4 抛物线，峰值幅度按格 seed 微差（正弦哈希，禁真随机）" },
      { name: "B 描线", typical: "hold 20f → 分组错峰各 30f 描完：侧栏 20f 起/顶栏 30f 起/6 卡 40+i*3f 起/折线图 52f 起；SVG pathLength=1 + dashoffset 1→0，蓝图冷灰蓝 #6c7894（外框 1.6px / 内件 1.25px）round，淡蓝 24px 点阵底 + 卡角裁切标记", feelZh: "分组错峰是\"手在画\"的感觉来源，全部同帧起笔读作打印机；卡内占位线再按 +3f 细错峰，长短用 seed 哈希微差" },
      { name: "B 实体化", typical: "88–118f 实体层 clip-path inset(0 right% 0 0) 从左向右展开 30f，bezier(0.55,0,0.25,1)；前沿跟 4px 强调色竖线（#ffc46b + 双层辉光 boxShadow），86–92f 淡入、112–120f 淡出；竖线身后 260px 一段渐隐暖光（刚显影的余温）", feelZh: "竖线位置与 clip 前沿必须同一个 scan 值驱动，异步读作穿帮；描线段与扫描段之间留 ~6f 喘息（82→88f），线框画完立刻扫读作赶工；再往大或往小调都会改变手感" },
      { name: "静止收尾", typical: "两式动作全部落定后真静止 ≥15f（A 在缓推结束后、B 在扫描线淡出后起算）", feelZh: "R1 呼吸判例：静止期一切属性锁死，包括辉光/阴影/高光残留" },
    ],
    soundZh: "UI 落位配短促 click 或 pop，错峰时音量阶梯递减防机枪感；大面积入场用一层 air 铺底。音效密度与画面节拍一致即可。",
    pitfallsZh: "demo 在灰阶/占位素材上调校通过——参数是调校起点非实战定稿， 首次实战须以真实素材回验；A/B 的强调色描边/扫描线属\"单点高质量光效\"范畴（Q4 三约束内合规），但一支片 整墙点亮 ≤1 次（P4 手法去重）——A 和 B 同片共用即算两次整墙光效，选一；B 式线框几何必须与实体层布局逐像素对位（demo 里按 FakeDashboard A 手排）， 换素材要重排线框——对不齐则扫描线扫过瞬间元素跳位，一眼穿帮；改了品牌名 / logo 也算换素材（字宽变了，面包屑后面的元素会整组右移），线长要按实体层实测字宽重对；两式都是\"原位显形\"，别混入位移入场（如逐格点亮时再加 translateX 飞入）—— 位移需求去 deck-deal-flyin，杂交会两头不像；A 式暗态 opacity 0.18 依赖暗底（#2a2a28）成立，亮底下压暗读作褪色故障",
    recipe: {
      css: "@keyframes ms-pop{0%{opacity:0;transform:translateY(20px) scale(.82)}70%{transform:translateY(0) scale(1.015)}100%{opacity:1;transform:none}}.ms-pop{animation:ms-pop 5s cubic-bezier(.3,1.18,.5,1) both;animation-delay:calc(var(--i) * 0.3s)}",
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
