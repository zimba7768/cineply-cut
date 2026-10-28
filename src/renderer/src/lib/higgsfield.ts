import { create } from 'zustand'
import type { MediaItem } from '@shared/types'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { importFiles } from '@/lib/importMedia'

/**
 * Renderer side of the Higgsfield integration: the model catalog (endpoint IDs and parameter
 * schemas from docs.higgsfield.ai), typed wrappers around the 'hf:*' and 'audio:tts:*' IPC
 * channels, and a small store that mirrors generation jobs from the main process.
 */

// ---------------------------------------------------------------- types ----
// Keep in sync with src/main/higgsfield.ts.

export type HfKind = 'text-to-video' | 'image-to-video' | 'text-to-image' | 'audio'

export type HfJobStatus =
  | 'uploading' | 'submitting' | 'queued' | 'in_progress' | 'downloading'
  | 'completed' | 'failed' | 'nsfw' | 'canceled'

export interface HfJob {
  id: string
  kind: HfKind
  endpoint: string
  model: string
  prompt: string
  params: Record<string, unknown>
  status: HfJobStatus
  message?: string
  requestId?: string
  correlationId?: string
  error?: string
  createdAt: number
  finishedAt?: number
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

export const FINISHED_STATUSES: HfJobStatus[] = ['completed', 'failed', 'nsfw', 'canceled']
export const isJobFinished = (j: HfJob): boolean => FINISHED_STATUSES.includes(j.status)

export const KIND_LABELS: Record<HfKind, string> = {
  'text-to-video': 'Text → Video',
  'image-to-video': 'Image → Video',
  'text-to-image': 'Text → Image',
  audio: 'Soundtrack'
}

// --------------------------------------------------------------- schema ----

export type HfValue = string | number | boolean

export type HfField =
  | { key: string; label: string; type: 'select'; options: (string | number)[]; default: string | number; unit?: string; optional?: boolean }
  | { key: string; label: string; type: 'number'; min: number; max: number; step?: number; default?: number; unit?: string }
  | { key: string; label: string; type: 'boolean'; default: boolean }
  | { key: string; label: string; type: 'text'; default?: string; placeholder?: string }

export interface HfModel {
  id: string
  label: string
  kind: HfKind
  endpoint: string
  description?: string
  /** Prompt is required unless false. */
  promptRequired?: boolean
  promptMax?: number
  fields: HfField[]
  /** How to switch on the native soundtrack, for video models that can make sound. */
  sound?: { key: string; on: HfValue }
  /** Custom models: raw JSON object merged into the request body. */
  rawParams?: string
  custom?: boolean
}

const duration = (min: number, max: number, def: number): HfField =>
  ({ key: 'duration', label: 'Duration', type: 'number', min, max, step: 1, default: def, unit: 's' })
const durationOf = (options: number[], def: number): HfField =>
  ({ key: 'duration', label: 'Duration', type: 'select', options, default: def, unit: 's' })
const aspect = (options: string[], def: string): HfField => ({ key: 'aspect_ratio', label: 'Aspect ratio', type: 'select', options, default: def })
const resolution = (options: string[], def: string): HfField => ({ key: 'resolution', label: 'Resolution', type: 'select', options, default: def })
const flag = (key: string, label: string, def: boolean): HfField => ({ key, label, type: 'boolean', default: def })
const seed = (min: number, max: number): HfField => ({ key: 'seed', label: 'Seed', type: 'number', min, max, step: 1 })
const negative: HfField = { key: 'negative_prompt', label: 'Avoid', type: 'text', placeholder: 'Negative prompt (optional)' }
const klingSound: HfField = { key: 'sound', label: 'Sound', type: 'select', options: ['on', 'off'], default: 'on' }
const cfg: HfField = { key: 'cfg_scale', label: 'Prompt strength', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }

const T2V_ASPECTS_SEEDANCE = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']
const IMAGE_ASPECTS = ['16:9', '9:16', '4:3', '3:4', '1:1', '2:3', '3:2']
const WIDE_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '2:3', '3:2', '7:9', '9:7', '21:9']

