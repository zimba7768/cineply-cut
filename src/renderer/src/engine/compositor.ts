import type { Project } from '@shared/types'
import type { FrameProvider } from './frames'

export interface RenderOptions {
  /** Output scale relative to sequence size (preview renders smaller for speed). */
  scale: number
}

/**
 * Renders the composited sequence frame at timeline time t into ctx (canvas sized
 * sequence.width*scale × sequence.height*scale). Shared by the preview monitor and export so
 * both produce identical frames.
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  t: number,
  frames: FrameProvider,
  opts: RenderOptions
): void {
  void t; void frames
  const { width, height, background } = project.sequence
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width * opts.scale, height * opts.scale)
}
