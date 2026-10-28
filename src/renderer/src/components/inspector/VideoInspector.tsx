import { useRef, type JSX } from 'react'
import type { Draft } from 'immer'
import type { BlendMode, Clip, VideoProps } from '@shared/types'
import { useProject } from '@/store/project'
import { usePlayback } from '@/store/playback'
import { updateClip } from '@/lib/editing'
import { removeKeyframeNear, setKeyframe, valueAt } from '@/lib/keyframes'
import { NumberSlider, Row, Section, Toggle } from '../ui/controls'
import './Inspector.css'

export type AnimProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity'

const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'source-over', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
  { value: 'lighter', label: 'Add (Linear Dodge)' }
]

const clampLocal = (clip: Clip, t: number): number => Math.min(Math.max(0, t - clip.start), clip.duration)

/** The clip's value of an animatable prop at local time (keyframes override the static value). */
export function animatedValue(clip: Clip, prop: AnimProp, local: number): number {
  return valueAt(clip.video.keyframes[prop], local, clip.video[prop])
}

/**
 * Sets an animatable prop: updates (or adds) the keyframe at `local` when the prop is keyframed,
 * otherwise sets the static value.
 */
export function setAnimatedProp(c: Draft<Clip>, prop: AnimProp, value: number, local: number): void {
  const kfs = c.video.keyframes[prop]
  if (kfs && kfs.length) {
    const existing = kfs.find((k) => Math.abs(k.t - local) <= 0.001)
    c.video.keyframes[prop] = setKeyframe(kfs.map((k) => ({ ...k })), local, value, existing?.ease)
  } else {
    c.video[prop] = value
  }
}

const playheadLocal = (clip: Clip): number => clampLocal(clip, usePlayback.getState().time)

function KeyframeButtons(props: { clip: Clip; prop: AnimProp; local: number; onEdit(label: string, fn: (c: Draft<Clip>) => void): void }): JSX.Element {
  const { clip, prop } = props
  const kfs = clip.video.keyframes[prop] ?? []
  const animated = kfs.length > 0
  const halfFrame = 0.5 / useProject.getState().project.sequence.fps
  const atKey = kfs.some((k) => Math.abs(k.t - props.local) < halfFrame)
  const prev = [...kfs].reverse().find((k) => k.t < props.local - halfFrame)
  const next = kfs.find((k) => k.t > props.local + halfFrame)
  const goto = (t: number): void => {
    usePlayback.getState().setPlaying(false)
    usePlayback.getState().setTime(clip.start + t)
  }

  const toggleAnimation = (): void => {
    const local = playheadLocal(clip)
    const value = animatedValue(clip, prop, local)
    if (animated) {
      props.onEdit(`Stop animating ${prop}`, (c) => {
        c.video[prop] = value
        delete c.video.keyframes[prop]
      })
    } else {
      props.onEdit(`Animate ${prop}`, (c) => {
        c.video.keyframes[prop] = [{ t: local, v: value }]
      })
    }
  }

  const toggleKey = (): void => {
    const local = playheadLocal(clip)
    if (atKey) {
      props.onEdit(`Remove ${prop} keyframe`, (c) => {
        const left = removeKeyframeNear(c.video.keyframes[prop], local, halfFrame).map((k) => ({ ...k }))
        if (left.length) c.video.keyframes[prop] = left
        else {
          c.video[prop] = animatedValue(clip, prop, local)
          delete c.video.keyframes[prop]
        }
      })
    } else {
      const value = animatedValue(clip, prop, local)
      props.onEdit(`Add ${prop} keyframe`, (c) => {
        c.video.keyframes[prop] = setKeyframe(c.video.keyframes[prop]?.map((k) => ({ ...k })), local, value)
      })
    }
  }

  return (
    <span className="kf-buttons">
      {animated && (
        <>
          <button className="kf-btn" disabled={!prev} onClick={() => prev && goto(prev.t)} title="Previous keyframe">◂</button>
          <button className={`kf-btn diamond${atKey ? ' on' : ''}`} onClick={toggleKey} title={atKey ? 'Remove keyframe' : 'Add keyframe at playhead'}>◆</button>
          <button className="kf-btn" disabled={!next} onClick={() => next && goto(next.t)} title="Next keyframe">▸</button>
        </>
      )}
      <button className={`kf-btn watch${animated ? ' on' : ''}`} onClick={toggleAnimation} title={animated ? 'Stop animating (removes keyframes)' : 'Animate: add a keyframe at the playhead'}>
        ⏱
      </button>
    </span>
  )
}

function NumberRow(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  /** Display multiplier, e.g. 100 to show a 0..1 value as percent. */
  factor?: number
  onChange(v: number): void
  right?: JSX.Element
}): JSX.Element {
  const f = props.factor ?? 1
  return (
    <Row label={props.label}>
      <NumberSlider
        value={props.value * f}
        min={props.min * f}
        max={props.max * f}
        step={props.step}
        unit={props.unit}
        onChange={(v) => props.onChange(v / f)}
      />
      {props.right}
    </Row>
  )
}

