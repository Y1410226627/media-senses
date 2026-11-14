/**
 * lib/easing.js — "motion timing" vocabulary.
 *
 * Turns director-speak ("snappy entrance", "premium settle", "rubber band exit")
 * into executable numbers: 12 named easing curves, a closed-form spring, a few
 * S-curve helpers, and role presets that map a *purpose* (enter / move / exit /
 * camera) to the curve a motion designer would pick.
 *
 * Deliberately standalone: zero dependencies and **no imports from the rest of
 * the plugin** (lib/build.js, lib/craft.js and the HTML renderer must be able to
 * import this file without creating a cycle). The CSS strings and the spring
 * damping semantics are copied from the public design conventions documented in
 * CONTRACT-V2 / lib/build.js; no upstream code is copied.
 *
 * Conventions
 * -----------
 * - Every easing function maps normalised time t ∈ [0,1] to progress. f(0) = 0
 *   and f(1) = 1 exactly; t outside [0,1] is clamped (same as CSS timing
 *   functions). Overshooting curves (back / elastic) intentionally return values
 *   > 1 (or slightly < 1) between the endpoints — that bounce is the feature.
 * - `cubicBezier(x1,y1,x2,y2)` mirrors CSS `cubic-bezier()`: x control points
 *   must stay inside [0,1] (time must be monotone), y control points may
 *   overshoot. The parameter is solved with Newton-Raphson and falls back to
 *   bisection when the derivative degenerates (x1 = x2 = 0 style curves).
 * - `spring({damping, frequency, t})` is the closed-form step response of a
 *   damped second-order system, normalised so it settles at 1. `damping` is the
 *   damping ratio ζ (not the physical damping coefficient):
 *     ζ = 1.0          critical — no overshoot at all, clean firm stop
 *     ζ = 0.7 – 0.85   premium settle — one barely-visible bounce ("高级感")
 *     ζ = 0.4 – 0.6    lively — clearly springy but controlled ("活泼")
 *     ζ < 0.3          cartoon rubber — 2–3 visible oscillations ("卡通")
 *   `frequency` is the undamped natural frequency in Hz (higher = faster settle).
 *
 * `browserPrelude()` returns the same maths as a plain-JS string for injection
 * into generated HTML pages (window.MS.ease / MS.spring / MS.cubicBezier /
 * MS.inertia …). The vocabulary test evaluates that string and asserts it agrees
 * with the module functions to 1e-6, so the two copies cannot drift silently.
 *
 * @module lib/easing
 */

/* ------------------------------------------------------------------ *
 * Numeric helpers
 * ------------------------------------------------------------------ */

/** Clamp a value into [min, max]; non-finite input returns min. */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Coerce to a finite number, else fallback. */
function finiteOr(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/* ------------------------------------------------------------------ *
 * Cubic bezier
 * ------------------------------------------------------------------ */

/**
 * Build a CSS-compatible cubic-bezier timing function.
 *
 * @param {number} x1 first control point x (must be within [0,1])
 * @param {number} y1 first control point y (may overshoot)
 * @param {number} x2 second control point x (must be within [0,1])
 * @param {number} y2 second control point y (may overshoot)
 * @returns {(t: number) => number} easing function on the normalised domain
 */
export function cubicBezier(x1, y1, x2, y2) {
  const control = [x1, y1, x2, y2].map((value) => Number(value))
  if (!control.every((value) => Number.isFinite(value))) {
    throw new TypeError('cubicBezier: x1, y1, x2, y2 must be finite numbers')
  }
  const [cx1, cy1, cx2, cy2] = control
  if (cx1 < 0 || cx1 > 1 || cx2 < 0 || cx2 > 1) {
    throw new RangeError('cubicBezier: x1 and x2 must be within [0, 1] (CSS requires monotone time)')
  }
  // Polynomial coefficients for one axis: p(t) = ((a·t + b)·t + c)·t.
  const ax = 3 * cx1 - 3 * cx2 + 1
  const bx = 3 * cx2 - 6 * cx1
  const cx = 3 * cx1
  const ay = 3 * cy1 - 3 * cy2 + 1
  const by = 3 * cy2 - 6 * cy1
  const cy = 3 * cy1
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t) => ((ay * t + by) * t + cy) * t
  const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx

  /** Solve x(t) = x for the curve parameter t (Newton, bisection fallback). */
  const solveParameter = (x) => {
    let t = x
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const error = sampleX(t) - x
      if (Math.abs(error) < 1e-7) return t
      const slope = slopeX(t)
      if (Math.abs(slope) < 1e-6) break
      t -= error / slope
      if (t < 0 || t > 1) break
    }
    let low = 0
    let high = 1
    t = x
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const value = sampleX(t)
      if (Math.abs(value - x) < 1e-7) break
      if (value < x) low = t
      else high = t
      t = (low + high) / 2
    }
    return t
  }

  return (t) => {
    if (!Number.isFinite(t) || t <= 0) return 0
    if (t >= 1) return 1
    return sampleY(solveParameter(t))
  }
}

