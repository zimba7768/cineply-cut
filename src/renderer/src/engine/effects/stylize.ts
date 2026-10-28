import type { VideoEffectDef } from './types'
import { clamp01, prng, refilter, rgbShift, scratch, timeSeed, withPixels } from './util'
import { bool, boolParam, colorParam, num, numberParam, str, unit } from './params'

/** Darkens towards the edges, only where the layer has content. size/softness are 0..1. */
export function drawVignette(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  amount: number,
  size: number,
  softness: number,
  color: string,
  circular = false
): void {
  if (amount <= 0) return
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.translate(w / 2, h / 2)
  // Normalised space: x spans -1..1; y spans -1..1 (elliptical) or keeps the frame aspect (circular).
  const sy = circular ? w / 2 : h / 2
  ctx.scale(w / 2, sy)
  const r = Math.hypot(1, (h / 2) / sy)
  const r0 = r * size * (1 - softness)
  const r1 = r * Math.max(size + softness * (1 - size), size + 0.001)
  const g = ctx.createRadialGradient(0, 0, Math.max(0, r0), 0, 0, Math.max(r0 + 0.001, r1))
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, color)
  ctx.globalAlpha = clamp01(amount)
  ctx.fillStyle = g
  ctx.fillRect(-1, -r, 2, 2 * r)
  ctx.restore()
}

/** Overlays seeded noise (stable for a given time) onto the layer content. */
export function drawGrain(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  amount: number,
  size: number,
  colored: boolean,
  t: number,
  salt = 0
): void {
  if (amount <= 0) return
  const rnd = prng(timeSeed(t, salt))
  const T = 256
  const tile = scratch('fx-grain-tile', T, T, true)
  const img = tile.ctx.createImageData(T, T)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    // Sum of two uniforms: a cheap, roughly gaussian distribution around mid-grey.
    const n = (rnd() + rnd() - 1) * 255
    if (colored) {
      d[i] = 128 + n
      d[i + 1] = 128 + (rnd() + rnd() - 1) * 255
      d[i + 2] = 128 + (rnd() + rnd() - 1) * 255
    } else {
      d[i] = d[i + 1] = d[i + 2] = 128 + n
    }
    d[i + 3] = 255
  }
  tile.ctx.putImageData(img, 0, 0)

  const layer = scratch('fx-grain', w, h)
  const pattern = layer.ctx.createPattern(tile.canvas, 'repeat')
  if (!pattern) return
  const s = Math.max(0.25, size * unit(h))
  pattern.setTransform(new DOMMatrix().translate(rnd() * T * s, rnd() * T * s).scale(s))
  layer.ctx.fillStyle = pattern
  layer.ctx.fillRect(0, 0, w, h)
  layer.ctx.globalCompositeOperation = 'destination-in'
  layer.ctx.drawImage(canvas, 0, 0)
  ctx.save()
  ctx.globalCompositeOperation = 'overlay'
  ctx.globalAlpha = clamp01(amount)
  ctx.drawImage(layer.canvas, 0, 0)
  ctx.restore()
}

const vignette: VideoEffectDef = {
  type: 'vignette',
  name: 'Vignette',
  category: 'Stylize',
  params: [
    numberParam('amount', 'Amount', 0.6, 0, 1),
    numberParam('size', 'Size', 0.55, 0, 1),
    numberParam('softness', 'Softness', 0.6, 0, 1),
    colorParam('color', 'Color', '#000000'),
    boolParam('circular', 'Circular', false)
  ],
  apply(ctx, _canvas, params, _t, w, h) {
    drawVignette(ctx, w, h, num(params, 'amount'), num(params, 'size'), num(params, 'softness'), str(params, 'color'), bool(params, 'circular'))
  }
}

const filmGrain: VideoEffectDef = {
  type: 'film-grain',
  name: 'Film Grain',
  category: 'Stylize',
  params: [
    numberParam('amount', 'Amount', 0.35, 0, 1),
    numberParam('size', 'Grain size', 1.5, 0.5, 6, 0.1, 'px'),
    boolParam('color', 'Color grain', false)
  ],
  apply(ctx, canvas, params, t, w, h) {
    drawGrain(ctx, canvas, w, h, num(params, 'amount'), num(params, 'size'), bool(params, 'color'), t, 1)
  }
}

