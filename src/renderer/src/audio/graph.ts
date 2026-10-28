import type { AudioEffect, MediaItem, Project, Track } from '@shared/types'
import { getAudioEffect, type AudioEffectInstance } from './effects'
import { anySolo, envelopePoints, isAudible, planVoices, type VoicePlan } from './envelope'

/**
 * The mix graph, shared by realtime playback and the offline export mix:
 *
 *   clip:   BufferSource → clip effects → envelope gain → clip pan ─┐
 *   track:  input → track effects → track gain (mute/solo) → track pan → master gain → [meter] → destination
 *
 * `sync(project, ctxFloor)` is idempotent: it applies mixer changes live, creates voices for clips that
 * start within the lookahead window, re-schedules envelopes that changed, and retires voices whose
 * timing changed or that have finished. Nothing is changed before `ctxFloor` (context time).
 */

export type BufferLookup = (media: MediaItem) => AudioBuffer | null | undefined

export interface MixGraphOptions {
  destination: AudioNode
  /** Timeline time heard at context time ctxStart. */
  from: number
  ctxStart: number
  /** Shuttle rate. Voices are only scheduled for rate > 0; other rates are silent. */
  rate: number
  lookup: BufferLookup
  metering: boolean
  /** Seconds of context time ahead of ctxFloor for which voices are created. */
  lookahead: number
}

const isOffline = (ctx: BaseAudioContext): boolean => ctx instanceof OfflineAudioContext

/** Sets a param immediately (offline / before playback) or glides to it (live mixer changes). */
function glide(ctx: BaseAudioContext, param: AudioParam, v: number, at: number, immediate = false): void {
  if (immediate || isOffline(ctx) || at <= ctx.currentTime) {
    param.cancelScheduledValues(0)
    param.value = v
    return
  }
  param.cancelScheduledValues(at)
  param.setTargetAtTime(v, at, 0.012)
}

function safeDisconnect(node: AudioNode | null | undefined): void {
  try {
    node?.disconnect()
  } catch {
    /* already disconnected */
  }
}

// --------------------------------------------------------------- meter ----

export class StereoMeter {
  readonly input: ChannelSplitterNode
  private readonly analysers: AnalyserNode[]
  private readonly data: Float32Array<ArrayBuffer>

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createChannelSplitter(2)
    this.analysers = [0, 1].map((ch) => {
      const a = ctx.createAnalyser()
      a.fftSize = 2048
      this.input.connect(a, ch)
      return a
    })
    this.data = new Float32Array(2048)
  }

  /** Peak absolute sample value of the last ~43 ms, per channel. */
  peak(): [number, number] {
    const out: [number, number] = [0, 0]
    this.analysers.forEach((a, ch) => {
      a.getFloatTimeDomainData(this.data)
      let m = 0
      for (let i = 0; i < this.data.length; i++) {
        const v = Math.abs(this.data[i])
        if (v > m) m = v
      }
      out[ch] = m
    })
    return out
  }

  dispose(): void {
    safeDisconnect(this.input)
  }
}

// -------------------------------------------------------- effect chain ----

/** A rack of effects between a fixed input and output node, rebuilt only when its structure changes. */
export class EffectChain {
  readonly input: GainNode
  readonly output: GainNode
  private items: { inst: AudioEffectInstance; params: string; hasUpdate: boolean }[] = []
  private signature = ''

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.input.connect(this.output)
  }

  set(effects: AudioEffect[]): void {
    const active = effects.filter((e) => e.enabled && getAudioEffect(e.type))
    const signature = active.map((e) => `${e.id}:${e.type}`).join('|')
    if (signature === this.signature) {
      let rebuild = false
      active.forEach((e, i) => {
        const item = this.items[i]
        const params = JSON.stringify(e.params)
        if (!item || params === item.params) return
        if (item.hasUpdate) {
          item.inst.update!(e.params)
          item.params = params
        } else rebuild = true
      })
      if (!rebuild) return
    }
    this.rebuild(active, signature)
  }

  private rebuild(active: AudioEffect[], signature: string): void {
    safeDisconnect(this.input)
    this.items.forEach((it) => safeDisconnect(it.inst.output))
    this.items = []
    let node: AudioNode = this.input
    for (const e of active) {
      try {
        const inst = getAudioEffect(e.type)!.build(this.ctx, e.params)
        node.connect(inst.input)
        node = inst.output
        this.items.push({ inst, params: JSON.stringify(e.params), hasUpdate: !!inst.update })
      } catch (err) {
        console.warn(`[audio] effect ${e.type} failed to build`, err)
      }
    }
    node.connect(this.output)
    this.signature = signature
  }

  dispose(): void {
    safeDisconnect(this.input)
    this.items.forEach((it) => safeDisconnect(it.inst.output))
    safeDisconnect(this.output)
  }
}

// ----------------------------------------------------------- track bus ----

class TrackBus {
  readonly input: GainNode
  readonly chain: EffectChain
  readonly gain: GainNode
  readonly pan: StereoPannerNode
  readonly meter: StereoMeter | null
  private level = -1
  private panValue = NaN

