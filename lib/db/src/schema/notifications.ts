/**
 * `notifications` — in-app notification centre records.
 *
 * Every notification belongs to a tenant + workspace and is fanned out to
 * a category (task, approval, skill, error, system) so users can silence
 * categories independently via `notification_preferences`. The Electron
 * main process also reads this table to dispatch native OS notifications
 * (Mac/Windows) when the app is backgrounded.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    category: text("category").notNull(),
    severity: text("severity").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    actionLabel: text("action_label"),
    actionHref: text("action_href"),
    relatedRunId: text("related_run_id"),
    relatedApprovalId: text("related_approval_id"),
    readAt: integer("read_at"),
    dispatchedToOs: integer("dispatched_to_os").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_notifications_tenant").on(t.tenantId),
    workspaceIdx: index("idx_notifications_workspace").on(t.workspaceId),
    createdIdx: index("idx_notifications_created").on(t.tenantId, t.createdAt),
    unreadIdx: index("idx_notifications_unread").on(t.tenantId, t.readAt),
    categoryIdx: index("idx_notifications_category").on(t.tenantId, t.category),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

/**
 * `notification_preferences` — per-tenant per-category opt-in matrix.
 *
 * Stored as a singleton row keyed by tenant; the row carries a JSON blob of
 * `{ category: { inApp, os } }`. Defaults are baked into the service layer
 * so a missing row is equivalent to "all categories on".
 */
export const notificationPreferences = sqliteTable(
  "notification_preferences",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    preferences: text("preferences").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_notification_prefs_tenant").on(t.tenantId),
    workspaceIdx: index("idx_notification_prefs_workspace").on(t.workspaceId),
  }),
);

export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreferenceRow = typeof notificationPreferences.$inferInsert;
