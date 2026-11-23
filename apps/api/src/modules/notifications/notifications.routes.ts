import crypto from 'node:crypto'
import { hasPolicyPermission, type WorkspaceRole } from '@meofast/shared'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { AppError } from '../../core/errors/app-error.js'
import { paginateServerArray, parseTableQuery } from '../../core/http/pagination.js'
import { requireAuthMiddleware } from '../../middleware/security.js'
import type { AppEnv } from '../../types/hono.types.js'
import {
  createAndPushNotification,
  emitUserSyncEvent,
  type NotificationPayload,
  type NotificationType,
  subscribeUserNotifications,
} from './notification-hub.js'

export const notificationsRoutes = new Hono<AppEnv>()

notificationsRoutes.use('*', requireAuthMiddleware)

function safeParseMetadata(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ============================================================================
// 1. Real-Time Notification Stream (Server-Sent Events — Zero Polling!)
// ============================================================================
notificationsRoutes.get('/notifications/stream', async (c) => {
  const user = c.get('user')!

  c.header('Content-Type', 'text/event-stream; charset=utf-8')
  c.header('Cache-Control', 'no-cache, no-transform')
  c.header('Connection', 'keep-alive')
  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    let closed = false

    const unsubscribe = subscribeUserNotifications(user.id, (event) => {
      if (closed) return
      void stream
        .writeSSE({
          event: event.kind,
          data: JSON.stringify(event),
        })
        .catch(() => {
          closed = true
        })
    })

    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({ userId: user.id, timestamp: new Date().toISOString() }),
    })

    stream.onAbort(() => {
      closed = true
      unsubscribe()
    })

    try {
      while (!closed) {
        await stream.sleep(25_000)
        if (closed) break
        await stream.writeSSE({
          event: 'ping',
          data: JSON.stringify({ ts: Date.now() }),
        })
      }
    } finally {
      closed = true
      unsubscribe()
    }
  })
})

// ============================================================================
// 2. Notification CRUD & Read State
// ============================================================================
notificationsRoutes.get('/notifications', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!

  const rows = await db
    .selectFrom('notifications')
    .selectAll()
    .where('user_id', '=', user.id)
    .orderBy('created_at', 'desc')
    .limit(60)
    .execute()

  const items: NotificationPayload[] = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    type: r.type,
    title: r.title,
    message: r.message,
    metadata: safeParseMetadata(r.metadata_json),
    isRead: r.is_read === 1,
    createdAt: r.created_at,
  }))

  const unreadCount = items.filter((n) => !n.isRead).length
  return c.json({ notifications: items, unreadCount })
})

notificationsRoutes.post('/notifications', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!

  const schema = z.object({
    type: z.enum([
      'workspace_invite',
      'workspace_invite_response',
      'request_completed',
      'request_failed',
      'role_updated',
      'comment_added',
      'system',
    ]),
    title: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(500),
    metadata: z.record(z.unknown()).optional(),
  })

  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid notification payload.')
  }

  const created = await createAndPushNotification(db, {
    userId: user.id,
    type: parsed.data.type as NotificationType,
    title: parsed.data.title,
    message: parsed.data.message,
    metadata: parsed.data.metadata ?? null,
  })

  return c.json({ notification: created }, 201)
})

notificationsRoutes.patch('/notifications/:id/read', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const id = c.req.param('id')

  await db
    .updateTable('notifications')
    .set({ is_read: 1 })
    .where('id', '=', id)
    .where('user_id', '=', user.id)
    .execute()

  return c.json({ ok: true })
})

notificationsRoutes.post('/notifications/read-all', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!

  await db
    .updateTable('notifications')
    .set({ is_read: 1 })
    .where('user_id', '=', user.id)
    .where('is_read', '=', 0)
    .execute()

  return c.json({ ok: true })
})

notificationsRoutes.delete('/notifications/:id', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const id = c.req.param('id')

  await db
    .deleteFrom('notifications')
    .where('id', '=', id)
    .where('user_id', '=', user.id)
    .execute()

  return c.json({ ok: true })
})

