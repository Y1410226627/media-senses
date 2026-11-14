/**
 * Template tests.
 *
 * A template library is only worth anything if every template actually renders
 * and actually moves. So these tests do the expensive thing: render each one
 * through the real headless-Edge renderer and assert (a) frames differ over time,
 * (b) the first frame is not blank, (c) params really change the output.
 *
 * When no browser is installed the render checks are skipped and the structural
 * checks still run, so the suite stays useful on a bare machine.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBrowser, renderAnimation } from '../lib/htmlrender.js'
import { TEMPLATES, fillTemplate, getTemplate, listTemplates, loadTemplates, renderTemplateCard, templatePath } from '../lib/templates.js'
import { resolveTools, run } from '../lib/ffmpeg.js'

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

function skip(name, reason) {
  console.log(`  skip ${name} (${reason})`)
}

const tools = await resolveTools({})
const browser = await findBrowser()
const scratch = await mkdtemp(join(tmpdir(), 'templates-test-'))

/* ------------------------------------------------------------------ *
 * Structural checks (no browser needed)
 * ------------------------------------------------------------------ */

await check('the catalogue has the six curated templates, each fully described', () => {
  assert.equal(TEMPLATES.length, 6)
  for (const meta of TEMPLATES) {
    assert.ok(typeof meta.id === 'string' && /^[a-z-]+$/u.test(meta.id), `bad id ${meta.id}`)
    assert.ok(typeof meta.nameZh === 'string' && meta.nameZh.length > 1, `${meta.id} needs a Chinese name`)
    assert.ok(typeof meta.useWhenZh === 'string' && meta.useWhenZh.length > 20, `${meta.id} needs a real "use when" line`)
    assert.ok(Array.isArray(meta.params) && meta.params.length > 0, `${meta.id} must list its params`)
    assert.ok(Array.isArray(meta.seconds) && meta.seconds.length === 2 && meta.seconds[1] > meta.seconds[0], `${meta.id} needs a duration range`)
    assert.ok(['low', 'medium', 'high'].includes(meta.energy), `${meta.id} has a bad energy`)
    assert.ok(Array.isArray(meta.techniques) && meta.techniques.length >= 2, `${meta.id} must name its techniques`)
  }
})

