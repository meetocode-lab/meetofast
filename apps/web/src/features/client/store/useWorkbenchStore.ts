'use client'

import {
  type ExecuteRequestResponse,
  type GraphqlPayloadConfig,
  type HttpMethod,
  type KeyValueItem,
  reconcileUrlAndQueryParams,
  type RequestAssertion,
  type RequestAuthConfig,
  type RequestBodyConfig,
  type RequestProtocol,
  type ResponseVariableExtractor,
  syncPathVariablesFromUrl,
} from '@meofast/shared'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  buildSectionPath,
  isSidebarSection,
  parseWorkspacePath,
  SIDEBAR_SECTIONS,
  type SidebarSection,
} from './workspace-routes'

export {
  buildSectionPath,
  isSidebarSection,
  parseWorkspacePath,
  SIDEBAR_SECTIONS,
  type SidebarSection,
}

export interface RequestTab {
  tabId: string
  workspaceId?: string | null
  savedRequestId: string | null
  collectionId: string | null
  folderId: string | null
  sourceHistoryId?: string | null
  sourceCapsuleId?: string | null
  name: string
  description?: string
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
  dirty: boolean
  isSending: boolean
  response: ExecuteRequestResponse | null
  pinnedResponse: ExecuteRequestResponse | null
  lastError: string | null
}

function pushBrowserPath(nextPath: string) {
  if (typeof window === 'undefined') return
  if (window.location.pathname !== nextPath) {
    window.history.pushState(null, '', nextPath)
  }
}

function makeId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createBlankTab(overrides?: Partial<RequestTab>): RequestTab {
  const base: RequestTab = {
    tabId: makeId(),
    workspaceId: null,
    savedRequestId: null,
    collectionId: null,
    folderId: null,
    sourceHistoryId: null,
    sourceCapsuleId: null,
    name: 'Untitled Request',
    description: '',
    protocol: 'http',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/users/1',
    queryParams: [],
    headers: [
      { id: makeId(), key: 'Accept', value: 'application/json', description: '', enabled: true },
    ],
    pathVariables: [],
    auth: { type: 'none' },
    body: { mode: 'none', raw: '', urlencoded: [], multipart: [] },
    graphql: {
      query: 'query ListUsers {\n  users {\n    id\n    name\n    role\n  }\n}',
      variables: '{}',
      operationName: '',
    },
    assertions: [
      { id: makeId(), type: 'status_in_2xx', target: '', expected: '200-299', enabled: true },
    ],
    postResponseVars: [],
    preRequestScript: '',
    testScript: '',
    jsonSchema: '',
    dirty: false,
    isSending: false,
    response: null,
    pinnedResponse: null,
    lastError: null,
    ...overrides,
  }

  if (base.protocol !== 'websocket' && base.protocol !== 'graphql') {
    const synced = reconcileUrlAndQueryParams(base.url, base.queryParams, makeId)
    base.url = synced.url
    base.queryParams = synced.queryParams
    base.pathVariables = syncPathVariablesFromUrl(base.url, base.pathVariables, makeId)
  }

  return base
}

interface WorkbenchState {
  activeWorkspaceId: string
  activeEnvironmentId: string | null
  initializedEnvWsIds: string[]
  sidebarSection: SidebarSection
  sidebarSubTab: string | null
  splitDirection: 'vertical' | 'horizontal'
  tabs: RequestTab[]
  activeTabId: string
  consoleEntries: Array<{
    id: string
    timestamp: string
    level: 'info' | 'warn' | 'error'
    message: string
  }>

  setActiveWorkspaceId: (id: string) => void
  setActiveEnvironmentId: (id: string | null) => void
  markEnvInitializedForWorkspace: (wsId: string) => void
  setSidebarSection: (section: SidebarSection, subTab?: string | null) => void
  syncRouteFromPathname: (pathname: string) => void
  toggleSplitDirection: () => void