/* ------------------------------------------------------------------ *
 * Analytic curves that CSS cannot express
 * ------------------------------------------------------------------ */

/**
 * "Back out": overshoots past the target then settles — a snappy hit with a
 * slight recoil. `overshoot` scales the recoil (1.70158 = the classic value;
 * 1.4 is a gentler, more modern pop).
 */
export function backOut(overshoot = 1.70158) {
  const c1 = finiteOr(overshoot, 1.70158)
  const c3 = c1 + 1
  return (t) => {
    if (!Number.isFinite(t) || t <= 0) return 0
    if (t >= 1) return 1
    const p = t - 1
    return 1 + c3 * p * p * p + c1 * p * p
  }
}

/**
 * "Elastic out": a damped oscillation that overshoots and rings down. CSS
 * timing-functions cannot express this (it needs keyframes or JS), so the named
 * curve entry exposes `css: null` and a single-overshoot `cssApprox` instead.
 * `amplitude` < 1 behaves like 1 (Penner convention); `period` is in seconds.
 */
export function elasticOut(amplitude = 1, period = 0.5) {
  const a = Math.max(1, finiteOr(amplitude, 1))
  const p = Math.max(1e-3, finiteOr(period, 0.5))
  const c4 = (2 * Math.PI) / p
  // Phase shift so the curve starts exactly at 0: sin(-shift·c4) = -1/a.
  const shift = Math.asin(Math.min(1, 1 / a)) / c4
  return (t) => {
    if (!Number.isFinite(t) || t <= 0) return 0
    if (t >= 1) return 1
    return a * 2 ** (-10 * t) * Math.sin((t - shift) * c4) + 1
  }
}

/* ------------------------------------------------------------------ *
 * S-curves
 * ------------------------------------------------------------------ */

