import crypto from 'node:crypto'
import {
  canManageSystem,
  createApiTokenSchema,
  type GlobalRole,
  type GraphqlPayloadConfig,
  type KeyValueItem,
  loginSchema,
  registerSchema,
  type RequestAssertion,
  type RequestAuthConfig,
  type RequestBodyConfig,
  type RequestProtocol,
  type ResponseVariableExtractor,
  strongPasswordSchema,
} from '@meofast/shared'
import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { hashPassword, verifyPassword } from '../../core/crypto/argon2.js'
import { generateRandomToken, sha256Hex } from '../../core/crypto/vault.js'
import { AppError } from '../../core/errors/app-error.js'
import {
  paginateServerArray,
  parseTableQuery,
  resolveSqlPageWindow,
  sqlTextLike,
} from '../../core/http/pagination.js'
import {
  createRateLimiter,
  requireAuthMiddleware,
  SESSION_COOKIE_NAME,
} from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'
import { recordAuditLog } from '../audit/audit.service.js'

export const authRoutes = new Hono<AppEnv>()

const loginRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  keyPrefix: 'auth_login',
})

authRoutes.post('/login', loginRateLimiter, async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const body = await c.req.json().catch(() => ({}))
  const parsed = loginSchema.safeParse(body)

  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid login credentials',
    )
  }

  const identifier = parsed.data.identifier.toLowerCase()
  const nowIso = new Date().toISOString()
  const ipAddress = c.get('clientIp')
  const userAgent = c.req.header('user-agent') ?? null

  const user = await db
    .selectFrom('users')
    .selectAll()
    .where((eb) => eb.or([eb('email', '=', identifier), eb('username', '=', identifier)]))
    .executeTakeFirst()

  if (!user) {
    await db
      .insertInto('login_history')
      .values({
        id: crypto.randomUUID(),
        user_id: null,
        email_attempted: identifier,
        succeeded: 0,
        ip_address: ipAddress,
        user_agent: userAgent,
        failure_reason: 'user_not_found',
        created_at: nowIso,
      })
      .execute()
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email/username or password.')
  }

  if (user.status !== 'active') {
    await db
      .insertInto('login_history')
      .values({
        id: crypto.randomUUID(),
        user_id: user.id,
        email_attempted: identifier,
        succeeded: 0,
        ip_address: ipAddress,
        user_agent: userAgent,
        failure_reason: 'account_deactivated',
        created_at: nowIso,
      })
      .execute()
    throw new AppError(
      403,
      'ACCOUNT_DEACTIVATED',
      'Your account has been deactivated. Contact your administrator.',
    )
  }

  const passwordValid = await verifyPassword(parsed.data.password, user.password_hash)
  if (!passwordValid) {
    await db
      .insertInto('login_history')
      .values({
        id: crypto.randomUUID(),
        user_id: user.id,
        email_attempted: identifier,
        succeeded: 0,
        ip_address: ipAddress,
        user_agent: userAgent,
        failure_reason: 'invalid_password',
        created_at: nowIso,
      })
      .execute()
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email/username or password.')
  }

  const rawSessionToken = generateRandomToken(32)
  const csrfToken = generateRandomToken(24)
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()

  await db
    .insertInto('sessions')
    .values({
      id: crypto.randomUUID(),
      user_id: user.id,
      token_hash: sha256Hex(rawSessionToken),
      csrf_token: csrfToken,
      ip_address: ipAddress,
      user_agent: userAgent,
      expires_at: expiresAt,
      created_at: nowIso,
    })
    .execute()

  await db
    .updateTable('users')
    .set({ last_login_at: nowIso, updated_at: nowIso })
    .where('id', '=', user.id)
    .execute()

  await db
    .insertInto('login_history')
    .values({
      id: crypto.randomUUID(),
      user_id: user.id,
      email_attempted: user.email,
      succeeded: 1,
      ip_address: ipAddress,
      user_agent: userAgent,
      failure_reason: null,
      created_at: nowIso,
    })
    .execute()

  const isHttps = c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://')

  setCookie(c, SESSION_COOKIE_NAME, rawSessionToken, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps,
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      fullName: user.full_name,
      globalRole: user.global_role,
    },
    csrfToken,
  })
})

