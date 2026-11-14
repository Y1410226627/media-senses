/**
 * Director-vocabulary tool surface.
 *
 * `media_moves` is the one place a model asks "how do I say this?" and gets
 * numbers back, so the tests care about three things:
 *
 *  1. every action answers with content (not an empty report),
 *  2. the numbers are consistent with the modules the rest of the plugin uses
 *     (an ffmpeg motion that the builder cannot render would be a lie),
 *  3. unknown ids fail with a message that names the alternative.
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { CAMERA_MOVES, TRANSITIONS } from '../lib/moves.js'
import { LOOKS, LOOK_ANTIPATTERNS } from '../lib/look.js'
import { SHOT_CARDS } from '../lib/shots.js'

/**
 * The motions `media_build_video` actually renders (lib/build.js MOTIONS).
 * Duplicated here on purpose: this test is the guard that the vocabulary never
 * advertises something the builder cannot do, so it must not read the value out
 * of the builder itself.
 */
const BUILD_MOTIONS = new Set([
  'none',
  'kenburns-in', 'kenburns-out',
  'pan-left', 'pan-right', 'pan-up', 'pan-down',
  'tilt-up', 'tilt-down',
])

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

const registry = new Map()
apply({ tools: { register: (def) => (registry.set(def.name, def), () => {}) } }, {})
const def = registry.get('media_moves')

/** Run one action and return both the structured value and the rendered text. */
async function run(args) {
  const value = await def.execute(args, {})
  const text = def.output
    .render(args, value)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return { value, text }
}

await check('the tool is registered with a bilingual description and a schema', () => {
  assert.ok(def !== undefined, 'media_moves must be registered')
  assert.match(def.description, /[\u4e00-\u9fff]/u, 'description must carry Chinese')
  assert.match(def.description, /camera moves/u, 'description must carry English')
  assert.ok(def.parameters?.properties?.action?.enum.includes('moves'))
  assert.ok(def.output?.schema !== undefined)
  assert.equal(typeof def.execute, 'function')
})

await check('moves lists all 18 camera moves with ffmpeg mappings the builder can render', async () => {
  const { value, text } = await run({ action: 'moves' })
  assert.equal(value.count, CAMERA_MOVES.length)
  assert.equal(CAMERA_MOVES.length, 18)
  assert.match(text, /运镜词典/u)
  // Every advertised ffmpeg motion must exist in the builder's motion set,
  // otherwise the model would write a plan the renderer rejects.
  for (const move of value.data.moves) {
    if (move.ffmpegMotion === null || move.ffmpegMotion === undefined) continue
    assert.ok(BUILD_MOTIONS.has(move.ffmpegMotion), `${move.id} advertises unsupported motion ${move.ffmpegMotion}`)
  }
  assert.ok(text.includes('kenburns-in'), 'the table must show the ffmpeg column')
})

await check('transitions lists all 9 with sound handling', async () => {
  const { value, text } = await run({ action: 'transitions' })
  assert.equal(value.count, TRANSITIONS.length)
  assert.equal(TRANSITIONS.length, 9)
  assert.match(text, /转场词典/u)
  for (const transition of value.data.transitions) {
    assert.ok(typeof transition.soundZh === 'string' && transition.soundZh.length > 4, `${transition.id} needs soundZh`)
  }
})

await check('easing reports roles, curves and spring damping', async () => {
  const { value, text } = await run({ action: 'easing' })
  assert.match(text, /缓动词典/u)
  const curves = Object.keys(value.data.easings.curves)
  assert.ok(curves.length >= 12, `expected >=12 curves, got ${curves.length}`)
  assert.ok(curves.includes('expo.out'), 'the enter role curve must be listed')
  assert.ok(Object.keys(value.data.easings.roles).includes('enter'))
  assert.ok(Array.isArray(value.data.easings.spring) && value.data.easings.spring.length >= 3)
  assert.match(text, /阻尼比/u)
})

await check('looks reports all 8 families with their parameter groups', async () => {
  const { value, text } = await run({ action: 'looks' })
  assert.equal(value.count, LOOKS.length)
  assert.equal(LOOKS.length, 8)
  assert.match(text, /外观参数预设/u)
  for (const look of value.data.looks) {
    assert.ok(Array.isArray(look.palette) && look.palette.length >= 3, `${look.id} needs a palette`)
    assert.ok(look.materials !== undefined && look.light !== undefined && look.post !== undefined, `${look.id} needs all groups`)
    assert.match(text, new RegExp(look.id, 'u'))
  }
})

