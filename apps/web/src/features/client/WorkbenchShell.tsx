'use client'

import {
  type AssertionEvaluationResult,
  type ExecuteRequestResponse,
  type GlobalRole,
  type GraphqlPayloadConfig,
  HTTP_METHODS,
  hasPolicyPermission,
  type HttpMethod,
  type KeyValueItem,
  type RbacFeatureKey,
  REQUEST_PROTOCOLS,
  type RequestAssertion,
  type RequestAuthConfig,
  type RequestBodyConfig,
  type RequestProtocol,
  type ResponseVariableExtractor,
  type RolePermissionsMatrix,
  type SetupStatusResponse,
} from '@meofast/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { usePathname, useRouter } from 'next/navigation'
import {
  type ChangeEvent,
  type DragEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Avatar,
  Badge,
  Button,
  CodeEditor,
  Dialog,
  DropdownMenu,
  Icon,
  Input,
  MeofastLogo,
  MethodBadge,
  renderMethodOption,
  renderMethodTrigger,
  Select,
  Spinner,
  useConfirm,
  useToast,
} from '@/components/ui'
import { AdminPanel } from '@/features/admin/AdminPanel'
import { ProfilePanel } from '@/features/auth/ProfilePanel'
import { CookieJarModal } from '@/features/client/components/CookieJarModal'
import { NotificationBell } from '@/features/client/components/NotificationBell'
import { RequestPane } from '@/features/client/components/RequestPane'
import { ResponsePane } from '@/features/client/components/ResponsePane'
import {
  type SidebarSection,
  useWorkbenchStore,
} from '@/features/client/store/useWorkbenchStore'
import { CollectionRunnerModal } from '@/features/collections/CollectionRunnerModal'
import {
  CollectionSettingsModal,
  type SettingsTargetEntity,
} from '@/features/collections/CollectionSettingsModal'
import { DocsPanel } from '@/features/docs/DocsPanel'
import { EnvironmentsPanel } from '@/features/environments/EnvironmentsPanel'
import { MocksPanel } from '@/features/mocks/MocksPanel'
import { MonitorsLoadPanel } from '@/features/monitors/MonitorsLoadPanel'
import { WebhooksPanel } from '@/features/webhooks/WebhooksPanel'
import { ApiClientError, apiRequest, setActiveCsrfToken } from '@/lib/api-client'
import { useTheme } from '@/providers/ThemeProvider'
import { cn, formatDuration, formatShortTime } from '@/utils/cn'

interface AuthMeResponse {
  user: {
    id: string
    email: string
    username: string
    fullName: string
    globalRole: GlobalRole
    permissions?: RolePermissionsMatrix
  }
  csrfToken: string
  appName: string
  workspaces: Array<{
    id: string
    name: string
    slug: string
    description: string
    visibility: 'team' | 'private'
  }>
}

interface FolderNode {
  id: string
  collectionId: string
  parentFolderId: string | null
  name: string
  description?: string
  variables?: KeyValueItem[]
  auth?: RequestAuthConfig
  headers?: KeyValueItem[]
}

interface SavedRequestNode {
  id: string
  workspaceId: string
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
  preRequestScript: string
  testScript: string
  jsonSchema: string
  sortOrder: number
}

interface CollectionNode {
  id: string
  workspaceId: string
  name: string
  description: string
  variables: KeyValueItem[]
  auth?: RequestAuthConfig
  headers?: KeyValueItem[]
  folders: FolderNode[]
  requests: SavedRequestNode[]
}

interface WorkspaceTreeResponse {
  collections: CollectionNode[]
}

interface WorkspaceSearchResultItem {
  kind: 'request' | 'collection' | 'mock' | 'environment' | 'webhook' | 'monitor' | 'capsule'
  id: string
  title: string
  subtitle: string
  badge: string
  method?: HttpMethod
  request?: SavedRequestNode
}

const PRIMARY_NAV_ITEMS = [
  { id: 'collections', label: 'Collections', icon: 'collection' },
  { id: 'docs', label: 'API Docs', icon: 'book' },
  { id: 'mocks', label: 'Mock Server', icon: 'server' },
  { id: 'webhooks', label: 'Webhooks', icon: 'webhook' },
  { id: 'monitors', label: 'Load Test & Monitors', icon: 'activity' },
  { id: 'environments', label: 'Environments', icon: 'layers' },
  { id: 'history', label: 'History & Capsules', icon: 'clock' },
  { id: 'profile', label: 'My Profile', icon: 'user' },
  { id: 'admin', label: 'Settings', icon: 'settings' },
] as const

const stageMotionVariants = {
  enter: (dir: number) => ({
    opacity: 0,
    y: dir * 14,
  }),
  center: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.22,
      ease: [0.16, 1, 0.3, 1] as const,
    },
    transitionEnd: {
      transform: 'none',
    },
  },
  exit: (dir: number) => ({
    opacity: 0,
    y: dir * -10,
    transition: {
      duration: 0.12,
      ease: [0.4, 0, 1, 1] as const,
    },
  }),
}

const explorerMotionVariants = {
  enter: (dir: number) => ({
    opacity: 0,
    y: dir * 10,
  }),
  center: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.18,
      ease: [0.16, 1, 0.3, 1] as const,
    },
    transitionEnd: {
      transform: 'none',
    },
  },
  exit: (dir: number) => ({
    opacity: 0,
    y: dir * -8,
    transition: {
      duration: 0.1,
      ease: [0.4, 0, 1, 1] as const,
    },
  }),
}

