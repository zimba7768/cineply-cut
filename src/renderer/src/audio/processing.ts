import { replaceClipMedia, updateClip } from '@/lib/editing'
import { uid } from '@/lib/ids'
import { importFiles } from '@/lib/importMedia'
import { findClip, findMedia, useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { dbToGain } from './effects'

/** Mirrors src/main/audio.ts. */
export type DenoiseStrength = 'light' | 'medium' | 'strong'
export type HumRemoval = 'off' | '50' | '60'
export type NormalizeTarget = 'peak' | '-14' | '-16' | '-23'

export interface LoudnessResult {
  peakDb: number
  truePeakDb: number | null
  lufs: number | null
  meanDb: number
}

export const NORMALIZE_TARGETS: { value: NormalizeTarget; label: string }[] = [
  { value: 'peak', label: 'Peak −1 dBFS' },
  { value: '-14', label: '−14 LUFS (streaming)' },
  { value: '-16', label: '−16 LUFS (podcast)' },
  { value: '-23', label: '−23 LUFS (broadcast)' }
]

/** Runs a main-process ffmpeg job with progress in the jobs list. */
async function withJob<T>(label: string, duration: number, run: (jobId: string) => Promise<T>): Promise<T> {
  const ui = useUi.getState()
  const jobId = `audio-${uid()}`
  ui.upsertJob({ id: jobId, label, progress: 0, status: 'running', cancel: () => void window.cineply.ffmpeg.cancel(jobId) })
  const off = window.cineply.ffmpeg.onProgress((p) => {
    if (p.jobId === jobId && duration > 0) useUi.getState().upsertJob({ id: jobId, progress: Math.min(0.99, p.outTime / duration) })
  })
  try {
    const result = await run(jobId)
    useUi.getState().upsertJob({ id: jobId, progress: 1, status: 'done', cancel: undefined })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
    const cancelled = /cancel/i.test(message)
    useUi.getState().upsertJob({ id: jobId, status: cancelled ? 'cancelled' : 'error', error: message, cancel: undefined })
    throw new Error(message)
  } finally {
    off()
  }
}

/**
 * Noise reduction: ffmpeg writes a cleaned WAV into <mediaDir>/Processed, which is imported and
 * swapped into the clip (timing is kept; undoable).
 */
export async function denoiseClip(clipId: string, strength: DenoiseStrength, hum: HumRemoval): Promise<void> {
  const p = useProject.getState().project
  const clip = findClip(p, clipId)
  const media = findMedia(p, clip?.mediaId)
  if (!clip || !media) return
  try {
    const result = await withJob(`Denoise ${media.name}`, media.duration, (jobId) =>
      window.cineply.invoke<{ path: string; noiseFloorDb: number | null }>('audio:denoise', media.path, { strength, hum, jobId })
    )
    const [item] = await importFiles([result.path], { source: 'processed' })
    if (!item) throw new Error('Could not import the processed file')
    replaceClipMedia(clipId, item.id)
    useUi.getState().showToast(`Noise reduced (${strength}${hum === 'off' ? '' : `, ${hum} Hz hum removed`})`)
  } catch (err) {
    if (!/cancel/i.test(String(err))) useUi.getState().showToast(`Denoise failed: ${err instanceof Error ? err.message : err}`, 'error')
  }
}

const analysisCache = new Map<string, LoudnessResult>()

/** Loudness of the part of the source a clip uses. */
export async function analyzeClip(clipId: string): Promise<LoudnessResult | null> {
  const p = useProject.getState().project
  const clip = findClip(p, clipId)
  const media = findMedia(p, clip?.mediaId)
  if (!clip || !media) return null
  const start = clip.in
  const duration = clip.duration * clip.speed
  const key = `${media.path}|${start.toFixed(3)}|${duration.toFixed(3)}`
  const hit = analysisCache.get(key)
  if (hit) return hit
  const result = await withJob(`Analyze ${media.name}`, duration, (jobId) =>
    window.cineply.invoke<LoudnessResult>('audio:analyze', media.path, { start, duration, jobId })
  )
  analysisCache.set(key, result)
  return result
}

/** Sets the clip gain so its peak reaches −1 dBFS or its integrated loudness hits the LUFS target. */
export async function normalizeClip(clipId: string, target: NormalizeTarget): Promise<void> {
  const ui = useUi.getState()
  try {
    const r = await analyzeClip(clipId)
    if (!r) return
    if (!Number.isFinite(r.peakDb)) return ui.showToast('The clip is silent', 'error')
    let changeDb: number
    if (target === 'peak') changeDb = -1 - r.peakDb
    else {
      if (r.lufs === null) return ui.showToast('Too short or too quiet to measure loudness; try Peak instead', 'error')
      changeDb = Number(target) - r.lufs
    }
    const gain = Math.min(dbToGain(36), dbToGain(changeDb))
    updateClip(clipId, 'Normalize', (c) => {
      c.audio.gain = gain
    })
    const peakAfter = r.peakDb + changeDb
    const note = peakAfter > 0 ? ` Peaks reach +${peakAfter.toFixed(1)} dBFS: add a Limiter to avoid clipping.` : ''
    ui.showToast(`Gain set to ${changeDb >= 0 ? '+' : ''}${changeDb.toFixed(1)} dB.${note}`, peakAfter > 0 ? 'error' : 'info')
  } catch (err) {
    if (!/cancel/i.test(String(err))) ui.showToast(`Normalize failed: ${err instanceof Error ? err.message : err}`, 'error')
  }
}
