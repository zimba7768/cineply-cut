import { useState, type JSX } from 'react'
import { SEQUENCE_PRESETS, type SequenceSettings } from '@shared/types'
import { useProject } from '@/store/project'
import { ColorInput, Modal, Row } from '@/components/ui/controls'

const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]
const SAMPLE_RATES = [44100, 48000]

const even = (n: number): number => Math.max(16, Math.min(8192, Math.round(n / 2) * 2))

// Sequence settings (resolution, fps, presets).
export function SequenceSettingsDialog(props: { onClose(): void }): JSX.Element {
  const current = useProject((s) => s.project.sequence)
  const [seq, setSeq] = useState<SequenceSettings>({ ...current })
  const [width, setWidth] = useState(String(current.width))
  const [height, setHeight] = useState(String(current.height))

  const preset = SEQUENCE_PRESETS.find((p) => p.width === seq.width && p.height === seq.height && p.fps === seq.fps)
  const setSize = (w: number, h: number): void => {
    setSeq((s) => ({ ...s, width: w, height: h }))
    setWidth(String(w))
    setHeight(String(h))
  }
  const aspect = (): string => {
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
    const g = gcd(seq.width, seq.height) || 1
    return `${seq.width / g}:${seq.height / g}`
  }

  const apply = (): void => {
    const next: SequenceSettings = { ...seq, width: even(seq.width), height: even(seq.height), fps: Math.min(120, Math.max(1, seq.fps)) }
    const changed = (Object.keys(next) as (keyof SequenceSettings)[]).some((k) => next[k] !== current[k])
    if (changed) {
      useProject.getState().mutate('Sequence settings', (p) => {
        p.sequence = next
      })
    }
    props.onClose()
  }

  return (
    <Modal
      title="Sequence settings"
      onClose={props.onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>Cancel</button>
          <button className="btn primary" onClick={apply}>Apply</button>
        </>
      }
    >
      <Row label="Preset">
        <select
          className="select grow"
          value={preset?.id ?? 'custom'}
          onChange={(e) => {
            const p = SEQUENCE_PRESETS.find((x) => x.id === e.target.value)
            if (!p) return
            setSize(p.width, p.height)
            setSeq((s) => ({ ...s, fps: p.fps }))
          }}
        >
          {SEQUENCE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="custom" disabled>Custom</option>
        </select>
      </Row>
      <Row label="Frame size">
        <input
          className="input"
          style={{ width: 80 }}
          value={width}
          onChange={(e) => {
            setWidth(e.target.value)
            const v = parseInt(e.target.value, 10)
            if (v > 0) setSeq((s) => ({ ...s, width: v }))
          }}
          onBlur={() => setSize(even(seq.width), seq.height)}
        />
        <span className="muted">×</span>
        <input
          className="input"
          style={{ width: 80 }}
          value={height}
          onChange={(e) => {
            setHeight(e.target.value)
            const v = parseInt(e.target.value, 10)
            if (v > 0) setSeq((s) => ({ ...s, height: v }))
          }}
          onBlur={() => setSize(seq.width, even(seq.height))}
        />
        <button className="btn small ghost" title="Swap width and height" onClick={() => setSize(seq.height, seq.width)}>⇄</button>
        <span className="muted">{aspect()}</span>
      </Row>
      <Row label="Frame rate">
        <select className="select grow" value={String(seq.fps)} onChange={(e) => setSeq((s) => ({ ...s, fps: Number(e.target.value) }))}>
          {(FPS_OPTIONS.includes(seq.fps) ? FPS_OPTIONS : [...FPS_OPTIONS, seq.fps].sort((a, b) => a - b)).map((f) => (
            <option key={f} value={String(f)}>{f} fps</option>
          ))}
        </select>
      </Row>
      <Row label="Sample rate">
        <select className="select grow" value={String(seq.sampleRate)} onChange={(e) => setSeq((s) => ({ ...s, sampleRate: Number(e.target.value) }))}>
          {SAMPLE_RATES.map((r) => <option key={r} value={String(r)}>{r.toLocaleString()} Hz</option>)}
        </select>
      </Row>
      <Row label="Background">
        <ColorInput value={seq.background} onChange={(v) => setSeq((s) => ({ ...s, background: v }))} />
      </Row>
      <div className="muted" style={{ fontSize: 11 }}>
        Clips keep their timing when the frame rate changes. Frame sizes are rounded to even numbers for video encoders.
      </div>
    </Modal>
  )
}
