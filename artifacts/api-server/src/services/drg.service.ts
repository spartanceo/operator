/**
 * Dynamic Resource Governor (DRG) — Task #36.
 *
 * Decides how Omninity Operator manages model residency on the host:
 *
 *   Sequential mode ("8GB Path"):
 *     <12GB available RAM. Vision and reasoning models cold-swap — only
 *     one model resident at a time. Step indicator drives the
 *     "Looking → Reasoning → Acting → Verifying" rhythm in chat.
 *
 *   Parallel mode ("Power Path"):
 *     ≥16GB available RAM. Vision + reasoning stay warm; the Vision
 *     adapter polls every 500ms for real-time UI feedback.
 *
 *   Hybrid (12–16GB):
 *     Sequential, but with the warm-vision idle timeout extended.
 *
 * Configurable RAM ceiling (default 60% of total) caps how much memory
 * the OP process is allowed to use; the emergency-throttle monitor
 * watches free memory and pauses the active task when system pressure
 * crosses a threshold (other apps starting to swap).
 *
 * This module is the single source of truth — the desktop orchestrator,
 * privacy meter, and frontend settings page all read from `getDrgState()`.
 */
import os from "node:os";

import { logger } from "../lib/logger";

import { getHardwareProfile } from "./hardware/cache";
import { getVisionLifecycle } from "./hardware/vision-lifecycle";

const ONE_GB = 1024 * 1024 * 1024;

/** RAM thresholds for mode selection. */
export const SEQUENTIAL_MAX_BYTES = 12 * ONE_GB;
export const PARALLEL_MIN_BYTES = 16 * ONE_GB;

/** Default ceiling = 60% of total RAM (per task spec). */
export const DEFAULT_CEILING_FRACTION = 0.6;

/** Pressure threshold — when free RAM (system-wide) drops below this
 *  fraction of total, throttle the active task and notify the user. */
export const PRESSURE_FREE_FRACTION = 0.08;

/** Default model unload idle period — 3 minutes per task spec. */
export const DEFAULT_UNLOAD_IDLE_MS = 3 * 60 * 1000;

export type DrgMode = "sequential" | "hybrid" | "parallel";

export type DrgPhase =
  | "idle"
  | "looking"
  | "reasoning"
  | "acting"
  | "verifying";

export interface DrgConfig {
  /** Mode chosen by automatic detection (overridable by tests). */
  mode: DrgMode;
  /** RAM ceiling — process is not allowed to grow past this. */
  ceilingBytes: number;
  /** User-visible idle period after which idle models unload. */
  unloadIdleMs: number;
  /** Real-time vision poll interval (parallel mode only). */
  visionPollMs: number;
}

export interface DrgMemorySnapshot {
  totalBytes: number;
  freeBytes: number;
  /** RSS of this Node process. */
  processRssBytes: number;
  /** True when system free memory is below the pressure threshold. */
  underPressure: boolean;
  /** True when our process RSS is above the configured ceiling. */
  overCeiling: boolean;
  capturedAt: string;
}

export interface DrgThrottleEvent {
  reason: string;
  triggeredAt: string;
  acknowledgedAt: string | null;
  freeBytesAtTrigger: number;
}

export interface DrgPhaseSnapshot {
  sessionId: string | null;
  phase: DrgPhase;
  message: string;
  changedAt: string;
}

export interface DrgState {
  config: DrgConfig;
  memory: DrgMemorySnapshot;
  phase: DrgPhaseSnapshot;
  throttle: DrgThrottleEvent | null;
}

// ─── Mode selection ────────────────────────────────────────────────────────

export function modeFor(totalRamBytes: number): DrgMode {
  if (totalRamBytes >= PARALLEL_MIN_BYTES) return "parallel";
  if (totalRamBytes < SEQUENTIAL_MAX_BYTES) return "sequential";
  return "hybrid";
}

