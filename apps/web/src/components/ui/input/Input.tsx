'use client'

import { type InputHTMLAttributes, type ReactNode, useId, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { cn } from '@/utils/cn'

export type InputSize = 'sm' | 'md' | 'lg'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string
  hint?: string
  error?: string
  mono?: boolean
  size?: InputSize
  leftIcon?: ReactNode
}

const sizeMap: Record<InputSize, string> = {
  sm: 'h-[30px] text-xs rounded-[var(--radius-md)]',
  md: 'h-[34px] text-[13px] rounded-[var(--radius-md)]',
  lg: 'h-[38px] text-[13px] rounded-[var(--radius-lg)]',
}

export function Input({
  label,
  hint,
  error,
  mono = false,
  size = 'md',
  leftIcon,
  required,
  type = 'text',
  id,
  className,
  ...props
}: InputProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  const isPasswordType = type === 'password'
  const [passwordVisible, setPasswordVisible] = useState(false)

  const resolvedType = isPasswordType ? (passwordVisible ? 'text' : 'password') : type

  return (
    <div className="flex flex-col gap-1 w-full">
      {label ? (
        <label
          htmlFor={fieldId}
          className="text-xs font-medium leading-snug text-[var(--color-text-secondary)]"
        >
          {label}
          {required ? <span className="ml-1 text-[var(--color-danger)]">*</span> : null}
        </label>
      ) : null}

      <div className="relative flex items-center w-full">
        {leftIcon ? (
          <span className="pointer-events-none absolute left-2.5 inset-y-0 flex items-center text-[var(--color-text-muted)]">
            {leftIcon}
          </span>
        ) : null}

        <input
          id={fieldId}
          type={resolvedType}
          required={required}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${fieldId}-err` : hint ? `${fieldId}-hint` : undefined}
          className={cn(
            'w-full border bg-[var(--color-surface)] text-[var(--color-text)] shadow-[var(--shadow-xs)] placeholder:text-[var(--color-text-muted)] transition-all duration-150 hover:border-[var(--color-primary)]/70 focus-visible:outline-none focus-visible:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/16 disabled:opacity-55 disabled:cursor-not-allowed disabled:bg-[var(--color-surface-secondary)]',
            sizeMap[size],
            leftIcon ? 'pl-8' : 'px-3',
            isPasswordType && (leftIcon ? 'pr-9' : 'pr-9 pl-3'),
            error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-strong)]',
            mono && 'font-mono text-xs',
            className,
          )}
          {...props}
        />

        {isPasswordType ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setPasswordVisible((v) => !v)}
            aria-label={passwordVisible ? 'Hide password' : 'Show password'}
            className="absolute right-1 inset-y-1 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] cursor-pointer transition-colors"
          >
            <Icon name={passwordVisible ? 'eye-off' : 'eye'} size={14} />
          </button>
        ) : null}
      </div>

      {error ? (
        <p
          id={`${fieldId}-err`}
          role="alert"
          className="text-xs font-medium text-[var(--color-danger)] leading-snug"
        >
          {error}
        </p>
      ) : hint ? (
        <p id={`${fieldId}-hint`} className="text-xs text-[var(--color-text-muted)] leading-snug">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
