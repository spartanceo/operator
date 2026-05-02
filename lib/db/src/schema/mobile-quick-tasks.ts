/**
 * `mobile_quick_tasks` — tasks dictated from the Mobile Companion PWA that
 * are queued for the desktop OP to pick up on its next poll.
 *
 * Lifecycle: `pending` → `delivered` (desktop ack'd) → optional terminal
 * `cancelled` if the user revokes from the PWA.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { pairedDevices } from "./paired-devices";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const mobileQuickTasks = sqliteTable(
  "mobile_quick_tasks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    deviceId: text("device_id").notNull().references(() => pairedDevices.id),
    body: text("body").notNull(),
    /** "pending" | "delivered" | "cancelled". */
    status: text("status").notNull().default("pending"),
    deliveredAt: integer("delivered_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_mobile_quick_tasks_tenant").on(t.tenantId),
    workspaceIdx: index("idx_mobile_quick_tasks_workspace").on(t.workspaceId),
    statusIdx: index("idx_mobile_quick_tasks_status").on(t.tenantId, t.status),
    deviceIdx: index("idx_mobile_quick_tasks_device").on(t.deviceId),
  }),
);

export type MobileQuickTask = typeof mobileQuickTasks.$inferSelect;
export type NewMobileQuickTask = typeof mobileQuickTasks.$inferInsert;
