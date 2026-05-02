/**
 * Vision-companion lifecycle policy + state machine.
 *
 * Scope split with Task #30 (Model Runtime Abstraction Layer) is dictated
 * by task-64.md itself:
 *  - Sequencing section: "Task #30 … must support the on-demand load/unload
 *    pattern for the vision model. … The on-demand load/unload requirement
 *    is the most important coordination point with Task #30 — flag it early."
 *  - Step 3 ("Vision model lifecycle"): "Coordinate with Task #30 to ensure
 *    the runtime layer supports load-on-demand and idle-timeout unload …".
 *
 * Therefore Task #64's slice of the lifecycle is: the policy (mode →
 * idle-timeout-ms tier defaults), the state machine (unloaded → loading →
 * loaded → unloaded after idle), the configurable settings toggle, and the
 * single-process authority for "is the vision model resident?". The
 * `ollama load` / `ollama unload` HTTP calls themselves are intentionally
 * Task #30's responsibility — wiring them here would duplicate the
 * ModelRuntime interface that Task #30 owns.
 *
 * Until Task #30 lands, `touch()` flips the state machine straight to
 * `loaded` (no real loader to await) so consumers and tests observe the
 * full transition surface today. When Task #30 merges, the body of
 * `touch()` and `unload()` will gain an awaited bridge to that runtime
 * without changing the policy / config / observation API exported here.
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
   * Mark the vision model as in-use. The real implementation (Task #30)
   * will bridge to `ollama load`; here we just flip state and reset the
   * idle timer.
   */
  touch(): void {
    this.lastUsedAt = Date.now();
    if (this.state === "unloaded") {
      this.state = "loading";
      // No real loader yet — flip straight to loaded so the state machine
      // is observable in tests. Task #30 will replace this with an awaited
      // ollama call.
      this.state = "loaded";
      logger.info(
        { visionModelId: this.config.visionModelId },
        "vision-lifecycle: load (stub)",
      );
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
      this.state = "unloaded";
      logger.info(
        { visionModelId: this.config.visionModelId },
        "vision-lifecycle: unload",
      );
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
