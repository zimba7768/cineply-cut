import type { TitleSpec } from '@shared/types'
import { uid } from '@/lib/ids'

export interface TitleTemplate {
  id: string
  name: string
  category: 'Title' | 'Lower Third' | 'Credits' | 'Social' | 'Basic'
  defaultDuration: number
  create(): TitleSpec
}

function basicTitle(): TitleSpec {
  return {
    background: { type: 'none' },
    shapes: [],
    texts: [
      {
        id: uid(), text: 'Your Title', fontFamily: 'Inter, Segoe UI, sans-serif', fontSize: 120, fontWeight: 700,
        italic: false, color: '#ffffff', align: 'center', x: 0.5, y: 0.5, letterSpacing: 0, lineHeight: 1.15,
        uppercase: false, stroke: { enabled: false, color: '#000000', width: 4 },
        shadow: { enabled: true, color: 'rgba(0,0,0,0.6)', blur: 12, x: 0, y: 4 },
        box: { enabled: false, color: 'rgba(0,0,0,0.6)', padding: 24, radius: 8 },
        animIn: { type: 'fade', duration: 0.5 }, animOut: { type: 'fade', duration: 0.5 }
      }
    ]
  }
}

export const TITLE_TEMPLATES: TitleTemplate[] = [
  { id: 'basic', name: 'Basic Title', category: 'Basic', defaultDuration: 5, create: basicTitle }
]

export function createTitleFromTemplate(templateId: string): { spec: TitleSpec; duration: number; name: string } {
  const t = TITLE_TEMPLATES.find((x) => x.id === templateId) ?? TITLE_TEMPLATES[0]
  return { spec: { ...t.create(), template: t.id }, duration: t.defaultDuration, name: t.name }
}

/**
 * Draws a title clip at `localTime` seconds into a clip of `clipDuration` onto ctx (w×h, cleared).
 * getImage returns a drawable for a background media item (or null while loading).
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
  void localTime; void clipDuration; void getImage
  if (spec.background.type === 'solid') {
    ctx.fillStyle = spec.background.color
    ctx.fillRect(0, 0, w, h)
  }
  for (const t of spec.texts) {
    ctx.font = `${t.italic ? 'italic ' : ''}${t.fontWeight} ${t.fontSize}px ${t.fontFamily}`
    ctx.fillStyle = t.color
    ctx.textAlign = t.align
    ctx.textBaseline = 'middle'
    ctx.fillText(t.text, t.x * w, t.y * h)
  }
}
