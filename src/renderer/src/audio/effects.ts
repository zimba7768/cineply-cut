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

type Params = Record<string, number | string | boolean>
type Instance = ReturnType<AudioEffectDef['build']>

// ------------------------------------------------------------- helpers ----

export const dbToGain = (db: number): number => Math.pow(10, db / 20)
export const gainToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : -Infinity)

function num(p: Params, key: string, fallback: number): number {
  const v = Number(p[key])
  return Number.isFinite(v) ? v : fallback
}

const initialized = new WeakSet<AudioParam>()

/**
 * Sets an AudioParam: the first call (while building) sets it outright, later calls (live slider
 * changes) glide there to avoid zipper noise. Offline renders always set values outright.
 */
function setParam(param: AudioParam, v: number, ctx: BaseAudioContext): void {
  if (!Number.isFinite(v)) return
  if (!initialized.has(param) || ctx instanceof OfflineAudioContext) {
    initialized.add(param)
    param.value = v
    return
  }
  param.cancelScheduledValues(ctx.currentTime)
  param.setTargetAtTime(v, ctx.currentTime, 0.015)
}

/** Keeps a filter frequency safely below Nyquist. */
const freq = (ctx: BaseAudioContext, f: number): number => Math.min(Math.max(10, f), ctx.sampleRate * 0.45)

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, frequency: number, q = 0, gainDb = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq(ctx, frequency)
  f.Q.value = q
  f.gain.value = gainDb
  return f
}

function gainNode(ctx: BaseAudioContext, v = 1): GainNode {
  const g = ctx.createGain()
  g.gain.value = v
  return g
}

/** Connects nodes in series and returns the first and last. */
function series(...nodes: AudioNode[]): { input: AudioNode; output: AudioNode } {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1])
  return { input: nodes[0], output: nodes[nodes.length - 1] }
}

function shaper(ctx: BaseAudioContext, fn: (x: number) => number, size = 2049): WaveShaperNode {
  const ws = ctx.createWaveShaper()
  ws.curve = makeCurve(fn, size)
  return ws
}

function makeCurve(fn: (x: number) => number, size = 2049): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size)
  for (let i = 0; i < size; i++) curve[i] = fn((i / (size - 1)) * 2 - 1)
  return curve
}

/**
 * Chromium's DynamicsCompressorNode adds automatic makeup gain, (1 / gain at 0 dBFS)^0.6. This returns
 * that boost in dB so we can cancel it and keep the "makeup" knob honest.
 */
function autoMakeupDb(threshold: number, ratio: number): number {
  // Hard-knee estimate; a soft knee changes it by under ~1.5 dB.
  const outAt0 = threshold - threshold / Math.max(1, ratio)
  return Math.max(0, -outAt0) * 0.6
}

/** Dry/wet pair with equal-power crossfade. */
function wetDry(ctx: BaseAudioContext, mix: number): { dry: GainNode; wet: GainNode; set(mix: number): void } {
  const dry = gainNode(ctx)
  const wet = gainNode(ctx)
  const set = (m: number): void => {
    const x = Math.min(1, Math.max(0, m))
    setParam(dry.gain, Math.cos((x * Math.PI) / 2), ctx)
    setParam(wet.gain, Math.sin((x * Math.PI) / 2), ctx)
  }
  set(mix)
  return { dry, wet, set }
}

/**
 * Envelope follower driving a VCA: input → mono → |x| → one-pole smoothing → curve(level) → vca.gain.
 * The VCA's own gain is 0, so the control signal *is* the gain. Used by the noise gate and de-esser.
 */
function sidechain(ctx: BaseAudioContext, detectIn: AudioNode, vca: GainNode, smoothingMs: number, curve: (levelDb: number) => number) {
  const mono = ctx.createGain()
  mono.channelCount = 1
  mono.channelCountMode = 'explicit'
  mono.channelInterpretation = 'speakers'
  const rect = shaper(ctx, (x) => Math.abs(x))
  const map = ctx.createWaveShaper()
  // The smoothed |x| of a sine is 2/π of its peak; report levels as peak dBFS.
  const setCurve = (fn: (levelDb: number) => number): void => {
    map.curve = makeCurve((x) => fn(20 * Math.log10(Math.max(1e-6, x * (Math.PI / 2)))), 4097)
  }
  const onePole = (ms: number): IIRFilterNode => {
    const a = Math.exp(-1 / (Math.max(0.5, ms) / 1000 * ctx.sampleRate))
    return ctx.createIIRFilter([1 - a], [1, -a])
  }
  let smooth = onePole(smoothingMs)
  setCurve(curve)
  vca.gain.value = 0
  detectIn.connect(mono)
  mono.connect(rect)
  rect.connect(smooth)
  smooth.connect(map)
  map.connect(vca.gain)
  return {
    setCurve,
    setSmoothing(ms: number): void {
      rect.disconnect(smooth)
      smooth.disconnect()
      smooth = onePole(ms)
      rect.connect(smooth)
      smooth.connect(map)
    }
  }
}

