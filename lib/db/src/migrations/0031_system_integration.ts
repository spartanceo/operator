/**
 * Migration 0031 — system-level integration (Task #52).
 *
 * Adds two tables that back the global hotkey, quick-input overlay,
 * right-click "Ask OP" services, menu bar / system tray, focus-mode and
 * login-item controls used by the Electron desktop shell:
 *
 *  - desktop_integration_settings : singleton-per-tenant configuration
 *      (hotkey binding, focus-mode awareness, login-item opt-in,
 *      tray badge mode).
 *  - desktop_quick_invocations    : append-friendly history of every
 *      hotkey / right-click / tray invocation, with the source surface,
 *      the optional injected clipboard / selection context, and the
 *      resulting agent run / task id so the activity feed can link back.
 *
 * Both tables are tenant-scoped (Standard 5) and indexed per Standard 13.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS desktop_integration_settings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    hotkey_mac TEXT NOT NULL DEFAULT 'Command+Space+Space',
    hotkey_windows TEXT NOT NULL DEFAULT 'Control+Shift+Space',
    hotkey_enabled INTEGER NOT NULL DEFAULT 1,
    hotkey_conflict TEXT,
    tray_enabled INTEGER NOT NULL DEFAULT 1,
    tray_badge_mode TEXT NOT NULL DEFAULT 'count',
    login_item_enabled INTEGER NOT NULL DEFAULT 0,
    login_item_consent_at INTEGER,
    focus_mode_active INTEGER NOT NULL DEFAULT 0,
    focus_mode_source TEXT,
    focus_mode_updated_at INTEGER,
    right_click_mac_enabled INTEGER NOT NULL DEFAULT 1,
    right_click_windows_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_desktop_int_settings_tenant ON desktop_integration_settings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_desktop_int_settings_workspace ON desktop_integration_settings(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_desktop_int_settings_unique ON desktop_integration_settings(tenant_id, workspace_id);

  CREATE TABLE IF NOT EXISTS desktop_quick_invocations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    source TEXT NOT NULL,
    surface TEXT NOT NULL,
    prompt TEXT NOT NULL,
    context_kind TEXT NOT NULL DEFAULT 'none',
    context_text TEXT,
    application_hint TEXT,
    related_task_id TEXT,
    related_run_id TEXT,
    notification_id TEXT,
    expanded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_desktop_quick_inv_tenant ON desktop_quick_invocations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_desktop_quick_inv_workspace ON desktop_quick_invocations(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_desktop_quick_inv_created ON desktop_quick_invocations(tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_desktop_quick_inv_source ON desktop_quick_invocations(tenant_id, source);
`;

const down = `
  DROP TABLE IF EXISTS desktop_quick_invocations;
  DROP TABLE IF EXISTS desktop_integration_settings;
`;

export const migration: SchemaMigration = {
  id: 31,
  name: "system_integration",
  up,
  down,
};
