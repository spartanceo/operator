#!/usr/bin/env tsx
/**
 * Omninity Operator — Tier Review Script
 *
 * Runs all 8 automated quality gates. Execute after every tier merges.
 * Exit 0 = all checks pass (safe to start next tier).
 * Exit 1 = one or more checks failed (fix before advancing).
 *
 * Usage: pnpm run tier-review
 */

import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const ROOT = path.resolve(import.meta.dirname, "../..");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

interface CheckResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  message: string;
  detail?: string[];
}

function tick(r: CheckResult): string {
  if (r.skipped) return `${YELLOW}~${RESET}`;
  return r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
}

function run(cmd: string, cwd = ROOT): { ok: boolean; output: string } {
  const result = spawnSync(cmd, { shell: true, cwd, encoding: "utf8" });
  return {
    ok: result.status === 0,
    output: (result.stdout ?? "") + (result.stderr ?? ""),
  };
}

function collectFiles(dir: string, ext: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
      } else if (ext.some((e) => entry.name.endsWith(e))) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function readLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n");
}

// ─── Check 1: TypeScript typecheck ───────────────────────────────────────────
function checkTypeScript(): CheckResult {
  const { ok, output } = run("pnpm run typecheck");
  if (ok) {
    return { name: "TypeScript typecheck", passed: true, message: "No type errors" };
  }
  const lines = output
    .split("\n")
    .filter((l) => l.includes("error TS"))
    .slice(0, 10);
  return {
    name: "TypeScript typecheck",
    passed: false,
    message: `Type errors found (${lines.length}${lines.length === 10 ? "+" : ""})`,
    detail: lines,
  };
}

// ─── Check 2: All tests passing ──────────────────────────────────────────────
function checkTests(): CheckResult {
  const testFiles = [
    ...collectFiles(path.join(ROOT, "artifacts"), [".test.ts", ".test.tsx", ".spec.ts"]),
    ...collectFiles(path.join(ROOT, "lib"), [".test.ts", ".test.tsx", ".spec.ts"]),
  ];
  if (testFiles.length === 0) {
    return {
      name: "All tests passing",
      passed: true,
      skipped: true,
      message: "No test files found — skipped (tests required from Tier 1 onwards)",
    };
  }
  const { ok, output } = run("pnpm test");
  if (ok) {
    return { name: "All tests passing", passed: true, message: "All tests pass" };
  }
  const failing = output
    .split("\n")
    .filter((l) => /FAIL|✕|× /.test(l))
    .slice(0, 10);
  return {
    name: "All tests passing",
    passed: false,
    message: "Test failures detected",
    detail: failing,
  };
}

// ─── Check 3: No console.log in source files ─────────────────────────────────
function checkConsoleLogs(): CheckResult {
  const sourceFiles = [
    ...collectFiles(path.join(ROOT, "artifacts"), [".ts", ".tsx"]),
    ...collectFiles(path.join(ROOT, "lib"), [".ts"]),
  ].filter(
    (f) =>
      !f.includes(".test.") &&
      !f.includes(".spec.") &&
      !f.includes("node_modules") &&
      !f.endsWith("tier-review.ts") &&
      !f.endsWith("hello.ts"),
  );

  const offenders: string[] = [];
  for (const file of sourceFiles) {
    const lines = readLines(file);
    lines.forEach((line, i) => {
      if (/console\.log\s*\(/.test(line)) {
        const rel = path.relative(ROOT, file);
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      }
    });
  }

  if (offenders.length === 0) {
    return { name: "No console.log in source files", passed: true, message: "Clean" };
  }
  return {
    name: "No console.log in source files",
    passed: false,
    message: `${offenders.length} occurrence(s) — use Pino logger instead`,
    detail: offenders.slice(0, 15),
  };
}

// ─── Check 4: No hardcoded hex colours in component files ────────────────────
const DESIGN_TOKEN_EXEMPT = [
  "design-tokens.ts",
  "design-tokens.tsx",
  "tokens.ts",
  "tailwind.config.ts",
  "tailwind.config.js",
];

function checkHardcodedColours(): CheckResult {
  const componentFiles = collectFiles(path.join(ROOT, "artifacts"), [".tsx"]).filter(
    (f) =>
      !f.includes("node_modules") &&
      !f.includes("mockup-sandbox") &&
      !DESIGN_TOKEN_EXEMPT.some((e) => f.endsWith(e)),
  );

  const HEX_RE = /#([0-9a-fA-F]{3,8})\b/g;
  const offenders: string[] = [];

  for (const file of componentFiles) {
    const lines = readLines(file);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      let m: RegExpExecArray | null;
      HEX_RE.lastIndex = 0;
      while ((m = HEX_RE.exec(line)) !== null) {
        const rel = path.relative(ROOT, file);
        offenders.push(`${rel}:${i + 1}  "${m[0]}"  ${trimmed.slice(0, 60)}`);
      }
    });
  }

  if (offenders.length === 0) {
    return { name: "No hardcoded hex colours in components", passed: true, message: "Clean" };
  }
  return {
    name: "No hardcoded hex colours in components",
    passed: false,
    message: `${offenders.length} hardcoded colour(s) — use design tokens instead`,
    detail: offenders.slice(0, 15),
  };
}

