'use client'

import {
  type AssertionType,
  buildUrlFromQueryParams,
  type DeclarativeAssertionType,
  HTTP_METHODS,
  type HttpMethod,
  type KeyValueItem,
  REQUEST_PROTOCOLS,
  reconcileUrlAndQueryParams,
  type RequestAssertion,
  type RequestAuthConfig,
  type RequestBodyConfig,
  type RequestProtocol,
  type ResponseVariableExtractor,
  type ResponseVariableSource,
  syncPathVariablesFromUrl,
  syncQueryParamsFromUrl,
} from '@meofast/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutGroup, motion } from 'motion/react'
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
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
  MethodBadge,
  renderMethodOption,
  renderMethodTrigger,
  ResizableSplit,
  Select,
  Tabs,
  useConfirm,
  useToast,
  VariableInput,
} from '@/components/ui'
import { apiRequest } from '@/lib/api-client'
import { cn, formatShortTime } from '@/utils/cn'
import { useWorkspaceVariables } from '../hooks/useWorkspaceVariables'
import { type RequestTab, useWorkbenchStore } from '../store/useWorkbenchStore'
import { parsePastedCurl } from '../utils/parse-curl'
import { decodeJwtToken } from '../utils/type-generator'
import { CodeSnippetModal } from './CodeSnippetModal'
import { KeyValueEditor } from './KeyValueEditor'

interface RequestPaneProps {
  workspaceId: string
  activeTab: RequestTab
  onSend: () => void
  onCancel: () => void
  onOpenSaveModal: () => void
  responseSlot?: ReactNode
}

const PROTOCOL_OPTIONS: Array<{ value: RequestProtocol; label: string }> = [
  { value: 'http', label: 'HTTP' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'websocket', label: 'WebSocket' },
  { value: 'sse', label: 'SSE' },
  { value: 'soap', label: 'SOAP' },
  { value: 'grpc', label: 'gRPC' },
]

const ASSERTION_OPTIONS: Array<{ value: DeclarativeAssertionType; label: string }> = [
  { value: 'status_equals', label: 'Status Code Equals' },
  { value: 'status_in_2xx', label: 'Status Is 2xx' },
  { value: 'duration_lt', label: 'Response Time < (ms)' },
  { value: 'header_exists', label: 'Header Exists' },
  { value: 'header_equals', label: 'Header Equals' },
  { value: 'json_path_equals', label: 'JSON Path Equals' },
  { value: 'body_contains', label: 'Body Contains Text' },
]

const POST_VAR_SOURCE_OPTIONS: Array<{ value: ResponseVariableSource; label: string }> = [
  { value: 'body', label: 'JSON Body Path' },
  { value: 'header', label: 'Response Header' },
  { value: 'cookie', label: 'Set-Cookie' },
  { value: 'status', label: 'HTTP Status Code' },
]

function suggestTokenPathsFromJson(
  obj: unknown,
  prefix = '',
  depth = 0,
): Array<{ path: string; suggestedVar: string }> {
  if (depth > 2 || obj === null || typeof obj !== 'object' || Array.isArray(obj)) return []
  const out: Array<{ path: string; suggestedVar: string }> = []
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const fullPath = prefix ? `${prefix}.${k}` : k
    if (
      (typeof v === 'string' || typeof v === 'number') &&
      /(token|jwt|session|key|id|secret|csrf)/i.test(k)
    ) {
      const camel = k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())
      out.push({ path: fullPath, suggestedVar: camel })
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...suggestTokenPathsFromJson(v, fullPath, depth + 1))
    }
  }
  return out.slice(0, 6)
}

function inferJsonSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4 || value === null) return { type: 'null' }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length > 0 ? inferJsonSchema(value[0], depth + 1) : {},
    }
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    const properties: Record<string, unknown> = {}
    for (const k of keys) {
      properties[k] = inferJsonSchema(obj[k], depth + 1)
    }
    return {
      type: 'object',
      required: keys,
      properties,
    }
  }
  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'integer' : 'number' }
  }
  return { type: typeof value }
}

interface WsFrameItem {
  id: string
  direction: 'sent' | 'received' | 'system'
  data: string
  timestamp: string
}

interface GqlFieldInfo {
  name: string
  description?: string | null
}

interface GqlTypeInfo {
  kind: string
  name: string
  description?: string | null
  fields?: GqlFieldInfo[] | null
}

