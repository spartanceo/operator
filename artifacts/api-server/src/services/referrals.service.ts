/**
 * Referrals service — referral codes, attribution, dual-reward grants,
 * acquisition-channel survey, enterprise-trial invites, and beta-tier
 * unlock based on the completed-referral threshold.
 *
 * Design notes (Standard 13 / Standard 6):
 *   - `tenantScope(ctx, table)` is used on every read and `withTenantValues`
 *     on every write — no hand-rolled tenant predicates.
 *   - `referral_codes`, `acquisition_channels`, and `beta_access_grants`
 *     are singleton-per-tenant, enforced by their unique indexes.
 *   - `referrals.status` transitions are monotonic ('pending' → 'completed').
 *     A second completion attempt on the same row is idempotent — we only
 *     grant rewards on the first transition.
 *   - Rewards are always granted in pairs (referrer + referred). Both rows
 *     point at the same `referralId` so the dashboard can group them.
 */
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  acquisitionChannels,
  betaAccessGrants,
  db,
  enterpriseTrialInvites,
  referralCodes,
  referralRewards,
  referrals,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

/** Reward window: 30 days of curated premium-skill access. */
export const REWARD_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const REWARD_KIND = "premium_skill_access_30d" as const;
/** Beta access unlocks at this many completed referrals. */
export const BETA_REFERRAL_THRESHOLD = 3;

/** Public base URL used to render the share link. */
function baseShareUrl(): string {
  const fromEnv = process.env["OMNINITY_PUBLIC_BASE_URL"];
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/$/, "");
  return "https://omninity.app";
}

/** Generate a fresh URL-safe referral code (12 chars). */
function newCode(): string {
  return nanoid(12);
}

export interface ReferralCodeRow {
  code: string;
  shareUrl: string;
  createdAt: string;
}

export interface ReferralRow {
  id: string;
  code: string;
  status: "pending" | "completed";
  referredEmail: string | null;
  referredLabel: string | null;
  completedAt: string | null;
  rewardGrantedAt: string | null;
  createdAt: string;
}

export interface ReferralRewardRow {
  id: string;
  referralId: string | null;
  kind: string;
  role: "referrer" | "referred";
  grantedAt: string;
  expiresAt: string;
  active: boolean;
}

export interface ReferralDashboard {
  code: ReferralCodeRow;
  totalReferred: number;
  totalCompleted: number;
  totalPending: number;
  activeRewards: number;
  betaUnlocked: boolean;
  betaThreshold: number;
  referrals: ReferralRow[];
  rewards: ReferralRewardRow[];
}

