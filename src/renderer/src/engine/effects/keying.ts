import type { VideoEffectDef } from './types'
import { parseColor, withPixels } from './util'
import { colorParam, num, numberParam, selectParam, str } from './params'

const KEY_PRESETS: Record<string, [number, number, number]> = {
  green: [0, 177, 64],
  blue: [0, 71, 187]
}

const chromaKey: VideoEffectDef = {
  type: 'chroma-key',
  name: 'Chroma Key',
  category: 'Keying',
  params: [
    selectParam('key', 'Screen', 'green', [['green', 'Green screen'], ['blue', 'Blue screen'], ['custom', 'Custom colour']]),
    colorParam('color', 'Key colour', '#00b140'),
    numberParam('tolerance', 'Tolerance', 0.3, 0, 1),
    numberParam('softness', 'Softness', 0.15, 0, 1),
    numberParam('spill', 'Spill suppression', 0.6, 0, 1)
  ],
  apply(ctx, _canvas, params, _t, w, h) {
    const preset = str(params, 'key')
    const [kr, kg, kb] = KEY_PRESETS[preset] ?? parseColor(str(params, 'color'))
    // Compare in the CbCr (chroma) plane so shading of the screen doesn't matter.
    const kcb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb
    const kcr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb
    const inner = num(params, 'tolerance') * 0.45 * 255
    const outer = inner + num(params, 'softness') * 0.35 * 255 + 1
    const spill = num(params, 'spill')
    // Spill is suppressed on the key's dominant channel.
    const dom = kg >= kr && kg >= kb ? 1 : kb >= kr ? 2 : 0
    const o1 = dom === 0 ? 1 : 0
    const o2 = dom === 2 ? 1 : 2
    withPixels(ctx, w, h, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue
        const r = d[i]
        const g = d[i + 1]
        const b = d[i + 2]
        const cb = -0.168736 * r - 0.331264 * g + 0.5 * b - kcb
        const cr = 0.5 * r - 0.418688 * g - 0.081312 * b - kcr
        const dist = Math.sqrt(cb * cb + cr * cr)
        if (dist <= inner) {
          d[i + 3] = 0
          continue
        }
        if (dist < outer) {
          const a = (dist - inner) / (outer - inner)
          d[i + 3] *= a * a * (3 - 2 * a)
        }
        if (spill > 0) {
          const limit = Math.max(d[i + o1], d[i + o2])
          const v = d[i + dom]
          if (v > limit) d[i + dom] = v - (v - limit) * spill
        }
      }
    })
  }
}

export const KEYING_EFFECTS: VideoEffectDef[] = [chromaKey]
