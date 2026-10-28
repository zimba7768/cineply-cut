import { useEffect, useMemo, useState, type DragEvent, type JSX } from 'react'
import type { MediaItem } from '@shared/types'
import { useUi } from '@/store/ui'
import { useProject } from '@/store/project'
import { usePlayback } from '@/store/playback'
import { captureFrame } from '@/engine/capture'
import { importFiles } from '@/lib/importMedia'
import { addMediaClip } from '@/lib/editing'
import { getDragPayload } from '@/lib/dnd'
import { NumberSlider, Row, Section, Toggle } from '@/components/ui/controls'
import {
  KIND_LABELS, buildParams, clearFinishedHfJobs, defaultValues, higgsfield, importJobResult, ipcErrorMessage,
  isJobFinished, loadCustomModels, mediaForJob, modelsFor, removeHfJob, startHfJobSync, tts, useHfJobs,
  type HfCustomModel, type HfField, type HfJob, type HfKind, type HfModel, type HfValue, type TtsVoice
} from '@/lib/higgsfield'
import './AIPanel.css'

type Tab = 'text-to-video' | 'image-to-video' | 'text-to-image' | 'voice'

const TABS: { id: Tab; label: string }[] = [
  { id: 'text-to-video', label: 'Text → Video' },
  { id: 'image-to-video', label: 'Image → Video' },
  { id: 'text-to-image', label: 'Text → Image' },
  { id: 'voice', label: 'Voice' }
]

const KEYS_URL = 'https://console.higgsfield.ai'
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i

// Form state survives switching panels (the panel unmounts when another left tab is shown).
let lastTab: Tab = 'text-to-video'
const memory: Partial<Record<HfKind, { modelId: string; prompt: string; values: Record<string, HfValue>; raw: string }>> = {}
let lastImagePath: string | null = null
const voiceMemory = { text: '', voice: '', rate: 0, volume: 100 }

const toast = (msg: string, kind?: 'info' | 'error'): void => useUi.getState().showToast(msg, kind)

