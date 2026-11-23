import { z } from 'zod'

export const MEOFAST_VERSION = '1.0.0'

// ============================================================================
// 1. Database & Setup Wizard Schemas
// ============================================================================

export const DATABASE_ENGINES = ['postgresql', 'mysql', 'mariadb', 'sqlite'] as const
export type DatabaseEngine = (typeof DATABASE_ENGINES)[number]

export const SSL_MODES = ['disable', 'prefer', 'require'] as const
export type SslMode = (typeof SSL_MODES)[number]

export const networkDatabaseConfigSchema = z.object({
  engine: z.enum(['postgresql', 'mysql', 'mariadb']),
  host: z.string().trim().min(1, 'Database host is required').max(255),
  port: z.coerce.number().int().min(1).max(65535),
  database: z
    .string()
    .trim()
    .min(1, 'Database name is required')
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Use letters, numbers, underscores, or hyphens only'),
  username: z.string().trim().min(1, 'Database username is required').max(128),
  password: z.string().max(512).default(''),
  sslMode: z.enum(SSL_MODES).default('disable'),
  connectionParams: z.string().trim().max(512).optional().default(''),
})

export const sqliteDatabaseConfigSchema = z.object({
  engine: z.literal('sqlite'),
  storageDir: z.string().trim().min(1, 'Storage directory is required').max(512),
  filename: z
    .string()
    .trim()
    .min(1, 'Database file name is required')
    .max(128)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid SQLite file name'),
})

export const databaseConfigSchema = z.discriminatedUnion('engine', [
  networkDatabaseConfigSchema,
  sqliteDatabaseConfigSchema,
])
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>

export const strongPasswordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Include at least one uppercase letter')
  .regex(/[a-z]/, 'Include at least one lowercase letter')
  .regex(/[0-9]/, 'Include at least one number')
  .regex(/[^A-Za-z0-9]/, 'Include at least one symbol')

export const setupAdminSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Full name is required').max(160),
    email: z.string().trim().email('Enter a valid email address').max(255).toLowerCase(),
    username: z
      .string()
      .trim()
      .min(3, 'Username must be at least 3 characters')
      .max(40)
      .toLowerCase()
      .regex(/^[a-z0-9._-]+$/, 'Use lowercase letters, numbers, dots, underscores, or hyphens'),
    password: strongPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
export type SetupAdminInput = z.infer<typeof setupAdminSchema>

export const setupAppConfigSchema = z.object({
  appName: z.string().trim().min(2, 'Application name is required').max(100).default('Meofast'),
  publicUrl: z.string().trim().url('Enter a valid URL (including http:// or https://)').max(255),
  timezone: z.string().trim().min(1).max(80).default('UTC'),
  language: z.enum(['en', 'id']).default('en'),
  organizationName: z.string().trim().max(160).optional().default(''),
})
export type SetupAppConfigInput = z.infer<typeof setupAppConfigSchema>

export const setupExecuteSchema = z.object({
  database: databaseConfigSchema,
  admin: setupAdminSchema,
  appConfig: setupAppConfigSchema,
})
export type SetupExecuteInput = z.infer<typeof setupExecuteSchema>

export interface DatabaseValidationResult {
  valid: boolean
  engine: DatabaseEngine
  reachable: boolean
  authenticated: boolean
  databaseExists: boolean
  canCreateDatabase: boolean
  permissionsOk: boolean
  serverVersion?: string
  existingTablesCount?: number
  message: string
  errorCode?: string
}

export interface SetupStatusResponse {
  installed: boolean
  version: string
  appName: string
  defaultLanguage: string
  registrationMode: 'invite_only' | 'open'
  csrfToken: string
  configuredEngine?: DatabaseEngine
  defaultStorageDir?: string
}

// ============================================================================
// 2. RBAC, Laravel-Style Feature Policies, Users, Organizations & Workspaces
// ============================================================================

export const BUILTIN_GLOBAL_ROLES = [
  'super_admin',
  'org_admin',
  'workspace_admin',
  'developer',
  'viewer',
] as const
export const GLOBAL_ROLES = BUILTIN_GLOBAL_ROLES
export type BuiltinGlobalRole = (typeof BUILTIN_GLOBAL_ROLES)[number]
export type GlobalRole = BuiltinGlobalRole | (string & {})

export const roleSlugSchema = z
  .string()
  .trim()
  .min(2, 'Role slug must be at least 2 characters')
  .max(40, 'Role slug must be at most 40 characters')
  .toLowerCase()
  .regex(/^[a-z0-9_-]+$/, 'Role slug may only contain lowercase letters, numbers, underscores, or hyphens')

export const WORKSPACE_ROLES = ['workspace_admin', 'developer', 'viewer'] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export const POLICY_ABILITIES = ['anyView', 'view', 'create', 'update', 'delete'] as const
export type PolicyAbility = (typeof POLICY_ABILITIES)[number]

