'use client'

import {
  buildDefaultRoleMatrix,
  canManageSystem,
  GLOBAL_ROLES,
  type GlobalRole,
  hasPolicyPermission,
  normalizeRolePermissionsMatrix,
  POLICY_ABILITIES,
  type PolicyAbility,
  RBAC_FEATURES,
  type RbacFeatureKey,
  type RbacRoleItem,
  type RolePermissionsMatrix,
} from '@meofast/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { type ChangeEvent, useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  DropdownMenu,
  Icon,
  Input,
  Select,
  Switch,
  useConfirm,
  useToast,
} from '@/components/ui'
import { useWorkbenchStore } from '@/features/client/store/useWorkbenchStore'
import { apiRequest } from '@/lib/api-client'
import { cn, formatShortTime } from '@/utils/cn'
import { WorkspaceSharingSection } from './WorkspaceSharingSection'

interface UserRecord {
  id: string
  email: string
  username: string
  fullName: string
  globalRole: GlobalRole
  status: 'active' | 'deactivated'
  lastLoginAt: string | null
  createdAt: string
}

interface AdminSettingsResponse {
  appName: string
  publicUrl: string
  registrationMode: 'invite_only' | 'open'
  configuredEngine?: string
  networkPolicy: {
    allowPrivateNetworks: boolean
    allowLocalhost: boolean
    allowedCidrs: string[]
    allowedDomains: string[]
  }
}

interface AuditResponse {
  auditTotal?: number
  loginTotal?: number
  auditLogs: Array<{
    id: string
    actorEmail: string | null
    action: string
    targetType: string
    targetId?: string | null
    metadata?: Record<string, unknown>
    ipAddress: string | null
    createdAt: string
  }>
  loginHistory: Array<{
    id: string
    emailAttempted: string
    succeeded: boolean
    failureReason: string | null
    ipAddress: string | null
    createdAt: string
  }>
}

interface PolicyFeatureRow {
  featureKey: RbacFeatureKey
  label: string
  category: string
  description: string
  anyView: boolean
  view: boolean
  create: boolean
  update: boolean
  delete: boolean
}

const ABILITY_COLUMNS: ReadonlyArray<{ key: PolicyAbility; label: string }> = [
  { key: 'anyView', label: 'anyView' },
  { key: 'view', label: 'View' },
  { key: 'create', label: 'Create' },
  { key: 'update', label: 'Update' },
  { key: 'delete', label: 'Delete' },
]

