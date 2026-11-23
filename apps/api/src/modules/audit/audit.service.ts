import crypto from 'node:crypto'
import type { Kysely } from 'kysely'
import type { DatabaseSchema } from '../../core/database/schema.types.js'

const SENSITIVE_KEY_PATTERN = /password|secret|token|authorization|cookie|key/i

function scrubMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(input)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = '[REDACTED]'
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      output[key] = scrubMetadata(val as Record<string, unknown>)
    } else {
      output[key] = val
    }
  }
  return output
}

export async function recordAuditLog(
  db: Kysely<DatabaseSchema>,
  entry: {
    organizationId?: string | null
    workspaceId?: string | null
    actorUserId?: string | null
    actorEmail?: string | null
    action: string
    targetType: string
    targetId?: string | null
    metadata?: Record<string, unknown>
    ipAddress?: string | null
  },
): Promise<void> {
  const safeMeta = scrubMetadata(entry.metadata ?? {})
  await db
    .insertInto('audit_logs')
    .values({
      id: crypto.randomUUID(),
      organization_id: entry.organizationId ?? null,
      workspace_id: entry.workspaceId ?? null,
      actor_user_id: entry.actorUserId ?? null,
      actor_email: entry.actorEmail ?? null,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId ?? null,
      metadata_json: JSON.stringify(safeMeta),
      ip_address: entry.ipAddress ?? null,
      created_at: new Date().toISOString(),
    })
    .execute()
}
