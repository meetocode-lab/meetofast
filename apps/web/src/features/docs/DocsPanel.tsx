'use client'

import type {
  GraphqlPayloadConfig,
  HttpMethod,
  KeyValueItem,
  RequestAssertion,
  RequestAuthConfig,
  RequestBodyConfig,
  RequestProtocol,
  ResponseExampleItem,
  ResponseVariableExtractor,
} from '@meofast/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CodeEditor,
  DataTable,
  Dialog,
  DropdownMenu,
  Icon,
  Input,
  MethodBadge,
  Select,
  useToast,
} from '@/components/ui'
import { useWorkbenchStore } from '@/features/client/store/useWorkbenchStore'
import { generateClientSnippet } from '@/features/client/utils/code-snippets'
import { apiRequest } from '@/lib/api-client'
import { cn } from '@/utils/cn'

interface SavedReqDoc {
  id: string
  collectionId: string
  folderId: string | null
  name: string
  description: string
  protocol: RequestProtocol
  method: HttpMethod
  url: string
  queryParams: KeyValueItem[]
  headers: KeyValueItem[]
  pathVariables: KeyValueItem[]
  auth: RequestAuthConfig
  body: RequestBodyConfig
  graphql: GraphqlPayloadConfig
  assertions: RequestAssertion[]
  postResponseVars?: ResponseVariableExtractor[]
  examples?: ResponseExampleItem[]
  jsonSchema: string
}

interface CollectionDoc {
  id: string
  name: string
  description: string
  folders: Array<{ id: string; name: string }>
  requests: SavedReqDoc[]
}

