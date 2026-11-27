/**
 * 像素级比对（pixel-level QA）——为什么需要：`media_compare` 原来只比整片统计
 * （时长 / 镜头数 / BPM / 亮度 / 彩度），回答不了「这一帧哪里不一样、差多少、
 * 算 match 还是 diverge」。本模块把参考帧与仿制帧逐像素比较：MAE / RMSE /
 * PSNR、窗口化 SSIM、CIEDE2000 色差，并把画面切成网格逐块判定，用中文方位词
 * 点名最差的几块。
 *
 * Why this module: whole-film statistics cannot localise a visual regression. A
 * replica can match a reference's duration, cut rhythm and BPM while the hero
 * title is 8 px off, the background hue is wrong, or a whole quadrant is a
 * different image. Pixel QA answers exactly that, so the next revision has a
 * concrete target ("左下角 ΔE00 14.2 / PSNR 15.8 dB / diverge").
 *
 * Method (public standards, implemented from the definitions):
 *  - MAE / RMSE over the 8-bit RGB channels (0..255 scale, alpha ignored);
 *  - PSNR = 10·log10(255² / MSE); identical pixels therefore give Infinity (the
 *    renderer should print it as "∞ / 完全一致", JSON.stringify would turn it
 *    into null);
 *  - SSIM (Wang et al. 2004) on luminance, 8×8 uniform windows, C1=(0.01·L)²,
 *    C2=(0.03·L)², L=255; window stride is scaled down on big frames so the cost
 *    stays bounded; sub-8-pixel images fall back to one global window;
 *  - ΔE00 = full CIEDE2000 (kL=kC=kH=1) through sRGB → linear RGB → XYZ(D65) →
 *    CIE L*a*b* (D65 white point). This is the real CIEDE2000, not CIE76.
 *
 * Cross-resolution: the two frames are first resampled to one common size (the
 * image with fewer pixels wins, so a 1920×1080 reference is averaged down to the
 * 1280×720 produced frame instead of upscaling the produced frame). Downscaling
 * uses box/area averaging, upscaling uses nearest neighbour. Aspect-ratio
 * mismatch is stretched to the common size — extract both frames with the same
 * aspect when comparing.
 *
 * PNG decode note: `lib/png.js` is an encoder only (no decoder), so
 * `decodePngPixels` implements the PNG read side here with `node:zlib`
 * (inflateSync + all five PNG row filters, 8-bit colour types 0/2/3/4/6,
 * non-interlaced). `lib/png.js` is still reused by the test suite to produce the
 * PNG fixtures; it is not modified. 16-bit and interlaced PNGs are rejected with
 * a readable error because ffmpeg/Canvas output is 8-bit non-interlaced.
 *
 * Thresholds / 三档判定的取值依据（PIXEL_QA_THRESHOLDS）:
 *  - PSNR ≥ 28 dB: MSE ≤ ~1.0 grey-level² → 0.4% of the 255² range. This is the
 *    "visually transparent" floor for flat motion-graphics frames at the same
 *    resolution; AA / 1-px resample differences usually stay above it, an 8 px
 *    misregistration or a re-layout drops far below it.
 *  - PSNR ≥ 22 dB: MSE ≤ ~6.4 → a clearly visible difference, but the same
 *    layout/composition; below that the frame is structurally different.
 *  - SSIM ≥ 0.92 (match) / ≥ 0.80 (close): Wang et al.'s quality bands; 0.92 is
 *    "near-identical structure", 0.80 is "recognisably the same composition".
 *  - ΔE00 ≤ 3 (match) / ≤ 8 (close): CIEDE2000 JND is ≈2.3 for large patches, so
 *    ≤3 tolerates encode/gamma/AA differences, >8 is an obvious colour shift.
 *  - Match requires ALL three metrics in the match tier; close requires ALL three
 *    in the close tier; anything else is diverge. Per-region verdicts use
 *    PSNR + ΔE00 only (SSIM on a few small blocks is not statistically useful).
 *
 * Attribution: no upstream code or data is reused. dsh-drawai's
 * src/motion/pixelqa.js was reviewed; it checks banding / antialiasing / font
 * registration and is a different problem, so nothing was copied. The metric
 * formulas are public standards; the thresholds come from CONTRACT-V4 §2.5.
 */
import { inflateSync } from 'node:zlib'

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 } // colour type -> returned channels (palette expanded)
const PNG_BYTES_PER_PIXEL = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const L = 255
const MAX_CHANNEL = L * L // 65025
const DEFAULT_COLS = 3
const DEFAULT_ROWS = 3
const DEFAULT_MAX_WORST = 3
const SSIM_WINDOW = 8
const SSIM_C1 = (0.01 * L) ** 2 // 6.5025
const SSIM_C2 = (0.03 * L) ** 2 // 58.5225

