'use client'

import { HTTP_METHODS, type HttpMethod, type KeyValueItem } from '@meofast/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CodeEditor,
  Dialog,
  DropdownMenu,
  Icon,
  Input,
  MethodBadge,
  renderMethodOption,
  renderMethodTrigger,
  Select,
  Switch,
  Tabs,
  useConfirm,
  useToast,
} from '@/components/ui'
import { KeyValueEditor } from '@/features/client/components/KeyValueEditor'
import { useWorkbenchStore } from '@/features/client/store/useWorkbenchStore'
import { apiRequest } from '@/lib/api-client'
import { cn } from '@/utils/cn'

interface MockRouteItem {
  id: string
  workspaceId: string
  collectionId: string | null
  name: string
  method: HttpMethod
  pathPattern: string
  statusCode: number
  latencyMs: number
  errorRate: number
  rateLimitRpm?: number
  headers: KeyValueItem[]
  responseBody: string
  isStateful: boolean
  stateItems?: Array<Record<string, unknown>>
  hitCount: number
  enabled: boolean
}

const DYNAMIC_MOCK_TOKENS = [
  { token: '{{$uuid}}', label: '$uuid', title: 'Insert random UUIDv4' },
  { token: '{{$isoTimestamp}}', label: '$isoTimestamp', title: 'Insert ISO-8601 timestamp' },
  { token: '{{$timestamp}}', label: '$timestamp', title: 'Insert Unix timestamp (seconds)' },
  { token: '{{$randomInt}}', label: '$randomInt', title: 'Insert random integer (1–10000)' },
  { token: '{{params.id}}', label: 'params.id', title: 'Insert path parameter :id' },
  { token: '{{query.page}}', label: 'query.page', title: 'Insert query parameter ?page=' },
] as const

