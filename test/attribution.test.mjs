/**
 * Attribution completeness.
 *
 * The project promises several things about credits, and each has been wrong at
 * least once: a repo listed twice, a repo claimed as "not absorbed" while its
 * ideas were in the code, and a README table that predated the whole batch. Those
 * are documentation bugs with a licensing dimension, so they get a test.
 *
 * Assertions:
 *  1. All 18 second-batch repositories are credited exactly once in THIRD-PARTY.md.
 *  2. All 18 are also named in the README acknowledgements section.
 *  3. No repository appears in both the "absorbed" and the "read only" table.
 *  4. Every `lib/*.js`, `assets/*` or `test/*` path claimed as a landing site exists.
 *  5. The non-commercial / AGPL / unlicensed projects are explicitly flagged.
 */
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
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

const thirdParty = await readFile(join(root, 'THIRD-PARTY.md'), 'utf8')
const readme = await readFile(join(root, 'README.md'), 'utf8')

/** The 18 repositories the objective names, by `owner/repo` slug. */
const BATCH = [
  'sarpstar/cinecode',
  'mromidev/claude-animated-shorts',
  'lemomo-ai/lemo-opuscar',
  'alchaincyf/huashu-art-motion',
  'Vincentwei1021/mg-styles-15',
  'Vincentwei1021/video-shotcraft',
  'alexgreensh/anidoodle',
  'cth9191/animate',
  'threerocks/sweety-handdraw-video',
  'bangtutorial/bang-motion',
  'JohnHeibel/ClaudeAnimationBase',
  'yihui-dev/awesome-opus5-5-videos',
  'joeseesun/opus-video-prompts',
  'feitangyuan/onetake',
  'heygen-com/hyperframes',
  'remotion-dev/skills',
  'roboflow/supervision',
  'calesthio/OpenMontage',
]

/**
 * Return the body of the first heading at `level` matching `pattern`, including
 * every deeper heading underneath it, stopping at the next heading of the same or
 * shallower level.
 */
function sectionBody(text, pattern, level = 2) {
  const lines = text.split(/\r?\n/u)
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*)$/u.exec(lines[index])
    if (match === null) continue
    if (match[1].length === level && pattern.test(match[2])) {
      start = index
      break
    }
  }
  if (start === -1) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/u.exec(lines[index])
    if (match !== null && match[1].length <= level) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const absorbed = sectionBody(thirdParty, /已吸收并落地/u, 3)
const readOnly = sectionBody(thirdParty, /读过但未采用/u, 3)

await check('THIRD-PARTY has an absorbed table and a read-only table', () => {
  assert.ok(absorbed !== undefined, 'missing the "已吸收并落地" section')
  assert.ok(readOnly !== undefined, 'missing the "读过但未采用" section')
})

await check('all 18 second-batch repositories appear exactly once in THIRD-PARTY', () => {
  for (const slug of BATCH) {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const count = (thirdParty.match(new RegExp(`github\\.com/${escaped}\\b`, 'gu')) ?? []).length
    assert.equal(count, 1, `${slug} is credited ${count} times in THIRD-PARTY.md (expected exactly 1)`)
  }
})

await check('all 18 second-batch repositories are named in the README acknowledgements', () => {
  const section = sectionBody(readme, /参考与致谢/u, 2)
  assert.ok(section !== undefined, 'README section 7 not found')
  const missing = BATCH.filter((slug) => !section.includes(`github.com/${slug}`))
  assert.deepEqual(missing, [], `README section 7 does not credit: ${missing.join(', ')}`)
})

await check('the Credits table is split into the two waves, each complete', () => {
  const section = sectionBody(readme, /参考与致谢/u, 2)
  assert.match(section, /### 7\.1 上一轮/u)
  assert.match(section, /### 7\.2 第二批/u)
  // The first wave has to keep its own credits too.
  for (const earlier of [
    'FFmpeg/FFmpeg',
    'ggml-org/whisper.cpp',
    'Breakthrough/PySceneDetect',
    'librosa/librosa',
    'SAOS-3624/dsh-see-now',
  ]) {
    assert.ok(section.includes(earlier), `README lost the credit for ${earlier}`)
  }
})

await check('no repository is listed as both absorbed and not absorbed', () => {
  const absorbedSlugs = new Set()
  for (const match of absorbed.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/gu)) absorbedSlugs.add(match[1])
  for (const match of readOnly.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/gu)) {
    assert.ok(
      !absorbedSlugs.has(match[1]),
      `${match[1]} is claimed both absorbed and not absorbed`,
    )
  }
})

await check('ClaudeAnimationBase is recorded as absorbed (it backs lib/performance.js)', () => {
  assert.ok(absorbed.includes('JohnHeibel/ClaudeAnimationBase'), 'ClaudeAnimationBase must be in the absorbed table')
  assert.ok(!readOnly.includes('JohnHeibel/ClaudeAnimationBase'), 'ClaudeAnimationBase must not be in the read-only table')
  // And the module it backs must actually exist.
  assert.ok(thirdParty.includes('lib/performance.js'), 'the landing site must be named')
})

await check('every landing site claimed in THIRD-PARTY exists on disk', async () => {
  // Only paths inside this repository count. `assets/starter/index.html` lives in
  // the external skill, not here, so it is deliberately excluded.
  const claimed = new Set()
  for (const match of thirdParty.matchAll(/`((?:lib|test)\/[\w./-]+|assets\/templates\/[\w./-]+)`/gu)) claimed.add(match[1])
  const missing = []
  for (const path of claimed) {
    const info = await stat(join(root, path)).catch(() => undefined)
    if (info === undefined) missing.push(path)
  }
  assert.deepEqual(missing, [], `THIRD-PARTY points at files that do not exist: ${missing.join(', ')}`)
})

await check('the restrictive licences are called out, not just listed', () => {
  // A licence that constrains redistribution must be named as such somewhere.
  for (const [slug, reason] of [
    ['feitangyuan/onetake', /PolyForm Noncommercial/u],
    ['calesthio/OpenMontage', /AGPL-3\.0/u],
    ['lemomo-ai/lemo-opuscar', /CC BY-NC/u],
  ]) {
    assert.ok(thirdParty.includes(slug), `${slug} must be credited`)
    assert.match(thirdParty, reason, `${slug}'s licence constraint is not stated`)
  }
  // The summary table dedicated to red lines must exist.
  assert.match(thirdParty, /许可红线/u)
})

await check('the README points at THIRD-PARTY for the detail', () => {
  const section = sectionBody(readme, /参考与致谢/u, 2)
  assert.match(section, /THIRD-PARTY\.md/u)
})

await check('runtime dependencies that are not bundled are disclosed', () => {
  assert.match(thirdParty, /不随本仓库分发/u)
  // The page-side libraries are the easiest thing to forget: they are not ours.
  for (const library of ['GSAP', 'Lottie', 'Three.js', 'Anime.js']) {
    assert.ok(thirdParty.includes(library), `the optional page library ${library} is not disclosed`)
  }
  assert.match(thirdParty, /系统字体/u, 'system fonts used by drawtext are not disclosed')
})

await check('the project states it owns its own code and offers to fix overlap', () => {
  assert.match(thirdParty, /我们的代码/u)
  assert.match(thirdParty, /MIT/u)
  assert.match(thirdParty, /雷同|疏漏/u, 'there must be a "if we copied something, tell us" clause')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`\n${name}\n${error.stack}`)
  process.exitCode = 1
}

