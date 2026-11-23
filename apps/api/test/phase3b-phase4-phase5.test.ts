import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHtmlReport, renderJunitXmlReport } from '../../../packages/cli/src/reporters.js'
import { createApp } from '../src/app.js'
import { RuntimeContext } from '../src/core/bootstrap/runtime-context.js'
import {
  applyAwsSigV4Headers,
  buildDigestAuthorizationHeader,
  buildOAuth1AuthorizationHeader,
} from '../src/modules/proxy/advanced-auth.js'

function extractCookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders.map((raw) => raw.split(';')[0]).join('; ')
}

describe('Phase 3B, Phase 4 & Phase 5 — Full Platform Capabilities', () => {
  it('computes AWS SigV4, OAuth 1.0a, Digest Auth headers, and CLI JUnit/HTML reports', () => {
    const headers = new Headers()
    applyAwsSigV4Headers({
      method: 'POST',
      url: new URL('https://execute-api.us-east-1.amazonaws.com/v1/orders?page=1'),
      headers,
      bodyPayload: '{"item":"book"}',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'execute-api',
      now: new Date('2026-01-01T00:00:00Z'),
    })
    expect(headers.get('authorization')).toContain('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE')
    expect(headers.get('x-amz-date')).toBe('20260101T000000Z')

    const oauth1 = buildOAuth1AuthorizationHeader({
      method: 'GET',
      url: new URL('https://api.example.com/v1/resource'),
      consumerKey: 'ck_123',
      consumerSecret: 'cs_456',
      token: 'tok_789',
      tokenSecret: 'ts_000',
    })
    expect(oauth1).toContain('OAuth oauth_consumer_key="ck_123"')
    expect(oauth1).toContain('oauth_signature=')

    const digest = buildDigestAuthorizationHeader({
      wwwAuthenticateHeader:
        'Digest realm="meofast", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
      method: 'GET',
      uriPathWithQuery: '/dir/index.html',
      username: 'Mufasa',
      password: 'Circle Of Life',
    })
    expect(digest).toContain('Digest username="Mufasa"')
    expect(digest).toContain('response="')

    const junit = renderJunitXmlReport({
      collectionName: 'Core Suite',
      totalRequests: 2,
      passedRequests: 1,
      failedRequests: 1,
      totalDurationMs: 120,
      items: [
        { name: 'Health', method: 'GET', url: 'http://localhost/health', status: 200, durationMs: 40, passed: true },
        { name: 'Create', method: 'POST', url: 'http://localhost/items', status: 500, durationMs: 80, passed: false, error: 'HTTP 500' },
      ],
    })
    expect(junit).toContain('<testsuites tests="2" failures="1"')
    expect(junit).toContain('<failure message="HTTP 500">')

    const htmlReport = renderHtmlReport({
      collectionName: 'Core Suite',
      totalRequests: 1,
      passedRequests: 1,
      failedRequests: 0,
      totalDurationMs: 25,
      items: [{ name: 'Health', method: 'GET', url: 'http://localhost/health', status: 200, durationMs: 25, passed: true }],
    })
    expect(htmlReport).toContain('<!DOCTYPE html>')
    expect(htmlReport).toContain('Core Suite')
  })

  describe('Multi-Protocol, Mock Server, Webhooks, Capsules, Monitors, Load Tests, Tokens & AI', () => {
    let tmpDir: string
    let runtime: RuntimeContext

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meofast-full-'))
      runtime = new RuntimeContext(tmpDir)
      await runtime.initializeFromDisk()
    })

    afterEach(async () => {
      await runtime.shutdown()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('runs end-to-end across Phase 3B, Phase 4, and Phase 5 features', async () => {
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
          database: { engine: 'sqlite', storageDir: tmpDir, filename: 'full.sqlite' },
          admin: {
            fullName: 'Davin Metoti',
            email: 'admin@meofast.org',
            username: 'davin',
            password: 'SuperSecure#2026Password',
            confirmPassword: 'SuperSecure#2026Password',
          },
          appConfig: {
            appName: 'Meofast',
            publicUrl: 'http://localhost:3000',
            timezone: 'Asia/Jakarta',
            language: 'en',
            organizationName: 'Meocode',
          },
        }),
      })
      expect(exec.status).toBe(200)
      const execBody = (await exec.json()) as { csrfToken: string }
      const sessionCookie = extractCookieHeader(exec.headers.getSetCookie())
      const csrf = execBody.csrfToken
      const authHeaders = {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'X-CSRF-Token': csrf,
      }

      const meRes = await app.request('/api/v1/auth/me', { headers: { Cookie: sessionCookie } })
      const meJson = (await meRes.json()) as { workspaces: Array<{ id: string; slug: string }> }
      const wsId = meJson.workspaces[0]!.id
      const wsSlug = meJson.workspaces[0]!.slug

      // 1. OAuth 2.0 Token Fetcher
      const oauthRes = await app.request('/api/v1/proxy/oauth2/token', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: wsId,
          grantType: 'client_credentials',
          tokenUrl: '/api/v1/playground/oauth/token',
          clientId: 'demo-client',
          clientSecret: 'demo-secret',
        }),
      })
      expect(oauthRes.status).toBe(200)
      const oauthJson = (await oauthRes.json()) as { accessToken: string }
      expect(oauthJson.accessToken).toContain('mf_oauth_client_credentials_')

      // 2. GraphQL Introspection & Execution
      const gqlIntro = await app.request('/api/v1/proxy/graphql/introspect', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: wsId,
          url: '/api/v1/playground/graphql',
        }),
      })
      expect(gqlIntro.status).toBe(200)
      const gqlExec = await app.request('/api/v1/proxy/execute', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: wsId,
          protocol: 'graphql',
          method: 'POST',
          url: '/api/v1/playground/graphql',
          graphql: {
            query: 'query { users { id name } }',
            variables: '{}',
          },
        }),
      })
      expect(gqlExec.status).toBe(200)
      const gqlExecBody = (await gqlExec.json()) as { body: string; status: number }
      expect(gqlExecBody.status).toBe(200)
      expect(gqlExecBody.body).toContain('Davin Metoti')

      // 3. SSE Stream Execution
      const sseExec = await app.request('/api/v1/proxy/execute', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: wsId,
          protocol: 'sse',
          method: 'GET',
          url: '/api/v1/playground/sse',
        }),
      })
      expect(sseExec.status).toBe(200)
      const sseBody = (await sseExec.json()) as { sseEvents?: Array<{ event: string }> }
      expect(sseBody.sseEvents?.length).toBe(3)
      expect(sseBody.sseEvents?.[0]?.event).toBe('connected')

      // 4. Interactive WebSocket Session
      const wsConn = await app.request('/api/v1/proxy/ws/connect', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: wsId,
          url: 'ws://meofast.local/echo',
        }),
      })
      expect(wsConn.status).toBe(201)
      const wsConnJson = (await wsConn.json()) as { sessionId: string }
      const wsSend = await app.request(`/api/v1/proxy/ws/${wsConnJson.sessionId}/send`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ message: '{"ping":true}' }),
      })
      expect(wsSend.status).toBe(200)
      const wsSendJson = (await wsSend.json()) as { messages: Array<{ direction: string; data: string }> }
      expect(wsSendJson.messages.some((m) => m.direction === 'received' && m.data.includes('"ping": true'))).toBe(true)

      // 5. Bruno Import + Static HTML & HAR Export
      const bruImport = await app.request(`/api/v1/workspaces/${wsId}/collections/import`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          mode: 'bruno',
          content: `meta {\n  name: Check Health\n  type: http\n  seq: 1\n}\n\nget {\n  url: /api/v1/health\n  body: none\n}`,
        }),
      })
      expect(bruImport.status).toBe(201)
      const bruColId = ((await bruImport.json()) as { importedCollectionId: string }).importedCollectionId

      const htmlDocs = await app.request(`/api/v1/collections/${bruColId}/export?format=html`, {
        headers: { Cookie: sessionCookie },
      })
      expect(htmlDocs.status).toBe(200)
      expect(await htmlDocs.text()).toContain('<!DOCTYPE html>')

      // 6. Stateful Workspace Mock Server
      const mockCreate = await app.request(`/api/v1/workspaces/${wsId}/mocks`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'Stateful Tasks Mock',
          method: 'GET',
          pathPattern: '/tasks',
          statusCode: 200,
          latencyMs: 0,
          errorRate: 0,
          headers: [],
          responseBody: '[{"id":"t1","title":"Initial Task"}]',
          isStateful: true,
          enabled: true,
        }),
      })
      expect(mockCreate.status).toBe(201)

      const mockPost = await app.request(`/api/v1/mock/${wsSlug}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 't2', title: 'Created via Mock' }),
      })
      expect(mockPost.status).toBe(201)

      const mockGet = await app.request(`/api/v1/mock/${wsSlug}/tasks`)
      expect(mockGet.status).toBe(200)
      const mockItems = (await mockGet.json()) as Array<{ id: string }>
      expect(mockItems).toHaveLength(2)

      // 7. Webhook Inspector with HMAC-SHA256 verification & Replay
      const whCreate = await app.request(`/api/v1/workspaces/${wsId}/webhooks`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'Orders Webhook',
          signingSecret: 'whsec_test_secret_2026',
        }),
      })
      expect(whCreate.status).toBe(201)
      const whEndpoint = ((await whCreate.json()) as { endpoint: { id: string; receivePath: string } }).endpoint

      const whTest = await app.request(`/api/v1/webhooks/${whEndpoint.id}/test-event`, {
        method: 'POST',
        headers: authHeaders,
        body: '{}',
      })
      expect(whTest.status).toBe(200)

      const whEventsRes = await app.request(`/api/v1/webhooks/${whEndpoint.id}/events`, {
        headers: { Cookie: sessionCookie },
      })
      const whEvents = ((await whEventsRes.json()) as { events: Array<{ id: string; hmacStatus: string }> }).events
      expect(whEvents[0]?.hmacStatus).toBe('verified')

      const whReplay = await app.request(`/api/v1/webhooks/events/${whEvents[0]!.id}/replay`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ targetUrl: whEndpoint.receivePath }),
      })
      expect(whReplay.status).toBe(200)

      // 8. Sanitized .capsule Debug Bundle
      const capSave = await app.request(`/api/v1/workspaces/${wsId}/capsules`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          title: 'Auth Failure Repro',
          notes: '401 debug',
          capsule: {
            request: {
              method: 'GET',
              url: 'https://api.example.com/me',
              headers: [{ id: '1', key: 'Authorization', value: 'Bearer super-secret-jwt', enabled: true }],
            },
          },
        }),
      })
      expect(capSave.status).toBe(201)
      const capJson = (await capSave.json()) as {
        capsule: { request: { headers: Array<{ value: string }> } }
      }
      expect(capJson.capsule.request.headers[0]?.value).toBe('[REDACTED]')

      // 9. Scheduled API Monitor & Manual Check
      const monCreate = await app.request(`/api/v1/workspaces/${wsId}/monitors`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'Internal Health Check',
          method: 'GET',
          url: '/api/v1/health',
          expectedStatus: 200,
          maxLatencyMs: 2000,
          intervalSeconds: 300,
          enabled: true,
        }),
      })
      expect(monCreate.status).toBe(201)
      const monId = ((await monCreate.json()) as { id: string }).id

      const monRun = await app.request(`/api/v1/monitors/${monId}/run`, {
        method: 'POST',
        headers: authHeaders,
        body: '{}',
      })
      expect(monRun.status).toBe(200)
      expect(((await monRun.json()) as { passed: boolean }).passed).toBe(true)

      // 10. Concurrent Load Test Runner
      const loadRun = await app.request(`/api/v1/workspaces/${wsId}/load-tests/run`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'Health Stress',
          method: 'GET',
          url: '/api/v1/health',
          virtualUsers: 4,
          totalRequests: 16,
        }),
      })
      expect(loadRun.status).toBe(201)
      const loadSummary = (await loadRun.json()) as {
        completedRequests: number
        succeededRequests: number
        requestsPerSecond: number
      }
      expect(loadSummary.completedRequests).toBe(16)
      expect(loadSummary.succeededRequests).toBe(16)
      expect(loadSummary.requestsPerSecond).toBeGreaterThan(0)

      // 11. Personal API Token (CLI / CI Bearer Auth without CSRF cookie)
      const patRes = await app.request('/api/v1/auth/tokens', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'CI Pipeline' }),
      })
      expect(patRes.status).toBe(201)
      const patToken = ((await patRes.json()) as { token: string }).token
      expect(patToken.startsWith('mf_pat_')).toBe(true)

      const cliMeRes = await app.request('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${patToken}` },
      })
      expect(cliMeRes.status).toBe(200)

      // 12. Smart Test Generator (Zero-cloud deterministic fallback)
      const aiRes = await app.request('/api/v1/ai/assist', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          task: 'generate_tests',
          method: 'GET',
          url: '/api/v1/mock/orders',
          responseStatus: 200,
          responseBody: '{"id":"ord_1","total":500}',
        }),
      })
      expect(aiRes.status).toBe(200)
      const aiBody = (await aiRes.json()) as { output: string }
      expect(aiBody.output).toContain('pm.test(')
      expect(aiBody.output).toContain('have.property("id")')
    })
  })
})
