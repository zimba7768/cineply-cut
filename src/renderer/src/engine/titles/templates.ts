import type { TitleAnimation, TitleShapeLayer, TitleSpec, TitleTextLayer } from '@shared/types'
import { uid } from '@/lib/ids'

export interface TitleTemplate {
  id: string
  name: string
  category: 'Title' | 'Lower Third' | 'Credits' | 'Social' | 'Basic'
  defaultDuration: number
  create(): TitleSpec
}

// ------------------------------------------------------------- builders ----

type TextOverrides = Partial<Omit<TitleTextLayer, 'stroke' | 'shadow' | 'box'>> & {
  stroke?: Partial<TitleTextLayer['stroke']>
  shadow?: Partial<TitleTextLayer['shadow']>
  box?: Partial<TitleTextLayer['box']>
}

/** A text layer with sensible defaults (sizes are sequence px at 1080p). */
export function newTextLayer(o: TextOverrides = {}): TitleTextLayer {
  return {
    id: uid(),
    text: 'Text',
    fontFamily: 'Inter, Segoe UI, sans-serif',
    fontSize: 96,
    fontWeight: 700,
    italic: false,
    color: '#ffffff',
    align: 'center',
    x: 0.5,
    y: 0.5,
    letterSpacing: 0,
    lineHeight: 1.15,
    uppercase: false,
    animIn: { type: 'fade', duration: 0.5 },
    animOut: { type: 'fade', duration: 0.5 },
    ...o,
    stroke: { enabled: false, color: '#000000', width: 4, ...o.stroke },
    shadow: { enabled: false, color: 'rgba(0,0,0,0.6)', blur: 12, x: 0, y: 4, ...o.shadow },
    box: { enabled: false, color: 'rgba(0,0,0,0.6)', padding: 24, radius: 8, ...o.box }
  }
}

export function newShapeLayer(o: Partial<TitleShapeLayer> = {}): TitleShapeLayer {
  return {
    id: uid(),
    kind: 'rect',
    x: 0.35,
    y: 0.45,
    w: 0.3,
    h: 0.1,
    color: '#7c5cff',
    radius: 0,
    animIn: { type: 'wipe', duration: 0.5 },
    animOut: { type: 'fade', duration: 0.4 },
    ...o
  }
}

const anim = (type: TitleAnimation, duration = 0.5): { type: TitleAnimation; duration: number } => ({ type, duration })
const SHADOW = { enabled: true, color: 'rgba(0,0,0,0.6)', blur: 14, x: 0, y: 4 }

const spec = (texts: TitleTextLayer[], shapes: TitleShapeLayer[] = [], background: TitleSpec['background'] = { type: 'none' }): TitleSpec => ({
  background, texts, shapes
})

// ------------------------------------------------------------ templates ----

