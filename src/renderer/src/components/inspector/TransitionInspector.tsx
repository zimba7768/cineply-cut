import type { JSX } from 'react'
import { clipBefore, useProject } from '@/store/project'
import { setTransition, updateClip } from '@/lib/editing'
import { defaultParams } from '@/lib/params'
import { timecode } from '@/lib/time'
import { TRANSITIONS, TRANSITION_CATEGORIES, getTransition } from '@/engine/transitions'
import { NumberSlider, ParamControls, Row, Section } from '../ui/controls'
import { TransitionThumb } from '../panels/EffectsPanel'
import './Inspector.css'
import './EffectsInspector.css'

// Selected transition: type, duration, params.
export function TransitionInspector(props: { clipId: string; edge: 'in' | 'out' }): JSX.Element {
  const { clipId, edge } = props
  const project = useProject((s) => s.project)
  const clip = project.clips.find((c) => c.id === clipId)
  const spec = clip ? (edge === 'in' ? clip.transitionIn : clip.transitionOut) : undefined
  if (!clip || !spec) return <div className="empty">This transition no longer exists.</div>

  const key = edge === 'in' ? 'transitionIn' : 'transitionOut'
  const def = getTransition(spec.type)
  const fps = project.sequence.fps
  const prev = edge === 'in' ? clipBefore(project, clip) : undefined
  // Same limits as setTransition: at most half of each clip it overlaps.
  const minDur = 1 / fps
  const maxDur = Math.max(minDur, Math.min(clip.duration / 2, prev ? prev.duration / 2 : Infinity))
  const alignment = edge === 'out' ? 'Ends at the clip end (fades to the tracks below)' : prev ? 'Centred on the cut' : 'Starts at the clip start (fades in from the tracks below)'

  const setDuration = (d: number): void => {
    const dur = Math.min(maxDur, Math.max(minDur, d))
    updateClip(clipId, 'Transition duration', (c) => {
      const s = c[key]
      if (s) s.duration = dur
    }, `transition-duration:${clipId}:${edge}`)
  }
  const setParam = (k: string, v: number | string | boolean): void => {
    updateClip(clipId, `Edit ${def.name}`, (c) => {
      const s = c[key]
      if (s) s.params[k] = v
    }, `transition-param:${clipId}:${edge}:${k}`)
  }
  const resetParams = (): void => {
    updateClip(clipId, `Reset ${def.name}`, (c) => {
      const s = c[key]
      if (s) s.params = defaultParams(getTransition(s.type).params)
    })
  }

  return (
    <>
      <div className="inspector-title">
        <span className="inspector-swatch" style={{ background: 'var(--transition)' }} />
        <span className="inspector-name">{def.name}</span>
        <span className="muted">{edge === 'in' ? 'In' : 'Out'}</span>
      </div>
      <Section title="Transition">
        <div className="fxi-preview">
          <TransitionThumb def={def} params={spec.params} playing width={256} height={144} />
        </div>
        <Row label="Type">
          <select className="select grow" value={spec.type} onChange={(e) => setTransition(clipId, edge, e.target.value, spec.duration)}>
            {TRANSITION_CATEGORIES.map((cat) => (
              <optgroup key={cat} label={cat}>
                {TRANSITIONS.filter((t) => t.category === cat).map((t) => <option key={t.type} value={t.type}>{t.name}</option>)}
              </optgroup>
            ))}
          </select>
        </Row>
        <Row label="Duration" title={`Up to ${maxDur.toFixed(2)} s (half the length of the clips involved)`}>
          <NumberSlider value={spec.duration} min={minDur} max={maxDur} step={1 / fps} unit="s" onChange={setDuration} format={(v) => v.toFixed(2)} />
        </Row>
        <Row label="">
          <span className="muted mono-small">{timecode(spec.duration, fps)} · {Math.round(spec.duration * fps)} frames</span>
        </Row>
        <Row label="Alignment"><span className="inspector-value wrap">{alignment}</span></Row>
        <Row label="Between">
          <span className="inspector-value">{prev ? `${prev.name} → ${clip.name}` : edge === 'in' ? `(below) → ${clip.name}` : `${clip.name} → (below)`}</span>
        </Row>
      </Section>
      {def.params.length > 0 && (
        <Section title="Parameters" right={<button className="btn small ghost" onClick={resetParams}>Reset</button>}>
          <ParamControls defs={def.params} values={spec.params} onChange={setParam} />
        </Section>
      )}
      <div className="fxi-footer">
        <button className="btn danger" onClick={() => setTransition(clipId, edge, null)}>Remove transition</button>
      </div>
    </>
  )
}
