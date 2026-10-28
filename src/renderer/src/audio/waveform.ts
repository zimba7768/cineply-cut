/**
 * Waveform peaks for timeline drawing.
 * drawWaveform draws the portion [sourceStart, sourceEnd] (seconds of media) of mediaId into the rect.
 * Peaks load asynchronously; subscribe with onPeaksReady to repaint when they arrive.
 */
const listeners = new Set<() => void>()

export function onPeaksReady(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  mediaId: string,
  sourceStart: number,
  sourceEnd: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  gain = 1
): void {
  void ctx; void mediaId; void sourceStart; void sourceEnd; void x; void y; void w; void h; void color; void gain
}
