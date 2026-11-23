import crypto from 'node:crypto'

const ARGON2_MEMORY_KIB = 65536 // 64 MiB
const ARGON2_PASSES = 3
const ARGON2_PARALLELISM = 4
const ARGON2_TAG_LENGTH = 32
const SALT_BYTES = 16

/**
 * Hashes a password using Node.js native RFC 9106 Argon2id and encodes in standard PHC format:
 * $argon2id$v=19$m=65536,t=3,p=4$<base64_no_pad_salt>$<base64_no_pad_hash>
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES)
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    crypto.argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        parallelism: ARGON2_PARALLELISM,
        tagLength: ARGON2_TAG_LENGTH,
        memory: ARGON2_MEMORY_KIB,
        passes: ARGON2_PASSES,
      },
      (err, key) => {
        if (err) reject(err)
        else resolve(key)
      },
    )
  })

  const saltB64 = salt.toString('base64').replace(/=+$/, '')
  const hashB64 = derivedKey.toString('base64').replace(/=+$/, '')
  return `$argon2id$v=19$m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}$${saltB64}$${hashB64}`
}

/**
 * Verifies a password against an Argon2id PHC string in constant time.
 */
export async function verifyPassword(password: string, phcHash: string): Promise<boolean> {
  try {
    const parts = phcHash.split('$')
    // ['', 'argon2id', 'v=19', 'm=65536,t=3,p=4', salt, hash]
    if (parts.length !== 6 || parts[1] !== 'argon2id') {
      return false
    }

    const paramMap = new Map<string, number>()
    for (const kv of (parts[3] ?? '').split(',')) {
      const [k, v] = kv.split('=')
      if (k && v) paramMap.set(k, Number(v))
    }

    const memory = paramMap.get('m') ?? ARGON2_MEMORY_KIB
    const passes = paramMap.get('t') ?? ARGON2_PASSES
    const parallelism = paramMap.get('p') ?? ARGON2_PARALLELISM
    const salt = Buffer.from(parts[4] ?? '', 'base64')
    const expectedHash = Buffer.from(parts[5] ?? '', 'base64')

    if (salt.length < 8 || expectedHash.length < 16) {
      return false
    }

    const actualHash = await new Promise<Buffer>((resolve, reject) => {
      crypto.argon2(
        'argon2id',
        {
          message: Buffer.from(password, 'utf8'),
          nonce: salt,
          parallelism,
          tagLength: expectedHash.length,
          memory,
          passes,
        },
        (err, key) => {
          if (err) reject(err)
          else resolve(key)
        },
      )
    })

    if (actualHash.length !== expectedHash.length) {
      return false
    }
    return crypto.timingSafeEqual(actualHash, expectedHash)
  } catch {
    return false
  }
}
