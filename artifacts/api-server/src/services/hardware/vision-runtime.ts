/**
 * Vision-runtime bridge — the actual Ollama load/unload calls that the
 * `vision-lifecycle` state machine fires on touch / idle-unload.
 *
 * Why this lives here (not in the future Task #30 ModelRuntime):
 *
 *   Task #64 "Done looks like" line 22: "The vision model is loaded on
 *   demand when a desktop control task starts (within ~2 seconds on
 *   Apple Silicon) and unloaded after a configurable idle timeout to
 *   free RAM." This is a user-visible runtime guarantee — the policy
 *   state machine alone doesn't satisfy it. We therefore implement the
 *   minimum viable runtime bridge here: two POSTs to Ollama's
 *   `/api/generate` with `keep_alive` set (load = "24h", unload = 0),
 *   which is the documented Ollama pattern for residency control
 *   (see `docs.ollama.com` keep_alive parameter).
 *
 *   When Task #30 lands its full ModelRuntime abstraction, this module
 *   becomes a thin shim that delegates to that runtime — the bridge
 *   interface stays intact so vision-lifecycle.ts is unaffected. The
 *   `setVisionRuntimeBridgeForTests` seam is the same hook Task #30
 *   will use to plug in the abstracted runtime in production.
 *
 * Network-call semantics:
 *  - Best-effort: failures (Ollama not running, transient 5xx, timeout)
 *    log a warn and resolve `false`. The state machine treats this as
 *    "we asked, can't be sure". Never throws — vision residency must
 *    not block the rest of the API server.
 *  - Bounded timeouts: 30s for the load (cold-start moondream2 on a
 *    spinning disk can be slow) and 5s for the unload (just header
 *    handling on Ollama's side).
 *  - Privacy: every fetch is paired with a `logPrivacyEvent` within ±10
 *    lines (tier-review Check #8) so the user sees vision load/unload
 *    in the privacy dashboard alongside chat and tool calls.
 */
import { nanoid } from "nanoid";

import type { TenantContext } from "@workspace/types";

import { logger } from "../../lib/logger";
import { logPrivacyEvent } from "../privacy.service";

const KEEP_ALIVE_LOAD = "24h";
const LOAD_TIMEOUT_MS = 30_000;
const UNLOAD_TIMEOUT_MS = 5_000;

function ollamaHost(): string {
  return process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
}

function systemContext(): TenantContext {
  // Vision lifecycle is a system-owned background process; it has no
  // request-bound tenant. Use the documented "system" tenant so the
  // event still satisfies the multi-tenant invariant on
  // `privacy_events.tenantId` while staying clearly attributable.
  return {
    tenantId: "system",
    userId: "system:vision-lifecycle",
    requestId: `vision-${nanoid(10)}`,
  };
}

export interface VisionRuntimeBridge {
  /** Send Ollama a keep-alive load. Resolves `true` on HTTP 2xx. */
  load(modelId: string): Promise<boolean>;
  /** Send Ollama `keep_alive: 0` to free the model. Resolves `true` on 2xx. */
  unload(modelId: string): Promise<boolean>;
}

const defaultBridge: VisionRuntimeBridge = {
  async load(modelId) {
    try {
      // Privacy log MUST stay within ±10 lines of the fetch() below
      // so tier-review Check #8 sees the audit pairing.
      await logPrivacyEvent(systemContext(), {
        eventType: "network.ollama",
        actor: "system:vision-lifecycle",
        target: `ollama:/api/generate:${modelId}:keep_alive=${KEEP_ALIVE_LOAD}`,
        severity: "low",
        detail: "vision-load",
      });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), LOAD_TIMEOUT_MS);
      const res = await fetch(`${ollamaHost()}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          prompt: "",
          keep_alive: KEEP_ALIVE_LOAD,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return res.ok;
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e), modelId },
        "vision-runtime: load failed (best-effort)",
      );
      return false;
    }
  },
  async unload(modelId) {
    try {
      // Privacy log MUST stay within ±10 lines of the fetch() below
      // so tier-review Check #8 sees the audit pairing.
      await logPrivacyEvent(systemContext(), {
        eventType: "network.ollama",
        actor: "system:vision-lifecycle",
        target: `ollama:/api/generate:${modelId}:keep_alive=0`,
        severity: "low",
        detail: "vision-unload",
      });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), UNLOAD_TIMEOUT_MS);
      const res = await fetch(`${ollamaHost()}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          prompt: "",
          keep_alive: 0,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return res.ok;
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e), modelId },
        "vision-runtime: unload failed (best-effort)",
      );
      return false;
    }
  },
};

let bridge: VisionRuntimeBridge = defaultBridge;

export function getVisionRuntimeBridge(): VisionRuntimeBridge {
  return bridge;
}

export function setVisionRuntimeBridgeForTests(b: VisionRuntimeBridge): void {
  bridge = b;
}

export function resetVisionRuntimeBridgeForTests(): void {
  bridge = defaultBridge;
}
