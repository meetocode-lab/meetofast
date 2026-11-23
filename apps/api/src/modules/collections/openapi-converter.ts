import crypto from 'node:crypto'
import {
  HTTP_METHODS,
  type HttpMethod,
  type KeyValueItem,
  type RequestBodyConfig,
} from '@meofast/shared'

interface OpenApiParameter {
  name?: string
  in?: 'query' | 'header' | 'path' | 'cookie'
  required?: boolean
  description?: string
  schema?: { type?: string; default?: unknown; example?: unknown }
}

interface OpenApiSchema {
  type?: string
  example?: unknown
  default?: unknown
  properties?: Record<string, OpenApiSchema>
  items?: OpenApiSchema
}

interface OpenApiOperation {
  summary?: string
  operationId?: string
  description?: string
  tags?: string[]
  parameters?: OpenApiParameter[]
  requestBody?: {
    content?: Record<
      string,
      {
        example?: unknown
        schema?: OpenApiSchema
      }
    >
  }
}

export interface ParsedOpenApiCollection {
  name: string
  description: string
  variables: KeyValueItem[]
  folders: Array<{ tempId: string; name: string }>
  requests: Array<{
    folderTempId: string | null
    name: string
    description: string
    method: HttpMethod
    url: string
    queryParams: KeyValueItem[]
    headers: KeyValueItem[]
    pathVariables: KeyValueItem[]
    body: RequestBodyConfig
  }>
}

function buildSampleFromSchema(schema: OpenApiSchema | undefined, depth = 0): unknown {
  if (!schema || depth > 4) return {}
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default

  switch (schema.type) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return true
    case 'array':
      return [buildSampleFromSchema(schema.items, depth + 1)]
    case 'object':
    default: {
      if (schema.properties) {
        const out: Record<string, unknown> = {}
        for (const [k, prop] of Object.entries(schema.properties)) {
          out[k] = buildSampleFromSchema(prop, depth + 1)
        }
        return out
      }
      return {}
    }
  }
}

export function parseOpenApiDocument(doc: Record<string, unknown>): ParsedOpenApiCollection {
  const info = (doc.info ?? {}) as { title?: string; description?: string }
  const servers = Array.isArray(doc.servers) ? (doc.servers as Array<{ url?: string }>) : []
  const swaggerHost = typeof doc.host === 'string' ? doc.host : ''
  const swaggerBasePath = typeof doc.basePath === 'string' ? doc.basePath : ''
  const defaultServerUrl =
    servers[0]?.url ||
    (swaggerHost ? `https://${swaggerHost}${swaggerBasePath}` : 'https://api.example.com')

  const variables: KeyValueItem[] = [
    {
      id: crypto.randomUUID(),
      key: 'baseUrl',
      value: defaultServerUrl.replace(/\/$/, ''),
      description: 'Base server URL from OpenAPI spec',
      enabled: true,
    },
  ]

  const folderByTag = new Map<string, string>()
  const folders: Array<{ tempId: string; name: string }> = []
  const requests: ParsedOpenApiCollection['requests'] = []

  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue
    const pathLevelParams = Array.isArray(pathItem.parameters)
      ? (pathItem.parameters as OpenApiParameter[])
      : []

    for (const [verbLower, rawOp] of Object.entries(pathItem)) {
      const upper = verbLower.toUpperCase()
      if (!(HTTP_METHODS as readonly string[]).includes(upper)) continue
      if (!rawOp || typeof rawOp !== 'object') continue

      const method = upper as HttpMethod
      const op = rawOp as OpenApiOperation
      const tag = op.tags?.[0]?.trim()
      let folderTempId: string | null = null

      if (tag) {
        if (!folderByTag.has(tag)) {
          const id = crypto.randomUUID()
          folderByTag.set(tag, id)
          folders.push({ tempId: id, name: tag })
        }
        folderTempId = folderByTag.get(tag) ?? null
      }

      // Convert /users/{id} -> /users/:id
      const convertedPath = rawPath.replace(/\{([^}]+)\}/g, ':$1')
      const allParams = [...pathLevelParams, ...(op.parameters ?? [])]

      const queryParams: KeyValueItem[] = []
      const headers: KeyValueItem[] = []
      const pathVariables: KeyValueItem[] = []

      for (const p of allParams) {
        if (!p.name) continue
        const sampleVal = String(p.schema?.example ?? p.schema?.default ?? '')
        const item: KeyValueItem = {
          id: crypto.randomUUID(),
          key: p.name,
          value: sampleVal,
          description: p.description ?? '',
          enabled: Boolean(p.required ?? p.in === 'path'),
        }
        if (p.in === 'query') queryParams.push(item)
        else if (p.in === 'header') headers.push(item)
        else if (p.in === 'path') pathVariables.push(item)
      }

      let body: RequestBodyConfig = {
        mode: 'none',
        raw: '',
        urlencoded: [],
        multipart: [],
      }

      const jsonMedia = op.requestBody?.content?.['application/json']
      if (jsonMedia) {
        const sample =
          jsonMedia.example !== undefined
            ? jsonMedia.example
            : buildSampleFromSchema(jsonMedia.schema)
        body = {
          mode: 'json',
          raw: JSON.stringify(sample, null, 2),
          urlencoded: [],
          multipart: [],
        }
        headers.push({
          id: crypto.randomUUID(),
          key: 'Content-Type',
          value: 'application/json',
          description: '',
          enabled: true,
        })
      }

      requests.push({
        folderTempId,
        name: (op.summary || op.operationId || `${method} ${rawPath}`).slice(0, 180),
        description: op.description ?? '',
        method,
        url: `{{baseUrl}}${convertedPath.startsWith('/') ? convertedPath : `/${convertedPath}`}`,
        queryParams,
        headers,
        pathVariables,
        body,
      })
    }
  }

  return {
    name: String(info.title || 'OpenAPI Collection').slice(0, 180),
    description: String(info.description || ''),
    variables,
    folders,
    requests,
  }
}

