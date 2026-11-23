import type { HttpMethod } from '@meofast/shared'
import type { HTMLAttributes } from 'react'
import { Icon } from '@/components/ui/icon'
import { cn } from '@/utils/cn'

export type BadgeVariant = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

const badgeStyles: Record<BadgeVariant, string> = {
  neutral:
    'bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] border-[var(--color-border)]',
  primary:
    'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] border-[var(--color-border-strong)]',
  success:
    'bg-[var(--color-success-subtle)] text-[var(--color-success)] border-[var(--color-success-border)]',
  warning:
    'bg-[var(--color-warning-subtle)] text-[var(--color-warning)] border-[var(--color-warning-border)]',
  danger:
    'bg-[var(--color-danger-subtle)] text-[var(--color-danger)] border-[var(--color-danger-border)]',
  info: 'bg-[var(--color-info-subtle)] text-[var(--color-info)] border-[var(--color-info-border)]',
}

export function Badge({ variant = 'neutral', className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium border rounded-[var(--radius-full)] tabular-nums leading-tight whitespace-nowrap shrink-0',
        badgeStyles[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}

const methodVariantMap: Record<HttpMethod, BadgeVariant> = {
  GET: 'success',
  POST: 'primary',
  PUT: 'warning',
  PATCH: 'info',
  DELETE: 'danger',
  HEAD: 'neutral',
  OPTIONS: 'neutral',
}

const methodSolidStyleMap: Record<HttpMethod, string> = {
  GET: 'bg-[var(--method-get-solid)] text-white border-transparent shadow-[var(--shadow-xs)]',
  POST: 'bg-[var(--method-post-solid)] text-white border-transparent shadow-[var(--shadow-xs)]',
  PUT: 'bg-[var(--method-put-solid)] text-white border-transparent shadow-[var(--shadow-xs)]',
  PATCH: 'bg-[var(--method-patch-solid)] text-white border-transparent shadow-[var(--shadow-xs)]',
  DELETE: 'bg-[var(--method-delete-solid)] text-white border-transparent shadow-[var(--shadow-xs)]',
  HEAD: 'bg-[var(--method-neutral-solid)] text-white border-transparent shadow-[var(--shadow-xs)]',
  OPTIONS:
    'bg-[var(--method-neutral-solid)] text-white border-transparent shadow-[var(--shadow-xs)]',
}

export function MethodBadge({
  method,
  compact = false,
  active = false,
  solid = false,
  className,
}: {
  method: HttpMethod
  compact?: boolean
  active?: boolean
  solid?: boolean
  className?: string
}) {
  const isSolid = solid || active
  const variant = methodVariantMap[method] ?? 'neutral'
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center shrink-0 font-mono font-semibold uppercase tracking-tight border rounded-[var(--radius-sm)] tabular-nums transition-all',
        compact ? 'w-[46px] h-[17px] px-0 text-[10px]' : 'w-[56px] h-[22px] px-0 text-[11px]',
        isSolid
          ? (methodSolidStyleMap[method] ?? methodSolidStyleMap.GET)
          : cn(badgeStyles[variant], 'opacity-70 group-hover:opacity-100'),
        className,
      )}
    >
      {method}
    </span>
  )
}

export function renderMethodTrigger(
  opt?: { value: string; label: string },
  fallbackMethod: HttpMethod = 'GET',
) {
  const method = ((opt?.value ?? fallbackMethod) as HttpMethod)
  return (
    <div className="flex items-center justify-center w-full min-w-0">
      <MethodBadge method={method} solid className="w-[62px] h-[21px] text-[11px]" />
    </div>
  )
}

export function renderMethodOption(
  opt: { value: string; label: string },
  { isSelected }: { isSelected: boolean },
) {
  const method = opt.value as HttpMethod
  return (
    <div className="flex items-center justify-center w-full">
      <MethodBadge
        method={method}
        solid
        className={cn(
          'w-[64px] h-[22px] text-[11px]',
          isSelected &&
            'ring-2 ring-[var(--color-primary)] ring-offset-1 ring-offset-[var(--color-surface)]',
        )}
      />
    </div>
  )
}
