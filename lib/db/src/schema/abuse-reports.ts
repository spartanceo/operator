/**
 * `abuse_reports` — flagged skills/users awaiting moderator review.
 *
 * Mutation-light table; status walks `open → resolved | dismissed`.
 * Used by the Super Admin abuse-monitoring view to triage suspicious
 * activity without exposing individual user actions (the privacy
 * promise only summary `target_label` + `reason` is stored).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const abuseReports = sqliteTable(
  "abuse_reports",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** skill | user | review | other */
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    targetLabel: text("target_label").notNull().default(""),
    reason: text("reason").notNull(),
    /** low | medium | high | critical */
    severity: text("severity").notNull().default("medium"),
    /** open | resolved | dismissed */
    status: text("status").notNull().default("open"),
    reporterLabel: text("reporter_label").notNull().default("system"),
    resolutionNotes: text("resolution_notes").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_abuse_reports_tenant").on(t.tenantId),
    workspaceIdx: index("idx_abuse_reports_workspace").on(t.workspaceId),
    statusIdx: index("idx_abuse_reports_status").on(t.status),
    targetIdx: index("idx_abuse_reports_target").on(t.targetType, t.targetId),
  }),
);

export type AbuseReport = typeof abuseReports.$inferSelect;
export type NewAbuseReport = typeof abuseReports.$inferInsert;