  constructor(private readonly ctx: BaseAudioContext, out: AudioNode, metering: boolean) {
    this.input = ctx.createGain()
    this.chain = new EffectChain(ctx)
    this.gain = ctx.createGain()
    this.pan = ctx.createStereoPanner()
    this.input.connect(this.chain.input)
    this.chain.output.connect(this.gain).connect(this.pan).connect(out)
    this.meter = metering ? new StereoMeter(ctx) : null
    if (this.meter) this.pan.connect(this.meter.input)
  }

  apply(track: Track, solo: boolean, at: number): void {
    const level = isAudible(track, solo) ? Math.max(0, track.gain) : 0
    if (level !== this.level) glide(this.ctx, this.gain.gain, level, at, this.level < 0)
    this.level = level
    const pan = Math.max(-1, Math.min(1, track.pan || 0))
    if (pan !== this.panValue) glide(this.ctx, this.pan.pan, pan, at, Number.isNaN(this.panValue))
    this.panValue = pan
    this.chain.set(track.effects ?? [])
  }

  dispose(): void {
    safeDisconnect(this.input)
    this.chain.dispose()
    safeDisconnect(this.gain)
    safeDisconnect(this.pan)
    this.meter?.dispose()
  }
}

// --------------------------------------------------------------- voice ----

const bufferIds = new WeakMap<AudioBuffer, number>()
let nextBufferId = 1
function bufferId(b: AudioBuffer): number {
  let id = bufferIds.get(b)
  if (!id) bufferIds.set(b, (id = nextBufferId++))
  return id
}

const timingKey = (plan: VoicePlan, buffer: AudioBuffer): string => {
  const c = plan.clip
  return [c.trackId, plan.start, plan.end, c.start, c.in, c.speed, bufferId(buffer)].join('|')
}

const envelopeKey = (plan: VoicePlan): string => {
  const a = plan.clip.audio
  return JSON.stringify([plan.ramps, a.gain, a.mute, a.volumeKeyframes])
}

class Voice {
  readonly key: string
  private envKey: string
  private panValue: number
  private readonly source: AudioBufferSourceNode
  private readonly chain: EffectChain
  private readonly env: GainNode
  private readonly pan: StereoPannerNode
  readonly endCtx: number

  constructor(private readonly graph: MixGraph, plan: VoicePlan, buffer: AudioBuffer, bus: TrackBus, tBegin: number) {
    const ctx = graph.ctx
    const clip = plan.clip
    this.key = timingKey(plan, buffer)
    this.envKey = envelopeKey(plan)
    this.source = ctx.createBufferSource()
    this.source.buffer = buffer
    this.source.playbackRate.value = clip.speed * graph.rate
    this.chain = new EffectChain(ctx)
    this.chain.set(clip.audio.effects ?? [])
    this.env = ctx.createGain()
    this.pan = ctx.createStereoPanner()
    this.panValue = Math.max(-1, Math.min(1, clip.audio.pan || 0))
    this.pan.pan.value = this.panValue
    this.source.connect(this.chain.input)
    this.chain.output.connect(this.env).connect(this.pan).connect(bus.input)

    this.scheduleEnvelope(plan, tBegin, false)
    const offset = Math.max(0, clip.in + (tBegin - clip.start) * clip.speed)
    this.endCtx = graph.toCtx(plan.end)
    this.source.start(graph.toCtx(tBegin), offset)
    this.source.stop(this.endCtx)
  }

  private scheduleEnvelope(plan: VoicePlan, tFrom: number, live: boolean): void {
    const g = this.graph
    const param = this.env.gain
    const pts = envelopePoints(plan, tFrom, plan.end)
    if (live) {
      // Hold whatever is playing now, then glide into the new envelope over 20 ms.
      param.cancelAndHoldAtTime(g.toCtx(tFrom - 0.02 * g.rate))
    } else {
      param.value = pts[0].v
      param.setValueAtTime(pts[0].v, g.toCtx(pts[0].t))
    }
    for (let i = live ? 0 : 1; i < pts.length; i++) param.linearRampToValueAtTime(pts[i].v, g.toCtx(pts[i].t))
  }

  /** Applies envelope, pan and effect changes that don't affect timing. */
  refresh(plan: VoicePlan, tFloor: number): void {
    const a = plan.clip.audio
    const envKey = envelopeKey(plan)
    if (envKey !== this.envKey) {
      this.envKey = envKey
      const tFrom = Math.max(tFloor + 0.02 * this.graph.rate, plan.start)
      if (tFrom < plan.end) this.scheduleEnvelope(plan, tFrom, true)
    }
    const pan = Math.max(-1, Math.min(1, a.pan || 0))
    if (pan !== this.panValue) glide(this.graph.ctx, this.pan.pan, (this.panValue = pan), this.graph.toCtx(tFloor))
    this.chain.set(a.effects ?? [])
  }