authRoutes.post('/register', loginRateLimiter, async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const body = await c.req.json().catch(() => ({}))
  const parsed = registerSchema.safeParse(body)

  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid registration data',
    )
  }

  const regModeSetting = await db
    .selectFrom('system_settings')
    .select('setting_value')
    .where('setting_key', '=', 'registration_mode')
    .executeTakeFirst()

  const nowIso = new Date().toISOString()
  let assignedRole: GlobalRole = 'developer'
  let invitedWorkspaceId: string | null = null

  if (parsed.data.invitationToken) {
    const tokenHash = sha256Hex(parsed.data.invitationToken)
    const invite = await db
      .selectFrom('user_invitations')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .where('accepted_at', 'is', null)
      .executeTakeFirst()

    if (!invite || invite.expires_at <= nowIso) {
      throw new AppError(400, 'INVALID_INVITATION', 'Invitation token is invalid or expired.')
    }
    assignedRole = invite.role
    invitedWorkspaceId = invite.workspace_id
    await db
      .updateTable('user_invitations')
      .set({ accepted_at: nowIso })
      .where('id', '=', invite.id)
      .execute()
  } else if (regModeSetting?.setting_value !== 'open') {
    throw new AppError(
      403,
      'REGISTRATION_CLOSED',
      'Self-registration is restricted by the administrator. Request an invitation link.',
    )
  }

  const duplicate = await db
    .selectFrom('users')
    .select('id')
    .where((eb) =>
      eb.or([eb('email', '=', parsed.data.email), eb('username', '=', parsed.data.username)]),
    )
    .executeTakeFirst()

  if (duplicate) {
    throw new AppError(409, 'USER_EXISTS', 'Email or username is already registered.')
  }

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
      global_role: assignedRole,
      status: 'active',
      last_login_at: nowIso,
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
        role: 'member',
        created_at: nowIso,
      })
      .execute()
  }

  const targetWs = invitedWorkspaceId
    ? await db
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', invitedWorkspaceId)
        .executeTakeFirst()
    : await db
        .selectFrom('workspaces')
        .select('id')
        .where('visibility', '=', 'team')
        .orderBy('created_at', 'asc')
        .limit(1)
        .executeTakeFirst()

  if (targetWs) {
    await db
      .insertInto('workspace_members')
      .values({
        id: crypto.randomUUID(),
        workspace_id: targetWs.id,
        user_id: userId,
        role: assignedRole === 'viewer' ? 'viewer' : 'developer',
        created_at: nowIso,
      })
      .execute()
  }

  const rawSessionToken = generateRandomToken(32)
  const csrfToken = generateRandomToken(24)
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()

  await db
    .insertInto('sessions')
    .values({
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: sha256Hex(rawSessionToken),
      csrf_token: csrfToken,
      ip_address: c.get('clientIp'),
      user_agent: c.req.header('user-agent') ?? null,
      expires_at: expiresAt,
      created_at: nowIso,
    })
    .execute()

  await recordAuditLog(db, {
    organizationId: defaultOrg?.id ?? null,
    actorUserId: userId,
    actorEmail: parsed.data.email,
    action: 'user.registered',
    targetType: 'user',
    targetId: userId,
    ipAddress: c.get('clientIp'),
  })

  const isHttps = c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://')
  setCookie(c, SESSION_COOKIE_NAME, rawSessionToken, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps,
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })

  return c.json(
    {
      user: {
        id: userId,
        email: parsed.data.email,
        username: parsed.data.username,
        fullName: parsed.data.fullName,
        globalRole: assignedRole,
      },
      csrfToken,
    },
    201,
  )
})

authRoutes.get('/me', requireAuthMiddleware, async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const user = c.get('user')!
  const session = c.get('session')

  const settingsRows = await db
    .selectFrom('system_settings')
    .select(['setting_key', 'setting_value'])
    .where('setting_key', 'in', ['app_name', 'public_url', 'registration_mode'])
    .execute()

  const settingsMap = new Map(settingsRows.map((s) => [s.setting_key, s.setting_value]))

  const canSeeAllWorkspaces =
    user.permissions.workspaces.anyView || canManageSystem(user.globalRole, user.permissions)

  const workspaces = canSeeAllWorkspaces
    ? await db.selectFrom('workspaces').selectAll().orderBy('created_at', 'asc').execute()
    : await db
        .selectFrom('workspaces')
        .leftJoin('workspace_members', (join) =>
          join
            .onRef('workspace_members.workspace_id', '=', 'workspaces.id')
            .on('workspace_members.user_id', '=', user.id),
        )
        .selectAll('workspaces')
        .where((eb) =>
          eb.or([eb('workspaces.visibility', '=', 'team'), eb('workspace_members.id', 'is not', null)]),
        )
        .orderBy('workspaces.created_at', 'asc')
        .execute()

  return c.json({
    user,
    csrfToken: session?.csrfToken ?? '',
    appName: settingsMap.get('app_name') ?? 'Meofast',
    publicUrl: settingsMap.get('public_url') ?? '',
    registrationMode: settingsMap.get('registration_mode') ?? 'invite_only',
    workspaces: workspaces.map((w) => ({
      id: w.id,
      organizationId: w.organization_id,
      name: w.name,
      slug: w.slug,
      description: w.description ?? '',
      visibility: w.visibility,
    })),
  })
})

authRoutes.post('/logout', requireAuthMiddleware, async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const session = c.get('session')!

  await db.deleteFrom('sessions').where('id', '=', session.id).execute()
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' })
  return c.json({ ok: true })
})

