import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'

export interface MenuItem {
  label?: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  separator?: boolean
  onClick?(): void
}

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

/** A small fixed-position context menu; closes on outside click, Escape, scroll or blur. */
export function ContextMenu(props: { menu: MenuState; onClose(): void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: props.menu.x, y: props.menu.y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(props.menu.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(props.menu.y, window.innerHeight - r.height - 4))
    })
  }, [props.menu])

  useEffect(() => {
    const close = (e: Event): void => {
      if (e instanceof PointerEvent && ref.current?.contains(e.target as Node)) return
      props.onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    window.addEventListener('wheel', close, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('wheel', close, true)
    }
  }, [props])

  return (
    <div className="tl-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {props.menu.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="tl-menu-sep" />
        ) : (
          <button
            key={i}
            className={`tl-menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              props.onClose()
              item.onClick?.()
            }}
          >
            <span className="tl-menu-check">{item.checked ? '✓' : ''}</span>
            <span className="tl-menu-label">{item.label}</span>
            {item.shortcut && <span className="tl-menu-key">{item.shortcut}</span>}
          </button>
        )
      )}
    </div>
  )
}
