/**
 * Continuity analyser for media-senses ("does this cut carry anything over,
 * or does it just paste a new scene on?").
 *
 * Why this module exists: a numeric comparison of shot counts / brightness /
 * BPM cannot tell whether a video feels like a slide deck. The measurable
 * difference is *continuity across boundaries*: in continuous filmmaking an
 * object or backdrop survives the cut (a carried subject, a static anchor),
 * while in a slide-show nothing survives. This module quantifies that and also
 * measures how long the top / bottom / centre zones are occupied by
 * non-background content (titles, subtitles, HUD).
 *
 * The method follows the public calibration notes captured from the "onetake"
 * screen-capture work (method idea only, code written independently here):
 *
 *  - boundary window = 0.4 s: compare the frame just before the boundary with
 *    the frame 0.4 s around it, on a small 320x180 rgb24 raster;
 *  - the raster is split into a 12x9 block grid; for each block of the PRE
 *    frame the POST frame is searched over ±8 px and the minimum SAD is kept;
 *    a block below the SAD threshold "survived" the cut;
 *  - carried  = something survived and moved >= 2% of the image diagonal, or
 *    scaled >= 10%;
 *  - anchored = the only/largest surviving thing is large (>= 3% of the frame)
 *    and did not move;
 *  - bare     = nothing survived (a new scene was pasted on);
 *  - exemptions: boundaries inside a hard-cut burst (>= 3 cuts within 1.5 s)
 *    and the last 1.2 s of the clip are not scored;
 *  - carry score = (carried + anchored / 2) / scored boundaries; < 0.5 reads
 *    as "like a PPT", < 0.7 deserves a warning.
 *
 * Decoding is ONE ffmpeg pass: `fps=2.5,select=…,scale=320:180,format=rgb24
 * -f rawvideo <relative name>` with `cwd = workDir` and a RELATIVE output name
 * (absolute paths appear only in ordinary `-i` arguments, so no drive-letter
 * colon ever enters a filtergraph). Only the 0.4 s windows around boundaries
 * are selected, so the raw payload is proportional to the cut count rather
 * than to the clip length. `-fps_mode passthrough` keeps exactly one decoded
 * frame per 2.5 fps grid tick (without it the 0.4 s filter/select output would
 * be duplicated/dropped by CFR conversion and pairs would misalign).
 *
 * Known blind spots (also written into the returned `blindSpots`):
 *  - a continuous world may legitimately have very few boundaries; a high
 *    carry score over fewer boundaries than the storyboard's shot count is
 *    NOT evidence that every cut is carried;
 *  - at 320 px wide, low-contrast detail on dark backgrounds ("rest" frames)
 *    is easily misread as background change and vice versa.
 *
 * Honest degradation: no shots / a single shot / a static clip return zero
 * boundaries plus a blind-spot explanation instead of throwing. A missing or
 * undecodable input throws a clear error. An aborted signal rejects promptly.
 *
 * @module lib/continuity
 */
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { probe, run, tailLines } from './ffmpeg.js'

/* ------------------------------------------------------------------ *
 * Public constants (the calibration, quotable by reports and tests)
 * ------------------------------------------------------------------ */

/** Decode rate: 2.5 fps means adjacent decoded frames are exactly 0.4 s apart. */
const DECODE_FPS = 2.5
/** A block "survived" when its best matching SAD (0-255 mean |ΔRGB|) is below this. */
const SURVIVOR_SAD = 22
/** Below this share of the frame nothing meaningful survived -> bare. */
const SURVIVOR_MIN_SHARE = 0.04
/** Carried if a surviving thing moved at least this share of the image diagonal. */
const CARRIED_MOVE_SHARE = 0.02
/** Carried if a surviving thing changed size by at least this share. */
const CARRIED_SCALE_SHARE = 0.1
/** Anchored if the largest surviving component covers at least this share. */
const ANCHORED_MIN_COMPONENT_SHARE = 0.03
/** Blocks flatter than this luma variance cannot localise a displacement. */
const TEXTURE_MIN_VARIANCE = 25
/** Displacement search radius in raster pixels. */
const SEARCH_RADIUS = 8
/**
 * "Something survived and moved": a coherent group of at least this many
 * textured survivor blocks whose displacement magnitudes agree within
 * MOTION_CLUSTER_TOLERANCE_PX. Three blocks are ~2.8% of the 12x9 grid, i.e.
 * a meaningful object rather than one noisy block.
 */
const MOTION_CLUSTER_MIN_BLOCKS = 3
const MOTION_CLUSTER_TOLERANCE_PX = 2
/** Carry-score thresholds: below the first reads as PPT, below the second warns. */
const PPT_SCORE = 0.5
const REMIND_SCORE = 0.7
/** A boundary inside a burst of >= 3 cuts within 1.5 s is exempt. */
const BURST_WINDOW_SECONDS = 1.5
const BURST_MIN_CUTS = 3
/** The last 1.2 s of a clip is exempt (tail titles / end cards). */
const TAIL_EXEMPT_SECONDS = 1.2

const RASTER_WIDTH = 320
const RASTER_HEIGHT = 180
const RASTER_DIAGONAL = Math.hypot(RASTER_WIDTH, RASTER_HEIGHT)
const GRID_COLUMNS = 12
const GRID_ROWS = 9
const GRID_CELLS = GRID_COLUMNS * GRID_ROWS
const FRAME_BYTES = RASTER_WIDTH * RASTER_HEIGHT * 3