/**
 * 三档判定阈值（可被 comparePixels 的 opts.thresholds 局部覆盖）。
 * match / close 各自是一条"三项都过"的线；两条都不过就是 diverge。
 */
export const PIXEL_QA_THRESHOLDS = Object.freeze({
  match: Object.freeze({ psnr: 28, ssim: 0.92, deltaE00: 3 }),
  close: Object.freeze({ psnr: 22, ssim: 0.8, deltaE00: 8 }),
})

/** 方位词表：行列各三分，合成 9 个中文方位。 */
const POSITION_WORDS = Object.freeze({
  '上左': '左上角',
  '上中': '上边中间',
  '上右': '右上角',
  '中左': '左侧中间',
  '中中': '画面中央',
  '中右': '右侧中间',
  '下左': '左下角',
  '下中': '下边中间',
  '下右': '右下角',
})
const VERTICAL_WORDS = ['上', '中', '下']
const HORIZONTAL_WORDS = ['左', '中', '右']

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Round to `digits` decimals; Infinity / NaN are returned untouched. */
function round(value, digits) {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function clampInt(value, low, high) {
  const numeric = Math.round(Number(value))
  if (!Number.isFinite(numeric)) return low
  return Math.min(high, Math.max(low, numeric))
}

/** Return a Buffer view for Buffer / Uint8Array / ArrayBuffer input, else null. */
function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  return null
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

/* ------------------------------------------------------------------ *
 * PNG decoding (lib/png.js only writes PNGs; the read side lives here)
 * ------------------------------------------------------------------ */

function parseIhdr(data) {
  if (data.length < 13) throw new Error('pixelqa.decodePngPixels: truncated IHDR chunk')
  const header = {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    bitDepth: data[8],
    colorType: data[9],
    compression: data[10],
    filter: data[11],
    interlace: data[12],
  }
  if (!(header.width > 0) || !(header.height > 0)) {
    throw new Error(`pixelqa.decodePngPixels: invalid PNG dimensions ${header.width}x${header.height}`)
  }
  if (header.bitDepth !== 8) {
    throw new Error(`pixelqa.decodePngPixels: unsupported bit depth ${header.bitDepth} (only 8-bit PNGs are supported)`)
  }
  if (header.compression !== 0 || header.filter !== 0) {
    throw new Error('pixelqa.decodePngPixels: unsupported PNG compression/filter method')
  }
  if (header.interlace !== 0) {
    throw new Error('pixelqa.decodePngPixels: interlaced PNG is not supported; re-encode without interlace')
  }
  if (PNG_CHANNELS[header.colorType] === undefined) {
    throw new Error(`pixelqa.decodePngPixels: unsupported PNG colour type ${header.colorType}`)
  }
  return header
}

/** Reverse the five PNG row filters (0=None, 1=Sub, 2=Up, 3=Average, 4=Paeth). */
function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft
  const distanceLeft = Math.abs(estimate - left)
  const distanceUp = Math.abs(estimate - up)
  const distanceUpLeft = Math.abs(estimate - upLeft)
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left
  if (distanceUp <= distanceUpLeft) return up
  return upLeft
}

function unfilterRows(inflated, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel
  const expected = (stride + 1) * height
  if (inflated.length < expected) {
    throw new Error(`pixelqa.decodePngPixels: PNG pixel data is truncated (${inflated.length} < ${expected} bytes)`)
  }
  const raw = new Uint8Array(stride * height)
  let source = 0
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source]
    source += 1
    const rowStart = y * stride
    const previousStart = rowStart - stride
    for (let x = 0; x < stride; x += 1) {
      const value = inflated[source + x]
      const left = x >= bytesPerPixel ? raw[rowStart + x - bytesPerPixel] : 0
      const up = y > 0 ? raw[previousStart + x] : 0
      const upLeft = y > 0 && x >= bytesPerPixel ? raw[previousStart + x - bytesPerPixel] : 0
      let restored
      switch (filter) {
        case 0:
          restored = value
          break
        case 1:
          restored = value + left
          break
        case 2:
          restored = value + up
          break
        case 3:
          restored = value + ((left + up) >> 1)
          break
        case 4:
          restored = value + paethPredictor(left, up, upLeft)
          break
        default:
          throw new Error(`pixelqa.decodePngPixels: unknown PNG row filter ${filter} on row ${y}`)
      }
      raw[rowStart + x] = restored & 0xff
    }
    source += stride
  }
  return raw
}

/**
 * Decode an 8-bit, non-interlaced PNG buffer into raw pixels.
 *
 * Accepts colour types 0 (grey), 2 (RGB), 3 (palette, expanded to RGB),
 * 4 (grey+alpha) and 6 (RGBA). Alpha is returned but comparePixels() ignores it
 * (frames are opaque). Throws a readable English error for anything else
 * (16-bit, interlaced, corrupt/truncated data).
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer PNG bytes
 * @returns {{width: number, height: number, channels: number, data: Uint8Array}}
 */
