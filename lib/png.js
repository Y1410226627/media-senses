/**
 * Minimal dependency-free PNG writer used to render analysis charts
 * (waveform envelope, energy curve, chroma heat map, section map).
 *
 * Only 8-bit RGBA truecolour output is needed, so this is a tiny zlib-backed
 * encoder rather than a general imaging library.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'latin1')
  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crcBuffer])
}

/** A mutable RGBA canvas with a few drawing primitives. */
export class Canvas {
  constructor(width, height, background = [12, 14, 20, 255]) {
    this.width = Math.max(1, Math.round(width))
    this.height = Math.max(1, Math.round(height))
    this.data = Buffer.alloc(this.width * this.height * 4)
    this.fill(background)
  }

  fill([r, g, b, a = 255]) {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r
      this.data[i + 1] = g
      this.data[i + 2] = b
      this.data[i + 3] = a
    }
  }

  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const offset = (y * this.width + x) * 4
    const alpha = a / 255
    if (alpha >= 1) {
      this.data[offset] = r
      this.data[offset + 1] = g
      this.data[offset + 2] = b
      this.data[offset + 3] = 255
      return
    }
    this.data[offset] = Math.round(this.data[offset] * (1 - alpha) + r * alpha)
    this.data[offset + 1] = Math.round(this.data[offset + 1] * (1 - alpha) + g * alpha)
    this.data[offset + 2] = Math.round(this.data[offset + 2] * (1 - alpha) + b * alpha)
    this.data[offset + 3] = 255
  }

  rect(x, y, width, height, color) {
    for (let dy = 0; dy < height; dy += 1) for (let dx = 0; dx < width; dx += 1) this.set(x + dx, y + dy, color)
  }

  /** Draw a 1px (optionally thicker) line with Bresenham. */
  line(x0, y0, x1, y1, color, thickness = 1) {
    let x = Math.round(x0)
    let y = Math.round(y0)
    const tx = Math.round(x1)
    const ty = Math.round(y1)
    const dx = Math.abs(tx - x)
    const dy = Math.abs(ty - y)
    const sx = x < tx ? 1 : -1
    const sy = y < ty ? 1 : -1
    let err = dx - dy
    for (;;) {
      if (thickness <= 1) this.set(x, y, color)
      else this.rect(x - Math.floor(thickness / 2), y - Math.floor(thickness / 2), thickness, thickness, color)
      if (x === tx && y === ty) break
      const e2 = 2 * err
      if (e2 > -dy) {
        err -= dy
        x += sx
      }
      if (e2 < dx) {
        err += dx
        y += sy
      }
    }
  }

  /** Encode the canvas as PNG bytes. */
  toPng() {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(this.width, 0)
    header.writeUInt32BE(this.height, 4)
    header[8] = 8 // bit depth
    header[9] = 6 // colour type: RGBA
    header[10] = 0 // compression
    header[11] = 0 // filter
    header[12] = 0 // interlace
    const stride = this.width * 4
    const raw = Buffer.alloc((stride + 1) * this.height)
    for (let y = 0; y < this.height; y += 1) {
      raw[y * (stride + 1)] = 0 // filter type: none
      this.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  }

  async save(path) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, this.toPng())
    return path
  }
}

/** Perceptually reasonable viridis-like colour ramp for heat maps. */
export function heatColor(value) {
  const t = Math.min(1, Math.max(0, value))
  const stops = [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ]
  const pos = t * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(pos))
  const local = pos - index
  const a = stops[index]
  const b = stops[index + 1]
  return [
    Math.round(a[0] + (b[0] - a[0]) * local),
    Math.round(a[1] + (b[1] - a[1]) * local),
    Math.round(a[2] + (b[2] - a[2]) * local),
    255,
  ]
}

/** Blue -> cyan -> yellow -> red ramp for intensity plots. */
export function intensityColor(value) {
  const t = Math.min(1, Math.max(0, value))
  if (t < 0.5) {
    const k = t / 0.5
    return [Math.round(30 + 20 * k), Math.round(90 + 120 * k), Math.round(220 - 20 * k), 255]
  }
  const k = (t - 0.5) / 0.5
  return [Math.round(50 + 205 * k), Math.round(210 - 120 * k), Math.round(200 - 190 * k), 255]
}

/**
 * Write a line chart PNG.
 *
 * @param {string} path
 * @param {{width?: number, height?: number, series: Array<{values: number[], color: [number, number, number], min?: number, max?: number}>, background?: [number, number, number]}} options
 */
export async function writeLineChart(path, options) {
  const width = options.width ?? 960
  const height = options.height ?? 200
  const bg = options.background ?? [16, 18, 26]
  const canvas = new Canvas(width, height, [...bg, 255])
  const pad = 6
  // Faint horizontal grid at 25/50/75%.
  for (const fraction of [0.25, 0.5, 0.75]) {
    const y = Math.round(pad + (height - 2 * pad) * fraction)
    for (let x = pad; x < width - pad; x += 1) canvas.set(x, y, [...bg.map((c) => Math.min(255, c + 18)), 255])
  }
  for (const series of options.series) {
    const values = series.values.filter((v) => Number.isFinite(v))
    if (values.length === 0) continue
    const min = series.min ?? Math.min(...values)
    const max = series.max ?? Math.max(...values)
    const span = max - min || 1
    const points = []
    const step = values.length > 1 ? (width - 2 * pad) / (values.length - 1) : 0
    for (let i = 0; i < values.length; i += 1) {
      const x = pad + i * step
      const y = height - pad - ((values[i] - min) / span) * (height - 2 * pad)
      points.push([x, y])
    }
    for (let i = 1; i < points.length; i += 1) {
      canvas.line(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], [...series.color, 255], 1)
    }
  }
  await canvas.save(path)
  return path
}

/**
 * Write a chroma/heat-map PNG from a matrix of normalized values.
 *
 * @param {string} path
 * @param {{matrix: number[][], width?: number, height?: number, rows?: number}} options
 */
export async function writeHeatmap(path, options) {
  const rows = options.rows ?? 12
  const width = options.width ?? 960
  const height = options.height ?? 180
  const canvas = new Canvas(width, height)
  const columns = Math.max(1, Math.floor(width / 8))
  const matrix = options.matrix
  for (let x = 0; x < width; x += 1) {
    const column = Math.min(columns - 1, Math.floor((x / width) * columns))
    const frameValues = matrix[column] ?? []
    for (let y = 0; y < height; y += 1) {
      const row = Math.min(rows - 1, Math.floor((y / height) * rows))
      const value = Number.isFinite(frameValues[row]) ? frameValues[row] : 0
      canvas.set(x, y, heatColor(value))
    }
  }
  await canvas.save(path)
  return path
}

export default { Canvas, writeLineChart, writeHeatmap, heatColor, intensityColor }
