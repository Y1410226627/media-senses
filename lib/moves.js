/**
 * lib/moves.js — camera-move + transition + cut-seam vocabulary.
 *
 * The point of this module is to turn the words a director or a video model uses
 * ("缓推", "甩镜", "J-cut", "切在动作顶点") into parameters another engine can
 * execute: duration windows, speed bands, an easing id (see lib/easing.js), a
 * framing change, an `ffmpegMotion` id that lib/build.js understands, and a CSS
 * recipe for the HTML animation renderer.
 *
 * Deliberately standalone: zero dependencies and **no imports from the rest of
 * the plugin** (build.js / craft.js / htmlrender.js must be able to import this
 * file without a cycle). Two things are copied by value from sibling modules and
 * documented here:
 *
 *  - `BUILD_MOTIONS` = the exact motion ids accepted by `lib/build.js` (`MOTIONS`
 *    constant, build.js line ~70): none, kenburns-in, kenburns-out, pan-left,
 *    pan-right, pan-up, pan-down, tilt-up, tilt-down.
 *  - `BUILD_XFADE_TRANSITIONS` = the exact xfade names accepted by
 *    `lib/build.js` (`TRANSITIONS` constant, build.js line ~82), plus the
 *    builder's no-op name `cut`.
 *    The visible Chinese labels were catalogued from `lib/craft.js` MOTION_ZH and
 *    `lib/render-v2.js` MOTION_ZH / TRANSITION_ZH so the vocabulary matches the
 *    reports the plugin already emits.
 *
 * Speed vocabulary (the part that makes "slow / medium / fast" measurable):
 *  - A SIZE change (push in, dolly, zoom) is measured in percent of subject size
 *    per second: slow ≤ 10 %/s, medium 10–25 %/s, fast > 25 %/s.
 *  - A SWEEP (pan, tilt, track, crane crossing the frame) is measured in seconds
 *    to cross one screen width: slow ≥ 6 s, medium 3–6 s, fast 1.5–3 s, and under
 *    1.5 s it stops being a pan and becomes a whip.
 *
 * @module lib/moves
 */

/* ------------------------------------------------------------------ *
 * Constants copied from lib/build.js (see header)
 * ------------------------------------------------------------------ */

/** Motion ids accepted by `RenderPlan.scenes[].motion` in lib/build.js. */
export const BUILD_MOTIONS = [
  'none',
  'kenburns-in',
  'kenburns-out',
  'pan-left',
  'pan-right',
  'pan-up',
  'pan-down',
  'tilt-up',
  'tilt-down',
]

/** xfade transition names accepted by lib/build.js (`transitionIn`), plus `cut`. */
export const BUILD_XFADE_TRANSITIONS = [
  'cut',
  'fade',
  'fadeblack',
  'fadewhite',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'circleopen',
  'circleclose',
  'dissolve',
  'pixelize',
  'radial',
  'smoothleft',
  'smoothright',
  'smoothup',
  'smoothdown',
  'horzopen',
  'horzclose',
  'vertopen',
  'vertclose',
]

const BUILD_MOTION_SET = new Set(BUILD_MOTIONS)
const BUILD_XFADE_SET = new Set(BUILD_XFADE_TRANSITIONS)

/* ------------------------------------------------------------------ *
 * Speed bands
 * ------------------------------------------------------------------ */

/**
 * Quantified speed vocabulary. Two metrics because "fast" means different things
 * for a zoom and for a pan:
 *  - `scale.percentPerSecond`: how much the subject grows/shrinks per second.
 *  - `sweep.secondsPerScreen`: how long the camera takes to travel one frame width.
 */
