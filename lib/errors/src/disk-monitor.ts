/**
 * Disk-space monitor — partial implementation of Step 5 of Task #31.
 *
 * Surfaces three states based on free bytes on a given path:
 *   - `ok`        — comfortable headroom.
 *   - `warning`   — below WARNING_THRESHOLD_BYTES (default 2 GB).
 *   - `critical`  — below CRITICAL_THRESHOLD_BYTES (default 500 MB). Callers
 *                   MUST refuse model downloads / backups in this state.
 *
 * The probe uses `fs.statfs`, which is Linux/macOS only on older Node, but
 * is available on every platform from Node 18+. If the call throws (e.g.
 * sandboxed environments where statfs is unavailable), the monitor returns
 * `unknown` rather than crashing — callers should treat `unknown` as `ok`
 * for non-critical decisions and as `warning` for destructive ones.
 */
import { statfs } from "node:fs/promises";

export type DiskHealth = "ok" | "warning" | "critical" | "unknown";

export interface DiskStatus {
  readonly health: DiskHealth;
  readonly freeBytes: number | null;
  readonly totalBytes: number | null;
  readonly path: string;
}

export const DISK_THRESHOLDS = {
  WARNING_BYTES: 2 * 1024 * 1024 * 1024, // 2 GB
  CRITICAL_BYTES: 500 * 1024 * 1024, // 500 MB
} as const;

export interface DiskMonitorOptions {
  readonly warningBytes?: number;
  readonly criticalBytes?: number;
  /** Optional override for tests — if provided, replaces the statfs probe. */
  readonly probe?: (path: string) => Promise<{ freeBytes: number; totalBytes: number }>;
}

export class DiskMonitor {
  private readonly warningBytes: number;
  private readonly criticalBytes: number;
  private readonly probe: (path: string) => Promise<{ freeBytes: number; totalBytes: number }>;

  constructor(options: DiskMonitorOptions = {}) {
    this.warningBytes = options.warningBytes ?? DISK_THRESHOLDS.WARNING_BYTES;
    this.criticalBytes = options.criticalBytes ?? DISK_THRESHOLDS.CRITICAL_BYTES;
    this.probe = options.probe ?? defaultProbe;

    if (this.criticalBytes >= this.warningBytes) {
      throw new RangeError(
        "DiskMonitor: criticalBytes must be strictly less than warningBytes",
      );
    }
  }

  public async check(path: string): Promise<DiskStatus> {
    try {
      const { freeBytes, totalBytes } = await this.probe(path);
      const health: DiskHealth =
        freeBytes <= this.criticalBytes
          ? "critical"
          : freeBytes <= this.warningBytes
            ? "warning"
            : "ok";
      return { health, freeBytes, totalBytes, path };
    } catch {
      return { health: "unknown", freeBytes: null, totalBytes: null, path };
    }
  }
}

async function defaultProbe(
  path: string,
): Promise<{ freeBytes: number; totalBytes: number }> {
  const s = await statfs(path);
  // statfs returns bigint blocks on some platforms; coerce safely via Number.
  const bsize = Number(s.bsize);
  const bavail = Number(s.bavail);
  const blocks = Number(s.blocks);
  return {
    freeBytes: bsize * bavail,
    totalBytes: bsize * blocks,
  };
}
