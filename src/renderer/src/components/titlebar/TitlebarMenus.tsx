import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'

export type TitlebarMenuItem = {
  id: string
  label: string
  description?: string
  icon: ReactNode
  checked?: boolean
  disabled?: boolean
  onSelect: () => void
}

type MenuId = 'view' | 'tools'

type MenuPosition = {
  left: number
  top: number
}

const MENU_WIDTH = 236
const VIEWPORT_GUTTER = 8

export function TitlebarMenus({
  viewItems,
  toolItems
}: {
  viewItems: TitlebarMenuItem[]
  toolItems: TitlebarMenuItem[]
}): JSX.Element {
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null)
  const [position, setPosition] = useState<MenuPosition>({ left: VIEWPORT_GUTTER, top: 46 })
  const viewButtonRef = useRef<HTMLButtonElement>(null)
  const toolsButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const items = openMenu === 'view' ? viewItems : toolItems

  const closeMenu = useCallback((restoreFocus = false): void => {
    const trigger = openMenu === 'view' ? viewButtonRef.current : toolsButtonRef.current
    setOpenMenu(null)
    if (restoreFocus) trigger?.focus()
  }, [openMenu])

  const open = (id: MenuId, focusFirst = false): void => {
    const trigger = id === 'view' ? viewButtonRef.current : toolsButtonRef.current
    const rect = trigger?.getBoundingClientRect()
    if (rect) {
      setPosition({
        left: Math.max(VIEWPORT_GUTTER, Math.min(rect.left, window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER)),
        top: rect.bottom + 5
      })
    }
    setOpenMenu(id)
    if (focusFirst) {
      window.requestAnimationFrame(() => {
        menuRef.current?.querySelector<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')?.focus()
      })
    }
  }

  useEffect(() => {
    if (!openMenu) return

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target)) return
      if (viewButtonRef.current?.contains(target) || toolsButtonRef.current?.contains(target)) return
      closeMenu()
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu(true)
      }
    }
    const handleScroll = (): void => closeMenu()

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [closeMenu, openMenu])

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: MenuId): void => {
    if (event.key !== 'ArrowDown') return
    event.preventDefault()
    open(id, true)
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const enabledItems = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)') ?? []
    )
    if (enabledItems.length === 0) return
    const currentIndex = enabledItems.indexOf(document.activeElement as HTMLButtonElement)
    let nextIndex = 0
    if (event.key === 'End') nextIndex = enabledItems.length - 1
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1 + enabledItems.length) % enabledItems.length
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + enabledItems.length) % enabledItems.length
    enabledItems[nextIndex]?.focus()
  }

  return (
    <div className="titlebar-menus" aria-label="Application menu">
      <button
        ref={viewButtonRef}
        type="button"
        className={`titlebar-menu-trigger ${openMenu === 'view' ? 'active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={openMenu === 'view'}
        onClick={() => (openMenu === 'view' ? closeMenu() : open('view'))}
        onKeyDown={(event) => handleTriggerKeyDown(event, 'view')}
      >
        View
      </button>
      <button
        ref={toolsButtonRef}
        type="button"
        className={`titlebar-menu-trigger ${openMenu === 'tools' ? 'active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={openMenu === 'tools'}
        onClick={() => (openMenu === 'tools' ? closeMenu() : open('tools'))}
        onKeyDown={(event) => handleTriggerKeyDown(event, 'tools')}
      >
        Tools
      </button>
      {openMenu ? (
        <div
          ref={menuRef}
          className="titlebar-menu-popover"
          role="menu"
          aria-label={`${openMenu === 'view' ? 'View' : 'Tools'} menu`}
          style={{ left: position.left, top: position.top }}
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role={typeof item.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={typeof item.checked === 'boolean' ? item.checked : undefined}
              className={`titlebar-menu-item ${item.checked ? 'active' : ''}`}
              disabled={item.disabled}
              title={item.description}
              onClick={() => {
                closeMenu()
                item.onSelect()
              }}
            >
              <span className="titlebar-menu-item-icon">{item.icon}</span>
              <span className="titlebar-menu-item-copy">
                <span className="titlebar-menu-item-label">{item.label}</span>
                {item.description ? <span className="titlebar-menu-item-description">{item.description}</span> : null}
              </span>
              {item.checked ? <span className="titlebar-menu-item-state" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
