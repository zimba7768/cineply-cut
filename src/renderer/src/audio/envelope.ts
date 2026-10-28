import type { Clip, Project, Track } from '@shared/types'
import { clipEnd } from '@shared/types'
import { valueAt } from '@/lib/keyframes'
import { clipAfter, clipBefore } from '@/store/project'

/**
 * Pure timing and gain math for the mix: which clips sound when, and the gain envelope of each one
 * (clip gain × volume keyframes × fades × transition crossfades). Shared by realtime and offline mixes.
 */

export interface Ramp {
  t0: number
  t1: number
  dir: 'in' | 'out'
  shape: 'power' | 'linear'
}

export interface VoicePlan {
  clip: Clip
  /** Timeline span during which this clip is heard (extends past the clip edges for crossfades). */
  start: number
  end: number
  ramps: Ramp[]
}

export interface EnvelopePoint {
  t: number
  v: number
}

export const anySolo = (p: Project): boolean => p.tracks.some((t) => t.kind === 'audio' && t.solo)

export const isAudible = (track: Track, solo: boolean): boolean => !track.muted && (!solo || track.solo)

/** Plans one clip's voice, or null if it makes no sound (video track, title, no media, zero length). */
export function planClip(project: Project, clip: Clip): VoicePlan | null {
  const track = project.tracks.find((t) => t.id === clip.trackId)
  if (!track || track.kind !== 'audio' || clip.type !== 'media' || !clip.mediaId) return null
  if (!(clip.duration > 0) || !(clip.speed > 0)) return null

  let start = clip.start
  let end = clipEnd(clip)
  const ramps: Ramp[] = []

  const dIn = Math.max(0, clip.transitionIn?.duration ?? 0)
  if (dIn > 0) {
    if (clipBefore(project, clip)) {
      start = clip.start - dIn / 2
      ramps.push({ t0: clip.start - dIn / 2, t1: clip.start + dIn / 2, dir: 'in', shape: 'power' })
    } else {
      ramps.push({ t0: clip.start, t1: clip.start + Math.min(dIn, clip.duration), dir: 'in', shape: 'power' })
    }
  }

  const next = clipAfter(project, clip)
  const dNext = Math.max(0, next?.transitionIn?.duration ?? 0)
  const dOut = Math.max(0, clip.transitionOut?.duration ?? 0)
  if (next && dNext > 0) {
    // The outgoing clip keeps playing into the incoming clip's transition window.
    end = clipEnd(clip) + dNext / 2
    ramps.push({ t0: clipEnd(clip) - dNext / 2, t1: end, dir: 'out', shape: 'power' })
  } else if (!next && dOut > 0) {
    ramps.push({ t0: end - Math.min(dOut, clip.duration), t1: end, dir: 'out', shape: 'power' })
  }

  // Source media starts at 0: a crossfade can't reach before the first sample.
  if (clip.in + (start - clip.start) * clip.speed < 0) start = clip.start - clip.in / clip.speed

  const { fadeIn, fadeOut } = clip.audio
  if (fadeIn > 0) ramps.push({ t0: start, t1: start + fadeIn, dir: 'in', shape: 'linear' })
  if (fadeOut > 0) ramps.push({ t0: end - fadeOut, t1: end, dir: 'out', shape: 'linear' })

  return { clip, start, end, ramps }
}

/** Plans every audible-by-structure clip (mute/solo are applied as gains, not here). */
export function planVoices(project: Project): VoicePlan[] {
  const plans: VoicePlan[] = []
  for (const clip of project.clips) {
    const plan = planClip(project, clip)
    if (plan) plans.push(plan)
  }
  return plans
}

export function rampFactor(r: Ramp, t: number): number {
  const p = r.t1 > r.t0 ? Math.min(1, Math.max(0, (t - r.t0) / (r.t1 - r.t0))) : t >= r.t1 ? 1 : 0
  if (r.shape === 'power') return r.dir === 'in' ? Math.sin((p * Math.PI) / 2) : Math.cos((p * Math.PI) / 2)
  return r.dir === 'in' ? p : 1 - p
}

/** Linear gain of the clip at timeline time t (before track gain, pan and master). */
export function envelopeAt(plan: VoicePlan, t: number): number {
  const a = plan.clip.audio
  if (a.mute) return 0
  let g = a.gain * valueAt(a.volumeKeyframes, t - plan.clip.start, 1)
  for (const r of plan.ramps) g *= rampFactor(r, t)
  return Math.max(0, g)
}

const EPS = 1e-4

/**
 * Breakpoints of the envelope over [from, to] for AudioParam automation. Between consecutive points
 * the envelope is linear (exact for flat and linearly keyframed stretches); fades, crossfades and
 * eased keyframes are sampled at `rate` points per second. Holds jump within EPS seconds.
 */
export function envelopePoints(plan: VoicePlan, from: number, to: number, rate = 100): EnvelopePoint[] {
  if (!(to > from)) return [{ t: from, v: envelopeAt(plan, from) }]
  const kfs = plan.clip.audio.volumeKeyframes ?? []
  const times = new Set<number>([from, to])
  for (const r of plan.ramps) [r.t0, r.t1].forEach((t) => t > from && t < to && times.add(t))
  for (const k of kfs) {
    const t = plan.clip.start + k.t
    if (t > from && t < to) times.add(t)
  }
  const bounds = [...times].sort((a, b) => a - b)

  const curved = (a: number, b: number): boolean => {
    if (plan.ramps.some((r) => r.t0 < b && r.t1 > a)) return true
    const rel = (a + b) / 2 - plan.clip.start
    for (let i = 0; i < kfs.length - 1; i++) {
      if (rel >= kfs[i].t && rel < kfs[i + 1].t) {
        const e = kfs[i].ease
        return e === 'ease-in' || e === 'ease-out' || e === 'ease-in-out'
      }
    }
    return false
  }

  const pts: EnvelopePoint[] = []
  const push = (t: number, v: number): void => {
    if (pts.length && t <= pts[pts.length - 1].t + EPS / 2) return
    pts.push({ t, v })
  }
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i]
    const b = bounds[i + 1]
    push(a, envelopeAt(plan, a))
    if (curved(a, b)) {
      const n = Math.max(1, Math.ceil((b - a) * rate))
      for (let k = 1; k < n; k++) {
        const t = a + ((b - a) * k) / n
        push(t, envelopeAt(plan, t))
      }
    }
    if (b - a > 2 * EPS) {
      // A jump at b (hold keyframe, mute edge): keep the old value until just before it.
      const before = envelopeAt(plan, b - EPS)
      if (Math.abs(before - envelopeAt(plan, b)) > 1e-4) push(b - EPS, before)
    }
  }
  push(to, envelopeAt(plan, to))
  return pts
}
