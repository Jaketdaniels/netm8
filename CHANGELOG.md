# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- AI Elements registry (shadcn/ui + Vercel AI Elements) for consistent frontend components
- Tailwind CSS v4 with dark theme CSS variables and `@/` path alias
- Policy-as-code documentation linter (`scripts/lint-docs.mjs`)
- CHANGELOG.md enforced by docs linter

### Changed
- Rewrote all frontend routes to use Tailwind classes + shadcn/AI Elements components
- Updated ADR 001 to reflect current architecture (Hono, TanStack, Agents SDK, Tailwind, etc.)
- `0003_drop_dead_columns` — reconciled database schema: dropped dead columns (`spawns.stage`, `spawns.architecture`, `spawn_files.stage`) and `spawn_stages` table
- Replaced spawn engine JSON operations with tool-calling agent loop using Cloudflare Sandbox SDK
- `0004_add_build_log` — added `build_log` column to `spawns` table for real sandbox execution output
- **Migrated SpawnAgent from base `Agent` to `AIChatAgent`** (`@cloudflare/ai-chat`) — built-in message persistence, streaming protocol, tool call lifecycle states
- Replaced `generateText` with Vercel AI SDK `streamText` + `stopWhen: stepCountIs()` for multi-step sandbox tool loops
- Frontend spawn page now uses `useAgentChat` for messages/status and `useAgent` for structured state (hybrid model)
- Removed `AgentStep` type — tool calls are now `UIMessage.parts` with states (`input-streaming` → `input-available` → `output-available`)
- Updated all Cloudflare SDKs: `@cloudflare/vitest-pool-workers` 0.12.18, `wrangler` 4.69.0, `shiki` 4.0

### Fixed
- Template component type errors: `appendChild`, `Shimmer` children, ES2023 lib
- Stale biome-ignore suppression comments in AI Elements templates
- Biome CSS parse errors with Tailwind v4 directives

## [0.1.0] - 2026-02-26

### Added
- Fullstack Cloudflare Workers application (React 19 + Vite 7 + Hono)
- `0001_initial_schema` — users table with email uniqueness
- `0002_spawn_tables` — spawns, spawn_files, spawn_stages tables
- SpawnAgent Durable Object with iterative AI operations loop
- Workers AI integration with JSON Mode + Zod validation
- TanStack Router file-based routing with auto code-splitting
- TanStack Query for server state management
- Hono RPC client for end-to-end type-safe API calls
- Vitest + @cloudflare/vitest-pool-workers for behavior-centric testing
- GitHub Actions CI/CD pipeline with quality gate + deploy
- Biome lint/format with Lefthook pre-commit hooks
- Conventional commits enforced via commitlint
