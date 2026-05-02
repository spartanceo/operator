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

const TENANT_HEADER = "x-tenant-id";
const WORKSPACE_HEADER = "x-workspace-id";
const USER_HEADER = "x-user-id";

/**
 * If the tenant header is present, populate the AsyncLocalStorage context
 * for the duration of the request. Missing header is allowed here —
 * `requireTenant()` is the gate that rejects anonymous requests.
 */
export function tenantContext() {
  return function tenantContextMiddleware(
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

    const ctx: TenantContext = {
      tenantId,
      workspaceId,
      ...(userId !== undefined ? { userId } : {}),
      requestId,
    };
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
