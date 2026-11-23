import {
  canWriteWorkspace,
  executeRequestSchema,
  graphqlIntrospectSchema,
  hasPolicyPermission,
  networkPolicySchema,
  oauth2FetchTokenSchema,
  wsConnectSchema,
  wsSendMessageSchema,
} from '@meofast/shared'
import { Hono } from 'hono'
import { AppError } from '../../core/errors/app-error.js'
import { createRateLimiter, requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'
import { executeSingleRequest } from './request-runner.js'
import { validateOutboundTargetUrl } from './ssrf-guard.js'
import {
  closeWsProxySession,
  createWsProxySession,
  getWsProxySessionState,
  sendWsProxyMessage,
} from './ws-session-manager.js'

export const proxyRoutes = new Hono<AppEnv>()

proxyRoutes.use('*', requireAuthMiddleware)

const proxyRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 250,
  keyPrefix: 'proxy_exec',
})

const INTROSPECTION_QUERY = `
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind
      name
      description
      fields {
        name
        description
        args {
          name
          type { kind name ofType { kind name } }
        }
        type { kind name ofType { kind name } }
      }
    }
  }
}
`

proxyRoutes.post('/execute', proxyRateLimiter, async (c) => {
  const runtime = c.get('runtime')
  const user = c.get('user')!

  const rawBody = await c.req.json().catch(() => ({}))
  const parsed = executeRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid request execution payload',
    )
  }

  const payload = await executeSingleRequest(runtime, user.id, parsed.data)
  return c.json(payload)
})

proxyRoutes.post('/oauth2/token', proxyRateLimiter, async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()

  const parsed = oauth2FetchTokenSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid OAuth 2.0 token parameters',
    )
  }

  const d = parsed.data
  const form = new URLSearchParams()
  form.set('grant_type', d.grantType)
  if (d.clientId) form.set('client_id', d.clientId)
  if (d.clientSecret) form.set('client_secret', d.clientSecret)
  if (d.scope) form.set('scope', d.scope)
  if (d.grantType === 'password') {
    form.set('username', d.username)
    form.set('password', d.password)
  } else if (d.grantType === 'authorization_code') {
    form.set('code', d.code)
    if (d.redirectUri) form.set('redirect_uri', d.redirectUri)
  }

  const headers = new Headers({
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  })

  let tokenUrlStr = d.tokenUrl.trim()
  if (tokenUrlStr.startsWith('/api/v1/playground/') && runtime.localFetch) {
    const res = await runtime.localFetch(
      new Request(`http://127.0.0.1${tokenUrlStr}`, {
        method: 'POST',
        headers,
        body: form.toString(),
      }),
    )
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return c.json({
      accessToken: String(json.access_token ?? ''),
      tokenType: String(json.token_type ?? 'Bearer'),
      expiresIn: json.expires_in ?? null,
      raw: json,
    })
  }

  if (!/^https?:\/\//i.test(tokenUrlStr)) {
    tokenUrlStr = `https://${tokenUrlStr}`
  }

  const policySetting = await db
    .selectFrom('system_settings')
    .select('setting_value')
    .where('setting_key', '=', 'network_policy')
    .executeTakeFirst()

  let networkPolicy = {
    allowPrivateNetworks: false,
    allowLocalhost: false,
    allowedCidrs: [] as string[],
    allowedDomains: [] as string[],
  }
  if (policySetting?.setting_value) {
    try {
      networkPolicy = networkPolicySchema.parse(JSON.parse(policySetting.setting_value))
    } catch {
      // ignore
    }
  }

  const validatedUrl = await validateOutboundTargetUrl(tokenUrlStr, networkPolicy)
  const upstream = await fetch(validatedUrl.toString(), {
    method: 'POST',
    headers,
    body: form.toString(),
    signal: AbortSignal.timeout(15000),
  })

  const json = (await upstream.json().catch(() => ({}))) as Record<string, unknown>
  if (!upstream.ok || !json.access_token) {
    throw new AppError(
      400,
      'OAUTH2_TOKEN_FAILED',
      String(json.error_description ?? json.error ?? `Token endpoint returned ${upstream.status}`),
    )
  }

  return c.json({
    accessToken: String(json.access_token),
    tokenType: String(json.token_type ?? 'Bearer'),
    expiresIn: json.expires_in ?? null,
    raw: json,
  })
})

