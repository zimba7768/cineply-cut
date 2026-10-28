import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { clipEnd, type Clip, type Id, type Marker, type Track } from '@shared/types'
import { clipBefore, findMedia, sequenceDuration, useProject } from '@/store/project'
import { usePlayback } from '@/store/playback'
import { useUi } from '@/store/ui'
import { preview } from '@/engine/playback'
import { getTransition } from '@/engine/transitions'
import { createTitleFromTemplate } from '@/engine/titles'
import { endDrag, getDragPayload, type DragPayload } from '@/lib/dnd'
import { snapToFrame, timecode } from '@/lib/time'
import * as edit from '@/lib/editing'
import {
  HEADER_W, RULER_H, SNAP_PX, bestSnap, clipsByTrack, computeLayout, rowAt, rowOf, snapTargets, type TrackLayout
} from './layout'
import { Lane } from './Lane'
import { Ruler, formatRulerTime } from './Ruler'
import { TrackHeader } from './TrackHeader'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'
import { Icon } from './icons'
import { MAX_ZOOM, MIN_ZOOM, registerViewport, revealTime, takePendingScroll, zoomAt, zoomBy, zoomToFit } from './viewport'
import './timeline.css'

const BOTTOM_PAD = 48
const VIEW_QUANTUM = 512

interface GhostRect {
  trackId: Id
  start: number
  duration: number
}

interface DropPlan {
  rects: GhostRect[]
  style: 'clip' | 'edge' | 'target'
  snapAt: number | null
  label?: string
  apply(): void
}

let gestureCounter = 0
const gestureKey = (): string => `timeline-gesture-${++gestureCounter}`

const titleDurations = new Map<string, number>()
function titleDuration(templateId: string): number {
  let d = titleDurations.get(templateId)
  if (d === undefined) {
    d = createTitleFromTemplate(templateId).duration
    titleDurations.set(templateId, d)
  }
  return d
}

const formatDelta = (dt: number, fps: number): string => `${dt < 0 ? '−' : '+'}${formatRulerTime(Math.abs(dt), fps)}`

function blurActive(): void {
  const el = document.activeElement
  if (el instanceof HTMLElement && el !== document.body) el.blur()
}

/** Follows the pointer until release. Escape cancels (onCancel runs instead of onUp). */
function trackPointer(onMove: (ev: PointerEvent) => void, onUp?: (ev: PointerEvent | null) => void, onCancel?: () => void): void {
  const cleanup = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    window.removeEventListener('keydown', key, true)
  }
  const up = (ev: PointerEvent): void => {
    cleanup()
    onUp?.(ev)
  }
  const key = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    ev.stopPropagation()
    cleanup()
    onCancel?.()
    onUp?.(null)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  window.addEventListener('keydown', key, true)
}

const inOutPoints = (): (number | null)[] => {
  const pb = usePlayback.getState()
  return [pb.inPoint, pb.outPoint]
}

