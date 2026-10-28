import { sourceTimeAt, type MediaItem, type Project } from '@shared/types'
import { clipBefore, getProject, sequenceDuration, useProject } from '@/store/project'
import { usePlayback } from '@/store/playback'
import { audioEngine } from '@/audio/engine'
import { clampSourceTime, collectFrameRequests, renderFrame, type FrameRequest } from './compositor'
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

/** Seeks land slightly inside the wanted frame so float error never shows the previous one. */
const SEEK_EPS = 0.0005
/** Re-seek a playing video when it drifts this far (seconds) from the master clock. */
const MAX_DRIFT = 0.15
/** Rates above this are shown by step-seeking instead of native playback. */
const MAX_NATIVE_RATE = 2
const PREROLL = 1
const IDLE_RELEASE_MS = 20_000
const MAX_VIDEO_SLOTS = 24

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3

let hostEl: HTMLDivElement | null = null

/** Media elements live in the DOM (invisible) so Chromium keeps decoding and firing frame callbacks. */
function mediaHost(): HTMLDivElement {
  if (!hostEl) {
    hostEl = document.createElement('div')
    hostEl.setAttribute('aria-hidden', 'true')
    hostEl.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1'
    document.body.appendChild(hostEl)
  }
  return hostEl
}

const urlOf = (m: MediaItem): string => window.cineply.mediaUrl(m.playbackPath ?? m.path)

interface VideoSlot {
  key: string
  mediaId: string
  url: string
  video: HTMLVideoElement
  clipId: string | null
  still: boolean
  lastUsed: number
  /** Last precise seek target (paused mode), null while playing. */
  target: number | null
  /** Seek requested while another was in flight; issued on 'seeked' (coalesces scrubbing). */
  pending: number | null
  /** Last good frame, shown while a seek is in flight so scrubbing never flashes empty. */
  snapshot: HTMLCanvasElement | null
  failed: boolean
}

interface ImageSlot {
  url: string
  img: HTMLImageElement
  bitmap: ImageBitmap | null
  failed: boolean
  lastUsed: number
}

/**
 * FrameProvider backed by muted <video> elements (one per clip on screen, pooled per media item so
 * two clips of the same media can show at once during a transition) and decoded images.
 */
export class MediaPool implements FrameProvider {
  playing = false
  onChange: (() => void) | null = null
  private videos: VideoSlot[] = []
  private stills = new Map<string, VideoSlot>()
  private images = new Map<string, ImageSlot>()
  private assigned = new Map<string, VideoSlot>()
  private nextKey = 0

  // ------------------------------------------------------- FrameProvider --

  getFrame(clip: FrameRequest['clip'], media: MediaItem, sourceTime: number): CanvasImageSource | null {
    if (media.kind === 'image') return this.image(media)
    let slot = this.assigned.get(clip.id)
    if (!slot) {
      slot = this.claim({ clip, media, sourceTime }, false)
      if (!this.playing) this.seek(slot, sourceTime)
    }
    if (slot.failed) return null
    const v = slot.video
    const hasFrame = v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    if (this.playing) return hasFrame ? v : slot.snapshot
    if (hasFrame && !v.seeking && (slot.target === null || near(v.currentTime, slot.target))) return v
    return slot.snapshot ?? (hasFrame ? v : null)
  }

  getStill(media: MediaItem): CanvasImageSource | null {
    if (media.kind === 'image') return this.image(media)
    if (media.kind !== 'video') return null
    let slot = this.stills.get(media.id)
    if (!slot || slot.url !== urlOf(media)) {
      if (slot) this.destroy(slot)
      slot = this.createVideo(media, true)
      this.stills.set(media.id, slot)
      this.seek(slot, Math.min(0.04, media.duration / 2))
    }
    slot.lastUsed = performance.now()
    return slot.snapshot
  }

  // ---------------------------------------------------------- assignment --

