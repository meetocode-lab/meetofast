import crypto from 'node:crypto'
import { canWriteWorkspace, upsertEnvironmentSchema } from '@meofast/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { AppError } from '../../core/errors/app-error.js'
import { paginateServerArray, parseTableQuery } from '../../core/http/pagination.js'
import { requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'

export const environmentsRoutes = new Hono<AppEnv>()

environmentsRoutes.use('*', requireAuthMiddleware)

environmentsRoutes.get('/workspaces/:wsId/environments', async (c) => {
  const db = c.get('runtime').getDb()
  const wsId = c.req.param('wsId')

  const envs = await db
    .selectFrom('environments')
    .selectAll()
    .where('workspace_id', '=', wsId)
    .orderBy('is_global', 'desc')
    .orderBy('created_at', 'asc')
    .execute()

  const envIds = envs.map((e) => e.id)
  const vars =
    envIds.length > 0
      ? await db
          .selectFrom('environment_variables')
          .selectAll()
          .where('environment_id', 'in', envIds)
          .orderBy('sort_order', 'asc')
          .execute()
      : []

  return c.json({
    environments: envs.map((e) => ({
      id: e.id,
      workspaceId: e.workspace_id,
      name: e.name,
      isGlobal: e.is_global === 1,
      variables: vars
        .filter((v) => v.environment_id === e.id)
        .map((v) => ({
          id: v.id,
          key: v.var_key,
          value: v.is_secret === 1 ? '' : v.var_value,
          isSecret: v.is_secret === 1,
          hasSecretValue: v.is_secret === 1 && Boolean(v.encrypted_value),
          enabled: v.enabled === 1,
        })),
    })),
  })
})

environmentsRoutes.post('/workspaces/:wsId/environments', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'environments',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot create environments.')
  }

  const parsed = upsertEnvironmentSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid environment payload',
    )
  }

  const nowIso = new Date().toISOString()
  const envId = crypto.randomUUID()

  await db
    .insertInto('environments')
    .values({
      id: envId,
      workspace_id: wsId,
      name: parsed.data.name,
      is_global: parsed.data.isGlobal ? 1 : 0,
      created_by: user.id,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  for (let idx = 0; idx < parsed.data.variables.length; idx += 1) {
    const v = parsed.data.variables[idx]!
    await db
      .insertInto('environment_variables')
      .values({
        id: crypto.randomUUID(),
        environment_id: envId,
        var_key: v.key,
        var_value: v.isSecret ? '' : v.value,
        encrypted_value: v.isSecret && v.value ? runtime.vault.encrypt(v.value) : null,
        is_secret: v.isSecret ? 1 : 0,
        enabled: v.enabled ? 1 : 0,
        sort_order: idx,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()
  }

  return c.json({ id: envId }, 201)
})

environmentsRoutes.put('/environments/:id', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const user = c.get('user')!
  const envId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'environments',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot modify environments.')
  }

  const parsed = upsertEnvironmentSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid environment payload',
    )
  }

  const existingVars = await db
    .selectFrom('environment_variables')
    .selectAll()
    .where('environment_id', '=', envId)
    .execute()
  const existingById = new Map(existingVars.map((ev) => [ev.id, ev]))

  const nowIso = new Date().toISOString()
  await db
    .updateTable('environments')
    .set({
      name: parsed.data.name,
      updated_at: nowIso,
    })
    .where('id', '=', envId)
    .execute()

  await db.deleteFrom('environment_variables').where('environment_id', '=', envId).execute()

  for (let idx = 0; idx < parsed.data.variables.length; idx += 1) {
    const v = parsed.data.variables[idx]!
    const prev = v.id ? existingById.get(v.id) : undefined
    let encryptedVal: string | null = null
    if (v.isSecret) {
      if (v.value) {
        encryptedVal = runtime.vault.encrypt(v.value)
      } else if (v.keepExistingSecret && prev?.encrypted_value) {
        encryptedVal = prev.encrypted_value
      }
    }

    await db
      .insertInto('environment_variables')
      .values({
        id: v.id ?? crypto.randomUUID(),
        environment_id: envId,
        var_key: v.key,
        var_value: v.isSecret ? '' : v.value,
        encrypted_value: encryptedVal,
        is_secret: v.isSecret ? 1 : 0,
        enabled: v.enabled ? 1 : 0,
        sort_order: idx,
        created_at: prev?.created_at ?? nowIso,
        updated_at: nowIso,
      })
      .execute()
  }

  return c.json({ ok: true })
})

environmentsRoutes.patch('/environments/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const envId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'environments',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot rename environments.')
  }

  const schema = z.object({
    name: z.string().trim().min(1, 'Environment name is required').max(160),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Environment name is required.',
    )
  }

  await db
    .updateTable('environments')
    .set({
      name: parsed.data.name,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', envId)
    .execute()

  return c.json({ ok: true, id: envId, name: parsed.data.name })
})

