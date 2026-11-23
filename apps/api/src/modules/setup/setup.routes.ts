import crypto from 'node:crypto'
import {
  databaseConfigSchema,
  MEOFAST_VERSION,
  type SetupStatusResponse,
  setupExecuteSchema,
} from '@meofast/shared'
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { hashPassword } from '../../core/crypto/argon2.js'
import { generateRandomToken, sha256Hex } from '../../core/crypto/vault.js'
import {
  createDatabaseExplicitly,
  createKyselyDatabase,
  validateDatabaseConnection,
} from '../../core/database/connection-manager.js'
import { runMigrations } from '../../core/database/migrations.js'
import { AppError } from '../../core/errors/app-error.js'
import {
  createRateLimiter,
  SESSION_COOKIE_NAME,
  SETUP_CSRF_COOKIE_NAME,
} from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'
import { recordAuditLog } from '../audit/audit.service.js'

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'default'
}

export const setupRoutes = new Hono<AppEnv>()

const setupRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  keyPrefix: 'setup',
})

function ensureSetupUnlocked(installed: boolean): void {
  if (installed) {
    throw new AppError(
      403,
      'INSTALLATION_LOCKED',
      'Meetofast installation is already completed and permanently locked.',
    )
  }
}

function verifySetupCsrf(
  cookieToken: string | undefined,
  headerToken: string | undefined,
  isValidIssued: boolean,
): void {
  if (!cookieToken || !headerToken || !isValidIssued) {
    throw new AppError(
      403,
      'SETUP_CSRF_INVALID',
      'Invalid or expired setup security token. Refresh the setup page and try again.',
    )
  }
  const a = Buffer.from(cookieToken, 'utf8')
  const b = Buffer.from(headerToken, 'utf8')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new AppError(403, 'SETUP_CSRF_MISMATCH', 'Setup CSRF token mismatch.')
  }
}

setupRoutes.get('/status', async (c) => {
  const runtime = c.get('runtime')

  if (runtime.isInstalled()) {
    const db = runtime.getDb()
    const rows = await db
      .selectFrom('system_settings')
      .select(['setting_key', 'setting_value'])
      .where('setting_key', 'in', ['app_name', 'default_language', 'registration_mode'])
      .execute()

    const map = new Map(rows.map((r) => [r.setting_key, r.setting_value]))
    const response: SetupStatusResponse = {
      installed: true,
      version: MEOFAST_VERSION,
      appName: map.get('app_name') ?? 'Meetofast',
      defaultLanguage: map.get('default_language') ?? 'en',
      registrationMode: map.get('registration_mode') === 'open' ? 'open' : 'invite_only',
      csrfToken: '',
      configuredEngine: runtime.getConfiguredEngine(),
    }
    return c.json(response)
  }

  let csrfToken = getCookie(c, SETUP_CSRF_COOKIE_NAME)
  if (!csrfToken || !runtime.verifyBootstrapCsrfToken(csrfToken)) {
    csrfToken = runtime.issueBootstrapCsrfToken()
    const isHttps =
      c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://')
    setCookie(c, SETUP_CSRF_COOKIE_NAME, csrfToken, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps,
      path: '/',
      maxAge: 3600 * 4,
    })
  }

  const response: SetupStatusResponse = {
    installed: false,
    version: MEOFAST_VERSION,
    appName: 'Meetofast',
    defaultLanguage: 'en',
    registrationMode: 'invite_only',
    csrfToken,
    defaultStorageDir: runtime.dataDir,
  }
  return c.json(response)
})

setupRoutes.post('/validate-db', setupRateLimiter, async (c) => {
  const runtime = c.get('runtime')
  ensureSetupUnlocked(runtime.isInstalled())

  const cookieToken = getCookie(c, SETUP_CSRF_COOKIE_NAME)
  const headerToken = c.req.header('x-csrf-token')
  verifySetupCsrf(cookieToken, headerToken, runtime.verifyBootstrapCsrfToken(cookieToken))

  const body = await c.req.json().catch(() => ({}))
  const parsed = databaseConfigSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid database configuration',
      parsed.error.flatten(),
    )
  }

  const validation = await validateDatabaseConnection(parsed.data, runtime.dataDir)
  return c.json(validation)
})