/** Built-in catalog. Availability varies by account; users can add more endpoints in Settings. */
export const HF_MODELS: HfModel[] = [
  // ------------------------------------------------------- text to video
  {
    id: 'kling-3-std-t2v', label: 'Kling 3.0 Standard', kind: 'text-to-video', endpoint: 'kling-video/v3.0/std/text-to-video',
    description: '3–15 s, native sound', promptMax: 2500, sound: { key: 'sound', on: 'on' },
    fields: [duration(3, 15, 5), aspect(['16:9', '9:16', '1:1'], '16:9'), klingSound, cfg]
  },
  {
    id: 'kling-3-pro-t2v', label: 'Kling 3.0 Pro', kind: 'text-to-video', endpoint: 'kling-video/v3.0/pro/text-to-video',
    description: 'Higher quality, native sound', promptMax: 2500, sound: { key: 'sound', on: 'on' },
    fields: [duration(3, 15, 5), aspect(['16:9', '9:16', '1:1'], '16:9'), klingSound, cfg]
  },
  {
    id: 'hailuo-23-t2v', label: 'Hailuo 2.3 Standard', kind: 'text-to-video', endpoint: 'minimax/hailuo-2.3/standard/text-to-video',
    description: '6 or 10 s at 768p',
    fields: [durationOf([6, 10], 6), flag('prompt_optimizer', 'Optimize prompt', true)]
  },
  {
    id: 'seedance-20-t2v', label: 'Seedance 2.0', kind: 'text-to-video', endpoint: 'bytedance/seedance-2.0/text-to-video',
    description: '4–15 s up to 4K, native sound', sound: { key: 'generate_audio', on: true },
    fields: [duration(4, 15, 5), aspect(T2V_ASPECTS_SEEDANCE, '16:9'), resolution(['480p', '720p', '1080p', '4k'], '720p'), flag('generate_audio', 'Sound', true)]
  },
  {
    id: 'wan-26-t2v', label: 'Wan 2.6', kind: 'text-to-video', endpoint: 'wan/v2.6/text-to-video',
    description: '5–15 s, 720p/1080p',
    fields: [durationOf([5, 10, 15], 5), resolution(['720p', '1080p'], '720p'), flag('prompt_extend', 'Expand prompt', false), seed(-1, 10_000_000)]
  },
  {
    id: 'ltx-25-fast-t2v', label: 'LTX 2.5 Fast', kind: 'text-to-video', endpoint: 'lightricks/ltx-2.5/text-to-video/fast',
    description: 'Fast drafts up to 4K, native sound', promptMax: 5000, sound: { key: 'generate_audio', on: true },
    fields: [
      durationOf([6, 8, 10], 6), aspect(['16:9', '9:16'], '16:9'), resolution(['720p', '1080p', '2k', '4k'], '720p'),
      { key: 'fps', label: 'Frame rate', type: 'select', options: [24, 25, 48, 50], default: 25, unit: 'fps' },
      flag('generate_audio', 'Sound', true),
      {
        key: 'camera_movement', label: 'Camera', type: 'select', optional: true, default: '',
        options: ['', 'static', 'dolly_in', 'dolly_out', 'dolly_left', 'dolly_right', 'jib_up', 'jib_down', 'focus_shift']
      }
    ]
  },

  // ------------------------------------------------------ image to video
  {
    id: 'kling-3-std-i2v', label: 'Kling 3.0 Standard', kind: 'image-to-video', endpoint: 'kling-video/v3.0/std/image-to-video',
    description: 'Image is the first frame, native sound', promptMax: 2500, sound: { key: 'sound', on: 'on' },
    fields: [duration(3, 15, 5), klingSound, cfg]
  },
  {
    id: 'kling-3-pro-i2v', label: 'Kling 3.0 Pro', kind: 'image-to-video', endpoint: 'kling-video/v3.0/pro/image-to-video',
    description: 'Higher quality, native sound', promptMax: 2500, sound: { key: 'sound', on: 'on' },
    fields: [duration(3, 15, 5), klingSound, cfg]
  },
  {
    id: 'hailuo-23-i2v', label: 'Hailuo 2.3 Standard', kind: 'image-to-video', endpoint: 'minimax/hailuo-2.3/standard/image-to-video',
    description: '6 or 10 s at 768p',
    fields: [durationOf([6, 10], 6), flag('prompt_optimizer', 'Optimize prompt', true)]
  },
  {
    id: 'seedance-20-i2v', label: 'Seedance 2.0', kind: 'image-to-video', endpoint: 'bytedance/seedance-2.0/image-to-video',
    description: 'Prompt optional, native sound', promptRequired: false, sound: { key: 'generate_audio', on: true },
    fields: [duration(4, 15, 5), resolution(['480p', '720p', '1080p', '4k'], '720p'), flag('generate_audio', 'Sound', true)]
  },
  {
    id: 'wan-26-i2v', label: 'Wan 2.6', kind: 'image-to-video', endpoint: 'wan/v2.6/image-to-video',
    description: '5–15 s up to 1080p',
    fields: [durationOf([5, 10, 15], 5), resolution(['480p', '720p', '1080p'], '720p'), flag('prompt_extend', 'Expand prompt', false), negative, seed(-1, 10_000_000)]
  },

  // ------------------------------------------------------ text to image
  {
    id: 'soul-v2', label: 'Soul V2', kind: 'text-to-image', endpoint: 'higgsfield-ai/soul/v2/standard',
    description: 'Higgsfield’s photoreal model',
    fields: [aspect(IMAGE_ASPECTS, '16:9'), resolution(['720p', '1080p'], '1080p'), flag('enhance_prompt', 'Enhance prompt', false),
      { key: 'batch_size', label: 'Images', type: 'select', options: [1, 4], default: 1 }, seed(1, 1_000_000)]
  },
  {
    id: 'soul', label: 'Soul', kind: 'text-to-image', endpoint: 'higgsfield-ai/soul/standard',
    fields: [aspect(IMAGE_ASPECTS, '16:9'), resolution(['720p', '1080p'], '1080p'), flag('enhance_prompt', 'Enhance prompt', false),
      { key: 'batch_size', label: 'Images', type: 'select', options: [1, 4], default: 1 }, seed(1, 1_000_000)]
  },
  {
    id: 'z-image-turbo', label: 'Z-Image Turbo', kind: 'text-to-image', endpoint: 'z-image/turbo',
    description: 'Fast, prompt up to 800 characters', promptMax: 800,
    fields: [aspect(WIDE_ASPECTS, '16:9'), resolution(['1k', '2k'], '1k'), flag('prompt_extend', 'Enhance prompt', false), seed(0, 2_147_483_647)]
  },
  {
    id: 'qwen-image-3', label: 'Qwen Image 3', kind: 'text-to-image', endpoint: 'alibaba/qwen-image-3/text-to-image',
    fields: [aspect(WIDE_ASPECTS, '16:9'), resolution(['1k', '2k'], '1k'), flag('prompt_extend', 'Enhance prompt', true),
      flag('enable_thinking', 'Thinking mode', true), negative, seed(0, 2_147_483_647)]
  },
  {
    id: 'recraft-41', label: 'Recraft V4.1', kind: 'text-to-image', endpoint: 'recraft/v4.1/text-to-image',
    description: 'Design and illustration', promptMax: 10_000,
    fields: [aspect(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '2:1', '1:2'], '16:9'),
      { key: 'output_format', label: 'Format', type: 'select', options: ['png', 'jpg', 'webp'], default: 'png' }]
  }
]