export function decodePngPixels(buffer) {
  const bytes = asBuffer(buffer)
  if (bytes === null) throw new Error('pixelqa.decodePngPixels: buffer must be a Buffer, Uint8Array or ArrayBuffer')
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('pixelqa.decodePngPixels: not a PNG (bad signature)')
  }
  let header = null
  let palette = null
  const idat = []
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) {
      throw new Error(`pixelqa.decodePngPixels: truncated PNG chunk ${type}`)
    }
    const data = bytes.subarray(dataStart, dataEnd)
    if (type === 'IHDR') header = parseIhdr(data)
    else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    offset = dataEnd + 4
  }
  if (header === null) throw new Error('pixelqa.decodePngPixels: PNG has no IHDR chunk')
  if (idat.length === 0) throw new Error('pixelqa.decodePngPixels: PNG has no IDAT pixel data')
  if (header.colorType === 3 && palette === null) {
    throw new Error('pixelqa.decodePngPixels: palette PNG has no PLTE chunk')
  }

  let inflated
  try {
    inflated = inflateSync(Buffer.concat(idat))
  } catch (error) {
    throw new Error(`pixelqa.decodePngPixels: cannot inflate PNG pixel data (${error.message})`)
  }
  const bytesPerPixel = PNG_BYTES_PER_PIXEL[header.colorType]
  const channels = PNG_CHANNELS[header.colorType]
  const raw = unfilterRows(inflated, header.width, header.height, bytesPerPixel)
  const pixelCount = header.width * header.height

  if (header.colorType === 3) {
    const expanded = new Uint8Array(pixelCount * 3)
    for (let index = 0; index < pixelCount; index += 1) {
      const paletteOffset = raw[index] * 3
      if (paletteOffset + 2 >= palette.length) {
        throw new Error(`pixelqa.decodePngPixels: palette index ${raw[index]} is outside the PLTE chunk`)
      }
      expanded[index * 3] = palette[paletteOffset]
      expanded[index * 3 + 1] = palette[paletteOffset + 1]
      expanded[index * 3 + 2] = palette[paletteOffset + 2]
    }
    return { width: header.width, height: header.height, channels: 3, data: expanded }
  }
  return { width: header.width, height: header.height, channels, data: raw }
}

/* ------------------------------------------------------------------ *
 * Pixel normalisation / resampling
 * ------------------------------------------------------------------ */

/** Accept PNG bytes or a {width,height,channels?,data} raster. */
function normalisePixels(input, label) {
  const bytes = asBuffer(input)
  if (bytes !== null) {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return decodePngPixels(bytes)
    throw new Error(`pixelqa: ${label} is raw bytes without dimensions; pass PNG bytes or {width,height,channels,data}`)
  }
  if (input === null || typeof input !== 'object') {
    throw new Error(`pixelqa: ${label} must be PNG bytes or {width,height,channels,data}`)
  }
  const width = Math.round(Number(input.width))
  const height = Math.round(Number(input.height))
  if (!(width > 0) || !(height > 0)) throw new Error(`pixelqa: ${label}.width/height must be positive integers`)
  const data = input.data
  if (!(data instanceof Uint8Array)) throw new Error(`pixelqa: ${label}.data must be a Uint8Array or Buffer`)
  const pixelCount = width * height
  let channels = Number.isInteger(input.channels) ? input.channels : undefined
  if (channels === undefined) {
    if (data.length === pixelCount * 3) channels = 3
    else if (data.length === pixelCount * 4) channels = 4
    else if (data.length === pixelCount) channels = 1
    else if (data.length === pixelCount * 2) channels = 2
    else {
      throw new Error(
        `pixelqa: ${label}.channels is missing and cannot be inferred from ${data.length} bytes for ${width}x${height}`,
      )
    }
  }
  if (![1, 2, 3, 4].includes(channels)) throw new Error(`pixelqa: ${label}.channels must be 1, 2, 3 or 4 (got ${channels})`)
  if (data.length < pixelCount * channels) {
    throw new Error(`pixelqa: ${label}.data has ${data.length} bytes but ${width}x${height}x${channels} are required`)
  }
  return { width, height, channels, data }
}

/** Convert any supported channel layout to interleaved RGB (alpha ignored). */
function toRgb(source) {
  const { width, height, channels, data } = source
  if (channels === 3) return { width, height, data }
  const pixelCount = width * height
  const out = new Uint8Array(pixelCount * 3)
  for (let index = 0; index < pixelCount; index += 1) {
    if (channels === 4) {
      out[index * 3] = data[index * 4]
      out[index * 3 + 1] = data[index * 4 + 1]
      out[index * 3 + 2] = data[index * 4 + 2]
    } else if (channels === 1) {
      const value = data[index]
      out[index * 3] = value
      out[index * 3 + 1] = value
      out[index * 3 + 2] = value
    } else {
      // grey + alpha: the grey sample leads the pair
      const value = data[index * 2]
      out[index * 3] = value
      out[index * 3 + 1] = value
      out[index * 3 + 2] = value
    }
  }
  return { width, height, data: out }
}

