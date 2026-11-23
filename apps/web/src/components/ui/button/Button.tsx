import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/utils/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  isLoading?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-transparent shadow-[var(--shadow-xs)] hover:bg-[var(--color-primary-hover)] active:bg-[var(--color-primary-active)]',
  secondary:
    'bg-[var(--color-surface-secondary)] text-[var(--color-primary)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-border-strong)]',
  outline:
    'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-primary)]',
  ghost:
    'bg-transparent text-[var(--color-text-secondary)] border-transparent hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]',
  danger:
    'bg-[var(--color-danger)] text-[var(--color-primary-foreground)] border-transparent shadow-[var(--shadow-xs)] hover:bg-[var(--color-danger-hover)]',
}

/**
 * Unified proportional control heights shared identically across Button, Input, and Select:
 * sm = 30px, md = 34px, lg = 38px
 */
const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-[30px] px-2.5 text-xs gap-1.5 rounded-[var(--radius-md)]',
  md: 'h-[34px] px-3 text-[13px] gap-1.5 rounded-[var(--radius-md)]',
  lg: 'h-[38px] px-4 text-[13px] gap-2 rounded-[var(--radius-lg)]',
}

export function Button({
  variant = 'primary',
  size = 'md',
  isLoading = false,
  leftIcon,
  rightIcon,
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  const isDisabled = disabled || isLoading

  return (
    <button
      type={type}
      disabled={isDisabled}
      className={cn(
        'inline-flex items-center justify-center font-medium leading-none border whitespace-nowrap select-none cursor-pointer transition-all duration-150 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--color-primary)]/20 focus-visible:border-[var(--color-primary)] disabled:opacity-55 disabled:cursor-not-allowed shrink-0',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {isLoading ? <Spinner size="sm" /> : leftIcon}
      <span>{children}</span>
      {!isLoading ? rightIcon : null}
    </button>
  )
}