/** Zone sampling for `zoneDwell` (kept small so the pass is cheap). */
const ZONE_WIDTH = 160
const ZONE_HEIGHT = 90
const ZONE_FPS = 4
const ZONE_MAX_FRAMES = 3600
const ZONE_COLUMNS = 12
/** Bands as fractions of the frame height: top / centre / bottom. */
const ZONE_BANDS = Object.freeze({
  top: Object.freeze({ from: 0, to: 0.22 }),
  centre: Object.freeze({ from: 0.28, to: 0.72 }),
  bottom: Object.freeze({ from: 0.78, to: 1 }),
})
/** A sub-block counts as "content" when its luma/edge statistics deviate. */
const ZONE_LUMA_DEVIATION = 18
const ZONE_EDGE_DEVIATION = 0.05
/** Fraction of sub-blocks that must be content for the band to be "occupied". */
const ZONE_OCCUPIED_SHARE = 0.08

export const CONTINUITY_THRESHOLDS = Object.freeze({
  decodeFps: DECODE_FPS,
  windowSeconds: 1 / DECODE_FPS,
  rasterWidth: RASTER_WIDTH,
  rasterHeight: RASTER_HEIGHT,
  gridColumns: GRID_COLUMNS,
  gridRows: GRID_ROWS,
  searchRadiusPx: SEARCH_RADIUS,
  survivorSad: SURVIVOR_SAD,
  survivorMinShare: SURVIVOR_MIN_SHARE,
  carriedMoveShare: CARRIED_MOVE_SHARE,
  carriedScaleShare: CARRIED_SCALE_SHARE,
  motionClusterMinBlocks: MOTION_CLUSTER_MIN_BLOCKS,
  motionClusterTolerancePx: MOTION_CLUSTER_TOLERANCE_PX,
  anchoredMinComponentShare: ANCHORED_MIN_COMPONENT_SHARE,
  textureMinVariance: TEXTURE_MIN_VARIANCE,
  pptScore: PPT_SCORE,
  remindScore: REMIND_SCORE,
  burstWindowSeconds: BURST_WINDOW_SECONDS,
  burstMinCuts: BURST_MIN_CUTS,
  tailExemptSeconds: TAIL_EXEMPT_SECONDS,
})

