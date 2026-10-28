import { current, isDraft, produce, type Draft } from 'immer'
import {
  clipEnd, type Clip, type Id, type Keyframe, type MediaItem, type Project, type Track, type TrackKind
} from '@shared/types'
import { clipAfter, clipBefore, findMedia, getProject, linkedClips, newClip, newTrack, useProject } from '@/store/project'
import { usePlayback } from '@/store/playback'
import { useUi } from '@/store/ui'
import { uid } from '@/lib/ids'
import { defaultParams } from '@/lib/params'
import { snapToFrame } from '@/lib/time'
import { getTransition } from '@/engine/transitions'
import { getVideoEffect } from '@/engine/effects'
import { getAudioEffect } from '@/audio/effects'
import { createTitleFromTemplate } from '@/engine/titles'

/**
 * Editing commands shared by the timeline, panels, and shortcuts. Each command is one undo step.
 * (Owner: timeline/editing. Other modules call these rather than re-implementing edits.)
 *
 * The lower-level `op*` functions edit a project draft in place and record nothing; the timeline
 * uses them for live drags (`applyGesture`) so a whole gesture becomes one coalesced undo step.
 */

const EPS = 1e-6
export const IMAGE_DEFAULT_DURATION = 5
export const MIN_SPEED = 0.1
export const MAX_SPEED = 16

const mutate = (label: string, fn: (p: Draft<Project>) => void, coalesce?: string): void =>
  useProject.getState().mutate(label, fn, coalesce ? { coalesce } : undefined)

const playhead = (): number => usePlayback.getState().time

/** Mutates a single clip as one undo step. Pass coalesce for continuous edits (slider drags). */
export function updateClip(clipId: Id, label: string, fn: (c: Draft<Clip>) => void, coalesce?: string): void {
  useProject.getState().mutate(label, (p) => {
    const c = p.clips.find((x) => x.id === clipId)
    if (c) fn(c)
  }, coalesce ? { coalesce } : undefined)
}

/**
 * Applies `fn` to `base` (the project as it was when a drag began) and stores the result as one
 * coalesced undo step. Calling it again with the same key replaces the previous result, so a drag
 * can be recomputed from scratch on every pointer move.
 */
export function applyGesture(label: string, key: string, base: Project, fn: (p: Project) => void): void {
  const next = produce(base, (d) => fn(d as Project))
  useProject.getState().mutate(label, () => next, { coalesce: key })
}

// ------------------------------------------------------------ queries ----

export const frameDuration = (p: Project): number => 1 / p.sequence.fps

/** Stills, titles and colour mattes can be any length; media clips are limited by the file. */
export function isUnlimited(p: Project, c: Clip): boolean {
  if (c.type !== 'media') return true
  const m = findMedia(p, c.mediaId)
  return !m || m.kind === 'image'
}

/** Longest timeline duration the clip can have from its current `in` point. */
export function maxClipDuration(p: Project, c: Clip, speed = c.speed): number {
  if (isUnlimited(p, c)) return Infinity
  const m = findMedia(p, c.mediaId)!
  return Math.max(0, (m.duration - c.in) / speed)
}

/** How far (timeline seconds) the clip's head can be extended to the left before media runs out. */
export function maxHeadExtension(p: Project, c: Clip): number {
  return isUnlimited(p, c) ? Infinity : c.in / c.speed
}

export const tracksOfKind = (p: Project, kind: TrackKind): Track[] => p.tracks.filter((t) => t.kind === kind)

/** Tracks of a kind ordered outward from the video/audio divider (V1, V2… or A1, A2…). */
function tracksFromDivider(p: Project, kind: TrackKind): Track[] {
  const list = tracksOfKind(p, kind)
  return kind === 'video' ? list.reverse() : list
}

/** True when nothing on the track overlaps [start, end). */
export function isRangeFree(p: Project, trackId: Id, start: number, end: number, ignore?: Set<Id>): boolean {
  return !p.clips.some((c) => c.trackId === trackId && !ignore?.has(c.id) && c.start < end - EPS && clipEnd(c) > start + EPS)
}

function isLocked(p: Project, trackId: Id): boolean {
  return p.tracks.find((t) => t.id === trackId)?.locked ?? true
}

/** Expands ids with their linked partners. */
export function withLinked(p: Project, ids: Iterable<Id>): Id[] {
  const out = new Set<Id>()
  for (const id of ids) {
    const c = p.clips.find((x) => x.id === id)
    if (!c) continue
    for (const l of linkedClips(p, c)) out.add(l.id)
  }
  return [...out]
}

