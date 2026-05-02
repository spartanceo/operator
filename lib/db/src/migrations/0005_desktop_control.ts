/**
 * Migration 0002 — desktop control tables.
 *
 * Adds the two tables that back the Operator's Look-Act-Verify desktop
 * agent (Task #5):
 *   - `desktop_sessions` — one row per goal, with the planner snapshot
 *     and the lifecycle status (planning → awaiting_approval → running
 *     → completed | failed | stopped).
 *   - `desktop_steps`    — ordered LAV steps belonging to a session,
 *     each with a semantic target description (no coordinates ever),
 *     a risk level, and optional links to the synthesised tool_call /
 *     approval rows used by the gating UI.
 *
 * FK + tenant indexes follow the project's tier-review checklist
 * (Standard 18 — required indexes on tenant + FK columns).
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS desktop_sessions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    run_id TEXT REFERENCES agent_runs(id),
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planning',
    mode TEXT NOT NULL DEFAULT 'sequential',
    plan_json TEXT,
    summary TEXT,
    error TEXT,
    model_name TEXT,
    started_at INTEGER,
    stopped_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_desktop_sessions_tenant ON desktop_sessions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_desktop_sessions_workspace ON desktop_sessions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_desktop_sessions_run ON desktop_sessions(run_id);
  CREATE INDEX IF NOT EXISTS idx_desktop_sessions_status ON desktop_sessions(tenant_id, status);

  CREATE TABLE IF NOT EXISTS desktop_steps (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    session_id TEXT NOT NULL REFERENCES desktop_sessions(id),
    step_index INTEGER NOT NULL DEFAULT 0,
    action_type TEXT NOT NULL,
    target_description TEXT NOT NULL DEFAULT '',
    target_role TEXT,
    target_label TEXT,
    input_value TEXT,
    risk_level TEXT NOT NULL DEFAULT 'medium',
    needs_approval INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    expected_state TEXT,
    observed_state TEXT,
    verify_attempts INTEGER NOT NULL DEFAULT 0,
    tool_call_id TEXT REFERENCES tool_calls(id),
    approval_id TEXT REFERENCES approvals(id),
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_desktop_steps_tenant ON desktop_steps(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_desktop_steps_workspace ON desktop_steps(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_desktop_steps_session ON desktop_steps(session_id);
  CREATE INDEX IF NOT EXISTS idx_desktop_steps_tool_call ON desktop_steps(tool_call_id);
  CREATE INDEX IF NOT EXISTS idx_desktop_steps_approval ON desktop_steps(approval_id);
  CREATE INDEX IF NOT EXISTS idx_desktop_steps_status ON desktop_steps(tenant_id, status);
`;

const down = `
  DROP TABLE IF EXISTS desktop_steps;
  DROP TABLE IF EXISTS desktop_sessions;
`;

export const migration: SchemaMigration = {
  id: 5,
  name: "desktop_control",
  up,
  down,
};
