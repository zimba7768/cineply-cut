import {
  PROJECT_VERSION, defaultAudioProps, defaultVideoProps,
  type Clip, type MediaItem, type Project, type Track
} from '@shared/types'
import { newProject, newTrack, useProject } from '@/store/project'
import { usePlayback } from '@/store/playback'
import { useUi } from '@/store/ui'
import { preview } from '@/engine/playback'

/**
 * Project files (.cineply): new, open, save, save as, recent projects and crash recovery.
 * Media paths are stored absolute plus relative to the project file, so a project folder that was
 * moved or copied to another machine still finds its media.
 */

const EXT = '.cineply'
const RECENT_KEY = 'recentProjects'
const RECENT_MAX = 10
const AUTOSAVE_MS = 2 * 60 * 1000
const RECOVERY_FILE = 'recovery.cineply'

type StoredMedia = MediaItem & { relPath?: string; relPlaybackPath?: string }
interface ProjectFile extends Omit<Project, 'media'> {
  media: StoredMedia[]
  /** Present only in the autosaved recovery copy. */
  recovery?: { filePath: string | null; savedAt: number }
}

const api = (): typeof window.cineply => window.cineply
const toast = (msg: string, kind: 'info' | 'error' = 'info'): void => useUi.getState().showToast(msg, kind)

// --------------------------------------------------------------- paths ----

const splitPath = (p: string): string[] => p.split(/[\\/]+/).filter((s) => s.length > 0)
const isWindowsPath = (p: string): boolean => /^[a-z]:/i.test(p) || p.startsWith('\\\\')

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i <= 0 ? p : p.slice(0, i)
}

/** Relative path from directory `from` to `to`, or undefined when they're on different drives. */
export function relativePath(from: string, to: string): string | undefined {
  const a = splitPath(from)
  const b = splitPath(to)
  const win = isWindowsPath(from) || isWindowsPath(to)
  const same = (x: string, y: string): boolean => (win ? x.toLowerCase() === y.toLowerCase() : x === y)
  if (a.length === 0 || b.length === 0 || !same(a[0], b[0])) return undefined
  let i = 0
  while (i < a.length && i < b.length && same(a[i], b[i])) i++
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/')
}

export function projectNameFromPath(path: string): string {
  const base = api().paths.basename(path)
  return base.toLowerCase().endsWith(EXT) ? base.slice(0, -EXT.length) : base
}

// ------------------------------------------------------- serialization ----

export function serializeProject(project: Project, filePath: string | null): string {
  const dir = filePath ? dirname(filePath) : null
  const file: ProjectFile = {
    ...project,
    version: PROJECT_VERSION,
    media: project.media.map((m) => ({
      ...m,
      relPath: dir ? relativePath(dir, m.path) : undefined,
      relPlaybackPath: dir && m.playbackPath ? relativePath(dir, m.playbackPath) : undefined
    }))
  }
  return JSON.stringify(file, null, 1)
}

/** Fills in fields that older or hand-edited files may lack. */
function normalize(raw: ProjectFile): Project {
  const base = newProject(raw.name || 'Untitled')
  const tracks: Track[] = Array.isArray(raw.tracks) && raw.tracks.length
    ? raw.tracks.map((t) => ({ ...newTrack(t.kind, t.name), ...t, effects: t.effects ?? [] }))
    : base.tracks
  const clips: Clip[] = (raw.clips ?? []).map((c) => {
    const v = defaultVideoProps()
    const a = defaultAudioProps()
    return {
      ...c,
      in: c.in ?? 0,
      speed: c.speed || 1,
      video: { ...v, ...c.video, crop: { ...v.crop, ...c.video?.crop }, keyframes: c.video?.keyframes ?? {}, effects: c.video?.effects ?? [] },
      audio: { ...a, ...c.audio, volumeKeyframes: c.audio?.volumeKeyframes ?? [], effects: c.audio?.effects ?? [] }
    }
  })
  return {
    version: PROJECT_VERSION,
    name: raw.name || base.name,
    sequence: { ...base.sequence, ...raw.sequence },
    tracks,
    clips: clips.filter((c) => tracks.some((t) => t.id === c.trackId)),
    media: (raw.media ?? []) as MediaItem[],
    markers: raw.markers ?? [],
    masterGain: raw.masterGain ?? 1
  }
}

/** Resolves media paths for a project loaded from `filePath`. Returns the number of missing files. */
async function resolveMedia(media: StoredMedia[], filePath: string | null): Promise<{ media: MediaItem[]; missing: number }> {
  const dir = filePath ? dirname(filePath) : null
  const { exists } = api().fs
  const { join } = api().paths
  let missing = 0
  const out = await Promise.all(media.map(async (stored) => {
    const { relPath, relPlaybackPath, ...m } = stored
    const item: MediaItem = { ...m }
    if (!(await exists(item.path))) {
      const candidate = dir && relPath ? join(dir, relPath) : null
      if (candidate && (await exists(candidate))) item.path = candidate
      else missing++
    }
    if (item.playbackPath && !(await exists(item.playbackPath))) {
      const candidate = dir && relPlaybackPath ? join(dir, relPlaybackPath) : null
      if (candidate && (await exists(candidate))) item.playbackPath = candidate
      else delete item.playbackPath
    }
    return item
  }))
  return { media: out, missing }
}

export async function parseProject(text: string, filePath: string | null): Promise<{ project: Project; missing: number; recovery?: ProjectFile['recovery'] }> {
  const raw = JSON.parse(text) as ProjectFile
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.clips)) throw new Error('This is not a Cineply Cut project file.')
  if ((raw.version ?? 1) > PROJECT_VERSION) toast('This project was saved by a newer version of Cineply Cut. Some features may be missing.', 'error')
  const project = normalize(raw)
  const resolved = await resolveMedia(raw.media ?? [], raw.recovery ? raw.recovery.filePath : filePath)
  project.media = resolved.media
  return { project, missing: resolved.missing, recovery: raw.recovery }
}