  /**
   * Binds every request (and upcoming pre-roll requests) to an element. A clip keeps its element across
   * frames, so steady playback never re-seeks; free elements of the same media are reused otherwise.
   */
  assign(requests: FrameRequest[], preroll: FrameRequest[] = []): void {
    this.assigned.clear()
    const all = [...requests, ...preroll].filter((r) => r.clip.type === 'media' && r.media.kind === 'video')
    const rest: FrameRequest[] = []
    for (const r of all) {
      if (this.assigned.has(r.clip.id)) continue
      const sticky = this.videos.find((s) => s.clipId === r.clip.id && s.mediaId === r.media.id && !this.isAssigned(s))
      if (sticky) this.bind(sticky, r)
      else rest.push(r)
    }
    for (const r of rest) if (!this.assigned.has(r.clip.id)) this.claim(r, true)
  }

  private isAssigned(slot: VideoSlot): boolean {
    for (const s of this.assigned.values()) if (s === slot) return true
    return false
  }

  private claim(r: FrameRequest, preferNear: boolean): VideoSlot {
    let best: VideoSlot | null = null
    let bestDist = Infinity
    for (const s of this.videos) {
      if (s.mediaId !== r.media.id || this.isAssigned(s)) continue
      const d = preferNear ? Math.abs(s.video.currentTime - r.sourceTime) : 0
      if (d < bestDist) {
        best = s
        bestDist = d
      }
    }
    const slot = best ?? this.createVideo(r.media, false)
    this.bind(slot, r)
    return slot
  }

  private bind(slot: VideoSlot, r: FrameRequest): void {
    slot.clipId = r.clip.id
    slot.lastUsed = performance.now()
    this.assigned.set(r.clip.id, slot)
    const url = urlOf(r.media)
    if (slot.url !== url) {
      // The media got a transcoded playback copy: reload.
      slot.url = url
      slot.failed = false
      slot.target = null
      slot.pending = null
      slot.snapshot = null
      slot.video.src = url
    }
  }

  // -------------------------------------------------------------- sync ----

  /** Paused: seeks every on-screen element precisely to its frame. */
  seekTo(requests: FrameRequest[], preroll: FrameRequest[] = []): void {
    for (const r of [...requests, ...preroll]) {
      const slot = this.assigned.get(r.clip.id)
      if (!slot || r.media.kind !== 'video') continue
      if (!slot.video.paused) slot.video.pause()
      this.seek(slot, r.sourceTime)
    }
  }

  /** Playing: keeps on-screen elements running at the right rate near the clock; pre-rolls upcoming ones. */
  syncPlaying(project: Project, t: number, rate: number, requests: FrameRequest[], preroll: FrameRequest[]): void {
    const active = new Set<VideoSlot>()
    for (const r of requests) {
      const slot = this.assigned.get(r.clip.id)
      if (!slot || slot.failed || r.media.kind !== 'video') continue
      active.add(slot)
      const v = slot.video
      slot.target = null
      const speed = rate * r.clip.speed
      const holding = Math.abs(sourceTimeAt(r.clip, t) - r.sourceTime) > 1e-6
      const frame = 1 / (r.media.fps || project.sequence.fps)
      if (holding || speed <= 0 || speed > MAX_NATIVE_RATE) {
        // Step-seek: reverse, very fast shuttle, or holding an edge frame.
        if (!v.paused) v.pause()
        if (!v.seeking && Math.abs(v.currentTime - r.sourceTime) > frame / 2) v.currentTime = r.sourceTime + SEEK_EPS
        continue
      }
      if (v.playbackRate !== speed) v.playbackRate = speed
      if (!v.seeking && Math.abs(v.currentTime - r.sourceTime) > MAX_DRIFT * Math.max(1, speed)) {
        v.currentTime = Math.min(r.sourceTime + 0.05 * speed, clampSourceTime(project, r.media, Infinity))
      }
      if (v.paused) v.play().catch(() => {})
    }
    for (const r of preroll) {
      const slot = this.assigned.get(r.clip.id)
      if (!slot || active.has(slot)) continue
      active.add(slot)
      if (!slot.video.paused) slot.video.pause()
      if (!slot.video.seeking && Math.abs(slot.video.currentTime - r.sourceTime) > 0.05) slot.video.currentTime = r.sourceTime + SEEK_EPS
    }
    for (const s of this.videos) if (!active.has(s) && !s.video.paused) s.video.pause()
  }

