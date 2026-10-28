import { useState, type JSX } from 'react'
import { clipEnd, type Clip } from '@shared/types'
import { findMedia, findTrack, sequenceDuration, useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { timecode } from '@/lib/time'
import { Row, Section } from '../ui/controls'
import { VideoInspector } from './VideoInspector'
import { EffectsInspector } from './EffectsInspector'
import { TitleInspector } from './TitleInspector'
import { AudioInspector } from './AudioInspector'
import { TransitionInspector } from './TransitionInspector'
import './Inspector.css'

type TabId = 'video' | 'effects' | 'title' | 'audio' | 'info'

const TAB_LABELS: Record<TabId, string> = { video: 'Video', effects: 'Effects', title: 'Title', audio: 'Audio', info: 'Clip' }

function SequenceInfo(): JSX.Element {
  const project = useProject((s) => s.project)
  const openModal = useUi((s) => s.openModal)
  const { sequence: seq } = project
  const duration = sequenceDuration(project)
  return (
    <div className="inspector-scroll">
      <Section title="Sequence">
        <Row label="Name"><span className="inspector-value">{project.name}</span></Row>
        <Row label="Frame size"><span className="inspector-value">{seq.width} × {seq.height}</span></Row>
        <Row label="Frame rate"><span className="inspector-value">{seq.fps} fps</span></Row>
        <Row label="Audio"><span className="inspector-value">{seq.sampleRate / 1000} kHz</span></Row>
        <Row label="Duration"><span className="inspector-value mono">{timecode(duration, seq.fps)}</span></Row>
        <Row label="Contents">
          <span className="inspector-value">
            {project.clips.length} clip{project.clips.length === 1 ? '' : 's'} · {project.media.length} media · {project.markers.length} marker{project.markers.length === 1 ? '' : 's'}
          </span>
        </Row>
        <button className="btn small" onClick={() => openModal('sequence')}>Sequence settings…</button>
      </Section>
      <div className="empty">Select a clip or transition on the timeline to edit it.</div>
    </div>
  )
}

function ClipInfo(props: { clip: Clip }): JSX.Element {
  const { clip } = props
  const project = useProject((s) => s.project)
  const fps = project.sequence.fps
  const media = findMedia(project, clip.mediaId)
  const track = findTrack(project, clip.trackId)
  const kind = clip.type === 'title' ? 'Title' : clip.type === 'color' ? 'Color matte' : media?.kind === 'image' ? 'Still image' : media?.kind === 'audio' ? 'Audio' : 'Video'
  return (
    <Section title="Clip">
      <Row label="Name"><span className="inspector-value">{clip.name}</span></Row>
      <Row label="Type"><span className="inspector-value">{kind}{track ? ` on ${track.name}` : ''}</span></Row>
      <Row label="Start"><span className="inspector-value mono">{timecode(clip.start, fps)}</span></Row>
      <Row label="End"><span className="inspector-value mono">{timecode(clipEnd(clip), fps)}</span></Row>
      <Row label="Duration"><span className="inspector-value mono">{timecode(clip.duration, fps)}</span></Row>
      {clip.type === 'media' && <Row label="Source in"><span className="inspector-value mono">{timecode(clip.in, fps)}</span></Row>}
      {clip.type === 'media' && <Row label="Speed"><span className="inspector-value">{Math.round(clip.speed * 100)}%</span></Row>}
      {media && (
        <>
          <Row label="Source" title={media.path}>
            <span className="inspector-value path" title={media.path}>{media.path}</span>
          </Row>
          {media.width && media.height && (
            <Row label="Resolution">
              <span className="inspector-value">{media.width} × {media.height}{media.fps ? ` · ${Math.round(media.fps * 100) / 100} fps` : ''}</span>
            </Row>
          )}
          <Row label="Codecs"><span className="inspector-value">{[media.videoCodec, media.audioCodec].filter(Boolean).join(' / ') || '—'}</span></Row>
          {media.playbackPath && <Row label="Proxy" title={media.playbackPath}><span className="inspector-value path">{media.playbackPath}</span></Row>}
          {media.ai && <Row label="AI prompt"><span className="inspector-value wrap">{media.ai.prompt}</span></Row>}
          <button className="btn small" onClick={() => void window.cineply.shell.showItemInFolder(media.path)}>Reveal in Explorer</button>
        </>
      )}
      {clip.type === 'color' && <Row label="Color"><span className="inspector-value">{clip.color}</span></Row>}
    </Section>
  )
}

function ClipInspector(props: { clip: Clip; count: number; preferred: TabId; onTab(t: TabId): void }): JSX.Element {
  const { clip, preferred } = props
  const trackKind = useProject((s) => findTrack(s.project, clip.trackId)?.kind ?? 'video')
  const tabs: TabId[] =
    trackKind === 'audio'
      ? ['audio', 'info']
      : clip.type === 'title'
        ? ['title', 'video', 'effects', 'info']
        : ['video', 'effects', 'info']
  const tab = tabs.includes(preferred) ? preferred : tabs[0]
  return (
    <>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => props.onTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="inspector-scroll">
        <div className="inspector-title">
          <span className={`inspector-swatch ${clip.type === 'title' ? 'title' : trackKind}`} />
          <span className="inspector-name">{clip.name}</span>
          {props.count > 1 && <span className="muted">+{props.count - 1} more selected</span>}
        </div>
        {tab === 'video' && <VideoInspector clip={clip} />}
        {tab === 'effects' && <EffectsInspector clip={clip} />}
        {tab === 'title' && <TitleInspector clip={clip} />}
        {tab === 'audio' && <AudioInspector clip={clip} />}
        {tab === 'info' && <ClipInfo clip={clip} />}
      </div>
    </>
  )
}

// Right-hand inspector for the selected clip / transition.
export function Inspector(): JSX.Element {
  const selection = useUi((s) => s.selection)
  const selectedTransition = useUi((s) => s.selectedTransition)
  const clip = useProject((s) => {
    const id = selection[selection.length - 1]
    return id ? s.project.clips.find((c) => c.id === id) : undefined
  })
  const transitionExists = useProject((s) =>
    selectedTransition ? !!s.project.clips.find((c) => c.id === selectedTransition.clipId)?.[selectedTransition.edge === 'in' ? 'transitionIn' : 'transitionOut'] : false
  )
  // The chosen tab is kept across selections (falls back to the first tab a clip offers).
  const [preferred, setPreferred] = useState<TabId>('video')

  if (selectedTransition && transitionExists) {
    return (
      <div className="inspector">
        <div className="inspector-scroll">
          <TransitionInspector clipId={selectedTransition.clipId} edge={selectedTransition.edge} />
        </div>
      </div>
    )
  }
  return (
    <div className="inspector">
      {clip ? <ClipInspector clip={clip} count={selection.length} preferred={preferred} onTab={setPreferred} /> : <SequenceInfo />}
    </div>
  )
}
