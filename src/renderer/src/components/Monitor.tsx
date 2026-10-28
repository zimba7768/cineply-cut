import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { clipEnd, type Clip, type Project } from '@shared/types'
import { findMedia, findTrack, getProject, sequenceDuration, useProject } from '@/store/project'
import { usePlayback } from '@/store/playback'
import { useUi } from '@/store/ui'
import { preview } from '@/engine/playback'
import { captureFrame } from '@/engine/capture'
import { fitFactors } from '@/engine/compositor'
import { snapToFrame, timecode } from '@/lib/time'
import { updateClip } from '@/lib/editing'
import { valueAt } from '@/lib/keyframes'
import { animatedValue, setAnimatedProp } from './inspector/VideoInspector'
import './Monitor.css'

type Quality = 1 | 0.5 | 0.25

/** Parses typed timecode: HH:MM:SS:FF (fewer fields allowed), seconds with a '.', bare digits as packed timecode, or ±frames. */
function parseTimecode(text: string, fps: number, current: number): number | null {
  const s = text.trim()
  if (!s) return null
  const rate = Math.round(fps)
  if (/^[+-]\d+$/.test(s)) return Math.max(0, current + Number(s) / fps)
  if (/^\d+\.\d*$/.test(s)) return Number(s)
  let parts: number[]
  if (/^\d+$/.test(s)) {
    const d = s.padStart(8, '0').slice(-8)
    parts = [0, 2, 4, 6].map((i) => Number(d.slice(i, i + 2)))
  } else {
    if (!/^\d+([:;.]\d+){1,3}$/.test(s)) return null
    parts = s.split(/[:;.]/).map(Number)
    while (parts.length < 4) parts.unshift(0)
  }
  const [h, m, sec, f] = parts
  return h * 3600 + m * 60 + sec + f / rate
}

function goTo(t: number): void {
  const pb = usePlayback.getState()
  if (pb.playing) pb.setPlaying(false)
  pb.setTime(Math.max(0, t))
}

function stepFrames(n: number): void {
  const { fps } = getProject().sequence
  const t = usePlayback.getState().time
  goTo(snapToFrame(t, fps) + n / fps)
}

