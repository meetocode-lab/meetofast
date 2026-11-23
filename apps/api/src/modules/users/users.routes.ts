import crypto from 'node:crypto'
import {
  adminSettingsSchema,
  createRbacRoleSchema,
  createUserSchema,
  networkPolicySchema,
  normalizeRolePermissionsMatrix,
  RBAC_FEATURE_CATALOG,
  roleSlugSchema,
  updateRbacRoleSchema,
  updateUserSchema,
} from '@meofast/shared'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { hashPassword } from '../../core/crypto/argon2.js'
import { generateRandomToken, sha256Hex } from '../../core/crypto/vault.js'
import { AppError } from '../../core/errors/app-error.js'
import {
  paginateServerArray,
  parseTableQuery,
  resolveSqlPageWindow,
  sqlTextLike,
} from '../../core/http/pagination.js'
import { requireAdminMiddleware, requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'
import { recordAuditLog } from '../audit/audit.service.js'
import { createAndPushNotification, emitUserSyncEvent } from '../notifications/notification-hub.js'
import {
  assertPolicy,
  ensureDefaultRbacRolesSeeded,
  mapRbacRoleRow,
  resolveRolePermissions,
} from './rbac.service.js'

export const adminRoutes = new Hono<AppEnv>()

adminRoutes.use('*', requireAuthMiddleware, requireAdminMiddleware)

function slugifyRoleName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return cleaned.length >= 2 ? cleaned : `role_${crypto.randomBytes(2).toString('hex')}`
}

adminRoutes.get('/users', async (c) => {
  assertPolicy(c.get('user'), 'users_rbac', 'anyView')
  const db = c.get('runtime').getDb()
  const tq = parseTableQuery(c, 10)

  let baseQuery = db.selectFrom('users')
  for (const tk of tq.tokens) {
    baseQuery = baseQuery.where((eb) =>
      eb.or([
        sqlTextLike('full_name', tk),
        sqlTextLike('email', tk),
        sqlTextLike('username', tk),
        sqlTextLike('global_role', tk),
        sqlTextLike('status', tk),
      ]),
    )
  }

  const countRow = await baseQuery
    .select((eb) => eb.fn.count<number>('id').as('total'))
    .executeTakeFirst()
  const total = Number(countRow?.total ?? 0)

  const sortColMap: Record<
    string,
    'full_name' | 'email' | 'global_role' | 'status' | 'last_login_at' | 'created_at'
  > = {
    user: 'full_name',
    email: 'email',
    role: 'global_role',
    status: 'status',
    lastLogin: 'last_login_at',
    createdAt: 'created_at',
  }
  const resolvedSortCol = (tq.sortBy && sortColMap[tq.sortBy]) || 'created_at'
  const resolvedSortDir = tq.sortBy ? tq.sortDir : 'asc'

  let listQuery = baseQuery
    .select([
      'id',
      'email',
      'username',
      'full_name',
      'global_role',
      'status',
      'last_login_at',
      'created_at',
    ])
    .orderBy(resolvedSortCol, resolvedSortDir)

  const { safePage, safeOffset } = resolveSqlPageWindow(total, tq.page, tq.pageSize)
  if (tq.hasPaginationParams) {
    listQuery = listQuery.limit(tq.pageSize).offset(safeOffset)
  }

  const rows = await listQuery.execute()
  const mapped = rows.map((u) => ({
    id: u.id,
    email: u.email,
    username: u.username,
    fullName: u.full_name,
    globalRole: u.global_role,
    status: u.status,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  }))

  return c.json({
    users: mapped,
    items: mapped,
    total,
    page: safePage,
    pageSize: tq.pageSize,
  })
})

