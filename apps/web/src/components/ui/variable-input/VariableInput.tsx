'use client'

import { fuzzySubsequenceScore } from '@meofast/shared'
import { AnimatePresence, motion } from 'motion/react'
import {
  type ChangeEvent,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Badge } from '@/components/ui/badge'
import { Icon } from '@/components/ui/icon'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/utils/cn'

export type VariableScopeKind = 'environment' | 'folder' | 'collection' | 'global' | 'dynamic'

export interface ResolvedVariableItem {
  key: string
  value: string
  scope: VariableScopeKind
  scopeLabel: string
  environmentId: string | null
  isSecret?: boolean
  hasSecretValue?: boolean
  editable: boolean
}

export type VariableInputSize = 'sm' | 'md' | 'lg'
export type VariableInputVariant = 'default' | 'bare' | 'cell'

export interface VariableInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'value' | 'onChange'> {
  value: string
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void
  onValueChange?: (value: string) => void
  variables: ResolvedVariableItem[]
  defaultTargetLabel?: string
  defaultTargetEnvId?: string | null
  onSaveVariable?: (input: {
    key: string
    value: string
    environmentId: string | null
  }) => Promise<void> | void
  label?: string
  hint?: string
  error?: string
  size?: VariableInputSize
  variant?: VariableInputVariant
  wrapperClassName?: string
}

interface TokenSegment {
  type: 'text' | 'var'
  raw: string
  varKey?: string
  start: number
  end: number
}

function splitTemplateSegments(text: string): TokenSegment[] {
  if (!text) return []
  const segments: TokenSegment[] = []
  const regex = /\{\{([^{}]*)\}\}/g
  let lastIdx = 0
  let match = regex.exec(text)

  while (match !== null) {
    if (match.index > lastIdx) {
      segments.push({
        type: 'text',
        raw: text.slice(lastIdx, match.index),
        start: lastIdx,
        end: match.index,
      })
    }
    const rawToken = match[0]
    const innerKey = (match[1] ?? '').trim()
    segments.push({
      type: 'var',
      raw: rawToken,
      varKey: innerKey,
      start: match.index,
      end: match.index + rawToken.length,
    })
    lastIdx = match.index + rawToken.length
    match = regex.exec(text)
  }

  if (lastIdx < text.length) {
    segments.push({
      type: 'text',
      raw: text.slice(lastIdx),
      start: lastIdx,
      end: text.length,
    })
  }

  return segments
}

const sizeClasses: Record<VariableInputSize, string> = {
  sm: 'h-[30px] rounded-[var(--radius-md)]',
  md: 'h-[34px] rounded-[var(--radius-md)]',
  lg: 'h-[38px] rounded-[var(--radius-lg)]',
}

