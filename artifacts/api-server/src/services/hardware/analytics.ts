/**
 * Hardware-detection analytics — opt-in, single-shot per install.
 *
 * Task #64 "Done looks like": "Hardware detection is logged once on install
 * for analytics (opt-in only, per the privacy rules) and cached locally so
 * subsequent launches don't re-probe."
 *
 * Privacy contract (OMNINITY_PROJECT_CONTEXT.md rule #10: "No telemetry by
 * default — analytics and crash reporting are opt-in, off by default"):
 *
 *  - Default behaviour: NO emission. The analytics path is fully off until
 *    `OMNINITY_ANALYTICS_OPT_IN=true` is set in the environment.
 *  - Single-shot semantics: gated by a *durable* marker file that is
 *    independent of the hardware snapshot cache. `clearHardwareCache()` /
 *    the "Re-detect hardware" Settings action wipe the snapshot but NOT
 *    the marker, so a redetect never re-emits install-time telemetry.
 *  - Payload contains hardware-class data only (RAM tier, CPU count,
 *    arch, Apple Silicon flag, GPU vendor/kind). No PII, no machine
 *    identifier, no IP.
 *
 * The default sink logs through Pino with a structured `event` tag so a
 * future privacy-event consumer (Task #36 Resource Governor) can subscribe
 * without us coupling to that subsystem here. Tests swap the sink via
 * `setHardwareAnalyticsSinkForTests` to assert exact emit semantics.
 */
import fs from "node:fs";
import path from "node:path";

import type { HardwareProfile } from "@workspace/types";

import { logger } from "../../lib/logger";

export interface HardwareAnalyticsEvent {
  readonly event: "hardware_detected";
  readonly tier: HardwareProfile["tier"];
  readonly platform: string;
  readonly arch: string;
  readonly cpuCount: number;
  readonly totalRamBytes: number;
  readonly appleSilicon: boolean;
  readonly gpuVendor: string | null;
  readonly gpuKind: string | null;
  readonly at: string;
}

export type HardwareAnalyticsSink = (e: HardwareAnalyticsEvent) => void;

const defaultSink: HardwareAnalyticsSink = (e) => {
  logger.info(e, "analytics: hardware_detected");
};

let sink: HardwareAnalyticsSink = defaultSink;

/**
 * Default-off opt-in flag. We deliberately require the explicit string
 * "true" so a stray "1" or "yes" doesn't accidentally enable telemetry —
 * privacy-by-default beats permissive parsing here.
 */
export function isAnalyticsOptedIn(): boolean {
  return process.env["OMNINITY_ANALYTICS_OPT_IN"] === "true";
}

/**
 * Resolve the durable install-marker path. Defaults to a sibling of the
 * hardware cache file so a single install dir contains both. Tests
 * (and the hardware-cache test) override OMNINITY_HARDWARE_CACHE_PATH
 * to /tmp; we honour that so test runs stay isolated.
 */
function markerPath(): string {
  const explicit = process.env["OMNINITY_ANALYTICS_MARKER_PATH"];
  if (explicit && explicit.length > 0) return explicit;
  const cachePath = process.env["OMNINITY_HARDWARE_CACHE_PATH"];
  if (cachePath && cachePath.length > 0) {
    return cachePath + ".analytics-emitted";
  }
  return path.join(
    process.cwd(),
    "data",
    "hardware-analytics-emitted.marker",
  );
}

function hasAlreadyEmitted(): boolean {
  try {
    return fs.existsSync(markerPath());
  } catch {
    // If we can't even stat the marker we err on the side of NOT
    // emitting — privacy-preserving default.
    return true;
  }
}

function writeMarker(): void {
  const file = markerPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, new Date().toISOString(), "utf8");
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), file },
      "hardware analytics: failed to write install marker",
    );
  }
}

export function recordHardwareDetectionIfOptedIn(
  profile: HardwareProfile,
): void {
  if (!isAnalyticsOptedIn()) return;
  // Durable single-shot gate. Survives clearHardwareCache() and the
  // "Re-detect hardware" Settings action so a user-driven redetect
  // never re-emits install-time telemetry.
  if (hasAlreadyEmitted()) return;
  sink({
    event: "hardware_detected",
    tier: profile.tier,
    platform: profile.platform,
    arch: profile.arch,
    cpuCount: profile.cpuCount,
    totalRamBytes: profile.totalRamBytes,
    appleSilicon: profile.appleSilicon,
    gpuVendor: profile.gpu?.vendor ?? null,
    gpuKind: profile.gpu?.kind ?? null,
    at: new Date().toISOString(),
  });
  writeMarker();
}

/**
 * Test-only: drop the install marker so the next opted-in detection
 * emits again. Production code never calls this — `clearHardwareCache`
 * intentionally leaves the marker in place.
 */
export function __clearAnalyticsMarkerForTests(): void {
  try {
    const file = markerPath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

export function setHardwareAnalyticsSinkForTests(
  s: HardwareAnalyticsSink,
): void {
  sink = s;
}

export function resetHardwareAnalyticsSinkForTests(): void {
  sink = defaultSink;
}
