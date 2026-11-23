import { cn } from '@/utils/cn'

export function Avatar({
  name,
  size = 'md',
}: {
  name: string
  size?: 'sm' | 'md'
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-[var(--color-primary)] text-[var(--color-primary-foreground)] font-semibold select-none shrink-0',
        size === 'sm' ? 'w-6 h-6 text-[11px]' : 'w-8 h-8 text-xs',
      )}
    >
      {initials || 'M'}
    </span>
  )
}
