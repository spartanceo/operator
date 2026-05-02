/**
 * Updates service — desktop application update channel.
 *
 * This task ships only the API surface for the update check. The actual
 * platform-specific binary download + delta-update mechanism is the
 * "Desktop App Auto-Update System" task; this service provides the
 * `currentVersion` / `latestVersion` comparison so the chat header can
 * render the "update available" banner immediately.
 *
 * Source-of-truth seam: the latest published version is read from
 * `OMNINITY_LATEST_VERSION` (with optional `OMNINITY_LATEST_DOWNLOAD_URL`,
 * `OMNINITY_LATEST_RELEASE_NOTES`, `OMNINITY_RELEASE_CHANNEL`). When the
 * dedicated update server lands, this service is the only file that needs
 * to swap the env-read for a fetch — every consumer keeps working.
 *
 * The currently-running version is read from `npm_package_version` (set by
 * pnpm) with a sensible fallback so the endpoint never 500s in dev.
 */

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  channel: string;
  downloadUrl: string | null;
  releaseNotes: string | null;
  checkedAt: string;
}

const FALLBACK_VERSION = "0.1.0";

function readCurrentVersion(): string {
  const fromPnpm = process.env["npm_package_version"];
  if (fromPnpm && fromPnpm.length > 0) return fromPnpm;
  return FALLBACK_VERSION;
}

function readLatestVersion(current: string): string {
  const fromEnv = process.env["OMNINITY_LATEST_VERSION"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return current;
}

/**
 * Loose semver comparison — splits on `.`, compares numerically left to
 * right. Any trailing pre-release suffix (e.g. `1.2.3-beta.1`) is stripped
 * so the channel field carries that information instead.
 *
 * Returns:
 *   -1 if a < b
 *    0 if a == b
 *    1 if a > b
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const stripPre = (v: string): string => v.split("-")[0] ?? v;
  const aParts = stripPre(a).split(".").map((s) => Number(s) || 0);
  const bParts = stripPre(b).split(".").map((s) => Number(s) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export function checkForUpdates(): UpdateCheckResult {
  const currentVersion = readCurrentVersion();
  const latestVersion = readLatestVersion(currentVersion);
  const channel = process.env["OMNINITY_RELEASE_CHANNEL"] ?? "stable";
  const downloadUrl = process.env["OMNINITY_LATEST_DOWNLOAD_URL"] ?? null;
  const releaseNotes = process.env["OMNINITY_LATEST_RELEASE_NOTES"] ?? null;
  const updateAvailable = compareVersions(currentVersion, latestVersion) < 0;
  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    channel,
    downloadUrl,
    releaseNotes,
    checkedAt: new Date().toISOString(),
  };
}