authRoutes.patch('/profile', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!

  const schema = z.object({
    fullName: z.string().trim().min(2, 'Full name must be at least 2 characters').max(160),
    username: z
      .string()
      .trim()
      .min(3, 'Username must be at least 3 characters')
      .max(40)
      .toLowerCase()
      .regex(/^[a-z0-9._-]+$/, 'Use lowercase letters, numbers, dots, underscores, or hyphens'),
  })

  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid profile data',
    )
  }

  const duplicate = await db
    .selectFrom('users')
    .select('id')
    .where('username', '=', parsed.data.username)
    .where('id', '!=', user.id)
    .executeTakeFirst()

  if (duplicate) {
    throw new AppError(409, 'USERNAME_TAKEN', 'Username is already in use.')
  }

  const nowIso = new Date().toISOString()
  await db
    .updateTable('users')
    .set({
      full_name: parsed.data.fullName,
      username: parsed.data.username,
      updated_at: nowIso,
    })
    .where('id', '=', user.id)
    .execute()

  await recordAuditLog(db, {
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'user.profile_updated',
    targetType: 'user',
    targetId: user.id,
    ipAddress: c.get('clientIp'),
  })

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      username: parsed.data.username,
      fullName: parsed.data.fullName,
      globalRole: user.globalRole,
      permissions: user.permissions,
    },
  })
})

authRoutes.post('/password', requireAuthMiddleware, async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const user = c.get('user')!
  const session = c.get('session')!

  const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword: strongPasswordSchema,
  })
  const body = await c.req.json().catch(() => ({}))
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid password input',
    )
  }

  const dbUser = await db
    .selectFrom('users')
    .select('password_hash')
    .where('id', '=', user.id)
    .executeTakeFirstOrThrow()

  const valid = await verifyPassword(parsed.data.currentPassword, dbUser.password_hash)
  if (!valid) {
    throw new AppError(401, 'INVALID_PASSWORD', 'Current password is incorrect.')
  }

  const nextHash = await hashPassword(parsed.data.newPassword)
  await db
    .updateTable('users')
    .set({ password_hash: nextHash, updated_at: new Date().toISOString() })
    .where('id', '=', user.id)
    .execute()

  // Revoke other active sessions for this user
  await db
    .deleteFrom('sessions')
    .where('user_id', '=', user.id)
    .where('id', '!=', session.id)
    .execute()

  await recordAuditLog(db, {
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'user.password_changed',
    targetType: 'user',
    targetId: user.id,
    ipAddress: c.get('clientIp'),
  })

  return c.json({ ok: true })
})

authRoutes.get('/sessions', requireAuthMiddleware, async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const user = c.get('user')!
  const currentSession = c.get('session')!
  const tq = parseTableQuery(c, 10)

  let baseQuery = db.selectFrom('sessions').where('user_id', '=', user.id)
  for (const tk of tq.tokens) {
    if ('current session'.includes(tk) || 'active'.includes(tk)) {
      // allow status search tokens alongside user_agent/ip_address
      baseQuery = baseQuery.where((eb) =>
        eb.or([
          sqlTextLike('ip_address', tk),
          sqlTextLike('user_agent', tk),
          ...(tk === 'current' ? [eb('id', '=', currentSession.id)] : [eb('user_id', '=', user.id)]),
        ]),
      )
    } else {
      baseQuery = baseQuery.where((eb) =>
        eb.or([sqlTextLike('ip_address', tk), sqlTextLike('user_agent', tk)]),
      )
    }
  }

  const countRow = await baseQuery
    .select((eb) => eb.fn.count<number>('id').as('total'))
    .executeTakeFirst()
  const total = Number(countRow?.total ?? 0)

  const sortMap: Record<string, 'user_agent' | 'ip_address' | 'created_at' | 'expires_at'> = {
    device: 'user_agent',
    ip: 'ip_address',
    createdAt: 'created_at',
    expiresAt: 'expires_at',
  }
  const sortCol = (tq.sortBy && sortMap[tq.sortBy]) || 'created_at'
  const sortDir = tq.sortBy ? tq.sortDir : 'desc'

  const { safePage, safeOffset } = resolveSqlPageWindow(total, tq.page, tq.pageSize)
  let listQuery = baseQuery
    .select(['id', 'ip_address', 'user_agent', 'expires_at', 'created_at'])
    .orderBy(sortCol, sortDir)

  if (tq.hasPaginationParams) {
    listQuery = listQuery.limit(tq.pageSize).offset(safeOffset)
  }

  const rows = await listQuery.execute()
  const mapped = rows.map((s) => ({
    id: s.id,
    ipAddress: s.ip_address,
    userAgent: s.user_agent,
    expiresAt: s.expires_at,
    createdAt: s.created_at,
    isCurrent: s.id === currentSession.id,
  }))

  return c.json({
    sessions: mapped,
    items: mapped,
    total,
    page: safePage,
    pageSize: tq.pageSize,
  })
})

authRoutes.delete('/sessions/:id', requireAuthMiddleware, async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const user = c.get('user')!
  const targetId = c.req.param('id')

  await db
    .deleteFrom('sessions')
    .where('id', '=', targetId)
    .where('user_id', '=', user.id)
    .execute()

  return c.json({ ok: true })
})

