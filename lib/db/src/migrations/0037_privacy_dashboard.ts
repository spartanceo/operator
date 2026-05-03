/**
 * Migration 0030 — Privacy Dashboard & Granular Data Controls (Task #54).
 *
 * Adds four tables that back the Privacy Dashboard:
 *   - privacy_settings   : per-feature toggles (singleton per tenant)
 *   - network_calls      : append-only log of outbound network calls
 *   - skill_permissions  : per-skill granular permission grants
 *   - erasure_requests   : GDPR erasure-request log (enterprise cloud)
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS privacy_settings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    allow_external_models INTEGER NOT NULL DEFAULT 0,
    allow_marketplace_usage_stats INTEGER NOT NULL DEFAULT 0,
    allow_integration_data_reads INTEGER NOT NULL DEFAULT 1,
    allow_skill_network_calls INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_privacy_settings_tenant ON privacy_settings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_privacy_settings_workspace ON privacy_settings(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_settings_unique_tenant ON privacy_settings(tenant_id);

  CREATE TABLE IF NOT EXISTS network_calls (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    domain TEXT NOT NULL,
    purpose TEXT NOT NULL,
    data_type TEXT NOT NULL DEFAULT 'metadata',
    initiator TEXT NOT NULL DEFAULT 'automatic',
    bytes_sent INTEGER NOT NULL DEFAULT 0,
    bytes_received INTEGER NOT NULL DEFAULT 0,
    status_code INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_network_calls_tenant ON network_calls(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_network_calls_workspace ON network_calls(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_network_calls_domain ON network_calls(tenant_id, domain);
  CREATE INDEX IF NOT EXISTS idx_network_calls_created ON network_calls(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS skill_permissions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    skill_id TEXT NOT NULL,
    skill_slug TEXT NOT NULL,
    permission TEXT NOT NULL,
    granted INTEGER NOT NULL DEFAULT 0,
    granted_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_skill_permissions_tenant ON skill_permissions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skill_permissions_workspace ON skill_permissions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_skill_permissions_skill ON skill_permissions(tenant_id, skill_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_permissions_unique
    ON skill_permissions(tenant_id, skill_id, permission);

  CREATE TABLE IF NOT EXISTS erasure_requests (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    requester_email TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'all',
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_erasure_requests_tenant ON erasure_requests(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_erasure_requests_workspace ON erasure_requests(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_erasure_requests_status ON erasure_requests(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_erasure_requests_created ON erasure_requests(tenant_id, created_at);
`;

const down = `
  DROP TABLE IF EXISTS erasure_requests;
  DROP TABLE IF EXISTS skill_permissions;
  DROP TABLE IF EXISTS network_calls;
  DROP TABLE IF EXISTS privacy_settings;
`;

export const migration: SchemaMigration = {
  id: 37,
  name: "privacy_dashboard",
  up,
  down,
};
