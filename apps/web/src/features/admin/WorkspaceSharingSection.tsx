'use client'

import type { WorkspaceRole } from '@meofast/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Avatar,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  DropdownMenu,
  Icon,
  Select,
  useConfirm,
  useToast,
} from '@/components/ui'
import { apiRequest } from '@/lib/api-client'
import { formatShortTime } from '@/utils/cn'

interface WorkspaceMemberPreview {
  userId: string
  fullName: string
  email: string
  role: WorkspaceRole
}

interface AdminWorkspaceRow {
  id: string
  name: string
  slug: string
  description: string
  visibility: 'team' | 'private'
  publicAccessLevel: 'none' | 'view' | 'edit'
  members: WorkspaceMemberPreview[]
  memberCount: number
  pendingInviteCount: number
  collectionCount: number
  updatedAt: string
}

interface WorkspaceMembersDetailResponse {
  workspace: {
    id: string
    name: string
    visibility: 'team' | 'private'
    publicAccessLevel: 'none' | 'view' | 'edit'
  }
  members: Array<{
    userId: string
    fullName: string
    email: string
    username: string
    role: WorkspaceRole
    joinedAt: string
  }>
  pendingInvitations: Array<{
    id: string
    userId: string
    fullName: string
    email: string
    role: WorkspaceRole
    invitedBy: string
    createdAt: string
  }>
  availableUsers: Array<{
    id: string
    fullName: string
    email: string
    username: string
    globalRole: string
  }>
}

const WORKSPACE_ROLE_OPTIONS: Array<{ value: WorkspaceRole; label: string }> = [
  { value: 'workspace_admin', label: 'Admin' },
  { value: 'developer', label: 'Can Edit' },
  { value: 'viewer', label: 'Can View' },
]