export interface FeaturePolicyPermissions {
  anyView: boolean
  view: boolean
  create: boolean
  update: boolean
  delete: boolean
}

export const RBAC_FEATURES = [
  'workspaces',
  'collections',
  'requests',
  'environments',
  'docs',
  'mocks',
  'webhooks',
  'monitors',
  'history',
  'cookies',
  'tokens',
  'backup',
  'users_rbac',
  'system_settings',
  'audit_logs',
] as const
export type RbacFeatureKey = (typeof RBAC_FEATURES)[number]

export type RolePermissionsMatrix = Record<RbacFeatureKey, FeaturePolicyPermissions>

export interface RbacFeatureMeta {
  key: RbacFeatureKey
  label: string
  category: 'Core Workspace' | 'API Development' | 'Testing & Automation' | 'Observability' | 'Security & Administration'
  description: string
}

export const RBAC_FEATURE_CATALOG: readonly RbacFeatureMeta[] = [
  {
    key: 'workspaces',
    label: 'Workspaces',
    category: 'Core Workspace',
    description: 'Create, switch, rename, and manage team or private workspaces.',
  },
  {
    key: 'collections',
    label: 'Collections & Folders',
    category: 'API Development',
    description: 'API collections, nested folders, inherited auth/headers, import/export, and Collection Runner.',
  },
  {
    key: 'requests',
    label: 'Requests & Execution',
    category: 'API Development',
    description: 'Saved endpoints, response examples, comments, and outbound HTTP/GraphQL/WS/gRPC execution.',
  },
  {
    key: 'environments',
    label: 'Environments & Secrets',
    category: 'API Development',
    description: 'Environment variables, .env import/export, diffing, and AES-256-GCM secret vault.',
  },
  {
    key: 'docs',
    label: 'API Documentation',
    category: 'API Development',
    description: 'Interactive endpoint documentation explorer and static HTML export.',
  },
  {
    key: 'mocks',
    label: 'Mock Server',
    category: 'Testing & Automation',
    description: 'Dynamic and stateful mock server routes, simulated latency, and rate limits.',
  },
  {
    key: 'webhooks',
    label: 'Webhook Inspector',
    category: 'Testing & Automation',
    description: 'Inbound webhook receivers, HMAC-SHA256 verification, and event replay.',
  },
  {
    key: 'monitors',
    label: 'Monitors & Load Testing',
    category: 'Testing & Automation',
    description: 'Scheduled health monitors, anomaly alerts, and virtual-user load test runs.',
  },
  {
    key: 'history',
    label: 'History & Debug Capsules',
    category: 'Observability',
    description: 'Recorded API execution logs and sanitized .capsule.json snapshots.',
  },
  {
    key: 'cookies',
    label: 'Workspace Cookie Jar',
    category: 'Core Workspace',
    description: 'Automatic Set-Cookie capture and domain cookie management.',
  },
  {
    key: 'tokens',
    label: 'Personal API Tokens',
    category: 'Security & Administration',
    description: 'CLI and CI/CD personal bearer tokens (mf_pat_...).',
  },
  {
    key: 'backup',
    label: 'Backup & Restore',
    category: 'Security & Administration',
    description: 'Full Git-friendly .meofast-backup.json workspace export and restore.',
  },
  {
    key: 'users_rbac',
    label: 'Users & RBAC Policies',
    category: 'Security & Administration',
    description: 'Team members, invitations, custom roles, and Laravel-style policy matrices.',
  },
  {
    key: 'system_settings',
    label: 'System & Network Policy',
    category: 'Security & Administration',
    description: 'Instance identity, registration mode, optional BYOK AI, and SSRF network rules.',
  },
  {
    key: 'audit_logs',
    label: 'Audit & Login Logs',
    category: 'Security & Administration',
    description: 'Organization-wide security audit trail and authentication diagnostics.',
  },
] as const

export const BUILTIN_ROLE_METADATA: ReadonlyArray<{
  slug: BuiltinGlobalRole
  name: string
  description: string
}> = [
  {
    slug: 'super_admin',
    name: 'Super Administrator',
    description: 'Unrestricted root access across all system, security, RBAC, and workspace features.',
  },
  {
    slug: 'org_admin',
    name: 'Organization Administrator',
    description: 'Full organization management across users, custom roles, network policy, and workspaces.',
  },
  {
    slug: 'workspace_admin',
    name: 'Workspace Administrator',
    description: 'Full control over workspaces, collections, environments, mocks, monitors, and backups.',
  },
  {
    slug: 'developer',
    name: 'Developer',
    description: 'Create, execute, and update API collections, requests, environments, mocks, and monitors.',
  },
  {
    slug: 'viewer',
    name: 'Viewer (Read-Only)',
    description: 'Read-only inspection of workspaces, collections, documentation, and API history.',
  },
] as const

