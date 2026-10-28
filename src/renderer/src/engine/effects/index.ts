import type { VideoEffect } from '@shared/types'
import { defaultParams } from '@/lib/params'
import { uid } from '@/lib/ids'
import type { VideoEffectDef } from './types'
import { resetContext } from './util'
import { COLOR_EFFECTS } from './color'
import { BLUR_EFFECTS } from './blur'
import { STYLIZE_EFFECTS } from './stylize'
import { KEYING_EFFECTS } from './keying'
import { DISTORT_EFFECTS, TRANSFORM_EFFECTS } from './distort'

export type { VideoEffectDef } from './types'

/**
 * Wraps a definition so every effect: merges missing params with defaults, works in canvas pixel
 * space (identity transform, w×h = canvas size) and never leaks context state.
 */
function guarded(def: VideoEffectDef): VideoEffectDef {
  const defaults = defaultParams(def.params)
  return {
    ...def,
    apply(ctx, canvas, params, t, _w, _h) {
      const w = canvas.width
      const h = canvas.height
      if (w < 1 || h < 1) return
      ctx.save()
      try {
        resetContext(ctx)
        def.apply(ctx, canvas, { ...defaults, ...params }, t, w, h)
      } finally {
        ctx.restore()
      }
    }
  }
}

export const VIDEO_EFFECTS: VideoEffectDef[] = [
  ...COLOR_EFFECTS,
  ...BLUR_EFFECTS,
  ...STYLIZE_EFFECTS,
  ...KEYING_EFFECTS,
  ...DISTORT_EFFECTS,
  ...TRANSFORM_EFFECTS
].map(guarded)

export const VIDEO_EFFECT_CATEGORIES: VideoEffectDef['category'][] = ['Color', 'Blur & Sharpen', 'Stylize', 'Keying', 'Distort', 'Transform']

export function getVideoEffect(type: string): VideoEffectDef | undefined {
  return VIDEO_EFFECTS.find((e) => e.type === type)
}

/** A new effect instance with default params. */
export function createVideoEffect(type: string): VideoEffect {
  const def = getVideoEffect(type)
  return { id: uid(), type, enabled: true, params: def ? defaultParams(def.params) : {} }
}

/** Applies the enabled effects of a stack in order. */
export function applyVideoEffects(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, effects: VideoEffect[], t: number): void {
  for (const fx of effects) {
    if (!fx.enabled) continue
    getVideoEffect(fx.type)?.apply(ctx, canvas, fx.params, t, canvas.width, canvas.height)
  }
}
