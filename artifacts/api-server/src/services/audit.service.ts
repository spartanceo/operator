/**
 * Audit log service — the single appender for `audit_log_entries`.
 *
 * Standard 12 § "Tamper-evident audit log": every privileged action
 * (login, logout, master-password set, vault read/write, skill install,
 * data export, data nuke, tool call, file op, API call, approval
 * decision) is appended to a hash-chained log. The chain is anchored to
 * the previous row's `entryHash`, so any insertion, deletion, or edit
 * anywhere in history breaks verification.
 *
 * Compliance-grade fields (Task #53) — actionType, agentId, skillId,
 * toolId, userId, sessionId, inputHash, outputSummary, approvalStatus —
 * are optional on the input but participate in the chain hash whenever
 * supplied, so any post-hoc tampering with them is detectable.
 *
 * Append-only at the application layer — no `update` or `delete` is
 * exported; only `appendAuditEntry`, `listAuditEntries`,
 * `verifyAuditChain`, `purgeExpiredAuditEntries`, `signAuditExport`,
 * and the read tail used by the security-report builder. Callers MUST
 * go through this service.
 */
import { and, asc, count as drizzleCount, desc, eq, gte, like, lt, lte, max as drizzleMax } from "drizzle-orm";
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

import { hashChainNext, hmacSign, verifyHashChain } from "../lib/security-crypto";
import { logger } from "../lib/logger";
import { evaluateAlertRulesForEntry } from "./audit-alerts.service";

export interface AuditEntryInput {
  readonly actor: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly summary: string;
  readonly actionType?: string | null;
  readonly agentId?: string | null;
  readonly skillId?: string | null;
  readonly toolId?: string | null;
  readonly userId?: string | null;
  readonly sessionId?: string | null;
  readonly inputHash?: string | null;
  readonly outputSummary?: string | null;
  readonly approvalStatus?: string | null;
}

export interface AuditEntryRow {
  readonly id: string;
  readonly sequence: number;
  readonly actor: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly summary: string;
  readonly actionType: string | null;
  readonly agentId: string | null;
  readonly skillId: string | null;
  readonly toolId: string | null;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly inputHash: string | null;
  readonly outputSummary: string | null;
  readonly approvalStatus: string | null;
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
    actionType: r.actionType,
    agentId: r.agentId,
    skillId: r.skillId,
    toolId: r.toolId,
    userId: r.userId,
    sessionId: r.sessionId,
    inputHash: r.inputHash,
    outputSummary: r.outputSummary,
    approvalStatus: r.approvalStatus,
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
 *
 * After persisting, the alert-rule engine is invoked best-effort —
 * a failure there never aborts the audit append.
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
    actionType: input.actionType ?? null,
    agentId: input.agentId ?? null,
    skillId: input.skillId ?? null,
    toolId: input.toolId ?? null,
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? null,
    inputHash: input.inputHash ?? null,
    outputSummary: input.outputSummary ?? null,
    approvalStatus: input.approvalStatus ?? null,
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
        actionType: input.actionType ?? null,
        agentId: input.agentId ?? null,
        skillId: input.skillId ?? null,
        toolId: input.toolId ?? null,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        inputHash: input.inputHash ?? null,
        outputSummary: input.outputSummary ?? null,
        approvalStatus: input.approvalStatus ?? null,
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
  const row: AuditEntryRow = {
    id,
    sequence: nextSequence,
    actor: input.actor,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    summary: input.summary,
    actionType: input.actionType ?? null,
    agentId: input.agentId ?? null,
    skillId: input.skillId ?? null,
    toolId: input.toolId ?? null,
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? null,
    inputHash: input.inputHash ?? null,
    outputSummary: input.outputSummary ?? null,
    approvalStatus: input.approvalStatus ?? null,
    previousHash,
    entryHash,
    createdAt: new Date(createdAt).toISOString(),
  };
  // Best-effort alert evaluation. A throw here MUST NOT abort the
  // audit append (the audit guarantee outranks the alert convenience).
  try {
    await evaluateAlertRulesForEntry(ctx, row);
  } catch (e) {
    logger.warn({ err: e, action: input.action }, "audit alert evaluation failed");
  }
  return row;
}

export interface AuditListInput {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly actionType?: string | null;
  readonly action?: string | null;
  readonly actor?: string | null;
  readonly agentId?: string | null;
  readonly userId?: string | null;
  readonly sinceMs?: number | null;
  readonly untilMs?: number | null;
  readonly search?: string | null;
}

