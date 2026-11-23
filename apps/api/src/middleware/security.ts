import crypto from 'node:crypto'
import {
  canManageSystem,
  type PolicyAbility,
  type RbacFeatureKey,
} from '@meofast/shared'
import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { sha256Hex } from '../core/crypto/vault.js'
import { AppError } from '../core/errors/app-error.js'
import { assertPolicy, resolveRolePermissions } from '../modules/users/rbac.service.js'
import type { AppEnv, AuthenticatedUser } from '../types/hono.types.js'

function resolveRoutePolicyRequirement(
  pathname: string,
  method: string,
  formatQuery?: string,
): { feature: RbacFeatureKey; ability: PolicyAbility } | null {
  const m = method.toUpperCase()
  const p = pathname.replace(/^\/api\/v1/, '')

  // Personal account / session / profile endpoints are always accessible to the signed-in owner,
  // except Personal API Tokens which map to the `tokens` feature policy.
  if (p.startsWith('/auth/tokens')) {
    if (m === 'GET') return { feature: 'tokens', ability: 'view' }
    if (m === 'POST') return { feature: 'tokens', ability: 'create' }
    if (m === 'DELETE') return { feature: 'tokens', ability: 'delete' }
    return { feature: 'tokens', ability: 'update' }
  }
  if (p.startsWith('/auth/') || p.startsWith('/admin/')) {
    if (p.startsWith('/admin/ai-config')) {
      return { feature: 'system_settings', ability: m === 'GET' ? 'view' : 'update' }
    }
    return null
  }

  // Backup & Restore
  if (/^\/workspaces\/[^/]+\/backup$/.test(p)) {
    return { feature: 'backup', ability: 'view' }
  }
  if (/^\/workspaces\/[^/]+\/restore$/.test(p)) {
    return { feature: 'backup', ability: 'create' }
  }

  // API Documentation static HTML export & doc tables
  if (formatQuery === 'html' || /\/doc-items$/.test(p)) {
    return { feature: 'docs', ability: 'view' }
  }

  const crudAbility = (readAbility: PolicyAbility = 'anyView'): PolicyAbility => {
    if (m === 'GET' || m === 'HEAD') return readAbility
    if (m === 'POST') return 'create'
    if (m === 'DELETE') return 'delete'
    return 'update'
  }

  // Environments
  if (p.includes('/environments')) {
    const isSingleRead = m === 'GET' && /^\/environments\/[^/]+/.test(p)
    return { feature: 'environments', ability: crudAbility(isSingleRead ? 'view' : 'anyView') }
  }

  // Mocks
  if (p.includes('/mocks') || p.endsWith('/generate-mocks')) {
    return { feature: 'mocks', ability: crudAbility('anyView') }
  }

  // Webhooks (protected routes)
  if (p.includes('/webhooks')) {
    const isTestOrReplay = m === 'POST' && (/\/test-event$/.test(p) || /\/replay$/.test(p))
    if (isTestOrReplay) return { feature: 'webhooks', ability: 'update' }
    return { feature: 'webhooks', ability: crudAbility('anyView') }
  }

  // Monitors & Load Tests
  if (p.includes('/monitors') || p.includes('/load-tests')) {
    return { feature: 'monitors', ability: crudAbility('anyView') }
  }

  // History & Debug Capsules
  if (p.includes('/history') || p.includes('/capsules')) {
    return { feature: 'history', ability: crudAbility('anyView') }
  }

  // Cookies
  if (p.includes('/cookies')) {
    return { feature: 'cookies', ability: crudAbility('anyView') }
  }

  // Outbound Proxy Execution (running a request requires requests.view)
  if (p.startsWith('/proxy/')) {
    return { feature: 'requests', ability: 'view' }
  }

  // Saved Requests, Examples & Comments
  if (p.includes('/requests') || p.includes('/examples') || p.includes('/comments')) {
    return { feature: 'requests', ability: crudAbility('view') }
  }

  // Collections, Folders &Workspace Tree
  if (p.includes('/collections') || p.includes('/folders') || /\/workspaces\/[^/]+\/tree$/.test(p)) {
    if (m === 'POST' && /\/collections\/[^/]+\/run$/.test(p)) {
      return { feature: 'collections', ability: 'view' }
    }
    return { feature: 'collections', ability: crudAbility('anyView') }
  }

  // Workspaces
  if (p.startsWith('/workspaces')) {
    if (m === 'GET' && /\/search$/.test(p)) {
      return { feature: 'workspaces', ability: 'view' }
    }
    return { feature: 'workspaces', ability: crudAbility('anyView') }
  }

  return null
}

function enforceAuthenticatedRoutePolicy(
  pathname: string,
  method: string,
  formatQuery: string | undefined,
  user: AuthenticatedUser,
): void {
  const reqPolicy = resolveRoutePolicyRequirement(pathname, method, formatQuery)
  if (!reqPolicy) return
  assertPolicy(user, reqPolicy.feature, reqPolicy.ability)
}

export const SESSION_COOKIE_NAME = 'meofast_session'
export const SETUP_CSRF_COOKIE_NAME = 'meofast_setup_csrf'

