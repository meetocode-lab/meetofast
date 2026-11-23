'use client'

import {
  computeJsonStructuralDiff,
  computeMyersLineDiff,
  type ResponseExampleItem,
} from '@meofast/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Badge,
  Button,
  CodeEditor,
  DataTable,
  Dialog,
  DropdownMenu,
  Icon,
  Input,
  Spinner,
  Tabs,
  useConfirm,
  useToast,
} from '@/components/ui'
import { apiRequest } from '@/lib/api-client'
import { cn, formatBytes, formatDuration, formatShortTime } from '@/utils/cn'
import { useWorkspaceVariables } from '../hooks/useWorkspaceVariables'
import { type RequestTab, useWorkbenchStore } from '../store/useWorkbenchStore'
import { TypeGeneratorModal } from './TypeGeneratorModal'

function extractPathnameForMock(rawUrl: string): string {
  const withoutVars = rawUrl.replace(/\{\{[^}]+\}\}/g, '').trim()
  if (withoutVars.startsWith('/')) {
    return withoutVars.split('?')[0] || '/mock-endpoint'
  }
  try {
    const parsed = new URL(
      rawUrl.replace(/\{\{[^}]+\}\}/g, 'https://placeholder.local').trim(),
      'https://placeholder.local',
    )
    return parsed.pathname || '/mock-endpoint'
  } catch {
    return '/mock-endpoint'
  }
}

function suggestVarNameFromPath(jsonPath: string): string {
  const lastSeg =
    jsonPath
      .replace(/\[\d+\]/g, '')
      .split('.')
      .filter(Boolean)
      .pop() ?? 'capturedValue'
  return lastSeg.replace(/[^a-zA-Z0-9_]/g, '').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) || 'capturedValue'
}

function isHtmlOrSvgResponse(contentType: string, body: string): boolean {
  const ct = (contentType || '').toLowerCase()
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml') || ct.includes('image/svg+xml')) {
    return true
  }
  const trimmed = (body || '').trimStart()
  return /^(<!doctype\s+html|<html\b|<head\b|<body\b|<svg\b|<!--[\s\S]*?-->\s*<(!doctype|html|svg)\b)/i.test(
    trimmed,
  )
}

function buildSafeHtmlPreviewDoc(
  rawBody: string,
  resolvedUrl: string,
  darkCanvas: boolean,
): { srcDoc: string; pageTitle: string | null } {
  const titleMatch = rawBody.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const pageTitle = titleMatch ? titleMatch[1]!.replace(/\s+/g, ' ').trim().slice(0, 120) : null

  let baseTag = ''
  if (/^https?:\/\//i.test(resolvedUrl) && !/<base\b/i.test(rawBody)) {
    const safeHref = resolvedUrl
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    baseTag = `<base href="${safeHref}">`
  }

  const canvasStyle = darkCanvas
    ? `<style data-meofast-preview>html{color-scheme:dark;background:#0b172a;color:#e2e8f0;}body{margin:12px;}</style>`
    : `<style data-meofast-preview>html{color-scheme:light;background:#ffffff;color:#0f172a;}body{margin:12px;}</style>`

  if (/<head[^>]*>/i.test(rawBody)) {
    return {
      srcDoc: rawBody.replace(/<head([^>]*)>/i, `<head$1>${baseTag}${canvasStyle}`),
      pageTitle,
    }
  }

  return {
    srcDoc: `<!DOCTYPE html><html><head><meta charset="utf-8">${baseTag}${canvasStyle}</head><body>${rawBody}</body></html>`,
    pageTitle,
  }
}

function extractTableData(parsed: unknown): {
  mode: 'rows' | 'kv'
  columns: string[]
  rows: Array<Record<string, string>>
  sourceLabel: string
} | null {
  if (parsed === null || parsed === undefined || typeof parsed !== 'object') return null

  const formatCell = (v: unknown): string => {
    if (v === null) return 'null'
    if (v === undefined) return '—'
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  }

  let candidateArray: unknown[] | null = null
  let sourceLabel = 'Root Array'

  if (Array.isArray(parsed)) {
    candidateArray = parsed
  } else {
    const obj = parsed as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length > 0) {
        candidateArray = v
        sourceLabel = `Array "${k}" (${v.length})`
        break
      }
    }
  }

  if (candidateArray && candidateArray.length > 0) {
    const firstItem = candidateArray[0]
    if (firstItem !== null && typeof firstItem === 'object' && !Array.isArray(firstItem)) {
      const colSet = new Set<string>()
      for (const item of candidateArray.slice(0, 50)) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          for (const k of Object.keys(item as Record<string, unknown>)) {
            if (colSet.size < 12) colSet.add(k)
          }
        }
      }
      const columns = Array.from(colSet)
      const rows = candidateArray.slice(0, 200).map((item) => {
        const rec: Record<string, string> = {}
        const recObj =
          item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
        for (const col of columns) {
          rec[col] = formatCell(recObj[col])
        }
        return rec
      })
      return { mode: 'rows', columns, rows, sourceLabel }
    }
  }

  if (!Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>)
    return {
      mode: 'kv',
      columns: ['Field', 'Value'],
      rows: entries.map(([k, v]) => ({ Field: k, Value: formatCell(v) })),
      sourceLabel: `Object Properties (${entries.length})`,
    }
  }

  return null
}

