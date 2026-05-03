/**
 * `audit_alerts` — append-only ledger of triggered audit-alert-rule firings.
 *
 * Append-only by design (the table name contains "alert" / "audit", and
 * the audit-alerts service exposes no UPDATE or DELETE). Each row records
 * what rule fired, how many matching events occurred, the threshold and
 * window that were exceeded, and a human-readable summary for the
 * notification stream.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { auditAlertRules } from "./audit-alert-rules";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const auditAlerts = sqliteTable(
  "audit_alerts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    ruleId: text("rule_id").notNull().references(() => auditAlertRules.id),
    ruleName: text("rule_name").notNull(),
    triggeredCount: integer("triggered_count").notNull(),
    thresholdCount: integer("threshold_count").notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    summary: text("summary").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_audit_alerts_tenant").on(t.tenantId),
    workspaceIdx: index("idx_audit_alerts_workspace").on(t.workspaceId),
    ruleIdx: index("idx_audit_alerts_rule").on(t.ruleId),
    createdIdx: index("idx_audit_alerts_created").on(t.tenantId, t.createdAt),
  }),
);

export type AuditAlert = typeof auditAlerts.$inferSelect;
export type NewAuditAlert = typeof auditAlerts.$inferInsert;