/** Sorted, de-duplicated edit points (clip starts and ends). */
export function editPoints(p: Project): number[] {
  const pts = new Set<number>([0])
  for (const c of p.clips) {
    pts.add(Math.round(c.start * 1e6) / 1e6)
    pts.add(Math.round(clipEnd(c) * 1e6) / 1e6)
  }
  return [...pts].sort((a, b) => a - b)
}

function mediaDuration(m: MediaItem): number {
  if (m.kind === 'image') return IMAGE_DEFAULT_DURATION
  return Number.isFinite(m.duration) && m.duration > 0 ? m.duration : IMAGE_DEFAULT_DURATION
}

/**
 * Picks the tracks a media item lands on when placed at [start, start+duration). An explicit track
 * of the right kind is used as-is (overwrite); a track of the other kind selects its counterpart
 * (V2 ↔ A2). Otherwise the first unlocked free track counted from the divider, falling back to V1/A1.
 */
export function resolveMediaTargets(
  p: Project,
  media: MediaItem,
  start: number,
  trackId?: Id
): { videoTrackId?: Id; audioTrackId?: Id; duration: number } {
  const duration = mediaDuration(media)
  const end = start + duration
  const wantsVideo = media.kind === 'image' || (media.kind === 'video' && media.hasVideo)
  const wantsAudio = media.kind !== 'image' && media.hasAudio
  const given = trackId ? p.tracks.find((t) => t.id === trackId) : undefined
  const givenIndex = given ? tracksFromDivider(p, given.kind).findIndex((t) => t.id === given.id) : -1

  const pick = (kind: TrackKind): Id | undefined => {
    const list = tracksFromDivider(p, kind)
    if (given?.kind === kind) return given.locked ? undefined : given.id
    const preferred = givenIndex >= 0 ? list[givenIndex] : undefined
    if (preferred && !preferred.locked) return preferred.id
    const free = list.find((t) => !t.locked && isRangeFree(p, t.id, start, end))
    return (free ?? list.find((t) => !t.locked))?.id
  }
  return {
    videoTrackId: wantsVideo ? pick('video') : undefined,
    audioTrackId: wantsAudio ? pick('audio') : undefined,
    duration
  }
}

// --------------------------------------------------------- primitives ----

function cloneClip(c: Clip): Clip {
  const copy = structuredClone(isDraft(c) ? current(c) : c) as Clip
  copy.id = uid()
  copy.video.effects = copy.video.effects.map((e) => ({ ...e, id: uid() }))
  copy.audio.effects = copy.audio.effects.map((e) => ({ ...e, id: uid() }))
  return copy
}

/**
 * Re-bases keyframes after the clip's head moved by `shift` seconds and its length became `len`.
 * Keyframes outside the clip are dropped, except the nearest one on each side so the curve's
 * value inside the clip stays exactly the same.
 */
function rebaseKeyframes(kfs: Keyframe[], shift: number, len: number): Keyframe[] {
  if (kfs.length === 0) return kfs
  const s = kfs.map((k) => ({ ...k, t: k.t - shift })).sort((a, b) => a.t - b.t)
  let before = -1
  let after = -1
  s.forEach((k, i) => {
    if (k.t < -EPS) before = i
    if (k.t > len + EPS && after < 0) after = i
  })
  return s.filter((k, i) => (k.t >= -EPS && k.t <= len + EPS) || i === before || i === after)
}

/** Keeps keyframes, fades and transitions consistent after a clip's head shifted by `shift`. */
function retime(c: Clip, shift: number): void {
  for (const key of Object.keys(c.video.keyframes) as (keyof Clip['video']['keyframes'])[]) {
    const list = c.video.keyframes[key]
    if (list) c.video.keyframes[key] = rebaseKeyframes(list, shift, c.duration)
  }
  c.audio.volumeKeyframes = rebaseKeyframes(c.audio.volumeKeyframes, shift, c.duration)
  c.audio.fadeIn = Math.min(c.audio.fadeIn, c.duration)
  c.audio.fadeOut = Math.min(c.audio.fadeOut, c.duration - c.audio.fadeIn)
  if (c.transitionIn) c.transitionIn.duration = Math.min(c.transitionIn.duration, c.duration)
  if (c.transitionOut) c.transitionOut.duration = Math.min(c.transitionOut.duration, c.duration)
}

