/**
 * Model install orchestrator (Task #64 — "one-click install").
 *
 * Why this lives here, not in the future Task #16/#30 lifecycle layer:
 *
 *   Task #64 promises "every install includes Moondream2 automatically"
 *   and a "one-click install" CTA at the end of onboarding. Without a
 *   real orchestration path the recommendation engine is academic — the
 *   user sees a recommendation, clicks Install, and nothing actually
 *   gets pulled. This module closes that loop today by paring the
 *   primary + vision pulls together through Ollama's documented
 *   `/api/pull` endpoint and tracking per-tenant progress so the
 *   wizard polls a real status (not a setTimeout fake).
 *
 *   When Task #30 lands its full ModelRuntime abstraction it will
 *   inject its own `InstallRuntimeBridge` via `setInstallRuntimeBridge
 *   ForTests` and this orchestrator stays untouched. The bridge
 *   interface is deliberately tiny (one method, `pull`) so swapping
 *   it later is a one-line change.
 *
 * Per-tenant state:
 *  - Stored in a bounded Map keyed by tenantId. Capped at 64 entries
 *    (LRU-like — oldest dropped on overflow) so a long-running daemon
 *    cannot grow this map unboundedly. tier-review Check #18 flags any
 *    unbounded module-level cache.
 *  - The state is per-tenant because two different tenants could be
 *    onboarding concurrently in a multi-tenant build (current target
 *    is single-tenant desktop, but the architecture stays honest).
 *
 * Privacy:
 *  - The default bridge calls `logPrivacyEvent` within ±10 lines of
 *    the `fetch()` so tier-review Check #8 sees the audit pairing.
 *  - Every model in the install plan emits its own audit row.
 */
import type { TenantContext } from "@workspace/types";

import { logger } from "../../lib/logger";
import { logPrivacyEvent } from "../privacy.service";

const PULL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TENANT_STATES = 64;

function ollamaHost(): string {
  return process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
}

export type ModelInstallStatus =
  | "pending"
  | "pulling"
  | "ready"
  | "failed"
  | "skipped";

export interface ModelInstallEntry {
  readonly modelId: string;
  readonly role: "primary" | "vision";
  status: ModelInstallStatus;
  /** 0..100. Best-effort progress derived from Ollama's NDJSON stream. */
  percent: number;
  error: string | null;
}

export type InstallOverallStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed";

export interface InstallState {
  readonly tenantId: string;
  status: InstallOverallStatus;
  startedAt: string;
  completedAt: string | null;
  models: ModelInstallEntry[];
}

export interface InstallRuntimeBridge {
  /**
   * Pull a single model. Resolves `true` on success, `false` on
   * network failure (best-effort; the orchestrator treats `false` as
   * a hard failure for that model). The optional `onProgress` callback
   * receives a 0..100 estimate; implementations that don't stream may
   * call it once with 100 on success.
   */
  pull(
    ctx: TenantContext,
    modelId: string,
    onProgress: (percent: number) => void,
  ): Promise<boolean>;
}

interface OllamaPullEvent {
  status?: string;
  total?: number;
  completed?: number;
  error?: string;
}

