# ADR 001: Initial Architecture

**Status**: Accepted
**Date**: 2026-02-26

## Context

NetM8 needs a fullstack web application architecture that is:
- Optimized for AI coding agent development (Claude Code)
- Scalable on Cloudflare's edge network
- Maintainable with docs-as-code
- Testable with behavior-centric patterns

## Decision

### Platform: Cloudflare Workers (fullstack)
Single Worker serves both the React SPA and API routes. Static assets via Workers Static Assets with SPA fallback. No Pages (deprecated).

### Frontend
- **React 19 + Vite 7** — Minimal, fast, widely understood by AI agents. Vite provides HMR and optimized builds.
- **TanStack Router** — File-based routing with auto code-splitting (`src/routes/`).
- **TanStack Query** — Server state management, caching, and data fetching.
- **Tailwind CSS v4 + shadcn/ui** — Utility-first styling with a component library. AI Elements registry from Vercel for chat/code/file-tree components.

### Backend
- **Hono** — Lightweight API framework. All routes under `/api/*`. Exports `AppType` for end-to-end type-safe RPC client on the frontend.
- **Drizzle ORM** — Type-safe database access. Schema defined in `worker/db/schema.ts`.
- **Zod** — Validation schemas shared between worker and client (`src/shared/schemas.ts`).

### Database: D1 (SQLite at the edge)
Zero-latency reads, automatic replication, SQL migrations as sequential numbered files in `migrations/`.

### State: KV for caching, R2 for file storage
KV (`CACHE` binding) for session/config caching. R2 (`STORAGE` binding) for generated spawn manifests and assets.

### AI: Workers AI via Vercel AI SDK
Workers AI binding (`AI`) accessed through `workers-ai-provider`, orchestrated by Vercel AI SDK's `streamText`. Spec extraction uses direct Workers AI JSON Mode (`response_format: { type: "json_schema" }`) with Zod validation. Build/feedback phases use `streamText` with tool-calling loop (`stopWhen: stepCountIs(20)`).

### Agents: AIChatAgent (`@cloudflare/ai-chat`)
`SpawnAgent` extends `AIChatAgent` (Durable Object) for AI-driven software generation:
- Built-in message persistence and streaming protocol via `onChatMessage()`
- Structured state via `this.setState()` for spec, files, spawnId, status
- Client connects with `useAgent` (state) + `useAgentChat` (messages/status) from `@cloudflare/ai-chat/react`
- Sandbox tools (write_file, read_file, exec, done) stream as `UIMessage.parts` with lifecycle states
- Streaming loop: `extractSpec` → `buildProjectStream` (sandbox tools) → user feedback → `continueProjectStream`

### Quality
- **Biome** — Linting and formatting (warnings are blockers).
- **Lefthook** — Pre-commit hooks running Biome on staged files.
- **commitlint** — Conventional commit enforcement (`feat:`, `fix:`, `docs:`, etc.).

### Testing: Vitest + @cloudflare/vitest-pool-workers
Behavior-centric test structure (`describe('feature') > describe('given context') > it('behavior')`). Tests run against real Worker runtime.

### CI/CD: GitHub Actions
Automated quality gate on PR. Staging deploy on merge to `main`. Production deploy via `gh workflow run pipeline.yml -f environment=production`.

### Environments
- `local` — Wrangler dev with local D1/KV/R2 simulation
- `staging` — Cloudflare staging deployment (staging.netm8.com)
- `production` — Cloudflare production deployment (netm8.com)
- All environments share the same D1, KV, R2, and AI bindings. Only `ENVIRONMENT` var and worker `name` differ.

## Consequences

- Single deployment unit simplifies operations
- Edge-first architecture means some Node.js APIs unavailable (mitigated by `nodejs_compat`)
- D1 has row/size limits — acceptable for app data, R2 for large objects
- Monolith Worker is simpler to start; can decompose via Service Bindings later
- Durable Objects provide per-session state without external databases
- WebSocket gives real-time progress without polling or SSE
