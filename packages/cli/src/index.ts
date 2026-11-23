#!/usr/bin/env node
import fs from 'node:fs'
import { type CliRunItem, type CliRunReport, renderHtmlReport, renderJunitXmlReport } from './reporters.js'

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const val = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true'
      flags[key] = val
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, key: string) => {
    const k = key.trim()
    return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k]! : full
  })
}

async function runLocalCollectionFile(filePath: string, envPath?: string): Promise<CliRunReport> {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
  const vars: Record<string, string> = {}

  if (envPath && fs.existsSync(envPath)) {
    const envRaw = fs.readFileSync(envPath, 'utf8').trim()
    if (envRaw.startsWith('{')) {
      const envJson = JSON.parse(envRaw) as {
        values?: Array<{ key?: string; value?: string; enabled?: boolean }>
      }
      for (const v of envJson.values ?? []) {
        if (v.key && v.enabled !== false) vars[v.key] = String(v.value ?? '')
      }
    } else {
      for (const line of envRaw.split(/\r?\n/)) {
        const idx = line.indexOf('=')
        if (idx > 0 && !line.trim().startsWith('#')) {
          vars[line.slice(0, idx).trim()] = line
            .slice(idx + 1)
            .trim()
            .replace(/^['"]|['"]$/g, '')
        }
      }
    }
  }

  const info = (raw.info ?? {}) as { name?: string }
  const collectionName = String(raw.name ?? info.name ?? 'Meofast Collection')

  interface RawReq {
    name?: string
    method?: string
    url?: string | { raw?: string }
    headers?: Array<{ key?: string; value?: string; enabled?: boolean }>
    body?: { mode?: string; raw?: string }
    request?: {
      method?: string
      url?: string | { raw?: string }
      header?: Array<{ key?: string; value?: string; disabled?: boolean }>
      body?: { raw?: string }
    }
  }

  const rawItems = (Array.isArray(raw.requests) ? raw.requests : Array.isArray(raw.item) ? raw.item : []) as RawReq[]
  const items: CliRunItem[] = []
  const started = performance.now()

  for (const r of rawItems) {
    const method = String(r.method ?? r.request?.method ?? 'GET').toUpperCase()
    const rawUrlObj = r.url ?? r.request?.url ?? ''
    const urlStr = interpolate(
      typeof rawUrlObj === 'string' ? rawUrlObj : String(rawUrlObj.raw ?? ''),
      vars,
    )
    const hdrs = new Headers()
    for (const h of r.headers ?? []) {
      if (h.key && h.enabled !== false) hdrs.set(h.key, interpolate(String(h.value ?? ''), vars))
    }
    for (const h of r.request?.header ?? []) {
      if (h.key && !h.disabled) hdrs.set(h.key, interpolate(String(h.value ?? ''), vars))
    }

    const bodyText = r.body?.raw ?? r.request?.body?.raw ?? ''
    const reqStarted = performance.now()

    try {
      const res = await fetch(urlStr, {
        method,
        headers: hdrs,
        body: method !== 'GET' && method !== 'HEAD' && bodyText ? interpolate(bodyText, vars) : undefined,
        signal: AbortSignal.timeout(20000),
      })
      await res.body?.cancel().catch(() => undefined)
      const durationMs = Math.round(performance.now() - reqStarted)
      const passed = res.status >= 200 && res.status < 400
      items.push({
        name: String(r.name ?? `${method} ${urlStr}`),
        method,
        url: urlStr,
        status: res.status,
        durationMs,
        passed,
        ...(passed ? {} : { error: `HTTP ${res.status}` }),
      })
    } catch (err) {
      items.push({
        name: String(r.name ?? `${method} ${urlStr}`),
        method,
        url: urlStr,
        status: null,
        durationMs: Math.round(performance.now() - reqStarted),
        passed: false,
        error: err instanceof Error ? err.message : 'Request failed',
      })
    }
  }

  const passedRequests = items.filter((i) => i.passed).length
  return {
    collectionName,
    totalRequests: items.length,
    passedRequests,
    failedRequests: items.length - passedRequests,
    totalDurationMs: Math.round(performance.now() - started),
    items,
  }
}

async function runRemoteCollection(params: {
  serverUrl: string
  token: string
  collectionId: string
  environmentId?: string
}): Promise<CliRunReport> {
  const base = params.serverUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/api/v1/collections/${params.collectionId}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      environmentId: params.environmentId ?? null,
      delayMs: 0,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Server returned ${res.status}: ${text}`)
  }

  const data = (await res.json()) as {
    collectionName: string
    totalRequests: number
    passedRequests: number
    failedRequests: number
    totalDurationMs: number
    items: Array<{
      requestName: string
      method: string
      resolvedUrl: string
      status: number | null
      durationMs: number
      passed: boolean
      error?: string
    }>
  }

  return {
    collectionName: data.collectionName,
    totalRequests: data.totalRequests,
    passedRequests: data.passedRequests,
    failedRequests: data.failedRequests,
    totalDurationMs: data.totalDurationMs,
    items: data.items.map((it) => ({
      name: it.requestName,
      method: it.method,
      url: it.resolvedUrl,
      status: it.status,
      durationMs: it.durationMs,
      passed: it.passed,
      ...(it.error ? { error: it.error } : {}),
    })),
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  const cmd = positional[0]

  if (!cmd || cmd === 'help' || flags.help) {
    console.log(`Meofast CLI v1.0.0 — Self-Hosted API Collection & CI/CD Runner

Usage:
  meofast run <collection.json> [--env <.env|env.json>] [--report-junit junit.xml] [--report-html report.html] [--report-json out.json]
  meofast run --server <url> --token <mf_pat_...> --collection <id> [--env-id <id>] [--report-junit junit.xml]`)
    return 0
  }

  if (cmd !== 'run') {
    console.error(`Unknown command: ${cmd}`)
    return 1
  }

  let report: CliRunReport
  if (flags.server && flags.token && flags.collection) {
    report = await runRemoteCollection({
      serverUrl: flags.server,
      token: flags.token,
      collectionId: flags.collection,
      environmentId: flags['env-id'],
    })
  } else if (positional[1]) {
    report = await runLocalCollectionFile(positional[1], flags.env)
  } else {
    console.error('Provide either a <collection.json> path or --server, --token, and --collection.')
    return 1
  }

  for (const item of report.items) {
    const tag = item.passed ? '[PASS]' : '[FAIL]'
    console.log(`${tag} ${item.method} ${item.name} -> ${item.status ?? 'ERR'} (${item.durationMs} ms)`)
  }
  console.log(
    `\nSummary: ${report.passedRequests}/${report.totalRequests} passed in ${report.totalDurationMs} ms`,
  )

  if (flags['report-json']) {
    fs.writeFileSync(flags['report-json'], JSON.stringify(report, null, 2), 'utf8')
  }
  if (flags['report-junit']) {
    fs.writeFileSync(flags['report-junit'], renderJunitXmlReport(report), 'utf8')
  }
  if (flags['report-html']) {
    fs.writeFileSync(flags['report-html'], renderHtmlReport(report), 'utf8')
  }

  return report.failedRequests > 0 ? 1 : 0
}

const isDirectExec =
  process.argv[1] &&
  (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('meofast'))

if (isDirectExec) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[Meofast CLI Error]', err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
}
