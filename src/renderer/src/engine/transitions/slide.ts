import { averageSamples, clamp01, drawRegion, easeInOut } from '@/engine/effects/util'
import type { Layer, TransitionDef } from './types'
import { DIRECTIONS, dirVector, full, num, numberParam, selectParam, str } from './helpers'

const directionParam = selectParam('direction', 'Direction', 'left', DIRECTIONS)

/** Draws from/to pushed by e (0..1) along direction (dx, dy): from leaves, to arrives. */
function drawPush(ctx: CanvasRenderingContext2D, from: Layer, to: Layer, e: number, dx: number, dy: number, w: number, h: number): void {
  if (from) ctx.drawImage(from, dx * e * w, dy * e * h, w, h)
  if (to) ctx.drawImage(to, dx * (e - 1) * w, dy * (e - 1) * h, w, h)
}

const push: TransitionDef = {
  type: 'push',
  name: 'Push',
  category: 'Slide',
  defaultDuration: 1,
  params: [directionParam],
  render(ctx, from, to, p, params, w, h) {
    const [dx, dy] = dirVector(str(params, 'direction'))
    drawPush(ctx, from, to, easeInOut(p), dx, dy, w, h)
  }
}

const slide: TransitionDef = {
  type: 'slide',
  name: 'Slide',
  category: 'Slide',
  defaultDuration: 1,
  params: [directionParam],
  render(ctx, from, to, p, params, w, h) {
    const [dx, dy] = dirVector(str(params, 'direction'))
    const e = easeInOut(p)
    // With nothing incoming, the outgoing shot slides away instead.
    if (!to) {
      drawPush(ctx, from, null, e, dx, dy, w, h)
      return
    }
    if (from) ctx.drawImage(from, 0, 0, w, h)
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = h * 0.03
    ctx.drawImage(to, dx * (e - 1) * w, dy * (e - 1) * h, w, h)
  }
}

const split: TransitionDef = {
  type: 'split',
  name: 'Split',
  category: 'Slide',
  defaultDuration: 1,
  params: [selectParam('orientation', 'Orientation', 'vertical', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']])],
  render(ctx, from, to, p, params, w, h) {
    // The outgoing shot splits down the middle and both halves slide away to reveal the incoming one.
    // With nothing outgoing, the incoming shot's halves slide together instead.
    const e = from ? easeInOut(p) : 1 - easeInOut(p)
    const img = from ?? to
    if (from) full(ctx, to, w, h)
    if (!img) return
    if (str(params, 'orientation') === 'vertical') {
      const o = (e * w) / 2
      drawRegion(ctx, img, w, h, 0, 0, w / 2, h, -o, 0, w / 2, h)
      drawRegion(ctx, img, w, h, w / 2, 0, w / 2, h, w / 2 + o, 0, w / 2, h)
    } else {
      const o = (e * h) / 2
      drawRegion(ctx, img, w, h, 0, 0, w, h / 2, 0, -o, w, h / 2)
      drawRegion(ctx, img, w, h, 0, h / 2, w, h / 2, 0, h / 2 + o, w, h / 2)
    }
  }
}

const whipPan: TransitionDef = {
  type: 'whip-pan',
  name: 'Whip Pan',
  category: 'Slide',
  defaultDuration: 0.5,
  params: [directionParam, numberParam('blur', 'Motion blur', 1, 0, 2)],
  render(ctx, from, to, p, params, w, h) {
    const [dx, dy] = dirVector(str(params, 'direction'))
    // Sharp acceleration into the middle of the move; the shutter smears along the motion.
    const curve = (x: number): number => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x))
    const e = curve(p)
    const velocity = (Math.PI / 2) * Math.sin(Math.PI * p) // de/dp
    const spread = Math.min(0.45, velocity * 0.12 * num(params, 'blur'))
    const n = spread < 0.004 ? 1 : 10
    averageSamples(ctx, w, h, n, (s, i) => {
      const ei = n === 1 ? e : clamp01(e + (i / (n - 1) - 0.5) * spread)
      drawPush(s, from, to, ei, dx, dy, w, h)
    }, 'tr-whip')
  }
}

export const SLIDE_TRANSITIONS: TransitionDef[] = [push, slide, split, whipPan]
