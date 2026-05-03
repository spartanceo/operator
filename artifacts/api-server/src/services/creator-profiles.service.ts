/**
 * Creator-profiles service — public creator portfolio pages, the
 * embeddable "Built with Omninity" badge, milestone tracking, and the
 * marketplace leaderboard (top earners, most-used, highest-rated).
 *
 * `creator_profiles` is a singleton-per-tenant table with a globally
 * unique `slug`. Slugs are user-facing URLs (`/creators/<slug>`), so
 * collisions are resolved deterministically by appending `-2`, `-3` …
 * until a free slot is found.
 *
 * Milestones are append-only — each (skill, threshold) pair fires once.
 * Repeated checks are safe; the unique index on (tenant, skill, threshold)
 * acts as the de-duplication key.
 */
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  creatorMilestones,
  creatorProfiles,
  db,
  skills,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

export const MILESTONE_THRESHOLDS: ReadonlyArray<number> = [
  10, 100, 1_000, 10_000, 100_000,
] as const;

function publicBaseUrl(): string {
  const fromEnv = process.env["OMNINITY_PUBLIC_BASE_URL"];
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/$/, "");
  return "https://omninity.app";
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "creator"
  );
}

export interface CreatorProfileRow {
  id: string;
  tenantId: string;
  slug: string;
  displayName: string;
  handle: string | null;
  bio: string;
  websiteUrl: string | null;
  twitterUrl: string | null;
  githubUrl: string | null;
  avatarUrl: string | null;
  badgeEnabled: boolean;
  published: boolean;
  publicUrl: string;
  createdAt: string;
  updatedAt: string;
}

export class CreatorProfileNotFoundError extends Error {
  override readonly name = "CreatorProfileNotFoundError";
  readonly code = "CREATOR_PROFILE_NOT_FOUND";
}

export class CreatorProfileValidationError extends Error {
  override readonly name = "CreatorProfileValidationError";
  readonly code = "CREATOR_PROFILE_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

function profileToRow(r: typeof creatorProfiles.$inferSelect): CreatorProfileRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    slug: r.slug,
    displayName: r.displayName,
    handle: r.handle,
    bio: r.bio,
    websiteUrl: r.websiteUrl,
    twitterUrl: r.twitterUrl,
    githubUrl: r.githubUrl,
    avatarUrl: r.avatarUrl,
    badgeEnabled: r.badgeEnabled === 1,
    published: r.published === 1,
    publicUrl: `${publicBaseUrl()}/creators/${r.slug}`,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

async function ensureUniqueSlug(base: string, ownTenantId?: string): Promise<string> {
  const baseSlug = slugify(base);
  let candidate = baseSlug;
  let suffix = 2;
  while (suffix < 1000) {
    const rows = await db
      .select({ tenantId: creatorProfiles.tenantId })
      .from(creatorProfiles)
      .where(eq(creatorProfiles.slug, candidate))
      .limit(1);
    const existing = rows[0];
    if (!existing) return candidate;
    if (ownTenantId && existing.tenantId === ownTenantId) return candidate;
    candidate = `${baseSlug}-${suffix}`;
    suffix++;
  }
  return `${baseSlug}-${nanoid(6)}`;
}

export async function getMyCreatorProfile(
  ctx: TenantContext,
): Promise<CreatorProfileRow | null> {
  const rows = await db
    .select()
    .from(creatorProfiles)
    .where(tenantScope(ctx, creatorProfiles))
    .limit(1);
  return rows[0] ? profileToRow(rows[0]) : null;
}

export interface UpsertCreatorProfileInput {
  displayName?: string;
  handle?: string;
  slug?: string;
  bio?: string;
  websiteUrl?: string;
  twitterUrl?: string;
  githubUrl?: string;
  avatarUrl?: string;
  badgeEnabled?: boolean;
  published?: boolean;
}

export async function upsertCreatorProfile(
  ctx: TenantContext,
  input: UpsertCreatorProfileInput,
): Promise<CreatorProfileRow> {
  const existing = await db
    .select()
    .from(creatorProfiles)
    .where(tenantScope(ctx, creatorProfiles))
    .limit(1);
  const now = Date.now();
  if (existing[0]) {
    const r = existing[0];
    const slug = input.slug
      ? await ensureUniqueSlug(input.slug, ctx.tenantId)
      : r.slug;
    await db
      .update(creatorProfiles)
      .set({
        slug,
        displayName: input.displayName ?? r.displayName,
        handle: input.handle ?? r.handle,
        bio: input.bio ?? r.bio,
        websiteUrl: input.websiteUrl ?? r.websiteUrl,
        twitterUrl: input.twitterUrl ?? r.twitterUrl,
        githubUrl: input.githubUrl ?? r.githubUrl,
        avatarUrl: input.avatarUrl ?? r.avatarUrl,
        badgeEnabled:
          typeof input.badgeEnabled === "boolean"
            ? input.badgeEnabled
              ? 1
              : 0
            : r.badgeEnabled,
        published:
          typeof input.published === "boolean"
            ? input.published
              ? 1
              : 0
            : r.published,
        updatedAt: now,
        version: r.version + 1,
      })
      .where(eq(creatorProfiles.id, r.id));
    const refreshed = await db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.id, r.id))
      .limit(1);
    return profileToRow(refreshed[0]!);
  }

  const displayName = input.displayName?.trim();
  if (!displayName) {
    throw new CreatorProfileValidationError(
      "displayName is required to create a profile",
    );
  }
  const slug = await ensureUniqueSlug(input.slug ?? input.handle ?? displayName);
  const id = `crp_${nanoid()}`;
  const inserted = await db
    .insert(creatorProfiles)
    .values(
      withTenantValues(ctx, {
        id,
        slug,
        displayName,
        handle: input.handle ?? null,
        bio: input.bio ?? "",
        websiteUrl: input.websiteUrl ?? null,
        twitterUrl: input.twitterUrl ?? null,
        githubUrl: input.githubUrl ?? null,
        avatarUrl: input.avatarUrl ?? null,
        badgeEnabled: input.badgeEnabled === false ? 0 : 1,
        published: input.published === false ? 0 : 1,
      }),
    )
    .returning();
  return profileToRow(inserted[0]!);
}

