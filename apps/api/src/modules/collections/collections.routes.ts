import crypto from 'node:crypto'
import {
  canWriteWorkspace,
  type CollectionRunItemResult,
  type CollectionRunSummary,
  collectionRunSchema,
  createCollectionSchema,
  createCommentSchema,
  createFolderSchema,
  extractConsumedVariablesFromText,
  extractProducedVariablesFromScript,
  type GraphqlPayloadConfig,
  HTTP_METHODS,
  type HttpMethod,
  type KeyValueItem,
  moveRequestSchema,
  type RequestAssertion,
  type RequestAuthConfig,
  type RequestBodyConfig,
  type RequestProtocol,
  type ResponseExampleItem,
  type ResponseVariableExtractor,
  saveRequestSchema,
  saveResponseExampleSchema,
  sortRequestsByDependencyDag,
  updateCollectionSchema,
  updateFolderSchema,
} from '@meofast/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { AppError } from '../../core/errors/app-error.js'
import {
  paginateServerArray,
  parseTableQuery,
  resolveSqlPageWindow,
  sqlTextLike,
} from '../../core/http/pagination.js'
import { requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'
import { recordAuditLog } from '../audit/audit.service.js'
import { exportCollectionStaticHtml } from '../docs/docs-generator.js'
import { executeSingleRequest } from '../proxy/request-runner.js'
import {
  exportBrunoDocument,
  exportHarDocument,
  exportInsomniaDocument,
  type NormalizedImportCollection,
  parseBrunoDocument,
  parseHarDocument,
  parseInsomniaDocument,
} from './format-converters.js'
import { exportOpenApiDocument, parseOpenApiDocument } from './openapi-converter.js'

export const collectionsRoutes = new Hono<AppEnv>()

collectionsRoutes.use('*', requireAuthMiddleware)

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function parseCurlCommand(curlRaw: string): {
  name: string
  method: HttpMethod
  url: string
  headers: KeyValueItem[]
  body: RequestBodyConfig
} {
  const cleaned = curlRaw.replace(/\\\r?\n/g, ' ').trim()
  const tokens: string[] = []
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g
  let match: RegExpExecArray | null = regex.exec(cleaned)
  while (match !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0])
    match = regex.exec(cleaned)
  }

  let method: HttpMethod = 'GET'
  let explicitMethod = false
  let url = ''
  const headers: KeyValueItem[] = []
  let rawBody = ''

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!
    if (t === 'curl') continue
    if ((t === '-X' || t === '--request') && tokens[i + 1]) {
      const candidate = tokens[i + 1]!.toUpperCase()
      if ((HTTP_METHODS as readonly string[]).includes(candidate)) {
        method = candidate as HttpMethod
        explicitMethod = true
      }
      i += 1
      continue
    }
    if ((t === '-H' || t === '--header') && tokens[i + 1]) {
      const headerStr = tokens[i + 1]!
      const idx = headerStr.indexOf(':')
      if (idx > 0) {
        headers.push({
          id: crypto.randomUUID(),
          key: headerStr.slice(0, idx).trim(),
          value: headerStr.slice(idx + 1).trim(),
          description: '',
          enabled: true,
        })
      }
      i += 1
      continue
    }
    if (
      (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') &&
      tokens[i + 1]
    ) {
      rawBody = tokens[i + 1]!
      if (!explicitMethod) method = 'POST'
      i += 1
      continue
    }
    if (
      !t.startsWith('-') &&
      (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('{{'))
    ) {
      url = t
    }
  }

  if (!url) {
    throw new AppError(400, 'INVALID_CURL', 'Could not locate a valid URL inside the cURL command.')
  }

  let mode: RequestBodyConfig['mode'] = 'none'
  if (rawBody) {
    try {
      JSON.parse(rawBody)
      mode = 'json'
    } catch {
      mode = 'text'
    }
  }

  let pathname = url
  try {
    pathname = new URL(url.replace(/\{\{[^}]+\}\}/g, 'https://placeholder.local')).pathname
  } catch {
    // keep raw
  }

  return {
    name: `${method} ${pathname || url}`.slice(0, 120),
    method,
    url,
    headers,
    body: {
      mode,
      raw: rawBody,
      urlencoded: [],
      multipart: [],
    },
  }
}

collectionsRoutes.get('/workspaces/:wsId/tree', async (c) => {
  const db = c.get('runtime').getDb()
  const wsId = c.req.param('wsId')

  const [collections, requests, exampleRows] = await Promise.all([
    db
      .selectFrom('collections')
      .selectAll()
      .where('workspace_id', '=', wsId)
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .execute(),
    db
      .selectFrom('saved_requests')
      .selectAll()
      .where('workspace_id', '=', wsId)
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .execute(),
    db
      .selectFrom('request_examples')
      .selectAll()
      .where('workspace_id', '=', wsId)
      .orderBy('created_at', 'asc')
      .execute(),
  ])

  const examplesByReqId = new Map<string, ResponseExampleItem[]>()
  for (const ex of exampleRows) {
    const list = examplesByReqId.get(ex.request_id) ?? []
    list.push({
      id: ex.id,
      requestId: ex.request_id,
      name: ex.name,
      statusCode: ex.status_code,
      statusText: ex.status_text,
      contentType: ex.content_type,
      headers: safeParseJson<Record<string, string>>(ex.headers_json, {}),
      body: ex.body,
      createdAt: ex.created_at,
    })
    examplesByReqId.set(ex.request_id, list)
  }

  const collectionIds = collections.map((col) => col.id)
  const folders =
    collectionIds.length > 0
      ? await db
          .selectFrom('collection_folders')
          .selectAll()
          .where('collection_id', 'in', collectionIds)
          .orderBy('sort_order', 'asc')
          .orderBy('created_at', 'asc')
          .execute()
      : []

  return c.json({
    collections: collections.map((col) => ({
      id: col.id,
      workspaceId: col.workspace_id,
      name: col.name,
      description: col.description ?? '',
      variables: safeParseJson<KeyValueItem[]>(col.variables_json, []),
      auth: safeParseJson<RequestAuthConfig>(col.auth_json, { type: 'none' }),
      headers: safeParseJson<KeyValueItem[]>(col.headers_json, []),
      folders: folders
        .filter((f) => f.collection_id === col.id)
        .map((f) => ({
          id: f.id,
          collectionId: f.collection_id,
          parentFolderId: f.parent_folder_id,
          name: f.name,
          description: f.description ?? '',
          variables: safeParseJson<KeyValueItem[]>(f.variables_json, []),
          auth: safeParseJson<RequestAuthConfig>(f.auth_json, { type: 'inherit' }),
          headers: safeParseJson<KeyValueItem[]>(f.headers_json, []),
        })),
      requests: requests
        .filter((r) => r.collection_id === col.id)
        .map((r) => ({
          id: r.id,
          workspaceId: r.workspace_id,
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
            binaryBase64: '',
            binaryFileName: '',
            binaryContentType: 'application/octet-stream',
          }),
          graphql: safeParseJson<GraphqlPayloadConfig>(r.graphql_json, {
            query: '',
            variables: '{}',
            operationName: '',
          }),
          assertions: safeParseJson<RequestAssertion[]>(r.assertions_json, []),
          postResponseVars: safeParseJson<ResponseVariableExtractor[]>(r.post_vars_json, []),
          examples: examplesByReqId.get(r.id) ?? [],
          preRequestScript: r.pre_request_script ?? '',
          testScript: r.test_script ?? '',
          jsonSchema: r.json_schema ?? '',
          sortOrder: r.sort_order,
          updatedAt: r.updated_at,
        })),
    })),
  })
})

