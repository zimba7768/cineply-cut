import type { Project } from '@shared/types'

/**
 * Audio engine contract. The playback engine calls start/stop and uses clockTime() as the master
 * clock while playing so picture follows sound.
 */
export interface AudioEngine {
  /** Start playing the project mix from timeline time t. */
  start(project: Project, t: number, rate: number): void
  stop(): void
  /** Timeline time of the audio currently being heard, or null when not playing. */
  clockTime(): number | null
  /** Called whenever the project changes during playback (gain/mute/pan changes should apply live). */
  update(project: Project): void
  /** Offline mix of [start, end) of the timeline for export. */
  renderMix(project: Project, start: number, end: number): Promise<AudioBuffer>
  /** Master output peak levels (0..1) for meters, [left, right]. */
  meter(): [number, number]
}

let startedAt = 0
let startT = 0
let playing = false
let playRate = 1

/** Placeholder: silent engine with a wall clock. Replaced by the real Web Audio engine. */
export const audioEngine: AudioEngine = {
  start(_p, t, rate) {
    startedAt = performance.now()
    startT = t
    playRate = rate
    playing = true
  },
  stop() {
    playing = false
  },
  clockTime() {
    return playing ? startT + ((performance.now() - startedAt) / 1000) * playRate : null
  },
  update() {},
  async renderMix(project, start, end) {
    const sr = project.sequence.sampleRate
    return new OfflineAudioContext(2, Math.max(1, Math.ceil((end - start) * sr)), sr).startRendering()
  },
  meter() {
    return [0, 0]
  }
}
