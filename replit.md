# Overview

This is a pnpm workspace monorepo using TypeScript, designed to build a robust and scalable application. The project aims to provide a reliable backend API with a focus on multi-tenancy, enterprise standards, and a deterministic agent-based system. Key capabilities include a SQLite-backed API server, a multi-stage agent loop, a tool registry, an approval system, comprehensive privacy logging, and local authentication.

The core vision is to deliver a high-performance, secure, and maintainable platform.

# User Preferences

I expect all task agents to strictly adhere to the planning documents located at `.local/tasks/OMNINITY_PROJECT_CONTEXT.md` and `.local/tasks/OMNINITY_BUG_PREVENTION_STANDARDS.md`. These documents are the single source of truth, and no deviations are permitted without explicit architect review.

# System Architecture

The system is built on a pnpm workspace monorepo, utilizing Node.js 24 and TypeScript 5.9. The API is powered by Express 5, with data managed by SQLite and Drizzle ORM. Zod is used for validation, and Orval handles API codegen from an OpenAPI specification. The build process uses esbuild.

## Core Architectural Patterns

- **Monorepo Structure**: Organized into shared packages with a defined build order: `@workspace/types` → `@workspace/db` → `@workspace/api-zod` → `@workspace/api-client-react` → consumers.
- **Multi-Tenancy**: Enforced at the database level using `tenantScope`, `withTenant`, and `withTenantValues` helpers. `assertTenant` provides runtime isolation for hand-written queries.
- **API Codegen**: Orval generates Zod schemas and React Query hooks from `openapi.yaml`, with specific configuration rules to prevent build issues.
- **Drizzle Schema Convention**: Strict rules for Drizzle schema definitions to ensure compatibility with tier-review checks, avoiding inline options in column definitions.
- **API Server Middleware**: A carefully ordered middleware stack in `artifacts/api-server/src/app.ts` handles security, logging, rate limiting, tenant context, and error handling.
- **Tenant Context Plumbing**: `AsyncLocalStorage` manages tenant context, retrieved via `requireTenantContext()` in route handlers, facilitating a single-file change for authentication migration.
- **Rate Limiting**: Implemented with `defaultLimiter` (global) and `adminLimiter` (specific to GDPR routes).
- **Error Handling**: The `@workspace/errors` package provides a comprehensive error taxonomy, `getUserMessage` for user-facing messages, `TIMEOUTS` constants, `withTimeout` for fail-fast operations, `withRetry` for exponential backoff, and an in-house `CircuitBreaker`. `toApiError` provides universal error mapping.
- **Agent System**: A deterministic 6-stage agent loop (Router → Planner → Executor → Verifier → Research → Memory) handles complex operations.
- **Tool Registry**: A centralized registry of 15 tools with risk levels that gate the approval flow.
- **Privacy Logging**: Every outbound `fetch()` is bracketed by `logPrivacyEvent()`.
- **Filesystem Sandboxing**: `lib/sandbox.ts` restricts file operations to a dedicated workspace-specific directory, preventing path traversal and symlink attacks, and capping read/write sizes.
- **Authentication**: `bcryptjs`, `express-session`, and a DB-backed `sessions` table manage user authentication.
- **Database Schema**: SQLite with 15 tenant-scoped tables — `tenants`, `workspaces`, `users`, `sessions`, `memories`, `agent_runs`, `messages`, `tool_calls`, `approvals`, `privacy_events`, `onboarding_profiles`, `model_preferences` (singleton-per-tenant primary-model + vision-lifecycle config), plus the Task #12 knowledge-base tables `kb_collections`, `kb_documents`, `kb_chunks`.
- **Onboarding & Updates**: `/api/onboarding/{profile,hardware,starter-tasks}` powers a 4-step wizard rendered at the operator shell when no completed profile exists. Hardware is probed via `os.*` with an `OMNINITY_HARDWARE_OVERRIDE` env seam for tests; the recommendation engine maps RAM/Apple-Silicon tier to a static MODEL_CATALOGUE. `/api/updates/check` compares `npm_package_version` to `OMNINITY_LATEST_VERSION` (env-driven seam for the future update server). The chat surface ships starter-task chips, a one-time first-approval tooltip, and a success-sparkle on first agent completion.
- **Hardware-Aware Model Recommendation (Task #64)**: `services/hardware/` owns the data-driven model catalogue (Phi-3 Mini → Mistral 7B / Qwen Coder 7B → Llama 3.1 8B → Llama 3.1 70B + Moondream 2 vision companion), the pure recommendation engine (`buildModelInstallPlan` / `evaluateMinimumSpec`), the in-process hardware cache, the vision-companion lifecycle state machine (aggressive/balanced/warm idle-timeout policy), and the singleton-per-tenant `model_preferences` service. Surfaced through `/api/models/{hardware,catalogue,recommended,select}`. The wizard's model step renders the recommended primary, alternative options keyed by use-case axis (writing/code/balanced), the bundled vision companion with idle-timeout toggle, total install size, and a min-spec screen when no model fits the host.
- **Knowledge Base (Task #12)**: Local second-brain with deterministic FNV-1a hash-bucket TF-IDF embeddings (256-dim, L2-normalised, no ML deps), sentence-aware chunking with overlap, sha256 dedupe, hybrid search (0.6·cosine + 0.4·Jaccard text overlap) with citations, collections/tags, URL ingest with `logPrivacyEvent` + `withTimeout` + AbortController + 1 MB cap + SSRF guard, and JSON export/import. RAG: `CreateAgentRunRequest.useKnowledgeBase` retrieves top-k snippets and injects them as a `system` message before the agent loop runs (best-effort — failures are swallowed). Routes mounted at `/api/knowledge`. UI lives at `/knowledge` in the operator app.
- **Tier-1 KB scope**: only `text`, `url`, and `youtube`-placeholder source types are wired; binary parsers (PDF, DOCX, EPUB, PPTX, CSV) are deferred until ML deps are introduced.
- **UI/UX**: `chart.tsx` uses hardcoded hex colors and `dangerouslySetInnerHTML`, which is slated for refactoring in Task #2 (Design System).

# External Dependencies

- **Database**: SQLite (via `better-sqlite3`)
- **ORM**: Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API Codegen**: Orval
- **Authentication**: `bcryptjs`, `express-session`
- **Logging**: `pinoHttp`
- **Security**: `helmet`, `cors`
- **Other Utilities**: `nanoid` (for request IDs), `path-to-regexp` (noted for high CVE, to be addressed by Task #16)