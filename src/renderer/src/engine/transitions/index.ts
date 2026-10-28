import type { ParamDef } from '@/lib/params'

/**
 * A transition draws the blend of two layers into ctx (already cleared, sized w×h).
 * `from` / `to` are fully rendered layer canvases (transform + effects already applied) or null for
 * "nothing" (transparent; the tracks below show through). p goes 0 → 1 across the transition.
 */
export interface TransitionDef {
  type: string
  name: string
  category: 'Dissolve' | 'Wipe' | 'Slide' | 'Zoom' | 'Iris' | 'Stylized' | '3D'
  defaultDuration: number
  params: ParamDef[]
  render(
    ctx: CanvasRenderingContext2D,
    from: CanvasImageSource | null,
    to: CanvasImageSource | null,
    p: number,
    params: Record<string, number | string | boolean>,
    w: number,
    h: number
  ): void
}

const crossDissolve: TransitionDef = {
  type: 'cross-dissolve',
  name: 'Cross Dissolve',
  category: 'Dissolve',
  defaultDuration: 1,
  params: [],
  render(ctx, from, to, p, _params, w, h) {
    if (from) {
      ctx.globalAlpha = 1 - p
      ctx.drawImage(from, 0, 0, w, h)
    }
    if (to) {
      ctx.globalAlpha = p
      ctx.drawImage(to, 0, 0, w, h)
    }
    ctx.globalAlpha = 1
  }
}

/** All transitions, in browser display order. */
export const TRANSITIONS: TransitionDef[] = [crossDissolve]

export function getTransition(type: string): TransitionDef {
  return TRANSITIONS.find((t) => t.type === type) ?? crossDissolve
}

export const DEFAULT_TRANSITION = 'cross-dissolve'
