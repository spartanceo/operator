/**
 * Connected-account service — Gmail / Outlook / Google Calendar /
 * Apple Calendar / Twilio VoIP.
 *
 * Tier 1 stores OAuth tokens locally on the comm_accounts row. Section 12
 * calls for a future swap to an OS keychain (keytar); the column shape
 * stays the same so callers don't churn. Every connect/disconnect writes
 * a privacy event so the user can audit which providers have been linked.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  commAccounts,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logPrivacyEvent } from "../privacy.service";

export type CommProvider =
  | "gmail"
  | "outlook"
  | "google_calendar"
  | "apple_calendar"
  | "twilio";

export type CommKind = "email" | "calendar" | "voip";

export type CommStatus = "active" | "disconnected" | "error";

export interface CommAccountRow {
  id: string;
  provider: CommProvider;
  kind: CommKind;
  label: string;
  status: CommStatus;
  metadata: Record<string, unknown> | null;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectAccountInput {
  provider: CommProvider;
  label: string;
  /** Opaque token captured from the provider's OAuth callback (or the
   *  Twilio Account SID for VoIP). */
  accessToken?: string;
  refreshToken?: string;
  /** Unix-ms expiry. Omit for never-expiring credentials. */
  tokenExpiresAt?: number;
  metadata?: Record<string, unknown>;
}

const PROVIDER_KIND: Record<CommProvider, CommKind> = {
  gmail: "email",
  outlook: "email",
  google_calendar: "calendar",
  apple_calendar: "calendar",
  twilio: "voip",
};

function toRow(r: typeof commAccounts.$inferSelect): CommAccountRow {
  return {
    id: r.id,
    provider: r.provider as CommProvider,
    kind: r.kind as CommKind,
    label: r.label,
    status: r.status as CommStatus,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    tokenExpiresAt: r.tokenExpiresAt ? new Date(r.tokenExpiresAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function listAccounts(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<CommAccountRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, commAccounts);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(commAccounts.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(commAccounts)
    .where(where)
    .orderBy(desc(commAccounts.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) => String(new Date(r.createdAt).getTime()));
}

export async function getAccount(
  ctx: TenantContext,
  id: string,
): Promise<CommAccountRow | null> {
  const rows = await db
    .select()
    .from(commAccounts)
    .where(and(tenantScope(ctx, commAccounts), eq(commAccounts.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function connectAccount(
  ctx: TenantContext,
  input: ConnectAccountInput,
): Promise<CommAccountRow> {
  const id = `cacc_${nanoid()}`;
  const kind = PROVIDER_KIND[input.provider];
  await db.insert(commAccounts).values(
    withTenantValues(ctx, {
      id,
      provider: input.provider,
      kind,
      label: input.label,
      accessToken: input.accessToken ?? null,
      refreshToken: input.refreshToken ?? null,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      status: "active" as const,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    }),
  );
  await logPrivacyEvent(ctx, {
    eventType: "comm.account.connected",
    actor: "user",
    target: `${input.provider}:${input.label}`,
    severity: "medium",
    detail: `Connected ${input.provider} account`,
  });
  const row = await getAccount(ctx, id);
  if (!row) throw new Error("Account not found after insert");
  return row;
}

export async function disconnectAccount(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; disconnected: boolean }> {
  const existing = await getAccount(ctx, id);
  if (!existing) return { id, disconnected: false };
  await db
    .update(commAccounts)
    .set({
      status: "disconnected",
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      updatedAt: Date.now(),
    })
    .where(and(tenantScope(ctx, commAccounts), eq(commAccounts.id, id)));
  await logPrivacyEvent(ctx, {
    eventType: "comm.account.disconnected",
    actor: "user",
    target: `${existing.provider}:${existing.label}`,
    severity: "low",
    detail: `Disconnected ${existing.provider} account`,
  });
  return { id, disconnected: true };
}

/**
 * Internal helper: load an account row and assert that it has a token.
 * Used by every send/read path so the call site can rely on a non-null
 * credential being present.
 */
export async function requireConnectedAccount(
  ctx: TenantContext,
  id: string,
  expectedKind: CommKind,
): Promise<CommAccountRow> {
  const row = await getAccount(ctx, id);
  if (!row) throw new Error(`Account ${id} not found`);
  if (row.kind !== expectedKind) {
    throw new Error(
      `Account ${id} is kind="${row.kind}", expected "${expectedKind}"`,
    );
  }
  if (row.status !== "active") {
    throw new Error(`Account ${id} is ${row.status}, not active`);
  }
  return row;
}
