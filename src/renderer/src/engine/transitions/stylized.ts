import { clamp01, drawRegion, prng, rgbShift, scratch, smoothstep, withPixels } from '@/engine/effects/util'
import type { Layer, TransitionDef } from './types'
import { colorParam, mix, num, numberParam, unit } from './helpers'

const glitch: TransitionDef = {
  type: 'glitch',
  name: 'Glitch',
  category: 'Stylized',
  defaultDuration: 0.6,
  params: [numberParam('intensity', 'Intensity', 1, 0, 2), numberParam('seed', 'Seed', 1, 1, 100, 1)],
  render(ctx, from, to, p, params, w, h) {
    const g = Math.sqrt(Math.sin(Math.PI * p)) * num(params, 'intensity')
    // The pattern changes in ~40 steps over the transition, so a given p always looks the same.
    const rnd = prng(Math.floor(p * 40) * 7349 + Math.round(num(params, 'seed')) * 104723)
    const pick = (): Layer => (rnd() < p ? to : from)
    let base = p < 0.5 ? from : to
    if (g > 0.4 && rnd() < 0.3) base = base === from ? to : from
    if (base) ctx.drawImage(base, 0, 0, w, h)

    const slices = Math.round((4 + rnd() * 10) * Math.min(1, g * 1.5))
    for (let i = 0; i < slices; i++) {
      const y = rnd() * h
      const sh = h * (0.01 + rnd() * 0.12)
      const off = (rnd() - 0.5) * w * 0.18 * g
      const src = pick()
      if (!src) {
        ctx.clearRect(0, y, w, sh)
        continue
      }
      drawRegion(ctx, src, w, h, 0, y, w, sh, off, y, w, sh)
    }
    const shift = Math.round(g * w * 0.012)
    if (shift >= 1) {
      const W = ctx.canvas.width
      const H = ctx.canvas.height
      withPixels(ctx, W, H, (d) => rgbShift(d, W, H, (shift * W) / w, ((rnd() - 0.5) * shift * H) / h))
    }
  }
}

const lightLeak: TransitionDef = {
  type: 'light-leak',
  name: 'Light Leak',
  category: 'Stylized',
  defaultDuration: 1.2,
  params: [colorParam('color', 'Color', '#ff8a3d'), numberParam('intensity', 'Intensity', 1, 0, 2)],
  render(ctx, from, to, p, params, w, h) {
    mix(ctx, from, to, smoothstep(0.3, 0.7, p), w, h)
    const a = Math.sin(Math.PI * p) * num(params, 'intensity')
    if (a <= 0.001) return
    ctx.globalCompositeOperation = 'screen'
    const blob = (cx: number, cy: number, r: number, color: string, alpha: number): void => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
      g.addColorStop(0, color)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalAlpha = clamp01(alpha)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }
    const color = String(params.color)
    blob(w * (-0.2 + 1.3 * p), h * 0.35, w * 0.75, color, a)
    blob(w * (1.1 - 1.0 * p), h * 0.8, w * 0.45, '#ffe2a8', a * 0.8)
    blob(w * 0.5, h * 0.5, w * 0.9, '#ffffff', a * 0.35 * smoothstep(0.3, 0.5, p) * (1 - smoothstep(0.5, 0.7, p)))
  }
}

const pixelate: TransitionDef = {
  type: 'pixelate',
  name: 'Pixelate',
  category: 'Stylized',
  defaultDuration: 1,
  params: [numberParam('size', 'Max block', 48, 4, 200, 1, 'px')],
  render(ctx, from, to, p, params, w, h) {
    const block = Math.max(1, 1 + (num(params, 'size') * unit(h) - 1) * Math.sin(Math.PI * p))
    const m = smoothstep(0.4, 0.6, p)
    if (block < 1.5) {
      mix(ctx, from, to, m, w, h)
      return
    }
    const sw = Math.max(1, Math.round(w / block))
    const sh = Math.max(1, Math.round(h / block))
    const small = scratch('tr-pixel', sw, sh)
    mix(small.ctx, from, to, m, sw, sh)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(small.canvas, 0, 0, w, h)
  }
}

const ripple: TransitionDef = {
  type: 'ripple',
  name: 'Ripple',
  category: 'Stylized',
  defaultDuration: 1.2,
  params: [numberParam('amplitude', 'Amplitude', 40, 0, 200, 1, 'px'), numberParam('waves', 'Waves', 5, 1, 20, 0.5)],
  render(ctx, from, to, p, params, w, h) {
    const amp = num(params, 'amplitude') * unit(h) * Math.sin(Math.PI * p)
    const waves = num(params, 'waves')
    const m = smoothstep(0.25, 0.75, p)
    const band = Math.max(2, Math.round(h / 135))
    const drawWavy = (img: Layer, alpha: number): void => {
      if (!img || alpha <= 0) return
      ctx.globalAlpha = alpha
      for (let y = 0; y < h; y += band) {
        const bh = Math.min(band, h - y)
        const off = amp * Math.sin(((y + bh / 2) / h) * waves * Math.PI * 2 + p * Math.PI * 6)
        drawRegion(ctx, img, w, h, 0, y, w, bh, off, y, w, bh)
      }
      ctx.globalAlpha = 1
    }
    drawWavy(from, 1 - m)
    ctx.globalCompositeOperation = 'lighter'
    drawWavy(to, m)
    ctx.globalCompositeOperation = 'source-over'
  }
}

export const STYLIZED_TRANSITIONS: TransitionDef[] = [glitch, lightLeak, pixelate, ripple]