/**
 * Paginated list of audit rows, newest first, with optional filters
 * (date range, action, action type, actor, agent, user, free-text
 * substring search over the summary).
 */
export async function listAuditEntries(
  ctx: TenantContext,
  input: AuditListInput = {},
): Promise<PaginatedData<AuditEntryRow>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const conditions = [tenantScope(ctx, auditLogEntries)];
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(auditLogEntries.createdAt, cursorTs));
  }
  if (input.actionType) conditions.push(eq(auditLogEntries.actionType, input.actionType));
  if (input.action) conditions.push(eq(auditLogEntries.action, input.action));
  if (input.actor) conditions.push(eq(auditLogEntries.actor, input.actor));
  if (input.agentId) conditions.push(eq(auditLogEntries.agentId, input.agentId));
  if (input.userId) conditions.push(eq(auditLogEntries.userId, input.userId));
  if (input.sinceMs && Number.isFinite(input.sinceMs)) {
    conditions.push(gte(auditLogEntries.createdAt, input.sinceMs));
  }
  if (input.untilMs && Number.isFinite(input.untilMs)) {
    conditions.push(lte(auditLogEntries.createdAt, input.untilMs));
  }
  if (input.search && input.search.length > 0) {
    const escaped = input.search.replace(/[%_\\]/g, (c) => `\\${c}`);
    conditions.push(like(auditLogEntries.summary, `%${escaped}%`));
  }
  const rows = await db
    .select()
    .from(auditLogEntries)
    .where(and(...conditions))
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
 *
 * If a retention purge has occurred, the first surviving row's
 * `previousHash` is expected to equal the recorded
 * `chainCheckpointHash` (segmented-chain design) — that anchor proves
 * the surviving tail is a continuation of the deleted prefix.
 */
