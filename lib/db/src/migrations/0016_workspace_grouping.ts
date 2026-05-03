/**
 * Migration 0014 — workspaces & project grouping (Task #42).
 *
 * Extends the `workspaces` table with the metadata that backs the new
 * top-level workspace switcher: a free-text description, a colour token, an
 * icon name (lucide identifier on the client), an `is_default` flag so the
 * UI can pin the user's "Personal" workspace, and a `last_active_at`
 * timestamp updated whenever the user switches into the workspace.
 *
 * The migration also backfills:
 *   - The system-seeded `workspace_system` row gets `is_default = 0`,
 *     `name = 'System'`, colour `slate`, icon `cpu`.
 *   - Every other existing workspace whose name is `'Default'` (the row
 *     auto-created by `bootstrapTenant` and the legacy header-driven
 *     middleware) is renamed to `'Personal'`, marked `is_default = 1`,
 *     and given colour `indigo`, icon `home`.
 *
 * The unique partial index `idx_workspaces_one_default` enforces "at most
 * one default workspace per tenant" at the database level so the API
 * doesn't have to rely on application-level guards alone.
 *
 * Down: drops the unique partial index and the new columns. SQLite ≥ 3.35
 * supports `DROP COLUMN` natively; better-sqlite3 ships a recent enough
 * SQLite to honour it.
 */
import type { SchemaMigration } from "./types";

const up = `
  ALTER TABLE workspaces ADD COLUMN description TEXT;
  ALTER TABLE workspaces ADD COLUMN color TEXT;
  ALTER TABLE workspaces ADD COLUMN icon TEXT;
  ALTER TABLE workspaces ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE workspaces ADD COLUMN last_active_at INTEGER;

  UPDATE workspaces
     SET color = 'slate', icon = 'cpu', is_default = 0
   WHERE id = 'workspace_system';

  UPDATE workspaces
     SET name = 'Personal',
         color = COALESCE(color, 'indigo'),
         icon = COALESCE(icon, 'home'),
         is_default = 1
   WHERE id != 'workspace_system'
     AND name IN ('Default', 'Personal')
     AND is_default = 0;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_one_default
    ON workspaces(tenant_id) WHERE is_default = 1;
`;

const down = `
  DROP INDEX IF EXISTS idx_workspaces_one_default;
  ALTER TABLE workspaces DROP COLUMN last_active_at;
  ALTER TABLE workspaces DROP COLUMN is_default;
  ALTER TABLE workspaces DROP COLUMN icon;
  ALTER TABLE workspaces DROP COLUMN color;
  ALTER TABLE workspaces DROP COLUMN description;
`;

export const migration: SchemaMigration = {
  id: 16,
  name: "workspace_grouping",
  up,
  down,
};
