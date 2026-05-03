/**
 * `dr_incidents` — platform-side incident records with severity tier,
 * runbook reference, response timeline and structured post-incident
 * report (Task #59 — Platform Disaster Recovery).
 *
 * Distinct from `incident_reports` (which tracks user-submitted reports
 * of unexpected agent behaviour for the EU AI Act). DR incidents are
 * platform-team-owned: replication failures, storage node outages,
 * snapshot integrity failures, region outages.
 *
 * The post-incident report fields (`timeline`, `impact`, `rootCause`,
 * `remediation`) are required for any P0 or P1 once the incident
 * transitions to `resolved`. The DR service refuses to close such an
 * incident until those fields are populated.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const drIncidents = sqliteTable(
  "dr_incidents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    severityTier: text("severity_tier").notNull().default("P2"),
    scenario: text("scenario").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    runbookId: text("runbook_id"),
    status: text("status").notNull().default("open"),
    detectedAt: integer("detected_at").notNull().default(sql`(unixepoch() * 1000)`),
    acknowledgedAt: integer("acknowledged_at"),
    resolvedAt: integer("resolved_at"),
    timeline: text("timeline"),
    impact: text("impact"),
    rootCause: text("root_cause"),
    remediation: text("remediation"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_dr_incidents_tenant").on(t.tenantId),
    workspaceIdx: index("idx_dr_incidents_workspace").on(t.workspaceId),
    statusIdx: index("idx_dr_incidents_status").on(t.tenantId, t.status),
    severityIdx: index("idx_dr_incidents_severity").on(t.tenantId, t.severityTier),
  }),
);

export type DrIncident = typeof drIncidents.$inferSelect;
export type NewDrIncident = typeof drIncidents.$inferInsert;
