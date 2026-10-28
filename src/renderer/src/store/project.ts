import { create } from 'zustand'
import { produce, type Draft } from 'immer'
import {
  PROJECT_VERSION, defaultAudioProps, defaultVideoProps, clipEnd,
  type Clip, type Id, type MediaItem, type Project, type Track, type TrackKind
} from '@shared/types'
import { uid } from '@/lib/ids'

/**
 * The project store. Every change to the project goes through `mutate` (undoable) or
 * `mutateSilently` (not recorded, e.g. media status updates). Feature modules should write
 * their own helpers on top of `mutate` rather than adding actions here.
 */

const HISTORY_LIMIT = 200

export interface ProjectState {
  project: Project
  filePath: string | null
  dirty: boolean
  past: { label: string; project: Project }[]
  future: { label: string; project: Project }[]
  /** Coalescing key of the last mutation: consecutive mutations with the same key share one undo step (slider drags). */
  lastCoalesce: string | null

  mutate(label: string, fn: (p: Draft<Project>) => void, opts?: { coalesce?: string }): void
  mutateSilently(fn: (p: Draft<Project>) => void): void
  undo(): void
  redo(): void
  load(project: Project, filePath: string | null): void
  markSaved(filePath: string): void
}

export function newTrack(kind: TrackKind, name: string): Track {
  return { id: uid(), kind, name, muted: false, solo: false, locked: false, gain: 1, pan: 0, effects: [], height: kind === 'video' ? 64 : 72 }
}

export function newProject(name = 'Untitled'): Project {
  return {
    version: PROJECT_VERSION,
    name,
    sequence: { width: 1920, height: 1080, fps: 30, sampleRate: 48000, background: '#000000' },
    tracks: [
      newTrack('video', 'V3'), newTrack('video', 'V2'), newTrack('video', 'V1'),
      newTrack('audio', 'A1'), newTrack('audio', 'A2'), newTrack('audio', 'A3')
    ],
    clips: [],
    media: [],
    markers: [],
    masterGain: 1
  }
}

export function newClip(partial: Partial<Clip> & Pick<Clip, 'trackId' | 'type' | 'start' | 'duration'>): Clip {
  return {
    id: uid(),
    name: 'Clip',
    in: 0,
    speed: 1,
    video: defaultVideoProps(),
    audio: defaultAudioProps(),
    ...partial
  }
}

export const useProject = create<ProjectState>((set, get) => ({
  project: newProject(),
  filePath: null,
  dirty: false,
  past: [],
  future: [],
  lastCoalesce: null,

  mutate(label, fn, opts) {
    const { project, past, lastCoalesce } = get()
    const next = produce(project, fn)
    if (next === project) return
    const coalesce = opts?.coalesce ?? null
    const merge = coalesce !== null && coalesce === lastCoalesce && past.length > 0
    set({
      project: next,
      dirty: true,
      past: merge ? past : [...past, { label, project }].slice(-HISTORY_LIMIT),
      future: [],
      lastCoalesce: coalesce
    })
  },

  mutateSilently(fn) {
    const { project } = get()
    const next = produce(project, fn)
    if (next !== project) set({ project: next })
  },

  undo() {
    const { past, future, project } = get()
    const prev = past[past.length - 1]
    if (!prev) return
    set({
      project: prev.project,
      past: past.slice(0, -1),
      future: [{ label: prev.label, project }, ...future],
      dirty: true,
      lastCoalesce: null
    })
  },

  redo() {
    const { past, future, project } = get()
    const next = future[0]
    if (!next) return
    set({
      project: next.project,
      past: [...past, { label: next.label, project }],
      future: future.slice(1),
      dirty: true,
      lastCoalesce: null
    })
  },

  load(project, filePath) {
    set({ project, filePath, dirty: false, past: [], future: [], lastCoalesce: null })
  },

  markSaved(filePath) {
    set({ filePath, dirty: false })
  }
}))

// ------------------------------------------------------------ selectors ----

export const getProject = (): Project => useProject.getState().project
export const findClip = (p: Project, id: Id): Clip | undefined => p.clips.find((c) => c.id === id)
export const findTrack = (p: Project, id: Id): Track | undefined => p.tracks.find((t) => t.id === id)
export const findMedia = (p: Project, id: Id | undefined): MediaItem | undefined =>
  id ? p.media.find((m) => m.id === id) : undefined
export const clipsOnTrack = (p: Project, trackId: Id): Clip[] =>
  p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start)
export const videoTracks = (p: Project): Track[] => p.tracks.filter((t) => t.kind === 'video')
export const audioTracks = (p: Project): Track[] => p.tracks.filter((t) => t.kind === 'audio')
export const sequenceDuration = (p: Project): number => p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)

/** The clip on `trackId` that ends exactly where `clip` starts (within half a frame), if any. */
export function clipBefore(p: Project, clip: Clip): Clip | undefined {
  const eps = 0.5 / p.sequence.fps
  return p.clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < eps)
}

/** The clip on the same track that starts exactly where `clip` ends, if any. */
export function clipAfter(p: Project, clip: Clip): Clip | undefined {
  const eps = 0.5 / p.sequence.fps
  return p.clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(c.start - clipEnd(clip)) < eps)
}

/** All clips linked to `clip` (including itself). */
export function linkedClips(p: Project, clip: Clip): Clip[] {
  return clip.linkId ? p.clips.filter((c) => c.linkId === clip.linkId) : [clip]
}
