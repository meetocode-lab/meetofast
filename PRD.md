# Product Requirements Document (PRD) — Meofast

**Product Name:** Meofast  
**License:** Apache-2.0 (100% Free & Open-Source)  
**Platform:** Self-Hosted Web Application  
**Default Visual Theme:** Blue Aurora (`meorora` design language) — Light mode default with Dark mode toggle  

---

## 1. Executive Summary & Vision

**Meofast** is an enterprise-grade, 100% free, open-source, self-hosted API Development Platform built primarily for the web. It enables individual developers, startups, and large enterprises to design, execute, test, debug, document, mock, and govern APIs entirely on their own infrastructure (personal VPS, company servers, private cloud, on-premise VMs, or local Docker environments).

Meofast serves as a complete, self-hosted alternative to Postman, Insomnia, Bruno, and Hoppscotch—eliminating mandatory cloud accounts, per-user seat fees, collection limits, and browser CORS barriers.

### Fundamental Product Policy (Non-Negotiable)
- **100% Free, All Features, Zero Paywall:** Every capability—including multi-workspace RBAC, encrypted secret variables, audit logs, internal network SSRF policies, team management, and collection runners—ships unlocked in the open-source repository.
- **No Forced Cloud or Telemetry:** Zero phone-home analytics, zero license keys, zero external account requirements.

---

## 2. Target Distribution Models

1. **Self-Hosted Individual:** Single `docker compose up -d` deployment on localhost or a small VPS using SQLite or PostgreSQL with full feature parity.
2. **Self-Hosted Company / Enterprise:** Multi-user, multi-workspace deployment backed by PostgreSQL/MySQL/MariaDB, supporting 5-tier RBAC, shared collections, encrypted secrets, private internal network API testing, session governance, and immutable audit trails.
3. **Hosted-Ready Architecture:** Clean multi-organization data isolation (`organizations` -> `workspaces`) allowing future managed hosting without architectural rewrites while keeping cloud hosting strictly optional.

---

## 3. Core Functional Requirements

### 3.1 First-Time Web Installation Wizard (Mandatory)
An n8n-inspired browser setup flow triggered automatically whenever Meofast detects an uninitialized instance:
- **Step 1 — Welcome:** Product identity, version, open-source guarantee, system readiness check.
- **Step 2 — Database Selection:** Runtime selection among **PostgreSQL** (recommended), **MySQL**, **MariaDB**, or **SQLite** without rebuilding the application.
- **Step 3 — Database Connection Validation:** Live validation of driver, network/filesystem reachability, credentials, version compatibility, and DDL permissions. If the target database does not exist and credentials permit creation, offer an explicit user-confirmed "Create Database" action (never silent creation or overwrite).
- **Step 4 — Administrator Account:** Creation of the single initial Super Administrator (`fullName`, `email`, `username`, strong `password` hashed with **Argon2id**). Zero default credentials.
- **Step 5 — Application Configuration:** Application name (`Meofast`), public URL, default timezone, language, and initial organization name.
- **Step 6 — Installation Execution:** Live progress display executing encrypted config persistence, Kysely connection initialization, schema migrations, system seeding, admin creation, cryptographic secret generation, and permanent setup locking—without requiring manual container restarts.
- **Step 7 — Installation Complete:** Summary of configured engine, version, admin email, and one-click entry into the dashboard.

### 3.2 User Management, RBAC & Company Workspaces
- **5 Built-In Roles:** `super_admin`, `org_admin`, `workspace_admin`, `developer`, `viewer`.
- **User Lifecycle:** Admin-controlled registration policy (invite-only vs open internal signup), direct user creation/invitations, role updates, account deactivation, password changes, active session revocation, login history, and audit logging.
- **Multi-Workspace Isolation:** Separate collections, folders, saved requests, environments, and execution history per workspace with granular workspace membership.

### 3.3 Backend Web Request Execution Engine
- **Server-Side Execution:** All outbound API calls execute through Hono's backend engine (`apps/api`) to eliminate browser CORS restrictions and support custom headers, cookies, TLS options, proxies, and accurate latency timing.
- **SSRF Defense + Company Private API Policy:**
  - Always blocks cloud metadata IPs (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`).
  - Blocks loopback (`127.0.0.0/8`, `::1`) and private RFC1918 networks (`10/8`, `172.16/12`, `192.168/16`) by default.
  - Allows Super/Org Administrators to explicitly enable authorized private subnets or internal domain patterns (e.g., `*.corp.internal`, `10.0.0.0/8`) so companies can test internal microservices safely.
  - Validates DNS resolution on initial URL and every redirect hop.

### 3.4 API Client, Collections, Environments & Testing
- **Request Builder:** HTTP methods (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`), URL & `:path` parameter sync, query params, custom headers, JSON/XML/Text/Form-Urlencoded/Multipart bodies, request cancellation, and configurable timeouts.
- **Authentication:** Bearer Token, Basic Auth, API Key (Header or Query), JWT Bearer, OAuth 2.0 Token/Header, and Custom Auth headers with full `{{variable}}` interpolation.
- **Collections & Folders:** Unlimited nested folders, saved requests, descriptions, collection-level execution, cURL import, Postman Collection v2.1 import/export, and native JSON export.
- **Environment & Secret Vault:** Multiple workspace environments + Global variables, dynamic built-in variables (`{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`), `.env` import/export, and **AES-256-GCM encrypted secret variables**.
- **Automated Assertions:** Declarative post-response assertions (HTTP status equals/in-range, response latency `< ms`, header presence/value, JSON path value/contains) with pass/fail reporting.

### 3.5 Extended Platform Capabilities (Milestones 3–5)
- **Protocols:** GraphQL query/variables mode, SSE/WebSocket inspector, gRPC & SOAP roadmap modules.
- **Mocking, Webhooks & Debugging:** Dynamic Mock Server endpoints, Webhook capture & replay inspector, `.capsule` sanitized bug reproduction export, OpenAPI documentation viewer, performance load runner, scheduled uptime monitors, CLI runner, and optional BYOK AI assistant.

---

## 4. Non-Functional Requirements

- **Performance:** Sub-50ms internal API overhead; high-density React UI using Zustand for zero-lag tab editing and TanStack Query for server synchronization.
- **Portability:** Single codebase runs identically on PostgreSQL 14+, MySQL 8.0+, MariaDB 10.6+, and SQLite 3.x.
- **Security:** Argon2id (`m=64MiB, t=3, p=4`), AES-256-GCM secret storage, HttpOnly + SameSite cookies, Double-Submit/Session CSRF tokens, rate limiting, and sanitized logs.
- **Deployability:** Turnkey `docker compose up -d` with persistent named volumes, healthchecks, backup/restore scripts, and Nginx/Traefik production templates.
