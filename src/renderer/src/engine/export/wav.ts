// Minimal RIFF/WAVE writer: integer PCM (16/24-bit) or 32-bit float, interleaved.
// Long exports stream through `writeWavStream`, which patches the header sizes at the end.

export type WavBitDepth = 16 | 24 | 32

const HEADER_BYTES = 44

/** 44-byte canonical WAV header. `dataBytes` above 4 GiB is clamped (readers like ffmpeg then read to EOF). */
export function wavHeader(sampleRate: number, channels: number, bitDepth: WavBitDepth, dataBytes: number): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES)
  const v = new DataView(out.buffer)
  const bytesPerSample = bitDepth / 8
  const clamp = (n: number): number => Math.min(0xffffffff, n)
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  v.setUint32(4, clamp(36 + dataBytes), true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, bitDepth === 32 ? 3 : 1, true) // 3 = IEEE float, 1 = PCM
  v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * channels * bytesPerSample, true)
  v.setUint16(32, channels * bytesPerSample, true)
  v.setUint16(34, bitDepth, true)
  ascii(36, 'data')
  v.setUint32(40, clamp(dataBytes), true)
  return out
}

/** Interleaves and quantizes frames [from, to) of an AudioBuffer. */
export function encodePcm(buffer: AudioBuffer, bitDepth: WavBitDepth, from = 0, to = buffer.length): Uint8Array {
  const channels = buffer.numberOfChannels
  const frames = Math.max(0, to - from)
  const bytesPerSample = bitDepth / 8
  const out = new Uint8Array(frames * channels * bytesPerSample)
  const v = new DataView(out.buffer)
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let o = 0
  for (let i = from; i < to; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]))
      if (bitDepth === 16) {
        v.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
      } else if (bitDepth === 24) {
        const n = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff)
        out[o] = n & 0xff
        out[o + 1] = (n >> 8) & 0xff
        out[o + 2] = (n >> 16) & 0xff
      } else {
        v.setFloat32(o, s, true)
      }
      o += bytesPerSample
    }
  }
  return out
}

/** Whole-buffer WAV file in memory (short clips). */
export function encodeWav(buffer: AudioBuffer, bitDepth: WavBitDepth = 16): Uint8Array {
  const pcm = encodePcm(buffer, bitDepth)
  const out = new Uint8Array(HEADER_BYTES + pcm.byteLength)
  out.set(wavHeader(buffer.sampleRate, buffer.numberOfChannels, bitDepth, pcm.byteLength))
  out.set(pcm, HEADER_BYTES)
  return out
}

/**
 * Streams AudioBuffer chunks into a WAV file on disk through window.cineply.fs, so memory stays
 * flat for long mixes. All chunks must share sample rate and channel count.
 */
export async function writeWavStream(
  path: string,
  chunks: AsyncIterable<AudioBuffer>,
  bitDepth: WavBitDepth,
  onChunk?: (framesWritten: number) => void
): Promise<void> {
  const fs = window.cineply.fs
  const handle = await fs.openWrite(path)
  try {
    let position = HEADER_BYTES
    let frames = 0
    let format: { sampleRate: number; channels: number } | null = null
    await fs.write(handle, wavHeader(48000, 2, bitDepth, 0), 0)
    for await (const chunk of chunks) {
      format ??= { sampleRate: chunk.sampleRate, channels: chunk.numberOfChannels }
      const pcm = encodePcm(chunk, bitDepth)
      await fs.write(handle, pcm, position)
      position += pcm.byteLength
      frames += chunk.length
      onChunk?.(frames)
    }
    const f = format ?? { sampleRate: 48000, channels: 2 }
    await fs.write(handle, wavHeader(f.sampleRate, f.channels, bitDepth, position - HEADER_BYTES), 0)
  } finally {
    await fs.close(handle)
  }
}
