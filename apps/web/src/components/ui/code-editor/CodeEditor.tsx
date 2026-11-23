'use client'

import { type KeyboardEvent, useMemo, useRef } from 'react'
import { cn } from '@/utils/cn'

export type CodeLanguage = 'json' | 'javascript' | 'xml' | 'text'

export interface CodeEditorProps {
  value: string
  onChange?: (next: string) => void
  language?: CodeLanguage
  placeholder?: string
  readOnly?: boolean
  minHeight?: string
  maxHeight?: string
  ariaLabel?: string
  className?: string
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function highlightCode(source: string, language: CodeLanguage): string {
  if (!source) return ''
  let html = escapeHtml(source)

  if (language === 'json') {
    html = html.replace(
      /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        if (match.startsWith('"')) {
          if (match.endsWith(':')) {
            return `<span style="color:var(--color-primary);font-weight:500">${match}</span>`
          }
          return `<span style="color:var(--color-success)">${match}</span>`
        }
        if (match === 'true' || match === 'false') {
          return `<span style="color:var(--color-info);font-weight:500">${match}</span>`
        }
        if (match === 'null') {
          return `<span style="color:var(--color-text-muted);font-style:italic">${match}</span>`
        }
        return `<span style="color:var(--color-warning)">${match}</span>`
      },
    )
  } else if (language === 'javascript') {
    html = html.replace(
      /(\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|try|catch|throw|new|typeof|true|false|null|undefined)\b|\b(?:pm|mf|console)\b|\b\d+(?:\.\d+)?\b)/g,
      (match) => {
        if (match.startsWith('//')) {
          return `<span style="color:var(--color-text-muted)">${match}</span>`
        }
        if (match.startsWith('"') || match.startsWith("'") || match.startsWith('`')) {
          return `<span style="color:var(--color-success)">${match}</span>`
        }
        if (match === 'pm' || match === 'mf' || match === 'console') {
          return `<span style="color:var(--color-info);font-weight:600">${match}</span>`
        }
        if (/^\d/.test(match)) {
          return `<span style="color:var(--color-warning)">${match}</span>`
        }
        return `<span style="color:var(--color-primary);font-weight:500">${match}</span>`
      },
    )
  } else if (language === 'xml') {
    html = html.replace(
      /(&lt;\/?[a-zA-Z0-9:_-]+(?:\s+[^&]*?)?\/?&gt;)/g,
      (match) => `<span style="color:var(--color-primary)">${match}</span>`,
    )
  }

  // Highlight {{variable}} interpolations across all modes
  html = html.replace(
    /(\{\{\s*[^}\n]+?\s*\}\})/g,
    '<span style="background:var(--color-primary-subtle);color:var(--color-primary);border-radius:3px">$1</span>',
  )

  return html
}

const PAIRS: Record<string, string> = {
  '{': '}',
  '[': ']',
  '(': ')',
  '"': '"',
}