export function MocksPanel({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const { addBlankTab } = useWorkbenchStore()

  const [selectedId, setSelectedId] = useState('')
  const [searchFilter, setSearchFilter] = useState('')
  const [editorTab, setEditorTab] = useState<'body' | 'headers' | 'state'>('body')
  const [name, setName] = useState('')
  const [method, setMethod] = useState<HttpMethod>('GET')
  const [pathPattern, setPathPattern] = useState('/orders')
  const [statusCode, setStatusCode] = useState('200')
  const [latencyMs, setLatencyMs] = useState('0')
  const [errorRate, setErrorRate] = useState('0')
  const [rateLimitRpm, setRateLimitRpm] = useState('0')
  const [headers, setHeaders] = useState<KeyValueItem[]>([])
  const [responseBody, setResponseBody] = useState(
    '{\n  "id": "{{$uuid}}",\n  "status": "confirmed",\n  "createdAt": "{{$isoTimestamp}}"\n}',
  )
  const [isStateful, setIsStateful] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [isDirty, setIsDirty] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [originUrl, setOriginUrl] = useState('')
  const [genOpen, setGenOpen] = useState(false)
  const [genCollectionId, setGenCollectionId] = useState('')
  const [renameMockTarget, setRenameMockTarget] = useState<{ id: string; name: string } | null>(
    null,
  )
  const [renameMockDraft, setRenameMockDraft] = useState('')

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setOriginUrl(window.location.origin)
    }
  }, [])

  const mocksQuery = useQuery({
    queryKey: ['mocks', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      apiRequest<{ baseMockPath: string; routes: MockRouteItem[] }>(
        `/api/v1/workspaces/${workspaceId}/mocks`,
      ),
  })

  const treeQuery = useQuery({
    queryKey: ['workspace-tree', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      apiRequest<{ collections: Array<{ id: string; name: string }> }>(
        `/api/v1/workspaces/${workspaceId}/tree`,
      ),
  })

  const mocks = mocksQuery.data?.routes ?? []
  const baseMockPath = mocksQuery.data?.baseMockPath ?? `/api/v1/mock/${workspaceId}`

  const filteredMocks = useMemo(() => {
    const q = searchFilter.trim().toLowerCase()
    if (!q) return mocks
    return mocks.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.method.toLowerCase().includes(q) ||
        m.pathPattern.toLowerCase().includes(q),
    )
  }, [mocks, searchFilter])

  const selectedMock = useMemo(
    () => mocks.find((m) => m.id === selectedId) ?? null,
    [mocks, selectedId],
  )

  const jsonValidation = useMemo(() => {
    const trimmed = responseBody.trim()
    if (!trimmed) return { valid: true, label: 'Empty' }
    try {
      JSON.parse(trimmed)
      return { valid: true, label: 'Valid JSON' }
    } catch {
      return { valid: false, label: 'Plain Text / Non-JSON' }
    }
  }, [responseBody])

  const loadIntoForm = (m: MockRouteItem) => {
    setSelectedId(m.id)
    setName(m.name)
    setMethod(m.method)
    setPathPattern(m.pathPattern)
    setStatusCode(String(m.statusCode))
    setLatencyMs(String(m.latencyMs))
    setErrorRate(String(m.errorRate))
    setRateLimitRpm(String(m.rateLimitRpm ?? 0))
    setHeaders(m.headers ?? [])
    setResponseBody(m.responseBody)
    setIsStateful(m.isStateful)
    setEnabled(m.enabled)
    setIsDirty(false)
    if (!m.isStateful && editorTab === 'state') {
      setEditorTab('body')
    }
  }

  const handleSelectMock = async (m: MockRouteItem) => {
    if (m.id === selectedId) return
    if (isDirty) {
      const ok = await confirm({
        title: 'Discard unsaved mock edits?',
        description: `Mock "${name}" has unsaved changes. Switching now will discard your edits.`,
        confirmLabel: 'Discard Changes',
        variant: 'warning',
      })
      if (!ok) return
    }
    loadIntoForm(m)
  }

  useEffect(() => {
    if (mocks.length > 0 && !selectedId) {
      loadIntoForm(mocks[0]!)
    }
  }, [mocks, selectedId])

  const resetForCreate = async () => {
    if (isDirty) {
      const ok = await confirm({
        title: 'Discard unsaved mock edits?',
        description: `Mock "${name}" has unsaved changes. Starting a new mock will discard your edits.`,
        confirmLabel: 'Discard Changes',
        variant: 'warning',
      })
      if (!ok) return
    }
    setSelectedId('__new__')
    setName('Mock Orders Endpoint')
    setMethod('GET')
    setPathPattern('/orders')
    setStatusCode('200')
    setLatencyMs('0')
    setErrorRate('0')
    setRateLimitRpm('0')
    setHeaders([])
    setResponseBody(
      '{\n  "id": "{{$uuid}}",\n  "status": "confirmed",\n  "createdAt": "{{$isoTimestamp}}"\n}',
    )
    setIsStateful(false)
    setEnabled(true)
    setEditorTab('body')
    setIsDirty(false)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        method,
        pathPattern: pathPattern.trim(),
        statusCode: Number(statusCode) || 200,
        latencyMs: Number(latencyMs) || 0,
        errorRate: Number(errorRate) || 0,
        rateLimitRpm: Math.max(0, Number(rateLimitRpm) || 0),
        headers,
        responseBody,
        isStateful,
        enabled,
      }
      if (!selectedId || selectedId === '__new__') {
        const res = await apiRequest<{ id: string }>(`/api/v1/workspaces/${workspaceId}/mocks`, {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        return res.id
      }
      await apiRequest(`/api/v1/mocks/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      return selectedId
    },
    onSuccess: async (savedId) => {
      setSelectedId(savedId)
      setIsDirty(false)
      toast.success('Mock saved', `${method} ${pathPattern}`)
      await queryClient.invalidateQueries({ queryKey: ['mocks', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to save mock', err instanceof Error ? err.message : undefined)
    },
  })

  const renameMockMutation = useMutation({
    mutationFn: async () => {
      if (!renameMockTarget || !renameMockDraft.trim()) return null
      const nextName = renameMockDraft.trim()
      await apiRequest(`/api/v1/mocks/${renameMockTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: nextName }),
      })
      return { id: renameMockTarget.id, name: nextName }
    },
    onSuccess: async (updated) => {
      if (updated && updated.id === selectedId) {
        setName(updated.name)
      }
      setRenameMockTarget(null)
      setRenameMockDraft('')
      toast.success('Mock renamed')
      await queryClient.invalidateQueries({ queryKey: ['mocks', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to rename mock', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest(`/api/v1/mocks/${id}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      setSelectedId('')
      setIsDirty(false)
      toast.danger('Mock deleted')
      await queryClient.invalidateQueries({ queryKey: ['mocks', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to delete mock', err instanceof Error ? err.message : undefined)
    },
  })

  const generateMutation = useMutation({
    mutationFn: async () => {
      await apiRequest(`/api/v1/collections/${genCollectionId}/generate-mocks`, {
        method: 'POST',
        body: '{}',
      })
    },
    onSuccess: async () => {
      setGenOpen(false)
      toast.success('Mocks generated from collection')
      await queryClient.invalidateQueries({ queryKey: ['mocks', workspaceId] })
    },
    onError: (err) => {
      toast.error('Generation failed', err instanceof Error ? err.message : undefined)
    },
  })

  const resetStateMutation = useMutation({
    mutationFn: async (mode: 'seed' | 'empty') => {
      if (!selectedId || selectedId === '__new__') return
      await apiRequest(`/api/v1/mocks/${selectedId}/reset-state`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      })
    },
    onSuccess: async (_data, mode) => {
      toast.success(mode === 'empty' ? 'Stateful store cleared' : 'Stateful store reset to seed')
      await queryClient.invalidateQueries({ queryKey: ['mocks', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to reset store', err instanceof Error ? err.message : undefined)
    },
  })

  const normalizedPath = pathPattern.startsWith('/') ? pathPattern : `/${pathPattern}`
  const fullMockEndpoint = `${baseMockPath}${normalizedPath}`
  const absoluteMockEndpoint = originUrl ? `${originUrl}${fullMockEndpoint}` : fullMockEndpoint

  const handleCopyFullUrl = async () => {
    try {
      await navigator.clipboard.writeText(absoluteMockEndpoint)
      setCopiedUrl(true)
      toast.info('Mock URL copied', absoluteMockEndpoint)
      window.setTimeout(() => setCopiedUrl(false), 1800)
    } catch {
      toast.error('Failed to copy URL')
    }
  }

  const handleFormatJson = () => {
    try {
      const formatted = JSON.stringify(JSON.parse(responseBody), null, 2)
      setResponseBody(formatted)
      setIsDirty(true)
      toast.success('Response JSON formatted')
    } catch {
      toast.error('Invalid JSON', 'Fix JSON syntax before formatting.')
    }
  }

  const handleInsertToken = (token: string) => {
    setResponseBody((prev) => {
      if (!prev.trim()) return token
      return `${prev}${prev.endsWith('\n') ? '' : '\n'}${token}`
    })
    setIsDirty(true)
    toast.info('Token inserted', token)
  }

  const activeHeadersCount = headers.filter((h) => h.enabled && h.key.trim()).length
  const statefulItems = selectedMock?.stateItems ?? []
  const isSavedMock = Boolean(selectedId && selectedId !== '__new__')

  return (
    <div className="flex-1 min-w-0 flex overflow-hidden">
      {/* Left Docked Sidebar */}
      <aside className="w-64 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col shrink-0 hidden md:flex">
        <div className="p-2.5 border-b border-[var(--color-border)] flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
              Mock Server
            </span>
            <DropdownMenu
              ariaLabel="Mock server menu"
              align="start"
              widthClassName="w-52"
              triggerClassName="w-7 h-7 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)]"
              trigger={() => <Icon name="dots-vertical" size={14} />}
              items={[
                {
                  id: 'new',
                  label: 'New Mock',
                  icon: 'plus',
                  onSelect: () => {
                    void resetForCreate()
                  },
                },
                {
                  id: 'generate',
                  label: 'Generate from Collection',
                  icon: 'layers',
                  onSelect: () => {
                    setGenCollectionId(treeQuery.data?.collections[0]?.id ?? '')
                    setGenOpen(true)
                  },
                },
              ]}
            />
          </div>
          <Input
            size="sm"
            type="search"
            leftIcon={<Icon name="search" size={13} />}
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Filter mocks..."
            aria-label="Filter mocks"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {mocks.length === 0 ? (
            <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
              No mocks yet. Open the menu above to create or generate from a collection.
            </div>
          ) : filteredMocks.length === 0 ? (
            <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
              No mocks matched &ldquo;{searchFilter.trim()}&rdquo;.
            </div>
          ) : (
            filteredMocks.map((m) => (
              <div
                key={m.id}
                onClick={() => {
                  void handleSelectMock(m)
                }}
                className={cn(
                  'group p-2.5 pr-1.5 rounded-[var(--radius-md)] text-left flex flex-col gap-1 cursor-pointer border transition-colors',
                  selectedId === m.id
                    ? 'bg-[var(--color-primary-subtle)] border-[var(--color-primary)]'
                    : 'border-transparent hover:bg-[var(--color-surface-hover)]',
                  !m.enabled && 'opacity-65',
                )}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <MethodBadge method={m.method} compact active={selectedId === m.id} />
                    {!m.enabled ? <Badge variant="neutral">Off</Badge> : null}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] font-mono tabular-nums text-[var(--color-text-muted)]">
                      {m.hitCount} hits
                    </span>
                    <DropdownMenu
                      ariaLabel={`Actions for ${m.name}`}
                      align="start"
                      widthClassName="w-52"
                      triggerClassName="w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      trigger={() => <Icon name="dots-vertical" size={13} />}
                      items={[
                        {
                          id: 'rename',
                          label: 'Rename Mock',
                          icon: 'edit',
                          onSelect: () => {
                            setRenameMockTarget({ id: m.id, name: m.name })
                            setRenameMockDraft(m.name)
                          },
                        },
                        {
                          id: 'test-client',
                          label: 'Test in Request Client',
                          icon: 'play',
                          onSelect: () =>
                            addBlankTab({
                              name: `Mock: ${m.name}`,
                              method: m.method,
                              url: `${baseMockPath}${m.pathPattern.startsWith('/') ? m.pathPattern : `/${m.pathPattern}`}`,
                            }),
                        },
                        {
                          id: 'delete',
                          label: 'Delete Mock',
                          icon: 'trash',
                          variant: 'danger',
                          dividerBefore: true,
                          onSelect: () => {
                            void (async () => {
                              const ok = await confirm({
                                title: 'Delete mock?',
                                description: `This action cannot be undone. Mock "${m.name}" (${m.method} ${m.pathPattern}) will be permanently removed.`,
                                confirmLabel: 'Delete Mock',
                              })
                              if (ok) deleteMutation.mutate(m.id)
                            })()
                          },
                        },
                      ]}
                    />
                  </div>
                </div>
                <span className="text-xs font-medium truncate pr-1">{m.name}</span>
                <span className="text-[11px] font-mono text-[var(--color-text-secondary)] truncate pr-1">
                  {m.pathPattern}
                </span>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Full-Width Right Editor */}
      <main className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-5">
        <div className="w-full flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex flex-col gap-1.5 min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base font-semibold tracking-tight">Mock Server</h1>
                {selectedMock ? (
                  <Badge variant={selectedMock.enabled ? 'success' : 'neutral'}>
                    {selectedMock.enabled ? 'Active' : 'Disabled'}
                  </Badge>
                ) : null}
                {selectedMock ? (
                  <Badge variant="info">{selectedMock.hitCount} hits</Badge>
                ) : null}
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                <code className="font-mono text-[11px] px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-[var(--color-text)] truncate max-w-full">
                  {absoluteMockEndpoint}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={<Icon name={copiedUrl ? 'check' : 'copy'} size={12} />}
                  onClick={() => {
                    void handleCopyFullUrl()
                  }}
                >
                  {copiedUrl ? 'Copied' : 'Copy URL'}
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                size="md"
                variant="secondary"
                disabled={!pathPattern.trim()}
                leftIcon={<Icon name="play" size={14} />}
                onClick={() =>
                  addBlankTab({
                    name: `Mock: ${name.trim() || pathPattern.trim()}`,
                    method,
                    url: fullMockEndpoint,
                  })
                }
              >
                Test
              </Button>
              <Button
                size="md"
                variant="primary"
                disabled={!name.trim() || !pathPattern.trim()}
                isLoading={saveMutation.isPending}
                leftIcon={<Icon name="save" size={14} />}
                onClick={() => saveMutation.mutate()}
              >
                Save Mock
              </Button>

              <DropdownMenu
                ariaLabel="Mock actions"
                widthClassName="w-52"
                triggerClassName="w-[34px] h-[34px] justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
                trigger={() => <Icon name="dots-vertical" size={15} />}
                items={[
                  ...(isSavedMock
                    ? [
                        {
                          id: 'rename-mock',
                          label: 'Rename Mock',
                          icon: 'edit' as const,
                          onSelect: () => {
                            setRenameMockTarget({ id: selectedId, name })
                            setRenameMockDraft(name)
                          },
                        },
                      ]
                    : []),
                  {
                    id: 'new-mock',
                    label: 'New Mock',
                    icon: 'plus',
                    onSelect: () => {
                      void resetForCreate()
                    },
                  },
                  {
                    id: 'generate-col',
                    label: 'Generate from Collection',
                    icon: 'layers',
                    onSelect: () => {
                      setGenCollectionId(treeQuery.data?.collections[0]?.id ?? '')
                      setGenOpen(true)
                    },
                  },
                  ...(isSavedMock
                    ? [
                        {
                          id: 'delete-mock',
                          label: 'Delete Mock',
                          icon: 'trash' as const,
                          variant: 'danger' as const,
                          dividerBefore: true,
                          onSelect: () => {
                            void (async () => {
                              const ok = await confirm({
                                title: 'Delete mock?',
                                description: `This action cannot be undone. Mock "${name}" (${method} ${pathPattern}) will be permanently removed.`,
                                confirmLabel: 'Delete Mock',
                              })
                              if (ok) deleteMutation.mutate(selectedId)
                            })()
                          },
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          </div>

          <Card className="flex flex-col gap-3.5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Input
                label="Mock Name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setIsDirty(true)
                }}
                placeholder="List Orders"
              />
              <Select
                label="HTTP Method"
                value={method}
                onValueChange={(v) => {
                  setMethod(v as HttpMethod)
                  setIsDirty(true)
                }}
                options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
                popoverWidth={76}
                renderTrigger={(opt) => renderMethodTrigger(opt, method)}
                renderOption={renderMethodOption}
              />
              <Input
                label="Path Pattern"
                mono
                value={pathPattern}
                onChange={(e) => {
                  setPathPattern(e.target.value)
                  setIsDirty(true)
                }}
                placeholder="/orders/:id"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3.5">
              <Input
                label="Status Code"
                mono
                value={statusCode}
                onChange={(e) => {
                  setStatusCode(e.target.value)
                  setIsDirty(true)
                }}
                placeholder="200"
              />
              <Input
                label="Simulated Latency (ms)"
                mono
                value={latencyMs}
                onChange={(e) => {
                  setLatencyMs(e.target.value)
                  setIsDirty(true)
                }}
                placeholder="0"
              />
              <Input
                label="Simulated Error Rate (%)"
                mono
                value={errorRate}
                onChange={(e) => {
                  setErrorRate(e.target.value)
                  setIsDirty(true)
                }}
                placeholder="0"
              />
              <Input
                label="Rate Limit (req/min)"
                mono
                value={rateLimitRpm}
                onChange={(e) => {
                  setRateLimitRpm(e.target.value)
                  setIsDirty(true)
                }}
                placeholder="0 (Unlimited)"
              />
            </div>

            <div className="flex items-center gap-6 flex-wrap pt-1">
              <Switch
                checked={enabled}
                onChange={(val) => {
                  setEnabled(val)
                  setIsDirty(true)
                }}
                label="Mock Enabled"
              />
              <Switch
                checked={isStateful}
                onChange={(val) => {
                  setIsStateful(val)
                  setIsDirty(true)
                  if (!val && editorTab === 'state') {
                    setEditorTab('body')
                  }
                }}
                label="Stateful CRUD Store (GET / POST / DELETE)"
              />
            </div>

            <div className="pt-1 border-t border-[var(--color-border)] flex flex-col gap-3">
              <Tabs
                activeId={editorTab}
                onChange={(id) => setEditorTab(id as 'body' | 'headers' | 'state')}
                items={[
                  { id: 'body', label: 'Response Body' },
                  { id: 'headers', label: 'Response Headers', count: activeHeadersCount },
                  ...(isStateful
                    ? [{ id: 'state', label: 'Stateful Store', count: statefulItems.length }]
                    : []),
                ]}
                rightSlot={
                  editorTab === 'body' ? (
                    <div className="flex items-center gap-2">
                      <Badge variant={jsonValidation.valid ? 'success' : 'neutral'}>
                        {jsonValidation.label}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        leftIcon={<Icon name="code" size={12} />}
                        onClick={handleFormatJson}
                      >
                        Format JSON
                      </Button>
                    </div>
                  ) : null
                }
              />

              {editorTab === 'body' ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                    <span className="text-[var(--color-text-muted)] font-medium mr-1">
                      Insert token:
                    </span>
                    {DYNAMIC_MOCK_TOKENS.map((t) => (
                      <button
                        key={t.token}
                        type="button"
                        title={t.title}
                        onClick={() => handleInsertToken(t.token)}
                        className="h-6 px-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] font-mono text-[11px] text-[var(--color-text-secondary)] cursor-pointer transition-colors"
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <CodeEditor
                    language="json"
                    value={responseBody}
                    onChange={(val) => {
                      setResponseBody(val)
                      setIsDirty(true)
                    }}
                    minHeight="220px"
                    ariaLabel="Mock response body"
                  />
                </div>
              ) : null}

              {editorTab === 'headers' ? (
                <KeyValueEditor
                  items={headers}
                  onChange={(next) => {
                    setHeaders(next)
                    setIsDirty(true)
                  }}
                  keyPlaceholder="Header (e.g. X-Request-Id)"
                  valuePlaceholder="Value (e.g. application/json)"
                  addLabel="Add Response Header"
                />
              ) : null}

              {editorTab === 'state' && isStateful ? (
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs text-[var(--color-text-secondary)]">
                      Live in-memory records served by <code className="font-mono">GET</code>,{' '}
                      <code className="font-mono">POST</code>, and{' '}
                      <code className="font-mono">DELETE</code> on this mock endpoint.
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!isSavedMock}
                        isLoading={mocksQuery.isFetching}
                        leftIcon={<Icon name="refresh" size={12} />}
                        onClick={() => {
                          void queryClient.invalidateQueries({ queryKey: ['mocks', workspaceId] })
                        }}
                      >
                        Refresh
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!isSavedMock}
                        isLoading={resetStateMutation.isPending}
                        onClick={() => resetStateMutation.mutate('seed')}
                      >
                        Reset to Seed
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={!isSavedMock || statefulItems.length === 0}
                        isLoading={resetStateMutation.isPending}
                        leftIcon={<Icon name="trash" size={12} />}
                        onClick={() => {
                          void (async () => {
                            const ok = await confirm({
                              title: 'Clear stateful store?',
                              description: `Remove all ${statefulItems.length} stored record(s) from "${name}"?`,
                              confirmLabel: 'Clear Store',
                            })
                            if (ok) resetStateMutation.mutate('empty')
                          })()
                        }}
                      >
                        Clear Store
                      </Button>
                    </div>
                  </div>

                  {!isSavedMock ? (
                    <div className="p-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-xs text-[var(--color-text-muted)] text-center">
                      Save this mock first to initialize and inspect its stateful CRUD store.
                    </div>
                  ) : (
                    <CodeEditor
                      language="json"
                      value={JSON.stringify(statefulItems, null, 2)}
                      readOnly
                      minHeight="200px"
                      ariaLabel="Stateful mock store items"
                    />
                  )}
                </div>
              ) : null}
            </div>
          </Card>
        </div>
      </main>

      <Dialog
        open={genOpen}
        title="Generate Mocks from Collection"
        onClose={() => setGenOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <Select
            label="Source Collection"
            value={genCollectionId}
            onValueChange={setGenCollectionId}
            options={(treeQuery.data?.collections ?? []).map((c) => ({
              value: c.id,
              label: c.name,
            }))}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setGenOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!genCollectionId}
              isLoading={generateMutation.isPending}
              onClick={() => generateMutation.mutate()}
            >
              Generate Mocks
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(renameMockTarget)}
        title="Rename Mock"
        onClose={() => setRenameMockTarget(null)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Mock Name"
            value={renameMockDraft}
            onChange={(e) => setRenameMockDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                renameMockDraft.trim() &&
                !renameMockMutation.isPending
              ) {
                e.preventDefault()
                renameMockMutation.mutate()
              }
            }}
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setRenameMockTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!renameMockDraft.trim()}
              isLoading={renameMockMutation.isPending}
              onClick={() => renameMockMutation.mutate()}
            >
              Save Name
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
