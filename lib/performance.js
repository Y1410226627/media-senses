/**
 * Character performance: the timing rules that make a drawn character look alive.
 *
 * A character that is drawn nicely but never blinks, never anticipates and never
 * settles reads as a puppet. The numbers below come from frame-by-frame
 * measurement of hand-made character animation, and they are the rules this
 * module encodes:
 *
 *   - **blink**: every 0.5–2.3 s, and always on a change of expression; the lid
 *     shape is four frames `[half, closed, closed, half]`, never a linear fade.
 *   - **bob**: 3–7 % of body height, lowest point on foot contact (never in the
 *     air), which is what separates a walk from a hover.
 *   - **lean**: about 1° when passing, 5–7° on contact, in phase with the bob.
 *   - **step**: 9–12 frames per step (2.5–3.3 steps/s); the foot stays planted, so
 *     stride length follows speed instead of sliding.
 *   - **acting beat**: 4–7 frames of anticipation (about 6 held), a single frame
 *     for the strike, then 4–5 frames to recover. The single frame is the whole
 *     trick: a multi-frame strike reads as a slide.
 *   - **expression lead**: an expression or gesture starts 0–3 frames *before*
 *     the word or beat it belongs to.
 *
 * Everything here is a pure function of time so a frame can be rendered alone.
 *
 * @module lib/performance
 */

/** Measured timing rules. Every consumer should read these instead of hardcoding. */
export const PERFORMANCE = Object.freeze({
  /** Frames per step at 24 fps. */
  stepFrames: [9, 12],
  /** Body bob as a share of character height. */
  bobShare: [0.03, 0.07],
  /** Lean in degrees: passing pose, contact pose. */
  leanDeg: { passing: 1, contact: [5, 7] },
  /** Blink interval in seconds. */
  blinkIntervalSec: [0.5, 2.3],
  /** Blink lid samples as a fraction of closure (four frames). */
  blinkShape: [0.5, 1, 1, 0.5],
  /** Anticipation hold in frames (the "coil" before a move). */
  anticipationFrames: [4, 7],
  /** The strike itself: exactly this many frames. */
  strikeFrames: 1,
  /** Recovery frames after the strike. */
  recoverFrames: [4, 5],
  /** How many frames before its cue a gesture or expression starts. */
  expressionLeadFrames: [0, 3],
  /** Heads-tall proportion a readable character drawing usually keeps. */
  headRatio: 3.5,
})

/**
 * Emotion presets, parameterised rather than described.
 *
 * `brow` and `mouth` are normalised -1..1 (brow up/down, mouth frown/smile);
 * `energy` scales gesture amplitude; `lean` is degrees of whole-body tilt.
 * The set deliberately covers the emotions a short film actually needs.
 */
export const EMOTIONS = Object.freeze({
  neutral: { nameZh: '平静', brow: 0, eyeOpen: 1, mouth: 0, lean: 0, energy: 0.5 },
  happy: { nameZh: '高兴', brow: 0.25, eyeOpen: 0.88, mouth: 0.8, lean: -3, energy: 0.75 },
  excited: { nameZh: '兴奋', brow: 0.5, eyeOpen: 1.15, mouth: 0.9, lean: -6, energy: 1 },
  curious: { nameZh: '好奇', brow: 0.35, eyeOpen: 1.1, mouth: 0.25, lean: 4, energy: 0.6 },
  worried: { nameZh: '担心', brow: -0.4, eyeOpen: 0.95, mouth: -0.35, lean: 5, energy: 0.35 },
  sad: { nameZh: '难过', brow: -0.55, eyeOpen: 0.7, mouth: -0.7, lean: 7, energy: 0.2 },
  angry: { nameZh: '生气', brow: -0.7, eyeOpen: 0.85, mouth: -0.5, lean: -4, energy: 0.95 },
  surprised: { nameZh: '惊讶', brow: 0.7, eyeOpen: 1.4, mouth: 0.6, lean: 0, energy: 0.8 },
  tired: { nameZh: '疲惫', brow: -0.2, eyeOpen: 0.5, mouth: -0.2, lean: 6, energy: 0.15 },
  thinking: { nameZh: '思考', brow: -0.15, eyeOpen: 0.9, mouth: -0.1, lean: 3, energy: 0.4 },
})

const NAMES = Object.keys(EMOTIONS)

/** Total length of one acting beat, in frames. */
export function actingBeatFrames() {
  return PERFORMANCE.anticipationFrames[1] + PERFORMANCE.strikeFrames + PERFORMANCE.recoverFrames[1]
}