/** Moves a clip's first frame to `t`, keeping the source frames under the rest of the clip in place. */
function setHead(c: Clip, t: number): void {
  const d = t - c.start
  c.in = Math.max(0, c.in + d * c.speed)
  c.start = t
  c.duration -= d
  retime(c, d)
}

function setTail(c: Clip, t: number): void {
  c.duration = t - c.start
  retime(c, 0)
}

function removeClipsWhere(p: Project, pred: (c: Clip) => boolean): void {
  for (let i = p.clips.length - 1; i >= 0; i--) if (pred(p.clips[i])) p.clips.splice(i, 1)
}

/** Splits one clip at t. Returns the new right half, or null when t isn't inside the clip. */
export function opSplitClip(p: Project, c: Clip, t: number): Clip | null {
  const half = 0.5 / p.sequence.fps
  if (t <= c.start + half || t >= clipEnd(c) - half) return null
  const right = cloneClip(c)
  setHead(right, t)
  setTail(c, t)
  right.transitionIn = undefined
  right.audio.fadeIn = 0
  c.transitionOut = undefined
  c.audio.fadeOut = 0
  p.clips.push(right)
  return p.clips[p.clips.length - 1]
}

/**
 * Overwrite edit: removes whatever lies on `trackId` inside [start, end), trimming or splitting the
 * clips that are only partly covered. Clips in `keep` are left alone.
 */
export function opClearRange(p: Project, trackId: Id, start: number, end: number, keep?: Set<Id>): void {
  if (end - start <= EPS) return
  for (const c of p.clips.slice()) {
    if (c.trackId !== trackId || keep?.has(c.id)) continue
    const cs = c.start
    const ce = clipEnd(c)
    if (ce <= start + EPS || cs >= end - EPS) continue
    if (cs >= start - EPS && ce <= end + EPS) {
      removeClipsWhere(p, (x) => x.id === c.id)
    } else if (cs < start && ce > end) {
      opSplitClip(p, c, end)
      setTail(c, start)
    } else if (cs < start) {
      setTail(c, start)
      c.transitionOut = undefined
    } else {
      setHead(c, end)
      c.transitionIn = undefined
    }
  }
}

export interface ClipPlacement {
  id: Id
  start: number
  trackId: Id
}

/** Moves clips to new positions/tracks and overwrites whatever they land on. */
export function opPlaceClips(p: Project, moves: ClipPlacement[]): void {
  const ids = new Set(moves.map((m) => m.id))
  for (const m of moves) {
    const c = p.clips.find((x) => x.id === m.id)
    if (!c) continue
    c.start = Math.max(0, m.start)
    c.trackId = m.trackId
  }
  for (const m of moves) {
    const c = p.clips.find((x) => x.id === m.id)
    if (c) opClearRange(p, c.trackId, c.start, clipEnd(c), ids)
  }
}

/**
 * Allowed range of `delta` (seconds the edge moves) when trimming `ids` at `edge`.
 * Regular trims stop at neighbouring clips; ripple trims push them instead.
 */
export function trimLimits(p: Project, ids: Id[], edge: 'in' | 'out', ripple: boolean): [number, number] {
  const minDur = frameDuration(p)
  const set = new Set(ids)
  let lo = -Infinity
  let hi = Infinity
  for (const id of ids) {
    const c = p.clips.find((x) => x.id === id)
    if (!c) continue
    const end = clipEnd(c)
    const others = p.clips.filter((x) => x.trackId === c.trackId && !set.has(x.id))
    if (edge === 'in') {
      hi = Math.min(hi, c.duration - minDur)
      lo = Math.max(lo, -maxHeadExtension(p, c))
      if (!ripple) {
        lo = Math.max(lo, -c.start)
        const prevEnd = others.filter((x) => clipEnd(x) <= c.start + EPS).reduce((m, x) => Math.max(m, clipEnd(x)), 0)
        lo = Math.max(lo, prevEnd - c.start)
      }
    } else {
      lo = Math.max(lo, minDur - c.duration)
      hi = Math.min(hi, maxClipDuration(p, c) - c.duration)
      if (!ripple) {
        const nextStart = others.filter((x) => x.start >= end - EPS).reduce((m, x) => Math.min(m, x.start), Infinity)
        hi = Math.min(hi, nextStart - end)
      }
    }
  }
  if (lo > hi) return [0, 0]
  return [Math.min(lo, 0), Math.max(hi, 0)]
}

