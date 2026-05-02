/**
 * Migration 0004 — system tenant + workspace.
 *
 * Seeds a single, well-known tenant/workspace pair that owns audit
 * rows produced by background system processes — most prominently the
 * Task #64 vision-companion lifecycle, which fires Ollama keep-alive
 * load/unload calls outside any user request.
 *
 * Why seeded in a migration rather than created on first use:
 *  - Ensures the `privacy_events.tenantId/workspaceId` foreign keys
 *    are always satisfiable for system-context audit logging — there
 *    is no race where the very first vision load loses its audit row
 *    because the FK target row hasn't been INSERTed yet.
 *  - Idempotent (`INSERT OR IGNORE`) so re-running the migration on a
 *    pre-existing DB is a no-op.
 *  - Tier-review Check #15 is unaffected: the helpers continue to
 *    enforce tenant scoping; this migration just guarantees the
 *    sentinel row exists so the FK constraint never fails for legit
 *    system-owned events.
 *
 * IDs are stable string literals (`tenant_system` / `workspace_system`)
 * so application code can reference them as constants. Status is
 * `active` so the GDPR `status != 'erased'` filter never excludes
 * system audit rows from queries.
 *
 * Down: deletes the seeded rows. Tests that depend on the system
 * tenant existing should rely on the up script having been re-applied.
 */
import type { SchemaMigration } from "./types";

const up = `
  INSERT OR IGNORE INTO tenants (id, tenant_id, name, status)
    VALUES ('tenant_system', 'tenant_system', 'System', 'active');
  INSERT OR IGNORE INTO workspaces (id, tenant_id, name, status)
    VALUES ('workspace_system', 'tenant_system', 'System', 'active');
`;

const down = `
  DELETE FROM workspaces WHERE id = 'workspace_system';
  DELETE FROM tenants    WHERE id = 'tenant_system';
`;

export const migration: SchemaMigration = {
  id: 4,
  name: "system_tenant",
  up,
  down,
};
