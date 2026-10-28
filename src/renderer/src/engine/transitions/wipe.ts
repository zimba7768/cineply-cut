import { clamp01, deg, prng } from '@/engine/effects/util'
import type { TransitionDef } from './types'
import { maskBlend, num, numberParam, rampStops, selectParam, str, unit, wipeRamp } from './helpers'

const WIPE_DIRECTIONS: [string, string][] = [
  ['ltr', 'Left to right'], ['rtl', 'Right to left'], ['ttb', 'Top to bottom'], ['btt', 'Bottom to top'],
  ['tl', 'From top left'], ['tr', 'From top right'], ['bl', 'From bottom left'], ['br', 'From bottom right']
]

/** Start and end points of the wipe axis for a direction. */
function wipeAxis(dir: string, w: number, h: number): [number, number, number, number] {
  switch (dir) {
    case 'rtl': return [w, 0, 0, 0]
    case 'ttb': return [0, 0, 0, h]
    case 'btt': return [0, h, 0, 0]
    case 'tl': return [0, 0, w, h]
    case 'tr': return [w, 0, 0, h]
    case 'bl': return [0, h, w, 0]
    case 'br': return [w, h, 0, 0]
    default: return [0, 0, w, 0]
  }
}

const wipe: TransitionDef = {
  type: 'wipe',
  name: 'Wipe',
  category: 'Wipe',
  defaultDuration: 1,
  params: [selectParam('direction', 'Direction', 'ltr', WIPE_DIRECTIONS), numberParam('softness', 'Softness', 0.05, 0, 0.5)],
  render(ctx, from, to, p, params, w, h) {
    const [x0, y0, x1, y1] = wipeAxis(str(params, 'direction'), w, h)
    const { f, breaks } = wipeRamp(p, num(params, 'softness'))
    maskBlend(ctx, from, to, w, h, (m) => {
      // Diagonal axes run corner to corner; the perpendicular gradient lines then sweep the whole frame.
      m.fillStyle = rampStops(m.createLinearGradient(x0, y0, x1, y1), f, breaks)
      m.fillRect(0, 0, w, h)
    })
  }
}

const clockWipe: TransitionDef = {
  type: 'clock-wipe',
  name: 'Clock Wipe',
  category: 'Wipe',
  defaultDuration: 1,
  params: [
    numberParam('angle', 'Start angle', 0, -180, 180, 1, '°'),
    selectParam('direction', 'Direction', 'cw', [['cw', 'Clockwise'], ['ccw', 'Counter-clockwise']])
  ],
  render(ctx, from, to, p, params, w, h) {
    const a0 = deg(num(params, 'angle') - 90)
    const ccw = str(params, 'direction') === 'ccw'
    const sweep = p * Math.PI * 2
    maskBlend(ctx, from, to, w, h, (m) => {
      m.beginPath()
      m.moveTo(w / 2, h / 2)
      m.arc(w / 2, h / 2, Math.hypot(w, h), a0, ccw ? a0 - sweep : a0 + sweep, ccw)
      m.closePath()
      m.fill()
    })
  }
}

const barnDoor: TransitionDef = {
  type: 'barn-door',
  name: 'Barn Door',
  category: 'Wipe',
  defaultDuration: 1,
  params: [
    selectParam('orientation', 'Orientation', 'vertical', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']]),
    selectParam('mode', 'Mode', 'open', [['open', 'Open'], ['close', 'Close']])
  ],
  render(ctx, from, to, p, params, w, h) {
    const vertical = str(params, 'orientation') === 'vertical'
    const open = str(params, 'mode') === 'open'
    maskBlend(ctx, from, to, w, h, (m) => {
      if (vertical) {
        if (open) m.fillRect(w / 2 - (p * w) / 2, 0, p * w, h)
        else {
          m.fillRect(0, 0, (p * w) / 2, h)
          m.fillRect(w - (p * w) / 2, 0, (p * w) / 2, h)
        }
      } else if (open) m.fillRect(0, h / 2 - (p * h) / 2, w, p * h)
      else {
        m.fillRect(0, 0, w, (p * h) / 2)
        m.fillRect(0, h - (p * h) / 2, w, (p * h) / 2)
      }
    })
  }
}

const venetianBlinds: TransitionDef = {
  type: 'venetian-blinds',
  name: 'Venetian Blinds',
  category: 'Wipe',
  defaultDuration: 1,
  params: [
    numberParam('count', 'Blinds', 10, 2, 40, 1),
    selectParam('orientation', 'Orientation', 'horizontal', [['horizontal', 'Horizontal'], ['vertical', 'Vertical']])
  ],
  render(ctx, from, to, p, params, w, h) {
    const n = Math.max(1, Math.round(num(params, 'count')))
    const horizontal = str(params, 'orientation') === 'horizontal'
    maskBlend(ctx, from, to, w, h, (m) => {
      const size = (horizontal ? h : w) / n
      for (let i = 0; i < n; i++) {
        // +0.5px overlap hides hairline seams between strips.
        if (horizontal) m.fillRect(0, i * size, w, size * p + 0.5)
        else m.fillRect(i * size, 0, size * p + 0.5, h)
      }
    })
  }
}

const checkerboard: TransitionDef = {
  type: 'checkerboard',
  name: 'Checkerboard',
  category: 'Wipe',
  defaultDuration: 1,
  params: [numberParam('columns', 'Columns', 8, 2, 32, 1)],
  render(ctx, from, to, p, params, w, h) {
    const cols = Math.max(1, Math.round(num(params, 'columns')))
    const rows = Math.max(1, Math.round((cols * h) / w))
    const cw = w / cols
    const ch = h / rows
    maskBlend(ctx, from, to, w, h, (m) => {
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const local = clamp01((p - ((i + j) % 2) * 0.5) / 0.5)
          if (local > 0) m.fillRect(i * cw, j * ch, cw * local + 0.5, ch + 0.5)
        }
      }
    })
  }
}

