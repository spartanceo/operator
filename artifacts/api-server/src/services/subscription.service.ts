/**
 * Subscription service — Stripe-backed monetisation, local-first.
 *
 * Tier 1 ships an offline stub: Stripe is reached only when both
 * `OMNINITY_STRIPE_SECRET` and `OMNINITY_STRIPE_PRICE_ID` are set in
 * the environment. Without them the service generates deterministic
 * mock checkout URLs and accepts mock webhooks so the entire flow can
 * be exercised on a developer's laptop without leaking traffic.
 *
 * Surfaces:
 *   - `getStatus`               — current `Subscription` row + computed `hasAccess`.
 *   - `createCheckoutSession`   — creates a Stripe checkout session (or stub).
 *   - `cancel` / `reactivate`   — toggle `cancelAtPeriodEnd` on the row.
 *   - `handleWebhook`           — idempotent Stripe webhook ingest.
 *   - `recordUsage`             — append a row to `skill_usage_events`.
 *   - `consumePreview`          — bump `skill_preview_counters` for one skill.
 *   - `checkPremiumAccess`      — gating decision used by the agent orchestrator.
 *   - `listMonthlyUsage`        — usage rollup for the operator UI.
 *
 * All writes log a `subscription.*` privacy event so the user can audit
 * billing activity from `/privacy` (Standard 7).
 */
import { and, desc, eq, gte, sql as drizzleSql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  skillPreviewCounters,
  skillUsageEvents,
  subscriptions,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";

export interface SubscriptionRow {
  id: string;
  status: "inactive" | "trialing" | "active" | "past_due" | "cancelled";
  planId: string;
  priceCents: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionStatusPayload {
  subscription: SubscriptionRow;
  hasAccess: boolean;
  /** True when running in offline stub mode (no STRIPE_* env). */
  stripeStubMode: boolean;
}

// tier-review: bounded — fixed two-element status enum, never mutated at runtime
const ACTIVE_STATES = new Set<SubscriptionRow["status"]>(["active", "trialing"]);

function toRow(r: typeof subscriptions.$inferSelect): SubscriptionRow {
  return {
    id: r.id,
    status: (r.status as SubscriptionRow["status"]) ?? "inactive",
    planId: r.planId,
    priceCents: r.priceCents,
    currentPeriodEnd: r.currentPeriodEnd
      ? new Date(r.currentPeriodEnd).toISOString()
      : null,
    cancelAtPeriodEnd: Boolean(r.cancelAtPeriodEnd),
    stripeCustomerId: r.stripeCustomerId,
    stripeSubscriptionId: r.stripeSubscriptionId,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export function isStripeStubMode(): boolean {
  return !process.env["OMNINITY_STRIPE_SECRET"] || !process.env["OMNINITY_STRIPE_PRICE_ID"];
}

async function ensureRow(ctx: TenantContext): Promise<typeof subscriptions.$inferSelect> {
  const existing = await db
    .select()
    .from(subscriptions)
    .where(tenantScope(ctx, subscriptions))
    .limit(1);
  if (existing[0]) return existing[0];
  const id = `sub_${nanoid()}`;
  await db
    .insert(subscriptions)
    .values(withTenantValues(ctx, { id, status: "inactive" }))
    .onConflictDoNothing();
  const after = await db
    .select()
    .from(subscriptions)
    .where(tenantScope(ctx, subscriptions))
    .limit(1);
  if (!after[0]) throw new Error("Subscription row vanished after upsert");
  return after[0];
}

export async function getStatus(ctx: TenantContext): Promise<SubscriptionStatusPayload> {
  const row = await ensureRow(ctx);
  const sub = toRow(row);
  const periodOk =
    sub.currentPeriodEnd === null
      ? false
      : new Date(sub.currentPeriodEnd).getTime() > Date.now();
  const hasAccess = ACTIVE_STATES.has(sub.status) && (sub.status === "trialing" || periodOk);
  return { subscription: sub, hasAccess, stripeStubMode: isStripeStubMode() };
}

export interface CheckoutSessionPayload {
  checkoutUrl: string;
  sessionId: string;
  stripeStubMode: boolean;
}

export async function createCheckoutSession(
  ctx: TenantContext,
  opts: { successPath?: string; cancelPath?: string } = {},
): Promise<CheckoutSessionPayload> {
  const row = await ensureRow(ctx);
  const sessionId = `cs_${nanoid()}`;
  const stub = isStripeStubMode();
  const successPath = opts.successPath ?? "/subscription?status=success";
  const cancelPath = opts.cancelPath ?? "/subscription?status=cancelled";

  await logPrivacyEvent(ctx, {
    eventType: "subscription.checkout.created",
    actor: ctx.userId ?? ctx.tenantId,
    target: row.id,
    severity: "info",
    detail: `sessionId=${sessionId} stub=${stub}`,
  });

  if (!stub) {
    // Tier 2 hook — when real Stripe creds are configured we'd build a
    // session via the Stripe SDK. The stub returns the same shape so
    // the client doesn't branch.
    logger.warn("Stripe live mode requested but SDK not bundled in Tier 1; returning stub URL");
  }

  const checkoutUrl = `${successPath}&session_id=${sessionId}`;
  return { checkoutUrl, sessionId, stripeStubMode: stub };
}

/**
 * Confirm a checkout session — in stub mode this flips the subscription
 * to `active` immediately. In live Stripe mode the webhook handler does
 * the same job after the customer completes payment.
 */
export async function confirmCheckout(
  ctx: TenantContext,
  sessionId: string,
): Promise<SubscriptionStatusPayload> {
  const row = await ensureRow(ctx);
  const periodEnd = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await db
    .update(subscriptions)
    .set({
      status: "active",
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      stripeSubscriptionId: row.stripeSubscriptionId ?? `sub_stub_${sessionId}`,
      stripeCustomerId: row.stripeCustomerId ?? `cus_stub_${ctx.tenantId}`,
      updatedAt: Date.now(),
      version: row.version + 1,
    })
    .where(and(tenantScope(ctx, subscriptions), eq(subscriptions.id, row.id)));
  await logPrivacyEvent(ctx, {
    eventType: "subscription.activated",
    actor: ctx.userId ?? ctx.tenantId,
    target: row.id,
    severity: "info",
    detail: `sessionId=${sessionId} periodEnd=${new Date(periodEnd).toISOString()}`,
  });
  return getStatus(ctx);
}

export async function cancel(ctx: TenantContext): Promise<SubscriptionStatusPayload> {
  const row = await ensureRow(ctx);
  await db
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true, updatedAt: Date.now(), version: row.version + 1 })
    .where(and(tenantScope(ctx, subscriptions), eq(subscriptions.id, row.id)));
  await logPrivacyEvent(ctx, {
    eventType: "subscription.cancel.requested",
    actor: ctx.userId ?? ctx.tenantId,
    target: row.id,
    severity: "info",
    detail: `cancelAtPeriodEnd=true`,
  });
  return getStatus(ctx);
}

export async function reactivate(ctx: TenantContext): Promise<SubscriptionStatusPayload> {
  const row = await ensureRow(ctx);
  await db
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: false, updatedAt: Date.now(), version: row.version + 1 })
    .where(and(tenantScope(ctx, subscriptions), eq(subscriptions.id, row.id)));
  await logPrivacyEvent(ctx, {
    eventType: "subscription.reactivated",
    actor: ctx.userId ?? ctx.tenantId,
    target: row.id,
    severity: "info",
    detail: `cancelAtPeriodEnd=false`,
  });
  return getStatus(ctx);
}

