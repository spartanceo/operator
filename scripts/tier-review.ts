#!/usr/bin/env tsx
/**
 * Omninity Operator — Tier Review Script
 *
 * Runs all 8 automated quality gates after every tier merges.
 * Exit 0 = all checks pass (safe to activate next tier).
 * Exit 1 = one or more checks failed (fix before advancing).
 *
 * Usage: pnpm run tier-review
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(import.meta.dirname, "..");

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
  try {
    const output = execSync(cmd, { cwd, encoding: "utf8", shell: true, stdio: "pipe" });
    return { ok: true, output: String(output) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function collectFiles(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
      } else if (exts.some((e) => entry.name.endsWith(e))) {
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
// Always runs `pnpm test` — never skipped. The root test script uses
// `--if-present` so packages without tests are silently skipped by pnpm itself.
function checkTests(): CheckResult {
  const { ok, output } = run("pnpm test");
  if (ok) {
    return { name: "All tests passing", passed: true, message: "All tests pass" };
  }
  const failing = output
    .split("\n")
    .filter((l) => /FAIL|✕|× |Error/.test(l))
    .slice(0, 10);
  return {
    name: "All tests passing",
    passed: false,
    message: "Test failures detected — run `pnpm test` for details",
    detail: failing.length > 0 ? failing : [output.trim().slice(0, 200)],
  };
}

// ─── Check 3: No console.log in source files ─────────────────────────────────
// Scope: .ts AND .tsx under both artifacts/ and lib/ (excluding test/spec files)
function checkConsoleLogs(): CheckResult {
  const sourceFiles = [
    ...collectFiles(path.join(ROOT, "artifacts"), [".ts", ".tsx"]),
    ...collectFiles(path.join(ROOT, "lib"), [".ts", ".tsx"]),
  ].filter(
    (f) =>
      !f.includes(".test.") &&
      !f.includes(".spec.") &&
      !f.endsWith("tier-review.ts") &&
      !f.endsWith("hello.ts"),
  );

  const offenders: string[] = [];
  for (const file of sourceFiles) {
    const lines = readLines(file);
    lines.forEach((line, i) => {
      if (/console\.log\s*\(/.test(line)) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
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
// Scope: all .tsx files under artifacts/.
// Exempt: ONLY artifacts/frontend/src/design-tokens.ts (the single token file).
// All other files, including third-party templates, are in scope per the spec.
const DESIGN_TOKEN_EXEMPT_PATH = path.join(
  ROOT,
  "artifacts",
  "frontend",
  "src",
  "design-tokens.ts",
);

function checkHardcodedColours(): CheckResult {
  const componentFiles = collectFiles(path.join(ROOT, "artifacts"), [".tsx"]).filter(
    (f) => !f.includes("node_modules") && f !== DESIGN_TOKEN_EXEMPT_PATH,
  );

  const HEX_RE = /#([0-9a-fA-F]{3,8})\b/g;
  const offenders: string[] = [];

  for (const file of componentFiles) {
    const lines = readLines(file);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // Skip comment-only lines
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      HEX_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = HEX_RE.exec(line)) !== null) {
        offenders.push(
          `${path.relative(ROOT, file)}:${i + 1}  "${m[0]}"  ${trimmed.slice(0, 60)}`,
        );
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
// Tables whose names contain these keywords are exempt from the version requirement
const VERSION_EXEMPT_KEYWORDS = [
  "idempotency",
  "event",
  "log",
  "audit",
  "seed",
  "migration",
  "junction",
  "membership",
];

function checkDrizzleSchema(): CheckResult {
  const schemaFiles = [
    ...collectFiles(path.join(ROOT, "lib", "db"), [".ts"]),
    ...collectFiles(path.join(ROOT, "artifacts", "api-server"), [".ts"]),
  ].filter(
    (f) =>
      f.toLowerCase().includes("schema") &&
      !f.includes(".test.") &&
      !f.includes(".spec."),
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
    const rawSrc = fs.readFileSync(file, "utf8");
    // Strip comments before parsing to avoid matching commented-out example code.
    // 1. Remove block comments /* ... */
    // 2. Remove single-line comment lines (lines whose first non-whitespace is //)
    const src = rawSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");

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

      const needsVersion = !VERSION_EXEMPT_KEYWORDS.some((kw) =>
        tableName.toLowerCase().includes(kw),
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
// Validates each route+method+status contextually.
// For $ref responses: checks only the named component schema, not the whole file.
// For inline responses: checks that "success:" appears within the indented
//   properties block of that specific response, not anywhere in the file.
//
// Exported for unit testing with fixture YAML strings (see tier-review.check6.test.ts).
export function parseOpenApiEnvelopeProblems(src: string): string[] {
  const lines = src.split("\n");
  const problems: string[] = [];

  // Phase 1: Build a map of component schema names → whether they have "success"
  // A schema has "success" if `success:` appears as a direct property key
  // (i.e. indented under `properties:` within that schema's block).
  const schemaHasSuccess = new Map<string, boolean>();
  {
    let inComponents = false;
    let inSchemas = false;
    let currentSchema = "";
    let foundSuccess = false;
    let inPropertiesBlock = false;
    let propertiesIndent = -1;

    for (const line of lines) {
      if (!inComponents) {
        if (/^components:/.test(line)) inComponents = true;
        continue;
      }
      if (!inSchemas) {
        if (/^  schemas:/.test(line)) inSchemas = true;
        continue;
      }
      // A new top-level section ends schemas
      if (/^[a-zA-Z]/.test(line) && !line.startsWith(" ")) {
        if (currentSchema) schemaHasSuccess.set(currentSchema, foundSuccess);
        inComponents = false; inSchemas = false;
        continue;
      }
      // Schema name at 4-space indent
      const nameMatch = /^    (\w+):$/.exec(line);
      if (nameMatch) {
        if (currentSchema) schemaHasSuccess.set(currentSchema, foundSuccess);
        currentSchema = nameMatch[1];
        foundSuccess = false;
        inPropertiesBlock = false;
        propertiesIndent = -1;
        continue;
      }
      if (!currentSchema) continue;

      // Detect properties: block
      const propsMatch = /^(\s+)properties:/.exec(line);
      if (propsMatch) {
        inPropertiesBlock = true;
        propertiesIndent = propsMatch[1].length;
        continue;
      }

      if (inPropertiesBlock && propertiesIndent >= 0) {
        const trimmed = line.trimStart();
        if (trimmed.length === 0) continue;
        const indent = line.length - trimmed.length;
        // Property keys are exactly one level deeper than `properties:`
        if (indent === propertiesIndent + 2 && trimmed.startsWith("success:")) {
          foundSuccess = true;
        }
        // Left properties block if indent goes back to or past properties level
        if (indent <= propertiesIndent && trimmed.length > 0 && !trimmed.startsWith("properties:")) {
          inPropertiesBlock = false;
          propertiesIndent = -1;
        }
      }
    }
    if (currentSchema) schemaHasSuccess.set(currentSchema, foundSuccess);
  }

  // Phase 2: Walk paths and validate each 2xx response contextually
  {
    let currentPath = "";
    let currentMethod = "";
    let currentStatus = "";
    let inResponse = false;
    let hasContent = false;
    let schemaRef = "";
    let inPropsBlock = false;
    let propsIndent = -1;
    // sawInlineProperties is set true when we enter a properties block and stays
    // true until resetResponse() — so flushResponse() can detect inline schemas
    // even after the parser has left the block.
    let sawInlineProperties = false;
    let inlineHasSuccess = false;

    function flushResponse() {
      if (!inResponse || !hasContent) return;
      const label = `${currentMethod.toUpperCase()} ${currentPath} "${currentStatus}":`;
      if (schemaRef) {
        const has = schemaHasSuccess.get(schemaRef);
        if (has === false) {
          problems.push(`${label} — $ref schema "${schemaRef}" lacks "success" property`);
        } else if (has === undefined) {
          problems.push(`${label} — $ref schema "${schemaRef}" not found in components`);
        }
      } else if (sawInlineProperties) {
        // Use sawInlineProperties (not inPropsBlock) so we validate inline schemas
        // even when flushResponse is called after the parser has exited the block.
        if (!inlineHasSuccess) {
          problems.push(`${label} — inline schema properties lacks "success" field`);
        }
      }
      // Reset so a repeated flush call doesn't double-report the same response
      resetResponse();
    }

    function resetResponse() {
      inResponse = false;
      hasContent = false;
      schemaRef = "";
      inPropsBlock = false;
      propsIndent = -1;
      sawInlineProperties = false;
      inlineHasSuccess = false;
    }

    for (const line of lines) {
      // Stop processing paths once we hit components
      if (/^components:/.test(line)) {
        flushResponse();
        break;
      }

      const pathMatch = /^  (\/[^\s:]+):$/.exec(line);
      if (pathMatch) {
        flushResponse();
        currentPath = pathMatch[1];
        resetResponse();
        continue;
      }

      const methodMatch = /^    (get|post|put|patch|delete|head|options):$/i.exec(line);
      if (methodMatch) {
        flushResponse();
        currentMethod = methodMatch[1];
        resetResponse();
        continue;
      }

      const statusMatch = /^        (["']?)(2\d{2})\1:/.exec(line);
      if (statusMatch) {
        flushResponse();
        currentStatus = statusMatch[2];
        inResponse = true;
        hasContent = false;
        schemaRef = "";
        inPropsBlock = false;
        propsIndent = -1;
        inlineHasSuccess = false;
        continue;
      }

      if (!inResponse) continue;

      if (/^          content:/.test(line)) {
        hasContent = true;
        continue;
      }

      if (!hasContent) continue;

      // Detect $ref
      const refMatch = /\$ref:\s*["']#\/components\/schemas\/(\w+)["']/.exec(line);
      if (refMatch && !schemaRef) {
        schemaRef = refMatch[1];
      }

      // Detect inline properties block — note its indentation
      const propsMatch = /^(\s+)properties:/.exec(line);
      if (propsMatch && propsIndent === -1) {
        propsIndent = propsMatch[1].length;
        inPropsBlock = true;
        sawInlineProperties = true; // persists until resetResponse(), survives block exit
        continue;
      }

      // Track "success:" appearing as a direct property within the block
      if (inPropsBlock && propsIndent >= 0) {
        const trimmed = line.trimStart();
        if (trimmed.length === 0) continue;
        const indent = line.length - trimmed.length;
        // Property keys sit one level deeper than `properties:`
        if (indent === propsIndent + 2 && trimmed.startsWith("success:")) {
          inlineHasSuccess = true;
        }
        // Left the properties block
        if (indent <= propsIndent && !trimmed.startsWith("properties:")) {
          inPropsBlock = false;
          propsIndent = -1;
        }
      }
    }
    flushResponse();
  }

  return problems;
}

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
  const problems = parseOpenApiEnvelopeProblems(src);

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

// ─── Check 9: Performance budget compliance (vitest bench + @budget) ─────────
//
// Discovers every *.bench.ts under artifacts/ and lib/. For each, parses the
// `/** @budget <ms>[ms] [p95|mean] */` annotation directly above each
// `bench("name", ...)` call. Runs `pnpm run bench` and parses the JSON output
// from vitest's bench reporter to extract measured durations. Fails the check
// for any benchmark whose mean (or p95 when declared) exceeds its budget.
//
// Skips gracefully when:
//  - No *.bench.ts files exist (Tier 0 — no benchmarks yet)
//  - The root `bench` script is missing (shouldn't happen but defensive)

export interface BenchBudget {
  file: string;       // path relative to ROOT
  benchName: string;  // the string passed to bench("...", fn)
  budgetMs: number;   // the @budget value in milliseconds
  metric: "mean" | "p95"; // which metric to enforce against
  line: number;       // 1-indexed line of the bench() call
}

/**
 * Parse `@budget` annotations from a single bench file's source.
 *
 * The annotation must be a JSDoc-style comment directly above (no blank line
 * separator) a `bench("name", ...)` call. Format:
 *   /** @budget 50ms p95 *​/
 *   bench("doing the thing", async () => { ... });
 *
 * Defaults: metric is `mean` when unspecified. Unit is always milliseconds —
 * `50ms` and `50` parse identically. `p95` is the only alternative metric for
 * v1; bare `mean` is also accepted.
 *
 * Exported for fixture testing.
 */
export function parseBudgetAnnotations(src: string, file = "<test>"): BenchBudget[] {
  const lines = src.split("\n");
  const results: BenchBudget[] = [];

  // Match a JSDoc comment containing @budget — supports single-line and
  // multi-line /** ... */ forms. We look for the comment END line, then
  // expect the next non-empty line to be the bench() call.
  // The `\s*ms` is grouped together so the whitespace is only consumed when
  // `ms` actually matches — otherwise the space stays available for the
  // subsequent `\s+(p95|mean)` separator.
  const BUDGET_RE = /@budget\s+(\d+(?:\.\d+)?)(?:\s*ms)?(?:\s+(p95|mean))?/i;
  const BENCH_RE = /\bbench\s*\(\s*["'`]([^"'`]+)["'`]/;

  for (let i = 0; i < lines.length; i++) {
    const m = BUDGET_RE.exec(lines[i]);
    if (!m) continue;

    // Find the end of this JSDoc comment block (the line containing `*/`).
    // Single-line case: the same line ends with `*/`.
    let endIdx = i;
    if (!/\*\//.test(lines[i])) {
      while (endIdx < lines.length - 1 && !/\*\//.test(lines[endIdx])) endIdx++;
    }

    // Walk forward to the first non-blank, non-comment line — that must be
    // the bench() call. If it isn't, the annotation is orphaned and ignored.
    let j = endIdx + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t === "" || t.startsWith("//") || t.startsWith("*")) {
        j++;
        continue;
      }
      break;
    }
    if (j >= lines.length) continue;

    const bm = BENCH_RE.exec(lines[j]);
    if (!bm) continue;

    results.push({
      file,
      benchName: bm[1],
      budgetMs: parseFloat(m[1]),
      metric: (m[2]?.toLowerCase() as "p95" | "mean") || "mean",
      line: j + 1,
    });

    // Skip past this match so a single budget can't double-count
    i = j;
  }

  return results;
}

interface BenchResult {
  name: string;
  meanMs: number;
  p95Ms?: number;
}

/**
 * Parse the JSON output of `vitest bench --reporter=json`.
 *
 * Vitest's JSON bench reporter emits a tree-shaped result. We walk it
 * recursively and collect every leaf with a `result.benchmark` field, which
 * is where vitest stores the measured stats. Times are normalised to ms.
 *
 * The reporter format has changed across vitest versions; this parser is
 * defensive and accepts either `{ testResults: [...] }` (newer) or
 * `{ files: [{ tasks: [...] }] }` (older) shapes.
 *
 * Exported for fixture testing.
 */
export function parseVitestBenchOutput(jsonText: string): BenchResult[] {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const results: BenchResult[] = [];

  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    // Vitest stores bench stats on `result.benchmark` for bench tasks.
    const result = obj.result as Record<string, unknown> | undefined;
    const benchmark = result?.benchmark as Record<string, unknown> | undefined;
    if (benchmark && typeof obj.name === "string") {
      // benchmark.mean is in milliseconds in vitest's output
      const meanRaw = benchmark.mean;
      const p95Raw = (benchmark.p95 ?? benchmark.percentile95) as number | undefined;
      if (typeof meanRaw === "number") {
        results.push({
          name: obj.name,
          meanMs: meanRaw,
          p95Ms: typeof p95Raw === "number" ? p95Raw : undefined,
        });
      }
    }

    // Recurse into common child arrays
    for (const key of ["testResults", "files", "tasks", "suites", "children"]) {
      const child = obj[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c);
      }
    }
  }

  visit(data);
  return results;
}

/**
 * Walk upwards from a file path to find the nearest package.json — this is
 * the package root the file belongs to. Returns null if no package.json is
 * found before reaching the workspace root (which would indicate a misplaced
 * file outside any package).
 *
 * Exported for fixture testing.
 */
export function findPackageRoot(filePath: string, root = ROOT): string | null {
  let dir = path.dirname(filePath);
  while (dir.startsWith(root) && dir !== root) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  // Allow the workspace root to be a package itself
  if (dir === root && fs.existsSync(path.join(root, "package.json"))) return root;
  return null;
}

// File each package's `bench` script must write its vitest JSON output to.
// The convention is documented in scripts/README.md and used by Check #9 to
// avoid parsing pnpm's mixed stdout (which prefixes lines with package names
// and would break a naive JSON.parse).
const BENCH_RESULTS_FILENAME = ".bench-results.json";

function checkPerformanceBudgets(): CheckResult {
  const benchFiles = [
    ...collectFiles(path.join(ROOT, "artifacts"), [".bench.ts"]),
    ...collectFiles(path.join(ROOT, "lib"), [".bench.ts"]),
  ];

  if (benchFiles.length === 0) {
    return {
      name: "Performance budget compliance",
      passed: true,
      skipped: true,
      message: "No *.bench.ts files found — skipped (active once first benchmark ships)",
    };
  }

  // Parse @budget annotations and group budgets by their owning package
  const budgetsByPackage = new Map<string, BenchBudget[]>();
  const orphanedBenchFiles: string[] = [];
  for (const file of benchFiles) {
    const pkgRoot = findPackageRoot(file);
    if (!pkgRoot) {
      orphanedBenchFiles.push(`${path.relative(ROOT, file)}: not inside any package`);
      continue;
    }
    const src = fs.readFileSync(file, "utf8");
    const budgets = parseBudgetAnnotations(src, path.relative(ROOT, file));
    if (!budgetsByPackage.has(pkgRoot)) budgetsByPackage.set(pkgRoot, []);
    budgetsByPackage.get(pkgRoot)!.push(...budgets);
  }

  const allBudgets = Array.from(budgetsByPackage.values()).flat();
  if (allBudgets.length === 0) {
    const detail = [
      ...benchFiles.map((f) => `${path.relative(ROOT, f)}: missing /** @budget Nms */ annotation`),
      ...orphanedBenchFiles,
    ];
    return {
      name: "Performance budget compliance",
      passed: false,
      message: `${benchFiles.length} bench file(s) found but no @budget annotations parsed`,
      detail,
    };
  }

  // For each package: clean up any stale results file, run that package's
  // local `bench` script, then read the JSON it wrote. Per-package isolation
  // is what makes parsing reliable — each package writes a clean, complete
  // JSON document to a known location, with no interleaved pnpm log noise.
  // Results are keyed by `<packageRoot>::<benchName>` so duplicate bench names
  // across packages cannot collide.
  const measured = new Map<string, BenchResult>();
  const runProblems: string[] = [];

  for (const pkgRoot of budgetsByPackage.keys()) {
    const pkgBudgets = budgetsByPackage.get(pkgRoot)!;
    const resultsFile = path.join(pkgRoot, BENCH_RESULTS_FILENAME);
    if (fs.existsSync(resultsFile)) {
      try {
        fs.unlinkSync(resultsFile);
      } catch {
        // best-effort — if cleanup fails the freshness check below catches it
      }
    }

    const pkgRel = path.relative(ROOT, pkgRoot);
    const { ok, output } = run("pnpm run bench", pkgRoot);

    if (!fs.existsSync(resultsFile)) {
      runProblems.push(
        `${pkgRel}: bench script did not write ${BENCH_RESULTS_FILENAME} — script must include "--outputFile=./${BENCH_RESULTS_FILENAME}"`,
      );
      if (!ok) {
        runProblems.push(`${pkgRel}: bench command failed: ${output.split("\n").slice(-3).join(" | ").slice(0, 200)}`);
      }
      continue;
    }

    let json: string;
    try {
      json = fs.readFileSync(resultsFile, "utf8");
    } catch (e) {
      runProblems.push(`${pkgRel}: could not read ${BENCH_RESULTS_FILENAME}: ${(e as Error).message}`);
      continue;
    }

    const pkgResults = parseVitestBenchOutput(json);
    if (pkgResults.length === 0) {
      runProblems.push(
        `${pkgRel}: ${BENCH_RESULTS_FILENAME} parsed but contained no benchmark results (${pkgBudgets.length} budget(s) declared)`,
      );
      continue;
    }
    for (const r of pkgResults) {
      measured.set(`${pkgRoot}::${r.name}`, r);
    }
  }

  const problems: string[] = [...runProblems, ...orphanedBenchFiles];
  for (const b of allBudgets) {
    // The budget's owning package is the same one we ran benches for above —
    // re-derive it from the budget's file path so the lookup key matches.
    const absBenchFile = path.join(ROOT, b.file);
    const pkgRoot = findPackageRoot(absBenchFile);
    if (!pkgRoot) continue;
    const m = measured.get(`${pkgRoot}::${b.benchName}`);
    if (!m) {
      problems.push(`${b.file}:${b.line}  bench "${b.benchName}" — no measurement found in ${path.relative(ROOT, pkgRoot)}/${BENCH_RESULTS_FILENAME}`);
      continue;
    }
    const actual = b.metric === "p95" && m.p95Ms !== undefined ? m.p95Ms : m.meanMs;
    if (actual > b.budgetMs) {
      problems.push(
        `${b.file}:${b.line}  "${b.benchName}" — ${actual.toFixed(1)}ms (${b.metric}) exceeds budget of ${b.budgetMs}ms`,
      );
    }
  }

  if (problems.length === 0) {
    return {
      name: "Performance budget compliance",
      passed: true,
      message: `${allBudgets.length} budget(s) checked across ${budgetsByPackage.size} package(s) — all within target`,
    };
  }
  return {
    name: "Performance budget compliance",
    passed: false,
    message: `${problems.length} performance budget issue(s)`,
    detail: problems.slice(0, 15),
  };
}

// ─── Check 10: Frontend bundle size budget ───────────────────────────────────
//
// For every artifact under artifacts/ that ships a `bundle-budget.json` at its
// root, build the artifact in production mode and verify the gzipped main JS
// chunk is at or below the declared `main_js_gzip_kb`. Skips gracefully when
// no `bundle-budget.json` files exist anywhere.
//
// Schema (bundle-budget.json):
// {
//   "main_js_gzip_kb": 500,        // required — the enforced limit
//   "total_js_gzip_kb": 1500,      // optional — informational only for now
//   "css_gzip_kb": 100,            // optional — informational only for now
//   "build_command": "pnpm build", // optional override (default: pnpm build)
//   "dist_dir": "dist"             // optional override (default: dist)
// }

interface BundleBudget {
  main_js_gzip_kb: number;
  total_js_gzip_kb?: number;
  css_gzip_kb?: number;
  build_command?: string;
  dist_dir?: string;
}

function gzipSizeKb(filePath: string): number {
  // Use the system `gzip` binary so we don't add a node dependency. -c writes
  // to stdout; we capture it and measure the byte length, then convert to KB.
  const { ok, output } = run(`gzip -c "${filePath}" | wc -c`);
  if (!ok) return -1;
  const bytes = parseInt(output.trim(), 10);
  if (!Number.isFinite(bytes)) return -1;
  return bytes / 1024;
}

function checkBundleSize(): CheckResult {
  const artifactsDir = path.join(ROOT, "artifacts");
  if (!fs.existsSync(artifactsDir)) {
    return {
      name: "Frontend bundle size budget",
      passed: true,
      skipped: true,
      message: "No artifacts/ directory — skipped",
    };
  }

  const artifactRoots = fs
    .readdirSync(artifactsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(artifactsDir, d.name));

  const budgeted = artifactRoots
    .map((root) => ({ root, budgetPath: path.join(root, "bundle-budget.json") }))
    .filter((x) => fs.existsSync(x.budgetPath));

  if (budgeted.length === 0) {
    return {
      name: "Frontend bundle size budget",
      passed: true,
      skipped: true,
      message: "No bundle-budget.json found in any artifact — skipped (added by Task #2)",
    };
  }

  const problems: string[] = [];
  const passes: string[] = [];

  for (const { root, budgetPath } of budgeted) {
    const rel = path.relative(ROOT, root);
    let budget: BundleBudget;
    try {
      budget = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
    } catch (e) {
      problems.push(`${rel}/bundle-budget.json — invalid JSON: ${(e as Error).message}`);
      continue;
    }
    if (typeof budget.main_js_gzip_kb !== "number") {
      problems.push(`${rel}/bundle-budget.json — missing required numeric field "main_js_gzip_kb"`);
      continue;
    }

    const buildCmd = budget.build_command ?? "pnpm build";
    const distDir = path.join(root, budget.dist_dir ?? "dist");

    const build = run(buildCmd, root);
    if (!build.ok) {
      problems.push(`${rel} — build failed: ${build.output.split("\n").slice(-3).join(" | ").slice(0, 200)}`);
      continue;
    }
    if (!fs.existsSync(distDir)) {
      problems.push(`${rel} — dist directory "${path.relative(ROOT, distDir)}" not found after build`);
      continue;
    }

    // Find the main JS chunk. Vite emits files like `assets/index-<hash>.js`;
    // we pick the largest top-level .js under assets/ as a proxy for "main".
    const assetsDir = path.join(distDir, "assets");
    const jsCandidates = fs.existsSync(assetsDir)
      ? collectFiles(assetsDir, [".js"]).filter((f) => !/\.map$/.test(f))
      : collectFiles(distDir, [".js"]).filter((f) => !/\.map$/.test(f));

    if (jsCandidates.length === 0) {
      problems.push(`${rel} — no .js files found under ${path.relative(ROOT, distDir)}`);
      continue;
    }

    let mainFile = jsCandidates[0];
    let mainSize = fs.statSync(mainFile).size;
    for (const f of jsCandidates) {
      const s = fs.statSync(f).size;
      if (s > mainSize) {
        mainSize = s;
        mainFile = f;
      }
    }

    const sizeKb = gzipSizeKb(mainFile);
    if (sizeKb < 0) {
      problems.push(`${rel} — failed to measure gzip size of ${path.relative(ROOT, mainFile)}`);
      continue;
    }

    if (sizeKb > budget.main_js_gzip_kb) {
      problems.push(
        `${rel} — main JS ${path.relative(root, mainFile)} is ${sizeKb.toFixed(1)} KB gzipped, exceeds budget of ${budget.main_js_gzip_kb} KB`,
      );
    } else {
      passes.push(`${rel}: ${sizeKb.toFixed(1)} KB / ${budget.main_js_gzip_kb} KB`);
    }
  }

  if (problems.length === 0) {
    return {
      name: "Frontend bundle size budget",
      passed: true,
      message: `${budgeted.length} artifact(s) within budget — ${passes.join(", ")}`,
    };
  }
  return {
    name: "Frontend bundle size budget",
    passed: false,
    message: `${problems.length} bundle budget violation(s)`,
    detail: problems,
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
        problems.push(
          `${path.relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 80)}`,
        );
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
    checkPerformanceBudgets,
    checkBundleSize,
  ];

  const results: CheckResult[] = [];
  for (const check of checks) {
    process.stdout.write(`  Checking ${check.name}...\r`);
    try {
      const r = check();
      results.push(r);
      process.stdout.write(
        `  ${tick(r)} ${r.name.padEnd(46)} ${DIM}${r.message}${RESET}\n`,
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const r: CheckResult = {
        name: check.name,
        passed: false,
        message: `Unexpected error: ${err}`,
      };
      results.push(r);
      process.stdout.write(
        `  ${tick(r)} ${r.name.padEnd(46)} ${DIM}${r.message}${RESET}\n`,
      );
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
        if (r.detail.length >= 15) {
          console.log(`    ${DIM}... (truncated — see full output above)${RESET}`);
        }
      }
    }
    console.log();
  }

  if (skipped.length > 0) {
    console.log(
      `${YELLOW}Skipped (${skipped.length}):${RESET} ${skipped.map((r) => r.name).join(", ")}`,
    );
    console.log();
  }

  if (failed.length === 0) {
    console.log(
      `${BOLD}${GREEN}Result: PASSED${RESET} — ${passed.length} check(s) passed` +
        (skipped.length > 0 ? `, ${skipped.length} skipped` : ""),
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

// Only auto-execute when this file is the direct entry point, not when imported
const _isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("tier-review.ts");
if (_isMain) {
  main();
}