function perm(
  anyView: boolean,
  view: boolean,
  create: boolean,
  update: boolean,
  del: boolean,
): FeaturePolicyPermissions {
  return { anyView, view, create, update, delete: del }
}

export function buildDefaultRoleMatrix(roleSlug: string): RolePermissionsMatrix {
  const full = () => perm(true, true, true, true, true)
  const readOnly = () => perm(true, true, false, false, false)
  const none = () => perm(false, false, false, false, false)

  if (roleSlug === 'super_admin' || roleSlug === 'org_admin') {
    return {
      workspaces: full(),
      collections: full(),
      requests: full(),
      environments: full(),
      docs: full(),
      mocks: full(),
      webhooks: full(),
      monitors: full(),
      history: full(),
      cookies: full(),
      tokens: full(),
      backup: full(),
      users_rbac: full(),
      system_settings: full(),
      audit_logs: perm(true, true, false, false, false),
    }
  }

  if (roleSlug === 'workspace_admin') {
    return {
      workspaces: full(),
      collections: full(),
      requests: full(),
      environments: full(),
      docs: full(),
      mocks: full(),
      webhooks: full(),
      monitors: full(),
      history: full(),
      cookies: full(),
      tokens: full(),
      backup: full(),
      users_rbac: none(),
      system_settings: none(),
      audit_logs: none(),
    }
  }

  if (roleSlug === 'viewer') {
    return {
      workspaces: readOnly(),
      collections: readOnly(),
      requests: readOnly(),
      environments: readOnly(),
      docs: readOnly(),
      mocks: readOnly(),
      webhooks: readOnly(),
      monitors: readOnly(),
      history: readOnly(),
      cookies: readOnly(),
      tokens: perm(false, true, true, true, true),
      backup: none(),
      users_rbac: none(),
      system_settings: none(),
      audit_logs: none(),
    }
  }

  // Default for 'developer' and custom roles when unspecified
  return {
    workspaces: perm(true, true, true, true, false),
    collections: full(),
    requests: full(),
    environments: full(),
    docs: full(),
    mocks: full(),
    webhooks: full(),
    monitors: full(),
    history: full(),
    cookies: full(),
    tokens: perm(false, true, true, true, true),
    backup: perm(false, true, true, false, false),
    users_rbac: none(),
    system_settings: none(),
    audit_logs: none(),
  }
}

export function normalizeRolePermissionsMatrix(
  raw: unknown,
  fallbackRoleSlug = 'developer',
): RolePermissionsMatrix {
  if (fallbackRoleSlug === 'super_admin') {
    const rootMatrix = {} as RolePermissionsMatrix
    for (const f of RBAC_FEATURES) {
      rootMatrix[f] = perm(true, true, true, true, true)
    }
    return rootMatrix
  }

  const base = buildDefaultRoleMatrix(fallbackRoleSlug)
  if (!raw || typeof raw !== 'object') return base

  const obj = raw as Record<string, unknown>
  const result = { ...base }
  for (const f of RBAC_FEATURES) {
    const row = obj[f]
    if (row && typeof row === 'object') {
      const r = row as Record<string, unknown>
      result[f] = {
        anyView: typeof r.anyView === 'boolean' ? r.anyView : base[f].anyView,
        view: typeof r.view === 'boolean' ? r.view : base[f].view,
        create: typeof r.create === 'boolean' ? r.create : base[f].create,
        update: typeof r.update === 'boolean' ? r.update : base[f].update,
        delete: typeof r.delete === 'boolean' ? r.delete : base[f].delete,
      }
    }
  }
  return result
}

export function hasPolicyPermission(
  permissions: RolePermissionsMatrix | null | undefined,
  roleSlug: GlobalRole,
  feature: RbacFeatureKey,
  ability: PolicyAbility,
): boolean {
  if (roleSlug === 'super_admin') return true
  const matrix = permissions ?? buildDefaultRoleMatrix(roleSlug)
  return Boolean(matrix[feature]?.[ability])
}

export function canManageSystem(
  role: GlobalRole,
  permissions?: RolePermissionsMatrix | null,
): boolean {
  if (role === 'super_admin') return true
  if (permissions) {
    return (
      permissions.users_rbac.anyView ||
      permissions.users_rbac.view ||
      permissions.system_settings.anyView ||
      permissions.system_settings.view ||
      permissions.audit_logs.anyView ||
      permissions.audit_logs.view
    )
  }
  return role === 'org_admin'
}

export function canWriteWorkspace(
  globalRole: GlobalRole,
  workspaceRole?: WorkspaceRole | null,
  permissions?: RolePermissionsMatrix | null,
  feature: RbacFeatureKey = 'requests',
  ability: PolicyAbility = 'update',
): boolean {
  if (globalRole === 'super_admin') return true
  if (permissions) {
    return Boolean(permissions[feature]?.[ability])
  }
  if (globalRole === 'org_admin') return true
  if (workspaceRole === 'workspace_admin' || workspaceRole === 'developer') return true
  if (globalRole === 'viewer') return false
  return globalRole === 'workspace_admin' || globalRole === 'developer'
}

