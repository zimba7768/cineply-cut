import { app, BrowserWindow, Menu, dialog, ipcMain, protocol, safeStorage, shell } from 'electron'
import { createReadStream, existsSync, promises as fsp, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { ffmpegPath, ffprobe, makePlayable, runFfmpeg, cancelFfmpeg, thumbnail } from './ffmpeg'
import { registerHiggsfieldIpc } from './higgsfield'
import { registerAudioIpc } from './audio'
import { registerExportIpc } from './export'

const MEDIA_SCHEME = 'cineply-media'

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true }
  }
])

let mainWindow: BrowserWindow | null = null
let dirty = false

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml'
}

/** Serves local files as cineply-media://file/<encoded path> with HTTP Range support (needed for video seeking). */
function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (!existsSync(filePath)) return new Response('Not found', { status: 404 })
    const size = statSync(filePath).size
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const range = request.headers.get('range')
    const headers: Record<string, string> = {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*'
    }
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1
      if (!m || !m[1]) {
        // suffix range: bytes=-N
        if (m && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1 }
      }
      end = Math.min(end, size - 1)
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream
      return new Response(stream, {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
      })
    }
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream
    return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
  })
}

// ------------------------------------------------------------- settings ----

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')
let settingsCache: Record<string, unknown> | null = null

async function loadSettings(): Promise<Record<string, unknown>> {
  if (settingsCache) return settingsCache
  try {
    settingsCache = JSON.parse(await fsp.readFile(settingsFile(), 'utf8'))
  } catch {
    settingsCache = {}
  }
  return settingsCache!
}

async function saveSettings(): Promise<void> {
  await fsp.writeFile(settingsFile(), JSON.stringify(settingsCache ?? {}, null, 2), 'utf8')
}

export async function getSetting<T = unknown>(key: string): Promise<T | undefined> {
  return (await loadSettings())[key] as T | undefined
}

export async function getSecret(key: string): Promise<string | undefined> {
  const s = await loadSettings()
  const enc = s[`secret:${key}`]
  if (typeof enc !== 'string') return undefined
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : enc
  } catch {
    return undefined
  }
}

async function setSecret(key: string, value: string): Promise<void> {
  const s = await loadSettings()
  if (!value) delete s[`secret:${key}`]
  else s[`secret:${key}`] = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : value
  await saveSettings()
}

export async function mediaDir(): Promise<string> {
  const dir = join(app.getPath('documents'), 'Cineply Cut', 'Media')
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

export function send(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args)
}

// ------------------------------------------------------------------ IPC ----

const openHandles = new Map<number, fsp.FileHandle>()
let nextHandle = 1

function toBuffer(data: ArrayBuffer | Uint8Array): Buffer {
  return data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data)
}