export function CodeEditor({
  value,
  onChange,
  language = 'json',
  placeholder = '',
  readOnly = false,
  minHeight = '180px',
  maxHeight,
  ariaLabel = 'Code editor',
  className,
}: CodeEditorProps) {
  const preRef = useRef<HTMLPreElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const lineCount = useMemo(() => Math.max(1, value.split('\n').length), [value])
  const highlightedHtml = useMemo(() => highlightCode(value, language), [value, language])

  const syncScroll = () => {
    const ta = textareaRef.current
    if (!ta) return
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop
      preRef.current.scrollLeft = ta.scrollLeft
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = ta.scrollTop
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (readOnly || !onChange) return
    const ta = e.currentTarget
    const start = ta.selectionStart
    const end = ta.selectionEnd

    if (e.key === 'Tab') {
      e.preventDefault()
      const next = `${value.slice(0, start)}  ${value.slice(end)}`
      onChange(next)
      requestAnimationFrame(() => {
        ta.selectionStart = start + 2
        ta.selectionEnd = start + 2
      })
      return
    }

    if (e.key === 'Enter') {
      const before = value.slice(0, start)
      const currentLine = before.split('\n').pop() ?? ''
      const indentMatch = /^(\s*)/.exec(currentLine)
      const baseIndent = indentMatch?.[1] ?? ''
      const prevChar = value[start - 1]
      const nextChar = value[end]

      if ((prevChar === '{' && nextChar === '}') || (prevChar === '[' && nextChar === ']')) {
        e.preventDefault()
        const inner = `${baseIndent}  `
        const insert = `\n${inner}\n${baseIndent}`
        onChange(`${value.slice(0, start)}${insert}${value.slice(end)}`)
        requestAnimationFrame(() => {
          const pos = start + 1 + inner.length
          ta.selectionStart = pos
          ta.selectionEnd = pos
        })
        return
      }

      if (baseIndent.length > 0 || prevChar === '{' || prevChar === '[') {
        e.preventDefault()
        const extra = prevChar === '{' || prevChar === '[' ? '  ' : ''
        const insert = `\n${baseIndent}${extra}`
        onChange(`${value.slice(0, start)}${insert}${value.slice(end)}`)
        requestAnimationFrame(() => {
          const pos = start + insert.length
          ta.selectionStart = pos
          ta.selectionEnd = pos
        })
      }
      return
    }

    const closing = PAIRS[e.key]
    if (closing && start === end) {
      if (e.key === '"' && value[start] === '"') {
        e.preventDefault()
        ta.selectionStart = start + 1
        ta.selectionEnd = start + 1
        return
      }
      e.preventDefault()
      onChange(`${value.slice(0, start)}${e.key}${closing}${value.slice(end)}`)
      requestAnimationFrame(() => {
        ta.selectionStart = start + 1
        ta.selectionEnd = start + 1
      })
    }
  }

  if (readOnly) {
    return (
      <div
        style={{ minHeight, maxHeight }}
        className={cn(
          'relative w-full min-h-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] overflow-auto font-mono text-xs leading-[20px]',
          className,
        )}
      >
        <div className="flex min-h-full min-w-max">
          <div
            aria-hidden="true"
            className="sticky left-0 z-10 select-none py-3 px-2.5 text-right bg-[var(--color-surface-secondary)] border-r border-[var(--color-border)] text-[var(--color-text-muted)] tabular-nums shrink-0"
          >
            {Array.from({ length: lineCount }, (_, idx) => (
              <div key={idx} className="h-[20px]">
                {idx + 1}
              </div>
            ))}
          </div>
          <pre
            className="m-0 py-3 px-3.5 flex-1 text-xs font-mono leading-[20px] text-[var(--color-text)] whitespace-pre"
            dangerouslySetInnerHTML={{
              __html: highlightedHtml || escapeHtml(placeholder || '(Empty)'),
            }}
          />
        </div>
      </div>
    )
  }

  const autoGrowHeight = !maxHeight ? `${Math.max(160, lineCount * 20 + 24)}px` : undefined

  return (
    <div
      style={{ minHeight: autoGrowHeight ?? minHeight, maxHeight }}
      className={cn(
        'relative flex w-full min-h-0 rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-background)] focus-within:border-[var(--color-primary)] focus-within:ring-3 focus-within:ring-[var(--color-primary)]/15 overflow-hidden transition-all',
        className,
      )}
    >
      {/* Line Number Gutter */}
      <div
        ref={gutterRef}
        aria-hidden="true"
        className="select-none py-3 px-2.5 min-w-[40px] text-right bg-[var(--color-surface-secondary)]/70 border-r border-[var(--color-border)] text-xs font-mono leading-[20px] text-[var(--color-text-muted)] tabular-nums overflow-hidden shrink-0"
      >
        {Array.from({ length: lineCount }, (_, idx) => (
          <div key={idx} className="h-[20px]">
            {idx + 1}
          </div>
        ))}
      </div>

      {/* Synchronized Highlight + Caret Layer */}
      <div className="relative flex-1 min-w-0" style={{ minHeight: autoGrowHeight ?? minHeight }}>
        <pre
          ref={preRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-0 py-3 px-3.5 font-mono text-xs leading-[20px] whitespace-pre overflow-hidden text-[var(--color-text)]"
          dangerouslySetInnerHTML={{
            __html: `${highlightedHtml}\n`,
          }}
        />
        <textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className={cn(
            'relative z-10 w-full h-full min-h-[inherit] m-0 py-3 px-3.5 font-mono text-xs leading-[20px] whitespace-pre bg-transparent text-transparent caret-[var(--color-primary)] placeholder:text-[var(--color-text-muted)] resize-none outline-none selection:bg-[var(--color-primary)]/25',
            maxHeight ? 'overflow-auto' : 'overflow-x-auto overflow-y-hidden',
          )}
        />
      </div>
    </div>
  )
}
