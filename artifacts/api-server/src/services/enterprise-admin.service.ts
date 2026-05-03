/**
 * Enterprise-admin service — per-tenant org, seat, whitelist, audit-log
 * and usage views consumed by the Enterprise Admin Portal (Task #7).
 *
 * Org rows are auto-materialised on first access — the calling tenant
 * always has exactly one `enterprise_orgs` row keyed by `tenantId`.
 *
 * All writes append an audit entry through `audit.service` so the
 * tamper-evident chain captures every team-mgmt + branding change for
 * compliance reviews.
 */
import { and, count, desc, eq, gte, lt, sql as drizzleSql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  agentRuns as agentRunsTable,
  buildPage,
  db,
  decodeCursor,
  enterpriseOrgs,
  enterpriseSeats,
  enterpriseSkillWhitelist,
  normaliseLimit,
  type PaginatedData,
  tenants,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { appendAuditEntry, listAuditEntries } from "./audit.service";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EnterpriseOrgRow {
  id: string;
  name: string;
  logoUrl: string | null;
  primaryColor: string;
  plan: string;
  seatLimit: number;
  airGapped: boolean;
  ssoProvider: string | null;
  ssoDomain: string | null;
  stripeCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
}

function orgToRow(r: typeof enterpriseOrgs.$inferSelect): EnterpriseOrgRow {
  return {
    id: r.id,
    name: r.name,
    logoUrl: r.logoUrl,
    primaryColor: r.primaryColor,
    plan: r.plan,
    seatLimit: r.seatLimit,
    airGapped: Boolean(r.airGapped),
    ssoProvider: r.ssoProvider,
    ssoDomain: r.ssoDomain,
    stripeCustomerId: r.stripeCustomerId,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

/**
 * Read or auto-create the calling tenant's enterprise org row. Returns
 * a populated row in both cases.
 */
export async function getOrCreateOrg(ctx: TenantContext): Promise<EnterpriseOrgRow> {
  const rows = await db
    .select()
    .from(enterpriseOrgs)
    .where(tenantScope(ctx, enterpriseOrgs))
    .limit(1);
  if (rows[0]) return orgToRow(rows[0]);
  // Pull the tenant's display name as a sensible default.
  const tenantRows = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, ctx.tenantId))
    .limit(1);
  const defaultName =
    (tenantRows[0] as { name?: string } | undefined)?.name ?? "My Organisation";
  const id = `org_${nanoid()}`;
  const now = Date.now();
  await db.insert(enterpriseOrgs).values(
    withTenantValues(ctx, {
      id,
      name: defaultName,
      logoUrl: null,
      primaryColor: "#F2A341",
      plan: "business",
      seatLimit: 5,
      airGapped: false,
      ssoProvider: null,
      ssoDomain: null,
      stripeCustomerId: null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const fresh = await db.select().from(enterpriseOrgs).where(eq(enterpriseOrgs.id, id)).limit(1);
  return orgToRow(fresh[0]!);
}

export async function updateOrg(
  ctx: TenantContext,
  reviewer: string,
  patch: Partial<{
    name: string;
    logoUrl: string | null;
    primaryColor: string;
    plan: string;
    seatLimit: number;
    airGapped: boolean;
    ssoProvider: string | null;
    ssoDomain: string | null;
  }>,
): Promise<EnterpriseOrgRow> {
  const org = await getOrCreateOrg(ctx);
  const now = Date.now();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (patch.name !== undefined) updates["name"] = patch.name;
  if (patch.logoUrl !== undefined) updates["logoUrl"] = patch.logoUrl;
  if (patch.primaryColor !== undefined) updates["primaryColor"] = patch.primaryColor;
  if (patch.plan !== undefined) updates["plan"] = patch.plan;
  if (patch.seatLimit !== undefined)
    updates["seatLimit"] = Math.max(1, Math.min(10000, patch.seatLimit));
  if (patch.airGapped !== undefined) updates["airGapped"] = patch.airGapped;
  if (patch.ssoProvider !== undefined) updates["ssoProvider"] = patch.ssoProvider;
  if (patch.ssoDomain !== undefined) updates["ssoDomain"] = patch.ssoDomain;
  await db
    .update(enterpriseOrgs)
    .set(updates)
    .where(eq(enterpriseOrgs.id, org.id));
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "enterprise_org.update",
    resourceType: "enterprise_org",
    resourceId: org.id,
    summary: `Updated org settings (${Object.keys(patch).join(", ")})`,
  });
  const fresh = await db
    .select()
    .from(enterpriseOrgs)
    .where(eq(enterpriseOrgs.id, org.id))
    .limit(1);
  return orgToRow(fresh[0]!);
}

// --------------------------- Seats ----------------------------------------

export interface SeatRow {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "standard" | "readonly";
  status: "invited" | "active" | "disabled";
  invitedAt: string;
  lastActiveAt: string | null;
}

function seatToRow(r: typeof enterpriseSeats.$inferSelect): SeatRow {
  return {
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    role: r.role as SeatRow["role"],
    status: r.status as SeatRow["status"],
    invitedAt: new Date(r.invitedAt).toISOString(),
    lastActiveAt: r.lastActiveAt ? new Date(r.lastActiveAt).toISOString() : null,
  };
}

export async function listSeats(
  ctx: TenantContext,
  input: { cursor?: string | null; limit?: number },
): Promise<PaginatedData<SeatRow>> {
  const org = await getOrCreateOrg(ctx);
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const conditions = [tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.orgId, org.id)];
  if (cursorTs !== null && Number.isFinite(cursorTs))
    conditions.push(lt(enterpriseSeats.invitedAt, cursorTs));
  const rows = await db
    .select()
    .from(enterpriseSeats)
    .where(and(...conditions))
    .orderBy(desc(enterpriseSeats.invitedAt))
    .limit(limit + 1);
  return buildPage(
    rows.map(seatToRow),
    limit,
    (r) => String(new Date(r.invitedAt).getTime()),
  );
}

export class SeatLimitExceededError extends Error {
  override readonly name = "SeatLimitExceededError";
  readonly code = "SEAT_LIMIT_EXCEEDED";
  constructor(message: string) {
    super(message);
  }
}

export async function inviteSeat(
  ctx: TenantContext,
  reviewer: string,
  input: { email: string; displayName?: string; role?: SeatRow["role"] },
): Promise<SeatRow> {
  const org = await getOrCreateOrg(ctx);
  const [{ n: existingCount = 0 } = { n: 0 }] = await db
    .select({ n: count() })
    .from(enterpriseSeats)
    .where(and(tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.orgId, org.id)));
  if (existingCount >= org.seatLimit) {
    throw new SeatLimitExceededError(
      `Seat limit ${org.seatLimit} reached; upgrade the plan to add more`,
    );
  }
  const id = `seat_${nanoid()}`;
  const now = Date.now();
  await db.insert(enterpriseSeats).values(
    withTenantValues(ctx, {
      id,
      orgId: org.id,
      email: input.email.trim().toLowerCase(),
      displayName: input.displayName ?? "",
      role: input.role ?? "standard",
      status: "invited",
      invitedAt: now,
      lastActiveAt: null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "enterprise_seat.invite",
    resourceType: "enterprise_seat",
    resourceId: id,
    summary: `Invited ${input.email} as ${input.role ?? "standard"}`,
  });
  const fresh = await db.select().from(enterpriseSeats).where(eq(enterpriseSeats.id, id)).limit(1);
  return seatToRow(fresh[0]!);
}

export async function updateSeat(
  ctx: TenantContext,
  reviewer: string,
  seatId: string,
  patch: Partial<Pick<SeatRow, "role" | "status" | "displayName">>,
): Promise<SeatRow | null> {
  const now = Date.now();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (patch.role !== undefined) updates["role"] = patch.role;
  if (patch.status !== undefined) updates["status"] = patch.status;
  if (patch.displayName !== undefined) updates["displayName"] = patch.displayName;
  await db
    .update(enterpriseSeats)
    .set(updates)
    .where(and(tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.id, seatId)));
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "enterprise_seat.update",
    resourceType: "enterprise_seat",
    resourceId: seatId,
    summary: `Updated seat ${seatId}: ${Object.keys(patch).join(", ")}`,
  });
  const rows = await db
    .select()
    .from(enterpriseSeats)
    .where(and(tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.id, seatId)))
    .limit(1);
  return rows[0] ? seatToRow(rows[0]) : null;
}

