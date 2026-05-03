/**
 * Migration 0008 — runtime selection + credentials.
 *
 * Introduced by Task #30 (Model Runtime Abstraction Layer):
 *   - `runtime_settings`     — per-tenant active runtime adapter id and
 *                              default model name. UNIQUE on tenant_id so
 *                              upserts are deterministic.
 *   - `runtime_credentials`  — encrypted API keys for cloud adapters
 *                              (OpenAI, Anthropic). Stored as
 *                              ciphertext + IV + auth tag (AES-256-GCM
 *                              from `services/runtime/credentials.ts`)
 *                              so the SQLite file is safe at rest even
 *                              when the OS keychain is unavailable.
 *
 * The `IF NOT EXISTS` clauses keep this script safe to re-run on a
 * database that already has these tables — important during the
 * rollout window where Tier-1 idempotent boots may have created them
 * before the versioned framework took over.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS runtime_settings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    active_runtime_id TEXT NOT NULL DEFAULT 'ollama',
    default_model TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_runtime_settings_tenant ON runtime_settings(tenant_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_runtime_settings_tenant ON runtime_settings(tenant_id);

  CREATE TABLE IF NOT EXISTS runtime_credentials (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    runtime_id TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_runtime_credentials_tenant ON runtime_credentials(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_runtime_credentials_runtime ON runtime_credentials(tenant_id, runtime_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_runtime_credentials_tenant_runtime ON runtime_credentials(tenant_id, runtime_id);
`;

const down = `
  DROP TABLE IF EXISTS runtime_credentials;
  DROP TABLE IF EXISTS runtime_settings;
`;

export const migration: SchemaMigration = {
  id: 46,
  name: "runtime",
  up,
  down,
};
