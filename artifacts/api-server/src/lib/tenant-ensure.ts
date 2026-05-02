/**
 * Lazy tenant + workspace bootstrap.
 *
 * Several services (mobile pairing, push, dashboard) accept the very first
 * write for a tenant — there is no separate provisioning step. This helper
 * guarantees the parent rows exist before any FK-bearing insert runs, so
 * services don't crash on `SQLITE_CONSTRAINT_FOREIGNKEY` when a brand-new
 * `X-Tenant-Id` is used.
 *
 * Idempotent: each lookup is `SELECT ... LIMIT 1` followed by an `INSERT`
 * only if the row is missing. Concurrent calls are safe because the
 * inserts are guarded by a primary-key check first.
 */
import { eq } from "drizzle-orm";
import { db, tenants, workspaces } from "@workspace/db";
import type { TenantContext } from "@workspace/types";

export async function ensureTenantWorkspace(ctx: TenantContext): Promise<void> {
  const existingTenant = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, ctx.tenantId))
    .limit(1);
  if (existingTenant.length === 0) {
    await db
      .insert(tenants)
      .values({
        id: ctx.tenantId,
        tenantId: ctx.tenantId,
        name: `Tenant ${ctx.tenantId}`,
        status: "active",
      })
      .onConflictDoNothing();
  }
  const wsId = ctx.workspaceId;
  if (!wsId) return;
  const existingWs = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, wsId))
    .limit(1);
  if (existingWs.length === 0) {
    await db
      .insert(workspaces)
      .values({
        id: wsId,
        tenantId: ctx.tenantId,
        name: "Default Workspace",
        status: "active",
      })
      .onConflictDoNothing();
  }
}
