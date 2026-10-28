import { create } from 'zustand'
import type { Project } from '@shared/types'
import { useUi } from '@/store/ui'
import { uid } from '@/lib/ids'
import { runExport, type ExportProgress, type ExportResult } from './pipeline'
import type { ExportSettings } from './settings'

/** The current (or last finished) export. Lives outside the dialog so closing it doesn't stop the export. */
export interface ExportRun {
  id: string
  settings: ExportSettings
  label: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  progress: ExportProgress
  startedAt: number
  finishedAt?: number
  result?: ExportResult
  error?: string
}

interface ExportState {
  run: ExportRun | null
  /** Forget a finished export (the dialog shows settings again). */
  clear(): void
}

export const useExport = create<ExportState>((set, get) => ({
  run: null,
  clear: () => {
    if (get().run?.status !== 'running') set({ run: null })
  }
}))

let controller: AbortController | null = null

const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p

const patch = (id: string, changes: Partial<ExportRun>): void => {
  const run = useExport.getState().run
  if (run?.id === id) useExport.setState({ run: { ...run, ...changes } })
}

/** Starts an export in the background; progress is mirrored into useExport and the jobs list. */
export function startExport(project: Project, settings: ExportSettings): Promise<ExportResult | null> {
  if (useExport.getState().run?.status === 'running') return Promise.reject(new Error('An export is already running'))
  const id = `export-${uid()}`
  const label = `Export ${fileName(settings.output)}`
  const ac = new AbortController()
  controller = ac
  const ui = useUi.getState()
  useExport.setState({
    run: {
      id, settings, label, status: 'running', startedAt: performance.now(),
      progress: { phase: 'preparing', framesDone: 0, framesTotal: 0, fraction: 0 }
    }
  })
  ui.upsertJob({ id, label, progress: 0, status: 'running', cancel: cancelExport, error: undefined })

  // Re-rendering React on every frame would slow the export down; publish ~8 times a second.
  let lastPublish = 0
  const onProgress = (p: ExportProgress): void => {
    const now = performance.now()
    if (now - lastPublish < 120 && p.fraction < 1) return
    lastPublish = now
    patch(id, { progress: p })
    useUi.getState().upsertJob({ id, progress: p.fraction })
  }

  return runExport(project, settings, { signal: ac.signal, onProgress, jobId: id }).then(
    (result) => {
      const run = useExport.getState().run
      patch(id, {
        status: 'done', result, finishedAt: performance.now(),
        progress: { ...(run?.progress ?? { phase: 'finalizing', framesDone: 0, framesTotal: 0 }), fraction: 1 }
      })
      useUi.getState().upsertJob({ id, status: 'done', progress: 1, cancel: undefined })
      useUi.getState().showToast(`Exported ${fileName(settings.output)}`)
      return result
    },
    (err: unknown) => {
      const cancelled = ac.signal.aborted
      const message = err instanceof Error ? err.message : String(err)
      if (!cancelled) console.error('[export] failed', err)
      patch(id, { status: cancelled ? 'cancelled' : 'error', error: cancelled ? undefined : message, finishedAt: performance.now() })
      useUi.getState().upsertJob({
        id, status: cancelled ? 'cancelled' : 'error', error: cancelled ? undefined : message, cancel: undefined
      })
      if (!cancelled) useUi.getState().showToast(`Export failed: ${message}`, 'error')
      return null
    }
  ).finally(() => {
    if (controller === ac) controller = null
  })
}

export function cancelExport(): void {
  controller?.abort(new DOMException('Export cancelled', 'AbortError'))
}
