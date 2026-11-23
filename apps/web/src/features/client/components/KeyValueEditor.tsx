'use client'

import type { KeyValueItem } from '@meofast/shared'
import { useState } from 'react'
import {
  Button,
  CodeEditor,
  Icon,
  type ResolvedVariableItem,
  useConfirm,
  useToast,
  VariableInput,
} from '@/components/ui'

interface KeyValueEditorProps {
  items: KeyValueItem[]
  onChange: (next: KeyValueItem[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  addLabel?: string
  variables?: ResolvedVariableItem[]
  defaultTargetLabel?: string
  defaultTargetEnvId?: string | null
  onSaveVariable?: (input: {
    key: string
    value: string
    environmentId: string | null
  }) => Promise<void> | void
}

function serializeItemsToBulkText(items: KeyValueItem[]): string {
  return items
    .filter((item) => item.key.trim() || item.value.trim())
    .map((item) => `${item.enabled ? '' : '# '}${item.key}: ${item.value}`)
    .join('\n')
}

function parseBulkTextToItems(text: string, previousItems: KeyValueItem[]): KeyValueItem[] {
  const prevByKeyPool = new Map<string, KeyValueItem[]>()
  for (const prev of previousItems) {
    const k = prev.key.trim().toLowerCase()
    const list = prevByKeyPool.get(k) ?? []
    list.push(prev)
    prevByKeyPool.set(k, list)
  }

  const out: KeyValueItem[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue

    let enabled = true
    let working = rawLine
    if (/^\s*(#|\/\/)/.test(working)) {
      enabled = false
      working = working.replace(/^\s*(#|\/\/)\s?/, '')
    }

    const colonIdx = working.indexOf(':')
    const eqIdx = working.indexOf('=')
    let splitIdx = colonIdx
    if (splitIdx === -1 || (eqIdx !== -1 && eqIdx < splitIdx)) {
      splitIdx = eqIdx
    }

    const key = splitIdx >= 0 ? working.slice(0, splitIdx).trim() : working.trim()
    const value = splitIdx >= 0 ? working.slice(splitIdx + 1).trim() : ''
    if (!key && !value) continue

    const pool = prevByKeyPool.get(key.toLowerCase())
    const reused = pool?.shift()

    out.push({
      id: reused?.id ?? crypto.randomUUID(),
      key,
      value,
      description: reused?.description ?? '',
      enabled,
    })
  }
  return out
}

export function KeyValueEditor({
  items,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value (supports {{variable}})',
  addLabel = 'Add Row',
  variables = [],
  defaultTargetLabel = 'Global',
  defaultTargetEnvId = null,
  onSaveVariable,
}: KeyValueEditorProps) {
  const confirm = useConfirm()
  const toast = useToast()
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkDraft, setBulkDraft] = useState('')

  const handleToggleBulkMode = () => {
    if (!bulkMode) {
      setBulkDraft(serializeItemsToBulkText(items))
      setBulkMode(true)
    } else {
      onChange(parseBulkTextToItems(bulkDraft, items))
      setBulkMode(false)
    }
  }

  const handleBulkDraftChange = (nextText: string) => {
    setBulkDraft(nextText)
    onChange(parseBulkTextToItems(nextText, items))
  }

  const addRow = () => {
    onChange([
      ...items,
      {
        id: crypto.randomUUID(),
        key: '',
        value: '',
        description: '',
        enabled: true,
      },
    ])
  }

  const updateRow = (id: string, patch: Partial<KeyValueItem>) => {
    onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const removeRow = async (row: KeyValueItem) => {
    const ok = await confirm({
      title: 'Are you sure?',
      description:
        row.key.trim()
          ? `This action cannot be undone. All values associated with "${row.key.trim()}" will be lost.`
          : 'This action cannot be undone. All values associated with this field will be lost.',
      confirmLabel: 'Delete field',
    })
    if (!ok) return
    onChange(items.filter((item) => item.id !== row.id))
    toast.info('Field removed')
  }

  return (
    <div className="w-full flex flex-col gap-2">
      {bulkMode ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--color-text-secondary)]">
            <span>
              Enter one <code className="font-mono">key: value</code> pair per line. Prefix a line
              with <code className="font-mono">#</code> or <code className="font-mono">//</code> to
              disable it.
            </span>
          </div>
          <CodeEditor
            language="text"
            value={bulkDraft}
            onChange={handleBulkDraftChange}
            placeholder={'Accept: application/json\nAuthorization: Bearer {{accessToken}}\n# X-Debug-Mode: true'}
            minHeight="135px"
            ariaLabel="Bulk key value editor"
          />
        </div>
      ) : (
        <div className="border border-[var(--color-border)] rounded-[var(--radius-md)] overflow-hidden bg-[var(--color-surface)]">
          <div className="grid grid-cols-[36px_1fr_1fr_36px] items-center h-7 px-2 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)] text-[11px] font-medium text-[var(--color-text-secondary)]">
            <span className="text-center">On</span>
            <span className="px-2">Key</span>
            <span className="px-2">Value</span>
            <span className="sr-only">Actions</span>
          </div>

          {items.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">
              No entries configured yet.
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {items.map((row) => (
                <div
                  key={row.id}
                  className="grid grid-cols-[36px_1fr_1fr_36px] items-center px-2 py-1 gap-1.5"
                >
                  <div className="flex justify-center">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      aria-label={`Enable ${row.key || 'row'}`}
                      onChange={(e) => updateRow(row.id, { enabled: e.target.checked })}
                      className="w-3.5 h-3.5 accent-[var(--color-primary)] cursor-pointer rounded"
                    />
                  </div>
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) => updateRow(row.id, { key: e.target.value })}
                    placeholder={keyPlaceholder}
                    aria-label={keyPlaceholder}
                    className="h-7 px-2 text-xs font-mono bg-[var(--color-background)] rounded-[var(--radius-sm)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/15 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none transition-all"
                  />
                  <VariableInput
                    variant="cell"
                    value={row.value}
                    onChange={(e) => updateRow(row.id, { value: e.target.value })}
                    placeholder={valuePlaceholder}
                    aria-label={valuePlaceholder}
                    variables={variables}
                    defaultTargetLabel={defaultTargetLabel}
                    defaultTargetEnvId={defaultTargetEnvId}
                    onSaveVariable={onSaveVariable}
                  />
                  <button
                    type="button"
                    aria-label="Delete row"
                    onClick={() => {
                      void removeRow(row)
                    }}
                    className="w-7 h-7 inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] cursor-pointer transition-colors"
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          {!bulkMode ? (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Icon name="plus" size={13} />}
              onClick={addRow}
            >
              {addLabel}
            </Button>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={bulkMode ? 'primary' : 'ghost'}
          leftIcon={<Icon name={bulkMode ? 'rows' : 'code'} size={13} />}
          onClick={handleToggleBulkMode}
        >
          {bulkMode ? 'Table View' : 'Bulk Edit'}
        </Button>
      </div>
    </div>
  )
}
