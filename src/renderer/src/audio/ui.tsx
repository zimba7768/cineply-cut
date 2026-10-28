import { useEffect, useRef, useState, type JSX } from 'react'
import type { AudioEffect } from '@shared/types'
import { ParamControls } from '@/components/ui/controls'
import { endDrag, getDragPayload } from '@/lib/dnd'
import { AUDIO_EFFECTS, dbToGain, gainToDb, getAudioEffect } from './effects'
import { addEffect, moveEffect, removeEffect, setEffectParam, toggleEffect, type RackTarget } from './mixer'
import './ui.css'

/** Shared audio UI pieces: dB fader, pan control, peak meter and effect rack. */

const FADER_MIN = -60
const FADER_MAX = 12
const METER_MIN = -60
const METER_MAX = 6

export function formatDb(gain: number, digits = 1): string {
  const db = gainToDb(gain)
  if (!Number.isFinite(db) || db <= FADER_MIN) return '−∞'
  return `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(digits)}`
}

const faderPos = (gain: number): number => {
  const db = gainToDb(gain)
  return Number.isFinite(db) ? Math.min(1, Math.max(0, (db - FADER_MIN) / (FADER_MAX - FADER_MIN))) : 0
}
const posToGain = (pos: number): number => (pos <= 0.002 ? 0 : dbToGain(FADER_MIN + pos * (FADER_MAX - FADER_MIN)))

/** Vertical volume fader in dB. Double-click resets to 0 dB, the wheel nudges by 0.5 dB. */
export function Fader(props: { gain: number; onChange(gain: number): void; height?: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const height = props.height ?? 150
  const fromEvent = (clientY: number): void => {
    const r = ref.current!.getBoundingClientRect()
    props.onChange(posToGain(1 - (clientY - r.top) / r.height))
  }
  const ticks = [6, 0, -6, -12, -24, -40]
  return (
    <div className="fader" style={{ height }} title={`${formatDb(props.gain)} dB`}>
      <div className="fader-scale">
        {ticks.map((db) => (
          <span key={db} style={{ bottom: `${((db - FADER_MIN) / (FADER_MAX - FADER_MIN)) * 100}%` }}>{db > 0 ? `+${db}` : db}</span>
        ))}
      </div>
      <div
        ref={ref}
        className="fader-track"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          fromEvent(e.clientY)
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && fromEvent(e.clientY)}
        onDoubleClick={() => props.onChange(1)}
        onWheel={(e) => {
          const db = Math.max(FADER_MIN, gainToDb(props.gain))
          props.onChange(dbToGain(Math.min(FADER_MAX, db + (e.deltaY < 0 ? 0.5 : -0.5))))
        }}
      >
        <div className="fader-zero" style={{ bottom: `${(-FADER_MIN / (FADER_MAX - FADER_MIN)) * 100}%` }} />
        <div className="fader-thumb" style={{ bottom: `calc(${faderPos(props.gain) * 100}% - 7px)` }} />
      </div>
    </div>
  )
}

/** Horizontal pan slider, −1 (L) .. +1 (R). Double-click centres. */
export function PanControl(props: { pan: number; onChange(pan: number): void }): JSX.Element {
  const p = props.pan || 0
  const label = Math.abs(p) < 0.005 ? 'C' : `${p < 0 ? 'L' : 'R'}${Math.round(Math.abs(p) * 100)}`
  return (
    <div className="pan" title={`Pan ${label}`}>
      <input
        type="range" min={-1} max={1} step={0.01} value={p}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onDoubleClick={() => props.onChange(0)}
      />
      <span className="pan-label">{label}</span>
    </div>
  )
}

const levelFrac = (v: number): number => {
  const db = 20 * Math.log10(Math.max(1e-6, v))
  return Math.min(1, Math.max(0, (db - METER_MIN) / (METER_MAX - METER_MIN)))
}

