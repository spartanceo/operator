/**
 * Feedback service — feature-request board (community submissions,
 * upvotes, status notifications) and the in-app thumbs up/down feedback
 * stream (Task #34).
 *
 * Feature requests live under the SYSTEM tenant so the public website
 * can list them without a tenant context. Per-user upvote/comment data
 * carries the voter's email but no other PII — the dashboard's
 * "sentiment view" is computed by aggregate, never by individual.
 */
import { and, count, desc, eq, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  featureFeedbackEvents,
  featureRequests,
  featureRequestVotes,
  normaliseLimit,
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
const STATUSES = new Set([
  "under_review",
  "under_consideration",
  "planned",
  "shipped",
  "wont_build",
]);

// tier-review: bounded — fixed enum, never grows past code-defined values
const CATEGORIES = new Set([
  "general",
  "desktop",
  "mobile",
  "marketplace",
  "model",
  "integrations",
  "other",
]);

export class FeedbackValidationError extends Error {
  override readonly name = "FeedbackValidationError";
  readonly code = "FEEDBACK_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

export interface FeatureRequestRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  status: string;
  statusNote: string;
  submitterLabel: string;
  upvoteCount: number;
  createdAt: string;
  updatedAt: string;
}

function frRow(r: typeof featureRequests.$inferSelect): FeatureRequestRow {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    category: r.category,
    status: r.status,
    statusNote: r.statusNote,
    submitterLabel: r.submitterLabel,
    upvoteCount: r.upvoteCount,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 64);
}

export interface CreateFeatureRequestInput {
  title: string;
  description?: string;
  category?: string;
  submitterEmail: string;
  submitterLabel?: string;
}

export async function createFeatureRequest(
  input: CreateFeatureRequestInput,
): Promise<FeatureRequestRow> {
  const title = input.title.trim();
  if (title.length === 0 || title.length > 160) {
    throw new FeedbackValidationError("title is required (≤160 chars)");
  }
  const description = (input.description ?? "").trim().slice(0, 4000);
  const email = input.submitterEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new FeedbackValidationError("valid submitter email required");
  }
  const category =
    input.category && CATEGORIES.has(input.category) ? input.category : "general";
  const baseSlug = slugify(title) || `request-${nanoid(8).toLowerCase()}`;
  let slug = baseSlug;
  let attempt = 0;
  // Up to 5 attempts to find a free slug — bounded.
  while (attempt < 5) {
    const existing = await db
      .select({ id: featureRequests.id })
      .from(featureRequests)
      .where(eq(featureRequests.slug, slug))
      .limit(1);
    if (!existing[0]) break;
    attempt += 1;
    slug = `${baseSlug}-${nanoid(4).toLowerCase()}`;
  }
  const id = `frq_${nanoid()}`;
  const inserted = await db
    .insert(featureRequests)
    .values({
      id,
      tenantId: SYSTEM_TENANT_ID,
      workspaceId: SYSTEM_WORKSPACE_ID,
      slug,
      title,
      description,
      category,
      status: "under_review",
      submitterEmail: email,
      submitterLabel: input.submitterLabel?.trim() ?? "",
    })
    .returning();
  // Submitter is auto-subscribed to status changes.
  await castVote({
    featureRequestId: id,
    voterEmail: email,
    voterLabel: input.submitterLabel,
    notifyOnChange: true,
  });
  logger.info({ id, slug }, "Feature request created");
  return frRow(inserted[0]!);
}

export interface ListFeatureRequestsOptions {
  status?: string;
  category?: string;
  cursor?: string;
  limit?: number;
}

