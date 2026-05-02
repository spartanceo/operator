/**
 * Migration 0002 — onboarding_profiles.
 *
 * Adds a singleton-per-tenant table that powers the first-run setup wizard,
 * starter-task chips, the first-approval tooltip, and the success-sparkle
 * celebration. The completion / first-task / tooltip flags are monotonic
 * — once set to 1 in the upsert service, they cannot be cleared by a
 * stale client payload, so the wizard never re-appears after a one-time
 * dismissal.
 *
 * Introduced as a follow-on to the 0001 baseline (Task #37 framework)
 * during the Task #8 rebase rather than back-patched into baseline so
 * already-migrated databases pick this up cleanly without a checksum drift.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS onboarding_profiles (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    display_name TEXT,
    user_type TEXT,
    use_case TEXT,
    recommended_model TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    first_task_completed INTEGER NOT NULL DEFAULT 0,
    approval_tooltip_seen INTEGER NOT NULL DEFAULT 0,
    hardware_snapshot TEXT,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_onboarding_profiles_tenant ON onboarding_profiles(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_onboarding_profiles_completed ON onboarding_profiles(tenant_id, completed);
`;

const down = `
  DROP TABLE IF EXISTS onboarding_profiles;
`;

export const migration: SchemaMigration = {
  id: 2,
  name: "onboarding_profiles",
  up,
  down,
};