export function WorkbenchShell() {
  const router = useRouter()
  const pathname = usePathname()
  const queryClient = useQueryClient()
  const { theme, toggleTheme } = useTheme()
  const toast = useToast()
  const confirm = useConfirm()

  const {
    activeWorkspaceId,
    activeEnvironmentId,
    initializedEnvWsIds,
    sidebarSection,
    sidebarSubTab,
    tabs,
    activeTabId,
    setActiveTab,
    setActiveWorkspaceId,
    setActiveEnvironmentId,
    markEnvInitializedForWorkspace,
    setSidebarSection,
    syncRouteFromPathname,
    openSavedRequest,
    addBlankTab,
    openCapturedRun,
    closeTabsMatching,
    updateTabById,
    appendConsoleLogs,
  } = useWorkbenchStore()

  const activeTab = useMemo(
    () => tabs.find((t) => t.tabId === activeTabId) ?? tabs[0]!,
    [tabs, activeTabId],
  )

  const abortControllersByTabRef = useRef<Map<string, AbortController>>(new Map())
  const justSavedRequestIdsRef = useRef<Set<string>>(new Set())
  const [bootstrapping, setBootstrapping] = useState(true)
  const [sessionData, setSessionData] = useState<AuthMeResponse | null>(null)
  const [treeFilter, setTreeFilter] = useState('')

  const canViewFeature = (feature: RbacFeatureKey): boolean => {
    if (!sessionData) return false
    return (
      hasPolicyPermission(
        sessionData.user.permissions,
        sessionData.user.globalRole,
        feature,
        'anyView',
      ) ||
      hasPolicyPermission(
        sessionData.user.permissions,
        sessionData.user.globalRole,
        feature,
        'view',
      )
    )
  }

  const canCreateWorkspace = Boolean(
    sessionData &&
      hasPolicyPermission(
        sessionData.user.permissions,
        sessionData.user.globalRole,
        'workspaces',
        'create',
      ),
  )
  const canUpdateWorkspace = Boolean(
    sessionData &&
      hasPolicyPermission(
        sessionData.user.permissions,
        sessionData.user.globalRole,
        'workspaces',
        'update',
      ),
  )
  const canAccessAdminSettings =
    canViewFeature('users_rbac') ||
    canViewFeature('tokens') ||
    canViewFeature('system_settings') ||
    canViewFeature('backup') ||
    canViewFeature('audit_logs')

  const canAccessSection = (section: SidebarSection): boolean => {
    if (!sessionData) return false
    switch (section) {
      case 'collections':
        return canViewFeature('collections') || canViewFeature('requests')
      case 'docs':
        return canViewFeature('docs')
      case 'mocks':
        return canViewFeature('mocks')
      case 'webhooks':
        return canViewFeature('webhooks')
      case 'monitors':
        return canViewFeature('monitors')
      case 'environments':
        return canViewFeature('environments')
      case 'history':
        return canViewFeature('history')
      case 'admin':
        return canAccessAdminSettings
      case 'profile':
        return true
    }
  }

  const visiblePrimaryNavItems = PRIMARY_NAV_ITEMS.filter((nav) =>
    canAccessSection(nav.id as SidebarSection),
  )

  useEffect(() => {
    if (!sessionData || bootstrapping) return
    if (!canAccessSection(sidebarSection)) {
      const fallback = (visiblePrimaryNavItems[0]?.id ?? 'profile') as SidebarSection
      setSidebarSection(fallback)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionData, bootstrapping, sidebarSection])

  // Sidebar width resize & primary rail motion state
  const [sidebarWidth, setSidebarWidth] = useState(256)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [hoveredNavId, setHoveredNavId] = useState<SidebarSection | '__logo__' | null>(null)
  const currentNavIndex = PRIMARY_NAV_ITEMS.findIndex((item) => item.id === sidebarSection)
  const prevNavIndexRef = useRef(currentNavIndex >= 0 ? currentNavIndex : 0)
  const navDirectionRef = useRef<1 | -1>(1)
  if (currentNavIndex !== -1 && currentNavIndex !== prevNavIndexRef.current) {
    navDirectionRef.current = currentNavIndex > prevNavIndexRef.current ? 1 : -1
    prevNavIndexRef.current = currentNavIndex
  }
  const navDirection = navDirectionRef.current
  const activeStageKey =
    sidebarSection === 'collections' || sidebarSection === 'history'
      ? 'workbench'
      : sidebarSection

  // Tree collapse & drag-drop state
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const [draggingRequestId, setDraggingRequestId] = useState<string | null>(null)
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null)

  // Modals
  const [cookieJarOpen, setCookieJarOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [debouncedPaletteQuery, setDebouncedPaletteQuery] = useState('')
  const [paletteActiveIdx, setPaletteActiveIdx] = useState(0)
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false)
  const [wsName, setWsName] = useState('')
  const [wsDesc, setWsDesc] = useState('')

  const [newCollectionOpen, setNewCollectionOpen] = useState(false)
  const [colName, setColName] = useState('')

  const [newFolderTarget, setNewFolderTarget] = useState<{
    collectionId: string
    parentFolderId: string | null
  } | null>(null)
  const [folderName, setFolderName] = useState('')

  const [newRequestTarget, setNewRequestTarget] = useState<{
    collectionId: string
    collectionName: string
    folderId: string | null
    folderName?: string
  } | null>(null)
  const [newReqProtocol, setNewReqProtocol] = useState<RequestProtocol>('http')
  const [newReqMethod, setNewReqMethod] = useState<HttpMethod>('GET')
  const [newReqName, setNewReqName] = useState('')
  const [newReqUrl, setNewReqUrl] = useState('')

  const [renameTarget, setRenameTarget] = useState<
    | { kind: 'workspace'; id: string; name: string }
    | { kind: 'request'; request: SavedRequestNode }
    | { kind: 'folder'; id: string; name: string }
    | { kind: 'collection'; id: string; name: string }
    | { kind: 'capsule'; id: string; name: string }
    | null
  >(null)
  const [renameNameDraft, setRenameNameDraft] = useState('')

  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [saveReqName, setSaveReqName] = useState('')
  const [saveTargetColId, setSaveTargetColId] = useState('')
  const [saveTargetFolderId, setSaveTargetFolderId] = useState<string>('__root__')

  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importMode, setImportMode] = useState<
    'curl' | 'openapi' | 'json' | 'insomnia' | 'har' | 'bruno'
  >('curl')
  const [importText, setImportText] = useState('')

  const [exportTargetCol, setExportTargetCol] = useState<CollectionNode | null>(null)
  const [exportFormat, setExportFormat] = useState<
    'openapi' | 'postman' | 'insomnia' | 'har' | 'bruno' | 'native' | 'html'
  >('openapi')
  const historySubMode: 'history' | 'capsules' =
    sidebarSection === 'history' && sidebarSubTab === 'capsules' ? 'capsules' : 'history'

  const [runnerTarget, setRunnerTarget] = useState<{
    collection: CollectionNode
    folderId: string | null
  } | null>(null)
  const [settingsTarget, setSettingsTarget] = useState<SettingsTargetEntity | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedPaletteQuery(paletteQuery.trim())
      setPaletteActiveIdx(0)
    }, 140)
    return () => window.clearTimeout(timer)
  }, [paletteQuery])

  useEffect(() => {
    if (pathname) {
      syncRouteFromPathname(pathname)
    }
  }, [pathname, syncRouteFromPathname])

  useEffect(() => {
    const onPopState = () => {
      syncRouteFromPathname(window.location.pathname)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [syncRouteFromPathname])

  useEffect(() => {
    const savedWidth = Number(window.localStorage.getItem('meofast-sidebar-width'))
    if (!Number.isNaN(savedWidth) && savedWidth >= 210 && savedWidth <= 420) {
      setSidebarWidth(savedWidth)
    }
  }, [])

  // Initial Bootstrap & Session Check
  useEffect(() => {
    let mounted = true
    async function bootstrap() {
      try {
        const status = await apiRequest<SetupStatusResponse>('/api/v1/setup/status')
        if (!status.installed) {
          router.replace('/setup')
          return
        }
        const me = await apiRequest<AuthMeResponse>('/api/v1/auth/me')
        if (!mounted) return
        setActiveCsrfToken(me.csrfToken)
        setSessionData(me)
        if (me.workspaces.length > 0 && !activeWorkspaceId) {
          setActiveWorkspaceId(me.workspaces[0]!.id)
        }
        setBootstrapping(false)
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 503) {
          router.replace('/setup')
          return
        }
        router.replace('/login')
      }
    }
    void bootstrap()
    return () => {
      mounted = false
    }
  }, [router, activeWorkspaceId, setActiveWorkspaceId])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((prev) => !prev)
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (sidebarSection === 'collections') {
          e.preventDefault()
          handleOpenSaveRequest()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const wsId = activeWorkspaceId || sessionData?.workspaces[0]?.id || ''

  const treeQuery = useQuery({
    queryKey: ['workspace-tree', wsId],
    enabled: Boolean(wsId && sessionData),
    refetchInterval: 10000,
    queryFn: () => apiRequest<WorkspaceTreeResponse>(`/api/v1/workspaces/${wsId}/tree`),
  })

  const capsulesQuery = useQuery({
    queryKey: ['capsules', wsId],
    enabled: Boolean(wsId && sessionData),
    queryFn: () =>
      apiRequest<{
        capsules: Array<{
          id: string
          title: string
          notes: string
          capsule: {
            autoCaptured?: boolean
            request?: {
              protocol?: RequestProtocol
              method?: HttpMethod
              url?: string
              rawUrl?: string
              headers?: KeyValueItem[]
              queryParams?: KeyValueItem[]
              pathVariables?: KeyValueItem[]
              body?: RequestBodyConfig
              graphql?: GraphqlPayloadConfig
              assertions?: RequestAssertion[]
            }
            response?: {
              status?: number
              statusText?: string
              durationMs?: number
              sizeBytes?: number
              headers?: Record<string, string>
              body?: string
              assertions?: AssertionEvaluationResult[]
              isJson?: boolean
              contentType?: string
              errorMessage?: string
            }
          }
          createdAt: string
        }>
      }>(`/api/v1/workspaces/${wsId}/capsules`),
  })

  const envsQuery = useQuery({
    queryKey: ['environments', wsId],
    enabled: Boolean(wsId && sessionData),
    queryFn: () =>
      apiRequest<{
        environments: Array<{ id: string; name: string; isGlobal: boolean }>
      }>(`/api/v1/workspaces/${wsId}/environments`),
  })

  const serverSearchQuery = useQuery({
    queryKey: ['workspace-search', wsId, debouncedPaletteQuery],
    enabled: Boolean(paletteOpen && wsId && sessionData),
    queryFn: () =>
      apiRequest<{ query: string; results: WorkspaceSearchResultItem[] }>(
        `/api/v1/workspaces/${wsId}/search?q=${encodeURIComponent(debouncedPaletteQuery)}`,
      ),
  })

  const historyQuery = useQuery({
    queryKey: ['history', wsId],
    enabled: Boolean(wsId && sessionData),
    queryFn: () =>
      apiRequest<{
        history: Array<{
          id: string
          method: HttpMethod
          url: string
          requestSnapshot?: {
            protocol?: RequestProtocol
            method?: HttpMethod
            url?: string
            rawUrl?: string
            headers?: KeyValueItem[]
            queryParams?: KeyValueItem[]
            pathVariables?: KeyValueItem[]
            body?: RequestBodyConfig
            graphql?: GraphqlPayloadConfig
            assertions?: RequestAssertion[]
          }
          status: number | null
          statusText?: string
          durationMs: number
          sizeBytes?: number
          headers?: Record<string, string>
          body?: string
          assertions?: AssertionEvaluationResult[]
          errorMessage?: string | null
          createdAt: string
        }>
      }>(`/api/v1/workspaces/${wsId}/history`),
  })

  useEffect(() => {
    if (!wsId || !envsQuery.data) return
    const nonGlobalList = envsQuery.data.environments.filter((e) => !e.isGlobal)

    if (!initializedEnvWsIds.includes(wsId)) {
      markEnvInitializedForWorkspace(wsId)
      setActiveEnvironmentId(nonGlobalList[0]?.id ?? null)
      return
    }

    if (activeEnvironmentId !== null && !nonGlobalList.some((e) => e.id === activeEnvironmentId)) {
      setActiveEnvironmentId(null)
    }
  }, [
    wsId,
    envsQuery.data,
    initializedEnvWsIds,
    activeEnvironmentId,
    markEnvInitializedForWorkspace,
    setActiveEnvironmentId,
  ])

  useEffect(() => {
    if (!wsId || !treeQuery.data || treeQuery.isFetching) return
    const wsCollectionIds = new Set(treeQuery.data.collections.map((c) => c.id))
    const wsRequestIds = new Set(
      treeQuery.data.collections.flatMap((c) => c.requests.map((r) => r.id)),
    )
    for (const id of wsRequestIds) {
      justSavedRequestIdsRef.current.delete(id)
    }
    const isSingleWorkspace = (sessionData?.workspaces.length ?? 0) <= 1

    closeTabsMatching((t) => {
      if (!t.savedRequestId) return false
      if (justSavedRequestIdsRef.current.has(t.savedRequestId)) return false
      const belongsToCurrentWorkspace =
        t.workspaceId === wsId ||
        (t.collectionId !== null && wsCollectionIds.has(t.collectionId)) ||
        isSingleWorkspace
      return belongsToCurrentWorkspace && !wsRequestIds.has(t.savedRequestId)
    })
  }, [
    wsId,
    treeQuery.data,
    treeQuery.isFetching,
    sessionData?.workspaces.length,
    closeTabsMatching,
  ])

  const handleSendRequest = async () => {
    if (!wsId || !activeTab) return
    const tabId = activeTab.tabId
    const reqLabel = `${activeTab.method} ${activeTab.name?.trim() || activeTab.url || 'Request'}`
    abortControllersByTabRef.current.get(tabId)?.abort()
    const controller = new AbortController()
    abortControllersByTabRef.current.set(tabId, controller)

    updateTabById(tabId, { isSending: true, lastError: null })

    try {
      const res = await apiRequest<ExecuteRequestResponse>('/api/v1/proxy/execute', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          workspaceId: wsId,
          environmentId: activeEnvironmentId,
          collectionId: activeTab.collectionId,
          folderId: activeTab.folderId,
          savedRequestId: activeTab.savedRequestId,
          protocol: activeTab.protocol,
          method: activeTab.method,
          url: activeTab.url,
          queryParams: activeTab.queryParams,
          headers: activeTab.headers,
          pathVariables: activeTab.pathVariables,
          auth: activeTab.auth,
          body: activeTab.body,
          graphql: activeTab.graphql,
          assertions: activeTab.assertions,
          postResponseVars: activeTab.postResponseVars ?? [],
          preRequestScript: activeTab.preRequestScript,
          testScript: activeTab.testScript,
          jsonSchema: activeTab.jsonSchema,
          timeoutMs: 30000,
          followRedirects: true,
        }),
      })
      updateTabById(tabId, { isSending: false, response: res, lastError: null })
      appendConsoleLogs(res.consoleLogs)
      if (res.environmentUpdated) {
        void queryClient.invalidateQueries({ queryKey: ['environments', wsId] })
        if (res.updatedVariableKeys && res.updatedVariableKeys.length > 0) {
          toast.success(
            'Environment variables captured',
            res.updatedVariableKeys.map((k) => `{{${k}}}`).join(', '),
          )
        }
      }

      // If the user switched to another tab or section while this request ran in the background, notify them in real time!
      const liveState = useWorkbenchStore.getState()
      if (liveState.activeTabId !== tabId || liveState.sidebarSection !== 'collections') {
        void apiRequest('/api/v1/notifications', {
          method: 'POST',
          body: JSON.stringify({
            type: res.status >= 400 ? 'request_failed' : 'request_completed',
            title: `Request Finished (${res.status} ${res.statusText || ''})`.trim(),
            message: `${reqLabel} completed in ${res.durationMs} ms.`,
            metadata: { tabId, statusCode: res.status, durationMs: res.durationMs },
          }),
        }).catch(() => undefined)
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        updateTabById(tabId, { isSending: false, lastError: 'Request cancelled.' })
        return
      }
      const message = err instanceof Error ? err.message : 'Request failed'
      updateTabById(tabId, { isSending: false, lastError: message })
      appendConsoleLogs([{ timestamp: new Date().toISOString(), level: 'error', message }])

      const liveState = useWorkbenchStore.getState()
      if (liveState.activeTabId !== tabId || liveState.sidebarSection !== 'collections') {
        void apiRequest('/api/v1/notifications', {
          method: 'POST',
          body: JSON.stringify({
            type: 'request_failed',
            title: `Request Failed: ${reqLabel}`,
            message,
            metadata: { tabId },
          }),
        }).catch(() => undefined)
      }
    } finally {
      if (abortControllersByTabRef.current.get(tabId) === controller) {
        abortControllersByTabRef.current.delete(tabId)
      }
      void queryClient.invalidateQueries({ queryKey: ['history', wsId] })
      void queryClient.invalidateQueries({ queryKey: ['capsules', wsId] })
    }
  }

  const handleCancelRequest = () => {
    if (!activeTab) return
    abortControllersByTabRef.current.get(activeTab.tabId)?.abort()
  }

  const handleOpenSaveRequest = () => {
    const collections = treeQuery.data?.collections ?? []
    if (activeTab.savedRequestId && activeTab.collectionId) {
      void saveRequestMutation.mutateAsync({
        name: activeTab.name,
        collectionId: activeTab.collectionId,
        folderId: activeTab.folderId,
      })
      return
    }
    const defaultColId = activeTab.collectionId ?? collections[0]?.id ?? ''
    setSaveReqName(
      activeTab.name === 'Untitled Request' ? `${activeTab.method} Endpoint` : activeTab.name,
    )
    setSaveTargetColId(defaultColId)
    setSaveTargetFolderId(activeTab.folderId ?? '__root__')
    setSaveModalOpen(true)
  }

  const saveRequestMutation = useMutation({
    mutationFn: async (input: {
      name: string
      collectionId: string
      folderId: string | null
    }) => {
      const payload = {
        workspaceId: wsId,
        collectionId: input.collectionId,
        folderId: input.folderId,
        name: input.name,
        description: activeTab.description ?? '',
        protocol: activeTab.protocol,
        method: activeTab.method,
        url: activeTab.url,
        queryParams: activeTab.queryParams,
        headers: activeTab.headers,
        pathVariables: activeTab.pathVariables,
        auth: activeTab.auth,
        body: activeTab.body,
        graphql: activeTab.graphql,
        assertions: activeTab.assertions,
        postResponseVars: activeTab.postResponseVars ?? [],
        preRequestScript: activeTab.preRequestScript,
        testScript: activeTab.testScript,
        jsonSchema: activeTab.jsonSchema,
      }
      if (activeTab.savedRequestId) {
        return apiRequest<{ id: string }>(`/api/v1/requests/${activeTab.savedRequestId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        })
      }
      return apiRequest<{ id: string }>('/api/v1/requests', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    onSuccess: async (res, vars) => {
      justSavedRequestIdsRef.current.add(res.id)
      updateTabById(activeTab.tabId, {
        workspaceId: wsId,
        savedRequestId: res.id,
        collectionId: vars.collectionId,
        folderId: vars.folderId,
        name: vars.name,
        dirty: false,
      })
      setSaveModalOpen(false)
      toast.success('Request saved', `"${vars.name}" saved to collection.`)
      await queryClient.invalidateQueries({ queryKey: ['workspace-tree', wsId] })
    },
    onError: (err) => {
      toast.error('Failed to save request', err instanceof Error ? err.message : undefined)
    },
  })

  const createWorkspaceMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{
        workspace: {
          id: string
          name: string
          slug: string
          description: string
          visibility: 'team' | 'private'
        }
      }>('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: wsName, description: wsDesc, visibility: 'team' }),
      })
    },
    onSuccess: (res) => {
      setNewWorkspaceOpen(false)
      setWsName('')
      setWsDesc('')
      setSessionData((prev) =>
        prev ? { ...prev, workspaces: [...prev.workspaces, res.workspace] } : prev,
      )
      setActiveWorkspaceId(res.workspace.id)
      toast.success('Workspace created', `Switched to "${res.workspace.name}".`)
    },
    onError: (err) => {
      toast.error('Failed to create workspace', err instanceof Error ? err.message : undefined)
    },
  })

  const createCollectionMutation = useMutation({
    mutationFn: async () => {
      await apiRequest(`/api/v1/workspaces/${wsId}/collections`, {
        method: 'POST',
        body: JSON.stringify({ name: colName }),
      })
    },
    onSuccess: async () => {
      setNewCollectionOpen(false)
      setColName('')
      toast.success('Collection created')
      await queryClient.invalidateQueries({ queryKey: ['workspace-tree', wsId] })
    },
    onError: (err) => {
      toast.error('Failed to create collection', err instanceof Error ? err.message : undefined)
    },
  })

  const createFolderMutation = useMutation({
    mutationFn: async () => {
      if (!newFolderTarget) return
      await apiRequest(`/api/v1/collections/${newFolderTarget.collectionId}/folders`, {
        method: 'POST',
        body: JSON.stringify({
          name: folderName.trim(),
          parentFolderId: newFolderTarget.parentFolderId,
        }),
      })
    },
    onSuccess: async () => {
      setNewFolderTarget(null)
      setFolderName('')
      toast.success('Folder created')
      await queryClient.invalidateQueries({ queryKey: ['workspace-tree', wsId] })
    },
    onError: (err) => {
      toast.error('Failed to create folder', err instanceof Error ? err.message : undefined)
    },
  })

  const createRequestInTreeMutation = useMutation({
    mutationFn: async () => {
      if (!newRequestTarget) throw new Error('No collection selected')
      const defaultUrl =
        newReqUrl.trim() ||
        (newReqProtocol === 'websocket'
          ? 'ws://meofast.local/echo'
          : newReqProtocol === 'graphql'
            ? '/api/v1/playground/graphql'
            : newReqProtocol === 'sse'
              ? '/api/v1/playground/sse'
              : '{{BASE_URL}}/')
      const effectiveMethod: HttpMethod =
        newReqProtocol === 'graphql' || newReqProtocol === 'soap' || newReqProtocol === 'grpc'
          ? 'POST'
          : newReqMethod
      const defaultHeaders: KeyValueItem[] = [
        {
          id: crypto.randomUUID(),
          key: 'Accept',
          value: 'application/json',
          description: '',
          enabled: true,
        },
      ]
      const defaultAssertions: RequestAssertion[] = [
        {
          id: crypto.randomUUID(),
          type: 'status_in_2xx',
          target: '',
          expected: '200-299',
          enabled: true,
        },
      ]
      const defaultBody: RequestBodyConfig = {
        mode:
          effectiveMethod === 'POST' || effectiveMethod === 'PUT' || effectiveMethod === 'PATCH'
            ? 'json'
            : 'none',
        raw:
          effectiveMethod === 'POST' || effectiveMethod === 'PUT' || effectiveMethod === 'PATCH'
            ? '{\n  \n}'
            : '',
        urlencoded: [],
        multipart: [],
      }
      const defaultGraphql: GraphqlPayloadConfig = {
        query: 'query {\n  users {\n    id\n    name\n  }\n}',
        variables: '{}',
        operationName: '',
      }

      const created = await apiRequest<{ id: string }>('/api/v1/requests', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: wsId,
          collectionId: newRequestTarget.collectionId,
          folderId: newRequestTarget.folderId,
          name: newReqName.trim(),
          description: '',
          protocol: newReqProtocol,
          method: effectiveMethod,
          url: defaultUrl,
          queryParams: [],
          headers: defaultHeaders,
          pathVariables: [],
          auth: { type: 'inherit' as const },
          body: defaultBody,
          graphql: defaultGraphql,
          assertions: defaultAssertions,
          postResponseVars: [],
          preRequestScript: '',
          testScript: '',
          jsonSchema: '',
        }),
      })

      return {
        id: created.id,
        workspaceId: wsId,
        collectionId: newRequestTarget.collectionId,
        folderId: newRequestTarget.folderId,
        name: newReqName.trim(),
        description: '',
        protocol: newReqProtocol,
        method: effectiveMethod,
        url: defaultUrl,
        queryParams: [] as KeyValueItem[],
        headers: defaultHeaders,
        pathVariables: [] as KeyValueItem[],
        auth: { type: 'inherit' as const },
        body: defaultBody,
        graphql: defaultGraphql,
        assertions: defaultAssertions,
        postResponseVars: [] as ResponseVariableExtractor[],
        preRequestScript: '',
        testScript: '',
        jsonSchema: '',
      }
    },
    onSuccess: async (reqObj) => {
      setCollapsedIds((prev) => {
        const next = new Set(prev)
        next.delete(reqObj.collectionId)
        if (reqObj.folderId) next.delete(reqObj.folderId)
        return next
      })
      setNewRequestTarget(null)
      setNewReqName('')
      setNewReqUrl('')
      justSavedRequestIdsRef.current.add(reqObj.id)
      openSavedRequest(reqObj)
      toast.success('Request created', `${reqObj.method} ${reqObj.name}`)
      await queryClient.invalidateQueries({ queryKey: ['workspace-tree', wsId] })
    },
    onError: (err) => {
      toast.error('Failed to create request', err instanceof Error ? err.message : undefined)
    },
  })

  const renameEntityMutation = useMutation({
    mutationFn: async () => {
      if (!renameTarget) return null
      const nextName = renameNameDraft.trim()
      if (!nextName) return null

      if (renameTarget.kind === 'workspace') {
        await apiRequest(`/api/v1/workspaces/${renameTarget.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: nextName }),
        })
        return { kind: 'workspace' as const, id: renameTarget.id, name: nextName }
      }

      if (renameTarget.kind === 'collection') {
        await apiRequest(`/api/v1/collections/${renameTarget.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: nextName }),
        })
        return { kind: 'collection' as const, id: renameTarget.id, name: nextName }
      }

      if (renameTarget.kind === 'folder') {
        await apiRequest(`/api/v1/folders/${renameTarget.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: nextName }),
        })
        return { kind: 'folder' as const, id: renameTarget.id, name: nextName }
      }

      if (renameTarget.kind === 'capsule') {
        await apiRequest(`/api/v1/capsules/${renameTarget.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: nextName }),
        })
        return { kind: 'capsule' as const, id: renameTarget.id, name: nextName }
      }

      const r = renameTarget.request
      await apiRequest(`/api/v1/requests/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: nextName }),
      })
      return { kind: 'request' as const, id: r.id, name: nextName }
    },
    onSuccess: async (updated) => {
      if (updated?.kind === 'workspace') {
        setSessionData((prev) =>
          prev
            ? {
                ...prev,
                workspaces: prev.workspaces.map((w) =>
                  w.id === updated.id ? { ...w, name: updated.name } : w,
                ),
              }
            : prev,
        )
      }
      if (updated?.kind === 'request') {
        for (const tab of tabs) {
          if (tab.savedRequestId === updated.id) {
            updateTabById(tab.tabId, { name: updated.name }, false)
          }
        }
      }
      setRenameTarget(null)
      setRenameNameDraft('')
      toast.success(
        updated?.kind === 'workspace'
          ? 'Workspace renamed'
          : updated?.kind === 'collection'
            ? 'Collection renamed'
            : updated?.kind === 'folder'
              ? 'Folder renamed'
              : updated?.kind === 'capsule'
                ? 'Debug Capsule renamed'
                : 'Request renamed',
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workspace-tree', wsId] }),
        queryClient.invalidateQueries({ queryKey: ['capsules', wsId] }),
        queryClient.invalidateQueries({ queryKey: ['profile-overview'] }),
      ])
    },
    onError: (err) => {
      toast.error('Failed to rename', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteCollectionMutation = useMutation({
    mutationFn: async (colId: string) => {
      const targetCol = (treeQuery.data?.collections ?? []).find((c) => c.id === colId)
      const deletedReqIds = new Set((targetCol?.requests ?? []).map((r) => r.id))
      await apiRequest(`/api/v1/collections/${colId}`, { method: 'DELETE' })
      return { colId, deletedReqIds }
    },
    onSuccess: async ({ colId, deletedReqIds }) => {
      for (const reqId of deletedReqIds) {
        justSavedRequestIdsRef.current.delete(reqId)
      }
      closeTabsMatching(
        (t) =>
          t.collectionId === colId ||
          (t.savedRequestId !== null && deletedReqIds.has(t.savedRequestId)),
      )
      toast.danger('Collection deleted')
      await queryClient.invalidateQueries({ queryKey: ['workspace-tree', wsId] })
    },
    onError: (err) => {
      toast.error('Failed to delete collection', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteFolderMutation = useMutation({
    mutationFn: async (folderId: string) => {
      const allCols = treeQuery.data?.collections ?? []
      const deletedFolderIds = new Set<string>([folderId])
      let added = true
      while (added) {
        added = false
        for (const col of allCols) {
          for (const f of col.folders) {
            if (f.parentFolderId && deletedFolderIds.has(f.parentFolderId) && !deletedFolderIds.has(f.id)) {
              deletedFolderIds.add(f.id)
              added = true
            }
          }
        }
      }
      const deletedReqIds = new Set<string>()
      for (const col of allCols) {
        for (const r of col.requests) {
          if (r.folderId && deletedFolderIds.has(r.folderId)) {
            deletedReqIds.add(r.id)
          }
        }
      }
      await apiRequest(`/api/v1/folders/${folderId}`, { method: 'DELETE' })
      return { deletedFolderIds, deletedReqIds }
    },
    onSuccess: async ({ deletedFolderIds, deletedReqIds }) => {
      for (const reqId of deletedReqIds) {
        justSavedRequestIdsRef.current.delete(reqId)
      }
      closeTabsMatching(
        (t) =>
          (t.folderId !== null && deletedFolderIds.has(t.folderId)) ||
          (t.savedRequestId !== null && deletedReqIds.has(t.savedRequestId)),
      )
      toast.danger('Folder deleted')
      await queryClient.invalidateQueries({ queryKey: ['workspace-tree', wsId] })
    },
    onError: (err) => {
      toast.error('Failed to delete folder', err instanceof Error ? err.message : undefined)
    },
  })

  const duplicateRequestMutation = useMutation({
    mutationFn: async (reqId: string) => {
      await apiRequest(`/api/v1/requests/${reqId}/duplicate`, { method: 'POST' })
    },
    onSuccess: async () => {
      toast.success('Request duplicated')
      await queryClient.invalidateQueries({ queryKey: ['workspace-tree', wsId] })
    },
    onError: (err) => {
      toast.error('Failed to duplicate request', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteRequestMutation = useMutation({
    mutationFn: async (reqId: string) => {
      await apiRequest(`/api/v1/requests/${reqId}`, { method: 'DELETE' })
      return reqId
    },
    onSuccess: async (deletedReqId) => {
      justSavedRequestIdsRef.current.delete(deletedReqId)
      closeTabsMatching((t) => t.savedRequestId === deletedReqId)
      toast.danger('Request deleted')
      await queryClient.invalidateQueries({ queryKey: ['workspace-tree', wsId] })
    },
    onError: (err) => {
      toast.error('Failed to delete request', err instanceof Error ? err.message : undefined)
    },
  })

  const clearHistoryMutation = useMutation({
    mutationFn: async () => {
      await apiRequest(`/api/v1/workspaces/${wsId}/history`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      closeTabsMatching((t) => Boolean(t.sourceHistoryId))
      toast.danger('Request history cleared')
      await queryClient.invalidateQueries({ queryKey: ['history', wsId] })
    },
    onError: (err) => {
      toast.error('Failed to clear history', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteHistoryItemMutation = useMutation({
    mutationFn: async (historyId: string) => {
      await apiRequest(`/api/v1/history/${historyId}`, { method: 'DELETE' })
      return historyId
    },
    onSuccess: async (deletedHistoryId) => {
      closeTabsMatching((t) => t.sourceHistoryId === deletedHistoryId)
      toast.info('History entry removed')
      await queryClient.invalidateQueries({ queryKey: ['history', wsId] })
    },
  })

  const captureCurrentCapsuleMutation = useMutation({
    mutationFn: async () => {
      const res = activeTab.response
      if (!res || !wsId) return
      const capsulePayload = {
        format: 'meofast.capsule.v1',
        exportedAt: new Date().toISOString(),
        title: `${activeTab.method} ${activeTab.name}`,
        notes: `HTTP ${res.status} (${res.durationMs} ms)`,
        request: {
          protocol: activeTab.protocol,
          method: activeTab.method,
          url: res.resolvedUrl || activeTab.url,
          rawUrl: activeTab.url,
          headers: activeTab.headers,
          queryParams: activeTab.queryParams,
          pathVariables: activeTab.pathVariables,
          body: activeTab.body,
          graphql: activeTab.graphql,
          assertions: activeTab.assertions,
        },
        response: {
          status: res.status,
          statusText: res.statusText,
          durationMs: res.durationMs,
          sizeBytes: res.sizeBytes,
          headers: res.headers,
          body: res.body,
          assertions: res.assertions,
          isJson: res.isJson,
          contentType: res.contentType,
        },
      }
      await apiRequest(`/api/v1/workspaces/${wsId}/capsules`, {
        method: 'POST',
        body: JSON.stringify({
          title: `${activeTab.method} ${activeTab.name} → ${res.status}`,
          notes: `Captured · HTTP ${res.status} · ${res.durationMs} ms`,
          capsule: capsulePayload,
        }),
      })
    },
    onSuccess: async () => {
      toast.success('Debug Capsule captured')
      await queryClient.invalidateQueries({ queryKey: ['capsules', wsId] })
    },
    onError: (err) => {
      toast.error('Failed to capture capsule', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteCapsuleMutation = useMutation({
    mutationFn: async (capsuleId: string) => {
      await apiRequest(`/api/v1/capsules/${capsuleId}`, { method: 'DELETE' })
      return capsuleId
    },
    onSuccess: async (deletedCapsuleId) => {
      closeTabsMatching((t) => t.sourceCapsuleId === deletedCapsuleId)
      toast.danger('Debug Capsule deleted')
      await queryClient.invalidateQueries({ queryKey: ['capsules', wsId] })
    },
  })

  const moveRequestMutation = useMutation({
    mutationFn: async (input: {
      requestId: string
      collectionId: string
      folderId: string | null
      sortOrder: number
    }) => {
      await apiRequest(`/api/v1/requests/${input.requestId}/move`, {
        method: 'PATCH',
        body: JSON.stringify({
          collectionId: input.collectionId,
          folderId: input.folderId,
          sortOrder: input.sortOrder,
        }),
      })
      return input
    },
    onSuccess: async (moved) => {
      for (const t of tabs) {
        if (t.savedRequestId === moved.requestId) {
          updateTabById(
            t.tabId,
            { collectionId: moved.collectionId, folderId: moved.folderId },
            false,
          )
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['workspace-tree', wsId] })
    },
  })

  const importMutation = useMutation({
    mutationFn: async () => {
      await apiRequest(`/api/v1/workspaces/${wsId}/collections/import`, {
        method: 'POST',
        body: JSON.stringify({ mode: importMode, content: importText }),
      })
    },
    onSuccess: async () => {
      setImportModalOpen(false)
      setImportText('')
      toast.success('Collection imported')
      await queryClient.invalidateQueries({ queryKey: ['workspace-tree', wsId] })
    },
    onError: (err) => {
      toast.error('Import failed', err instanceof Error ? err.message : undefined)
    },
  })

  const handleConfirmExport = async () => {
    if (!exportTargetCol) return
    const slug = exportTargetCol.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')

    if (exportFormat === 'html') {
      const res = await fetch(`/api/v1/collections/${exportTargetCol.id}/export?format=html`, {
        credentials: 'include',
      })
      const html = await res.text()
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug}-docs.html`
      a.click()
      URL.revokeObjectURL(url)
      setExportTargetCol(null)
      return
    }

    const json = await apiRequest<Record<string, unknown>>(
      `/api/v1/collections/${exportTargetCol.id}/export?format=${exportFormat}`,
    )

    if (exportFormat === 'bruno') {
      const bruText = String(json.content ?? '')
      const blob = new Blob([bruText], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug}.bru`
      a.click()
      URL.revokeObjectURL(url)
      setExportTargetCol(null)
      return
    }

    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const extMap: Record<string, string> = {
      openapi: '.openapi.json',
      postman: '.postman_collection.json',
      insomnia: '.insomnia.json',
      har: '.har',
      native: '.meofast.json',
    }
    a.download = `${slug}${extMap[exportFormat] ?? '.json'}`
    a.click()
    URL.revokeObjectURL(url)
    setExportTargetCol(null)
  }

  const handleImportFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    setImportText(text)
    if (file.name.endsWith('.bru')) {
      setImportMode('bruno')
    } else if (file.name.endsWith('.har') || text.includes('"log"')) {
      setImportMode('har')
    } else if (text.includes('"_type": "export"') || text.includes('"__export_format"')) {
      setImportMode('insomnia')
    } else if (text.includes('"openapi"') || text.includes('"swagger"')) {
      setImportMode('openapi')
    } else if (text.trim().startsWith('{')) {
      setImportMode('json')
    }
  }

  const toggleCollapsed = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDropOnContainer = (
    e: DragEvent,
    collectionId: string,
    folderId: string | null,
    sortOrder = 0,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTargetKey(null)
    if (!draggingRequestId) return
    moveRequestMutation.mutate({
      requestId: draggingRequestId,
      collectionId,
      folderId,
      sortOrder,
    })
    setDraggingRequestId(null)
  }

  const handleSidebarResizeDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setResizingSidebar(true)
  }

  const handleSidebarResizeMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!resizingSidebar) return
    // Left rail is 56px wide
    const nextWidth = Math.min(420, Math.max(210, e.clientX - 56))
    setSidebarWidth(nextWidth)
    window.localStorage.setItem('meofast-sidebar-width', String(nextWidth))
  }

  const handleSidebarResizeUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!resizingSidebar) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    setResizingSidebar(false)
  }

  const handleLogout = async () => {
    const hasUnsaved = tabs.some((t) => t.dirty)
    const ok = await confirm({
      title: 'Sign out?',
      description: hasUnsaved
        ? 'You have unsaved request tabs open. Are you sure you want to sign out of Meofast?'
        : 'You will be signed out of your current Meofast session.',
      confirmLabel: 'Sign Out',
      variant: 'danger',
    })
    if (!ok) return
    await apiRequest('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined)
    toast.info('Signed out')
    router.replace('/login')
  }

  if (bootstrapping || !sessionData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-background)]">
        <div className="flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
          <Spinner size="md" />
          <span>Loading workspace...</span>
        </div>
      </div>
    )
  }

  const collections = treeQuery.data?.collections ?? []
  const searchResults = serverSearchQuery.data?.results ?? []

  const handleSelectSearchResult = (item: WorkspaceSearchResultItem) => {
    if (item.kind === 'request' && item.request) {
      openSavedRequest(item.request)
    } else if (item.kind === 'collection') {
      setCollapsedIds((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
      setSidebarSection('collections')
    } else if (item.kind === 'mock') {
      setSidebarSection('mocks')
    } else if (item.kind === 'environment') {
      setSidebarSection('environments')
    } else if (item.kind === 'webhook') {
      setSidebarSection('webhooks')
    } else if (item.kind === 'monitor') {
      setSidebarSection('monitors', 'monitors')
    } else if (item.kind === 'capsule') {
      setSidebarSection('history', 'capsules')
    }
    setPaletteOpen(false)
  }

  const workspaceSelectOptions = sessionData.workspaces.map((ws) => ({
    value: ws.id,
    label: ws.name,
  }))

  const environmentSelectOptions = [
    { value: '__none__', label: 'No Environment' },
    ...(envsQuery.data?.environments ?? [])
      .filter((e) => !e.isGlobal)
      .map((env) => ({
        value: env.id,
        label: env.name,
      })),
  ]

  const selectedSaveCollection = collections.find((c) => c.id === saveTargetColId)

  const renderRequestItem = (req: SavedRequestNode, depth: number) => {
    const isSelected = activeTab.savedRequestId === req.id
    return (
      <div
        key={req.id}
        draggable
        onDragStart={(e) => {
          setDraggingRequestId(req.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => {
          setDraggingRequestId(null)
          setDropTargetKey(null)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDropTargetKey(`req:${req.id}`)
        }}
        onDrop={(e) =>
          handleDropOnContainer(e, req.collectionId, req.folderId, req.sortOrder + 1)
        }
        style={{ paddingLeft: `${depth * 12 + 10}px` }}
        className={cn(
          'group w-full h-8 pr-1.5 rounded-[var(--radius-md)] flex items-center gap-2 text-left text-xs cursor-pointer transition-colors',
          isSelected
            ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] font-medium'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]',
          dropTargetKey === `req:${req.id}` && 'ring-1 ring-[var(--color-primary)]',
        )}
        onClick={() => openSavedRequest(req)}
      >
        <MethodBadge method={req.method} compact active={isSelected} />
        <span className="truncate flex-1">{req.name}</span>
        <div className="flex items-center justify-center shrink-0">
          <DropdownMenu
            ariaLabel={`Actions for ${req.name}`}
            align="start"
            widthClassName="w-48"
            triggerClassName={cn(
              'w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-opacity',
              isSelected
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100',
            )}
            trigger={() => <Icon name="dots-vertical" size={13} />}
            items={[
              {
                id: 'rename',
                label: 'Rename Request',
                icon: 'edit',
                onSelect: () => {
                  setRenameTarget({ kind: 'request', request: req })
                  setRenameNameDraft(req.name)
                },
              },
              {
                id: 'duplicate',
                label: 'Duplicate Request',
                icon: 'copy',
                onSelect: () => duplicateRequestMutation.mutate(req.id),
              },
              {
                id: 'delete',
                label: 'Delete Request',
                icon: 'trash',
                variant: 'danger',
                dividerBefore: true,
                onSelect: () => {
                  void (async () => {
                    const ok = await confirm({
                      title: 'Delete request?',
                      description: `This action cannot be undone. "${req.name}" will be permanently removed from this collection.`,
                      confirmLabel: 'Delete Request',
                    })
                    if (ok) deleteRequestMutation.mutate(req.id)
                  })()
                },
              },
            ]}
          />
        </div>
      </div>
    )
  }

  const renderFolderTree = (
    col: CollectionNode,
    parentFolderId: string | null,
    depth: number,
  ) => {
    const childFolders = col.folders.filter((f) => f.parentFolderId === parentFolderId)
    return childFolders.map((folder) => {
      const collapsed = collapsedIds.has(folder.id)
      const folderRequests = col.requests.filter(
        (r) =>
          r.folderId === folder.id &&
          (!treeFilter.trim() ||
            r.name.toLowerCase().includes(treeFilter.toLowerCase()) ||
            r.url.toLowerCase().includes(treeFilter.toLowerCase())),
      )

      return (
        <div key={folder.id} className="flex flex-col gap-0.5">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDropTargetKey(`folder:${folder.id}`)
            }}
            onDrop={(e) => handleDropOnContainer(e, col.id, folder.id, 0)}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className={cn(
              'group h-8 pr-1.5 rounded-[var(--radius-md)] flex items-center justify-between gap-1.5 hover:bg-[var(--color-surface-hover)] text-xs cursor-pointer transition-colors',
              dropTargetKey === `folder:${folder.id}` &&
                'bg-[var(--color-primary-subtle)] ring-1 ring-[var(--color-primary)]',
            )}
            onClick={() => toggleCollapsed(folder.id)}
          >
            <span className="inline-flex items-center gap-1.5 min-w-0 truncate font-medium text-[var(--color-text)]">
              <Icon
                name={collapsed ? 'chevron-right' : 'chevron-down'}
                size={12}
                className="text-[var(--color-text-muted)] shrink-0"
              />
              <Icon name="folder" size={13} className="text-[var(--color-primary)] shrink-0" />
              <span className="truncate">{folder.name}</span>
            </span>

            <div className="flex items-center justify-center shrink-0">
              <DropdownMenu
                ariaLabel={`Actions for ${folder.name}`}
                align="start"
                widthClassName="w-60"
                triggerClassName="w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
                trigger={() => <Icon name="dots-vertical" size={13} />}
                items={[
                  {
                    id: 'new-request',
                    label: 'New Request',
                    icon: 'plus',
                    onSelect: () => {
                      setNewReqProtocol('http')
                      setNewReqMethod('GET')
                      setNewReqName('')
                      setNewReqUrl('')
                      setNewRequestTarget({
                        collectionId: col.id,
                        collectionName: col.name,
                        folderId: folder.id,
                        folderName: folder.name,
                      })
                    },
                  },
                  {
                    id: 'subfolder',
                    label: 'New Sub-folder',
                    icon: 'folder-plus',
                    onSelect: () =>
                      setNewFolderTarget({ collectionId: col.id, parentFolderId: folder.id }),
                  },
                  {
                    id: 'run',
                    label: 'Run Folder',
                    icon: 'play',
                    dividerBefore: true,
                    onSelect: () => setRunnerTarget({ collection: col, folderId: folder.id }),
                  },
                  {
                    id: 'rename',
                    label: 'Rename Folder',
                    icon: 'edit',
                    dividerBefore: true,
                    onSelect: () => {
                      setRenameTarget({ kind: 'folder', id: folder.id, name: folder.name })
                      setRenameNameDraft(folder.name)
                    },
                  },
                  {
                    id: 'settings',
                    label: 'Folder Settings',
                    icon: 'settings',
                    onSelect: () =>
                      setSettingsTarget({
                        kind: 'folder',
                        id: folder.id,
                        collectionId: col.id,
                        name: folder.name,
                        description: folder.description ?? '',
                        variables: folder.variables ?? [],
                        auth: folder.auth ?? { type: 'inherit' },
                        headers: folder.headers ?? [],
                      }),
                  },
                  {
                    id: 'delete',
                    label: 'Delete Folder',
                    icon: 'trash',
                    variant: 'danger',
                    dividerBefore: true,
                    onSelect: () => {
                      void (async () => {
                        const ok = await confirm({
                          title: 'Delete folder?',
                          description: `This action cannot be undone. Folder "${folder.name}" and all nested requests inside it will be permanently deleted.`,
                          confirmLabel: 'Delete Folder',
                        })
                        if (ok) deleteFolderMutation.mutate(folder.id)
                      })()
                    },
                  },
                ]}
              />
            </div>
          </div>

          {!collapsed ? (
            <>
              {renderFolderTree(col, folder.id, depth + 1)}
              {folderRequests.map((req) => renderRequestItem(req, depth + 1))}
            </>
          ) : null}
        </div>
      )
    })
  }

  const activeWorkspaceObj = sessionData.workspaces.find((w) => w.id === wsId) ?? null

  return (
    <div className="h-screen flex bg-[var(--color-background)] text-[var(--color-text)] overflow-hidden">
      {/* Full-Height Primary Activity Rail — Logo at Top + Blue Aurora Liquid Curved Notch */}
      <aside
        aria-label="Primary sections"
        className="relative z-30 w-[56px] h-full bg-[var(--color-primary)] flex flex-col items-center pb-3.5 shrink-0"
      >
        <div className="relative w-full h-12 border-b border-white/15 flex items-center justify-center shrink-0">
          <motion.button
            type="button"
            aria-label={sessionData.appName}
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.92 }}
            onMouseEnter={() => setHoveredNavId('__logo__')}
            onMouseLeave={() =>
              setHoveredNavId((prev) => (prev === '__logo__' ? null : prev))
            }
            onFocus={() => setHoveredNavId('__logo__')}
            onBlur={() => setHoveredNavId((prev) => (prev === '__logo__' ? null : prev))}
            onClick={() => setSidebarSection('collections')}
            className="w-9 h-9 rounded-[var(--radius-md)] inline-flex items-center justify-center cursor-pointer focus-visible:outline-white"
          >
            <MeofastLogo size={30} />
          </motion.button>

          <AnimatePresence>
            {hoveredNavId === '__logo__' ? (
              <motion.span
                role="tooltip"
                initial={{ opacity: 0, x: -6, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -4, scale: 0.98 }}
                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 -translate-y-1/2 z-50 px-2.5 py-1 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border-strong)] shadow-[var(--shadow-md)] text-xs font-semibold text-[var(--color-text)] whitespace-nowrap"
              >
                {sessionData.appName}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>

        <div className="w-full flex-1 flex flex-col items-center pt-[18px] pb-1.5 gap-1 min-h-0">
          <LayoutGroup id="meofast-primary-rail">
            {visiblePrimaryNavItems.map((nav) => {
              const active = sidebarSection === nav.id
              const isPinnedBottom = nav.id === 'admin'
              return (
                <div
                  key={nav.id}
                  className={cn(
                    'relative w-full h-10 flex items-center justify-center shrink-0',
                    isPinnedBottom && 'mt-auto',
                  )}
                >
                  {active ? (
                    <motion.div
                      layoutId="primary-rail-active-tab"
                      transition={{
                        type: 'spring',
                        stiffness: 380,
                        damping: 32,
                        mass: 0.75,
                      }}
                      aria-hidden="true"
                      className="pointer-events-none absolute left-[6px] -right-px -top-[16px] -bottom-[16px] z-0"
                    >
                      <svg
                        viewBox="0 0 54 80"
                        preserveAspectRatio="none"
                        className="w-full h-full block"
                        style={{ fill: 'var(--color-surface)' }}
                      >
                        <path d="M 54 0 L 53 0 C 53 10.5 45.5 18 35 18 L 22 18 C 9.85 18 0 27.85 0 40 C 0 52.15 9.85 62 22 62 L 35 62 C 45.5 62 53 69.5 53 80 L 54 80 Z" />
                      </svg>
                    </motion.div>
                  ) : null}

                  <motion.button
                    type="button"
                    aria-label={nav.label}
                    aria-current={active ? 'page' : undefined}
                    whileTap={{ scale: 0.91 }}
                    onMouseEnter={() => setHoveredNavId(nav.id)}
                    onMouseLeave={() =>
                      setHoveredNavId((prev) => (prev === nav.id ? null : prev))
                    }
                    onFocus={() => setHoveredNavId(nav.id)}
                    onBlur={() => setHoveredNavId((prev) => (prev === nav.id ? null : prev))}
                    onClick={() => setSidebarSection(nav.id as SidebarSection)}
                    className={cn(
                      'relative z-10 w-9 h-9 rounded-[var(--radius-md)] inline-flex items-center justify-center cursor-pointer transition-colors',
                      active
                        ? 'text-[var(--color-primary)] focus-visible:outline-[var(--color-primary)]'
                        : 'text-white/80 hover:text-white hover:bg-white/15 focus-visible:outline-white',
                    )}
                  >
                    <motion.span
                      animate={{ x: active ? 2.5 : 0, scale: active ? 1.06 : 1 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      className="inline-flex items-center justify-center"
                    >
                      <Icon name={nav.icon} size={17} />
                    </motion.span>
                  </motion.button>

                  <AnimatePresence>
                    {hoveredNavId === nav.id ? (
                      <motion.span
                        role="tooltip"
                        initial={{ opacity: 0, x: -6, scale: 0.96 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        exit={{ opacity: 0, x: -4, scale: 0.98 }}
                        transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                        className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 -translate-y-1/2 z-50 px-2.5 py-1 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border-strong)] shadow-[var(--shadow-md)] text-xs font-medium text-[var(--color-text)] whitespace-nowrap"
                      >
                        {nav.label}
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                </div>
              )
            })}
          </LayoutGroup>
        </div>
      </aside>

      {/* Right Column: Top Workspace Toolbar + Main Stage */}
      <div
        className={cn(
          'flex-1 min-w-0 h-full flex flex-col overflow-hidden',
          resizingSidebar && 'select-none',
        )}
      >
        <header className="h-12 px-3.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 shrink-0">
            <span className="font-bold text-sm tracking-tight hidden sm:inline whitespace-nowrap">
              {sessionData.appName}
            </span>

            <span className="h-4 w-px bg-[var(--color-border)] hidden sm:inline-block" aria-hidden="true" />

            <div className="flex items-center gap-1.5">
              <Select
                size="sm"
                ariaLabel="Active Workspace"
                value={wsId}
                onValueChange={(nextWsId) => {
                  if (nextWsId === wsId) return
                  if (tabs.some((t) => t.dirty)) {
                    void (async () => {
                      const ok = await confirm({
                        title: 'Switch workspace?',
                        description:
                          'You have unsaved request tabs open. Switch to the selected workspace anyway?',
                        confirmLabel: 'Switch Workspace',
                        variant: 'warning',
                      })
                      if (ok) setActiveWorkspaceId(nextWsId)
                    })()
                    return
                  }
                  setActiveWorkspaceId(nextWsId)
                }}
                options={workspaceSelectOptions}
                className="w-[165px] sm:w-[190px]"
              />
              {canCreateWorkspace || canUpdateWorkspace ? (
                <DropdownMenu
                  ariaLabel="Workspace actions"
                  align="start"
                  widthClassName="w-52"
                  triggerClassName="w-[30px] h-[30px] justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] shrink-0"
                  trigger={() => <Icon name="dots-vertical" size={13} />}
                  items={[
                    ...(activeWorkspaceObj && canUpdateWorkspace
                      ? [
                          {
                            id: 'rename-ws',
                            label: 'Rename Workspace',
                            icon: 'edit' as const,
                            onSelect: () => {
                              setRenameTarget({
                                kind: 'workspace',
                                id: activeWorkspaceObj.id,
                                name: activeWorkspaceObj.name,
                              })
                              setRenameNameDraft(activeWorkspaceObj.name)
                            },
                          },
                        ]
                      : []),
                    ...(canCreateWorkspace
                      ? [
                          {
                            id: 'new-ws',
                            label: 'New Workspace',
                            icon: 'plus' as const,
                            onSelect: () => setNewWorkspaceOpen(true),
                          },
                        ]
                      : []),
                  ]}
                />
              ) : null}
            </div>
          </div>

          <div className="hidden lg:flex flex-1 justify-center min-w-0 px-2">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="w-full max-w-xs h-[30px] px-2.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-background)] hover:border-[var(--color-primary)] text-xs text-[var(--color-text-muted)] inline-flex items-center justify-between gap-2.5 cursor-pointer transition-colors"
            >
              <span className="inline-flex items-center gap-2 min-w-0 truncate">
                <Icon name="search" size={13} className="shrink-0" />
                <span className="truncate">Search workspace...</span>
              </span>
              <kbd className="h-[18px] px-1.5 inline-flex items-center text-[10px] font-medium whitespace-nowrap shrink-0 rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-secondary)]">
                Ctrl K
              </kbd>
            </button>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {canViewFeature('environments') ? (
              <Select
                size="sm"
                variant="subtle"
                ariaLabel="Active Environment"
                prefixIcon={<Icon name="layers" size={12} />}
                value={activeEnvironmentId ?? '__none__'}
                onValueChange={(val) => setActiveEnvironmentId(val === '__none__' ? null : val)}
                options={environmentSelectOptions}
                className="w-[155px] sm:w-[180px]"
              />
            ) : null}

            {canViewFeature('cookies') ? (
              <button
                type="button"
                onClick={() => setCookieJarOpen(true)}
                aria-label="Open Workspace Cookie Jar"
                title="Workspace Cookie Jar"
                className="w-[30px] h-[30px] rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-primary)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] inline-flex items-center justify-center cursor-pointer transition-colors shrink-0"
              >
                <Icon name="cookie" size={14} />
              </button>
            ) : null}

            <NotificationBell
              onOpenRequestTab={(targetTabId) => {
                setActiveTab(targetTabId)
                setSidebarSection('collections')
              }}
              onWorkspacesChanged={() => {
                void apiRequest<AuthMeResponse>('/api/v1/auth/me')
                  .then((me) => setSessionData(me))
                  .catch(() => undefined)
              }}
            />

            <span className="h-4 w-px bg-[var(--color-border)] mx-0.5" aria-hidden="true" />

            <DropdownMenu
              ariaLabel="Account menu"
              triggerClassName="h-8 pl-1 pr-2 gap-1.5 shrink-0"
              trigger={({ open }) => (
                <>
                  <Avatar name={sessionData.user.fullName} size="sm" />
                  <div className="hidden xl:flex flex-col text-left leading-tight">
                    <span className="text-xs font-semibold truncate max-w-[120px]">
                      {sessionData.user.fullName}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-muted)]">
                      {sessionData.user.globalRole}
                    </span>
                  </div>
                  <Icon
                    name="chevron-down"
                    size={13}
                    className={cn(
                      'text-[var(--color-text-muted)] transition-transform duration-150 shrink-0',
                      open && 'rotate-180 text-[var(--color-primary)]',
                    )}
                  />
                </>
              )}
              header={
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar name={sessionData.user.fullName} size="sm" />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-xs font-semibold truncate">
                      {sessionData.user.fullName}
                    </span>
                    <span className="text-[11px] text-[var(--color-text-muted)] truncate">
                      {sessionData.user.email}
                    </span>
                  </div>
                  <Badge variant="primary">{sessionData.user.globalRole}</Badge>
                </div>
              }
              items={[
                {
                  id: 'profile',
                  label: 'My Profile',
                  icon: 'user',
                  onSelect: () => setSidebarSection('profile', 'overview'),
                },
                ...(canViewFeature('collections')
                  ? [
                      {
                        id: 'my-collections',
                        label: 'My Collections',
                        icon: 'collection' as const,
                        onSelect: () => setSidebarSection('profile', 'collections'),
                      },
                    ]
                  : []),
                {
                  id: 'password',
                  label: 'Password & Security',
                  icon: 'lock',
                  onSelect: () => setSidebarSection('profile', 'password'),
                },
                ...(canViewFeature('tokens')
                  ? [
                      {
                        id: 'tokens',
                        label: 'API Tokens (CLI / CI)',
                        icon: 'terminal' as const,
                        onSelect: () => setSidebarSection('profile', 'tokens'),
                      },
                    ]
                  : []),
                {
                  id: 'theme',
                  label: theme === 'light' ? 'Dark Mode' : 'Light Mode',
                  icon: theme === 'light' ? 'moon' : 'sun',
                  dividerBefore: true,
                  onSelect: () => toggleTheme(),
                },
                {
                  id: 'logout',
                  label: 'Sign Out',
                  icon: 'logout',
                  variant: 'danger',
                  dividerBefore: true,
                  onSelect: () => {
                    void handleLogout()
                  },
                },
              ]}
            />
          </div>
        </header>

        <div className="relative flex-1 min-w-0 min-h-0 flex overflow-hidden">
          {/* Solid surface anchor behind Sidebar Kedua so the liquid curved notch stays 100% seamless mid-transition */}
          <div
            aria-hidden="true"
            style={{
              width:
                sidebarSection === 'collections' || sidebarSection === 'history'
                  ? `${sidebarWidth}px`
                  : '256px',
            }}
            className="pointer-events-none hidden md:block absolute inset-y-0 left-0 bg-[var(--color-surface)] border-r border-[var(--color-border)]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none md:hidden absolute inset-0 bg-[var(--color-surface)]"
          />

          <AnimatePresence mode="wait" initial={false} custom={navDirection}>
            <motion.div
              key={activeStageKey}
              custom={navDirection}
              variants={stageMotionVariants}
              initial="enter"
              animate="center"
              exit="exit"
              className="relative z-10 flex-1 min-w-0 min-h-0 flex overflow-hidden"
            >
            {sidebarSection === 'docs' && canAccessSection('docs') ? (
              <DocsPanel workspaceId={wsId} />
            ) : sidebarSection === 'mocks' && canAccessSection('mocks') ? (
              <MocksPanel workspaceId={wsId} />
            ) : sidebarSection === 'webhooks' && canAccessSection('webhooks') ? (
              <WebhooksPanel workspaceId={wsId} />
            ) : sidebarSection === 'monitors' && canAccessSection('monitors') ? (
              <MonitorsLoadPanel workspaceId={wsId} />
            ) : sidebarSection === 'environments' && canAccessSection('environments') ? (
              <EnvironmentsPanel workspaceId={wsId} />
            ) : sidebarSection === 'admin' && canAccessSection('admin') ? (
              <AdminPanel
                currentUserRole={sessionData.user.globalRole}
                currentUserPermissions={sessionData.user.permissions}
                workspaceId={wsId}
                workspaceName={
                  sessionData.workspaces.find((w) => w.id === wsId)?.name ?? 'Workspace'
                }
              />
            ) : sidebarSection === 'profile' || !canAccessSection(sidebarSection) ? (
              <ProfilePanel
                user={sessionData.user}
                onUserUpdated={(updatedUser) => {
                  setSessionData((prev) =>
                    prev ? { ...prev, user: { ...prev.user, ...updatedUser } } : prev,
                  )
                }}
                onWorkspaceRenamed={(renamedId, nextName) => {
                  setSessionData((prev) =>
                    prev
                      ? {
                          ...prev,
                          workspaces: prev.workspaces.map((w) =>
                            w.id === renamedId ? { ...w, name: nextName } : w,
                          ),
                        }
                      : prev,
                  )
                }}
                onSignOut={() => {
                  void handleLogout()
                }}
              />
            ) : (
              <>
                {/* Resizable Left Collection / History Explorer */}
                <aside
                  style={{ width: `${sidebarWidth}px` }}
                  className="bg-[var(--color-surface)] flex flex-col shrink-0 hidden md:flex overflow-hidden"
                >
                  <AnimatePresence mode="wait" initial={false} custom={navDirection}>
                    <motion.div
                      key={sidebarSection}
                      custom={navDirection}
                      variants={explorerMotionVariants}
                      initial="enter"
                      animate="center"
                      exit="exit"
                      className="flex-1 min-h-0 flex flex-col"
                    >
                      {sidebarSection === 'collections' ? (
                        <>
                          <div className="px-3 pt-3 pb-2.5 border-b border-[var(--color-border)] flex flex-col gap-2.5">
                            <div className="flex items-center justify-between pr-0.5">
                              <span className="text-xs font-semibold tracking-wide text-[var(--color-text-secondary)] uppercase">
                                Collections
                              </span>
                              <DropdownMenu
                                ariaLabel="Collections menu"
                                align="start"
                                widthClassName="w-60"
                                triggerClassName="w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] shrink-0"
                                trigger={() => <Icon name="dots-vertical" size={13} />}
                                items={[
                                  {
                                    id: 'new-col',
                                    label: 'New Collection',
                                    icon: 'plus',
                                    onSelect: () => setNewCollectionOpen(true),
                                  },
                                  {
                                    id: 'import-col',
                                    label: 'Import cURL / OpenAPI / Postman',
                                    icon: 'upload',
                                    onSelect: () => setImportModalOpen(true),
                                  },
                                ]}
                              />
                            </div>

                    <Input
                      size="sm"
                      type="search"
                      leftIcon={<Icon name="search" size={13} />}
                      value={treeFilter}
                      onChange={(e) => setTreeFilter(e.target.value)}
                      placeholder="Filter endpoints..."
                      aria-label="Filter endpoints"
                    />
                  </div>

                  <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
                    {collections.length === 0 ? (
                      <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
                        No collections yet. Click + to create or import.
                      </div>
                    ) : (
                      collections.map((col) => {
                        const collapsed = collapsedIds.has(col.id)
                        const rootRequests = col.requests.filter(
                          (r) =>
                            !r.folderId &&
                            (!treeFilter.trim() ||
                              r.name.toLowerCase().includes(treeFilter.toLowerCase()) ||
                              r.url.toLowerCase().includes(treeFilter.toLowerCase())),
                        )

                        return (
                          <div key={col.id} className="flex flex-col gap-0.5">
                            <div
                              onDragOver={(e) => {
                                e.preventDefault()
                                setDropTargetKey(`col:${col.id}`)
                              }}
                              onDrop={(e) => handleDropOnContainer(e, col.id, null, 0)}
                              onClick={() => toggleCollapsed(col.id)}
                              className={cn(
                                'group h-8 pl-2 pr-1.5 rounded-[var(--radius-md)] flex items-center justify-between gap-1.5 bg-[var(--color-surface-secondary)] cursor-pointer transition-colors',
                                dropTargetKey === `col:${col.id}` &&
                                  'ring-1 ring-[var(--color-primary)]',
                              )}
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Icon
                                  name={collapsed ? 'chevron-right' : 'chevron-down'}
                                  size={12}
                                  className="text-[var(--color-text-muted)] shrink-0"
                                />
                                <span className="text-xs font-semibold truncate">{col.name}</span>
                              </div>

                              <div className="flex items-center justify-center shrink-0">
                                <DropdownMenu
                                  ariaLabel={`Actions for ${col.name}`}
                                  align="start"
                                  widthClassName="w-60"
                                  triggerClassName="w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] shrink-0"
                                  trigger={() => <Icon name="dots-vertical" size={13} />}
                                  items={[
                                    {
                                      id: 'new-request',
                                      label: 'New Request',
                                      icon: 'plus',
                                      onSelect: () => {
                                        setNewReqProtocol('http')
                                        setNewReqMethod('GET')
                                        setNewReqName('')
                                        setNewReqUrl('')
                                        setNewRequestTarget({
                                          collectionId: col.id,
                                          collectionName: col.name,
                                          folderId: null,
                                        })
                                      },
                                    },
                                    {
                                      id: 'new-folder',
                                      label: 'New Folder',
                                      icon: 'folder-plus',
                                      onSelect: () =>
                                        setNewFolderTarget({
                                          collectionId: col.id,
                                          parentFolderId: null,
                                        }),
                                    },
                                    {
                                      id: 'run',
                                      label: 'Run Collection',
                                      icon: 'play',
                                      dividerBefore: true,
                                      onSelect: () =>
                                        setRunnerTarget({ collection: col, folderId: null }),
                                    },
                                    {
                                      id: 'rename',
                                      label: 'Rename Collection',
                                      icon: 'edit',
                                      dividerBefore: true,
                                      onSelect: () => {
                                        setRenameTarget({
                                          kind: 'collection',
                                          id: col.id,
                                          name: col.name,
                                        })
                                        setRenameNameDraft(col.name)
                                      },
                                    },
                                    {
                                      id: 'settings',
                                      label: 'Collection Settings',
                                      icon: 'settings',
                                      onSelect: () =>
                                        setSettingsTarget({
                                          kind: 'collection',
                                          id: col.id,
                                          collectionId: col.id,
                                          name: col.name,
                                          description: col.description ?? '',
                                          variables: col.variables ?? [],
                                          auth: col.auth ?? { type: 'none' },
                                          headers: col.headers ?? [],
                                        }),
                                    },
                                    {
                                      id: 'export',
                                      label: 'Export Collection',
                                      icon: 'download',
                                      onSelect: () => setExportTargetCol(col),
                                    },
                                    {
                                      id: 'delete',
                                      label: 'Delete Collection',
                                      icon: 'trash',
                                      variant: 'danger',
                                      dividerBefore: true,
                                      onSelect: () => {
                                        void (async () => {
                                          const ok = await confirm({
                                            title: 'Delete collection?',
                                            description: `This action cannot be undone. "${col.name}" and all folders and requests inside it will be permanently deleted.`,
                                            confirmLabel: 'Delete Collection',
                                          })
                                          if (ok) deleteCollectionMutation.mutate(col.id)
                                        })()
                                      },
                                    },
                                  ]}
                                />
                              </div>
                            </div>

                            {!collapsed ? (
                              <>
                                {renderFolderTree(col, null, 1)}
                                {rootRequests.map((req) => renderRequestItem(req, 1))}
                              </>
                            ) : null}
                          </div>
                        )
                      })
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="p-3 border-b border-[var(--color-border)] flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
                        History & Capsules
                      </span>

                      {historySubMode === 'history' ? (
                        (historyQuery.data?.history.length ?? 0) > 0 ? (
                          <button
                            type="button"
                            onClick={() => {
                              void (async () => {
                                const ok = await confirm({
                                  title: 'Clear request history?',
                                  description:
                                    'This action cannot be undone. All recorded request executions in this workspace will be cleared.',
                                  confirmLabel: 'Clear History',
                                })
                                if (ok) clearHistoryMutation.mutate()
                              })()
                            }}
                            disabled={clearHistoryMutation.isPending}
                            className="h-6 px-2 rounded-[var(--radius-sm)] text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] cursor-pointer transition-colors"
                          >
                            Clear
                          </button>
                        ) : null
                      ) : activeTab.response ? (
                        <button
                          type="button"
                          onClick={() => captureCurrentCapsuleMutation.mutate()}
                          disabled={captureCurrentCapsuleMutation.isPending}
                          className="h-6 px-2 rounded-[var(--radius-sm)] text-[11px] font-medium bg-[var(--color-primary-subtle)] text-[var(--color-primary)] hover:opacity-90 inline-flex items-center gap-1 cursor-pointer transition-opacity"
                        >
                          <Icon name="plus" size={11} />
                          <span>Capture</span>
                        </button>
                      ) : null}
                    </div>

                    <LayoutGroup id="meofast-history-submode">
                      <div className="grid grid-cols-2 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--color-surface-secondary)]">
                        {(['history', 'capsules'] as const).map((sub) => {
                          const subActive = historySubMode === sub
                          const count =
                            sub === 'history'
                              ? (historyQuery.data?.history.length ?? 0)
                              : (capsulesQuery.data?.capsules.length ?? 0)
                          return (
                            <button
                              key={sub}
                              type="button"
                              onClick={() =>
                                setSidebarSection('history', sub === 'capsules' ? 'capsules' : null)
                              }
                              className={cn(
                                'relative h-7 rounded-[var(--radius-sm)] text-xs font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer transition-colors',
                                subActive
                                  ? 'text-[var(--color-primary)]'
                                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]',
                              )}
                            >
                              {subActive ? (
                                <motion.span
                                  layoutId="history-submode-pill"
                                  transition={{
                                    type: 'spring',
                                    stiffness: 520,
                                    damping: 38,
                                    mass: 0.6,
                                  }}
                                  className="absolute inset-0 rounded-[var(--radius-sm)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
                                />
                              ) : null}
                              <span className="relative z-10 capitalize">{sub}</span>
                              {count > 0 ? (
                                <span className="relative z-10 h-4 min-w-[16px] px-1 inline-flex items-center justify-center text-[10px] font-semibold rounded-full bg-[var(--color-primary-subtle)] text-[var(--color-primary)] tabular-nums">
                                  {count}
                                </span>
                              ) : null}
                            </button>
                          )
                        })}
                      </div>
                    </LayoutGroup>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
                    {historySubMode === 'history' ? (
                      (historyQuery.data?.history ?? []).length === 0 ? (
                        <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
                          No requests recorded yet. Send any request to capture live history.
                        </div>
                      ) : (
                        (historyQuery.data?.history ?? []).map((item) => {
                          const snap = item.requestSnapshot
                          const statusBadgeVariant =
                            item.status === null
                              ? 'danger'
                              : item.status >= 500
                                ? 'danger'
                                : item.status >= 400
                                  ? 'warning'
                                  : 'success'

                          return (
                            <div
                              key={item.id}
                              onClick={() => {
                                const bodyStr = item.body ?? ''
                                const hdrs = item.headers ?? {}
                                const ct =
                                  hdrs['content-type'] ?? hdrs['Content-Type'] ?? 'text/plain'
                                const isJsonBody =
                                  ct.includes('json') ||
                                  bodyStr.trim().startsWith('{') ||
                                  bodyStr.trim().startsWith('[')

                                const restoredResponse: ExecuteRequestResponse | null =
                                  item.status !== null
                                    ? {
                                        historyId: item.id,
                                        resolvedUrl: item.url,
                                        status: item.status,
                                        statusText: item.statusText ?? '',
                                        durationMs: item.durationMs,
                                        sizeBytes: item.sizeBytes ?? bodyStr.length,
                                        headers: hdrs,
                                        cookies: [],
                                        body: bodyStr,
                                        contentType: ct,
                                        isJson: isJsonBody,
                                        truncated: false,
                                        redirects: [],
                                        assertions: item.assertions ?? [],
                                        consoleLogs: [],
                                      }
                                    : null

                                openCapturedRun({
                                  workspaceId: wsId,
                                  sourceHistoryId: item.id,
                                  name: `${item.method} ${item.url.replace(/^https?:\/\/[^/]+/, '') || item.url}`.slice(
                                    0,
                                    48,
                                  ),
                                  protocol: snap?.protocol ?? 'http',
                                  method: item.method,
                                  url: snap?.rawUrl || item.url,
                                  headers: snap?.headers ?? [],
                                  queryParams: snap?.queryParams ?? [],
                                  pathVariables: snap?.pathVariables ?? [],
                                  body: snap?.body ?? {
                                    mode: 'none',
                                    raw: '',
                                    urlencoded: [],
                                    multipart: [],
                                  },
                                  graphql: snap?.graphql ?? {
                                    query: '',
                                    variables: '{}',
                                    operationName: '',
                                  },
                                  assertions: snap?.assertions ?? [],
                                  response: restoredResponse,
                                  lastError: item.errorMessage ?? null,
                                })
                              }}
                              className="group p-2.5 rounded-[var(--radius-md)] hover:bg-[var(--color-surface-hover)] text-left flex flex-col gap-1 cursor-pointer border border-transparent hover:border-[var(--color-border)] transition-colors"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <MethodBadge method={item.method} compact />
                                <div className="flex items-center gap-1.5 tabular-nums">
                                  <Badge variant={statusBadgeVariant}>
                                    {item.status ?? 'ERR'}
                                  </Badge>
                                  <span className="text-[11px] font-mono text-[var(--color-text-muted)]">
                                    {formatDuration(item.durationMs)}
                                  </span>
                                  <button
                                    type="button"
                                    title="Delete entry"
                                    aria-label="Delete history entry"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void (async () => {
                                        const ok = await confirm({
                                          title: 'Delete history entry?',
                                          description: `Remove recorded ${item.method} execution from history?`,
                                          confirmLabel: 'Delete Entry',
                                        })
                                        if (ok) deleteHistoryItemMutation.mutate(item.id)
                                      })()
                                    }}
                                    className="hidden group-hover:inline-flex w-5 h-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer"
                                  >
                                    <Icon name="trash" size={11} />
                                  </button>
                                </div>
                              </div>
                              <span className="text-xs font-mono truncate text-[var(--color-text)]">
                                {item.url}
                              </span>
                              <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums">
                                {formatShortTime(item.createdAt)}
                              </span>
                            </div>
                          )
                        })
                      )
                    ) : (capsulesQuery.data?.capsules ?? []).length === 0 ? (
                      <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
                        Error responses (4xx/5xx) & failed tests are captured here automatically, or
                        click Capture to snapshot the active response.
                      </div>
                    ) : (
                      (capsulesQuery.data?.capsules ?? []).map((cap) => {
                        const r = cap.capsule.request
                        const capRes = cap.capsule.response
                        return (
                          <div
                            key={cap.id}
                            onClick={() => {
                              const bodyStr = capRes?.body ?? ''
                              const hdrs = capRes?.headers ?? {}
                              const ct =
                                capRes?.contentType ??
                                hdrs['content-type'] ??
                                hdrs['Content-Type'] ??
                                'text/plain'
                              const isJsonBody =
                                capRes?.isJson ??
                                (ct.includes('json') ||
                                  bodyStr.trim().startsWith('{') ||
                                  bodyStr.trim().startsWith('['))

                              const restoredResponse: ExecuteRequestResponse | null =
                                capRes && typeof capRes.status === 'number' && capRes.status > 0
                                  ? {
                                      historyId: cap.id,
                                      resolvedUrl: r?.url ?? '',
                                      status: capRes.status,
                                      statusText: capRes.statusText ?? '',
                                      durationMs: capRes.durationMs ?? 0,
                                      sizeBytes: capRes.sizeBytes ?? bodyStr.length,
                                      headers: hdrs,
                                      cookies: [],
                                      body: bodyStr,
                                      contentType: ct,
                                      isJson: isJsonBody,
                                      truncated: false,
                                      redirects: [],
                                      assertions: capRes.assertions ?? [],
                                      consoleLogs: [],
                                    }
                                  : null

                              openCapturedRun({
                                workspaceId: wsId,
                                sourceCapsuleId: cap.id,
                                name: cap.title,
                                protocol: r?.protocol ?? 'http',
                                method: r?.method ?? 'GET',
                                url: r?.rawUrl || r?.url || '',
                                headers: r?.headers ?? [],
                                queryParams: r?.queryParams ?? [],
                                pathVariables: r?.pathVariables ?? [],
                                body: r?.body ?? {
                                  mode: 'none',
                                  raw: '',
                                  urlencoded: [],
                                  multipart: [],
                                },
                                graphql: r?.graphql ?? {
                                  query: '',
                                  variables: '{}',
                                  operationName: '',
                                },
                                assertions: r?.assertions ?? [],
                                response: restoredResponse,
                                lastError: capRes?.errorMessage ?? null,
                              })
                            }}
                            className="group p-2.5 rounded-[var(--radius-md)] hover:bg-[var(--color-surface-hover)] text-left flex flex-col gap-1 cursor-pointer border border-transparent hover:border-[var(--color-border)] transition-colors"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold truncate">{cap.title}</span>
                              <div className="flex items-center gap-1 shrink-0">
                                <Badge variant={cap.capsule.autoCaptured ? 'warning' : 'info'}>
                                  {cap.capsule.autoCaptured ? 'Auto' : 'Replay'}
                                </Badge>
                                <DropdownMenu
                                  ariaLabel={`Actions for ${cap.title}`}
                                  align="start"
                                  widthClassName="w-52"
                                  triggerClassName="w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                                  trigger={() => <Icon name="dots-vertical" size={13} />}
                                  items={[
                                    {
                                      id: 'rename',
                                      label: 'Rename Capsule',
                                      icon: 'edit',
                                      onSelect: () => {
                                        setRenameTarget({
                                          kind: 'capsule',
                                          id: cap.id,
                                          name: cap.title,
                                        })
                                        setRenameNameDraft(cap.title)
                                      },
                                    },
                                    {
                                      id: 'download',
                                      label: 'Download .capsule.json',
                                      icon: 'download',
                                      onSelect: () => {
                                        const blob = new Blob(
                                          [JSON.stringify(cap.capsule, null, 2)],
                                          { type: 'application/json' },
                                        )
                                        const dlUrl = URL.createObjectURL(blob)
                                        const a = document.createElement('a')
                                        a.href = dlUrl
                                        a.download = `${cap.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.capsule.json`
                                        a.click()
                                        URL.revokeObjectURL(dlUrl)
                                      },
                                    },
                                    {
                                      id: 'delete',
                                      label: 'Delete Capsule',
                                      icon: 'trash',
                                      variant: 'danger',
                                      dividerBefore: true,
                                      onSelect: () => {
                                        void (async () => {
                                          const ok = await confirm({
                                            title: 'Delete debug capsule?',
                                            description: `This action cannot be undone. Capsule "${cap.title}" will be permanently deleted.`,
                                            confirmLabel: 'Delete Capsule',
                                          })
                                          if (ok) deleteCapsuleMutation.mutate(cap.id)
                                        })()
                                      },
                                    },
                                  ]}
                                />
                              </div>
                            </div>
                            <span className="text-[11px] text-[var(--color-text-secondary)] truncate">
                              {cap.notes}
                            </span>
                            <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums">
                              {formatShortTime(cap.createdAt)}
                            </span>
                          </div>
                        )
                      })
                    )}
                  </div>
                </>
              )}
                    </motion.div>
                  </AnimatePresence>
                </aside>

                {/* Draggable Sidebar Resize Divider */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  title="Drag to resize sidebar (double-click to reset)"
                  onDoubleClick={() => {
                    setSidebarWidth(256)
                    window.localStorage.setItem('meofast-sidebar-width', '256')
                  }}
                  onPointerDown={handleSidebarResizeDown}
                  onPointerMove={handleSidebarResizeMove}
                  onPointerUp={handleSidebarResizeUp}
                  className={cn(
                    'hidden md:block w-1 shrink-0 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-primary)] transition-colors',
                    resizingSidebar && 'bg-[var(--color-primary)]',
                  )}
                />

                {/* Resizable Request / Response Split Workbench */}
                <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
                  <RequestPane
                    workspaceId={wsId}
                    activeTab={activeTab}
                    onSend={handleSendRequest}
                    onCancel={handleCancelRequest}
                    onOpenSaveModal={handleOpenSaveRequest}
                    responseSlot={<ResponsePane workspaceId={wsId} activeTab={activeTab} />}
                  />
                </main>
              </>
            )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Collection Runner Modal */}
      {runnerTarget ? (
        <CollectionRunnerModal
          open={Boolean(runnerTarget)}
          onClose={() => {
            setRunnerTarget(null)
            void queryClient.invalidateQueries({ queryKey: ['history', wsId] })
          }}
          workspaceId={wsId}
          collection={runnerTarget.collection}
          initialFolderId={runnerTarget.folderId}
          environments={envsQuery.data?.environments ?? []}
          activeEnvironmentId={activeEnvironmentId}
        />
      ) : null}

      {/* Server-Side Workspace Search Modal (Ctrl+K) */}
      <Dialog
        open={paletteOpen}
        title="Search Workspace"
        maxWidthClass="max-w-xl"
        onClose={() => setPaletteOpen(false)}
      >
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Input
              leftIcon={<Icon name="search" size={14} />}
              placeholder="Search endpoints, URLs, collections, mocks, variables..."
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
              onKeyDown={(e) => {
                if (searchResults.length === 0) return
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setPaletteActiveIdx((prev) => (prev + 1) % searchResults.length)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setPaletteActiveIdx(
                    (prev) => (prev - 1 + searchResults.length) % searchResults.length,
                  )
                } else if (e.key === 'Enter') {
                  const chosen = searchResults[paletteActiveIdx] ?? searchResults[0]
                  if (chosen) {
                    e.preventDefault()
                    handleSelectSearchResult(chosen)
                  }
                }
              }}
              autoFocus
            />
            {serverSearchQuery.isFetching ? (
              <span className="pointer-events-none absolute right-2.5 inset-y-0 flex items-center">
                <Spinner size="sm" />
              </span>
            ) : null}
          </div>

          <div className="border border-[var(--color-border)] rounded-[var(--radius-lg)] divide-y divide-[var(--color-border)] overflow-hidden text-xs">
            {serverSearchQuery.isLoading ? (
              <div className="py-8 flex items-center justify-center gap-2 text-[var(--color-text-muted)]">
                <Spinner size="sm" />
                <span>Searching workspace...</span>
              </div>
            ) : searchResults.length === 0 ? (
              <div className="py-8 px-4 text-center text-[var(--color-text-muted)]">
                {debouncedPaletteQuery
                  ? `No matching results found for "${debouncedPaletteQuery}".`
                  : 'No saved endpoints or resources in this workspace yet.'}
              </div>
            ) : (
              searchResults.map((item, idx) => {
                const isHighlighted = idx === paletteActiveIdx
                return (
                  <button
                    key={`${item.kind}-${item.id}`}
                    type="button"
                    onMouseEnter={() => setPaletteActiveIdx(idx)}
                    onClick={() => handleSelectSearchResult(item)}
                    className={cn(
                      'w-full px-3 py-2 flex items-center justify-between gap-3 cursor-pointer text-left transition-colors',
                      isHighlighted
                        ? 'bg-[var(--color-primary-subtle)]/75'
                        : 'hover:bg-[var(--color-surface-hover)]',
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      {item.method ? (
                        <MethodBadge
                          method={item.method}
                          compact
                          active={isHighlighted}
                        />
                      ) : (
                        <span className="w-[46px] h-[17px] rounded-[var(--radius-sm)] bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] inline-flex items-center justify-center shrink-0">
                          <Icon
                            name={
                              item.kind === 'collection'
                                ? 'collection'
                                : item.kind === 'environment'
                                  ? 'key'
                                  : item.kind === 'webhook'
                                    ? 'webhook'
                                    : 'bug'
                            }
                            size={11}
                          />
                        </span>
                      )}
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="font-medium text-[var(--color-text)] truncate">
                          {item.title}
                        </span>
                        <span className="font-mono text-[11px] text-[var(--color-text-muted)] truncate">
                          {item.subtitle}
                        </span>
                      </div>
                    </div>

                    <Badge variant={item.kind === 'request' ? 'neutral' : 'info'}>
                      {item.badge}
                    </Badge>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </Dialog>

      {/* Create Workspace Modal */}
      <Dialog
        open={newWorkspaceOpen}
        title="New Workspace"
        onClose={() => setNewWorkspaceOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={wsName}
            onChange={(e) => setWsName(e.target.value)}
            placeholder="Payments API"
            required
          />
          <Input
            label="Description (Optional)"
            value={wsDesc}
            onChange={(e) => setWsDesc(e.target.value)}
            placeholder="Shared workspace for checkout services"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setNewWorkspaceOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!wsName.trim()}
              isLoading={createWorkspaceMutation.isPending}
              onClick={() => createWorkspaceMutation.mutate()}
            >
              Create
            </Button>
          </div>
        </div>
      </Dialog>

      {/* New Collection Modal */}
      <Dialog
        open={newCollectionOpen}
        title="New Collection"
        onClose={() => setNewCollectionOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Collection Name"
            value={colName}
            onChange={(e) => setColName(e.target.value)}
            placeholder="Orders API v2"
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setNewCollectionOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!colName.trim()}
              isLoading={createCollectionMutation.isPending}
              onClick={() => createCollectionMutation.mutate()}
            >
              Create
            </Button>
          </div>
        </div>
      </Dialog>

      {/* New Folder Modal */}
      <Dialog
        open={Boolean(newFolderTarget)}
        title="New Folder"
        onClose={() => setNewFolderTarget(null)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Folder Name"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder="Auth Endpoints"
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setNewFolderTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={!folderName.trim()}
              isLoading={createFolderMutation.isPending}
              onClick={() => createFolderMutation.mutate()}
            >
              Create Folder
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Save Request Modal */}
      <Dialog
        open={saveModalOpen}
        title="Save Request"
        onClose={() => setSaveModalOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Request Name"
            value={saveReqName}
            onChange={(e) => setSaveReqName(e.target.value)}
            required
          />
          <Select
            label="Collection"
            value={saveTargetColId}
            onValueChange={(val) => {
              setSaveTargetColId(val)
              setSaveTargetFolderId('__root__')
            }}
            options={collections.map((c) => ({ value: c.id, label: c.name }))}
          />
          {selectedSaveCollection && selectedSaveCollection.folders.length > 0 ? (
            <Select
              label="Folder"
              value={saveTargetFolderId}
              onValueChange={setSaveTargetFolderId}
              options={[
                { value: '__root__', label: '(Collection Root)' },
                ...selectedSaveCollection.folders.map((f) => ({ value: f.id, label: f.name })),
              ]}
            />
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setSaveModalOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!saveReqName.trim() || !saveTargetColId}
              isLoading={saveRequestMutation.isPending}
              onClick={() =>
                saveRequestMutation.mutate({
                  name: saveReqName.trim(),
                  collectionId: saveTargetColId,
                  folderId: saveTargetFolderId === '__root__' ? null : saveTargetFolderId,
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Import cURL / OpenAPI / Postman Modal */}
      <Dialog
        open={importModalOpen}
        title="Import API Specification"
        maxWidthClass="max-w-2xl"
        onClose={() => setImportModalOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-end justify-between gap-3">
            <div className="flex-1">
              <Select
                label="Format"
                value={importMode}
                onValueChange={(val) =>
                  setImportMode(
                    val as 'curl' | 'openapi' | 'json' | 'insomnia' | 'har' | 'bruno',
                  )
                }
                options={[
                  { value: 'curl', label: 'cURL Command' },
                  { value: 'openapi', label: 'OpenAPI 3.0 / 3.1 / Swagger JSON' },
                  { value: 'json', label: 'Postman v2.1 / Meofast JSON' },
                  { value: 'insomnia', label: 'Insomnia v4 Export (.json)' },
                  { value: 'har', label: 'HTTP Archive (.har)' },
                  { value: 'bruno', label: 'Bruno Request (.bru)' },
                ]}
              />
            </div>
            {importMode !== 'curl' ? (
              <label className="h-[34px] px-3 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer shrink-0">
                <Icon name="upload" size={13} />
                <span>Upload File</span>
                <input
                  type="file"
                  accept=".json,.har,.bru"
                  onChange={handleImportFileUpload}
                  className="hidden"
                />
              </label>
            ) : null}
          </div>

          <CodeEditor
            language={importMode === 'curl' || importMode === 'bruno' ? 'text' : 'json'}
            value={importText}
            onChange={setImportText}
            placeholder={
              importMode === 'curl'
                ? 'curl -X POST https://jsonplaceholder.typicode.com/posts \\\n  -H "Content-Type: application/json" \\\n  -d \'{"title":"Hello"}\''
                : importMode === 'openapi'
                  ? '{\n  "openapi": "3.0.3",\n  "info": { "title": "My API", "version": "1.0.0" },\n  "paths": {}\n}'
                  : '{\n  "info": { "name": "My Collection" },\n  "item": []\n}'
            }
            minHeight="180px"
            ariaLabel="Import payload"
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setImportModalOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!importText.trim()}
              isLoading={importMutation.isPending}
              onClick={() => importMutation.mutate()}
            >
              Import
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Export Collection Modal */}
      <Dialog
        open={Boolean(exportTargetCol)}
        title={`Export — ${exportTargetCol?.name ?? ''}`}
        onClose={() => setExportTargetCol(null)}
      >
        <div className="flex flex-col gap-4">
          <Select
            label="Export Format"
            value={exportFormat}
            onValueChange={(val) =>
              setExportFormat(
                val as
                  | 'openapi'
                  | 'postman'
                  | 'insomnia'
                  | 'har'
                  | 'bruno'
                  | 'native'
                  | 'html',
              )
            }
            options={[
              { value: 'openapi', label: 'OpenAPI 3.0.3 Specification (.openapi.json)' },
              { value: 'postman', label: 'Postman Collection v2.1 (.postman_collection.json)' },
              { value: 'insomnia', label: 'Insomnia v4 Export (.insomnia.json)' },
              { value: 'har', label: 'HTTP Archive (.har)' },
              { value: 'bruno', label: 'Bruno File (.bru)' },
              { value: 'native', label: 'Git-Friendly Native Bundle (.meofast.json)' },
              { value: 'html', label: 'Static HTML API Documentation (.html)' },
            ]}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setExportTargetCol(null)}>
              Cancel
            </Button>
            <Button
              leftIcon={<Icon name="download" size={14} />}
              onClick={handleConfirmExport}
            >
              Download
            </Button>
          </div>
        </div>
      </Dialog>

      {/* New Request in Collection / Folder Modal */}
      <Dialog
        open={Boolean(newRequestTarget)}
        title={
          newRequestTarget
            ? `New Request — ${
                newRequestTarget.folderName
                  ? `${newRequestTarget.collectionName} / ${newRequestTarget.folderName}`
                  : newRequestTarget.collectionName
              }`
            : 'New Request'
        }
        onClose={() => setNewRequestTarget(null)}
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select
              label="Protocol"
              value={newReqProtocol}
              onValueChange={(val) => setNewReqProtocol(val as RequestProtocol)}
              options={REQUEST_PROTOCOLS.map((p) => ({
                value: p,
                label:
                  p === 'http'
                    ? 'HTTP / REST'
                    : p === 'graphql'
                      ? 'GraphQL'
                      : p === 'websocket'
                        ? 'WebSocket'
                        : p === 'sse'
                          ? 'SSE'
                          : p === 'soap'
                            ? 'SOAP'
                            : 'gRPC',
              }))}
            />
            {newReqProtocol === 'http' || newReqProtocol === 'soap' ? (
              <Select
                label="HTTP Method"
                mono
                value={newReqMethod}
                onValueChange={(val) => setNewReqMethod(val as HttpMethod)}
                options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
                popoverWidth={76}
                renderTrigger={(opt) => renderMethodTrigger(opt, newReqMethod)}
                renderOption={renderMethodOption}
              />
            ) : (
              <div className="flex flex-col gap-1.5 justify-end">
                <span className="text-xs font-medium text-[var(--color-text-secondary)]">
                  Transport
                </span>
                <div className="h-[34px] px-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-secondary)] flex items-center text-xs font-mono text-[var(--color-text-secondary)]">
                  {newReqProtocol.toUpperCase()}
                </div>
              </div>
            )}
          </div>

          <Input
            label="Request Name"
            value={newReqName}
            onChange={(e) => setNewReqName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newReqName.trim() && !createRequestInTreeMutation.isPending) {
                e.preventDefault()
                createRequestInTreeMutation.mutate()
              }
            }}
            placeholder="e.g. Get User Profile, Create Payment"
            required
          />

          <Input
            label="Endpoint URL (Optional)"
            mono
            value={newReqUrl}
            onChange={(e) => setNewReqUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newReqName.trim() && !createRequestInTreeMutation.isPending) {
                e.preventDefault()
                createRequestInTreeMutation.mutate()
              }
            }}
            placeholder={
              newReqProtocol === 'websocket'
                ? 'ws://meofast.local/echo'
                : newReqProtocol === 'graphql'
                  ? '/api/v1/playground/graphql'
                  : '{{BASE_URL}}/v1/users'
            }
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setNewRequestTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!newReqName.trim()}
              isLoading={createRequestInTreeMutation.isPending}
              leftIcon={<Icon name="plus" size={14} />}
              onClick={() => createRequestInTreeMutation.mutate()}
            >
              Create Request
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Unified Rename Modal (Workspace / Collection / Folder / Request / Capsule) */}
      <Dialog
        open={Boolean(renameTarget)}
        title={
          renameTarget?.kind === 'workspace'
            ? 'Rename Workspace'
            : renameTarget?.kind === 'collection'
              ? 'Rename Collection'
              : renameTarget?.kind === 'folder'
                ? 'Rename Folder'
                : renameTarget?.kind === 'capsule'
                  ? 'Rename Debug Capsule'
                  : 'Rename Request'
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
                  : renameTarget?.kind === 'folder'
                    ? 'Folder Name'
                    : renameTarget?.kind === 'capsule'
                      ? 'Capsule Title'
                      : 'Request Name'
            }
            value={renameNameDraft}
            onChange={(e) => setRenameNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                renameNameDraft.trim() &&
                !renameEntityMutation.isPending
              ) {
                e.preventDefault()
                renameEntityMutation.mutate()
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
              disabled={!renameNameDraft.trim()}
              isLoading={renameEntityMutation.isPending}
              onClick={() => renameEntityMutation.mutate()}
            >
              Save Name
            </Button>
          </div>
        </div>
      </Dialog>

      <CookieJarModal
        open={cookieJarOpen}
        onClose={() => setCookieJarOpen(false)}
        workspaceId={wsId}
      />

      <CollectionSettingsModal
        open={Boolean(settingsTarget)}
        workspaceId={wsId}
        target={settingsTarget}
        onClose={() => setSettingsTarget(null)}
      />
    </div>
  )
}
