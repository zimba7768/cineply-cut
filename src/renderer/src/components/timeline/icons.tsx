import type { JSX, ReactNode } from 'react'

/** Small stroke icons for the timeline and top bar (16×16, currentColor). */
function Svg(props: { children: ReactNode; size?: number }): JSX.Element {
  const s = props.size ?? 14
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {props.children}
    </svg>
  )
}

export const Icon = {
  select: (): JSX.Element => <Svg><path d="M4 2l8 6-3.6.8L10.5 13l-1.7.8-2.1-4.2L4 12z" fill="currentColor" stroke="none" /></Svg>,
  razor: (): JSX.Element => <Svg><path d="M3 13l6.5-6.5M9 3l4 4-2.5 2.5-4-4zM2.5 13.5l1-1" /></Svg>,
  ripple: (): JSX.Element => <Svg><path d="M5 3v10M11 3v10M2 8h3M8 8l3-3M8 8l3 3M8 8h3" /></Svg>,
  hand: (): JSX.Element => <Svg><path d="M5 8V4a1 1 0 012 0v3V3a1 1 0 012 0v4V4a1 1 0 012 0v5c0 3-1.5 5-4 5-2 0-3-1-4-3L2.8 8.6a1 1 0 011.6-1.1z" /></Svg>,
  undo: (): JSX.Element => <Svg><path d="M5 4L2 7l3 3M2 7h7a4 4 0 010 8H7" /></Svg>,
  redo: (): JSX.Element => <Svg><path d="M11 4l3 3-3 3M14 7H7a4 4 0 000 8h2" /></Svg>,
  magnet: (): JSX.Element => <Svg><path d="M3 3v5a5 5 0 0010 0V3h-3v5a2 2 0 01-4 0V3zM3 6h3M10 6h3" /></Svg>,
  gear: (): JSX.Element => (
    <Svg>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </Svg>
  ),
  keyboard: (): JSX.Element => <Svg><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h1M7 7h1M10 7h1M5 9.5h6" /></Svg>,
  film: (): JSX.Element => <Svg><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 3v10M11 3v10M2 6h3M2 10h3M11 6h3M11 10h3" /></Svg>,
  marker: (): JSX.Element => <Svg><path d="M4 2h8v8l-4 4-4-4z" /></Svg>,
  plus: (): JSX.Element => <Svg><path d="M8 3v10M3 8h10" /></Svg>,
  minus: (): JSX.Element => <Svg><path d="M3 8h10" /></Svg>,
  fit: (): JSX.Element => <Svg><path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3M5 8h6M5 8l2-2M5 8l2 2M11 8l-2-2M11 8l-2 2" /></Svg>,
  lock: (): JSX.Element => <Svg size={12}><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5 7V5a3 3 0 016 0v2" /></Svg>,
  unlock: (): JSX.Element => <Svg size={12}><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5 7V5a3 3 0 015.8-1" /></Svg>,
  eye: (): JSX.Element => <Svg size={12}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></Svg>,
  eyeOff: (): JSX.Element => <Svg size={12}><path d="M2 2l12 12M6.5 4C7 3.7 7.5 3.5 8 3.5c4 0 6.5 4.5 6.5 4.5a12 12 0 01-1.8 2.3M10 11.9c-.6.4-1.3.6-2 .6-4 0-6.5-4.5-6.5-4.5a12 12 0 012.2-2.7" /></Svg>,
  link: (): JSX.Element => <Svg><path d="M7 9a3 3 0 004 0l2-2a3 3 0 00-4-4l-1 1M9 7a3 3 0 00-4 0L3 9a3 3 0 004 4l1-1" /></Svg>,
  chevron: (): JSX.Element => <Svg size={10}><path d="M4 6l4 4 4-4" /></Svg>
}
