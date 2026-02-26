# NetM8

Fullstack Cloudflare Workers application — React 19 + Vite frontend, Worker backend.
Domain: netm8.com

## Architecture

- `src/routes/` — TanStack Router file-based routes (auto code-split)
- `src/client/api.ts` — Hono RPC client (end-to-end type-safe API calls)
- `src/db/schema.ts` — Drizzle ORM schema (single source of truth for DB types)
- `src/shared/schemas.ts` — Zod validation schemas (shared worker + client)
- `worker/index.ts` — Hono app with middleware, exports `AppType` for RPC
- `migrations/` — D1 database migrations (sequential numbered SQL files)
- `tests/behaviors/` — Behavior-centric tests (Vitest + Cloudflare Workers pool)
- `docs/adr/` — Architecture Decision Records
- `.github/workflows/` — CI/CD pipelines

## Stack

| Layer      | Technology                                    |
| ---------- | --------------------------------------------- |
| Frontend   | React 19, Vite 7, TanStack Router, TanStack Query |
| Backend    | Hono (Cloudflare Worker)                      |
| Database   | Cloudflare D1 (SQLite) + Drizzle ORM          |
| Validation | Zod                                           |
| Cache      | Cloudflare KV                                 |
| Storage    | Cloudflare R2                                 |
| AI         | Workers AI binding                            |
| Linting    | Biome (lint + format)                         |
| Testing    | Vitest + @cloudflare/vitest-pool-workers      |
| Hooks      | Lefthook (pre-commit lint/typecheck, commitlint) |

## Commands

| Task                    | Command                                            |
| ----------------------- | -------------------------------------------------- |
| Dev server              | `npm run dev`                                      |
| Dev with local bindings | `npm run dev:worker`                               |
| Build                   | `npm run build`                                    |
| Test                    | `npm run test`                                     |
| Test watch              | `npm run test:watch`                               |
| Lint                    | `npm run lint`                                     |
| Lint + fix              | `npm run lint:fix`                                 |
| Format                  | `npm run format`                                   |
| Type check              | `npm run typecheck`                                |
| Generate CF types       | `npm run cf-typegen`                               |
| Deploy staging          | `npm run deploy:staging`                           |
| Deploy production       | `npm run deploy:production`                        |
| New migration           | `wrangler d1 migrations create netm8-db <name>`   |
| Apply migrations local  | `wrangler d1 migrations apply netm8-db --local`   |
| Apply migrations remote | `wrangler d1 migrations apply netm8-db --remote`  |

## Conventions

- **Wrangler config**: `wrangler.jsonc` (never `.toml`)
- **Environments**: `staging` and `production` defined in wrangler.jsonc
- **Migrations**: Sequential numbered SQL files in `migrations/`
- **API routes**: Hono router at `worker/index.ts`, all routes under `/api/*`
- **RPC client**: `src/client/api.ts` — type-safe, no codegen, inferred from `AppType`
- **DB access**: `drizzle(c.env.DB)` per-request inside Hono handlers (not module scope)
- **Validation**: Zod schemas in `src/shared/schemas.ts`, used via `zValidator()` middleware
- **Routing**: TanStack Router file-based routes in `src/routes/`
- **Testing**: Behavior-centric — `describe('feature') > describe('given context') > it('expected behavior')`
- **Commits**: Conventional commits enforced by commitlint (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `refactor:`)
- **Quality gate**: Warnings are blockers — fix before feature work
- **Pre-commit**: Lefthook runs Biome + typecheck on staged files

## Environment Variables

- `.dev.vars` — Local development secrets (git-ignored)
- `.dev.vars.example` — Template for local secrets (committed)
- Secrets set via `wrangler secret put <NAME>` for staging/production

## Port Assignments (Slot 1)

| Service | Port |
| ------- | ---- |
| API     | 8781 |
| Web     | 4321 |
