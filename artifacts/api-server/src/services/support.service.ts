/**
 * Support service — ticket submission, conversation log, status updates,
 * response templates, OP team support dashboard metrics (Task #34).
 *
 * Tickets always live under the submitter's tenant (so `/api/admin/tenant-data`
 * GDPR export picks them up). The OP team support dashboard is a Super
 * Admin surface that reads ALL tickets across the platform; that path
 * uses the `*ForOpTeam` helpers which deliberately do NOT scope by
 * tenant context.
 */
import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  supportResponseTemplates,
  supportTicketEvents,
  supportTickets,
  SYSTEM_TENANT_ID,
  SYSTEM_WORKSPACE_ID,
  tenantScope,
  withTenantValues,
  type PaginatedData,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// tier-review: bounded — fixed enum, never grows past code-defined values
const TICKET_CATEGORIES = new Set([
  "general",
  "bug",
  "billing",
  "account",
  "security",
  "feature-question",
  "other",
]);

// tier-review: bounded — fixed enum, never grows past code-defined values
const TICKET_STATUSES = new Set([
  "open",
  "in_progress",
  "waiting_user",
  "resolved",
  "closed",
]);

// tier-review: bounded — fixed enum, never grows past code-defined values
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

export class SupportValidationError extends Error {
  override readonly name = "SupportValidationError";
  readonly code = "SUPPORT_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

export interface SupportTicketRow {
  id: string;
  tenantId: string;
  workspaceId: string;
  userEmail: string;
  userLabel: string;
  subject: string;
  body: string;
  category: string;
  priority: string;
  status: string;
  opVersion: string;
  osInfo: string;
  hardwareTier: string;
  attachmentNote: string;
  escalated: boolean;
  assigneeLabel: string;
  resolutionNotes: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicketEventRow {
  id: string;
  ticketId: string;
  sender: string;
  senderLabel: string;
  body: string;
  createdAt: string;
}

export interface SupportResponseTemplateRow {
  id: string;
  label: string;
  body: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

function ticketRow(r: typeof supportTickets.$inferSelect): SupportTicketRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    workspaceId: r.workspaceId,
    userEmail: r.userEmail,
    userLabel: r.userLabel,
    subject: r.subject,
    body: r.body,
    category: r.category,
    priority: r.priority,
    status: r.status,
    opVersion: r.opVersion,
    osInfo: r.osInfo,
    hardwareTier: r.hardwareTier,
    attachmentNote: r.attachmentNote,
    escalated: r.escalated === 1,
    assigneeLabel: r.assigneeLabel,
    resolutionNotes: r.resolutionNotes,
    resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function eventRow(
  r: typeof supportTicketEvents.$inferSelect,
): SupportTicketEventRow {
  return {
    id: r.id,
    ticketId: r.ticketId,
    sender: r.sender,
    senderLabel: r.senderLabel,
    body: r.body,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

function templateRow(
  r: typeof supportResponseTemplates.$inferSelect,
): SupportResponseTemplateRow {
  return {
    id: r.id,
    label: r.label,
    body: r.body,
    category: r.category,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

/**
 * Priority routing: certain categories are auto-bumped so the OP team
 * sees them at the top of the queue immediately.
 */
function autoEscalate(
  category: string,
  priority: string,
): { priority: string; escalated: boolean } {
  if (category === "security" || category === "billing") {
    return { priority: "urgent", escalated: true };
  }
  if (priority === "urgent") return { priority: "urgent", escalated: true };
  return { priority, escalated: false };
}

export interface CreateTicketInput {
  subject: string;
  body: string;
  userEmail: string;
  userLabel?: string;
  category?: string;
  priority?: string;
  opVersion?: string;
  osInfo?: string;
  hardwareTier?: string;
  attachmentNote?: string;
}

export async function createTicket(
  ctx: TenantContext,
  input: CreateTicketInput,
): Promise<SupportTicketRow> {
  const subject = input.subject.trim();
  const body = input.body.trim();
  const email = input.userEmail.trim().toLowerCase();
  if (subject.length === 0 || subject.length > 200) {
    throw new SupportValidationError("subject is required (≤200 chars)");
  }
  if (body.length === 0 || body.length > 8000) {
    throw new SupportValidationError("body is required (≤8000 chars)");
  }
  if (!EMAIL_RE.test(email)) {
    throw new SupportValidationError("valid email required");
  }
  const category = input.category && TICKET_CATEGORIES.has(input.category)
    ? input.category
    : "general";
  const requestedPriority =
    input.priority && PRIORITIES.has(input.priority) ? input.priority : "normal";
  const routed = autoEscalate(category, requestedPriority);
  const id = `tkt_${nanoid()}`;
  const inserted = await db
    .insert(supportTickets)
    .values(
      withTenantValues(ctx, {
        id,
        userEmail: email,
        userLabel: input.userLabel?.trim() ?? "",
        subject,
        body,
        category,
        priority: routed.priority,
        escalated: routed.escalated ? 1 : 0,
        opVersion: input.opVersion?.trim() ?? "",
        osInfo: input.osInfo?.trim() ?? "",
        hardwareTier: input.hardwareTier?.trim() ?? "",
        attachmentNote: input.attachmentNote?.trim() ?? "",
      }),
    )
    .returning();
  const ticket = inserted[0]!;
  await db.insert(supportTicketEvents).values(
    withTenantValues(ctx, {
      id: `tev_${nanoid()}`,
      ticketId: ticket.id,
      sender: "user",
      senderLabel: input.userLabel?.trim() ?? email,
      body,
    }),
  );
  if (routed.escalated) {
    await db.insert(supportTicketEvents).values(
      withTenantValues(ctx, {
        id: `tev_${nanoid()}`,
        ticketId: ticket.id,
        sender: "system",
        senderLabel: "priority-router",
        body: `Ticket auto-escalated to ${routed.priority} (category=${category}).`,
      }),
    );
  }
  logger.info({ id: ticket.id, category, priority: routed.priority }, "Support ticket created");
  return ticketRow(ticket);
}

export interface ListTicketsOptions {
  status?: string;
  cursor?: string;
  limit?: number;
}

export async function listTickets(
  ctx: TenantContext,
  opts: ListTicketsOptions = {},
): Promise<PaginatedData<SupportTicketRow>> {
  const limit = normaliseLimit(opts.limit);
  const predicates = [tenantScope(ctx, supportTickets)];
  if (opts.status && TICKET_STATUSES.has(opts.status)) {
    predicates.push(eq(supportTickets.status, opts.status));
  }
  if (opts.cursor) {
    const seek = Number(decodeCursor(opts.cursor));
    if (Number.isFinite(seek)) {
      predicates.push(lt(supportTickets.createdAt, seek));
    }
  }
  const rows = await db
    .select()
    .from(supportTickets)
    .where(and(...predicates))
    .orderBy(desc(supportTickets.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(ticketRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getTicket(
  ctx: TenantContext,
  id: string,
): Promise<SupportTicketRow | null> {
  const rows = await db
    .select()
    .from(supportTickets)
    .where(and(tenantScope(ctx, supportTickets), eq(supportTickets.id, id)))
    .limit(1);
  return rows[0] ? ticketRow(rows[0]) : null;
}

export async function listTicketEvents(
  ctx: TenantContext,
  ticketId: string,
): Promise<SupportTicketEventRow[]> {
  const rows = await db
    .select()
    .from(supportTicketEvents)
    .where(
      and(
        tenantScope(ctx, supportTicketEvents),
        eq(supportTicketEvents.ticketId, ticketId),
      ),
    )
    .orderBy(supportTicketEvents.createdAt)
    .limit(500);
  return rows.map(eventRow);
}

export interface AppendMessageInput {
  ticketId: string;
  body: string;
  sender?: "user" | "op" | "system";
  senderLabel?: string;
}

export async function appendTicketMessage(
  ctx: TenantContext,
  input: AppendMessageInput,
): Promise<SupportTicketEventRow> {
  const body = input.body.trim();
  if (body.length === 0 || body.length > 8000) {
    throw new SupportValidationError("body is required (≤8000 chars)");
  }
  const ticket = await getTicket(ctx, input.ticketId);
  if (!ticket) throw new SupportValidationError("ticket not found");
  const sender = input.sender ?? "user";
  const id = `tev_${nanoid()}`;
  const inserted = await db
    .insert(supportTicketEvents)
    .values(
      withTenantValues(ctx, {
        id,
        ticketId: input.ticketId,
        sender,
        senderLabel: input.senderLabel ?? "",
        body,
      }),
    )
    .returning();
  // Touch the parent ticket so list-by-recent-activity stays correct.
  const nextStatus = sender === "op" ? "waiting_user" : ticket.status;
  await db
    .update(supportTickets)
    .set({
      updatedAt: Date.now(),
      status: nextStatus,
      version: sql`${supportTickets.version} + 1`,
    })
    .where(
      and(tenantScope(ctx, supportTickets), eq(supportTickets.id, input.ticketId)),
    );
  return eventRow(inserted[0]!);
}

export interface UpdateTicketStatusInput {
  ticketId: string;
  status: string;
  resolutionNotes?: string;
  assigneeLabel?: string;
}

export async function updateTicketStatus(
  ctx: TenantContext,
  input: UpdateTicketStatusInput,
): Promise<SupportTicketRow> {
  if (!TICKET_STATUSES.has(input.status)) {
    throw new SupportValidationError(`invalid status "${input.status}"`);
  }
  const ticket = await getTicket(ctx, input.ticketId);
  if (!ticket) throw new SupportValidationError("ticket not found");
  const updates: Partial<typeof supportTickets.$inferInsert> = {
    status: input.status,
    updatedAt: Date.now(),
  };
  if (input.resolutionNotes !== undefined) {
    updates.resolutionNotes = input.resolutionNotes.trim();
  }
  if (input.assigneeLabel !== undefined) {
    updates.assigneeLabel = input.assigneeLabel.trim();
  }
  if (input.status === "resolved" || input.status === "closed") {
    updates.resolvedAt = Date.now();
  }
  await db
    .update(supportTickets)
    .set({ ...updates, version: sql`${supportTickets.version} + 1` })
    .where(
      and(tenantScope(ctx, supportTickets), eq(supportTickets.id, input.ticketId)),
    );
  const refreshed = await getTicket(ctx, input.ticketId);
  return refreshed!;
}

// ───────────── Response templates (system-tenant scoped) ────────────────────

export async function listResponseTemplates(): Promise<SupportResponseTemplateRow[]> {
  const rows = await db
    .select()
    .from(supportResponseTemplates)
    .where(eq(supportResponseTemplates.tenantId, SYSTEM_TENANT_ID))
    .orderBy(supportResponseTemplates.label)
    .limit(200);
  return rows.map(templateRow);
}

export interface UpsertTemplateInput {
  id?: string;
  label: string;
  body: string;
  category?: string;
}

export async function upsertResponseTemplate(
  input: UpsertTemplateInput,
): Promise<SupportResponseTemplateRow> {
  const label = input.label.trim();
  const body = input.body.trim();
  if (label.length === 0 || label.length > 120) {
    throw new SupportValidationError("label is required (≤120 chars)");
  }
  if (body.length === 0 || body.length > 8000) {
    throw new SupportValidationError("body is required (≤8000 chars)");
  }
  if (input.id) {
    await db
      .update(supportResponseTemplates)
      .set({
        label,
        body,
        category: input.category ?? "general",
        updatedAt: Date.now(),
        version: sql`${supportResponseTemplates.version} + 1`,
      })
      .where(eq(supportResponseTemplates.id, input.id));
    const rows = await db
      .select()
      .from(supportResponseTemplates)
      .where(eq(supportResponseTemplates.id, input.id))
      .limit(1);
    return templateRow(rows[0]!);
  }
  const id = `srt_${nanoid()}`;
  const inserted = await db
    .insert(supportResponseTemplates)
    .values({
      id,
      tenantId: SYSTEM_TENANT_ID,
      workspaceId: SYSTEM_WORKSPACE_ID,
      label,
      body,
      category: input.category ?? "general",
    })
    .returning();
  return templateRow(inserted[0]!);
}

export async function deleteResponseTemplate(id: string): Promise<void> {
  await db.delete(supportResponseTemplates).where(
    and(
      eq(supportResponseTemplates.tenantId, SYSTEM_TENANT_ID),
      eq(supportResponseTemplates.id, id),
    ),
  );
}

// ───────────── OP team support dashboard (cross-tenant aggregate) ───────────

export interface SupportDashboardMetrics {
  openCount: number;
  inProgressCount: number;
  resolvedLast30dCount: number;
  urgentOpenCount: number;
  avgResolutionHours: number;
  byCategory: Array<{ category: string; total: number }>;
  topReportedIssues: Array<{ subject: string; count: number }>;
  recent: SupportTicketRow[];
}

/**
 * Cross-tenant aggregate read used only by the Super Admin support
 * dashboard. Deliberately bypasses `tenantScope` — the OP team is a
 * platform-wide actor.
 */
export async function getSupportDashboardMetrics(): Promise<SupportDashboardMetrics> {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const [openRow] = await db
    .select({ total: count() })
    .from(supportTickets)
    .where(eq(supportTickets.status, "open"));
  const [inProgressRow] = await db
    .select({ total: count() })
    .from(supportTickets)
    .where(eq(supportTickets.status, "in_progress"));
  const [resolvedRow] = await db
    .select({ total: count() })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.status, "resolved"),
        gte(supportTickets.resolvedAt, thirtyDaysAgo),
      ),
    );
  const [urgentRow] = await db
    .select({ total: count() })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.priority, "urgent"),
        eq(supportTickets.status, "open"),
      ),
    );
  const resolvedRows = await db
    .select({ created: supportTickets.createdAt, resolved: supportTickets.resolvedAt })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.status, "resolved"),
        gte(supportTickets.resolvedAt, thirtyDaysAgo),
      ),
    );
  let avgResolutionHours = 0;
  if (resolvedRows.length > 0) {
    const totalHours = resolvedRows.reduce((acc, r) => {
      const r1 = r.resolved ?? Date.now();
      return acc + (Number(r1) - Number(r.created)) / (1000 * 60 * 60);
    }, 0);
    avgResolutionHours = totalHours / resolvedRows.length;
  }
  const byCategoryRows = await db
    .select({ category: supportTickets.category, total: count() })
    .from(supportTickets)
    .groupBy(supportTickets.category);
  const byCategory = byCategoryRows.map((r) => ({
    category: r.category,
    total: Number(r.total),
  }));
  const topRows = await db
    .select({ subject: supportTickets.subject, total: count() })
    .from(supportTickets)
    .where(gte(supportTickets.createdAt, thirtyDaysAgo))
    .groupBy(supportTickets.subject)
    .orderBy(desc(count()))
    .limit(10);
  const topReportedIssues = topRows.map((r) => ({
    subject: r.subject,
    count: Number(r.total),
  }));
  const recentRows = await db
    .select()
    .from(supportTickets)
    .orderBy(desc(supportTickets.createdAt))
    .limit(20);
  return {
    openCount: Number(openRow?.total ?? 0),
    inProgressCount: Number(inProgressRow?.total ?? 0),
    resolvedLast30dCount: Number(resolvedRow?.total ?? 0),
    urgentOpenCount: Number(urgentRow?.total ?? 0),
    avgResolutionHours: Math.round(avgResolutionHours * 10) / 10,
    byCategory,
    topReportedIssues,
    recent: recentRows.map(ticketRow),
  };
}

export async function listAllTicketsForOpTeam(opts: {
  status?: string;
  cursor?: string;
  limit?: number;
}): Promise<PaginatedData<SupportTicketRow>> {
  const limit = normaliseLimit(opts.limit);
  const predicates: Array<ReturnType<typeof eq>> = [];
  if (opts.status && TICKET_STATUSES.has(opts.status)) {
    predicates.push(eq(supportTickets.status, opts.status));
  }
  if (opts.cursor) {
    const seek = Number(decodeCursor(opts.cursor));
    if (Number.isFinite(seek)) {
      predicates.push(lt(supportTickets.createdAt, seek));
    }
  }
  const query = db
    .select()
    .from(supportTickets)
    .orderBy(desc(supportTickets.createdAt))
    .limit(limit + 1);
  const rows = predicates.length > 0
    ? await query.where(and(...predicates))
    : await query;
  return buildPage(rows.map(ticketRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

/**
 * Diagnostic bundle — sanitised snapshot the in-app support panel offers
 * the user as a one-click "attach to ticket" download. Deliberately
 * coarse: NO file paths, NO message bodies, NO API keys, NO conversation
 * data — just the version/OS/hardware fingerprint plus a count of
 * recently-completed agent runs so the OP team can correlate the report.
 */
export interface DiagnosticBundle {
  generatedAt: string;
  opVersion: string;
  osInfo: string;
  hardwareTier: string;
  recentTicketIds: string[];
  notes: string;
}

export async function buildDiagnosticBundle(
  ctx: TenantContext,
  meta: { opVersion?: string; osInfo?: string; hardwareTier?: string } = {},
): Promise<DiagnosticBundle> {
  const recent = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(tenantScope(ctx, supportTickets))
    .orderBy(desc(supportTickets.createdAt))
    .limit(5);
  return {
    generatedAt: new Date().toISOString(),
    opVersion: meta.opVersion ?? "",
    osInfo: meta.osInfo ?? "",
    hardwareTier: meta.hardwareTier ?? "",
    recentTicketIds: recent.map((r) => r.id),
    notes:
      "Sanitised diagnostic bundle. Contains no personal data, " +
      "no file contents, no conversation history, no API keys.",
  };
}