notificationsRoutes.delete('/notifications', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!

  await db.deleteFrom('notifications').where('user_id', '=', user.id).execute()
  return c.json({ ok: true })
})

// ============================================================================
// 3. Google Drive-Style Workspace Management, Sharing & Invitations
// ============================================================================
notificationsRoutes.get('/admin/workspaces', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!

  const canViewWorkspaces =
    hasPolicyPermission(user.permissions, user.globalRole, 'workspaces', 'anyView') ||
    hasPolicyPermission(user.permissions, user.globalRole, 'workspaces', 'view') ||
    hasPolicyPermission(user.permissions, user.globalRole, 'users_rbac', 'anyView')
  if (!canViewWorkspaces) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view Workspaces.')
  }

  const [workspaces, memberships, users, collections, pendingInvites] = await Promise.all([
    db.selectFrom('workspaces').selectAll().orderBy('created_at', 'asc').execute(),
    db.selectFrom('workspace_members').selectAll().execute(),
    db
      .selectFrom('users')
      .select(['id', 'full_name', 'email', 'username', 'global_role', 'status'])
      .execute(),
    db.selectFrom('collections').select(['id', 'workspace_id']).execute(),
    db
      .selectFrom('workspace_invitations')
      .select(['id', 'workspace_id', 'status'])
      .where('status', '=', 'pending')
      .execute(),
  ])

  const userMap = new Map(users.map((u) => [u.id, u]))
  const colCountMap = new Map<string, number>()
  for (const col of collections) {
    colCountMap.set(col.workspace_id, (colCountMap.get(col.workspace_id) ?? 0) + 1)
  }

  const pendingCountMap = new Map<string, number>()
  for (const inv of pendingInvites) {
    pendingCountMap.set(inv.workspace_id, (pendingCountMap.get(inv.workspace_id) ?? 0) + 1)
  }

  const membersByWs = new Map<
    string,
    Array<{ userId: string; fullName: string; email: string; role: WorkspaceRole }>
  >()
  for (const m of memberships) {
    const u = userMap.get(m.user_id)
    if (!u) continue
    const list = membersByWs.get(m.workspace_id) ?? []
    list.push({
      userId: u.id,
      fullName: u.full_name,
      email: u.email,
      role: m.role,
    })
    membersByWs.set(m.workspace_id, list)
  }

  const rows = workspaces.map((ws) => {
    const wsMembers = membersByWs.get(ws.id) ?? []
    const accessLevel =
      ws.public_access_level ?? (ws.visibility === 'team' ? 'edit' : 'none')
    return {
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      description: ws.description ?? '',
      visibility: ws.visibility,
      publicAccessLevel: accessLevel as 'none' | 'view' | 'edit',
      members: wsMembers,
      memberCount: wsMembers.length,
      pendingInviteCount: pendingCountMap.get(ws.id) ?? 0,
      collectionCount: colCountMap.get(ws.id) ?? 0,
      createdAt: ws.created_at,
      updatedAt: ws.updated_at,
    }
  })

  const tableQuery = parseTableQuery(c, 10)
  const paginated = paginateServerArray(rows, tableQuery, {
    getSearchText: (r) =>
      [
        r.name,
        r.slug,
        r.description,
        r.visibility,
        r.publicAccessLevel,
        ...r.members.map((m) => `${m.fullName} ${m.email}`),
      ].join(' '),
    sortExtractors: {
      name: (r) => r.name,
      visibility: (r) => `${r.visibility}_${r.publicAccessLevel}`,
      members: (r) => r.memberCount,
      collections: (r) => r.collectionCount,
      updatedAt: (r) => r.updatedAt,
    },
  })

  return c.json(paginated)
})

