/**
 * Migration 0050 — Universal App Understanding & Capability Indexer (Task #70).
 *
 * Adds four tables that together form the per-app capability profile:
 *
 *   - app_profiles               : one row per (tenant, app); fuses OS-native,
 *                                  docs, MCP, and community App-Skill sources.
 *   - app_capability_commands    : discrete commands / menu items / shortcuts /
 *                                  MCP tools / skill actions for fast lookup.
 *   - app_mcp_connections        : MCP connector status + cached tool list.
 *   - app_doc_ingestions         : background "Deep Learn" doc-ingestion jobs.
 *
 * Also extends `skills` with a `target_app_id` column so a community App
 * Skill can declare which app it targets (Task #70 step 7).
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS app_profiles (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    app_version TEXT NOT NULL DEFAULT '0.0.0',
    platform TEXT NOT NULL DEFAULT 'macos',
    sources TEXT NOT NULL DEFAULT '{"osNative":false,"mcp":false,"docs":false,"skill":false}',
    command_count INTEGER NOT NULL DEFAULT 0,
    menu_count INTEGER NOT NULL DEFAULT 0,
    shortcut_count INTEGER NOT NULL DEFAULT 0,
    doc_index_status TEXT NOT NULL DEFAULT 'absent',
    mcp_status TEXT NOT NULL DEFAULT 'absent',
    installed_skill_id TEXT REFERENCES skills(id),
    last_refreshed_at INTEGER,
    profile_ttl_ms INTEGER NOT NULL DEFAULT 86400000,
    discovered_path TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_app_profiles_tenant ON app_profiles(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_app_profiles_workspace ON app_profiles(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_app_profiles_app ON app_profiles(tenant_id, app_id);
  CREATE INDEX IF NOT EXISTS idx_app_profiles_skill ON app_profiles(installed_skill_id);
  CREATE INDEX IF NOT EXISTS idx_app_profiles_refreshed ON app_profiles(tenant_id, last_refreshed_at);

  CREATE TABLE IF NOT EXISTS app_capability_commands (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    app_profile_id TEXT NOT NULL REFERENCES app_profiles(id),
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    shortcut TEXT,
    payload_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_app_cmd_tenant ON app_capability_commands(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_app_cmd_workspace ON app_capability_commands(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_app_cmd_profile ON app_capability_commands(app_profile_id);
  CREATE INDEX IF NOT EXISTS idx_app_cmd_kind ON app_capability_commands(app_profile_id, kind);
  CREATE INDEX IF NOT EXISTS idx_app_cmd_name ON app_capability_commands(tenant_id, name);

  CREATE TABLE IF NOT EXISTS app_mcp_connections (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    app_profile_id TEXT NOT NULL REFERENCES app_profiles(id),
    endpoint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    tools_json TEXT,
    error TEXT,
    connected_at INTEGER,
    disconnected_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_app_mcp_tenant ON app_mcp_connections(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_app_mcp_workspace ON app_mcp_connections(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_app_mcp_profile ON app_mcp_connections(app_profile_id);
  CREATE INDEX IF NOT EXISTS idx_app_mcp_status ON app_mcp_connections(tenant_id, status);

  CREATE TABLE IF NOT EXISTS app_doc_ingestions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    app_profile_id TEXT NOT NULL REFERENCES app_profiles(id),
    status TEXT NOT NULL DEFAULT 'queued',
    root_url TEXT NOT NULL,
    pages_fetched INTEGER NOT NULL DEFAULT 0,
    pages_planned INTEGER NOT NULL DEFAULT 0,
    chunks_embedded INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_app_doc_tenant ON app_doc_ingestions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_app_doc_workspace ON app_doc_ingestions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_app_doc_profile ON app_doc_ingestions(app_profile_id);
  CREATE INDEX IF NOT EXISTS idx_app_doc_status ON app_doc_ingestions(tenant_id, status);

  ALTER TABLE skills ADD COLUMN target_app_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_skills_target_app ON skills(tenant_id, target_app_id);
`;

const down = `
  DROP INDEX IF EXISTS idx_skills_target_app;
  DROP TABLE IF EXISTS app_doc_ingestions;
  DROP TABLE IF EXISTS app_mcp_connections;
  DROP TABLE IF EXISTS app_capability_commands;
  DROP TABLE IF EXISTS app_profiles;
`;

export const migration: SchemaMigration = {
  id: 50,
  name: "app_capability_indexer",
  up,
  down,
};
