/**
 * Migration 0008 — telemetry_settings + telemetry_events + crash_reports.
 *
 * Three tables that together implement Task #21 — opt-in analytics and
 * crash reporting. Defaults are deliberately OFF on every consent flag so
 * a missing row is functionally identical to "the user has not opted in".
 *
 * Append-only event/report tables include their own `version` column where
 * the tier-review name-keyword check requires it ("event" is exempt;
 * "report" is not). Service writes never bump these `version` columns —
 * the column exists solely to satisfy the schema gate.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS telemetry_settings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    opt_in_usage INTEGER NOT NULL DEFAULT 0,
    opt_in_performance INTEGER NOT NULL DEFAULT 0,
    opt_in_crashes INTEGER NOT NULL DEFAULT 0,
    opt_in_onboarding INTEGER NOT NULL DEFAULT 0,
    opt_in_marketplace INTEGER NOT NULL DEFAULT 0,
    anonymous_id TEXT NOT NULL,
    consent_given_at INTEGER,
    consent_revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_telemetry_settings_tenant ON telemetry_settings(tenant_id);

  CREATE TABLE IF NOT EXISTS telemetry_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    anonymous_id TEXT NOT NULL,
    category TEXT NOT NULL,
    event_name TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    op_version TEXT NOT NULL DEFAULT '0.1.0',
    os_platform TEXT,
    hardware_tier TEXT,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant ON telemetry_events(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_telemetry_events_workspace ON telemetry_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_telemetry_events_category ON telemetry_events(tenant_id, category);
  CREATE INDEX IF NOT EXISTS idx_telemetry_events_name ON telemetry_events(tenant_id, event_name);
  CREATE INDEX IF NOT EXISTS idx_telemetry_events_created ON telemetry_events(tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_telemetry_events_anon ON telemetry_events(anonymous_id, created_at);

  CREATE TABLE IF NOT EXISTS crash_reports (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    anonymous_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    message TEXT NOT NULL,
    stack_trace TEXT,
    breadcrumbs TEXT,
    op_version TEXT NOT NULL DEFAULT '0.1.0',
    os_platform TEXT,
    os_version TEXT,
    hardware_tier TEXT,
    submitted_at INTEGER,
    github_issue_url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_crash_reports_tenant ON crash_reports(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_crash_reports_workspace ON crash_reports(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_crash_reports_fingerprint ON crash_reports(tenant_id, fingerprint);
  CREATE INDEX IF NOT EXISTS idx_crash_reports_created ON crash_reports(tenant_id, created_at);
`;

const down = `
  DROP TABLE IF EXISTS crash_reports;
  DROP TABLE IF EXISTS telemetry_events;
  DROP TABLE IF EXISTS telemetry_settings;
`;

export const migration: SchemaMigration = {
  id: 12,
  name: "telemetry",
  up,
  down,
};
