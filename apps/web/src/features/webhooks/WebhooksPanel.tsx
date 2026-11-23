'use client'

import type { HttpMethod } from '@meofast/shared'
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
  useConfirm,
  useToast,
} from '@/components/ui'
import { apiRequest } from '@/lib/api-client'
import { cn, formatShortTime } from '@/utils/cn'

interface WebhookEndpointItem {
  id: string
  workspaceId: string
  name: string
  token: string
  receivePath: string
  hasSigningSecret: boolean
  enabled: boolean
  createdAt: string
}

interface WebhookEventItem {
  id: string
  endpointId: string
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  bodyRaw: string
  sourceIp: string
  hmacStatus: 'verified' | 'invalid' | 'unsigned'
  createdAt: string
}

export function WebhooksPanel({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()

  const [selectedEpId, setSelectedEpId] = useState('')
  const [selectedEventId, setSelectedEventId] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSecret, setNewSecret] = useState('')
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [renameEpTarget, setRenameEpTarget] = useState<{ id: string; name: string } | null>(null)
  const [renameEpDraft, setRenameEpDraft] = useState('')

  const [replayTargetUrl, setReplayTargetUrl] = useState('')
  const [replayStatusMsg, setReplayStatusMsg] = useState<string | null>(null)

  const endpointsQuery = useQuery({
    queryKey: ['webhooks', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      apiRequest<{ endpoints: WebhookEndpointItem[] }>(
        `/api/v1/workspaces/${workspaceId}/webhooks`,
      ),
  })

  const endpoints = endpointsQuery.data?.endpoints ?? []

  useEffect(() => {
    if (endpoints.length > 0 && !endpoints.some((e) => e.id === selectedEpId)) {
      setSelectedEpId(endpoints[0]!.id)
    }
  }, [endpoints, selectedEpId])

  const activeEndpoint = endpoints.find((e) => e.id === selectedEpId) ?? null

  const eventsQuery = useQuery({
    queryKey: ['webhook-events', activeEndpoint?.id],
    enabled: Boolean(activeEndpoint?.id),
    refetchInterval: 3000,
    queryFn: () =>
      apiRequest<{ events: WebhookEventItem[] }>(`/api/v1/webhooks/${activeEndpoint!.id}/events`),
  })

  const events = eventsQuery.data?.events ?? []

  useEffect(() => {
    if (events.length > 0 && !events.some((ev) => ev.id === selectedEventId)) {
      setSelectedEventId(events[0]!.id)
    }
  }, [events, selectedEventId])

  const activeEvent = events.find((ev) => ev.id === selectedEventId) ?? events[0] ?? null

  const createMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{ endpoint: WebhookEndpointItem }>(
        `/api/v1/workspaces/${workspaceId}/webhooks`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: newName.trim(),
            signingSecret: newSecret.trim(),
          }),
        },
      )
    },
    onSuccess: async (res) => {
      setCreateOpen(false)
      setNewName('')
      setNewSecret('')
      setSelectedEpId(res.endpoint.id)
      toast.success('Webhook endpoint created')
      await queryClient.invalidateQueries({ queryKey: ['webhooks', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to create webhook', err instanceof Error ? err.message : undefined)
    },
  })

  const renameEndpointMutation = useMutation({
    mutationFn: async () => {
      if (!renameEpTarget || !renameEpDraft.trim()) return null
      await apiRequest(`/api/v1/webhooks/${renameEpTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: renameEpDraft.trim() }),
      })
      return renameEpDraft.trim()
    },
    onSuccess: async () => {
      setRenameEpTarget(null)
      setRenameEpDraft('')
      toast.success('Webhook endpoint renamed')
      await queryClient.invalidateQueries({ queryKey: ['webhooks', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to rename webhook', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest(`/api/v1/webhooks/${id}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      setSelectedEpId('')
      toast.danger('Webhook endpoint deleted')
      await queryClient.invalidateQueries({ queryKey: ['webhooks', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to delete webhook', err instanceof Error ? err.message : undefined)
    },
  })

  const testEventMutation = useMutation({
    mutationFn: async () => {
      if (!activeEndpoint) return
      await apiRequest(`/api/v1/webhooks/${activeEndpoint.id}/test-event`, {
        method: 'POST',
        body: '{}',
      })
    },
    onSuccess: async () => {
      toast.success('Sample event captured')
      await queryClient.invalidateQueries({ queryKey: ['webhook-events', activeEndpoint?.id] })
    },
    onError: (err) => {
      toast.error('Failed to send sample event', err instanceof Error ? err.message : undefined)
    },
  })

  const clearEventsMutation = useMutation({
    mutationFn: async () => {
      if (!activeEndpoint) return
      await apiRequest(`/api/v1/webhooks/${activeEndpoint.id}/events`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      setSelectedEventId('')
      toast.danger('Captured events cleared')
      await queryClient.invalidateQueries({ queryKey: ['webhook-events', activeEndpoint?.id] })
    },
  })

  const replayMutation = useMutation({
    mutationFn: async () => {
      if (!activeEvent) return null
      return apiRequest<{ status: number; durationMs: number }>(
        `/api/v1/webhooks/events/${activeEvent.id}/replay`,
        {
          method: 'POST',
          body: JSON.stringify({
            targetUrl: replayTargetUrl.trim() || activeEndpoint?.receivePath || '',
          }),
        },
      )
    },
    onSuccess: async (res) => {
      if (res) {
        const summary = `HTTP ${res.status} (${res.durationMs} ms)`
        setReplayStatusMsg(`Replayed -> ${summary}`)
        if (res.status >= 400) {
          toast.warning('Event replayed with warning', summary)
        } else {
          toast.success('Webhook event replayed', summary)
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['webhook-events', activeEndpoint?.id] })
    },
    onError: (err) => {
      toast.error('Replay failed', err instanceof Error ? err.message : undefined)
    },
  })

  const fullWebhookUrl =
    typeof window !== 'undefined' && activeEndpoint
      ? `${window.location.origin}${activeEndpoint.receivePath}`
      : activeEndpoint?.receivePath ?? ''

  const handleCopyUrl = async () => {
    if (!fullWebhookUrl) return
    await navigator.clipboard.writeText(fullWebhookUrl)
    setCopiedUrl(true)
    toast.success('Webhook URL copied')
    setTimeout(() => setCopiedUrl(false), 1500)
  }

  return (
    <div className="flex-1 min-w-0 flex overflow-hidden">
      {/* Left Docked Sidebar */}
      <aside className="w-64 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col shrink-0 hidden md:flex">
        <div className="p-2.5 border-b border-[var(--color-border)] flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            Webhook Endpoints
          </span>
          <button
            type="button"
            title="New Webhook"
            aria-label="New Webhook"
            onClick={() => setCreateOpen(true)}
            className="w-7 h-7 inline-flex items-center justify-center rounded-[var(--radius-sm)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] cursor-pointer"
          >
            <Icon name="plus" size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {endpoints.length === 0 ? (
            <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
              No webhook receivers yet. Click + to create one.
            </div>
          ) : (
            endpoints.map((ep) => (
              <div
                key={ep.id}
                onClick={() => {
                  setSelectedEpId(ep.id)
                  setReplayStatusMsg(null)
                }}
                className={cn(
                  'group p-2.5 pr-1.5 rounded-[var(--radius-md)] text-left flex flex-col gap-1 cursor-pointer border transition-colors',
                  selectedEpId === ep.id
                    ? 'bg-[var(--color-primary-subtle)] border-[var(--color-primary)]'
                    : 'border-transparent hover:bg-[var(--color-surface-hover)]',
                )}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-xs font-semibold truncate">{ep.name}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    {ep.hasSigningSecret ? <Badge variant="primary">HMAC</Badge> : null}
                    <DropdownMenu
                      ariaLabel={`Actions for ${ep.name}`}
                      align="start"
                      widthClassName="w-48"
                      triggerClassName="w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      trigger={() => <Icon name="dots-vertical" size={13} />}
                      items={[
                        {
                          id: 'rename',
                          label: 'Rename Endpoint',
                          icon: 'edit',
                          onSelect: () => {
                            setRenameEpTarget({ id: ep.id, name: ep.name })
                            setRenameEpDraft(ep.name)
                          },
                        },
                        {
                          id: 'copy',
                          label: 'Copy Webhook URL',
                          icon: 'copy',
                          onSelect: () => {
                            const url =
                              typeof window !== 'undefined'
                                ? `${window.location.origin}${ep.receivePath}`
                                : ep.receivePath
                            void navigator.clipboard.writeText(url)
                            toast.success('Webhook URL copied')
                          },
                        },
                        {
                          id: 'delete',
                          label: 'Delete Endpoint',
                          icon: 'trash',
                          variant: 'danger',
                          dividerBefore: true,
                          onSelect: () => {
                            void (async () => {
                              const ok = await confirm({
                                title: 'Delete webhook endpoint?',
                                description: `This action cannot be undone. Receiver "${ep.name}" and all captured events will be permanently deleted.`,
                                confirmLabel: 'Delete Endpoint',
                              })
                              if (ok) deleteMutation.mutate(ep.id)
                            })()
                          },
                        },
                      ]}
                    />
                  </div>
                </div>
                <span className="text-[11px] font-mono text-[var(--color-text-secondary)] truncate pr-1">
                  {ep.receivePath}
                </span>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Full-Width Right Inspector */}
      <main className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-5">
        {!activeEndpoint ? (
          <Card className="p-6 flex flex-col items-center gap-2.5 text-center">
            <h1 className="text-base font-semibold">Webhook Inspector</h1>
            <p className="text-xs text-[var(--color-text-secondary)]">
              Create a unique receiver endpoint to inspect payloads, verify HMAC signatures, and
              replay events.
            </p>
            <Button onClick={() => setCreateOpen(true)} leftIcon={<Icon name="plus" size={14} />}>
              New Webhook Endpoint
            </Button>
          </Card>
        ) : (
          <div className="w-full flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-base font-semibold tracking-tight">{activeEndpoint.name}</h1>
                  {activeEndpoint.hasSigningSecret ? (
                    <Badge variant="success">HMAC Secret Active</Badge>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    title="Click to copy webhook URL"
                    onClick={() => {
                      void handleCopyUrl()
                    }}
                    className="text-[11px] font-mono px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--color-surface-secondary)] border border-[var(--color-border)] hover:border-[var(--color-primary)] cursor-pointer transition-colors"
                  >
                    {fullWebhookUrl}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  size="md"
                  variant="primary"
                  isLoading={testEventMutation.isPending}
                  leftIcon={<Icon name="send" size={13} />}
                  onClick={() => testEventMutation.mutate()}
                >
                  Send Sample Event
                </Button>

                <DropdownMenu
                  ariaLabel="Webhook endpoint actions"
                  widthClassName="w-52"
                  triggerClassName="w-[34px] h-[34px] justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
                  trigger={() => <Icon name="dots-vertical" size={15} />}
                  items={[
                    {
                      id: 'rename-endpoint',
                      label: 'Rename Endpoint',
                      icon: 'edit',
                      onSelect: () => {
                        setRenameEpTarget({
                          id: activeEndpoint.id,
                          name: activeEndpoint.name,
                        })
                        setRenameEpDraft(activeEndpoint.name)
                      },
                    },
                    {
                      id: 'copy-url',
                      label: copiedUrl ? 'Copied Webhook URL' : 'Copy Webhook URL',
                      icon: 'copy',
                      onSelect: () => {
                        void handleCopyUrl()
                      },
                    },
                    {
                      id: 'new-endpoint',
                      label: 'New Webhook Endpoint',
                      icon: 'plus',
                      onSelect: () => setCreateOpen(true),
                    },
                    ...(events.length > 0
                      ? [
                          {
                            id: 'clear-events',
                            label: 'Clear Captured Events',
                            icon: 'trash' as const,
                            variant: 'danger' as const,
                            dividerBefore: true,
                            onSelect: () => {
                              void (async () => {
                                const ok = await confirm({
                                  title: 'Clear captured events?',
                                  description:
                                    'This action cannot be undone. All recorded inbound webhook events for this endpoint will be deleted.',
                                  confirmLabel: 'Clear Events',
                                })
                                if (ok) clearEventsMutation.mutate()
                              })()
                            },
                          },
                        ]
                      : []),
                    {
                      id: 'delete-endpoint',
                      label: 'Delete Endpoint',
                      icon: 'trash',
                      variant: 'danger',
                      dividerBefore: events.length === 0,
                      onSelect: () => {
                        void (async () => {
                          const ok = await confirm({
                            title: 'Delete webhook endpoint?',
                            description: `This action cannot be undone. Receiver "${activeEndpoint.name}" and all captured events will be permanently deleted.`,
                            confirmLabel: 'Delete Endpoint',
                          })
                          if (ok) deleteMutation.mutate(activeEndpoint.id)
                        })()
                      },
                    },
                  ]}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 items-start">
              {/* Captured Event Feed */}
              <Card className="p-3 flex flex-col gap-2">
                <span className="text-xs font-semibold text-[var(--color-text-secondary)] px-1">
                  Captured Events ({events.length})
                </span>
                {events.length === 0 ? (
                  <div className="py-10 text-center text-xs text-[var(--color-text-muted)]">
                    Waiting for incoming requests...
                  </div>
                ) : (
                  events.map((ev) => (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => {
                        setSelectedEventId(ev.id)
                        setReplayStatusMsg(null)
                      }}
                      className={cn(
                        'group p-2.5 rounded-[var(--radius-md)] text-left flex flex-col gap-1 cursor-pointer border transition-colors',
                        activeEvent?.id === ev.id
                          ? 'bg-[var(--color-primary-subtle)] border-[var(--color-primary)]'
                          : 'border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <MethodBadge
                          method={ev.method as HttpMethod}
                          compact
                          active={activeEvent?.id === ev.id}
                        />
                        <Badge
                          variant={
                            ev.hmacStatus === 'verified'
                              ? 'success'
                              : ev.hmacStatus === 'invalid'
                                ? 'danger'
                                : 'neutral'
                          }
                        >
                          {ev.hmacStatus.toUpperCase()}
                        </Badge>
                      </div>
                      <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums">
                        {formatShortTime(ev.createdAt)} · {ev.sourceIp}
                      </span>
                    </button>
                  ))
                )}
              </Card>

              {/* Event Detail & Replay */}
              <Card className="p-5 flex flex-col gap-4 min-w-0">
                {!activeEvent ? (
                  <div className="py-16 text-center text-xs text-[var(--color-text-muted)]">
                    Select an event or click Send Sample Event.
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col gap-2">
                      <div className="flex items-end gap-2 flex-wrap sm:flex-nowrap">
                        <div className="flex-1 min-w-[200px]">
                          <Input
                            size="sm"
                            label="Replay Target URL"
                            mono
                            value={replayTargetUrl}
                            onChange={(e) => setReplayTargetUrl(e.target.value)}
                            placeholder={activeEndpoint.receivePath}
                          />
                        </div>
                        <Button
                          size="sm"
                          variant="primary"
                          isLoading={replayMutation.isPending}
                          leftIcon={<Icon name="refresh" size={12} />}
                          onClick={() => replayMutation.mutate()}
                        >
                          Replay Event
                        </Button>
                      </div>
                      {replayStatusMsg ? (
                        <div>
                          <Badge variant="info">{replayStatusMsg}</Badge>
                        </div>
                      ) : null}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                        Payload Body
                      </span>
                      <CodeEditor
                        readOnly
                        language="json"
                        value={activeEvent.bodyRaw || '(Empty payload)'}
                        minHeight="160px"
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                        Headers
                      </span>
                      <DataTable<{ key: string; value: string }>
                        compact
                        defaultPageSize={10}
                        server={{
                          queryKey: ['webhook-events', activeEndpoint?.id, 'headers'],
                          endpoint: `/api/v1/webhooks/events/${activeEvent.id}/headers`,
                          enabled: Boolean(activeEvent?.id),
                        }}
                        getRowKey={(row) => row.key}
                        searchPlaceholder="Search event headers..."
                        emptyMessage="No headers recorded."
                        columns={[
                          {
                            id: 'key',
                            header: 'Header',
                            headerClassName: 'w-1/3',
                            cellClassName: 'font-mono font-medium',
                            cell: (row) => row.key,
                          },
                          {
                            id: 'value',
                            header: 'Value',
                            cellClassName: 'font-mono text-[var(--color-text-secondary)] break-all',
                            cell: (row) => row.value,
                          },
                        ]}
                      />
                    </div>
                  </>
                )}
              </Card>
            </div>
          </div>
        )}
      </main>

      <Dialog
        open={createOpen}
        title="New Webhook Endpoint"
        onClose={() => setCreateOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Endpoint Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Payment Gateway Webhook"
            required
          />
          <Input
            label="HMAC Signing Secret (Optional)"
            type="password"
            mono
            value={newSecret}
            onChange={(e) => setNewSecret(e.target.value)}
            placeholder="whsec_..."
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newName.trim()}
              isLoading={createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              Create Endpoint
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(renameEpTarget)}
        title="Rename Webhook Endpoint"
        onClose={() => setRenameEpTarget(null)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Endpoint Name"
            value={renameEpDraft}
            onChange={(e) => setRenameEpDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                renameEpDraft.trim() &&
                !renameEndpointMutation.isPending
              ) {
                e.preventDefault()
                renameEndpointMutation.mutate()
              }
            }}
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setRenameEpTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!renameEpDraft.trim()}
              isLoading={renameEndpointMutation.isPending}
              onClick={() => renameEndpointMutation.mutate()}
            >
              Save Name
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
