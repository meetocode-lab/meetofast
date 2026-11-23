import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DatabaseConfig, DatabaseValidationResult } from '@meofast/shared'
import { Kysely, MysqlDialect, PostgresDialect } from 'kysely'
import mysql from 'mysql2'
import mysqlPromise from 'mysql2/promise'
import pg from 'pg'
import { AppError } from '../errors/app-error.js'
import { NodeSqliteDialect } from './node-sqlite-dialect.js'
import type { DatabaseSchema } from './schema.types.js'

const SAFE_DB_IDENTIFIER = /^[a-zA-Z0-9_-]{1,64}$/

export function resolveSqliteFilePath(
  config: Extract<DatabaseConfig, { engine: 'sqlite' }>,
  defaultDataDir: string,
): string {
  if (config.filename === ':memory:') return ':memory:'
  const baseDir = path.isAbsolute(config.storageDir)
    ? config.storageDir
    : path.resolve(defaultDataDir, config.storageDir === './data' ? '.' : config.storageDir)
  return path.join(baseDir, config.filename)
}

export function createKyselyDatabase(
  config: DatabaseConfig,
  defaultDataDir: string,
): Kysely<DatabaseSchema> {
  if (config.engine === 'sqlite') {
    const filePath = resolveSqliteFilePath(config, defaultDataDir)
    return new Kysely<DatabaseSchema>({
      dialect: new NodeSqliteDialect({ filePath }),
    })
  }

  if (config.engine === 'postgresql') {
    const ssl =
      config.sslMode === 'require'
        ? { rejectUnauthorized: false }
        : config.sslMode === 'prefer'
          ? { rejectUnauthorized: false }
          : false

    const pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl,
      max: 15,
      connectionTimeoutMillis: 6000,
    })

    return new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
    })
  }

  // mysql or mariadb
  const ssl = config.sslMode === 'require' ? { rejectUnauthorized: false } : undefined
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl,
    connectionLimit: 15,
    connectTimeout: 6000,
  })

  return new Kysely<DatabaseSchema>({
    dialect: new MysqlDialect({ pool: pool as unknown as never }),
  })
}