/** Deterministic PRNG so generated impulses are identical in preview and export. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const impulseCache = new Map<string, { sampleRate: number; channels: Float32Array<ArrayBuffer>[] }>()

/** Stereo reverb impulse: decorrelated noise with an RT60 decay, HF damping over time and early reflections. */
function reverbImpulse(ctx: BaseAudioContext, size: number, decay: number): AudioBuffer {
  const sr = ctx.sampleRate
  const key = `${sr}|${size.toFixed(3)}|${decay.toFixed(3)}`
  let data = impulseCache.get(key)
  if (!data) {
    const preDelay = 0.005 + size * 0.045
    const length = Math.ceil(sr * Math.min(10, preDelay + decay * 1.1))
    const channels = [new Float32Array(length), new Float32Array(length)]
    channels.forEach((ch, c) => {
      const rnd = mulberry32(0x5eed + c * 7919)
      let lp = 0
      for (let i = Math.floor(preDelay * sr); i < length; i++) {
        const t = i / sr - preDelay
        const env = Math.pow(10, (-3 * t) / decay)
        const damp = Math.max(0.08, 0.9 - (t / decay) * (1 - size * 0.5))
        lp += ((rnd() * 2 - 1) - lp) * damp
        ch[i] = lp * env
      }
      // A handful of early reflections, spaced by room size.
      const taps = 6 + Math.round(size * 10)
      for (let k = 0; k < taps; k++) {
        const t = preDelay * (0.3 + rnd() * 1.7) + size * 0.06 * rnd()
        const i = Math.floor(t * sr)
        if (i < length) ch[i] += (rnd() < 0.5 ? -1 : 1) * (0.7 - (0.5 * k) / taps)
      }
    })
    data = { sampleRate: sr, channels }
    if (impulseCache.size > 24) impulseCache.delete(impulseCache.keys().next().value!)
    impulseCache.set(key, data)
  }
  const buf = ctx.createBuffer(2, data.channels[0].length, sr)
  data.channels.forEach((ch, c) => buf.copyToChannel(ch, c))
  return buf
}

// ------------------------------------------------------------- effects ----

const eq: AudioEffectDef = {
  type: 'eq',
  name: 'Parametric EQ',
  category: 'EQ & Filter',
  params: [
    { key: 'hpFreq', label: 'High-pass', type: 'number', default: 20, min: 20, max: 1000, step: 1, unit: 'Hz', scale: 'log' },
    { key: 'lowFreq', label: 'Low freq', type: 'number', default: 120, min: 30, max: 1000, step: 1, unit: 'Hz', scale: 'log' },
    { key: 'lowGain', label: 'Low gain', type: 'number', default: 0, min: -24, max: 24, step: 0.5, unit: 'dB' },
    { key: 'midFreq', label: 'Mid freq', type: 'number', default: 1000, min: 150, max: 10000, step: 10, unit: 'Hz', scale: 'log' },
    { key: 'midGain', label: 'Mid gain', type: 'number', default: 0, min: -24, max: 24, step: 0.5, unit: 'dB' },
    { key: 'midQ', label: 'Mid Q', type: 'number', default: 1, min: 0.1, max: 12, step: 0.1 },
    { key: 'highFreq', label: 'High freq', type: 'number', default: 8000, min: 1000, max: 18000, step: 10, unit: 'Hz', scale: 'log' },
    { key: 'highGain', label: 'High gain', type: 'number', default: 0, min: -24, max: 24, step: 0.5, unit: 'dB' },
    { key: 'lpFreq', label: 'Low-pass', type: 'number', default: 20000, min: 1000, max: 20000, step: 10, unit: 'Hz', scale: 'log' }
  ],
  build(ctx, p) {
    const hp = biquad(ctx, 'highpass', 20, -3.01)
    const low = biquad(ctx, 'lowshelf', 120)
    const mid = biquad(ctx, 'peaking', 1000, 1)
    const high = biquad(ctx, 'highshelf', 8000)
    const lp = biquad(ctx, 'lowpass', 20000, -3.01)
    const update = (q: Params): void => {
      setParam(hp.frequency, freq(ctx, num(q, 'hpFreq', 20)), ctx)
      setParam(low.frequency, freq(ctx, num(q, 'lowFreq', 120)), ctx)
      setParam(low.gain, num(q, 'lowGain', 0), ctx)
      setParam(mid.frequency, freq(ctx, num(q, 'midFreq', 1000)), ctx)
      setParam(mid.gain, num(q, 'midGain', 0), ctx)
      setParam(mid.Q, Math.max(0.05, num(q, 'midQ', 1)), ctx)
      setParam(high.frequency, freq(ctx, num(q, 'highFreq', 8000)), ctx)
      setParam(high.gain, num(q, 'highGain', 0), ctx)
      setParam(lp.frequency, freq(ctx, num(q, 'lpFreq', 20000)), ctx)
    }
    update(p)
    return { ...series(hp, low, mid, high, lp), update }
  }
}

