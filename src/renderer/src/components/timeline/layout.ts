import { clipEnd, type Clip, type Id, type Project, type Track } from '@shared/types'

export const HEADER_W = 196
export const RULER_H = 30
export const DIVIDER_H = 8
export const CLIP_HEAD_H = 16
export const SNAP_PX = 8
export const MIN_TRACK_H = 30
export const MAX_TRACK_H = 220

export interface Row {
  track: Track
  top: number
  height: number
}

export interface TrackLayout {
  rows: Row[]
  dividerTop: number
  height: number
}

/** Vertical layout: video tracks (top-most first), the video/audio divider, then the audio tracks. */
export function computeLayout(tracks: Track[]): TrackLayout {
  const rows: Row[] = []
  let y = 0
  let dividerTop = 0
  let dividerPlaced = false
  for (const track of tracks) {
    if (track.kind === 'audio' && !dividerPlaced) {
      dividerTop = y
      y += DIVIDER_H
      dividerPlaced = true
    }
    rows.push({ track, top: y, height: track.height })
    y += track.height
  }
  if (!dividerPlaced) {
    dividerTop = y
    y += DIVIDER_H
  }
  return { rows, dividerTop, height: y }
}

export function rowAt(layout: TrackLayout, y: number): Row | undefined {
  return layout.rows.find((r) => y >= r.top && y < r.top + r.height)
}

export function rowOf(layout: TrackLayout, trackId: Id): Row | undefined {
  return layout.rows.find((r) => r.track.id === trackId)
}

/** Times the playhead and dragged edges snap to. */
export function snapTargets(p: Project, playhead: number, exclude: Set<Id>, inOut: (number | null)[] = []): number[] {
  const out = [0, playhead]
  for (const m of p.markers) out.push(m.time)
  for (const t of inOut) if (t !== null) out.push(t)
  for (const c of p.clips) {
    if (exclude.has(c.id)) continue
    out.push(c.start, clipEnd(c))
  }
  return out
}

/**
 * Finds the smallest shift that puts one of `edges` on a target within `threshold` seconds.
 * Returns the shift and the target it snapped to, or null.
 */
export function bestSnap(edges: number[], targets: number[], threshold: number): { shift: number; at: number } | null {
  let best: { shift: number; at: number } | null = null
  for (const e of edges) {
    for (const t of targets) {
      const d = t - e
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.shift))) best = { shift: d, at: t }
    }
  }
  return best
}

export function clipsByTrack(clips: Clip[]): Map<Id, Clip[]> {
  const map = new Map<Id, Clip[]>()
  for (const c of clips) {
    const list = map.get(c.trackId)
    if (list) list.push(c)
    else map.set(c.trackId, [c])
  }
  for (const list of map.values()) list.sort((a, b) => a.start - b.start)
  return map
}

/** Ruler tick spacing for a zoom level: a labelled major step and the number of minor subdivisions. */
export function rulerSteps(zoom: number, fps: number): { major: number; minorPerMajor: number } {
  const frame = 1 / fps
  const ladder = [frame, 2 * frame, 5 * frame, 10 * frame, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]
    .filter((v, i, a) => i === 0 || v > a[i - 1])
  const major = ladder.find((s) => s * zoom >= 84) ?? ladder[ladder.length - 1]
  const majorFrames = Math.round(major * fps)
  for (const n of [10, 5, 4, 2]) {
    const minor = major / n
    if (minor * zoom < 7) continue
    if (major < 1 && (majorFrames % n !== 0)) continue
    return { major, minorPerMajor: n }
  }
  return { major, minorPerMajor: 1 }
}
