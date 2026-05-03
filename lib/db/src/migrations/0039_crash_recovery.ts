/**
 * Migration 0039 — Crash Recovery & Mid-Task Resumption (Task #58).
 *
 * Adds two tables that back the recovery flow:
 *
 *   - task_checkpoints   : one row per executed step of a queued task.
 *                          Written BEFORE execution (`in_progress`) and
 *                          updated AFTER (`completed` / `failed`) so a
 *                          hard crash leaves the unfinished step
 *                          identifiable on next launch.
 *   - clean_shutdown_log : append-only log of every clean process
 *                          shutdown. The startup detector compares the
 *                          most recent shutdown timestamp against the
 *                          latest in-progress task to decide whether to
 *                          surface the recovery prompt.
 *
 * Also adds a `paused_at` column to `task_queue_entries` so the
 * shutdown handler can pause running tasks cleanly without inventing a
 * brand-new status — paused rows stay in `running` with `paused_at`
 * set, and the recovery prompt surfaces them as "paused due to
 * shutdown" rather than "abandoned by crash".
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS task_checkpoints (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    task_id TEXT NOT NULL,
    run_id TEXT,
    step_index INTEGER NOT NULL,
    step_kind TEXT NOT NULL,
    destructive INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'in_progress',
    summary TEXT,
    inputs TEXT,
    outputs TEXT,
    tool_calls TEXT,
    approvals TEXT,
    error TEXT,
    required_skill_ids TEXT,
    required_tool_names TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_task_checkpoints_tenant ON task_checkpoints(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_task_checkpoints_workspace ON task_checkpoints(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task ON task_checkpoints(tenant_id, task_id, step_index);
  CREATE INDEX IF NOT EXISTS idx_task_checkpoints_status ON task_checkpoints(tenant_id, status);

  CREATE TABLE IF NOT EXISTS clean_shutdown_log (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT '_global_',
    reason TEXT NOT NULL DEFAULT 'normal',
    paused_task_ids TEXT,
    pid INTEGER,
    shutdown_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_clean_shutdown_at ON clean_shutdown_log(shutdown_at);
  CREATE INDEX IF NOT EXISTS idx_clean_shutdown_tenant ON clean_shutdown_log(tenant_id);

  ALTER TABLE task_queue_entries ADD COLUMN paused_at INTEGER;
  ALTER TABLE task_queue_entries ADD COLUMN pause_reason TEXT;
`;

const down = `
  DROP TABLE IF EXISTS task_checkpoints;
  DROP TABLE IF EXISTS clean_shutdown_log;
`;

export const migration: SchemaMigration = {
  id: 39,
  name: "crash_recovery",
  up,
  down,
};
