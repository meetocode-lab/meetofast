'use client'

import { LayoutGroup, motion } from 'motion/react'
import { type ReactNode, useId } from 'react'
import { cn } from '@/utils/cn'

export interface TabItem {
  id: string
  label: string
  count?: number
}

export interface TabsProps {
  items: TabItem[]
  activeId: string
  onChange: (id: string) => void
  rightSlot?: ReactNode
  className?: string
}

export function Tabs({ items, activeId, onChange, rightSlot, className }: TabsProps) {
  const groupId = useId()

  return (
    <div className={cn('flex items-center justify-between gap-3 flex-nowrap min-w-0', className)}>
      <LayoutGroup id={groupId}>
        <div
          role="tablist"
          className="inline-flex items-center gap-0.5 p-[3px] min-h-[30px] rounded-[var(--radius-md)] bg-[var(--color-surface-secondary)] border border-[var(--color-border)] overflow-x-auto max-w-full shrink min-w-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {items.map((item) => {
            const active = item.id === activeId
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onChange(item.id)}
                className={cn(
                  'relative h-6 inline-flex items-center justify-center gap-1.5 px-2.5 text-xs font-medium leading-none whitespace-nowrap rounded-[var(--radius-sm)] transition-colors cursor-pointer shrink-0',
                  active
                    ? 'text-[var(--color-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]',
                )}
              >
                {active ? (
                  <motion.span
                    layoutId={`${groupId}-active-tab`}
                    transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.6 }}
                    className="absolute inset-0 rounded-[var(--radius-sm)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-xs)]"
                  />
                ) : null}
                <span className="relative z-10 inline-flex items-center gap-1.5">
                  <span>{item.label}</span>
                  {typeof item.count === 'number' && item.count > 0 ? (
                    <span className="h-4 min-w-[16px] px-1 inline-flex items-center justify-center text-[10px] font-semibold rounded-full bg-[var(--color-primary-subtle)] text-[var(--color-primary)] tabular-nums">
                      {item.count}
                    </span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      </LayoutGroup>
      {rightSlot ? <div className="flex items-center gap-2 shrink-0">{rightSlot}</div> : null}
    </div>
  )
}
