/**
 * `agent_orchestrations` — one row per multi-agent DAG execution (Task #50).
 *
 * Decomposes a user goal into a directed acyclic graph of sub-tasks
 * (`orchestration_nodes`) and tracks the lifecycle of the whole graph.
 * `parentOrchestrationId` links nested orchestrations so a four-level
 * cap can be enforced (`depth` is reset to 0 at the top, +1 per nesting).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { conversations } from "./conversations";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const agentOrchestrations = sqliteTable(
  "agent_orchestrations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    parentOrchestrationId: text("parent_orchestration_id"),
    conversationId: text("conversation_id").references(() => conversations.id),
    goal: text("goal").notNull(),
    status: text("status").notNull().default("pending"),
    depth: integer("depth").notNull().default(0),
    nodeCount: integer("node_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    plan: text("plan"),
    summary: text("summary"),
    error: text("error"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_agent_orch_tenant").on(t.tenantId),
    workspaceIdx: index("idx_agent_orch_workspace").on(t.workspaceId),
    statusIdx: index("idx_agent_orch_status").on(t.tenantId, t.status),
    parentIdx: index("idx_agent_orch_parent").on(t.parentOrchestrationId),
    createdIdx: index("idx_agent_orch_created").on(t.tenantId, t.createdAt),
  }),
);

export type AgentOrchestration = typeof agentOrchestrations.$inferSelect;
export type NewAgentOrchestration = typeof agentOrchestrations.$inferInsert;
