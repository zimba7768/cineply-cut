import type { CineplyApi } from '../shared/ipc'

declare global {
  interface Window {
    cineply: CineplyApi
  }
}
export {}
