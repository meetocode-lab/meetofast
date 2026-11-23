# AGENTS.md — Meofast Engineering & Design Rules

## Project Overview

**Meofast** is an open-source, 100% free, self-hosted web API Development Platform built as a TypeScript monorepo:

- **`apps/web`:** Next.js (App Router), React, TypeScript, Tailwind CSS, TanStack Query, Zustand, and the **Blue Aurora** design system (`meorora` architecture).
- **`apps/api`:** Hono modular monolith on Node.js (`@hono/node-server`), Kysely multi-dialect database engine (PostgreSQL, MySQL, MariaDB, SQLite), native Argon2id, and AES-256-GCM encryption.
- **`packages/shared`:** Shared TypeScript contracts, Zod validation schemas, and RBAC/HTTP constants.

---

## 1. Visual Identity & Theme Rules (Inherited from `meorora`)

1. **Blue Aurora Palette Only:** Use royal blue (`#2563eb` light / `#3b82f6` dark), cyan (`#22d3ee`), sky (`#7dd3fc`), crisp white (`#ffffff`), and neutral ice-slate surfaces (`#f8fbff` light / `#071426` dark).
2. **Forbidden Brand Colors:** Do **not** introduce purple, violet, magenta, or pink into brand UI, gradients, or decorative elements. Semantic feedback colors (`success`, `warning`, `danger`, `info`) are strictly for status badges, HTTP verbs, and validation states.
3. **Default Light Mode + Mode Switch:** `data-theme="light"` is the mandatory default theme on initial visit; users can switch seamlessly between Light and Dark (`data-theme="dark"`).
4. **Craft Floor Requirements:**
   - Never place kickers or eyebrow labels above headings.
   - Never use emoji or Unicode glyphs (`☰`, `✕`, `⌄`, `🔍`) as icons—always use crisp SVG icons from `@/components/ui/icon`.
   - Enforce `font-variant-numeric: tabular-nums` on HTTP status codes, millisecond timings, byte counts, and timestamps.
   - Theme `:focus-visible`, `::selection`, and scrollbars using Blue Aurora CSS variables.

---

## 2. Mandatory Frontend UI Component Structure

Every reusable UI primitive in `apps/web/src/components/ui/` **must** live in its own `kebab-case` directory with `PascalCase` component files and an `index.ts` barrel export:

```text
apps/web/src/components/ui/
├── avatar/
│   ├── Avatar.tsx
│   └── index.ts
├── badge/
│   ├── Badge.tsx
│   └── index.ts
├── button/
│   ├── Button.tsx
│   └── index.ts
├── card/
│   ├── Card.tsx
│   └── index.ts
├── dialog/
│   ├── Dialog.tsx
│   └── index.ts
├── icon/
│   ├── Icon.tsx
│   └── index.ts
├── input/
│   ├── Input.tsx
│   └── index.ts
├── select/
│   ├── Select.tsx
│   └── index.ts
├── spinner/
│   ├── Spinner.tsx
│   └── index.ts
├── switch/
│   ├── Switch.tsx
│   └── index.ts
├── tabs/
│   ├── Tabs.tsx
│   └── index.ts
└── index.ts
```

Never dump loose `.tsx` primitives directly into `apps/web/src/components/ui/`. Keep domain-specific components inside `apps/web/src/features/<feature>/`.

---

## 3. Backend, Database & Security Invariants

1. **No Paywalls or Quotas:** Never add feature flags, license checks, seat caps, collection limits, or external telemetry.
2. **Database Portability:** Every Kysely migration and query in `apps/api` must run cleanly on PostgreSQL, MySQL, MariaDB, and SQLite. Use application-generated `UUIDv4` strings (`varchar(36)`), ISO-8601 UTC strings (`varchar(40)`), integer `0/1` flags, and avoid dialect-specific SQL syntax.
3. **Setup Locking:** Once `install.lock` and `system_settings.installation_completed` are written, `/api/v1/setup/*` mutating routes must always return `403 INSTALLATION_LOCKED`. Never expose database credentials in responses or logs.
4. **SSRF Enforcement:** All outbound HTTP requests in `modules/proxy` must validate resolved DNS IPs (and every redirect hop) through `SsrfGuard`. Cloud metadata endpoints (`169.254.169.254`, etc.) are unconditionally blocked; private networks require explicit admin policy authorization.
5. **Cryptography:** Hash passwords exclusively with Argon2id; encrypt stored DB credentials and secret environment variables with AES-256-GCM; hash session tokens with SHA-256 before database persistence.

---

## 4. Verification Before Completing Changes

1. Run TypeScript typechecks across all workspaces (`npm run typecheck`).
2. Run automated backend & database compatibility tests (`npm test`).
3. Run production builds (`npm run build`) to confirm clean bundling.
4. Verify rendered UI in both Light (default) and Dark themes across Setup Wizard and Main Workspace.
