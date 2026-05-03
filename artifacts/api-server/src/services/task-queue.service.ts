/**
 * Task #38 — Multi-Task Queue & Concurrent Task Management.
 *
 * The queue is an in-process scheduler that drains `task_queue_entries`
 * rows through the existing agent loop. State is fully persisted so a
 * crash / restart leaves no row dangling: the runner re-evaluates every
 * `running` row at boot and re-queues anything whose process didn't get
 * to mark it `completed` (Task #39 — Crash Recovery — extends that).
 *
 * Concurrency policy:
 *   - Sequential mode (low-tier hardware) — at most ONE active run.
 *     Every queue tick acquires a process-wide async mutex around
 *     `createAgentRun()` so the model adapter is never asked to serve
 *     two requests at the same time.
 *   - Parallel mode (mid+ tier hardware) — up to `MAX_PARALLEL_RUNS`
 *     active runs. The model serializer mutex still gates each
 *     individual model call, but tasks that mostly do non-model work
 *     (e.g. file moves, web research) overlap freely.
 *
 * The queue is per-tenant: each enqueue triggers a tick scoped to the
 * caller's tenant. Cross-tenant fairness is not in scope for Task #38.
 *
 * Stale-context check: if the caller passes `contextSnapshot.requiredFiles`
 * the runner verifies every file exists inside the workspace sandbox at
 * the moment the task is picked up. A missing file flips the task to
 * `stale` with a `staleReason`, and the user can re-enqueue.
 */
import fs from "node:fs/promises";

import { and, asc, count, desc, eq, inArray, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  taskQueueEntries,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { resolveSandboxedPath } from "../lib/sandbox";
import { runWithTenantContext } from "../lib/tenant-context";
import { createAgentRun, type AgentRunRow } from "./agent.service";
import { getHardwareProfile } from "./hardware";

export type TaskPriority = "high" | "normal" | "low";
export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";

export interface ContextSnapshot {
  requiredFiles?: ReadonlyArray<string>;
  [key: string]: unknown;
}

export interface QueuedTaskRow {
  id: string;
  goal: string;
  modelName: string | null;
  useKnowledgeBase: boolean;
  knowledgeCollectionId: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  runId: string | null;
  contextSnapshot: ContextSnapshot | null;
  staleReason: string | null;
  error: string | null;
  summary: string | null;
  position: number | null;
  estimatedWaitMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueTaskInput {
  goal: string;
  modelName?: string;
  useKnowledgeBase?: boolean;
  knowledgeCollectionId?: string;
  priority?: TaskPriority;
  contextSnapshot?: ContextSnapshot;
}

export interface QueueSnapshot {
  mode: "sequential" | "parallel";
  parallelism: number;
  active: ReadonlyArray<QueuedTaskRow>;
  queued: ReadonlyArray<QueuedTaskRow>;
  recent: ReadonlyArray<QueuedTaskRow>;
}

const MAX_PARALLEL_RUNS = 2;
const RECENT_LIMIT = 20;
const PRIORITY_RANK: Record<TaskPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

// The model-access serializer mutex itself lives in `lib/model-lock.ts`
// and is applied at the model-adapter boundary (`ollama.service.chat`).
// That keeps non-model phases of the agent loop (file work, knowledge-base
// retrieval, planning) overlapping freely in parallel mode while still
// preventing two concurrent model calls from thrashing the GPU.

// In-process tracking of which task IDs are currently running. The DB row
// status remains the source of truth across restarts, but this set is what
// the parallel coordinator uses to count "live" slots without round-tripping
// SQLite on every tick.
// tier-review: bounded — size capped at `parallelism` (1–2); IDs removed in startRun's finally block
const inFlight = new Set<string>();

function isParallelTier(tier: string): boolean {
  // Sequential mode is the conservative default for low-RAM hardware.
  // Mid / high / pro tiers can host two concurrent runs without thrash.
  return tier !== "low";
}

function currentMode(): { mode: "sequential" | "parallel"; parallelism: number } {
  try {
    const profile = getHardwareProfile();
    if (isParallelTier(profile.tier)) {
      return { mode: "parallel", parallelism: MAX_PARALLEL_RUNS };
    }
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "task-queue: hardware probe failed; defaulting to sequential mode",
    );
  }
  return { mode: "sequential", parallelism: 1 };
}

function parseSnapshot(raw: string | null): ContextSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as ContextSnapshot;
    return null;
  } catch {
    return null;
  }
}