const radialBlinds: TransitionDef = {
  type: 'radial-blinds',
  name: 'Radial Blinds',
  category: 'Wipe',
  defaultDuration: 1,
  params: [numberParam('count', 'Blades', 8, 2, 24, 1)],
  render(ctx, from, to, p, params, w, h) {
    const n = Math.max(1, Math.round(num(params, 'count')))
    const step = (Math.PI * 2) / n
    const r = Math.hypot(w, h)
    maskBlend(ctx, from, to, w, h, (m) => {
      m.beginPath()
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + i * step
        m.moveTo(w / 2, h / 2)
        m.arc(w / 2, h / 2, r, a, a + step * p + 0.002)
        m.closePath()
      }
      m.fill()
    })
  }
}

const inkSpread: TransitionDef = {
  type: 'ink-spread',
  name: 'Ink Spread',
  category: 'Wipe',
  defaultDuration: 1.5,
  params: [numberParam('blots', 'Blots', 14, 3, 40, 1), numberParam('seed', 'Seed', 1, 1, 100, 1), numberParam('softness', 'Softness', 12, 0, 60, 1, 'px')],
  render(ctx, from, to, p, params, w, h) {
    const rnd = prng(Math.round(num(params, 'seed')) * 7919)
    const n = Math.max(1, Math.round(num(params, 'blots')))
    const full = Math.hypot(w, h)
    const soft = num(params, 'softness') * unit(h)
    maskBlend(ctx, from, to, w, h, (m) => {
      if (soft > 0.1) m.filter = `blur(${soft.toFixed(2)}px)`
      m.beginPath()
      for (let i = 0; i < n; i++) {
        const x = rnd() * w
        const y = rnd() * h
        const start = rnd() * 0.5
        const k = clamp01((p - start) / (1 - start))
        // Each blot reaches the frame diagonal at p = 1, so the frame is always fully covered at the end.
        const r = Math.pow(k, 1.6) * full
        if (r <= 0) continue
        m.moveTo(x + r, y)
        m.arc(x, y, r, 0, Math.PI * 2)
      }
      m.fill()
    })
  }
}

const randomBlocks: TransitionDef = {
  type: 'random-blocks',
  name: 'Random Blocks',
  category: 'Wipe',
  defaultDuration: 1,
  params: [numberParam('columns', 'Columns', 16, 2, 64, 1), numberParam('seed', 'Seed', 1, 1, 100, 1)],
  render(ctx, from, to, p, params, w, h) {
    const cols = Math.max(1, Math.round(num(params, 'columns')))
    const rows = Math.max(1, Math.round((cols * h) / w))
    const rnd = prng(Math.round(num(params, 'seed')) * 104729)
    const cw = w / cols
    const ch = h / rows
    maskBlend(ctx, from, to, w, h, (m) => {
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const a = clamp01((p - rnd() * 0.85) / 0.15)
          if (a <= 0) continue
          const x0 = Math.round(i * cw)
          const y0 = Math.round(j * ch)
          m.globalAlpha = a
          m.fillRect(x0, y0, Math.round((i + 1) * cw) - x0, Math.round((j + 1) * ch) - y0)
        }
      }
    })
  }
}

export const WIPE_TRANSITIONS: TransitionDef[] = [
  wipe, clockWipe, barnDoor, venetianBlinds, checkerboard, radialBlinds, inkSpread, randomBlocks
]
