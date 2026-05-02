/**
 * In-process hardware cache.
 *
 * Hardware doesn't change while the process is up, so we probe `os.*` once
 * and re-use the result. Keeping the cache in-process (vs. on disk) matches
 * the local-first model — every desktop install opens the api-server fresh
 * on launch, so a long-lived disk cache would just create stale-data risk.
 *
 * Tests can call `clearHardwareCache()` to force a re-probe (e.g. after
 * mutating `OMNINITY_HARDWARE_OVERRIDE`).
 */
import type { HardwareProfile } from "@workspace/types";

import { detectHardware } from "./detector";

let cached: HardwareProfile | null = null;

export function getHardwareProfile(): HardwareProfile {
  if (cached) return cached;
  cached = detectHardware();
  return cached;
}

export function clearHardwareCache(): void {
  cached = null;
}