// -------------------------------------------------------- custom models ----

export interface HfCustomModel {
  id: string
  label: string
  kind: HfKind
  endpoint: string
  /** JSON object text merged into the request body. */
  params: string
}

export const CUSTOM_MODELS_KEY = 'higgsfield.customModels'
export const MOCK_KEY = 'higgsfield.mock'

export async function loadCustomModels(): Promise<HfCustomModel[]> {
  const list = await window.cineply.settings.get<HfCustomModel[]>(CUSTOM_MODELS_KEY)
  return Array.isArray(list) ? list : []
}

export function saveCustomModels(list: HfCustomModel[]): Promise<void> {
  return window.cineply.settings.set(CUSTOM_MODELS_KEY, list)
}

/** Endpoint IDs look like "vendor/model/variant". */
export const isValidEndpoint = (s: string): boolean => /^[\w.-]+(\/[\w.-]+)*$/.test(s.trim())

/** Parses a raw JSON params string. Returns an error message instead of throwing. */
export function parseRawParams(raw: string): { value: Record<string, unknown> } | { error: string } {
  if (!raw.trim()) return { value: {} }
  try {
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'Params must be a JSON object, like {"duration": 5}.' }
    return { value: v as Record<string, unknown> }
  } catch (e) {
    return { error: `Invalid JSON: ${(e as Error).message}` }
  }
}

