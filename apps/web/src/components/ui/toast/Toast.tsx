'use client'

import { AnimatePresence, motion } from 'motion/react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '@/components/ui/icon'
import { cn } from '@/utils/cn'

export type ToastVariant = 'success' | 'error' | 'danger' | 'warning' | 'info'

export interface ToastInput {
  title: string
  description?: string
  variant?: ToastVariant
  durationMs?: number
}

interface ToastRecord extends Required<Pick<ToastInput, 'title' | 'variant' | 'durationMs'>> {
  id: string
  description?: string
}

interface ToastContextValue {
  push: (input: ToastInput) => string
  dismiss: (id: string) => void
  success: (title: string, description?: string) => string
  error: (title: string, description?: string) => string
  danger: (title: string, description?: string) => string
  warning: (title: string, description?: string) => string
  info: (title: string, description?: string) => string
}

const ToastContext = createContext<ToastContextValue | null>(null)

const VARIANT_CONFIG: Record<
  ToastVariant,
  {
    icon: IconName
    strokeWidth: number
    cardClass: string
    circleClass: string
  }
> = {
  success: {
    icon: 'check',
    strokeWidth: 2.5,
    cardClass:
      'bg-[var(--toast-success-bg)] border-[var(--toast-success-border)]',
    circleClass: 'bg-[var(--toast-success-icon)] text-white',
  },
  info: {
    icon: 'lightbulb',
    strokeWidth: 2.1,
    cardClass: 'bg-[var(--toast-info-bg)] border-[var(--toast-info-border)]',
    circleClass: 'bg-[var(--toast-info-icon)] text-white',
  },
  warning: {
    icon: 'exclamation',
    strokeWidth: 2.6,
    cardClass:
      'bg-[var(--toast-warning-bg)] border-[var(--toast-warning-border)]',
    circleClass: 'bg-[var(--toast-warning-icon)] text-white',
  },
  error: {
    icon: 'x',
    strokeWidth: 2.6,
    cardClass:
      'bg-[var(--toast-danger-bg)] border-[var(--toast-danger-border)]',
    circleClass: 'bg-[var(--toast-danger-icon)] text-white',
  },
  danger: {
    icon: 'x',
    strokeWidth: 2.6,
    cardClass:
      'bg-[var(--toast-danger-bg)] border-[var(--toast-danger-border)]',
    circleClass: 'bg-[var(--toast-danger-icon)] text-white',
  },
}

function ToastCard({
  item,
  onDismiss,
}: {
  item: ToastRecord
  onDismiss: (id: string) => void
}) {
  const [paused, setPaused] = useState(false)
  const cfg = VARIANT_CONFIG[item.variant]

  useEffect(() => {
    if (paused || item.durationMs <= 0) return undefined
    const timer = window.setTimeout(() => {
      onDismiss(item.id)
    }, item.durationMs)
    return () => window.clearTimeout(timer)
  }, [item.id, item.durationMs, paused, onDismiss])

  return (
    <motion.div
      layout
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      initial={{ opacity: 0, x: 28, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.96, transition: { duration: 0.14 } }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'pointer-events-auto w-full rounded-xl border-[1.5px] shadow-[var(--shadow-md)] px-3.5 py-2.5 flex items-center gap-3',
        cfg.cardClass,
      )}
    >
      <span
        className={cn(
          'w-8 h-8 rounded-full inline-flex items-center justify-center shrink-0',
          cfg.circleClass,
        )}
      >
        <Icon name={cfg.icon} size={15} strokeWidth={cfg.strokeWidth} />
      </span>

      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <p className="text-xs font-bold text-[var(--color-text)] leading-snug">{item.title}</p>
        {item.description ? (
          <p className="text-[11px] text-[var(--color-text-secondary)] leading-snug break-words">
            {item.description}
          </p>
        ) : null}
      </div>

      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(item.id)}
        className="w-7 h-7 inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--toast-close-hover)] cursor-pointer shrink-0 transition-colors"
      >
        <Icon name="x" size={14} strokeWidth={1.9} />
      </button>
    </motion.div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false)
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const seqRef = useRef(0)

  useEffect(() => {
    setMounted(true)
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback((input: ToastInput) => {
    seqRef.current += 1
    const id = `toast-${Date.now()}-${seqRef.current}`
    const next: ToastRecord = {
      id,
      title: input.title,
      description: input.description,
      variant: input.variant ?? 'info',
      durationMs: input.durationMs ?? 3600,
    }
    setToasts((prev) => [next, ...prev].slice(0, 5))
    return id
  }, [])

  const api = useMemo<ToastContextValue>(
    () => ({
      push,
      dismiss,
      success: (title, description) => push({ title, description, variant: 'success' }),
      error: (title, description) => push({ title, description, variant: 'error' }),
      danger: (title, description) => push({ title, description, variant: 'danger' }),
      warning: (title, description) => push({ title, description, variant: 'warning' }),
      info: (title, description) => push({ title, description, variant: 'info' }),
    }),
    [push, dismiss],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted
        ? createPortal(
            <div
              aria-label="Notifications"
              className="fixed top-3.5 right-3.5 z-[180] flex flex-col gap-2 w-[calc(100vw-2rem)] max-w-[340px] pointer-events-none"
            >
              <AnimatePresence mode="popLayout" initial={false}>
                {toasts.map((item) => (
                  <ToastCard key={item.id} item={item} onDismiss={dismiss} />
                ))}
              </AnimatePresence>
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return ctx
}
