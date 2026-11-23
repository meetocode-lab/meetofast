import type { HTMLAttributes } from 'react'
import { cn } from '@/utils/cn'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'bordered' | 'elevated'
  padding?: 'none' | 'sm' | 'md' | 'lg'
}

export function Card({
  variant = 'default',
  padding = 'md',
  className,
  children,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        'bg-[var(--color-surface)] rounded-[var(--radius-lg)] transition-colors',
        variant === 'default' && 'border border-[var(--color-border)] shadow-[var(--shadow-sm)]',
        variant === 'bordered' && 'border border-[var(--color-border-strong)]',
        variant === 'elevated' && 'border border-[var(--color-border)] shadow-[var(--shadow-md)]',
        padding === 'none' && 'p-0',
        padding === 'sm' && 'p-3',
        padding === 'md' && 'p-4',
        padding === 'lg' && 'p-5',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}
