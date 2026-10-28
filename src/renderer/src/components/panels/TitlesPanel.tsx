import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { TitleSpec } from '@shared/types'
import { useProject } from '@/store/project'
import { endDrag, setDragPayload } from '@/lib/dnd'
import { addColorMatte, addTitleClip } from '@/lib/editing'
import { TITLE_CATEGORIES, TITLE_TEMPLATES, renderTitle, type TitleTemplate } from '@/engine/titles'
import { ColorInput } from '../ui/controls'
import './TitlesPanel.css'

const THUMB_W = 224
const THUMB_H = 126

/**
 * Draws a title spec into a 16:9 thumbnail canvas, letterboxing the sequence frame (so vertical
 * projects preview correctly). Title coordinates are sequence pixels, so we draw through a scale.
 */
export function drawTitleThumb(ctx: CanvasRenderingContext2D, spec: TitleSpec, t: number, duration: number, seqW: number, seqH: number): void {
  const cw = ctx.canvas.width
  const ch = ctx.canvas.height
  const k = Math.min(cw / seqW, ch / seqH)
  const ox = (cw - seqW * k) / 2
  const oy = (ch - seqH * k) / 2
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, cw, ch)
  const g = ctx.createLinearGradient(0, oy, 0, oy + seqH * k)
  g.addColorStop(0, '#3a3f4b')
  g.addColorStop(1, '#1d2027')
  ctx.fillStyle = g
  ctx.fillRect(ox, oy, seqW * k, seqH * k)
  ctx.save()
  ctx.beginPath()
  ctx.rect(ox, oy, seqW * k, seqH * k)
  ctx.clip()
  ctx.setTransform(k, 0, 0, k, ox, oy)
  renderTitle(ctx, spec, t, duration, seqW, seqH, () => null)
  ctx.restore()
}

function TemplateCard(props: { template: TitleTemplate; seqW: number; seqH: number }): JSX.Element {
  const { template, seqW, seqH } = props
  const ref = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState(false)
  const spec = useMemo(() => template.create(), [template])

  useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    const dur = template.defaultDuration
    if (!hover) {
      drawTitleThumb(ctx, spec, dur / 2, dur, seqW, seqH)
      return
    }
    // Play the whole clip (in and out animations) on hover.
    let raf = 0
    const t0 = performance.now()
    const frame = (now: number): void => {
      const t = (((now - t0) / 1000) % (dur + 0.6)) - 0.3
      drawTitleThumb(ctx, spec, Math.min(Math.max(0, t), dur - 0.001), dur, seqW, seqH)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [hover, spec, template, seqW, seqH])

  // Fonts load lazily; redraw once they're ready so thumbnails use the right faces.
  useEffect(() => {
    let alive = true
    void document.fonts?.ready.then(() => {
      const ctx = ref.current?.getContext('2d')
      if (alive && ctx) drawTitleThumb(ctx, spec, template.defaultDuration / 2, template.defaultDuration, seqW, seqH)
    })
    return () => {
      alive = false
    }
  }, [spec, template, seqW, seqH])

  return (
    <div
      className="card ttp-card"
      draggable
      onDragStart={(e) => setDragPayload(e, { kind: 'titleTemplate', templateId: template.id })}
      onDragEnd={() => endDrag()}
      onDoubleClick={() => addTitleClip(template.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${template.name} — drag to the timeline, or double-click to add at the playhead`}
    >
      <div className="thumb">
        <canvas ref={ref} width={THUMB_W} height={THUMB_H} />
      </div>
      <div className="ttp-foot">
        <span className="name">{template.name}</span>
        <button className="ttp-add" title="Add at playhead" onClick={() => addTitleClip(template.id)}>+</button>
      </div>
    </div>
  )
}

const MATTE_SWATCHES = ['#000000', '#ffffff', '#1d2027', '#7c5cff', '#ff5c6c', '#ffb547', '#3ccf91', '#2f6fe0']

function ColorMatte(): JSX.Element {
  const [color, setColor] = useState('#000000')
  return (
    <div className="ttp-matte">
      <div className="category-label" style={{ padding: 0 }}>Colour matte</div>
      <div className="ttp-swatches">
        {MATTE_SWATCHES.map((c) => (
          <button key={c} className={`ttp-swatch${c === color ? ' active' : ''}`} style={{ background: c }} title={c} onClick={() => setColor(c)} />
        ))}
      </div>
      <div className="ttp-matte-row">
        <ColorInput value={color} onChange={setColor} />
        <button className="btn small primary" onClick={() => addColorMatte(color)}>Add at playhead</button>
      </div>
    </div>
  )
}

// Title templates browser.
export function TitlesPanel(): JSX.Element {
  const seqW = useProject((s) => s.project.sequence.width)
  const seqH = useProject((s) => s.project.sequence.height)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const templates = TITLE_TEMPLATES.filter((t) => !q || t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q))

  return (
    <div className="ttp">
      <input className="input search" placeholder="Search titles…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {templates.length === 0 && <div className="empty">No title templates match “{query}”.</div>}
      {TITLE_CATEGORIES.map((cat) => {
        const list = templates.filter((t) => t.category === cat)
        if (list.length === 0) return null
        return (
          <div key={cat}>
            <div className="category-label">{cat}</div>
            <div className="grid-cards ttp-grid">
              {list.map((t) => <TemplateCard key={t.id} template={t} seqW={seqW} seqH={seqH} />)}
            </div>
          </div>
        )
      })}
      <ColorMatte />
    </div>
  )
}
