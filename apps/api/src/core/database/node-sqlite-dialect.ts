import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely'

export interface NodeSqliteDialectConfig {
  filePath: string
}

function normalizeParam(param: unknown): SQLInputValue {
  if (param === undefined || param === null) return null
  if (typeof param === 'boolean') return param ? 1 : 0
  if (typeof param === 'number' || typeof param === 'bigint' || typeof param === 'string') {
    return param
  }
  if (param instanceof Uint8Array) {
    return param
  }
  if (param instanceof Date) {
    return param.toISOString()
  }
  return JSON.stringify(param)
}

class NodeSqliteConnection implements DatabaseConnection {
  constructor(private readonly db: DatabaseSync) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery
    const params = parameters.map(normalizeParam)
    const stmt = this.db.prepare(sql)

    if (/^\s*(select|pragma|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      const rawRows = stmt.all(...params) as Array<Record<string, unknown>>
      const rows = rawRows.map((row) => ({ ...row })) as R[]
      return { rows }
    }

    const result = stmt.run(...params)
    return {
      rows: [],
      numAffectedRows: BigInt(result.changes),
      insertId: BigInt(result.lastInsertRowid),
    }
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(compiledQuery)
  }
}

class NodeSqliteDriver implements Driver {
  private db: DatabaseSync | null = null
  private connection: NodeSqliteConnection | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly config: NodeSqliteDialectConfig) {}

  async init(): Promise<void> {
    if (this.config.filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.config.filePath), { recursive: true })
    }
    this.db = new DatabaseSync(this.config.filePath)
    if (this.config.filePath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;')
    }
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.connection = new NodeSqliteConnection(this.db)
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.connection) {
      await this.init()
    }
    return this.connection!
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    let release!: () => void
    const prev = this.queue
    this.queue = new Promise<void>((res) => {
      release = res
    })
    ;(connection as unknown as { _releaseLock?: () => void })._releaseLock = release
    await prev
    await connection.executeQuery(CompiledQuery.raw('BEGIN'))
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    try {
      await connection.executeQuery(CompiledQuery.raw('COMMIT'))
    } finally {
      ;(connection as unknown as { _releaseLock?: () => void })._releaseLock?.()
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    try {
      await connection.executeQuery(CompiledQuery.raw('ROLLBACK'))
    } finally {
      ;(connection as unknown as { _releaseLock?: () => void })._releaseLock?.()
    }
  }

  async releaseConnection(): Promise<void> {
    // Single serialized SQLite connection
  }

  async destroy(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = null
      this.connection = null
    }
  }
}

export class NodeSqliteDialect implements Dialect {
  constructor(private readonly config: NodeSqliteDialectConfig) {}

  createAdapter() {
    return new SqliteAdapter()
  }

  createDriver() {
    return new NodeSqliteDriver(this.config)
  }

  createIntrospector(db: Kysely<unknown>) {
    return new SqliteIntrospector(db)
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler()
  }
}
