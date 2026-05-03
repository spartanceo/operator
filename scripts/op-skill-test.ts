#!/usr/bin/env tsx
/**
 * `op skill test` (Task #39) — CLI entry-point that runs the manifest
 * test cases for a local skill source + manifest pair without needing
 * the API server to be running.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run op-skill-test <manifest.json> <source.js>
 *
 * Exit code 0 on all-pass, 1 on any failure. Emits a colourless,
 * machine-friendly summary so it can be wired into CI.
 */
import { readFileSync } from "node:fs";
import { argv, exit, stderr, stdout } from "node:process";

import {
  parseManifest,
  ManifestValidationError,
} from "../artifacts/api-server/src/skill-runtime/manifest";
import { executeSkill } from "../artifacts/api-server/src/skill-runtime/executor";
import type { SkillResult, SkillTestCase } from "@workspace/types";

async function main(): Promise<void> {
  const manifestPath = argv[2];
  const sourcePath = argv[3];
  if (!manifestPath || !sourcePath) {
    stderr.write(
      "Usage: op-skill-test <manifest.json> <source.js>\n",
    );
    exit(2);
  }
  const manifest = (() => {
    try {
      return parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    } catch (e) {
      if (e instanceof ManifestValidationError) {
        stderr.write(`manifest invalid (${e.path}): ${e.message}\n`);
      } else {
        stderr.write(
          `manifest unreadable: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
      exit(2);
    }
  })();
  const source = readFileSync(sourcePath, "utf8");
  const cases = manifest.testCases ?? [];
  if (cases.length === 0) {
    stdout.write("No test cases declared in manifest.\n");
    exit(0);
  }
  let failed = 0;
  for (const tc of cases) {
    const ok = await runOne(manifest, source, tc);
    stdout.write(`${ok.passed ? "PASS" : "FAIL"}  ${tc.name}${ok.passed ? "" : `  — ${ok.reason}`}\n`);
    if (!ok.passed) failed++;
  }
  stdout.write(
    `\n${failed === 0 ? "✓" : "✗"} ${cases.length - failed}/${cases.length} test(s) passed\n`,
  );
  exit(failed === 0 ? 0 : 1);
}

interface CaseOutcome {
  readonly passed: boolean;
  readonly reason?: string;
}

async function runOne(
  manifest: ReturnType<typeof parseManifest>,
  source: string,
  tc: SkillTestCase,
): Promise<CaseOutcome> {
  const result: SkillResult = await executeSkill({
    manifest,
    source,
    input: tc.input,
    tenantId: "cli",
    workspaceId: "cli",
    toolBindings: {},
    timeoutMs: tc.timeoutMs,
  });
  const expectedStatus = tc.expectedStatus ?? "success";
  if (result.status !== expectedStatus) {
    return {
      passed: false,
      reason: `status ${result.status} ≠ ${expectedStatus}${
        result.error ? ` (${result.error.message})` : ""
      }`,
    };
  }
  if (
    tc.expectedSummaryIncludes !== undefined &&
    !result.summary.includes(tc.expectedSummaryIncludes)
  ) {
    return { passed: false, reason: `summary missing "${tc.expectedSummaryIncludes}"` };
  }
  if (
    tc.expectedOutput !== undefined &&
    JSON.stringify(result.output) !== JSON.stringify(tc.expectedOutput)
  ) {
    return { passed: false, reason: `output mismatch` };
  }
  return { passed: true };
}

main().catch((e) => {
  stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  exit(2);
});
