import { useState, type JSX } from 'react'
import type { Draft } from 'immer'
import type { Clip, TitleAnimation, TitleShapeLayer, TitleSpec, TitleTextLayer } from '@shared/types'
import { useProject } from '@/store/project'
import { updateClip } from '@/lib/editing'
import { uid } from '@/lib/ids'
import {
  SYSTEM_FONTS, TITLE_CATEGORIES, TITLE_TEMPLATES, createTitleFromTemplate, getTitleTemplate, newShapeLayer, newTextLayer, primaryFontName
} from '@/engine/titles'
import { ColorInput, NumberSlider, Row, Section, Toggle } from '../ui/controls'
import './Inspector.css'
import './TitleInspector.css'

type Selected = { kind: 'text' | 'shape'; id: string }
type Edit = (label: string, fn: (s: Draft<TitleSpec>) => void, coalesce?: string) => void

const ANIMATIONS: { value: TitleAnimation; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'slide-down', label: 'Slide down' },
  { value: 'slide-left', label: 'Slide left' },
  { value: 'slide-right', label: 'Slide right' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'pop', label: 'Pop' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'blur', label: 'Blur' },
  { value: 'wipe', label: 'Wipe' },
  { value: 'letter-fade', label: 'Letter fade' }
]

const WEIGHTS: [number, string][] = [
  [100, 'Thin'], [200, 'Extra Light'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'],
  [600, 'Semibold'], [700, 'Bold'], [800, 'Extra Bold'], [900, 'Black']
]

// ---------------------------------------------------------------- shared ----

function AnimationRows(props: {
  label: string
  value: { type: TitleAnimation; duration: number }
  onType(t: TitleAnimation): void
  onDuration(d: number): void
}): JSX.Element {
  return (
    <>
      <Row label={props.label}>
        <select className="select grow" value={props.value.type} onChange={(e) => props.onType(e.target.value as TitleAnimation)}>
          {ANIMATIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
      </Row>
      {props.value.type !== 'none' && (
        <Row label="Duration">
          <NumberSlider value={props.value.duration} min={0} max={5} step={0.05} unit="s" onChange={props.onDuration} />
        </Row>
      )}
    </>
  )
}

/** Reorders `id` within `list` by delta (+1 = towards the front / later in draw order). */
function shift<T extends { id: string }>(list: T[], id: string, delta: number): void {
  const i = list.findIndex((x) => x.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return
  const [x] = list.splice(i, 1)
  list.splice(j, 0, x)
}

// ---------------------------------------------------------------- layers ----

function LayerList(props: { spec: TitleSpec; selected: Selected | null; onSelect(s: Selected | null): void; edit: Edit }): JSX.Element {
  const { spec, selected, edit } = props

  const addText = (): void => {
    const layer = newTextLayer({ text: 'New text', fontSize: 80, y: 0.5 + 0.06 * (spec.texts.length % 5) })
    edit('Add text layer', (s) => {
      s.texts.push(layer)
    })
    props.onSelect({ kind: 'text', id: layer.id })
  }
  const addShape = (kind: 'rect' | 'line'): void => {
    const shape = newShapeLayer(kind === 'line' ? { kind, x: 0.4, y: 0.6, w: 0.2, h: 0.005, color: '#ffffff' } : { kind })
    edit(kind === 'line' ? 'Add line' : 'Add rectangle', (s) => {
      s.shapes.push(shape)
    })
    props.onSelect({ kind: 'shape', id: shape.id })
  }
  const duplicate = (sel: Selected): void => {
    const id = uid()
    const offset = <T extends { y: number }>(l: T): T => ({ ...structuredClone(l), id, y: Math.min(1, l.y + 0.04) })
    edit('Duplicate layer', (s) => {
      if (sel.kind === 'text') {
        const i = spec.texts.findIndex((x) => x.id === sel.id)
        if (i >= 0) s.texts.splice(i + 1, 0, offset(spec.texts[i]))
      } else {
        const i = spec.shapes.findIndex((x) => x.id === sel.id)
        if (i >= 0) s.shapes.splice(i + 1, 0, offset(spec.shapes[i]))
      }
    })
    props.onSelect({ kind: sel.kind, id })
  }
  const remove = (sel: Selected): void => {
    edit('Delete layer', (s) => {
      const list = sel.kind === 'text' ? s.texts : s.shapes
      const i = list.findIndex((x) => x.id === sel.id)
      if (i >= 0) list.splice(i, 1)
    })
    props.onSelect(null)
  }
  const move = (sel: Selected, delta: number): void =>
    edit('Reorder layers', (s) => {
      if (sel.kind === 'text') shift(s.texts, sel.id, delta)
      else shift(s.shapes, sel.id, delta)
    })

  // Front-most first: texts draw above shapes, and later entries above earlier ones.
  const rows: { sel: Selected; label: string; icon: string; index: number; count: number }[] = [
    ...spec.texts.map((t, i) => ({
      sel: { kind: 'text' as const, id: t.id }, icon: 'T', index: i, count: spec.texts.length,
      label: t.text.split('\n')[0] || '(empty text)'
    })).reverse(),
    ...spec.shapes.map((s, i) => ({
      sel: { kind: 'shape' as const, id: s.id }, icon: s.kind === 'line' ? '─' : '▭', index: i, count: spec.shapes.length,
      label: s.kind === 'line' ? 'Line' : 'Rectangle'
    })).reverse()
  ]

  return (
    <Section title="Layers">
      <div className="tti-layer-buttons">
        <button className="btn small" onClick={addText}>+ Text</button>
        <button className="btn small" onClick={() => addShape('rect')}>+ Rectangle</button>
        <button className="btn small" onClick={() => addShape('line')}>+ Line</button>
      </div>
      <div className="tti-layers">
        {rows.length === 0 && <div className="muted tti-none">No layers. Add text or a shape.</div>}
        {rows.map((r) => {
          const active = selected?.id === r.sel.id
          return (
            <div key={r.sel.id} className={`tti-layer${active ? ' active' : ''}`} onClick={() => props.onSelect(r.sel)}>
              <span className={`tti-layer-icon ${r.sel.kind}`}>{r.icon}</span>
              <span className="tti-layer-name">{r.label}</span>
              <span className="tti-layer-actions" onClick={(e) => e.stopPropagation()}>
                <button className="fxi-btn" title="Bring forward" disabled={r.index === r.count - 1} onClick={() => move(r.sel, 1)}>↑</button>
                <button className="fxi-btn" title="Send backward" disabled={r.index === 0} onClick={() => move(r.sel, -1)}>↓</button>
                <button className="fxi-btn" title="Duplicate" onClick={() => duplicate(r.sel)}>⧉</button>
                <button className="fxi-btn danger" title="Delete" onClick={() => remove(r.sel)}>✕</button>
              </span>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

// ------------------------------------------------------------ text layer ----

function TextLayerEditor(props: { layer: TitleTextLayer; edit: Edit }): JSX.Element {
  const { layer: t } = props
  const set = (label: string, fn: (l: Draft<TitleTextLayer>) => void, coalesce?: string): void =>
    props.edit(label, (s) => {
      const l = s.texts.find((x) => x.id === t.id)
      if (l) fn(l)
    }, coalesce ? `${t.id}:${coalesce}` : undefined)
  // Match the list by primary family so 'Georgia, serif' and 'Georgia' select the same entry.
  const primary = primaryFontName(t.fontFamily).toLowerCase()
  const listed = SYSTEM_FONTS.find((f) => f.value === t.fontFamily) ?? SYSTEM_FONTS.find((f) => primaryFontName(f.value).toLowerCase() === primary)

  return (
    <>
      <Section title="Text">
        <textarea
          className="textarea tti-text"
          rows={3}
          value={t.text}
          style={{ fontFamily: t.fontFamily }}
          onChange={(e) => set('Edit text', (l) => { l.text = e.target.value }, 'text')}
        />
        <Row label="Font">
          <select className="select grow" value={listed?.value ?? t.fontFamily} onChange={(e) => set('Change font', (l) => { l.fontFamily = e.target.value })}>
            {!listed && <option value={t.fontFamily}>{primaryFontName(t.fontFamily)} (custom)</option>}
            {SYSTEM_FONTS.map((f) => <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>{f.label}</option>)}
          </select>
        </Row>
        <Row label="Font family" title="Any installed font; comma-separated fallbacks allowed">
          <input className="input grow" value={t.fontFamily} onChange={(e) => set('Change font', (l) => { l.fontFamily = e.target.value }, 'font-family')} />
        </Row>
        <Row label="Size">
          <NumberSlider value={t.fontSize} min={8} max={400} step={1} unit="px" onChange={(v) => set('Font size', (l) => { l.fontSize = Math.max(1, v) }, 'size')} />
        </Row>
        <Row label="Weight">
          <select className="select grow" value={t.fontWeight} onChange={(e) => set('Font weight', (l) => { l.fontWeight = Number(e.target.value) })}>
            {WEIGHTS.map(([w, n]) => <option key={w} value={w}>{w} {n}</option>)}
          </select>
        </Row>
        <Row label="Style">
          <Toggle value={t.italic} label="Italic" onChange={(v) => set('Italic', (l) => { l.italic = v })} />
          <Toggle value={t.uppercase} label="All caps" onChange={(v) => set('All caps', (l) => { l.uppercase = v })} />
        </Row>
        <Row label="Color">
          <ColorInput value={t.color} onChange={(v) => set('Text color', (l) => { l.color = v }, 'color')} />
        </Row>
        <Row label="Align">
          <div className="tti-segment">
            {(['left', 'center', 'right'] as const).map((a) => (
              <button key={a} className={`btn small${t.align === a ? ' active' : ''}`} onClick={() => set('Align text', (l) => { l.align = a })}>
                {a === 'left' ? 'Left' : a === 'center' ? 'Center' : 'Right'}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Position X">
          <NumberSlider value={t.x} min={0} max={1} step={0.001} onChange={(v) => set('Move text', (l) => { l.x = v }, 'x')} />
        </Row>
        <Row label="Position Y">
          <NumberSlider value={t.y} min={0} max={1} step={0.001} onChange={(v) => set('Move text', (l) => { l.y = v }, 'y')} />
        </Row>
        <Row label="Tracking">
          <NumberSlider value={t.letterSpacing} min={-20} max={120} step={1} unit="px" onChange={(v) => set('Letter spacing', (l) => { l.letterSpacing = v }, 'tracking')} />
        </Row>
        <Row label="Line height">
          <NumberSlider value={t.lineHeight} min={0.6} max={3} step={0.05} onChange={(v) => set('Line height', (l) => { l.lineHeight = v }, 'leading')} />
        </Row>
      </Section>

      <Section title="Stroke, shadow & box" defaultOpen={t.stroke.enabled || t.shadow.enabled || t.box.enabled}>
        <Row label="Stroke"><Toggle value={t.stroke.enabled} label="Outline" onChange={(v) => set('Text stroke', (l) => { l.stroke.enabled = v })} /></Row>
        {t.stroke.enabled && (
          <>
            <Row label="Stroke color"><ColorInput value={t.stroke.color} onChange={(v) => set('Stroke color', (l) => { l.stroke.color = v }, 'stroke-color')} /></Row>
            <Row label="Stroke width">
              <NumberSlider value={t.stroke.width} min={0} max={40} step={0.5} unit="px" onChange={(v) => set('Stroke width', (l) => { l.stroke.width = v }, 'stroke-width')} />
            </Row>
          </>
        )}
        <Row label="Shadow"><Toggle value={t.shadow.enabled} label="Drop shadow / glow" onChange={(v) => set('Text shadow', (l) => { l.shadow.enabled = v })} /></Row>
        {t.shadow.enabled && (
          <>
            <Row label="Shadow color"><ColorInput value={t.shadow.color} onChange={(v) => set('Shadow color', (l) => { l.shadow.color = v }, 'shadow-color')} /></Row>
            <Row label="Blur"><NumberSlider value={t.shadow.blur} min={0} max={120} step={1} unit="px" onChange={(v) => set('Shadow blur', (l) => { l.shadow.blur = v }, 'shadow-blur')} /></Row>
            <Row label="Offset X"><NumberSlider value={t.shadow.x} min={-60} max={60} step={1} unit="px" onChange={(v) => set('Shadow offset', (l) => { l.shadow.x = v }, 'shadow-x')} /></Row>
            <Row label="Offset Y"><NumberSlider value={t.shadow.y} min={-60} max={60} step={1} unit="px" onChange={(v) => set('Shadow offset', (l) => { l.shadow.y = v }, 'shadow-y')} /></Row>
          </>
        )}
        <Row label="Box"><Toggle value={t.box.enabled} label="Background box" onChange={(v) => set('Text box', (l) => { l.box.enabled = v })} /></Row>
        {t.box.enabled && (
          <>
            <Row label="Box color"><ColorInput value={t.box.color} onChange={(v) => set('Box color', (l) => { l.box.color = v }, 'box-color')} /></Row>
            <Row label="Padding"><NumberSlider value={t.box.padding} min={0} max={160} step={1} unit="px" onChange={(v) => set('Box padding', (l) => { l.box.padding = v }, 'box-padding')} /></Row>
            <Row label="Radius"><NumberSlider value={t.box.radius} min={0} max={120} step={1} unit="px" onChange={(v) => set('Box radius', (l) => { l.box.radius = v }, 'box-radius')} /></Row>
          </>
        )}
      </Section>

      <Section title="Animation">
        <AnimationRows
          label="In"
          value={t.animIn}
          onType={(v) => set('Animation in', (l) => { l.animIn.type = v })}
          onDuration={(v) => set('Animation in', (l) => { l.animIn.duration = v }, 'anim-in')}
        />
        <AnimationRows
          label="Out"
          value={t.animOut}
          onType={(v) => set('Animation out', (l) => { l.animOut.type = v })}
          onDuration={(v) => set('Animation out', (l) => { l.animOut.duration = v }, 'anim-out')}
        />
      </Section>
    </>
  )
}

// ----------------------------------------------------------- shape layer ----

function ShapeLayerEditor(props: { shape: TitleShapeLayer; edit: Edit }): JSX.Element {
  const { shape: s } = props
  const set = (label: string, fn: (l: Draft<TitleShapeLayer>) => void, coalesce?: string): void =>
    props.edit(label, (spec) => {
      const l = spec.shapes.find((x) => x.id === s.id)
      if (l) fn(l)
    }, coalesce ? `${s.id}:${coalesce}` : undefined)
  const geometry: [keyof Pick<TitleShapeLayer, 'x' | 'y' | 'w' | 'h'>, string][] = [['x', 'X'], ['y', 'Y'], ['w', 'Width'], ['h', 'Height']]

  return (
    <>
      <Section title={s.kind === 'line' ? 'Line' : 'Rectangle'}>
        <Row label="Kind">
          <select className="select grow" value={s.kind} onChange={(e) => set('Shape kind', (l) => { l.kind = e.target.value as TitleShapeLayer['kind'] })}>
            <option value="rect">Rectangle</option>
            <option value="line">Line (rounded bar)</option>
          </select>
        </Row>
        {geometry.map(([k, label]) => (
          <Row key={k} label={label}>
            <NumberSlider value={s[k]} min={0} max={1} step={0.001} onChange={(v) => set('Edit shape', (l) => { l[k] = v }, k)} />
          </Row>
        ))}
        <Row label="Color"><ColorInput value={s.color} onChange={(v) => set('Shape color', (l) => { l.color = v }, 'color')} /></Row>
        {s.kind === 'rect' && (
          <Row label="Corner radius">
            <NumberSlider value={s.radius} min={0} max={200} step={1} unit="px" onChange={(v) => set('Corner radius', (l) => { l.radius = v }, 'radius')} />
          </Row>
        )}
      </Section>
      <Section title="Animation">
        <AnimationRows
          label="In"
          value={s.animIn}
          onType={(v) => set('Animation in', (l) => { l.animIn.type = v })}
          onDuration={(v) => set('Animation in', (l) => { l.animIn.duration = v }, 'anim-in')}
        />
        <AnimationRows
          label="Out"
          value={s.animOut}
          onType={(v) => set('Animation out', (l) => { l.animOut.type = v })}
          onDuration={(v) => set('Animation out', (l) => { l.animOut.duration = v }, 'anim-out')}
        />
      </Section>
    </>
  )
}

// ------------------------------------------------------------ background ----

function BackgroundEditor(props: { spec: TitleSpec; edit: Edit }): JSX.Element {
  const { spec, edit } = props
  const bg = spec.background
  const media = useProject((s) => s.project.media)
  const visual = media.filter((m) => m.kind === 'image' || (m.kind === 'video' && m.hasVideo))

  const setType = (type: TitleSpec['background']['type']): void => {
    edit('Title background', (s) => {
      if (type === 'none') s.background = { type: 'none' }
      else if (type === 'solid') s.background = { type: 'solid', color: bg.type === 'gradient' ? bg.from : '#000000' }
      else if (type === 'gradient') s.background = { type: 'gradient', from: bg.type === 'solid' ? bg.color : '#7c5cff', to: '#ff5c8a', angle: 135 }
      else s.background = { type: 'media', mediaId: visual[0]?.id ?? '', dim: 0.35 }
    })
  }

  return (
    <Section title="Background" defaultOpen={bg.type !== 'none'}>
      <Row label="Type">
        <select className="select grow" value={bg.type} onChange={(e) => setType(e.target.value as TitleSpec['background']['type'])}>
          <option value="none">None (transparent)</option>
          <option value="solid">Solid colour</option>
          <option value="gradient">Gradient</option>
          <option value="media">Image / video still</option>
        </select>
      </Row>
      {bg.type === 'solid' && (
        <Row label="Color">
          <ColorInput value={bg.color} onChange={(v) => edit('Background color', (s) => { if (s.background.type === 'solid') s.background.color = v }, 'bg-color')} />
        </Row>
      )}
      {bg.type === 'gradient' && (
        <>
          <Row label="From">
            <ColorInput value={bg.from} onChange={(v) => edit('Background gradient', (s) => { if (s.background.type === 'gradient') s.background.from = v }, 'bg-from')} />
          </Row>
          <Row label="To">
            <ColorInput value={bg.to} onChange={(v) => edit('Background gradient', (s) => { if (s.background.type === 'gradient') s.background.to = v }, 'bg-to')} />
          </Row>
          <Row label="Angle">
            <NumberSlider value={bg.angle} min={0} max={360} step={1} unit="°" onChange={(v) => edit('Background gradient', (s) => { if (s.background.type === 'gradient') s.background.angle = v }, 'bg-angle')} />
          </Row>
        </>
      )}
      {bg.type === 'media' && (
        <>
          <Row label="Media">
            <select
              className="select grow"
              value={bg.mediaId}
              onChange={(e) => edit('Background media', (s) => { if (s.background.type === 'media') s.background.mediaId = e.target.value })}
            >
              <option value="">{visual.length ? 'Choose…' : 'Import an image or video first'}</option>
              {visual.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Row>
          <Row label="Dim">
            <NumberSlider value={bg.dim} min={0} max={1} step={0.01} onChange={(v) => edit('Background dim', (s) => { if (s.background.type === 'media') s.background.dim = v }, 'bg-dim')} />
          </Row>
        </>
      )}
    </Section>
  )
}

// -------------------------------------------------------------- template ----

function TemplatePicker(props: { clip: Clip; spec: TitleSpec }): JSX.Element {
  const { clip, spec } = props
  const [choice, setChoice] = useState(spec.template ?? TITLE_TEMPLATES[0].id)

  const apply = (): void => {
    const { spec: next, name } = createTitleFromTemplate(choice)
    const oldName = spec.template ? getTitleTemplate(spec.template).name : null
    updateClip(clip.id, 'Apply title template', (c) => {
      // Keep the words the user already typed, layer by layer.
      const old = c.title?.texts ?? []
      next.texts.forEach((t, i) => {
        if (old[i]) t.text = old[i].text
      })
      c.title = next
      if (!oldName || c.name === oldName || c.name === 'Title') c.name = name
    })
  }

  return (
    <Section title="Template">
      <Row label="Template">
        <select className="select grow" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {TITLE_CATEGORIES.map((cat) => (
            <optgroup key={cat} label={cat}>
              {TITLE_TEMPLATES.filter((t) => t.category === cat).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </optgroup>
          ))}
        </select>
        <button className="btn small" onClick={apply} title="Replace the layout and style; your text is kept">Apply</button>
      </Row>
    </Section>
  )
}

// Title editor: text layers, fonts, colours, background, animations.
export function TitleInspector(props: { clip: Clip }): JSX.Element {
  const { clip } = props
  const spec = clip.title
  const [picked, setPicked] = useState<Selected | null>(null)
  if (!spec) return <div className="empty">This clip has no title data.</div>

  const edit: Edit = (label, fn, coalesce) =>
    updateClip(clip.id, label, (c) => {
      if (c.title) fn(c.title)
    }, coalesce ? `title:${clip.id}:${coalesce}` : undefined)

  // Fall back to the first text (or shape) when nothing valid is picked.
  const exists = (s: Selected | null): s is Selected =>
    !!s && (s.kind === 'text' ? spec.texts.some((t) => t.id === s.id) : spec.shapes.some((x) => x.id === s.id))
  const selected: Selected | null = exists(picked)
    ? picked
    : spec.texts[0] ? { kind: 'text', id: spec.texts[0].id } : spec.shapes[0] ? { kind: 'shape', id: spec.shapes[0].id } : null
  const text = selected?.kind === 'text' ? spec.texts.find((t) => t.id === selected.id) : undefined
  const shape = selected?.kind === 'shape' ? spec.shapes.find((s) => s.id === selected.id) : undefined

  return (
    <div className="tti">
      <TemplatePicker key={clip.id} clip={clip} spec={spec} />
      <LayerList spec={spec} selected={selected} onSelect={setPicked} edit={edit} />
      {text && <TextLayerEditor key={text.id} layer={text} edit={edit} />}
      {shape && <ShapeLayerEditor key={shape.id} shape={shape} edit={edit} />}
      <BackgroundEditor spec={spec} edit={edit} />
    </div>
  )
}