/** Peak meter animated with requestAnimationFrame; `read` returns [left, right] (or one value) 0..1. */
export function PeakMeter(props: { read(): number[]; height?: number; horizontal?: boolean }): JSX.Element {
  const covers = useRef<(HTMLDivElement | null)[]>([])
  const holds = useRef<(HTMLDivElement | null)[]>([])
  const clip = useRef<HTMLDivElement>(null)
  const read = useRef(props.read)
  read.current = props.read
  const [channels] = useState(() => Math.max(1, props.read().length))

  useEffect(() => {
    const shown = new Array(channels).fill(0)
    const hold = new Array(channels).fill(0)
    const holdAt = new Array(channels).fill(0)
    let clipUntil = 0
    let raf = 0
    let last = performance.now()
    const frame = (now: number): void => {
      const dt = (now - last) / 1000
      last = now
      const levels = read.current()
      for (let ch = 0; ch < channels; ch++) {
        const v = levels[ch] ?? levels[0] ?? 0
        if (v >= 0.999) clipUntil = now + 1500
        const f = levelFrac(v)
        // Instant attack, ~20 dB/s fall, 1 s peak hold.
        shown[ch] = Math.max(f, shown[ch] - (dt * 20) / (METER_MAX - METER_MIN))
        if (f >= hold[ch] || now - holdAt[ch] > 1000) {
          hold[ch] = f
          holdAt[ch] = now
        }
        const cover = covers.current[ch]
        if (cover) cover.style[props.horizontal ? 'width' : 'height'] = `${(1 - shown[ch]) * 100}%`
        const h = holds.current[ch]
        if (h) {
          h.style[props.horizontal ? 'left' : 'bottom'] = `${hold[ch] * 100}%`
          h.style.opacity = hold[ch] > 0.01 ? '1' : '0'
        }
      }
      if (clip.current) clip.current.classList.toggle('on', now < clipUntil)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [channels, props.horizontal])

  return (
    <div className={`meter${props.horizontal ? ' horizontal' : ''}`} style={props.horizontal ? undefined : { height: props.height ?? 150 }}>
      <div ref={clip} className="meter-clip" title="Clipped" />
      <div className="meter-bars">
        {Array.from({ length: channels }, (_, ch) => (
          <div key={ch} className="meter-bar">
            <div className="meter-cover" ref={(el) => { covers.current[ch] = el }} />
            <div className="meter-hold" ref={(el) => { holds.current[ch] = el }} />
          </div>
        ))}
      </div>
    </div>
  )
}

const CATEGORIES = ['EQ & Filter', 'Dynamics', 'Time & Space', 'Utility'] as const

/** Effect rack for a clip or track: add (menu or drag from the Effects panel), enable, reorder, remove, params. */
export function EffectRack(props: { target: RackTarget; effects: AudioEffect[]; compact?: boolean }): JSX.Element {
  const { target, effects } = props
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [dropping, setDropping] = useState(false)
  return (
    <div
      className={`fx-rack${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        const payload = getDragPayload(e)
        if (payload?.kind !== 'audioEffect') return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false)
        const payload = getDragPayload(e)
        endDrag()
        if (payload?.kind !== 'audioEffect') return
        e.preventDefault()
        addEffect(target, payload.type)
      }}
    >
      {effects.length === 0 && <div className="fx-empty muted">No effects</div>}
      {effects.map((fx, i) => {
        const def = getAudioEffect(fx.type)
        const isOpen = open[fx.id] ?? !props.compact
        return (
          <div key={fx.id} className={`fx-item${fx.enabled ? '' : ' disabled'}`}>
            <div className="fx-head">
              <input type="checkbox" checked={fx.enabled} title="Enable" onChange={() => toggleEffect(target, fx.id)} />
              <button className="fx-name" onClick={() => setOpen({ ...open, [fx.id]: !isOpen })} disabled={!def}>
                <span className="fx-caret">{isOpen ? '▾' : '▸'}</span>
                {def?.name ?? `${fx.type} (unknown)`}
              </button>
              <button className="btn ghost icon small" title="Move up" disabled={i === 0} onClick={() => moveEffect(target, fx.id, -1)}>↑</button>
              <button className="btn ghost icon small" title="Move down" disabled={i === effects.length - 1} onClick={() => moveEffect(target, fx.id, 1)}>↓</button>
              <button className="btn ghost icon small" title="Remove" onClick={() => removeEffect(target, fx.id)}>✕</button>
            </div>
            {isOpen && def && (
              <div className="fx-params">
                <ParamControls defs={def.params} values={fx.params} onChange={(k, v) => setEffectParam(target, fx.id, k, v)} />
              </div>
            )}
          </div>
        )
      })}
      <select
        className="select fx-add"
        value=""
        onChange={(e) => {
          if (e.target.value) addEffect(target, e.target.value)
        }}
      >
        <option value="">+ Add effect…</option>
        {CATEGORIES.map((cat) => (
          <optgroup key={cat} label={cat}>
            {AUDIO_EFFECTS.filter((d) => d.category === cat).map((d) => (
              <option key={d.type} value={d.type}>{d.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  )
}
