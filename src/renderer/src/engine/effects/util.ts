/**
 * Canvas helpers shared by the transition, effect and title renderers. Everything here is
 * synchronous and deterministic so preview and export produce identical frames.
 */

export type Params = Record<string, number | string | boolean>

export interface Surface {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

/** Creates a canvas (an OffscreenCanvas when there is no DOM, e.g. in a worker). */
export function createCanvas(w: number, h: number): HTMLCanvasElement {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  return new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement
}

const POOL_LIMIT = 40
const pool = new Map<string, Surface>()

/**
 * A cleared scratch canvas of w×h for temporary drawing, reused across frames. Keys must be unique per
 * concurrent use within one render call. `readback` requests a CPU-backed context for getImageData work.
 */
export function scratch(key: string, w: number, h: number, readback = false): Surface {
  const cw = Math.max(1, Math.round(w))
  const ch = Math.max(1, Math.round(h))
  const id = `${key}:${cw}x${ch}:${readback ? 'r' : 'g'}`
  let s = pool.get(id)
  if (s) {
    pool.delete(id)
  } else {
    const canvas = createCanvas(cw, ch)
    const ctx = canvas.getContext('2d', { willReadFrequently: readback }) as CanvasRenderingContext2D
    s = { canvas, ctx }
    if (pool.size >= POOL_LIMIT) pool.delete(pool.keys().next().value!)
  }
  pool.set(id, s)
  resetContext(s.ctx)
  s.ctx.clearRect(0, 0, cw, ch)
  return s
}

export function resetContext(ctx: CanvasRenderingContext2D): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0
}

/** Pixel size of any drawable. */
export function sourceSize(img: CanvasImageSource): { w: number; h: number } {
  const o = img as unknown as Record<string, unknown>
  if (typeof o.videoWidth === 'number') return { w: o.videoWidth, h: o.videoHeight as number }
  if (typeof o.naturalWidth === 'number') return { w: o.naturalWidth, h: o.naturalHeight as number }
  if (typeof o.displayWidth === 'number') return { w: o.displayWidth, h: o.displayHeight as number }
  const sw = o.width as number | { baseVal: { value: number } }
  const sh = o.height as number | { baseVal: { value: number } }
  return {
    w: typeof sw === 'number' ? sw : sw.baseVal.value,
    h: typeof sh === 'number' ? sh : sh.baseVal.value
  }
}

/**
 * Draws the region (x, y, rw, rh) of `img` — given in frame coordinates, where the image is
 * stretched over w×h — to (dx, dy, dw, dh).
 */
export function drawRegion(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  w: number,
  h: number,
  x: number, y: number, rw: number, rh: number,
  dx: number, dy: number, dw: number, dh: number
): void {
  const s = sourceSize(img)
  const kx = s.w / w
  const ky = s.h / h
  const sx = Math.max(0, x * kx)
  const sy = Math.max(0, y * ky)
  const sw = Math.min(s.w - sx, rw * kx)
  const sh = Math.min(s.h - sy, rh * ky)
  if (sw <= 0 || sh <= 0 || dw === 0 || dh === 0) return
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
}

/** Copies a canvas into a scratch surface (so it can be redrawn onto itself). */
export function copyOf(canvas: HTMLCanvasElement, key = 'fx-copy'): Surface {
  const s = scratch(key, canvas.width, canvas.height)
  s.ctx.drawImage(canvas, 0, 0)
  return s
}

/** Redraws the canvas onto itself through a CSS filter string. */
export function refilter(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, filter: string, dx = 0, dy = 0): void {
  const copy = copyOf(canvas)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.filter = filter
  ctx.drawImage(copy.canvas, dx, dy)
  ctx.filter = 'none'
}

/** Runs fn over the pixels of the whole canvas and writes them back. */
export function withPixels(ctx: CanvasRenderingContext2D, w: number, h: number, fn: (d: Uint8ClampedArray, w: number, h: number) => void): void {
  if (w < 1 || h < 1) return
  const img = ctx.getImageData(0, 0, w, h)
  fn(img.data, w, h)
  ctx.putImageData(img, 0, 0)
}