function toRow(
  r: typeof taskQueueEntries.$inferSelect,
  position: number | null = null,
  estimatedWaitMs: number | null = null,
): QueuedTaskRow {
  return {
    id: r.id,
    goal: r.goal,
    modelName: r.modelName,
    useKnowledgeBase: r.useKnowledgeBase === 1,
    knowledgeCollectionId: r.knowledgeCollectionId,
    priority: (r.priority as TaskPriority) ?? "normal",
    status: r.status as TaskStatus,
    runId: r.runId,
    contextSnapshot: parseSnapshot(r.contextSnapshot),
    staleReason: r.staleReason,
    error: r.error,
    summary: r.summary,
    position,
    estimatedWaitMs,
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

async function loadQueuedSorted(ctx: TenantContext): Promise<
  Array<typeof taskQueueEntries.$inferSelect>
> {
  const rows = await db
    .select()
    .from(taskQueueEntries)
    .where(
      and(tenantScope(ctx, taskQueueEntries), eq(taskQueueEntries.status, "queued")),
    );
  return rows.sort((a, b) => {
    const pa = PRIORITY_RANK[(a.priority as TaskPriority) ?? "normal"];
    const pb = PRIORITY_RANK[(b.priority as TaskPriority) ?? "normal"];
    if (pa !== pb) return pa - pb;
    return a.createdAt - b.createdAt;
  });
}

async function loadActive(
  ctx: TenantContext,
): Promise<Array<typeof taskQueueEntries.$inferSelect>> {
  return db
    .select()
    .from(taskQueueEntries)
    .where(
      and(tenantScope(ctx, taskQueueEntries), eq(taskQueueEntries.status, "running")),
    );
}

async function checkStaleContext(
  ctx: TenantContext,
  snapshot: ContextSnapshot | null,
): Promise<string | null> {
  if (!snapshot?.requiredFiles?.length) return null;
  const missing: string[] = [];
  for (const rel of snapshot.requiredFiles) {
    try {
      const abs = resolveSandboxedPath(ctx, rel);
      // eslint-disable-next-line no-await-in-loop -- bounded by user input
      await fs.stat(abs);
    } catch {
      missing.push(rel);
    }
  }
  if (missing.length === 0) return null;
  return `Required file(s) no longer present: ${missing.join(", ")}`;
}

const FALLBACK_AVG_RUN_MS = 30_000;
const AVG_SAMPLE_SIZE = 10;

/**
 * Average duration of recently-completed runs for the tenant — used to
 * project how long each queued task is expected to wait. Falls back to a
 * 30 s heuristic when no completed runs exist yet.
 */
async function avgRecentRunMs(ctx: TenantContext): Promise<number> {
  const rows = await db
    .select({
      startedAt: taskQueueEntries.startedAt,
      completedAt: taskQueueEntries.completedAt,
    })
    .from(taskQueueEntries)
    .where(
      and(
        tenantScope(ctx, taskQueueEntries),
        eq(taskQueueEntries.status, "completed"),
      ),
    )
    .orderBy(desc(taskQueueEntries.completedAt))
    .limit(AVG_SAMPLE_SIZE);
  const samples = rows
    .map((r) =>
      r.startedAt && r.completedAt ? r.completedAt - r.startedAt : null,
    )
    .filter((n): n is number => typeof n === "number" && n > 0);
  if (samples.length === 0) return FALLBACK_AVG_RUN_MS;
  return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
}

/**
 * Project queue wait per position: each "slot" of `parallelism` queued
 * tasks gets one average run-duration of wait. Active count is mixed in
 * so position 0 in line still inherits the wait of the running tasks.
 */
function estimateWaitMs(
  position: number,
  activeCount: number,
  parallelism: number,
  avgMs: number,
): number {
  const ahead = position + activeCount;
  const slots = Math.max(1, parallelism);
  return Math.max(0, Math.ceil(ahead / slots) * avgMs);
}

export async function enqueueTask(
  ctx: TenantContext,
  input: EnqueueTaskInput,
): Promise<QueuedTaskRow> {
  const id = `tq_${nanoid()}`;
  await db.insert(taskQueueEntries).values(
    withTenantValues(ctx, {
      id,
      goal: input.goal,
      modelName: input.modelName ?? null,
      useKnowledgeBase: input.useKnowledgeBase === false ? 0 : 1,
      knowledgeCollectionId: input.knowledgeCollectionId ?? null,
      priority: input.priority ?? "normal",
      status: "queued",
      contextSnapshot: input.contextSnapshot
        ? JSON.stringify(input.contextSnapshot)
        : null,
    }),
  );
  // Kick the runner in the next tick so the HTTP response returns first.
  scheduleTick(ctx);
  const row = await getTask(ctx, id);
  if (!row) throw new Error("Task vanished after insert");
  return row;
}

export async function getTask(
  ctx: TenantContext,
  id: string,
): Promise<QueuedTaskRow | null> {
  const rows = await db
    .select()
    .from(taskQueueEntries)
    .where(and(tenantScope(ctx, taskQueueEntries), eq(taskQueueEntries.id, id)))
    .limit(1);
  if (!rows[0]) return null;
  let position: number | null = null;
  let estimated: number | null = null;
  if (rows[0].status === "queued") {
    const ordered = await loadQueuedSorted(ctx);
    const idx = ordered.findIndex((r) => r.id === id);
    if (idx >= 0) {
      position = idx;
      const { parallelism } = currentMode();
      const active = await loadActive(ctx);
      const avg = await avgRecentRunMs(ctx);
      estimated = estimateWaitMs(idx, active.length, parallelism, avg);
    }
  }
  return toRow(rows[0], position, estimated);
}

export async function listTasks(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number; status?: TaskStatus } = {},
): Promise<PaginatedData<QueuedTaskRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const conditions = [tenantScope(ctx, taskQueueEntries)];
  if (opts.status) conditions.push(eq(taskQueueEntries.status, opts.status));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(taskQueueEntries.createdAt, cursorTs));
  }
  const rows = await db
    .select()
    .from(taskQueueEntries)
    .where(and(...conditions))
    .orderBy(desc(taskQueueEntries.createdAt))
    .limit(limit + 1);
  const queued = await loadQueuedSorted(ctx);
  const positionById = new Map<string, number>();
  queued.forEach((q, i) => positionById.set(q.id, i));
  const { parallelism } = currentMode();
  const active = await loadActive(ctx);
  const avg = await avgRecentRunMs(ctx);
  return buildPage(
    rows.map((r) => {
      const pos = positionById.get(r.id) ?? null;
      const est =
        pos === null ? null : estimateWaitMs(pos, active.length, parallelism, avg);
      return toRow(r, pos, est);
    }),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}