authRoutes.delete('/sessions', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const currentSession = c.get('session')!

  await db
    .deleteFrom('sessions')
    .where('user_id', '=', user.id)
    .where('id', '!=', currentSession.id)
    .execute()

  return c.json({ ok: true })
})

authRoutes.get('/profile-overview', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!

  const safeParse = <T>(raw: string | null | undefined, fallback: T): T => {
    if (!raw) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  const canSeeAllWorkspaces =
    user.permissions.workspaces.anyView || canManageSystem(user.globalRole, user.permissions)

  const [
    userRow,
    accessibleWorkspaces,
    workspaceMemberships,
    allCollections,
    allFolders,
    allSavedRequests,
    recentHistory,
    personalLogins,
    activeSessionsCountRows,
    personalTokensRows,
  ] = await Promise.all([
    db
      .selectFrom('users')
      .select(['id', 'email', 'username', 'full_name', 'global_role', 'status', 'last_login_at', 'created_at'])
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow(),
    canSeeAllWorkspaces
      ? db.selectFrom('workspaces').selectAll().orderBy('created_at', 'asc').execute()
      : db
          .selectFrom('workspaces')
          .leftJoin('workspace_members', (join) =>
            join
              .onRef('workspace_members.workspace_id', '=', 'workspaces.id')
              .on('workspace_members.user_id', '=', user.id),
          )
          .selectAll('workspaces')
          .where((eb) =>
            eb.or([
              eb('workspaces.visibility', '=', 'team'),
              eb('workspace_members.id', 'is not', null),
            ]),
          )
          .orderBy('workspaces.created_at', 'asc')
          .execute(),
    db
      .selectFrom('workspace_members')
      .select(['workspace_id', 'role', 'created_at'])
      .where('user_id', '=', user.id)
      .execute(),
    db
      .selectFrom('collections')
      .selectAll()
      .orderBy('updated_at', 'desc')
      .execute(),
    db.selectFrom('collection_folders').select(['id', 'collection_id']).execute(),
    db
      .selectFrom('saved_requests')
      .selectAll()
      .orderBy('updated_at', 'desc')
      .execute(),
    db
      .selectFrom('request_history')
      .select([
        'id',
        'workspace_id',
        'method',
        'url',
        'response_status',
        'duration_ms',
        'created_at',
      ])
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .limit(30)
      .execute(),
    db
      .selectFrom('login_history')
      .select(['id', 'email_attempted', 'succeeded', 'ip_address', 'user_agent', 'failure_reason', 'created_at'])
      .where((eb) =>
        eb.or([eb('user_id', '=', user.id), eb('email_attempted', '=', user.email)]),
      )
      .orderBy('created_at', 'desc')
      .limit(25)
      .execute(),
    db.selectFrom('sessions').select('id').where('user_id', '=', user.id).execute(),
    db.selectFrom('api_tokens').select('id').where('user_id', '=', user.id).execute(),
  ])

  const wsMap = new Map(accessibleWorkspaces.map((w) => [w.id, w]))
  const memberRoleMap = new Map(workspaceMemberships.map((m) => [m.workspace_id, m.role]))
  const folderCountByCol = new Map<string, number>()
  for (const f of allFolders) {
    folderCountByCol.set(f.collection_id, (folderCountByCol.get(f.collection_id) ?? 0) + 1)
  }
  const reqCountByCol = new Map<string, number>()
  for (const r of allSavedRequests) {
    reqCountByCol.set(r.collection_id, (reqCountByCol.get(r.collection_id) ?? 0) + 1)
  }
  const colNameMap = new Map(allCollections.map((col) => [col.id, col.name]))

  const visibleCollections = allCollections.filter((col) => wsMap.has(col.workspace_id))
  const visibleRequests = allSavedRequests.filter((r) => wsMap.has(r.workspace_id))

  const mapCollectionItem = (col: (typeof allCollections)[number]) => ({
    id: col.id,
    workspaceId: col.workspace_id,
    workspaceName: wsMap.get(col.workspace_id)?.name ?? 'Workspace',
    name: col.name,
    description: col.description ?? '',
    isMine:
      col.created_by === user.id ||
      (user.globalRole === 'super_admin' && col.created_by === null),
    folderCount: folderCountByCol.get(col.id) ?? 0,
    requestCount: reqCountByCol.get(col.id) ?? 0,
    updatedAt: col.updated_at,
  })

  const mapRequestItem = (r: (typeof allSavedRequests)[number]) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    workspaceName: wsMap.get(r.workspace_id)?.name ?? 'Workspace',
    collectionId: r.collection_id,
    collectionName: colNameMap.get(r.collection_id) ?? 'Collection',
    folderId: r.folder_id,
    name: r.name,
    description: r.description ?? '',
    protocol: ((r.protocol as RequestProtocol | null) ?? 'http') as RequestProtocol,
    method: r.method,
    url: r.url,
    isMine:
      r.created_by === user.id ||
      (user.globalRole === 'super_admin' && r.created_by === null),
    queryParams: safeParse<KeyValueItem[]>(r.query_params_json, []),
    headers: safeParse<KeyValueItem[]>(r.headers_json, []),
    pathVariables: safeParse<KeyValueItem[]>(r.path_vars_json, []),
    auth: safeParse<RequestAuthConfig>(r.auth_json, { type: 'none' }),
    body: safeParse<RequestBodyConfig>(r.body_json, {
      mode: 'none',
      raw: '',
      urlencoded: [],
      multipart: [],
    }),
    graphql: safeParse<GraphqlPayloadConfig>(r.graphql_json, {
      query: '',
      variables: '{}',
      operationName: '',
    }),
    assertions: safeParse<RequestAssertion[]>(r.assertions_json, []),
    postResponseVars: safeParse<ResponseVariableExtractor[]>(r.post_vars_json, []),
    preRequestScript: r.pre_request_script ?? '',
    testScript: r.test_script ?? '',
    jsonSchema: r.json_schema ?? '',
    updatedAt: r.updated_at,
  })

  const mappedCollections = visibleCollections.map(mapCollectionItem)
  const mappedRequests = visibleRequests.slice(0, 80).map(mapRequestItem)

  return c.json({
    account: {
      id: userRow.id,
      email: userRow.email,
      username: userRow.username,
      fullName: userRow.full_name,
      globalRole: userRow.global_role,
      status: userRow.status,
      lastLoginAt: userRow.last_login_at,
      createdAt: userRow.created_at,
    },
    stats: {
      myCollectionsCount: mappedCollections.filter((cItem) => cItem.isMine).length,
      totalCollectionsCount: mappedCollections.length,
      myRequestsCount: visibleRequests.filter(
        (r) =>
          r.created_by === user.id ||
          (user.globalRole === 'super_admin' && r.created_by === null),
      ).length,
      recentExecutionsCount: recentHistory.length,
      activeSessionsCount: activeSessionsCountRows.length,
      apiTokensCount: personalTokensRows.length,
    },
    workspaces: accessibleWorkspaces.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      visibility: w.visibility,
      role: memberRoleMap.get(w.id) ?? (canSeeAllWorkspaces ? user.globalRole : 'member'),
      isOwner: w.created_by === user.id,
      createdAt: w.created_at,
    })),
    collections: mappedCollections,
    requests: mappedRequests,
    recentHistory: recentHistory.map((h) => ({
      id: h.id,
      workspaceId: h.workspace_id,
      workspaceName: wsMap.get(h.workspace_id)?.name ?? 'Workspace',
      method: h.method,
      url: h.url,
      status: h.response_status,
      durationMs: h.duration_ms,
      createdAt: h.created_at,
    })),
    loginHistory: personalLogins.map((l) => ({
      id: l.id,
      emailAttempted: l.email_attempted,
      succeeded: l.succeeded === 1,
      ipAddress: l.ip_address,
      userAgent: l.user_agent,
      failureReason: l.failure_reason,
      createdAt: l.created_at,
    })),
  })
})


