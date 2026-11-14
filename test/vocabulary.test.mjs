#!/usr/bin/env node
/**
 * Acceptance tests for the media-senses visual vocabulary library:
 *   lib/easing.js  — 12 named curves, spring, S-curves, role presets, browser prelude
 *   lib/moves.js   — 18 camera moves, speed bands, 9 transitions, cut-seam rules
 *   lib/look.js    — 8 look families, CSS custom properties, 15 AI-look antipatterns
 *
 * Run: node test/vocabulary.test.mjs
 *
 * Pure JS, no ffmpeg, no network: this suite is fast by design so it can run
 * before every render. Prints PASS/FAIL per assertion and exits non-zero when
 * anything fails.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cubicBezier,
  spring,
  smoothstep,
  smootherstep,
  inertia,
  backOut,
  elasticOut,
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
  browserPrelude,
} from '../lib/easing.js'
import {
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
} from '../lib/moves.js'
import {
  LOOKS,
  LOOKS_BY_ID,
  getLook,
  lookCssVars,
  LOOK_ANTIPATTERNS,
  getAntipattern,
} from '../lib/look.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB_DIR = join(HERE, '..', 'lib')

// Copied from lib/build.js (MOTIONS / TRANSITIONS constants) so this vocabulary
// suite can verify the mapping without importing another plugin module.
const BUILD_MOTION_SET = new Set([
  'none',
  'kenburns-in', 'kenburns-out',
  'pan-left', 'pan-right', 'pan-up', 'pan-down',
  'tilt-up', 'tilt-down',
])
const BUILD_XFADE_SET = new Set([
  'cut',
  'fade', 'fadeblack', 'fadewhite',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'circleopen', 'circleclose', 'dissolve', 'pixelize', 'radial',
  'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
  'horzopen', 'horzclose', 'vertopen', 'vertclose',
])

const HEX_PATTERN = /^#[0-9a-f]{6}$/u
const CJK_PATTERN = /[\u4e00-\u9fa5]/u
const SPEED_VALUES = new Set(['slow', 'medium', 'fast'])
const MOVE_KINDS = new Set(['scale', 'sweep', 'hold', 'composite', 'focus'])

let passed = 0
let failed = 0

/** Run one assertion block, printing PASS/FAIL. */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(`FAIL  ${name}`)
    console.log(`      ${message.split(/\r?\n/u).join('\n      ')}`)
  }
}

/* ------------------------------------------------------------------ *
 * Small assertion helpers
 * ------------------------------------------------------------------ */

