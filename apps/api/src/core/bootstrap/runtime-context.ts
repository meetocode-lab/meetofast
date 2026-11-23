import fs from 'node:fs'
import path from 'node:path'
import { type DatabaseConfig, databaseConfigSchema, type DatabaseEngine } from '@meofast/shared'
import type { Kysely } from 'kysely'
import { generateRandomToken, SecretVault } from '../crypto/vault.js'
import { createKyselyDatabase } from '../database/connection-manager.js'
import { runMigrations } from '../database/migrations.js'
import type { DatabaseSchema } from '../database/schema.types.js'
import { AppError } from '../errors/app-error.js'

interface PersistedLockFile {
  installedAt: string
  version: string
  engine: DatabaseEngine
}

export class RuntimeContext {
  public readonly dataDir: string
  public readonly vault: SecretVault
  public localFetch: ((req: Request) => Promise<Response> | Response) | null = null
  private db: Kysely<DatabaseSchema> | null = null
  private dbConfig: DatabaseConfig | null = null
  private installed = false
  private bootstrapCsrfSecrets = new Set<string>()

  constructor(dataDir?: string, masterKeyHex?: string) {
    this.dataDir = path.resolve(
      dataDir ?? process.env.MEOFAST_DATA_DIR ?? path.join(process.cwd(), 'data'),
    )
    fs.mkdirSync(this.dataDir, { recursive: true })
    this.vault = new SecretVault(this.dataDir, masterKeyHex ?? process.env.MEOFAST_MASTER_KEY)
  }

  private get lockFilePath(): string {
    return path.join(this.dataDir, 'install.lock')
  }

  private get encryptedConfigPath(): string {
    return path.join(this.dataDir, 'config.enc.json')
  }

  isInstalled(): boolean {
    return this.installed
  }

  getConfiguredEngine(): DatabaseEngine | undefined {
    return this.dbConfig?.engine
  }

  getDb(): Kysely<DatabaseSchema> {
    if (!this.db || !this.installed) {
      throw new AppError(
        503,
        'SETUP_REQUIRED',
        'Meofast installation has not been completed yet. Please finish setup at /setup.',
      )
    }
    return this.db
  }

  issueBootstrapCsrfToken(): string {
    const token = generateRandomToken(24)
    this.bootstrapCsrfSecrets.add(token)
    if (this.bootstrapCsrfSecrets.size > 200) {
      const oldest = this.bootstrapCsrfSecrets.values().next().value
      if (oldest) this.bootstrapCsrfSecrets.delete(oldest)
    }
    return token
  }

  verifyBootstrapCsrfToken(token: string | undefined | null): boolean {
    if (!token) return false
    return this.bootstrapCsrfSecrets.has(token)
  }

  /**
   * Called at server boot: if install.lock + config.enc.json exist, decrypts config,
   * connects Kysely, runs any pending migrations, and enters INSTALLED mode.
   */
  async initializeFromDisk(): Promise<void> {
    if (!fs.existsSync(this.lockFilePath) || !fs.existsSync(this.encryptedConfigPath)) {
      this.installed = false
      return
    }

    const rawEnc = fs.readFileSync(this.encryptedConfigPath, 'utf8')
    const parsedWrapper = JSON.parse(rawEnc) as { ciphertext: string }
    const decryptedJson = this.vault.decrypt(parsedWrapper.ciphertext)
    const validatedConfig = databaseConfigSchema.parse(JSON.parse(decryptedJson))

    const db = createKyselyDatabase(validatedConfig, this.dataDir)
    await runMigrations(db, validatedConfig.engine)

    const completedSetting = await db
      .selectFrom('system_settings')
      .select('setting_value')
      .where('setting_key', '=', 'installation_completed')
      .executeTakeFirst()

    if (completedSetting?.setting_value !== 'true') {
      await db.destroy()
      this.installed = false
      return
    }

    this.db = db
    this.dbConfig = validatedConfig
    this.installed = true
  }

  /**
   * Atomically persists encrypted DB config and install.lock, and activates live runtime DB
   * without requiring a container restart.
   */
  async commitInstallation(
    config: DatabaseConfig,
    liveDb: Kysely<DatabaseSchema>,
    version: string,
  ): Promise<void> {
    if (this.installed || fs.existsSync(this.lockFilePath)) {
      throw new AppError(
        403,
        'INSTALLATION_LOCKED',
        'Installation has already been completed and locked.',
      )
    }

    const ciphertext = this.vault.encrypt(JSON.stringify(config))
    const tempConfigPath = `${this.encryptedConfigPath}.tmp`
    fs.writeFileSync(tempConfigPath, JSON.stringify({ ciphertext }, null, 2), { mode: 0o600 })
    fs.renameSync(tempConfigPath, this.encryptedConfigPath)

    const lockPayload: PersistedLockFile = {
      installedAt: new Date().toISOString(),
      version,
      engine: config.engine,
    }
    const tempLockPath = `${this.lockFilePath}.tmp`
    fs.writeFileSync(tempLockPath, JSON.stringify(lockPayload, null, 2), { mode: 0o600 })
    fs.renameSync(tempLockPath, this.lockFilePath)

    if (this.db && this.db !== liveDb) {
      await this.db.destroy()
    }
    this.db = liveDb
    this.dbConfig = config
    this.installed = true
    this.bootstrapCsrfSecrets.clear()
  }

  async shutdown(): Promise<void> {
    if (this.db) {
      await this.db.destroy()
      this.db = null
    }
  }
}
