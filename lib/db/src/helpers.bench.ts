#!/usr/bin/env tsx
/**
 * Performance benchmarks for the @workspace/db helpers.
 *
 * The hot paths here run on every list endpoint (cursor encode/decode +
 * tenantScope SQL build), so a regression here would fan out across the
 * entire API surface. The budgets are intentionally generous — they exist
 * to catch order-of-magnitude regressions, not micro-optimisation drift.
 *
 * tier-review Check #9 reads `@budget` annotations directly above each
 * `bench("...", ...)` call and compares the measured mean (or p95 if
 * declared) against the annotated value.
 */
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

import { runBench, formatBenchSummary } from "@workspace/scripts/bench-runner";

import {
  buildPage,
  decodeCursor,
  encodeCursor,
  normaliseLimit,
  tenantScope,
} from "./helpers/index";
import { tenants } from "./schema/tenants";

const dialect = new SQLiteSyncDialect();
const ctx = {
  tenantId: "t_bench",
  workspaceId: "w_bench",
  requestId: "req_bench",
} as const;

// Pre-encoded sample cursor used by the decode bench so we don't measure
// the encoder twice.
const SAMPLE_CURSOR = encodeCursor("k_0123456789_abcdef");

// Synthetic 200-row page used by buildPage so the measurement covers
// realistic slice + cursor work, not an empty array.
const ROWS = Array.from({ length: 200 }, (_, i) => ({ id: `row_${i}` }));

const bench = (name: string, fn: () => unknown | Promise<unknown>) => ({
  name,
  fn,
});

async function main() {
  const samples = await runBench(".bench-results.json", [
    /** @budget 0.05ms */
    bench("encode cursor", () => encodeCursor("k_0123456789_abcdef")),

    /** @budget 0.05ms */
    bench("decode cursor", () => decodeCursor(SAMPLE_CURSOR)),

    /** @budget 0.05ms */
    bench("normalise limit", () => normaliseLimit(50)),

    /** @budget 0.5ms */
    bench("buildPage 200 rows", () => buildPage(ROWS, 100, (r) => r.id)),

    /** @budget 0.5ms */
    bench("tenantScope SQL build", () =>
      dialect.sqlToQuery(tenantScope(ctx, tenants)),
    ),
  ]);

  process.stdout.write(
    `\n@workspace/db benchmarks:\n${formatBenchSummary(samples)}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(
    `bench failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
