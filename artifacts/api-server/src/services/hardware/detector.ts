/**
 * Hardware detection — `os.*` reads + best-effort GPU probe + the
 * documented test override.
 *
 * Cohabits with the recommendation engine in `services/hardware/` so the
 * full Task #64 unit lives in one folder. The legacy
 * `services/onboarding.service.ts#detectHardware` re-exports from here so
 * the existing `/api/onboarding/hardware` route keeps working.
 *
 * `OMNINITY_HARDWARE_OVERRIDE` is the documented test seam — when set, the
 * JSON value short-circuits all `os.*` reads and skips the GPU probe.
 * The test-runner uses it to pin the recommendation engine to a
 * deterministic 16GB Apple-Silicon profile across CI hosts.
 */
import { execFileSync } from "node:child_process";
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

export interface GpuInfo {
  readonly vendor: string;
  readonly kind: string;
  readonly vramBytes?: number;
}

/**
 * Best-effort GPU class probe. Never throws, never blocks startup
 * meaningfully — every shell call is bounded to 800ms and returns null
 * on any failure (missing tool, permission denied, parse error, etc.).
 *
 * The recommendation engine in `recommendation.ts` does NOT key on the
 * GPU field today — it sizes from RAM only, which is the binding
 * constraint for local LLM inference. The GPU field is surfaced for
 * Settings UI display, the privacy-preserving analytics opt-in event,
 * and future Task #30 model-runtime decisions (e.g. preferring Metal
 * vs CUDA backends). Returning null is therefore always safe.
 *
 * Exported (rather than inlined into `detectHardware`) so tests can
 * exercise the real platform path while the hardware override pins the
 * rest of the profile to a deterministic snapshot.
 */
export function probeGpu(): GpuInfo | null {
  try {
    const platform = os.platform();
    const arch = os.arch();
    if (platform === "darwin") {
      // Apple Silicon ships an integrated GPU; its presence is implied
      // by arch=arm64 on darwin without needing to shell out to the
      // notoriously slow `system_profiler`.
      if (arch === "arm64") {
        return { vendor: "Apple", kind: "Apple integrated GPU" };
      }
      return probeGpuMacIntel();
    }
    if (platform === "linux") return probeGpuLinux();
    if (platform === "win32") return probeGpuWindows();
    return null;
  } catch {
    return null;
  }
}

const PROBE_TIMEOUT_MS = 800;

function safeExec(cmd: string, args: ReadonlyArray<string>): string | null {
  try {
    const out = execFileSync(cmd, args as string[], {
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer: 256 * 1024,
    });
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}

function classifyVendor(line: string): string | null {
  const u = line.toUpperCase();
  if (u.includes("NVIDIA")) return "NVIDIA";
  if (u.includes("ADVANCED MICRO DEVICES") || u.includes("AMD") || u.includes("ATI"))
    return "AMD";
  if (u.includes("INTEL")) return "Intel";
  if (u.includes("APPLE")) return "Apple";
  return null;
}

function probeGpuLinux(): GpuInfo | null {
  // `lspci -mm` is on every mainstream distro and stable across years.
  // Output line example:
  //   00:02.0 "VGA compatible controller" "Intel Corporation" "UHD Graphics 620" -r07 ...
  const out = safeExec("lspci", ["-mm"]);
  if (!out) return null;
  const lines = out.split("\n");
  for (const ln of lines) {
    const upper = ln.toUpperCase();
    if (
      !upper.includes("VGA") &&
      !upper.includes("3D CONTROLLER") &&
      !upper.includes("DISPLAY CONTROLLER")
    ) {
      continue;
    }
    const vendor = classifyVendor(ln);
    // The third quoted field is the device name.
    const quoted = ln.match(/"([^"]*)"/g);
    const kind =
      quoted && quoted.length >= 3
        ? quoted[2]!.replace(/"/g, "")
        : ln.trim();
    return { vendor: vendor ?? "Unknown", kind };
  }
  return null;
}

function probeGpuWindows(): GpuInfo | null {
  // wmic ships on every Windows build supported in 2026 and avoids the
  // PowerShell startup tax (~700ms cold). Output is `key=value` lines
  // separated by blank lines per device.
  const out = safeExec("wmic", [
    "path",
    "win32_videocontroller",
    "get",
    "name,adapterram",
    "/value",
  ]);
  if (!out) return null;
  const blocks = out.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const nameMatch = block.match(/Name=(.+)/i);
    const ramMatch = block.match(/AdapterRAM=(\d+)/i);
    if (!nameMatch) continue;
    const name = nameMatch[1]!.trim();
    if (!name) continue;
    const vendor = classifyVendor(name);
    const info: GpuInfo = { vendor: vendor ?? "Unknown", kind: name };
    if (ramMatch) {
      const v = Number(ramMatch[1]);
      if (Number.isFinite(v) && v > 0) {
        return { ...info, vramBytes: v };
      }
    }
    return info;
  }
  return null;
}

function probeGpuMacIntel(): GpuInfo | null {
  // `system_profiler` is slow (~1-2s cold) so we cap it tightly. JSON
  // mode keeps parsing trivial. Failure (timeout, missing binary,
  // sandboxed environment) cleanly returns null.
  const out = safeExec("system_profiler", ["-json", "SPDisplaysDataType"]);
  if (!out) return null;
  try {
    const parsed = JSON.parse(out) as {
      SPDisplaysDataType?: Array<{
        sppci_model?: string;
        spdisplays_vram?: string;
        spdisplays_vendor?: string;
      }>;
    };
    const first = parsed.SPDisplaysDataType?.[0];
    if (!first) return null;
    const kind =
      first.sppci_model ?? first.spdisplays_vendor ?? "Unknown GPU";
    const vendor = classifyVendor(kind) ?? "Unknown";
    return { vendor, kind };
  } catch {
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
  // Override wins (tests pin a deterministic profile). On real hosts we
  // do a best-effort platform probe; failure → null, which the rest of
  // the stack already handles.
  const gpu = override?.gpu !== undefined ? override.gpu : probeGpu();

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