adminRoutes.post('/users', async (c) => {
  const db = c.get('runtime').getDb()
  const actor = c.get('user')!
  assertPolicy(actor, 'users_rbac', 'create')

  const body = await c.req.json().catch(() => ({}))
  const parsed = createUserSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid user payload',
    )
  }

  if (parsed.data.globalRole === 'super_admin' && actor.globalRole !== 'super_admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only Super Administrators can assign Super Admin role.')
  }

  await ensureDefaultRbacRolesSeeded(db)
  const roleExists = await db
    .selectFrom('rbac_roles')
    .select('id')
    .where('slug', '=', parsed.data.globalRole)
    .executeTakeFirst()
  if (!roleExists) {
    throw new AppError(400, 'ROLE_NOT_FOUND', `Role "${parsed.data.globalRole}" does not exist.`)
  }

  const dup = await db
    .selectFrom('users')
    .select('id')
    .where((eb) =>
      eb.or([eb('email', '=', parsed.data.email), eb('username', '=', parsed.data.username)]),
    )
    .executeTakeFirst()

  if (dup) {
    throw new AppError(409, 'USER_EXISTS', 'A user with that email or username already exists.')
  }

  const nowIso = new Date().toISOString()
  const userId = crypto.randomUUID()
  const passwordHash = await hashPassword(parsed.data.password)

  await db
    .insertInto('users')
    .values({
      id: userId,
      email: parsed.data.email,
      username: parsed.data.username,
      full_name: parsed.data.fullName,
      password_hash: passwordHash,
      global_role: parsed.data.globalRole,
      status: 'active',
      last_login_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  const defaultOrg = await db
    .selectFrom('organizations')
    .select('id')
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirst()

  if (defaultOrg) {
    await db
      .insertInto('organization_members')
      .values({
        id: crypto.randomUUID(),
        organization_id: defaultOrg.id,
        user_id: userId,
        role:
          parsed.data.globalRole === 'super_admin' || parsed.data.globalRole === 'org_admin'
            ? 'org_admin'
            : 'member',
        created_at: nowIso,
      })
      .execute()
  }

  const wsIds = parsed.data.workspaceIds?.length
    ? parsed.data.workspaceIds
    : (await db.selectFrom('workspaces').select('id').limit(1).execute()).map((w) => w.id)

  for (const wsId of wsIds) {
    await db
      .insertInto('workspace_members')
      .values({
        id: crypto.randomUUID(),
        workspace_id: wsId,
        user_id: userId,
        role: parsed.data.globalRole === 'viewer' ? 'viewer' : 'developer',
        created_at: nowIso,
      })
      .execute()
  }

  await recordAuditLog(db, {
    organizationId: defaultOrg?.id ?? null,
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.created_by_admin',
    targetType: 'user',
    targetId: userId,
    metadata: { email: parsed.data.email, role: parsed.data.globalRole },
    ipAddress: c.get('clientIp'),
  })

  return c.json(
    {
      user: {
        id: userId,
        email: parsed.data.email,
        username: parsed.data.username,
        fullName: parsed.data.fullName,
        globalRole: parsed.data.globalRole,
        status: 'active',
        lastLoginAt: null,
        createdAt: nowIso,
      },
    },
    201,
  )
})