const oldFilm: VideoEffectDef = {
  type: 'old-film',
  name: 'Old Film',
  category: 'Stylize',
  params: [
    numberParam('sepia', 'Sepia', 0.7, 0, 1),
    numberParam('grain', 'Grain', 0.5, 0, 1),
    numberParam('flicker', 'Flicker', 0.4, 0, 1),
    numberParam('scratches', 'Scratches', 0.5, 0, 1),
    numberParam('dust', 'Dust', 0.5, 0, 1),
    numberParam('jitter', 'Gate weave', 0.3, 0, 1),
    numberParam('vignette', 'Vignette', 0.6, 0, 1)
  ],
  apply(ctx, canvas, params, t, w, h) {
    const u = unit(h)
    const rnd = prng(timeSeed(t, 77))
    const b = 1 + (rnd() - 0.5) * 0.35 * num(params, 'flicker')
    const dy = (rnd() - 0.5) * 6 * u * num(params, 'jitter')
    refilter(ctx, canvas, `sepia(${num(params, 'sepia')}) brightness(${b.toFixed(3)}) contrast(1.08)`, 0, dy)
    drawVignette(ctx, w, h, num(params, 'vignette'), 0.5, 0.7, '#140b02')
    drawGrain(ctx, canvas, w, h, num(params, 'grain') * 0.7, 1.6, false, t, 78)

    ctx.save()
    ctx.globalCompositeOperation = 'source-atop'
    const scratches = num(params, 'scratches')
    const count = Math.floor(rnd() * 3 * scratches + scratches * 1.5)
    for (let i = 0; i < count; i++) {
      const x = rnd() * w
      const y0 = rnd() < 0.5 ? 0 : rnd() * h * 0.6
      const len = h * (0.3 + rnd() * 0.7)
      ctx.globalAlpha = 0.15 + rnd() * 0.35
      ctx.strokeStyle = rnd() < 0.6 ? '#f4ead2' : '#1a1206'
      ctx.lineWidth = (0.6 + rnd() * 1.4) * u
      ctx.beginPath()
      ctx.moveTo(x, y0)
      ctx.lineTo(x + (rnd() - 0.5) * 6 * u, y0 + len)
      ctx.stroke()
    }
    const dust = Math.floor(rnd() * 10 * num(params, 'dust'))
    for (let i = 0; i < dust; i++) {
      ctx.globalAlpha = 0.3 + rnd() * 0.5
      ctx.fillStyle = rnd() < 0.7 ? '#120b03' : '#f8f0dc'
      ctx.beginPath()
      ctx.ellipse(rnd() * w, rnd() * h, (1 + rnd() * 3) * u, (1 + rnd() * 2.5) * u, rnd() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }
}

const glow: VideoEffectDef = {
  type: 'glow',
  name: 'Glow',
  category: 'Stylize',
  params: [
    numberParam('radius', 'Radius', 24, 0, 200, 1, 'px'),
    numberParam('intensity', 'Intensity', 0.8, 0, 2),
    numberParam('threshold', 'Threshold', 0.5, 0, 1)
  ],
  apply(ctx, canvas, params, _t, w, h) {
    const thr = num(params, 'threshold')
    const r = num(params, 'radius') * unit(h)
    const s = scratch('fx-glow', w, h)
    // Brightness + contrast act as a soft threshold so only the highlights bloom.
    s.ctx.filter = `brightness(${(1 - thr * 0.6).toFixed(3)}) contrast(${(1 + thr * 4).toFixed(3)}) blur(${r.toFixed(2)}px)`
    s.ctx.drawImage(canvas, 0, 0)
    ctx.globalCompositeOperation = 'lighter'
    let intensity = num(params, 'intensity')
    while (intensity > 0.001) {
      ctx.globalAlpha = Math.min(1, intensity)
      ctx.drawImage(s.canvas, 0, 0)
      intensity -= 1
    }
  }
}

const rgbSplit: VideoEffectDef = {
  type: 'rgb-split',
  name: 'RGB Split',
  category: 'Stylize',
  params: [numberParam('amount', 'Amount', 8, 0, 100, 0.5, 'px'), numberParam('angle', 'Angle', 0, -180, 180, 1, '°')],
  apply(ctx, _canvas, params, _t, w, h) {
    const a = num(params, 'amount') * unit(h)
    const ang = (num(params, 'angle') * Math.PI) / 180
    if (a < 0.5) return
    withPixels(ctx, w, h, (d) => rgbShift(d, w, h, Math.cos(ang) * a, Math.sin(ang) * a))
  }
}

const pixelate: VideoEffectDef = {
  type: 'pixelate',
  name: 'Pixelate',
  category: 'Stylize',
  params: [numberParam('size', 'Block size', 16, 1, 200, 1, 'px')],
  apply(ctx, canvas, params, _t, w, h) {
    const block = num(params, 'size') * unit(h)
    if (block < 1.5) return
    const small = scratch('fx-pixel', Math.max(1, w / block), Math.max(1, h / block))
    small.ctx.drawImage(canvas, 0, 0, small.canvas.width, small.canvas.height)
    ctx.clearRect(0, 0, w, h)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(small.canvas, 0, 0, w, h)
  }
}

export const STYLIZE_EFFECTS: VideoEffectDef[] = [vignette, filmGrain, oldFilm, glow, rgbSplit, pixelate]
