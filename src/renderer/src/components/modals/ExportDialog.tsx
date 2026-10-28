import { useEffect, useMemo, useState, type JSX } from 'react'
import { useProject, sequenceDuration } from '@/store/project'
import { usePlayback } from '@/store/playback'
import { Modal, ProgressBar, Row, Section } from '@/components/ui/controls'
import { timecode } from '@/lib/time'
import {
  AUDIO_BITRATES, EXPORT_PRESETS, FPS_OPTIONS, QUALITY_LABELS, aspectDiffers, cancelExport, estimateBytes,
  fileFilterFor, formatBytes, formatFps, frameCount, presetSize, safeFileName, startExport, useExport, videoBitrate,
  withExtension, type EncoderChoice, type ExportPresetId, type ExportRun, type ExportSettings, type QualityLevel
} from '@/engine/export'
import './ExportDialog.css'

interface Prefs {
  preset: ExportPresetId
  quality: QualityLevel
  customMbps: number
  audioBitrate: number
  encoder: EncoderChoice
  lastDir?: string
}

const PREFS_KEY = 'export.prefs'
const DEFAULT_PREFS: Prefs = { preset: 'mp4-1080', quality: 'high', customMbps: 20, audioBitrate: 192_000, encoder: 'auto' }

const dirname = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')
const clampEven = (n: number): number => Math.min(8192, Math.max(16, Math.round((Number.isFinite(n) ? n : 0) / 2) * 2))

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor(s / 60) % 60).padStart(h ? 2 : 1, '0')
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`
}

/** Export dialog: presets and options, then progress for the running export (which survives closing the dialog). */
export function ExportDialog(props: { onClose(): void }): JSX.Element {
  const run = useExport((s) => s.run)
  if (run) return <ExportProgressView run={run} onClose={props.onClose} />
  return <ExportSettingsView onClose={props.onClose} />
}

function ExportSettingsView(props: { onClose(): void }): JSX.Element {
  const project = useProject((s) => s.project)
  const inPoint = usePlayback((s) => s.inPoint)
  const outPoint = usePlayback((s) => s.outPoint)
  const seq = project.sequence
  const seqDuration = sequenceDuration(project)

  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [size, setSize] = useState(() => presetSize(DEFAULT_PREFS.preset, seq.width, seq.height))
  const [sizeText, setSizeText] = useState({ w: String(size.width), h: String(size.height) })
  const [fps, setFps] = useState(seq.fps)
  const [range, setRange] = useState<'all' | 'inout'>('all')
  const [output, setOutput] = useState('')
  const [busy, setBusy] = useState(false)

  const preset = EXPORT_PRESETS.find((p) => p.id === prefs.preset) ?? EXPORT_PRESETS[0]
  const format = preset.format
  const audioOnly = format !== 'mp4'

  // Restore the last-used choices once.
  useEffect(() => {
    void window.cineply.settings.get<Partial<Prefs>>(PREFS_KEY).then((saved) => {
      if (!saved) return
      const p = { ...DEFAULT_PREFS, ...saved }
      setPrefs(p)
      applySize(presetSize(p.preset, seq.width, seq.height))
    })
  }, [])

  const applySize = (s: { width: number; height: number }): void => {
    setSize(s)
    setSizeText({ w: String(s.width), h: String(s.height) })
  }

  const update = (p: Partial<Prefs>): void => setPrefs((old) => ({ ...old, ...p }))

  const choosePreset = (id: ExportPresetId): void => {
    update({ preset: id })
    applySize(presetSize(id, seq.width, seq.height))
    const f = EXPORT_PRESETS.find((p) => p.id === id)!.format
    if (output) setOutput(withExtension(output, f))
  }

  const hasInOut = inPoint !== null || outPoint !== null
  const inOutStart = Math.max(0, inPoint ?? 0)
  const inOutEnd = outPoint ?? seqDuration
  const inOutValid = hasInOut && inOutEnd > inOutStart
  const [start, end] = range === 'inout' && inOutValid ? [inOutStart, inOutEnd] : [0, seqDuration]
  const duration = Math.max(0, end - start)

  const fpsOptions = useMemo(
    () => [...new Set([...FPS_OPTIONS, seq.fps])].sort((a, b) => a - b),
    [seq.fps]
  )

  const settings: ExportSettings = {
    format, width: size.width, height: size.height, fps, quality: prefs.quality, customMbps: prefs.customMbps,
    audioBitrate: prefs.audioBitrate, start, end, output, encoder: prefs.encoder
  }
  const bitrateMbps = videoBitrate(settings) / 1e6
  const estimate = estimateBytes(settings, seq.sampleRate)
  const letterboxed = !audioOnly && aspectDiffers(project, size.width, size.height)

  const defaultPath = (): string => {
    const name = `${safeFileName(project.name)}.${format}`
    return prefs.lastDir ? window.cineply.paths.join(prefs.lastDir, name) : name
  }

  const browse = async (): Promise<string | null> => {
    const p = await window.cineply.dialog.saveFile(output || defaultPath(), [fileFilterFor(format)])
    if (!p) return null
    const fixed = withExtension(p, format)
    setOutput(fixed)
    update({ lastDir: dirname(fixed) })
    return fixed
  }

  const doExport = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const path = output || (await browse())
      if (!path) return
      const final = { ...settings, output: withExtension(path, format) }
      const { preset: pr, quality, customMbps, audioBitrate, encoder } = prefs
      void window.cineply.settings.set(PREFS_KEY, { preset: pr, quality, customMbps, audioBitrate, encoder, lastDir: dirname(final.output) })
      void startExport(project, final)
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      <span className="muted export-estimate">
        {duration > 0 ? `${timecode(duration, seq.fps)} · ~${formatBytes(estimate)}` : 'The sequence is empty'}
      </span>
      <button className="btn" onClick={props.onClose}>Cancel</button>
      <button className="btn primary" disabled={duration <= 0 || busy} onClick={() => void doExport()}>Export</button>
    </>
  )

  return (
    <Modal title="Export" onClose={props.onClose} footer={footer} width={600}>
      <div className="export-presets">
        {EXPORT_PRESETS.map((p) => (
          <button key={p.id} className={`btn${p.id === prefs.preset ? ' active' : ''}`} onClick={() => choosePreset(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      {prefs.preset === 'vertical' && letterboxed && (
        <div className="export-note">
          The sequence is {seq.width}×{seq.height}, not 9:16. It will be fit inside the vertical frame with black bars above and below.
          For a full-frame vertical video, change the sequence to Vertical 9:16 in Sequence Settings and reframe your clips.
        </div>
      )}

      {!audioOnly && (
        <Section title="Video">
          <Row label="Resolution">
            <input
              className="input export-num" value={sizeText.w}
              onChange={(e) => setSizeText({ ...sizeText, w: e.target.value })}
              onBlur={() => applySize({ ...size, width: clampEven(parseFloat(sizeText.w)) })}
            />
            <span className="muted">×</span>
            <input
              className="input export-num" value={sizeText.h}
              onChange={(e) => setSizeText({ ...sizeText, h: e.target.value })}
              onBlur={() => applySize({ ...size, height: clampEven(parseFloat(sizeText.h)) })}
            />
            <button className="btn small ghost" title="Use the sequence size" onClick={() => applySize(presetSize('match', seq.width, seq.height))}>
              Sequence size
            </button>
          </Row>
          {letterboxed && prefs.preset !== 'vertical' && (
            <div className="muted export-hint">The sequence aspect ratio differs; the picture will be letterboxed.</div>
          )}
          <Row label="Frame rate">
            <select className="select grow" value={String(fps)} onChange={(e) => setFps(Number(e.target.value))}>
              {fpsOptions.map((f) => (
                <option key={f} value={String(f)}>{formatFps(f)} fps{f === seq.fps ? ' (sequence)' : ''}</option>
              ))}
            </select>
          </Row>
          <Row label="Quality">
            <select className="select grow" value={prefs.quality} onChange={(e) => update({ quality: e.target.value as QualityLevel })}>
              {(Object.keys(QUALITY_LABELS) as QualityLevel[]).map((q) => (
                <option key={q} value={q}>
                  {QUALITY_LABELS[q]}
                  {q !== 'custom' ? ` (${(videoBitrate({ ...settings, quality: q }) / 1e6).toFixed(1)} Mbps)` : ''}
                </option>
              ))}
            </select>
            {prefs.quality === 'custom' && (
              <>
                <input
                  className="input export-num" type="number" min={0.5} max={400} step={0.5} value={prefs.customMbps}
                  onChange={(e) => update({ customMbps: Math.max(0.5, Number(e.target.value) || 0.5) })}
                />
                <span className="muted">Mbps</span>
              </>
            )}
          </Row>
          <Row label="Encoder" title="Auto uses the hardware H.264 encoder and falls back to ffmpeg (x264) when it isn't available">
            <select className="select grow" value={prefs.encoder} onChange={(e) => update({ encoder: e.target.value as EncoderChoice })}>
              <option value="auto">Auto (hardware, ffmpeg fallback)</option>
              <option value="ffmpeg">ffmpeg x264 (software)</option>
            </select>
          </Row>
        </Section>
      )}

      <Section title="Audio">
        {format === 'wav' ? (
          <Row label="Format"><span className="muted">PCM 24-bit, {seq.sampleRate / 1000} kHz stereo</span></Row>
        ) : (
          <Row label={format === 'mp3' ? 'MP3 bitrate' : 'AAC bitrate'}>
            <select className="select grow" value={prefs.audioBitrate} onChange={(e) => update({ audioBitrate: Number(e.target.value) })}>
              {AUDIO_BITRATES.map((b) => <option key={b} value={b}>{b / 1000} kbps</option>)}
            </select>
          </Row>
        )}
      </Section>

      <Section title="Range">
        <label className="export-radio">
          <input type="radio" checked={range === 'all'} onChange={() => setRange('all')} />
          Entire sequence <span className="muted">({timecode(seqDuration, seq.fps)})</span>
        </label>
        <label className={`export-radio${inOutValid ? '' : ' disabled'}`}>
          <input type="radio" disabled={!inOutValid} checked={range === 'inout' && inOutValid} onChange={() => setRange('inout')} />
          In to Out{' '}
          <span className="muted">
            {inOutValid ? `(${timecode(inOutStart, seq.fps)} – ${timecode(inOutEnd, seq.fps)})` : '(set In/Out points with I and O)'}
          </span>
        </label>
      </Section>

      <Section title="Output">
        <Row label="File">
          <input className="input export-file" value={output} placeholder={defaultPath()} onChange={(e) => setOutput(e.target.value)} />
          <button className="btn" onClick={() => void browse()}>Browse…</button>
        </Row>
        <div className="export-summary muted">
          {audioOnly
            ? `${format.toUpperCase()} · ${timecode(duration, seq.fps)}`
            : `${size.width}×${size.height} · ${formatFps(fps)} fps · ${frameCount({ start, end, fps })} frames · H.264 ${bitrateMbps.toFixed(1)} Mbps + AAC ${prefs.audioBitrate / 1000} kbps`}
          {' · '}estimated {formatBytes(estimate)}
        </div>
      </Section>
    </Modal>
  )
}

const PHASE_LABELS: Record<string, string> = {
  preparing: 'Preparing…', audio: 'Mixing audio…', video: 'Rendering and encoding…', muxing: 'Encoding…', finalizing: 'Finishing…'
}

function ExportProgressView(props: { run: ExportRun; onClose(): void }): JSX.Element {
  const { run } = props
  const clear = useExport((s) => s.clear)
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (run.status !== 'running') return
    const t = setInterval(() => setNow(performance.now()), 500)
    return () => clearInterval(t)
  }, [run.status])

  const elapsed = ((run.finishedAt ?? now) - run.startedAt) / 1000
  const f = run.progress.fraction
  const eta = f > 0.02 ? (elapsed / f) * (1 - f) : null
  const { framesDone, framesTotal } = run.progress
  const probe = run.result?.probe

  const footer =
    run.status === 'running' ? (
      <>
        <button className="btn danger" onClick={cancelExport}>Cancel export</button>
        <button className="btn" onClick={props.onClose} title="The export keeps running in the background">Hide</button>
      </>
    ) : (
      <>
        {run.status === 'done' && (
          <button className="btn" onClick={() => void window.cineply.shell.showItemInFolder(run.settings.output)}>Show in folder</button>
        )}
        <button className="btn" onClick={clear}>{run.status === 'done' ? 'New export' : 'Back to settings'}</button>
        <button className="btn primary" onClick={() => { clear(); props.onClose() }}>Close</button>
      </>
    )

  return (
    <Modal title={run.label} onClose={props.onClose} footer={footer} width={560}>
      <div className="export-path" title={run.settings.output}>{run.settings.output}</div>
      {run.status === 'running' && (
        <>
          <div className="export-phase">{PHASE_LABELS[run.progress.phase] ?? 'Exporting…'}</div>
          <ProgressBar value={f} />
          <div className="export-stats muted">
            <span>{Math.floor(f * 100)}%</span>
            {framesTotal > 0 && <span>Frame {framesDone} / {framesTotal}</span>}
            <span>Elapsed {clock(elapsed)}</span>
            <span>{eta !== null ? `Remaining ~${clock(eta)}` : 'Estimating…'}</span>
          </div>
        </>
      )}
      {run.status === 'done' && (
        <>
          <div className="export-ok">Export finished in {clock(elapsed)}.</div>
          {probe && (
            <div className="export-stats muted">
              <span>{probe.duration.toFixed(2)} s</span>
              {probe.hasVideo && <span>{probe.width}×{probe.height}</span>}
              {probe.hasVideo && probe.fps && <span>{formatFps(Math.round(probe.fps * 1000) / 1000)} fps</span>}
              <span>{[probe.videoCodec, probe.audioCodec].filter(Boolean).join(' + ')}</span>
              <span>{encoderLabel(run)}</span>
            </div>
          )}
        </>
      )}
      {run.status === 'error' && <div className="export-error">{run.error}</div>}
      {run.status === 'cancelled' && <div className="muted">Export cancelled. The partial file was deleted.</div>}
      {!!run.result?.warnings.length && (
        <ul className="export-warnings">
          {run.result.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
    </Modal>
  )
}

function encoderLabel(run: ExportRun): string {
  switch (run.result?.encoder) {
    case 'webcodecs': return 'hardware encoder'
    case 'webcodecs+ffmpeg': return 'hardware video, ffmpeg audio'
    case 'ffmpeg': return 'ffmpeg x264'
    default: return ''
  }
}
