/**
 * Network call logger.
 *
 * Every service that performs an outbound HTTP call MUST also call
 * `recordNetworkCall(...)` so the Privacy Dashboard's "What's been shared"
 * panel reflects reality. The recorder is intentionally synchronous-ish
 * (returns a promise but never throws) so the caller can `void`-await it
 * without blocking the actual request path.
 */
import { and, desc, gte, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  networkCalls,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";

export type NetworkCallInitiator = "user" | "automatic";

export interface NetworkCallInput {
  readonly domain: string;
  readonly purpose: string;
  readonly dataType?: string;
  readonly initiator?: NetworkCallInitiator;
  readonly bytesSent?: number;
  readonly bytesReceived?: number;
  readonly statusCode?: number;
}

export interface NetworkCallRow {
  readonly id: string;
  readonly domain: string;
  readonly purpose: string;
  readonly dataType: string;
  readonly initiator: NetworkCallInitiator;
  readonly bytesSent: number;
  readonly bytesReceived: number;
  readonly statusCode: number | null;
  readonly createdAt: string;
}

function toRow(r: typeof networkCalls.$inferSelect): NetworkCallRow {
  return {
    id: r.id,
    domain: r.domain,
    purpose: r.purpose,
    dataType: r.dataType,
    initiator: r.initiator as NetworkCallInitiator,
    bytesSent: r.bytesSent,
    bytesReceived: r.bytesReceived,
    statusCode: r.statusCode,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/**
 * Record one outbound network call. Best-effort — failures are logged
 * but never rethrown so the production code path is never broken by
 * audit logging (Standard 12 § "logging never breaks the caller").
 *
 * Also fans the event out to `privacy_events` so the existing audit log
 * remains the canonical surface for "every cross-boundary call".
 */
export async function recordNetworkCall(
  ctx: TenantContext,
  input: NetworkCallInput,
): Promise<NetworkCallRow | null> {
  try {
    const id = `nc_${nanoid()}`;
    const initiator = input.initiator ?? "automatic";
    const dataType = input.dataType ?? "metadata";
    const now = Date.now();
    await db.insert(networkCalls).values(
      withTenantValues(ctx, {
        id,
        domain: input.domain,
        purpose: input.purpose,
        dataType,
        initiator,
        bytesSent: input.bytesSent ?? 0,
        bytesReceived: input.bytesReceived ?? 0,
        statusCode: input.statusCode ?? null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await logPrivacyEvent(ctx, {
      eventType: "network.outbound",
      actor: initiator,
      target: input.domain,
      severity: initiator === "user" ? "info" : "low",
      detail: `${input.purpose} (${dataType})`,
    });
    return {
      id,
      domain: input.domain,
      purpose: input.purpose,
      dataType,
      initiator,
      bytesSent: input.bytesSent ?? 0,
      bytesReceived: input.bytesReceived ?? 0,
      statusCode: input.statusCode ?? null,
      createdAt: new Date(now).toISOString(),
    };
  } catch (e) {
    logger.error({ err: e, domain: input.domain }, "Failed to record network call");
    return null;
  }
}

export async function listNetworkCalls(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number; sinceMs?: number } = {},
): Promise<PaginatedData<NetworkCallRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, networkCalls);
  const sinceFilter =
    typeof opts.sinceMs === "number" && Number.isFinite(opts.sinceMs)
      ? gte(networkCalls.createdAt, opts.sinceMs)
      : undefined;
  const cursorFilter =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? lt(networkCalls.createdAt, cursorTs)
      : undefined;
  const where = [baseScope, sinceFilter, cursorFilter].filter(
    (x): x is NonNullable<typeof x> => x !== undefined,
  );
  const whereExpr = where.length === 1 ? where[0] : and(...where);

  const rows = await db
    .select()
    .from(networkCalls)
    .where(whereExpr)
    .orderBy(desc(networkCalls.createdAt))
    .limit(limit + 1);

  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export interface NetworkCallSummary {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly totalCalls: number;
  readonly totalBytesSent: number;
  readonly totalBytesReceived: number;
  readonly userInitiated: number;
  readonly automatic: number;
  readonly byDomain: ReadonlyArray<{
    readonly domain: string;
    readonly count: number;
    readonly purposes: ReadonlyArray<string>;
  }>;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Aggregate the trailing-30-day call log for the dashboard's
 * "What's been shared" panel.
 */
export async function summariseNetworkCalls(
  ctx: TenantContext,
  now: number = Date.now(),
): Promise<NetworkCallSummary> {
  const start = now - THIRTY_DAYS_MS;
  const rows = await db
    .select()
    .from(networkCalls)
    .where(
      and(
        tenantScope(ctx, networkCalls),
        gte(networkCalls.createdAt, start),
      ),
    )
    .orderBy(desc(networkCalls.createdAt))
    .limit(5000);

  let totalBytesSent = 0;
  let totalBytesReceived = 0;
  let userInitiated = 0;
  let automatic = 0;
  const byDomain = new Map<string, { count: number; purposes: Set<string> }>();
  for (const r of rows) {
    totalBytesSent += r.bytesSent;
    totalBytesReceived += r.bytesReceived;
    if (r.initiator === "user") userInitiated++;
    else automatic++;
    const entry = byDomain.get(r.domain) ?? {
      count: 0,
      purposes: new Set<string>(),
    };
    entry.count++;
    entry.purposes.add(r.purpose);
    byDomain.set(r.domain, entry);
  }

  const byDomainArr = Array.from(byDomain.entries())
    .map(([domain, v]) => ({
      domain,
      count: v.count,
      purposes: Array.from(v.purposes).slice(0, 10),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  return {
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(now).toISOString(),
    totalCalls: rows.length,
    totalBytesSent,
    totalBytesReceived,
    userInitiated,
    automatic,
    byDomain: byDomainArr,
  };
}
