'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  Icon,
  Input,
  Switch,
  useConfirm,
  useToast,
} from '@/components/ui'
import { apiRequest } from '@/lib/api-client'
import { formatShortTime } from '@/utils/cn'

interface WorkspaceCookieItem {
  id: string
  workspaceId: string
  domain: string
  path: string
  name: string
  value: string
  httpOnly: boolean
  secure: boolean
  expiresAt: string | null
  enabled: boolean
  updatedAt: string
}

export function CookieJarModal({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean
  onClose: () => void
  workspaceId: string
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()

  const [domain, setDomain] = useState('')
  const [cookiePath, setCookiePath] = useState('/')
  const [cookieName, setCookieName] = useState('')
  const [cookieValue, setCookieValue] = useState('')

  const cookiesQuery = useQuery({
    queryKey: ['workspace-cookies', workspaceId],
    enabled: Boolean(open && workspaceId),
    queryFn: () =>
      apiRequest<{ cookies: WorkspaceCookieItem[] }>(
        `/api/v1/workspaces/${workspaceId}/cookies`,
      ),
  })

  const cookies = cookiesQuery.data?.cookies ?? []

  const groupedByDomain = useMemo(() => {
    const map = new Map<string, WorkspaceCookieItem[]>()
    for (const c of cookies) {
      const bucket = map.get(c.domain) ?? []
      bucket.push(c)
      map.set(c.domain, bucket)
    }
    return Array.from(map.entries())
  }, [cookies])

  const addCookieMutation = useMutation({
    mutationFn: async () => {
      await apiRequest(`/api/v1/workspaces/${workspaceId}/cookies`, {
        method: 'POST',
        body: JSON.stringify({
          domain: domain.trim(),
          path: cookiePath.trim() || '/',
          name: cookieName.trim(),
          value: cookieValue,
        }),
      })
    },
    onSuccess: async () => {
      setCookieName('')
      setCookieValue('')
      toast.success('Cookie saved', `Stored on ${domain.trim().toLowerCase()}.`)
      await queryClient.invalidateQueries({ queryKey: ['workspace-cookies', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to save cookie', err instanceof Error ? err.message : undefined)
    },
  })

  const toggleCookieMutation = useMutation({
    mutationFn: async (input: { id: string; enabled: boolean }) => {
      await apiRequest(`/api/v1/cookies/${input.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: input.enabled }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspace-cookies', workspaceId] })
    },
  })

  const deleteCookieMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest(`/api/v1/cookies/${id}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      toast.info('Cookie removed')
      await queryClient.invalidateQueries({ queryKey: ['workspace-cookies', workspaceId] })
    },
  })

  const clearAllMutation = useMutation({
    mutationFn: async () => {
      await apiRequest(`/api/v1/workspaces/${workspaceId}/cookies`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      toast.danger('Cookie Jar cleared', 'All stored domain cookies were removed.')
      await queryClient.invalidateQueries({ queryKey: ['workspace-cookies', workspaceId] })
    },
  })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Workspace Cookie Jar"
      description="Set-Cookie responses are captured automatically and sent on matching domain requests."
      maxWidthClass="max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        <div className="p-3.5 rounded-[var(--radius-lg)] bg-[var(--color-surface-secondary)] border border-[var(--color-border)] flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1.2fr_0.7fr_1fr_1.3fr] gap-2.5">
            <Input
              size="sm"
              placeholder="api.example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              aria-label="Cookie domain"
            />
            <Input
              size="sm"
              mono
              placeholder="/"
              value={cookiePath}
              onChange={(e) => setCookiePath(e.target.value)}
              aria-label="Cookie path"
            />
            <Input
              size="sm"
              mono
              placeholder="session_id"
              value={cookieName}
              onChange={(e) => setCookieName(e.target.value)}
              aria-label="Cookie name"
            />
            <Input
              size="sm"
              mono
              placeholder="Value"
              value={cookieValue}
              onChange={(e) => setCookieValue(e.target.value)}
              aria-label="Cookie value"
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            {cookies.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Icon name="trash" size={12} />}
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Clear Cookie Jar?',
                    description:
                      'This action cannot be undone. All stored session cookies across every domain in this workspace will be deleted.',
                    confirmLabel: 'Clear All Cookies',
                  })
                  if (ok) clearAllMutation.mutate()
                }}
              >
                Clear All ({cookies.length})
              </Button>
            ) : (
              <span className="text-xs text-[var(--color-text-muted)]">
                Add manually or send a login request that returns Set-Cookie.
              </span>
            )}

            <Button
              size="sm"
              leftIcon={<Icon name="plus" size={13} />}
              disabled={!domain.trim() || !cookieName.trim()}
              isLoading={addCookieMutation.isPending}
              onClick={() => addCookieMutation.mutate()}
            >
              Save Cookie
            </Button>
          </div>
        </div>

        {groupedByDomain.length === 0 ? (
          <div className="py-8 text-center text-xs text-[var(--color-text-muted)] border border-dashed border-[var(--color-border-strong)] rounded-[var(--radius-lg)]">
            No cookies stored in this workspace yet.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {groupedByDomain.map(([dom, items]) => (
              <div
                key={dom}
                className="rounded-[var(--radius-lg)] border border-[var(--color-border)] overflow-hidden"
              >
                <div className="px-3.5 py-2 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)] flex items-center justify-between">
                  <span className="text-xs font-mono font-semibold text-[var(--color-primary)]">
                    {dom}
                  </span>
                  <Badge variant="neutral">{items.length}</Badge>
                </div>

                <div className="divide-y divide-[var(--color-border)]">
                  {items.map((ck) => (
                    <div
                      key={ck.id}
                      className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <Switch
                          checked={ck.enabled}
                          onChange={(enabled) =>
                            toggleCookieMutation.mutate({ id: ck.id, enabled })
                          }
                          ariaLabel={`Enable cookie ${ck.name}`}
                        />
                        <div className="flex flex-col min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono font-semibold truncate">{ck.name}</span>
                            <span className="text-[11px] font-mono text-[var(--color-text-muted)]">
                              {ck.path}
                            </span>
                            {ck.httpOnly ? <Badge variant="neutral">HttpOnly</Badge> : null}
                            {ck.secure ? <Badge variant="info">Secure</Badge> : null}
                          </div>
                          <span className="font-mono text-[11px] text-[var(--color-text-secondary)] truncate">
                            {ck.value}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums hidden sm:inline">
                          {formatShortTime(ck.updatedAt)}
                        </span>
                        <DropdownMenu
                          ariaLabel={`Actions for cookie ${ck.name}`}
                          widthClassName="w-44"
                          triggerClassName="w-7 h-7 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)]"
                          trigger={() => <Icon name="dots-vertical" size={14} />}
                          items={[
                            {
                              id: 'copy',
                              label: 'Copy Cookie Value',
                              icon: 'copy',
                              onSelect: () => {
                                void navigator.clipboard.writeText(ck.value)
                                toast.info('Cookie value copied', ck.name)
                              },
                            },
                            {
                              id: 'delete',
                              label: 'Delete Cookie',
                              icon: 'trash',
                              variant: 'danger',
                              dividerBefore: true,
                              onSelect: () => {
                                void (async () => {
                                  const ok = await confirm({
                                    title: 'Delete cookie?',
                                    description: `Remove "${ck.name}" from ${ck.domain}?`,
                                    confirmLabel: 'Delete Cookie',
                                  })
                                  if (ok) deleteCookieMutation.mutate(ck.id)
                                })()
                              },
                            },
                          ]}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}