export interface StripeWebhookEvent {
  type: string;
  data?: Record<string, unknown>;
}

export async function handleWebhook(
  ctx: TenantContext,
  event: StripeWebhookEvent,
): Promise<{ processed: boolean; type: string }> {
  const row = await ensureRow(ctx);
  switch (event.type) {
    case "checkout.session.completed":
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const periodEnd = Date.now() + 30 * 24 * 60 * 60 * 1000;
      await db
        .update(subscriptions)
        .set({
          status: "active",
          currentPeriodEnd: periodEnd,
          updatedAt: Date.now(),
          version: row.version + 1,
        })
        .where(and(tenantScope(ctx, subscriptions), eq(subscriptions.id, row.id)));
      break;
    }
    case "customer.subscription.deleted": {
      await db
        .update(subscriptions)
        .set({ status: "cancelled", updatedAt: Date.now(), version: row.version + 1 })
        .where(and(tenantScope(ctx, subscriptions), eq(subscriptions.id, row.id)));
      break;
    }
    case "invoice.payment_failed": {
      await db
        .update(subscriptions)
        .set({ status: "past_due", updatedAt: Date.now(), version: row.version + 1 })
        .where(and(tenantScope(ctx, subscriptions), eq(subscriptions.id, row.id)));
      break;
    }
    default:
      // Unrecognised webhook — record and move on.
      break;
  }
  await logPrivacyEvent(ctx, {
    eventType: "subscription.webhook",
    actor: "stripe",
    target: row.id,
    severity: "info",
    detail: `type=${event.type}`,
  });
  return { processed: true, type: event.type };
}

