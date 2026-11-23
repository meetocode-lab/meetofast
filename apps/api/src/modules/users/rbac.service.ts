import crypto from 'node:crypto'
import {
  BUILTIN_ROLE_METADATA,
  buildDefaultRoleMatrix,
  hasPolicyPermission,
  normalizeRolePermissionsMatrix,
  POLICY_ABILITIES,
  type PolicyAbility,
  RBAC_FEATURES,
  type RbacFeatureKey,
  type RbacRoleItem,
  type RolePermissionsMatrix,
} from '@meofast/shared'
import type { Kysely } from 'kysely'
import type { DatabaseSchema, RbacRolesTable } from '../../core/database/schema.types.js'
import { AppError } from '../../core/errors/app-error.js'
import type { AuthenticatedUser } from '../../types/hono.types.js'

export const TOTAL_RBAC_ABILITIES = RBAC_FEATURES.length * POLICY_ABILITIES.length

export function countGrantedAbilities(matrix: RolePermissionsMatrix): number {
  let count = 0
  for (const f of RBAC_FEATURES) {
    const row = matrix[f]
    if (!row) continue
    for (const ab of POLICY_ABILITIES) {
      if (row[ab]) count += 1
    }
  }
  return count
}

export async function ensureDefaultRbacRolesSeeded(db: Kysely<DatabaseSchema>): Promise<void> {
  const existing = await db.selectFrom('rbac_roles').select('slug').execute()
  const existingSet = new Set(existing.map((r) => r.slug))
  const nowIso = new Date().toISOString()

  for (const meta of BUILTIN_ROLE_METADATA) {
    if (existingSet.has(meta.slug)) continue
    await db
      .insertInto('rbac_roles')
      .values({
        id: crypto.randomUUID(),
        slug: meta.slug,
        name: meta.name,
        description: meta.description,
        is_system: 1,
        permissions_json: JSON.stringify(buildDefaultRoleMatrix(meta.slug)),
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute()
  }
}

export async function resolveRolePermissions(
  db: Kysely<DatabaseSchema>,
  roleSlug: string,
): Promise<RolePermissionsMatrix> {
  if (roleSlug === 'super_admin') {
    return normalizeRolePermissionsMatrix(null, 'super_admin')
  }

  const row = await db
    .selectFrom('rbac_roles')
    .select(['slug', 'permissions_json'])
    .where('slug', '=', roleSlug)
    .executeTakeFirst()

  if (!row) {
    return buildDefaultRoleMatrix(roleSlug)
  }

  try {
    const parsed = JSON.parse(row.permissions_json || '{}') as unknown
    return normalizeRolePermissionsMatrix(parsed, roleSlug)
  } catch {
    return buildDefaultRoleMatrix(roleSlug)
  }
}

export function mapRbacRoleRow(
  row: RbacRolesTable,
  userCountMap: Map<string, number>,
): RbacRoleItem {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(row.permissions_json || '{}')
  } catch {
    parsed = null
  }
  const permissions = normalizeRolePermissionsMatrix(parsed, row.slug)
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    isSystem: row.is_system === 1,
    isImmutable: row.slug === 'super_admin',
    userCount: userCountMap.get(row.slug) ?? 0,
    grantedCount: countGrantedAbilities(permissions),
    totalAbilities: TOTAL_RBAC_ABILITIES,
    permissions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function assertPolicy(
  user: AuthenticatedUser | undefined,
  feature: RbacFeatureKey,
  ability: PolicyAbility,
  customMessage?: string,
): void {
  if (!user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required.')
  }
  if (!hasPolicyPermission(user.permissions, user.globalRole, feature, ability)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      customMessage ??
        `Access denied: role "${user.globalRole}" lacks "${ability}" policy on "${feature}".`,
    )
  }
}
