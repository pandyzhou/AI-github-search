# AGENTS.md

## Developer Commands & Verification Order

Run validation in this exact order:

```bash
# 1. Type check
npm run typecheck

# 2. Lint check
npm run lint

# 3. Unit tests
npm run test:unit

# 4. Production build check
npm run build
```

Run a single unit test file:

```bash
npx vitest run src/test/unit/user-actions.test.ts
```

## Architecture & Data Layer

- **Dual Database Provider**: Controlled via `DATABASE_PROVIDER=sqlite|postgresql` (defaults to Postgres schema if unset).
  - SQLite mode uses `better-sqlite3` and `src/db/schema-sqlite.ts`. It auto-executes `CREATE TABLE IF NOT EXISTS` at startup in `src/db/index.ts`.
  - Postgres mode uses `pg` and `src/db/schema-pg.ts`.
- **Database Fallbacks**: Set `ALLOW_MEMORY_DB=true` for testing/temporary runs without a persistent database.
- **Search & Caching**: Search falls back to GitHub REST API if Meilisearch fails. Caching uses Redis with in-memory fallback.

## Authentication & Middleware Security

- **Authentication**: NextAuth.js credentials provider (`src/lib/auth.ts`). Password hashing uses `scrypt` (`src/lib/password.ts`).
- **Global Auth Guard**: `src/middleware.ts` enforces authentication across all pages and APIs except:
  - `/login`
  - `/api/auth/*`
  - `/api/health`
  - Static assets (`/_next/*`, `/logo.png`, etc.)
- **Admin Assignment**: Configured via `ADMIN_EMAILS` (comma-separated) in `.env.local` or set directly on `users.role = 'ADMIN'`.

## File Structure & Entrypoints

- `src/middleware.ts`: Global route & API protection
- `src/db/index.ts`: Database connection initialization & SQLite schema auto-bootstrap
- `src/lib/password.ts`: Password hashing (`scrypt`) and verification
- `src/lib/github.ts`: GitHub REST API client & rate-limit handling
- `src/server/*.actions.ts`: Server-side actions for data fetching & user management
