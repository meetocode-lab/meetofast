import {
  HTTP_METHODS,
  type HttpMethod,
  type KeyValueItem,
  type RequestAuthConfig,
  type RequestBodyConfig,
  syncQueryParamsFromUrl,
} from '@meofast/shared'

export interface ParsedCurlRequest {
  method: HttpMethod
  url: string
  queryParams: KeyValueItem[]
  headers: KeyValueItem[]
  auth?: RequestAuthConfig
  body?: RequestBodyConfig
}

function tokenizeShellCommand(input: string): string[] {
  const normalized = input.replace(/\\\r?\n/g, ' ').trim()
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let i = 0

  while (i < normalized.length) {
    const ch = normalized[i]!
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < normalized.length) {
        current += normalized[i + 1]
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
        i += 1
        continue
      }
      current += ch
      i += 1
      continue
    }

    if (ch === '$' && normalized[i + 1] === "'") {
      quote = "'"
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < normalized.length) {
      current += normalized[i + 1]
      i += 2
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      i += 1
      continue
    }
    current += ch
    i += 1
  }

  if (current.length > 0) tokens.push(current)
  return tokens
}

export function parsePastedCurl(raw: string): ParsedCurlRequest | null {
  const trimmed = raw.trim()
  if (!/^curl(\s+|$)/i.test(trimmed)) return null

  const tokens = tokenizeShellCommand(trimmed)
  if (tokens.length < 2) return null

  let explicitMethod: HttpMethod | null = null
  let url = ''
  const headers: KeyValueItem[] = []
  let auth: RequestAuthConfig | undefined
  const dataParts: string[] = []

  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i]!

    if (tok === '-X' || tok === '--request') {
      const next = (tokens[i + 1] ?? '').toUpperCase()
      if ((HTTP_METHODS as readonly string[]).includes(next)) {
        explicitMethod = next as HttpMethod
      }
      i += 1
      continue
    }

    if (tok === '-H' || tok === '--header') {
      const hdr = tokens[i + 1] ?? ''
      const colonIdx = hdr.indexOf(':')
      if (colonIdx > 0) {
        const key = hdr.slice(0, colonIdx).trim()
        const value = hdr.slice(colonIdx + 1).trim()
        if (key.toLowerCase() === 'authorization' && /^bearer\s+/i.test(value)) {
          auth = {
            type: 'bearer',
            token: value.replace(/^bearer\s+/i, '').trim(),
            prefix: 'Bearer',
          }
        } else if (key) {
          headers.push({
            id: crypto.randomUUID(),
            key,
            value,
            description: '',
            enabled: true,
          })
        }
      }
      i += 1
      continue
    }

    if (tok === '-u' || tok === '--user') {
      const creds = tokens[i + 1] ?? ''
      const sep = creds.indexOf(':')
      auth = {
        type: 'basic',
        username: sep >= 0 ? creds.slice(0, sep) : creds,
        password: sep >= 0 ? creds.slice(sep + 1) : '',
      }
      i += 1
      continue
    }

    if (
      tok === '-d' ||
      tok === '--data' ||
      tok === '--data-raw' ||
      tok === '--data-binary' ||
      tok === '--data-urlencode'
    ) {
      if (tokens[i + 1] !== undefined) {
        dataParts.push(tokens[i + 1]!)
      }
      i += 1
      continue
    }

    if (tok === '--url') {
      url = tokens[i + 1] ?? url
      i += 1
      continue
    }

    if (!tok.startsWith('-') && !url && /^https?:\/\//i.test(tok)) {
      url = tok
    }
  }

  if (!url) return null

  const rawBody = dataParts.join('&')
  let body: RequestBodyConfig | undefined
  if (rawBody) {
    let mode: 'json' | 'text' = 'text'
    try {
      JSON.parse(rawBody)
      mode = 'json'
    } catch {
      mode = 'text'
    }
    body = {
      mode,
      raw: rawBody,
      urlencoded: [],
      multipart: [],
      binaryBase64: '',
      binaryFileName: '',
      binaryContentType: 'application/octet-stream',
    }
  }

  const method: HttpMethod = explicitMethod ?? (rawBody ? 'POST' : 'GET')
  const queryParams = syncQueryParamsFromUrl(url, [])

  return {
    method,
    url,
    queryParams,
    headers,
    auth,
    body,
  }
}
