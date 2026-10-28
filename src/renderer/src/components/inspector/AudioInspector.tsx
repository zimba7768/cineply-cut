import { useState, type JSX } from 'react'
import type { Clip, Keyframe } from '@shared/types'
import { NumberSlider, Row, Section, Toggle } from '@/components/ui/controls'
import { dbToGain, gainToDb } from '@/audio/effects'
import { EffectRack, formatDb } from '@/audio/ui'
import {
  NORMALIZE_TARGETS, denoiseClip, normalizeClip, type DenoiseStrength, type HumRemoval, type NormalizeTarget
} from '@/audio/processing'
import { updateClip } from '@/lib/editing'
import { setKeyframe, valueAt } from '@/lib/keyframes'
import { shortTime } from '@/lib/time'
import { usePlayback } from '@/store/playback'
import { findMedia, findTrack, linkedClips, useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import './AudioInspector.css'

const MIN_DB = -60
const toDb = (g: number): number => Math.max(MIN_DB, gainToDb(g))
const fromDb = (db: number): number => (db <= MIN_DB ? 0 : dbToGain(db))
const EASES: { value: NonNullable<Keyframe['ease']>; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease-in', label: 'Ease in' },
  { value: 'ease-out', label: 'Ease out' },
  { value: 'ease-in-out', label: 'Ease in/out' },
  { value: 'hold', label: 'Hold' }
]

// Clip audio: gain, pan, fades, volume keyframes, effect rack, denoise, normalize.
export function AudioInspector(props: { clip: Clip }): JSX.Element {
  const clip = props.clip
  const project = useProject((s) => s.project)
  const track = findTrack(project, clip.trackId)
  const media = findMedia(project, clip.mediaId)

  if (track?.kind !== 'audio') {
    const partner = linkedClips(project, clip).find((c) => findTrack(project, c.trackId)?.kind === 'audio')
    return (
      <Section title="Audio">
        <div className="muted">Video tracks are silent. The sound lives on {partner ? 'the linked audio clip' : 'an audio track'}.</div>
        {partner && <button className="btn small" onClick={() => useUi.getState().select([partner.id])}>Select linked audio</button>}
      </Section>
    )
  }

  const a = clip.audio
  const id = clip.id
  const maxFade = Math.max(0.05, Math.min(10, clip.duration))
  return (
    <>
      <Section title="Audio">
        <Row label="Gain">
          <NumberSlider
            value={toDb(a.gain)} min={MIN_DB} max={24} step={0.1} unit="dB"
            format={(db) => (db <= MIN_DB ? '-inf' : db.toFixed(1))}
            onChange={(db) => updateClip(id, 'Clip gain', (c) => { c.audio.gain = fromDb(db) }, `clip-gain-${id}`)}
          />
        </Row>
        <Row label="Pan">
          <NumberSlider
            value={a.pan} min={-1} max={1} step={0.01}
            onChange={(v) => updateClip(id, 'Clip pan', (c) => { c.audio.pan = Math.max(-1, Math.min(1, v)) }, `clip-pan-${id}`)}
          />
        </Row>
        <Row label="Mute">
          <Toggle value={a.mute} onChange={(v) => updateClip(id, v ? 'Mute clip' : 'Unmute clip', (c) => { c.audio.mute = v })} />
        </Row>
        <Row label="Fade in">
          <NumberSlider
            value={a.fadeIn} min={0} max={maxFade} step={0.05} unit="s"
            onChange={(v) => updateClip(id, 'Fade in', (c) => { c.audio.fadeIn = Math.max(0, v) }, `clip-fadein-${id}`)}
          />
        </Row>
        <Row label="Fade out">
          <NumberSlider
            value={a.fadeOut} min={0} max={maxFade} step={0.05} unit="s"
            onChange={(v) => updateClip(id, 'Fade out', (c) => { c.audio.fadeOut = Math.max(0, v) }, `clip-fadeout-${id}`)}
          />
        </Row>
        <Row label="Speed">
          <span>{Math.round(clip.speed * 100)}%</span>
          {clip.speed !== 1 && <span className="muted">pitch follows speed</span>}
        </Row>
        {media && (
          <Row label="Source" title={media.path}>
            <span className="ai-source">{media.name} · {shortTime(clip.in)}–{shortTime(clip.in + clip.duration * clip.speed)}</span>
          </Row>
        )}
      </Section>

      <VolumeKeyframes clip={clip} />

      <Section title="Clip effects">
        <EffectRack target={{ kind: 'clip', id }} effects={a.effects} compact />
      </Section>

      <RepairSection clip={clip} />
    </>
  )
}

function VolumeKeyframes(props: { clip: Clip }): JSX.Element {
  const clip = props.clip
  const id = clip.id
  const time = usePlayback((s) => s.time)
  const kfs = clip.audio.volumeKeyframes ?? []
  const rel = time - clip.start
  const inside = rel >= -1e-6 && rel <= clip.duration + 1e-6
  const current = valueAt(kfs, rel, 1)

  const edit = (label: string, fn: (list: Keyframe[]) => Keyframe[], coalesce?: string): void =>
    updateClip(id, label, (c) => { c.audio.volumeKeyframes = fn(c.audio.volumeKeyframes.map((k) => ({ ...k }))) }, coalesce)

  return (
    <Section
      title="Volume keyframes"
      right={kfs.length > 0 ? <button className="btn ghost small" onClick={() => edit('Clear volume keyframes', () => [])}>Clear</button> : undefined}
    >
      <Row label="At playhead">
        <span className="ai-mono">{inside ? `${formatDb(current)} dB` : '—'}</span>
        <button
          className="btn small" disabled={!inside} title="Add a keyframe at the playhead with the current level"
          onClick={() => edit('Add volume keyframe', (list) => setKeyframe(list, Math.max(0, Math.min(clip.duration, rel)), current))}
        >
          ◆ Add keyframe
        </button>
      </Row>
      {kfs.length === 0 && <div className="muted ai-note">No keyframes: the clip plays at its gain. Keyframes multiply the clip gain.</div>}
      {kfs.map((k, i) => (
        <div key={i} className="ai-kf">
          <button className="btn ghost small ai-kf-time" title="Move the playhead here" onClick={() => usePlayback.getState().setTime(clip.start + k.t)}>
            {shortTime(k.t)}
          </button>
          <input
            type="range" min={MIN_DB} max={12} step={0.1} value={toDb(k.v)}
            onChange={(e) => edit('Volume keyframe', (list) => {
              list[i].v = fromDb(Number(e.target.value))
              return list
            }, `kf-${id}-${i}`)}
          />
          <span className="ai-mono ai-kf-db">{formatDb(k.v)}</span>
          <select
            className="select" value={k.ease ?? 'linear'} title="Curve to the next keyframe"
            onChange={(e) => edit('Keyframe easing', (list) => {
              list[i].ease = e.target.value as Keyframe['ease']
              return list
            })}
          >
            {EASES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button className="btn ghost icon small" title="Delete keyframe" onClick={() => edit('Delete volume keyframe', (list) => list.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
    </Section>
  )
}

function RepairSection(props: { clip: Clip }): JSX.Element {
  const [strength, setStrength] = useState<DenoiseStrength>('medium')
  const [hum, setHum] = useState<HumRemoval>('off')
  const [target, setTarget] = useState<NormalizeTarget>('peak')
  const [busy, setBusy] = useState<null | 'denoise' | 'normalize'>(null)
  const run = async (kind: 'denoise' | 'normalize', fn: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }
  return (
    <Section title="Repair">
      <Row label="Noise">
        <select className="select grow" value={strength} onChange={(e) => setStrength(e.target.value as DenoiseStrength)}>
          <option value="light">Light</option>
          <option value="medium">Medium</option>
          <option value="strong">Strong</option>
        </select>
      </Row>
      <Row label="Hum">
        <select className="select grow" value={hum} onChange={(e) => setHum(e.target.value as HumRemoval)}>
          <option value="off">Off</option>
          <option value="50">50 Hz (Europe, Asia)</option>
          <option value="60">60 Hz (Americas)</option>
        </select>
      </Row>
      <Row label="">
        <button className="btn small" disabled={!!busy} onClick={() => void run('denoise', () => denoiseClip(props.clip.id, strength, hum))}>
          {busy === 'denoise' ? 'Reducing noise…' : 'Denoise'}
        </button>
        <span className="muted ai-note">Creates a cleaned copy; undo restores the original.</span>
      </Row>
      <Row label="Normalize to">
        <select className="select grow" value={target} onChange={(e) => setTarget(e.target.value as NormalizeTarget)}>
          {NORMALIZE_TARGETS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Row>
      <Row label="">
        <button className="btn small" disabled={!!busy} onClick={() => void run('normalize', () => normalizeClip(props.clip.id, target))}>
          {busy === 'normalize' ? 'Measuring…' : 'Normalize'}
        </button>
        <span className="muted ai-note">Sets the clip gain.</span>
      </Row>
    </Section>
  )
}