export const SPEED_BANDS = {
  scale: {
    metric: 'percentPerSecond',
    unit: '%/s',
    /** ≤ slowMax %/s = slow. */
    slowMax: 10,
    /** (slowMax, mediumMax] %/s = medium; above mediumMax = fast. */
    mediumMax: 25,
    /** Usable total size change across one move, in percent. */
    sizeChangePercent: [10, 120],
  },
  sweep: {
    metric: 'secondsPerScreen',
    unit: 's',
    /** ≥ slowMinSeconds to cross the frame = slow. */
    slowMinSeconds: 6,
    /** [mediumMinSeconds, slowMinSeconds) = medium. */
    mediumMinSeconds: 3,
    /** [fastMinSeconds, mediumMinSeconds) = fast. */
    fastMinSeconds: 1.5,
    /** Below this a pan/tilt reads as a whip, not a controlled sweep. */
    whipBelowSeconds: 1.5,
  },
  /** Kinds handled by each metric (aliases accepted by classifySpeed). */
  scaleKinds: ['scale', 'size', 'zoom', 'push', 'dolly'],
  sweepKinds: ['sweep', 'pan', 'tilt', 'track', 'crane', 'hold'],
}

const SCALE_KINDS = new Set(SPEED_BANDS.scaleKinds)
const SWEEP_KINDS = new Set(SPEED_BANDS.sweepKinds)

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

/**
 * Quantify a move duration into the slow/medium/fast/whip vocabulary.
 *
 * @param {'scale'|'size'|'zoom'|'sweep'|'pan'|'tilt'|'track'|string} kind
 * @param {number} seconds duration of the move in seconds
 * @param {number} [amountPercent=100] total size change for scale kinds (percent
 *   of the subject's starting size, e.g. 30 for scale(1) → scale(1.3)). Default
 *   100 so that `classifySpeed('scale', seconds)` alone obeys the documented
 *   boundaries: 10 s → 10 %/s (slow), 4 s → 25 %/s (medium), 2 s → 50 %/s (fast).
 * @returns {{kind: string|null, band: 'slow'|'medium'|'fast'|'whip'|null, seconds: number|null, percentPerSecond: number|null, noteZh: string}}
 */
export function classifySpeed(kind, seconds, amountPercent = 100) {
  const duration = Number(seconds)
  const normalizedKind = SCALE_KINDS.has(kind) ? 'scale' : SWEEP_KINDS.has(kind) ? 'sweep' : null
  if (normalizedKind === null) {
    return {
      kind: null,
      band: null,
      seconds: null,
      percentPerSecond: null,
      noteZh: `未知动作类型 "${String(kind)}"：请用 scale（变大小）或 sweep（扫掠）`,
    }
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      kind: normalizedKind,
      band: null,
      seconds: null,
      percentPerSecond: null,
      noteZh: '时长必须是大于 0 的秒数，无法分档',
    }
  }
  if (normalizedKind === 'scale') {
    const amount = Number(amountPercent)
    if (!Number.isFinite(amount) || amount <= 0) {
      return { kind: 'scale', band: null, seconds: round2(duration), percentPerSecond: null, noteZh: '变化百分比必须是正数' }
    }
    const rate = amount / duration
    const band = rate <= SPEED_BANDS.scale.slowMax ? 'slow' : rate <= SPEED_BANDS.scale.mediumMax ? 'medium' : 'fast'
    return {
      kind: 'scale',
      band,
      seconds: round2(duration),
      percentPerSecond: round2(rate),
      noteZh:
        `变大小 ${round2(rate)} %/s（共 ${round2(amount)}%）：` +
        `≤${SPEED_BANDS.scale.slowMax} 慢 / ${SPEED_BANDS.scale.slowMax}–${SPEED_BANDS.scale.mediumMax} 中 / >${SPEED_BANDS.scale.mediumMax} 快`,
    }
  }
  const band =
    duration >= SPEED_BANDS.sweep.slowMinSeconds
      ? 'slow'
      : duration >= SPEED_BANDS.sweep.mediumMinSeconds
        ? 'medium'
        : duration >= SPEED_BANDS.sweep.fastMinSeconds
          ? 'fast'
          : 'whip'
  return {
    kind: 'sweep',
    band,
    seconds: round2(duration),
    percentPerSecond: null,
    noteZh:
      `扫掠过画 ${round2(duration)} s：` +
      `≥${SPEED_BANDS.sweep.slowMinSeconds} 慢 / ${SPEED_BANDS.sweep.mediumMinSeconds}–${SPEED_BANDS.sweep.slowMinSeconds} 中 / ` +
      `${SPEED_BANDS.sweep.fastMinSeconds}–${SPEED_BANDS.sweep.mediumMinSeconds} 快 / <${SPEED_BANDS.sweep.whipBelowSeconds} 甩镜（whip）`,
  }
}

