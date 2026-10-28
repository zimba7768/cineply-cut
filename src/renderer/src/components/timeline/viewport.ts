import { useUi } from '@/store/ui'
import { usePlayback } from '@/store/playback'
import { getProject, sequenceDuration } from '@/store/project'

/**
 * The timeline's horizontal viewport. Lets keyboard shortcuts and the zoom slider zoom around an
 * anchor (cursor or playhead) and scroll the playhead into view without reaching into the component.
 */

export const MIN_ZOOM = 2
export const MAX_ZOOM = 2000

let el: HTMLElement | null = null
let pendingScroll: number | null = null

export function registerViewport(node: HTMLElement | null): void {
  el = node
}

export function viewportWidth(): number {
  return el?.clientWidth ?? 800
}

/** Scroll position requested by the last zoom; the timeline applies it once it re-rendered at the new zoom. */
export function takePendingScroll(): number | null {
  const s = pendingScroll
  pendingScroll = null
  return s
}

/** Zooms so that `anchorTime` stays at `anchorPx` (pixels from the viewport's left edge). */
export function zoomAt(zoom: number, anchorTime?: number, anchorPx?: number): void {
  const ui = useUi.getState()
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
  const scroll = el?.scrollLeft ?? ui.scrollX
  const width = viewportWidth()
  let t = anchorTime
  if (t === undefined) {
    const ph = usePlayback.getState().time
    const x = ph * ui.zoom - scroll
    t = x >= 0 && x <= width ? ph : (scroll + width / 2) / ui.zoom
  }
  const px = anchorPx ?? t * ui.zoom - scroll
  pendingScroll = Math.max(0, t * z - px)
  if (z === ui.zoom) {
    applyScroll(pendingScroll)
    pendingScroll = null
  } else {
    ui.setZoom(z)
  }
}

export function zoomBy(factor: number): void {
  zoomAt(useUi.getState().zoom * factor)
}

/** Fits the whole sequence into the viewport. */
export function zoomToFit(): void {
  const dur = Math.max(5, sequenceDuration(getProject()))
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (viewportWidth() - 40) / dur))
  pendingScroll = 0
  if (z === useUi.getState().zoom) {
    applyScroll(0)
    pendingScroll = null
  } else {
    useUi.getState().setZoom(z)
  }
}

function applyScroll(x: number): void {
  if (el) el.scrollLeft = x
  useUi.getState().setScrollX(x)
}

/** Scrolls horizontally so that time t is visible (with a small margin). */
export function revealTime(t: number, page = false): void {
  if (!el) return
  const x = t * useUi.getState().zoom
  const w = el.clientWidth
  const margin = Math.min(60, w / 4)
  if (x < el.scrollLeft + margin) applyScroll(Math.max(0, page ? x - w + margin * 2 : x - margin))
  else if (x > el.scrollLeft + w - margin) applyScroll(page ? x - margin : x - w + margin)
}
