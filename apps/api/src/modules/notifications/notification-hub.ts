import crypto from 'node:crypto'
import type { Kysely } from 'kysely'
import type { DatabaseSchema } from '../../core/database/schema.types.js'

export type NotificationType =
  | 'workspace_invite'
  | 'workspace_invite_response'
  | 'request_completed'
  | 'request_failed'
  | 'role_updated'
  | 'comment_added'
  | 'system'

export interface NotificationPayload {
  id: string
  userId: string
  type: NotificationType | string
  title: string
  message: string
  metadata: Record<string, unknown> | null
  isRead: boolean
  createdAt: string
}

type NotificationListener = (event: {
  kind: 'notification' | 'sync'
  notification?: NotificationPayload
  reason?: string
}) => void

const userListeners = new Map<string, Set<NotificationListener>>()

export function subscribeUserNotifications(
  userId: string,
  listener: NotificationListener,
): () => void {
  let set = userListeners.get(userId)
  if (!set) {
    set = new Set()
    userListeners.set(userId, set)
  }
  set.add(listener)

  return () => {
    const current = userListeners.get(userId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      userListeners.delete(userId)
    }
  }
}

export function emitUserSyncEvent(userId: string, reason: string): void {
  const listeners = userListeners.get(userId)
  if (!listeners || listeners.size === 0) return
  for (const fn of listeners) {
    try {
      fn({ kind: 'sync', reason })
    } catch {
      // ignore disconnected stream listener
    }
  }
}

export async function createAndPushNotification(
  db: Kysely<DatabaseSchema>,
  input: {
    userId: string
    type: NotificationType
    title: string
    message: string
    metadata?: Record<string, unknown> | null
  },
): Promise<NotificationPayload> {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null

  await db
    .insertInto('notifications')
    .values({
      id,
      user_id: input.userId,
      type: input.type,
      title: input.title.slice(0, 200),
      message: input.message.slice(0, 500),
      metadata_json: metadataJson,
      is_read: 0,
      created_at: createdAt,
    })
    .execute()

  const payload: NotificationPayload = {
    id,
    userId: input.userId,
    type: input.type,
    title: input.title.slice(0, 200),
    message: input.message.slice(0, 500),
    metadata: input.metadata ?? null,
    isRead: false,
    createdAt,
  }

  const listeners = userListeners.get(input.userId)
  if (listeners && listeners.size > 0) {
    for (const fn of listeners) {
      try {
        fn({ kind: 'notification', notification: payload })
      } catch {
        // ignore disconnected stream listener
      }
    }
  }

  return payload
}
