/**
 * Migration 0019 — Developer SDK & Plugin API (Task #14).
 *
 * Adds two tables that back the public developer surface:
 *
 *  - plugin_tools         : custom tools registered via the SDK. Each row
 *                           stores a JSON-Schema-validated input
 *                           definition, a risk level (drives the approval
 *                           gate), and the URL of the local sidecar
 *                           process the API server invokes when the
 *                           agent calls the tool.
 *
 *  - webhook_subscriptions: per-tenant webhook delivery targets. The
 *                           in-process event bus posts JSON payloads to
 *                           the registered URL whenever an OP event
 *                           matching the subscription's filter fires.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS plugin_tools (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    risk_level TEXT NOT NULL DEFAULT 'medium',
    input_schema TEXT NOT NULL DEFAULT '{}',
    invoke_url TEXT NOT NULL,
    auth_token TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_plugin_tools_tenant ON plugin_tools(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_plugin_tools_workspace ON plugin_tools(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_tools_tenant_name ON plugin_tools(tenant_id, name);

  CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    event_types TEXT NOT NULL DEFAULT '[]',
    secret TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_delivery_at INTEGER,
    last_delivery_status INTEGER,
    failure_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_subs_tenant ON webhook_subscriptions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_webhook_subs_workspace ON webhook_subscriptions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_webhook_subs_enabled ON webhook_subscriptions(tenant_id, enabled);
`;

const down = `
  DROP TABLE IF EXISTS plugin_tools;
  DROP TABLE IF EXISTS webhook_subscriptions;
`;

export const migration: SchemaMigration = {
  id: 26,
  name: "developer_sdk",
  up,
  down,
};
