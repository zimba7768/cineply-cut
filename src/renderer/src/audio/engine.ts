import type { MediaItem, Project } from '@shared/types'
import { useProject } from '@/store/project'
import { decodeMedia, onDecoded, peekDecoded } from './decode'
import { planVoices } from './envelope'
import { MixGraph } from './graph'

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

/** Context time between start() and the first audible sample, so the first events aren't late. */
const START_LEAD = 0.06
/** How far ahead of "now" live changes are scheduled (must exceed the render-ahead of the device). */
const LIVE_LEAD = 0.04
const LOOKAHEAD = 8
const PUMP_MS = 200

let ctx: AudioContext | null = null
let graph: MixGraph | null = null
let project: Project | null = null
let playing = false
let pumpTimer: ReturnType<typeof setInterval> | undefined
let unsubscribe: (() => void) | undefined

// Clock: a performance.now()-based line through (anchorPerf, anchorCtx) that is gently slewed toward
// the device's output timestamp, so it is smooth, accurate and never runs backwards.
let anchor: { perf: number; ctx: number } | null = null
let lastClock = 0

function audioContext(sampleRate: number): AudioContext | null {
  if (ctx && ctx.state !== 'closed' && ctx.sampleRate === sampleRate) return ctx
  void ctx?.close().catch(() => undefined)
  try {
    ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' })
  } catch (err) {
    console.warn('[audio] no AudioContext at', sampleRate, err)
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' })
    } catch {
      ctx = null
    }
  }
  return ctx
}

/** The sample rate buffers are decoded at (the sequence rate). */
const rateOf = (p: Project): number => p.sequence.sampleRate || 48000

function lookup(sampleRate: number) {
  return (m: MediaItem): AudioBuffer | null | undefined => {
    const b = peekDecoded(m, sampleRate)
    if (b === undefined) void decodeMedia(m, sampleRate)
    return b
  }
}

/** Starts decoding every media item used by an audio clip, in timeline order around time t. */
function requestDecodes(p: Project, t = 0): Promise<unknown> {
  const sr = rateOf(p)
  const media = new Map(p.media.map((m) => [m.id, m]))
  const plans = planVoices(p).sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t))
  const ids = [...new Set(plans.map((pl) => pl.clip.mediaId!))]
  return Promise.all(ids.map((id) => media.get(id)).filter((m): m is MediaItem => !!m).map((m) => decodeMedia(m, sr)))
}

function liveFloor(): number {
  if (!ctx || !graph) return 0
  return Math.max(ctx.currentTime + LIVE_LEAD, graph.ctxStart)
}

function pump(): void {
  if (graph && project) graph.sync(project, liveFloor())
}

/** Context time of the sample reaching the speakers now. */
function heardContextTime(c: AudioContext, now: number): number {
  const ts = c.getOutputTimestamp()
  if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0 && ts.contextTime > 0) {
    return Math.min(c.currentTime, ts.contextTime + (now - ts.performanceTime) / 1000)
  }
  return c.currentTime - (c.baseLatency || 0) - (c.outputLatency || 0)
}

function stopGraph(): void {
  clearInterval(pumpTimer)
  pumpTimer = undefined
  unsubscribe?.()
  unsubscribe = undefined
  graph?.dispose()
  graph = null
}

onDecoded(() => {
  if (playing) pump()
})

export const audioEngine: AudioEngine = {
  start(p, t, rate) {
    stopGraph()
    project = p
    playing = true
    anchor = null
    lastClock = t
    const c = audioContext(rateOf(p))
    if (c) {
      if (c.state !== 'running') void c.resume().catch(() => undefined)
      graph = new MixGraph(c, {
        destination: c.destination,
        from: t,
        ctxStart: c.currentTime + START_LEAD,
        rate,
        lookup: lookup(rateOf(p)),
        metering: true,
        lookahead: LOOKAHEAD
      })
      graph.sync(p, graph.ctxStart)
      pumpTimer = setInterval(pump, PUMP_MS)
    }
    if (rate > 0) void requestDecodes(p, t)
    // Apply edits made during playback even if the caller doesn't forward them.
    unsubscribe = useProject.subscribe((s) => {
      if (s.project !== project) audioEngine.update(s.project)
    })
  },

  stop() {
    playing = false
    stopGraph()
    anchor = null
  },

  clockTime() {
    if (!playing) return null
    const now = performance.now()
    const from = graph?.from ?? lastClock
    const rate = graph?.rate ?? 1
    let t: number
    if (ctx && graph && ctx.state === 'running') {
      const raw = heardContextTime(ctx, now)
      if (!anchor) anchor = { perf: now, ctx: raw }
      const err = raw - (anchor.ctx + (now - anchor.perf) / 1000)
      if (Math.abs(err) > 0.08) anchor = { perf: now, ctx: raw }
      else anchor.ctx += err * 0.05
      const heard = anchor.ctx + (now - anchor.perf) / 1000
      t = from + Math.max(0, heard - graph.ctxStart) * rate
    } else {
      // No running audio device: keep the picture moving on the wall clock.
      if (!anchor) anchor = { perf: now, ctx: 0 }
      t = from + ((now - anchor.perf) / 1000) * rate
    }
    if (rate > 0) t = Math.max(t, lastClock)
    else if (rate < 0) t = Math.min(t, lastClock)
    lastClock = Math.max(0, t)
    return lastClock
  },

  update(p) {
    if (p === project) return
    project = p
    if (!playing || !graph) return
    graph.sync(p, liveFloor())
    void requestDecodes(p, lastClock)
  },

  async renderMix(p, start, end) {
    const sr = rateOf(p)
    const length = Math.max(1, Math.ceil((end - start) * sr))
    const octx = new OfflineAudioContext(2, length, sr)
    await requestDecodes(p, start)
    const offline = new MixGraph(octx, {
      destination: octx.destination,
      from: start,
      ctxStart: 0,
      rate: 1,
      lookup: (m) => peekDecoded(m, sr),
      metering: false,
      lookahead: LOOKAHEAD * 1.5
    })
    offline.sync(p, 0)
    // Create voices window by window so long timelines don't run every clip's nodes for the whole render.
    const duration = length / sr
    for (let t = LOOKAHEAD; t < duration - 0.01; t += LOOKAHEAD) {
      void octx.suspend(t).then(() => {
        offline.sync(p, t)
        return octx.resume()
      })
    }
    const out = await octx.startRendering()
    offline.dispose()
    return out
  },

  meter() {
    return playing && graph?.meter ? graph.meter.peak() : [0, 0]
  }
}

/** Peak levels [left, right] of one audio track's output (post fader/pan) while playing. */
export function trackMeter(trackId: string): [number, number] {
  return playing && graph ? graph.trackMeter(trackId) : [0, 0]
}

/** True while the engine is playing (used by meters and the voiceover recorder). */
export function isPlaying(): boolean {
  return playing
}
