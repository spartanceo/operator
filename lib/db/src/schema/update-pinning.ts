/**
 * `update_pinning` — per-tenant version pin and auto-update opt-out
 * (Task #48). Enterprise admins use this row to freeze a fleet on a
 * specific version while a regression is investigated.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const updatePinning = sqliteTable(
  "update_pinning",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    pinnedVersion: text("pinned_version"),
    pinnedChannel: text("pinned_channel"),
    autoUpdateEnabled: integer("auto_update_enabled").notNull().default(1),
    managedBy: text("managed_by").notNull().default("user"),
    managedByUserId: text("managed_by_user_id"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantUnique: uniqueIndex("idx_update_pinning_tenant_unique").on(t.tenantId),
  }),
);

export type UpdatePinning = typeof updatePinning.$inferSelect;
export type NewUpdatePinning = typeof updatePinning.$inferInsert;
