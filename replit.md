# Workspace

## MANDATORY FOR ALL TASK AGENTS

Before writing any code, read BOTH of these planning documents in full:

1. `.local/tasks/OMNINITY_PROJECT_CONTEXT.md` — The authoritative reference for all 60 tasks. Defines the stack, database conventions, API patterns, module boundaries, design system, agent architecture, skill contract, multi-tenancy rules, and build order.
2. `.local/tasks/OMNINITY_BUG_PREVENTION_STANDARDS.md` — Ten mandatory bug prevention standards every task must implement. Covers contract-first development, Zod validation, per-task testing, tier review gates, DB transactions, idempotency keys, optimistic locking, circuit breakers, feature flags, and the shared types package.

These two documents are the single source of truth. Do not deviate from them.

---

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: SQLite + Drizzle ORM (better-sqlite3) — the existing `lib/db/` package uses a PostgreSQL boilerplate driver that Task #1 (Backend Foundation) will replace with SQLite
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm run tier-review` — run the automated 8-point tier review gate (run after every tier merges before activating the next)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
