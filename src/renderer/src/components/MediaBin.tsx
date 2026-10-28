import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { MediaItem } from '@shared/types'
import { useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { importFiles, startTranscode, transcodeJobId } from '@/lib/importMedia'
import { addMediaClip } from '@/lib/editing'
import { endDrag, setDragPayload } from '@/lib/dnd'
import { shortTime } from '@/lib/time'
import { ProgressBar } from './ui/controls'
import './MediaBin.css'

type SortKey = 'added' | 'name' | 'duration' | 'kind'
type ViewMode = 'grid' | 'list'

// ------------------------------------------------------------- helpers ----

/** Electron ≥ 32 removed File.path; the preload exposes webUtils.getPathForFile instead. */
function pathOfFile(file: File): string {
  return window.cineply.getPathForFile(file)
}

const thumbCache = new Map<string, Promise<string | null>>()

function thumbnailUrl(m: MediaItem): Promise<string | null> {
  const key = `${m.id}|${m.path}`
  let p = thumbCache.get(key)
  if (!p) {
    if (m.kind === 'image') p = Promise.resolve(window.cineply.mediaUrl(m.path))
    else if (m.kind === 'audio') p = Promise.resolve(null)
    else {
      p = window.cineply.media
        .thumbnail(m.path, Math.min(1, m.duration * 0.1), 320)
        .then((out) => window.cineply.mediaUrl(out))
        .catch(() => null)
    }
    thumbCache.set(key, p)
  }
  return p
}

function badgeOf(m: MediaItem): { text: string; cls: string; title: string } | null {
  if (m.ai || m.source === 'higgsfield') return { text: 'AI', cls: 'ai', title: m.ai?.prompt ? `AI: ${m.ai.prompt}` : 'AI generated' }
  if (m.source === 'voiceover') return { text: 'VO', cls: 'vo', title: 'Voiceover recording' }
  if (m.source === 'processed') return { text: 'FX', cls: 'fx', title: 'Processed copy' }
  if (m.source === 'title-render') return { text: 'TTL', cls: 'fx', title: 'Rendered title' }
  return null
}

const kindIcon = (m: MediaItem): string => (m.kind === 'audio' ? '♪' : m.kind === 'image' ? '▣' : '▶')
const resolution = (m: MediaItem): string => (m.width && m.height ? `${m.width}×${m.height}` : '')
const durationText = (m: MediaItem): string => (m.kind === 'image' ? 'Still' : shortTime(m.duration))

function Thumb(props: { media: MediaItem }): JSX.Element {
  const { media } = props
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setUrl(null)
    thumbnailUrl(media).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [media.id, media.path, media.kind])
  if (url) return <img src={url} alt="" draggable={false} />
  return <span className="mb-kind-icon">{kindIcon(media)}</span>
}

function StatusOverlay(props: { media: MediaItem; progress: number | undefined }): JSX.Element | null {
  const { media, progress } = props
  if (media.status === 'transcoding') {
    return (
      <div className="mb-status">
        <span>Optimizing{progress !== undefined && progress >= 0 ? ` ${Math.round(progress * 100)}%` : '…'}</span>
        <ProgressBar value={progress ?? -1} />
      </div>
    )
  }
  if (media.status === 'error') {
    return <div className="mb-status error" title={media.error}>⚠ {media.error ?? 'Error'}</div>
  }
  return null
}

// ------------------------------------------------------------- actions ----

async function importViaDialog(): Promise<void> {
  const paths = await window.cineply.dialog.openMedia()
  if (paths.length) await importAndReport(paths)
}

async function importAndReport(paths: string[]): Promise<void> {
  const before = useProject.getState().project.media.length
  const items = await importFiles(paths)
  const added = useProject.getState().project.media.length - before
  if (added > 0) useUi.getState().showToast(`Imported ${added} item${added === 1 ? '' : 's'}`)
  else if (items.length) useUi.getState().showToast('Already in the project')
}

