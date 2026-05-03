/**
 * Migration 0039 — Enterprise SSO & Identity Federation (Task #55).
 *
 * Adds:
 *   - `sso_configurations`        — per-org IdP config (SAML / OIDC).
 *   - `sso_group_role_mappings`   — IdP group → OP role rules.
 *   - `sso_login_events`          — high-volume login audit (append-only).
 *   - `sso_sessions`              — OP↔IdP session linkage for SLO.
 *   - `scim_provisioning_tokens`  — bearer auth for SCIM 2.0 endpoints.
 *   - `scim_groups`               — synced SCIM /Groups membership.
 *   - `break_glass_accounts`      — emergency local-admin bypass.
 *
 * All tables follow the standard tenant_id/workspace_id contract and
 * reference `enterprise_orgs(id)` for org scoping.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS sso_configurations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    protocol TEXT NOT NULL DEFAULT 'saml',
    display_name TEXT NOT NULL DEFAULT '',
    email_domain TEXT NOT NULL DEFAULT '',
    saml_entity_id TEXT,
    saml_sso_url TEXT,
    saml_slo_url TEXT,
    saml_signing_cert_pem TEXT,
    saml_want_assertions_signed INTEGER NOT NULL DEFAULT 1,
    oidc_issuer TEXT,
    oidc_client_id TEXT,
    oidc_client_secret TEXT,
    oidc_discovery_json TEXT,
    oidc_discovery_fetched_at INTEGER,
    enforced INTEGER NOT NULL DEFAULT 0,
    jit_provisioning INTEGER NOT NULL DEFAULT 1,
    single_logout_enabled INTEGER NOT NULL DEFAULT 1,
    session_timeout_minutes INTEGER NOT NULL DEFAULT 480,
    last_success_at INTEGER,
    last_failure_at INTEGER,
    last_failure_message TEXT,
    last_health_check_at INTEGER,
    healthy INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_sso_configurations_tenant ON sso_configurations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_sso_configurations_workspace ON sso_configurations(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_sso_configurations_org ON sso_configurations(org_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_sso_configurations_org ON sso_configurations(org_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_sso_configurations_domain ON sso_configurations(email_domain);

  CREATE TABLE IF NOT EXISTS sso_group_role_mappings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    group_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'standard',
    priority INTEGER NOT NULL DEFAULT 100,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_sso_group_role_mappings_tenant ON sso_group_role_mappings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_sso_group_role_mappings_workspace ON sso_group_role_mappings(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_sso_group_role_mappings_org ON sso_group_role_mappings(org_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_sso_group_role_mappings ON sso_group_role_mappings(org_id, group_name);

  CREATE TABLE IF NOT EXISTS sso_login_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    protocol TEXT NOT NULL,
    outcome TEXT NOT NULL,
    subject TEXT,
    email TEXT,
    failure_code TEXT,
    failure_message TEXT,
    source_ip TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_sso_login_events_tenant ON sso_login_events(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_sso_login_events_workspace ON sso_login_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_sso_login_events_org ON sso_login_events(org_id);
  CREATE INDEX IF NOT EXISTS idx_sso_login_events_outcome ON sso_login_events(org_id, outcome);
  CREATE INDEX IF NOT EXISTS idx_sso_login_events_created ON sso_login_events(org_id, created_at);

  CREATE TABLE IF NOT EXISTS sso_sessions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    session_id TEXT NOT NULL,
    idp_session_index TEXT,
    idp_subject TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_sso_sessions_tenant ON sso_sessions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_sso_sessions_workspace ON sso_sessions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_sso_sessions_org ON sso_sessions(org_id);
  CREATE INDEX IF NOT EXISTS idx_sso_sessions_user ON sso_sessions(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_sso_sessions_session ON sso_sessions(session_id);
  CREATE INDEX IF NOT EXISTS idx_sso_sessions_idp ON sso_sessions(org_id, idp_session_index);

  CREATE TABLE IF NOT EXISTS scim_provisioning_tokens (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    label TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    revoked_at INTEGER,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_scim_provisioning_tokens_tenant ON scim_provisioning_tokens(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_scim_provisioning_tokens_workspace ON scim_provisioning_tokens(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_scim_provisioning_tokens_org ON scim_provisioning_tokens(org_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_scim_provisioning_tokens_hash ON scim_provisioning_tokens(token_hash);

  CREATE TABLE IF NOT EXISTS scim_groups (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    external_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    members_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_scim_groups_tenant ON scim_groups(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_scim_groups_workspace ON scim_groups(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_scim_groups_org ON scim_groups(org_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_scim_groups_external ON scim_groups(org_id, external_id);

  CREATE TABLE IF NOT EXISTS break_glass_accounts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    passphrase_suffix TEXT NOT NULL,
    issued_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    last_used_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_break_glass_accounts_tenant ON break_glass_accounts(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_break_glass_accounts_workspace ON break_glass_accounts(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_break_glass_accounts_org ON break_glass_accounts(org_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_break_glass_accounts_org ON break_glass_accounts(org_id);
`;

const down = `
  DROP TABLE IF EXISTS break_glass_accounts;
  DROP TABLE IF EXISTS scim_groups;
  DROP TABLE IF EXISTS scim_provisioning_tokens;
  DROP TABLE IF EXISTS sso_sessions;
  DROP TABLE IF EXISTS sso_login_events;
  DROP TABLE IF EXISTS sso_group_role_mappings;
  DROP TABLE IF EXISTS sso_configurations;
`;

export const migration: SchemaMigration = {
  id: 43,
  name: "enterprise_sso",
  up,
  down,
};