  pauseAll(): void {
    for (const s of this.videos) {
      if (!s.video.paused) s.video.pause()
      s.target = null
      s.pending = null
    }
  }

  private seek(slot: VideoSlot, time: number): void {
    const target = time + SEEK_EPS
    if (slot.target !== null && Math.abs(slot.target - target) < 1e-6) return
    slot.target = target
    if (slot.video.seeking) {
      slot.pending = target
      return
    }
    slot.pending = null
    slot.video.currentTime = target
  }

  /** Resolves when every frame needed at t is decoded (or failed), for exact captures. */
  async prepare(project: Project, t: number, timeoutMs = 8000): Promise<void> {
    this.playing = false
    const requests = collectFrameRequests(project, t)
    this.assign(requests)
    this.seekTo(requests)
    for (const r of requests) {
      if (r.clip.type === 'title') this.getStill(r.media)
      else if (r.media.kind === 'image') this.image(r.media)
    }
    const ready = (): boolean =>
      requests.every((r) => {
        if (r.clip.type === 'title' && r.media.kind === 'video') {
          const s = this.stills.get(r.media.id)
          return !s || s.failed || !!s.snapshot
        }
        if (r.media.kind === 'image') {
          const s = this.images.get(r.media.id)
          return !s || s.failed || !!s.bitmap
        }
        const s = this.assigned.get(r.clip.id)
        if (!s || s.failed) return true
        const v = s.video
        return !v.seeking && s.pending === null && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          (s.target === null || near(v.currentTime, s.target))
      })
    const until = performance.now() + timeoutMs
    while (!ready() && performance.now() < until) await new Promise((r) => setTimeout(r, 25))
  }

  // ----------------------------------------------------------- elements ---

  private createVideo(media: MediaItem, still: boolean): VideoSlot {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    video.playsInline = true
    video.disablePictureInPicture = true
    const slot: VideoSlot = {
      key: `${media.id}#${this.nextKey++}`, mediaId: media.id, url: urlOf(media), video, clipId: null, still,
      lastUsed: performance.now(), target: null, pending: null, snapshot: null, failed: false
    }
    video.addEventListener('seeked', () => {
      if (slot.pending !== null) {
        const p = slot.pending
        slot.pending = null
        if (!near(p, video.currentTime)) {
          video.currentTime = p
          return
        }
      }
      if (slot.still || !this.playing) this.snap(slot)
      this.changed()
    })
    video.addEventListener('loadeddata', () => {
      if (!video.seeking) this.snap(slot)
      this.changed()
    })
    video.addEventListener('error', () => {
      slot.failed = true
      this.changed()
    })
    video.src = slot.url
    mediaHost().appendChild(video)
    if (!still) this.videos.push(slot)
    return slot
  }

