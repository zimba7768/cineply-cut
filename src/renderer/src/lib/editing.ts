import type { Draft } from 'immer'
import type { Clip, Id, TrackKind } from '@shared/types'
import { useProject } from '@/store/project'

/**
 * Editing commands shared by the timeline, panels, and shortcuts. Each command is one undo step.
 * (Owner: timeline/editing. Other modules call these rather than re-implementing edits.)
 */

/** Mutates a single clip as one undo step. Pass coalesce for continuous edits (slider drags). */
export function updateClip(clipId: Id, label: string, fn: (c: Draft<Clip>) => void, coalesce?: string): void {
  useProject.getState().mutate(label, (p) => {
    const c = p.clips.find((x) => x.id === clipId)
    if (c) fn(c)
  }, coalesce ? { coalesce } : undefined)
}

/**
 * Places a media item on the timeline. Video files with sound create a video clip plus a linked audio
 * clip. Defaults: start = playhead, video track = V1 (or the first track with room), audio track = A1.
 * Returns the created clip ids.
 */
export function addMediaClip(mediaId: Id, opts?: { start?: number; trackId?: Id }): Id[] {
  void mediaId; void opts
  return []
}

/** Adds a title clip from a template (engine/titles) at `start` (default playhead) on the top-most free video track. */
export function addTitleClip(templateId: string, opts?: { start?: number; trackId?: Id }): Id | null {
  void templateId; void opts
  return null
}

/** Splits the given clips (default: selected clips, or all unlocked clips under the playhead) at time t. */
export function splitAt(t: number, clipIds?: Id[]): void {
  void t; void clipIds
}

/** Deletes clips (and their linked partners). ripple = close the gap. */
export function deleteClips(clipIds: Id[], ripple: boolean): void {
  void clipIds; void ripple
}

/** Sets or clears (type = null) the transition on a clip edge. Duration defaults to the transition's default. */
export function setTransition(clipId: Id, edge: 'in' | 'out', type: string | null, duration?: number): void {
  void clipId; void edge; void type; void duration
}

/** Appends a video effect (engine/effects registry) with default params to a clip. */
export function addVideoEffect(clipId: Id, type: string): void {
  void clipId; void type
}

/** Appends an audio effect (audio/effects registry) to a clip, or to a track when target = 'track'. */
export function addAudioEffect(targetId: Id, type: string, target: 'clip' | 'track' = 'clip'): void {
  void targetId; void type; void target
}

/** Points a clip at a different media item (e.g. a denoised copy), keeping its timing. */
export function replaceClipMedia(clipId: Id, mediaId: Id): void {
  updateClip(clipId, 'Replace media', (c) => {
    c.mediaId = mediaId
  })
}

export function addTrack(kind: TrackKind): Id | null {
  void kind
  return null
}
