import type { Project } from '@shared/types'
import { audioEngine } from '@/audio/engine'

// Long ranges are mixed in chunks so a one-hour export doesn't hold a 1.4 GB AudioBuffer.
// Each chunk after the first is rendered with a pre-roll that is then discarded, so reverb and
// delay tails and compressor state carry across chunk boundaries.
const CHUNK_SECONDS = 60
const PREROLL_SECONDS = 4

/** Total sample frames of the mix for [start, end). */
export function mixLength(project: Project, start: number, end: number): number {
  return Math.max(1, Math.round((end - start) * project.sequence.sampleRate))
}

/** Yields the offline mix of [start, end) as consecutive AudioBuffers totalling exactly mixLength() frames. */
export async function* mixChunks(project: Project, start: number, end: number, signal?: AbortSignal): AsyncGenerator<AudioBuffer> {
  const sr = project.sequence.sampleRate
  const total = mixLength(project, start, end)
  const chunk = CHUNK_SECONDS * sr
  for (let from = 0; from < total; from += chunk) {
    signal?.throwIfAborted()
    const frames = Math.min(chunk, total - from)
    const t0 = start + from / sr
    const pre = from === 0 ? 0 : Math.min(PREROLL_SECONDS, t0)
    const preFrames = Math.round(pre * sr)
    const rendered = await audioEngine.renderMix(project, t0 - preFrames / sr, t0 + frames / sr)
    yield slice(rendered, preFrames, frames, sr)
  }
}

/** Exactly `frames` frames of `buf` starting at `offset`, as a stereo buffer at `sampleRate` (zero padded). */
function slice(buf: AudioBuffer, offset: number, frames: number, sampleRate: number): AudioBuffer {
  if (offset === 0 && buf.length === frames && buf.sampleRate === sampleRate && buf.numberOfChannels === 2) return buf
  const out = new AudioBuffer({ length: frames, numberOfChannels: 2, sampleRate })
  for (let c = 0; c < 2; c++) {
    const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1))
    out.copyToChannel(src.subarray(offset, Math.min(src.length, offset + frames)), c)
  }
  return out
}