function passFilter(type: 'highpass' | 'lowpass', name: string, def: number): AudioEffectDef {
  return {
    type,
    name,
    category: 'EQ & Filter',
    params: [
      { key: 'frequency', label: 'Frequency', type: 'number', default: def, min: 20, max: 20000, step: 1, unit: 'Hz', scale: 'log' },
      { key: 'resonance', label: 'Resonance', type: 'number', default: -3, min: -12, max: 18, step: 0.5, unit: 'dB' }
    ],
    build(ctx, p) {
      const f = biquad(ctx, type, def, -3)
      const update = (q: Params): void => {
        setParam(f.frequency, freq(ctx, num(q, 'frequency', def)), ctx)
        setParam(f.Q, num(q, 'resonance', -3), ctx)
      }
      update(p)
      return { input: f, output: f, update }
    }
  }
}

const compressor: AudioEffectDef = {
  type: 'compressor',
  name: 'Compressor',
  category: 'Dynamics',
  params: [
    { key: 'threshold', label: 'Threshold', type: 'number', default: -24, min: -60, max: 0, step: 0.5, unit: 'dB' },
    { key: 'ratio', label: 'Ratio', type: 'number', default: 4, min: 1, max: 20, step: 0.1, unit: ':1' },
    { key: 'attack', label: 'Attack', type: 'number', default: 5, min: 0, max: 200, step: 0.5, unit: 'ms' },
    { key: 'release', label: 'Release', type: 'number', default: 150, min: 10, max: 1000, step: 1, unit: 'ms' },
    { key: 'knee', label: 'Knee', type: 'number', default: 6, min: 0, max: 40, step: 0.5, unit: 'dB' },
    { key: 'makeup', label: 'Makeup', type: 'number', default: 0, min: -12, max: 24, step: 0.5, unit: 'dB' }
  ],
  build(ctx, p) {
    const comp = ctx.createDynamicsCompressor()
    const out = gainNode(ctx)
    comp.connect(out)
    const update = (q: Params): void => {
      const threshold = num(q, 'threshold', -24)
      const ratio = num(q, 'ratio', 4)
      const knee = num(q, 'knee', 6)
      setParam(comp.threshold, threshold, ctx)
      setParam(comp.ratio, ratio, ctx)
      setParam(comp.knee, knee, ctx)
      setParam(comp.attack, num(q, 'attack', 5) / 1000, ctx)
      setParam(comp.release, num(q, 'release', 150) / 1000, ctx)
      setParam(out.gain, dbToGain(num(q, 'makeup', 0) - autoMakeupDb(threshold, ratio)), ctx)
    }
    update(p)
    return { input: comp, output: out, update }
  }
}