function defaultPollMs(mode: DrgMode): number {
  // The 500ms loop is the "Power Path" guarantee in the task spec.
  return mode === "parallel" ? 500 : 0;
}

// ─── State ────────────────────────────────────────────────────────────────

interface InternalState {
  config: DrgConfig;
  phase: DrgPhaseSnapshot;
  throttle: DrgThrottleEvent | null;
  monitor: NodeJS.Timeout | null;
}

let state: InternalState | null = null;

function ensureState(): InternalState {
  if (state) return state;
  const profile = getHardwareProfile();
  const total = profile.totalRamBytes;
  const mode = modeFor(total);
  state = {
    config: {
      mode,
      ceilingBytes: Math.floor(total * DEFAULT_CEILING_FRACTION),
      unloadIdleMs: DEFAULT_UNLOAD_IDLE_MS,
      visionPollMs: defaultPollMs(mode),
    },
    phase: {
      sessionId: null,
      phase: "idle",
      message: "Idle",
      changedAt: new Date().toISOString(),
    },
    throttle: null,
    monitor: null,
  };
  return state;
}

// ─── Memory probe ─────────────────────────────────────────────────────────

export function snapshotMemory(): DrgMemorySnapshot {
  const s = ensureState();
  const total = os.totalmem();
  const free = os.freemem();
  const rss = process.memoryUsage().rss;
  return {
    totalBytes: total,
    freeBytes: free,
    processRssBytes: rss,
    underPressure: free / total < PRESSURE_FREE_FRACTION,
    overCeiling: rss > s.config.ceilingBytes,
    capturedAt: new Date().toISOString(),
  };
}

// ─── Public surface ───────────────────────────────────────────────────────

export function getDrgConfig(): DrgConfig {
  return { ...ensureState().config };
}

export function getDrgState(): DrgState {
  const s = ensureState();
  return {
    config: { ...s.config },
    memory: snapshotMemory(),
    phase: { ...s.phase },
    throttle: s.throttle ? { ...s.throttle } : null,
  };
}

export interface UpdateCeilingInput {
  ceilingBytes?: number;
  unloadIdleMs?: number;
  modeOverride?: DrgMode | null;
}

export class InvalidCeilingError extends Error {
  override readonly name = "InvalidCeilingError";
  readonly code = "INVALID_CEILING";
}

export function updateDrgConfig(input: UpdateCeilingInput): DrgConfig {
  const s = ensureState();
  const profile = getHardwareProfile();
  if (input.ceilingBytes !== undefined) {
    // Sanity bounds: at least 1GB, at most total RAM.
    if (
      !Number.isFinite(input.ceilingBytes) ||
      input.ceilingBytes < ONE_GB ||
      input.ceilingBytes > profile.totalRamBytes
    ) {
      throw new InvalidCeilingError(
        `ceilingBytes must be between 1GB and totalRam (${profile.totalRamBytes})`,
      );
    }
    s.config.ceilingBytes = Math.floor(input.ceilingBytes);
  }
  if (input.unloadIdleMs !== undefined) {
    if (!Number.isFinite(input.unloadIdleMs) || input.unloadIdleMs < 0) {
      throw new InvalidCeilingError("unloadIdleMs must be >= 0");
    }
    s.config.unloadIdleMs = Math.floor(input.unloadIdleMs);
  }
  if (input.modeOverride !== undefined) {
    if (input.modeOverride === null) {
      s.config.mode = modeFor(profile.totalRamBytes);
    } else {
      s.config.mode = input.modeOverride;
    }
    s.config.visionPollMs = defaultPollMs(s.config.mode);
  }
  return { ...s.config };
}

// ─── Phase indicator (Looking → Reasoning → Acting → Verifying) ──────────