// Server-Side Paginated Profile Portfolio & Activity Endpoints
authRoutes.get('/profile/workspaces', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const tq = parseTableQuery(c, 5)
  const canSeeAllWorkspaces =
    user.permissions.workspaces.anyView || canManageSystem(user.globalRole, user.permissions)

  const [accessibleWorkspaces, memberships] = await Promise.all([
    canSeeAllWorkspaces
      ? db.selectFrom('workspaces').selectAll().orderBy('created_at', 'asc').execute()
      : db
          .selectFrom('workspaces')
          .leftJoin('workspace_members', (join) =>
            join
              .onRef('workspace_members.workspace_id', '=', 'workspaces.id')
              .on('workspace_members.user_id', '=', user.id),
          )
          .selectAll('workspaces')
          .where((eb) =>
            eb.or([
              eb('workspaces.visibility', '=', 'team'),
              eb('workspace_members.id', 'is not', null),
            ]),
          )
          .orderBy('workspaces.created_at', 'asc')
          .execute(),
    db
      .selectFrom('workspace_members')
      .select(['workspace_id', 'role'])
      .where('user_id', '=', user.id)
      .execute(),
  ])

  const roleMap = new Map(memberships.map((m) => [m.workspace_id, m.role]))
  const rows = accessibleWorkspaces.map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    visibility: w.visibility,
    role: roleMap.get(w.id) ?? (canSeeAllWorkspaces ? user.globalRole : 'member'),
    isOwner: w.created_by === user.id,
    createdAt: w.created_at,
  }))

  return c.json(
    paginateServerArray(rows, tq, {
      getSearchText: (w) => `${w.name} ${w.slug} ${w.role} ${w.visibility}`,
      sortExtractors: {
        name: (w) => w.name,
        role: (w) => w.role,
        createdAt: (w) => w.createdAt,
      },
    }),
  )
})