/* ------------------------------------------------------------------ *
 * Camera moves (18)
 * ------------------------------------------------------------------ */

/** Easing ids are keys of `EASINGS` in lib/easing.js. */
const EASE = {
  enter: 'expo.out',
  move: 'power2.inOut',
  exit: 'power3.in',
  camera: 'ease-in-out',
}

/**
 * The 18 canonical camera moves. Every entry carries the same seven required
 * fields — `{ id, nameZh, seconds, speed, easing, framing, ffmpegMotion,
 * htmlRecipe }` — plus `kind`/`amountPercent` (used by classifySpeed) and
 * `whyZh` (the director-language one-liner a model can learn from).
 *
 * `ffmpegMotion` is a lib/build.js motion id, or `null` when the move cannot be
 * expressed by the builder's zoompan path (whip, orbit, rack focus, dolly zoom,
 * handheld); those still carry an `htmlRecipe` for the HTML animation renderer.
 */
export const CAMERA_MOVES = [
  {
    id: 'static-hold',
    nameZh: '固定镜头（定场）',
    seconds: [2, 8],
    speed: 'slow',
    kind: 'hold',
    easing: EASE.enter,
    framing: 'WS→WS',
    ffmpegMotion: 'none',
    htmlRecipe: 'transform: none → none；只保留 0.5% 呼吸位移（约 1–2 px，周期 4 s）',
    whyZh: '让观众看清空间关系；固定镜头每多 1 秒，就多 1 秒信息量',
  },
  {
    id: 'push-in',
    nameZh: '缓推（人物/主体）',
    seconds: [2.5, 6],
    speed: 'slow',
    kind: 'scale',
    amountPercent: 20,
    easing: EASE.move,
    framing: 'WS→MS',
    ffmpegMotion: 'kenburns-in',
    htmlRecipe: 'transform: scale(1)→scale(1.2)，transform-origin 对准主体',
    whyZh: '推近 = 强调；20% 的缓慢放大不会暴露分辨率，只会把注意力收进主体',
  },
  {
    id: 'pull-out',
    nameZh: '缓拉（揭示环境）',
    seconds: [2.5, 6],
    speed: 'slow',
    kind: 'scale',
    amountPercent: 20,
    easing: EASE.move,
    framing: 'MS→WS',
    ffmpegMotion: 'kenburns-out',
    htmlRecipe: 'transform: scale(1.2)→scale(1)，反向即缓拉',
    whyZh: '拉开 = 揭示；先给主体再给环境，最后 20% 时间停在完整构图上',
  },
  {
    id: 'dolly-in',
    nameZh: '推轨前进',
    seconds: [1.4, 3.5],
    speed: 'medium',
    kind: 'scale',
    amountPercent: 35,
    easing: EASE.move,
    framing: 'MS→CU',
    ffmpegMotion: 'kenburns-in',
    htmlRecipe: 'transform: scale(1)→scale(1.35) + translateY(1%→0)（推轨带轻微视差）',
    whyZh: '带透视的推进，比纯 zoom 更有空间感；35% 是 2 秒内不晕的极限',
  },
  {
    id: 'dolly-out',
    nameZh: '推轨后退',
    seconds: [1.4, 3.5],
    speed: 'medium',
    kind: 'scale',
    amountPercent: 35,
    easing: EASE.move,
    framing: 'CU→MS',
    ffmpegMotion: 'kenburns-out',
    htmlRecipe: 'transform: scale(1.35)→scale(1)，反向即推轨后退',
    whyZh: '后退 = 抽离；离开主体时把新信息（环境/其他人物）带进画面',
  },
  {
    id: 'track-left',
    nameZh: '左移跟拍',
    seconds: [3, 6],
    speed: 'medium',
    kind: 'sweep',
    easing: EASE.move,
    framing: 'MS→MS（横向）',
    ffmpegMotion: 'pan-left',
    htmlRecipe: 'transform: translateX(0→8%)（画面右移 = 镜头左移）',
    whyZh: '跟拍要贴着主体速度；主体在画面里的位置基本不变，背景单向流动',
  },
  {
    id: 'track-right',
    nameZh: '右移跟拍',
    seconds: [3, 6],
    speed: 'medium',
    kind: 'sweep',
    easing: EASE.move,
    framing: 'MS→MS（横向）',
    ffmpegMotion: 'pan-right',
    htmlRecipe: 'transform: translateX(0→-8%)（画面左移 = 镜头右移）',
    whyZh: '向右跟拍时，让主体略偏画面左侧，给运动方向留出空间',
  },
  {
    id: 'pan-left',
    nameZh: '左摇',
    seconds: [3, 6],
    speed: 'medium',
    kind: 'sweep',
    easing: EASE.camera,
    framing: 'WS→WS（横向）',
    ffmpegMotion: 'pan-left',
    htmlRecipe: 'transform: translateX(0→6%)，配合 background-size: 115% 留出摇镜余量',
    whyZh: '摇镜 = 转头：慢速扫过空间，两端必须缓起缓停，否则像监视器',
  },
  {
    id: 'pan-right',
    nameZh: '右摇',
    seconds: [3, 6],
    speed: 'medium',
    kind: 'sweep',
    easing: EASE.camera,
    framing: 'WS→WS（横向）',
    ffmpegMotion: 'pan-right',
    htmlRecipe: 'transform: translateX(0→-6%)，background-size 留 115% 余量',
    whyZh: '右摇通常用于"接待"新主体：落点停在下一个视觉重点上',
  },
  {
    id: 'tilt-up',
    nameZh: '上摇',
    seconds: [3, 6],
    speed: 'medium',
    kind: 'sweep',
    easing: EASE.camera,
    framing: 'WS→WS（垂直）',
    ffmpegMotion: 'tilt-up',
    htmlRecipe: 'transform: translateY(0→6%)（画面下移 = 镜头抬起）',
    whyZh: '上摇 = 揭示高度：从人物脚部摇到脸部，或从地面摇到建筑尖顶',
  },
  {
    id: 'tilt-down',
    nameZh: '下摇',
    seconds: [3, 6],
    speed: 'medium',
    kind: 'sweep',
    easing: EASE.camera,
    framing: 'WS→WS（垂直）',
    ffmpegMotion: 'tilt-down',
    htmlRecipe: 'transform: translateY(0→-6%)（画面上移 = 镜头下压）',
    whyZh: '下摇 = 施压：从天空压到人物，画面越往下越有压迫感',
  },
  {
    id: 'whip-pan',
    nameZh: '甩镜',
    seconds: [0.4, 1.2],
    speed: 'fast',
    kind: 'sweep',
    easing: EASE.exit,
    framing: 'MS→MS（高速）',
    ffmpegMotion: null,
    htmlRecipe: 'translateX(0→±40%) + blur(0→18px)，持续 3–5 帧；出/入两镜的运动方向必须一致',
    whyZh: '甩镜是转场不是运镜：靠模糊把两个空间焊在一起，声音要提前一拍',
  },
  {
    id: 'crane',
    nameZh: '升降镜头',
    seconds: [6, 10],
    speed: 'slow',
    kind: 'sweep',
    easing: EASE.move,
    framing: 'WS→WS（垂直）',
    ffmpegMotion: 'pan-up',
    htmlRecipe: 'translateY(+10%→-6%) + scale(1.05→1)；反向（-6%→+10%）即降镜',
    whyZh: '升降改变的是"看世界的高度"：慢是气势，快是穿越',
  },
  {
    id: 'orbit',
    nameZh: '环绕',
    seconds: [4, 8],
    speed: 'medium',
    kind: 'composite',
    easing: EASE.move,
    framing: 'MS→MS（环绕）',
    ffmpegMotion: null,
    htmlRecipe: 'perspective(1200px) rotateY(-6deg→+6deg) + translateX(-2%→+2%)；前景比背景快 1.4 倍做视差',
    whyZh: '环绕 = 空间宣言：让主体不动、背景旋转，观众立刻感到"这是三维的"',
  },
  {
    id: 'handheld',
    nameZh: '手持晃动',
    seconds: [2, 10],
    speed: 'medium',
    kind: 'hold',
    easing: 'linear',
    framing: 'MS→MS（不规则）',
    ffmpegMotion: null,
    htmlRecipe: 'translate(±1.2%, ±0.8%) + rotate(±0.25deg)；用两组 0.7 s / 1.3 s 的 sin 叠加，不要用随机数（不可复现）',
    whyZh: '手持 = 临场感；幅度超过 1.5% 就会晕，要用低频慢晃而不是高频抖动',
  },
  {
    id: 'rack-focus',
    nameZh: '移焦',
    seconds: [0.6, 2],
    speed: 'medium',
    kind: 'focus',
    easing: EASE.move,
    framing: 'CU→CU（焦点转移）',
    ffmpegMotion: null,
    htmlRecipe: '背景 filter: blur(6px)→blur(0)，同时前景 blur(0)→blur(6px)；或用两层图交叉 opacity',
    whyZh: '移焦 = 换主角：焦点从一个主体交到另一个主体，比切镜头更连贯',
  },
  {
    id: 'dolly-zoom',
    nameZh: '迷幻变焦（希区柯克变焦）',
    seconds: [1.5, 4],
    speed: 'medium',
    kind: 'composite',
    easing: EASE.move,
    framing: 'MS→MS（透视拉伸）',
    ffmpegMotion: null,
    htmlRecipe: 'scale(1→1.6) 的同时把 perspective 从 1600px 拉到 900px，保持主体尺寸不变、背景被拉伸',
    whyZh: '眩晕 = 主体不动而空间在变；只用在情绪逆转的 1–2 个瞬间',
  },
  {
    id: 'snap-zoom',
    nameZh: '急推变焦',
    seconds: [0.25, 0.7],
    speed: 'fast',
    kind: 'scale',
    amountPercent: 45,
    easing: EASE.exit,
    framing: 'WS→CU',
    ffmpegMotion: 'kenburns-in',
    htmlRecipe: 'transform: scale(1)→scale(1.45)，0.2–0.4 s 内完成并命中节拍（用 MS.ease("expo.in")）',
    whyZh: '急推是标点符号：只用来强调一个词/一个数字，一两条片子最多用 1–2 次',
  },
]