/**
 * Progress through an acting beat at a given frame.
 *
 * Phases: `anticipation` (holds, pulling back), `strike` (one frame), `recover`
 * (settling with a little overshoot), then `done`.
 *
 * @param {number} frame frame index inside the beat (0-based)
 * @returns {{phase: 'anticipation'|'strike'|'recover'|'done', progress: number, pose: number}}
 *   `pose` is -1 (fully coiled) .. 0 (neutral) .. 1 (fully extended)
 */
export function actingBeat(frame) {
  const coil = PERFORMANCE.anticipationFrames[0]
  const held = PERFORMANCE.anticipationFrames[1]
  const strike = PERFORMANCE.strikeFrames
  const recover = PERFORMANCE.recoverFrames[1]
  if (frame < 0) return { phase: 'done', progress: 0, pose: 0 }
  if (frame < coil) {
    // Ramps back over the first frames of the anticipation, then holds.
    return { phase: 'anticipation', progress: frame / Math.max(1, coil), pose: -frame / Math.max(1, coil) }
  }
  if (frame < held) return { phase: 'anticipation', progress: 1, pose: -1 }
  if (frame < held + strike) return { phase: 'strike', progress: 1, pose: 1 }
  const recoverFrame = frame - held - strike
  if (recoverFrame < recover) {
    // A damped settle: it leaves full extension, crosses neutral and swings back
    // a little before landing exactly on 0. A linear return reads as robotic, and
    // an overshoot that only appears on the last frame is not visible at all.
    const p = recoverFrame / Math.max(1, recover)
    return { phase: 'recover', progress: p, pose: (1 - p) * Math.cos(p * Math.PI * 1.2) }
  }
  return { phase: 'done', progress: 1, pose: 0 }
}

/**
 * Eyelid closure at a time, on the measured blink schedule.
 *
 * @param {number} t seconds
 * @param {number} [fps=24]
 * @param {{offset?: number, interval?: number}} [options]
 *   `offset` shifts the phase so several characters do not blink together;
 *   `interval` overrides the cycle (seconds).
 * @returns {number} 0 (open) .. 1 (closed)
 */
export function blinkAt(t, fps = 24, options = {}) {
  const interval = Number.isFinite(options.interval) && options.interval > 0
    ? options.interval
    : (PERFORMANCE.blinkIntervalSec[0] + PERFORMANCE.blinkIntervalSec[1]) / 2
  const offset = Number.isFinite(options.offset) ? options.offset : 0
  const frame = (t + offset) * fps
  const blinkFrames = PERFORMANCE.blinkShape.length
  // A blink occupies `blinkFrames` frames once per `interval`.
  const cycleFrames = interval * fps
  const position = frame % cycleFrames
  if (position >= blinkFrames) return 0
  return PERFORMANCE.blinkShape[Math.floor(position)]
}

/**
 * Walk cycle pose: bob, lean and foot phase for a character moving at `speed`.
 *
 * @param {object} options
 * @param {number} options.t seconds
 * @param {number} [options.fps=24]
 * @param {number} [options.speed] steps per second (default 2.9, mid-band)
 * @param {number} [options.height=400] character height in px
 * @param {number} [options.phase=0] 0..1 cycle offset
 * @returns {{bobPx: number, leanDeg: number, step: number, planted: 'left'|'right', contact: boolean}}
 */
export function walkAt({ t, fps = 24, speed = 2.9, height = 400, phase = 0 }) {
  const stepsPerSecond = Math.max(2.5, Math.min(3.3, speed))
  const stepFrames = Math.max(PERFORMANCE.stepFrames[0], Math.min(PERFORMANCE.stepFrames[1], Math.round(fps / stepsPerSecond)))
  const cycle = (t + phase) * fps
  const stepIndex = Math.floor(cycle / stepFrames)
  const within = (cycle % stepFrames) / stepFrames
  // Two bobs per full stride (one per foot contact).
  const bobPhase = Math.sin(Math.PI * (within * 2 - 0.5))
  const bobRange = PERFORMANCE.bobShare
  const bobPx = -((bobRange[0] + bobRange[1]) / 2) * height * (0.5 + 0.5 * bobPhase)
  // Lean is largest at contact, smallest at the passing pose.
  const contact = within < 0.16 || within > 0.84
  const leanDeg = contact
    ? PERFORMANCE.leanDeg.contact[1]
    : PERFORMANCE.leanDeg.passing
  return {
    bobPx: Math.round(bobPx * 100) / 100,
    leanDeg: Math.round(leanDeg * 10) / 10,
    step: stepIndex,
    planted: stepIndex % 2 === 0 ? 'left' : 'right',
    contact,
  }
}