/**
 * Trims `ids` at `edge` by `delta` seconds (already clamped with trimLimits). A ripple trim keeps the
 * clip's start fixed for in-edge trims and shifts everything after the edit on the affected tracks.
 */
export function opTrim(p: Project, ids: Id[], edge: 'in' | 'out', delta: number, ripple: boolean): void {
  if (Math.abs(delta) < EPS) return
  const set = new Set(ids)
  const shifts = new Map<Id, { from: number; by: number }>()
  for (const id of ids) {
    const c = p.clips.find((x) => x.id === id)
    if (!c) continue
    const oldEnd = clipEnd(c)
    if (edge === 'out') {
      setTail(c, oldEnd + delta)
      if (ripple) shifts.set(c.trackId, { from: oldEnd, by: delta })
    } else if (ripple) {
      const start = c.start
      setHead(c, start + delta)
      c.start = start
      shifts.set(c.trackId, { from: oldEnd, by: -delta })
    } else {
      setHead(c, c.start + delta)
    }
  }
  for (const c of p.clips) {
    const s = shifts.get(c.trackId)
    if (s && !set.has(c.id) && c.start >= s.from - EPS) c.start = Math.max(0, c.start + s.by)
  }
}

// ------------------------------------------------------------ commands ----

function selectIfExists(ids: Id[]): void {
  const p = getProject()
  useUi.getState().select(ids.filter((id) => p.clips.some((c) => c.id === id)))
}

function pruneSelection(): void {
  const p = getProject()
  const ui = useUi.getState()
  const sel = ui.selection.filter((id) => p.clips.some((c) => c.id === id))
  if (sel.length !== ui.selection.length) ui.select(sel)
  const tr = ui.selectedTransition
  if (tr) {
    const c = p.clips.find((x) => x.id === tr.clipId)
    if (!c || !(tr.edge === 'in' ? c.transitionIn : c.transitionOut)) ui.selectTransition(null)
  }
}

/**
 * Places a media item on the timeline. Video files with sound create a video clip plus a linked audio
 * clip. Defaults: start = playhead, video track = V1 (or the first track with room), audio track = A1.
 * Returns the created clip ids.
 */
export function addMediaClip(mediaId: Id, opts?: { start?: number; trackId?: Id }): Id[] {
  const p = getProject()
  const m = findMedia(p, mediaId)
  if (!m) return []
  const start = snapToFrame(Math.max(0, opts?.start ?? playhead()), p.sequence.fps)
  const { videoTrackId, audioTrackId, duration } = resolveMediaTargets(p, m, start, opts?.trackId)
  if (!videoTrackId && !audioTrackId) {
    useUi.getState().showToast('All tracks are locked', 'error')
    return []
  }
  const linkId = videoTrackId && audioTrackId ? uid() : undefined
  const clips: Clip[] = []
  if (videoTrackId) clips.push(newClip({ trackId: videoTrackId, type: 'media', mediaId, name: m.name, start, duration, linkId }))
  if (audioTrackId) clips.push(newClip({ trackId: audioTrackId, type: 'media', mediaId, name: m.name, start, duration, linkId }))
  mutate('Add clip', (d) => {
    for (const c of clips) {
      opClearRange(d as Project, c.trackId, c.start, clipEnd(c))
      d.clips.push(c)
    }
  })
  const ids = clips.map((c) => c.id)
  useUi.getState().select(ids)
  return ids
}

/** Picks a video track for a generated clip: the given one, else the top-most free one, else a new track on top. */
function placeGenerated(d: Project, start: number, duration: number, trackId?: Id): Id | null {
  const given = trackId ? d.tracks.find((t) => t.id === trackId && t.kind === 'video') : undefined
  if (given) return given.locked ? null : given.id
  const free = tracksOfKind(d, 'video').find((t) => !t.locked && isRangeFree(d, t.id, start, start + duration))
  if (free) return free.id
  const t = newTrack('video', 'V')
  d.tracks.unshift(t)
  renumberTracks(d)
  return t.id
}

