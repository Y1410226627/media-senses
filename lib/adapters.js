/**
 * Runtime adapters for third-party animation engines.
 *
 * The renderer can already seek three things on its own: CSS/WAAPI animations,
 * `window.__timelines` entries and declarative clips. That leaves the engines a
 * model is most likely to reach for — Lottie, Three.js, Anime.js — with no way to
 * say "put this object at time t".
 *
 * This module provides the page-side extension point that closes the gap:
 *
 *   - `MS.onSeek(fn)` registers any function as a frame clock listener. That is
 *     the generic answer: three.js mixers, custom canvas engines, physics
 *     replays all reduce to "call this with t".
 *   - `MS.lottie(anim)` registers a Lottie animation and seeks it by frame.
 *   - `MS.three({ mixer, renderer, scene, camera })` registers a three.js rig.
 *   - `MS.anime(timeline)` registers an Anime.js timeline (which is in ms).
 *   - `MS.ease(name, t)` / `MS.spring(...)` / `MS.inertia(t)` are the same curves
 *     the plugin's own vocabulary uses, so a page does not have to re-derive them.
 *
 * The prelude is deliberately dependency-free and defensive: half of these
 * libraries may be absent, and a missing library must never break a render.
 *
 * @module lib/adapters
 */

/**
 * Easing curves mirrored into the page.
 *
 * Kept as source rather than importing `lib/easing.js` because this string is
 * evaluated inside the browser, where module syntax is not available.
 */
const EASING_SOURCE = `
    function cubicBezier(x1, y1, x2, y2) {
      function sample(t, a1, a2) { return 3 * a1 * t * (1 - t) * (1 - t) + 3 * a2 * t * t * (1 - t) + t * t * t; }
      function slope(t, a1, a2) { return 3 * a1 * (1 - t) * (1 - t) + 6 * (a2 - a1) * t * (1 - t) + 3 * (1 - a2) * t * t; }
      return function (x) {
        if (!(x > 0)) return 0;
        if (x >= 1) return 1;
        var t = x;
        for (var i = 0; i < 8; i += 1) {
          var dx = sample(t, x1, x2) - x;
          if (Math.abs(dx) < 1e-5) break;
          var d = slope(t, x1, x2);
          if (Math.abs(d) < 1e-6) break;
          t -= dx / d;
        }
        var low = 0;
        var high = 1;
        for (var j = 0; j < 12; j += 1) {
          var value = sample(t, x1, x2);
          if (Math.abs(value - x) < 1e-5) break;
          if (value < x) low = t; else high = t;
          t = (low + high) / 2;
        }
        return sample(t, y1, y2);
      };
    }
    var CURVES = {
      linear: function (t) { return t; },
      'ease-in-out': cubicBezier(0.42, 0, 0.58, 1),
      'expo.out': cubicBezier(0.16, 1, 0.3, 1),
      'power2.inOut': cubicBezier(0.45, 0, 0.55, 1),
      'power3.in': cubicBezier(0.32, 0, 0.67, 0),
      'back.out': function (t) { var c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
    };
    function ease(name, t) {
      var curve = CURVES[name];
      if (curve === undefined) curve = CURVES.linear;
      return curve(Math.max(0, Math.min(1, t)));
    }
    function spring(options, t) {
      var damping = options && options.damping !== undefined ? options.damping : 0.75;
      var frequency = options && options.frequency !== undefined ? options.frequency : 1.6;
      var seconds = Math.max(0, t);
      if (damping >= 1) {
        var w = frequency * Math.PI * 2;
        return 1 - Math.exp(-w * seconds) * (1 + w * seconds);
      }
      var omega = frequency * Math.PI * 2;
      var decay = Math.exp(-damping * omega * seconds);
      var omegaD = omega * Math.sqrt(1 - damping * damping);
      return 1 - decay * (Math.cos(omegaD * seconds) + (damping * omega / omegaD) * Math.sin(omegaD * seconds));
    }
    function smootherstep(t) {
      var v = Math.max(0, Math.min(1, t));
      return v * v * v * (v * (v * 6 - 15) + 10);
    }
    function inertia(t) {
      var v = Math.max(0, Math.min(1, t));
      return 0.35 * v + 0.65 * smootherstep(v);
    }
`

/**
 * Source for `window.MS`, the page-side adapter object.
 *
 * Injected before any page script, so a template can call `MS.spring(...)` at
 * module evaluation time.
 *
 * @returns {string} a self-contained script body (no imports)
 */
