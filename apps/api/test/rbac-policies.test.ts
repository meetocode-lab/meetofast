import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDefaultRoleMatrix } from '@meofast/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { RuntimeContext } from '../src/core/bootstrap/runtime-context.js'

function extractCookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders.map((raw) => raw.split(';')[0]).join('; ')
}

describe('Laravel Policy-Style Custom RBAC Roles & Feature Permission Matrix', () => {
  let tmpDir: string
  let runtime: RuntimeContext

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meofast-rbac-policies-'))
    runtime = new RuntimeContext(tmpDir)
    await runtime.initializeFromDisk()
  })

  afterEach(async () => {
    await runtime.shutdown()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('seeds built-in roles, creates custom roles, paginates policy matrices, and enforces per-feature CRUD policies live', async () => {
    const app = createApp(runtime)

    // 1. Complete Setup Wizard as Super Admin
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
        database: { engine: 'sqlite', storageDir: tmpDir, filename: 'rbac.sqlite' },
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
    const adminCookie = extractCookieHeader(exec.headers.getSetCookie())
    const adminHeaders = {
      'Content-Type': 'application/json',
      Cookie: adminCookie,
      'X-CSRF-Token': execBody.csrfToken,
    }

    const meRes = await app.request('/api/v1/auth/me', { headers: { Cookie: adminCookie } })
    const meJson = (await meRes.json()) as {
      user: { globalRole: string; permissions: Record<string, Record<string, boolean>> }
      workspaces: Array<{ id: string }>
    }
    expect(meJson.user.globalRole).toBe('super_admin')
    expect(meJson.user.permissions.users_rbac?.create).toBe(true)
    const wsId = meJson.workspaces[0]!.id

    // 2. Verify 5 seeded system roles exist
    const rolesRes = await app.request('/api/v1/admin/roles', {
      headers: { Cookie: adminCookie },
    })
    expect(rolesRes.status).toBe(200)
    const rolesBody = (await rolesRes.json()) as {
      roles: Array<{ id: string; slug: string; isSystem: boolean; isImmutable: boolean }>
    }
    expect(rolesBody.roles.map((r) => r.slug)).toEqual(
      expect.arrayContaining([
        'super_admin',
        'org_admin',
        'workspace_admin',
        'developer',
        'viewer',
      ]),
    )

    const superRole = rolesBody.roles.find((r) => r.slug === 'super_admin')!
    expect(superRole.isImmutable).toBe(true)

    // Super admin cannot be restricted or deleted
    const mutateSuper = await app.request(`/api/v1/admin/roles/${superRole.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'Hacked Root' }),
    })
    expect(mutateSuper.status).toBe(400)

    const deleteSuper = await app.request(`/api/v1/admin/roles/${superRole.id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    })
    expect(deleteSuper.status).toBe(400)

    // 3. Create Custom Role "QA Engineer" (qa_engineer) with tailored Laravel Policy matrix:
    //    - mocks: create=true, delete=false
    //    - environments: anyView=true, view=true, create=false, update=false, delete=false
    const qaMatrix = buildDefaultRoleMatrix('viewer')
    qaMatrix.mocks = {
      anyView: true,
      view: true,
      create: true,
      update: true,
      delete: false,
    }
    qaMatrix.environments = {
      anyView: true,
      view: true,
      create: false,
      update: false,
      delete: false,
    }

    const createRoleRes = await app.request('/api/v1/admin/roles', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'QA Engineer',
        slug: 'qa_engineer',
        description: 'Creates mocks & tests without deleting mocks or modifying environments.',
        permissions: qaMatrix,
      }),
    })
    expect(createRoleRes.status).toBe(201)
    const createdRole = ((await createRoleRes.json()) as { role: { id: string; slug: string } })
      .role
    expect(createdRole.slug).toBe('qa_engineer')

    // 4. Verify server-side search, sort & pagination on /api/v1/admin/roles/:id/policies
    const policyPageRes = await app.request(
      `/api/v1/admin/roles/${createdRole.id}/policies?q=mock&page=1&pageSize=5&sortBy=feature&sortDir=asc`,
      { headers: { Cookie: adminCookie } },
    )
    expect(policyPageRes.status).toBe(200)
    const policyPage = (await policyPageRes.json()) as {
      items: Array<{
        featureKey: string
        anyView: boolean
        view: boolean
        create: boolean
        update: boolean
        delete: boolean
      }>
      total: number
    }
    expect(policyPage.total).toBe(1)
    expect(policyPage.items[0]?.featureKey).toBe('mocks')
    expect(policyPage.items[0]?.create).toBe(true)
    expect(policyPage.items[0]?.delete).toBe(false)

    // 5. Create a Team Member assigned to custom role "qa_engineer"
    const createQaUser = await app.request('/api/v1/admin/users', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        fullName: 'Rina QA',
        email: 'rina.qa@meofast.org',
        username: 'rinaqa',
        password: 'QaPassword#2026Strong',
        globalRole: 'qa_engineer',
        workspaceIds: [wsId],
      }),
    })
    expect(createQaUser.status).toBe(201)
    const qaUserId = ((await createQaUser.json()) as { user: { id: string } }).user.id

    // Log in as Rina QA
    const qaLogin = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: setupCookie,
        'X-CSRF-Token': stBody.csrfToken,
      },
      body: JSON.stringify({
        identifier: 'rina.qa@meofast.org',
        password: 'QaPassword#2026Strong',
      }),
    })
    expect(qaLogin.status).toBe(200)
    const qaLoginBody = (await qaLogin.json()) as { csrfToken: string }
    const qaCookie = extractCookieHeader(qaLogin.headers.getSetCookie())
    const qaHeaders = {
      'Content-Type': 'application/json',
      Cookie: qaCookie,
      'X-CSRF-Token': qaLoginBody.csrfToken,
    }

    // Rina CAN create a mock route (mocks.create = true)
    const createMock = await app.request(`/api/v1/workspaces/${wsId}/mocks`, {
      method: 'POST',
      headers: qaHeaders,
      body: JSON.stringify({
        name: 'QA Health Mock',
        method: 'GET',
        pathPattern: '/qa/health',
        statusCode: 200,
        responseBody: '{"ok":true}',
      }),
    })
    expect(createMock.status).toBe(201)
    const mockId = ((await createMock.json()) as { id: string }).id

    // Rina CANNOT delete that mock route (mocks.delete = false -> 403)
    const deleteMock = await app.request(`/api/v1/mocks/${mockId}`, {
      method: 'DELETE',
      headers: qaHeaders,
    })
    expect(deleteMock.status).toBe(403)

    // Rina CANNOT create an environment (environments.create = false -> 403)
    const createEnvDenied = await app.request(`/api/v1/workspaces/${wsId}/environments`, {
      method: 'POST',
      headers: qaHeaders,
      body: JSON.stringify({ name: 'QA Staging' }),
    })
    expect(createEnvDenied.status).toBe(403)

    // 6. Super Admin updates qa_engineer policy matrix to grant environments.create = true!
    qaMatrix.environments.create = true
    const updatePolicyRes = await app.request(`/api/v1/admin/roles/${createdRole.id}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ permissions: qaMatrix }),
    })
    expect(updatePolicyRes.status).toBe(200)

    // Immediately (live without re-login), Rina CAN create an environment!
    const createEnvAllowed = await app.request(`/api/v1/workspaces/${wsId}/environments`, {
      method: 'POST',
      headers: qaHeaders,
      body: JSON.stringify({ name: 'QA Staging' }),
    })
    expect(createEnvAllowed.status).toBe(201)

    // 7. Role in use cannot be deleted until assigned users are moved to another role
    const deleteInUse = await app.request(`/api/v1/admin/roles/${createdRole.id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    })
    expect(deleteInUse.status).toBe(400)

    // Reassign Rina to developer, then delete custom role cleanly
    const reassignRes = await app.request(`/api/v1/admin/users/${qaUserId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ globalRole: 'developer' }),
    })
    expect(reassignRes.status).toBe(200)

    const deleteClean = await app.request(`/api/v1/admin/roles/${createdRole.id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    })
    expect(deleteClean.status).toBe(200)
  })
})