function usageCount(mediaId: string): number {
  const { clips } = useProject.getState().project
  return clips.filter((c) => c.mediaId === mediaId || (c.title?.background.type === 'media' && c.title.background.mediaId === mediaId)).length
}

async function removeMedia(m: MediaItem): Promise<void> {
  const used = usageCount(m.id)
  if (used > 0) {
    const choice = await window.cineply.dialog.confirm(
      `Remove "${m.name}" from the project?`,
      `It is used by ${used} clip${used === 1 ? '' : 's'} on the timeline. ${used === 1 ? 'That clip' : 'Those clips'} will be removed too.`,
      ['Remove', 'Cancel']
    )
    if (choice !== 0) return
  }
  if (m.status === 'transcoding') void window.cineply.ffmpeg.cancel(transcodeJobId(m.id))
  const removed = new Set<string>()
  useProject.getState().mutate(`Remove ${m.name}`, (p) => {
    p.media = p.media.filter((x) => x.id !== m.id)
    p.clips = p.clips.filter((c) => {
      if (c.mediaId !== m.id) return true
      removed.add(c.id)
      return false
    })
    for (const c of p.clips) {
      if (c.title?.background.type === 'media' && c.title.background.mediaId === m.id) c.title.background = { type: 'none' }
    }
  })
  const ui = useUi.getState()
  if (ui.selection.some((id) => removed.has(id))) ui.select(ui.selection.filter((id) => !removed.has(id)))
}

function addToTimeline(m: MediaItem): void {
  if (m.status === 'error') return
  const ids = addMediaClip(m.id)
  if (ids.length) useUi.getState().select(ids)
}

// ----------------------------------------------------------- component ----

interface MenuState {
  x: number
  y: number
  media: MediaItem
}

