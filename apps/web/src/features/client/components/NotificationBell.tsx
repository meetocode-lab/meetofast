'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Icon, useToast } from '@/components/ui'
import { apiRequest } from '@/lib/api-client'
import { cn, formatShortTime } from '@/utils/cn'

export interface NotificationItem {
  id: string
  userId: string
  type: string
  title: string
  message: string
  metadata: Record<string, unknown> | null
  isRead: boolean
  createdAt: string
}

interface NotificationBellProps {
  onOpenRequestTab?: (tabId: string) => void
  onWorkspacesChanged?: () => void
}

export function NotificationBell({
  onOpenRequestTab,
  onWorkspacesChanged,
}: NotificationBellProps) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [sseConnected, setSseConnected] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const notificationsQuery = useQuery({
    queryKey: ['user-notifications'],
    queryFn: () =>
      apiRequest<{ notifications: NotificationItem[]; unreadCount: number }>('/api/v1/notifications'),
  })

  // Real-time Server-Sent Events (SSE) subscription — zero polling!
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return undefined

    const es = new EventSource('/api/v1/notifications/stream', { withCredentials: true })

    es.addEventListener('connected', () => {
      setSseConnected(true)
    })

    es.addEventListener('notification', (evt) => {
      try {
        const parsed = JSON.parse((evt as MessageEvent).data) as {
          notification?: NotificationItem
        }
        const incoming = parsed.notification
        if (!incoming) return

        queryClient.setQueryData<{ notifications: NotificationItem[]; unreadCount: number }>(
          ['user-notifications'],
          (prev) => {
            const existing = prev?.notifications ?? []
            if (existing.some((n) => n.id === incoming.id)) return prev
            const next = [incoming, ...existing].slice(0, 60)
            return {
              notifications: next,
              unreadCount: next.filter((n) => !n.isRead).length,
            }
          },
        )

        if (incoming.type === 'workspace_invite') {
          toast.info(incoming.title, incoming.message)
        } else if (incoming.type === 'request_failed') {
          toast.error(incoming.title, incoming.message)
        } else if (incoming.type === 'request_completed') {
          toast.success(incoming.title, incoming.message)
        }
      } catch {
        // ignore malformed SSE chunk
      }
    })

    es.addEventListener('sync', () => {
      onWorkspacesChanged?.()
      void queryClient.invalidateQueries({ queryKey: ['admin-workspaces'] })
    })

    es.onerror = () => {
      setSseConnected(false)
    }

    return () => {
      es.close()
    }
  }, [queryClient, toast, onWorkspacesChanged])

  // Close popover on outside click / Escape
  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const markReadMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/notifications/${id}/read`, { method: 'PATCH', body: '{}' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['user-notifications'] })
    },
  })

  const markAllReadMutation = useMutation({
    mutationFn: () => apiRequest('/api/v1/notifications/read-all', { method: 'POST', body: '{}' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['user-notifications'] })
    },
  })

  const clearAllMutation = useMutation({
    mutationFn: () => apiRequest('/api/v1/notifications', { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['user-notifications'] })
    },
  })

  const respondInviteMutation = useMutation({
    mutationFn: async (input: { invitationId: string; action: 'accept' | 'decline' }) =>
      apiRequest<{ ok: boolean; status: string; workspaceId: string }>(
        `/api/v1/workspace-invitations/${input.invitationId}/respond`,
        {
          method: 'POST',
          body: JSON.stringify({ action: input.action }),
        },
      ),
    onSuccess: (_res, vars) => {
      toast.success(
        vars.action === 'accept' ? 'Joined workspace' : 'Invitation declined',
        vars.action === 'accept'
          ? 'The workspace is now available in your workspace switcher.'
          : undefined,
      )
      void queryClient.invalidateQueries({ queryKey: ['user-notifications'] })
      void queryClient.invalidateQueries({ queryKey: ['admin-workspaces'] })
      onWorkspacesChanged?.()
    },
    onError: (err) => {
      toast.error('Failed to respond', err instanceof Error ? err.message : undefined)
    },
  })

  const items = notificationsQuery.data?.notifications ?? []
  const unreadCount = notificationsQuery.data?.unreadCount ?? 0

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Notifications"
        aria-expanded={open}
        title={sseConnected ? 'Notifications (Live)' : 'Notifications'}
        className={cn(
          'relative w-[30px] h-[30px] rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-primary)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] inline-flex items-center justify-center cursor-pointer transition-colors',
          open && 'border-[var(--color-primary)] text-[var(--color-primary)] bg-[var(--color-primary-subtle)]/50',
        )}
      >
        <Icon name="bell" size={14} />
        {unreadCount > 0 ? (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-[var(--color-danger)] text-white text-[10px] font-bold leading-none inline-flex items-center justify-center tabular-nums shadow-[var(--shadow-xs)]">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 mt-2 w-[360px] max-w-[calc(100vw-24px)] rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-popover)] z-[140] overflow-hidden flex flex-col"
          >
            <div className="px-3.5 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-[var(--color-text)]">
                  Notifications
                </span>
                {unreadCount > 0 ? (
                  <Badge variant="primary">{unreadCount} new</Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                {unreadCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => markAllReadMutation.mutate()}
                    className="text-[11px] font-medium text-[var(--color-primary)] hover:underline cursor-pointer"
                  >
                    Mark all read
                  </button>
                ) : null}
                {items.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => clearAllMutation.mutate()}
                    className="text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer ml-1.5"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            </div>

            <div className="max-h-[420px] overflow-y-auto divide-y divide-[var(--color-border)]">
              {items.length === 0 ? (
                <div className="px-4 py-10 text-center flex flex-col items-center gap-2">
                  <div className="w-9 h-9 rounded-full bg-[var(--color-surface-secondary)] border border-[var(--color-border)] flex items-center justify-center text-[var(--color-text-muted)]">
                    <Icon name="bell" size={16} />
                  </div>
                  <span className="text-xs font-medium text-[var(--color-text)]">
                    You&apos;re all caught up
                  </span>
                  <span className="text-[11px] text-[var(--color-text-muted)]">
                    Workspace invitations &amp; background API completions appear here in real time.
                  </span>
                </div>
              ) : (
                items.map((n) => {
                  const meta = n.metadata ?? {}
                  const invitationId =
                    typeof meta.invitationId === 'string' ? meta.invitationId : null
                  const inviteStatus =
                    typeof meta.status === 'string' ? meta.status : 'pending'
                  const tabId = typeof meta.tabId === 'string' ? meta.tabId : null

                  const iconName =
                    n.type === 'workspace_invite'
                      ? 'user-plus'
                      : n.type === 'request_completed'
                        ? 'check-circle'
                        : n.type === 'request_failed'
                          ? 'x-circle'
                          : 'bell'

                  const iconTone =
                    n.type === 'workspace_invite'
                      ? 'text-[var(--color-primary)] bg-[var(--color-primary-subtle)]'
                      : n.type === 'request_completed'
                        ? 'text-[var(--color-success)] bg-[var(--color-success-subtle)]'
                        : n.type === 'request_failed'
                          ? 'text-[var(--color-danger)] bg-[var(--color-danger-subtle)]'
                          : 'text-[var(--color-info)] bg-[var(--color-info-subtle)]'

                  return (
                    <div
                      key={n.id}
                      onClick={() => {
                        if (!n.isRead) markReadMutation.mutate(n.id)
                      }}
                      className={cn(
                        'px-3.5 py-2.5 flex items-start gap-2.5 transition-colors cursor-pointer hover:bg-[var(--color-surface-hover)]/60',
                        !n.isRead && 'bg-[var(--color-primary-subtle)]/35',
                      )}
                    >
                      <div
                        className={cn(
                          'w-7 h-7 rounded-[var(--radius-md)] flex items-center justify-center shrink-0 mt-0.5',
                          iconTone,
                        )}
                      >
                        <Icon name={iconName} size={14} />
                      </div>
                      <div className="min-w-0 flex-1 flex flex-col gap-1">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-xs font-semibold text-[var(--color-text)] leading-snug">
                            {n.title}
                          </span>
                          <span className="text-[10px] text-[var(--color-text-muted)] whitespace-nowrap tabular-nums shrink-0">
                            {formatShortTime(n.createdAt)}
                          </span>
                        </div>
                        <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed">
                          {n.message}
                        </p>

                        {n.type === 'workspace_invite' && invitationId ? (
                          inviteStatus === 'pending' ? (
                            <div
                              className="flex items-center gap-1.5 pt-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Button
                                size="sm"
                                variant="primary"
                                isLoading={respondInviteMutation.isPending}
                                onClick={() =>
                                  respondInviteMutation.mutate({
                                    invitationId,
                                    action: 'accept',
                                  })
                                }
                              >
                                Accept
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={respondInviteMutation.isPending}
                                onClick={() =>
                                  respondInviteMutation.mutate({
                                    invitationId,
                                    action: 'decline',
                                  })
                                }
                              >
                                Decline
                              </Button>
                            </div>
                          ) : (
                            <div className="pt-0.5">
                              <Badge variant={inviteStatus === 'accepted' ? 'success' : 'neutral'}>
                                {inviteStatus === 'accepted' ? 'Accepted' : 'Declined'}
                              </Badge>
                            </div>
                          )
                        ) : null}

                        {(n.type === 'request_completed' || n.type === 'request_failed') &&
                        tabId &&
                        onOpenRequestTab ? (
                          <div className="pt-1" onClick={(e) => e.stopPropagation()}>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                onOpenRequestTab(tabId)
                                setOpen(false)
                              }}
                            >
                              View Result
                            </Button>
                          </div>
                        ) : null}
                      </div>
                      {!n.isRead ? (
                        <span
                          className="w-2 h-2 rounded-full bg-[var(--color-primary)] shrink-0 mt-1.5"
                          aria-label="Unread"
                        />
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
