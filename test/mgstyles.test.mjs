#!/usr/bin/env node
/**
 * media-senses — whole-film motion-graphics style tests.
 *
 * These 15 styles are a different layer from the 341 single-shot style prompts:
 * one style fixes palette, type scale, easing family, texture and the list of
 * things the film must never do, so ten shots read as one film. The tests pin the
 * three things a caller depends on:
 *
 *  1. every style is complete enough to hand to a model (palette, type, motion,
 *     forbidden list, and a prompt that stands on its own);
 *  2. search can actually find a style by mood rather than only by id;
 *  3. the runnable templates exist, are self-contained, and implement the
 *     `window.renderAt(t)` contract that media_animate depends on.
 *
 * Run from `media-senses/`:  node test/mgstyles.test.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MG_STYLES, MG_STYLE_COUNT, MG_FAMILIES, getMgStyle, findMgStyles, mgStylePrompt } from '../lib/mgstyles.js'

// fileURLToPath, not `new URL(...).pathname`: the workspace path contains Chinese
// characters and the raw pathname comes back percent-encoded.
const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = join(HERE, '..', 'assets', 'mgstyles')

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

await check('exactly 15 whole-film styles are present', () => {
  assert.equal(MG_STYLE_COUNT, 15)
  assert.equal(MG_STYLES.length, 15)
  const ids = MG_STYLES.map((style) => style.id)
  assert.equal(new Set(ids).size, 15, 'duplicate style id')
})

await check('every style is complete enough to hand to a model', () => {
  for (const style of MG_STYLES) {
    assert.ok(typeof style.id === 'string' && style.id.length > 2, `${style.id}: id`)
    assert.ok(typeof style.zh === 'string' && style.zh.length > 1, `${style.id}: zh name`)
    assert.ok(typeof style.en === 'string' && style.en.length > 3, `${style.id}: en name`)
    assert.ok(['low', 'medium', 'high'].includes(style.energy), `${style.id}: energy ${style.energy}`)
    assert.ok(MG_FAMILIES.some((family) => family.id === style.family), `${style.id}: unknown family ${style.family}`)
    assert.ok(Array.isArray(style.palette) && style.palette.length >= 4, `${style.id}: palette too small`)
    for (const hex of style.palette) {
      assert.match(hex, /^#[0-9A-Fa-f]{6}$/u, `${style.id}: bad hex ${hex}`)
    }
    assert.ok(typeof style.typeZh === 'string' && style.typeZh.length > 30, `${style.id}: type scale`)
    assert.ok(typeof style.motionZh === 'string' && style.motionZh.length > 40, `${style.id}: motion vocabulary`)
    assert.ok(typeof style.textureZh === 'string' && style.textureZh.length > 5, `${style.id}: texture`)
    assert.ok(Array.isArray(style.avoidZh) && style.avoidZh.length >= 3, `${style.id}: forbidden list`)
    assert.ok(typeof style.promptZh === 'string' && style.promptZh.length > 400, `${style.id}: prompt too thin`)
  }
})

await check('palette roles, when present, cover the palette', () => {
  for (const style of MG_STYLES) {
    if (!Array.isArray(style.paletteRoles)) continue
    for (const entry of style.paletteRoles) {
      assert.ok(Array.isArray(entry) && entry.length === 2, `${style.id}: role entry shape`)
      assert.match(entry[0], /^#[0-9A-Fa-f]{6}$/u, `${style.id}: role hex`)
      assert.ok(typeof entry[1] === 'string' && entry[1].length > 0, `${style.id}: role name`)
    }
  }
})

/* ------------------------------------------------------------------ *
 * Lookup and search
 * ------------------------------------------------------------------ */

await check('getMgStyle resolves by id and by upstream code', () => {
  assert.equal(getMgStyle('hud').id, 'hud')
  // The upstream codes (01-, 02-, …) are what a reader of the source would use.
  assert.equal(getMgStyle('22-hud').id, 'hud')
  assert.equal(getMgStyle('nope'), undefined)
  assert.equal(getMgStyle(''), undefined)
})

