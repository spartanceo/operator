/**
 * Share service — skill share links, social card metadata, post-task
 * satisfaction ratings, and the deep-link handshake into the OP desktop
 * app.
 *
 * Privacy preserving by design:
 *   - Share cards are TEXT, never screenshots.
 *   - Social card payloads contain only marketing-safe fields (title,
 *     creator, rating, one-line description) — no message bodies, no
 *     workspace data.
 *   - Deep links use a custom scheme (`omninity://`) that the desktop
 *     app's URL-handler intercepts; the public web fallback opens the
 *     marketplace listing instead.
 */
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  shareEvents,
  skills,
  taskSatisfactionRatings,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

export type ShareTargetKind = "skill" | "task" | "creator";
export type ShareChannel =
  | "twitter"
  | "linkedin"
  | "whatsapp"
  | "copy"
  | "native"
  | "email";

export interface ShareEventRow {
  id: string;
  targetKind: ShareTargetKind;
  targetId: string;
  channel: ShareChannel;
  label: string | null;
  createdAt: string;
}

function publicBaseUrl(): string {
  const fromEnv = process.env["OMNINITY_PUBLIC_BASE_URL"];
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/$/, "");
  return "https://omninity.app";
}

function deepLinkScheme(): string {
  return process.env["OMNINITY_DEEP_LINK_SCHEME"] ?? "omninity";
}

