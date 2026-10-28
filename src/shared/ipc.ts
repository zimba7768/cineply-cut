// The API the preload script exposes to the renderer as `window.cineply`.

export interface ProbeResult {
  duration: number
  hasVideo: boolean
  hasAudio: boolean
  width?: number
  height?: number
  fps?: number
  videoCodec?: string
  audioCodec?: string
  pixFmt?: string
  formatName: string
  /** True when Chromium can decode it directly (h264/vp8/vp9/av1 video, aac/mp3/opus/vorbis/flac/pcm audio). */
  playable: boolean
}

export interface FfmpegResult {
  code: number | null
  cancelled: boolean
  stderrTail: string // last ~4 KB of ffmpeg stderr, for error messages
}

export interface FfmpegProgress {
  jobId: string
  outTime: number // seconds of output written so far
  speed?: string
  done: boolean
}

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface DownloadProgress {
  jobId: string
  received: number
  total: number // 0 if unknown
}

export interface CineplyApi {
  platform: string
  /** URL the renderer can use in <video>/<audio>/<img>/fetch for a local file path (supports Range requests). */
  mediaUrl(path: string): string

  dialog: {
    openMedia(): Promise<string[]>
    openProject(): Promise<string | null>
    saveProject(defaultName: string): Promise<string | null>
    saveFile(defaultName: string, filters: FileFilter[]): Promise<string | null>
    confirm(message: string, detail?: string, buttons?: string[]): Promise<number>
  }

  media: {
    probe(path: string): Promise<ProbeResult>
    /** Transcode to an H.264/AAC MP4 Chromium can play. Emits ffmpeg progress on jobId. Returns output path. */
    makePlayable(path: string, jobId: string): Promise<string>
    /** Extract a JPEG thumbnail at time t (seconds), width w. Returns output path (cached). */
    thumbnail(path: string, t: number, w: number): Promise<string>
  }

  ffmpeg: {
    /** Run ffmpeg with args (without the leading binary). '-progress pipe:1 -nostats' is added automatically. */
    run(args: string[], jobId: string, durationHint?: number): Promise<FfmpegResult>
    cancel(jobId: string): Promise<void>
    onProgress(cb: (p: FfmpegProgress) => void): () => void
  }

  fs: {
    readText(path: string): Promise<string>
    writeText(path: string, data: string): Promise<void>
    readBinary(path: string): Promise<ArrayBuffer>
    writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void>
    /** Streaming writes (exports). */
    openWrite(path: string): Promise<number>
    write(handle: number, data: ArrayBuffer | Uint8Array, position?: number): Promise<void>
    close(handle: number): Promise<void>
    exists(path: string): Promise<boolean>
    remove(path: string): Promise<void>
    mkdirp(path: string): Promise<void>
  }

  paths: {
    /** Documents/Cineply Cut/Media: generated media (AI results, voiceovers, processed audio, transcodes). */
    mediaDir(): Promise<string>
    tempDir(): Promise<string>
    join(...parts: string[]): string
    basename(path: string): string
  }

  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    /** Encrypted with the OS keychain (safeStorage). For API keys. */
    getSecret(key: string): Promise<string | undefined>
    setSecret(key: string, value: string): Promise<void>
  }

  net: {
    /** Download an https URL to destPath in the main process (no CORS). */
    download(url: string, destPath: string, jobId: string): Promise<void>
    onDownloadProgress(cb: (p: DownloadProgress) => void): () => void
  }

  shell: {
    showItemInFolder(path: string): Promise<void>
    openExternal(url: string): Promise<void>
  }

  app: {
    setDirty(dirty: boolean): void
    setTitle(title: string): void
    /** Native menu actions: 'new' | 'open' | 'save' | 'saveAs' | 'import' | 'export' | 'undo' | 'redo' ... */
    onMenu(cb: (action: string) => void): () => void
  }

  /**
   * Feature modules register extra IPC handlers in the main process under a channel prefix
   * (e.g. 'hf:' for Higgsfield). Only allow-listed prefixes are forwarded.
   */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  on(channel: string, cb: (...args: unknown[]) => void): () => void
}

export const EXTRA_CHANNEL_PREFIXES = ['hf:', 'audio:', 'export:']