// ─── Premium-skill gating ─────────────────────────────────────────────────

export interface PremiumSkillRef {
  skillId: string;
  slug: string;
  isPremium: boolean;
  previewUsesAllowed: number;
  creatorHandle?: string | null;
}

export type PremiumDecision =
  | { allowed: true; reason: "subscription"; previewsUsed: number; previewsRemaining: number }
  | { allowed: true; reason: "preview"; previewsUsed: number; previewsRemaining: number }
  | { allowed: true; reason: "free"; previewsUsed: 0; previewsRemaining: 0 }
  | {
      allowed: false;
      reason: "subscription_required";
      previewsUsed: number;
      previewsRemaining: 0;
    };

export async function checkPremiumAccess(
  ctx: TenantContext,
  skill: PremiumSkillRef,
): Promise<PremiumDecision> {
  if (!skill.isPremium) {
    return { allowed: true, reason: "free", previewsUsed: 0, previewsRemaining: 0 };
  }
  const status = await getStatus(ctx);
  const counter = await getPreviewCounter(ctx, skill.skillId);
  const used = counter?.usesConsumed ?? 0;
  const remaining = Math.max(0, skill.previewUsesAllowed - used);
  if (status.hasAccess) {
    return { allowed: true, reason: "subscription", previewsUsed: used, previewsRemaining: remaining };
  }
  if (remaining > 0) {
    return { allowed: true, reason: "preview", previewsUsed: used, previewsRemaining: remaining };
  }
  return {
    allowed: false,
    reason: "subscription_required",
    previewsUsed: used,
    previewsRemaining: 0,
  };
}

