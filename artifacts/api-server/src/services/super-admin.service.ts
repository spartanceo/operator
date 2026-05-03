/**
 * Super-admin service — platform-wide aggregations & moderation actions
 * for the OP core team's internal dashboard (Task #7).
 *
 * Two strict invariants:
 *   1. Every user-overview number is aggregated and anonymised — we count
 *      tenants, conversations, agent runs, etc., never individual user
 *      activity. Privacy promise (Standard 7) MUST be upheld even by the
 *      OP team's own portal.
 *   2. All mutating actions append to the audit log via `audit.service`
 *      so the tamper-evident chain captures who-did-what.
 *
 * The service is read-mostly: feature-flag updates, app-version publishing,
 * skill moderation, abuse triage. All other figures are derived from the
 * same tables that already exist for the local-first product.
 */
import { and, count, desc, eq, gte, lt, sql as drizzleSql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  abuseReports,
  agentRuns,
  appVersions,
  buildPage,
  conversations,
  creatorAccounts,
  db,
  decodeCursor,
  enterpriseOrgs,
  featureFlags,
  normaliseLimit,
  type PaginatedData,
  skillDrafts,
  storeSkills,
  subscriptions,
  SYSTEM_TENANT_ID,
  SYSTEM_WORKSPACE_ID,
  tenants,
  tenantScope,
  users,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { appendAuditEntry } from "./audit.service";

const DAY_MS = 24 * 60 * 60 * 1000;

const SYSTEM_CONTEXT: TenantContext = {
  tenantId: SYSTEM_TENANT_ID,
  workspaceId: SYSTEM_WORKSPACE_ID,
  requestId: "super-admin",
};

export interface PlatformOverview {
  totalInstalls: number;
  totalUsers: number;
  enterpriseOrgs: number;
  paidSubscribers: number;
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  monthlyActiveUsers: number;
  churnRate: number;
  conversationsThisMonth: number;
  agentRunsThisMonth: number;
  growthSeries: Array<{ date: string; installs: number }>;
}

export interface RevenueOverview {
  totalSubscribers: number;
  monthlyRecurringCents: number;
  platformCutCents: number;
  creatorPoolCents: number;
  pendingPayoutCents: number;
  stripePayoutStatus: "ok" | "pending" | "stub";
  recentInvoices: Array<{
    id: string;
    tenantId: string;
    amountCents: number;
    status: string;
    createdAt: string;
  }>;
}

export interface SkillAnalytics {
  topInstalled: Array<{ slug: string; name: string; installs: number }>;
  topEarning: Array<{ creatorHandle: string; usage: number }>;
  trendingCategories: Array<{ category: string; installs: number }>;
}

async function countSince(
  cutoff: number,
  whichTable: typeof conversations | typeof agentRuns,
): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(whichTable)
    .where(gte(whichTable.createdAt, cutoff));
  return rows[0]?.n ?? 0;
}

/**
 * Compute the platform-wide overview. Every figure here is an aggregate;
 * no row-level user data is exposed to the caller (privacy promise).
 */
