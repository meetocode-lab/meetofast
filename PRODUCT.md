# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Next.js (App Router) + React + TypeScript + Tailwind CSS with structured Blue Aurora UI primitives (`apps/web`), Hono on Node.js (`@hono/node-server`) modular monolith + Kysely dynamic multi-dialect database engine supporting PostgreSQL, MySQL, MariaDB, and SQLite (`apps/api`), shared TypeScript/Zod contracts (`packages/shared`), and Docker Compose deployment.

## Users

- **Individual Developers & Consultants:** Deploying a self-hosted API workspace on a local machine or personal VPS to design, test, debug, and organize HTTP/REST and multi-protocol APIs without cloud lock-in or subscription limits.
- **Engineering Teams & Platform Administrators:** Deploying a centralized, multi-user API development platform on company servers, private cloud, or on-premise infrastructure to share collections, manage encrypted environment secrets, test internal private-network services, and enforce role-based access control with audit trails.

## Product Purpose

Meofast is a 100% free, open-source, self-hosted web-based API Development Platform. It replaces fragmented desktop clients and paywalled SaaS tools (Postman, Insomnia, Bruno, Hoppscotch) with a unified, company-owned platform for API request execution, environment management, automated assertions, collection sharing, and team governance. Success means an administrator can run `docker compose up -d`, complete database and admin setup entirely in the browser via an n8n-style installation wizard without editing `.env` or writing SQL, and immediately collaborate with their team to test external and authorized internal APIs.

## Positioning

Unlike browser-only API clients crippled by CORS or desktop clients that force cloud sync and per-seat paywalls for team collaboration, Meofast combines a zero-paywall self-hosted multi-user workspace, a browser-driven multi-database installation wizard (PostgreSQL, MySQL, MariaDB, SQLite without rebuilding), and an SSRF-hardened backend request execution engine with administrator-governed internal network policies.

## Operating Context

- **First-Time Provisioning:** A DevOps engineer or administrator provisions a fresh Linux VPS or internal VM, starts containers via Docker Compose, opens port `3000` in a browser, validates database credentials (or creates a local SQLite database), creates the initial Argon2id-protected Super Administrator account, and locks setup permanently.
- **Daily API Engineering:** Developers work in bright office or dark coding environments across wide desktop monitors, keeping multiple request tabs open, switching between Staging/Production environments, interpolating encrypted secrets (`{{apiKey}}`), inspecting JSON payloads, headers, latency timings, and assertion results, and importing/exporting Postman v2.1 or cURL definitions.
- **Enterprise Governance:** Administrators manage workspaces, invite or provision team members across five RBAC roles, configure allowed private CIDR/domain targets for internal microservices, and inspect login history and audit logs.

## Capabilities and Constraints

- **100% Free & Open-Source Policy:** Apache-2.0 licensed. Zero paywalls, zero usage quotas, zero seat limits, zero collection/environment caps, zero mandatory cloud accounts, and zero telemetry.
- **Dynamic Multi-Database Support:** Single compiled Hono backend dynamically connects to and migrates PostgreSQL (recommended production), MySQL, MariaDB, or SQLite (lightweight/personal) at runtime from the web setup wizard without rebuilding containers.
- **Backend Request Execution Engine:** Executes HTTP/HTTPS requests server-side to bypass browser CORS, enforces DNS-resolved SSRF protection blocking cloud metadata endpoints (`169.254.169.254`) and unauthorized localhost/RFC1918 ranges by default, and allows explicit administrator allowlists for legitimate internal company APIs.
- **Security Baseline:** Argon2id password hashing, AES-256-GCM encryption at rest for database credentials and secret environment variables, HttpOnly session cookies, CSRF protection, rate limiting, and permanent setup wizard locking (`data/install.lock` + database state) after initialization.

## Brand Commitments

- **Name:** Meofast
- **Visual Identity:** Blue Aurora Design System inherited from `meorora` — clean, crisp blue (`#2563eb`), cyan (`#22d3ee`), sky (`#7dd3fc`), pure white (`#ffffff`), and cool ice-slate (`#f8fbff` / `#0f172a`) surfaces. Purple, violet, magenta, and pink are strictly excluded from brand styling.
- **Theme Behavior:** Light theme (`data-theme="light"`) is the default experience, paired with an instant user-switchable Dark theme (`data-theme="dark"`).
- **Component Discipline:** Strict per-component folder organization (`src/components/ui/<component>/`) with colocated styles and barrel exports.

## Evidence on Hand

- Reference UI system and component conventions in sibling repository `d:\Project\Meocode\meorora`.
- Live runtime execution metrics, HTTP response headers/bodies, database connection validation probes, and persistent SQLite/PostgreSQL/MySQL/MariaDB records generated directly by the application. No fabricated customer logos, testimonials, or synthetic marketing claims may be introduced.

## Product Principles

1. **Browser-Complete Self-Hosting:** Every operational lifecycle step—from database provisioning and schema migration to user management and internal network policy—must work cleanly through the web UI without manual `.env` surgery or container rebuilds.
2. **Zero Artificial Scarcity:** Collaboration, RBAC, audit logging, unlimited workspaces, and encrypted secrets are foundational engineering necessities, never gated behind tiers or cloud accounts.
3. **Security Without Blocking Real Work:** Protect self-hosted infrastructure by default (SSRF guards, setup locks, Argon2id, AES-256-GCM vault) while giving administrators explicit, auditable controls to test private internal APIs.
4. **High-Density Operational Clarity:** Prioritize scannable typography, keyboard-first workflows, tabular metrics, and fast request-response feedback over decorative chrome.

## Accessibility & Inclusion

- Semantic HTML landmarks, labeled form controls, accessible error announcements, and full keyboard navigation (`Tab`, `Escape`, `Ctrl/Cmd+K` command palette, `Ctrl/Cmd+Enter` send request).
- WCAG AA contrast ratios (≥4.5:1 for body copy and inputs across both Light and Dark Blue Aurora themes), visible `:focus-visible` rings, status indicators never relying on color alone, and `prefers-reduced-motion` support.
