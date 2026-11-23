import crypto from 'node:crypto'
import {
  canWriteWorkspace,
  createWebhookEndpointSchema,
  hasPolicyPermission,
  networkPolicySchema,
  replayWebhookEventSchema,
} from '@meofast/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { AppError } from '../../core/errors/app-error.js'
import { paginateServerArray, parseTableQuery } from '../../core/http/pagination.js'
import { requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'
import { validateOutboundTargetUrl } from '../proxy/ssrf-guard.js'

export const webhooksPublicRoutes = new Hono<AppEnv>()
export const webhooksProtectedRoutes = new Hono<AppEnv>()

webhooksProtectedRoutes.use('*', requireAuthMiddleware)

function verifyHmacSignature(
  secret: string | null,
  rawBody: string,
  headers: Record<string, string>,
): 'verified' | 'invalid' | 'unsigned' {
  if (!secret) return 'unsigned'
  const provided =
    headers['x-hub-signature-256'] ||
    headers['x-webhook-signature'] ||
    headers['x-meofast-signature']
  if (!provided) return 'unsigned'

  const cleanProvided = provided.replace(/^sha256=/i, '').trim()
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  try {
    const a = Buffer.from(cleanProvided, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'verified' : 'invalid'
  } catch {
    return 'invalid'
  }
}

// Public Webhook Receiver: /api/v1/webhooks/in/:token
webhooksPublicRoutes.all('/:token', async (c) => {
  const db = c.get('runtime').getDb()
  const token = c.req.param('token')

  const endpoint = await db
    .selectFrom('webhook_endpoints')
    .selectAll()
    .where('token', '=', token)
    .executeTakeFirst()

  if (!endpoint || endpoint.enabled !== 1) {
    return c.json({ error: 'Webhook endpoint not found or disabled' }, 404)
  }

  const rawBody = await c.req.text().catch(() => '')
  const headersObj: Record<string, string> = {}
  c.req.raw.headers.forEach((v, k) => {
    headersObj[k.toLowerCase()] = v
  })

  const hmacStatus = verifyHmacSignature(endpoint.signing_secret, rawBody, headersObj)
  const eventId = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  await db
    .insertInto('webhook_events')
    .values({
      id: eventId,
      endpoint_id: endpoint.id,
      method: c.req.method.toUpperCase(),
      path: c.req.path,
      query_json: JSON.stringify(c.req.query()),
      headers_json: JSON.stringify(headersObj),
      body_raw: rawBody.slice(0, 500_000),
      source_ip: c.get('clientIp') || '127.0.0.1',
      hmac_status: hmacStatus,
      created_at: createdAt,
    })
    .execute()

  return c.json(
    {
      received: true,
      eventId,
      hmacStatus,
      timestamp: createdAt,
    },
    200,
  )
})

// Protected Webhook Inspector Management
webhooksProtectedRoutes.get('/workspaces/:wsId/webhooks', async (c) => {
  const user = c.get('user')!
  if (
    !hasPolicyPermission(user.permissions, user.globalRole, 'webhooks', 'anyView') &&
    !hasPolicyPermission(user.permissions, user.globalRole, 'webhooks', 'view')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view Webhooks.')
  }
  const db = c.get('runtime').getDb()
  const wsId = c.req.param('wsId')

  const rows = await db
    .selectFrom('webhook_endpoints')
    .selectAll()
    .where('workspace_id', '=', wsId)
    .orderBy('created_at', 'desc')
    .execute()

  return c.json({
    endpoints: rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      token: r.token,
      receivePath: `/api/v1/webhooks/in/${r.token}`,
      hasSigningSecret: Boolean(r.signing_secret),
      forwardUrl: r.forward_url ?? '',
      enabled: r.enabled === 1,
      createdAt: r.created_at,
    })),
  })
})

webhooksProtectedRoutes.post('/workspaces/:wsId/webhooks', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'webhooks',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot create webhook endpoints.')
  }

  const parsed = createWebhookEndpointSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Endpoint name is required.')
  }

  const id = crypto.randomUUID()
  const token = crypto.randomBytes(14).toString('hex')
  const createdAt = new Date().toISOString()

  await db
    .insertInto('webhook_endpoints')
    .values({
      id,
      workspace_id: wsId,
      name: parsed.data.name,
      token,
      signing_secret: parsed.data.signingSecret?.trim() || null,
      forward_url: parsed.data.forwardUrl?.trim() || null,
      enabled: 1,
      created_at: createdAt,
    })
    .execute()

  return c.json(
    {
      endpoint: {
        id,
        workspaceId: wsId,
        name: parsed.data.name,
        token,
        receivePath: `/api/v1/webhooks/in/${token}`,
        hasSigningSecret: Boolean(parsed.data.signingSecret?.trim()),
        enabled: true,
        createdAt,
      },
    },
    201,
  )
})

webhooksProtectedRoutes.patch('/webhooks/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const id = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'webhooks',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot rename webhook endpoints.')
  }

  const schema = z.object({
    name: z.string().trim().min(1, 'Endpoint name is required').max(160),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Endpoint name is required.',
    )
  }

  await db
    .updateTable('webhook_endpoints')
    .set({ name: parsed.data.name })
    .where('id', '=', id)
    .execute()

  return c.json({ ok: true, id, name: parsed.data.name })
})

webhooksProtectedRoutes.delete('/webhooks/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'webhooks',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete webhook endpoints.')
  }
  await db.deleteFrom('webhook_endpoints').where('id', '=', c.req.param('id')).execute()
  return c.json({ ok: true })
})

