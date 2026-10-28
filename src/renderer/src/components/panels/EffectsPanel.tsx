import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { Clip } from '@shared/types'
import { findClip, findTrack, useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { endDrag, setDragPayload, type DragPayload } from '@/lib/dnd'
import { defaultParams } from '@/lib/params'
import { addAudioEffect, addVideoEffect, setTransition } from '@/lib/editing'
import { TRANSITIONS, TRANSITION_CATEGORIES, drawTransitionPreview, type TransitionDef } from '@/engine/transitions'
import { VIDEO_EFFECTS, VIDEO_EFFECT_CATEGORIES } from '@/engine/effects'
import { AUDIO_EFFECTS } from '@/audio/effects'
import './EffectsPanel.css'

const THUMB_W = 160
const THUMB_H = 90
const LOOP_MS = 1800

/**
 * Animated transition preview between two test cards. Static at p = 0.5 unless `playing`, in which case
 * it loops (with a short hold on each card).
 */
export function TransitionThumb(props: {
  def: TransitionDef
  params?: Record<string, number | string | boolean>
  playing: boolean
  width?: number
  height?: number
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const { def, playing } = props
  const w = props.width ?? THUMB_W
  const h = props.height ?? THUMB_H
  const params = useMemo(() => props.params ?? defaultParams(def.params), [props.params, def])

  useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    if (!playing) {
      drawTransitionPreview(ctx, def, 0.5, params, w, h)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const frame = (now: number): void => {
      const phase = ((now - t0) % LOOP_MS) / LOOP_MS
      const p = Math.min(1, Math.max(0, (phase - 0.15) / 0.7))
      drawTransitionPreview(ctx, def, p, params, w, h)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [def, params, playing, w, h])

  return <canvas ref={ref} width={w} height={h} />
}

// --------------------------------------------------------------- applying ----

/** Selected clips on tracks of the given kind (a selected video clip contributes its linked audio). */
function selectedClips(kind: 'video' | 'audio'): Clip[] {
  const p = useProject.getState().project
  const out: Clip[] = []
  for (const id of useUi.getState().selection) {
    const c = findClip(p, id)
    if (!c) continue
    const candidates = c.linkId ? p.clips.filter((x) => x.linkId === c.linkId) : [c]
    for (const x of candidates) {
      if (findTrack(p, x.trackId)?.kind === kind && !out.includes(x)) out.push(x)
    }
  }
  return out
}

function applyItem(payload: DragPayload, name: string): void {
  const ui = useUi.getState()
  const kind = payload.kind === 'audioEffect' ? 'audio' : 'video'
  const clips = selectedClips(kind)
  if (clips.length === 0) {
    ui.showToast(`Select a ${kind} clip on the timeline first`, 'error')
    return
  }
  for (const c of clips) {
    if (payload.kind === 'transition') setTransition(c.id, 'in', payload.type)
    else if (payload.kind === 'videoEffect') addVideoEffect(c.id, payload.type)
    else if (payload.kind === 'audioEffect') addAudioEffect(c.id, payload.type)
  }
  if (payload.kind === 'transition' && clips.length === 1) ui.selectTransition({ clipId: clips[0].id, edge: 'in' })
  ui.showToast(`Applied ${name} to ${clips.length === 1 ? clips[0].name : `${clips.length} clips`}`)
}

// --------------------------------------------------------------- browser ----

interface Item {
  payload: DragPayload
  name: string
  category: string
}

function matches(item: Item, q: string): boolean {
  return !q || item.name.toLowerCase().includes(q) || item.category.toLowerCase().includes(q)
}

function Group(props: { title: string; count: number; forceOpen: boolean; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(true)
  const isOpen = open || props.forceOpen
  return (
    <div className="fxp-group">
      <div className="fxp-group-head" onClick={() => setOpen(!open)}>
        <span className="fxp-caret">{isOpen ? '▾' : '▸'}</span>
        <span className="grow">{props.title}</span>
        <span className="muted">{props.count}</span>
      </div>
      {isOpen && <div className="fxp-group-body">{props.children}</div>}
    </div>
  )
}

function dragProps(item: Item): Pick<JSX.IntrinsicElements['div'], 'draggable' | 'onDragStart' | 'onDragEnd' | 'onDoubleClick' | 'title'> {
  return {
    draggable: true,
    onDragStart: (e) => setDragPayload(e, item.payload),
    onDragEnd: () => endDrag(),
    onDoubleClick: () => applyItem(item.payload, item.name),
    title: `${item.name} — drag onto a clip, or double-click to apply to the selection`
  }
}

function TransitionCard(props: { def: TransitionDef }): JSX.Element {
  const [hover, setHover] = useState(false)
  const item: Item = { payload: { kind: 'transition', type: props.def.type }, name: props.def.name, category: props.def.category }
  return (
    <div className="card fxp-card" {...dragProps(item)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="thumb">
        <TransitionThumb def={props.def} playing={hover} />
      </div>
      <div className="fxp-card-foot">
        <span className="name grow">{props.def.name}</span>
        <button className="fxp-apply" title="Apply to the selected clip's start" onClick={() => applyItem(item.payload, item.name)}>+</button>
      </div>
    </div>
  )
}

function ItemRow(props: { item: Item; icon: string }): JSX.Element {
  const { item } = props
  return (
    <div className="fxp-item" {...dragProps(item)}>
      <span className="fxp-icon">{props.icon}</span>
      <span className="grow fxp-item-name">{item.name}</span>
      <button className="fxp-apply" title="Apply to the selected clip" onClick={() => applyItem(item.payload, item.name)}>+</button>
    </div>
  )
}

/** Groups items by category (in the given order, then any others) and drops empty groups. */
function byCategory<T extends Item>(items: T[], order: string[]): [string, T[]][] {
  const cats = [...order, ...items.map((i) => i.category).filter((c) => !order.includes(c))]
  return [...new Set(cats)].map((c) => [c, items.filter((i) => i.category === c)] as [string, T[]]).filter(([, list]) => list.length > 0)
}

// Transitions + video effects + audio effects browser.
export function EffectsPanel(): JSX.Element {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  const transitions = TRANSITIONS.filter((d) => matches({ payload: { kind: 'transition', type: d.type }, name: d.name, category: d.category }, q))
  const videoEffects: Item[] = VIDEO_EFFECTS.map((d) => ({ payload: { kind: 'videoEffect' as const, type: d.type }, name: d.name, category: d.category })).filter((i) => matches(i, q))
  const audioEffects: Item[] = AUDIO_EFFECTS.map((d) => ({ payload: { kind: 'audioEffect' as const, type: d.type }, name: d.name, category: d.category })).filter((i) => matches(i, q))
  const searching = q.length > 0

  return (
    <div className="fxp">
      <input className="input search fxp-search" placeholder="Search transitions and effects…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {searching && transitions.length + videoEffects.length + audioEffects.length === 0 && <div className="empty">Nothing matches “{query}”.</div>}

      {transitions.length > 0 && (
        <Group title="Video Transitions" count={transitions.length} forceOpen={searching}>
          {TRANSITION_CATEGORIES.map((cat) => {
            const list = transitions.filter((d) => d.category === cat)
            if (list.length === 0) return null
            return (
              <div key={cat}>
                <div className="category-label">{cat}</div>
                <div className="grid-cards fxp-grid">
                  {list.map((d) => <TransitionCard key={d.type} def={d} />)}
                </div>
              </div>
            )
          })}
        </Group>
      )}

      {videoEffects.length > 0 && (
        <Group title="Video Effects" count={videoEffects.length} forceOpen={searching}>
          {byCategory(videoEffects, VIDEO_EFFECT_CATEGORIES).map(([cat, list]) => (
            <div key={cat}>
              <div className="category-label">{cat}</div>
              <div className="fxp-list">{list.map((i) => <ItemRow key={i.name} item={i} icon="◐" />)}</div>
            </div>
          ))}
        </Group>
      )}

      {(audioEffects.length > 0 || !searching) && (
        <Group title="Audio Effects" count={audioEffects.length} forceOpen={searching}>
          {audioEffects.length === 0 && <div className="empty">No audio effects available.</div>}
          {byCategory(audioEffects, ['EQ & Filter', 'Dynamics', 'Time & Space', 'Utility']).map(([cat, list]) => (
            <div key={cat}>
              <div className="category-label">{cat}</div>
              <div className="fxp-list">{list.map((i) => <ItemRow key={i.name} item={i} icon="♪" />)}</div>
            </div>
          ))}
        </Group>
      )}
      <div className="fxp-hint muted">Drag onto a clip on the timeline, or select a clip and press +.</div>
    </div>
  )
}
