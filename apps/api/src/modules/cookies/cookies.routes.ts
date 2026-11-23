import crypto from 'node:crypto'
import { canWriteWorkspace, hasPolicyPermission } from '@meofast/shared'
import { Hono } from 'hono'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { DatabaseSchema } from '../../core/database/schema.types.js'
import { AppError } from '../../core/errors/app-error.js'
import { requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'

export const cookiesRoutes = new Hono<AppEnv>()
cookiesRoutes.use('*', requireAuthMiddleware)

function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\.+/, '')
}

function domainMatches(requestHost: string, cookieDomain: string): boolean {
  const host = normalizeDomain(requestHost)
  const target = normalizeDomain(cookieDomain)
  if (!host || !target) return false
  return host === target || host.endsWith(`.${target}`)
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  const reqP = requestPath || '/'
  const ckP = cookiePath || '/'
  if (ckP === '/') return true
  return reqP === ckP || reqP.startsWith(ckP.endsWith('/') ? ckP : `${ckP}/`)
}

export async function loadJarCookieHeader(
  db: Kysely<DatabaseSchema>,
  workspaceId: string,
  targetUrl: URL,
): Promise<string | null> {
  const host = normalizeDomain(targetUrl.hostname)
  if (!host) return null

  const nowIso = new Date().toISOString()
  const rows = await db
    .selectFrom('workspace_cookies')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('enabled', '=', 1)
    .execute()

  const pairs: string[] = []
  for (const row of rows) {
    if (row.expires_at && row.expires_at <= nowIso) continue
    if (row.secure === 1 && targetUrl.protocol !== 'https:' && host !== 'meofast.internal') {
      continue
    }
    if (!domainMatches(host, row.domain)) continue
    if (!pathMatches(targetUrl.pathname, row.path)) continue
    pairs.push(`${row.cookie_name}=${row.cookie_value}`)
  }

  return pairs.length > 0 ? pairs.join('; ') : null
}

export async function persistSetCookiesToJar(
  db: Kysely<DatabaseSchema>,
  workspaceId: string,
  targetUrl: URL,
  setCookies: string[],
): Promise<number> {
  if (setCookies.length === 0) return 0
  const defaultDomain = normalizeDomain(targetUrl.hostname)
  if (!defaultDomain) return 0

  const now = new Date()
  const nowIso = now.toISOString()
  let savedCount = 0

  for (const raw of setCookies) {
    const segments = raw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    if (segments.length === 0) continue

    const first = segments[0]!
    const eqIdx = first.indexOf('=')
    if (eqIdx <= 0) continue

    const name = first.slice(0, eqIdx).trim()
    const value = first.slice(eqIdx + 1).trim()
    if (!name) continue

    let domain = defaultDomain
    let cookiePath = '/'
    let httpOnly = 0
    let secure = 0
    let expiresAt: string | null = null
    let shouldDelete = false

    for (const attr of segments.slice(1)) {
      const aEq = attr.indexOf('=')
      const attrName = (aEq > 0 ? attr.slice(0, aEq) : attr).trim().toLowerCase()
      const attrVal = aEq > 0 ? attr.slice(aEq + 1).trim() : ''

      if (attrName === 'domain' && attrVal) {
        const cleanDom = normalizeDomain(attrVal)
        if (domainMatches(defaultDomain, cleanDom)) {
          domain = cleanDom
        }
      } else if (attrName === 'path' && attrVal.startsWith('/')) {
        cookiePath = attrVal
      } else if (attrName === 'httponly') {
        httpOnly = 1
      } else if (attrName === 'secure') {
        secure = 1
      } else if (attrName === 'max-age') {
        const sec = Number(attrVal)
        if (!Number.isNaN(sec)) {
          if (sec <= 0) {
            shouldDelete = true
          } else {
            expiresAt = new Date(now.getTime() + sec * 1000).toISOString()
          }
        }
      } else if (attrName === 'expires' && !expiresAt) {
        const parsedTs = Date.parse(attrVal)
        if (!Number.isNaN(parsedTs)) {
          if (parsedTs <= now.getTime()) {
            shouldDelete = true
          } else {
            expiresAt = new Date(parsedTs).toISOString()
          }
        }
      }
    }

    const existing = await db
      .selectFrom('workspace_cookies')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('domain', '=', domain)
      .where('path', '=', cookiePath)
      .where('cookie_name', '=', name)
      .executeTakeFirst()

    if (shouldDelete) {
      if (existing) {
        await db.deleteFrom('workspace_cookies').where('id', '=', existing.id).execute()
      }
      continue
    }

    if (existing) {
      await db
        .updateTable('workspace_cookies')
        .set({
          cookie_value: value,
          http_only: httpOnly,
          secure,
          expires_at: expiresAt,
          updated_at: nowIso,
        })
        .where('id', '=', existing.id)
        .execute()
    } else {
      await db
        .insertInto('workspace_cookies')
        .values({
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          domain,
          path: cookiePath,
          cookie_name: name,
          cookie_value: value,
          http_only: httpOnly,
          secure,
          expires_at: expiresAt,
          enabled: 1,
          updated_at: nowIso,
        })
        .execute()
    }
    savedCount += 1
  }

  return savedCount
}

