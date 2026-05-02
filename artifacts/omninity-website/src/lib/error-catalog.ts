/**
 * Browser-side mirror of the @workspace/errors catalog.
 *
 * We can't import `@workspace/errors` directly because that package pulls
 * in `node:fs/promises` (the disk monitor). The full catalog is fetched
 * once at boot via `useGetDiagnosticCatalog()` and merged into the static
 * fallbacks below — that way unknown codes still get a graceful message
 * even if the network call hasn't returned yet.
 */
export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export interface CatalogEntry {
  readonly message: string;
  readonly action: string;
  readonly severity: ErrorSeverity;
}

export interface DescribedError extends CatalogEntry {
  /** True when the error code was found in the catalog (live or fallback). */
  readonly knownCode: boolean;
}

const FALLBACK_ENTRY: CatalogEntry = {
  message: "Something went wrong.",
  action: "Try again. If the problem persists, open the help panel.",
  severity: "error",
};

/**
 * Static fallbacks used before the live catalog has loaded. Keep this list
 * in sync with `lib/errors/src/error-catalog.ts` for the codes most likely
 * to surface during the first few seconds of a session.
 */
const STATIC_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  INTERNAL: {
    message: "Something went wrong on our end.",
    action: "Try again. If the problem keeps happening, open the help panel.",
    severity: "error",
  },
  RUNTIME_ERROR: {
    message: "Operator hit an unexpected problem while running your task.",
    action: "Retry the task. The detailed log is available in the help panel.",
    severity: "error",
  },
  INVALID_INPUT: {
    message: "Some of the information provided isn't valid.",
    action: "Check the highlighted fields and try again.",
    severity: "warning",
  },
  UNAUTHENTICATED: {
    message: "You need to sign in to do that.",
    action: "Sign in and try again.",
    severity: "warning",
  },
  PERMISSION_DENIED: {
    message: "Operator doesn't have the permission it needs to do that.",
    action: "Open System Settings to grant the requested permission.",
    severity: "warning",
  },
  NOT_FOUND: {
    message: "Operator couldn't find what you were asking for.",
    action: "Check the link or refresh the page.",
    severity: "info",
  },
  TIMEOUT: {
    message: "That took longer than expected.",
    action: "Try again. If it keeps happening, check your network.",
    severity: "warning",
  },
  NETWORK_ERROR: {
    message: "Operator couldn't reach the network.",
    action: "Check your internet connection and try again.",
    severity: "warning",
  },
  RATE_LIMITED: {
    message: "Operator is sending requests too quickly to a service.",
    action: "Operator will retry automatically — no action needed.",
    severity: "info",
  },
  OLLAMA_UNAVAILABLE: {
    message: "Your local AI isn't running yet.",
    action: "Start Ollama, or click 'Set up AI' to install it.",
    severity: "error",
  },
  MODEL_OOM: {
    message: "The AI model ran out of memory.",
    action: "Switch to a smaller model — Operator can suggest one for you.",
    severity: "error",
  },
  TOOL_FAILED: {
    message: "A step in your task didn't complete successfully.",
    action: "Retry the step, skip it, or stop the task — your call.",
    severity: "error",
  },
  FILE_NOT_FOUND: {
    message: "Operator couldn't find the file it was looking for.",
    action: "Locate the file and try again.",
    severity: "warning",
  },
  DISK_SPACE_LOW: {
    message: "Your disk is running out of space.",
    action: "Free up space — Operator paused background tasks until you do.",
    severity: "critical",
  },
  OAUTH_EXPIRED: {
    message: "Your sign-in with the connected service has expired.",
    action: "Reconnect the service in Settings → Integrations.",
    severity: "warning",
  },
  SAFE_MODE: {
    message: "Operator is in safe mode and can only read your data right now.",
    action: "Restart the app or restore from a backup to enable changes again.",
    severity: "warning",
  },
};

/** Live catalog populated from /api/diagnostics/catalog at runtime. */
let liveCatalog: Readonly<Record<string, CatalogEntry>> = {};

export function setLiveCatalog(entries: ReadonlyArray<CatalogEntry & { code: string }>): void {
  const next: Record<string, CatalogEntry> = {};
  for (const e of entries) {
    next[e.code] = { message: e.message, action: e.action, severity: e.severity };
  }
  liveCatalog = next;
}

export function describeErrorCode(code: string | undefined | null): DescribedError {
  if (!code) {
    return { ...FALLBACK_ENTRY, knownCode: false };
  }
  const entry = liveCatalog[code] ?? STATIC_CATALOG[code];
  if (entry) return { ...entry, knownCode: true };
  return { ...FALLBACK_ENTRY, knownCode: false };
}
