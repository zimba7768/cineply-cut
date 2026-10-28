import { useEffect, useRef, useState, type JSX } from 'react'
import { useProject } from '@/store/project'
import { useUi, type Tool } from '@/store/ui'
import { Icon } from '@/components/timeline/icons'
import {
  clearRecentProjects, getRecentProjects, newProjectCmd, openProjectCmd, projectNameFromPath, saveProject, saveProjectAs
} from '@/lib/projectIO'
import { importMediaCmd } from '@/hooks/useAppCommands'
import './TopBar.css'

const TOOLS: { id: Tool; label: string; key: string; icon: () => JSX.Element }[] = [
  { id: 'select', label: 'Selection', key: 'V', icon: Icon.select },
  { id: 'razor', label: 'Razor', key: 'C', icon: Icon.razor },
  { id: 'ripple', label: 'Ripple edit', key: 'B', icon: Icon.ripple },
  { id: 'hand', label: 'Hand', key: 'H', icon: Icon.hand }
]

// Top bar: project name, tools, undo/redo, export button.
export function TopBar(): JSX.Element {
  const name = useProject((s) => s.project.name)
  const dirty = useProject((s) => s.dirty)
  const undoLabel = useProject((s) => s.past[s.past.length - 1]?.label)
  const redoLabel = useProject((s) => s.future[0]?.label)
  const seq = useProject((s) => s.project.sequence)
  const tool = useUi((s) => s.tool)
  const snapping = useUi((s) => s.snapping)
  const ui = useUi.getState()

  return (
    <div className="topbar">
      <div className="topbar-brand">
        <span className="topbar-logo">▶</span>
        <span>Cineply Cut</span>
      </div>
      <ProjectMenu name={name} dirty={dirty} />

      <div className="topbar-group">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`btn icon${tool === t.id ? ' active' : ''}`}
            title={`${t.label} (${t.key})`}
            onClick={() => ui.setTool(t.id)}
          >
            <t.icon />
          </button>
        ))}
      </div>

      <div className="topbar-group">
        <button
          className="btn icon"
          disabled={!undoLabel}
          title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
          onClick={() => useProject.getState().undo()}
        >
          <Icon.undo />
        </button>
        <button
          className="btn icon"
          disabled={!redoLabel}
          title={redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}
          onClick={() => useProject.getState().redo()}
        >
          <Icon.redo />
        </button>
      </div>

      <button
        className={`btn icon${snapping ? ' active' : ''}`}
        title={`Snapping ${snapping ? 'on' : 'off'} (S)`}
        onClick={() => ui.setSnapping(!snapping)}
      >
        <Icon.magnet />
      </button>

      <div className="grow" />

      <button className="btn ghost topbar-seq" title="Sequence settings" onClick={() => ui.openModal('sequence')}>
        <Icon.film />
        <span>{seq.width}×{seq.height} · {seq.fps} fps</span>
      </button>
      <button className="btn ghost icon" title="Keyboard shortcuts (?)" onClick={() => ui.openModal('shortcuts')}>
        <Icon.keyboard />
      </button>
      <button className="btn ghost icon" title="Settings" onClick={() => ui.openModal('settings')}>
        <Icon.gear />
      </button>
      <button className="btn primary topbar-export" title="Export (Ctrl+M)" onClick={() => ui.openModal('export')}>
        Export
      </button>
    </div>
  )
}

function ProjectMenu(props: { name: string; dirty: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<string[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    getRecentProjects().then(setRecent).catch(() => setRecent([]))
    const close = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [open])

  const run = (fn: () => unknown): void => {
    setOpen(false)
    void fn()
  }

  return (
    <div className="topbar-project" ref={ref}>
      <button className="btn ghost" onClick={() => setOpen(!open)} title="Project">
        <span className="topbar-project-name">{props.name}</span>
        {props.dirty && <span className="topbar-dirty" title="Unsaved changes">●</span>}
        <Icon.chevron />
      </button>
      {open && (
        <div className="topbar-menu">
          <button onClick={() => run(newProjectCmd)}><span>New project</span><kbd>Ctrl+N</kbd></button>
          <button onClick={() => run(() => openProjectCmd())}><span>Open…</span><kbd>Ctrl+O</kbd></button>
          <button onClick={() => run(saveProject)}><span>Save</span><kbd>Ctrl+S</kbd></button>
          <button onClick={() => run(saveProjectAs)}><span>Save as…</span><kbd>Ctrl+Shift+S</kbd></button>
          <div className="topbar-menu-sep" />
          <button onClick={() => run(importMediaCmd)}><span>Import media…</span><kbd>Ctrl+I</kbd></button>
          {recent.length > 0 && (
            <>
              <div className="topbar-menu-sep" />
              <div className="topbar-menu-label">Recent projects</div>
              {recent.map((p) => (
                <button key={p} title={p} onClick={() => run(() => openProjectCmd(p))}>
                  <span>{projectNameFromPath(p)}</span>
                </button>
              ))}
              <button className="muted" onClick={() => run(async () => { await clearRecentProjects(); setRecent([]) })}>
                <span>Clear recent</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