export async function verifyAuditChain(
  ctx: TenantContext,
  options: { checkpointHash?: string | null } = {},
): Promise<AuditVerifyResult> {
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
      actionType: r.actionType,
      agentId: r.agentId,
      skillId: r.skillId,
      toolId: r.toolId,
      userId: r.userId,
      sessionId: r.sessionId,
      inputHash: r.inputHash,
      outputSummary: r.outputSummary,
      approvalStatus: r.approvalStatus,
      createdAt: r.createdAt,
    },
  }));
  // Segmented-chain verification: when a checkpoint exists (i.e. a
  // purge has happened) the first surviving row's `previousHash` is
  // expected to equal the checkpoint, and its own `entryHash` was
  // computed by hashing (checkpoint || payload). We verify the head
  // row explicitly against the checkpoint, then walk the tail
  // pairwise — never mutating row data passed to the verifier.
  if (options.checkpointHash && chainRows.length > 0) {
    const head = chainRows[0]!;
    if (head.previousHash !== options.checkpointHash) {
      return {
        intact: false,
        checkedRows: rows.length,
        firstBrokenSequence: rows[0]!.sequence,
        verifiedAt: new Date().toISOString(),
      };
    }
    const expectedHead = hashChainNext(options.checkpointHash, head.payload);
    if (expectedHead !== head.entryHash) {
      return {
        intact: false,
        checkedRows: rows.length,
        firstBrokenSequence: rows[0]!.sequence,
        verifiedAt: new Date().toISOString(),
      };
    }
    // Walk the tail. Each row[i] must have previousHash == row[i-1].entryHash
    // and entryHash == hashChainNext(row[i-1].entryHash, row[i].payload).
    for (let i = 1; i < chainRows.length; i += 1) {
      const prev = chainRows[i - 1]!;
      const curr = chainRows[i]!;
      if (curr.previousHash !== prev.entryHash) {
        return {
          intact: false,
          checkedRows: rows.length,
          firstBrokenSequence: rows[i]!.sequence,
          verifiedAt: new Date().toISOString(),
        };
      }
      const expected = hashChainNext(prev.entryHash, curr.payload);
      if (expected !== curr.entryHash) {
        return {
          intact: false,
          checkedRows: rows.length,
          firstBrokenSequence: rows[i]!.sequence,
          verifiedAt: new Date().toISOString(),
        };
      }
    }
    return {
      intact: true,
      checkedRows: rows.length,
      firstBrokenSequence: null,
      verifiedAt: new Date().toISOString(),
    };
  }
  const broken = verifyHashChain(chainRows);
  return {
    intact: broken === null,
    checkedRows: rows.length,
    firstBrokenSequence: broken === null ? null : rows[broken]!.sequence,
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Look up the most recent entry_hash among rows that would be deleted
 * by a purge of `retentionDays`. Used by the retention service to
 * record a chain-checkpoint anchor before/after the actual delete.
 */
export async function findPurgeCheckpoint(
  ctx: TenantContext,
  retentionDays: number,
): Promise<{ hash: string; sequence: number } | null> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const rows = await db
    .select()
    .from(auditLogEntries)
    .where(and(tenantScope(ctx, auditLogEntries), lt(auditLogEntries.createdAt, cutoff)))
    .orderBy(desc(auditLogEntries.sequence))
    .limit(1);
  if (!rows[0]) return null;
  return { hash: rows[0].entryHash, sequence: rows[0].sequence };
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

/**
 * Count audit rows matching `actionType` (and optionally `actor`)
 * inside the trailing `windowSeconds` window. Used by the alert engine
 * to decide whether a rule's threshold has been exceeded.
 */
export async function countActionsInWindow(
  ctx: TenantContext,
  options: {
    actionType?: string | null;
    actor?: string | null;
    windowSeconds: number;
  },
): Promise<number> {
  const cutoff = Date.now() - options.windowSeconds * 1000;
  const conditions = [
    tenantScope(ctx, auditLogEntries),
    gte(auditLogEntries.createdAt, cutoff),
  ];
  if (options.actionType) {
    conditions.push(eq(auditLogEntries.actionType, options.actionType));
  }
  if (options.actor) {
    conditions.push(eq(auditLogEntries.actor, options.actor));
  }
  const [row] = await db
    .select({ n: drizzleCount() })
    .from(auditLogEntries)
    .where(and(...conditions));
  return Number(row?.n ?? 0);
}

/**
 * Purge audit entries older than `retentionDays`. Returns the number of
 * rows deleted. Callers append a self-recorded purge entry — that
 * append MUST happen AFTER this call returns so the purge event itself
 * is captured in the chain.
 *
 * Even though the audit log is "append-only" at the application layer,
 * this is the single sanctioned exception: deletion of rows older than
 * the configured retention window for compliance with data-minimisation
 * laws (GDPR Art. 5(1)(e)). The chain is rebuilt on next append by
 * pointing at the new tip; older entries are gone but their hashes
 * never re-appear.
 */
export async function purgeExpiredAuditEntries(
  ctx: TenantContext,
  retentionDays: number,
): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = await db
    .delete(auditLogEntries)
    .where(and(tenantScope(ctx, auditLogEntries), lt(auditLogEntries.createdAt, cutoff)));
  return (result as unknown as { changes?: number }).changes ?? 0;
}

export interface SignedAuditExport {
  readonly issuedAt: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly entryCount: number;
  readonly chainTipHash: string | null;
  readonly entries: ReadonlyArray<AuditEntryRow>;
  readonly signature: string;
  readonly signatureAlgo: "hmac-sha256";
}

/**
 * Build a signed JSON export of the filtered audit log.
 *
 * The signature is HMAC-SHA-256 over the canonical JSON of the export
 * (sans the signature field itself), keyed by `secret`. The recipient
 * verifies by recomputing the HMAC with the same shared secret —
 * provides authenticity for regulatory submissions and third-party
 * security reviews.
 */
export async function signAuditExport(
  ctx: TenantContext,
  options: AuditListInput & { secret: string; maxEntries?: number },
): Promise<SignedAuditExport> {
  const max = Math.min(Math.max(options.maxEntries ?? 5000, 1), 50000);
  const collected: AuditEntryRow[] = [];
  let cursor: string | null = options.cursor ?? null;
  while (collected.length < max) {
    const remaining = max - collected.length;
    const page: PaginatedData<AuditEntryRow> = await listAuditEntries(ctx, {
      ...options,
      limit: Math.min(remaining, 100),
      cursor,
    });
    collected.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const tip = collected[0]?.entryHash ?? null;
  const body = {
    issuedAt: new Date().toISOString(),
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId ?? "",
    entryCount: collected.length,
    chainTipHash: tip,
    entries: collected,
    signatureAlgo: "hmac-sha256" as const,
  };
  const signature = hmacSign(options.secret, JSON.stringify(body));
  return { ...body, signature };
}
