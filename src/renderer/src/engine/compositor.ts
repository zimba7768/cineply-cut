import {
  clipEnd, sourceTimeAt,
  type BlendMode, type Clip, type MediaItem, type Project, type TransitionSpec, type VideoProps
} from '@shared/types'
import { clipAfter, clipBefore, findMedia } from '@/store/project'
import { valueAt } from '@/lib/keyframes'
import { renderTitle } from '@/engine/titles'
import { getVideoEffect } from '@/engine/effects'
import { getTransition } from '@/engine/transitions'
import type { FrameProvider } from './frames'

export interface RenderOptions {
  /** Output scale relative to sequence size (preview renders smaller for speed). */
  scale: number
}

export interface FrameRequest {
  clip: Clip
  media: MediaItem
  sourceTime: number
}

// ------------------------------------------------------------ planning ----

/** One clip drawn at timeline time t. `local` is t relative to the clip start (may lie outside the clip during transitions). */
interface LayerPlan {
  clip: Clip
  media?: MediaItem
  local: number
  sourceTime: number
}

type TrackItem =
  | { kind: 'clip'; layer: LayerPlan }
  | { kind: 'transition'; spec: TransitionSpec; from: LayerPlan | null; to: LayerPlan | null; p: number }

/** Source time clamped to the media's first..last frame, so clips hold their edge frame when media runs out. */
export function clampSourceTime(project: Project, media: MediaItem, time: number): number {
  const frame = 1 / (media.fps || project.sequence.fps)
  return Math.min(Math.max(0, time), Math.max(0, media.duration - frame))
}

function layerAt(project: Project, clip: Clip, t: number): LayerPlan | null {
  const local = t - clip.start
  if (clip.type === 'media') {
    const media = findMedia(project, clip.mediaId)
    if (!media || media.kind === 'audio' || !media.hasVideo) return null
    const sourceTime = media.kind === 'image' ? 0 : clampSourceTime(project, media, sourceTimeAt(clip, t))
    return { clip, media, local, sourceTime }
  }
  if (clip.type === 'title' && !clip.title) return null
  return { clip, local, sourceTime: 0 }
}

/**
 * What a track shows at time t: a transition (see the TransitionSpec timing rules) or the clip(s) under t.
 */
function planTrack(project: Project, trackId: string, t: number): TrackItem[] {
  const clips = project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start)
  for (const c of clips) {
    const tin = c.transitionIn
    if (tin && tin.duration > 0 && t >= c.start - tin.duration && t < Math.min(clipEnd(c), c.start + tin.duration)) {
      const prev = clipBefore(project, c)
      const s = prev ? c.start - tin.duration / 2 : c.start
      if (t >= s && t < s + tin.duration) {
        const from = prev ? layerAt(project, prev, t) : null
        const to = layerAt(project, c, t)
        if (!from && !to) return []
        return [{ kind: 'transition', spec: tin, from, to, p: (t - s) / tin.duration }]
      }
    }
    const tout = c.transitionOut
    if (tout && tout.duration > 0) {
      const end = clipEnd(c)
      const s = end - tout.duration
      if (t >= s && t >= c.start && t < end && !clipAfter(project, c)) {
        const from = layerAt(project, c, t)
        return from ? [{ kind: 'transition', spec: tout, from, to: null, p: (t - s) / tout.duration }] : []
      }
    }
  }
  const items: TrackItem[] = []
  for (const c of clips) {
    if (t < c.start || t >= clipEnd(c)) continue
    const layer = layerAt(project, c, t)
    if (layer) items.push({ kind: 'clip', layer })
  }
  return items
}

/** Visible video tracks, bottom-up (V1 first). */
function* planFrame(project: Project, t: number): Generator<TrackItem> {
  const tracks = project.tracks.filter((tr) => tr.kind === 'video' && !tr.muted)
  for (let i = tracks.length - 1; i >= 0; i--) yield* planTrack(project, tracks[i].id, t)
}

/**
 * Every (clip, media, sourceTime) frame renderFrame will ask the FrameProvider for at time t,
 * including both sides of active transitions and title background media. Export uses this to
 * decode exactly the needed frames before calling renderFrame.
 * Title background media are fetched with getStill(); they appear here as requests whose clip is the
 * title clip (clip.type === 'title') with sourceTime 0.
 */
export function collectFrameRequests(project: Project, t: number): FrameRequest[] {
  const out: FrameRequest[] = []
  const add = (layer: LayerPlan | null): void => {
    if (!layer) return
    if (layer.media) {
      out.push({ clip: layer.clip, media: layer.media, sourceTime: layer.sourceTime })
    } else if (layer.clip.type === 'title' && layer.clip.title?.background.type === 'media') {
      const media = findMedia(project, layer.clip.title.background.mediaId)
      if (media) out.push({ clip: layer.clip, media, sourceTime: 0 })
    }
  }
  for (const item of planFrame(project, t)) {
    if (item.kind === 'clip') add(item.layer)
    else {
      add(item.from)
      add(item.to)
    }
  }
  return out
}

