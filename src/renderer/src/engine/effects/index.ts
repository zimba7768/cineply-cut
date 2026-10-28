import type { ParamDef } from '@/lib/params'

/**
 * A video effect processes a clip's layer in place. `canvas` holds the clip already drawn with its
 * transform; the effect reads and redraws it (via ctx / getImageData / filters). t = seconds since clip start.
 */
export interface VideoEffectDef {
  type: string
  name: string
  category: 'Color' | 'Blur & Sharpen' | 'Stylize' | 'Keying' | 'Distort' | 'Transform'
  params: ParamDef[]
  apply(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    params: Record<string, number | string | boolean>,
    t: number,
    w: number,
    h: number
  ): void
}

export const VIDEO_EFFECTS: VideoEffectDef[] = []

export function getVideoEffect(type: string): VideoEffectDef | undefined {
  return VIDEO_EFFECTS.find((e) => e.type === type)
}