export async function getQueueSnapshot(ctx: TenantContext): Promise<QueueSnapshot> {
  const { mode, parallelism } = currentMode();
  const queued = await loadQueuedSorted(ctx);
  const active = await loadActive(ctx);
  const recentRows = await db
    .select()
    .from(taskQueueEntries)
    .where(
      and(
        tenantScope(ctx, taskQueueEntries),
        inArray(taskQueueEntries.status, [
          "completed",
          "failed",
          "cancelled",
          "stale",
        ]),
      ),
    )
    .orderBy(desc(taskQueueEntries.updatedAt))
    .limit(RECENT_LIMIT);
  const avg = await avgRecentRunMs(ctx);
  return {
    mode,
    parallelism,
    active: active.map((r) => toRow(r)),
    queued: queued.map((r, i) =>
      toRow(r, i, estimateWaitMs(i, active.length, parallelism, avg)),
    ),
    recent: recentRows.map((r) => toRow(r)),
  };
}

export async function cancelTask(
  ctx: TenantContext,
  id: string,
): Promise<QueuedTaskRow | null> {
  const existing = await getTask(ctx, id);
  if (!existing) return null;
  if (
    existing.status === "completed" ||
    existing.status === "failed" ||
    existing.status === "cancelled" ||
    existing.status === "stale"
  ) {
    return existing;
  }
  const now = Date.now();
  await db
    .update(taskQueueEntries)
    .set({ status: "cancelled", completedAt: now, updatedAt: now })
    .where(and(tenantScope(ctx, taskQueueEntries), eq(taskQueueEntries.id, id)));
  inFlight.delete(id);
  return getTask(ctx, id);
}

