'use client'

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/ui/icon'
import { cn } from '@/utils/cn'

export interface SelectOption {
  value: string
  label: string
  badge?: ReactNode
  disabled?: boolean
}

export type SelectSize = 'sm' | 'md' | 'lg'
export type SelectVariant = 'default' | 'subtle' | 'inline'

export interface SelectProps {
  label?: string
  hint?: string
  error?: string
  value: string
  onChange?: (event: { target: { value: string } }) => void
  onValueChange?: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  size?: SelectSize
  variant?: SelectVariant
  prefixIcon?: ReactNode
  required?: boolean
  disabled?: boolean
  id?: string
  ariaLabel?: string
  className?: string
  triggerClassName?: string
  mono?: boolean
  hideChevron?: boolean
  popoverWidth?: number
  popoverMinWidth?: number
  popoverClassName?: string
  renderTrigger?: (selectedOption?: SelectOption) => ReactNode
  renderOption?: (
    option: SelectOption,
    state: { isSelected: boolean; isHighlighted: boolean },
  ) => ReactNode
}

const triggerSizeClasses: Record<SelectSize, string> = {
  sm: 'h-[30px] px-2.5 text-xs rounded-[var(--radius-md)]',
  md: 'h-[34px] px-3 text-[13px] rounded-[var(--radius-md)]',
  lg: 'h-[38px] px-3.5 text-[13px] rounded-[var(--radius-lg)]',
}

const triggerVariantClasses: Record<SelectVariant, string> = {
  default:
    'border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] hover:border-[var(--color-primary)]/70 focus-visible:border-[var(--color-primary)] focus-visible:ring-3 focus-visible:ring-[var(--color-primary)]/18',
  subtle:
    'border border-[var(--color-border-strong)] bg-[var(--color-surface-secondary)] shadow-[var(--shadow-xs)] hover:border-[var(--color-primary)]/70 focus-visible:border-[var(--color-primary)] focus-visible:ring-3 focus-visible:ring-[var(--color-primary)]/18',
  inline:
    'border-0 border-r border-[var(--color-border)] rounded-none bg-[var(--color-surface-secondary)]/75 hover:bg-[var(--color-surface-hover)] focus-visible:bg-[var(--color-surface-hover)]',
}