export async function validateDatabaseConnection(
  config: DatabaseConfig,
  defaultDataDir: string,
): Promise<DatabaseValidationResult> {
  if (config.engine === 'sqlite') {
    try {
      const filePath = resolveSqliteFilePath(config, defaultDataDir)
      if (filePath !== ':memory:') {
        const dir = path.dirname(filePath)
        fs.mkdirSync(dir, { recursive: true })
        fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK)
      }
      const alreadyExists = filePath === ':memory:' ? true : fs.existsSync(filePath)
      const db = new DatabaseSync(filePath)
      try {
        const versionRow = db.prepare('SELECT sqlite_version() AS version').get() as
          | { version?: string }
          | undefined
        const tablesRow = db
          .prepare(
            "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .get() as { cnt?: number } | undefined
        db.exec(
          'CREATE TEMP TABLE IF NOT EXISTS _meofast_perm_probe (id INTEGER); DROP TABLE _meofast_perm_probe;',
        )
        return {
          valid: true,
          engine: 'sqlite',
          reachable: true,
          authenticated: true,
          databaseExists: alreadyExists || true,
          canCreateDatabase: true,
          permissionsOk: true,
          serverVersion: `SQLite ${versionRow?.version ?? '3.x'}`,
          existingTablesCount: Number(tablesRow?.cnt ?? 0),
          message: `SQLite storage verified at ${filePath}`,
        }
      } finally {
        db.close()
      }
    } catch (err) {
      return {
        valid: false,
        engine: 'sqlite',
        reachable: false,
        authenticated: false,
        databaseExists: false,
        canCreateDatabase: false,
        permissionsOk: false,
        message: err instanceof Error ? err.message : 'Unable to initialize SQLite storage directory',
        errorCode: 'SQLITE_STORAGE_ERROR',
      }
    }
  }

  if (config.engine === 'postgresql') {
    const ssl = config.sslMode === 'require' ? { rejectUnauthorized: false } : false
    const client = new pg.Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl,
      connectionTimeoutMillis: 5000,
    })

    try {
      await client.connect()
      const verRes = await client.query<{ version: string }>('SHOW server_version')
      const tblRes = await client.query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM information_schema.tables WHERE table_schema = 'public'",
      )
      await client.query(
        'CREATE TEMP TABLE _meofast_perm_probe (id int); DROP TABLE _meofast_perm_probe;',
      )
      await client.end()

      return {
        valid: true,
        engine: 'postgresql',
        reachable: true,
        authenticated: true,
        databaseExists: true,
        canCreateDatabase: false,
        permissionsOk: true,
        serverVersion: `PostgreSQL ${verRes.rows[0]?.version ?? ''}`.trim(),
        existingTablesCount: Number(tblRes.rows[0]?.cnt ?? 0),
        message: `Connected to PostgreSQL database '${config.database}' successfully.`,
      }
    } catch (err) {
      try {
        await client.end()
      } catch {
        // ignore cleanup error
      }
      const pgErr = err as { code?: string; message?: string }
      if (pgErr.code === '3D000') {
        // Database does not exist; check if credentials can reach maintenance DB 'postgres'
        const adminClient = new pg.Client({
          host: config.host,
          port: config.port,
          database: 'postgres',
          user: config.username,
          password: config.password,
          ssl,
          connectionTimeoutMillis: 5000,
        })
        try {
          await adminClient.connect()
          const roleRes = await adminClient.query<{ rolcreatedb: boolean; rolsuper: boolean }>(
            'SELECT rolcreatedb, rolsuper FROM pg_roles WHERE rolname = current_user',
          )
          const canCreate = Boolean(roleRes.rows[0]?.rolcreatedb || roleRes.rows[0]?.rolsuper)
          await adminClient.end()
          return {
            valid: false,
            engine: 'postgresql',
            reachable: true,
            authenticated: true,
            databaseExists: false,
            canCreateDatabase: canCreate,
            permissionsOk: canCreate,
            errorCode: 'DATABASE_NOT_FOUND',
            message: canCreate
              ? `Database '${config.database}' does not exist yet. Your account has permission to create it.`
              : `Database '${config.database}' does not exist and user '${config.username}' lacks CREATEDB privilege.`,
          }
        } catch {
          try {
            await adminClient.end()
          } catch {
            // ignore
          }
        }
      }

      const authFailed = pgErr.code === '28P01' || pgErr.code === '28000'
      return {
        valid: false,
        engine: 'postgresql',
        reachable: authFailed,
        authenticated: false,
        databaseExists: false,
        canCreateDatabase: false,
        permissionsOk: false,
        errorCode: pgErr.code ?? 'PG_CONNECT_ERROR',
        message: authFailed
          ? 'Authentication failed: verify username and password.'
          : `Could not connect to PostgreSQL at ${config.host}:${config.port} (${pgErr.message ?? 'connection error'}).`,
      }
    }
  }

  // MySQL or MariaDB
  const ssl = config.sslMode === 'require' ? { rejectUnauthorized: false } : undefined
  try {
    const conn = await mysqlPromise.createConnection({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl,
      connectTimeout: 5000,
    })
    try {
      const [verRows] = await conn.query('SELECT VERSION() AS version')
      const versionStr = String(
        (verRows as Array<{ version?: string }>)[0]?.version ?? config.engine,
      )
      const [tblRows] = await conn.query(
        'SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = ?',
        [config.database],
      )
      const cnt = Number((tblRows as Array<{ cnt?: number }>)[0]?.cnt ?? 0)
      await conn.query('CREATE TEMPORARY TABLE _meofast_perm_probe (id INT)')
      await conn.query('DROP TEMPORARY TABLE _meofast_perm_probe')

      return {
        valid: true,
        engine: config.engine,
        reachable: true,
        authenticated: true,
        databaseExists: true,
        canCreateDatabase: false,
        permissionsOk: true,
        serverVersion: versionStr,
        existingTablesCount: cnt,
        message: `Connected to ${config.engine === 'mariadb' ? 'MariaDB' : 'MySQL'} database '${config.database}' (${versionStr}).`,
      }
    } finally {
      await conn.end()
    }
  } catch (err) {
    const myErr = err as { code?: string; errno?: number; message?: string }
    if (myErr.code === 'ER_BAD_DB_ERROR' || myErr.errno === 1049) {
      try {
        const rootConn = await mysqlPromise.createConnection({
          host: config.host,
          port: config.port,
          user: config.username,
          password: config.password,
          ssl,
          connectTimeout: 5000,
        })
        await rootConn.end()
        return {
          valid: false,
          engine: config.engine,
          reachable: true,
          authenticated: true,
          databaseExists: false,
          canCreateDatabase: true,
          permissionsOk: true,
          errorCode: 'DATABASE_NOT_FOUND',
          message: `Database '${config.database}' does not exist yet. Click 'Create Database' to create it explicitly.`,
        }
      } catch {
        // fall through
      }
    }

    const authFailed = myErr.code === 'ER_ACCESS_DENIED_ERROR' || myErr.errno === 1045
    return {
      valid: false,
      engine: config.engine,
      reachable: authFailed,
      authenticated: false,
      databaseExists: false,
      canCreateDatabase: false,
      permissionsOk: false,
      errorCode: myErr.code ?? 'MYSQL_CONNECT_ERROR',
      message: authFailed
        ? 'Authentication failed: invalid database username or password.'
        : `Could not connect to ${config.host}:${config.port} (${myErr.message ?? 'connection error'}).`,
    }
  }
}

export async function createDatabaseExplicitly(config: DatabaseConfig): Promise<void> {
  if (config.engine === 'sqlite') {
    return
  }

  if (!SAFE_DB_IDENTIFIER.test(config.database)) {
    throw new AppError(400, 'INVALID_DATABASE_NAME', 'Unsafe database identifier')
  }

  if (config.engine === 'postgresql') {
    const ssl = config.sslMode === 'require' ? { rejectUnauthorized: false } : false
    const client = new pg.Client({
      host: config.host,
      port: config.port,
      database: 'postgres',
      user: config.username,
      password: config.password,
      ssl,
      connectionTimeoutMillis: 5000,
    })
    await client.connect()
    try {
      const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        config.database,
      ])
      if (exists.rowCount && exists.rowCount > 0) {
        throw new AppError(
          409,
          'DATABASE_ALREADY_EXISTS',
          `Database '${config.database}' already exists; refusing to overwrite.`,
        )
      }
      await client.query(`CREATE DATABASE "${config.database}" ENCODING 'UTF8'`)
    } finally {
      await client.end()
    }
    return
  }

  // MySQL / MariaDB
  const ssl = config.sslMode === 'require' ? { rejectUnauthorized: false } : undefined
  const conn = await mysqlPromise.createConnection({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    ssl,
    connectTimeout: 5000,
  })
  try {
    const [existing] = await conn.query(
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
      [config.database],
    )
    if ((existing as unknown[]).length > 0) {
      throw new AppError(
        409,
        'DATABASE_ALREADY_EXISTS',
        `Database '${config.database}' already exists; refusing to overwrite.`,
      )
    }
    await conn.query(
      `CREATE DATABASE \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    )
  } finally {
    await conn.end()
  }
}