collectionsRoutes.post('/workspaces/:wsId/collections', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot create collections.')
  }

  const parsed = createCollectionSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Collection name is required',
    )
  }

  const nowIso = new Date().toISOString()
  const id = crypto.randomUUID()

  await db
    .insertInto('collections')
    .values({
      id,
      workspace_id: wsId,
      name: parsed.data.name,
      description: parsed.data.description || null,
      variables_json: JSON.stringify(parsed.data.variables ?? []),
      auth_json: JSON.stringify(parsed.data.auth ?? { type: 'none' }),
      headers_json: JSON.stringify(parsed.data.headers ?? []),
      sort_order: 0,
      created_by: user.id,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  await recordAuditLog(db, {
    workspaceId: wsId,
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'collection.created',
    targetType: 'collection',
    targetId: id,
    metadata: { name: parsed.data.name },
    ipAddress: c.get('clientIp'),
  })

  return c.json(
    {
      collection: {
        id,
        workspaceId: wsId,
        name: parsed.data.name,
        description: parsed.data.description ?? '',
        variables: parsed.data.variables ?? [],
        auth: parsed.data.auth ?? { type: 'none' },
        headers: parsed.data.headers ?? [],
        folders: [],
        requests: [],
      },
    },
    201,
  )
})

collectionsRoutes.patch('/collections/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const colId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot update collections.')
  }

  const parsed = updateCollectionSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid collection update payload.')
  }

  const existing = await db
    .selectFrom('collections')
    .selectAll()
    .where('id', '=', colId)
    .executeTakeFirst()
  if (!existing) {
    throw new AppError(404, 'COLLECTION_NOT_FOUND', 'Collection not found.')
  }

  await db
    .updateTable('collections')
    .set({
      name: parsed.data.name ?? existing.name,
      description:
        parsed.data.description !== undefined ? parsed.data.description : existing.description,
      variables_json:
        parsed.data.variables !== undefined
          ? JSON.stringify(parsed.data.variables)
          : existing.variables_json,
      auth_json:
        parsed.data.auth !== undefined ? JSON.stringify(parsed.data.auth) : existing.auth_json,
      headers_json:
        parsed.data.headers !== undefined
          ? JSON.stringify(parsed.data.headers)
          : (existing.headers_json ?? '[]'),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', colId)
    .execute()

  return c.json({ ok: true })
})

collectionsRoutes.delete('/collections/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const colId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete collections.')
  }

  await db.deleteFrom('collections').where('id', '=', colId).execute()
  return c.json({ ok: true })
})

collectionsRoutes.post('/collections/:id/folders', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const colId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot create folders.')
  }

  const parsed = createFolderSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Folder name is required.')
  }

  const nowIso = new Date().toISOString()
  const id = crypto.randomUUID()

  await db
    .insertInto('collection_folders')
    .values({
      id,
      collection_id: colId,
      parent_folder_id: parsed.data.parentFolderId ?? null,
      name: parsed.data.name,
      description: parsed.data.description || null,
      variables_json: JSON.stringify(parsed.data.variables ?? []),
      auth_json: JSON.stringify(parsed.data.auth ?? { type: 'inherit' }),
      headers_json: JSON.stringify(parsed.data.headers ?? []),
      sort_order: 0,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  return c.json(
    {
      folder: {
        id,
        collectionId: colId,
        parentFolderId: parsed.data.parentFolderId ?? null,
        name: parsed.data.name,
        description: parsed.data.description ?? '',
        variables: parsed.data.variables ?? [],
        auth: parsed.data.auth ?? { type: 'inherit' },
        headers: parsed.data.headers ?? [],
      },
    },
    201,
  )
})

collectionsRoutes.patch('/folders/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const folderId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot update folders.')
  }

  const parsed = updateFolderSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid folder update payload.')
  }

  const existing = await db
    .selectFrom('collection_folders')
    .selectAll()
    .where('id', '=', folderId)
    .executeTakeFirst()
  if (!existing) {
    throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found.')
  }

  await db
    .updateTable('collection_folders')
    .set({
      name: parsed.data.name ?? existing.name,
      description:
        parsed.data.description !== undefined ? parsed.data.description : existing.description,
      variables_json:
        parsed.data.variables !== undefined
          ? JSON.stringify(parsed.data.variables)
          : existing.variables_json,
      auth_json:
        parsed.data.auth !== undefined
          ? JSON.stringify(parsed.data.auth)
          : (existing.auth_json ?? JSON.stringify({ type: 'inherit' })),
      headers_json:
        parsed.data.headers !== undefined
          ? JSON.stringify(parsed.data.headers)
          : (existing.headers_json ?? '[]'),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', folderId)
    .execute()

  return c.json({ ok: true })
})

