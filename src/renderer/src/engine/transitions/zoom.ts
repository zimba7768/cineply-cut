import { averageSamples, easeIn, easeInOut, easeOut } from '@/engine/effects/util'
import type { Layer, TransitionDef } from './types'
import { full, num, numberParam, selectParam, str, unit } from './helpers'

const centerParams = [numberParam('cx', 'Center X', 0.5, 0, 1), numberParam('cy', 'Center Y', 0.5, 0, 1)]

/** Draws img scaled by s about the frame point (px, py). */
function drawScaled(ctx: CanvasRenderingContext2D, img: Layer, s: number, px: number, py: number, w: number, h: number): void {
  if (!img || s <= 0) return
  ctx.drawImage(img, px - px * s, py - py * s, w * s, h * s)
}

const zoomIn: TransitionDef = {
  type: 'zoom-in',
  name: 'Zoom In',
  category: 'Zoom',
  defaultDuration: 1,
  params: centerParams,
  render(ctx, from, to, p, params, w, h) {
    // The incoming shot grows out of a point over the outgoing one.
    const e = easeInOut(p)
    const px = num(params, 'cx') * w
    const py = num(params, 'cy') * h
    if (!to) {
      // Nothing incoming: the outgoing shot shrinks away instead.
      ctx.globalAlpha = Math.min(1, (1 - e) * 4)
      drawScaled(ctx, from, 1 - e, px, py, w, h)
      return
    }
    full(ctx, from, w, h)
    ctx.globalAlpha = Math.min(1, e * 4)
    drawScaled(ctx, to, e, px, py, w, h)
  }
}

const zoomOut: TransitionDef = {
  type: 'zoom-out',
  name: 'Zoom Out',
  category: 'Zoom',
  defaultDuration: 1,
  params: centerParams,
  render(ctx, from, to, p, params, w, h) {
    // The outgoing shot shrinks away into a point, revealing the incoming one.
    const e = easeInOut(p)
    const px = num(params, 'cx') * w
    const py = num(params, 'cy') * h
    if (!from) {
      // Nothing outgoing: the incoming shot grows in instead.
      ctx.globalAlpha = Math.min(1, e * 4)
      drawScaled(ctx, to, e, px, py, w, h)
      return
    }
    full(ctx, to, w, h)
    ctx.globalAlpha = Math.min(1, (1 - e) * 4)
    drawScaled(ctx, from, 1 - e, px, py, w, h)
  }
}

const crossZoom: TransitionDef = {
  type: 'cross-zoom',
  name: 'Cross Zoom',
  category: 'Zoom',
  defaultDuration: 0.8,
  params: [numberParam('zoom', 'Zoom', 3, 1.2, 8, 0.1, '×'), numberParam('blur', 'Zoom blur', 1, 0, 2)],
  render(ctx, from, to, p, params, w, h) {
    // Punch into the outgoing shot, cut at peak blur, then pull out of the incoming one.
    const z = num(params, 'zoom')
    const first = p < 0.5
    const q = first ? easeIn(p * 2) : 1 - easeOut((p - 0.5) * 2)
    const img = first ? from : to
    if (!img) return
    const s = 1 + (z - 1) * q
    const streak = 0.08 * q * num(params, 'blur')
    const n = streak < 0.002 ? 1 : 8
    const blur = q * 6 * unit(h) * num(params, 'blur')
    averageSamples(ctx, w, h, n, (c, i) => {
      if (blur > 0.2) c.filter = `blur(${blur.toFixed(2)}px)`
      drawScaled(c, img, s * (1 + (n === 1 ? 0 : (i / (n - 1)) * streak)), w / 2, h / 2, w, h)
    }, 'tr-zoom')
    // A short exposure flash hides the cut.
    const flash = Math.max(0, 1 - Math.abs(p - 0.5) * 8) * 0.35
    if (flash > 0) {
      ctx.globalCompositeOperation = 'lighter'
      full(ctx, img, w, h, flash)
    }
  }
}

const spin: TransitionDef = {
  type: 'spin',
  name: 'Spin',
  category: 'Zoom',
  defaultDuration: 1,
  params: [numberParam('turns', 'Turns', 1, 0.25, 4, 0.25), selectParam('direction', 'Direction', 'cw', [['cw', 'Clockwise'], ['ccw', 'Counter-clockwise']])],
  render(ctx, from, to, p, params, w, h) {
    // The outgoing shot spins and shrinks away while the incoming one settles in behind it.
    const e = easeInOut(p)
    const dir = str(params, 'direction') === 'ccw' ? -1 : 1
    ctx.globalAlpha = Math.min(1, p * 2)
    drawScaled(ctx, to, 1.15 - 0.15 * e, w / 2, h / 2, w, h)
    ctx.globalAlpha = 1
    if (!from || e >= 1) return
    ctx.save()
    ctx.translate(w / 2, h / 2)
    ctx.rotate(dir * e * Math.PI * 2 * num(params, 'turns'))
    const s = 1 - e
    ctx.globalAlpha = Math.min(1, (1 - e) * 3)
    ctx.drawImage(from, (-w / 2) * s, (-h / 2) * s, w * s, h * s)
    ctx.restore()
  }
}

export const ZOOM_TRANSITIONS: TransitionDef[] = [zoomIn, zoomOut, crossZoom, spin]
