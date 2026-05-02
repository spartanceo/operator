/**
 * Migration 0005 — security hardening (Task #16).
 *
 * Adds the persistence layer for the defence-in-depth security stack:
 *
 *  - audit_log_entries  : tamper-evident, hash-chained, append-only.
 *  - security_events    : separate severity-tagged event stream
 *                         (auth failures, blocked skill actions, etc.).
 *  - secret_vault_entries: AES-256-GCM ciphertext for credentials whose
 *                          backing store is the OS keychain in production
 *                          but a file-backed vault in dev / tests.
 *  - master_password_state: singleton-per-tenant Argon2id-style KDF hash
 *                           and biometric-unlock toggle.
 *  - webhook_secrets    : per-tenant HMAC keys for webhook sign / verify.
 *  - telemetry_consent  : singleton-per-tenant opt-in (off by default).
 *  - auto_lock_state    : singleton-per-tenant inactivity policy.
 *  - admin_2fa_secrets  : RFC-6238 TOTP secrets for super-admin accounts.
 *  - refresh_tokens     : opaque rotating refresh tokens for the
 *                         short-expiry JWT access flow.
 *
 * All FKs target tables seeded by migrations 0001/0004 (tenants,
 * workspaces, users) so the FK constraint is always satisfiable on a
 * fresh install or an in-place upgrade.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS audit_log_entries (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    sequence INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    summary TEXT NOT NULL,
    previous_hash TEXT,
    entry_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_entries_tenant ON audit_log_entries(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_entries_workspace ON audit_log_entries(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_entries_sequence ON audit_log_entries(tenant_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_audit_log_entries_created ON audit_log_entries(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    actor TEXT NOT NULL,
    target TEXT,
    source_ip TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_security_events_tenant ON security_events(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_security_events_workspace ON security_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(tenant_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(tenant_id, severity);
  CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS secret_vault_entries (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    namespace TEXT NOT NULL,
    key_name TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    backend TEXT NOT NULL DEFAULT 'file',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_secret_vault_entries_tenant ON secret_vault_entries(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_secret_vault_entries_namespace ON secret_vault_entries(tenant_id, namespace);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_secret_vault_entries_unique_key
    ON secret_vault_entries(tenant_id, namespace, key_name);

  CREATE TABLE IF NOT EXISTS master_password_state (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    kdf_hash TEXT NOT NULL,
    kdf_salt TEXT NOT NULL,
    kdf_algo TEXT NOT NULL DEFAULT 'scrypt-n16384-r8-p1',
    biometric_enabled INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    set_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_master_password_state_tenant ON master_password_state(tenant_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_master_password_state_unique_tenant
    ON master_password_state(tenant_id);

  CREATE TABLE IF NOT EXISTS webhook_secrets (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    endpoint TEXT NOT NULL,
    label TEXT NOT NULL,
    secret TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_used_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_secrets_tenant ON webhook_secrets(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_webhook_secrets_endpoint ON webhook_secrets(tenant_id, endpoint);
  CREATE INDEX IF NOT EXISTS idx_webhook_secrets_status ON webhook_secrets(tenant_id, status);

  CREATE TABLE IF NOT EXISTS telemetry_consent (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    crash_reports_enabled INTEGER NOT NULL DEFAULT 0,
    usage_metrics_enabled INTEGER NOT NULL DEFAULT 0,
    product_improvement_enabled INTEGER NOT NULL DEFAULT 0,
    consent_given_at INTEGER,
    consent_revoked_at INTEGER,
    consent_version TEXT NOT NULL DEFAULT 'v1',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_telemetry_consent_tenant ON telemetry_consent(tenant_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_consent_unique_tenant
    ON telemetry_consent(tenant_id);

  CREATE TABLE IF NOT EXISTS auto_lock_state (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    inactivity_minutes INTEGER NOT NULL DEFAULT 15,
    require_biometric INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    locked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_auto_lock_state_tenant ON auto_lock_state(tenant_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_lock_state_unique_tenant
    ON auto_lock_state(tenant_id);

  CREATE TABLE IF NOT EXISTS admin_2fa_secrets (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    secret_base32 TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    last_used_counter INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_admin_2fa_secrets_tenant ON admin_2fa_secrets(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_admin_2fa_secrets_user ON admin_2fa_secrets(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_2fa_secrets_unique_user
    ON admin_2fa_secrets(tenant_id, user_id);

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    replaced_by_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_tenant ON refresh_tokens(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
`;

const down = `
  DROP TABLE IF EXISTS refresh_tokens;
  DROP TABLE IF EXISTS admin_2fa_secrets;
  DROP TABLE IF EXISTS auto_lock_state;
  DROP TABLE IF EXISTS telemetry_consent;
  DROP TABLE IF EXISTS webhook_secrets;
  DROP TABLE IF EXISTS master_password_state;
  DROP TABLE IF EXISTS secret_vault_entries;
  DROP TABLE IF EXISTS security_events;
  DROP TABLE IF EXISTS audit_log_entries;
`;

export const migration: SchemaMigration = {
  id: 9,
  name: "security_hardening",
  up,
  down,
};