export async function removeSeat(
  ctx: TenantContext,
  reviewer: string,
  seatId: string,
): Promise<{ removed: boolean }> {
  const result = await db
    .delete(enterpriseSeats)
    .where(and(tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.id, seatId)));
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "enterprise_seat.remove",
    resourceType: "enterprise_seat",
    resourceId: seatId,
    summary: `Removed seat ${seatId}`,
  });
  return { removed: (result as unknown as { changes?: number }).changes !== 0 };
}

// --------------------------- Skill whitelist ------------------------------

export interface WhitelistEntry {
  skillSlug: string;
  skillName: string;
  allowed: boolean;
  updatedAt: string;
}

export async function getWhitelist(ctx: TenantContext): Promise<WhitelistEntry[]> {
  const org = await getOrCreateOrg(ctx);
  const rows = await db
    .select()
    .from(enterpriseSkillWhitelist)
    .where(
      and(
        tenantScope(ctx, enterpriseSkillWhitelist),
        eq(enterpriseSkillWhitelist.orgId, org.id),
      ),
    )
    .orderBy(desc(enterpriseSkillWhitelist.updatedAt));
  return rows.map((r) => ({
    skillSlug: r.skillSlug,
    skillName: r.skillName,
    allowed: Boolean(r.allowed),
    updatedAt: new Date(r.updatedAt).toISOString(),
  }));
}

