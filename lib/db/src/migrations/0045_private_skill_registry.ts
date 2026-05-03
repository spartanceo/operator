/**
 * Migration 0045 — Enterprise Private Skill Registry (Task #60).
 *
 * Adds the persistent state for an organisation-private skill registry
 * that is fully isolated from the public marketplace and the public
 * skill-moderation pipeline:
 *
 *   - `private_registry_settings` — one row per enterprise org. Holds
 *     the registry mode (`local` co-hosted vs. `remote` self-hosted
 *     air-gap server), the remote URL, the org's code-signing public
 *     key (PEM), and the toggle that enables/disables signature
 *     verification on install.
 *
 *   - `private_skill_packages` — published private skills. Versioned
 *     (creator_id + slug + version unique). Each row carries the
 *     visibility scope (`all` | `roles` | `workspaces`), a JSON array
 *     of role/workspace targets, the IT-admin approval status
 *     (`pending` | `approved` | `rejected` | `superseded`), the
 *     `mandatory` flag, the optional code signature, and full skill
 *     content. Strictly tenant-isolated — never leaves the org.
 *
 *   - `private_skill_installations` — per-tenant install record (one row
 *     per (tenant, package_id)). Tracks the local skills row produced,
 *     the installed version, mandatory flag (mirrored for fast
 *     uninstall-block lookups), and whether the install was an admin
 *     push or a member-initiated install.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS private_registry_settings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    mode TEXT NOT NULL DEFAULT 'local',
    remote_registry_url TEXT,
    signing_public_key_pem TEXT,
    require_signature INTEGER NOT NULL DEFAULT 0,
    last_synced_at INTEGER,
    last_sync_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_private_registry_settings_tenant
    ON private_registry_settings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_private_registry_settings_workspace
    ON private_registry_settings(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_private_registry_settings_org
    ON private_registry_settings(org_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_private_registry_settings_org
    ON private_registry_settings(org_id);

  CREATE TABLE IF NOT EXISTS private_skill_packages (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    model_tags TEXT NOT NULL DEFAULT '[]',
    triggers TEXT NOT NULL DEFAULT '[]',
    category TEXT NOT NULL DEFAULT 'Internal',
    documentation TEXT NOT NULL DEFAULT '',
    skill_version INTEGER NOT NULL DEFAULT 1,
    is_latest INTEGER NOT NULL DEFAULT 1,
    visibility TEXT NOT NULL DEFAULT 'all',
    visibility_targets TEXT NOT NULL DEFAULT '[]',
    mandatory INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    submitted_by TEXT NOT NULL DEFAULT '',
    submitted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    reviewed_by TEXT NOT NULL DEFAULT '',
    reviewed_at INTEGER,
    review_notes TEXT NOT NULL DEFAULT '',
    rejection_reason TEXT NOT NULL DEFAULT '',
    signature TEXT NOT NULL DEFAULT '',
    signature_algo TEXT NOT NULL DEFAULT '',
    install_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_private_skill_packages_tenant
    ON private_skill_packages(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_private_skill_packages_workspace
    ON private_skill_packages(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_private_skill_packages_org
    ON private_skill_packages(org_id);
  CREATE INDEX IF NOT EXISTS idx_private_skill_packages_status
    ON private_skill_packages(status);
  CREATE INDEX IF NOT EXISTS idx_private_skill_packages_latest
    ON private_skill_packages(org_id, is_latest);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_private_skill_packages_slug_version
    ON private_skill_packages(org_id, slug, skill_version);

  CREATE TABLE IF NOT EXISTS private_skill_installations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    package_id TEXT NOT NULL REFERENCES private_skill_packages(id),
    slug TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    installed_version INTEGER NOT NULL,
    mandatory INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'user',
    installed_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_private_skill_installations_tenant
    ON private_skill_installations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_private_skill_installations_workspace
    ON private_skill_installations(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_private_skill_installations_org
    ON private_skill_installations(org_id);
  CREATE INDEX IF NOT EXISTS idx_private_skill_installations_package
    ON private_skill_installations(package_id);
  CREATE INDEX IF NOT EXISTS idx_private_skill_installations_skill
    ON private_skill_installations(skill_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_private_skill_installations_pair
    ON private_skill_installations(tenant_id, workspace_id, slug);
`;

const down = `
  DROP TABLE IF EXISTS private_skill_installations;
  DROP TABLE IF EXISTS private_skill_packages;
  DROP TABLE IF EXISTS private_registry_settings;
`;

export const migration: SchemaMigration = {
  id: 45,
  name: "private_skill_registry",
  up,
  down,
};
