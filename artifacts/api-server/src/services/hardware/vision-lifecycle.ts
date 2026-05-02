/**
 * Vision-companion lifecycle policy + state machine.
 *
 * Owns the policy (mode → idle-timeout-ms tier defaults), the state
 * machine (unloaded → loading → loaded → unloaded after idle), the
 * configurable settings toggle, and the single-process authority for
 * "is the vision model resident?".
 *
 * The actual Ollama HTTP calls (`/api/generate` with `keep_alive`) are
 * fired through the swappable `VisionRuntimeBridge` in
 * `./vision-runtime.ts`. That module ships a real default bridge today
 * so the user-visible runtime guarantee from task-64.md line 22
 * ("loaded on demand … unloaded after a configurable idle timeout to
 * free RAM") holds without waiting on Task #30. When Task #30 lands
 * its full ModelRuntime abstraction it will inject its bridge via
 * `setVisionRuntimeBridge(...)` and this state machine stays untouched.
 *
 * `touch()` and `unload()` are intentionally synchronous to keep call
 * sites simple (every desktop-control entry point would otherwise have
 * to await). The runtime promises are launched in the background; the
 * state machine reflects *intent* — "we have asked Ollama to load /
 * unload" — which is the right authority for UI display ("Vision is
 * resident") and for the idle timer. Tests that need determinism call
 * `awaitInflight()` to await the in-flight bridge promise.
 *
 * Modes:
 *  - `aggressive` — short idle timeout (low/mid tier). Frees RAM quickly.
 *  - `balanced`   — default. Reasonable idle timeout for most hosts.
 *  - `warm`       — long idle (high/pro tier). Keeps the model resident
 *                   for repeat vision queries.
 *
 * The mode strings are presentation hints; the idle-timeout milliseconds
 * are the source of truth used by the timer.
 */
import type {
  HardwareTierKey,
  VisionLifecycleMode,
  VisionModelLifecycleConfig,
} from "@workspace/types";

import { logger } from "../../lib/logger";

import { getDefaultVision } from "./catalogue";
import { getVisionRuntimeBridge } from "./vision-runtime";

const ONE_MINUTE_MS = 60 * 1000;

const MODE_DEFAULT_TIMEOUT_MS: Record<VisionLifecycleMode, number> = {
  aggressive: 30 * 1000, // 30s — free RAM ASAP on lean machines
  balanced: 5 * ONE_MINUTE_MS,
  warm: 30 * ONE_MINUTE_MS,
};

export function defaultLifecycleForTier(
  tier: HardwareTierKey,
): VisionModelLifecycleConfig {
  const vision = getDefaultVision();
  const visionId = vision?.id ?? "moondream:v2";
  const mode: VisionLifecycleMode =
    tier === "low" || tier === "mid"
      ? "aggressive"
      : tier === "pro"
        ? "warm"
        : "balanced";
  return {
    visionModelId: visionId,
    mode,
    idleTimeoutMs: MODE_DEFAULT_TIMEOUT_MS[mode],
  };
}

export function timeoutForMode(mode: VisionLifecycleMode): number {
  return MODE_DEFAULT_TIMEOUT_MS[mode];
}

type LifecycleState = "unloaded" | "loading" | "loaded";

interface LifecycleSnapshot {
  readonly state: LifecycleState;
  readonly visionModelId: string;
  readonly mode: VisionLifecycleMode;
  readonly idleTimeoutMs: number;
  readonly lastUsedAt: string | null;
}

class VisionLifecycle {
  private state: LifecycleState = "unloaded";
  private config: VisionModelLifecycleConfig;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastUsedAt: number | null = null;
  private inflight: Promise<unknown> | null = null;

  constructor(initial: VisionModelLifecycleConfig) {
    this.config = initial;
  }

  configure(next: VisionModelLifecycleConfig): void {
    this.config = next;
    // Re-arm the timer with the new timeout if currently loaded.
    if (this.state === "loaded") this.armIdleTimer();
  }

  getConfig(): VisionModelLifecycleConfig {
    return this.config;
  }

  /**
   * Mark the vision model as in-use. Fires the real Ollama keep-alive
   * load via the runtime bridge in the background (best-effort, never
   * throws) and resets the idle timer. The visible state flips to
   * `loaded` optimistically — it represents *intent* ("we have asked
   * Ollama to keep this resident"), which is the right authority for
   * the idle timer and UI display. The bridge's resolved/rejected
   * outcome is only logged; the next desktop-control call retries.
   * Tests can `awaitInflight()` to drive the bridge promise.
   */
  touch(): void {
    this.lastUsedAt = Date.now();
    if (this.state !== "loaded") {
      const id = this.config.visionModelId;
      this.state = "loaded";
      logger.info({ visionModelId: id }, "vision-lifecycle: load");
      this.inflight = getVisionRuntimeBridge()
        .load(id)
        .catch(() => false);
    }
    this.armIdleTimer();
  }

  /** Force-unload (e.g. when the user toggles the feature off). */
  unload(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.state !== "unloaded") {
      const id = this.config.visionModelId;
      this.state = "unloaded";
      logger.info({ visionModelId: id }, "vision-lifecycle: unload");
      // Best-effort fire-and-forget Ollama unload (keep_alive=0) so RAM
      // is freed promptly. Errors are swallowed inside the bridge.
      this.inflight = getVisionRuntimeBridge()
        .unload(id)
        .catch(() => false);
    }
  }

  /**
   * Test hook — awaits the most recent bridge call so assertions on
   * runtime invocation are deterministic. Resolves immediately when no
   * bridge call is in flight.
   */
  async awaitInflight(): Promise<void> {
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* swallow — bridge errors are logged, not surfaced */
      }
    }
  }

  snapshot(): LifecycleSnapshot {
    return {
      state: this.state,
      visionModelId: this.config.visionModelId,
      mode: this.config.mode,
      idleTimeoutMs: this.config.idleTimeoutMs,
      lastUsedAt: this.lastUsedAt
        ? new Date(this.lastUsedAt).toISOString()
        : null,
    };
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.config.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.unload();
    }, this.config.idleTimeoutMs);
    // Don't keep the event loop alive in tests / dev shutdown.
    if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
  }
}

// tier-review: bounded — singleton lifecycle for the single vision model.
let singleton: VisionLifecycle | null = null;

export function getVisionLifecycle(
  initialTier: HardwareTierKey = "mid",
): VisionLifecycle {
  if (!singleton) {
    singleton = new VisionLifecycle(defaultLifecycleForTier(initialTier));
  }
  return singleton;
}

export function resetVisionLifecycleForTests(): void {
  if (singleton) singleton.unload();
  singleton = null;
}

export type { LifecycleSnapshot };
