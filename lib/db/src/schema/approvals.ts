/**
 * `approvals` — human-in-the-loop gates for medium/high/critical tool calls.
 *
 * The orchestrator inserts a row when it pauses for confirmation and waits
 * (with a deadline) until the row's `decision` flips from `pending`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { agentRuns } from "./agent-runs";
import { tenants } from "./tenants";
import { toolCalls } from "./tool-calls";
import { workspaces } from "./workspaces";

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    runId: text("run_id").notNull().references(() => agentRuns.id),
    toolCallId: text("tool_call_id").notNull().references(() => toolCalls.id),
    reason: text("reason").notNull(),
    summary: text("summary").notNull(),
    decision: text("decision").notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: integer("decided_at"),
    note: text("note"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_approvals_tenant").on(t.tenantId),
    workspaceIdx: index("idx_approvals_workspace").on(t.workspaceId),
    runIdx: index("idx_approvals_run").on(t.runId),
    toolCallIdx: index("idx_approvals_tool_call").on(t.toolCallId),
    decisionIdx: index("idx_approvals_decision").on(t.tenantId, t.decision),
  }),
);

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
