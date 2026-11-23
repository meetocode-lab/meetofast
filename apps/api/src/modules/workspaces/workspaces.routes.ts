import crypto from 'node:crypto'
import {
  canManageSystem,
  canWriteWorkspace,
  createWorkspaceSchema,
  fuzzySubsequenceScore,
  type GraphqlPayloadConfig,
  HTTP_METHODS,
  type HttpMethod,
  type KeyValueItem,
  rankSearchCandidates,
  type RequestAssertion,
  type RequestAuthConfig,
  type RequestBodyConfig,
  type RequestProtocol,
  type ResponseVariableExtractor,
  WORKSPACE_ROLES,
} from '@meofast/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { AppError } from '../../core/errors/app-error.js'
import { requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'
import { recordAuditLog } from '../audit/audit.service.js'

export const workspacesRoutes = new Hono<AppEnv>()

workspacesRoutes.use('*', requireAuthMiddleware)

function makeSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base || 'workspace'}-${crypto.randomBytes(2).toString('hex')}`
}

workspacesRoutes.get('/', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!

  const rows = user.permissions.workspaces.anyView
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
          eb.or([
            eb('workspaces.visibility', '=', 'team'),
            eb('workspace_members.id', 'is not', null),
          ]),
        )
        .orderBy('workspaces.created_at', 'asc')
        .execute()

  return c.json({
    workspaces: rows.map((w) => ({
      id: w.id,
      organizationId: w.organization_id,
      name: w.name,
      slug: w.slug,
      description: w.description ?? '',
      visibility: w.visibility,
      createdAt: w.created_at,
    })),
  })
})

workspacesRoutes.post('/', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!

  if (!user.permissions.workspaces.create) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create workspaces.')
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = createWorkspaceSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid workspace payload',
    )
  }

  const org = await db
    .selectFrom('organizations')
    .select('id')
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirstOrThrow()

  const nowIso = new Date().toISOString()
  const workspaceId = crypto.randomUUID()
  const slug = makeSlug(parsed.data.name)

  await db
    .insertInto('workspaces')
    .values({
      id: workspaceId,
      organization_id: org.id,
      name: parsed.data.name,
      slug,
      description: parsed.data.description || null,
      visibility: parsed.data.visibility,
      created_by: user.id,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  await db
    .insertInto('workspace_members')
    .values({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      user_id: user.id,
      role: 'workspace_admin',
      created_at: nowIso,
    })
    .execute()

  await db
    .insertInto('environments')
    .values({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      name: 'Global Variables',
      is_global: 1,
      created_by: user.id,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  await recordAuditLog(db, {
    organizationId: org.id,
    workspaceId,
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'workspace.created',
    targetType: 'workspace',
    targetId: workspaceId,
    metadata: { name: parsed.data.name, visibility: parsed.data.visibility },
    ipAddress: c.get('clientIp'),
  })

  return c.json(
    {
      workspace: {
        id: workspaceId,
        organizationId: org.id,
        name: parsed.data.name,
        slug,
        description: parsed.data.description ?? '',
        visibility: parsed.data.visibility,
        createdAt: nowIso,
      },
    },
    201,
  )
})

workspacesRoutes.patch('/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('id')

  if (!user.permissions.workspaces.update) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to rename workspaces.')
  }

  const schema = z.object({
    name: z.string().trim().min(2, 'Workspace name must be at least 2 characters').max(160),
    description: z.string().trim().max(500).optional(),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Workspace name is required.',
    )
  }

  const existing = await db
    .selectFrom('workspaces')
    .select(['id', 'organization_id', 'description'])
    .where('id', '=', wsId)
    .executeTakeFirst()
  if (!existing) {
    throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.')
  }

  const nowIso = new Date().toISOString()
  await db
    .updateTable('workspaces')
    .set({
      name: parsed.data.name,
      ...(parsed.data.description !== undefined
        ? { description: parsed.data.description || null }
        : {}),
      updated_at: nowIso,
    })
    .where('id', '=', wsId)
    .execute()

  await recordAuditLog(db, {
    organizationId: existing.organization_id,
    workspaceId: wsId,
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'workspace.renamed',
    targetType: 'workspace',
    targetId: wsId,
    metadata: { name: parsed.data.name },
    ipAddress: c.get('clientIp'),
  })

  return c.json({ ok: true, id: wsId, name: parsed.data.name })
})

workspacesRoutes.get('/:id/members', async (c) => {
  const db = c.get('runtime').getDb()
  const wsId = c.req.param('id')

  const rows = await db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select([
      'workspace_members.id as id',
      'workspace_members.role as role',
      'workspace_members.created_at as created_at',
      'users.id as user_id',
      'users.email as email',
      'users.username as username',
      'users.full_name as full_name',
      'users.global_role as global_role',
    ])
    .where('workspace_members.workspace_id', '=', wsId)
    .orderBy('workspace_members.created_at', 'asc')
    .execute()

  return c.json({
    members: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      email: r.email,
      username: r.username,
      fullName: r.full_name,
      globalRole: r.global_role,
      workspaceRole: r.role,
      joinedAt: r.created_at,
    })),
  })
})

workspacesRoutes.post('/:id/members', async (c) => {
  const db = c.get('runtime').getDb()
  const actor = c.get('user')!
  const wsId = c.req.param('id')

  if (!canManageSystem(actor.globalRole) && actor.globalRole !== 'workspace_admin') {
    throw new AppError(403, 'FORBIDDEN', 'Workspace administrator access required.')
  }

  const schema = z.object({
    userId: z.string().min(1),
    role: z.enum(WORKSPACE_ROLES).default('developer'),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Valid userId and role are required.')
  }

  const existing = await db
    .selectFrom('workspace_members')
    .select('id')
    .where('workspace_id', '=', wsId)
    .where('user_id', '=', parsed.data.userId)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('workspace_members')
      .set({ role: parsed.data.role })
      .where('id', '=', existing.id)
      .execute()
  } else {
    await db
      .insertInto('workspace_members')
      .values({
        id: crypto.randomUUID(),
        workspace_id: wsId,
        user_id: parsed.data.userId,
        role: parsed.data.role,
        created_at: new Date().toISOString(),
      })
      .execute()
  }

  await recordAuditLog(db, {
    workspaceId: wsId,
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'workspace.member_upserted',
    targetType: 'user',
    targetId: parsed.data.userId,
    metadata: { role: parsed.data.role },
    ipAddress: c.get('clientIp'),
  })

  return c.json({ ok: true })
})

workspacesRoutes.delete('/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const actor = c.get('user')!
  const wsId = c.req.param('id')

  if (!canManageSystem(actor.globalRole)) {
    throw new AppError(403, 'FORBIDDEN', 'Only administrators can delete workspaces.')
  }

  const allWorkspaces = await db.selectFrom('workspaces').select('id').execute()
  if (allWorkspaces.length <= 1) {
    throw new AppError(400, 'LAST_WORKSPACE', 'Cannot delete the only remaining workspace.')
  }

  await db.deleteFrom('workspaces').where('id', '=', wsId).execute()

  await recordAuditLog(db, {
    workspaceId: wsId,
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'workspace.deleted',
    targetType: 'workspace',
    targetId: wsId,
    ipAddress: c.get('clientIp'),
  })

  return c.json({ ok: true })
})

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

workspacesRoutes.get('/:id/search', async (c) => {
  const db = c.get('runtime').getDb()
  const wsId = c.req.param('id')
  const rawQuery = (c.req.query('q') ?? '').trim()
  const qLower = rawQuery.toLowerCase()

  if (!qLower) {
    const [recentRequests, recentCollections] = await Promise.all([
      db
        .selectFrom('saved_requests')
        .innerJoin('collections', 'collections.id', 'saved_requests.collection_id')
        .select([
          'saved_requests.id as id',
          'saved_requests.workspace_id as workspace_id',
          'saved_requests.collection_id as collection_id',
          'saved_requests.folder_id as folder_id',
          'saved_requests.name as name',
          'saved_requests.description as description',
          'saved_requests.protocol as protocol',
          'saved_requests.method as method',
          'saved_requests.url as url',
          'saved_requests.query_params_json as query_params_json',
          'saved_requests.headers_json as headers_json',
          'saved_requests.path_vars_json as path_vars_json',
          'saved_requests.auth_json as auth_json',
          'saved_requests.body_json as body_json',
          'saved_requests.graphql_json as graphql_json',
          'saved_requests.assertions_json as assertions_json',
          'saved_requests.post_vars_json as post_vars_json',
          'saved_requests.pre_request_script as pre_request_script',
          'saved_requests.test_script as test_script',
          'saved_requests.json_schema as json_schema',
          'saved_requests.sort_order as sort_order',
          'collections.name as collection_name',
        ])
        .where('saved_requests.workspace_id', '=', wsId)
        .orderBy('saved_requests.updated_at', 'desc')
        .limit(12)
        .execute(),
      db
        .selectFrom('collections')
        .select(['id', 'name', 'description'])
        .where('workspace_id', '=', wsId)
        .orderBy('sort_order', 'asc')
        .limit(6)
        .execute(),
    ])

    return c.json({
      query: '',
      results: [
        ...recentRequests.map((r) => ({
          kind: 'request' as const,
          id: r.id,
          title: r.name,
          subtitle: r.url,
          badge: r.collection_name,
          method: r.method,
          request: {
            id: r.id,
            workspaceId: r.workspace_id,
            collectionId: r.collection_id,
            folderId: r.folder_id,
            name: r.name,
            description: r.description ?? '',
            protocol: (r.protocol ?? 'http') as RequestProtocol,
            method: r.method,
            url: r.url,
            queryParams: safeParseJson<KeyValueItem[]>(r.query_params_json, []),
            headers: safeParseJson<KeyValueItem[]>(r.headers_json, []),
            pathVariables: safeParseJson<KeyValueItem[]>(r.path_vars_json, []),
            auth: safeParseJson<RequestAuthConfig>(r.auth_json, { type: 'none' }),
            body: safeParseJson<RequestBodyConfig>(r.body_json, {
              mode: 'none',
              raw: '',
              urlencoded: [],
              multipart: [],
            }),
            graphql: safeParseJson<GraphqlPayloadConfig>(r.graphql_json, {
              query: '',
              variables: '{}',
              operationName: '',
            }),
            assertions: safeParseJson<RequestAssertion[]>(r.assertions_json, []),
            postResponseVars: safeParseJson<ResponseVariableExtractor[]>(r.post_vars_json, []),
            preRequestScript: r.pre_request_script ?? '',
            testScript: r.test_script ?? '',
            jsonSchema: r.json_schema ?? '',
            sortOrder: r.sort_order,
          },
        })),
        ...recentCollections.map((col) => ({
          kind: 'collection' as const,
          id: col.id,
          title: col.name,
          subtitle: col.description || 'Collection',
          badge: 'Collection',
        })),
      ],
    })
  }

  // Load workspace corpus and rank via Okapi BM25 + Damerau-Levenshtein + Fuzzy Subsequence
  const [
    allRequests,
    allCollections,
    allMocks,
    allWebhooks,
    allEnvs,
    allMonitors,
    allCapsules,
  ] = await Promise.all([
    db
      .selectFrom('saved_requests')
      .innerJoin('collections', 'collections.id', 'saved_requests.collection_id')
      .select([
        'saved_requests.id as id',
        'saved_requests.workspace_id as workspace_id',
        'saved_requests.collection_id as collection_id',
        'saved_requests.folder_id as folder_id',
        'saved_requests.name as name',
        'saved_requests.description as description',
        'saved_requests.protocol as protocol',
        'saved_requests.method as method',
        'saved_requests.url as url',
        'saved_requests.query_params_json as query_params_json',
        'saved_requests.headers_json as headers_json',
        'saved_requests.path_vars_json as path_vars_json',
        'saved_requests.auth_json as auth_json',
        'saved_requests.body_json as body_json',
        'saved_requests.graphql_json as graphql_json',
        'saved_requests.assertions_json as assertions_json',
        'saved_requests.post_vars_json as post_vars_json',
        'saved_requests.pre_request_script as pre_request_script',
        'saved_requests.test_script as test_script',
        'saved_requests.json_schema as json_schema',
        'saved_requests.sort_order as sort_order',
        'collections.name as collection_name',
      ])
      .where('saved_requests.workspace_id', '=', wsId)
      .orderBy('saved_requests.updated_at', 'desc')
      .limit(400)
      .execute(),

    db
      .selectFrom('collections')
      .select(['id', 'name', 'description'])
      .where('workspace_id', '=', wsId)
      .limit(100)
      .execute(),

    db
      .selectFrom('mock_routes')
      .select(['id', 'name', 'method', 'path_pattern'])
      .where('workspace_id', '=', wsId)
      .limit(100)
      .execute(),

    db
      .selectFrom('webhook_endpoints')
      .select(['id', 'name', 'token'])
      .where('workspace_id', '=', wsId)
      .limit(100)
      .execute(),

    db
      .selectFrom('environments')
      .leftJoin('environment_variables', 'environment_variables.environment_id', 'environments.id')
      .select([
        'environments.id as id',
        'environments.name as name',
        'environment_variables.var_key as var_key',
      ])
      .where('environments.workspace_id', '=', wsId)
      .limit(300)
      .execute(),

    db
      .selectFrom('monitors')
      .select(['id', 'name', 'method', 'url'])
      .where('workspace_id', '=', wsId)
      .limit(100)
      .execute(),

    db
      .selectFrom('debug_capsules')
      .select(['id', 'title', 'notes'])
      .where('workspace_id', '=', wsId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute(),
  ])

  const dedupedEnvs = new Map<string, { id: string; name: string; allKeys: string[] }>()
  for (const row of allEnvs) {
    const entry = dedupedEnvs.get(row.id) ?? { id: row.id, name: row.name, allKeys: [] }
    if (row.var_key && !entry.allKeys.includes(row.var_key)) {
      entry.allKeys.push(row.var_key)
    }
    dedupedEnvs.set(row.id, entry)
  }

  const candidates = [
    ...allRequests.map((r) => ({
      searchPrimary: `${r.method} ${r.name}`,
      searchSecondary: `${r.url} ${r.collection_name} ${r.description ?? ''}`,
      boost: 1.15,
      payload: {
        kind: 'request' as const,
        id: r.id,
        title: r.name,
        subtitle: r.url,
        badge: r.collection_name,
        method: r.method,
        request: {
          id: r.id,
          workspaceId: r.workspace_id,
          collectionId: r.collection_id,
          folderId: r.folder_id,
          name: r.name,
          description: r.description ?? '',
          protocol: (r.protocol ?? 'http') as RequestProtocol,
          method: r.method,
          url: r.url,
          queryParams: safeParseJson<KeyValueItem[]>(r.query_params_json, []),
          headers: safeParseJson<KeyValueItem[]>(r.headers_json, []),
          pathVariables: safeParseJson<KeyValueItem[]>(r.path_vars_json, []),
          auth: safeParseJson<RequestAuthConfig>(r.auth_json, { type: 'none' }),
          body: safeParseJson<RequestBodyConfig>(r.body_json, {
            mode: 'none',
            raw: '',
            urlencoded: [],
            multipart: [],
          }),
          graphql: safeParseJson<GraphqlPayloadConfig>(r.graphql_json, {
            query: '',
            variables: '{}',
            operationName: '',
          }),
          assertions: safeParseJson<RequestAssertion[]>(r.assertions_json, []),
          postResponseVars: safeParseJson<ResponseVariableExtractor[]>(r.post_vars_json, []),
          preRequestScript: r.pre_request_script ?? '',
          testScript: r.test_script ?? '',
          jsonSchema: r.json_schema ?? '',
          sortOrder: r.sort_order,
        },
      },
    })),
    ...allCollections.map((col) => ({
      searchPrimary: col.name,
      searchSecondary: col.description ?? '',
      boost: 1.0,
      payload: {
        kind: 'collection' as const,
        id: col.id,
        title: col.name,
        subtitle: col.description || 'API Collection',
        badge: 'Collection',
      },
    })),
    ...allMocks.map((m) => ({
      searchPrimary: `${m.method} ${m.name}`,
      searchSecondary: m.path_pattern,
      boost: 0.95,
      payload: {
        kind: 'mock' as const,
        id: m.id,
        title: m.name,
        subtitle: m.path_pattern,
        badge: 'Mock Route',
        method: m.method,
      },
    })),
    ...Array.from(dedupedEnvs.values()).map((env) => {
      const matchedKeys = env.allKeys.filter((k) => fuzzySubsequenceScore(rawQuery, k) > 0)
      return {
        searchPrimary: env.name,
        searchSecondary: env.allKeys.join(' '),
        boost: 0.95,
        payload: {
          kind: 'environment' as const,
          id: env.id,
          title: env.name,
          subtitle:
            matchedKeys.length > 0
              ? `Variables: ${matchedKeys.slice(0, 4).map((k) => `{{${k}}}`).join(', ')}`
              : 'Environment',
          badge: 'Environment',
        },
      }
    }),
    ...allWebhooks.map((wh) => ({
      searchPrimary: wh.name,
      searchSecondary: wh.token,
      boost: 0.9,
      payload: {
        kind: 'webhook' as const,
        id: wh.id,
        title: wh.name,
        subtitle: `/api/v1/webhooks/in/${wh.token}`,
        badge: 'Webhook',
      },
    })),
    ...allMonitors.map((mon) => ({
      searchPrimary: mon.name,
      searchSecondary: `${mon.method} ${mon.url}`,
      boost: 0.9,
      payload: {
        kind: 'monitor' as const,
        id: mon.id,
        title: mon.name,
        subtitle: mon.url,
        badge: 'Monitor',
        method: mon.method,
      },
    })),
    ...allCapsules.map((cap) => ({
      searchPrimary: cap.title,
      searchSecondary: cap.notes ?? '',
      boost: 0.85,
      payload: {
        kind: 'capsule' as const,
        id: cap.id,
        title: cap.title,
        subtitle: cap.notes || 'Debug Capsule',
        badge: 'Capsule',
      },
    })),
  ]

  const ranked = rankSearchCandidates(
    candidates,
    rawQuery,
    (cItem) => ({
      primary: cItem.searchPrimary,
      secondary: cItem.searchSecondary,
      boost: cItem.boost,
    }),
    24,
  )

  return c.json({
    query: rawQuery,
    results: ranked.map((r) => r.payload),
  })
})

// ============================================================================
// Full Workspace Backup & Restore (.meofast-backup.json)
// ============================================================================

workspacesRoutes.get('/:id/backup', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('id')

  if (!user.permissions.backup.view) {
    throw new AppError(403, 'FORBIDDEN', 'Backup view permission is required to export backup.')
  }

  const ws = await db
    .selectFrom('workspaces')
    .selectAll()
    .where('id', '=', wsId)
    .executeTakeFirst()
  if (!ws) {
    throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.')
  }

  const [
    collections,
    requests,
    examples,
    environments,
    mockRoutes,
    webhooks,
    monitors,
  ] = await Promise.all([
    db
      .selectFrom('collections')
      .selectAll()
      .where('workspace_id', '=', wsId)
      .orderBy('sort_order', 'asc')
      .execute(),
    db
      .selectFrom('saved_requests')
      .selectAll()
      .where('workspace_id', '=', wsId)
      .orderBy('sort_order', 'asc')
      .execute(),
    db
      .selectFrom('request_examples')
      .selectAll()
      .where('workspace_id', '=', wsId)
      .orderBy('created_at', 'asc')
      .execute(),
    db
      .selectFrom('environments')
      .selectAll()
      .where('workspace_id', '=', wsId)
      .orderBy('is_global', 'desc')
      .orderBy('created_at', 'asc')
      .execute(),
    db
      .selectFrom('mock_routes')
      .selectAll()
      .where('workspace_id', '=', wsId)
      .orderBy('created_at', 'asc')
      .execute(),
    db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('workspace_id', '=', wsId)
      .orderBy('created_at', 'asc')
      .execute(),
    db
      .selectFrom('monitors')
      .selectAll()
      .where('workspace_id', '=', wsId)
      .orderBy('created_at', 'asc')
      .execute(),
  ])

  const collectionIds = collections.map((col) => col.id)
  const folders =
    collectionIds.length > 0
      ? await db
          .selectFrom('collection_folders')
          .selectAll()
          .where('collection_id', 'in', collectionIds)
          .orderBy('sort_order', 'asc')
          .execute()
      : []

  const envIds = environments.map((e) => e.id)
  const envVars =
    envIds.length > 0
      ? await db
          .selectFrom('environment_variables')
          .selectAll()
          .where('environment_id', 'in', envIds)
          .orderBy('sort_order', 'asc')
          .execute()
      : []

  return c.json({
    format: 'meofast.workspace-backup.v1',
    exportedAt: new Date().toISOString(),
    workspace: {
      name: ws.name,
      description: ws.description ?? '',
      visibility: ws.visibility,
    },
    collections: collections.map((col) => ({
      id: col.id,
      name: col.name,
      description: col.description ?? '',
      variables: safeParseJson<KeyValueItem[]>(col.variables_json, []),
      auth: safeParseJson<RequestAuthConfig>(col.auth_json, { type: 'none' }),
      headers: safeParseJson<KeyValueItem[]>(col.headers_json, []),
      sortOrder: col.sort_order,
    })),
    folders: folders.map((f) => ({
      id: f.id,
      collectionId: f.collection_id,
      parentFolderId: f.parent_folder_id,
      name: f.name,
      description: f.description ?? '',
      variables: safeParseJson<KeyValueItem[]>(f.variables_json, []),
      auth: safeParseJson<RequestAuthConfig>(f.auth_json, { type: 'inherit' }),
      headers: safeParseJson<KeyValueItem[]>(f.headers_json, []),
      sortOrder: f.sort_order,
    })),
    requests: requests.map((r) => ({
      id: r.id,
      collectionId: r.collection_id,
      folderId: r.folder_id,
      name: r.name,
      description: r.description ?? '',
      protocol: ((r.protocol as RequestProtocol | null) ?? 'http') as RequestProtocol,
      method: r.method,
      url: r.url,
      queryParams: safeParseJson<KeyValueItem[]>(r.query_params_json, []),
      headers: safeParseJson<KeyValueItem[]>(r.headers_json, []),
      pathVariables: safeParseJson<KeyValueItem[]>(r.path_vars_json, []),
      auth: safeParseJson<RequestAuthConfig>(r.auth_json, { type: 'none' }),
      body: safeParseJson<RequestBodyConfig>(r.body_json, {
        mode: 'none',
        raw: '',
        urlencoded: [],
        multipart: [],
      }),
      graphql: safeParseJson<GraphqlPayloadConfig>(r.graphql_json, {
        query: '',
        variables: '{}',
        operationName: '',
      }),
      assertions: safeParseJson<RequestAssertion[]>(r.assertions_json, []),
      postResponseVars: safeParseJson<ResponseVariableExtractor[]>(r.post_vars_json, []),
      preRequestScript: r.pre_request_script ?? '',
      testScript: r.test_script ?? '',
      jsonSchema: r.json_schema ?? '',
      sortOrder: r.sort_order,
    })),
    examples: examples.map((ex) => ({
      id: ex.id,
      requestId: ex.request_id,
      name: ex.name,
      statusCode: ex.status_code,
      statusText: ex.status_text,
      contentType: ex.content_type,
      headers: safeParseJson<Record<string, string>>(ex.headers_json, {}),
      body: ex.body,
    })),
    environments: environments.map((env) => ({
      id: env.id,
      name: env.name,
      isGlobal: env.is_global === 1,
      variables: envVars
        .filter((v) => v.environment_id === env.id)
        .map((v) => ({
          key: v.var_key,
          value: v.is_secret === 1 ? '' : v.var_value,
          isSecret: v.is_secret === 1,
          enabled: v.enabled === 1,
        })),
    })),
    mockRoutes: mockRoutes.map((m) => ({
      name: m.name,
      collectionId: m.collection_id,
      method: m.method,
      pathPattern: m.path_pattern,
      statusCode: m.status_code,
      latencyMs: m.latency_ms,
      errorRate: m.error_rate,
      rateLimitRpm: m.rate_limit_rpm ?? 0,
      headers: safeParseJson<KeyValueItem[]>(m.headers_json, []),
      responseBody: m.response_body,
      isStateful: m.is_stateful === 1,
      enabled: m.enabled === 1,
    })),
    webhooks: webhooks.map((w) => ({
      name: w.name,
      forwardUrl: w.forward_url ?? '',
      enabled: w.enabled === 1,
    })),
    monitors: monitors.map((mon) => ({
      name: mon.name,
      method: mon.method,
      url: mon.url,
      headers: safeParseJson<KeyValueItem[]>(mon.headers_json, []),
      bodyRaw: mon.body_raw ?? '',
      expectedStatus: mon.expected_status,
      maxLatencyMs: mon.max_latency_ms,
      intervalSeconds: mon.interval_seconds,
      alertWebhookUrl: mon.alert_webhook_url ?? '',
      enabled: mon.enabled === 1,
    })),
  })
})

workspacesRoutes.post('/:id/restore', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const user = c.get('user')!
  const wsId = c.req.param('id')

  if (!user.permissions.backup.create) {
    throw new AppError(403, 'FORBIDDEN', 'Backup create permission is required to restore backup.')
  }

  const rawBody = await c.req.json().catch(() => null)
  if (!rawBody || typeof rawBody !== 'object') {
    throw new AppError(400, 'INVALID_BACKUP', 'Invalid JSON backup payload.')
  }

  const backupObj = rawBody as Record<string, unknown>
  if (backupObj.format !== 'meofast.workspace-backup.v1') {
    throw new AppError(
      400,
      'UNSUPPORTED_BACKUP_FORMAT',
      'Expected backup format "meofast.workspace-backup.v1".',
    )
  }

  const nowIso = new Date().toISOString()
  const collectionIdMap = new Map<string, string>()
  const folderIdMap = new Map<string, string>()
  const requestIdMap = new Map<string, string>()

  const rawCollections = Array.isArray(backupObj.collections)
    ? (backupObj.collections as Array<Record<string, unknown>>)
    : []
  const rawFolders = Array.isArray(backupObj.folders)
    ? (backupObj.folders as Array<Record<string, unknown>>)
    : []
  const rawRequests = Array.isArray(backupObj.requests)
    ? (backupObj.requests as Array<Record<string, unknown>>)
    : []
  const rawExamples = Array.isArray(backupObj.examples)
    ? (backupObj.examples as Array<Record<string, unknown>>)
    : []
  const rawEnvironments = Array.isArray(backupObj.environments)
    ? (backupObj.environments as Array<Record<string, unknown>>)
    : []
  const rawMockRoutes = Array.isArray(backupObj.mockRoutes)
    ? (backupObj.mockRoutes as Array<Record<string, unknown>>)
    : []
  const rawWebhooks = Array.isArray(backupObj.webhooks)
    ? (backupObj.webhooks as Array<Record<string, unknown>>)
    : []
  const rawMonitors = Array.isArray(backupObj.monitors)
    ? (backupObj.monitors as Array<Record<string, unknown>>)
    : []

  for (let i = 0; i < rawCollections.length; i += 1) {
    const col = rawCollections[i]!
    const oldId = String(col.id ?? crypto.randomUUID())
    const newId = crypto.randomUUID()
    collectionIdMap.set(oldId, newId)
    await db
      .insertInto('collections')
      .values({
        id: newId,
        workspace_id: wsId,
        name: String(col.name ?? 'Imported Collection').slice(0, 200),
        description: col.description ? String(col.description) : null,
        variables_json: JSON.stringify(Array.isArray(col.variables) ? col.variables : []),
        auth_json: JSON.stringify(col.auth ?? { type: 'none' }),
        headers_json: JSON.stringify(Array.isArray(col.headers) ? col.headers : []),
        sort_order: typeof col.sortOrder === 'number' ? col.sortOrder : i,
        created_by: user.id,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()
  }

  // Insert folders with pre-mapped IDs so nested parentFolderId references resolve cleanly
  for (const f of rawFolders) {
    folderIdMap.set(String(f.id ?? crypto.randomUUID()), crypto.randomUUID())
  }
  const insertedFolders = new Set<string>()
  let remainingFolders = [...rawFolders]
  for (let pass = 0; pass < 8 && remainingFolders.length > 0; pass += 1) {
    const deferred: Array<Record<string, unknown>> = []
    for (let i = 0; i < remainingFolders.length; i += 1) {
      const f = remainingFolders[i]!
      const oldId = String(f.id ?? '')
      const newId = folderIdMap.get(oldId) ?? crypto.randomUUID()
      const mappedColId = collectionIdMap.get(String(f.collectionId ?? ''))
      if (!mappedColId) continue

      const oldParent = f.parentFolderId ? String(f.parentFolderId) : null
      if (oldParent && folderIdMap.has(oldParent) && !insertedFolders.has(oldParent) && pass < 7) {
        deferred.push(f)
        continue
      }

      await db
        .insertInto('collection_folders')
        .values({
          id: newId,
          collection_id: mappedColId,
          parent_folder_id: oldParent ? (folderIdMap.get(oldParent) ?? null) : null,
          name: String(f.name ?? 'Folder').slice(0, 200),
          description: f.description ? String(f.description) : null,
          variables_json: JSON.stringify(Array.isArray(f.variables) ? f.variables : []),
          auth_json: JSON.stringify(f.auth ?? { type: 'inherit' }),
          headers_json: JSON.stringify(Array.isArray(f.headers) ? f.headers : []),
          sort_order: typeof f.sortOrder === 'number' ? f.sortOrder : i,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .execute()
      insertedFolders.add(oldId)
    }
    remainingFolders = deferred
  }

  let restoredRequests = 0
  for (let i = 0; i < rawRequests.length; i += 1) {
    const r = rawRequests[i]!
    const mappedColId = collectionIdMap.get(String(r.collectionId ?? ''))
    if (!mappedColId) continue

    const oldReqId = String(r.id ?? crypto.randomUUID())
    const newReqId = crypto.randomUUID()
    requestIdMap.set(oldReqId, newReqId)

    const methodUpper = String(r.method ?? 'GET').toUpperCase()
    const validMethod: HttpMethod = (HTTP_METHODS as readonly string[]).includes(methodUpper)
      ? (methodUpper as HttpMethod)
      : 'GET'

    await db
      .insertInto('saved_requests')
      .values({
        id: newReqId,
        workspace_id: wsId,
        collection_id: mappedColId,
        folder_id: r.folderId ? (folderIdMap.get(String(r.folderId)) ?? null) : null,
        name: String(r.name ?? 'Request').slice(0, 200),
        description: r.description ? String(r.description) : null,
        method: validMethod,
        url: String(r.url ?? ''),
        query_params_json: JSON.stringify(Array.isArray(r.queryParams) ? r.queryParams : []),
        headers_json: JSON.stringify(Array.isArray(r.headers) ? r.headers : []),
        path_vars_json: JSON.stringify(Array.isArray(r.pathVariables) ? r.pathVariables : []),
        auth_json: JSON.stringify(r.auth ?? { type: 'none' }),
        body_json: JSON.stringify(
          r.body ?? { mode: 'none', raw: '', urlencoded: [], multipart: [] },
        ),
        assertions_json: JSON.stringify(Array.isArray(r.assertions) ? r.assertions : []),
        post_vars_json: JSON.stringify(
          Array.isArray(r.postResponseVars) ? r.postResponseVars : [],
        ),
        pre_request_script: String(r.preRequestScript ?? ''),
        test_script: String(r.testScript ?? ''),
        json_schema: String(r.jsonSchema ?? ''),
        protocol: String(r.protocol ?? 'http'),
        graphql_json: r.graphql ? JSON.stringify(r.graphql) : null,
        sort_order: typeof r.sortOrder === 'number' ? r.sortOrder : i,
        created_by: user.id,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()
    restoredRequests += 1
  }

  let restoredExamples = 0
  for (const ex of rawExamples) {
    const mappedReqId = requestIdMap.get(String(ex.requestId ?? ''))
    if (!mappedReqId) continue
    await db
      .insertInto('request_examples')
      .values({
        id: crypto.randomUUID(),
        workspace_id: wsId,
        request_id: mappedReqId,
        name: String(ex.name ?? 'Example').slice(0, 160),
        status_code: typeof ex.statusCode === 'number' ? ex.statusCode : 200,
        status_text: String(ex.statusText ?? 'OK').slice(0, 80),
        content_type: String(ex.contentType ?? 'application/json').slice(0, 160),
        headers_json: JSON.stringify(ex.headers ?? {}),
        body: String(ex.body ?? ''),
        created_at: nowIso,
      })
      .execute()
    restoredExamples += 1
  }

  const existingGlobalEnv = await db
    .selectFrom('environments')
    .select('id')
    .where('workspace_id', '=', wsId)
    .where('is_global', '=', 1)
    .limit(1)
    .executeTakeFirst()

  let restoredEnvironments = 0
  for (const env of rawEnvironments) {
    const isGlobal = Boolean(env.isGlobal)
    let targetEnvId: string

    if (isGlobal && existingGlobalEnv) {
      targetEnvId = existingGlobalEnv.id
    } else {
      targetEnvId = crypto.randomUUID()
      await db
        .insertInto('environments')
        .values({
          id: targetEnvId,
          workspace_id: wsId,
          name: String(env.name ?? 'Environment').slice(0, 160),
          is_global: isGlobal ? 1 : 0,
          created_by: user.id,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .execute()
      restoredEnvironments += 1
    }

    const vars = Array.isArray(env.variables)
      ? (env.variables as Array<Record<string, unknown>>)
      : []
    for (let idx = 0; idx < vars.length; idx += 1) {
      const v = vars[idx]!
      const key = String(v.key ?? '').trim()
      if (!key) continue
      const isSecret = Boolean(v.isSecret)
      const valStr = String(v.value ?? '')
      await db
        .insertInto('environment_variables')
        .values({
          id: crypto.randomUUID(),
          environment_id: targetEnvId,
          var_key: key,
          var_value: isSecret ? '' : valStr,
          encrypted_value: isSecret && valStr ? runtime.vault.encrypt(valStr) : null,
          is_secret: isSecret ? 1 : 0,
          enabled: v.enabled === false ? 0 : 1,
          sort_order: idx,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .execute()
    }
  }

  let restoredMocks = 0
  for (const m of rawMockRoutes) {
    const methodUpper = String(m.method ?? 'GET').toUpperCase()
    const validMethod: HttpMethod = (HTTP_METHODS as readonly string[]).includes(methodUpper)
      ? (methodUpper as HttpMethod)
      : 'GET'
    const rawPath = String(m.pathPattern ?? '/mock').trim()
    await db
      .insertInto('mock_routes')
      .values({
        id: crypto.randomUUID(),
        workspace_id: wsId,
        collection_id: m.collectionId
          ? (collectionIdMap.get(String(m.collectionId)) ?? null)
          : null,
        name: String(m.name ?? 'Mock Route').slice(0, 160),
        method: validMethod,
        path_pattern: rawPath.startsWith('/') ? rawPath : `/${rawPath}`,
        status_code: typeof m.statusCode === 'number' ? m.statusCode : 200,
        latency_ms: typeof m.latencyMs === 'number' ? m.latencyMs : 0,
        error_rate: typeof m.errorRate === 'number' ? m.errorRate : 0,
        rate_limit_rpm: typeof m.rateLimitRpm === 'number' ? m.rateLimitRpm : 0,
        headers_json: JSON.stringify(Array.isArray(m.headers) ? m.headers : []),
        response_body: String(m.responseBody ?? '{}'),
        is_stateful: m.isStateful ? 1 : 0,
        state_items_json: null,
        enabled: m.enabled === false ? 0 : 1,
        hit_count: 0,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()
    restoredMocks += 1
  }

  let restoredWebhooks = 0
  for (const w of rawWebhooks) {
    await db
      .insertInto('webhook_endpoints')
      .values({
        id: crypto.randomUUID(),
        workspace_id: wsId,
        name: String(w.name ?? 'Webhook').slice(0, 160),
        token: crypto.randomBytes(18).toString('hex'),
        signing_secret: null,
        forward_url: w.forwardUrl ? String(w.forwardUrl) : null,
        enabled: w.enabled === false ? 0 : 1,
        created_at: nowIso,
      })
      .execute()
    restoredWebhooks += 1
  }

  let restoredMonitors = 0
  for (const mon of rawMonitors) {
    const methodUpper = String(mon.method ?? 'GET').toUpperCase()
    const validMethod: HttpMethod = (HTTP_METHODS as readonly string[]).includes(methodUpper)
      ? (methodUpper as HttpMethod)
      : 'GET'
    await db
      .insertInto('monitors')
      .values({
        id: crypto.randomUUID(),
        workspace_id: wsId,
        name: String(mon.name ?? 'Monitor').slice(0, 160),
        method: validMethod,
        url: String(mon.url ?? ''),
        headers_json: JSON.stringify(Array.isArray(mon.headers) ? mon.headers : []),
        body_raw: mon.bodyRaw ? String(mon.bodyRaw) : null,
        expected_status: typeof mon.expectedStatus === 'number' ? mon.expectedStatus : 200,
        max_latency_ms: typeof mon.maxLatencyMs === 'number' ? mon.maxLatencyMs : 3000,
        interval_seconds: typeof mon.intervalSeconds === 'number' ? mon.intervalSeconds : 300,
        alert_webhook_url: mon.alertWebhookUrl ? String(mon.alertWebhookUrl) : null,
        enabled: mon.enabled === false ? 0 : 1,
        last_status: null,
        last_latency_ms: null,
        last_run_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()
    restoredMonitors += 1
  }

  await recordAuditLog(db, {
    workspaceId: wsId,
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'workspace.backup_restored',
    targetType: 'workspace',
    targetId: wsId,
    metadata: {
      collections: collectionIdMap.size,
      requests: restoredRequests,
      examples: restoredExamples,
      environments: restoredEnvironments,
      mockRoutes: restoredMocks,
      webhooks: restoredWebhooks,
      monitors: restoredMonitors,
    },
    ipAddress: c.get('clientIp'),
  })

  return c.json({
    ok: true,
    restored: {
      collections: collectionIdMap.size,
      folders: insertedFolders.size,
      requests: restoredRequests,
      examples: restoredExamples,
      environments: restoredEnvironments,
      mockRoutes: restoredMocks,
      webhooks: restoredWebhooks,
      monitors: restoredMonitors,
    },
  })
})