const limiter: AudioEffectDef = {
  type: 'limiter',
  name: 'Limiter',
  category: 'Dynamics',
  params: [
    { key: 'drive', label: 'Input gain', type: 'number', default: 0, min: 0, max: 24, step: 0.5, unit: 'dB' },
    { key: 'ceiling', label: 'Ceiling', type: 'number', default: -1, min: -24, max: 0, step: 0.1, unit: 'dB' },
    { key: 'release', label: 'Release', type: 'number', default: 80, min: 5, max: 1000, step: 1, unit: 'ms' }
  ],
  build(ctx, p) {
    const drive = gainNode(ctx)
    const comp = ctx.createDynamicsCompressor()
    comp.knee.value = 0
    comp.ratio.value = 20
    comp.attack.value = 0.001
    const trim = gainNode(ctx)
    // Catches the few samples the compressor's attack lets through.
    const clip = ctx.createWaveShaper()
    const update = (q: Params): void => {
      const ceiling = num(q, 'ceiling', -1)
      setParam(drive.gain, dbToGain(num(q, 'drive', 0)), ctx)
      setParam(comp.threshold, ceiling, ctx)
      setParam(comp.release, num(q, 'release', 80) / 1000, ctx)
      setParam(trim.gain, dbToGain(-autoMakeupDb(ceiling, 20)), ctx)
      const c = dbToGain(ceiling)
      clip.curve = makeCurve((x) => Math.max(-c, Math.min(c, x)))
    }
    update(p)
    return { ...series(drive, comp, trim, clip), update }
  }
}

const noiseGate: AudioEffectDef = {
  type: 'noiseGate',
  name: 'Noise Gate',
  category: 'Dynamics',
  params: [
    { key: 'threshold', label: 'Threshold', type: 'number', default: -45, min: -80, max: 0, step: 0.5, unit: 'dB' },
    { key: 'range', label: 'Reduction', type: 'number', default: -40, min: -80, max: 0, step: 1, unit: 'dB' },
    { key: 'response', label: 'Response', type: 'number', default: 40, min: 2, max: 500, step: 1, unit: 'ms' }
  ],
  build(ctx, p) {
    const input = gainNode(ctx)
    const vca = gainNode(ctx, 0)
    input.connect(vca)
    const gateCurve = (q: Params) => {
      const thr = num(q, 'threshold', -45)
      const floor = dbToGain(num(q, 'range', -40))
      return (level: number): number => {
        // Opens smoothly over the 6 dB below the threshold.
        const x = Math.min(1, Math.max(0, (level - (thr - 6)) / 6))
        const s = x * x * (3 - 2 * x)
        return floor + (1 - floor) * s
      }
    }
    const sc = sidechain(ctx, input, vca, num(p, 'response', 40), gateCurve(p))
    let response = num(p, 'response', 40)
    return {
      input,
      output: vca,
      update(q) {
        sc.setCurve(gateCurve(q))
        const r = num(q, 'response', 40)
        if (r !== response) sc.setSmoothing((response = r))
      }
    }
  }
}

const deesser: AudioEffectDef = {
  type: 'deesser',
  name: 'De-esser',
  category: 'Dynamics',
  params: [
    { key: 'frequency', label: 'Frequency', type: 'number', default: 6000, min: 2500, max: 12000, step: 50, unit: 'Hz', scale: 'log' },
    { key: 'threshold', label: 'Threshold', type: 'number', default: -30, min: -60, max: 0, step: 0.5, unit: 'dB' },
    { key: 'reduction', label: 'Max reduction', type: 'number', default: 10, min: 0, max: 30, step: 0.5, unit: 'dB' }
  ],
  build(ctx, p) {
    // Linkwitz-Riley split: LP − HP sums flat, so only the ducked high band changes the sound.
    const input = gainNode(ctx)
    const lowBand = biquad(ctx, 'lowpass', 6000, -6.02)
    const highBand = biquad(ctx, 'highpass', 6000, -6.02)
    const vca = gainNode(ctx, 0)
    const output = gainNode(ctx)
    input.connect(lowBand).connect(output)
    input.connect(highBand).connect(vca).connect(output)
    const duck = (q: Params) => {
      const thr = num(q, 'threshold', -30)
      const maxRed = num(q, 'reduction', 10)
      return (level: number): number => -dbToGain(-Math.min(maxRed, Math.max(0, (level - thr) * 0.75)))
    }
    const sc = sidechain(ctx, highBand, vca, 8, duck(p))
    const update = (q: Params): void => {
      const f = freq(ctx, num(q, 'frequency', 6000))
      setParam(lowBand.frequency, f, ctx)
      setParam(highBand.frequency, f, ctx)
      sc.setCurve(duck(q))
    }
    update(p)
    return { input, output, update }
  }
}

