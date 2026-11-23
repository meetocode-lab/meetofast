import crypto from 'node:crypto'
import {
  canWriteWorkspace,
  hasPolicyPermission,
  type KeyValueItem,
  RadixSegmentTrie,
  type RequestBodyConfig,
  TokenBucket,
  upsertMockRouteSchema,
} from '@meofast/shared'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { AppError } from '../../core/errors/app-error.js'
import { requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'

export const mocksPublicRoutes = new Hono<AppEnv>()
export const mocksProtectedRoutes = new Hono<AppEnv>()

mocksProtectedRoutes.use('*', requireAuthMiddleware)

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const mockRateBuckets = new Map<string, { rpm: number; bucket: TokenBucket }>()

function checkMockRouteRateLimit(
  routeId: string,
  clientIp: string,
  rateLimitRpm: number,
): { allowed: boolean; retryAfterSeconds: number } {
  if (rateLimitRpm <= 0) return { allowed: true, retryAfterSeconds: 0 }
  const key = `${routeId}:${clientIp || 'anon'}`
  let entry = mockRateBuckets.get(key)
  if (!entry || entry.rpm !== rateLimitRpm) {
    const ratePerSec = rateLimitRpm / 60
    const burst = Math.max(1, Math.min(rateLimitRpm, Math.ceil(rateLimitRpm / 4)))
    entry = { rpm: rateLimitRpm, bucket: new TokenBucket(ratePerSec, burst) }
    mockRateBuckets.set(key, entry)
    if (mockRateBuckets.size > 2000) {
      const firstKey = mockRateBuckets.keys().next().value
      if (firstKey) mockRateBuckets.delete(firstKey)
    }
  }
  return entry.bucket.tryConsume(1)
}

function renderDynamicMockBody(
  template: string,
  params: Record<string, string>,
  query: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, rawKey: string) => {
    const key = rawKey.trim()
    if (key === '$uuid') return crypto.randomUUID()
    if (key === '$timestamp') return String(Math.floor(Date.now() / 1000))
    if (key === '$isoTimestamp') return new Date().toISOString()
    if (key === '$randomInt') return String(crypto.randomInt(1, 10000))
    if (key.startsWith('params.')) return params[key.slice(7)] ?? ''
    if (key.startsWith('query.')) return query[key.slice(6)] ?? ''
    return full
  })
}

