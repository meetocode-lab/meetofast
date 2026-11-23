import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { RuntimeContext } from '../src/core/bootstrap/runtime-context.js'

function extractCookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders.map((raw) => raw.split(';')[0]).join('; ')
}

describe('First-Time Installation Wizard, Setup Locking & End-to-End API Execution', () => {
  let tmpDir: string
  let runtime: RuntimeContext
  let upstreamServer: http.Server
  let upstreamPort: number

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meofast-e2e-'))
    runtime = new RuntimeContext(tmpDir)
    await runtime.initializeFromDisk()

    upstreamServer = http.createServer((req, res) => {
      const auth = req.headers.authorization ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Upstream-Engine': 'MeofastTest' })
      res.end(
        JSON.stringify({
          ok: true,
          method: req.method,
          url: req.url,
          authReceived: auth,
        }),
      )
    })
    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => resolve())
    })
    upstreamPort = (upstreamServer.address() as AddressInfo).port
  })

  afterEach(async () => {
    await runtime.shutdown()
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('completes browser setup flow, locks setup permanently, survives restart, and executes real API requests', async () => {
    const app = createApp(runtime)

    // 1. Operational routes return 503 SETUP_REQUIRED before setup
    const preAuthRes = await app.request('/api/v1/workspaces')
    expect(preAuthRes.status).toBe(503)

    // 2. Fetch setup status & bootstrap CSRF token
    const statusRes = await app.request('/api/v1/setup/status')
    expect(statusRes.status).toBe(200)
    const statusBody = (await statusRes.json()) as { installed: boolean; csrfToken: string }
    expect(statusBody.installed).toBe(false)
    expect(statusBody.csrfToken.length).toBeGreaterThan(16)
    const setupCookie = extractCookieHeader(statusRes.headers.getSetCookie())

    // 3. Reject setup calls missing CSRF token
    const noCsrfRes = await app.request('/api/v1/setup/validate-db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: setupCookie },
      body: JSON.stringify({ engine: 'sqlite', storageDir: tmpDir, filename: 'meofast.sqlite' }),
    })
    expect(noCsrfRes.status).toBe(403)

    // 4. Validate SQLite database connection
    const validateRes = await app.request('/api/v1/setup/validate-db', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: setupCookie,
        'X-CSRF-Token': statusBody.csrfToken,
      },
      body: JSON.stringify({ engine: 'sqlite', storageDir: tmpDir, filename: 'meofast.sqlite' }),
    })
    expect(validateRes.status).toBe(200)
    const validateJson = (await validateRes.json()) as { valid: boolean }
    expect(validateJson.valid).toBe(true)

    // 5. Execute full installation
    const execRes = await app.request('/api/v1/setup/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: setupCookie,
        'X-CSRF-Token': statusBody.csrfToken,
      },
      body: JSON.stringify({
        database: { engine: 'sqlite', storageDir: tmpDir, filename: 'meofast.sqlite' },
        admin: {
          fullName: 'Davin Admin',
          email: 'admin@meofast.local',
          username: 'davinadmin',
          password: 'SuperSecure#2026Password',
          confirmPassword: 'SuperSecure#2026Password',
        },
        appConfig: {
          appName: 'Meofast Studio',
          publicUrl: 'http://localhost:3000',
          timezone: 'Asia/Jakarta',
          language: 'en',
          organizationName: 'Meocode Engineering',
        },
      }),
    })
    expect(execRes.status).toBe(200)
    const execJson = (await execRes.json()) as { installed: boolean; csrfToken: string }
    expect(execJson.installed).toBe(true)

    const sessionCookie = extractCookieHeader(execRes.headers.getSetCookie())
    const sessionCsrf = execJson.csrfToken

    // 6. Verify setup is permanently locked (403 INSTALLATION_LOCKED)
    const lockedRes = await app.request('/api/v1/setup/validate-db', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: setupCookie,
        'X-CSRF-Token': statusBody.csrfToken,
      },
      body: JSON.stringify({ engine: 'sqlite', storageDir: tmpDir, filename: 'second.sqlite' }),
    })
    expect(lockedRes.status).toBe(403)

    // 7. Simulate container restart and verify state persists from disk
    await runtime.shutdown()
    const restartedRuntime = new RuntimeContext(tmpDir)
    await restartedRuntime.initializeFromDisk()
    expect(restartedRuntime.isInstalled()).toBe(true)
    expect(restartedRuntime.getConfiguredEngine()).toBe('sqlite')
    runtime = restartedRuntime

    const restartedApp = createApp(restartedRuntime)

    // 8. Authenticated /me check
    const meRes = await restartedApp.request('/api/v1/auth/me', {
      headers: { Cookie: sessionCookie },
    })
    expect(meRes.status).toBe(200)
    const meJson = (await meRes.json()) as {
      appName: string
      workspaces: Array<{ id: string; name: string }>
    }
    expect(meJson.appName).toBe('Meofast Studio')
    expect(meJson.workspaces.length).toBe(1)
    const workspaceId = meJson.workspaces[0]!.id

    // 9. Authorize localhost in Admin Network Policy so company local service can be tested
    const settingsRes = await restartedApp.request('/api/v1/admin/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'X-CSRF-Token': sessionCsrf,
      },
      body: JSON.stringify({
        appName: 'Meofast Studio',
        publicUrl: 'http://localhost:3000',
        registrationMode: 'invite_only',
        networkPolicy: {
          allowPrivateNetworks: false,
          allowLocalhost: true,
          allowedCidrs: [],
          allowedDomains: [],
        },
      }),
    })
    expect(settingsRes.status).toBe(200)

    // 10. Create Environment with encrypted secret variable
    const envRes = await restartedApp.request(`/api/v1/workspaces/${workspaceId}/environments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'X-CSRF-Token': sessionCsrf,
      },
      body: JSON.stringify({
        name: 'Local Integration Env',
        isGlobal: false,
        variables: [
          { key: 'localHost', value: `http://127.0.0.1:${upstreamPort}`, isSecret: false, enabled: true },
          { key: 'secretToken', value: 'top-secret-jwt-999', isSecret: true, enabled: true },
        ],
      }),
    })
    expect(envRes.status).toBe(201)
    const { id: envId } = (await envRes.json()) as { id: string }

    // 11. Execute outbound API request with {{localHost}} & encrypted {{secretToken}} + assertions
    const proxyRes = await restartedApp.request('/api/v1/proxy/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'X-CSRF-Token': sessionCsrf,
      },
      body: JSON.stringify({
        workspaceId,
        environmentId: envId,
        method: 'GET',
        url: '{{localHost}}/v1/ping',
        queryParams: [{ id: 'q1', key: 'env', value: 'ci', description: '', enabled: true }],
        headers: [],
        pathVariables: [],
        auth: { type: 'bearer', token: '{{secretToken}}', prefix: 'Bearer' },
        body: { mode: 'none', raw: '', urlencoded: [], multipart: [] },
        assertions: [
          { id: 'a1', type: 'status_equals', target: '', expected: '200', enabled: true },
          {
            id: 'a2',
            type: 'header_equals',
            target: 'X-Upstream-Engine',
            expected: 'MeofastTest',
            enabled: true,
          },
          { id: 'a3', type: 'json_path_equals', target: 'ok', expected: 'true', enabled: true },
        ],
        timeoutMs: 5000,
        followRedirects: true,
      }),
    })
    expect(proxyRes.status).toBe(200)
    const proxyJson = (await proxyRes.json()) as {
      status: number
      body: string
      assertions: Array<{ passed: boolean }>
    }
    expect(proxyJson.status).toBe(200)
    expect(proxyJson.assertions.every((a) => a.passed)).toBe(true)
    const parsedUpstream = JSON.parse(proxyJson.body) as { authReceived: string; url: string }
    expect(parsedUpstream.authReceived).toBe('Bearer top-secret-jwt-999')
    expect(parsedUpstream.url).toBe('/v1/ping?env=ci')
  })
})