/** Motion, opacity/blend, crop and colour of a video-track clip. */
export function VideoInspector(props: { clip: Clip }): JSX.Element {
  const { clip } = props
  const v = clip.video
  const seq = useProject((s) => s.project.sequence)
  const animated = Object.values(v.keyframes).some((k) => k && k.length > 0)
  const time = usePlayback((s) => (animated ? s.time : 0))
  const local = clampLocal(clip, time)
  // Each pointer/keyboard interaction starts a new coalesced undo step; slider drags within it merge.
  const session = useRef(0)

  const edit = (label: string, key: string, fn: (c: Draft<Clip>) => void): void =>
    updateClip(clip.id, label, fn, `video:${clip.id}:${key}:${session.current}`)
  const editOnce = (label: string, fn: (c: Draft<Clip>) => void): void => updateClip(clip.id, label, fn)

  const anim = (prop: AnimProp, label: string, opts: { min: number; max: number; step?: number; unit?: string; factor?: number }): JSX.Element => (
    <NumberRow
      label={label}
      value={animatedValue(clip, prop, local)}
      {...opts}
      onChange={(x) => edit(`Change ${label.toLowerCase()}`, prop, (c) => setAnimatedProp(c, prop, x, playheadLocal(clip)))}
      right={<KeyframeButtons clip={clip} prop={prop} local={local} onEdit={editOnce} />}
    />
  )

  const plain = <K extends 'brightness' | 'contrast' | 'saturation' | 'hue' | 'blur'>(
    prop: K,
    label: string,
    opts: { min: number; max: number; step?: number; unit?: string; factor?: number }
  ): JSX.Element => (
    <NumberRow label={label} value={v[prop]} {...opts} onChange={(x) => edit(`Change ${label.toLowerCase()}`, prop, (c) => { c.video[prop] = x })} />
  )

  const crop = (side: keyof VideoProps['crop'], label: string): JSX.Element => (
    <NumberRow
      label={label}
      value={v.crop[side]}
      min={0}
      max={1}
      step={0.1}
      unit="%"
      factor={100}
      onChange={(x) => edit('Crop', `crop-${side}`, (c) => { c.video.crop[side] = Math.min(1, Math.max(0, x)) })}
    />
  )

  const reset = (label: string, fn: (c: Draft<Clip>) => void): JSX.Element => (
    <button className="btn ghost small" title={`Reset ${label}`} onClick={() => editOnce(`Reset ${label}`, fn)}>↺</button>
  )

  return (
    <div
      className="video-inspector"
      onPointerDownCapture={() => session.current++}
      onKeyDownCapture={() => session.current++}
    >
      <Section
        title="Motion"
        right={reset('motion', (c) => {
          Object.assign(c.video, { x: 0, y: 0, scale: 1, rotation: 0, fit: 'fit', flipH: false, flipV: false })
          for (const p of ['x', 'y', 'scale', 'rotation'] as const) delete c.video.keyframes[p]
        })}
      >
        {anim('x', 'Position X', { min: -seq.width, max: seq.width, step: 1, unit: 'px' })}
        {anim('y', 'Position Y', { min: -seq.height, max: seq.height, step: 1, unit: 'px' })}
        {anim('scale', 'Scale', { min: 0, max: 4, step: 1, unit: '%', factor: 100 })}
        {anim('rotation', 'Rotation', { min: -360, max: 360, step: 0.1, unit: '°' })}
        <Row label="Fit">
          <select className="select grow" value={v.fit} onChange={(e) => editOnce('Change fit', (c) => { c.video.fit = e.target.value as VideoProps['fit'] })}>
            <option value="fit">Fit (letterbox)</option>
            <option value="fill">Fill (crop)</option>
            <option value="stretch">Stretch</option>
            <option value="none">Original size</option>
          </select>
        </Row>
        <Row label="Flip">
          <Toggle label="Horizontal" value={v.flipH} onChange={(x) => editOnce('Flip horizontal', (c) => { c.video.flipH = x })} />
          <Toggle label="Vertical" value={v.flipV} onChange={(x) => editOnce('Flip vertical', (c) => { c.video.flipV = x })} />
        </Row>
      </Section>

      <Section
        title="Opacity"
        right={reset('opacity', (c) => {
          c.video.opacity = 1
          c.video.blendMode = 'source-over'
          delete c.video.keyframes.opacity
        })}
      >
        {anim('opacity', 'Opacity', { min: 0, max: 1, step: 1, unit: '%', factor: 100 })}
        <Row label="Blend mode">
          <select className="select grow" value={v.blendMode} onChange={(e) => editOnce('Change blend mode', (c) => { c.video.blendMode = e.target.value as BlendMode })}>
            {BLEND_MODES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </Row>
      </Section>

      <Section title="Crop" defaultOpen={v.crop.left + v.crop.right + v.crop.top + v.crop.bottom > 0} right={reset('crop', (c) => { c.video.crop = { left: 0, right: 0, top: 0, bottom: 0 } })}>
        {crop('left', 'Left')}
        {crop('right', 'Right')}
        {crop('top', 'Top')}
        {crop('bottom', 'Bottom')}
      </Section>

      <Section
        title="Color"
        right={reset('color', (c) => Object.assign(c.video, { brightness: 1, contrast: 1, saturation: 1, hue: 0, blur: 0 }))}
      >
        {plain('brightness', 'Brightness', { min: 0, max: 3, step: 1, unit: '%', factor: 100 })}
        {plain('contrast', 'Contrast', { min: 0, max: 3, step: 1, unit: '%', factor: 100 })}
        {plain('saturation', 'Saturation', { min: 0, max: 3, step: 1, unit: '%', factor: 100 })}
        {plain('hue', 'Hue', { min: -180, max: 180, step: 1, unit: '°' })}
        {plain('blur', 'Blur', { min: 0, max: 100, step: 0.1, unit: 'px' })}
      </Section>
    </div>
  )
}
