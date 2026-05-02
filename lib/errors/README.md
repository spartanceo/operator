# @workspace/errors

Resilience primitives and the typed error taxonomy for Omninity Operator.

This package owns the **Step 1, parts of Step 5, and parts of Step 6** of Task #31
(Error Handling & Graceful Degradation):

- A typed error taxonomy (`DomainError` + domain subclasses) so every failure
  has a stable `code`, an HTTP status, and a plain-English user-facing message.
- A user-facing message catalog (`getUserMessage(code)`) — every error code
  registered here resolves to a sentence in plain English plus a suggested
  recovery action. No raw stack traces or jargon ever reach the UI.
- Resilience primitives that every external call must use:
  - `withTimeout(promise, ms)` — fail fast, never hang.
  - `withRetry(fn, opts)` — exponential backoff with jitter.
  - `CircuitBreaker` — open after configurable failure threshold; trip closed
    after a reset timeout. In-house, dependency-free implementation.
- `TIMEOUTS` — the canonical timeout constants from Standard 8 of the project
  context. Define once, use everywhere.
- `DiskMonitor` — a small wrapper around `fs.statfs` that exposes "ok",
  "warning" (<2 GB free), and "critical" (<500 MB free) states.
- `toApiError(err)` — converts any thrown value into the `{ code, message,
  status }` triple the API envelope helper consumes. Internal errors collapse
  to `INTERNAL` / "Internal server error" so secrets cannot leak (Standard 12).

## What this package intentionally does NOT own

These belong to later tasks because they require subsystems that do not yet
exist:

- Ollama-specific error UI / setup card → Task #30 (Model Runtime).
- Per-step task pause/resume controls → Task #38 (Task Queue) + Task #50
  (Multi-Agent Orchestration).
- OAuth re-auth flow / retry queues → Task #21 (Integrations).
- Notification centre escalation for repeated errors → Task #2 (Frontend Web App).
- Database integrity check / KB rebuild → Task #57 (Knowledge Base) and
  the migrations layer (Task #37).

Each of those tasks consumes the primitives in this package. They do not
re-implement them.

## Importing

```ts
import {
  TIMEOUTS,
  withTimeout,
  withRetry,
  CircuitBreaker,
  DomainError,
  RuntimeError,
  toApiError,
  getUserMessage,
} from "@workspace/errors";
```
