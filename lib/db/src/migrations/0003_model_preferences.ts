/**
 * Migration 0003 — model_preferences.
 *
 * Singleton-per-tenant table backing the hardware-aware model recommendation
 * (Task #64). Captures the user's chosen primary model and vision-companion
 * lifecycle policy so they survive across launches and can be edited from
 * Settings independently of the (write-once) onboarding answers.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS model_preferences (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    primary_model TEXT,
    vision_lifecycle_mode TEXT,
    vision_idle_timeout_ms INTEGER,
    catalogue_choice_made INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_model_preferences_tenant ON model_preferences(tenant_id);
`;

const down = `
  DROP TABLE IF EXISTS model_preferences;
`;

export const migration: SchemaMigration = {
  id: 3,
  name: "model_preferences",
  up,
  down,
};
