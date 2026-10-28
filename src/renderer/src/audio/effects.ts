import type { ParamDef } from '@/lib/params'

/**
 * Audio effect registry. `build` creates a Web Audio sub-graph for one effect instance in either a
 * realtime AudioContext or an OfflineAudioContext (export), so preview and export sound the same.
 */
export interface AudioEffectDef {
  type: string
  name: string
  category: 'EQ & Filter' | 'Dynamics' | 'Time & Space' | 'Utility'
  params: ParamDef[]
  build(
    ctx: BaseAudioContext,
    params: Record<string, number | string | boolean>
  ): { input: AudioNode; output: AudioNode; update?(params: Record<string, number | string | boolean>): void }
}

export const AUDIO_EFFECTS: AudioEffectDef[] = []

export function getAudioEffect(type: string): AudioEffectDef | undefined {
  return AUDIO_EFFECTS.find((e) => e.type === type)
}