// ------------------------------------------------------------ surfaces ----

interface Surface {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

const LAYER_FROM = 0
const LAYER_TO = 1
const LAYER_MIX = 2
const LAYER_TITLE = 3

/** Offscreen canvases reused across frames, one set per output size (preview and export sizes can alternate). */
const pools = new Map<string, Surface[]>()

function resetCtx(ctx: CanvasRenderingContext2D): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
}

function surface(index: number, w: number, h: number): Surface {
  const key = `${w}x${h}`
  let pool = pools.get(key)
  if (!pool) {
    pool = []
    pools.set(key, pool)
    if (pools.size > 2) pools.delete(pools.keys().next().value!)
  }
  let s = pool[index]
  if (!s) {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    s = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: false })! }
    pool[index] = s
  }
  resetCtx(s.ctx)
  s.ctx.clearRect(0, 0, w, h)
  return s
}

// ----------------------------------------------------------- rendering ----

interface RenderCtx {
  project: Project
  frames: FrameProvider
  scale: number
  w: number
  h: number
}

function sourceSize(src: CanvasImageSource): [number, number] {
  if (src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight]
  if (src instanceof HTMLImageElement) return [src.naturalWidth, src.naturalHeight]
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return [src.displayWidth, src.displayHeight]
  if (src instanceof SVGImageElement) return [src.width.baseVal.value, src.height.baseVal.value]
  return [(src as { width: number }).width, (src as { height: number }).height]
}