function JsonTreeNode({
  keyLabel,
  value,
  path,
  depth,
  searchQuery,
  onCaptureVar,
  onCopyPath,
}: {
  keyLabel: string | null
  value: unknown
  path: string
  depth: number
  searchQuery: string
  onCaptureVar: (path: string, stringValue: string) => void
  onCopyPath: (path: string) => void
}) {
  const [collapsed, setCollapsed] = useState(depth >= 2)
  const isObject = value !== null && typeof value === 'object'
  const isArray = Array.isArray(value)

  if (isObject) {
    const entries = isArray
      ? (value as unknown[]).map((item, idx) => ({
          label: `[${idx}]`,
          val: item,
          childPath: `${path}[${idx}]`,
        }))
      : Object.entries(value as Record<string, unknown>).map(([k, val]) => ({
          label: k,
          val,
          childPath: path ? `${path}.${k}` : k,
        }))

    return (
      <div className="flex flex-col">
        <div
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => setCollapsed((prev) => !prev)}
          className="group h-6 pr-2 flex items-center justify-between gap-2 rounded-[var(--radius-sm)] hover:bg-[var(--color-surface-hover)] cursor-pointer select-none"
        >
          <div className="flex items-center gap-1.5 min-w-0 font-mono text-xs">
            <Icon
              name={collapsed ? 'chevron-right' : 'chevron-down'}
              size={11}
              className="text-[var(--color-text-muted)] shrink-0"
            />
            {keyLabel !== null ? (
              <span className="font-semibold text-[var(--color-primary)]">{keyLabel}:</span>
            ) : null}
            <span className="text-[var(--color-text-muted)] text-[11px]">
              {isArray ? `Array(${entries.length})` : `{${entries.length}}`}
            </span>
          </div>
          {path ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onCopyPath(path)
              }}
              className="opacity-0 group-hover:opacity-100 h-5 px-1.5 rounded text-[10px] font-mono text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-subtle)] cursor-pointer transition-opacity"
            >
              Copy path
            </button>
          ) : null}
        </div>

        {!collapsed ? (
          <div className="flex flex-col">
            {entries.slice(0, 250).map((entry) => (
              <JsonTreeNode
                key={entry.childPath}
                keyLabel={entry.label}
                value={entry.val}
                path={entry.childPath}
                depth={depth + 1}
                searchQuery={searchQuery}
                onCaptureVar={onCaptureVar}
                onCopyPath={onCopyPath}
              />
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  const strValue = value === null ? 'null' : String(value)
  if (searchQuery) {
    const q = searchQuery.toLowerCase()
    const matches =
      (keyLabel ?? '').toLowerCase().includes(q) ||
      strValue.toLowerCase().includes(q) ||
      path.toLowerCase().includes(q)
    if (!matches) return null
  }

  return (
    <div
      style={{ paddingLeft: `${depth * 14 + 22}px` }}
      className="group min-h-[26px] py-0.5 pr-2 flex items-center justify-between gap-2 rounded-[var(--radius-sm)] hover:bg-[var(--color-surface-hover)] font-mono text-xs"
    >
      <div className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
        {keyLabel !== null ? (
          <span className="font-medium text-[var(--color-text)]">{keyLabel}:</span>
        ) : null}
        <span
          className={cn(
            'break-all',
            typeof value === 'string' && 'text-[var(--color-success)]',
            typeof value === 'number' && 'text-[var(--color-primary)] tabular-nums',
            typeof value === 'boolean' && 'text-[var(--color-info)]',
            value === null && 'text-[var(--color-text-muted)] italic',
          )}
        >
          {typeof value === 'string' ? `"${value}"` : strValue}
        </span>
      </div>

      {path ? (
        <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex items-center gap-1 shrink-0 transition-opacity">
          <button
            type="button"
            onClick={() => onCopyPath(path)}
            className="h-5 px-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] cursor-pointer"
          >
            Path
          </button>
          {value !== null ? (
            <button
              type="button"
              onClick={() => onCaptureVar(path, String(value))}
              className="h-5 px-1.5 rounded border border-[var(--color-border-strong)] bg-[var(--color-primary-subtle)] text-[10px] font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white cursor-pointer transition-colors"
            >
              Set {'{{var}}'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function ResponsePane({
  workspaceId,
  activeTab,
}: {
  workspaceId: string
  activeTab: RequestTab
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const {
    consoleEntries,
    clearConsole,
    splitDirection,
    toggleSplitDirection,
    updateActiveTab,
  } = useWorkbenchStore()

  const { defaultTargetEnvId, defaultTargetLabel, saveVariable } = useWorkspaceVariables(
    workspaceId,
    activeTab.collectionId,
    activeTab.folderId,
  )

  const [resTab, setResTab] = useState<
    'body' | 'events' | 'headers' | 'cookies' | 'assertions' | 'examples' | 'diff' | 'console'
  >('body')
  const [jsonViewMode, setJsonViewMode] = useState<'pretty' | 'tree' | 'table'>('pretty')
  const [markupViewMode, setMarkupViewMode] = useState<'code' | 'preview'>('code')
  const [previewDarkCanvas, setPreviewDarkCanvas] = useState(false)
  const [copied, setCopied] = useState(false)
  const [capsuleSaved, setCapsuleSaved] = useState(false)
  const [typesModalOpen, setTypesModalOpen] = useState(false)
  const [bodySearch, setBodySearch] = useState('')

  // Timing Waterfall Popover state
  const timingBadgeRef = useRef<HTMLSpanElement | null>(null)
  const [timingAnchorRect, setTimingAnchorRect] = useState<DOMRect | null>(null)

  // Save Value to Variable Modal state
  const [captureVarDraft, setCaptureVarDraft] = useState<{
    path: string
    varName: string
    value: string
    alsoAutoCapture: boolean
  } | null>(null)

  // Save Response Example Modal state
  const [saveExampleOpen, setSaveExampleOpen] = useState(false)
  const [exampleName, setExampleName] = useState('')
  const [renameExampleTarget, setRenameExampleTarget] = useState<{
    id: string
    name: string
  } | null>(null)
  const [renameExampleDraft, setRenameExampleDraft] = useState('')

  const res = activeTab.response
  const pinned = activeTab.pinnedResponse

  const examplesQuery = useQuery({
    queryKey: ['request-examples', activeTab.savedRequestId],
    enabled: Boolean(activeTab.savedRequestId),
    queryFn: () =>
      apiRequest<{ examples: ResponseExampleItem[] }>(
        `/api/v1/requests/${activeTab.savedRequestId}/examples`,
      ),
  })
  const savedExamples = examplesQuery.data?.examples ?? []

  const statusVariant = !res
    ? 'neutral'
    : res.status >= 200 && res.status < 300
      ? 'success'
      : res.status >= 300 && res.status < 500
        ? 'warning'
        : 'danger'

  const parsedJsonData = useMemo(() => {
    if (!res?.isJson || !res.body) return null
    try {
      return JSON.parse(res.body)
    } catch {
      return null
    }
  }, [res])

  const tablePreview = useMemo(() => extractTableData(parsedJsonData), [parsedJsonData])

  const isHtmlResponse = useMemo(
    () => (res && !res.isJson ? isHtmlOrSvgResponse(res.contentType, res.body) : false),
    [res],
  )

  const htmlPreviewDoc = useMemo(
    () =>
      res && !res.isJson
        ? buildSafeHtmlPreviewDoc(res.body || '', res.resolvedUrl || '', previewDarkCanvas)
        : null,
    [res, previewDarkCanvas],
  )

  const filteredBody = useMemo(() => {
    if (!res) return ''
    if (!bodySearch.trim()) return res.body || '(Empty body)'
    const q = bodySearch.toLowerCase()
    const matched = res.body
      .split('\n')
      .filter((line) => line.toLowerCase().includes(q))
      .join('\n')
    return matched || `No lines matching "${bodySearch}"`
  }, [res, bodySearch])

  const diffLines = useMemo(() => {
    if (!pinned || !res) return []
    return computeMyersLineDiff(pinned.body, res.body)
  }, [pinned, res])

  const structuralDiffSummary = useMemo(() => {
    if (!pinned?.isJson || !res?.isJson) return null
    try {
      const changes = computeJsonStructuralDiff(JSON.parse(pinned.body), JSON.parse(res.body))
      return {
        added: changes.filter((c) => c.kind === 'added').length,
        removed: changes.filter((c) => c.kind === 'removed').length,
        modified: changes.filter((c) => c.kind === 'modified').length,
        typeChanged: changes.filter((c) => c.kind === 'type_changed').length,
      }
    } catch {
      return null
    }
  }, [pinned, res])

  const handleCopyBody = async () => {
    if (!res) return
    await navigator.clipboard.writeText(res.body)
    setCopied(true)
    toast.success('Response copied to clipboard')
    setTimeout(() => setCopied(false), 1500)
  }

  const handleDownloadBody = () => {
    if (!res) return
    const ext = res.isJson
      ? 'json'
      : res.contentType.toLowerCase().includes('svg')
        ? 'svg'
        : isHtmlResponse
          ? 'html'
          : 'txt'
    const blob = new Blob([res.body], { type: res.contentType || 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `meofast-response-${Date.now()}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
    toast.info('Response exported', `Saved as .${ext} file.`)
  }

  const handlePinToggle = () => {
    if (!res) return
    if (pinned) {
      updateActiveTab({ pinnedResponse: null }, false)
      if (resTab === 'diff') setResTab('body')
    } else {
      updateActiveTab({ pinnedResponse: res }, false)
      setResTab('diff')
    }
  }

  const saveCapsuleMutation = useMutation({
    mutationFn: async () => {
      if (!res || !workspaceId) return
      const capsulePayload = {
        format: 'meofast.capsule.v1',
        exportedAt: new Date().toISOString(),
        title: `${activeTab.method} ${activeTab.name}`,
        notes: `Status ${res.status} (${res.durationMs} ms)`,
        request: {
          protocol: activeTab.protocol,
          method: activeTab.method,
          url: activeTab.url,
          headers: activeTab.headers,
          queryParams: activeTab.queryParams,
          body: activeTab.body,
          graphql: activeTab.graphql,
        },
        response: {
          status: res.status,
          statusText: res.statusText,
          durationMs: res.durationMs,
          sizeBytes: res.sizeBytes,
          headers: res.headers,
          body: res.body,
          assertions: res.assertions,
        },
      }

      await apiRequest<{ capsule: Record<string, unknown> }>(
        `/api/v1/workspaces/${workspaceId}/capsules`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: `${activeTab.method} ${activeTab.name}`,
            notes: `HTTP ${res.status} · ${res.durationMs} ms`,
            capsule: capsulePayload,
          }),
        },
      )
    },
    onSuccess: async () => {
      setCapsuleSaved(true)
      setTimeout(() => setCapsuleSaved(false), 1800)
      toast.success('Debug Capsule saved', 'Sanitized snapshot stored in History & Capsules.')
      await queryClient.invalidateQueries({ queryKey: ['capsules', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to save capsule', err instanceof Error ? err.message : undefined)
    },
  })

  const saveExampleMutation = useMutation({
    mutationFn: async () => {
      if (!res || !activeTab.savedRequestId) return
      return apiRequest<{ example: ResponseExampleItem }>(
        `/api/v1/requests/${activeTab.savedRequestId}/examples`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: exampleName.trim() || `${res.status} ${res.statusText || 'Response'}`,
            statusCode: res.status,
            statusText: res.statusText || 'OK',
            contentType: res.contentType || 'application/json',
            headers: res.headers,
            body: res.body,
          }),
        },
      )
    },
    onSuccess: async () => {
      setSaveExampleOpen(false)
      setExampleName('')
      setResTab('examples')
      toast.success('Response example saved', 'Synced to endpoint documentation & examples.')
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['request-examples', activeTab.savedRequestId],
        }),
        queryClient.invalidateQueries({ queryKey: ['workspace-tree', workspaceId] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to save example', err instanceof Error ? err.message : undefined)
    },
  })

  const renameExampleMutation = useMutation({
    mutationFn: async () => {
      if (!renameExampleTarget) return
      await apiRequest(`/api/v1/examples/${renameExampleTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: renameExampleDraft.trim() }),
      })
    },
    onSuccess: async () => {
      setRenameExampleTarget(null)
      setRenameExampleDraft('')
      toast.success('Response example renamed')
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['request-examples', activeTab.savedRequestId],
        }),
        queryClient.invalidateQueries({ queryKey: ['workspace-tree', workspaceId] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to rename example', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteExampleMutation = useMutation({
    mutationFn: async (exampleId: string) => {
      await apiRequest(`/api/v1/examples/${exampleId}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      toast.info('Response example deleted')
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['request-examples', activeTab.savedRequestId],
        }),
        queryClient.invalidateQueries({ queryKey: ['workspace-tree', workspaceId] }),
      ])
    },
  })

  const createMockFromExampleMutation = useMutation({
    mutationFn: async (ex: ResponseExampleItem) => {
      const pathPattern = extractPathnameForMock(activeTab.url)
      await apiRequest(`/api/v1/workspaces/${workspaceId}/mocks`, {
        method: 'POST',
        body: JSON.stringify({
          name: `${activeTab.name} (${ex.name})`.slice(0, 160),
          collectionId: activeTab.collectionId,
          method: activeTab.method,
          pathPattern,
          statusCode: ex.statusCode,
          latencyMs: 0,
          errorRate: 0,
          headers: Object.entries(ex.headers)
            .slice(0, 12)
            .map(([key, value]) => ({
              id: crypto.randomUUID(),
              key,
              value,
              description: '',
              enabled: true,
            })),
          responseBody: ex.body || '{}',
          isStateful: false,
          enabled: true,
        }),
      })
      return pathPattern
    },
    onSuccess: async (pathPattern) => {
      toast.success(
        'Mock route created',
        `${activeTab.method} /api/v1/mock/${workspaceId}${pathPattern}`,
      )
      await queryClient.invalidateQueries({ queryKey: ['mocks', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to create mock route', err instanceof Error ? err.message : undefined)
    },
  })

  const handleLoadExampleIntoPreview = (ex: ResponseExampleItem) => {
    const isJson =
      ex.contentType.includes('json') ||
      ex.body.trim().startsWith('{') ||
      ex.body.trim().startsWith('[')
    updateActiveTab(
      {
        response: {
          historyId: `example-${ex.id}`,
          resolvedUrl: activeTab.url,
          status: ex.statusCode,
          statusText: ex.statusText,
          durationMs: 0,
          sizeBytes: new Blob([ex.body]).size,
          headers: ex.headers,
          cookies: [],
          body: ex.body,
          contentType: ex.contentType,
          isJson,
          truncated: false,
          redirects: [],
          assertions: [],
          consoleLogs: [],
        },
        lastError: null,
      },
      false,
    )
    setResTab('body')
    toast.info('Loaded example into preview', ex.name)
  }

  const passedCount = res?.assertions.filter((a) => a.passed).length ?? 0

  const timingPhases = useMemo(() => {
    if (!res) return []
    const t = res.timings ?? {
      dnsMs: 0,
      tcpMs: 0,
      tlsMs: 0,
      ttfbMs: res.durationMs,
      downloadMs: 0,
      totalMs: res.durationMs,
    }
    const total = Math.max(1, t.totalMs || res.durationMs)
    return [
      { label: 'DNS Lookup', ms: t.dnsMs, pct: Math.min(100, (t.dnsMs / total) * 100) },
      { label: 'TCP Connect', ms: t.tcpMs, pct: Math.min(100, (t.tcpMs / total) * 100) },
      { label: 'TLS Handshake', ms: t.tlsMs, pct: Math.min(100, (t.tlsMs / total) * 100) },
      { label: 'TTFB (Waiting)', ms: t.ttfbMs, pct: Math.min(100, (t.ttfbMs / total) * 100) },
      {
        label: 'Content Download',
        ms: t.downloadMs,
        pct: Math.min(100, (t.downloadMs / total) * 100),
      },
    ]
  }, [res])

  return (
    <section
      aria-label="API Response Viewer"
      className="h-full flex-1 min-h-0 flex flex-col bg-[var(--color-surface)] overflow-hidden"
    >
      {/* Telemetry Header — Fixed h-[42px] aligned pixel-for-pixel with Request Tabs Bar */}
      <div className="h-[42px] px-3 border-b border-[var(--color-border)] bg-[var(--color-background)] flex items-center justify-between gap-2 shrink-0">
        <Tabs
          className="min-w-0 flex-1 flex-nowrap"
          items={[
            { id: 'body', label: 'Body' },
            ...(res?.sseEvents && res.sseEvents.length > 0
              ? [{ id: 'events', label: 'Events', count: res.sseEvents.length }]
              : []),
            {
              id: 'headers',
              label: 'Headers',
              count: res ? Object.keys(res.headers).length : 0,
            },
            {
              id: 'cookies',
              label: 'Cookies',
              count: res?.cookies.length ?? 0,
            },
            {
              id: 'assertions',
              label: 'Tests',
              count: res?.assertions.length ?? 0,
            },
            ...(activeTab.savedRequestId
              ? [{ id: 'examples', label: 'Examples', count: savedExamples.length }]
              : []),
            ...(pinned ? [{ id: 'diff', label: 'Diff' }] : []),
            {
              id: 'console',
              label: 'Console',
              count: consoleEntries.length,
            },
          ]}
          activeId={resTab}
          onChange={(id) => setResTab(id as typeof resTab)}
        />

        <div className="flex items-center gap-1.5 shrink-0 flex-nowrap tabular-nums">
          {res ? (
            <>
              <Badge variant={statusVariant}>
                <span className="truncate max-w-[110px]">
                  {res.status} {res.statusText}
                </span>
              </Badge>
              <span
                ref={timingBadgeRef}
                tabIndex={0}
                onMouseEnter={() => {
                  if (timingBadgeRef.current) {
                    setTimingAnchorRect(timingBadgeRef.current.getBoundingClientRect())
                  }
                }}
                onMouseLeave={() => setTimingAnchorRect(null)}
                onFocus={() => {
                  if (timingBadgeRef.current) {
                    setTimingAnchorRect(timingBadgeRef.current.getBoundingClientRect())
                  }
                }}
                onBlur={() => setTimingAnchorRect(null)}
                className="inline-flex cursor-default outline-none"
              >
                <Badge variant="neutral">{formatDuration(res.durationMs)}</Badge>
              </span>
              <Badge variant="neutral">{formatBytes(res.sizeBytes)}</Badge>
            </>
          ) : null}

          {res ? (
            <DropdownMenu
              ariaLabel="Response actions"
              widthClassName="w-56"
              triggerClassName="w-[30px] h-[30px] justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
              trigger={() => <Icon name="dots-vertical" size={14} />}
              items={[
                {
                  id: 'copy',
                  label: copied ? 'Copied Response' : 'Copy Response Body',
                  icon: 'copy',
                  onSelect: () => {
                    void handleCopyBody()
                  },
                },
                {
                  id: 'export',
                  label: 'Export Response File',
                  icon: 'download',
                  onSelect: handleDownloadBody,
                },
                ...(activeTab.savedRequestId
                  ? [
                      {
                        id: 'save-example',
                        label: 'Save as Response Example',
                        icon: 'book' as const,
                        onSelect: () => {
                          setExampleName(`${res.status} ${res.statusText || 'OK'}`)
                          setSaveExampleOpen(true)
                        },
                      },
                    ]
                  : []),
                ...(res.isJson
                  ? [
                      {
                        id: 'types',
                        label: 'Generate Types & Schema',
                        icon: 'code' as const,
                        onSelect: () => setTypesModalOpen(true),
                      },
                    ]
                  : []),
                {
                  id: 'compare',
                  label: pinned ? 'Clear Diff Baseline' : 'Pin for Response Diff',
                  icon: 'diff',
                  onSelect: handlePinToggle,
                },
                {
                  id: 'capsule',
                  label: capsuleSaved ? 'Capsule Saved' : 'Save Debug Capsule',
                  icon: 'bug',
                  onSelect: () => saveCapsuleMutation.mutate(),
                },
                {
                  id: 'split',
                  label:
                    splitDirection === 'vertical'
                      ? 'Switch to Side-by-Side Split'
                      : 'Switch to Stacked Split',
                  icon: splitDirection === 'vertical' ? 'columns' : 'rows',
                  dividerBefore: true,
                  onSelect: toggleSplitDirection,
                },
              ]}
            />
          ) : (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={
                <Icon name={splitDirection === 'vertical' ? 'columns' : 'rows'} size={13} />
              }
              onClick={toggleSplitDirection}
              title={
                splitDirection === 'vertical'
                  ? 'Switch to Side-by-Side Split'
                  : 'Switch to Stacked Split'
              }
            >
              {splitDirection === 'vertical' ? 'Side Split' : 'Stacked'}
            </Button>
          )}
        </div>
      </div>

      {/* Portaled Timing Waterfall Popover */}
      {res && timingAnchorRect && typeof document !== 'undefined'
        ? createPortal(
            <div
              style={{
                position: 'fixed',
                top: `${Math.min(window.innerHeight - 230, timingAnchorRect.bottom + 6)}px`,
                left: `${Math.max(12, Math.min(window.innerWidth - 280, timingAnchorRect.right - 264))}px`,
              }}
              className="z-[140] w-[264px] rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-lg)] pointer-events-none flex flex-col gap-2 text-xs tabular-nums"
            >
              <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-1.5">
                <span className="font-semibold text-[var(--color-text)]">Timing Waterfall</span>
                <span className="font-mono font-semibold text-[var(--color-primary)]">
                  {formatDuration(res.durationMs)}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {timingPhases.map((phase) => (
                  <div key={phase.label} className="flex flex-col gap-0.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-[var(--color-text-secondary)]">{phase.label}</span>
                      <span className="font-mono text-[var(--color-text)]">{phase.ms} ms</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-[var(--color-surface-secondary)] overflow-hidden">
                      <div
                        style={{ width: `${phase.ms > 0 ? Math.max(6, phase.pct) : 0}%` }}
                        className="h-full rounded-full bg-[var(--color-primary)]"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}

      {/* Content Area — Single Clean Scroll Container */}
      <div
        className={cn(
          'flex-1 min-h-0 p-3',
          res &&
            !activeTab.isSending &&
            !activeTab.lastError &&
            (resTab === 'body' || resTab === 'diff')
            ? 'flex flex-col overflow-hidden'
            : 'overflow-y-auto',
        )}
      >
        {activeTab.isSending ? (
          <div className="h-full min-h-[140px] flex flex-col items-center justify-center gap-3 text-sm text-[var(--color-text-secondary)]">
            <Spinner size="md" />
            <span>Sending request...</span>
          </div>
        ) : activeTab.lastError && resTab !== 'console' && resTab !== 'examples' ? (
          <div
            role="alert"
            className="p-4 rounded-[var(--radius-lg)] bg-[var(--color-danger-subtle)] border border-[var(--color-danger-border)] text-sm text-[var(--color-danger)] flex items-start gap-3"
          >
            <Icon name="alert" size={18} className="shrink-0 mt-0.5" />
            <div className="flex flex-col gap-1">
              <span className="font-semibold">Request Failed</span>
              <span className="text-xs leading-relaxed">{activeTab.lastError}</span>
            </div>
          </div>
        ) : resTab === 'examples' ? (
          <div className="w-full flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs text-[var(--color-text-secondary)]">
                Saved response snapshots for documentation, offline preview, and 1-click Mock
                Server routes.
              </span>
              {res && activeTab.savedRequestId ? (
                <Button
                  size="sm"
                  variant="primary"
                  leftIcon={<Icon name="plus" size={13} />}
                  onClick={() => {
                    setExampleName(`${res.status} ${res.statusText || 'OK'}`)
                    setSaveExampleOpen(true)
                  }}
                >
                  Save Current Response
                </Button>
              ) : null}
            </div>

            {savedExamples.length === 0 ? (
              <div className="py-8 text-center text-xs text-[var(--color-text-muted)] border border-dashed border-[var(--color-border)] rounded-[var(--radius-lg)]">
                No saved examples yet. Send this request and select &ldquo;Save as Response
                Example&rdquo; to store <code className="font-mono">200 OK</code>,{' '}
                <code className="font-mono">400</code>, or <code className="font-mono">401</code>{' '}
                payloads.
              </div>
            ) : (
              <DataTable<ResponseExampleItem>
                server={{
                  queryKey: ['request-examples', activeTab.savedRequestId],
                  endpoint: `/api/v1/requests/${activeTab.savedRequestId}/examples`,
                  enabled: Boolean(activeTab.savedRequestId),
                }}
                defaultPageSize={10}
                getRowKey={(ex) => ex.id}
                searchPlaceholder="Search saved examples..."
                emptyMessage="No saved response examples yet."
                columns={[
                  {
                    id: 'name',
                    header: 'Example Name',
                    sortValue: (ex) => ex.name,
                    cellClassName: 'font-semibold text-[var(--color-text)]',
                    cell: (ex) => ex.name,
                  },
                  {
                    id: 'status',
                    header: 'Status',
                    sortValue: (ex) => ex.statusCode,
                    searchValue: (ex) => `${ex.statusCode} ${ex.statusText}`,
                    cellClassName: 'tabular-nums',
                    cell: (ex) => (
                      <Badge
                        variant={
                          ex.statusCode >= 200 && ex.statusCode < 300
                            ? 'success'
                            : ex.statusCode >= 400
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {ex.statusCode} {ex.statusText}
                      </Badge>
                    ),
                  },
                  {
                    id: 'contentType',
                    header: 'Content-Type',
                    sortValue: (ex) => ex.contentType,
                    cellClassName: 'font-mono text-[var(--color-text-secondary)]',
                    cell: (ex) => ex.contentType,
                  },
                  {
                    id: 'createdAt',
                    header: 'Saved',
                    sortValue: (ex) => ex.createdAt,
                    cellClassName: 'text-[var(--color-text-muted)] tabular-nums',
                    cell: (ex) => formatShortTime(ex.createdAt),
                  },
                  {
                    id: 'actions',
                    header: 'Actions',
                    sortable: false,
                    align: 'right',
                    cell: (ex) => (
                      <DropdownMenu
                        ariaLabel={`Actions for ${ex.name}`}
                        widthClassName="w-56"
                        triggerClassName="w-[30px] h-[30px] justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] text-[var(--color-text-secondary)]"
                        trigger={() => <Icon name="dots-vertical" size={14} />}
                        items={[
                          {
                            id: 'rename',
                            label: 'Rename Example',
                            icon: 'edit',
                            onSelect: () => {
                              setRenameExampleTarget({ id: ex.id, name: ex.name })
                              setRenameExampleDraft(ex.name)
                            },
                          },
                          {
                            id: 'preview',
                            label: 'Load into Response Preview',
                            icon: 'eye',
                            onSelect: () => handleLoadExampleIntoPreview(ex),
                          },
                          {
                            id: 'mock',
                            label: 'Create Mock Route',
                            icon: 'server',
                            onSelect: () => createMockFromExampleMutation.mutate(ex),
                          },
                          {
                            id: 'delete',
                            label: 'Delete Example',
                            icon: 'trash',
                            variant: 'danger',
                            dividerBefore: true,
                            onSelect: () => {
                              void (async () => {
                                const ok = await confirm({
                                  title: 'Delete response example?',
                                  description: `Remove saved example "${ex.name}" from this endpoint?`,
                                  confirmLabel: 'Delete Example',
                                })
                                if (ok) deleteExampleMutation.mutate(ex.id)
                              })()
                            },
                          },
                        ]}
                      />
                    ),
                  },
                ]}
              />
            )}
          </div>
        ) : resTab === 'console' ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--color-text-secondary)]">
                Request Log
              </span>
              {consoleEntries.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Clear console logs?',
                      description: 'All recorded script and network log lines will be cleared.',
                      confirmLabel: 'Clear Console',
                      variant: 'warning',
                    })
                    if (ok) {
                      clearConsole()
                      toast.info('Console cleared')
                    }
                  }}
                >
                  Clear
                </Button>
              ) : null}
            </div>
            {consoleEntries.length === 0 ? (
              <div className="py-10 text-center text-xs text-[var(--color-text-muted)]">
                No log entries yet.
              </div>
            ) : (
              <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] divide-y divide-[var(--color-border)] font-mono text-xs">
                {consoleEntries.map((entry) => (
                  <div key={entry.id} className="px-3 py-2 flex items-start gap-3">
                    <span className="text-[var(--color-text-muted)] shrink-0 tabular-nums">
                      {entry.timestamp.slice(11, 23)}
                    </span>
                    <span
                      className={cn(
                        'uppercase font-semibold shrink-0',
                        entry.level === 'error' && 'text-[var(--color-danger)]',
                        entry.level === 'warn' && 'text-[var(--color-warning)]',
                        entry.level === 'info' && 'text-[var(--color-primary)]',
                      )}
                    >
                      {entry.level}
                    </span>
                    <span className="break-all text-[var(--color-text)]">{entry.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : !res ? (
          <div className="h-full min-h-[140px] flex flex-col items-center justify-center gap-2 text-center">
            <div className="w-10 h-10 rounded-full bg-[var(--color-surface-secondary)] text-[var(--color-primary)] inline-flex items-center justify-center">
              <Icon name="send" size={18} />
            </div>
            <p className="text-sm font-medium text-[var(--color-text)]">Ready to Send</p>
            <p className="text-xs text-[var(--color-text-secondary)] max-w-sm">
              Enter a URL or select a request from the sidebar, then press{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-[11px]">
                Ctrl+Enter
              </kbd>
              .
            </p>
          </div>
        ) : resTab === 'events' && res.sseEvents ? (
          <div className="border border-[var(--color-border)] rounded-[var(--radius-lg)] divide-y divide-[var(--color-border)] font-mono text-xs">
            {res.sseEvents.map((ev) => (
              <div key={ev.id} className="p-3 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="primary">{ev.event}</Badge>
                    <span className="text-[var(--color-text-muted)]">id: {ev.id}</span>
                  </div>
                  <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums">
                    {ev.receivedAt.slice(11, 23)}
                  </span>
                </div>
                <pre className="whitespace-pre-wrap break-all text-[var(--color-text)]">
                  {ev.data}
                </pre>
              </div>
            ))}
          </div>
        ) : resTab === 'diff' && pinned ? (
          <div className="flex flex-col gap-2.5 flex-1 min-h-0">
            <div className="flex items-center justify-between gap-2 flex-wrap text-xs text-[var(--color-text-secondary)] shrink-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span>
                  Comparing pinned baseline ({pinned.status}, {formatDuration(pinned.durationMs)}) vs
                  latest ({res.status}, {formatDuration(res.durationMs)})
                </span>
                {structuralDiffSummary ? (
                  <>
                    {structuralDiffSummary.added > 0 ? (
                      <Badge variant="success">+{structuralDiffSummary.added} added</Badge>
                    ) : null}
                    {structuralDiffSummary.removed > 0 ? (
                      <Badge variant="danger">-{structuralDiffSummary.removed} removed</Badge>
                    ) : null}
                    {structuralDiffSummary.typeChanged > 0 ? (
                      <Badge variant="warning">
                        {structuralDiffSummary.typeChanged} type change
                      </Badge>
                    ) : null}
                    {structuralDiffSummary.modified > 0 ? (
                      <Badge variant="info">{structuralDiffSummary.modified} modified</Badge>
                    ) : null}
                  </>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => updateActiveTab({ pinnedResponse: null }, false)}
              >
                Clear Baseline
              </Button>
            </div>
            <div className="flex-1 min-h-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] font-mono text-xs overflow-auto">
              {diffLines.map((d, idx) => (
                <div
                  key={idx}
                  className={cn(
                    'px-3 py-0.5 whitespace-pre',
                    d.type === 'added' &&
                      'bg-[var(--color-success-subtle)] text-[var(--color-success)]',
                    d.type === 'removed' &&
                      'bg-[var(--color-danger-subtle)] text-[var(--color-danger)]',
                  )}
                >
                  {d.type === 'added' ? '+ ' : d.type === 'removed' ? '- ' : '  '}
                  {d.text}
                </div>
              ))}
            </div>
          </div>
        ) : resTab === 'body' ? (
          <div className="flex flex-col gap-2 flex-1 min-h-0">
            <div className="flex items-center justify-between gap-2.5 flex-wrap shrink-0">
              <div className="flex items-center gap-2 min-w-[120px] flex-1 overflow-hidden">
                <span className="text-[11px] text-[var(--color-text-muted)] font-mono truncate">
                  {res.resolvedUrl}
                </span>
                {isHtmlResponse ? <Badge variant="info">HTML</Badge> : null}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {res.isJson && parsedJsonData !== null ? (
                  <div className="inline-flex items-center h-[30px] p-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
                    {(
                      [
                        { id: 'pretty', label: 'Pretty' },
                        { id: 'tree', label: 'Tree' },
                        { id: 'table', label: 'Table' },
                      ] as const
                    ).map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => setJsonViewMode(mode.id)}
                        className={cn(
                          'h-6 px-2.5 rounded-[var(--radius-sm)] text-xs font-medium cursor-pointer transition-colors',
                          jsonViewMode === mode.id
                            ? 'bg-[var(--color-surface)] text-[var(--color-primary)] shadow-[var(--shadow-xs)]'
                            : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]',
                        )}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="inline-flex items-center h-[30px] p-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
                    {(
                      [
                        { id: 'code', label: 'Code', icon: 'code' as const },
                        { id: 'preview', label: 'Preview', icon: 'eye' as const },
                      ] as const
                    ).map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => setMarkupViewMode(mode.id)}
                        className={cn(
                          'h-6 px-2.5 rounded-[var(--radius-sm)] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer transition-colors',
                          markupViewMode === mode.id
                            ? 'bg-[var(--color-surface)] text-[var(--color-primary)] shadow-[var(--shadow-xs)]'
                            : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]',
                        )}
                      >
                        <Icon name={mode.icon} size={12} />
                        <span>{mode.label}</span>
                      </button>
                    ))}
                  </div>
                )}

                {!(res.isJson && parsedJsonData !== null && jsonViewMode === 'table') &&
                !(!(res.isJson && parsedJsonData !== null) && markupViewMode === 'preview') ? (
                  <div className="w-48">
                    <Input
                      size="sm"
                      type="search"
                      leftIcon={<Icon name="search" size={12} />}
                      value={bodySearch}
                      onChange={(e) => setBodySearch(e.target.value)}
                      placeholder="Filter response..."
                      aria-label="Filter response body"
                    />
                  </div>
                ) : null}

                {!(res.isJson && parsedJsonData !== null) && markupViewMode === 'preview' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    leftIcon={<Icon name={previewDarkCanvas ? 'sun' : 'moon'} size={12} />}
                    onClick={() => setPreviewDarkCanvas((prev) => !prev)}
                    title={
                      previewDarkCanvas
                        ? 'Switch preview canvas to Light background'
                        : 'Switch preview canvas to Dark background'
                    }
                  >
                    {previewDarkCanvas ? 'Light Canvas' : 'Dark Canvas'}
                  </Button>
                ) : null}
              </div>
            </div>

            {res.isJson && parsedJsonData !== null && jsonViewMode === 'tree' ? (
              <div className="flex-1 min-h-0 overflow-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] p-2">
                <JsonTreeNode
                  keyLabel={null}
                  value={parsedJsonData}
                  path=""
                  depth={0}
                  searchQuery={bodySearch.trim()}
                  onCopyPath={(p) => {
                    void navigator.clipboard.writeText(p)
                    toast.info('JSON path copied', p)
                  }}
                  onCaptureVar={(p, strVal) => {
                    setCaptureVarDraft({
                      path: p,
                      varName: suggestVarNameFromPath(p),
                      value: strVal,
                      alsoAutoCapture: true,
                    })
                  }}
                />
              </div>
            ) : res.isJson && parsedJsonData !== null && jsonViewMode === 'table' ? (
              !tablePreview || tablePreview.rows.length === 0 ? (
                <div className="flex-1 min-h-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center text-xs text-[var(--color-text-muted)]">
                  No tabular rows available in this JSON payload.
                </div>
              ) : (
                <DataTable<Record<string, string>>
                  compact
                  defaultPageSize={10}
                  data={tablePreview.rows}
                  getRowKey={(_row, idx) => `json-row-${idx}`}
                  searchQuery={bodySearch}
                  onSearchQueryChange={setBodySearch}
                  searchPlaceholder="Search JSON table rows..."
                  columns={tablePreview.columns.map((col) => ({
                    id: col,
                    header: col,
                    headerClassName: 'font-mono',
                    sortValue: (row: Record<string, string>) => {
                      const raw = row[col] ?? ''
                      const num = Number(raw)
                      return raw !== '' && !Number.isNaN(num) ? num : raw
                    },
                    cellClassName:
                      'font-mono text-[var(--color-text)] max-w-[320px] truncate tabular-nums',
                    cell: (row: Record<string, string>) => <span title={row[col]}>{row[col]}</span>,
                  }))}
                />
              )
            ) : !(res.isJson && parsedJsonData !== null) && markupViewMode === 'preview' ? (
              <div className="flex-1 min-h-0 flex flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] overflow-hidden bg-[var(--color-surface)]">
                <div className="h-7 px-3 border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)] flex items-center justify-between gap-2 text-[11px] text-[var(--color-text-secondary)] shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon name="globe" size={12} className="text-[var(--color-primary)] shrink-0" />
                    <span className="font-medium text-[var(--color-text)] truncate">
                      {htmlPreviewDoc?.pageTitle || 'Rendered HTML Preview'}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-[var(--color-text-muted)] shrink-0">
                    Sandboxed Preview (Scripts Disabled)
                  </span>
                </div>
                <iframe
                  title="HTML Response Preview"
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={htmlPreviewDoc?.srcDoc ?? ''}
                  className={cn(
                    'w-full flex-1 min-h-[160px] border-0',
                    previewDarkCanvas ? 'bg-[#0b172a]' : 'bg-white',
                  )}
                />
              </div>
            ) : (
              <CodeEditor
                readOnly
                language={
                  res.isJson
                    ? 'json'
                    : res.contentType.includes('xml') || isHtmlResponse
                      ? 'xml'
                      : 'text'
                }
                value={filteredBody}
                minHeight="120px"
                className="flex-1 min-h-0"
              />
            )}
          </div>
        ) : resTab === 'headers' ? (
          <DataTable
            compact
            defaultPageSize={10}
            data={Object.entries(res.headers).map(([key, value]) => ({ key, value }))}
            getRowKey={(row) => row.key}
            searchPlaceholder="Search response headers..."
            emptyMessage="No response headers returned."
            columns={[
              {
                id: 'key',
                header: 'Header',
                sortValue: (row) => row.key,
                headerClassName: 'w-1/3',
                cellClassName: 'font-mono font-medium text-[var(--color-text)]',
                cell: (row) => row.key,
              },
              {
                id: 'value',
                header: 'Value',
                sortValue: (row) => row.value,
                cellClassName: 'font-mono text-[var(--color-text-secondary)] break-all',
                cell: (row) => row.value,
              },
            ]}
          />
        ) : resTab === 'cookies' ? (
          res.cookies.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--color-text-muted)]">
              No cookies returned.
            </div>
          ) : (
            <div className="border border-[var(--color-border)] rounded-[var(--radius-lg)] divide-y divide-[var(--color-border)] font-mono text-xs">
              {res.cookies.map((cookie, idx) => (
                <div key={`${cookie.name}-${idx}`} className="p-3 flex flex-col gap-1">
                  <span className="font-semibold text-[var(--color-text)]">
                    {cookie.name} = {cookie.value}
                  </span>
                  <span className="text-[11px] text-[var(--color-text-muted)]">{cookie.raw}</span>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Badge variant={passedCount === res.assertions.length ? 'success' : 'danger'}>
                {passedCount} / {res.assertions.length} Passed
              </Badge>
            </div>
            {res.assertions.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">No tests configured.</p>
            ) : (
              <div className="border border-[var(--color-border)] rounded-[var(--radius-lg)] divide-y divide-[var(--color-border)]">
                {res.assertions.map((a) => (
                  <div
                    key={a.id}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-4 text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Badge variant={a.passed ? 'success' : 'danger'}>
                        {a.passed ? 'PASS' : 'FAIL'}
                      </Badge>
                      <span className="font-medium text-[var(--color-text)] truncate">
                        {a.label}
                      </span>
                    </div>
                    <span className="font-mono text-[var(--color-text-secondary)] tabular-nums shrink-0">
                      {a.actual}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 1-Click Set Environment Variable Modal from Tree Viewer */}
      <Dialog
        open={Boolean(captureVarDraft)}
        onClose={() => setCaptureVarDraft(null)}
        title={`Set Environment Variable (${defaultTargetLabel})`}
        description="Save this response value immediately and optionally auto-update it on every future run."
      >
        {captureVarDraft ? (
          <div className="flex flex-col gap-3.5">
            <Input
              label="Variable Name"
              mono
              value={captureVarDraft.varName}
              onChange={(e) =>
                setCaptureVarDraft({ ...captureVarDraft, varName: e.target.value })
              }
              placeholder="accessToken"
            />
            <Input
              label="Value"
              mono
              value={captureVarDraft.value}
              onChange={(e) =>
                setCaptureVarDraft({ ...captureVarDraft, value: e.target.value })
              }
            />
            <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={captureVarDraft.alsoAutoCapture}
                onChange={(e) =>
                  setCaptureVarDraft({
                    ...captureVarDraft,
                    alsoAutoCapture: e.target.checked,
                  })
                }
                className="w-3.5 h-3.5 accent-[var(--color-primary)] rounded cursor-pointer"
              />
              <span>
                Also add <code className="font-mono">{captureVarDraft.path}</code> to this
                request&apos;s <strong>Vars</strong> tab for automatic capture on every run
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setCaptureVarDraft(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!captureVarDraft.varName.trim()}
                onClick={async () => {
                  const key = captureVarDraft.varName.trim()
                  await saveVariable({
                    key,
                    value: captureVarDraft.value,
                    environmentId: defaultTargetEnvId,
                  })
                  if (captureVarDraft.alsoAutoCapture) {
                    const existing = activeTab.postResponseVars ?? []
                    if (!existing.some((r) => r.varName === key && r.path === captureVarDraft.path)) {
                      updateActiveTab({
                        postResponseVars: [
                          ...existing,
                          {
                            id: crypto.randomUUID(),
                            varName: key,
                            source: 'body',
                            path: captureVarDraft.path,
                            enabled: true,
                          },
                        ],
                      })
                    }
                  }
                  setCaptureVarDraft(null)
                }}
              >
                Save Variable
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      {/* Save Response Example Modal */}
      <Dialog
        open={saveExampleOpen}
        onClose={() => setSaveExampleOpen(false)}
        title="Save Response Example"
        description="Store this status code, headers, and payload as a documented response example on this endpoint."
      >
        <div className="flex flex-col gap-3.5">
          <Input
            label="Example Title"
            value={exampleName}
            onChange={(e) => setExampleName(e.target.value)}
            placeholder="e.g. 200 OK — Authenticated User Profile"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setSaveExampleOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!exampleName.trim()}
              isLoading={saveExampleMutation.isPending}
              onClick={() => saveExampleMutation.mutate()}
            >
              Save Example
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Rename Response Example Modal */}
      <Dialog
        open={Boolean(renameExampleTarget)}
        onClose={() => setRenameExampleTarget(null)}
        title="Rename Response Example"
      >
        <div className="flex flex-col gap-3.5">
          <Input
            label="Example Title"
            value={renameExampleDraft}
            onChange={(e) => setRenameExampleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                renameExampleDraft.trim() &&
                !renameExampleMutation.isPending
              ) {
                e.preventDefault()
                renameExampleMutation.mutate()
              }
            }}
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setRenameExampleTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!renameExampleDraft.trim()}
              isLoading={renameExampleMutation.isPending}
              onClick={() => renameExampleMutation.mutate()}
            >
              Save Name
            </Button>
          </div>
        </div>
      </Dialog>

      {res?.isJson ? (
        <TypeGeneratorModal
          open={typesModalOpen}
          onClose={() => setTypesModalOpen(false)}
          jsonBody={res.body}
          requestName={activeTab.name}
          onApplyJsonSchema={(schema) => updateActiveTab({ jsonSchema: schema })}
        />
      ) : null}
    </section>
  )
}
