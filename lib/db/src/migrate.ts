/**
 * Hand-rolled migration runner.
 *
 * Drizzle-kit is configured for `drizzle-kit push` against a file-backed
 * database; in-memory test databases need a programmatic alternative because
 * push runs out-of-process and can't see the in-process handle.
 *
 * `runMigrations(sqlite)` is idempotent — every CREATE TABLE / CREATE INDEX
 * statement uses `IF NOT EXISTS` so it's safe to call on an already-migrated
 * database (production startup) and on a brand-new one (tests).
 *
 * The schema lives here as plain DDL strings rather than driving it through
 * drizzle's introspection because:
 *   1. Tests stay zero-dependency on drizzle-kit.
 *   2. The DDL is explicit and auditable in a single file.
 *   3. Schema drift between this file and the Drizzle table definitions is
 *      caught by tier-review Check #5 (required columns) on the .ts side.
 */
import type { Database as SqliteDatabase } from "better-sqlite3";

import { getRawSqlite } from "./index";

const DDL = [
  // tenants
  `CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tenants_tenant ON tenants(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status)`,

  // workspaces
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_tenant ON workspaces(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_status ON workspaces(tenant_id, status)`,

  // users
  `CREATE TABLE IF NOT EXISTS users (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email ON users(tenant_id, email)`,

  // sessions
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,

  // agent_runs
  `CREATE TABLE IF NOT EXISTS agent_runs (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant ON agent_runs(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace ON agent_runs(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(tenant_id, status)`,

  // messages
  `CREATE TABLE IF NOT EXISTS messages (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id)`,

  // tool_calls
  `CREATE TABLE IF NOT EXISTS tool_calls (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_tenant ON tool_calls(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_workspace ON tool_calls(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(tenant_id, status)`,

  // memories
  `CREATE TABLE IF NOT EXISTS memories (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_tenant ON memories(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(tenant_id, kind)`,

  // privacy_events
  `CREATE TABLE IF NOT EXISTS privacy_events (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_privacy_events_tenant ON privacy_events(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_privacy_events_workspace ON privacy_events(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_privacy_events_type ON privacy_events(tenant_id, event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_privacy_events_created ON privacy_events(tenant_id, created_at)`,

  // approvals
  `CREATE TABLE IF NOT EXISTS approvals (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_tenant ON approvals(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_workspace ON approvals(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_tool_call ON approvals(tool_call_id)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_decision ON approvals(tenant_id, decision)`,
];

export function runMigrations(sqlite?: SqliteDatabase): void {
  const handle = sqlite ?? getRawSqlite();
  for (const stmt of DDL) {
    handle.exec(stmt);
  }
}
