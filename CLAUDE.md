# NetM8

Fullstack Cloudflare Workers application — React 19 + Vite frontend, Worker backend.
Domain: netm8.com

## Architecture

- `src/routes/` — TanStack Router file-based routes (auto code-split)
- `src/api.ts` — Hono RPC client (end-to-end type-safe API calls)
- `worker/db/schema.ts` — Drizzle ORM schema (single source of truth for DB types)
- `src/shared/schemas.ts` — Zod validation schemas (shared worker + client)
- `worker/index.ts` — Hono app with middleware, exports `AppType` for RPC + `SpawnAgent` DO class
- `worker/agents/spawn-agent.ts` — SpawnAgent AIChatAgent (persistent chat + state, WebSocket)
- `worker/services/spawn-engine.ts` — AI orchestration engine (Vercel AI SDK `streamText` + sandbox tools)
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
| AI         | Workers AI via Vercel AI SDK (`streamText` + tools)|
| Agents     | AIChatAgent (`@cloudflare/ai-chat`) + WebSocket    |
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
npm run test:visual           # Playwright visual regression tests (against staging)
npm run test:visual:update    # Update visual regression snapshots
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
- **RPC client**: `src/api.ts` — type-safe, inferred from `AppType`
- **DB access**: `drizzle(c.env.DB)` per-request inside Hono handlers
- **Validation**: Zod schemas in `src/shared/schemas.ts`, used via `zValidator()`
- **Routing**: File-based routes in `src/routes/`
- **Testing**: `describe('feature') > describe('given context') > it('behavior')`
- **Commits**: Conventional commits enforced (`feat:`, `fix:`, `docs:`, `test:`, `ci:`)
- **Quality**: Warnings are blockers — fix before feature work
- **Pre-commit**: Lefthook runs Biome on staged files + commitlint

## Spawn System

AIChatAgent streaming loop: `extractSpec` (one-shot Workers AI) → `streamText` with sandbox tools (write_file, read_file, exec, done) → user feedback → `continueProjectStream`

- **SpawnAgent** (`AIChatAgent`): Extends `@cloudflare/ai-chat` — built-in message persistence, streaming protocol, `useAgentChat` on client
- **State**: Hybrid model — `useAgent` for structured state (spec, files, spawnId, status) + `useAgentChat` for messages/status/tool parts
- **Engine**: Vercel AI SDK `streamText` with `workers-ai-provider` wrapping `@hf/nousresearch/hermes-2-pro-mistral-7b`, multi-step tool loop via `stopWhen: stepCountIs(20)`
- **Sandbox**: Cloudflare Sandbox SDK (`@cloudflare/sandbox`) — ephemeral Linux container with Node.js, tools write/read/exec against `/workspace/`
- **Tool streaming**: Tool calls stream as `UIMessage.parts` with lifecycle states (`input-streaming` → `input-available` → `output-available`)
- **Feedback loop**: After completion, user sends another chat message → `continueProjectStream` seeds sandbox with existing files, applies changes
- **Dual persistence**: Agent state (live progress) + D1 (queryable via REST API) + R2 (spawn manifests)
- **Client**: `useAgentChat` from `@cloudflare/ai-chat/react` provides `messages`, `sendMessage`, `status` (`ready | submitted | streaming | error`)
