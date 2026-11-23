'use client'

import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/ui/icon'
import { cn } from '@/utils/cn'

export interface DialogProps {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  maxWidthClass?: string
  children: ReactNode
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  maxWidthClass = 'max-w-md',
  children,
}: DialogProps) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!mounted) return null

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-[var(--color-overlay)]"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0, transitionEnd: { transform: 'none' } }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-xl)] shadow-[var(--shadow-popover)] overflow-hidden',
              maxWidthClass,
            )}
          >
            <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-[var(--color-border)]">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
                {description ? (
                  <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                    {description}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                aria-label="Close dialog"
                onClick={onClose}
                className="w-7 h-7 inline-flex items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] cursor-pointer"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="p-4 max-h-[80vh] overflow-y-auto">{children}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}
