/**
 * Tenant-context middleware.
 *
 * Until Task #4 (Authentication) lands, the tenant identifier is read from
 * the `X-Tenant-ID` header. Once auth ships, this middleware will be the
 * one place that swaps in JWT-derived context — every other route will
 * keep working unchanged because they read context via `getTenantContext()`.
 *
 * Routes that require a tenant context use the `requireTenant()` middleware
 * exported below; public routes (e.g. `/healthz`) do not, and skip the
 * 401 short-circuit.
 */
import type { NextFunction, Request, Response } from "express";
import type { TenantContext } from "@workspace/types";

import { runWithTenantContext } from "../lib/tenant-context";
import { err } from "../lib/api-envelope";
import { ensureTenantWorkspace } from "../lib/tenant-ensure";
import { listConfirmedRuntimeIds } from "../lib/cloud-session";

const TENANT_HEADER = "x-tenant-id";
const WORKSPACE_HEADER = "x-workspace-id";
const USER_HEADER = "x-user-id";

// In-process bootstrap cache. Once we have successfully ensured the
// `tenants` + `workspaces` rows for a `${tenantId}:${workspaceId}` pair
// in this process, every subsequent request can skip the two SELECTs.
// Bounded — capped at MAX_BOOTSTRAP_CACHE entries with FIFO eviction so
// we never accumulate unbounded memory if a long-running process sees
// many distinct tenants (multi-user installs, tests).
const MAX_BOOTSTRAP_CACHE = 1024;
// tier-review: bounded — FIFO-evicted past MAX_BOOTSTRAP_CACHE entries.
const bootstrappedPairs = new Set<string>();

function rememberBootstrapped(key: string): void {
  bootstrappedPairs.add(key);
  if (bootstrappedPairs.size > MAX_BOOTSTRAP_CACHE) {
    const oldest = bootstrappedPairs.values().next().value;
    if (oldest !== undefined) bootstrappedPairs.delete(oldest);
  }
}

/** Test-only: drop the cache so a fresh DB starts from a clean slate. */
export function clearTenantBootstrapCacheForTests(): void {
  bootstrappedPairs.clear();
}

/**
 * If the tenant header is present, populate the AsyncLocalStorage context
 * for the duration of the request. Missing header is allowed here —
 * `requireTenant()` is the gate that rejects anonymous requests.
 *
 * On the first request we see for a `(tenantId, workspaceId)` pair, this
 * middleware also lazily seeds the parent `tenants` + `workspaces` rows
 * via `ensureTenantWorkspace`. Without this, every tenant-scoped write
 * (model select, install, knowledge ingest, media generate, comm
 * connect, …) would 500 with `SQLITE_CONSTRAINT_FOREIGNKEY` on a fresh
 * install — first surfaced as a wizard-blocking bug after Task #22.
 */
export function tenantContext() {
  return async function tenantContextMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const requestId = (res.locals["requestId"] as string | undefined) ?? "req_unknown";
    const tenantId = req.header(TENANT_HEADER);

    if (!tenantId) {
      // No tenant on this request — continue without entering the store.
      // requireTenant() below will 401 if the route needs one.
      next();
      return;
    }

    // Default the workspace id to a tenant-scoped value when the caller
    // doesn't supply one. `workspaces.id` is a single-column PK, so two
    // tenants can't both own a row with id "default" — we therefore namespace
    // the default by tenantId. Auth bootstrap creates the matching row on
    // first registration.
    const workspaceId =
      req.header(WORKSPACE_HEADER) || `default-${tenantId}`;
    const userId = req.header(USER_HEADER) || undefined;

    // Snapshot per-session cloud confirmations so downstream services
    // (tools, agent orchestrator) inherit them automatically without
    // every signature having to plumb the list. Background jobs that
    // build their own ctx omit this field — deny-by-default for cloud.
    const confirmedRuntimeIds = listConfirmedRuntimeIds(req);

    const ctx: TenantContext = {
      tenantId,
      workspaceId,
      ...(userId !== undefined ? { userId } : {}),
      requestId,
      confirmedRuntimeIds,
    };

    const cacheKey = `${tenantId}:${workspaceId}`;
    if (!bootstrappedPairs.has(cacheKey)) {
      try {
        await ensureTenantWorkspace(ctx);
        rememberBootstrapped(cacheKey);
      } catch (e) {
        // Hard-fail: do NOT swallow. A bootstrap failure means the DB
        // is in a state we don't understand; the downstream insert
        // would also fail and the 5xx must surface to the operator.
        next(e);
        return;
      }
    }

    runWithTenantContext(ctx, () => next());
  };
}

/**
 * Route-level guard: rejects with 401 if no tenant context is bound.
 * Use as `router.get("/foo", requireTenant(), handler)`.
 */
export function requireTenant() {
  return function requireTenantMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (!req.header(TENANT_HEADER)) {
      res
        .status(401)
        .json(err("UNAUTHENTICATED", "Missing X-Tenant-ID header"));
      return;
    }
    next();
  };
}