function filterOf(v: VideoProps, scale: number): string {
  const parts: string[] = []
  if (v.brightness !== 1) parts.push(`brightness(${v.brightness})`)
  if (v.contrast !== 1) parts.push(`contrast(${v.contrast})`)
  if (v.saturation !== 1) parts.push(`saturate(${v.saturation})`)
  if (v.hue !== 0) parts.push(`hue-rotate(${v.hue}deg)`)
  if (v.blur > 0) parts.push(`blur(${v.blur * scale}px)`)
  return parts.length ? parts.join(' ') : 'none'
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/** Scale factors that fit a w×h source into the seqW×seqH frame for a VideoProps fit mode (before props.scale). */
export function fitFactors(fit: VideoProps['fit'], w: number, h: number, seqW: number, seqH: number): [number, number] {
  if (fit === 'fit' || fit === 'fill') {
    const f = (fit === 'fit' ? Math.min : Math.max)(seqW / w, seqH / h)
    return [f, f]
  }
  if (fit === 'stretch') return [seqW / w, seqH / h]
  return [1, 1]
}

export function opacityAt(v: VideoProps, local: number): number {
  return clamp01(valueAt(v.keyframes.opacity, local, v.opacity))
}

/** Renders a title clip into the title surface at output size (title coordinates are sequence px). */
function titleSurface(rc: RenderCtx, clip: Clip, local: number): HTMLCanvasElement {
  const { project, frames, scale, w, h } = rc
  const s = surface(LAYER_TITLE, w, h)
  const fps = project.sequence.fps
  const localTime = Math.min(Math.max(0, local), Math.max(0, clip.duration - 1 / fps))
  s.ctx.setTransform(scale, 0, 0, scale, 0, 0)
  renderTitle(s.ctx, clip.title!, localTime, clip.duration, project.sequence.width, project.sequence.height, (id) => {
    const m = findMedia(project, id)
    return m ? frames.getStill(m) : null
  })
  resetCtx(s.ctx)
  return s.canvas
}

/**
 * Draws one clip (media frame, title or colour matte) into ctx with its motion, crop and colour
 * props applied. Opacity is applied as alpha; blend as the composite operation.
 */
function drawClip(ctx: CanvasRenderingContext2D, layer: LayerPlan, rc: RenderCtx, alpha: number, blend: BlendMode): void {
  const { clip, local } = layer
  const { project, scale, w, h } = rc
  const v = clip.video
  const seqW = project.sequence.width
  const seqH = project.sequence.height

  let src: CanvasImageSource | null = null
  let pw: number // source size in pixels (for the crop rect)
  let ph: number
  let lw: number // logical size in sequence px (for fitting)
  let lh: number
  if (clip.type === 'media') {
    src = rc.frames.getFrame(clip, layer.media!, layer.sourceTime)
    if (!src) return
    ;[pw, ph] = sourceSize(src)
    lw = pw
    lh = ph
  } else if (clip.type === 'title') {
    src = titleSurface(rc, clip, local)
    pw = w
    ph = h
    lw = seqW
    lh = seqH
  } else {
    pw = lw = seqW
    ph = lh = seqH
  }
  if (alpha <= 0 || !pw || !ph) return

  const [fx, fy] = fitFactors(v.fit, lw, lh, seqW, seqH)
  const s = valueAt(v.keyframes.scale, local, v.scale)
  const dw = lw * fx * s * scale
  const dh = lh * fy * s * scale
  const left = clamp01(v.crop.left)
  const top = clamp01(v.crop.top)
  const cw = 1 - left - clamp01(v.crop.right)
  const ch = 1 - top - clamp01(v.crop.bottom)
  if (cw <= 0 || ch <= 0 || dw === 0 || dh === 0) return

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.globalCompositeOperation = blend
  ctx.filter = filterOf(v, scale)
  ctx.translate(w / 2 + valueAt(v.keyframes.x, local, v.x) * scale, h / 2 + valueAt(v.keyframes.y, local, v.y) * scale)
  ctx.rotate((valueAt(v.keyframes.rotation, local, v.rotation) * Math.PI) / 180)
  if (v.flipH || v.flipV) ctx.scale(v.flipH ? -1 : 1, v.flipV ? -1 : 1)
  const dx = -dw / 2 + left * dw
  const dy = -dh / 2 + top * dh
  if (src) {
    ctx.drawImage(src, left * pw, top * ph, cw * pw, ch * ph, dx, dy, cw * dw, ch * dh)
  } else {
    ctx.fillStyle = clip.color ?? '#000000'
    ctx.fillRect(dx, dy, cw * dw, ch * dh)
  }
  ctx.restore()
}

function activeEffects(v: VideoProps): VideoProps['effects'] {
  return v.effects.filter((e) => e.enabled && getVideoEffect(e.type))
}

/** Renders a clip into an offscreen layer: transform + colour, then the effect stack, then opacity. */
function renderLayer(index: number, layer: LayerPlan, rc: RenderCtx): HTMLCanvasElement {
  const { w, h } = rc
  const { ctx, canvas } = surface(index, w, h)
  const v = layer.clip.video
  drawClip(ctx, layer, rc, 1, 'source-over')
  for (const fx of activeEffects(v)) {
    ctx.save()
    resetCtx(ctx)
    getVideoEffect(fx.type)!.apply(ctx, canvas, fx.params, layer.local, w, h)
    ctx.restore()
  }
  const opacity = opacityAt(v, layer.local)
  if (opacity < 1) {
    resetCtx(ctx)
    ctx.globalCompositeOperation = 'destination-in'
    ctx.fillStyle = `rgba(0,0,0,${opacity})`
    ctx.fillRect(0, 0, w, h)
    resetCtx(ctx)
  }
  return canvas
}

function composite(ctx: CanvasRenderingContext2D, layer: HTMLCanvasElement, blend: BlendMode): void {
  ctx.save()
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = blend
  ctx.filter = 'none'
  ctx.drawImage(layer, 0, 0)
  ctx.restore()
}

/**
 * Renders the composited sequence frame at timeline time t into ctx (canvas sized
 * sequence.width*scale × sequence.height*scale). Shared by the preview monitor and export so
 * both produce identical frames.
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  t: number,
  frames: FrameProvider,
  opts: RenderOptions
): void {
  const { width, height, background } = project.sequence
  const scale = opts.scale
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  const rc: RenderCtx = { project, frames, scale, w, h }

  ctx.save()
  resetCtx(ctx)
  ctx.fillStyle = background
  ctx.fillRect(0, 0, w, h)

  for (const item of planFrame(project, t)) {
    if (item.kind === 'clip') {
      const { clip, local } = item.layer
      const v = clip.video
      if (activeEffects(v).length === 0) {
        // Fast path: without effects, drawing straight onto the frame equals layer + composite.
        drawClip(ctx, item.layer, rc, opacityAt(v, local), v.blendMode)
      } else {
        composite(ctx, renderLayer(LAYER_FROM, item.layer, rc), v.blendMode)
      }
    } else {
      const from = item.from ? renderLayer(LAYER_FROM, item.from, rc) : null
      const to = item.to ? renderLayer(LAYER_TO, item.to, rc) : null
      const mix = surface(LAYER_MIX, w, h)
      mix.ctx.save()
      getTransition(item.spec.type).render(mix.ctx, from, to, clamp01(item.p), item.spec.params, w, h)
      mix.ctx.restore()
      const blend = (item.to ?? item.from)!.clip.video.blendMode
      composite(ctx, mix.canvas, blend)
    }
  }
  ctx.restore()
}
