import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

export class SecretVault {
  private readonly masterKey: Buffer

  constructor(dataDir: string, explicitHexKey?: string) {
    if (explicitHexKey && /^[0-9a-fA-F]{64}$/.test(explicitHexKey.trim())) {
      this.masterKey = Buffer.from(explicitHexKey.trim(), 'hex')
      return
    }

    fs.mkdirSync(dataDir, { recursive: true })
    const keyPath = path.join(dataDir, 'master.key')

    if (fs.existsSync(keyPath)) {
      const content = fs.readFileSync(keyPath, 'utf8').trim()
      if (/^[0-9a-fA-F]{64}$/.test(content)) {
        this.masterKey = Buffer.from(content, 'hex')
        return
      }
    }

    const generated = crypto.randomBytes(32)
    fs.writeFileSync(keyPath, generated.toString('hex'), { mode: 0o600 })
    this.masterKey = generated
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return `v1:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`
  }

  decrypt(payload: string): string {
    const parts = payload.split(':')
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Invalid encrypted payload format')
    }
    const iv = Buffer.from(parts[1] ?? '', 'base64')
    const authTag = Buffer.from(parts[2] ?? '', 'base64')
    const ciphertext = Buffer.from(parts[3] ?? '', 'base64')

    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decrypted.toString('utf8')
  }
}

export function generateRandomToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('hex')
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}
