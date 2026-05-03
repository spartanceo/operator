/**
 * `dr_alerts` — append-only ledger of DR monitor alerts (Task #59).
 *
 * Triggered by the DR monitor when:
 *   - replication lag exceeds the configured threshold (10s default),
 *   - a snapshot integrity verification fails,
 *   - a storage node transitions to `offline`,
 *   - the healthy storage-node count drops below the minimum,
 *   - a backup job fails.
 *
 * Each alert carries the source `kind`, the `severityTier`, and a free-
 * form `details` JSON blob with the contextual values that triggered it
 * (lag seconds, node id, etc). Acknowledged alerts retain their row;
 * resolution is recorded by setting `acknowledgedAt`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const drAlerts = sqliteTable(
  "dr_alerts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    kind: text("kind").notNull(),
    severityTier: text("severity_tier").notNull().default("P1"),
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    details: text("details"),
    incidentId: text("incident_id"),
    acknowledgedAt: integer("acknowledged_at"),
    acknowledgedBy: text("acknowledged_by"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_dr_alerts_tenant").on(t.tenantId),
    workspaceIdx: index("idx_dr_alerts_workspace").on(t.workspaceId),
    kindIdx: index("idx_dr_alerts_kind").on(t.tenantId, t.kind),
    createdIdx: index("idx_dr_alerts_created").on(t.tenantId, t.createdAt),
  }),
);

export type DrAlert = typeof drAlerts.$inferSelect;
export type NewDrAlert = typeof drAlerts.$inferInsert;
