import { memo, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { Clip, Id, MediaItem, Track } from '@shared/types'
import { clipEnd } from '@shared/types'
import { drawWaveform, onPeaksReady } from '@/audio/waveform'
import { getTransition } from '@/engine/transitions'
import { valueAt } from '@/lib/keyframes'
import { CLIP_HEAD_H } from './layout'
import { thumbQuantum, useThumb } from './thumbs'

const THUMB_W = 160

/** One track lane: its clips (culled to the visible range) and the transition blocks on their edges. */
export const Lane = memo(function Lane(props: {
  track: Track
  top: number
  clips: Clip[]
  media: Map<Id, MediaItem>
  zoom: number
  fps: number
  selection: string[]
  selectedTransition: { clipId: string; edge: 'in' | 'out' } | null
  trackSelected: boolean
  viewL: number
  viewR: number
}): JSX.Element {
  const { track, clips, zoom, viewL, viewR } = props
  const half = 0.5 / props.fps
  const visible = clips.filter((c) => clipEnd(c) * zoom >= viewL && c.start * zoom <= viewR)
  const transitions: JSX.Element[] = []
  clips.forEach((c, i) => {
    const prev = i > 0 && Math.abs(clipEnd(clips[i - 1]) - c.start) < half ? clips[i - 1] : undefined
    const next = i < clips.length - 1 && Math.abs(clips[i + 1].start - clipEnd(c)) < half ? clips[i + 1] : undefined
    const sel = props.selectedTransition
    if (c.transitionIn) {
      const d = c.transitionIn.duration
      const start = prev ? c.start - d / 2 : c.start
      transitions.push(
        <TransitionBlock key={`${c.id}-in`} clipId={c.id} edge="in" type={c.transitionIn.type} left={start * zoom} width={d * zoom}
          selected={sel?.clipId === c.id && sel.edge === 'in'} />
      )
    }
    if (c.transitionOut && !next) {
      const d = c.transitionOut.duration
      transitions.push(
        <TransitionBlock key={`${c.id}-out`} clipId={c.id} edge="out" type={c.transitionOut.type} left={(clipEnd(c) - d) * zoom} width={d * zoom}
          selected={sel?.clipId === c.id && sel.edge === 'out'} />
      )
    }
  })
  return (
    <div
      className={`tl-lane ${track.kind}${track.locked ? ' locked' : ''}${props.trackSelected ? ' selected' : ''}`}
      style={{ top: props.top, height: track.height }}
      data-track={track.id}
    >
      {visible.map((c) => (
        <ClipView
          key={c.id}
          clip={c}
          media={c.mediaId ? props.media.get(c.mediaId) : undefined}
          audio={track.kind === 'audio'}
          height={track.height}
          zoom={zoom}
          selected={props.selection.includes(c.id)}
          dim={track.muted}
          viewL={viewL}
          viewR={viewR}
        />
      ))}
      {transitions}
    </div>
  )
})

function TransitionBlock(props: { clipId: Id; edge: 'in' | 'out'; type: string; left: number; width: number; selected: boolean }): JSX.Element {
  const name = getTransition(props.type).name
  return (
    <div
      className={`tl-trans${props.selected ? ' selected' : ''}`}
      data-transition={`${props.clipId}:${props.edge}`}
      style={{ left: props.left, width: Math.max(6, props.width) }}
      title={name}
    >
      {props.width > 40 && <span>{name}</span>}
    </div>
  )
}

const ClipView = memo(function ClipView(props: {
  clip: Clip
  media?: MediaItem
  audio: boolean
  height: number
  zoom: number
  selected: boolean
  dim: boolean
  viewL: number
  viewR: number
}): JSX.Element {
  const { clip, media, zoom, height } = props
  const left = clip.start * zoom
  const width = Math.max(2, clip.duration * zoom)
  const visL = Math.max(0, props.viewL - left)
  const visR = Math.min(width, props.viewR - left)
  const bodyH = Math.max(0, height - 4 - CLIP_HEAD_H)
  const kind = props.audio ? 'audio' : clip.type === 'media' ? 'video' : clip.type
  const missing = clip.type === 'media' && (!media || media.status === 'error')
  const fx = props.audio ? clip.audio.effects.length : clip.video.effects.length
  const cls = ['tl-clip', kind, props.selected && 'selected', props.dim && 'dim', missing && 'missing'].filter(Boolean).join(' ')
  const style: React.CSSProperties = { left, width, height: height - 4 }
  if (clip.type === 'color' && !props.audio) style.background = clip.color ?? '#000'

  return (
    <div className={cls} style={style} data-clip={clip.id}>
      <div className="tl-clip-head">
        <span className="tl-clip-name">
          {clip.linkId && <span className="tl-linkdot" title="Linked" />}
          {clip.name}
        </span>
        {clip.speed !== 1 && <span className="tl-badge">{Math.round(clip.speed * 100)}%</span>}
        {fx > 0 && <span className="tl-badge fx" title={`${fx} effect${fx > 1 ? 's' : ''}`}>fx</span>}
      </div>
      {bodyH > 4 && visR > visL && (
        <div className="tl-clip-body" style={{ height: bodyH }}>
          {!props.audio && clip.type === 'media' && media && media.kind !== 'audio' && (
            <Filmstrip clip={clip} media={media} zoom={zoom} height={bodyH} visL={visL} visR={visR} />
          )}
          {!props.audio && clip.type === 'title' && (
            <div className="tl-title-preview">T&nbsp; {clip.title?.texts[0]?.text ?? ''}</div>
          )}
          {props.audio && clip.type === 'media' && media && (
            <>
              <Waveform clip={clip} mediaId={media.id} zoom={zoom} height={bodyH} visL={visL} visR={visR} />
              <AudioOverlay clip={clip} zoom={zoom} height={bodyH} visL={visL} visR={visR} />
            </>
          )}
          {media?.status === 'transcoding' && <div className="tl-clip-status">Preparing…</div>}
          {missing && <div className="tl-clip-status">Media offline</div>}
        </div>
      )}
      <div className="tl-edge in" data-edge="in" />
      <div className="tl-edge out" data-edge="out" />
    </div>
  )
})

function Filmstrip(props: { clip: Clip; media: MediaItem; zoom: number; height: number; visL: number; visR: number }): JSX.Element {
  const { clip, media, zoom, height } = props
  const aspect = media.width && media.height ? media.width / media.height : 16 / 9
  const tileW = Math.max(24, Math.round(height * aspect))
  if (media.kind === 'image') {
    return (
      <div
        className="tl-film-image"
        style={{ backgroundImage: `url("${window.cineply.mediaUrl(media.path)}")`, backgroundSize: `${tileW}px 100%` }}
      />
    )
  }
  const q = thumbQuantum((tileW / zoom) * clip.speed)
  const first = Math.floor(props.visL / tileW)
  const last = Math.ceil(props.visR / tileW)
  const tiles: JSX.Element[] = []
  for (let i = first; i < last; i++) {
    const x = i * tileW
    const src = clip.in + (x / zoom) * clip.speed
    const t = Math.max(0, Math.min(Math.floor(src / q) * q, media.duration - 0.05))
    tiles.push(<Thumb key={i} path={media.path} t={t} left={x} width={tileW} />)
  }
  return <>{tiles}</>
}

function Thumb(props: { path: string; t: number; left: number; width: number }): JSX.Element {
  const url = useThumb(props.path, props.t, THUMB_W)
  return (
    <div className="tl-thumb" style={{ left: props.left, width: props.width }}>
      {url && <img src={url} alt="" draggable={false} />}
    </div>
  )
}

function Waveform(props: { clip: Clip; mediaId: Id; zoom: number; height: number; visL: number; visR: number }): JSX.Element {
  const { clip, zoom, height, visL, visR } = props
  const ref = useRef<HTMLCanvasElement>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => onPeaksReady(() => setVersion((v) => v + 1)), [])
  const width = Math.max(1, Math.ceil(visR - visL))
  useLayoutEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const srcStart = clip.in + (visL / zoom) * clip.speed
    const srcEnd = clip.in + (visR / zoom) * clip.speed
    drawWaveform(ctx, props.mediaId, srcStart, srcEnd, 0, 0, width, height, 'rgba(214, 255, 233, 0.78)', clip.audio.mute ? 0 : clip.audio.gain)
  }, [props.mediaId, clip.in, clip.speed, clip.audio.gain, clip.audio.mute, zoom, visL, visR, width, height, version])
  return <canvas ref={ref} className="tl-wave" style={{ left: visL, width, height }} />
}

