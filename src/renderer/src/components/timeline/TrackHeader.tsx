import { memo, useState, type JSX } from 'react'
import type { Track } from '@shared/types'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { addAudioEffect, renameTrack, updateTrack } from '@/lib/editing'
import { endDrag, getDragPayload } from '@/lib/dnd'
import { Icon } from './icons'
import { MAX_TRACK_H, MIN_TRACK_H } from './layout'

/** Track header: name (double-click to rename), hide/mute, solo, lock, and a drag handle to resize. */
export const TrackHeader = memo(function TrackHeader(props: {
  track: Track
  top: number
  selected: boolean
  onContextMenu(e: React.MouseEvent, track: Track): void
}): JSX.Element {
  const { track } = props
  const [editing, setEditing] = useState(false)
  const [dropping, setDropping] = useState(false)
  const video = track.kind === 'video'

  const toggle = (key: 'muted' | 'solo' | 'locked', label: string): void =>
    updateTrack(track.id, label, (t) => {
      t[key] = !t[key]
    })

  const onResizeDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const y0 = e.clientY
    const h0 = track.height
    const onMove = (ev: PointerEvent): void => {
      const h = Math.round(Math.min(MAX_TRACK_H, Math.max(MIN_TRACK_H, h0 + ev.clientY - y0)))
      useProject.getState().mutateSilently((p) => {
        const t = p.tracks.find((x) => x.id === track.id)
        if (t) t.height = h
      })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (useProject.getState().project.tracks.find((t) => t.id === track.id)?.height !== h0) useProject.setState({ dirty: true })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const acceptsDrop = (e: React.DragEvent): boolean => {
    const payload = getDragPayload(e)
    return !video && payload?.kind === 'audioEffect'
  }

  return (
    <div
      className={`tl-header ${track.kind}${props.selected ? ' selected' : ''}${track.locked ? ' locked' : ''}${dropping ? ' drop' : ''}`}
      style={{ top: props.top, height: track.height }}
      onPointerDown={() => useUi.setState({ selectedTrackId: track.id })}
      onContextMenu={(e) => props.onContextMenu(e, track)}
      onDragOver={(e) => {
        if (!acceptsDrop(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false)
        const payload = getDragPayload(e)
        endDrag()
        if (video || payload?.kind !== 'audioEffect') return
        e.preventDefault()
        addAudioEffect(track.id, payload.type, 'track')
        useUi.getState().showToast(`Added to track ${track.name}`)
      }}
    >
      <div className="tl-header-main">
        {editing ? (
          <input
            className="input tl-header-input"
            autoFocus
            defaultValue={track.name}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              renameTrack(track.id, e.currentTarget.value)
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <span className="tl-header-name" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {track.name}
          </span>
        )}
        <div className="tl-header-btns">
          {video ? (
            <button className={`tl-tbtn${track.muted ? ' off' : ''}`} title={track.muted ? 'Show track' : 'Hide track'} onClick={() => toggle('muted', track.muted ? 'Show track' : 'Hide track')}>
              {track.muted ? <Icon.eyeOff /> : <Icon.eye />}
            </button>
          ) : (
            <>
              <button className={`tl-tbtn${track.muted ? ' on mute' : ''}`} title="Mute track" onClick={() => toggle('muted', track.muted ? 'Unmute track' : 'Mute track')}>M</button>
              <button className={`tl-tbtn${track.solo ? ' on solo' : ''}`} title="Solo track" onClick={() => toggle('solo', track.solo ? 'Unsolo track' : 'Solo track')}>S</button>
            </>
          )}
          <button className={`tl-tbtn${track.locked ? ' on lock' : ''}`} title={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => toggle('locked', track.locked ? 'Unlock track' : 'Lock track')}>
            {track.locked ? <Icon.lock /> : <Icon.unlock />}
          </button>
        </div>
      </div>
      {!video && track.effects.length > 0 && track.height >= 48 && (
        <div className="tl-header-sub">fx × {track.effects.length}</div>
      )}
      <div className="tl-header-resize" onPointerDown={onResizeDown} title="Drag to resize" />
    </div>
  )
})
