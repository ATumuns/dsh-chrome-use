/**
 * Generate the extension's PNG icon set from one deterministic shape description.
 *
 * The icons are committed, so this script is not part of the install path; it
 * exists so a redesign is a one-command rebuild instead of hand-painted pixels.
 * Every pixel is sampled 4x4 for antialiasing and encoded as RGBA, so no image
 * library is needed.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'extension', 'icons')
const SIZES = [16, 32, 48, 128]
const SAMPLES = 4

const TOP = [0x4f, 0x9d, 0xff]
const BOTTOM = [0x18, 0x4f, 0xc8]
const INK = [0xff, 0xff, 0xff]

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hx = (x1 - x0) / 2 - r
  const hy = (y1 - y0) / 2 - r
  const dx = Math.abs(x - cx) - hx
  const dy = Math.abs(y - cy) - hy
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - r
}

function circle(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) - r
}

/**
 * @param {number} u - horizontal position in [0,1]
 * @param {number} v - vertical position in [0,1]
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
function shade(u, v) {
  // Background: rounded square with a vertical gradient.
  const bg = roundedRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.22)
  if (bg > 0) return { r: 0, g: 0, b: 0, a: 0 }
  const t = Math.min(Math.max((v - 0.02) / 0.96, 0), 1)
  const r = Math.round(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
  const g = Math.round(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
  const b = Math.round(TOP[2] + (BOTTOM[2] - TOP[2]) * t)

  // A browser window drawn as a white frame with a title bar, and a pointer
  // arrow sitting in the page area: the mark for "a browser someone else drives".
  const outer = roundedRect(u, v, 0.15, 0.19, 0.85, 0.81, 0.08) < 0
  const inner = roundedRect(u, v, 0.235, 0.315, 0.765, 0.745, 0.045) < 0
  const frameRing = outer && !inner
  const titleDivider = v >= 0.312 && v <= 0.342 && u >= 0.235 && u <= 0.765
  const dotLeft = circle(u, v, 0.302, 0.262, 0.024) < 0
  const dotRight = circle(u, v, 0.372, 0.262, 0.024) < 0
  const pointer = pointInPolygon(u, v, POINTER)
  const ink = frameRing || titleDivider || dotLeft || dotRight || (pointer && inner)
  if (!ink) return { r, g, b, a: 255 }
  return { r: INK[0], g: INK[1], b: INK[2], a: 255 }
}

/** A pointer arrow: a wedge with a stepped tail, the "dragged by someone" mark. */
const POINTER = [
  [0.408, 0.404],
  [0.408, 0.664],
  [0.472, 0.6],
  [0.522, 0.706],
  [0.582, 0.676],
  [0.532, 0.572],
  [0.618, 0.566],
]

function pointInPolygon(u, v, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const u = (px + (sx + 0.5) / SAMPLES) / size
          const v = (py + (sy + 0.5) / SAMPLES) / size
          const sample = shade(u, v)
          const alpha = sample.a / 255
          r += sample.r * alpha
          g += sample.g * alpha
          b += sample.b * alpha
          a += alpha
        }
      }
      const total = SAMPLES * SAMPLES
      const offset = (py * size + px) * 4
      const cover = a / total
      if (cover > 0) {
        pixels[offset] = Math.round(r / a)
        pixels[offset + 1] = Math.round(g / a)
        pixels[offset + 2] = Math.round(b / a)
      }
      pixels[offset + 3] = Math.round(cover * 255)
    }
  }
  return pixels
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function png(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })
for (const size of SIZES) {
  const file = join(OUT, `icon-${size}.png`)
  writeFileSync(file, png(size, render(size)))
  console.log(`wrote ${file}`)
}