function eventToRow(r: typeof shareEvents.$inferSelect): ShareEventRow {
  return {
    id: r.id,
    targetKind: r.targetKind as ShareTargetKind,
    targetId: r.targetId,
    channel: r.channel as ShareChannel,
    label: r.label,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export async function recordShareEvent(
  ctx: TenantContext,
  input: {
    targetKind: ShareTargetKind;
    targetId: string;
    channel?: ShareChannel;
    label?: string;
  },
): Promise<ShareEventRow> {
  const id = `shr_${nanoid()}`;
  const inserted = await db
    .insert(shareEvents)
    .values(
      withTenantValues(ctx, {
        id,
        targetKind: input.targetKind,
        targetId: input.targetId,
        channel: input.channel ?? "copy",
        label: input.label ?? null,
      }),
    )
    .returning();
  return eventToRow(inserted[0]!);
}

export async function listShareEvents(
  ctx: TenantContext,
  filters: { targetKind?: ShareTargetKind; targetId?: string } = {},
): Promise<ShareEventRow[]> {
  const predicates = [tenantScope(ctx, shareEvents)];
  if (filters.targetKind) {
    predicates.push(eq(shareEvents.targetKind, filters.targetKind));
  }
  if (filters.targetId) {
    predicates.push(eq(shareEvents.targetId, filters.targetId));
  }
  const rows = await db
    .select()
    .from(shareEvents)
    .where(and(...predicates))
    .orderBy(desc(shareEvents.createdAt))
    .limit(100);
  return rows.map(eventToRow);
}

export interface SkillShareLinks {
  webUrl: string;
  deepLinkUrl: string;
  shortUrl: string;
}

export interface SkillSocialCard {
  title: string;
  creator: string;
  description: string;
  category: string;
  installs: number;
  rating: number;
  ratingDisplay: string;
  webUrl: string;
  deepLinkUrl: string;
  /** Per-channel preformatted text strings the client can paste. */
  channels: {
    twitter: string;
    linkedin: string;
    whatsapp: string;
    email: { subject: string; body: string };
  };
}

/**
 * Build the share links + social card for a skill. We intentionally
 * accept either the canonical id or slug so the marketplace UI can call
 * with whichever it has on hand.
 */
export async function getSkillShareCard(
  ctx: TenantContext,
  identifier: string,
): Promise<SkillSocialCard | null> {
  const rows = await db
    .select()
    .from(skills)
    .where(
      and(
        tenantScope(ctx, skills),
        eq(skills.id, identifier),
      ),
    )
    .limit(1);
  let row = rows[0];
  if (!row) {
    const bySlug = await db
      .select()
      .from(skills)
      .where(and(tenantScope(ctx, skills), eq(skills.slug, identifier)))
      .limit(1);
    row = bySlug[0];
  }
  if (!row) return null;
  return buildSkillCard({
    name: row.name,
    slug: row.slug,
    description: row.description,
    author: row.author,
    category: row.category,
    installCount: row.installCount,
    // The marketplace doesn't yet store ratings on the skill row — we
    // use the install count as a deterministic stand-in (4.2 base + a
    // mild log bonus, capped at 5.0). Once Task #56 (Reviews & Trust)
    // lands this can read the persisted rating.
    rating: ratingFromInstalls(row.installCount),
  });
}

export function buildSkillShareLinks(slug: string): SkillShareLinks {
  const base = publicBaseUrl();
  const shortUrl = `${base}/s/${slug}`;
  const webUrl = `${base}/marketplace/${slug}`;
  const deepLinkUrl = `${deepLinkScheme()}://skill/${slug}`;
  return { webUrl, deepLinkUrl, shortUrl };
}

export function buildTaskShareCard(input: {
  goal: string;
  summary: string;
  durationMs?: number;
}): { title: string; body: string; channels: SkillSocialCard["channels"] } {
  // Trim + sanitise — strip any URL/email-looking tokens to avoid
  // accidentally surfacing private context. Privacy-preserving share.
  const cleanGoal = sanitiseForShare(input.goal).slice(0, 140);
  const cleanSummary = sanitiseForShare(input.summary).slice(0, 220);
  const dur =
    input.durationMs && input.durationMs > 0
      ? ` in ${formatDuration(input.durationMs)}`
      : "";
  const title = `OP just did that${dur}`;
  const body = `${title}\n\nGoal: ${cleanGoal}\n\n${cleanSummary}\n\nLearn more at ${publicBaseUrl()}`;
  const channels: SkillSocialCard["channels"] = {
    twitter: `OP just handled this for me${dur}: "${cleanGoal}" — ${publicBaseUrl()}`,
    linkedin: `${title}.\n\n${cleanSummary}\n\nTry Omninity Operator: ${publicBaseUrl()}`,
    whatsapp: `${title} → ${cleanGoal}\n${publicBaseUrl()}`,
    email: {
      subject: `OP just handled this${dur}`,
      body,
    },
  };
  return { title, body, channels };
}

function buildSkillCard(input: {
  name: string;
  slug: string;
  description: string;
  author: string;
  category: string;
  installCount: number;
  rating: number;
}): SkillSocialCard {
  const links = buildSkillShareLinks(input.slug);
  const oneLiner = (input.description || "").trim().split(/\n+/)[0]?.slice(0, 140) ?? "";
  const ratingDisplay = `${input.rating.toFixed(1)} ★`;
  const channels = {
    twitter: `${input.name} by ${input.author} — ${ratingDisplay} on Omninity Operator. ${links.shortUrl}`,
    linkedin: `${input.name} — built by ${input.author} for Omninity Operator (${input.category}). ${oneLiner} ${links.shortUrl}`,
    whatsapp: `${input.name} (${ratingDisplay}) on Omninity: ${links.shortUrl}`,
    email: {
      subject: `${input.name} on Omninity Operator`,
      body: `${input.name} by ${input.author}\n${oneLiner}\n${ratingDisplay} · ${input.installCount} installs\n\n${links.webUrl}`,
    },
  };
  return {
    title: input.name,
    creator: input.author,
    description: oneLiner,
    category: input.category,
    installs: input.installCount,
    rating: input.rating,
    ratingDisplay,
    webUrl: links.webUrl,
    deepLinkUrl: links.deepLinkUrl,
    channels,
  };
}

function ratingFromInstalls(installCount: number): number {
  const bonus = Math.min(0.7, Math.log10(installCount + 1) / 4);
  return Math.min(5, Math.max(0, 4.2 + bonus));
}

function sanitiseForShare(input: string): string {
  return input
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ─── Task satisfaction ratings ──────────────────────────────────────────

export type SatisfactionRating = "up" | "down";

export interface TaskSatisfactionRow {
  id: string;
  runId: string | null;
  rating: SatisfactionRating;
  summary: string | null;
  shouldPromptShare: boolean;
  createdAt: string;
}

function ratingToRow(
  r: typeof taskSatisfactionRatings.$inferSelect,
): TaskSatisfactionRow {
  return {
    id: r.id,
    runId: r.runId,
    rating: r.rating as SatisfactionRating,
    summary: r.summary,
    shouldPromptShare: r.rating === "up",
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export async function recordSatisfaction(
  ctx: TenantContext,
  input: { runId?: string; rating: SatisfactionRating; summary?: string },
): Promise<TaskSatisfactionRow> {
  if (input.rating !== "up" && input.rating !== "down") {
    throw new Error("rating must be 'up' or 'down'");
  }
  const id = `sat_${nanoid()}`;
  const inserted = await db
    .insert(taskSatisfactionRatings)
    .values(
      withTenantValues(ctx, {
        id,
        runId: input.runId ?? null,
        rating: input.rating,
        summary: input.summary ?? null,
      }),
    )
    .returning();
  return ratingToRow(inserted[0]!);
}

export async function listSatisfactionRatings(
  ctx: TenantContext,
  filters: { runId?: string } = {},
): Promise<TaskSatisfactionRow[]> {
  const predicates = [tenantScope(ctx, taskSatisfactionRatings)];
  if (filters.runId) {
    predicates.push(eq(taskSatisfactionRatings.runId, filters.runId));
  }
  const rows = await db
    .select()
    .from(taskSatisfactionRatings)
    .where(and(...predicates))
    .orderBy(desc(taskSatisfactionRatings.createdAt))
    .limit(100);
  return rows.map(ratingToRow);
}
