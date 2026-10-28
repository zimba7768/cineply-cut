import type { TransitionSpec } from '@shared/types'
import { defaultParams } from '@/lib/params'
import { clamp01 } from '@/engine/effects/util'
import type { TransitionDef } from './types'
import { DISSOLVE_TRANSITIONS } from './dissolve'
import { WIPE_TRANSITIONS } from './wipe'
import { IRIS_TRANSITIONS } from './iris'
import { SLIDE_TRANSITIONS } from './slide'
import { ZOOM_TRANSITIONS } from './zoom'
import { PERSPECTIVE_TRANSITIONS } from './perspective'
import { STYLIZED_TRANSITIONS } from './stylized'

export type { TransitionDef } from './types'

/**
 * Wraps a definition so every transition: merges missing params with their defaults, never leaks
 * context state, and shows exactly `from` at p ≤ 0 and exactly `to` at p ≥ 1.
 */
function guarded(def: TransitionDef): TransitionDef {
  const defaults = defaultParams(def.params)
  return {
    ...def,
    render(ctx, from, to, p, params, w, h) {
      const q = clamp01(Number.isFinite(p) ? p : 0)
      ctx.save()
      try {
        if (q <= 0) {
          if (from) ctx.drawImage(from, 0, 0, w, h)
        } else if (q >= 1) {
          if (to) ctx.drawImage(to, 0, 0, w, h)
        } else {
          def.render(ctx, from, to, q, { ...defaults, ...params }, w, h)
        }
      } finally {
        ctx.restore()
      }
    }
  }
}

/** All transitions, in browser display order. */
export const TRANSITIONS: TransitionDef[] = [
  ...DISSOLVE_TRANSITIONS,
  ...WIPE_TRANSITIONS,
  ...IRIS_TRANSITIONS,
  ...SLIDE_TRANSITIONS,
  ...ZOOM_TRANSITIONS,
  ...PERSPECTIVE_TRANSITIONS,
  ...STYLIZED_TRANSITIONS
].map(guarded)

export const DEFAULT_TRANSITION = 'cross-dissolve'

export const TRANSITION_CATEGORIES: TransitionDef['category'][] = ['Dissolve', 'Wipe', 'Iris', 'Slide', 'Zoom', '3D', 'Stylized']

export function getTransition(type: string): TransitionDef {
  return TRANSITIONS.find((t) => t.type === type) ?? TRANSITIONS[0]
}

/** A new TransitionSpec with the transition's default duration and params. */
export function createTransitionSpec(type: string, duration?: number): TransitionSpec {
  const def = getTransition(type)
  return { type: def.type, duration: duration ?? def.defaultDuration, params: defaultParams(def.params) }
}

export { drawTransitionPreview } from './preview'
