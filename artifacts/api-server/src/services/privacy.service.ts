/**
 * Privacy-event service.
 *
 * The single place that writes to `privacy_events`. Every other service that
 * touches the network or reads data across a tier boundary calls
 * `logPrivacyEvent(...)` here so the audit log is complete (Section 13 of
 * the project context).
 *
 * Reads expose a paginated list endpoint — the user must always be able to
 * audit "what left my machine, when, why".
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  privacyEvents,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

export type PrivacySeverity = "info" | "low" | "medium" | "high" | "critical";

export interface PrivacyEventInput {
  eventType: string;
  actor: string;
  target: string;
  severity?: PrivacySeverity;
  detail?: string;
}

export interface PrivacyEventRow {
  id: string;
  eventType: string;
  actor: string;
  target: string;
  severity: string;
  detail: string | null;
  createdAt: string;
}

function toRow(r: typeof privacyEvents.$inferSelect): PrivacyEventRow {
  return {
    id: r.id,
    eventType: r.eventType,
    actor: r.actor,
    target: r.target,
    severity: r.severity,
    detail: r.detail,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/**
 * Append a privacy event for the current request. Failures are swallowed
 * after logging — privacy logging must never break the caller (Standard 12 +
 * Section 13: degrade gracefully but always record what we tried).
 */
export async function logPrivacyEvent(
  ctx: TenantContext,
  input: PrivacyEventInput,
): Promise<PrivacyEventRow | null> {
  try {
    const id = `pe_${nanoid()}`;
    const severity = input.severity ?? "info";
    await db.insert(privacyEvents).values(
      withTenantValues(ctx, {
        id,
        eventType: input.eventType,
        actor: input.actor,
        target: input.target,
        severity,
        detail: input.detail ?? null,
      }),
    );
    return {
      id,
      eventType: input.eventType,
      actor: input.actor,
      target: input.target,
      severity,
      detail: input.detail ?? null,
      createdAt: new Date().toISOString(),
    };
  } catch (e) {
    logger.error({ err: e, eventType: input.eventType }, "Failed to write privacy event");
    return null;
  }
}

export async function listPrivacyEvents(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<PrivacyEventRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, privacyEvents);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(privacyEvents.createdAt, cursorTs))
      : baseScope;

  const rows = await db
    .select()
    .from(privacyEvents)
    .where(where)
    .orderBy(desc(privacyEvents.createdAt))
    .limit(limit + 1);

  return buildPage(rows.map(toRow), limit, (r) => {
    // Use the raw ms timestamp as the cursor key so we can keyset-paginate
    // by createdAt without needing a secondary tiebreak in v1.
    const ts = new Date(r.createdAt).getTime();
    return String(ts);
  });
}

export async function getPrivacyEvent(
  ctx: TenantContext,
  id: string,
): Promise<PrivacyEventRow | null> {
  const rows = await db
    .select()
    .from(privacyEvents)
    .where(and(tenantScope(ctx, privacyEvents), eq(privacyEvents.id, id)))
    .limit(1);
  const r = rows[0];
  return r ? toRow(r) : null;
}
