import crypto from 'node:crypto'
import {
  HTTP_METHODS,
  type HttpMethod,
  type KeyValueItem,
  type RequestBodyConfig,
} from '@meofast/shared'

export interface NormalizedImportRequest {
  name: string
  description: string
  method: HttpMethod
  url: string
  queryParams: KeyValueItem[]
  headers: KeyValueItem[]
  body: RequestBodyConfig
  folderTempId: string | null
}

export interface NormalizedImportCollection {
  name: string
  description: string
  folders: Array<{ tempId: string; name: string }>
  requests: NormalizedImportRequest[]
}

function toValidMethod(raw: unknown): HttpMethod {
  const upper = String(raw ?? 'GET').toUpperCase()
  return (HTTP_METHODS as readonly string[]).includes(upper) ? (upper as HttpMethod) : 'GET'
}

export function parseHarDocument(doc: Record<string, unknown>): NormalizedImportCollection {
  const log = (doc.log ?? {}) as {
    entries?: Array<{
      request?: {
        method?: string
        url?: string
        headers?: Array<{ name?: string; value?: string }>
        queryString?: Array<{ name?: string; value?: string }>
        postData?: { mimeType?: string; text?: string }
      }
    }>
  }

  const entries = Array.isArray(log.entries) ? log.entries : []
  const requests: NormalizedImportRequest[] = entries.map((entry, idx) => {
    const req = entry.request ?? {}
    const method = toValidMethod(req.method)
    const rawUrl = String(req.url ?? 'https://example.com')
    let pathLabel = rawUrl
    try {
      pathLabel = new URL(rawUrl).pathname
    } catch {
      // keep raw
    }

    const headers: KeyValueItem[] = (req.headers ?? [])
      .filter((h) => h.name && !h.name.startsWith(':'))
      .map((h) => ({
        id: crypto.randomUUID(),
        key: String(h.name ?? ''),
        value: String(h.value ?? ''),
        description: '',
        enabled: true,
      }))

    const queryParams: KeyValueItem[] = (req.queryString ?? []).map((q) => ({
      id: crypto.randomUUID(),
      key: String(q.name ?? ''),
      value: String(q.value ?? ''),
      description: '',
      enabled: true,
    }))

    const rawBody = String(req.postData?.text ?? '')
    const mime = String(req.postData?.mimeType ?? '').toLowerCase()
    let mode: RequestBodyConfig['mode'] = 'none'
    if (rawBody) {
      if (mime.includes('json')) mode = 'json'
      else if (mime.includes('xml')) mode = 'xml'
      else mode = 'text'
    }

    return {
      name: `${method} ${pathLabel || `#${idx + 1}`}`.slice(0, 160),
      description: 'Imported from HAR archive',
      method,
      url: rawUrl.split('?')[0] || rawUrl,
      queryParams,
      headers,
      body: {
        mode,
        raw: rawBody,
        urlencoded: [],
        multipart: [],
        binaryBase64: '',
        binaryFileName: '',
        binaryContentType: 'application/octet-stream',
      },
      folderTempId: null,
    }
  })

  return {
    name: 'HAR Imported Traffic',
    description: `Imported ${requests.length} HTTP entries`,
    folders: [],
    requests,
  }
}

export function parseInsomniaDocument(doc: Record<string, unknown>): NormalizedImportCollection {
  const resources = Array.isArray(doc.resources)
    ? (doc.resources as Array<Record<string, unknown>>)
    : []

  const workspaceRes = resources.find(
    (r) => r._type === 'workspace' || r._type === 'request_collection',
  )
  const colName = String(workspaceRes?.name ?? 'Insomnia Collection').slice(0, 160)

  const folderResources = resources.filter((r) => r._type === 'request_group')
  const folders = folderResources.map((f) => ({
    tempId: String(f._id ?? crypto.randomUUID()),
    name: String(f.name ?? 'Folder').slice(0, 160),
  }))
  const knownFolderIds = new Set(folders.map((f) => f.tempId))

  const reqResources = resources.filter((r) => r._type === 'request')
  const requests: NormalizedImportRequest[] = reqResources.map((r) => {
    const method = toValidMethod(r.method)
    const rawHeaders = Array.isArray(r.headers)
      ? (r.headers as Array<{ name?: string; value?: string; disabled?: boolean }>)
      : []
    const rawParams = Array.isArray(r.parameters)
      ? (r.parameters as Array<{ name?: string; value?: string; disabled?: boolean }>)
      : []
    const bodyObj = (r.body ?? {}) as { mimeType?: string; text?: string }
    const bodyText = String(bodyObj.text ?? '')
    let mode: RequestBodyConfig['mode'] = 'none'
    if (bodyText) {
      mode = String(bodyObj.mimeType ?? '').includes('json') ? 'json' : 'text'
    }
    const parentId = String(r.parentId ?? '')

    return {
      name: String(r.name ?? `${method} Request`).slice(0, 160),
      description: String(r.description ?? ''),
      method,
      url: String(r.url ?? 'https://example.com'),
      queryParams: rawParams.map((p) => ({
        id: crypto.randomUUID(),
        key: String(p.name ?? ''),
        value: String(p.value ?? ''),
        description: '',
        enabled: !p.disabled,
      })),
      headers: rawHeaders.map((h) => ({
        id: crypto.randomUUID(),
        key: String(h.name ?? ''),
        value: String(h.value ?? ''),
        description: '',
        enabled: !h.disabled,
      })),
      body: {
        mode,
        raw: bodyText,
        urlencoded: [],
        multipart: [],
        binaryBase64: '',
        binaryFileName: '',
        binaryContentType: 'application/octet-stream',
      },
      folderTempId: knownFolderIds.has(parentId) ? parentId : null,
    }
  })

  return {
    name: colName,
    description: String(workspaceRes?.description ?? ''),
    folders,
    requests,
  }
}

