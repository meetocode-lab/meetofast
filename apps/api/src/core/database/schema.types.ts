import type { GlobalRole, HttpMethod, WorkspaceRole } from '@meofast/shared'

export interface SystemSettingsTable {
  setting_key: string
  setting_value: string
  updated_at: string
}

export interface UsersTable {
  id: string
  email: string
  username: string
  full_name: string
  password_hash: string
  global_role: GlobalRole
  status: 'active' | 'deactivated'
  last_login_at: string | null
  created_at: string
  updated_at: string
}

export interface SessionsTable {
  id: string
  user_id: string
  token_hash: string
  csrf_token: string
  ip_address: string | null
  user_agent: string | null
  expires_at: string
  created_at: string
}

export interface LoginHistoryTable {
  id: string
  user_id: string | null
  email_attempted: string
  succeeded: number
  ip_address: string | null
  user_agent: string | null
  failure_reason: string | null
  created_at: string
}

export interface OrganizationsTable {
  id: string
  name: string
  slug: string
  created_at: string
  updated_at: string
}

export interface OrganizationMembersTable {
  id: string
  organization_id: string
  user_id: string
  role: 'org_admin' | 'member'
  created_at: string
}

export interface WorkspacesTable {
  id: string
  organization_id: string
  name: string
  slug: string
  description: string | null
  visibility: 'team' | 'private'
  public_access_level?: 'none' | 'view' | 'edit'
  created_by: string
  created_at: string
  updated_at: string
}

export interface WorkspaceMembersTable {
  id: string
  workspace_id: string
  user_id: string
  role: WorkspaceRole
  created_at: string
}

export interface UserInvitationsTable {
  id: string
  organization_id: string
  workspace_id: string | null
  email: string
  role: GlobalRole
  token_hash: string
  invited_by: string
  accepted_at: string | null
  expires_at: string
  created_at: string
}

