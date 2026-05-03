#!/usr/bin/env tsx
/**
 * Lint stage for the QA pipeline.
 *
 * The project does not use ESLint — TypeScript strict mode + the 18
 * tier-review structural checks already cover the rules a typical
 * JS-lint config enforces. This stage adds the one thing tier-review
 * does NOT cover: formatting consistency.
 *
 * It runs `prettier --check` on the QA-pipeline source files and any
 * other path explicitly opted in via the `LINT_SCOPE` array. The full
 * codebase is NOT prettified yet (~250 legacy files would need to be
 * reformatted in a separate, dedicated commit) — until that happens
 * we lint only the files this pipeline owns plus anything new.
 *
 * Usage:
 *   pnpm lint           # check formatting
 *   pnpm lint --fix     # auto-format files (uses `prettier --write`)
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const FIX_MODE = process.argv.slice(2).includes("--fix");

// Scope of the lint stage. Add new paths here as more of the codebase
// gets prettified. Each entry is a glob relative to the repo root.
const LINT_SCOPE = [
  "scripts/src/bench-runner.ts",
  "scripts/src/coverage.ts",
  "scripts/src/flaky-detect.ts",
  "scripts/src/lint.ts",
  "scripts/src/qa.ts",
  "lib/db/src/helpers.bench.ts",
  "lib/errors/src/errors.bench.ts",
  "artifacts/api-server/src/security.test.ts",
];

function run(cmd: string, args: string[]): number {
  process.stdout.write(`\u25b8 ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: false });
  return r.status ?? 1;
}

const prettierArgs = [
  "exec",
  "prettier",
  FIX_MODE ? "--write" : "--check",
  "--log-level",
  "warn",
  ...LINT_SCOPE,
];

process.stdout.write(
  `Lint \u2014 ${FIX_MODE ? "fixing" : "checking"} formatting on ${LINT_SCOPE.length} file(s)\n`,
);

const code = run("pnpm", prettierArgs);
if (code !== 0) {
  process.stderr.write(
    FIX_MODE
      ? `\nLint --fix reported errors above.\n`
      : `\nLint failed \u2014 run \`pnpm lint --fix\` to auto-format.\n`,
  );
  process.exit(code);
}
process.stdout.write(`\n\u2713 Lint passed.\n`);
