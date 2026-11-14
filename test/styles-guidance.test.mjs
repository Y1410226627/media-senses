/**
 * Style-guidance tests.
 *
 * The 341-style library mixes three different prompt layouts. What matters is not
 * parsing them perfectly but answering one question reliably for a model that is
 * about to rewrite a style: **which parts define the style, and which may a new
 * episode swap?** Getting that split wrong is how a reproduction drifts from "in
 * this style" to "with these colours".
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { deriveGuidance, parseStyleSections, resolveSkillDir, getStyle, searchStyles } from '../lib/styles.js'

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

/* ------------------------------------------------------------------ *
 * Pure parsing (always runs, no skill install needed)
 * ------------------------------------------------------------------ */

const LEMO_STYLE = `# Test Style — Board

- 分类：L · 实证影像
- 长相：一块板

## 风格提示词

# Board — Style Prompt

## 1. Essence, and what it is not

A physical board in a room.

Not **Whiteboard Explainer** (hand drawing on a flat page).

## 2. Materials & rendering

- Board (z 0): procedural enamel.

## 3. Colour logic

- Ink: graphite = names, blue = water.

## 4. Type & subtitles

- Marker lettering.

## 7. Sound palette

- Room tone under the voice.

## 11. Variation space

The agent decides the structure.
`

const MG_STYLE = `# 极光与毛玻璃

## 风格提示词

# 弥散渐变 · Gradient Blur

## 怎么用

复制提示词。

## 提示词

# Style

弥散渐变 / 玻璃拟态。

# Output (fixed)

- 1920×1080, 30 fps, exactly 10.000 s.

# Creative seed

深靛底，4–5 个光斑。

# Signature features and key techniques (the result is judged against these)

大面积高斯模糊的彩色光斑缓慢漂移。

# Rules

- 光斑速度不超过 3 %/s。
`

await check('parseStyleSections splits on Markdown headings and keeps the bodies', () => {
  const sections = parseStyleSections(LEMO_STYLE)
  assert.ok(sections.length >= 5, `expected several sections, got ${sections.length}`)
  const essence = sections.find((section) => section.heading.includes('Essence'))
  assert.ok(essence !== undefined, 'the Essence heading must become a section')
  assert.match(essence.body, /physical board/u)
  assert.equal(essence.role, 'essence')
})

await check('parseStyleSections handles a prompt with no headings as one body', () => {
  const sections = parseStyleSections('一段没有标题的散文。')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].heading, '')
  assert.equal(sections[0].role, 'body')
})

await check('parseStyleSections returns nothing for empty input', () => {
  assert.deepEqual(parseStyleSections(''), [])
  assert.deepEqual(parseStyleSections(undefined), [])
})

await check('numbered headings still map to their role', () => {
  const sections = parseStyleSections('## 2. Materials & rendering\n\nenamel')
  assert.equal(sections[0].role, 'materials')
})

await check('deriveGuidance separates invariants from variables on the Lemo layout', () => {
  const guidance = deriveGuidance(LEMO_STYLE)
  assert.equal(guidance.hasStructure, true)
  const invariantRoles = guidance.invariants.map((section) => section.role)
  assert.ok(invariantRoles.includes('essence'), 'essence defines the style')
  assert.ok(invariantRoles.includes('materials'), 'materials define the style')
  assert.ok(invariantRoles.includes('colour'), 'colour logic defines the style')
  const variableRoles = guidance.variables.map((section) => section.role)
  assert.ok(variableRoles.includes('type'), 'type is a variable')
  assert.ok(variableRoles.includes('sound'), 'sound is a variable')
  assert.ok(variableRoles.includes('variation'), 'the variation space is a variable')
  // An invariant must never also be listed as a variable.
  for (const role of invariantRoles) assert.ok(!variableRoles.includes(role), `${role} is in both lists`)
})

await check('deriveGuidance handles the mg-styles layout (bare # Style / # Signature features)', () => {
  const guidance = deriveGuidance(MG_STYLE)
  assert.equal(guidance.hasStructure, true)
  const invariantRoles = guidance.invariants.map((section) => section.role)
  assert.ok(invariantRoles.includes('essence'), `expected essence, got ${invariantRoles.join(',')}`)
  assert.ok(invariantRoles.includes('signature'), `expected signature, got ${invariantRoles.join(',')}`)
  const variableRoles = guidance.variables.map((section) => section.role)
  assert.ok(variableRoles.includes('output'))
  assert.ok(variableRoles.includes('variation'))
})

