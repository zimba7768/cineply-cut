import type { Draft } from 'immer'
import type { AudioEffect, Project } from '@shared/types'
import { uid } from '@/lib/ids'
import { defaultParams } from '@/lib/params'
import { useProject } from '@/store/project'
import { getAudioEffect } from './effects'

/** Undoable mixer and effect-rack edits. Slider edits pass a coalesce key so a drag is one undo step. */

export type RackTarget = { kind: 'clip' | 'track'; id: string }

function mutate(label: string, fn: (p: Draft<Project>) => void, coalesce?: string): void {
  useProject.getState().mutate(label, fn, coalesce ? { coalesce } : undefined)
}

function rackOf(p: Draft<Project>, target: RackTarget): Draft<AudioEffect>[] | null {
  if (target.kind === 'track') {
    const t = p.tracks.find((x) => x.id === target.id)
    if (!t) return null
    t.effects ??= []
    return t.effects
  }
  const c = p.clips.find((x) => x.id === target.id)
  return c ? c.audio.effects : null
}

export function setTrackGain(trackId: string, gain: number): void {
  mutate('Track volume', (p) => {
    const t = p.tracks.find((x) => x.id === trackId)
    if (t) t.gain = Math.max(0, gain)
  }, `track-gain-${trackId}`)
}

export function setTrackPan(trackId: string, pan: number): void {
  mutate('Track pan', (p) => {
    const t = p.tracks.find((x) => x.id === trackId)
    if (t) t.pan = Math.max(-1, Math.min(1, pan))
  }, `track-pan-${trackId}`)
}

export function toggleTrackFlag(trackId: string, flag: 'muted' | 'solo'): void {
  mutate(flag === 'muted' ? 'Mute track' : 'Solo track', (p) => {
    const t = p.tracks.find((x) => x.id === trackId)
    if (t) t[flag] = !t[flag]
  })
}

export function setMasterGain(gain: number): void {
  mutate('Master volume', (p) => {
    p.masterGain = Math.max(0, gain)
  }, 'master-gain')
}

export function addEffect(target: RackTarget, type: string): void {
  const def = getAudioEffect(type)
  if (!def) return
  mutate(`Add ${def.name}`, (p) => {
    rackOf(p, target)?.push({ id: uid(), type, enabled: true, params: defaultParams(def.params) })
  })
}

export function removeEffect(target: RackTarget, effectId: string): void {
  mutate('Remove audio effect', (p) => {
    const rack = rackOf(p, target)
    const i = rack?.findIndex((e) => e.id === effectId) ?? -1
    if (rack && i >= 0) rack.splice(i, 1)
  })
}

export function toggleEffect(target: RackTarget, effectId: string): void {
  mutate('Toggle audio effect', (p) => {
    const e = rackOf(p, target)?.find((x) => x.id === effectId)
    if (e) e.enabled = !e.enabled
  })
}

export function moveEffect(target: RackTarget, effectId: string, delta: -1 | 1): void {
  mutate('Reorder audio effects', (p) => {
    const rack = rackOf(p, target)
    if (!rack) return
    const i = rack.findIndex((e) => e.id === effectId)
    const j = i + delta
    if (i < 0 || j < 0 || j >= rack.length) return
    const [e] = rack.splice(i, 1)
    rack.splice(j, 0, e)
  })
}

export function setEffectParam(target: RackTarget, effectId: string, key: string, value: number | string | boolean): void {
  mutate('Audio effect parameter', (p) => {
    const e = rackOf(p, target)?.find((x) => x.id === effectId)
    if (e) e.params[key] = value
  }, `fx-${effectId}-${key}`)
}