export async function setPriority(
  ctx: TenantContext,
  id: string,
  priority: TaskPriority,
): Promise<QueuedTaskRow | null> {
  const existing = await getTask(ctx, id);
  if (!existing) return null;
  if (existing.status !== "queued") return existing;
  const now = Date.now();
  await db
    .update(taskQueueEntries)
    .set({ priority, updatedAt: now })
    .where(and(tenantScope(ctx, taskQueueEntries), eq(taskQueueEntries.id, id)));
  scheduleTick(ctx);
  return getTask(ctx, id);
}

export async function clearQueue(ctx: TenantContext): Promise<{ cleared: number }> {
  const queued = await loadQueuedSorted(ctx);
  if (queued.length === 0) return { cleared: 0 };
  const now = Date.now();
  const ids = queued.map((q) => q.id);
  await db
    .update(taskQueueEntries)
    .set({ status: "cancelled", completedAt: now, updatedAt: now })
    .where(
      and(
        tenantScope(ctx, taskQueueEntries),
        inArray(taskQueueEntries.id, ids),
      ),
    );
  return { cleared: queued.length };
}

export async function countQueuedTasks(ctx: TenantContext): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(taskQueueEntries)
    .where(
      and(tenantScope(ctx, taskQueueEntries), eq(taskQueueEntries.status, "queued")),
    );
  return Number(rows[0]?.n ?? 0);
}

// ─── Background runner ──────────────────────────────────────────────────────

/**
 * Per-tenant tick guard. We only want one tick loop alive per tenant at a
 * time so two concurrent enqueues don't both spin up draining loops and
 * race over the same row.
 */
// tier-review: bounded — one entry per actively-draining tenant, removed in scheduleTick's finally
const tickInFlight = new Set<string>();

function scheduleTick(ctx: TenantContext): void {
  if (tickInFlight.has(ctx.tenantId)) return;
  tickInFlight.add(ctx.tenantId);
  // Detach so the HTTP handler returns immediately.
  setImmediate(() => {
    runTickLoop(ctx)
      .catch((e) => {
        logger.error(
          { err: e instanceof Error ? e.message : String(e), tenantId: ctx.tenantId },
          "task-queue: tick loop crashed",
        );
      })
      .finally(() => {
        tickInFlight.delete(ctx.tenantId);
      });
  });
}

async function runTickLoop(ctx: TenantContext): Promise<void> {
  // Drain repeatedly: each iteration starts however many runs the
  // current concurrency budget allows, then awaits the first completion
  // before re-checking the queue.
  // eslint-disable-next-line no-constant-condition -- drained by the queue itself
  while (true) {
    const { parallelism } = currentMode();
    const activeCount = inFlight.size;
    const budget = Math.max(0, parallelism - activeCount);
    if (budget === 0) return;
    const queued = await loadQueuedSorted(ctx);
    if (queued.length === 0) return;
    const next = queued.slice(0, budget);
    const promises = next.map((row) => startRun(ctx, row.id));
    // Wait for at least one to finish before deciding whether to start more.
    if (promises.length === 0) return;
    await Promise.race(promises);
    // Loop continues — allow other started ones to keep running in the background.
    // eslint-disable-next-line no-await-in-loop -- intentional drain pace
    await new Promise((r) => setImmediate(r));
  }
}

