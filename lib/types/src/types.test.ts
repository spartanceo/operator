#!/usr/bin/env tsx
/**
 * Compile-only smoke test for @workspace/types.
 *
 * The package ships type declarations only; the most useful test is to
 * verify the exports compose and that envelope shapes accept the expected
 * payloads. Run with `pnpm --filter @workspace/types run test`.
 */
import assert from "node:assert/strict";
import {
  type ApiEnvelope,
  type PaginatedEnvelope,
  type TenantContext,
  type RuntimeMode,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "./index";

const ctx: TenantContext = {
  tenantId: "t_demo",
  workspaceId: "w_demo",
  userId: "u_demo",
  requestId: "req_test",
};
assert.equal(ctx.tenantId, "t_demo");

const ok: ApiEnvelope<{ status: "ok" }> = {
  success: true,
  data: { status: "ok" },
};
assert.equal(ok.success, true);

const fail: ApiEnvelope<{ status: "ok" }> = {
  success: false,
  error: { code: "INTERNAL", message: "boom" },
};
assert.equal(fail.success, false);

const list: PaginatedEnvelope<{ id: string }> = {
  success: true,
  data: { items: [{ id: "a" }], nextCursor: null },
};
assert.equal(list.data.items.length, 1);

const mode: RuntimeMode = "sequential";
assert.ok(mode === "sequential" || mode === "parallel");

assert.equal(DEFAULT_PAGE_LIMIT, 20);
assert.equal(MAX_PAGE_LIMIT, 100);

console.log("  ✓  @workspace/types: shapes compose and constants are correct");
