/**
 * Migration 0041 — Platform Disaster Recovery & Business Continuity
 * (Task #59).
 *
 * Adds the seven tables that back the DR service:
 *
 *   dr_replicas       — registered hot-standby replicas + lag readings.
 *   dr_snapshots      — daily cold-storage snapshots + integrity verdicts.
 *   dr_runbooks       — written runbooks per failure scenario.
 *   dr_drills         — monthly + quarterly DR drill results.
 *   dr_storage_nodes  — skill-distribution storage node health.
 *   dr_incidents      — platform incidents with severity tier + post-
 *                        incident report fields.
 *   dr_alerts         — append-only ledger of monitor alerts.
 *
 * All tables follow the standard tenant_id / workspace_id / created_at /
 * updated_at / version contract enforced by tier-review.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS dr_replicas (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT 'primary',
    availability_zone TEXT NOT NULL DEFAULT 'az-a',
    role TEXT NOT NULL DEFAULT 'standby',
    replication_mode TEXT NOT NULL DEFAULT 'asynchronous',
    data_class TEXT NOT NULL DEFAULT 'standard',
    status TEXT NOT NULL DEFAULT 'healthy',
    last_probe_at INTEGER,
    lag_seconds INTEGER NOT NULL DEFAULT 0,
    last_failover_at INTEGER,
    last_failover_duration_ms INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_dr_replicas_tenant ON dr_replicas(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_dr_replicas_workspace ON dr_replicas(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_dr_replicas_status ON dr_replicas(tenant_id, status);

  CREATE TABLE IF NOT EXISTS dr_snapshots (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    snapshot_key TEXT NOT NULL,
    cold_storage_uri TEXT NOT NULL,
    cold_storage_provider TEXT NOT NULL DEFAULT 'offsite',
    region TEXT NOT NULL DEFAULT 'eu-west',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    checksum TEXT,
    pitr_log_start_at INTEGER,
    pitr_log_end_at INTEGER,
    verify_status TEXT NOT NULL DEFAULT 'pending',
    verify_at INTEGER,
    verify_failure_reason TEXT,
    row_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_dr_snapshots_tenant ON dr_snapshots(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_dr_snapshots_workspace ON dr_snapshots(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_dr_snapshots_key ON dr_snapshots(tenant_id, snapshot_key);
  CREATE INDEX IF NOT EXISTS idx_dr_snapshots_created ON dr_snapshots(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS dr_runbooks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    scenario TEXT NOT NULL,
    title TEXT NOT NULL,
    severity_tier TEXT NOT NULL DEFAULT 'P1',
    response_sla_minutes INTEGER NOT NULL DEFAULT 30,
    body TEXT NOT NULL,
    last_reviewed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_dr_runbooks_tenant ON dr_runbooks(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_dr_runbooks_workspace ON dr_runbooks(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_dr_runbooks_scenario ON dr_runbooks(tenant_id, scenario);

  CREATE TABLE IF NOT EXISTS dr_drills (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL DEFAULT 'monthly',
    snapshot_id TEXT,
    overall_status TEXT NOT NULL DEFAULT 'pending',
    checks TEXT NOT NULL DEFAULT '[]',
    actual_rto_ms INTEGER,
    actual_rpo_seconds INTEGER,
    started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    completed_at INTEGER,
    notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_dr_drills_tenant ON dr_drills(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_dr_drills_workspace ON dr_drills(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_dr_drills_kind ON dr_drills(tenant_id, kind);
  CREATE INDEX IF NOT EXISTS idx_dr_drills_created ON dr_drills(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS dr_storage_nodes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT 'eu-west',
    endpoint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'healthy',
    last_probe_at INTEGER,
    stored_packages INTEGER NOT NULL DEFAULT 0,
    capacity_bytes INTEGER NOT NULL DEFAULT 0,
    used_bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_dr_storage_nodes_tenant ON dr_storage_nodes(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_dr_storage_nodes_workspace ON dr_storage_nodes(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_dr_storage_nodes_status ON dr_storage_nodes(tenant_id, status);

  CREATE TABLE IF NOT EXISTS dr_incidents (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    severity_tier TEXT NOT NULL DEFAULT 'P2',
    scenario TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    runbook_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    detected_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    acknowledged_at INTEGER,
    resolved_at INTEGER,
    timeline TEXT,
    impact TEXT,
    root_cause TEXT,
    remediation TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_dr_incidents_tenant ON dr_incidents(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_dr_incidents_workspace ON dr_incidents(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_dr_incidents_status ON dr_incidents(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_dr_incidents_severity ON dr_incidents(tenant_id, severity_tier);

  CREATE TABLE IF NOT EXISTS dr_alerts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL,
    severity_tier TEXT NOT NULL DEFAULT 'P1',
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    incident_id TEXT,
    acknowledged_at INTEGER,
    acknowledged_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_dr_alerts_tenant ON dr_alerts(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_dr_alerts_workspace ON dr_alerts(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_dr_alerts_kind ON dr_alerts(tenant_id, kind);
  CREATE INDEX IF NOT EXISTS idx_dr_alerts_created ON dr_alerts(tenant_id, created_at);
`;

const down = `
  DROP INDEX IF EXISTS idx_dr_alerts_created;
  DROP INDEX IF EXISTS idx_dr_alerts_kind;
  DROP INDEX IF EXISTS idx_dr_alerts_workspace;
  DROP INDEX IF EXISTS idx_dr_alerts_tenant;
  DROP TABLE IF EXISTS dr_alerts;
  DROP INDEX IF EXISTS idx_dr_incidents_severity;
  DROP INDEX IF EXISTS idx_dr_incidents_status;
  DROP INDEX IF EXISTS idx_dr_incidents_workspace;
  DROP INDEX IF EXISTS idx_dr_incidents_tenant;
  DROP TABLE IF EXISTS dr_incidents;
  DROP INDEX IF EXISTS idx_dr_storage_nodes_status;
  DROP INDEX IF EXISTS idx_dr_storage_nodes_workspace;
  DROP INDEX IF EXISTS idx_dr_storage_nodes_tenant;
  DROP TABLE IF EXISTS dr_storage_nodes;
  DROP INDEX IF EXISTS idx_dr_drills_created;
  DROP INDEX IF EXISTS idx_dr_drills_kind;
  DROP INDEX IF EXISTS idx_dr_drills_workspace;
  DROP INDEX IF EXISTS idx_dr_drills_tenant;
  DROP TABLE IF EXISTS dr_drills;
  DROP INDEX IF EXISTS uq_dr_runbooks_scenario;
  DROP INDEX IF EXISTS idx_dr_runbooks_workspace;
  DROP INDEX IF EXISTS idx_dr_runbooks_tenant;
  DROP TABLE IF EXISTS dr_runbooks;
  DROP INDEX IF EXISTS idx_dr_snapshots_created;
  DROP INDEX IF EXISTS idx_dr_snapshots_key;
  DROP INDEX IF EXISTS idx_dr_snapshots_workspace;
  DROP INDEX IF EXISTS idx_dr_snapshots_tenant;
  DROP TABLE IF EXISTS dr_snapshots;
  DROP INDEX IF EXISTS idx_dr_replicas_status;
  DROP INDEX IF EXISTS idx_dr_replicas_workspace;
  DROP INDEX IF EXISTS idx_dr_replicas_tenant;
  DROP TABLE IF EXISTS dr_replicas;
`;

export const migration: SchemaMigration = {
  id: 42,
  name: "disaster_recovery",
  up,
  down,
};
