/**
 * Hardware cache — in-process memo + on-disk snapshot.
 *
 * Hardware does not change while the process is up, so we probe `os.*` at
 * most once per launch. The result is also persisted to a JSON file
 * (`<data dir>/hardware.json`) so subsequent app launches can short-circuit
 * detection entirely on cold start, satisfying Task #64's "cache locally so
 * we don't re-probe on every launch" requirement.
 *
 * To avoid stale-data bugs after a hardware upgrade, the on-disk snapshot
 * carries a fingerprint (platform / arch / cpuCount / totalRamBytes). On
 * load we re-detect the fingerprint cheaply with `os.*`; if it has drifted
 * we discard the snapshot and run the full detector again.
 *
 * Tests (or any caller that wants a fresh probe — e.g. a "Re-detect
 * hardware" UI button) call `clearHardwareCache()` to drop both the
 * in-memory memo and the on-disk snapshot.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HardwareProfile } from "@workspace/types";

import { logger } from "../../lib/logger";

import { recordHardwareDetectionIfOptedIn } from "./analytics";
import { detectHardware } from "./detector";

let cached: HardwareProfile | null = null;

/**
 * Where the snapshot lives. Defaults to `<cwd>/data/hardware.json` (the
 * same parent dir as the SQLite DB) so an installer can wipe both at
 * once. Tests override this with `OMNINITY_HARDWARE_CACHE_PATH` to keep
 * each run isolated.
 */
function snapshotPath(): string {
  const fromEnv = process.env["OMNINITY_HARDWARE_CACHE_PATH"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const dataDir = path.resolve(process.cwd(), "data");
  return path.join(dataDir, "hardware.json");
}

/**
 * Skip disk persistence in test mode — `OMNINITY_HARDWARE_OVERRIDE` already
 * pins the synthetic profile, and writing a real file would leak state
 * between cases. Set `OMNINITY_HARDWARE_CACHE_PATH` to opt in for tests
 * that explicitly exercise the persistence path.
 */
function shouldPersist(): boolean {
  if (process.env["OMNINITY_HARDWARE_CACHE_PATH"]) return true;
  return process.env["NODE_ENV"] !== "test";
}

interface HardwareSnapshotFingerprint {
  readonly platform: string;
  readonly arch: string;
  readonly cpuCount: number;
  readonly totalRamBytes: number;
}

function currentFingerprint(): HardwareSnapshotFingerprint {
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuCount: os.cpus().length,
    totalRamBytes: os.totalmem(),
  };
}

/** ±256 MB tolerance — masks the noise in `os.totalmem()` between probes. */
const RAM_FINGERPRINT_TOLERANCE_BYTES = 256 * 1024 * 1024;

function fingerprintMatches(
  saved: HardwareSnapshotFingerprint,
  current: HardwareSnapshotFingerprint,
): boolean {
  if (saved.platform !== current.platform) return false;
  if (saved.arch !== current.arch) return false;
  if (saved.cpuCount !== current.cpuCount) return false;
  return (
    Math.abs(saved.totalRamBytes - current.totalRamBytes) <=
    RAM_FINGERPRINT_TOLERANCE_BYTES
  );
}

function readSnapshot(): HardwareProfile | null {
  if (!shouldPersist()) return null;
  const file = snapshotPath();
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as {
      fingerprint?: HardwareSnapshotFingerprint;
      profile?: HardwareProfile;
    };
    if (!parsed.fingerprint || !parsed.profile) return null;
    if (!fingerprintMatches(parsed.fingerprint, currentFingerprint())) {
      logger.info(
        { file },
        "hardware cache: fingerprint drift, ignoring snapshot",
      );
      return null;
    }
    return parsed.profile;
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), file },
      "hardware cache: failed to read snapshot, falling back to detection",
    );
    return null;
  }
}

function writeSnapshot(profile: HardwareProfile): void {
  if (!shouldPersist()) return;
  const file = snapshotPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        { fingerprint: currentFingerprint(), profile },
        null,
        2,
      ),
      "utf8",
    );
  } catch (e) {
    // Persistence is a best-effort optimisation — the in-memory cache
    // still shields the process from re-probing. Log + continue.
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), file },
      "hardware cache: failed to write snapshot",
    );
  }
}

export function getHardwareProfile(): HardwareProfile {
  if (cached) return cached;
  const fromDisk = readSnapshot();
  if (fromDisk) {
    // Re-launch path: snapshot already on disk, analytics was already
    // emitted at original install time (single-shot semantics).
    cached = fromDisk;
    return cached;
  }
  // First-detection path. Capture whether the snapshot file existed
  // BEFORE we write so the analytics emit is exactly-once across the
  // install lifetime (the file becomes the install marker).
  const isFirstDetection =
    shouldPersist() && !fs.existsSync(snapshotPath());
  const fresh = detectHardware();
  cached = fresh;
  writeSnapshot(fresh);
  if (isFirstDetection) {
    // Per Task #64 "Done looks like": "Hardware detection is logged
    // once on install for analytics (opt-in only, per the privacy
    // rules)". The recordHardware…IfOptedIn helper short-circuits to
    // a no-op unless OMNINITY_ANALYTICS_OPT_IN=true.
    recordHardwareDetectionIfOptedIn(fresh);
  }
  return cached;
}

/**
 * Drop the in-memory memo AND the on-disk snapshot so the next call to
 * `getHardwareProfile()` runs a full detection. Used by tests and by the
 * forthcoming "Re-detect hardware" Settings action.
 */
export function clearHardwareCache(): void {
  cached = null;
  if (!shouldPersist()) return;
  const file = snapshotPath();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), file },
      "hardware cache: failed to delete snapshot",
    );
  }
}

/**
 * Test-only: drop ONLY the in-memory memo, leaving the on-disk snapshot
 * intact. Lets the persistence test simulate a process restart so the
 * next `getHardwareProfile()` call must re-hydrate from disk rather
 * than serving the still-warm memo.
 */
export function __clearHardwareCacheMemoForTests(): void {
  cached = null;
}
