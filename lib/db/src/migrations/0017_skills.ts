/**
 * Migration 0015 — skills + agent run routed-skill attribution.
 *
 * Adds the local-first Skills Marketplace table and its indexes. Also
 * extends `agent_runs` with `routed_skill_id` / `routed_skill_name`
 * columns so the Operator UI can show which skill (if any) was injected
 * into a run, including auto-routed matches that were not explicitly
 * picked by the user. Both extensions are additive and idempotent.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    model_tags TEXT NOT NULL DEFAULT '[]',
    triggers TEXT NOT NULL DEFAULT '[]',
    category TEXT NOT NULL DEFAULT 'Productivity',
    author TEXT NOT NULL DEFAULT 'local',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1,
    is_installed INTEGER NOT NULL DEFAULT 0,
    install_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_skills_tenant ON skills(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skills_workspace ON skills(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_skills_tenant_slug ON skills(tenant_id, slug);
  CREATE INDEX IF NOT EXISTS idx_skills_installed ON skills(tenant_id, is_installed);
  CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(tenant_id, category);
  ALTER TABLE agent_runs ADD COLUMN routed_skill_id TEXT;
  ALTER TABLE agent_runs ADD COLUMN routed_skill_name TEXT;
`;

const down = `
  DROP TABLE IF EXISTS skills;
`;

export const migration: SchemaMigration = {
  id: 17,
  name: "skills",
  up,
  down,
};
