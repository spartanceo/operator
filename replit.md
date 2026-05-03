# Overview

This project is a pnpm workspace monorepo using TypeScript, designed to build a robust and scalable application. Its primary purpose is to provide a reliable backend API with a strong focus on multi-tenancy, enterprise standards, and a deterministic agent-based system. Key capabilities include a SQLite-backed API server, a multi-stage agent loop, a tool registry, an approval system, comprehensive privacy logging, and local authentication. The vision is to deliver a high-performance, secure, and maintainable platform.

# User Preferences

I expect all task agents to strictly adhere to the planning documents located at `.local/tasks/OMNINITY_PROJECT_CONTEXT.md` and `.local/tasks/OMNINITY_BUG_PREVENTION_STANDARDS.md`. These documents are the single source of truth, and no deviations are permitted without explicit architect review.

# System Architecture

The system is built on a pnpm workspace monorepo, utilizing Node.js 24 and TypeScript 5.9. The API is powered by Express 5, with data managed by SQLite and Drizzle ORM. Zod is used for validation, and Orval handles API codegen from an OpenAPI specification. The build process uses esbuild.

## Core Architectural Patterns

- **Monorepo Structure**: Organized into shared packages with a defined build order.
- **Multi-Tenancy**: Enforced at the database level using helper functions for tenant isolation.
- **API Codegen**: Orval generates Zod schemas and React Query hooks from `openapi.yaml`.
- **Drizzle Schema Convention**: Strict rules for Drizzle schema definitions for compatibility with tier-review.
- **API Server Middleware**: A carefully ordered middleware stack handles security, logging, rate limiting, tenant context, and error handling.
- **Tenant Context Plumbing**: `AsyncLocalStorage` manages tenant context.
- **Rate Limiting**: Implemented with global and admin-specific limiters.
- **Error Handling**: A comprehensive error taxonomy with user-facing messages, timeouts, retries, and circuit breakers.
- **Agent System**: A deterministic 6-stage agent loop (Router → Planner → Executor → Verifier → Research → Memory) for complex operations.
- **Tool Registry**: A centralized registry of 15 tools with risk levels influencing approval flows.
- **Privacy Logging**: Every outbound `fetch()` operation is bracketed by privacy logging.
- **Filesystem Sandboxing**: Restricts file operations to a dedicated workspace-specific directory.
- **Authentication**: Managed via `bcryptjs`, `express-session`, and a DB-backed `sessions` table.
- **Database Schema**: SQLite with 19+ tenant-scoped tables, including `tenants`, `workspaces`, `users`, `sessions`, `memories`, `agent_runs`, `messages`, `tool_calls`, `approvals`, `privacy_events`, `onboarding_profiles`, `model_preferences`, knowledge-base tables, media assets, legal compliance tables, and integrations.
- **Integrations**: `/api/integrations/*` exposes a static catalogue of 18 connectors with encrypted credentials.
- **Onboarding & Updates**: A 4-step wizard for onboarding and an update check mechanism.
- **Platform Distribution & Code Signing (Task #27)**: Uses electron-builder for macOS and Windows code signing, notarization, and entitlements management. Provides API endpoints for build attestation and OS permission management.
- **Hardware-Aware Model Recommendation (Task #64)**: Manages a data-driven model catalogue, recommendation engine, and vision companion lifecycle.
- **Knowledge Base (Task #12)**: A local second-brain with deterministic FNV-1a hash-bucket TF-IDF embeddings, sentence-aware chunking, hybrid search, and URL ingest.
- **Media Generation Pipeline (Task #10)**: Local image/audio/video generation with hardware-dependent model selection and tool registration for agent use.
- **Multi-Task Queue (Task #38)**: A persistent queue of agent runs with concurrency control, priority, and task context validation.
- **Legal & Compliance (Task #25)**: Manages static legal documents, an append-only consent ledger, incident reporting, and age verification.
- **Backups & Data Portability (Task #20)**: Provides AES-256-GCM-encrypted local archives with schema versioning, scheduling, retention, and cloud stub functionality.
- **UI/UX**: `chart.tsx` uses hardcoded hex colors and `dangerouslySetInnerHTML`, slated for refactoring.
- **No-Code Skill Creator & Store (Task #4)**: A wizard for creating skills, a local LLM tester, and a hosted skill store with publishing and installation capabilities.
- **Referral & Growth Mechanics (Task #35)**: Implements referral codes, rewards, acquisition channels, share events, task satisfaction ratings, creator profiles, and enterprise trial invites.
- **Developer SDK & Plugin API (Task #14)**: An in-process event bus, custom tool registration, outbound webhook subscriptions, and an SDK for client interaction and CLI tools.
- **Accessibility & i18n (Task #28)**: WCAG 2.1 AA foundations, global CSS rules, and `react-i18next` for internationalization with locale detection and translation key parity checks.

## Testing & QA Pipeline (Task #18)

The QA stack is split into independent, composable scripts so any single check can run in isolation (locally, in CI, or as a pre-commit hook). All tooling is zero-dep — no vitest, c8, or Jest — built directly on `node:test`, `tsx`, and Node's built-in V8 coverage capture.

- **Lint** — `pnpm lint` runs `prettier --check` on the QA-pipeline source files and any other path opted in via `LINT_SCOPE` in `scripts/src/lint.ts`. The full codebase is not yet prettified (~250 legacy files would need a dedicated reformat commit); the scope is whitelist-based so new files stay clean from day one. `pnpm lint --fix` auto-formats. The structural half of "lint" (no `console.log`, no hex colours, no raw fetch, no `eval`, no `dangerouslySetInnerHTML`, no raw SQL, no unbounded module-level caches, schema invariants) is enforced by tier-review.
- **Unit / integration tests** — `pnpm test` runs every package's `test` script. The api-server runs both `test-runner.ts` (53+ integration cases) and `security.test.ts` (11 dedicated security regression cases: auth bypass, cross-tenant isolation on memory + agent runs, sandbox escape via `..` / absolute / NUL byte, prompt-injection rejection, approval bypass, admin rate-limit headers).
- **Performance benchmarks** — `pnpm bench` runs every package's `bench` script via the in-house `@workspace/scripts/bench-runner` helper. It emits `.bench-results.json` in vitest's `{files:[{tasks:[{name,result:{benchmark:{mean,p95}}}]}]}` shape so `tier-review` Check #9 can enforce `/** @budget Nms */` annotations directly above each `bench(...)` call. Currently covers `lib/db` (cursor encode/decode, `tenantScope` SQL build, `buildPage`) and `lib/errors` (`withTimeout`, `defaultShouldRetry`, `toApiError`).
- **Coverage** — `pnpm coverage` spawns each package's tests with `NODE_V8_COVERAGE` set, walks the per-process v8 JSON, computes line + function coverage from byte offsets, and writes `coverage/summary.{json,md}`. `pnpm coverage:check` enforces `COVERAGE_MIN_PCT` (default 80%) on `lib/**` packages. `@workspace/types` is excluded from the gate because it is almost entirely TypeScript declarations that erase at runtime.
- **Flaky test detector** — `pnpm flaky-detect` runs `pnpm test` per package N times (default 5) and flags any package whose result flips. Outputs `coverage/flaky.md` (human-readable) and `coverage/quarantine.json` (machine-readable list of quarantined packages with flake rate + timestamp, ready for CI annotations or dashboard ingestion). Wired as a nightly CI cron job, not a PR blocker.
- **Tier review** — `pnpm tier-review` runs the 21-check quality gate (typecheck, tests, no `console.log`, schema invariants, OpenAPI envelope, codegen-in-sync, generated `.d.ts` in sync, fetch privacy logs, perf budgets, bundle size, dangerous primitives, `dangerouslySetInnerHTML`, dependency audit, raw-SQL, tenant scoping, pagination envelope, required indexes, unbounded caches, translation key parity, axe-core accessibility). Append-only/audit-class tables are exempt from the `version` column requirement via `VERSION_EXEMPT_KEYWORDS` (audit, append, log, history, journal, event, invocation, screening, document, notice, collection) in `scripts/tier-review.ts`.
- **Audit-log concurrency** — `services/audit.service.ts` serialises `appendAuditEntry` per tenant via an in-process `Promise`-chain mutex (`tenantAppendLocks` Map keyed by `tenantId`). The hash chain's `readTip` + INSERT pair must be atomic; without serialisation, two concurrent appenders both read sequence N and both insert at N+1, producing duplicate sequence numbers and breaking `verifyAuditChain`. The mutex prunes its Map entry when the last waiter completes (identity-check on the materialised tail promise), so steady-state size is "tenants with an in-flight append", not "tenants ever seen". Local-first single-process scope only — multi-process deployments would need a DB-level unique `(tenant_id, sequence)` constraint instead.
- **QA orchestrator** — `pnpm qa` runs typecheck → lint → tests → coverage:check (optional, doesn't bail) → tier-review and prints a single coloured pass/fail summary. Supports `--skip=stage` and `--only=stage`.
- **CI** — `.github/workflows/ci.yml` runs typecheck, lint, tests, coverage, coverage:check, and tier-review on every PR with Node 24 + pnpm 10, uploads `coverage/` as an artifact, and appends `coverage/summary.md` to the PR's GitHub step summary. A separate nightly cron job (03:17 UTC) runs the flaky-test detector and uploads `coverage/flaky.md` + `coverage/quarantine.json`.
- **Voice Interface (Task #9)**: `/api/voice/{transcribe,synthesize,voices}` provides a Tier 1 stub Whisper-style STT (deterministic transcript) and a real WAV PCM16 TTS engine. Frontend `lib/voice-engine.ts` exposes `useVoiceRecorder` (MediaRecorder + AnalyserNode meter + Web Speech live captions), `useVoicePlayer` (HTMLAudioElement + interrupt), and `useWakeWord` (continuous SpeechRecognition). Chat page exposes mic button, waveform, voice-mode toggle and wake-word triggered capture; Settings exposes voice + speed + autoplay + wake-word controls and a preview button. All endpoints return the canonical envelope and are privacy-logged.
- **Universal App Understanding & Capability Indexer (Task #70)**: Per-(tenant, app) capability profiles fused from four sources — OS-native introspection (seeded scan), public docs, MCP connector tool lists, and community App Skills (`skills.target_app_id`). Schema: `app_profiles`, `app_capability_commands` (kind: command|menu|shortcut|mcp_tool|skill_action), `app_mcp_connections`, `app_doc_ingestions` (migration 0050; all tables tenant/workspace-scoped with covering indexes). Service `services/app-capability.service.ts` is feature-flagged (`FEATURE_APP_CAPABILITIES`, default on in dev), uses an LRU cache (256 entries, 60s TTL) and `tenantScope` everywhere. Routes under `/api/apps`: `GET /feature`, `GET /` (paginated `{items, nextCursor}`), `POST /scan` (idempotent — re-running never duplicates a profile), `GET /:id`, `GET /:id/commands` (filterable by kind), `POST /:id/deep-learn`, `POST /:id/mcp/connect|disconnect` (mirrors connector tools as `mcp_tool` commands), `POST /:id/install-skill` (stamps `target_app_id` on the skill row, adds a `skill_action` command). `summariseCapabilitiesForAgent()` exposes a planner-ready snapshot used by the agent layer. Bench `app-capability.bench.ts`: planner summary 0.27ms / list 0.26ms (budgets 50ms / 25ms). Drift: frontend Apps panel deferred — no clean mount point in `omninity-website` yet.
- **Context Window Management (Task #51)**: `services/context.service.ts` sizes each model's context window (regex map: llama3.1=128k, claude=200k, gpt-4o=128k, default=4k), estimates tokens (char/4), enforces pinned-message survival and a `context_reset_ts` cutoff, and triggers rolling summarisation at 75% usage with a deterministic fallback when the runtime is unavailable. New endpoints: `GET /api/conversations/:id/context`, `POST /api/conversations/:id/context/reset`, `POST|DELETE /api/conversations/:id/messages/:msgId/pin`, `POST /api/context/chunk`. `POST /api/chat` accepts `conversationId` and returns 413 with `code: CONTEXT_OVERFLOW` plus a usage payload when the prompt would overflow. Chat UI shows a `<ContextUsageBar/>` (token bar with green/amber/red ramp, pinned-count badge, summary badge, Reset-context button) and per-row pin/unpin buttons; rolled summaries render as a dashed amber banner.

# External Dependencies

- **Database**: SQLite (`better-sqlite3`)
- **ORM**: Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API Codegen**: Orval
- **Authentication**: `bcryptjs`, `express-session`
- **Logging**: `pinoHttp`
- **Security**: `helmet`, `cors`
- **Other Utilities**: `nanoid`, `path-to-regexp` (noted for high CVE)