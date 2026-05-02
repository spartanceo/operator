/**
 * `mobile_notification_prefs` — per-workspace notification category opt-out
 * settings for the Mobile Companion PWA. Singleton row per workspace.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const mobileNotificationPrefs = sqliteTable(
  "mobile_notification_prefs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    taskCompleted: integer("task_completed").notNull().default(1),
    approvalNeeded: integer("approval_needed").notNull().default(1),
    taskFailed: integer("task_failed").notNull().default(1),
    longTaskProgress: integer("long_task_progress").notNull().default(1),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_mobile_prefs_tenant").on(t.tenantId),
    workspaceIdx: index("idx_mobile_prefs_workspace").on(t.tenantId, t.workspaceId),
  }),
);

export type MobileNotificationPrefs = typeof mobileNotificationPrefs.$inferSelect;
export type NewMobileNotificationPrefs = typeof mobileNotificationPrefs.$inferInsert;
