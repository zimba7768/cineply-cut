import { createCanvas } from '@/engine/effects/util'
import type { TransitionDef } from './types'

/** Two colourful test cards (A and B) used for transition thumbnails, cached per size. */
const cards = new Map<string, [HTMLCanvasElement, HTMLCanvasElement]>()

function card(w: number, h: number, label: string, c1: string, c2: string): HTMLCanvasElement {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, c1)
  g.addColorStop(1, c2)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(255,255,255,0.18)'
  for (let i = 0; i < 6; i++) ctx.fillRect((i * w) / 6, 0, 1, h)
  ctx.beginPath()
  ctx.arc(w * 0.78, h * 0.3, h * 0.16, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = `700 ${Math.round(h * 0.55)}px Segoe UI, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, w / 2, h / 2 + h * 0.03)
  return c
}

export function testCards(w: number, h: number): [HTMLCanvasElement, HTMLCanvasElement] {
  const key = `${w}x${h}`
  let pair = cards.get(key)
  if (!pair) {
    pair = [card(w, h, 'A', '#2f6fe0', '#1b2f6b'), card(w, h, 'B', '#ff9f43', '#c2364b')]
    cards.set(key, pair)
  }
  return pair
}

/** Renders `def` between the A and B test cards at progress p into ctx (w×h). */
export function drawTransitionPreview(
  ctx: CanvasRenderingContext2D,
  def: TransitionDef,
  p: number,
  params: Record<string, number | string | boolean>,
  w: number,
  h: number
): void {
  const [a, b] = testCards(w, h)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#0b0c0f'
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
  // Transitions draw onto a cleared layer, so render on a separate surface and composite over the backdrop.
  const layer = layerFor(w, h)
  const lctx = layer.getContext('2d')!
  lctx.setTransform(1, 0, 0, 1, 0, 0)
  lctx.clearRect(0, 0, w, h)
  def.render(lctx, a, b, p, params, w, h)
  ctx.drawImage(layer, 0, 0)
}

const layers = new Map<string, HTMLCanvasElement>()
function layerFor(w: number, h: number): HTMLCanvasElement {
  const key = `${w}x${h}`
  let c = layers.get(key)
  if (!c) {
    c = createCanvas(w, h)
    layers.set(key, c)
  }
  return c
}
