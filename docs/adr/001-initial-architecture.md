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

### Frontend: React 19 + Vite 7
Minimal, fast, widely understood by AI agents. Vite provides HMR and optimized builds.

### Database: D1 (SQLite at the edge)
Zero-latency reads, automatic replication, SQL migrations as code.

### State: KV for caching, R2 for file storage
KV for session/config caching. R2 for user uploads and generated assets.

### AI: Workers AI binding
Direct model access without external API calls. Low latency, pay-per-use.

### Testing: Vitest + @cloudflare/vitest-pool-workers
Behavior-centric test structure. Tests run against real Worker runtime.

### CI/CD: GitHub Actions
Automated quality gate on PR, staging deploy on merge to `main`, production deploy on release tag.

### Environments
- `local` — Wrangler dev with local D1/KV/R2 simulation
- `staging` — Cloudflare staging deployment (staging.netm8.com)
- `production` — Cloudflare production deployment (netm8.com)

## Consequences

- Single deployment unit simplifies operations
- Edge-first architecture means some Node.js APIs unavailable (mitigated by `nodejs_compat`)
- D1 has row/size limits — acceptable for app data, R2 for large objects
- Monolith Worker is simpler to start; can decompose via Service Bindings later
