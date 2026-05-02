/**
 * Diagnostics service — Step 6 of Task #31 (Error Handling & Graceful
 * Degradation).
 *
 * Owns the local detailed error log surfaced via the help panel and the
 * persistent-error escalator that promotes recurring failures to the
 * notification centre.
 *
 * Design choices:
 *  - In-memory ring buffer per process (bounded at MAX_ENTRIES). The point
 *    of the log is to give the user immediate context after a problem; long-
 *    term diagnostics live in the structured pino logs on disk.
 *  - Frequency tracking is per-tenant + per-code. Once the same code fires
 *    `ESCALATE_AT` times within `WINDOW_MS`, we open a notification with
 *    escalating severity ("warning" first time, "error" thereafter) so the
 *    user is not silently absorbing the same failure over and over.
 *  - The escalator is best-effort. Notification creation failures are logged
 *    but never thrown — diagnostics MUST never become a new failure source.
 *  - Disk health is exposed through `getDiskHealth()` which delegates to
 *    `@workspace/errors`' `DiskMonitor`.
 */
import {
  DiskMonitor,
  DISK_THRESHOLDS,
  getUserMessage,
  type DiskStatus,
  type ErrorSeverity,
  type UserMessage,
} from "@workspace/errors";
import { LRUCache } from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { createNotification } from "./notifications.service";

export interface DiagnosticEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly tenantId: string | null;
  readonly code: string;
  readonly message: string;
  readonly action: string;
  readonly severity: ErrorSeverity;
  readonly httpStatus: number;
  readonly requestId: string | null;
  readonly path: string | null;
  readonly method: string | null;
  /** Snippet of the underlying cause for support diagnostics. Never shown to users. */
  readonly causeSnippet: string | null;
}

export interface RecordEventInput {
  readonly code: string;
  readonly httpStatus: number;
  readonly tenantId?: string | null;
  readonly requestId?: string | null;
  readonly path?: string | null;
  readonly method?: string | null;
  readonly cause?: unknown;
}

const MAX_ENTRIES = 200;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const ESCALATE_AT = 3;
const ESCALATE_COOLDOWN_MS = 5 * 60 * 1000;

interface FrequencyState {
  count: number;
  windowStart: number;
  lastEscalatedAt: number;
  escalations: number;
}

// tier-review: bounded — fixed-length ring buffer (MAX_ENTRIES) trimmed on every push.
const ringBuffer: DiagnosticEntry[] = [];
// LRUCache (Standard 13) — bounded by `max` AND `ttl` so a noisy tenant cannot
// grow the frequency table without limit. Entries fall out automatically once
// the 10-minute window closes, so no manual sweeper is required.
const frequency = new LRUCache<string, FrequencyState>({
  max: 5_000,
  ttl: WINDOW_MS,
  ttlAutopurge: true,
});
const diskMonitor = new DiskMonitor();

export function recordErrorEvent(input: RecordEventInput): DiagnosticEntry {
  const user: UserMessage = getUserMessage(input.code);
  const entry: DiagnosticEntry = {
    id: makeId(),
    timestamp: new Date().toISOString(),
    tenantId: input.tenantId ?? null,
    code: input.code,
    message: user.message,
    action: user.action,
    severity: user.severity,
    httpStatus: input.httpStatus,
    requestId: input.requestId ?? null,
    path: input.path ?? null,
    method: input.method ?? null,
    causeSnippet: snippet(input.cause),
  };

  ringBuffer.push(entry);
  if (ringBuffer.length > MAX_ENTRIES) {
    ringBuffer.splice(0, ringBuffer.length - MAX_ENTRIES);
  }

  if (entry.tenantId) {
    void maybeEscalate(entry).catch((escalationErr) => {
      logger.warn(
        { err: escalationErr, code: entry.code, tenantId: entry.tenantId },
        "Diagnostic escalation failed",
      );
    });
  }

  return entry;
}

