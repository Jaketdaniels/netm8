# NetM8

Fullstack Cloudflare Workers application — React 19 + Vite frontend, Worker backend.
Domain: netm8.com

## Architecture

- `src/routes/` — TanStack Router file-based routes (auto code-split)
- `src/client/api.ts` — Hono RPC client (end-to-end type-safe API calls)
- `src/db/schema.ts` — Drizzle ORM schema (single source of truth for DB types)
- `src/shared/schemas.ts` — Zod validation schemas (shared worker + client)
- `worker/index.ts` — Hono app with middleware, exports `AppType` for RPC + `SpawnAgent` DO class
- `worker/agents/spawn-agent.ts` — SpawnAgent Durable Object (persistent state, WebSocket)
- `worker/services/spawn-engine.ts` — AI orchestration engine (Workers AI JSON Mode + Zod)
- `migrations/` — D1 database migrations (sequential numbered SQL files)
- `tests/behaviors/` — Behavior-centric tests (Vitest + Cloudflare Workers pool)
- `docs/adr/` — Architecture Decision Records
- `.github/workflows/pipeline.yml` — Unified CI/CD pipeline (quality gate + deploy)

## Stack

| Layer      | Technology                                         |
| ---------- | -------------------------------------------------- |
| Frontend   | React 19, Vite 7, TanStack Router, TanStack Query |
| Backend    | Hono (Cloudflare Worker)                           |
| Database   | Cloudflare D1 (SQLite) + Drizzle ORM              |
| Validation | Zod                                                |
| Cache      | Cloudflare KV                                      |
| Storage    | Cloudflare R2                                      |
| AI         | Workers AI binding (JSON Mode)                     |
| Agents     | Cloudflare Agents SDK (Durable Objects + WebSocket)|
| Quality    | Biome (lint + format), Lefthook, commitlint        |
| Testing    | Vitest + @cloudflare/vitest-pool-workers           |

## Commands

```
npm run dev                   # Local dev server (Vite + Wrangler, full stack with D1/KV/R2)
npm run build                 # Production build (types + tsc + vite)
npm run check                 # Full quality gate (lint + typecheck + docs + test)
npm run check:docs            # Documentation policy linter (runs in check)
npm run lint                  # Biome lint + format (auto-fix)
npm run lint:check            # Biome lint + format (CI, no writes)
npm run test                  # Vitest run
npm run test:watch            # Vitest watch mode
npm run migrate               # Apply D1 migrations to remote (shared DB)
npm run deploy:staging        # Trigger GitHub Actions pipeline (staging)
npm run deploy:production     # Trigger GitHub Actions pipeline (production)
```

## Environment Configuration

- **Config**: `wrangler.jsonc` (never `.toml`). Run `wrangler types` after changes.
- **Environments**: `staging` and `production` in `wrangler.jsonc` env block
- **Env selection**: `CLOUDFLARE_ENV=<env>` at build time (Vite plugin bakes it in). Do NOT use `wrangler deploy --env`.
- **Deployment**: Always via GitHub Actions (`gh workflow run`). Push to main deploys staging; use `deploy:production` for production. Never deploy directly with wrangler.
- **Shared storage**: All environments use the same D1, KV, R2, and AI bindings. Only `ENVIRONMENT` var and worker `name` differ.
- **Non-secret vars**: `wrangler.jsonc` `vars` section, accessed via `c.env.<VAR>`
- **Secrets**: `.dev.vars` for local dev (git-ignored), `wrangler secret bulk .dev.vars` for remote
- **Client-side vars**: `.env` with `VITE_` prefix, accessed via `import.meta.env.VITE_<VAR>`
- **AI**: Workers AI binding only — no third-party AI API keys

## Conventions

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

## Spawn System

Iterative loop: `extractSpec` (one-shot) → `runIteration` × N (create/edit/delete/done operations) → user feedback → more iterations

- **SpawnAgent** (Durable Object): Persistent state via `this.setState()`, WebSocket real-time updates via `agents/react` `useAgent` hook
- **Workers AI**: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` model with `response_format: { type: "json_schema" }` for structured output
- **Operations**: Each iteration returns `create`, `edit` (line diffs), `delete`, or `done` operations applied to a file map
- **Feedback loop**: After completion, user can send feedback to trigger additional iterations
- **Validation**: Zod schemas validate every AI response before proceeding
- **Dual persistence**: Agent state (live progress, survives disconnects) + D1 (queryable via REST API)
- **Client connection**: `ws://host/agents/SpawnAgent/{uuid}` — state syncs on reconnect