export function adapterPreludeSource() {
  return `;(() => {
  'use strict';
  try {
    var MS = window.MS || {};
    MS.seekers = MS.seekers || [];
    MS.lottieAnimations = MS.lottieAnimations || [];
    MS.threeRigs = MS.threeRigs || [];
    MS.animeTimelines = MS.animeTimelines || [];
    MS.time = 0;
${EASING_SOURCE}
    MS.ease = ease;
    MS.spring = spring;
    MS.inertia = inertia;
    MS.smootherstep = smootherstep;
    MS.cubicBezier = cubicBezier;
    MS.curves = Object.keys(CURVES);

    /** Register any function as a per-frame listener. */
    MS.onSeek = function (fn) {
      if (typeof fn === 'function') MS.seekers.push(fn);
      return fn;
    };
    /** Register a Lottie animation; it is seeked by frame at \`fps\`. */
    MS.lottie = function (animation, fps) {
      if (animation && typeof animation.goToAndStop === 'function') {
        MS.lottieAnimations.push({ animation: animation, fps: fps > 0 ? fps : 30 });
      }
      return animation;
    };
    /**
     * Register a three.js rig. \`mixer\` advances animation clips, and if a
     * renderer/scene/camera triple is given the frame is drawn here.
     */
    MS.three = function (rig) {
      if (rig && (rig.mixer || (rig.renderer && rig.scene && rig.camera))) MS.threeRigs.push(rig);
      return rig;
    };
    /** Register an Anime.js timeline (its \`seek\` takes milliseconds). */
    MS.anime = function (timeline) {
      if (timeline && typeof timeline.seek === 'function') MS.animeTimelines.push(timeline);
      return timeline;
    };

    /** Advance every registered adapter to \`seconds\`. Called by the renderer. */
    MS.seek = function (seconds) {
      MS.time = seconds;
      for (var i = 0; i < MS.seekers.length; i += 1) {
        try { MS.seekers[i](seconds); } catch (error) {}
      }
      for (var j = 0; j < MS.lottieAnimations.length; j += 1) {
        try {
          var entry = MS.lottieAnimations[j];
          entry.animation.goToAndStop(seconds * entry.fps, true);
        } catch (error) {}
      }
      for (var k = 0; k < MS.animeTimelines.length; k += 1) {
        try { MS.animeTimelines[k].seek(seconds * 1000); } catch (error) {}
      }
      for (var m = 0; m < MS.threeRigs.length; m += 1) {
        try {
          var rig = MS.threeRigs[m];
          if (rig.mixer && typeof rig.mixer.setTime === 'function') rig.mixer.setTime(seconds);
          if (rig.renderer && rig.scene && rig.camera) rig.renderer.render(rig.scene, rig.camera);
        } catch (error) {}
      }
    };

    window.MS = MS;
  } catch (error) {}
})();`
}

/**
 * Catalogue of supported engines, for the model-facing report.
 *
 * `howZh` is the line that matters: it tells the model exactly what call to make
 * to get that engine onto the frame clock.
 */
export const ADAPTERS = Object.freeze([
  {
    id: 'renderAt',
    nameZh: 'window.renderAt(t)',
    howZh: '页面自己实现 `window.renderAt = async (t) => {…}`，整帧由 t 决定。最可控，优先用它。',
    auto: true,
  },
  {
    id: 'css',
    nameZh: 'CSS @keyframes / WAAPI',
    howZh: '什么都不用做：渲染器每帧把 `document.getAnimations()` 全部 pause 并 seek 到 t。',
    auto: true,
  },
  {
    id: 'timelines',
    nameZh: 'GSAP / 任意时间轴对象',
    howZh: '建完 paused 时间轴后注册：`window.__timelines = window.__timelines || {}; window.__timelines.main = tl`。支持 `seek(t)` / `time(t)` / `progress(t)`。',
    auto: true,
  },
  {
    id: 'clips',
    nameZh: '声明式 clip',
    howZh: '合成根写 `data-composition-id` + `data-duration`，每个元素写 `class="clip" data-start data-duration`。渲染器负责显隐。',
    auto: true,
  },
  {
    id: 'lottie',
    nameZh: 'Lottie / Bodymovin',
    howZh: '`lottie.loadAnimation({...})` 之后调 `MS.lottie(anim, fps)`；渲染器会用 `goToAndStop(帧)` 精确定位。',
    auto: false,
  },
  {
    id: 'three',
    nameZh: 'Three.js',
    howZh: '`MS.three({ mixer, renderer, scene, camera })`：每帧 `mixer.setTime(t)` 并重新渲染。相机/物体请由 t 推导，不要用自带 clock。',
    auto: false,
  },
  {
    id: 'anime',
    nameZh: 'Anime.js',
    howZh: '`MS.anime(timeline)`：Anime 的 seek 用毫秒，渲染器会自动乘 1000。',
    auto: false,
  },
  {
    id: 'custom',
    nameZh: '任意自研引擎',
    howZh: '`MS.onSeek(t => { /* 把整个世界推进到 t */ })`：注册一次，之后每帧都会被调用。这是通用逃生口。',
    auto: false,
  },
])

/** Render the adapter catalogue as Markdown. */
export function renderAdapterTable() {
  const lines = []
  lines.push('| 引擎 | 怎么让它跟着帧走 | 是否自动 |')
  lines.push('|------|------------------|----------|')
  for (const adapter of ADAPTERS) {
    lines.push(`| ${adapter.nameZh} | ${adapter.howZh} | ${adapter.auto ? '自动' : '需注册一行'} |`)
  }
  return lines.join('\n')
}

export default { ADAPTERS, adapterPreludeSource, renderAdapterTable }
