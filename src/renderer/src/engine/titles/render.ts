import type { TitleAnimation, TitleShapeLayer, TitleSpec, TitleTextLayer } from '@shared/types'
import { clamp01, easeOut, easeOutBack, smoothstep, sourceSize } from '@/engine/effects/util'
import { cssFontFamily } from './fonts'

type Anim = { type: TitleAnimation; duration: number }

/** Animation state of a layer at one instant; the identity state is "at rest". */
interface AnimState {
  alpha: number
  dx: number
  dy: number
  scale: number
  blur: number // px at sequence resolution
  reveal: number // typewriter: fraction of characters shown
  letter: number // letter-fade progress (1 = all letters visible)
  wipeFrom: number // visible horizontal span of the layer, fractions of its width
  wipeTo: number
}

function progress(t: number, duration: number): number {
  return duration > 0 ? clamp01(t / duration) : 1
}

/**
 * Folds one animation into the state. q goes 0 (hidden) → 1 (at rest). `entering` is false for out
 * animations, which run in reverse; slides keep their direction (slide-up exits upwards).
 */
function applyAnim(st: AnimState, type: TitleAnimation, q: number, entering: boolean, w: number, h: number): void {
  if (type === 'none' || q >= 1) return
  const e = easeOut(q)
  const sign = entering ? 1 : -1
  switch (type) {
    case 'fade':
      st.alpha *= smoothstep(0, 1, q)
      break
    case 'slide-up':
    case 'slide-down':
    case 'slide-left':
    case 'slide-right': {
      const vertical = type === 'slide-up' || type === 'slide-down'
      const dist = (1 - e) * (vertical ? h * 0.08 : w * 0.1)
      const toward = type === 'slide-up' || type === 'slide-left' ? 1 : -1
      if (vertical) st.dy += dist * toward * sign
      else st.dx += dist * toward * sign
      st.alpha *= clamp01(q * 1.6)
      break
    }
    case 'zoom':
      st.scale *= entering ? 0.6 + 0.4 * e : 1 + 0.4 * (1 - e)
      st.alpha *= e
      break
    case 'pop':
      st.scale *= Math.max(0, easeOutBack(q, 2.2))
      st.alpha *= clamp01(q * 4)
      break
    case 'typewriter':
      st.reveal = Math.min(st.reveal, q)
      break
    case 'blur':
      st.blur += (1 - e) * 28
      st.alpha *= smoothstep(0, 1, q)
      break
    case 'wipe':
      if (entering) st.wipeTo = Math.min(st.wipeTo, e)
      else st.wipeFrom = Math.max(st.wipeFrom, 1 - e)
      break
    case 'letter-fade':
      st.letter = Math.min(st.letter, q)
      break
  }
}

function animState(animIn: Anim, animOut: Anim, local: number, clipDuration: number, w: number, h: number): AnimState {
  const st: AnimState = { alpha: 1, dx: 0, dy: 0, scale: 1, blur: 0, reveal: 1, letter: 1, wipeFrom: 0, wipeTo: 1 }
  applyAnim(st, animIn.type, progress(local, animIn.duration), true, w, h)
  applyAnim(st, animOut.type, progress(clipDuration - local, animOut.duration), false, w, h)
  return st
}

/** Scale of the current transform; shadow and filter lengths are not transformed, so scale them by hand. */
function deviceScale(ctx: CanvasRenderingContext2D): number {
  const m = ctx.getTransform()
  return Math.hypot(m.a, m.b) || 1
}

/** Applies the animation transform (offset + scale about cx, cy), opacity, blur and wipe clip. */
function enterAnim(ctx: CanvasRenderingContext2D, st: AnimState, cx: number, cy: number, left: number, width: number, h: number): void {
  ctx.globalAlpha *= clamp01(st.alpha)
  ctx.translate(cx + st.dx, cy + st.dy)
  ctx.scale(st.scale, st.scale)
  ctx.translate(-cx, -cy)
  if (st.blur > 0.05) ctx.filter = `blur(${(st.blur * deviceScale(ctx)).toFixed(2)}px)`
  if (st.wipeFrom > 0 || st.wipeTo < 1) {
    ctx.beginPath()
    ctx.rect(left + width * st.wipeFrom, -h, width * Math.max(0, st.wipeTo - st.wipeFrom), h * 3)
    ctx.clip()
  }
}

