/**
 * Migration 0028 — subscription billing + premium-skill monetisation.
 *
 * Adds:
 *   - `subscriptions`             — per-tenant Stripe-stub subscription row.
 *   - `skill_usage_events`        — append-only log of premium skill runs,
 *                                   used by both the subscriber usage view
 *                                   and the creator revenue dashboard.
 *   - `skill_preview_counters`    — per-(tenant, skill) free-preview tally.
 *
 * Mutates:
 *   - `skills.is_premium`              (bool, default 0)
 *   - `skills.preview_uses_allowed`    (int, default 2)
 *   - `store_skills.is_premium`        (bool, default 0)
 *   - `store_skills.preview_uses_allowed` (int, default 2)
 */
import type { SchemaMigration } from "./types";

const up = `
  ALTER TABLE skills ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE skills ADD COLUMN preview_uses_allowed INTEGER NOT NULL DEFAULT 2;
  ALTER TABLE store_skills ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE store_skills ADD COLUMN preview_uses_allowed INTEGER NOT NULL DEFAULT 2;

  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    status TEXT NOT NULL DEFAULT 'inactive',
    plan_id TEXT NOT NULL DEFAULT 'creator_pro',
    price_cents INTEGER NOT NULL DEFAULT 1900,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    current_period_end INTEGER,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_tenant ON subscriptions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_workspace ON subscriptions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

  ALTER TABLE skill_usage_events ADD COLUMN skill_slug TEXT;
  ALTER TABLE skill_usage_events ADD COLUMN creator_handle TEXT;
  ALTER TABLE skill_usage_events ADD COLUMN model_name TEXT;
  ALTER TABLE skill_usage_events ADD COLUMN updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000);
  ALTER TABLE skill_usage_events ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE skill_usage_events ADD COLUMN approved_by_user INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE skill_usage_events ADD COLUMN was_preview INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_skill_usage_creator ON skill_usage_events(creator_handle);

  CREATE TABLE IF NOT EXISTS skill_preview_counters (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    skill_id TEXT NOT NULL,
    uses_consumed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_skill_preview_counters_tenant ON skill_preview_counters(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skill_preview_counters_workspace ON skill_preview_counters(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_preview_counters_pair ON skill_preview_counters(tenant_id, skill_id);
`;

const down = `
  DROP TABLE IF EXISTS skill_preview_counters;
  DROP TABLE IF EXISTS subscriptions;
`;

export const migration: SchemaMigration = {
  id: 28,
  name: "subscription_monetisation",
  up,
  down,
};
