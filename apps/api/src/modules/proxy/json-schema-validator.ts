import crypto from 'node:crypto'
import type { AssertionEvaluationResult } from '@meofast/shared'

interface JsonSchemaNode {
  type?: string | string[]
  required?: string[]
  properties?: Record<string, JsonSchemaNode>
  additionalProperties?: boolean | JsonSchemaNode
  items?: JsonSchemaNode
  minItems?: number
  maxItems?: number
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  enum?: unknown[]
  const?: unknown
}

function getJsType(val: unknown): string {
  if (val === null) return 'null'
  if (Array.isArray(val)) return 'array'
  if (typeof val === 'number') return Number.isInteger(val) ? 'integer' : 'number'
  return typeof val
}

function matchesSchemaType(val: unknown, expected: string): boolean {
  const actual = getJsType(val)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  return actual === expected
}

function validateNode(
  data: unknown,
  schema: JsonSchemaNode,
  path: string,
  errors: string[],
): void {
  if (errors.length >= 10) return

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
    const ok = allowed.some((t) => matchesSchemaType(data, t))
    if (!ok) {
      errors.push(`${path}: expected ${allowed.join('|')}, got ${getJsType(data)}`)
      return
    }
  }

  if (schema.const !== undefined && JSON.stringify(data) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected constant ${JSON.stringify(schema.const)}`)
    return
  }

  if (Array.isArray(schema.enum)) {
    const matched = schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(data))
    if (!matched) {
      errors.push(`${path}: value not in enum [${schema.enum.map(String).join(', ')}]`)
      return
    }
  }

  if (typeof data === 'string') {
    if (typeof schema.minLength === 'number' && data.length < schema.minLength) {
      errors.push(`${path}: length ${data.length} < minLength ${schema.minLength}`)
    }
    if (typeof schema.maxLength === 'number' && data.length > schema.maxLength) {
      errors.push(`${path}: length ${data.length} > maxLength ${schema.maxLength}`)
    }
    if (typeof schema.pattern === 'string') {
      try {
        const re = new RegExp(schema.pattern)
        if (!re.test(data)) {
          errors.push(`${path}: does not match pattern /${schema.pattern}/`)
        }
      } catch {
        errors.push(`${path}: invalid regex pattern in schema`)
      }
    }
  }

  if (typeof data === 'number') {
    if (typeof schema.minimum === 'number' && data < schema.minimum) {
      errors.push(`${path}: ${data} < minimum ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && data > schema.maximum) {
      errors.push(`${path}: ${data} > maximum ${schema.maximum}`)
    }
  }

  if (Array.isArray(data)) {
    if (typeof schema.minItems === 'number' && data.length < schema.minItems) {
      errors.push(`${path}: array length ${data.length} < minItems ${schema.minItems}`)
    }
    if (typeof schema.maxItems === 'number' && data.length > schema.maxItems) {
      errors.push(`${path}: array length ${data.length} > maxItems ${schema.maxItems}`)
    }
    if (schema.items) {
      data.forEach((item, idx) => validateNode(item, schema.items!, `${path}[${idx}]`, errors))
    }
  }

  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!(reqKey in record) || record[reqKey] === undefined) {
          errors.push(`${path}: missing required property '${reqKey}'`)
        }
      }
    }
    if (schema.properties) {
      for (const [propKey, propSchema] of Object.entries(schema.properties)) {
        if (propKey in record && record[propKey] !== undefined) {
          validateNode(record[propKey], propSchema, `${path}.${propKey}`, errors)
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowedKeys = new Set(Object.keys(schema.properties))
      for (const key of Object.keys(record)) {
        if (!allowedKeys.has(key)) {
          errors.push(`${path}: unexpected property '${key}'`)
        }
      }
    }
  }
}

export function evaluateJsonSchemaAssertion(
  rawSchemaText: string | undefined,
  parsedJson: unknown,
  isJsonResponse: boolean,
): AssertionEvaluationResult | null {
  const trimmed = (rawSchemaText ?? '').trim()
  if (!trimmed) return null

  let schemaObj: JsonSchemaNode
  try {
    schemaObj = JSON.parse(trimmed) as JsonSchemaNode
  } catch {
    return {
      id: crypto.randomUUID(),
      type: 'json_schema',
      passed: false,
      label: 'JSON Schema Validation',
      actual: 'Invalid JSON Schema syntax',
      expected: 'Valid JSON Schema',
    }
  }

  if (!isJsonResponse) {
    return {
      id: crypto.randomUUID(),
      type: 'json_schema',
      passed: false,
      label: 'JSON Schema Validation',
      actual: 'Response body is not valid JSON',
      expected: 'Valid JSON payload',
    }
  }

  const errors: string[] = []
  validateNode(parsedJson, schemaObj, '$', errors)

  return {
    id: crypto.randomUUID(),
    type: 'json_schema',
    passed: errors.length === 0,
    label: 'JSON Schema Validation',
    actual: errors.length === 0 ? 'Schema matched' : errors[0]!,
    expected: 'Schema matched',
  }
}
