import type { VideoEffectDef } from './types'
import { clamp, parseColor, refilter, withPixels } from './util'
import { colorParam, num, numberParam } from './params'

const blackWhite: VideoEffectDef = {
  type: 'black-white',
  name: 'Black & White',
  category: 'Color',
  params: [numberParam('amount', 'Amount', 1, 0, 1)],
  apply(ctx, canvas, params) {
    refilter(ctx, canvas, `grayscale(${num(params, 'amount')})`)
  }
}

const sepia: VideoEffectDef = {
  type: 'sepia',
  name: 'Sepia',
  category: 'Color',
  params: [numberParam('amount', 'Amount', 0.8, 0, 1)],
  apply(ctx, canvas, params) {
    refilter(ctx, canvas, `sepia(${num(params, 'amount')})`)
  }
}

const invert: VideoEffectDef = {
  type: 'invert',
  name: 'Invert',
  category: 'Color',
  params: [numberParam('amount', 'Amount', 1, 0, 1)],
  apply(ctx, canvas, params) {
    refilter(ctx, canvas, `invert(${num(params, 'amount')})`)
  }
}

const tint: VideoEffectDef = {
  type: 'tint',
  name: 'Tint',
  category: 'Color',
  params: [
    colorParam('black', 'Map black to', '#1a1030'),
    colorParam('white', 'Map white to', '#ffd9a0'),
    numberParam('amount', 'Amount', 1, 0, 1)
  ],
  apply(ctx, _canvas, params, _t, w, h) {
    const [br, bg, bb] = parseColor(String(params.black))
    const [wr, wg, wb] = parseColor(String(params.white))
    const a = num(params, 'amount')
    const lr = new Float32Array(256)
    const lg = new Float32Array(256)
    const lb = new Float32Array(256)
    for (let l = 0; l < 256; l++) {
      const x = l / 255
      lr[l] = br + (wr - br) * x
      lg[l] = bg + (wg - bg) * x
      lb[l] = bb + (wb - bb) * x
    }
    withPixels(ctx, w, h, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue
        const l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8
        d[i] += (lr[l] - d[i]) * a
        d[i + 1] += (lg[l] - d[i + 1]) * a
        d[i + 2] += (lb[l] - d[i + 2]) * a
      }
    })
  }
}

const posterize: VideoEffectDef = {
  type: 'posterize',
  name: 'Posterize',
  category: 'Color',
  params: [numberParam('levels', 'Levels', 5, 2, 32, 1)],
  apply(ctx, _canvas, params, _t, w, h) {
    const n = Math.max(2, Math.round(num(params, 'levels')))
    const lut = new Uint8ClampedArray(256)
    for (let v = 0; v < 256; v++) lut[v] = Math.round(Math.round((v / 255) * (n - 1)) * (255 / (n - 1)))
    withPixels(ctx, w, h, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        d[i] = lut[d[i]]
        d[i + 1] = lut[d[i + 1]]
        d[i + 2] = lut[d[i + 2]]
      }
    })
  }
}

const RANGES = [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']] as const
const CHANNELS = [['R', 'red'], ['G', 'green'], ['B', 'blue']] as const

const colorBalance: VideoEffectDef = {
  type: 'color-balance',
  name: 'Color Balance',
  category: 'Color',
  params: RANGES.flatMap(([key, label]) =>
    CHANNELS.map(([c, cl]) => numberParam(`${key}${c}`, `${label} ${cl}`, 0, -1, 1))
  ),
  apply(ctx, _canvas, params, _t, w, h) {
    // Offsets per luminance level: shadows weigh in the darks, highlights in the brights, midtones between.
    const offsets = [new Float32Array(256), new Float32Array(256), new Float32Array(256)]
    let any = false
    for (let l = 0; l < 256; l++) {
      const x = l / 255
      const ws = (1 - x) * (1 - x)
      const wh = x * x
      const wm = 1 - ws - wh
      CHANNELS.forEach(([c], ci) => {
        const v = (ws * num(params, `shadows${c}`) + wm * num(params, `midtones${c}`) + wh * num(params, `highlights${c}`)) * 80
        offsets[ci][l] = v
        if (v !== 0) any = true
      })
    }
    if (!any) return
    const [or, og, ob] = offsets
    withPixels(ctx, w, h, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const l = clamp((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8, 0, 255)
        d[i] += or[l]
        d[i + 1] += og[l]
        d[i + 2] += ob[l]
      }
    })
  }
}

export const COLOR_EFFECTS: VideoEffectDef[] = [blackWhite, sepia, tint, invert, posterize, colorBalance]
