/**
 * `agent_runs` — one row per Operator task / pipeline execution.
 *
 * Captures the full lifecycle: which agent kicked off, the user goal, the
 * planner output, intermediate state, and the verifier verdict at the end.
 * The `status` field is the canonical state-machine value; transitions are
 * append-only via `tool_calls` and `messages`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    goal: text("goal").notNull(),
    status: text("status").notNull().default("queued"),
    plan: text("plan"),
    summary: text("summary"),
    error: text("error"),
    modelName: text("model_name"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_agent_runs_tenant").on(t.tenantId),
    workspaceIdx: index("idx_agent_runs_workspace").on(t.workspaceId),
    statusIdx: index("idx_agent_runs_status").on(t.tenantId, t.status),
  }),
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