function makeRoleSlugPreview(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

function countMatrixGranted(matrix: RolePermissionsMatrix | null | undefined): number {
  if (!matrix) return 0
  let total = 0
  for (const f of RBAC_FEATURES) {
    const row = matrix[f]
    if (!row) continue
    for (const ab of POLICY_ABILITIES) {
      if (row[ab]) total += 1
    }
  }
  return total
}

const VALID_ADMIN_TABS = [
  'users',
  'roles',
  'workspaces',
  'tokens',
  'ai',
  'security',
  'backup',
  'audit',
  'logins',
] as const
type AdminTabId = (typeof VALID_ADMIN_TABS)[number]

export function AdminPanel({
  currentUserRole,
  currentUserPermissions,
  workspaceId,
  workspaceName = 'Workspace',
}: {
  currentUserRole: GlobalRole
  currentUserPermissions?: RolePermissionsMatrix
  workspaceId: string
  workspaceName?: string
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const isAdmin = canManageSystem(currentUserRole, currentUserPermissions)
  const canViewUsersRbac =
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'users_rbac', 'anyView') ||
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'users_rbac', 'view')
  const canCreateUsersRbac = hasPolicyPermission(
    currentUserPermissions,
    currentUserRole,
    'users_rbac',
    'create',
  )
  const canUpdateUsersRbac = hasPolicyPermission(
    currentUserPermissions,
    currentUserRole,
    'users_rbac',
    'update',
  )
  const canDeleteUsersRbac = hasPolicyPermission(
    currentUserPermissions,
    currentUserRole,
    'users_rbac',
    'delete',
  )
  const canViewSettings =
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'system_settings', 'anyView') ||
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'system_settings', 'view')
  const canViewAudit =
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'audit_logs', 'anyView') ||
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'audit_logs', 'view')
  const canManageBackup =
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'backup', 'view') ||
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'backup', 'create')
  const canViewTokens =
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'tokens', 'anyView') ||
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'tokens', 'view')
  const canViewWorkspaces =
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'workspaces', 'anyView') ||
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'workspaces', 'view') ||
    canViewUsersRbac
  const canManageWorkspaces =
    hasPolicyPermission(currentUserPermissions, currentUserRole, 'workspaces', 'update') ||
    canUpdateUsersRbac
  const { sidebarSubTab, setSidebarSection } = useWorkbenchStore()

  const subParts = (sidebarSubTab ?? '').split('/').filter(Boolean)
  const primarySubTab = subParts[0] ?? null
  const resolvedUrlTab = VALID_ADMIN_TABS.find((t) => t === primarySubTab)
  const defaultAdminTab: AdminTabId = canViewUsersRbac
    ? 'users'
    : canViewSettings
      ? 'security'
      : canViewAudit
        ? 'audit'
        : 'tokens'
  const tab: AdminTabId = resolvedUrlTab ?? defaultAdminTab
  const activePermissionRoleSlug =
    tab === 'roles' && subParts[1] ? decodeURIComponent(subParts[1]) : null
  const setTab = (nextTab: AdminTabId) => {
    setSidebarSection('admin', nextTab)
  }
  const openRolePermissionsPage = (roleSlug: string) => {
    setSidebarSection('admin', `roles/${encodeURIComponent(roleSlug)}/permissions`)
  }

  const [logsMenuExpanded, setLogsMenuExpanded] = useState(
    tab === 'audit' || tab === 'logins',
  )
  const [auditFilter, setAuditFilter] = useState('')
  const [loginFilter, setLoginFilter] = useState('')

  useEffect(() => {
    if (tab === 'audit' || tab === 'logins') {
      setLogsMenuExpanded(true)
    }
  }, [tab])

  // Personal API Tokens state
  const [tokenName, setTokenName] = useState('')
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null)
  const [copiedToken, setCopiedToken] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{
    kind: 'user' | 'token'
    id: string
    name: string
  } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  // Optional BYOK AI state
  const [aiEnabled, setAiEnabled] = useState(false)
  const [aiProvider, setAiProvider] = useState<'openai_compatible' | 'gemini' | 'ollama'>(
    'openai_compatible',
  )
  const [aiBaseUrl, setAiBaseUrl] = useState('https://api.openai.com/v1')
  const [aiModel, setAiModel] = useState('gpt-4o-mini')
  const [aiApiKey, setAiApiKey] = useState('')
  const [aiHasKey, setAiHasKey] = useState(false)
  const [aiSavedMsg, setAiSavedMsg] = useState<string | null>(null)

  // Create user modal
  const [newUserOpen, setNewUserOpen] = useState(false)
  const [uFullName, setUFullName] = useState('')
  const [uEmail, setUEmail] = useState('')
  const [uUsername, setUUsername] = useState('')
  const [uPassword, setUPassword] = useState('')
  const [uRole, setURole] = useState<GlobalRole>('developer')
  const [userModalError, setUserModalError] = useState<string | null>(null)

  // Invitation modal
  const [inviteOpen, setInviteOpen] = useState(false)
  const [invEmail, setInvEmail] = useState('')
  const [invRole, setInvRole] = useState<GlobalRole>('developer')
  const [generatedToken, setGeneratedToken] = useState<string | null>(null)

  // Settings form
  const [sAppName, setSAppName] = useState('Meetofast')
  const [sPublicUrl, setSPublicUrl] = useState('http://localhost:4780')
  const [sRegMode, setSRegMode] = useState<'invite_only' | 'open'>('invite_only')
  const [allowPrivate, setAllowPrivate] = useState(false)
  const [allowLocalhost, setAllowLocalhost] = useState(false)
  const [allowedCidrsText, setAllowedCidrsText] = useState('')
  const [allowedDomainsText, setAllowedDomainsText] = useState('')
  const [settingsSavedMsg, setSettingsSavedMsg] = useState<string | null>(null)

  // Workspace Backup & Restore state
  const [exportingBackup, setExportingBackup] = useState(false)
  const [backupFileName, setBackupFileName] = useState('')
  const [backupPayload, setBackupPayload] = useState<Record<string, unknown> | null>(null)
  const [backupParseError, setBackupParseError] = useState<string | null>(null)
  const [restoredSummary, setRestoredSummary] = useState<Record<string, number> | null>(null)

  // Laravel Policy-Style Custom RBAC Role & Matrix state
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [draftPermissions, setDraftPermissions] = useState<RolePermissionsMatrix | null>(null)
  const [roleModalMode, setRoleModalMode] = useState<'create' | 'edit' | null>(null)
  const [editingRole, setEditingRole] = useState<RbacRoleItem | null>(null)
  const [roleNameDraft, setRoleNameDraft] = useState('')
  const [roleSlugDraft, setRoleSlugDraft] = useState('')
  const [roleSlugTouched, setRoleSlugTouched] = useState(false)
  const [roleDescDraft, setRoleDescDraft] = useState('')
  const [roleTemplateSlug, setRoleTemplateSlug] = useState('developer')
  const [roleModalError, setRoleModalError] = useState<string | null>(null)

  const usersQuery = useQuery({
    queryKey: ['admin-users'],
    enabled: canViewUsersRbac,
    queryFn: () => apiRequest<{ users: UserRecord[] }>('/api/v1/admin/users'),
  })

  const rolesQuery = useQuery({
    queryKey: ['admin-roles'],
    enabled: canViewUsersRbac,
    queryFn: () => apiRequest<{ roles: RbacRoleItem[] }>('/api/v1/admin/roles'),
  })

  const settingsQuery = useQuery({
    queryKey: ['admin-settings'],
    enabled: canViewSettings,
    queryFn: () => apiRequest<AdminSettingsResponse>('/api/v1/admin/settings'),
  })

  const auditQuery = useQuery({
    queryKey: ['admin-audit'],
    enabled: canViewAudit,
    queryFn: () => apiRequest<AuditResponse>('/api/v1/admin/audit-logs?limit=100'),
  })

  const tokensQuery = useQuery({
    queryKey: ['auth-tokens'],
    enabled: tab === 'tokens',
    queryFn: () =>
      apiRequest<{
        tokens: Array<{
          id: string
          name: string
          tokenPrefix: string
          lastUsedAt: string | null
          createdAt: string
        }>
      }>('/api/v1/auth/tokens'),
  })

  const aiConfigQuery = useQuery({
    queryKey: ['admin-ai-config'],
    enabled: canViewSettings && tab === 'ai',
    queryFn: () =>
      apiRequest<{
        enabled: boolean
        provider: 'openai_compatible' | 'gemini' | 'ollama'
        baseUrl: string
        model: string
        hasApiKey: boolean
      }>('/api/v1/admin/ai-config'),
  })

  const allRoles = rolesQuery.data?.roles ?? []

  const roleSelectOptions = useMemo(() => {
    if (allRoles.length > 0) {
      return allRoles.map((r) => ({
        value: r.slug,
        label: `${r.name} (${r.slug})`,
      }))
    }
    return GLOBAL_ROLES.map((r) => ({ value: r, label: r }))
  }, [allRoles])

  const selectedRole = useMemo(() => {
    if (!allRoles.length) return null
    if (activePermissionRoleSlug) {
      const bySlug = allRoles.find(
        (r) => r.slug === activePermissionRoleSlug || r.id === activePermissionRoleSlug,
      )
      if (bySlug) return bySlug
    }
    if (selectedRoleId) {
      const match = allRoles.find((r) => r.id === selectedRoleId)
      if (match) return match
    }
    return allRoles.find((r) => !r.isSystem) ?? allRoles.find((r) => r.slug === 'developer') ?? allRoles[0] ?? null
  }, [activePermissionRoleSlug, allRoles, selectedRoleId])

  useEffect(() => {
    if (selectedRole && selectedRole.id !== selectedRoleId) {
      setSelectedRoleId(selectedRole.id)
    }
  }, [selectedRole, selectedRoleId])

  useEffect(() => {
    if (selectedRole) {
      setDraftPermissions(
        normalizeRolePermissionsMatrix(selectedRole.permissions, selectedRole.slug),
      )
    }
  }, [selectedRole?.id, selectedRole?.updatedAt])

  const hasUnsavedPolicyChanges = useMemo(() => {
    if (!selectedRole || !draftPermissions || selectedRole.isImmutable) return false
    return JSON.stringify(draftPermissions) !== JSON.stringify(selectedRole.permissions)
  }, [draftPermissions, selectedRole])

  const activeDraftGrantedCount = useMemo(
    () =>
      draftPermissions
        ? countMatrixGranted(draftPermissions)
        : (selectedRole?.grantedCount ?? 0),
    [draftPermissions, selectedRole?.grantedCount],
  )

  const openCreateRoleModal = (templateSlug = 'developer', suggestedName = '') => {
    setRoleModalMode('create')
    setEditingRole(null)
    setRoleNameDraft(suggestedName)
    setRoleSlugDraft(suggestedName ? makeRoleSlugPreview(suggestedName) : '')
    setRoleSlugTouched(false)
    setRoleDescDraft('')
    setRoleTemplateSlug(templateSlug)
    setRoleModalError(null)
  }

  const openEditRoleModal = (role: RbacRoleItem) => {
    setRoleModalMode('edit')
    setEditingRole(role)
    setRoleNameDraft(role.name)
    setRoleSlugDraft(role.slug)
    setRoleSlugTouched(true)
    setRoleDescDraft(role.description)
    setRoleModalError(null)
  }

  const toggleFeatureAbility = (featureKey: RbacFeatureKey, ability: PolicyAbility) => {
    if (!selectedRole || selectedRole.isImmutable || !canUpdateUsersRbac) return
    setDraftPermissions((prev) => {
      const base =
        prev ?? normalizeRolePermissionsMatrix(selectedRole.permissions, selectedRole.slug)
      const currentRow = base[featureKey]
      return {
        ...base,
        [featureKey]: {
          ...currentRow,
          [ability]: !currentRow[ability],
        },
      }
    })
  }

  const toggleFullFeatureRow = (featureKey: RbacFeatureKey) => {
    if (!selectedRole || selectedRole.isImmutable || !canUpdateUsersRbac) return
    setDraftPermissions((prev) => {
      const base =
        prev ?? normalizeRolePermissionsMatrix(selectedRole.permissions, selectedRole.slug)
      const currentRow = base[featureKey]
      const allChecked = POLICY_ABILITIES.every((ab) => currentRow[ab])
      const nextVal = !allChecked
      return {
        ...base,
        [featureKey]: {
          anyView: nextVal,
          view: nextVal,
          create: nextVal,
          update: nextVal,
          delete: nextVal,
        },
      }
    })
  }

  const applyPolicyPreset = (preset: 'grant_all' | 'read_only' | 'clear_all') => {
    if (!selectedRole || selectedRole.isImmutable || !canUpdateUsersRbac) return
    if (preset === 'read_only') {
      setDraftPermissions(buildDefaultRoleMatrix('viewer'))
      return
    }
    const val = preset === 'grant_all'
    const nextMatrix = {} as RolePermissionsMatrix
    for (const f of RBAC_FEATURES) {
      nextMatrix[f] = {
        anyView: val,
        view: val,
        create: val,
        update: val,
        delete: val,
      }
    }
    setDraftPermissions(nextMatrix)
  }

  const createRoleMutation = useMutation({
    mutationFn: async () => {
      const finalSlug = roleSlugDraft.trim() || makeRoleSlugPreview(roleNameDraft)
      return apiRequest<{ role: RbacRoleItem }>('/api/v1/admin/roles', {
        method: 'POST',
        body: JSON.stringify({
          name: roleNameDraft.trim(),
          slug: finalSlug,
          description: roleDescDraft.trim(),
          templateRoleSlug: roleTemplateSlug,
        }),
      })
    },
    onSuccess: async (res) => {
      setRoleModalMode(null)
      setSelectedRoleId(res.role.id)
      setDraftPermissions(res.role.permissions)
      toast.success(
        'Custom role created',
        `Role "${res.role.name}" (${res.role.slug}) is ready to customize.`,
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-roles'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-audit'] }),
      ])
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'Failed to create role'
      setRoleModalError(msg)
      toast.error('Failed to create role', msg)
    },
  })

  const updateRoleMetaMutation = useMutation({
    mutationFn: async () => {
      if (!editingRole) throw new Error('No role selected')
      return apiRequest<{ ok: boolean; role: RbacRoleItem }>(
        `/api/v1/admin/roles/${editingRole.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            name: roleNameDraft.trim(),
            description: roleDescDraft.trim(),
          }),
        },
      )
    },
    onSuccess: async (res) => {
      setRoleModalMode(null)
      setEditingRole(null)
      toast.success('Role updated', `Saved details for "${res.role.name}".`)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-roles'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-audit'] }),
      ])
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'Failed to update role'
      setRoleModalError(msg)
      toast.error('Failed to update role', msg)
    },
  })

  const saveRolePoliciesMutation = useMutation({
    mutationFn: async () => {
      if (!selectedRole || !draftPermissions) throw new Error('No role matrix selected')
      return apiRequest<{ ok: boolean; role: RbacRoleItem }>(
        `/api/v1/admin/roles/${selectedRole.id}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            permissions: draftPermissions,
          }),
        },
      )
    },
    onSuccess: async (res) => {
      setDraftPermissions(res.role.permissions)
      toast.success(
        'Feature policies saved',
        `Updated policy matrix for "${res.role.name}" (${res.role.slug}).`,
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-roles'] }),
        queryClient.invalidateQueries({
          queryKey: ['admin-role-policies', res.role.id],
        }),
        queryClient.invalidateQueries({ queryKey: ['admin-audit'] }),
      ])
    },
    onError: (err) => {
      toast.error(
        'Failed to save policies',
        err instanceof Error ? err.message : undefined,
      )
    },
  })

  const deleteRoleMutation = useMutation({
    mutationFn: async (role: { id: string; slug: string }) => {
      await apiRequest(`/api/v1/admin/roles/${role.id}`, { method: 'DELETE' })
      return role
    },
    onSuccess: async (deleted) => {
      if (selectedRoleId === deleted.id) {
        setSelectedRoleId(null)
      }
      if (activePermissionRoleSlug === deleted.slug) {
        setSidebarSection('admin', 'roles')
      }
      toast.danger('Custom role deleted')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-roles'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-audit'] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to delete role', err instanceof Error ? err.message : undefined)
    },
  })

  const handleBackToRolesList = async () => {
    if (hasUnsavedPolicyChanges) {
      const ok = await confirm({
        title: 'Discard unsaved permission changes?',
        description: `Role "${selectedRole?.name ?? ''}" has unsaved policy changes. Leave without saving?`,
        confirmLabel: 'Discard Changes',
        variant: 'warning',
      })
      if (!ok) return
    }
    setSidebarSection('admin', 'roles')
  }

  const promptDeleteRole = (role: RbacRoleItem) => {
    void (async () => {
      const ok = await confirm({
        title: `Delete custom role "${role.name}"?`,
        description:
          role.userCount > 0
            ? `This role currently has ${role.userCount} assigned member(s). Reassign them in Team Members before deleting.`
            : `Permanently delete custom role "${role.name}" (${role.slug}) and its feature policy matrix?`,
        confirmLabel: 'Delete Role',
        variant: 'danger',
      })
      if (ok) {
        deleteRoleMutation.mutate({ id: role.id, slug: role.slug })
      }
    })()
  }

  useEffect(() => {
    if (aiConfigQuery.data) {
      setAiEnabled(aiConfigQuery.data.enabled)
      setAiProvider(aiConfigQuery.data.provider)
      setAiBaseUrl(aiConfigQuery.data.baseUrl)
      setAiModel(aiConfigQuery.data.model)
      setAiHasKey(aiConfigQuery.data.hasApiKey)
    }
  }, [aiConfigQuery.data])

  const createTokenMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{ token: string }>('/api/v1/auth/tokens', {
        method: 'POST',
        body: JSON.stringify({ name: tokenName.trim() }),
      })
    },
    onSuccess: async (res) => {
      setTokenName('')
      setNewlyCreatedToken(res.token)
      toast.success('API token generated', 'Copy your token now — it will only be shown once.')
      await queryClient.invalidateQueries({ queryKey: ['auth-tokens'] })
    },
    onError: (err) => {
      toast.error('Failed to generate token', err instanceof Error ? err.message : undefined)
    },
  })

  const renameAdminEntityMutation = useMutation({
    mutationFn: async () => {
      if (!renameTarget || !renameDraft.trim()) return null
      const nextName = renameDraft.trim()
      if (renameTarget.kind === 'user') {
        await apiRequest(`/api/v1/admin/users/${renameTarget.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ fullName: nextName }),
        })
      } else {
        await apiRequest(`/api/v1/auth/tokens/${renameTarget.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: nextName }),
        })
      }
      return { ...renameTarget, name: nextName }
    },
    onSuccess: async (updated) => {
      setRenameTarget(null)
      setRenameDraft('')
      toast.success(updated?.kind === 'user' ? 'Member renamed' : 'API token renamed')
      if (updated?.kind === 'user') {
        await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-roles'] }),
      ])
      } else {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['auth-tokens'] }),
          queryClient.invalidateQueries({ queryKey: ['profile-overview'] }),
        ])
      }
    },
    onError: (err) => {
      toast.error('Failed to rename', err instanceof Error ? err.message : undefined)
    },
  })

  const revokeTokenMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest(`/api/v1/auth/tokens/${id}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      toast.danger('API token revoked')
      await queryClient.invalidateQueries({ queryKey: ['auth-tokens'] })
    },
    onError: (err) => {
      toast.error('Failed to revoke token', err instanceof Error ? err.message : undefined)
    },
  })

  const saveAiConfigMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{ hasApiKey: boolean }>('/api/v1/admin/ai-config', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: aiEnabled,
          provider: aiProvider,
          baseUrl: aiBaseUrl,
          model: aiModel,
          apiKey: aiApiKey,
          keepExistingApiKey: !aiApiKey && aiHasKey,
        }),
      })
    },
    onSuccess: async (res) => {
      setAiApiKey('')
      setAiHasKey(res.hasApiKey)
      setAiSavedMsg('AI settings saved.')
      toast.success('AI settings saved')
      await queryClient.invalidateQueries({ queryKey: ['admin-ai-config'] })
    },
    onError: (err) => {
      toast.error('Failed to save AI settings', err instanceof Error ? err.message : undefined)
    },
  })

  useEffect(() => {
    if (settingsQuery.data) {
      setSAppName(settingsQuery.data.appName)
      setSPublicUrl(settingsQuery.data.publicUrl)
      setSRegMode(settingsQuery.data.registrationMode)
      setAllowPrivate(settingsQuery.data.networkPolicy.allowPrivateNetworks)
      setAllowLocalhost(settingsQuery.data.networkPolicy.allowLocalhost)
      setAllowedCidrsText(settingsQuery.data.networkPolicy.allowedCidrs.join(', '))
      setAllowedDomainsText(settingsQuery.data.networkPolicy.allowedDomains.join(', '))
    }
  }, [settingsQuery.data])

  const createUserMutation = useMutation({
    mutationFn: async () => {
      await apiRequest('/api/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          fullName: uFullName,
          email: uEmail,
          username: uUsername,
          password: uPassword,
          globalRole: uRole,
        }),
      })
    },
    onSuccess: async () => {
      setNewUserOpen(false)
      setUFullName('')
      setUEmail('')
      setUUsername('')
      setUPassword('')
      setUserModalError(null)
      toast.success('User created')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-roles'] }),
      ])
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'Failed to create user'
      setUserModalError(msg)
      toast.error('Failed to create user', msg)
    },
  })

  const updateUserMutation = useMutation({
    mutationFn: async (input: {
      id: string
      globalRole?: GlobalRole
      status?: 'active' | 'deactivated'
    }) => {
      await apiRequest(`/api/v1/admin/users/${input.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          globalRole: input.globalRole,
          status: input.status,
        }),
      })
    },
    onSuccess: async (_res, vars) => {
      if (vars.status === 'deactivated') {
        toast.warning('User deactivated')
      } else {
        toast.success('User updated')
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-roles'] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to update user', err instanceof Error ? err.message : undefined)
    },
  })

  const createInviteMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{ invitation: { invitationToken: string } }>(
        '/api/v1/admin/invitations',
        {
          method: 'POST',
          body: JSON.stringify({ email: invEmail, role: invRole }),
        },
      )
    },
    onSuccess: (res) => {
      setGeneratedToken(res.invitation.invitationToken)
      toast.success('Invitation token generated')
    },
    onError: (err) => {
      toast.error('Failed to generate invite', err instanceof Error ? err.message : undefined)
    },
  })

  const saveSettingsMutation = useMutation({
    mutationFn: async () => {
      await apiRequest('/api/v1/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          appName: sAppName,
          publicUrl: sPublicUrl,
          registrationMode: sRegMode,
          networkPolicy: {
            allowPrivateNetworks: allowPrivate,
            allowLocalhost,
            allowedCidrs: allowedCidrsText
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            allowedDomains: allowedDomainsText
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          },
        }),
      })
    },
    onSuccess: async () => {
      setSettingsSavedMsg('Administration & SSRF network security policies saved.')
      toast.success('Network & instance settings saved')
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] })
    },
    onError: (err) => {
      toast.error('Failed to save settings', err instanceof Error ? err.message : undefined)
    },
  })

  return (
    <div className="flex-1 min-w-0 w-full flex overflow-hidden">
      {/* Docked Left Sidebar Panel (w-64) — Consistent with Collections, Environments & History */}
      <aside className="w-64 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col justify-between shrink-0 hidden md:flex">
        <div className="flex flex-col">
          <div className="p-2.5 border-b border-[var(--color-border)]">
            <span className="text-xs font-semibold tracking-wide text-[var(--color-text-secondary)] uppercase">
              Administration
            </span>
          </div>

          <LayoutGroup id="meofast-admin-sidebar">
            <nav aria-label="Administration sections" className="p-2.5 flex flex-col gap-1">
              {(
                [
                  ...(canViewUsersRbac
                    ? [
                        {
                          id: 'users' as const,
                          label: 'Team Members',
                          icon: 'users' as const,
                          badge: usersQuery.data?.users.length,
                        },
                        {
                          id: 'roles' as const,
                          label: 'Roles & Policies',
                          icon: 'lock' as const,
                          badge: allRoles.length || undefined,
                        },
                      ]
                    : []),
                  ...(canViewWorkspaces
                    ? [
                        {
                          id: 'workspaces' as const,
                          label: 'Workspaces',
                          icon: 'layers' as const,
                        },
                      ]
                    : []),
                  ...(canViewTokens
                    ? [
                        {
                          id: 'tokens' as const,
                          label: 'API Tokens (CLI / CI)',
                          icon: 'terminal' as const,
                        },
                      ]
                    : []),
                  ...(canViewSettings
                    ? [
                        {
                          id: 'ai' as const,
                          label: 'AI Assistant (Optional)',
                          icon: 'sparkles' as const,
                        },
                        {
                          id: 'security' as const,
                          label: 'Network Policy',
                          icon: 'shield' as const,
                        },
                      ]
                    : []),
                  ...(canManageBackup
                    ? [
                        {
                          id: 'backup' as const,
                          label: 'Backup & Restore',
                          icon: 'database' as const,
                        },
                      ]
                    : []),
                ]
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
                        layoutId="admin-sidebar-active-pill"
                        transition={{ type: 'spring', stiffness: 500, damping: 36, mass: 0.65 }}
                        className="absolute inset-0 rounded-[var(--radius-md)] bg-[var(--color-primary-subtle)]"
                      />
                    ) : null}
                    <span className="relative z-10 inline-flex items-center gap-2.5 truncate">
                      <Icon name={item.icon} size={14} />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {'badge' in item && typeof item.badge === 'number' ? (
                      <span className="relative z-10">
                        <Badge variant={active ? 'primary' : 'neutral'}>{item.badge}</Badge>
                      </span>
                    ) : null}
                  </button>
                )
              })}

              {/* Expandable Audit & Login Logs Sub-Menu */}
              {canViewAudit ? (
                <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  aria-expanded={logsMenuExpanded}
                  onClick={() => {
                    if (!logsMenuExpanded) {
                      setLogsMenuExpanded(true)
                      if (tab !== 'audit' && tab !== 'logins') {
                        setTab('audit')
                      }
                    } else if (tab !== 'audit' && tab !== 'logins') {
                      setTab('audit')
                    } else {
                      setLogsMenuExpanded((prev) => !prev)
                    }
                  }}
                  className={cn(
                    'w-full h-8 px-2.5 rounded-[var(--radius-md)] text-left text-xs font-medium flex items-center justify-between gap-2 cursor-pointer transition-colors',
                    tab === 'audit' || tab === 'logins'
                      ? 'text-[var(--color-text)] font-semibold'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]',
                  )}
                >
                  <span className="inline-flex items-center gap-2.5 truncate">
                    <Icon
                      name="clock"
                      size={14}
                      className={
                        tab === 'audit' || tab === 'logins' ? 'text-[var(--color-primary)]' : ''
                      }
                    />
                    <span className="truncate">Audit &amp; Login Logs</span>
                  </span>
                  <Icon
                    name={logsMenuExpanded ? 'chevron-down' : 'chevron-right'}
                    size={13}
                    className="text-[var(--color-text-muted)] shrink-0"
                  />
                </button>

                <AnimatePresence initial={false}>
                  {logsMenuExpanded ? (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="ml-4 pl-2.5 py-0.5 border-l border-[var(--color-border-strong)] flex flex-col gap-0.5">
                        {(
                          [
                            {
                              id: 'audit',
                              label: 'Audit Trail',
                              count: auditQuery.data?.auditTotal ?? auditQuery.data?.auditLogs.length,
                            },
                            {
                              id: 'logins',
                              label: 'Login History',
                              count: auditQuery.data?.loginTotal ?? auditQuery.data?.loginHistory.length,
                            },
                          ] as const
                        ).map((sub) => {
                          const subActive = tab === sub.id
                          return (
                            <button
                              key={sub.id}
                              type="button"
                              onClick={() => setTab(sub.id)}
                              className={cn(
                                'relative w-full h-7 px-2.5 rounded-[var(--radius-sm)] text-left text-xs font-medium flex items-center justify-between gap-2 cursor-pointer transition-colors',
                                subActive
                                  ? 'text-[var(--color-primary)] font-semibold'
                                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]',
                              )}
                            >
                              {subActive ? (
                                <motion.span
                                  layoutId="admin-sidebar-active-pill"
                                  transition={{
                                    type: 'spring',
                                    stiffness: 500,
                                    damping: 36,
                                    mass: 0.65,
                                  }}
                                  className="absolute inset-0 rounded-[var(--radius-sm)] bg-[var(--color-primary-subtle)]"
                                />
                              ) : null}
                              <span className="relative z-10 truncate">{sub.label}</span>
                              {typeof sub.count === 'number' ? (
                                <span className="relative z-10">
                                  <Badge variant={subActive ? 'primary' : 'neutral'}>
                                    {sub.count}
                                  </Badge>
                                </span>
                              ) : null}
                            </button>
                          )
                        })}
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
              ) : null}
            </nav>
          </LayoutGroup>
        </div>

        <div className="p-3.5 border-t border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col gap-2 text-xs">
          {isAdmin ? (
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--color-text-secondary)]">Database</span>
              <span className="font-mono uppercase font-medium">
                {settingsQuery.data?.configuredEngine || 'Active'}
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--color-text-secondary)]">Role</span>
              <Badge variant="neutral">{currentUserRole}</Badge>
            </div>
          )}
          {isAdmin ? (
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--color-text-secondary)]">Sign-up</span>
              <Badge variant="neutral">
                {sRegMode === 'invite_only' ? 'Invite Only' : 'Open'}
              </Badge>
            </div>
          ) : null}
        </div>
      </aside>

      <main className="flex-1 min-w-0 w-full overflow-y-auto p-4 sm:p-5 flex flex-col gap-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${tab}-${activePermissionRoleSlug ?? 'index'}-${isAdmin}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transitionEnd: { transform: 'none' } }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="w-full flex flex-col gap-4"
          >
            {(tab === 'users' || tab === 'roles') && !canViewUsersRbac ? (
              <Card className="w-full">
                <h1 className="text-base font-semibold">Users &amp; RBAC Policy Access Required</h1>
                <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
                  Your current role (<code className="font-mono">{currentUserRole}</code>) does not
                  grant <code className="font-mono">users_rbac.anyView</code> or{' '}
                  <code className="font-mono">users_rbac.view</code>. Contact an administrator to
                  update your role policy.
                </p>
              </Card>
            ) : (tab === 'security' || tab === 'ai') && !canViewSettings ? (
              <Card className="w-full">
                <h1 className="text-base font-semibold">System Settings Policy Required</h1>
                <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
                  Your current role (<code className="font-mono">{currentUserRole}</code>) does not
                  grant <code className="font-mono">system_settings.view</code>.
                </p>
              </Card>
            ) : (tab === 'audit' || tab === 'logins') && !canViewAudit ? (
              <Card className="w-full">
                <h1 className="text-base font-semibold">Audit Log Policy Required</h1>
                <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
                  Your current role (<code className="font-mono">{currentUserRole}</code>) does not
                  grant <code className="font-mono">audit_logs.anyView</code> or{' '}
                  <code className="font-mono">audit_logs.view</code>.
                </p>
              </Card>
            ) : tab === 'backup' && !canManageBackup ? (
              <Card className="w-full">
                <h1 className="text-base font-semibold">Backup Policy Required</h1>
                <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
                  Your current role (<code className="font-mono">{currentUserRole}</code>) does not
                  grant <code className="font-mono">backup.view</code>.
                </p>
              </Card>
            ) : tab === 'workspaces' ? (
              canViewWorkspaces ? (
                <WorkspaceSharingSection canManageWorkspaces={canManageWorkspaces} />
              ) : (
                <Card className="w-full">
                  <h1 className="text-base font-semibold">Workspaces Policy Required</h1>
                  <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
                    Your current role (<code className="font-mono">{currentUserRole}</code>) does
                    not grant <code className="font-mono">workspaces.view</code>.
                  </p>
                </Card>
              )
            ) : tab === 'users' ? (
          <Card padding="md" className="w-full flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h1 className="text-base font-semibold">Team Members</h1>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  Manage members, assign custom RBAC roles, and generate invitations.
                </p>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={<Icon name="lock" size={13} />}
                  onClick={() => setTab('roles')}
                >
                  Roles &amp; Policies
                </Button>
                {canCreateUsersRbac ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<Icon name="key" size={13} />}
                      onClick={() => {
                        setGeneratedToken(null)
                        setInviteOpen(true)
                      }}
                    >
                      Invite Token
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      leftIcon={<Icon name="plus" size={13} />}
                      onClick={() => setNewUserOpen(true)}
                    >
                      Create User
                    </Button>
                  </>
                ) : null}
              </div>
            </div>

            <DataTable<UserRecord>
              server={{
                queryKey: ['admin-users'],
                endpoint: '/api/v1/admin/users',
                enabled: canViewUsersRbac && tab === 'users',
              }}
              defaultPageSize={10}
              getRowKey={(u) => u.id}
              searchPlaceholder="Search members by name, email, username, role..."
              emptyMessage="No team members found."
              columns={[
                {
                  id: 'user',
                  header: 'User',
                  sortValue: (u) => u.fullName,
                  searchValue: (u) => `${u.fullName} ${u.email} ${u.username}`,
                  cell: (u) => (
                    <div>
                      <div className="font-semibold text-[var(--color-text)]">{u.fullName}</div>
                      <div className="text-[var(--color-text-secondary)] font-mono">
                        {u.email} (@{u.username})
                      </div>
                    </div>
                  ),
                },
                {
                  id: 'role',
                  header: 'Global Role',
                  sortValue: (u) => u.globalRole,
                  cellClassName: 'w-[240px]',
                  cell: (u) => {
                    const hasOption = roleSelectOptions.some((o) => o.value === u.globalRole)
                    const opts = hasOption
                      ? roleSelectOptions
                      : [...roleSelectOptions, { value: u.globalRole, label: u.globalRole }]
                    return (
                      <Select
                        size="sm"
                        ariaLabel={`Role for ${u.email}`}
                        disabled={!canUpdateUsersRbac}
                        value={u.globalRole}
                        onValueChange={(val) => {
                          if (val === u.globalRole) return
                          void (async () => {
                            const ok = await confirm({
                              title: 'Change user role?',
                              description: `Change global role for ${u.fullName} (@${u.username}) to "${val}"?`,
                              confirmLabel: 'Update Role',
                              variant: 'warning',
                            })
                            if (ok) {
                              updateUserMutation.mutate({
                                id: u.id,
                                globalRole: val as GlobalRole,
                              })
                            }
                          })()
                        }}
                        options={opts}
                      />
                    )
                  },
                },
                {
                  id: 'status',
                  header: 'Status',
                  sortValue: (u) => u.status,
                  cell: (u) => (
                    <Badge variant={u.status === 'active' ? 'success' : 'danger'}>
                      {u.status}
                    </Badge>
                  ),
                },
                {
                  id: 'lastLogin',
                  header: 'Last Login',
                  sortValue: (u) => u.lastLoginAt ?? '',
                  cellClassName: 'text-[var(--color-text-secondary)] tabular-nums',
                  cell: (u) => formatShortTime(u.lastLoginAt),
                },
                {
                  id: 'actions',
                  header: 'Actions',
                  sortable: false,
                  align: 'right',
                  cell: (u) => (
                    <DropdownMenu
                      ariaLabel={`Actions for ${u.fullName}`}
                      widthClassName="w-44"
                      triggerClassName="w-[30px] h-[30px] justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] text-[var(--color-text-secondary)]"
                      trigger={() => <Icon name="dots-vertical" size={14} />}
                      items={[
                        ...(canUpdateUsersRbac
                          ? [
                              {
                                id: 'rename-user',
                                label: 'Rename Member',
                                icon: 'edit' as const,
                                onSelect: () => {
                                  setRenameTarget({ kind: 'user', id: u.id, name: u.fullName })
                                  setRenameDraft(u.fullName)
                                },
                              },
                            ]
                          : []),
                        {
                          id: 'role-permissions',
                          label: 'Role Permissions',
                          icon: 'shield',
                          onSelect: () => openRolePermissionsPage(u.globalRole),
                        },
                        {
                          id: 'copy-email',
                          label: 'Copy Email',
                          icon: 'copy',
                          onSelect: () => {
                            void navigator.clipboard.writeText(u.email)
                            toast.info('Email copied', u.email)
                          },
                        },
                        ...(canUpdateUsersRbac
                          ? [
                              {
                                id: 'toggle-status',
                                label: u.status === 'active' ? 'Deactivate User' : 'Reactivate User',
                                icon: (u.status === 'active' ? 'x' : 'check') as 'x' | 'check',
                                variant: (u.status === 'active' ? 'danger' : 'default') as
                                  | 'danger'
                                  | 'default',
                                dividerBefore: true,
                                onSelect: () => {
                                  void (async () => {
                                    const deactivating = u.status === 'active'
                                    const ok = await confirm({
                                      title: deactivating ? 'Deactivate user?' : 'Reactivate user?',
                                      description: deactivating
                                        ? `User "${u.fullName}" will immediately lose access to Meetofast.`
                                        : `Restore workspace access for "${u.fullName}"?`,
                                      confirmLabel: deactivating
                                        ? 'Deactivate User'
                                        : 'Reactivate User',
                                      variant: deactivating ? 'danger' : 'info',
                                    })
                                    if (ok) {
                                      updateUserMutation.mutate({
                                        id: u.id,
                                        status: deactivating ? 'deactivated' : 'active',
                                      })
                                    }
                                  })()
                                },
                              },
                            ]
                          : []),
                      ]}
                    />
                  ),
                },
              ]}
            />
          </Card>
        ) : tab === 'roles' ? (
          activePermissionRoleSlug ? (
            /* Dedicated Role Permission Matrix Page (/admin/roles/:slug/permissions) */
            <div className="w-full flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
                  <span>Roles &amp; Policies</span>
                  <Icon name="chevron-right" size={12} className="text-[var(--color-text-muted)]" />
                  <span className="font-semibold text-[var(--color-text)]">
                    {selectedRole?.name ?? activePermissionRoleSlug}
                  </span>
                  <Icon name="chevron-right" size={12} className="text-[var(--color-text-muted)]" />
                  <span className="text-[var(--color-primary)] font-medium">Permissions</span>
                </div>

                <div className="flex items-center gap-2">
                  {selectedRole && !selectedRole.isImmutable && canUpdateUsersRbac ? (
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<Icon name="edit" size={12} />}
                      onClick={() => openEditRoleModal(selectedRole)}
                    >
                      Edit Role
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    leftIcon={<Icon name="chevron-left" size={13} />}
                    onClick={() => {
                      void handleBackToRolesList()
                    }}
                  >
                    Back to Roles
                  </Button>
                </div>
              </div>

              {rolesQuery.isLoading ? (
                <Card padding="md" className="w-full py-10 text-center text-xs text-[var(--color-text-muted)]">
                  Loading role permissions...
                </Card>
              ) : !selectedRole ||
                (selectedRole.slug !== activePermissionRoleSlug &&
                  selectedRole.id !== activePermissionRoleSlug) ? (
                <Card padding="md" className="w-full flex flex-col items-start gap-3">
                  <div>
                    <h1 className="text-base font-semibold">Role Not Found</h1>
                    <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                      No RBAC role matched{' '}
                      <code className="font-mono">{activePermissionRoleSlug}</code>.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setSidebarSection('admin', 'roles')}
                  >
                    Return to Roles List
                  </Button>
                </Card>
              ) : (
                <Card padding="md" className="w-full flex flex-col gap-4">
                  <div className="flex items-start justify-between gap-4 flex-wrap pb-3 border-b border-[var(--color-border)]">
                    <div className="flex flex-col gap-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h1 className="text-base font-semibold text-[var(--color-text)]">
                          {selectedRole.name} — Feature Permissions
                        </h1>
                        <code className="px-2 py-0.5 rounded bg-[var(--color-surface-secondary)] border border-[var(--color-border)] font-mono text-[11px] text-[var(--color-text-secondary)]">
                          {selectedRole.slug}
                        </code>
                        <Badge variant={selectedRole.isSystem ? 'neutral' : 'primary'}>
                          {selectedRole.isSystem ? 'System' : 'Custom'}
                        </Badge>
                        <Badge variant="info">
                          <span className="tabular-nums">
                            {activeDraftGrantedCount} / {selectedRole.totalAbilities}
                          </span>{' '}
                          Granted
                        </Badge>
                        {selectedRole.isImmutable ? (
                          <Badge variant="primary">Root Full Access (Immutable)</Badge>
                        ) : hasUnsavedPolicyChanges ? (
                          <Badge variant="warning">Unsaved Changes</Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-[var(--color-text-secondary)]">
                        {selectedRole.description ||
                          'Configure Laravel-style per-feature policy abilities (anyView, View, Create, Update, Delete).'}
                      </p>
                    </div>

                    {!selectedRole.isImmutable && canUpdateUsersRbac ? (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => applyPolicyPreset('grant_all')}
                        >
                          Grant All
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => applyPolicyPreset('read_only')}
                        >
                          Read-Only
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => applyPolicyPreset('clear_all')}
                        >
                          Clear All
                        </Button>
                        {hasUnsavedPolicyChanges ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setDraftPermissions(
                                normalizeRolePermissionsMatrix(
                                  selectedRole.permissions,
                                  selectedRole.slug,
                                ),
                              )
                            }
                          >
                            Reset
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={!hasUnsavedPolicyChanges}
                          isLoading={saveRolePoliciesMutation.isPending}
                          leftIcon={<Icon name="save" size={13} />}
                          onClick={() => saveRolePoliciesMutation.mutate()}
                        >
                          Save Policy Matrix
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  <DataTable<PolicyFeatureRow>
                    server={{
                      queryKey: ['admin-role-policies', selectedRole.id],
                      endpoint: `/api/v1/admin/roles/${selectedRole.id}/policies`,
                      enabled:
                        Boolean(selectedRole.id) &&
                        canViewUsersRbac &&
                        tab === 'roles' &&
                        Boolean(activePermissionRoleSlug),
                    }}
                    defaultPageSize={25}
                    getRowKey={(row) => row.featureKey}
                    searchPlaceholder="Search feature, module category, or policy description..."
                    emptyMessage="No features matched your search."
                    columns={[
                      {
                        id: 'feature',
                        header: 'Feature',
                        sortValue: (row) => row.label,
                        cell: (row) => (
                          <div className="min-w-0 py-0.5">
                            <span className="font-semibold text-[var(--color-text)] block text-[13px]">
                              {row.label}
                            </span>
                            <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5 leading-snug">
                              {row.description}
                            </p>
                          </div>
                        ),
                      },
                      {
                        id: 'category',
                        header: 'Module & Key',
                        sortValue: (row) => `${row.category} ${row.featureKey}`,
                        headerClassName: 'min-w-[260px] whitespace-nowrap',
                        cellClassName: 'min-w-[260px] whitespace-nowrap',
                        cell: (row) => {
                          const rowPerms = draftPermissions?.[row.featureKey] ?? {
                            anyView: row.anyView,
                            view: row.view,
                            create: row.create,
                            update: row.update,
                            delete: row.delete,
                          }
                          const allRowEnabled = POLICY_ABILITIES.every((ab) => rowPerms[ab])
                          return (
                            <div className="flex items-center justify-between gap-2.5">
                              <div className="flex flex-col gap-1 min-w-0">
                                <Badge variant="neutral" className="w-fit">
                                  {row.category}
                                </Badge>
                                <code className="text-[10px] font-mono text-[var(--color-text-muted)]">
                                  {row.featureKey}
                                </code>
                              </div>
                              {!selectedRole.isImmutable && canUpdateUsersRbac ? (
                                <button
                                  type="button"
                                  onClick={() => toggleFullFeatureRow(row.featureKey)}
                                  className={cn(
                                    'h-6 px-2 rounded-[var(--radius-sm)] border text-[11px] font-medium shrink-0 cursor-pointer transition-colors',
                                    allRowEnabled
                                      ? 'border-[var(--color-primary)] bg-[var(--color-primary-subtle)] text-[var(--color-primary)]'
                                      : 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]',
                                  )}
                                >
                                  {allRowEnabled ? 'All On' : 'Toggle All'}
                                </button>
                              ) : null}
                            </div>
                          )
                        },
                      },
                      ...ABILITY_COLUMNS.map((abilityCol) => ({
                        id: abilityCol.key,
                        header: abilityCol.label,
                        align: 'center' as const,
                        headerClassName: 'w-[100px]',
                        cellClassName: 'w-[100px]',
                        sortValue: (row: PolicyFeatureRow) =>
                          (draftPermissions?.[row.featureKey]?.[abilityCol.key] ??
                          row[abilityCol.key])
                            ? 1
                            : 0,
                        cell: (row: PolicyFeatureRow) => {
                          const checked =
                            draftPermissions?.[row.featureKey]?.[abilityCol.key] ??
                            row[abilityCol.key]
                          const locked = selectedRole.isImmutable || !canUpdateUsersRbac
                          return (
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              aria-label={`${abilityCol.label} for ${row.label}`}
                              disabled={locked}
                              onClick={() => toggleFeatureAbility(row.featureKey, abilityCol.key)}
                              className={cn(
                                'w-5 h-5 rounded-[6px] border inline-flex items-center justify-center transition-all',
                                checked
                                  ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white shadow-[var(--shadow-xs)]'
                                  : 'bg-[var(--color-surface)] border-[var(--color-border-strong)] text-transparent hover:border-[var(--color-primary)]',
                                locked ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
                              )}
                            >
                              <Icon name="check" size={12} />
                            </button>
                          )
                        },
                      })),
                    ]}
                  />
                </Card>
              )}
            </div>
          ) : (
            /* Default Roles Table Page (/admin/roles) */
            <Card padding="md" className="w-full flex flex-col gap-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <h1 className="text-base font-semibold">Roles &amp; Policies</h1>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    Manage system and custom RBAC roles. Click <strong>Permission</strong> on any
                    role to configure its feature policy matrix.
                  </p>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    leftIcon={<Icon name="users" size={13} />}
                    onClick={() => setTab('users')}
                  >
                    Team Members
                  </Button>
                  {canCreateUsersRbac ? (
                    <Button
                      size="sm"
                      variant="primary"
                      leftIcon={<Icon name="plus" size={13} />}
                      onClick={() => openCreateRoleModal('developer')}
                    >
                      Create Role
                    </Button>
                  ) : null}
                </div>
              </div>

              <DataTable<RbacRoleItem>
                server={{
                  queryKey: ['admin-roles'],
                  endpoint: '/api/v1/admin/roles',
                  enabled: canViewUsersRbac && tab === 'roles' && !activePermissionRoleSlug,
                }}
                defaultPageSize={10}
                getRowKey={(r) => r.id}
                searchPlaceholder="Search roles by name, slug, or description..."
                emptyMessage="No RBAC roles found."
                columns={[
                  {
                    id: 'name',
                    header: 'Role',
                    sortValue: (r) => r.name,
                    cell: (r) => (
                      <div>
                        <div className="font-semibold text-[var(--color-text)]">{r.name}</div>
                        <div className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">
                          {r.description || 'Custom RBAC role'}
                        </div>
                      </div>
                    ),
                  },
                  {
                    id: 'slug',
                    header: 'Slug',
                    sortValue: (r) => r.slug,
                    cell: (r) => (
                      <code className="px-2 py-0.5 rounded bg-[var(--color-surface-secondary)] border border-[var(--color-border)] font-mono text-[11px] text-[var(--color-text-secondary)]">
                        {r.slug}
                      </code>
                    ),
                  },
                  {
                    id: 'type',
                    header: 'Type',
                    sortValue: (r) => (r.isSystem ? 'System' : 'Custom'),
                    cell: (r) => (
                      <Badge variant={r.isSystem ? 'neutral' : 'primary'}>
                        {r.isSystem ? 'System' : 'Custom'}
                      </Badge>
                    ),
                  },
                  {
                    id: 'users',
                    header: 'Members',
                    sortValue: (r) => r.userCount,
                    cellClassName: 'tabular-nums text-[var(--color-text-secondary)]',
                    cell: (r) => r.userCount,
                  },
                  {
                    id: 'granted',
                    header: 'Permissions',
                    sortValue: (r) => r.grantedCount,
                    cellClassName: 'tabular-nums',
                    cell: (r) => (
                      <Badge variant="info">
                        {r.grantedCount} / {r.totalAbilities}
                      </Badge>
                    ),
                  },
                  {
                    id: 'actions',
                    header: 'Actions',
                    sortable: false,
                    align: 'right',
                    cell: (r) => (
                      <DropdownMenu
                        ariaLabel={`Actions for ${r.name}`}
                        widthClassName="w-48"
                        triggerClassName="w-[30px] h-[30px] justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] text-[var(--color-text-secondary)]"
                        trigger={() => <Icon name="dots-vertical" size={14} />}
                        items={[
                          {
                            id: 'permissions',
                            label: 'Configure Permissions',
                            icon: 'shield',
                            onSelect: () => openRolePermissionsPage(r.slug),
                          },
                          ...(!r.isImmutable && canUpdateUsersRbac
                            ? [
                                {
                                  id: 'edit-role',
                                  label: 'Edit Role',
                                  icon: 'edit' as const,
                                  onSelect: () => openEditRoleModal(r),
                                },
                              ]
                            : []),
                          ...(!r.isSystem && canDeleteUsersRbac
                            ? [
                                {
                                  id: 'delete-role',
                                  label: 'Delete Role',
                                  icon: 'trash' as const,
                                  variant: 'danger' as const,
                                  onSelect: () => promptDeleteRole(r),
                                },
                              ]
                            : []),
                        ]}
                      />
                    ),
                  },
                ]}
              />
            </Card>
          )
        ) : null}

        {tab === 'security' ? (
          <div className="w-full flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-base font-semibold">General &amp; Network Access</h1>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  Configure workspace identity, sign-up access, and internal network permissions.
                </p>
              </div>
              <Button
                isLoading={saveSettingsMutation.isPending}
                leftIcon={<Icon name="save" size={14} />}
                onClick={() => saveSettingsMutation.mutate()}
              >
                Save Changes
              </Button>
            </div>

            {settingsSavedMsg ? (
              <div className="p-3.5 rounded-[var(--radius-lg)] bg-[var(--color-success-subtle)] border border-[var(--color-success-border)] text-xs font-medium text-[var(--color-success)]">
                {settingsSavedMsg}
              </div>
            ) : null}

            <div className="w-full grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
              <Card padding="lg" className="w-full flex flex-col gap-4">
                <h2 className="text-base font-semibold">Instance Identity &amp; Access</h2>
                <Input
                  label="Application Name"
                  value={sAppName}
                  onChange={(e) => setSAppName(e.target.value)}
                />
                <Input
                  label="Public Application URL"
                  value={sPublicUrl}
                  mono
                  onChange={(e) => setSPublicUrl(e.target.value)}
                  hint="Base origin used for invitations and HTTPS cookie policies."
                />
                <Select
                  label="User Registration Mode"
                  value={sRegMode}
                  onValueChange={(val) => setSRegMode(val as 'invite_only' | 'open')}
                  options={[
                    { value: 'invite_only', label: 'Invite Only (Recommended)' },
                    { value: 'open', label: 'Open Self-Registration' },
                  ]}
                />
              </Card>

              <Card padding="lg" className="w-full flex flex-col gap-4">
                <h2 className="text-base font-semibold">Company Internal Network Authorization</h2>
                <Switch
                  checked={allowPrivate}
                  onChange={setAllowPrivate}
                  label="Allow Private RFC1918 Networks (10/8, 172.16/12, 192.168/16)"
                  description="Enable when self-hosting inside a corporate VPC to test internal microservices."
                />
                <Switch
                  checked={allowLocalhost}
                  onChange={setAllowLocalhost}
                  label="Allow Localhost / Loopback Targets (127.0.0.1, ::1)"
                  description="Enable on local development machines to test services bound to localhost."
                />
                <Input
                  label="Authorized Private CIDRs (Comma-separated)"
                  value={allowedCidrsText}
                  onChange={(e) => setAllowedCidrsText(e.target.value)}
                  placeholder="10.24.0.0/16, 192.168.10.0/24"
                  mono
                  hint="Granular alternative to allowing all private RFC1918 subnets."
                />
                <Input
                  label="Authorized Internal Domains (Comma-separated)"
                  value={allowedDomainsText}
                  onChange={(e) => setAllowedDomainsText(e.target.value)}
                  placeholder="*.corp.internal, api.staging.lan"
                  mono
                />
              </Card>
            </div>
          </div>
        ) : null}

        {tab === 'tokens' ? (
          <Card padding="md" className="w-full flex flex-col gap-4">
            <div>
              <h1 className="text-base font-semibold">Personal API Tokens</h1>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                Authenticate CI/CD pipelines and the Meetofast CLI runner.
              </p>
            </div>

            <div className="w-full flex items-end gap-2.5">
              <div className="flex-1">
                <Input
                  label="Token Name"
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                  placeholder="GitHub Actions CI"
                />
              </div>
              <Button
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
                    Copy your new token now (shown once):
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

            <div className="p-3 rounded-[var(--radius-lg)] bg-[var(--color-background)] border border-[var(--color-border)] text-xs font-mono text-[var(--color-text-secondary)]">
              npx meofast run --server {sPublicUrl} --token mf_pat_... --collection &lt;id&gt; --report-junit junit.xml
            </div>

            <DataTable<{
              id: string
              name: string
              tokenPrefix: string
              lastUsedAt: string | null
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
              emptyMessage="No active API tokens."
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
                  header: 'Token Prefix',
                  sortValue: (t) => t.tokenPrefix,
                  cellClassName: 'font-mono text-[var(--color-text-secondary)]',
                  cell: (t) => `${t.tokenPrefix}••••••`,
                },
                {
                  id: 'lastUsed',
                  header: 'Last Used',
                  sortValue: (t) => t.lastUsedAt ?? '',
                  cellClassName: 'text-[var(--color-text-secondary)] tabular-nums',
                  cell: (t) => (t.lastUsedAt ? formatShortTime(t.lastUsedAt) : 'Never'),
                },
                {
                  id: 'created',
                  header: 'Created',
                  sortValue: (t) => t.createdAt,
                  cellClassName: 'text-[var(--color-text-muted)] tabular-nums',
                  cell: (t) => formatShortTime(t.createdAt),
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
                            setRenameTarget({ kind: 'token', id: t.id, name: t.name })
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
                                description: `This action cannot be undone. Any CLI or CI/CD pipeline using "${t.name}" (${t.tokenPrefix}••••••) will immediately lose access.`,
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

        {tab === 'ai' ? (
          <Card padding="md" className="w-full flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 flex-wrap pb-3.5 border-b border-[var(--color-border)]">
              <div>
                <h1 className="text-base font-semibold">Optional AI Assistant (BYOK)</h1>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  Connect your own OpenAI-compatible, Gemini, or local Ollama endpoint. Disabled by
                  default.
                </p>
              </div>
              <Button
                isLoading={saveAiConfigMutation.isPending}
                leftIcon={<Icon name="save" size={14} />}
                onClick={() => saveAiConfigMutation.mutate()}
              >
                Save AI Settings
              </Button>
            </div>

            {aiSavedMsg ? (
              <div>
                <Badge variant="success">{aiSavedMsg}</Badge>
              </div>
            ) : null}

            <Switch
              checked={aiEnabled}
              onChange={setAiEnabled}
              label="Enable Custom AI Provider"
              description="When disabled, Auto-Generate Tests uses the built-in local response analyzer with zero external calls."
            />

            <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-3.5">
              <Select
                label="Provider"
                value={aiProvider}
                onValueChange={(v) =>
                  setAiProvider(v as 'openai_compatible' | 'gemini' | 'ollama')
                }
                options={[
                  { value: 'openai_compatible', label: 'OpenAI-Compatible API' },
                  { value: 'ollama', label: 'Local Ollama (http://localhost:11434/v1)' },
                  { value: 'gemini', label: 'Gemini OpenAI Endpoint' },
                ]}
              />
              <Input
                label="Model"
                mono
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
                placeholder="gpt-4o-mini"
              />
              <Input
                label="Base URL"
                mono
                value={aiBaseUrl}
                onChange={(e) => setAiBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
              <Input
                label="API Key"
                type="password"
                mono
                value={aiApiKey}
                onChange={(e) => setAiApiKey(e.target.value)}
                placeholder={aiHasKey ? '•••••••• (Saved — type to replace)' : 'sk-...'}
              />
            </div>
          </Card>
        ) : null}

        {tab === 'audit' ? (
          <Card padding="md" className="w-full flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-base font-semibold">Audit Trail</h1>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  System, security, and workspace activity events recorded across this instance.
                </p>
              </div>
              <Button
                size="sm"
                variant="primary"
                isLoading={auditQuery.isFetching}
                leftIcon={<Icon name="refresh" size={12} />}
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: ['admin-audit'] })
                }}
              >
                Refresh
              </Button>
            </div>

            <DataTable<AuditResponse['auditLogs'][number]>
              server={{
                queryKey: ['admin-audit'],
                endpoint: '/api/v1/admin/audit-events',
                enabled: canViewAudit && tab === 'audit',
              }}
              defaultPageSize={10}
              getRowKey={(log) => log.id}
              searchQuery={auditFilter}
              onSearchQueryChange={setAuditFilter}
              searchPlaceholder="Filter action, target, actor, IP..."
              emptyMessage="No audit events recorded yet."
              columns={[
                {
                  id: 'action',
                  header: 'Action',
                  sortValue: (log) => log.action,
                  cell: (log) => (
                    <code className="px-2 py-0.5 rounded bg-[var(--color-primary-subtle)] text-[var(--color-primary)] border border-[var(--color-border-strong)] font-mono font-semibold text-[11px]">
                      {log.action}
                    </code>
                  ),
                },
                {
                  id: 'target',
                  header: 'Target Resource',
                  sortValue: (log) => `${log.targetType} ${log.targetId ?? ''}`,
                  cell: (log) => (
                    <div className="flex items-center gap-2">
                      <Badge variant="neutral">{log.targetType}</Badge>
                      {log.targetId ? (
                        <span className="font-mono text-[11px] text-[var(--color-text-muted)] truncate max-w-[180px]">
                          {log.targetId}
                        </span>
                      ) : null}
                    </div>
                  ),
                },
                {
                  id: 'actor',
                  header: 'Actor',
                  sortValue: (log) => log.actorEmail || 'system',
                  cellClassName: 'font-mono text-[var(--color-text)]',
                  cell: (log) => log.actorEmail || 'system',
                },
                {
                  id: 'ip',
                  header: 'IP Address',
                  sortValue: (log) => log.ipAddress || 'local',
                  cellClassName: 'font-mono text-[var(--color-text-secondary)] tabular-nums',
                  cell: (log) => log.ipAddress || 'local',
                },
                {
                  id: 'createdAt',
                  header: 'Timestamp',
                  align: 'right',
                  sortValue: (log) => log.createdAt,
                  cellClassName: 'text-[var(--color-text-muted)] tabular-nums whitespace-nowrap',
                  cell: (log) => formatShortTime(log.createdAt),
                },
              ]}
            />
          </Card>
        ) : null}

        {tab === 'logins' ? (
          <Card padding="md" className="w-full flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-base font-semibold">Login History</h1>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  Authentication attempts, session origins, and failure diagnostics.
                </p>
              </div>
              <Button
                size="sm"
                variant="primary"
                isLoading={auditQuery.isFetching}
                leftIcon={<Icon name="refresh" size={12} />}
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: ['admin-audit'] })
                }}
              >
                Refresh
              </Button>
            </div>

            <DataTable<AuditResponse['loginHistory'][number]>
              server={{
                queryKey: ['admin-audit'],
                endpoint: '/api/v1/admin/login-events',
                enabled: canViewAudit && tab === 'logins',
              }}
              defaultPageSize={10}
              getRowKey={(item) => item.id}
              searchQuery={loginFilter}
              onSearchQueryChange={setLoginFilter}
              searchPlaceholder="Filter email, status, reason, IP..."
              emptyMessage="No login attempts recorded yet."
              columns={[
                {
                  id: 'email',
                  header: 'Account / Email',
                  sortValue: (item) => item.emailAttempted,
                  cellClassName: 'font-mono font-medium text-[var(--color-text)]',
                  cell: (item) => item.emailAttempted,
                },
                {
                  id: 'status',
                  header: 'Status',
                  sortValue: (item) => (item.succeeded ? 'Success' : 'Failed'),
                  cell: (item) => (
                    <Badge variant={item.succeeded ? 'success' : 'danger'}>
                      {item.succeeded ? 'Success' : 'Failed'}
                    </Badge>
                  ),
                },
                {
                  id: 'details',
                  header: 'Diagnostic Details',
                  sortValue: (item) =>
                    item.succeeded
                      ? 'Session authenticated'
                      : item.failureReason || 'Invalid credentials',
                  cellClassName: 'text-[var(--color-text-secondary)]',
                  cell: (item) =>
                    item.succeeded
                      ? 'Session authenticated'
                      : item.failureReason || 'Invalid credentials',
                },
                {
                  id: 'ip',
                  header: 'IP Address',
                  sortValue: (item) => item.ipAddress || '127.0.0.1',
                  cellClassName: 'font-mono text-[var(--color-text-secondary)] tabular-nums',
                  cell: (item) => item.ipAddress || '127.0.0.1',
                },
                {
                  id: 'createdAt',
                  header: 'Timestamp',
                  align: 'right',
                  sortValue: (item) => item.createdAt,
                  cellClassName: 'text-[var(--color-text-muted)] tabular-nums whitespace-nowrap',
                  cell: (item) => formatShortTime(item.createdAt),
                },
              ]}
            />
          </Card>
        ) : null}

        {tab === 'backup' ? (
          <div className="w-full flex flex-col gap-4">
            <div>
              <h1 className="text-base font-semibold">Workspace Backup &amp; Restore</h1>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                Export or restore a complete Git-friendly snapshot of{' '}
                <strong className="text-[var(--color-text)]">{workspaceName}</strong> (Collections,
                Folders, Requests, Vars, Examples, Environments, Mock Routes, Webhooks &amp;
                Monitors).
              </p>
            </div>

            <div className="w-full grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
              <Card padding="lg" className="w-full flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-semibold text-[var(--color-text)]">
                      Export Workspace Bundle
                    </h2>
                    <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                      Downloads a portable <code className="font-mono">.meofast-backup.json</code>{' '}
                      bundle. Encrypted secret values are automatically omitted from plaintext
                      export so vault credentials remain protected.
                    </p>
                  </div>
                  <Badge variant="info">v1 Bundle</Badge>
                </div>

                <div className="p-3 rounded-[var(--radius-md)] bg-[var(--color-background)] border border-[var(--color-border)] flex flex-wrap gap-1.5">
                  {[
                    'Collections & Folders',
                    'Inherited Auth & Headers',
                    'Endpoints & Vars',
                    'Response Examples',
                    'Environments',
                    'Mock Routes',
                    'Webhooks',
                    'Monitors',
                  ].map((item) => (
                    <Badge key={item} variant="neutral">
                      {item}
                    </Badge>
                  ))}
                </div>

                <div>
                  <Button
                    variant="primary"
                    isLoading={exportingBackup}
                    disabled={!workspaceId}
                    leftIcon={<Icon name="download" size={14} />}
                    onClick={() => {
                      void (async () => {
                        if (!workspaceId) return
                        setExportingBackup(true)
                        try {
                          const data = await apiRequest<Record<string, unknown>>(
                            `/api/v1/workspaces/${workspaceId}/backup`,
                          )
                          const slug = workspaceName
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, '-')
                            .replace(/^-+|-+$/g, '')
                          const datePart = new Date().toISOString().slice(0, 10)
                          const blob = new Blob([JSON.stringify(data, null, 2)], {
                            type: 'application/json',
                          })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = `${slug || 'workspace'}-${datePart}.meofast-backup.json`
                          a.click()
                          URL.revokeObjectURL(url)
                          toast.success(
                            'Workspace backup exported',
                            `Saved ${slug || 'workspace'}-${datePart}.meofast-backup.json`,
                          )
                        } catch (err) {
                          toast.error(
                            'Failed to export backup',
                            err instanceof Error ? err.message : undefined,
                          )
                        } finally {
                          setExportingBackup(false)
                        }
                      })()
                    }}
                  >
                    Export Workspace Backup
                  </Button>
                </div>
              </Card>

              <Card padding="lg" className="w-full flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <h2 className="text-sm font-semibold text-[var(--color-text)]">
                    Restore from Backup Bundle
                  </h2>
                  <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                    Imports resources from a <code className="font-mono">.meofast-backup.json</code>{' '}
                    file into <strong className="text-[var(--color-text)]">{workspaceName}</strong>{' '}
                    with newly generated IDs so existing items are never overwritten.
                  </p>
                </div>

                <div className="flex items-center justify-between gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background)] flex-wrap">
                  <div className="flex flex-col gap-0.5 text-xs min-w-0">
                    <span className="font-medium text-[var(--color-text)] truncate">
                      {backupFileName || 'No backup file selected'}
                    </span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      Supports meofast.workspace-backup.v1 (.json)
                    </span>
                  </div>
                  <label className="h-[30px] px-3 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer shrink-0 transition-colors">
                    <Icon name="upload" size={13} />
                    <span>Select Backup File</span>
                    <input
                      type="file"
                      accept=".json"
                      className="hidden"
                      onChange={(e: ChangeEvent<HTMLInputElement>) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        setBackupFileName(file.name)
                        setBackupParseError(null)
                        setRestoredSummary(null)
                        void file.text().then((raw) => {
                          try {
                            const parsed = JSON.parse(raw) as Record<string, unknown>
                            if (parsed.format !== 'meofast.workspace-backup.v1') {
                              setBackupPayload(null)
                              setBackupParseError(
                                'Invalid file format: expected "meofast.workspace-backup.v1".',
                              )
                              return
                            }
                            setBackupPayload(parsed)
                          } catch {
                            setBackupPayload(null)
                            setBackupParseError('Selected file is not valid JSON.')
                          }
                        })
                      }}
                    />
                  </label>
                </div>

                {backupParseError ? (
                  <p role="alert" className="text-xs text-[var(--color-danger)]">
                    {backupParseError}
                  </p>
                ) : null}

                {backupPayload ? (
                  <div className="p-3 rounded-[var(--radius-md)] bg-[var(--color-surface-secondary)] border border-[var(--color-border)] flex flex-wrap gap-2 text-xs tabular-nums">
                    <Badge variant="primary">
                      Collections:{' '}
                      {Array.isArray(backupPayload.collections)
                        ? backupPayload.collections.length
                        : 0}
                    </Badge>
                    <Badge variant="neutral">
                      Requests:{' '}
                      {Array.isArray(backupPayload.requests) ? backupPayload.requests.length : 0}
                    </Badge>
                    <Badge variant="neutral">
                      Examples:{' '}
                      {Array.isArray(backupPayload.examples) ? backupPayload.examples.length : 0}
                    </Badge>
                    <Badge variant="neutral">
                      Environments:{' '}
                      {Array.isArray(backupPayload.environments)
                        ? backupPayload.environments.length
                        : 0}
                    </Badge>
                    <Badge variant="neutral">
                      Mocks:{' '}
                      {Array.isArray(backupPayload.mockRoutes)
                        ? backupPayload.mockRoutes.length
                        : 0}
                    </Badge>
                    <Badge variant="neutral">
                      Monitors:{' '}
                      {Array.isArray(backupPayload.monitors) ? backupPayload.monitors.length : 0}
                    </Badge>
                  </div>
                ) : null}

                <div>
                  <Button
                    variant="primary"
                    disabled={!backupPayload || !workspaceId}
                    leftIcon={<Icon name="upload" size={14} />}
                    onClick={() => {
                      void (async () => {
                        if (!backupPayload || !workspaceId) return
                        const ok = await confirm({
                          title: 'Restore workspace backup?',
                          description: `Import all collections, requests, environments, mocks, webhooks, and monitors from "${backupFileName}" into "${workspaceName}"?`,
                          confirmLabel: 'Restore Snapshot',
                          variant: 'warning',
                        })
                        if (!ok) return
                        try {
                          const res = await apiRequest<{
                            ok: boolean
                            restored: Record<string, number>
                          }>(`/api/v1/workspaces/${workspaceId}/restore`, {
                            method: 'POST',
                            body: JSON.stringify(backupPayload),
                          })
                          setRestoredSummary(res.restored)
                          toast.success(
                            'Workspace backup restored',
                            `Imported ${res.restored.collections ?? 0} collections and ${res.restored.requests ?? 0} requests.`,
                          )
                          await Promise.all([
                            queryClient.invalidateQueries({
                              queryKey: ['workspace-tree', workspaceId],
                            }),
                            queryClient.invalidateQueries({
                              queryKey: ['environments', workspaceId],
                            }),
                            queryClient.invalidateQueries({ queryKey: ['mocks', workspaceId] }),
                            queryClient.invalidateQueries({ queryKey: ['webhooks', workspaceId] }),
                            queryClient.invalidateQueries({ queryKey: ['monitors', workspaceId] }),
                            queryClient.invalidateQueries({ queryKey: ['admin-audit'] }),
                          ])
                        } catch (err) {
                          toast.error(
                            'Restore failed',
                            err instanceof Error ? err.message : undefined,
                          )
                        }
                      })()
                    }}
                  >
                    Restore into Workspace
                  </Button>
                </div>

                {restoredSummary ? (
                  <div className="p-3 rounded-[var(--radius-md)] bg-[var(--color-success-subtle)] border border-[var(--color-success-border)] text-xs font-medium text-[var(--color-success)] tabular-nums">
                    Restored {restoredSummary.collections ?? 0} collections,{' '}
                    {restoredSummary.requests ?? 0} requests, {restoredSummary.examples ?? 0}{' '}
                    examples, {restoredSummary.environments ?? 0} environments, and{' '}
                    {restoredSummary.mockRoutes ?? 0} mock routes.
                  </div>
                ) : null}
              </Card>
            </div>
          </div>
        ) : null}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Create User Modal */}
      <Dialog
        open={newUserOpen}
        title="Add Member"
        onClose={() => setNewUserOpen(false)}
      >
        <div className="flex flex-col gap-3.5">
          {userModalError ? (
            <p role="alert" className="text-xs text-[var(--color-danger)]">
              {userModalError}
            </p>
          ) : null}
          <Input
            label="Full Name"
            value={uFullName}
            onChange={(e) => setUFullName(e.target.value)}
            required
          />
          <Input
            label="Email Address"
            type="email"
            value={uEmail}
            onChange={(e) => setUEmail(e.target.value)}
            required
          />
          <Input
            label="Username"
            value={uUsername}
            mono
            onChange={(e) => setUUsername(e.target.value.toLowerCase())}
            required
          />
          <Input
            label="Initial Password"
            type="password"
            value={uPassword}
            onChange={(e) => setUPassword(e.target.value)}
            hint="10+ chars with uppercase, lowercase, number, and symbol."
            required
          />
          <Select
            label="Global Role"
            value={uRole}
            onValueChange={(val) => setURole(val as GlobalRole)}
            options={roleSelectOptions}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setNewUserOpen(false)}>
              Cancel
            </Button>
            <Button
              isLoading={createUserMutation.isPending}
              onClick={() => createUserMutation.mutate()}
            >
              Create User
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Invite Modal */}
      <Dialog
        open={inviteOpen}
        title="Generate Invitation Token"
        description="Share this single-use token so a teammate can register at /login."
        onClose={() => setInviteOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Invitee Email"
            type="email"
            value={invEmail}
            onChange={(e) => setInvEmail(e.target.value)}
            placeholder="engineer@company.com"
          />
          <Select
            label="Assigned Role"
            value={invRole}
            onValueChange={(val) => setInvRole(val as GlobalRole)}
            options={roleSelectOptions}
          />
          {generatedToken ? (
            <div className="p-3 rounded-[var(--radius-lg)] bg-[var(--color-primary-subtle)] border border-[var(--color-border-strong)] flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-[var(--color-primary)]">
                Invitation Token Generated:
              </span>
              <code className="text-xs font-mono break-all select-all">{generatedToken}</code>
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              Close
            </Button>
            <Button
              disabled={!invEmail.trim()}
              isLoading={createInviteMutation.isPending}
              onClick={() => createInviteMutation.mutate()}
            >
              Generate Token
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(renameTarget)}
        title={renameTarget?.kind === 'user' ? 'Rename Team Member' : 'Rename API Token'}
        onClose={() => setRenameTarget(null)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label={renameTarget?.kind === 'user' ? 'Full Name' : 'Token Name'}
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                renameDraft.trim() &&
                !renameAdminEntityMutation.isPending
              ) {
                e.preventDefault()
                renameAdminEntityMutation.mutate()
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
              isLoading={renameAdminEntityMutation.isPending}
              onClick={() => renameAdminEntityMutation.mutate()}
            >
              Save Name
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Create / Edit Custom RBAC Role Modal */}
      <Dialog
        open={Boolean(roleModalMode)}
        title={roleModalMode === 'edit' ? 'Edit Role Details' : 'Create Custom RBAC Role'}
        description={
          roleModalMode === 'edit'
            ? 'Update the display name and description for this role.'
            : 'Create a custom role and customize its Laravel-style feature policy matrix.'
        }
        onClose={() => setRoleModalMode(null)}
      >
        <div className="flex flex-col gap-3.5">
          {roleModalError ? (
            <p role="alert" className="text-xs text-[var(--color-danger)]">
              {roleModalError}
            </p>
          ) : null}

          <Input
            label="Role Name"
            placeholder="QA Engineer"
            value={roleNameDraft}
            onChange={(e) => {
              const nextName = e.target.value
              setRoleNameDraft(nextName)
              if (roleModalMode === 'create' && !roleSlugTouched) {
                setRoleSlugDraft(makeRoleSlugPreview(nextName))
              }
            }}
            required
          />

          <Input
            label="Role Slug (Policy Identifier)"
            placeholder="qa_engineer"
            mono
            disabled={roleModalMode === 'edit'}
            value={roleSlugDraft}
            onChange={(e) => {
              setRoleSlugTouched(true)
              setRoleSlugDraft(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
            }}
            hint={
              roleModalMode === 'edit'
                ? 'Role slug is permanent once created.'
                : 'Lowercase letters, numbers, underscores, or hyphens (2–40 chars).'
            }
            required
          />

          {roleModalMode === 'create' ? (
            <Select
              label="Copy Initial Policies From"
              value={roleTemplateSlug}
              onValueChange={setRoleTemplateSlug}
              options={[
                ...allRoles.map((r) => ({
                  value: r.slug,
                  label: `${r.name} (${r.slug})`,
                })),
                { value: '__blank__', label: 'Blank Matrix (No Permissions Granted)' },
              ]}
            />
          ) : null}

          <Input
            label="Description"
            placeholder="Can create and run API tests and mocks without deleting production resources."
            value={roleDescDraft}
            onChange={(e) => setRoleDescDraft(e.target.value)}
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setRoleModalMode(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!roleNameDraft.trim()}
              isLoading={createRoleMutation.isPending || updateRoleMetaMutation.isPending}
              onClick={() => {
                if (roleModalMode === 'edit') {
                  updateRoleMetaMutation.mutate()
                } else {
                  createRoleMutation.mutate()
                }
              }}
            >
              {roleModalMode === 'edit' ? 'Save Role' : 'Create Role'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
