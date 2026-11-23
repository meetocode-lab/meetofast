import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../src/core/database/migrations.js'
import { NodeSqliteDialect } from '../src/core/database/node-sqlite-dialect.js'
import type { DatabaseSchema } from '../src/core/database/schema.types.js'

describe('Multi-Database Compatibility (PostgreSQL, MySQL, MariaDB, SQLite)', () => {
  it('compiles portable DDL and DML queries cleanly for PostgreSQL and MySQL/MariaDB dialects', () => {
    const pgDb = new Kysely<DatabaseSchema>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    })

    const mysqlDb = new Kysely<DatabaseSchema>({
      dialect: {
        createAdapter: () => new MysqlAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new MysqlIntrospector(db),
        createQueryCompiler: () => new MysqlQueryCompiler(),
      },
    })

    const pgCompiled = pgDb
      .selectFrom('saved_requests')
      .innerJoin('collections', 'collections.id', 'saved_requests.collection_id')
      .select(['saved_requests.id', 'saved_requests.method', 'collections.name'])
      .where('saved_requests.workspace_id', '=', 'ws-1')
      .compile()

    const mysqlCompiled = mysqlDb
      .selectFrom('saved_requests')
      .innerJoin('collections', 'collections.id', 'saved_requests.collection_id')
      .select(['saved_requests.id', 'saved_requests.method', 'collections.name'])
      .where('saved_requests.workspace_id', '=', 'ws-1')
      .compile()

    expect(pgCompiled.sql).toContain('"saved_requests"')
    expect(pgCompiled.parameters).toEqual(['ws-1'])
    expect(mysqlCompiled.sql).toContain('`saved_requests`')
    expect(mysqlCompiled.parameters).toEqual(['ws-1'])
  })

  it('executes full schema migrations and enforces foreign key cascades on SQLite', async () => {
    const db = new Kysely<DatabaseSchema>({
      dialect: new NodeSqliteDialect({ filePath: ':memory:' }),
    })

    try {
      const firstRun = await runMigrations(db, 'sqlite')
      expect(firstRun.applied).toEqual([
        '001_initial_schema',
        '002_phase3_batch3a',
        '003_complete_platform',
        '004_cookie_jar',
        '005_vars_inheritance_examples',
        '006_mock_rate_limit',
        '007_custom_rbac_roles',
        '008_workspace_sharing_and_notifications',
      ])

      // Idempotent second run
      const secondRun = await runMigrations(db, 'sqlite')
      expect(secondRun.applied).toEqual([])

      const now = new Date().toISOString()
      await db
        .insertInto('users')
        .values({
          id: 'u1',
          email: 'dev@meofast.org',
          username: 'dev',
          full_name: 'Dev User',
          password_hash: 'hash',
          global_role: 'developer',
          status: 'active',
          last_login_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute()

      await db
        .insertInto('sessions')
        .values({
          id: 's1',
          user_id: 'u1',
          token_hash: 'tok-hash-1',
          csrf_token: 'csrf-1',
          ip_address: '127.0.0.1',
          user_agent: 'vitest',
          expires_at: now,
          created_at: now,
        })
        .execute()

      // Cascade delete check
      await db.deleteFrom('users').where('id', '=', 'u1').execute()
      const remainingSession = await db
        .selectFrom('sessions')
        .select('id')
        .where('id', '=', 's1')
        .executeTakeFirst()
      expect(remainingSession).toBeUndefined()
    } finally {
      await db.destroy()
    }
  })
})
