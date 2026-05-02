#!/usr/bin/env tsx
/**
 * Pure-function tests for the Standard 13 helpers exported from
 * `@workspace/db`. No database connection required — these helpers are
 * either pure (pagination) or build SQL fragments (tenantScope) we can
 * inspect via Drizzle's `SQLiteSyncDialect.sqlToQuery` API.
 *
 * Run with `pnpm --filter @workspace/db run test`.
 */
import assert from "node:assert/strict";

import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

import {
  assertTenant,
  buildPage,
  decodeCursor,
  encodeCursor,
  LRUCache,
  normaliseLimit,
  paginated,
  TenantIsolationError,
  tenantScope,
  withTenant,
  withTenantValues,
} from "./helpers/index";
import { tenants } from "./schema/tenants";
import { workspaces } from "./schema/workspaces";

const dialect = new SQLiteSyncDialect();
const ctx = {
  tenantId: "t_demo",
  workspaceId: "w_demo",
  requestId: "req_test",
} as const;

// ─── tenantScope ─────────────────────────────────────────────────────────────

{
  const q = dialect.sqlToQuery(tenantScope(ctx, tenants));
  assert.match(q.sql, /tenant_id/);
  assert.match(q.sql, /status/);
  assert.deepEqual(q.params, ["t_demo", "erased"]);
  console.log("  ✓  tenantScope(ctx, tenants) emits tenant_id + status!=erased filter");
}

{
  const q = dialect.sqlToQuery(tenantScope(ctx, workspaces));
  assert.match(q.sql, /tenant_id/);
  assert.match(q.sql, /status/);
  assert.deepEqual(q.params, ["t_demo", "erased"]);
  console.log(
    "  ✓  tenantScope(ctx, workspaces) emits tenant_id + status!=erased filter",
  );
}

{
  const fakeTable = { tenantId: tenants.tenantId } as const;
  const q = dialect.sqlToQuery(
    tenantScope(ctx, fakeTable as unknown as typeof tenants),
  );
  assert.deepEqual(q.params, ["t_demo"]);
  console.log("  ✓  tenantScope skips status filter on tables without status column");
}

{
  const a = dialect.sqlToQuery(tenantScope(ctx, tenants));
  const b = dialect.sqlToQuery(withTenant(ctx, tenants));
  assert.equal(a.sql, b.sql);
  assert.deepEqual(a.params, b.params);
  console.log("  ✓  withTenant is identical to tenantScope");
}

// ─── withTenantValues ────────────────────────────────────────────────────────

{
  const v = withTenantValues(ctx, { name: "x" });
  assert.equal(v.tenantId, "t_demo");
  assert.equal(v.workspaceId, "w_demo");
  assert.equal((v as { name: string }).name, "x");
  console.log("  ✓  withTenantValues stamps tenantId + workspaceId");
}

{
  const v = withTenantValues(ctx, { tenantId: "t_other", name: "x" });
  assert.equal(v.tenantId, "t_other");
  console.log("  ✓  withTenantValues respects explicit tenantId from caller");
}

{
  // When the caller's context omits an explicit workspaceId, the helper
  // synthesises a tenant-scoped default (`default-<tenantId>`). This keeps
  // every downstream insert FK-safe against the workspaces table, which
  // rejects nulls.
  const ctxNoWs = { tenantId: "t_demo", requestId: "r" } as const;
  const v = withTenantValues(ctxNoWs, { name: "x" });
  assert.equal(v.tenantId, "t_demo");
  assert.equal(v.workspaceId, "default-t_demo");
  console.log("  ✓  withTenantValues defaults workspaceId to default-<tenantId> when ctx lacks one");
}

// ─── assertTenant ────────────────────────────────────────────────────────────

{
  const row = { id: "1", tenantId: "t_demo", workspaceId: "w_demo" };
  const out = assertTenant(ctx, row);
  assert.equal(out, row);
  console.log("  ✓  assertTenant returns the row when tenantId + workspaceId match");
}

{
  const row = { id: "1", tenantId: "t_other" };
  assert.throws(
    () => assertTenant(ctx, row),
    (err) =>
      err instanceof TenantIsolationError &&
      /does not match request tenant/.test(err.message),
  );
  console.log("  ✓  assertTenant throws TenantIsolationError on tenant mismatch");
}

{
  const row = { id: "1", tenantId: "t_demo", workspaceId: "w_other" };
  assert.throws(
    () => assertTenant(ctx, row),
    (err) => err instanceof TenantIsolationError,
  );
  console.log("  ✓  assertTenant throws on workspace mismatch");
}

{
  assert.equal(assertTenant(ctx, null), null);
  assert.equal(assertTenant(ctx, undefined), null);
  console.log("  ✓  assertTenant returns null for null/undefined rows");
}

{
  const row = { id: "1", tenantId: "t_demo" };
  assert.equal(assertTenant(ctx, row), row);
  console.log("  ✓  assertTenant tolerates rows without workspaceId");
}

// ─── pagination ──────────────────────────────────────────────────────────────

{
  const env = paginated([{ id: "a" }, { id: "b" }], "abc");
  assert.equal(env.items.length, 2);
  assert.equal(env.nextCursor, "abc");
  console.log("  ✓  paginated() wraps items + nextCursor");
}

{
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const page = buildPage(rows, 2, (r) => r.id);
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0]!.id, "a");
  assert.equal(page.items[1]!.id, "b");
  assert.equal(decodeCursor(page.nextCursor!), "b");
  console.log("  ✓  buildPage trims overshoot and encodes the cursor");
}

{
  const page = buildPage([{ id: "a" }], 5, (r) => r.id);
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, null);
  console.log("  ✓  buildPage returns null cursor when no next page");
}

{
  const c = encodeCursor("hello/world+1");
  assert.notEqual(c, "hello/world+1");
  assert.equal(decodeCursor(c), "hello/world+1");
  console.log("  ✓  encodeCursor + decodeCursor round-trip");
}

{
  assert.equal(normaliseLimit(undefined), 20);
  assert.equal(normaliseLimit(0), 20);
  assert.equal(normaliseLimit(-5), 20);
  assert.equal(normaliseLimit(50), 50);
  assert.equal(normaliseLimit(500), 100);
  assert.equal(normaliseLimit(33.7), 33);
  console.log("  ✓  normaliseLimit clamps to [1, 100] with 20 default");
}

// ─── LRUCache re-export ──────────────────────────────────────────────────────

{
  const cache = new LRUCache<string, number>({ max: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);
  console.log("  ✓  LRUCache re-export evicts past max size");
}

console.log("\nAll @workspace/db helper tests passed.");
