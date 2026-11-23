import type { GlobalRole, RolePermissionsMatrix } from '@meofast/shared'
import type { RuntimeContext } from '../core/bootstrap/runtime-context.js'

export interface AuthenticatedUser {
  id: string
  email: string
  username: string
  fullName: string
  globalRole: GlobalRole
  permissions: RolePermissionsMatrix
}

export interface ActiveSession {
  id: string
  csrfToken: string
  expiresAt: string
}

export interface AppEnv {
  Variables: {
    runtime: RuntimeContext
    clientIp: string
    user?: AuthenticatedUser
    session?: ActiveSession
  }
}
