import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { RuntimeContext } from './core/bootstrap/runtime-context.js'
import { runDueMonitorsTick } from './modules/monitors/monitors.routes.js'

async function main() {
  const port = Number(process.env.API_PORT ?? 4781)
  const runtime = new RuntimeContext()
  await runtime.initializeFromDisk()

  const app = createApp(runtime)

  const monitorTimer = setInterval(() => {
    void runDueMonitorsTick(runtime)
  }, 30_000)
  monitorTimer.unref()

  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname: '0.0.0.0',
    },
    (info) => {
      const mode = runtime.isInstalled()
        ? `INSTALLED (${runtime.getConfiguredEngine()})`
        : 'BOOTSTRAP_SETUP_MODE (visit /setup in browser)'
      console.log(`[Meofast API] Listening on http://0.0.0.0:${info.port} — Mode: ${mode}`)
    },
  )

  const shutdown = async () => {
    console.log('[Meofast API] Shutting down gracefully...')
    clearInterval(monitorTimer)
    server.close()
    await runtime.shutdown()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((err) => {
  console.error('[Meofast API] Fatal startup error:', err)
  process.exit(1)
})
