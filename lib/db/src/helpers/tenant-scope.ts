/**
 * Standard 13 — canonical tenant-scoping helpers.
 *
 * The contract is:
 *   import { db, tenantScope, withTenant, assertTenant } from "@workspace/db";
 *
 *   // Reads — predicate every query MUST use:
 *   const rows = await db.select().from(skills).where(tenantScope(ctx, skills));
 *
 *   // Writes — stamps tenant_id (+ workspace_id when relevant) onto inserts:
 *   await db.insert(skills).values(withTenant(ctx, { name: "x" }));
 *
 *   // Defence-in-depth — for any hand-written query / RPC payload, validate
 *   // that the row belongs to the request's tenant before acting on it:
 *   const skill = assertTenant(ctx, await db.select()...where(eq(skills.id, id)));
 *
 * Every service and route file under `artifacts/api-server/src/{services,routes}`
 * that imports `db` MUST also import one of these helpers — the tier-review
 * gate (Check #15) enforces it.
 *
 * Why this is the only allowed shape:
 *   - Hand-rolled `eq(t.tenantId, ctx.tenantId)` predicates drift across 60
 *     tasks; one missing branch = cross-tenant data leak.
 *   - A single helper is auditable: the GDPR `status = 'erased'` exclusion is
 *     applied automatically to every table that has a `status` column.
 *   - `assertTenant` exists for the rare paths that cannot use `tenantScope`
 *     (e.g. id-based lookups joined to external IDs); it is the runtime
 *     guard that catches accidental cross-tenant access.
 */
import { and, eq, ne, type AnyColumn, type SQL } from "drizzle-orm";
import type { TenantContext } from "@workspace/types";

/**
 * Minimum shape of a Drizzle table that can be tenant-scoped: it must
 * expose a `tenantId` column. `workspaceId` and `status` are optional —
 * if the table has them, additional predicates are added automatically.
 *
 * `AnyColumn` is Drizzle's official escape hatch for "any column from any
 * table" and is what `eq()` / `ne()` accept; using it here lets the helper
 * be table-agnostic without leaking the deeply generic column generics
 * into every consumer's call site, and avoids `any` escapes entirely.
 */
export interface TenantScopedTable {
  readonly tenantId: AnyColumn;
  readonly workspaceId?: AnyColumn;
  readonly status?: AnyColumn;
}

/**
 * Build the standard WHERE expression for a tenant-scoped query.
 *
 * Always filters by `tenantId`. Additionally:
 *   - When the table has a `workspaceId` column AND the request context
 *     carries a workspaceId, that is added with AND — narrower scope is the
 *     safe default for multi-workspace data.
 *   - When the table has a `status` column, rows with `status = 'erased'`
 *     are excluded. This is the GDPR soft-delete contract documented in
 *     `@workspace/types#TenantStatus`. A tenant marked `erased` by the
 *     `/api/admin/tenant-data` DELETE endpoint becomes invisible to every
 *     subsequent tenant-scoped query without each call site needing to
 *     remember to filter.
 *
 * Returns a non-null `SQL` so callers can pass it directly to `.where(...)`
 * or compose with `and(...)`.
 */
export function tenantScope<T extends TenantScopedTable>(
  ctx: TenantContext,
  table: T,
): SQL {
  const conditions: SQL[] = [eq(table.tenantId, ctx.tenantId)];
  if (table.workspaceId !== undefined && ctx.workspaceId) {
    conditions.push(eq(table.workspaceId, ctx.workspaceId));
  }
  if (table.status !== undefined) {
    // GDPR soft-delete: erased rows are invisible to tenant-scoped reads.
    conditions.push(ne(table.status, "erased"));
  }
  // and(...) returns SQL when at least one condition is provided.
  return and(...conditions) as SQL;
}

/**
 * Sanctioned alias for write paths — semantically identical to `tenantScope`
 * for SELECT/UPDATE/DELETE WHERE clauses. For INSERTs, prefer the
 * value-stamping form `withTenantValues(ctx, values)` below.
 *
 * Both `tenantScope` and `withTenant` satisfy tier-review Check #15.
 */
export const withTenant = tenantScope;

/**
 * INSERT-side companion to `tenantScope`: stamps `tenantId` (and
 * `workspaceId` when the request carries one) onto a values object.
 *
 *   await db.insert(skills).values(withTenantValues(ctx, { name: "x" }));
 *
 * Caller-provided fields win — this helper never silently overwrites a
 * tenantId that was set explicitly. That keeps the helper honest about
 * "additive defaults"; if a caller deliberately passes a different
 * tenantId, `assertTenant` is the right second line of defence.
 */
export function withTenantValues<V extends Record<string, unknown>>(
  ctx: TenantContext,
  values: V,
): V & { tenantId: string; workspaceId?: string } {
  return {
    tenantId: ctx.tenantId,
    ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    ...values,
  } as V & { tenantId: string; workspaceId?: string };
}

/**
 * Runtime tenant-isolation guard.
 *
 * Used by hand-written queries, RPC payload validators, and any code path
 * that doesn't go through `tenantScope`. Throws if the row's `tenantId`
 * doesn't match the request context, or if the row carries a `workspaceId`
 * that disagrees with the bound workspace.
 *
 * Overloads:
 *   - `assertTenant(ctx, row)`         → returns the row, throws if mismatch.
 *   - `assertTenant(ctx, row | null)`  → passes null through; throws otherwise.
 *
 * The throw is a hard error (`TenantIsolationError`) — never catch and
 * swallow it. In production it surfaces as 500 INTERNAL via the central
 * error handler; the request id in the log is the audit trail.
 */
export class TenantIsolationError extends Error {
  override readonly name = "TenantIsolationError";
  constructor(message: string) {
    super(message);
  }
}

interface TenantScopedRow {
  readonly tenantId?: string | null;
  readonly workspaceId?: string | null;
}

export function assertTenant<R extends TenantScopedRow>(
  ctx: TenantContext,
  row: R,
): R;
export function assertTenant<R extends TenantScopedRow>(
  ctx: TenantContext,
  row: R | null | undefined,
): R | null;
export function assertTenant<R extends TenantScopedRow>(
  ctx: TenantContext,
  row: R | null | undefined,
): R | null {
  if (row === null || row === undefined) return null;
  if (row.tenantId !== ctx.tenantId) {
    throw new TenantIsolationError(
      `Row tenantId=${String(row.tenantId)} does not match request tenant ${ctx.tenantId}`,
    );
  }
  if (
    ctx.workspaceId !== undefined &&
    row.workspaceId !== undefined &&
    row.workspaceId !== null &&
    row.workspaceId !== ctx.workspaceId
  ) {
    throw new TenantIsolationError(
      `Row workspaceId=${String(row.workspaceId)} does not match request workspace ${ctx.workspaceId}`,
    );
  }
  return row;
}

export type { TenantContext } from "@workspace/types";
