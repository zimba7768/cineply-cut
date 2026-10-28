import { useEffect } from 'react'
import { getProject, sequenceDuration, useProject } from '@/store/project'
import { usePlayback } from '@/store/playback'
import { useUi } from '@/store/ui'
import { preview } from '@/engine/playback'
import { TITLE_TEMPLATES } from '@/engine/titles'
import { importFiles } from '@/lib/importMedia'
import { snapToFrame } from '@/lib/time'
import {
  addMarker, addTitleClip, addTrack, copyClips, cutClips, deleteClips, duplicateClips, editPoints,
  nudgeClips, pasteClips, selectAll, setTransition, splitAt, toggleLink
} from '@/lib/editing'
import {
  checkRecovery, newProjectCmd, openProjectCmd, saveProject, saveProjectAs, startAutosave
} from '@/lib/projectIO'
import { revealTime, zoomBy, zoomToFit } from '@/components/timeline/viewport'

// Wires native menu actions and global keyboard shortcuts to editor commands.

const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'color', 'submit', 'reset', 'file'])

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && !NON_TEXT_INPUTS.has((el as HTMLInputElement).type)
}

const hasTextSelection = (): boolean => (window.getSelection()?.toString().length ?? 0) > 0

export async function importMediaCmd(): Promise<void> {
  const paths = await window.cineply.dialog.openMedia()
  if (paths.length === 0) return
  useUi.getState().setLeftTab('media')
  await importFiles(paths)
}

function setTime(t: number): void {
  usePlayback.getState().setTime(Math.max(0, t))
  revealTime(usePlayback.getState().time)
}

function stepFrames(n: number): void {
  const pb = usePlayback.getState()
  if (pb.playing) preview.pause()
  const fps = getProject().sequence.fps
  setTime(snapToFrame(pb.time, fps) + n / fps)
}

function jumpEdit(dir: 1 | -1): void {
  const t = usePlayback.getState().time
  const eps = 0.5 / getProject().sequence.fps
  const pts = editPoints(getProject())
  const target = dir > 0 ? pts.find((p) => p > t + eps) : [...pts].reverse().find((p) => p < t - eps)
  if (target !== undefined) setTime(target)
}

function shuttle(dir: 1 | -1): void {
  const pb = usePlayback.getState()
  if (pb.playing && Math.sign(pb.rate) === dir) pb.setRate(Math.max(-8, Math.min(8, pb.rate * 2)))
  else {
    pb.setRate(dir)
    if (!pb.playing) preview.play()
  }
}

function togglePlay(): void {
  const pb = usePlayback.getState()
  if (!pb.playing && pb.rate !== 1) pb.setRate(1)
  preview.togglePlay()
}

function deleteSelection(ripple: boolean): void {
  const ui = useUi.getState()
  if (ui.selectedTransition) setTransition(ui.selectedTransition.clipId, ui.selectedTransition.edge, null)
  else if (ui.selection.length) deleteClips(ui.selection, ripple)
}

// Clipboard shortcuts arrive both as keydown and (via the Edit menu roles) as DOM clipboard
// events; whichever comes first wins.
let lastClipboard = { action: '', at: 0 }
function clipboardOnce(action: 'copy' | 'cut' | 'paste'): void {
  const now = performance.now()
  if (lastClipboard.action === action && now - lastClipboard.at < 300) return
  lastClipboard = { action, at: now }
  if (action === 'copy') copyClips()
  else if (action === 'cut') cutClips()
  else pasteClips()
}

function undoRedo(redo: boolean): void {
  // Inside a text field, the menu accelerator should edit the text, not the project.
  if (isTyping(document.activeElement)) {
    document.execCommand(redo ? 'redo' : 'undo')
    return
  }
  const s = useProject.getState()
  if (redo) s.redo()
  else s.undo()
  preview.invalidate()
}