adminRoutes.patch('/users/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const actor = c.get('user')!
  assertPolicy(actor, 'users_rbac', 'update')
  const targetUserId = c.req.param('id')

  const parsed = updateUserSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid user update payload.')
  }

  if (parsed.data.globalRole) {
    if (parsed.data.globalRole === 'super_admin' && actor.globalRole !== 'super_admin') {
      throw new AppError(403, 'FORBIDDEN', 'Only Super Administrators can assign Super Admin role.')
    }
    await ensureDefaultRbacRolesSeeded(db)
    const roleExists = await db
      .selectFrom('rbac_roles')
      .select('id')
      .where('slug', '=', parsed.data.globalRole)
      .executeTakeFirst()
    if (!roleExists) {
      throw new AppError(400, 'ROLE_NOT_FOUND', `Role "${parsed.data.globalRole}" does not exist.`)
    }
  }

  const target = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', targetUserId)
    .executeTakeFirst()

  if (!target) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found.')
  }

  // Prevent demoting or deactivating the last active Super Administrator
  if (
    target.global_role === 'super_admin' &&
    ((parsed.data.globalRole && parsed.data.globalRole !== 'super_admin') ||
      parsed.data.status === 'deactivated')
  ) {
    const activeSupers = await db
      .selectFrom('users')
      .select('id')
      .where('global_role', '=', 'super_admin')
      .where('status', '=', 'active')
      .execute()
    if (activeSupers.length <= 1) {
      throw new AppError(
        400,
        'LAST_SUPER_ADMIN',
        'Cannot deactivate or demote the sole active Super Administrator.',
      )
    }
  }

  const nextRole = parsed.data.globalRole ?? target.global_role
  const nextStatus = parsed.data.status ?? target.status
  const nextName = parsed.data.fullName ?? target.full_name
  const nowIso = new Date().toISOString()

  await db
    .updateTable('users')
    .set({
      global_role: nextRole,
      status: nextStatus,
      full_name: nextName,
      updated_at: nowIso,
    })
    .where('id', '=', targetUserId)
    .execute()

  if (nextStatus === 'deactivated') {
    await db.deleteFrom('sessions').where('user_id', '=', targetUserId).execute()
  }

  if (parsed.data.globalRole && parsed.data.globalRole !== target.global_role) {
    await createAndPushNotification(db, {
      userId: targetUserId,
      type: 'role_updated',
      title: 'Role Updated',
      message: `${actor.fullName} updated your role to "${nextRole}". Your permissions have been refreshed.`,
      metadata: { role: nextRole },
    })
    emitUserSyncEvent(targetUserId, 'role_updated')
  }

  await recordAuditLog(db, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.updated',
    targetType: 'user',
    targetId: targetUserId,
    metadata: { globalRole: nextRole, status: nextStatus },
    ipAddress: c.get('clientIp'),
  })

  return c.json({ ok: true })
})

adminRoutes.post('/invitations', async (c) => {
  const db = c.get('runtime').getDb()
  const actor = c.get('user')!
  assertPolicy(actor, 'users_rbac', 'create')

  const schema = z.object({
    email: z.string().trim().email().toLowerCase(),
    role: roleSlugSchema.default('developer'),
    workspaceId: z.string().nullable().optional().default(null),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Valid email and role are required.')
  }

  if (parsed.data.role === 'super_admin' && actor.globalRole !== 'super_admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only Super Administrators can invite Super Admins.')
  }

  await ensureDefaultRbacRolesSeeded(db)
  const roleExists = await db
    .selectFrom('rbac_roles')
    .select('id')
    .where('slug', '=', parsed.data.role)
    .executeTakeFirst()
  if (!roleExists) {
    throw new AppError(400, 'ROLE_NOT_FOUND', `Role "${parsed.data.role}" does not exist.`)
  }

  const org = await db
    .selectFrom('organizations')
    .select('id')
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirstOrThrow()

  const rawInviteToken = generateRandomToken(24)
  const nowIso = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()
  const inviteId = crypto.randomUUID()

  await db
    .insertInto('user_invitations')
    .values({
      id: inviteId,
      organization_id: org.id,
      workspace_id: parsed.data.workspaceId,
      email: parsed.data.email,
      role: parsed.data.role,
      token_hash: sha256Hex(rawInviteToken),
      invited_by: actor.id,
      accepted_at: null,
      expires_at: expiresAt,
      created_at: nowIso,
    })
    .execute()

  await recordAuditLog(db, {
    organizationId: org.id,
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'invitation.created',
    targetType: 'user_invitation',
    targetId: inviteId,
    metadata: { email: parsed.data.email, role: parsed.data.role },
    ipAddress: c.get('clientIp'),
  })

  return c.json(
    {
      invitation: {
        id: inviteId,
        email: parsed.data.email,
        role: parsed.data.role,
        invitationToken: rawInviteToken,
        expiresAt,
      },
    },
    201,
  )
})

// ============================================================================
// Laravel Policy-Style Custom RBAC Roles & Feature Permission Matrix
// ============================================================================

