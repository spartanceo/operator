/**
 * Migration 0020 — Skill versioning & update management (Task #32).
 *
 * Extends `skills` with semantic-version, changelog, breaking-change flag,
 * minimum-OP-version, auto-update toggle, and publish-time / update-dismissal
 * bookkeeping needed by the marketplace update flow. Adds `skill_versions`
 * — the immutable per-version history that backs version listings, rollback,
 * and per-version adoption stats.
 *
 * Schema is purely additive: every new column on `skills` carries a
 * `DEFAULT` so existing rows back-fill cleanly during migration. The
 * `1.0.0` defaults match the implicit version that every previously
 * created skill effectively shipped at.
 */
import type { SchemaMigration } from "./types";

const up = `
  ALTER TABLE skills ADD COLUMN latest_version TEXT NOT NULL DEFAULT '1.0.0';
  ALTER TABLE skills ADD COLUMN installed_version TEXT NOT NULL DEFAULT '1.0.0';
  ALTER TABLE skills ADD COLUMN changelog TEXT NOT NULL DEFAULT '';
  ALTER TABLE skills ADD COLUMN breaking_change INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE skills ADD COLUMN min_op_version TEXT NOT NULL DEFAULT '0.0.0';
  ALTER TABLE skills ADD COLUMN auto_update INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE skills ADD COLUMN published_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000);
  ALTER TABLE skills ADD COLUMN update_dismissed_version TEXT;

  CREATE TABLE IF NOT EXISTS skill_versions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    semver TEXT NOT NULL,
    sort_key INTEGER NOT NULL,
    changelog TEXT NOT NULL DEFAULT '',
    breaking_change INTEGER NOT NULL DEFAULT 0,
    min_op_version TEXT NOT NULL DEFAULT '0.0.0',
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    model_tags TEXT NOT NULL DEFAULT '[]',
    triggers TEXT NOT NULL DEFAULT '[]',
    category TEXT NOT NULL DEFAULT 'Productivity',
    author TEXT NOT NULL DEFAULT 'local',
    install_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_skill_versions_tenant ON skill_versions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skill_versions_workspace ON skill_versions(tenant_id, workspace_id);
  CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(tenant_id, skill_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_versions_skill_semver
    ON skill_versions(tenant_id, skill_id, semver);
`;

const down = `
  DROP TABLE IF EXISTS skill_versions;
`;

export const migration: SchemaMigration = {
  id: 21,
  name: "skill_versioning",
  up,
  down,
};