// ----------------------------------------------------------- background ----

function drawBackground(
  ctx: CanvasRenderingContext2D,
  bg: TitleSpec['background'],
  w: number,
  h: number,
  getImage: (mediaId: string) => CanvasImageSource | null
): void {
  switch (bg.type) {
    case 'solid':
      ctx.fillStyle = bg.color
      ctx.fillRect(0, 0, w, h)
      break
    case 'gradient': {
      // CSS convention: 0° points up, 90° points right.
      const a = (bg.angle * Math.PI) / 180
      const vx = Math.sin(a)
      const vy = -Math.cos(a)
      const half = Math.abs((w / 2) * vx) + Math.abs((h / 2) * vy)
      const g = ctx.createLinearGradient(w / 2 - vx * half, h / 2 - vy * half, w / 2 + vx * half, h / 2 + vy * half)
      g.addColorStop(0, bg.from)
      g.addColorStop(1, bg.to)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      break
    }
    case 'media': {
      const img = getImage(bg.mediaId)
      if (img) {
        const s = sourceSize(img)
        if (s.w > 0 && s.h > 0) {
          const k = Math.max(w / s.w, h / s.h)
          ctx.drawImage(img, (w - s.w * k) / 2, (h - s.h * k) / 2, s.w * k, s.h * k)
        }
      }
      if (bg.dim > 0) {
        ctx.fillStyle = `rgba(0,0,0,${clamp01(bg.dim)})`
        ctx.fillRect(0, 0, w, h)
      }
      break
    }
  }
}

// --------------------------------------------------------------- shapes ----

function drawShape(ctx: CanvasRenderingContext2D, s: TitleShapeLayer, local: number, dur: number, w: number, h: number): void {
  const st = animState(s.animIn, s.animOut, local, dur, w, h)
  // Typewriter reveals a shape like a wipe; letter-fade fades it.
  st.wipeTo = Math.min(st.wipeTo, st.reveal)
  st.alpha *= st.letter
  if (st.alpha <= 0.001 || st.scale <= 0.001 || st.wipeTo <= st.wipeFrom) return
  const x = s.x * w
  const y = s.y * h
  const sw = s.w * w
  const sh = s.h * h
  ctx.save()
  enterAnim(ctx, st, x + sw / 2, y + sh / 2, x, sw, h)
  ctx.fillStyle = s.color
  // A line is a bar with fully rounded caps along its longer side.
  const r = s.kind === 'line' ? Math.min(Math.abs(sw), Math.abs(sh)) / 2 : Math.min(s.radius, Math.abs(sw) / 2, Math.abs(sh) / 2)
  ctx.beginPath()
  ctx.roundRect(x, y, sw, sh, Math.max(0, r))
  ctx.fill()
  ctx.restore()
}

// ----------------------------------------------------------------- text ----

export function titleFont(t: Pick<TitleTextLayer, 'italic' | 'fontWeight' | 'fontSize' | 'fontFamily'>): string {
  return `${t.italic ? 'italic ' : ''}${t.fontWeight} ${Math.max(1, t.fontSize)}px ${cssFontFamily(t.fontFamily)}`
}

