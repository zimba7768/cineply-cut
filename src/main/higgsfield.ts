// Higgsfield API client (main process). The renderer calls these through window.cineply.invoke('hf:...')
// and receives job updates on the 'hf:job' channel. Credentials never leave the main process except
// when the Settings dialog loads them for editing.

import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, promises as fsp } from 'node:fs'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getSecret, getSetting, mediaDir, send } from './index'
import { cancelFfmpeg, ffprobe, runFfmpeg } from './ffmpeg'
import { registerTtsIpc } from './tts'

const BASE = 'https://api.higgsfield.ai'
const HISTORY_LIMIT = 100

// ---------------------------------------------------------------- types ----
// Keep in sync with src/renderer/src/lib/higgsfield.ts.

export type HfKind = 'text-to-video' | 'image-to-video' | 'text-to-image' | 'audio'

export type HfJobStatus =
  | 'uploading' | 'submitting' | 'queued' | 'in_progress' | 'downloading'
  | 'completed' | 'failed' | 'nsfw' | 'canceled'

export interface HfJob {
  id: string
  kind: HfKind
  endpoint: string
  model: string // display name
  prompt: string
  params: Record<string, unknown>
  status: HfJobStatus
  message?: string
  requestId?: string
  correlationId?: string
  error?: string
  createdAt: number
  finishedAt?: number
  /** Local files of the result (video / images / extracted audio). */
  outputs: string[]
  mock: boolean
}

export interface HfGenerateRequest {
  kind: HfKind
  endpoint: string
  params: Record<string, unknown>
  model?: string
  inputImagePath?: string
}

const FINISHED: HfJobStatus[] = ['completed', 'failed', 'nsfw', 'canceled']
const isFinished = (s: HfJobStatus): boolean => FINISHED.includes(s)

// --------------------------------------------------------------- errors ----

class HfError extends Error {
  constructor(message: string, readonly status = 0, readonly correlationId?: string, readonly retryAfter?: number) {
    super(message)
  }
}

class CanceledError extends Error {
  constructor() {
    super('Canceled')
  }
}

function formatDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (d && typeof d === 'object') {
          const loc = Array.isArray((d as { loc?: unknown[] }).loc)
            ? (d as { loc: unknown[] }).loc.filter((p) => p !== 'body').join('.')
            : ''
          const msg = String((d as { msg?: unknown }).msg ?? JSON.stringify(d))
          return loc ? `${loc}: ${msg}` : msg
        }
        return String(d)
      })
      .join('; ')
  }
  return detail === undefined ? '' : JSON.stringify(detail)
}

function friendlyMessage(status: number, detail: string, retryAfter?: number): string {
  switch (status) {
    case 400:
      return `Higgsfield rejected the request${detail ? `: ${detail}` : '.'}`
    case 401:
      return 'Higgsfield rejected your API key. Check the key ID and secret in Settings.'
    case 403:
      return 'Not enough Higgsfield credits for this generation. Top up your balance, then try again.'
    case 404:
      return 'This model or request isn’t available to your Higgsfield account.'
    case 409:
      return 'That request is still running.'
    case 422:
      return `Some settings aren’t valid for this model${detail ? `: ${detail}` : '.'}`
    case 423:
      return 'This model is temporarily blocked. Try again later or pick another model.'
    case 429:
      return `Your Higgsfield queue is full. Try again${retryAfter ? ` in ${retryAfter} s` : ' shortly'}.`
    default:
      if (status >= 500) return `Higgsfield is having trouble right now (HTTP ${status}). Try again in a moment.`
      return `Higgsfield request failed (HTTP ${status})${detail ? `: ${detail}` : ''}`
  }
}

function withCorrelation(message: string, correlationId?: string): string {
  return correlationId ? `${message} (correlation ID ${correlationId})` : message
}

function errorText(e: unknown): string {
  if (e instanceof HfError) return withCorrelation(e.message, e.correlationId)
  if (e instanceof Error) {
    if (e.name === 'TimeoutError') return 'Higgsfield didn’t respond in time. Check your connection and try again.'
    if (e.message === 'fetch failed') return 'Couldn’t reach Higgsfield. Check your internet connection.'
    return e.message
  }
  return String(e)
}