// -------------------------------------------------------------- recent ----

export async function getRecentProjects(): Promise<string[]> {
  const list = (await api().settings.get<string[]>(RECENT_KEY)) ?? []
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []
}

async function addRecent(path: string): Promise<void> {
  const list = (await getRecentProjects()).filter((p) => p.toLowerCase() !== path.toLowerCase())
  await api().settings.set(RECENT_KEY, [path, ...list].slice(0, RECENT_MAX))
}

async function removeRecent(path: string): Promise<void> {
  const list = await getRecentProjects()
  await api().settings.set(RECENT_KEY, list.filter((p) => p !== path))
}

export async function clearRecentProjects(): Promise<void> {
  await api().settings.set(RECENT_KEY, [])
}

// ------------------------------------------------------------ commands ----

function resetTransport(): void {
  preview.pause()
  const pb = usePlayback.getState()
  pb.setTime(0)
  pb.setRate(1)
  pb.setInOut(null, null)
  useUi.getState().select([])
  useUi.getState().setScrollX(0)
}

/**
 * Asks to save unsaved changes. Returns false when the user cancelled (the caller should stop).
 */
export async function confirmDiscardChanges(): Promise<boolean> {
  const { dirty, project } = useProject.getState()
  if (!dirty) return true
  const choice = await api().dialog.confirm(
    `Save changes to "${project.name}"?`,
    'Your changes will be lost if you don\'t save them.',
    ['Save', 'Don\'t Save', 'Cancel']
  )
  if (choice === 2) return false
  if (choice === 0) return saveProject()
  await removeRecovery()
  return true
}

export async function newProjectCmd(): Promise<boolean> {
  if (!(await confirmDiscardChanges())) return false
  resetTransport()
  useProject.getState().load(newProject(), null)
  return true
}

/** Opens a project from `path`, or asks for one. */
export async function openProjectCmd(path?: string): Promise<boolean> {
  if (!(await confirmDiscardChanges())) return false
  const file = path ?? (await api().dialog.openProject())
  if (!file) return false
  try {
    if (!(await api().fs.exists(file))) {
      await removeRecent(file)
      throw new Error('The file no longer exists.')
    }
    const { project, missing } = await parseProject(await api().fs.readText(file), file)
    project.name = projectNameFromPath(file)
    resetTransport()
    useProject.getState().load(project, file)
    await addRecent(file)
    if (missing) toast(`${missing} media file${missing > 1 ? 's are' : ' is'} missing. Check the media bin.`, 'error')
    return true
  } catch (err) {
    toast(`Couldn't open project: ${(err as Error).message}`, 'error')
    return false
  }
}

async function writeTo(path: string): Promise<boolean> {
  const name = projectNameFromPath(path)
  const store = useProject.getState()
  if (store.project.name !== name) store.mutateSilently((p) => { p.name = name })
  try {
    await api().fs.writeText(path, serializeProject(useProject.getState().project, path))
  } catch (err) {
    toast(`Couldn't save: ${(err as Error).message}`, 'error')
    return false
  }
  useProject.getState().markSaved(path)
  await addRecent(path)
  await removeRecovery()
  toast(`Saved ${name}`)
  return true
}

export async function saveProject(): Promise<boolean> {
  const { filePath } = useProject.getState()
  return filePath ? writeTo(filePath) : saveProjectAs()
}

export async function saveProjectAs(): Promise<boolean> {
  const { project } = useProject.getState()
  let path = await api().dialog.saveProject(`${project.name}${EXT}`)
  if (!path) return false
  if (!path.toLowerCase().endsWith(EXT)) path += EXT
  return writeTo(path)
}

// ------------------------------------------------------------ recovery ----

async function recoveryPath(): Promise<string> {
  return api().paths.join(await api().paths.tempDir(), RECOVERY_FILE)
}

async function removeRecovery(): Promise<void> {
  try {
    await api().fs.remove(await recoveryPath())
  } catch {
    // nothing to remove
  }
}

async function writeRecovery(): Promise<void> {
  const { project, filePath, dirty } = useProject.getState()
  if (!dirty) return
  const file = JSON.parse(serializeProject(project, filePath)) as ProjectFile
  file.recovery = { filePath, savedAt: Date.now() }
  await api().fs.writeText(await recoveryPath(), JSON.stringify(file))
}

/** Writes a recovery copy of unsaved work every 2 minutes. Returns a stop function. */
export function startAutosave(): () => void {
  const timer = setInterval(() => {
    writeRecovery().catch((err) => console.warn('[cineply] autosave failed', err))
  }, AUTOSAVE_MS)
  return () => clearInterval(timer)
}

/** On startup: offers to restore an autosaved copy left behind by a crash or an unsaved quit. */
export async function checkRecovery(): Promise<void> {
  const path = await recoveryPath()
  if (!(await api().fs.exists(path))) return
  try {
    const { project, recovery } = await parseProject(await api().fs.readText(path), null)
    const when = recovery ? new Date(recovery.savedAt).toLocaleString() : 'an earlier session'
    const choice = await api().dialog.confirm(
      `Recover unsaved changes to "${project.name}"?`,
      `Cineply Cut found an autosaved copy from ${when}.`,
      ['Recover', 'Discard']
    )
    if (choice !== 0) {
      await removeRecovery()
      return
    }
    resetTransport()
    useProject.getState().load(project, recovery?.filePath ?? null)
    useProject.setState({ dirty: true })
  } catch (err) {
    console.warn('[cineply] recovery file unreadable', err)
    await removeRecovery()
  }
}