export function exportOpenApiDocument(input: {
  name: string
  description: string
  requests: Array<{
    name: string
    description: string
    method: HttpMethod
    url: string
    queryParams: KeyValueItem[]
    headers: KeyValueItem[]
    body: RequestBodyConfig
  }>
}): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const r of input.requests) {
    let pathKey = r.url.replace(/^\{\{[^}]+\}\}/, '')
    try {
      if (/^https?:\/\//i.test(pathKey)) {
        pathKey = new URL(pathKey).pathname
      }
    } catch {
      // keep raw
    }
    if (!pathKey.startsWith('/')) pathKey = `/${pathKey}`
    // Convert :id -> {id}
    const openApiPath = pathKey.replace(/:([a-zA-Z_][a-zA-Z0-9_-]*)/g, '{$1}')

    if (!paths[openApiPath]) paths[openApiPath] = {}

    const parameters = [
      ...r.queryParams
        .filter((q) => q.key.trim())
        .map((q) => ({
          name: q.key,
          in: 'query',
          required: q.enabled,
          schema: { type: 'string', example: q.value },
        })),
      ...r.headers
        .filter((h) => h.key.trim() && h.key.toLowerCase() !== 'content-type')
        .map((h) => ({
          name: h.key,
          in: 'header',
          required: false,
          schema: { type: 'string', example: h.value },
        })),
    ]

    let requestBody: Record<string, unknown> | undefined
    if (r.body.mode === 'json' && r.body.raw) {
      let exampleObj: unknown = r.body.raw
      try {
        exampleObj = JSON.parse(r.body.raw)
      } catch {
        // keep string
      }
      requestBody = {
        content: {
          'application/json': {
            schema: { type: 'object' },
            example: exampleObj,
          },
        },
      }
    }

    paths[openApiPath]![r.method.toLowerCase()] = {
      summary: r.name,
      description: r.description || undefined,
      parameters: parameters.length > 0 ? parameters : undefined,
      requestBody,
      responses: {
        '200': {
          description: 'Successful response',
        },
      },
    }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: input.name,
      description: input.description || undefined,
      version: '1.0.0',
    },
    servers: [{ url: 'https://api.example.com' }],
    paths,
  }
}
