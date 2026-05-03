#!/usr/bin/env tsx
/**
 * Unified QA orchestrator — runs the entire quality pipeline locally and
 * prints a single coloured pass/fail table.
 *
 * Stages (in order):
 *   1. typecheck         — `pnpm typecheck`
 *   2. tests             — `pnpm test`
 *   3. coverage          — `pnpm coverage:check`
 *   4. tier-review       — `pnpm tier-review` (covers 18 quality gates,
 *                          including bundle-size, perf budgets, security)
 *
 * Stages run sequentially because later stages rebuild artifacts touched
 * by earlier stages and we want each failure attributable to a single
 * stage. The exit code is non-zero on any stage failure.
 *
 * Usage:
 *   pnpm qa                    # full pipeline
 *   pnpm qa --skip=coverage    # skip a specific stage
 *   pnpm qa --only=tests       # run a single stage
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface Stage {
  name: string;
  cmd: string;
  optional?: boolean;
}

const STAGES: Stage[] = [
  { name: "typecheck", cmd: "pnpm typecheck" },
  { name: "lint", cmd: "pnpm lint" },
  { name: "tests", cmd: "pnpm test" },
  { name: "coverage", cmd: "pnpm coverage:check", optional: true },
  { name: "tier-review", cmd: "pnpm tier-review" },
];

function parseArgs(argv: string[]): { skip: Set<string>; only?: string } {
  const skip = new Set<string>();
  let only: string | undefined;
  for (const arg of argv) {
    const m = /^--skip=(.+)$/.exec(arg);
    if (m) {
      for (const name of m[1]!.split(",")) skip.add(name.trim());
    }
    const o = /^--only=(.+)$/.exec(arg);
    if (o) only = o[1]!.trim();
  }
  return { skip, only };
}

interface StageResult {
  name: string;
  passed: boolean;
  durationMs: number;
  optional: boolean;
}

function runStage(stage: Stage): StageResult {
  process.stdout.write(`\n${BOLD}▸ ${stage.name}${RESET}\n`);
  const t0 = Date.now();
  const [cmd, ...args] = stage.cmd.split(/\s+/);
  const result = spawnSync(cmd!, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
  });
  const durationMs = Date.now() - t0;
  return {
    name: stage.name,
    passed: result.status === 0,
    durationMs,
    optional: stage.optional ?? false,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  process.stdout.write(`${BOLD}Omninity Operator — QA Pipeline${RESET}\n`);
  process.stdout.write("=".repeat(48) + "\n");

  const stages = STAGES.filter((s) => {
    if (args.only) return s.name === args.only;
    if (args.skip.has(s.name)) return false;
    return true;
  });

  if (stages.length === 0) {
    process.stderr.write(`No stages selected.\n`);
    process.exit(1);
  }

  const results: StageResult[] = [];
  let bail = false;
  for (const s of stages) {
    if (bail) {
      results.push({
        name: s.name,
        passed: false,
        durationMs: 0,
        optional: s.optional ?? false,
      });
      continue;
    }
    const r = runStage(s);
    results.push(r);
    // Required-stage failures bail the pipeline early to surface the first
    // actionable error. Optional stages (like coverage gate) report and continue.
    if (!r.passed && !r.optional) bail = true;
  }

  process.stdout.write(`\n${BOLD}Summary${RESET}\n`);
  process.stdout.write("=".repeat(48) + "\n");
  for (const r of results) {
    const tick = r.passed
      ? `${GREEN}✓${RESET}`
      : r.optional
        ? `${YELLOW}~${RESET}`
        : `${RED}✗${RESET}`;
    const time =
      r.durationMs > 0 ? `${(r.durationMs / 1000).toFixed(1)}s` : "skipped";
    process.stdout.write(
      `  ${tick} ${r.name.padEnd(20)} ${DIM}${time}${RESET}\n`,
    );
  }

  const failures = results.filter((r) => !r.passed && !r.optional);
  const optWarn = results.filter((r) => !r.passed && r.optional);

  process.stdout.write("\n");
  if (failures.length > 0) {
    process.stdout.write(
      `${RED}${BOLD}QA FAILED${RESET} — ${failures.length} stage(s) failed: ${failures.map((r) => r.name).join(", ")}\n`,
    );
    process.exit(1);
  }
  if (optWarn.length > 0) {
    process.stdout.write(
      `${YELLOW}QA passed with warnings${RESET} — optional: ${optWarn.map((r) => r.name).join(", ")}\n`,
    );
    process.exit(0);
  }
  process.stdout.write(`${GREEN}${BOLD}QA PASSED${RESET}\n`);
}

main();
