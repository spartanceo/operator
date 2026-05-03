/**
 * Migration 0020 — scheduled & recurring tasks (Task #45).
 *
 * Adds three tables:
 *   - `scheduled_tasks`       — user-defined cron schedules.
 *   - `scheduled_task_runs`   — execution history (newest 10 per schedule).
 *   - `schedule_settings`     — per-tenant controls (global pause).
 *
 * The scheduler engine in `schedules.service.ts` reads `next_run_at`
 * on each tick and writes a `scheduled_task_runs` row whenever it fires
 * a schedule. The agent run id is written back so the user can jump
 * straight to the agent transcript from a history entry.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    natural_language TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    recurrence_kind TEXT NOT NULL DEFAULT 'custom',
    paused INTEGER NOT NULL DEFAULT 0,
    task_context TEXT,
    last_run_at INTEGER,
    last_run_status TEXT,
    last_run_summary TEXT,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_tenant ON scheduled_tasks(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_workspace ON scheduled_tasks(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(tenant_id, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_paused ON scheduled_tasks(tenant_id, paused);

  CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    scheduled_task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
    scheduled_for INTEGER NOT NULL,
    started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    completed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    summary TEXT,
    error TEXT,
    agent_run_id TEXT,
    trigger_kind TEXT NOT NULL DEFAULT 'scheduled',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_tenant ON scheduled_task_runs(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_schedule
    ON scheduled_task_runs(tenant_id, scheduled_task_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_status
    ON scheduled_task_runs(tenant_id, status);

  CREATE TABLE IF NOT EXISTS schedule_settings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    global_paused INTEGER NOT NULL DEFAULT 0,
    last_tick_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_schedule_settings_tenant ON schedule_settings(tenant_id);
`;

const down = `
  DROP TABLE IF EXISTS schedule_settings;
  DROP TABLE IF EXISTS scheduled_task_runs;
  DROP TABLE IF EXISTS scheduled_tasks;
`;

export const migration: SchemaMigration = {
  id: 20,
  name: "scheduled_tasks",
  up,
  down,
};
