# Contributing to Meetofast

Thank you for contributing to **Meetofast**! Our mission is to maintain a 100% free, open-source, self-hosted API development platform with uncompromising security, multi-database portability, and clean Blue Aurora UI craftsmanship.

## Core Contribution Rules

1. **Zero Paywalls or Telemetry:** Never introduce feature gating, seat restrictions, paid tiers, or external analytics calls.
2. **Multi-Database Compatibility:** Every database migration or Kysely query must work across PostgreSQL, MySQL, MariaDB, and SQLite. Avoid dialect-locked SQL syntax and add coverage in `apps/api/test/`.
3. **UI Component Discipline:** Place reusable UI primitives in `apps/web/src/components/ui/<kebab-case>/` with barrel exports (`index.ts`), adhering to the Blue Aurora token palette (`DESIGN.md` and `AGENTS.md`).
4. **Security First:** Never log plaintext secrets, database passwords, or session cookies. Route all outbound target API calls through `SsrfGuard`.

## Development Workflow

1. Fork and clone the repository.
2. Run `npm install`.
3. Create a feature branch: `git checkout -b feat/your-feature`.
4. Implement your feature along with automated tests in `apps/api/test/`.
5. Verify before opening a Pull Request:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
6. Open a clear, focused Pull Request describing the problem, architectural choices, and verification steps.