function addGeneratedClip(label: string, partial: Partial<Clip> & Pick<Clip, 'type' | 'duration'>, opts?: { start?: number; trackId?: Id }): Id | null {
  const fps = getProject().sequence.fps
  const start = snapToFrame(Math.max(0, opts?.start ?? playhead()), fps)
  let id: Id | null = null
  mutate(label, (d) => {
    const trackId = placeGenerated(d as Project, start, partial.duration, opts?.trackId)
    if (!trackId) return
    const c = newClip({ ...partial, trackId, start })
    opClearRange(d as Project, trackId, start, start + c.duration)
    d.clips.push(c)
    id = c.id
  })
  if (id) useUi.getState().select([id])
  else useUi.getState().showToast('That track is locked', 'error')
  return id
}

/** Adds a title clip from a template (engine/titles) at `start` (default playhead) on the top-most free video track. */
export function addTitleClip(templateId: string, opts?: { start?: number; trackId?: Id }): Id | null {
  const { spec, duration, name } = createTitleFromTemplate(templateId)
  return addGeneratedClip('Add title', { type: 'title', name, title: spec, duration }, opts)
}

/** Adds a solid colour matte (default 5 s) at `start` (default playhead). */
export function addColorMatte(color = '#000000', opts?: { start?: number; trackId?: Id }): Id | null {
  return addGeneratedClip('Add color matte', { type: 'color', name: 'Color Matte', color, duration: IMAGE_DEFAULT_DURATION }, opts)
}

/**
 * Splits the given clips (default: selected clips, or all unlocked clips under the playhead) at time t.
 * Linked partners are split too unless opts.linked is false.
 */
export function splitAt(t: number, clipIds?: Id[], opts?: { linked?: boolean }): void {
  const p = getProject()
  const spans = (c: Clip): boolean => c.start < t - EPS && clipEnd(c) > t + EPS && !isLocked(p, c.trackId)
  let targets = clipIds
  if (!targets) {
    const selected = useUi.getState().selection.filter((id) => p.clips.some((c) => c.id === id && spans(c)))
    targets = selected.length ? selected : p.clips.filter(spans).map((c) => c.id)
  }
  const ids = (opts?.linked === false ? targets : withLinked(p, targets)).filter((id) => {
    const c = p.clips.find((x) => x.id === id)
    return !!c && spans(c)
  })
  if (ids.length === 0) return
  mutate('Split', (d) => {
    const links = new Map<Id, Id>()
    for (const id of ids) {
      const c = d.clips.find((x) => x.id === id)
      if (!c) continue
      const right = opSplitClip(d as Project, c as Clip, snapToFrame(t, d.sequence.fps))
      if (right?.linkId) {
        if (!links.has(right.linkId)) links.set(right.linkId, uid())
        right.linkId = links.get(right.linkId)
      }
    }
  })
}

/** Deletes clips (and their linked partners). ripple = close the gap. */
export function deleteClips(clipIds: Id[], ripple: boolean): void {
  const p = getProject()
  const ids = new Set(withLinked(p, clipIds).filter((id) => !isLocked(p, p.clips.find((c) => c.id === id)!.trackId)))
  if (ids.size === 0) return
  mutate(ripple ? 'Ripple delete' : 'Delete', (d) => {
    const gaps = new Map<Id, [number, number][]>()
    for (const c of d.clips) {
      if (!ids.has(c.id)) continue
      const list = gaps.get(c.trackId) ?? []
      list.push([c.start, clipEnd(c)])
      gaps.set(c.trackId, list)
    }
    removeClipsWhere(d as Project, (c) => ids.has(c.id))
    if (!ripple) return
    for (const c of d.clips) {
      const list = gaps.get(c.trackId)
      if (!list) continue
      const shift = list.filter(([, e]) => e <= c.start + EPS).reduce((s, [a, b]) => s + (b - a), 0)
      c.start = Math.max(0, c.start - shift)
    }
  })
  pruneSelection()
}

/** Sets or clears (type = null) the transition on a clip edge. Duration defaults to the transition's default. */
export function setTransition(clipId: Id, edge: 'in' | 'out', type: string | null, duration?: number): void {
  mutate(type ? 'Set transition' : 'Remove transition', (d) => {
    const c = d.clips.find((x) => x.id === clipId)
    if (!c) return
    const key = edge === 'in' ? 'transitionIn' : 'transitionOut'
    if (!type) {
      delete c[key]
      return
    }
    const def = getTransition(type)
    const other = edge === 'in' ? clipBefore(d as Project, c as Clip) : undefined
    const limit = Math.min(c.duration / 2, other ? other.duration / 2 : Infinity)
    const dur = Math.max(frameDuration(d as Project), Math.min(duration ?? c[key]?.duration ?? def.defaultDuration, limit))
    const prev = c[key]
    c[key] = { type, duration: dur, params: prev?.type === type ? prev.params : defaultParams(def.params) }
  })
  if (!type) pruneSelection()
}

