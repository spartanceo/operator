/**
 * Audit-log retention configuration & purge (Task #53).
 *
 * Each tenant has a configurable retention window in days (default
 * 365). The purge call:
 *   1. Reads the retention setting (creating it on first access).
 *   2. Deletes rows older than the window via the audit service.
 *   3. Updates the settings row with `lastPurgeAt` + `lastPurgeCount`.
 *   4. Appends a self-recorded purge audit entry so the chain captures
 *      the retention event itself ("the auditor is audited").
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  auditRetentionSettings,
  db,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { runWithTenantContext } from "../lib/tenant-context";

import {
  appendAuditEntry,
  findPurgeCheckpoint,
  purgeExpiredAuditEntries,
} from "./audit.service";

export interface AuditRetentionRow {
  readonly id: string;
  readonly retentionDays: number;
  readonly lastPurgeAt: string | null;
  readonly lastPurgeCount: number;
  readonly chainCheckpointHash: string | null;
  readonly chainCheckpointSequence: number | null;
  readonly updatedAt: string;
}

const DEFAULT_RETENTION_DAYS = 365;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3650;

function toRow(r: typeof auditRetentionSettings.$inferSelect): AuditRetentionRow {
  return {
    id: r.id,
    retentionDays: r.retentionDays,
    lastPurgeAt: r.lastPurgeAt ? new Date(r.lastPurgeAt).toISOString() : null,
    lastPurgeCount: r.lastPurgeCount,
    chainCheckpointHash: r.chainCheckpointHash ?? null,
    chainCheckpointSequence: r.chainCheckpointSequence ?? null,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function getOrCreateRetention(
  ctx: TenantContext,
): Promise<AuditRetentionRow> {
  const rows = await db
    .select()
    .from(auditRetentionSettings)
    .where(tenantScope(ctx, auditRetentionSettings))
    .limit(1);
  if (rows[0]) return toRow(rows[0]);
  const id = `art_${nanoid()}`;
  const now = Date.now();
  await db.insert(auditRetentionSettings).values(
    withTenantValues(ctx, {
      id,
      retentionDays: DEFAULT_RETENTION_DAYS,
      lastPurgeAt: null,
      lastPurgeCount: 0,
      chainCheckpointHash: null,
      chainCheckpointSequence: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }),
  );
  const fresh = await db
    .select()
    .from(auditRetentionSettings)
    .where(and(tenantScope(ctx, auditRetentionSettings), eq(auditRetentionSettings.id, id)))
    .limit(1);
  return toRow(fresh[0]!);
}

export async function setRetention(
  ctx: TenantContext,
  actor: string,
  retentionDays: number,
): Promise<AuditRetentionRow> {
  const clamped = Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, retentionDays));
  const current = await getOrCreateRetention(ctx);
  const now = Date.now();
  await db
    .update(auditRetentionSettings)
    .set({ retentionDays: clamped, updatedAt: now, version: 1 })
    .where(and(tenantScope(ctx, auditRetentionSettings), eq(auditRetentionSettings.id, current.id)));
  await appendAuditEntry(ctx, {
    actor,
    action: "audit_retention.update",
    actionType: "compliance",
    resourceType: "audit_retention_settings",
    resourceId: current.id,
    summary: `Audit retention window set to ${clamped} days (was ${current.retentionDays})`,
  });
  return { ...current, retentionDays: clamped, updatedAt: new Date(now).toISOString() };
}

export interface PurgeResult {
  readonly purgedCount: number;
  readonly retentionDays: number;
  readonly purgedAt: string;
}

/**
 * Purge audit rows older than the configured retention window.
 *
 * Tamper-evidence is preserved across the purge by snapshotting the
 * entry_hash of the most-recent row that *will* be deleted into
 * `chain_checkpoint_hash`. After the delete, the new earliest
 * surviving row's `previous_hash` still equals this checkpoint, so
 * `verifyAuditChain` can resume verification from a known-good
 * anchor (segmented-chain design).
 *
 * The purge itself is then recorded as a fresh audit entry so the
 * chain captures it ("the auditor is audited").
 */
export async function purgeAuditLog(
  ctx: TenantContext,
  actor: string,
): Promise<PurgeResult> {
  const settings = await getOrCreateRetention(ctx);
  const checkpoint = await findPurgeCheckpoint(ctx, settings.retentionDays);
  const purgedCount = await purgeExpiredAuditEntries(ctx, settings.retentionDays);
  const now = Date.now();
  await db
    .update(auditRetentionSettings)
    .set({
      lastPurgeAt: now,
      lastPurgeCount: purgedCount,
      chainCheckpointHash: checkpoint?.hash ?? settings.chainCheckpointHash,
      chainCheckpointSequence: checkpoint?.sequence ?? settings.chainCheckpointSequence,
      updatedAt: now,
    })
    .where(and(tenantScope(ctx, auditRetentionSettings), eq(auditRetentionSettings.id, settings.id)));
  await appendAuditEntry(ctx, {
    actor,
    action: "audit_log.purge",
    actionType: "compliance",
    resourceType: "audit_log_entries",
    resourceId: null,
    summary: `Purged ${purgedCount} audit row(s) older than ${settings.retentionDays} days`,
  });
  return {
    purgedCount,
    retentionDays: settings.retentionDays,
    purgedAt: new Date(now).toISOString(),
  };
}

export interface SchedulerTickResult {
  readonly tenantsScanned: number;
  readonly tenantsPurged: number;
  readonly totalPurgedCount: number;
  readonly errors: number;
  readonly tickedAt: string;
}

/**
 * Daily scheduler driver — walks every tenant that has a configured
 * retention policy and runs a purge inside that tenant's context. Each
 * purge is an independent operation; one tenant's failure never aborts
 * the others. Designed to be invoked by the application's existing
 * cron/scheduler (or by the test runner) and is itself idempotent.
 */
export async function runRetentionPurgeForAllTenants(): Promise<SchedulerTickResult> {
  const all = await db.select().from(auditRetentionSettings);
  let tenantsPurged = 0;
  let totalPurgedCount = 0;
  let errors = 0;
  for (const row of all) {
    const ctx: TenantContext = {
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      requestId: `scheduler_${nanoid()}`,
    };
    try {
      const result = await runWithTenantContext(ctx, () =>
        purgeAuditLog(ctx, "system_scheduler"),
      );
      if (result.purgedCount > 0) tenantsPurged += 1;
      totalPurgedCount += result.purgedCount;
    } catch (e) {
      errors += 1;
      logger.warn(
        { err: e, tenantId: row.tenantId },
        "scheduled audit purge failed for tenant",
      );
    }
  }
  return {
    tenantsScanned: all.length,
    tenantsPurged,
    totalPurgedCount,
    errors,
    tickedAt: new Date().toISOString(),
  };
}
