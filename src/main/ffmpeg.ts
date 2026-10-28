import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { app } from 'electron'
import { basename, extname, join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import type { FfmpegResult, ProbeResult } from '@shared/ipc'
import { send } from './index'

// In a packaged app the binaries live in app.asar.unpacked.
const unpacked = (p: string): string => p.replace('app.asar', 'app.asar.unpacked')

export function ffmpegPath(): string {
  return unpacked(ffmpegStatic as unknown as string)
}

export function ffprobePath(): string {
  return unpacked(ffprobeStatic.path)
}

const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

export async function ffprobe(path: string): Promise<ProbeResult> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `ffprobe exited ${code}`))))
  })
  const j = JSON.parse(out)
  const streams: any[] = j.streams ?? []
  const isImage = IMAGE_EXTS.has(extname(path).toLowerCase())
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic === 1 && !isImage))
  const a = streams.find((s) => s.codec_type === 'audio')
  const rate = (r?: string): number | undefined => {
    if (!r) return undefined
    const [n, d] = r.split('/').map(Number)
    return d ? n / d : n
  }
  const duration = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0
  const videoOk = !v || isImage || PLAYABLE_VIDEO.has(v.codec_name) && ['yuv420p', 'yuvj420p', undefined].includes(v.pix_fmt)
  const audioOk = !a || PLAYABLE_AUDIO.has(a.codec_name)
  const fmt: string = j.format?.format_name ?? ''
  const containerOk = isImage || /mp4|mov|webm|matroska|mp3|wav|ogg|flac|aac/.test(fmt)
  return {
    duration,
    hasVideo: !!v,
    hasAudio: !!a,
    width: v?.width,
    height: v?.height,
    fps: rate(v?.avg_frame_rate) || rate(v?.r_frame_rate),
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    pixFmt: v?.pix_fmt,
    formatName: fmt,
    playable: videoOk && audioOk && containerOk
  }
}

const jobs = new Map<string, { proc: ChildProcess; cancelled: boolean }>()

export function runFfmpeg(args: string[], jobId: string, durationHint?: number): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', ...args])
    const job = { proc, cancelled: false }
    jobs.set(jobId, job)
    let stderr = ''
    let buf = ''
    proc.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const blocks = buf.split(/progress=(continue|end)\r?\n/)
      // blocks: [kv, 'continue', kv, 'end', rest]
      while (blocks.length >= 3) {
        const kv = blocks.shift()!
        const state = blocks.shift()!
        const m = /out_time_us=(\d+)/.exec(kv) ?? /out_time_ms=(\d+)/.exec(kv)
        const sp = /speed=\s*([\d.]+x)/.exec(kv)
        send('ffmpeg:progress', {
          jobId,
          outTime: m ? Number(m[1]) / 1e6 : 0,
          speed: sp?.[1],
          done: state === 'end',
          durationHint
        })
      }
      buf = blocks.join('')
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4096)
    })
    proc.on('error', (err) => {
      jobs.delete(jobId)
      resolve({ code: -1, cancelled: false, stderrTail: String(err) })
    })
    proc.on('close', (code) => {
      jobs.delete(jobId)
      resolve({ code, cancelled: job.cancelled, stderrTail: stderr })
    })
  })
}

export function cancelFfmpeg(jobId: string): void {
  const j = jobs.get(jobId)
  if (!j) return
  j.cancelled = true
  j.proc.kill('SIGKILL')
}

/** Transcodes a file Chromium can't decode into an H.264/AAC MP4 next to other generated media. */
export async function makePlayable(path: string, jobId: string, mediaDir: string): Promise<string> {
  const stat = await fsp.stat(path)
  const hash = createHash('sha1').update(`${path}|${stat.size}|${stat.mtimeMs}`).digest('hex').slice(0, 10)
  const dir = join(mediaDir, 'Optimized')
  await fsp.mkdir(dir, { recursive: true })
  const info = await ffprobe(path)
  const isAudioOnly = !info.hasVideo
  const out = join(dir, `${basename(path, extname(path))}.${hash}.${isAudioOnly ? 'm4a' : 'mp4'}`)
  if (existsSync(out)) return out
  const tmp = out + '.part' + (isAudioOnly ? '.m4a' : '.mp4')
  const args = isAudioOnly
    ? ['-i', path, '-vn', '-c:a', 'aac', '-b:a', '256k', tmp]
    : ['-i', path, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', tmp]
  const r = await runFfmpeg(args, jobId, info.duration)
  if (r.code !== 0) {
    await fsp.rm(tmp, { force: true })
    throw new Error(r.cancelled ? 'Cancelled' : `Transcode failed: ${r.stderrTail.split('\n').slice(-4).join(' ')}`)
  }
  await fsp.rename(tmp, out)
  return out
}

export async function thumbnail(path: string, t: number, w: number): Promise<string> {
  const dir = join(app.getPath('userData'), 'thumbs')
  await fsp.mkdir(dir, { recursive: true })
  const key = createHash('sha1').update(`${path}|${t.toFixed(2)}|${w}`).digest('hex').slice(0, 16)
  const out = join(dir, `${key}.jpg`)
  if (existsSync(out)) return out
  const r = await runFfmpeg(['-ss', String(Math.max(0, t)), '-i', path, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-q:v', '4', out], `thumb-${key}`)
  if (r.code !== 0) throw new Error('Thumbnail failed')
  return out
}
