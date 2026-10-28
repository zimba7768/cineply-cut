import { drawRegion, easeInOut } from '@/engine/effects/util'
import type { Layer, TransitionDef } from './types'
import { full, selectParam, str } from './helpers'

const SLICES = 64

interface Plane {
  img: Layer
  angle: number // rotation about the vertical axis, radians
  axisX: number // axis position relative to the frame centre, px
  axisZ: number // axis depth (positive = into the screen), px
}

/** Projected geometry of a rotated frame-sized plane: slice edges and depth scale at each edge. */
function project(pl: Plane, w: number): { xs: number[]; fs: number[]; depth: number } {
  const cam = w * 1.6
  const cos = Math.cos(pl.angle)
  const sin = Math.sin(pl.angle)
  const xs: number[] = []
  const fs: number[] = []
  let depth = 0
  for (let j = 0; j <= SLICES; j++) {
    const rx = -w / 2 + (j / SLICES) * w - pl.axisX
    const rz = -pl.axisZ
    const X = pl.axisX + rx * cos - rz * sin
    const Z = pl.axisZ + rx * sin + rz * cos
    const f = cam / Math.max(1, cam + Z)
    xs.push(w / 2 + X * f)
    fs.push(f)
    depth += Z
  }
  return { xs, fs, depth: depth / (SLICES + 1) }
}

/**
 * Fakes a perspective rotation about a vertical axis by drawing the image in vertical slices, each
 * scaled by its projected depth. Back-facing planes are skipped. `shade` darkens with the angle.
 */
function drawPlanes(ctx: CanvasRenderingContext2D, planes: Plane[], w: number, h: number, shade = 0.55): void {
  const projected = planes
    .filter((pl) => pl.img)
    .map((pl) => ({ pl, geo: project(pl, w) }))
    .filter(({ geo }) => geo.xs[SLICES] - geo.xs[0] > 0.5)
    .sort((a, b) => b.geo.depth - a.geo.depth)
  for (const { pl, geo } of projected) {
    const dark = shade * (1 - Math.abs(Math.cos(pl.angle)))
    for (let j = 0; j < SLICES; j++) {
      const x0 = geo.xs[j]
      const x1 = geo.xs[j + 1]
      const f = (geo.fs[j] + geo.fs[j + 1]) / 2
      const dh = h * f
      const dy = h / 2 - dh / 2
      // Overlap slices by half a pixel so no seams show.
      drawRegion(ctx, pl.img!, w, h, (j / SLICES) * w, 0, w / SLICES, h, x0, dy, x1 - x0 + 0.5, dh)
      if (dark > 0.01) {
        ctx.fillStyle = `rgba(0,0,0,${dark.toFixed(3)})`
        ctx.fillRect(x0, dy, x1 - x0 + 0.5, dh)
      }
    }
  }
}

const directionParam = selectParam('direction', 'Direction', 'left', [['left', 'Left'], ['right', 'Right']])

const flip: TransitionDef = {
  type: 'flip-3d',
  name: 'Flip 3D',
  category: '3D',
  defaultDuration: 1,
  params: [directionParam],
  render(ctx, from, to, p, params, w, h) {
    // A card flip: the incoming shot is on the back of the outgoing one.
    const dir = str(params, 'direction') === 'right' ? -1 : 1
    const a = easeInOut(p) * Math.PI * dir
    drawPlanes(ctx, [
      { img: from, angle: a, axisX: 0, axisZ: 0 },
      { img: to, angle: a - Math.PI * dir, axisX: 0, axisZ: 0 }
    ], w, h)
  }
}

const cube: TransitionDef = {
  type: 'cube-spin',
  name: 'Cube Spin',
  category: '3D',
  defaultDuration: 1,
  params: [directionParam],
  render(ctx, from, to, p, params, w, h) {
    // Two adjacent faces of a cube rotating about its centre (half a frame width behind the screen).
    const dir = str(params, 'direction') === 'right' ? 1 : -1
    const a = easeInOut(p) * (Math.PI / 2) * dir
    drawPlanes(ctx, [
      { img: from, angle: a, axisX: 0, axisZ: w / 2 },
      { img: to, angle: a - (Math.PI / 2) * dir, axisX: 0, axisZ: w / 2 }
    ], w, h, 0.4)
  }
}

const pageTurn: TransitionDef = {
  type: 'page-turn',
  name: 'Page Turn',
  category: '3D',
  defaultDuration: 1,
  params: [selectParam('hinge', 'Hinge', 'left', [['left', 'Left edge'], ['right', 'Right edge']])],
  render(ctx, from, to, p, params, w, h) {
    // The outgoing shot swings open like a page on a hinge, uncovering the incoming one.
    const e = easeInOut(p)
    const left = str(params, 'hinge') !== 'right'
    const sign = left ? -1 : 1
    if (!from) {
      // Nothing outgoing: the incoming shot swings shut onto the frame instead.
      drawPlanes(ctx, [{ img: to, angle: sign * (1 - e) * (Math.PI / 2), axisX: left ? -w / 2 : w / 2, axisZ: 0 }], w, h, 0.3)
      return
    }
    full(ctx, to, w, h)
    if (to) {
      ctx.fillStyle = `rgba(0,0,0,${(0.5 * (1 - e)).toFixed(3)})`
      ctx.fillRect(0, 0, w, h)
    }
    drawPlanes(ctx, [{ img: from, angle: sign * e * (Math.PI / 2), axisX: left ? -w / 2 : w / 2, axisZ: 0 }], w, h, 0.3)
  }
}

export const PERSPECTIVE_TRANSITIONS: TransitionDef[] = [flip, cube, pageTurn]