notificationsRoutes.patch('/workspaces/:wsId/sharing', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  const canUpdate =
    hasPolicyPermission(user.permissions, user.globalRole, 'workspaces', 'update') ||
    hasPolicyPermission(user.permissions, user.globalRole, 'users_rbac', 'update')
  if (!canUpdate) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to update workspace sharing.')
  }

  const schema = z.object({
    visibility: z.enum(['private', 'team']),
    publicAccessLevel: z.enum(['none', 'view', 'edit']),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid sharing settings.')
  }

  const normalizedLevel =
    parsed.data.visibility === 'private' ? 'none' : parsed.data.publicAccessLevel === 'none' ? 'view' : parsed.data.publicAccessLevel

  await db
    .updateTable('workspaces')
    .set({
      visibility: parsed.data.visibility,
      public_access_level: normalizedLevel,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', wsId)
    .execute()

  return c.json({
    ok: true,
    visibility: parsed.data.visibility,
    publicAccessLevel: normalizedLevel,
  })
})

notificationsRoutes.get('/workspaces/:wsId/members', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  const canView =
    hasPolicyPermission(user.permissions, user.globalRole, 'workspaces', 'anyView') ||
    hasPolicyPermission(user.permissions, user.globalRole, 'workspaces', 'view') ||
    hasPolicyPermission(user.permissions, user.globalRole, 'users_rbac', 'anyView')
  if (!canView) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view workspace members.')
  }

  const [ws, memberships, allUsers, invites] = await Promise.all([
    db.selectFrom('workspaces').selectAll().where('id', '=', wsId).executeTakeFirst(),
    db.selectFrom('workspace_members').selectAll().where('workspace_id', '=', wsId).execute(),
    db
      .selectFrom('users')
      .select(['id', 'full_name', 'email', 'username', 'global_role', 'status'])
      .where('status', '=', 'active')
      .orderBy('full_name', 'asc')
      .execute(),
    db
      .selectFrom('workspace_invitations')
      .selectAll()
      .where('workspace_id', '=', wsId)
      .where('status', '=', 'pending')
      .orderBy('created_at', 'desc')
      .execute(),
  ])

  if (!ws) throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.')

  const userMap = new Map(allUsers.map((u) => [u.id, u]))
  const memberUserIds = new Set(memberships.map((m) => m.user_id))
  const pendingUserIds = new Set(invites.map((i) => i.invitee_user_id))

  const members = memberships
    .map((m) => {
      const u = userMap.get(m.user_id)
      if (!u) return null
      return {
        userId: u.id,
        fullName: u.full_name,
        email: u.email,
        username: u.username,
        role: m.role,
        joinedAt: m.created_at,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const pendingInvitations = invites
    .map((inv) => {
      const invitee = userMap.get(inv.invitee_user_id)
      const inviter = userMap.get(inv.inviter_id)
      if (!invitee) return null
      return {
        id: inv.id,
        userId: invitee.id,
        fullName: invitee.full_name,
        email: invitee.email,
        role: inv.role,
        invitedBy: inviter?.full_name ?? 'Admin',
        createdAt: inv.created_at,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const availableUsers = allUsers
    .filter((u) => !memberUserIds.has(u.id) && !pendingUserIds.has(u.id))
    .map((u) => ({
      id: u.id,
      fullName: u.full_name,
      email: u.email,
      username: u.username,
      globalRole: u.global_role,
    }))

  return c.json({
    workspace: {
      id: ws.id,
      name: ws.name,
      visibility: ws.visibility,
      publicAccessLevel: ws.public_access_level ?? (ws.visibility === 'team' ? 'edit' : 'none'),
    },
    members,
    pendingInvitations,
    availableUsers,
  })
})

notificationsRoutes.post('/workspaces/:wsId/invitations', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')

  const canInvite =
    hasPolicyPermission(user.permissions, user.globalRole, 'workspaces', 'update') ||
    hasPolicyPermission(user.permissions, user.globalRole, 'users_rbac', 'create')
  if (!canInvite) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to invite members.')
  }

  const schema = z.object({
    userId: z.string().min(1),
    role: z.enum(['workspace_admin', 'developer', 'viewer']).default('developer'),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Select a valid user and workspace role.')
  }

  const [ws, targetUser, existingMember, existingInvite] = await Promise.all([
    db.selectFrom('workspaces').selectAll().where('id', '=', wsId).executeTakeFirst(),
    db
      .selectFrom('users')
      .select(['id', 'full_name', 'email'])
      .where('id', '=', parsed.data.userId)
      .executeTakeFirst(),
    db
      .selectFrom('workspace_members')
      .select('id')
      .where('workspace_id', '=', wsId)
      .where('user_id', '=', parsed.data.userId)
      .executeTakeFirst(),
    db
      .selectFrom('workspace_invitations')
      .select('id')
      .where('workspace_id', '=', wsId)
      .where('invitee_user_id', '=', parsed.data.userId)
      .where('status', '=', 'pending')
      .executeTakeFirst(),
  ])

  if (!ws) throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.')
  if (!targetUser) throw new AppError(404, 'USER_NOT_FOUND', 'Target user not found.')
  if (existingMember) {
    throw new AppError(409, 'ALREADY_MEMBER', `${targetUser.full_name} is already a member.`)
  }
  if (existingInvite) {
    throw new AppError(409, 'INVITE_EXISTS', `An invitation for ${targetUser.full_name} is already pending.`)
  }

  const inviteId = crypto.randomUUID()
  const nowIso = new Date().toISOString()

  await db
    .insertInto('workspace_invitations')
    .values({
      id: inviteId,
      workspace_id: wsId,
      inviter_id: user.id,
      invitee_user_id: targetUser.id,
      role: parsed.data.role,
      status: 'pending',
      created_at: nowIso,
      responded_at: null,
    })
    .execute()

  const roleLabel =
    parsed.data.role === 'workspace_admin'
      ? 'Admin'
      : parsed.data.role === 'developer'
        ? 'Editor'
        : 'Viewer'

  await createAndPushNotification(db, {
    userId: targetUser.id,
    type: 'workspace_invite',
    title: `Invitation to ${ws.name}`,
    message: `${user.fullName} invited you to join "${ws.name}" as ${roleLabel}.`,
    metadata: {
      invitationId: inviteId,
      workspaceId: ws.id,
      workspaceName: ws.name,
      role: parsed.data.role,
      inviterName: user.fullName,
      status: 'pending',
    },
  })

  return c.json({ id: inviteId, ok: true }, 201)
})

notificationsRoutes.post('/workspace-invitations/:id/respond', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const inviteId = c.req.param('id')

  const schema = z.object({
    action: z.enum(['accept', 'decline']),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Action must be accept or decline.')
  }

  const invite = await db
    .selectFrom('workspace_invitations')
    .selectAll()
    .where('id', '=', inviteId)
    .where('invitee_user_id', '=', user.id)
    .executeTakeFirst()

  if (!invite) throw new AppError(404, 'INVITATION_NOT_FOUND', 'Workspace invitation not found.')
  if (invite.status !== 'pending') {
    throw new AppError(409, 'INVITATION_ALREADY_HANDLED', `Invitation already ${invite.status}.`)
  }

  const ws = await db
    .selectFrom('workspaces')
    .select(['id', 'name'])
    .where('id', '=', invite.workspace_id)
    .executeTakeFirst()

  const nowIso = new Date().toISOString()
  const nextStatus = parsed.data.action === 'accept' ? 'accepted' : 'declined'

  await db
    .updateTable('workspace_invitations')
    .set({ status: nextStatus, responded_at: nowIso })
    .where('id', '=', inviteId)
    .execute()

  if (parsed.data.action === 'accept') {
    const existingMember = await db
      .selectFrom('workspace_members')
      .select('id')
      .where('workspace_id', '=', invite.workspace_id)
      .where('user_id', '=', user.id)
      .executeTakeFirst()

    if (!existingMember) {
      await db
        .insertInto('workspace_members')
        .values({
          id: crypto.randomUUID(),
          workspace_id: invite.workspace_id,
          user_id: user.id,
          role: invite.role,
          created_at: nowIso,
        })
        .execute()
    }
  }

  // Update the invitee's notification metadata & mark read
  const myNotifs = await db
    .selectFrom('notifications')
    .selectAll()
    .where('user_id', '=', user.id)
    .where('type', '=', 'workspace_invite')
    .execute()

  for (const n of myNotifs) {
    const meta = safeParseMetadata(n.metadata_json)
    if (meta?.invitationId === inviteId) {
      await db
        .updateTable('notifications')
        .set({
          is_read: 1,
          metadata_json: JSON.stringify({ ...meta, status: nextStatus }),
        })
        .where('id', '=', n.id)
        .execute()
    }
  }

  // Notify inviter in real time
  if (invite.inviter_id !== user.id) {
    await createAndPushNotification(db, {
      userId: invite.inviter_id,
      type: 'workspace_invite_response',
      title:
        parsed.data.action === 'accept'
          ? `${user.fullName} joined ${ws?.name ?? 'workspace'}`
          : `${user.fullName} declined invitation`,
      message:
        parsed.data.action === 'accept'
          ? `${user.fullName} accepted your invitation to "${ws?.name ?? 'workspace'}".`
          : `${user.fullName} declined your invitation to "${ws?.name ?? 'workspace'}".`,
      metadata: {
        workspaceId: invite.workspace_id,
        workspaceName: ws?.name ?? '',
        action: parsed.data.action,
      },
    })
  }

  emitUserSyncEvent(user.id, 'workspace_membership_changed')

  return c.json({ ok: true, status: nextStatus, workspaceId: invite.workspace_id })
})

notificationsRoutes.patch('/workspaces/:wsId/members/:userId', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')
  const targetUserId = c.req.param('userId')

  const canUpdate =
    hasPolicyPermission(user.permissions, user.globalRole, 'workspaces', 'update') ||
    hasPolicyPermission(user.permissions, user.globalRole, 'users_rbac', 'update')
  if (!canUpdate) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to update member roles.')
  }

  const schema = z.object({
    role: z.enum(['workspace_admin', 'developer', 'viewer']),
  })
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid workspace role.')
  }

  await db
    .updateTable('workspace_members')
    .set({ role: parsed.data.role })
    .where('workspace_id', '=', wsId)
    .where('user_id', '=', targetUserId)
    .execute()

  return c.json({ ok: true })
})

notificationsRoutes.delete('/workspaces/:wsId/members/:userId', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')
  const targetUserId = c.req.param('userId')

  const canUpdate =
    hasPolicyPermission(user.permissions, user.globalRole, 'workspaces', 'update') ||
    hasPolicyPermission(user.permissions, user.globalRole, 'users_rbac', 'delete')
  if (!canUpdate) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to remove workspace members.')
  }

  await db
    .deleteFrom('workspace_members')
    .where('workspace_id', '=', wsId)
    .where('user_id', '=', targetUserId)
    .execute()

  emitUserSyncEvent(targetUserId, 'workspace_membership_changed')
  return c.json({ ok: true })
})

notificationsRoutes.delete('/workspaces/:wsId/invitations/:inviteId', async (c) => {
  const db = c.get('runtime').getDb()
  const user = c.get('user')!
  const wsId = c.req.param('wsId')
  const inviteId = c.req.param('inviteId')

  const canUpdate =
    hasPolicyPermission(user.permissions, user.globalRole, 'workspaces', 'update') ||
    hasPolicyPermission(user.permissions, user.globalRole, 'users_rbac', 'delete')
  if (!canUpdate) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to revoke invitations.')
  }

  await db
    .deleteFrom('workspace_invitations')
    .where('id', '=', inviteId)
    .where('workspace_id', '=', wsId)
    .execute()

  return c.json({ ok: true })
})