function registerIpc(): void {
  const mediaExts = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mts', 'm2ts', 'wmv', 'flv', 'mpg', 'mpeg', '3gp',
    'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wma', 'aif', 'aiff',
    'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']

  ipcMain.handle('dialog:openMedia', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Media', extensions: mediaExts }, { name: 'All files', extensions: ['*'] }]
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('dialog:openProject', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: 'Open project', properties: ['openFile'], filters: [{ name: 'Cineply Cut project', extensions: ['cineply'] }]
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:saveProject', async (_e, defaultName: string) => {
    const r = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save project', defaultPath: defaultName, filters: [{ name: 'Cineply Cut project', extensions: ['cineply'] }]
    })
    return r.canceled ? null : r.filePath
  })
  ipcMain.handle('dialog:saveFile', async (_e, defaultName: string, filters: Electron.FileFilter[]) => {
    const r = await dialog.showSaveDialog(mainWindow!, { defaultPath: defaultName, filters })
    return r.canceled ? null : r.filePath
  })
  ipcMain.handle('dialog:confirm', async (_e, message: string, detail?: string, buttons?: string[]) => {
    const r = await dialog.showMessageBox(mainWindow!, {
      type: 'question', message, detail, buttons: buttons ?? ['OK', 'Cancel'], defaultId: 0, cancelId: (buttons?.length ?? 2) - 1
    })
    return r.response
  })

  ipcMain.handle('media:probe', (_e, path: string) => ffprobe(path))
  ipcMain.handle('media:makePlayable', async (_e, path: string, jobId: string) => makePlayable(path, jobId, await mediaDir()))
  ipcMain.handle('media:thumbnail', async (_e, path: string, t: number, w: number) => thumbnail(path, t, w))

  ipcMain.handle('ffmpeg:run', (_e, args: string[], jobId: string, durationHint?: number) => runFfmpeg(args, jobId, durationHint))
  ipcMain.handle('ffmpeg:cancel', (_e, jobId: string) => cancelFfmpeg(jobId))

  ipcMain.handle('fs:readText', (_e, p: string) => fsp.readFile(p, 'utf8'))
  ipcMain.handle('fs:writeText', (_e, p: string, d: string) => fsp.writeFile(p, d, 'utf8'))
  ipcMain.handle('fs:readBinary', async (_e, p: string) => {
    const b = await fsp.readFile(p)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  })
  ipcMain.handle('fs:writeBinary', (_e, p: string, d: ArrayBuffer | Uint8Array) => fsp.writeFile(p, toBuffer(d)))
  ipcMain.handle('fs:openWrite', async (_e, p: string) => {
    const h = await fsp.open(p, 'w')
    const id = nextHandle++
    openHandles.set(id, h)
    return id
  })
  ipcMain.handle('fs:write', async (_e, id: number, d: ArrayBuffer | Uint8Array, position?: number) => {
    const h = openHandles.get(id)
    if (!h) throw new Error('Invalid file handle')
    const buf = toBuffer(d)
    await h.write(buf, 0, buf.length, position ?? null)
  })
  ipcMain.handle('fs:close', async (_e, id: number) => {
    await openHandles.get(id)?.close()
    openHandles.delete(id)
  })
  ipcMain.handle('fs:exists', (_e, p: string) => existsSync(p))
  ipcMain.handle('fs:remove', (_e, p: string) => fsp.rm(p, { force: true }))
  ipcMain.handle('fs:mkdirp', (_e, p: string) => fsp.mkdir(p, { recursive: true }))

  ipcMain.handle('paths:mediaDir', () => mediaDir())
  ipcMain.handle('paths:tempDir', async () => {
    const d = join(app.getPath('temp'), 'cineply-cut')
    await fsp.mkdir(d, { recursive: true })
    return d
  })

  ipcMain.handle('settings:get', async (_e, key: string) => (await loadSettings())[key])
  ipcMain.handle('settings:set', async (_e, key: string, value: unknown) => {
    const s = await loadSettings()
    s[key] = value
    await saveSettings()
  })
  ipcMain.handle('settings:getSecret', (_e, key: string) => getSecret(key))
  ipcMain.handle('settings:setSecret', (_e, key: string, value: string) => setSecret(key, value))

  ipcMain.handle('net:download', async (_e, url: string, destPath: string, jobId: string) => {
    if (!/^https:\/\//i.test(url)) throw new Error('Only https downloads are allowed')
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? 0)
    const fh = await fsp.open(destPath, 'w')
    let received = 0
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await fh.write(value)
        received += value.byteLength
        send('net:downloadProgress', { jobId, received, total })
      }
    } finally {
      await fh.close()
    }
  })

  ipcMain.handle('shell:showItemInFolder', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })

  ipcMain.on('app:setDirty', (_e, d: boolean) => { dirty = d })
  ipcMain.on('app:setTitle', (_e, t: string) => mainWindow?.setTitle(t))
}

function buildMenu(): void {
  const act = (action: string) => () => send('menu', action)
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: act('new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: act('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: act('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: act('saveAs') },
        { type: 'separator' },
        { label: 'Import Media…', accelerator: 'CmdOrCtrl+I', click: act('import') },
        { label: 'Export…', accelerator: 'CmdOrCtrl+M', click: act('export') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: act('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: act('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'Sequence',
      submenu: [
        { label: 'Sequence Settings…', click: act('sequenceSettings') },
        { label: 'Add Video Track', click: act('addVideoTrack') },
        { label: 'Add Audio Track', click: act('addAudioTrack') },
        { label: 'New Title', accelerator: 'CmdOrCtrl+T', click: act('newTitle') }
      ]
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: act('shortcuts') },
        { label: 'Cineply Cut on GitHub', click: () => shell.openExternal('https://github.com/zimba7768/cineply-cut') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#16171b',
    title: 'Cineply Cut',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (e) => {
    if (!dirty) return
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning', message: 'You have unsaved changes.', detail: 'Quit without saving?',
      buttons: ['Quit without saving', 'Cancel'], defaultId: 1, cancelId: 1
    })
    if (choice !== 0) e.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Allow the microphone for voiceover recording.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'clipboard-sanitized-write')
  })

  if (process.env['ELECTRON_RENDERER_URL']) mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  console.log(`[cineply] ffmpeg: ${ffmpegPath()}`)
  registerMediaProtocol()
  registerIpc()
  registerHiggsfieldIpc()
  registerAudioIpc()
  registerExportIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

export { basename }
