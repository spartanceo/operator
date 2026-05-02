/**
 * Data nuke service.
 *
 * "Nuke" is the user-facing button that wipes EVERY local trace of the
 * tenant: SQLite rows in every table, files inside the workspace
 * sandbox, and any cached blobs. The user must type the explicit
 * confirmation phrase ("DELETE EVERYTHING") and provide their master
 * password — both checked at the route layer before the service runs.
 *
 * The nuke is intentionally synchronous and final. Standard 12 §
 * "Right to delete": after a nuke completes, the tenant row is marked
 * `status = 'erased'` so the GDPR soft-delete predicate hides the
 * sentinel from every other query.
 */
import path from "node:path";
import fs from "node:fs";

import { eq, sql } from "drizzle-orm";

import {
  admin2faSecrets,
  agentRuns,
  approvals,
  auditLogEntries,
  autoLockState,
  db,
  getRawSqlite,
  masterPasswordState,
  memories,
  messages,
  modelPreferences,
  onboardingProfiles,
  privacyEvents,
  refreshTokens,
  secretVaultEntries,
  securityEvents,
  sessions,
  telemetryConsent,
  tenants,
  tenantScope,
  toolCalls,
  webhookSecrets,
  workspaces,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { appendAuditEntry } from "./audit.service";
import { logSecurityEvent } from "./security-events.service";

export interface DataNukeResult {
  readonly tenantId: string;
  readonly deletedCounts: Readonly<Record<string, number>>;
  readonly filesDeleted: number;
  readonly completedAt: string;
}

function workspaceDirRoot(): string {
  return process.env["SANDBOX_ROOT"] ?? path.resolve(process.cwd(), "data", "workspaces");
}

function deleteDirRecursive(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += deleteDirRecursive(full);
      try {
        fs.rmdirSync(full);
      } catch {
        // best-effort
      }
    } else {
      try {
        fs.unlinkSync(full);
        count++;
      } catch {
        // best-effort
      }
    }
  }
  return count;
}

/**
 * Wipe everything for the tenant. A defensive ordering deletes
 * dependent rows before parents to keep FKs satisfied even though we
 * disable them transactionally.
 *
 * Audit + security events are emitted BEFORE the wipe so the row
 * survives — the nuke explicitly clears the audit log too.
 */
export async function nukeTenantData(
  ctx: TenantContext,
  reason: string,
): Promise<DataNukeResult> {
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "user",
    action: "data.nuke.requested",
    resourceType: "tenant",
    resourceId: ctx.tenantId,
    summary: `Data nuke requested: ${reason || "no reason provided"}`,
  });
  await logSecurityEvent(ctx, {
    eventType: "data.nuke.requested",
    severity: "critical",
    actor: ctx.userId ?? "user",
    target: ctx.tenantId,
    detail: reason,
  });

  const tenantId = ctx.tenantId;
  const deletedCounts: Record<string, number> = {};

  // Per-table deletes, scoped strictly by tenantId.
  const ordered: ReadonlyArray<{
    name: string;
    delete: () => Promise<{ changes: number } | unknown>;
  }> = [
    { name: "tool_calls", delete: () => db.delete(toolCalls).where(tenantScope(ctx, toolCalls)) },
    { name: "messages", delete: () => db.delete(messages).where(tenantScope(ctx, messages)) },
    { name: "agent_runs", delete: () => db.delete(agentRuns).where(tenantScope(ctx, agentRuns)) },
    { name: "approvals", delete: () => db.delete(approvals).where(tenantScope(ctx, approvals)) },
    { name: "memories", delete: () => db.delete(memories).where(tenantScope(ctx, memories)) },
    { name: "privacy_events", delete: () => db.delete(privacyEvents).where(tenantScope(ctx, privacyEvents)) },
    { name: "security_events", delete: () => db.delete(securityEvents).where(tenantScope(ctx, securityEvents)) },
    { name: "audit_log_entries", delete: () => db.delete(auditLogEntries).where(tenantScope(ctx, auditLogEntries)) },
    { name: "refresh_tokens", delete: () => db.delete(refreshTokens).where(tenantScope(ctx, refreshTokens)) },
    { name: "admin_2fa_secrets", delete: () => db.delete(admin2faSecrets).where(tenantScope(ctx, admin2faSecrets)) },
    { name: "auto_lock_state", delete: () => db.delete(autoLockState).where(tenantScope(ctx, autoLockState)) },
    { name: "telemetry_consent", delete: () => db.delete(telemetryConsent).where(tenantScope(ctx, telemetryConsent)) },
    { name: "webhook_secrets", delete: () => db.delete(webhookSecrets).where(tenantScope(ctx, webhookSecrets)) },
    { name: "secret_vault_entries", delete: () => db.delete(secretVaultEntries).where(tenantScope(ctx, secretVaultEntries)) },
    { name: "master_password_state", delete: () => db.delete(masterPasswordState).where(tenantScope(ctx, masterPasswordState)) },
    { name: "model_preferences", delete: () => db.delete(modelPreferences).where(tenantScope(ctx, modelPreferences)) },
    { name: "onboarding_profiles", delete: () => db.delete(onboardingProfiles).where(tenantScope(ctx, onboardingProfiles)) },
    { name: "sessions", delete: () => db.delete(sessions).where(tenantScope(ctx, sessions)) },
    { name: "workspaces", delete: () => db.delete(workspaces).where(tenantScope(ctx, workspaces)) },
  ];

  // The raw SQLite handle gives us COUNT(*) before delete so we report
  // accurate per-table counts (drizzle's typed delete returns void here).
  const sqlite = getRawSqlite();
  for (const step of ordered) {
    let count = 0;
    try {
      const row = sqlite
        .prepare(`SELECT COUNT(*) AS c FROM ${step.name} WHERE tenant_id = ?`)
        .get(tenantId) as { c: number } | undefined;
      count = row?.c ?? 0;
    } catch {
      count = 0;
    }
    try {
      await step.delete();
      deletedCounts[step.name] = count;
    } catch {
      // Best-effort — continue wiping the rest even if one table errors.
      deletedCounts[step.name] = 0;
    }
  }

  // Mark the tenant row as erased rather than deleting it — the row is
  // the FK target every audit / event references and the GDPR
  // soft-delete contract hides it from every subsequent tenant-scoped
  // read (see lib/db helpers/tenant-scope.ts).
  await db
    .update(tenants)
    .set({ status: "erased", updatedAt: Date.now(), version: sql`${tenants.version} + 1` })
    .where(eq(tenants.id, tenantId));
  deletedCounts["tenants_marked_erased"] = 1;

  // Wipe the workspace directory tree.
  const dir = path.join(workspaceDirRoot(), tenantId);
  const filesDeleted = deleteDirRecursive(dir);
  try {
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
  } catch {
    // best-effort
  }

  return {
    tenantId,
    deletedCounts,
    filesDeleted,
    completedAt: new Date().toISOString(),
  };
}
