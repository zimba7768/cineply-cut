import type { JSX } from 'react'
import type { Clip } from '@shared/types'

// Title editor: text layers, fonts, colours, background, animations.
export function TitleInspector(props: { clip: Clip }): JSX.Element {
  void props
  return <div className="empty">TitleInspector</div>
}
