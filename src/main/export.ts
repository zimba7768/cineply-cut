// Main-process IPC for the export feature. Register handlers with ipcMain.handle('export:...').
// Renderer calls them through window.cineply.invoke('export:...').
//
// The ffmpeg fallback encoder: the renderer streams raw RGBA frames into ffmpeg's stdin, ffmpeg
// encodes them with libx264 and muxes the pre-rendered mix (a WAV file) as AAC.

import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { app, ipcMain } from 'electron'
import { ffmpegPath } from './ffmpeg'

export interface FfmpegExportOptions {
  output: string
  width: number
  height: number
  fps: number
  /** Target video bitrate, bits per second. */
  videoBitrate: number
  /** Mixed audio to mux in, or omitted for a silent video. */
  audioPath?: string
  audioBitrate: number
  preset?: string
}

export interface FfmpegExportResult {
  code: number | null
  cancelled: boolean
  stderrTail: string
}

interface Session {
  proc: ChildProcess
  output: string
  cancelled: boolean
  error: Error | null
  stderr: string
  exited: Promise<number | null>
}

const sessions = new Map<string, Session>()
let nextId = 1

/** ffmpeg rate string, with NTSC rates written as exact fractions (29.97 -> 30000/1001). */
function rate(fps: number): string {
  const ntsc = Math.round(fps * 1.001)
  if (Math.abs(fps - ntsc / 1.001) < 0.005 && Math.abs(fps - Math.round(fps)) > 0.005) return `${ntsc * 1000}/1001`
  return Number.isInteger(fps) ? String(fps) : `${Math.round(fps * 1000)}/1000`
}

function buildArgs(o: FfmpegExportOptions): string[] {
  const kbps = (bps: number): string => `${Math.max(1, Math.round(bps / 1000))}k`
  const args = [
    '-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-r', rate(o.fps), '-i', 'pipe:0'
  ]
  if (o.audioPath) args.push('-i', o.audioPath)
  args.push('-map', '0:v:0')
  if (o.audioPath) args.push('-map', '1:a:0')
  args.push(
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', o.preset ?? 'medium',
    '-b:v', kbps(o.videoBitrate), '-maxrate', kbps(o.videoBitrate * 1.5), '-bufsize', kbps(o.videoBitrate * 2),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'
  )
  if (o.audioPath) args.push('-c:a', 'aac', '-b:a', kbps(o.audioBitrate))
  args.push('-movflags', '+faststart', o.output)
  return args
}

function start(o: FfmpegExportOptions): string {
  const id = `ffx-${nextId++}`
  const proc = spawn(ffmpegPath(), buildArgs(o), { stdio: ['pipe', 'ignore', 'pipe'] })
  const s: Session = { proc, output: o.output, cancelled: false, error: null, stderr: '', exited: Promise.resolve(null) }
  s.exited = new Promise((resolve) => {
    proc.on('error', (err) => {
      s.error = err
      resolve(-1)
    })
    proc.on('close', (code) => resolve(code))
  })
  proc.stderr!.on('data', (d: Buffer) => {
    s.stderr = (s.stderr + d.toString()).slice(-4096)
  })
  // EPIPE when ffmpeg dies early; the next write reports the failure.
  proc.stdin!.on('error', (err) => {
    s.error ??= err
  })
  sessions.set(id, s)
  return id
}

function failure(s: Session): Error {
  const detail = s.stderr.trim().split('\n').slice(-3).join(' ')
  return new Error(`ffmpeg stopped: ${detail || s.error?.message || 'unknown error'}`)
}

async function write(id: string, data: ArrayBuffer | Uint8Array): Promise<void> {
  const s = sessions.get(id)
  if (!s) throw new Error('Export session not found')
  const stdin = s.proc.stdin!
  if (s.error || stdin.destroyed || s.proc.exitCode !== null) throw failure(s)
  const buf = data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data)
  if (stdin.write(buf)) return
  // Backpressure: wait until ffmpeg has consumed the frame (or died).
  await new Promise<void>((resolve, reject) => {
    const done = (): void => {
      stdin.off('drain', done)
      stdin.off('close', done)
      if (s.error || s.proc.exitCode !== null) reject(failure(s))
      else resolve()
    }
    stdin.on('drain', done)
    stdin.on('close', done)
  })
}

async function end(id: string): Promise<FfmpegExportResult> {
  const s = sessions.get(id)
  if (!s) throw new Error('Export session not found')
  s.proc.stdin!.end()
  const code = await s.exited
  sessions.delete(id)
  if (code !== 0) await fsp.rm(s.output, { force: true })
  return { code, cancelled: s.cancelled, stderrTail: s.stderr }
}

async function cancel(id: string): Promise<void> {
  const s = sessions.get(id)
  if (!s) return
  s.cancelled = true
  s.proc.stdin!.destroy()
  s.proc.kill('SIGKILL')
  await s.exited
  sessions.delete(id)
  await fsp.rm(s.output, { force: true })
}

export function registerExportIpc(): void {
  ipcMain.handle('export:ffmpegStart', (_e, o: FfmpegExportOptions) => start(o))
  ipcMain.handle('export:ffmpegWrite', (_e, id: string, data: ArrayBuffer | Uint8Array) => write(id, data))
  ipcMain.handle('export:ffmpegEnd', (_e, id: string) => end(id))
  ipcMain.handle('export:ffmpegCancel', (_e, id: string) => cancel(id))
  app.on('will-quit', () => {
    for (const s of sessions.values()) s.proc.kill('SIGKILL')
  })
}