adminRoutes.get('/roles', async (c) => {
  assertPolicy(c.get('user'), 'users_rbac', 'anyView')
  const db = c.get('runtime').getDb()
  const tq = parseTableQuery(c, 50)

  await ensureDefaultRbacRolesSeeded(db)

  const [roleRows, userRows] = await Promise.all([
    db
      .selectFrom('rbac_roles')
      .selectAll()
      .orderBy('is_system', 'desc')
      .orderBy('created_at', 'asc')
      .execute(),
    db.selectFrom('users').select('global_role').execute(),
  ])

  const userCountMap = new Map<string, number>()
  for (const u of userRows) {
    userCountMap.set(u.global_role, (userCountMap.get(u.global_role) ?? 0) + 1)
  }

  const mappedRoles = roleRows.map((r) => mapRbacRoleRow(r, userCountMap))
  const paged = paginateServerArray(mappedRoles, tq, {
    getSearchText: (r) =>
      `${r.name} ${r.slug} ${r.description} ${r.isSystem ? 'system' : 'custom'}`,
    sortExtractors: {
      name: (r) => r.name,
      slug: (r) => r.slug,
      type: (r) => (r.isSystem ? 'system' : 'custom'),
      users: (r) => r.userCount,
      granted: (r) => r.grantedCount,
      updatedAt: (r) => r.updatedAt,
    },
  })

  return c.json({
    roles: mappedRoles,
    ...paged,
  })
})

adminRoutes.get('/roles/:id/policies', async (c) => {
  assertPolicy(c.get('user'), 'users_rbac', 'view')
  const db = c.get('runtime').getDb()
  const roleId = c.req.param('id')
  const tq = parseTableQuery(c, 25)

  await ensureDefaultRbacRolesSeeded(db)
  const roleRow = await db
    .selectFrom('rbac_roles')
    .selectAll()
    .where('id', '=', roleId)
    .executeTakeFirst()
  if (!roleRow) {
    throw new AppError(404, 'ROLE_NOT_FOUND', 'Role not found.')
  }

  let parsedRaw: unknown = null
  try {
    parsedRaw = JSON.parse(roleRow.permissions_json || '{}')
  } catch {
    parsedRaw = null
  }
  const matrix = normalizeRolePermissionsMatrix(parsedRaw, roleRow.slug)

  const featureRows = RBAC_FEATURE_CATALOG.map((meta) => {
    const p = matrix[meta.key]
    return {
      featureKey: meta.key,
      label: meta.label,
      category: meta.category,
      description: meta.description,
      anyView: p.anyView,
      view: p.view,
      create: p.create,
      update: p.update,
      delete: p.delete,
    }
  })

  return c.json(
    paginateServerArray(featureRows, tq, {
      getSearchText: (f) => `${f.label} ${f.featureKey} ${f.category} ${f.description}`,
      sortExtractors: {
        feature: (f) => f.label,
        category: (f) => f.category,
        anyView: (f) => (f.anyView ? 1 : 0),
        view: (f) => (f.view ? 1 : 0),
        create: (f) => (f.create ? 1 : 0),
        update: (f) => (f.update ? 1 : 0),
        delete: (f) => (f.delete ? 1 : 0),
      },
    }),
  )
})

adminRoutes.post('/roles', async (c) => {
  const db = c.get('runtime').getDb()
  const actor = c.get('user')!
  assertPolicy(actor, 'users_rbac', 'create')

  await ensureDefaultRbacRolesSeeded(db)

  const parsed = createRbacRoleSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Valid role name is required.',
    )
  }

  const slug = parsed.data.slug || slugifyRoleName(parsed.data.name)
  const slugValid = roleSlugSchema.safeParse(slug)
  if (!slugValid.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      slugValid.error.issues[0]?.message ?? 'Invalid role slug.',
    )
  }

  const existing = await db
    .selectFrom('rbac_roles')
    .select('id')
    .where('slug', '=', slugValid.data)
    .executeTakeFirst()
  if (existing) {
    throw new AppError(409, 'ROLE_EXISTS', `A role with slug "${slugValid.data}" already exists.`)
  }

  const permissions = parsed.data.permissions
    ? normalizeRolePermissionsMatrix(parsed.data.permissions, 'developer')
    : parsed.data.templateRoleSlug === '__blank__'
      ? normalizeRolePermissionsMatrix(
          Object.fromEntries(
            RBAC_FEATURE_CATALOG.map((f) => [
              f.key,
              { anyView: false, view: false, create: false, update: false, delete: false },
            ]),
          ),
          'developer',
        )
      : await resolveRolePermissions(db, parsed.data.templateRoleSlug || 'developer')

  const nowIso = new Date().toISOString()
  const id = crypto.randomUUID()

  await db
    .insertInto('rbac_roles')
    .values({
      id,
      slug: slugValid.data,
      name: parsed.data.name,
      description: parsed.data.description || null,
      is_system: 0,
      permissions_json: JSON.stringify(permissions),
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  await recordAuditLog(db, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'role.created',
    targetType: 'rbac_role',
    targetId: id,
    metadata: { slug: slugValid.data, name: parsed.data.name },
    ipAddress: c.get('clientIp'),
  })

  const createdRow = await db
    .selectFrom('rbac_roles')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()

  return c.json({ role: mapRbacRoleRow(createdRow, new Map()) }, 201)
})

