#!/usr/bin/env tsx
/**
 * Performance benchmarks for @workspace/errors.
 *
 * Covers the fast paths only: `withTimeout` on a resolved promise,
 * `defaultShouldRetry` decision logic, and the `toApiError` mapper that
 * runs in the global Express error handler. None of these may exceed
 * sub-millisecond budgets — they sit in front of every request.
 */
import { runBench, formatBenchSummary } from "@workspace/scripts/bench-runner";

import {
  defaultShouldRetry,
  toApiError,
  ValidationError,
  withTimeout,
} from "./index.js";

const bench = (name: string, fn: () => unknown | Promise<unknown>) => ({
  name,
  fn,
});

const SAMPLE_ERR = new ValidationError("bench validation failure");

async function main() {
  const samples = await runBench(".bench-results.json", [
    /** @budget 0.5ms */
    bench("withTimeout (already-resolved)", async () => {
      await withTimeout(Promise.resolve(1), 1000);
    }),

    /** @budget 0.05ms */
    bench("defaultShouldRetry on validation", () =>
      defaultShouldRetry(SAMPLE_ERR, 0),
    ),

    /** @budget 0.1ms */
    bench("toApiError mapping", () => toApiError(SAMPLE_ERR)),
  ]);

  process.stdout.write(
    `\n@workspace/errors benchmarks:\n${formatBenchSummary(samples)}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(
    `bench failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
