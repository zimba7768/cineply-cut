import {
  AudioBufferSource, CanvasSource, Mp4OutputFormat, Output, Quality, StreamTarget, canEncodeAudio, canEncodeVideo,
  type StreamTargetChunk
} from 'mediabunny'
import type { Project } from '@shared/types'
import type { ProbeResult } from '@shared/ipc'
import { collectFrameRequests, renderFrame } from '../compositor'
import { DecoderFrameProvider } from './frameProvider'
import { mixChunks, mixLength } from './audio'
import { writeWavStream } from './wav'
import { exactFps, frameCount, videoBitrate, type ExportSettings } from './settings'

export type ExportPhase = 'preparing' | 'audio' | 'video' | 'muxing' | 'finalizing'
export type EncoderUsed = 'webcodecs' | 'webcodecs+ffmpeg' | 'ffmpeg' | 'wav' | 'mp3'

export interface ExportProgress {
  phase: ExportPhase
  framesDone: number
  framesTotal: number
  /** Overall completion 0..1. */
  fraction: number
}

export interface ExportResult {
  output: string
  encoder: EncoderUsed
  probe: ProbeResult | null
  warnings: string[]
}

export interface ExportRunOptions {
  signal: AbortSignal
  onProgress(p: ExportProgress): void
  /** Used as the id of ffmpeg child jobs. */
  jobId: string
}

const api = (): typeof window.cineply => window.cineply

/** Exports [s.start, s.end) of the project to s.output. Rejects with the signal's reason when cancelled. */
export async function runExport(project: Project, s: ExportSettings, opts: ExportRunOptions): Promise<ExportResult> {
  const temps: string[] = []
  const warnings: string[] = []
  const ctx: RunContext = { project, s, opts, temps, warnings }
  try {
    let encoder: EncoderUsed
    if (s.format === 'wav') encoder = await exportWav(ctx)
    else if (s.format === 'mp3') encoder = await exportMp3(ctx)
    else encoder = await exportMp4(ctx)
    opts.onProgress({ phase: 'finalizing', framesDone: 0, framesTotal: 0, fraction: 1 })
    const probe = await api().media.probe(s.output).catch(() => null)
    return { output: s.output, encoder, probe, warnings }
  } catch (err) {
    await api().fs.remove(s.output).catch(() => undefined)
    throw opts.signal.aborted ? opts.signal.reason : err
  } finally {
    await Promise.all(temps.map((p) => api().fs.remove(p).catch(() => undefined)))
  }
}

interface RunContext {
  project: Project
  s: ExportSettings
  opts: ExportRunOptions
  temps: string[]
  warnings: string[]
}

async function tempPath(ctx: RunContext, ext: string): Promise<string> {
  const p = api().paths.join(await api().paths.tempDir(), `export-${ctx.opts.jobId}-${ctx.temps.length}.${ext}`)
  ctx.temps.push(p)
  return p
}

// ------------------------------------------------------------- audio only ----

/** Streams the mix to a 24-bit WAV, reporting progress on [base, base + weight]. */
async function writeMixWav(ctx: RunContext, path: string, base: number, weight: number): Promise<void> {
  const { project, s, opts } = ctx
  const total = mixLength(project, s.start, s.end)
  opts.onProgress({ phase: 'audio', framesDone: 0, framesTotal: 0, fraction: base })
  await writeWavStream(path, mixChunks(project, s.start, s.end, opts.signal), 24, (frames) =>
    opts.onProgress({ phase: 'audio', framesDone: 0, framesTotal: 0, fraction: base + (frames / total) * weight })
  )
  opts.signal.throwIfAborted()
}

async function exportWav(ctx: RunContext): Promise<EncoderUsed> {
  await writeMixWav(ctx, ctx.s.output, 0, 1)
  return 'wav'
}

async function exportMp3(ctx: RunContext): Promise<EncoderUsed> {
  const { s, opts } = ctx
  const wav = await tempPath(ctx, 'wav')
  await writeMixWav(ctx, wav, 0, 0.3)
  const args = ['-i', wav, '-vn', '-c:a', 'libmp3lame', '-b:a', `${Math.round(s.audioBitrate / 1000)}k`, s.output]
  await runFfmpegJob(ctx, args, `${opts.jobId}-mp3`, s.end - s.start, 0.3)
  return 'mp3'
}

/** Runs a one-shot ffmpeg job, mapping its progress onto [base, 1] and honouring cancel. */
async function runFfmpegJob(ctx: RunContext, args: string[], jobId: string, duration: number, base: number): Promise<void> {
  const { opts } = ctx
  const off = api().ffmpeg.onProgress((p) => {
    if (p.jobId !== jobId) return
    const f = duration > 0 ? Math.min(1, p.outTime / duration) : 0
    opts.onProgress({ phase: 'muxing', framesDone: 0, framesTotal: 0, fraction: base + (1 - base) * f })
  })
  const abort = (): void => void api().ffmpeg.cancel(jobId)
  opts.signal.addEventListener('abort', abort)
  try {
    const r = await api().ffmpeg.run(args, jobId, duration)
    opts.signal.throwIfAborted()
    if (r.code !== 0) throw new Error(`ffmpeg failed: ${lastLines(r.stderrTail)}`)
  } finally {
    off()
    opts.signal.removeEventListener('abort', abort)
  }
}

