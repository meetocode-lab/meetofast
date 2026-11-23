import crypto from 'node:crypto'
import {
  canWriteWorkspace,
  evaluateLatencyAnomaly,
  hasPolicyPermission,
  type KeyValueItem,
  networkPolicySchema,
  upsertMonitorSchema,
} from '@meofast/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { RuntimeContext } from '../../core/bootstrap/runtime-context.js'
import type { MonitorsTable } from '../../core/database/schema.types.js'
import { AppError } from '../../core/errors/app-error.js'
import { requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'
import { validateOutboundTargetUrl } from '../proxy/ssrf-guard.js'

export const monitorsRoutes = new Hono<AppEnv>()

monitorsRoutes.use('*', requireAuthMiddleware)

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function executeMonitorCheck(
  runtime: RuntimeContext,
  monitor: MonitorsTable,
): Promise<{
  runId: string
  passed: boolean
  statusCode: number | null
  durationMs: number
  errorMessage: string | null
  checkedAt: string
}> {
  const db = runtime.getDb()
  const started = performance.now()
  let statusCode: number | null = null
  let errorMessage: string | null = null
  let passed = false

  try {
    const hdrs = new Headers({ 'User-Agent': 'Meofast-Monitor/1.0' })
    for (const h of safeParseJson<KeyValueItem[]>(monitor.headers_json, [])) {
      if (h.enabled && h.key) hdrs.set(h.key, h.value)
    }

    let urlStr = monitor.url.trim()
    let res: Response

    if (
      urlStr.startsWith('/api/v1/') &&
      (urlStr.startsWith('/api/v1/mock/') ||
        urlStr.startsWith('/api/v1/webhooks/in/') ||
        urlStr.startsWith('/api/v1/playground/') ||
        urlStr === '/api/v1/health') &&
      runtime.localFetch
    ) {
      res = await runtime.localFetch(
        new Request(`http://127.0.0.1${urlStr}`, {
          method: monitor.method,
          headers: hdrs,
          body:
            monitor.method !== 'GET' && monitor.method !== 'HEAD' && monitor.body_raw
              ? monitor.body_raw
              : undefined,
        }),
      )
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
          // safe defaults
        }
      }

      const validatedUrl = await validateOutboundTargetUrl(urlStr, networkPolicy)
      res = await fetch(validatedUrl.toString(), {
        method: monitor.method,
        headers: hdrs,
        body:
          monitor.method !== 'GET' && monitor.method !== 'HEAD' && monitor.body_raw
            ? monitor.body_raw
            : undefined,
        signal: AbortSignal.timeout(Math.max(monitor.max_latency_ms + 3000, 10000)),
      })
    }

    statusCode = res.status
    await res.body?.cancel().catch(() => undefined)
    const elapsed = Math.round(performance.now() - started)

    if (statusCode !== monitor.expected_status) {
      errorMessage = `Expected status ${monitor.expected_status}, received ${statusCode}`
      passed = false
    } else if (elapsed > monitor.max_latency_ms) {
      errorMessage = `Latency ${elapsed} ms exceeded ${monitor.max_latency_ms} ms threshold`
      passed = false
    } else {
      passed = true
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'Check failed'
    passed = false
  }

  const durationMs = Math.round(performance.now() - started)
  const checkedAt = new Date().toISOString()
  const runId = crypto.randomUUID()

  let effectiveHealthStatus: 'healthy' | 'degraded' | 'failing' = passed ? 'healthy' : 'failing'
  if (passed) {
    const priorHealthyRuns = await db
      .selectFrom('monitor_runs')
      .select('duration_ms')
      .where('monitor_id', '=', monitor.id)
      .where('passed', '=', 1)
      .orderBy('checked_at', 'desc')
      .limit(20)
      .execute()
    const chronologicalMs = priorHealthyRuns.map((r) => r.duration_ms).reverse()
    const anomaly = evaluateLatencyAnomaly(chronologicalMs, durationMs)
    if (anomaly.isAnomaly) {
      effectiveHealthStatus = 'degraded'
    }
  }

  await db
    .insertInto('monitor_runs')
    .values({
      id: runId,
      monitor_id: monitor.id,
      passed: passed ? 1 : 0,
      status_code: statusCode,
      duration_ms: durationMs,
      error_message: errorMessage,
      checked_at: checkedAt,
    })
    .execute()

  await db
    .updateTable('monitors')
    .set({
      last_status: effectiveHealthStatus,
      last_latency_ms: durationMs,
      last_run_at: checkedAt,
      updated_at: checkedAt,
    })
    .where('id', '=', monitor.id)
    .execute()

  // Dispatch webhook alert if monitor failed and alert URL is configured
  if (!passed && monitor.alert_webhook_url) {
    try {
      const alertUrl = monitor.alert_webhook_url.trim()
      const alertBody = JSON.stringify({
        monitor: monitor.name,
        url: monitor.url,
        status: 'failing',
        statusCode,
        durationMs,
        error: errorMessage,
        checkedAt,
      })
      if (alertUrl.startsWith('/api/v1/webhooks/in/') && runtime.localFetch) {
        await runtime.localFetch(
          new Request(`http://127.0.0.1${alertUrl}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: alertBody,
          }),
        )
      }
    } catch {
      // never crash monitor loop on alert error
    }
  }

  return { runId, passed, statusCode, durationMs, errorMessage, checkedAt }
}

export async function runDueMonitorsTick(runtime: RuntimeContext): Promise<void> {
  if (!runtime.isInstalled()) return
  const db = runtime.getDb()
  const activeMonitors = await db
    .selectFrom('monitors')
    .selectAll()
    .where('enabled', '=', 1)
    .execute()

  const nowMs = Date.now()
  for (const mon of activeMonitors) {
    const lastMs = mon.last_run_at ? Date.parse(mon.last_run_at) : 0
    if (!lastMs || nowMs - lastMs >= mon.interval_seconds * 1000) {
      await executeMonitorCheck(runtime, mon).catch(() => undefined)
    }
  }
}

monitorsRoutes.get('/workspaces/:wsId/monitors', async (c) => {
  const user = c.get('user')!
  if (
    !hasPolicyPermission(user.permissions, user.globalRole, 'monitors', 'anyView') &&
    !hasPolicyPermission(user.permissions, user.globalRole, 'monitors', 'view')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view Monitors.')
  }
  const db = c.get('runtime').getDb()
  const wsId = c.req.param('wsId')

  const monitors = await db
    .selectFrom('monitors')
    .selectAll()
    .where('workspace_id', '=', wsId)
    .orderBy('created_at', 'desc')
    .execute()

  const monitorIds = monitors.map((m) => m.id)
  const recentRuns =
    monitorIds.length > 0
      ? await db
          .selectFrom('monitor_runs')
          .selectAll()
          .where('monitor_id', 'in', monitorIds)
          .orderBy('checked_at', 'desc')
          .limit(200)
          .execute()
      : []

  return c.json({
    monitors: monitors.map((m) => {
      const runs = recentRuns.filter((r) => r.monitor_id === m.id).slice(0, 20)
      const passedCount = runs.filter((r) => r.passed === 1).length
      const uptimePercent = runs.length > 0 ? Math.round((passedCount / runs.length) * 100) : 100
      const healthyChronological = runs
        .filter((r) => r.passed === 1)
        .map((r) => r.duration_ms)
        .reverse()
      const baselineTelemetry =
        healthyChronological.length > 1
          ? evaluateLatencyAnomaly(
              healthyChronological.slice(0, -1),
              healthyChronological[healthyChronological.length - 1]!,
            )
          : null

      return {
        id: m.id,
        workspaceId: m.workspace_id,
        name: m.name,
        method: m.method,
        url: m.url,
        headers: safeParseJson<KeyValueItem[]>(m.headers_json, []),
        bodyRaw: m.body_raw ?? '',
        expectedStatus: m.expected_status,
        maxLatencyMs: m.max_latency_ms,
        intervalSeconds: m.interval_seconds,
        alertWebhookUrl: m.alert_webhook_url ?? '',
        enabled: m.enabled === 1,
        lastStatus: m.last_status ?? 'pending',
        lastLatencyMs: m.last_latency_ms,
        ewmaLatencyMs: baselineTelemetry?.ewmaMs ?? m.last_latency_ms,
        lastRunAt: m.last_run_at,
        uptimePercent,
        runs: runs.map((r) => ({
          id: r.id,
          passed: r.passed === 1,
          statusCode: r.status_code,
          durationMs: r.duration_ms,
          errorMessage: r.error_message,
          checkedAt: r.checked_at,
        })),
      }
    }),
  })
})

monitorsRoutes.post('/workspaces/:wsId/monitors', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'monitors',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot create monitors.')
  }

  const parsed = upsertMonitorSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid monitor configuration',
    )
  }

  const d = parsed.data
  const id = crypto.randomUUID()
  const nowIso = new Date().toISOString()

  await db
    .insertInto('monitors')
    .values({
      id,
      workspace_id: wsId,
      name: d.name,
      method: d.method,
      url: d.url,
      headers_json: JSON.stringify(d.headers),
      body_raw: d.bodyRaw || null,
      expected_status: d.expectedStatus,
      max_latency_ms: d.maxLatencyMs,
      interval_seconds: d.intervalSeconds,
      alert_webhook_url: d.alertWebhookUrl || null,
      enabled: d.enabled ? 1 : 0,
      last_status: null,
      last_latency_ms: null,
      last_run_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  return c.json({ id }, 201)
})

monitorsRoutes.post('/monitors/:id/run', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const mon = await db
    .selectFrom('monitors')
    .selectAll()
    .where('id', '=', c.req.param('id'))
    .executeTakeFirst()

  if (!mon) throw new AppError(404, 'MONITOR_NOT_FOUND', 'Monitor not found.')

  const result = await executeMonitorCheck(runtime, mon)
  return c.json(result)
})

monitorsRoutes.patch('/monitors/:id', async (c) => {
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
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot rename monitors.')
  }

  const schema = z.object({
    name: z.string().trim().min(1, 'Monitor name is required').max(160),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Monitor name is required.',
    )
  }

  await db
    .updateTable('monitors')
    .set({
      name: parsed.data.name,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .execute()

  return c.json({ ok: true, id, name: parsed.data.name })
})

monitorsRoutes.delete('/monitors/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'monitors',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete monitors.')
  }
  await db.deleteFrom('monitors').where('id', '=', c.req.param('id')).execute()
  return c.json({ ok: true })
})