await check('deriveGuidance extracts the sentence carrying a prohibition, not the whole paragraph', () => {
  const guidance = deriveGuidance(LEMO_STYLE)
  assert.ok(guidance.banned.length > 0, 'the "Not ..." line is a prohibition')
  const joined = guidance.banned.join('\n')
  assert.match(joined, /Whiteboard Explainer/u)
  assert.match(joined, /never a generated image|Not \*\*Whiteboard/u)
  // The quoted constraint must be a sentence, not a 400-character paragraph.
  for (const item of guidance.banned) assert.ok(item.length <= 200, `banned item too long: ${item.length}`)
})

await check('deriveGuidance reports hasStructure=false for a single-blob prompt', () => {
  const guidance = deriveGuidance('## 风格提示词\n\n就一句话。')
  assert.equal(guidance.hasStructure, false)
  assert.deepEqual(guidance.invariants, [])
  assert.deepEqual(guidance.variables, [])
})

await check('deriveGuidance caps the banned list so the report cannot explode', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `- Never do thing ${index}.`)
  const guidance = deriveGuidance(`## 1. Essence, and what it is not\n\n${lines.join('\n')}`)
  assert.ok(guidance.banned.length <= 12, `banned list must be capped, got ${guidance.banned.length}`)
})

/* ------------------------------------------------------------------ *
 * Against the real library, when it is installed
 * ------------------------------------------------------------------ */

const skillDir = resolveSkillDir('')
const hasLibrary = existsSync(join(skillDir, 'references', 'catalog.json'))

if (!hasLibrary) {
  console.log(`  skip real-library checks (no ${skillDir})`)
} else {
  await check('every sampled real style returns a guidance object', async () => {
    const catalog = JSON.parse(await readFile(join(skillDir, 'references', 'catalog.json'), 'utf8'))
    const ids = ['L10', 'V10', 'A1', 'Z10', 'M1'].filter((id) => catalog.entries.some((entry) => entry.id === id))
    assert.ok(ids.length >= 3, 'expected at least three sampled styles to exist')
    for (const id of ids) {
      const style = await getStyle(skillDir, id)
      assert.ok(style !== undefined, `${id} should resolve`)
      assert.ok(style.guidance !== undefined, `${id} must carry guidance`)
      assert.ok(Array.isArray(style.guidance.invariants), `${id} invariants must be an array`)
      assert.ok(Array.isArray(style.guidance.variables), `${id} variables must be an array`)
      assert.ok(Array.isArray(style.guidance.banned), `${id} banned must be an array`)
      assert.equal(typeof style.guidance.hasStructure, 'boolean')
    }
  })

  await check('a structured style yields at least one invariant', async () => {
    for (const id of ['L10', 'V10']) {
      const style = await getStyle(skillDir, id)
      if (style === undefined || style.guidance.hasStructure === false) continue
      assert.ok(
        style.guidance.invariants.length > 0,
        `${id} is structured but produced no invariants: ${style.guidance.roles.join(',')}`,
      )
    }
  })

  await check('getStyle still returns the prompt and entry unchanged', async () => {
    const style = await getStyle(skillDir, 'L10')
    assert.ok(typeof style.prompt === 'string' && style.prompt.length > 100)
    assert.equal(style.entry.id, 'L10')
    assert.ok(typeof style.promptPath === 'string')
  })

  await check('searchStyles ranks a category match above an incidental keyword hit', async () => {
    // The category is the visual family; a style in that family should come first.
    const results = await searchStyles({ skillDir, query: '字', limit: 5 })
    assert.ok(results.length > 0)
    const topCategories = results.slice(0, 2).map((entry) => entry.category)
    assert.ok(
      topCategories.some((category) => category.includes('字')),
      `expected a 字-category style near the top, got ${topCategories.join(' / ')}`,
    )
  })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`\n${name}\n${error.stack}`)
  process.exitCode = 1
}