/** Blind spots that are always reported, regardless of the measurement. */
export const CONTINUITY_BLIND_SPOTS = Object.freeze([
  '320px 低分辨率解码会误读暗底细节：休息段/黑场上的微弱内容可能被判成背景改换，反之亦然。',
  '连续世界（长镜头、一镜到底）的边界本来就少；承接分高但边界数少于分镜数时，不能当作“每一刀都有承接”的证据。',
  '±8px 位移搜索（约 2.2% 画面对角线）只能测到不超过该幅度的运动：更快的平移/缩放会在块匹配中失败，可能被低估成 anchored 或 bare。',
])

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function abortError() {
  const error = new Error('continuity analysis aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError()
}

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function round(value, digits) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function randomToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`
}

/** Parse a duration from ffprobe JSON (format duration, else the video stream's). */
function durationOf(metadata) {
  const format = metadata?.format ?? {}
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
  for (const candidate of [format.duration, video?.duration]) {
    const value = Number.parseFloat(String(candidate ?? ''))
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

/** Validate the shared (tools, file, workDir) trio with clear errors. */
function validateInputs(label, tools, file, workDir) {
  if (tools === null || typeof tools !== 'object' || typeof tools.ffmpeg !== 'string' || tools.ffmpeg.length === 0) {
    throw new Error(`continuity.${label}: tools.ffmpeg is required (run resolveTools() from lib/ffmpeg.js first)`)
  }
  if (typeof file !== 'string' || file.trim().length === 0) {
    throw new Error(`continuity.${label}: file must be a non-empty path string`)
  }
  if (typeof workDir !== 'string' || workDir.trim().length === 0) {
    throw new Error(`continuity.${label}: workDir must be a non-empty path string`)
  }
}

/** Stat the input and throw a clear error when it cannot be read. */
async function assertReadableFile(label, file) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`continuity.${label}: cannot read input video "${file}": ${reason}`)
  }
  if (!info.isFile()) throw new Error(`continuity.${label}: input is not a regular file: "${file}"`)
}

/* ------------------------------------------------------------------ *
 * Boundary extraction + exemptions
 * ------------------------------------------------------------------ */

/**
 * Turn the caller's `shots` into boundary times in seconds.
 *
 * Accepts the `analyzeVideo` shot objects ({start, end, duration, ...}) or a
 * plain number list (shot starts *or* boundary times: any positive time is
 * treated as a boundary, so both conventions work). Shot 0 starts at 0 and is
 * not a boundary. Duplicates are removed and the result is sorted.
 *
 * @param {unknown} shots
 * @param {number} duration
 * @returns {{times: number[], shotCount: number}}
 */
function extractBoundaries(shots, duration) {
  const list = Array.isArray(shots) ? shots : []
  const shotCount = list.length
  const times = []
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    let time = null
    if (typeof entry === 'number' && Number.isFinite(entry)) time = entry
    else if (entry !== null && typeof entry === 'object') time = finiteNumber(entry.start ?? entry.t ?? entry.time)
    if (time === null) continue
    if (!(time > 0)) continue
    if (duration > 0 && time >= duration) continue
    times.push(round(time, 3))
  }
  times.sort((a, b) => a - b)
  const unique = []
  for (const time of times) {
    if (unique.length === 0 || time - unique[unique.length - 1] > 1e-9) unique.push(time)
  }
  return { times: unique, shotCount }
}

/**
 * Mark boundaries that are exempt from scoring:
 *  - inside a burst of >= BURST_MIN_CUTS cuts within BURST_WINDOW_SECONDS;
 *  - inside the last TAIL_EXEMPT_SECONDS of the clip.
 *
 * The burst rule is a sliding window: every boundary that belongs to a window
 * containing at least BURST_MIN_CUTS boundaries is exempt.
 *
 * @param {number[]} times ascending boundary times
 * @param {number} duration
 * @returns {boolean[]}
 */
function computeExemptions(times, duration) {
  const exempt = new Array(times.length).fill(false)
  if (times.length === 0) return exempt
  const tailStart = duration > 0 ? duration - TAIL_EXEMPT_SECONDS : Number.POSITIVE_INFINITY
  for (let index = 0; index < times.length; index += 1) {
    if (times[index] >= tailStart) exempt[index] = true
  }
  let end = 0
  for (let start = 0; start < times.length; start += 1) {
    while (end + 1 < times.length && times[end + 1] - times[start] <= BURST_WINDOW_SECONDS + 1e-9) end += 1
    const count = end - start + 1
    if (count >= BURST_MIN_CUTS) {
      for (let index = start; index <= end; index += 1) exempt[index] = true
    }
    if (end < start + 1) end = start + 1
  }
  return exempt
}

/* ------------------------------------------------------------------ *
 * Pixel helpers
 * ------------------------------------------------------------------ */

/** Precomputed block rectangle (raster pixels) for one 12x9 grid cell. */
function blockRect(col, row) {
  const x0 = Math.round((col * RASTER_WIDTH) / GRID_COLUMNS)
  const x1 = Math.round(((col + 1) * RASTER_WIDTH) / GRID_COLUMNS)
  const y0 = Math.round((row * RASTER_HEIGHT) / GRID_ROWS)
  const y1 = Math.round(((row + 1) * RASTER_HEIGHT) / GRID_ROWS)
  return { x0, x1, y0, y1 }
}

const BLOCK_RECTS = (() => {
  const rects = new Array(GRID_CELLS)
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLUMNS; col += 1) rects[row * GRID_COLUMNS + col] = blockRect(col, row)
  }
  return rects
})()

const BLOCK_AREA = RASTER_WIDTH * RASTER_HEIGHT / GRID_CELLS

/** Sample stride used inside blocks (2 = quarter of the pixels, plenty for SAD). */
const SAMPLE_STRIDE = 2
/** Inset avoids block borders (scale/interpolation bleeding). */
const BLOCK_INSET = 2

/**
 * Match one PRE block against the POST frame over ±SEARCH_RADIUS pixels.
 *
 * Returns the minimum mean |ΔRGB| (0-255), the offset that produced it, and
 * the PRE block's luma variance (flat blocks cannot localise a displacement).
 * Ties prefer the smaller offset so that flat/ambiguous content reports "did
 * not move" instead of an arbitrary first minimum.
 *
 * @returns {{sad: number, dx: number, dy: number, variance: number}}
 */
function matchBlock(preFrame, postFrame, rect) {
  const x0 = rect.x0 + BLOCK_INSET
  const x1 = rect.x1 - BLOCK_INSET
  const y0 = rect.y0 + BLOCK_INSET
  const y1 = rect.y1 - BLOCK_INSET
  const width = x1 - x0
  if (width <= 0 || y1 <= y0) return { sad: Number.POSITIVE_INFINITY, dx: 0, dy: 0, variance: 0 }

  // Luma variance of the pre block (texture check + flat-block detection).
  let lumaSum = 0
  let lumaSquareSum = 0
  let sampled = 0
  for (let y = y0; y < y1; y += SAMPLE_STRIDE) {
    for (let x = x0; x < x1; x += SAMPLE_STRIDE) {
      const offset = (y * RASTER_WIDTH + x) * 3
      const luma = preFrame[offset] * 0.299 + preFrame[offset + 1] * 0.587 + preFrame[offset + 2] * 0.114
      lumaSum += luma
      lumaSquareSum += luma * luma
      sampled += 1
    }
  }
  const lumaMean = sampled > 0 ? lumaSum / sampled : 0
  const variance = sampled > 0 ? lumaSquareSum / sampled - lumaMean * lumaMean : 0

  const dxMin = Math.max(-SEARCH_RADIUS, -x0)
  const dxMax = Math.min(SEARCH_RADIUS, RASTER_WIDTH - x1)
  const dyMin = Math.max(-SEARCH_RADIUS, -y0)
  const dyMax = Math.min(SEARCH_RADIUS, RASTER_HEIGHT - y1)
  let bestSad = Number.POSITIVE_INFINITY
  let bestDx = 0
  let bestDy = 0
  for (let dy = dyMin; dy <= dyMax; dy += 1) {
    for (let dx = dxMin; dx <= dxMax; dx += 1) {
      let sum = 0
      let count = 0
      let aborted = false
      for (let y = y0; y < y1 && !aborted; y += SAMPLE_STRIDE) {
        const preRow = (y * RASTER_WIDTH + x0) * 3
        const postRow = ((y + dy) * RASTER_WIDTH + x0 + dx) * 3
        for (let x = 0; x < width; x += SAMPLE_STRIDE) {
          const preOffset = preRow + x * 3
          const postOffset = postRow + x * 3
          sum +=
            Math.abs(preFrame[preOffset] - postFrame[postOffset]) +
            Math.abs(preFrame[preOffset + 1] - postFrame[postOffset + 1]) +
            Math.abs(preFrame[preOffset + 2] - postFrame[postOffset + 2])
          count += 3
        }
        // Early abort once the running mean already exceeds the best mean.
        if (bestSad !== Number.POSITIVE_INFINITY && sum / count > bestSad) aborted = true
      }
      if (aborted) continue
      const meanSad = sum / count
      const magnitude = Math.abs(dx) + Math.abs(dy)
      const bestMagnitude = Math.abs(bestDx) + Math.abs(bestDy)
      if (meanSad < bestSad - 1e-9 || (Math.abs(meanSad - bestSad) <= 1e-9 && magnitude < bestMagnitude)) {
        bestSad = meanSad
        bestDx = dx
        bestDy = dy
      }
    }
  }
  return { sad: bestSad, dx: bestDx, dy: bestDy, variance }
}

/** Count the largest 4-connected component of survivors on the 12x9 grid. */
function largestComponentSize(survivorGrid) {
  const seen = new Uint8Array(GRID_CELLS)
  let largest = 0
  for (let start = 0; start < GRID_CELLS; start += 1) {
    if (survivorGrid[start] === 0 || seen[start] === 1) continue
    const stack = [start]
    let size = 0
    while (stack.length > 0) {
      const cell = stack.pop()
      if (cell < 0 || cell >= GRID_CELLS || survivorGrid[cell] === 0 || seen[cell] === 1) continue
      seen[cell] = 1
      size += 1
      const row = Math.floor(cell / GRID_COLUMNS)
      const col = cell % GRID_COLUMNS
      if (row > 0) stack.push(cell - GRID_COLUMNS)
      if (row < GRID_ROWS - 1) stack.push(cell + GRID_COLUMNS)
      if (col > 0) stack.push(cell - 1)
      if (col < GRID_COLUMNS - 1) stack.push(cell + 1)
    }
    largest = Math.max(largest, size)
  }
  return largest
}

/**
 * Find a coherent group of sufficiently large survivor displacements.
 *
 * A "carried subject" is not always the dominant survivor: a large static
 * background may survive while the subject translates. Looking for a coherent
 * cluster (>= MOTION_CLUSTER_MIN_BLOCKS blocks agreeing within
 * MOTION_CLUSTER_TOLERANCE_PX, mean magnitude >= minMagnitude) catches that
 * subject without being fooled by a single noisy block.
 *
 * @param {number[]} magnitudes survivor displacement magnitudes in raster px
 * @param {number} minMagnitude smallest cluster mean that counts as "moved"
 * @returns {{count: number, mean: number} | null}
 */
function coherentMotionCluster(magnitudes, minMagnitude) {
  if (magnitudes.length < MOTION_CLUSTER_MIN_BLOCKS) return null
  let best = null
  for (const candidate of magnitudes) {
    if (candidate < minMagnitude) continue
    let count = 0
    let sum = 0
    for (const magnitude of magnitudes) {
      if (Math.abs(magnitude - candidate) <= MOTION_CLUSTER_TOLERANCE_PX) {
        count += 1
        sum += magnitude
      }
    }
    if (count < MOTION_CLUSTER_MIN_BLOCKS) continue
    if (best === null || count > best.count) best = { count, mean: sum / count }
  }
  return best
}

/**
 * Compare the PRE and POST frames around one boundary and classify the cut.
 *
 * @returns {{kind: 'carried'|'anchored'|'bare', survivorShare: number,
 *            displacement: number, scaleDelta: number,
 *            survivorShareRaw: number, largestComponentShare: number,
 *            texturedSurvivors: number, sadMedian: number}}
 */
function classifyBoundary(preFrame, postFrame) {
  const survivorGrid = new Uint8Array(GRID_CELLS)
  const sadValues = new Array(GRID_CELLS)
  const movesX = new Int16Array(GRID_CELLS)
  const movesY = new Int16Array(GRID_CELLS)
  const textured = new Uint8Array(GRID_CELLS)
  let survivors = 0
  let texturedSurvivors = 0
  const movingMagnitudes = []
  for (let cell = 0; cell < GRID_CELLS; cell += 1) {
    const match = matchBlock(preFrame, postFrame, BLOCK_RECTS[cell])
    sadValues[cell] = match.sad
    movesX[cell] = match.dx
    movesY[cell] = match.dy
    if (!(match.sad <= SURVIVOR_SAD)) continue
    survivorGrid[cell] = 1
    survivors += 1
    if (match.variance >= TEXTURE_MIN_VARIANCE) {
      textured[cell] = 1
      texturedSurvivors += 1
      movingMagnitudes.push(Math.hypot(match.dx, match.dy))
    }
  }
  sadValues.sort((a, b) => a - b)
  const sadMedian = sadValues[Math.floor(sadValues.length / 2)]

  // Survivor area share (block areas are equal by construction).
  const survivorShare = (survivors * BLOCK_AREA) / (RASTER_WIDTH * RASTER_HEIGHT)

  // Displacement: a coherent MOVING cluster (a subject crossing the boundary)
  // wins even when a large static background dominates the survivor set;
  // otherwise report the median survivor motion (usually ~0 when anchored).
  movingMagnitudes.sort((a, b) => a - b)
  const medianMovePx = movingMagnitudes.length === 0
    ? 0
    : movingMagnitudes[Math.floor(movingMagnitudes.length / 2)]
  const minMovingPx = CARRIED_MOVE_SHARE * RASTER_DIAGONAL
  const movingCluster = coherentMotionCluster(movingMagnitudes, minMovingPx)
  const displacementPx = movingCluster !== null ? movingCluster.mean : medianMovePx
  const displacement = displacementPx / RASTER_DIAGONAL

  // Scale: compare the survivor bounding box before and after the displacement.
  let preX0 = Number.POSITIVE_INFINITY
  let preX1 = Number.NEGATIVE_INFINITY
  let preY0 = Number.POSITIVE_INFINITY
  let preY1 = Number.NEGATIVE_INFINITY
  let postX0 = Number.POSITIVE_INFINITY
  let postX1 = Number.NEGATIVE_INFINITY
  let postY0 = Number.POSITIVE_INFINITY
  let postY1 = Number.NEGATIVE_INFINITY
  for (let cell = 0; cell < GRID_CELLS; cell += 1) {
    if (survivorGrid[cell] === 0) continue
    const rect = BLOCK_RECTS[cell]
    if (rect.x0 < preX0) preX0 = rect.x0
    if (rect.x1 > preX1) preX1 = rect.x1
    if (rect.y0 < preY0) preY0 = rect.y0
    if (rect.y1 > preY1) preY1 = rect.y1
    const postX = rect.x0 + movesX[cell]
    const postY = rect.y0 + movesY[cell]
    if (postX < postX0) postX0 = postX
    if (postX + (rect.x1 - rect.x0) > postX1) postX1 = postX + (rect.x1 - rect.x0)
    if (postY < postY0) postY0 = postY
    if (postY + (rect.y1 - rect.y0) > postY1) postY1 = postY + (rect.y1 - rect.y0)
  }
  let scaleDelta = 0
  if (Number.isFinite(preX0) && preX1 > preX0 && preY1 > preY0) {
    const preArea = (preX1 - preX0) * (preY1 - preY0)
    const postArea = (postX1 - postX0) * (postY1 - postY0)
    if (preArea > 0 && postArea > 0) scaleDelta = Math.sqrt(postArea / preArea) - 1
  }

  const largestComponent = largestComponentSize(survivorGrid)
  const largestComponentShare = (largestComponent * BLOCK_AREA) / (RASTER_WIDTH * RASTER_HEIGHT)

  let kind = 'bare'
  if (survivorShare >= SURVIVOR_MIN_SHARE) {
    if (displacement >= CARRIED_MOVE_SHARE || Math.abs(scaleDelta) >= CARRIED_SCALE_SHARE) kind = 'carried'
    else if (largestComponentShare >= ANCHORED_MIN_COMPONENT_SHARE) kind = 'anchored'
  }

  return {
    kind,
    survivorShare: round(survivorShare, 3),
    displacement: round(displacement, 4),
    scaleDelta: round(scaleDelta, 4),
    survivorShareRaw: survivorShare,
    largestComponentShare,
    texturedSurvivors,
    sadMedian,
  }
}

/* ------------------------------------------------------------------ *
 * Frame-pair decoding (ONE ffmpeg pass over only the needed 0.4 s windows)
 * ------------------------------------------------------------------ */

/**
 * Compute the (pre, post) raster times around every boundary.
 *
 * Decoded frames sit on the 1/DECODE_FPS grid (0, 0.4, 0.8, ...). For a
 * boundary between two ticks we take the tick before and after it: the pair is
 * exactly 0.4 s apart and always straddles the cut. When the boundary lands
 * exactly on a tick the frame at that tick is already the new shot, so the
 * pair becomes (tick-1, tick).
 *
 * @param {number[]} times ascending boundary times
 * @param {number} duration
 * @returns {Array<{pre: number, post: number} | null>}
 */
function planFramePairs(times, duration) {
  const step = 1 / DECODE_FPS
  const lastTick = duration > 0 ? Math.floor(duration * DECODE_FPS - 1e-9) / DECODE_FPS : Number.POSITIVE_INFINITY
  return times.map((time) => {
    let tick = Math.floor(time * DECODE_FPS + 1e-9)
    // Boundary exactly on a grid tick: that frame belongs to the new shot.
    if (Math.abs(time - tick / DECODE_FPS) <= 1e-9) tick -= 1
    let pre = tick / DECODE_FPS
    let post = (tick + 1) / DECODE_FPS
    if (pre < 0) {
      pre = 0
      post = step
    }
    if (post > lastTick + 1e-9) {
      // Near the tail: slide the pair back so both ticks exist.
      post = lastTick
      pre = lastTick - step
    }
    if (pre < 0 || post <= pre) return null
    return { pre: round(pre, 6), post: round(post, 6) }
  })
}

/**
 * Decode exactly the raster frames needed by the planned pairs in ONE pass.
 *
 * @returns {Promise<{buffer: Buffer, times: number[], expectedCount: number, decodedCount: number, stderr: string}>}
 */
async function decodePairFrames({ tools, file, workDir, pairs, signal }) {
  const windows = []
  for (const pair of pairs) {
    if (pair === null) continue
    const last = windows[windows.length - 1]
    const lo = pair.pre - 0.001
    const hi = pair.post + 0.001
    if (last !== undefined && lo <= last.hi) last.hi = Math.max(last.hi, hi)
    else windows.push({ lo, hi })
  }
  if (windows.length === 0) {
    return { buffer: Buffer.alloc(0), times: [], expectedCount: 0, decodedCount: 0, stderr: '' }
  }

  const expression = windows
    .map((window) => `between(t,${window.lo.toFixed(3)},${window.hi.toFixed(3)})`)
    .join('+')
  const rawName = `continuity-${randomToken()}.rgb`
  const result = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-nostdin', '-y',
      '-i', file,
      '-an', '-sn',
      '-vf', `fps=${DECODE_FPS},select='${expression}',scale=${RASTER_WIDTH}:${RASTER_HEIGHT},format=rgb24`,
      '-fps_mode', 'passthrough',
      '-f', 'rawvideo', rawName,
    ],
    { cwd: workDir, timeoutMs: 10 * 60 * 1000, signal },
  )
  if (signal?.aborted === true) throw abortError()

  const rawPath = join(workDir, rawName)
  let buffer
  try {
    buffer = await readFile(rawPath)
  } catch {
    buffer = Buffer.alloc(0)
  }
  await rm(rawPath, { force: true }).catch(() => {})

  const decodedCount = Math.floor(buffer.length / FRAME_BYTES)
  if (decodedCount === 0) {
    if (result.code !== 0) {
      throw new Error(`continuity: ffmpeg could not decode any frame from "${file}":\n${tailLines(result.stderr, 8)}`)
    }
    return { buffer: Buffer.alloc(0), times: [], expectedCount: 0, decodedCount: 0, stderr: result.stderr ?? '' }
  }

  // Reconstruct the decoded frame times from the 2.5 fps grid + selected windows.
  const expectedTimes = []
  for (const window of windows) {
    const firstTick = Math.ceil(window.lo * DECODE_FPS - 1e-6)
    const lastTickInWindow = Math.floor(window.hi * DECODE_FPS + 1e-6)
    for (let tick = firstTick; tick <= lastTickInWindow; tick += 1) {
      const time = tick / DECODE_FPS
      if (expectedTimes.length === 0 || time > expectedTimes[expectedTimes.length - 1] + 1e-9) expectedTimes.push(time)
    }
  }
  // A decode that ends early (e.g. window past EOF) yields fewer frames: keep
  // the leading times, which is where the truncation happens.
  const times = expectedTimes.slice(0, decodedCount)
  return {
    buffer,
    times,
    expectedCount: expectedTimes.length,
    decodedCount,
    stderr: result.stderr ?? '',
    exitCode: result.code,
  }
}

/** Find the frame index whose reconstructed time matches `time` (± half tick). */
function frameIndexAt(times, time) {
  const tolerance = 0.5 / DECODE_FPS + 1e-6
  for (let index = 0; index < times.length; index += 1) {
    if (Math.abs(times[index] - time) <= tolerance) return index
  }
  return -1
}

/* ------------------------------------------------------------------ *
 * analyzeContinuity
 * ------------------------------------------------------------------ */

/**
 * Quantify whether the cuts of a video carry anything over, or paste scenes.
 *
 * @param {object} options
 * @param {{ffmpeg: string, ffprobe?: string}} options.tools
 * @param {string} options.file absolute path to a video file
 * @param {string} options.workDir scratch directory (used as cwd); caller owns it
 * @param {Array<{start: number}> | number[]} [options.shots] analyzeVideo shots (or boundary times)
 * @param {number} [options.duration] clip duration in seconds (probed when omitted)
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{boundaries: Array<{t: number, kind: 'carried'|'anchored'|'bare',
 *            survivorShare: number, displacement: number, scaleDelta: number, exempt: boolean}>,
 *            score: number|null, considered: number, carried: number, anchored: number, bare: number,
 *            blindSpots: string[]}>}
 *   `survivorShare` is the share of the raster that survived (0..1);
 *   `displacement` is in fractions of the image diagonal (0.02 = the carried
 *   movement threshold); `scaleDelta` is the relative change of the survivor
 *   bounding box (+0.1 = grew 10%). `score` is
 *   `(carried + anchored / 2) / considered`, null when nothing was scored.
 */
export async function analyzeContinuity({ tools, file, workDir, shots, duration, signal } = {}) {
  validateInputs('analyzeContinuity', tools, file, workDir)
  throwIfAborted(signal)
  await assertReadableFile('analyzeContinuity', file)
  throwIfAborted(signal)

  const blindSpots = [...CONTINUITY_BLIND_SPOTS]
  let totalDuration = finiteNumber(duration) ?? 0
  if (!(totalDuration > 0)) {
    let metadata
    try {
      metadata = await probe(tools, file, { signal })
    } catch (error) {
      if (signal?.aborted === true) throw abortError()
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`continuity.analyzeContinuity: cannot read media metadata for "${file}": ${reason}`)
    }
    throwIfAborted(signal)
    const streams = Array.isArray(metadata?.streams) ? metadata.streams : []
    const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
    if (video === undefined) throw new Error(`continuity.analyzeContinuity: "${file}" has no video stream to analyse`)
    totalDuration = durationOf(metadata)
  }

  const { times, shotCount } = extractBoundaries(shots, totalDuration)
  const exempt = computeExemptions(times, totalDuration)

  // A continuous world may have fewer boundaries than storyboard shots: that
  // is not evidence of carried cuts, so it is always reported as a blind spot.
  if (times.length === 0) {
    blindSpots.push('没有检测到任何边界（单镜头、全静止或未提供分镜数据），无法判断镜头之间的承接。')
    return { boundaries: [], score: null, considered: 0, carried: 0, anchored: 0, bare: 0, blindSpots }
  }
  if (shotCount > 0 && times.length < Math.max(1, shotCount - 1)) {
    blindSpots.push(
      `边界数 ${times.length} 少于分镜数 ${shotCount}（少 1）；连续长镜头世界本来就边界少，` +
        '高承接分不能当作“每一刀都有承接”的证据。',
    )
  }
  const exemptCount = exempt.filter(Boolean).length
  if (exemptCount > 0) {
    blindSpots.push(`${exemptCount} 个边界未计分（硬切爆发或片尾 ${TAIL_EXEMPT_SECONDS}s 豁免）。`)
  }

  // ----- ONE decode pass for all boundary windows -----
  const pairs = planFramePairs(times, totalDuration)
  const plannedPairs = pairs.filter((pair) => pair !== null)
  if (plannedPairs.length === 0) {
    blindSpots.push('边界都贴边，没有成对的帧可比较，未能判定。')
    return {
      boundaries: times.map((time, index) => ({
        t: round(time, 2),
        kind: 'bare',
        survivorShare: 0,
        displacement: 0,
        scaleDelta: 0,
        exempt: exempt[index],
      })),
      score: null,
      considered: 0,
      carried: 0,
      anchored: 0,
      bare: 0,
      blindSpots,
    }
  }
  const decoded = await decodePairFrames({ tools, file, workDir, pairs, signal })
  if (decoded.decodedCount < decoded.expectedCount) {
    blindSpots.push(
      `解码帧数 ${decoded.decodedCount} 少于预期 ${decoded.expectedCount}（窗口超出片尾或解码提前结束），` +
        '缺失窗口的边界按 bare 记录。',
    )
  } else if (decoded.exitCode !== 0 && decoded.decodedCount > 0) {
    blindSpots.push(`解码提前结束（${firstLine(decoded.stderr) || `exit ${decoded.exitCode}`}），部分边界可能未判定。`)
  }
  const frameAt = (time) => {
    const index = frameIndexAt(decoded.times, time)
    if (index < 0) return null
    return decoded.buffer.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES)
  }

  // ----- Classify every boundary -----
  const boundaries = []
  let unpaired = 0
  let noTexture = 0
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index]
    const pair = pairs[index]
    let result = {
      t: round(time, 2),
      kind: 'bare',
      survivorShare: 0,
      displacement: 0,
      scaleDelta: 0,
      exempt: exempt[index],
    }
    const preFrame = pair === null ? null : frameAt(pair.pre)
    const postFrame = pair === null ? null : frameAt(pair.post)
    if (preFrame !== null && postFrame !== null) {
      const classified = classifyBoundary(preFrame, postFrame)
      result = {
        t: round(time, 2),
        kind: classified.kind,
        survivorShare: classified.survivorShare,
        displacement: classified.displacement,
        scaleDelta: classified.scaleDelta,
        exempt: exempt[index],
      }
      if (classified.kind !== 'bare' && classified.texturedSurvivors === 0) noTexture += 1
    } else {
      unpaired += 1
    }
    boundaries.push(result)
  }
  if (unpaired > 0) {
    blindSpots.push(`${unpaired} 个边界附近没有成对的帧（片长过短或边界贴边），这些边界按 bare 记录、未计入评分。`)
  }
  if (noTexture > 0) {
    blindSpots.push(`${noTexture} 个边界的存活区域缺少纹理，位移估计不可靠（可能低估 carried）。`)
  }

  // ----- Score over the non-exempt boundaries -----
  let considered = 0
  let carried = 0
  let anchored = 0
  let bare = 0
  for (let index = 0; index < boundaries.length; index += 1) {
    if (boundaries[index].exempt) continue
    // An unpaired boundary has no honest kind: exclude it from scoring.
    if (pairs[index] === null) continue
    considered += 1
    if (boundaries[index].kind === 'carried') carried += 1
    else if (boundaries[index].kind === 'anchored') anchored += 1
    else bare += 1
  }
  if (considered === 0) {
    blindSpots.push('没有可计分的边界（全部边界被豁免或没有成对帧），无法判断镜头承接。')
  }
  const score = considered > 0 ? round((carried + anchored / 2) / considered, 3) : null

  return { boundaries, score, considered, carried, anchored, bare, blindSpots }
}

/* ------------------------------------------------------------------ *
 * zoneDwell — how long the top / centre / bottom zones stay occupied
 * ------------------------------------------------------------------ */

/** Band row range for one of top/centre/bottom. */
function bandRows(band) {
  const from = Math.round(band.from * ZONE_HEIGHT)
  const to = Math.round(band.to * ZONE_HEIGHT)
  return { from, to: Math.max(from + 1, to) }
}

/**
 * Compute per-band occupancy statistics for one decoded frame.
 *
 * The band is split into ZONE_COLUMNS sub-blocks. A sub-block is "content"
 * when its mean luma deviates from the band's median luma OR its edge density
 * deviates from the band's median edge density (a title/subtitle/logo changes
 * local contrast even when the background is busy). The band is "occupied"
 * when enough sub-blocks are content.
 *
 * @returns {{top: boolean, centre: boolean, bottom: boolean}}
 */
function frameZoneOccupancy(frame) {
  const luma = new Float32Array(ZONE_WIDTH * ZONE_HEIGHT)
  for (let y = 0; y < ZONE_HEIGHT; y += 1) {
    for (let x = 0; x < ZONE_WIDTH; x += 1) {
      const offset = (y * ZONE_WIDTH + x) * 3
      luma[y * ZONE_WIDTH + x] = frame[offset] * 0.299 + frame[offset + 1] * 0.587 + frame[offset + 2] * 0.114
    }
  }
  const occupancy = { top: false, centre: false, bottom: false }
  for (const [name, band] of Object.entries(ZONE_BANDS)) {
    const { from, to } = bandRows(band)
    const blockWidth = Math.max(1, Math.floor(ZONE_WIDTH / ZONE_COLUMNS))
    const meanLumas = new Array(ZONE_COLUMNS)
    const edgeDensities = new Array(ZONE_COLUMNS)
    for (let col = 0; col < ZONE_COLUMNS; col += 1) {
      const x0 = col * blockWidth
      const x1 = col === ZONE_COLUMNS - 1 ? ZONE_WIDTH : x0 + blockWidth
      let sum = 0
      let count = 0
      let edgeSum = 0
      let edgeCount = 0
      for (let y = from; y < to; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const value = luma[y * ZONE_WIDTH + x]
          sum += value
          count += 1
          if (x + 1 < x1) {
            edgeSum += Math.abs(luma[y * ZONE_WIDTH + x + 1] - value)
            edgeCount += 1
          }
          if (y + 1 < to) {
            edgeSum += Math.abs(luma[(y + 1) * ZONE_WIDTH + x] - value)
            edgeCount += 1
          }
        }
      }
      meanLumas[col] = count > 0 ? sum / count : 0
      edgeDensities[col] = edgeCount > 0 ? edgeSum / edgeCount / 255 : 0
    }
    const sortedLumas = [...meanLumas].sort((a, b) => a - b)
    const sortedEdges = [...edgeDensities].sort((a, b) => a - b)
    const medianLuma = sortedLumas[Math.floor(sortedLumas.length / 2)]
    const medianEdge = sortedEdges[Math.floor(sortedEdges.length / 2)]
    let content = 0
    for (let col = 0; col < ZONE_COLUMNS; col += 1) {
      const lumaDeviation = Math.abs(meanLumas[col] - medianLuma)
      const edgeDeviation = edgeDensities[col] - medianEdge
      if (lumaDeviation > ZONE_LUMA_DEVIATION || edgeDeviation > ZONE_EDGE_DEVIATION) content += 1
    }
    occupancy[name] = content / ZONE_COLUMNS >= ZONE_OCCUPIED_SHARE
  }
  return occupancy
}

/**
 * Measure how many seconds per band are occupied by non-background content.
 *
 * Useful for "how long is the title on screen?": the top band lights up while
 * a title/lower-third is present, the bottom band for subtitles, the centre
 * band for a centred card. Softer/thinner content may be under-detected at
 * 160x90 (see the module-level blind spots).
 *
 * ONE decode pass at 4 fps / 160x90 rgb24 (relative output name, cwd=workDir).
 *
 * @param {object} options
 * @param {{ffmpeg: string, ffprobe?: string}} options.tools
 * @param {string} options.file
 * @param {string} options.workDir
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{top: {seconds: number, ratio: number},
 *            bottom: {seconds: number, ratio: number},
 *            centre: {seconds: number, ratio: number},
 *            occupiedSeconds: number}>}
 */
export async function zoneDwell({ tools, file, workDir, signal } = {}) {
  validateInputs('zoneDwell', tools, file, workDir)
  throwIfAborted(signal)
  await assertReadableFile('zoneDwell', file)
  throwIfAborted(signal)

  let totalDuration = 0
  try {
    const metadata = await probe(tools, file, { signal })
    const streams = Array.isArray(metadata?.streams) ? metadata.streams : []
    const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
    if (video === undefined) throw new Error(`continuity.zoneDwell: "${file}" has no video stream to analyse`)
    totalDuration = durationOf(metadata)
  } catch (error) {
    if (signal?.aborted === true) throw abortError()
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`continuity.zoneDwell: cannot read media metadata for "${file}": ${reason}`)
  }
  throwIfAborted(signal)

  const fps = totalDuration > 0
    ? Math.max(1, Math.min(ZONE_FPS, ZONE_MAX_FRAMES / totalDuration))
    : ZONE_FPS
  const rawName = `zones-${randomToken()}.rgb`
  const result = await run(
    tools.ffmpeg,
    [
      '-v', 'error', '-nostdin', '-y',
      '-i', file,
      '-an', '-sn',
      '-vf', `fps=${round(fps, 3)},scale=${ZONE_WIDTH}:${ZONE_HEIGHT},format=rgb24`,
      '-f', 'rawvideo', rawName,
    ],
    { cwd: workDir, timeoutMs: 10 * 60 * 1000, signal },
  )
  if (signal?.aborted === true) throw abortError()

  const rawPath = join(workDir, rawName)
  let buffer
  try {
    buffer = await readFile(rawPath)
  } catch {
    buffer = Buffer.alloc(0)
  }
  await rm(rawPath, { force: true }).catch(() => {})

  const frameBytes = ZONE_WIDTH * ZONE_HEIGHT * 3
  const count = Math.floor(buffer.length / frameBytes)
  if (count === 0) {
    if (result.code !== 0) {
      throw new Error(`continuity.zoneDwell: ffmpeg could not decode any frame from "${file}":\n${tailLines(result.stderr, 8)}`)
    }
    throw new Error(`continuity.zoneDwell: "${file}" produced no decodable video frames`)
  }
  if (result.code !== 0) {
    // Partial decode is still useful: use the decoded prefix.
  }

  const occupiedCounts = { top: 0, centre: 0, bottom: 0 }
  let anyOccupied = 0
  for (let index = 0; index < count; index += 1) {
    const frame = buffer.subarray(index * frameBytes, (index + 1) * frameBytes)
    const occupancy = frameZoneOccupancy(frame)
    if (occupancy.top) occupiedCounts.top += 1
    if (occupancy.centre) occupiedCounts.centre += 1
    if (occupancy.bottom) occupiedCounts.bottom += 1
    if (occupancy.top || occupancy.centre || occupancy.bottom) anyOccupied += 1
  }
  const analysedSeconds = count / fps
  const secondsOf = (frames) => (analysedSeconds > 0 ? round(frames / fps, 2) : 0)
  const ratioOf = (frames) => (count > 0 ? round(frames / count, 3) : 0)
  return {
    top: { seconds: secondsOf(occupiedCounts.top), ratio: ratioOf(occupiedCounts.top) },
    bottom: { seconds: secondsOf(occupiedCounts.bottom), ratio: ratioOf(occupiedCounts.bottom) },
    centre: { seconds: secondsOf(occupiedCounts.centre), ratio: ratioOf(occupiedCounts.centre) },
    occupiedSeconds: secondsOf(anyOccupied),
  }
}

/* ------------------------------------------------------------------ *
 * Interpretation helpers (used by the report renderer)
 * ------------------------------------------------------------------ */

/**
 * Turn a carry score into a label: 'ok' | 'warning' | 'ppt' | 'unknown'.
 *
 * @param {number|null} score
 * @returns {'ok'|'warning'|'ppt'|'unknown'}
 */
export function continuityVerdict(score) {
  const value = finiteNumber(score)
  if (value === null) return 'unknown'
  if (value < PPT_SCORE) return 'ppt'
  if (value < REMIND_SCORE) return 'warning'
  return 'ok'
}

export default {
  analyzeContinuity,
  zoneDwell,
  continuityVerdict,
  CONTINUITY_THRESHOLDS,
  CONTINUITY_BLIND_SPOTS,
}