collectionsRoutes.delete('/folders/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const folderId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete folders.')
  }

  await db
    .updateTable('saved_requests')
    .set({ folder_id: null })
    .where('folder_id', '=', folderId)
    .execute()
  await db
    .updateTable('collection_folders')
    .set({ parent_folder_id: null })
    .where('parent_folder_id', '=', folderId)
    .execute()
  await db.deleteFrom('collection_folders').where('id', '=', folderId).execute()
  return c.json({ ok: true })
})

collectionsRoutes.post('/requests', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot save requests.')
  }

  const parsed = saveRequestSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid request payload',
    )
  }

  const d = parsed.data
  const nowIso = new Date().toISOString()
  const id = crypto.randomUUID()

  await db
    .insertInto('saved_requests')
    .values({
      id,
      workspace_id: d.workspaceId,
      collection_id: d.collectionId,
      folder_id: d.folderId ?? null,
      name: d.name,
      description: d.description || null,
      method: d.method,
      url: d.url,
      query_params_json: JSON.stringify(d.queryParams),
      headers_json: JSON.stringify(d.headers),
      path_vars_json: JSON.stringify(d.pathVariables),
      auth_json: JSON.stringify(d.auth),
      body_json: JSON.stringify(d.body),
      assertions_json: JSON.stringify(d.assertions),
      post_vars_json: JSON.stringify(d.postResponseVars ?? []),
      pre_request_script: d.preRequestScript ?? '',
      test_script: d.testScript ?? '',
      json_schema: d.jsonSchema ?? '',
      protocol: d.protocol ?? 'http',
      graphql_json: JSON.stringify(d.graphql ?? { query: '', variables: '{}', operationName: '' }),
      sort_order: d.sortOrder ?? 0,
      created_by: user.id,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  return c.json({ id, updatedAt: nowIso }, 201)
})

collectionsRoutes.put('/requests/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const reqId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot modify saved requests.')
  }

  const parsed = saveRequestSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid request payload',
    )
  }

  const d = parsed.data
  const nowIso = new Date().toISOString()

  await db
    .updateTable('saved_requests')
    .set({
      collection_id: d.collectionId,
      folder_id: d.folderId ?? null,
      name: d.name,
      description: d.description || null,
      method: d.method,
      url: d.url,
      query_params_json: JSON.stringify(d.queryParams),
      headers_json: JSON.stringify(d.headers),
      path_vars_json: JSON.stringify(d.pathVariables),
      auth_json: JSON.stringify(d.auth),
      body_json: JSON.stringify(d.body),
      assertions_json: JSON.stringify(d.assertions),
      post_vars_json: JSON.stringify(d.postResponseVars ?? []),
      pre_request_script: d.preRequestScript ?? '',
      test_script: d.testScript ?? '',
      json_schema: d.jsonSchema ?? '',
      protocol: d.protocol ?? 'http',
      graphql_json: JSON.stringify(d.graphql ?? { query: '', variables: '{}', operationName: '' }),
      ...(d.sortOrder !== undefined ? { sort_order: d.sortOrder } : {}),
      updated_at: nowIso,
    })
    .where('id', '=', reqId)
    .execute()

  return c.json({ id: reqId, updatedAt: nowIso })
})

collectionsRoutes.patch('/requests/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const reqId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot rename saved requests.')
  }

  const schema = z.object({
    name: z.string().trim().min(1, 'Request name is required').max(200),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Request name is required.',
    )
  }

  const nowIso = new Date().toISOString()
  await db
    .updateTable('saved_requests')
    .set({
      name: parsed.data.name,
      updated_at: nowIso,
    })
    .where('id', '=', reqId)
    .execute()

  return c.json({ ok: true, id: reqId, name: parsed.data.name, updatedAt: nowIso })
})

collectionsRoutes.patch('/requests/:id/move', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const reqId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot reorder requests.')
  }

  const parsed = moveRequestSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid move payload.')
  }

  await db
    .updateTable('saved_requests')
    .set({
      collection_id: parsed.data.collectionId,
      folder_id: parsed.data.folderId ?? null,
      sort_order: parsed.data.sortOrder,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', reqId)
    .execute()

  return c.json({ ok: true })
})

collectionsRoutes.post('/requests/:id/duplicate', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const reqId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot duplicate requests.')
  }

  const source = await db
    .selectFrom('saved_requests')
    .selectAll()
    .where('id', '=', reqId)
    .executeTakeFirst()
  if (!source) {
    throw new AppError(404, 'REQUEST_NOT_FOUND', 'Request not found.')
  }

  const nowIso = new Date().toISOString()
  const copyId = crypto.randomUUID()

  await db
    .insertInto('saved_requests')
    .values({
      ...source,
      id: copyId,
      name: `${source.name} (Copy)`.slice(0, 200),
      sort_order: source.sort_order + 1,
      created_by: user.id,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  return c.json({ id: copyId }, 201)
})

collectionsRoutes.delete('/requests/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const reqId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete saved requests.')
  }

  await db.deleteFrom('saved_requests').where('id', '=', reqId).execute()
  return c.json({ ok: true })
})