function drawText(ctx: CanvasRenderingContext2D, t: TitleTextLayer, local: number, dur: number, w: number, h: number): void {
  const st = animState(t.animIn, t.animOut, local, dur, w, h)
  if (st.alpha <= 0.001 || st.scale <= 0.001 || st.wipeTo <= st.wipeFrom) return
  const text = t.uppercase ? t.text.toUpperCase() : t.text
  const lines = text.split('\n').map((l) => Array.from(l))

  ctx.save()
  ctx.font = titleFont(t)
  ctx.letterSpacing = `${t.letterSpacing}px`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  // Canvas adds letter spacing after every glyph, including the last; drop that trailing gap.
  const measure = (s: string): number => (s ? ctx.measureText(s).width - t.letterSpacing : 0)
  const widths = lines.map((l) => measure(l.join('')))
  const lh = t.fontSize * t.lineHeight
  const blockW = Math.max(0, ...widths)
  const blockH = lines.length * lh
  const anchor = t.x * w
  const left = t.align === 'left' ? anchor : t.align === 'center' ? anchor - blockW / 2 : anchor - blockW
  const top = t.y * h - blockH / 2
  const m = ctx.measureText('Hg')
  const ascent = m.fontBoundingBoxAscent || t.fontSize * 0.8
  const descent = m.fontBoundingBoxDescent || t.fontSize * 0.2
  const baselineShift = (ascent - descent) / 2

  const pad = t.box.enabled ? t.box.padding : 0
  const margin = pad + (t.stroke.enabled ? t.stroke.width : 0) + (t.shadow.enabled ? t.shadow.blur + Math.abs(t.shadow.x) : 0)
  enterAnim(ctx, st, left + blockW / 2, t.y * h, left - margin, blockW + margin * 2, h)

  if (t.box.enabled) {
    ctx.save()
    ctx.globalAlpha *= st.letter < 1 ? smoothstep(0, 0.4, st.letter) : 1
    ctx.fillStyle = t.box.color
    ctx.beginPath()
    ctx.roundRect(left - pad, top - pad, blockW + pad * 2, blockH + pad * 2, Math.max(0, Math.min(t.box.radius, (blockH + pad * 2) / 2)))
    ctx.fill()
    ctx.restore()
  }

  const ds = deviceScale(ctx)
  const shadow = (on: boolean): void => {
    if (on && t.shadow.enabled) {
      ctx.shadowColor = t.shadow.color
      ctx.shadowBlur = t.shadow.blur * ds
      ctx.shadowOffsetX = t.shadow.x * ds
      ctx.shadowOffsetY = t.shadow.y * ds
    } else {
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
    }
  }
  const stroke = t.stroke.enabled && t.stroke.width > 0
  if (stroke) {
    ctx.strokeStyle = t.stroke.color
    ctx.lineWidth = t.stroke.width * 2 // stroked behind the fill, so only the outer half shows
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
  }
  ctx.fillStyle = t.color
  const paint = (s: string, x: number, y: number): void => {
    shadow(true)
    if (stroke) {
      ctx.strokeText(s, x, y)
      shadow(false)
    }
    ctx.fillText(s, x, y)
  }

  const total = lines.reduce((n, l) => n + l.length, 0)
  let budget = st.reveal >= 1 ? total : Math.floor(st.reveal * total + 1e-6)
  let index = 0
  const baseAlpha = ctx.globalAlpha
  for (let i = 0; i < lines.length; i++) {
    const chars = lines[i]
    const lw = widths[i]
    const x = t.align === 'left' ? left : t.align === 'center' ? left + (blockW - lw) / 2 : left + blockW - lw
    const y = top + i * lh + lh / 2 + baselineShift
    const shown = Math.min(chars.length, budget)
    budget -= shown
    if (shown > 0) {
      if (st.letter >= 1) {
        paint(chars.slice(0, shown).join(''), x, y)
      } else {
        // Letters fade and rise in one after another.
        const spread = 0.7
        for (let c = 0; c < shown; c++) {
          const order = total > 1 ? (index + c) / (total - 1) : 0
          const a = clamp01((st.letter - order * spread) / (1 - spread))
          if (a <= 0) continue
          ctx.globalAlpha = baseAlpha * a
          const cx = x + (c > 0 ? ctx.measureText(chars.slice(0, c).join('')).width : 0)
          paint(chars[c], cx, y + (1 - easeOut(a)) * t.fontSize * 0.25)
        }
        ctx.globalAlpha = baseAlpha
      }
    }
    index += chars.length
  }
  ctx.restore()
}

/**
 * Draws a title clip at `localTime` seconds into a clip of `clipDuration` onto ctx.
 * w×h are the sequence dimensions: all title coordinates are sequence pixels, so to render at
 * another size apply a scale transform to ctx first (the transform is respected, including for
 * shadows and blur). getImage returns a drawable for a background media item (or null while loading).
 */
export function renderTitle(
  ctx: CanvasRenderingContext2D,
  spec: TitleSpec,
  localTime: number,
  clipDuration: number,
  w: number,
  h: number,
  getImage: (mediaId: string) => CanvasImageSource | null
): void {
  ctx.save()
  try {
    drawBackground(ctx, spec.background, w, h, getImage)
    for (const s of spec.shapes) drawShape(ctx, s, localTime, clipDuration, w, h)
    for (const t of spec.texts) drawText(ctx, t, localTime, clipDuration, w, h)
  } finally {
    ctx.restore()
  }
}