// Public Mock Execution Handler: /api/v1/mock/:workspaceSlug/*
mocksPublicRoutes.all('/:workspaceSlug/*', async (c) => {
  const db = c.get('runtime').getDb()
  const wsSlug = c.req.param('workspaceSlug')
  const fullPath = c.req.path
  const marker = `/api/v1/mock/${wsSlug}`
  const idx = fullPath.indexOf(marker)
  const subPath = idx >= 0 ? fullPath.slice(idx + marker.length) || '/' : '/'

  const ws = await db
    .selectFrom('workspaces')
    .select(['id', 'slug'])
    .where((eb) => eb.or([eb('slug', '=', wsSlug), eb('id', '=', wsSlug)]))
    .executeTakeFirst()

  if (!ws) {
    return c.json({ error: 'Mock workspace not found', workspace: wsSlug }, 404)
  }

  const routes = await db
    .selectFrom('mock_routes')
    .selectAll()
    .where('workspace_id', '=', ws.id)
    .where('enabled', '=', 1)
    .orderBy('created_at', 'asc')
    .execute()

  const reqMethod = c.req.method.toUpperCase()
  const methodTrie = new RadixSegmentTrie<(typeof routes)[number]>()
  const statefulTrie = new RadixSegmentTrie<(typeof routes)[number]>()

  for (const r of routes) {
    if (r.method === reqMethod) {
      methodTrie.insert(r.path_pattern, r)
    }
    if (r.is_stateful === 1) {
      statefulTrie.insert(r.path_pattern, r)
      const trimmedBase = r.path_pattern.replace(/\/+$/, '') || ''
      statefulTrie.insert(`${trimmedBase}/:id`, r)
    }
  }

  const exactHit = methodTrie.match(subPath) ?? statefulTrie.match(subPath)
  const matchedRoute = exactHit?.value ?? null
  const pathParams = exactHit?.params ?? {}

  if (!matchedRoute) {
    return c.json(
      {
        error: 'MOCK_ROUTE_NOT_FOUND',
        message: `No active mock route matched ${reqMethod} ${subPath}`,
      },
      404,
    )
  }

  // Optional Token Bucket Rate Limit (requests / minute)
  const rpm = matchedRoute.rate_limit_rpm ?? 0
  if (rpm > 0) {
    const rl = checkMockRouteRateLimit(matchedRoute.id, c.get('clientIp') || 'local', rpm)
    if (!rl.allowed) {
      c.header('Retry-After', String(rl.retryAfterSeconds))
      c.header('X-RateLimit-Limit', String(rpm))
      return c.json(
        {
          error: 'MOCK_RATE_LIMITED',
          message: `Simulated rate limit exceeded (${rpm} req/min). Retry after ${rl.retryAfterSeconds}s.`,
        },
        429,
      )
    }
  }

  // Increment hit count
  await db
    .updateTable('mock_routes')
    .set({ hit_count: matchedRoute.hit_count + 1 })
    .where('id', '=', matchedRoute.id)
    .execute()

  // Optional simulated latency
  if (matchedRoute.latency_ms > 0) {
    await new Promise((r) => setTimeout(r, Math.min(matchedRoute.latency_ms, 15000)))
  }

  // Optional simulated error rate (%)
  if (matchedRoute.error_rate > 0) {
    const roll = crypto.randomInt(1, 101)
    if (roll <= matchedRoute.error_rate) {
      return c.json(
        {
          error: 'SIMULATED_MOCK_FAILURE',
          message: `Simulated error (${matchedRoute.error_rate}% fault injection rate)`,
        },
        503,
      )
    }
  }

  const customHeaders = safeParseJson<KeyValueItem[]>(matchedRoute.headers_json, [])
  for (const h of customHeaders) {
    if (h.enabled && h.key) {
      c.header(h.key, h.value)
    }
  }
  c.header('X-Meofast-Mock-Route', matchedRoute.id)

  // Stateful CRUD scenario
  if (matchedRoute.is_stateful === 1) {
    const items = safeParseJson<Array<Record<string, unknown>>>(matchedRoute.state_items_json, [])
    if (reqMethod === 'GET') {
      if (pathParams.id) {
        const found = items.find((it) => String(it.id) === pathParams.id)
        if (!found) return c.json({ error: 'Item not found' }, 404)
        return c.json(found, 200)
      }
      return c.json(items, 200)
    }
    if (reqMethod === 'POST') {
      const incoming = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      const created = {
        id: String(incoming.id ?? crypto.randomUUID().slice(0, 8)),
        ...incoming,
        createdAt: new Date().toISOString(),
      }
      const nextItems = [...items, created].slice(-100)
      await db
        .updateTable('mock_routes')
        .set({ state_items_json: JSON.stringify(nextItems), updated_at: new Date().toISOString() })
        .where('id', '=', matchedRoute.id)
        .execute()
      return c.json(created, 201)
    }
    if (reqMethod === 'DELETE' && pathParams.id) {
      const nextItems = items.filter((it) => String(it.id) !== pathParams.id)
      await db
        .updateTable('mock_routes')
        .set({ state_items_json: JSON.stringify(nextItems), updated_at: new Date().toISOString() })
        .where('id', '=', matchedRoute.id)
        .execute()
      return c.json({ deleted: true, id: pathParams.id }, 200)
    }
  }

  const queryObj = c.req.query()
  const rendered = renderDynamicMockBody(matchedRoute.response_body, pathParams, queryObj)
  const status = matchedRoute.status_code as ContentfulStatusCode

  try {
    const parsedJson = JSON.parse(rendered)
    return c.json(parsedJson, status)
  } catch {
    return c.text(rendered, status)
  }
})

