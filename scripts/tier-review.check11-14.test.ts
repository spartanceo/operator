#!/usr/bin/env tsx
/**
 * Fixture tests for Checks 11–14 (Standard 12 — Security Patterns) in
 * tier-review.ts.
 *
 * Exercises the four exported parser functions with synthetic source/JSON to
 * prove the rules described in Standard 12 of the bug-prevention standards
 * are enforced exactly:
 *  - findDangerousExec    (Check 11)
 *  - findUnsafeHtml       (Check 12)
 *  - parseAuditOutput     (Check 13)
 *  - findRawSqlInterpolation (Check 14)
 *
 * Usage: pnpm run tier-review:check11-14-test
 */

import assert from "assert";
import {
  findDangerousExec,
  findRawSqlInterpolation,
  findUnsafeHtml,
  parseAuditOutput,
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

// ─── Check 11: findDangerousExec ──────────────────────────────────────────────

test("flags bare eval(...)", () => {
  const src = `const result = eval(userInput);`;
  const out = findDangerousExec(src, "f.ts", false);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].pattern, "eval");
  assert.strictEqual(out[0].line, 1);
});

test("does NOT flag .eval() method calls or identifiers ending in eval", () => {
  const src = [
    `expr.eval();`,
    `myEval(x);`,
    `obj.evalSomething();`,
  ].join("\n");
  const out = findDangerousExec(src, "f.ts", false);
  assert.strictEqual(out.length, 0, `Expected 0, got: ${JSON.stringify(out)}`);
});

test("flags new Function(...)", () => {
  const src = `const fn = new Function("a", "return a + 1");`;
  const out = findDangerousExec(src, "f.ts", false);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].pattern, "new Function");
});

test("flags vm.runInNewContext outside the sandbox file", () => {
  const src = `vm.runInNewContext(code, ctx);`;
  const out = findDangerousExec(src, "some/other/file.ts", false);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].pattern, "vm.runInNewContext");
});

