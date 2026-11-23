import crypto from 'node:crypto'
import { networkPolicySchema } from '@meofast/shared'
import type { RuntimeContext } from '../../core/bootstrap/runtime-context.js'
import { AppError } from '../../core/errors/app-error.js'
import { validateOutboundTargetUrl } from './ssrf-guard.js'

export interface WsFrameItem {
  id: string
  direction: 'sent' | 'received' | 'system'
  data: string
  timestamp: string
}

interface WsSession {
  id: string
  userId: string
  url: string
  isBuiltinEcho: boolean
  status: 'connecting' | 'open' | 'closed' | 'error'
  messages: WsFrameItem[]
  socket: WebSocket | null
  createdAt: number
}

const sessions = new Map<string, WsSession>()

function cleanupStaleSessions() {
  const cutoff = Date.now() - 15 * 60 * 1000
  for (const [id, s] of sessions.entries()) {
    if (s.createdAt < cutoff) {
      try {
        s.socket?.close()
      } catch {
        // ignore
      }
      sessions.delete(id)
    }
  }
}

export async function createWsProxySession(
  runtime: RuntimeContext,
  userId: string,
  rawUrl: string,
): Promise<{ sessionId: string; status: string; messages: WsFrameItem[] }> {
  cleanupStaleSessions()

  const trimmed = rawUrl.trim()
  const isBuiltinEcho =
    trimmed === 'ws://meofast.local/echo' ||
    trimmed === 'wss://meofast.local/echo' ||
    trimmed === '/ws/echo'

  const sessionId = crypto.randomUUID()
  const nowIso = new Date().toISOString()

  if (isBuiltinEcho) {
    const session: WsSession = {
      id: sessionId,
      userId,
      url: 'ws://meofast.local/echo',
      isBuiltinEcho: true,
      status: 'open',
      messages: [
        {
          id: crypto.randomUUID(),
          direction: 'system',
          data: 'Connected to Meofast Local WebSocket Echo Server',
          timestamp: nowIso,
        },
      ],
      socket: null,
      createdAt: Date.now(),
    }
    sessions.set(sessionId, session)
    return {
      sessionId,
      status: session.status,
      messages: session.messages,
    }
  }

  if (!/^wss?:\/\//i.test(trimmed)) {
    throw new AppError(400, 'INVALID_WS_URL', 'WebSocket URL must start with ws:// or wss://')
  }

  // Validate against SSRF policy by mapping ws/wss to http/https
  const db = runtime.getDb()
  const policySetting = await db
    .selectFrom('system_settings')
    .select('setting_value')
    .where('setting_key', '=', 'network_policy')
    .executeTakeFirst()

  let networkPolicy = {
    allowPrivateNetworks: false,
    allowLocalhost: false,
    allowedCidrs: [] as string[],
    allowedDomains: [] as string[],
  }
  if (policySetting?.setting_value) {
    try {
      networkPolicy = networkPolicySchema.parse(JSON.parse(policySetting.setting_value))
    } catch {
      // safe defaults
    }
  }

  const httpEquivalent = trimmed.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
  await validateOutboundTargetUrl(httpEquivalent, networkPolicy)

  const session: WsSession = {
    id: sessionId,
    userId,
    url: trimmed,
    isBuiltinEcho: false,
    status: 'connecting',
    messages: [
      {
        id: crypto.randomUUID(),
        direction: 'system',
        data: `Connecting to ${trimmed}...`,
        timestamp: nowIso,
      },
    ],
    socket: null,
    createdAt: Date.now(),
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve()
      }
    }, 3500)

    try {
      const ws = new WebSocket(trimmed)
      session.socket = ws

      ws.addEventListener('open', () => {
        session.status = 'open'
        session.messages.push({
          id: crypto.randomUUID(),
          direction: 'system',
          data: `Connected to ${trimmed}`,
          timestamp: new Date().toISOString(),
        })
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve()
        }
      })

      ws.addEventListener('message', (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : String(ev.data)
        session.messages.push({
          id: crypto.randomUUID(),
          direction: 'received',
          data: text.slice(0, 100_000),
          timestamp: new Date().toISOString(),
        })
        if (session.messages.length > 200) {
          session.messages.splice(0, session.messages.length - 200)
        }
      })

      ws.addEventListener('error', () => {
        session.status = 'error'
        session.messages.push({
          id: crypto.randomUUID(),
          direction: 'system',
          data: 'WebSocket connection error.',
          timestamp: new Date().toISOString(),
        })
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve()
        }
      })

      ws.addEventListener('close', (ev) => {
        if (session.status !== 'error') {
          session.status = 'closed'
        }
        session.messages.push({
          id: crypto.randomUUID(),
          direction: 'system',
          data: `Disconnected (code ${ev.code})`,
          timestamp: new Date().toISOString(),
        })
      })
    } catch (err) {
      session.status = 'error'
      session.messages.push({
        id: crypto.randomUUID(),
        direction: 'system',
        data: err instanceof Error ? err.message : 'Failed to open WebSocket',
        timestamp: new Date().toISOString(),
      })
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve()
      }
    }
  })

  sessions.set(sessionId, session)
  return {
    sessionId,
    status: session.status,
    messages: session.messages,
  }
}

export async function sendWsProxyMessage(
  sessionId: string,
  userId: string,
  payload: string,
): Promise<{ status: string; messages: WsFrameItem[] }> {
  const session = sessions.get(sessionId)
  if (!session || session.userId !== userId) {
    throw new AppError(404, 'WS_SESSION_NOT_FOUND', 'WebSocket session not found or expired.')
  }
  if (session.status !== 'open') {
    throw new AppError(400, 'WS_NOT_OPEN', `WebSocket is currently ${session.status}.`)
  }

  session.messages.push({
    id: crypto.randomUUID(),
    direction: 'sent',
    data: payload,
    timestamp: new Date().toISOString(),
  })

  if (session.isBuiltinEcho) {
    let reply = payload
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      reply = JSON.stringify(
        {
          echo: parsed,
          serverTime: new Date().toISOString(),
        },
        null,
        2,
      )
    } catch {
      reply = `Echo: ${payload}`
    }
    session.messages.push({
      id: crypto.randomUUID(),
      direction: 'received',
      data: reply,
      timestamp: new Date().toISOString(),
    })
    return { status: session.status, messages: session.messages }
  }

  session.socket?.send(payload)
  await new Promise((r) => setTimeout(r, 250))
  return { status: session.status, messages: session.messages }
}

export function getWsProxySessionState(sessionId: string, userId: string) {
  const session = sessions.get(sessionId)
  if (!session || session.userId !== userId) {
    throw new AppError(404, 'WS_SESSION_NOT_FOUND', 'WebSocket session not found.')
  }
  return {
    sessionId: session.id,
    url: session.url,
    status: session.status,
    messages: session.messages,
  }
}

export function closeWsProxySession(sessionId: string, userId: string) {
  const session = sessions.get(sessionId)
  if (!session || session.userId !== userId) {
    return { status: 'closed', messages: [] as WsFrameItem[] }
  }
  session.status = 'closed'
  try {
    session.socket?.close()
  } catch {
    // ignore
  }
  session.messages.push({
    id: crypto.randomUUID(),
    direction: 'system',
    data: 'Closed by client.',
    timestamp: new Date().toISOString(),
  })
  return { status: session.status, messages: session.messages }
}
