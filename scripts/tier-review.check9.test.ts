#!/usr/bin/env tsx
/**
 * Fixture tests for Check 9 (performance budget compliance) in tier-review.ts.
 *
 * Exercises parseBudgetAnnotations() and parseVitestBenchOutput() with
 * synthetic source and JSON to prove:
 *  - JSDoc-style /** @budget Nms *​/ above bench() pairs correctly
 *  - Single-line and multi-line JSDoc forms both parse
 *  - "p95" metric is captured; default metric is "mean"
 *  - "ms" suffix is optional
 *  - Orphaned annotations (no bench() following) are ignored
 *  - vitest JSON output is parsed across both `testResults` and `files` shapes
 *
 * Usage: pnpm run tier-review:check9-test
 */

import assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  findPackageRoot,
  parseBudgetAnnotations,
  parseVitestBenchOutput,
} from "./tier-review.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    const err = e instanceof assert.AssertionError ? e.message : String(e);
    console.log(`  ✗  ${name}\n     ${err}`);
    failed++;
  }
}

// ─── parseBudgetAnnotations tests ─────────────────────────────────────────────

test("single-line JSDoc /** @budget 50ms p95 */ pairs with bench on next line", () => {
  const src = [
    `import { bench, describe } from "vitest";`,
    ``,
    `describe("kb search", () => {`,
    `  /** @budget 50ms p95 */`,
    `  bench("top-10 against 10k corpus", async () => {`,
    `    await search();`,
    `  });`,
    `});`,
  ].join("\n");

  const out = parseBudgetAnnotations(src, "kb.bench.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].benchName, "top-10 against 10k corpus");
  assert.strictEqual(out[0].budgetMs, 50);
  assert.strictEqual(out[0].metric, "p95");
  assert.strictEqual(out[0].file, "kb.bench.ts");
  assert.strictEqual(out[0].line, 5);
});

test("multi-line JSDoc with @budget on inner line still pairs with bench", () => {
  const src = [
    `/**`,
    ` * Knowledge base hot path.`,
    ` * @budget 300 mean`,
    ` */`,
    `bench("search hot path", async () => {});`,
  ].join("\n");

  const out = parseBudgetAnnotations(src);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].budgetMs, 300);
  assert.strictEqual(out[0].metric, "mean");
  assert.strictEqual(out[0].benchName, "search hot path");
});

test("metric defaults to mean when unspecified", () => {
  const src = [`/** @budget 100ms */`, `bench("default metric", () => {});`].join("\n");
  const out = parseBudgetAnnotations(src);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].metric, "mean");
  assert.strictEqual(out[0].budgetMs, 100);
});

test("ms suffix is optional — bare number parses identically", () => {
  const src = [`/** @budget 75 p95 */`, `bench("no ms suffix", () => {});`].join("\n");
  const out = parseBudgetAnnotations(src);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].budgetMs, 75);
  assert.strictEqual(out[0].metric, "p95");
});

test("orphaned @budget with no bench() following is ignored", () => {
  const src = [
    `/** @budget 50ms */`,
    `// no bench call here, just a comment`,
    `const x = 1;`,
  ].join("\n");
  const out = parseBudgetAnnotations(src);
  assert.strictEqual(out.length, 0, `Expected 0, got: ${JSON.stringify(out)}`);
});

test("multiple budgets in one file all pair correctly", () => {
  const src = [
    `/** @budget 50ms p95 */`,
    `bench("first", () => {});`,
    ``,
    `/** @budget 200 */`,
    `bench("second", () => {});`,
  ].join("\n");
  const out = parseBudgetAnnotations(src);
  assert.strictEqual(out.length, 2, JSON.stringify(out));
  assert.strictEqual(out[0].benchName, "first");
  assert.strictEqual(out[0].metric, "p95");
  assert.strictEqual(out[1].benchName, "second");
  assert.strictEqual(out[1].budgetMs, 200);
  assert.strictEqual(out[1].metric, "mean");
});

test("blank lines between JSDoc and bench() do NOT break the pairing", () => {
  // The parser walks past blank/comment lines to find the next code line.
  const src = [
    `/** @budget 100ms */`,
    ``,
    `// a comment in between`,
    ``,
    `bench("with gap", () => {});`,
  ].join("\n");
  const out = parseBudgetAnnotations(src);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].benchName, "with gap");
});

// ─── parseVitestBenchOutput tests ─────────────────────────────────────────────

test("parses newer testResults shape with result.benchmark", () => {
  const json = JSON.stringify({
    testResults: [
      {
        name: "bench file",
        tasks: [
          {
            name: "top-10 against 10k corpus",
            result: { benchmark: { mean: 42.5, p95: 60.1 } },
          },
        ],
      },
    ],
  });
  const out = parseVitestBenchOutput(json);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].name, "top-10 against 10k corpus");
  assert.strictEqual(out[0].meanMs, 42.5);
  assert.strictEqual(out[0].p95Ms, 60.1);
});

test("parses older files/tasks/suites shape", () => {
  const json = JSON.stringify({
    files: [
      {
        tasks: [
          {
            suites: [
              {
                tasks: [
                  {
                    name: "search hot path",
                    result: { benchmark: { mean: 280, percentile95: 350 } },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const out = parseVitestBenchOutput(json);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].name, "search hot path");
  assert.strictEqual(out[0].meanMs, 280);
  assert.strictEqual(out[0].p95Ms, 350);
});

test("invalid JSON returns empty array (does not throw)", () => {
  const out = parseVitestBenchOutput("not json at all {{{");
  assert.deepStrictEqual(out, []);
});

test("missing benchmark stat is silently skipped", () => {
  const json = JSON.stringify({
    testResults: [
      { name: "no bench here", result: { state: "pass" } },
      { name: "real bench", result: { benchmark: { mean: 10 } } },
    ],
  });
  const out = parseVitestBenchOutput(json);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, "real bench");
  assert.strictEqual(out[0].meanMs, 10);
  assert.strictEqual(out[0].p95Ms, undefined);
});

// ─── findPackageRoot tests ────────────────────────────────────────────────────

test("findPackageRoot walks up to nearest package.json", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tier-review-"));
  try {
    const pkgDir = path.join(tmp, "pkg-a");
    const subDir = path.join(pkgDir, "src", "deep", "nested");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), "{}");
    const file = path.join(subDir, "thing.bench.ts");
    fs.writeFileSync(file, "");

    const found = findPackageRoot(file, tmp);
    assert.strictEqual(found, pkgDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("findPackageRoot returns null when no package.json exists above the file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tier-review-"));
  try {
    const subDir = path.join(tmp, "no-package", "src");
    fs.mkdirSync(subDir, { recursive: true });
    const file = path.join(subDir, "lonely.bench.ts");
    fs.writeFileSync(file, "");

    const found = findPackageRoot(file, tmp);
    assert.strictEqual(found, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("findPackageRoot picks the NEAREST package.json, not the workspace root", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tier-review-"));
  try {
    fs.writeFileSync(path.join(tmp, "package.json"), "{}");
    const innerPkg = path.join(tmp, "lib", "inner");
    fs.mkdirSync(innerPkg, { recursive: true });
    fs.writeFileSync(path.join(innerPkg, "package.json"), "{}");
    const file = path.join(innerPkg, "src", "x.bench.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");

    const found = findPackageRoot(file, tmp);
    assert.strictEqual(found, innerPkg);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log();
console.log(`Check 9 fixture tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