/**
 * Resample an RGB raster to an exact target size. 'auto' averages box areas when
 * shrinking and copies nearest pixels when enlarging (area-averaging on upscale
 * would just produce blocky duplicates, nearest is cheaper and equivalent).
 */
function resizeRgb(source, targetWidth, targetHeight, mode) {
  if (source.width === targetWidth && source.height === targetHeight) return source
  const shrinking = targetWidth <= source.width && targetHeight <= source.height
  const algorithm = mode === 'area' || mode === 'nearest' ? mode : shrinking ? 'area' : 'nearest'
  const sourceWidth = source.width
  const sourceHeight = source.height
  const sourceData = source.data
  const out = new Uint8Array(targetWidth * targetHeight * 3)

  if (algorithm === 'nearest') {
    for (let y = 0; y < targetHeight; y += 1) {
      const sourceY = Math.min(sourceHeight - 1, Math.floor(((y + 0.5) * sourceHeight) / targetHeight))
      for (let x = 0; x < targetWidth; x += 1) {
        const sourceX = Math.min(sourceWidth - 1, Math.floor(((x + 0.5) * sourceWidth) / targetWidth))
        const src = (sourceY * sourceWidth + sourceX) * 3
        const dst = (y * targetWidth + x) * 3
        out[dst] = sourceData[src]
        out[dst + 1] = sourceData[src + 1]
        out[dst + 2] = sourceData[src + 2]
      }
    }
    return { width: targetWidth, height: targetHeight, data: out }
  }

  // Box/area averaging: every target pixel averages the source rectangle it covers.
  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor((y * sourceHeight) / targetHeight)
    const y1 = Math.min(sourceHeight, Math.max(y0 + 1, Math.floor(((y + 1) * sourceHeight) / targetHeight)))
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor((x * sourceWidth) / targetWidth)
      const x1 = Math.min(sourceWidth, Math.max(x0 + 1, Math.floor(((x + 1) * sourceWidth) / targetWidth)))
      let red = 0
      let green = 0
      let blue = 0
      let count = 0
      for (let sourceY = y0; sourceY < y1; sourceY += 1) {
        let offset = (sourceY * sourceWidth + x0) * 3
        for (let sourceX = x0; sourceX < x1; sourceX += 1) {
          red += sourceData[offset]
          green += sourceData[offset + 1]
          blue += sourceData[offset + 2]
          offset += 3
          count += 1
        }
      }
      const dst = (y * targetWidth + x) * 3
      out[dst] = Math.round(red / count)
      out[dst + 1] = Math.round(green / count)
      out[dst + 2] = Math.round(blue / count)
    }
  }
  return { width: targetWidth, height: targetHeight, data: out }
}

/**
 * Normalise both inputs and bring them to one common size.
 * The frame with fewer pixels defines the comparison size (the larger frame is
 * averaged down), which is the honest direction for reference-vs-replica QA.
 */
function preparePair(pixelsA, pixelsB, resizeMode) {
  const a = normalisePixels(pixelsA, 'a')
  const b = normalisePixels(pixelsB, 'b')
  const rgbA = toRgb(a)
  const rgbB = toRgb(b)
  if (a.width === b.width && a.height === b.height) {
    return { rgbA, rgbB, width: a.width, height: a.height, resampled: false }
  }
  const areaA = a.width * a.height
  const areaB = b.width * b.height
  const width = areaA <= areaB ? a.width : b.width
  const height = areaA <= areaB ? a.height : b.height
  return {
    rgbA: resizeRgb(rgbA, width, height, resizeMode),
    rgbB: resizeRgb(rgbB, width, height, resizeMode),
    width,
    height,
    resampled: true,
  }
}

/* ------------------------------------------------------------------ *
 * CIEDE2000 (sRGB -> linear -> XYZ(D65) -> Lab -> CIEDE2000)
 * ------------------------------------------------------------------ */

const DEG = Math.PI / 180
const D65_X = 0.95047
const D65_Y = 1.0
const D65_Z = 1.08883
const DELTA = 6 / 29
const DELTA_CUBED = DELTA ** 3
const DELTA_SQUARED_TIMES_3 = 3 * DELTA * DELTA
const TWENTY_FIVE_POW_7 = 25 ** 7 // 6103515625