// Multi-track timeline.
export function Timeline(): JSX.Element {
  const project = useProject((s) => s.project)
  const zoom = useUi((s) => s.zoom)
  const tool = useUi((s) => s.tool)
  const selection = useUi((s) => s.selection)
  const selectedTransition = useUi((s) => s.selectedTransition)
  const selectedTrackId = useUi((s) => s.selectedTrackId)
  const snapping = useUi((s) => s.snapping)

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const headersRef = useRef<HTMLDivElement>(null)
  const [viewSize, setViewSize] = useState({ w: 800, h: 200 })
  const [view, setView] = useState({ l: 0, r: 2048 })
  const [snapAt, setSnapAt] = useState<number | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [ghost, setGhost] = useState<DropPlan | null>(null)
  const [razorT, setRazorT] = useState<number | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [info, setInfo] = useState<{ x: number; y: number; text: string } | null>(null)
  const [renaming, setRenaming] = useState<{ marker: Marker; x: number; y: number } | null>(null)

  const fps = project.sequence.fps
  const layout = useMemo(() => computeLayout(project.tracks), [project.tracks])
  const layoutRef = useRef<TrackLayout>(layout)
  layoutRef.current = layout
  const byTrack = useMemo(() => clipsByTrack(project.clips), [project.clips])
  const mediaMap = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media])
  const duration = sequenceDuration(project)
  const contentW = Math.max(viewSize.w, duration * zoom + viewSize.w * 0.75)
  const contentH = Math.max(layout.height + BOTTOM_PAD, viewSize.h)

  // ---------------------------------------------------------- viewport ----

  const updateView = (): void => {
    const el = scrollRef.current
    if (!el) return
    const margin = el.clientWidth / 2
    const l = Math.floor((el.scrollLeft - margin) / VIEW_QUANTUM) * VIEW_QUANTUM
    const r = Math.ceil((el.scrollLeft + el.clientWidth + margin) / VIEW_QUANTUM) * VIEW_QUANTUM
    setView((v) => (v.l === l && v.r === r ? v : { l, r }))
  }

  const onScroll = (): void => {
    const el = scrollRef.current!
    if (headersRef.current) headersRef.current.style.transform = `translateY(${-el.scrollTop}px)`
    useUi.getState().setScrollX(el.scrollLeft)
    updateView()
  }

  useEffect(() => {
    const el = scrollRef.current!
    registerViewport(el)
    const ro = new ResizeObserver(() => {
      setViewSize({ w: el.clientWidth, h: el.clientHeight })
      updateView()
    })
    ro.observe(el)
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = el.getBoundingClientRect()
        const px = e.clientX - rect.left
        const z = useUi.getState().zoom
        zoomAt(z * Math.exp(-e.deltaY * 0.0015), (el.scrollLeft + px) / z, px)
      } else if (!e.shiftKey && el.scrollHeight <= el.clientHeight && e.deltaY !== 0) {
        e.preventDefault()
        el.scrollLeft += e.deltaY
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    // Keep the DOM scroll in sync when something else (e.g. opening a project) resets scrollX.
    const unsub = useUi.subscribe((s, prev) => {
      if (s.scrollX !== prev.scrollX && Math.abs(el.scrollLeft - s.scrollX) > 1) el.scrollLeft = s.scrollX
    })
    return () => {
      registerViewport(null)
      ro.disconnect()
      el.removeEventListener('wheel', onWheel)
      unsub()
    }
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    const pending = takePendingScroll()
    if (el && pending !== null) {
      el.scrollLeft = pending
      useUi.getState().setScrollX(el.scrollLeft)
    }
    updateView()
  }, [zoom])

  // ------------------------------------------------------- coordinates ----

  const toContent = (ev: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = contentRef.current!.getBoundingClientRect()
    return { x: ev.clientX - r.left, y: ev.clientY - r.top }
  }

  const autoScroll = (ev: PointerEvent): void => {
    const el = scrollRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (ev.clientX > r.right - 30) el.scrollLeft += 24
    else if (ev.clientX < r.left + 30) el.scrollLeft -= 24
  }

  const snapThreshold = (): number => SNAP_PX / useUi.getState().zoom

  // ---------------------------------------------------------- gestures ----

  const startMove = (e: React.PointerEvent, clip: Clip): void => {
    const ui = useUi.getState()
    const base = useProject.getState().project
    const alt = e.altKey
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const group = alt ? [clip.id] : edit.withLinked(base, [clip.id])
    const wasSelected = ui.selection.includes(clip.id)
    let sel = ui.selection
    if (additive) {
      sel = wasSelected ? sel.filter((id) => !group.includes(id)) : [...new Set([...sel, ...group])]
      ui.select(sel)
      if (wasSelected) return
    } else if (!wasSelected) {
      sel = group
      ui.select(sel)
    }

    const locked = new Set(base.tracks.filter((t) => t.locked).map((t) => t.id))
    const movingIds = alt ? [clip.id] : edit.withLinked(base, sel)
    const moving = base.clips.filter((c) => movingIds.includes(c.id) && !locked.has(c.trackId))
    if (moving.length === 0) return
    const primaryKind = base.tracks.find((t) => t.id === clip.trackId)!.kind
    const kindList = edit.tracksOfKind(base, primaryKind)
    const idxOf = (id: Id): number => kindList.findIndex((t) => t.id === id)
    const primaryIdx = idxOf(clip.trackId)
    const sameKind = moving.filter((c) => idxOf(c.trackId) >= 0)
    const minIdx = Math.min(...sameKind.map((c) => idxOf(c.trackId)))
    const maxIdx = Math.max(...sameKind.map((c) => idxOf(c.trackId)))
    const minStart = Math.min(...moving.map((c) => c.start))
    const targets = snapTargets(base, usePlayback.getState().time, new Set(movingIds), inOutPoints())
    const p0 = toContent(e)
    const key = gestureKey()
    let moved = false

    trackPointer((ev) => {
      autoScroll(ev)
      const pt = toContent(ev)
      if (!moved && Math.abs(pt.x - p0.x) < 4 && Math.abs(pt.y - p0.y) < 4) return
      moved = true
      const z = useUi.getState().zoom
      let dt = snapToFrame(clip.start + (pt.x - p0.x) / z, fps) - clip.start
      let at: number | null = null
      if (useUi.getState().snapping) {
        const s = bestSnap(moving.flatMap((c) => [c.start + dt, clipEnd(c) + dt]), targets, snapThreshold())
        if (s) {
          dt += s.shift
          at = s.at
        }
      }
      if (dt < -minStart) {
        dt = -minStart
        at = null
      }
      let dk = 0
      const row = rowAt(layoutRef.current, pt.y)
      if (row && row.track.kind === primaryKind) {
        dk = Math.max(-minIdx, Math.min(kindList.length - 1 - maxIdx, idxOf(row.track.id) - primaryIdx))
        if (sameKind.some((c) => kindList[idxOf(c.trackId) + dk].locked)) dk = 0
      }
      const moves = moving.map((c) => {
        const i = idxOf(c.trackId)
        return { id: c.id, start: c.start + dt, trackId: i >= 0 ? kindList[i + dk].id : c.trackId }
      })
      setSnapAt(at)
      setInfo({ x: ev.clientX, y: ev.clientY, text: formatDelta(dt, fps) })
      edit.applyGesture(moving.length > 1 ? 'Move clips' : 'Move clip', key, base, (d) => edit.opPlaceClips(d, moves))
    }, () => {
      setSnapAt(null)
      setInfo(null)
      if (!moved && !additive && wasSelected) ui.select(group)
    }, () => edit.applyGesture('Move clip', key, base, () => {}))
  }

  const startTrim = (e: React.PointerEvent, clip: Clip, edge: 'in' | 'out'): void => {
    const ui = useUi.getState()
    const base = useProject.getState().project
    const ripple = ui.tool === 'ripple'
    const lockedTrack = (id: Id): boolean => base.tracks.find((t) => t.id === id)?.locked ?? true
    const ids = (e.altKey ? [clip.id] : edit.withLinked(base, [clip.id]))
      .filter((id) => !lockedTrack(base.clips.find((c) => c.id === id)!.trackId))
    if (!ui.selection.includes(clip.id)) ui.select(ids)
    const [lo, hi] = edit.trimLimits(base, ids, edge, ripple)
    const edge0 = edge === 'in' ? clip.start : clipEnd(clip)
    const targets = snapTargets(base, usePlayback.getState().time, new Set(ids), inOutPoints())
    const p0 = toContent(e)
    const key = gestureKey()
    const label = ripple ? 'Ripple trim' : 'Trim'

    trackPointer((ev) => {
      autoScroll(ev)
      const z = useUi.getState().zoom
      let t = snapToFrame(edge0 + (toContent(ev).x - p0.x) / z, fps)
      let at: number | null = null
      if (useUi.getState().snapping) {
        const s = bestSnap([t], targets, snapThreshold())
        if (s) {
          t += s.shift
          at = s.at
        }
      }
      const delta = Math.min(hi, Math.max(lo, t - edge0))
      if (delta !== t - edge0) at = null
      setSnapAt(at)
      const newDur = clip.duration + (edge === 'in' ? -delta : delta)
      setInfo({ x: ev.clientX, y: ev.clientY, text: `${formatDelta(delta, fps)}  ·  ${formatRulerTime(newDur, fps)}` })
      edit.applyGesture(label, key, base, (d) => edit.opTrim(d, ids, edge, delta, ripple))
    }, () => {
      setSnapAt(null)
      setInfo(null)
    }, () => edit.applyGesture(label, key, base, () => {}))
  }

  const startMarquee = (e: React.PointerEvent): void => {
    const ui = useUi.getState()
    const p0 = toContent(e)
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const initial = additive ? ui.selection : []
    const row = rowAt(layoutRef.current, p0.y)
    useUi.setState({ selectedTrackId: row?.track.id ?? null })
    let moved = false
    trackPointer((ev) => {
      autoScroll(ev)
      const pt = toContent(ev)
      if (!moved && Math.abs(pt.x - p0.x) < 4 && Math.abs(pt.y - p0.y) < 4) return
      moved = true
      const r = { x0: Math.min(p0.x, pt.x), y0: Math.min(p0.y, pt.y), x1: Math.max(p0.x, pt.x), y1: Math.max(p0.y, pt.y) }
      setMarquee(r)
      const p = useProject.getState().project
      const z = useUi.getState().zoom
      const hits = p.clips.filter((c) => {
        const rr = rowOf(layoutRef.current, c.trackId)
        if (!rr || rr.track.locked) return false
        return c.start * z < r.x1 && clipEnd(c) * z > r.x0 && rr.top < r.y1 && rr.top + rr.height > r.y0
      })
      ui.select([...new Set([...initial, ...edit.withLinked(p, hits.map((c) => c.id))])])
    }, () => {
      setMarquee(null)
      if (!moved && !additive) ui.select([])
    })
  }

  const startHand = (e: React.PointerEvent): void => {
    const el = scrollRef.current!
    const sx = el.scrollLeft
    const sy = el.scrollTop
    el.classList.add('panning')
    trackPointer((ev) => {
      el.scrollLeft = sx - (ev.clientX - e.clientX)
      el.scrollTop = sy - (ev.clientY - e.clientY)
    }, () => el.classList.remove('panning'))
  }

  const razorTime = (clientX: number, clientY: number): number => {
    const p = useProject.getState().project
    let t = snapToFrame(Math.max(0, toContent({ clientX, clientY }).x / useUi.getState().zoom), fps)
    if (useUi.getState().snapping) {
      const s = bestSnap([t], [usePlayback.getState().time, ...p.markers.map((m) => m.time)], snapThreshold())
      if (s) t += s.shift
    }
    return t
  }

  const razor = (e: React.PointerEvent, clip: Clip): void => {
    const t = razorTime(e.clientX, e.clientY)
    if (e.shiftKey) {
      const p = useProject.getState().project
      const ids = p.clips.filter((c) => c.start < t && clipEnd(c) > t).map((c) => c.id)
      edit.splitAt(t, ids)
    } else {
      edit.splitAt(t, [clip.id], { linked: !e.altKey })
    }
  }

  const onContentPointerDown = (e: React.PointerEvent): void => {
    setMenu(null)
    blurActive()
    if (e.button === 1) {
      e.preventDefault()
      startHand(e)
      return
    }
    if (e.button !== 0) return
    const ui = useUi.getState()
    if (ui.tool === 'hand') {
      startHand(e)
      return
    }
    const target = e.target as HTMLElement
    const trans = target.closest<HTMLElement>('[data-transition]')
    if (trans) {
      const [clipId, edge] = trans.dataset.transition!.split(':')
      ui.selectTransition({ clipId, edge: edge as 'in' | 'out' })
      return
    }
    const clipEl = target.closest<HTMLElement>('[data-clip]')
    const p = useProject.getState().project
    const clip = clipEl ? p.clips.find((c) => c.id === clipEl.dataset.clip) : undefined
    if (!clip) {
      startMarquee(e)
      return
    }
    if (p.tracks.find((t) => t.id === clip.trackId)?.locked) return
    useUi.setState({ selectedTrackId: clip.trackId })
    if (ui.tool === 'razor') {
      razor(e, clip)
      return
    }
    const edgeEl = target.closest<HTMLElement>('[data-edge]')
    if (edgeEl) startTrim(e, clip, edgeEl.dataset.edge as 'in' | 'out')
    else startMove(e, clip)
  }

  const onContentPointerMove = (e: React.PointerEvent): void => {
    if (tool !== 'razor') return
    const overClip = (e.target as HTMLElement).closest('[data-clip]')
    setRazorT(overClip ? razorTime(e.clientX, e.clientY) : null)
  }

  // ------------------------------------------------------------- ruler ----

  const onRulerPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    setMenu(null)
    blurActive()
    if (usePlayback.getState().playing) preview.pause()
    const rect = e.currentTarget.getBoundingClientRect()
    const p = useProject.getState().project
    const targets = [...edit.editPoints(p), ...p.markers.map((m) => m.time), ...inOutPoints().filter((t): t is number => t !== null)]
    const scrub = (clientX: number): void => {
      const z = useUi.getState().zoom
      let t = Math.max(0, (clientX - rect.left + scrollRef.current!.scrollLeft) / z)
      if (useUi.getState().snapping) {
        const s = bestSnap([t], targets, snapThreshold())
        if (s) t += s.shift
      }
      usePlayback.getState().setTime(snapToFrame(t, fps))
    }
    scrub(e.clientX)
    trackPointer((ev) => {
      autoScroll(ev)
      scrub(ev.clientX)
    })
  }

  const onMarkerPointerDown = (e: React.PointerEvent, m: Marker): void => {
    if (e.button !== 0) return
    const x0 = e.clientX
    const key = gestureKey()
    let moved = false
    trackPointer((ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return
      moved = true
      const t = Math.max(0, snapToFrame(m.time + (ev.clientX - x0) / useUi.getState().zoom, fps))
      edit.updateMarker(m.id, 'Move marker', { time: t }, key)
    }, () => {
      if (!moved) usePlayback.getState().setTime(m.time)
    })
  }

  const onMarkerContextMenu = (e: React.MouseEvent, m: Marker): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Go to marker', onClick: () => usePlayback.getState().setTime(m.time) },
        { label: 'Rename…', onClick: () => setRenaming({ marker: m, x: e.clientX, y: e.clientY }) },
        { separator: true },
        ...edit.MARKER_COLORS.map((color) => ({
          label: `● ${color}`,
          checked: m.color === color,
          onClick: () => edit.updateMarker(m.id, 'Marker color', { color })
        })),
        { separator: true },
        { label: 'Delete marker', danger: true, onClick: () => edit.removeMarker(m.id) }
      ]
    })
  }

  // ------------------------------------------------------ context menus ----

  const clipMenu = (clip: Clip): MenuItem[] => {
    const p = useProject.getState().project
    const t = usePlayback.getState().time
    const ids = useUi.getState().selection
    const hasLink = p.clips.some((c) => ids.includes(c.id) && c.linkId)
    const speeds = [0.25, 0.5, 1, 1.5, 2, 4]
    return [
      { label: 'Split at playhead', shortcut: 'Ctrl+K', disabled: !(clip.start < t && clipEnd(clip) > t), onClick: () => edit.splitAt(t) },
      { label: 'Duplicate', shortcut: 'Ctrl+D', onClick: () => edit.duplicateClips() },
      { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => edit.copyClips() },
      { label: 'Cut', shortcut: 'Ctrl+X', onClick: () => edit.cutClips() },
      { separator: true },
      hasLink
        ? { label: 'Unlink', shortcut: 'Ctrl+L', onClick: () => edit.unlinkClips() }
        : { label: 'Link', shortcut: 'Ctrl+L', disabled: ids.length < 2, onClick: () => edit.linkClips() },
      { separator: true },
      ...speeds.map((s) => ({
        label: `Speed ${Math.round(s * 100)}%`,
        checked: Math.abs(clip.speed - s) < 1e-6,
        onClick: () => edit.setClipSpeed(clip.id, s)
      })),
      { separator: true },
      {
        label: 'Remove transitions',
        disabled: !clip.transitionIn && !clip.transitionOut,
        onClick: () => {
          if (clip.transitionIn) edit.setTransition(clip.id, 'in', null)
          if (clip.transitionOut) edit.setTransition(clip.id, 'out', null)
        }
      },
      { separator: true },
      { label: 'Delete', shortcut: 'Del', danger: true, onClick: () => edit.deleteClips(useUi.getState().selection, false) },
      { label: 'Ripple delete', shortcut: 'Shift+Del', danger: true, onClick: () => edit.deleteClips(useUi.getState().selection, true) }
    ]
  }

  const onContentContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const target = e.target as HTMLElement
    const p = useProject.getState().project
    const pt = toContent(e)
    const t = snapToFrame(Math.max(0, pt.x / zoom), fps)
    const row = rowAt(layout, pt.y)
    const trans = target.closest<HTMLElement>('[data-transition]')
    if (trans) {
      const [clipId, edge] = trans.dataset.transition!.split(':') as [string, 'in' | 'out']
      useUi.getState().selectTransition({ clipId, edge })
      setMenu({ x: e.clientX, y: e.clientY, items: [{ label: 'Remove transition', danger: true, onClick: () => edit.setTransition(clipId, edge, null) }] })
      return
    }
    const clipEl = target.closest<HTMLElement>('[data-clip]')
    const clip = clipEl ? p.clips.find((c) => c.id === clipEl.dataset.clip) : undefined
    if (clip) {
      if (!useUi.getState().selection.includes(clip.id)) useUi.getState().select(edit.withLinked(p, [clip.id]))
      setMenu({ x: e.clientX, y: e.clientY, items: clipMenu(clip) })
      return
    }
    const videoTrackId = row?.track.kind === 'video' ? row.track.id : undefined
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Paste here', shortcut: 'Ctrl+V', disabled: !edit.hasClipboard(), onClick: () => edit.pasteClips(t) },
        { label: 'Add title here', onClick: () => edit.addTitleClip('basic', { start: t, trackId: videoTrackId }) },
        { label: 'Add color matte here', onClick: () => edit.addColorMatte('#000000', { start: t, trackId: videoTrackId }) },
        { label: 'Add marker here', onClick: () => edit.addMarker(t) },
        { separator: true },
        { label: 'Add video track', onClick: () => edit.addTrack('video') },
        { label: 'Add audio track', onClick: () => edit.addTrack('audio') }
      ]
    })
  }

  const onHeaderContextMenu = (e: React.MouseEvent, track: Track): void => {
    e.preventDefault()
    e.stopPropagation()
    const p = useProject.getState().project
    const index = p.tracks.findIndex((t) => t.id === track.id)
    const lastOfKind = edit.tracksOfKind(p, track.kind).length <= 1
    const count = p.clips.filter((c) => c.trackId === track.id).length
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: track.kind === 'video' ? 'Add video track above' : 'Add audio track below', onClick: () => edit.addTrack(track.kind, { index: track.kind === 'video' ? index : index + 1 }) },
        { label: track.kind === 'video' ? 'Add audio track' : 'Add video track', onClick: () => edit.addTrack(track.kind === 'video' ? 'audio' : 'video') },
        { separator: true },
        {
          label: track.locked ? 'Unlock track' : 'Lock track',
          onClick: () => edit.updateTrack(track.id, track.locked ? 'Unlock track' : 'Lock track', (t) => { t.locked = !t.locked })
        },
        {
          label: 'Select all clips on track',
          disabled: count === 0,
          onClick: () => useUi.getState().select(useProject.getState().project.clips.filter((c) => c.trackId === track.id).map((c) => c.id))
        },
        { separator: true },
        { label: `Delete track${count ? ` (${count} clip${count > 1 ? 's' : ''})` : ''}`, danger: true, disabled: lastOfKind, onClick: () => edit.removeTrack(track.id) }
      ]
    })
  }

  // -------------------------------------------------------------- drops ----

  const planDrop = (payload: DragPayload, ev: { clientX: number; clientY: number }): DropPlan | null => {
    const p = useProject.getState().project
    const ui = useUi.getState()
    const pt = toContent(ev)
    const z = ui.zoom
    const t = Math.max(0, pt.x / z)
    const row = rowAt(layoutRef.current, pt.y)
    const targets = ui.snapping ? snapTargets(p, usePlayback.getState().time, new Set(), inOutPoints()) : []
    const snapStart = (start: number, dur: number): { start: number; at: number | null } => {
      const s = bestSnap([start, start + dur], targets, snapThreshold())
      return s ? { start: Math.max(0, start + s.shift), at: s.at } : { start, at: null }
    }

    switch (payload.kind) {
      case 'media': {
        const m = findMedia(p, payload.mediaId)
        if (!m || row?.track.locked) return null
        const first = edit.resolveMediaTargets(p, m, snapToFrame(t, fps), row?.track.id)
        const { start, at } = snapStart(snapToFrame(t, fps), first.duration)
        const tg = edit.resolveMediaTargets(p, m, start, row?.track.id)
        const rects = [tg.videoTrackId, tg.audioTrackId]
          .filter((id): id is Id => !!id)
          .map((trackId) => ({ trackId, start, duration: tg.duration }))
        if (rects.length === 0) return null
        return { rects, style: 'clip', snapAt: at, label: m.name, apply: () => edit.addMediaClip(m.id, { start, trackId: row?.track.id }) }
      }
      case 'titleTemplate': {
        const dur = titleDuration(payload.templateId)
        const trackId = row?.track.kind === 'video' ? row.track.id : undefined
        if (row?.track.locked && trackId) return null
        const { start, at } = snapStart(snapToFrame(t, fps), dur)
        const videos = edit.tracksOfKind(p, 'video')
        const ghostTrack = trackId
          ?? videos.find((v) => !v.locked && edit.isRangeFree(p, v.id, start, start + dur))?.id
          ?? videos[0]?.id
        return {
          rects: ghostTrack ? [{ trackId: ghostTrack, start, duration: dur }] : [],
          style: 'clip',
          snapAt: at,
          label: 'Title',
          apply: () => edit.addTitleClip(payload.templateId, { start, trackId })
        }
      }
      case 'transition': {
        if (!row || row.track.locked) return null
        const onRow = byTrackRef.current.get(row.track.id) ?? []
        let clip = onRow.find((c) => t >= c.start && t <= clipEnd(c))
        let edge: 'in' | 'out' = 'in'
        if (clip) {
          edge = t < clip.start + clip.duration / 2 ? 'in' : 'out'
        } else {
          let best = 24 / z
          for (const c of onRow) {
            if (Math.abs(t - c.start) < best) { best = Math.abs(t - c.start); clip = c; edge = 'in' }
            if (Math.abs(t - clipEnd(c)) < best) { best = Math.abs(t - clipEnd(c)); clip = c; edge = 'out' }
          }
        }
        if (!clip) return null
        const target = edit.transitionTarget(p, clip, edge)
        const tc = p.clips.find((c) => c.id === target.clipId)!
        const before = target.edge === 'in' ? clipBefore(p, tc) : undefined
        const def = getTransition(payload.type)
        const d = Math.max(1 / fps, Math.min(def.defaultDuration, tc.duration / 2, before ? before.duration / 2 : Infinity))
        const start = target.edge === 'in' ? (before ? tc.start - d / 2 : tc.start) : clipEnd(tc) - d
        return {
          rects: [{ trackId: tc.trackId, start, duration: d }],
          style: 'edge',
          snapAt: null,
          label: def.name,
          apply: () => {
            edit.setTransition(target.clipId, target.edge, payload.type)
            useUi.getState().selectTransition(target)
          }
        }
      }
      case 'videoEffect':
      case 'audioEffect': {
        const kind = payload.kind === 'videoEffect' ? 'video' : 'audio'
        if (!row || row.track.kind !== kind || row.track.locked) return null
        const clip = (byTrackRef.current.get(row.track.id) ?? []).find((c) => t >= c.start && t < clipEnd(c))
        if (!clip) return null
        return {
          rects: [{ trackId: clip.trackId, start: clip.start, duration: clip.duration }],
          style: 'target',
          snapAt: null,
          apply: () => {
            if (kind === 'video') edit.addVideoEffect(clip.id, payload.type)
            else edit.addAudioEffect(clip.id, payload.type)
            useUi.getState().select([clip.id])
          }
        }
      }
    }
    return null
  }
  const byTrackRef = useRef(byTrack)
  byTrackRef.current = byTrack

  const ghostKey = useRef('')
  const onDragOver = (e: React.DragEvent): void => {
    const payload = getDragPayload(e)
    if (!payload) return
    const plan = planDrop(payload, e)
    if (!plan) {
      e.dataTransfer.dropEffect = 'none'
      if (ghostKey.current) {
        ghostKey.current = ''
        setGhost(null)
      }
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const k = JSON.stringify([plan.rects, plan.style, plan.snapAt])
    if (k !== ghostKey.current) {
      ghostKey.current = k
      setGhost(plan)
    }
  }

  const clearGhost = (): void => {
    ghostKey.current = ''
    setGhost(null)
  }

  const onDragLeave = (e: React.DragEvent): void => {
    if (!contentRef.current?.contains(e.relatedTarget as Node | null)) clearGhost()
  }

  const onDrop = (e: React.DragEvent): void => {
    const payload = getDragPayload(e)
    endDrag()
    clearGhost()
    if (!payload) return
    e.preventDefault()
    planDrop(payload, e)?.apply()
  }

  // ------------------------------------------------------------- render ----

  const rows = layout.rows
  const empty = project.clips.length === 0

  return (
    <div className={`tl tool-${tool}`} style={{ '--tl-header-w': `${HEADER_W}px`, '--tl-ruler-h': `${RULER_H}px` } as React.CSSProperties}>
      <TimelineBar snapping={snapping} zoom={zoom} duration={duration} fps={fps} />
      <div className="tl-grid">
        <div className="tl-corner"><PlayheadTimecode fps={fps} /></div>
        <Ruler
          fps={fps}
          markers={project.markers}
          onPointerDown={onRulerPointerDown}
          onMarkerPointerDown={onMarkerPointerDown}
          onMarkerContextMenu={onMarkerContextMenu}
        />
        <div
          className="tl-headers"
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, items: [
              { label: 'Add video track', onClick: () => edit.addTrack('video') },
              { label: 'Add audio track', onClick: () => edit.addTrack('audio') }
            ] })
          }}
        >
          <div className="tl-headers-inner" ref={headersRef} style={{ height: contentH }}>
            {rows.map((r) => (
              <TrackHeader key={r.track.id} track={r.track} top={r.top} selected={r.track.id === selectedTrackId} onContextMenu={onHeaderContextMenu} />
            ))}
            <div className="tl-divider" style={{ top: layout.dividerTop }} />
          </div>
        </div>
        <div className="tl-scroll" ref={scrollRef} onScroll={onScroll}>
          <div
            className="tl-content"
            ref={contentRef}
            style={{ width: contentW, height: contentH }}
            onPointerDown={onContentPointerDown}
            onPointerMove={onContentPointerMove}
            onPointerLeave={() => setRazorT(null)}
            onContextMenu={onContentContextMenu}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            {rows.map((r) => (
              <Lane
                key={r.track.id}
                track={r.track}
                top={r.top}
                clips={byTrack.get(r.track.id) ?? EMPTY}
                media={mediaMap}
                zoom={zoom}
                fps={fps}
                selection={selection}
                selectedTransition={selectedTransition}
                trackSelected={r.track.id === selectedTrackId}
                viewL={view.l}
                viewR={view.r}
              />
            ))}
            <div className="tl-divider" style={{ top: layout.dividerTop }} />
            {ghost?.rects.map((g, i) => {
              const r = rowOf(layout, g.trackId)
              if (!r) return null
              return (
                <div key={i} className={`tl-ghost ${ghost.style}`} style={{ left: g.start * zoom, width: Math.max(4, g.duration * zoom), top: r.top + 2, height: r.height - 4 }}>
                  {ghost.label && g.duration * zoom > 50 && <span>{ghost.label}</span>}
                </div>
              )
            })}
            {marquee && (
              <div className="tl-marquee" style={{ left: marquee.x0, top: marquee.y0, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }} />
            )}
            {(snapAt ?? ghost?.snapAt ?? null) !== null && <div className="tl-snapline" style={{ left: (snapAt ?? ghost!.snapAt!) * zoom }} />}
            {tool === 'razor' && razorT !== null && <div className="tl-razorline" style={{ left: razorT * zoom }} />}
            <PlayheadLine />
          </div>
        </div>
        {empty && !ghost && (
          <div className="tl-empty-hint">Drag clips, titles and transitions here · Right-click for more</div>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {info && <div className="tl-info" style={{ left: info.x + 14, top: info.y + 18 }}>{info.text}</div>}
      {renaming && <MarkerRename {...renaming} onClose={() => setRenaming(null)} />}
    </div>
  )
}

