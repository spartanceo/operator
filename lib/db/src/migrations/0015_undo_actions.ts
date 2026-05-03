/**
 * Migration 0015 — undo stack for desktop / file actions (Task #44).
 *
 * Adds the `undo_actions` table that records a JSON snapshot of the
 * before-state of every reversible action OP performs, plus an
 * `IRREVERSIBLE` audit row for actions like email send / terminal
 * commands. The reversal executors in `undo.service.ts` consume rows
 * from this table to roll the world back one step at a time.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS undo_actions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    task_id TEXT,
    action_type TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    target TEXT,
    reversible INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'available',
    before_state TEXT,
    after_state TEXT,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    undone_at INTEGER,
    expires_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_undo_actions_tenant ON undo_actions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_undo_actions_workspace ON undo_actions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_undo_actions_task ON undo_actions(tenant_id, task_id);
  CREATE INDEX IF NOT EXISTS idx_undo_actions_status ON undo_actions(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_undo_actions_created ON undo_actions(tenant_id, created_at);
`;

const down = `
  DROP TABLE IF EXISTS undo_actions;
`;

export const migration: SchemaMigration = {
  id: 15,
  name: "undo_actions",
  up,
  down,
};