  private snap(slot: VideoSlot): void {
    const v = slot.video
    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !v.videoWidth) return
    const c = slot.snapshot ?? document.createElement('canvas')
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
      c.width = v.videoWidth
      c.height = v.videoHeight
    }
    c.getContext('2d')!.drawImage(v, 0, 0)
    slot.snapshot = c
  }

  private image(media: MediaItem): CanvasImageSource | null {
    const url = urlOf(media)
    let s = this.images.get(media.id)
    if (!s || s.url !== url) {
      s?.bitmap?.close()
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      const slot: ImageSlot = { url, img, bitmap: null, failed: false, lastUsed: performance.now() }
      img.onload = () => {
        createImageBitmap(img)
          .then((b) => {
            if (this.images.get(media.id) === slot) slot.bitmap = b
            else b.close()
          })
          .catch(() => {})
          .finally(() => this.changed())
      }
      img.onerror = () => {
        slot.failed = true
        this.changed()
      }
      img.src = url
      this.images.set(media.id, slot)
      s = slot
    }
    s.lastUsed = performance.now()
    return s.bitmap ?? (s.img.complete && s.img.naturalWidth ? s.img : null)
  }

  private destroy(slot: VideoSlot): void {
    slot.video.pause()
    slot.video.removeAttribute('src')
    slot.video.load()
    slot.video.remove()
    slot.snapshot = null
  }

  /** Releases decoders for media that hasn't been on screen for a while. */
  gc(): void {
    const now = performance.now()
    const idle = (s: { lastUsed: number }): boolean => now - s.lastUsed > IDLE_RELEASE_MS
    const keep: VideoSlot[] = []
    const byAge = [...this.videos].sort((a, b) => b.lastUsed - a.lastUsed)
    for (const s of byAge) {
      if (this.isAssigned(s) || (!idle(s) && keep.length < MAX_VIDEO_SLOTS)) keep.push(s)
      else this.destroy(s)
    }
    if (keep.length !== this.videos.length) this.videos = this.videos.filter((s) => keep.includes(s))
    for (const [id, s] of this.stills) if (idle(s)) {
      this.destroy(s)
      this.stills.delete(id)
    }
    for (const [id, s] of this.images) if (idle(s)) {
      s.bitmap?.close()
      this.images.delete(id)
    }
  }

  dispose(): void {
    for (const s of this.videos) this.destroy(s)
    for (const s of this.stills.values()) this.destroy(s)
    for (const s of this.images.values()) s.bitmap?.close()
    this.videos = []
    this.stills.clear()
    this.images.clear()
    this.assigned.clear()
    this.onChange = null
  }

  private changed(): void {
    this.onChange?.()
  }
}

// ---------------------------------------------------------------- engine ----

