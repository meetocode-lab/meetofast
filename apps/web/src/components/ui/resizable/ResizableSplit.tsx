'use client'

import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '@/utils/cn'

export interface ResizableSplitProps {
  direction: 'vertical' | 'horizontal'
  storageKey?: string
  defaultRatio?: number
  minRatio?: number
  maxRatio?: number
  first: ReactNode
  second: ReactNode
  className?: string
}

export function ResizableSplit({
  direction,
  storageKey,
  defaultRatio = 0.52,
  minRatio = 0.25,
  maxRatio = 0.78,
  first,
  second,
  className,
}: ResizableSplitProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(defaultRatio)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!storageKey) return
    const saved = Number(window.localStorage.getItem(storageKey))
    if (!Number.isNaN(saved) && saved >= minRatio && saved <= maxRatio) {
      setRatio(saved)
    }
  }, [storageKey, minRatio, maxRatio])

  const persistRatio = (next: number) => {
    setRatio(next)
    if (storageKey) {
      window.localStorage.setItem(storageKey, String(next))
    }
  }

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const raw =
      direction === 'horizontal'
        ? (e.clientX - rect.left) / Math.max(1, rect.width)
        : (e.clientY - rect.top) / Math.max(1, rect.height)
    const clamped = Math.min(maxRatio, Math.max(minRatio, raw))
    persistRatio(clamped)
  }

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }

  const isHorizontal = direction === 'horizontal'

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex-1 min-w-0 min-h-0 flex overflow-hidden',
        isHorizontal ? 'flex-row' : 'flex-col',
        dragging && 'select-none',
        className,
      )}
    >
      <div
        style={
          isHorizontal
            ? { width: `${ratio * 100}%` }
            : { height: `${ratio * 100}%` }
        }
        className="min-w-0 min-h-0 flex flex-col overflow-hidden shrink-0"
      >
        {first}
      </div>

      {/* Draggable Split Handle */}
      <div
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        title="Drag to resize (double-click to reset)"
        onDoubleClick={() => persistRatio(defaultRatio)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className={cn(
          'group relative z-20 flex items-center justify-center shrink-0 bg-[var(--color-border)] transition-colors',
          isHorizontal ? 'w-1 cursor-col-resize hover:w-1' : 'h-1 cursor-row-resize hover:h-1',
          dragging
            ? 'bg-[var(--color-primary)]'
            : 'hover:bg-[var(--color-primary)]',
        )}
      >
        <span
          className={cn(
            'rounded-full bg-[var(--color-border-strong)] group-hover:bg-[var(--color-primary)] transition-colors',
            isHorizontal ? 'w-1 h-8' : 'h-1 w-8',
            dragging && 'bg-[var(--color-primary)]',
          )}
        />
      </div>

      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">{second}</div>
    </div>
  )
}