async function exportFrame(): Promise<void> {
  const project = getProject()
  const t = usePlayback.getState().time
  const ui = useUi.getState()
  const name = `${project.name || 'frame'} ${timecode(t, project.sequence.fps).replace(/:/g, '-')}.png`
  const path = await window.cineply.dialog.saveFile(name, [{ name: 'PNG image', extensions: ['png'] }])
  if (!path) return
  try {
    const blob = await captureFrame(t)
    if (!blob) throw new Error('Nothing to capture')
    await window.cineply.fs.writeBinary(path, new Uint8Array(await blob.arrayBuffer()))
    ui.showToast(`Saved ${window.cineply.paths.basename(path)}`)
  } catch (err) {
    ui.showToast(`Export frame failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

// --------------------------------------------------------- direct edit ----

/** Corners (sequence px) of a clip's visible rectangle at time t, or null if unknown. */
function clipCorners(project: Project, clip: Clip, t: number): [number, number][] | null {
  const { width: seqW, height: seqH } = project.sequence
  const v = clip.video
  const local = t - clip.start
  let w = seqW
  let h = seqH
  if (clip.type === 'media') {
    const m = findMedia(project, clip.mediaId)
    if (!m?.width || !m.height) return null
    w = m.width
    h = m.height
  }
  const [fx, fy] = fitFactors(v.fit, w, h, seqW, seqH)
  const s = animatedValue(clip, 'scale', local)
  const dw = w * fx * s
  const dh = h * fy * s
  let x0 = -dw / 2 + v.crop.left * dw
  let x1 = dw / 2 - v.crop.right * dw
  let y0 = -dh / 2 + v.crop.top * dh
  let y1 = dh / 2 - v.crop.bottom * dh
  if (v.flipH) [x0, x1] = [-x1, -x0]
  if (v.flipV) [y0, y1] = [-y1, -y0]
  const r = (animatedValue(clip, 'rotation', local) * Math.PI) / 180
  const cx = seqW / 2 + animatedValue(clip, 'x', local)
  const cy = seqH / 2 + animatedValue(clip, 'y', local)
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][]).map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos])
}

/** The single selected video-track clip under the playhead, if any. */
function useEditableClip(): Clip | null {
  const id = useUi((s) => (s.selection.length === 1 ? s.selection[0] : null))
  // null while playing, so playback doesn't re-render the monitor every frame.
  const time = usePlayback((s) => (s.playing ? null : s.time))
  return useProject((s) => {
    if (!id || time === null) return null
    const c = s.project.clips.find((x) => x.id === id)
    if (!c || findTrack(s.project, c.trackId)?.kind !== 'video') return null
    return time >= c.start && time < clipEnd(c) ? c : null
  })
}

function SelectionOverlay(props: { clip: Clip; displayW: number }): JSX.Element | null {
  const { clip, displayW } = props
  const project = useProject((s) => s.project)
  const time = usePlayback((s) => s.time)
  const corners = clipCorners(project, clip, time)
  const drag = useRef<{ x: number; y: number; startX: number; startY: number; key: string } | null>(null)
  if (!corners) return null
  const { width: seqW, height: seqH } = project.sequence
  const toSeq = seqW / displayW

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const local = time - clip.start
    drag.current = {
      x: e.clientX, y: e.clientY,
      startX: animatedValue(clip, 'x', local), startY: animatedValue(clip, 'y', local),
      key: `monitor-move:${clip.id}:${performance.now()}`
    }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const local = Math.min(Math.max(0, usePlayback.getState().time - clip.start), clip.duration)
    let nx = d.startX + (e.clientX - d.x) * toSeq
    let ny = d.startY + (e.clientY - d.y) * toSeq
    if (e.shiftKey) {
      if (Math.abs(nx - d.startX) > Math.abs(ny - d.startY)) ny = d.startY
      else nx = d.startX
    }
    updateClip(clip.id, 'Move clip', (c) => {
      setAnimatedProp(c, 'x', Math.round(nx), local)
      setAnimatedProp(c, 'y', Math.round(ny), local)
    }, d.key)
  }
  const onPointerUp = (): void => {
    drag.current = null
  }

  return (
    <svg className="monitor-overlay" viewBox={`0 0 ${seqW} ${seqH}`} preserveAspectRatio="none">
      <polygon
        className="monitor-bounds"
        points={corners.map((p) => p.join(',')).join(' ')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {corners.map(([x, y], i) => (
        <rect key={i} className="monitor-handle" x={x - 5 * toSeq} y={y - 5 * toSeq} width={10 * toSeq} height={10 * toSeq} />
      ))}
    </svg>
  )
}

function SafeMargins(): JSX.Element {
  return (
    <svg className="monitor-overlay safe" viewBox="0 0 100 100" preserveAspectRatio="none">
      <rect x="5" y="5" width="90" height="90" />
      <rect x="10" y="10" width="80" height="80" />
      <line x1="48" y1="50" x2="52" y2="50" />
      <line x1="50" y1="48" x2="50" y2="52" />
    </svg>
  )
}

// ------------------------------------------------------------ transport ---

function TimecodeField(): JSX.Element {
  const time = usePlayback((s) => s.time)
  const fps = useProject((s) => s.project.sequence.fps)
  const [editing, setEditing] = useState<string | null>(null)
  const commit = (): void => {
    if (editing !== null) {
      const t = parseTimecode(editing, fps, time)
      if (t !== null) goTo(t)
    }
    setEditing(null)
  }
  if (editing !== null) {
    return (
      <input
        className="input monitor-tc editing"
        autoFocus
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') setEditing(null)
        }}
      />
    )
  }
  return (
    <button className="monitor-tc" title="Click to type a time" onClick={() => setEditing(timecode(time, fps))}>
      {timecode(time, fps)}
    </button>
  )
}

function DurationLabel(): JSX.Element {
  const text = useProject((s) => timecode(sequenceDuration(s.project), s.project.sequence.fps))
  return <span className="monitor-tc total" title="Sequence duration">{text}</span>
}

// Program monitor: composited preview + transport controls.
export function Monitor(): JSX.Element {
  const seqW = useProject((s) => s.project.sequence.width)
  const seqH = useProject((s) => s.project.sequence.height)
  const playing = usePlayback((s) => s.playing)
  const loop = usePlayback((s) => s.loop)
  const [quality, setQuality] = useState<Quality>(0.5)
  const [safe, setSafe] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const editable = useEditableClip()
  const wheelKey = useRef({ key: '', at: 0 })

  useEffect(() => {
    preview.attachCanvas(canvasRef.current)
    return () => preview.attachCanvas(null)
  }, [])

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const fit = (): void => {
      const pad = 16
      const aw = Math.max(0, el.clientWidth - pad)
      const ah = Math.max(0, el.clientHeight - pad)
      const aspect = seqW / seqH
      const w = Math.min(aw, ah * aspect)
      setBox({ w: Math.floor(w), h: Math.floor(w / aspect) })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [seqW, seqH])

  useEffect(() => preview.invalidate(), [quality, seqW, seqH])

  const onWheel = (e: React.WheelEvent): void => {
    if (!editable || e.deltaY === 0) return
    const now = performance.now()
    if (wheelKey.current.key === '' || now - wheelKey.current.at > 600) wheelKey.current.key = `monitor-scale:${editable.id}:${now}`
    wheelKey.current.at = now
    const local = Math.min(Math.max(0, usePlayback.getState().time - editable.start), editable.duration)
    const current = valueAt(editable.video.keyframes.scale, local, editable.video.scale)
    const next = Math.min(10, Math.max(0.01, current * Math.exp(-e.deltaY * (e.shiftKey ? 0.0002 : 0.001))))
    updateClip(editable.id, 'Scale clip', (c) => setAnimatedProp(c, 'scale', Math.round(next * 1000) / 1000, local), wheelKey.current.key)
  }

  const onExportFrame = async (): Promise<void> => {
    setExporting(true)
    try {
      await exportFrame()
    } finally {
      setExporting(false)
    }
  }

  const duration = (): number => sequenceDuration(getProject())

  return (
    <div className="monitor">
      <div className="monitor-stage" ref={stageRef} onWheel={onWheel}>
        <div className="monitor-frame" style={{ width: box.w, height: box.h }}>
          <canvas
            ref={canvasRef}
            className="monitor-canvas"
            width={Math.max(1, Math.round(seqW * quality))}
            height={Math.max(1, Math.round(seqH * quality))}
          />
          {safe && <SafeMargins />}
          {editable && box.w > 0 && <SelectionOverlay clip={editable} displayW={box.w} />}
        </div>
      </div>

      <div className="monitor-bar">
        <div className="monitor-bar-side">
          <TimecodeField />
        </div>
        <div className="monitor-transport">
          <button className="btn ghost icon" title="Go to start (Home)" onClick={() => goTo(0)}>⏮</button>
          <button className="btn ghost icon" title="Previous frame (←)" onClick={() => stepFrames(-1)}>◂◂</button>
          <button className="btn icon monitor-play" title="Play / pause (Space)" onClick={() => preview.togglePlay()}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button className="btn ghost icon" title="Next frame (→)" onClick={() => stepFrames(1)}>▸▸</button>
          <button className="btn ghost icon" title="Go to end (End)" onClick={() => goTo(duration())}>⏭</button>
          <button className={`btn ghost icon${loop ? ' active' : ''}`} title="Loop playback (in/out range)" onClick={() => usePlayback.getState().setLoop(!loop)}>
            ⟲
          </button>
        </div>
        <div className="monitor-bar-side right">
          <button className={`btn ghost icon small${safe ? ' active' : ''}`} title="Safe margins" onClick={() => setSafe(!safe)}>⊡</button>
          <button className="btn ghost icon small" title="Export frame as PNG" disabled={exporting} onClick={() => void onExportFrame()}>
            📷
          </button>
          <select className="select monitor-quality" value={quality} title="Preview quality" onChange={(e) => setQuality(Number(e.target.value) as Quality)}>
            <option value={1}>Full</option>
            <option value={0.5}>½</option>
            <option value={0.25}>¼</option>
          </select>
          <DurationLabel />
        </div>
      </div>
    </div>
  )
}
