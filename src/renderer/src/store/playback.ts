import { create } from 'zustand'

/** Transport state. `time` is the playhead in seconds. The playback engine drives it while playing. */
export interface PlaybackState {
  time: number
  playing: boolean
  rate: number // shuttle speed (J/K/L): negative = reverse
  loop: boolean
  inPoint: number | null
  outPoint: number | null
  setTime(t: number): void
  setPlaying(p: boolean): void
  setRate(r: number): void
  setLoop(l: boolean): void
  setInOut(i: number | null, o: number | null): void
}

export const usePlayback = create<PlaybackState>((set) => ({
  time: 0,
  playing: false,
  rate: 1,
  loop: false,
  inPoint: null,
  outPoint: null,
  setTime: (t) => set({ time: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  setRate: (rate) => set({ rate }),
  setLoop: (loop) => set({ loop }),
  setInOut: (inPoint, outPoint) => set({ inPoint, outPoint })
}))
