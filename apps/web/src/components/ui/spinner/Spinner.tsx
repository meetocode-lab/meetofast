import { cn } from '@/utils/cn'

export function Spinner({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block rounded-full border-2 border-current border-r-transparent animate-spin',
        size === 'sm' && 'w-3.5 h-3.5',
        size === 'md' && 'w-5 h-5',
        size === 'lg' && 'w-7 h-7',
        className,
      )}
    />
  )
}
