/**
 * Migration 0001 — baseline.
 *
 * Snapshot of every table the schema package defines as of Task #37. New
 * installations execute this migration first; pre-existing installations
 * (Tasks #1 and #2 era, where `runMigrations()` was idempotent CREATE TABLE
 * IF NOT EXISTS) will also have these tables already and will simply
 * record this row in `schema_migrations` without re-creating anything —
 * the IF NOT EXISTS clauses make the up script safe to re-run on a DB
 * that already has the baseline schema.
 *
 * The down script drops every table in reverse FK order. Used only by
 * `rollbackTo(0)` for a clean teardown — never executed automatically.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_tenants_tenant ON tenants(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_workspaces_tenant ON workspaces(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_status ON workspaces(tenant_id, status);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    last_login_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email ON users(tenant_id, email);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    plan TEXT,
    summary TEXT,
    error TEXT,
    model_name TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant ON agent_runs(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace ON agent_runs(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(tenant_id, status);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    run_id TEXT REFERENCES agent_runs(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);

  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    run_id TEXT NOT NULL REFERENCES agent_runs(id),
    tool_name TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'low',
    status TEXT NOT NULL DEFAULT 'pending',
    input TEXT NOT NULL,
    output TEXT,
    error TEXT,
    duration_ms INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_tenant ON tool_calls(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_workspace ON tool_calls(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(tenant_id, status);

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL DEFAULT 'fact',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 50,
    source TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_memories_tenant ON memories(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(tenant_id, kind);

  CREATE TABLE IF NOT EXISTS privacy_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    target TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    detail TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_privacy_events_tenant ON privacy_events(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_privacy_events_workspace ON privacy_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_privacy_events_type ON privacy_events(tenant_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_privacy_events_created ON privacy_events(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    run_id TEXT NOT NULL REFERENCES agent_runs(id),
    tool_call_id TEXT NOT NULL REFERENCES tool_calls(id),
    reason TEXT NOT NULL,
    summary TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    decided_at INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_tenant ON approvals(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_approvals_workspace ON approvals(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id);
  CREATE INDEX IF NOT EXISTS idx_approvals_tool_call ON approvals(tool_call_id);
  CREATE INDEX IF NOT EXISTS idx_approvals_decision ON approvals(tenant_id, decision);
`;

const down = `
  DROP TABLE IF EXISTS approvals;
  DROP TABLE IF EXISTS privacy_events;
  DROP TABLE IF EXISTS memories;
  DROP TABLE IF EXISTS tool_calls;
  DROP TABLE IF EXISTS messages;
  DROP TABLE IF EXISTS agent_runs;
  DROP TABLE IF EXISTS sessions;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS workspaces;
  DROP TABLE IF EXISTS tenants;
`;

export const migration: SchemaMigration = {
  id: 1,
  name: "baseline",
  up,
  down,
};
