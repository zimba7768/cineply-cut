import { useState, type JSX } from 'react'
import type { Clip } from '@shared/types'
import { addVideoEffect, updateClip } from '@/lib/editing'
import { getDragPayload } from '@/lib/dnd'
import { defaultParams } from '@/lib/params'
import { VIDEO_EFFECTS, VIDEO_EFFECT_CATEGORIES, getVideoEffect } from '@/engine/effects'
import { ParamControls, Section } from '../ui/controls'
import './Inspector.css'
import './EffectsInspector.css'

// Video effect stack of a clip (add/remove/reorder/params).
export function EffectsInspector(props: { clip: Clip }): JSX.Element {
  const { clip } = props
  const effects = clip.video.effects
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dropping, setDropping] = useState(false)

  const edit = (label: string, fn: (list: Clip['video']['effects']) => void, coalesce?: string): void =>
    updateClip(clip.id, label, (c) => fn(c.video.effects as Clip['video']['effects']), coalesce)

  const move = (index: number, delta: number): void =>
    edit('Reorder effects', (list) => {
      const to = index + delta
      if (to < 0 || to >= list.length) return
      const [fx] = list.splice(index, 1)
      list.splice(to, 0, fx)
    })

  const toggleCollapsed = (id: string): void => {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setCollapsed(next)
  }

  const addSelect = (
    <select
      className="select fxi-add"
      value=""
      onChange={(e) => {
        if (e.target.value) addVideoEffect(clip.id, e.target.value)
      }}
    >
      <option value="">+ Add effect…</option>
      {VIDEO_EFFECT_CATEGORIES.map((cat) => (
        <optgroup key={cat} label={cat}>
          {VIDEO_EFFECTS.filter((d) => d.category === cat).map((d) => <option key={d.type} value={d.type}>{d.name}</option>)}
        </optgroup>
      ))}
    </select>
  )

  return (
    <div
      className={`fxi${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (getDragPayload(e)?.kind !== 'videoEffect') return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false)
        const payload = getDragPayload(e)
        if (payload?.kind !== 'videoEffect') return
        e.preventDefault()
        addVideoEffect(clip.id, payload.type)
      }}
    >
      <Section title={`Video effects${effects.length ? ` (${effects.length})` : ''}`} right={addSelect}>
        {effects.length === 0 && (
          <div className="empty fxi-empty">No effects yet. Pick one above or drag one here from the Effects panel.</div>
        )}
        {effects.map((fx, i) => {
          const def = getVideoEffect(fx.type)
          const open = !collapsed.has(fx.id)
          return (
            <div key={fx.id} className={`fxi-card${fx.enabled ? '' : ' disabled'}`}>
              <div className="fxi-head">
                <button className="fxi-btn" onClick={() => toggleCollapsed(fx.id)} title={open ? 'Collapse' : 'Expand'}>{open ? '▾' : '▸'}</button>
                <input
                  type="checkbox"
                  checked={fx.enabled}
                  title={fx.enabled ? 'Disable' : 'Enable'}
                  onChange={(e) => edit(e.target.checked ? 'Enable effect' : 'Disable effect', (list) => {
                    const x = list.find((f) => f.id === fx.id)
                    if (x) x.enabled = e.target.checked
                  })}
                />
                <span className="fxi-name" onDoubleClick={() => toggleCollapsed(fx.id)}>{def?.name ?? `Unknown effect (${fx.type})`}</span>
                <button className="fxi-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up (applied earlier)">↑</button>
                <button className="fxi-btn" disabled={i === effects.length - 1} onClick={() => move(i, 1)} title="Move down (applied later)">↓</button>
                <button
                  className="fxi-btn"
                  disabled={!def}
                  title="Reset parameters"
                  onClick={() => edit(`Reset ${def?.name ?? 'effect'}`, (list) => {
                    const x = list.find((f) => f.id === fx.id)
                    if (x && def) x.params = defaultParams(def.params)
                  })}
                >↺</button>
                <button
                  className="fxi-btn danger"
                  title="Remove"
                  onClick={() => edit(`Remove ${def?.name ?? 'effect'}`, (list) => {
                    const k = list.findIndex((f) => f.id === fx.id)
                    if (k >= 0) list.splice(k, 1)
                  })}
                >✕</button>
              </div>
              {open && def && def.params.length > 0 && (
                <div className="fxi-body">
                  <ParamControls
                    defs={def.params}
                    values={fx.params}
                    onChange={(key, v) => edit(`Edit ${def.name}`, (list) => {
                      const x = list.find((f) => f.id === fx.id)
                      if (x) x.params[key] = v
                    }, `fx-param:${fx.id}:${key}`)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </Section>
    </div>
  )
}
