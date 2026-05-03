/**
 * `update_install_attempts` — per-tenant install state log (Task #48).
 *
 * Powers the post-update crash detector: the desktop shell inserts a row
 * with status `launch_pending` immediately before relaunching to apply
 * the update, then on next launch flips it to `launch_succeeded`. If a
 * subsequent launch finds a `launch_pending` row older than the rollback
 * window, the rollback service treats the update as bad and surfaces the
 * previous good version to the shell.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const updateInstallAttempts = sqliteTable(
  "update_install_attempts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    deviceId: text("device_id").notNull(),
    fromVersion: text("from_version"),
    toVersion: text("to_version").notNull(),
    channel: text("channel").notNull().default("stable"),
    platform: text("platform").notNull(),
    arch: text("arch").notNull().default("x64"),
    updateKind: text("update_kind").notNull().default("full"),
    status: text("status").notNull().default("downloading"),
    failureReason: text("failure_reason"),
    signatureVerified: integer("signature_verified").notNull().default(0),
    bytesDownloaded: integer("bytes_downloaded").notNull().default(0),
    startedAt: integer("started_at").notNull().default(sql`(unixepoch() * 1000)`),
    completedAt: integer("completed_at"),
    rolledBackAt: integer("rolled_back_at"),
    rolledBackToVersion: text("rolled_back_to_version"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_update_install_attempts_tenant").on(t.tenantId, t.startedAt),
    deviceIdx: index("idx_update_install_attempts_device").on(
      t.tenantId,
      t.deviceId,
      t.startedAt,
    ),
    statusIdx: index("idx_update_install_attempts_status").on(t.tenantId, t.status),
    workspaceIdx: index("idx_update_install_attempts_workspace").on(t.workspaceId),
  }),
);

export type UpdateInstallAttempt = typeof updateInstallAttempts.$inferSelect;
export type NewUpdateInstallAttempt = typeof updateInstallAttempts.$inferInsert;
