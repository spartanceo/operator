/**
 * Migration 0018 — no-code skill creator wizard + hosted Skill Store.
 *
 * Adds:
 *   - `skill_drafts`        — wizard drafts (upload / paste / interview).
 *   - `creator_accounts`    — hosted-store creator profiles.
 *   - `store_skills`        — published store skills (versioned per slug).
 *   - `store_installations` — local record of which store skill versions
 *                             this tenant has installed (auto-update check).
 *
 * All four tables are tenant + workspace scoped so the canonical
 * multi-tenant helpers keep working. The store tables also carry a
 * globally-unique creator-handle / slug-version index because the
 * "store" portion is logically global across tenants in the same DB.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS skill_drafts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    raw_input TEXT NOT NULL DEFAULT '',
    interview_transcript TEXT NOT NULL DEFAULT '[]',
    interview_step INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    model_tags TEXT NOT NULL DEFAULT '[]',
    triggers TEXT NOT NULL DEFAULT '[]',
    example_prompts TEXT NOT NULL DEFAULT '[]',
    category TEXT NOT NULL DEFAULT 'Productivity',
    skill_id TEXT,
    published_store_skill_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_skill_drafts_tenant ON skill_drafts(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skill_drafts_workspace ON skill_drafts(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_skill_drafts_status ON skill_drafts(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_skill_drafts_created ON skill_drafts(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS creator_accounts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    handle TEXT NOT NULL,
    display_name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    website_url TEXT,
    external_links TEXT NOT NULL DEFAULT '[]',
    api_token_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_creator_accounts_tenant ON creator_accounts(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_creator_accounts_workspace ON creator_accounts(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_creator_accounts_handle ON creator_accounts(handle);

  CREATE TABLE IF NOT EXISTS store_skills (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    creator_id TEXT NOT NULL REFERENCES creator_accounts(id),
    creator_handle TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    model_tags TEXT NOT NULL DEFAULT '[]',
    triggers TEXT NOT NULL DEFAULT '[]',
    example_prompts TEXT NOT NULL DEFAULT '[]',
    category TEXT NOT NULL DEFAULT 'Productivity',
    skill_version INTEGER NOT NULL DEFAULT 1,
    is_latest INTEGER NOT NULL DEFAULT 1,
    install_count INTEGER NOT NULL DEFAULT 0,
    documentation TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_store_skills_tenant ON store_skills(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_store_skills_workspace ON store_skills(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_store_skills_creator ON store_skills(creator_id);
  CREATE INDEX IF NOT EXISTS idx_store_skills_creator_handle ON store_skills(creator_handle);
  CREATE INDEX IF NOT EXISTS idx_store_skills_category ON store_skills(category);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_store_skills_creator_slug_version ON store_skills(creator_handle, slug, skill_version);
  CREATE INDEX IF NOT EXISTS idx_store_skills_latest ON store_skills(is_latest);

  CREATE TABLE IF NOT EXISTS store_installations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    skill_id TEXT NOT NULL,
    creator_handle TEXT NOT NULL,
    slug TEXT NOT NULL,
    installed_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_store_installations_tenant ON store_installations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_store_installations_workspace ON store_installations(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_store_installations_skill ON store_installations(skill_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_store_installations_pair ON store_installations(tenant_id, creator_handle, slug);
`;

const down = `
  DROP TABLE IF EXISTS store_installations;
  DROP TABLE IF EXISTS store_skills;
  DROP TABLE IF EXISTS creator_accounts;
  DROP TABLE IF EXISTS skill_drafts;
`;

export const migration: SchemaMigration = {
  id: 22,
  name: "skill_creator_store",
  up,
  down,
};
