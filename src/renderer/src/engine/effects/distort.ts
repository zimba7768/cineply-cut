import type { VideoEffectDef } from './types'
import { clamp01, copyOf, withPixels } from './util'
import { num, numberParam, selectParam, str, unit } from './params'

/** Replaces one half of the canvas with the mirror image of the other half. */
function mirrorHalf(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, w: number, h: number, mode: string): void {
  const copy = copyOf(canvas)
  ctx.save()
  ctx.beginPath()
  if (mode === 'left') ctx.rect(w / 2, 0, w / 2, h)
  else if (mode === 'right') ctx.rect(0, 0, w / 2, h)
  else if (mode === 'top') ctx.rect(0, h / 2, w, h / 2)
  else ctx.rect(0, 0, w, h / 2)
  ctx.clip()
  ctx.clearRect(0, 0, w, h)
  if (mode === 'left' || mode === 'right') {
    ctx.translate(w, 0)
    ctx.scale(-1, 1)
  } else {
    ctx.translate(0, h)
    ctx.scale(1, -1)
  }
  ctx.drawImage(copy.canvas, 0, 0)
  ctx.restore()
}

const mirror: VideoEffectDef = {
  type: 'mirror',
  name: 'Mirror',
  category: 'Distort',
  params: [
    selectParam('mode', 'Reflect', 'left', [
      ['left', 'Left onto right'], ['right', 'Right onto left'], ['top', 'Top onto bottom'], ['bottom', 'Bottom onto top'], ['quad', 'Kaleidoscope (4-way)']
    ])
  ],
  apply(ctx, canvas, params, _t, w, h) {
    const mode = str(params, 'mode')
    if (mode === 'quad') {
      mirrorHalf(ctx, canvas, w, h, 'left')
      mirrorHalf(ctx, canvas, w, h, 'top')
    } else {
      mirrorHalf(ctx, canvas, w, h, mode)
    }
  }
}

const wave: VideoEffectDef = {
  type: 'wave',
  name: 'Wave Warp',
  category: 'Distort',
  params: [
    numberParam('amplitude', 'Amplitude', 20, 0, 200, 1, 'px'),
    numberParam('wavelength', 'Wavelength', 0.25, 0.02, 2),
    numberParam('speed', 'Speed', 1, -10, 10, 0.1, 'Hz'),
    selectParam('direction', 'Direction', 'horizontal', [['horizontal', 'Horizontal'], ['vertical', 'Vertical']])
  ],
  apply(ctx, _canvas, params, t, w, h) {
    const amp = num(params, 'amplitude') * unit(h)
    if (amp < 0.25) return
    const horizontal = str(params, 'direction') === 'horizontal'
    const len = Math.max(0.02, num(params, 'wavelength')) * (horizontal ? h : w)
    const phase = t * num(params, 'speed') * Math.PI * 2
    // Shift whole pixel rows (or columns) in one readback; much faster than hundreds of slice blits.
    withPixels(ctx, w, h, (d) => {
      const dst = new Uint32Array(d.buffer, d.byteOffset, w * h)
      const src = dst.slice()
      const extent = horizontal ? h : w
      for (let p = 0; p < extent; p++) {
        const off = Math.round(amp * Math.sin((p / len) * Math.PI * 2 + phase))
        if (horizontal) {
          const row = p * w
          dst.fill(0, row, row + w)
          const from = Math.max(0, -off)
          const to = Math.min(w, w - off)
          if (to > from) dst.set(src.subarray(row + from, row + to), row + from + off)
        } else {
          for (let y = 0; y < h; y++) {
            const sy = y - off
            dst[y * w + p] = sy >= 0 && sy < h ? src[sy * w + p] : 0
          }
        }
      }
    })
  }
}

const ASPECTS: [string, string][] = [
  ['2.39', '2.39:1 Anamorphic'], ['2.35', '2.35:1 Cinemascope'], ['2', '2:1 Univisium'], ['1.85', '1.85:1 Flat'],
  ['1.6667', '5:3'], ['1.3333', '4:3'], ['1', '1:1 Square'], ['0.8', '4:5 Portrait'], ['0.5625', '9:16 Vertical']
]

const letterbox: VideoEffectDef = {
  type: 'letterbox',
  name: 'Letterbox / Cinematic Bars',
  category: 'Transform',
  params: [
    selectParam('aspect', 'Aspect', '2.39', ASPECTS),
    { key: 'color', label: 'Color', type: 'color', default: '#000000' },
    numberParam('opacity', 'Opacity', 1, 0, 1)
  ],
  apply(ctx, _canvas, params, _t, w, h) {
    const target = Number(params.aspect) || 2.39
    ctx.globalAlpha = clamp01(num(params, 'opacity'))
    ctx.fillStyle = str(params, 'color')
    if (target > w / h) {
      const bar = (h - w / target) / 2
      ctx.fillRect(0, 0, w, bar)
      ctx.fillRect(0, h - bar, w, bar)
    } else {
      const bar = (w - h * target) / 2
      ctx.fillRect(0, 0, bar, h)
      ctx.fillRect(w - bar, 0, bar, h)
    }
  }
}

export const DISTORT_EFFECTS: VideoEffectDef[] = [mirror, wave]
export const TRANSFORM_EFFECTS: VideoEffectDef[] = [letterbox]