export function parseBrunoDocument(bruText: string): NormalizedImportCollection {
  const nameMatch = bruText.match(/meta\s*\{[\s\S]*?name:\s*(.+)/i)
  const methodUrlMatch = bruText.match(
    /\b(get|post|put|patch|delete|head|options)\s*\{[\s\S]*?url:\s*(.+)/i,
  )
  const headersBlock = bruText.match(/headers\s*\{([\s\S]*?)\}/i)
  const jsonBodyBlock = bruText.match(/body:json\s*\{([\s\S]*)\}/i)

  const name = (nameMatch?.[1] ?? 'Bruno Request').trim().slice(0, 160)
  const method = toValidMethod(methodUrlMatch?.[1] ?? 'GET')
  const url = (methodUrlMatch?.[2] ?? 'https://example.com').trim()

  const headers: KeyValueItem[] = []
  if (headersBlock?.[1]) {
    for (const line of headersBlock[1].split(/\r?\n/)) {
      const idx = line.indexOf(':')
      if (idx > 0) {
        headers.push({
          id: crypto.randomUUID(),
          key: line.slice(0, idx).trim(),
          value: line.slice(idx + 1).trim(),
          description: '',
          enabled: !line.trim().startsWith('~'),
        })
      }
    }
  }

  const rawJson = jsonBodyBlock?.[1]?.trim() ?? ''

  return {
    name: 'Bruno Imported Collection',
    description: '',
    folders: [],
    requests: [
      {
        name,
        description: '',
        method,
        url,
        queryParams: [],
        headers,
        body: {
          mode: rawJson ? 'json' : 'none',
          raw: rawJson,
          urlencoded: [],
          multipart: [],
          binaryBase64: '',
          binaryFileName: '',
          binaryContentType: 'application/octet-stream',
        },
        folderTempId: null,
      },
    ],
  }
}

export function exportHarDocument(col: {
  name: string
  requests: Array<{
    name: string
    method: HttpMethod
    url: string
    headers: KeyValueItem[]
    queryParams: KeyValueItem[]
    body: RequestBodyConfig
  }>
}) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Meofast', version: '1.0.0' },
      entries: col.requests.map((r) => ({
        startedDateTime: new Date().toISOString(),
        time: 0,
        request: {
          method: r.method,
          url: r.url,
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: r.headers
            .filter((h) => h.enabled && h.key)
            .map((h) => ({ name: h.key, value: h.value })),
          queryString: r.queryParams
            .filter((q) => q.enabled && q.key)
            .map((q) => ({ name: q.key, value: q.value })),
          postData:
            r.body.mode !== 'none' && r.body.raw
              ? {
                  mimeType: r.body.mode === 'json' ? 'application/json' : 'text/plain',
                  text: r.body.raw,
                }
              : undefined,
          headersSize: -1,
          bodySize: r.body.raw ? Buffer.byteLength(r.body.raw, 'utf8') : 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          content: { size: 0, mimeType: 'application/json' },
          redirectURL: '',
          headersSize: -1,
          bodySize: 0,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      })),
    },
  }
}

export function exportInsomniaDocument(col: {
  id: string
  name: string
  description: string
  requests: Array<{
    id: string
    name: string
    description: string
    method: HttpMethod
    url: string
    headers: KeyValueItem[]
    queryParams: KeyValueItem[]
    body: RequestBodyConfig
  }>
}) {
  const wsId = `wrk_${col.id.replace(/-/g, '').slice(0, 16)}`
  return {
    _type: 'export',
    __export_format: 4,
    __export_date: new Date().toISOString(),
    __export_source: 'meofast.v1',
    resources: [
      {
        _id: wsId,
        _type: 'workspace',
        name: col.name,
        description: col.description,
        scope: 'collection',
      },
      ...col.requests.map((r) => ({
        _id: `req_${r.id.replace(/-/g, '').slice(0, 16)}`,
        _type: 'request',
        parentId: wsId,
        name: r.name,
        description: r.description,
        method: r.method,
        url: r.url,
        headers: r.headers.map((h) => ({
          name: h.key,
          value: h.value,
          disabled: !h.enabled,
        })),
        parameters: r.queryParams.map((q) => ({
          name: q.key,
          value: q.value,
          disabled: !q.enabled,
        })),
        body:
          r.body.mode !== 'none'
            ? {
                mimeType: r.body.mode === 'json' ? 'application/json' : 'text/plain',
                text: r.body.raw ?? '',
              }
            : {},
      })),
    ],
  }
}

export function exportBrunoDocument(col: {
  name: string
  requests: Array<{
    name: string
    method: HttpMethod
    url: string
    headers: KeyValueItem[]
    body: RequestBodyConfig
  }>
}): string {
  return col.requests
    .map((r, idx) => {
      const m = r.method.toLowerCase()
      const hdrs = r.headers
        .filter((h) => h.key)
        .map((h) => `  ${h.enabled ? '' : '~'}${h.key}: ${h.value}`)
        .join('\n')
      const bodyBlock =
        r.body.mode === 'json' && r.body.raw ? `\nbody:json {\n${r.body.raw}\n}\n` : ''
      return `meta {\n  name: ${r.name}\n  type: http\n  seq: ${idx + 1}\n}\n\n${m} {\n  url: ${r.url}\n  body: ${r.body.mode === 'json' ? 'json' : 'none'}\n}\n${hdrs ? `\nheaders {\n${hdrs}\n}\n` : ''}${bodyBlock}`
    })
    .join('\n# ---\n\n')
}
