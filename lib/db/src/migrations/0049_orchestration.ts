/**
 * Migration 0048 — multi-agent orchestration engine (Task #50).
 *
 * Adds two tables:
 *
 *  - agent_orchestrations  : one row per orchestrated user goal. Tracks
 *                            the lifecycle of the DAG (status, depth,
 *                            parent for nested orchestrations, summary).
 *  - orchestration_nodes   : one row per node in the DAG. Each node is a
 *                            sub-task assigned to a specialised agent
 *                            (research / writing / code / desktop / data /
 *                            communication). Stores the dependency list
 *                            (`depends_on` JSON), structured input /
 *                            output payloads, risk level, attempt count,
 *                            approval gate state, and timing.
 *
 * The DAG is in-process — there is no distributed worker. State is
 * persisted so a restart leaves a queryable trace; a hard crash leaves
 * any in-flight nodes in `running` and the route surface lets the user
 * cancel or restart the orchestration from the timeline.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS agent_orchestrations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    parent_orchestration_id TEXT,
    conversation_id TEXT,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    depth INTEGER NOT NULL DEFAULT 0,
    node_count INTEGER NOT NULL DEFAULT 0,
    completed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    plan TEXT,
    summary TEXT,
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_agent_orch_tenant ON agent_orchestrations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_agent_orch_workspace ON agent_orchestrations(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_agent_orch_status ON agent_orchestrations(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_agent_orch_parent ON agent_orchestrations(parent_orchestration_id);
  CREATE INDEX IF NOT EXISTS idx_agent_orch_created ON agent_orchestrations(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS orchestration_nodes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    orchestration_id TEXT NOT NULL REFERENCES agent_orchestrations(id),
    node_key TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    depends_on TEXT NOT NULL DEFAULT '[]',
    input TEXT,
    output TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    risk_level TEXT NOT NULL DEFAULT 'low',
    requires_approval INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    approval_decision TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_orch_node_tenant ON orchestration_nodes(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_orch_node_workspace ON orchestration_nodes(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_orch_node_orch ON orchestration_nodes(orchestration_id);
  CREATE INDEX IF NOT EXISTS idx_orch_node_status ON orchestration_nodes(tenant_id, status);
`;

const down = `
  DROP TABLE IF EXISTS orchestration_nodes;
  DROP TABLE IF EXISTS agent_orchestrations;
`;

export const migration: SchemaMigration = {
  id: 49,
  name: "orchestration",
  up,
  down,
};