export const featurePolicyPermissionsSchema = z.object({
  anyView: z.boolean(),
  view: z.boolean(),
  create: z.boolean(),
  update: z.boolean(),
  delete: z.boolean(),
})

export const rolePermissionsMatrixSchema = z.object({
  workspaces: featurePolicyPermissionsSchema,
  collections: featurePolicyPermissionsSchema,
  requests: featurePolicyPermissionsSchema,
  environments: featurePolicyPermissionsSchema,
  docs: featurePolicyPermissionsSchema,
  mocks: featurePolicyPermissionsSchema,
  webhooks: featurePolicyPermissionsSchema,
  monitors: featurePolicyPermissionsSchema,
  history: featurePolicyPermissionsSchema,
  cookies: featurePolicyPermissionsSchema,
  tokens: featurePolicyPermissionsSchema,
  backup: featurePolicyPermissionsSchema,
  users_rbac: featurePolicyPermissionsSchema,
  system_settings: featurePolicyPermissionsSchema,
  audit_logs: featurePolicyPermissionsSchema,
})

export const createRbacRoleSchema = z.object({
  name: z.string().trim().min(2, 'Role name is required').max(120),
  slug: roleSlugSchema.optional(),
  description: z.string().trim().max(500).optional().default(''),
  templateRoleSlug: z.string().trim().optional(),
  permissions: rolePermissionsMatrixSchema.optional(),
})
export type CreateRbacRoleInput = z.infer<typeof createRbacRoleSchema>

export const updateRbacRoleSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  permissions: rolePermissionsMatrixSchema.optional(),
})
export type UpdateRbacRoleInput = z.infer<typeof updateRbacRoleSchema>

export interface RbacRoleItem {
  id: string
  slug: string
  name: string
  description: string
  isSystem: boolean
  isImmutable: boolean
  userCount: number
  grantedCount: number
  totalAbilities: number
  permissions: RolePermissionsMatrix
  createdAt: string
  updatedAt: string
}

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Email or username is required').max(255),
  password: z.string().min(1, 'Password is required').max(256),
})
export type LoginInput = z.infer<typeof loginSchema>

export const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(255).toLowerCase(),
  username: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .toLowerCase()
    .regex(/^[a-z0-9._-]+$/),
  password: strongPasswordSchema,
  invitationToken: z.string().trim().optional(),
})
export type RegisterInput = z.infer<typeof registerSchema>

export const createUserSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(255).toLowerCase(),
  username: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .toLowerCase()
    .regex(/^[a-z0-9._-]+$/),
  password: strongPasswordSchema,
  globalRole: roleSlugSchema.default('developer'),
  workspaceIds: z.array(z.string()).optional().default([]),
})
export type CreateUserInput = z.infer<typeof createUserSchema>

export const updateUserSchema = z.object({
  globalRole: roleSlugSchema.optional(),
  status: z.enum(['active', 'deactivated']).optional(),
  fullName: z.string().trim().min(2).max(160).optional(),
})
export type UpdateUserInput = z.infer<typeof updateUserSchema>

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2, 'Workspace name is required').max(160),
  description: z.string().trim().max(500).optional().default(''),
  visibility: z.enum(['team', 'private']).default('team'),
})
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>

export const networkPolicySchema = z.object({
  allowPrivateNetworks: z.boolean().default(false),
  allowLocalhost: z.boolean().default(false),
  allowedCidrs: z.array(z.string().trim().min(3).max(64)).default([]),
  allowedDomains: z.array(z.string().trim().min(1).max(255)).default([]),
})
export type NetworkPolicy = z.infer<typeof networkPolicySchema>

export const adminSettingsSchema = z.object({
  appName: z.string().trim().min(2).max(100),
  publicUrl: z.string().trim().url().max(255),
  registrationMode: z.enum(['invite_only', 'open']),
  networkPolicy: networkPolicySchema,
})
export type AdminSettingsInput = z.infer<typeof adminSettingsSchema>

// ============================================================================
// 3. API Client, Auth, Collections, Environments & Assertions
// ============================================================================

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export const REQUEST_PROTOCOLS = [
  'http',
  'graphql',
  'websocket',
  'sse',
  'soap',
  'grpc',
] as const
export type RequestProtocol = (typeof REQUEST_PROTOCOLS)[number]

export const keyValueItemSchema = z.object({
  id: z.string().min(1),
  key: z.string().max(512),
  value: z.string().max(16384),
  description: z.string().max(512).optional().default(''),
  enabled: z.boolean().default(true),
})
export type KeyValueItem = z.infer<typeof keyValueItemSchema>

