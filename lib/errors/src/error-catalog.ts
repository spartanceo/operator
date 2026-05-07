/**
 * User-facing error message catalog — Step 6 (foundation) of Task #31.
 *
 * Every error code that may surface to the user MUST have an entry here.
 * The contract is:
 *   - `message`  — one short sentence in plain English. No stack traces, no
 *                  technical jargon, no error codes.
 *   - `action`   — what the user should do next. Always actionable, never a
 *                  dead end.
 *   - `severity` — how the UI should style the message and decide whether to
 *                  escalate to the notification centre.
 *
 * `getUserMessage(code)` is the single read path; consumers (UI, notifications,
 * the API error mapper) NEVER inline message strings.
 */

export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export interface UserMessage {
  readonly message: string;
  readonly action: string;
  readonly severity: ErrorSeverity;
}

const CATALOG: Readonly<Record<string, UserMessage>> = {
  /* ---------- Generic ---------- */
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

  /* ---------- Auth & tenancy ---------- */
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
  TENANT_ISOLATION: {
    message: "That information belongs to a different workspace.",
    action: "Switch to the right workspace and try again.",
    severity: "error",
  },
  OAUTH_EXPIRED: {
    message: "Your sign-in with the connected service has expired.",
    action: "Reconnect the service in Settings → Integrations.",
    severity: "warning",
  },

  /* ---------- Network ---------- */
  TIMEOUT: {
    message: "That took longer than expected.",
    action: "Try again. If it keeps happening, check your network.",
    severity: "warning",
  },
  CIRCUIT_OPEN: {
    message: "A service is having trouble right now and Operator is giving it a moment to recover.",
    action: "Try again in a minute.",
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

  /* ---------- Configuration ---------- */
  RUNTIME_KEY_SECRET_MISSING: {
    message: "Encryption key not configured — credential storage is unavailable.",
    action: "Set the RUNTIME_KEY_SECRET environment variable to a 32+ character random value and restart the server.",
    severity: "error",
  },

  /* ---------- Model / runtime ---------- */
  OLLAMA_UNAVAILABLE: {
    message: "Your local AI isn't running yet.",
    action: "Start Ollama, or click 'Set up AI' to install it.",
    severity: "error",
  },
  MODEL_ERROR: {
    message: "The AI model couldn't finish what it was working on.",
    action: "Retry the request, or switch to a smaller model in Settings.",
    severity: "error",
  },
  MODEL_OOM: {
    message: "The AI model ran out of memory.",
    action: "Switch to a smaller model — Operator can suggest one for you.",
    severity: "error",
  },

  /* ---------- Tools ---------- */
  TOOL_FAILED: {
    message: "A step in your task didn't complete successfully.",
    action: "Retry the step, skip it, or stop the task — your call.",
    severity: "error",
  },

  /* ---------- Storage ---------- */
  STORAGE_ERROR: {
    message: "Operator couldn't access your local data.",
    action: "Try again. If the problem persists, restart Operator.",
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

  /* ---------- Integrations ---------- */
  INTEGRATION_FAILED: {
    message: "A connected service didn't respond correctly.",
    action: "Operator will keep retrying. You can also reconnect the service in Settings.",
    severity: "warning",
  },

  /* ---------- HTTP nicety ---------- */
  NOT_FOUND: {
    message: "Operator couldn't find what you were asking for.",
    action: "Check the link or refresh the page.",
    severity: "info",
  },
};

const FALLBACK: UserMessage = {
  message: "Something went wrong.",
  action: "Try again. If the problem persists, open the help panel.",
  severity: "error",
};

export function getUserMessage(code: string): UserMessage {
  return CATALOG[code] ?? FALLBACK;
}

export function knownErrorCodes(): ReadonlyArray<string> {
  return Object.keys(CATALOG);
}

export function hasUserMessage(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG, code);
}
