import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { RuntimeContext } from '../src/core/bootstrap/runtime-context.js'

function extractCookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders.map((raw) => raw.split(';')[0]).join('; ')
}

describe('Server-Side Table Search, Row Size, Pagination, Sorting & Rename Endpoints', () => {
  let tmpDir: string
  let runtime: RuntimeContext

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meofast-pagination-'))
    runtime = new RuntimeContext(tmpDir)
    await runtime.initializeFromDisk()
  })

  afterEach(async () => {
    await runtime.shutdown()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('paginates, searches, sorts, clamps pages, compares encrypted secrets, and renames entities server-side', async () => {
    const app = createApp(runtime)

    const st = await app.request('/api/v1/setup/status')
    const stBody = (await st.json()) as { csrfToken: string }
    const setupCookie = extractCookieHeader(st.headers.getSetCookie())

    const exec = await app.request('/api/v1/setup/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: setupCookie,
        'X-CSRF-Token': stBody.csrfToken,
      },
      body: JSON.stringify({
        database: { engine: 'sqlite', storageDir: tmpDir, filename: 'page.sqlite' },
        admin: {
          fullName: 'Davin Metoti',
          email: 'admin@meofast.org',
          username: 'davin',
          password: 'SuperSecure#2026Password',
          confirmPassword: 'SuperSecure#2026Password',
        },
        appConfig: {
          appName: 'Meofast',
          publicUrl: 'http://localhost:4780',
          timezone: 'Asia/Jakarta',
          language: 'en',
          organizationName: 'Meocode',
        },
      }),
    })
    expect(exec.status).toBe(200)
    const execBody = (await exec.json()) as { csrfToken: string }
    const sessionCookie = extractCookieHeader(exec.headers.getSetCookie())
    const authHeaders = {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
      'X-CSRF-Token': execBody.csrfToken,
    }

    const meRes = await app.request('/api/v1/auth/me', { headers: { Cookie: sessionCookie } })
    const meJson = (await meRes.json()) as { workspaces: Array<{ id: string; name: string }> }
    const wsId = meJson.workspaces[0]!.id

    // 1. Rename Workspace via PATCH /api/v1/workspaces/:id
    const renameWsRes = await app.request(`/api/v1/workspaces/${wsId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Platform Core Workspace' }),
    })
    expect(renameWsRes.status).toBe(200)

    // 2. Create 7 Personal API Tokens and verify server-side search, pageSize, page, and sort
    const tokenNames = [
      'Gamma Runner',
      'Alpha Pipeline',
      'Beta Deploy',
      'Delta Canary',
      'Epsilon Nightly',
      'Zeta Audit',
      'Alpha Secondary',
    ]
    let firstTokenId = ''
    for (const name of tokenNames) {
      const r = await app.request('/api/v1/auth/tokens', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name }),
      })
      expect(r.status).toBe(201)
      const body = (await r.json()) as { id: string }
      if (!firstTokenId) firstTokenId = body.id
    }

    // Rename first token
    const renameTok = await app.request(`/api/v1/auth/tokens/${firstTokenId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Gamma Renamed Runner' }),
    })
    expect(renameTok.status).toBe(200)

    // Page 1 with pageSize=5 sorted by name ASC
    const page1Res = await app.request(
      '/api/v1/auth/tokens?page=1&pageSize=5&sortBy=name&sortDir=asc',
      { headers: { Cookie: sessionCookie } },
    )
    expect(page1Res.status).toBe(200)
    const page1 = (await page1Res.json()) as {
      items: Array<{ name: string }>
      total: number
      page: number
      pageSize: number
    }
    expect(page1.total).toBe(7)
    expect(page1.page).toBe(1)
    expect(page1.pageSize).toBe(5)
    expect(page1.items.map((t) => t.name)).toEqual([
      'Alpha Pipeline',
      'Alpha Secondary',
      'Beta Deploy',
      'Delta Canary',
      'Epsilon Nightly',
    ])

    // Page 2 with pageSize=5 sorted by name ASC -> remaining 2 items
    const page2Res = await app.request(
      '/api/v1/auth/tokens?page=2&pageSize=5&sortBy=name&sortDir=asc',
      { headers: { Cookie: sessionCookie } },
    )
    const page2 = (await page2Res.json()) as { items: Array<{ name: string }>; page: number }
    expect(page2.page).toBe(2)
    expect(page2.items.map((t) => t.name)).toEqual(['Gamma Renamed Runner', 'Zeta Audit'])

    // Out-of-range page (page=99) clamps safely to last valid page (page=2)
    const clampedRes = await app.request(
      '/api/v1/auth/tokens?page=99&pageSize=5&sortBy=name&sortDir=asc',
      { headers: { Cookie: sessionCookie } },
    )
    const clamped = (await clampedRes.json()) as { items: Array<{ name: string }>; page: number }
    expect(clamped.page).toBe(2)
    expect(clamped.items).toHaveLength(2)

    // Server-side search q=alpha
    const searchRes = await app.request(
      '/api/v1/auth/tokens?q=alpha&page=1&pageSize=10&sortBy=name&sortDir=desc',
      { headers: { Cookie: sessionCookie } },
    )
    const searchJson = (await searchRes.json()) as {
      items: Array<{ name: string }>
      total: number
    }
    expect(searchJson.total).toBe(2)
    expect(searchJson.items.map((t) => t.name)).toEqual(['Alpha Secondary', 'Alpha Pipeline'])

    // 3. Server-side Audit Events pagination & search
    const auditRes = await app.request(
      '/api/v1/admin/audit-events?q=workspace.renamed&page=1&pageSize=5',
      { headers: { Cookie: sessionCookie } },
    )
    expect(auditRes.status).toBe(200)
    const auditJson = (await auditRes.json()) as {
      items: Array<{ action: string }>
      total: number
    }
    expect(auditJson.total).toBeGreaterThanOrEqual(1)
    expect(auditJson.items[0]!.action).toBe('workspace.renamed')

    // 4. Server-side Environment Comparison (including AES-256-GCM secret equality)
    const envARes = await app.request(`/api/v1/workspaces/${wsId}/environments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Staging',
        isGlobal: false,
        variables: [
          { key: 'API_KEY', value: 'sec_same_123', isSecret: true, enabled: true },
          { key: 'SIGN_SECRET', value: 'sec_left_only', isSecret: true, enabled: true },
          { key: 'BASE_URL', value: 'https://staging.example.com', isSecret: false, enabled: true },
        ],
      }),
    })
    const envA = (await envARes.json()) as { id: string }

    const envBRes = await app.request(`/api/v1/workspaces/${wsId}/environments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Production',
        isGlobal: false,
        variables: [
          { key: 'API_KEY', value: 'sec_same_123', isSecret: true, enabled: true },
          { key: 'SIGN_SECRET', value: 'sec_right_diff', isSecret: true, enabled: true },
          { key: 'BASE_URL', value: 'https://api.example.com', isSecret: false, enabled: true },
        ],
      }),
    })
    const envB = (await envBRes.json()) as { id: string }

    const cmpRes = await app.request(
      `/api/v1/environments/compare?leftId=${envA.id}&rightId=${envB.id}&page=1&pageSize=5&sortBy=key&sortDir=asc`,
      { headers: { Cookie: sessionCookie } },
    )
    expect(cmpRes.status).toBe(200)
    const cmpJson = (await cmpRes.json()) as {
      items: Array<{ key: string; state: string; left: { value: string } | null }>
      total: number
    }
    expect(cmpJson.total).toBe(3)
    const apiKeyRow = cmpJson.items.find((r) => r.key === 'API_KEY')!
    const signRow = cmpJson.items.find((r) => r.key === 'SIGN_SECRET')!
    expect(apiKeyRow.state).toBe('same')
    expect(apiKeyRow.left?.value).toBe('') // Never leaks decrypted secret to client
    expect(signRow.state).toBe('different')

    // 4. Verify Proxy Execution never duplicates query params when both URL & queryParams are synced
    const mockCreateRes = await app.request(`/api/v1/workspaces/${wsId}/mocks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Forecast Echo Mock',
        method: 'GET',
        pathPattern: '/forecast',
        statusCode: 200,
        responseBody: '{"ok":true}',
      }),
    })
    expect(mockCreateRes.status).toBe(201)

    const execProxyRes = await app.request('/api/v1/proxy/execute', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId: wsId,
        protocol: 'http',
        method: 'GET',
        url: `/api/v1/mock/${wsId}/forecast?latitude=-6.2&longitude=106.8&current=temperature_2m`,
        queryParams: [
          { id: '1', key: 'latitude', value: '-6.2', enabled: true },
          { id: '2', key: 'longitude', value: '106.8', enabled: true },
          { id: '3', key: 'current', value: 'temperature_2m', enabled: true },
        ],
        headers: [],
        pathVariables: [],
        auth: { type: 'none' },
        body: { mode: 'none', raw: '', urlencoded: [], multipart: [] },
        assertions: [],
      }),
    })
    expect(execProxyRes.status).toBe(200)
    const execProxyJson = (await execProxyRes.json()) as { resolvedUrl: string }
    expect(execProxyJson.resolvedUrl).toContain(
      '/forecast?latitude=-6.2&longitude=106.8&current=temperature_2m',
    )
    expect(execProxyJson.resolvedUrl.match(/latitude=/g)?.length).toBe(1)
    expect(execProxyJson.resolvedUrl.match(/longitude=/g)?.length).toBe(1)
    expect(execProxyJson.resolvedUrl.match(/current=/g)?.length).toBe(1)
  })
})