export async function runMenuAction(action: string): Promise<void> {
  const ui = useUi.getState()
  switch (action) {
    case 'new': await newProjectCmd(); break
    case 'open': await openProjectCmd(); break
    case 'save': await saveProject(); break
    case 'saveAs': await saveProjectAs(); break
    case 'import': await importMediaCmd(); break
    case 'export': ui.openModal('export'); break
    case 'undo': undoRedo(false); break
    case 'redo': undoRedo(true); break
    case 'sequenceSettings': ui.openModal('sequence'); break
    case 'addVideoTrack': addTrack('video'); break
    case 'addAudioTrack': addTrack('audio'); break
    case 'newTitle': addTitleClip(TITLE_TEMPLATES[0]?.id ?? 'basic'); break
    case 'shortcuts': ui.openModal('shortcuts'); break
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const ui = useUi.getState()
  if (ui.modal) {
    if (e.key === 'Escape') ui.openModal(null)
    return
  }
  if (isTyping(e.target) || e.defaultPrevented) return
  if (e.target instanceof HTMLInputElement && e.target.type === 'range' && e.key.startsWith('Arrow')) return

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const ctrl = e.ctrlKey || e.metaKey
  const pb = usePlayback.getState()
  let handled = true

  if (ctrl) {
    switch (key) {
      case 'c': clipboardOnce('copy'); break
      case 'x': if (e.shiftKey) pb.setInOut(null, null); else clipboardOnce('cut'); break
      case 'v': clipboardOnce('paste'); break
      case 'd': duplicateClips(); break
      case 'k': splitAt(pb.time); break
      case 'l': toggleLink(); break
      case 'a': selectAll(); break
      case 'y': undoRedo(true); break
      case '=': case '+': zoomBy(1.5); break
      case '-': zoomBy(1 / 1.5); break
      default: handled = false
    }
  } else if (e.altKey) {
    handled = false
  } else {
    switch (key) {
      case ' ': togglePlay(); break
      case 'j': shuttle(-1); break
      case 'k': preview.pause(); pb.setRate(1); break
      case 'l': shuttle(1); break
      case 'Home': setTime(0); break
      case 'End': setTime(sequenceDuration(getProject())); break
      case 'ArrowLeft': stepFrames(e.shiftKey ? -5 : -1); break
      case 'ArrowRight': stepFrames(e.shiftKey ? 5 : 1); break
      case 'ArrowUp': jumpEdit(-1); break
      case 'ArrowDown': jumpEdit(1); break
      case 'i': pb.setInOut(pb.time, pb.outPoint !== null && pb.outPoint > pb.time ? pb.outPoint : null); break
      case 'o': pb.setInOut(pb.inPoint !== null && pb.inPoint < pb.time ? pb.inPoint : null, pb.time); break
      case 'v': ui.setTool('select'); break
      case 'c': ui.setTool('razor'); break
      case 'b': ui.setTool('ripple'); break
      case 'h': ui.setTool('hand'); break
      case 's': ui.setSnapping(!ui.snapping); break
      case 'm': addMarker(); break
      case 'Delete': case 'Backspace': deleteSelection(e.shiftKey); break
      case '=': case '+': zoomBy(1.5); break
      case '-': case '_': zoomBy(1 / 1.5); break
      case '\\': zoomToFit(); break
      case ',': nudgeClips(e.shiftKey ? -5 : -1); break
      case '.': nudgeClips(e.shiftKey ? 5 : 1); break
      case '?': ui.openModal('shortcuts'); break
      case 'Escape': ui.select([]); break
      default: handled = false
    }
  }
  if (handled) e.preventDefault()
}

function onClipboard(e: ClipboardEvent): void {
  if (useUi.getState().modal || isTyping(document.activeElement) || (e.type !== 'paste' && hasTextSelection())) return
  e.preventDefault()
  clipboardOnce(e.type as 'copy' | 'cut' | 'paste')
}

let recoveryChecked = false

export function useAppCommands(): void {
  useEffect(() => {
    const offMenu = window.cineply.app.onMenu((action) => {
      runMenuAction(action).catch((err) => useUi.getState().showToast(String((err as Error).message ?? err), 'error'))
    })
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('copy', onClipboard)
    document.addEventListener('cut', onClipboard)
    document.addEventListener('paste', onClipboard)
    const stopAutosave = startAutosave()
    if (!recoveryChecked) {
      recoveryChecked = true
      checkRecovery().catch((err) => console.warn('[cineply] recovery check failed', err))
    }
    return () => {
      offMenu()
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('copy', onClipboard)
      document.removeEventListener('cut', onClipboard)
      document.removeEventListener('paste', onClipboard)
      stopAutosave()
    }
  }, [])
}