/** `id -> move` lookup. */
export const MOVES_BY_ID = Object.fromEntries(CAMERA_MOVES.map((move) => [move.id, move]))

/** Look up one camera move by id (null when unknown). */
export function getMove(id) {
  if (typeof id !== 'string') return null
  return Object.prototype.hasOwnProperty.call(MOVES_BY_ID, id) ? MOVES_BY_ID[id] : null
}

/* ------------------------------------------------------------------ *
 * Transitions (9)
 * ------------------------------------------------------------------ */

/**
 * The 9 canonical transitions. `ffmpeg` is a lib/build.js `transitionIn` name
 * when one exists, else `null` and the `htmlRecipe` (or audio recipe) carries the
 * implementation. `defaultSeconds` is the usual transition length (`0` = hard cut).
 * `soundZh` always explains what the audio does — half of a transition is sound.
 */
export const TRANSITIONS = [
  {
    id: 'hard-cut',
    nameZh: '硬切',
    defaultSeconds: 0,
    soundZh: '声音连续、不加音效；把切点放在动作顶点或鼓点上，靠画面自己换气',
    ffmpeg: 'cut',
    htmlRecipe: null,
    whenZh: '同场景内推进节奏、对话正反打、动作连贯',
  },
  {
    id: 'match-cut',
    nameZh: '匹配剪辑',
    defaultSeconds: 0,
    soundZh: '声音随画面一起切；若两镜空间不同，做 1–2 帧短促静音再进气口',
    ffmpeg: null,
    htmlRecipe: '前后两镜对齐同一形状/动作位置：切点两侧主体位置差 ≤1/10 画幅（竖屏 1080 宽约 108 px），方向与速度比 0.7–1.4',
    whenZh: '跨场景但视觉上有承接；形状、颜色或动作的"同构"',
  },
  {
    id: 'whip',
    nameZh: '甩镜转场',
    defaultSeconds: 0.24,
    soundZh: '叠一声 0.15–0.3 s 的 whoosh，两端环境声各压低 6 dB，让声音跟着画面一起甩过去',
    ffmpeg: null,
    htmlRecipe: '方向性 blur(0→18px) 持续 2–3 帧 + 速度线；前后镜运动方向必须一致，中间帧可全模糊',
    whenZh: '两个相邻空间的高速切换；音乐/打击点上的爆发',
  },
  {
    id: 'dissolve',
    nameZh: '叠化（溶接）',
    defaultSeconds: 0.6,
    soundZh: '声音交叉淡化 0.3–0.6 s，避免在叠化中点出现两次硬切的攻击音',
    ffmpeg: 'dissolve',
    htmlRecipe: 'opacity 0→1 交叉淡化，或用 filter: blur(8px)→blur(0) 的"焦点溶解"',
    whenZh: '时间流逝、地点漂移、回忆进出现实',
  },
  {
    id: 'iris',
    nameZh: '圈入圈出',
    defaultSeconds: 0.5,
    soundZh: '收圈时近场音（呼吸、脚步）随圈缩小，出圈时声音先回来 2–3 帧',
    ffmpeg: 'circleopen',
    htmlRecipe: 'clip-path: circle(0%)→circle(75%)，圆心对准主体；反向即圈出',
    whenZh: '默片感、复古、聚焦一个细节（钥匙孔/望远镜）',
  },
  {
    id: 'wipe',
    nameZh: '划像',
    defaultSeconds: 0.4,
    soundZh: '配 0.2–0.4 s 的 whoosh 或纸页声，方向与划像方向一致',
    ffmpeg: 'wipeleft',
    htmlRecipe: 'clip-path: inset(0 100% 0 0)→inset(0)，或 translateX(-100%)→0 的硬边层',
    whenZh: '明确的空间/时间并列（左=过去，右=现在）',
  },
  {
    id: 'smash',
    nameZh: '砸切',
    defaultSeconds: 0,
    soundZh: '用撞击声/鼓点/音乐骤停制造冲击；切点前 2–3 帧可先静音，切点后 1 帧爆发',
    ffmpeg: 'cut',
    htmlRecipe: '硬切 + 前 2–3 帧加 1.05 倍冲击缩放或 4 px 抖动，切点后立即恢复',
    whenZh: '情绪或信息量的暴力转折；广告/预告的"打点"',
  },
  {
    id: 'j-cut',
    nameZh: 'J 型剪辑（先闻其声）',
    defaultSeconds: 0.3,
    soundZh: '下一镜的声音提前 6–20 帧（0.25–0.8 s）进入，画面仍停在前一镜，把观众"拉"过去',
    ffmpeg: null,
    htmlRecipe: '把下一镜 <audio> 的 start 提前 0.3 s，画面切换延迟到原切点；音频元素按 data-start 排布',
    whenZh: '场景过渡前的铺垫；让新场景的声音先建立空间',
  },
  {
    id: 'l-cut',
    nameZh: 'L 型剪辑（余音未了）',
    defaultSeconds: 0.4,
    soundZh: '前一镜的声音延续 8–24 帧（0.3–1 s），画面已切到下一镜，把观众"留在"前一场景',
    ffmpeg: null,
    htmlRecipe: '让前一镜 <audio> 的 end 晚于画面切点 0.4 s；用两段音频叠在切点两侧',
    whenZh: '对话/旁白跨场景延续；让观众带着上一场情绪进入下一场',
  },
]