export function MediaBin(): JSX.Element {
  const media = useProject((s) => s.project.media)
  const jobs = useUi((s) => s.jobs)
  const [view, setView] = useState<ViewMode>('grid')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('added')
  const [desc, setDesc] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropping, setDropping] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const progress = useMemo(() => {
    const map = new Map<string, number>()
    for (const j of jobs) if (j.id.startsWith('transcode-') && j.status === 'running') map.set(j.id, j.progress)
    return map
  }, [jobs])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = media.filter((m) => !q || m.name.toLowerCase().includes(q) || m.ai?.prompt.toLowerCase().includes(q))
    const cmp: Record<SortKey, (a: MediaItem, b: MediaItem) => number> = {
      added: () => 0,
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      duration: (a, b) => a.duration - b.duration,
      kind: (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
    }
    const sorted = [...list].sort(cmp[sort])
    return desc ? sorted.reverse() : sorted
  }, [media, query, sort, desc])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const isFileDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')

  const onDragOver = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }

  const onDragLeave = (e: React.DragEvent): void => {
    if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setDropping(false)
  }

  const onDrop = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    setDropping(false)
    const files = Array.from(e.dataTransfer.files)
    const paths = files.map(pathOfFile).filter(Boolean)
    if (files.length && !paths.length) {
      useUi.getState().showToast('Dropped files have no local path; use Import instead', 'error')
      return
    }
    if (paths.length) void importAndReport(paths)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const m = media.find((x) => x.id === selected)
    if (!m || (e.target as HTMLElement).tagName === 'INPUT') return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      void removeMedia(m)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      addToTimeline(m)
    }
  }

  const itemProps = (m: MediaItem) => ({
    draggable: m.status !== 'error',
    title: [m.name, resolution(m), m.videoCodec, m.audioCodec, m.ai?.prompt].filter(Boolean).join(' · '),
    onClick: () => setSelected(m.id),
    onDoubleClick: () => addToTimeline(m),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      setSelected(m.id)
      setMenu({ x: e.clientX, y: e.clientY, media: m })
    },
    onDragStart: (e: React.DragEvent) => {
      setSelected(m.id)
      setDragPayload(e, { kind: 'media', mediaId: m.id })
    },
    onDragEnd: () => endDrag()
  })

  return (
    <div
      ref={rootRef}
      className={`media-bin${dropping ? ' dropping' : ''}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mb-toolbar">
        <button className="btn primary small" onClick={() => void importViaDialog()} title="Import media files (Ctrl+I)">
          ＋ Import
        </button>
        <input className="input mb-search" placeholder="Search media" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="select mb-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} title="Sort by">
          <option value="added">Added</option>
          <option value="name">Name</option>
          <option value="duration">Duration</option>
          <option value="kind">Type</option>
        </select>
        <button className="btn ghost icon small" onClick={() => setDesc(!desc)} title={desc ? 'Descending' : 'Ascending'}>
          {desc ? '↓' : '↑'}
        </button>
        <button className={`btn ghost icon small${view === 'grid' ? ' active' : ''}`} onClick={() => setView('grid')} title="Grid view">▦</button>
        <button className={`btn ghost icon small${view === 'list' ? ' active' : ''}`} onClick={() => setView('list')} title="List view">☰</button>
      </div>

      {media.length === 0 ? (
        <div className="mb-empty" onDoubleClick={() => void importViaDialog()}>
          <div className="mb-empty-icon">⇪</div>
          <div>Drop video, audio or image files here</div>
          <button className="btn small" onClick={() => void importViaDialog()}>Import media…</button>
        </div>
      ) : items.length === 0 ? (
        <div className="empty">No media matches “{query}”</div>
      ) : view === 'grid' ? (
        <div className="grid-cards mb-grid">
          {items.map((m) => {
            const badge = badgeOf(m)
            return (
              <div key={m.id} {...itemProps(m)} className={`card mb-card${selected === m.id ? ' selected' : ''}${m.status === 'error' ? ' failed' : ''}`}>
                <div className="thumb">
                  <Thumb media={m} />
                  {badge && <span className={`mb-badge ${badge.cls}`} title={badge.title}>{badge.text}</span>}
                  <span className="mb-duration">{durationText(m)}</span>
                  <StatusOverlay media={m} progress={progress.get(transcodeJobId(m.id))} />
                </div>
                <div className="name">{m.name}</div>
                <div className="mb-meta">{[kindIcon(m), resolution(m)].filter(Boolean).join(' ')}</div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="mb-list">
          {items.map((m) => {
            const badge = badgeOf(m)
            return (
              <div key={m.id} {...itemProps(m)} className={`mb-row${selected === m.id ? ' selected' : ''}${m.status === 'error' ? ' failed' : ''}`}>
                <div className="mb-row-thumb"><Thumb media={m} /></div>
                <div className="mb-row-main">
                  <div className="mb-row-name">
                    {badge && <span className={`mb-badge inline ${badge.cls}`} title={badge.title}>{badge.text}</span>}
                    <span>{m.name}</span>
                  </div>
                  <div className="mb-meta">
                    {[durationText(m), resolution(m), m.fps ? `${Math.round(m.fps * 100) / 100} fps` : '', m.videoCodec ?? m.audioCodec]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {m.status === 'transcoding' && <ProgressBar value={progress.get(transcodeJobId(m.id)) ?? -1} />}
                  {m.status === 'error' && <div className="mb-error" title={m.error}>⚠ {m.error ?? 'Error'}</div>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {dropping && <div className="mb-drop-hint">Drop to import</div>}

      {menu && (
        <div className="mb-menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 150) }} onMouseDown={(e) => e.stopPropagation()}>
          <button disabled={menu.media.status === 'error'} onClick={() => { addToTimeline(menu.media); setMenu(null) }}>
            Add to timeline
          </button>
          <button onClick={() => { void window.cineply.shell.showItemInFolder(menu.media.path); setMenu(null) }}>
            Reveal in Explorer
          </button>
          {menu.media.status === 'error' && (
            <button onClick={() => { startTranscode(menu.media); setMenu(null) }}>Retry optimizing</button>
          )}
          <div className="mb-menu-sep" />
          <button className="danger" onClick={() => { void removeMedia(menu.media); setMenu(null) }}>
            Remove from project
          </button>
        </div>
      )}
    </div>
  )
}