function samples(count = 101) {
  const list = []
  for (let index = 0; index < count; index += 1) list.push(index / (count - 1))
  return list
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function assertCjk(value, name) {
  assert.equal(typeof value, 'string', `${name} must be a string`)
  assert.ok(value.trim().length > 0, `${name} must not be empty`)
  assert.match(value, CJK_PATTERN, `${name} must contain Chinese copy: ${value}`)
}

function assertRange(value, min, max, name) {
  assert.ok(isFiniteNumber(value), `${name} must be a finite number (got ${value})`)
  assert.ok(value >= min && value <= max, `${name}=${value} outside [${min}, ${max}]`)
}

function roundTrip(value) {
  return JSON.parse(JSON.stringify(value))
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  /* ================= lib/easing.js ================= */

  await check('easing: the 12 named curves are exported with the {css, fn} shape', () => {
    assert.equal(EASE_NAMES.length, 12, `expected 12 named curves, got ${EASE_NAMES.length}`)
    assert.equal(Object.keys(EASINGS).length, 12)
    let cssStrings = 0
    for (const name of EASE_NAMES) {
      const entry = EASINGS[name]
      assert.equal(typeof entry.fn, 'function', `${name}.fn`)
      assert.equal(typeof entry.css, 'string', `${name}.css must be a CSS timing function`)
      assert.ok(entry.cssApprox === null || typeof entry.cssApprox === 'string', `${name}.cssApprox`)
      assert.equal(typeof entry.cssExact, 'boolean', `${name}.cssExact`)
      assert.equal(typeof entry.monotonic, 'boolean', `${name}.monotonic`)
      assertCjk(entry.nameZh, `${name}.nameZh`)
      assertCjk(entry.feelZh, `${name}.feelZh`)
      if (typeof entry.css === 'string') {
        cssStrings += 1
        const isKeyword = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'].includes(entry.css)
        assert.ok(
          isKeyword || entry.css.startsWith('cubic-bezier('),
          `${name}.css is not a CSS timing function: ${entry.css}`,
        )
      }
    }
    assert.equal(cssStrings, 12, `only ${cssStrings} curves have a CSS timing-function string`)
    assert.equal(EASINGS['elastic.out(1,0.5)'].cssExact, false, 'elastic CSS can only be an approximation')
    assert.equal(EASINGS['expo.out'].cssExact, true, 'cubic-bezier curves are exact')
    // Required curve ids from the vocabulary contract.
    for (const required of ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'expo.out', 'power2.inOut', 'power3.in', 'back.out(1.4)', 'elastic.out(1,0.5)']) {
      assert.ok(required in EASINGS, `missing required curve ${required}`)
    }
  })

  await check('easing: every curve hits f(0)=0 and f(1)=1 exactly', () => {
    for (const name of EASE_NAMES) {
      const fn = EASINGS[name].fn
      assert.equal(fn(0), 0, `${name}(0) !== 0`)
      assert.equal(fn(1), 1, `${name}(1) !== 1`)
    }
    for (const fn of [smoothstep, smootherstep, inertia, backOut(1.4), elasticOut(1, 0.5)]) {
      assert.equal(fn(0), 0)
      assert.equal(fn(1), 1)
    }
  })

  await check('easing: monotone curves never go backwards and stay within [0,1]', () => {
    const times = samples()
    let monotoneCount = 0
    for (const name of EASE_NAMES) {
      const entry = EASINGS[name]
      if (!entry.monotonic) continue
      monotoneCount += 1
      let previous = -1
      for (const t of times) {
        const value = entry.fn(t)
        assert.ok(Number.isFinite(value), `${name}(${t}) is not finite`)
        assert.ok(value >= -1e-9 && value <= 1 + 1e-9, `${name}(${t})=${value} outside [0,1]`)
        assert.ok(value >= previous - 1e-9, `${name} is not monotone at t=${t} (${previous} -> ${value})`)
        previous = value
      }
    }
    assert.ok(monotoneCount >= 10, `only ${monotoneCount} monotone curves`)
  })

  await check('easing: back/elastic intentionally overshoot and are flagged non-monotone', () => {
    for (const name of ['back.out(1.4)', 'elastic.out(1,0.5)']) {
      assert.equal(EASINGS[name].monotonic, false)
      const values = samples().map((t) => EASINGS[name].fn(t))
      const max = Math.max(...values)
      assert.ok(max > 1.02, `${name} should overshoot above 1, max=${max}`)
      let nonMonotone = false
      for (let index = 1; index < values.length; index += 1) {
        if (values[index] < values[index - 1] - 1e-6) nonMonotone = true
      }
      assert.ok(nonMonotone, `${name} should come back down after overshooting`)
    }
    const backMax = Math.max(...samples().map((t) => EASINGS['back.out(1.4)'].fn(t)))
    assert.ok(backMax > 1.03 && backMax < 1.15, `back.out(1.4) max=${backMax} should be a restrained overshoot`)
    const elasticMax = Math.max(...samples().map((t) => EASINGS['elastic.out(1,0.5)'].fn(t)))
    assert.ok(elasticMax > 1.2, `elastic.out max=${elasticMax} should ring clearly`)
  })

  await check('easing: cubicBezier solves CSS curves correctly and validates inputs', () => {
    const identity = cubicBezier(0, 0, 1, 1)
    for (const t of [0.1, 0.37, 0.8]) assert.ok(Math.abs(identity(t) - t) < 1e-6, `identity curve at ${t}`)
    const symmetric = cubicBezier(0.42, 0, 0.58, 1)
    assert.ok(Math.abs(symmetric(0.5) - 0.5) < 1e-6, `symmetric curve midpoint=${symmetric(0.5)}`)
    const expoOut = cubicBezier(0.16, 1, 0.3, 1)
    assert.ok(expoOut(0.5) > 0.7, `expo.out(0.5)=${expoOut(0.5)} should be a long-tail curve`)
    assert.ok(expoOut(0.5) <= 1, 'expo.out must not overshoot')
    assert.equal(ease('expo.out', 0.5), easingFn('expo.out')(0.5))
    assert.equal(typeof easeCss('expo.out'), 'string')
    assert.equal(easeCss('elastic.out(1,0.5)'), 'cubic-bezier(0.34, 1.56, 0.64, 1)')
    assert.equal(ease('no-such-curve', 0.5) !== ease('no-such-curve', 0.5), true, 'unknown curve must return NaN')
    assert.throws(() => cubicBezier(1.2, 0, 0.5, 1), /x1 and x2/u)
    assert.throws(() => cubicBezier(Number.NaN, 0, 0.5, 1), /finite/u)
  })

  await check('easing: spring semantics — damping 1.0 is firm, 0.7–0.85 premium, 0.4 lively, <0.3 cartoon', () => {
    const time = samples(241).map((t) => t * 3)
    const sampleSpring = (damping) => time.map((t) => spring({ damping, frequency: 2, t }))
    const firm = sampleSpring(1)
    assert.equal(spring({ damping: 1, frequency: 2, t: 0 }), 0)
    assert.ok(Math.max(...firm) <= 1 + 1e-9, `critical damping must never overshoot, max=${Math.max(...firm)}`)
    let previous = -1
    for (const value of firm) {
      assert.ok(value >= previous - 1e-9, 'critically damped spring must rise monotonically')
      previous = value
    }
    assert.ok(Math.abs(spring({ damping: 1, frequency: 2, t: 6 }) - 1) < 1e-6, 'critical spring must settle at 1')
    const premium = sampleSpring(0.8)
    const premiumMax = Math.max(...premium)
    assert.ok(premiumMax > 1 + 1e-6 && premiumMax < 1.05, `premium damping (0.8) should barely overshoot, max=${premiumMax}`)
    const lively = sampleSpring(0.4)
    const livelyMax = Math.max(...lively)
    assert.ok(livelyMax > 1.1, `lively damping (0.4) should overshoot visibly, max=${livelyMax}`)
    const cartoon = sampleSpring(0.2)
    const cartoonMax = Math.max(...cartoon)
    assert.ok(cartoonMax > 1.3, `cartoon damping (0.2) should overshoot hard, max=${cartoonMax}`)
    assert.ok(Math.abs(spring({ damping: 0.4, frequency: 2, t: 8 }) - 1) < 1e-4, 'under-damped spring must settle')
    assert.ok(Number.isFinite(spring({ damping: Number.NaN, frequency: 0, t: 1 })), 'invalid spring options must degrade to finite numbers')
  })

  await check('easing: smoothstep / smootherstep / inertia are well-formed S-curves', () => {
    for (const fn of [smoothstep, smootherstep]) {
      assert.equal(fn(0), 0)
      assert.equal(fn(1), 1)
      assert.equal(fn(0.5), 0.5)
      let previous = -1
      for (const t of samples()) {
        const value = fn(t)
        assert.ok(value >= previous - 1e-9, `S-curve is not monotone at t=${t}`)
        previous = value
      }
    }
    // smootherstep removes the velocity jump at the edges: slower start than smoothstep.
    assert.ok(smootherstep(0.1) < smoothstep(0.1), 'smootherstep should start slower than smoothstep')
    assert.ok(smoothstep(0.001) < 0.01, 'smoothstep should start with near-zero slope')
    assert.equal(inertia(0), 0)
    assert.equal(inertia(1), 1)
    for (const t of [0.1, 0.25, 0.5, 0.77, 0.9]) {
      const expected = 0.35 * t + 0.65 * smootherstep(t)
      assert.ok(Math.abs(inertia(t) - expected) < 1e-12, `inertia weights are wrong at t=${t}`)
    }
    assert.equal(inertia(0.5), 0.5)
  })

  await check('easing: EASE_ROLES maps purpose to curve and easeForRole returns functions', () => {
    assert.deepEqual(Object.keys(EASE_ROLES).sort(), ['camera', 'enter', 'exit', 'move'])
    assert.equal(EASE_ROLES.enter, 'expo.out')
    assert.equal(EASE_ROLES.move, 'power2.inOut')
    assert.equal(EASE_ROLES.exit, 'power3.in')
    for (const role of Object.keys(EASE_ROLES)) {
      assert.ok(EASE_ROLES[role] in EASINGS, `role ${role} maps to unknown curve ${EASE_ROLES[role]}`)
      assertCjk(EASE_ROLE_NOTES[role], `EASE_ROLE_NOTES.${role}`)
      const fn = easeForRole(role)
      assert.equal(typeof fn, 'function', `easeForRole(${role})`)
      assert.equal(fn(0), 0)
      assert.equal(fn(1), 1)
    }
    assert.equal(easeForRole('unknown-role'), null)
  })

  await check('easing: SPRING_FEEL encodes the damping→feel semantics', () => {
    assert.equal(SPRING_FEEL.length, 4)
    for (const entry of SPRING_FEEL) {
      assertCjk(entry.feelZh, `SPRING_FEEL.${entry.id}.feelZh`)
      assert.ok(entry.dampingMin >= 0 && entry.dampingMax <= 1 && entry.dampingMin < entry.dampingMax)
    }
    const premium = SPRING_FEEL.find((entry) => entry.dampingMin <= 0.7 && entry.dampingMax >= 0.85)
    assert.ok(premium !== undefined, 'no premium band covering 0.7–0.85')
    const cartoon = SPRING_FEEL.find((entry) => entry.dampingMax <= 0.3)
    assert.ok(cartoon !== undefined, 'no cartoon band below 0.3')
  })

  await check('easing: browserPrelude evaluates in a plain JS sandbox and exposes window.MS', () => {
    const prelude = browserPrelude()
    assert.equal(typeof prelude, 'string')
    assert.ok(prelude.length > 2000, 'prelude is suspiciously short')
    assert.ok(!/(^|\n)\s*import\s/u.test(prelude), 'prelude must not contain ES import statements')
    assert.ok(!/require\s*\(/u.test(prelude), 'prelude must not contain require()')
    const sandbox = {}
    const MS = new Function('window', `${prelude}\n;return window.MS`)(sandbox)
    assert.equal(typeof MS, 'object')
    assert.equal(sandbox.MS, MS, 'prelude must attach MS to the passed window object')
    for (const name of ['ease', 'easeCss', 'cubicBezier', 'spring', 'smoothstep', 'smootherstep', 'inertia', 'easeRole']) {
      assert.equal(typeof MS[name], 'function', `MS.${name}`)
    }
    assert.equal(typeof MS.easings, 'object')
  })

  await check('easing: browserPrelude agrees with the module maths to 1e-6', () => {
    const prelude = browserPrelude()
    const MS = new Function('window', `${prelude}\n;return window.MS`)({})
    const times = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]
    for (const name of EASE_NAMES) {
      for (const t of times) {
        const browserValue = MS.ease(name, t)
        const moduleValue = EASINGS[name].fn(t)
        assert.ok(
          Math.abs(browserValue - moduleValue) < 1e-6,
          `prelude drift on ${name}(${t}): browser=${browserValue} module=${moduleValue}`,
        )
      }
    }
    for (const t of times) {
      assert.ok(Math.abs(MS.inertia(t) - inertia(t)) < 1e-12, `prelude inertia drift at ${t}`)
      assert.ok(Math.abs(MS.smoothstep(t) - smoothstep(t)) < 1e-12, `prelude smoothstep drift at ${t}`)
    }
    const springOptions = { damping: 0.4, frequency: 2.4, t: 0.37 }
    assert.ok(Math.abs(MS.spring(springOptions) - spring(springOptions)) < 1e-12, 'prelude spring drift')
    const browserBezier = MS.cubicBezier(0.42, 0, 0.58, 1)
    assert.ok(Math.abs(browserBezier(0.5) - 0.5) < 1e-6, 'prelude cubicBezier is wrong')
    assert.equal(MS.easeCss('elastic.out(1,0.5)'), easeCss('elastic.out(1,0.5)'))
    assert.ok(Number.isNaN(MS.ease('nope', 0.5)))
    // Injecting the same prelude twice must not break window.MS.
    const again = new Function('window', `${prelude}\n;return window.MS`)({})
    assert.equal(typeof again.ease, 'function')
  })

  /* ================= lib/moves.js ================= */

  await check('moves: CAMERA_MOVES has exactly 18 complete, well-formed entries', () => {
    assert.equal(CAMERA_MOVES.length, 18)
    const ids = new Set()
    for (const move of CAMERA_MOVES) {
      assert.equal(typeof move.id, 'string', 'move.id')
      assert.ok(move.id.length > 0)
      assert.ok(!ids.has(move.id), `duplicate move id ${move.id}`)
      ids.add(move.id)
      assertCjk(move.nameZh, `${move.id}.nameZh`)
      assert.ok(Array.isArray(move.seconds) && move.seconds.length === 2, `${move.id}.seconds`)
      assert.ok(isFiniteNumber(move.seconds[0]) && move.seconds[0] > 0, `${move.id}.seconds[0]`)
      assert.ok(isFiniteNumber(move.seconds[1]) && move.seconds[1] > move.seconds[0], `${move.id}.seconds[1]`)
      assert.ok(SPEED_VALUES.has(move.speed), `${move.id}.speed=${move.speed}`)
      assert.ok(move.easing in EASINGS, `${move.id}.easing=${move.easing} is not a named curve`)
      assert.equal(typeof move.framing, 'string', `${move.id}.framing`)
      assert.ok(move.framing.length > 0)
      assert.ok(move.ffmpegMotion === null || BUILD_MOTION_SET.has(move.ffmpegMotion), `${move.id}.ffmpegMotion=${move.ffmpegMotion}`)
      assert.equal(typeof move.htmlRecipe, 'string', `${move.id}.htmlRecipe`)
      assert.ok(move.htmlRecipe.length > 5)
      assertCjk(move.whyZh, `${move.id}.whyZh`)
      assert.ok(MOVE_KINDS.has(move.kind), `${move.id}.kind=${move.kind}`)
      if (move.kind === 'scale') {
        assert.ok(isFiniteNumber(move.amountPercent) && move.amountPercent > 0, `${move.id}.amountPercent`)
      }
      assert.equal(getMove(move.id), move)
      assert.equal(MOVES_BY_ID[move.id], move)
    }
  })

  await check('moves: the required 18 camera vocabulary ids are all covered', () => {
    const required = [
      'static-hold', 'push-in', 'pull-out', 'dolly-in', 'dolly-out',
      'track-left', 'track-right', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down',
      'whip-pan', 'crane', 'orbit', 'handheld', 'rack-focus', 'dolly-zoom', 'snap-zoom',
    ]
    for (const id of required) assert.ok(getMove(id) !== null, `missing camera move ${id}`)
    assert.equal(getMove('no-such-move'), null)
  })

  await check('moves: entry speed agrees with classifySpeed on the duration window midpoint', () => {
    let checked = 0
    for (const move of CAMERA_MOVES) {
      if (move.kind !== 'scale' && move.kind !== 'sweep') continue
      const midpoint = (move.seconds[0] + move.seconds[1]) / 2
      const quantified = classifySpeed(move.kind, midpoint, move.amountPercent)
      const band = quantified.band === 'whip' ? 'fast' : quantified.band
      assert.equal(band, move.speed, `${move.id}: midpoint ${midpoint}s classified as ${band}, entry says ${move.speed}`)
      checked += 1
    }
    assert.ok(checked >= 13, `only ${checked} moves cross-checked`)
  })

  await check('moves: every ffmpegMotion id is in the build.js MOTIONS set, unmappable moves carry htmlRecipe', () => {
    let mapped = 0
    let unmapped = 0
    for (const move of CAMERA_MOVES) {
      if (move.ffmpegMotion !== null) {
        assert.ok(BUILD_MOTION_SET.has(move.ffmpegMotion), `${move.id}.ffmpegMotion=${move.ffmpegMotion} not in build.js MOTIONS`)
        mapped += 1
      } else {
        unmapped += 1
        assert.ok(move.htmlRecipe.length > 5, `${move.id} has no ffmpeg mapping and no htmlRecipe`)
      }
    }
    assert.ok(mapped >= 10, `only ${mapped} moves map to the builder`)
    assert.ok(unmapped >= 1, 'some moves (whip/orbit/handheld…) must honestly report ffmpegMotion: null')
    for (const id of BUILD_MOTIONS) assert.ok(isBuildMotion(id), `isBuildMotion(${id})`)
  })

  await check('moves: SPEED_BANDS codifies the documented numeric boundaries', () => {
    assert.equal(SPEED_BANDS.scale.slowMax, 10)
    assert.equal(SPEED_BANDS.scale.mediumMax, 25)
    assert.equal(SPEED_BANDS.scale.unit, '%/s')
    assert.equal(SPEED_BANDS.sweep.slowMinSeconds, 6)
    assert.equal(SPEED_BANDS.sweep.mediumMinSeconds, 3)
    assert.equal(SPEED_BANDS.sweep.fastMinSeconds, 1.5)
    assert.equal(SPEED_BANDS.sweep.whipBelowSeconds, 1.5)
    assert.ok(Array.isArray(SPEED_BANDS.scale.sizeChangePercent) && SPEED_BANDS.scale.sizeChangePercent.length === 2)
  })

  await check('moves: classifySpeed resolves the exact size-change boundaries', () => {
    assert.equal(classifySpeed('scale', 10).band, 'slow') // 10 %/s exactly is still slow
    assert.equal(classifySpeed('scale', 10).percentPerSecond, 10)
    assert.equal(classifySpeed('scale', 4).band, 'medium') // 25 %/s exactly is still medium
    assert.equal(classifySpeed('scale', 4).percentPerSecond, 25)
    assert.equal(classifySpeed('scale', 3).band, 'fast')
    assert.equal(classifySpeed('scale', 3, 30).band, 'slow') // 10 %/s
    assert.equal(classifySpeed('scale', 2, 40).band, 'medium') // 20 %/s
    assert.equal(classifySpeed('scale', 1, 40).band, 'fast') // 40 %/s
    assert.equal(classifySpeed('size', 3).kind, 'scale', 'size alias')
    assert.equal(classifySpeed('zoom', 3).kind, 'scale', 'zoom alias')
    assertCjk(classifySpeed('scale', 3).noteZh, 'classifySpeed noteZh')
  })

  await check('moves: classifySpeed resolves the exact sweep boundaries and the whip band', () => {
    assert.equal(classifySpeed('sweep', 8).band, 'slow')
    assert.equal(classifySpeed('sweep', 6).band, 'slow') // ≥6 s per screen is slow
    assert.equal(classifySpeed('sweep', 5.9).band, 'medium')
    assert.equal(classifySpeed('sweep', 3).band, 'medium')
    assert.equal(classifySpeed('sweep', 2).band, 'fast')
    assert.equal(classifySpeed('sweep', 1.5).band, 'fast')
    assert.equal(classifySpeed('sweep', 1.4).band, 'whip')
    assert.equal(classifySpeed('sweep', 0.3).band, 'whip')
    assert.equal(classifySpeed('pan', 5).kind, 'sweep', 'pan alias')
    assert.equal(classifySpeed('tilt', 5).kind, 'sweep', 'tilt alias')
  })

  await check('moves: classifySpeed rejects invalid input without throwing', () => {
    for (const badSeconds of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = classifySpeed('scale', badSeconds)
      assert.equal(result.band, null, `band for seconds=${badSeconds}`)
      assert.equal(result.seconds, null)
      assert.equal(result.percentPerSecond, null)
      assert.ok(typeof result.noteZh === 'string' && result.noteZh.length > 0)
    }
    const unknown = classifySpeed('teleport', 2)
    assert.equal(unknown.band, null)
    assertCjk(unknown.noteZh, 'unknown-kind noteZh')
  })

  await check('moves: motionForCameraLabel maps Chinese/English labels to build.js ids', () => {
    const cases = [
      ['固定机位', 'none'],
      ['固定镜头', 'none'],
      ['static', 'none'],
      ['推镜', 'kenburns-in'],
      ['缓慢推近', 'kenburns-in'],
      ['dolly in', 'kenburns-in'],
      ['拉镜', 'kenburns-out'],
      ['缓慢拉远', 'kenburns-out'],
      ['pull out', 'kenburns-out'],
      ['左摇', 'pan-left'],
      ['向右摇镜', 'pan-right'],
      ['pan left', 'pan-left'],
      ['上摇', 'tilt-up'],
      ['向下摇镜', 'tilt-down'],
      ['tilt up', 'tilt-up'],
      ['升起', 'pan-up'],
      ['crane down', 'pan-down'],
      ['kenburns-in', 'kenburns-in'],
      ['dolly-in', 'kenburns-in'],
      ['snap-zoom', 'kenburns-in'],
      ['static-hold', 'none'],
    ]
    for (const [label, expected] of cases) {
      assert.equal(motionForCameraLabel(label), expected, `motionForCameraLabel(${label})`)
    }
    for (const unmappable of ['手持晃动', 'handheld', '环绕', 'orbit', '甩镜', 'whip pan', 'whip-pan', 'rack-focus', 'dolly-zoom', '移焦', '', null, 42]) {
      assert.equal(motionForCameraLabel(unmappable), null, `motionForCameraLabel(${String(unmappable)}) should be null`)
    }
  })

  await check('moves: 9 transitions carry duration, sound treatment and a build mapping when possible', () => {
    assert.equal(TRANSITIONS.length, 9)
    const required = ['hard-cut', 'match-cut', 'whip', 'dissolve', 'iris', 'wipe', 'smash', 'j-cut', 'l-cut']
    let mapped = 0
    const ids = new Set()
    for (const transition of TRANSITIONS) {
      assert.equal(typeof transition.id, 'string')
      assert.ok(!ids.has(transition.id), `duplicate transition id ${transition.id}`)
      ids.add(transition.id)
      assertCjk(transition.nameZh, `${transition.id}.nameZh`)
      assert.ok(isFiniteNumber(transition.defaultSeconds) && transition.defaultSeconds >= 0, `${transition.id}.defaultSeconds`)
      assertCjk(transition.soundZh, `${transition.id}.soundZh`)
      assertCjk(transition.whenZh, `${transition.id}.whenZh`)
      assert.ok(transition.ffmpeg === null || BUILD_XFADE_SET.has(transition.ffmpeg), `${transition.id}.ffmpeg=${transition.ffmpeg}`)
      if (transition.ffmpeg !== null) mapped += 1
      else assert.equal(typeof transition.htmlRecipe, 'string', `${transition.id} has no ffmpeg mapping and no htmlRecipe`)
      if (transition.htmlRecipe !== null) assert.ok(transition.htmlRecipe.length > 5)
      assert.equal(getTransition(transition.id), transition)
      assert.equal(TRANSITIONS_BY_ID[transition.id], transition)
    }
    for (const id of required) assert.ok(getTransition(id) !== null, `missing transition ${id}`)
    assert.ok(mapped >= 4, `only ${mapped} transitions map to build.js xfade/cut names`)
    // J-cut leads the audio, L-cut lags it.
    assert.match(getTransition('j-cut').soundZh, /提前/u)
    assert.match(getTransition('l-cut').soundZh, /延续/u)
    assert.ok(isBuildTransition('dissolve') && isBuildTransition('cut') && !isBuildTransition('nope'))
  })

  await check('moves: CUT_SEAM_RULES encodes at least 5 hard rules with thresholds and fixes', () => {
    assert.ok(CUT_SEAM_RULES.length >= 5, `only ${CUT_SEAM_RULES.length} cut-seam rules`)
    const ids = new Set()
    for (const rule of CUT_SEAM_RULES) {
      assert.equal(typeof rule.id, 'string')
      assert.ok(!ids.has(rule.id), `duplicate rule id ${rule.id}`)
      ids.add(rule.id)
      assertCjk(rule.ruleZh, `${rule.id}.ruleZh`)
      assert.equal(typeof rule.metric, 'string')
      assert.ok(rule.metric.length > 0)
      assert.equal(typeof rule.threshold, 'string')
      assert.ok(rule.threshold.length > 0)
      assertCjk(rule.fixZh, `${rule.id}.fixZh`)
    }
    const corpus = CUT_SEAM_RULES.map((rule) => `${rule.ruleZh} ${rule.metric} ${rule.threshold} ${rule.fixZh}`).join('\n')
    for (const keyword of ['动作顶点', '方向', '变焦', '1/10', '运动模糊']) {
      assert.ok(corpus.includes(keyword), `cut-seam rules do not cover "${keyword}"`)
    }
  })

  /* ================= lib/look.js ================= */

  await check('look: 8 look families each carry the five parameter groups', () => {
    assert.equal(LOOKS.length, 8)
    const required = [
      'cinematic-realistic', 'anime-cel', 'pastel-storybook', 'claymation',
      'papercut-collage', 'retro-synthwave-vhs', 'glossy-commercial', 'handmade-ink',
    ]
    const ids = new Set()
    for (const look of LOOKS) {
      assert.equal(typeof look.id, 'string')
      assert.ok(!ids.has(look.id), `duplicate look id ${look.id}`)
      ids.add(look.id)
      assertCjk(look.nameZh, `${look.id}.nameZh`)
      assertCjk(look.oneLineZh, `${look.id}.oneLineZh`)
      assert.ok(Array.isArray(look.palette) && look.palette.length === 5, `${look.id}.palette length`)
      for (const hex of look.palette) assert.match(hex, HEX_PATTERN, `${look.id}.palette ${hex}`)
      assert.deepEqual(Object.keys(look.materials).sort(), ['roughness', 'shading', 'steps'])
      assert.deepEqual(
        Object.keys(look.light).sort(),
        ['ambient', 'azimuthDeg', 'elevationDeg', 'exposure', 'fog', 'intensity'],
      )
      assert.deepEqual(
        Object.keys(look.post).sort(),
        ['bloom', 'chromatic', 'contrast', 'grain', 'outline', 'saturation', 'scanline', 'tone', 'vignette'],
      )
      assert.deepEqual(Object.keys(look.render).sort(), ['fps', 'hold'])
      assert.equal(LOOKS_BY_ID[look.id], look)
      assert.equal(getLook(look.id), look)
    }
    for (const id of required) assert.ok(getLook(id) !== null, `missing look ${id}`)
    assert.equal(getLook('nope'), null)
  })

  await check('look: material, light, post and render parameters are inside their valid ranges', () => {
    for (const look of LOOKS) {
      assert.equal(typeof look.materials.shading, 'string')
      assert.ok(look.materials.shading.length > 0)
      assert.ok(Number.isInteger(look.materials.steps) && look.materials.steps >= 0 && look.materials.steps <= 16, `${look.id}.materials.steps`)
      assertRange(look.materials.roughness, 0, 1, `${look.id}.materials.roughness`)
      assertRange(look.light.azimuthDeg, 0, 360, `${look.id}.light.azimuthDeg`)
      assertRange(look.light.elevationDeg, 0, 90, `${look.id}.light.elevationDeg`)
      assertRange(look.light.intensity, 0.3, 2.5, `${look.id}.light.intensity`)
      assertRange(look.light.ambient, 0, 1, `${look.id}.light.ambient`)
      assertRange(look.light.fog, 0, 1, `${look.id}.light.fog`)
      assertRange(look.light.exposure, -2, 2, `${look.id}.light.exposure`)
      assert.equal(typeof look.post.tone, 'string')
      assert.ok(look.post.tone.length > 0)
      assertRange(look.post.saturation, 0, 2, `${look.id}.post.saturation`)
      assertRange(look.post.contrast, 0.5, 1.6, `${look.id}.post.contrast`)
      for (const key of ['bloom', 'chromatic', 'outline', 'vignette', 'grain', 'scanline']) {
        assertRange(look.post[key], 0, 1, `${look.id}.post.${key}`)
      }
      assertRange(look.render.fps, 1, 60, `${look.id}.render.fps`)
      assert.ok(Number.isInteger(look.render.hold) && look.render.hold >= 1 && look.render.hold <= 8, `${look.id}.render.hold`)
    }
  })

  await check('look: the 8 families are actually different (shading, cadence, palette)', () => {
    const shadings = new Set(LOOKS.map((look) => look.materials.shading))
    assert.ok(shadings.size >= 3, `only ${shadings.size} distinct shading models`)
    const fpsValues = new Set(LOOKS.map((look) => look.render.fps))
    assert.ok(fpsValues.size >= 2, 'all looks share one frame rate')
    const cadences = new Set(LOOKS.map((look) => look.render.hold))
    assert.ok(cadences.size >= 2, 'all looks share one hold cadence')
    const backgrounds = new Set(LOOKS.map((look) => look.palette[0]))
    assert.equal(backgrounds.size, LOOKS.length, 'two looks share a background colour')
    // The cel-shaded look really is quantised and outlined.
    const anime = getLook('anime-cel')
    assert.equal(anime.materials.steps, 3)
    assert.ok(anime.post.outline > 0.3)
    const ink = getLook('handmade-ink')
    assert.ok(ink.post.saturation < 0.6, 'ink look should be desaturated')
  })

  await check('look: lookCssVars emits a complete --ms-* custom-property block', () => {
    const vars = lookCssVars(LOOKS[0])
    assert.equal(typeof vars, 'string')
    assert.ok(vars.length > 200, 'CSS variable block is suspiciously short')
    assert.ok(vars.includes(`--ms-bg: ${LOOKS[0].palette[0]}`), 'background variable missing')
    for (const token of ['--ms-ink', '--ms-accent', '--ms-mid', '--ms-light', '--ms-grain', '--ms-fps', '--ms-hold', '--ms-tone', '--ms-vignette', '--ms-outline', '--ms-scanline']) {
      assert.ok(vars.includes(token), `missing CSS variable ${token}`)
    }
    for (const declaration of vars.split('; ')) {
      assert.match(declaration, /^--ms-[a-z0-9-]+: .+$/u, `malformed CSS declaration: ${declaration}`)
    }
    assert.equal(lookCssVars('cinematic-realistic'), lookCssVars(LOOKS[0]), 'id and object must render the same block')
    assert.equal(lookCssVars('no-such-look'), '')
    for (const look of LOOKS) {
      const block = lookCssVars(look)
      assert.ok(block.length > 200, `${look.id} CSS block too short`)
      assert.ok(block.includes(look.palette[2]), `${look.id} accent colour missing`)
    }
  })

  await check('look: 15 AI-look antipatterns each have tell/why/fix, and the fixes carry numbers', () => {
    assert.equal(LOOK_ANTIPATTERNS.length, 15)
    const ids = new Set()
    for (const entry of LOOK_ANTIPATTERNS) {
      assert.equal(typeof entry.id, 'string')
      assert.ok(!ids.has(entry.id), `duplicate antipattern id ${entry.id}`)
      ids.add(entry.id)
      assertCjk(entry.tellZh, `${entry.id}.tellZh`)
      assertCjk(entry.whyZh, `${entry.id}.whyZh`)
      assertCjk(entry.fixZh, `${entry.id}.fixZh`)
      assert.match(entry.fixZh, /\d/u, `${entry.id}.fixZh needs a concrete number so it is executable: ${entry.fixZh}`)
      assert.equal(getAntipattern(entry.id), entry)
    }
    assert.equal(getAntipattern('nope'), null)
    const corpus = LOOK_ANTIPATTERNS.map((entry) => `${entry.tellZh}${entry.whyZh}${entry.fixZh}`).join('\n')
    const themes = [
      ['purple/teal gradient', /紫[\s\S]{0,8}青|青[\s\S]{0,8}紫/u],
      ['particle soup', /粒子/u],
      ['lens flare abuse', /光晕/u],
      ['RGB split', /RGB|色差/u],
      ['neon overload', /霓虹/u],
      ['bouncy easing', /回弹/u],
      ['slow motion everywhere', /慢动作/u],
      ['centered black title', /黑底|居中/u],
      ['same framing/speed', /景别/u],
      ['teal-orange default', /青橙/u],
      ['procedural noise nebula', /噪声|星云/u],
      ['floating glass cards', /玻璃/u],
      ['default fonts', /字体/u],
      ['bloom everywhere', /bloom|发光/u],
      ['unmotivated drift', /漂移/u],
    ]
    for (const [name, pattern] of themes) assert.match(corpus, pattern, `antipattern theme missing: ${name}`)
  })

  /* ================= cross-cutting ================= */

  await check('all data exports survive a JSON round-trip unchanged', () => {
    for (const value of [CAMERA_MOVES, TRANSITIONS, CUT_SEAM_RULES, SPEED_BANDS, EASE_ROLES, EASE_ROLE_NOTES, SPRING_FEEL, LOOKS, LOOK_ANTIPATTERNS]) {
      assert.deepEqual(roundTrip(value), value, 'data export is not plain JSON')
    }
    const curveProjection = Object.fromEntries(
      EASE_NAMES.map((name) => [name, {
        css: EASINGS[name].css,
        cssApprox: EASINGS[name].cssApprox,
        monotonic: EASINGS[name].monotonic,
        nameZh: EASINGS[name].nameZh,
      }]),
    )
    assert.deepEqual(roundTrip(curveProjection), curveProjection)
    assert.deepEqual(roundTrip([...BUILD_MOTIONS, ...BUILD_XFADE_TRANSITIONS]), [...BUILD_MOTIONS, ...BUILD_XFADE_TRANSITIONS])
  })

  await check('no cross-library imports: easing/moves/look are standalone modules', async () => {
    for (const file of ['easing.js', 'moves.js', 'look.js']) {
      const source = await readFile(join(LIB_DIR, file), 'utf8')
      assert.ok(!/from\s+['"]\.{1,2}\//u.test(source), `${file} imports a sibling lib module (cycle risk)`)
      assert.ok(!/(^|\n)\s*import\s+[^;\n]*from\s+['"]/u.test(source), `${file} contains an ES import statement`)
      assert.ok(!/require\s*\(/u.test(source), `${file} uses require()`)
    }
  })

  await check('exports expose lookup helpers with honest null/unknown behaviour', () => {
    assert.equal(getEasing('expo.out'), EASINGS['expo.out'])
    assert.equal(getEasing('nope'), null)
    assert.equal(easingFn('nope'), null)
    assert.equal(getMove('nope'), null)
    assert.equal(getTransition('nope'), null)
    assert.equal(getLook('nope'), null)
    assert.equal(getAntipattern('nope'), null)
    assert.equal(isBuildMotion('nope'), false)
    assert.equal(isBuildTransition('nope'), false)
    assert.equal(easeForRole('nope'), null)
  })

  /* ---------------- summary ---------------- */

  console.log('')
  console.log(`vocabulary: ${passed} passed, ${failed} failed`)
  console.log(`  curves: ${EASE_NAMES.length} (${EASE_NAMES.join(', ')})`)
  console.log(`  camera moves: ${CAMERA_MOVES.length}; transitions: ${TRANSITIONS.length}; cut-seam rules: ${CUT_SEAM_RULES.length}`)
  console.log(`  looks: ${LOOKS.length} (${LOOKS.map((look) => look.id).join(', ')})`)
  console.log(`  antipatterns: ${LOOK_ANTIPATTERNS.length}`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
