import type { MediaItem } from '@shared/types'
import { useProject } from '@/store/project'
import { decodeMedia } from './decode'

/**
 * Waveform peaks for timeline drawing.
 * drawWaveform draws the portion [sourceStart, sourceEnd] (seconds of media) of mediaId into the rect.
 * Peaks load asynchronously; subscribe with onPeaksReady to repaint when they arrive.
 */

const PEAKS_PER_SECOND = 200
const REDUCTION = 4 // each coarser level merges 4 peaks
const CHUNK_SAMPLES = 1 << 20

/** Min/max pairs at several resolutions: level 0 = 200 peaks/s, level n = 200 / 4^n. */
interface Peaks {
  rate: number[]
  min: Float32Array[]
  max: Float32Array[]
}

const listeners = new Set<() => void>()
const peaks = new Map<string, Peaks | null>()
const pending = new Set<string>()

export function onPeaksReady(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

const keyOf = (m: MediaItem): string => m.playbackPath ?? m.path

/** Yields to the event loop so long computations don't block input and painting. */
const idle = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 50 })
    else setTimeout(resolve, 0)
  })

async function computePeaks(buffer: AudioBuffer): Promise<Peaks> {
  const spp = buffer.sampleRate / PEAKS_PER_SECOND
  const n = Math.max(1, Math.ceil(buffer.length / spp))
  const min = new Float32Array(n)
  const max = new Float32Array(n)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  for (let start = 0; start < n; ) {
    const end = Math.min(n, start + Math.ceil(CHUNK_SAMPLES / spp))
    for (let i = start; i < end; i++) {
      const s0 = Math.floor(i * spp)
      const s1 = Math.min(buffer.length, Math.floor((i + 1) * spp))
      let lo = 0
      let hi = 0
      for (const data of channels) {
        for (let s = s0; s < s1; s++) {
          const v = data[s]
          if (v < lo) lo = v
          else if (v > hi) hi = v
        }
      }
      min[i] = lo
      max[i] = hi
    }
    start = end
    if (start < n) await idle()
  }
  const result: Peaks = { rate: [PEAKS_PER_SECOND], min: [min], max: [max] }
  while (result.min[result.min.length - 1].length > 256) {
    const pmin = result.min[result.min.length - 1]
    const pmax = result.max[result.max.length - 1]
    const len = Math.ceil(pmin.length / REDUCTION)
    const cmin = new Float32Array(len)
    const cmax = new Float32Array(len)
    for (let i = 0; i < len; i++) {
      let lo = 0
      let hi = 0
      for (let j = i * REDUCTION; j < Math.min(pmin.length, (i + 1) * REDUCTION); j++) {
        if (pmin[j] < lo) lo = pmin[j]
        if (pmax[j] > hi) hi = pmax[j]
      }
      cmin[i] = lo
      cmax[i] = hi
    }
    result.rate.push(result.rate[result.rate.length - 1] / REDUCTION)
    result.min.push(cmin)
    result.max.push(cmax)
  }
  return result
}

function request(media: MediaItem, sampleRate: number): void {
  const key = keyOf(media)
  if (pending.has(key) || peaks.has(key) || media.status === 'transcoding') return
  pending.add(key)
  decodeMedia(media, sampleRate)
    .then((buf) => (buf ? computePeaks(buf) : null))
    .catch(() => null)
    .then((p) => {
      peaks.set(key, p)
      pending.delete(key)
      listeners.forEach((cb) => cb())
    })
}

/** Starts computing peaks for a media item (e.g. right after import) without drawing. */
export function preloadPeaks(media: MediaItem): void {
  request(media, useProject.getState().project.sequence.sampleRate || 48000)
}

/** True once peaks for the media are available (or known to be unavailable). */
export function peaksReady(mediaId: string): boolean {
  const media = useProject.getState().project.media.find((m) => m.id === mediaId)
  return !!media && peaks.has(keyOf(media))
}

export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  mediaId: string,
  sourceStart: number,
  sourceEnd: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  gain = 1
): void {
  if (w <= 0 || h <= 0 || !(sourceEnd > sourceStart)) return
  const project = useProject.getState().project
  const media = project.media.find((m) => m.id === mediaId)
  if (!media || !media.hasAudio) return
  const p = peaks.get(keyOf(media))
  if (p === undefined) {
    request(media, project.sequence.sampleRate || 48000)
    return
  }
  if (p === null) return

  // Only walk the columns that are actually visible on the canvas.
  const tf = ctx.getTransform()
  const sx = tf.a || 1
  const visLeft = (0 - tf.e) / sx
  const visRight = (ctx.canvas.width - tf.e) / sx
  const c0 = Math.max(0, Math.floor(visLeft - x))
  const c1 = Math.min(Math.ceil(w), Math.ceil(visRight - x))
  if (c1 <= c0) return

  const secPerPx = (sourceEnd - sourceStart) / w
  // Coarsest level that still has at least one peak per pixel.
  let level = 0
  while (level + 1 < p.rate.length && p.rate[level + 1] * secPerPx >= 1) level++
  const rate = p.rate[level]
  const min = p.min[level]
  const max = p.max[level]
  const mid = y + h / 2
  const half = h / 2
  const g = Math.max(0, gain)

  const top: number[] = []
  const bottom: number[] = []
  for (let c = c0; c < c1; c++) {
    const i0 = Math.floor((sourceStart + c * secPerPx) * rate)
    const i1 = Math.max(i0 + 1, Math.floor((sourceStart + (c + 1) * secPerPx) * rate))
    let lo = 0
    let hi = 0
    for (let i = Math.max(0, i0); i < Math.min(min.length, i1); i++) {
      if (min[i] < lo) lo = min[i]
      if (max[i] > hi) hi = max[i]
    }
    top.push(mid - Math.min(1, hi * g) * half)
    bottom.push(mid - Math.max(-1, lo * g) * half)
  }

  ctx.save()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x + c0, top[0])
  for (let k = 0; k < top.length; k++) ctx.lineTo(x + c0 + k + 0.5, Math.min(top[k], mid - 0.5))
  ctx.lineTo(x + c1, top[top.length - 1])
  ctx.lineTo(x + c1, bottom[bottom.length - 1])
  for (let k = bottom.length - 1; k >= 0; k--) ctx.lineTo(x + c0 + k + 0.5, Math.max(bottom[k], mid + 0.5))
  ctx.lineTo(x + c0, bottom[0])
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}