authRoutes.get('/profile/collections', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const scope = c.req.query('scope') === 'all' ? 'all' : 'mine'
  const tq = parseTableQuery(c, 10)

  const canSeeAllWorkspaces =
    user.permissions.workspaces.anyView || canManageSystem(user.globalRole, user.permissions)

  const [accessibleWorkspaces, collections, folders, requests] = await Promise.all([
    canSeeAllWorkspaces
      ? db.selectFrom('workspaces').select(['id', 'name']).execute()
      : db
          .selectFrom('workspaces')
          .leftJoin('workspace_members', (join) =>
            join
              .onRef('workspace_members.workspace_id', '=', 'workspaces.id')
              .on('workspace_members.user_id', '=', user.id),
          )
          .select(['workspaces.id as id', 'workspaces.name as name'])
          .where((eb) =>
            eb.or([
              eb('workspaces.visibility', '=', 'team'),
              eb('workspace_members.id', 'is not', null),
            ]),
          )
          .execute(),
    db.selectFrom('collections').selectAll().orderBy('updated_at', 'desc').execute(),
    db.selectFrom('collection_folders').select(['id', 'collection_id']).execute(),
    db.selectFrom('saved_requests').select(['id', 'collection_id']).execute(),
  ])

  const wsMap = new Map(accessibleWorkspaces.map((w) => [w.id, w.name]))
  const folderCounts = new Map<string, number>()
  for (const f of folders) {
    folderCounts.set(f.collection_id, (folderCounts.get(f.collection_id) ?? 0) + 1)
  }
  const reqCounts = new Map<string, number>()
  for (const r of requests) {
    reqCounts.set(r.collection_id, (reqCounts.get(r.collection_id) ?? 0) + 1)
  }

  const rows = collections
    .filter((col) => wsMap.has(col.workspace_id))
    .map((col) => ({
      id: col.id,
      workspaceId: col.workspace_id,
      workspaceName: wsMap.get(col.workspace_id) ?? 'Workspace',
      name: col.name,
      description: col.description ?? '',
      isMine:
        col.created_by === user.id ||
        (user.globalRole === 'super_admin' && col.created_by === null),
      folderCount: folderCounts.get(col.id) ?? 0,
      requestCount: reqCounts.get(col.id) ?? 0,
      updatedAt: col.updated_at,
    }))
    .filter((col) => (scope === 'mine' ? col.isMine : true))

  return c.json(
    paginateServerArray(rows, tq, {
      getSearchText: (col) => `${col.name} ${col.description} ${col.workspaceName}`,
      sortExtractors: {
        name: (col) => col.name,
        workspace: (col) => col.workspaceName,
        folders: (col) => col.folderCount,
        endpoints: (col) => col.requestCount,
        updatedAt: (col) => col.updatedAt,
      },
    }),
  )
})

authRoutes.get('/profile/requests', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const scope = c.req.query('scope') === 'all' ? 'all' : 'mine'
  const tq = parseTableQuery(c, 10)

  const safeParse = <T>(raw: string | null | undefined, fallback: T): T => {
    if (!raw) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  const canSeeAllWorkspaces =
    user.permissions.workspaces.anyView || canManageSystem(user.globalRole, user.permissions)

  const [accessibleWorkspaces, collections, savedRequests] = await Promise.all([
    canSeeAllWorkspaces
      ? db.selectFrom('workspaces').select(['id', 'name']).execute()
      : db
          .selectFrom('workspaces')
          .leftJoin('workspace_members', (join) =>
            join
              .onRef('workspace_members.workspace_id', '=', 'workspaces.id')
              .on('workspace_members.user_id', '=', user.id),
          )
          .select(['workspaces.id as id', 'workspaces.name as name'])
          .where((eb) =>
            eb.or([
              eb('workspaces.visibility', '=', 'team'),
              eb('workspace_members.id', 'is not', null),
            ]),
          )
          .execute(),
    db.selectFrom('collections').select(['id', 'name']).execute(),
    db.selectFrom('saved_requests').selectAll().orderBy('updated_at', 'desc').execute(),
  ])

  const wsMap = new Map(accessibleWorkspaces.map((w) => [w.id, w.name]))
  const colMap = new Map(collections.map((col) => [col.id, col.name]))

  const rows = savedRequests
    .filter((r) => wsMap.has(r.workspace_id))
    .map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      workspaceName: wsMap.get(r.workspace_id) ?? 'Workspace',
      collectionId: r.collection_id,
      collectionName: colMap.get(r.collection_id) ?? 'Collection',
      folderId: r.folder_id,
      name: r.name,
      description: r.description ?? '',
      protocol: ((r.protocol as RequestProtocol | null) ?? 'http') as RequestProtocol,
      method: r.method,
      url: r.url,
      isMine:
        r.created_by === user.id ||
        (user.globalRole === 'super_admin' && r.created_by === null),
      queryParams: safeParse<KeyValueItem[]>(r.query_params_json, []),
      headers: safeParse<KeyValueItem[]>(r.headers_json, []),
      pathVariables: safeParse<KeyValueItem[]>(r.path_vars_json, []),
      auth: safeParse<RequestAuthConfig>(r.auth_json, { type: 'none' }),
      body: safeParse<RequestBodyConfig>(r.body_json, {
        mode: 'none',
        raw: '',
        urlencoded: [],
        multipart: [],
      }),
      graphql: safeParse<GraphqlPayloadConfig>(r.graphql_json, {
        query: '',
        variables: '{}',
        operationName: '',
      }),
      assertions: safeParse<RequestAssertion[]>(r.assertions_json, []),
      postResponseVars: safeParse<ResponseVariableExtractor[]>(r.post_vars_json, []),
      preRequestScript: r.pre_request_script ?? '',
      testScript: r.test_script ?? '',
      jsonSchema: r.json_schema ?? '',
      updatedAt: r.updated_at,
    }))
    .filter((r) => (scope === 'mine' ? r.isMine : true))

  return c.json(
    paginateServerArray(rows, tq, {
      getSearchText: (r) =>
        `${r.method} ${r.name} ${r.url} ${r.collectionName} ${r.workspaceName}`,
      sortExtractors: {
        endpoint: (r) => `${r.method} ${r.name}`,
        url: (r) => r.url,
        collection: (r) => r.collectionName,
        updatedAt: (r) => r.updatedAt,
      },
    }),
  )
})

