/**
 * Tiny benchmark runner — emits vitest-bench-compatible JSON.
 *
 * Why: tier-review Check #9 already parses vitest's bench JSON shape
 * (`{ files: [{ tasks: [{ name, result: { benchmark: { mean, p95 } } }] }] }`).
 * Rather than introduce vitest as a dependency just for benchmarking, we
 * own both producer (this runner) and consumer (tier-review), so we can
 * emit the same shape with zero extra deps.
 *
 * Usage from a package:
 *   import { runBench } from "@workspace/scripts/bench-runner";
 *   await runBench(".bench-results.json", [
 *     { name: "encode cursor", fn: () => encodeCursor("abc") },
 *     { name: "decode cursor", fn: async () => decodeCursor(token) },
 *   ]);
 *
 * Each bench is run for at least `minIterations` iterations AND `minDurationMs`
 * milliseconds — whichever takes longer. Mean and p95 are computed from all
 * sample durations in milliseconds.
 *
 * Standard 12: writes JSON to disk; tier-review reads from
 * `<package>/.bench-results.json`.
 */
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

export interface BenchSpec {
  /** Stable name used to look up the @budget annotation in tier-review. */
  readonly name: string;
  /** The work to measure. Sync or async. */
  readonly fn: () => unknown | Promise<unknown>;
  /** Override defaults for this single bench (e.g. expensive setups). */
  readonly minIterations?: number;
  readonly minDurationMs?: number;
}

interface BenchSample {
  readonly name: string;
  readonly mean: number;
  readonly p95: number;
  readonly samples: number;
}

const DEFAULT_MIN_ITERATIONS = 25;
const DEFAULT_MIN_DURATION_MS = 200;

async function runOne(spec: BenchSpec): Promise<BenchSample> {
  const minIter = spec.minIterations ?? DEFAULT_MIN_ITERATIONS;
  const minMs = spec.minDurationMs ?? DEFAULT_MIN_DURATION_MS;

  // Warm up — discard first 3 samples so JIT/branch-predictor settle.
  for (let i = 0; i < 3; i++) {
    await spec.fn();
  }

  const samples: number[] = [];
  const started = performance.now();
  while (samples.length < minIter || performance.now() - started < minMs) {
    const t0 = performance.now();
    await spec.fn();
    samples.push(performance.now() - t0);
    // Hard cap so a slow bench can't run forever.
    if (samples.length > 10_000) break;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[p95Idx]!;
  return { name: spec.name, mean, p95, samples: samples.length };
}

/**
 * Run all benches sequentially and write the vitest-compatible JSON to
 * `outputFile`. Returns the parsed sample list so callers can log a summary.
 */
export async function runBench(
  outputFile: string,
  specs: ReadonlyArray<BenchSpec>,
): Promise<ReadonlyArray<BenchSample>> {
  const results: BenchSample[] = [];
  for (const spec of specs) {
    const sample = await runOne(spec);
    results.push(sample);
  }

  // vitest bench JSON shape — see scripts/tier-review.ts parseVitestBenchOutput.
  const payload = {
    files: [
      {
        tasks: results.map((r) => ({
          name: r.name,
          result: {
            benchmark: {
              mean: r.mean,
              p95: r.p95,
              samples: r.samples,
            },
          },
        })),
      },
    ],
  };

  writeFileSync(outputFile, JSON.stringify(payload, null, 2));
  return results;
}

/**
 * Format a one-line summary suitable for console output. Used by package
 * bench scripts so the developer sees mean/p95 for each bench.
 */
export function formatBenchSummary(
  samples: ReadonlyArray<BenchSample>,
): string {
  const lines = samples.map(
    (s) =>
      `  ${s.name.padEnd(40)} mean ${s.mean.toFixed(3)}ms  p95 ${s.p95.toFixed(3)}ms  (${s.samples} samples)`,
  );
  return lines.join("\n");
}
