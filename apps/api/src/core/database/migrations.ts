import crypto from 'node:crypto'
import {
  BUILTIN_ROLE_METADATA,
  buildDefaultRoleMatrix,
  type DatabaseEngine,
} from '@meofast/shared'
import { type Kysely, sql } from 'kysely'
import type { DatabaseSchema } from './schema.types.js'

const MIGRATION_VERSION = '001_initial_schema'
const MIGRATION_002 = '002_phase3_batch3a'
const MIGRATION_003 = '003_complete_platform'
const MIGRATION_004 = '004_cookie_jar'
const MIGRATION_005 = '005_vars_inheritance_examples'
const MIGRATION_006 = '006_mock_rate_limit'
const MIGRATION_007 = '007_custom_rbac_roles'
const MIGRATION_008 = '008_workspace_sharing_and_notifications'

function largeTextType(engine: DatabaseEngine) {
  return engine === 'mysql' || engine === 'mariadb' ? sql`longtext` : ('text' as const)
}

async function createIndexSafe(
  db: Kysely<DatabaseSchema>,
  indexName: string,
  tableName: keyof DatabaseSchema,
  columns: string[],
  unique = false,
): Promise<void> {
  try {
    let builder = db.schema.createIndex(indexName).on(tableName).columns(columns)
    if (unique) {
      builder = builder.unique()
    }
    await builder.execute()
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
    if (
      msg.includes('already exists') ||
      msg.includes('duplicate key name') ||
      msg.includes('1061')
    ) {
      return
    }
    throw err
  }
}