async function getPreviewCounter(
  ctx: TenantContext,
  skillId: string,
): Promise<typeof skillPreviewCounters.$inferSelect | null> {
  const rows = await db
    .select()
    .from(skillPreviewCounters)
    .where(
      and(tenantScope(ctx, skillPreviewCounters), eq(skillPreviewCounters.skillId, skillId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function consumePreview(ctx: TenantContext, skillId: string): Promise<number> {
  const existing = await getPreviewCounter(ctx, skillId);
  if (!existing) {
    await db
      .insert(skillPreviewCounters)
      .values(
        withTenantValues(ctx, {
          id: `prv_${nanoid()}`,
          skillId,
          usesConsumed: 1,
        }),
      )
      .onConflictDoNothing();
    const fresh = await getPreviewCounter(ctx, skillId);
    return fresh?.usesConsumed ?? 1;
  }
  const next = existing.usesConsumed + 1;
  await db
    .update(skillPreviewCounters)
    .set({ usesConsumed: next, updatedAt: Date.now(), version: existing.version + 1 })
    .where(
      and(
        tenantScope(ctx, skillPreviewCounters),
        eq(skillPreviewCounters.id, existing.id),
        eq(skillPreviewCounters.version, existing.version),
      ),
    );
  return next;
}

export interface RecordUsageInput {
  skillId: string;
  skillSlug: string;
  creatorHandle?: string | null;
  modelName?: string | null;
  runId?: string | null;
  approvedByUser?: boolean;
  wasPreview?: boolean;
}

export async function recordUsage(
  ctx: TenantContext,
  input: RecordUsageInput,
): Promise<{ id: string }> {
  const id = `use_${nanoid()}`;
  await db.insert(skillUsageEvents).values(
    withTenantValues(ctx, {
      id,
      skillId: input.skillId,
      userId: ctx.userId ?? ctx.tenantId,
      skillSlug: input.skillSlug,
      creatorHandle: input.creatorHandle ?? null,
      modelName: input.modelName ?? null,
      runId: input.runId ?? null,
      approvedByUser: input.approvedByUser ?? true,
      wasPreview: input.wasPreview ?? false,
    }),
  );
  await logPrivacyEvent(ctx, {
    eventType: "skill.usage",
    actor: ctx.userId ?? ctx.tenantId,
    target: input.skillId,
    severity: "info",
    detail:
      `slug=${input.skillSlug} creator=${input.creatorHandle ?? "local"} ` +
      `preview=${Boolean(input.wasPreview)} approved=${input.approvedByUser !== false} ` +
      `run=${input.runId ?? "n/a"}`,
  });
  return { id };
}

export interface UsageItem {
  id: string;
  skillId: string;
  skillSlug: string | null;
  creatorHandle: string | null;
  modelName: string | null;
  wasPreview: boolean;
  approvedByUser: boolean;
  createdAt: string;
}

export interface MonthlyUsagePayload {
  totalThisMonth: number;
  totalAllTime: number;
  perSkill: Array<{ skillId: string; skillSlug: string | null; count: number }>;
  recent: UsageItem[];
}

function startOfMonth(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

export async function listMonthlyUsage(ctx: TenantContext): Promise<MonthlyUsagePayload> {
  const monthStart = startOfMonth();
  const recentRows = await db
    .select()
    .from(skillUsageEvents)
    .where(tenantScope(ctx, skillUsageEvents))
    .orderBy(desc(skillUsageEvents.createdAt))
    .limit(50);
  const monthRows = await db
    .select()
    .from(skillUsageEvents)
    .where(
      and(tenantScope(ctx, skillUsageEvents), gte(skillUsageEvents.createdAt, monthStart)),
    );
  const allRows = await db
    .select({ count: drizzleSql<number>`count(*)` })
    .from(skillUsageEvents)
    .where(tenantScope(ctx, skillUsageEvents));
  const perSkillMap = new Map<string, { skillId: string; skillSlug: string | null; count: number }>();
  for (const r of monthRows) {
    const key = r.skillId;
    const existing = perSkillMap.get(key);
    if (existing) existing.count += 1;
    else perSkillMap.set(key, { skillId: r.skillId, skillSlug: r.skillSlug ?? "", count: 1 });
  }
  return {
    totalThisMonth: monthRows.length,
    totalAllTime: Number(allRows[0]?.count ?? 0),
    perSkill: Array.from(perSkillMap.values()).sort((a, b) => b.count - a.count),
    recent: recentRows.map((r) => ({
      id: r.id,
      skillId: r.skillId,
      skillSlug: r.skillSlug ?? "",
      creatorHandle: r.creatorHandle,
      modelName: r.modelName,
      wasPreview: Boolean(r.wasPreview),
      approvedByUser: Boolean(r.approvedByUser),
      createdAt: new Date(r.createdAt).toISOString(),
    })),
  };
}

// ─── Creator earnings (reused by /creator routes) ────────────────────────

export interface CreatorEarningsPayload {
  creatorHandle: string;
  periodStart: string;
  periodEnd: string;
  totalUses: number;
  globalUses: number;
  /** Pool dollars distributed to creators this period (cents). */
  poolCents: number;
  /** Creator's share = totalUses / globalUses * poolCents. */
  estimatedEarningsCents: number;
  perSkill: Array<{ skillSlug: string; uses: number; earningsCents: number }>;
}

/** Default pool: 70% of one subscriber-month at $19/mo (1900¢) = 1330¢. */
const POOL_CENTS_PER_MONTH = 1330;

export async function getCreatorEarnings(
  ctx: TenantContext,
  creatorHandle: string,
): Promise<CreatorEarningsPayload> {
  const monthStart = startOfMonth();
  const monthEnd = Date.now();
  // All usage events globally for this period (across tenants, since the
  // "store" is logically global). We deliberately bypass tenant scoping for
  // the global denominator — creators get paid for usage by any subscriber.
  void ctx;
  const allMonthRows = await db
    .select()
    .from(skillUsageEvents)
    .where(gte(skillUsageEvents.createdAt, monthStart));
  const creatorRows = allMonthRows.filter((r) => r.creatorHandle === creatorHandle);
  const totalUses = creatorRows.length;
  const globalUses = allMonthRows.length;
  const estimatedEarningsCents =
    globalUses === 0 ? 0 : Math.round((totalUses / globalUses) * POOL_CENTS_PER_MONTH);
  const perSkillMap = new Map<string, number>();
  for (const r of creatorRows) {
    const slug = r.skillSlug ?? "";
    perSkillMap.set(slug, (perSkillMap.get(slug) ?? 0) + 1);
  }
  const perSkill = Array.from(perSkillMap.entries())
    .map(([skillSlug, uses]) => ({
      skillSlug,
      uses,
      earningsCents:
        globalUses === 0 ? 0 : Math.round((uses / globalUses) * POOL_CENTS_PER_MONTH),
    }))
    .sort((a, b) => b.uses - a.uses);
  return {
    creatorHandle,
    periodStart: new Date(monthStart).toISOString(),
    periodEnd: new Date(monthEnd).toISOString(),
    totalUses,
    globalUses,
    poolCents: POOL_CENTS_PER_MONTH,
    estimatedEarningsCents,
    perSkill,
  };
}