export function WorkspaceSharingSection({
  canManageWorkspaces,
}: {
  canManageWorkspaces: boolean
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()

  const [shareTargetId, setShareTargetId] = useState<string | null>(null)
  const [inviteUserId, setInviteUserId] = useState('')
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('developer')

  const membersQuery = useQuery({
    queryKey: ['workspace-members-detail', shareTargetId],
    enabled: Boolean(shareTargetId),
    queryFn: () =>
      apiRequest<WorkspaceMembersDetailResponse>(`/api/v1/workspaces/${shareTargetId}/members`),
  })

  const updateSharingMutation = useMutation({
    mutationFn: async (input: {
      workspaceId: string
      visibility: 'private' | 'team'
      publicAccessLevel: 'none' | 'view' | 'edit'
    }) =>
      apiRequest(`/api/v1/workspaces/${input.workspaceId}/sharing`, {
        method: 'PATCH',
        body: JSON.stringify({
          visibility: input.visibility,
          publicAccessLevel: input.publicAccessLevel,
        }),
      }),
    onSuccess: async () => {
      toast.success('Workspace access updated')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-workspaces'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-members-detail', shareTargetId] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to update access', err instanceof Error ? err.message : undefined)
    },
  })

  const sendInviteMutation = useMutation({
    mutationFn: async () => {
      if (!shareTargetId || !inviteUserId) return
      await apiRequest(`/api/v1/workspaces/${shareTargetId}/invitations`, {
        method: 'POST',
        body: JSON.stringify({ userId: inviteUserId, role: inviteRole }),
      })
    },
    onSuccess: async () => {
      setInviteUserId('')
      toast.success('Invitation sent', 'The user has been notified in real time.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-workspaces'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-members-detail', shareTargetId] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to send invitation', err instanceof Error ? err.message : undefined)
    },
  })

  const updateMemberRoleMutation = useMutation({
    mutationFn: async (input: { userId: string; role: WorkspaceRole }) => {
      if (!shareTargetId) return
      await apiRequest(`/api/v1/workspaces/${shareTargetId}/members/${input.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: input.role }),
      })
    },
    onSuccess: async () => {
      toast.success('Member role updated')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-workspaces'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-members-detail', shareTargetId] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to update role', err instanceof Error ? err.message : undefined)
    },
  })

  const removeMemberMutation = useMutation({
    mutationFn: async (userId: string) => {
      if (!shareTargetId) return
      await apiRequest(`/api/v1/workspaces/${shareTargetId}/members/${userId}`, {
        method: 'DELETE',
      })
    },
    onSuccess: async () => {
      toast.info('Member removed from workspace')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-workspaces'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-members-detail', shareTargetId] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to remove member', err instanceof Error ? err.message : undefined)
    },
  })

  const revokeInviteMutation = useMutation({
    mutationFn: async (inviteId: string) => {
      if (!shareTargetId) return
      await apiRequest(`/api/v1/workspaces/${shareTargetId}/invitations/${inviteId}`, {
        method: 'DELETE',
      })
    },
    onSuccess: async () => {
      toast.info('Invitation revoked')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-workspaces'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-members-detail', shareTargetId] }),
      ])
    },
  })

  const detail = membersQuery.data

  return (
    <>
      <Card padding="md" className="w-full flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-base font-semibold">Workspaces &amp; Access</h1>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              Manage workspace visibility (Private / Public Can View or Can Edit), members, and real-time invitations.
            </p>
          </div>
        </div>

        <DataTable<AdminWorkspaceRow>
          server={{
            queryKey: ['admin-workspaces'],
            endpoint: '/api/v1/admin/workspaces',
          }}
          defaultPageSize={10}
          getRowKey={(ws) => ws.id}
          searchPlaceholder="Search workspaces, members, or visibility..."
          emptyMessage="No workspaces found."
          columns={[
            {
              id: 'name',
              header: 'Workspace',
              sortValue: (ws) => ws.name,
              cell: (ws) => (
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[var(--color-text)]">{ws.name}</span>
                    <code className="text-[11px] font-mono text-[var(--color-text-muted)]">
                      {ws.slug}
                    </code>
                  </div>
                  {ws.description ? (
                    <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5 truncate max-w-md">
                      {ws.description}
                    </p>
                  ) : null}
                </div>
              ),
            },
            {
              id: 'visibility',
              header: 'Visibility & Access',
              sortValue: (ws) => `${ws.visibility}_${ws.publicAccessLevel}`,
              cell: (ws) => {
                if (ws.visibility === 'private' || ws.publicAccessLevel === 'none') {
                  return (
                    <Badge variant="neutral">
                      <Icon name="lock" size={11} />
                      <span>Private</span>
                    </Badge>
                  )
                }
                if (ws.publicAccessLevel === 'view') {
                  return (
                    <Badge variant="info">
                      <Icon name="globe" size={11} />
                      <span>Public · Can View</span>
                    </Badge>
                  )
                }
                return (
                  <Badge variant="success">
                    <Icon name="globe" size={11} />
                    <span>Public · Can Edit</span>
                  </Badge>
                )
              },
            },
            {
              id: 'members',
              header: 'Members',
              sortValue: (ws) => ws.memberCount,
              cell: (ws) => {
                const shown = ws.members.slice(0, 3)
                const overflow = Math.max(0, ws.members.length - 3)
                return (
                  <button
                    type="button"
                    onClick={() => setShareTargetId(ws.id)}
                    title="Manage workspace members & invitations"
                    className="inline-flex items-center gap-2 group cursor-pointer"
                  >
                    <div className="flex items-center -space-x-2">
                      {shown.map((m) => (
                        <span
                          key={m.userId}
                          title={`${m.fullName} (${m.role})`}
                          className="inline-flex rounded-full ring-2 ring-[var(--color-surface)] transition-transform group-hover:translate-x-0.5"
                        >
                          <Avatar name={m.fullName} size="sm" />
                        </span>
                      ))}
                      {overflow > 0 ? (
                        <span className="w-7 h-7 rounded-full bg-[var(--color-primary-subtle)] text-[var(--color-primary)] border border-[var(--color-border-strong)] ring-2 ring-[var(--color-surface)] text-[11px] font-semibold inline-flex items-center justify-center tabular-nums">
                          +{overflow}
                        </span>
                      ) : null}
                      {shown.length === 0 ? (
                        <span className="text-[11px] text-[var(--color-text-muted)]">No members</span>
                      ) : null}
                    </div>
                    {ws.pendingInviteCount > 0 ? (
                      <Badge variant="warning">{ws.pendingInviteCount} pending</Badge>
                    ) : null}
                  </button>
                )
              },
            },
            {
              id: 'collections',
              header: 'Collections',
              sortValue: (ws) => ws.collectionCount,
              cellClassName: 'tabular-nums text-[var(--color-text-secondary)]',
              cell: (ws) => ws.collectionCount,
            },
            {
              id: 'actions',
              header: 'Actions',
              sortable: false,
              align: 'right',
              cell: (ws) => (
                <DropdownMenu
                  ariaLabel={`Actions for ${ws.name}`}
                  widthClassName="w-52"
                  triggerClassName="w-[30px] h-[30px] justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] text-[var(--color-text-secondary)]"
                  trigger={() => <Icon name="dots-vertical" size={14} />}
                  items={[
                    {
                      id: 'share-members',
                      label: 'Share & Manage Members',
                      icon: 'user-plus',
                      onSelect: () => setShareTargetId(ws.id),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>

      {/* Google Drive-Style Share, Visibility & Members Modal */}
      <Dialog
        open={Boolean(shareTargetId)}
        title={detail ? `Share "${detail.workspace.name}"` : 'Share Workspace'}
        description="Control public visibility, manage existing members, or send real-time workspace invitations."
        maxWidthClass="max-w-xl"
        onClose={() => {
          setShareTargetId(null)
          setInviteUserId('')
        }}
      >
        {membersQuery.isLoading || !detail ? (
          <div className="py-8 flex flex-col gap-3 animate-pulse">
            <div className="h-14 rounded-[var(--radius-md)] bg-[var(--color-surface-secondary)]" />
            <div className="h-10 rounded-[var(--radius-md)] bg-[var(--color-surface-secondary)]" />
            <div className="h-10 rounded-[var(--radius-md)] bg-[var(--color-surface-secondary)]" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* General Access Card (Google Drive-Style) */}
            <div className="p-3.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-secondary)]/55 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-[var(--color-primary-subtle)] text-[var(--color-primary)] flex items-center justify-center shrink-0">
                    <Icon
                      name={detail.workspace.visibility === 'private' ? 'lock' : 'globe'}
                      size={15}
                    />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-[var(--color-text)]">
                      General Access
                    </div>
                    <div className="text-[11px] text-[var(--color-text-secondary)]">
                      {detail.workspace.visibility === 'private'
                        ? 'Restricted — Only invited members can access this workspace.'
                        : detail.workspace.publicAccessLevel === 'view'
                          ? 'Public — Anyone in your organization can view.'
                          : 'Public — Anyone in your organization can edit.'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <Select
                  label="Visibility"
                  disabled={!canManageWorkspaces || updateSharingMutation.isPending}
                  value={detail.workspace.visibility}
                  onValueChange={(val) => {
                    const nextVis = val as 'private' | 'team'
                    updateSharingMutation.mutate({
                      workspaceId: detail.workspace.id,
                      visibility: nextVis,
                      publicAccessLevel:
                        nextVis === 'private'
                          ? 'none'
                          : detail.workspace.publicAccessLevel === 'none'
                            ? 'view'
                            : detail.workspace.publicAccessLevel,
                    })
                  }}
                  options={[
                    { value: 'private', label: 'Private (Invited Only)' },
                    { value: 'team', label: 'Public (Organization)' },
                  ]}
                />

                {detail.workspace.visibility === 'team' ? (
                  <Select
                    label="Public Access Level"
                    disabled={!canManageWorkspaces || updateSharingMutation.isPending}
                    value={
                      detail.workspace.publicAccessLevel === 'none'
                        ? 'view'
                        : detail.workspace.publicAccessLevel
                    }
                    onValueChange={(val) => {
                      updateSharingMutation.mutate({
                        workspaceId: detail.workspace.id,
                        visibility: 'team',
                        publicAccessLevel: val as 'view' | 'edit',
                      })
                    }}
                    options={[
                      { value: 'view', label: 'Can View (Read-Only)' },
                      { value: 'edit', label: 'Can Edit (Developer)' },
                    ]}
                  />
                ) : null}
              </div>
            </div>

            {/* Send Real-Time Invitation */}
            {canManageWorkspaces ? (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-[var(--color-text)]">
                  Invite People
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_130px_auto] gap-2 items-end">
                  <Select
                    ariaLabel="Select user to invite"
                    placeholder={
                      detail.availableUsers.length === 0
                        ? 'All active users already invited'
                        : 'Select team member...'
                    }
                    disabled={detail.availableUsers.length === 0}
                    value={inviteUserId}
                    onValueChange={setInviteUserId}
                    options={detail.availableUsers.map((u) => ({
                      value: u.id,
                      label: `${u.fullName} (${u.email})`,
                    }))}
                  />
                  <Select
                    ariaLabel="Invitation role"
                    value={inviteRole}
                    onValueChange={(v) => setInviteRole(v as WorkspaceRole)}
                    options={WORKSPACE_ROLE_OPTIONS}
                  />
                  <Button
                    size="md"
                    variant="primary"
                    disabled={!inviteUserId}
                    isLoading={sendInviteMutation.isPending}
                    leftIcon={<Icon name="send" size={13} />}
                    onClick={() => sendInviteMutation.mutate()}
                  >
                    Invite
                  </Button>
                </div>
              </div>
            ) : null}

            {/* Current Members */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--color-text)]">
                  People with access
                </span>
                <Badge variant="neutral">{detail.members.length}</Badge>
              </div>
              <div className="max-h-52 overflow-y-auto divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
                {detail.members.length === 0 ? (
                  <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
                    No direct members assigned yet.
                  </div>
                ) : (
                  detail.members.map((m) => (
                    <div
                      key={m.userId}
                      className="px-3 py-2 flex items-center justify-between gap-2.5"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Avatar name={m.fullName} size="sm" />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[var(--color-text)] truncate">
                            {m.fullName}
                          </div>
                          <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                            {m.email}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Select
                          size="sm"
                          ariaLabel={`Role for ${m.fullName}`}
                          disabled={!canManageWorkspaces}
                          value={m.role}
                          onValueChange={(nextRole) =>
                            updateMemberRoleMutation.mutate({
                              userId: m.userId,
                              role: nextRole as WorkspaceRole,
                            })
                          }
                          options={WORKSPACE_ROLE_OPTIONS}
                          className="w-[110px]"
                        />
                        {canManageWorkspaces ? (
                          <button
                            type="button"
                            title={`Remove ${m.fullName}`}
                            aria-label={`Remove ${m.fullName}`}
                            onClick={() => {
                              void (async () => {
                                const ok = await confirm({
                                  title: 'Remove member?',
                                  description: `Remove ${m.fullName} from "${detail.workspace.name}"?`,
                                  confirmLabel: 'Remove Member',
                                })
                                if (ok) removeMemberMutation.mutate(m.userId)
                              })()
                            }}
                            className="w-7 h-7 inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] cursor-pointer transition-colors"
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Pending Invitations */}
            {detail.pendingInvitations.length > 0 ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[var(--color-text)]">
                    Pending Invitations
                  </span>
                  <Badge variant="warning">{detail.pendingInvitations.length}</Badge>
                </div>
                <div className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
                  {detail.pendingInvitations.map((inv) => (
                    <div
                      key={inv.id}
                      className="px-3 py-2 flex items-center justify-between gap-2.5"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Avatar name={inv.fullName} size="sm" />
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-[var(--color-text)] truncate">
                            {inv.fullName}
                          </div>
                          <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                            {inv.email} · Sent {formatShortTime(inv.createdAt)}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="neutral">
                          {inv.role === 'workspace_admin'
                            ? 'Admin'
                            : inv.role === 'developer'
                              ? 'Can Edit'
                              : 'Can View'}
                        </Badge>
                        {canManageWorkspaces ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => revokeInviteMutation.mutate(inv.id)}
                          >
                            Revoke
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Dialog>
    </>
  )
}