const reverb: AudioEffectDef = {
  type: 'reverb',
  name: 'Reverb',
  category: 'Time & Space',
  params: [
    { key: 'size', label: 'Room size', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'decay', label: 'Decay', type: 'number', default: 1.8, min: 0.2, max: 8, step: 0.1, unit: 's' },
    { key: 'mix', label: 'Wet/dry', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01 }
  ],
  build(ctx, p) {
    const input = gainNode(ctx)
    const output = gainNode(ctx)
    const conv = ctx.createConvolver()
    const mix = wetDry(ctx, num(p, 'mix', 0.3))
    input.connect(mix.dry).connect(output)
    input.connect(conv).connect(mix.wet).connect(output)
    let shape = ''
    const update = (q: Params): void => {
      const size = Math.min(1, Math.max(0, num(q, 'size', 0.5)))
      const decay = Math.min(8, Math.max(0.2, num(q, 'decay', 1.8)))
      const key = `${size}|${decay}`
      if (key !== shape) {
        shape = key
        conv.buffer = reverbImpulse(ctx, size, decay)
      }
      mix.set(num(q, 'mix', 0.3))
    }
    update(p)
    return { input, output, update }
  }
}

const delay: AudioEffectDef = {
  type: 'delay',
  name: 'Delay / Echo',
  category: 'Time & Space',
  params: [
    { key: 'time', label: 'Time', type: 'number', default: 350, min: 10, max: 2000, step: 1, unit: 'ms' },
    { key: 'feedback', label: 'Feedback', type: 'number', default: 0.35, min: 0, max: 0.95, step: 0.01 },
    { key: 'tone', label: 'Tone', type: 'number', default: 6000, min: 500, max: 20000, step: 10, unit: 'Hz', scale: 'log' },
    { key: 'mix', label: 'Wet/dry', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01 }
  ],
  build(ctx, p) {
    const input = gainNode(ctx)
    const output = gainNode(ctx)
    const line = ctx.createDelay(2.5)
    const tone = biquad(ctx, 'lowpass', 6000, -3.01)
    const fb = gainNode(ctx)
    const mix = wetDry(ctx, num(p, 'mix', 0.3))
    input.connect(mix.dry).connect(output)
    input.connect(line).connect(tone)
    tone.connect(fb).connect(line)
    tone.connect(mix.wet).connect(output)
    const update = (q: Params): void => {
      setParam(line.delayTime, Math.min(2.4, Math.max(0.01, num(q, 'time', 350) / 1000)), ctx)
      setParam(fb.gain, Math.min(0.95, Math.max(0, num(q, 'feedback', 0.35))), ctx)
      setParam(tone.frequency, freq(ctx, num(q, 'tone', 6000)), ctx)
      mix.set(num(q, 'mix', 0.3))
    }
    update(p)
    return { input, output, update }
  }
}

const gain: AudioEffectDef = {
  type: 'gain',
  name: 'Gain',
  category: 'Utility',
  params: [
    { key: 'gain', label: 'Gain', type: 'number', default: 0, min: -48, max: 24, step: 0.5, unit: 'dB' },
    { key: 'invert', label: 'Invert polarity', type: 'boolean', default: false }
  ],
  build(ctx, p) {
    const g = gainNode(ctx)
    const update = (q: Params): void => setParam(g.gain, dbToGain(num(q, 'gain', 0)) * (q.invert ? -1 : 1), ctx)
    update(p)
    return { input: g, output: g, update }
  }
}

const stereoWidth: AudioEffectDef = {
  type: 'stereoWidth',
  name: 'Stereo Width',
  category: 'Utility',
  params: [{ key: 'width', label: 'Width', type: 'number', default: 1.4, min: 0, max: 2, step: 0.01 }],
  build(ctx, p) {
    // Mid/side: L' = aL + bR, R' = bL + aR with a = (1+w)/2, b = (1-w)/2. w = 0 → mono, 1 → unchanged.
    const input = ctx.createGain()
    input.channelCount = 2
    input.channelCountMode = 'explicit'
    const split = ctx.createChannelSplitter(2)
    const merge = ctx.createChannelMerger(2)
    const ll = gainNode(ctx)
    const rl = gainNode(ctx)
    const lr = gainNode(ctx)
    const rr = gainNode(ctx)
    input.connect(split)
    split.connect(ll, 0).connect(merge, 0, 0)
    split.connect(rl, 1).connect(merge, 0, 0)
    split.connect(lr, 0).connect(merge, 0, 1)
    split.connect(rr, 1).connect(merge, 0, 1)
    const update = (q: Params): void => {
      const w = Math.min(2, Math.max(0, num(q, 'width', 1.4)))
      const a = (1 + w) / 2
      const b = (1 - w) / 2
      setParam(ll.gain, a, ctx)
      setParam(rr.gain, a, ctx)
      setParam(rl.gain, b, ctx)
      setParam(lr.gain, b, ctx)
    }
    update(p)
    return { input, output: merge, update }
  }
}

