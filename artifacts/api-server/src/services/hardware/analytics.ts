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
 *  - Single-shot semantics: the cache.ts caller only invokes us when it
 *    just performed a fresh detection AND no on-disk snapshot existed
 *    beforehand. The snapshot file is therefore the install-time marker —
 *    once it exists we never re-emit, even across process restarts.
 *  - Payload contains hardware-class data only (RAM tier, CPU count,
 *    arch, Apple Silicon flag). No PII, no machine identifier, no IP.
 *
 * The default sink logs through Pino with a structured `event` tag so a
 * future privacy-event consumer (Task #36 Resource Governor) can subscribe
 * without us coupling to that subsystem here. Tests swap the sink via
 * `setHardwareAnalyticsSinkForTests` to assert exact emit semantics.
 */
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

export function recordHardwareDetectionIfOptedIn(
  profile: HardwareProfile,
): void {
  if (!isAnalyticsOptedIn()) return;
  sink({
    event: "hardware_detected",
    tier: profile.tier,
    platform: profile.platform,
    arch: profile.arch,
    cpuCount: profile.cpuCount,
    totalRamBytes: profile.totalRamBytes,
    appleSilicon: profile.appleSilicon,
    at: new Date().toISOString(),
  });
}

export function setHardwareAnalyticsSinkForTests(
  s: HardwareAnalyticsSink,
): void {
  sink = s;
}

export function resetHardwareAnalyticsSinkForTests(): void {
  sink = defaultSink;
}
