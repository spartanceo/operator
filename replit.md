# Workspace

## MANDATORY FOR ALL TASK AGENTS

Before writing any code, read BOTH of these planning documents in full:

1. `.local/tasks/OMNINITY_PROJECT_CONTEXT.md` — The authoritative reference for all 60 tasks. Defines the stack, database conventions, API patterns, module boundaries, design system, agent architecture, skill contract, multi-tenancy rules, and build order.
2. `.local/tasks/OMNINITY_BUG_PREVENTION_STANDARDS.md` — Thirteen mandatory bug prevention standards every task must implement. Covers contract-first development, Zod validation, per-task testing, tier review gates, DB transactions, idempotency keys, optimistic locking, circuit breakers, feature flags, the shared types package, performance budgets & benchmarks, security patterns & sandboxing, and scalability & multi-tenant isolation.

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
- `pnpm run tier-review` — run the automated 18-point tier review gate (run after every tier merges before activating the next; includes Standard 11 performance/bundle checks, Standard 12 security checks, and Standard 13 scalability/multi-tenant checks)
- `pnpm run bench` — run all `*.bench.ts` performance benchmarks across the workspace (gated by tier-review Check #9)
- For changes touching auth, credentials, IPC, outbound network, skill execution, or input parsing: run the Replit `security_scan` skill end-to-end before requesting code review (Standard 12 — Pre-Merge Security Scan)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

---

## Task #17 Architectural Notes (Codebase Architecture, Multi-Tenancy & Enterprise Standards)

These conventions were established by Task #17 and apply to every subsequent task. Do not deviate without an architect review.

### Shared packages (build order)

`@workspace/types` → `@workspace/db` → `@workspace/api-zod` → `@workspace/api-client-react` → consumers.

- **`@workspace/types`** — `TenantContext`, `Result`, error envelope shapes. Pure types, no runtime deps. Its `tsconfig.json` MUST include `"types": ["node"]` so `Buffer`/`process` resolve.
- **`@workspace/db`** — Drizzle schema + the multi-tenant helper trio:
  - `tenantScope(ctx, table)` — produces the SQL `WHERE` predicate every query MUST use to enforce tenant isolation (Standard 13). Automatically appends `workspace_id = ctx.workspaceId` when both the table and the context carry one, AND `status != 'erased'` when the table has a `status` column (GDPR soft-delete contract).
  - `withTenant(ctx, table)` — sanctioned alias for `tenantScope` on UPDATE/DELETE WHERE clauses.
  - `withTenantValues(ctx, values)` — INSERT-side companion; stamps `tenantId` (and `workspaceId` when the request carries one) onto a values object. Caller-provided fields win.
  - `assertTenant(ctx, row)` — runtime tenant-isolation guard for hand-written queries / RPC payload validators that bypass `tenantScope`. Throws `TenantIsolationError` (hard error, not catch-and-swallow) when the row's `tenantId` or `workspaceId` doesn't match the request context. Passes `null`/`undefined` rows through.
  - The `tenants` table self-references `tenant_id = id` so every helper is uniform across all tables (no special-case for tenants itself).
- **`@workspace/api-zod`** — orval-generated Zod schemas from `lib/api-spec/openapi.yaml`.
- **`@workspace/api-client-react`** — orval-generated React Query hooks.
- **`@workspace/errors`** — typed error taxonomy + resilience primitives (Task #31 foundation). See "Task #31 Foundation Notes" below.

### orval / OpenAPI codegen rules (CRITICAL — easy to break)

In `lib/api-spec/orval.config.ts`:

1. The `zod` target MUST set `output.indexFiles: false`. Without it, orval rewrites `lib/api-zod/src/index.ts` on every codegen and clobbers the package barrel — TS6305 / "module not found" errors follow.
2. The `zod` target MUST NOT have `schemas: { type: "typescript" }`. Setting it makes orval emit duplicate `export` blocks for the same schema names.
3. Run codegen via `pnpm --filter @workspace/api-spec run codegen`, then `pnpm run typecheck` to confirm.

### Drizzle schema convention (works around tier-review check #5)

The tier-review schema-index checker uses regex `/pgTable\(..., \{([^}]+)\}/gs` which stops at the first `}`. **Schemas MUST NOT use inline option objects** inside the column definitions block, including:

- `timestamp("col", { withTimezone: true })`  — use bare `timestamp("col")`. Add timezone in the migration layer (Task #37).
- `.references(() => other.id, { onDelete: "cascade" })` — use bare `.references(() => other.id)`. Add cascade in the migration layer.

If you need these options, add them in raw SQL migrations rather than in the Drizzle schema file. The runtime behaviour is unchanged because Drizzle does not enforce these client-side.

### api-server middleware order (`artifacts/api-server/src/app.ts`)

Order is load-bearing — do not reshuffle without understanding why:

1. `helmet` (with locked CSP from `lib/security`)
2. `cors` with explicit allowlist (NEVER `*` or `true` — Standard 12)
3. `requestId()` — assigns nanoid trace id to `res.locals.requestId`
4. `pinoHttp` — bound to the request id via `customProps`
5. `defaultLimiter` — coarse 600 req/min global cap
6. Body parsers with `limit: "1mb"` caps
7. `tenantContext()` — populates `AsyncLocalStorage` from `X-Tenant-ID` / `X-Workspace-ID` / `X-User-ID` headers (auth in Task #4 will replace headers with JWT-derived context here, leaving every other route unchanged)
8. `app.use("/api", router)`
9. `notFoundHandler()` — **MUST be a 3-arg `RequestHandler`**. Express treats any 4-arg middleware as an error handler and only invokes it when an error is forwarded; if you make this 4-arg, every thrown route error surfaces as a 404 instead of reaching the real error handler.
10. `errorHandler()` — 4-arg `ErrorRequestHandler`, the canonical envelope catch-all. Internal error details are NEVER returned to the client (Standard 12 secret leakage); they are logged with the request id.

### Tenant context plumbing

- `lib/tenant-context.ts` exposes `runWithTenantContext(ctx, cb)`, `getTenantContext()`, `requireTenantContext()` backed by `AsyncLocalStorage`.
- Route handlers retrieve context via `requireTenantContext()` rather than reading headers directly. This is what lets the auth migration in Task #4 be a single-file change.
- Routes that require a tenant attach the `requireTenant()` middleware so the 401 short-circuit happens before the handler runs.

### Rate limiters (`artifacts/api-server/src/middlewares/rate-limit.ts`)

- `defaultLimiter` — global, 600/min.
- `adminLimiter` — 5/min on the GDPR routes (`/api/admin/tenant-data` GET + DELETE) because they are expensive and destructive.
- Auth (Task #4) and LLM (Task #5) routes will add their own limiters; do not loosen these existing two.

### GDPR admin routes

- `GET /api/admin/tenant-data` — returns the tenant snapshot via `exportTenantData(ctx)`.
- `DELETE /api/admin/tenant-data` — soft-deletes the tenant via `eraseTenantData(ctx)` and returns an erasure receipt.
- Both flow through `adminLimiter` then `requireTenant()`. They will return `500 INTERNAL` until Task #37 (DB Migrations) creates the actual `tenants` / `workspaces` tables in the running database — the route plumbing itself is verified working.

### Pre-existing failures NOT to fix in Task #17

The tier-review reports 3 failures that are out of scope for Task #17:

- `chart.tsx` hardcoded hex colours + unsanitised `dangerouslySetInnerHTML` — owned by Task #2 (Design System).
- `path-to-regexp` high CVE — owned by Task #16 (Dependency Hygiene).

---

## Task #31 Foundation Notes (Error Handling & Graceful Degradation)

The `@workspace/errors` package shipped Step 1 (taxonomy), part of Step 5 (disk monitor), and part of Step 6 (user-message catalog) of Task #31. Every other task should consume these primitives instead of inventing local equivalents.

### What lives in `@workspace/errors`

- **`DomainError`** + 9 domain subclasses (`RuntimeError`, `ToolError`, `StorageError`, `NetworkError`, `PermissionError`, `IntegrationError`, `ValidationError`, `AuthError`, `ModelError`) and 8 specialised errors (`TimeoutError`, `CircuitOpenError`, `OllamaUnavailableError`, `ModelOutOfMemoryError`, `DiskSpaceLowError`, `FileNotFoundError`, `RateLimitedError`, `OAuthExpiredError`). Each pins a stable `code` + HTTP `status` + `expose` flag.
- **`getUserMessage(code)`** — single read path for any code → `{ message, action, severity }`. UI/notifications/error mapper NEVER inline message strings. A test enforces no `SCREAM_CASE` leaks into user-facing messages and that every default code emitted by the taxonomy has a catalog entry.
- **`TIMEOUTS`** — Standard 8 constants (Ollama 60s/3s, Stripe 10s, Resend 5s, IPC 5s, skill 30s, LAV 15s, HTTP 10s, DB 5s). Add new entries here, never inline magic numbers at call sites.
- **`withTimeout(promise, ms, opts)`** — fail-fast race wrapper, optional `onTimeout` cancellation hook (errors swallowed so the `TimeoutError` is never masked).
- **`withRetry(fn, opts)`** — exponential backoff with jitter. Default policy retries network/runtime/integration/timeout errors; refuses to retry `validation`, `auth`, `permission`, `tenant`, `tool` (deterministic failures). `sleep`/`onRetry` are injectable for tests.
- **`CircuitBreaker`** — in-house, dependency-free (no `opossum` dep). Three states (closed/open/half-open), rolling-window stats with `volumeThreshold` gating, optional fallback. Composes orthogonally with `withTimeout` — the breaker does NOT add its own timeout.
- **`DiskMonitor`** — `fs.statfs` wrapper, returns `ok`/`warning`/`critical`/`unknown` against 2 GB / 500 MB thresholds. Refuses inverted threshold configs at construction time.
- **`toApiError(unknown)`** — universal mapper to `{ code, message, status, details?, cause }`. `DomainError.message` only passes through when `expose === true`; otherwise the catalog message is used. Express-style `{ status, expose, code }` errors are honoured. Truly unknown values collapse to `INTERNAL` / 500 / safe catalog message — secrets never leak (Standard 12). The original error is preserved on `cause` for logging.

### Rules for downstream tasks

1. Every external call MUST use a `TIMEOUTS` constant. No naked `await fetch(...)` without a timeout wrapper.
2. Every external service that can be flaky should be wrapped in a `CircuitBreaker` with a registered fallback so one external failure never cascades.
3. Throw `DomainError` subclasses (or specialised errors) — never throw plain `Error` from request handlers or service layers. Plain throwables collapse to `INTERNAL` and lose all signal in logs and the UI.
4. Never inline user-facing error strings. If a new error code is needed, add it to `error-catalog.ts` first.
5. The api-server's `error-handler.ts` will eventually call `toApiError` to do the conversion (deferred — it would require re-opening Task #17). Until then, throwing a `DomainError` from a handler still works because the existing handler honours `e.status` / `e.code`, but the user-facing message will be the raw message rather than the catalog message.

### Out of scope for the @workspace/errors package

These belong to dependent tasks that will consume the primitives, not re-implement them:

- Ollama-specific error UI / setup card → Task #30 (Model Runtime).
- Per-step task pause/resume controls → Task #38 + Task #50.
- OAuth re-auth flow / retry queues → Task #21 (Integrations).
- Notification-centre escalation → Task #2 (Frontend Web App).
- DB integrity check / KB rebuild → Task #57 + Task #37.
