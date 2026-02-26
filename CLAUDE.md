# NetM8

Fullstack Cloudflare Workers application — React 19 + Vite frontend, Worker backend.
Domain: netm8.com

## Architecture

- `src/` — React frontend (Vite, TypeScript)
- `worker/` — Cloudflare Worker backend (API routes)
- `migrations/` — D1 database migrations (sequential numbered SQL files)
- `tests/` — Behavior-centric tests (Vitest + Cloudflare Workers pool)
- `docs/` — Architecture Decision Records and technical docs
- `.github/workflows/` — CI/CD pipelines

## Stack

| Layer          | Technology                        |
| -------------- | --------------------------------- |
| Frontend       | React 19, Vite 7, TypeScript 5.9  |
| Backend        | Cloudflare Worker                  |
| Database       | Cloudflare D1 (SQLite)            |
| Cache          | Cloudflare KV                     |
| Storage        | Cloudflare R2                     |
| AI             | Workers AI binding                |
| Testing        | Vitest + @cloudflare/vitest-pool-workers |

## Commands

| Task                    | Command                                    |
| ----------------------- | ------------------------------------------ |
| Dev server              | `npm run dev`                              |
| Dev with local bindings | `npm run dev:worker`                       |
| Build                   | `npm run build`                            |
| Test                    | `npm run test`                             |
| Test watch              | `npm run test:watch`                       |
| Lint                    | `npm run lint`                             |
| Type check              | `npm run typecheck`                        |
| Generate CF types       | `npm run cf-typegen`                       |
| Deploy staging          | `npm run deploy:staging`                   |
| Deploy production       | `npm run deploy:production`                |
| New migration           | `wrangler d1 migrations create netm8-db <name>` |
| Apply migrations local  | `wrangler d1 migrations apply netm8-db --local`  |
| Apply migrations remote | `wrangler d1 migrations apply netm8-db --remote` |

## Conventions

- **Wrangler config**: `wrangler.jsonc` (never `.toml`)
- **Environments**: `staging` and `production` defined in wrangler.jsonc
- **Migrations**: Sequential numbered SQL files in `migrations/`
- **API routes**: Worker handles `/api/*`, static assets served for everything else
- **Testing**: Behavior-centric — describe what the system does, not implementation details
  - Pattern: `describe('feature') > describe('given context') > it('expected behavior')`
- **Commits**: Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `refactor:`)
- **Quality gate**: Warnings are blockers — fix before feature work

## Environment Variables

- `.dev.vars` — Local development secrets (git-ignored)
- `.dev.vars.example` — Template for local secrets (committed)
- Secrets set via `wrangler secret put <NAME>` for staging/production

## Port Assignments (Slot 1)

| Service | Port |
| ------- | ---- |
| API     | 8781 |
| Web     | 4321 |
