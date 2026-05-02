/**
 * Self-contained test runner.
 *
 * Runs an in-memory SQLite + a real Express app via supertest. We set
 * `SQLITE_PATH=:memory:` BEFORE importing the app so the lazy-init Proxy
 * in `@workspace/db` opens the in-memory handle on first dereference.
 *
 * Failures throw — the script exits non-zero so `pnpm test` (via tier-review
 * Check #2) reports red.
 */
process.env["SQLITE_PATH"] = ":memory:";
process.env["NODE_ENV"] = "test";
process.env["SESSION_SECRET"] = "test-session-secret-omninity-tier-1";
process.env["SANDBOX_ROOT"] = `/tmp/omninity-sandbox-${Date.now()}`;

import assert from "node:assert/strict";

import request from "supertest";

import { db, getRawSqlite, runMigrations, tenants, workspaces } from "@workspace/db";

import app from "./app";

const TENANT = "tenant_test_1";
const TENANT_2 = "tenant_test_2";

async function bootstrapTenant(tenantId: string) {
  await db.insert(tenants).values({
    id: tenantId,
    tenantId,
    name: `Test Tenant ${tenantId}`,
    status: "active",
  });
  await db.insert(workspaces).values({
    id: `default-${tenantId}`,
    tenantId,
    name: "Default",
    status: "active",
  });
}

interface TestCase {
  name: string;
  run: () => Promise<void>;
}

// The test-runner is a CLI tool, not application code, so it writes to
// stdout directly. The tier-review console.log gate intentionally bans
// console.log in source files; process.stdout.write is the explicit
// CLI-output escape valve.
function out(line: string) {
  process.stdout.write(`${line}\n`);
}

function status(label: string, ok: boolean, detail = "") {
  const icon = ok ? "✓" : "✗";
  out(`  ${icon} ${label}${detail ? ` — ${detail}` : ""}`);
}

const cases: TestCase[] = [
  {
    name: "GET /api/health → ok envelope",
    run: async () => {
      const res = await request(app).get("/api/health");
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.status, "ok");
    },
  },
  {
    name: "missing X-Tenant-ID returns 401 envelope",
    run: async () => {
      const res = await request(app).get("/api/memory");
      assert.equal(res.status, 401);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, "UNAUTHENTICATED");
    },
  },
  {
    name: "register + login + me round-trip",
    run: async () => {
      const agent = request.agent(app);
      const reg = await agent
        .post("/api/auth/register")
        .set("X-Tenant-ID", TENANT)
        .send({
          email: "owner@example.com",
          password: "correct horse battery!1",
          displayName: "Owner",
        });
      assert.equal(reg.status, 200, JSON.stringify(reg.body));
      assert.equal(reg.body.success, true);
      assert.equal(reg.body.data.user.email, "owner@example.com");

      const me = await agent.get("/api/auth/me").set("X-Tenant-ID", TENANT);
      assert.equal(me.status, 200);
      assert.equal(me.body.data.user.email, "owner@example.com");
    },
  },
  {
    name: "memory CRUD round-trips through pagination envelope",
    run: async () => {
      const create = await request(app)
        .post("/api/memory")
        .set("X-Tenant-ID", TENANT)
        .send({ title: "Test", content: "hello", importance: 80 });
      assert.equal(create.status, 200, JSON.stringify(create.body));
      const id = create.body.data.id;

      const list = await request(app).get("/api/memory").set("X-Tenant-ID", TENANT);
      assert.equal(list.status, 200);
      assert.equal(list.body.success, true);
      assert.ok(Array.isArray(list.body.data.items));
      assert.ok(list.body.data.items.some((m: { id: string }) => m.id === id));
      assert.ok("nextCursor" in list.body.data);

      const del = await request(app)
        .delete(`/api/memory/${id}`)
        .set("X-Tenant-ID", TENANT);
      assert.equal(del.status, 200);
      assert.equal(del.body.data.deleted, true);
    },
  },
  {
    name: "tenant isolation: tenant 2 cannot see tenant 1's memory",
    run: async () => {
      const c1 = await request(app)
        .post("/api/memory")
        .set("X-Tenant-ID", TENANT)
        .send({ title: "Private", content: "secret" });
      assert.equal(c1.status, 200);
      const id = c1.body.data.id;

      const cross = await request(app)
        .get(`/api/memory/${id}`)
        .set("X-Tenant-ID", TENANT_2);
      assert.equal(cross.status, 404);
      assert.equal(cross.body.success, false);
    },
  },
  {
    name: "tools list is paginated",
    run: async () => {
      const res = await request(app)
        .get("/api/tools?limit=5")
        .set("X-Tenant-ID", TENANT);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data.items));
      assert.ok(res.body.data.items.length <= 5);
    },
  },
  {
    name: "agent run completes deterministically",
    run: async () => {
      const res = await request(app)
        .post("/api/agent/runs")
        .set("X-Tenant-ID", TENANT)
        .send({ goal: "summarise the universe" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.status, "completed");
      assert.ok(res.body.data.summary);

      const calls = await request(app)
        .get(`/api/agent/runs/${res.body.data.id}/tool-calls`)
        .set("X-Tenant-ID", TENANT);
      assert.equal(calls.status, 200);
      assert.ok(calls.body.data.items.length >= 3);
    },
  },
  {
    name: "files sandbox blocks traversal but allows in-sandbox writes",
    run: async () => {
      const bad = await request(app)
        .post("/api/files/write")
        .set("X-Tenant-ID", TENANT)
        .send({ path: "../escape.txt", content: "nope" });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, "SANDBOX_ESCAPE");

      const good = await request(app)
        .post("/api/files/write")
        .set("X-Tenant-ID", TENANT)
        .send({ path: "notes/hello.txt", content: "hi" });
      assert.equal(good.status, 200);

      const read = await request(app)
        .post("/api/files/read")
        .set("X-Tenant-ID", TENANT)
        .send({ path: "notes/hello.txt" });
      assert.equal(read.status, 200);
      assert.equal(read.body.data.content, "hi");
    },
  },
  {
    name: "privacy events log records the in-band activity",
    run: async () => {
      const res = await request(app)
        .get("/api/privacy/events?limit=20")
        .set("X-Tenant-ID", TENANT);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data.items));
      // The earlier file.read/file.write tests must have left an audit trail.
      const eventTypes = new Set(
        res.body.data.items.map((e: { eventType: string }) => e.eventType),
      );
      assert.ok(eventTypes.has("file.write"));
    },
  },
];

async function main() {
  out("\n  api-server test-runner\n  ─────────────────────");
  runMigrations(getRawSqlite());
  // Two tenants with one workspace each — the isolation test relies on
  // both existing so cross-tenant lookups can be observed.
  await bootstrapTenant(TENANT);
  await bootstrapTenant(TENANT_2);

  let failures = 0;
  for (const c of cases) {
    try {
      await c.run();
      status(c.name, true);
    } catch (e) {
      failures++;
      const msg = e instanceof Error ? e.message : String(e);
      status(c.name, false, msg);
    }
  }
  out(
    `\n  ${failures === 0 ? "✓ all" : `✗ ${failures} of`} ${cases.length} test(s) failed`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
