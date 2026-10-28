import { getProject } from '@/store/project'
import { renderFrame } from './compositor'
import { createMediaPool } from './playback'

/**
 * Captures the composited sequence frame at timeline time t as a PNG blob at full sequence
 * resolution (used for image-to-video AI input and "export frame").
 * Uses its own media pool so the monitor's elements are not re-seeked.
 */
export async function captureFrame(t: number): Promise<Blob | null> {
  const project = getProject()
  const pool = createMediaPool()
  try {
    await pool.prepare(project, t)
    const canvas = document.createElement('canvas')
    canvas.width = project.sequence.width
    canvas.height = project.sequence.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    renderFrame(ctx, project, t, pool, { scale: 1 })
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  } finally {
    pool.dispose()
  }
}
