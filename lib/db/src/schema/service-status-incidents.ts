/**
 * `service_status_incidents` — published incident timeline entries
 * shown on the in-app status page.
 *
 * Mutable (incidents are updated through `investigating →
 * identified → monitoring → resolved`), so `version` is required.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const serviceStatusIncidents = sqliteTable(
  "service_status_incidents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** investigating | identified | monitoring | resolved */
    status: text("status").notNull().default("investigating"),
    /** none | minor | major | critical */
    severity: text("severity").notNull().default("minor"),
    /** Comma-separated list of affected component_key values. */
    affectedComponents: text("affected_components").notNull().default(""),
    startedAt: integer("started_at").notNull().default(sql`(unixepoch() * 1000)`),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_service_status_incidents_tenant").on(t.tenantId),
    workspaceIdx: index("idx_service_status_incidents_workspace").on(t.workspaceId),
    statusIdx: index("idx_service_status_incidents_status").on(t.status),
    startedIdx: index("idx_service_status_incidents_started").on(t.startedAt),
  }),
);

export type ServiceStatusIncident = typeof serviceStatusIncidents.$inferSelect;
export type NewServiceStatusIncident = typeof serviceStatusIncidents.$inferInsert;