export const securityHeadersMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  const realIp = c.req.header('x-real-ip')?.trim()
  c.set('clientIp', forwarded || realIp || '127.0.0.1')

  await next()

  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
})

export function createRateLimiter(options: { windowMs: number; max: number; keyPrefix: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>()

  return createMiddleware<AppEnv>(async (c, next) => {
    const now = Date.now()
    if (hits.size > 5000) {
      for (const [k, v] of hits.entries()) {
        if (v.resetAt <= now) hits.delete(k)
      }
    }

    const ip = c.get('clientIp') || '127.0.0.1'
    const key = `${options.keyPrefix}:${ip}`
    const current = hits.get(key)

    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs })
      await next()
      return
    }

    if (current.count >= options.max) {
      throw new AppError(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Too many requests. Please wait a moment before trying again.',
      )
    }

    current.count += 1
    await next()
  })
}

export const requireInstalledMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const runtime = c.get('runtime')
  if (!runtime.isInstalled()) {
    throw new AppError(
      503,
      'SETUP_REQUIRED',
      'Meofast first-time installation has not been completed.',
    )
  }
  await next()
})

export const requireAuthMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const nowIso = new Date().toISOString()

  // 1. Support Personal API Tokens (Bearer mf_pat_...) for CLI & CI/CD
  const authHeader = c.req.header('authorization') ?? ''
  if (authHeader.startsWith('Bearer mf_pat_')) {
    const rawApiToken = authHeader.slice('Bearer '.length).trim()
    const apiTokenHash = sha256Hex(rawApiToken)

    const tokenRow = await db
      .selectFrom('api_tokens')
      .innerJoin('users', 'users.id', 'api_tokens.user_id')
      .select([
        'api_tokens.id as token_id',
        'api_tokens.expires_at as expires_at',
        'users.id as user_id',
        'users.email as email',
        'users.username as username',
        'users.full_name as full_name',
        'users.global_role as global_role',
        'users.status as status',
      ])
      .where('api_tokens.token_hash', '=', apiTokenHash)
      .executeTakeFirst()

    if (!tokenRow || (tokenRow.expires_at && tokenRow.expires_at <= nowIso)) {
      throw new AppError(401, 'INVALID_API_TOKEN', 'Invalid or expired API token.')
    }

    if (tokenRow.status !== 'active') {
      throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This user account has been deactivated.')
    }

    await db
      .updateTable('api_tokens')
      .set({ last_used_at: nowIso })
      .where('id', '=', tokenRow.token_id)
      .execute()

    const permissions = await resolveRolePermissions(db, tokenRow.global_role)

    const authedTokenUser: AuthenticatedUser = {
      id: tokenRow.user_id,
      email: tokenRow.email,
      username: tokenRow.username,
      fullName: tokenRow.full_name,
      globalRole: tokenRow.global_role,
      permissions,
    }
    c.set('user', authedTokenUser)
    enforceAuthenticatedRoutePolicy(
      c.req.path,
      c.req.method,
      c.req.query('format'),
      authedTokenUser,
    )

    await next()
    return
  }

  // 2. Browser Session Cookie + CSRF protection
  const rawToken = getCookie(c, SESSION_COOKIE_NAME)
  if (!rawToken) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required. Please sign in.')
  }

  const tokenHash = sha256Hex(rawToken)

  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'sessions.id as session_id',
      'sessions.csrf_token as csrf_token',
      'sessions.expires_at as expires_at',
      'users.id as user_id',
      'users.email as email',
      'users.username as username',
      'users.full_name as full_name',
      'users.global_role as global_role',
      'users.status as status',
    ])
    .where('sessions.token_hash', '=', tokenHash)
    .executeTakeFirst()

  if (!row || row.expires_at <= nowIso) {
    throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.')
  }

  if (row.status !== 'active') {
    throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This user account has been deactivated.')
  }

  // Enforce CSRF verification on mutating HTTP verbs
  const method = c.req.method.toUpperCase()
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const providedCsrf = c.req.header('x-csrf-token') ?? ''
    const expectedBuf = Buffer.from(row.csrf_token, 'utf8')
    const providedBuf = Buffer.from(providedCsrf, 'utf8')
    if (
      expectedBuf.length !== providedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, providedBuf)
    ) {
      throw new AppError(403, 'CSRF_INVALID', 'Invalid or missing X-CSRF-Token header.')
    }
  }

  const permissions = await resolveRolePermissions(db, row.global_role)

  const authedSessionUser: AuthenticatedUser = {
    id: row.user_id,
    email: row.email,
    username: row.username,
    fullName: row.full_name,
    globalRole: row.global_role,
    permissions,
  }
  c.set('user', authedSessionUser)
  c.set('session', {
    id: row.session_id,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
  })
  enforceAuthenticatedRoutePolicy(
    c.req.path,
    c.req.method,
    c.req.query('format'),
    authedSessionUser,
  )

  await next()
})

export const requireAdminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('user')
  if (!user || !canManageSystem(user.globalRole, user.permissions)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Administrator privileges are required to perform this action.',
    )
  }
  await next()
})
