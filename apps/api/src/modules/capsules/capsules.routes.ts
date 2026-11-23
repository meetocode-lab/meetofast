import crypto from 'node:crypto'
import { canWriteWorkspace, hasPolicyPermission, saveDebugCapsuleSchema } from '@meofast/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { AppError } from '../../core/errors/app-error.js'
import { requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'

export const capsulesRoutes = new Hono<AppEnv>()

capsulesRoutes.use('*', requireAuthMiddleware)

const SENSITIVE_HEADER_REGEX = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i

function sanitizeCapsuleObject(raw: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
  const reqObj = clone.request as Record<string, unknown> | undefined
  if (reqObj && Array.isArray(reqObj.headers)) {
    reqObj.headers = (reqObj.headers as Array<Record<string, unknown>>).map((h) => {
      const k = String(h.key ?? '')
      if (SENSITIVE_HEADER_REGEX.test(k)) {
        return { ...h, value: '[REDACTED]' }
      }
      return h
    })
  }
  const resObj = clone.response as Record<string, unknown> | undefined
  if (resObj && resObj.headers && typeof resObj.headers === 'object') {
    const resHdrs = resObj.headers as Record<string, string>
    for (const k of Object.keys(resHdrs)) {
      if (SENSITIVE_HEADER_REGEX.test(k)) {
        resHdrs[k] = '[REDACTED]'
      }
    }
  }
  return clone
}

capsulesRoutes.get('/workspaces/:wsId/capsules', async (c) => {
  const user = c.get('user')!
  if (
    !hasPolicyPermission(user.permissions, user.globalRole, 'history', 'anyView') &&
    !hasPolicyPermission(user.permissions, user.globalRole, 'history', 'view')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view Debug Capsules.')
  }
  const db = c.get('runtime').getDb()
  const wsId = c.req.param('wsId')

  const rows = await db
    .selectFrom('debug_capsules')
    .selectAll()
    .where('workspace_id', '=', wsId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute()

  return c.json({
    capsules: rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      title: r.title,
      notes: r.notes ?? '',
      capsule: JSON.parse(r.capsule_json || '{}') as Record<string, unknown>,
      createdAt: r.created_at,
    })),
  })
})

capsulesRoutes.post('/workspaces/:wsId/capsules', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'history',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot save debug capsules.')
  }

  const parsed = saveDebugCapsuleSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Valid capsule title and payload required.')
  }

  const sanitized = sanitizeCapsuleObject(parsed.data.capsule)
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  await db
    .insertInto('debug_capsules')
    .values({
      id,
      workspace_id: wsId,
      title: parsed.data.title,
      notes: parsed.data.notes || null,
      capsule_json: JSON.stringify(sanitized),
      created_by: user.id,
      created_at: createdAt,
    })
    .execute()

  return c.json({ id, capsule: sanitized, createdAt }, 201)
})

capsulesRoutes.patch('/capsules/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const id = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'history',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot rename debug capsules.')
  }

  const schema = z.object({
    title: z.string().trim().min(1, 'Capsule title is required').max(200),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Capsule title is required.',
    )
  }

  const existing = await db
    .selectFrom('debug_capsules')
    .select(['id', 'capsule_json'])
    .where('id', '=', id)
    .executeTakeFirst()
  if (!existing) {
    throw new AppError(404, 'CAPSULE_NOT_FOUND', 'Debug capsule not found.')
  }

  let nextCapsuleJson = existing.capsule_json
  try {
    const capObj = JSON.parse(existing.capsule_json || '{}') as Record<string, unknown>
    capObj.title = parsed.data.title
    nextCapsuleJson = JSON.stringify(capObj)
  } catch {
    // keep raw capsule_json
  }

  await db
    .updateTable('debug_capsules')
    .set({
      title: parsed.data.title,
      capsule_json: nextCapsuleJson,
    })
    .where('id', '=', id)
    .execute()

  return c.json({ ok: true, id, title: parsed.data.title })
})

capsulesRoutes.delete('/capsules/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'history',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete debug capsules.')
  }
  await db.deleteFrom('debug_capsules').where('id', '=', c.req.param('id')).execute()
  return c.json({ ok: true })
})