authRoutes.get('/profile/history', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const tq = parseTableQuery(c, 10)

  const workspaces = await db.selectFrom('workspaces').select(['id', 'name']).execute()
  const wsMap = new Map(workspaces.map((w) => [w.id, w.name]))

  let baseQuery = db.selectFrom('request_history').where('user_id', '=', user.id)
  for (const tk of tq.tokens) {
    const maybeCode = Number(tk)
    if (!Number.isNaN(maybeCode) && /^\d{3}$/.test(tk)) {
      baseQuery = baseQuery.where((eb) =>
        eb.or([
          eb('response_status', '=', maybeCode),
          sqlTextLike('method', tk),
          sqlTextLike('url', tk),
        ]),
      )
    } else {
      baseQuery = baseQuery.where((eb) =>
        eb.or([sqlTextLike('method', tk), sqlTextLike('url', tk)]),
      )
    }
  }

  const countRow = await baseQuery
    .select((eb) => eb.fn.count<number>('id').as('total'))
    .executeTakeFirst()
  const total = Number(countRow?.total ?? 0)

  const sortMap: Record<
    string,
    'method' | 'url' | 'response_status' | 'duration_ms' | 'created_at'
  > = {
    method: 'method',
    url: 'url',
    status: 'response_status',
    durationMs: 'duration_ms',
    createdAt: 'created_at',
  }
  const sortCol = (tq.sortBy && sortMap[tq.sortBy]) || 'created_at'
  const sortDir = tq.sortBy ? tq.sortDir : 'desc'

  const { safePage: histSafePage, safeOffset: histSafeOffset } = resolveSqlPageWindow(
    total,
    tq.page,
    tq.pageSize,
  )
  const rows = await baseQuery
    .select([
      'id',
      'workspace_id',
      'method',
      'url',
      'response_status',
      'duration_ms',
      'created_at',
    ])
    .orderBy(sortCol, sortDir)
    .limit(tq.pageSize)
    .offset(histSafeOffset)
    .execute()

  return c.json({
    items: rows.map((h) => ({
      id: h.id,
      workspaceId: h.workspace_id,
      workspaceName: wsMap.get(h.workspace_id) ?? 'Workspace',
      method: h.method,
      url: h.url,
      status: h.response_status,
      durationMs: h.duration_ms,
      createdAt: h.created_at,
    })),
    total,
    page: histSafePage,
    pageSize: tq.pageSize,
  })
})

