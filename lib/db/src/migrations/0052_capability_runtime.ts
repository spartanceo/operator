/**
 * Migration 0052 — capability_settings table.
 *
 * Task #237 extended the runtime switcher to all non-LLM AI capability types
 * (ImageGen, WebSearch, TTS, Embeddings, CodeSandbox). This table stores one
 * row per (tenant, capability_type) recording the operator's chosen backend.
 *
 * A NULL activeBackendId means "not configured" — the UI prompts the user to
 * pick a backend. This is the correct default for capabilities that may not
 * have any local service running.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS capability_settings (
    id                TEXT    PRIMARY KEY NOT NULL,
    tenant_id         TEXT    NOT NULL REFERENCES tenants(id),
    capability_type   TEXT    NOT NULL,
    active_backend_id TEXT,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version           INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_capability_settings_tenant
    ON capability_settings(tenant_id);

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_capability_settings_tenant_type
    ON capability_settings(tenant_id, capability_type);
`;

const down = `
  DROP INDEX IF EXISTS uniq_capability_settings_tenant_type;
  DROP INDEX IF EXISTS idx_capability_settings_tenant;
  DROP TABLE IF EXISTS capability_settings;
`;

export const migration: SchemaMigration = {
  id: 52,
  name: "capability_runtime",
  up,
  down,
};
