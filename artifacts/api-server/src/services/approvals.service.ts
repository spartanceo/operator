/**
 * Approvals service — human-in-the-loop gates for medium/high tool calls.
 *
 * The orchestrator inserts an approval row when a risky tool is queued and
 * the route handler resolves it (`/api/agent/approvals/{id}/decide`). This
 * service only mutates the database; the orchestrator polls the row.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  approvals,
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  toolCalls,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

export interface ApprovalRow {
  id: string;
  runId: string;
  toolCallId: string;
  reason: string;
  summary: string;
  decision: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  createdAt: string;
}

export interface CreateApprovalInput {
  runId: string;
  toolCallId: string;
  reason: string;
  summary: string;
}

export interface ApprovalDecisionInput {
  decision: "approved" | "denied";
  note?: string;
}

function toRow(r: typeof approvals.$inferSelect): ApprovalRow {
  return {
    id: r.id,
    runId: r.runId,
    toolCallId: r.toolCallId,
    reason: r.reason,
    summary: r.summary,
    decision: r.decision,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
    note: r.note,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export async function createApproval(
  ctx: TenantContext,
  input: CreateApprovalInput,
): Promise<ApprovalRow> {
  const id = `apr_${nanoid()}`;
  await db.insert(approvals).values(
    withTenantValues(ctx, {
      id,
      runId: input.runId,
      toolCallId: input.toolCallId,
      reason: input.reason,
      summary: input.summary,
      decision: "pending",
    }),
  );
  const row = await getApproval(ctx, id);
  if (!row) throw new Error("Approval missing immediately after insert");
  return row;
}

export async function getApproval(
  ctx: TenantContext,
  id: string,
): Promise<ApprovalRow | null> {
  const rows = await db
    .select()
    .from(approvals)
    .where(and(tenantScope(ctx, approvals), eq(approvals.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listApprovalsForRun(
  ctx: TenantContext,
  runId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<ApprovalRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = and(tenantScope(ctx, approvals), eq(approvals.runId, runId));
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(approvals.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(approvals)
    .where(where)
    .orderBy(desc(approvals.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export interface ApprovalListOptions {
  cursor?: string;
  limit?: number;
  decision?: "pending" | "approved" | "denied";
}

export async function listApprovals(
  ctx: TenantContext,
  opts: ApprovalListOptions = {},
): Promise<PaginatedData<ApprovalRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const filters = [tenantScope(ctx, approvals)];
  if (opts.decision) filters.push(eq(approvals.decision, opts.decision));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    filters.push(lt(approvals.createdAt, cursorTs));
  }
  const where = filters.length === 1 ? filters[0] : and(...filters);
  const rows = await db
    .select()
    .from(approvals)
    .where(where)
    .orderBy(desc(approvals.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export interface BatchDecideInput {
  ids: ReadonlyArray<string>;
  decision: "approved" | "denied";
  note?: string;
}

export interface BatchDecideResult {
  decided: ReadonlyArray<ApprovalRow>;
  skipped: ReadonlyArray<{ id: string; reason: string }>;
}

export async function batchDecideApprovals(
  ctx: TenantContext,
  input: BatchDecideInput,
): Promise<BatchDecideResult> {
  const decided: ApprovalRow[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of input.ids) {
    const decision = input.note
      ? { decision: input.decision, note: input.note }
      : { decision: input.decision };
    const updated = await decideApproval(ctx, id, decision);
    if (!updated) {
      skipped.push({ id, reason: "not_found" });
    } else if (updated.decision !== input.decision) {
      skipped.push({ id, reason: "already_decided" });
    } else {
      decided.push(updated);
    }
  }
  return { decided, skipped };
}

export async function decideApproval(
  ctx: TenantContext,
  id: string,
  input: ApprovalDecisionInput,
): Promise<ApprovalRow | null> {
  const existing = await getApproval(ctx, id);
  if (!existing) return null;
  if (existing.decision !== "pending") return existing;
  const now = Date.now();
  await db
    .update(approvals)
    .set({
      decision: input.decision,
      decidedAt: now,
      decidedBy: ctx.userId ?? "owner",
      note: input.note ?? null,
      updatedAt: now,
    })
    .where(and(tenantScope(ctx, approvals), eq(approvals.id, id)));
  // Cascade the decision to the linked tool call's status.
  const newToolStatus = input.decision === "approved" ? "approved" : "denied";
  await db
    .update(toolCalls)
    .set({ status: newToolStatus, updatedAt: now })
    .where(and(tenantScope(ctx, toolCalls), eq(toolCalls.id, existing.toolCallId)));
  return getApproval(ctx, id);
}
