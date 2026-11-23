'use client'

import type {
  GlobalRole,
  GraphqlPayloadConfig,
  HttpMethod,
  KeyValueItem,
  RequestAssertion,
  RequestAuthConfig,
  RequestBodyConfig,
  RequestProtocol,
  ResponseVariableExtractor,
} from '@meofast/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import {
  Avatar,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  DropdownMenu,
  Icon,
  Input,
  MethodBadge,
  Select,
  useConfirm,
  useToast,
} from '@/components/ui'
import { useWorkbenchStore } from '@/features/client/store/useWorkbenchStore'
import { apiRequest } from '@/lib/api-client'
import { useTheme } from '@/providers/ThemeProvider'
import { cn, formatDuration, formatShortTime } from '@/utils/cn'

export interface ProfileUserInfo {
  id: string
  email: string
  username: string
  fullName: string
  globalRole: GlobalRole
}

interface ProfileCollectionItem {
  id: string
  workspaceId: string
  workspaceName: string
  name: string
  description: string
  isMine: boolean
  folderCount: number
  requestCount: number
  updatedAt: string
}

interface ProfileRequestItem {
  id: string
  workspaceId: string
  workspaceName: string
  collectionId: string
  collectionName: string
  folderId: string | null
  name: string
  description: string
  protocol: RequestProtocol
  method: HttpMethod
  url: string
  isMine: boolean
  queryParams: KeyValueItem[]
  headers: KeyValueItem[]
  pathVariables: KeyValueItem[]
  auth: RequestAuthConfig
  body: RequestBodyConfig
  graphql: GraphqlPayloadConfig
  assertions: RequestAssertion[]
  postResponseVars: ResponseVariableExtractor[]
  preRequestScript: string
  testScript: string
  jsonSchema: string
  updatedAt: string
}

interface ProfileOverviewResponse {
  account: {
    id: string
    email: string
    username: string
    fullName: string
    globalRole: GlobalRole
    status: string
    lastLoginAt: string | null
    createdAt: string
  }
  stats: {
    myCollectionsCount: number
    totalCollectionsCount: number
    myRequestsCount: number
    recentExecutionsCount: number
    activeSessionsCount: number
    apiTokensCount: number
  }
  workspaces: Array<{
    id: string
    name: string
    slug: string
    visibility: string
    role: string
    isOwner: boolean
    createdAt: string
  }>
  collections: ProfileCollectionItem[]
  requests: ProfileRequestItem[]
  recentHistory: Array<{
    id: string
    workspaceId: string
    workspaceName: string
    method: HttpMethod
    url: string
    status: number | null
    durationMs: number
    createdAt: string
  }>
  loginHistory: Array<{
    id: string
    emailAttempted: string
    succeeded: boolean
    ipAddress: string | null
    userAgent: string | null
    failureReason: string | null
    createdAt: string
  }>
}

interface SessionItem {
  id: string
  ipAddress: string | null
  userAgent: string | null
  expiresAt: string
  createdAt: string
  isCurrent: boolean
}

const VALID_PROFILE_TABS = [
  'overview',
  'collections',
  'password',
  'sessions',
  'tokens',
  'activity',
] as const
type ProfileTabId = (typeof VALID_PROFILE_TABS)[number]

function summarizeUserAgent(ua: string | null): string {
  if (!ua) return 'Browser Session'
  const browser = ua.includes('Edg/')
    ? 'Edge'
    : ua.includes('Chrome/')
      ? 'Chrome'
      : ua.includes('Firefox/')
        ? 'Firefox'
        : ua.includes('Safari/')
          ? 'Safari'
          : 'Web Client'
  const os = ua.includes('Windows')
    ? 'Windows'
    : ua.includes('Mac OS')
      ? 'macOS'
      : ua.includes('Linux')
        ? 'Linux'
        : 'Device'
  return `${browser} on ${os}`
}