const handleUpdateRole = async (c: Context<AppEnv>) => {
  const db = c.get('runtime').getDb()
  const actor = c.get('user')!
  assertPolicy(actor, 'users_rbac', 'update')
  const id = c.req.param('id') ?? ''

  const target = await db
    .selectFrom('rbac_roles')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (!target) {
    throw new AppError(404, 'ROLE_NOT_FOUND', 'Role not found.')
  }

  if (target.slug === 'super_admin') {
    throw new AppError(
      400,
      'SUPER_ADMIN_IMMUTABLE',
      'Super Administrator root permissions cannot be restricted.',
    )
  }

  const parsed = updateRbacRoleSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid role update payload.',
    )
  }

  const nextName = parsed.data.name ?? target.name
  const nextDesc =
    parsed.data.description !== undefined ? parsed.data.description || null : target.description
  const nextPermissionsJson = parsed.data.permissions
    ? JSON.stringify(normalizeRolePermissionsMatrix(parsed.data.permissions, target.slug))
    : target.permissions_json
  const nowIso = new Date().toISOString()

  await db
    .updateTable('rbac_roles')
    .set({
      name: nextName,
      description: nextDesc,
      permissions_json: nextPermissionsJson,
      updated_at: nowIso,
    })
    .where('id', '=', id)
    .execute()

  await recordAuditLog(db, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'role.updated',
    targetType: 'rbac_role',
    targetId: id,
    metadata: { slug: target.slug, name: nextName },
    ipAddress: c.get('clientIp'),
  })

  const updatedRow = await db
    .selectFrom('rbac_roles')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()

  return c.json({ ok: true, role: mapRbacRoleRow(updatedRow, new Map()) })
}

adminRoutes.put('/roles/:id', handleUpdateRole)
adminRoutes.patch('/roles/:id', handleUpdateRole)

adminRoutes.delete('/roles/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const actor = c.get('user')!
  assertPolicy(actor, 'users_rbac', 'delete')
  const id = c.req.param('id')

  const target = await db
    .selectFrom('rbac_roles')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (!target) {
    throw new AppError(404, 'ROLE_NOT_FOUND', 'Role not found.')
  }

  if (target.is_system === 1) {
    throw new AppError(
      400,
      'CANNOT_DELETE_SYSTEM_ROLE',
      `Built-in system role "${target.slug}" cannot be deleted.`,
    )
  }

  const assignedUsers = await db
    .selectFrom('users')
    .select((eb) => eb.fn.count<number>('id').as('total'))
    .where('global_role', '=', target.slug)
    .executeTakeFirst()
  const assignedCount = Number(assignedUsers?.total ?? 0)
  if (assignedCount > 0) {
    throw new AppError(
      400,
      'ROLE_IN_USE',
      `Reassign the ${assignedCount} user(s) assigned to "${target.name}" before deleting this role.`,
    )
  }

  await db.deleteFrom('rbac_roles').where('id', '=', id).execute()

  await recordAuditLog(db, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'role.deleted',
    targetType: 'rbac_role',
    targetId: id,
    metadata: { slug: target.slug, name: target.name },
    ipAddress: c.get('clientIp'),
  })

  return c.json({ ok: true })
})