webhooksProtectedRoutes.get('/webhooks/:id/events', async (c) => {
  const db = c.get('runtime').getDb()
  const epId = c.req.param('id')

  const rows = await db
    .selectFrom('webhook_events')
    .selectAll()
    .where('endpoint_id', '=', epId)
    .orderBy('created_at', 'desc')
    .limit(80)
    .execute()

  return c.json({
    events: rows.map((e) => ({
      id: e.id,
      endpointId: e.endpoint_id,
      method: e.method,
      path: e.path,
      query: JSON.parse(e.query_json || '{}') as Record<string, string>,
      headers: JSON.parse(e.headers_json || '{}') as Record<string, string>,
      bodyRaw: e.body_raw,
      sourceIp: e.source_ip ?? '',
      hmacStatus: e.hmac_status,
      createdAt: e.created_at,
    })),
  })
})

webhooksProtectedRoutes.get('/webhooks/events/:eventId/headers', async (c) => {
  const db = c.get('runtime').getDb()
  const eventId = c.req.param('eventId')
  const tq = parseTableQuery(c, 10)

  const ev = await db
    .selectFrom('webhook_events')
    .select(['id', 'headers_json'])
    .where('id', '=', eventId)
    .executeTakeFirst()
  if (!ev) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Webhook event not found.')
  }

  let headersObj: Record<string, string> = {}
  try {
    headersObj = JSON.parse(ev.headers_json || '{}') as Record<string, string>
  } catch {
    headersObj = {}
  }

  const rows = Object.entries(headersObj).map(([key, value]) => ({ key, value: String(value) }))
  return c.json(
    paginateServerArray(rows, tq, {
      getSearchText: (r) => `${r.key} ${r.value}`,
      sortExtractors: {
        key: (r) => r.key,
        value: (r) => r.value,
      },
    }),
  )
})

webhooksProtectedRoutes.delete('/webhooks/:id/events', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'webhooks',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot clear webhook events.')
  }
  await db.deleteFrom('webhook_events').where('endpoint_id', '=', c.req.param('id')).execute()
  return c.json({ ok: true })
})

webhooksProtectedRoutes.post('/webhooks/:id/test-event', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const epId = c.req.param('id')

  const ep = await db
    .selectFrom('webhook_endpoints')
    .selectAll()
    .where('id', '=', epId)
    .executeTakeFirst()
  if (!ep) throw new AppError(404, 'WEBHOOK_NOT_FOUND', 'Webhook endpoint not found.')

  const samplePayload = JSON.stringify(
    {
      event: 'order.paid',
      id: `evt_${crypto.randomUUID().slice(0, 8)}`,
      amount: 149000,
      currency: 'IDR',
      sentAt: new Date().toISOString(),
    },
    null,
    2,
  )

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'Meofast-Webhook-Tester/1.0',
  }
  if (ep.signing_secret) {
    const sig = crypto.createHmac('sha256', ep.signing_secret).update(samplePayload, 'utf8').digest('hex')
    headers['x-hub-signature-256'] = `sha256=${sig}`
  }

  if (runtime.localFetch) {
    await runtime.localFetch(
      new Request(`http://127.0.0.1/api/v1/webhooks/in/${ep.token}`, {
        method: 'POST',
        headers,
        body: samplePayload,
      }),
    )
  }

  return c.json({ ok: true })
})

webhooksProtectedRoutes.post('/webhooks/events/:eventId/replay', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const eventId = c.req.param('eventId')

  const parsed = replayWebhookEventSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Target URL is required.')
  }

  const ev = await db
    .selectFrom('webhook_events')
    .selectAll()
    .where('id', '=', eventId)
    .executeTakeFirst()
  if (!ev) throw new AppError(404, 'EVENT_NOT_FOUND', 'Webhook event not found.')

  let targetUrlStr = parsed.data.targetUrl.trim()
  const origHeaders = JSON.parse(ev.headers_json || '{}') as Record<string, string>
  const replayHeaders = new Headers({
    'Content-Type': origHeaders['content-type'] || 'application/json',
    'X-Meofast-Replay-Event-ID': ev.id,
  })
  if (origHeaders['x-hub-signature-256']) {
    replayHeaders.set('X-Hub-Signature-256', origHeaders['x-hub-signature-256'])
  }

  const started = performance.now()

  if (
    targetUrlStr.startsWith('/api/v1/') &&
    (targetUrlStr.startsWith('/api/v1/mock/') || targetUrlStr.startsWith('/api/v1/webhooks/in/')) &&
    runtime.localFetch
  ) {
    const res = await runtime.localFetch(
      new Request(`http://127.0.0.1${targetUrlStr}`, {
        method: ev.method,
        headers: replayHeaders,
        body: ev.method !== 'GET' && ev.method !== 'HEAD' ? ev.body_raw : undefined,
      }),
    )
    return c.json({
      status: res.status,
      durationMs: Math.round(performance.now() - started),
      body: (await res.text()).slice(0, 10_000),
    })
  }

  if (!/^https?:\/\//i.test(targetUrlStr)) {
    targetUrlStr = `https://${targetUrlStr}`
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
      // safe default
    }
  }

  const validated = await validateOutboundTargetUrl(targetUrlStr, networkPolicy)
  const upstream = await fetch(validated.toString(), {
    method: ev.method,
    headers: replayHeaders,
    body: ev.method !== 'GET' && ev.method !== 'HEAD' ? ev.body_raw : undefined,
    signal: AbortSignal.timeout(15000),
  })

  return c.json({
    status: upstream.status,
    durationMs: Math.round(performance.now() - started),
    body: (await upstream.text()).slice(0, 10_000),
  })
})
