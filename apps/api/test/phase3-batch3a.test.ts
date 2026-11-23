import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { RuntimeContext } from '../src/core/bootstrap/runtime-context.js'
import { evaluateJsonSchemaAssertion } from '../src/modules/proxy/json-schema-validator.js'
import { runSandboxedScript } from '../src/modules/proxy/script-sandbox.js'

function extractCookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders.map((raw) => raw.split(';')[0]).join('; ')
}

describe('Phase 3 Batch 3A — Script Sandbox, JSON Schema, OpenAPI & Collection Runner', () => {
  it('isolates scripts, blocks infinite loops, and evaluates pm.test / pm.expect', () => {
    const vars = new Map<string, string>([['envName', 'staging']])
    const reqHeaders = new Map<string, string>()

    const out = runSandboxedScript(
      `
      pm.environment.set("chainedToken", "tok_abc_123");
      pm.request.headers.add({ key: "X-Script-Header", value: "active" });
      pm.test("Status is 200 and JSON matches", () => {
        pm.expect(pm.response.code).to.equal(200);
        pm.expect(pm.response.json()).to.have.property("ok", true);
      });
      `,
      'test',
      {
        variables: vars,
        requestHeaders: reqHeaders,
        response: {
          status: 200,
          statusText: 'OK',
          durationMs: 42,
          headers: { 'content-type': 'application/json' },
          body: '{"ok":true}',
          parsedJson: { ok: true },
          isJson: true,
        },
      },
    )

    expect(out.updatedEnvironmentVars.get('chainedToken')).toBe('tok_abc_123')
    expect(out.addedHeaders).toEqual([{ key: 'X-Script-Header', value: 'active' }])
    expect(out.assertions).toHaveLength(1)
    expect(out.assertions[0]?.passed).toBe(true)

    // Infinite loop protection
    const timeoutOut = runSandboxedScript('while (true) {}', 'test', {
      variables: vars,
      requestHeaders: reqHeaders,
    })
    expect(timeoutOut.assertions[0]?.passed).toBe(false)
  })

  it('validates response payloads against JSON Schema rules', () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['id', 'tags'],
      properties: {
        id: { type: 'integer', minimum: 1 },
        tags: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
    })

    const passRes = evaluateJsonSchemaAssertion(schema, { id: 7, tags: ['core'] }, true)
    expect(passRes?.passed).toBe(true)

    const failRes = evaluateJsonSchemaAssertion(schema, { id: 'bad', tags: [] }, true)
    expect(failRes?.passed).toBe(false)
    expect(failRes?.actual).toContain('$.id')
  })

  describe('OpenAPI 3.0 Import/Export, Drag-and-Drop Move & Collection Runner E2E', () => {
    let tmpDir: string
    let runtime: RuntimeContext
    let upstream: http.Server
    let port: number

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meofast-p3-'))
      runtime = new RuntimeContext(tmpDir)
      await runtime.initializeFromDisk()

      upstream = http.createServer((req, res) => {
        if (req.url?.startsWith('/auth/token')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ accessToken: 'chained-jwt-777' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 101,
            receivedAuth: req.headers.authorization ?? null,
            path: req.url,
          }),
        )
      })
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
      port = (upstream.address() as AddressInfo).port
    })

    afterEach(async () => {
      await runtime.shutdown()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('imports OpenAPI 3.0, reorders requests, chains script tokens in Collection Runner, and exports OpenAPI', async () => {
      const app = createApp(runtime)

      // Setup instance
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
          database: { engine: 'sqlite', storageDir: tmpDir, filename: 'p3.sqlite' },
          admin: {
            fullName: 'Davin',
            email: 'admin@meofast.local',
            username: 'davin',
            password: 'SuperSecure#2026Password',
            confirmPassword: 'SuperSecure#2026Password',
          },
          appConfig: {
            appName: 'Meofast',
            publicUrl: 'http://localhost:3000',
            timezone: 'UTC',
            language: 'en',
            organizationName: 'Meocode',
          },
        }),
      })
      const execBody = (await exec.json()) as { csrfToken: string }
      const sessionCookie = extractCookieHeader(exec.headers.getSetCookie())
      const csrf = execBody.csrfToken

      const meRes = await app.request('/api/v1/auth/me', { headers: { Cookie: sessionCookie } })
      const meJson = (await meRes.json()) as { workspaces: Array<{ id: string }> }
      const wsId = meJson.workspaces[0]!.id

      // Enable localhost access for test server
      await app.request('/api/v1/admin/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({
          appName: 'Meofast',
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

      // Import OpenAPI 3.0 Spec
      const openApiSpec = {
        openapi: '3.0.3',
        info: { title: 'Orders Microservice' },
        servers: [{ url: `http://127.0.0.1:${port}` }],
        paths: {
          '/auth/token': {
            post: {
              tags: ['Auth'],
              summary: 'Issue Token',
            },
          },
          '/orders/{orderId}': {
            get: {
              tags: ['Orders'],
              summary: 'Get Order Details',
              parameters: [{ name: 'orderId', in: 'path', required: true, schema: { default: '42' } }],
            },
          },
        },
      }

      const impRes = await app.request(`/api/v1/workspaces/${wsId}/collections/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({
          mode: 'openapi',
          content: JSON.stringify(openApiSpec),
        }),
      })
      expect(impRes.status).toBe(201)
      const { importedCollectionId } = (await impRes.json()) as { importedCollectionId: string }

      // Verify imported tree
      const treeRes = await app.request(`/api/v1/workspaces/${wsId}/tree`, {
        headers: { Cookie: sessionCookie },
      })
      const treeJson = (await treeRes.json()) as {
        collections: Array<{
          id: string
          folders: Array<{ id: string; name: string }>
          requests: Array<{ id: string; name: string; method: string; url: string; pathVariables: Array<{ key: string; value: string }> }>
        }>
      }
      const importedCol = treeJson.collections.find((c) => c.id === importedCollectionId)!
      expect(importedCol.folders.map((f) => f.name)).toEqual(['Auth', 'Orders'])
      expect(importedCol.requests).toHaveLength(2)

      // Update Step 1 ('Issue Token') with testScript that stores token into environment,
      // and Step 2 ('Get Order Details') with Bearer {{chainedJwt}} + JSON Schema!
      const authReq = importedCol.requests.find((r) => r.name === 'Issue Token')!
      const orderReq = importedCol.requests.find((r) => r.name === 'Get Order Details')!

      await app.request(`/api/v1/requests/${authReq.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({
          workspaceId: wsId,
          collectionId: importedCollectionId,
          name: 'Issue Token',
          method: 'POST',
          url: '{{baseUrl}}/auth/token',
          testScript: 'pm.environment.set("chainedJwt", pm.response.json().accessToken);',
          sortOrder: 0,
        }),
      })

      await app.request(`/api/v1/requests/${orderReq.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({
          workspaceId: wsId,
          collectionId: importedCollectionId,
          name: 'Get Order Details',
          method: 'GET',
          url: '{{baseUrl}}/orders/:orderId',
          pathVariables: [{ id: 'p1', key: 'orderId', value: '{{rowOrderId}}', enabled: true }],
          auth: { type: 'bearer', token: '{{chainedJwt}}', prefix: 'Bearer' },
          testScript:
            'pm.test("Chained token arrived", () => { pm.expect(pm.response.json().receivedAuth).to.equal("Bearer chained-jwt-777"); });',
          jsonSchema: JSON.stringify({
            type: 'object',
            required: ['id', 'receivedAuth'],
            properties: { id: { type: 'integer' } },
          }),
          sortOrder: 1,
        }),
      })

      // Run Collection Runner with 2 data rows
      const runRes = await app.request(`/api/v1/collections/${importedCollectionId}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({
          dataRows: [{ rowOrderId: '9001' }, { rowOrderId: '9002' }],
        }),
      })
      expect(runRes.status).toBe(200)
      const summary = (await runRes.json()) as {
        iterations: number
        totalRequests: number
        failedRequests: number
        passedRequests: number
      }
      expect(summary.iterations).toBe(2)
      expect(summary.totalRequests).toBe(4)
      expect(summary.failedRequests).toBe(0)
      expect(summary.passedRequests).toBe(4)

      // Export back as OpenAPI 3.0.3
      const expRes = await app.request(
        `/api/v1/collections/${importedCollectionId}/export?format=openapi`,
        {
          headers: { Cookie: sessionCookie },
        },
      )
      expect(expRes.status).toBe(200)
      const expJson = (await expRes.json()) as { openapi: string; paths: Record<string, unknown> }
      expect(expJson.openapi).toBe('3.0.3')
      expect(Object.keys(expJson.paths)).toContain('/orders/{orderId}')
    })
  })
})
