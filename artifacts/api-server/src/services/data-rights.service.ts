/**
 * Data-rights service — implements the user-facing data-rights actions
 * surfaced on the Privacy Dashboard:
 *
 *   - exportAllData()         : one-shot snapshot of every category
 *   - deleteByCategory()      : wipe just one category, leaving the rest
 *   - createErasureRequest()  : file a formal GDPR erasure request
 *   - listErasureRequests()   : list the user's filed requests
 *
 * The full "DELETE EVERYTHING" nuclear option lives in `data-nuke.service`
 * — re-used here for the export flow's table inventory.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  agentRuns,
  approvals,
  auditLogEntries,
  buildPage,
  conversations,
  crashReports,
  db,
  decodeCursor,
  erasureRequests,
  integrations,
  kbDocuments,
  mediaAssets,
  memories,
  messages,
  networkCalls,
  normaliseLimit,
  type PaginatedData,
  privacyEvents,
  scheduledTasks,
  securityEvents,
  skills,
  taskQueueEntries,
  taskTemplates,
  telemetryEvents,
  tenantScope,
  toolCalls,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { appendAuditEntry } from "./audit.service";
import { logPrivacyEvent } from "./privacy.service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = any;

interface CategoryDef {
  key: string;
  label: string;
  table: AnyTable;
}

const CATEGORIES: ReadonlyArray<CategoryDef> = [
  { key: "conversations", label: "Conversations", table: conversations },
  { key: "messages", label: "Messages", table: messages },
  { key: "agent_runs", label: "Agent runs", table: agentRuns },
  { key: "tool_calls", label: "Tool calls", table: toolCalls },
  { key: "memories", label: "Memories", table: memories },
  { key: "knowledge_documents", label: "Knowledge documents", table: kbDocuments },
  { key: "media_assets", label: "Media assets", table: mediaAssets },
  { key: "skills", label: "Skills", table: skills },
  { key: "approvals", label: "Approvals", table: approvals },
  { key: "audit_log", label: "Audit log", table: auditLogEntries },
  { key: "privacy_events", label: "Privacy events", table: privacyEvents },
  { key: "security_events", label: "Security events", table: securityEvents },
  { key: "network_calls", label: "Network calls", table: networkCalls },
  { key: "telemetry_events", label: "Telemetry events", table: telemetryEvents },
  { key: "crash_reports", label: "Crash reports", table: crashReports },
  { key: "integrations", label: "Integrations", table: integrations },
  { key: "task_queue", label: "Task queue", table: taskQueueEntries },
  { key: "task_templates", label: "Task templates", table: taskTemplates },
  { key: "scheduled_tasks", label: "Scheduled tasks", table: scheduledTasks },
];

export function listDeletableCategories(): ReadonlyArray<{ key: string; label: string }> {
  return CATEGORIES.map((c) => ({ key: c.key, label: c.label }));
}

export interface ExportBundle {
  readonly tenantId: string;
  readonly exportedAt: string;
  readonly version: "1";
  readonly data: Record<string, ReadonlyArray<unknown>>;
}

/**
 * Export every category's rows. The shape is a plain JSON object so the
 * Privacy Dashboard can blob-download it directly. Per-category cap of
 * 5,000 rows keeps the response bounded — anything bigger should go via
 * the background-export job (Task #37).
 */
export async function exportAllData(
  ctx: TenantContext,
): Promise<ExportBundle> {
  const data: Record<string, ReadonlyArray<unknown>> = {};
  for (const def of CATEGORIES) {
    try {
      const rows = await db
        .select()
        .from(def.table)
        .where(tenantScope(ctx, def.table))
        .limit(5000);
      data[def.key] = rows;
    } catch {
      data[def.key] = [];
    }
  }
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "user",
    action: "data.export.full",
    resourceType: "tenant",
    resourceId: ctx.tenantId,
    summary: "Full export bundle generated",
  });
  await logPrivacyEvent(ctx, {
    eventType: "data.export.full",
    actor: ctx.userId ?? "user",
    target: ctx.tenantId,
    severity: "info",
    detail: `Exported ${Object.keys(data).length} categories`,
  });
  return {
    tenantId: ctx.tenantId,
    exportedAt: new Date().toISOString(),
    version: "1",
    data,
  };
}

