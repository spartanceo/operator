/**
 * Activity service — append-only chronological feed of "what OP did".
 *
 * Distinct from `audit.service` (security-grade hash-chained log) and
 * `privacy.service` (data-leaving-the-machine log). The activity feed is
 * the user-facing transparency surface: agent runs started, skills
 * executed, tool calls made, approvals decided.
 *
 * The export endpoints stream CSV / structured JSON suitable for the
 * activity centre's "Export as CSV / PDF" actions. PDF generation lives
 * client-side because Tier 1 ships no PDF binary; the API returns a
 * structured payload the UI converts via the browser print pipeline.
 */
import { and, asc, desc, eq, gte, lte, like, lt, or } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  activityEvents,
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

export type ActivityEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "tool.invoked"
  | "skill.executed"
  | "approval.requested"
  | "approval.decided"
  | "system";

export type ActivityOutcome = "success" | "failure" | "cancelled" | "pending";

export interface ActivityEventInput {
  eventType: ActivityEventType;
  actor: string;
  agent?: string;
  skillName?: string;
  runId?: string;
  toolCallId?: string;
  approvalId?: string;
  summary: string;
  outcome?: ActivityOutcome;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ActivityEventRow {
  id: string;
  eventType: string;
  actor: string;
  agent: string | null;
  skillName: string | null;
  runId: string | null;
  toolCallId: string | null;
  approvalId: string | null;
  summary: string;
  outcome: string;
  durationMs: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

function toRow(r: typeof activityEvents.$inferSelect): ActivityEventRow {
  let parsedMetadata: Record<string, unknown> | null = null;
  if (r.metadata) {
    try {
      const parsed = JSON.parse(r.metadata);
      if (parsed && typeof parsed === "object") {
        parsedMetadata = parsed as Record<string, unknown>;
      }
    } catch {
      parsedMetadata = null;
    }
  }
  return {
    id: r.id,
    eventType: r.eventType,
    actor: r.actor,
    agent: r.agent,
    skillName: r.skillName,
    runId: r.runId,
    toolCallId: r.toolCallId,
    approvalId: r.approvalId,
    summary: r.summary,
    outcome: r.outcome,
    durationMs: r.durationMs,
    metadata: parsedMetadata,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export async function recordActivity(
  ctx: TenantContext,
  input: ActivityEventInput,
): Promise<ActivityEventRow | null> {
  try {
    const id = `act_${nanoid()}`;
    await db.insert(activityEvents).values(
      withTenantValues(ctx, {
        id,
        eventType: input.eventType,
        actor: input.actor,
        agent: input.agent ?? null,
        skillName: input.skillName ?? null,
        runId: input.runId ?? null,
        toolCallId: input.toolCallId ?? null,
        approvalId: input.approvalId ?? null,
        summary: input.summary,
        outcome: input.outcome ?? "success",
        durationMs: input.durationMs ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      }),
    );
    const fetched = await getActivityEvent(ctx, id);
    return fetched;
  } catch (e) {
    logger.error({ err: e, eventType: input.eventType }, "Failed to record activity event");
    return null;
  }
}

export async function getActivityEvent(
  ctx: TenantContext,
  id: string,
): Promise<ActivityEventRow | null> {
  const rows = await db
    .select()
    .from(activityEvents)
    .where(and(tenantScope(ctx, activityEvents), eq(activityEvents.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export interface ActivityFilters {
  cursor?: string;
  limit?: number;
  eventType?: ActivityEventType;
  agent?: string;
  search?: string;
  fromMs?: number;
  toMs?: number;
}

export async function listActivityEvents(
  ctx: TenantContext,
  opts: ActivityFilters = {},
): Promise<PaginatedData<ActivityEventRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const filters = [tenantScope(ctx, activityEvents)];
  if (opts.eventType) filters.push(eq(activityEvents.eventType, opts.eventType));
  if (opts.agent) filters.push(eq(activityEvents.agent, opts.agent));
  if (opts.fromMs !== undefined && Number.isFinite(opts.fromMs)) {
    filters.push(gte(activityEvents.createdAt, opts.fromMs));
  }
  if (opts.toMs !== undefined && Number.isFinite(opts.toMs)) {
    filters.push(lte(activityEvents.createdAt, opts.toMs));
  }
  if (opts.search) {
    const pattern = `%${opts.search.toLowerCase()}%`;
    const matchSummary = like(activityEvents.summary, pattern);
    const matchActor = like(activityEvents.actor, pattern);
    const matchEvent = like(activityEvents.eventType, pattern);
    const combined = or(matchSummary, matchActor, matchEvent);
    if (combined) filters.push(combined);
  }
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    filters.push(lt(activityEvents.createdAt, cursorTs));
  }
  const where = filters.length === 1 ? filters[0] : and(...filters);
  const rows = await db
    .select()
    .from(activityEvents)
    .where(where)
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

/**
 * CSV serialiser for the activity-feed export. Returns a UTF-8 string the
 * caller can stream as `text/csv`. Quoting follows RFC 4180.
 */
export async function exportActivityCsv(
  ctx: TenantContext,
  opts: Omit<ActivityFilters, "cursor" | "limit"> = {},
): Promise<string> {
  const filters = [tenantScope(ctx, activityEvents)];
  if (opts.eventType) filters.push(eq(activityEvents.eventType, opts.eventType));
  if (opts.agent) filters.push(eq(activityEvents.agent, opts.agent));
  if (opts.fromMs !== undefined) filters.push(gte(activityEvents.createdAt, opts.fromMs));
  if (opts.toMs !== undefined) filters.push(lte(activityEvents.createdAt, opts.toMs));
  if (opts.search) {
    const pattern = `%${opts.search.toLowerCase()}%`;
    const combined = or(
      like(activityEvents.summary, pattern),
      like(activityEvents.actor, pattern),
      like(activityEvents.eventType, pattern),
    );
    if (combined) filters.push(combined);
  }
  const where = filters.length === 1 ? filters[0] : and(...filters);
  const rows = await db
    .select()
    .from(activityEvents)
    .where(where)
    .orderBy(asc(activityEvents.createdAt))
    .limit(10_000);
  const header = [
    "id",
    "createdAt",
    "eventType",
    "actor",
    "agent",
    "skillName",
    "runId",
    "outcome",
    "durationMs",
    "summary",
  ].join(",");
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        new Date(r.createdAt).toISOString(),
        r.eventType,
        r.actor,
        r.agent ?? "",
        r.skillName ?? "",
        r.runId ?? "",
        r.outcome,
        r.durationMs?.toString() ?? "",
        r.summary,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