function linearChannel(channel) {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** sRGB 0..255 -> CIE L*a*b* with a D65 white point. */
function labFromRgb(red, green, blue) {
  const r = linearChannel(red)
  const g = linearChannel(green)
  const b = linearChannel(blue)
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / D65_X
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175) / D65_Y
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / D65_Z
  const f = (t) => (t > DELTA_CUBED ? Math.cbrt(t) : t / DELTA_SQUARED_TIMES_3 + 4 / 29)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function hueAngle(a, b) {
  if (a === 0 && b === 0) return 0
  const angle = Math.atan2(b, a) / DEG
  return angle >= 0 ? angle : angle + 360
}

/** CIEDE2000 colour difference for two Lab triples (kL = kC = kH = 1). */
function ciede2000(lab1, lab2) {
  const [l1, a1, b1] = lab1
  const [l2, a2, b2] = lab2
  const c1 = Math.hypot(a1, b1)
  const c2 = Math.hypot(a2, b2)
  const cBar = (c1 + c2) / 2
  const cBar7 = cBar ** 7
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + TWENTY_FIVE_POW_7)))
  const a1p = (1 + g) * a1
  const a2p = (1 + g) * a2
  const c1p = Math.hypot(a1p, b1)
  const c2p = Math.hypot(a2p, b2)
  const h1p = hueAngle(a1p, b1)
  const h2p = hueAngle(a2p, b2)
  const deltaL = l2 - l1
  const deltaC = c2p - c1p
  let deltaHue = 0
  if (c1p * c2p !== 0) {
    deltaHue = h2p - h1p
    if (deltaHue > 180) deltaHue -= 360
    else if (deltaHue < -180) deltaHue += 360
  }
  const deltaH = 2 * Math.sqrt(c1p * c2p) * Math.sin((deltaHue * DEG) / 2)
  const lBar = (l1 + l2) / 2
  const cBarP = (c1p + c2p) / 2
  let hBarP = h1p + h2p
  if (c1p * c2p !== 0) {
    const sum = h1p + h2p
    if (Math.abs(h1p - h2p) <= 180) hBarP = sum / 2
    else hBarP = sum < 360 ? (sum + 360) / 2 : (sum - 360) / 2
  }
  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * DEG) +
    0.24 * Math.cos(2 * hBarP * DEG) +
    0.32 * Math.cos((3 * hBarP + 6) * DEG) -
    0.2 * Math.cos((4 * hBarP - 63) * DEG)
  const deltaTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2))
  const cBarP7 = cBarP ** 7
  const rc = 2 * Math.sqrt(cBarP7 / (cBarP7 + TWENTY_FIVE_POW_7))
  const lOffset = (lBar - 50) ** 2
  const sl = 1 + (0.015 * lOffset) / Math.sqrt(20 + lOffset)
  const sc = 1 + 0.045 * cBarP
  const sh = 1 + 0.015 * cBarP * t
  const rt = -Math.sin(2 * deltaTheta * DEG) * rc
  const lTerm = deltaL / sl
  const cTerm = deltaC / sc
  const hTerm = deltaH / sh
  return Math.sqrt(lTerm * lTerm + cTerm * cTerm + hTerm * hTerm + rt * cTerm * hTerm)
}

/** Bounded Lab lookup: flat-colour frames hit the cache, natural frames fall back. */
const LAB_CACHE_LIMIT = 4096

function createLabLookup() {
  const cache = new Map()
  return function labLookup(red, green, blue) {
    const key = (red << 16) | (green << 8) | blue
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const lab = labFromRgb(red, green, blue)
    if (cache.size < LAB_CACHE_LIMIT) cache.set(key, lab)
    return lab
  }
}

/* ------------------------------------------------------------------ *
 * Region grid
 * ------------------------------------------------------------------ */

/**
 * Split an image into a cols × rows grid. Cells cover every pixel exactly once
 * (integer edges, remainder distributed to the last rows/columns), and `index`
 * is row-major. cols/rows are clamped to the image size so no cell is empty.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} [cols=3]
 * @param {number} [rows=3]
 * @returns {Array<{x:number,y:number,w:number,h:number,index:number}>}
 */
export function regionGrid(width, height, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  const imageWidth = Math.round(Number(width))
  const imageHeight = Math.round(Number(height))
  if (!(imageWidth > 0) || !(imageHeight > 0)) {
    throw new Error(`pixelqa.regionGrid: width/height must be positive integers (got ${width}x${height})`)
  }
  const columnCount = clampInt(cols, 1, imageWidth)
  const rowCount = clampInt(rows, 1, imageHeight)
  const grid = []
  for (let row = 0; row < rowCount; row += 1) {
    const y0 = Math.floor((row * imageHeight) / rowCount)
    const y1 = Math.floor(((row + 1) * imageHeight) / rowCount)
    for (let col = 0; col < columnCount; col += 1) {
      const x0 = Math.floor((col * imageWidth) / columnCount)
      const x1 = Math.floor(((col + 1) * imageWidth) / columnCount)
      grid.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, index: row * columnCount + col })
    }
  }
  return grid
}