adminRoutes.get('/settings', async (c) => {
  assertPolicy(c.get('user'), 'system_settings', 'view')
  const db = c.get('runtime').getDb()
  const rows = await db.selectFrom('system_settings').selectAll().execute()
  const map = new Map(rows.map((r) => [r.setting_key, r.setting_value]))

  let networkPolicy = {
    allowPrivateNetworks: false,
    allowLocalhost: false,
    allowedCidrs: [] as string[],
    allowedDomains: [] as string[],
  }
  try {
    const raw = map.get('network_policy')
    if (raw) {
      networkPolicy = networkPolicySchema.parse(JSON.parse(raw))
    }
  } catch {
    // use safe defaults
  }

  return c.json({
    appName: map.get('app_name') ?? 'Meofast',
    publicUrl: map.get('public_url') ?? 'http://localhost:4780',
    registrationMode: map.get('registration_mode') === 'open' ? 'open' : 'invite_only',
    configuredEngine: c.get('runtime').getConfiguredEngine(),
    networkPolicy,
  })
})

adminRoutes.put('/settings', async (c) => {
  const db = c.get('runtime').getDb()
  const actor = c.get('user')!
  assertPolicy(actor, 'system_settings', 'update')

  const parsed = adminSettingsSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid settings payload',
    )
  }

  const nowIso = new Date().toISOString()
  const updates: Array<{ key: string; value: string }> = [
    { key: 'app_name', value: parsed.data.appName },
    { key: 'public_url', value: parsed.data.publicUrl },
    { key: 'registration_mode', value: parsed.data.registrationMode },
    { key: 'network_policy', value: JSON.stringify(parsed.data.networkPolicy) },
  ]

  for (const u of updates) {
    const existing = await db
      .selectFrom('system_settings')
      .select('setting_key')
      .where('setting_key', '=', u.key)
      .executeTakeFirst()

    if (existing) {
      await db
        .updateTable('system_settings')
        .set({ setting_value: u.value, updated_at: nowIso })
        .where('setting_key', '=', u.key)
        .execute()
    } else {
      await db
        .insertInto('system_settings')
        .values({ setting_key: u.key, setting_value: u.value, updated_at: nowIso })
        .execute()
    }
  }

  await recordAuditLog(db, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'system.settings_updated',
    targetType: 'system_settings',
    metadata: {
      appName: parsed.data.appName,
      registrationMode: parsed.data.registrationMode,
      allowPrivateNetworks: parsed.data.networkPolicy.allowPrivateNetworks,
      allowLocalhost: parsed.data.networkPolicy.allowLocalhost,
    },
    ipAddress: c.get('clientIp'),
  })

  return c.json({ ok: true })
})

