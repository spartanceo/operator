/**
 * Audit log service — the single appender for `audit_log_entries`.
 *
 * Standard 12 § "Tamper-evident audit log": every privileged action
 * (login, logout, master-password set, vault read/write, skill install,
 * data export, data nuke) is appended to a hash-chained log. The chain
 * is anchored to the previous row's `entryHash`, so any insertion,
 * deletion, or edit anywhere in history breaks verification.
 *
 * Append-only at the application layer — there is no `update` or
 * `delete` exported, only `appendAuditEntry`, `listAuditEntries`,
 * `verifyAuditChain`. Callers MUST go through this service.
 */
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  auditLogEntries,
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { hashChainNext, verifyHashChain } from "../lib/security-crypto";
import { logger } from "../lib/logger";

export interface AuditEntryInput {
  readonly actor: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly summary: string;
}

export interface AuditEntryRow {
  readonly id: string;
  readonly sequence: number;
  readonly actor: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly summary: string;
  readonly previousHash: string | null;
  readonly entryHash: string;
  readonly createdAt: string;
}

function toRow(r: typeof auditLogEntries.$inferSelect): AuditEntryRow {
  return {
    id: r.id,
    sequence: r.sequence,
    actor: r.actor,
    action: r.action,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    summary: r.summary,
    previousHash: r.previousHash,
    entryHash: r.entryHash,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/**
 * Read the most recent row for the tenant — needed so the next append
 * can hash-chain off its `entryHash` and `sequence`.
 */
async function readTip(ctx: TenantContext): Promise<{
  previousHash: string | null;
  nextSequence: number;
}> {
  const rows = await db
    .select()
    .from(auditLogEntries)
    .where(tenantScope(ctx, auditLogEntries))
    .orderBy(desc(auditLogEntries.sequence))
    .limit(1);
  const tip = rows[0];
  if (!tip) return { previousHash: null, nextSequence: 1 };
  return { previousHash: tip.entryHash, nextSequence: tip.sequence + 1 };
}

/**
 * Append an audit entry. Writes are NOT wrapped in a transaction with
 * the caller's business write — by design. The audit log records intent
 * even when the business write fails; a separate compensating entry
 * marks the failure.
 */
export async function appendAuditEntry(
  ctx: TenantContext,
  input: AuditEntryInput,
): Promise<AuditEntryRow> {
  const { previousHash, nextSequence } = await readTip(ctx);
  const id = `aud_${nanoid()}`;
  const createdAt = Date.now();
  const payload = {
    sequence: nextSequence,
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId ?? null,
    actor: input.actor,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    summary: input.summary,
    createdAt,
  };
  const entryHash = hashChainNext(previousHash, payload);
  try {
    await db.insert(auditLogEntries).values(
      withTenantValues(ctx, {
        id,
        sequence: nextSequence,
        actor: input.actor,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        summary: input.summary,
        previousHash,
        entryHash,
        createdAt,
        updatedAt: createdAt,
      }),
    );
  } catch (e) {
    logger.error({ err: e, action: input.action }, "audit append failed");
    throw e;
  }
  return {
    id,
    sequence: nextSequence,
    actor: input.actor,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    summary: input.summary,
    previousHash,
    entryHash,
    createdAt: new Date(createdAt).toISOString(),
  };
}

export interface AuditListInput {
  readonly limit?: number;
  readonly cursor?: string | null;
}

/**
 * Paginated list of audit rows, newest first.
 */
export async function listAuditEntries(
  ctx: TenantContext,
  input: AuditListInput = {},
): Promise<PaginatedData<AuditEntryRow>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const baseScope = tenantScope(ctx, auditLogEntries);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(auditLogEntries.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(auditLogEntries)
    .where(where)
    .orderBy(desc(auditLogEntries.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) => String(new Date(r.createdAt).getTime()));
}

export interface AuditVerifyResult {
  readonly intact: boolean;
  readonly checkedRows: number;
  readonly firstBrokenSequence: number | null;
  readonly verifiedAt: string;
}

/**
 * Walk the entire chain and confirm every row's hash matches its
 * declared payload + previous hash. Returns the sequence number of the
 * first broken row, or null if the chain is intact.
 */
export async function verifyAuditChain(ctx: TenantContext): Promise<AuditVerifyResult> {
  const rows = await db
    .select()
    .from(auditLogEntries)
    .where(tenantScope(ctx, auditLogEntries))
    .orderBy(asc(auditLogEntries.sequence));
  const chainRows = rows.map((r) => ({
    previousHash: r.previousHash,
    entryHash: r.entryHash,
    payload: {
      sequence: r.sequence,
      tenantId: r.tenantId,
      workspaceId: r.workspaceId,
      actor: r.actor,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      summary: r.summary,
      createdAt: r.createdAt,
    },
  }));
  const broken = verifyHashChain(chainRows);
  return {
    intact: broken === null,
    checkedRows: rows.length,
    firstBrokenSequence: broken === null ? null : rows[broken]!.sequence,
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Sequence-ordered tail (used by /security/report). Returns the most
 * recent N rows in chronological order so a reader can render a
 * timeline without further sorting.
 */
export async function recentAuditEntries(
  ctx: TenantContext,
  sinceMs: number,
  limit: number = 500,
): Promise<ReadonlyArray<AuditEntryRow>> {
  const rows = await db
    .select()
    .from(auditLogEntries)
    .where(and(tenantScope(ctx, auditLogEntries), eq(auditLogEntries.tenantId, ctx.tenantId)))
    .orderBy(asc(auditLogEntries.createdAt))
    .limit(limit);
  return rows.filter((r) => r.createdAt >= sinceMs).map(toRow);
}