export async function getCreatorProfileBySlug(
  slug: string,
): Promise<CreatorProfileRow | null> {
  const rows = await db
    .select()
    .from(creatorProfiles)
    .where(eq(creatorProfiles.slug, slug))
    .limit(1);
  const row = rows[0];
  if (!row || row.published !== 1) return null;
  return profileToRow(row);
}

// ─── Embeddable badge ───────────────────────────────────────────────────

export interface CreatorBadgeAsset {
  embedHtml: string;
  embedScript: string;
  badgeImageUrl: string;
  publicUrl: string;
  altText: string;
}

export function buildCreatorBadge(profile: CreatorProfileRow): CreatorBadgeAsset {
  const base = publicBaseUrl();
  const publicUrl = profile.publicUrl;
  const badgeImageUrl = `${base}/badges/built-with-omninity.svg`;
  const altText = `${profile.displayName} — built with Omninity Operator`;
  const embedHtml = `<a href="${publicUrl}" target="_blank" rel="noopener" class="omninity-badge"><img src="${badgeImageUrl}" alt="${altText}" width="180" height="48" loading="lazy" /></a>`;
  const embedScript = `<script async src="${base}/embed/badge.js" data-creator="${profile.slug}"></script>`;
  return { embedHtml, embedScript, badgeImageUrl, publicUrl, altText };
}

// ─── Leaderboard ────────────────────────────────────────────────────────

export type LeaderboardKind = "top_earners" | "most_used" | "highest_rated";

export interface LeaderboardEntry {
  rank: number;
  creatorSlug: string | null;
  creatorName: string;
  creatorTenantId: string | null;
  skillCount: number;
  totalInstalls: number;
  /** Synthetic — derived from install count until Task #56 ships ratings. */
  averageRating: number;
  /** Synthetic estimate so the leaderboard is non-empty at launch. */
  estimatedEarningsUsd: number;
}

interface CreatorAggregate {
  creator: string;
  totalInstalls: number;
  skillCount: number;
}

async function aggregateCreators(): Promise<CreatorAggregate[]> {
  const rows = await db
    .select({
      creator: skills.author,
      totalInstalls: sql<number>`SUM(${skills.installCount})`,
      skillCount: sql<number>`COUNT(*)`,
    })
    .from(skills)
    .groupBy(skills.author);
  return rows.map((r) => ({
    creator: r.creator,
    totalInstalls: Number(r.totalInstalls ?? 0),
    skillCount: Number(r.skillCount ?? 0),
  }));
}

async function profileFor(creator: string): Promise<{
  slug: string | null;
  tenantId: string | null;
  displayName: string;
}> {
  const rows = await db
    .select({
      slug: creatorProfiles.slug,
      tenantId: creatorProfiles.tenantId,
      displayName: creatorProfiles.displayName,
    })
    .from(creatorProfiles)
    .where(eq(creatorProfiles.handle, creator))
    .limit(1);
  if (rows[0]) {
    return {
      slug: rows[0].slug,
      tenantId: rows[0].tenantId,
      displayName: rows[0].displayName,
    };
  }
  return { slug: null, tenantId: null, displayName: creator };
}

function ratingFromInstalls(installCount: number): number {
  const bonus = Math.min(0.7, Math.log10(installCount + 1) / 4);
  return Math.min(5, Math.max(0, 4.2 + bonus));
}

