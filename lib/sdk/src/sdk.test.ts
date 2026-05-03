/**
 * Light smoke test for the SDK — runs without a live API by stubbing
 * `fetch`. Verifies the tenant header, envelope unwrapping and error
 * mapping. Run with: `pnpm --filter @omninity/sdk test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { OmninityClient } from "./client";
import { ApiError } from "./errors";
import { verifyEventSignature } from "./events";
import { createHmac } from "node:crypto";

function mockFetch(
  expect: (url: string, init: RequestInit) => unknown,
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const data = expect(url, init);
    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("forwards tenant header and base URL", async () => {
  let seenTenant = "";
  const op = new OmninityClient({
    tenantId: "ws_test",
    fetch: mockFetch((url, init) => {
      seenTenant = String((init.headers as Record<string, string>)["x-tenant-id"]);
      assert.ok(url.startsWith("http://localhost:3001"));
      return { items: [] };
    }),
  });
  await op.plugins.list();
  assert.equal(seenTenant, "ws_test");
});

test("unwraps envelope and returns data", async () => {
  const op = new OmninityClient({
    tenantId: "ws_test",
    fetch: mockFetch(() => ({
      id: "pt_1",
      name: "demo",
      description: "",
      riskLevel: "low",
      inputSchema: {},
      invokeUrl: "http://localhost:9999/p",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    })),
  });
  const tool = await op.plugins.get("pt_1");
  assert.equal(tool.id, "pt_1");
});

test("maps error envelope to ApiError", async () => {
  const op = new OmninityClient({
    tenantId: "ws_test",
    fetch: (async () =>
      new Response(
        JSON.stringify({ success: false, error: { code: "X", message: "nope" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
  });
  await assert.rejects(() => op.plugins.list(), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal((e as ApiError).code, "X");
    return true;
  });
});

test("verifyEventSignature accepts valid HMAC", () => {
  const body = JSON.stringify({
    id: "e1",
    type: "task_started",
    tenantId: "t",
    workspaceId: "w",
    timestamp: new Date().toISOString(),
    data: {},
  });
  const sig = "sha256=" + createHmac("sha256", "shh").update(body).digest("hex");
  const ev = verifyEventSignature("shh", sig, body);
  assert.equal(ev.type, "task_started");
});

test("verifyEventSignature rejects bad HMAC", () => {
  assert.throws(() =>
    verifyEventSignature(
      "shh",
      "sha256=" + "0".repeat(64),
      JSON.stringify({ id: "e", type: "x", tenantId: "t", workspaceId: "w", timestamp: "now", data: {} }),
    ),
  );
});