// Sequential & Data-Driven Collection Runner
collectionsRoutes.post('/collections/:id/run', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()
  const user = c.get('user')!
  const colId = c.req.param('id')

  const parsed = collectionRunSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid collection runner payload.')
  }

  const col = await db
    .selectFrom('collections')
    .selectAll()
    .where('id', '=', colId)
    .executeTakeFirst()
  if (!col) {
    throw new AppError(404, 'COLLECTION_NOT_FOUND', 'Collection not found.')
  }

  let targetRequests = await db
    .selectFrom('saved_requests')
    .selectAll()
    .where('collection_id', '=', colId)
    .orderBy('sort_order', 'asc')
    .orderBy('created_at', 'asc')
    .execute()

  if (parsed.data.folderId) {
    const allFolders = await db
      .selectFrom('collection_folders')
      .select(['id', 'parent_folder_id'])
      .where('collection_id', '=', colId)
      .execute()

    const allowedFolders = new Set<string>([parsed.data.folderId])
    let added = true
    while (added) {
      added = false
      for (const f of allFolders) {
        if (f.parent_folder_id && allowedFolders.has(f.parent_folder_id) && !allowedFolders.has(f.id)) {
          allowedFolders.add(f.id)
          added = true
        }
      }
    }
    targetRequests = targetRequests.filter((r) => r.folder_id && allowedFolders.has(r.folder_id))
  }

  let reorderedByDependencies = false
  let hasDependencyCycle = false

  if (parsed.data.smartOrder !== false && targetRequests.length > 1) {
    const dagNodes = targetRequests.map((reqRow, originalIndex) => {
      const postVars = safeParseJson<ResponseVariableExtractor[]>(reqRow.post_vars_json, [])
      const producedVars = Array.from(
        new Set([
          ...postVars.filter((v) => v.enabled && v.varName.trim()).map((v) => v.varName.trim()),
          ...extractProducedVariablesFromScript(
            `${reqRow.pre_request_script ?? ''}\n${reqRow.test_script ?? ''}`,
          ),
        ]),
      )
      const consumedVars = extractConsumedVariablesFromText(
        [
          reqRow.url,
          reqRow.query_params_json,
          reqRow.headers_json,
          reqRow.path_vars_json,
          reqRow.auth_json,
          reqRow.body_json,
          reqRow.graphql_json ?? '',
        ].join(' '),
      )
      return {
        id: reqRow.id,
        originalIndex,
        producedVars,
        consumedVars,
        row: reqRow,
      }
    })

    const dagSorted = sortRequestsByDependencyDag(dagNodes)
    targetRequests = dagSorted.ordered.map((n) => n.row)
    reorderedByDependencies = dagSorted.reordered
    hasDependencyCycle = dagSorted.hasCycle
  }

  const rowsToIterate =
    parsed.data.dataRows && parsed.data.dataRows.length > 0 ? parsed.data.dataRows : [{}]

  const items: CollectionRunItemResult[] = []
  const runStartedAt = performance.now()
  let passedRequests = 0
  let failedRequests = 0
  let totalAssertions = 0
  let passedAssertions = 0
  let failedAssertions = 0

  for (let iterIdx = 0; iterIdx < rowsToIterate.length; iterIdx += 1) {
    const dataRow = rowsToIterate[iterIdx]!

    for (const reqRow of targetRequests) {
      if (parsed.data.delayMs > 0 && items.length > 0) {
        await new Promise((r) => setTimeout(r, Math.min(parsed.data.delayMs, 5000)))
      }

      const itemStart = performance.now()
      try {
        const res = await executeSingleRequest(
          runtime,
          user.id,
          {
            workspaceId: col.workspace_id,
            environmentId: parsed.data.environmentId ?? null,
            collectionId: col.id,
            folderId: reqRow.folder_id,
            savedRequestId: reqRow.id,
            protocol: ((reqRow.protocol as RequestProtocol | null) ?? 'http') as RequestProtocol,
            method: reqRow.method,
            url: reqRow.url,
            queryParams: safeParseJson<KeyValueItem[]>(reqRow.query_params_json, []),
            headers: safeParseJson<KeyValueItem[]>(reqRow.headers_json, []),
            pathVariables: safeParseJson<KeyValueItem[]>(reqRow.path_vars_json, []),
            auth: safeParseJson<RequestAuthConfig>(reqRow.auth_json, { type: 'none' }),
            body: safeParseJson<RequestBodyConfig>(reqRow.body_json, {
              mode: 'none',
              raw: '',
              urlencoded: [],
              multipart: [],
              binaryBase64: '',
              binaryFileName: '',
              binaryContentType: 'application/octet-stream',
            }),
            graphql: safeParseJson<GraphqlPayloadConfig>(reqRow.graphql_json, {
              query: '',
              variables: '{}',
              operationName: '',
            }),
            assertions: safeParseJson<RequestAssertion[]>(reqRow.assertions_json, []),
            postResponseVars: safeParseJson<ResponseVariableExtractor[]>(
              reqRow.post_vars_json,
              [],
            ),
            preRequestScript: reqRow.pre_request_script ?? '',
            testScript: reqRow.test_script ?? '',
            jsonSchema: reqRow.json_schema ?? '',
            timeoutMs: 25000,
            followRedirects: true,
          },
          Object.keys(dataRow).length > 0 ? dataRow : undefined,
        )

        const reqFailed = res.assertions.some((a) => !a.passed)
        if (reqFailed) failedRequests += 1
        else passedRequests += 1

        for (const a of res.assertions) {
          totalAssertions += 1
          if (a.passed) passedAssertions += 1
          else failedAssertions += 1
        }

        items.push({
          iteration: iterIdx + 1,
          requestId: reqRow.id,
          requestName: reqRow.name,
          method: reqRow.method,
          resolvedUrl: res.resolvedUrl,
          status: res.status,
          durationMs: res.durationMs,
          passed: !reqFailed,
          assertions: res.assertions,
        })
      } catch (err) {
        failedRequests += 1
        items.push({
          iteration: iterIdx + 1,
          requestId: reqRow.id,
          requestName: reqRow.name,
          method: reqRow.method,
          resolvedUrl: reqRow.url,
          status: null,
          durationMs: Math.round(performance.now() - itemStart),
          passed: false,
          error: err instanceof Error ? err.message : 'Request execution failed',
          assertions: [],
        })
      }
    }
  }

  const summary: CollectionRunSummary = {
    collectionId: col.id,
    collectionName: col.name,
    iterations: rowsToIterate.length,
    totalRequests: items.length,
    passedRequests,
    failedRequests,
    totalAssertions,
    passedAssertions,
    failedAssertions,
    totalDurationMs: Math.round(performance.now() - runStartedAt),
    reorderedByDependencies,
    hasDependencyCycle,
    items,
  }

  return c.json(summary)
})