export function DocsPanel({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const { openSavedRequest, tabs, updateTabById } = useWorkbenchStore()
  const toast = useToast()
  const [selectedColId, setSelectedColId] = useState('')
  const [search, setSearch] = useState('')
  const [downloadingHtml, setDownloadingHtml] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{
    kind: 'collection' | 'request' | 'example'
    id: string
    name: string
  } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const renameMutation = useMutation({
    mutationFn: async () => {
      if (!renameTarget || !renameDraft.trim()) return null
      const nextName = renameDraft.trim()
      const endpoint =
        renameTarget.kind === 'collection'
          ? `/api/v1/collections/${renameTarget.id}`
          : renameTarget.kind === 'request'
            ? `/api/v1/requests/${renameTarget.id}`
            : `/api/v1/examples/${renameTarget.id}`
      await apiRequest(endpoint, {
        method: 'PATCH',
        body: JSON.stringify({ name: nextName }),
      })
      return { ...renameTarget, name: nextName }
    },
    onSuccess: async (updated) => {
      if (updated?.kind === 'request') {
        for (const t of tabs) {
          if (t.savedRequestId === updated.id) {
            updateTabById(t.tabId, { name: updated.name }, false)
          }
        }
      }
      setRenameTarget(null)
      setRenameDraft('')
      toast.success(
        updated?.kind === 'collection'
          ? 'Collection renamed'
          : updated?.kind === 'example'
            ? 'Example renamed'
            : 'Endpoint renamed',
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workspace-tree', workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ['profile-overview'] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to rename', err instanceof Error ? err.message : undefined)
    },
  })

  const treeQuery = useQuery({
    queryKey: ['workspace-tree', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () => apiRequest<{ collections: CollectionDoc[] }>(`/api/v1/workspaces/${workspaceId}/tree`),
  })

  const collections = treeQuery.data?.collections ?? []

  useEffect(() => {
    if (collections.length > 0 && !collections.some((c) => c.id === selectedColId)) {
      setSelectedColId(collections[0]!.id)
    }
  }, [collections, selectedColId])

  const activeCol = collections.find((c) => c.id === selectedColId) ?? collections[0] ?? null
  const filteredRequests = (activeCol?.requests ?? []).filter(
    (r) =>
      !search.trim() ||
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.url.toLowerCase().includes(search.toLowerCase()),
  )

  const handleExportHtml = async () => {
    if (!activeCol) return
    setDownloadingHtml(true)
    try {
      const res = await fetch(`/api/v1/collections/${activeCol.id}/export?format=html`, {
        credentials: 'include',
      })
      const html = await res.text()
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${activeCol.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-docs.html`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setDownloadingHtml(false)
    }
  }

  return (
    <div className="flex-1 min-w-0 flex overflow-hidden">
      {/* Left Docked Sidebar */}
      <aside className="w-64 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col shrink-0 hidden md:flex">
        <div className="p-2.5 border-b border-[var(--color-border)] flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            API Documentation
          </span>
          {collections.length > 0 ? (
            <Select
              size="sm"
              ariaLabel="Select collection"
              value={activeCol?.id ?? ''}
              onValueChange={setSelectedColId}
              options={collections.map((c) => ({ value: c.id, label: c.name }))}
            />
          ) : null}
          <Input
            size="sm"
            type="search"
            leftIcon={<Icon name="search" size={13} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter endpoints..."
            aria-label="Filter documentation endpoints"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {filteredRequests.map((req) => (
            <div
              key={req.id}
              onClick={() => {
                document.getElementById(`doc-ep-${req.id}`)?.scrollIntoView({ behavior: 'smooth' })
              }}
              className="group h-8 pl-2.5 pr-1.5 rounded-[var(--radius-md)] hover:bg-[var(--color-surface-hover)] flex items-center justify-between gap-2 text-xs text-[var(--color-text)] cursor-pointer transition-colors"
            >
              <span className="inline-flex items-center gap-2 min-w-0 truncate">
                <MethodBadge method={req.method} compact />
                <span className="truncate">{req.name}</span>
              </span>
              <div className="flex items-center justify-center shrink-0">
                <DropdownMenu
                  ariaLabel={`Actions for ${req.name}`}
                  align="start"
                  widthClassName="w-48"
                  triggerClassName="w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                  trigger={() => <Icon name="dots-vertical" size={13} />}
                  items={[
                    {
                      id: 'rename',
                      label: 'Rename Endpoint',
                      icon: 'edit',
                      onSelect: () => {
                        setRenameTarget({ kind: 'request', id: req.id, name: req.name })
                        setRenameDraft(req.name)
                      },
                    },
                    {
                      id: 'open',
                      label: 'Open in Request Client',
                      icon: 'play',
                      onSelect: () => openSavedRequest(req),
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Full-Width Documentation Main Workspace */}
      <main className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-5">
        {!activeCol ? (
          <Card className="p-6 text-center text-xs text-[var(--color-text-muted)]">
            Create or import a collection to generate API documentation.
          </Card>
        ) : (
          <div className="w-full flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex flex-col gap-0.5">
                <h1 className="text-base font-semibold tracking-tight">{activeCol.name}</h1>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  {activeCol.description || `${activeCol.requests.length} documented endpoints.`}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="md"
                  variant="primary"
                  isLoading={downloadingHtml}
                  leftIcon={<Icon name="download" size={14} />}
                  onClick={() => {
                    void handleExportHtml()
                  }}
                >
                  Export Static HTML
                </Button>
                <DropdownMenu
                  ariaLabel={`Actions for ${activeCol.name}`}
                  widthClassName="w-48"
                  triggerClassName="w-[34px] h-[34px] justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
                  trigger={() => <Icon name="dots-vertical" size={15} />}
                  items={[
                    {
                      id: 'rename-col',
                      label: 'Rename Collection',
                      icon: 'edit',
                      onSelect: () => {
                        setRenameTarget({
                          kind: 'collection',
                          id: activeCol.id,
                          name: activeCol.name,
                        })
                        setRenameDraft(activeCol.name)
                      },
                    },
                    {
                      id: 'export-html',
                      label: 'Export Static HTML',
                      icon: 'download',
                      onSelect: () => {
                        void handleExportHtml()
                      },
                    },
                  ]}
                />
              </div>
            </div>

            {filteredRequests.map((req) => {
              const curlSample = generateClientSnippet(
                {
                  tabId: req.id,
                  savedRequestId: req.id,
                  collectionId: req.collectionId,
                  folderId: req.folderId,
                  name: req.name,
                  description: req.description,
                  protocol: req.protocol ?? 'http',
                  method: req.method,
                  url: req.url,
                  queryParams: req.queryParams,
                  headers: req.headers,
                  pathVariables: req.pathVariables,
                  auth: req.auth,
                  body: req.body,
                  graphql: req.graphql,
                  assertions: req.assertions,
                  postResponseVars: req.postResponseVars ?? [],
                  preRequestScript: '',
                  testScript: '',
                  jsonSchema: req.jsonSchema,
                  dirty: false,
                  isSending: false,
                  response: null,
                  pinnedResponse: null,
                  lastError: null,
                },
                'curl',
              )

              const activeParams = [...req.pathVariables, ...req.queryParams].filter(
                (p) => p.enabled && p.key,
              )
              const activeHeaders = req.headers.filter((h) => h.enabled && h.key)

              return (
                <Card key={req.id} id={`doc-ep-${req.id}`} className="p-5 flex flex-col gap-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex flex-col gap-1.5 min-w-0">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <MethodBadge method={req.method} active />
                        <code className="text-xs font-mono px-2.5 py-1 rounded-[var(--radius-md)] bg-[var(--color-surface-secondary)] border border-[var(--color-border)]">
                          {req.url}
                        </code>
                        {req.auth.type !== 'none' ? (
                          <Badge variant="primary">Auth: {req.auth.type.toUpperCase()}</Badge>
                        ) : null}
                      </div>
                      <h2 className="text-base font-semibold">{req.name}</h2>
                      {req.description ? (
                        <p className="text-xs text-[var(--color-text-secondary)]">
                          {req.description}
                        </p>
                      ) : null}
                    </div>

                    <DropdownMenu
                      ariaLabel={`Actions for ${req.name}`}
                      widthClassName="w-52"
                      triggerClassName="w-[30px] h-[30px] justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
                      trigger={() => <Icon name="dots-vertical" size={14} />}
                      items={[
                        {
                          id: 'rename-ep',
                          label: 'Rename Endpoint',
                          icon: 'edit',
                          onSelect: () => {
                            setRenameTarget({ kind: 'request', id: req.id, name: req.name })
                            setRenameDraft(req.name)
                          },
                        },
                        {
                          id: 'try-client',
                          label: 'Open in Request Client',
                          icon: 'play',
                          onSelect: () => openSavedRequest(req),
                        },
                        {
                          id: 'copy-curl',
                          label: 'Copy cURL Command',
                          icon: 'copy',
                          onSelect: () => {
                            void navigator.clipboard.writeText(curlSample)
                            toast.success('cURL command copied')
                          },
                        },
                      ]}
                    />
                  </div>

                  <div className={cn('grid grid-cols-1 lg:grid-cols-2 gap-4')}>
                    <div className="flex flex-col gap-3">
                      {activeParams.length > 0 ? (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                            Parameters
                          </span>
                          <DataTable<KeyValueItem>
                            compact
                            defaultPageSize={5}
                            server={{
                              queryKey: ['workspace-tree', workspaceId, 'doc-params', req.id],
                              endpoint: `/api/v1/requests/${req.id}/doc-items`,
                              params: { kind: 'params' },
                            }}
                            getRowKey={(p) => p.id}
                            searchPlaceholder="Search parameters..."
                            columns={[
                              {
                                id: 'key',
                                header: 'Parameter',
                                cellClassName: 'font-mono font-medium',
                                cell: (p) => p.key,
                              },
                              {
                                id: 'value',
                                header: 'Example Value',
                                cellClassName: 'font-mono text-[var(--color-text-secondary)]',
                                cell: (p) => p.value,
                              },
                            ]}
                          />
                        </div>
                      ) : null}

                      {activeHeaders.length > 0 ? (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                            Headers
                          </span>
                          <DataTable<KeyValueItem>
                            compact
                            defaultPageSize={5}
                            server={{
                              queryKey: ['workspace-tree', workspaceId, 'doc-headers', req.id],
                              endpoint: `/api/v1/requests/${req.id}/doc-items`,
                              params: { kind: 'headers' },
                            }}
                            getRowKey={(h) => h.id}
                            searchPlaceholder="Search headers..."
                            columns={[
                              {
                                id: 'key',
                                header: 'Header',
                                cellClassName: 'font-mono font-medium',
                                cell: (h) => h.key,
                              },
                              {
                                id: 'value',
                                header: 'Value',
                                cellClassName: 'font-mono text-[var(--color-text-secondary)]',
                                cell: (h) => h.value,
                              },
                            ]}
                          />
                        </div>
                      ) : null}

                      {req.body.mode !== 'none' && req.body.raw ? (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                            Body ({req.body.mode.toUpperCase()})
                          </span>
                          <CodeEditor
                            readOnly
                            language={req.body.mode === 'json' ? 'json' : 'text'}
                            value={req.body.raw}
                            minHeight="100px"
                          />
                        </div>
                      ) : null}
                    </div>

                    <div className="flex flex-col gap-3">
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                          cURL Request
                        </span>
                        <CodeEditor
                          readOnly
                          language="text"
                          value={curlSample}
                          minHeight="110px"
                        />
                      </div>

                      {req.examples && req.examples.length > 0 ? (
                        <div className="flex flex-col gap-2">
                          <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                            Saved Response Examples ({req.examples.length})
                          </span>
                          <div className="flex flex-col gap-2.5">
                            {req.examples.map((ex) => (
                              <div
                                key={ex.id}
                                className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background)] p-2.5 flex flex-col gap-1.5"
                              >
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                  <span className="text-xs font-medium text-[var(--color-text)]">
                                    {ex.name}
                                  </span>
                                  <div className="flex items-center gap-1.5">
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
                                    <DropdownMenu
                                      ariaLabel={`Actions for ${ex.name}`}
                                      widthClassName="w-44"
                                      triggerClassName="w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                                      trigger={() => <Icon name="dots-vertical" size={13} />}
                                      items={[
                                        {
                                          id: 'rename-ex',
                                          label: 'Rename Example',
                                          icon: 'edit',
                                          onSelect: () => {
                                            setRenameTarget({
                                              kind: 'example',
                                              id: ex.id,
                                              name: ex.name,
                                            })
                                            setRenameDraft(ex.name)
                                          },
                                        },
                                      ]}
                                    />
                                  </div>
                                </div>
                                {ex.body ? (
                                  <CodeEditor
                                    readOnly
                                    language={
                                      ex.contentType.includes('json') ||
                                      ex.body.trim().startsWith('{') ||
                                      ex.body.trim().startsWith('[')
                                        ? 'json'
                                        : 'text'
                                    }
                                    value={ex.body}
                                    minHeight="80px"
                                  />
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </main>

      <Dialog
        open={Boolean(renameTarget)}
        title={
          renameTarget?.kind === 'collection'
            ? 'Rename Collection'
            : renameTarget?.kind === 'example'
              ? 'Rename Response Example'
              : 'Rename Endpoint'
        }
        onClose={() => setRenameTarget(null)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label={
              renameTarget?.kind === 'collection'
                ? 'Collection Name'
                : renameTarget?.kind === 'example'
                  ? 'Example Title'
                  : 'Endpoint Name'
            }
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameDraft.trim() && !renameMutation.isPending) {
                e.preventDefault()
                renameMutation.mutate()
              }
            }}
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!renameDraft.trim()}
              isLoading={renameMutation.isPending}
              onClick={() => renameMutation.mutate()}
            >
              Save Name
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