/**
 * Full pose for one frame: emotion, blink and (optionally) walk, all in phase.
 *
 * @param {object} options
 * @param {string} options.emotion one of {@link EMOTIONS} (or 'neutral')
 * @param {number} options.t seconds
 * @param {number} [options.fps=24]
 * @param {number} [options.height=400]
 * @param {boolean} [options.walking=false]
 * @param {number} [options.speed=2.9]
 * @param {number} [options.phase=0]
 * @param {number} [options.blinkOffset]
 * @param {number} [options.energyScale=1] multiplies the emotion's energy
 * @returns {{brow: number, eyeOpen: number, mouth: number, leanDeg: number, bobPx: number, blink: number, energy: number}}
 */
export function poseAt(options = {}) {
  const emotion = EMOTIONS[options.emotion] ?? EMOTIONS.neutral
  const fps = Number.isFinite(options.fps) ? options.fps : 24
  const height = Number.isFinite(options.height) ? options.height : 400
  const energyScale = Number.isFinite(options.energyScale) ? options.energyScale : 1
  const blink = blinkAt(options.t, fps, { offset: options.blinkOffset })
  const walk = options.walking === true
    ? walkAt({ t: options.t, fps, speed: options.speed, height, phase: options.phase })
    : { bobPx: 0, leanDeg: 0 }
  return {
    brow: emotion.brow,
    eyeOpen: emotion.eyeOpen * (1 - blink * 0.92),
    mouth: emotion.mouth,
    leanDeg: round2(emotion.lean + walk.leanDeg),
    bobPx: round2(walk.bobPx),
    blink,
    energy: round2(Math.max(0, Math.min(1.5, emotion.energy * energyScale))),
  }
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * Page-side prelude exposing the same rules as `MS.performance`.
 *
 * Kept as source so a HTML template can call it without a bundler.
 *
 * @returns {string}
 */
export function performancePreludeSource() {
  const payload = JSON.stringify({ emotions: EMOTIONS, performance: PERFORMANCE })
  return `;(() => {
  'use strict';
  try {
    var DATA = ${payload};
    var MS = window.MS || (window.MS = {});
    MS.emotions = DATA.emotions;
    MS.performance = DATA.performance;
    function round2(value) { return Math.round(value * 100) / 100; }
    MS.blinkAt = function (t, fps, interval) {
      var rate = fps > 0 ? fps : 24;
      var cycle = interval > 0 ? interval : (DATA.performance.blinkIntervalSec[0] + DATA.performance.blinkIntervalSec[1]) / 2;
      var frame = t * rate;
      var shape = DATA.performance.blinkShape;
      var position = frame % (cycle * rate);
      if (position >= shape.length) return 0;
      return shape[Math.floor(position)];
    };
    MS.poseAt = function (options) {
      var opts = options || {};
      var emotion = DATA.emotions[opts.emotion] || DATA.emotions.neutral;
      var blink = MS.blinkAt(opts.t || 0, opts.fps, opts.blinkInterval);
      return {
        brow: emotion.brow,
        eyeOpen: emotion.eyeOpen * (1 - blink * 0.92),
        mouth: emotion.mouth,
        leanDeg: round2(emotion.lean),
        bobPx: 0,
        blink: blink,
        energy: emotion.energy
      };
    };
    MS.actingBeat = function (frame) {
      var p = DATA.performance;
      var coil = p.anticipationFrames[0];
      var held = p.anticipationFrames[1];
      var strike = p.strikeFrames;
      var recover = p.recoverFrames[1];
      if (frame < coil) return { phase: 'anticipation', pose: -frame / Math.max(1, coil) };
      if (frame < held) return { phase: 'anticipation', pose: -1 };
      if (frame < held + strike) return { phase: 'strike', pose: 1 };
      var r = frame - held - strike;
      if (r < recover) {
        var p = r / Math.max(1, recover);
        return { phase: 'recover', pose: (1 - p) * Math.cos(p * Math.PI * 1.2) };
      }
      return { phase: 'done', pose: 0 };
    };
  } catch (error) {}
})();`
}

/** Emotion names, in table order (used by the report and the tests). */
export function emotionNames() {
  return [...NAMES]
}

export default {
  PERFORMANCE,
  EMOTIONS,
  actingBeat,
  actingBeatFrames,
  blinkAt,
  walkAt,
  poseAt,
  performancePreludeSource,
  emotionNames,
}
