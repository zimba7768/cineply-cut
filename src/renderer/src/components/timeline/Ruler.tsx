import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { Marker } from '@shared/types'
import { useUi } from '@/store/ui'
import { usePlayback } from '@/store/playback'
import { timecode } from '@/lib/time'
import { rulerSteps } from './layout'

export function formatRulerTime(t: number, fps: number): string {
  const tc = timecode(t, fps)
  return tc.startsWith('00:') ? tc.slice(3) : tc
}

/**
 * Time ruler: adaptive ticks drawn on a canvas sized to the viewport, the in/out range, markers and
 * the playhead handle. Pointer handling (scrubbing, marker drags) is done by the Timeline.
 */
export function Ruler(props: {
  fps: number
  markers: Marker[]
  onPointerDown(e: React.PointerEvent): void
  onMarkerPointerDown(e: React.PointerEvent, m: Marker): void
  onMarkerContextMenu(e: React.MouseEvent, m: Marker): void
}): JSX.Element {
  const zoom = useUi((s) => s.zoom)
  const scrollX = useUi((s) => s.scrollX)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = wrapRef.current!
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width === 0) return
    const h = canvas.parentElement!.clientHeight
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, h)
    const css = getComputedStyle(canvas)
    const tick = css.getPropertyValue('--text-2').trim() || '#7d818b'
    const label = css.getPropertyValue('--text-1').trim() || '#b4b7bf'
    const { major, minorPerMajor } = rulerSteps(zoom, props.fps)
    const minor = major / minorPerMajor
    const first = Math.floor(scrollX / zoom / minor)
    const last = Math.ceil((scrollX + width) / zoom / minor)
    ctx.font = '10px ' + (css.getPropertyValue('--mono').trim() || 'monospace')
    ctx.textBaseline = 'top'
    ctx.fillStyle = tick
    for (let i = first; i <= last; i++) {
      const t = i * minor
      const x = Math.round(t * zoom - scrollX) + 0.5
      const isMajor = i % minorPerMajor === 0
      const len = isMajor ? 11 : minorPerMajor >= 4 && i % (minorPerMajor / 2) === 0 ? 7 : 4
      ctx.fillRect(x - 0.5, h - len, 1, len)
      if (isMajor && t >= 0) {
        ctx.fillStyle = label
        ctx.fillText(formatRulerTime(t, props.fps), x + 4, 4)
        ctx.fillStyle = tick
      }
    }
  }, [zoom, scrollX, width, props.fps])

  return (
    <div className="tl-ruler" ref={wrapRef} onPointerDown={props.onPointerDown}>
      <canvas ref={canvasRef} />
      <InOutRange zoom={zoom} scrollX={scrollX} />
      {props.markers.map((m) => {
        const x = m.time * zoom - scrollX
        if (x < -20 || x > width + 20) return null
        return (
          <div
            key={m.id}
            className="tl-marker"
            style={{ left: x, color: m.color }}
            title={`${m.name} — ${formatRulerTime(m.time, props.fps)}`}
            onPointerDown={(e) => {
              e.stopPropagation()
              props.onMarkerPointerDown(e, m)
            }}
            onContextMenu={(e) => props.onMarkerContextMenu(e, m)}
          />
        )
      })}
      <RulerPlayhead zoom={zoom} scrollX={scrollX} />
    </div>
  )
}

function InOutRange(props: { zoom: number; scrollX: number }): JSX.Element | null {
  const inPoint = usePlayback((s) => s.inPoint)
  const outPoint = usePlayback((s) => s.outPoint)
  if (inPoint === null && outPoint === null) return null
  const a = (inPoint ?? 0) * props.zoom - props.scrollX
  const b = outPoint !== null ? outPoint * props.zoom - props.scrollX : null
  return (
    <div
      className={`tl-inout${inPoint !== null ? ' has-in' : ''}${outPoint !== null ? ' has-out' : ''}`}
      style={{ left: a, width: b === null ? undefined : Math.max(1, b - a), right: b === null ? 0 : undefined }}
    />
  )
}

function RulerPlayhead(props: { zoom: number; scrollX: number }): JSX.Element {
  const time = usePlayback((s) => s.time)
  return <div className="tl-ph-head" style={{ left: time * props.zoom - props.scrollX }} />
}
