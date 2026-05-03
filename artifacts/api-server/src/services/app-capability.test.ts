#!/usr/bin/env tsx
/**
 * App Capability Indexer regression tests (Task #70).
 *
 * Pins the contract guarantees:
 *   1. scanInstalledApps() is idempotent — same app slug never duplicates.
 *   2. Profiles are tenant-scoped — tenant A cannot read tenant B's apps.
 *   3. listProfiles() returns the canonical {items, nextCursor} envelope.
 *   4. connectMcp / disconnectMcp flip mcpStatus and mirror tools as commands.
 *   5. installAppSkill stamps targetAppId on the skill row and surfaces it.
 *   6. summariseCapabilitiesForAgent returns an agent-ready snapshot.
 */
process.env["SQLITE_PATH"] = ":memory:";
process.env["NODE_ENV"] = "test";
process.env["FEATURE_APP_CAPABILITIES"] = "1";

import assert from "node:assert/strict";

import {
  appCapabilityCommands,
  appProfiles,
  db,
  runMigrations,
  skills,
  tenants,
  tenantScope,
  workspaces,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { TenantContext } from "@workspace/types";

import {
  clearAppCapabilityCacheForTests,
  connectMcp,
  disconnectMcp,
  getProfileByAppId,
  installAppSkill,
  isPublicHttpsUrl,
  listCommands,
  listProfiles,
  mcpHandshake,
  scanInstalledApps,
  startDeepLearn,
  summariseCapabilitiesForAgent,
} from "./app-capability.service";
import { matchAppFromGoal } from "./agent.service";

const TENANT_A = "tenant_app_a";
const TENANT_B = "tenant_app_b";
const WORKSPACE = "workspace_default";

function ctx(tenantId: string): TenantContext {
  return { tenantId, workspaceId: WORKSPACE, requestId: "test" };
}

async function bootstrap(tenantId: string) {
  await db
    .insert(tenants)
    .values({ id: tenantId, tenantId, name: `Apps Test ${tenantId}` })
    .onConflictDoNothing();
  await db
    .insert(workspaces)
    .values({ id: WORKSPACE, tenantId, name: "Default" })
    .onConflictDoNothing();
}

interface Case {
  name: string;
  run: () => Promise<void>;
}

const cases: Case[] = [
  {
    name: "scan is idempotent — second scan does not duplicate profiles",
    run: async () => {
      const first = await scanInstalledApps(ctx(TENANT_A));
      assert.ok(first.length > 0, "expected at least one seeded app");
      const second = await scanInstalledApps(ctx(TENANT_A));
      assert.equal(second.length, first.length);
      const distinct = new Set(second.map((p) => p.appId));
      assert.equal(distinct.size, second.length);
    },
  },
  {
    name: "tenant isolation — tenant A profiles invisible to tenant B",
    run: async () => {
      await scanInstalledApps(ctx(TENANT_A));
      const a = await listProfiles(ctx(TENANT_A));
      const b = await listProfiles(ctx(TENANT_B));
      assert.ok(a.items.length > 0);
      assert.equal(b.items.length, 0);
    },
  },
  {
    name: "listProfiles returns the {items,nextCursor} envelope",
    run: async () => {
      const page = await listProfiles(ctx(TENANT_A), { limit: 1 });
      assert.equal(typeof page.items, "object");
      assert.ok(Array.isArray(page.items));
      assert.ok(page.items.length <= 1);
      assert.ok(page.nextCursor === null || typeof page.nextCursor === "string");
    },
  },
  {
    name: "connectMcp flips status and mirrors tools as mcp commands",
    run: async () => {
      const profiles = await scanInstalledApps(ctx(TENANT_A));
      const linear = profiles.find((p) => p.appId === "com.linear.linear");
      assert.ok(linear, "expected Linear in seed list");
      const conn = await connectMcp(ctx(TENANT_A), linear.id);
      assert.equal(conn.status, "connected");
      assert.ok(conn.tools.length > 0);
      const cmds = await listCommands(ctx(TENANT_A), linear.id, {
        kind: "mcp_tool",
      });
      assert.ok(cmds.items.length > 0);

      const after = await getProfileByAppId(ctx(TENANT_A), linear.appId);
      assert.equal(after?.mcpStatus, "connected");

      const disc = await disconnectMcp(ctx(TENANT_A), linear.id);
      assert.equal(disc?.status, "disconnected");
      const cmdsAfter = await listCommands(ctx(TENANT_A), linear.id, {
        kind: "mcp_tool",
      });
      assert.equal(cmdsAfter.items.length, 0);
    },
  },
  {
    name: "installAppSkill stamps targetAppId and adds skill_action command",
    run: async () => {
      const profiles = await scanInstalledApps(ctx(TENANT_A));
      const code = profiles.find((p) => p.appId === "com.microsoft.VSCode");
      assert.ok(code, "expected VS Code in seed list");

      // Insert a skill row for this tenant.
      const skillId = "skill_test_apps";
      await db.insert(skills).values({
        id: skillId,
        tenantId: TENANT_A,
        workspaceId: WORKSPACE,
        slug: "vscode-helper",
        name: "VS Code Helper",
        description: "Adds quick file scaffolding",
      });

      const updated = await installAppSkill(ctx(TENANT_A), code.id, skillId);
      assert.equal(updated.installedSkillId, skillId);
      assert.equal(updated.sources.skill, true);

      const cmds = await listCommands(ctx(TENANT_A), code.id, {
        kind: "skill_action",
      });
      assert.ok(cmds.items.length > 0);

      const skillRow = await db
        .select()
        .from(skills)
        .where(and(tenantScope(ctx(TENANT_A), skills), eq(skills.id, skillId)))
        .limit(1);
      assert.equal(skillRow[0]?.targetAppId, code.appId);
    },
  },
  {
    name: "summariseCapabilitiesForAgent returns capability snapshot",
    run: async () => {
      const summary = await summariseCapabilitiesForAgent(
        ctx(TENANT_A),
        "com.microsoft.VSCode",
      );
      assert.ok(summary);
      assert.equal(summary?.appId, "com.microsoft.VSCode");
      assert.ok(summary && summary.commands.length > 0);
    },
  },
  {
    name: "listCommands pagination advances forward (no row repeats)",
    run: async () => {
      const profiles = await scanInstalledApps(ctx(TENANT_A));
      const target = profiles[0];
      assert.ok(target);
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      // Walk every page using a tiny limit so seek behaviour is exercised.
      // The bug we are guarding against re-emits earlier rows on page 2+.
      for (let i = 0; i < 50; i += 1) {
        const page = await listCommands(ctx(TENANT_A), target.id, {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        for (const row of page.items) {
          assert.ok(!seen.has(row.id), `duplicate row across pages: ${row.id}`);
          seen.add(row.id);
        }
        pages += 1;
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      assert.ok(pages >= 2, "expected at least two pages of commands");
    },
  },
  {
    name: "matchAppFromGoal pre-resolves a known app for the planner",
    run: async () => {
      const page = await listProfiles(ctx(TENANT_A), { limit: 50 });
      const matched = matchAppFromGoal(
        "open Linear and create an issue for me",
        page.items.map((p) => ({ appId: p.appId, appName: p.appName })),
      );
      assert.ok(matched, "expected Linear to match");
      assert.equal(matched?.appId, "com.linear.linear");
    },
  },
  {
    name: "isPublicHttpsUrl rejects http/localhost/ip/intranet",
    run: async () => {
      assert.equal(isPublicHttpsUrl("https://docs.linear.app/"), true);
      assert.equal(isPublicHttpsUrl("http://docs.linear.app/"), false);
      assert.equal(isPublicHttpsUrl("https://localhost/"), false);
      assert.equal(isPublicHttpsUrl("https://127.0.0.1/"), false);
      assert.equal(isPublicHttpsUrl("https://intranet/"), false);
      assert.equal(isPublicHttpsUrl("file:///etc/passwd"), false);
      assert.equal(isPublicHttpsUrl("not a url"), false);
      // Cloud metadata + RFC1918 + link-local + ULA + CGNAT must be refused.
      assert.equal(isPublicHttpsUrl("https://169.254.169.254/"), false);
      assert.equal(isPublicHttpsUrl("https://10.0.0.1/"), false);
      assert.equal(isPublicHttpsUrl("https://172.16.5.5/"), false);
      assert.equal(isPublicHttpsUrl("https://192.168.1.1/"), false);
      assert.equal(isPublicHttpsUrl("https://100.64.1.1/"), false);
      assert.equal(isPublicHttpsUrl("https://kube-api.local/"), false);
      assert.equal(isPublicHttpsUrl("https://svc.internal/"), false);
      // Public IP literal (e.g. 1.1.1.1) is allowed by URL guard; the
      // DNS-resolution layer in fetchWithTimeout enforces the rest.
      assert.equal(isPublicHttpsUrl("https://1.1.1.1/"), true);
    },
  },
  {
    name: "mcpHandshake returns deterministic stub tools in test mode",
    run: async () => {
      const tools = await mcpHandshake("https://example.com/mcp", "Linear");
      assert.ok(tools.length >= 2);
      assert.ok(tools.every((t) => typeof t.name === "string"));
    },
  },
  {
    name: "startDeepLearn fetches doc root and stamps profile ready",
    run: async () => {
      process.env["FEATURE_APP_CAPABILITIES_OFFLINE"] = "1";
      const profiles = await scanInstalledApps(ctx(TENANT_A));
      const linear = profiles.find((p) => p.appId === "com.linear.linear");
      assert.ok(linear);
      const job = await startDeepLearn(ctx(TENANT_A), linear.id);
      assert.equal(job.status, "ready");
      assert.ok(job.pagesFetched > 0);
      assert.ok(job.chunksEmbedded > 0);
      const after = await getProfileByAppId(ctx(TENANT_A), linear.appId);
      assert.equal(after?.docIndexStatus, "ready");
      delete process.env["FEATURE_APP_CAPABILITIES_OFFLINE"];
    },
  },
  {
    name: "scoped writes preserve tenant_id — tenant B sees zero rows",
    run: async () => {
      const rows = await db
        .select()
        .from(appProfiles)
        .where(tenantScope(ctx(TENANT_B), appProfiles));
      assert.equal(rows.length, 0);
      const cmdRows = await db
        .select()
        .from(appCapabilityCommands)
        .where(tenantScope(ctx(TENANT_B), appCapabilityCommands));
      assert.equal(cmdRows.length, 0);
    },
  },
];

async function main() {
  await runMigrations();
  await bootstrap(TENANT_A);
  await bootstrap(TENANT_B);

  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    clearAppCapabilityCacheForTests();
    try {
      await c.run();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (e) {
      fail += 1;
      console.error(`  ✗ ${c.name}`);
      console.error(e);
    }
  }
  console.log(`\nApp capability tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
