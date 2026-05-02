/**
 * `tool_calls` — one row per tool invocation inside an agent run.
 *
 * Status walks through `pending → running → completed | failed | denied`.
 * `riskLevel` is the canonical low/medium/high/critical taxonomy from the
 * project context; high+ requires a human approval before `running` begins.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { agentRuns } from "./agent-runs";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    runId: text("run_id").notNull().references(() => agentRuns.id),
    toolName: text("tool_name").notNull(),
    riskLevel: text("risk_level").notNull().default("low"),
    status: text("status").notNull().default("pending"),
    input: text("input").notNull(),
    output: text("output"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_tool_calls_tenant").on(t.tenantId),
    workspaceIdx: index("idx_tool_calls_workspace").on(t.workspaceId),
    runIdx: index("idx_tool_calls_run").on(t.runId),
    statusIdx: index("idx_tool_calls_status").on(t.tenantId, t.status),
  }),
);

export type ToolCall = typeof toolCalls.$inferSelect;
export type NewToolCall = typeof toolCalls.$inferInsert;