const lastLines = (s: string): string => s.trim().split('\n').slice(-3).join(' ')

// ------------------------------------------------------------------ video ----

/** Renders composited frames at output size, letterboxing when the output aspect differs. */
class FrameRenderer {
  readonly canvas = document.createElement('canvas')
  readonly ctx: CanvasRenderingContext2D
  readonly provider = new DecoderFrameProvider()
  private seq: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; x: number; y: number } | null = null
  private scale: number

  constructor(private project: Project, width: number, height: number, readback: boolean) {
    this.canvas.width = width
    this.canvas.height = height
    this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: readback })!
    const { width: sw, height: sh } = project.sequence
    const direct = Math.round(sh * (width / sw)) === height
    this.scale = direct ? width / sw : Math.min(width / sw, height / sh)
    if (!direct) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(sw * this.scale)
      canvas.height = Math.round(sh * this.scale)
      const ctx = canvas.getContext('2d', { alpha: false })!
      this.seq = { canvas, ctx, x: Math.round((width - canvas.width) / 2), y: Math.round((height - canvas.height) / 2) }
    }
  }

  async render(t: number): Promise<void> {
    await this.provider.prepare(collectFrameRequests(this.project, t))
    if (!this.seq) {
      renderFrame(this.ctx, this.project, t, this.provider, { scale: this.scale })
      return
    }
    renderFrame(this.seq.ctx, this.project, t, this.provider, { scale: this.scale })
    this.ctx.fillStyle = '#000'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx.imageSmoothingQuality = 'high'
    this.ctx.drawImage(this.seq.canvas, this.seq.x, this.seq.y)
  }

  async dispose(): Promise<void> {
    await this.provider.dispose()
    this.canvas.width = this.canvas.height = 0
    if (this.seq) this.seq.canvas.width = this.seq.canvas.height = 0
  }
}

/** Lets the UI breathe between frames. MessageChannel isn't throttled in background windows like setTimeout. */
let lastYield = 0
function maybeYield(): Promise<void> | void {
  if (performance.now() - lastYield < 25) return
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      lastYield = performance.now()
      resolve()
    }
    port2.postMessage(null)
  })
}

async function exportMp4(ctx: RunContext): Promise<EncoderUsed> {
  const { s, opts, warnings } = ctx
  if (s.encoder === 'ffmpeg') {
    await encodeWithFfmpeg(ctx)
    return 'ffmpeg'
  }
  opts.onProgress({ phase: 'preparing', framesDone: 0, framesTotal: frameCount(s), fraction: 0 })
  const support = await webCodecsSupport(ctx.project, s)
  if (!support.video) {
    warnings.push('Hardware H.264 encoding is not available at this size, so ffmpeg (x264) was used.')
    await encodeWithFfmpeg(ctx)
    return 'ffmpeg'
  }
  try {
    if (support.audio) {
      await encodeWithWebCodecs(ctx, s.output, true)
      return 'webcodecs'
    }
    // No AAC encoder: hardware video, then mux the mix in with ffmpeg.
    const video = await tempPath(ctx, 'mp4')
    const wav = await tempPath(ctx, 'wav')
    await encodeWithWebCodecs(ctx, video, false, 0.9)
    await writeMixWav(ctx, wav, 0.9, 0)
    const args = ['-i', video, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
      '-b:a', `${Math.round(s.audioBitrate / 1000)}k`, '-movflags', '+faststart', s.output]
    await runFfmpegJob(ctx, args, `${opts.jobId}-mux`, s.end - s.start, 0.9)
    return 'webcodecs+ffmpeg'
  } catch (err) {
    if (opts.signal.aborted) throw err
    console.warn('[export] WebCodecs export failed, retrying with ffmpeg', err)
    warnings.push(`The hardware encoder failed (${err instanceof Error ? err.message : String(err)}), so ffmpeg (x264) was used.`)
    await api().fs.remove(s.output).catch(() => undefined)
    await encodeWithFfmpeg(ctx)
    return 'ffmpeg'
  }
}

async function webCodecsSupport(project: Project, s: ExportSettings): Promise<{ video: boolean; audio: boolean }> {
  if (typeof VideoEncoder === 'undefined') return { video: false, audio: false }
  const video = await canEncodeVideo('avc', {
    width: s.width, height: s.height, frameRate: exactFps(s.fps), quality: new Quality({ bitrate: videoBitrate(s) })
  }).catch(() => false)
  const audio = await canEncodeAudio('aac', {
    numberOfChannels: 2, sampleRate: project.sequence.sampleRate, quality: new Quality({ bitrate: s.audioBitrate })
  }).catch(() => false)
  return { video, audio }
}

