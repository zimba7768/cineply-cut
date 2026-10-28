import { useEffect, useRef, type JSX } from 'react'
import { useUi, type LeftTab } from '@/store/ui'
import { useProject } from '@/store/project'
import { TopBar } from '@/components/TopBar'
import { MediaBin } from '@/components/MediaBin'
import { Monitor } from '@/components/Monitor'
import { Inspector } from '@/components/inspector/Inspector'
import { Timeline } from '@/components/timeline/Timeline'
import { EffectsPanel } from '@/components/panels/EffectsPanel'
import { TitlesPanel } from '@/components/panels/TitlesPanel'
import { AudioPanel } from '@/components/panels/AudioPanel'
import { AIPanel } from '@/components/panels/AIPanel'
import { ExportDialog } from '@/components/modals/ExportDialog'
import { SequenceSettingsDialog } from '@/components/modals/SequenceSettingsDialog'
import { ShortcutsDialog } from '@/components/modals/ShortcutsDialog'
import { SettingsDialog } from '@/components/modals/SettingsDialog'
import { JobsAndToast } from '@/components/JobsAndToast'
import { useAppCommands } from '@/hooks/useAppCommands'

const LEFT_TABS: { id: LeftTab; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'effects', label: 'Effects' },
  { id: 'titles', label: 'Titles' },
  { id: 'audio', label: 'Audio' },
  { id: 'ai', label: 'AI ✦' }
]

export function App(): JSX.Element {
  const leftTab = useUi((s) => s.leftTab)
  const setLeftTab = useUi((s) => s.setLeftTab)
  const modal = useUi((s) => s.modal)
  const openModal = useUi((s) => s.openModal)
  const appRef = useRef<HTMLDivElement>(null)

  useAppCommands()

  // Keep the window title and the main-process "unsaved changes" flag in sync.
  const dirty = useProject((s) => s.dirty)
  const name = useProject((s) => s.project.name)
  useEffect(() => {
    window.cineply.app.setDirty(dirty)
    window.cineply.app.setTitle(`${dirty ? '● ' : ''}${name} — Cineply Cut`)
  }, [dirty, name])

  // Drag the splitter to resize the timeline.
  const onSplitDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const el = appRef.current!
    const onMove = (ev: MouseEvent): void => {
      const h = Math.min(window.innerHeight - 300, Math.max(160, window.innerHeight - ev.clientY))
      el.style.setProperty('--timeline-h', `${h}px`)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="app" ref={appRef}>
      <div className="area-top"><TopBar /></div>
      <div className="area-left panel">
        <div className="tabs">
          {LEFT_TABS.map((t) => (
            <button key={t.id} className={`tab${leftTab === t.id ? ' active' : ''}`} onClick={() => setLeftTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="panel-body">
          {leftTab === 'media' && <MediaBin />}
          {leftTab === 'effects' && <EffectsPanel />}
          {leftTab === 'titles' && <TitlesPanel />}
          {leftTab === 'audio' && <AudioPanel />}
          {leftTab === 'ai' && <AIPanel />}
        </div>
      </div>
      <div className="area-monitor panel"><Monitor /></div>
      <div className="area-right panel"><Inspector /></div>
      <div className="area-split" onMouseDown={onSplitDown} />
      <div className="area-timeline panel"><Timeline /></div>

      {modal === 'export' && <ExportDialog onClose={() => openModal(null)} />}
      {modal === 'sequence' && <SequenceSettingsDialog onClose={() => openModal(null)} />}
      {modal === 'shortcuts' && <ShortcutsDialog onClose={() => openModal(null)} />}
      {modal === 'settings' && <SettingsDialog onClose={() => openModal(null)} />}
      <JobsAndToast />
    </div>
  )
}