export async function listFeatureRequests(
  opts: ListFeatureRequestsOptions = {},
): Promise<PaginatedData<FeatureRequestRow>> {
  const limit = normaliseLimit(opts.limit);
  const predicates = [eq(featureRequests.tenantId, SYSTEM_TENANT_ID)];
  if (opts.status && STATUSES.has(opts.status)) {
    predicates.push(eq(featureRequests.status, opts.status));
  }
  if (opts.category && CATEGORIES.has(opts.category)) {
    predicates.push(eq(featureRequests.category, opts.category));
  }
  if (opts.cursor) {
    const seek = Number(decodeCursor(opts.cursor));
    if (Number.isFinite(seek)) {
      predicates.push(lt(featureRequests.upvoteCount, seek));
    }
  }
  const rows = await db
    .select()
    .from(featureRequests)
    .where(and(...predicates))
    .orderBy(desc(featureRequests.upvoteCount), desc(featureRequests.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(frRow), limit, (r) => String(r.upvoteCount));
}

export async function getFeatureRequest(
  slug: string,
): Promise<FeatureRequestRow | null> {
  const rows = await db
    .select()
    .from(featureRequests)
    .where(eq(featureRequests.slug, slug))
    .limit(1);
  return rows[0] ? frRow(rows[0]) : null;
}

export interface CastVoteInput {
  featureRequestId: string;
  voterEmail: string;
  voterLabel?: string;
  notifyOnChange?: boolean;
}

export async function castVote(
  input: CastVoteInput,
): Promise<{ deduplicated: boolean; upvoteCount: number }> {
  const email = input.voterEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new FeedbackValidationError("valid voter email required");
  }
  const fr = await db
    .select()
    .from(featureRequests)
    .where(eq(featureRequests.id, input.featureRequestId))
    .limit(1);
  if (!fr[0]) throw new FeedbackValidationError("feature request not found");
  const existing = await db
    .select({ id: featureRequestVotes.id })
    .from(featureRequestVotes)
    .where(
      and(
        eq(featureRequestVotes.featureRequestId, input.featureRequestId),
        eq(featureRequestVotes.voterEmail, email),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return { deduplicated: true, upvoteCount: fr[0].upvoteCount };
  }
  await db.insert(featureRequestVotes).values({
    id: `frv_${nanoid()}`,
    tenantId: SYSTEM_TENANT_ID,
    workspaceId: SYSTEM_WORKSPACE_ID,
    featureRequestId: input.featureRequestId,
    voterEmail: email,
    voterLabel: input.voterLabel?.trim() ?? "",
    notifyOnChange: input.notifyOnChange === false ? 0 : 1,
  });
  await db
    .update(featureRequests)
    .set({
      upvoteCount: sql`${featureRequests.upvoteCount} + 1`,
      updatedAt: Date.now(),
      version: sql`${featureRequests.version} + 1`,
    })
    .where(eq(featureRequests.id, input.featureRequestId));
  const refreshed = await db
    .select({ count: featureRequests.upvoteCount })
    .from(featureRequests)
    .where(eq(featureRequests.id, input.featureRequestId))
    .limit(1);
  return { deduplicated: false, upvoteCount: refreshed[0]?.count ?? 0 };
}

export async function withdrawVote(input: {
  featureRequestId: string;
  voterEmail: string;
}): Promise<{ removed: boolean; upvoteCount: number }> {
  const email = input.voterEmail.trim().toLowerCase();
  const removed = await db
    .delete(featureRequestVotes)
    .where(
      and(
        eq(featureRequestVotes.featureRequestId, input.featureRequestId),
        eq(featureRequestVotes.voterEmail, email),
      ),
    )
    .returning();
  if (removed.length === 0) {
    const fr = await db
      .select({ count: featureRequests.upvoteCount })
      .from(featureRequests)
      .where(eq(featureRequests.id, input.featureRequestId))
      .limit(1);
    return { removed: false, upvoteCount: fr[0]?.count ?? 0 };
  }
  await db
    .update(featureRequests)
    .set({
      upvoteCount: sql`MAX(0, ${featureRequests.upvoteCount} - 1)`,
      updatedAt: Date.now(),
      version: sql`${featureRequests.version} + 1`,
    })
    .where(eq(featureRequests.id, input.featureRequestId));
  const refreshed = await db
    .select({ count: featureRequests.upvoteCount })
    .from(featureRequests)
    .where(eq(featureRequests.id, input.featureRequestId))
    .limit(1);
  return { removed: true, upvoteCount: refreshed[0]?.count ?? 0 };
}

export interface UpdateStatusInput {
  featureRequestId: string;
  status: string;
  statusNote?: string;
}

export interface UpdateStatusResult {
  request: FeatureRequestRow;
  notifiedVoters: number;
}

export async function updateFeatureRequestStatus(
  input: UpdateStatusInput,
): Promise<UpdateStatusResult> {
  if (!STATUSES.has(input.status)) {
    throw new FeedbackValidationError(`invalid status "${input.status}"`);
  }
  const before = await db
    .select()
    .from(featureRequests)
    .where(eq(featureRequests.id, input.featureRequestId))
    .limit(1);
  if (!before[0]) throw new FeedbackValidationError("feature request not found");
  await db
    .update(featureRequests)
    .set({
      status: input.status,
      statusNote: input.statusNote?.trim() ?? before[0].statusNote,
      updatedAt: Date.now(),
      version: sql`${featureRequests.version} + 1`,
    })
    .where(eq(featureRequests.id, input.featureRequestId));
  const refreshed = await db
    .select()
    .from(featureRequests)
    .where(eq(featureRequests.id, input.featureRequestId))
    .limit(1);
  // Stub notification: count subscribers we WOULD email; the real
  // notification fan-out is handled by the notification skill (Task #43).
  let notifiedVoters = 0;
  if (input.status !== before[0].status) {
    const subs = await db
      .select({ count: count() })
      .from(featureRequestVotes)
      .where(
        and(
          eq(featureRequestVotes.featureRequestId, input.featureRequestId),
          eq(featureRequestVotes.notifyOnChange, 1),
        ),
      );
    notifiedVoters = Number(subs[0]?.count ?? 0);
    logger.info(
      { id: input.featureRequestId, from: before[0].status, to: input.status, notifiedVoters },
      "Feature request status changed",
    );
  }
  return { request: frRow(refreshed[0]!), notifiedVoters };
}

// ─── In-app feature feedback (thumbs up / down) ──────────────────────────────

export interface FeatureFeedbackRow {
  id: string;
  featureKey: string;
  sentiment: string;
  comment: string;
  submitterLabel: string;
  createdAt: string;
}

function ffRow(r: typeof featureFeedbackEvents.$inferSelect): FeatureFeedbackRow {
  return {
    id: r.id,
    featureKey: r.featureKey,
    sentiment: r.sentiment,
    comment: r.comment,
    submitterLabel: r.submitterLabel,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export interface SubmitFeedbackInput {
  featureKey: string;
  sentiment: "up" | "down";
  comment?: string;
  submitterLabel?: string;
}

export async function submitFeatureFeedback(
  ctx: TenantContext,
  input: SubmitFeedbackInput,
): Promise<FeatureFeedbackRow> {
  const featureKey = input.featureKey.trim();
  if (!featureKey || featureKey.length > 80) {
    throw new FeedbackValidationError("featureKey is required (≤80 chars)");
  }
  if (input.sentiment !== "up" && input.sentiment !== "down") {
    throw new FeedbackValidationError("sentiment must be 'up' or 'down'");
  }
  const id = `ffe_${nanoid()}`;
  const inserted = await db
    .insert(featureFeedbackEvents)
    .values(
      withTenantValues(ctx, {
        id,
        featureKey,
        sentiment: input.sentiment,
        comment: (input.comment ?? "").trim().slice(0, 2000),
        submitterLabel: input.submitterLabel?.trim() ?? "",
      }),
    )
    .returning();
  return ffRow(inserted[0]!);
}

export interface FeatureFeedbackSentiment {
  featureKey: string;
  upCount: number;
  downCount: number;
  total: number;
  netScore: number;
}

/**
 * Cross-tenant aggregate sentiment view used by the OP team support
 * dashboard. Returns one row per feature key.
 */
export async function getFeedbackSentiment(): Promise<FeatureFeedbackSentiment[]> {
  const rows = await db
    .select({
      featureKey: featureFeedbackEvents.featureKey,
      sentiment: featureFeedbackEvents.sentiment,
      total: count(),
    })
    .from(featureFeedbackEvents)
    .groupBy(featureFeedbackEvents.featureKey, featureFeedbackEvents.sentiment);
  const map = new Map<string, FeatureFeedbackSentiment>();
  for (const r of rows) {
    const cur = map.get(r.featureKey) ?? {
      featureKey: r.featureKey,
      upCount: 0,
      downCount: 0,
      total: 0,
      netScore: 0,
    };
    if (r.sentiment === "up") cur.upCount = Number(r.total);
    if (r.sentiment === "down") cur.downCount = Number(r.total);
    cur.total = cur.upCount + cur.downCount;
    cur.netScore = cur.upCount - cur.downCount;
    map.set(r.featureKey, cur);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

export async function listRecentFeedback(limit = 50): Promise<FeatureFeedbackRow[]> {
  const safe = Math.min(Math.max(1, Math.floor(limit)), 200);
  const rows = await db
    .select()
    .from(featureFeedbackEvents)
    .orderBy(desc(featureFeedbackEvents.createdAt))
    .limit(safe);
  return rows.map(ffRow);
}
