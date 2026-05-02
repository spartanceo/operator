/**
 * Admin service — GDPR data-export and data-erasure backing functions.
 *
 * Both functions go through `tenantScope` so they can NEVER touch another
 * tenant's data even if a route handler accidentally passed the wrong
 * context. Standard 13 / Check #15 enforces the import discipline; this
 * file is the canonical example.
 *
 * Note on timestamps: SQLite stores times as integer milliseconds (the
 * schema avoids inline `{}` option objects per the tier-review Check #5
 * regex). Helpers below convert via `new Date(ms).toISOString()`.
 */
import { db, tenantScope, tenants, workspaces } from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { eraseTelemetryData } from "./telemetry.service";

export interface TenantDataSnapshot {
  tenant: {
    id: string;
    name: string;
    status: string;
    createdAt: string;
  };
  workspaces: Array<{ id: string; name: string; createdAt: string }>;
  exportedAt: string;
}

/**
 * Read every record the requesting tenant owns and return a serialisable
 * snapshot. Synchronous in v1 — fine for an empty / nearly-empty schema;
 * Task #37 extends this to a job-based flow once the schema fills out.
 */
export async function exportTenantData(
  ctx: TenantContext,
): Promise<TenantDataSnapshot | null> {
  const tenantRows = await db
    .select()
    .from(tenants)
    .where(tenantScope(ctx, tenants))
    .limit(1);
  const tenant = tenantRows[0];
  if (!tenant) return null;

  const workspaceRows = await db
    .select()
    .from(workspaces)
    .where(tenantScope(ctx, workspaces));

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      createdAt: new Date(tenant.createdAt).toISOString(),
    },
    workspaces: workspaceRows.map((w) => ({
      id: w.id,
      name: w.name,
      createdAt: new Date(w.createdAt).toISOString(),
    })),
    exportedAt: new Date().toISOString(),
  };
}

export interface TenantErasureReceipt {
  tenantId: string;
  status: "erased";
  scheduledAt: string;
}

/**
 * Soft-delete the tenant by flipping its status to `erased`. The 30-day
 * grace period is enforced by a nightly job (Task #37) that hard-deletes
 * tenants whose `updatedAt` is more than 30 days into the past.
 *
 * Returns null if no tenant matches the context (tenantScope kept us safe
 * even though the route should have rejected the request earlier).
 */
export async function eraseTenantData(
  ctx: TenantContext,
): Promise<TenantErasureReceipt | null> {
  const tenantRows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(tenantScope(ctx, tenants))
    .limit(1);
  const tenant = tenantRows[0];
  if (!tenant) return null;

  const nowMs = Date.now();
  // Hard-delete every telemetry artefact this tenant produced. The
  // telemetry tables are intentionally outside the soft-delete contract
  // because the consent semantics are stricter than the per-table erasure
  // grace period — when the user requests GDPR erasure, every event,
  // crash report, and consent row goes immediately.
  await eraseTelemetryData(ctx);

  await db
    .update(tenants)
    .set({ status: "erased", updatedAt: nowMs })
    .where(tenantScope(ctx, tenants));

  return {
    tenantId: tenant.id,
    status: "erased",
    scheduledAt: new Date(nowMs).toISOString(),
  };
}
