/**
 * Crash Recovery & Mid-Task Resumption (Task #58).
 *
 * Two halves:
 *
 *   1. Checkpoint writer — `recordStepStart()` writes an `in_progress`
 *      row before each step runs; `recordStepComplete()` finalises it.
 *      Destructive steps (`destructive = true`) flush synchronously so
 *      reversal information is durable BEFORE the side-effect lands.
 *      Read-only steps flush asynchronously (`setImmediate`) so info-
 *      gathering imposes no extra latency.
 *
 *   2. Recovery flow — on startup we look for queue rows last touched
 *      AFTER the most recent clean-shutdown timestamp that are still in
 *      a non-terminal status (`running`). Those rows are flagged as
 *      `interrupted`. The recovery prompt API surfaces them along with
 *      the per-step checkpoint history so the user can resume, discard,
 *      or partial-undo before resuming.
 *
 * Resume = reset the queue row to `queued` and let the queue runner
 * pick it up again. The checkpoint history is preserved so the
 * executor's replay loop can short-circuit completed steps without
 * re-running them. Discard = mark `failed`, archive checkpoint rows
 * for 30 days then purge.
 *
 * Edge cases:
 *   - validateCheckpoint() refuses to resume if any required skill or
 *     tool referenced by an in-progress checkpoint is no longer
 *     installed in the host. The route surfaces a typed error.
 */
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  cleanShutdownLog,
  db,
  taskCheckpoints,
  taskQueueEntries,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { getToolByName } from "./tools.service";
import { getSkill } from "./skill.service";
import { listAvailableForTask, undoTask } from "./undo.service";

// ─── Types ────────────────────────────────────────────────────────────────

export type CheckpointStatus = "in_progress" | "completed" | "failed";

export interface CheckpointStartInput {
  taskId: string;
  runId?: string | null;
  stepIndex: number;
  stepKind: string;
  destructive: boolean;
  inputs?: unknown;
  summary?: string;
  requiredSkillIds?: ReadonlyArray<string>;
  requiredToolNames?: ReadonlyArray<string>;
}

export interface CheckpointCompleteInput {
  outputs?: unknown;
  toolCalls?: unknown;
  approvals?: unknown;
  summary?: string;
  status?: CheckpointStatus;
  error?: string;
}