authRoutes.get('/profile/logins', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const tq = parseTableQuery(c, 10)

  let baseQuery = db
    .selectFrom('login_history')
    .where((eb) => eb.or([eb('user_id', '=', user.id), eb('email_attempted', '=', user.email)]))

  for (const tk of tq.tokens) {
    if (tk === 'success' || tk === 'succeeded') {
      baseQuery = baseQuery.where('succeeded', '=', 1)
    } else if (tk === 'failed' || tk === 'fail') {
      baseQuery = baseQuery.where('succeeded', '=', 0)
    } else {
      baseQuery = baseQuery.where((eb) =>
        eb.or([
          sqlTextLike('ip_address', tk),
          sqlTextLike('user_agent', tk),
          sqlTextLike('failure_reason', tk),
        ]),
      )
    }
  }

  const countRow = await baseQuery
    .select((eb) => eb.fn.count<number>('id').as('total'))
    .executeTakeFirst()
  const total = Number(countRow?.total ?? 0)

  const sortMap: Record<string, 'succeeded' | 'user_agent' | 'ip_address' | 'created_at'> = {
    result: 'succeeded',
    device: 'user_agent',
    ip: 'ip_address',
    createdAt: 'created_at',
  }
  const sortCol = (tq.sortBy && sortMap[tq.sortBy]) || 'created_at'
  const sortDir = tq.sortBy ? tq.sortDir : 'desc'

  const { safePage: loginSafePage, safeOffset: loginSafeOffset } = resolveSqlPageWindow(
    total,
    tq.page,
    tq.pageSize,
  )
  const rows = await baseQuery
    .select([
      'id',
      'email_attempted',
      'succeeded',
      'ip_address',
      'user_agent',
      'failure_reason',
      'created_at',
    ])
    .orderBy(sortCol, sortDir)
    .limit(tq.pageSize)
    .offset(loginSafeOffset)
    .execute()

  return c.json({
    items: rows.map((l) => ({
      id: l.id,
      emailAttempted: l.email_attempted,
      succeeded: l.succeeded === 1,
      ipAddress: l.ip_address,
      userAgent: l.user_agent,
      failureReason: l.failure_reason,
      createdAt: l.created_at,
    })),
    total,
    page: loginSafePage,
    pageSize: tq.pageSize,
  })
})

// Personal API Tokens for CLI & CI/CD
authRoutes.get('/tokens', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const tq = parseTableQuery(c, 10)

  let baseQuery = db.selectFrom('api_tokens').where('user_id', '=', user.id)
  for (const tk of tq.tokens) {
    baseQuery = baseQuery.where((eb) =>
      eb.or([sqlTextLike('name', tk), sqlTextLike('token_prefix', tk)]),
    )
  }

  const countRow = await baseQuery
    .select((eb) => eb.fn.count<number>('id').as('total'))
    .executeTakeFirst()
  const total = Number(countRow?.total ?? 0)

  const sortMap: Record<
    string,
    'name' | 'token_prefix' | 'last_used_at' | 'expires_at' | 'created_at'
  > = {
    name: 'name',
    prefix: 'token_prefix',
    lastUsed: 'last_used_at',
    lastUsedAt: 'last_used_at',
    expiresAt: 'expires_at',
    created: 'created_at',
    createdAt: 'created_at',
  }
  const sortCol = (tq.sortBy && sortMap[tq.sortBy]) || 'created_at'
  const sortDir = tq.sortBy ? tq.sortDir : 'desc'

  const { safePage: tokSafePage, safeOffset: tokSafeOffset } = resolveSqlPageWindow(
    total,
    tq.page,
    tq.pageSize,
  )
  let listQuery = baseQuery
    .select(['id', 'name', 'token_prefix', 'last_used_at', 'expires_at', 'created_at'])
    .orderBy(sortCol, sortDir)

  if (tq.hasPaginationParams) {
    listQuery = listQuery.limit(tq.pageSize).offset(tokSafeOffset)
  }

  const rows = await listQuery.execute()
  const mapped = rows.map((t) => ({
    id: t.id,
    name: t.name,
    tokenPrefix: t.token_prefix,
    lastUsedAt: t.last_used_at,
    expiresAt: t.expires_at,
    createdAt: t.created_at,
  }))

  return c.json({
    tokens: mapped,
    items: mapped,
    total,
    page: tokSafePage,
    pageSize: tq.pageSize,
  })
})

authRoutes.post('/tokens', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!

  const parsed = createApiTokenSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Token name is required.')
  }

  const rawSecret = `mf_pat_${generateRandomToken(24)}`
  const tokenPrefix = rawSecret.slice(0, 14)
  const tokenHash = sha256Hex(rawSecret)
  const nowIso = new Date().toISOString()
  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000).toISOString()
    : null

  const id = crypto.randomUUID()
  await db
    .insertInto('api_tokens')
    .values({
      id,
      user_id: user.id,
      name: parsed.data.name,
      token_prefix: tokenPrefix,
      token_hash: tokenHash,
      last_used_at: null,
      expires_at: expiresAt,
      created_at: nowIso,
    })
    .execute()

  return c.json(
    {
      id,
      name: parsed.data.name,
      token: rawSecret,
      tokenPrefix,
      expiresAt,
      createdAt: nowIso,
    },
    201,
  )
})

authRoutes.patch('/tokens/:id', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const tokenId = c.req.param('id')

  const schema = z.object({
    name: z.string().trim().min(1, 'Token name is required').max(120),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Token name is required.',
    )
  }

  await db
    .updateTable('api_tokens')
    .set({ name: parsed.data.name })
    .where('id', '=', tokenId)
    .where('user_id', '=', user.id)
    .execute()

  return c.json({ ok: true, id: tokenId, name: parsed.data.name })
})

authRoutes.delete('/tokens/:id', requireAuthMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  await db
    .deleteFrom('api_tokens')
    .where('id', '=', c.req.param('id'))
    .where('user_id', '=', user.id)
    .execute()
  return c.json({ ok: true })
})
