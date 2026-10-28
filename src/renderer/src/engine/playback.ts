import type { FrameProvider } from './frames'

/**
 * Preview playback engine: owns the pool of <video>/<img> elements used as the preview
 * FrameProvider, runs the requestAnimationFrame loop while playing (following audioEngine.clockTime()),
 * and handles seeking/scrubbing. The Monitor component attaches its canvas with attachCanvas().
 */
export interface PreviewEngine {
  frames: FrameProvider
  attachCanvas(canvas: HTMLCanvasElement | null): void
  play(): void
  pause(): void
  togglePlay(): void
  /** Forces a redraw of the current frame (after edits). */
  invalidate(): void
}

export const preview: PreviewEngine = {
  frames: { getFrame: () => null, getStill: () => null },
  attachCanvas() {},
  play() {},
  pause() {},
  togglePlay() {},
  invalidate() {}
}