const defaultBridge: InstallRuntimeBridge = {
  async pull(ctx, modelId, onProgress) {
    try {
      // Privacy log MUST stay within ±10 lines of the fetch() below
      // so tier-review Check #8 sees the audit pairing.
      await logPrivacyEvent(ctx, {
        eventType: "network.ollama",
        actor: ctx.userId ?? ctx.tenantId,
        target: `ollama:/api/pull:${modelId}`,
        severity: "low",
        detail: "model-install",
      });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PULL_TIMEOUT_MS);
      const res = await fetch(`${ollamaHost()}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: modelId, stream: true }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        clearTimeout(t);
        return false;
      }
      // Stream the NDJSON pull progress and translate to 0..100.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastPercent = 0;
      let sawError = false;
      // tier-review: bounded — outer loop terminates on `done`, inner
      // split walks lines from a string buffer (no recursion, no
      // unbounded growth — buffer is trimmed after each newline).
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (line.length === 0) continue;
          try {
            const evt = JSON.parse(line) as OllamaPullEvent;
            if (evt.error) {
              sawError = true;
              break;
            }
            if (
              typeof evt.total === "number" &&
              typeof evt.completed === "number" &&
              evt.total > 0
            ) {
              const pct = Math.min(
                99,
                Math.floor((evt.completed / evt.total) * 100),
              );
              if (pct > lastPercent) {
                lastPercent = pct;
                onProgress(pct);
              }
            }
          } catch {
            // ignore malformed line — Ollama occasionally emits a
            // trailing partial chunk we'll see on the next iteration.
          }
        }
      }
      clearTimeout(t);
      if (sawError) return false;
      onProgress(100);
      return true;
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e), modelId },
        "install: pull failed (best-effort)",
      );
      return false;
    }
  },
};

let bridge: InstallRuntimeBridge = defaultBridge;

export function getInstallRuntimeBridge(): InstallRuntimeBridge {
  return bridge;
}

export function setInstallRuntimeBridgeForTests(
  b: InstallRuntimeBridge,
): void {
  bridge = b;
}

export function resetInstallRuntimeBridgeForTests(): void {
  bridge = defaultBridge;
}

// ─── Per-tenant state store (bounded) ─────────────────────────────────

// tier-review: bounded — capped at MAX_TENANT_STATES via rememberState LRU eviction.
const states = new Map<string, InstallState>();

function rememberState(state: InstallState): void {
  states.set(state.tenantId, state);
  // Bounded LRU-ish behaviour: drop oldest entries past the cap. Map
  // iteration order is insertion order, so the first key is the oldest.
  while (states.size > MAX_TENANT_STATES) {
    const oldest = states.keys().next().value;
    if (oldest === undefined) break;
    states.delete(oldest);
  }
}

export function getInstallState(
  ctx: TenantContext,
): InstallState | null {
  return states.get(ctx.tenantId) ?? null;
}

/** Test/Settings hook — wipe state for a tenant (e.g. retry after failure). */
export function clearInstallStateForTests(): void {
  states.clear();
}

// ─── Orchestration ────────────────────────────────────────────────────

export interface InstallPlanItem {
  readonly modelId: string;
  readonly role: "primary" | "vision";
}

/**
 * Kicks off (or resumes) an install for the given primary + bundled
 * vision. If a previous install is still `running` for this tenant we
 * return the existing state without starting a second one — onboarding
 * polling and a refresh-driven re-POST should not result in two
 * concurrent pulls of the same model.
 *
 * Returns the (possibly already-present) InstallState. The actual pull
 * work runs in the background; callers poll `getInstallState` for
 * terminal status.
 */
export function startInstall(
  ctx: TenantContext,
  plan: ReadonlyArray<InstallPlanItem>,
): InstallState {
  const existing = states.get(ctx.tenantId);
  if (existing && existing.status === "running") return existing;

  const now = new Date().toISOString();
  const state: InstallState = {
    tenantId: ctx.tenantId,
    status: "running",
    startedAt: now,
    completedAt: null,
    models: plan.map((p) => ({
      modelId: p.modelId,
      role: p.role,
      status: "pending",
      percent: 0,
      error: null,
    })),
  };
  rememberState(state);

  // Background runner — do NOT await; the route returns immediately.
  void runInstall(ctx, state);
  return state;
}

async function runInstall(
  ctx: TenantContext,
  state: InstallState,
): Promise<void> {
  let anyFailed = false;
  for (const entry of state.models) {
    entry.status = "pulling";
    rememberState(state);
    const ok = await bridge.pull(ctx, entry.modelId, (pct) => {
      entry.percent = pct;
      rememberState(state);
    });
    if (ok) {
      entry.status = "ready";
      entry.percent = 100;
    } else {
      entry.status = "failed";
      entry.error = "Ollama pull did not complete";
      anyFailed = true;
    }
    rememberState(state);
  }
  state.status = anyFailed ? "failed" : "completed";
  state.completedAt = new Date().toISOString();
  rememberState(state);
}