// Protected Mock Management Routes
mocksProtectedRoutes.get('/workspaces/:wsId/mocks', async (c) => {
  const user = c.get('user')!
  if (
    !hasPolicyPermission(user.permissions, user.globalRole, 'mocks', 'anyView') &&
    !hasPolicyPermission(user.permissions, user.globalRole, 'mocks', 'view')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view Mock Server.')
  }
  const db = c.get('runtime').getDb()
  const wsId = c.req.param('wsId')

  const ws = await db
    .selectFrom('workspaces')
    .select(['id', 'slug'])
    .where('id', '=', wsId)
    .executeTakeFirst()

  const rows = await db
    .selectFrom('mock_routes')
    .selectAll()
    .where('workspace_id', '=', wsId)
    .orderBy('created_at', 'asc')
    .execute()

  return c.json({
    workspaceSlug: ws?.slug ?? wsId,
    baseMockPath: `/api/v1/mock/${ws?.slug ?? wsId}`,
    routes: rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      collectionId: r.collection_id,
      name: r.name,
      method: r.method,
      pathPattern: r.path_pattern,
      statusCode: r.status_code,
      latencyMs: r.latency_ms,
      errorRate: r.error_rate,
      rateLimitRpm: r.rate_limit_rpm ?? 0,
      headers: safeParseJson<KeyValueItem[]>(r.headers_json, []),
      responseBody: r.response_body,
      isStateful: r.is_stateful === 1,
      stateItems: safeParseJson<Array<Record<string, unknown>>>(r.state_items_json, []),
      hitCount: r.hit_count,
      enabled: r.enabled === 1,
      updatedAt: r.updated_at,
    })),
  })
})

mocksProtectedRoutes.post('/workspaces/:wsId/mocks', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'mocks',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot create mock routes.')
  }

  const parsed = upsertMockRouteSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid mock route payload',
    )
  }

  const d = parsed.data
  const id = crypto.randomUUID()
  const nowIso = new Date().toISOString()

  let initialStateItems: string | null = null
  if (d.isStateful) {
    try {
      const parsedBody = JSON.parse(d.responseBody)
      initialStateItems = JSON.stringify(Array.isArray(parsedBody) ? parsedBody : [parsedBody])
    } catch {
      initialStateItems = '[]'
    }
  }

  await db
    .insertInto('mock_routes')
    .values({
      id,
      workspace_id: wsId,
      collection_id: d.collectionId ?? null,
      name: d.name,
      method: d.method,
      path_pattern: d.pathPattern,
      status_code: d.statusCode,
      latency_ms: d.latencyMs,
      error_rate: d.errorRate,
      rate_limit_rpm: d.rateLimitRpm ?? 0,
      headers_json: JSON.stringify(d.headers),
      response_body: d.responseBody,
      is_stateful: d.isStateful ? 1 : 0,
      state_items_json: initialStateItems,
      enabled: d.enabled ? 1 : 0,
      hit_count: 0,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  return c.json({ id }, 201)
})

mocksProtectedRoutes.put('/mocks/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const id = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'mocks',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot update mock routes.')
  }

  const parsed = upsertMockRouteSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid mock route payload.')
  }

  const d = parsed.data
  const existing = await db
    .selectFrom('mock_routes')
    .select(['id', 'state_items_json'])
    .where('id', '=', id)
    .executeTakeFirst()

  if (!existing) {
    throw new AppError(404, 'MOCK_NOT_FOUND', 'Mock not found.')
  }

  let nextStateItemsJson = existing.state_items_json
  if (d.isStateful && !nextStateItemsJson) {
    try {
      const parsedBody = JSON.parse(d.responseBody)
      nextStateItemsJson = JSON.stringify(Array.isArray(parsedBody) ? parsedBody : [parsedBody])
    } catch {
      nextStateItemsJson = '[]'
    }
  }

  await db
    .updateTable('mock_routes')
    .set({
      name: d.name,
      method: d.method,
      path_pattern: d.pathPattern,
      status_code: d.statusCode,
      latency_ms: d.latencyMs,
      error_rate: d.errorRate,
      rate_limit_rpm: d.rateLimitRpm ?? 0,
      headers_json: JSON.stringify(d.headers),
      response_body: d.responseBody,
      is_stateful: d.isStateful ? 1 : 0,
      state_items_json: nextStateItemsJson,
      enabled: d.enabled ? 1 : 0,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .execute()

  return c.json({ ok: true })
})

