import type { JSX } from 'react'
import type { Clip } from '@shared/types'

// Video effect stack of a clip (add/remove/reorder/params).
export function EffectsInspector(props: { clip: Clip }): JSX.Element {
  void props
  return <div className="empty">EffectsInspector</div>
}
