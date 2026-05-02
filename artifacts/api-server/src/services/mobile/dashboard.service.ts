/**
 * Aggregator service for the Mobile Companion PWA dashboard.
 *
 * Stitches together the live agent run, pending approvals, recent
 * activity, and connection status from existing tables so the PWA
 * can fetch one bundled payload per refresh.
 */
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  agentRuns,
  approvals,
  buildPage,
  db,
  decodeCursor,
  mobileQuickTasks,
  normaliseLimit,
  type PaginatedData,
  pairedDevices,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

export interface MobileStatusCard {
  connection: "online" | "idle" | "offline";
  lastSeenAt: string | null;
  activeRun: {
    id: string;
    title: string;
    status: string;
    updatedAt: string;
  } | null;
  pendingApprovalCount: number;
  pairedDeviceCount: number;
}

export interface MobileApprovalRow {
  id: string;
  runId: string;
  toolCallId: string;
  reason: string;
  summary: string;
  decision: string;
  createdAt: string;
  riskLevel: "low" | "medium" | "high" | "critical";
}

export interface MobileActivityItem {
  id: string;
  kind: "run" | "approval";
  title: string;
  status: string;
  at: string;
}

export interface QuickTaskInput {
  body: string;
  deviceId: string;
}

export interface QuickTaskRow {
  id: string;
  body: string;
  status: string;
  createdAt: string;
  deliveredAt: string | null;
}

const ONLINE_WINDOW_MS = 60_000;
const IDLE_WINDOW_MS = 5 * 60_000;

function classifyConnection(lastSeen: number | null): MobileStatusCard["connection"] {
  if (lastSeen === null) return "offline";
  const age = Date.now() - lastSeen;
  if (age < ONLINE_WINDOW_MS) return "online";
  if (age < IDLE_WINDOW_MS) return "idle";
  return "offline";
}

function inferRiskLevel(reason: string): MobileApprovalRow["riskLevel"] {
  const r = reason.toLowerCase();
  if (r.includes("critical")) return "critical";
  if (r.includes("high") || r.includes("delete") || r.includes("send")) return "high";
  if (r.includes("medium")) return "medium";
  return "low";
}

export async function getStatus(ctx: TenantContext): Promise<MobileStatusCard> {
  const [activeRunRow] = await db
    .select()
    .from(agentRuns)
    .where(tenantScope(ctx, agentRuns))
    .orderBy(desc(agentRuns.updatedAt))
    .limit(1);

  const pending = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(tenantScope(ctx, approvals), eq(approvals.decision, "pending")));

  const devices = await db
    .select({ lastSeenAt: pairedDevices.lastSeenAt })
    .from(pairedDevices)
    .where(and(tenantScope(ctx, pairedDevices), eq(pairedDevices.status, "active")));

  const lastSeen = devices.reduce<number | null>((acc, d) => {
    if (!d.lastSeenAt) return acc;
    return acc === null || d.lastSeenAt > acc ? d.lastSeenAt : acc;
  }, null);

  return {
    connection: classifyConnection(lastSeen),
    lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
    activeRun: activeRunRow
      ? {
          id: activeRunRow.id,
          title: activeRunRow.goal ?? "Agent run",
          status: activeRunRow.status,
          updatedAt: new Date(activeRunRow.updatedAt).toISOString(),
        }
      : null,
    pendingApprovalCount: pending.length,
    pairedDeviceCount: devices.length,
  };
}

export async function listPendingApprovals(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<MobileApprovalRow>> {
  const limit = normaliseLimit(opts.limit);
  const rows = await db
    .select()
    .from(approvals)
    .where(and(tenantScope(ctx, approvals), eq(approvals.decision, "pending")))
    .orderBy(desc(approvals.createdAt))
    .limit(limit + 1);
  return buildPage(
    rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      toolCallId: r.toolCallId,
      reason: r.reason,
      summary: r.summary,
      decision: r.decision,
      createdAt: new Date(r.createdAt).toISOString(),
      riskLevel: inferRiskLevel(r.reason),
    })),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}

export async function listActivity(
  ctx: TenantContext,
  opts: { limit?: number } = {},
): Promise<MobileActivityItem[]> {
  const limit = Math.min(opts.limit ?? 20, 50);
  const runs = await db
    .select()
    .from(agentRuns)
    .where(tenantScope(ctx, agentRuns))
    .orderBy(desc(agentRuns.updatedAt))
    .limit(limit);
  return runs.map((r) => ({
    id: r.id,
    kind: "run" as const,
    title: r.goal ?? "Agent run",
    status: r.status,
    at: new Date(r.updatedAt).toISOString(),
  }));
}

export async function createQuickTask(
  ctx: TenantContext,
  input: QuickTaskInput,
): Promise<QuickTaskRow> {
  // Verify the device exists and is active before queueing the task.
  const device = await db
    .select()
    .from(pairedDevices)
    .where(
      and(
        tenantScope(ctx, pairedDevices),
        eq(pairedDevices.id, input.deviceId),
        eq(pairedDevices.status, "active"),
      ),
    )
    .limit(1);
  if (!device[0]) {
    throw new Error("Device not paired or has been revoked");
  }
  const id = `mqt_${nanoid()}`;
  const now = Date.now();
  await db.insert(mobileQuickTasks).values(
    withTenantValues(ctx, {
      id,
      deviceId: input.deviceId,
      body: input.body.slice(0, 4000),
      status: "pending" as const,
    }),
  );
  return {
    id,
    body: input.body.slice(0, 4000),
    status: "pending",
    createdAt: new Date(now).toISOString(),
    deliveredAt: null,
  };
}

export async function listQuickTasks(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<QuickTaskRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const rows = await db
    .select()
    .from(mobileQuickTasks)
    .where(tenantScope(ctx, mobileQuickTasks))
    .orderBy(desc(mobileQuickTasks.createdAt))
    .limit(limit + 1);
  void cursorTs; // pagination beyond first page is best-effort for Tier 1
  return buildPage(
    rows.map((r) => ({
      id: r.id,
      body: r.body,
      status: r.status,
      createdAt: new Date(r.createdAt).toISOString(),
      deliveredAt: r.deliveredAt ? new Date(r.deliveredAt).toISOString() : null,
    })),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}
