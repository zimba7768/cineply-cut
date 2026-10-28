import type { JSX } from 'react'
import { Modal } from '@/components/ui/controls'

export const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Playback',
    items: [
      ['Space', 'Play / pause'],
      ['J / K / L', 'Shuttle reverse / stop / forward (press again to speed up)'],
      ['← / →', 'Back / forward one frame (Shift: 5 frames)'],
      ['↑ / ↓', 'Previous / next edit point'],
      ['Home / End', 'Go to start / end'],
      ['I / O', 'Set in / out point'],
      ['Ctrl+Shift+X', 'Clear in and out points']
    ]
  },
  {
    group: 'Tools',
    items: [
      ['V', 'Selection tool'],
      ['C', 'Razor tool (Shift+click: all tracks, Alt+click: ignore links)'],
      ['B', 'Ripple edit tool'],
      ['H', 'Hand tool (or drag with the middle mouse button)'],
      ['S', 'Toggle snapping']
    ]
  },
  {
    group: 'Editing',
    items: [
      ['Ctrl+K', 'Split at playhead'],
      ['Delete', 'Delete (leave gap)'],
      ['Shift+Delete', 'Ripple delete'],
      ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copy / cut / paste at playhead'],
      ['Ctrl+D', 'Duplicate'],
      ['Ctrl+A', 'Select all'],
      [', / .', 'Nudge selection one frame (Shift: 5 frames)'],
      ['Ctrl+L', 'Link / unlink'],
      ['Alt+drag', 'Move or trim one clip without its linked clips'],
      ['Shift / Ctrl+click', 'Add to or remove from selection'],
      ['Esc', 'Deselect, or cancel a drag'],
      ['Ctrl+Z', 'Undo'],
      ['Ctrl+Shift+Z / Ctrl+Y', 'Redo']
    ]
  },
  {
    group: 'Timeline',
    items: [
      ['M', 'Add marker'],
      ['+ / −', 'Zoom in / out'],
      ['Ctrl+wheel', 'Zoom at cursor'],
      ['\\', 'Zoom to fit'],
      ['Right-click', 'Clip, track and marker options']
    ]
  },
  {
    group: 'Project',
    items: [
      ['Ctrl+N', 'New project'],
      ['Ctrl+O', 'Open project'],
      ['Ctrl+S', 'Save'],
      ['Ctrl+Shift+S', 'Save as'],
      ['Ctrl+I', 'Import media'],
      ['Ctrl+T', 'New title'],
      ['Ctrl+M', 'Export'],
      ['?', 'Show this list']
    ]
  }
]

// Keyboard shortcut reference.
export function ShortcutsDialog(props: { onClose(): void }): JSX.Element {
  return (
    <Modal title="Keyboard shortcuts" onClose={props.onClose} width={640}>
      <div style={{ columns: 2, columnGap: 28 }}>
        {SHORTCUTS.map((g) => (
          <div key={g.group} style={{ breakInside: 'avoid', marginBottom: 14 }}>
            <div className="category-label" style={{ padding: '0 0 6px' }}>{g.group}</div>
            {g.items.map(([keys, what]) => (
              <div key={keys} style={{ display: 'flex', gap: 10, padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
                <span style={{ width: 118, flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent-2)' }}>{keys}</span>
                <span style={{ color: 'var(--text-1)' }}>{what}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  )
}