function validateRegion(cell, width, height) {
  if (cell === null || typeof cell !== 'object') throw new Error('pixelqa: a region must be an object {x,y,w,h,index}')
  const { x, y, w, h } = cell
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h)) {
    throw new Error(`pixelqa: region ${cell.index ?? '?'} must have integer x/y/w/h`)
  }
  if (x < 0 || y < 0 || w <= 0 || h <= 0) throw new Error(`pixelqa: region ${cell.index ?? '?'} has an invalid rectangle`)
  if (x + w > width || y + h > height) {
    throw new Error(`pixelqa: region ${cell.index ?? '?'} (${x},${y},${w}x${h}) exceeds the ${width}x${height} comparison frame`)
  }
}

/** Chinese direction word for a cell, derived from its centre and image size. */
function directionZh(cell, imageWidth, imageHeight) {
  const centerX = cell.x + cell.w / 2
  const centerY = cell.y + cell.h / 2
  const columnBand = Math.min(2, Math.max(0, Math.floor((centerX / imageWidth) * 3)))
  const rowBand = Math.min(2, Math.max(0, Math.floor((centerY / imageHeight) * 3)))
  return POSITION_WORDS[`${VERTICAL_WORDS[rowBand]}${HORIZONTAL_WORDS[columnBand]}`]
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

/** PSNR from an MSE on the 0..255 scale (Infinity when identical). */
function psnrFromMse(mse) {
  return mse === 0 ? Infinity : 10 * Math.log10(MAX_CHANNEL / mse)
}

/**
 * MAE / RMSE / PSNR / mean CIEDE2000 over one rectangle of two same-size RGB
 * rasters. Pixels are visited once; no alpha, no channel weighting.
 *
 * `labLookupA`/`labLookupB` are optional bounded Lab caches shared across the
 * whole comparison. Motion-graphics frames have very few unique colours, so one
 * lookup pass turns thousands of full CIEDE2000 conversions into Map hits; on
 * natural footage the cache caps (see LAB_CACHE_LIMIT) and computation falls
 * back to direct conversion.
 */
function measureRegion(rgbA, rgbB, rect, labLookupA = createLabLookup(), labLookupB = createLabLookup()) {
  const width = rgbA.width
  const dataA = rgbA.data
  const dataB = rgbB.data
  let absoluteSum = 0
  let squareSum = 0
  let deltaESum = 0
  let count = 0
  for (let row = 0; row < rect.h; row += 1) {
    let offset = ((rect.y + row) * width + rect.x) * 3
    for (let column = 0; column < rect.w; column += 1) {
      const dr = dataA[offset] - dataB[offset]
      const dg = dataA[offset + 1] - dataB[offset + 1]
      const db = dataA[offset + 2] - dataB[offset + 2]
      if (dr === 0 && dg === 0 && db === 0) {
        // Identical pixel: contributes 0 to every metric. Skipping the Lab
        // conversion here is what makes flat motion-graphics frames cheap.
        offset += 3
        count += 1
        continue
      }
      absoluteSum += Math.abs(dr) + Math.abs(dg) + Math.abs(db)
      squareSum += dr * dr + dg * dg + db * db
      deltaESum += ciede2000(
        labLookupA(dataA[offset], dataA[offset + 1], dataA[offset + 2]),
        labLookupB(dataB[offset], dataB[offset + 1], dataB[offset + 2]),
      )
      offset += 3
      count += 1
    }
  }
  const mse = count === 0 ? 0 : squareSum / (count * 3)
  return {
    mae: count === 0 ? 0 : absoluteSum / (count * 3),
    rmse: Math.sqrt(mse),
    psnr: psnrFromMse(mse),
    deltaE00: count === 0 ? 0 : deltaESum / count,
  }
}

/** Luminance plane (BT.601 weights, same as lib/video.js / lib/frame.js). */
function lumaPlane(rgb) {
  const { width, height, data } = rgb
  const pixelCount = width * height
  const luma = new Float32Array(pixelCount)
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 3
    luma[index] = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]
  }
  return luma
}

/** SSIM of one uniform window; `stride` is the plane width. */
function ssimWindow(lumaA, lumaB, stride, startX, startY, windowWidth, windowHeight) {
  let sumA = 0
  let sumB = 0
  let sumAA = 0
  let sumBB = 0
  let sumAB = 0
  for (let row = 0; row < windowHeight; row += 1) {
    let index = (startY + row) * stride + startX
    for (let column = 0; column < windowWidth; column += 1) {
      const a = lumaA[index]
      const b = lumaB[index]
      sumA += a
      sumB += b
      sumAA += a * a
      sumBB += b * b
      sumAB += a * b
      index += 1
    }
  }
  const total = windowWidth * windowHeight
  const meanA = sumA / total
  const meanB = sumB / total
  const varianceA = Math.max(0, sumAA / total - meanA * meanA)
  const varianceB = Math.max(0, sumBB / total - meanB * meanB)
  const covariance = sumAB / total - meanA * meanB
  const numerator = (2 * meanA * meanB + SSIM_C1) * (2 * covariance + SSIM_C2)
  const denominator = (meanA * meanA + meanB * meanB + SSIM_C1) * (varianceA + varianceB + SSIM_C2)
  return denominator === 0 ? 1 : numerator / denominator
}