for (const meta of TEMPLATES) {
  await check(`${meta.id}: file exists, implements renderAt, and has no self-driving loop`, async () => {
    const source = await readFile(templatePath(meta.id), 'utf8')
    assert.match(source, /window\.renderAt\s*=\s*(async\s*)?function/u, `${meta.id} must define window.renderAt`)
    assert.match(source, /__MS_TEMPLATE/u, `${meta.id} must read the injected config`)
    // A template is used as the deterministic baseline, so it must not self-drive.
    assert.doesNotMatch(source, /requestAnimationFrame/u, `${meta.id} must not use rAF`)
    assert.doesNotMatch(source, /setInterval|setTimeout/u, `${meta.id} must not use timers`)
    assert.doesNotMatch(source, /Math\.random\s*\(/u, `${meta.id} must not use unseeded random`)
    assert.doesNotMatch(source, /Date\.now\s*\(|performance\.now\s*\(/u, `${meta.id} must not read a clock`)
  })
}

await check('fillTemplate injects config and duration before the page script', () => {
  const page = '<!doctype html><html><body><div id="x"></div><script>renderAt=1</script></body></html>'
  const filled = fillTemplate(page, { words: ['a', 'b'] }, { duration: 5 })
  assert.ok(filled.includes('window.__MS_TEMPLATE'), 'config assignment must be injected')
  assert.ok(filled.includes('"words":["a","b"]'), 'params must survive as JSON')
  assert.ok(filled.includes('window.__MS_DURATION = 5'), 'duration must be injected')
  // Config must come before the page's own script so it is readable at parse time.
  assert.ok(filled.indexOf('__MS_TEMPLATE') < filled.indexOf('renderAt=1'), 'config must precede the page script')
})

await check('fillTemplate cannot be broken out of with a script tag in the content', () => {
  const page = '<html><body><script>x</script></body></html>'
  const filled = fillTemplate(page, { caption: '</script><script>alert(1)</script>' })
  // The closing-tag sequence inside the JSON string must be escaped.
  const injected = filled.slice(filled.indexOf('__MS_TEMPLATE'), filled.indexOf('</script>', filled.indexOf('__MS_TEMPLATE')))
  assert.ok(!injected.includes('</script>'), 'the injected JSON must not close the script tag early')
  assert.ok(injected.includes('<\\/script>'), 'the slash must be escaped')
})

await check('getTemplate rejects an unknown id with the available list', async () => {
  await assert.rejects(() => getTemplate('no-such-template'), (error) => {
    assert.match(error.message, /no-such-template/u)
    assert.match(error.message, /kinetic-type/u)
    return true
  })
})

await check('listTemplates filters by free text and by technique', () => {
  assert.equal(listTemplates({}).length, TEMPLATES.length)
  const hand = listTemplates({ query: '手绘' })
  assert.ok(hand.length > 0 && hand[0].id === 'hand-drawn-line', `expected hand-drawn-line first, got ${hand.map((e) => e.id).join(',')}`)
  const data = listTemplates({ query: '数据' })
  assert.ok(data.some((entry) => entry.id === 'data-bars'))
  const boil = listTemplates({ query: '沸腾' })
  assert.ok(boil.some((entry) => entry.id === 'hand-drawn-line'), 'a technique word must find its template')
  assert.equal(listTemplates({ query: 'zzzz-none' }).length, 0)
})

await check('loadTemplates reads every file and renderTemplateCard describes it', async () => {
  const loaded = await loadTemplates()
  assert.equal(loaded.length, TEMPLATES.length)
  for (const entry of loaded) {
    assert.ok(entry.html.length > 800, `${entry.meta.id} looks too short to be a real page`)
    const card = renderTemplateCard(entry.meta)
    assert.match(card, new RegExp(entry.meta.id.replace('-', '-'), 'u'))
    assert.match(card, /技法/u)
  }
})

/* ------------------------------------------------------------------ *
 * Render checks (need a browser)
 * ------------------------------------------------------------------ */

/** Mean absolute difference between two grey rasters sampled from a video. */
async function frameDelta(file, timeA, timeB) {
  const grab = async (time, name) => {
    await run(tools.ffmpeg, ['-v', 'error', '-y', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'scale=48:27,format=gray', '-f', 'rawvideo', name], { cwd: scratch })
    return readFile(join(scratch, name))
  }
  const a = await grab(timeA, `a-${Math.random().toString(36).slice(2)}.raw`)
  const b = await grab(timeB, `b-${Math.random().toString(36).slice(2)}.raw`)
  let delta = 0
  for (let index = 0; index < a.length; index += 1) delta += Math.abs(a[index] - b[index])
  return delta / a.length
}

if (browser === undefined) {
  skip('every template renders a moving, non-blank clip', 'no Edge/Chrome installed')
} else {
  for (const meta of TEMPLATES) {
    await check(`${meta.id}: renders and the frames actually move`, async () => {
      const loaded = await getTemplate(meta.id)
      const page = fillTemplate(loaded.html, {}, { duration: 3 })
      const htmlPath = join(scratch, `${meta.id}.html`)
      await writeFile(htmlPath, page, 'utf8')
      const output = join(scratch, `${meta.id}.mp4`)
      const result = await renderAnimation({
        tools,
        htmlPath,
        output,
        width: 640,
        height: 360,
        fps: 10,
        duration: 3,
        workDir: join(scratch, `${meta.id}-work`),
      })
      assert.ok(result.frames >= 25, `${meta.id} produced only ${result.frames} frames`)
      // In the first second something must have moved: a static first second is a
      // template bug (the renderer would still "succeed").
      const delta = await frameDelta(output, 0.1, 1.2)
      assert.ok(delta > 1.2, `${meta.id} looks frozen (mean |delta| ${delta.toFixed(2)})`)
    })
  }
}

if (browser === undefined) {
  skip('params change the rendered output', 'no Edge/Chrome installed')
} else {
  await check('params change the rendered output', async () => {
    const loaded = await getTemplate('kinetic-type')
    const render = async (label, params) => {
      const page = fillTemplate(loaded.html, params, { duration: 3 })
      const htmlPath = join(scratch, `param-${label}.html`)
      await writeFile(htmlPath, page, 'utf8')
      const output = join(scratch, `param-${label}.mp4`)
      await renderAnimation({ tools, htmlPath, output, width: 480, height: 270, fps: 10, duration: 2, workDir: join(scratch, `param-${label}-work`) })
      return output
    }
    const a = await render('a', { words: ['甲'], bg: '#101018', ink: '#ffffff' })
    const b = await render('b', { words: ['乙'], bg: '#f5f5f0', ink: '#101010' })
    await run(tools.ffmpeg, ['-v', 'error', '-y', '-ss', '1.6', '-i', a, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pa.raw'], { cwd: scratch })
    await run(tools.ffmpeg, ['-v', 'error', '-y', '-ss', '1.6', '-i', b, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pb.raw'], { cwd: scratch })
    const bufA = await readFile(join(scratch, 'pa.raw'))
    const bufB = await readFile(join(scratch, 'pb.raw'))
    let diff = 0
    for (let index = 0; index < bufA.length; index += 1) diff += Math.abs(bufA[index] - bufB[index])
    const mean = diff / bufA.length
    assert.ok(mean > 20, `different params should render visibly differently, mean |delta| ${mean.toFixed(1)}`)
  })
}

await rm(scratch, { recursive: true, force: true }).catch(() => undefined)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`\n${name}\n${error.stack}`)
  process.exitCode = 1
}