/** `id -> transition` lookup. */
export const TRANSITIONS_BY_ID = Object.fromEntries(TRANSITIONS.map((transition) => [transition.id, transition]))

/** Look up one transition by id (null when unknown). */
export function getTransition(id) {
  if (typeof id !== 'string') return null
  return Object.prototype.hasOwnProperty.call(TRANSITIONS_BY_ID, id) ? TRANSITIONS_BY_ID[id] : null
}

/* ------------------------------------------------------------------ *
 * Cut-seam hard rules (the reasons a cut "feels wrong")
 * ------------------------------------------------------------------ */

/**
 * Mechanical rules for placing a cut. Each rule is data so a linter/report can
 * quote it: `{ id, ruleZh, metric, threshold, fixZh }`.
 */
export const CUT_SEAM_RULES = [
  {
    id: 'cut-on-action-apex',
    ruleZh: '切在动作最快的那一帧（动作顶点），不要切在起势或收势的停顿上',
    metric: 'cutFrameDistanceToPeakMotion',
    threshold: '≤2 帧',
    fixZh: '把切点移到该动作位移最大的帧，前后各留 1 帧动作余量',
  },
  {
    id: 'direction-speed-match',
    ruleZh: '切点两侧画面运动方向一致、速度接近（速度比 0.7–1.4）',
    metric: 'speedRatioAcrossCut',
    threshold: '0.7–1.4',
    fixZh: '前一镜向右运动，下一镜开场也向右；速度差大时加 2–3 帧运动模糊或改用中性镜头',
  },
  {
    id: 'zoom-sign-consistency',
    ruleZh: '切点两侧变焦符号不得反转（前一镜在推，下一镜不要立刻拉）',
    metric: 'zoomSign',
    threshold: '符号相同',
    fixZh: '推/拉方向保持一致，或在中间插一个 0.5 s 静态镜头完成换向',
  },
  {
    id: 'subject-position-continuity',
    ruleZh: '同一主体在切点两侧的位置差不超过 1/10 画幅（竖屏 1080 宽约 108 px）',
    metric: 'subjectPositionDelta',
    threshold: '≤0.10 画幅',
    fixZh: '用构图把主体放在三分线同一象限，或用 4–6 帧的短摇镜过渡',
  },
  {
    id: 'no-cut-inside-motion-blur',
    ruleZh: '运动模糊帧内不得硬切（切点要落在清晰帧上）',
    metric: 'blurFrameCount',
    threshold: '0 帧',
    fixZh: '把切点提前/延后 1–2 帧到清晰帧，或给前后镜各自加 2 帧出/入模糊',
  },
  {
    id: 'no-cut-on-incomplete-action',
    ruleZh: '动作未完成时不要切走（嘴型、手部、落点要交代完）',
    metric: 'actionCompletion',
    threshold: '完成',
    fixZh: '把切点放到动作完成帧（落点/收势），或用 J-cut 让声音先走、画面后切',
  },
  {
    id: 'eye-trace-reset',
    ruleZh: '硬切后 6–10 帧内新画面要有明确视觉落点，避免观众找不到焦点',
    metric: 'newFocusArrivalSeconds',
    threshold: '≤0.33 s',
    fixZh: '下一镜开场 0.2–0.4 s 内把主体/字幕放到预期位置；不要用空镜开场',
  },
]