export async function runMigrations(
  db: Kysely<DatabaseSchema>,
  engine: DatabaseEngine,
): Promise<{ applied: string[] }> {
  const bigText = largeTextType(engine)

  await db.schema
    .createTable('schema_migrations')
    .ifNotExists()
    .addColumn('version', 'varchar(80)', (c) => c.primaryKey().notNull())
    .addColumn('applied_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  const existingRows = await db.selectFrom('schema_migrations').select('version').execute()
  const appliedSet = new Set(existingRows.map((r) => r.version))
  const newlyApplied: string[] = []

  if (!appliedSet.has(MIGRATION_VERSION)) {

  // 1. system_settings
  await db.schema
    .createTable('system_settings')
    .ifNotExists()
    .addColumn('setting_key', 'varchar(100)', (c) => c.primaryKey().notNull())
    .addColumn('setting_value', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  // 2. users
  await db.schema
    .createTable('users')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('email', 'varchar(191)', (c) => c.notNull().unique())
    .addColumn('username', 'varchar(100)', (c) => c.notNull().unique())
    .addColumn('full_name', 'varchar(160)', (c) => c.notNull())
    .addColumn('password_hash', 'varchar(512)', (c) => c.notNull())
    .addColumn('global_role', 'varchar(40)', (c) => c.notNull())
    .addColumn('status', 'varchar(20)', (c) => c.notNull())
    .addColumn('last_login_at', 'varchar(40)')
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  // 3. sessions
  await db.schema
    .createTable('sessions')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('user_id', 'varchar(36)', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('token_hash', 'varchar(128)', (c) => c.notNull().unique())
    .addColumn('csrf_token', 'varchar(128)', (c) => c.notNull())
    .addColumn('ip_address', 'varchar(80)')
    .addColumn('user_agent', 'varchar(512)')
    .addColumn('expires_at', 'varchar(40)', (c) => c.notNull())
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  await createIndexSafe(db, 'idx_sessions_user_id', 'sessions', ['user_id'])
  await createIndexSafe(db, 'idx_sessions_expires_at', 'sessions', ['expires_at'])

  // 4. login_history
  await db.schema
    .createTable('login_history')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('user_id', 'varchar(36)')
    .addColumn('email_attempted', 'varchar(191)', (c) => c.notNull())
    .addColumn('succeeded', 'integer', (c) => c.notNull())
    .addColumn('ip_address', 'varchar(80)')
    .addColumn('user_agent', 'varchar(512)')
    .addColumn('failure_reason', 'varchar(160)')
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  await createIndexSafe(db, 'idx_login_history_created_at', 'login_history', ['created_at'])

  // 5. organizations
  await db.schema
    .createTable('organizations')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('name', 'varchar(160)', (c) => c.notNull())
    .addColumn('slug', 'varchar(120)', (c) => c.notNull().unique())
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  // 6. organization_members
  await db.schema
    .createTable('organization_members')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('organization_id', 'varchar(36)', (c) =>
      c.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'varchar(36)', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('role', 'varchar(40)', (c) => c.notNull())
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  await createIndexSafe(
    db,
    'uq_org_members_org_user',
    'organization_members',
    ['organization_id', 'user_id'],
    true,
  )

  // 7. workspaces
  await db.schema
    .createTable('workspaces')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('organization_id', 'varchar(36)', (c) =>
      c.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar(160)', (c) => c.notNull())
    .addColumn('slug', 'varchar(120)', (c) => c.notNull())
    .addColumn('description', 'varchar(500)')
    .addColumn('visibility', 'varchar(20)', (c) => c.notNull())
    .addColumn('created_by', 'varchar(36)', (c) => c.notNull())
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  await createIndexSafe(
    db,
    'uq_workspaces_org_slug',
    'workspaces',
    ['organization_id', 'slug'],
    true,
  )

  // 8. workspace_members
  await db.schema
    .createTable('workspace_members')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('workspace_id', 'varchar(36)', (c) =>
      c.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'varchar(36)', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('role', 'varchar(40)', (c) => c.notNull())
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  await createIndexSafe(
    db,
    'uq_ws_members_ws_user',
    'workspace_members',
    ['workspace_id', 'user_id'],
    true,
  )

  // 9. user_invitations
  await db.schema
    .createTable('user_invitations')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('organization_id', 'varchar(36)', (c) =>
      c.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('workspace_id', 'varchar(36)')
    .addColumn('email', 'varchar(191)', (c) => c.notNull())
    .addColumn('role', 'varchar(40)', (c) => c.notNull())
    .addColumn('token_hash', 'varchar(128)', (c) => c.notNull().unique())
    .addColumn('invited_by', 'varchar(36)', (c) => c.notNull())
    .addColumn('accepted_at', 'varchar(40)')
    .addColumn('expires_at', 'varchar(40)', (c) => c.notNull())
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  // 10. collections
  await db.schema
    .createTable('collections')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('workspace_id', 'varchar(36)', (c) =>
      c.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar(200)', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('variables_json', 'text', (c) => c.notNull())
    .addColumn('auth_json', 'text', (c) => c.notNull())
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_by', 'varchar(36)')
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  await createIndexSafe(db, 'idx_collections_ws', 'collections', ['workspace_id'])

  // 11. collection_folders
  await db.schema
    .createTable('collection_folders')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('collection_id', 'varchar(36)', (c) =>
      c.notNull().references('collections.id').onDelete('cascade'),
    )
    .addColumn('parent_folder_id', 'varchar(36)')
    .addColumn('name', 'varchar(200)', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('variables_json', 'text', (c) => c.notNull())
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  await createIndexSafe(db, 'idx_folders_collection', 'collection_folders', ['collection_id'])

  // 12. saved_requests
  await db.schema
    .createTable('saved_requests')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('workspace_id', 'varchar(36)', (c) =>
      c.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('collection_id', 'varchar(36)', (c) =>
      c.notNull().references('collections.id').onDelete('cascade'),
    )
    .addColumn('folder_id', 'varchar(36)')
    .addColumn('name', 'varchar(200)', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('method', 'varchar(16)', (c) => c.notNull())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('query_params_json', 'text', (c) => c.notNull())
    .addColumn('headers_json', 'text', (c) => c.notNull())
    .addColumn('path_vars_json', 'text', (c) => c.notNull())
    .addColumn('auth_json', 'text', (c) => c.notNull())
    .addColumn('body_json', bigText, (c) => c.notNull())
    .addColumn('assertions_json', 'text', (c) => c.notNull())
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_by', 'varchar(36)')
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  await createIndexSafe(db, 'idx_requests_ws', 'saved_requests', ['workspace_id'])
  await createIndexSafe(db, 'idx_requests_collection', 'saved_requests', ['collection_id'])

  // 13. environments
  await db.schema
    .createTable('environments')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('workspace_id', 'varchar(36)', (c) =>
      c.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar(160)', (c) => c.notNull())
    .addColumn('is_global', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_by', 'varchar(36)')
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  await createIndexSafe(db, 'idx_environments_ws', 'environments', ['workspace_id'])

  // 14. environment_variables
  await db.schema
    .createTable('environment_variables')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('environment_id', 'varchar(36)', (c) =>
      c.notNull().references('environments.id').onDelete('cascade'),
    )
    .addColumn('var_key', 'varchar(160)', (c) => c.notNull())
    .addColumn('var_value', 'text', (c) => c.notNull())
    .addColumn('encrypted_value', 'text')
    .addColumn('is_secret', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  await createIndexSafe(db, 'idx_env_vars_env', 'environment_variables', ['environment_id'])

  // 15. request_history
  await db.schema
    .createTable('request_history')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('workspace_id', 'varchar(36)', (c) =>
      c.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'varchar(36)', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('saved_request_id', 'varchar(36)')
    .addColumn('method', 'varchar(16)', (c) => c.notNull())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('request_snapshot_json', bigText, (c) => c.notNull())
    .addColumn('response_status', 'integer')
    .addColumn('response_status_text', 'varchar(120)')
    .addColumn('duration_ms', 'integer', (c) => c.notNull())
    .addColumn('response_size_bytes', 'integer', (c) => c.notNull())
    .addColumn('response_headers_json', 'text', (c) => c.notNull())
    .addColumn('response_body_preview', bigText, (c) => c.notNull())
    .addColumn('assertion_results_json', 'text', (c) => c.notNull())
    .addColumn('error_message', 'text')
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .execute()

  await createIndexSafe(db, 'idx_history_ws_created', 'request_history', [
    'workspace_id',
    'created_at',
  ])

  // 16. audit_logs
  await db.schema
    .createTable('audit_logs')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
    .addColumn('organization_id', 'varchar(36)')
    .addColumn('workspace_id', 'varchar(36)')
    .addColumn('actor_user_id', 'varchar(36)')
    .addColumn('actor_email', 'varchar(191)')
    .addColumn('action', 'varchar(120)', (c) => c.notNull())
    .addColumn('target_type', 'varchar(80)', (c) => c.notNull())
    .addColumn('target_id', 'varchar(120)')
    .addColumn('metadata_json', 'text', (c) => c.notNull())
    .addColumn('ip_address', 'varchar(80)')
    .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
    .execute()

    await createIndexSafe(db, 'idx_audit_created', 'audit_logs', ['created_at'])

    await db
      .insertInto('schema_migrations')
      .values({
        version: MIGRATION_VERSION,
        applied_at: new Date().toISOString(),
      })
      .execute()
    newlyApplied.push(MIGRATION_VERSION)
  }

  if (!appliedSet.has(MIGRATION_002)) {
    const addColSafe = async (colName: string) => {
      try {
        await db.schema.alterTable('saved_requests').addColumn(colName, 'text').execute()
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
        if (msg.includes('duplicate column') || msg.includes('already exists') || msg.includes('1060')) {
          return
        }
        throw err
      }
    }

    await addColSafe('pre_request_script')
    await addColSafe('test_script')
    await addColSafe('json_schema')

    await db
      .insertInto('schema_migrations')
      .values({
        version: MIGRATION_002,
        applied_at: new Date().toISOString(),
      })
      .execute()
    newlyApplied.push(MIGRATION_002)
  }

  if (!appliedSet.has(MIGRATION_003)) {
    const addReqColSafe = async (colName: string, colType: 'varchar(20)' | 'text') => {
      try {
        await db.schema.alterTable('saved_requests').addColumn(colName, colType).execute()
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
        if (
          msg.includes('duplicate column') ||
          msg.includes('already exists') ||
          msg.includes('1060')
        ) {
          return
        }
        throw err
      }
    }

    await addReqColSafe('protocol', 'varchar(20)')
    await addReqColSafe('graphql_json', 'text')

    // 17. api_tokens
    await db.schema
      .createTable('api_tokens')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('user_id', 'varchar(36)', (c) =>
        c.notNull().references('users.id').onDelete('cascade'),
      )
      .addColumn('name', 'varchar(120)', (c) => c.notNull())
      .addColumn('token_prefix', 'varchar(24)', (c) => c.notNull())
      .addColumn('token_hash', 'varchar(128)', (c) => c.notNull().unique())
      .addColumn('last_used_at', 'varchar(40)')
      .addColumn('expires_at', 'varchar(40)')
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_api_tokens_user', 'api_tokens', ['user_id'])

    // 18. mock_routes
    await db.schema
      .createTable('mock_routes')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('workspace_id', 'varchar(36)', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('collection_id', 'varchar(36)')
      .addColumn('name', 'varchar(160)', (c) => c.notNull())
      .addColumn('method', 'varchar(16)', (c) => c.notNull())
      .addColumn('path_pattern', 'varchar(512)', (c) => c.notNull())
      .addColumn('status_code', 'integer', (c) => c.notNull().defaultTo(200))
      .addColumn('latency_ms', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('error_rate', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('headers_json', 'text', (c) => c.notNull())
      .addColumn('response_body', bigText, (c) => c.notNull())
      .addColumn('is_stateful', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('state_items_json', bigText)
      .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('hit_count', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_mock_routes_ws', 'mock_routes', ['workspace_id'])

    // 19. webhook_endpoints
    await db.schema
      .createTable('webhook_endpoints')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('workspace_id', 'varchar(36)', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('name', 'varchar(160)', (c) => c.notNull())
      .addColumn('token', 'varchar(64)', (c) => c.notNull().unique())
      .addColumn('signing_secret', 'varchar(256)')
      .addColumn('forward_url', 'text')
      .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_webhooks_ws', 'webhook_endpoints', ['workspace_id'])

    // 20. webhook_events
    await db.schema
      .createTable('webhook_events')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('endpoint_id', 'varchar(36)', (c) =>
        c.notNull().references('webhook_endpoints.id').onDelete('cascade'),
      )
      .addColumn('method', 'varchar(16)', (c) => c.notNull())
      .addColumn('path', 'varchar(512)', (c) => c.notNull())
      .addColumn('query_json', 'text', (c) => c.notNull())
      .addColumn('headers_json', 'text', (c) => c.notNull())
      .addColumn('body_raw', bigText, (c) => c.notNull())
      .addColumn('source_ip', 'varchar(80)')
      .addColumn('hmac_status', 'varchar(24)', (c) => c.notNull())
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_webhook_events_ep', 'webhook_events', [
      'endpoint_id',
      'created_at',
    ])

    // 21. debug_capsules
    await db.schema
      .createTable('debug_capsules')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('workspace_id', 'varchar(36)', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('title', 'varchar(200)', (c) => c.notNull())
      .addColumn('notes', 'text')
      .addColumn('capsule_json', bigText, (c) => c.notNull())
      .addColumn('created_by', 'varchar(36)')
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_capsules_ws', 'debug_capsules', ['workspace_id'])

    // 22. monitors
    await db.schema
      .createTable('monitors')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('workspace_id', 'varchar(36)', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('name', 'varchar(160)', (c) => c.notNull())
      .addColumn('method', 'varchar(16)', (c) => c.notNull())
      .addColumn('url', 'text', (c) => c.notNull())
      .addColumn('headers_json', 'text', (c) => c.notNull())
      .addColumn('body_raw', bigText)
      .addColumn('expected_status', 'integer', (c) => c.notNull().defaultTo(200))
      .addColumn('max_latency_ms', 'integer', (c) => c.notNull().defaultTo(3000))
      .addColumn('interval_seconds', 'integer', (c) => c.notNull().defaultTo(300))
      .addColumn('alert_webhook_url', 'text')
      .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('last_status', 'varchar(20)')
      .addColumn('last_latency_ms', 'integer')
      .addColumn('last_run_at', 'varchar(40)')
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_monitors_ws', 'monitors', ['workspace_id'])

    // 23. monitor_runs
    await db.schema
      .createTable('monitor_runs')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('monitor_id', 'varchar(36)', (c) =>
        c.notNull().references('monitors.id').onDelete('cascade'),
      )
      .addColumn('passed', 'integer', (c) => c.notNull())
      .addColumn('status_code', 'integer')
      .addColumn('duration_ms', 'integer', (c) => c.notNull())
      .addColumn('error_message', 'text')
      .addColumn('checked_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_monitor_runs_mon', 'monitor_runs', [
      'monitor_id',
      'checked_at',
    ])

    // 24. load_test_runs
    await db.schema
      .createTable('load_test_runs')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('workspace_id', 'varchar(36)', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('name', 'varchar(160)', (c) => c.notNull())
      .addColumn('method', 'varchar(16)', (c) => c.notNull())
      .addColumn('url', 'text', (c) => c.notNull())
      .addColumn('virtual_users', 'integer', (c) => c.notNull())
      .addColumn('total_requests', 'integer', (c) => c.notNull())
      .addColumn('rps_text', 'varchar(32)', (c) => c.notNull())
      .addColumn('error_rate_text', 'varchar(32)', (c) => c.notNull())
      .addColumn('p50_ms', 'integer', (c) => c.notNull())
      .addColumn('p95_ms', 'integer', (c) => c.notNull())
      .addColumn('p99_ms', 'integer', (c) => c.notNull())
      .addColumn('summary_json', bigText, (c) => c.notNull())
      .addColumn('created_by', 'varchar(36)')
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_load_tests_ws', 'load_test_runs', [
      'workspace_id',
      'created_at',
    ])

    // 25. request_comments
    await db.schema
      .createTable('request_comments')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('workspace_id', 'varchar(36)', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('request_id', 'varchar(36)', (c) =>
        c.notNull().references('saved_requests.id').onDelete('cascade'),
      )
      .addColumn('author_id', 'varchar(36)', (c) => c.notNull())
      .addColumn('author_name', 'varchar(160)', (c) => c.notNull())
      .addColumn('body', 'text', (c) => c.notNull())
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_req_comments_req', 'request_comments', ['request_id'])

    await db
      .insertInto('schema_migrations')
      .values({
        version: MIGRATION_003,
        applied_at: new Date().toISOString(),
      })
      .execute()
    newlyApplied.push(MIGRATION_003)
  }

  // =========================================================================
  // Migration 004: Automatic Domain Cookie Jar
  // =========================================================================
  if (!appliedSet.has(MIGRATION_004)) {
    await db.schema
      .createTable('workspace_cookies')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('workspace_id', 'varchar(36)', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('domain', 'varchar(255)', (c) => c.notNull())
      .addColumn('path', 'varchar(255)', (c) => c.notNull())
      .addColumn('cookie_name', 'varchar(160)', (c) => c.notNull())
      .addColumn('cookie_value', 'text', (c) => c.notNull())
      .addColumn('http_only', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('secure', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('expires_at', 'varchar(40)')
      .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_ws_cookies_ws_domain', 'workspace_cookies', [
      'workspace_id',
      'domain',
    ])

    await db
      .insertInto('schema_migrations')
      .values({
        version: MIGRATION_004,
        applied_at: new Date().toISOString(),
      })
      .execute()
    newlyApplied.push(MIGRATION_004)
  }

  // =========================================================================
  // Migration 005: Post-Response Vars, Auth/Header Inheritance & Examples
  // =========================================================================
  if (!appliedSet.has(MIGRATION_005)) {
    const addColSafe = async (
      tableName: 'collections' | 'collection_folders' | 'saved_requests',
      colName: string,
    ) => {
      try {
        await db.schema.alterTable(tableName).addColumn(colName, 'text').execute()
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
        if (
          msg.includes('duplicate column') ||
          msg.includes('already exists') ||
          msg.includes('1060')
        ) {
          return
        }
        throw err
      }
    }

    await addColSafe('collections', 'headers_json')
    await addColSafe('collection_folders', 'auth_json')
    await addColSafe('collection_folders', 'headers_json')
    await addColSafe('saved_requests', 'post_vars_json')

    await db.schema
      .createTable('request_examples')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('workspace_id', 'varchar(36)', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('request_id', 'varchar(36)', (c) =>
        c.notNull().references('saved_requests.id').onDelete('cascade'),
      )
      .addColumn('name', 'varchar(160)', (c) => c.notNull())
      .addColumn('status_code', 'integer', (c) => c.notNull().defaultTo(200))
      .addColumn('status_text', 'varchar(80)', (c) => c.notNull().defaultTo('OK'))
      .addColumn('content_type', 'varchar(160)', (c) => c.notNull().defaultTo('application/json'))
      .addColumn('headers_json', 'text', (c) => c.notNull())
      .addColumn('body', bigText, (c) => c.notNull())
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_req_examples_req', 'request_examples', ['request_id'])

    await db
      .insertInto('schema_migrations')
      .values({
        version: MIGRATION_005,
        applied_at: new Date().toISOString(),
      })
      .execute()
    newlyApplied.push(MIGRATION_005)
  }

  // =========================================================================
  // Migration 006: Mock Route Token Bucket Rate Limit
  // =========================================================================
  if (!appliedSet.has(MIGRATION_006)) {
    try {
      await db.schema
        .alterTable('mock_routes')
        .addColumn('rate_limit_rpm', 'integer', (c) => c.notNull().defaultTo(0))
        .execute()
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
      if (
        !msg.includes('duplicate column') &&
        !msg.includes('already exists') &&
        !msg.includes('1060')
      ) {
        throw err
      }
    }

    await db
      .insertInto('schema_migrations')
      .values({
        version: MIGRATION_006,
        applied_at: new Date().toISOString(),
      })
      .execute()
    newlyApplied.push(MIGRATION_006)
  }

  // =========================================================================
  // Migration 007: Laravel Policy-Style Custom RBAC Roles & Matrix
  // =========================================================================
  if (!appliedSet.has(MIGRATION_007)) {
    await db.schema
      .createTable('rbac_roles')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('slug', 'varchar(40)', (c) => c.notNull().unique())
      .addColumn('name', 'varchar(120)', (c) => c.notNull())
      .addColumn('description', 'varchar(500)')
      .addColumn('is_system', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('permissions_json', 'text', (c) => c.notNull())
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .addColumn('updated_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    const existingSlugs = new Set(
      (await db.selectFrom('rbac_roles').select('slug').execute()).map((r) => r.slug),
    )
    const nowIso = new Date().toISOString()

    for (const roleMeta of BUILTIN_ROLE_METADATA) {
      if (existingSlugs.has(roleMeta.slug)) continue
      await db
        .insertInto('rbac_roles')
        .values({
          id: crypto.randomUUID(),
          slug: roleMeta.slug,
          name: roleMeta.name,
          description: roleMeta.description,
          is_system: 1,
          permissions_json: JSON.stringify(buildDefaultRoleMatrix(roleMeta.slug)),
          created_at: nowIso,
          updated_at: nowIso,
        })
        .execute()
    }

    await db
      .insertInto('schema_migrations')
      .values({
        version: MIGRATION_007,
        applied_at: nowIso,
      })
      .execute()
    newlyApplied.push(MIGRATION_007)
  }

  // =========================================================================
  // Migration 008: Google Drive-Style Workspace Sharing & Real-Time Notifications
  // =========================================================================
  if (!appliedSet.has(MIGRATION_008)) {
    try {
      await db.schema
        .alterTable('workspaces')
        .addColumn('public_access_level', 'varchar(20)', (c) => c.notNull().defaultTo('none'))
        .execute()
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
      if (
        !msg.includes('duplicate column') &&
        !msg.includes('already exists') &&
        !msg.includes('1060')
      ) {
        throw err
      }
    }

    await db
      .updateTable('workspaces')
      .set({ public_access_level: 'edit' })
      .where('visibility', '=', 'team')
      .execute()

    await db.schema
      .createTable('workspace_invitations')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('workspace_id', 'varchar(36)', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('inviter_id', 'varchar(36)', (c) =>
        c.notNull().references('users.id').onDelete('cascade'),
      )
      .addColumn('invitee_user_id', 'varchar(36)', (c) =>
        c.notNull().references('users.id').onDelete('cascade'),
      )
      .addColumn('role', 'varchar(20)', (c) => c.notNull().defaultTo('developer'))
      .addColumn('status', 'varchar(20)', (c) => c.notNull().defaultTo('pending'))
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .addColumn('responded_at', 'varchar(40)')
      .execute()

    await createIndexSafe(db, 'idx_ws_invites_invitee', 'workspace_invitations', [
      'invitee_user_id',
      'status',
    ])
    await createIndexSafe(db, 'idx_ws_invites_ws', 'workspace_invitations', ['workspace_id'])

    await db.schema
      .createTable('notifications')
      .ifNotExists()
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey().notNull())
      .addColumn('user_id', 'varchar(36)', (c) =>
        c.notNull().references('users.id').onDelete('cascade'),
      )
      .addColumn('type', 'varchar(40)', (c) => c.notNull())
      .addColumn('title', 'varchar(200)', (c) => c.notNull())
      .addColumn('message', 'varchar(500)', (c) => c.notNull())
      .addColumn('metadata_json', 'text')
      .addColumn('is_read', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('created_at', 'varchar(40)', (c) => c.notNull())
      .execute()

    await createIndexSafe(db, 'idx_notifications_user_read', 'notifications', [
      'user_id',
      'is_read',
      'created_at',
    ])

    await db
      .insertInto('schema_migrations')
      .values({
        version: MIGRATION_008,
        applied_at: new Date().toISOString(),
      })
      .execute()
    newlyApplied.push(MIGRATION_008)
  }

  // Sanity probe across dialects
  await sql`SELECT 1`.execute(db)

  return { applied: newlyApplied }
}