export const requestAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('inherit') }),
  z.object({
    type: z.literal('bearer'),
    token: z.string().default(''),
    prefix: z.string().default('Bearer'),
  }),
  z.object({
    type: z.literal('basic'),
    username: z.string().default(''),
    password: z.string().default(''),
  }),
  z.object({
    type: z.literal('apikey'),
    key: z.string().default('X-API-Key'),
    value: z.string().default(''),
    in: z.enum(['header', 'query']).default('header'),
  }),
  z.object({
    type: z.literal('oauth2'),
    accessToken: z.string().default(''),
    headerPrefix: z.string().default('Bearer'),
    grantType: z.enum(['client_credentials', 'password', 'authorization_code']).optional(),
    tokenUrl: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    scope: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
  z.object({
    type: z.literal('aws_sigv4'),
    accessKeyId: z.string().default(''),
    secretAccessKey: z.string().default(''),
    region: z.string().default('us-east-1'),
    service: z.string().default('execute-api'),
    sessionToken: z.string().optional(),
  }),
  z.object({
    type: z.literal('digest'),
    username: z.string().default(''),
    password: z.string().default(''),
  }),
  z.object({
    type: z.literal('oauth1'),
    consumerKey: z.string().default(''),
    consumerSecret: z.string().default(''),
    token: z.string().optional(),
    tokenSecret: z.string().optional(),
  }),
  z.object({
    type: z.literal('custom'),
    headerName: z.string().default('Authorization'),
    headerValue: z.string().default(''),
  }),
])
export type RequestAuthConfig = z.infer<typeof requestAuthSchema>

export const requestBodySchema = z.object({
  mode: z
    .enum(['none', 'json', 'xml', 'text', 'urlencoded', 'multipart', 'binary'])
    .default('none'),
  raw: z.string().max(5_000_000).optional().default(''),
  urlencoded: z.array(keyValueItemSchema).optional().default([]),
  multipart: z.array(keyValueItemSchema).optional().default([]),
  binaryBase64: z.string().max(7_000_000).optional(),
  binaryFileName: z.string().max(255).optional(),
  binaryContentType: z.string().max(128).optional(),
})
export type RequestBodyConfig = z.infer<typeof requestBodySchema>

export const graphqlPayloadSchema = z.object({
  query: z.string().max(500_000).default(''),
  variables: z.string().max(500_000).default('{}'),
  operationName: z.string().max(160).optional().default(''),
})
export type GraphqlPayloadConfig = z.infer<typeof graphqlPayloadSchema>

export const ASSERTION_TYPES = [
  'status_equals',
  'status_in_2xx',
  'duration_lt',
  'header_exists',
  'header_equals',
  'json_path_equals',
  'body_contains',
  'script',
  'json_schema',
] as const
export type AssertionType = (typeof ASSERTION_TYPES)[number]

export const DECLARATIVE_ASSERTION_TYPES = [
  'status_equals',
  'status_in_2xx',
  'duration_lt',
  'header_exists',
  'header_equals',
  'json_path_equals',
  'body_contains',
] as const
export type DeclarativeAssertionType = (typeof DECLARATIVE_ASSERTION_TYPES)[number]

export const requestAssertionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(ASSERTION_TYPES),
  target: z.string().max(256).optional().default(''),
  expected: z.string().max(2048).optional().default(''),
  enabled: z.boolean().default(true),
})
export type RequestAssertion = z.infer<typeof requestAssertionSchema>

export interface AssertionEvaluationResult {
  id: string
  type: AssertionType
  passed: boolean
  label: string
  actual: string
  expected: string
}

export const RESPONSE_VARIABLE_SOURCES = ['body', 'header', 'cookie', 'status'] as const
export type ResponseVariableSource = (typeof RESPONSE_VARIABLE_SOURCES)[number]

export const responseVariableExtractorSchema = z.object({
  id: z.string().min(1),
  varName: z.string().max(160).default(''),
  source: z.enum(RESPONSE_VARIABLE_SOURCES).default('body'),
  path: z.string().max(512).optional().default(''),
  enabled: z.boolean().default(true),
})
export type ResponseVariableExtractor = z.infer<typeof responseVariableExtractorSchema>

export interface RequestTimings {
  dnsMs: number
  tcpMs: number
  tlsMs: number
  ttfbMs: number
  downloadMs: number
  totalMs: number
}