/** Higgsfield generation and AI voice. */
export function AIPanel(): JSX.Element {
  const [tab, setTabState] = useState<Tab>(lastTab)
  const [status, setStatus] = useState<{ hasCredentials: boolean; mock: boolean } | null>(null)
  const [custom, setCustom] = useState<HfCustomModel[]>([])
  const modal = useUi((s) => s.modal)

  const setTab = (t: Tab): void => {
    lastTab = t
    setTabState(t)
  }

  useEffect(() => startHfJobSync(), [])

  // Re-read credentials and custom models whenever Settings closes.
  useEffect(() => {
    if (modal !== null) return
    higgsfield.status().then(setStatus).catch(() => setStatus({ hasCredentials: false, mock: false }))
    loadCustomModels().then(setCustom).catch(() => undefined)
  }, [modal])

  const connected = !!status && (status.hasCredentials || status.mock)

  return (
    <div className="ai-panel">
      <div className="ai-subtabs">
        {TABS.map((t) => (
          <button key={t.id} className={`ai-subtab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {status?.mock && (
        <div className="ai-banner">Mock mode: nothing is sent to Higgsfield and nothing is charged.</div>
      )}
      {tab === 'voice' ? (
        <VoiceTab connected={connected} status={status} custom={custom} />
      ) : status === null ? (
        <div className="empty">Loading…</div>
      ) : connected ? (
        <GenerateForm key={tab} kind={tab} custom={custom} />
      ) : (
        <ConnectCard />
      )}
      <JobList />
    </div>
  )
}

// ------------------------------------------------------------ connect ----

function ConnectCard(props: { compact?: boolean }): JSX.Element {
  const openModal = useUi((s) => s.openModal)
  return (
    <div className={`ai-connect${props.compact ? ' compact' : ''}`}>
      {!props.compact && <div className="ai-connect-icon">✦</div>}
      <div className="ai-connect-title">Connect your Higgsfield account</div>
      <div className="muted">
        Generate video, images and AI soundtracks without leaving the editor. Add your API key in Settings, or
        turn on mock mode there to try the flow for free.
      </div>
      <div className="ai-actions">
        <button className="btn primary" onClick={() => openModal('settings')}>Open Settings</button>
        <button className="btn ghost" onClick={() => void window.cineply.shell.openExternal(KEYS_URL)}>Get API keys ↗</button>
      </div>
    </div>
  )
}

// ------------------------------------------------------- generate form ----

function GenerateForm(props: { kind: HfKind; custom: HfCustomModel[] }): JSX.Element {
  const { kind } = props
  const models = useMemo(() => modelsFor(kind, props.custom), [kind, props.custom])
  const saved = memory[kind]
  const [modelId, setModelId] = useState(saved?.modelId ?? models[0]?.id ?? '')
  const model = models.find((m) => m.id === modelId) ?? models[0]
  const [prompt, setPrompt] = useState(saved?.prompt ?? '')
  const [values, setValues] = useState<Record<string, HfValue>>(saved?.values ?? (model ? defaultValues(model) : {}))
  const [raw, setRaw] = useState(saved?.raw ?? model?.rawParams ?? '')
  const [imagePath, setImagePath] = useState<string | null>(kind === 'image-to-video' ? lastImagePath : null)
  const [estimate, setEstimate] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState<'estimate' | 'generate' | null>(null)

  useEffect(() => {
    if (model) memory[kind] = { modelId: model.id, prompt, values, raw }
  }, [kind, model, prompt, values, raw])

  useEffect(() => setEstimate(null), [modelId, prompt, values, raw])

  if (!model) return <div className="empty">No models available.</div>

  const selectModel = (id: string): void => {
    const m = models.find((x) => x.id === id)
    if (!m) return
    setModelId(id)
    setValues(defaultValues(m))
    setRaw(m.rawParams ?? '')
  }

  const soundtrack = kind === 'audio'
  const fields = model.fields.filter((f) => !(soundtrack && model.sound && f.key === model.sound.key))
  const promptRequired = model.promptRequired !== false
  const tooLong = !!model.promptMax && prompt.length > model.promptMax

  const params = (): Record<string, unknown> => buildParams(model, prompt, values, { raw: model.custom ? raw : undefined, forceSound: soundtrack })

  const runEstimate = async (): Promise<void> => {
    setBusy('estimate')
    try {
      const r = await higgsfield.estimate(kind, model.endpoint, params())
      setEstimate({ text: `≈ $${r.usd.toFixed(r.usd < 1 ? 3 : 2)}${r.mock ? ' (mock)' : ''}` })
    } catch (e) {
      setEstimate({ text: ipcErrorMessage(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  const generate = async (): Promise<void> => {
    if (promptRequired && !prompt.trim()) return toast('Write a prompt first.', 'error')
    if (tooLong) return toast(`The prompt is longer than ${model.promptMax} characters.`, 'error')
    if (kind === 'image-to-video' && !imagePath) return toast('Pick an input image first.', 'error')
    setBusy('generate')
    try {
      await higgsfield.generate({
        kind, endpoint: model.endpoint, params: params(), model: model.label,
        inputImagePath: kind === 'image-to-video' ? imagePath ?? undefined : undefined
      })
      toast('Generation started. The result is added to the media bin when it’s ready.')
    } catch (e) {
      toast(ipcErrorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="ai-form">
      <Row label="Model">
        <select className="select grow" value={model.id} onChange={(e) => selectModel(e.target.value)}>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </Row>
      {model.description && <div className="ai-hint">{model.description}</div>}

      {kind === 'image-to-video' && (
        <ImageInput
          path={imagePath}
          onChange={(p) => {
            lastImagePath = p
            setImagePath(p)
          }}
        />
      )}

      <div className="ai-prompt">
        <textarea
          className="textarea"
          rows={soundtrack ? 3 : 4}
          placeholder={soundtrack
            ? 'Describe the sound or music, e.g. "gentle rain on a tin roof with distant thunder"'
            : kind === 'text-to-image' ? 'Describe the image…' : 'Describe the shot: subject, action, camera, light…'}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        {model.promptMax && (
          <span className={`ai-count${tooLong ? ' over' : ''}`}>{prompt.length}/{model.promptMax}</span>
        )}
      </div>

      {fields.map((f) => (
        <Row key={f.key} label={f.label}>
          <FieldControl field={f} value={values[f.key]} onChange={(v) => setValues({ ...values, [f.key]: v })} />
        </Row>
      ))}

      {model.custom && (
        <div className="ai-raw">
          <div className="muted">Request params (JSON). The prompt above is added automatically.</div>
          <textarea className="textarea mono" rows={4} spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} />
        </div>
      )}

      <div className="ai-actions">
        <button className="btn" disabled={busy !== null} onClick={() => void runEstimate()}>
          {busy === 'estimate' ? 'Estimating…' : 'Estimate cost'}
        </button>
        {estimate && <span className={`ai-estimate${estimate.error ? ' error' : ''}`}>{estimate.text}</span>}
        <span className="grow" />
        <button className="btn primary" disabled={busy !== null} onClick={() => void generate()}>
          {busy === 'generate' ? 'Starting…' : soundtrack ? 'Generate sound' : 'Generate'}
        </button>
      </div>
    </div>
  )
}

function FieldControl(props: { field: HfField; value: HfValue | undefined; onChange(v: HfValue): void }): JSX.Element {
  const { field: f, value } = props
  switch (f.type) {
    case 'select': {
      const numeric = f.options.some((o) => typeof o === 'number')
      return (
        <select
          className="select grow"
          value={String(value ?? f.default)}
          onChange={(e) => props.onChange(numeric && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
        >
          {f.options.map((o) => (
            <option key={String(o)} value={String(o)}>
              {o === '' ? 'Default' : `${String(o).replace(/_/g, ' ')}${f.unit ? ` ${f.unit}` : ''}`}
            </option>
          ))}
        </select>
      )
    }
    case 'number':
      if (f.default === undefined) {
        return (
          <input
            className="input grow"
            type="number"
            min={f.min}
            max={f.max}
            step={f.step ?? 1}
            placeholder="Random"
            value={value === undefined || value === '' ? '' : String(value)}
            onChange={(e) => props.onChange(e.target.value === '' ? '' : Number(e.target.value))}
          />
        )
      }
      return (
        <NumberSlider value={Number(value ?? f.default)} min={f.min} max={f.max} step={f.step} unit={f.unit} onChange={props.onChange} />
      )
    case 'boolean':
      return <Toggle value={Boolean(value ?? f.default)} onChange={props.onChange} />
    case 'text':
      return (
        <input className="input grow" placeholder={f.placeholder} value={String(value ?? f.default ?? '')} onChange={(e) => props.onChange(e.target.value)} />
      )
  }
}

// --------------------------------------------------------- image input ----

function ImageInput(props: { path: string | null; onChange(path: string | null): void }): JSX.Element {
  const media = useProject((s) => s.project.media)
  const images = media.filter((m) => m.kind === 'image')
  const [capturing, setCapturing] = useState(false)
  const [over, setOver] = useState(false)

  const useCurrentFrame = async (): Promise<void> => {
    setCapturing(true)
    try {
      const blob = await captureFrame(usePlayback.getState().time)
      if (!blob) throw new Error('Nothing to capture at the playhead.')
      const dir = await window.cineply.paths.tempDir()
      const path = window.cineply.paths.join(dir, `frame-${Date.now()}.png`)
      await window.cineply.fs.writeBinary(path, await blob.arrayBuffer())
      props.onChange(path)
    } catch (e) {
      toast(`Couldn’t capture the frame: ${ipcErrorMessage(e)}`, 'error')
    } finally {
      setCapturing(false)
    }
  }

  const browse = async (): Promise<void> => {
    const paths = await window.cineply.dialog.openMedia()
    if (!paths.length) return
    const img = paths.find((p) => IMAGE_EXT.test(p))
    if (img) props.onChange(img)
    else toast('Pick an image file (PNG, JPEG, WebP…).', 'error')
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const payload = getDragPayload(e)
    if (payload?.kind !== 'media') return
    const item = media.find((m) => m.id === payload.mediaId)
    if (item?.kind === 'image') props.onChange(item.path)
    else toast('Drop an image here, or use "Current frame" for a video.', 'error')
  }

  const selected = images.find((m) => m.path === props.path)

  return (
    <div className="ai-image-input">
      <div
        className={`ai-image-drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {props.path ? (
          <>
            <img src={window.cineply.mediaUrl(props.path)} alt="" />
            <button className="btn ghost icon ai-image-clear" title="Remove" onClick={() => props.onChange(null)}>✕</button>
          </>
        ) : (
          <span className="muted">Input image: first frame of the video. Drop an image from the media bin here.</span>
        )}
      </div>
      <div className="ai-image-buttons">
        <select
          className="select grow"
          value={selected?.path ?? ''}
          onChange={(e) => e.target.value && props.onChange(e.target.value)}
        >
          <option value="">{images.length ? 'From media bin…' : 'No images in the bin'}</option>
          {images.map((m) => <option key={m.id} value={m.path}>{m.name}</option>)}
        </select>
        <button className="btn" disabled={capturing} title="Use the frame under the playhead" onClick={() => void useCurrentFrame()}>
          {capturing ? 'Capturing…' : 'Current frame'}
        </button>
        <button className="btn" onClick={() => void browse()}>Browse…</button>
      </div>
      {props.path && <div className="ai-hint ellipsis" title={props.path}>{window.cineply.paths.basename(props.path)}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- voice ----

interface VoiceResult {
  path: string
  text: string
  mediaId?: string
}

let voiceResults: VoiceResult[] = []

function VoiceTab(props: { connected: boolean; status: { hasCredentials: boolean; mock: boolean } | null; custom: HfCustomModel[] }): JSX.Element {
  const [voices, setVoices] = useState<TtsVoice[] | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [text, setText] = useState(voiceMemory.text)
  const [voice, setVoice] = useState(voiceMemory.voice)
  const [rate, setRate] = useState(voiceMemory.rate)
  const [volume, setVolume] = useState(voiceMemory.volume)
  const [speaking, setSpeaking] = useState(false)
  const [results, setResults] = useState<VoiceResult[]>(voiceResults)

  useEffect(() => {
    tts.voices()
      .then((v) => {
        setVoices(v)
        if (!v.length) setVoiceError(window.cineply.platform === 'win32' ? 'No voices are installed.' : 'Built-in voices are only available on Windows.')
      })
      .catch((e) => {
        setVoices([])
        setVoiceError(ipcErrorMessage(e))
      })
  }, [])

  useEffect(() => {
    Object.assign(voiceMemory, { text, voice, rate, volume })
  }, [text, voice, rate, volume])

  const updateResults = (r: VoiceResult[]): void => {
    voiceResults = r
    setResults(r)
  }

  const speak = async (): Promise<void> => {
    if (!text.trim()) return toast('Type something to say first.', 'error')
    setSpeaking(true)
    try {
      const { path } = await tts.speak({ text, voice: voice || undefined, rate, volume })
      const items = await importFiles([path], { source: 'tts' })
      updateResults([{ path, text: text.trim(), mediaId: items[0]?.id }, ...results].slice(0, 20))
      toast(items.length ? 'Voice added to the media bin' : 'Voice saved')
    } catch (e) {
      toast(ipcErrorMessage(e), 'error')
    } finally {
      setSpeaking(false)
    }
  }

  const play = (path: string): void => {
    void new Audio(window.cineply.mediaUrl(path)).play().catch(() => toast('Couldn’t play the file.', 'error'))
  }

  const addToTimeline = async (r: VoiceResult): Promise<void> => {
    let mediaId = r.mediaId && useProject.getState().project.media.some((m) => m.id === r.mediaId) ? r.mediaId : undefined
    if (!mediaId) {
      const items = await importFiles([r.path], { source: 'tts' })
      mediaId = items[0]?.id
      if (mediaId) updateResults(results.map((x) => (x === r ? { ...x, mediaId } : x)))
    }
    if (!mediaId) return toast('Couldn’t import the voice file.', 'error')
    addMediaClip(mediaId)
  }

  return (
    <div className="ai-voice">
      <div className="ai-note">
        Higgsfield’s API has no text-to-speech, so spoken voice comes from the voices built into Windows.
      </div>

      <Section title="Windows voice · free, offline">
        {voiceError && <div className="ai-hint error">{voiceError}</div>}
        <Row label="Voice">
          <select className="select grow" value={voice} disabled={!voices?.length} onChange={(e) => setVoice(e.target.value)}>
            <option value="">{voices === null ? 'Loading voices…' : 'System default'}</option>
            {voices?.map((v) => (
              <option key={v.name} value={v.name}>{v.name.replace(/^Microsoft /, '').replace(/ Desktop$/, '')} · {v.culture} · {v.gender}</option>
            ))}
          </select>
        </Row>
        <Row label="Speed">
          <NumberSlider value={rate} min={-10} max={10} step={1} onChange={(v) => setRate(Math.round(v))} />
        </Row>
        <Row label="Volume">
          <NumberSlider value={volume} min={0} max={100} step={1} unit="%" onChange={(v) => setVolume(Math.round(v))} />
        </Row>
        <textarea className="textarea" rows={4} placeholder="Type the narration…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="ai-actions">
          <span className="grow" />
          <button className="btn primary" disabled={speaking || !voices?.length} onClick={() => void speak()}>
            {speaking ? 'Speaking…' : 'Generate voice'}
          </button>
        </div>
        {results.map((r) => (
          <div key={r.path} className="ai-voice-result">
            <button className="btn ghost icon" title="Play" onClick={() => play(r.path)}>▶</button>
            <span className="grow ellipsis" title={r.text}>{r.text}</span>
            <button className="btn small" onClick={() => void addToTimeline(r)}>Add to timeline</button>
          </div>
        ))}
      </Section>

      <Section title="AI sound / music from a Higgsfield video model">
        <div className="ai-hint">
          Generates a short video with native sound and keeps only its soundtrack as a WAV. Good for ambience,
          effects and music beds; it can’t read a script aloud.
        </div>
        {props.status === null ? null : props.connected ? (
          <GenerateForm kind="audio" custom={props.custom} />
        ) : (
          <ConnectCard compact />
        )}
      </Section>
    </div>
  )
}

// ------------------------------------------------------------- job list ----

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const STATUS_LABEL: Record<HfJob['status'], string> = {
  uploading: 'Uploading', submitting: 'Submitting', queued: 'Queued', in_progress: 'Generating', downloading: 'Downloading',
  completed: 'Done', failed: 'Failed', nsfw: 'Blocked', canceled: 'Canceled'
}

function JobList(): JSX.Element | null {
  const jobs = useHfJobs((s) => s.jobs)
  const active = jobs.some((j) => !isJobFinished(j))
  const now = useNow(active)
  if (!jobs.length) return null
  return (
    <Section
      title={`Generations (${jobs.length})`}
      right={jobs.some(isJobFinished) ? (
        <button className="btn ghost small" onClick={() => void clearFinishedHfJobs()}>Clear finished</button>
      ) : undefined}
    >
      {jobs.slice(0, 40).map((j) => <JobRow key={j.id} job={j} now={now} />)}
    </Section>
  )
}

function JobRow(props: { job: HfJob; now: number }): JSX.Element {
  const { job } = props
  // Re-render when the project's media changes so import state stays current.
  const media = useProject((s) => s.project.media)
  const imported = useMemo(() => mediaForJob(job.id), [job.id, media])
  const finished = isJobFinished(job)
  const elapsed = (job.finishedAt ?? props.now) - job.createdAt
  const [working, setWorking] = useState(false)

  const cancel = async (): Promise<void> => {
    const r = await higgsfield.cancel(job.id).catch((e) => ({ ok: false, message: ipcErrorMessage(e) }))
    if (!r.ok) toast(r.message, 'error')
  }

  const ensureImported = async (): Promise<MediaItem[]> => {
    if (imported.length) return imported
    setWorking(true)
    try {
      const items = await importJobResult(job)
      if (!items.length) toast('Nothing was imported.', 'error')
      return items
    } catch (e) {
      toast(`Couldn’t import: ${ipcErrorMessage(e)}`, 'error')
      return []
    } finally {
      setWorking(false)
    }
  }

  const addToTimeline = async (index = 0): Promise<void> => {
    const items = await ensureImported()
    const item = items.find((m) => m.path === job.outputs[index]) ?? items[index] ?? items[0]
    if (item) addMediaClip(item.id)
  }

  const images = job.status === 'completed' ? job.outputs.filter((p) => IMAGE_EXT.test(p)) : []

  return (
    <div className={`ai-job status-${job.status}`}>
      <div className="ai-job-head">
        <span className="ai-dot" />
        <span className="ai-job-title ellipsis" title={`${job.model} · ${job.endpoint}`}>
          {job.mock && <span className="ai-tag">mock</span>}
          {KIND_LABELS[job.kind]} · {job.model}
        </span>
        <span className="ai-job-time">{formatElapsed(elapsed)}</span>
      </div>
      {job.prompt && <div className="ai-job-prompt ellipsis" title={job.prompt}>{job.prompt}</div>}
      <div className={`ai-job-status${job.error ? ' error' : ''}`}>
        {job.error ?? job.message ?? STATUS_LABEL[job.status]}
        {job.error && job.correlationId && !job.error.includes(job.correlationId) && (
          <span className="muted"> · correlation ID {job.correlationId}</span>
        )}
      </div>
      {images.length > 1 && (
        <div className="ai-job-images">
          {images.map((p, i) => (
            <button key={p} className="ai-job-thumb" title="Add to timeline" onClick={() => void addToTimeline(job.outputs.indexOf(p))}>
              <img src={window.cineply.mediaUrl(p)} alt={`Result ${i + 1}`} />
            </button>
          ))}
        </div>
      )}
      <div className="ai-job-actions">
        {!finished && <button className="btn small" onClick={() => void cancel()}>Cancel</button>}
        {job.status === 'completed' && job.outputs.length > 0 && (
          <>
            <button className="btn small primary" disabled={working} onClick={() => void addToTimeline()}>Add to timeline</button>
            {!imported.length && (
              <button className="btn small" disabled={working} onClick={() => void ensureImported()}>Import</button>
            )}
            <button className="btn small ghost" onClick={() => void window.cineply.shell.showItemInFolder(job.outputs[0])}>Show file</button>
          </>
        )}
        <span className="grow" />
        {finished && (
          <button className="btn ghost icon small" title="Remove from list" onClick={() => void removeHfJob(job.id)}>✕</button>
        )}
      </div>
    </div>
  )
}
