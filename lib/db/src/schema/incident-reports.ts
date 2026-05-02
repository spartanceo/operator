/**
 * `incident_reports` — user-submitted reports of unexpected autonomous
 * behaviour. Required by the EU AI Act human-oversight clauses (Task #25).
 *
 * Mutable record — status transitions (submitted → triaged →
 * investigating → resolved → closed) update the original row, so the
 * `version` column is present for optimistic concurrency. The original
 * `title`, `description`, `category` and `severity` are treated as
 * immutable by the service layer, and history of status changes is
 * captured separately in the activity-events stream so the report
 * itself remains the single canonical record.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const incidentReports = sqliteTable(
  "incident_reports",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id"),
    category: text("category").notNull(),
    severity: text("severity").notNull().default("medium"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    relatedRunId: text("related_run_id"),
    relatedApprovalId: text("related_approval_id"),
    contactEmail: text("contact_email"),
    status: text("status").notNull().default("submitted"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_incident_reports_tenant").on(t.tenantId),
    workspaceIdx: index("idx_incident_reports_workspace").on(t.workspaceId),
    statusIdx: index("idx_incident_reports_status").on(t.tenantId, t.status),
    createdIdx: index("idx_incident_reports_created").on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);

export type IncidentReport = typeof incidentReports.$inferSelect;
export type NewIncidentReport = typeof incidentReports.$inferInsert;
