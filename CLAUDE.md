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

| Layer      | Technology                                         |
| ---------- | -------------------------------------------------- |
| Frontend   | React 19, Vite 7, TanStack Router, TanStack Query |
| Backend    | Hono (Cloudflare Worker)                           |
| Database   | Cloudflare D1 (SQLite) + Drizzle ORM              |
| Validation | Zod                                                |
| Cache      | Cloudflare KV                                      |
| Storage    | Cloudflare R2                                      |
| AI         | Workers AI binding                                 |
| Quality    | Biome (lint + format), Lefthook, commitlint        |
| Testing    | Vitest + @cloudflare/vitest-pool-workers           |

## Commands

```
npm run dev                   # Local dev server (Wrangler, full stack with D1/KV/R2)
npm run build                 # Production build (types + tsc + vite)
npm run check                 # Full quality gate (lint + typecheck + test)
npm run lint                  # Biome lint + format (auto-fix)
npm run lint:check            # Biome lint + format (CI, no writes)
npm run test                  # Vitest run
npm run test:watch            # Vitest watch mode
npm run deploy:staging        # Build + migrate + deploy staging
npm run deploy:production     # Build + migrate + deploy production
```

## Conventions

- **Config**: `wrangler.jsonc` (never `.toml`)
- **Environments**: `staging` and `production` in wrangler.jsonc
- **Migrations**: Sequential SQL files in `migrations/`
- **API routes**: Hono router at `worker/index.ts`, all routes under `/api/*`
- **RPC client**: `src/client/api.ts` — type-safe, inferred from `AppType`
- **DB access**: `drizzle(c.env.DB)` per-request inside Hono handlers
- **Validation**: Zod schemas in `src/shared/schemas.ts`, used via `zValidator()`
- **Routing**: File-based routes in `src/routes/`
- **Testing**: `describe('feature') > describe('given context') > it('behavior')`
- **Commits**: Conventional commits enforced (`feat:`, `fix:`, `docs:`, `test:`, `ci:`)
- **Quality**: Warnings are blockers — fix before feature work
- **Pre-commit**: Lefthook runs Biome on staged files + commitlint

## Secrets

- `.dev.vars` — Local secrets (git-ignored)
- `.dev.vars.example` — Template (committed)
- `wrangler secret put <NAME>` — Staging/production secrets