  /** Fades out quickly from context time `at` and stops. */
  retire(at: number): void {
    const ctx = this.graph.ctx
    if (isOffline(ctx) || at >= this.endCtx) {
      this.dispose()
      return
    }
    this.env.gain.cancelAndHoldAtTime(at)
    this.env.gain.linearRampToValueAtTime(0, at + 0.015)
    this.source.stop(at + 0.02)
    setTimeout(() => this.dispose(), Math.max(0, (at - ctx.currentTime) * 1000) + 100)
  }

  dispose(): void {
    try {
      this.source.stop()
    } catch {
      /* not started */
    }
    safeDisconnect(this.source)
    this.chain.dispose()
    safeDisconnect(this.env)
    safeDisconnect(this.pan)
  }
}

// ----------------------------------------------------------- mix graph ----

export class MixGraph {
  readonly ctx: BaseAudioContext
  readonly from: number
  readonly ctxStart: number
  readonly rate: number
  readonly meter: StereoMeter | null
  private readonly master: GainNode
  private readonly opts: MixGraphOptions
  private readonly buses = new Map<string, TrackBus>()
  private readonly voices = new Map<string, Voice>()
  private masterLevel = -1
  private planned: { project: Project; plans: VoicePlan[] } | null = null

  constructor(ctx: BaseAudioContext, opts: MixGraphOptions) {
    this.ctx = ctx
    this.opts = opts
    this.from = opts.from
    this.ctxStart = opts.ctxStart
    this.rate = opts.rate
    this.master = ctx.createGain()
    this.master.connect(opts.destination)
    this.meter = opts.metering ? new StereoMeter(ctx) : null
    if (this.meter) this.master.connect(this.meter.input)
  }

  toCtx(t: number): number {
    return this.ctxStart + (t - this.from) / this.rate
  }

  toTimeline(ctxTime: number): number {
    return this.from + (ctxTime - this.ctxStart) * this.rate
  }

  trackMeter(trackId: string): [number, number] {
    return this.buses.get(trackId)?.meter?.peak() ?? [0, 0]
  }

  private plans(project: Project): VoicePlan[] {
    if (this.planned?.project !== project) this.planned = { project, plans: planVoices(project) }
    return this.planned.plans
  }

  sync(project: Project, ctxFloor: number): void {
    const solo = anySolo(project)
    const master = Math.max(0, project.masterGain ?? 1)
    if (master !== this.masterLevel) glide(this.ctx, this.master.gain, master, ctxFloor, this.masterLevel < 0)
    this.masterLevel = master

    const seen = new Set<string>()
    for (const track of project.tracks) {
      if (track.kind !== 'audio') continue
      seen.add(track.id)
      let bus = this.buses.get(track.id)
      if (!bus) {
        bus = new TrackBus(this.ctx, this.master, this.opts.metering)
        this.buses.set(track.id, bus)
      }
      bus.apply(track, solo, ctxFloor)
    }
    for (const [id, bus] of this.buses) {
      if (!seen.has(id)) {
        bus.dispose()
        this.buses.delete(id)
      }
    }

    if (this.rate <= 0) return
    const tFloor = this.toTimeline(ctxFloor)
    const horizon = this.toTimeline(ctxFloor + this.opts.lookahead)
    const media = new Map(project.media.map((m) => [m.id, m]))
    const live = new Set<string>()

    for (const plan of this.plans(project)) {
      const clip = plan.clip
      const existing = this.voices.get(clip.id)
      const item = media.get(clip.mediaId!)
      const buffer = item ? this.opts.lookup(item) : null
      if (existing) {
        if (buffer && existing.key === timingKey(plan, buffer)) {
          live.add(clip.id)
          existing.refresh(plan, tFloor)
          continue
        }
        existing.retire(ctxFloor)
        this.voices.delete(clip.id)
      }
      if (!buffer || plan.start >= horizon || plan.end <= tFloor) continue
      const tBegin = Math.max(plan.start, tFloor)
      if (clip.in + (tBegin - clip.start) * clip.speed >= buffer.duration) continue
      const bus = this.buses.get(clip.trackId)
      if (!bus) continue
      this.voices.set(clip.id, new Voice(this, plan, buffer, bus, tBegin))
      live.add(clip.id)
    }

    for (const [id, voice] of this.voices) {
      if (!live.has(id)) {
        voice.retire(ctxFloor)
        this.voices.delete(id)
      } else if (voice.endCtx < ctxFloor - 0.5) {
        voice.dispose()
        this.voices.delete(id)
      }
    }
  }

  /** Stops everything with a short fade (realtime) and releases the nodes. */
  dispose(): void {
    const ctx = this.ctx
    const release = (): void => {
      this.voices.forEach((v) => v.dispose())
      this.voices.clear()
      this.buses.forEach((b) => b.dispose())
      this.buses.clear()
      safeDisconnect(this.master)
      this.meter?.dispose()
    }
    if (isOffline(ctx)) return release()
    const now = ctx.currentTime
    this.master.gain.cancelAndHoldAtTime(now)
    this.master.gain.linearRampToValueAtTime(0, now + 0.02)
    setTimeout(release, 60)
  }
}