// ─── Check 5: Drizzle tables have required columns ───────────────────────────
const REQUIRED_COLS = ["id", "tenantId", "createdAt", "updatedAt"];
const VERSION_REQUIRED_UNLESS = [
  "idempotency",
  "event",
  "log",
  "audit",
  "seed",
  "migration",
  "junction",
  "map",
  "membership",
];

function checkDrizzleSchema(): CheckResult {
  const schemaFiles = [
    ...collectFiles(path.join(ROOT, "lib", "db"), [".ts"]),
    ...collectFiles(path.join(ROOT, "artifacts", "api-server"), [".ts"]),
  ].filter(
    (f) =>
      (f.includes("schema") || f.includes("Schema")) &&
      !f.includes("node_modules") &&
      !f.includes(".test."),
  );

  if (schemaFiles.length === 0) {
    return {
      name: "Drizzle tables have required columns",
      passed: true,
      skipped: true,
      message: "No schema files found — skipped (required from Task #37 onwards)",
    };
  }

  const problems: string[] = [];

  for (const file of schemaFiles) {
    const src = fs.readFileSync(file, "utf8");
    const tableRe = /(?:sqliteTable|pgTable)\s*\(\s*["'`](\w+)["'`]\s*,\s*\{([^}]+)\}/gs;
    let m: RegExpExecArray | null;
    while ((m = tableRe.exec(src)) !== null) {
      const tableName = m[1];
      const body = m[2];
      const rel = path.relative(ROOT, file);

      for (const col of REQUIRED_COLS) {
        const colSnake = col.replace(/([A-Z])/g, "_$1").toLowerCase();
        if (!body.includes(col) && !body.includes(colSnake)) {
          problems.push(`${rel}: table "${tableName}" missing column "${col}"`);
        }
      }

      const needsVersion = !VERSION_REQUIRED_UNLESS.some((keyword) =>
        tableName.toLowerCase().includes(keyword),
      );
      if (needsVersion && !body.includes("version")) {
        problems.push(`${rel}: table "${tableName}" missing "version" column (mutable record)`);
      }
    }
  }

  if (problems.length === 0) {
    return {
      name: "Drizzle tables have required columns",
      passed: true,
      message: `${schemaFiles.length} schema file(s) checked — all tables valid`,
    };
  }
  return {
    name: "Drizzle tables have required columns",
    passed: false,
    message: `${problems.length} table(s) missing required columns`,
    detail: problems,
  };
}

// ─── Check 6: API envelope on all OpenAPI 2xx response schemas ───────────────
function checkOpenApiEnvelope(): CheckResult {
  const specPath = path.join(ROOT, "lib", "api-spec", "openapi.yaml");
  if (!fs.existsSync(specPath)) {
    return {
      name: "API envelope on OpenAPI responses",
      passed: true,
      skipped: true,
      message: "openapi.yaml not found — skipped",
    };
  }

  const src = fs.readFileSync(specPath, "utf8");
  const lines = src.split("\n");
  const problems: string[] = [];
  const INLINE_ROUTE_RE = /^  (\/[^\s:]+):/;
  const METHOD_RE = /^    (get|post|put|patch|delete|head|options):/i;
  const STATUS_2XX_RE = /^        ["']?2\d{2}["']?:/;
  const CONTENT_RE = /^          content:/;
  const SCHEMA_REF_RE = /\$ref:\s*["']#\/components\/schemas\/(\w+)["']/;
  const SCHEMA_INLINE_PROPS_RE = /properties:/;

  let currentPath = "";
  let currentMethod = "";
  let inResponse = false;
  let statusLine = "";
  let hasContent = false;
  let schemaRef = "";
  let hasInlineProps = false;

  function flush() {
    if (!inResponse || !hasContent) return;
    if (schemaRef) {
      const schemaRe = new RegExp(`${schemaRef}:\\s*\\n((?:[ \\t]+[^\\n]+\\n)*)`, "m");
      const match = src.match(schemaRe);
      if (match && !match[1].includes("success:")) {
        problems.push(
          `${currentMethod.toUpperCase()} ${currentPath} ${statusLine.trim()} — $ref schema "${schemaRef}" lacks "success" property`,
        );
      }
    } else if (hasInlineProps && !src.includes("success:")) {
      problems.push(
        `${currentMethod.toUpperCase()} ${currentPath} ${statusLine.trim()} — inline schema lacks "success" property`,
      );
    }
  }

  for (const line of lines) {
    const routeMatch = INLINE_ROUTE_RE.exec(line);
    if (routeMatch) {
      flush();
      currentPath = routeMatch[1];
      inResponse = false;
      continue;
    }
    const methodMatch = METHOD_RE.exec(line);
    if (methodMatch) {
      flush();
      currentMethod = methodMatch[1];
      inResponse = false;
      hasContent = false;
      schemaRef = "";
      hasInlineProps = false;
      continue;
    }
    if (STATUS_2XX_RE.test(line)) {
      flush();
      statusLine = line;
      inResponse = true;
      hasContent = false;
      schemaRef = "";
      hasInlineProps = false;
      continue;
    }
    if (inResponse && CONTENT_RE.test(line)) {
      hasContent = true;
    }
    if (inResponse && hasContent) {
      const refMatch = SCHEMA_REF_RE.exec(line);
      if (refMatch) schemaRef = refMatch[1];
      if (SCHEMA_INLINE_PROPS_RE.test(line)) hasInlineProps = true;
    }
  }
  flush();

  if (problems.length === 0) {
    return {
      name: "API envelope on OpenAPI responses",
      passed: true,
      message: "All 2xx responses include envelope shape",
    };
  }
  return {
    name: "API envelope on OpenAPI responses",
    passed: false,
    message: `${problems.length} route(s) missing "success" in response schema`,
    detail: problems,
  };
}

// ─── Check 7: OpenAPI codegen in sync ────────────────────────────────────────
function snapshotDir(dir: string): Map<string, string> {
  const snap = new Map<string, string>();
  if (!fs.existsSync(dir)) return snap;
  for (const file of collectFiles(dir, [".ts", ".tsx", ".js"])) {
    snap.set(file, fs.readFileSync(file, "utf8"));
  }
  return snap;
}

function checkCodegenSync(): CheckResult {
  const specPath = path.join(ROOT, "lib", "api-spec", "openapi.yaml");
  if (!fs.existsSync(specPath)) {
    return {
      name: "OpenAPI codegen in sync",
      passed: true,
      skipped: true,
      message: "openapi.yaml not found — skipped",
    };
  }

  const genDirs = [
    path.join(ROOT, "lib", "api-client-react", "src", "generated"),
    path.join(ROOT, "lib", "api-zod", "src", "generated"),
  ].filter(fs.existsSync);

  if (genDirs.length === 0) {
    return {
      name: "OpenAPI codegen in sync",
      passed: true,
      skipped: true,
      message: "Generated directories not found — skipped (required after Task #1)",
    };
  }

  const before = new Map<string, string>();
  for (const dir of genDirs) {
    for (const [k, v] of snapshotDir(dir)) before.set(k, v);
  }

  const { ok, output } = run("pnpm --filter @workspace/api-spec run codegen");
  if (!ok) {
    return {
      name: "OpenAPI codegen in sync",
      passed: false,
      message: `Codegen command failed: ${output.slice(0, 200)}`,
    };
  }

  const dirty: string[] = [];
  for (const dir of genDirs) {
    for (const [file, content] of snapshotDir(dir)) {
      const prev = before.get(file);
      if (prev === undefined) {
        dirty.push(`NEW: ${path.relative(ROOT, file)}`);
      } else if (prev !== content) {
        dirty.push(`CHANGED: ${path.relative(ROOT, file)}`);
      }
    }
    for (const [file] of before) {
      if (file.startsWith(dir) && !fs.existsSync(file)) {
        dirty.push(`DELETED: ${path.relative(ROOT, file)}`);
      }
    }
  }

  if (dirty.length === 0) {
    return { name: "OpenAPI codegen in sync", passed: true, message: "Generated files are up to date" };
  }
  return {
    name: "OpenAPI codegen in sync",
    passed: false,
    message: `${dirty.length} generated file(s) out of sync — run codegen and commit`,
    detail: dirty,
  };
}

// ─── Check 8: No raw fetch() in service files without privacy log ─────────────
function checkPrivacyLog(): CheckResult {
  const serviceDir = path.join(ROOT, "artifacts", "api-server", "src", "services");
  if (!fs.existsSync(serviceDir)) {
    return {
      name: "No raw fetch() in services without privacy log",
      passed: true,
      skipped: true,
      message: "Service directory not found — skipped (required from Task #1 onwards)",
    };
  }

  const files = collectFiles(serviceDir, [".ts"]).filter((f) => !f.includes(".test."));
  const problems: string[] = [];
  const FETCH_RE = /\bfetch\s*\(|\baxios\s*[.(]/;
  const PRIVACY_RE = /privacyLog|privacy_events|logPrivacyEvent/;
  const CONTEXT = 10;

  for (const file of files) {
    const lines = readLines(file);
    lines.forEach((line, i) => {
      if (!FETCH_RE.test(line)) return;
      const start = Math.max(0, i - CONTEXT);
      const end = Math.min(lines.length - 1, i + CONTEXT);
      const window = lines.slice(start, end + 1).join("\n");
      if (!PRIVACY_RE.test(window)) {
        const rel = path.relative(ROOT, file);
        problems.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`);
      }
    });
  }

  if (problems.length === 0) {
    return {
      name: "No raw fetch() in services without privacy log",
      passed: true,
      message: "All outbound calls are accompanied by a privacy log",
    };
  }
  return {
    name: "No raw fetch() in services without privacy log",
    passed: false,
    message: `${problems.length} bare network call(s) missing privacy log`,
    detail: problems,
  };
}

// ─── Runner ───────────────────────────────────────────────────────────────────
async function main() {
  console.log();
  console.log(`${BOLD}Omninity Operator — Tier Review${RESET}`);
  console.log("=".repeat(48));
  console.log(`${DIM}Running checks from: ${ROOT}${RESET}`);
  console.log();

  const checks: Array<() => CheckResult> = [
    checkTypeScript,
    checkTests,
    checkConsoleLogs,
    checkHardcodedColours,
    checkDrizzleSchema,
    checkOpenApiEnvelope,
    checkCodegenSync,
    checkPrivacyLog,
  ];

  const results: CheckResult[] = [];
  for (const check of checks) {
    process.stdout.write(`  Checking: ${check.name}...`);
    try {
      const r = check();
      results.push(r);
      process.stdout.write(`\r  ${tick(r)} ${r.name.padEnd(46)} ${DIM}${r.message}${RESET}\n`);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const r: CheckResult = {
        name: check.name,
        passed: false,
        message: `Unexpected error: ${err}`,
      };
      results.push(r);
      process.stdout.write(`\r  ${tick(r)} ${r.name.padEnd(46)} ${DIM}${r.message}${RESET}\n`);
    }
  }

  console.log();

  const failed = results.filter((r) => !r.passed && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const passed = results.filter((r) => r.passed && !r.skipped);

  if (failed.length > 0) {
    console.log(`${BOLD}${RED}Failures:${RESET}`);
    for (const r of failed) {
      console.log(`\n  ${RED}✗ ${r.name}${RESET}`);
      console.log(`    ${r.message}`);
      if (r.detail && r.detail.length > 0) {
        for (const d of r.detail) {
          console.log(`    ${DIM}${d}${RESET}`);
        }
        if ((r.detail?.length ?? 0) >= 15) {
          console.log(`    ${DIM}... (truncated — see full output above)${RESET}`);
        }
      }
    }
    console.log();
  }

  if (skipped.length > 0) {
    console.log(`${YELLOW}Skipped (${skipped.length}):${RESET} ${skipped.map((r) => r.name).join(", ")}`);
    console.log();
  }

  if (failed.length === 0) {
    console.log(
      `${BOLD}${GREEN}Result: PASSED${RESET} — ${passed.length} check(s) passed${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}`,
    );
    console.log(`${GREEN}Safe to activate the next tier.${RESET}`);
    console.log();
    process.exit(0);
  } else {
    console.log(
      `${BOLD}${RED}Result: FAILED — ${failed.length} check(s) failed${RESET}`,
    );
    console.log(`${RED}Fix the above before activating the next tier.${RESET}`);
    console.log();
    process.exit(1);
  }
}

main();
