#!/usr/bin/env node
/**
 * Build deterministic video fixtures for the video perception engine.
 *
 * Output (under test/fixtures/):
 *   scenes.mp4       12 s, 640x360 @ 25 fps, three 4 s scenes + 440 Hz sine audio
 *                    scene 1: dark red flat + centred white text  (YAVG ~ 35)
 *                    scene 2: bright blue flat + centred yellow text (YAVG ~ 90)
 *                    scene 3: testsrc2 motion
 *   tiny-solid.mp4   1 s single colour + sine audio  (degenerate short clip)
 *   muted-3s.mp4     3 s testsrc2 video with -an     (no audio stream)
 *   static-30s.mp4   30 s flat colour + SILENT track (zero cuts: density floor,
 *                    freeze detection and silence detection ground truth)
 *   truncated.mp4    scenes.mp4 truncated mid-data: probes fine, decode fails part-way
 *
 * `muted-3s.mp4` is deliberately NOT called `no-audio.mp4`: the audio-engine
 * teammate owns a fixture with that name in the same directory.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatBytes, resolveTools, runOrThrow } from '../lib/ffmpeg.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

// The font path must be escaped twice when passed as a raw argv element: one
// backslash is consumed by the filtergraph parser and one by drawtext's own
// option parser. Only the fixture generator needs this; lib/video.js treats a
// drawtext failure as non-fatal.
const FONT = 'C\\\\:/Windows/Fonts/arial.ttf'

const VIDEO_ENCODE = [
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '20',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
]

/** Draw a centred caption on one branch and normalise its pixel format. */
function captionFilter(index, text, fontcolor) {
  const props = [
    'format=yuv420p',
    'setsar=1',
  ].join(',')
  if (text === null) return `[${index}:v]${props}[v${index}]`
  return (
    `[${index}:v]drawtext=fontfile=${FONT}:text='${text}':fontcolor=${fontcolor}:` +
    `fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2,${props}[v${index}]`
  )
}

async function buildScenes(tools) {
  const out = join(FIXTURES, 'scenes.mp4')
  const graph = [
    captionFilter(0, 'SCENE ONE', 'white'),
    captionFilter(1, 'SCENE TWO', 'yellow'),
    captionFilter(2, null, 'white'),
    '[v0][v1][v2]concat=n=3:v=1:a=0[vout]',
  ].join(';')
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x5a0a0a:s=640x360:r=25:d=4',
    '-f', 'lavfi', '-i', 'color=c=0x1e64c8:s=640x360:r=25:d=4',
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=12',
    '-filter_complex', graph,
    '-map', '[vout]', '-map', '3:a',
    ...VIDEO_ENCODE,
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    out,
  ]
  await runOrThrow(tools.ffmpeg, args)
  return out
}

async function buildTinySolid(tools) {
  const out = join(FIXTURES, 'tiny-solid.mp4')
  await runOrThrow(tools.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x203040:s=320x180:r=25:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
    '-map', '0:v', '-map', '1:a',
    ...VIDEO_ENCODE,
    '-c:a', 'aac', '-b:a', '96k', '-shortest',
    out,
  ])
  return out
}

async function buildNoAudio(tools) {
  const out = join(FIXTURES, 'muted-3s.mp4')
  await runOrThrow(tools.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=3',
    '-an',
    ...VIDEO_ENCODE,
    out,
  ])
  return out
}

/**
 * 30 s of a single flat colour with a SILENT audio track: the zero-cut case
 * (shot boundaries come only from the density floor) plus ground truth for the
 * freeze detector (the whole clip is static) and the silence detector (the whole
 * soundtrack is digital silence).
 */
async function buildStaticSilent(tools) {
  const out = join(FIXTURES, 'static-30s.mp4')
  await runOrThrow(tools.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x303030:s=640x360:r=25:d=30',
    '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono:d=30',
    '-map', '0:v', '-map', '1:a',
    ...VIDEO_ENCODE,
    '-c:a', 'aac', '-b:a', '64k', '-shortest',
    out,
  ])
  return out
}

/**
 * Copy scenes.mp4 but cut it off at ~55% of its bytes. Because the fixture is
 * written with `+faststart` (moov atom first) the container still probes, while
 * decoding runs out of data part-way: exactly the "corrupt but probeable" case
 * the engine must survive with warnings instead of an exception.
 */
async function buildTruncated(source) {
  const out = join(FIXTURES, 'truncated.mp4')
  const bytes = await readFile(source)
  const cut = Math.max(4096, Math.floor(bytes.length * 0.55))
  await writeFile(out, bytes.subarray(0, cut))
  return out
}

async function report(paths) {
  for (const path of paths) {
    const info = await stat(path)
    console.log(`fixture ${path}`)
    console.log(`  ${formatBytes(info.size)}`)
  }
}

async function main() {
  await mkdir(FIXTURES, { recursive: true })
  const tools = await resolveTools()
  console.log(`ffmpeg: ${tools.version}`)
  // Rebuild from scratch so stale artifacts can never mask a regression.
  // Only touch files this generator owns (no-audio.mp4 belongs to the audio suite).
  for (const name of ['scenes.mp4', 'tiny-solid.mp4', 'muted-3s.mp4', 'static-30s.mp4', 'truncated.mp4']) {
    await rm(join(FIXTURES, name), { force: true })
  }
  const scenes = await buildScenes(tools)
  const tiny = await buildTinySolid(tools)
  const muted = await buildNoAudio(tools)
  const staticClip = await buildStaticSilent(tools)
  const truncated = await buildTruncated(scenes)
  await report([scenes, tiny, muted, staticClip, truncated])
  console.log('fixtures ready')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