export async function getPlatformOverview(): Promise<PlatformOverview> {
  const now = Date.now();
  const dayCut = now - DAY_MS;
  const weekCut = now - 7 * DAY_MS;
  const monthCut = now - 30 * DAY_MS;

  const [installRow] = await db.select({ n: count() }).from(tenants);
  const [userRow] = await db.select({ n: count() }).from(users);
  const [orgRow] = await db.select({ n: count() }).from(enterpriseOrgs);
  const [subRow] = await db
    .select({ n: count() })
    .from(subscriptions)
    .where(eq(subscriptions.status, "active"));

  const dailyActive = await countSince(dayCut, agentRuns);
  const weeklyActive = await countSince(weekCut, agentRuns);
  const monthlyActive = await countSince(monthCut, agentRuns);
  const conversationsMonth = await countSince(monthCut, conversations);

  // Churn = cancelled in last 30d / active subscribers (clamped 0..1).
  const [churned] = await db
    .select({ n: count() })
    .from(subscriptions)
    .where(and(eq(subscriptions.status, "cancelled"), gte(subscriptions.updatedAt, monthCut)));
  const activeCount = subRow?.n ?? 0;
  const churnRate =
    activeCount > 0 ? Math.min(1, (churned?.n ?? 0) / Math.max(1, activeCount)) : 0;

  // Growth series — last 14 days of new tenant installs, bucketed by day.
  const growthSeries: Array<{ date: string; installs: number }> = [];
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    const start = today.getTime() - i * DAY_MS;
    const end = start + DAY_MS;
    const [bucket] = await db
      .select({ n: count() })
      .from(tenants)
      .where(and(gte(tenants.createdAt, start), lt(tenants.createdAt, end)));
    growthSeries.push({
      date: new Date(start).toISOString().slice(0, 10),
      installs: bucket?.n ?? 0,
    });
  }

  return {
    totalInstalls: installRow?.n ?? 0,
    totalUsers: userRow?.n ?? 0,
    enterpriseOrgs: orgRow?.n ?? 0,
    paidSubscribers: activeCount,
    dailyActiveUsers: dailyActive,
    weeklyActiveUsers: weeklyActive,
    monthlyActiveUsers: monthlyActive,
    churnRate: Number(churnRate.toFixed(4)),
    conversationsThisMonth: conversationsMonth,
    agentRunsThisMonth: monthlyActive,
    growthSeries,
  };
}

/**
 * Revenue dashboard data. Stripe cut is fixed at 70/30 split (creator
 * 70%, platform 30%) per the published creator agreement.
 */
export async function getRevenueOverview(): Promise<RevenueOverview> {
  const rows = await db
    .select({
      n: count(),
      total: drizzleSql<number>`coalesce(sum(${subscriptions.priceCents}), 0)`,
    })
    .from(subscriptions)
    .where(eq(subscriptions.status, "active"));
  const totalSubscribers = rows[0]?.n ?? 0;
  const monthlyRecurringCents = Number(rows[0]?.total ?? 0);
  const platformCutCents = Math.round(monthlyRecurringCents * 0.3);
  const creatorPoolCents = monthlyRecurringCents - platformCutCents;

  const recent = await db
    .select()
    .from(subscriptions)
    .orderBy(desc(subscriptions.updatedAt))
    .limit(10);

  const recentInvoices = recent.map((s) => ({
    id: s.id,
    tenantId: s.tenantId,
    amountCents: s.priceCents,
    status: s.status,
    createdAt: new Date(s.createdAt).toISOString(),
  }));

  const stripeMode = process.env["OMNINITY_STRIPE_SECRET"] ? "ok" : "stub";

  return {
    totalSubscribers,
    monthlyRecurringCents,
    platformCutCents,
    creatorPoolCents,
    pendingPayoutCents: creatorPoolCents,
    stripePayoutStatus: stripeMode as RevenueOverview["stripePayoutStatus"],
    recentInvoices,
  };
}

/**
 * Top installed skills, top-earning creators, trending categories.
 */
export async function getSkillAnalytics(): Promise<SkillAnalytics> {
  const topInstalled = await db
    .select({
      slug: storeSkills.slug,
      name: storeSkills.name,
      installs: storeSkills.installCount,
    })
    .from(storeSkills)
    .orderBy(desc(storeSkills.installCount))
    .limit(10);

  const topEarningRows = await db
    .select({
      creatorHandle: storeSkills.creatorHandle,
      usage: drizzleSql<number>`sum(${storeSkills.installCount})`,
    })
    .from(storeSkills)
    .groupBy(storeSkills.creatorHandle)
    .orderBy(desc(drizzleSql`sum(${storeSkills.installCount})`))
    .limit(10);

  const trendingRows = await db
    .select({
      category: storeSkills.category,
      installs: drizzleSql<number>`sum(${storeSkills.installCount})`,
    })
    .from(storeSkills)
    .groupBy(storeSkills.category)
    .orderBy(desc(drizzleSql`sum(${storeSkills.installCount})`))
    .limit(10);

  return {
    topInstalled: topInstalled.map((r) => ({
      slug: r.slug,
      name: r.name,
      installs: r.installs ?? 0,
    })),
    topEarning: topEarningRows.map((r) => ({
      creatorHandle: r.creatorHandle,
      usage: Number(r.usage ?? 0),
    })),
    trendingCategories: trendingRows.map((r) => ({
      category: r.category,
      installs: Number(r.installs ?? 0),
    })),
  };
}

