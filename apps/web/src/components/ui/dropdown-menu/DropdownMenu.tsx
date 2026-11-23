'use client'

import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '@/components/ui/icon'
import { cn } from '@/utils/cn'

export interface DropdownMenuItem {
  id: string
  label: string
  icon?: IconName
  variant?: 'default' | 'danger'
  dividerBefore?: boolean
  onSelect: () => void
}

export interface DropdownMenuProps {
  trigger: (props: { open: boolean }) => ReactNode
  header?: ReactNode
  items: DropdownMenuItem[]
  align?: 'start' | 'end'
  widthClassName?: string
  triggerClassName?: string
  ariaLabel?: string
}

export function DropdownMenu({
  trigger,
  header,
  items,
  align = 'end',
  widthClassName = 'w-52',
  triggerClassName,
  ariaLabel = 'Open menu',
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [coords, setCoords] = useState<{
    top?: number
    bottom?: number
    left: number
    right: number
  }>({ top: 0, left: 0, right: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  const updatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const estimatedHeight = items.length * 36 + (header ? 64 : 16)
    const spaceBelow = window.innerHeight - rect.bottom
    const openUpward = spaceBelow < estimatedHeight + 12 && rect.top > spaceBelow
    setCoords({
      top: openUpward ? undefined : rect.bottom + 6,
      bottom: openUpward ? window.innerHeight - rect.top + 6 : undefined,
      left: rect.left,
      right: window.innerWidth - rect.right,
    })
  }

  useEffect(() => {
    if (!open) return
    updatePosition()

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return
      }
      setOpen(false)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }

    const handleViewportChange = () => updatePosition()

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        data-state={open ? 'open' : 'closed'}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((prev) => !prev)
        }}
        className={cn(
          'inline-flex items-center gap-2 rounded-[var(--radius-lg)] border border-transparent hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-hover)] cursor-pointer transition-colors',
          open && 'border-[var(--color-border-strong)] bg-[var(--color-surface-hover)]',
          triggerClassName,
        )}
      >
        {trigger({ open })}
      </button>

      {mounted
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  ref={menuRef}
                  role="menu"
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.98 }}
                  transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                  style={{
                    position: 'fixed',
                    ...(coords.bottom !== undefined
                      ? { bottom: `${coords.bottom}px` }
                      : { top: `${coords.top ?? 0}px` }),
                    ...(align === 'end'
                      ? { right: `${Math.max(8, coords.right)}px` }
                      : { left: `${Math.max(8, coords.left)}px` }),
                  }}
                  className={cn(
                    'z-[130] rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-popover)] overflow-hidden',
                    widthClassName,
                  )}
                >
                  {header ? (
                    <div className="px-3 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)]/55">
                      {header}
                    </div>
                  ) : null}

                  <div className="p-1 flex flex-col gap-0.5">
                    {items.map((item) => (
                      <div key={item.id} className="flex flex-col">
                        {item.dividerBefore ? (
                          <div className="my-1 h-px bg-[var(--color-border)]" role="separator" />
                        ) : null}
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(e) => {
                            e.stopPropagation()
                            setOpen(false)
                            item.onSelect()
                          }}
                          className={cn(
                            'w-full h-[30px] px-2.5 rounded-[var(--radius-sm)] text-left text-xs font-medium flex items-center gap-2 cursor-pointer transition-colors',
                            item.variant === 'danger'
                              ? 'text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)]'
                              : 'text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-primary)]',
                          )}
                        >
                          {item.icon ? (
                            <Icon
                              name={item.icon}
                              size={14}
                              className={cn(
                                'shrink-0',
                                item.variant === 'danger'
                                  ? 'text-[var(--color-danger)]'
                                  : 'text-[var(--color-text-secondary)]',
                              )}
                            />
                          ) : null}
                          <span className="truncate">{item.label}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  )
}
