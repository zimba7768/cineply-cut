import { create } from 'zustand'

export type Tool = 'select' | 'razor' | 'ripple' | 'hand'
export type LeftTab = 'media' | 'effects' | 'titles' | 'audio' | 'ai'
export type Modal = null | 'export' | 'sequence' | 'shortcuts' | 'settings'

export interface Job {
  id: string
  label: string
  progress: number // 0..1, or -1 for indeterminate
  status: 'running' | 'done' | 'error' | 'cancelled'
  error?: string
  cancel?: () => void
}

export interface UiState {
  tool: Tool
  selection: string[] // clip ids
  selectedTrackId: string | null
  /** Selected transition: clip id + which edge. */
  selectedTransition: { clipId: string; edge: 'in' | 'out' } | null
  zoom: number // timeline pixels per second
  scrollX: number // timeline scroll in px
  snapping: boolean
  leftTab: LeftTab
  modal: Modal
  jobs: Job[]
  toast: { message: string; kind: 'info' | 'error' } | null

  setTool(t: Tool): void
  select(ids: string[]): void
  selectTransition(t: UiState['selectedTransition']): void
  setZoom(z: number): void
  setScrollX(x: number): void
  setSnapping(s: boolean): void
  setLeftTab(t: LeftTab): void
  openModal(m: Modal): void
  upsertJob(job: Partial<Job> & { id: string }): void
  removeJob(id: string): void
  showToast(message: string, kind?: 'info' | 'error'): void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

export const useUi = create<UiState>((set) => ({
  tool: 'select',
  selection: [],
  selectedTrackId: null,
  selectedTransition: null,
  zoom: 60,
  scrollX: 0,
  snapping: true,
  leftTab: 'media',
  modal: null,
  jobs: [],
  toast: null,

  setTool: (tool) => set({ tool }),
  select: (selection) => set({ selection, selectedTransition: null }),
  selectTransition: (selectedTransition) => set({ selectedTransition, selection: [] }),
  setZoom: (zoom) => set({ zoom: Math.min(2000, Math.max(2, zoom)) }),
  setScrollX: (scrollX) => set({ scrollX: Math.max(0, scrollX) }),
  setSnapping: (snapping) => set({ snapping }),
  setLeftTab: (leftTab) => set({ leftTab }),
  openModal: (modal) => set({ modal }),
  upsertJob: (job) =>
    set((s) => {
      const i = s.jobs.findIndex((j) => j.id === job.id)
      if (i < 0) return { jobs: [...s.jobs, { label: '', progress: -1, status: 'running', ...job }] }
      const jobs = s.jobs.slice()
      jobs[i] = { ...jobs[i], ...job }
      return { jobs }
    }),
  removeJob: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
  showToast: (message, kind = 'info') => {
    clearTimeout(toastTimer)
    set({ toast: { message, kind } })
    toastTimer = setTimeout(() => set({ toast: null }), 4000)
  }
}))