  addBlankTab: (overrides?: Partial<RequestTab>) => void
  openCapturedRun: (overrides: Partial<RequestTab>) => void
  openSavedRequest: (req: {
    id: string
    workspaceId?: string
    collectionId: string
    folderId: string | null
    name: string
    description?: string
    protocol?: RequestProtocol
    method: HttpMethod
    url: string
    queryParams: KeyValueItem[]
    headers: KeyValueItem[]
    pathVariables: KeyValueItem[]
    auth: RequestAuthConfig
    body: RequestBodyConfig
    graphql?: GraphqlPayloadConfig
    assertions: RequestAssertion[]
    postResponseVars?: ResponseVariableExtractor[]
    preRequestScript?: string
    testScript?: string
    jsonSchema?: string
  }) => void
  closeTab: (tabId: string) => void
  closeTabsMatching: (predicate: (tab: RequestTab) => boolean) => void
  setActiveTab: (tabId: string) => void
  updateActiveTab: (patch: Partial<RequestTab>, markDirty?: boolean) => void
  updateTabById: (tabId: string, patch: Partial<RequestTab>, markDirty?: boolean) => void
  appendConsoleLogs: (
    logs: Array<{ timestamp: string; level: 'info' | 'warn' | 'error'; message: string }>,
  ) => void
  clearConsole: () => void
}

