import type { Project } from '@shared/types'

export type ExportFormat = 'mp4' | 'wav' | 'mp3'
export type ExportPresetId = 'mp4-1080' | 'mp4-4k' | 'vertical' | 'match' | 'wav' | 'mp3'
export type QualityLevel = 'low' | 'medium' | 'high' | 'very-high' | 'custom'
/** 'auto' tries hardware WebCodecs first and falls back to ffmpeg; 'ffmpeg' forces libx264. */
export type EncoderChoice = 'auto' | 'ffmpeg'

export interface ExportSettings {
  format: ExportFormat
  width: number
  height: number
  fps: number
  quality: QualityLevel
  /** Used when quality is 'custom'. */
  customMbps: number
  audioBitrate: number // bits per second (AAC/MP3)
  start: number
  end: number
  output: string
  encoder: EncoderChoice
}

export interface ExportPreset {
  id: ExportPresetId
  label: string
  format: ExportFormat
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'mp4-1080', label: 'MP4 H.264 1080p', format: 'mp4' },
  { id: 'mp4-4k', label: 'MP4 H.264 4K', format: 'mp4' },
  { id: 'vertical', label: 'Vertical 9:16 (1080×1920)', format: 'mp4' },
  { id: 'match', label: 'Match Sequence', format: 'mp4' },
  { id: 'wav', label: 'Audio only: WAV', format: 'wav' },
  { id: 'mp3', label: 'Audio only: MP3', format: 'mp3' }
]

export const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]
export const AUDIO_BITRATES = [128_000, 192_000, 256_000, 320_000]
export const QUALITY_LABELS: Record<QualityLevel, string> = {
  low: 'Low', medium: 'Medium', high: 'High', 'very-high': 'Very high', custom: 'Custom'
}
/** Bitrates for 1080p30; other sizes and rates scale from these. */
const BASE_MBPS: Record<Exclude<QualityLevel, 'custom'>, number> = { low: 5, medium: 10, high: 16, 'very-high': 25 }

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** Largest even size with the sequence's aspect that fits a box (oriented like the sequence). */
export function fitBox(seqW: number, seqH: number, longEdge: number, shortEdge: number): { width: number; height: number } {
  const landscape = seqW >= seqH
  const boxW = landscape ? longEdge : shortEdge
  const boxH = landscape ? shortEdge : longEdge
  const s = Math.min(boxW / seqW, boxH / seqH)
  return { width: even(seqW * s), height: even(seqH * s) }
}

export function presetSize(preset: ExportPresetId, seqW: number, seqH: number): { width: number; height: number } {
  switch (preset) {
    case 'mp4-4k': return fitBox(seqW, seqH, 3840, 2160)
    case 'vertical': return { width: 1080, height: 1920 }
    case 'match': return { width: even(seqW), height: even(seqH) }
    default: return fitBox(seqW, seqH, 1920, 1080)
  }
}

/** Exact frame rate for NTSC-style values (29.97 -> 30000/1001) so long exports don't drift. */
export function exactFps(fps: number): number {
  const ntsc = Math.round(fps * 1.001)
  if (!Number.isInteger(fps) && Math.abs(fps - ntsc / 1.001) < 0.005) return (ntsc * 1000) / 1001
  return fps
}

export function formatFps(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/0+$/, '')
}

export function videoBitrate(s: Pick<ExportSettings, 'quality' | 'customMbps' | 'width' | 'height' | 'fps'>): number {
  if (s.quality === 'custom') return Math.max(0.1, s.customMbps) * 1e6
  const load = (s.width * s.height * s.fps) / (1920 * 1080 * 30)
  return Math.round(BASE_MBPS[s.quality] * Math.pow(load, 0.8) * 10) / 10 * 1e6
}

export const isAudioOnly = (f: ExportFormat): boolean => f !== 'mp4'

export function frameCount(s: Pick<ExportSettings, 'start' | 'end' | 'fps'>): number {
  return Math.max(1, Math.round((s.end - s.start) * exactFps(s.fps)))
}

/** Rough output size in bytes. */
export function estimateBytes(s: ExportSettings, sampleRate: number): number {
  const duration = Math.max(0, s.end - s.start)
  if (s.format === 'wav') return 44 + duration * sampleRate * 2 * 3
  if (s.format === 'mp3') return (duration * s.audioBitrate) / 8
  return (duration * (videoBitrate(s) + s.audioBitrate)) / 8 * 1.01
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function extensionFor(f: ExportFormat): string {
  return f
}

export function fileFilterFor(f: ExportFormat): { name: string; extensions: string[] } {
  if (f === 'wav') return { name: 'WAV audio', extensions: ['wav'] }
  if (f === 'mp3') return { name: 'MP3 audio', extensions: ['mp3'] }
  return { name: 'MP4 video', extensions: ['mp4'] }
}

/** Replaces or adds the extension matching the format. */
export function withExtension(path: string, f: ExportFormat): string {
  const base = path.replace(/\.(mp4|mov|m4v|wav|mp3)$/i, '')
  return `${base}.${extensionFor(f)}`
}

export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').trim() || 'Untitled'
}

export function aspectDiffers(project: Project, width: number, height: number): boolean {
  const { width: w, height: h } = project.sequence
  return Math.abs(w / h - width / height) > 0.01
}
