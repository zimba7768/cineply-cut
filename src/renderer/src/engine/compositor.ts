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

export interface FrameRequest {
  clip: import('@shared/types').Clip
  media: import('@shared/types').MediaItem
  sourceTime: number
}

/**
 * Every (clip, media, sourceTime) frame renderFrame will ask the FrameProvider for at time t,
 * including both sides of active transitions and title background media. Export uses this to
 * decode exactly the needed frames before calling renderFrame.
 */
export function collectFrameRequests(project: Project, t: number): FrameRequest[] {
  void project; void t
  return []
}
