// Cineply Cut project data model. Shared by the main process and the renderer.
// All times are in seconds (floating point). Positions are in sequence pixels
// unless noted. A project serializes to JSON as-is (*.cineply files).

export type Id = string

export const PROJECT_VERSION = 1

export interface SequenceSettings {
  width: number
  height: number
  fps: number
  sampleRate: number // audio sample rate, 48000
  background: string // CSS color shown where no clip covers the frame
}

export const SEQUENCE_PRESETS: { id: string; label: string; width: number; height: number; fps: number }[] = [
  { id: '1080p30', label: '1080p HD 16:9 (30 fps)', width: 1920, height: 1080, fps: 30 },
  { id: '1080p60', label: '1080p HD 16:9 (60 fps)', width: 1920, height: 1080, fps: 60 },
  { id: '1080p24', label: '1080p HD 16:9 (24 fps)', width: 1920, height: 1080, fps: 24 },
  { id: '4k30', label: '4K UHD 16:9 (30 fps)', width: 3840, height: 2160, fps: 30 },
  { id: 'vertical30', label: 'Vertical 9:16 (1080×1920, 30 fps)', width: 1080, height: 1920, fps: 30 },
  { id: 'square30', label: 'Square 1:1 (1080×1080, 30 fps)', width: 1080, height: 1080, fps: 30 }
]

// ---------------------------------------------------------------- media ----

export type MediaKind = 'video' | 'audio' | 'image'
export type MediaSource = 'import' | 'higgsfield' | 'voiceover' | 'processed' | 'title-render'

export interface MediaItem {
  id: Id
  name: string
  path: string // absolute path of the original file
  playbackPath?: string // transcoded H.264/AAC copy when the original isn't playable in Chromium
  kind: MediaKind
  duration: number // seconds; images use 5 as a nominal default
  width?: number
  height?: number
  fps?: number
  hasVideo: boolean
  hasAudio: boolean
  videoCodec?: string
  audioCodec?: string
  source: MediaSource
  ai?: { provider: 'higgsfield'; prompt: string; model: string; jobId?: string }
  status?: 'ready' | 'transcoding' | 'error'
  error?: string
}

// ----------------------------------------------------------- keyframes ----

/** t is relative to the clip's timeline start, in seconds. */
export interface Keyframe {
  t: number
  v: number
  ease?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold'
}

// --------------------------------------------------------------- video -----

/** Subset of canvas globalCompositeOperation values offered as blend modes. */
export type BlendMode =
  | 'source-over' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity' | 'lighter'

export interface VideoEffect {
  id: Id
  type: string // key into the video effect registry (renderer/src/engine/effects)
  enabled: boolean
  params: Record<string, number | string | boolean>
}

export interface VideoProps {
  x: number // offset of the clip centre from the frame centre, sequence px
  y: number
  scale: number // 1 = "fit to frame" (letterboxed), see fit
  fit: 'fit' | 'fill' | 'stretch' | 'none'
  rotation: number // degrees
  opacity: number // 0..1
  flipH: boolean
  flipV: boolean
  crop: { left: number; right: number; top: number; bottom: number } // fractions 0..1
  blendMode: BlendMode
  brightness: number // 1 = unchanged (CSS filter semantics)
  contrast: number
  saturation: number
  hue: number // degrees
  blur: number // px
  effects: VideoEffect[]
  /** Keyframed overrides of the numeric props above, keyed by prop name (x, y, scale, rotation, opacity...). */
  keyframes: Partial<Record<'x' | 'y' | 'scale' | 'rotation' | 'opacity', Keyframe[]>>
}

// --------------------------------------------------------------- audio -----

export interface AudioEffect {
  id: Id
  type: 'eq' | 'compressor' | 'reverb' | 'delay' | 'gain' | 'highpass' | 'lowpass' | 'noiseGate' | string
  enabled: boolean
  params: Record<string, number | string | boolean>
}

export interface AudioProps {
  gain: number // linear, 1 = 0 dB
  pan: number // -1..1
  mute: boolean
  fadeIn: number // seconds
  fadeOut: number // seconds
  /** Volume envelope (linear gain multipliers) relative to clip start. Empty = flat. */
  volumeKeyframes: Keyframe[]
  effects: AudioEffect[]
}

// ---------------------------------------------------------- transitions ----

/**
 * A transition attached to a clip edge.
 * transitionIn on clip B: blends from the clip that ends where B starts (same track) to B,
 * centred on the cut: [B.start - duration/2, B.start + duration/2].
 * If no clip touches B's start, it blends from "nothing" (the tracks underneath) to B,
 * over [B.start, B.start + duration].
 * transitionOut on a clip is only used when no clip follows it: it blends the clip to
 * "nothing" over [end - duration, end].
 * When a source runs out of media during the transition its edge frame is held.
 */