// ------------------------------------------------------------------ maths ----

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a || 1e-6))
  return t * t * (3 - 2 * t)
}
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const easeIn = (t: number): number => t * t * t
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3)
export const easeOutBack = (t: number, s = 1.70158): number => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2)
export const deg = (d: number): number => (d * Math.PI) / 180

/** Seeded PRNG (mulberry32), returns floats in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A 32-bit seed derived from a time (rounded to the millisecond, so it is stable per frame) and a salt. */
export function timeSeed(t: number, salt = 0): number {
  let x = (Math.round(t * 1000) | 0) ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

/** Parses #rgb / #rrggbb / rgb()/rgba() into [r, g, b] 0..255 (black when unparseable). */
export function parseColor(c: string): [number, number, number] {
  const s = c.trim()
  let m = /^#([0-9a-f]{3})$/i.exec(s)
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as [number, number, number]
  m = /^#([0-9a-f]{6})/i.exec(s)
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as [number, number, number]
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  return [0, 0, 0]
}

/** Inverse error function (Giles' approximation); used to place gaussian sample offsets. */
export function erfinv(x: number): number {
  let w = -Math.log((1 - x) * (1 + x))
  let p: number
  if (w < 5) {
    w -= 2.5
    p = 2.81022636e-8
    p = 3.43273939e-7 + p * w
    p = -3.5233877e-6 + p * w
    p = -4.39150654e-6 + p * w
    p = 0.00021858087 + p * w
    p = -0.00125372503 + p * w
    p = -0.00417768164 + p * w
    p = 0.246640727 + p * w
    p = 1.50140941 + p * w
  } else {
    w = Math.sqrt(w) - 3
    p = -0.000200214257
    p = 0.000100950558 + p * w
    p = 0.00134934322 + p * w
    p = -0.00367342844 + p * w
    p = 0.00573950773 + p * w
    p = -0.0076224613 + p * w
    p = 0.00943887047 + p * w
    p = 1.00167406 + p * w
    p = 2.83297682 + p * w
  }
  return p * x
}

/** Offsets (in units of sigma) of n equal-weight samples that together approximate a gaussian. */
export function gaussianOffsets(n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(Math.SQRT2 * erfinv(2 * ((i + 0.5) / n) - 1))
  return out
}

/**
 * Averages n renderings into ctx with equal weights (running average, exact for opaque samples).
 * draw(target, i) renders sample i into a cleared scratch context.
 */
export function averageSamples(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  n: number,
  draw: (target: CanvasRenderingContext2D, i: number) => void,
  key = 'avg'
): void {
  const s = scratch(key, w, h)
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      resetContext(s.ctx)
      s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height)
    }
    draw(s.ctx, i)
    ctx.globalAlpha = 1 / (i + 1)
    ctx.drawImage(s.canvas, 0, 0, w, h)
  }
  ctx.globalAlpha = 1
}

/** Shifts the red and blue channels of an RGBA buffer in opposite directions (chromatic aberration). */
export function rgbShift(d: Uint8ClampedArray, w: number, h: number, dx: number, dy: number): void {
  const ox = Math.round(dx)
  const oy = Math.round(dy)
  if (ox === 0 && oy === 0) return
  const src = new Uint8ClampedArray(d)
  for (let y = 0; y < h; y++) {
    const yr = clamp(y - oy, 0, h - 1) * w
    const yb = clamp(y + oy, 0, h - 1) * w
    const row = y * w
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4
      const ir = (yr + clamp(x - ox, 0, w - 1)) * 4
      const ib = (yb + clamp(x + ox, 0, w - 1)) * 4
      d[i] = src[ir]
      d[i + 2] = src[ib + 2]
      const a = Math.max(src[i + 3], src[ir + 3], src[ib + 3])
      d[i + 3] = a
    }
  }
}