/** Fade ramps and the (read-only) volume line, drawn for the visible part of an audio clip. */
function AudioOverlay(props: { clip: Clip; zoom: number; height: number; visL: number; visR: number }): JSX.Element {
  const { clip, zoom, height: h, visL, visR } = props
  const w = Math.max(1, visR - visL)
  const xOf = (t: number): number => t * zoom - visL
  const yOf = (v: number): number => h - Math.min(1, Math.max(0, v / 2)) * (h - 4) - 2
  const kfs = clip.audio.volumeKeyframes
  const gain = clip.audio.gain
  let line: string
  if (kfs.length === 0) {
    line = `0,${yOf(gain)} ${w},${yOf(gain)}`
  } else {
    const pts: string[] = []
    for (let x = 0; x <= w; x += 3) pts.push(`${x},${yOf(gain * valueAt(kfs, (x + visL) / zoom, 1))}`)
    pts.push(`${w},${yOf(gain * valueAt(kfs, visR / zoom, 1))}`)
    line = pts.join(' ')
  }
  const fi = clip.audio.fadeIn * zoom
  const fo = clip.audio.fadeOut * zoom
  const end = clip.duration * zoom
  return (
    <svg className="tl-audio-overlay" style={{ left: visL }} width={w} height={h}>
      {fi > 0 && (
        <>
          <polygon points={`${xOf(0)},0 ${xOf(0) + fi},0 ${xOf(0)},${h}`} className="tl-fade" />
          <line x1={xOf(0)} y1={h} x2={xOf(0) + fi} y2={0} className="tl-fade-line" />
        </>
      )}
      {fo > 0 && (
        <>
          <polygon points={`${end - visL - fo},0 ${end - visL},0 ${end - visL},${h}`} className="tl-fade" />
          <line x1={end - visL - fo} y1={0} x2={end - visL} y2={h} className="tl-fade-line" />
        </>
      )}
      <polyline points={line} className="tl-volume" />
      {kfs.map((k, i) => {
        const x = xOf(k.t)
        return x >= -4 && x <= w + 4 ? <circle key={i} cx={x} cy={yOf(gain * k.v)} r={2.5} className="tl-volume-kf" /> : null
      })}
    </svg>
  )
}