export function listErrorEvents(options: {
  tenantId?: string | null;
  limit?: number;
} = {}): ReadonlyArray<DiagnosticEntry> {
  const limit = clampLimit(options.limit ?? 50);
  const filtered = options.tenantId
    ? ringBuffer.filter((e) => e.tenantId === options.tenantId)
    : ringBuffer.slice();
  // Newest first.
  return filtered.slice(-limit).reverse();
}

export function clearErrorEvents(tenantId?: string | null): { cleared: number } {
  if (!tenantId) {
    const cleared = ringBuffer.length;
    ringBuffer.length = 0;
    frequency.clear();
    return { cleared };
  }
  let cleared = 0;
  for (let i = ringBuffer.length - 1; i >= 0; i--) {
    if (ringBuffer[i]!.tenantId === tenantId) {
      ringBuffer.splice(i, 1);
      cleared++;
    }
  }
  const prefix = `${tenantId}::`;
  for (const key of Array.from(frequency.keys())) {
    if (key.startsWith(prefix)) frequency.delete(key);
  }
  return { cleared };
}

export interface DiskHealthReport {
  readonly status: DiskStatus;
  readonly thresholds: {
    readonly warningBytes: number;
    readonly criticalBytes: number;
  };
  readonly checkedAt: string;
}

export async function getDiskHealth(path: string): Promise<DiskHealthReport> {
  const status = await diskMonitor.check(path);
  return {
    status,
    thresholds: {
      warningBytes: DISK_THRESHOLDS.WARNING_BYTES,
      criticalBytes: DISK_THRESHOLDS.CRITICAL_BYTES,
    },
    checkedAt: new Date().toISOString(),
  };
}

/* ---------------- internals ---------------- */

async function maybeEscalate(entry: DiagnosticEntry): Promise<void> {
  if (!entry.tenantId) return;
  const key = `${entry.tenantId}::${entry.code}`;
  const now = Date.now();
  const state = frequency.get(key);
  const next: FrequencyState =
    state && now - state.windowStart < WINDOW_MS
      ? { ...state, count: state.count + 1 }
      : { count: 1, windowStart: now, lastEscalatedAt: 0, escalations: state?.escalations ?? 0 };

  if (
    next.count >= ESCALATE_AT &&
    now - next.lastEscalatedAt >= ESCALATE_COOLDOWN_MS
  ) {
    next.lastEscalatedAt = now;
    next.escalations += 1;
    frequency.set(key, next);
    await pushEscalationNotification(entry, next);
    return;
  }

  frequency.set(key, next);
}

async function pushEscalationNotification(
  entry: DiagnosticEntry,
  state: FrequencyState,
): Promise<void> {
  if (!entry.tenantId) return;

  const ctx: TenantContext = {
    tenantId: entry.tenantId,
    requestId: entry.requestId ?? "diagnostics",
  };

  const repeated = state.count;
  const escalations = state.escalations;
  const severity = escalations >= 2 ? "error" : "warning";

  const guidance =
    escalations === 1
      ? "Operator has hit this problem repeatedly in a short window. Review the suggested fix below."
      : escalations === 2
        ? "This problem keeps happening. If retrying didn't help, open the help panel for full diagnostics."
        : "This problem is persistent. Consider restarting Operator or contacting support from the help panel.";

  try {
    await createNotification(ctx, {
      category: "error",
      severity,
      title: `Repeated problem: ${entry.message}`,
      body: `${entry.action} ${guidance} (occurred ${repeated} times in the last 10 minutes)`,
      actionLabel: "Open diagnostics",
      actionHref: "/operator/activity",
    });
  } catch (notifyErr) {
    logger.warn(
      { err: notifyErr, code: entry.code, tenantId: entry.tenantId },
      "Could not push escalation notification",
    );
  }
}

function snippet(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Error) {
    const base = `${value.name}: ${value.message}`;
    return base.length > 500 ? `${base.slice(0, 500)}…` : base;
  }
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    if (!s) return null;
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return null;
  }
}

function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return 50;
  if (n < 1) return 1;
  if (n > MAX_ENTRIES) return MAX_ENTRIES;
  return Math.floor(n);
}

function makeId(): string {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Test-only helper. */
export function __resetDiagnosticsForTests(): void {
  ringBuffer.length = 0;
  frequency.clear();
}
