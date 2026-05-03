/**
 * Schedules service — scheduled & recurring tasks (Task #45).
 *
 * Responsibilities:
 *   - CRUD on `scheduled_tasks` and per-tenant `schedule_settings`.
 *   - Compute / refresh `next_run_at` from the cron expression.
 *   - The scheduler engine (`startScheduler`) ticks every TICK_MS,
 *     enumerates due rows across every tenant, and fires them through
 *     `createAgentRun()` so the agent loop respects the existing
 *     approval-gate plumbing (risky tools still raise approvals; the
 *     scheduler just creates the run).
 *   - Wake-from-sleep handling: the tick computes how long it has been
 *     since `last_tick_at` and emits a `missed` history row + summary
 *     notification when the gap is greater than 2 ticks AND a row that
 *     should have fired during the gap is now overdue.
 *
 * Per Standard 1, every public function returns plain JSON-friendly rows
 * — never the raw drizzle row — so route handlers can wrap them in `ok()`
 * without re-mapping.
 */
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  scheduleSettings,
  scheduledTaskRuns,
  scheduledTasks,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { runWithTenantContext } from "../lib/tenant-context";
import { createAgentRun } from "./agent.service";
import { createNotification } from "./notifications.service";
import {
  CronParseError,
  nextFireAfter,
  nextFires,
  validateCron,
} from "./schedule-cron";
import {
  parseNaturalLanguageSchedule,
  ScheduleParseError,
  type RecurrenceKind,
} from "./schedule-nl";

// Scheduler tick — one minute matches the cron resolution and is cheap.
const TICK_MS = 60_000;
// History pruning threshold — keep the newest 10 rows per schedule.
const HISTORY_KEEP = 10;

// ─── Public types ──────────────────────────────────────────────────────────