class Engine implements PreviewEngine {
  readonly frames = new MediaPool()
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private running = false
  private raf = 0
  private queued = false
  private settingTime = false
  private clock = { t: 0, wall: 0, rate: 1 }
  private initialized = false

  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.init()
    this.canvas = canvas
    this.ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null
    this.invalidate()
  }

  play(): void {
    usePlayback.getState().setPlaying(true)
  }

  pause(): void {
    usePlayback.getState().setPlaying(false)
  }

  togglePlay(): void {
    const pb = usePlayback.getState()
    if (!pb.playing && pb.rate !== 1) pb.setRate(1)
    pb.setPlaying(!pb.playing)
  }

  invalidate(): void {
    if (this.running || this.queued) return
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      if (!this.running) this.draw(getProject(), usePlayback.getState().time, false)
    })
  }

  private init(): void {
    if (this.initialized) return
    this.initialized = true
    this.frames.onChange = () => this.invalidate()
    useProject.subscribe((s, prev) => {
      if (s.project === prev.project) return
      if (this.running && this.clock.rate > 0) audioEngine.update(s.project)
      this.invalidate()
    })
    usePlayback.subscribe((s, prev) => {
      if (s.playing !== prev.playing) {
        if (s.playing) this.start()
        else this.stop()
        return
      }
      if (this.running && s.rate !== prev.rate) {
        this.restartClock(this.now(), s.rate)
        return
      }
      if (s.time !== prev.time && !this.settingTime) {
        if (this.running) this.restartClock(s.time, s.rate)
        else this.invalidate()
      }
    })
    if (usePlayback.getState().playing) this.start()
  }

  /** Playback range: the in/out range when looping, else the whole sequence. */
  private range(project: Project): [number, number] {
    const end = sequenceDuration(project)
    const { loop, inPoint, outPoint } = usePlayback.getState()
    if (!loop) return [0, end]
    const lo = inPoint ?? 0
    const hi = outPoint ?? end
    return hi > lo ? [lo, hi] : [0, end]
  }

  private start(): void {
    if (this.running) return
    const project = getProject()
    const pb = usePlayback.getState()
    const [lo, hi] = this.range(project)
    const frame = 1 / project.sequence.fps
    if (hi <= 0 || pb.rate === 0) {
      pb.setPlaying(false)
      return
    }
    let t = pb.time
    if (pb.rate > 0 && (t >= hi - frame / 2 || (pb.loop && t < lo))) t = lo
    if (pb.rate < 0 && t <= lo + frame / 2) {
      if (!pb.loop) {
        pb.setPlaying(false)
        return
      }
      t = hi - frame
    }
    this.running = true
    this.frames.playing = true
    this.restartClock(t, pb.rate)
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(this.tick)
  }

  private stop(): void {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.raf)
    audioEngine.stop()
    this.frames.playing = false
    this.frames.pauseAll()
    this.invalidate()
  }

  private restartClock(t: number, rate: number): void {
    audioEngine.stop()
    this.clock = { t, wall: performance.now(), rate }
    if (rate > 0) audioEngine.start(getProject(), t, rate)
    this.setTime(t)
  }

  private now(): number {
    const audio = this.clock.rate > 0 ? audioEngine.clockTime() : null
    return audio ?? this.clock.t + ((performance.now() - this.clock.wall) / 1000) * this.clock.rate
  }

  private setTime(t: number): void {
    this.settingTime = true
    try {
      usePlayback.getState().setTime(t)
    } finally {
      this.settingTime = false
    }
  }

  private tick = (): void => {
    if (!this.running) return
    const project = getProject()
    const pb = usePlayback.getState()
    const [lo, hi] = this.range(project)
    let t = this.now()
    if (pb.rate > 0 && t >= hi) {
      if (!pb.loop) {
        this.setTime(hi)
        pb.setPlaying(false)
        return
      }
      t = lo
      this.restartClock(lo, pb.rate)
    } else if (pb.rate < 0 && t <= lo) {
      if (!pb.loop) {
        this.setTime(lo)
        pb.setPlaying(false)
        return
      }
      t = hi - 1 / project.sequence.fps
      this.restartClock(t, pb.rate)
    }
    this.setTime(t)
    this.draw(project, t, true)
    this.raf = requestAnimationFrame(this.tick)
  }

  /** Clips that come on screen within the next second, with the source time of their first visible frame. */
  private prerollRequests(project: Project, t: number, rate: number, current: FrameRequest[]): FrameRequest[] {
    const have = new Set(current.map((r) => r.clip.id))
    const out: FrameRequest[] = []
    for (const ahead of [0.5, PREROLL]) {
      for (const r of collectFrameRequests(project, t + ahead * rate)) {
        if (have.has(r.clip.id) || r.media.kind !== 'video' || r.clip.type !== 'media') continue
        have.add(r.clip.id)
        const tin = r.clip.transitionIn
        const firstVisible = tin && clipBefore(project, r.clip) ? r.clip.start - tin.duration / 2 : r.clip.start
        const sourceTime = clampSourceTime(project, r.media, sourceTimeAt(r.clip, Math.max(t, firstVisible)))
        out.push({ ...r, sourceTime })
      }
    }
    return out
  }

  private draw(project: Project, t: number, playing: boolean): void {
    const requests = collectFrameRequests(project, t)
    const rate = usePlayback.getState().rate
    const preroll = playing && rate > 0 ? this.prerollRequests(project, t, rate, requests) : []
    this.frames.assign(requests, preroll)
    if (playing) this.frames.syncPlaying(project, t, rate, requests, preroll)
    else this.frames.seekTo(requests)
    if (this.canvas && this.ctx && this.canvas.width > 0) {
      renderFrame(this.ctx, project, t, this.frames, { scale: this.canvas.width / project.sequence.width })
    }
    this.frames.gc()
  }
}

export const preview: PreviewEngine = new Engine()

/** A fresh, independent frame provider (e.g. for captures that must not disturb the monitor). Call dispose() after use. */
export function createMediaPool(): MediaPool {
  return new MediaPool()
}