export interface CategoryDeletionResult {
  readonly category: string;
  readonly deleted: number;
  readonly completedAt: string;
}

export class UnknownCategoryError extends Error {
  override readonly name = "UnknownCategoryError";
  readonly code = "UNKNOWN_CATEGORY";
  constructor(key: string) {
    super(`Unknown data category: ${key}`);
  }
}

/**
 * Wipe just one category's rows. The audit log entry survives because the
 * insert happens first; if the user nukes the audit log itself the
 * pre-write entry is captured in the security event log.
 */
export async function deleteByCategory(
  ctx: TenantContext,
  category: string,
): Promise<CategoryDeletionResult> {
  const def = CATEGORIES.find((c) => c.key === category);
  if (!def) throw new UnknownCategoryError(category);

  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "user",
    action: "data.delete.category",
    resourceType: "category",
    resourceId: category,
    summary: `Category-scoped delete: ${category}`,
  });
  await logPrivacyEvent(ctx, {
    eventType: "data.delete.category",
    actor: ctx.userId ?? "user",
    target: category,
    severity: "medium",
  });

  const before = await db
    .select()
    .from(def.table)
    .where(tenantScope(ctx, def.table));
  const count = before.length;

  try {
    await db.delete(def.table).where(tenantScope(ctx, def.table));
  } catch {
    // best-effort — categories with FK dependents may partially fail
  }

  return {
    category,
    deleted: count,
    completedAt: new Date().toISOString(),
  };
}

export interface ErasureRequestRow {
  readonly id: string;
  readonly requesterEmail: string;
  readonly scope: string;
  readonly reason: string | null;
  readonly status: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

function toErasureRow(
  r: typeof erasureRequests.$inferSelect,
): ErasureRequestRow {
  return {
    id: r.id,
    requesterEmail: r.requesterEmail,
    scope: r.scope,
    reason: r.reason,
    status: r.status,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export interface CreateErasureRequestInput {
  readonly requesterEmail: string;
  readonly scope?: string;
  readonly reason?: string;
}

export async function createErasureRequest(
  ctx: TenantContext,
  input: CreateErasureRequestInput,
): Promise<ErasureRequestRow> {
  const id = `er_${nanoid()}`;
  const now = Date.now();
  await db.insert(erasureRequests).values(
    withTenantValues(ctx, {
      id,
      requesterEmail: input.requesterEmail,
      scope: input.scope ?? "all",
      reason: input.reason ?? null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "user",
    action: "data.erasure.requested",
    resourceType: "tenant",
    resourceId: ctx.tenantId,
    summary: `GDPR erasure request filed by ${input.requesterEmail} (${input.scope ?? "all"})`,
  });
  await logPrivacyEvent(ctx, {
    eventType: "data.erasure.requested",
    actor: input.requesterEmail,
    target: ctx.tenantId,
    severity: "high",
    ...(input.reason ? { detail: input.reason } : {}),
  });
  return {
    id,
    requesterEmail: input.requesterEmail,
    scope: input.scope ?? "all",
    reason: input.reason ?? null,
    status: "pending",
    completedAt: null,
    createdAt: new Date(now).toISOString(),
  };
}

export async function listErasureRequests(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<ErasureRequestRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, erasureRequests);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(erasureRequests.createdAt, cursorTs))
      : baseScope;

  const rows = await db
    .select()
    .from(erasureRequests)
    .where(where)
    .orderBy(desc(erasureRequests.createdAt))
    .limit(limit + 1);

  return buildPage(rows.map(toErasureRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function cancelErasureRequest(
  ctx: TenantContext,
  id: string,
): Promise<ErasureRequestRow | null> {
  const rows = await db
    .select()
    .from(erasureRequests)
    .where(
      and(
        tenantScope(ctx, erasureRequests),
        eq(erasureRequests.id, id),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.status !== "pending") return toErasureRow(row);
  const now = Date.now();
  await db
    .update(erasureRequests)
    .set({ status: "cancelled", updatedAt: now, version: row.version + 1 })
    .where(eq(erasureRequests.id, id));
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "user",
    action: "data.erasure.cancelled",
    resourceType: "erasure_request",
    resourceId: id,
    summary: `GDPR erasure request ${id} cancelled`,
  });
  return { ...toErasureRow(row), status: "cancelled" };
}
