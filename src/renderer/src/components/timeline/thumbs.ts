import { useEffect, useState } from 'react'

/**
 * Filmstrip thumbnail cache. Requests go to ffmpeg in the main process (which caches the JPEGs on
 * disk); here we keep the resulting URLs, run at most a few requests at once, serve the newest
 * (most likely visible) requests first, and skip requests nobody is waiting for any more.
 */

type Listener = (url: string | null) => void

interface Entry {
  path: string
  t: number
  w: number
  listeners: Set<Listener>
}

const MAX_ACTIVE = 3
const cache = new Map<string, string | null>()
const waiting = new Map<string, Entry>()
const queue: string[] = []
const inflight = new Set<string>()

const keyOf = (path: string, t: number, w: number): string => `${path}|${t.toFixed(2)}|${w}`

function pump(): void {
  while (inflight.size < MAX_ACTIVE && queue.length) {
    const key = queue.pop()!
    const entry = waiting.get(key)
    if (!entry) continue
    if (entry.listeners.size === 0) {
      waiting.delete(key)
      continue
    }
    inflight.add(key)
    window.cineply.media.thumbnail(entry.path, entry.t, entry.w)
      .then((p) => window.cineply.mediaUrl(p), () => null)
      .then((url) => {
        cache.set(key, url)
        inflight.delete(key)
        waiting.delete(key)
        for (const l of entry.listeners) l(url)
        pump()
      })
  }
}

/** Subscribes to the thumbnail of `path` at `t` seconds, `w` px wide. Calls back once with its URL (null on failure). */
export function subscribeThumb(path: string, t: number, w: number, cb: Listener): () => void {
  const key = keyOf(path, t, w)
  if (cache.has(key)) {
    cb(cache.get(key)!)
    return () => {}
  }
  let entry = waiting.get(key)
  if (!entry) {
    entry = { path, t, w, listeners: new Set() }
    waiting.set(key, entry)
  }
  if (!inflight.has(key)) {
    const i = queue.indexOf(key)
    if (i >= 0) queue.splice(i, 1)
    queue.push(key)
  }
  entry.listeners.add(cb)
  pump()
  const e = entry
  return () => {
    e.listeners.delete(cb)
  }
}

export function cachedThumb(path: string, t: number, w: number): string | null | undefined {
  return cache.get(keyOf(path, t, w))
}

export function useThumb(path: string, t: number, w: number): string | null | undefined {
  const [url, setUrl] = useState(() => cachedThumb(path, t, w))
  useEffect(() => {
    setUrl(cachedThumb(path, t, w))
    return subscribeThumb(path, t, w, setUrl)
  }, [path, t, w])
  return url
}

/** Source-time step for filmstrip frames: a power-of-two ladder so nearby zoom levels reuse thumbnails. */
export function thumbQuantum(secondsPerTile: number): number {
  let q = 1 / 8
  while (q * 2 <= secondsPerTile) q *= 2
  return q
}
