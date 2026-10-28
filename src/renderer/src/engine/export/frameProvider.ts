import { ALL_FORMATS, Input, UrlSource, VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny'
import type { Clip, MediaItem } from '@shared/types'
import type { FrameProvider } from '../frames'
import type { FrameRequest } from '../compositor'

/**
 * Frame-accurate FrameProvider for export. Call `prepare(requests)` with every frame the
 * compositor will ask for at the next output time; afterwards getFrame/getStill answer
 * synchronously. Each (clip, media) pair gets its own sequential decoder (mediabunny
 * VideoSampleSink iterator), which is efficient because export walks time forwards.
 * Decoded samples are drawn into a per-stream canvas and closed immediately, so memory
 * stays flat regardless of export length.
 */

// A frame is shown when its timestamp is within this of the requested time (float noise).
const EPS = 1e-3
// Jumping further ahead than this restarts decoding at the nearest key frame instead of decoding through.
const SEEK_AHEAD = 2.5
// Idle inputs (no active decoder) kept open for reuse when a later clip uses the same file.
const MAX_IDLE_INPUTS = 8

const mediaFile = (m: MediaItem): string => m.playbackPath ?? m.path

interface OpenInput {
  input: Input
  track: Promise<InputVideoTrack | null>
  refs: number
  lastUse: number
}

class VideoStream {
  readonly canvas = document.createElement('canvas')
  private readonly ctx = this.canvas.getContext('2d')!
  private readonly sink: VideoSampleSink
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null
  private next: VideoSample | null = null
  private ended = false
  private lastTarget = -Infinity
  hasFrame = false

  constructor(readonly path: string, track: InputVideoTrack) {
    this.sink = new VideoSampleSink(track)
  }

  /** The source time the stream is positioned at (for reusing it across cuts of the same file). */
  get position(): number {
    return this.lastTarget
  }

  /** Decodes up to source time t and draws that frame into `canvas`. Returns false if no frame exists. */
  async seek(t: number): Promise<boolean> {
    const target = t + EPS
    const backwards = target < this.lastTarget
    const farAhead = this.next !== null && target - this.next.timestamp > SEEK_AHEAD
    if (!this.iter || backwards || farAhead) await this.restart(t)
    this.lastTarget = target

    let pick: VideoSample | null = null
    for (;;) {
      if (!this.next) {
        if (this.ended) break
        const r = await this.iter!.next()
        if (r.done) {
          this.ended = true
          break
        }
        this.next = r.value
      }
      // Before the first frame, show the first frame instead of nothing.
      const take = this.next.timestamp <= target || (!this.hasFrame && !pick)
      if (!take) break
      pick?.close()
      pick = this.next
      this.next = null
      if (pick.timestamp > target) break
    }
    if (pick) {
      this.draw(pick)
      pick.close()
    }
    return this.hasFrame
  }

  private draw(sample: VideoSample): void {
    const w = sample.displayWidth
    const h = sample.displayHeight
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    sample.draw(this.ctx, 0, 0, w, h)
    this.hasFrame = true
  }

  private async restart(t: number): Promise<void> {
    await this.stopIterator()
    this.iter = this.sink.samples(Math.max(0, t))
    this.ended = false
  }

  private async stopIterator(): Promise<void> {
    this.next?.close()
    this.next = null
    const it = this.iter
    this.iter = null
    await it?.return(undefined)
  }

  async close(): Promise<void> {
    await this.stopIterator()
    this.canvas.width = this.canvas.height = 0
  }
}

export class DecoderFrameProvider implements FrameProvider {
  private inputs = new Map<string, OpenInput>()
  private streams = new Map<string, Promise<VideoStream | null>>()
  private images = new Map<string, Promise<ImageBitmap | null>>()
  private stills = new Map<string, Promise<HTMLCanvasElement | null>>()
  private ready = new Map<string, CanvasImageSource>()
  private readyStills = new Map<string, CanvasImageSource>()
  private clock = 0
  /** Human-readable problems (undecodable media etc.), reported with the export result. */
  readonly warnings = new Set<string>()

  /**
   * Decodes exactly the frames needed for one output frame (collectFrameRequests). Requests on
   * title clips are title backgrounds, served by getStill(). Resources not needed for this frame
   * are released.
   */
  async prepare(requests: FrameRequest[]): Promise<void> {
    this.clock++
    this.ready.clear()
    this.readyStills.clear()

    const videoReqs = new Map<string, FrameRequest>()
    const imageMedia = new Map<string, MediaItem>()
    const stillVideos = new Map<string, MediaItem>()
    for (const r of requests) {
      const m = r.media
      if (m.kind === 'image') imageMedia.set(m.id, m)
      else if (m.kind !== 'video' || !m.hasVideo) continue
      else if (r.clip.type === 'title') stillVideos.set(m.id, m)
      else {
        const key = streamKey(r.clip.id, m.id)
        if (!videoReqs.has(key)) videoReqs.set(key, r)
      }
    }

    // Streams no longer needed may be adopted by a new clip of the same file (e.g. razor cuts).
    const idle = [...this.streams.keys()].filter((k) => !videoReqs.has(k))
    for (const [key, r] of videoReqs) {
      if (this.streams.has(key)) continue
      const adopt = await this.findAdoptable(idle, mediaFile(r.media), r.sourceTime)
      if (adopt) {
        this.streams.set(key, this.streams.get(adopt)!)
        this.streams.delete(adopt)
        idle.splice(idle.indexOf(adopt), 1)
      }
    }
    await Promise.all(idle.map((k) => this.closeStream(k)))

    await Promise.all([
      ...[...videoReqs].map(async ([key, r]) => {
        const stream = await this.stream(key, r.media)
        try {
          if (stream && (await stream.seek(r.sourceTime))) this.ready.set(key, stream.canvas)
        } catch (err) {
          this.warn(r.media, err)
          await this.closeStream(key)
          this.streams.set(key, Promise.resolve(null))
        }
      }),
      ...[...imageMedia.values()].map(async (m) => {
        const img = await this.image(m)
        if (img) this.ready.set(imageKey(m.id), img)
      }),
      ...[...stillVideos.values()].map(async (m) => {
        const still = await this.still(m)
        if (still) this.readyStills.set(m.id, still)
      })
    ])

    for (const [id, p] of this.images) {
      if (!imageMedia.has(id)) {
        this.images.delete(id)
        void p.then((b) => b?.close())
      }
    }
    for (const id of [...this.stills.keys()]) if (!stillVideos.has(id)) this.stills.delete(id)
    this.trimInputs()
  }

  getFrame(clip: Clip, media: MediaItem): CanvasImageSource | null {
    if (media.kind === 'image') return this.ready.get(imageKey(media.id)) ?? null
    return this.ready.get(streamKey(clip.id, media.id)) ?? null
  }

  getStill(media: MediaItem): CanvasImageSource | null {
    if (media.kind === 'image') return this.ready.get(imageKey(media.id)) ?? null
    return this.readyStills.get(media.id) ?? null
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.streams.keys()].map((k) => this.closeStream(k)))
    for (const p of this.images.values()) void p.then((b) => b?.close())
    this.images.clear()
    this.stills.clear()
    this.ready.clear()
    this.readyStills.clear()
    for (const o of this.inputs.values()) o.input.dispose()
    this.inputs.clear()
  }

  // ------------------------------------------------------------------------

  private warn(media: MediaItem, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    this.warnings.add(`${media.name}: ${msg}`)
    console.warn('[export] decode problem', media.name, err)
  }

  private openInput(path: string): OpenInput {
    let o = this.inputs.get(path)
    if (!o) {
      const input = new Input({
        formats: ALL_FORMATS,
        // Local files: retry briefly, then give up (the default retries forever, e.g. on a missing file).
        source: new UrlSource(window.cineply.mediaUrl(path), {
          maxCacheSize: 16 * 2 ** 20,
          getRetryDelay: (attempts) => (attempts < 3 ? 0.2 : null)
        })
      })
      const track = input.getPrimaryVideoTrack().then(async (t) => {
        if (t && !(await t.canDecode())) throw new Error('video codec cannot be decoded on this system')
        return t
      })
      o = { input, track, refs: 0, lastUse: this.clock }
      this.inputs.set(path, o)
    }
    o.lastUse = this.clock
    return o
  }

  private stream(key: string, media: MediaItem): Promise<VideoStream | null> {
    let p = this.streams.get(key)
    if (!p) {
      const path = mediaFile(media)
      const o = this.openInput(path)
      p = o.track.then(
        (track) => {
          if (!track) return null
          o.refs++
          return new VideoStream(path, track)
        },
        (err) => {
          this.warn(media, err)
          return null
        }
      )
      this.streams.set(key, p)
    }
    return p
  }

  private async findAdoptable(idle: string[], path: string, sourceTime: number): Promise<string | null> {
    for (const key of idle) {
      const s = await this.streams.get(key)
      if (s && s.path === path && sourceTime + EPS >= s.position && sourceTime - s.position < SEEK_AHEAD) return key
    }
    return null
  }

  private async closeStream(key: string): Promise<void> {
    const p = this.streams.get(key)
    if (!p) return
    this.streams.delete(key)
    const s = await p
    if (!s) return
    await s.close()
    const o = this.inputs.get(s.path)
    if (o) {
      o.refs--
      o.lastUse = this.clock
    }
  }

  private trimInputs(): void {
    const idle = [...this.inputs].filter(([, o]) => o.refs <= 0).sort((a, b) => a[1].lastUse - b[1].lastUse)
    while (idle.length > MAX_IDLE_INPUTS) {
      const [path, o] = idle.shift()!
      o.input.dispose()
      this.inputs.delete(path)
    }
  }

  private image(media: MediaItem): Promise<ImageBitmap | null> {
    let p = this.images.get(media.id)
    if (!p) {
      p = (async () => {
        const res = await fetch(window.cineply.mediaUrl(mediaFile(media)))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return createImageBitmap(await res.blob())
      })().catch((err) => {
        this.warn(media, err)
        return null
      })
      this.images.set(media.id, p)
    }
    return p
  }

  /** First frame of a video, for title backgrounds. */
  private still(media: MediaItem): Promise<HTMLCanvasElement | null> {
    let p = this.stills.get(media.id)
    if (!p) {
      p = (async () => {
        const track = await this.openInput(mediaFile(media)).track
        if (!track) return null
        const sink = new VideoSampleSink(track)
        const sample = await sink.getSample(await track.getFirstTimestamp())
        if (!sample) return null
        const c = document.createElement('canvas')
        c.width = sample.displayWidth
        c.height = sample.displayHeight
        sample.draw(c.getContext('2d')!, 0, 0, c.width, c.height)
        sample.close()
        return c
      })().catch((err) => {
        this.warn(media, err)
        return null
      })
      this.stills.set(media.id, p)
    }
    return p
  }
}

const streamKey = (clipId: string, mediaId: string): string => `${clipId}|${mediaId}`
const imageKey = (mediaId: string): string => `img|${mediaId}`