export const executeRequestSchema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullable().optional(),
  collectionId: z.string().nullable().optional(),
  folderId: z.string().nullable().optional(),
  savedRequestId: z.string().nullable().optional(),
  protocol: z.enum(REQUEST_PROTOCOLS).optional().default('http'),
  method: z.enum(HTTP_METHODS),
  url: z.string().trim().min(1, 'Request URL is required').max(8192),
  queryParams: z.array(keyValueItemSchema).default([]),
  headers: z.array(keyValueItemSchema).default([]),
  pathVariables: z.array(keyValueItemSchema).default([]),
  auth: requestAuthSchema.default({ type: 'none' }),
  body: requestBodySchema.default({
    mode: 'none',
    raw: '',
    urlencoded: [],
    multipart: [],
    binaryBase64: '',
    binaryFileName: '',
    binaryContentType: 'application/octet-stream',
  }),
  graphql: graphqlPayloadSchema.optional().default({
    query: '',
    variables: '{}',
    operationName: '',
  }),
  assertions: z.array(requestAssertionSchema).default([]),
  postResponseVars: z.array(responseVariableExtractorSchema).optional().default([]),
  preRequestScript: z.string().max(100_000).optional().default(''),
  testScript: z.string().max(100_000).optional().default(''),
  jsonSchema: z.string().max(200_000).optional().default(''),
  timeoutMs: z.number().int().min(500).max(120000).default(30000),
  followRedirects: z.boolean().default(true),
})
export type ExecuteRequestInput = z.infer<typeof executeRequestSchema>

export interface ExecuteRequestResponse {
  historyId: string
  resolvedUrl: string
  status: number
  statusText: string
  durationMs: number
  timings?: RequestTimings
  sizeBytes: number
  headers: Record<string, string>
  cookies: Array<{ name: string; value: string; raw: string }>
  body: string
  contentType: string
  isJson: boolean
  truncated: boolean
  redirects: Array<{ status: number; location: string }>
  assertions: AssertionEvaluationResult[]
  consoleLogs: Array<{ timestamp: string; level: 'info' | 'warn' | 'error'; message: string }>
  environmentUpdated?: boolean
  updatedVariableKeys?: string[]
  sseEvents?: Array<{ id: string; event: string; data: string; receivedAt: string }>
}

export const saveRequestSchema = z.object({
  workspaceId: z.string().min(1),
  collectionId: z.string().min(1),
  folderId: z.string().nullable().optional().default(null),
  name: z.string().trim().min(1, 'Request name is required').max(200),
  description: z.string().max(4000).optional().default(''),
  protocol: z.enum(REQUEST_PROTOCOLS).optional().default('http'),
  method: z.enum(HTTP_METHODS),
  url: z.string().max(8192),
  queryParams: z.array(keyValueItemSchema).default([]),
  headers: z.array(keyValueItemSchema).default([]),
  pathVariables: z.array(keyValueItemSchema).default([]),
  auth: requestAuthSchema.default({ type: 'none' }),
  body: requestBodySchema.default({
    mode: 'none',
    raw: '',
    urlencoded: [],
    multipart: [],
    binaryBase64: '',
    binaryFileName: '',
    binaryContentType: 'application/octet-stream',
  }),
  graphql: graphqlPayloadSchema.optional().default({
    query: '',
    variables: '{}',
    operationName: '',
  }),
  assertions: z.array(requestAssertionSchema).default([]),
  postResponseVars: z.array(responseVariableExtractorSchema).optional().default([]),
  preRequestScript: z.string().max(100_000).optional().default(''),
  testScript: z.string().max(100_000).optional().default(''),
  jsonSchema: z.string().max(200_000).optional().default(''),
  sortOrder: z.number().int().optional(),
})
export type SaveRequestInput = z.infer<typeof saveRequestSchema>

export const moveRequestSchema = z.object({
  collectionId: z.string().min(1),
  folderId: z.string().nullable().optional().default(null),
  sortOrder: z.number().int().min(0).default(0),
})
export type MoveRequestInput = z.infer<typeof moveRequestSchema>

export const createCollectionSchema = z.object({
  name: z.string().trim().min(1, 'Collection name is required').max(200),
  description: z.string().max(4000).optional().default(''),
  variables: z.array(keyValueItemSchema).optional().default([]),
  auth: requestAuthSchema.optional(),
  headers: z.array(keyValueItemSchema).optional().default([]),
})

export const updateCollectionSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  variables: z.array(keyValueItemSchema).optional(),
  auth: requestAuthSchema.optional(),
  headers: z.array(keyValueItemSchema).optional(),
})

export const createFolderSchema = z.object({
  name: z.string().trim().min(1, 'Folder name is required').max(200),
  parentFolderId: z.string().nullable().optional().default(null),
  description: z.string().max(2000).optional().default(''),
  variables: z.array(keyValueItemSchema).optional().default([]),
  auth: requestAuthSchema.optional(),
  headers: z.array(keyValueItemSchema).optional().default([]),
})

export const updateFolderSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  variables: z.array(keyValueItemSchema).optional(),
  auth: requestAuthSchema.optional(),
  headers: z.array(keyValueItemSchema).optional(),
})