/* ------------------------------------------------------------------ *
 * Label -> build.js motion id
 * ------------------------------------------------------------------ */

/** Normalise a human label: lowercase, drop spaces / underscores / hyphens. */
function normaliseLabel(label) {
  return label.toLowerCase().replace(/[\s_-]+/gu, '')
}

/**
 * Chinese / English camera labels -> build.js motion id (or null when the move
 * has no builder equivalent). Labels were catalogued from lib/craft.js MOTION_ZH
 * and lib/render-v2.js MOTION_ZH, plus the common English director terms.
 */
const LABEL_TO_MOTION = new Map(
  [
    // static
    ['固定机位', 'none'],
    ['固定镜头', 'none'],
    ['定场', 'none'],
    ['静置', 'none'],
    ['static', 'none'],
    ['hold', 'none'],
    ['statichold', 'none'],
    ['still', 'none'],
    ['none', 'none'],
    // push in
    ['推镜', 'kenburns-in'],
    ['推近', 'kenburns-in'],
    ['缓慢推近', 'kenburns-in'],
    ['缓推', 'kenburns-in'],
    ['推', 'kenburns-in'],
    ['pushin', 'kenburns-in'],
    ['push', 'kenburns-in'],
    ['zoomin', 'kenburns-in'],
    ['dollyin', 'kenburns-in'],
    ['kenburnsin', 'kenburns-in'],
    // pull out
    ['拉镜', 'kenburns-out'],
    ['拉远', 'kenburns-out'],
    ['缓慢拉远', 'kenburns-out'],
    ['缓拉', 'kenburns-out'],
    ['拉', 'kenburns-out'],
    ['pullout', 'kenburns-out'],
    ['pull', 'kenburns-out'],
    ['zoomout', 'kenburns-out'],
    ['dollyout', 'kenburns-out'],
    ['kenburnsout', 'kenburns-out'],
    // horizontal pans
    ['左摇', 'pan-left'],
    ['向左摇镜', 'pan-left'],
    ['panleft', 'pan-left'],
    ['trackleft', 'pan-left'],
    ['右摇', 'pan-right'],
    ['向右摇镜', 'pan-right'],
    ['panright', 'pan-right'],
    ['trackright', 'pan-right'],
    // vertical tilts
    ['上摇', 'tilt-up'],
    ['向上摇镜', 'tilt-up'],
    ['tiltup', 'tilt-up'],
    ['下摇', 'tilt-down'],
    ['向下摇镜', 'tilt-down'],
    ['tiltdown', 'tilt-down'],
    // vertical camera travel (builder exposes pan-up / pan-down for this)
    ['升起', 'pan-up'],
    ['升镜', 'pan-up'],
    ['上升', 'pan-up'],
    ['craneup', 'pan-up'],
    ['boomup', 'pan-up'],
    ['panup', 'pan-up'],
    ['下降', 'pan-down'],
    ['降镜', 'pan-down'],
    ['cranedown', 'pan-down'],
    ['boomdown', 'pan-down'],
    ['pandown', 'pan-down'],
  ],
)

