/**
 * `dr_drills` — recorded results of monthly automated DR drills and
 * quarterly full-failover tests (Task #59 — Platform Disaster Recovery).
 *
 * One row per drill. The DR service spins up a shadow environment from
 * the most recent verified snapshot and runs the marketplace validation
 * suite (skills browsable, downloadable, subscription status correct).
 * Each check verdict is captured in the structured `checks` JSON blob;
 * `overallStatus` rolls up to `passed | failed | partial` for dashboard
 * consumption.
 *
 * `kind` is `monthly | quarterly_failover | manual`. The actual RTO
 * achieved by a quarterly failover drill is stored in `actualRtoMs` so
 * platform leadership can verify the 60-second target is being met.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const drDrills = sqliteTable(
  "dr_drills",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    kind: text("kind").notNull().default("monthly"),
    snapshotId: text("snapshot_id"),
    overallStatus: text("overall_status").notNull().default("pending"),
    checks: text("checks").notNull().default("[]"),
    actualRtoMs: integer("actual_rto_ms"),
    actualRpoSeconds: integer("actual_rpo_seconds"),
    startedAt: integer("started_at").notNull().default(sql`(unixepoch() * 1000)`),
    completedAt: integer("completed_at"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_dr_drills_tenant").on(t.tenantId),
    workspaceIdx: index("idx_dr_drills_workspace").on(t.workspaceId),
    kindIdx: index("idx_dr_drills_kind").on(t.tenantId, t.kind),
    createdIdx: index("idx_dr_drills_created").on(t.tenantId, t.createdAt),
  }),
);

export type DrDrill = typeof drDrills.$inferSelect;
export type NewDrDrill = typeof drDrills.$inferInsert;
