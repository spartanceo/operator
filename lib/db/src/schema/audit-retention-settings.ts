/**
 * `audit_retention_settings` — per-tenant audit-log retention configuration.
 *
 * One row per tenant (uniqueness enforced by index in migration 0039).
 * `retentionDays` controls automatic purge of audit entries older than
 * the window; default is 365 days. Each successful purge stamps
 * `lastPurgeAt` and `lastPurgeCount` so admins can audit the auditor.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const auditRetentionSettings = sqliteTable(
  "audit_retention_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    retentionDays: integer("retention_days").notNull().default(365),
    lastPurgeAt: integer("last_purge_at"),
    lastPurgeCount: integer("last_purge_count").notNull().default(0),
    // Hash of the most recent purged entry — anchors chain verification
    // after retention purges so the surviving rows still form a single
    // verifiable chain (segmented-chain design).
    chainCheckpointHash: text("chain_checkpoint_hash"),
    chainCheckpointSequence: integer("chain_checkpoint_sequence"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_audit_retention_settings_tenant").on(t.tenantId),
    workspaceIdx: index("idx_audit_retention_settings_workspace").on(t.workspaceId),
  }),
);

export type AuditRetentionSetting = typeof auditRetentionSettings.$inferSelect;
export type NewAuditRetentionSetting = typeof auditRetentionSettings.$inferInsert;
