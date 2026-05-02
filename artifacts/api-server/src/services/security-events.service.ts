/**
 * Security events service — append-only writer / paginated reader for
 * `security_events`. Distinct from the audit log: events are not
 * hash-chained (volume is too high for the per-event hash overhead) but
 * they are filterable by severity for the 30-day report and for the
 * Settings → Security panel.
 */
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  securityEvents,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

export type SecuritySeverity = "info" | "low" | "medium" | "high" | "critical";

export interface SecurityEventInput {
  readonly eventType: string;
  readonly severity?: SecuritySeverity;
  readonly actor: string;
  readonly target?: string | null;
  readonly sourceIp?: string | null;
  readonly detail?: string | null;
}

export interface SecurityEventRow {
  readonly id: string;
  readonly eventType: string;
  readonly severity: string;
  readonly actor: string;
  readonly target: string | null;
  readonly sourceIp: string | null;
  readonly detail: string | null;
  readonly createdAt: string;
}

function toRow(r: typeof securityEvents.$inferSelect): SecurityEventRow {
  return {
    id: r.id,
    eventType: r.eventType,
    severity: r.severity,
    actor: r.actor,
    target: r.target,
    sourceIp: r.sourceIp,
    detail: r.detail,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/**
 * Append a security event. Failures are swallowed after logging — the
 * security log must NEVER break the calling flow (a logging outage
 * shouldn't lock the user out of their own data).
 */
export async function logSecurityEvent(
  ctx: TenantContext,
  input: SecurityEventInput,
): Promise<SecurityEventRow | null> {
  try {
    const id = `sev_${nanoid()}`;
    const severity = input.severity ?? "info";
    const createdAt = Date.now();
    await db.insert(securityEvents).values(
      withTenantValues(ctx, {
        id,
        eventType: input.eventType,
        severity,
        actor: input.actor,
        target: input.target ?? null,
        sourceIp: input.sourceIp ?? null,
        detail: input.detail ?? null,
        createdAt,
        updatedAt: createdAt,
      }),
    );
    return {
      id,
      eventType: input.eventType,
      severity,
      actor: input.actor,
      target: input.target ?? null,
      sourceIp: input.sourceIp ?? null,
      detail: input.detail ?? null,
      createdAt: new Date(createdAt).toISOString(),
    };
  } catch (e) {
    logger.error({ err: e, eventType: input.eventType }, "security event append failed");
    return null;
  }
}

export interface SecurityEventsListInput {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly severity?: SecuritySeverity;
}

export async function listSecurityEvents(
  ctx: TenantContext,
  input: SecurityEventsListInput = {},
): Promise<PaginatedData<SecurityEventRow>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const base = tenantScope(ctx, securityEvents);
  const filters = [base];
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    filters.push(lt(securityEvents.createdAt, cursorTs));
  }
  if (input.severity) filters.push(eq(securityEvents.severity, input.severity));
  const rows = await db
    .select()
    .from(securityEvents)
    .where(and(...filters))
    .orderBy(desc(securityEvents.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) => String(new Date(r.createdAt).getTime()));
}

/**
 * Used by the 30-day report — all events newer than `sinceMs`,
 * unbounded but capped at 5000 rows so a long-lived install with a
 * noisy logger can't OOM the report endpoint.
 */
export async function recentSecurityEvents(
  ctx: TenantContext,
  sinceMs: number,
): Promise<ReadonlyArray<SecurityEventRow>> {
  const rows = await db
    .select()
    .from(securityEvents)
    .where(and(tenantScope(ctx, securityEvents), gte(securityEvents.createdAt, sinceMs)))
    .orderBy(desc(securityEvents.createdAt))
    .limit(5000);
  return rows.map(toRow);
}