export const saveResponseExampleSchema = z.object({
  name: z.string().trim().min(1, 'Example name is required').max(160),
  statusCode: z.number().int().min(100).max(599).default(200),
  statusText: z.string().max(80).optional().default('OK'),
  contentType: z.string().max(160).optional().default('application/json'),
  headers: z.record(z.string(), z.string()).optional().default({}),
  body: z.string().max(2_000_000).default(''),
})
export type SaveResponseExampleInput = z.infer<typeof saveResponseExampleSchema>

export interface ResponseExampleItem {
  id: string
  requestId: string
  name: string
  statusCode: number
  statusText: string
  contentType: string
  headers: Record<string, string>
  body: string
  createdAt: string
}

export const collectionRunSchema = z.object({
  environmentId: z.string().nullable().optional().default(null),
  folderId: z.string().nullable().optional().default(null),
  delayMs: z.number().int().min(0).max(10000).default(0),
  smartOrder: z.boolean().optional().default(true),
  dataRows: z.array(z.record(z.string(), z.string())).max(200).optional().default([]),
})
export type CollectionRunInput = z.infer<typeof collectionRunSchema>

export interface CollectionRunItemResult {
  iteration: number
  requestId: string
  requestName: string
  method: HttpMethod
  resolvedUrl: string
  status: number | null
  durationMs: number
  passed: boolean
  error?: string
  assertions: AssertionEvaluationResult[]
}

export interface CollectionRunSummary {
  collectionId: string
  collectionName: string
  iterations: number
  totalRequests: number
  passedRequests: number
  failedRequests: number
  totalAssertions: number
  passedAssertions: number
  failedAssertions: number
  totalDurationMs: number
  reorderedByDependencies?: boolean
  hasDependencyCycle?: boolean
  items: CollectionRunItemResult[]
}

export const environmentVariableInputSchema = z.object({
  id: z.string().optional(),
  key: z.string().trim().min(1).max(160),
  value: z.string().max(16384).default(''),
  isSecret: z.boolean().default(false),
  enabled: z.boolean().default(true),
  keepExistingSecret: z.boolean().optional().default(false),
})
export type EnvironmentVariableInput = z.infer<typeof environmentVariableInputSchema>

export const upsertEnvironmentSchema = z.object({
  name: z.string().trim().min(1, 'Environment name is required').max(160),
  isGlobal: z.boolean().default(false),
  variables: z.array(environmentVariableInputSchema).default([]),
})
export type UpsertEnvironmentInput = z.infer<typeof upsertEnvironmentSchema>


// ============================================================================
// 4. Phase 3B — OAuth2 Token Helper, WebSocket Sessions & API Access Tokens
// ============================================================================

export const oauth2FetchTokenSchema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullable().optional(),
  grantType: z.enum(['client_credentials', 'password', 'authorization_code']),
  tokenUrl: z.string().trim().min(1, 'Token URL is required').max(4096),
  clientId: z.string().max(512).default(''),
  clientSecret: z.string().max(1024).default(''),
  scope: z.string().max(512).optional().default(''),
  username: z.string().max(512).optional().default(''),
  password: z.string().max(1024).optional().default(''),
  code: z.string().max(2048).optional().default(''),
  redirectUri: z.string().max(2048).optional().default(''),
})
export type OAuth2FetchTokenInput = z.infer<typeof oauth2FetchTokenSchema>

export const graphqlIntrospectSchema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullable().optional(),
  url: z.string().trim().min(1).max(4096),
  headers: z.array(keyValueItemSchema).optional().default([]),
  auth: requestAuthSchema.optional().default({ type: 'none' }),
})
export type GraphqlIntrospectInput = z.infer<typeof graphqlIntrospectSchema>

export const wsConnectSchema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullable().optional(),
  url: z.string().trim().min(1).max(4096),
  headers: z.array(keyValueItemSchema).optional().default([]),
})
export type WsConnectInput = z.infer<typeof wsConnectSchema>

export const wsSendMessageSchema = z.object({
  message: z.string().max(500_000),
})

export const createApiTokenSchema = z.object({
  name: z.string().trim().min(2, 'Token name is required').max(120),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional().default(null),
})

// ============================================================================
// 5. Phase 4 — Mock Server, Webhook Inspector & Debug Capsules
// ============================================================================

export const upsertMockRouteSchema = z.object({
  name: z.string().trim().min(1, 'Route name is required').max(160),
  collectionId: z.string().nullable().optional().default(null),
  method: z.enum(HTTP_METHODS).default('GET'),
  pathPattern: z
    .string()
    .trim()
    .min(1, 'Path pattern is required')
    .max(512)
    .transform((v) => (v.startsWith('/') ? v : `/${v}`)),
  statusCode: z.number().int().min(100).max(599).default(200),
  latencyMs: z.number().int().min(0).max(15000).default(0),
  errorRate: z.number().int().min(0).max(100).default(0),
  rateLimitRpm: z.number().int().min(0).max(10000).optional().default(0),
  headers: z.array(keyValueItemSchema).default([]),
  responseBody: z.string().max(2_000_000).default('{}'),
  isStateful: z.boolean().default(false),
  enabled: z.boolean().default(true),
})
export type UpsertMockRouteInput = z.infer<typeof upsertMockRouteSchema>

