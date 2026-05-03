/**
 * `service_status_components` — per-component health row for the in-app
 * status page (Task #34).
 *
 * Examples: `marketplace`, `sync`, `payments`, `update-server`. Mutable
 * record (status flips over time); `version` is required.
 *
 * Stored under the SYSTEM tenant — these are global platform services,
 * not per-tenant resources.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const serviceStatusComponents = sqliteTable(
  "service_status_components",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Stable component identifier — `marketplace`, `sync`, `payments`. */
    componentKey: text("component_key").notNull(),
    label: text("label").notNull(),
    /** operational | degraded | partial_outage | major_outage | maintenance */
    status: text("status").notNull().default("operational"),
    message: text("message").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_service_status_components_tenant").on(t.tenantId),
    workspaceIdx: index("idx_service_status_components_workspace").on(t.workspaceId),
    keyUnique: uniqueIndex("uq_service_status_components_key").on(t.componentKey),
  }),
);

export type ServiceStatusComponent = typeof serviceStatusComponents.$inferSelect;
export type NewServiceStatusComponent = typeof serviceStatusComponents.$inferInsert;
