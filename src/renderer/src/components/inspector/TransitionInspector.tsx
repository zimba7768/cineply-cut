import type { JSX } from 'react'
import type { Clip } from '@shared/types'

// Selected transition: type, duration, params.
export function TransitionInspector(props: { clipId: string; edge: 'in' | 'out' }): JSX.Element {
  void props
  return <div className="empty">TransitionInspector</div>
}