await check('antipatterns lists all 15 with a concrete fix', async () => {
  const { value, text } = await run({ action: 'antipatterns' })
  assert.equal(value.count, LOOK_ANTIPATTERNS.length)
  assert.equal(LOOK_ANTIPATTERNS.length, 15)
  assert.match(text, /一眼 AI 味/u)
  for (const item of value.data.antipatterns) {
    assert.ok(typeof item.fixZh === 'string' && /\d/u.test(item.fixZh), `${item.id} fix must contain a number`)
  }
})

await check('rules lists the cut-seam rules with thresholds', async () => {
  const { value, text } = await run({ action: 'rules' })
  assert.match(text, /剪辑缝/u)
  assert.ok(value.data.rules.length >= 5, `expected >=5 rules, got ${value.data.rules.length}`)
  for (const rule of value.data.rules) {
    assert.ok(typeof rule.ruleZh === 'string' && rule.ruleZh.length > 4)
  }
})

await check('cards returns recipe cards with the "what happens if you turn this" column', async () => {
  const { value, text } = await run({ action: 'cards', query: '标题', limit: 3 })
  assert.ok(value.count > 0, 'a search for 标题 must hit some cards')
  assert.match(text, /镜头配方卡/u)
  assert.match(text, /往哪调会怎样/u, 'the params table must carry the knob-direction column')
  assert.ok(SHOT_CARDS.length >= 40, `expected >=40 cards in the library, got ${SHOT_CARDS.length}`)
})

await check('cards honours the category and energy filters', async () => {
  const byCategory = await run({ action: 'cards', category: 'typography', limit: 5 })
  assert.ok(byCategory.value.count > 0)
  for (const entry of byCategory.value.data.entries) assert.equal(entry.category, 'typography')
  const byEnergy = await run({ action: 'cards', energy: 'high', limit: 5 })
  assert.ok(byEnergy.value.count > 0)
  for (const entry of byEnergy.value.data.entries) assert.equal(entry.energy, 'high')
})

await check('cards degrades gracefully when nothing matches', async () => {
  const { value, text } = await run({ action: 'cards', query: 'zzzz-no-such-shot-zzzz' })
  assert.equal(value.count, 0)
  assert.match(text, /没有匹配/u)
})

await check('budget answers both "how many strokes" and "how long should this genre be"', async () => {
  const { value, text } = await run({ action: 'budget', seconds: 30, kind: 'demo' })
  assert.match(text, /时长预算/u)
  assert.equal(value.data.budget.maxStrokes, 117)
  assert.ok(value.data.budget.genreRange !== null)
  assert.equal(value.data.budget.withinGenreRange, true)
  // A duration outside the genre range must be flagged rather than clamped silently.
  const outOfRange = await run({ action: 'budget', seconds: 300, kind: 'bumper' })
  assert.equal(outOfRange.value.data.budget.withinGenreRange, false)
})

await check('show resolves a move, a transition and a shot card by id', async () => {
  const move = await run({ action: 'show', id: 'push-in' })
  assert.match(move.text, /缓推/u)
  const transition = await run({ action: 'show', id: 'dissolve' })
  assert.match(transition.text, /溶|dissolve|叠/u)
  const card = await run({ action: 'show', id: 'camera.push-in' })
  assert.match(card.text, /镜头配方卡/u)
})

await check('show rejects an unknown id with a message that names the alternatives', async () => {
  await assert.rejects(
    () => def.execute({ action: 'show', id: 'no-such-thing' }, {}),
    (error) => {
      assert.match(error.message, /no-such-thing/u)
      assert.match(error.message, /moves|looks|cards/u)
      return true
    },
  )
})

await check('every action returns report text, and the payload is JSON-safe', async () => {
  for (const args of [
    { action: 'moves' },
    { action: 'transitions' },
    { action: 'easing' },
    { action: 'looks' },
    { action: 'antipatterns' },
    { action: 'rules' },
    { action: 'cards', query: '数据', limit: 2 },
    { action: 'budget', seconds: 12 },
  ]) {
    const { value, text } = await run(args)
    assert.ok(typeof text === 'string' && text.length > 40, `${args.action} produced a short report`)
    assert.ok(value.kind === 'moves')
    // The whole payload has to survive a JSON round-trip for tool results.
    assert.deepEqual(JSON.parse(JSON.stringify(value.data)), value.data)
  }
})

await check('isConcurrencySafe is true: the vocabulary is read-only', () => {
  assert.equal(def.isConcurrencySafe(), true)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`\n${name}\n${error.stack}`)
  process.exitCode = 1
}