/**
 * Mean SSIM over 8×8 uniform windows on the luminance plane. Identical images
 * return exactly 1. Small images (<8 px on a side) use one global window; large
 * images use a stride so a 4K frame does not pay O(pixels × 64).
 */
function ssimIndex(rgbA, rgbB) {
  const width = rgbA.width
  const height = rgbB.height === rgbA.height ? rgbA.height : rgbB.height
  const lumaA = lumaPlane(rgbA)
  const lumaB = lumaPlane(rgbB)
  if (width < SSIM_WINDOW || height < SSIM_WINDOW) {
    return round(ssimWindow(lumaA, lumaB, width, 0, 0, width, height), 6)
  }
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 128))
  let total = 0
  let count = 0
  for (let y = 0; y + SSIM_WINDOW <= height; y += stride) {
    for (let x = 0; x + SSIM_WINDOW <= width; x += stride) {
      total += ssimWindow(lumaA, lumaB, width, x, y, SSIM_WINDOW, SSIM_WINDOW)
      count += 1
    }
  }
  return count === 0 ? 1 : round(total / count, 6)
}

/* ------------------------------------------------------------------ *
 * Verdicts
 * ------------------------------------------------------------------ */

function normaliseThresholds(input) {
  const result = {
    match: { ...PIXEL_QA_THRESHOLDS.match },
    close: { ...PIXEL_QA_THRESHOLDS.close },
  }
  if (input === null || typeof input !== 'object') return result
  for (const tier of ['match', 'close']) {
    const source = input[tier]
    if (source === null || typeof source !== 'object') continue
    for (const key of ['psnr', 'ssim', 'deltaE00']) {
      const value = Number(source[key])
      if (Number.isFinite(value)) result[tier][key] = value
    }
  }
  return result
}

/** Whole-frame verdict: all three metrics must pass the tier. */
function verdictFor(metrics, thresholds) {
  const match = thresholds.match
  if (metrics.psnr >= match.psnr && metrics.ssim >= match.ssim && metrics.deltaE00 <= match.deltaE00) return 'match'
  const close = thresholds.close
  if (metrics.psnr >= close.psnr && metrics.ssim >= close.ssim && metrics.deltaE00 <= close.deltaE00) return 'close'
  return 'diverge'
}

/**
 * Region verdict: PSNR + ΔE00 only. SSIM over a handful of small blocks is not
 * statistically meaningful, and compareRegions() does not return it either.
 */
function regionVerdict(metrics, thresholds) {
  if (metrics.psnr >= thresholds.match.psnr && metrics.deltaE00 <= thresholds.match.deltaE00) return 'match'
  if (metrics.psnr >= thresholds.close.psnr && metrics.deltaE00 <= thresholds.close.deltaE00) return 'close'
  return 'diverge'
}

/* ------------------------------------------------------------------ *
 * comparePixels / compareRegions
 * ------------------------------------------------------------------ */

function normaliseCompareOptions(options) {
  const source = options !== null && typeof options === 'object' ? options : {}
  return {
    cols: clampInt(source.cols ?? DEFAULT_COLS, 1, 4096),
    rows: clampInt(source.rows ?? DEFAULT_ROWS, 1, 4096),
    maxWorstRegions: clampInt(source.maxWorstRegions ?? DEFAULT_MAX_WORST, 0, 64),
    resize: source.resize === 'area' || source.resize === 'nearest' ? source.resize : 'auto',
    grid: Array.isArray(source.grid) && source.grid.length > 0 ? source.grid : null,
    thresholds: normaliseThresholds(source.thresholds),
  }
}

function collectWorstRegions(rgbA, rgbB, grid, options, labLookupA, labLookupB) {
  const width = rgbA.width
  const height = rgbA.height
  const candidates = []
  for (const cell of grid) {
    validateRegion(cell, width, height)
    const metrics = measureRegion(rgbA, rgbB, cell, labLookupA, labLookupB)
    if (!(metrics.mae > 0)) continue // identical cells are never "worst"
    candidates.push({
      index: cell.index,
      directionZh: directionZh(cell, width, height),
      x: cell.x,
      y: cell.y,
      w: cell.w,
      h: cell.h,
      mae: round(metrics.mae, 3),
      psnr: round(metrics.psnr, 2),
      deltaE00: round(metrics.deltaE00, 2),
      verdict: regionVerdict(metrics, options.thresholds),
      _psnr: metrics.psnr,
    })
  }
  candidates.sort((a, b) => a._psnr - b._psnr || b.mae - a.mae || a.index - b.index)
  return candidates.slice(0, options.maxWorstRegions).map(({ _psnr, ...region }) => region)
}