export function setPhase(
  phase: DrgPhase,
  opts: { sessionId?: string | null; message?: string } = {},
): DrgPhaseSnapshot {
  const s = ensureState();
  s.phase = {
    sessionId: opts.sessionId ?? s.phase.sessionId,
    phase,
    message: opts.message ?? defaultPhaseMessage(phase),
    changedAt: new Date().toISOString(),
  };
  // Sequential mode unloads vision before reasoning per spec.
  if (s.config.mode === "sequential" && phase === "reasoning") {
    try {
      getVisionLifecycle().unload();
    } catch {
      /* best-effort */
    }
  }
  if (phase === "looking" || phase === "verifying") {
    try {
      getVisionLifecycle().touch();
    } catch {
      /* best-effort */
    }
  }
  return { ...s.phase };
}

function defaultPhaseMessage(phase: DrgPhase): string {
  switch (phase) {
    case "looking":
      return "Looking at screen…";
    case "reasoning":
      return "Reasoning…";
    case "acting":
      return "Acting…";
    case "verifying":
      return "Verifying…";
    case "idle":
      return "Idle";
  }
}

// ─── Emergency throttle ───────────────────────────────────────────────────

/**
 * Pause-the-active-task signal. The desktop orchestrator polls
 * `consumeThrottle()` between LAV steps; if a throttle is set the
 * orchestrator marks the session paused and surfaces the reason to the
 * user before any further action runs.
 */
export function triggerThrottle(reason: string): DrgThrottleEvent {
  const s = ensureState();
  const mem = snapshotMemory();
  s.throttle = {
    reason,
    triggeredAt: new Date().toISOString(),
    acknowledgedAt: null,
    freeBytesAtTrigger: mem.freeBytes,
  };
  logger.warn(
    { reason, freeBytes: mem.freeBytes, rss: mem.processRssBytes },
    "DRG: emergency throttle triggered",
  );
  // Free memory immediately by shedding warm models.
  try {
    getVisionLifecycle().unload();
  } catch {
    /* best-effort */
  }
  return { ...s.throttle };
}

export function acknowledgeThrottle(): DrgThrottleEvent | null {
  const s = ensureState();
  if (!s.throttle) return null;
  s.throttle = {
    ...s.throttle,
    acknowledgedAt: new Date().toISOString(),
  };
  const out = { ...s.throttle };
  s.throttle = null;
  return out;
}

export function getThrottle(): DrgThrottleEvent | null {
  const s = ensureState();
  return s.throttle ? { ...s.throttle } : null;
}

/**
 * Memory-pressure tick — invoked by the periodic monitor (or directly by
 * the desktop orchestrator before each step). Returns true when a fresh
 * throttle was raised on this tick.
 */
export function tickMemoryMonitor(): boolean {
  const s = ensureState();
  if (s.throttle) return false; // already pending acknowledgement
  const mem = snapshotMemory();
  if (mem.underPressure) {
    triggerThrottle(
      `System memory pressure: only ${(mem.freeBytes / ONE_GB).toFixed(1)}GB free of ${(mem.totalBytes / ONE_GB).toFixed(1)}GB.`,
    );
    return true;
  }
  if (mem.overCeiling) {
    triggerThrottle(
      `Process RSS (${(mem.processRssBytes / ONE_GB).toFixed(1)}GB) exceeded the configured ceiling (${(s.config.ceilingBytes / ONE_GB).toFixed(1)}GB).`,
    );
    return true;
  }
  return false;
}

const MONITOR_INTERVAL_MS = 5_000;

export function startMemoryMonitor(): void {
  const s = ensureState();
  if (s.monitor) return;
  s.monitor = setInterval(() => tickMemoryMonitor(), MONITOR_INTERVAL_MS);
  if (typeof s.monitor.unref === "function") s.monitor.unref();
}

export function stopMemoryMonitor(): void {
  const s = ensureState();
  if (s.monitor) {
    clearInterval(s.monitor);
    s.monitor = null;
  }
}

// ─── Test seam ────────────────────────────────────────────────────────────

export function resetDrgForTests(): void {
  if (state?.monitor) clearInterval(state.monitor);
  state = null;
}