export function ProfilePanel({
  user,
  onUserUpdated,
  onWorkspaceRenamed,
  onSignOut,
}: {
  user: ProfileUserInfo
  onUserUpdated: (updated: ProfileUserInfo) => void
  onWorkspaceRenamed?: (id: string, name: string) => void
  onSignOut: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const { theme, setTheme } = useTheme()

  const {
    activeWorkspaceId,
    sidebarSubTab,
    splitDirection,
    toggleSplitDirection,
    setActiveWorkspaceId,
    setSidebarSection,
    openSavedRequest,
    tabs,
    updateTabById,
  } = useWorkbenchStore()

  const resolvedTab = VALID_PROFILE_TABS.find((t) => t === sidebarSubTab)
  const tab: ProfileTabId = resolvedTab ?? 'overview'
  const setTab = (next: ProfileTabId) => {
    setSidebarSection('profile', next)
  }

  // Identity form state
  const [fullName, setFullName] = useState(user.fullName)
  const [username, setUsername] = useState(user.username)

  // Collections & Endpoints scope state
  const [portfolioScope, setPortfolioScope] = useState<'mine' | 'all'>('mine')

  // Password reset state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Personal API Tokens state
  const [tokenName, setTokenName] = useState('')
  const [tokenExpiryDays, setTokenExpiryDays] = useState('__never__')
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null)
  const [copiedToken, setCopiedToken] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{
    kind: 'workspace' | 'collection' | 'request' | 'token'
    id: string
    name: string
    workspaceId?: string
  } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  useEffect(() => {
    setFullName(user.fullName)
    setUsername(user.username)
  }, [user.fullName, user.username])

  const overviewQuery = useQuery({
    queryKey: ['profile-overview', user.id],
    queryFn: () => apiRequest<ProfileOverviewResponse>('/api/v1/auth/profile-overview'),
  })

  const sessionsQuery = useQuery({
    queryKey: ['auth-sessions'],
    enabled: tab === 'sessions' || tab === 'overview',
    queryFn: () => apiRequest<{ sessions: SessionItem[] }>('/api/v1/auth/sessions'),
  })

  const tokensQuery = useQuery({
    queryKey: ['auth-tokens'],
    enabled: tab === 'tokens' || tab === 'overview',
    queryFn: () =>
      apiRequest<{
        tokens: Array<{
          id: string
          name: string
          tokenPrefix: string
          lastUsedAt: string | null
          expiresAt: string | null
          createdAt: string
        }>
      }>('/api/v1/auth/tokens'),
  })

  const updateProfileMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{ user: ProfileUserInfo }>('/api/v1/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: fullName.trim(),
          username: username.trim().toLowerCase(),
        }),
      })
    },
    onSuccess: async (res) => {
      onUserUpdated(res.user)
      toast.success('Profile updated', `@${res.user.username}`)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['profile-overview', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to update profile', err instanceof Error ? err.message : undefined)
    },
  })

  const changePasswordMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{ ok: boolean }>('/api/v1/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      })
    },
    onSuccess: async () => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      toast.success('Password updated', 'All other active device sessions were signed out.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auth-sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['profile-overview', user.id] }),
      ])
    },
    onError: (err) => {
      toast.error('Password update failed', err instanceof Error ? err.message : undefined)
    },
  })

  const revokeSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await apiRequest(`/api/v1/auth/sessions/${sessionId}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      toast.danger('Session revoked')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auth-sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['profile-overview', user.id] }),
      ])
    },
  })

  const revokeOtherSessionsMutation = useMutation({
    mutationFn: async () => {
      await apiRequest('/api/v1/auth/sessions', { method: 'DELETE' })
    },
    onSuccess: async () => {
      toast.success('Signed out of other devices')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auth-sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['profile-overview', user.id] }),
      ])
    },
  })

  const createTokenMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{ token: string }>('/api/v1/auth/tokens', {
        method: 'POST',
        body: JSON.stringify({
          name: tokenName.trim(),
          expiresInDays: tokenExpiryDays === '__never__' ? null : Number(tokenExpiryDays),
        }),
      })
    },
    onSuccess: async (res) => {
      setTokenName('')
      setNewlyCreatedToken(res.token)
      toast.success('API token generated', 'Copy your token now — it is only shown once.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auth-tokens'] }),
        queryClient.invalidateQueries({ queryKey: ['profile-overview', user.id] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to generate token', err instanceof Error ? err.message : undefined)
    },
  })

  const renameProfileEntityMutation = useMutation({
    mutationFn: async () => {
      if (!renameTarget || !renameDraft.trim()) return null
      const nextName = renameDraft.trim()
      const endpoint =
        renameTarget.kind === 'workspace'
          ? `/api/v1/workspaces/${renameTarget.id}`
          : renameTarget.kind === 'collection'
            ? `/api/v1/collections/${renameTarget.id}`
            : renameTarget.kind === 'request'
              ? `/api/v1/requests/${renameTarget.id}`
              : `/api/v1/auth/tokens/${renameTarget.id}`

      await apiRequest(endpoint, {
        method: 'PATCH',
        body: JSON.stringify({ name: nextName }),
      })
      return { ...renameTarget, name: nextName }
    },
    onSuccess: async (updated) => {
      if (updated?.kind === 'workspace') {
        onWorkspaceRenamed?.(updated.id, updated.name)
      }
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
        updated?.kind === 'workspace'
          ? 'Workspace renamed'
          : updated?.kind === 'collection'
            ? 'Collection renamed'
            : updated?.kind === 'request'
              ? 'Endpoint renamed'
              : 'API token renamed',
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['profile-overview', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['auth-tokens'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-tree'] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to rename', err instanceof Error ? err.message : undefined)
    },
  })

  const revokeTokenMutation = useMutation({
    mutationFn: async (tokenId: string) => {
      await apiRequest(`/api/v1/auth/tokens/${tokenId}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      toast.danger('API token revoked')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auth-tokens'] }),
        queryClient.invalidateQueries({ queryKey: ['profile-overview', user.id] }),
      ])
    },
  })

  const data = overviewQuery.data
  const sessions = sessionsQuery.data?.sessions ?? []
  const tokens = tokensQuery.data?.tokens ?? []

  const filteredCollections = useMemo(
    () =>
      (data?.collections ?? []).filter((c) => (portfolioScope === 'mine' ? c.isMine : true)),
    [data?.collections, portfolioScope],
  )

  const filteredRequests = useMemo(
    () => (data?.requests ?? []).filter((r) => (portfolioScope === 'mine' ? r.isMine : true)),
    [data?.requests, portfolioScope],
  )

  const passwordChecks = [
    { label: 'At least 10 characters long', ok: newPassword.length >= 10 },
    { label: 'Contains uppercase letter (A–Z)', ok: /[A-Z]/.test(newPassword) },
    { label: 'Contains lowercase letter (a–z)', ok: /[a-z]/.test(newPassword) },
    { label: 'Contains number (0–9)', ok: /[0-9]/.test(newPassword) },
    { label: 'Contains symbol (!@#$...)', ok: /[^A-Za-z0-9]/.test(newPassword) },
    {
      label: 'Confirmation password matches',
      ok: Boolean(newPassword) && newPassword === confirmPassword,
    },
  ]
  const passwordValidToSubmit =
    Boolean(currentPassword) && passwordChecks.every((check) => check.ok)

  const handleExportCollectionJson = async (col: ProfileCollectionItem) => {
    try {
      const json = await apiRequest<Record<string, unknown>>(
        `/api/v1/collections/${col.id}/export?format=native`,
      )
      const slug = col.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug || 'collection'}.meofast.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Collection exported', `${col.name}.meofast.json`)
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : undefined)
    }
  }

  return (
    <div className="flex-1 min-w-0 flex overflow-hidden">
      {/* Secondary Docked Profile Sidebar (256px) */}
      <aside className="w-64 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col justify-between shrink-0 hidden md:flex">
        <div className="p-3 flex flex-col gap-3">
          {/* User Identity Card */}
          <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-xs)] overflow-hidden">
            <div className="h-10 bg-gradient-to-r from-[var(--color-primary)] via-[var(--color-primary-hover)] to-[var(--color-cyan)] relative">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_20%,rgba(255,255,255,0.28),transparent_55%)]" />
            </div>
            <div className="px-3 pb-3 -mt-5 relative flex flex-col gap-2">
              <div className="flex items-end justify-between gap-2">
                <div className="rounded-full ring-[3px] ring-[var(--color-surface)] shadow-[var(--shadow-sm)]">
                  <Avatar name={user.fullName} size="md" />
                </div>
                <Badge variant="primary" className="mb-0.5">
                  {user.globalRole}
                </Badge>
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-[13px] font-semibold text-[var(--color-text)] truncate leading-snug">
                  {user.fullName}
                </span>
                <span className="text-[11px] font-mono text-[var(--color-text-muted)] truncate">
                  @{user.username}
                </span>
                <span className="text-[11px] text-[var(--color-text-secondary)] truncate mt-0.5">
                  {user.email}
                </span>
              </div>
            </div>
          </div>

          <LayoutGroup id="meofast-profile-sidebar">
            <nav className="flex flex-col gap-0.5">
              {(
                [
                  { id: 'overview', label: 'Overview & Preferences', icon: 'user' },
                  {
                    id: 'collections',
                    label: 'My Collections',
                    icon: 'collection',
                    badge: data?.stats.myCollectionsCount,
                  },
                  { id: 'password', label: 'Password & Security', icon: 'lock' },
                  {
                    id: 'sessions',
                    label: 'Active Sessions',
                    icon: 'shield',
                    badge: sessions.length || data?.stats.activeSessionsCount,
                  },
                  {
                    id: 'tokens',
                    label: 'Personal API Tokens',
                    icon: 'terminal',
                    badge: tokens.length || data?.stats.apiTokensCount,
                  },
                  { id: 'activity', label: 'Activity & Logins', icon: 'clock' },
                ] as const
              ).map((item) => {
                const active = tab === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setTab(item.id)}
                    className={cn(
                      'relative w-full h-8 px-2.5 rounded-[var(--radius-md)] text-left text-xs font-medium flex items-center justify-between gap-2 cursor-pointer transition-colors',
                      active
                        ? 'text-[var(--color-primary)] font-semibold'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]',
                    )}
                  >
                    {active ? (
                      <motion.span
                        layoutId="profile-sidebar-active-pill"
                        transition={{ type: 'spring', stiffness: 500, damping: 36, mass: 0.65 }}
                        className="absolute inset-0 rounded-[var(--radius-md)] bg-[var(--color-primary-subtle)]"
                      />
                    ) : null}
                    <span className="relative z-10 inline-flex items-center gap-2.5 truncate">
                      <Icon name={item.icon} size={14} />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {'badge' in item && typeof item.badge === 'number' && item.badge > 0 ? (
                      <span className="relative z-10">
                        <Badge variant={active ? 'primary' : 'neutral'}>{item.badge}</Badge>
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </nav>
          </LayoutGroup>
        </div>

        <div className="p-3.5 border-t border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col gap-2.5">
          {data?.account.createdAt ? (
            <div className="flex items-center justify-between text-[11px] tabular-nums">
              <span className="text-[var(--color-text-secondary)]">Joined</span>
              <span className="text-[var(--color-text)] font-medium">
                {formatShortTime(data.account.createdAt)}
              </span>
            </div>
          ) : null}
          <Button
            size="sm"
            variant="danger"
            leftIcon={<Icon name="logout" size={13} />}
            onClick={onSignOut}
            className="w-full justify-center"
          >
            Sign Out
          </Button>
        </div>
      </aside>

      {/* Main Full-Width Profile Workspace */}
      <main className="flex-1 min-w-0 w-full overflow-y-auto p-4 sm:p-5 flex flex-col gap-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transitionEnd: { transform: 'none' } }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="w-full flex flex-col gap-4"
          >
            {tab === 'overview' ? (
              <>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <h1 className="text-base font-semibold">Account Overview &amp; Preferences</h1>
                    <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                      Manage your developer identity, workspace memberships, and personal IDE
                      preferences.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Icon name="collection" size={13} />}
                    onClick={() => setTab('collections')}
                  >
                    View My Collections
                  </Button>
                </div>

                {/* KPI Summary Cards */}
                <div className="w-full grid grid-cols-2 lg:grid-cols-4 gap-3 tabular-nums">
                  {[
                    {
                      label: 'My Collections',
                      value: data?.stats.myCollectionsCount ?? 0,
                      sub: `${data?.stats.totalCollectionsCount ?? 0} accessible`,
                    },
                    {
                      label: 'Authored Endpoints',
                      value: data?.stats.myRequestsCount ?? 0,
                      sub: 'Saved API requests',
                    },
                    {
                      label: 'Recent API Runs',
                      value: data?.stats.recentExecutionsCount ?? 0,
                      sub: 'Recorded executions',
                    },
                    {
                      label: 'Active Sessions',
                      value: sessions.length || (data?.stats.activeSessionsCount ?? 1),
                      sub: `${tokens.length || (data?.stats.apiTokensCount ?? 0)} CLI tokens`,
                    },
                  ].map((kpi) => (
                    <Card key={kpi.label} className="p-3.5 flex flex-col gap-1">
                      <span className="text-xs text-[var(--color-text-secondary)]">
                        {kpi.label}
                      </span>
                      <span className="text-lg font-bold font-mono text-[var(--color-text)]">
                        {kpi.value}
                      </span>
                      <span className="text-[11px] text-[var(--color-text-muted)]">{kpi.sub}</span>
                    </Card>
                  ))}
                </div>

                <div className="w-full grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
                  {/* Profile Identity Form */}
                  <Card padding="lg" className="w-full flex flex-col gap-4">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-sm font-semibold">Developer Profile</h2>
                      <Badge variant="primary">{user.globalRole}</Badge>
                    </div>

                    <Input
                      label="Full Name"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      required
                    />
                    <Input
                      label="Username"
                      mono
                      value={username}
                      onChange={(e) => setUsername(e.target.value.toLowerCase())}
                      hint="Lowercase handle used across workspace mentions and audit logs."
                      required
                    />
                    <Input
                      label="Email Address"
                      value={user.email}
                      disabled
                      hint="Verified account email address."
                    />

                    <div>
                      <Button
                        variant="primary"
                        disabled={!fullName.trim() || !username.trim()}
                        isLoading={updateProfileMutation.isPending}
                        leftIcon={<Icon name="save" size={14} />}
                        onClick={() => updateProfileMutation.mutate()}
                      >
                        Save Profile
                      </Button>
                    </div>
                  </Card>

                  {/* IDE Preferences & Workspaces */}
                  <div className="w-full flex flex-col gap-4">
                    <Card padding="lg" className="w-full flex flex-col gap-3.5">
                      <h2 className="text-sm font-semibold">Workspace &amp; Editor Preferences</h2>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Select
                          label="Color Theme"
                          value={theme}
                          onValueChange={(val) => setTheme(val as 'light' | 'dark')}
                          options={[
                            { value: 'light', label: 'Light Mode (Blue Aurora)' },
                            { value: 'dark', label: 'Dark Mode (Midnight Aurora)' },
                          ]}
                        />
                        <Select
                          label="Request / Response Split"
                          value={splitDirection}
                          onValueChange={(val) => {
                            if (val !== splitDirection) toggleSplitDirection()
                          }}
                          options={[
                            { value: 'vertical', label: 'Stacked (Top / Bottom)' },
                            { value: 'horizontal', label: 'Side-by-Side (Left / Right)' },
                          ]}
                        />
                      </div>
                    </Card>

                    <Card padding="md" className="w-full flex flex-col gap-3">
                      <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold">My Workspaces</h2>
                        <Badge variant="neutral">{(data?.workspaces ?? []).length}</Badge>
                      </div>

                      <DataTable<ProfileOverviewResponse['workspaces'][number]>
                        compact
                        defaultPageSize={5}
                        server={{
                          queryKey: ['profile-overview', user.id, 'workspaces'],
                          endpoint: '/api/v1/auth/profile/workspaces',
                          enabled: tab === 'overview',
                        }}
                        getRowKey={(ws) => ws.id}
                        searchPlaceholder="Search workspaces or roles..."
                        emptyMessage="No accessible workspaces."
                        columns={[
                          {
                            id: 'name',
                            header: 'Workspace',
                            sortValue: (ws) => ws.name,
                            cell: (ws) => (
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-[var(--color-text)]">
                                  {ws.name}
                                </span>
                                {ws.id === activeWorkspaceId ? (
                                  <Badge variant="success">Active</Badge>
                                ) : null}
                              </div>
                            ),
                          },
                          {
                            id: 'role',
                            header: 'Role',
                            sortValue: (ws) => ws.role,
                            cell: (ws) => <Badge variant="neutral">{ws.role}</Badge>,
                          },
                          {
                            id: 'actions',
                            header: 'Actions',
                            sortable: false,
                            align: 'right',
                            cell: (ws) => (
                              <DropdownMenu
                                ariaLabel={`Actions for ${ws.name}`}
                                widthClassName="w-48"
                                triggerClassName="w-[30px] h-[30px] justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] text-[var(--color-text-secondary)]"
                                trigger={() => <Icon name="dots-vertical" size={14} />}
                                items={[
                                  {
                                    id: 'rename-ws',
                                    label: 'Rename Workspace',
                                    icon: 'edit',
                                    onSelect: () => {
                                      setRenameTarget({
                                        kind: 'workspace',
                                        id: ws.id,
                                        name: ws.name,
                                      })
                                      setRenameDraft(ws.name)
                                    },
                                  },
                                  {
                                    id: 'open-ws',
                                    label: 'Open Collections',
                                    icon: 'collection',
                                    onSelect: () => {
                                      setActiveWorkspaceId(ws.id)
                                      setSidebarSection('collections')
                                    },
                                  },
                                  {
                                    id: 'open-docs',
                                    label: 'Open API Docs',
                                    icon: 'book',
                                    onSelect: () => {
                                      setActiveWorkspaceId(ws.id)
                                      setSidebarSection('docs')
                                    },
                                  },
                                ]}
                              />
                            ),
                          },
                        ]}
                      />
                    </Card>
                  </div>
                </div>
              </>
            ) : null}

            {tab === 'collections' ? (
              <div className="w-full flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <h1 className="text-base font-semibold">My Collections &amp; Endpoints</h1>
                    <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                      Browse, search, export, or jump directly into any collection and API endpoint
                      in your portfolio.
                    </p>
                  </div>

                  <div className="inline-flex items-center h-[30px] p-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                    {(
                      [
                        { id: 'mine', label: 'Created by Me' },
                        { id: 'all', label: 'All Accessible' },
                      ] as const
                    ).map((sc) => (
                      <button
                        key={sc.id}
                        type="button"
                        onClick={() => setPortfolioScope(sc.id)}
                        className={cn(
                          'h-6 px-2.5 rounded-[var(--radius-sm)] text-xs font-medium cursor-pointer transition-colors',
                          portfolioScope === sc.id
                            ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)]'
                            : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]',
                        )}
                      >
                        {sc.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Collections Table */}
                <Card padding="md" className="w-full flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold">
                      Collections ({filteredCollections.length})
                    </h2>
                  </div>

                  <DataTable<ProfileCollectionItem>
                    server={{
                      queryKey: ['profile-overview', user.id, 'collections'],
                      endpoint: '/api/v1/auth/profile/collections',
                      params: { scope: portfolioScope },
                      enabled: tab === 'collections',
                    }}
                    defaultPageSize={10}
                    getRowKey={(col) => col.id}
                    searchPlaceholder="Search collections or workspaces..."
                    emptyMessage="No matching collections found."
                    columns={[
                      {
                        id: 'name',
                        header: 'Collection Name',
                        sortValue: (col) => col.name,
                        searchValue: (col) => `${col.name} ${col.description}`,
                        cell: (col) => (
                          <div className="flex flex-col gap-0.5">
                            <span className="font-semibold text-[var(--color-text)]">
                              {col.name}
                            </span>
                            {col.description ? (
                              <span className="text-[11px] text-[var(--color-text-muted)] truncate max-w-md">
                                {col.description}
                              </span>
                            ) : null}
                          </div>
                        ),
                      },
                      {
                        id: 'workspace',
                        header: 'Workspace',
                        sortValue: (col) => col.workspaceName,
                        cell: (col) => <Badge variant="neutral">{col.workspaceName}</Badge>,
                      },
                      {
                        id: 'folders',
                        header: 'Folders',
                        sortValue: (col) => col.folderCount,
                        cellClassName: 'font-mono tabular-nums text-[var(--color-text-secondary)]',
                        cell: (col) => col.folderCount,
                      },
                      {
                        id: 'endpoints',
                        header: 'Endpoints',
                        sortValue: (col) => col.requestCount,
                        cellClassName: 'font-mono tabular-nums text-[var(--color-primary)] font-semibold',
                        cell: (col) => col.requestCount,
                      },
                      {
                        id: 'updatedAt',
                        header: 'Last Updated',
                        sortValue: (col) => col.updatedAt,
                        cellClassName: 'text-[var(--color-text-muted)] tabular-nums',
                        cell: (col) => formatShortTime(col.updatedAt),
                      },
                      {
                        id: 'actions',
                        header: 'Actions',
                        sortable: false,
                        align: 'right',
                        cell: (col) => (
                          <DropdownMenu
                            ariaLabel={`Actions for ${col.name}`}
                            widthClassName="w-52"
                            triggerClassName="w-[30px] h-[30px] justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] text-[var(--color-text-secondary)]"
                            trigger={() => <Icon name="dots-vertical" size={14} />}
                            items={[
                              {
                                id: 'rename-col',
                                label: 'Rename Collection',
                                icon: 'edit',
                                onSelect: () => {
                                  setRenameTarget({
                                    kind: 'collection',
                                    id: col.id,
                                    name: col.name,
                                    workspaceId: col.workspaceId,
                                  })
                                  setRenameDraft(col.name)
                                },
                              },
                              {
                                id: 'open-col',
                                label: 'Open in Collections',
                                icon: 'collection',
                                onSelect: () => {
                                  setActiveWorkspaceId(col.workspaceId)
                                  setSidebarSection('collections')
                                },
                              },
                              {
                                id: 'open-docs',
                                label: 'View API Documentation',
                                icon: 'book',
                                onSelect: () => {
                                  setActiveWorkspaceId(col.workspaceId)
                                  setSidebarSection('docs')
                                },
                              },
                              {
                                id: 'export-col',
                                label: 'Export Bundle (.json)',
                                icon: 'download',
                                dividerBefore: true,
                                onSelect: () => {
                                  void handleExportCollectionJson(col)
                                },
                              },
                            ]}
                          />
                        ),
                      },
                    ]}
                  />
                </Card>

                {/* Endpoints Table */}
                <Card padding="md" className="w-full flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold">
                      Saved Endpoints ({filteredRequests.length})
                    </h2>
                  </div>

                  <DataTable<ProfileRequestItem>
                    server={{
                      queryKey: ['profile-overview', user.id, 'requests'],
                      endpoint: '/api/v1/auth/profile/requests',
                      params: { scope: portfolioScope },
                      enabled: tab === 'collections',
                    }}
                    defaultPageSize={10}
                    getRowKey={(req) => req.id}
                    searchPlaceholder="Search endpoints by name, method, URL, collection..."
                    emptyMessage="No matching endpoints found."
                    columns={[
                      {
                        id: 'endpoint',
                        header: 'Endpoint',
                        sortValue: (req) => `${req.method} ${req.name}`,
                        cell: (req) => (
                          <div className="flex items-center gap-2">
                            <MethodBadge method={req.method} compact />
                            <span className="font-semibold text-[var(--color-text)]">
                              {req.name}
                            </span>
                          </div>
                        ),
                      },
                      {
                        id: 'url',
                        header: 'URL',
                        sortValue: (req) => req.url,
                        cellClassName:
                          'font-mono text-[var(--color-text-secondary)] max-w-[300px] truncate',
                        cell: (req) => req.url,
                      },
                      {
                        id: 'collection',
                        header: 'Collection',
                        sortValue: (req) => req.collectionName,
                        cellClassName: 'text-[var(--color-text-secondary)]',
                        cell: (req) => req.collectionName,
                      },
                      {
                        id: 'updatedAt',
                        header: 'Updated',
                        sortValue: (req) => req.updatedAt,
                        cellClassName: 'text-[var(--color-text-muted)] tabular-nums',
                        cell: (req) => formatShortTime(req.updatedAt),
                      },
                      {
                        id: 'actions',
                        header: 'Actions',
                        sortable: false,
                        align: 'right',
                        cell: (req) => (
                          <DropdownMenu
                            ariaLabel={`Actions for ${req.name}`}
                            widthClassName="w-52"
                            triggerClassName="w-[30px] h-[30px] justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] text-[var(--color-text-secondary)]"
                            trigger={() => <Icon name="dots-vertical" size={14} />}
                            items={[
                              {
                                id: 'rename-req',
                                label: 'Rename Endpoint',
                                icon: 'edit',
                                onSelect: () => {
                                  setRenameTarget({
                                    kind: 'request',
                                    id: req.id,
                                    name: req.name,
                                    workspaceId: req.workspaceId,
                                  })
                                  setRenameDraft(req.name)
                                },
                              },
                              {
                                id: 'open-req',
                                label: 'Open in Request Client',
                                icon: 'play',
                                onSelect: () => {
                                  setActiveWorkspaceId(req.workspaceId)
                                  openSavedRequest(req)
                                },
                              },
                              {
                                id: 'copy-url',
                                label: 'Copy Endpoint URL',
                                icon: 'copy',
                                onSelect: () => {
                                  void navigator.clipboard.writeText(req.url)
                                  toast.info('Endpoint URL copied')
                                },
                              },
                            ]}
                          />
                        ),
                      },
                    ]}
                  />
                </Card>
              </div>
            ) : null}

            {tab === 'password' ? (
              <div className="w-full flex flex-col gap-4">
                <div>
                  <h1 className="text-base font-semibold">Password &amp; Account Security</h1>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    Passwords are hashed using RFC 9106 Argon2id. Updating your password
                    automatically revokes other active sessions.
                  </p>
                </div>

                <div className="w-full grid grid-cols-1 xl:grid-cols-[1.15fr_1fr] gap-5 items-start">
                  <Card padding="lg" className="w-full flex flex-col gap-4">
                    <h2 className="text-sm font-semibold">Change Password</h2>

                    <Input
                      label="Current Password"
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="Enter your current password"
                      required
                    />
                    <Input
                      label="New Password"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Enter a strong new password"
                      required
                    />
                    <Input
                      label="Confirm New Password"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter new password"
                      required
                    />

                    <div>
                      <Button
                        variant="primary"
                        disabled={!passwordValidToSubmit}
                        isLoading={changePasswordMutation.isPending}
                        leftIcon={<Icon name="lock" size={14} />}
                        onClick={() => changePasswordMutation.mutate()}
                      >
                        Update Password
                      </Button>
                    </div>
                  </Card>

                  <Card padding="lg" className="w-full flex flex-col gap-3">
                    <h2 className="text-sm font-semibold">Password Policy Checklist</h2>
                    <div className="flex flex-col gap-2">
                      {passwordChecks.map((check) => (
                        <div
                          key={check.label}
                          className="flex items-center gap-2.5 text-xs"
                        >
                          <Icon
                            name={check.ok ? 'check-circle' : 'info'}
                            size={15}
                            className={
                              check.ok
                                ? 'text-[var(--color-success)] shrink-0'
                                : 'text-[var(--color-text-muted)] shrink-0'
                            }
                          />
                          <span
                            className={
                              check.ok
                                ? 'text-[var(--color-text)] font-medium'
                                : 'text-[var(--color-text-secondary)]'
                            }
                          >
                            {check.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              </div>
            ) : null}

            {tab === 'sessions' ? (
              <Card padding="md" className="w-full flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <h1 className="text-base font-semibold">Active Browser &amp; Device Sessions</h1>
                    <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                      Review where your account is currently signed in and revoke unrecognized
                      sessions immediately.
                    </p>
                  </div>

                  {sessions.length > 1 ? (
                    <Button
                      size="sm"
                      variant="danger"
                      isLoading={revokeOtherSessionsMutation.isPending}
                      leftIcon={<Icon name="logout" size={13} />}
                      onClick={() => {
                        void (async () => {
                          const ok = await confirm({
                            title: 'Sign out other devices?',
                            description:
                              'All other active browser sessions will be signed out immediately. Your current session will remain active.',
                            confirmLabel: 'Sign Out Other Devices',
                          })
                          if (ok) revokeOtherSessionsMutation.mutate()
                        })()
                      }}
                    >
                      Sign Out Other Devices
                    </Button>
                  ) : null}
                </div>

                <DataTable<SessionItem>
                  server={{
                    queryKey: ['auth-sessions'],
                    endpoint: '/api/v1/auth/sessions',
                    enabled: tab === 'sessions',
                  }}
                  defaultPageSize={10}
                  getRowKey={(s) => s.id}
                  searchPlaceholder="Search sessions by device, browser, or IP..."
                  emptyMessage="No active sessions found."
                  columns={[
                    {
                      id: 'device',
                      header: 'Device / Browser',
                      sortValue: (s) => summarizeUserAgent(s.userAgent),
                      searchValue: (s) => `${summarizeUserAgent(s.userAgent)} ${s.userAgent ?? ''}`,
                      cell: (s) => (
                        <div className="flex flex-col gap-0.5">
                          <span className="font-semibold text-[var(--color-text)]">
                            {summarizeUserAgent(s.userAgent)}
                          </span>
                          <span className="text-[11px] text-[var(--color-text-muted)] truncate max-w-xs">
                            {s.userAgent || 'Browser'}
                          </span>
                        </div>
                      ),
                    },
                    {
                      id: 'ip',
                      header: 'IP Address',
                      sortValue: (s) => s.ipAddress || '127.0.0.1',
                      cellClassName: 'font-mono tabular-nums text-[var(--color-text-secondary)]',
                      cell: (s) => s.ipAddress || '127.0.0.1',
                    },
                    {
                      id: 'status',
                      header: 'Status',
                      sortValue: (s) => (s.isCurrent ? 'Current Session' : 'Active'),
                      cell: (s) =>
                        s.isCurrent ? (
                          <Badge variant="success">Current Session</Badge>
                        ) : (
                          <Badge variant="neutral">Active</Badge>
                        ),
                    },
                    {
                      id: 'createdAt',
                      header: 'Signed In',
                      sortValue: (s) => s.createdAt,
                      cellClassName: 'text-[var(--color-text-secondary)] tabular-nums',
                      cell: (s) => formatShortTime(s.createdAt),
                    },
                    {
                      id: 'expiresAt',
                      header: 'Expires',
                      sortValue: (s) => s.expiresAt,
                      cellClassName: 'text-[var(--color-text-muted)] tabular-nums',
                      cell: (s) => formatShortTime(s.expiresAt),
                    },
                    {
                      id: 'actions',
                      header: 'Actions',
                      sortable: false,
                      align: 'right',
                      cell: (s) =>
                        !s.isCurrent ? (
                          <DropdownMenu
                            ariaLabel={`Actions for session ${s.ipAddress || 'session'}`}
                            widthClassName="w-44"
                            triggerClassName="w-[30px] h-[30px] justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] text-[var(--color-text-secondary)]"
                            trigger={() => <Icon name="dots-vertical" size={14} />}
                            items={[
                              {
                                id: 'revoke',
                                label: 'Revoke Session',
                                icon: 'trash',
                                variant: 'danger',
                                onSelect: () => {
                                  void (async () => {
                                    const ok = await confirm({
                                      title: 'Revoke session?',
                                      description:
                                        'This browser session will be signed out immediately.',
                                      confirmLabel: 'Revoke Session',
                                    })
                                    if (ok) revokeSessionMutation.mutate(s.id)
                                  })()
                                },
                              },
                            ]}
                          />
                        ) : (
                          <span className="text-[11px] text-[var(--color-text-muted)]">—</span>
                        ),
                    },
                  ]}
                />
              </Card>
            ) : null}

            {tab === 'tokens' ? (
              <Card padding="md" className="w-full flex flex-col gap-4">
                <div>
                  <h1 className="text-base font-semibold">Personal API Tokens (CLI &amp; CI/CD)</h1>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    Generate personal bearer tokens (`mf_pat_...`) to run collections from CI/CD or
                    the Meetofast CLI.
                  </p>
                </div>

                <div className="w-full grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] items-end gap-3">
                  <Input
                    label="Token Name"
                    value={tokenName}
                    onChange={(e) => setTokenName(e.target.value)}
                    placeholder="e.g. GitHub Actions Runner"
                  />
                  <Select
                    label="Expiration"
                    value={tokenExpiryDays}
                    onValueChange={setTokenExpiryDays}
                    options={[
                      { value: '__never__', label: 'No Expiration' },
                      { value: '30', label: '30 Days' },
                      { value: '90', label: '90 Days' },
                      { value: '365', label: '1 Year' },
                    ]}
                  />
                  <Button
                    variant="primary"
                    disabled={!tokenName.trim()}
                    isLoading={createTokenMutation.isPending}
                    leftIcon={<Icon name="plus" size={14} />}
                    onClick={() => createTokenMutation.mutate()}
                  >
                    Generate Token
                  </Button>
                </div>

                {newlyCreatedToken ? (
                  <div className="p-3.5 rounded-[var(--radius-lg)] bg-[var(--color-primary-subtle)] border border-[var(--color-primary)] flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex flex-col gap-1 min-w-0">
                      <span className="text-xs font-semibold text-[var(--color-primary)]">
                        Copy your personal API token now (shown once):
                      </span>
                      <code className="text-xs font-mono break-all select-all">
                        {newlyCreatedToken}
                      </code>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<Icon name={copiedToken ? 'check' : 'copy'} size={13} />}
                      onClick={async () => {
                        await navigator.clipboard.writeText(newlyCreatedToken)
                        setCopiedToken(true)
                        setTimeout(() => setCopiedToken(false), 1500)
                      }}
                    >
                      {copiedToken ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                ) : null}

                <DataTable<{
                  id: string
                  name: string
                  tokenPrefix: string
                  lastUsedAt: string | null
                  expiresAt: string | null
                  createdAt: string
                }>
                  server={{
                    queryKey: ['auth-tokens'],
                    endpoint: '/api/v1/auth/tokens',
                    enabled: tab === 'tokens',
                  }}
                  defaultPageSize={10}
                  getRowKey={(t) => t.id}
                  searchPlaceholder="Search tokens by name or prefix..."
                  emptyMessage="No personal API tokens created yet."
                  columns={[
                    {
                      id: 'name',
                      header: 'Token Name',
                      sortValue: (t) => t.name,
                      cellClassName: 'font-semibold text-[var(--color-text)]',
                      cell: (t) => t.name,
                    },
                    {
                      id: 'prefix',
                      header: 'Prefix',
                      sortValue: (t) => t.tokenPrefix,
                      cellClassName: 'font-mono text-[var(--color-text-secondary)]',
                      cell: (t) => `${t.tokenPrefix}••••••`,
                    },
                    {
                      id: 'lastUsedAt',
                      header: 'Last Used',
                      sortValue: (t) => t.lastUsedAt ?? '',
                      cellClassName: 'text-[var(--color-text-secondary)] tabular-nums',
                      cell: (t) => (t.lastUsedAt ? formatShortTime(t.lastUsedAt) : 'Never'),
                    },
                    {
                      id: 'expiresAt',
                      header: 'Expires',
                      sortValue: (t) => t.expiresAt ?? '',
                      cellClassName: 'text-[var(--color-text-muted)] tabular-nums',
                      cell: (t) => (t.expiresAt ? formatShortTime(t.expiresAt) : 'Never'),
                    },
                    {
                      id: 'actions',
                      header: 'Actions',
                      sortable: false,
                      align: 'right',
                      cell: (t) => (
                        <DropdownMenu
                          ariaLabel={`Actions for ${t.name}`}
                          widthClassName="w-44"
                          triggerClassName="w-[30px] h-[30px] justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] text-[var(--color-text-secondary)]"
                          trigger={() => <Icon name="dots-vertical" size={14} />}
                          items={[
                            {
                              id: 'rename-token',
                              label: 'Rename Token',
                              icon: 'edit',
                              onSelect: () => {
                                setRenameTarget({
                                  kind: 'token',
                                  id: t.id,
                                  name: t.name,
                                })
                                setRenameDraft(t.name)
                              },
                            },
                            {
                              id: 'revoke',
                              label: 'Revoke Token',
                              icon: 'trash',
                              variant: 'danger',
                              dividerBefore: true,
                              onSelect: () => {
                                void (async () => {
                                  const ok = await confirm({
                                    title: 'Revoke API token?',
                                    description: `Token "${t.name}" (${t.tokenPrefix}••••••) will immediately stop working.`,
                                    confirmLabel: 'Revoke Token',
                                  })
                                  if (ok) revokeTokenMutation.mutate(t.id)
                                })()
                              },
                            },
                          ]}
                        />
                      ),
                    },
                  ]}
                />
              </Card>
            ) : null}

            {tab === 'activity' ? (
              <div className="w-full flex flex-col gap-4">
                <div>
                  <h1 className="text-base font-semibold">Recent API Activity &amp; Sign-In Log</h1>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    Your personal API execution history and authentication events.
                  </p>
                </div>

                <Card padding="md" className="w-full flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Recent API Executions</h2>
                  <DataTable<ProfileOverviewResponse['recentHistory'][number]>
                    server={{
                      queryKey: ['profile-overview', user.id, 'history'],
                      endpoint: '/api/v1/auth/profile/history',
                      enabled: tab === 'activity',
                    }}
                    defaultPageSize={10}
                    getRowKey={(h) => h.id}
                    searchPlaceholder="Search method, URL, workspace, status..."
                    emptyMessage="No recent API requests recorded yet."
                    columns={[
                      {
                        id: 'method',
                        header: 'Method',
                        sortValue: (h) => h.method,
                        cell: (h) => <MethodBadge method={h.method} compact />,
                      },
                      {
                        id: 'url',
                        header: 'Target URL',
                        sortValue: (h) => h.url,
                        cellClassName: 'font-mono text-[var(--color-text)] max-w-[320px] truncate',
                        cell: (h) => h.url,
                      },
                      {
                        id: 'workspace',
                        header: 'Workspace',
                        sortValue: (h) => h.workspaceName,
                        cellClassName: 'text-[var(--color-text-secondary)]',
                        cell: (h) => h.workspaceName,
                      },
                      {
                        id: 'status',
                        header: 'Status',
                        sortValue: (h) => h.status ?? -1,
                        cellClassName: 'tabular-nums',
                        cell: (h) => (
                          <Badge
                            variant={
                              h.status && h.status >= 200 && h.status < 300
                                ? 'success'
                                : h.status && h.status >= 400
                                  ? 'danger'
                                  : 'warning'
                            }
                          >
                            {h.status ?? 'ERR'}
                          </Badge>
                        ),
                      },
                      {
                        id: 'durationMs',
                        header: 'Latency',
                        sortValue: (h) => h.durationMs,
                        cellClassName: 'font-mono tabular-nums text-[var(--color-text-secondary)]',
                        cell: (h) => formatDuration(h.durationMs),
                      },
                      {
                        id: 'createdAt',
                        header: 'Time',
                        align: 'right',
                        sortValue: (h) => h.createdAt,
                        cellClassName: 'text-[var(--color-text-muted)] tabular-nums',
                        cell: (h) => formatShortTime(h.createdAt),
                      },
                    ]}
                  />
                </Card>

                <Card padding="md" className="w-full flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Personal Sign-In History</h2>
                  <DataTable<ProfileOverviewResponse['loginHistory'][number]>
                    server={{
                      queryKey: ['profile-overview', user.id, 'logins'],
                      endpoint: '/api/v1/auth/profile/logins',
                      enabled: tab === 'activity',
                    }}
                    defaultPageSize={10}
                    getRowKey={(item) => item.id}
                    searchPlaceholder="Search sign-in status, browser, or IP..."
                    emptyMessage="No sign-in history recorded yet."
                    columns={[
                      {
                        id: 'result',
                        header: 'Result',
                        sortValue: (item) => (item.succeeded ? 'Success' : 'Failed'),
                        cell: (item) => (
                          <Badge variant={item.succeeded ? 'success' : 'danger'}>
                            {item.succeeded ? 'Success' : 'Failed'}
                          </Badge>
                        ),
                      },
                      {
                        id: 'device',
                        header: 'Device / Client',
                        sortValue: (item) => summarizeUserAgent(item.userAgent),
                        cellClassName: 'text-[var(--color-text)]',
                        cell: (item) => summarizeUserAgent(item.userAgent),
                      },
                      {
                        id: 'ip',
                        header: 'IP Address',
                        sortValue: (item) => item.ipAddress || '127.0.0.1',
                        cellClassName: 'font-mono tabular-nums text-[var(--color-text-secondary)]',
                        cell: (item) => item.ipAddress || '127.0.0.1',
                      },
                      {
                        id: 'createdAt',
                        header: 'Timestamp',
                        align: 'right',
                        sortValue: (item) => item.createdAt,
                        cellClassName: 'text-[var(--color-text-muted)] tabular-nums',
                        cell: (item) => formatShortTime(item.createdAt),
                      },
                    ]}
                  />
                </Card>
              </div>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </main>

      <Dialog
        open={Boolean(renameTarget)}
        title={
          renameTarget?.kind === 'workspace'
            ? 'Rename Workspace'
            : renameTarget?.kind === 'collection'
              ? 'Rename Collection'
              : renameTarget?.kind === 'request'
                ? 'Rename Endpoint'
                : 'Rename API Token'
        }
        onClose={() => setRenameTarget(null)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label={
              renameTarget?.kind === 'workspace'
                ? 'Workspace Name'
                : renameTarget?.kind === 'collection'
                  ? 'Collection Name'
                  : renameTarget?.kind === 'request'
                    ? 'Endpoint Name'
                    : 'Token Name'
            }
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                renameDraft.trim() &&
                !renameProfileEntityMutation.isPending
              ) {
                e.preventDefault()
                renameProfileEntityMutation.mutate()
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
              isLoading={renameProfileEntityMutation.isPending}
              onClick={() => renameProfileEntityMutation.mutate()}
            >
              Save Name
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
