/**
 * Tenant-context middleware (Task #72).
 *
 * Identity resolution order:
 *   1. Session cookie (`omninity.sid`) — preferred after login/register.
 *      The session row carries tenantId + userId; we also resolve the user's
 *      role so requireRole() guards can check it without an extra query.
 *      workspaceId is derived as `default-{tenantId}` (matches the bootstrap
 *      convention in auth.service.ts / ensureTenantWorkspace).
 *   2. X-Tenant-ID header fallback — kept for automated tests and for the
 *      very first bootstrap request (before any session exists). Header
 *      requests still go through ensureTenantWorkspace to seed DB rows.
 *
 * Every other route reads context via getTenantContext() /
 * requireTenantContext() — none of them need to change.
 */
import type { NextFunction, Request, Response } from "express";
import type { TenantContext, TenantRole } from "@workspace/types";

import { requireTenantContext, runWithTenantContext } from "../lib/tenant-context";
import { err } from "../lib/api-envelope";
import { ensureTenantWorkspace } from "../lib/tenant-ensure";
import { listConfirmedRuntimeIds } from "../lib/cloud-session";
import { getSessionUnscoped } from "../services/auth.service";

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
 * Populate the AsyncLocalStorage TenantContext for the duration of the
 * request. Prefers session-based identity (Task #72); falls back to the
 * X-Tenant-ID header for automated tests and the initial bootstrap request
 * (before any session exists).
 */
export function tenantContext() {
  return async function tenantContextMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const requestId = (res.locals["requestId"] as string | undefined) ?? "req_unknown";
    const confirmedRuntimeIds = listConfirmedRuntimeIds(req);

    // ── 1. Session-based identity (preferred post-login) ──────────────────
    const sessionId = req.session?.sessionId;
    if (sessionId) {
      try {
        const sess = await getSessionUnscoped(sessionId);
        if (sess) {
          const workspaceId = `default-${sess.tenantId}`;
          const ctx: TenantContext = {
            tenantId: sess.tenantId,
            workspaceId,
            userId: sess.userId,
            role: sess.role as TenantRole,
            requestId,
            confirmedRuntimeIds,
          };
          runWithTenantContext(ctx, () => next());
          return;
        }
        // Session id in cookie but row is expired/missing — clear the stale
        // field so the client gets a clean 401 rather than a loop.
        req.session.sessionId = undefined;
      } catch {
        // Session lookup failure is non-fatal — fall through to header path.
      }
    }

    // ── 2. Header-based fallback (automated tests + pre-auth bootstrap) ───
    const tenantId = req.header(TENANT_HEADER);

    if (!tenantId) {
      // Neither session nor header — continue without context.
      // requireTenant() will 401 if the route needs authentication.
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
 * After Task #72 this passes when either a valid session cookie OR an
 * X-Tenant-ID header is present (header kept for automated tests).
 */
export function requireTenant() {
  return function requireTenantMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const hasSession = Boolean(req.session?.sessionId);
    const hasHeader = Boolean(req.header(TENANT_HEADER));
    if (!hasSession && !hasHeader) {
      res.status(401).json(err("UNAUTHENTICATED", "Authentication required"));
      return;
    }
    next();
  };
}

/**
 * Role guard: rejects with 401/403 unless the authenticated user holds one
 * of the specified roles. Must be placed AFTER requireTenant() so the
 * TenantContext is already in AsyncLocalStorage.
 *
 * Header-based requests (automated tests) carry no role — they are treated
 * as implicitly privileged in test environments only.
 *
 * Usage: `router.delete("/tenant-data", requireRole("owner", "admin"), handler)`
 */
export function requireRole(...roles: TenantRole[]) {
  return function requireRoleMiddleware(
    _req: Request,
    res: Response,
    next: NextFunction,
  ) {
    let ctx: TenantContext;
    try {
      ctx = requireTenantContext();
    } catch {
      res.status(401).json(err("UNAUTHENTICATED", "Authentication required"));
      return;
    }

    const role = ctx.role;

    if (!role) {
      // No role in context → header-based request (test / bootstrap path).
      // Allow only in test mode; production always requires a real session.
      if (process.env["NODE_ENV"] === "test") {
        next();
        return;
      }
      res.status(401).json(err("UNAUTHENTICATED", "Authentication required"));
      return;
    }

    if (!roles.includes(role)) {
      res.status(403).json(err("FORBIDDEN", "Insufficient permissions for this action"));
      return;
    }

    next();
  };
}
