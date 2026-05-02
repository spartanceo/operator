/**
 * Hardware detection — `os.*` reads + the documented test override.
 *
 * Cohabits with the recommendation engine in `services/hardware/` so the
 * full Task #64 unit lives in one folder. The legacy
 * `services/onboarding.service.ts#detectHardware` re-exports from here so
 * the existing `/api/onboarding/hardware` route keeps working.
 *
 * `OMNINITY_HARDWARE_OVERRIDE` is the documented test seam — when set, the
 * JSON value short-circuits all `os.*` reads. The test-runner uses it to
 * pin the recommendation engine to a deterministic 16GB Apple-Silicon
 * profile across CI hosts.
 */
import os from "node:os";

import type { HardwareProfile } from "@workspace/types";

import { logger } from "../../lib/logger";

import { tierForRam } from "./catalogue";

interface HardwareOverride {
  platform?: string;
  arch?: string;
  cpuCount?: number;
  cpuModel?: string | null;
  totalRamBytes?: number;
  freeRamBytes?: number;
  appleSilicon?: boolean;
  osVersion?: string | null;
  gpu?: { vendor: string; kind: string; vramBytes?: number } | null;
}

function readOverride(): HardwareOverride | null {
  const raw = process.env["OMNINITY_HARDWARE_OVERRIDE"];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as HardwareOverride;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "Invalid OMNINITY_HARDWARE_OVERRIDE — ignoring",
    );
    return null;
  }
}

export function detectHardware(): HardwareProfile {
  const override = readOverride();
  const platform = override?.platform ?? os.platform();
  const arch = override?.arch ?? os.arch();
  const cpus = os.cpus();
  const cpuCount = override?.cpuCount ?? cpus.length;
  const cpuModel =
    override?.cpuModel !== undefined
      ? override.cpuModel
      : cpus[0]?.model ?? null;
  const totalRamBytes = override?.totalRamBytes ?? os.totalmem();
  const freeRamBytes = override?.freeRamBytes ?? os.freemem();
  const appleSilicon =
    override?.appleSilicon ?? (platform === "darwin" && arch === "arm64");
  const osVersion =
    override?.osVersion !== undefined ? override.osVersion : os.release();
  const gpu = override?.gpu ?? null;

  return {
    platform,
    arch,
    cpuCount,
    cpuModel,
    totalRamBytes,
    freeRamBytes,
    appleSilicon,
    tier: tierForRam(totalRamBytes),
    detectedAt: new Date().toISOString(),
    ...(osVersion !== null ? { osVersion } : { osVersion: null }),
    ...(gpu !== null ? { gpu } : { gpu: null }),
  };
}