function customToModel(c: HfCustomModel): HfModel {
  return {
    id: `custom:${c.id}`, label: `${c.label || c.endpoint} (custom)`, kind: c.kind, endpoint: c.endpoint.trim(),
    description: c.endpoint, promptRequired: false, fields: [], rawParams: c.params, custom: true
  }
}

/** Models for a tab. The soundtrack tab lists video models that can generate sound. */
export function modelsFor(kind: HfKind, custom: HfCustomModel[]): HfModel[] {
  const builtIn = kind === 'audio'
    ? HF_MODELS.filter((m) => m.kind === 'text-to-video' && m.sound)
    : HF_MODELS.filter((m) => m.kind === kind)
  return [...builtIn, ...custom.filter((c) => c.kind === kind && isValidEndpoint(c.endpoint)).map(customToModel)]
}

export function defaultValues(model: HfModel): Record<string, HfValue> {
  const out: Record<string, HfValue> = {}
  for (const f of model.fields) if (f.default !== undefined) out[f.key] = f.default
  return out
}

/**
 * Builds the request body: prompt + schema values (empty values are omitted so the server default
 * applies) + raw JSON for custom models. For soundtrack jobs the model's sound switch is forced on.
 */
export function buildParams(
  model: HfModel,
  prompt: string,
  values: Record<string, HfValue | undefined>,
  opts: { raw?: string; forceSound?: boolean } = {}
): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (prompt.trim()) params['prompt'] = prompt.trim()
  for (const f of model.fields) {
    const v = values[f.key] ?? f.default
    if (v === undefined || v === '') continue
    if (f.type === 'number') {
      const n = Number(v)
      if (Number.isFinite(n)) params[f.key] = n
    } else params[f.key] = v
  }
  const raw = opts.raw ?? model.rawParams
  if (raw) {
    const parsed = parseRawParams(raw)
    if ('error' in parsed) throw new Error(parsed.error)
    Object.assign(params, parsed.value)
  }
  if (opts.forceSound && model.sound) params[model.sound.key] = model.sound.on
  return params
}

// ------------------------------------------------------------------- IPC ----

/** Strips Electron's "Error invoking remote method 'x': Error: " prefix. */
export function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+':\s*(\w*Error:\s*)?/, '')
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => window.cineply.invoke<T>(channel, ...args)

export const higgsfield = {
  status: () => invoke<{ hasCredentials: boolean; mock: boolean }>('hf:status'),
  /** Tests the given credentials, or the saved ones when omitted. Free: no generation is made. */
  testCredentials: (creds?: { keyId: string; keySecret: string }) => invoke<{ ok: boolean; message: string }>('hf:testCredentials', creds),
  estimate: (kind: HfKind, endpoint: string, params: Record<string, unknown>) =>
    invoke<{ usd: number; mock?: boolean }>('hf:estimate', { kind, endpoint, params }),
  generate: (req: HfGenerateRequest) => invoke<HfJob>('hf:generate', req),
  cancel: (jobId: string) => invoke<{ ok: boolean; message: string }>('hf:cancel', jobId),
  listJobs: () => invoke<HfJob[]>('hf:listJobs'),
  removeJob: (jobId: string) => invoke<void>('hf:removeJob', jobId),
  clearFinished: () => invoke<void>('hf:clearFinished'),
  onJob: (cb: (job: HfJob) => void): (() => void) => window.cineply.on('hf:job', (job) => cb(job as HfJob))
}

export interface TtsVoice {
  name: string
  culture: string
  gender: string
  age: string
}

/** Windows built-in voices (System.Speech). Free and offline; returns [] on other platforms. */
export const tts = {
  voices: () => invoke<TtsVoice[]>('audio:tts:voices'),
  speak: (req: { text: string; voice?: string; rate?: number; volume?: number }) => invoke<{ path: string }>('audio:tts:speak', req)
}

