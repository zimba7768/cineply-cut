import type { MediaItem } from '@shared/types'

/**
 * Decoded audio cache. Each media file is decoded once per sample rate, with concurrent requests
 * sharing one load. Files Chromium can't decode, and very large video files (which would otherwise be
 * fetched whole), go through the main process ('audio:extract' → cached FLAC) first.
 */

const FETCH_LIMIT = 256 * 1024 * 1024
const MAX_PARALLEL = 2

type Entry = { promise: Promise<AudioBuffer | null>; buffer: AudioBuffer | null | undefined; error?: string }

const cache = new Map<string, Entry>()
const listeners = new Set<(mediaId: string) => void>()
const decoders = new Map<number, OfflineAudioContext>()
let running = 0
const waiting: (() => void)[] = []

const sourcePath = (m: MediaItem): string => m.playbackPath ?? m.path
const keyOf = (m: MediaItem, sampleRate: number): string => `${sourcePath(m)}|${sampleRate}`

/** Notified with the media id whenever a decode finishes (successfully or not). */
export function onDecoded(cb: (mediaId: string) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The decoded buffer if ready, null if decoding failed or the media has no audio, undefined while pending/unrequested. */
export function peekDecoded(media: MediaItem, sampleRate: number): AudioBuffer | null | undefined {
  if (!media.hasAudio) return null
  return cache.get(keyOf(media, sampleRate))?.buffer
}

/** Error message of a failed decode, if any. */
export function decodeError(media: MediaItem, sampleRate: number): string | undefined {
  return cache.get(keyOf(media, sampleRate))?.error
}

/** Decodes (or returns the cached decode of) a media item's audio at sampleRate. Resolves null on failure. */
export function decodeMedia(media: MediaItem, sampleRate: number): Promise<AudioBuffer | null> {
  if (!media.hasAudio || media.kind === 'image' || media.status === 'transcoding') return Promise.resolve(null)
  const key = keyOf(media, sampleRate)
  const hit = cache.get(key)
  if (hit) return hit.promise
  const entry: Entry = { buffer: undefined, promise: Promise.resolve(null) }
  entry.promise = withSlot(() => load(media, sampleRate))
    .then((buf) => {
      entry.buffer = buf
      return buf
    })
    .catch((err: unknown) => {
      entry.buffer = null
      entry.error = err instanceof Error ? err.message : String(err)
      console.warn(`[audio] could not decode ${media.name}:`, entry.error)
      return null
    })
    .finally(() => listeners.forEach((cb) => cb(media.id)))
  cache.set(key, entry)
  return entry.promise
}

/** Drops cached decodes for a path (e.g. after the file changed on disk). */
export function forgetDecoded(path: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${path}|`)) cache.delete(key)
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

function decoder(sampleRate: number): OfflineAudioContext {
  let ctx = decoders.get(sampleRate)
  if (!ctx) {
    ctx = new OfflineAudioContext(1, 1, sampleRate)
    decoders.set(sampleRate, ctx)
  }
  return ctx
}

async function decodeUrl(url: string, sampleRate: number): Promise<AudioBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.arrayBuffer()
  return decoder(sampleRate).decodeAudioData(data)
}

async function extracted(path: string, sampleRate: number): Promise<AudioBuffer> {
  const flac = await window.cineply.invoke<string>('audio:extract', path, sampleRate)
  return decodeUrl(window.cineply.mediaUrl(flac), sampleRate)
}

async function load(media: MediaItem, sampleRate: number): Promise<AudioBuffer> {
  const path = sourcePath(media)
  const size = await window.cineply.invoke<number>('audio:fileSize', path).catch(() => 0)
  if (media.hasVideo && size > FETCH_LIMIT) return extracted(media.path, sampleRate)
  try {
    return await decodeUrl(window.cineply.mediaUrl(path), sampleRate)
  } catch (err) {
    // Unusual codecs/containers: let ffmpeg convert the audio, then decode that.
    try {
      return await extracted(media.path, sampleRate)
    } catch {
      throw err
    }
  }
}
