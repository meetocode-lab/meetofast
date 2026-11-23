import crypto from 'node:crypto'
import {
  type AssertionEvaluationResult,
  type ExecuteRequestInput,
  type ExecuteRequestResponse,
  type KeyValueItem,
  networkPolicySchema,
  type RequestAssertion,
  type RequestAuthConfig,
  type RequestTimings,
  redactHighEntropySecrets,
  requestAuthSchema,
} from '@meofast/shared'
import type { RuntimeContext } from '../../core/bootstrap/runtime-context.js'
import { AppError } from '../../core/errors/app-error.js'
import {
  applyAwsSigV4Headers,
  buildDigestAuthorizationHeader,
  buildOAuth1AuthorizationHeader,
} from './advanced-auth.js'
import { evaluateJsonSchemaAssertion } from './json-schema-validator.js'
import { runSandboxedScript } from './script-sandbox.js'
import { validateOutboundTargetUrl } from './ssrf-guard.js'
import { loadJarCookieHeader, persistSetCookiesToJar } from '../cookies/cookies.routes.js'

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024 // 5 MB safety cap
const MAX_REDIRECTS = 5

function resolveDynamicToken(name: string): string | undefined {
  switch (name) {
    case '$uuid':
      return crypto.randomUUID()
    case '$timestamp':
      return String(Math.floor(Date.now() / 1000))
    case '$isoTimestamp':
      return new Date().toISOString()
    case '$randomInt':
      return String(crypto.randomInt(1, 10000))
    default:
      return undefined
  }
}

function interpolateTemplate(template: string, variables: Map<string, string>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, rawKey: string) => {
    const key = rawKey.trim()
    const dyn = resolveDynamicToken(key)
    if (dyn !== undefined) return dyn
    if (variables.has(key)) return variables.get(key)!
    return full
  })
}

const SENSITIVE_HEADER_NAME = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i

function maskSecrets(text: string, secretValues: string[]): string {
  return redactHighEntropySecrets(text, secretValues)
}

function buildSanitizedRequestSnapshot(
  reqInput: ExecuteRequestInput,
  effectiveMethod: string,
  safeResolvedUrl: string,
  secretValues: string[],
) {
  return {
    protocol: reqInput.protocol ?? 'http',
    method: effectiveMethod,
    url: safeResolvedUrl,
    rawUrl: maskSecrets(reqInput.url, secretValues),
    queryParams: reqInput.queryParams.map((q) => ({
      ...q,
      value: maskSecrets(q.value, secretValues),
    })),
    headers: reqInput.headers.map((h) => ({
      ...h,
      value: SENSITIVE_HEADER_NAME.test(h.key.trim())
        ? '[REDACTED]'
        : maskSecrets(h.value, secretValues),
    })),
    pathVariables: (reqInput.pathVariables ?? []).map((p) => ({
      ...p,
      value: maskSecrets(p.value, secretValues),
    })),
    body: {
      ...reqInput.body,
      raw: maskSecrets(reqInput.body.raw ?? '', secretValues),
    },
    graphql: reqInput.graphql,
    assertions: reqInput.assertions,
  }
}

function sanitizeResponseHeaders(
  headers: Record<string, string>,
  secretValues: string[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_NAME.test(k) ? '[REDACTED]' : maskSecrets(v, secretValues)
  }
  return out
}

function shortUrlLabel(urlStr: string): string {
  try {
    const parsed = new URL(urlStr, 'http://meofast.local')
    return parsed.pathname || urlStr
  } catch {
    return urlStr.slice(0, 60)
  }
}

function readJsonPath(obj: unknown, dotPath: string): unknown {
  const normalized = dotPath.trim().replace(/^\$\.?/, '')
  if (!normalized) return obj
  const parts = normalized.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function evaluateDeclarativeAssertions(
  assertions: RequestAssertion[],
  ctx: {
    status: number
    durationMs: number
    headers: Record<string, string>
    body: string
    parsedJson: unknown
    isJson: boolean
  },
): AssertionEvaluationResult[] {
  const results: AssertionEvaluationResult[] = []
  const lowerHeaders = new Map(
    Object.entries(ctx.headers).map(([k, v]) => [k.toLowerCase(), v]),
  )

  for (const rule of assertions) {
    if (!rule.enabled) continue

    switch (rule.type) {
      case 'status_equals': {
        const expectedNum = Number(rule.expected)
        const passed = ctx.status === expectedNum
        results.push({
          id: rule.id,
          type: rule.type,
          passed,
          label: `Status equals ${rule.expected}`,
          actual: String(ctx.status),
          expected: rule.expected ?? '',
        })
        break
      }
      case 'status_in_2xx': {
        const passed = ctx.status >= 200 && ctx.status < 300
        results.push({
          id: rule.id,
          type: rule.type,
          passed,
          label: 'Status is 2xx',
          actual: String(ctx.status),
          expected: '200-299',
        })
        break
      }
      case 'duration_lt': {
        const threshold = Number(rule.expected) || 1000
        const passed = ctx.durationMs < threshold
        results.push({
          id: rule.id,
          type: rule.type,
          passed,
          label: `Response time < ${threshold} ms`,
          actual: `${ctx.durationMs} ms`,
          expected: `< ${threshold} ms`,
        })
        break
      }
      case 'header_exists': {
        const key = (rule.target ?? '').toLowerCase()
        const exists = lowerHeaders.has(key)
        results.push({
          id: rule.id,
          type: rule.type,
          passed: exists,
          label: `Header '${rule.target}' exists`,
          actual: exists ? 'present' : 'missing',
          expected: 'present',
        })
        break
      }
      case 'header_equals': {
        const key = (rule.target ?? '').toLowerCase()
        const actualVal = lowerHeaders.get(key) ?? ''
        const passed = actualVal === (rule.expected ?? '')
        results.push({
          id: rule.id,
          type: rule.type,
          passed,
          label: `Header '${rule.target}' equals '${rule.expected}'`,
          actual: actualVal || '(missing)',
          expected: rule.expected ?? '',
        })
        break
      }
      case 'json_path_equals': {
        const val = ctx.isJson ? readJsonPath(ctx.parsedJson, rule.target ?? '') : undefined
        const actualStr = val === undefined ? 'undefined' : String(val)
        const passed = actualStr === (rule.expected ?? '')
        results.push({
          id: rule.id,
          type: rule.type,
          passed,
          label: `JSON '${rule.target}' equals '${rule.expected}'`,
          actual: actualStr,
          expected: rule.expected ?? '',
        })
        break
      }
      case 'body_contains': {
        const needle = rule.expected ?? ''
        const passed = ctx.body.includes(needle)
        results.push({
          id: rule.id,
          type: rule.type,
          passed,
          label: `Body contains '${needle}'`,
          actual: passed ? 'matched' : 'not found',
          expected: needle,
        })
        break
      }
      case 'script':
      case 'json_schema':
        break
    }
  }

  return results
}

function safeParseVars(raw: string | null | undefined): KeyValueItem[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as KeyValueItem[]) : []
  } catch {
    return []
  }
}