export interface ScheduledTaskRow {
  id: string;
  title: string;
  prompt: string;
  cronExpression: string;
  naturalLanguage: string | null;
  timezone: string;
  recurrenceKind: string;
  paused: boolean;
  taskContext: unknown;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunSummary: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskRunRow {
  id: string;
  scheduledTaskId: string;
  scheduledFor: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  summary: string | null;
  error: string | null;
  agentRunId: string | null;
  triggerKind: string;
  createdAt: string;
}

export interface ScheduleSettingsRow {
  globalPaused: boolean;
  lastTickAt: string | null;
  updatedAt: string;
}

export interface CreateScheduleInput {
  title: string;
  prompt: string;
  cronExpression?: string;
  naturalLanguage?: string;
  tzOffsetMinutes?: number;
  timezone?: string;
  taskContext?: unknown;
  recurrenceKind?: RecurrenceKind;
}

export interface UpdateScheduleInput {
  title?: string;
  prompt?: string;
  cronExpression?: string;
  naturalLanguage?: string;
  tzOffsetMinutes?: number;
  timezone?: string;
  taskContext?: unknown;
  paused?: boolean;
  recurrenceKind?: RecurrenceKind;
}

export class ScheduleNotFoundError extends Error {
  override readonly name = "ScheduleNotFoundError";
  readonly code = "SCHEDULE_NOT_FOUND";
  constructor(id: string) {
    super(`Scheduled task "${id}" not found`);
  }
}

// Re-export the parser errors so the route layer can `instanceof`-check.
export { CronParseError, ScheduleParseError };

// ─── Mappers ───────────────────────────────────────────────────────────────

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toRow(r: typeof scheduledTasks.$inferSelect): ScheduledTaskRow {
  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    cronExpression: r.cronExpression,
    naturalLanguage: r.naturalLanguage,
    timezone: r.timezone,
    recurrenceKind: r.recurrenceKind,
    paused: Boolean(r.paused),
    taskContext: parseJson(r.taskContext),
    lastRunAt: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
    lastRunStatus: r.lastRunStatus,
    lastRunSummary: r.lastRunSummary,
    nextRunAt: r.nextRunAt ? new Date(r.nextRunAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toRunRow(r: typeof scheduledTaskRuns.$inferSelect): ScheduledTaskRunRow {
  return {
    id: r.id,
    scheduledTaskId: r.scheduledTaskId,
    scheduledFor: new Date(r.scheduledFor).toISOString(),
    startedAt: new Date(r.startedAt).toISOString(),
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    status: r.status,
    summary: r.summary,
    error: r.error,
    agentRunId: r.agentRunId,
    triggerKind: r.triggerKind,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

function toSettingsRow(
  r: typeof scheduleSettings.$inferSelect,
): ScheduleSettingsRow {
  return {
    globalPaused: Boolean(r.globalPaused),
    lastTickAt: r.lastTickAt ? new Date(r.lastTickAt).toISOString() : null,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

// ─── Resolution helpers ────────────────────────────────────────────────────

function resolveCron(
  inputCron: string | undefined,
  inputNl: string | undefined,
  tzOffsetMinutes: number,
): { cron: string; recurrence: RecurrenceKind; nl: string | null } {
  if (inputNl && inputNl.trim().length > 0) {
    const parsed = parseNaturalLanguageSchedule(inputNl, tzOffsetMinutes);
    return {
      cron: parsed.cronExpression,
      recurrence: parsed.recurrenceKind,
      nl: inputNl,
    };
  }
  if (inputCron && inputCron.trim().length > 0) {
    validateCron(inputCron);
    return { cron: inputCron, recurrence: "custom", nl: null };
  }
  throw new ScheduleParseError(
    "A schedule requires either `cronExpression` or `naturalLanguage`.",
  );
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

export function previewSchedule(
  naturalLanguage: string | undefined,
  cronExpression: string | undefined,
  tzOffsetMinutes: number,
  count = 3,
): { cronExpression: string; recurrenceKind: RecurrenceKind; nextRuns: string[] } {
  const resolved = resolveCron(cronExpression, naturalLanguage, tzOffsetMinutes);
  const fires = nextFires(resolved.cron, Date.now(), count);
  return {
    cronExpression: resolved.cron,
    recurrenceKind: resolved.recurrence,
    nextRuns: fires.map((ms) => new Date(ms).toISOString()),
  };
}

export async function createSchedule(
  ctx: TenantContext,
  input: CreateScheduleInput,
): Promise<ScheduledTaskRow> {
  const tz = input.tzOffsetMinutes ?? 0;
  const resolved = resolveCron(
    input.cronExpression,
    input.naturalLanguage,
    tz,
  );
  const id = `sch_${nanoid()}`;
  const next = nextFireAfter(resolved.cron, Date.now());
  await db.insert(scheduledTasks).values(
    withTenantValues(ctx, {
      id,
      title: input.title,
      prompt: input.prompt,
      cronExpression: resolved.cron,
      naturalLanguage: resolved.nl,
      timezone: input.timezone ?? "UTC",
      recurrenceKind: input.recurrenceKind ?? resolved.recurrence,
      paused: 0,
      taskContext:
        input.taskContext === undefined ? null : JSON.stringify(input.taskContext),
      nextRunAt: next,
    }),
  );
  const row = await getSchedule(ctx, id);
  if (!row) throw new Error("Schedule vanished after insert");
  return row;
}

export async function getSchedule(
  ctx: TenantContext,
  id: string,
): Promise<ScheduledTaskRow | null> {
  const rows = await db
    .select()
    .from(scheduledTasks)
    .where(and(tenantScope(ctx, scheduledTasks), eq(scheduledTasks.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listSchedules(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<ScheduledTaskRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(
          tenantScope(ctx, scheduledTasks),
          lt(scheduledTasks.createdAt, cursorTs),
        )
      : tenantScope(ctx, scheduledTasks);
  const rows = await db
    .select()
    .from(scheduledTasks)
    .where(where)
    .orderBy(desc(scheduledTasks.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function updateSchedule(
  ctx: TenantContext,
  id: string,
  input: UpdateScheduleInput,
): Promise<ScheduledTaskRow> {
  const existing = await getSchedule(ctx, id);
  if (!existing) throw new ScheduleNotFoundError(id);

  // tier-review: bounded — only known column writes are produced below.
  const patch: Record<string, unknown> = { updatedAt: Date.now() };

  if (input.title !== undefined) patch["title"] = input.title;
  if (input.prompt !== undefined) patch["prompt"] = input.prompt;
  if (input.timezone !== undefined) patch["timezone"] = input.timezone;
  if (input.taskContext !== undefined) {
    patch["taskContext"] =
      input.taskContext === null ? null : JSON.stringify(input.taskContext);
  }
  if (input.paused !== undefined) {
    patch["paused"] = input.paused ? 1 : 0;
  }

  if (
    input.cronExpression !== undefined ||
    input.naturalLanguage !== undefined
  ) {
    const tz = input.tzOffsetMinutes ?? 0;
    const resolved = resolveCron(
      input.cronExpression ?? existing.cronExpression,
      input.naturalLanguage ?? undefined,
      tz,
    );
    patch["cronExpression"] = resolved.cron;
    patch["naturalLanguage"] = resolved.nl;
    patch["recurrenceKind"] =
      input.recurrenceKind ?? resolved.recurrence;
    patch["nextRunAt"] = nextFireAfter(resolved.cron, Date.now());
  } else if (input.recurrenceKind !== undefined) {
    patch["recurrenceKind"] = input.recurrenceKind;
  }

  await db
    .update(scheduledTasks)
    .set(patch as Partial<typeof scheduledTasks.$inferInsert>)
    .where(and(tenantScope(ctx, scheduledTasks), eq(scheduledTasks.id, id)));

  const row = await getSchedule(ctx, id);
  if (!row) throw new ScheduleNotFoundError(id);
  return row;
}

export async function deleteSchedule(
  ctx: TenantContext,
  id: string,
): Promise<{ deleted: true; id: string }> {
  const existing = await getSchedule(ctx, id);
  if (!existing) throw new ScheduleNotFoundError(id);
  await db
    .delete(scheduledTaskRuns)
    .where(
      and(
        tenantScope(ctx, scheduledTaskRuns),
        eq(scheduledTaskRuns.scheduledTaskId, id),
      ),
    );
  await db
    .delete(scheduledTasks)
    .where(and(tenantScope(ctx, scheduledTasks), eq(scheduledTasks.id, id)));
  return { deleted: true, id };
}

// ─── History ───────────────────────────────────────────────────────────────

export async function listScheduleRuns(
  ctx: TenantContext,
  scheduleId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<ScheduledTaskRunRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = and(
    tenantScope(ctx, scheduledTaskRuns),
    eq(scheduledTaskRuns.scheduledTaskId, scheduleId),
  );
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(scheduledTaskRuns.startedAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(scheduledTaskRuns)
    .where(where)
    .orderBy(desc(scheduledTaskRuns.startedAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRunRow), limit, (r) =>
    String(new Date(r.startedAt).getTime()),
  );
}

async function pruneHistory(
  ctx: TenantContext,
  scheduleId: string,
): Promise<void> {
  const rows = await db
    .select({ id: scheduledTaskRuns.id, startedAt: scheduledTaskRuns.startedAt })
    .from(scheduledTaskRuns)
    .where(
      and(
        tenantScope(ctx, scheduledTaskRuns),
        eq(scheduledTaskRuns.scheduledTaskId, scheduleId),
      ),
    )
    .orderBy(desc(scheduledTaskRuns.startedAt));
  if (rows.length <= HISTORY_KEEP) return;
  const cutoff = rows[HISTORY_KEEP]!.startedAt;
  await db
    .delete(scheduledTaskRuns)
    .where(
      and(
        tenantScope(ctx, scheduledTaskRuns),
        eq(scheduledTaskRuns.scheduledTaskId, scheduleId),
        lt(scheduledTaskRuns.startedAt, cutoff + 1),
      ),
    );
}

// ─── Settings (global pause + last-tick) ───────────────────────────────────

async function ensureSettings(
  ctx: TenantContext,
): Promise<typeof scheduleSettings.$inferSelect> {
  const existing = await db
    .select()
    .from(scheduleSettings)
    .where(tenantScope(ctx, scheduleSettings))
    .limit(1);
  if (existing[0]) return existing[0];
  const id = `schset_${nanoid()}`;
  await db.insert(scheduleSettings).values(
    withTenantValues(ctx, {
      id,
      globalPaused: 0,
    }),
  );
  const created = await db
    .select()
    .from(scheduleSettings)
    .where(tenantScope(ctx, scheduleSettings))
    .limit(1);
  if (!created[0]) throw new Error("schedule_settings missing after insert");
  return created[0];
}

export async function getScheduleSettings(
  ctx: TenantContext,
): Promise<ScheduleSettingsRow> {
  const row = await ensureSettings(ctx);
  return toSettingsRow(row);
}

export async function setGlobalPause(
  ctx: TenantContext,
  paused: boolean,
): Promise<ScheduleSettingsRow> {
  await ensureSettings(ctx);
  await db
    .update(scheduleSettings)
    .set({ globalPaused: paused ? 1 : 0, updatedAt: Date.now() })
    .where(tenantScope(ctx, scheduleSettings));
  return getScheduleSettings(ctx);
}

async function touchTick(ctx: TenantContext, tickAt: number): Promise<void> {
  await ensureSettings(ctx);
  await db
    .update(scheduleSettings)
    .set({ lastTickAt: tickAt, updatedAt: Date.now() })
    .where(tenantScope(ctx, scheduleSettings));
}

// ─── Trigger one schedule ──────────────────────────────────────────────────

export async function triggerScheduleNow(
  ctx: TenantContext,
  scheduleId: string,
): Promise<ScheduledTaskRunRow> {
  const schedule = await getSchedule(ctx, scheduleId);
  if (!schedule) throw new ScheduleNotFoundError(scheduleId);
  return runOnce(ctx, schedule, Date.now(), "manual");
}

async function runOnce(
  ctx: TenantContext,
  schedule: ScheduledTaskRow,
  scheduledFor: number,
  triggerKind: "scheduled" | "manual" | "missed-recovery",
): Promise<ScheduledTaskRunRow> {
  const runRowId = `schrun_${nanoid()}`;
  const now = Date.now();
  await db.insert(scheduledTaskRuns).values(
    withTenantValues(ctx, {
      id: runRowId,
      scheduledTaskId: schedule.id,
      scheduledFor,
      startedAt: now,
      status: "running",
      triggerKind,
    }),
  );

  let agentRunId: string | null = null;
  let status: "succeeded" | "failed" = "succeeded";
  let summary: string | null = null;
  let error: string | null = null;
  try {
    const ctxObj =
      schedule.taskContext && typeof schedule.taskContext === "object"
        ? (schedule.taskContext as Record<string, unknown>)
        : {};
    const modelName =
      typeof ctxObj["modelName"] === "string"
        ? (ctxObj["modelName"] as string)
        : undefined;
    const conversationId =
      typeof ctxObj["conversationId"] === "string"
        ? (ctxObj["conversationId"] as string)
        : undefined;
    const knowledgeCollectionId =
      typeof ctxObj["knowledgeCollectionId"] === "string"
        ? (ctxObj["knowledgeCollectionId"] as string)
        : undefined;
    const useKnowledgeBase =
      typeof ctxObj["useKnowledgeBase"] === "boolean"
        ? (ctxObj["useKnowledgeBase"] as boolean)
        : undefined;

    const run = await createAgentRun(ctx, {
      goal: schedule.prompt,
      ...(modelName ? { modelName } : {}),
      ...(useKnowledgeBase !== undefined ? { useKnowledgeBase } : {}),
      ...(knowledgeCollectionId ? { knowledgeCollectionId } : {}),
      ...(conversationId ? { conversationId } : {}),
    });
    agentRunId = run.id;
    if (run.status === "failed" || run.status === "cancelled") {
      status = "failed";
      summary = run.summary ?? null;
      error = run.error ?? null;
      await safeNotify(ctx, {
        category: "error",
        severity: "error",
        title: `Scheduled task failed: ${schedule.title}`,
        body: error ?? "The scheduled run did not complete.",
        relatedRunId: run.id,
      });
    } else {
      summary = run.summary ?? null;
      await safeNotify(ctx, {
        category: "task",
        severity: "success",
        title: `Scheduled task ran: ${schedule.title}`,
        body: summary ?? "The scheduled run completed successfully.",
        relatedRunId: run.id,
      });
    }
  } catch (e) {
    status = "failed";
    error = e instanceof Error ? e.message : String(e);
    summary = null;
    logger.warn(
      { err: e, scheduleId: schedule.id },
      "Scheduled task: agent run failed",
    );
    await safeNotify(ctx, {
      category: "error",
      severity: "error",
      title: `Scheduled task failed: ${schedule.title}`,
      body: error,
    });
  }

  const completedAt = Date.now();
  await db
    .update(scheduledTaskRuns)
    .set({
      status,
      summary,
      error,
      agentRunId,
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        tenantScope(ctx, scheduledTaskRuns),
        eq(scheduledTaskRuns.id, runRowId),
      ),
    );

  const nextAt = nextFireAfter(schedule.cronExpression, completedAt);
  await db
    .update(scheduledTasks)
    .set({
      lastRunAt: completedAt,
      lastRunStatus: status,
      lastRunSummary: summary,
      nextRunAt: nextAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        tenantScope(ctx, scheduledTasks),
        eq(scheduledTasks.id, schedule.id),
      ),
    );

  await pruneHistory(ctx, schedule.id);

  const refreshed = await db
    .select()
    .from(scheduledTaskRuns)
    .where(
      and(
        tenantScope(ctx, scheduledTaskRuns),
        eq(scheduledTaskRuns.id, runRowId),
      ),
    )
    .limit(1);
  return toRunRow(refreshed[0]!);
}

async function safeNotify(
  ctx: TenantContext,
  input: Parameters<typeof createNotification>[1],
): Promise<void> {
  try {
    await createNotification(ctx, input);
  } catch (e) {
    logger.warn({ err: e }, "Schedule notification failed");
  }
}

// ─── Scheduler engine ──────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

/**
 * Start the scheduler tick. Idempotent — calling twice is a no-op.
 *
 * The tick walks every tenant that has a `schedule_settings` row OR any
 * `scheduled_tasks` row, then for each tenant fires every overdue
 * schedule under that tenant's context. Wake-from-sleep detection lives
 * here too: if the tenant's `last_tick_at` was more than 2 ticks ago we
 * record a `missed-recovery` history row and notify the user before
 * re-firing the schedule.
 */
export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tickAll().catch((e) => {
      logger.error({ err: e }, "Scheduler tick crashed");
    });
  }, TICK_MS);
  // Allow the process to exit even if the timer is still pending — tests
  // create/destroy the server in tight loops; an active interval would
  // otherwise hang teardown.
  if (typeof timer.unref === "function") timer.unref();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Single tick — exposed for tests and the route-driven manual fire.
 */
export async function tickAll(now = Date.now()): Promise<{
  tenantsScanned: number;
  fired: number;
  missedRecovered: number;
}> {
  let tenantsScanned = 0;
  let fired = 0;
  let missedRecovered = 0;

  // Find every tenant that has at least one scheduled_tasks row. We can't
  // use a true cross-tenant scan without breaking the tenantScope helper
  // contract, so this query reads the raw column directly — it returns
  // tenant IDs only, never row data.
  const tenantRows = await db
    .selectDistinct({ tenantId: scheduledTasks.tenantId })
    .from(scheduledTasks);

  for (const t of tenantRows) {
    const ctx: TenantContext = {
      tenantId: t.tenantId,
      // Workspace fan-out happens inside the tick — every schedule row
      // already carries its workspace_id; tenantScope only needs tenantId.
      requestId: `scheduler-${now}`,
    };
    tenantsScanned += 1;
    const result = await runWithTenantContext(ctx, () =>
      tickTenant(ctx, now),
    );
    fired += result.fired;
    missedRecovered += result.missedRecovered;
  }

  return { tenantsScanned, fired, missedRecovered };
}

async function tickTenant(
  ctx: TenantContext,
  now: number,
): Promise<{ fired: number; missedRecovered: number }> {
  const settings = await ensureSettings(ctx);
  if (settings.globalPaused) {
    await touchTick(ctx, now);
    return { fired: 0, missedRecovered: 0 };
  }

  const lastTickAt = settings.lastTickAt ?? now - TICK_MS;
  const sleepGapMs = now - lastTickAt;
  const wokeFromSleep = sleepGapMs > TICK_MS * 2;

  // Pull every schedule whose next_run_at <= now, tenant-scoped, ordered
  // so we always fire the most overdue first.
  const due = await db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        tenantScope(ctx, scheduledTasks),
        eq(scheduledTasks.paused, 0),
        sql`${scheduledTasks.nextRunAt} IS NOT NULL`,
        lt(scheduledTasks.nextRunAt, now + 1),
      ),
    )
    .orderBy(asc(scheduledTasks.nextRunAt));

  let fired = 0;
  let missedRecovered = 0;

  for (const r of due) {
    const row = toRow(r);
    // Use the per-row workspace_id when running the agent.
    const rowCtx: TenantContext = { ...ctx, workspaceId: r.workspaceId };
    if (wokeFromSleep && r.nextRunAt && r.nextRunAt < lastTickAt) {
      // The schedule was due during the gap — record a missed-recovery
      // row + notify the user, then run it once now.
      missedRecovered += 1;
      await safeNotify(rowCtx, {
        category: "system",
        severity: "warning",
        title: `Catching up: "${row.title}"`,
        body: `This schedule was due during sleep at ${new Date(
          r.nextRunAt,
        ).toLocaleString()}. Running it now.`,
      });
      await runWithTenantContext(rowCtx, () =>
        runOnce(rowCtx, row, r.nextRunAt!, "missed-recovery"),
      );
    } else {
      await runWithTenantContext(rowCtx, () =>
        runOnce(rowCtx, row, r.nextRunAt ?? now, "scheduled"),
      );
    }
    fired += 1;
  }

  await touchTick(ctx, now);
  return { fired, missedRecovered };
}

