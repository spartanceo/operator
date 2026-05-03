/**
 * Migration 0039 — Compliance-grade audit log (Task #53).
 *
 * The base `audit_log_entries` table from migration 0009 is already a
 * tamper-evident, hash-chained, append-only log. Compliance-grade
 * deployments (legal, medical, financial, defence) need richer per-entry
 * fields, a configurable retention window, an alert-rule engine, and a
 * separate ledger of triggered alerts. This migration adds:
 *
 *  - extra optional columns on `audit_log_entries` capturing the full
 *    compliance schema: action_type, agent_id, skill_id, tool_id,
 *    user_id, session_id, input_hash (never raw input), output_summary,
 *    approval_status. Existing rows simply have NULLs in the new
 *    columns; the chain hash for new rows includes them so tampering
 *    with any field still breaks verification.
 *  - `audit_retention_settings` — singleton-per-tenant configurable
 *    retention window in days (default 365).
 *  - `audit_alert_rules` — admin-defined threshold rules
 *    (e.g. "more than 50 file_op events in 60 seconds").
 *  - `audit_alerts` — append-only ledger of triggered rule firings.
 *
 * All new tables follow the standard tenant_id / workspace_id /
 * created_at / updated_at / version contract enforced by tier-review.
 * Audit-prefixed tables are version-exempt by design (append-only).
 */
import type { SchemaMigration } from "./types";

const up = `
  ALTER TABLE audit_log_entries ADD COLUMN action_type TEXT;
  ALTER TABLE audit_log_entries ADD COLUMN agent_id TEXT;
  ALTER TABLE audit_log_entries ADD COLUMN skill_id TEXT;
  ALTER TABLE audit_log_entries ADD COLUMN tool_id TEXT;
  ALTER TABLE audit_log_entries ADD COLUMN user_id TEXT;
  ALTER TABLE audit_log_entries ADD COLUMN session_id TEXT;
  ALTER TABLE audit_log_entries ADD COLUMN input_hash TEXT;
  ALTER TABLE audit_log_entries ADD COLUMN output_summary TEXT;
  ALTER TABLE audit_log_entries ADD COLUMN approval_status TEXT;
  CREATE INDEX IF NOT EXISTS idx_audit_log_entries_action_type
    ON audit_log_entries(tenant_id, action_type);
  CREATE INDEX IF NOT EXISTS idx_audit_log_entries_agent
    ON audit_log_entries(tenant_id, agent_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_entries_user
    ON audit_log_entries(tenant_id, user_id);

  CREATE TABLE IF NOT EXISTS audit_retention_settings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    retention_days INTEGER NOT NULL DEFAULT 365,
    last_purge_at INTEGER,
    last_purge_count INTEGER NOT NULL DEFAULT 0,
    -- chain_checkpoint_hash is the entry_hash of the last row that was
    -- purged. After a purge, the new earliest surviving row's
    -- previous_hash equals this checkpoint, allowing chain verification
    -- to resume from a known-good anchor instead of expecting null.
    chain_checkpoint_hash TEXT,
    chain_checkpoint_sequence INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_audit_retention_settings_tenant
    ON audit_retention_settings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_audit_retention_settings_workspace
    ON audit_retention_settings(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_retention_settings_tenant
    ON audit_retention_settings(tenant_id);

  CREATE TABLE IF NOT EXISTS audit_alert_rules (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    action_type TEXT,
    actor TEXT,
    threshold_count INTEGER NOT NULL DEFAULT 50,
    window_seconds INTEGER NOT NULL DEFAULT 60,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_triggered_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_audit_alert_rules_tenant
    ON audit_alert_rules(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_audit_alert_rules_workspace
    ON audit_alert_rules(workspace_id);

  CREATE TABLE IF NOT EXISTS audit_alerts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    rule_id TEXT NOT NULL REFERENCES audit_alert_rules(id),
    rule_name TEXT NOT NULL,
    triggered_count INTEGER NOT NULL,
    threshold_count INTEGER NOT NULL,
    window_seconds INTEGER NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_audit_alerts_tenant
    ON audit_alerts(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_audit_alerts_workspace
    ON audit_alerts(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_audit_alerts_rule
    ON audit_alerts(rule_id);
  CREATE INDEX IF NOT EXISTS idx_audit_alerts_created
    ON audit_alerts(tenant_id, created_at);
`;

const down = `
  DROP INDEX IF EXISTS idx_audit_alerts_created;
  DROP INDEX IF EXISTS idx_audit_alerts_rule;
  DROP INDEX IF EXISTS idx_audit_alerts_workspace;
  DROP INDEX IF EXISTS idx_audit_alerts_tenant;
  DROP TABLE IF EXISTS audit_alerts;
  DROP INDEX IF EXISTS idx_audit_alert_rules_workspace;
  DROP INDEX IF EXISTS idx_audit_alert_rules_tenant;
  DROP TABLE IF EXISTS audit_alert_rules;
  DROP INDEX IF EXISTS uq_audit_retention_settings_tenant;
  DROP INDEX IF EXISTS idx_audit_retention_settings_workspace;
  DROP INDEX IF EXISTS idx_audit_retention_settings_tenant;
  DROP TABLE IF EXISTS audit_retention_settings;
  DROP INDEX IF EXISTS idx_audit_log_entries_user;
  DROP INDEX IF EXISTS idx_audit_log_entries_agent;
  DROP INDEX IF EXISTS idx_audit_log_entries_action_type;
`;

export const migration: SchemaMigration = {
  id: 40,
  name: "compliance_audit",
  up,
  down,
};
