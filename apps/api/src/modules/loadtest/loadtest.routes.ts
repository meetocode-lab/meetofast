import crypto from 'node:crypto'
import {
  canWriteWorkspace,
  computeApdexAndJitter,
  hasPolicyPermission,
  type LoadTestSummary,
  networkPolicySchema,
  runLoadTestSchema,
  TokenBucket,
} from '@meofast/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { AppError } from '../../core/errors/app-error.js'
import { requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'
import { validateOutboundTargetUrl } from '../proxy/ssrf-guard.js'

export const loadTestRoutes = new Hono<AppEnv>()

loadTestRoutes.use('*', requireAuthMiddleware)

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}

loadTestRoutes.get('/workspaces/:wsId/load-tests', async (c) => {
  const user = c.get('user')!
  if (
    !hasPolicyPermission(user.permissions, user.globalRole, 'monitors', 'anyView') &&
    !hasPolicyPermission(user.permissions, user.globalRole, 'monitors', 'view')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view Load Tests.')
  }
  const db = c.get('runtime').getDb()
  const wsId = c.req.param('wsId')

  const rows = await db
    .selectFrom('load_test_runs')
    .selectAll()
    .where('workspace_id', '=', wsId)
    .orderBy('created_at', 'desc')
    .limit(30)
    .execute()

  return c.json({
    runs: rows.map((r) => JSON.parse(r.summary_json) as LoadTestSummary),
  })
})

