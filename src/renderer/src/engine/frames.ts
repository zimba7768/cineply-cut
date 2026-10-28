import type { Clip, MediaItem } from '@shared/types'

/**
 * Supplies decoded frames to the compositor. Preview uses <video>/<img> elements; export uses
 * frame-accurate decoding. Returns null when the frame isn't available yet (compositor skips it).
 */
export interface FrameProvider {
  getFrame(clip: Clip, media: MediaItem, sourceTime: number): CanvasImageSource | null
  /** Image for a media item used as a title background (stills: the image; videos: first frame). */
  getStill(media: MediaItem): CanvasImageSource | null
}