environmentsRoutes.delete('/environments/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const envId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'environments',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete environments.')
  }

  const target = await db
    .selectFrom('environments')
    .select(['id', 'is_global'])
    .where('id', '=', envId)
    .executeTakeFirst()

  if (target?.is_global === 1) {
    throw new AppError(400, 'CANNOT_DELETE_GLOBAL', 'Global Variables environment cannot be deleted.')
  }

  await db.deleteFrom('environments').where('id', '=', envId).execute()
  return c.json({ ok: true })
})

environmentsRoutes.post('/workspaces/:wsId/environments/import-dotenv', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'environments',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot import environments.')
  }

  const schema = z.object({
    name: z.string().trim().min(1).max(160),
    dotenvContent: z.string().min(1),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Environment name and .env content are required.')
  }

  const nowIso = new Date().toISOString()
  const envId = crypto.randomUUID()

  await db
    .insertInto('environments')
    .values({
      id: envId,
      workspace_id: wsId,
      name: parsed.data.name,
      is_global: 0,
      created_by: user.id,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  const lines = parsed.data.dotenvContent.split(/\r?\n/)
  let order = 0
  const trimmedRaw = parsed.data.dotenvContent.trim()

  // Auto-detect Postman Environment JSON ({ name, values: [{ key, value, type, enabled }] })
  if (trimmedRaw.startsWith('{')) {
    try {
      const pmEnv = JSON.parse(trimmedRaw) as {
        values?: Array<{ key?: string; value?: string; type?: string; enabled?: boolean }>
      }
      if (Array.isArray(pmEnv.values)) {
        for (const item of pmEnv.values) {
          const key = String(item.key ?? '').trim()
          if (!key) continue
          const val = String(item.value ?? '')
          const looksSecret =
            item.type === 'secret' || /secret|token|password|api_key|apikey|private/i.test(key)
          await db
            .insertInto('environment_variables')
            .values({
              id: crypto.randomUUID(),
              environment_id: envId,
              var_key: key,
              var_value: looksSecret ? '' : val,
              encrypted_value: looksSecret && val ? runtime.vault.encrypt(val) : null,
              is_secret: looksSecret ? 1 : 0,
              enabled: item.enabled === false ? 0 : 1,
              sort_order: order++,
              created_at: nowIso,
              updated_at: nowIso,
            })
            .execute()
        }
        return c.json({ id: envId, importedCount: order }, 201)
      }
    } catch {
      // Fall back to .env line parser
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIdx = line.indexOf('=')
    if (eqIdx <= 0) continue
    const key = line.slice(0, eqIdx).trim()
    const val = line
      .slice(eqIdx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    const looksSecret = /secret|token|password|api_key|apikey|private/i.test(key)

    await db
      .insertInto('environment_variables')
      .values({
        id: crypto.randomUUID(),
        environment_id: envId,
        var_key: key,
        var_value: looksSecret ? '' : val,
        encrypted_value: looksSecret && val ? runtime.vault.encrypt(val) : null,
        is_secret: looksSecret ? 1 : 0,
        enabled: 1,
        sort_order: order,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()
    order += 1
  }

  return c.json({ id: envId, importedCount: order }, 201)
})

environmentsRoutes.get('/environments/compare', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const leftId = c.req.query('leftId') ?? ''
  const rightId = c.req.query('rightId') ?? ''
  const tq = parseTableQuery(c, 10)

  if (!leftId || !rightId) {
    return c.json({ items: [], total: 0, page: tq.page, pageSize: tq.pageSize })
  }

  const vars = await db
    .selectFrom('environment_variables')
    .selectAll()
    .where('environment_id', 'in', [leftId, rightId])
    .orderBy('sort_order', 'asc')
    .execute()

  const leftMap = new Map(vars.filter((v) => v.environment_id === leftId).map((v) => [v.var_key, v]))
  const rightMap = new Map(
    vars.filter((v) => v.environment_id === rightId).map((v) => [v.var_key, v]),
  )

  const resolveComparableVal = (v: (typeof vars)[number]) => {
    if (v.is_secret === 1) {
      if (!v.encrypted_value) return ''
      try {
        return runtime.vault.decrypt(v.encrypted_value)
      } catch {
        return v.encrypted_value
      }
    }
    return v.var_value
  }

  const allKeys = Array.from(new Set([...leftMap.keys(), ...rightMap.keys()])).sort()
  const allRows = allKeys.map((key) => {
    const l = leftMap.get(key)
    const r = rightMap.get(key)
    const state: 'missing_right' | 'missing_left' | 'different' | 'same' = !r
      ? 'missing_right'
      : !l
        ? 'missing_left'
        : resolveComparableVal(l) === resolveComparableVal(r)
          ? 'same'
          : 'different'

    return {
      key,
      left: l
        ? {
            isSecret: l.is_secret === 1,
            value: l.is_secret === 1 ? '' : l.var_value,
          }
        : null,
      right: r
        ? {
            isSecret: r.is_secret === 1,
            value: r.is_secret === 1 ? '' : r.var_value,
          }
        : null,
      state,
    }
  })

  const paged = paginateServerArray(allRows, tq, {
    getSearchText: (row) =>
      `${row.key} ${row.state} ${row.left?.isSecret ? 'secret' : (row.left?.value ?? '')} ${row.right?.isSecret ? 'secret' : (row.right?.value ?? '')}`,
    sortExtractors: {
      key: (row) => row.key,
      left: (row) => (!row.left ? '' : row.left.isSecret ? '[secret]' : row.left.value),
      right: (row) => (!row.right ? '' : row.right.isSecret ? '[secret]' : row.right.value),
      status: (row) => row.state,
    },
  })

  return c.json(paged)
})

environmentsRoutes.get('/environments/:id/export-dotenv', async (c) => {
  const db = c.get('runtime').getDb()
  const envId = c.req.param('id')

  const vars = await db
    .selectFrom('environment_variables')
    .selectAll()
    .where('environment_id', '=', envId)
    .orderBy('sort_order', 'asc')
    .execute()

  const content = vars
    .filter((v) => v.enabled === 1)
    .map((v) =>
      v.is_secret === 1
        ? `${v.var_key}="#REDACTED_SECRET_SET_LOCALLY"`
        : `${v.var_key}="${v.var_value.replace(/"/g, '\\"')}"`,
    )
    .join('\n')

  return c.json({ dotenv: content })
})


environmentsRoutes.get('/environments/:id/export-postman', async (c) => {
  const db = c.get('runtime').getDb()
  const envId = c.req.param('id')

  const envRow = await db
    .selectFrom('environments')
    .selectAll()
    .where('id', '=', envId)
    .executeTakeFirst()
  if (!envRow) {
    throw new AppError(404, 'ENV_NOT_FOUND', 'Environment not found.')
  }

  const vars = await db
    .selectFrom('environment_variables')
    .selectAll()
    .where('environment_id', '=', envId)
    .orderBy('sort_order', 'asc')
    .execute()

  return c.json({
    id: envRow.id,
    name: envRow.name,
    values: vars.map((v) => ({
      key: v.var_key,
      value: v.is_secret === 1 ? '' : v.var_value,
      type: v.is_secret === 1 ? 'secret' : 'default',
      enabled: v.enabled === 1,
    })),
    _postman_variable_scope: 'environment',
    _postman_exported_using: 'Meofast/1.0.0',
  })
})

const quickUpsertVariableSchema = z.object({
  environmentId: z.string().trim().min(1).nullable().optional(),
  key: z.string().trim().min(1).max(160),
  value: z.string().max(16000),
})

environmentsRoutes.patch('/workspaces/:wsId/variables', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      'environments',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot modify environment variables.')
  }

  const parsed = quickUpsertVariableSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid variable payload',
    )
  }

  const nowIso = new Date().toISOString()
  let targetEnv = parsed.data.environmentId
    ? await db
        .selectFrom('environments')
        .selectAll()
        .where('id', '=', parsed.data.environmentId)
        .where('workspace_id', '=', wsId)
        .executeTakeFirst()
    : await db
        .selectFrom('environments')
        .selectAll()
        .where('workspace_id', '=', wsId)
        .where('is_global', '=', 1)
        .limit(1)
        .executeTakeFirst()

  if (!targetEnv) {
    const newGlobalId = crypto.randomUUID()
    await db
      .insertInto('environments')
      .values({
        id: newGlobalId,
        workspace_id: wsId,
        name: 'Global Variables',
        is_global: 1,
        created_by: user.id,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()
    targetEnv = {
      id: newGlobalId,
      workspace_id: wsId,
      name: 'Global Variables',
      is_global: 1,
      created_by: user.id,
      created_at: nowIso,
      updated_at: nowIso,
    }
  }

  const existingVars = await db
    .selectFrom('environment_variables')
    .selectAll()
    .where('environment_id', '=', targetEnv.id)
    .orderBy('sort_order', 'asc')
    .execute()

  const existing = existingVars.find((v) => v.var_key === parsed.data.key)
  if (existing) {
    if (existing.is_secret === 1) {
      await db
        .updateTable('environment_variables')
        .set({
          encrypted_value: parsed.data.value ? runtime.vault.encrypt(parsed.data.value) : null,
          var_value: '',
          enabled: 1,
          updated_at: nowIso,
        })
        .where('id', '=', existing.id)
        .execute()
    } else {
      await db
        .updateTable('environment_variables')
        .set({
          var_value: parsed.data.value,
          enabled: 1,
          updated_at: nowIso,
        })
        .where('id', '=', existing.id)
        .execute()
    }
  } else {
    const nextOrder =
      existingVars.length > 0
        ? Math.max(...existingVars.map((v) => v.sort_order)) + 1
        : 0
    await db
      .insertInto('environment_variables')
      .values({
        id: crypto.randomUUID(),
        environment_id: targetEnv.id,
        var_key: parsed.data.key,
        var_value: parsed.data.value,
        encrypted_value: null,
        is_secret: 0,
        enabled: 1,
        sort_order: nextOrder,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()
  }

  await db
    .updateTable('environments')
    .set({ updated_at: nowIso })
    .where('id', '=', targetEnv.id)
    .execute()

  return c.json({
    ok: true,
    environmentId: targetEnv.id,
    environmentName: targetEnv.name,
    isGlobal: targetEnv.is_global === 1,
  })
})