loadTestRoutes.post('/workspaces/:wsId/load-tests/run', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'monitors',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot run load tests.')
  }

  const parsed = runLoadTestSchema.safeParse({
    ...(await c.req.json().catch(() => ({}))),
    workspaceId: wsId,
  })
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid load test parameters',
    )
  }

  const d = parsed.data
  let urlStr = d.url.trim()
  let isInternal = false

  if (
    urlStr.startsWith('/api/v1/') &&
    (urlStr.startsWith('/api/v1/mock/') ||
      urlStr.startsWith('/api/v1/webhooks/in/') ||
      urlStr.startsWith('/api/v1/playground/') ||
      urlStr === '/api/v1/health') &&
    runtime.localFetch
  ) {
    isInternal = true
  } else {
    if (!/^https?:\/\//i.test(urlStr)) urlStr = `https://${urlStr}`

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

    const validated = await validateOutboundTargetUrl(urlStr, networkPolicy)
    urlStr = validated.toString()
  }

  const headers = new Headers({ 'User-Agent': 'Meofast-LoadRunner/1.0' })
  for (const h of d.headers) {
    if (h.enabled && h.key) headers.set(h.key, h.value)
  }
  const bodyPayload =
    d.method !== 'GET' && d.method !== 'HEAD' && d.body.mode !== 'none'
      ? d.body.raw || undefined
      : undefined
  if (bodyPayload && d.body.mode === 'json' && !headers.has('content-type')) {
    headers.set('Content-Type', 'application/json')
  }

  const latencies: number[] = []
  const statusCounts: Record<string, number> = {}
  let succeeded = 0
  let failed = 0
  let nextIndex = 0

  const suiteStart = performance.now()
  const pacer =
    d.targetRps && d.targetRps > 0
      ? new TokenBucket(d.targetRps, Math.max(1, Math.min(d.virtualUsers, d.targetRps)))
      : null

  const worker = async () => {
    while (true) {
      const idx = nextIndex++
      if (idx >= d.totalRequests) break

      if (pacer) {
        const delayMs = pacer.waitDelayMs(1)
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, Math.min(delayMs, 5000)))
        }
      }

      const reqStart = performance.now()
      try {
        const res =
          isInternal && runtime.localFetch
            ? await runtime.localFetch(
                new Request(`http://127.0.0.1${urlStr}`, {
                  method: d.method,
                  headers,
                  body: bodyPayload,
                }),
              )
            : await fetch(urlStr, {
                method: d.method,
                headers,
                body: bodyPayload,
                signal: AbortSignal.timeout(d.timeoutMs),
              })

        await res.body?.cancel().catch(() => undefined)
        const elapsed = Math.max(1, Math.round(performance.now() - reqStart))
        latencies.push(elapsed)

        const codeKey = String(res.status)
        statusCounts[codeKey] = (statusCounts[codeKey] ?? 0) + 1

        if (res.status >= 200 && res.status < 400) {
          succeeded += 1
        } else {
          failed += 1
        }
      } catch {
        const elapsed = Math.max(1, Math.round(performance.now() - reqStart))
        latencies.push(elapsed)
        statusCounts.ERR = (statusCounts.ERR ?? 0) + 1
        failed += 1
      }
    }
  }

  const concurrency = Math.min(d.virtualUsers, d.totalRequests)
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  const totalDurationMs = Math.max(1, Math.round(performance.now() - suiteStart))
  latencies.sort((a, b) => a - b)

  const sumMs = latencies.reduce((acc, v) => acc + v, 0)
  const minMs = latencies[0] ?? 0
  const maxMs = latencies[latencies.length - 1] ?? 0
  const avgMs = latencies.length > 0 ? Math.round(sumMs / latencies.length) : 0
  const p50Ms = percentile(latencies, 50)
  const p95Ms = percentile(latencies, 95)
  const p99Ms = percentile(latencies, 99)

  const rps = Number(((d.totalRequests / totalDurationMs) * 1000).toFixed(2))
  const errorRatePercent = Number(((failed / d.totalRequests) * 100).toFixed(1))
  const { apdexScore, jitterMs } = computeApdexAndJitter(
    latencies,
    failed,
    Math.min(500, Math.max(100, Math.round(d.timeoutMs / 10))),
  )

  // Build 4 clean latency distribution buckets
  const span = Math.max(4, maxMs - minMs)
  const step = Math.ceil(span / 4)
  const buckets = [0, 1, 2, 3].map((b) => {
    const low = minMs + b * step
    const high = b === 3 ? maxMs : minMs + (b + 1) * step - 1
    const count = latencies.filter((ms) =>
      b === 3 ? ms >= low && ms <= high : ms >= low && ms <= high,
    ).length
    return {
      label: `${low}-${Math.max(low, high)} ms`,
      count,
    }
  })

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  const summary: LoadTestSummary = {
    id,
    name: d.name,
    method: d.method,
    url: d.url,
    virtualUsers: d.virtualUsers,
    totalRequests: d.totalRequests,
    completedRequests: succeeded + failed,
    succeededRequests: succeeded,
    failedRequests: failed,
    errorRatePercent,
    totalDurationMs,
    requestsPerSecond: rps,
    apdexScore,
    jitterMs,
    latency: { minMs, avgMs, p50Ms, p95Ms, p99Ms, maxMs },
    statusCounts,
    buckets,
    createdAt,
  }

  await db
    .insertInto('load_test_runs')
    .values({
      id,
      workspace_id: wsId,
      name: d.name,
      method: d.method,
      url: d.url,
      virtual_users: d.virtualUsers,
      total_requests: d.totalRequests,
      rps_text: String(rps),
      error_rate_text: String(errorRatePercent),
      p50_ms: p50Ms,
      p95_ms: p95Ms,
      p99_ms: p99Ms,
      summary_json: JSON.stringify(summary),
      created_by: user.id,
      created_at: createdAt,
    })
    .execute()

  return c.json(summary, 201)
})

loadTestRoutes.patch('/load-tests/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const id = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'monitors',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot rename load test runs.')
  }

  const schema = z.object({
    name: z.string().trim().min(1, 'Run name is required').max(160),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Run name is required.',
    )
  }

  const existing = await db
    .selectFrom('load_test_runs')
    .select(['id', 'summary_json'])
    .where('id', '=', id)
    .executeTakeFirst()
  if (!existing) {
    throw new AppError(404, 'LOAD_TEST_NOT_FOUND', 'Load test run not found.')
  }

  let nextSummaryJson = existing.summary_json
  try {
    const summaryObj = JSON.parse(existing.summary_json || '{}') as Record<string, unknown>
    summaryObj.name = parsed.data.name
    nextSummaryJson = JSON.stringify(summaryObj)
  } catch {
    // keep raw summary_json if malformed
  }

  await db
    .updateTable('load_test_runs')
    .set({
      name: parsed.data.name,
      summary_json: nextSummaryJson,
    })
    .where('id', '=', id)
    .execute()

  return c.json({ ok: true, id, name: parsed.data.name })
})

loadTestRoutes.delete('/load-tests/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'monitors',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete load test runs.')
  }
  await db.deleteFrom('load_test_runs').where('id', '=', c.req.param('id')).execute()
  return c.json({ ok: true })
})