const isRetryable = (e: unknown): boolean =>
  e instanceof HfError ? e.status === 0 || e.status === 429 || e.status >= 500 : !(e instanceof CanceledError)

// ----------------------------------------------------------- http client ----

interface Credentials {
  keyId: string
  keySecret: string
}

async function storedCredentials(): Promise<Credentials | null> {
  const keyId = (await getSecret('higgsfield.keyId'))?.trim()
  const keySecret = (await getSecret('higgsfield.keySecret'))?.trim()
  return keyId && keySecret ? { keyId, keySecret } : null
}

async function requireCredentials(): Promise<Credentials> {
  const c = await storedCredentials()
  if (!c) throw new HfError('Add your Higgsfield API key in Settings first.', 401)
  return c
}

async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; idempotencyKey?: string; creds?: Credentials; signal?: AbortSignal } = {}
): Promise<T> {
  const creds = opts.creds ?? (await requireCredentials())
  const headers: Record<string, string> = {
    Authorization: `Key ${creds.keyId}:${creds.keySecret}`,
    Accept: 'application/json'
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  const signals = [AbortSignal.timeout(60_000), ...(opts.signal ? [opts.signal] : [])]
  let res: Response
  try {
    res = await fetch(`${BASE}/${path.replace(/^\//, '')}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.any(signals)
    })
  } catch (e) {
    if (opts.signal?.aborted) throw new CanceledError()
    throw new HfError(errorText(e), 0)
  }
  const correlationId = res.headers.get('x-correlation-id') ?? undefined
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { detail: text.slice(0, 300) }
  }
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('retry-after')) || undefined
    const detail = formatDetail((json as { detail?: unknown }).detail)
    if (correlationId) console.warn(`[higgsfield] HTTP ${res.status} on ${method} ${path} (correlation ${correlationId})`)
    throw new HfError(friendlyMessage(res.status, detail, retryAfter), res.status, correlationId, retryAfter)
  }
  return json as T
}

// ----------------------------------------------------------- settings ----

async function mockEnabled(): Promise<boolean> {
  return process.env['CINEPLY_HF_MOCK'] === '1' || (await getSetting<boolean>('higgsfield.mock')) === true
}

// ------------------------------------------------------------ job store ----

interface JobState {
  job: HfJob
  abort: AbortController
  cancelRequested: boolean
  ffmpegJob?: string
}

const jobs = new Map<string, JobState>()
const historyFile = (): string => join(app.getPath('userData'), 'higgsfield-jobs.json')
let persistTimer: ReturnType<typeof setTimeout> | undefined
let loaded: Promise<void> | null = null

function persistSoon(): void {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    const list = [...jobs.values()].map((s) => s.job).sort((a, b) => b.createdAt - a.createdAt).slice(0, HISTORY_LIMIT)
    fsp.writeFile(historyFile(), JSON.stringify(list, null, 2), 'utf8').catch((e) => console.warn('[higgsfield] history save failed', e))
  }, 500)
}

function emit(st: JobState, patch: Partial<HfJob>): void {
  Object.assign(st.job, patch)
  if (isFinished(st.job.status) && !st.job.finishedAt) st.job.finishedAt = Date.now()
  send('hf:job', { ...st.job })
  persistSoon()
}

/** Loads the job history. Jobs that were waiting on Higgsfield when the app quit resume polling. */
function loadHistory(): Promise<void> {
  loaded ??= (async () => {
    let list: HfJob[] = []
    try {
      list = JSON.parse(await fsp.readFile(historyFile(), 'utf8'))
    } catch {
      return
    }
    for (const job of list) {
      const st: JobState = { job, abort: new AbortController(), cancelRequested: false }
      jobs.set(job.id, st)
      if (isFinished(job.status)) continue
      if (job.requestId && !job.mock) {
        job.message = 'Resuming…'
        void poll(st).catch((e) => fail(st, e))
      } else {
        job.status = 'failed'
        job.error = 'Interrupted when Cineply Cut closed.'
        job.finishedAt = Date.now()
      }
    }
    persistSoon()
  })()
  return loaded
}

function fail(st: JobState, e: unknown): void {
  if (e instanceof CanceledError || st.cancelRequested) {
    emit(st, { status: 'canceled', message: 'Canceled' })
    return
  }
  const error = errorText(e)
  console.warn(`[higgsfield] job ${st.job.id} failed: ${error}`)
  emit(st, {
    status: 'failed',
    error,
    message: undefined,
    correlationId: e instanceof HfError ? e.correlationId ?? st.job.correlationId : st.job.correlationId
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CanceledError())
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new CanceledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ----------------------------------------------------------- file names ----

function slug(s: string, max = 40): string {
  const out = s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, max).replace(/-+$/, '')
  return out.toLowerCase() || 'untitled'
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function aiDir(): Promise<string> {
  const dir = join(await mediaDir(), 'AI')
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

async function tempDir(): Promise<string> {
  const dir = join(app.getPath('temp'), 'cineply-cut', 'higgsfield')
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

/** e.g. "sunlit-coastal-road_kling-video-v3.0_20261028-091500.mp4" in <mediaDir>/AI. */
async function outputPath(job: HfJob, ext: string, index?: number, tag?: string): Promise<string> {
  const model = job.endpoint.split('/').slice(0, 2).join('-').replace(/[^\w.-]/g, '')
  const parts = [job.mock ? 'mock' : '', slug(job.prompt), model, stamp(), tag ?? ''].filter(Boolean)
  const base = parts.join('_') + (index !== undefined ? `-${index + 1}` : '')
  const dir = await aiDir()
  let path = join(dir, `${base}.${ext}`)
  for (let n = 2; existsSync(path); n++) path = join(dir, `${base} (${n}).${ext}`)
  return path
}

// --------------------------------------------------------------- upload ----

const UPLOAD_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif'
}

/** Converts unsupported or oversized images to PNG so Higgsfield accepts them. */
async function prepareImage(path: string, st: JobState): Promise<{ file: string; type: string }> {
  const type = UPLOAD_TYPES[extname(path).toLowerCase()]
  const size = (await fsp.stat(path)).size
  if (type && size < 20 * 1024 * 1024) return { file: path, type }
  const out = join(await tempDir(), `${st.job.id}-input.png`)
  st.ffmpegJob = `hf-convert-${st.job.id}`
  const r = await runFfmpeg(
    ['-i', path, '-frames:v', '1', '-vf', "scale='min(3840,iw)':'min(3840,ih)':force_original_aspect_ratio=decrease", out],
    st.ffmpegJob
  )
  st.ffmpegJob = undefined
  if (r.cancelled) throw new CanceledError()
  if (r.code !== 0) throw new Error('Couldn’t convert the input image for upload.')
  return { file: out, type: 'image/png' }
}

async function uploadImage(path: string, st: JobState): Promise<string> {
  const { file, type } = await prepareImage(path, st)
  const target = await api<{ public_url: string; upload_url: string; upload_headers?: Record<string, string> }>(
    'POST', '/files/generate-upload-url', { body: { content_type: type }, signal: st.abort.signal }
  )
  if (!/^https:\/\//i.test(target.upload_url)) throw new Error('Higgsfield returned an invalid upload URL.')
  // The presigned URL carries its own authorization: never send API credentials there.
  const res = await fetch(target.upload_url, {
    method: 'PUT',
    headers: target.upload_headers ?? { 'Content-Type': type },
    body: await fsp.readFile(file),
    signal: st.abort.signal
  }).catch((e) => {
    if (st.abort.signal.aborted) throw new CanceledError()
    throw new Error(`Image upload failed: ${errorText(e)}`)
  })
  if (!res.ok) throw new Error(`Image upload failed (HTTP ${res.status}).`)
  return target.public_url
}

// ------------------------------------------------------- submit & poll ----

interface RequestStatus {
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled'
  request_id: string
  error?: string | null
  images?: { url: string }[]
  video?: { url: string }
  audio?: { url: string }
  audios?: { url: string }[]
}

async function submit(st: JobState): Promise<void> {
  const key = randomUUID()
  // Retry queue-full / transient errors with the same idempotency key so we never double-charge.
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await api<RequestStatus>('POST', `/${st.job.endpoint}`, {
        body: st.job.params, idempotencyKey: key, signal: st.abort.signal
      })
      emit(st, { status: 'queued', requestId: r.request_id, message: 'Waiting in queue…' })
      return
    } catch (e) {
      if (!isRetryable(e) || attempt >= 3 || st.cancelRequested) throw e
      const wait = Math.min(60, (e instanceof HfError && e.retryAfter) || 5 * (attempt + 1))
      emit(st, { message: `${errorText(e)} Retrying in ${wait} s…` })
      await sleep(wait * 1000, st.abort.signal)
    }
  }
}

async function poll(st: JobState): Promise<void> {
  let delay = 2000
  let failures = 0
  for (;;) {
    await sleep(delay + Math.random() * 1000, st.abort.signal)
    let s: RequestStatus
    try {
      s = await api<RequestStatus>('GET', `/requests/${st.job.requestId}/status`, { signal: st.abort.signal })
      failures = 0
    } catch (e) {
      if (!isRetryable(e) || ++failures > 10) throw e
      emit(st, { message: 'Connection problem, retrying…' })
      delay = Math.min(10_000, delay * 1.5)
      continue
    }
    switch (s.status) {
      case 'queued':
        if (st.job.status !== 'queued' || st.job.message !== 'Waiting in queue…') emit(st, { status: 'queued', message: 'Waiting in queue…' })
        break
      case 'in_progress':
        if (st.job.status !== 'in_progress' || st.job.message !== 'Generating…') emit(st, { status: 'in_progress', message: 'Generating…' })
        break
      case 'completed':
        await finish(st, s)
        return
      case 'nsfw':
        emit(st, { status: 'nsfw', error: 'Higgsfield blocked this result by its content filter. You weren’t charged.', message: undefined })
        return
      case 'failed':
        emit(st, { status: 'failed', error: `Generation failed${s.error ? `: ${s.error}` : '.'} You weren’t charged.`, message: undefined })
        return
      case 'canceled':
        emit(st, { status: 'canceled', message: 'Canceled' })
        return
    }
    delay = Math.min(10_000, delay * 1.5)
  }
}

async function download(url: string, dest: string, signal: AbortSignal): Promise<void> {
  if (!/^https:\/\//i.test(url)) throw new Error('Refusing to download a non-https result URL.')
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`Couldn’t download the result (HTTP ${res.status}).`)
  const part = `${dest}.part`
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(part), { signal })
    await fsp.rename(part, dest)
  } catch (e) {
    await fsp.rm(part, { force: true })
    if (signal.aborted) throw new CanceledError()
    throw e
  }
}

function extFromUrl(url: string, fallback: string): string {
  try {
    const ext = extname(new URL(url).pathname).slice(1).toLowerCase()
    return /^(mp4|mov|webm|png|jpe?g|webp|gif|wav|mp3|m4a|aac|ogg|flac)$/.test(ext) ? ext : fallback
  } catch {
    return fallback
  }
}

async function finish(st: JobState, s: RequestStatus): Promise<void> {
  const urls: { url: string; fallback: string }[] = []
  if (s.video?.url) urls.push({ url: s.video.url, fallback: 'mp4' })
  for (const img of s.images ?? []) urls.push({ url: img.url, fallback: 'png' })
  if (s.audio?.url) urls.push({ url: s.audio.url, fallback: 'mp3' })
  for (const a of s.audios ?? []) urls.push({ url: a.url, fallback: 'mp3' })
  if (!urls.length) throw new Error('Higgsfield finished but returned no files.')

  const files: string[] = []
  for (let i = 0; i < urls.length; i++) {
    emit(st, { status: 'downloading', message: urls.length > 1 ? `Downloading ${i + 1} of ${urls.length}…` : 'Downloading…' })
    const dest = await outputPath(st.job, extFromUrl(urls[i].url, urls[i].fallback), urls.length > 1 ? i : undefined)
    await download(urls[i].url, dest, st.abort.signal)
    files.push(dest)
  }
  await complete(st, files)
}

/** Final step for real and mock jobs: soundtrack jobs keep only the audio. */
async function complete(st: JobState, files: string[]): Promise<void> {
  let outputs = files
  if (st.job.kind === 'audio') {
    const video = files.find((f) => /\.(mp4|mov|webm)$/i.test(f))
    const audio = files.find((f) => /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(f))
    outputs = audio ? [audio] : video ? [await extractAudio(st, video)] : files
  }
  emit(st, { status: 'completed', outputs, message: undefined })
}

async function extractAudio(st: JobState, video: string): Promise<string> {
  emit(st, { status: 'downloading', message: 'Extracting the soundtrack…' })
  const info = await ffprobe(video)
  if (!info.hasAudio) throw new Error('The model returned a video without sound. Try a model that supports sound.')
  const out = await outputPath(st.job, 'wav', undefined, 'soundtrack')
  st.ffmpegJob = `hf-audio-${st.job.id}`
  const r = await runFfmpeg(['-i', video, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le', '-ar', '48000', out], st.ffmpegJob, info.duration)
  st.ffmpegJob = undefined
  if (r.cancelled) throw new CanceledError()
  if (r.code !== 0) throw new Error('Couldn’t extract the soundtrack from the generated video.')
  return out
}

async function runJob(st: JobState, inputImagePath?: string): Promise<void> {
  if (inputImagePath) {
    emit(st, { status: 'uploading', message: 'Uploading the input image…' })
    const url = await uploadImage(inputImagePath, st)
    st.job.params = { ...st.job.params, image_url: url }
  }
  if (st.cancelRequested) throw new CanceledError()
  emit(st, { status: 'submitting', message: 'Submitting…' })
  await submit(st)
  if (st.cancelRequested) await cancelRemote(st)
  await poll(st)
}

// ------------------------------------------------------------------ mock ----

const MOCK_PALETTES = [
  ['0x3a1c71', '0xd76d77', '0xffaf7b'],
  ['0x0f2027', '0x2c5364', '0x00b4db'],
  ['0x42275a', '0x734b6d', '0xf8b195'],
  ['0x134e5e', '0x71b280', '0xe0f7a3']
]

function mockSize(aspect: unknown, longSide: number): [number, number] {
  const m = /^(\d+):(\d+)$/.exec(String(aspect ?? '16:9'))
  const [aw, ah] = m ? [Number(m[1]), Number(m[2])] : [16, 9]
  const even = (n: number): number => Math.round(n / 2) * 2
  return aw >= ah ? [longSide, even((longSide * ah) / aw)] : [even((longSide * aw) / ah), longSide]
}

/** Escapes a value for an ffmpeg filter option, then for the filter graph. */
function filterArg(s: string): string {
  const opt = s.replace(/[\\':]/g, (c) => `\\${c}`)
  return opt.replace(/[\\'[\],;]/g, (c) => `\\${c}`)
}

function wrapText(text: string, width = 38, maxLines = 6): string {
  const lines: string[] = []
  let line = ''
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if ((line + ' ' + word).trim().length > width && line) {
      lines.push(line)
      line = word
    } else line = (line + ' ' + word).trim()
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    lines.length = maxLines
    lines[maxLines - 1] += ' …'
  }
  return lines.join('\n') || '(no prompt)'
}

function wantsSound(job: HfJob): boolean {
  if (job.kind === 'audio') return true
  if (job.kind === 'text-to-image') return false
  return job.params['sound'] === 'on' || job.params['generate_audio'] === true
}

async function renderMock(st: JobState, inputImagePath: string | undefined, index: number): Promise<string> {
  const job = st.job
  const isImage = job.kind === 'text-to-image'
  const [w, h] = mockSize(job.params['aspect_ratio'], isImage ? 1024 : 1280)
  const duration = Math.min(15, Math.max(1, Number(job.params['duration']) || 5))
  const tmp = await tempDir()
  const textFile = join(tmp, `${job.id}-prompt.txt`)
  await fsp.writeFile(textFile, wrapText(job.prompt), 'utf8')
  const font = ['C:\\Windows\\Fonts\\segoeui.ttf', 'C:\\Windows\\Fonts\\arial.ttf'].find((f) => existsSync(f))
  const fontArg = font ? `fontfile=${filterArg(font.replace(/\\/g, '/'))}:` : ''
  const label = filterArg(`MOCK · ${job.model}`)
  const draw =
    `drawtext=${fontArg}textfile=${filterArg(textFile.replace(/\\/g, '/'))}:expansion=none:fontcolor=white:` +
    `fontsize=${Math.round(h / 16)}:line_spacing=8:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.35:boxborderw=24,` +
    `drawtext=${fontArg}text=${label}:expansion=none:fontcolor=white@0.75:fontsize=${Math.round(h / 34)}:x=24:y=h-th-24`
  const palette = MOCK_PALETTES[(job.prompt.length + index) % MOCK_PALETTES.length]
  const gradient = `gradients=s=${w}x${h}:r=30:d=${duration}:speed=0.015:nb_colors=3:c0=${palette[0]}:c1=${palette[1]}:c2=${palette[2]}`

  const args: string[] = []
  if (inputImagePath) {
    args.push('-loop', '1', '-t', String(duration), '-i', inputImagePath)
  } else {
    args.push('-f', 'lavfi', '-i', gradient)
  }
  const sound = wantsSound(job)
  if (sound && !isImage) {
    const chord = '0.12*sin(2*PI*220*t)+0.08*sin(2*PI*277.18*t)+0.08*sin(2*PI*329.63*t)'
    args.push('-f', 'lavfi', '-i', `aevalsrc=${chord}*min(1\\,t)*min(1\\,${duration}-t):s=48000:d=${duration}`)
  }
  const fit = inputImagePath ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30,` : ''
  args.push('-vf', fit + draw)
  const out = await outputPath(job, isImage ? 'png' : 'mp4', isImage && index > 0 ? index : undefined)
  if (isImage) args.push('-frames:v', '1', out)
  else {
    args.push('-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p')
    if (sound) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
    args.push('-movflags', '+faststart', out)
  }
  st.ffmpegJob = `hf-mock-${job.id}`
  const r = await runFfmpeg(args, st.ffmpegJob, duration)
  st.ffmpegJob = undefined
  await fsp.rm(textFile, { force: true })
  if (r.cancelled) throw new CanceledError()
  if (r.code !== 0) throw new Error(`Mock render failed: ${r.stderrTail.split('\n').filter(Boolean).slice(-2).join(' ')}`)
  return out
}

async function runMockJob(st: JobState, inputImagePath?: string): Promise<void> {
  const signal = st.abort.signal
  if (inputImagePath) {
    emit(st, { status: 'uploading', message: 'Uploading the input image… (mock)' })
    await sleep(700, signal)
  }
  emit(st, { status: 'queued', requestId: `mock-${randomUUID()}`, message: 'Waiting in queue… (mock)' })
  await sleep(1500, signal)
  for (const pct of [15, 40, 70, 90]) {
    emit(st, { status: 'in_progress', message: `Generating… ${pct}% (mock)` })
    await sleep(900, signal)
  }
  emit(st, { status: 'downloading', message: 'Rendering the mock result…' })
  const count = st.job.kind === 'text-to-image' ? Math.max(1, Math.min(4, Number(st.job.params['batch_size']) || 1)) : 1
  const files: string[] = []
  for (let i = 0; i < count; i++) files.push(await renderMock(st, inputImagePath, i))
  await complete(st, files)
}

// ---------------------------------------------------------------- cancel ----

async function cancelRemote(st: JobState): Promise<{ ok: boolean; message: string }> {
  try {
    await api('POST', `/requests/${st.job.requestId}/cancel`)
    emit(st, { status: 'canceled', message: 'Canceled' })
    st.abort.abort()
    return { ok: true, message: 'Canceled. Higgsfield refunds canceled requests.' }
  } catch (e) {
    st.cancelRequested = false
    if (e instanceof HfError && (e.status === 400 || e.status === 409)) {
      const message = 'Higgsfield has already started this generation, so it can’t be canceled now.'
      emit(st, { message: `${message} Still generating…` })
      return { ok: false, message }
    }
    return { ok: false, message: errorText(e) }
  }
}

async function cancelJob(id: string): Promise<{ ok: boolean; message: string }> {
  const st = jobs.get(id)
  if (!st) return { ok: false, message: 'Job not found.' }
  if (isFinished(st.job.status)) return { ok: true, message: 'Already finished.' }
  st.cancelRequested = true
  if (!st.job.mock && st.job.status === 'submitting') {
    // The request may already be accepted; runJob cancels it remotely once the submit returns.
    emit(st, { message: 'Canceling…' })
    return { ok: true, message: 'Canceling…' }
  }
  // Not submitted yet, a mock job, or only downloading: stop locally.
  if (st.job.mock || !st.job.requestId || st.job.status === 'downloading') {
    st.abort.abort()
    if (st.ffmpegJob) cancelFfmpeg(st.ffmpegJob)
    emit(st, { status: 'canceled', message: 'Canceled' })
    return { ok: true, message: 'Canceled.' }
  }
  return cancelRemote(st)
}

// ------------------------------------------------------------------- IPC ----

async function generate(req: HfGenerateRequest): Promise<HfJob> {
  await loadHistory()
  if (!req?.endpoint || !/^[\w.-]+(\/[\w.-]+)*$/.test(req.endpoint)) throw new Error('Invalid model endpoint ID.')
  const mock = await mockEnabled()
  if (!mock) await requireCredentials()
  const job: HfJob = {
    id: `hf-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    kind: req.kind,
    endpoint: req.endpoint,
    model: req.model || req.endpoint,
    prompt: String(req.params?.['prompt'] ?? ''),
    params: { ...req.params },
    status: 'submitting',
    createdAt: Date.now(),
    outputs: [],
    mock
  }
  const st: JobState = { job, abort: new AbortController(), cancelRequested: false }
  jobs.set(job.id, st)
  emit(st, { message: 'Starting…' })
  const run = mock ? runMockJob(st, req.inputImagePath) : runJob(st, req.inputImagePath)
  run.catch((e) => fail(st, e))
  return { ...job }
}

async function testCredentials(creds?: Partial<Credentials>): Promise<{ ok: boolean; message: string }> {
  const c = creds?.keyId && creds?.keySecret ? { keyId: creds.keyId.trim(), keySecret: creds.keySecret.trim() } : await storedCredentials()
  if (!c) return { ok: false, message: 'Enter your key ID and secret first.' }
  // A status lookup on a request that can't exist is free: 404 means the key works, 401 means it doesn't.
  try {
    await api('GET', '/requests/00000000-0000-0000-0000-000000000000/status', { creds: c })
    return { ok: true, message: 'Connected to Higgsfield.' }
  } catch (e) {
    if (e instanceof HfError && (e.status === 404 || e.status === 422)) return { ok: true, message: 'Connected to Higgsfield.' }
    return { ok: false, message: errorText(e) }
  }
}

async function estimate(req: { endpoint: string; params: Record<string, unknown>; kind?: HfKind }): Promise<{ usd: number; mock?: boolean }> {
  const params = { ...req.params }
  if (req.kind === 'image-to-video' && !params['image_url']) params['image_url'] = 'https://example.com/input.jpg'
  if (!(await storedCredentials()) && (await mockEnabled())) {
    const seconds = Number(params['duration']) || 5
    const usd = req.kind === 'text-to-image' ? 0.03 * (Number(params['batch_size']) || 1) : 0.07 * seconds
    return { usd: Math.round(usd * 1000) / 1000, mock: true }
  }
  const r = await api<{ usd: string | number }>('POST', `/estimate/${req.endpoint}`, { body: params })
  return { usd: Number(r.usd) }
}

export function registerHiggsfieldIpc(): void {
  void loadHistory()
  ipcMain.handle('hf:status', async () => ({ hasCredentials: !!(await storedCredentials()), mock: await mockEnabled() }))
  ipcMain.handle('hf:testCredentials', (_e, creds?: Partial<Credentials>) => testCredentials(creds))
  ipcMain.handle('hf:estimate', async (_e, req) => {
    try {
      return await estimate(req)
    } catch (e) {
      throw new Error(errorText(e))
    }
  })
  ipcMain.handle('hf:generate', async (_e, req: HfGenerateRequest) => {
    try {
      return await generate(req)
    } catch (e) {
      throw new Error(errorText(e))
    }
  })
  ipcMain.handle('hf:cancel', (_e, id: string) => cancelJob(id))
  ipcMain.handle('hf:listJobs', async () => {
    await loadHistory()
    return [...jobs.values()].map((s) => ({ ...s.job })).sort((a, b) => b.createdAt - a.createdAt)
  })
  ipcMain.handle('hf:removeJob', (_e, id: string) => {
    const st = jobs.get(id)
    if (st && isFinished(st.job.status)) {
      jobs.delete(id)
      persistSoon()
    }
  })
  ipcMain.handle('hf:clearFinished', () => {
    for (const [id, st] of jobs) if (isFinished(st.job.status)) jobs.delete(id)
    persistSoon()
  })
  registerTtsIpc()
}