test("does NOT flag vm.runInNewContext inside the sandbox file (allowlisted)", () => {
  const src = `vm.runInNewContext(skillCode, sandboxCtx);`;
  const out = findDangerousExec(src, "artifacts/api-server/src/skill-runtime/sandbox.ts", true);
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("eval and new Function are forbidden EVEN inside the sandbox file", () => {
  const src = [`eval(x);`, `new Function("y");`].join("\n");
  const out = findDangerousExec(src, "artifacts/api-server/src/skill-runtime/sandbox.ts", true);
  assert.strictEqual(out.length, 2, JSON.stringify(out));
});

test("ignores forbidden patterns inside comment-only lines", () => {
  const src = [
    `// example: eval(x) — do not do this`,
    ` * Avoid: new Function(...)`,
    `// vm.runInNewContext(code) is forbidden`,
  ].join("\n");
  const out = findDangerousExec(src, "f.ts", false);
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

// ─── Check 12: findUnsafeHtml ─────────────────────────────────────────────────

test("flags dangerouslySetInnerHTML without DOMPurify in window", () => {
  const src = `<div dangerouslySetInnerHTML={{ __html: post.body }} />`;
  const out = findUnsafeHtml(src, "Post.tsx");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
});

test("does NOT flag dangerouslySetInnerHTML when DOMPurify.sanitize is on the same line", () => {
  const src = `<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(post.body) }} />`;
  const out = findUnsafeHtml(src, "Post.tsx");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("does NOT flag when DOMPurify.sanitize is in a nearby line", () => {
  const src = [
    `const safe = DOMPurify.sanitize(post.body);`,
    `return <div dangerouslySetInnerHTML={{ __html: safe }} />;`,
  ].join("\n");
  const out = findUnsafeHtml(src, "Post.tsx");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("ignores comments mentioning dangerouslySetInnerHTML", () => {
  const src = `// Never use dangerouslySetInnerHTML without DOMPurify`;
  const out = findUnsafeHtml(src, "doc.tsx");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

// Architect-flagged false negative: a nearby DOMPurify.sanitize call on an
// UNRELATED variable used to pass the proximity heuristic. The tightened
// detector requires sanitize to live INSIDE the prop expression OR be the
// declarative source of the bound variable.
test("flags when DOMPurify.sanitize nearby is on an UNRELATED variable", () => {
  const src = [
    `const safe = DOMPurify.sanitize(otherContent);`,
    `return <div dangerouslySetInnerHTML={{ __html: rawContent }} />;`,
  ].join("\n");
  const out = findUnsafeHtml(src, "Post.tsx");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
});

// The tightened parser walks across lines using bracket matching so multiline
// JSX prop expressions are handled correctly.
test("does NOT flag multiline JSX prop with DOMPurify.sanitize inside", () => {
  const src = [
    `<div`,
    `  dangerouslySetInnerHTML={{`,
    `    __html: DOMPurify.sanitize(post.body),`,
    `  }}`,
    `/>`,
  ].join("\n");
  const out = findUnsafeHtml(src, "Post.tsx");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("flags multiline JSX prop with NO DOMPurify.sanitize inside", () => {
  const src = [
    `<div`,
    `  dangerouslySetInnerHTML={{`,
    `    __html: post.body,`,
    `  }}`,
    `/>`,
  ].join("\n");
  const out = findUnsafeHtml(src, "Post.tsx");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
});

// ─── Check 13: parseAuditOutput ───────────────────────────────────────────────

test("returns clean summary when there are no vulnerabilities", () => {
  const json = JSON.stringify({
    advisories: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
  });
  const out = parseAuditOutput(json);
  assert.ok(out, "expected summary, got null");
  assert.strictEqual(out!.high, 0);
  assert.strictEqual(out!.critical, 0);
  assert.strictEqual(out!.advisoryTitles.length, 0);
});

test("captures high/critical advisory titles", () => {
  const json = JSON.stringify({
    advisories: {
      "1": { severity: "critical", title: "RCE in foo", module_name: "foo" },
      "2": { severity: "high", title: "XSS in bar", module_name: "bar" },
      "3": { severity: "moderate", title: "Info leak", module_name: "baz" },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 1 } },
  });
  const out = parseAuditOutput(json);
  assert.ok(out);
  assert.strictEqual(out!.critical, 1);
  assert.strictEqual(out!.high, 1);
  assert.strictEqual(out!.moderate, 1);
  assert.strictEqual(out!.advisoryTitles.length, 2, JSON.stringify(out));
  assert.ok(out!.advisoryTitles.some((t) => t.includes("foo") && t.includes("critical")));
  assert.ok(out!.advisoryTitles.some((t) => t.includes("bar") && t.includes("high")));
});

test("returns null on invalid JSON", () => {
  assert.strictEqual(parseAuditOutput("not json {{"), null);
});

test("missing metadata.vulnerabilities yields zero counts", () => {
  const json = JSON.stringify({ advisories: {}, metadata: {} });
  const out = parseAuditOutput(json);
  assert.ok(out);
  assert.strictEqual(out!.high, 0);
  assert.strictEqual(out!.critical, 0);
});

// ─── Check 14: findRawSqlInterpolation ────────────────────────────────────────

test("flags db.run with template literal containing ${...}", () => {
  const src = "db.run(`UPDATE users SET name = ${name} WHERE id = ${id}`);";
  const out = findRawSqlInterpolation(src, "f.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].reason, "template literal");
});

test("flags db.exec with string concatenation", () => {
  const src = `db.exec("DELETE FROM x WHERE id = " + id);`;
  const out = findRawSqlInterpolation(src, "f.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].reason, "string concatenation");
});

test("does NOT flag Drizzle's sql tagged template", () => {
  const src = "db.run(sql`SELECT * FROM users WHERE id = ${id}`);";
  const out = findRawSqlInterpolation(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("does NOT flag Drizzle typed builder chained .all() with no args", () => {
  const src = `const rows = db.select().from(users).where(eq(users.id, id)).all();`;
  const out = findRawSqlInterpolation(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("does NOT flag db.prepare with a constant string (no interpolation)", () => {
  const src = `const stmt = db.prepare("SELECT * FROM users WHERE id = ?");`;
  const out = findRawSqlInterpolation(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("flags db.all/get/prepare equally, not just exec/run", () => {
  const src = [
    "db.all(`SELECT * FROM x WHERE k = ${k}`);",
    'db.get("SELECT 1 WHERE y = " + y);',
    "db.prepare(`UPDATE z SET v = ${v}`);",
  ].join("\n");
  const out = findRawSqlInterpolation(src, "f.ts");
  assert.strictEqual(out.length, 3, JSON.stringify(out));
});

test("ignores raw SQL patterns inside comment-only lines", () => {
  const src = [
    "// Forbidden: db.run(`UPDATE x SET y = ${y}`)",
    ' * Bad pattern: db.exec("..." + id)',
  ].join("\n");
  const out = findRawSqlInterpolation(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

// Architect-flagged false negative: a multi-line db.run call where the
// template literal lives on a different line than the call opener used to
// pass the single-line regex. The bracket-matched parser now handles this.
test("flags multi-line db.run with template literal on a separate line", () => {
  const src = [
    `db.run(`,
    "  `UPDATE users SET name = ${name} WHERE id = ${id}`,",
    `);`,
  ].join("\n");
  const out = findRawSqlInterpolation(src, "f.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].reason, "template literal");
});

test("flags multi-line db.exec with string concatenation across lines", () => {
  const src = [
    `db.exec(`,
    `  "DELETE FROM x WHERE id = " +`,
    `  String(id),`,
    `);`,
  ].join("\n");
  const out = findRawSqlInterpolation(src, "f.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].reason, "string concatenation");
});

test("does NOT flag multi-line Drizzle sql tagged template across lines", () => {
  const src = [
    `db.run(`,
    "  sql`SELECT * FROM users WHERE id = ${id}`,",
    `);`,
  ].join("\n");
  const out = findRawSqlInterpolation(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log();
console.log(`Checks 11–14 fixture tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
