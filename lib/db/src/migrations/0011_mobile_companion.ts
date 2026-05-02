/**
 * Migration 0010 — Mobile Companion PWA.
 *
 * Adds the five tables that back Task #24's mobile companion feature:
 * paired devices, short-lived pairing tokens (QR codes), Web Push
 * subscriptions, per-workspace notification preferences, and the queue of
 * "quick tasks" dictated from the phone.
 *
 * Every table is tenant + workspace scoped (push subscriptions inherit
 * tenant from their device) and indexed on the dimensions the services
 * filter by. Up uses IF NOT EXISTS so re-runs are safe.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS paired_devices (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    label TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'web',
    user_agent TEXT,
    token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    paired_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    last_seen_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_paired_devices_tenant ON paired_devices(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_paired_devices_workspace ON paired_devices(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_paired_devices_status ON paired_devices(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_paired_devices_token ON paired_devices(token_hash);

  CREATE TABLE IF NOT EXISTS pairing_tokens (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    code TEXT NOT NULL,
    relay_token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_at INTEGER,
    device_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_pairing_tokens_tenant ON pairing_tokens(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_pairing_tokens_workspace ON pairing_tokens(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_pairing_tokens_code ON pairing_tokens(tenant_id, code);
  CREATE INDEX IF NOT EXISTS idx_pairing_tokens_expires ON pairing_tokens(expires_at);

  CREATE TABLE IF NOT EXISTS mobile_push_subscriptions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    device_id TEXT NOT NULL REFERENCES paired_devices(id),
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_mobile_push_tenant ON mobile_push_subscriptions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_mobile_push_device ON mobile_push_subscriptions(device_id);

  CREATE TABLE IF NOT EXISTS mobile_notification_prefs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    task_completed INTEGER NOT NULL DEFAULT 1,
    approval_needed INTEGER NOT NULL DEFAULT 1,
    task_failed INTEGER NOT NULL DEFAULT 1,
    long_task_progress INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_mobile_prefs_tenant ON mobile_notification_prefs(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_mobile_prefs_workspace ON mobile_notification_prefs(tenant_id, workspace_id);

  CREATE TABLE IF NOT EXISTS mobile_quick_tasks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    device_id TEXT NOT NULL REFERENCES paired_devices(id),
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    delivered_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_mobile_quick_tasks_tenant ON mobile_quick_tasks(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_mobile_quick_tasks_workspace ON mobile_quick_tasks(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_mobile_quick_tasks_status ON mobile_quick_tasks(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_mobile_quick_tasks_device ON mobile_quick_tasks(device_id);
`;

const down = `
  DROP TABLE IF EXISTS mobile_quick_tasks;
  DROP TABLE IF EXISTS mobile_notification_prefs;
  DROP TABLE IF EXISTS mobile_push_subscriptions;
  DROP TABLE IF EXISTS pairing_tokens;
  DROP TABLE IF EXISTS paired_devices;
`;

export const migration: SchemaMigration = {
  id: 11,
  name: "mobile_companion",
  up,
  down,
};
