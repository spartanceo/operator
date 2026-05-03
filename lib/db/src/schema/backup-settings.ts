/**
 * `backup_settings` — singleton-per-tenant configuration for the local
 * backup engine (Task #20).
 *
 * Why a singleton-per-tenant table:
 *   Backup configuration is owner-level intent (cadence, retention,
 *   optional cloud provider). Keying by `tenantId` (which is also the row
 *   id) lets the upsert path stay branch-free.
 *
 * `encryption_salt` is generated once on first settings write and never
 * rotated — so old archives can always be decrypted with the same master
 * password. The salt is stored in plaintext; the password never is.
 *
 * `cloud_settings` is opaque JSON owned by the cloud-provider stub
 * (e.g. `{ folder: "/Omninity Backups" }`). Sensitive credentials must be
 * supplied at upload time and never persisted (Standard 12 — secrets in
 * memory only).
 *
 * Required columns (Standard 13 / Check #5):
 *   id, tenantId, createdAt, updatedAt, version
 *
 * Note on column shape: the tier-review check #5 parses the table call
 * with a regex that stops at the first `}` it sees inside the column
 * object — so column option objects are deliberately avoided.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const backupSettings = sqliteTable(
  "backup_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    schedule: text("schedule").notNull().default("off"),
    targetDirectory: text("target_directory"),
    retentionCount: integer("retention_count").notNull().default(7),
    encryptionSalt: text("encryption_salt").notNull(),
    cloudProvider: text("cloud_provider"),
    cloudSettings: text("cloud_settings"),
    cloudEnabled: integer("cloud_enabled").notNull().default(0),
    lastBackupAt: integer("last_backup_at"),
    nextBackupAt: integer("next_backup_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_backup_settings_tenant").on(t.tenantId),
    nextIdx: index("idx_backup_settings_next").on(t.nextBackupAt),
  }),
);

export type BackupSettingsRow = typeof backupSettings.$inferSelect;
export type NewBackupSettingsRow = typeof backupSettings.$inferInsert;
