/**
 * Skill reviews, ratings, helpful votes, creator responses,
 * moderation queue, and trust-badge logic — Task #33.
 *
 * Verified-usage gate
 *   `submitRating` consults `skill_usage_events` and refuses to write a
 *   rating row unless the requesting user has at least one usage event
 *   for the target skill. The agent loop calls `recordSkillUsage()` from
 *   `skill.service.installSkill()` and from `agent.service.createAgentRun()`
 *   when a routed skill is selected, so any user who has actually run a
 *   skill (or installed it) can rate it; nobody else can.
 *
 * Aggregate cache
 *   The skills table caches `rating_avg`, `rating_count` and `usage_count`.
 *   The service is the only writer and recomputes them after every mutation
 *   (`recomputeSkillAggregates`). This keeps the browse-page sort
 *   ("Highest Rated", "Most Used") to a single index scan.
 *
 * Trust badges
 *   `getSkillBadges` returns the derived set:
 *     - "verified-by-op"  — `skills.verified_by_op` flag.
 *     - "op-pick"         — `skills.editorial_pick` flag.
 *     - "top-creator"     — author has 4.5+ avg across 3+ skills.
 *     - "active"          — updated within the last 90 days.
 *     - "unmaintained"    — older than 180 days since last update.
 *
 * Quality enforcement
 *   `recomputeSkillAggregates` notifies the creator via
 *   `notifications.service` when the average drops below 2 stars after
 *   50+ reviews — throttled by `low_rating_alert_at` so the notification
 *   is sent at most once per 7 days.
 */
import { and, count, desc, eq, gte, ne, sql, sum } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  skillRatings,
  skillReviewFlags,
  skillReviewHelpfulVotes,
  skillReviewResponses,
  skillUsageEvents,
  skills,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { createNotification } from "./notifications.service";
import { logPrivacyEvent } from "./privacy.service";

const LOW_RATING_THRESHOLD = 2.0;
const LOW_RATING_MIN_REVIEWS = 50;
const LOW_RATING_THROTTLE_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const UNMAINTAINED_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
const TOP_CREATOR_MIN_AVG = 4.5;
const TOP_CREATOR_MIN_SKILLS = 3;
const TRENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const REVIEW_TEXT_MAX = 4_000;

export type RatingStatus = "active" | "hidden" | "removed";
export type FlagStatus = "open" | "dismissed" | "upheld";
export type ModerationAction = "hide" | "restore" | "remove" | "dismiss";
export type ReviewSort = "helpful" | "recent" | "highest" | "lowest";

export interface SkillRatingRow {
  id: string;
  skillId: string;
  userId: string;
  stars: number;
  reviewText: string | null;
  status: RatingStatus;
  helpfulCount: number;
  unhelpfulCount: number;
  flagCount: number;
  verifiedPurchase: boolean;
  createdAt: string;
  updatedAt: string;
  response: SkillReviewResponseRow | null;
}

