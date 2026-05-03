/**
 * `dr_replicas` — registered hot-standby replicas for the platform DB
 * (Task #59 — Platform Disaster Recovery).
 *
 * One row per configured replication target. The DR service samples
 * replication lag every minute and writes the latest measurement here,
 * along with the most recent failover record. The `dataClass` column
 * gates the failover policy:
 *
 *   - `payouts` / `subscriptions` rows are flagged synchronous — the
 *     monitor alerts immediately if `replicationMode` slips off
 *     `synchronous`.
 *   - other classes default to asynchronous.
 *
 * The row is mutable (status + lag readings updated on every probe),
 * so it carries the standard `version` column for optimistic
 * concurrency under tier-review check #5.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const drReplicas = sqliteTable(
  "dr_replicas",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    region: text("region").notNull().default("primary"),
    availabilityZone: text("availability_zone").notNull().default("az-a"),
    role: text("role").notNull().default("standby"),
    replicationMode: text("replication_mode").notNull().default("asynchronous"),
    dataClass: text("data_class").notNull().default("standard"),
    status: text("status").notNull().default("healthy"),
    lastProbeAt: integer("last_probe_at"),
    lagSeconds: integer("lag_seconds").notNull().default(0),
    lastFailoverAt: integer("last_failover_at"),
    lastFailoverDurationMs: integer("last_failover_duration_ms"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_dr_replicas_tenant").on(t.tenantId),
    workspaceIdx: index("idx_dr_replicas_workspace").on(t.workspaceId),
    statusIdx: index("idx_dr_replicas_status").on(t.tenantId, t.status),
  }),
);

export type DrReplica = typeof drReplicas.$inferSelect;
export type NewDrReplica = typeof drReplicas.$inferInsert;