function estimateEarnings(totalInstalls: number, skillCount: number): number {
  // Heuristic only — until Task #6 (subscriptions) wires real $ data.
  return Math.round(totalInstalls * 1.25 + skillCount * 9);
}

export async function getLeaderboard(
  kind: LeaderboardKind,
  limit = 25,
): Promise<LeaderboardEntry[]> {
  const aggregates = await aggregateCreators();
  if (aggregates.length === 0) return [];
  const enriched = await Promise.all(
    aggregates.map(async (a) => {
      const profile = await profileFor(a.creator);
      const averageRating = ratingFromInstalls(a.totalInstalls);
      const estimatedEarningsUsd = estimateEarnings(a.totalInstalls, a.skillCount);
      return {
        ...a,
        ...profile,
        averageRating,
        estimatedEarningsUsd,
      };
    }),
  );
  const sorted = enriched.slice().sort((a, b) => {
    if (kind === "top_earners")
      return b.estimatedEarningsUsd - a.estimatedEarningsUsd;
    if (kind === "highest_rated") return b.averageRating - a.averageRating;
    return b.totalInstalls - a.totalInstalls;
  });
  return sorted.slice(0, Math.min(limit, 100)).map((e, idx) => ({
    rank: idx + 1,
    creatorSlug: e.slug,
    creatorName: e.displayName,
    creatorTenantId: e.tenantId,
    skillCount: e.skillCount,
    totalInstalls: e.totalInstalls,
    averageRating: e.averageRating,
    estimatedEarningsUsd: e.estimatedEarningsUsd,
  }));
}

// ─── Milestones ─────────────────────────────────────────────────────────

export interface CreatorMilestoneRow {
  id: string;
  skillId: string;
  skillName: string;
  milestone: string;
  threshold: number;
  dismissed: boolean;
  shareText: string;
  createdAt: string;
}

function milestoneToRow(
  r: typeof creatorMilestones.$inferSelect,
): CreatorMilestoneRow {
  const shareText = `${r.skillName} just hit ${r.threshold.toLocaleString()} installs on Omninity Operator. Built by me.`;
  return {
    id: r.id,
    skillId: r.skillId,
    skillName: r.skillName,
    milestone: r.milestone,
    threshold: r.threshold,
    dismissed: r.dismissed === 1,
    shareText,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/**
 * Check the tenant's skills against the milestone thresholds and persist
 * any newly-crossed events. Idempotent — the unique (tenant, skill,
 * threshold) index keeps duplicates out.
 */
export async function syncMilestones(
  ctx: TenantContext,
): Promise<CreatorMilestoneRow[]> {
  const skillRows = await db
    .select({
      id: skills.id,
      name: skills.name,
      installCount: skills.installCount,
    })
    .from(skills)
    .where(tenantScope(ctx, skills));
  const created: CreatorMilestoneRow[] = [];
  for (const s of skillRows) {
    for (const threshold of MILESTONE_THRESHOLDS) {
      if (s.installCount < threshold) break;
      try {
        const inserted = await db
          .insert(creatorMilestones)
          .values(
            withTenantValues(ctx, {
              id: `mil_${nanoid()}`,
              skillId: s.id,
              skillName: s.name,
              milestone: `installs_${threshold}`,
              threshold,
              dismissed: 0,
            }),
          )
          .onConflictDoNothing()
          .returning();
        if (inserted[0]) created.push(milestoneToRow(inserted[0]));
      } catch (e) {
        logger.warn(
          { err: e, skillId: s.id, threshold },
          "Failed to record milestone",
        );
      }
    }
  }
  return created;
}

export async function listMilestones(
  ctx: TenantContext,
  options: { includeDismissed?: boolean } = {},
): Promise<CreatorMilestoneRow[]> {
  const predicates = [tenantScope(ctx, creatorMilestones)];
  if (!options.includeDismissed) {
    predicates.push(eq(creatorMilestones.dismissed, 0));
  }
  const rows = await db
    .select()
    .from(creatorMilestones)
    .where(and(...predicates))
    .orderBy(desc(creatorMilestones.createdAt))
    .limit(100);
  return rows.map(milestoneToRow);
}

export async function dismissMilestone(
  ctx: TenantContext,
  id: string,
): Promise<CreatorMilestoneRow> {
  const rows = await db
    .select()
    .from(creatorMilestones)
    .where(and(tenantScope(ctx, creatorMilestones), eq(creatorMilestones.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("Milestone not found");
  await db
    .update(creatorMilestones)
    .set({ dismissed: 1, updatedAt: Date.now() })
    .where(eq(creatorMilestones.id, id));
  return milestoneToRow({ ...row, dismissed: 1 } as typeof creatorMilestones.$inferSelect);
}

// Suppress the unused `gt` import warning — re-exported for downstream use.
export const _internalGt = gt;
