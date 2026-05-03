/**
 * Migration 0014 — multi-task queue & concurrent task management (Task #38).
 *
 * Adds a single table that backs the task queue UI:
 *
 *  - task_queue_entries : append-and-update queue of user-submitted tasks.
 *                         Each row stores the queued goal + agent params,
 *                         a priority (high/normal/low), a status
 *                         (queued/running/completed/failed/cancelled/stale),
 *                         the optional context snapshot (JSON) used to
 *                         flag stale entries before execution, and the
 *                         resulting agent_runs.id once the queue runner
 *                         drains the entry through createAgentRun().
 *
 * The queue is in-process — there is no distributed worker — but the
 * persisted state survives restarts so a queued entry that didn't get a
 * chance to run before the crash can be picked up again next launch.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS task_queue_entries (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    goal TEXT NOT NULL,
    model_name TEXT,
    use_knowledge_base INTEGER NOT NULL DEFAULT 1,
    knowledge_collection_id TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'queued',
    run_id TEXT,
    context_snapshot TEXT,
    stale_reason TEXT,
    error TEXT,
    summary TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_task_queue_tenant ON task_queue_entries(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_task_queue_workspace ON task_queue_entries(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue_entries(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_task_queue_created ON task_queue_entries(tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_task_queue_priority ON task_queue_entries(tenant_id, status, priority, created_at);
`;

const down = `
  DROP TABLE IF EXISTS task_queue_entries;
`;

export const migration: SchemaMigration = {
  id: 18,
  name: "task_queue",
  up,
  down,
};
