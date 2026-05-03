/**
 * `orchestration_nodes` — one row per node in a multi-agent DAG (Task #50).
 *
 * Each node is dispatched to a specialised agent (research / writing /
 * code / desktop / data / communication). Dependency edges are stored
 * inline in `dependsOn` (JSON array of node keys) so the table stays
 * narrow and queries don't need a separate edges table.
 *
 * Inputs / outputs are stored as JSON so downstream nodes receive
 * structured, typed payloads rather than free-form text — the contract
 * the orchestrator's "inter-agent communication" requirement depends on.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { agentOrchestrations } from "./agent-orchestrations";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const orchestrationNodes = sqliteTable(
  "orchestration_nodes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orchestrationId: text("orchestration_id")
      .notNull()
      .references(() => agentOrchestrations.id),
    nodeKey: text("node_key").notNull(),
    agentType: text("agent_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    dependsOn: text("depends_on").notNull().default("[]"),
    input: text("input"),
    output: text("output"),
    status: text("status").notNull().default("pending"),
    riskLevel: text("risk_level").notNull().default("low"),
    requiresApproval: integer("requires_approval").notNull().default(0),
    approvalId: text("approval_id"),
    approvalDecision: text("approval_decision"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_orch_node_tenant").on(t.tenantId),
    workspaceIdx: index("idx_orch_node_workspace").on(t.workspaceId),
    orchIdx: index("idx_orch_node_orch").on(t.orchestrationId),
    statusIdx: index("idx_orch_node_status").on(t.tenantId, t.status),
  }),
);

export type OrchestrationNode = typeof orchestrationNodes.$inferSelect;
export type NewOrchestrationNode = typeof orchestrationNodes.$inferInsert;
