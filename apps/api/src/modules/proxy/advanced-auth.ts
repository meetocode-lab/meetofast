import crypto from 'node:crypto'

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function md5Hex(data: string): string {
  return crypto.createHash('md5').update(data, 'utf8').digest('hex')
}

function rfc3986Encode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export function applyAwsSigV4Headers(params: {
  method: string
  url: URL
  headers: Headers
  bodyPayload: string | Uint8Array | undefined
  accessKeyId: string
  secretAccessKey: string
  region: string
  service: string
  sessionToken?: string
  now?: Date
}): void {
  const now = params.now ?? new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8) // YYYYMMDD

  const payloadBuf =
    typeof params.bodyPayload === 'string'
      ? Buffer.from(params.bodyPayload, 'utf8')
      : params.bodyPayload
        ? Buffer.from(params.bodyPayload)
        : Buffer.alloc(0)
  const payloadHash = sha256Hex(payloadBuf)

  params.headers.set('host', params.url.host)
  params.headers.set('x-amz-date', amzDate)
  params.headers.set('x-amz-content-sha256', payloadHash)
  if (params.sessionToken) {
    params.headers.set('x-amz-security-token', params.sessionToken)
  }

  const canonicalUri = params.url.pathname || '/'
  const queryEntries: Array<[string, string]> = []
  params.url.searchParams.forEach((v, k) => {
    queryEntries.push([rfc3986Encode(k), rfc3986Encode(v)])
  })
  queryEntries.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  const canonicalQueryString = queryEntries.map(([k, v]) => `${k}=${v}`).join('&')

  const signedHeaderNames = ['host', 'x-amz-content-sha256', 'x-amz-date']
  if (params.sessionToken) signedHeaderNames.push('x-amz-security-token')
  signedHeaderNames.sort()

  const canonicalHeaders = signedHeaderNames
    .map((h) => `${h}:${(params.headers.get(h) ?? '').trim()}\n`)
    .join('')
  const signedHeaders = signedHeaderNames.join(';')

  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = hmacSha256(`AWS4${params.secretAccessKey}`, dateStamp)
  const kRegion = hmacSha256(kDate, params.region)
  const kService = hmacSha256(kRegion, params.service)
  const kSigning = hmacSha256(kService, 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  params.headers.set(
    'Authorization',
    `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  )
}

export function buildOAuth1AuthorizationHeader(params: {
  method: string
  url: URL
  consumerKey: string
  consumerSecret: string
  token?: string
  tokenSecret?: string
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: crypto.randomBytes(12).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
  }
  if (params.token) {
    oauthParams.oauth_token = params.token
  }

  const allPairs: Array<[string, string]> = []
  for (const [k, v] of Object.entries(oauthParams)) {
    allPairs.push([rfc3986Encode(k), rfc3986Encode(v)])
  }
  params.url.searchParams.forEach((v, k) => {
    allPairs.push([rfc3986Encode(k), rfc3986Encode(v)])
  })
  allPairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))

  const normalizedParams = allPairs.map(([k, v]) => `${k}=${v}`).join('&')
  const baseUrl = `${params.url.protocol}//${params.url.host}${params.url.pathname}`
  const baseString = [
    params.method.toUpperCase(),
    rfc3986Encode(baseUrl),
    rfc3986Encode(normalizedParams),
  ].join('&')

  const signingKey = `${rfc3986Encode(params.consumerSecret)}&${rfc3986Encode(params.tokenSecret ?? '')}`
  const signature = crypto.createHmac('sha1', signingKey).update(baseString, 'utf8').digest('base64')
  oauthParams.oauth_signature = signature

  const headerParts = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${rfc3986Encode(k)}="${rfc3986Encode(v)}"`)
    .join(', ')

  return `OAuth ${headerParts}`
}

export function buildDigestAuthorizationHeader(params: {
  wwwAuthenticateHeader: string
  method: string
  uriPathWithQuery: string
  username: string
  password: string
}): string | null {
  const header = params.wwwAuthenticateHeader.trim()
  if (!/^digest\s+/i.test(header)) return null

  const attrs: Record<string, string> = {}
  const attrRegex = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g
  let match: RegExpExecArray | null = attrRegex.exec(header)
  while (match !== null) {
    const key = match[1]!.toLowerCase()
    const val = match[2] ?? match[3] ?? ''
    attrs[key] = val
    match = attrRegex.exec(header)
  }

  const realm = attrs.realm ?? ''
  const nonce = attrs.nonce
  if (!nonce) return null

  const algorithm = (attrs.algorithm ?? 'MD5').toUpperCase()
  const hashFn = algorithm.startsWith('SHA-256') ? sha256Hex : md5Hex
  const qopTokens = (attrs.qop ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const useAuthQop = qopTokens.includes('auth')

  const nc = '00000001'
  const cnonce = crypto.randomBytes(8).toString('hex')
  const ha1 = hashFn(`${params.username}:${realm}:${params.password}`)
  const ha2 = hashFn(`${params.method.toUpperCase()}:${params.uriPathWithQuery}`)

  const responseDigest = useAuthQop
    ? hashFn(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
    : hashFn(`${ha1}:${nonce}:${ha2}`)

  const parts = [
    `username="${params.username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${params.uriPathWithQuery}"`,
    `algorithm=${algorithm}`,
    `response="${responseDigest}"`,
  ]
  if (attrs.opaque) parts.push(`opaque="${attrs.opaque}"`)
  if (useAuthQop) {
    parts.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`)
  }

  return `Digest ${parts.join(', ')}`
}
