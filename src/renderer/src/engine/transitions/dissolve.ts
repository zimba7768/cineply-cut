import { clamp01, scratch, smoothstep } from '@/engine/effects/util'
import type { TransitionDef } from './types'
import { boolParam, colorParam, full, maskBlend, mix, num, numberParam, str, unit } from './helpers'

const crossDissolve: TransitionDef = {
  type: 'cross-dissolve',
  name: 'Cross Dissolve',
  category: 'Dissolve',
  defaultDuration: 1,
  params: [],
  render(ctx, from, to, p, _params, w, h) {
    mix(ctx, from, to, p, w, h)
  }
}

function dip(type: string, name: string, color: string): TransitionDef {
  return {
    type,
    name,
    category: 'Dissolve',
    defaultDuration: 1,
    params: [colorParam('color', 'Color', color), numberParam('hold', 'Hold', 0.1, 0, 0.8)],
    render(ctx, from, to, p, params, w, h) {
      const half = (1 - num(params, 'hold')) / 2
      let a = 1
      if (p < half) {
        full(ctx, from, w, h)
        a = p / half
      } else if (p > 1 - half) {
        full(ctx, to, w, h)
        a = (1 - p) / half
      }
      ctx.globalAlpha = smoothstep(0, 1, a)
      ctx.fillStyle = str(params, 'color')
      ctx.fillRect(0, 0, w, h)
    }
  }
}

const additiveDissolve: TransitionDef = {
  type: 'additive-dissolve',
  name: 'Additive Dissolve',
  category: 'Dissolve',
  defaultDuration: 1,
  params: [],
  render(ctx, from, to, p, _params, w, h) {
    full(ctx, from, w, h, Math.min(1, 2 * (1 - p)))
    ctx.globalCompositeOperation = 'lighter'
    full(ctx, to, w, h, Math.min(1, 2 * p))
  }
}

const filmDissolve: TransitionDef = {
  type: 'film-dissolve',
  name: 'Film Dissolve',
  category: 'Dissolve',
  defaultDuration: 1,
  params: [numberParam('bloom', 'Bloom', 0.5, 0, 1)],
  render(ctx, from, to, p, params, w, h) {
    // A gamma-style blend: the incoming shot rises faster than the outgoing one falls, so the
    // midpoint blooms slightly instead of dipping, like an optical dissolve.
    const bloom = num(params, 'bloom')
    const m = smoothstep(0, 1, p)
    const bump = Math.sin(Math.PI * p) * bloom
    ctx.filter = `brightness(${1 + 0.12 * bump}) saturate(${1 - 0.2 * bump})`
    full(ctx, from, w, h, Math.pow(1 - m, 1 + 0.5 * bloom))
    ctx.globalCompositeOperation = 'lighter'
    full(ctx, to, w, h, Math.pow(m, 1 - 0.35 * bloom))
  }
}

const blurDissolve: TransitionDef = {
  type: 'blur-dissolve',
  name: 'Blur Dissolve',
  category: 'Dissolve',
  defaultDuration: 1,
  params: [numberParam('amount', 'Blur', 30, 0, 120, 1, 'px')],
  render(ctx, from, to, p, params, w, h) {
    const b = num(params, 'amount') * unit(h) * Math.sin(Math.PI * p)
    if (b > 0.1) ctx.filter = `blur(${b.toFixed(2)}px)`
    mix(ctx, from, to, smoothstep(0, 1, p), w, h)
  }
}

const lumaFade: TransitionDef = {
  type: 'luma-fade',
  name: 'Luma Fade',
  category: 'Dissolve',
  defaultDuration: 1.5,
  params: [numberParam('softness', 'Softness', 0.3, 0.02, 1), boolParam('invert', 'Darks first', false)],
  render(ctx, from, to, p, params, w, h) {
    // Reveal `to` brightest areas first (or `from` disappears darkest first when there is no `to`).
    const keySource = to ?? from
    if (!keySource) return
    const soft = num(params, 'softness')
    const invert = Boolean(params.invert) !== !to
    const sw = Math.min(w, 960)
    const sh = Math.max(1, Math.round((h * sw) / w))
    const m = scratch('tr-luma', sw, sh, true)
    m.ctx.drawImage(keySource, 0, 0, sw, sh)
    const img = m.ctx.getImageData(0, 0, m.canvas.width, m.canvas.height)
    const d = img.data
    const lead = p * (1 + soft)
    const lut = new Uint8ClampedArray(256)
    for (let l = 0; l < 256; l++) {
      const v = invert ? 1 - l / 255 : l / 255
      lut[l] = Math.round(clamp01((lead - (1 - v)) / soft) * 255)
    }
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8
      d[i] = d[i + 1] = d[i + 2] = 255
      d[i + 3] = lut[l]
    }
    m.ctx.putImageData(img, 0, 0)
    maskBlend(ctx, from, to, w, h, (mc) => mc.drawImage(m.canvas, 0, 0, w, h))
  }
}

export const DISSOLVE_TRANSITIONS: TransitionDef[] = [
  crossDissolve,
  dip('dip-to-black', 'Dip to Black', '#000000'),
  dip('dip-to-white', 'Dip to White', '#ffffff'),
  additiveDissolve,
  filmDissolve,
  blurDissolve,
  lumaFade
]