const initialTab = createBlankTab()
const initialRoute =
  typeof window !== 'undefined' ? parseWorkspacePath(window.location.pathname) : null

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      activeWorkspaceId: '',
      activeEnvironmentId: null,
      initializedEnvWsIds: [],
      sidebarSection: initialRoute?.section ?? 'collections',
      sidebarSubTab: initialRoute?.subTab ?? null,
      splitDirection: 'vertical',
      tabs: [initialTab],
      activeTabId: initialTab.tabId,
      consoleEntries: [],

      setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),
      setActiveEnvironmentId: (id) => set({ activeEnvironmentId: id }),
      markEnvInitializedForWorkspace: (wsId) =>
        set((s) =>
          s.initializedEnvWsIds.includes(wsId)
            ? s
            : { initializedEnvWsIds: [...s.initializedEnvWsIds, wsId] },
        ),

      setSidebarSection: (section, subTab = null) => {
        pushBrowserPath(buildSectionPath(section, subTab))
        set({ sidebarSection: section, sidebarSubTab: subTab })
      },

      syncRouteFromPathname: (pathname) => {
        const parsed = parseWorkspacePath(pathname)
        if (!parsed) return
        set((state) => {
          if (state.sidebarSection === parsed.section && state.sidebarSubTab === parsed.subTab) {
            return state
          }
          return {
            sidebarSection: parsed.section,
            sidebarSubTab: parsed.subTab,
          }
        })
      },

      toggleSplitDirection: () =>
        set((s) => ({
          splitDirection: s.splitDirection === 'vertical' ? 'horizontal' : 'vertical',
        })),

      addBlankTab: (overrides) => {
        pushBrowserPath('/collections')
        set((state) => {
          const next = createBlankTab(overrides)
          return {
            tabs: [...state.tabs, next],
            activeTabId: next.tabId,
            sidebarSection: 'collections',
            sidebarSubTab: null,
          }
        })
      },

      openCapturedRun: (overrides) =>
        set((state) => {
          const next = createBlankTab(overrides)
          return {
            tabs: [...state.tabs, next],
            activeTabId: next.tabId,
          }
        }),

      openSavedRequest: (req) => {
        pushBrowserPath('/collections')
        set((state) => {
          const existing = state.tabs.find((t) => t.savedRequestId === req.id)
          if (existing) {
            return {
              activeTabId: existing.tabId,
              sidebarSection: 'collections',
              sidebarSubTab: null,
            }
          }
          const next = createBlankTab({
            workspaceId: req.workspaceId ?? state.activeWorkspaceId ?? null,
            savedRequestId: req.id,
            collectionId: req.collectionId,
            folderId: req.folderId,
            name: req.name,
            description: req.description ?? '',
            protocol: req.protocol ?? 'http',
            method: req.method,
            url: req.url,
            queryParams: req.queryParams,
            headers: req.headers,
            pathVariables: req.pathVariables,
            auth: req.auth,
            body: req.body,
            graphql: req.graphql ?? {
              query: 'query ListUsers {\n  users {\n    id\n    name\n    role\n  }\n}',
              variables: '{}',
              operationName: '',
            },
            assertions: req.assertions,
            postResponseVars: req.postResponseVars ?? [],
            preRequestScript: req.preRequestScript ?? '',
            testScript: req.testScript ?? '',
            jsonSchema: req.jsonSchema ?? '',
            dirty: false,
          })
          return {
            tabs: [...state.tabs, next],
            activeTabId: next.tabId,
            sidebarSection: 'collections',
            sidebarSubTab: null,
          }
        })
      },

      closeTab: (tabId) =>
        set((state) => {
          const filtered = state.tabs.filter((t) => t.tabId !== tabId)
          if (filtered.length === 0) {
            const fresh = createBlankTab()
            return { tabs: [fresh], activeTabId: fresh.tabId }
          }
          const nextActive =
            state.activeTabId === tabId
              ? filtered[filtered.length - 1]!.tabId
              : state.activeTabId
          return { tabs: filtered, activeTabId: nextActive }
        }),

      closeTabsMatching: (predicate) =>
        set((state) => {
          const filtered = state.tabs.filter((t) => !predicate(t))
          if (filtered.length === state.tabs.length) return state
          if (filtered.length === 0) {
            const fresh = createBlankTab()
            return { tabs: [fresh], activeTabId: fresh.tabId }
          }
          const activeStillExists = filtered.some((t) => t.tabId === state.activeTabId)
          return {
            tabs: filtered,
            activeTabId: activeStillExists
              ? state.activeTabId
              : filtered[filtered.length - 1]!.tabId,
          }
        }),

      setActiveTab: (tabId) => set({ activeTabId: tabId }),

      updateActiveTab: (patch, markDirty = true) =>
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === state.activeTabId
              ? { ...t, ...patch, dirty: markDirty ? true : (patch.dirty ?? t.dirty) }
              : t,
          ),
        })),

      updateTabById: (tabId, patch, markDirty = false) =>
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? { ...t, ...patch, dirty: markDirty ? true : (patch.dirty ?? t.dirty) }
              : t,
          ),
        })),

      appendConsoleLogs: (logs) =>
        set((state) => ({
          consoleEntries: [
            ...state.consoleEntries,
            ...logs.map((l) => ({ ...l, id: makeId() })),
          ].slice(-120),
        })),

      clearConsole: () => set({ consoleEntries: [] }),
    }),
    {
      name: 'meofast-workbench-v1',
      partialize: (state) => ({
        activeWorkspaceId: state.activeWorkspaceId,
        activeEnvironmentId: state.activeEnvironmentId,
        initializedEnvWsIds: state.initializedEnvWsIds,
        splitDirection: state.splitDirection,
        tabs: state.tabs.map((t) => ({ ...t, isSending: false })),
        activeTabId: state.activeTabId,
      }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState as Partial<WorkbenchState> | undefined) ?? {}
        const merged = { ...currentState, ...persisted }
        if (Array.isArray(merged.tabs)) {
          merged.tabs = merged.tabs.map((t) => {
            if (t.protocol === 'websocket' || t.protocol === 'graphql') return t
            const synced = reconcileUrlAndQueryParams(t.url ?? '', t.queryParams ?? [], makeId)
            return {
              ...t,
              url: synced.url,
              queryParams: synced.queryParams,
              pathVariables: syncPathVariablesFromUrl(
                synced.url,
                t.pathVariables ?? [],
                makeId,
              ),
            }
          })
        }
        return merged
      },
    },
  ),
)
