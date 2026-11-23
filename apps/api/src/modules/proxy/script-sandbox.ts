import crypto from 'node:crypto'
import vm from 'node:vm'
import type { AssertionEvaluationResult } from '@meofast/shared'

export interface ScriptExecutionContext {
  variables: Map<string, string>
  requestHeaders: Map<string, string>
  response?: {
    status: number
    statusText: string
    durationMs: number
    headers: Record<string, string>
    body: string
    parsedJson: unknown
    isJson: boolean
  }
}

export interface ScriptExecutionOutput {
  updatedEnvironmentVars: Map<string, string>
  addedHeaders: Array<{ key: string; value: string }>
  assertions: AssertionEvaluationResult[]
  logs: Array<{ timestamp: string; level: 'info' | 'warn' | 'error'; message: string }>
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return false
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

function createExpectChain(actual: unknown, negated = false) {
  const check = (condition: boolean, expectedDesc: string) => {
    const ok = negated ? !condition : condition
    if (!ok) {
      throw new Error(
        `Expected ${JSON.stringify(actual)} ${negated ? 'not ' : ''}${expectedDesc}`,
      )
    }
  }

  const api = {
    get to() {
      return api
    },
    get be() {
      return api
    },
    get have() {
      return api
    },
    get not() {
      return createExpectChain(actual, !negated)
    },
    equal(expected: unknown) {
      check(actual === expected, `to equal ${JSON.stringify(expected)}`)
    },
    eql(expected: unknown) {
      check(deepEqual(actual, expected), `to deeply equal ${JSON.stringify(expected)}`)
    },
    above(n: number) {
      check(typeof actual === 'number' && actual > n, `to be above ${n}`)
    },
    below(n: number) {
      check(typeof actual === 'number' && actual < n, `to be below ${n}`)
    },
    include(item: unknown) {
      const cond =
        typeof actual === 'string'
          ? actual.includes(String(item))
          : Array.isArray(actual)
            ? actual.includes(item)
            : false
      check(cond, `to include ${JSON.stringify(item)}`)
    },
    property(prop: string, val?: unknown) {
      const has =
        actual !== null &&
        typeof actual === 'object' &&
        Object.prototype.hasOwnProperty.call(actual, prop)
      check(has, `to have property '${prop}'`)
      if (has && arguments.length > 1) {
        const propVal = (actual as Record<string, unknown>)[prop]
        check(deepEqual(propVal, val), `property '${prop}' to equal ${JSON.stringify(val)}`)
      }
    },
    get ok() {
      check(Boolean(actual), 'to be truthy')
      return true
    },
    get true() {
      check(actual === true, 'to be true')
      return true
    },
    get false() {
      check(actual === false, 'to be false')
      return true
    },
  }

  return api
}

export function runSandboxedScript(
  scriptCode: string,
  phase: 'pre_request' | 'test',
  ctx: ScriptExecutionContext,
): ScriptExecutionOutput {
  const updatedEnvironmentVars = new Map<string, string>()
  const addedHeaders: Array<{ key: string; value: string }> = []
  const assertions: AssertionEvaluationResult[] = []
  const logs: Array<{ timestamp: string; level: 'info' | 'warn' | 'error'; message: string }> = []

  const trimmed = scriptCode.trim()
  if (!trimmed) {
    return { updatedEnvironmentVars, addedHeaders, assertions, logs }
  }

  const pushLog = (level: 'info' | 'warn' | 'error', args: unknown[]) => {
    if (logs.length >= 50) return
    const msg = args
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join(' ')
    logs.push({ timestamp: new Date().toISOString(), level, message: `[${phase}] ${msg}` })
  }

  const envApi = Object.freeze({
    get(key: string): string | undefined {
      return ctx.variables.get(String(key))
    },
    set(key: string, value: unknown): void {
      const k = String(key).trim()
      if (!k) return
      const v = value === undefined || value === null ? '' : String(value)
      ctx.variables.set(k, v)
      updatedEnvironmentVars.set(k, v)
    },
  })

  const lowerResHeaders = new Map(
    Object.entries(ctx.response?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  )

  const pmObject = Object.freeze({
    environment: envApi,
    variables: envApi,
    request: Object.freeze({
      headers: Object.freeze({
        add(header: { key: string; value: string } | string, val?: string) {
          if (typeof header === 'string') {
            addedHeaders.push({ key: header, value: String(val ?? '') })
            ctx.requestHeaders.set(header, String(val ?? ''))
          } else if (header && typeof header === 'object' && header.key) {
            addedHeaders.push({ key: String(header.key), value: String(header.value ?? '') })
            ctx.requestHeaders.set(String(header.key), String(header.value ?? ''))
          }
        },
        get(name: string) {
          return ctx.requestHeaders.get(name)
        },
      }),
    }),
    response: ctx.response
      ? Object.freeze({
          code: ctx.response.status,
          status: ctx.response.statusText,
          responseTime: ctx.response.durationMs,
          text: () => ctx.response!.body,
          json: () => {
            if (ctx.response!.isJson) return ctx.response!.parsedJson
            return JSON.parse(ctx.response!.body)
          },
          headers: Object.freeze({
            get: (name: string) => lowerResHeaders.get(String(name).toLowerCase()),
          }),
        })
      : undefined,
    expect: (actual: unknown) => createExpectChain(actual),
    test(label: string, fn: () => void) {
      const testName = String(label || 'Script test')
      try {
        fn()
        assertions.push({
          id: crypto.randomUUID(),
          type: 'script',
          passed: true,
          label: testName,
          actual: 'passed',
          expected: 'passed',
        })
      } catch (err) {
        assertions.push({
          id: crypto.randomUUID(),
          type: 'script',
          passed: false,
          label: testName,
          actual: err instanceof Error ? err.message : 'Assertion failed',
          expected: 'passed',
        })
      }
    },
  })

  const bruObject = Object.freeze({
    getEnvVar: (key: string) => envApi.get(key),
    setEnvVar: (key: string, value: unknown) => envApi.set(key, value),
    getVar: (key: string) => envApi.get(key),
    setVar: (key: string, value: unknown) => envApi.set(key, value),
  })

  const resObject = ctx.response
    ? Object.freeze({
        status: ctx.response.status,
        statusText: ctx.response.statusText,
        responseTime: ctx.response.durationMs,
        headers: Object.freeze({ ...ctx.response.headers }),
        body: ctx.response.isJson ? ctx.response.parsedJson : ctx.response.body,
        getStatus: () => ctx.response!.status,
        getHeader: (name: string) => lowerResHeaders.get(String(name).toLowerCase()),
        getHeaders: () => ({ ...ctx.response!.headers }),
        getBody: () => (ctx.response!.isJson ? ctx.response!.parsedJson : ctx.response!.body),
      })
    : undefined

  const sandboxGlobals = Object.create(null) as Record<string, unknown>
  sandboxGlobals.pm = pmObject
  sandboxGlobals.mf = pmObject
  sandboxGlobals.bru = bruObject
  if (resObject) {
    sandboxGlobals.res = resObject
  }
  sandboxGlobals.console = Object.freeze({
    log: (...args: unknown[]) => pushLog('info', args),
    info: (...args: unknown[]) => pushLog('info', args),
    warn: (...args: unknown[]) => pushLog('warn', args),
    error: (...args: unknown[]) => pushLog('error', args),
  })
  sandboxGlobals.JSON = JSON
  sandboxGlobals.Math = Math
  sandboxGlobals.Date = Date
  sandboxGlobals.Number = Number
  sandboxGlobals.String = String
  sandboxGlobals.Boolean = Boolean
  sandboxGlobals.Array = Array
  sandboxGlobals.Object = Object
  sandboxGlobals.RegExp = RegExp

  try {
    const context = vm.createContext(sandboxGlobals, {
      codeGeneration: { strings: false, wasm: false },
    })
    const script = new vm.Script(`"use strict";\n${trimmed}`, {
      filename: `${phase}.script.js`,
    })
    script.runInContext(context, { timeout: 1200 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Script runtime error'
    logs.push({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: `[${phase}] ${msg}`,
    })
    if (phase === 'test') {
      assertions.push({
        id: crypto.randomUUID(),
        type: 'script',
        passed: false,
        label: 'Script Execution',
        actual: msg,
        expected: 'No runtime error',
      })
    }
  }

  return { updatedEnvironmentVars, addedHeaders, assertions, logs }
}