/**
 * Where a transition dropped on `edge` of a clip really belongs: an out-edge followed by another
 * clip becomes that clip's in-edge (the transition is centred on the cut).
 */
export function transitionTarget(p: Project, clip: Clip, edge: 'in' | 'out'): { clipId: Id; edge: 'in' | 'out' } {
  if (edge === 'out') {
    const next = clipAfter(p, clip)
    if (next) return { clipId: next.id, edge: 'in' }
  }
  return { clipId: clip.id, edge }
}

/** Appends a video effect (engine/effects registry) with default params to a clip. */
export function addVideoEffect(clipId: Id, type: string): void {
  const def = getVideoEffect(type)
  updateClip(clipId, `Add ${def?.name ?? 'effect'}`, (c) => {
    c.video.effects.push({ id: uid(), type, enabled: true, params: def ? defaultParams(def.params) : {} })
  })
}

/** Appends an audio effect (audio/effects registry) to a clip, or to a track when target = 'track'. */
export function addAudioEffect(targetId: Id, type: string, target: 'clip' | 'track' = 'clip'): void {
  const def = getAudioEffect(type)
  const fx = { id: uid(), type, enabled: true, params: def ? defaultParams(def.params) : {} }
  mutate(`Add ${def?.name ?? 'audio effect'}`, (d) => {
    if (target === 'track') d.tracks.find((t) => t.id === targetId)?.effects.push(fx)
    else d.clips.find((c) => c.id === targetId)?.audio.effects.push(fx)
  })
}

/** Points a clip at a different media item (e.g. a denoised copy), keeping its timing. */
export function replaceClipMedia(clipId: Id, mediaId: Id): void {
  updateClip(clipId, 'Replace media', (c) => {
    c.mediaId = mediaId
  })
}

/** Renames default-named tracks by position: V1 is the bottom video track, A1 the top audio track. */
function renumberTracks(p: Project): void {
  for (const kind of ['video', 'audio'] as TrackKind[]) {
    tracksFromDivider(p, kind).forEach((t, i) => {
      if (/^[VA]\d*$/.test(t.name)) t.name = `${kind === 'video' ? 'V' : 'A'}${i + 1}`
    })
  }
}

/** Adds a track: video tracks go on top of the stack, audio tracks at the bottom (or at `index` in project.tracks). */
export function addTrack(kind: TrackKind, opts?: { index?: number }): Id | null {
  const t = newTrack(kind, kind === 'video' ? 'V' : 'A')
  mutate(kind === 'video' ? 'Add video track' : 'Add audio track', (d) => {
    const firstAudio = d.tracks.findIndex((x) => x.kind === 'audio')
    const videoEnd = firstAudio < 0 ? d.tracks.length : firstAudio
    let index = kind === 'video' ? 0 : d.tracks.length
    if (opts?.index !== undefined) {
      index = kind === 'video' ? Math.min(Math.max(0, opts.index), videoEnd) : Math.min(Math.max(videoEnd, opts.index), d.tracks.length)
    }
    d.tracks.splice(index, 0, t)
    renumberTracks(d as Project)
  })
  return t.id
}

/** Deletes a track and its clips. The last track of each kind can't be removed. */
export function removeTrack(trackId: Id): void {
  const p = getProject()
  const t = p.tracks.find((x) => x.id === trackId)
  if (!t) return
  if (tracksOfKind(p, t.kind).length <= 1) {
    useUi.getState().showToast(`The last ${t.kind} track can't be deleted`, 'error')
    return
  }
  mutate(`Delete track ${t.name}`, (d) => {
    removeClipsWhere(d as Project, (c) => c.trackId === trackId)
    d.tracks.splice(d.tracks.findIndex((x) => x.id === trackId), 1)
    renumberTracks(d as Project)
  })
  if (useUi.getState().selectedTrackId === trackId) useUi.setState({ selectedTrackId: null })
  pruneSelection()
}

export function renameTrack(trackId: Id, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  mutate('Rename track', (d) => {
    const t = d.tracks.find((x) => x.id === trackId)
    if (t) t.name = trimmed
  })
}

