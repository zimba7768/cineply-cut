import { useEffect, useState, type JSX } from 'react'
import type { Track } from '@shared/types'
import { Row, Section, Toggle } from '@/components/ui/controls'
import { audioEngine, trackMeter } from '@/audio/engine'
import { setMasterGain, setTrackGain, setTrackPan, toggleTrackFlag } from '@/audio/mixer'
import { EffectRack, Fader, PanControl, PeakMeter, formatDb } from '@/audio/ui'
import {
  closeInput, inputLevel, openInput, refreshDevices, startVoiceover, stopVoiceover, useVoiceover
} from '@/audio/voiceover'
import { addTrack } from '@/lib/editing'
import { shortTime, timecode } from '@/lib/time'
import { audioTracks, useProject } from '@/store/project'
import './AudioPanel.css'

// Audio track mixer, meters, voiceover recording.
export function AudioPanel(): JSX.Element {
  const project = useProject((s) => s.project)
  const tracks = audioTracks(project)
  const [fxTrackId, setFxTrackId] = useState<string | null>(null)
  const fxTrack = tracks.find((t) => t.id === fxTrackId) ?? null

  return (
    <div className="audio-panel">
      <Section
        title="Mixer"
        right={<button className="btn ghost small" title="Add audio track" onClick={() => addTrack('audio')}>+ Track</button>}
      >
        <div className="mixer">
          <div className="mixer-strips">
            {tracks.map((t) => (
              <ChannelStrip key={t.id} track={t} fxOpen={fxTrackId === t.id} onFx={() => setFxTrackId(fxTrackId === t.id ? null : t.id)} />
            ))}
            {tracks.length === 0 && <div className="empty">No audio tracks</div>}
          </div>
          <div className="strip master">
            <div className="strip-name">Master</div>
            <div className="strip-pan-spacer" />
            <div className="strip-body">
              <Fader gain={project.masterGain} onChange={setMasterGain} />
              <PeakMeter read={() => audioEngine.meter()} />
            </div>
            <div className="strip-db">{formatDb(project.masterGain)} dB</div>
          </div>
        </div>
      </Section>

      {fxTrack && (
        <Section title={`${fxTrack.name} effects`} right={<button className="btn ghost small" onClick={() => setFxTrackId(null)}>Close</button>}>
          <EffectRack target={{ kind: 'track', id: fxTrack.id }} effects={fxTrack.effects ?? []} />
        </Section>
      )}

      <VoiceoverSection tracks={tracks} />
    </div>
  )
}

function ChannelStrip(props: { track: Track; fxOpen: boolean; onFx(): void }): JSX.Element {
  const t = props.track
  const fxCount = (t.effects ?? []).filter((e) => e.enabled).length
  return (
    <div className={`strip${t.muted ? ' is-muted' : ''}`}>
      <div className="strip-name" title={t.name}>{t.name}</div>
      <PanControl pan={t.pan} onChange={(v) => setTrackPan(t.id, v)} />
      <div className="strip-body">
        <Fader gain={t.gain} onChange={(g) => setTrackGain(t.id, g)} />
        <PeakMeter read={() => trackMeter(t.id)} />
      </div>
      <div className="strip-db">{formatDb(t.gain)} dB</div>
      <div className="strip-buttons">
        <button className={`btn small strip-m${t.muted ? ' on' : ''}`} title="Mute" onClick={() => toggleTrackFlag(t.id, 'muted')}>M</button>
        <button className={`btn small strip-s${t.solo ? ' on' : ''}`} title="Solo" onClick={() => toggleTrackFlag(t.id, 'solo')}>S</button>
      </div>
      <button className={`btn small strip-fx${props.fxOpen ? ' active' : ''}`} onClick={props.onFx} title="Track effects">
        FX{fxCount ? ` ${fxCount}` : ''}
      </button>
    </div>
  )
}

function VoiceoverSection(props: { tracks: Track[] }): JSX.Element {
  const vo = useVoiceover()
  const fps = useProject((s) => s.project.sequence.fps)
  const [monitoring, setMonitoring] = useState(false)
  const busy = vo.status !== 'idle'

  // Default / repair the target track.
  useEffect(() => {
    if (!props.tracks.some((t) => t.id === vo.trackId)) vo.set({ trackId: props.tracks[0]?.id ?? null })
  }, [props.tracks, vo.trackId])

  // Keep the input open for the meter while monitoring; release the mic when the panel closes.
  useEffect(() => {
    if (!monitoring) return
    void openInput().catch((err) => useVoiceover.setState({ error: `Microphone unavailable: ${err.message ?? err}` }))
  }, [monitoring, vo.deviceId, vo.cleanup])
  useEffect(() => () => closeInput(), [])

  const enableInput = async (): Promise<void> => {
    await refreshDevices()
    setMonitoring(true)
  }

  return (
    <Section title="Voiceover">
      {vo.devices.length === 0 ? (
        <Row label="Microphone">
          <button className="btn small" onClick={() => void enableInput()}>Enable microphone</button>
        </Row>
      ) : (
        <Row label="Microphone">
          <select className="select grow" value={vo.deviceId} disabled={busy} onChange={(e) => vo.set({ deviceId: e.target.value })}>
            {vo.devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
          </select>
          <button className="btn ghost icon small" title="Refresh devices" disabled={busy} onClick={() => void refreshDevices()}>⟳</button>
        </Row>
      )}
      <Row label="Record to">
        <select className="select grow" value={vo.trackId ?? ''} disabled={busy} onChange={(e) => vo.set({ trackId: e.target.value })}>
          {props.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Row>
      <Row label="Input level">
        {monitoring || busy ? (
          <PeakMeter horizontal read={() => [inputLevel()]} />
        ) : (
          <button className="btn small" onClick={() => void enableInput()}>Show input level</button>
        )}
      </Row>
      <Row label="Voice cleanup" title="Browser echo cancellation and noise suppression. Leave off for the cleanest recording.">
        <Toggle value={vo.cleanup} onChange={(v) => vo.set({ cleanup: v })} />
      </Row>
      <div className="vo-controls">
        {vo.status === 'idle' && (
          <button className="btn vo-record" onClick={() => void startVoiceover()} disabled={!vo.trackId}>
            <span className="vo-dot" /> Record
          </button>
        )}
        {vo.status === 'countdown' && (
          <>
            <div className="vo-countdown">{vo.countdown}</div>
            <button className="btn" onClick={() => void stopVoiceover()}>Cancel</button>
          </>
        )}
        {vo.status === 'recording' && (
          <>
            <button className="btn vo-stop" onClick={() => void stopVoiceover()}>■ Stop</button>
            <span className="vo-time"><span className="vo-dot live" /> {shortTime(vo.elapsed)} from {timecode(vo.startedAt, fps)}</span>
          </>
        )}
        {vo.status === 'saving' && <span className="muted">Saving take…</span>}
      </div>
      {vo.error && <div className="vo-error">{vo.error}</div>}
      <div className="muted vo-hint">Recording starts at the playhead after a 3-2-1 countdown and plays the timeline. Use headphones so the playback isn't recorded.</div>
    </Section>
  )
}
