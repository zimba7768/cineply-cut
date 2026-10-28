import { clamp01, scratch } from '@/engine/effects/util'
import type { Layer } from './types'

/** Draws a whole layer stretched over the frame. */
export function full(ctx: CanvasRenderingContext2D, img: Layer, w: number, h: number, alpha = 1): void {
  if (!img || alpha <= 0) return
  ctx.globalAlpha = Math.min(1, alpha)
  ctx.drawImage(img, 0, 0, w, h)
  ctx.globalAlpha = 1
}

/**
 * from × (1 − m) + to × m. Uses additive compositing of premultiplied colour, so the blend is exact
 * (no mid-transition dip) and also correct when either side is transparent.
 */
export function mix(ctx: CanvasRenderingContext2D, from: Layer, to: Layer, m: number, w: number, h: number): void {
  full(ctx, from, w, h, 1 - m)
  ctx.globalCompositeOperation = 'lighter'
  full(ctx, to, w, h, m)
  ctx.globalCompositeOperation = 'source-over'
}

/**
 * Blends through a mask: `to` shows where the mask is opaque, `from` where it is clear (soft edges
 * blend both). drawMask paints the mask with any opaque colour onto a cleared context.
 */
export function maskBlend(
  ctx: CanvasRenderingContext2D,
  from: Layer,
  to: Layer,
  w: number,
  h: number,
  drawMask: (m: CanvasRenderingContext2D) => void
): void {
  const mask = scratch('tr-mask', w, h)
  mask.ctx.fillStyle = '#fff'
  mask.ctx.strokeStyle = '#fff'
  drawMask(mask.ctx)
  if (from) {
    const a = scratch('tr-mask-from', w, h)
    a.ctx.drawImage(from, 0, 0, w, h)
    a.ctx.globalCompositeOperation = 'destination-out'
    a.ctx.drawImage(mask.canvas, 0, 0, w, h)
    ctx.drawImage(a.canvas, 0, 0, w, h)
  }
  if (to) {
    const b = scratch('tr-mask-to', w, h)
    b.ctx.drawImage(to, 0, 0, w, h)
    b.ctx.globalCompositeOperation = 'destination-in'
    b.ctx.drawImage(mask.canvas, 0, 0, w, h)
    ctx.globalCompositeOperation = 'lighter'
    ctx.drawImage(b.canvas, 0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
  }
}

/**
 * Adds colour stops to a gradient for the piecewise-linear alpha ramp f(u), u ∈ [0, 1], whose
 * corners lie at `breaks`. Exact for hard and soft edges alike.
 */
export function rampStops(g: CanvasGradient, f: (u: number) => number, breaks: number[]): CanvasGradient {
  const us = [0, 1, ...breaks.map(clamp01)].sort((a, b) => a - b)
  let last = -1
  for (const u of us) {
    if (u === last) continue
    last = u
    g.addColorStop(u, `rgba(255,255,255,${clamp01(f(u)).toFixed(4)})`)
  }
  return g
}

/**
 * Alpha of a soft wipe edge travelling along u ∈ [0, 1]: fully clear at p = 0, fully covered at p = 1,
 * with a ramp of width `soft`. `u` small = covered first.
 */
export function wipeRamp(p: number, soft: number): { f: (u: number) => number; breaks: number[] } {
  const s = Math.max(soft, 1e-4)
  const lead = p * (1 + s)
  return { f: (u) => (lead - u) / s, breaks: [lead - s, lead] }
}

export { boolParam, colorParam, num, numberParam, selectParam, str, unit } from '@/engine/effects/params'

export const DIRECTIONS: [string, string][] = [
  ['left', 'Left'], ['right', 'Right'], ['up', 'Up'], ['down', 'Down']
]

/** Unit vector of a direction param value ('left' = content moves left). */
export function dirVector(d: string): [number, number] {
  switch (d) {
    case 'right': return [1, 0]
    case 'up': return [0, -1]
    case 'down': return [0, 1]
    default: return [-1, 0]
  }
}