export function RequestPane({
  workspaceId,
  activeTab,
  onSend,
  onCancel,
  onOpenSaveModal,
  responseSlot,
}: RequestPaneProps) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const {
    tabs,
    activeTabId,
    activeEnvironmentId,
    splitDirection,
    setActiveTab,
    closeTab,
    addBlankTab,
    updateActiveTab,
    updateTabById,
  } = useWorkbenchStore()

  const reconciledTabIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (reconciledTabIdsRef.current.has(activeTab.tabId)) return
    reconciledTabIdsRef.current.add(activeTab.tabId)
    if (activeTab.protocol === 'websocket' || activeTab.protocol === 'graphql') return

    const synced = reconcileUrlAndQueryParams(activeTab.url, activeTab.queryParams)
    const syncedPathVars = syncPathVariablesFromUrl(synced.url, activeTab.pathVariables)
    const paramsChanged =
      JSON.stringify(synced.queryParams) !== JSON.stringify(activeTab.queryParams)
    const urlChanged = synced.url !== activeTab.url
    const pathVarsChanged =
      JSON.stringify(syncedPathVars) !== JSON.stringify(activeTab.pathVariables)

    if (paramsChanged || urlChanged || pathVarsChanged) {
      updateTabById(
        activeTab.tabId,
        {
          url: synced.url,
          queryParams: synced.queryParams,
          pathVariables: syncedPathVars,
        },
        false,
      )
    }
  }, [
    activeTab.pathVariables,
    activeTab.protocol,
    activeTab.queryParams,
    activeTab.tabId,
    activeTab.url,
    updateTabById,
  ])

  const {
    variables: workspaceVariables,
    defaultTargetEnvId,
    defaultTargetLabel,
    saveVariable,
  } = useWorkspaceVariables(workspaceId, activeTab.collectionId, activeTab.folderId)

  const [editorSection, setEditorSection] = useState<
    | 'params'
    | 'graphql'
    | 'auth'
    | 'headers'
    | 'body'
    | 'vars'
    | 'scripts'
    | 'tests'
    | 'schema'
    | 'comments'
  >('params')
  const [scriptPhase, setScriptPhase] = useState<'pre' | 'post'>('post')
  const [jsonFormatError, setJsonFormatError] = useState<string | null>(null)
  const [snippetModalOpen, setSnippetModalOpen] = useState(false)
  const [renameTabOpen, setRenameTabOpen] = useState(false)
  const [renameTabDraft, setRenameTabDraft] = useState('')

  // WebSocket interactive state
  const [wsSessionId, setWsSessionId] = useState<string | null>(null)
  const [wsStatus, setWsStatus] = useState<'disconnected' | 'open' | 'closed' | 'error'>(
    'disconnected',
  )
  const [wsMessages, setWsMessages] = useState<WsFrameItem[]>([])
  const [wsDraft, setWsDraft] = useState('{\n  "action": "ping",\n  "message": "Hello Meetofast"\n}')
  const [wsBusy, setWsBusy] = useState(false)

  // GraphQL Introspection state
  const [gqlTypes, setGqlTypes] = useState<GqlTypeInfo[]>([])
  const [gqlIntrospecting, setGqlIntrospecting] = useState(false)
  const [gqlError, setGqlError] = useState<string | null>(null)

  // OAuth2 Token Helper state
  const [oauthFetching, setOauthFetching] = useState(false)
  const [oauthStatusMsg, setOauthStatusMsg] = useState<string | null>(null)

  // AI / Smart Test Generator state
  const [generatingTests, setGeneratingTests] = useState(false)

  // Comments state
  const [commentText, setCommentText] = useState('')

  const commentsQuery = useQuery({
    queryKey: ['request-comments', activeTab.savedRequestId],
    enabled: Boolean(activeTab.savedRequestId),
    queryFn: () =>
      apiRequest<{
        comments: Array<{
          id: string
          authorName: string
          body: string
          createdAt: string
        }>
      }>(`/api/v1/requests/${activeTab.savedRequestId}/comments`),
  })

  const parentTreeQuery = useQuery({
    queryKey: ['workspace-tree', workspaceId],
    enabled: Boolean(workspaceId && activeTab.collectionId),
    queryFn: () =>
      apiRequest<{
        collections: Array<{
          id: string
          name: string
          auth?: RequestAuthConfig
          headers?: KeyValueItem[]
          folders: Array<{
            id: string
            parentFolderId: string | null
            name: string
            auth?: RequestAuthConfig
            headers?: KeyValueItem[]
          }>
        }>
      }>(`/api/v1/workspaces/${workspaceId}/tree`),
  })

  const addCommentMutation = useMutation({
    mutationFn: async () => {
      if (!activeTab.savedRequestId) return
      await apiRequest(`/api/v1/requests/${activeTab.savedRequestId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: commentText.trim() }),
      })
    },
    onSuccess: async () => {
      setCommentText('')
      toast.success('Comment posted')
      await queryClient.invalidateQueries({
        queryKey: ['request-comments', activeTab.savedRequestId],
      })
    },
    onError: (err) => {
      toast.error('Failed to post comment', err instanceof Error ? err.message : undefined)
    },
  })

  const renameTabMutation = useMutation({
    mutationFn: async (nextName: string) => {
      if (activeTab.savedRequestId) {
        await apiRequest(`/api/v1/requests/${activeTab.savedRequestId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: nextName }),
        })
      }
      return nextName
    },
    onSuccess: async (nextName) => {
      updateActiveTab({ name: nextName }, !activeTab.savedRequestId)
      setRenameTabOpen(false)
      toast.success('Request renamed', nextName)
      if (activeTab.savedRequestId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workspace-tree', workspaceId] }),
          queryClient.invalidateQueries({ queryKey: ['profile-overview'] }),
        ])
      }
    },
    onError: (err) => {
      toast.error('Failed to rename request', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteCommentMutation = useMutation({
    mutationFn: async (commentId: string) => {
      await apiRequest(`/api/v1/comments/${commentId}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      toast.info('Comment deleted')
      await queryClient.invalidateQueries({
        queryKey: ['request-comments', activeTab.savedRequestId],
      })
    },
    onError: (err) => {
      toast.error('Failed to delete comment', err instanceof Error ? err.message : undefined)
    },
  })

  const handleProtocolChange = (nextProto: RequestProtocol) => {
    const patch: Partial<RequestTab> = { protocol: nextProto }
    if (nextProto === 'graphql') {
      if (activeTab.url.includes('jsonplaceholder')) {
        patch.url = '/api/v1/playground/graphql'
      }
      setEditorSection('graphql')
    } else if (nextProto === 'websocket') {
      if (!activeTab.url.startsWith('ws')) {
        patch.url = 'ws://meofast.local/echo'
      }
    } else if (nextProto === 'sse') {
      if (activeTab.url.includes('jsonplaceholder')) {
        patch.url = '/api/v1/playground/sse'
      }
    } else if (nextProto === 'soap') {
      patch.method = 'POST'
      patch.body = {
        ...activeTab.body,
        mode: 'xml',
        raw:
          activeTab.body.raw ||
          '<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n  <soap:Body>\n    <GetStatus xmlns="http://tempuri.org/" />\n  </soap:Body>\n</soap:Envelope>',
      }
      setEditorSection('body')
    } else if (nextProto === 'grpc') {
      patch.method = 'POST'
      patch.body = {
        ...activeTab.body,
        mode: 'json',
        raw: activeTab.body.raw || '{\n  "id": "1"\n}',
      }
      setEditorSection('body')
    } else if (editorSection === 'graphql') {
      setEditorSection('params')
    }
    updateActiveTab(patch)
  }

  const handleUrlKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (activeTab.protocol === 'websocket') {
        void handleWsConnectToggle()
      } else {
        onSend()
      }
    }
  }

  const handleCloseTabSafely = async (tab: RequestTab) => {
    if (tab.dirty) {
      const ok = await confirm({
        title: 'Discard unsaved changes?',
        description: `Tab "${tab.name}" has unsaved changes. Closing it now will permanently discard those changes.`,
        confirmLabel: 'Close Without Saving',
        variant: 'warning',
      })
      if (!ok) return
    }
    closeTab(tab.tabId)
  }

  const handleWsConnectToggle = async () => {
    if (wsStatus === 'open' && wsSessionId) {
      const ok = await confirm({
        title: 'Disconnect WebSocket?',
        description: 'Active live WebSocket connection will be closed.',
        confirmLabel: 'Disconnect',
        variant: 'warning',
      })
      if (!ok) return
      setWsBusy(true)
      try {
        const res = await apiRequest<{ status: string; messages: WsFrameItem[] }>(
          `/api/v1/proxy/ws/${wsSessionId}/disconnect`,
          { method: 'POST', body: '{}' },
        )
        setWsStatus('closed')
        setWsMessages(res.messages)
        toast.info('WebSocket disconnected')
      } finally {
        setWsBusy(false)
      }
      return
    }

    setWsBusy(true)
    try {
      const res = await apiRequest<{
        sessionId: string
        status: 'open' | 'closed' | 'error'
        messages: WsFrameItem[]
      }>('/api/v1/proxy/ws/connect', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          environmentId: activeEnvironmentId,
          url: activeTab.url,
          headers: activeTab.headers,
        }),
      })
      setWsSessionId(res.sessionId)
      setWsStatus(res.status)
      setWsMessages(res.messages)
    } catch (err) {
      setWsStatus('error')
      setWsMessages([
        {
          id: crypto.randomUUID(),
          direction: 'system',
          data: err instanceof Error ? err.message : 'Failed to connect',
          timestamp: new Date().toISOString(),
        },
      ])
    } finally {
      setWsBusy(false)
    }
  }

  const handleWsSendFrame = async () => {
    if (!wsSessionId || wsStatus !== 'open' || !wsDraft.trim()) return
    setWsBusy(true)
    try {
      const res = await apiRequest<{ status: 'open' | 'closed' | 'error'; messages: WsFrameItem[] }>(
        `/api/v1/proxy/ws/${wsSessionId}/send`,
        {
          method: 'POST',
          body: JSON.stringify({ message: wsDraft }),
        },
      )
      setWsStatus(res.status)
      setWsMessages(res.messages)
    } finally {
      setWsBusy(false)
    }
  }

  const handleIntrospectGraphql = async () => {
    setGqlIntrospecting(true)
    setGqlError(null)
    try {
      const res = await apiRequest<{ schema: { types?: GqlTypeInfo[] } }>(
        '/api/v1/proxy/graphql/introspect',
        {
          method: 'POST',
          body: JSON.stringify({
            workspaceId,
            environmentId: activeEnvironmentId,
            url: activeTab.url,
            headers: activeTab.headers,
            auth: activeTab.auth,
          }),
        },
      )
      const userTypes = (res.schema.types ?? []).filter((t) => !t.name.startsWith('__'))
      setGqlTypes(userTypes)
      toast.success('Schema introspected', `Loaded ${userTypes.length} GraphQL types.`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Introspection failed'
      setGqlError(msg)
      toast.error('Introspection failed', msg)
    } finally {
      setGqlIntrospecting(false)
    }
  }

  const handleFetchOAuth2Token = async () => {
    if (activeTab.auth.type !== 'oauth2') return
    setOauthFetching(true)
    setOauthStatusMsg(null)
    try {
      const tokenUrl = activeTab.auth.tokenUrl || '/api/v1/playground/oauth/token'
      const res = await apiRequest<{ accessToken: string }>('/api/v1/proxy/oauth2/token', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          environmentId: activeEnvironmentId,
          grantType: activeTab.auth.grantType ?? 'client_credentials',
          tokenUrl,
          clientId: activeTab.auth.clientId ?? '',
          clientSecret: activeTab.auth.clientSecret ?? '',
          scope: activeTab.auth.scope ?? '',
          username: activeTab.auth.username ?? '',
          password: activeTab.auth.password ?? '',
        }),
      })
      updateActiveTab({
        auth: {
          ...activeTab.auth,
          tokenUrl,
          accessToken: res.accessToken,
        },
      })
      setOauthStatusMsg('Token fetched and applied.')
      toast.success('OAuth 2.0 token fetched', 'Access token applied to request.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch token'
      setOauthStatusMsg(msg)
      toast.error('OAuth 2.0 token failed', msg)
    } finally {
      setOauthFetching(false)
    }
  }

  const handleSmartGenerateTests = async () => {
    setGeneratingTests(true)
    try {
      const res = await apiRequest<{ output: string }>('/api/v1/ai/assist', {
        method: 'POST',
        body: JSON.stringify({
          task: 'generate_tests',
          method: activeTab.method,
          url: activeTab.url,
          responseStatus: activeTab.response?.status ?? null,
          responseBody: activeTab.response?.body ?? '',
        }),
      })
      setScriptPhase('post')
      updateActiveTab({
        testScript: activeTab.testScript
          ? `${activeTab.testScript.trimEnd()}\n\n${res.output}`
          : res.output,
      })
      toast.success('Test assertions generated')
    } catch (err) {
      toast.error('Failed to generate tests', err instanceof Error ? err.message : undefined)
    } finally {
      setGeneratingTests(false)
    }
  }

  const handleBinaryFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '')
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1]! : ''
      updateActiveTab({
        body: {
          ...activeTab.body,
          mode: 'binary',
          binaryBase64: base64,
          binaryFileName: file.name,
          binaryContentType: file.type || 'application/octet-stream',
        },
      })
    }
    reader.readAsDataURL(file)
  }

  const handleFormatJson = () => {
    setJsonFormatError(null)
    try {
      const parsed = JSON.parse(activeTab.body.raw || '{}')
      updateActiveTab({
        body: {
          ...activeTab.body,
          mode: 'json',
          raw: JSON.stringify(parsed, null, 2),
        },
      })
    } catch {
      setJsonFormatError('Invalid JSON syntax.')
    }
  }

  const handleGenerateSchemaFromResponse = () => {
    if (!activeTab.response?.body) return
    try {
      const parsed = JSON.parse(activeTab.response.body)
      const schema = inferJsonSchema(parsed)
      updateActiveTab({ jsonSchema: JSON.stringify(schema, null, 2) })
      setEditorSection('schema')
    } catch {
      // response is not JSON
    }
  }

  const addAssertion = () => {
    const next: RequestAssertion = {
      id: crypto.randomUUID(),
      type: 'status_equals',
      target: '',
      expected: '200',
      enabled: true,
    }
    updateActiveTab({ assertions: [...activeTab.assertions, next] })
  }

  const updateAssertion = (id: string, patch: Partial<RequestAssertion>) => {
    updateActiveTab({
      assertions: activeTab.assertions.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })
  }

  const removeAssertion = async (rule: RequestAssertion) => {
    const ok = await confirm({
      title: 'Delete assertion?',
      description: 'This test assertion rule will be removed from the request.',
      confirmLabel: 'Delete Assertion',
    })
    if (!ok) return
    updateActiveTab({
      assertions: activeTab.assertions.filter((a) => a.id !== rule.id),
    })
    toast.info('Assertion removed')
  }

  const postVarsList = activeTab.postResponseVars ?? []

  const addPostVarExtractor = (preset?: { varName: string; path: string }) => {
    const next: ResponseVariableExtractor = {
      id: crypto.randomUUID(),
      varName: preset?.varName ?? '',
      source: 'body',
      path: preset?.path ?? '',
      enabled: true,
    }
    updateActiveTab({ postResponseVars: [...postVarsList, next] })
  }

  const updatePostVarExtractor = (id: string, patch: Partial<ResponseVariableExtractor>) => {
    updateActiveTab({
      postResponseVars: postVarsList.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    })
  }

  const removePostVarExtractor = async (item: ResponseVariableExtractor) => {
    const ok = await confirm({
      title: 'Delete variable capture rule?',
      description: item.varName.trim()
        ? `Stop capturing "{{${item.varName.trim()}}}" from the response?`
        : 'Remove this post-response variable capture row?',
      confirmLabel: 'Delete Rule',
    })
    if (!ok) return
    updateActiveTab({
      postResponseVars: postVarsList.filter((r) => r.id !== item.id),
    })
    toast.info('Capture rule removed')
  }

  const suggestedResponseTokens = (() => {
    if (!activeTab.response?.isJson || !activeTab.response.body) return []
    try {
      const parsed = JSON.parse(activeTab.response.body)
      return suggestTokenPathsFromJson(parsed).filter(
        (s) => !postVarsList.some((r) => r.path === s.path),
      )
    } catch {
      return []
    }
  })()

  const parentInheritanceSummary = (() => {
    if (!activeTab.collectionId) {
      return {
        resolvedAuthSource: null as string | null,
        resolvedAuthType: 'none' as RequestAuthConfig['type'],
        inheritedHeadersCount: 0,
      }
    }
    const col = (parentTreeQuery.data?.collections ?? []).find(
      (c) => c.id === activeTab.collectionId,
    )
    if (!col) {
      return {
        resolvedAuthSource: null as string | null,
        resolvedAuthType: 'none' as RequestAuthConfig['type'],
        inheritedHeadersCount: 0,
      }
    }

    const folderChain: typeof col.folders = []
    if (activeTab.folderId) {
      const seen = new Set<string>()
      let cursor: string | null = activeTab.folderId
      while (cursor && !seen.has(cursor) && seen.size < 16) {
        seen.add(cursor)
        const f = col.folders.find((item) => item.id === cursor)
        if (!f) break
        folderChain.unshift(f)
        cursor = f.parentFolderId
      }
    }

    let resolvedAuthSource: string | null = null
    let resolvedAuthType: RequestAuthConfig['type'] = 'none'
    for (let i = folderChain.length - 1; i >= 0; i -= 1) {
      const f = folderChain[i]!
      if (f.auth && f.auth.type !== 'inherit' && f.auth.type !== 'none') {
        resolvedAuthSource = `Folder "${f.name}"`
        resolvedAuthType = f.auth.type
        break
      }
    }
    if (!resolvedAuthSource && col.auth && col.auth.type !== 'inherit' && col.auth.type !== 'none') {
      resolvedAuthSource = `Collection "${col.name}"`
      resolvedAuthType = col.auth.type
    }

    const inheritedHeadersCount =
      (col.headers ?? []).filter((h) => h.enabled && h.key.trim()).length +
      folderChain.reduce(
        (sum, f) => sum + (f.headers ?? []).filter((h) => h.enabled && h.key.trim()).length,
        0,
      )

    return { resolvedAuthSource, resolvedAuthType, inheritedHeadersCount }
  })()

  const insertScriptSnippet = (snippet: string) => {
    if (scriptPhase === 'pre') {
      const next = activeTab.preRequestScript
        ? `${activeTab.preRequestScript.trimEnd()}\n\n${snippet}`
        : snippet
      updateActiveTab({ preRequestScript: next })
    } else {
      const next = activeTab.testScript
        ? `${activeTab.testScript.trimEnd()}\n\n${snippet}`
        : snippet
      updateActiveTab({ testScript: next })
    }
  }

  const hasPathParamInUrl = /\/:[a-zA-Z_][a-zA-Z0-9_-]*/.test(
    activeTab.url.replace(/^https?:\/\/[^/]+/i, ''),
  )
  const hasScripts = Boolean(activeTab.preRequestScript.trim() || activeTab.testScript.trim())
  const commentList = commentsQuery.data?.comments ?? []

  const referencedVariables = Array.from(
    new Set(
      [
        activeTab.url,
        activeTab.body.raw,
        ...activeTab.queryParams.map((p) => `${p.key} ${p.value}`),
        ...activeTab.headers.map((h) => `${h.key} ${h.value}`),
        ...activeTab.pathVariables.map((p) => `${p.key} ${p.value}`),
        JSON.stringify(activeTab.auth),
      ]
        .join(' ')
        .match(/\{\{\s*([a-zA-Z0-9_$.-]+)\s*\}\}/g)
        ?.map((token) => token.replace(/\s+/g, '')) ?? [],
    ),
  )

  return (
    <section
      aria-label="API Request Editor"
      className="h-full flex-1 min-h-0 flex flex-col bg-[var(--color-surface)] overflow-hidden"
    >
      {/* Seamless Connected Request Tab Strip (No HR / Border Line) */}
      <LayoutGroup id="meofast-request-tabs">
        <div className="flex items-end gap-0.5 px-2.5 pt-1.5 bg-[var(--color-surface-secondary)] overflow-x-auto shrink-0">
          {tabs.map((tab, idx) => {
            const isCurrent = tab.tabId === activeTabId
            const nextIsCurrent = tabs[idx + 1]?.tabId === activeTabId
            return (
              <div
                key={tab.tabId}
                onClick={() => setActiveTab(tab.tabId)}
                onDoubleClick={() => {
                  setActiveTab(tab.tabId)
                  setRenameTabDraft(tab.name)
                  setRenameTabOpen(true)
                }}
                title="Double-click to rename"
                className={cn(
                  'group relative h-8 inline-flex items-center gap-1.5 px-3 text-xs cursor-pointer shrink-0 max-w-[215px] select-none transition-colors',
                  isCurrent
                    ? 'z-10 text-[var(--color-text)] font-medium'
                    : 'z-0 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] rounded-t-[8px] hover:bg-[var(--color-surface)]/50',
                )}
              >
                {isCurrent ? (
                  <motion.div
                    layoutId="request-editor-active-tab"
                    transition={{ type: 'spring', stiffness: 460, damping: 36, mass: 0.65 }}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-0"
                  >
                    <div className="w-full h-full rounded-t-[10px] bg-[var(--color-surface)]" />
                    <svg
                      viewBox="0 0 11 10"
                      className="absolute -left-[10px] bottom-0 w-[11px] h-[10px] block"
                      style={{ fill: 'var(--color-surface)' }}
                    >
                      <path d="M 11 0 L 10 0 C 10 5.8 5.8 10 0 10 L 11 10 Z" />
                    </svg>
                    <svg
                      viewBox="0 0 11 10"
                      className="absolute -right-[10px] bottom-0 w-[11px] h-[10px] block"
                      style={{ fill: 'var(--color-surface)' }}
                    >
                      <path d="M 0 0 L 1 0 C 1 5.8 5.2 10 11 10 L 0 10 Z" />
                    </svg>
                  </motion.div>
                ) : null}

                <span className="relative z-10 inline-flex items-center gap-2 min-w-0">
                  {tab.protocol && tab.protocol !== 'http' ? (
                    <Badge variant="info">{tab.protocol.toUpperCase()}</Badge>
                  ) : (
                    <MethodBadge method={tab.method} compact active={isCurrent} />
                  )}
                  <span className="truncate">{tab.name}</span>
                  {tab.isSending ? (
                    <span
                      title="Running in background..."
                      className="w-2.5 h-2.5 rounded-full border-2 border-[var(--color-primary)] border-t-transparent animate-spin shrink-0"
                    />
                  ) : tab.dirty ? (
                    <span
                      title="Unsaved changes"
                      className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] shrink-0"
                    />
                  ) : null}
                  <button
                    type="button"
                    aria-label={`Close ${tab.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleCloseTabSafely(tab)
                    }}
                    className="w-5 h-5 inline-flex items-center justify-center rounded-[var(--radius-sm)] hover:bg-[var(--color-surface-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer shrink-0"
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>

                {!isCurrent && !nextIsCurrent && idx < tabs.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute right-0 top-2.5 bottom-2.5 w-px bg-[var(--color-border-strong)]/60"
                  />
                ) : null}
              </div>
            )
          })}

          <button
            type="button"
            aria-label="New Request Tab"
            title="New Request Tab"
            onClick={() => addBlankTab()}
            className="w-6 h-6 mb-1 ml-1 inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]/70 hover:text-[var(--color-primary)] cursor-pointer shrink-0 transition-colors"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
      </LayoutGroup>

      {/* Unified Full-Width 34px Protocol + Method + URL + Send + Menu Bar */}
      <div className="px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
        <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap">
          <Select
            ariaLabel="Protocol"
            value={activeTab.protocol}
            onValueChange={(val) => handleProtocolChange(val as RequestProtocol)}
            options={
              REQUEST_PROTOCOLS.map(
                (p) => PROTOCOL_OPTIONS.find((o) => o.value === p) ?? { value: p, label: p },
              )
            }
            className="w-[100px] shrink-0"
          />

          <div className="flex flex-1 min-w-[200px] h-[34px] items-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] focus-within:border-[var(--color-primary)] focus-within:ring-3 focus-within:ring-[var(--color-primary)]/18 overflow-hidden transition-all">
            {activeTab.protocol === 'http' || activeTab.protocol === 'soap' ? (
              <Select
                ariaLabel="HTTP Method"
                variant="inline"
                value={activeTab.method}
                onValueChange={(val) => updateActiveTab({ method: val as HttpMethod })}
                options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
                mono
                hideChevron
                className="w-[74px] shrink-0"
                triggerClassName="justify-center px-1"
                popoverWidth={76}
                renderTrigger={(opt) => renderMethodTrigger(opt, activeTab.method)}
                renderOption={renderMethodOption}
              />
            ) : null}
            <VariableInput
              variant="bare"
              aria-label="Request URL"
              value={activeTab.url}
              onPaste={(e) => {
                const pasted = e.clipboardData.getData('text')
                const parsed = parsePastedCurl(pasted)
                if (!parsed) return
                e.preventDefault()
                updateActiveTab({
                  protocol: 'http',
                  method: parsed.method,
                  url: parsed.url,
                  queryParams: parsed.queryParams,
                  headers: parsed.headers.length > 0 ? parsed.headers : activeTab.headers,
                  ...(parsed.auth ? { auth: parsed.auth } : {}),
                  ...(parsed.body ? { body: parsed.body } : {}),
                })
                toast.success('cURL imported into request', `${parsed.method} ${parsed.url}`)
              }}
              onChange={(e) => {
                const nextUrl = e.target.value
                if (activeTab.protocol === 'websocket' || activeTab.protocol === 'graphql') {
                  updateActiveTab({ url: nextUrl })
                  return
                }
                updateActiveTab({
                  url: nextUrl,
                  queryParams: syncQueryParamsFromUrl(nextUrl, activeTab.queryParams),
                  pathVariables: syncPathVariablesFromUrl(nextUrl, activeTab.pathVariables),
                })
              }}
              onKeyDown={handleUrlKeyDown}
              variables={workspaceVariables}
              defaultTargetLabel={defaultTargetLabel}
              defaultTargetEnvId={defaultTargetEnvId}
              onSaveVariable={saveVariable}
              placeholder={
                activeTab.protocol === 'websocket'
                  ? 'ws://meofast.local/echo'
                  : activeTab.protocol === 'graphql'
                    ? '/api/v1/playground/graphql'
                    : '{{BASE_URL}}/v1/users/:id'
              }
            />
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {activeTab.protocol === 'websocket' ? (
              <Button
                size="md"
                variant={wsStatus === 'open' ? 'danger' : 'primary'}
                isLoading={wsBusy}
                onClick={handleWsConnectToggle}
                leftIcon={<Icon name={wsStatus === 'open' ? 'x' : 'play'} size={14} />}
              >
                {wsStatus === 'open' ? 'Disconnect' : 'Connect'}
              </Button>
            ) : activeTab.isSending ? (
              <Button
                size="md"
                variant="danger"
                onClick={onCancel}
                leftIcon={<Icon name="x" size={14} />}
              >
                Cancel
              </Button>
            ) : (
              <Button
                size="md"
                variant="primary"
                onClick={onSend}
                leftIcon={<Icon name="send" size={14} />}
                title="Send Request (Ctrl+Enter)"
              >
                {activeTab.protocol === 'sse' ? 'Stream' : 'Send'}
              </Button>
            )}

            <DropdownMenu
              ariaLabel="Request actions"
              widthClassName="w-52"
              triggerClassName="w-[34px] h-[34px] justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
              trigger={() => <Icon name="dots-vertical" size={15} />}
              items={[
                {
                  id: 'save',
                  label: 'Save Request (Ctrl+S)',
                  icon: 'save',
                  onSelect: onOpenSaveModal,
                },
                {
                  id: 'rename-tab',
                  label: 'Rename Request',
                  icon: 'edit',
                  onSelect: () => {
                    setRenameTabDraft(activeTab.name)
                    setRenameTabOpen(true)
                  },
                },
                ...(activeTab.protocol !== 'websocket'
                  ? [
                      {
                        id: 'snippet',
                        label: 'Generate Code Snippet',
                        icon: 'code' as const,
                        onSelect: () => setSnippetModalOpen(true),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        </div>
      </div>

      {/* Split Workspace: Request Tabs + Editor aligned level with Response Pane */}
      {activeTab.protocol === 'websocket' ? (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pt-2.5 pb-3">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    wsStatus === 'open'
                      ? 'success'
                      : wsStatus === 'error'
                        ? 'danger'
                        : 'neutral'
                  }
                >
                  {wsStatus.toUpperCase()}
                </Badge>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  Send text or JSON frames over an active WebSocket session.
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => updateActiveTab({ url: 'ws://meofast.local/echo' })}
              >
                Use Local Echo
              </Button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                    Message Payload
                  </span>
                  <Button
                    size="sm"
                    disabled={wsStatus !== 'open' || !wsDraft.trim()}
                    isLoading={wsBusy}
                    onClick={handleWsSendFrame}
                    leftIcon={<Icon name="send" size={12} />}
                  >
                    Send Frame
                  </Button>
                </div>
                <CodeEditor
                  language="json"
                  value={wsDraft}
                  onChange={setWsDraft}
                  minHeight="150px"
                  ariaLabel="WebSocket outgoing frame"
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                    Message Stream ({wsMessages.length})
                  </span>
                  {wsMessages.length > 0 ? (
                    <Button size="sm" variant="ghost" onClick={() => setWsMessages([])}>
                      Clear
                    </Button>
                  ) : null}
                </div>
                <div className="min-h-[150px] max-h-[260px] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] divide-y divide-[var(--color-border)] text-xs font-mono">
                  {wsMessages.length === 0 ? (
                    <div className="p-6 text-center text-[var(--color-text-muted)] font-sans">
                      Click Connect to start streaming frames.
                    </div>
                  ) : (
                    wsMessages.map((m) => (
                      <div key={m.id} className="p-2.5 flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                          <Badge
                            variant={
                              m.direction === 'sent'
                                ? 'primary'
                                : m.direction === 'received'
                                  ? 'success'
                                  : 'neutral'
                            }
                          >
                            {m.direction.toUpperCase()}
                          </Badge>
                          <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums">
                            {m.timestamp.slice(11, 19)}
                          </span>
                        </div>
                        <pre className="whitespace-pre-wrap break-all text-[var(--color-text)]">
                          {m.data}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
          <ResizableSplit
            direction={splitDirection}
            storageKey={`meofast-workbench-split-${splitDirection}`}
            defaultRatio={0.54}
            first={
              <div className="h-full flex-1 min-h-0 min-w-0 flex flex-col bg-[var(--color-surface)] overflow-hidden">
                <div className="h-[42px] px-3 border-b border-[var(--color-border)] bg-[var(--color-background)] flex items-center shrink-0 overflow-hidden">
                  <Tabs
                    className="w-full flex-nowrap min-w-0"
                    items={[
                      ...(activeTab.protocol === 'graphql'
                        ? [{ id: 'graphql', label: 'GraphQL' }]
                        : [
                            {
                              id: 'params',
                              label: 'Params',
                              count: activeTab.queryParams.filter((p) => p.enabled && p.key).length,
                            },
                          ]),
                      {
                        id: 'auth',
                        label: 'Auth',
                        count:
                          activeTab.auth.type !== 'none' && activeTab.auth.type !== 'inherit'
                            ? 1
                            : 0,
                      },
                      {
                        id: 'headers',
                        label: 'Headers',
                        count: activeTab.headers.filter((h) => h.enabled && h.key).length,
                      },
                      ...(activeTab.protocol !== 'graphql' ? [{ id: 'body', label: 'Body' }] : []),
                      {
                        id: 'vars',
                        label: 'Vars',
                        count: postVarsList.filter((v) => v.enabled && v.varName.trim()).length,
                      },
                      {
                        id: 'scripts',
                        label: 'Scripts',
                        count: hasScripts ? 1 : 0,
                      },
                      {
                        id: 'tests',
                        label: 'Assertions',
                        count: activeTab.assertions.filter((a) => a.enabled).length,
                      },
                      {
                        id: 'schema',
                        label: 'Schema',
                        count: activeTab.jsonSchema.trim() ? 1 : 0,
                      },
                      ...(activeTab.savedRequestId
                        ? [{ id: 'comments', label: 'Comments', count: commentList.length }]
                        : []),
                    ]}
                    activeId={editorSection}
                    onChange={(id) => setEditorSection(id as typeof editorSection)}
                  />
                </div>

                {/* Scrollable Editor Content */}
                <div className="flex-1 min-h-0 overflow-y-auto px-3 pt-2.5 pb-3">

        {editorSection === 'graphql' ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                GraphQL Query & Variables
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => updateActiveTab({ url: '/api/v1/playground/graphql' })}
                >
                  Use Sample Endpoint
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  isLoading={gqlIntrospecting}
                  onClick={handleIntrospectGraphql}
                  leftIcon={<Icon name="refresh" size={12} />}
                >
                  Introspect Schema
                </Button>
              </div>
            </div>

            {gqlError ? (
              <p className="text-xs text-[var(--color-danger)]">{gqlError}</p>
            ) : null}

            <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
                  Query / Mutation
                </span>
                <CodeEditor
                  language="text"
                  value={activeTab.graphql.query}
                  onChange={(query) =>
                    updateActiveTab({ graphql: { ...activeTab.graphql, query } })
                  }
                  minHeight="160px"
                  ariaLabel="GraphQL Query"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
                  Variables (JSON)
                </span>
                <CodeEditor
                  language="json"
                  value={activeTab.graphql.variables}
                  onChange={(variables) =>
                    updateActiveTab({ graphql: { ...activeTab.graphql, variables } })
                  }
                  minHeight="160px"
                  ariaLabel="GraphQL Variables"
                />
              </div>
            </div>

            {gqlTypes.length > 0 ? (
              <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] p-3 flex flex-col gap-2">
                <span className="text-xs font-semibold">
                  Schema Explorer ({gqlTypes.length} types)
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {gqlTypes.map((t) => (
                    <div
                      key={t.name}
                      className="p-2.5 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)] text-xs flex flex-col gap-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-[var(--color-primary)]">
                          {t.name}
                        </span>
                        <Badge variant="neutral">{t.kind}</Badge>
                      </div>
                      {t.fields && t.fields.length > 0 ? (
                        <span className="text-[11px] font-mono text-[var(--color-text-secondary)] truncate">
                          {t.fields.map((f) => f.name).join(', ')}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {editorSection === 'params' ? (
          <div className="flex flex-col gap-4">
            {activeTab.protocol === 'sse' ? (
              <div className="flex items-center justify-between p-2.5 rounded-[var(--radius-md)] bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-xs">
                <span className="text-[var(--color-text-secondary)]">
                  Captures Server-Sent Events into the Events tab.
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => updateActiveTab({ url: '/api/v1/playground/sse' })}
                >
                  Use Sample SSE
                </Button>
              </div>
            ) : null}

            <KeyValueEditor
              items={activeTab.queryParams}
              onChange={(queryParams) =>
                updateActiveTab({
                  queryParams,
                  url: buildUrlFromQueryParams(activeTab.url, queryParams),
                })
              }
              keyPlaceholder="Query param (e.g. page)"
              valuePlaceholder="Value (e.g. 1 or {{limit}})"
              addLabel="Add Query Param"
              variables={workspaceVariables}
              defaultTargetLabel={defaultTargetLabel}
              defaultTargetEnvId={defaultTargetEnvId}
              onSaveVariable={saveVariable}
            />
            {hasPathParamInUrl ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                  Path Variables (:param)
                </span>
                <KeyValueEditor
                  items={activeTab.pathVariables}
                  onChange={(pathVariables) => updateActiveTab({ pathVariables })}
                  keyPlaceholder="Path key (e.g. id)"
                  valuePlaceholder="Value (supports {{variable}})"
                  addLabel="Add Path Variable"
                  variables={workspaceVariables}
                  defaultTargetLabel={defaultTargetLabel}
                  defaultTargetEnvId={defaultTargetEnvId}
                  onSaveVariable={saveVariable}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {editorSection === 'auth' ? (
          <div className="w-full flex flex-col gap-3.5">
            <Select
              label="Authentication"
              value={activeTab.auth.type}
              onValueChange={(val) => {
                const nextType = val as RequestAuthConfig['type']
                const defaults: Record<RequestAuthConfig['type'], RequestAuthConfig> = {
                  inherit: { type: 'inherit' },
                  none: { type: 'none' },
                  bearer: { type: 'bearer', token: '', prefix: 'Bearer' },
                  basic: { type: 'basic', username: '', password: '' },
                  apikey: { type: 'apikey', key: 'X-API-Key', value: '', in: 'header' },
                  oauth2: {
                    type: 'oauth2',
                    accessToken: '',
                    headerPrefix: 'Bearer',
                    grantType: 'client_credentials',
                    tokenUrl: '/api/v1/playground/oauth/token',
                    clientId: '',
                    clientSecret: '',
                    scope: 'read write',
                  },
                  aws_sigv4: {
                    type: 'aws_sigv4',
                    accessKeyId: '',
                    secretAccessKey: '',
                    region: 'us-east-1',
                    service: 'execute-api',
                  },
                  digest: { type: 'digest', username: '', password: '' },
                  oauth1: { type: 'oauth1', consumerKey: '', consumerSecret: '' },
                  custom: { type: 'custom', headerName: 'Authorization', headerValue: '' },
                }
                updateActiveTab({ auth: defaults[nextType] })
              }}
              options={[
                {
                  value: 'inherit',
                  label: 'Inherit Auth from Parent (Collection / Folder)',
                },
                { value: 'none', label: 'No Authentication' },
                { value: 'bearer', label: 'Bearer / JWT Token' },
                { value: 'basic', label: 'Basic Auth' },
                { value: 'apikey', label: 'API Key' },
                { value: 'oauth2', label: 'OAuth 2.0' },
                { value: 'aws_sigv4', label: 'AWS Signature v4' },
                { value: 'digest', label: 'Digest Auth' },
                { value: 'oauth1', label: 'OAuth 1.0' },
                { value: 'custom', label: 'Custom Header' },
              ]}
            />

            {activeTab.auth.type === 'inherit' ? (
              <div className="p-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] flex items-center justify-between gap-3 flex-wrap text-xs">
                {!activeTab.collectionId ? (
                  <span className="text-[var(--color-text-secondary)]">
                    Save this request into a Collection or Folder to inherit shared authentication.
                  </span>
                ) : parentInheritanceSummary.resolvedAuthSource ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Icon name="shield" size={14} className="text-[var(--color-primary)]" />
                    <span className="text-[var(--color-text)]">
                      Inheriting authentication from{' '}
                      <strong>{parentInheritanceSummary.resolvedAuthSource}</strong>
                    </span>
                    <Badge variant="primary">
                      {parentInheritanceSummary.resolvedAuthType.toUpperCase()}
                    </Badge>
                  </div>
                ) : (
                  <span className="text-[var(--color-text-secondary)]">
                    No default authentication configured on parent Collection or Folder yet. Open
                    the Collection or Folder <strong className="text-[var(--color-text)]">⋮</strong>{' '}
                    menu → <strong className="text-[var(--color-text)]">Settings</strong> to set
                    shared auth.
                  </span>
                )}
              </div>
            ) : null}

            {activeTab.auth.type === 'bearer' ? (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3">
                  <Input
                    label="Prefix"
                    value={activeTab.auth.prefix}
                    mono
                    onChange={(e) =>
                      updateActiveTab({
                        auth: {
                          type: 'bearer',
                          token: activeTab.auth.type === 'bearer' ? activeTab.auth.token : '',
                          prefix: e.target.value,
                        },
                      })
                    }
                  />
                  <VariableInput
                    label="Token"
                    value={activeTab.auth.token}
                    placeholder="{{apiToken}} or paste JWT..."
                    variables={workspaceVariables}
                    defaultTargetLabel={defaultTargetLabel}
                    defaultTargetEnvId={defaultTargetEnvId}
                    onSaveVariable={saveVariable}
                    onChange={(e) =>
                      updateActiveTab({
                        auth: {
                          type: 'bearer',
                          prefix:
                            activeTab.auth.type === 'bearer' ? activeTab.auth.prefix : 'Bearer',
                          token: e.target.value,
                        },
                      })
                    }
                  />
                </div>

                {(() => {
                  const jwt = decodeJwtToken(activeTab.auth.token)
                  if (!jwt) return null
                  return (
                    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] p-3.5 flex flex-col gap-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-[var(--color-text)]">
                            Decoded JWT Claims
                          </span>
                          {typeof jwt.header.alg === 'string' ? (
                            <Badge variant="neutral">{jwt.header.alg}</Badge>
                          ) : null}
                        </div>
                        {jwt.expiresAtIso ? (
                          <Badge variant={jwt.isExpired ? 'danger' : 'success'}>
                            {jwt.isExpired
                              ? `Expired (${formatShortTime(jwt.expiresAtIso)})`
                              : `Valid until ${formatShortTime(jwt.expiresAtIso)}`}
                          </Badge>
                        ) : (
                          <Badge variant="info">No exp claim</Badge>
                        )}
                      </div>
                      <pre className="m-0 p-2.5 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)] font-mono text-[11px] overflow-x-auto text-[var(--color-text)]">
                        {JSON.stringify(jwt.payload, null, 2)}
                      </pre>
                    </div>
                  )
                })()}
              </div>
            ) : null}

            {activeTab.auth.type === 'basic' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <VariableInput
                  label="Username"
                  value={activeTab.auth.username}
                  placeholder="{{basicUsername}}"
                  variables={workspaceVariables}
                  defaultTargetLabel={defaultTargetLabel}
                  defaultTargetEnvId={defaultTargetEnvId}
                  onSaveVariable={saveVariable}
                  onChange={(e) =>
                    updateActiveTab({
                      auth: {
                        type: 'basic',
                        username: e.target.value,
                        password: activeTab.auth.type === 'basic' ? activeTab.auth.password : '',
                      },
                    })
                  }
                />
                <VariableInput
                  label="Password"
                  type="password"
                  value={activeTab.auth.password}
                  placeholder="{{basicPassword}}"
                  variables={workspaceVariables}
                  defaultTargetLabel={defaultTargetLabel}
                  defaultTargetEnvId={defaultTargetEnvId}
                  onSaveVariable={saveVariable}
                  onChange={(e) =>
                    updateActiveTab({
                      auth: {
                        type: 'basic',
                        username: activeTab.auth.type === 'basic' ? activeTab.auth.username : '',
                        password: e.target.value,
                      },
                    })
                  }
                />
              </div>
            ) : null}

            {activeTab.auth.type === 'apikey' ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input
                  label="Key Name"
                  value={activeTab.auth.key}
                  mono
                  onChange={(e) =>
                    updateActiveTab({
                      auth: {
                        type: 'apikey',
                        key: e.target.value,
                        value: activeTab.auth.type === 'apikey' ? activeTab.auth.value : '',
                        in: activeTab.auth.type === 'apikey' ? activeTab.auth.in : 'header',
                      },
                    })
                  }
                />
                <VariableInput
                  label="Key Value"
                  value={activeTab.auth.value}
                  placeholder="{{apiKey}}"
                  variables={workspaceVariables}
                  defaultTargetLabel={defaultTargetLabel}
                  defaultTargetEnvId={defaultTargetEnvId}
                  onSaveVariable={saveVariable}
                  onChange={(e) =>
                    updateActiveTab({
                      auth: {
                        type: 'apikey',
                        key: activeTab.auth.type === 'apikey' ? activeTab.auth.key : 'X-API-Key',
                        value: e.target.value,
                        in: activeTab.auth.type === 'apikey' ? activeTab.auth.in : 'header',
                      },
                    })
                  }
                />
                <Select
                  label="Send In"
                  value={activeTab.auth.in}
                  onValueChange={(val) =>
                    updateActiveTab({
                      auth: {
                        type: 'apikey',
                        key: activeTab.auth.type === 'apikey' ? activeTab.auth.key : 'X-API-Key',
                        value: activeTab.auth.type === 'apikey' ? activeTab.auth.value : '',
                        in: val as 'header' | 'query',
                      },
                    })
                  }
                  options={[
                    { value: 'header', label: 'Header' },
                    { value: 'query', label: 'Query Param' },
                  ]}
                />
              </div>
            ) : null}

            {activeTab.auth.type === 'oauth2' ? (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3">
                  <Input
                    label="Prefix"
                    value={activeTab.auth.headerPrefix}
                    mono
                    onChange={(e) =>
                      updateActiveTab({
                        auth:
                          activeTab.auth.type === 'oauth2'
                            ? { ...activeTab.auth, headerPrefix: e.target.value }
                            : activeTab.auth,
                      })
                    }
                  />
                  <VariableInput
                    label="Access Token"
                    value={activeTab.auth.accessToken}
                    placeholder="{{oauthAccessToken}}"
                    variables={workspaceVariables}
                    defaultTargetLabel={defaultTargetLabel}
                    defaultTargetEnvId={defaultTargetEnvId}
                    onSaveVariable={saveVariable}
                    onChange={(e) =>
                      updateActiveTab({
                        auth:
                          activeTab.auth.type === 'oauth2'
                            ? { ...activeTab.auth, accessToken: e.target.value }
                            : activeTab.auth,
                      })
                    }
                  />
                </div>

                <div className="p-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">Get New Access Token</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      isLoading={oauthFetching}
                      onClick={handleFetchOAuth2Token}
                      leftIcon={<Icon name="refresh" size={12} />}
                    >
                      Fetch Token
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Select
                      size="sm"
                      label="Grant Type"
                      value={activeTab.auth.grantType ?? 'client_credentials'}
                      onValueChange={(v) =>
                        updateActiveTab({
                          auth:
                            activeTab.auth.type === 'oauth2'
                              ? {
                                  ...activeTab.auth,
                                  grantType: v as
                                    | 'client_credentials'
                                    | 'password'
                                    | 'authorization_code',
                                }
                              : activeTab.auth,
                        })
                      }
                      options={[
                        { value: 'client_credentials', label: 'Client Credentials' },
                        { value: 'password', label: 'Password Credentials' },
                        { value: 'authorization_code', label: 'Authorization Code' },
                      ]}
                    />
                    <Input
                      size="sm"
                      label="Token URL"
                      mono
                      value={activeTab.auth.tokenUrl ?? '/api/v1/playground/oauth/token'}
                      onChange={(e) =>
                        updateActiveTab({
                          auth:
                            activeTab.auth.type === 'oauth2'
                              ? { ...activeTab.auth, tokenUrl: e.target.value }
                              : activeTab.auth,
                        })
                      }
                    />
                    <Input
                      size="sm"
                      label="Client ID"
                      mono
                      value={activeTab.auth.clientId ?? ''}
                      onChange={(e) =>
                        updateActiveTab({
                          auth:
                            activeTab.auth.type === 'oauth2'
                              ? { ...activeTab.auth, clientId: e.target.value }
                              : activeTab.auth,
                        })
                      }
                    />
                    <Input
                      size="sm"
                      label="Client Secret"
                      type="password"
                      mono
                      value={activeTab.auth.clientSecret ?? ''}
                      onChange={(e) =>
                        updateActiveTab({
                          auth:
                            activeTab.auth.type === 'oauth2'
                              ? { ...activeTab.auth, clientSecret: e.target.value }
                              : activeTab.auth,
                        })
                      }
                    />
                  </div>
                  {oauthStatusMsg ? (
                    <span className="text-xs text-[var(--color-primary)]">{oauthStatusMsg}</span>
                  ) : null}
                </div>
              </div>
            ) : null}

            {activeTab.auth.type === 'aws_sigv4' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label="Access Key ID"
                  mono
                  value={activeTab.auth.accessKeyId}
                  onChange={(e) =>
                    updateActiveTab({
                      auth:
                        activeTab.auth.type === 'aws_sigv4'
                          ? { ...activeTab.auth, accessKeyId: e.target.value }
                          : activeTab.auth,
                    })
                  }
                />
                <Input
                  label="Secret Access Key"
                  type="password"
                  mono
                  value={activeTab.auth.secretAccessKey}
                  onChange={(e) =>
                    updateActiveTab({
                      auth:
                        activeTab.auth.type === 'aws_sigv4'
                          ? { ...activeTab.auth, secretAccessKey: e.target.value }
                          : activeTab.auth,
                    })
                  }
                />
                <Input
                  label="AWS Region"
                  mono
                  value={activeTab.auth.region}
                  onChange={(e) =>
                    updateActiveTab({
                      auth:
                        activeTab.auth.type === 'aws_sigv4'
                          ? { ...activeTab.auth, region: e.target.value }
                          : activeTab.auth,
                    })
                  }
                />
                <Input
                  label="Service Name"
                  mono
                  value={activeTab.auth.service}
                  onChange={(e) =>
                    updateActiveTab({
                      auth:
                        activeTab.auth.type === 'aws_sigv4'
                          ? { ...activeTab.auth, service: e.target.value }
                          : activeTab.auth,
                    })
                  }
                />
              </div>
            ) : null}

            {activeTab.auth.type === 'digest' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label="Username"
                  mono
                  value={activeTab.auth.username}
                  onChange={(e) =>
                    updateActiveTab({
                      auth:
                        activeTab.auth.type === 'digest'
                          ? { ...activeTab.auth, username: e.target.value }
                          : activeTab.auth,
                    })
                  }
                />
                <Input
                  label="Password"
                  type="password"
                  mono
                  value={activeTab.auth.password}
                  onChange={(e) =>
                    updateActiveTab({
                      auth:
                        activeTab.auth.type === 'digest'
                          ? { ...activeTab.auth, password: e.target.value }
                          : activeTab.auth,
                    })
                  }
                />
              </div>
            ) : null}

            {activeTab.auth.type === 'oauth1' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label="Consumer Key"
                  mono
                  value={activeTab.auth.consumerKey}
                  onChange={(e) =>
                    updateActiveTab({
                      auth:
                        activeTab.auth.type === 'oauth1'
                          ? { ...activeTab.auth, consumerKey: e.target.value }
                          : activeTab.auth,
                    })
                  }
                />
                <Input
                  label="Consumer Secret"
                  type="password"
                  mono
                  value={activeTab.auth.consumerSecret}
                  onChange={(e) =>
                    updateActiveTab({
                      auth:
                        activeTab.auth.type === 'oauth1'
                          ? { ...activeTab.auth, consumerSecret: e.target.value }
                          : activeTab.auth,
                    })
                  }
                />
                <Input
                  label="Access Token (Optional)"
                  mono
                  value={activeTab.auth.token ?? ''}
                  onChange={(e) =>
                    updateActiveTab({
                      auth:
                        activeTab.auth.type === 'oauth1'
                          ? { ...activeTab.auth, token: e.target.value }
                          : activeTab.auth,
                    })
                  }
                />
                <Input
                  label="Token Secret (Optional)"
                  type="password"
                  mono
                  value={activeTab.auth.tokenSecret ?? ''}
                  onChange={(e) =>
                    updateActiveTab({
                      auth:
                        activeTab.auth.type === 'oauth1'
                          ? { ...activeTab.auth, tokenSecret: e.target.value }
                          : activeTab.auth,
                    })
                  }
                />
              </div>
            ) : null}

            {activeTab.auth.type === 'custom' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label="Header Name"
                  value={activeTab.auth.headerName}
                  mono
                  onChange={(e) =>
                    updateActiveTab({
                      auth: {
                        type: 'custom',
                        headerName: e.target.value,
                        headerValue:
                          activeTab.auth.type === 'custom' ? activeTab.auth.headerValue : '',
                      },
                    })
                  }
                />
                <VariableInput
                  label="Header Value"
                  value={activeTab.auth.headerValue}
                  placeholder="{{customAuthHeader}}"
                  variables={workspaceVariables}
                  defaultTargetLabel={defaultTargetLabel}
                  defaultTargetEnvId={defaultTargetEnvId}
                  onSaveVariable={saveVariable}
                  onChange={(e) =>
                    updateActiveTab({
                      auth: {
                        type: 'custom',
                        headerName:
                          activeTab.auth.type === 'custom'
                            ? activeTab.auth.headerName
                            : 'Authorization',
                        headerValue: e.target.value,
                      },
                    })
                  }
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {editorSection === 'headers' ? (
          <div className="w-full flex flex-col gap-2.5">
            {parentInheritanceSummary.inheritedHeadersCount > 0 ? (
              <div className="px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-primary-subtle)]/60 border border-[var(--color-border-strong)] flex items-center justify-between gap-2 text-xs">
                <span className="text-[var(--color-text-secondary)]">
                  Inheriting{' '}
                  <strong className="text-[var(--color-primary)]">
                    {parentInheritanceSummary.inheritedHeadersCount}
                  </strong>{' '}
                  shared header{parentInheritanceSummary.inheritedHeadersCount > 1 ? 's' : ''} from
                  parent Collection / Folder.
                </span>
                <Badge variant="info">Inherited</Badge>
              </div>
            ) : null}
            <KeyValueEditor
              items={activeTab.headers}
              onChange={(headers) => updateActiveTab({ headers })}
              keyPlaceholder="Header (e.g. X-Request-ID)"
              valuePlaceholder="Value (e.g. {{$uuid}})"
              addLabel="Add Header"
              variables={workspaceVariables}
              defaultTargetLabel={defaultTargetLabel}
              defaultTargetEnvId={defaultTargetEnvId}
              onSaveVariable={saveVariable}
            />
          </div>
        ) : null}

        {editorSection === 'body' ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 flex-wrap">
                {(
                  [
                    { id: 'none', label: 'None' },
                    { id: 'json', label: 'JSON' },
                    { id: 'xml', label: 'XML' },
                    { id: 'text', label: 'Text' },
                    { id: 'urlencoded', label: 'Form URL-Encoded' },
                    { id: 'multipart', label: 'Multipart' },
                    { id: 'binary', label: 'Binary' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() =>
                      updateActiveTab({
                        body: {
                          ...activeTab.body,
                          mode: m.id as RequestBodyConfig['mode'],
                        },
                      })
                    }
                    className={cn(
                      'h-8 px-3 text-xs rounded-[var(--radius-md)] border cursor-pointer transition-colors inline-flex items-center',
                      activeTab.body.mode === m.id
                        ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] border-[var(--color-primary)] font-medium'
                        : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]',
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {activeTab.body.mode === 'json' ? (
                <Button size="sm" variant="ghost" onClick={handleFormatJson}>
                  Format JSON
                </Button>
              ) : null}
            </div>

            {jsonFormatError ? (
              <p role="alert" className="text-xs text-[var(--color-danger)]">
                {jsonFormatError}
              </p>
            ) : null}

            {activeTab.body.mode === 'none' ? (
              <div className="py-6 text-center text-xs text-[var(--color-text-muted)] border border-dashed border-[var(--color-border)] rounded-[var(--radius-lg)]">
                No request body.
              </div>
            ) : activeTab.body.mode === 'urlencoded' ? (
              <KeyValueEditor
                items={activeTab.body.urlencoded ?? []}
                onChange={(urlencoded) =>
                  updateActiveTab({ body: { ...activeTab.body, urlencoded } })
                }
                keyPlaceholder="Field"
                valuePlaceholder="Value (supports {{variable}})"
                addLabel="Add Field"
                variables={workspaceVariables}
                defaultTargetLabel={defaultTargetLabel}
                defaultTargetEnvId={defaultTargetEnvId}
                onSaveVariable={saveVariable}
              />
            ) : activeTab.body.mode === 'multipart' ? (
              <KeyValueEditor
                items={activeTab.body.multipart ?? []}
                onChange={(multipart) =>
                  updateActiveTab({ body: { ...activeTab.body, multipart } })
                }
                keyPlaceholder="Field"
                valuePlaceholder="Value (supports {{variable}})"
                addLabel="Add Field"
                variables={workspaceVariables}
                defaultTargetLabel={defaultTargetLabel}
                defaultTargetEnvId={defaultTargetEnvId}
                onSaveVariable={saveVariable}
              />
            ) : activeTab.body.mode === 'binary' ? (
              <div className="p-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] flex items-center justify-between gap-3 flex-wrap">
                <div className="flex flex-col gap-0.5 text-xs">
                  <span className="font-medium">
                    {activeTab.body.binaryFileName || 'No binary file selected'}
                  </span>
                  <span className="text-[var(--color-text-muted)] font-mono">
                    {activeTab.body.binaryContentType || 'application/octet-stream'}
                  </span>
                </div>
                <label className="h-9 px-3.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer">
                  <Icon name="upload" size={13} />
                  <span>Choose File</span>
                  <input type="file" onChange={handleBinaryFileUpload} className="hidden" />
                </label>
              </div>
            ) : (
              <CodeEditor
                language={
                  activeTab.body.mode === 'json'
                    ? 'json'
                    : activeTab.body.mode === 'xml'
                      ? 'xml'
                      : 'text'
                }
                value={activeTab.body.raw ?? ''}
                onChange={(raw) => updateActiveTab({ body: { ...activeTab.body, raw } })}
                placeholder={
                  activeTab.body.mode === 'json'
                    ? '{\n  "title": "New Item",\n  "requestId": "{{$uuid}}"\n}'
                    : 'Enter body payload...'
                }
                minHeight="160px"
                ariaLabel="Request Body"
              />
            )}
          </div>
        ) : null}

        {editorSection === 'vars' ? (
          <div className="w-full flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs text-[var(--color-text-secondary)]">
                Automatically capture response values into{' '}
                <strong className="text-[var(--color-text)]">{defaultTargetLabel}</strong>{' '}
                environment variables whenever this request runs — zero code required.
              </span>
              <Badge variant="info">Target: {defaultTargetLabel}</Badge>
            </div>

            {suggestedResponseTokens.length > 0 ? (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
                  Detected in response:
                </span>
                {suggestedResponseTokens.map((sug) => (
                  <button
                    key={sug.path}
                    type="button"
                    onClick={() =>
                      addPostVarExtractor({ varName: sug.suggestedVar, path: sug.path })
                    }
                    className="h-6 px-2 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-primary-subtle)] text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white text-[11px] font-mono inline-flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <Icon name="plus" size={11} />
                    <span>
                      {sug.path} → {`{{${sug.suggestedVar}}}`}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="w-full border border-[var(--color-border)] rounded-[var(--radius-md)] overflow-hidden bg-[var(--color-surface)]">
              <div className="grid grid-cols-[36px_1fr_175px_1.2fr_36px] items-center h-7 px-2 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)] text-[11px] font-medium text-[var(--color-text-secondary)]">
                <span className="text-center">On</span>
                <span className="px-2">Environment Variable</span>
                <span className="px-2">Source</span>
                <span className="px-2">JSON Path / Header / Cookie</span>
                <span className="sr-only">Actions</span>
              </div>

              {postVarsList.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">
                  No post-response variable captures configured yet.
                </div>
              ) : (
                <div className="divide-y divide-[var(--color-border)]">
                  {postVarsList.map((row) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-1 sm:grid-cols-[36px_1fr_175px_1.2fr_36px] items-center px-2 py-1 gap-1.5"
                    >
                      <div className="flex justify-center">
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          aria-label={`Enable ${row.varName || 'variable capture'}`}
                          onChange={(e) =>
                            updatePostVarExtractor(row.id, { enabled: e.target.checked })
                          }
                          className="w-3.5 h-3.5 accent-[var(--color-primary)] cursor-pointer rounded"
                        />
                      </div>
                      <input
                        type="text"
                        value={row.varName}
                        onChange={(e) =>
                          updatePostVarExtractor(row.id, { varName: e.target.value })
                        }
                        placeholder="e.g. accessToken"
                        aria-label="Target environment variable name"
                        className="h-7 px-2 text-xs font-mono bg-[var(--color-background)] rounded-[var(--radius-sm)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/15 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none transition-all"
                      />
                      <Select
                        size="sm"
                        ariaLabel="Response source"
                        value={row.source}
                        onValueChange={(val) =>
                          updatePostVarExtractor(row.id, {
                            source: val as ResponseVariableSource,
                          })
                        }
                        options={POST_VAR_SOURCE_OPTIONS}
                      />
                      <input
                        type="text"
                        disabled={row.source === 'status'}
                        value={row.path ?? ''}
                        onChange={(e) =>
                          updatePostVarExtractor(row.id, { path: e.target.value })
                        }
                        placeholder={
                          row.source === 'body'
                            ? 'e.g. data.access_token or items[0].id'
                            : row.source === 'header'
                              ? 'e.g. x-auth-token'
                              : row.source === 'cookie'
                                ? 'e.g. session_id'
                                : 'HTTP status code'
                        }
                        aria-label="Extraction path"
                        className="h-7 px-2 text-xs font-mono bg-[var(--color-background)] rounded-[var(--radius-sm)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/15 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none disabled:opacity-45 transition-all"
                      />
                      <button
                        type="button"
                        aria-label="Delete capture rule"
                        onClick={() => {
                          void removePostVarExtractor(row)
                        }}
                        className="w-7 h-7 inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] cursor-pointer transition-colors"
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Icon name="plus" size={13} />}
                onClick={() => addPostVarExtractor()}
              >
                Add Variable Capture
              </Button>
            </div>
          </div>
        ) : null}

        {editorSection === 'scripts' ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setScriptPhase('pre')}
                  className={cn(
                    'h-8 px-3 text-xs rounded-[var(--radius-md)] border cursor-pointer transition-colors',
                    scriptPhase === 'pre'
                      ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] border-[var(--color-primary)] font-medium'
                      : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]',
                  )}
                >
                  Pre-request
                </button>
                <button
                  type="button"
                  onClick={() => setScriptPhase('post')}
                  className={cn(
                    'h-8 px-3 text-xs rounded-[var(--radius-md)] border cursor-pointer transition-colors',
                    scriptPhase === 'post'
                      ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] border-[var(--color-primary)] font-medium'
                      : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]',
                  )}
                >
                  Post-response
                </button>
              </div>

              <DropdownMenu
                ariaLabel="Script actions"
                widthClassName="w-52"
                triggerClassName="w-[30px] h-[30px] justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
                trigger={() => <Icon name="dots-vertical" size={14} />}
                items={
                  scriptPhase === 'pre'
                    ? [
                        {
                          id: 'set-var',
                          label: 'Insert Set Variable Snippet',
                          icon: 'plus',
                          onSelect: () =>
                            insertScriptSnippet('pm.environment.set("timestamp", Date.now());'),
                        },
                        {
                          id: 'add-header',
                          label: 'Insert Add Header Snippet',
                          icon: 'plus',
                          onSelect: () =>
                            insertScriptSnippet(
                              'pm.request.headers.add({ key: "X-Trace-ID", value: String(Date.now()) });',
                            ),
                        },
                      ]
                    : [
                        {
                          id: 'auto-gen',
                          label: generatingTests
                            ? 'Generating Tests...'
                            : 'Auto-Generate Tests',
                          icon: 'sparkles',
                          onSelect: () => {
                            void handleSmartGenerateTests()
                          },
                        },
                        {
                          id: 'status-200',
                          label: 'Insert Status 200 Test',
                          icon: 'plus',
                          dividerBefore: true,
                          onSelect: () =>
                            insertScriptSnippet(
                              'pm.test("Status is 200", () => {\n  pm.expect(pm.response.code).to.equal(200);\n});',
                            ),
                        },
                        {
                          id: 'save-token',
                          label: 'Insert Save Token (pm.*)',
                          icon: 'key',
                          onSelect: () =>
                            insertScriptSnippet(
                              'const body = pm.response.json();\nif (body.token) {\n  pm.environment.set("accessToken", body.token);\n}',
                            ),
                        },
                        {
                          id: 'save-token-bruno',
                          label: 'Insert Save Token (bru.*)',
                          icon: 'key',
                          onSelect: () =>
                            insertScriptSnippet(
                              'if (res.body && res.body.access_token) {\n  bru.setEnvVar("accessToken", res.body.access_token);\n}',
                            ),
                        },
                      ]
                }
              />
            </div>

            <CodeEditor
              language="javascript"
              value={scriptPhase === 'pre' ? activeTab.preRequestScript : activeTab.testScript}
              onChange={(code) =>
                scriptPhase === 'pre'
                  ? updateActiveTab({ preRequestScript: code })
                  : updateActiveTab({ testScript: code })
              }
              placeholder={
                scriptPhase === 'pre'
                  ? '// Runs before sending the request\npm.environment.set("nonce", Date.now());'
                  : '// Runs after receiving the response\npm.test("Valid response", () => {\n  pm.expect(pm.response.code).to.equal(200);\n});'
              }
              minHeight="160px"
              ariaLabel={scriptPhase === 'pre' ? 'Pre-request script' : 'Post-response script'}
            />
          </div>
        ) : null}

        {editorSection === 'tests' ? (
          <div className="flex flex-col gap-2.5">
            <div className="border border-[var(--color-border)] rounded-[var(--radius-lg)] divide-y divide-[var(--color-border)] bg-[var(--color-surface)]">
              {activeTab.assertions.length === 0 ? (
                <div className="p-5 text-center text-xs text-[var(--color-text-muted)]">
                  No declarative assertions added yet.
                </div>
              ) : (
                activeTab.assertions.map((rule) => (
                  <div
                    key={rule.id}
                    className="grid grid-cols-1 sm:grid-cols-[32px_205px_1fr_1fr_36px] items-center gap-2 p-2"
                  >
                    <div className="flex justify-center">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        aria-label="Enable assertion"
                        onChange={(e) => updateAssertion(rule.id, { enabled: e.target.checked })}
                        className="w-4 h-4 accent-[var(--color-primary)] cursor-pointer"
                      />
                    </div>
                    <Select
                      size="sm"
                      ariaLabel="Assertion type"
                      value={rule.type}
                      onValueChange={(val) =>
                        updateAssertion(rule.id, { type: val as AssertionType })
                      }
                      options={ASSERTION_OPTIONS}
                    />
                    <input
                      type="text"
                      aria-label="Assertion target"
                      disabled={
                        rule.type === 'status_equals' ||
                        rule.type === 'status_in_2xx' ||
                        rule.type === 'duration_lt' ||
                        rule.type === 'body_contains'
                      }
                      value={rule.target ?? ''}
                      onChange={(e) => updateAssertion(rule.id, { target: e.target.value })}
                      placeholder={
                        rule.type.startsWith('header_')
                          ? 'Header name'
                          : rule.type === 'json_path_equals'
                            ? 'JSON path (e.g. [0].id)'
                            : '—'
                      }
                      className="h-8 px-2.5 text-xs font-mono rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text)] focus:border-[var(--color-primary)] outline-none disabled:opacity-45"
                    />
                    <input
                      type="text"
                      aria-label="Expected value"
                      disabled={rule.type === 'status_in_2xx' || rule.type === 'header_exists'}
                      value={rule.expected ?? ''}
                      onChange={(e) => updateAssertion(rule.id, { expected: e.target.value })}
                      placeholder={
                        rule.type === 'duration_lt' ? 'Max ms (e.g. 1000)' : 'Expected value'
                      }
                      className="h-8 px-2.5 text-xs font-mono rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text)] focus:border-[var(--color-primary)] outline-none disabled:opacity-45"
                    />
                    <button
                      type="button"
                      aria-label="Delete assertion"
                      onClick={() => {
                        void removeAssertion(rule)
                      }}
                      className="w-8 h-8 inline-flex items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] cursor-pointer"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Icon name="plus" size={13} />}
                onClick={addAssertion}
              >
                Add Assertion
              </Button>
            </div>
          </div>
        ) : null}

        {editorSection === 'schema' ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs text-[var(--color-text-secondary)]">
                Validate JSON responses against a JSON Schema.
              </span>
              {activeTab.response?.isJson && activeTab.jsonSchema ? (
                <DropdownMenu
                  ariaLabel="Schema actions"
                  widthClassName="w-52"
                  triggerClassName="w-[30px] h-[30px] justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
                  trigger={() => <Icon name="dots-vertical" size={14} />}
                  items={[
                    {
                      id: 'gen-schema',
                      label: 'Generate from Response',
                      icon: 'sparkles',
                      onSelect: handleGenerateSchemaFromResponse,
                    },
                    {
                      id: 'clear-schema',
                      label: 'Clear JSON Schema',
                      icon: 'trash',
                      variant: 'danger',
                      dividerBefore: true,
                      onSelect: () => {
                        void (async () => {
                          const ok = await confirm({
                            title: 'Clear JSON Schema?',
                            description:
                              'This will remove the JSON Schema validation contract from the current request.',
                            confirmLabel: 'Clear Schema',
                            variant: 'warning',
                          })
                          if (ok) {
                            updateActiveTab({ jsonSchema: '' })
                            toast.info('JSON Schema cleared')
                          }
                        })()
                      },
                    },
                  ]}
                />
              ) : activeTab.response?.isJson ? (
                <Button
                  size="sm"
                  variant="primary"
                  leftIcon={<Icon name="sparkles" size={12} />}
                  onClick={handleGenerateSchemaFromResponse}
                >
                  Generate from Response
                </Button>
              ) : activeTab.jsonSchema ? (
                <Button
                  size="sm"
                  variant="danger"
                  leftIcon={<Icon name="trash" size={12} />}
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Clear JSON Schema?',
                      description:
                        'This will remove the JSON Schema validation contract from the current request.',
                      confirmLabel: 'Clear Schema',
                      variant: 'warning',
                    })
                    if (ok) {
                      updateActiveTab({ jsonSchema: '' })
                      toast.info('JSON Schema cleared')
                    }
                  }}
                >
                  Clear Schema
                </Button>
              ) : null}
            </div>

            <CodeEditor
              language="json"
              value={activeTab.jsonSchema}
              onChange={(jsonSchema) => updateActiveTab({ jsonSchema })}
              placeholder={
                '{\n  "type": "object",\n  "required": ["id"],\n  "properties": {\n    "id": { "type": "integer" }\n  }\n}'
              }
              minHeight="160px"
              ariaLabel="JSON Schema"
            />
          </div>
        ) : null}

        {editorSection === 'comments' ? (
          <div
            className={cn(
              'grid gap-4 items-start',
              splitDirection === 'horizontal'
                ? 'grid-cols-1'
                : 'grid-cols-1 lg:grid-cols-[1.15fr_1fr]',
            )}
          >
            {/* Left Column: Team Comments & Discussion */}
            <div className="flex flex-col gap-2.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[var(--color-text)]">
                  Team Discussion
                </span>
                <Badge variant="neutral">{commentList.length}</Badge>
              </div>

              {!activeTab.savedRequestId ? (
                <div className="p-3 rounded-[var(--radius-md)] bg-[var(--color-surface-secondary)] border border-[var(--color-border)] flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-xs text-[var(--color-text-secondary)]">
                    Save this request to a collection first to enable team comments.
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Icon name="save" size={12} />}
                    onClick={onOpenSaveModal}
                  >
                    Save Request
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    <Input
                      size="sm"
                      placeholder="Write a note for teammates... (Press Enter)"
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && commentText.trim() && !addCommentMutation.isPending) {
                          e.preventDefault()
                          addCommentMutation.mutate()
                        }
                      }}
                      className="flex-1"
                    />
                    <Button
                      size="sm"
                      disabled={!commentText.trim()}
                      isLoading={addCommentMutation.isPending}
                      onClick={() => addCommentMutation.mutate()}
                    >
                      Post
                    </Button>
                  </div>

                  {commentList.length === 0 ? (
                    <div className="py-5 text-center text-xs text-[var(--color-text-muted)] border border-dashed border-[var(--color-border)] rounded-[var(--radius-md)]">
                      No comments on this request yet.
                    </div>
                  ) : (
                    <div className="border border-[var(--color-border)] rounded-[var(--radius-md)] divide-y divide-[var(--color-border)] bg-[var(--color-background)]/50 text-xs">
                      {commentList.map((c) => (
                        <div
                          key={c.id}
                          className="group p-2.5 flex items-start justify-between gap-2.5"
                        >
                          <div className="flex items-start gap-2.5 min-w-0 flex-1">
                            <Avatar name={c.authorName} size="sm" />
                            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-[var(--color-text)]">
                                  {c.authorName}
                                </span>
                                <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums">
                                  {formatShortTime(c.createdAt)}
                                </span>
                              </div>
                              <p className="text-[var(--color-text-secondary)] leading-relaxed break-words">
                                {c.body}
                              </p>
                            </div>
                          </div>

                          <button
                            type="button"
                            title="Delete comment"
                            aria-label={`Delete comment by ${c.authorName}`}
                            onClick={() => {
                              void (async () => {
                                const ok = await confirm({
                                  title: 'Delete comment?',
                                  description: 'Remove this note from the request discussion?',
                                  confirmLabel: 'Delete Comment',
                                })
                                if (ok) deleteCommentMutation.mutate(c.id)
                              })()
                            }}
                            className="w-6 h-6 inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:bg-[var(--color-danger)] hover:text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all cursor-pointer shrink-0"
                          >
                            <Icon name="trash" size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Right Column: Endpoint Documentation & Request Contract Summary */}
            <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[var(--color-text)]">
                  Endpoint Documentation
                </span>
                <Badge variant="info">Synced to API Docs</Badge>
              </div>

              <textarea
                rows={4}
                value={activeTab.description ?? ''}
                onChange={(e) => updateActiveTab({ description: e.target.value })}
                placeholder="Describe endpoint purpose, required roles, rate limits, or payload caveats. Saved automatically with the request and exported to API Docs & OpenAPI."
                aria-label="Endpoint documentation"
                className="w-full p-2.5 text-xs leading-relaxed rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-background)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-primary)]/70 focus-visible:outline-none focus-visible:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/16 resize-y transition-all"
              />

              <div className="pt-2 border-t border-[var(--color-border)] flex flex-col gap-2">
                <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
                  Request Contract &amp; Variables
                </span>

                <div className="flex items-center gap-1.5 flex-wrap">
                  <Badge variant="primary">{activeTab.protocol.toUpperCase()}</Badge>
                  <Badge variant={activeTab.auth.type !== 'none' ? 'info' : 'neutral'}>
                    Auth: {activeTab.auth.type.toUpperCase()}
                  </Badge>
                  <Badge variant="neutral">
                    Params: {activeTab.queryParams.filter((p) => p.enabled && p.key).length}
                  </Badge>
                  <Badge variant="neutral">
                    Headers: {activeTab.headers.filter((h) => h.enabled && h.key).length}
                  </Badge>
                  <Badge variant="neutral">
                    Tests: {activeTab.assertions.filter((a) => a.enabled).length}
                  </Badge>
                  {activeTab.jsonSchema.trim() ? (
                    <Badge variant="success">Schema Active</Badge>
                  ) : null}
                </div>

                {referencedVariables.length > 0 ? (
                  <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    <span className="text-[11px] text-[var(--color-text-muted)]">Variables:</span>
                    {referencedVariables.map((token) => (
                      <code
                        key={token}
                        className="px-1.5 py-0.5 text-[11px] font-mono rounded bg-[var(--color-primary-subtle)] text-[var(--color-primary)] border border-[var(--color-border-strong)]"
                      >
                        {token}
                      </code>
                    ))}
                  </div>
                ) : (
                  <span className="text-[11px] text-[var(--color-text-muted)]">
                    No <code className="font-mono">{'{{variable}}'}</code> placeholders referenced yet.
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : null}
                </div>
              </div>
            }
            second={responseSlot ?? <div className="h-full flex-1" />}
          />
        </div>
      )}

      <Dialog
        open={renameTabOpen}
        title="Rename Request"
        onClose={() => setRenameTabOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Request Name"
            value={renameTabDraft}
            onChange={(e) => setRenameTabDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameTabDraft.trim() && !renameTabMutation.isPending) {
                e.preventDefault()
                renameTabMutation.mutate(renameTabDraft.trim())
              }
            }}
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setRenameTabOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!renameTabDraft.trim()}
              isLoading={renameTabMutation.isPending}
              onClick={() => renameTabMutation.mutate(renameTabDraft.trim())}
            >
              Save Name
            </Button>
          </div>
        </div>
      </Dialog>

      <CodeSnippetModal
        open={snippetModalOpen}
        onClose={() => setSnippetModalOpen(false)}
        tab={activeTab}
      />
    </section>
  )
}