proxyRoutes.post('/graphql/introspect', proxyRateLimiter, async (c) => {
  const runtime = c.get('runtime')
  const user = c.get('user')!

  const parsed = graphqlIntrospectSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Provide a valid GraphQL endpoint URL.')
  }

  const execRes = await executeSingleRequest(runtime, user.id, {
    workspaceId: parsed.data.workspaceId,
    environmentId: parsed.data.environmentId ?? null,
    protocol: 'graphql',
    method: 'POST',
    url: parsed.data.url,
    queryParams: [],
    headers: parsed.data.headers ?? [],
    pathVariables: [],
    auth: parsed.data.auth ?? { type: 'none' },
    body: {
      mode: 'none',
      raw: '',
      urlencoded: [],
      multipart: [],
      binaryBase64: '',
      binaryFileName: '',
      binaryContentType: 'application/octet-stream',
    },
    graphql: {
      query: INTROSPECTION_QUERY,
      variables: '{}',
      operationName: 'IntrospectionQuery',
    },
    assertions: [],
    postResponseVars: [],
    preRequestScript: '',
    testScript: '',
    jsonSchema: '',
    timeoutMs: 20000,
    followRedirects: true,
  })

  let parsedBody: Record<string, unknown> = {}
  try {
    parsedBody = JSON.parse(execRes.body) as Record<string, unknown>
  } catch {
    throw new AppError(502, 'INVALID_GQL_SCHEMA', 'Endpoint did not return valid GraphQL JSON.')
  }

  const schemaData = ((parsedBody.data as Record<string, unknown> | undefined)?.__schema ??
    null) as Record<string, unknown> | null

  if (!schemaData) {
    throw new AppError(
      400,
      'INTROSPECTION_UNAVAILABLE',
      'GraphQL introspection is disabled or unsupported on this endpoint.',
    )
  }

  return c.json({ schema: schemaData })
})

proxyRoutes.post('/ws/connect', async (c) => {
  const runtime = c.get('runtime')
  const user = c.get('user')!
  const parsed = wsConnectSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Valid WebSocket URL is required.')
  }

  const session = await createWsProxySession(runtime, user.id, parsed.data.url)
  return c.json(session, 201)
})

proxyRoutes.get('/ws/:sessionId', async (c) => {
  const user = c.get('user')!
  const state = getWsProxySessionState(c.req.param('sessionId'), user.id)
  return c.json(state)
})

proxyRoutes.post('/ws/:sessionId/send', async (c) => {
  const user = c.get('user')!
  const parsed = wsSendMessageSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Message string is required.')
  }
  const result = await sendWsProxyMessage(c.req.param('sessionId'), user.id, parsed.data.message)
  return c.json(result)
})

proxyRoutes.post('/ws/:sessionId/disconnect', async (c) => {
  const user = c.get('user')!
  const result = closeWsProxySession(c.req.param('sessionId'), user.id)
  return c.json(result)
})

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export const historyProtectedRoutes = new Hono<AppEnv>()
historyProtectedRoutes.use('*', requireAuthMiddleware)

async function listWorkspaceHistory(db: ReturnType<AppEnv['Variables']['runtime']['getDb']>, wsId: string) {
  const rows = await db
    .selectFrom('request_history')
    .select([
      'id',
      'method',
      'url',
      'request_snapshot_json',
      'response_status',
      'response_status_text',
      'duration_ms',
      'response_size_bytes',
      'response_headers_json',
      'response_body_preview',
      'assertion_results_json',
      'error_message',
      'created_at',
    ])
    .where('workspace_id', '=', wsId)
    .orderBy('created_at', 'desc')
    .limit(60)
    .execute()

  return rows.map((h) => ({
    id: h.id,
    method: h.method,
    url: h.url,
    requestSnapshot: safeJsonParse<Record<string, unknown>>(h.request_snapshot_json, {}),
    status: h.response_status,
    statusText: h.response_status_text ?? '',
    durationMs: h.duration_ms,
    sizeBytes: h.response_size_bytes,
    headers: safeJsonParse<Record<string, string>>(h.response_headers_json, {}),
    body: h.response_body_preview ?? '',
    assertions: safeJsonParse<Array<Record<string, unknown>>>(h.assertion_results_json, []),
    errorMessage: h.error_message,
    createdAt: h.created_at,
  }))
}

proxyRoutes.get('/workspaces/:wsId/history', async (c) => {
  const user = c.get('user')!
  if (
    !hasPolicyPermission(user.permissions, user.globalRole, 'history', 'anyView') &&
    !hasPolicyPermission(user.permissions, user.globalRole, 'history', 'view')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view History.')
  }
  const db = c.get('runtime').getDb()
  const history = await listWorkspaceHistory(db, c.req.param('wsId'))
  return c.json({ history })
})

historyProtectedRoutes.get('/workspaces/:wsId/history', async (c) => {
  const user = c.get('user')!
  if (
    !hasPolicyPermission(user.permissions, user.globalRole, 'history', 'anyView') &&
    !hasPolicyPermission(user.permissions, user.globalRole, 'history', 'view')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view History.')
  }
  const db = c.get('runtime').getDb()
  const history = await listWorkspaceHistory(db, c.req.param('wsId'))
  return c.json({ history })
})

historyProtectedRoutes.delete('/workspaces/:wsId/history', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'history',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot clear request history.')
  }
  await db
    .deleteFrom('request_history')
    .where('workspace_id', '=', c.req.param('wsId'))
    .execute()
  return c.json({ ok: true })
})

historyProtectedRoutes.delete('/history/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'history',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete request history.')
  }
  await db.deleteFrom('request_history').where('id', '=', c.req.param('id')).execute()
  return c.json({ ok: true })
})
