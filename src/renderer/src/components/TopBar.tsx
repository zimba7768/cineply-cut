import type { JSX } from 'react'

// Top bar: project name, tools, undo/redo, export button.
export function TopBar(): JSX.Element {
  return <div style={{ height: 44, background: 'var(--bg-1)', borderBottom: '1px solid var(--line)' }} />
}
