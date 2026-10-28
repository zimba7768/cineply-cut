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

export type Layer = CanvasImageSource | null