export interface CollectionsTable {
  id: string
  workspace_id: string
  name: string
  description: string | null
  variables_json: string
  auth_json: string
  headers_json?: string | null
  sort_order: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CollectionFoldersTable {
  id: string
  collection_id: string
  parent_folder_id: string | null
  name: string
  description: string | null
  variables_json: string
  auth_json?: string | null
  headers_json?: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface SavedRequestsTable {
  id: string
  workspace_id: string
  collection_id: string
  folder_id: string | null
  name: string
  description: string | null
  method: HttpMethod
  url: string
  query_params_json: string
  headers_json: string
  path_vars_json: string
  auth_json: string
  body_json: string
  assertions_json: string
  post_vars_json?: string | null
  pre_request_script: string | null
  test_script: string | null
  json_schema: string | null
  protocol: string | null
  graphql_json: string | null
  sort_order: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface EnvironmentsTable {
  id: string
  workspace_id: string
  name: string
  is_global: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface EnvironmentVariablesTable {
  id: string
  environment_id: string
  var_key: string
  var_value: string
  encrypted_value: string | null
  is_secret: number
  enabled: number
  sort_order: number
  created_at: string
  updated_at: string
}

export interface RequestHistoryTable {
  id: string
  workspace_id: string
  user_id: string
  saved_request_id: string | null
  method: HttpMethod
  url: string
  request_snapshot_json: string
  response_status: number | null
  response_status_text: string | null
  duration_ms: number
  response_size_bytes: number
  response_headers_json: string
  response_body_preview: string
  assertion_results_json: string
  error_message: string | null
  created_at: string
}

export interface AuditLogsTable {
  id: string
  organization_id: string | null
  workspace_id: string | null
  actor_user_id: string | null
  actor_email: string | null
  action: string
  target_type: string
  target_id: string | null
  metadata_json: string
  ip_address: string | null
  created_at: string
}

export interface SchemaMigrationsTable {
  version: string
  applied_at: string
}

export interface ApiTokensTable {
  id: string
  user_id: string
  name: string
  token_prefix: string
  token_hash: string
  last_used_at: string | null
  expires_at: string | null
  created_at: string
}

export interface MockRoutesTable {
  id: string
  workspace_id: string
  collection_id: string | null
  name: string
  method: HttpMethod
  path_pattern: string
  status_code: number
  latency_ms: number
  error_rate: number
  rate_limit_rpm?: number | null
  headers_json: string
  response_body: string
  is_stateful: number
  state_items_json: string | null
  enabled: number
  hit_count: number
  created_at: string
  updated_at: string
}

export interface WebhookEndpointsTable {
  id: string
  workspace_id: string
  name: string
  token: string
  signing_secret: string | null
  forward_url: string | null
  enabled: number
  created_at: string
}

export interface WebhookEventsTable {
  id: string
  endpoint_id: string
  method: string
  path: string
  query_json: string
  headers_json: string
  body_raw: string
  source_ip: string | null
  hmac_status: string
  created_at: string
}

export interface DebugCapsulesTable {
  id: string
  workspace_id: string
  title: string
  notes: string | null
  capsule_json: string
  created_by: string | null
  created_at: string
}

export interface MonitorsTable {
  id: string
  workspace_id: string
  name: string
  method: HttpMethod
  url: string
  headers_json: string
  body_raw: string | null
  expected_status: number
  max_latency_ms: number
  interval_seconds: number
  alert_webhook_url: string | null
  enabled: number
  last_status: string | null
  last_latency_ms: number | null
  last_run_at: string | null
  created_at: string
  updated_at: string
}

export interface MonitorRunsTable {
  id: string
  monitor_id: string
  passed: number
  status_code: number | null
  duration_ms: number
  error_message: string | null
  checked_at: string
}

export interface LoadTestRunsTable {
  id: string
  workspace_id: string
  name: string
  method: HttpMethod
  url: string
  virtual_users: number
  total_requests: number
  rps_text: string
  error_rate_text: string
  p50_ms: number
  p95_ms: number
  p99_ms: number
  summary_json: string
  created_by: string | null
  created_at: string
}

export interface RequestCommentsTable {
  id: string
  workspace_id: string
  request_id: string
  author_id: string
  author_name: string
  body: string
  created_at: string
}

export interface WorkspaceCookiesTable {
  id: string
  workspace_id: string
  domain: string
  path: string
  cookie_name: string
  cookie_value: string
  http_only: number
  secure: number
  expires_at: string | null
  enabled: number
  updated_at: string
}

export interface RequestExamplesTable {
  id: string
  workspace_id: string
  request_id: string
  name: string
  status_code: number
  status_text: string
  content_type: string
  headers_json: string
  body: string
  created_at: string
}

export interface RbacRolesTable {
  id: string
  slug: string
  name: string
  description: string | null
  is_system: number
  permissions_json: string
  created_at: string
  updated_at: string
}

export interface WorkspaceInvitationsTable {
  id: string
  workspace_id: string
  inviter_id: string
  invitee_user_id: string
  role: WorkspaceRole
  status: 'pending' | 'accepted' | 'declined'
  created_at: string
  responded_at: string | null
}

export interface NotificationsTable {
  id: string
  user_id: string
  type: string
  title: string
  message: string
  metadata_json: string | null
  is_read: number
  created_at: string
}

export interface DatabaseSchema {
  schema_migrations: SchemaMigrationsTable
  system_settings: SystemSettingsTable
  users: UsersTable
  sessions: SessionsTable
  login_history: LoginHistoryTable
  organizations: OrganizationsTable
  organization_members: OrganizationMembersTable
  workspaces: WorkspacesTable
  workspace_members: WorkspaceMembersTable
  user_invitations: UserInvitationsTable
  collections: CollectionsTable
  collection_folders: CollectionFoldersTable
  saved_requests: SavedRequestsTable
  environments: EnvironmentsTable
  environment_variables: EnvironmentVariablesTable
  request_history: RequestHistoryTable
  audit_logs: AuditLogsTable
  api_tokens: ApiTokensTable
  mock_routes: MockRoutesTable
  webhook_endpoints: WebhookEndpointsTable
  webhook_events: WebhookEventsTable
  debug_capsules: DebugCapsulesTable
  monitors: MonitorsTable
  monitor_runs: MonitorRunsTable
  load_test_runs: LoadTestRunsTable
  request_comments: RequestCommentsTable
  workspace_cookies: WorkspaceCookiesTable
  request_examples: RequestExamplesTable
  rbac_roles: RbacRolesTable
  workspace_invitations: WorkspaceInvitationsTable
  notifications: NotificationsTable
}