export const createWebhookEndpointSchema = z.object({
  name: z.string().trim().min(1, 'Endpoint name is required').max(160),
  signingSecret: z.string().max(256).optional().default(''),
  forwardUrl: z.string().max(2048).optional().default(''),
})
export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>

export const replayWebhookEventSchema = z.object({
  targetUrl: z.string().trim().min(1, 'Target URL is required').max(4096),
})

export interface DebugCapsulePayload {
  format: 'meofast.capsule.v1'
  exportedAt: string
  title: string
  notes: string
  request: {
    protocol: RequestProtocol
    method: HttpMethod
    url: string
    headers: KeyValueItem[]
    queryParams: KeyValueItem[]
    body: RequestBodyConfig
    graphql?: GraphqlPayloadConfig
  }
  response: {
    status: number
    statusText: string
    durationMs: number
    sizeBytes: number
    headers: Record<string, string>
    body: string
    assertions: AssertionEvaluationResult[]
  } | null
}

export const saveDebugCapsuleSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(2000).optional().default(''),
  capsule: z.record(z.string(), z.unknown()),
})

// ============================================================================
// 6. Phase 5 — Load Testing, Scheduled Monitors, Comments & Optional BYOK AI
// ============================================================================

export const runLoadTestSchema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullable().optional(),
  name: z.string().trim().min(1).max(160).default('Load Test Run'),
  method: z.enum(HTTP_METHODS).default('GET'),
  url: z.string().trim().min(1, 'Target URL is required').max(4096),
  headers: z.array(keyValueItemSchema).default([]),
  body: requestBodySchema.optional().default({
    mode: 'none',
    raw: '',
    urlencoded: [],
    multipart: [],
    binaryBase64: '',
    binaryFileName: '',
    binaryContentType: 'application/octet-stream',
  }),
  virtualUsers: z.number().int().min(1).max(50).default(5),
  totalRequests: z.number().int().min(1).max(500).default(25),
  targetRps: z.number().int().min(0).max(500).optional().default(0),
  timeoutMs: z.number().int().min(500).max(30000).default(10000),
})
export type RunLoadTestInput = z.infer<typeof runLoadTestSchema>

export interface LoadTestSummary {
  id: string
  name: string
  method: HttpMethod
  url: string
  virtualUsers: number
  totalRequests: number
  completedRequests: number
  succeededRequests: number
  failedRequests: number
  errorRatePercent: number
  totalDurationMs: number
  requestsPerSecond: number
  apdexScore?: number
  jitterMs?: number
  latency: {
    minMs: number
    avgMs: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    maxMs: number
  }
  statusCounts: Record<string, number>
  buckets: Array<{ label: string; count: number }>
  createdAt: string
}

export const upsertMonitorSchema = z.object({
  name: z.string().trim().min(1, 'Monitor name is required').max(160),
  method: z.enum(HTTP_METHODS).default('GET'),
  url: z.string().trim().min(1, 'Monitor URL is required').max(4096),
  headers: z.array(keyValueItemSchema).default([]),
  bodyRaw: z.string().max(500_000).optional().default(''),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  maxLatencyMs: z.number().int().min(50).max(60000).default(3000),
  intervalSeconds: z.number().int().min(30).max(86400).default(300),
  alertWebhookUrl: z.string().max(2048).optional().default(''),
  enabled: z.boolean().default(true),
})
export type UpsertMonitorInput = z.infer<typeof upsertMonitorSchema>

export const createCommentSchema = z.object({
  body: z.string().trim().min(1, 'Comment cannot be empty').max(2000),
})

export const aiProviderConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['openai_compatible', 'gemini', 'ollama']).default('openai_compatible'),
  baseUrl: z.string().max(1024).default('https://api.openai.com/v1'),
  model: z.string().max(160).default('gpt-4o-mini'),
  apiKey: z.string().max(1024).optional().default(''),
  keepExistingApiKey: z.boolean().optional().default(false),
})
export type AiProviderConfigInput = z.infer<typeof aiProviderConfigSchema>

export const aiAssistRequestSchema = z.object({
  task: z.enum(['generate_tests', 'explain_response', 'generate_docs']),
  method: z.enum(HTTP_METHODS),
  url: z.string().max(4096),
  responseStatus: z.number().int().nullable().optional(),
  responseBody: z.string().max(50_000).optional().default(''),
})

export * from './algorithms.js'
export * from './url-params.js'
