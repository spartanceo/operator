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
// Deterministic hardware probe for the onboarding tests — overrides the
// real `os.*` reads with a known 16GB Apple Silicon profile so the
// recommendation engine returns the same model on every CI host.
process.env["OMNINITY_HARDWARE_OVERRIDE"] = JSON.stringify({
  platform: "darwin",
  arch: "arm64",
  cpuCount: 8,
  cpuModel: "Apple M1 Pro",
  totalRamBytes: 16 * 1024 * 1024 * 1024,
  freeRamBytes: 8 * 1024 * 1024 * 1024,
  appleSilicon: true,
});

import assert from "node:assert/strict";

import request from "supertest";

import { db, getRawSqlite, runMigrations, tenants, workspaces } from "@workspace/db";

import app from "./app";
import {
  __clearHardwareCacheMemoForTests,
  buildModelInstallPlan,
  clearHardwareCache,
  defaultLifecycleForTier,
  evaluateMinimumSpec,
  getDefaultVision,
  getHardwareProfile,
  getMinimumPrimary,
  getVisionLifecycle,
  resetVisionLifecycleForTests,
} from "./services/hardware";
import type { HardwareProfile } from "@workspace/types";

function syntheticHardware(
  totalRamGb: number,
  overrides: Partial<HardwareProfile> = {},
): HardwareProfile {
  const ONE_GB = 1024 * 1024 * 1024;
  const tier =
    totalRamGb >= 32 ? "pro" : totalRamGb >= 16 ? "high" : totalRamGb >= 8 ? "mid" : "low";
  return {
    platform: "linux",
    arch: "x64",
    cpuCount: 8,
    cpuModel: "Synthetic CPU",
    totalRamBytes: totalRamGb * ONE_GB,
    freeRamBytes: Math.floor((totalRamGb / 2) * ONE_GB),
    appleSilicon: false,
    tier,
    detectedAt: new Date().toISOString(),
    osVersion: "test",
    gpu: null,
    ...overrides,
  };
}

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

  {
    name: "onboarding profile starts as null then upserts idempotently",
    run: async () => {
      const empty = await request(app)
        .get("/api/onboarding/profile")
        .set("X-Tenant-ID", TENANT);
      assert.equal(empty.status, 200);
      assert.equal(empty.body.success, true);
      assert.equal(empty.body.data.profile, null);

      const created = await request(app)
        .put("/api/onboarding/profile")
        .set("X-Tenant-ID", TENANT)
        .send({
          displayName: "Owner",
          userType: "developer",
          useCase: "coding",
        });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      assert.equal(created.body.data.profile.displayName, "Owner");
      assert.equal(created.body.data.profile.useCase, "coding");
      assert.equal(created.body.data.profile.completed, false);

      const completed = await request(app)
        .put("/api/onboarding/profile")
        .set("X-Tenant-ID", TENANT)
        .send({ completed: true });
      assert.equal(completed.status, 200);
      assert.equal(completed.body.data.profile.completed, true);
      assert.equal(completed.body.data.profile.userType, "developer");
      assert.ok(completed.body.data.profile.completedAt);

      // Monotonic — even if the client tries to clear `completed`,
      // the server keeps the previously-flipped value.
      const replay = await request(app)
        .put("/api/onboarding/profile")
        .set("X-Tenant-ID", TENANT)
        .send({ completed: false });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.data.profile.completed, true);
    },
  },

  {
    name: "onboarding payload validation rejects unknown enums",
    run: async () => {
      const bad = await request(app)
        .put("/api/onboarding/profile")
        .set("X-Tenant-ID", TENANT)
        .send({ userType: "alien" });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.success, false);
      assert.equal(bad.body.error.code, "VALIDATION");
    },
  },

  {
    name: "onboarding hardware probe returns the override + a recommendation",
    run: async () => {
      const res = await request(app)
        .get("/api/onboarding/hardware")
        .set("X-Tenant-ID", TENANT);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      const { hardware, recommendation } = res.body.data;
      assert.equal(hardware.platform, "darwin");
      assert.equal(hardware.arch, "arm64");
      assert.equal(hardware.appleSilicon, true);
      assert.equal(hardware.tier, "high");
      assert.equal(recommendation.model, "llama3.1:8b");
      assert.equal(recommendation.tier, "high");
      assert.ok(recommendation.sizeBytes > 0);
    },
  },

  {
    name: "starter tasks are personalised by the saved use case",
    run: async () => {
      const res = await request(app)
        .get("/api/onboarding/starter-tasks")
        .set("X-Tenant-ID", TENANT);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.useCase, "coding");
      assert.equal(res.body.data.items.length, 3);
      const ids = res.body.data.items.map((t: { id: string }) => t.id);
      assert.ok(ids.every((id: string) => id.startsWith("starter-code-")));
    },
  },

  {
    name: "starter tasks fall back to productivity bundle without a profile",
    run: async () => {
      const res = await request(app)
        .get("/api/onboarding/starter-tasks")
        .set("X-Tenant-ID", TENANT_2);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.useCase, "productivity");
      assert.equal(res.body.data.items.length, 3);
    },
  },

  {
    name: "onboarding profile is tenant-isolated",
    run: async () => {
      const cross = await request(app)
        .get("/api/onboarding/profile")
        .set("X-Tenant-ID", TENANT_2);
      assert.equal(cross.status, 200);
      assert.equal(cross.body.data.profile, null);
    },
  },

  // ─── Task #64: hardware-aware model recommendation ────────────────────

  {
    name: "recommendation engine: 16GB host gets a primary + bundled vision",
    run: async () => {
      const plan = buildModelInstallPlan(syntheticHardware(16));
      assert.ok(plan, "plan must not be null on a 16GB host");
      assert.equal(plan.fitsHardware, true);
      assert.equal(plan.primary.role, "primary");
      assert.equal(plan.tier, "high");
      assert.ok(plan.companions.length >= 1, "vision companion expected");
      assert.equal(plan.companions[0]?.role, "vision");
      assert.ok(plan.alternatives.length >= 1, "alternatives expected");
      assert.ok(plan.totalDownloadBytes > plan.primary.sizeBytes);
    },
  },
  {
    name: "recommendation engine: pro host (64GB) returns the 70B model",
    run: async () => {
      const plan = buildModelInstallPlan(syntheticHardware(64));
      assert.ok(plan);
      assert.equal(plan.tier, "pro");
      assert.equal(plan.primary.id, "llama3.1:70b");
    },
  },
  {
    name: "recommendation engine: vision is always bundled — never silently dropped",
    run: async () => {
      // 6GB total — primary (3GB Phi-3) + vision (1.6GB) + OS (2GB) =
      // 6.6GB needed. Below the minimum, so the plan must be `null` and
      // the min-spec verdict must fail. Earlier behaviour silently
      // dropped vision to keep going; we explicitly reject that path
      // because installing primary-only produces a broken first-run.
      const hw = syntheticHardware(6);
      const plan = buildModelInstallPlan(hw);
      assert.equal(
        plan,
        null,
        "vision must never be silently dropped to keep a primary",
      );
      const verdict = evaluateMinimumSpec(hw);
      assert.equal(verdict.meetsMinimum, false);
    },
  },
  {
    name: "recommendation engine: <minimum spec returns null plan",
    run: async () => {
      const plan = buildModelInstallPlan(syntheticHardware(2));
      assert.equal(plan, null);
      const verdict = evaluateMinimumSpec(syntheticHardware(2));
      assert.equal(verdict.meetsMinimum, false);
      assert.ok(verdict.minimumRamBytes > 0);
      assert.match(verdict.message, /minimum/i);
    },
  },
  {
    name: "min-spec floor includes vision RAM + system reservation",
    run: async () => {
      // Floor must equal smallest primary + vision + system reserve so a
      // host that fits primary-only (but not primary+vision) still fails.
      const verdict = evaluateMinimumSpec(syntheticHardware(64));
      const minimum = getMinimumPrimary();
      const vision = getDefaultVision();
      assert.ok(vision, "catalogue must always ship a vision companion");
      const expected =
        minimum.ramRequiredBytes +
        vision.ramRequiredBytes +
        2 * 1024 * 1024 * 1024; // SYSTEM_RAM_RESERVATION_BYTES
      assert.equal(verdict.minimumRamBytes, expected);
    },
  },
  {
    name: "vision lifecycle: aggressive mode for low/mid tier hosts",
    run: async () => {
      const low = defaultLifecycleForTier("low");
      const mid = defaultLifecycleForTier("mid");
      const high = defaultLifecycleForTier("high");
      const pro = defaultLifecycleForTier("pro");
      assert.equal(low.mode, "aggressive");
      assert.equal(mid.mode, "aggressive");
      assert.equal(high.mode, "balanced");
      assert.equal(pro.mode, "warm");
      assert.ok(low.idleTimeoutMs < high.idleTimeoutMs);
    },
  },
  {
    name: "vision lifecycle: idle timeout auto-unloads after timer fires",
    run: async () => {
      resetVisionLifecycleForTests();
      const cycle = getVisionLifecycle("high");
      // Re-arm with a tiny timeout so the test does not have to wait
      // a real 5-minute balanced window.
      cycle.configure({
        visionModelId: "moondream:v2",
        mode: "aggressive",
        idleTimeoutMs: 20,
      });
      cycle.touch();
      assert.equal(cycle.snapshot().state, "loaded");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(
        cycle.snapshot().state,
        "unloaded",
        "idle timer must auto-unload",
      );
      // Re-touch followed by a fresh configure() must re-arm cleanly.
      cycle.touch();
      cycle.configure({
        visionModelId: "moondream:v2",
        mode: "aggressive",
        idleTimeoutMs: 15,
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(cycle.snapshot().state, "unloaded");
      resetVisionLifecycleForTests();
    },
  },
  {
    name: "vision lifecycle: touch loads, unload frees RAM",
    run: async () => {
      resetVisionLifecycleForTests();
      const cycle = getVisionLifecycle("high");
      assert.equal(cycle.snapshot().state, "unloaded");
      cycle.touch();
      assert.equal(cycle.snapshot().state, "loaded");
      assert.ok(cycle.snapshot().lastUsedAt);
      cycle.unload();
      assert.equal(cycle.snapshot().state, "unloaded");
      const vision = getDefaultVision();
      assert.ok(vision, "catalogue must include a vision model");
      assert.equal(cycle.snapshot().visionModelId, vision.id);
      resetVisionLifecycleForTests();
    },
  },
  {
    name: "GET /api/models/hardware returns plan + minimum-spec verdict",
    run: async () => {
      clearHardwareCache(); // pick up the test-runner override
      const res = await request(app)
        .get("/api/models/hardware")
        .set("X-Tenant-ID", TENANT);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      const { hardware, plan, minimumSpec } = res.body.data;
      assert.equal(hardware.tier, "high");
      assert.ok(plan, "16GB override must yield a plan");
      assert.equal(plan.primary.id, "llama3.1:8b");
      assert.equal(minimumSpec.meetsMinimum, true);
    },
  },
  {
    name: "GET /api/models/catalogue returns all entries with vision included",
    run: async () => {
      const res = await request(app)
        .get("/api/models/catalogue")
        .set("X-Tenant-ID", TENANT);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data.items));
      assert.ok(res.body.data.items.length >= 4);
      const roles = new Set(
        res.body.data.items.map((m: { role: string }) => m.role),
      );
      assert.ok(roles.has("primary"));
      assert.ok(roles.has("vision"));
    },
  },
  {
    name: "GET /api/models/recommended returns plan + default preferences",
    run: async () => {
      const res = await request(app)
        .get("/api/models/recommended")
        .set("X-Tenant-ID", TENANT);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.preferences.catalogueChoiceMade, false);
      assert.ok(res.body.data.preferences.visionLifecycle.idleTimeoutMs > 0);
      assert.ok(res.body.data.plan);
      assert.equal(res.body.data.plan.primary.id, "llama3.1:8b");
    },
  },
  {
    name: "POST /api/models/select persists user choice",
    run: async () => {
      const ok = await request(app)
        .post("/api/models/select")
        .set("X-Tenant-ID", TENANT)
        .send({
          primaryModel: "mistral:7b",
          visionLifecycleMode: "aggressive",
        });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.data.primaryModel, "mistral:7b");
      assert.equal(ok.body.data.visionLifecycle.mode, "aggressive");
      assert.equal(ok.body.data.catalogueChoiceMade, true);

      // Subsequent /recommended should reflect the saved preference.
      const after = await request(app)
        .get("/api/models/recommended")
        .set("X-Tenant-ID", TENANT);
      assert.equal(after.status, 200);
      assert.equal(after.body.data.preferences.primaryModel, "mistral:7b");
      assert.equal(after.body.data.preferences.catalogueChoiceMade, true);
    },
  },
  {
    name: "POST /api/models/select rejects unknown model id",
    run: async () => {
      const bad = await request(app)
        .post("/api/models/select")
        .set("X-Tenant-ID", TENANT)
        .send({ primaryModel: "made-up-model:foo" });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.success, false);
      assert.equal(bad.body.error.code, "INVALID_MODEL");
    },
  },
  {
    name: "model preferences are tenant-isolated",
    run: async () => {
      const cross = await request(app)
        .get("/api/models/recommended")
        .set("X-Tenant-ID", TENANT_2);
      assert.equal(cross.status, 200);
      assert.equal(cross.body.data.preferences.primaryModel, "llama3.1:8b");
      assert.equal(cross.body.data.preferences.catalogueChoiceMade, false);
    },
  },
  {
    name: "minimum primary in catalogue is the smallest by RAM",
    run: async () => {
      const min = getMinimumPrimary();
      assert.equal(min.id, "phi3:mini");
    },
  },
  {
    name: "POST /api/models/hardware/redetect clears cache and returns fresh plan",
    run: async () => {
      // First call to /hardware populates the in-memory cache from the
      // OMNINITY_HARDWARE_OVERRIDE profile; redetect must drop it and
      // return a 200 with the same plan shape (still 16GB Apple Silicon
      // because the override is set process-wide).
      await request(app).get("/api/models/hardware").set("X-Tenant-ID", TENANT);
      const res = await request(app)
        .post("/api/models/hardware/redetect")
        .set("X-Tenant-ID", TENANT);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.hardware.tier, "high");
      assert.ok(res.body.data.plan);
      assert.equal(res.body.data.plan.primary.id, "llama3.1:8b");
    },
  },
  {
    name: "feature flag off: hardware-aware routes return 404 FEATURE_DISABLED",
    run: async () => {
      const prev =
        process.env["OMNINITY_FEATURE_HARDWARE_AWARE_RECOMMENDATION"];
      process.env["OMNINITY_FEATURE_HARDWARE_AWARE_RECOMMENDATION"] = "false";
      try {
        for (const path of [
          "/api/models/hardware",
          "/api/models/catalogue",
          "/api/models/recommended",
        ]) {
          const res = await request(app)
            .get(path)
            .set("X-Tenant-ID", TENANT);
          assert.equal(res.status, 404, `${path} must 404 when flag off`);
          assert.equal(res.body.error.code, "FEATURE_DISABLED");
        }
        const sel = await request(app)
          .post("/api/models/select")
          .set("X-Tenant-ID", TENANT)
          .send({ primaryModel: "phi3:mini" });
        assert.equal(sel.status, 404);
        assert.equal(sel.body.error.code, "FEATURE_DISABLED");
        const re = await request(app)
          .post("/api/models/hardware/redetect")
          .set("X-Tenant-ID", TENANT);
        assert.equal(re.status, 404);
        assert.equal(re.body.error.code, "FEATURE_DISABLED");
      } finally {
        if (prev === undefined) {
          delete process.env["OMNINITY_FEATURE_HARDWARE_AWARE_RECOMMENDATION"];
        } else {
          process.env["OMNINITY_FEATURE_HARDWARE_AWARE_RECOMMENDATION"] = prev;
        }
      }
    },
  },
  {
    name: "hardware cache: persists snapshot to disk and re-hydrates without re-detecting",
    run: async () => {
      const fs = await import("node:fs");
      const tmp = `/tmp/omninity-hw-cache-${Date.now()}.json`;
      const prev = process.env["OMNINITY_HARDWARE_CACHE_PATH"];
      process.env["OMNINITY_HARDWARE_CACHE_PATH"] = tmp;
      try {
        clearHardwareCache();
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

        // First call must detect + persist.
        const first = getHardwareProfile();
        assert.ok(fs.existsSync(tmp), "snapshot file must be written");
        const onDisk = JSON.parse(fs.readFileSync(tmp, "utf8")) as {
          profile: HardwareProfile;
          fingerprint: { totalRamBytes: number };
        };
        assert.equal(onDisk.profile.totalRamBytes, first.totalRamBytes);
        assert.ok(onDisk.fingerprint, "snapshot must carry a fingerprint");

        // Drop ONLY the in-memory memo to simulate a fresh process. The
        // next call must re-hydrate from disk rather than re-detect — we
        // prove that by tampering with the file payload (a re-detect
        // would overwrite our edit).
        __clearHardwareCacheMemoForTests();
        const tampered = {
          ...onDisk,
          profile: { ...onDisk.profile, cpuModel: "FROM-DISK-SENTINEL" },
        };
        fs.writeFileSync(tmp, JSON.stringify(tampered), "utf8");
        const second = getHardwareProfile();
        assert.equal(
          second.cpuModel,
          "FROM-DISK-SENTINEL",
          "second call must hydrate from on-disk snapshot, not re-detect",
        );

        // clearHardwareCache() must wipe both the memo AND the file.
        clearHardwareCache();
        assert.equal(fs.existsSync(tmp), false, "file must be deleted");
      } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        if (prev === undefined) {
          delete process.env["OMNINITY_HARDWARE_CACHE_PATH"];
        } else {
          process.env["OMNINITY_HARDWARE_CACHE_PATH"] = prev;
        }
        clearHardwareCache();
      }
    },
  },

  {
    name: "updates check returns no update when latest matches current",
    run: async () => {
      const previous = process.env["OMNINITY_LATEST_VERSION"];
      delete process.env["OMNINITY_LATEST_VERSION"];
      try {
        const res = await request(app)
          .get("/api/updates/check")
          .set("X-Tenant-ID", TENANT);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.updateAvailable, false);
        assert.equal(
          res.body.data.currentVersion,
          res.body.data.latestVersion,
        );
        assert.equal(res.body.data.channel, "stable");
      } finally {
        if (previous !== undefined) {
          process.env["OMNINITY_LATEST_VERSION"] = previous;
        }
      }
    },
  },

  {
    name: "updates check flags an upgrade when latest is newer",
    run: async () => {
      const prevVersion = process.env["OMNINITY_LATEST_VERSION"];
      const prevChannel = process.env["OMNINITY_RELEASE_CHANNEL"];
      const prevUrl = process.env["OMNINITY_LATEST_DOWNLOAD_URL"];
      process.env["OMNINITY_LATEST_VERSION"] = "999.0.0";
      process.env["OMNINITY_RELEASE_CHANNEL"] = "beta";
      process.env["OMNINITY_LATEST_DOWNLOAD_URL"] =
        "https://omninity.example/download";
      try {
        const res = await request(app)
          .get("/api/updates/check")
          .set("X-Tenant-ID", TENANT);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.latestVersion, "999.0.0");
        assert.equal(res.body.data.updateAvailable, true);
        assert.equal(res.body.data.channel, "beta");
        assert.equal(
          res.body.data.downloadUrl,
          "https://omninity.example/download",
        );
      } finally {
        if (prevVersion === undefined) {
          delete process.env["OMNINITY_LATEST_VERSION"];
        } else {
          process.env["OMNINITY_LATEST_VERSION"] = prevVersion;
        }
        if (prevChannel === undefined) {
          delete process.env["OMNINITY_RELEASE_CHANNEL"];
        } else {
          process.env["OMNINITY_RELEASE_CHANNEL"] = prevChannel;
        }
        if (prevUrl === undefined) {
          delete process.env["OMNINITY_LATEST_DOWNLOAD_URL"];
        } else {
          process.env["OMNINITY_LATEST_DOWNLOAD_URL"] = prevUrl;
        }
      }
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
    `\n  ${
      failures === 0
        ? `✓ all ${cases.length} test(s) passed`
        : `✗ ${failures} of ${cases.length} test(s) failed`
    }`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
