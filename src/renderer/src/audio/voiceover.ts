import { create } from 'zustand'
import { preview } from '@/engine/playback'
import { addMediaClip } from '@/lib/editing'
import { importFiles } from '@/lib/importMedia'
import { usePlayback } from '@/store/playback'
import { useUi } from '@/store/ui'

/**
 * Voiceover recording: input device selection with a live level meter, a 3-2-1 countdown, then
 * MediaRecorder capture while the timeline plays from the playhead. On stop the take is saved to
 * <mediaDir>/Voiceover, imported, and placed on the chosen track at the record start time.
 */

export type VoiceoverStatus = 'idle' | 'countdown' | 'recording' | 'saving'

export interface VoiceoverState {
  status: VoiceoverStatus
  countdown: number
  devices: { deviceId: string; label: string }[]
  deviceId: string
  trackId: string | null
  /** Browser echo cancellation / noise suppression (off by default for clean recordings). */
  cleanup: boolean
  startedAt: number // timeline time the take starts at
  elapsed: number
  error: string | null
  set(patch: Partial<Pick<VoiceoverState, 'deviceId' | 'trackId' | 'cleanup'>>): void
}

export const useVoiceover = create<VoiceoverState>((set) => ({
  status: 'idle',
  countdown: 0,
  devices: [],
  deviceId: 'default',
  trackId: null,
  cleanup: false,
  startedAt: 0,
  elapsed: 0,
  error: null,
  set: (patch) => set(patch)
}))

let stream: MediaStream | null = null
let streamKey = ''
let meterCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let meterData: Float32Array<ArrayBuffer> | null = null
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let countdownTimer: ReturnType<typeof setTimeout> | undefined
let elapsedTimer: ReturnType<typeof setInterval> | undefined
let recordStartPerf = 0

const fail = (message: string): void => {
  useVoiceover.setState({ error: message })
  useUi.getState().showToast(message, 'error')
}

/** Lists audio inputs. Device labels are only exposed after microphone permission, so ask once. */
export async function refreshDevices(): Promise<void> {
  try {
    if (!stream) await openInput()
    const all = await navigator.mediaDevices.enumerateDevices()
    const devices = all
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
    const { deviceId } = useVoiceover.getState()
    useVoiceover.setState({
      devices,
      deviceId: devices.some((d) => d.deviceId === deviceId) ? deviceId : devices[0]?.deviceId ?? 'default',
      error: devices.length ? null : 'No microphone found'
    })
  } catch (err) {
    useVoiceover.setState({ error: `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}` })
  }
}

/** Opens (or re-opens on device/option change) the selected input and attaches the level meter. */
export async function openInput(): Promise<MediaStream> {
  const { deviceId, cleanup } = useVoiceover.getState()
  const key = `${deviceId}|${cleanup}`
  if (stream && key === streamKey && stream.active) return stream
  closeInput()
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
      echoCancellation: cleanup,
      noiseSuppression: cleanup,
      autoGainControl: false,
      channelCount: { ideal: 1 }
    }
  })
  streamKey = key
  meterCtx ??= new AudioContext()
  const src = meterCtx.createMediaStreamSource(stream)
  analyser = meterCtx.createAnalyser()
  analyser.fftSize = 1024
  meterData = new Float32Array(analyser.fftSize)
  src.connect(analyser)
  if (meterCtx.state !== 'running') void meterCtx.resume()
  return stream
}

/** Releases the microphone (unless recording). */
export function closeInput(): void {
  if (recorder || useVoiceover.getState().status !== 'idle') return
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  streamKey = ''
  analyser?.disconnect()
  analyser = null
}

/** Current input peak level, 0..1. */
export function inputLevel(): number {
  if (!analyser || !meterData) return 0
  analyser.getFloatTimeDomainData(meterData)
  let m = 0
  for (let i = 0; i < meterData.length; i++) m = Math.max(m, Math.abs(meterData[i]))
  return m
}

function pickMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return options.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

/** Starts the 3-2-1 countdown, then records while the timeline plays. */
export async function startVoiceover(): Promise<void> {
  const st = useVoiceover.getState()
  if (st.status !== 'idle') return
  if (!st.trackId) return fail('Choose an audio track to record onto')
  try {
    await openInput()
  } catch (err) {
    return fail(`Could not open the microphone: ${err instanceof Error ? err.message : String(err)}`)
  }
  preview.pause()
  useVoiceover.setState({ status: 'countdown', countdown: 3, error: null, elapsed: 0 })
  const tick = (n: number): void => {
    if (useVoiceover.getState().status !== 'countdown') return
    if (n > 0) {
      useVoiceover.setState({ countdown: n })
      countdownTimer = setTimeout(() => tick(n - 1), 1000)
    } else beginRecording()
  }
  tick(3)
}

function beginRecording(): void {
  if (!stream) return fail('The microphone was closed')
  chunks = []
  const mimeType = pickMime()
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 192000 } : undefined)
  } catch (err) {
    useVoiceover.setState({ status: 'idle' })
    return fail(`Recording is not supported: ${err instanceof Error ? err.message : String(err)}`)
  }
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const startedAt = usePlayback.getState().time
  recorder.start(1000)
  preview.play()
  recordStartPerf = performance.now()
  useVoiceover.setState({ status: 'recording', countdown: 0, startedAt, elapsed: 0 })
  elapsedTimer = setInterval(() => useVoiceover.setState({ elapsed: (performance.now() - recordStartPerf) / 1000 }), 100)
}

/** Cancels a countdown, or stops recording and saves/places the take. */
export async function stopVoiceover(): Promise<void> {
  const st = useVoiceover.getState()
  clearTimeout(countdownTimer)
  if (st.status === 'countdown') {
    useVoiceover.setState({ status: 'idle', countdown: 0 })
    return
  }
  if (st.status !== 'recording' || !recorder) return
  clearInterval(elapsedTimer)
  preview.pause()
  const rec = recorder
  useVoiceover.setState({ status: 'saving' })
  const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()))
  rec.stop()
  await stopped
  recorder = null
  try {
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
    chunks = []
    if (blob.size === 0) throw new Error('Nothing was recorded')
    await saveTake(blob, st.startedAt, st.trackId!)
  } catch (err) {
    fail(`Voiceover failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    useVoiceover.setState({ status: 'idle', elapsed: 0 })
  }
}

async function saveTake(blob: Blob, start: number, trackId: string): Promise<void> {
  const api = window.cineply
  const dir = api.paths.join(await api.paths.mediaDir(), 'Voiceover')
  await api.fs.mkdirp(dir)
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  const ext = blob.type.includes('ogg') ? 'ogg' : 'webm'
  const finalPath = api.paths.join(dir, `voiceover-${stamp}.${ext}`)
  // MediaRecorder files lack duration/cues; a stream-copy remux fixes that so probing and seeking work.
  const rawPath = api.paths.join(await api.paths.tempDir(), `voiceover-${stamp}.raw.${ext}`)
  await api.fs.writeBinary(rawPath, await blob.arrayBuffer())
  const r = await api.ffmpeg.run(['-i', rawPath, '-c', 'copy', finalPath], `voiceover-remux-${stamp}`).catch(() => null)
  if (!r || r.code !== 0) await api.fs.writeBinary(finalPath, await blob.arrayBuffer())
  await api.fs.remove(rawPath).catch(() => undefined)

  const [media] = await importFiles([finalPath], { source: 'voiceover' })
  if (!media) throw new Error('Import of the recording failed')
  addMediaClip(media.id, { start, trackId })
  useUi.getState().showToast(`Voiceover recorded: ${media.name}`)
}
