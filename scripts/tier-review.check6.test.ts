#!/usr/bin/env tsx
/**
 * Fixture tests for Check 6 (API envelope validation) in tier-review.ts.
 *
 * Exercises parseOpenApiEnvelopeProblems() with synthetic YAML to prove:
 *  - $ref schemas that have "success" pass
 *  - $ref schemas that lack "success" fail
 *  - inline schemas with "success" pass
 *  - inline schemas without "success" fail (including after the block ends)
 *  - non-2xx responses are not checked
 *  - routes with no content body are not checked
 *
 * Usage: pnpm run tier-review:test
 */

import assert from "assert";
import { parseOpenApiEnvelopeProblems } from "./tier-review.ts";

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

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const HEADER = `openapi: 3.1.0
info:
  title: TestApi
  version: 0.0.0
paths:`;

function spec(paths: string, components = ""): string {
  return `${HEADER}
${paths}
${components ? `components:\n  schemas:\n${components}` : ""}`.trim();
}

// ─── $ref tests ───────────────────────────────────────────────────────────────

test("$ref schema WITH success: passes", () => {
  const yaml = spec(
    `  /foo:
    get:
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/FooResponse"`,
    `    FooResponse:
      type: object
      properties:
        success:
          type: boolean
        data:
          type: object`,
  );
  const problems = parseOpenApiEnvelopeProblems(yaml);
  assert.strictEqual(problems.length, 0, `Expected 0 problems, got: ${JSON.stringify(problems)}`);
});

test("$ref schema WITHOUT success: fails with route label", () => {
  const yaml = spec(
    `  /bar:
    post:
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/BarResponse"`,
    `    BarResponse:
      type: object
      properties:
        data:
          type: object`,
  );
  const problems = parseOpenApiEnvelopeProblems(yaml);
  assert.strictEqual(problems.length, 1, `Expected 1 problem, got: ${JSON.stringify(problems)}`);
  assert.ok(
    problems[0].includes("POST") && problems[0].includes("/bar") && problems[0].includes("BarResponse"),
    `Problem message should reference route and schema: ${problems[0]}`,
  );
});

// ─── Inline schema tests ──────────────────────────────────────────────────────

test("inline schema WITH success: passes", () => {
  const yaml = spec(`  /inline-ok:
    get:
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  success:
                    type: boolean
                  data:
                    type: object`);
  const problems = parseOpenApiEnvelopeProblems(yaml);
  assert.strictEqual(problems.length, 0, `Expected 0 problems, got: ${JSON.stringify(problems)}`);
});

test("inline schema WITHOUT success: fails (including when parser has left the block)", () => {
  // The properties block ends before the file ends — the fix for the
  // sawInlineProperties bug ensures this still reports a failure.
  const yaml = spec(`  /inline-bad:
    delete:
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
                required:
                  - id`);
  const problems = parseOpenApiEnvelopeProblems(yaml);
  assert.strictEqual(problems.length, 1, `Expected 1 problem, got: ${JSON.stringify(problems)}`);
  assert.ok(
    problems[0].includes("DELETE") && problems[0].includes("/inline-bad"),
    `Problem should reference route: ${problems[0]}`,
  );
});

// ─── Non-2xx / no-body tests ─────────────────────────────────────────────────

test("non-2xx responses (4xx) are not checked", () => {
  const yaml = spec(
    `  /err:
    get:
      responses:
        "404":
          description: Not Found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorBody"`,
    `    ErrorBody:
      type: object
      properties:
        message:
          type: string`,
  );
  const problems = parseOpenApiEnvelopeProblems(yaml);
  assert.strictEqual(problems.length, 0, `4xx responses should not be checked: ${JSON.stringify(problems)}`);
});

test("2xx response with no content body is not checked", () => {
  const yaml = spec(`  /no-body:
    delete:
      responses:
        "204":
          description: No Content`);
  const problems = parseOpenApiEnvelopeProblems(yaml);
  assert.strictEqual(
    problems.length,
    0,
    `Responses with no content should not be checked: ${JSON.stringify(problems)}`,
  );
});

test("multiple routes: reports only the failing one", () => {
  const yaml = spec(
    `  /good:
    get:
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/GoodResponse"
  /bad:
    get:
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/BadResponse"`,
    `    GoodResponse:
      type: object
      properties:
        success:
          type: boolean
    BadResponse:
      type: object
      properties:
        data:
          type: object`,
  );
  const problems = parseOpenApiEnvelopeProblems(yaml);
  assert.strictEqual(problems.length, 1, `Expected 1 problem, got: ${JSON.stringify(problems)}`);
  assert.ok(problems[0].includes("/bad"), `Failing route should be /bad: ${problems[0]}`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log();
console.log(`Check 6 fixture tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