const bassBoost: AudioEffectDef = {
  type: 'bassBoost',
  name: 'Bass Boost',
  category: 'EQ & Filter',
  params: [
    { key: 'boost', label: 'Boost', type: 'number', default: 6, min: 0, max: 18, step: 0.5, unit: 'dB' },
    { key: 'frequency', label: 'Frequency', type: 'number', default: 100, min: 40, max: 300, step: 1, unit: 'Hz', scale: 'log' }
  ],
  build(ctx, p) {
    const rumble = biquad(ctx, 'highpass', 25, -3.01)
    const shelf = biquad(ctx, 'lowshelf', 100)
    const update = (q: Params): void => {
      setParam(shelf.frequency, num(q, 'frequency', 100), ctx)
      setParam(shelf.gain, num(q, 'boost', 6), ctx)
    }
    update(p)
    return { ...series(rumble, shelf), update }
  }
}

const RADIO_PRESETS: Record<string, { low: number; high: number; peak: number; drive: number }> = {
  telephone: { low: 300, high: 3400, peak: 1500, drive: 0.15 },
  radio: { low: 200, high: 4500, peak: 1200, drive: 0.25 },
  megaphone: { low: 600, high: 3000, peak: 1800, drive: 0.6 },
  walkie: { low: 450, high: 2600, peak: 1400, drive: 0.45 }
}

const telephone: AudioEffectDef = {
  type: 'telephone',
  name: 'Telephone / Radio',
  category: 'EQ & Filter',
  params: [
    {
      key: 'preset', label: 'Character', type: 'select', default: 'telephone',
      options: [
        { value: 'telephone', label: 'Telephone' }, { value: 'radio', label: 'AM radio' },
        { value: 'megaphone', label: 'Megaphone' }, { value: 'walkie', label: 'Walkie-talkie' }
      ]
    },
    { key: 'drive', label: 'Distortion', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01 }
  ],
  build(ctx, p) {
    const hp1 = biquad(ctx, 'highpass', 300, -3.01)
    const hp2 = biquad(ctx, 'highpass', 300, -3.01)
    const peak = biquad(ctx, 'peaking', 1500, 1.2, 6)
    const lp1 = biquad(ctx, 'lowpass', 3400, -3.01)
    const lp2 = biquad(ctx, 'lowpass', 3400, -3.01)
    const drive = ctx.createWaveShaper()
    drive.oversample = '2x'
    const out = gainNode(ctx, 0.5)
    const update = (q: Params): void => {
      const pr = RADIO_PRESETS[String(q.preset)] ?? RADIO_PRESETS.telephone
      for (const f of [hp1, hp2]) setParam(f.frequency, pr.low, ctx)
      for (const f of [lp1, lp2]) setParam(f.frequency, freq(ctx, pr.high), ctx)
      setParam(peak.frequency, pr.peak, ctx)
      const k = 1 + 30 * Math.min(1, Math.max(0, num(q, 'drive', 0.3) + pr.drive) ** 2)
      drive.curve = makeCurve((x) => Math.tanh(k * x) / Math.tanh(k))
    }
    update(p)
    return { ...series(hp1, hp2, peak, drive, lp1, lp2, out), update }
  }
}

export const AUDIO_EFFECTS: AudioEffectDef[] = [
  eq,
  passFilter('highpass', 'High-pass Filter', 80),
  passFilter('lowpass', 'Low-pass Filter', 8000),
  bassBoost,
  telephone,
  compressor,
  limiter,
  noiseGate,
  deesser,
  reverb,
  delay,
  gain,
  stereoWidth
]

export function getAudioEffect(type: string): AudioEffectDef | undefined {
  return AUDIO_EFFECTS.find((e) => e.type === type)
}

export type AudioEffectInstance = Instance