function codeToRow(r: typeof referralCodes.$inferSelect): ReferralCodeRow {
  return {
    code: r.code,
    shareUrl: r.shareUrl,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

function refToRow(r: typeof referrals.$inferSelect): ReferralRow {
  return {
    id: r.id,
    code: r.code,
    status: (r.status as "pending" | "completed") ?? "pending",
    referredEmail: r.referredEmail,
    referredLabel: r.referredLabel,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    rewardGrantedAt: r.rewardGrantedAt
      ? new Date(r.rewardGrantedAt).toISOString()
      : null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

function rewardToRow(r: typeof referralRewards.$inferSelect): ReferralRewardRow {
  const now = Date.now();
  return {
    id: r.id,
    referralId: r.referralId,
    kind: r.kind,
    role: (r.role as "referrer" | "referred") ?? "referrer",
    grantedAt: new Date(r.grantedAt).toISOString(),
    expiresAt: new Date(r.expiresAt).toISOString(),
    active: r.expiresAt > now,
  };
}

export class ReferralValidationError extends Error {
  override readonly name = "ReferralValidationError";
  readonly code = "REFERRAL_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

export class ReferralNotFoundError extends Error {
  override readonly name = "ReferralNotFoundError";
  readonly code = "REFERRAL_NOT_FOUND";
  constructor(message: string) {
    super(message);
  }
}

/** Get the tenant's referral code, generating one on first access. */
export async function getOrCreateReferralCode(
  ctx: TenantContext,
): Promise<ReferralCodeRow> {
  const existing = await db
    .select()
    .from(referralCodes)
    .where(tenantScope(ctx, referralCodes))
    .limit(1);
  if (existing[0]) return codeToRow(existing[0]);

  // Generate a unique code with bounded retries (collisions are
  // astronomically unlikely with nanoid(12) but the index is unique).
  let attempts = 0;
  while (attempts < 5) {
    const code = newCode();
    const shareUrl = `${baseShareUrl()}/r/${code}`;
    try {
      const inserted = await db
        .insert(referralCodes)
        .values(
          withTenantValues(ctx, {
            id: `ref_${nanoid()}`,
            code,
            shareUrl,
          }),
        )
        .returning();
      const row = inserted[0];
      if (row) return codeToRow(row);
    } catch (e) {
      logger.warn({ err: e, attempts }, "Referral code collision, retrying");
    }
    attempts++;
  }
  throw new Error("Failed to allocate a unique referral code");
}

/**
 * Resolve a referral code to its owning tenantId. Returns null when the
 * code is unknown — callers must treat null as "no attribution".
 */
export async function resolveReferralCode(
  code: string,
): Promise<{ tenantId: string; code: string } | null> {
  const rows = await db
    .select()
    .from(referralCodes)
    .where(eq(referralCodes.code, code))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { tenantId: row.tenantId, code: row.code };
}

/**
 * Record an attribution: the current `ctx` is the referred tenant and
 * `code` is the referrer's code. Idempotent on (referrer, referred).
 *
 * Self-referral attempts are rejected to keep the reward loop honest.
 */
export async function attributeReferral(
  ctx: TenantContext,
  input: { code: string; email?: string; label?: string },
): Promise<ReferralRow> {
  const trimmed = input.code.trim();
  if (trimmed.length === 0) {
    throw new ReferralValidationError("referral code required");
  }
  const resolved = await resolveReferralCode(trimmed);
  if (!resolved) {
    throw new ReferralNotFoundError(`Unknown referral code "${trimmed}"`);
  }
  if (resolved.tenantId === ctx.tenantId) {
    throw new ReferralValidationError("cannot self-refer");
  }
  // Already-attributed? Return the existing row (idempotent).
  const existing = await db
    .select()
    .from(referrals)
    .where(
      and(
        eq(referrals.referrerTenantId, resolved.tenantId),
        eq(referrals.referredTenantId, ctx.tenantId),
      ),
    )
    .limit(1);
  if (existing[0]) return refToRow(existing[0]);

  const id = `ref_${nanoid()}`;
  const inserted = await db
    .insert(referrals)
    .values({
      id,
      tenantId: resolved.tenantId,
      referrerTenantId: resolved.tenantId,
      referredTenantId: ctx.tenantId,
      referredEmail: input.email ?? null,
      referredLabel: input.label ?? null,
      code: resolved.code,
      status: "pending",
    })
    .returning();
  return refToRow(inserted[0]!);
}

/**
 * Mark the current tenant's pending referral as completed and grant the
 * dual reward to both sides. Called from the onboarding completion flow.
 *
 * Returns null when the tenant has no pending referral. Idempotent — a
 * second call after completion is a no-op.
 */
export async function completeReferralForReferred(
  ctx: TenantContext,
): Promise<{ referral: ReferralRow; rewards: ReferralRewardRow[] } | null> {
  const pending = await db
    .select()
    .from(referrals)
    .where(
      and(
        eq(referrals.referredTenantId, ctx.tenantId),
        eq(referrals.status, "pending"),
      ),
    )
    .limit(1);
  const row = pending[0];
  if (!row) return null;

  const now = Date.now();
  const expires = now + REWARD_DURATION_MS;

  await db
    .update(referrals)
    .set({
      status: "completed",
      completedAt: now,
      rewardGrantedAt: now,
      updatedAt: now,
      version: row.version + 1,
    })
    .where(eq(referrals.id, row.id));

  // Grant both rewards under the referrer's tenantId for the referrer
  // row, and under the referred tenant for the other.
  const referrerReward = await db
    .insert(referralRewards)
    .values({
      id: `rwd_${nanoid()}`,
      tenantId: row.referrerTenantId,
      referralId: row.id,
      kind: REWARD_KIND,
      role: "referrer",
      grantedAt: now,
      expiresAt: expires,
    })
    .returning();
  const referredReward = await db
    .insert(referralRewards)
    .values({
      id: `rwd_${nanoid()}`,
      tenantId: ctx.tenantId,
      referralId: row.id,
      kind: REWARD_KIND,
      role: "referred",
      grantedAt: now,
      expiresAt: expires,
    })
    .returning();

  // Check if the referrer just crossed the beta threshold.
  await maybeGrantBetaAccess(row.referrerTenantId);

  const rewards = [...referrerReward, ...referredReward].map(rewardToRow);
  return {
    referral: refToRow({
      ...row,
      status: "completed",
      completedAt: now,
      rewardGrantedAt: now,
      updatedAt: now,
    } as typeof referrals.$inferSelect),
    rewards,
  };
}

/** Internal: count completed referrals for a tenant. */
async function countCompletedReferrals(tenantId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(referrals)
    .where(
      and(
        eq(referrals.referrerTenantId, tenantId),
        eq(referrals.status, "completed"),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/** Internal: grant beta access if the threshold is crossed. Idempotent. */
async function maybeGrantBetaAccess(tenantId: string): Promise<void> {
  const completed = await countCompletedReferrals(tenantId);
  if (completed < BETA_REFERRAL_THRESHOLD) return;
  const existing = await db
    .select()
    .from(betaAccessGrants)
    .where(eq(betaAccessGrants.tenantId, tenantId))
    .limit(1);
  if (existing[0]) return;
  await db
    .insert(betaAccessGrants)
    .values({
      id: `beta_${nanoid()}`,
      tenantId,
      tier: "beta",
      reason: "referral_threshold",
      grantedAt: Date.now(),
    })
    .onConflictDoNothing();
  logger.info({ tenantId }, "Beta access granted via referral threshold");
}

export async function getDashboard(ctx: TenantContext): Promise<ReferralDashboard> {
  const code = await getOrCreateReferralCode(ctx);
  const referralRows = await db
    .select()
    .from(referrals)
    .where(eq(referrals.referrerTenantId, ctx.tenantId))
    .orderBy(desc(referrals.createdAt))
    .limit(200);
  const rewardRows = await db
    .select()
    .from(referralRewards)
    .where(tenantScope(ctx, referralRewards))
    .orderBy(desc(referralRewards.createdAt))
    .limit(200);
  const beta = await db
    .select()
    .from(betaAccessGrants)
    .where(tenantScope(ctx, betaAccessGrants))
    .limit(1);
  const now = Date.now();
  const completed = referralRows.filter((r) => r.status === "completed").length;
  const pending = referralRows.length - completed;
  const activeRewards = rewardRows.filter((r) => r.expiresAt > now).length;
  return {
    code,
    totalReferred: referralRows.length,
    totalCompleted: completed,
    totalPending: pending,
    activeRewards,
    betaUnlocked: beta.length > 0,
    betaThreshold: BETA_REFERRAL_THRESHOLD,
    referrals: referralRows.map(refToRow),
    rewards: rewardRows.map(rewardToRow),
  };
}

export async function listActiveRewards(
  ctx: TenantContext,
): Promise<ReferralRewardRow[]> {
  const rows = await db
    .select()
    .from(referralRewards)
    .where(
      and(tenantScope(ctx, referralRewards), gt(referralRewards.expiresAt, Date.now())),
    )
    .orderBy(desc(referralRewards.expiresAt));
  return rows.map(rewardToRow);
}

// ─── Acquisition channel ────────────────────────────────────────────────

export type AcquisitionChannelKey =
  | "search"
  | "social"
  | "friend"
  | "creator"
  | "podcast"
  | "blog"
  | "work"
  | "other";

export async function getAcquisitionChannel(ctx: TenantContext): Promise<{
  channel: AcquisitionChannelKey | null;
  detail: string | null;
} | null> {
  const rows = await db
    .select()
    .from(acquisitionChannels)
    .where(tenantScope(ctx, acquisitionChannels))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    channel: row.channel as AcquisitionChannelKey,
    detail: row.detail,
  };
}

export async function setAcquisitionChannel(
  ctx: TenantContext,
  input: { channel: AcquisitionChannelKey; detail?: string },
): Promise<{ channel: AcquisitionChannelKey; detail: string | null }> {
  const existing = await db
    .select()
    .from(acquisitionChannels)
    .where(tenantScope(ctx, acquisitionChannels))
    .limit(1);
  const now = Date.now();
  if (existing[0]) {
    await db
      .update(acquisitionChannels)
      .set({
        channel: input.channel,
        detail: input.detail ?? null,
        updatedAt: now,
        version: existing[0].version + 1,
      })
      .where(eq(acquisitionChannels.id, existing[0].id));
  } else {
    await db
      .insert(acquisitionChannels)
      .values(
        withTenantValues(ctx, {
          id: `acq_${nanoid()}`,
          channel: input.channel,
          detail: input.detail ?? null,
        }),
      )
      .onConflictDoNothing();
  }
  return { channel: input.channel, detail: input.detail ?? null };
}

// ─── Enterprise trial invites ───────────────────────────────────────────

export interface EnterpriseTrialInviteRow {
  id: string;
  colleagueEmail: string;
  colleagueName: string | null;
  company: string | null;
  note: string | null;
  status: string;
  createdAt: string;
}

function inviteToRow(
  r: typeof enterpriseTrialInvites.$inferSelect,
): EnterpriseTrialInviteRow {
  return {
    id: r.id,
    colleagueEmail: r.colleagueEmail,
    colleagueName: r.colleagueName,
    company: r.company,
    note: r.note,
    status: r.status,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export async function createEnterpriseTrialInvite(
  ctx: TenantContext,
  input: {
    colleagueEmail: string;
    colleagueName?: string;
    company?: string;
    note?: string;
  },
): Promise<EnterpriseTrialInviteRow> {
  const email = input.colleagueEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ReferralValidationError("invalid colleague email");
  }
  const id = `ent_${nanoid()}`;
  const inserted = await db
    .insert(enterpriseTrialInvites)
    .values(
      withTenantValues(ctx, {
        id,
        colleagueEmail: email,
        colleagueName: input.colleagueName ?? null,
        company: input.company ?? null,
        note: input.note ?? null,
        status: "pending",
      }),
    )
    .returning();
  return inviteToRow(inserted[0]!);
}

export async function listEnterpriseTrialInvites(
  ctx: TenantContext,
): Promise<EnterpriseTrialInviteRow[]> {
  const rows = await db
    .select()
    .from(enterpriseTrialInvites)
    .where(tenantScope(ctx, enterpriseTrialInvites))
    .orderBy(desc(enterpriseTrialInvites.createdAt))
    .limit(100);
  return rows.map(inviteToRow);
}

// ─── Beta access ────────────────────────────────────────────────────────

export interface BetaAccessRow {
  unlocked: boolean;
  tier: string | null;
  reason: string | null;
  grantedAt: string | null;
  threshold: number;
  completedReferrals: number;
}

export async function getBetaAccess(ctx: TenantContext): Promise<BetaAccessRow> {
  const rows = await db
    .select()
    .from(betaAccessGrants)
    .where(tenantScope(ctx, betaAccessGrants))
    .limit(1);
  const completed = await countCompletedReferrals(ctx.tenantId);
  const row = rows[0];
  if (!row) {
    return {
      unlocked: false,
      tier: null,
      reason: null,
      grantedAt: null,
      threshold: BETA_REFERRAL_THRESHOLD,
      completedReferrals: completed,
    };
  }
  return {
    unlocked: true,
    tier: row.tier,
    reason: row.reason,
    grantedAt: new Date(row.grantedAt).toISOString(),
    threshold: BETA_REFERRAL_THRESHOLD,
    completedReferrals: completed,
  };
}