setupRoutes.post('/create-db', setupRateLimiter, async (c) => {
  const runtime = c.get('runtime')
  ensureSetupUnlocked(runtime.isInstalled())

  const cookieToken = getCookie(c, SETUP_CSRF_COOKIE_NAME)
  const headerToken = c.req.header('x-csrf-token')
  verifySetupCsrf(cookieToken, headerToken, runtime.verifyBootstrapCsrfToken(cookieToken))

  const body = await c.req.json().catch(() => ({}))
  const parsed = databaseConfigSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid database configuration',
    )
  }

  await createDatabaseExplicitly(parsed.data)
  const validation = await validateDatabaseConnection(parsed.data, runtime.dataDir)
  return c.json(validation)
})

setupRoutes.post('/execute', setupRateLimiter, async (c) => {
  const runtime = c.get('runtime')
  ensureSetupUnlocked(runtime.isInstalled())

  const cookieToken = getCookie(c, SETUP_CSRF_COOKIE_NAME)
  const headerToken = c.req.header('x-csrf-token')
  verifySetupCsrf(cookieToken, headerToken, runtime.verifyBootstrapCsrfToken(cookieToken))

  const rawBody = await c.req.json().catch(() => ({}))
  const parsed = setupExecuteSchema.safeParse(rawBody)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid installation payload',
      parsed.error.flatten(),
    )
  }

  const { database, admin, appConfig } = parsed.data
  const stepsCompleted: string[] = []

  // Step 1: Validate DB connectivity before persisting anything
  const validation = await validateDatabaseConnection(database, runtime.dataDir)
  if (!validation.valid) {
    throw new AppError(400, 'DATABASE_VALIDATION_FAILED', validation.message, validation)
  }
  stepsCompleted.push('database_validated')

  // Step 2: Initialize Kysely & run migrations
  const liveDb = createKyselyDatabase(database, runtime.dataDir)
  try {
    await runMigrations(liveDb, database.engine)
    stepsCompleted.push('migrations_executed')

    // Step 3: Prevent duplicate administrator creation if database already had users
    const existingAdmin = await liveDb.selectFrom('users').select('id').limit(1).executeTakeFirst()
    if (existingAdmin) {
      await liveDb.destroy()
      throw new AppError(
        409,
        'ADMIN_ALREADY_EXISTS',
        'Target database already contains user accounts. Choose a clean database or reset the target schema.',
      )
    }

    const nowIso = new Date().toISOString()
    const adminId = crypto.randomUUID()
    const orgId = crypto.randomUUID()
    const workspaceId = crypto.randomUUID()
    const collectionId = crypto.randomUUID()
    const envGlobalId = crypto.randomUUID()
    const envDevId = crypto.randomUUID()

    // Step 4: Hash initial administrator password with Argon2id
    const passwordHash = await hashPassword(admin.password)

    await liveDb
      .insertInto('users')
      .values({
        id: adminId,
        email: admin.email.toLowerCase(),
        username: admin.username.toLowerCase(),
        full_name: admin.fullName,
        password_hash: passwordHash,
        global_role: 'super_admin',
        status: 'active',
        last_login_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()
    stepsCompleted.push('administrator_created')

    // Step 5: Seed initial Organization & Default Workspace
    const orgName = appConfig.organizationName?.trim() || `${appConfig.appName} Organization`
    await liveDb
      .insertInto('organizations')
      .values({
        id: orgId,
        name: orgName,
        slug: slugify(orgName),
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()

    await liveDb
      .insertInto('organization_members')
      .values({
        id: crypto.randomUUID(),
        organization_id: orgId,
        user_id: adminId,
        role: 'org_admin',
        created_at: nowIso,
      })
      .execute()

    await liveDb
      .insertInto('workspaces')
      .values({
        id: workspaceId,
        organization_id: orgId,
        name: 'Core API Workspace',
        slug: 'core-api-workspace',
        description: 'Primary team workspace for API collections, environments, and testing.',
        visibility: 'team',
        created_by: adminId,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()

    await liveDb
      .insertInto('workspace_members')
      .values({
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        user_id: adminId,
        role: 'workspace_admin',
        created_at: nowIso,
      })
      .execute()

    // Starter Environments (Global + Development)
    await liveDb
      .insertInto('environments')
      .values([
        {
          id: envGlobalId,
          workspace_id: workspaceId,
          name: 'Global Variables',
          is_global: 1,
          created_by: adminId,
          created_at: nowIso,
          updated_at: nowIso,
        },
        {
          id: envDevId,
          workspace_id: workspaceId,
          name: 'Public Demo API',
          is_global: 0,
          created_by: adminId,
          created_at: nowIso,
          updated_at: nowIso,
        },
      ])
      .execute()

    await liveDb
      .insertInto('environment_variables')
      .values([
        {
          id: crypto.randomUUID(),
          environment_id: envDevId,
          var_key: 'baseUrl',
          var_value: 'https://jsonplaceholder.typicode.com',
          encrypted_value: null,
          is_secret: 0,
          enabled: 1,
          sort_order: 0,
          created_at: nowIso,
          updated_at: nowIso,
        },
        {
          id: crypto.randomUUID(),
          environment_id: envDevId,
          var_key: 'demoApiToken',
          var_value: '',
          encrypted_value: runtime.vault.encrypt('meofast-demo-secret-token'),
          is_secret: 1,
          enabled: 1,
          sort_order: 1,
          created_at: nowIso,
          updated_at: nowIso,
        },
      ])
      .execute()

    // Starter Sample Collection & Requests
    await liveDb
      .insertInto('collections')
      .values({
        id: collectionId,
        workspace_id: workspaceId,
        name: 'Quickstart REST Collection',
        description: 'Ready-to-run sample HTTP requests demonstrating variables and assertions.',
        variables_json: '[]',
        auth_json: JSON.stringify({ type: 'none' }),
        sort_order: 0,
        created_by: adminId,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()

    await liveDb
      .insertInto('saved_requests')
      .values([
        {
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          collection_id: collectionId,
          folder_id: null,
          name: 'List Sample Users',
          description: 'Fetches sample user directory and validates HTTP 200 & latency.',
          method: 'GET',
          url: '{{baseUrl}}/users',
          query_params_json: JSON.stringify([]),
          headers_json: JSON.stringify([
            { id: 'h1', key: 'Accept', value: 'application/json', description: '', enabled: true },
          ]),
          path_vars_json: '[]',
          auth_json: JSON.stringify({ type: 'none' }),
          body_json: JSON.stringify({ mode: 'none', raw: '', urlencoded: [], multipart: [] }),
          assertions_json: JSON.stringify([
            {
              id: 'a1',
              type: 'status_equals',
              target: '',
              expected: '200',
              enabled: true,
            },
            {
              id: 'a2',
              type: 'duration_lt',
              target: '',
              expected: '5000',
              enabled: true,
            },
          ]),
          pre_request_script: '',
          test_script: `pm.test("Returns non-empty users array", () => {\n  const data = pm.response.json();\n  pm.expect(Array.isArray(data)).to.be.true;\n  pm.expect(data.length).to.be.above(0);\n});`,
          json_schema: JSON.stringify(
            {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['id', 'name', 'email'],
                properties: {
                  id: { type: 'integer' },
                  name: { type: 'string' },
                  email: { type: 'string' },
                },
              },
            },
            null,
            2,
          ),
          protocol: 'http',
          graphql_json: null,
          sort_order: 0,
          created_by: adminId,
          created_at: nowIso,
          updated_at: nowIso,
        },
        {
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          collection_id: collectionId,
          folder_id: null,
          name: 'Create Post Resource',
          description: 'Sends a JSON payload with Bearer token interpolation.',
          method: 'POST',
          url: '{{baseUrl}}/posts',
          query_params_json: '[]',
          headers_json: JSON.stringify([
            {
              id: 'h1',
              key: 'Content-Type',
              value: 'application/json',
              description: '',
              enabled: true,
            },
          ]),
          path_vars_json: '[]',
          auth_json: JSON.stringify({
            type: 'bearer',
            token: '{{demoApiToken}}',
            prefix: 'Bearer',
          }),
          body_json: JSON.stringify({
            mode: 'json',
            raw: JSON.stringify(
              {
                title: 'Meetofast Self-Hosted API Test',
                body: 'Executed via Meetofast Hono backend engine',
                userId: 1,
              },
              null,
              2,
            ),
            urlencoded: [],
            multipart: [],
          }),
          assertions_json: JSON.stringify([
            {
              id: 'a1',
              type: 'status_equals',
              target: '',
              expected: '201',
              enabled: true,
            },
          ]),
          pre_request_script: '',
          test_script: '',
          json_schema: '',
          protocol: 'http',
          graphql_json: null,
          sort_order: 1,
          created_by: adminId,
          created_at: nowIso,
          updated_at: nowIso,
        },
      ])
      .execute()
    stepsCompleted.push('workspace_seeded')

    // Step 6: Seed system settings & application secrets
    const defaultSettings: Array<{ key: string; value: string }> = [
      { key: 'app_name', value: appConfig.appName },
      { key: 'public_url', value: appConfig.publicUrl },
      { key: 'default_timezone', value: appConfig.timezone },
      { key: 'default_language', value: appConfig.language },
      { key: 'registration_mode', value: 'invite_only' },
      {
        key: 'network_policy',
        value: JSON.stringify({
          allowPrivateNetworks: false,
          allowLocalhost: false,
          allowedCidrs: [],
          allowedDomains: [],
        }),
      },
      { key: 'jwt_signing_secret', value: runtime.vault.encrypt(generateRandomToken(32)) },
      { key: 'installation_completed', value: 'true' },
    ]

    for (const s of defaultSettings) {
      await liveDb
        .insertInto('system_settings')
        .values({
          setting_key: s.key,
          setting_value: s.value,
          updated_at: nowIso,
        })
        .execute()
    }
    stepsCompleted.push('settings_initialized')

    // Step 7: Create immediate Super Admin session so "Go to Dashboard" works smoothly
    const rawSessionToken = generateRandomToken(32)
    const sessionCsrf = generateRandomToken(24)
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()

    await liveDb
      .insertInto('sessions')
      .values({
        id: crypto.randomUUID(),
        user_id: adminId,
        token_hash: sha256Hex(rawSessionToken),
        csrf_token: sessionCsrf,
        ip_address: c.get('clientIp'),
        user_agent: c.req.header('user-agent') ?? null,
        expires_at: expiresAt,
        created_at: nowIso,
      })
      .execute()

    await recordAuditLog(liveDb, {
      organizationId: orgId,
      workspaceId,
      actorUserId: adminId,
      actorEmail: admin.email.toLowerCase(),
      action: 'setup.completed',
      targetType: 'system',
      targetId: orgId,
      metadata: {
        engine: database.engine,
        appName: appConfig.appName,
        version: MEOFAST_VERSION,
      },
      ipAddress: c.get('clientIp'),
    })

    // Step 8: Commit encrypted config & lock file atomically
    await runtime.commitInstallation(database, liveDb, MEOFAST_VERSION)
    stepsCompleted.push('installation_locked')

    const isHttps =
      c.req.header('x-forwarded-proto') === 'https' || appConfig.publicUrl.startsWith('https://')

    setCookie(c, SESSION_COOKIE_NAME, rawSessionToken, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps,
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    })

    return c.json({
      installed: true,
      version: MEOFAST_VERSION,
      engine: database.engine,
      adminEmail: admin.email.toLowerCase(),
      appName: appConfig.appName,
      stepsCompleted,
      csrfToken: sessionCsrf,
    })
  } catch (err) {
    if (!runtime.isInstalled()) {
      try {
        await liveDb.destroy()
      } catch {
        // ignore cleanup error
      }
    }
    throw err
  }
})
