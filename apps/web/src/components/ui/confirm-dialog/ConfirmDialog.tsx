'use client'

import { AnimatePresence, motion } from 'motion/react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '@/components/ui/icon'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/utils/cn'

export type ConfirmDialogVariant = 'danger' | 'warning' | 'info'

export interface ConfirmOptions {
  title?: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: ConfirmDialogVariant
  icon?: IconName
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean
  isLoading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

const CONFIRM_STYLE: Record<
  ConfirmDialogVariant,
  {
    icon: IconName
    circleClass: string
    buttonClass: string
  }
> = {
  danger: {
    icon: 'triangle-alert',
    circleClass: 'bg-[var(--color-danger-subtle)] text-[var(--color-danger)]',
    buttonClass:
      'bg-[var(--color-danger)] hover:bg-[var(--color-danger-hover)] text-white focus-visible:outline-[var(--color-danger)]',
  },
  warning: {
    icon: 'triangle-alert',
    circleClass: 'bg-[var(--color-warning-subtle)] text-[var(--color-warning)]',
    buttonClass:
      'bg-[var(--method-put-solid)] hover:opacity-92 text-white focus-visible:outline-[var(--color-warning)]',
  },
  info: {
    icon: 'info',
    circleClass: 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)]',
    buttonClass:
      'bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white focus-visible:outline-[var(--color-primary)]',
  },
}

export function ConfirmDialog({
  open,
  title = 'Are you sure?',
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  variant = 'danger',
  icon,
  isLoading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [mounted, setMounted] = useState(false)
  const cfg = CONFIRM_STYLE[variant]

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isLoading) {
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, isLoading, onCancel])

  if (!mounted) return null

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !isLoading) {
              onCancel()
            }
          }}
          className="fixed inset-0 z-[170] flex items-center justify-center p-4 bg-[var(--color-overlay)]"
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-desc"
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-[356px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-popover)] flex flex-col items-center text-center"
          >
            <div
              className={cn(
                'w-10 h-10 rounded-full inline-flex items-center justify-center shrink-0',
                cfg.circleClass,
              )}
            >
              <Icon name={icon ?? cfg.icon} size={19} />
            </div>

            <h2
              id="confirm-dialog-title"
              className="mt-3 text-base font-semibold text-[var(--color-text)] tracking-tight"
            >
              {title}
            </h2>

            <p
              id="confirm-dialog-desc"
              className="mt-1.5 text-xs text-[var(--color-text-secondary)] leading-relaxed max-w-[296px]"
            >
              {description}
            </p>

            <div className="mt-5 w-full flex flex-col gap-2">
              <button
                type="button"
                disabled={isLoading}
                onClick={onConfirm}
                className={cn(
                  'w-full h-[34px] px-3.5 rounded-[var(--radius-md)] text-[13px] font-medium inline-flex items-center justify-center gap-2 shadow-[var(--shadow-xs)] cursor-pointer transition-all disabled:opacity-60 disabled:cursor-not-allowed',
                  cfg.buttonClass,
                )}
              >
                {isLoading ? <Spinner size="sm" /> : null}
                <span>{confirmLabel}</span>
              </button>

              <button
                type="button"
                disabled={isLoading}
                onClick={onCancel}
                className="w-full h-[34px] px-3.5 rounded-[var(--radius-md)] text-[13px] font-medium border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] inline-flex items-center justify-center cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {cancelLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolverRef = useRef<((accepted: boolean) => void) | null>(null)

  const confirm = useCallback((nextOptions: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
      setOptions(nextOptions)
    })
  }, [])

  const handleResolve = useCallback((accepted: boolean) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setOptions(null)
    resolve?.(accepted)
  }, [])

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <ConfirmDialog
        open={Boolean(options)}
        title={options?.title ?? 'Are you sure?'}
        description={options?.description ?? ''}
        confirmLabel={options?.confirmLabel ?? 'Delete'}
        cancelLabel={options?.cancelLabel ?? 'Cancel'}
        variant={options?.variant ?? 'danger'}
        icon={options?.icon}
        onConfirm={() => handleResolve(true)}
        onCancel={() => handleResolve(false)}
      />
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error('useConfirm must be used within a ConfirmProvider')
  }
  return ctx.confirm
}