/** Primary path: mediabunny + WebCodecs (Media Foundation hardware encoder on Windows), streamed to disk. */
async function encodeWithWebCodecs(ctx: RunContext, path: string, withAudio: boolean, weight = 1): Promise<void> {
  const { project, s, opts } = ctx
  const fps = exactFps(s.fps)
  const frames = frameCount(s)
  const duration = frames / fps
  const fs = api().fs
  const renderer = new FrameRenderer(project, s.width, s.height, false)
  const handle = await fs.openWrite(path)
  try {
    const writable = new WritableStream<StreamTargetChunk>({
      write: (chunk) => fs.write(handle, ownBytes(chunk.data), chunk.position)
    })
    const output = new Output({
      // 'reserve' puts the moov box up front (fast start) without buffering the file in memory.
      format: new Mp4OutputFormat({ fastStart: 'reserve' }),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 2 ** 20 })
    })
    const video = new CanvasSource(renderer.canvas, {
      codec: 'avc',
      quality: new Quality({ bitrate: videoBitrate(s) }),
      keyFrameInterval: 2,
      latencyMode: 'quality'
    })
    output.addVideoTrack(video, { frameRate: fps, maximumPacketCount: frames + 8 })
    let audio: AudioBufferSource | null = null
    if (withAudio) {
      audio = new AudioBufferSource({ codec: 'aac', quality: new Quality({ bitrate: s.audioBitrate }) })
      output.addAudioTrack(audio, { maximumPacketCount: Math.ceil(duration * 100 * 1.35) + 64 })
    }
    await output.start()

    try {
      // Audio is added in chunks just ahead of the video so the muxer can interleave.
      const chunks = withAudio ? mixChunks(project, s.start, s.start + duration, opts.signal) : null
      let audioAdded = 0
      let audioDone = !chunks
      const feedAudio = async (until: number): Promise<void> => {
        while (!audioDone && audioAdded <= until) {
          const r = await chunks!.next()
          if (r.done) {
            audioDone = true
            break
          }
          await audio!.add(r.value)
          audioAdded += r.value.duration
        }
      }

      for (let i = 0; i < frames; i++) {
        opts.signal.throwIfAborted()
        const rel = i / fps
        await feedAudio(rel + 1)
        await renderer.render(s.start + rel)
        await video.add(rel, 1 / fps)
        opts.onProgress({ phase: 'video', framesDone: i + 1, framesTotal: frames, fraction: ((i + 1) / frames) * weight * 0.99 })
        await maybeYield()
      }
      await feedAudio(Infinity)
      opts.signal.throwIfAborted()
      opts.onProgress({ phase: 'finalizing', framesDone: frames, framesTotal: frames, fraction: weight * 0.995 })
      await output.finalize()
    } catch (err) {
      await output.cancel().catch(() => undefined)
      throw err
    }
  } finally {
    ctx.warnings.push(...renderer.provider.warnings)
    await renderer.dispose()
    await fs.close(handle)
  }
}

/** The muxer may hand out views into larger buffers; IPC would copy the whole backing buffer. */
function ownBytes(data: Uint8Array): Uint8Array {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice()
}

/** Fallback path: raw RGBA frames piped into ffmpeg (libx264 + AAC), see src/main/export.ts. */
async function encodeWithFfmpeg(ctx: RunContext): Promise<void> {
  const { project, s, opts } = ctx
  const fps = exactFps(s.fps)
  const frames = frameCount(s)
  const wav = await tempPath(ctx, 'wav')
  const audioWeight = 0.05
  const mixCtx = { ...ctx, s: { ...s, end: s.start + frames / fps } }
  await writeMixWav(mixCtx, wav, 0, audioWeight)

  const renderer = new FrameRenderer(project, s.width, s.height, true)
  const id = await api().invoke<string>('export:ffmpegStart', {
    output: s.output, width: s.width, height: s.height, fps, videoBitrate: videoBitrate(s),
    audioPath: wav, audioBitrate: s.audioBitrate
  })
  try {
    for (let i = 0; i < frames; i++) {
      opts.signal.throwIfAborted()
      await renderer.render(s.start + i / fps)
      const pixels = renderer.ctx.getImageData(0, 0, s.width, s.height).data
      await api().invoke('export:ffmpegWrite', id, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength))
      opts.onProgress({
        phase: 'video', framesDone: i + 1, framesTotal: frames,
        fraction: audioWeight + (1 - audioWeight) * ((i + 1) / frames) * 0.99
      })
      await maybeYield()
    }
    opts.onProgress({ phase: 'finalizing', framesDone: frames, framesTotal: frames, fraction: 0.995 })
    const r = await api().invoke<{ code: number | null; stderrTail: string }>('export:ffmpegEnd', id)
    if (r.code !== 0) throw new Error(`ffmpeg failed: ${lastLines(r.stderrTail)}`)
  } catch (err) {
    await api().invoke('export:ffmpegCancel', id).catch(() => undefined)
    throw err
  } finally {
    ctx.warnings.push(...renderer.provider.warnings)
    await renderer.dispose()
  }
}
