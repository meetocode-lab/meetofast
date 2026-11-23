'use client'

import type { CollectionRunSummary } from '@meofast/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, useState } from 'react'
import {
  Badge,
  Button,
  CodeEditor,
  Dialog,
  Icon,
  Input,
  MethodBadge,
  Select,
  Switch,
} from '@/components/ui'
import { apiRequest } from '@/lib/api-client'
import { formatDuration } from '@/utils/cn'

interface RunnerProps {
  open: boolean
  onClose: () => void
  workspaceId: string
  collection: {
    id: string
    name: string
    folders: Array<{ id: string; name: string }>
  } | null
  initialFolderId?: string | null
  environments: Array<{ id: string; name: string; isGlobal: boolean }>
  activeEnvironmentId: string | null
}

function parseDataInput(raw: string): Array<Record<string, string>> {
  const trimmed = raw.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>
    return arr.map((row) => {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(row)) {
        out[k] = v === null || v === undefined ? '' : String(v)
      }
      return out
    })
  }

  // CSV parser
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const headers = lines[0]!.split(',').map((h) => h.trim().replace(/^"|"$/g, ''))
  return lines.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => {
      if (h) row[h] = cols[idx] ?? ''
    })
    return row
  })
}

export function CollectionRunnerModal({
  open,
  onClose,
  workspaceId,
  collection,
  initialFolderId = null,
  environments,
  activeEnvironmentId,
}: RunnerProps) {
  const queryClient = useQueryClient()
  const [folderId, setFolderId] = useState<string>(initialFolderId ?? '__all__')
  const [envId, setEnvId] = useState<string>(activeEnvironmentId ?? '__none__')
  const [delayMs, setDelayMs] = useState('0')
  const [smartOrder, setSmartOrder] = useState(true)
  const [dataText, setDataText] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [result, setResult] = useState<CollectionRunSummary | null>(null)

  const runMutation = useMutation({
    mutationFn: async () => {
      if (!collection) throw new Error('No collection selected')
      setParseError(null)
      let dataRows: Array<Record<string, string>> = []
      if (dataText.trim()) {
        try {
          dataRows = parseDataInput(dataText)
        } catch {
          throw new Error('Invalid CSV or JSON array in data input.')
        }
      }

      return apiRequest<CollectionRunSummary>(`/api/v1/collections/${collection.id}/run`, {
        method: 'POST',
        body: JSON.stringify({
          environmentId: envId === '__none__' ? null : envId,
          folderId: folderId === '__all__' ? null : folderId,
          delayMs: Number(delayMs) || 0,
          smartOrder,
          dataRows,
        }),
      })
    },
    onSuccess: (summary) => {
      setResult(summary)
      void queryClient.invalidateQueries({ queryKey: ['environments', workspaceId] })
      void queryClient.invalidateQueries({ queryKey: ['history', workspaceId] })
    },
    onError: (err) => {
      setParseError(err instanceof Error ? err.message : 'Run failed')
    },
  })

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    setDataText(text)
  }

  const handleExportReport = () => {
    if (!result) return
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `run-report-${result.collectionName.toLowerCase().replace(/\s+/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!collection) return null

  return (
    <Dialog
      open={open}
      title={`Run Collection — ${collection.name}`}
      maxWidthClass="max-w-3xl"
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select
            label="Scope"
            value={folderId}
            onValueChange={setFolderId}
            options={[
              { value: '__all__', label: 'Entire Collection' },
              ...collection.folders.map((f) => ({ value: f.id, label: `Folder: ${f.name}` })),
            ]}
          />
          <Select
            label="Environment"
            value={envId}
            onValueChange={setEnvId}
            options={[
              { value: '__none__', label: 'No Environment' },
              ...environments
                .filter((e) => !e.isGlobal)
                .map((e) => ({ value: e.id, label: e.name })),
            ]}
          />
          <Input
            label="Delay (ms)"
            type="number"
            value={delayMs}
            mono
            onChange={(e) => setDelayMs(e.target.value)}
          />
        </div>

        <Switch
          checked={smartOrder}
          onChange={setSmartOrder}
          label="Auto-order dependent requests"
          description="Automatically runs token/variable producer requests before endpoints that reference {{variables}}."
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-[var(--color-text)]">
              Data Rows (Optional CSV or JSON Array)
            </span>
            <label className="text-xs font-medium text-[var(--color-primary)] hover:underline cursor-pointer">
              Upload .csv / .json
              <input
                type="file"
                accept=".csv,.json"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
          </div>
          <CodeEditor
            language={dataText.trim().startsWith('[') ? 'json' : 'text'}
            value={dataText}
            onChange={setDataText}
            placeholder={'[\n  { "userId": "1" },\n  { "userId": "2" }\n]'}
            minHeight="96px"
            ariaLabel="Runner data rows"
          />
        </div>

        {parseError ? (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {parseError}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 pt-1">
          {result ? (
            <Button
              size="sm"
              variant="outline"
              leftIcon={<Icon name="download" size={13} />}
              onClick={handleExportReport}
            >
              Export JSON Report
            </Button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button
              isLoading={runMutation.isPending}
              leftIcon={<Icon name="play" size={14} />}
              onClick={() => runMutation.mutate()}
            >
              Run Now
            </Button>
          </div>
        </div>

        {result ? (
          <div className="border-t border-[var(--color-border)] pt-4 flex flex-col gap-3">
            {result.reorderedByDependencies ? (
              <div className="flex items-center gap-2">
                <Badge variant="info">Smart Dependency Order Applied</Badge>
              </div>
            ) : null}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 tabular-nums text-xs">
              <div className="p-3 rounded-[var(--radius-lg)] bg-[var(--color-background)] border border-[var(--color-border)]">
                <div className="text-[var(--color-text-secondary)]">Requests</div>
                <div className="text-base font-semibold mt-0.5">{result.totalRequests}</div>
              </div>
              <div className="p-3 rounded-[var(--radius-lg)] bg-[var(--color-success-subtle)] border border-[var(--color-success-border)] text-[var(--color-success)]">
                <div>Passed</div>
                <div className="text-base font-semibold mt-0.5">{result.passedRequests}</div>
              </div>
              <div className="p-3 rounded-[var(--radius-lg)] bg-[var(--color-danger-subtle)] border border-[var(--color-danger-border)] text-[var(--color-danger)]">
                <div>Failed</div>
                <div className="text-base font-semibold mt-0.5">{result.failedRequests}</div>
              </div>
              <div className="p-3 rounded-[var(--radius-lg)] bg-[var(--color-background)] border border-[var(--color-border)]">
                <div className="text-[var(--color-text-secondary)]">Duration</div>
                <div className="text-base font-semibold mt-0.5">
                  {formatDuration(result.totalDurationMs)}
                </div>
              </div>
            </div>

            <div className="border border-[var(--color-border)] rounded-[var(--radius-lg)] divide-y divide-[var(--color-border)] text-xs">
              {result.items.map((item, idx) => (
                <div
                  key={`${item.requestId}-${idx}`}
                  className="px-3.5 py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {result.iterations > 1 ? (
                      <Badge variant="neutral">#{item.iteration}</Badge>
                    ) : null}
                    <MethodBadge method={item.method} compact />
                    <span className="font-medium truncate">{item.requestName}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 tabular-nums">
                    <span className="text-[var(--color-text-muted)] font-mono">
                      {item.status ?? 'ERR'} · {formatDuration(item.durationMs)}
                    </span>
                    <Badge variant={item.passed ? 'success' : 'danger'}>
                      {item.passed ? 'PASS' : 'FAIL'}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