export interface TransitionSpec {
  type: string // key into the transition registry (renderer/src/engine/transitions)
  duration: number
  params: Record<string, number | string | boolean>
}

// --------------------------------------------------------------- titles ----

export type TitleAnimation =
  | 'none' | 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right'
  | 'zoom' | 'pop' | 'typewriter' | 'blur' | 'wipe' | 'letter-fade'

export interface TitleTextLayer {
  id: Id
  text: string
  fontFamily: string
  fontSize: number // px at sequence resolution
  fontWeight: number
  italic: boolean
  color: string
  align: 'left' | 'center' | 'right'
  x: number // 0..1 of frame width (anchor point, align decides which edge)
  y: number // 0..1 of frame height (text block vertical centre)
  letterSpacing: number // px
  lineHeight: number // multiplier
  uppercase: boolean
  stroke: { enabled: boolean; color: string; width: number }
  shadow: { enabled: boolean; color: string; blur: number; x: number; y: number }
  box: { enabled: boolean; color: string; padding: number; radius: number } // background plate behind text
  animIn: { type: TitleAnimation; duration: number }
  animOut: { type: TitleAnimation; duration: number }
}

export interface TitleShapeLayer {
  id: Id
  kind: 'rect' | 'line'
  x: number; y: number; w: number; h: number // 0..1 of frame
  color: string
  radius: number
  animIn: { type: TitleAnimation; duration: number }
  animOut: { type: TitleAnimation; duration: number }
}

export interface TitleSpec {
  template?: string
  background:
    | { type: 'none' }
    | { type: 'solid'; color: string }
    | { type: 'gradient'; from: string; to: string; angle: number }
    | { type: 'media'; mediaId: Id; dim: number } // image/video still behind the text, dim 0..1
  texts: TitleTextLayer[]
  shapes: TitleShapeLayer[]
}

// ---------------------------------------------------------------- clips ----

export type ClipType = 'media' | 'title' | 'color'

export interface Clip {
  id: Id
  trackId: Id
  type: ClipType
  name: string
  start: number // timeline position of the clip's first frame
  duration: number // timeline duration (already accounts for speed)
  in: number // source offset in seconds (media clips)
  speed: number // 1 = normal; source advances speed× timeline time
  mediaId?: Id // media clips
  title?: TitleSpec // title clips
  color?: string // color matte clips
  linkId?: Id // clips sharing a linkId move/trim/delete together (video + its audio)
  video: VideoProps // ignored on audio tracks
  audio: AudioProps // ignored on video tracks (video tracks are silent; their sound lives on a linked audio clip)
  transitionIn?: TransitionSpec
  transitionOut?: TransitionSpec
  label?: string // UI colour label
}

// --------------------------------------------------------------- tracks ----

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: Id
  kind: TrackKind
  name: string // V1, V2, A1...
  muted: boolean // video: hidden from output; audio: silent
  solo: boolean // audio only
  locked: boolean
  gain: number // audio track volume, linear
  pan: number
  effects: AudioEffect[] // audio track effect rack (applied after clip effects)
  height: number // UI px
}

export interface Marker {
  id: Id
  time: number
  name: string
  color: string
}

export interface Project {
  version: number
  name: string
  sequence: SequenceSettings
  /**
   * Track order: video tracks first, listed top-most first (V3, V2, V1), then audio tracks A1, A2...
   * Compositing draws video tracks bottom-up (V1 first, so higher tracks cover lower ones).
   */
  tracks: Track[]
  clips: Clip[]
  media: MediaItem[]
  markers: Marker[]
  masterGain: number
}

// ------------------------------------------------------------- defaults ----

export function defaultVideoProps(): VideoProps {
  return {
    x: 0, y: 0, scale: 1, fit: 'fit', rotation: 0, opacity: 1, flipH: false, flipV: false,
    crop: { left: 0, right: 0, top: 0, bottom: 0 }, blendMode: 'source-over',
    brightness: 1, contrast: 1, saturation: 1, hue: 0, blur: 0, effects: [], keyframes: {}
  }
}

export function defaultAudioProps(): AudioProps {
  return { gain: 1, pan: 0, mute: false, fadeIn: 0, fadeOut: 0, volumeKeyframes: [], effects: [] }
}

export function clipEnd(c: Clip): number {
  return c.start + c.duration
}

/** Source time (seconds into the media file) shown at timeline time t. */
export function sourceTimeAt(c: Clip, t: number): number {
  return c.in + (t - c.start) * c.speed
}
