import { Hono } from 'hono'
import type { AppEnv } from '../../types/hono.types.js'

export const playgroundRoutes = new Hono<AppEnv>()

const SAMPLE_GQL_USERS = [
  { id: '1', name: 'Davin Metoti', role: 'Lead Architect', active: true },
  { id: '2', name: 'Alya Pratama', role: 'Backend Engineer', active: true },
  { id: '3', name: 'Raka Wijaya', role: 'Platform SRE', active: true },
]

const INTROSPECTION_SCHEMA = {
  __schema: {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    types: [
      {
        kind: 'OBJECT',
        name: 'Query',
        description: 'Root query operations for Meofast GraphQL Playground',
        fields: [
          {
            name: 'users',
            description: 'List all workspace engineers',
            args: [],
            type: { kind: 'LIST', name: null, ofType: { kind: 'OBJECT', name: 'User' } },
          },
          {
            name: 'user',
            description: 'Find a single user by ID',
            args: [{ name: 'id', type: { kind: 'NON_NULL', name: 'ID' } }],
            type: { kind: 'OBJECT', name: 'User' },
          },
          {
            name: 'serverStatus',
            description: 'Check current server status',
            args: [],
            type: { kind: 'OBJECT', name: 'ServerStatus' },
          },
        ],
      },
      {
        kind: 'OBJECT',
        name: 'Mutation',
        description: 'Root mutation operations',
        fields: [
          {
            name: 'createItem',
            description: 'Create a new sample item',
            args: [{ name: 'title', type: { kind: 'NON_NULL', name: 'String' } }],
            type: { kind: 'OBJECT', name: 'Item' },
          },
        ],
      },
      {
        kind: 'OBJECT',
        name: 'User',
        description: 'Platform team member',
        fields: [
          { name: 'id', args: [], type: { kind: 'SCALAR', name: 'ID' } },
          { name: 'name', args: [], type: { kind: 'SCALAR', name: 'String' } },
          { name: 'role', args: [], type: { kind: 'SCALAR', name: 'String' } },
          { name: 'active', args: [], type: { kind: 'SCALAR', name: 'Boolean' } },
        ],
      },
      {
        kind: 'OBJECT',
        name: 'ServerStatus',
        description: 'Health telemetry',
        fields: [
          { name: 'ok', args: [], type: { kind: 'SCALAR', name: 'Boolean' } },
          { name: 'timestamp', args: [], type: { kind: 'SCALAR', name: 'String' } },
        ],
      },
    ],
  },
}

playgroundRoutes.post('/graphql', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    query?: string
    variables?: Record<string, unknown>
  }
  const query = String(body.query ?? '')
  const variables = body.variables ?? {}

  if (query.includes('__schema') || query.includes('IntrospectionQuery')) {
    return c.json({ data: INTROSPECTION_SCHEMA })
  }

  const data: Record<string, unknown> = {}
  if (query.includes('users')) {
    data.users = SAMPLE_GQL_USERS
  }
  if (query.includes('user(') || query.includes('$id')) {
    const idMatch = query.match(/id\s*:\s*"([^"]+)"/)
    const targetId = String(variables.id ?? idMatch?.[1] ?? '1')
    data.user = SAMPLE_GQL_USERS.find((u) => u.id === targetId) ?? null
  }
  if (query.includes('serverStatus')) {
    data.serverStatus = { ok: true, timestamp: new Date().toISOString() }
  }
  if (query.includes('createItem')) {
    const titleMatch = query.match(/title\s*:\s*"([^"]+)"/)
    data.createItem = {
      id: `item_${Date.now()}`,
      title: String(variables.title ?? titleMatch?.[1] ?? 'Untitled'),
      createdAt: new Date().toISOString(),
    }
  }

  if (Object.keys(data).length === 0) {
    data.users = SAMPLE_GQL_USERS
  }

  return c.json({ data })
})

playgroundRoutes.get('/sse', () => {
  const now = Date.now()
  const events = [
    `id: 1\nevent: connected\ndata: ${JSON.stringify({ status: 'stream_ready', timestamp: new Date(now).toISOString() })}\n\n`,
    `id: 2\nevent: metric\ndata: ${JSON.stringify({ rps: 142, latencyMs: 18 })}\n\n`,
    `id: 3\nevent: completed\ndata: ${JSON.stringify({ done: true, eventsSent: 3 })}\n\n`,
  ].join('')

  return new Response(events, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})

playgroundRoutes.post('/oauth/token', async (c) => {
  const formText = await c.req.text().catch(() => '')
  const params = new URLSearchParams(formText)
  const grantType = params.get('grant_type') || 'client_credentials'
  const scope = params.get('scope') || 'read write'

  return c.json({
    access_token: `mf_oauth_${grantType}_${Date.now().toString(36)}`,
    token_type: 'Bearer',
    expires_in: 3600,
    scope,
  })
})