adminRoutes.get('/audit-logs', async (c) => {
  assertPolicy(c.get('user'), 'audit_logs', 'anyView')
  const db = c.get('runtime').getDb()
  const limit = Math.min(200, Math.max(10, Number(c.req.query('limit') ?? 50)))

  const [auditRows, loginRows, auditCountRow, loginCountRow] = await Promise.all([
    db
      .selectFrom('audit_logs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute(),
    db
      .selectFrom('login_history')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute(),
    db
      .selectFrom('audit_logs')
      .select((eb) => eb.fn.count<number>('id').as('total'))
      .executeTakeFirst(),
    db
      .selectFrom('login_history')
      .select((eb) => eb.fn.count<number>('id').as('total'))
      .executeTakeFirst(),
  ])

  return c.json({
    auditTotal: Number(auditCountRow?.total ?? 0),
    loginTotal: Number(loginCountRow?.total ?? 0),
    auditLogs: auditRows.map((a) => ({
      id: a.id,
      actorEmail: a.actor_email,
      action: a.action,
      targetType: a.target_type,
      targetId: a.target_id,
      metadata: JSON.parse(a.metadata_json || '{}') as Record<string, unknown>,
      ipAddress: a.ip_address,
      createdAt: a.created_at,
    })),
    loginHistory: loginRows.map((l) => ({
      id: l.id,
      emailAttempted: l.email_attempted,
      succeeded: l.succeeded === 1,
      failureReason: l.failure_reason,
      ipAddress: l.ip_address,
      createdAt: l.created_at,
    })),
  })
})

adminRoutes.get('/audit-events', async (c) => {
  assertPolicy(c.get('user'), 'audit_logs', 'anyView')
  const db = c.get('runtime').getDb()
  const tq = parseTableQuery(c, 10)

  let baseQuery = db.selectFrom('audit_logs')
  for (const tk of tq.tokens) {
    baseQuery = baseQuery.where((eb) =>
      eb.or([
        sqlTextLike('action', tk),
        sqlTextLike('target_type', tk),
        sqlTextLike('target_id', tk),
        sqlTextLike('actor_email', tk),
        sqlTextLike('ip_address', tk),
      ]),
    )
  }

  const countRow = await baseQuery
    .select((eb) => eb.fn.count<number>('id').as('total'))
    .executeTakeFirst()
  const total = Number(countRow?.total ?? 0)

  const sortMap: Record<
    string,
    'action' | 'target_type' | 'actor_email' | 'ip_address' | 'created_at'
  > = {
    action: 'action',
    target: 'target_type',
    actor: 'actor_email',
    ip: 'ip_address',
    createdAt: 'created_at',
  }
  const sortCol = (tq.sortBy && sortMap[tq.sortBy]) || 'created_at'
  const sortDir = tq.sortBy ? tq.sortDir : 'desc'

  const { safePage, safeOffset } = resolveSqlPageWindow(total, tq.page, tq.pageSize)
  const rows = await baseQuery
    .selectAll()
    .orderBy(sortCol, sortDir)
    .limit(tq.pageSize)
    .offset(safeOffset)
    .execute()

  return c.json({
    items: rows.map((a) => ({
      id: a.id,
      actorEmail: a.actor_email,
      action: a.action,
      targetType: a.target_type,
      targetId: a.target_id,
      metadata: JSON.parse(a.metadata_json || '{}') as Record<string, unknown>,
      ipAddress: a.ip_address,
      createdAt: a.created_at,
    })),
    total,
    page: safePage,
    pageSize: tq.pageSize,
  })
})

adminRoutes.get('/login-events', async (c) => {
  assertPolicy(c.get('user'), 'audit_logs', 'anyView')
  const db = c.get('runtime').getDb()
  const tq = parseTableQuery(c, 10)

  let baseQuery = db.selectFrom('login_history')
  for (const tk of tq.tokens) {
    if (tk === 'success' || tk === 'succeeded') {
      baseQuery = baseQuery.where('succeeded', '=', 1)
    } else if (tk === 'failed' || tk === 'fail') {
      baseQuery = baseQuery.where('succeeded', '=', 0)
    } else {
      baseQuery = baseQuery.where((eb) =>
        eb.or([
          sqlTextLike('email_attempted', tk),
          sqlTextLike('failure_reason', tk),
          sqlTextLike('ip_address', tk),
        ]),
      )
    }
  }

  const countRow = await baseQuery
    .select((eb) => eb.fn.count<number>('id').as('total'))
    .executeTakeFirst()
  const total = Number(countRow?.total ?? 0)

  const sortMap: Record<
    string,
    'email_attempted' | 'succeeded' | 'failure_reason' | 'ip_address' | 'created_at'
  > = {
    email: 'email_attempted',
    status: 'succeeded',
    details: 'failure_reason',
    ip: 'ip_address',
    createdAt: 'created_at',
  }
  const sortCol = (tq.sortBy && sortMap[tq.sortBy]) || 'created_at'
  const sortDir = tq.sortBy ? tq.sortDir : 'desc'

  const { safePage, safeOffset } = resolveSqlPageWindow(total, tq.page, tq.pageSize)
  const rows = await baseQuery
    .selectAll()
    .orderBy(sortCol, sortDir)
    .limit(tq.pageSize)
    .offset(safeOffset)
    .execute()

  return c.json({
    items: rows.map((l) => ({
      id: l.id,
      emailAttempted: l.email_attempted,
      succeeded: l.succeeded === 1,
      failureReason: l.failure_reason,
      ipAddress: l.ip_address,
      createdAt: l.created_at,
    })),
    total,
    page: safePage,
    pageSize: tq.pageSize,
  })
})
