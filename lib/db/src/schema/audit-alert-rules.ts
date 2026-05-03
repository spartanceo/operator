/**
 * `audit_alert_rules` — admin-defined threshold rules over the audit log.
 *
 * Example: "alert me if any agent emits more than 50 file_op events in
 * 60 seconds". When the windowed count of matching audit entries crosses
 * the threshold, the alert engine appends a row to `audit_alerts` and
 * dispatches an in-app notification.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const auditAlertRules = sqliteTable(
  "audit_alert_rules",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    actionType: text("action_type"),
    actor: text("actor"),
    thresholdCount: integer("threshold_count").notNull().default(50),
    windowSeconds: integer("window_seconds").notNull().default(60),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastTriggeredAt: integer("last_triggered_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_audit_alert_rules_tenant").on(t.tenantId),
    workspaceIdx: index("idx_audit_alert_rules_workspace").on(t.workspaceId),
  }),
);

export type AuditAlertRule = typeof auditAlertRules.$inferSelect;
export type NewAuditAlertRule = typeof auditAlertRules.$inferInsert;
