// Main-process IPC for the audio feature: noise reduction, loudness analysis and a decodable-audio cache.
// Renderer calls these through window.cineply.invoke('audio:...').
import { app, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { ffmpegPath, ffprobe, runFfmpeg } from './ffmpeg'
import { mediaDir } from './index'

export type DenoiseStrength = 'light' | 'medium' | 'strong'
export type HumRemoval = 'off' | '50' | '60'

export interface DenoiseOptions {
  strength: DenoiseStrength
  hum: HumRemoval
  /** ffmpeg job id: progress arrives as 'ffmpeg:progress' events, cancel with ffmpeg.cancel(jobId). */
  jobId: string
}

export interface DenoiseResult {
  path: string
  /** Estimated noise floor (RMS dBFS of the quietest 10% of the audio); null when a cached result was reused. */
  noiseFloorDb: number | null
}

export interface AnalyzeOptions {
  start?: number // source seconds
  duration?: number
  jobId?: string
}

export interface LoudnessResult {
  peakDb: number // sample peak dBFS (-Infinity for silence)
  truePeakDb: number | null
  lufs: number | null // integrated loudness; null when too short or silent
  meanDb: number
}

const STRENGTH: Record<DenoiseStrength, { nr: number; floorOffset: number; nlm: boolean }> = {
  light: { nr: 12, floorOffset: 9, nlm: false },
  medium: { nr: 20, floorOffset: 12, nlm: false },
  strong: { nr: 30, floorOffset: 14, nlm: true }
}

/** Highpass plus narrow notches on the mains hum fundamental and its first harmonics. */
function cleanupFilters(hum: HumRemoval): string[] {
  const filters = [`highpass=f=${hum === 'off' ? 40 : 80}`]
  if (hum !== 'off') {
    const f0 = Number(hum)
    for (let k = 1; k <= 6; k++) filters.push(`bandreject=f=${f0 * k}:width_type=h:width=4`)
  }
  return filters
}

/**
 * Estimates the noise floor: decodes a mono 8 kHz copy through the cleanup filters and returns the
 * 10th percentile of 50 ms RMS windows, in dBFS.
 */
function estimateNoiseFloor(path: string, hum: HumRemoval): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), [
      '-hide_banner', '-nostdin', '-v', 'error', '-i', path, '-vn', '-af', cleanupFilters(hum).join(','),
      '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'
    ])
    const WINDOW = 400
    const windows: number[] = []
    let sum = 0
    let count = 0
    let carry: Buffer = Buffer.alloc(0)
    proc.stdout.on('data', (chunk: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const usable = buf.length - (buf.length % 4)
      for (let i = 0; i < usable; i += 4) {
        const v = buf.readFloatLE(i)
        sum += v * v
        if (++count === WINDOW) {
          windows.push(Math.sqrt(sum / WINDOW))
          sum = 0
          count = 0
        }
      }
      carry = buf.subarray(usable)
    })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2048)))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `ffmpeg exited ${code}`))
      if (count > WINDOW / 4) windows.push(Math.sqrt(sum / count))
      if (windows.length === 0) return resolve(-90)
      windows.sort((a, b) => a - b)
      const p10 = windows[Math.floor(windows.length * 0.1)]
      resolve(Math.max(-90, 20 * Math.log10(p10 + 1e-9)))
    })
  })
}

async function fileKey(path: string, extra: string): Promise<string> {
  const stat = await fsp.stat(path)
  return createHash('sha1').update(`${path}|${stat.size}|${stat.mtimeMs}|${extra}`).digest('hex').slice(0, 10)
}

function ffmpegError(stderrTail: string, cancelled: boolean, what: string): Error {
  return new Error(cancelled ? 'Cancelled' : `${what} failed: ${stderrTail.trim().split('\n').slice(-3).join(' ')}`)
}

/**
 * Writes a cleaned-up WAV into <mediaDir>/Processed: highpass, optional hum notches, FFT noise
 * reduction (afftdn) tuned to the measured noise floor, plus non-local-means smoothing when strong.
 */
