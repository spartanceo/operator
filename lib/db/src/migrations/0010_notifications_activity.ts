/**
 * Migration 0010 — notifications + activity centre (Task #23).
 *
 * Adds three tables that power the in-app notification bell, the activity
 * feed page, and the per-category notification preferences screen:
 *
 *  - notifications              : per-tenant in-app + OS notification rows.
 *  - notification_preferences   : singleton-per-tenant category opt-in JSON.
 *  - activity_events            : append-only chronological "what OP did" feed.
 *
 * The `activity_events` table intentionally omits the `version` column
 * because the service layer treats it as append-only (Standard 6 carve-out
 * for audit-class tables, same as `audit_log_entries`).
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    category TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    action_label TEXT,
    action_href TEXT,
    related_run_id TEXT,
    related_approval_id TEXT,
    read_at INTEGER,
    dispatched_to_os INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON notifications(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(tenant_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(tenant_id, category);

  CREATE TABLE IF NOT EXISTS notification_preferences (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    preferences TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_notification_prefs_tenant ON notification_preferences(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_notification_prefs_workspace ON notification_preferences(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_prefs_unique_tenant
    ON notification_preferences(tenant_id, workspace_id);

  CREATE TABLE IF NOT EXISTS activity_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    agent TEXT,
    skill_name TEXT,
    run_id TEXT,
    tool_call_id TEXT,
    approval_id TEXT,
    summary TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'success',
    duration_ms INTEGER,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_activity_events_tenant ON activity_events(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_activity_events_workspace ON activity_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_activity_events_created ON activity_events(tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_activity_events_type ON activity_events(tenant_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_activity_events_agent ON activity_events(tenant_id, agent);
  CREATE INDEX IF NOT EXISTS idx_activity_events_run ON activity_events(tenant_id, run_id);
`;

const down = `
  DROP TABLE IF EXISTS activity_events;
  DROP TABLE IF EXISTS notification_preferences;
  DROP TABLE IF EXISTS notifications;
`;

export const migration: SchemaMigration = {
  id: 10,
  name: "notifications_activity",
  up,
  down,
};