await check('findMgStyles finds styles by mood, not just by id', () => {
  const ink = findMgStyles('水墨')
  assert.ok(ink.length >= 1, 'ink wash should be findable by its Chinese name')
  assert.equal(ink[0].id, 'ink-wash')

  const neon = findMgStyles('霓虹')
  assert.ok(neon.length >= 1, 'neon should match something')

  // An empty query is "no filter", not "no results".
  assert.equal(findMgStyles('').length, 15)
  assert.equal(findMgStyles(undefined).length, 15)

  // A nonsense query returns nothing rather than everything.
  assert.equal(findMgStyles('zzzzqqqq').length, 0)
})

await check('findMgStyles honours the limit', () => {
  assert.ok(findMgStyles('', { limit: 3 }).length <= 3)
})

/* ------------------------------------------------------------------ *
 * Prompt generation
 * ------------------------------------------------------------------ */

await check('mgStylePrompt is a self-contained instruction', () => {
  const prompt = mgStylePrompt('flat-vector')
  assert.ok(prompt.length > 400, `prompt length ${prompt.length}`)
  // It has to name the render contract media_animate relies on.
  assert.ok(prompt.includes('renderAt'), 'must state the window.renderAt(t) contract')
  // …and the practical constraints of an offline single file.
  assert.ok(prompt.includes('内联') || prompt.includes('inline'), 'must ask for a self-contained file')
  assert.ok(!/https?:\/\//u.test(prompt), 'the prompt must not send the model to the network')
  // The style specifics have to survive into the prompt.
  assert.ok(prompt.includes('扁平矢量'), 'must name the style')
  const style = getMgStyle('flat-vector')
  assert.ok(prompt.includes(style.palette[0]), 'must carry the palette')
})

await check('mgStylePrompt differs between styles', () => {
  const flat = mgStylePrompt('flat-vector')
  const hud = mgStylePrompt('hud')
  assert.notEqual(flat, hud)
  assert.ok(hud.includes('HUD') || hud.includes('全息') || hud.includes('科幻'), 'hud prompt should read as hud')
})

await check('mgStylePrompt throws on an unknown style instead of inventing one', () => {
  assert.throws(() => mgStylePrompt('does-not-exist'), /does-not-exist|风格/u)
})

/* ------------------------------------------------------------------ *
 * Runnable templates
 * ------------------------------------------------------------------ */

const TEMPLATES = ['flat-vector.html', 'isometric.html', 'hud.html']

await check('the three runnable templates exist', async () => {
  for (const name of TEMPLATES) {
    const body = await readFile(join(TEMPLATE_DIR, name), 'utf8')
    assert.ok(body.length > 2000, `${name} looks empty (${body.length} bytes)`)
  }
})

await check('templates implement the renderAt(t) contract', async () => {
  for (const name of TEMPLATES) {
    const body = await readFile(join(TEMPLATE_DIR, name), 'utf8')
    assert.ok(/window\.renderAt\s*=/u.test(body), `${name} must define window.renderAt`)
  }
})

await check('templates are offline and deterministic', async () => {
  for (const name of TEMPLATES) {
    const body = await readFile(join(TEMPLATE_DIR, name), 'utf8')
    assert.ok(!/https?:\/\//u.test(body), `${name} must not reference the network`)
    assert.ok(!/Math\.random\s*\(/u.test(body), `${name} must not use Math.random (render must be repeatable)`)
    assert.ok(!/Date\.now\s*\(|performance\.now\s*\(/u.test(body), `${name} must not read the clock`)
  }
})

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log('')
console.log(`${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`\n--- ${failure.name} ---`)
    console.log(failure.error instanceof Error ? failure.error.stack ?? failure.error.message : String(failure.error))
  }
  process.exitCode = 1
}
