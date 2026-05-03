/**
 * Migration 0038 — Super Admin & Enterprise Admin dashboard tables.
 *
 * Adds:
 *   - `feature_flags`              — global on/off toggles for remote feature
 *                                    rollout, optionally segmented.
 *   - `app_versions`               — release channel + current/min required
 *                                    desktop versions, drives the force-update
 *                                    capability.
 *   - `enterprise_orgs`            — one row per business customer; holds
 *                                    plan/seat/branding/air-gap config.
 *   - `enterprise_seats`           — per-user seat assignment with role.
 *   - `enterprise_skill_whitelist` — allow-listed skills per org.
 *   - `abuse_reports`              — flagged skills/users awaiting moderator
 *                                    action.
 *
 * Every table follows the standard tenant_id/workspace_id/created_at/
 * updated_at/version contract enforced by the tier-review schema check.
 * Globally-scoped configuration rows (feature flags, app versions) live
 * under the system tenant + workspace.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS feature_flags (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    flag_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    segment TEXT NOT NULL DEFAULT 'all',
    description TEXT NOT NULL DEFAULT '',
    rollout_percent INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_feature_flags_tenant ON feature_flags(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_feature_flags_workspace ON feature_flags(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_feature_flags_key ON feature_flags(flag_key);

  CREATE TABLE IF NOT EXISTS app_versions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    version_string TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'stable',
    is_current INTEGER NOT NULL DEFAULT 0,
    is_min_required INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    released_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_app_versions_tenant ON app_versions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_app_versions_workspace ON app_versions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_app_versions_channel ON app_versions(channel);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_app_versions_string ON app_versions(version_string);

  CREATE TABLE IF NOT EXISTS enterprise_orgs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    logo_url TEXT,
    primary_color TEXT NOT NULL DEFAULT '#F2A341',
    plan TEXT NOT NULL DEFAULT 'business',
    seat_limit INTEGER NOT NULL DEFAULT 5,
    air_gapped INTEGER NOT NULL DEFAULT 0,
    sso_provider TEXT,
    sso_domain TEXT,
    stripe_customer_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_enterprise_orgs_tenant ON enterprise_orgs(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_enterprise_orgs_workspace ON enterprise_orgs(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_enterprise_orgs_tenant ON enterprise_orgs(tenant_id);

  CREATE TABLE IF NOT EXISTS enterprise_seats (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    email TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'standard',
    status TEXT NOT NULL DEFAULT 'invited',
    invited_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    last_active_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_enterprise_seats_tenant ON enterprise_seats(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_enterprise_seats_workspace ON enterprise_seats(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_enterprise_seats_org ON enterprise_seats(org_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_enterprise_seats_org_email ON enterprise_seats(org_id, email);

  CREATE TABLE IF NOT EXISTS enterprise_skill_whitelist (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    skill_slug TEXT NOT NULL,
    skill_name TEXT NOT NULL DEFAULT '',
    allowed INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_enterprise_skill_whitelist_tenant ON enterprise_skill_whitelist(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_enterprise_skill_whitelist_workspace ON enterprise_skill_whitelist(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_enterprise_skill_whitelist_org ON enterprise_skill_whitelist(org_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_enterprise_skill_whitelist ON enterprise_skill_whitelist(org_id, skill_slug);

  CREATE TABLE IF NOT EXISTS abuse_reports (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_label TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    reporter_label TEXT NOT NULL DEFAULT 'system',
    resolution_notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_abuse_reports_tenant ON abuse_reports(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_abuse_reports_workspace ON abuse_reports(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_abuse_reports_status ON abuse_reports(status);
  CREATE INDEX IF NOT EXISTS idx_abuse_reports_target ON abuse_reports(target_type, target_id);
`;

const down = `
  DROP TABLE IF EXISTS abuse_reports;
  DROP TABLE IF EXISTS enterprise_skill_whitelist;
  DROP TABLE IF EXISTS enterprise_seats;
  DROP TABLE IF EXISTS enterprise_orgs;
  DROP TABLE IF EXISTS app_versions;
  DROP TABLE IF EXISTS feature_flags;
`;

export const migration: SchemaMigration = {
  id: 38,
  name: "admin_dashboard",
  up,
  down,
};
