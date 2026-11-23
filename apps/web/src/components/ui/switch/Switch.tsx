import { cn } from '@/utils/cn'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  ariaLabel?: string
  description?: string
  disabled?: boolean
}

export function Switch({
  checked,
  onChange,
  label,
  ariaLabel,
  description,
  disabled = false,
}: SwitchProps) {
  const buttonEl = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label ?? 'Toggle'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors cursor-pointer disabled:opacity-50',
        checked
          ? 'bg-[var(--color-primary)] border-[var(--color-primary)]'
          : 'bg-[var(--color-surface-secondary)] border-[var(--color-border-strong)]',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  )

  if (!label) return buttonEl

  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <span className="text-[13px] font-medium text-[var(--color-text)]">{label}</span>
        {description ? (
          <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">{description}</p>
        ) : null}
      </div>
      {buttonEl}
    </div>
  )
}
