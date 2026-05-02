/**
 * `activity_events` — chronological feed of everything OP did.
 *
 * Distinct from `audit_log_entries` (which is hash-chained, append-only,
 * security-grade) — this table is the user-facing activity centre feed:
 * goals attempted, skills run, tools called, approvals decided, with the
 * outcome and full metadata for an expandable detail drawer.
 *
 * Append-only at the application layer (the activity service exposes no
 * UPDATE/DELETE). The schema therefore omits the `version` column —
 * mutation is forbidden by contract, mirroring `audit_log_entries`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    agent: text("agent"),
    skillName: text("skill_name"),
    runId: text("run_id"),
    toolCallId: text("tool_call_id"),
    approvalId: text("approval_id"),
    summary: text("summary").notNull(),
    outcome: text("outcome").notNull().default("success"),
    durationMs: integer("duration_ms"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_activity_events_tenant").on(t.tenantId),
    workspaceIdx: index("idx_activity_events_workspace").on(t.workspaceId),
    createdIdx: index("idx_activity_events_created").on(t.tenantId, t.createdAt),
    typeIdx: index("idx_activity_events_type").on(t.tenantId, t.eventType),
    agentIdx: index("idx_activity_events_agent").on(t.tenantId, t.agent),
    runIdx: index("idx_activity_events_run").on(t.tenantId, t.runId),
  }),
);

export type ActivityEvent = typeof activityEvents.$inferSelect;
export type NewActivityEvent = typeof activityEvents.$inferInsert;