collectionsRoutes.post('/workspaces/:wsId/collections/import', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot import collections.')
  }

  const schema = z.object({
    mode: z.enum(['curl', 'json', 'openapi', 'har', 'insomnia', 'bruno']),
    content: z.string().min(1),
    targetCollectionId: z.string().optional(),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Provide import mode and content.')
  }

  const nowIso = new Date().toISOString()

  const persistNormalizedCollection = async (norm: NormalizedImportCollection) => {
    const collectionId = crypto.randomUUID()
    await db
      .insertInto('collections')
      .values({
        id: collectionId,
        workspace_id: wsId,
        name: norm.name,
        description: norm.description || null,
        variables_json: '[]',
        auth_json: JSON.stringify({ type: 'none' }),
        sort_order: 0,
        created_by: user.id,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()

    const folderMap = new Map<string, string>()
    for (let i = 0; i < norm.folders.length; i += 1) {
      const f = norm.folders[i]!
      const fid = crypto.randomUUID()
      folderMap.set(f.tempId, fid)
      await db
        .insertInto('collection_folders')
        .values({
          id: fid,
          collection_id: collectionId,
          parent_folder_id: null,
          name: f.name,
          description: null,
          variables_json: '[]',
          sort_order: i,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .execute()
    }

    for (let i = 0; i < norm.requests.length; i += 1) {
      const r = norm.requests[i]!
      await db
        .insertInto('saved_requests')
        .values({
          id: crypto.randomUUID(),
          workspace_id: wsId,
          collection_id: collectionId,
          folder_id: r.folderTempId ? (folderMap.get(r.folderTempId) ?? null) : null,
          name: r.name,
          description: r.description || null,
          method: r.method,
          url: r.url,
          query_params_json: JSON.stringify(r.queryParams),
          headers_json: JSON.stringify(r.headers),
          path_vars_json: '[]',
          auth_json: JSON.stringify({ type: 'none' }),
          body_json: JSON.stringify(r.body),
          assertions_json: '[]',
          pre_request_script: '',
          test_script: '',
          json_schema: '',
          protocol: 'http',
          graphql_json: null,
          sort_order: i,
          created_by: user.id,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .execute()
    }
    return collectionId
  }

  if (parsed.data.mode === 'bruno') {
    const colId = await persistNormalizedCollection(parseBrunoDocument(parsed.data.content))
    return c.json({ importedCollectionId: colId }, 201)
  }

  if (parsed.data.mode === 'curl') {
    const curlParsed = parseCurlCommand(parsed.data.content)
    let collectionId = parsed.data.targetCollectionId
    if (!collectionId) {
      const firstCol = await db
        .selectFrom('collections')
        .select('id')
        .where('workspace_id', '=', wsId)
        .orderBy('created_at', 'asc')
        .limit(1)
        .executeTakeFirst()

      if (firstCol) {
        collectionId = firstCol.id
      } else {
        collectionId = crypto.randomUUID()
        await db
          .insertInto('collections')
          .values({
            id: collectionId,
            workspace_id: wsId,
            name: 'Imported Requests',
            description: null,
            variables_json: '[]',
            auth_json: JSON.stringify({ type: 'none' }),
            sort_order: 0,
            created_by: user.id,
            created_at: nowIso,
            updated_at: nowIso,
          })
          .execute()
      }
    }

    const reqId = crypto.randomUUID()
    await db
      .insertInto('saved_requests')
      .values({
        id: reqId,
        workspace_id: wsId,
        collection_id: collectionId,
        folder_id: null,
        name: curlParsed.name,
        description: null,
        protocol: 'http',
        method: curlParsed.method,
        url: curlParsed.url,
        query_params_json: '[]',
        headers_json: JSON.stringify(curlParsed.headers),
        path_vars_json: '[]',
        auth_json: JSON.stringify({ type: 'none' }),
        body_json: JSON.stringify(curlParsed.body),
        graphql_json: null,
        assertions_json: '[]',
        pre_request_script: '',
        test_script: '',
        json_schema: '',
        sort_order: 0,
        created_by: user.id,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()

    return c.json({ importedCollectionId: collectionId, importedRequestId: reqId }, 201)
  }

  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(parsed.data.content) as Record<string, unknown>
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Import content is not valid JSON.')
  }

  if (parsed.data.mode === 'har' || typeof doc.log === 'object') {
    const colId = await persistNormalizedCollection(parseHarDocument(doc))
    return c.json({ importedCollectionId: colId }, 201)
  }

  if (parsed.data.mode === 'insomnia' || doc._type === 'export') {
    const colId = await persistNormalizedCollection(parseInsomniaDocument(doc))
    return c.json({ importedCollectionId: colId }, 201)
  }

  // Auto-detect OpenAPI / Swagger even if user selected 'json', or when mode === 'openapi'
  const isOpenApi =
    parsed.data.mode === 'openapi' ||
    typeof doc.openapi === 'string' ||
    typeof doc.swagger === 'string'

  if (isOpenApi) {
    const parsedSpec = parseOpenApiDocument(doc)
    const collectionId = crypto.randomUUID()

    await db
      .insertInto('collections')
      .values({
        id: collectionId,
        workspace_id: wsId,
        name: parsedSpec.name,
        description: parsedSpec.description || null,
        variables_json: JSON.stringify(parsedSpec.variables),
        auth_json: JSON.stringify({ type: 'none' }),
        sort_order: 0,
        created_by: user.id,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()

    const folderMap = new Map<string, string>()
    for (let i = 0; i < parsedSpec.folders.length; i += 1) {
      const f = parsedSpec.folders[i]!
      const dbFolderId = crypto.randomUUID()
      folderMap.set(f.tempId, dbFolderId)
      await db
        .insertInto('collection_folders')
        .values({
          id: dbFolderId,
          collection_id: collectionId,
          parent_folder_id: null,
          name: f.name,
          description: null,
          variables_json: '[]',
          sort_order: i,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .execute()
    }

    for (let i = 0; i < parsedSpec.requests.length; i += 1) {
      const r = parsedSpec.requests[i]!
      await db
        .insertInto('saved_requests')
        .values({
          id: crypto.randomUUID(),
          workspace_id: wsId,
          collection_id: collectionId,
          folder_id: r.folderTempId ? (folderMap.get(r.folderTempId) ?? null) : null,
          name: r.name,
          description: r.description || null,
          method: r.method,
          url: r.url,
          query_params_json: JSON.stringify(r.queryParams),
          headers_json: JSON.stringify(r.headers),
          path_vars_json: JSON.stringify(r.pathVariables),
          auth_json: JSON.stringify({ type: 'none' }),
          body_json: JSON.stringify(r.body),
          assertions_json: JSON.stringify([
            {
              id: crypto.randomUUID(),
              type: 'status_in_2xx',
              target: '',
              expected: '200-299',
              enabled: true,
            },
          ]),
          pre_request_script: '',
          test_script: '',
          json_schema: '',
          protocol: 'http',
          graphql_json: null,
          sort_order: i,
          created_by: user.id,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .execute()
    }

    return c.json({ importedCollectionId: collectionId }, 201)
  }

  // Postman Collection v2.1 or Meofast Native JSON
  const info = (doc.info ?? {}) as { name?: string; description?: string }
  const collectionName = String(info.name ?? doc.name ?? 'Imported Collection').slice(0, 180)
  const collectionId = crypto.randomUUID()

  await db
    .insertInto('collections')
    .values({
      id: collectionId,
      workspace_id: wsId,
      name: collectionName,
      description: String(info.description ?? doc.description ?? '') || null,
      variables_json: '[]',
      auth_json: JSON.stringify({ type: 'none' }),
      sort_order: 0,
      created_by: user.id,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute()

  interface PostmanItem {
    name?: string
    item?: PostmanItem[]
    request?: {
      method?: string
      header?: Array<{ key?: string; value?: string; disabled?: boolean }>
      url?: string | { raw?: string }
      body?: { mode?: string; raw?: string }
    }
    method?: string
    url?: string
    headers?: KeyValueItem[]
    body?: RequestBodyConfig
  }

  let orderCounter = 0
  const walkItems = async (items: PostmanItem[], parentFolderId: string | null) => {
    for (const item of items) {
      if (Array.isArray(item.item)) {
        const folderId = crypto.randomUUID()
        await db
          .insertInto('collection_folders')
          .values({
            id: folderId,
            collection_id: collectionId,
            parent_folder_id: parentFolderId,
            name: String(item.name ?? 'Folder').slice(0, 180),
            description: null,
            variables_json: '[]',
            sort_order: orderCounter++,
            created_at: nowIso,
            updated_at: nowIso,
          })
          .execute()
        await walkItems(item.item, folderId)
      } else if (item.request) {
        const pmReq = item.request
        const rawMethod = String(pmReq.method ?? 'GET').toUpperCase()
        const method: HttpMethod = (HTTP_METHODS as readonly string[]).includes(rawMethod)
          ? (rawMethod as HttpMethod)
          : 'GET'
        const rawUrl =
          typeof pmReq.url === 'string'
            ? pmReq.url
            : String(pmReq.url?.raw ?? 'https://example.com')
        const headers: KeyValueItem[] = (pmReq.header ?? []).map((h) => ({
          id: crypto.randomUUID(),
          key: String(h.key ?? ''),
          value: String(h.value ?? ''),
          description: '',
          enabled: !h.disabled,
        }))
        const rawBody = String(pmReq.body?.raw ?? '')
        let bodyMode: RequestBodyConfig['mode'] = 'none'
        if (rawBody) {
          try {
            JSON.parse(rawBody)
            bodyMode = 'json'
          } catch {
            bodyMode = 'text'
          }
        }
        await db
          .insertInto('saved_requests')
          .values({
            id: crypto.randomUUID(),
            workspace_id: wsId,
            collection_id: collectionId,
            folder_id: parentFolderId,
            name: String(item.name ?? `${method} Request`).slice(0, 180),
            description: null,
            method,
            url: rawUrl,
            query_params_json: '[]',
            headers_json: JSON.stringify(headers),
            path_vars_json: '[]',
            auth_json: JSON.stringify({ type: 'none' }),
            body_json: JSON.stringify({
              mode: bodyMode,
              raw: rawBody,
              urlencoded: [],
              multipart: [],
            }),
            assertions_json: '[]',
            pre_request_script: '',
            test_script: '',
            json_schema: '',
            protocol: 'http',
            graphql_json: null,
            sort_order: orderCounter++,
            created_by: user.id,
            created_at: nowIso,
            updated_at: nowIso,
          })
          .execute()
      } else if (item.url && item.method) {
        const rawMethod = String(item.method).toUpperCase()
        const method: HttpMethod = (HTTP_METHODS as readonly string[]).includes(rawMethod)
          ? (rawMethod as HttpMethod)
          : 'GET'
        await db
          .insertInto('saved_requests')
          .values({
            id: crypto.randomUUID(),
            workspace_id: wsId,
            collection_id: collectionId,
            folder_id: parentFolderId,
            name: String(item.name ?? `${method} Request`).slice(0, 180),
            description: null,
            method,
            url: item.url,
            query_params_json: '[]',
            headers_json: JSON.stringify(item.headers ?? []),
            path_vars_json: '[]',
            auth_json: JSON.stringify({ type: 'none' }),
            body_json: JSON.stringify(
              item.body ?? { mode: 'none', raw: '', urlencoded: [], multipart: [] },
            ),
            assertions_json: '[]',
            pre_request_script: '',
            test_script: '',
            json_schema: '',
            protocol: 'http',
            graphql_json: null,
            sort_order: orderCounter++,
            created_by: user.id,
            created_at: nowIso,
            updated_at: nowIso,
          })
          .execute()
      }
    }
  }

  const rootItems = Array.isArray(doc.item)
    ? (doc.item as PostmanItem[])
    : Array.isArray(doc.requests)
      ? (doc.requests as PostmanItem[])
      : []

  await walkItems(rootItems, null)

  return c.json({ importedCollectionId: collectionId }, 201)
})

collectionsRoutes.get('/collections/:id/export', async (c) => {
  const db = c.get('runtime').getDb()
  const colId = c.req.param('id')
  const format = c.req.query('format') ?? 'postman'

  const col = await db
    .selectFrom('collections')
    .selectAll()
    .where('id', '=', colId)
    .executeTakeFirst()

  if (!col) {
    throw new AppError(404, 'COLLECTION_NOT_FOUND', 'Collection not found.')
  }

  const requests = await db
    .selectFrom('saved_requests')
    .selectAll()
    .where('collection_id', '=', colId)
    .orderBy('sort_order', 'asc')
    .execute()

  const mappedReqs = requests.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    protocol: r.protocol ?? 'http',
    method: r.method,
    url: r.url,
    queryParams: safeParseJson<KeyValueItem[]>(r.query_params_json, []),
    headers: safeParseJson<KeyValueItem[]>(r.headers_json, []),
    pathVariables: safeParseJson<KeyValueItem[]>(r.path_vars_json, []),
    body: safeParseJson<RequestBodyConfig>(r.body_json, {
      mode: 'none',
      raw: '',
      urlencoded: [],
      multipart: [],
      binaryBase64: '',
      binaryFileName: '',
      binaryContentType: 'application/octet-stream',
    }),
    jsonSchema: r.json_schema ?? '',
    folderId: r.folder_id,
  }))

  if (format === 'openapi') {
    const openApiDoc = exportOpenApiDocument({
      name: col.name,
      description: col.description ?? '',
      requests: mappedReqs,
    })
    return c.json(openApiDoc)
  }

  if (format === 'har') {
    return c.json(exportHarDocument({ name: col.name, requests: mappedReqs }))
  }

  if (format === 'insomnia') {
    return c.json(
      exportInsomniaDocument({
        id: col.id,
        name: col.name,
        description: col.description ?? '',
        requests: mappedReqs,
      }),
    )
  }

  if (format === 'bruno') {
    return c.json({
      filename: `${col.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.bru`,
      content: exportBrunoDocument({ name: col.name, requests: mappedReqs }),
    })
  }

  if (format === 'native') {
    return c.json({
      format: 'meofast.collection.v1',
      name: col.name,
      description: col.description ?? '',
      variables: safeParseJson<KeyValueItem[]>(col.variables_json, []),
      requests: mappedReqs.map((r) => ({
        name: r.name,
        description: r.description,
        protocol: r.protocol,
        method: r.method,
        url: r.url,
        headers: r.headers,
        queryParams: r.queryParams,
        body: r.body,
        jsonSchema: r.jsonSchema,
      })),
    })
  }

  if (format === 'html') {
    const folders = await db
      .selectFrom('collection_folders')
      .select(['id', 'name'])
      .where('collection_id', '=', colId)
      .execute()
    const folderById = new Map(folders.map((f) => [f.id, f.name]))

    const html = exportCollectionStaticHtml({
      name: col.name,
      description: col.description ?? '',
      endpoints: mappedReqs.map((r) => ({
        id: r.id,
        folderName: r.folderId ? (folderById.get(r.folderId) ?? null) : null,
        name: r.name,
        description: r.description,
        protocol: r.protocol,
        method: r.method,
        url: r.url,
        headers: r.headers,
        queryParams: r.queryParams,
        pathVariables: r.pathVariables,
        body: r.body,
        jsonSchema: r.jsonSchema,
      })),
    })
    return c.html(html)
  }

  const postmanCollection = {
    info: {
      _postman_id: col.id,
      name: col.name,
      description: col.description ?? '',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: mappedReqs.map((r) => ({
      name: r.name,
      request: {
        method: r.method,
        header: r.headers.map((h) => ({
          key: h.key,
          value: h.value,
          disabled: !h.enabled,
        })),
        url: { raw: r.url },
        body:
          r.body.mode === 'none'
            ? undefined
            : {
                mode: 'raw',
                raw: r.body.raw ?? '',
              },
      },
    })),
  }

  return c.json(postmanCollection)
})

// Request Collaboration Comments
collectionsRoutes.get('/requests/:id/comments', async (c) => {
  const db = c.get('runtime').getDb()
  const reqId = c.req.param('id')

  const rows = await db
    .selectFrom('request_comments')
    .selectAll()
    .where('request_id', '=', reqId)
    .orderBy('created_at', 'asc')
    .execute()

  return c.json({
    comments: rows.map((r) => ({
      id: r.id,
      requestId: r.request_id,
      authorId: r.author_id,
      authorName: r.author_name,
      body: r.body,
      createdAt: r.created_at,
    })),
  })
})

collectionsRoutes.post('/requests/:id/comments', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const reqId = c.req.param('id')

  const parsed = createCommentSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Comment body is required.')
  }

  const reqRow = await db
    .selectFrom('saved_requests')
    .select(['id', 'workspace_id'])
    .where('id', '=', reqId)
    .executeTakeFirst()
  if (!reqRow) {
    throw new AppError(404, 'REQUEST_NOT_FOUND', 'Saved request not found.')
  }

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  await db
    .insertInto('request_comments')
    .values({
      id,
      workspace_id: reqRow.workspace_id,
      request_id: reqId,
      author_id: user.id,
      author_name: user.fullName,
      body: parsed.data.body,
      created_at: createdAt,
    })
    .execute()

  return c.json(
    {
      comment: {
        id,
        requestId: reqId,
        authorId: user.id,
        authorName: user.fullName,
        body: parsed.data.body,
        createdAt,
      },
    },
    201,
  )
})

collectionsRoutes.delete('/comments/:commentId', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const commentId = c.req.param('commentId')

  const row = await db
    .selectFrom('request_comments')
    .select(['id', 'author_id'])
    .where('id', '=', commentId)
    .executeTakeFirst()
  if (!row) return c.json({ ok: true })

  if (row.author_id !== user.id && !canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Cannot delete another user comment.')
  }

  await db.deleteFrom('request_comments').where('id', '=', commentId).execute()
  return c.json({ ok: true })
})

// ============================================================================
// Saved Response Examples (200 OK, 400 Bad Request, 401 Unauthorized, etc.)
// ============================================================================

collectionsRoutes.get('/requests/:id/examples', async (c) => {
  const db = c.get('runtime').getDb()
  const reqId = c.req.param('id')
  const tq = parseTableQuery(c, 10)

  let baseQuery = db.selectFrom('request_examples').where('request_id', '=', reqId)
  for (const tk of tq.tokens) {
    const maybeCode = Number(tk)
    if (!Number.isNaN(maybeCode) && /^\d{3}$/.test(tk)) {
      baseQuery = baseQuery.where((eb) =>
        eb.or([
          eb('status_code', '=', maybeCode),
          sqlTextLike('name', tk),
          sqlTextLike('status_text', tk),
          sqlTextLike('content_type', tk),
        ]),
      )
    } else {
      baseQuery = baseQuery.where((eb) =>
        eb.or([
          sqlTextLike('name', tk),
          sqlTextLike('status_text', tk),
          sqlTextLike('content_type', tk),
        ]),
      )
    }
  }

  const countRow = await baseQuery
    .select((eb) => eb.fn.count<number>('id').as('total'))
    .executeTakeFirst()
  const total = Number(countRow?.total ?? 0)

  const sortMap: Record<string, 'name' | 'status_code' | 'content_type' | 'created_at'> = {
    name: 'name',
    status: 'status_code',
    contentType: 'content_type',
    createdAt: 'created_at',
  }
  const sortCol = (tq.sortBy && sortMap[tq.sortBy]) || 'created_at'
  const sortDir = tq.sortBy ? tq.sortDir : 'asc'

  const { safePage, safeOffset } = resolveSqlPageWindow(total, tq.page, tq.pageSize)
  let listQuery = baseQuery.selectAll().orderBy(sortCol, sortDir)
  if (tq.hasPaginationParams) {
    listQuery = listQuery.limit(tq.pageSize).offset(safeOffset)
  }

  const rows = await listQuery.execute()
  const mapped = rows.map((ex) => ({
    id: ex.id,
    requestId: ex.request_id,
    name: ex.name,
    statusCode: ex.status_code,
    statusText: ex.status_text,
    contentType: ex.content_type,
    headers: safeParseJson<Record<string, string>>(ex.headers_json, {}),
    body: ex.body,
    createdAt: ex.created_at,
  }))

  return c.json({
    examples: mapped,
    items: mapped,
    total,
    page: safePage,
    pageSize: tq.pageSize,
  })
})

collectionsRoutes.get('/requests/:id/doc-items', async (c) => {
  const db = c.get('runtime').getDb()
  const reqId = c.req.param('id')
  const kind = c.req.query('kind') === 'headers' ? 'headers' : 'params'
  const tq = parseTableQuery(c, 5)

  const reqRow = await db
    .selectFrom('saved_requests')
    .select(['id', 'query_params_json', 'path_vars_json', 'headers_json'])
    .where('id', '=', reqId)
    .executeTakeFirst()
  if (!reqRow) {
    throw new AppError(404, 'REQUEST_NOT_FOUND', 'Saved request not found.')
  }

  const items =
    kind === 'headers'
      ? safeParseJson<KeyValueItem[]>(reqRow.headers_json, []).filter((h) => h.enabled && h.key)
      : [
          ...safeParseJson<KeyValueItem[]>(reqRow.path_vars_json, []),
          ...safeParseJson<KeyValueItem[]>(reqRow.query_params_json, []),
        ].filter((p) => p.enabled && p.key)

  return c.json(
    paginateServerArray(items, tq, {
      getSearchText: (item) => `${item.key} ${item.value}`,
      sortExtractors: {
        key: (item) => item.key,
        value: (item) => item.value,
      },
    }),
  )
})

collectionsRoutes.post('/requests/:id/examples', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const reqId = c.req.param('id')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot save response examples.')
  }

  const parsed = saveResponseExampleSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Example name is required.',
    )
  }

  const reqRow = await db
    .selectFrom('saved_requests')
    .select(['id', 'workspace_id'])
    .where('id', '=', reqId)
    .executeTakeFirst()
  if (!reqRow) {
    throw new AppError(404, 'REQUEST_NOT_FOUND', 'Saved request not found.')
  }

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const d = parsed.data

  await db
    .insertInto('request_examples')
    .values({
      id,
      workspace_id: reqRow.workspace_id,
      request_id: reqId,
      name: d.name,
      status_code: d.statusCode,
      status_text: d.statusText || 'OK',
      content_type: d.contentType || 'application/json',
      headers_json: JSON.stringify(d.headers ?? {}),
      body: d.body ?? '',
      created_at: createdAt,
    })
    .execute()

  return c.json(
    {
      example: {
        id,
        requestId: reqId,
        name: d.name,
        statusCode: d.statusCode,
        statusText: d.statusText || 'OK',
        contentType: d.contentType || 'application/json',
        headers: d.headers ?? {},
        body: d.body ?? '',
        createdAt,
      },
    },
    201,
  )
})

collectionsRoutes.patch('/examples/:exampleId', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const exampleId = c.req.param('exampleId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot rename response examples.')
  }

  const schema = z.object({
    name: z.string().trim().min(1, 'Example name is required').max(160),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Example name is required.',
    )
  }

  await db
    .updateTable('request_examples')
    .set({ name: parsed.data.name })
    .where('id', '=', exampleId)
    .execute()

  return c.json({ ok: true, id: exampleId, name: parsed.data.name })
})

collectionsRoutes.delete('/examples/:exampleId', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const exampleId = c.req.param('exampleId')

  if (!canWriteWorkspace(
      user.globalRole,
      null,
      user.permissions,
      c.req.path.includes('/requests') ||
        c.req.path.includes('/examples') ||
        c.req.path.includes('/comments')
        ? 'requests'
        : 'collections',
      c.req.method === 'POST' ? 'create' : c.req.method === 'DELETE' ? 'delete' : 'update',
    )) {
    throw new AppError(403, 'FORBIDDEN', 'Viewers cannot delete response examples.')
  }

  await db.deleteFrom('request_examples').where('id', '=', exampleId).execute()
  return c.json({ ok: true })
})
