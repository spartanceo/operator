/**
 * Per-request tenant context, propagated through AsyncLocalStorage so
 * service code never has to thread it through every function call.
 *
 * The middleware in `../middlewares/tenant-context.ts` enters the store on
 * every request; helpers below read it out. Code that needs the context
 * outside an HTTP handler (background jobs, the Resource Governor) creates
 * its own context with `runWithTenantContext()`.
 *
 * Why AsyncLocalStorage instead of a parameter:
 *   - Logger redaction needs it on every log line — passing it everywhere
 *     would mean every function in the codebase grows a `ctx` argument.
 *   - The 60+ remaining tasks each touch routes/services; AsyncLocalStorage
 *     means none of them have to plumb context manually.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantContext } from "@workspace/types";

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Run `fn` with `ctx` bound as the active tenant context. Any nested call
 * to `getTenantContext()` inside `fn` (sync or async) returns this `ctx`.
 */
export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Returns the active context, or undefined if called outside a request /
 * `runWithTenantContext()` block.
 */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/**
 * Returns the active context, or throws — use this from route handlers
 * where the tenant-context middleware MUST have run first.
 */
export function requireTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "Tenant context missing — requireTenantContext() called outside the tenant-context middleware",
    );
  }
  return ctx;
}

export type { TenantContext };
