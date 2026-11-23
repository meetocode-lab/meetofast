import { aiAssistRequestSchema, aiProviderConfigSchema } from '@meofast/shared'
import { Hono } from 'hono'
import { AppError } from '../../core/errors/app-error.js'
import { requireAdminMiddleware, requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'

export const aiRoutes = new Hono<AppEnv>()

aiRoutes.use('*', requireAuthMiddleware)

interface StoredAiConfig {
  enabled: boolean
  provider: 'openai_compatible' | 'gemini' | 'ollama'
  baseUrl: string
  model: string
  encryptedApiKey: string | null
}

function generateDeterministicSmartTests(params: {
  method: string
  status: number | null
  body: string
}): string {
  const expectedStatus = params.status ?? (params.method === 'POST' ? 201 : 200)
  const lines = [
    `pm.test("Status code is ${expectedStatus}", () => {`,
    `  pm.expect(pm.response.code).to.equal(${expectedStatus});`,
    `});`,
    ``,
    `pm.test("Response latency under 2000 ms", () => {`,
    `  pm.expect(pm.response.responseTime).to.be.below(2000);`,
    `});`,
  ]

  try {
    const parsed = JSON.parse(params.body || '') as unknown
    if (Array.isArray(parsed)) {
      lines.push(
        ``,
        `pm.test("Response is a JSON array", () => {`,
        `  const list = pm.response.json();`,
        `  pm.expect(Array.isArray(list)).to.be.true;`,
        `});`,
      )
      if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
        const keys = Object.keys(parsed[0] as Record<string, unknown>).slice(0, 3)
        if (keys.length > 0) {
          lines.push(
            ``,
            `pm.test("First item has expected fields", () => {`,
            `  const first = pm.response.json()[0];`,
            ...keys.map((k) => `  pm.expect(first).to.have.property("${k}");`),
            `});`,
          )
        }
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed as Record<string, unknown>).slice(0, 4)
      if (keys.length > 0) {
        lines.push(
          ``,
          `pm.test("JSON payload includes expected keys", () => {`,
          `  const body = pm.response.json();`,
          ...keys.map((k) => `  pm.expect(body).to.have.property("${k}");`),
          `});`,
        )
      }
    }
  } catch {
    // Non-JSON response
  }

  return lines.join('\n')
}

aiRoutes.get('/admin/ai-config', requireAdminMiddleware, async (c) => {
  const db = c.get('runtime').getDb()
  const row = await db
    .selectFrom('system_settings')
    .select('setting_value')
    .where('setting_key', '=', 'ai_provider_config')
    .executeTakeFirst()

  if (!row?.setting_value) {
    return c.json({
      enabled: false,
      provider: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      hasApiKey: false,
    })
  }

  const cfg = JSON.parse(row.setting_value) as StoredAiConfig
  return c.json({
    enabled: cfg.enabled,
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasApiKey: Boolean(cfg.encryptedApiKey),
  })
})

aiRoutes.put('/admin/ai-config', requireAdminMiddleware, async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()

  const parsed = aiProviderConfigSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid AI provider settings.')
  }

  const existing = await db
    .selectFrom('system_settings')
    .select('setting_value')
    .where('setting_key', '=', 'ai_provider_config')
    .executeTakeFirst()

  const prev: StoredAiConfig | null = existing?.setting_value
    ? (JSON.parse(existing.setting_value) as StoredAiConfig)
    : null

  let encryptedApiKey: string | null = null
  if (parsed.data.apiKey?.trim()) {
    encryptedApiKey = runtime.vault.encrypt(parsed.data.apiKey.trim())
  } else if (parsed.data.keepExistingApiKey && prev?.encryptedApiKey) {
    encryptedApiKey = prev.encryptedApiKey
  }

  const nextCfg: StoredAiConfig = {
    enabled: parsed.data.enabled,
    provider: parsed.data.provider,
    baseUrl: parsed.data.baseUrl.trim(),
    model: parsed.data.model.trim(),
    encryptedApiKey,
  }

  const nowIso = new Date().toISOString()
  if (existing) {
    await db
      .updateTable('system_settings')
      .set({ setting_value: JSON.stringify(nextCfg), updated_at: nowIso })
      .where('setting_key', '=', 'ai_provider_config')
      .execute()
  } else {
    await db
      .insertInto('system_settings')
      .values({
        setting_key: 'ai_provider_config',
        setting_value: JSON.stringify(nextCfg),
        updated_at: nowIso,
      })
      .execute()
  }

  return c.json({ ok: true, hasApiKey: Boolean(encryptedApiKey) })
})

aiRoutes.post('/ai/assist', async (c) => {
  const runtime = c.get('runtime')
  const db = runtime.getDb()

  const parsed = aiAssistRequestSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid AI assist payload.')
  }

  const d = parsed.data
  const setting = await db
    .selectFrom('system_settings')
    .select('setting_value')
    .where('setting_key', '=', 'ai_provider_config')
    .executeTakeFirst()

  const cfg: StoredAiConfig | null = setting?.setting_value
    ? (JSON.parse(setting.setting_value) as StoredAiConfig)
    : null

  // If optional BYOK AI is enabled and configured, attempt upstream LLM call with graceful fallback
  if (cfg?.enabled && cfg.baseUrl) {
    try {
      const apiKey = cfg.encryptedApiKey ? runtime.vault.decrypt(cfg.encryptedApiKey) : ''
      const prompt =
        d.task === 'generate_tests'
          ? `Write concise JavaScript pm.test() assertions for ${d.method} ${d.url} returning status ${d.responseStatus ?? 200} and body:\n${(d.responseBody ?? '').slice(0, 3000)}\nReturn code only.`
          : `Summarize this API response (${d.method} ${d.url}, status ${d.responseStatus ?? 200}) concisely:\n${(d.responseBody ?? '').slice(0, 3000)}`

      const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`

      const llmRes = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(12000),
      })

      if (llmRes.ok) {
        const json = (await llmRes.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const content = json.choices?.[0]?.message?.content?.trim()
        if (content) {
          return c.json({
            source: cfg.provider,
            output: content.replace(/^```[a-z]*\n?|\n?```$/gi, '').trim(),
          })
        }
      }
    } catch {
      // Fall back to local analyzer
    }
  }

  // Zero-cloud deterministic local fallback
  if (d.task === 'generate_tests') {
    return c.json({
      source: 'local_analyzer',
      output: generateDeterministicSmartTests({
        method: d.method,
        status: d.responseStatus ?? null,
        body: d.responseBody ?? '',
      }),
    })
  }

  return c.json({
    source: 'local_analyzer',
    output: `${d.method} ${d.url} — HTTP ${d.responseStatus ?? 200}`,
  })
})