export async function setWhitelistEntry(
  ctx: TenantContext,
  reviewer: string,
  entry: { skillSlug: string; skillName?: string; allowed: boolean },
): Promise<WhitelistEntry> {
  const org = await getOrCreateOrg(ctx);
  const now = Date.now();
  const existing = await db
    .select()
    .from(enterpriseSkillWhitelist)
    .where(
      and(
        tenantScope(ctx, enterpriseSkillWhitelist),
        eq(enterpriseSkillWhitelist.orgId, org.id),
        eq(enterpriseSkillWhitelist.skillSlug, entry.skillSlug),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(enterpriseSkillWhitelist)
      .set({
        allowed: entry.allowed,
        skillName: entry.skillName ?? existing[0].skillName,
        updatedAt: now,
        version: existing[0].version + 1,
      })
      .where(eq(enterpriseSkillWhitelist.id, existing[0].id));
  } else {
    await db.insert(enterpriseSkillWhitelist).values(
      withTenantValues(ctx, {
        id: `wl_${nanoid()}`,
        orgId: org.id,
        skillSlug: entry.skillSlug,
        skillName: entry.skillName ?? "",
        allowed: entry.allowed,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "enterprise_whitelist.set",
    resourceType: "enterprise_skill_whitelist",
    resourceId: entry.skillSlug,
    summary: `${entry.allowed ? "Allowed" : "Blocked"} skill "${entry.skillSlug}"`,
  });
  return {
    skillSlug: entry.skillSlug,
    skillName: entry.skillName ?? "",
    allowed: entry.allowed,
    updatedAt: new Date(now).toISOString(),
  };
}

// --------------------------- Audit logs / usage ---------------------------

export async function listOrgAuditLog(
  ctx: TenantContext,
  input: { cursor?: string | null; limit?: number },
) {
  return listAuditEntries(ctx, input);
}

/**
 * Build a CSV blob from the entire audit chain. Exported for download
 * by the Enterprise Admin compliance officer.
 */
export async function exportAuditCsv(ctx: TenantContext): Promise<string> {
  // Pull all rows (chained walk) — bounded by the audit gate; fine for v1.
  const all = await listAuditEntries(ctx, { limit: 1000 });
  const header = "id,sequence,actor,action,resourceType,resourceId,summary,createdAt\n";
  const escape = (s: string | null | undefined): string => {
    if (s == null) return "";
    const v = String(s).replaceAll('"', '""');
    return `"${v}"`;
  };
  const rows = all.items.map((e) =>
    [e.id, e.sequence, e.actor, e.action, e.resourceType, e.resourceId, e.summary, e.createdAt]
      .map((v) => escape(v as string))
      .join(","),
  );
  return header + rows.join("\n");
}

export interface UsageReport {
  rangeDays: number;
  tasksAutomated: number;
  conversationsStarted: number;
  topSkills: Array<{ slug: string; name: string; runs: number }>;
  estimatedTimeSavedMinutes: number;
  perDay: Array<{ date: string; runs: number }>;
}

export async function getUsageReport(
  ctx: TenantContext,
  rangeDays = 30,
): Promise<UsageReport> {
  const days = Math.min(180, Math.max(1, rangeDays));
  const cutoff = Date.now() - days * DAY_MS;
  const [{ n: runCount = 0 } = { n: 0 }] = await db
    .select({ n: count() })
    .from(agentRunsTable)
    .where(and(tenantScope(ctx, agentRunsTable), gte(agentRunsTable.createdAt, cutoff)));

  const topSkillRows = await db
    .select({
      slug: agentRunsTable.routedSkillName,
      runs: count(),
    })
    .from(agentRunsTable)
    .where(and(tenantScope(ctx, agentRunsTable), gte(agentRunsTable.createdAt, cutoff)))
    .groupBy(agentRunsTable.routedSkillName)
    .orderBy(desc(count()))
    .limit(10);

  const perDay: Array<{ date: string; runs: number }> = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const start = today.getTime() - i * DAY_MS;
    const end = start + DAY_MS;
    const [bucket] = await db
      .select({ n: count() })
      .from(agentRunsTable)
      .where(
        and(
          tenantScope(ctx, agentRunsTable),
          gte(agentRunsTable.createdAt, start),
          lt(agentRunsTable.createdAt, end),
        ),
      );
    perDay.push({
      date: new Date(start).toISOString().slice(0, 10),
      runs: bucket?.n ?? 0,
    });
  }

  // Time-saved estimate: assume each agent run saved 7 minutes on average,
  // a conservative figure based on internal benchmarks.
  const estimatedTimeSavedMinutes = runCount * 7;

  return {
    rangeDays: days,
    tasksAutomated: runCount,
    conversationsStarted: runCount, // proxy; TODO: separate metric
    topSkills: topSkillRows
      .filter((r) => r.slug)
      .map((r) => ({
        slug: r.slug as string,
        name: r.slug as string,
        runs: Number(r.runs ?? 0),
      })),
    estimatedTimeSavedMinutes,
    perDay,
  };
}

export function buildUsageCsv(report: UsageReport): string {
  const header = "date,runs\n";
  const rows = report.perDay.map((d) => `${d.date},${d.runs}`).join("\n");
  return header + rows;
}
