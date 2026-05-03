/**
 * Migration 0025 — Skill configuration & post-install setup (Task #43).
 *
 * Two additive moves:
 *   1. Add `configuration_schema` (JSON-encoded array of field declarations)
 *      to both `skills` (the live row) and `skill_versions` (the version
 *      snapshot used for rollback / per-version manifest export).
 *   2. Add `skill_configurations` — the per-workspace, per-skill store of
 *      user-supplied configuration values. Sensitive entries (passwords,
 *      API keys) are referenced by key only; their plaintext lives in
 *      `secret_vault_entries` so the OS keychain wrapper can swap in.
 *
 * Defaults are `'[]'` / `'{}'` so existing rows back-fill without surgery.
 */
import type { SchemaMigration } from "./types";

const up = `
  ALTER TABLE skills ADD COLUMN configuration_schema TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE skill_versions ADD COLUMN configuration_schema TEXT NOT NULL DEFAULT '[]';

  CREATE TABLE IF NOT EXISTS skill_configurations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    values_json TEXT NOT NULL DEFAULT '{}',
    secret_refs_json TEXT NOT NULL DEFAULT '[]',
    configured_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_skill_configurations_tenant
    ON skill_configurations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skill_configurations_workspace
    ON skill_configurations(tenant_id, workspace_id);
  CREATE INDEX IF NOT EXISTS idx_skill_configurations_skill
    ON skill_configurations(tenant_id, skill_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_configurations_unique
    ON skill_configurations(tenant_id, workspace_id, skill_id);
`;

const down = `
  DROP TABLE IF EXISTS skill_configurations;
`;

export const migration: SchemaMigration = {
  id: 30,
  name: "skill_configuration",
  up,
  down,
};
