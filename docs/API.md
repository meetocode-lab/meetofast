# Internal REST API Reference — Meofast (`apps/api`)

Base prefix: `/api/v1` (proxied same-origin via `http://<host>:4780/api/v1`).

All mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) require the `X-CSRF-Token` header matching the active session (or bootstrap setup token during `/setup`).

---

## Health & Bootstrap Setup

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/v1/health` | Public | Returns service health, version, installation state, and DB connectivity |
| `GET` | `/api/v1/setup/status` | Public | Returns `{ installed, version, appName, csrfToken }` |
| `POST` | `/api/v1/setup/validate-db` | Pre-install only | Tests PostgreSQL, MySQL, MariaDB, or SQLite credentials & permissions |
| `POST` | `/api/v1/setup/create-db` | Pre-install only | Explicitly creates missing PG/MySQL/MariaDB database when confirmed |
| `POST` | `/api/v1/setup/execute` | Pre-install only | Runs migrations, seeds defaults, creates Super Admin, writes `install.lock` |

---

## Authentication & Sessions

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/login` | Public | Authenticates email/username + password (Argon2id), sets `HttpOnly` cookie |
| `POST` | `/api/v1/auth/register` | Policy / Invite | Registers account when registration mode is `open` or invite token is valid |
| `POST` | `/api/v1/auth/logout` | Authenticated | Destroys current session and clears cookie |
| `GET` | `/api/v1/auth/me` | Authenticated | Returns current user profile, CSRF token, orgs, workspaces, and settings |
| `POST` | `/api/v1/auth/password` | Authenticated | Verifies current password and updates Argon2id password hash |
| `GET` | `/api/v1/auth/sessions` | Authenticated | Lists active sessions for current user |
| `DELETE` | `/api/v1/auth/sessions/:id` | Authenticated | Revokes a specific session |

---

## Workspaces, Collections, Environments & Request Execution

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/v1/workspaces` | Authenticated | Lists accessible workspaces |
| `POST` | `/api/v1/workspaces` | Admin / Org Admin | Creates a new workspace |
| `GET` | `/api/v1/workspaces/:wsId/tree` | Workspace Member | Fetches full collections, nested folders, and saved requests tree |
| `POST` | `/api/v1/workspaces/:wsId/collections` | Developer+ | Creates a collection |
| `POST` | `/api/v1/workspaces/:wsId/collections/import` | Developer+ | Imports cURL command, Postman v2.1 JSON, or Meofast JSON |
| `GET` | `/api/v1/collections/:id/export` | Workspace Member | Exports collection as Postman v2.1 or Meofast JSON |
| `POST` | `/api/v1/collections/:id/folders` | Developer+ | Creates nested folder |
| `POST` | `/api/v1/workspaces/:wsId/requests` | Developer+ | Creates saved request |
| `PUT` | `/api/v1/requests/:id` | Developer+ | Updates saved request |
| `DELETE` | `/api/v1/requests/:id` | Developer+ | Deletes saved request |
| `GET` | `/api/v1/workspaces/:wsId/environments` | Workspace Member | Lists environments and variables (secrets masked) |
| `POST` | `/api/v1/workspaces/:wsId/environments` | Developer+ | Creates environment with plaintext & AES-256-GCM secret variables |
| `PUT` | `/api/v1/environments/:id` | Developer+ | Updates environment and variables |
| `POST` | `/api/v1/proxy/execute` | Workspace Member | Executes outbound HTTP request via SSRF-guarded backend engine + assertions |
| `GET` | `/api/v1/workspaces/:wsId/history` | Workspace Member | Lists recent request execution history |

---

## Administration, RBAC, Network Policy & Audit

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/v1/users` | Admin | Lists all instance users and login status |
| `POST` | `/api/v1/users` | Admin | Creates user account or issues invitation |
| `PATCH` | `/api/v1/users/:id` | Admin | Updates user global role or `active`/`deactivated` status |
| `GET` | `/api/v1/admin/settings` | Admin | Reads registration policy & SSRF internal network policy |
| `PUT` | `/api/v1/admin/settings` | Admin | Updates registration mode & authorized internal network CIDRs/domains |
| `GET` | `/api/v1/admin/audit-logs` | Admin | Queries immutable audit logs and login history |


---

## Multi-Protocol, Runner, Mock Server, Webhooks, Monitoring & Load Testing

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET/POST/DELETE` | `/api/v1/auth/tokens` | Authenticated | Manage Personal API Tokens (`mf_pat_...`) for `@meofast/cli` & CI/CD |
| `POST` | `/api/v1/collections/:id/run` | Workspace Member | Sequential & CSV/JSON data-driven Collection Runner |
| `POST` | `/api/v1/proxy/oauth2/token` | Workspace Member | Fetches OAuth 2.0 access tokens (`client_credentials`, `password`, `authorization_code`) |
| `POST` | `/api/v1/proxy/graphql/introspect` | Workspace Member | Runs GraphQL `__schema` introspection query |
| `POST` | `/api/v1/proxy/ws/connect` | Workspace Member | Opens interactive outbound WebSocket testing session |
| `POST` | `/api/v1/proxy/ws/:sessionId/send` | Workspace Member | Sends a WebSocket frame and returns updated stream |
| `ALL` | `/api/v1/mock/:workspaceSlug/*` | Public / Internal | Executes workspace mock routes (dynamic tokens, stateful CRUD, latency & error injection) |
| `GET/POST` | `/api/v1/workspaces/:wsId/mocks` | Developer+ | Lists or creates workspace mock routes |
| `POST` | `/api/v1/collections/:id/generate-mocks` | Developer+ | Auto-generates mock routes from a collection |
| `ALL` | `/api/v1/webhooks/in/:token` | Public / External | Captures inbound webhook requests and verifies HMAC-SHA256 signatures |
| `GET/POST` | `/api/v1/workspaces/:wsId/webhooks` | Developer+ | Lists or creates webhook endpoints |
| `POST` | `/api/v1/webhooks/events/:eventId/replay` | Developer+ | Replays a captured webhook payload to a target URL |
| `GET/POST` | `/api/v1/workspaces/:wsId/capsules` | Developer+ | Lists or saves sanitized `.capsule` debug reproduction bundles |
| `GET/POST` | `/api/v1/workspaces/:wsId/monitors` | Developer+ | Lists or creates scheduled endpoint monitors |
| `POST` | `/api/v1/monitors/:id/run` | Workspace Member | Executes an immediate health check probe on a monitor |
| `GET/POST` | `/api/v1/workspaces/:wsId/load-tests` | Developer+ | Lists or runs concurrent virtual-user load tests (`req/s`, `p50`, `p95`, `p99`) |
| `GET/POST` | `/api/v1/requests/:id/comments` | Workspace Member | Lists or posts team collaboration comments on saved requests |
| `GET/PUT` | `/api/v1/admin/ai-config` | Admin | Reads or updates optional BYOK AI provider configuration |
| `POST` | `/api/v1/ai/assist` | Authenticated | Generates smart test scripts (via configured BYOK provider or local deterministic analyzer) |