async function startRun(ctx: TenantContext, id: string): Promise<void> {
  if (inFlight.has(id)) return;
  // Atomic-ish status flip; if another tick already grabbed it, bail out.
  const now = Date.now();
  const updated = await db
    .update(taskQueueEntries)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(
      and(
        tenantScope(ctx, taskQueueEntries),
        eq(taskQueueEntries.id, id),
        eq(taskQueueEntries.status, "queued"),
      ),
    )
    .returning();
  if (updated.length === 0) return;
  const row = updated[0]!;
  inFlight.add(id);

  try {
    const snapshot = parseSnapshot(row.contextSnapshot);
    const staleReason = await checkStaleContext(ctx, snapshot);
    if (staleReason) {
      const stamp = Date.now();
      await db
        .update(taskQueueEntries)
        .set({
          status: "stale",
          staleReason,
          completedAt: stamp,
          updatedAt: stamp,
        })
        .where(
          and(tenantScope(ctx, taskQueueEntries), eq(taskQueueEntries.id, id)),
        );
      return;
    }

    const run: AgentRunRow = await runWithTenantContext(ctx, () =>
      createAgentRun(ctx, {
        goal: row.goal,
        ...(row.modelName ? { modelName: row.modelName } : {}),
        useKnowledgeBase: row.useKnowledgeBase === 1,
        ...(row.knowledgeCollectionId
          ? { knowledgeCollectionId: row.knowledgeCollectionId }
          : {}),
        // Task #58 — bind the queue task id so the executor checkpoints
        // every step under this row in `task_checkpoints`.
        queueTaskId: id,
      }),
    );
    const stamp = Date.now();
    const status: TaskStatus =
      run.status === "completed"
        ? "completed"
        : run.status === "failed"
          ? "failed"
          : run.status === "cancelled"
            ? "cancelled"
            : "completed";
    // Guard the terminal status flip with the current row state — a user
    // cancellation that lands while the run was in flight must not be
    // overwritten by the post-run "completed" update. We only mark the row
    // terminal if it is still `running`.
    await db
      .update(taskQueueEntries)
      .set({
        status,
        runId: run.id,
        summary: run.summary,
        error: run.error,
        completedAt: stamp,
        updatedAt: stamp,
      })
      .where(
        and(
          tenantScope(ctx, taskQueueEntries),
          eq(taskQueueEntries.id, id),
          eq(taskQueueEntries.status, "running"),
        ),
      );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logger.error({ err: e, taskId: id }, "task-queue: run failed");
    const stamp = Date.now();
    // Same cancellation guard as the success branch — don't clobber a row
    // the user already moved to `cancelled`.
    await db
      .update(taskQueueEntries)
      .set({
        status: "failed",
        error: errMsg,
        completedAt: stamp,
        updatedAt: stamp,
      })
      .where(
        and(
          tenantScope(ctx, taskQueueEntries),
          eq(taskQueueEntries.id, id),
          eq(taskQueueEntries.status, "running"),
        ),
      );
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Drain a tenant's queue and wait for every currently-queued + running task
 * to finish. Used by the test suite so cases can assert on terminal state
 * without polling.
 */
export async function drainQueueForTests(ctx: TenantContext): Promise<void> {
  // Spin until both the in-process inFlight set is empty AND no queued rows
  // remain. We deliberately walk the loop here instead of awaiting
  // `runTickLoop` directly because callers may have queued tasks that the
  // running loop hasn't observed yet.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!tickInFlight.has(ctx.tenantId)) {
      const remaining = await countQueuedTasks(ctx);
      if (remaining === 0 && inFlight.size === 0) return;
      scheduleTick(ctx);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Reset all in-process queue state. Used by tests that swap out the SQLite
 * database between cases and need to start with a clean tick book.
 */
export function __resetTaskQueueForTests(): void {
  inFlight.clear();
  tickInFlight.clear();
}

/**
 * On boot, recover anything left in `running` from a previous process —
 * we have no way to resume an in-progress agent loop, so we reset those
 * rows back to `queued`. (Crash recovery proper lands in Task #39.)
 */
export async function recoverInterruptedRuns(): Promise<number> {
  const rows = await db
    .select()
    .from(taskQueueEntries)
    .where(eq(taskQueueEntries.status, "running"));
  if (rows.length === 0) return 0;
  const now = Date.now();
  await db
    .update(taskQueueEntries)
    .set({ status: "queued", startedAt: null, updatedAt: now })
    .where(eq(taskQueueEntries.status, "running"));
  return rows.length;
}

// Re-export the priority / parallelism helper so the route layer can render
// it on the snapshot endpoint.
export { currentMode };

// Sort helper exposed for tests asserting deterministic order.
export const __PRIORITY_RANK = PRIORITY_RANK;

void asc; // keep the imported helper available for future order-bys
