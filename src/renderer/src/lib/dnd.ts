/** Drag-and-drop payloads between panels and the timeline. */
export const DND_MIME = 'application/x-cineply'

export type DragPayload =
  | { kind: 'media'; mediaId: string }
  | { kind: 'transition'; type: string }
  | { kind: 'videoEffect'; type: string }
  | { kind: 'audioEffect'; type: string }
  | { kind: 'titleTemplate'; templateId: string }

export function setDragPayload(e: React.DragEvent, payload: DragPayload): void {
  e.dataTransfer.setData(DND_MIME, JSON.stringify(payload))
  e.dataTransfer.effectAllowed = 'copy'
  currentDrag = payload
}

/** Payload of the drag in progress (dataTransfer can't be read during dragover). */
export let currentDrag: DragPayload | null = null

export function getDragPayload(e: React.DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(DND_MIME)
    return raw ? (JSON.parse(raw) as DragPayload) : currentDrag
  } catch {
    return currentDrag
  }
}

export function endDrag(): void {
  currentDrag = null
}