const upsertCookieSchema = z.object({
  domain: z.string().trim().min(1).max(255),
  path: z.string().trim().min(1).max(255).default('/'),
  name: z.string().trim().min(1).max(160),
  value: z.string().max(8192).default(''),
  httpOnly: z.boolean().optional().default(false),
  secure: z.boolean().optional().default(false),
  enabled: z.boolean().optional().default(true),
})

const patchCookieSchema = z.object({
  value: z.string().max(8192).optional(),
  enabled: z.boolean().optional(),
})

cookiesRoutes.get('/workspaces/:wsId/cookies', async (c) => {
  const user = c.get('user')!
  if (
    !hasPolicyPermission(user.permissions, user.globalRole, 'cookies', 'anyView') &&
    !hasPolicyPermission(user.permissions, user.globalRole, 'cookies', 'view')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view Cookie Jar.')
  }
  const db = c.get('runtime').getDb()
  const wsId = c.req.param('wsId')

  const rows = await db
    .selectFrom('workspace_cookies')
    .selectAll()
    .where('workspace_id', '=', wsId)
    .orderBy('domain', 'asc')
    .orderBy('cookie_name', 'asc')
    .execute()

  return c.json({
    cookies: rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      domain: r.domain,
      path: r.path,
      name: r.cookie_name,
      value: r.cookie_value,
      httpOnly: r.http_only === 1,
      secure: r.secure === 1,
      expiresAt: r.expires_at,
      enabled: r.enabled === 1,
      updatedAt: r.updated_at,
    })),
  })
})

cookiesRoutes.post('/workspaces/:wsId/cookies', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'cookies',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot modify cookies.')
  }

  const parsed = upsertCookieSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Valid domain and cookie name are required.')
  }

  const d = parsed.data
  const domain = normalizeDomain(d.domain)
  const cookiePath = d.path.startsWith('/') ? d.path : `/${d.path}`
  const nowIso = new Date().toISOString()

  const existing = await db
    .selectFrom('workspace_cookies')
    .select('id')
    .where('workspace_id', '=', wsId)
    .where('domain', '=', domain)
    .where('path', '=', cookiePath)
    .where('cookie_name', '=', d.name)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('workspace_cookies')
      .set({
        cookie_value: d.value,
        http_only: d.httpOnly ? 1 : 0,
        secure: d.secure ? 1 : 0,
        enabled: d.enabled ? 1 : 0,
        updated_at: nowIso,
      })
      .where('id', '=', existing.id)
      .execute()
    return c.json({ id: existing.id })
  }

  const id = crypto.randomUUID()
  await db
    .insertInto('workspace_cookies')
    .values({
      id,
      workspace_id: wsId,
      domain,
      path: cookiePath,
      cookie_name: d.name,
      cookie_value: d.value,
      http_only: d.httpOnly ? 1 : 0,
      secure: d.secure ? 1 : 0,
      expires_at: null,
      enabled: d.enabled ? 1 : 0,
      updated_at: nowIso,
    })
    .execute()

  return c.json({ id }, 201)
})

cookiesRoutes.patch('/cookies/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'cookies',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot modify cookies.')
  }

  const parsed = patchCookieSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid cookie update payload.')
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (parsed.data.value !== undefined) patch.cookie_value = parsed.data.value
  if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled ? 1 : 0

  await db
    .updateTable('workspace_cookies')
    .set(patch)
    .where('id', '=', c.req.param('id'))
    .execute()

  return c.json({ ok: true })
})

cookiesRoutes.delete('/cookies/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'cookies',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete cookies.')
  }
  await db.deleteFrom('workspace_cookies').where('id', '=', c.req.param('id')).execute()
  return c.json({ ok: true })
})

cookiesRoutes.delete('/workspaces/:wsId/cookies', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'cookies',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot clear cookies.')
  }
  const domainFilter = c.req.query('domain')
  let q = db.deleteFrom('workspace_cookies').where('workspace_id', '=', c.req.param('wsId'))
  if (domainFilter) {
    q = q.where('domain', '=', normalizeDomain(domainFilter))
  }
  await q.execute()
  return c.json({ ok: true })
})