/**
 * Map a camera label to the lib/build.js motion id.
 *
 * @param {string} label Chinese label ("向左摇镜", "缓推"), an English term
 *   ("pan left", "dolly in") or a build.js motion id ("pan-left").
 * @returns {string|null} a `BUILD_MOTIONS` id, or null when unmappable
 *   (handheld, orbit, rack focus, whip … have no builder equivalent).
 */
export function motionForCameraLabel(label) {
  if (typeof label !== 'string') return null
  const trimmed = label.trim()
  if (trimmed.length === 0) return null
  if (BUILD_MOTION_SET.has(trimmed)) return trimmed
  const normalised = normaliseLabel(trimmed)
  if (LABEL_TO_MOTION.has(normalised)) return LABEL_TO_MOTION.get(normalised)
  // Also accept a canonical camera-move id ("snap-zoom" -> its ffmpegMotion).
  const move = getMove(trimmed.toLowerCase()) ?? getMove(normalised)
  if (move !== null) return move.ffmpegMotion
  return null
}

/** True when a string is a build.js motion id. */
export function isBuildMotion(value) {
  return typeof value === 'string' && BUILD_MOTION_SET.has(value)
}

/** True when a string is a build.js transitionIn/xfade name. */
export function isBuildTransition(value) {
  return typeof value === 'string' && BUILD_XFADE_SET.has(value)
}

export default {
  BUILD_MOTIONS,
  BUILD_XFADE_TRANSITIONS,
  SPEED_BANDS,
  classifySpeed,
  CAMERA_MOVES,
  MOVES_BY_ID,
  getMove,
  TRANSITIONS,
  TRANSITIONS_BY_ID,
  getTransition,
  CUT_SEAM_RULES,
  motionForCameraLabel,
  isBuildMotion,
  isBuildTransition,
}