// ------------------------------------------------------------ job store ----

interface HfJobsState {
  jobs: HfJob[]
  /** Media ids imported per job id during this session (fallback when the project lookup misses). */
  imported: Record<string, string[]>
}

export const useHfJobs = create<HfJobsState>(() => ({ jobs: [], imported: {} }))

function upsertJob(job: HfJob): void {
  useHfJobs.setState((s) => {
    const i = s.jobs.findIndex((j) => j.id === job.id)
    const jobs = i < 0 ? [job, ...s.jobs] : s.jobs.map((j) => (j.id === job.id ? job : j))
    return { jobs }
  })
}

/** Media items in the open project that came from a job. */
export function mediaForJob(jobId: string): MediaItem[] {
  const media = useProject.getState().project.media
  const byJob = media.filter((m) => m.ai?.jobId === jobId)
  if (byJob.length) return byJob
  const ids = useHfJobs.getState().imported[jobId] ?? []
  return media.filter((m) => ids.includes(m.id))
}

/** Imports a finished job's files into the media bin (once per project). */
export async function importJobResult(job: HfJob): Promise<MediaItem[]> {
  const existing = mediaForJob(job.id)
  if (existing.length) return existing
  if (!job.outputs.length) return []
  const items = await importFiles(job.outputs, {
    source: 'higgsfield',
    ai: { provider: 'higgsfield', prompt: job.prompt, model: job.model, jobId: job.id }
  })
  useHfJobs.setState((s) => ({ imported: { ...s.imported, [job.id]: items.map((m) => m.id) } }))
  return items
}

function mirrorToJobsList(job: HfJob): void {
  const ui = useUi.getState()
  const status = job.status === 'completed' ? 'done' : job.status === 'canceled' ? 'cancelled'
    : job.status === 'failed' || job.status === 'nsfw' ? 'error' : 'running'
  ui.upsertJob({
    id: job.id,
    label: `${job.mock ? 'Mock ' : ''}${KIND_LABELS[job.kind]}: ${job.model}`,
    progress: -1,
    status,
    error: job.error,
    cancel: status === 'running' ? () => void higgsfield.cancel(job.id) : undefined
  })
  if (status === 'done' || status === 'cancelled') setTimeout(() => useUi.getState().removeJob(job.id), 3000)
}

let syncing = false

/**
 * Starts mirroring main-process jobs into useHfJobs (idempotent). Finished results are imported
 * into the media bin automatically. Stays subscribed for the life of the window, so jobs keep
 * importing even when the AI panel isn't visible.
 */
export function startHfJobSync(): void {
  if (syncing) return
  syncing = true
  higgsfield.onJob((job) => {
    upsertJob(job)
    mirrorToJobsList(job)
    if (job.status === 'completed') {
      importJobResult(job)
        .then((items) => {
          const what = job.kind === 'audio' ? 'Soundtrack' : job.kind === 'text-to-image' ? 'Image' : 'Video'
          useUi.getState().showToast(items.length ? `${what} ready and added to the media bin` : `${what} ready: ${job.outputs.length} file(s) saved`)
        })
        .catch((e) => useUi.getState().showToast(`Couldn’t import the result: ${ipcErrorMessage(e)}`, 'error'))
    } else if (job.status === 'failed' || job.status === 'nsfw') {
      useUi.getState().showToast(job.error ?? 'Generation failed', 'error')
    }
  })
  higgsfield.listJobs().then((list) => {
    useHfJobs.setState((s) => {
      const live = new Map(s.jobs.map((j) => [j.id, j]))
      return { jobs: list.map((j) => live.get(j.id) ?? j) }
    })
  }).catch(() => undefined)
}

export async function removeHfJob(jobId: string): Promise<void> {
  await higgsfield.removeJob(jobId)
  useHfJobs.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== jobId) }))
}

export async function clearFinishedHfJobs(): Promise<void> {
  await higgsfield.clearFinished()
  useHfJobs.setState((s) => ({ jobs: s.jobs.filter((j) => !isJobFinished(j)) }))
}