export interface CheckpointRow {
  id: string;
  taskId: string;
  runId: string | null;
  stepIndex: number;
  stepKind: string;
  destructive: boolean;
  status: CheckpointStatus;
  summary: string | null;
  inputs: unknown;
  outputs: unknown;
  toolCalls: unknown;
  approvals: unknown;
  error: string | null;
  requiredSkillIds: ReadonlyArray<string>;
  requiredToolNames: ReadonlyArray<string>;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InterruptedTaskSummary {
  taskId: string;
  goal: string;
  status: string;
  /** True iff the row was last touched after the most recent clean shutdown. */
  crashed: boolean;
  /** True iff the row was paused cleanly during shutdown. */
  pausedAtShutdown: boolean;
  pauseReason: string | null;
  completedSteps: number;
  inProgressStep: CheckpointRow | null;
  destructiveSteps: ReadonlyArray<CheckpointRow>;
  pendingDestructiveUndo: number;
  lastUpdatedAt: string;
}

export interface RecoveryDetails extends InterruptedTaskSummary {
  history: ReadonlyArray<CheckpointRow>;
  validation: ValidationReport;
}

export interface ValidationReport {
  ok: boolean;
  missingSkills: ReadonlyArray<string>;
  missingTools: ReadonlyArray<string>;
}

export interface CleanShutdownInput {
  reason?: "normal" | "user_quit" | "system_restart" | "test";
  pausedTaskIds?: ReadonlyArray<string>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseStringArray(raw: string | null): ReadonlyArray<string> {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === "string");
}

function toCheckpointRow(r: typeof taskCheckpoints.$inferSelect): CheckpointRow {
  return {
    id: r.id,
    taskId: r.taskId,
    runId: r.runId,
    stepIndex: r.stepIndex,
    stepKind: r.stepKind,
    destructive: r.destructive === 1,
    status: r.status as CheckpointStatus,
    summary: r.summary,
    inputs: parseJson<unknown>(r.inputs, null),
    outputs: parseJson<unknown>(r.outputs, null),
    toolCalls: parseJson<unknown>(r.toolCalls, null),
    approvals: parseJson<unknown>(r.approvals, null),
    error: r.error,
    requiredSkillIds: parseStringArray(r.requiredSkillIds),
    requiredToolNames: parseStringArray(r.requiredToolNames),
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

// ─── Checkpoint writer ────────────────────────────────────────────────────

/**
 * Insert an `in_progress` checkpoint row for a step that is about to run.
 *
 * For destructive steps we await the insert so the row is durable before
 * the side-effect lands. For read-only steps we fire-and-forget on the
 * next macrotask so the executor isn't slowed down by SQLite latency.
 */
export async function recordStepStart(
  ctx: TenantContext,
  input: CheckpointStartInput,
): Promise<CheckpointRow> {
  const id = `ck_${nanoid()}`;
  const now = Date.now();
  const row = withTenantValues(ctx, {
    id,
    taskId: input.taskId,
    runId: input.runId ?? null,
    stepIndex: input.stepIndex,
    stepKind: input.stepKind,
    destructive: input.destructive ? 1 : 0,
    status: "in_progress",
    summary: input.summary ?? null,
    inputs: input.inputs === undefined ? null : JSON.stringify(input.inputs),
    requiredSkillIds: input.requiredSkillIds?.length
      ? JSON.stringify(input.requiredSkillIds)
      : null,
    requiredToolNames: input.requiredToolNames?.length
      ? JSON.stringify(input.requiredToolNames)
      : null,
    startedAt: now,
  });

  if (input.destructive) {
    await db.insert(taskCheckpoints).values(row);
  } else {
    // Async — observable via the returned promise but the caller is free
    // to drop it. We capture errors so a logger entry is still produced.
    setImmediate(() => {
      db.insert(taskCheckpoints)
        .values(row)
        .catch((e) => {
          logger.error(
            { err: e instanceof Error ? e.message : String(e), taskId: input.taskId },
            "checkpoint: async pre-write failed",
          );
        });
    });
  }

  // Return a representation of the row using the values we just inserted
  // so the caller can correlate without an extra read.
  return {
    id,
    taskId: input.taskId,
    runId: input.runId ?? null,
    stepIndex: input.stepIndex,
    stepKind: input.stepKind,
    destructive: input.destructive,
    status: "in_progress",
    summary: input.summary ?? null,
    inputs: input.inputs ?? null,
    outputs: null,
    toolCalls: null,
    approvals: null,
    error: null,
    requiredSkillIds: input.requiredSkillIds ?? [],
    requiredToolNames: input.requiredToolNames ?? [],
    startedAt: new Date(now).toISOString(),
    completedAt: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * Update the most recent in-progress checkpoint for the given id with the
 * step's outputs. Same destructive-vs-read-only flush rule as the start
 * writer.
 */
export async function recordStepComplete(
  ctx: TenantContext,
  checkpointId: string,
  destructive: boolean,
  input: CheckpointCompleteInput,
): Promise<void> {
  const now = Date.now();
  const status: CheckpointStatus = input.status ?? "completed";
  const update: Partial<typeof taskCheckpoints.$inferInsert> = {
    status,
    completedAt: now,
    updatedAt: now,
  };
  if (input.outputs !== undefined) update.outputs = JSON.stringify(input.outputs);
  if (input.toolCalls !== undefined) update.toolCalls = JSON.stringify(input.toolCalls);
  if (input.approvals !== undefined) update.approvals = JSON.stringify(input.approvals);
  if (input.summary !== undefined) update.summary = input.summary;
  if (input.error !== undefined) update.error = input.error;

  const apply = () =>
    db
      .update(taskCheckpoints)
      .set(update)
      .where(
        and(
          tenantScope(ctx, taskCheckpoints),
          eq(taskCheckpoints.id, checkpointId),
        ),
      );

  if (destructive) {
    await apply();
  } else {
    setImmediate(() => {
      apply().catch((e) => {
        logger.error(
          { err: e instanceof Error ? e.message : String(e), checkpointId },
          "checkpoint: async post-write failed",
        );
      });
    });
  }
}

/**
 * Convenience wrapper used by the test-runner to wait for any pending
 * async writer ticks to drain.
 */
export async function flushCheckpointsForTests(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ─── Read paths ───────────────────────────────────────────────────────────

export async function listCheckpointsForTask(
  ctx: TenantContext,
  taskId: string,
): Promise<ReadonlyArray<CheckpointRow>> {
  const rows = await db
    .select()
    .from(taskCheckpoints)
    .where(
      and(
        tenantScope(ctx, taskCheckpoints),
        eq(taskCheckpoints.taskId, taskId),
      ),
    )
    .orderBy(asc(taskCheckpoints.stepIndex), asc(taskCheckpoints.createdAt));
  return rows.map(toCheckpointRow);
}

// ─── Clean shutdown log ───────────────────────────────────────────────────

const SHUTDOWN_LOG_RETAIN = 200;

export async function recordCleanShutdown(
  input: CleanShutdownInput = {},
): Promise<{ id: string; shutdownAt: number }> {
  const id = `shutdown_${nanoid()}`;
  const shutdownAt = Date.now();
  await db.insert(cleanShutdownLog).values({
    id,
    reason: input.reason ?? "normal",
    pausedTaskIds: input.pausedTaskIds?.length
      ? JSON.stringify(input.pausedTaskIds)
      : null,
    pid: process.pid,
    shutdownAt,
  });
  // Prune old rows so the log can't grow without bound.
  const all = await db
    .select({ id: cleanShutdownLog.id, shutdownAt: cleanShutdownLog.shutdownAt })
    .from(cleanShutdownLog)
    .orderBy(desc(cleanShutdownLog.shutdownAt));
  if (all.length > SHUTDOWN_LOG_RETAIN) {
    const toPurge = all.slice(SHUTDOWN_LOG_RETAIN).map((r) => r.id);
    await db
      .delete(cleanShutdownLog)
      .where(inArray(cleanShutdownLog.id, toPurge));
  }
  return { id, shutdownAt };
}

export async function lastCleanShutdownAt(): Promise<number | null> {
  const rows = await db
    .select()
    .from(cleanShutdownLog)
    .orderBy(desc(cleanShutdownLog.shutdownAt))
    .limit(1);
  return rows[0]?.shutdownAt ?? null;
}

// ─── Crash detection ──────────────────────────────────────────────────────

/**
 * Returns every queue row currently in `running` whose updatedAt comes
 * AFTER the most recent clean shutdown — those are interrupted by either
 * a hard crash or a clean shutdown that paused them. The route layer
 * differentiates the two via the `pausedAtShutdown` flag.
 *
 * No tenant scope: this is a global, host-level boot probe.
 */
export async function findInterruptedTasks(): Promise<
  ReadonlyArray<InterruptedTaskSummary>
> {
  const lastShutdown = await lastCleanShutdownAt();
  const rows = await db
    .select()
    .from(taskQueueEntries)
    .where(eq(taskQueueEntries.status, "running"));
  const interrupted: InterruptedTaskSummary[] = [];
  for (const row of rows) {
    if (lastShutdown !== null && row.updatedAt <= lastShutdown) continue;
    // eslint-disable-next-line no-await-in-loop -- bounded by # of running rows
    const summary = await summariseInterruptedRow(row);
    interrupted.push(summary);
  }
  return interrupted;
}

async function summariseInterruptedRow(
  row: typeof taskQueueEntries.$inferSelect,
): Promise<InterruptedTaskSummary> {
  const ctx: TenantContext = {
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    requestId: `recovery-probe-${row.id}`,
  };
  const checkpoints = await listCheckpointsForTask(ctx, row.id);
  const completed = checkpoints.filter((c) => c.status === "completed");
  const inProgress = checkpoints.find((c) => c.status === "in_progress") ?? null;
  const destructive = checkpoints.filter(
    (c) => c.destructive && c.status === "completed",
  );
  // Cross-reference with the undo stack so the prompt can tell the user
  // exactly how many destructive steps are still reversible.
  const undoActions = await listAvailableForTask(ctx, row.id);
  const pendingDestructiveUndo = undoActions.filter((a) => a.reversible).length;
  return {
    taskId: row.id,
    goal: row.goal,
    status: row.status,
    crashed: !row.pausedAt,
    pausedAtShutdown: !!row.pausedAt,
    pauseReason: row.pauseReason,
    completedSteps: completed.length,
    inProgressStep: inProgress,
    destructiveSteps: destructive,
    pendingDestructiveUndo,
    lastUpdatedAt: new Date(row.updatedAt).toISOString(),
  };
}

// ─── Validation ───────────────────────────────────────────────────────────

/**
 * Verifies that every skill/tool referenced by an interrupted task's
 * checkpoints is still present. Surfaced before resume so the user sees
 * a precise error rather than a runtime crash.
 */
export async function validateCheckpoint(
  ctx: TenantContext,
  taskId: string,
): Promise<ValidationReport> {
  const checkpoints = await listCheckpointsForTask(ctx, taskId);
  const requiredSkills = new Set<string>();
  const requiredTools = new Set<string>();
  for (const c of checkpoints) {
    for (const id of c.requiredSkillIds) requiredSkills.add(id);
    for (const name of c.requiredToolNames) requiredTools.add(name);
  }
  const missingSkills: string[] = [];
  const missingTools: string[] = [];
  for (const id of requiredSkills) {
    // eslint-disable-next-line no-await-in-loop -- bounded by step count
    const skill = await getSkill(ctx, id);
    if (!skill) missingSkills.push(id);
  }
  for (const name of requiredTools) {
    if (!getToolByName(name)) missingTools.push(name);
  }
  return {
    ok: missingSkills.length === 0 && missingTools.length === 0,
    missingSkills,
    missingTools,
  };
}

// ─── Recovery actions ─────────────────────────────────────────────────────

export async function getRecoveryDetails(
  ctx: TenantContext,
  taskId: string,
): Promise<RecoveryDetails | null> {
  const rows = await db
    .select()
    .from(taskQueueEntries)
    .where(
      and(tenantScope(ctx, taskQueueEntries), eq(taskQueueEntries.id, taskId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const summary = await summariseInterruptedRow(row);
  const history = await listCheckpointsForTask(ctx, taskId);
  const validation = await validateCheckpoint(ctx, taskId);
  return { ...summary, history, validation };
}

export class CheckpointInvalidError extends Error {
  readonly code = "CHECKPOINT_INVALID" as const;
  constructor(public readonly report: ValidationReport) {
    super(
      `Checkpoint cannot be resumed — missing skills: [${report.missingSkills.join(
        ", ",
      )}], missing tools: [${report.missingTools.join(", ")}]`,
    );
    this.name = "CheckpointInvalidError";
  }
}

/**
 * Re-queue an interrupted task. Validation is enforced first; the queue
 * runner picks the row up on the next tick and the executor's replay
 * loop short-circuits checkpoints already marked `completed`.
 */
export async function resumeTask(
  ctx: TenantContext,
  taskId: string,
): Promise<{ resumed: true; validation: ValidationReport }> {
  const validation = await validateCheckpoint(ctx, taskId);
  if (!validation.ok) throw new CheckpointInvalidError(validation);
  const now = Date.now();
  await db
    .update(taskQueueEntries)
    .set({
      status: "queued",
      pausedAt: null,
      pauseReason: null,
      startedAt: null,
      updatedAt: now,
    })
    .where(
      and(tenantScope(ctx, taskQueueEntries), eq(taskQueueEntries.id, taskId)),
    );
  return { resumed: true, validation };
}

const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface DiscardOptions {
  /** When true, also reverses any reversible destructive checkpoints. */
  partialUndo?: boolean;
}

export async function discardTask(
  ctx: TenantContext,
  taskId: string,
  opts: DiscardOptions = {},
): Promise<{ discarded: true; reversed: number; archivedUntil: string }> {
  let reversed = 0;
  if (opts.partialUndo) {
    const result = await undoTask(ctx, taskId);
    reversed = result.undone;
  }
  const now = Date.now();
  await db
    .update(taskQueueEntries)
    .set({
      status: "failed",
      error: "Discarded after crash",
      pausedAt: null,
      pauseReason: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(tenantScope(ctx, taskQueueEntries), eq(taskQueueEntries.id, taskId)),
    );
  return {
    discarded: true,
    reversed,
    archivedUntil: new Date(now + ARCHIVE_RETENTION_MS).toISOString(),
  };
}

/**
 * Pre-resume optional partial undo, separate from discard so the route
 * can let the user review undone actions before they confirm resume.
 */
export async function partialUndoBeforeResume(
  ctx: TenantContext,
  taskId: string,
): Promise<{ reversed: number }> {
  const result = await undoTask(ctx, taskId);
  return { reversed: result.undone };
}

// ─── Pruning ──────────────────────────────────────────────────────────────

/**
 * Purge checkpoint rows belonging to discarded tasks older than the
 * 30-day archive window. Run on each shutdown / startup so the table
 * never grows unbounded.
 */
export async function purgeArchivedCheckpoints(): Promise<number> {
  const cutoff = Date.now() - ARCHIVE_RETENTION_MS;
  // We can't join from this layer cleanly with drizzle, so do two reads.
  const archived = await db
    .select({ id: taskQueueEntries.id })
    .from(taskQueueEntries)
    .where(
      and(
        eq(taskQueueEntries.status, "failed"),
        lt(taskQueueEntries.completedAt, cutoff),
      ),
    );
  if (archived.length === 0) return 0;
  const ids = archived.map((r) => r.id);
  const result = await db
    .delete(taskCheckpoints)
    .where(inArray(taskCheckpoints.taskId, ids));
  return Number((result as { changes?: number }).changes ?? 0);
}

// ─── Pause / resume on shutdown ───────────────────────────────────────────

/**
 * Mark every still-running task as paused (cleanly) and return their ids.
 * The caller (the shutdown handler) will then write a clean-shutdown row
 * referencing those ids so the next-launch detector can label the rows
 * "paused due to shutdown" instead of "abandoned by crash".
 */
export async function pauseRunningTasksForShutdown(
  reason: string,
): Promise<ReadonlyArray<string>> {
  const rows = await db
    .select({ id: taskQueueEntries.id })
    .from(taskQueueEntries)
    .where(eq(taskQueueEntries.status, "running"));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const now = Date.now();
  await db
    .update(taskQueueEntries)
    .set({ pausedAt: now, pauseReason: reason, updatedAt: now })
    .where(inArray(taskQueueEntries.id, ids));
  return ids;
}
