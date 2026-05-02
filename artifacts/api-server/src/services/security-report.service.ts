/**
 * 30-day security report.
 *
 * Aggregates the audit log + security events for the trailing 30 days
 * into a single shape the Settings → Security panel renders.
 *
 * Pure aggregation — no writes, no side effects. Safe to call from
 * read-only routes and from the daily summary email producer (the email
 * wrapper task ships the producer; the report shape is fixed here).
 */
import type { TenantContext } from "@workspace/types";

import { recentAuditEntries, verifyAuditChain } from "./audit.service";
import { recentSecurityEvents } from "./security-events.service";

export interface SecurityReport {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly totals: {
    readonly auditEntries: number;
    readonly securityEvents: number;
    readonly criticalEvents: number;
    readonly highEvents: number;
    readonly mediumEvents: number;
  };
  readonly topEventTypes: ReadonlyArray<{ eventType: string; count: number }>;
  readonly chain: {
    readonly intact: boolean;
    readonly checkedRows: number;
    readonly firstBrokenSequence: number | null;
  };
  readonly recentCritical: ReadonlyArray<{
    readonly id: string;
    readonly eventType: string;
    readonly severity: string;
    readonly actor: string;
    readonly target: string | null;
    readonly createdAt: string;
  }>;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function generateSecurityReport(
  ctx: TenantContext,
  now: number = Date.now(),
): Promise<SecurityReport> {
  const start = now - THIRTY_DAYS_MS;
  const [audit, events, chain] = await Promise.all([
    recentAuditEntries(ctx, start, 5000),
    recentSecurityEvents(ctx, start),
    verifyAuditChain(ctx),
  ]);

  let critical = 0;
  let high = 0;
  let medium = 0;
  const byType = new Map<string, number>();
  for (const e of events) {
    if (e.severity === "critical") critical++;
    else if (e.severity === "high") high++;
    else if (e.severity === "medium") medium++;
    byType.set(e.eventType, (byType.get(e.eventType) ?? 0) + 1);
  }
  const topEventTypes = Array.from(byType.entries())
    .map(([eventType, count]) => ({ eventType, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const recentCritical = events
    .filter((e) => e.severity === "critical")
    .slice(0, 20)
    .map((e) => ({
      id: e.id,
      eventType: e.eventType,
      severity: e.severity,
      actor: e.actor,
      target: e.target,
      createdAt: e.createdAt,
    }));

  return {
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(now).toISOString(),
    totals: {
      auditEntries: audit.length,
      securityEvents: events.length,
      criticalEvents: critical,
      highEvents: high,
      mediumEvents: medium,
    },
    topEventTypes,
    chain: {
      intact: chain.intact,
      checkedRows: chain.checkedRows,
      firstBrokenSequence: chain.firstBrokenSequence,
    },
    recentCritical,
  };
}
