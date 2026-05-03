/**
 * `dr_storage_nodes` — registered storage nodes for the skill
 * distribution package CDN (Task #59 — Platform Disaster Recovery).
 *
 * Skill packages must be replicated across at least 3 storage nodes so a
 * single node failure does not affect downloads. This table records
 * each node's health and the most recent verification probe. The DR
 * service surfaces the count of healthy nodes; the alerting layer fires
 * when the healthy count drops below the configured minimum (default 3).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const drStorageNodes = sqliteTable(
  "dr_storage_nodes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    region: text("region").notNull().default("eu-west"),
    endpoint: text("endpoint").notNull(),
    status: text("status").notNull().default("healthy"),
    lastProbeAt: integer("last_probe_at"),
    storedPackages: integer("stored_packages").notNull().default(0),
    capacityBytes: integer("capacity_bytes").notNull().default(0),
    usedBytes: integer("used_bytes").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_dr_storage_nodes_tenant").on(t.tenantId),
    workspaceIdx: index("idx_dr_storage_nodes_workspace").on(t.workspaceId),
    statusIdx: index("idx_dr_storage_nodes_status").on(t.tenantId, t.status),
  }),
);

export type DrStorageNode = typeof drStorageNodes.$inferSelect;
export type NewDrStorageNode = typeof drStorageNodes.$inferInsert;
