import type { TransitionDef } from './types'
import { maskBlend, num, numberParam, rampStops, selectParam, str, wipeRamp } from './helpers'

const centerParams = [numberParam('cx', 'Center X', 0.5, 0, 1), numberParam('cy', 'Center Y', 0.5, 0, 1)]
const modeParam = selectParam('mode', 'Mode', 'open', [['open', 'Open (grow)'], ['close', 'Close (shrink)']])

const irisRound: TransitionDef = {
  type: 'iris-round',
  name: 'Iris Round',
  category: 'Iris',
  defaultDuration: 1,
  params: [...centerParams, modeParam, numberParam('softness', 'Softness', 0.05, 0, 0.5)],
  render(ctx, from, to, p, params, w, h) {
    const cx = num(params, 'cx') * w
    const cy = num(params, 'cy') * h
    const r = Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy))
    const { f, breaks } = wipeRamp(p, num(params, 'softness'))
    const close = str(params, 'mode') === 'close'
    maskBlend(ctx, from, to, w, h, (m) => {
      // Open: covered from the centre outwards (u = distance / r). Close: from the edges inwards.
      const g = m.createRadialGradient(cx, cy, 0, cx, cy, r)
      m.fillStyle = close ? rampStops(g, (u) => f(1 - u), breaks.map((b) => 1 - b)) : rampStops(g, f, breaks)
      m.fillRect(0, 0, w, h)
    })
  }
}

/** Iris whose shape is drawn by `shape(m, cx, cy, k)` at scale k (k = 1 just covers the frame). */
function irisShape(
  type: string,
  name: string,
  coverScale: (cx: number, cy: number, w: number, h: number) => number,
  shape: (m: CanvasRenderingContext2D, cx: number, cy: number, k: number, w: number, h: number) => void
): TransitionDef {
  return {
    type,
    name,
    category: 'Iris',
    defaultDuration: 1,
    params: [...centerParams, modeParam],
    render(ctx, from, to, p, params, w, h) {
      const cx = num(params, 'cx') * w
      const cy = num(params, 'cy') * h
      const cover = coverScale(cx, cy, w, h)
      const close = str(params, 'mode') === 'close'
      maskBlend(ctx, from, to, w, h, (m) => {
        m.beginPath()
        if (close) m.rect(0, 0, w, h)
        shape(m, cx, cy, (close ? 1 - p : p) * cover, w, h)
        m.fill(close ? 'evenodd' : 'nonzero')
      })
    }
  }
}

const irisBox = irisShape(
  'iris-box',
  'Iris Box',
  (cx, cy, w, h) => Math.max(Math.max(cx, w - cx) / (w / 2), Math.max(cy, h - cy) / (h / 2)),
  (m, cx, cy, k, w, h) => m.rect(cx - (k * w) / 2, cy - (k * h) / 2, k * w, k * h)
)

const irisDiamond = irisShape(
  'iris-diamond',
  'Iris Diamond',
  (cx, cy, w, h) => (Math.max(cx, w - cx) / w + Math.max(cy, h - cy) / h) * 1.001,
  (m, cx, cy, k, w, h) => {
    const a = k * w
    const b = k * h
    m.moveTo(cx, cy - b)
    m.lineTo(cx + a, cy)
    m.lineTo(cx, cy + b)
    m.lineTo(cx - a, cy)
    m.closePath()
  }
)

export const IRIS_TRANSITIONS: TransitionDef[] = [irisRound, irisBox, irisDiamond]