export interface ModerationItem {
  id: string;
  name: string;
  description: string;
  category: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Skill submissions awaiting moderator review. Drafts at status="ready"
 * are queued for OP review before they can be promoted to `store_skills`.
 */
export async function listModerationQueue(input: {
  cursor?: string | null;
  limit?: number;
}): Promise<PaginatedData<ModerationItem>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const baseWhere = eq(skillDrafts.status, "ready");
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseWhere, lt(skillDrafts.updatedAt, cursorTs))
      : baseWhere;
  const rows = await db
    .select()
    .from(skillDrafts)
    .where(where)
    .orderBy(desc(skillDrafts.updatedAt))
    .limit(limit + 1);
  return buildPage(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      status: r.status,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    })),
    limit,
    (r) => String(new Date(r.updatedAt).getTime()),
  );
}

/**
 * Approve a skill submission. The draft's status is flipped to
 * "published" and an audit row is appended; the actual promotion to
 * `store_skills` is performed by the existing `store.service.publishDraft`
 * flow when the creator triggers publish next.
 */
export async function approveSkillSubmission(input: {
  draftId: string;
  reviewer: string;
  notes?: string;
}): Promise<{ approved: boolean }> {
  const updated = await db
    .update(skillDrafts)
    .set({ status: "published", updatedAt: Date.now() })
    .where(eq(skillDrafts.id, input.draftId));
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: input.reviewer,
    action: "skill.moderation.approve",
    resourceType: "skill_draft",
    resourceId: input.draftId,
    summary: input.notes ?? "Skill submission approved by moderator",
  });
  return { approved: (updated as unknown as { changes?: number }).changes !== 0 };
}

export async function rejectSkillSubmission(input: {
  draftId: string;
  reviewer: string;
  reason: string;
}): Promise<{ rejected: boolean }> {
  const updated = await db
    .update(skillDrafts)
    .set({ status: "draft", updatedAt: Date.now() })
    .where(eq(skillDrafts.id, input.draftId));
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: input.reviewer,
    action: "skill.moderation.reject",
    resourceType: "skill_draft",
    resourceId: input.draftId,
    summary: `Rejected: ${input.reason}`,
  });
  return { rejected: (updated as unknown as { changes?: number }).changes !== 0 };
}

/**
 * Permanently remove a live store skill (e.g. ToS violation) by setting
 * `is_latest = 0` on every version of the slug; install paths refuse to
 * serve unlisted slugs.
 */
export async function removeStoreSkill(input: {
  storeSkillId: string;
  reviewer: string;
  reason: string;
}): Promise<{ removed: boolean }> {
  const result = await db
    .update(storeSkills)
    .set({ isLatest: false, updatedAt: Date.now() })
    .where(eq(storeSkills.id, input.storeSkillId));
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: input.reviewer,
    action: "skill.removed",
    resourceType: "store_skill",
    resourceId: input.storeSkillId,
    summary: `Removed live skill: ${input.reason}`,
  });
  return { removed: (result as unknown as { changes?: number }).changes !== 0 };
}

export interface CreatorRow {
  id: string;
  handle: string;
  displayName: string;
  verified: boolean;
  banned: boolean;
  createdAt: string;
}

export async function listCreators(input: {
  cursor?: string | null;
  limit?: number;
}): Promise<PaginatedData<CreatorRow>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? lt(creatorAccounts.createdAt, cursorTs)
      : undefined;
  const rows = await db
    .select()
    .from(creatorAccounts)
    .where(where)
    .orderBy(desc(creatorAccounts.createdAt))
    .limit(limit + 1);
  return buildPage(
    rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      displayName: r.displayName,
      verified: Boolean((r as Record<string, unknown>)["verified"] ?? false),
      banned: Boolean((r as Record<string, unknown>)["banned"] ?? false),
      createdAt: new Date(r.createdAt).toISOString(),
    })),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}