mocksProtectedRoutes.post('/mocks/:id/reset-state', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const id = c.req.param('id')

  if (
    !canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'mocks',
      'update',
    )
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot reset mock state.')
  }

  const existing = await db
    .selectFrom('mock_routes')
    .select(['id', 'response_body'])
    .where('id', '=', id)
    .executeTakeFirst()

  if (!existing) {
    throw new AppError(404, 'MOCK_NOT_FOUND', 'Mock not found.')
  }

  const body = (await c.req.json().catch(() => ({}))) as { mode?: 'seed' | 'empty' }
  let nextItems: Array<Record<string, unknown>> = []
  if (body.mode !== 'empty') {
    try {
      const parsedBody = JSON.parse(existing.response_body)
      nextItems = Array.isArray(parsedBody)
        ? (parsedBody as Array<Record<string, unknown>>)
        : [parsedBody as Record<string, unknown>]
    } catch {
      nextItems = []
    }
  }

  await db
    .updateTable('mock_routes')
    .set({
      state_items_json: JSON.stringify(nextItems),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .execute()

  return c.json({ ok: true, stateItems: nextItems })
})

mocksProtectedRoutes.patch('/mocks/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const id = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'mocks',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot rename mock routes.')
  }

  const schema = z.object({
    name: z.string().trim().min(1, 'Route name is required').max(160),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Route name is required.',
    )
  }

  await db
    .updateTable('mock_routes')
    .set({
      name: parsed.data.name,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .execute()

  return c.json({ ok: true, id, name: parsed.data.name })
})

mocksProtectedRoutes.delete('/mocks/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'mocks',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete mock routes.')
  }
  await db.deleteFrom('mock_routes').where('id', '=', c.req.param('id')).execute()
  return c.json({ ok: true })
})

mocksProtectedRoutes.post('/collections/:id/generate-mocks', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const colId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'mocks',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot generate mocks.')
  }

  const col = await db
    .selectFrom('collections')
    .selectAll()
    .where('id', '=', colId)
    .executeTakeFirst()
  if (!col) throw new AppError(404, 'COLLECTION_NOT_FOUND', 'Collection not found.')

  const reqs = await db
    .selectFrom('saved_requests')
    .selectAll()
    .where('collection_id', '=', colId)
    .orderBy('sort_order', 'asc')
    .execute()

  const nowIso = new Date().toISOString()
  let createdCount = 0

  for (const r of reqs) {
    let pathPattern = r.url.replace(/\{\{[^}]+\}\}/g, '')
    try {
      if (pathPattern.startsWith('http://') || pathPattern.startsWith('https://')) {
        pathPattern = new URL(pathPattern).pathname
      }
    } catch {
      // keep raw
    }
    if (!pathPattern.startsWith('/')) pathPattern = `/${pathPattern}`

    const bodyCfg = safeParseJson<RequestBodyConfig>(r.body_json, {
      mode: 'none',
      raw: '',
      urlencoded: [],
      multipart: [],
      binaryBase64: '',
      binaryFileName: '',
      binaryContentType: 'application/octet-stream',
    })

    const sampleBody =
      bodyCfg.mode === 'json' && bodyCfg.raw
        ? bodyCfg.raw
        : JSON.stringify(
            {
              ok: true,
              id: '{{$uuid}}',
              endpoint: r.name,
              timestamp: '{{$isoTimestamp}}',
            },
            null,
            2,
          )

    await db
      .insertInto('mock_routes')
      .values({
        id: crypto.randomUUID(),
        workspace_id: col.workspace_id,
        collection_id: col.id,
        name: r.name,
        method: r.method,
        path_pattern: pathPattern,
        status_code: r.method === 'POST' ? 201 : 200,
        latency_ms: 0,
        error_rate: 0,
        headers_json: '[]',
        response_body: sampleBody,
        is_stateful: 0,
        state_items_json: null,
        enabled: 1,
        hit_count: 0,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()
    createdCount += 1
  }

  return c.json({ createdCount }, 201)
})
