export interface DecodedJwtResult {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  expiresAtIso: string | null
  issuedAtIso: string | null
  isExpired: boolean
}

function decodeBase64Url(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (normalized.length % 4)) % 4
  const padded = normalized + '='.repeat(padLen)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function decodeJwtToken(rawInput: string): DecodedJwtResult | null {
  const cleaned = rawInput.trim().replace(/^Bearer\s+/i, '').trim()
  const parts = cleaned.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null

  try {
    const header = JSON.parse(decodeBase64Url(parts[0])) as Record<string, unknown>
    const payload = JSON.parse(decodeBase64Url(parts[1])) as Record<string, unknown>
    if (typeof header !== 'object' || header === null || typeof payload !== 'object' || payload === null) {
      return null
    }

    const expSec = typeof payload.exp === 'number' ? payload.exp : null
    const iatSec = typeof payload.iat === 'number' ? payload.iat : null
    const expiresAtIso = expSec ? new Date(expSec * 1000).toISOString() : null
    const issuedAtIso = iatSec ? new Date(iatSec * 1000).toISOString() : null
    const isExpired = expSec ? expSec * 1000 <= Date.now() : false

    return {
      header,
      payload,
      expiresAtIso,
      issuedAtIso,
      isExpired,
    }
  } catch {
    return null
  }
}

function toPascalCase(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9]+/g, ' ').trim()
  if (!cleaned) return 'Item'
  const res = cleaned
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
  return /^[0-9]/.test(res) ? `T${res}` : res
}

function isValidIdentifier(key: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
}

export function generateTypeScriptFromJson(value: unknown, rootName = 'ApiResponse'): string {
  const interfaces: string[] = []
  const seenNames = new Set<string>()

  function uniqueName(base: string): string {
    let candidate = toPascalCase(base)
    let n = 2
    while (seenNames.has(candidate)) {
      candidate = `${toPascalCase(base)}${n}`
      n += 1
    }
    seenNames.add(candidate)
    return candidate
  }

  function inferTs(val: unknown, hintName: string): string {
    if (val === null) return 'null'
    if (val === undefined) return 'unknown'
    if (typeof val === 'string') return 'string'
    if (typeof val === 'number') return 'number'
    if (typeof val === 'boolean') return 'boolean'

    if (Array.isArray(val)) {
      if (val.length === 0) return 'unknown[]'
      const elemTypes = Array.from(new Set(val.slice(0, 12).map((item) => inferTs(item, `${hintName}Item`))))
      const union = elemTypes.length === 1 ? elemTypes[0]! : `(${elemTypes.join(' | ')})`
      return `${union}[]`
    }

    if (typeof val === 'object') {
      const ifaceName = uniqueName(hintName)
      const entries = Object.entries(val as Record<string, unknown>)
      if (entries.length === 0) {
        return 'Record<string, unknown>'
      }
      const lines = entries.map(([k, v]) => {
        const prop = isValidIdentifier(k) ? k : JSON.stringify(k)
        return `  ${prop}: ${inferTs(v, k)}`
      })
      interfaces.push(`export interface ${ifaceName} {\n${lines.join('\n')}\n}`)
      return ifaceName
    }

    return 'unknown'
  }

  const rootType = inferTs(value, rootName)
  if (interfaces.length === 0) {
    return `export type ${toPascalCase(rootName)} = ${rootType}\n`
  }
  return `${interfaces.reverse().join('\n\n')}\n`
}

export function generateZodFromJson(value: unknown, rootName = 'apiResponse'): string {
  function inferZod(val: unknown, indent = 0): string {
    const pad = '  '.repeat(indent)
    const innerPad = '  '.repeat(indent + 1)

    if (val === null) return 'z.null()'
    if (typeof val === 'string') return 'z.string()'
    if (typeof val === 'number') return Number.isInteger(val) ? 'z.number().int()' : 'z.number()'
    if (typeof val === 'boolean') return 'z.boolean()'

    if (Array.isArray(val)) {
      if (val.length === 0) return 'z.array(z.unknown())'
      return `z.array(${inferZod(val[0], indent)})`
    }

    if (typeof val === 'object' && val !== null) {
      const entries = Object.entries(val as Record<string, unknown>)
      if (entries.length === 0) return 'z.record(z.unknown())'
      const fields = entries.map(([k, v]) => {
        const prop = isValidIdentifier(k) ? k : JSON.stringify(k)
        return `${innerPad}${prop}: ${inferZod(v, indent + 1)},`
      })
      return `z.object({\n${fields.join('\n')}\n${pad}})`
    }

    return 'z.unknown()'
  }

  const cleanVar = rootName.replace(/[^a-zA-Z0-9_$]/g, '') || 'apiResponse'
  const schemaVar = `${cleanVar.charAt(0).toLowerCase()}${cleanVar.slice(1)}Schema`
  const typeName = toPascalCase(cleanVar)

  return `import { z } from 'zod'\n\nexport const ${schemaVar} = ${inferZod(value, 0)}\n\nexport type ${typeName} = z.infer<typeof ${schemaVar}>\n`
}

export function generateJsonSchemaFromJson(value: unknown): string {
  function inferSchema(val: unknown): Record<string, unknown> {
    if (val === null) return { type: 'null' }
    if (typeof val === 'string') return { type: 'string' }
    if (typeof val === 'number') {
      return { type: Number.isInteger(val) ? 'integer' : 'number' }
    }
    if (typeof val === 'boolean') return { type: 'boolean' }

    if (Array.isArray(val)) {
      return {
        type: 'array',
        items: val.length > 0 ? inferSchema(val[0]) : {},
      }
    }

    if (typeof val === 'object' && val !== null) {
      const entries = Object.entries(val as Record<string, unknown>)
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [k, v] of entries) {
        properties[k] = inferSchema(v)
        if (v !== null && v !== undefined) {
          required.push(k)
        }
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      }
    }

    return {}
  }

  return JSON.stringify(
    {
      $schema: 'http://json-schema.org/draft-07/schema#',
      ...inferSchema(value),
    },
    null,
    2,
  )
}

export function generateGoStructFromJson(value: unknown, rootName = 'ApiResponse'): string {
  const structs: string[] = []
  const seen = new Set<string>()

  function uniqueStruct(base: string): string {
    let candidate = toPascalCase(base)
    let n = 2
    while (seen.has(candidate)) {
      candidate = `${toPascalCase(base)}${n}`
      n += 1
    }
    seen.add(candidate)
    return candidate
  }

  function inferGo(val: unknown, hint: string): string {
    if (val === null || val === undefined) return 'any'
    if (typeof val === 'string') return 'string'
    if (typeof val === 'boolean') return 'bool'
    if (typeof val === 'number') return Number.isInteger(val) ? 'int64' : 'float64'

    if (Array.isArray(val)) {
      if (val.length === 0) return '[]any'
      return `[]${inferGo(val[0], `${hint}Item`)}`
    }

    if (typeof val === 'object') {
      const structName = uniqueStruct(hint)
      const entries = Object.entries(val as Record<string, unknown>)
      if (entries.length === 0) return 'map[string]any'
      const fields = entries.map(
        ([k, v]) => `\t${toPascalCase(k)} ${inferGo(v, k)} \`json:"${k}"\``,
      )
      structs.push(`type ${structName} struct {\n${fields.join('\n')}\n}`)
      return structName
    }

    return 'any'
  }

  const rootGo = inferGo(value, rootName)
  if (structs.length === 0) {
    return `type ${toPascalCase(rootName)} ${rootGo}\n`
  }
  return `${structs.reverse().join('\n\n')}\n`
}
