import type { Keyframe } from '@shared/types'

function ease(kind: Keyframe['ease'], x: number): number {
  switch (kind) {
    case 'ease-in': return x * x
    case 'ease-out': return 1 - (1 - x) * (1 - x)
    case 'ease-in-out': return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2
    default: return x
  }
}

/**
 * Value of a keyframed property at time t (seconds relative to clip start). The easing of a
 * keyframe applies to the segment that starts at it; 'hold' keeps its value until the next one.
 * Returns `fallback` when there are no keyframes.
 */
export function valueAt(kfs: Keyframe[] | undefined, t: number, fallback: number): number {
  if (!kfs || kfs.length === 0) return fallback
  if (t <= kfs[0].t) return kfs[0].v
  const last = kfs[kfs.length - 1]
  if (t >= last.t) return last.v
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (t >= a.t && t < b.t) {
      if (a.ease === 'hold') return a.v
      const x = (t - a.t) / (b.t - a.t || 1)
      return a.v + (b.v - a.v) * ease(a.ease, x)
    }
  }
  return last.v
}

/** Returns a new sorted keyframe list with a keyframe at t set to v (replacing one within 1 ms). */
export function setKeyframe(kfs: Keyframe[] | undefined, t: number, v: number, easeKind?: Keyframe['ease']): Keyframe[] {
  const list = (kfs ?? []).filter((k) => Math.abs(k.t - t) > 0.001)
  list.push({ t, v, ease: easeKind })
  return list.sort((a, b) => a.t - b.t)
}

export function removeKeyframeNear(kfs: Keyframe[] | undefined, t: number, tolerance = 0.001): Keyframe[] {
  return (kfs ?? []).filter((k) => Math.abs(k.t - t) > tolerance)
}
