/**
 * Waitlist service — public marketing-site email capture for unreleased
 * features.
 *
 * Storage notes:
 *   - Rows are persisted under the SYSTEM tenant because public marketing
 *     visitors don't have a tenant of their own. Admin views from inside
 *     OP read the rows via the system-tenant scope.
 *   - The unique index on `(feature, email)` keeps double-submissions out;
 *     a re-submission is treated as success and returns the existing row.
 *   - Email is normalised to lower-case and trimmed before storage.
 */
import { and, count, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  SYSTEM_TENANT_ID,
  tenantScope,
  waitlistSignups,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface WaitlistSignupRow {
  id: string;
  feature: string;
  email: string;
  name: string | null;
  source: string | null;
  referralCode: string | null;
  notifiedAt: string | null;
  createdAt: string;
}

function toRow(r: typeof waitlistSignups.$inferSelect): WaitlistSignupRow {
  return {
    id: r.id,
    feature: r.feature,
    email: r.email,
    name: r.name,
    source: r.source,
    referralCode: r.referralCode,
    notifiedAt: r.notifiedAt ? new Date(r.notifiedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export class WaitlistValidationError extends Error {
  override readonly name = "WaitlistValidationError";
  readonly code = "WAITLIST_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

export interface CreateWaitlistInput {
  feature: string;
  email: string;
  name?: string;
  source?: string;
  referralCode?: string;
}

/**
 * Public path — accepts a signup with no tenant context. Idempotent:
 * a duplicate submission returns the existing row.
 */
export async function createWaitlistSignup(
  input: CreateWaitlistInput,
): Promise<{ signup: WaitlistSignupRow; deduplicated: boolean }> {
  const email = input.email.trim().toLowerCase();
  const feature = input.feature.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new WaitlistValidationError("invalid email");
  if (feature.length === 0 || feature.length > 80) {
    throw new WaitlistValidationError("feature is required (≤80 chars)");
  }
  const existing = await db
    .select()
    .from(waitlistSignups)
    .where(and(eq(waitlistSignups.feature, feature), eq(waitlistSignups.email, email)))
    .limit(1);
  if (existing[0]) {
    return { signup: toRow(existing[0]), deduplicated: true };
  }
  const id = `wl_${nanoid()}`;
  const inserted = await db
    .insert(waitlistSignups)
    .values({
      id,
      tenantId: SYSTEM_TENANT_ID,
      feature,
      email,
      name: input.name?.trim() || null,
      source: input.source?.trim() || null,
      referralCode: input.referralCode?.trim() || null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    logger.info({ feature, id }, "Waitlist signup recorded");
    return { signup: toRow(inserted[0]), deduplicated: false };
  }
  // Race-loser fell through onConflictDoNothing; re-read the existing row.
  const refresh = await db
    .select()
    .from(waitlistSignups)
    .where(
      and(eq(waitlistSignups.feature, feature), eq(waitlistSignups.email, email)),
    )
    .limit(1);
  return { signup: toRow(refresh[0]!), deduplicated: true };
}

export interface WaitlistStats {
  feature: string;
  total: number;
}

export async function listWaitlistStats(): Promise<WaitlistStats[]> {
  const rows = await db
    .select({
      feature: waitlistSignups.feature,
      total: count(),
    })
    .from(waitlistSignups)
    .groupBy(waitlistSignups.feature);
  return rows.map((r) => ({ feature: r.feature, total: Number(r.total) }));
}

export interface ListWaitlistOptions {
  feature?: string;
  cursor?: string;
  limit?: number;
}

export async function listWaitlistSignups(
  ctx: TenantContext,
  opts: ListWaitlistOptions = {},
): Promise<PaginatedData<WaitlistSignupRow>> {
  const limit = normaliseLimit(opts.limit);
  const predicates = [tenantScope(ctx, waitlistSignups)];
  if (opts.feature) {
    predicates.push(eq(waitlistSignups.feature, opts.feature.trim().toLowerCase()));
  }
  if (opts.cursor) {
    const cursorTs = Number(decodeCursor(opts.cursor));
    if (Number.isFinite(cursorTs)) {
      predicates.push(lt(waitlistSignups.createdAt, cursorTs));
    }
  }
  const rows = await db
    .select()
    .from(waitlistSignups)
    .where(and(...predicates))
    .orderBy(desc(waitlistSignups.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) => String(new Date(r.createdAt).getTime()));
}
