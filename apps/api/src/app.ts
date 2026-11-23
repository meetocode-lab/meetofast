import { MEOFAST_VERSION } from '@meofast/shared'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { sql } from 'kysely'
import type { RuntimeContext } from './core/bootstrap/runtime-context.js'
import { AppError } from './core/errors/app-error.js'
import { requireInstalledMiddleware, securityHeadersMiddleware } from './middleware/security.js'
import { aiRoutes } from './modules/ai/ai.routes.js'
import { authRoutes } from './modules/auth/auth.routes.js'
import { capsulesRoutes } from './modules/capsules/capsules.routes.js'
import { collectionsRoutes } from './modules/collections/collections.routes.js'
import { cookiesRoutes } from './modules/cookies/cookies.routes.js'
import { environmentsRoutes } from './modules/environments/environments.routes.js'
import { loadTestRoutes } from './modules/loadtest/loadtest.routes.js'
import { mocksProtectedRoutes, mocksPublicRoutes } from './modules/mocks/mocks.routes.js'
import { monitorsRoutes } from './modules/monitors/monitors.routes.js'
import { notificationsRoutes } from './modules/notifications/notifications.routes.js'
import { playgroundRoutes } from './modules/playground/playground.routes.js'
import { historyProtectedRoutes, proxyRoutes } from './modules/proxy/proxy.routes.js'
import { setupRoutes } from './modules/setup/setup.routes.js'
import { adminRoutes } from './modules/users/users.routes.js'
import { webhooksProtectedRoutes, webhooksPublicRoutes } from './modules/webhooks/webhooks.routes.js'
import { workspacesRoutes } from './modules/workspaces/workspaces.routes.js'
import type { AppEnv } from './types/hono.types.js'

export function createApp(runtime: RuntimeContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  runtime.localFetch = (req: Request) => app.fetch(req)

  app.use('*', async (c, next) => {
    c.set('runtime', runtime)
    await next()
  })
  app.use('*', securityHeadersMiddleware)

  app.get('/api/v1/health', async (c) => {
    const installed = runtime.isInstalled()
    let dbHealthy = false

    if (installed) {
      try {
        await sql`SELECT 1`.execute(runtime.getDb())
        dbHealthy = true
      } catch {
        dbHealthy = false
      }
    }

    return c.json({
      status: !installed || dbHealthy ? 'ok' : 'degraded',
      product: 'Meofast',
      version: MEOFAST_VERSION,
      installed,
      engine: runtime.getConfiguredEngine() ?? null,
      databaseHealthy: installed ? dbHealthy : null,
      uptimeSeconds: Math.floor(process.uptime()),
    })
  })

  // First-time Installation Wizard endpoints
  app.route('/api/v1/setup', setupRoutes)

  // Operational API routes (guarded until installation completes)
  const v1 = new Hono<AppEnv>()
  v1.use('*', requireInstalledMiddleware)

  // Public inbound endpoints for Mock Server, Webhook Receiver & Local Playground
  v1.route('/mock', mocksPublicRoutes)
  v1.route('/webhooks/in', webhooksPublicRoutes)
  v1.route('/playground', playgroundRoutes)

  // Authenticated Workspace & Platform APIs
  v1.route('/auth', authRoutes)
  v1.route('/workspaces', workspacesRoutes)
  v1.route('/admin', adminRoutes)
  v1.route('/', collectionsRoutes)
  v1.route('/', cookiesRoutes)
  v1.route('/', environmentsRoutes)
  v1.route('/', mocksProtectedRoutes)
  v1.route('/', webhooksProtectedRoutes)
  v1.route('/', capsulesRoutes)
  v1.route('/', monitorsRoutes)
  v1.route('/', notificationsRoutes)
  v1.route('/', loadTestRoutes)
  v1.route('/', aiRoutes)
  v1.route('/', historyProtectedRoutes)
  v1.route('/proxy', proxyRoutes)

  app.route('/api/v1', v1)

  app.notFound((c) => {
    return c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: `Route ${c.req.method} ${c.req.path} not found`,
        },
      },
      404,
    )
  })

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        },
        err.statusCode as ContentfulStatusCode,
      )
    }

    console.error('[Meofast API Error]', err instanceof Error ? err.message : 'Unknown error')
    return c.json(
      {
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected server error occurred.',
        },
      },
      500,
    )
  })

  return app
}
