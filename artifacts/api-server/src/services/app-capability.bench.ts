#!/usr/bin/env tsx
/**
 * App Capability Indexer benchmarks (Task #70).
 *
 * Hot path: the Planner calls summariseCapabilitiesForAgent() before each
 * agent run, and the API mounts /apps list/get on the same path the
 * frontend hits as the user navigates the Apps panel. Both must stay
 * well below the LLM round-trip budget so they disappear in the noise.
 *
 * tier-review Check #9 reads the @budget annotations directly above each
 * bench(...) call.
 */
process.env["SQLITE_PATH"] = ":memory:";
process.env["NODE_ENV"] = "test";
process.env["FEATURE_APP_CAPABILITIES"] = "1";

import { runBench, formatBenchSummary } from "@workspace/scripts/bench-runner";

import {
  db,
  runMigrations,
  tenants,
  tenantScope,
  workspaces,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

// Standard 13 — `tenantScope` is imported and used in a sanity assertion
// before the benches run. Bench code lives next to services in this monorepo,
// and the tier-review checker requires every file that pulls `db` to also
// pull a scoping helper so cross-tenant reads are impossible by construction.

import {
  listProfiles,
  scanInstalledApps,
  summariseCapabilitiesForAgent,
} from "./app-capability.service";

const TENANT = "tenant_bench_apps";
const WORKSPACE = "workspace_bench";
const ctx: TenantContext = {
  tenantId: TENANT,
  workspaceId: WORKSPACE,
  requestId: "bench",
};

const bench = (name: string, fn: () => unknown | Promise<unknown>) => ({
  name,
  fn,
});

async function main() {
  await runMigrations();
  await db
    .insert(tenants)
    .values({ id: TENANT, tenantId: TENANT, name: "Bench" })
    .onConflictDoNothing();
  await db
    .insert(workspaces)
    .values({ id: WORKSPACE, tenantId: TENANT, name: "Default" })
    .onConflictDoNothing();
  await scanInstalledApps(ctx);

  // Sanity: every read in the warm-up dataset must be tenant-scoped.
  // We exercise the helper once so the import isn't dead code and the
  // bench mirrors how production services build their queries.
  const scopedRows = await db
    .select()
    .from(tenants)
    .where(tenantScope(ctx, tenants));
  if (scopedRows.length !== 1) {
    throw new Error(
      `bench bootstrap expected exactly 1 scoped tenant row, got ${scopedRows.length}`,
    );
  }

  const samples = await runBench(".bench-results.json", [
    /** @budget 50ms */
    bench("planner capability summary", () =>
      summariseCapabilitiesForAgent(ctx, "com.microsoft.VSCode"),
    ),

    /** @budget 25ms */
    bench("list app profiles page", () => listProfiles(ctx, { limit: 25 })),
  ]);

  process.stdout.write(
    `\napp capability benchmarks:\n${formatBenchSummary(samples)}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(
    `bench failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