export function VariableInput({
  value,
  onChange,
  onValueChange,
  variables,
  defaultTargetLabel = 'Global',
  defaultTargetEnvId = null,
  onSaveVariable,
  label,
  hint,
  error,
  size = 'md',
  variant = 'default',
  type = 'text',
  required,
  disabled,
  id,
  placeholder,
  className,
  wrapperClassName,
  onKeyDown,
  onFocus,
  onBlur,
  ...rest
}: VariableInputProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  const isPasswordType = type === 'password'
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [mounted, setMounted] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const suggestRef = useRef<HTMLDivElement>(null)
  const hoverCardRef = useRef<HTMLDivElement>(null)
  const tokenSpanRefs = useRef<Map<number, HTMLSpanElement>>(new Map())

  // Autocomplete state
  const [suggestState, setSuggestState] = useState<{
    open: boolean
    query: string
    replaceStart: number
    replaceEnd: number
    highlightedIdx: number
    top?: number
    bottom?: number
    left: number
  }>({
    open: false,
    query: '',
    replaceStart: 0,
    replaceEnd: 0,
    highlightedIdx: 0,
    top: 0,
    left: 0,
  })

  // Hover popover state
  const [hoveredVar, setHoveredVar] = useState<{
    key: string
    top?: number
    bottom?: number
    left: number
  } | null>(null)
  const [draftVarValue, setDraftVarValue] = useState('')
  const [savingVar, setSavingVar] = useState(false)
  const [copiedVar, setCopiedVar] = useState(false)
  const [hoverInputFocused, setHoverInputFocused] = useState(false)

  const openHoverTimerRef = useRef<number | null>(null)
  const closeHoverTimerRef = useRef<number | null>(null)

  useEffect(() => {
    setMounted(true)
    return () => {
      if (openHoverTimerRef.current) window.clearTimeout(openHoverTimerRef.current)
      if (closeHoverTimerRef.current) window.clearTimeout(closeHoverTimerRef.current)
    }
  }, [])

  const variableMap = useMemo(() => {
    const map = new Map<string, ResolvedVariableItem>()
    for (const v of variables) {
      map.set(v.key, v)
    }
    return map
  }, [variables])

  const segments = useMemo(() => splitTemplateSegments(value), [value])
  const hasTemplateSyntax = value.includes('{{')
  const maskAsPassword = isPasswordType && !passwordVisible && !hasTemplateSyntax

  const syncScroll = useCallback(() => {
    if (inputRef.current && mirrorRef.current) {
      mirrorRef.current.scrollLeft = inputRef.current.scrollLeft
    }
  }, [])

  useEffect(() => {
    syncScroll()
  }, [value, syncScroll])

  const filteredSuggestions = useMemo(() => {
    if (!suggestState.open) return []
    const q = suggestState.query.trim()
    if (!q) return variables.slice(0, 10)
    return variables
      .map((v) => ({ v, score: fuzzySubsequenceScore(q, v.key) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((entry) => entry.v)
  }, [suggestState.open, suggestState.query, variables])

  const detectAutocomplete = useCallback((nextText: string, caretPos: number | null) => {
    const el = inputRef.current
    if (!el || caretPos === null) {
      setSuggestState((prev) => (prev.open ? { ...prev, open: false } : prev))
      return
    }

    const beforeCaret = nextText.slice(0, caretPos)
    const match = beforeCaret.match(/\{\{([a-zA-Z0-9_$.-]*)$/)
    if (!match) {
      setSuggestState((prev) => (prev.open ? { ...prev, open: false } : prev))
      return
    }

    const query = match[1] ?? ''
    const replaceStart = caretPos - match[0].length
    const afterCaret = nextText.slice(caretPos)
    const closingMatch = afterCaret.match(/^[a-zA-Z0-9_$.-]*(\}{1,2})?/)
    const replaceEnd = caretPos + (closingMatch ? closingMatch[0].length : 0)

    const rect = el.getBoundingClientRect()
    const approxCharOffset = Math.min(rect.width - 40, Math.max(8, replaceStart * 7.2 - el.scrollLeft))
    const left = Math.min(window.innerWidth - 310, Math.max(8, rect.left + approxCharOffset))
    const spaceBelow = window.innerHeight - rect.bottom
    const openUpward = spaceBelow < 230 && rect.top > spaceBelow

    setSuggestState((prev) => ({
      open: true,
      query,
      replaceStart,
      replaceEnd,
      highlightedIdx: prev.query === query ? prev.highlightedIdx : 0,
      top: openUpward ? undefined : rect.bottom + 6,
      bottom: openUpward ? window.innerHeight - rect.top + 6 : undefined,
      left,
    }))
    setHoveredVar(null)
  }, [])

  const emitChange = (nextVal: string) => {
    onValueChange?.(nextVal)
    if (onChange) {
      const synthetic = {
        target: { value: nextVal },
        currentTarget: { value: nextVal },
      } as ChangeEvent<HTMLInputElement>
      onChange(synthetic)
    }
  }

  const applySuggestion = (item: ResolvedVariableItem) => {
    const inserted = `{{${item.key}}}`
    const nextVal =
      value.slice(0, suggestState.replaceStart) +
      inserted +
      value.slice(suggestState.replaceEnd)

    emitChange(nextVal)
    setSuggestState((prev) => ({ ...prev, open: false }))

    const nextCaret = suggestState.replaceStart + inserted.length
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus()
        inputRef.current.setSelectionRange(nextCaret, nextCaret)
        syncScroll()
      }
    })
  }

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const nextVal = e.target.value
    onValueChange?.(nextVal)
    onChange?.(e)
    const caret = e.target.selectionStart
    detectAutocomplete(nextVal, caret)
    requestAnimationFrame(syncScroll)
  }

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggestState.open && filteredSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setSuggestState((prev) => ({
          ...prev,
          highlightedIdx: (prev.highlightedIdx + 1) % filteredSuggestions.length,
        }))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSuggestState((prev) => ({
          ...prev,
          highlightedIdx:
            (prev.highlightedIdx - 1 + filteredSuggestions.length) % filteredSuggestions.length,
        }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const chosen = filteredSuggestions[suggestState.highlightedIdx] ?? filteredSuggestions[0]
        if (chosen) {
          e.preventDefault()
          e.stopPropagation()
          applySuggestion(chosen)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setSuggestState((prev) => ({ ...prev, open: false }))
        return
      }
    }

    onKeyDown?.(e)
    requestAnimationFrame(syncScroll)
  }

  const handleInputFocus = (e: FocusEvent<HTMLInputElement>) => {
    onFocus?.(e)
  }

  const handleInputBlur = (e: FocusEvent<HTMLInputElement>) => {
    window.setTimeout(() => {
      setSuggestState((prev) => (prev.open ? { ...prev, open: false } : prev))
    }, 120)
    onBlur?.(e)
  }

  const scheduleCloseHover = useCallback(() => {
    if (openHoverTimerRef.current) {
      window.clearTimeout(openHoverTimerRef.current)
      openHoverTimerRef.current = null
    }
    if (closeHoverTimerRef.current) window.clearTimeout(closeHoverTimerRef.current)
    closeHoverTimerRef.current = window.setTimeout(() => {
      setHoveredVar((prev) => (hoverInputFocused ? prev : null))
    }, 170)
  }, [hoverInputFocused])

  const cancelCloseHover = useCallback(() => {
    if (closeHoverTimerRef.current) {
      window.clearTimeout(closeHoverTimerRef.current)
      closeHoverTimerRef.current = null
    }
  }, [])

  const handleWrapperMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (suggestState.open || maskAsPassword) return
    const { clientX, clientY } = e

    let matchedKey: string | null = null
    let matchedRect: DOMRect | null = null

    for (const [segIdx, spanEl] of tokenSpanRefs.current.entries()) {
      const seg = segments[segIdx]
      if (!seg || seg.type !== 'var' || !seg.varKey) continue
      const r = spanEl.getBoundingClientRect()
      if (
        clientX >= r.left - 2 &&
        clientX <= r.right + 2 &&
        clientY >= r.top - 2 &&
        clientY <= r.bottom + 2
      ) {
        matchedKey = seg.varKey
        matchedRect = r
        break
      }
    }

    if (!matchedKey || !matchedRect) {
      if (hoveredVar && !hoverInputFocused) {
        scheduleCloseHover()
      }
      return
    }

    cancelCloseHover()
    if (hoveredVar?.key === matchedKey) return

    if (openHoverTimerRef.current) window.clearTimeout(openHoverTimerRef.current)
    const targetRect = matchedRect
    const keyToOpen = matchedKey

    openHoverTimerRef.current = window.setTimeout(() => {
      const resolved = variableMap.get(keyToOpen)
      const spaceBelow = window.innerHeight - targetRect.bottom
      const openUpward = spaceBelow < 150 && targetRect.top > spaceBelow
      const clampedLeft = Math.min(window.innerWidth - 332, Math.max(8, targetRect.left))

      setDraftVarValue(resolved && !resolved.isSecret ? resolved.value : '')
      setCopiedVar(false)
      setHoveredVar({
        key: keyToOpen,
        top: openUpward ? undefined : targetRect.bottom + 6,
        bottom: openUpward ? window.innerHeight - targetRect.top + 6 : undefined,
        left: clampedLeft,
      })
    }, 85)
  }

  // Close hover card when clicking outside
  useEffect(() => {
    if (!hoveredVar) return undefined
    const onDocDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node
      if (hoverCardRef.current?.contains(target) || containerRef.current?.contains(target)) {
        return
      }
      setHoverInputFocused(false)
      setHoveredVar(null)
    }
    const onViewport = () => {
      if (!hoverInputFocused) setHoveredVar(null)
    }
    document.addEventListener('mousedown', onDocDown)
    window.addEventListener('scroll', onViewport, true)
    window.addEventListener('resize', onViewport)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      window.removeEventListener('scroll', onViewport, true)
      window.removeEventListener('resize', onViewport)
    }
  }, [hoveredVar, hoverInputFocused])

  const activeHoverResolved = hoveredVar ? variableMap.get(hoveredVar.key) : undefined

  const handleSaveHoveredVariable = async () => {
    if (!hoveredVar || !onSaveVariable) return
    const targetEnvId = activeHoverResolved
      ? activeHoverResolved.environmentId
      : defaultTargetEnvId

    setSavingVar(true)
    try {
      await onSaveVariable({
        key: hoveredVar.key,
        value: draftVarValue,
        environmentId: targetEnvId,
      })
      setHoverInputFocused(false)
    } finally {
      setSavingVar(false)
    }
  }

  const paddingClasses =
    variant === 'bare'
      ? 'px-3'
      : variant === 'cell'
        ? 'px-2'
        : isPasswordType
          ? 'pl-3 pr-9'
          : 'px-3'

  const wrapperAppearance =
    variant === 'bare'
      ? 'h-full flex-1 min-w-0'
      : variant === 'cell'
        ? 'h-7 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background)] hover:border-[var(--color-border-strong)] focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary)]/15 transition-all'
        : cn(
            'w-full border bg-[var(--color-surface)] shadow-[var(--shadow-xs)] transition-all duration-150 hover:border-[var(--color-primary)]/70 focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary)]/16',
            sizeClasses[size],
            error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-strong)]',
            disabled && 'opacity-55 cursor-not-allowed bg-[var(--color-surface-secondary)]',
          )

  const canEditHoverValue = Boolean(
    onSaveVariable && (!activeHoverResolved || activeHoverResolved.editable),
  )
  const isHoverDirty = activeHoverResolved
    ? activeHoverResolved.isSecret
      ? draftVarValue.length > 0
      : draftVarValue !== activeHoverResolved.value
    : draftVarValue.length > 0

  return (
    <div
      className={cn(
        variant === 'bare' ? 'flex-1 h-full min-w-0 flex items-center' : 'flex flex-col gap-1 w-full',
        wrapperClassName,
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

      <div
        ref={containerRef}
        onMouseMove={handleWrapperMouseMove}
        onMouseLeave={() => {
          if (!hoverInputFocused) scheduleCloseHover()
        }}
        className={cn('relative flex items-center overflow-hidden', wrapperAppearance, className)}
      >
        {/* Synchronized Syntax-Highlighted Mirror Layer */}
        {!maskAsPassword && value.length > 0 ? (
          <div
            ref={mirrorRef}
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre font-mono text-xs font-normal tracking-normal [font-variant-ligatures:none] select-none',
              paddingClasses,
            )}
          >
            {segments.map((seg, idx) => {
              if (seg.type === 'text') {
                return (
                  <span key={`${seg.start}-t`} className="text-[var(--color-text)]">
                    {seg.raw}
                  </span>
                )
              }
              const isValid = Boolean(seg.varKey && variableMap.has(seg.varKey))
              return (
                <span
                  key={`${seg.start}-v`}
                  ref={(el) => {
                    if (el) tokenSpanRefs.current.set(idx, el)
                    else tokenSpanRefs.current.delete(idx)
                  }}
                  className={cn(
                    'rounded-[3px] transition-colors',
                    isValid
                      ? 'text-[var(--color-success)] bg-[var(--color-success-subtle)]/85'
                      : 'text-[var(--color-danger)] bg-[var(--color-danger-subtle)]/85 underline decoration-wavy decoration-[var(--color-danger)]/65 underline-offset-2',
                  )}
                >
                  {seg.raw}
                </span>
              )
            })}
          </div>
        ) : null}

        <input
          ref={inputRef}
          id={fieldId}
          type={maskAsPassword ? 'password' : 'text'}
          value={value}
          disabled={disabled}
          required={required}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          onChange={handleInputChange}
          onKeyDown={handleInputKeyDown}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          onScroll={syncScroll}
          onClick={(e) => {
            syncScroll()
            const target = e.currentTarget
            detectAutocomplete(target.value, target.selectionStart)
          }}
          className={cn(
            'relative z-10 w-full h-full bg-transparent font-mono text-xs font-normal tracking-normal [font-variant-ligatures:none] placeholder:text-[var(--color-text-muted)] outline-none min-w-0 caret-[var(--color-primary)]',
            !maskAsPassword && value.length > 0
              ? 'text-transparent selection:bg-[var(--color-primary)]/22 selection:text-transparent'
              : 'text-[var(--color-text)]',
            paddingClasses,
          )}
          {...rest}
        />

        {isPasswordType ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setPasswordVisible((v) => !v)}
            aria-label={passwordVisible ? 'Hide value' : 'Show value'}
            className="absolute right-1 inset-y-1 z-20 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] cursor-pointer transition-colors"
          >
            <Icon name={passwordVisible ? 'eye-off' : 'eye'} size={14} />
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-xs font-medium text-[var(--color-danger)] leading-snug">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-[var(--color-text-muted)] leading-snug">{hint}</p>
      ) : null}

      {/* 1. Autocomplete Suggestions Popover on typing {{ */}
      {mounted && suggestState.open && filteredSuggestions.length > 0
        ? createPortal(
            <div
              ref={suggestRef}
              role="listbox"
              aria-label="Environment variable suggestions"
              style={{
                position: 'fixed',
                ...(suggestState.bottom !== undefined
                  ? { bottom: `${suggestState.bottom}px` }
                  : { top: `${suggestState.top ?? 0}px` }),
                left: `${suggestState.left}px`,
              }}
              className="z-[150] w-[300px] max-h-[224px] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-popover)]"
            >
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] flex items-center justify-between">
                <span>Variables</span>
                <span>Tab / Enter</span>
              </div>
              {filteredSuggestions.map((item, idx) => {
                const active = idx === suggestState.highlightedIdx
                return (
                  <button
                    key={`${item.scope}-${item.key}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      applySuggestion(item)
                    }}
                    onMouseEnter={() =>
                      setSuggestState((prev) => ({ ...prev, highlightedIdx: idx }))
                    }
                    className={cn(
                      'w-full h-8 px-2 rounded-[var(--radius-sm)] flex items-center justify-between gap-2 text-left text-xs cursor-pointer transition-colors',
                      active
                        ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)]'
                        : 'text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]',
                    )}
                  >
                    <div className="flex flex-col min-w-0 flex-1 leading-tight">
                      <span className="font-mono font-semibold text-[var(--color-success)] truncate">
                        {`{{${item.key}}}`}
                      </span>
                      <span className="font-mono text-[10px] text-[var(--color-text-muted)] truncate">
                        {item.isSecret ? '•••••••• (Secret)' : item.value || '(empty)'}
                      </span>
                    </div>
                    <Badge
                      variant={
                        item.scope === 'environment'
                          ? 'primary'
                          : item.scope === 'global'
                            ? 'info'
                            : 'neutral'
                      }
                    >
                      {item.scopeLabel}
                    </Badge>
                  </button>
                )
              })}
            </div>,
            document.body,
          )
        : null}

      {/* 2. Bruno-Style Variable Hover Inspector & Live Value Editor Popover */}
      {mounted
        ? createPortal(
            <AnimatePresence>
              {hoveredVar ? (
                <motion.div
                  ref={hoverCardRef}
                  initial={{ opacity: 0, y: 4, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 3, scale: 0.98 }}
                  transition={{ duration: 0.13, ease: [0.16, 1, 0.3, 1] }}
                  onMouseEnter={cancelCloseHover}
                  onMouseLeave={() => {
                    if (!hoverInputFocused) scheduleCloseHover()
                  }}
                  style={{
                    position: 'fixed',
                    ...(hoveredVar.bottom !== undefined
                      ? { bottom: `${hoveredVar.bottom}px` }
                      : { top: `${hoveredVar.top ?? 0}px` }),
                    left: `${hoveredVar.left}px`,
                  }}
                  className="z-[150] w-[320px] rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-popover)] flex flex-col gap-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        'font-mono text-xs font-semibold truncate',
                        activeHoverResolved
                          ? 'text-[var(--color-primary)]'
                          : 'text-[var(--color-danger)]',
                      )}
                    >
                      {hoveredVar.key}
                    </span>

                    {activeHoverResolved ? (
                      <Badge
                        variant={
                          activeHoverResolved.scope === 'environment'
                            ? 'primary'
                            : activeHoverResolved.scope === 'global'
                              ? 'info'
                              : 'neutral'
                        }
                      >
                        <Icon
                          name={
                            activeHoverResolved.scope === 'global'
                              ? 'globe'
                              : activeHoverResolved.scope === 'folder' ||
                                  activeHoverResolved.scope === 'collection'
                                ? 'folder'
                                : activeHoverResolved.scope === 'dynamic'
                                  ? 'sparkles'
                                  : 'layers'
                          }
                          size={11}
                        />
                        <span>{activeHoverResolved.scopeLabel}</span>
                      </Badge>
                    ) : (
                      <Badge variant="danger">Undefined · {defaultTargetLabel}</Badge>
                    )}
                  </div>

                  {canEditHoverValue ? (
                    <div className="relative flex items-center">
                      <input
                        type={activeHoverResolved?.isSecret ? 'password' : 'text'}
                        value={draftVarValue}
                        onFocus={() => setHoverInputFocused(true)}
                        onBlur={() => setHoverInputFocused(false)}
                        onChange={(e) => setDraftVarValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void handleSaveHoveredVariable()
                          }
                          if (e.key === 'Escape') {
                            setHoverInputFocused(false)
                            setHoveredVar(null)
                          }
                        }}
                        placeholder={
                          activeHoverResolved?.isSecret
                            ? '•••••••• (Type new secret & press Enter)'
                            : activeHoverResolved
                              ? 'Empty value'
                              : `Set value in ${defaultTargetLabel}...`
                        }
                        aria-label={`Value for ${hoveredVar.key}`}
                        className="w-full h-8 pl-2.5 pr-16 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-background)] font-mono text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/15 outline-none"
                      />

                      <div className="absolute right-1 inset-y-1 flex items-center gap-1">
                        {isHoverDirty || !activeHoverResolved ? (
                          <button
                            type="button"
                            disabled={savingVar || (!activeHoverResolved && !draftVarValue.trim())}
                            onClick={() => {
                              void handleSaveHoveredVariable()
                            }}
                            className="h-6 px-2 rounded-[var(--radius-sm)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer disabled:opacity-50 transition-colors"
                          >
                            {savingVar ? <Spinner size="sm" /> : 'Save'}
                          </button>
                        ) : !activeHoverResolved.isSecret ? (
                          <button
                            type="button"
                            title="Copy variable value"
                            aria-label="Copy variable value"
                            onClick={async () => {
                              await navigator.clipboard.writeText(activeHoverResolved.value)
                              setCopiedVar(true)
                              window.setTimeout(() => setCopiedVar(false), 1400)
                            }}
                            className="w-6 h-6 rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-surface-hover)] inline-flex items-center justify-center cursor-pointer transition-colors"
                          >
                            <Icon name={copiedVar ? 'check' : 'copy'} size={13} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="h-8 px-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background)] flex items-center justify-between gap-2 font-mono text-xs text-[var(--color-text-secondary)]">
                      <span className="truncate">{activeHoverResolved?.value ?? ''}</span>
                      {activeHoverResolved ? (
                        <button
                          type="button"
                          title="Copy value"
                          aria-label="Copy value"
                          onClick={async () => {
                            await navigator.clipboard.writeText(activeHoverResolved.value)
                            setCopiedVar(true)
                            window.setTimeout(() => setCopiedVar(false), 1400)
                          }}
                          className="w-6 h-6 rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-primary)] inline-flex items-center justify-center cursor-pointer shrink-0"
                        >
                          <Icon name={copiedVar ? 'check' : 'copy'} size={13} />
                        </button>
                      ) : null}
                    </div>
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </div>
  )
}