export const TITLE_TEMPLATES: TitleTemplate[] = [
  {
    id: 'basic',
    name: 'Basic Title',
    category: 'Basic',
    defaultDuration: 5,
    create: () => spec([newTextLayer({ text: 'Your Title', fontSize: 120, shadow: SHADOW })])
  },
  {
    id: 'big-bold',
    name: 'Big Bold',
    category: 'Title',
    defaultDuration: 4,
    create: () => spec([
      newTextLayer({
        text: 'Big Bold Title', fontFamily: 'Impact, Arial Black, sans-serif', fontWeight: 400, fontSize: 210, uppercase: true,
        letterSpacing: 2, stroke: { enabled: true, color: '#000000', width: 6 }, shadow: { ...SHADOW, blur: 24, y: 10 },
        animIn: anim('pop', 0.45), animOut: anim('zoom', 0.35)
      })
    ])
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    category: 'Title',
    defaultDuration: 6,
    create: () => spec([
      newTextLayer({
        text: 'The Journey', fontFamily: 'Segoe UI Light, Segoe UI, sans-serif', fontWeight: 300, fontSize: 110,
        letterSpacing: 48, uppercase: true, y: 0.48, animIn: anim('blur', 1.6), animOut: anim('fade', 1)
      }),
      newTextLayer({
        text: 'A film by Your Name', fontFamily: 'Segoe UI, sans-serif', fontWeight: 400, fontSize: 28, letterSpacing: 14,
        uppercase: true, color: '#c9cbd2', y: 0.6, animIn: anim('fade', 2.2), animOut: anim('fade', 1)
      })
    ])
  },
  {
    id: 'subtitle',
    name: 'Subtitle Caption',
    category: 'Basic',
    defaultDuration: 3,
    create: () => spec([
      newTextLayer({
        text: 'Subtitle text goes here', fontFamily: 'Segoe UI, sans-serif', fontWeight: 600, fontSize: 54, y: 0.88,
        box: { enabled: true, color: 'rgba(0,0,0,0.65)', padding: 14, radius: 6 },
        animIn: anim('fade', 0.15), animOut: anim('fade', 0.15)
      })
    ])
  },
  {
    id: 'lower-third',
    name: 'Lower Third',
    category: 'Lower Third',
    defaultDuration: 5,
    create: () => spec(
      [
        newTextLayer({
          text: 'Jane Doe', fontFamily: 'Segoe UI, sans-serif', fontWeight: 700, fontSize: 60, align: 'left', x: 0.088, y: 0.787,
          animIn: anim('slide-right', 0.6), animOut: anim('fade', 0.4)
        }),
        newTextLayer({
          text: 'Director of Photography', fontFamily: 'Segoe UI, sans-serif', fontWeight: 400, fontSize: 34, color: '#cfd2da',
          align: 'left', x: 0.088, y: 0.84, animIn: anim('slide-right', 0.8), animOut: anim('fade', 0.4)
        })
      ],
      [
        newShapeLayer({ x: 0.06, y: 0.74, w: 0.31, h: 0.135, color: 'rgba(12,12,16,0.78)', radius: 4, animIn: anim('wipe', 0.5) }),
        newShapeLayer({ x: 0.06, y: 0.74, w: 0.008, h: 0.135, color: '#7c5cff', animIn: anim('fade', 0.3) })
      ]
    )
  },
  {
    id: 'lower-third-modern',
    name: 'Lower Third Modern',
    category: 'Lower Third',
    defaultDuration: 5,
    create: () => spec(
      [
        newTextLayer({
          text: 'Alex Morgan', fontFamily: 'Bahnschrift, Segoe UI, sans-serif', fontWeight: 700, fontSize: 52, color: '#111318',
          align: 'left', x: 0.066, y: 0.823, animIn: anim('wipe', 0.6), animOut: anim('wipe', 0.4)
        }),
        newTextLayer({
          text: 'Product Designer', fontFamily: 'Segoe UI, sans-serif', fontWeight: 600, fontSize: 26, letterSpacing: 5,
          uppercase: true, align: 'left', x: 0.066, y: 0.888, animIn: anim('wipe', 0.8), animOut: anim('wipe', 0.4)
        })
      ],
      [
        newShapeLayer({ x: 0.05, y: 0.78, w: 0.25, h: 0.086, color: '#ffffff', animIn: anim('wipe', 0.45), animOut: anim('wipe', 0.4) }),
        newShapeLayer({ x: 0.05, y: 0.866, w: 0.21, h: 0.045, color: '#ff4d5e', animIn: anim('wipe', 0.6), animOut: anim('wipe', 0.4) })
      ]
    )
  },
  {
    id: 'news-banner',
    name: 'News Banner',
    category: 'Lower Third',
    defaultDuration: 6,
    create: () => spec(
      [
        newTextLayer({
          text: 'Breaking News', fontFamily: 'Arial Black, Arial, sans-serif', fontWeight: 900, fontSize: 40, uppercase: true,
          x: 0.11, y: 0.871, animIn: anim('fade', 0.4)
        }),
        newTextLayer({
          text: 'Headline text goes here', fontFamily: 'Arial, sans-serif', fontWeight: 700, fontSize: 46, color: '#111318',
          align: 'left', x: 0.24, y: 0.871, animIn: anim('slide-left', 0.6)
        }),
        newTextLayer({
          text: 'LIVE  •  Updates every hour  •  Your channel name', fontFamily: 'Arial, sans-serif', fontWeight: 400, fontSize: 26,
          align: 'left', x: 0.02, y: 0.943, animIn: anim('fade', 0.6)
        })
      ],
      [
        newShapeLayer({ x: 0, y: 0.82, w: 1, h: 0.1, color: '#ffffff', animIn: anim('wipe', 0.5) }),
        newShapeLayer({ x: 0, y: 0.82, w: 0.22, h: 0.1, color: '#d71920', animIn: anim('wipe', 0.35) }),
        newShapeLayer({ x: 0, y: 0.92, w: 1, h: 0.045, color: '#0d1b3d', animIn: anim('wipe', 0.6) })
      ]
    )
  },
  {
    id: 'opening-credits',
    name: 'Opening Credits',
    category: 'Credits',
    defaultDuration: 5,
    create: () => spec([
      newTextLayer({
        text: 'directed by', fontFamily: 'Georgia, serif', fontWeight: 400, italic: true, fontSize: 40, color: '#d8d8de',
        letterSpacing: 3, y: 0.44, animIn: anim('fade', 1), animOut: anim('fade', 1)
      }),
      newTextLayer({
        text: 'Firstname Lastname', fontFamily: 'Segoe UI Light, Segoe UI, sans-serif', fontWeight: 300, fontSize: 92,
        letterSpacing: 20, uppercase: true, y: 0.535, animIn: anim('fade', 1.5), animOut: anim('fade', 1)
      })
    ])
  },
  {
    id: 'end-credits',
    name: 'End Credits',
    category: 'Credits',
    defaultDuration: 8,
    create: () => spec(
      [
        newTextLayer({
          text: 'Directed by\nYour Name\n\nProduced by\nProducer Name\n\nMusic by\nComposer Name\n\nEdited with Cineply Cut',
          fontFamily: 'Segoe UI, sans-serif', fontWeight: 400, fontSize: 44, lineHeight: 1.45, color: '#e9eaee',
          animIn: anim('slide-up', 1.2), animOut: anim('fade', 1)
        })
      ],
      [],
      { type: 'solid', color: '#000000' }
    )
  },
  {
    id: 'chapter-card',
    name: 'Chapter Card',
    category: 'Title',
    defaultDuration: 4,
    create: () => spec(
      [
        newTextLayer({
          text: 'Chapter One', fontFamily: 'Segoe UI, sans-serif', fontWeight: 600, fontSize: 32, letterSpacing: 16,
          uppercase: true, color: '#c8ad7f', y: 0.41, animIn: anim('fade', 0.8)
        }),
        newTextLayer({
          text: 'The Beginning', fontFamily: 'Georgia, serif', fontWeight: 400, italic: true, fontSize: 112, y: 0.555,
          animIn: anim('letter-fade', 1.4), animOut: anim('fade', 0.6)
        })
      ],
      [newShapeLayer({ kind: 'line', x: 0.44, y: 0.462, w: 0.12, h: 0.004, color: '#c8ad7f', animIn: anim('wipe', 0.9) })],
      { type: 'solid', color: '#111317' }
    )
  },
  {
    id: 'quote',
    name: 'Quote',
    category: 'Title',
    defaultDuration: 6,
    create: () => spec(
      [
        newTextLayer({
          text: '“The best way to predict the future\nis to create it.”', fontFamily: 'Georgia, serif', fontWeight: 400, italic: true,
          fontSize: 74, lineHeight: 1.3, y: 0.45, shadow: { ...SHADOW, color: 'rgba(0,0,0,0.35)' }, animIn: anim('letter-fade', 2)
        }),
        newTextLayer({
          text: '— Peter Drucker', fontFamily: 'Segoe UI, sans-serif', fontWeight: 600, fontSize: 38, color: '#ecebf5',
          letterSpacing: 2, y: 0.66, animIn: anim('fade', 2.4)
        })
      ],
      [],
      { type: 'gradient', from: '#1f1c2c', to: '#6d5f9e', angle: 135 }
    )
  },
  {
    id: 'subscribe',
    name: 'Subscribe Callout',
    category: 'Social',
    defaultDuration: 4,
    create: () => spec([
      newTextLayer({
        text: '▶  SUBSCRIBE', fontFamily: 'Segoe UI, sans-serif', fontWeight: 800, fontSize: 52, x: 0.82, y: 0.83,
        box: { enabled: true, color: '#ff0033', padding: 24, radius: 16 }, shadow: { ...SHADOW, blur: 20, y: 8, color: 'rgba(0,0,0,0.45)' },
        animIn: anim('pop', 0.5), animOut: anim('zoom', 0.3)
      }),
      newTextLayer({
        text: 'and hit the bell 🔔', fontFamily: 'Segoe UI, Segoe UI Emoji, sans-serif', fontWeight: 600, fontSize: 30, x: 0.82, y: 0.92,
        shadow: SHADOW, animIn: anim('slide-up', 0.7), animOut: anim('fade', 0.3)
      })
    ])
  },
  {
    id: 'social-hook',
    name: 'Social Vertical Hook',
    category: 'Social',
    defaultDuration: 3,
    create: () => spec([
      newTextLayer({
        text: 'Wait for it…', fontFamily: 'Segoe UI Black, Segoe UI, sans-serif', fontWeight: 900, fontSize: 104, color: '#111111',
        uppercase: true, y: 0.3, box: { enabled: true, color: '#ffe14d', padding: 26, radius: 20 }, animIn: anim('pop', 0.45)
      }),
      newTextLayer({
        text: 'Watch till the end 👀', fontFamily: 'Segoe UI, Segoe UI Emoji, sans-serif', fontWeight: 700, fontSize: 56, y: 0.4,
        stroke: { enabled: true, color: '#000000', width: 5 }, animIn: anim('slide-up', 0.6)
      })
    ])
  },
  {
    id: 'neon',
    name: 'Neon',
    category: 'Title',
    defaultDuration: 5,
    create: () => spec([
      newTextLayer({
        text: 'Neon Nights', fontFamily: 'Bahnschrift, Segoe UI, sans-serif', fontWeight: 400, fontSize: 150, uppercase: true,
        letterSpacing: 14, color: '#ffe0fa', y: 0.47, stroke: { enabled: true, color: '#ff3bd6', width: 3 },
        shadow: { enabled: true, color: '#ff2bd6', blur: 48, x: 0, y: 0 }, animIn: anim('blur', 0.8)
      }),
      newTextLayer({
        text: 'open all night', fontFamily: 'Segoe Script, cursive', fontWeight: 400, fontSize: 56, color: '#d9fdff', y: 0.62,
        shadow: { enabled: true, color: '#21e8ff', blur: 30, x: 0, y: 0 }, animIn: anim('fade', 1.4)
      })
    ])
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    category: 'Basic',
    defaultDuration: 5,
    create: () => spec([
      newTextLayer({
        text: 'Once upon a time…', fontFamily: 'Consolas, monospace', fontWeight: 400, fontSize: 72, color: '#f0eee6',
        box: { enabled: true, color: 'rgba(0,0,0,0.55)', padding: 22, radius: 4 }, animIn: anim('typewriter', 1.8), animOut: anim('fade', 0.5)
      })
    ])
  },
  {
    id: 'color-card',
    name: 'Colour Card',
    category: 'Title',
    defaultDuration: 4,
    create: () => spec(
      [
        newTextLayer({
          text: 'Make It Pop', fontFamily: 'Segoe UI Black, Segoe UI, sans-serif', fontWeight: 900, fontSize: 150,
          shadow: { ...SHADOW, color: 'rgba(40,0,60,0.35)', blur: 30, y: 12 }, animIn: anim('zoom', 0.6)
        }),
        newTextLayer({
          text: 'subtitle goes here', fontFamily: 'Segoe UI, sans-serif', fontWeight: 600, fontSize: 40, letterSpacing: 6,
          uppercase: true, color: '#fff2fa', y: 0.62, animIn: anim('slide-up', 0.8)
        })
      ],
      [],
      { type: 'gradient', from: '#7c5cff', to: '#ff5c8a', angle: 120 }
    )
  }
]

export function getTitleTemplate(id: string): TitleTemplate {
  return TITLE_TEMPLATES.find((x) => x.id === id) ?? TITLE_TEMPLATES[0]
}

export function createTitleFromTemplate(templateId: string): { spec: TitleSpec; duration: number; name: string } {
  const t = getTitleTemplate(templateId)
  return { spec: { ...t.create(), template: t.id }, duration: t.defaultDuration, name: t.name }
}

/** Template categories in display order. */
export const TITLE_CATEGORIES: TitleTemplate['category'][] = ['Basic', 'Title', 'Lower Third', 'Credits', 'Social']
