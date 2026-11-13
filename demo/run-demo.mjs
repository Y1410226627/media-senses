/**
 * Runnable demo: analyze the media files in `demo/media` with the real plugin
 * tools and write the model-facing reports plus every generated image to
 * `demo/output`.
 *
 *   node demo/run-demo.mjs
 *
 * The same code path the Host uses (`ctx.tools.register` -> `execute` ->
 * `output.render`), against real footage and real music instead of fixtures.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const media = join(here, 'media')
const output = join(here, 'output')
await mkdir(output, { recursive: true })

const { apply } = await import(pathToFileURL(join(root, 'index.js')).href)
const registry = new Map()
apply({ tools: { register: (definition) => (registry.set(definition.name, definition), () => {}) } }, { asrMaxSeconds: 120, whisperModel: 'base' })

async function run(name, args, reportName) {
  const definition = registry.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const startedAt = Date.now()
  const value = await definition.execute(args, {})
  const seconds = Math.round((Date.now() - startedAt) / 100) / 10
  const blocks = definition.output.render(args, value)
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n')
  const reportPath = join(output, reportName ?? `${basename(args.path, '.??').replace(/\.[^.]+$/u, '')}-${name}.md`)
  await writeFile(reportPath, text, 'utf8')
  console.log(`\n${'='.repeat(80)}\n${name}  ${args.path}  (${seconds}s)\n${'='.repeat(80)}`)
  console.log(text.split('\n').slice(0, 26).join('\n'))
  console.log(`… (${text.length} chars total, report: ${reportPath})`)
  if (value.artifacts !== undefined) {
    for (const [key, path] of Object.entries(value.artifacts)) {
      if (typeof path === 'string' && path.length > 0) console.log(`artifact ${key}: ${path}`)
    }
  }
  return { value, text, seconds }
}

const video = join(media, 'real-video-5s-music.mp4')
const narrated = join(media, 'narrated.mp4')
const music = join(media, 'real-music-15s.mp3')
const trailer = join(media, 'trailer.mp4')

await run('media_probe', { path: video }, '01-probe-real-video.md')
await run('media_watch_video', { path: trailer, output_dir: join(output, 'trailer'), language: 'en' }, '02-watch-trailer.md')
await run('media_watch_video', { path: narrated, output_dir: join(output, 'narrated'), language: 'en' }, '03-watch-narrated.md')
await run('media_listen_audio', { path: music, output_dir: join(output, 'real-music') }, '04-listen-real-music.md')
await run('media_frame', { path: trailer, time: 12.5, output_dir: join(output, 'frame') }, '05-frame-trailer.md')

console.log(`\nAll reports written to ${output}`)