export function updateTrack(trackId: Id, label: string, fn: (t: Draft<Track>) => void): void {
  mutate(label, (d) => {
    const t = d.tracks.find((x) => x.id === trackId)
    if (t) fn(t)
  })
}

/** The editable selection: selected clips plus linked partners, minus clips on locked tracks. */
function editableSelection(p: Project, ids?: Id[]): Clip[] {
  const sel = withLinked(p, ids ?? useUi.getState().selection)
  return p.clips.filter((c) => sel.includes(c.id) && !isLocked(p, c.trackId))
}

/** Gives copies fresh ids and remaps link groups so copies link to each other, not to the originals. */
function freshCopies(clips: Clip[]): Clip[] {
  const links = new Map<Id, Id>()
  return clips.map((c) => {
    const copy = cloneClip(c)
    if (copy.linkId) {
      if (!links.has(copy.linkId)) links.set(copy.linkId, uid())
      copy.linkId = links.get(copy.linkId)
    }
    return copy
  })
}

function insertCopies(label: string, copies: Clip[]): void {
  if (copies.length === 0) return
  mutate(label, (d) => {
    for (const c of copies) {
      opClearRange(d as Project, c.trackId, c.start, clipEnd(c))
      d.clips.push(c)
    }
  })
  selectIfExists(copies.map((c) => c.id))
}

/** Duplicates the selected clips right after the selection (Ctrl+D). */
export function duplicateClips(ids?: Id[]): void {
  const p = getProject()
  const clips = editableSelection(p, ids)
  if (clips.length === 0) return
  const from = Math.min(...clips.map((c) => c.start))
  const to = Math.max(...clips.map(clipEnd))
  const copies = freshCopies(clips)
  for (const c of copies) c.start += to - from
  insertCopies('Duplicate', copies)
}

let clipboard: { clips: { clip: Clip; kind: TrackKind; index: number }[]; origin: number } | null = null

export function hasClipboard(): boolean {
  return !!clipboard && clipboard.clips.length > 0
}

/** Copies the selected clips (with linked partners) to the internal clipboard. */
export function copyClips(ids?: Id[]): number {
  const p = getProject()
  const sel = withLinked(p, ids ?? useUi.getState().selection)
  const clips = p.clips.filter((c) => sel.includes(c.id))
  if (clips.length === 0) return 0
  clipboard = {
    origin: Math.min(...clips.map((c) => c.start)),
    clips: clips.map((clip) => {
      const kind = p.tracks.find((t) => t.id === clip.trackId)?.kind ?? 'video'
      return { clip: structuredClone(clip), kind, index: tracksFromDivider(p, kind).findIndex((t) => t.id === clip.trackId) }
    })
  }
  return clips.length
}

export function cutClips(ids?: Id[]): void {
  if (copyClips(ids)) deleteClips(ids ?? useUi.getState().selection, false)
}

/**
 * Pastes the clipboard at `at` (default playhead), overwriting what's there, and moves the playhead
 * to the end of the pasted clips. Clips go back onto their original tracks when those still exist.
 */
export function pasteClips(at?: number): void {
  if (!clipboard) return
  const p = getProject()
  const { origin } = clipboard
  const t0 = snapToFrame(at ?? playhead(), p.sequence.fps)
  const entries = clipboard.clips.filter(({ clip }) => clip.type !== 'media' || findMedia(p, clip.mediaId))
  const copies = freshCopies(entries.map((e) => e.clip)).flatMap((c, i) => {
    const { kind, index } = entries[i]
    const list = tracksFromDivider(p, kind)
    const track = list.find((t) => t.id === c.trackId) ?? list[Math.min(Math.max(0, index), list.length - 1)]
    if (!track || track.locked) return []
    return [{ ...c, trackId: track.id, start: c.start - origin + t0 }]
  })
  if (copies.length === 0) return
  insertCopies('Paste', copies)
  usePlayback.getState().setTime(Math.max(...copies.map(clipEnd)))
}

/** Moves the selected clips by `frames` frames (, and .), overwriting what they land on. */
export function nudgeClips(frames: number, ids?: Id[]): void {
  const p = getProject()
  const clips = editableSelection(p, ids)
  if (clips.length === 0) return
  const minStart = Math.min(...clips.map((c) => c.start))
  const delta = Math.max(-minStart, frames / p.sequence.fps)
  if (Math.abs(delta) < EPS) return
  mutate('Nudge', (d) => {
    opPlaceClips(d as Project, clips.map((c) => ({ id: c.id, start: c.start + delta, trackId: c.trackId })))
  }, 'nudge')
}

