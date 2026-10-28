import type { MediaItem, MediaKind, MediaSource, Project } from '@shared/types'
import type { ProbeResult } from '@shared/ipc'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { uid } from '@/lib/ids'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const IMAGE_DURATION = 5

const normPath = (p: string): string => p.replace(/\//g, '\\').toLowerCase()
const ext = (p: string): string => /\.([^./\\]+)$/.exec(p)?.[1].toLowerCase() ?? ''

export const isImagePath = (p: string): boolean => IMAGE_EXTS.has(ext(p))

/** Finished transcodes by original path, so undo/redo snapshots taken mid-transcode get their playback copy back. */
const transcoded = new Map<string, string>()
/** Media ids with a transcode in flight. */
const running = new Set<string>()

export const transcodeJobId = (mediaId: string): string => `transcode-${mediaId}`

function kindOf(path: string, probe: ProbeResult): MediaKind {
  if (isImagePath(path)) return 'image'
  return probe.hasVideo ? 'video' : 'audio'
}

/**
 * Imports files into the project's media bin: probes them, transcodes unplayable formats in the
 * background, and returns the new media items (already added to the project).
 * Paths already in the project are not added again; their existing items are returned instead.
 */
export async function importFiles(
  paths: string[],
  opts?: { source?: MediaSource; ai?: MediaItem['ai'] }
): Promise<MediaItem[]> {
  const { project } = useProject.getState()
  const existing = new Map(project.media.map((m) => [normPath(m.path), m]))
  const unique = [...new Map(paths.filter(Boolean).map((p) => [normPath(p), p])).values()]
  const fresh = unique.filter((p) => !existing.has(normPath(p)))

  const probes = await Promise.allSettled(fresh.map((p) => window.cineply.media.probe(p)))
  const added: { item: MediaItem; durationHint: number }[] = []
  const failed: string[] = []
  probes.forEach((res, i) => {
    const path = fresh[i]
    if (res.status === 'rejected') {
      failed.push(window.cineply.paths.basename(path))
      return
    }
    const probe = res.value
    const kind = kindOf(path, probe)
    if (kind !== 'image' && !probe.hasVideo && !probe.hasAudio) {
      failed.push(window.cineply.paths.basename(path))
      return
    }
    const item: MediaItem = {
      id: uid(),
      name: window.cineply.paths.basename(path),
      path,
      kind,
      duration: kind === 'image' ? IMAGE_DURATION : probe.duration,
      width: probe.width,
      height: probe.height,
      fps: kind === 'video' ? probe.fps : undefined,
      hasVideo: kind !== 'audio',
      hasAudio: kind !== 'image' && probe.hasAudio,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      source: opts?.source ?? 'import',
      ...(opts?.ai ? { ai: opts.ai } : {}),
      status: probe.playable ? 'ready' : 'transcoding'
    }
    added.push({ item, durationHint: probe.duration })
  })

  if (failed.length) {
    useUi.getState().showToast(`Couldn't import ${failed.join(', ')}`, 'error')
  }
  if (added.length) {
    const label = added.length === 1 ? `Import ${added[0].item.name}` : `Import ${added.length} files`
    useProject.getState().mutate(label, (p) => {
      for (const { item } of added) if (!p.media.some((m) => normPath(m.path) === normPath(item.path))) p.media.push(item)
    })
    for (const { item, durationHint } of added) {
      if (item.status === 'transcoding') startTranscode(item, durationHint)
    }
  }

  const byPath = new Map(added.map(({ item }) => [normPath(item.path), item]))
  return unique
    .map((p) => byPath.get(normPath(p)) ?? existing.get(normPath(p)))
    .filter((m): m is MediaItem => !!m)
}

function setMediaStatus(mediaId: string, patch: Partial<MediaItem>): void {
  useProject.getState().mutateSilently((p) => {
    const m = p.media.find((x) => x.id === mediaId)
    if (m) Object.assign(m, patch)
  })
}

/**
 * Transcodes a media item Chromium can't decode to an H.264/AAC copy in the background, with a
 * cancellable job in the jobs list. Also used to retry a failed transcode.
 */
export function startTranscode(item: Pick<MediaItem, 'id' | 'name' | 'path' | 'duration'>, durationHint = item.duration): void {
  if (running.has(item.id)) return
  running.add(item.id)
  const jobId = transcodeJobId(item.id)
  const ui = useUi.getState()
  ui.upsertJob({
    id: jobId,
    label: `Optimizing ${item.name}`,
    progress: durationHint > 0 ? 0 : -1,
    status: 'running',
    error: undefined,
    cancel: () => void window.cineply.ffmpeg.cancel(jobId)
  })
  setMediaStatus(item.id, { status: 'transcoding', error: undefined })

  const off = window.cineply.ffmpeg.onProgress((p) => {
    if (p.jobId !== jobId || durationHint <= 0) return
    useUi.getState().upsertJob({ id: jobId, progress: Math.min(1, p.outTime / durationHint) })
  })

  window.cineply.media
    .makePlayable(item.path, jobId)
    .then((out) => {
      transcoded.set(normPath(item.path), out)
      setMediaStatus(item.id, { playbackPath: out, status: 'ready', error: undefined })
      useUi.getState().upsertJob({ id: jobId, status: 'done', progress: 1, cancel: undefined })
      setTimeout(() => {
        const job = useUi.getState().jobs.find((j) => j.id === jobId)
        if (job?.status === 'done') useUi.getState().removeJob(jobId)
      }, 2500)
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
      const cancelled = /cancel/i.test(message)
      setMediaStatus(item.id, { status: 'error', error: cancelled ? 'Optimizing was cancelled' : message })
      useUi.getState().upsertJob({
        id: jobId,
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled ? undefined : message,
        cancel: undefined
      })
    })
    .finally(() => {
      off()
      running.delete(item.id)
    })
}

/**
 * Keeps media status consistent with finished transcodes: undo/redo can restore a snapshot taken
 * while transcoding, and a project saved mid-transcode reopens with 'transcoding' status.
 */
function reconcile(project: Project): void {
  for (const m of project.media) {
    if (m.status !== 'transcoding' || running.has(m.id)) continue
    const out = transcoded.get(normPath(m.path))
    if (out) setMediaStatus(m.id, { playbackPath: out, status: 'ready', error: undefined })
    else startTranscode(m)
  }
}

let lastProject: Project | null = null
useProject.subscribe((s) => {
  if (s.project.media === lastProject?.media) return
  lastProject = s.project
  queueMicrotask(() => reconcile(useProject.getState().project))
})
