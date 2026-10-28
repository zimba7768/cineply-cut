/** Formats seconds as HH:MM:SS:FF timecode. */
export function timecode(seconds: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(seconds * fps))
  const f = totalFrames % Math.round(fps)
  const s = Math.floor(totalFrames / Math.round(fps))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`
}

/** Short human duration, e.g. 1:05.2 */
export function shortTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export const snapToFrame = (t: number, fps: number): number => Math.round(t * fps) / fps