/** Classic smoothstep: 3t² − 2t³ (zero slope at both ends). */
export function smoothstep(t) {
  if (!Number.isFinite(t) || t <= 0) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

/** Ken Perlin's smootherstep: 6t⁵ − 15t⁴ + 10t³ (zero first *and* second slope). */
export function smootherstep(t) {
  if (!Number.isFinite(t) || t <= 0) return 0
  if (t >= 1) return 1
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * Inertia: a camera / object comes to rest the way real mass does. A small
 * linear component keeps the motion reading as "coasting" instead of "easing",
 * and the smootherstep tail removes the mechanical stop:
 *   inertia(t) = 0.35·t + 0.65·smootherstep(t)
 */
export function inertia(t) {
  if (!Number.isFinite(t) || t <= 0) return 0
  if (t >= 1) return 1
  return 0.35 * t + 0.65 * smootherstep(t)
}

/* ------------------------------------------------------------------ *
 * Spring
 * ------------------------------------------------------------------ */

/** Human-readable damping-ratio bands (ζ semantics, see the module header). */
export const SPRING_FEEL = [
  { id: 'firm', dampingMin: 0.95, dampingMax: 1, feelZh: '干净利落，完全不过冲（按钮/切换）' },
  { id: 'premium', dampingMin: 0.7, dampingMax: 0.85, feelZh: '高级感：几乎看不见的一次轻微回弹（标题/卡片入场）' },
  { id: 'lively', dampingMin: 0.4, dampingMax: 0.6, feelZh: '活泼：一次明显回弹（弹窗/头像弹出）' },
  { id: 'cartoon', dampingMin: 0.15, dampingMax: 0.3, feelZh: '卡通橡皮感：2–3 次可见振荡（搞笑/儿童向）' },
]

/**
 * Closed-form spring step response: starts at 0, settles at 1.
 *
 * @param {{damping?: number, frequency?: number, t?: number}} options
 *   damping   damping ratio ζ (0 = undamped, 1 = critical); default 0.8
 *   frequency natural frequency in Hz; default 2 (≈ 1.2 s to settle at ζ 0.8)
 *   t         normalised seconds since the spring started; default 0
 * @returns {number} progress (overshoots > 1 for ζ < 1)
 */
export function spring(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const zeta = clamp(finiteOr(settings.damping, 0.8), 0, 10)
  const frequency = Math.max(1e-3, finiteOr(settings.frequency, 2))
  const time = finiteOr(settings.t, 0)
  if (time <= 0) return 0
  const w = 2 * Math.PI * frequency
  const decay = Math.exp(-zeta * w * time)
  if (zeta < 1 - 1e-6) {
    // Under-damped: decaying cosine ringing around the target.
    const damped = w * Math.sqrt(1 - zeta * zeta)
    return 1 - decay * (Math.cos(damped * time) + ((zeta * w) / damped) * Math.sin(damped * time))
  }
  if (zeta <= 1 + 1e-6) {
    // Critically damped: fastest approach that never crosses the target.
    return 1 - decay * (1 + w * time)
  }
  // Over-damped: sum of two real exponential modes.
  const root = w * Math.sqrt(zeta * zeta - 1)
  const r1 = -zeta * w + root
  const r2 = -zeta * w - root
  return 1 - (r2 * Math.exp(r1 * time) - r1 * Math.exp(r2 * time)) / (r2 - r1)
}

/* ------------------------------------------------------------------ *
 * Named curve catalogue (the 12 standard curves)
 * ------------------------------------------------------------------ */

/** CSS strings of the named curves (elastic: nearest single-overshoot approximation). */
const CURVE_CSS = {
  linear: 'linear',
  ease: 'ease',
  'ease-in': 'ease-in',
  'ease-out': 'ease-out',
  'ease-in-out': 'ease-in-out',
  'expo.out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'expo.in': 'cubic-bezier(0.7, 0, 0.84, 0)',
  'power2.inOut': 'cubic-bezier(0.45, 0, 0.55, 1)',
  'power2.out': 'cubic-bezier(0.5, 1, 0.89, 1)',
  'power3.in': 'cubic-bezier(0.32, 0, 0.67, 0)',
  'back.out(1.4)': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  // One CSS timing-function cannot express a damped oscillation, so the entry
  // ships the nearest single-overshoot approximation and marks cssExact: false.
  'elastic.out(1,0.5)': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
}

/** Which named curves never go backwards (used by tests and motion linters). */
const CURVE_MONOTONIC = {
  linear: true,
  ease: true,
  'ease-in': true,
  'ease-out': true,
  'ease-in-out': true,
  'expo.out': true,
  'expo.in': true,
  'power2.inOut': true,
  'power2.out': true,
  'power3.in': true,
  'back.out(1.4)': false,
  'elastic.out(1,0.5)': false,
}

/** Short Chinese guidance so a report can quote what a curve feels like. */
const CURVE_FEEL_ZH = {
  linear: '匀速：只适合进度条、时钟或刻意机械感',
  ease: '浏览器默认：首尾都很软，最不"设计师"的一条',
  'ease-in': '慢起快收：加速离场、下落',
  'ease-out': '快起慢收：最常见入场，收尾自然',
  'ease-in-out': '两端都缓：适合位移、镜头起停',
  'expo.out': '长尾入场：0.2 秒内到位、最后 0.6 秒几乎不动（高级感标题）',
  'expo.in': '长尾加速离场：先慢后突然加速（元素飞出/坠落）',
  'power2.inOut': '双端二次缓动：镜头和位移的默认手感',
  'power2.out': '双端偏软收：卡片、面板入场',
  'power3.in': '三次加速：比 expo.in 更急的离场',
  'back.out(1.4)': '过冲回弹：到位后轻微回撤（1.4 = 克制版回弹）',
  'elastic.out(1,0.5)': '弹性振荡：2–3 次回弹后停住（CSS 只能近似成单次过冲）',
}

/**
 * The 12 named easing curves. Each entry is `{ css, cssApprox, cssExact, fn,
 * monotonic, nameZh, feelZh }` — `css` is a directly usable CSS timing function.
 * For every curve except elastic it is exact; elastic cannot be expressed by one
 * CSS timing function, so its `css`/`cssApprox` carry the nearest single-overshoot
 * approximation and `cssExact` is false (use `fn` or MS.spring for the real ring).
 */
export const EASINGS = {
  linear: {
    css: CURVE_CSS.linear,
    cssApprox: null,
    monotonic: CURVE_MONOTONIC.linear,
    nameZh: '线性',
    feelZh: CURVE_FEEL_ZH.linear,
    fn: (t) => (Number.isFinite(t) && t > 0 ? (t >= 1 ? 1 : t) : 0),
  },
  ease: {
    css: CURVE_CSS.ease,
    cssApprox: null,
    monotonic: CURVE_MONOTONIC.ease,
    nameZh: '默认缓动',
    feelZh: CURVE_FEEL_ZH.ease,
    fn: cubicBezier(0.25, 0.1, 0.25, 1),
  },
  'ease-in': {
    css: CURVE_CSS['ease-in'],
    cssApprox: null,
    monotonic: CURVE_MONOTONIC['ease-in'],
    nameZh: '缓入',
    feelZh: CURVE_FEEL_ZH['ease-in'],
    fn: cubicBezier(0.42, 0, 1, 1),
  },
  'ease-out': {
    css: CURVE_CSS['ease-out'],
    cssApprox: null,
    monotonic: CURVE_MONOTONIC['ease-out'],
    nameZh: '缓出',
    feelZh: CURVE_FEEL_ZH['ease-out'],
    fn: cubicBezier(0, 0, 0.58, 1),
  },
  'ease-in-out': {
    css: CURVE_CSS['ease-in-out'],
    cssApprox: null,
    monotonic: CURVE_MONOTONIC['ease-in-out'],
    nameZh: '缓入缓出',
    feelZh: CURVE_FEEL_ZH['ease-in-out'],
    fn: cubicBezier(0.42, 0, 0.58, 1),
  },
  'expo.out': {
    css: CURVE_CSS['expo.out'],
    cssApprox: null,
    monotonic: CURVE_MONOTONIC['expo.out'],
    nameZh: '指数缓出（长尾入场）',
    feelZh: CURVE_FEEL_ZH['expo.out'],
    fn: cubicBezier(0.16, 1, 0.3, 1),
  },
  'expo.in': {
    css: CURVE_CSS['expo.in'],
    cssApprox: null,
    monotonic: CURVE_MONOTONIC['expo.in'],
    nameZh: '指数缓入（长尾离场）',
    feelZh: CURVE_FEEL_ZH['expo.in'],
    fn: cubicBezier(0.7, 0, 0.84, 0),
  },
  'power2.inOut': {
    css: CURVE_CSS['power2.inOut'],
    cssApprox: null,
    monotonic: CURVE_MONOTONIC['power2.inOut'],
    nameZh: '二次双端缓动',
    feelZh: CURVE_FEEL_ZH['power2.inOut'],
    fn: cubicBezier(0.45, 0, 0.55, 1),
  },
  'power2.out': {
    css: CURVE_CSS['power2.out'],
    cssApprox: null,
    monotonic: CURVE_MONOTONIC['power2.out'],
    nameZh: '二次缓出',
    feelZh: CURVE_FEEL_ZH['power2.out'],
    fn: cubicBezier(0.5, 1, 0.89, 1),
  },
  'power3.in': {
    css: CURVE_CSS['power3.in'],
    cssApprox: null,
    monotonic: CURVE_MONOTONIC['power3.in'],
    nameZh: '三次加速（急离场）',
    feelZh: CURVE_FEEL_ZH['power3.in'],
    fn: cubicBezier(0.32, 0, 0.67, 0),
  },
  'back.out(1.4)': {
    css: CURVE_CSS['back.out(1.4)'],
    cssApprox: null,
    monotonic: CURVE_MONOTONIC['back.out(1.4)'],
    nameZh: '过冲回弹（克制版）',
    feelZh: CURVE_FEEL_ZH['back.out(1.4)'],
    fn: backOut(1.4),
  },
  'elastic.out(1,0.5)': {
    css: CURVE_CSS['elastic.out(1,0.5)'],
    cssApprox: CURVE_CSS['elastic.out(1,0.5)'],
    monotonic: CURVE_MONOTONIC['elastic.out(1,0.5)'],
    nameZh: '弹性振荡',
    feelZh: CURVE_FEEL_ZH['elastic.out(1,0.5)'],
    fn: elasticOut(1, 0.5),
  },
}

// `css` is an exact CSS timing function for every curve except elastic, where CSS
// cannot express the damped ringing; there it is the nearest single-overshoot
// approximation (same value as cssApprox). Renderers that need exactness must use
// the `fn` curve or MS.spring.
for (const [name, entry] of Object.entries(EASINGS)) {
  entry.cssExact = name !== 'elastic.out(1,0.5)'
}

/** Ordered list of the 12 named curve ids. */
export const EASE_NAMES = Object.keys(EASINGS)

/** Look up one named curve (null when unknown). */
export function getEasing(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(EASINGS, name) ? EASINGS[name] : null
}

/** Look up one named curve's function (null when unknown). */
export function easingFn(name) {
  const entry = getEasing(name)
  return entry === null ? null : entry.fn
}

/** Evaluate a named curve: `ease('expo.out', 0.5)`. Unknown names return NaN. */
export function ease(name, t) {
  const fn = easingFn(name)
  return fn === null ? Number.NaN : fn(t)
}

/** Return the CSS timing-function string for a named curve (approx for elastic). */
export function easeCss(name) {
  const entry = getEasing(name)
  if (entry === null) return null
  return entry.css ?? entry.cssApprox
}

/* ------------------------------------------------------------------ *
 * Role presets: what the motion is *for* decides the curve
 * ------------------------------------------------------------------ */

/**
 * Purpose → named curve. Rationale (the vocabulary the model should learn):
 *   enter  — long-tail `expo.out`: lands within ~20% of the time, then holds. Reads
 *            confident; the default for titles, cards and overlays.
 *   move   — symmetric `power2.inOut`: both ends eased, so a translation neither
 *            starts nor stops abruptly. The default for object moves and pans.
 *   exit   — accelerating `power3.in`: leave quickly and get out of the way;
 *            never ease out an exit (it looks hesitant).
 *   camera — classic both-ended `ease-in-out`: a camera has mass; it accelerates
 *            and decelerates, and any long-tail entry would read as a mistake.
 */
export const EASE_ROLES = {
  enter: 'expo.out',
  move: 'power2.inOut',
  exit: 'power3.in',
  camera: 'ease-in-out',
}

/** Chinese rationale for each role (used by model-facing reports). */
export const EASE_ROLE_NOTES = {
  enter: '入场用长尾曲线：20% 时间到位，剩余时间几乎不动',
  move: '位移用双端曲线：起停都要缓，避免"啪"地停住',
  exit: '离场用加速曲线：先慢后快，果断离开画面',
  camera: '运镜用两端缓动：摄影机有质量，起停都要过渡',
}

/**
 * Resolve a role to its easing function.
 * @param {'enter'|'move'|'exit'|'camera'|string} role
 * @returns {((t: number) => number) | null}
 */
export function easeForRole(role) {
  if (typeof role !== 'string') return null
  const name = EASE_ROLES[role]
  if (typeof name !== 'string') return null
  return easingFn(name)
}

/* ------------------------------------------------------------------ *
 * Browser prelude
 * ------------------------------------------------------------------ */

/**
 * Self-contained JS string that installs the same vocabulary on `window.MS`:
 *
 *   MS.ease(name, t)               // named curve, e.g. MS.ease('expo.out', 0.6)
 *   MS.easeCss(name)               // CSS timing-function string
 *   MS.easings                     // name -> function
 *   MS.cubicBezier(x1,y1,x2,y2)    // returns a function
 *   MS.spring({damping, frequency, t})
 *   MS.inertia(t) / MS.smoothstep(t) / MS.smootherstep(t)
 *
 * It is written in plain ES5 on purpose (safe for any injected <script>) and has
 * no imports. The maths is duplicated from this module; the unit test samples
 * both implementations and asserts they agree to 1e-6.
 *
 * @returns {string} a `<script>`-ready IIFE
 */
export function browserPrelude() {
  return `(function (window) {
  'use strict'
  function cubicBezier(x1, y1, x2, y2) {
    var ax = 3 * x1 - 3 * x2 + 1
    var bx = 3 * x2 - 6 * x1
    var cx = 3 * x1
    var ay = 3 * y1 - 3 * y2 + 1
    var by = 3 * y2 - 6 * y1
    var cy = 3 * y1
    function sampleX(t) { return ((ax * t + bx) * t + cx) * t }
    function sampleY(t) { return ((ay * t + by) * t + cy) * t }
    function slopeX(t) { return (3 * ax * t + 2 * bx) * t + cx }
    function solveX(x) {
      var t = x
      var i
      for (i = 0; i < 8; i += 1) {
        var error = sampleX(t) - x
        if (Math.abs(error) < 1e-7) return t
        var slope = slopeX(t)
        if (Math.abs(slope) < 1e-6) break
        t -= error / slope
        if (t < 0 || t > 1) break
      }
      var low = 0
      var high = 1
      t = x
      for (i = 0; i < 40; i += 1) {
        var value = sampleX(t)
        if (Math.abs(value - x) < 1e-7) break
        if (value < x) low = t
        else high = t
        t = (low + high) / 2
      }
      return t
    }
    return function (t) {
      if (!(t > 0)) return 0
      if (t >= 1) return 1
      return sampleY(solveX(t))
    }
  }
  function backOut(overshoot) {
    var c1 = overshoot
    var c3 = c1 + 1
    return function (t) {
      if (!(t > 0)) return 0
      if (t >= 1) return 1
      var p = t - 1
      return 1 + c3 * p * p * p + c1 * p * p
    }
  }
  function elasticOut(amplitude, period) {
    var a = amplitude > 1 ? amplitude : 1
    var p = period > 0 ? period : 0.5
    var c4 = (2 * Math.PI) / p
    var shift = Math.asin(1 / a) / c4
    return function (t) {
      if (!(t > 0)) return 0
      if (t >= 1) return 1
      return a * Math.pow(2, -10 * t) * Math.sin((t - shift) * c4) + 1
    }
  }
  function spring(options) {
    var opts = options || {}
    var zeta = typeof opts.damping === 'number' ? opts.damping : 0.8
    if (!(zeta >= 0)) zeta = 0
    if (zeta > 10) zeta = 10
    var frequency = typeof opts.frequency === 'number' ? opts.frequency : 2
    if (!(frequency > 0)) frequency = 2
    var time = typeof opts.t === 'number' ? opts.t : 0
    if (!(time > 0)) return 0
    var w = 2 * Math.PI * frequency
    var decay = Math.exp(-zeta * w * time)
    if (zeta < 1 - 1e-6) {
      var damped = w * Math.sqrt(1 - zeta * zeta)
      return 1 - decay * (Math.cos(damped * time) + ((zeta * w) / damped) * Math.sin(damped * time))
    }
    if (zeta <= 1 + 1e-6) {
      return 1 - decay * (1 + w * time)
    }
    var root = w * Math.sqrt(zeta * zeta - 1)
    var r1 = -zeta * w + root
    var r2 = -zeta * w - root
    return 1 - (r2 * Math.exp(r1 * time) - r1 * Math.exp(r2 * time)) / (r2 - r1)
  }
  function smootherstep(t) {
    if (!(t > 0)) return 0
    if (t >= 1) return 1
    return t * t * t * (t * (t * 6 - 15) + 10)
  }
  function smoothstep(t) {
    if (!(t > 0)) return 0
    if (t >= 1) return 1
    return t * t * (3 - 2 * t)
  }
  function inertia(t) {
    if (!(t > 0)) return 0
    if (t >= 1) return 1
    return 0.35 * t + 0.65 * smootherstep(t)
  }
  var EASINGS = {
    'linear': function (t) { return t > 0 ? (t >= 1 ? 1 : t) : 0 },
    'ease': cubicBezier(0.25, 0.1, 0.25, 1),
    'ease-in': cubicBezier(0.42, 0, 1, 1),
    'ease-out': cubicBezier(0, 0, 0.58, 1),
    'ease-in-out': cubicBezier(0.42, 0, 0.58, 1),
    'expo.out': cubicBezier(0.16, 1, 0.3, 1),
    'expo.in': cubicBezier(0.7, 0, 0.84, 0),
    'power2.inOut': cubicBezier(0.45, 0, 0.55, 1),
    'power2.out': cubicBezier(0.5, 1, 0.89, 1),
    'power3.in': cubicBezier(0.32, 0, 0.67, 0),
    'back.out(1.4)': backOut(1.4),
    'elastic.out(1,0.5)': elasticOut(1, 0.5)
  }
  var EASE_CSS = {
    'linear': 'linear',
    'ease': 'ease',
    'ease-in': 'ease-in',
    'ease-out': 'ease-out',
    'ease-in-out': 'ease-in-out',
    'expo.out': 'cubic-bezier(0.16, 1, 0.3, 1)',
    'expo.in': 'cubic-bezier(0.7, 0, 0.84, 0)',
    'power2.inOut': 'cubic-bezier(0.45, 0, 0.55, 1)',
    'power2.out': 'cubic-bezier(0.5, 1, 0.89, 1)',
    'power3.in': 'cubic-bezier(0.32, 0, 0.67, 0)',
    'back.out(1.4)': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    'elastic.out(1,0.5)': null
  }
  var MS = window.MS || (window.MS = {})
  MS.ease = function (name, t) {
    var fn = EASINGS[name]
    return typeof fn === 'function' ? fn(t) : NaN
  }
  MS.easeCss = function (name) {
    if (Object.prototype.hasOwnProperty.call(EASE_CSS, name)) {
      return EASE_CSS[name] === null ? 'cubic-bezier(0.34, 1.56, 0.64, 1)' : EASE_CSS[name]
    }
    return null
  }
  MS.easings = EASINGS
  MS.cubicBezier = cubicBezier
  MS.spring = spring
  MS.smoothstep = smoothstep
  MS.smootherstep = smootherstep
  MS.inertia = inertia
  MS.easeRole = function (role, t) {
    var names = { enter: 'expo.out', move: 'power2.inOut', exit: 'power3.in', camera: 'ease-in-out' }
    var name = names[role]
    return typeof name === 'string' && typeof EASINGS[name] === 'function' ? EASINGS[name](t) : NaN
  }
  return MS
})(typeof window !== 'undefined' ? window : this)`
}

export default {
  cubicBezier,
  spring,
  smoothstep,
  smootherstep,
  inertia,
  EASINGS,
  EASE_NAMES,
  EASE_ROLES,
  EASE_ROLE_NOTES,
  SPRING_FEEL,
  ease,
  easeCss,
  easingFn,
  getEasing,
  easeForRole,
  backOut,
  elasticOut,
  browserPrelude,
}