async function denoise(path: string, opts: DenoiseOptions): Promise<DenoiseResult> {
  const preset = STRENGTH[opts.strength] ?? STRENGTH.medium
  const hum: HumRemoval = ['50', '60'].includes(opts.hum) ? opts.hum : 'off'
  const dir = join(await mediaDir(), 'Processed')
  await fsp.mkdir(dir, { recursive: true })
  const suffix = `denoised-${opts.strength}${hum === 'off' ? '' : `-hum${hum}`}`
  const out = join(dir, `${basename(path, extname(path))}.${suffix}.${await fileKey(path, suffix)}.wav`)

  if (existsSync(out)) return { path: out, noiseFloorDb: null }
  const info = await ffprobe(path)
  if (!info.hasAudio) throw new Error('This file has no audio stream')
  const noiseFloorDb = await estimateNoiseFloor(path, hum)

  // afftdn removes the most when its noise floor sits ~10 dB above the measured RMS floor.
  const nf = Math.min(-20, Math.max(-80, noiseFloorDb + preset.floorOffset))
  const filters = [...cleanupFilters(hum), `afftdn=nr=${preset.nr}:nf=${nf.toFixed(1)}`]
  if (preset.nlm) filters.push('anlmdn=s=0.0005')

  const tmp = `${out}.part.wav`
  const r = await runFfmpeg(['-i', path, '-vn', '-af', filters.join(','), '-c:a', 'pcm_s16le', tmp], opts.jobId, info.duration)
  if (r.code !== 0) {
    await fsp.rm(tmp, { force: true })
    throw ffmpegError(r.stderrTail, r.cancelled, 'Noise reduction')
  }
  await fsp.rename(tmp, out)
  return { path: out, noiseFloorDb }
}

function parseDb(text: string, re: RegExp): number | null {
  const m = re.exec(text)
  if (!m) return null
  if (/-?inf/i.test(m[1])) return -Infinity
  const v = parseFloat(m[1])
  return Number.isFinite(v) ? v : null
}

/** Sample peak, true peak and integrated loudness (EBU R128) of a file or a source range of it. */
async function analyze(path: string, opts: AnalyzeOptions = {}): Promise<LoudnessResult> {
  const args: string[] = []
  if (opts.start && opts.start > 0) args.push('-ss', opts.start.toFixed(3))
  args.push('-i', path)
  if (opts.duration && opts.duration > 0) args.push('-t', opts.duration.toFixed(3))
  args.push('-vn', '-af', 'ebur128=peak=true:framelog=verbose,volumedetect', '-f', 'null', '-')
  const jobId = opts.jobId ?? `audio-analyze-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const r = await runFfmpeg(args, jobId, opts.duration)
  if (r.code !== 0) throw ffmpegError(r.stderrTail, r.cancelled, 'Analysis')
  const text = r.stderrTail
  const peak = parseDb(text, /max_volume:\s*(-?[\d.]+|-?inf)\s*dB/)
  const mean = parseDb(text, /mean_volume:\s*(-?[\d.]+|-?inf)\s*dB/)
  const lufs = parseDb(text, /I:\s*(-?[\d.]+|-?inf)\s*LUFS/)
  const truePeak = parseDb(text, /Peak:\s*(-?[\d.]+|-?inf)\s*dBFS/)
  if (peak === null) throw new Error('Analysis failed: no level information (is there an audio stream?)')
  const silent = peak <= -90
  return {
    peakDb: silent ? -Infinity : peak,
    truePeakDb: truePeak,
    lufs: lufs === null || lufs <= -69.9 || silent ? null : lufs,
    meanDb: mean ?? -Infinity
  }
}

/**
 * Converts a file's audio to FLAC at the given sample rate (cached), for files whose audio the
 * renderer can't decode directly or that are too large to load whole (long videos).
 */
async function extract(path: string, sampleRate: number, jobId?: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'audio-cache')
  await fsp.mkdir(dir, { recursive: true })
  const out = join(dir, `${basename(path, extname(path))}.${await fileKey(path, String(sampleRate))}.flac`)
  if (existsSync(out)) return out
  const tmp = `${out}.part.flac`
  const r = await runFfmpeg(['-i', path, '-vn', '-map', '0:a:0', '-ar', String(sampleRate), '-c:a', 'flac', tmp],
    jobId ?? `audio-extract-${Date.now()}`)
  if (r.code !== 0) {
    await fsp.rm(tmp, { force: true })
    throw ffmpegError(r.stderrTail, r.cancelled, 'Audio extraction')
  }
  await fsp.rename(tmp, out)
  return out
}

export function registerAudioIpc(): void {
  ipcMain.handle('audio:denoise', (_e, path: string, opts: DenoiseOptions) => denoise(path, opts))
  ipcMain.handle('audio:analyze', (_e, path: string, opts?: AnalyzeOptions) => analyze(path, opts))
  ipcMain.handle('audio:extract', (_e, path: string, sampleRate: number, jobId?: string) => extract(path, sampleRate, jobId))
  ipcMain.handle('audio:fileSize', async (_e, path: string) => (await fsp.stat(path)).size)
}