/** Links the given clips (default: selection) so they move, trim and delete together. */
export function linkClips(ids?: Id[]): void {
  const sel = ids ?? useUi.getState().selection
  if (sel.length < 2) return
  const linkId = uid()
  mutate('Link', (d) => {
    for (const c of d.clips) if (sel.includes(c.id)) c.linkId = linkId
  })
}

export function unlinkClips(ids?: Id[]): void {
  const p = getProject()
  const sel = withLinked(p, ids ?? useUi.getState().selection)
  if (!p.clips.some((c) => sel.includes(c.id) && c.linkId)) return
  mutate('Unlink', (d) => {
    for (const c of d.clips) if (sel.includes(c.id)) delete c.linkId
  })
}

/** Toggles linking: unlinks when any selected clip is linked, otherwise links the selection. */
export function toggleLink(ids?: Id[]): void {
  const p = getProject()
  const sel = ids ?? useUi.getState().selection
  if (p.clips.some((c) => sel.includes(c.id) && c.linkId)) unlinkClips(sel)
  else linkClips(sel)
}

/**
 * Changes playback speed (1 = normal) of a clip and its linked partners. The in point stays; the
 * duration scales and is limited by the media length and by the next clip on the track.
 */
export function setClipSpeed(clipId: Id, speed: number): void {
  const p = getProject()
  const clip = p.clips.find((c) => c.id === clipId)
  if (!clip) return
  const s = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
  const group = linkedClips(p, clip)
  const groupIds = new Set(group.map((c) => c.id))
  mutate('Change speed', (d) => {
    for (const g of group) {
      const c = d.clips.find((x) => x.id === g.id)
      if (!c) continue
      const ratio = c.speed / s
      const nextStart = d.clips
        .filter((x) => x.trackId === c.trackId && !groupIds.has(x.id) && x.start >= clipEnd(c) - EPS)
        .reduce((m, x) => Math.min(m, x.start), Infinity)
      const dur = Math.min(c.duration * ratio, maxClipDuration(d as Project, c as Clip, s), nextStart - c.start)
      const scale = (k: Keyframe): Keyframe => ({ ...k, t: k.t * ratio })
      for (const key of Object.keys(c.video.keyframes) as (keyof Clip['video']['keyframes'])[]) {
        const list = c.video.keyframes[key]
        if (list) c.video.keyframes[key] = list.map(scale)
      }
      c.audio.volumeKeyframes = c.audio.volumeKeyframes.map(scale)
      c.speed = s
      c.duration = Math.max(frameDuration(d as Project), dur)
      retime(c as Clip, 0)
    }
  })
}

/** Selects every clip on unlocked tracks. */
export function selectAll(): void {
  const p = getProject()
  useUi.getState().select(p.clips.filter((c) => !isLocked(p, c.trackId)).map((c) => c.id))
}

// ------------------------------------------------------------ markers ----

const MARKER_COLORS = ['#3ccf91', '#ffb547', '#ff5c6c', '#4fa3ff', '#b47cff']

/** Adds a marker at t (default playhead), unless one is already within half a frame. Returns its id. */
export function addMarker(t = playhead(), name?: string): Id | null {
  const p = getProject()
  const time = snapToFrame(t, p.sequence.fps)
  if (p.markers.some((m) => Math.abs(m.time - time) < 0.5 / p.sequence.fps)) return null
  const id = uid()
  mutate('Add marker', (d) => {
    d.markers.push({ id, time, name: name ?? `Marker ${d.markers.length + 1}`, color: MARKER_COLORS[0] })
    d.markers.sort((a, b) => a.time - b.time)
  })
  return id
}

export function updateMarker(id: Id, label: string, patch: Partial<{ time: number; name: string; color: string }>, coalesce?: string): void {
  mutate(label, (d) => {
    const m = d.markers.find((x) => x.id === id)
    if (!m) return
    Object.assign(m, patch)
    d.markers.sort((a, b) => a.time - b.time)
  }, coalesce)
}

export function removeMarker(id: Id): void {
  mutate('Delete marker', (d) => {
    const i = d.markers.findIndex((m) => m.id === id)
    if (i >= 0) d.markers.splice(i, 1)
  })
}

export { MARKER_COLORS }