const EMPTY: Clip[] = []

function TimelineBar(props: { snapping: boolean; zoom: number; duration: number; fps: number }): JSX.Element {
  const hasSelection = useUi((s) => s.selection.length > 0)
  return (
    <div className="tl-bar">
      <button className={`btn ghost icon small${props.snapping ? ' active' : ''}`} title="Snapping (S)" onClick={() => useUi.getState().setSnapping(!props.snapping)}>
        <Icon.magnet />
      </button>
      <button className="btn ghost icon small" title="Add marker (M)" onClick={() => edit.addMarker()}>
        <Icon.marker />
      </button>
      <button className="btn ghost icon small" title="Link / unlink selection (Ctrl+L)" disabled={!hasSelection} onClick={() => edit.toggleLink()}>
        <Icon.link />
      </button>
      <span className="tl-bar-sep" />
      <button className="btn ghost small" title="Add video track" onClick={() => edit.addTrack('video')}>+ Video</button>
      <button className="btn ghost small" title="Add audio track" onClick={() => edit.addTrack('audio')}>+ Audio</button>
      <div className="grow" />
      <span className="tl-bar-info">Duration {formatRulerTime(props.duration, props.fps)}</span>
      <span className="tl-bar-sep" />
      <button className="btn ghost icon small" title="Zoom out (-)" onClick={() => zoomBy(1 / 1.5)}><Icon.minus /></button>
      <input
        className="tl-zoom"
        type="range"
        min={Math.log(MIN_ZOOM)}
        max={Math.log(MAX_ZOOM)}
        step={0.01}
        value={Math.log(props.zoom)}
        onChange={(e) => zoomAt(Math.exp(Number(e.target.value)))}
        title="Zoom (Ctrl+wheel)"
      />
      <button className="btn ghost icon small" title="Zoom in (+)" onClick={() => zoomBy(1.5)}><Icon.plus /></button>
      <button className="btn ghost icon small" title="Zoom to fit (\)" onClick={() => zoomToFit()}><Icon.fit /></button>
    </div>
  )
}

function PlayheadTimecode(props: { fps: number }): JSX.Element {
  const time = usePlayback((s) => s.time)
  return <span className="tl-timecode">{timecode(time, props.fps)}</span>
}

function PlayheadLine(): JSX.Element {
  const time = usePlayback((s) => s.time)
  const playing = usePlayback((s) => s.playing)
  const zoom = useUi((s) => s.zoom)
  useEffect(() => {
    if (playing) revealTime(time, true)
  }, [time, playing])
  return <div className="tl-playhead" style={{ transform: `translateX(${Math.round(time * zoom)}px)` }} />
}

function MarkerRename(props: { marker: Marker; x: number; y: number; onClose(): void }): JSX.Element {
  const commit = (value: string): void => {
    const name = value.trim()
    if (name && name !== props.marker.name) edit.updateMarker(props.marker.id, 'Rename marker', { name })
    props.onClose()
  }
  return (
    <div className="tl-rename" style={{ left: props.x, top: props.y }}>
      <input
        className="input"
        autoFocus
        defaultValue={props.marker.name}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value)
          if (e.key === 'Escape') props.onClose()
        }}
      />
    </div>
  )
}

