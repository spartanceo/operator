/**
 * Migration 0011 — legal, policy & regulatory compliance (Task #25).
 *
 * Adds three tables that back the in-app legal acceptance flow, the
 * EU AI Act incident-reporting channel, and the COPPA / GDPR-K age gate:
 *
 *  - legal_acceptances : append-only record of (documentType, version)
 *                        that the tenant has accepted, with timestamp and
 *                        actor. Re-acceptance after a material update
 *                        inserts a new row rather than mutating the old
 *                        one — proof of consent must be tamper-resistant.
 *  - incident_reports  : user-submitted reports of unexpected autonomous
 *                        behaviour. Required by the EU AI Act human
 *                        oversight clauses.
 *  - age_confirmations : singleton-per-tenant age-gate verdict captured
 *                        at account creation (COPPA / GDPR-K).
 *
 * `legal_acceptances` and `incident_reports` are append-only audit-class
 * tables and intentionally omit the `version` column (Standard 6 carve-out
 * for audit-class tables — same pattern as `audit_log_entries` and
 * `activity_events`).
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS legal_acceptances (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    user_id TEXT,
    document_type TEXT NOT NULL,
    document_version TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    accepted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    locale TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_legal_acceptances_tenant ON legal_acceptances(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_legal_acceptances_workspace ON legal_acceptances(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_legal_acceptances_doc ON legal_acceptances(tenant_id, document_type);
  CREATE INDEX IF NOT EXISTS idx_legal_acceptances_accepted ON legal_acceptances(tenant_id, accepted_at);

  CREATE TABLE IF NOT EXISTS incident_reports (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    user_id TEXT,
    category TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    related_run_id TEXT,
    related_approval_id TEXT,
    contact_email TEXT,
    status TEXT NOT NULL DEFAULT 'submitted',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_incident_reports_tenant ON incident_reports(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_incident_reports_workspace ON incident_reports(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_incident_reports_status ON incident_reports(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_incident_reports_created ON incident_reports(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS age_confirmations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    user_id TEXT,
    jurisdiction TEXT NOT NULL DEFAULT 'global',
    minimum_age INTEGER NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    confirmed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_age_confirmations_tenant ON age_confirmations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_age_confirmations_workspace ON age_confirmations(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_age_confirmations_unique_tenant
    ON age_confirmations(tenant_id);
`;

const down = `
  DROP TABLE IF EXISTS age_confirmations;
  DROP TABLE IF EXISTS incident_reports;
  DROP TABLE IF EXISTS legal_acceptances;
`;

export const migration: SchemaMigration = {
  id: 13,
  name: "legal_compliance",
  up,
  down,
};