/**
 * Pixel-level comparison of two frames.
 *
 * @param {Buffer|Uint8Array|object} pixelsA PNG bytes or {width,height,channels?,data}
 * @param {Buffer|Uint8Array|object} pixelsB same shapes as pixelsA (size may differ)
 * @param {object} [options]
 * @param {number} [options.cols=3]  region grid columns for worstRegions
 * @param {number} [options.rows=3]  region grid rows for worstRegions
 * @param {number} [options.maxWorstRegions=3] how many worst regions to report (0 disables)
 * @param {'auto'|'area'|'nearest'} [options.resize='auto'] cross-resolution resampling
 * @param {Array} [options.grid] explicit grid (must match the compared frame size)
 * @param {object} [options.thresholds] partial override, e.g. { match: { psnr: 32 } }
 * @returns {{mae:number, rmse:number, psnr:number, ssim:number, deltaE00:number,
 *   worstRegions:Array<object>, verdict:'match'|'close'|'diverge'}}
 *   NOTE: identical frames return `psnr: Infinity` (print as "∞"; JSON.stringify
 *   turns it into null). All other numbers are finite and rounded (3/3/2/4/2 dp).
 */
export function comparePixels(pixelsA, pixelsB, options = {}) {
  const settings = normaliseCompareOptions(options)
  const pair = preparePair(pixelsA, pixelsB, settings.resize)
  const { rgbA, rgbB, width, height } = pair

  if (bytesEqual(rgbA.data, rgbB.data)) {
    return { mae: 0, rmse: 0, psnr: Infinity, ssim: 1, deltaE00: 0, worstRegions: [], verdict: 'match' }
  }

  // One pair of bounded Lab caches is shared by the whole-frame scan and the
  // region scan, so flat-colour frames convert each unique colour only once.
  const labLookupA = createLabLookup()
  const labLookupB = createLabLookup()
  const global = measureRegion(rgbA, rgbB, { x: 0, y: 0, w: width, h: height }, labLookupA, labLookupB)
  const ssim = ssimIndex(rgbA, rgbB)
  const metrics = { mae: global.mae, rmse: global.rmse, psnr: global.psnr, ssim, deltaE00: global.deltaE00 }
  const verdict = verdictFor(metrics, settings.thresholds)
  let worstRegions = []
  if (settings.maxWorstRegions > 0) {
    const grid = settings.grid ?? regionGrid(width, height, settings.cols, settings.rows)
    worstRegions = collectWorstRegions(rgbA, rgbB, grid, settings, labLookupA, labLookupB)
  }

  return {
    mae: round(metrics.mae, 3),
    rmse: round(metrics.rmse, 3),
    psnr: round(metrics.psnr, 2),
    ssim: round(metrics.ssim, 4),
    deltaE00: round(metrics.deltaE00, 2),
    worstRegions,
    verdict,
  }
}

/**
 * Compare a pre-defined region grid block by block. `pixelsB` is resampled to
 * the grid's frame size when the two rasters differ, so a 1920×1080 reference
 * can be compared against a 1280×720 replica without pre-scaling.
 *
 * @param {Buffer|Uint8Array|object} pixelsA reference raster (grid is expressed in its size)
 * @param {Buffer|Uint8Array|object} pixelsB replica raster
 * @param {Array<{x:number,y:number,w:number,h:number,index:number}>} grid from regionGrid()
 * @returns {Array<{index:number, mae:number, psnr:number, deltaE00:number,
 *   verdict:'match'|'close'|'diverge'}>}
 */
export function compareRegions(pixelsA, pixelsB, grid) {
  if (!Array.isArray(grid) || grid.length === 0) {
    throw new Error('pixelqa.compareRegions: grid must be a non-empty array from regionGrid()')
  }
  const a = normalisePixels(pixelsA, 'regionA')
  const b = normalisePixels(pixelsB, 'regionB')
  const rgbA = toRgb(a)
  let rgbB = toRgb(b)
  if (a.width !== b.width || a.height !== b.height) {
    rgbB = resizeRgb(rgbB, a.width, a.height, 'auto')
  }
  // Shared bounded Lab caches: the cells partition the image, so every pixel is
  // converted once no matter how many cells the grid has.
  const labLookupA = createLabLookup()
  const labLookupB = createLabLookup()
  return grid.map((cell) => {
    validateRegion(cell, a.width, a.height)
    const metrics = measureRegion(rgbA, rgbB, cell, labLookupA, labLookupB)
    return {
      index: cell.index,
      mae: round(metrics.mae, 3),
      psnr: round(metrics.psnr, 2),
      deltaE00: round(metrics.deltaE00, 2),
      verdict: regionVerdict(metrics, PIXEL_QA_THRESHOLDS),
    }
  })
}

export default {
  decodePngPixels,
  comparePixels,
  regionGrid,
  compareRegions,
  PIXEL_QA_THRESHOLDS,
}
