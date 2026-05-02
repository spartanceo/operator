/**
 * `security_events` — append-only log of authentication failures, blocked
 * skill actions, suspicious tool calls, rate-limit hits, and any other
 * security-relevant signal. Distinct from `privacy_events` (which records
 * data egress) and from `audit_log_entries` (which is hash-chained for
 * tamper detection).
 *
 * Append-only — the tier-review check exempts table names containing
 * "event" / "log" from the version requirement.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const securityEvents = sqliteTable(
  "security_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    eventType: text("event_type").notNull(),
    severity: text("severity").notNull().default("info"),
    actor: text("actor").notNull(),
    target: text("target"),
    sourceIp: text("source_ip"),
    detail: text("detail"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_security_events_tenant").on(t.tenantId),
    workspaceIdx: index("idx_security_events_workspace").on(t.workspaceId),
    typeIdx: index("idx_security_events_type").on(t.tenantId, t.eventType),
    severityIdx: index("idx_security_events_severity").on(t.tenantId, t.severity),
    createdIdx: index("idx_security_events_created").on(t.tenantId, t.createdAt),
  }),
);

export type SecurityEvent = typeof securityEvents.$inferSelect;
export type NewSecurityEvent = typeof securityEvents.$inferInsert;