export interface SkillReviewResponseRow {
  id: string;
  ratingId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillReviewFlagRow {
  id: string;
  ratingId: string;
  skillId: string;
  reporterId: string;
  reason: string;
  detail: string | null;
  status: FlagStatus;
  resolution: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RatingSummary {
  skillId: string;
  ratingAvg: number;
  ratingCount: number;
  usageCount: number;
  breakdown: { stars: 1 | 2 | 3 | 4 | 5; count: number }[];
}

export interface TrustBadge {
  id: string;
  label: string;
}

export interface SkillBadgesRow {
  skillId: string;
  badges: TrustBadge[];
  status: "active" | "unmaintained";
  usageCount: number;
  ratingAvg: number;
  ratingCount: number;
}

export class ReviewError extends Error {
  override readonly name = "ReviewError";
  constructor(readonly code: string, message: string, readonly httpStatus = 400) {
    super(message);
  }
}

function actorFor(ctx: TenantContext): string {
  return ctx.userId ?? ctx.tenantId;
}

function toRatingRow(
  r: typeof skillRatings.$inferSelect,
  response: SkillReviewResponseRow | null,
): SkillRatingRow {
  return {
    id: r.id,
    skillId: r.skillId,
    userId: r.userId,
    stars: r.stars,
    reviewText: r.reviewText,
    status: r.status as RatingStatus,
    helpfulCount: r.helpfulCount,
    unhelpfulCount: r.unhelpfulCount,
    flagCount: r.flagCount,
    verifiedPurchase: Boolean(r.verifiedPurchase),
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    response,
  };
}

function toResponseRow(
  r: typeof skillReviewResponses.$inferSelect,
): SkillReviewResponseRow {
  return {
    id: r.id,
    ratingId: r.ratingId,
    authorId: r.authorId,
    body: r.body,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toFlagRow(
  r: typeof skillReviewFlags.$inferSelect,
): SkillReviewFlagRow {
  return {
    id: r.id,
    ratingId: r.ratingId,
    skillId: r.skillId,
    reporterId: r.reporterId,
    reason: r.reason,
    detail: r.detail,
    status: r.status as FlagStatus,
    resolution: r.resolution,
    resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
    resolvedBy: r.resolvedBy,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

async function loadSkill(ctx: TenantContext, skillId: string) {
  const rows = await db
    .select()
    .from(skills)
    .where(and(tenantScope(ctx, skills), eq(skills.id, skillId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Append a usage event for the requesting user. Idempotent at the call
 * site — `skill.service.installSkill` and the agent loop call this once
 * per significant interaction, never on every transcript message.
 */
export async function recordSkillUsage(
  ctx: TenantContext,
  skillId: string,
  options: { runId?: string } = {},
): Promise<void> {
  const skill = await loadSkill(ctx, skillId);
  if (!skill) return;
  const userId = actorFor(ctx);
  const id = `skuse_${nanoid()}`;
  await db.insert(skillUsageEvents).values(
    withTenantValues(ctx, {
      id,
      skillId,
      userId,
      runId: options.runId ?? null,
    }),
  );
  await db
    .update(skills)
    .set({
      usageCount: skill.usageCount + 1,
      updatedAt: Date.now(),
      version: skill.version + 1,
    })
    .where(and(tenantScope(ctx, skills), eq(skills.id, skillId)));
}

export async function hasVerifiedUsage(
  ctx: TenantContext,
  skillId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ c: count() })
    .from(skillUsageEvents)
    .where(
      and(
        tenantScope(ctx, skillUsageEvents),
        eq(skillUsageEvents.skillId, skillId),
        eq(skillUsageEvents.userId, userId),
      ),
    );
  return Number(rows[0]?.c ?? 0) > 0;
}

interface SubmitRatingInput {
  stars: number;
  reviewText?: string | null;
}

export async function submitRating(
  ctx: TenantContext,
  skillId: string,
  input: SubmitRatingInput,
): Promise<SkillRatingRow> {
  if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) {
    throw new ReviewError("VALIDATION", "stars must be an integer between 1 and 5");
  }
  const text = input.reviewText?.trim() ?? null;
  if (text && text.length > REVIEW_TEXT_MAX) {
    throw new ReviewError(
      "VALIDATION",
      `reviewText must be ${REVIEW_TEXT_MAX} characters or fewer`,
    );
  }
  const skill = await loadSkill(ctx, skillId);
  if (!skill) throw new ReviewError("NOT_FOUND", "Unknown skill", 404);

  const userId = actorFor(ctx);
  const verified = await hasVerifiedUsage(ctx, skillId, userId);
  if (!verified) {
    throw new ReviewError(
      "USAGE_REQUIRED",
      "You must install and use this skill at least once before rating it",
      403,
    );
  }

  const existing = await db
    .select()
    .from(skillRatings)
    .where(
      and(
        tenantScope(ctx, skillRatings),
        eq(skillRatings.skillId, skillId),
        eq(skillRatings.userId, userId),
      ),
    )
    .limit(1);
  const now = Date.now();

  let ratingId: string;
  if (existing[0]) {
    ratingId = existing[0].id;
    await db
      .update(skillRatings)
      .set({
        stars: input.stars,
        reviewText: text,
        status: "active",
        updatedAt: now,
        version: existing[0].version + 1,
      })
      .where(and(tenantScope(ctx, skillRatings), eq(skillRatings.id, ratingId)));
  } else {
    ratingId = `srat_${nanoid()}`;
    await db.insert(skillRatings).values(
      withTenantValues(ctx, {
        id: ratingId,
        skillId,
        userId,
        stars: input.stars,
        reviewText: text,
        verifiedPurchase: true,
        status: "active",
      }),
    );
  }

  await recomputeSkillAggregates(ctx, skillId);
  await logPrivacyEvent(ctx, {
    eventType: "skill.rate",
    actor: userId,
    target: skillId,
    severity: "info",
    detail: `stars=${input.stars}`,
  });

  const row = await getRating(ctx, ratingId);
  if (!row) throw new ReviewError("NOT_FOUND", "Rating disappeared after write", 500);
  return row;
}

async function getRating(
  ctx: TenantContext,
  ratingId: string,
): Promise<SkillRatingRow | null> {
  const rows = await db
    .select()
    .from(skillRatings)
    .where(and(tenantScope(ctx, skillRatings), eq(skillRatings.id, ratingId)))
    .limit(1);
  if (!rows[0]) return null;
  const responses = await db
    .select()
    .from(skillReviewResponses)
    .where(
      and(
        tenantScope(ctx, skillReviewResponses),
        eq(skillReviewResponses.ratingId, ratingId),
      ),
    )
    .limit(1);
  return toRatingRow(rows[0], responses[0] ? toResponseRow(responses[0]) : null);
}

export interface ListReviewsOptions {
  cursor?: string;
  limit?: number;
  sort?: ReviewSort;
  includeHidden?: boolean;
}

export async function listSkillReviews(
  ctx: TenantContext,
  skillId: string,
  opts: ListReviewsOptions = {},
): Promise<PaginatedData<SkillRatingRow>> {
  const limit = normaliseLimit(opts.limit);
  const sort = opts.sort ?? "helpful";
  const cursor = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;

  const filters = [
    tenantScope(ctx, skillRatings),
    eq(skillRatings.skillId, skillId),
  ];
  if (!opts.includeHidden) {
    filters.push(eq(skillRatings.status, "active"));
  } else {
    filters.push(ne(skillRatings.status, "removed"));
  }
  if (cursor !== null && Number.isFinite(cursor)) {
    if (sort === "helpful") {
      filters.push(sql`${skillRatings.helpfulCount} <= ${cursor}`);
    } else {
      filters.push(sql`${skillRatings.createdAt} < ${cursor}`);
    }
  }

  const order = (() => {
    switch (sort) {
      case "recent":
        return [desc(skillRatings.createdAt)];
      case "highest":
        return [desc(skillRatings.stars), desc(skillRatings.createdAt)];
      case "lowest":
        return [skillRatings.stars, desc(skillRatings.createdAt)];
      case "helpful":
      default:
        return [desc(skillRatings.helpfulCount), desc(skillRatings.createdAt)];
    }
  })();

  const rows = await db
    .select()
    .from(skillRatings)
    .where(and(...filters))
    .orderBy(...order)
    .limit(limit + 1);

  const ids = rows.map((r) => r.id);
  const responseRows = ids.length
    ? await db
        .select()
        .from(skillReviewResponses)
        .where(
          and(
            tenantScope(ctx, skillReviewResponses),
            sql`${skillReviewResponses.ratingId} IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
    : [];
  const responseByRating = new Map(
    responseRows.map((r) => [r.ratingId, toResponseRow(r)]),
  );

  return buildPage(
    rows.map((r) => toRatingRow(r, responseByRating.get(r.id) ?? null)),
    limit,
    (r) => {
      if (sort === "helpful") return String(r.helpfulCount);
      return String(new Date(r.createdAt).getTime());
    },
  );
}

export async function getRatingSummary(
  ctx: TenantContext,
  skillId: string,
): Promise<RatingSummary> {
  const skill = await loadSkill(ctx, skillId);
  if (!skill) throw new ReviewError("NOT_FOUND", "Unknown skill", 404);

  const counts = await db
    .select({ stars: skillRatings.stars, c: count() })
    .from(skillRatings)
    .where(
      and(
        tenantScope(ctx, skillRatings),
        eq(skillRatings.skillId, skillId),
        eq(skillRatings.status, "active"),
      ),
    )
    .groupBy(skillRatings.stars);

  const breakdown: RatingSummary["breakdown"] = [1, 2, 3, 4, 5].map(
    (stars) => ({
      stars: stars as 1 | 2 | 3 | 4 | 5,
      count: Number(counts.find((c) => c.stars === stars)?.c ?? 0),
    }),
  );

  return {
    skillId,
    ratingAvg: skill.ratingAvg,
    ratingCount: skill.ratingCount,
    usageCount: skill.usageCount,
    breakdown,
  };
}

export async function voteHelpful(
  ctx: TenantContext,
  ratingId: string,
  helpful: boolean,
): Promise<SkillRatingRow> {
  const rating = await getRating(ctx, ratingId);
  if (!rating) throw new ReviewError("NOT_FOUND", "Unknown review", 404);

  const userId = actorFor(ctx);
  const existing = await db
    .select()
    .from(skillReviewHelpfulVotes)
    .where(
      and(
        tenantScope(ctx, skillReviewHelpfulVotes),
        eq(skillReviewHelpfulVotes.ratingId, ratingId),
        eq(skillReviewHelpfulVotes.userId, userId),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(skillReviewHelpfulVotes)
      .set({ helpful: helpful ? 1 : 0 })
      .where(
        and(
          tenantScope(ctx, skillReviewHelpfulVotes),
          eq(skillReviewHelpfulVotes.id, existing[0].id),
        ),
      );
  } else {
    await db.insert(skillReviewHelpfulVotes).values(
      withTenantValues(ctx, {
        id: `shvt_${nanoid()}`,
        ratingId,
        userId,
        helpful: helpful ? 1 : 0,
      }),
    );
  }

  await recomputeRatingHelpfulness(ctx, ratingId);
  const updated = await getRating(ctx, ratingId);
  if (!updated) throw new ReviewError("NOT_FOUND", "Rating vanished", 500);
  return updated;
}

async function recomputeRatingHelpfulness(
  ctx: TenantContext,
  ratingId: string,
): Promise<void> {
  const rows = await db
    .select({
      helpful: sum(skillReviewHelpfulVotes.helpful),
      total: count(),
    })
    .from(skillReviewHelpfulVotes)
    .where(
      and(
        tenantScope(ctx, skillReviewHelpfulVotes),
        eq(skillReviewHelpfulVotes.ratingId, ratingId),
      ),
    );
  const helpfulCount = Number(rows[0]?.helpful ?? 0);
  const total = Number(rows[0]?.total ?? 0);
  await db
    .update(skillRatings)
    .set({
      helpfulCount,
      unhelpfulCount: total - helpfulCount,
      updatedAt: Date.now(),
    })
    .where(and(tenantScope(ctx, skillRatings), eq(skillRatings.id, ratingId)));
}

export async function respondToReview(
  ctx: TenantContext,
  ratingId: string,
  body: string,
): Promise<SkillReviewResponseRow> {
  const trimmed = body.trim();
  if (!trimmed) throw new ReviewError("VALIDATION", "Response body required");
  if (trimmed.length > REVIEW_TEXT_MAX) {
    throw new ReviewError(
      "VALIDATION",
      `body must be ${REVIEW_TEXT_MAX} characters or fewer`,
    );
  }
  const rating = await getRating(ctx, ratingId);
  if (!rating) throw new ReviewError("NOT_FOUND", "Unknown review", 404);
  const skill = await loadSkill(ctx, rating.skillId);
  if (!skill) throw new ReviewError("NOT_FOUND", "Unknown skill", 404);

  // Only the skill's author may respond. In the local-first install the
  // author defaults to the tenant owner — we accept either explicit
  // authorship or fall back to "actor matches skill.author".
  const actor = actorFor(ctx);
  if (skill.author !== actor && skill.author !== "local" && skill.author !== ctx.tenantId) {
    throw new ReviewError(
      "FORBIDDEN",
      "Only the skill author may respond to reviews",
      403,
    );
  }

  const existing = await db
    .select()
    .from(skillReviewResponses)
    .where(
      and(
        tenantScope(ctx, skillReviewResponses),
        eq(skillReviewResponses.ratingId, ratingId),
      ),
    )
    .limit(1);
  const now = Date.now();
  if (existing[0]) {
    await db
      .update(skillReviewResponses)
      .set({
        body: trimmed,
        updatedAt: now,
        version: existing[0].version + 1,
      })
      .where(
        and(
          tenantScope(ctx, skillReviewResponses),
          eq(skillReviewResponses.id, existing[0].id),
        ),
      );
    const updated = await db
      .select()
      .from(skillReviewResponses)
      .where(
        and(
          tenantScope(ctx, skillReviewResponses),
          eq(skillReviewResponses.id, existing[0].id),
        ),
      )
      .limit(1);
    return toResponseRow(updated[0]!);
  }

  const id = `srrp_${nanoid()}`;
  await db.insert(skillReviewResponses).values(
    withTenantValues(ctx, {
      id,
      ratingId,
      skillId: rating.skillId,
      authorId: actor,
      body: trimmed,
    }),
  );
  const created = await db
    .select()
    .from(skillReviewResponses)
    .where(
      and(
        tenantScope(ctx, skillReviewResponses),
        eq(skillReviewResponses.id, id),
      ),
    )
    .limit(1);
  return toResponseRow(created[0]!);
}

export async function flagReview(
  ctx: TenantContext,
  ratingId: string,
  reason: string,
  detail?: string | null,
): Promise<SkillReviewFlagRow> {
  const rating = await getRating(ctx, ratingId);
  if (!rating) throw new ReviewError("NOT_FOUND", "Unknown review", 404);
  const trimmed = reason.trim();
  if (!trimmed) throw new ReviewError("VALIDATION", "reason required");

  const id = `srfg_${nanoid()}`;
  await db.insert(skillReviewFlags).values(
    withTenantValues(ctx, {
      id,
      ratingId,
      skillId: rating.skillId,
      reporterId: actorFor(ctx),
      reason: trimmed.slice(0, 200),
      detail: detail?.trim().slice(0, 1_000) ?? null,
      status: "open",
    }),
  );
  await db
    .update(skillRatings)
    .set({ flagCount: rating.flagCount + 1, updatedAt: Date.now() })
    .where(and(tenantScope(ctx, skillRatings), eq(skillRatings.id, ratingId)));

  const created = await db
    .select()
    .from(skillReviewFlags)
    .where(and(tenantScope(ctx, skillReviewFlags), eq(skillReviewFlags.id, id)))
    .limit(1);
  return toFlagRow(created[0]!);
}

export async function listFlaggedReviews(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number; status?: FlagStatus } = {},
): Promise<PaginatedData<SkillReviewFlagRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const filters = [tenantScope(ctx, skillReviewFlags)];
  if (opts.status) {
    filters.push(eq(skillReviewFlags.status, opts.status));
  }
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    filters.push(sql`${skillReviewFlags.createdAt} < ${cursorTs}`);
  }
  const rows = await db
    .select()
    .from(skillReviewFlags)
    .where(and(...filters))
    .orderBy(desc(skillReviewFlags.createdAt))
    .limit(limit + 1);
  return buildPage(
    rows.map(toFlagRow),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}

export async function moderateReview(
  ctx: TenantContext,
  ratingId: string,
  action: ModerationAction,
  resolution?: string,
): Promise<SkillRatingRow> {
  const rating = await getRating(ctx, ratingId);
  if (!rating) throw new ReviewError("NOT_FOUND", "Unknown review", 404);

  const newStatus: RatingStatus =
    action === "remove" ? "removed" : action === "hide" ? "hidden" : "active";

  await db
    .update(skillRatings)
    .set({ status: newStatus, updatedAt: Date.now() })
    .where(and(tenantScope(ctx, skillRatings), eq(skillRatings.id, ratingId)));

  const flagStatus: FlagStatus =
    action === "dismiss" ? "dismissed" : action === "restore" ? "dismissed" : "upheld";
  await db
    .update(skillReviewFlags)
    .set({
      status: flagStatus,
      resolution: resolution ?? action,
      resolvedAt: Date.now(),
      resolvedBy: actorFor(ctx),
      updatedAt: Date.now(),
    })
    .where(
      and(
        tenantScope(ctx, skillReviewFlags),
        eq(skillReviewFlags.ratingId, ratingId),
        eq(skillReviewFlags.status, "open"),
      ),
    );

  await recomputeSkillAggregates(ctx, rating.skillId);
  const updated = await getRating(ctx, ratingId);
  if (!updated) throw new ReviewError("NOT_FOUND", "Rating disappeared", 500);
  return updated;
}

async function recomputeSkillAggregates(
  ctx: TenantContext,
  skillId: string,
): Promise<void> {
  const rows = await db
    .select({
      avg: sql<number>`avg(${skillRatings.stars})`,
      cnt: count(),
    })
    .from(skillRatings)
    .where(
      and(
        tenantScope(ctx, skillRatings),
        eq(skillRatings.skillId, skillId),
        eq(skillRatings.status, "active"),
      ),
    );
  const ratingAvg = Number(rows[0]?.avg ?? 0) || 0;
  const ratingCount = Number(rows[0]?.cnt ?? 0);
  const skill = await loadSkill(ctx, skillId);
  if (!skill) return;

  await db
    .update(skills)
    .set({
      ratingAvg,
      ratingCount,
      updatedAt: Date.now(),
    })
    .where(and(tenantScope(ctx, skills), eq(skills.id, skillId)));

  if (ratingCount >= LOW_RATING_MIN_REVIEWS && ratingAvg < LOW_RATING_THRESHOLD) {
    const lastAlert = skill.lowRatingAlertAt ?? 0;
    if (Date.now() - lastAlert >= LOW_RATING_THROTTLE_MS) {
      try {
        await createNotification(ctx, {
          category: "skill",
          severity: "warning",
          title: `Rating dropped: ${skill.name}`,
          body: `Average rating ${ratingAvg.toFixed(1)} across ${ratingCount} reviews — review the latest feedback to find what to fix.`,
          actionLabel: "Open skill",
          actionHref: `/skills/${skill.id}`,
        });
      } catch (err) {
        logger.warn({ err, skillId }, "Failed to send low-rating notification");
      }
      await db
        .update(skills)
        .set({ lowRatingAlertAt: Date.now() })
        .where(and(tenantScope(ctx, skills), eq(skills.id, skillId)));
    }
  }
}

export async function getSkillBadges(
  ctx: TenantContext,
  skillId: string,
): Promise<SkillBadgesRow> {
  const skill = await loadSkill(ctx, skillId);
  if (!skill) throw new ReviewError("NOT_FOUND", "Unknown skill", 404);
  const badges: TrustBadge[] = [];
  if (skill.verifiedByOp) badges.push({ id: "verified-by-op", label: "Verified by OP" });
  if (skill.editorialPick) badges.push({ id: "op-pick", label: "OP Pick" });

  // Top creator — author has avg >= 4.5 across at least N skills.
  if (skill.author && skill.author !== "local") {
    const authorAgg = await db
      .select({
        avg: sql<number>`avg(${skills.ratingAvg})`,
        cnt: count(),
      })
      .from(skills)
      .where(
        and(
          tenantScope(ctx, skills),
          eq(skills.author, skill.author),
          gte(skills.ratingCount, 1),
        ),
      );
    const avg = Number(authorAgg[0]?.avg ?? 0);
    const cnt = Number(authorAgg[0]?.cnt ?? 0);
    if (cnt >= TOP_CREATOR_MIN_SKILLS && avg >= TOP_CREATOR_MIN_AVG) {
      badges.push({ id: "top-creator", label: "Top Creator" });
    }
  }

  const ageMs = Date.now() - skill.updatedAt;
  const status: SkillBadgesRow["status"] =
    ageMs > UNMAINTAINED_WINDOW_MS ? "unmaintained" : "active";
  if (ageMs <= ACTIVE_WINDOW_MS) {
    badges.push({ id: "active", label: "Active" });
  } else if (status === "unmaintained") {
    badges.push({ id: "unmaintained", label: "Unmaintained" });
  }

  return {
    skillId,
    badges,
    status,
    usageCount: skill.usageCount,
    ratingAvg: skill.ratingAvg,
    ratingCount: skill.ratingCount,
  };
}

export interface TrendingSkillRow {
  skillId: string;
  slug: string;
  name: string;
  installsLastWeek: number;
  ratingAvg: number;
  usageCount: number;
}

export async function listTrendingSkills(
  ctx: TenantContext,
  limit = 10,
): Promise<TrendingSkillRow[]> {
  const cap = Math.max(1, Math.min(50, Math.floor(limit)));
  const since = Date.now() - TRENDING_WINDOW_MS;
  const rows = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      ratingAvg: skills.ratingAvg,
      usageCount: skills.usageCount,
      installsLastWeek: sql<number>`(
        SELECT COUNT(*) FROM skill_usage_events u
         WHERE u.tenant_id = ${skills.tenantId}
           AND u.skill_id = ${skills.id}
           AND u.created_at >= ${since}
      )`,
    })
    .from(skills)
    .where(tenantScope(ctx, skills))
    .orderBy(
      desc(sql<number>`installs_last_week`),
      desc(skills.usageCount),
    )
    .limit(cap);

  return rows.map((r) => ({
    skillId: r.id,
    slug: r.slug,
    name: r.name,
    installsLastWeek: Number(r.installsLastWeek ?? 0),
    ratingAvg: Number(r.ratingAvg ?? 0),
    usageCount: Number(r.usageCount ?? 0),
  }));
}

export interface SimilarSkillRow {
  skillId: string;
  slug: string;
  name: string;
  category: string;
  sharedUsers: number;
}

/**
 * "Similar to skills you use" — surfaces skills that share usage events
 * with skills the requesting user has run. Pure SQL, fully tenant-scoped,
 * no cross-tenant comparison.
 */
export async function listSimilarSkills(
  ctx: TenantContext,
  limit = 5,
): Promise<SimilarSkillRow[]> {
  const cap = Math.max(1, Math.min(20, Math.floor(limit)));
  const userId = actorFor(ctx);

  const rows = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      category: skills.category,
      sharedUsers: sql<number>`(
        SELECT COUNT(DISTINCT u2.user_id)
          FROM skill_usage_events u2
         WHERE u2.tenant_id = ${skills.tenantId}
           AND u2.skill_id = ${skills.id}
           AND u2.user_id IN (
             SELECT DISTINCT u3.user_id
               FROM skill_usage_events u3
              WHERE u3.tenant_id = ${skills.tenantId}
                AND u3.user_id != ${userId}
                AND u3.skill_id IN (
                  SELECT u4.skill_id FROM skill_usage_events u4
                   WHERE u4.tenant_id = ${skills.tenantId}
                     AND u4.user_id = ${userId}
                )
           )
      )`,
    })
    .from(skills)
    .where(
      and(
        tenantScope(ctx, skills),
        sql`${skills.id} NOT IN (
          SELECT u.skill_id FROM skill_usage_events u
           WHERE u.tenant_id = ${skills.tenantId}
             AND u.user_id = ${userId}
        )`,
      ),
    )
    .orderBy(desc(sql<number>`shared_users`), desc(skills.ratingAvg))
    .limit(cap);

  return rows
    .map((r) => ({
      skillId: r.id,
      slug: r.slug,
      name: r.name,
      category: r.category,
      sharedUsers: Number(r.sharedUsers ?? 0),
    }))
    .filter((r) => r.sharedUsers > 0);
}

export async function setSkillTrustFlags(
  ctx: TenantContext,
  skillId: string,
  flags: { verifiedByOp?: boolean; editorialPick?: boolean },
): Promise<SkillBadgesRow> {
  const skill = await loadSkill(ctx, skillId);
  if (!skill) throw new ReviewError("NOT_FOUND", "Unknown skill", 404);
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (flags.verifiedByOp !== undefined) patch["verifiedByOp"] = flags.verifiedByOp;
  if (flags.editorialPick !== undefined) patch["editorialPick"] = flags.editorialPick;
  await db
    .update(skills)
    .set(patch)
    .where(and(tenantScope(ctx, skills), eq(skills.id, skillId)));
  return getSkillBadges(ctx, skillId);
}