function safeParseAuth(raw: string | null | undefined): RequestAuthConfig {
  if (!raw) return { type: 'none' }
  try {
    const parsed = requestAuthSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : { type: 'none' }
  } catch {
    return { type: 'none' }
  }
}

async function persistScriptEnvironmentUpdates(
  runtime: RuntimeContext,
  workspaceId: string,
  preferredEnvironmentId: string | null | undefined,
  updates: Map<string, string>,
): Promise<boolean> {
  if (updates.size === 0) return false
  const db = runtime.getDb()

  let targetEnvId = preferredEnvironmentId ?? null
  if (!targetEnvId) {
    const globalEnv = await db
      .selectFrom('environments')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('is_global', '=', 1)
      .limit(1)
      .executeTakeFirst()
    targetEnvId = globalEnv?.id ?? null
  }
  if (!targetEnvId) return false

  const existingVars = await db
    .selectFrom('environment_variables')
    .selectAll()
    .where('environment_id', '=', targetEnvId)
    .execute()
  const byKey = new Map(existingVars.map((v) => [v.var_key, v]))
  const nowIso = new Date().toISOString()

  let nextOrder = existingVars.length
  for (const [key, val] of updates.entries()) {
    const existing = byKey.get(key)
    if (existing) {
      if (existing.is_secret === 1) {
        await db
          .updateTable('environment_variables')
          .set({
            encrypted_value: runtime.vault.encrypt(val),
            var_value: '',
            enabled: 1,
            updated_at: nowIso,
          })
          .where('id', '=', existing.id)
          .execute()
      } else {
        await db
          .updateTable('environment_variables')
          .set({
            var_value: val,
            enabled: 1,
            updated_at: nowIso,
          })
          .where('id', '=', existing.id)
          .execute()
      }
    } else {
      await db
        .insertInto('environment_variables')
        .values({
          id: crypto.randomUUID(),
          environment_id: targetEnvId,
          var_key: key,
          var_value: val,
          encrypted_value: null,
          is_secret: 0,
          enabled: 1,
          sort_order: nextOrder++,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .execute()
    }
  }

  return true
}

export async function executeSingleRequest(
  runtime: RuntimeContext,
  userId: string,
  reqInput: ExecuteRequestInput,
  iterationDataRow?: Record<string, string>,
): Promise<ExecuteRequestResponse> {
  const db = runtime.getDb()
  const consoleLogs: ExecuteRequestResponse['consoleLogs'] = []

  // 1. Resolve variable hierarchy:
  // Global -> Collection -> Folder -> Active Environment -> Data Iteration Row
  const variableMap = new Map<string, string>()
  const secretValues: string[] = []

  const envRows = await db
    .selectFrom('environments')
    .select(['id', 'is_global'])
    .where('workspace_id', '=', reqInput.workspaceId)
    .where((eb) =>
      reqInput.environmentId
        ? eb.or([eb('is_global', '=', 1), eb('id', '=', reqInput.environmentId)])
        : eb('is_global', '=', 1),
    )
    .execute()

  const globalIds = new Set(envRows.filter((e) => e.is_global === 1).map((e) => e.id))
  const envVarRows =
    envRows.length > 0
      ? await db
          .selectFrom('environment_variables')
          .selectAll()
          .where(
            'environment_id',
            'in',
            envRows.map((e) => e.id),
          )
          .where('enabled', '=', 1)
          .orderBy('sort_order', 'asc')
          .execute()
      : []

  // 1a. Global Variables
  for (const v of envVarRows.filter((r) => globalIds.has(r.environment_id))) {
    if (v.is_secret === 1 && v.encrypted_value) {
      try {
        const dec = runtime.vault.decrypt(v.encrypted_value)
        variableMap.set(v.var_key, dec)
        secretValues.push(dec)
      } catch {
        // ignore
      }
    } else {
      variableMap.set(v.var_key, v.var_value)
    }
  }

  // 1b. Collection & Folder Hierarchy (Variables, Inherited Headers & Inherited Auth)
  const inheritedHeaders: KeyValueItem[] = []
  let collectionAuth: RequestAuthConfig = { type: 'none' }

  if (reqInput.collectionId) {
    const colRow = await db
      .selectFrom('collections')
      .select(['variables_json', 'auth_json', 'headers_json'])
      .where('id', '=', reqInput.collectionId)
      .executeTakeFirst()
    for (const cv of safeParseVars(colRow?.variables_json)) {
      if (cv.enabled && cv.key.trim()) {
        variableMap.set(cv.key.trim(), cv.value)
      }
    }
    inheritedHeaders.push(...safeParseVars(colRow?.headers_json))
    collectionAuth = safeParseAuth(colRow?.auth_json)
  }

  // 1c. Folder Chain (walking root -> leaf if nested)
  const folderChain: Array<{
    id: string
    variables_json: string
    auth_json?: string | null
    headers_json?: string | null
  }> = []
  if (reqInput.folderId) {
    const visited = new Set<string>()
    let cursorId: string | null = reqInput.folderId
    while (cursorId && !visited.has(cursorId) && visited.size < 16) {
      visited.add(cursorId)
      const fRow = await db
        .selectFrom('collection_folders')
        .select(['id', 'parent_folder_id', 'variables_json', 'auth_json', 'headers_json'])
        .where('id', '=', cursorId)
        .executeTakeFirst()
      if (!fRow) break
      folderChain.unshift(fRow)
      cursorId = fRow.parent_folder_id
    }
    for (const fNode of folderChain) {
      for (const fv of safeParseVars(fNode.variables_json)) {
        if (fv.enabled && fv.key.trim()) {
          variableMap.set(fv.key.trim(), fv.value)
        }
      }
      inheritedHeaders.push(...safeParseVars(fNode.headers_json))
    }
  }

  let effectiveAuth: RequestAuthConfig = reqInput.auth
  if (effectiveAuth.type === 'inherit') {
    let resolvedParentAuth: RequestAuthConfig = { type: 'none' }
    for (let i = folderChain.length - 1; i >= 0; i -= 1) {
      const candidate = safeParseAuth(folderChain[i]!.auth_json)
      if (candidate.type !== 'inherit' && candidate.type !== 'none') {
        resolvedParentAuth = candidate
        break
      }
    }
    if (
      resolvedParentAuth.type === 'none' &&
      collectionAuth.type !== 'inherit' &&
      collectionAuth.type !== 'none'
    ) {
      resolvedParentAuth = collectionAuth
    }
    effectiveAuth = resolvedParentAuth
  }

  // 1d. Active Environment Variables
  for (const v of envVarRows.filter((r) => !globalIds.has(r.environment_id))) {
    if (v.is_secret === 1 && v.encrypted_value) {
      try {
        const dec = runtime.vault.decrypt(v.encrypted_value)
        variableMap.set(v.var_key, dec)
        secretValues.push(dec)
      } catch {
        // ignore
      }
    } else {
      variableMap.set(v.var_key, v.var_value)
    }
  }

  // 1e. Data-driven iteration row overrides
  if (iterationDataRow) {
    for (const [k, v] of Object.entries(iterationDataRow)) {
      variableMap.set(k, String(v))
    }
  }

  // 2. Execute Sandboxed Pre-Request Script
  const preHeaderMap = new Map<string, string>()
  for (const ih of inheritedHeaders) {
    if (ih.enabled && ih.key.trim()) preHeaderMap.set(ih.key.trim(), ih.value)
  }
  for (const h of reqInput.headers) {
    if (h.enabled && h.key.trim()) preHeaderMap.set(h.key.trim(), h.value)
  }

  const preScriptOut = runSandboxedScript(
    reqInput.preRequestScript ?? '',
    'pre_request',
    {
      variables: variableMap,
      requestHeaders: preHeaderMap,
    },
  )
  consoleLogs.push(...preScriptOut.logs)

  // 3. Load SSRF network policy
  const policySetting = await db
    .selectFrom('system_settings')
    .select('setting_value')
    .where('setting_key', '=', 'network_policy')
    .executeTakeFirst()

  let networkPolicy = {
    allowPrivateNetworks: false,
    allowLocalhost: false,
    allowedCidrs: [] as string[],
    allowedDomains: [] as string[],
  }
  if (policySetting?.setting_value) {
    try {
      networkPolicy = networkPolicySchema.parse(JSON.parse(policySetting.setting_value))
    } catch {
      // safe defaults
    }
  }

  // 4. Interpolate URL, Path Variables, Query Params, Headers, Auth & Body
  const protocol = reqInput.protocol ?? 'http'
  let resolvedUrlStr = interpolateTemplate(reqInput.url, variableMap).trim()
  for (const pv of reqInput.pathVariables) {
    if (pv.enabled && pv.key) {
      const val = encodeURIComponent(interpolateTemplate(pv.value, variableMap))
      resolvedUrlStr = resolvedUrlStr.replace(`:${pv.key}`, val)
    }
  }

  // Detect internal self-hosted Meofast sandbox routes (/api/v1/mock/*, /api/v1/webhooks/in/*, /api/v1/playground/*)
  let isInternalSandboxRoute = false
  if (resolvedUrlStr.startsWith('/api/v1/')) {
    resolvedUrlStr = `http://meofast.internal${resolvedUrlStr}`
  }
  if (!/^https?:\/\//i.test(resolvedUrlStr)) {
    resolvedUrlStr = `https://${resolvedUrlStr}`
  }

  let candidateUrlObj: URL
  try {
    candidateUrlObj = new URL(resolvedUrlStr)
  } catch {
    throw new AppError(400, 'INVALID_URL', `Invalid target URL: ${resolvedUrlStr}`)
  }

  const isLoopbackOrSelfHost =
    candidateUrlObj.hostname === 'meofast.internal' ||
    candidateUrlObj.hostname === 'localhost' ||
    candidateUrlObj.hostname === '127.0.0.1'

  if (
    runtime.localFetch &&
    isLoopbackOrSelfHost &&
    (candidateUrlObj.pathname.startsWith('/api/v1/mock/') ||
      candidateUrlObj.pathname.startsWith('/api/v1/webhooks/in/') ||
      candidateUrlObj.pathname.startsWith('/api/v1/playground/'))
  ) {
    isInternalSandboxRoute = true
  }

  const dnsStartedAt = performance.now()
  let targetUrl = isInternalSandboxRoute
    ? candidateUrlObj
    : await validateOutboundTargetUrl(resolvedUrlStr, networkPolicy)
  const measuredDnsMs = isInternalSandboxRoute
    ? 0
    : Math.max(0, Math.round(performance.now() - dnsStartedAt))

  const initialUrlEntries = Array.from(targetUrl.searchParams.entries()).map(([key, value]) => ({
    key,
    value,
    consumed: false,
  }))
  const enabledKeyCounts = new Map<string, number>()
  for (const qp of reqInput.queryParams) {
    if (!qp.enabled) continue
    const k = interpolateTemplate(qp.key.trim(), variableMap)
    if (!k) continue
    enabledKeyCounts.set(k, (enabledKeyCounts.get(k) ?? 0) + 1)
  }

  for (const qp of reqInput.queryParams) {
    if (!qp.enabled) continue
    const k = interpolateTemplate(qp.key.trim(), variableMap)
    if (!k) continue
    const v = interpolateTemplate(qp.value, variableMap)

    const exactMatch = initialUrlEntries.find(
      (entry) => !entry.consumed && entry.key === k && entry.value === v,
    )
    if (exactMatch) {
      exactMatch.consumed = true
      continue
    }

    const keyMatch = initialUrlEntries.find((entry) => !entry.consumed && entry.key === k)
    if (keyMatch) {
      keyMatch.consumed = true
      if (v !== '' && (enabledKeyCounts.get(k) ?? 0) === 1) {
        targetUrl.searchParams.set(k, v)
      }
      continue
    }

    targetUrl.searchParams.append(k, v)
  }

  const outboundHeaders = new Headers()
  outboundHeaders.set('User-Agent', 'MeetofastRuntime/1.0')
  outboundHeaders.set('Accept', '*/*')
  outboundHeaders.set('Accept-Encoding', 'gzip, deflate, br')
  outboundHeaders.set('Accept-Language', 'en-US,en;q=0.9')

  for (const ih of inheritedHeaders) {
    if (ih.enabled && ih.key.trim()) {
      outboundHeaders.set(
        interpolateTemplate(ih.key.trim(), variableMap),
        interpolateTemplate(ih.value, variableMap),
      )
    }
  }
  for (const h of reqInput.headers) {
    if (h.enabled && h.key.trim()) {
      outboundHeaders.set(
        interpolateTemplate(h.key.trim(), variableMap),
        interpolateTemplate(h.value, variableMap),
      )
    }
  }
  for (const added of preScriptOut.addedHeaders) {
    if (added.key.trim()) {
      outboundHeaders.set(
        interpolateTemplate(added.key.trim(), variableMap),
        interpolateTemplate(added.value, variableMap),
      )
    }
  }

  let effectiveMethod = reqInput.method
  if (protocol === 'graphql') {
    effectiveMethod = 'POST'
  } else if (protocol === 'sse') {
    outboundHeaders.set('Accept', 'text/event-stream')
    outboundHeaders.set('Cache-Control', 'no-cache')
  } else if (protocol === 'soap') {
    if (!outboundHeaders.has('content-type')) {
      outboundHeaders.set('Content-Type', 'text/xml; charset=utf-8')
    }
  } else if (protocol === 'grpc') {
    effectiveMethod = 'POST'
    if (!outboundHeaders.has('content-type')) {
      outboundHeaders.set('Content-Type', 'application/grpc+json')
    }
  }

  let requestBodyPayload: BodyInit | undefined
  let signablePayload: string | Uint8Array | undefined

  if (protocol === 'graphql') {
    const gqlQuery = interpolateTemplate(reqInput.graphql?.query ?? '', variableMap)
    const gqlVarsRaw = interpolateTemplate(reqInput.graphql?.variables ?? '{}', variableMap)
    let gqlVars: unknown = {}
    if (gqlVarsRaw.trim()) {
      try {
        gqlVars = JSON.parse(gqlVarsRaw)
      } catch {
        gqlVars = {}
      }
    }
    const gqlBody = JSON.stringify({
      query: gqlQuery,
      variables: gqlVars,
      ...(reqInput.graphql?.operationName ? { operationName: reqInput.graphql.operationName } : {}),
    })
    requestBodyPayload = gqlBody
    signablePayload = gqlBody
    outboundHeaders.set('Content-Type', 'application/json')
  } else if (effectiveMethod !== 'GET' && effectiveMethod !== 'HEAD') {
    if (reqInput.body.mode === 'json') {
      const str = interpolateTemplate(reqInput.body.raw ?? '', variableMap)
      requestBodyPayload = str
      signablePayload = str
      if (!outboundHeaders.has('content-type')) {
        outboundHeaders.set('Content-Type', 'application/json')
      }
    } else if (reqInput.body.mode === 'xml' || protocol === 'soap') {
      const str = interpolateTemplate(reqInput.body.raw ?? '', variableMap)
      requestBodyPayload = str
      signablePayload = str
      if (!outboundHeaders.has('content-type')) {
        outboundHeaders.set('Content-Type', 'application/xml')
      }
    } else if (reqInput.body.mode === 'text') {
      const str = interpolateTemplate(reqInput.body.raw ?? '', variableMap)
      requestBodyPayload = str
      signablePayload = str
      if (!outboundHeaders.has('content-type')) {
        outboundHeaders.set('Content-Type', 'text/plain;charset=UTF-8')
      }
    } else if (reqInput.body.mode === 'urlencoded') {
      const params = new URLSearchParams()
      for (const item of reqInput.body.urlencoded ?? []) {
        if (item.enabled && item.key) {
          params.append(
            interpolateTemplate(item.key, variableMap),
            interpolateTemplate(item.value, variableMap),
          )
        }
      }
      const str = params.toString()
      requestBodyPayload = str
      signablePayload = str
      if (!outboundHeaders.has('content-type')) {
        outboundHeaders.set('Content-Type', 'application/x-www-form-urlencoded')
      }
    } else if (reqInput.body.mode === 'multipart') {
      const form = new FormData()
      for (const item of reqInput.body.multipart ?? []) {
        if (item.enabled && item.key) {
          form.append(
            interpolateTemplate(item.key, variableMap),
            interpolateTemplate(item.value, variableMap),
          )
        }
      }
      requestBodyPayload = form
    } else if (reqInput.body.mode === 'binary' && reqInput.body.binaryBase64) {
      const binBuf = Buffer.from(reqInput.body.binaryBase64, 'base64')
      requestBodyPayload = binBuf
      signablePayload = binBuf
      if (!outboundHeaders.has('content-type')) {
        outboundHeaders.set(
          'Content-Type',
          reqInput.body.binaryContentType || 'application/octet-stream',
        )
      }
    }
  }

  switch (effectiveAuth.type) {
    case 'bearer': {
      const tok = interpolateTemplate(effectiveAuth.token, variableMap)
      if (tok) {
        secretValues.push(tok)
        outboundHeaders.set('Authorization', `${effectiveAuth.prefix || 'Bearer'} ${tok}`.trim())
      }
      break
    }
    case 'basic': {
      const u = interpolateTemplate(effectiveAuth.username, variableMap)
      const p = interpolateTemplate(effectiveAuth.password, variableMap)
      if (p) secretValues.push(p)
      const b64 = Buffer.from(`${u}:${p}`, 'utf8').toString('base64')
      outboundHeaders.set('Authorization', `Basic ${b64}`)
      break
    }
    case 'apikey': {
      const k = interpolateTemplate(effectiveAuth.key, variableMap)
      const v = interpolateTemplate(effectiveAuth.value, variableMap)
      if (v) secretValues.push(v)
      if (k) {
        if (effectiveAuth.in === 'query') {
          targetUrl.searchParams.set(k, v)
        } else {
          outboundHeaders.set(k, v)
        }
      }
      break
    }
    case 'oauth2': {
      const tok = interpolateTemplate(effectiveAuth.accessToken, variableMap)
      if (tok) {
        secretValues.push(tok)
        outboundHeaders.set(
          'Authorization',
          `${effectiveAuth.headerPrefix || 'Bearer'} ${tok}`.trim(),
        )
      }
      break
    }
    case 'aws_sigv4': {
      const ak = interpolateTemplate(effectiveAuth.accessKeyId, variableMap)
      const sk = interpolateTemplate(effectiveAuth.secretAccessKey, variableMap)
      const region = interpolateTemplate(effectiveAuth.region || 'us-east-1', variableMap)
      const service = interpolateTemplate(effectiveAuth.service || 'execute-api', variableMap)
      const sessionToken = interpolateTemplate(effectiveAuth.sessionToken ?? '', variableMap)
      if (sk) secretValues.push(sk)
      if (sessionToken) secretValues.push(sessionToken)
      if (ak && sk) {
        applyAwsSigV4Headers({
          method: effectiveMethod,
          url: targetUrl,
          headers: outboundHeaders,
          bodyPayload: signablePayload,
          accessKeyId: ak,
          secretAccessKey: sk,
          region,
          service,
          sessionToken: sessionToken || undefined,
        })
      }
      break
    }
    case 'oauth1': {
      const ck = interpolateTemplate(effectiveAuth.consumerKey, variableMap)
      const cs = interpolateTemplate(effectiveAuth.consumerSecret, variableMap)
      const tk = interpolateTemplate(effectiveAuth.token ?? '', variableMap)
      const ts = interpolateTemplate(effectiveAuth.tokenSecret ?? '', variableMap)
      if (cs) secretValues.push(cs)
      if (ts) secretValues.push(ts)
      if (ck && cs) {
        outboundHeaders.set(
          'Authorization',
          buildOAuth1AuthorizationHeader({
            method: effectiveMethod,
            url: targetUrl,
            consumerKey: ck,
            consumerSecret: cs,
            token: tk || undefined,
            tokenSecret: ts || undefined,
          }),
        )
      }
      break
    }
    case 'digest': {
      const p = interpolateTemplate(effectiveAuth.password, variableMap)
      if (p) secretValues.push(p)
      break
    }
    case 'custom': {
      const hn = interpolateTemplate(effectiveAuth.headerName, variableMap)
      const hv = interpolateTemplate(effectiveAuth.headerValue, variableMap)
      if (hv) secretValues.push(hv)
      if (hn) outboundHeaders.set(hn, hv)
      break
    }
    case 'none':
      break
  }

  // Inject matching Workspace Cookie Jar cookies when no manual Cookie header was specified
  if (!outboundHeaders.has('Cookie')) {
    const jarCookieHeader = await loadJarCookieHeader(db, reqInput.workspaceId, targetUrl)
    if (jarCookieHeader) {
      outboundHeaders.set('Cookie', jarCookieHeader)
    }
  }

  consoleLogs.push({
    timestamp: new Date().toISOString(),
    level: 'info',
    message: `${effectiveMethod} ${maskSecrets(targetUrl.toString(), secretValues)}`,
  })

  const dispatchFetch = async (
    urlObj: URL,
    methodStr: string,
    hdrs: Headers,
    bodyData: BodyInit | undefined,
    timeoutMsVal: number,
  ): Promise<Response> => {
    if (isInternalSandboxRoute && runtime.localFetch) {
      const internalReq = new Request(`http://127.0.0.1${urlObj.pathname}${urlObj.search}`, {
        method: methodStr,
        headers: hdrs,
        body: bodyData,
      })
      return await runtime.localFetch(internalReq)
    }
    return await fetch(urlObj.toString(), {
      method: methodStr,
      headers: hdrs,
      body: bodyData,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMsVal),
    })
  }

  // 5. Execute HTTP / GraphQL / SSE / SOAP / gRPC call with manual redirect SSRF inspection
  const startedAt = performance.now()
  const redirects: Array<{ status: number; location: string }> = []
  let currentUrl = targetUrl
  let currentMethod = effectiveMethod
  let currentBody = requestBodyPayload
  let response: Response | null = null

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      response = await dispatchFetch(
        currentUrl,
        currentMethod,
        outboundHeaders,
        currentBody,
        protocol === 'sse' ? Math.min(reqInput.timeoutMs, 6000) : reqInput.timeoutMs,
      )

      // Handle HTTP Digest Auth 401 WWW-Authenticate challenge
      if (response.status === 401 && effectiveAuth.type === 'digest') {
        const wwwAuth = response.headers.get('www-authenticate')
        if (wwwAuth) {
          const digestHeader = buildDigestAuthorizationHeader({
            wwwAuthenticateHeader: wwwAuth,
            method: currentMethod,
            uriPathWithQuery: `${currentUrl.pathname}${currentUrl.search}`,
            username: interpolateTemplate(effectiveAuth.username, variableMap),
            password: interpolateTemplate(effectiveAuth.password, variableMap),
          })
          if (digestHeader) {
            await response.body?.cancel().catch(() => undefined)
            outboundHeaders.set('Authorization', digestHeader)
            response = await dispatchFetch(
              currentUrl,
              currentMethod,
              outboundHeaders,
              currentBody,
              reqInput.timeoutMs,
            )
          }
        }
      }

      const isRedirect =
        response.status === 301 ||
        response.status === 302 ||
        response.status === 303 ||
        response.status === 307 ||
        response.status === 308

      if (!isRedirect || !reqInput.followRedirects || isInternalSandboxRoute) break

      const locationHeader = response.headers.get('location')
      if (!locationHeader || hop === MAX_REDIRECTS) break

      const nextUrlCandidate = new URL(locationHeader, currentUrl).toString()
      redirects.push({
        status: response.status,
        location: maskSecrets(nextUrlCandidate, secretValues),
      })

      currentUrl = await validateOutboundTargetUrl(nextUrlCandidate, networkPolicy)
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && currentMethod === 'POST')
      ) {
        currentMethod = 'GET'
        currentBody = undefined
      }
    }
  } catch (err) {
    const durationMs = Math.round(performance.now() - startedAt)
    if (err instanceof AppError) throw err
    const errMsg = err instanceof Error ? err.message : 'Outbound network request failed'
    const safeErrMsg = maskSecrets(errMsg, secretValues)
    const safeFailUrl = maskSecrets(targetUrl.toString(), secretValues)
    const reqSnapshot = buildSanitizedRequestSnapshot(
      reqInput,
      effectiveMethod,
      safeFailUrl,
      secretValues,
    )
    const nowIso = new Date().toISOString()
    const historyId = crypto.randomUUID()
    await db
      .insertInto('request_history')
      .values({
        id: historyId,
        workspace_id: reqInput.workspaceId,
        user_id: userId,
        saved_request_id: reqInput.savedRequestId ?? null,
        method: effectiveMethod,
        url: safeFailUrl,
        request_snapshot_json: JSON.stringify(reqSnapshot),
        response_status: null,
        response_status_text: 'ERROR',
        duration_ms: durationMs,
        response_size_bytes: 0,
        response_headers_json: '{}',
        response_body_preview: '',
        assertion_results_json: '[]',
        error_message: safeErrMsg,
        created_at: nowIso,
      })
      .execute()

    if (!iterationDataRow) {
      await db
        .insertInto('debug_capsules')
        .values({
          id: crypto.randomUUID(),
          workspace_id: reqInput.workspaceId,
          title: `${effectiveMethod} ${shortUrlLabel(safeFailUrl)} → Network Error`,
          notes: `Auto-captured · ${safeErrMsg.slice(0, 120)} (${durationMs} ms)`,
          capsule_json: JSON.stringify({
            format: 'meofast.capsule.v1',
            autoCaptured: true,
            exportedAt: nowIso,
            request: reqSnapshot,
            response: {
              status: 0,
              statusText: 'NETWORK_ERROR',
              durationMs,
              sizeBytes: 0,
              headers: {},
              body: safeErrMsg,
              assertions: [],
              errorMessage: safeErrMsg,
            },
          }),
          created_by: userId,
          created_at: nowIso,
        })
        .execute()
    }

    throw new AppError(502, 'UPSTREAM_REQUEST_FAILED', safeErrMsg)
  }

  const headersReceivedAt = performance.now()
  const finalRes = response!
  const reader = finalRes.body?.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let truncated = false
  const sseWindowDeadline = performance.now() + 3500

  if (reader) {
    try {
      while (true) {
        if (protocol === 'sse' && performance.now() > sseWindowDeadline) {
          await reader.cancel().catch(() => undefined)
          break
        }
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          if (totalBytes + value.byteLength > MAX_RESPONSE_BYTES) {
            const remaining = MAX_RESPONSE_BYTES - totalBytes
            if (remaining > 0) {
              chunks.push(value.subarray(0, remaining))
              totalBytes += remaining
            }
            truncated = true
            await reader.cancel()
            break
          }
          chunks.push(value)
          totalBytes += value.byteLength
        }
      }
    } catch {
      // SSE stream window closed cleanly
    }
  }

  const finishedAt = performance.now()
  const preBodyMs = Math.max(0, Math.round(headersReceivedAt - startedAt))
  const downloadMs = Math.max(0, Math.round(finishedAt - headersReceivedAt))
  const durationMs = Math.max(1, Math.round(finishedAt - startedAt + measuredDnsMs))

  let tcpMs = 0
  let tlsMs = 0
  let ttfbMs = preBodyMs
  let dnsMs = measuredDnsMs

  if (!isInternalSandboxRoute) {
    const perfEntries = performance.getEntriesByName(currentUrl.toString(), 'resource')
    const latestPerf = perfEntries.length > 0 ? perfEntries[perfEntries.length - 1] : undefined
    if (latestPerf && 'connectStart' in latestPerf && 'responseStart' in latestPerf) {
      const rt = latestPerf as PerformanceResourceTiming
      if (rt.domainLookupEnd > rt.domainLookupStart) {
        dnsMs = Math.max(dnsMs, Math.round(rt.domainLookupEnd - rt.domainLookupStart))
      }
      if (rt.connectEnd > rt.connectStart) {
        if (rt.secureConnectionStart > rt.connectStart) {
          tcpMs = Math.max(0, Math.round(rt.secureConnectionStart - rt.connectStart))
          tlsMs = Math.max(0, Math.round(rt.connectEnd - rt.secureConnectionStart))
        } else {
          tcpMs = Math.max(0, Math.round(rt.connectEnd - rt.connectStart))
        }
      }
      if (rt.responseStart > rt.requestStart) {
        ttfbMs = Math.max(0, Math.round(rt.responseStart - rt.requestStart))
      } else {
        ttfbMs = Math.max(0, preBodyMs - tcpMs - tlsMs)
      }
    }
  }

  const timings: RequestTimings = {
    dnsMs,
    tcpMs,
    tlsMs,
    ttfbMs,
    downloadMs,
    totalMs: durationMs,
  }
  const rawBuffer = Buffer.concat(chunks)
  const contentType = finalRes.headers.get('content-type') ?? ''
  let bodyText = rawBuffer.toString('utf8')

  let sseEvents: ExecuteRequestResponse['sseEvents']
  if (protocol === 'sse' || contentType.includes('text/event-stream')) {
    sseEvents = []
    const rawBlocks = bodyText.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0)
    for (const block of rawBlocks) {
      let evId = ''
      let evType = 'message'
      const dataLines: string[] = []
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('id:')) evId = line.slice(3).trim()
        else if (line.startsWith('event:')) evType = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (dataLines.length > 0 || evId) {
        sseEvents.push({
          id: evId || String(sseEvents.length + 1),
          event: evType,
          data: dataLines.join('\n'),
          receivedAt: new Date().toISOString(),
        })
      }
    }
  }

  let isJson = false
  let parsedJson: unknown = null
  if (
    contentType.includes('json') ||
    bodyText.trim().startsWith('{') ||
    bodyText.trim().startsWith('[')
  ) {
    try {
      parsedJson = JSON.parse(bodyText)
      bodyText = JSON.stringify(parsedJson, null, 2)
      isJson = true
    } catch {
      isJson = false
    }
  }

  const resHeaders: Record<string, string> = {}
  finalRes.headers.forEach((val, key) => {
    resHeaders[key] = val
  })

  const setCookies =
    typeof finalRes.headers.getSetCookie === 'function' ? finalRes.headers.getSetCookie() : []
  if (setCookies.length > 0) {
    await persistSetCookiesToJar(db, reqInput.workspaceId, currentUrl, setCookies)
  }
  const cookies = setCookies.map((rawCookie) => {
    const firstPart = rawCookie.split(';')[0] ?? ''
    const eq = firstPart.indexOf('=')
    return {
      name: eq > 0 ? firstPart.slice(0, eq).trim() : firstPart.trim(),
      value: eq > 0 ? firstPart.slice(eq + 1).trim() : '',
      raw: rawCookie,
    }
  })

  // 6. Post-Response Variable Extractors (No-Code `Vars` Tab) + Assertions + Scripts
  const postVarsUpdates = new Map<string, string>()
  const lowerResHeadersMap = new Map(
    Object.entries(resHeaders).map(([k, v]) => [k.toLowerCase(), v]),
  )
  for (const rule of reqInput.postResponseVars ?? []) {
    if (!rule.enabled) continue
    const varKey = rule.varName.trim()
    if (!varKey) continue

    let extracted: string | undefined
    const pathTrimmed = (rule.path ?? '').trim()

    if (rule.source === 'body') {
      if (isJson) {
        const val = readJsonPath(parsedJson, pathTrimmed)
        if (val !== undefined && val !== null) {
          extracted = typeof val === 'object' ? JSON.stringify(val) : String(val)
        }
      } else if (!pathTrimmed) {
        extracted = bodyText
      }
    } else if (rule.source === 'header') {
      if (pathTrimmed) {
        extracted = lowerResHeadersMap.get(pathTrimmed.toLowerCase())
      }
    } else if (rule.source === 'cookie') {
      if (pathTrimmed) {
        const foundCookie = cookies.find((c) => c.name === pathTrimmed)
        if (foundCookie) extracted = foundCookie.value
      }
    } else if (rule.source === 'status') {
      extracted = String(finalRes.status)
    }

    if (extracted !== undefined) {
      variableMap.set(varKey, extracted)
      postVarsUpdates.set(varKey, extracted)
      consoleLogs.push({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: `[vars] Captured {{${varKey}}} from ${rule.source}${pathTrimmed ? ` (${pathTrimmed})` : ''}`,
      })
    }
  }

  const declarativeResults = evaluateDeclarativeAssertions(reqInput.assertions, {
    status: finalRes.status,
    durationMs,
    headers: resHeaders,
    body: bodyText,
    parsedJson,
    isJson,
  })

  const testScriptOut = runSandboxedScript(reqInput.testScript ?? '', 'test', {
    variables: variableMap,
    requestHeaders: preHeaderMap,
    response: {
      status: finalRes.status,
      statusText: finalRes.statusText,
      durationMs,
      headers: resHeaders,
      body: bodyText,
      parsedJson,
      isJson,
    },
  })
  consoleLogs.push(...testScriptOut.logs)

  const schemaResult = evaluateJsonSchemaAssertion(reqInput.jsonSchema, parsedJson, isJson)

  const allAssertions: AssertionEvaluationResult[] = [
    ...declarativeResults,
    ...testScriptOut.assertions,
    ...(schemaResult ? [schemaResult] : []),
  ]

  // Merge and persist any environment variable updates from pre-request, post-vars, or post-response scripts
  const mergedEnvUpdates = new Map<string, string>([
    ...preScriptOut.updatedEnvironmentVars,
    ...postVarsUpdates,
    ...testScriptOut.updatedEnvironmentVars,
  ])
  const environmentUpdated = await persistScriptEnvironmentUpdates(
    runtime,
    reqInput.workspaceId,
    reqInput.environmentId,
    mergedEnvUpdates,
  )
  const updatedVariableKeys = environmentUpdated ? Array.from(mergedEnvUpdates.keys()) : []

  consoleLogs.push({
    timestamp: new Date().toISOString(),
    level: finalRes.status >= 400 ? 'warn' : 'info',
    message: `${finalRes.status} ${finalRes.statusText} (${durationMs} ms, ${totalBytes} B)`,
  })

  const sanitizedLogs = consoleLogs.map((l) => ({
    ...l,
    message: maskSecrets(l.message, secretValues),
  }))

  const historyId = crypto.randomUUID()
  const displayUrl =
    currentUrl.hostname === 'meofast.internal'
      ? `${currentUrl.pathname}${currentUrl.search}`
      : currentUrl.toString()
  const safeResolvedUrl = maskSecrets(displayUrl, secretValues)
  const reqSnapshot = buildSanitizedRequestSnapshot(
    reqInput,
    effectiveMethod,
    safeResolvedUrl,
    secretValues,
  )
  const safeResHeaders = sanitizeResponseHeaders(resHeaders, secretValues)
  const safeBodyPreview = maskSecrets(bodyText.slice(0, 65_000), secretValues)
  const nowIso = new Date().toISOString()

  await db
    .insertInto('request_history')
    .values({
      id: historyId,
      workspace_id: reqInput.workspaceId,
      user_id: userId,
      saved_request_id: reqInput.savedRequestId ?? null,
      method: effectiveMethod,
      url: safeResolvedUrl,
      request_snapshot_json: JSON.stringify(reqSnapshot),
      response_status: finalRes.status,
      response_status_text: finalRes.statusText,
      duration_ms: durationMs,
      response_size_bytes: totalBytes,
      response_headers_json: JSON.stringify(safeResHeaders),
      response_body_preview: safeBodyPreview,
      assertion_results_json: JSON.stringify(allAssertions),
      error_message: null,
      created_at: nowIso,
    })
    .execute()

  const failedAssertionsCount = allAssertions.filter((a) => !a.passed).length
  if (!iterationDataRow && (finalRes.status >= 400 || failedAssertionsCount > 0)) {
    const reasonParts: string[] = [`HTTP ${finalRes.status}`]
    if (failedAssertionsCount > 0) {
      reasonParts.push(
        `${failedAssertionsCount} test${failedAssertionsCount > 1 ? 's' : ''} failed`,
      )
    }
    reasonParts.push(`${durationMs} ms`)

    await db
      .insertInto('debug_capsules')
      .values({
        id: crypto.randomUUID(),
        workspace_id: reqInput.workspaceId,
        title: `${effectiveMethod} ${shortUrlLabel(safeResolvedUrl)} → ${finalRes.status}`,
        notes: `Auto-captured · ${reasonParts.join(' · ')}`,
        capsule_json: JSON.stringify({
          format: 'meofast.capsule.v1',
          autoCaptured: true,
          exportedAt: nowIso,
          request: reqSnapshot,
          response: {
            status: finalRes.status,
            statusText: finalRes.statusText,
            durationMs,
            sizeBytes: totalBytes,
            headers: safeResHeaders,
            body: safeBodyPreview,
            assertions: allAssertions,
            isJson,
            contentType,
          },
        }),
        created_by: userId,
        created_at: nowIso,
      })
      .execute()
  }

  return {
    historyId,
    resolvedUrl: safeResolvedUrl,
    status: finalRes.status,
    statusText: finalRes.statusText,
    durationMs,
    timings,
    sizeBytes: totalBytes,
    headers: resHeaders,
    cookies,
    body: bodyText,
    contentType,
    isJson,
    truncated,
    redirects,
    assertions: allAssertions,
    consoleLogs: sanitizedLogs,
    environmentUpdated,
    updatedVariableKeys,
    ...(sseEvents ? { sseEvents } : {}),
  }
}
