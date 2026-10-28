import type { JSX } from 'react'
import type { Clip } from '@shared/types'

// Clip audio: gain, pan, fades, volume keyframes, effect rack, denoise, normalize.
export function AudioInspector(props: { clip: Clip }): JSX.Element {
  void props
  return <div className="empty">AudioInspector</div>
}
