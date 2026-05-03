/**
 * Migration 0033 — backup, restore & data portability (Task #20).
 *
 * Adds two singleton/append-only tables that back the user-facing backup
 * surface:
 *   - backup_settings — singleton-per-tenant configuration row
 *     (auto-backup cadence, retention count, target directory, opt-in
 *     cloud provider + encrypted settings, encryption salt). The row id
 *     equals the tenantId so the upsert path stays deterministic.
 *   - backup_jobs    — append-only history of every backup attempt with
 *     checksum, encryption metadata, byte size, status lifecycle
 *     (pending → running → completed | failed | verified | restored),
 *     trigger source (manual / scheduled / cloud), and error envelope.
 *
 * FK + tenant indexes follow Standard 18 — tenant + status + cadence cursor
 * for the scheduler scan.
 *
 * The down script drops both tables.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS backup_settings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    schedule TEXT NOT NULL DEFAULT 'off',
    target_directory TEXT,
    retention_count INTEGER NOT NULL DEFAULT 7,
    encryption_salt TEXT NOT NULL,
    cloud_provider TEXT,
    cloud_settings TEXT,
    cloud_enabled INTEGER NOT NULL DEFAULT 0,
    last_backup_at INTEGER,
    next_backup_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_backup_settings_tenant ON backup_settings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_backup_settings_next ON backup_settings(next_backup_at);

  CREATE TABLE IF NOT EXISTS backup_jobs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    trigger TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'pending',
    encryption TEXT NOT NULL DEFAULT 'aes-256-gcm',
    file_path TEXT,
    cloud_target TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    checksum TEXT,
    document_count INTEGER NOT NULL DEFAULT 0,
    memory_count INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    snapshot_version TEXT NOT NULL DEFAULT '1',
    schema_version INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_backup_jobs_tenant ON backup_jobs(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_backup_jobs_workspace ON backup_jobs(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_backup_jobs_status ON backup_jobs(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_backup_jobs_created ON backup_jobs(tenant_id, created_at);
`;

const down = `
  DROP TABLE IF EXISTS backup_jobs;
  DROP TABLE IF EXISTS backup_settings;
`;

export const migration: SchemaMigration = {
  id: 33,
  name: "backups",
  up,
  down,
};
