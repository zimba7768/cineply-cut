import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { basename, join } from 'node:path'
import { EXTRA_CHANNEL_PREFIXES, type CineplyApi } from '../shared/ipc'

const inv = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const h = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

function allowed(channel: string): boolean {
  return EXTRA_CHANNEL_PREFIXES.some((p) => channel.startsWith(p))
}

const api: CineplyApi = {
  platform: process.platform,
  getPathForFile: (file) => webUtils.getPathForFile(file),
  mediaUrl: (path) => `cineply-media://file/${encodeURIComponent(path)}`,
  dialog: {
    openMedia: inv('dialog:openMedia') as CineplyApi['dialog']['openMedia'],
    openProject: inv('dialog:openProject') as CineplyApi['dialog']['openProject'],
    saveProject: inv('dialog:saveProject') as CineplyApi['dialog']['saveProject'],
    saveFile: inv('dialog:saveFile') as CineplyApi['dialog']['saveFile'],
    confirm: inv('dialog:confirm') as CineplyApi['dialog']['confirm']
  },
  media: {
    probe: inv('media:probe') as CineplyApi['media']['probe'],
    makePlayable: inv('media:makePlayable') as CineplyApi['media']['makePlayable'],
    thumbnail: inv('media:thumbnail') as CineplyApi['media']['thumbnail']
  },
  ffmpeg: {
    run: inv('ffmpeg:run') as CineplyApi['ffmpeg']['run'],
    cancel: inv('ffmpeg:cancel') as CineplyApi['ffmpeg']['cancel'],
    onProgress: (cb) => listen('ffmpeg:progress', cb)
  },
  fs: {
    readText: inv('fs:readText') as CineplyApi['fs']['readText'],
    writeText: inv('fs:writeText') as CineplyApi['fs']['writeText'],
    readBinary: inv('fs:readBinary') as CineplyApi['fs']['readBinary'],
    writeBinary: inv('fs:writeBinary') as CineplyApi['fs']['writeBinary'],
    openWrite: inv('fs:openWrite') as CineplyApi['fs']['openWrite'],
    write: inv('fs:write') as CineplyApi['fs']['write'],
    close: inv('fs:close') as CineplyApi['fs']['close'],
    exists: inv('fs:exists') as CineplyApi['fs']['exists'],
    remove: inv('fs:remove') as CineplyApi['fs']['remove'],
    mkdirp: inv('fs:mkdirp') as CineplyApi['fs']['mkdirp']
  },
  paths: {
    mediaDir: inv('paths:mediaDir') as CineplyApi['paths']['mediaDir'],
    tempDir: inv('paths:tempDir') as CineplyApi['paths']['tempDir'],
    join: (...parts) => join(...parts),
    basename: (p) => basename(p)
  },
  settings: {
    get: inv('settings:get') as CineplyApi['settings']['get'],
    set: inv('settings:set') as CineplyApi['settings']['set'],
    getSecret: inv('settings:getSecret') as CineplyApi['settings']['getSecret'],
    setSecret: inv('settings:setSecret') as CineplyApi['settings']['setSecret']
  },
  net: {
    download: inv('net:download') as CineplyApi['net']['download'],
    onDownloadProgress: (cb) => listen('net:downloadProgress', cb)
  },
  shell: {
    showItemInFolder: inv('shell:showItemInFolder') as CineplyApi['shell']['showItemInFolder'],
    openPath: inv('shell:openPath') as CineplyApi['shell']['openPath'],
    openExternal: inv('shell:openExternal') as CineplyApi['shell']['openExternal']
  },
  app: {
    setDirty: (d) => ipcRenderer.send('app:setDirty', d),
    setTitle: (t) => ipcRenderer.send('app:setTitle', t),
    onMenu: (cb) => listen('menu', cb)
  },
  invoke: ((channel: string, ...args: unknown[]) => {
    if (!allowed(channel)) return Promise.reject(new Error(`Channel not allowed: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  }) as CineplyApi['invoke'],
  on: (channel, cb) => {
    if (!allowed(channel)) throw new Error(`Channel not allowed: ${channel}`)
    const h = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...args)
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.removeListener(channel, h)
  }
}

contextBridge.exposeInMainWorld('cineply', api)
