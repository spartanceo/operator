/**
 * Migration 0027 — integrations.
 *
 * Adds the `integrations` table for the platform-integration framework.
 * One row per (tenant, provider) connection. Credentials are stored as
 * encrypted ciphertext in `credentials_encrypted`.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    provider TEXT NOT NULL,
    display_name TEXT NOT NULL,
    auth_type TEXT NOT NULL,
    connection_status TEXT NOT NULL DEFAULT 'disconnected',
    credentials_encrypted TEXT,
    account_label TEXT,
    last_tested_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_integrations_tenant ON integrations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_integrations_workspace ON integrations(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_integrations_provider ON integrations(tenant_id, provider);
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_integrations_tenant_provider ON integrations(tenant_id, provider);
`;

const down = `
  DROP TABLE IF EXISTS integrations;
`;

export const migration: SchemaMigration = {
  id: 27,
  name: "integrations",
  up,
  down,
};
