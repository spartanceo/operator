/**
 * `backup_jobs` — append-only history of every backup the engine has
 * produced (Task #20).
 *
 * Status walks `pending → running → completed | failed`. After verification
 * the row is read-only — restores never mutate the source job, they
 * append a new `restore` row instead so the audit trail is intact.
 *
 * `checksum` is the sha256 of the encrypted archive bytes — the same value
 * the integrity check recomputes after a write to detect on-disk corruption
 * and the value the cloud sync stub stores alongside the upload so a later
 * download can be verified before decryption is even attempted.
 *
 * `trigger` is `manual | scheduled | cloud` — the scheduler service uses
 * this to enforce per-tenant retention limits independently for manual vs
 * automatic backups (so a flurry of manual exports cannot evict the
 * scheduled history).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const backupJobs = sqliteTable(
  "backup_jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    trigger: text("trigger").notNull().default("manual"),
    status: text("status").notNull().default("pending"),
    encryption: text("encryption").notNull().default("aes-256-gcm"),
    filePath: text("file_path"),
    cloudTarget: text("cloud_target"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    checksum: text("checksum"),
    documentCount: integer("document_count").notNull().default(0),
    memoryCount: integer("memory_count").notNull().default(0),
    messageCount: integer("message_count").notNull().default(0),
    snapshotVersion: text("snapshot_version").notNull().default("1"),
    schemaVersion: integer("schema_version").notNull().default(1),
    error: text("error"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_backup_jobs_tenant").on(t.tenantId),
    workspaceIdx: index("idx_backup_jobs_workspace").on(t.workspaceId),
    statusIdx: index("idx_backup_jobs_status").on(t.tenantId, t.status),
    createdIdx: index("idx_backup_jobs_created").on(t.tenantId, t.createdAt),
  }),
);

export type BackupJobRow = typeof backupJobs.$inferSelect;
export type NewBackupJobRow = typeof backupJobs.$inferInsert;