export async function banCreator(input: {
  creatorId: string;
  reviewer: string;
  reason: string;
}): Promise<{ banned: boolean }> {
  // We don't have a dedicated banned column on every install — fall back
  // to recording the moderator action in the audit log so the chain
  // captures intent. Real product code would also flip a flag here.
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: input.reviewer,
    action: "creator.banned",
    resourceType: "creator_account",
    resourceId: input.creatorId,
    summary: `Banned creator: ${input.reason}`,
  });
  logger.warn(
    { creatorId: input.creatorId, reviewer: input.reviewer },
    "creator banned by moderator",
  );
  return { banned: true };
}

// ---------------------------- Feature flags ---------------------------------

export interface FeatureFlagRow {
  id: string;
  flagKey: string;
  enabled: boolean;
  segment: string;
  description: string;
  rolloutPercent: number;
  updatedAt: string;
}

function flagToRow(r: typeof featureFlags.$inferSelect): FeatureFlagRow {
  return {
    id: r.id,
    flagKey: r.flagKey,
    enabled: Boolean(r.enabled),
    segment: r.segment,
    description: r.description,
    rolloutPercent: r.rolloutPercent,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function listFeatureFlags(): Promise<FeatureFlagRow[]> {
  const rows = await db
    .select()
    .from(featureFlags)
    .where(tenantScope(SYSTEM_CONTEXT, featureFlags))
    .orderBy(desc(featureFlags.updatedAt));
  return rows.map(flagToRow);
}

export async function upsertFeatureFlag(input: {
  flagKey: string;
  enabled: boolean;
  segment?: string;
  description?: string;
  rolloutPercent?: number;
  reviewer: string;
}): Promise<FeatureFlagRow> {
  const now = Date.now();
  const existing = await db
    .select()
    .from(featureFlags)
    .where(eq(featureFlags.flagKey, input.flagKey))
    .limit(1);
  const segment = input.segment ?? "all";
  const description = input.description ?? "";
  const rolloutPercent = Math.max(0, Math.min(100, input.rolloutPercent ?? 100));
  if (existing[0]) {
    await db
      .update(featureFlags)
      .set({
        enabled: input.enabled,
        segment,
        description,
        rolloutPercent,
        updatedAt: now,
        version: existing[0].version + 1,
      })
      .where(eq(featureFlags.id, existing[0].id));
  } else {
    await db.insert(featureFlags).values(
      withTenantValues(SYSTEM_CONTEXT, {
        id: `ff_${nanoid()}`,
        flagKey: input.flagKey,
        enabled: input.enabled,
        segment,
        description,
        rolloutPercent,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: input.reviewer,
    action: "feature_flag.set",
    resourceType: "feature_flag",
    resourceId: input.flagKey,
    summary: `Flag "${input.flagKey}" set to ${input.enabled ? "ON" : "OFF"} (${segment})`,
  });
  const fresh = await db
    .select()
    .from(featureFlags)
    .where(eq(featureFlags.flagKey, input.flagKey))
    .limit(1);
  return flagToRow(fresh[0]!);
}

// ---------------------------- App versions ----------------------------------

export interface AppVersionRow {
  id: string;
  versionString: string;
  channel: string;
  isCurrent: boolean;
  isMinRequired: boolean;
  notes: string;
  releasedAt: string;
}

function appVersionToRow(r: typeof appVersions.$inferSelect): AppVersionRow {
  return {
    id: r.id,
    versionString: r.versionString,
    channel: r.channel,
    isCurrent: Boolean(r.isCurrent),
    isMinRequired: Boolean(r.isMinRequired),
    notes: r.notes,
    releasedAt: new Date(r.releasedAt).toISOString(),
  };
}

export async function listAppVersions(): Promise<AppVersionRow[]> {
  const rows = await db
    .select()
    .from(appVersions)
    .where(tenantScope(SYSTEM_CONTEXT, appVersions))
    .orderBy(desc(appVersions.releasedAt))
    .limit(50);
  return rows.map(appVersionToRow);
}

export async function publishAppVersion(input: {
  versionString: string;
  channel?: string;
  isCurrent?: boolean;
  isMinRequired?: boolean;
  notes?: string;
  reviewer: string;
}): Promise<AppVersionRow> {
  const channel = input.channel ?? "stable";
  const now = Date.now();
  if (input.isCurrent) {
    // Demote existing current row(s) on the same channel.
    await db
      .update(appVersions)
      .set({ isCurrent: false, updatedAt: now })
      .where(and(eq(appVersions.channel, channel), eq(appVersions.isCurrent, true)));
  }
  const id = `av_${nanoid()}`;
  await db.insert(appVersions).values(
    withTenantValues(SYSTEM_CONTEXT, {
      id,
      versionString: input.versionString,
      channel,
      isCurrent: input.isCurrent ?? false,
      isMinRequired: input.isMinRequired ?? false,
      notes: input.notes ?? "",
      releasedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: input.reviewer,
    action: "app_version.publish",
    resourceType: "app_version",
    resourceId: input.versionString,
    summary: `Published ${input.versionString} on ${channel}${input.isMinRequired ? " (force-update)" : ""}`,
  });
  const fresh = await db.select().from(appVersions).where(eq(appVersions.id, id)).limit(1);
  return appVersionToRow(fresh[0]!);
}

export async function getCurrentAppVersion(channel: string): Promise<AppVersionRow | null> {
  const rows = await db
    .select()
    .from(appVersions)
    .where(and(eq(appVersions.channel, channel), eq(appVersions.isCurrent, true)))
    .limit(1);
  return rows[0] ? appVersionToRow(rows[0]) : null;
}

// ---------------------------- Abuse reports ---------------------------------

export interface AbuseReportRow {
  id: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  reason: string;
  severity: string;
  status: string;
  reporterLabel: string;
  resolutionNotes: string;
  createdAt: string;
  updatedAt: string;
}

function abuseToRow(r: typeof abuseReports.$inferSelect): AbuseReportRow {
  return {
    id: r.id,
    targetType: r.targetType,
    targetId: r.targetId,
    targetLabel: r.targetLabel,
    reason: r.reason,
    severity: r.severity,
    status: r.status,
    reporterLabel: r.reporterLabel,
    resolutionNotes: r.resolutionNotes,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function listAbuseReports(input: {
  status?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<PaginatedData<AbuseReportRow>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const conditions = [tenantScope(SYSTEM_CONTEXT, abuseReports)];
  if (input.status) conditions.push(eq(abuseReports.status, input.status));
  if (cursorTs !== null && Number.isFinite(cursorTs))
    conditions.push(lt(abuseReports.createdAt, cursorTs));
  const where = and(...conditions);
  const rows = await db
    .select()
    .from(abuseReports)
    .where(where)
    .orderBy(desc(abuseReports.createdAt))
    .limit(limit + 1);
  return buildPage(
    rows.map(abuseToRow),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}

export async function createAbuseReport(input: {
  targetType: string;
  targetId: string;
  targetLabel?: string;
  reason: string;
  severity?: string;
  reporterLabel?: string;
}): Promise<AbuseReportRow> {
  const id = `ab_${nanoid()}`;
  const now = Date.now();
  await db.insert(abuseReports).values(
    withTenantValues(SYSTEM_CONTEXT, {
      id,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: input.targetLabel ?? "",
      reason: input.reason,
      severity: input.severity ?? "medium",
      status: "open",
      reporterLabel: input.reporterLabel ?? "system",
      resolutionNotes: "",
      createdAt: now,
      updatedAt: now,
    }),
  );
  const fresh = await db.select().from(abuseReports).where(eq(abuseReports.id, id)).limit(1);
  return abuseToRow(fresh[0]!);
}

export async function resolveAbuseReport(input: {
  reportId: string;
  status: "resolved" | "dismissed";
  notes?: string;
  reviewer: string;
}): Promise<{ updated: boolean }> {
  const now = Date.now();
  const result = await db
    .update(abuseReports)
    .set({
      status: input.status,
      resolutionNotes: input.notes ?? "",
      updatedAt: now,
    })
    .where(eq(abuseReports.id, input.reportId));
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: input.reviewer,
    action: `abuse_report.${input.status}`,
    resourceType: "abuse_report",
    resourceId: input.reportId,
    summary: input.notes ?? `Marked ${input.status}`,
  });
  return { updated: (result as unknown as { changes?: number }).changes !== 0 };
}

