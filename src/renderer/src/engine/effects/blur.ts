import type { VideoEffectDef } from './types'
import { averageSamples, copyOf, gaussianOffsets, refilter, withPixels } from './util'
import { num, numberParam, selectParam, str, unit } from './params'

const gaussianBlur: VideoEffectDef = {
  type: 'gaussian-blur',
  name: 'Gaussian Blur',
  category: 'Blur & Sharpen',
  params: [
    numberParam('amount', 'Blurriness', 10, 0, 200, 0.5, 'px'),
    selectParam('direction', 'Dimensions', 'both', [['both', 'Horizontal & vertical'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical']])
  ],
  apply(ctx, canvas, params, _t, w, h) {
    const sigma = num(params, 'amount') * unit(h)
    if (sigma < 0.1) return
    const dir = str(params, 'direction')
    if (dir === 'both') {
      refilter(ctx, canvas, `blur(${sigma.toFixed(2)}px)`)
      return
    }
    // One-dimensional blur: average copies shifted at gaussian quantiles along the axis.
    const n = Math.min(32, Math.max(4, Math.ceil(sigma * 1.5)))
    const offsets = gaussianOffsets(n)
    const copy = copyOf(canvas)
    ctx.clearRect(0, 0, w, h)
    averageSamples(ctx, w, h, n, (s, i) => {
      const o = offsets[i] * sigma
      s.drawImage(copy.canvas, dir === 'horizontal' ? o : 0, dir === 'vertical' ? o : 0)
    }, 'fx-blur')
  }
}

const sharpen: VideoEffectDef = {
  type: 'sharpen',
  name: 'Sharpen',
  category: 'Blur & Sharpen',
  params: [numberParam('amount', 'Amount', 0.6, 0, 3)],
  apply(ctx, _canvas, params, _t, w, h) {
    const a = num(params, 'amount')
    if (a <= 0 || w < 3 || h < 3) return
    withPixels(ctx, w, h, (d) => {
      const src = new Uint8ClampedArray(d)
      const center = 1 + 4 * a
      const stride = w * 4
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * stride + x * 4
          if (src[i + 3] === 0) continue
          for (let c = 0; c < 3; c++) {
            const k = i + c
            d[k] = src[k] * center - a * (src[k - 4] + src[k + 4] + src[k - stride] + src[k + stride])
          }
        }
      }
    })
  }
}

export const BLUR_EFFECTS: VideoEffectDef[] = [gaussianBlur, sharpen]