export function Select({
  label,
  hint,
  error,
  value,
  onChange,
  onValueChange,
  options,
  placeholder = 'Select an option...',
  size = 'md',
  variant = 'default',
  prefixIcon,
  required = false,
  disabled = false,
  id,
  ariaLabel,
  className,
  triggerClassName,
  mono = false,
  hideChevron = false,
  popoverWidth,
  popoverMinWidth,
  popoverClassName,
  renderTrigger,
  renderOption,
}: SelectProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  const listboxId = `${fieldId}-listbox`

  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState<number>(0)
  const [coords, setCoords] = useState<{
    top: number
    left: number
    width: number
    maxHeight: number
    placeAbove: boolean
  }>({
    top: 0,
    left: 0,
    width: 200,
    maxHeight: 260,
    placeAbove: false,
  })

  useEffect(() => {
    setMounted(true)
  }, [])

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  )
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const commitSelection = useCallback(
    (nextVal: string) => {
      onValueChange?.(nextVal)
      onChange?.({ target: { value: nextVal } })
      setOpen(false)
      triggerRef.current?.focus()
    },
    [onChange, onValueChange],
  )

  const updatePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - 12
    const spaceAbove = rect.top - 12
    const placeAbove = spaceBelow < 150 && spaceAbove > spaceBelow
    const availableSpace = placeAbove ? spaceAbove : spaceBelow
    const maxHeight = Math.max(120, Math.min(264, availableSpace))
    const width = popoverWidth ?? Math.max(rect.width, popoverMinWidth ?? 168)
    const clampedLeft = Math.min(rect.left, Math.max(8, window.innerWidth - width - 8))

    setCoords({
      top: placeAbove ? rect.top - 6 : rect.bottom + 6,
      left: clampedLeft,
      width,
      maxHeight,
      placeAbove,
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }, [open, selectedIndex, updatePosition])

  useEffect(() => {
    if (!open) return undefined

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return
      }
      setOpen(false)
    }

    const handleViewportChange = () => {
      updatePosition()
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [open, updatePosition])

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return

    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }

    if (e.key === 'Tab') {
      setOpen(false)
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((prev) => (prev + 1) % Math.max(1, options.length))
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((prev) => (prev - 1 + options.length) % Math.max(1, options.length))
      return
    }

    if (e.key === 'Home') {
      e.preventDefault()
      setHighlightedIndex(0)
      return
    }

    if (e.key === 'End') {
      e.preventDefault()
      setHighlightedIndex(Math.max(0, options.length - 1))
      return
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const candidate = options[highlightedIndex]
      if (candidate && !candidate.disabled) {
        commitSelection(candidate.value)
      }
    }
  }

  const hasCustomWidth = Boolean(className && /\bw-/.test(className))

  return (
    <div
      className={cn(
        'flex flex-col gap-1',
        variant === 'inline' ? 'h-full' : !hasCustomWidth && 'w-full',
        className,
      )}
    >
      {label ? (
        <label
          htmlFor={fieldId}
          className="text-xs font-medium leading-snug text-[var(--color-text-secondary)]"
        >
          {label}
          {required ? <span className="ml-1 text-[var(--color-danger)]">*</span> : null}
        </label>
      ) : null}

      <button
        ref={triggerRef}
        id={fieldId}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
        className={cn(
          'w-full inline-flex items-center justify-between gap-1.5 text-left text-[var(--color-text)] transition-all duration-150 cursor-pointer select-none focus-visible:outline-none disabled:opacity-55 disabled:cursor-not-allowed',
          variant !== 'inline' && triggerSizeClasses[size],
          variant === 'inline' && 'h-full px-2.5 text-xs',
          triggerVariantClasses[variant],
          error && 'border-[var(--color-danger)]',
          mono && 'font-mono text-xs',
          triggerClassName,
        )}
      >
        {renderTrigger ? (
          renderTrigger(selectedOption)
        ) : (
          <span className="inline-flex items-center gap-2 min-w-0 flex-1 truncate">
            {prefixIcon ? (
              <span className="text-[var(--color-primary)] shrink-0 inline-flex items-center">
                {prefixIcon}
              </span>
            ) : null}
            {selectedOption?.badge ? (
              <span className="shrink-0 inline-flex items-center">{selectedOption.badge}</span>
            ) : null}
            <span
              className={cn(
                'truncate leading-normal',
                !selectedOption && 'text-[var(--color-text-muted)]',
              )}
            >
              {selectedOption ? selectedOption.label : placeholder}
            </span>
          </span>
        )}

        {!hideChevron ? (
          <Icon
            name="chevron-down"
            size={14}
            className={cn(
              'shrink-0 text-[var(--color-text-muted)] transition-transform duration-150',
              open && 'rotate-180 text-[var(--color-primary)]',
            )}
          />
        ) : null}
      </button>

      {error ? (
        <p role="alert" className="text-xs font-medium text-[var(--color-danger)] leading-snug">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-[var(--color-text-muted)] leading-snug">{hint}</p>
      ) : null}

      {mounted && open
        ? createPortal(
            <div
              ref={popoverRef}
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel ?? label ?? 'Options'}
              style={{
                position: 'fixed',
                top: coords.placeAbove ? undefined : `${coords.top}px`,
                bottom: coords.placeAbove ? `${window.innerHeight - coords.top}px` : undefined,
                left: `${coords.left}px`,
                width: popoverWidth ? `${popoverWidth}px` : undefined,
                minWidth: `${coords.width}px`,
                maxWidth: popoverWidth ? `${popoverWidth}px` : 'min(92vw, 420px)',
                maxHeight: `${coords.maxHeight}px`,
              }}
              className={cn(
                'z-[130] rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-popover)] overflow-y-auto meofast-popover-enter',
                popoverClassName,
              )}
            >
              {options.map((opt, idx) => {
                const isSelected = opt.value === value
                const isHighlighted = idx === highlightedIndex
                return (
                  <div
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    onClick={() => {
                      if (!opt.disabled) commitSelection(opt.value)
                    }}
                    className={cn(
                      'h-8 px-2.5 rounded-[var(--radius-sm)] text-xs flex items-center justify-between gap-2.5 cursor-pointer select-none transition-colors',
                      mono && 'font-mono',
                      opt.disabled && 'opacity-45 cursor-not-allowed',
                      isHighlighted && !opt.disabled && 'bg-[var(--color-surface-hover)] text-[var(--color-text)]',
                      isSelected && 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] font-medium',
                    )}
                  >
                    {renderOption ? (
                      renderOption(opt, { isSelected, isHighlighted })
                    ) : (
                      <>
                        <span className="inline-flex items-center gap-2 min-w-0 truncate">
                          {opt.badge ? <span className="shrink-0">{opt.badge}</span> : null}
                          <span className="truncate">{opt.label}</span>
                        </span>
                        {isSelected ? (
                          <Icon name="check" size={14} className="shrink-0 text-[var(--color-primary)]" />
                        ) : (
                          <span className="w-3.5 shrink-0" />
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
