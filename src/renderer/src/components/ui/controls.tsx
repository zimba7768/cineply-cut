import { useState, type JSX, type ReactNode } from 'react'
import type { ParamDef } from '@/lib/params'

/** Shared inspector controls. Use these so every panel looks and behaves the same. */

export function Section(props: { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen ?? true)
  return (
    <div className="section">
      <div className="section-head" onClick={() => setOpen(!open)}>
        <span style={{ width: 10 }}>{open ? '▾' : '▸'}</span>
        <span style={{ flex: 1 }}>{props.title}</span>
        <span onClick={(e) => e.stopPropagation()}>{props.right}</span>
      </div>
      {open && <div className="section-body">{props.children}</div>}
    </div>
  )
}

export function Row(props: { label: string; children: ReactNode; title?: string }): JSX.Element {
  return (
    <div className="row" title={props.title}>
      <label>{props.label}</label>
      <div className="grow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{props.children}</div>
    </div>
  )
}

/**
 * Slider + number box. onChange fires continuously while dragging; pass `onCommitStart` if the
 * caller wants to know when a drag begins (e.g. to start a coalesced undo step).
 */
export function NumberSlider(props: {
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange(v: number): void
  format?: (v: number) => string
  /** Logarithmic slider travel (frequencies). Requires min > 0. */
  log?: boolean
}): JSX.Element {
  const step = props.step ?? 0.01
  const log = props.log && props.min > 0
  // Log sliders run on a 0..1000 position mapped exponentially between min and max.
  const toPos = (v: number): number => (Math.log(Math.max(props.min, v) / props.min) / Math.log(props.max / props.min)) * 1000
  const fromPos = (p: number): number => {
    const v = props.min * Math.pow(props.max / props.min, p / 1000)
    return Math.round(v / step) * step
  }
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  return (
    <>
      <input
        type="range"
        min={log ? 0 : props.min}
        max={log ? 1000 : props.max}
        step={log ? 1 : step}
        value={log ? toPos(props.value) : props.value}
        onChange={(e) => props.onChange(log ? fromPos(Number(e.target.value)) : Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <input
        className="input"
        style={{ width: 62, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11 }}
        value={props.format ? props.format(props.value) : props.value.toFixed(decimals)}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (!Number.isNaN(v)) props.onChange(v)
        }}
      />
      {props.unit && <span className="muted" style={{ width: 18 }}>{props.unit}</span>}
    </>
  )
}

export function Toggle(props: { value: boolean; onChange(v: boolean): void; label?: string }): JSX.Element {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
      <input type="checkbox" checked={props.value} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  )
}

export function ColorInput(props: { value: string; onChange(v: string): void }): JSX.Element {
  // <input type=color> only accepts #rrggbb.
  const hex = /^#[0-9a-f]{6}$/i.test(props.value) ? props.value : '#ffffff'
  return (
    <>
      <input type="color" value={hex} onChange={(e) => props.onChange(e.target.value)} />
      <input className="input" style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 11 }} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </>
  )
}

/** Renders a list of ParamDefs (transition/effect parameters) generically. */
export function ParamControls(props: {
  defs: ParamDef[]
  values: Record<string, number | string | boolean>
  onChange(key: string, value: number | string | boolean): void
}): JSX.Element {
  return (
    <>
      {props.defs.map((d) => {
        const v = props.values[d.key] ?? d.default
        return (
          <Row key={d.key} label={d.label}>
            {d.type === 'number' && (
              <NumberSlider value={Number(v)} min={d.min ?? 0} max={d.max ?? 1} step={d.step} unit={d.unit} log={d.scale === 'log'} onChange={(x) => props.onChange(d.key, x)} />
            )}
            {d.type === 'color' && <ColorInput value={String(v)} onChange={(x) => props.onChange(d.key, x)} />}
            {d.type === 'boolean' && <Toggle value={Boolean(v)} onChange={(x) => props.onChange(d.key, x)} />}
            {d.type === 'text' && <input className="input grow" value={String(v)} onChange={(e) => props.onChange(d.key, e.target.value)} />}
            {d.type === 'select' && (
              <select className="select grow" value={String(v)} onChange={(e) => props.onChange(d.key, e.target.value)}>
                {d.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
          </Row>
        )
      })}
    </>
  )
}

export function Modal(props: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; width?: number }): JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={{ width: props.width }}>
        <div className="modal-head">
          <span style={{ flex: 1 }}>{props.title}</span>
          <button className="btn ghost icon" onClick={props.onClose}>✕</button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

export function ProgressBar(props: { value: number }): JSX.Element {
  const indet = props.value < 0
  return (
    <div className={`progress${indet ? ' indeterminate' : ''}`}>
      <div style={{ width: `${Math.round(Math.min(1, Math.max(0, props.value)) * 100)}%` }} />
    </div>
  )
}
