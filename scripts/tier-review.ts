#!/usr/bin/env tsx
/**
 * Omninity Operator — Tier Review Script
 *
 * Runs all 18 automated quality gates after every tier merges.
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
  "interaction",
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

// ─── Check 11: No dangerous code execution primitives ────────────────────────
//
// Standard 12 forbids `eval(`, `new Function(`, and `vm.runInNewContext(` in
// the codebase. The single exception is the canonical skill sandbox file,
// which is the only module allowed to call `vm.runInNewContext` /
// `vm.createContext`. Test/spec files and the tier-review script itself are
// excluded so the checker's own pattern strings don't trigger it.
//
// Documented heuristic limits (intentional gaps caught only by the
// architect/security_scan review, not by this fast gate):
//  - `globalThis.eval(...)` / `window["eval"](...)` / aliased indirect calls
//    are not detected — only the bare `eval(` form is matched
//  - `Function.prototype.constructor(...)` and `setTimeout("...", n)` with a
//    string body are not flagged here
//  - `vm.createContext(...)` is the policy-allowed sandbox primitive used by
//    the canonical sandbox file; we deliberately do NOT flag it because that
//    would catch the legitimate use site
//
// Exported for fixture testing.

const SKILL_SANDBOX_ALLOWLIST = path.join(
  ROOT,
  "artifacts",
  "api-server",
  "src",
  "skill-runtime",
  "sandbox.ts",
);

export interface DangerousExecMatch {
  file: string;
  line: number;
  pattern: "eval" | "new Function" | "vm.runInNewContext";
  snippet: string;
}

/**
 * Scan a single source file's contents for forbidden code execution
 * primitives. The sandbox file is allowlisted for `vm.runInNewContext` only;
 * `eval` and `new Function` are forbidden everywhere.
 *
 * `(?<![.\w])eval` ensures we only flag the bare `eval(` call, never
 * `someObj.eval(` or `myEval(` which are unrelated identifiers. Comment-only
 * lines are skipped so docstrings explaining what is forbidden don't trigger.
 */
export function findDangerousExec(
  src: string,
  file: string,
  isSandboxFile: boolean,
): DangerousExecMatch[] {
  const lines = src.split("\n");
  const out: DangerousExecMatch[] = [];

  const EVAL_RE = /(?<![.\w])eval\s*\(/;
  const NEW_FUNC_RE = /\bnew\s+Function\s*\(/;
  const VM_RUN_RE = /\bvm\s*\.\s*runInNewContext\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Skip pure-comment lines so example/forbidden-pattern docs don't trigger
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    if (EVAL_RE.test(line)) {
      out.push({ file, line: i + 1, pattern: "eval", snippet: trimmed.slice(0, 80) });
    }
    if (NEW_FUNC_RE.test(line)) {
      out.push({
        file,
        line: i + 1,
        pattern: "new Function",
        snippet: trimmed.slice(0, 80),
      });
    }
    if (VM_RUN_RE.test(line) && !isSandboxFile) {
      out.push({
        file,
        line: i + 1,
        pattern: "vm.runInNewContext",
        snippet: trimmed.slice(0, 80),
      });
    }
  }

  return out;
}

function checkDangerousExec(): CheckResult {
  const dirs = [path.join(ROOT, "artifacts"), path.join(ROOT, "lib")].filter(fs.existsSync);
  if (dirs.length === 0) {
    return {
      name: "No dangerous code execution primitives",
      passed: true,
      skipped: true,
      message: "Neither artifacts/ nor lib/ exists — skipped",
    };
  }

  const files = dirs
    .flatMap((d) => collectFiles(d, [".ts", ".tsx"]))
    .filter(
      (f) =>
        !f.includes(".test.") &&
        !f.includes(".spec.") &&
        !f.endsWith("tier-review.ts"),
    );

  const problems: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const matches = findDangerousExec(src, path.relative(ROOT, file), file === SKILL_SANDBOX_ALLOWLIST);
    for (const m of matches) {
      problems.push(`${m.file}:${m.line}  ${m.pattern}  ${m.snippet}`);
    }
  }

  if (problems.length === 0) {
    return {
      name: "No dangerous code execution primitives",
      passed: true,
      message: `${files.length} file(s) scanned — no eval / new Function / vm.runInNewContext outside sandbox`,
    };
  }
  return {
    name: "No dangerous code execution primitives",
    passed: false,
    message: `${problems.length} forbidden code execution call(s) — see Standard 12`,
    detail: problems.slice(0, 15),
  };
}

// ─── Check 12: No unsanitised dangerouslySetInnerHTML ─────────────────────────
//
// Tightened heuristic: when a `dangerouslySetInnerHTML` occurrence is found,
// extract the JSX prop expression value (the `{{ __html: ... }}` block — even
// if it spans multiple lines) and require `DOMPurify.sanitize` to appear
// inside that expression. The single allowed escape hatch is binding the
// expression to a local variable on the same or immediately preceding line —
// then we look back up to 3 lines for that variable's `DOMPurify.sanitize`
// declaration. This eliminates the prior "unrelated sanitize call nearby"
// false negative the architect flagged.
//
// Bracket-matched extraction handles nested `{...}` correctly. The architect
// review and code review skill remain the deeper semantic check; this gate
// is a fast structural enforcement.
//
// Exported for fixture testing.

export function findUnsafeHtml(src: string, file: string): string[] {
  const lines = src.split("\n");
  const out: string[] = [];
  const HTML_RE = /dangerouslySetInnerHTML/;
  const SANITIZE_RE = /DOMPurify\s*\.\s*sanitize\s*\(/;
  const HTML_PROP_RE = /dangerouslySetInnerHTML\s*=\s*\{/;
  const HTML_VAR_RE = /__html\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Skip pure-comment lines so docstrings about the forbidden pattern don't trigger
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (!HTML_RE.test(line)) continue;

    // Find the start of the prop value `dangerouslySetInnerHTML={` and walk
    // forward across lines tracking nested `{` / `}` to extract the full prop
    // expression. If we can't find an opening `{`, fall back to scanning the
    // single line — but mark it unsafe by default so we don't silently pass.
    const propMatch = HTML_PROP_RE.exec(line);
    let exprText = "";
    if (propMatch) {
      const startCol = propMatch.index + propMatch[0].length - 1; // index of the opening `{`
      let depth = 0;
      let lineIdx = i;
      let colIdx = startCol;
      let captured = "";
      let done = false;
      while (lineIdx < lines.length && !done) {
        const cur = lines[lineIdx];
        for (let c = colIdx; c < cur.length; c++) {
          const ch = cur[c];
          captured += ch;
          if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) {
              done = true;
              break;
            }
          }
        }
        captured += "\n";
        lineIdx++;
        colIdx = 0;
        // Hard cap to keep the parser bounded on malformed input
        if (lineIdx - i > 50) break;
      }
      exprText = captured;
    } else {
      exprText = line;
    }

    // Pass if sanitize appears inside the prop expression itself
    if (SANITIZE_RE.test(exprText)) continue;

    // Otherwise: allow the local-variable escape hatch. If the prop's
    // `__html` value is a bare identifier (e.g. `__html: safeHtml`), look
    // back up to 3 non-blank lines for that identifier being assigned from
    // `DOMPurify.sanitize(...)`. Anything else fails.
    const varMatch = HTML_VAR_RE.exec(exprText);
    let safe = false;
    if (varMatch) {
      const varName = varMatch[1];
      const ASSIGN_RE = new RegExp(
        `\\b${varName}\\s*=\\s*[^;\\n]*DOMPurify\\s*\\.\\s*sanitize\\s*\\(`,
      );
      const start = Math.max(0, i - 3);
      const lookback = lines.slice(start, i + 1).join("\n");
      if (ASSIGN_RE.test(lookback)) safe = true;
    }
    if (safe) continue;

    out.push(`${file}:${i + 1}  ${trimmed.slice(0, 80)}`);
  }
  return out;
}

function checkUnsafeHtml(): CheckResult {
  const artifactsDir = path.join(ROOT, "artifacts");
  if (!fs.existsSync(artifactsDir)) {
    return {
      name: "No unsanitised dangerouslySetInnerHTML",
      passed: true,
      skipped: true,
      message: "No artifacts/ directory — skipped",
    };
  }
  const files = collectFiles(artifactsDir, [".tsx"]).filter(
    (f) => !f.includes(".test.") && !f.includes(".spec."),
  );
  if (files.length === 0) {
    return {
      name: "No unsanitised dangerouslySetInnerHTML",
      passed: true,
      skipped: true,
      message: "No .tsx files under artifacts/ — skipped",
    };
  }

  const problems: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    problems.push(...findUnsafeHtml(src, path.relative(ROOT, file)));
  }

  if (problems.length === 0) {
    return {
      name: "No unsanitised dangerouslySetInnerHTML",
      passed: true,
      message: `${files.length} .tsx file(s) scanned — clean`,
    };
  }
  return {
    name: "No unsanitised dangerouslySetInnerHTML",
    passed: false,
    message: `${problems.length} dangerouslySetInnerHTML use(s) without DOMPurify.sanitize`,
    detail: problems.slice(0, 15),
  };
}

// ─── Check 13: Dependency audit (high/critical) ──────────────────────────────
//
// Runs `pnpm audit --json` at the workspace root, parses the result, and
// fails on any high/critical advisory. Moderate is reported as a non-blocking
// warning. The check skips with `~` when the registry is unreachable (typical
// in offline development environments) so local work isn't blocked.
//
// pnpm exits non-zero when vulnerabilities exist, so we intentionally do NOT
// treat `ok: false` as a failure — we always parse the JSON output and decide
// from the parsed counts.
//
// Exported for fixture testing.

export interface AuditSummary {
  high: number;
  critical: number;
  moderate: number;
  low: number;
  info: number;
  advisoryTitles: string[]; // titles of high/critical advisories, for reporting
}

export function parseAuditOutput(jsonText: string): AuditSummary | null {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  // pnpm audit --json shape: { advisories: { [id]: {...} }, metadata: { vulnerabilities: { ... } } }
  const meta = obj.metadata as Record<string, unknown> | undefined;
  const vulns = (meta?.vulnerabilities ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);

  const summary: AuditSummary = {
    info: num(vulns.info),
    low: num(vulns.low),
    moderate: num(vulns.moderate),
    high: num(vulns.high),
    critical: num(vulns.critical),
    advisoryTitles: [],
  };

  const advisories = obj.advisories as Record<string, unknown> | undefined;
  if (advisories && typeof advisories === "object") {
    for (const a of Object.values(advisories)) {
      if (!a || typeof a !== "object") continue;
      const ao = a as Record<string, unknown>;
      const sev = String(ao.severity ?? "");
      if (sev === "high" || sev === "critical") {
        const title = String(ao.title ?? "(no title)");
        const moduleName = String(ao.module_name ?? ao.moduleName ?? "?");
        summary.advisoryTitles.push(`${sev}: ${moduleName} — ${title}`);
      }
    }
  }

  return summary;
}

function checkDependencyAudit(): CheckResult {
  const { output } = run("pnpm audit --json --prod");

  // Heuristic: if the output looks like a network failure (no JSON at all),
  // skip rather than fail so offline development isn't blocked.
  const trimmed = output.trim();
  const looksLikeJson = trimmed.startsWith("{");
  if (!looksLikeJson) {
    const networkHints = /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|registry|getaddrinfo|network/i;
    if (networkHints.test(output)) {
      return {
        name: "Dependency audit clean of high/critical",
        passed: true,
        skipped: true,
        message: "pnpm audit could not reach the registry — skipped (offline)",
      };
    }
    return {
      name: "Dependency audit clean of high/critical",
      passed: false,
      message: `pnpm audit produced no JSON output: ${output.slice(0, 200)}`,
    };
  }

  const summary = parseAuditOutput(output);
  if (!summary) {
    return {
      name: "Dependency audit clean of high/critical",
      passed: false,
      message: `Could not parse pnpm audit JSON output (length ${output.length})`,
    };
  }

  const blocking = summary.high + summary.critical;
  const moderateNote =
    summary.moderate > 0
      ? ` (${summary.moderate} moderate — review recommended)`
      : "";

  if (blocking === 0) {
    return {
      name: "Dependency audit clean of high/critical",
      passed: true,
      message: `0 high, 0 critical${moderateNote}`,
    };
  }
  return {
    name: "Dependency audit clean of high/critical",
    passed: false,
    message: `${summary.critical} critical, ${summary.high} high${moderateNote} — run \`pnpm audit\``,
    detail: summary.advisoryTitles.slice(0, 15),
  };
}

// ─── Check 14: No raw SQL string interpolation ───────────────────────────────
//
// Drizzle's typed query builder (`db.select().from(t)`) and tagged-template
// `sql\`...\`` are the only two safe ways to construct SQL. Any call to
// `db.exec`, `db.run`, `db.all`, `db.get`, or `db.prepare` whose argument
// list contains a raw template literal with `${...}` (without the `sql` tag)
// or a string concatenated with `+` is forbidden.
//
// The detector handles both single-line and multi-line call shapes by
// matching the call opener (`<ident>.<method>(`) and then capturing up to the
// matching closing paren across at most 8 lines. This catches the common
// forms the architect flagged:
//   db.run(
//     `UPDATE x SET y = ${y}`,
//   );
//
// The detector skips:
//  - The chained typed-builder forms (no risky tokens in the captured args)
//  - Drizzle's `sql\`...\`` tag (the only backtick is preceded by `sql`)
//  - Single-quote / double-quote string LITERALS that contain placeholder
//    syntax — only `+`-concatenation is risky for plain quoted strings
//
// Exported for fixture testing.

export interface RawSqlMatch {
  file: string;
  line: number;
  reason: "template literal" | "string concatenation";
  snippet: string;
}

const SQL_CALL_OPEN_RE = /\b\w+\s*\.\s*(exec|run|all|get|prepare)\s*\(/g;
const MAX_CALL_LINES = 8;

/**
 * Capture text inside a method call's parens, starting from the position of
 * the opening paren in `lines[startLine][startCol]`. Returns the captured
 * text (without the outer parens) plus the line offset where the matching
 * `)` was found, or null if no closing paren is found within the window.
 */
function captureCallArgs(
  lines: string[],
  startLine: number,
  startCol: number,
  maxLines = MAX_CALL_LINES,
): { text: string; endLine: number } | null {
  let depth = 0;
  let captured = "";
  let started = false;
  let lineIdx = startLine;
  let colIdx = startCol;

  while (lineIdx < lines.length && lineIdx - startLine < maxLines) {
    const cur = lines[lineIdx];
    for (let c = colIdx; c < cur.length; c++) {
      const ch = cur[c];
      if (ch === "(") {
        depth++;
        if (depth === 1) {
          started = true;
          continue; // don't capture the outer `(`
        }
      } else if (ch === ")") {
        depth--;
        if (depth === 0 && started) {
          return { text: captured, endLine: lineIdx };
        }
      }
      if (started) captured += ch;
    }
    captured += "\n";
    lineIdx++;
    colIdx = 0;
  }
  return null;
}

export function findRawSqlInterpolation(src: string, file = "<test>"): RawSqlMatch[] {
  const lines = src.split("\n");
  const out: RawSqlMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    SQL_CALL_OPEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SQL_CALL_OPEN_RE.exec(line)) !== null) {
      const method = m[1];
      // Position of the `(` is at m.index + m[0].length - 1
      const openCol = m.index + m[0].length - 1;
      const captured = captureCallArgs(lines, i, openCol);
      if (!captured) continue;
      const args = captured.text;

      // Strip Drizzle `sql\`...\`` tagged-template chunks before testing —
      // the `sql` tag parameterises bindings safely.
      const stripped = args.replace(/\bsql\s*`[^`]*`/g, "");

      // Forbidden: any backtick template literal containing `${...}`
      // remaining after sql-tag stripping
      if (/`[^`]*\$\{[\s\S]*?`/.test(stripped)) {
        out.push({
          file,
          line: i + 1,
          reason: "template literal",
          snippet: `.${method}(...)`,
        });
        continue;
      }

      // Forbidden: a quoted string followed by `+` (string concatenation
      // building SQL). We require the `+` to follow a closing quote so we
      // don't match unrelated arithmetic.
      if (/['"][^'"]*['"]\s*\+/.test(stripped)) {
        out.push({
          file,
          line: i + 1,
          reason: "string concatenation",
          snippet: `.${method}(...)`,
        });
        continue;
      }
    }
  }
  return out;
}

function checkRawSql(): CheckResult {
  const dirs = [
    path.join(ROOT, "artifacts", "api-server"),
    path.join(ROOT, "lib", "db"),
  ].filter(fs.existsSync);

  if (dirs.length === 0) {
    return {
      name: "No raw SQL string interpolation",
      passed: true,
      skipped: true,
      message: "Neither artifacts/api-server nor lib/db exists — skipped",
    };
  }

  const files = dirs
    .flatMap((d) => collectFiles(d, [".ts"]))
    .filter((f) => !f.includes(".test.") && !f.includes(".spec."));

  const problems: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const matches = findRawSqlInterpolation(src, path.relative(ROOT, file));
    for (const m of matches) {
      problems.push(`${m.file}:${m.line}  ${m.reason}  ${m.snippet}`);
    }
  }

  if (problems.length === 0) {
    return {
      name: "No raw SQL string interpolation",
      passed: true,
      message: `${files.length} file(s) scanned — all SQL parameterised`,
    };
  }
  return {
    name: "No raw SQL string interpolation",
    passed: false,
    message: `${problems.length} raw SQL interpolation(s) — use Drizzle builder or sql\`\` tag`,
    detail: problems.slice(0, 15),
  };
}

// ─── Check 15: Tenant scoping helper required ────────────────────────────────
//
// Every service or route file under artifacts/api-server/src/{services,routes}
// that imports `db` from `@workspace/db` must also import the canonical
// `tenantScope` (or `withTenant`) helper from the same module. This catches
// the most dangerous pattern in a multi-tenant local-first app: an unscoped
// `db.select().from(t)` that returns rows across tenants.
//
// The detector parses import statements with a small regex pass that handles:
//   import { db } from "@workspace/db";
//   import { db, tenantScope } from "@workspace/db";
//   import { db, type X } from "@workspace/db";
//   import {
//     db,
//     tenantScope,
//   } from "@workspace/db";
//   import type { ... } from "@workspace/db"   <- type-only, ignored
//
// Documented heuristic limit: indirect access via `import * as dbMod` is not
// detected — caught by code review.
//
// Exported for fixture testing.

export interface UnscopedDbAccess {
  file: string;
  line: number;
  reason: string;
}

const SCOPED_HELPER_NAMES = ["tenantScope", "withTenant"];

export function findUnscopedDbAccess(src: string, file = "<test>"): UnscopedDbAccess[] {
  const out: UnscopedDbAccess[] = [];

  // Find every import statement from "@workspace/db" (multi-line tolerant).
  // We capture the brace body so we can inspect the named imports.
  const importRe =
    /^(\s*import\s+(?:type\s+)?\{)([^}]*)\}\s*from\s*["']@workspace\/db["'];?/gm;

  let m: RegExpExecArray | null;
  let importsDb = false;
  let importsHelper = false;
  let firstDbImportLine = 0;

  while ((m = importRe.exec(src)) !== null) {
    const head = m[1];
    const body = m[2];
    const isType = /\bimport\s+type\b/.test(head);
    // Split the body by commas, normalise each named import token.
    const names = body
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        // strip leading `type ` from per-name type imports, strip aliasing
        const noType = s.replace(/^type\s+/, "");
        const base = noType.split(/\s+as\s+/)[0].trim();
        return base;
      });

    const hasDb = names.includes("db");
    const hasHelper = names.some((n) => SCOPED_HELPER_NAMES.includes(n));

    if (hasDb && !isType) {
      importsDb = true;
      if (firstDbImportLine === 0) {
        // Compute the line where this import statement begins
        const upTo = src.slice(0, m.index);
        firstDbImportLine = upTo.split("\n").length;
      }
    }
    // Only count runtime helper imports — type-only `import type { tenantScope }`
    // does NOT exist at runtime and cannot be used to scope a query.
    if (hasHelper && !isType) {
      importsHelper = true;
    }
  }

  if (importsDb && !importsHelper) {
    out.push({
      file,
      line: firstDbImportLine,
      reason:
        "imports `db` from @workspace/db without `tenantScope`/`withTenant` (Standard 13)",
    });
  }
  return out;
}

function checkTenantScoping(): CheckResult {
  const dirs = [
    path.join(ROOT, "artifacts", "api-server", "src", "services"),
    path.join(ROOT, "artifacts", "api-server", "src", "routes"),
  ].filter(fs.existsSync);

  if (dirs.length === 0) {
    return {
      name: "Tenant scoping helper required",
      passed: true,
      skipped: true,
      message:
        "Neither artifacts/api-server/src/services nor /routes exists — skipped (active from Task #1/#17)",
    };
  }

  const files = dirs
    .flatMap((d) => collectFiles(d, [".ts"]))
    .filter((f) => !f.includes(".test.") && !f.includes(".spec."));

  const problems: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const matches = findUnscopedDbAccess(src, path.relative(ROOT, file));
    for (const x of matches) {
      problems.push(`${x.file}:${x.line}  ${x.reason}`);
    }
  }

  if (problems.length === 0) {
    return {
      name: "Tenant scoping helper required",
      passed: true,
      message: `${files.length} file(s) scanned — all db imports paired with tenantScope`,
    };
  }
  return {
    name: "Tenant scoping helper required",
    passed: false,
    message: `${problems.length} unscoped service/route file(s)`,
    detail: problems.slice(0, 15),
  };
}

// ─── Check 16: Pagination on list endpoints ──────────────────────────────────
//
// Every GET route in lib/api-spec/openapi.yaml whose 2xx response is a
// collection MUST return the cursor envelope `{ items, nextCursor }` (nested
// under the standard `{ success, data, error }` outer envelope).
//
// The detector reuses the same indentation-aware YAML walker as Check #6.
// For each (path, method=GET, status=2xx) tuple, it determines whether the
// response is:
//   1. A collection → must contain `items` AND `nextCursor` properties
//      somewhere inside the schema (inline or via $ref). This tolerates
//      `oneOf`/`anyOf` shapes as long as every branch contains the envelope.
//   2. A singleton  → not flagged.
//
// Heuristic for "collection": the response schema (or any of its branches)
// must declare a `data` property whose schema mentions `items:` AND
// `nextCursor:`, OR it must contain a top-level `type: array`. The first
// shape is the canonical envelope; the second is the bare-array form that
// MUST be flagged.
//
// Exported for fixture testing.

export interface PaginationProblem {
  path: string;
  method: string;
  status: string;
  reason: string;
}

export function findUnpaginatedListRoutes(src: string): PaginationProblem[] {
  const lines = src.split("\n");
  const problems: PaginationProblem[] = [];

  // Phase 1: index components/schemas → raw schema text (so we can scan $refs).
  const schemaText = new Map<string, string>();
  {
    let inComponents = false;
    let inSchemas = false;
    let currentSchema = "";
    let buffer: string[] = [];
    for (const line of lines) {
      if (!inComponents) {
        if (/^components:/.test(line)) inComponents = true;
        continue;
      }
      if (!inSchemas) {
        if (/^  schemas:/.test(line)) inSchemas = true;
        continue;
      }
      if (/^[a-zA-Z]/.test(line) && !line.startsWith(" ")) {
        if (currentSchema) schemaText.set(currentSchema, buffer.join("\n"));
        break;
      }
      const nameMatch = /^    (\w+):$/.exec(line);
      if (nameMatch) {
        if (currentSchema) schemaText.set(currentSchema, buffer.join("\n"));
        currentSchema = nameMatch[1];
        buffer = [];
        continue;
      }
      if (currentSchema) buffer.push(line);
    }
    if (currentSchema && !schemaText.has(currentSchema)) {
      schemaText.set(currentSchema, buffer.join("\n"));
    }
  }

  // Helper: given a chunk of schema text, return the "kind" we care about.
  // - "envelope"   → top-level shape is the canonical pagination envelope
  // - "bare-array" → top-level shape is `type: array`
  // - "singleton"  → anything else (single object, scalar, etc.)
  //
  // Classification is top-level / structural — NOT a global text search —
  // because a singleton response can legitimately carry a nested array
  // property (e.g. a User schema with a `friends: { type: array }` property)
  // and must NOT be flagged as an unpaginated list. The previous global
  // heuristic produced false positives for exactly this case.
  //
  // The "envelope" shape is recognised by the presence of `nextCursor:`
  // anywhere in the schema text — `nextCursor:` is the canonical marker
  // and is unique enough in practice that property-name collisions are
  // tolerated. Top-level $refs are chased up to 3 levels deep.
  //
  // Documented heuristic limit: `oneOf`/`anyOf` schemas with a mix of
  // envelope and bare-array branches are not validated branch-by-branch;
  // the first branch that produces a recognisable shape wins. The standard
  // documents this and recommends extracting each branch to its own
  // component schema.
  function classify(text: string, depth = 0): "envelope" | "bare-array" | "singleton" {
    if (!text) return "singleton";
    const lines = text.split("\n");

    // Find the smallest indent of any non-blank line — that's the top level.
    let baseIndent = -1;
    for (const line of lines) {
      if (line.trim() === "") continue;
      const ind = line.length - line.trimStart().length;
      if (baseIndent === -1 || ind < baseIndent) baseIndent = ind;
    }
    if (baseIndent < 0) return "singleton";

    // Scan top-level keys: top-level `type:` and top-level `$ref:` win first.
    let topLevelType = "";
    let topLevelRef = "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      const ind = line.length - line.trimStart().length;
      if (ind !== baseIndent) continue;
      const m = /^\s*([\w$]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      const valuePart = m[2];
      if (key === "type" && !topLevelType) topLevelType = valuePart.trim();
      if (key === "$ref" && !topLevelRef) {
        const refMatch = /["']#\/components\/schemas\/(\w+)["']/.exec(valuePart);
        if (refMatch) topLevelRef = refMatch[1];
      }
    }

    if (topLevelType === "array") return "bare-array";

    // Follow a top-level $ref before doing any global text scan
    if (topLevelRef && depth < 3) {
      const refText = schemaText.get(topLevelRef);
      if (refText !== undefined) return classify(refText, depth + 1);
    }

    // For object responses, the canonical envelope is recognised by the
    // presence of `nextCursor:` anywhere in the schema text. This is the
    // documented marker — singleton schemas should not contain it.
    if (/^\s*nextCursor\s*:/m.test(text)) return "envelope";

    // Last-ditch: walk nested $refs (e.g. response = $ref → envelope wrapper)
    if (depth >= 3) return "singleton";
    const refRe = /\$ref:\s*["']#\/components\/schemas\/(\w+)["']/g;
    let r: RegExpExecArray | null;
    let sawRefAsEnvelope = false;
    let sawRefAsBareArray = false;
    while ((r = refRe.exec(text)) !== null) {
      const refText = schemaText.get(r[1]);
      const k = classify(refText ?? "", depth + 1);
      if (k === "envelope") sawRefAsEnvelope = true;
      if (k === "bare-array") sawRefAsBareArray = true;
    }
    if (sawRefAsBareArray) return "bare-array";
    if (sawRefAsEnvelope) return "envelope";
    return "singleton";
  }

  // Phase 2: walk paths → method → 2xx response → classify.
  let currentPath = "";
  let currentMethod = "";
  let currentStatus = "";
  let inResponse = false;
  let inSchemaBlock = false;
  let schemaIndent = -1;
  let schemaBuf: string[] = [];

  function flush() {
    if (!inResponse) return;
    if (currentMethod.toUpperCase() !== "GET") {
      reset();
      return;
    }
    const kind = classify(schemaBuf.join("\n"));
    if (kind === "bare-array") {
      problems.push({
        path: currentPath,
        method: currentMethod.toUpperCase(),
        status: currentStatus,
        reason: "bare `type: array` 2xx response — use `{ items, nextCursor }` envelope",
      });
    }
    // For oneOf branches: if ANY branch is bare-array, the route is unpaginated
    // because the caller cannot rely on a cursor. The classify() call above
    // walks $refs but treats `oneOf` as multiple inline siblings — those
    // siblings are part of the same schema text, so a mixed oneOf with one
    // bare branch will already be detected as bare-array (items missing in
    // the bare branch). Acceptable for v1; documented in the standard.
    reset();
  }

  function reset() {
    inResponse = false;
    inSchemaBlock = false;
    schemaIndent = -1;
    schemaBuf = [];
  }

  for (const line of lines) {
    if (/^components:/.test(line)) {
      flush();
      break;
    }
    const pathMatch = /^  (\/[^\s:]+):$/.exec(line);
    if (pathMatch) {
      flush();
      currentPath = pathMatch[1];
      reset();
      continue;
    }
    const methodMatch = /^    (get|post|put|patch|delete|head|options):$/i.exec(line);
    if (methodMatch) {
      flush();
      currentMethod = methodMatch[1];
      reset();
      continue;
    }
    const statusMatch = /^        (["']?)(2\d{2})\1:/.exec(line);
    if (statusMatch) {
      flush();
      currentStatus = statusMatch[2];
      inResponse = true;
      inSchemaBlock = false;
      schemaIndent = -1;
      schemaBuf = [];
      continue;
    }
    if (!inResponse) continue;

    // Detect the schema: block at any depth under this 2xx response and
    // capture every line that is more deeply indented than `schema:` itself.
    const schemaMatch = /^(\s+)schema:/.exec(line);
    if (schemaMatch && schemaIndent === -1) {
      schemaIndent = schemaMatch[1].length;
      inSchemaBlock = true;
      continue;
    }
    if (inSchemaBlock && schemaIndent >= 0) {
      const trimmed = line.trimStart();
      if (trimmed.length === 0) {
        schemaBuf.push("");
        continue;
      }
      const indent = line.length - trimmed.length;
      if (indent <= schemaIndent) {
        // left the schema block
        inSchemaBlock = false;
        schemaIndent = -1;
      } else {
        schemaBuf.push(line);
      }
    }
  }
  flush();
  return problems;
}

function checkPaginationEnvelope(): CheckResult {
  const specPath = path.join(ROOT, "lib", "api-spec", "openapi.yaml");
  if (!fs.existsSync(specPath)) {
    return {
      name: "Pagination on list endpoints",
      passed: true,
      skipped: true,
      message: "openapi.yaml not found — skipped",
    };
  }
  const src = fs.readFileSync(specPath, "utf8");
  const problems = findUnpaginatedListRoutes(src);
  if (problems.length === 0) {
    return {
      name: "Pagination on list endpoints",
      passed: true,
      message: "All GET list endpoints return `{ items, nextCursor }` envelope",
    };
  }
  return {
    name: "Pagination on list endpoints",
    passed: false,
    message: `${problems.length} GET list endpoint(s) without pagination envelope`,
    detail: problems.slice(0, 15).map(
      (p) => `${p.method} ${p.path} "${p.status}": ${p.reason}`,
    ),
  };
}

// ─── Check 17: Required indexes on tenant + FK columns ───────────────────────
//
// Every Drizzle table (`pgTable`/`sqliteTable`) that declares a `tenant_id`
// (or `tenantId`) column MUST declare an `index(...)` covering it. Same for
// `workspace_id`/`workspaceId` and any column that uses `.references(...)`.
// A composite index that mentions the column counts as covered.
//
// The detector parses each `pgTable("name", { ... }, (t) => ({ ... }))` (or
// `sqliteTable`) declaration:
//   1. Captures the table body (the `{ ... }` columns block) using bracket
//      matching.
//   2. Captures the optional trailing index callback `(t) => ({ ... })` (or
//      `(table) => [ ... ]`) similarly. Drizzle accepts both shapes.
//   3. From the body, extracts every column name and notes whether it is a
//      tenant/workspace column or uses `.references(`.
//   4. From the index block, extracts every `.on(t.col1, t.col2, ...)` token
//      so we know which columns are indexed.
//   5. Fails for each in-scope column that is not mentioned in any
//      `.on(...)` token.
//
// Exported for fixture testing.

export interface MissingIndex {
  file: string;
  table: string;
  column: string;
  reason: string;
}

const TENANT_COL_NAMES = ["tenant_id", "tenantId", "workspace_id", "workspaceId"];

function captureBalanced(
  src: string,
  startIdx: number,
  open: string,
  close: string,
): { text: string; endIdx: number } | null {
  // Find the first `open` at or after startIdx
  let i = src.indexOf(open, startIdx);
  if (i < 0) return null;
  let depth = 0;
  let begin = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) {
      if (depth === 0) begin = i + 1;
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return { text: src.slice(begin, i), endIdx: i };
      }
    }
  }
  return null;
}

export function findMissingIndexes(src: string, file = "<test>"): MissingIndex[] {
  const out: MissingIndex[] = [];
  // Strip block + line comments to avoid matching commented examples
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => (/^\s*\/\//.test(l) ? "" : l))
    .join("\n");

  const tableRe = /\b(?:sqliteTable|pgTable)\s*\(\s*["'`](\w+)["'`]\s*,\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(stripped)) !== null) {
    const tableName = m[1];
    // Capture the columns body — start from the `{` we just matched
    const openBrace = m.index + m[0].length - 1;
    const body = captureBalanced(stripped, openBrace, "{", "}");
    if (!body) continue;

    // After the body's closing `}`, an optional `, (t) => ({...})` or
    // `, (table) => [...]` index callback may follow. Look ahead within
    // the same `(...)` envelope of the table call.
    let indexBlock = "";
    const afterBody = body.endIdx + 1;
    // Find the closing `)` of the table call to bound our search
    const tableCallEnd = (() => {
      let depth = 1; // we're inside (...)
      for (let i = afterBody; i < stripped.length; i++) {
        if (stripped[i] === "(") depth++;
        else if (stripped[i] === ")") {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    })();
    if (tableCallEnd > afterBody) {
      const tail = stripped.slice(afterBody, tableCallEnd);
      // Match a callback: `, (t) => ({...})` or `, (t) => [...]`
      const cbObj = /,\s*\(\s*\w+\s*\)\s*=>\s*\(\s*\{/.exec(tail);
      const cbArr = /,\s*\(\s*\w+\s*\)\s*=>\s*\[/.exec(tail);
      if (cbObj) {
        const start = afterBody + cbObj.index + cbObj[0].length - 1;
        const cap = captureBalanced(stripped, start, "{", "}");
        if (cap) indexBlock = cap.text;
      } else if (cbArr) {
        const start = afterBody + cbArr.index + cbArr[0].length - 1;
        const cap = captureBalanced(stripped, start, "[", "]");
        if (cap) indexBlock = cap.text;
      }
    }

    // Determine indexed columns from `.on(t.col1, t.col2, ...)` in indexBlock
    const indexedCols = new Set<string>();
    const onRe = /\.on\s*\(\s*([^)]+)\)/g;
    let onMatch: RegExpExecArray | null;
    while ((onMatch = onRe.exec(indexBlock)) !== null) {
      const argList = onMatch[1];
      // Each arg is `t.colName` — strip `t.` and grab identifier
      const colTokens = argList.match(/\w+\.(\w+)/g) ?? [];
      for (const tok of colTokens) {
        const name = tok.split(".")[1];
        indexedCols.add(name);
      }
    }

    // Walk the table body and collect (column name, in-scope reason)
    // Column declarations look like:  colName: text("col_name")...
    // We use the JS column name as the key — index callbacks reference it
    // via t.colName.
    const colRe = /^\s*(\w+)\s*:\s*([\s\S]*?)(?=,\s*\n|,\s*$|$)/gm;
    const inScope: Array<{ jsName: string; reason: string }> = [];
    let cm: RegExpExecArray | null;
    while ((cm = colRe.exec(body.text)) !== null) {
      const jsName = cm[1];
      const decl = cm[2];
      // Try to find the SQL name from the first string literal argument
      const sqlNameMatch = /["'`]([\w]+)["'`]/.exec(decl);
      const sqlName = sqlNameMatch ? sqlNameMatch[1] : "";
      const isTenant = TENANT_COL_NAMES.includes(jsName) ||
        TENANT_COL_NAMES.includes(sqlName);
      const isFk = /\.references\s*\(/.test(decl);
      if (isTenant || isFk) {
        inScope.push({
          jsName,
          reason: isTenant ? "tenant/workspace column" : "foreign key (.references)",
        });
      }
    }

    for (const col of inScope) {
      if (!indexedCols.has(col.jsName)) {
        out.push({
          file,
          table: tableName,
          column: col.jsName,
          reason: `${col.reason} has no covering index() entry`,
        });
      }
    }
  }
  return out;
}

function checkRequiredIndexes(): CheckResult {
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
      name: "Required indexes on tenant + FK columns",
      passed: true,
      skipped: true,
      message: "No schema files found — skipped (active from Task #37 onwards)",
    };
  }

  const problems: string[] = [];
  for (const file of schemaFiles) {
    const src = fs.readFileSync(file, "utf8");
    const matches = findMissingIndexes(src, path.relative(ROOT, file));
    for (const x of matches) {
      problems.push(`${x.file}: ${x.table}.${x.column} — ${x.reason}`);
    }
  }

  if (problems.length === 0) {
    return {
      name: "Required indexes on tenant + FK columns",
      passed: true,
      message: `${schemaFiles.length} schema file(s) checked — all required indexes present`,
    };
  }
  return {
    name: "Required indexes on tenant + FK columns",
    passed: false,
    message: `${problems.length} column(s) missing required index`,
    detail: problems.slice(0, 15),
  };
}

// ─── Check 18: No unbounded module-level caches ──────────────────────────────
//
// Module-level (top-level, file-scope) `new Map(...)` / `new Set(...)` are
// forbidden unless wrapped by `LRUCache` on the same line OR the previous
// non-blank line carries `// tier-review: bounded — <reason>`.
//
// "Module-level" here means a line whose first non-whitespace token is one of
// `const`, `let`, `var`, or starts with `export const`/`export let`/`export var`.
// Function-local declarations, useState/useRef calls, and class field
// initialisers all have shorter indentation patterns OR sit on lines whose
// declaration keyword is at non-zero indent.
//
// Exported for fixture testing.

export interface UnboundedCache {
  file: string;
  line: number;
  reason: string;
}

const MODULE_DECL_RE =
  /^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+\w+/;
const NEW_MAP_OR_SET_RE = /\bnew\s+(Map|Set)\b(?:\s*<[^>]*>)?\s*\(/;

export function findUnboundedCaches(src: string, file = "<test>"): UnboundedCache[] {
  const lines = src.split("\n");
  const out: UnboundedCache[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Module-level declarations start at column 0
    if (line.length === 0 || line[0] === " " || line[0] === "\t") continue;

    if (!MODULE_DECL_RE.test(line)) continue;
    if (!NEW_MAP_OR_SET_RE.test(line)) continue;

    // Allowed if LRUCache is on the same line (the value is wrapped, not the
    // forbidden raw Map/Set)
    if (/\bLRUCache\b/.test(line)) continue;

    // Allowed if the previous non-blank line carries the justification comment
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === "") j--;
    const prev = j >= 0 ? lines[j] : "";
    if (/\/\/\s*tier-review:\s*bounded\b/.test(prev)) continue;

    const which = NEW_MAP_OR_SET_RE.exec(line)?.[1] ?? "Map/Set";
    out.push({
      file,
      line: i + 1,
      reason: `module-level new ${which}() — wrap with LRUCache or annotate with \`// tier-review: bounded — <reason>\``,
    });
  }
  return out;
}

function checkBoundedCaches(): CheckResult {
  const dirs = [path.join(ROOT, "artifacts"), path.join(ROOT, "lib")].filter(fs.existsSync);
  if (dirs.length === 0) {
    return {
      name: "No unbounded module-level caches",
      passed: true,
      skipped: true,
      message: "Neither artifacts/ nor lib/ exists — skipped",
    };
  }

  const files = dirs
    .flatMap((d) => collectFiles(d, [".ts", ".tsx"]))
    .filter(
      (f) =>
        !f.includes(".test.") &&
        !f.includes(".spec.") &&
        !f.endsWith("tier-review.ts"),
    );

  const problems: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const matches = findUnboundedCaches(src, path.relative(ROOT, file));
    for (const x of matches) {
      problems.push(`${x.file}:${x.line}  ${x.reason}`);
    }
  }

  if (problems.length === 0) {
    return {
      name: "No unbounded module-level caches",
      passed: true,
      message: `${files.length} file(s) scanned — no unbounded caches`,
    };
  }
  return {
    name: "No unbounded module-level caches",
    passed: false,
    message: `${problems.length} unbounded module-level cache(s)`,
    detail: problems.slice(0, 15),
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
    checkGeneratedDeclarationsFresh,
    checkPrivacyLog,
    checkPerformanceBudgets,
    checkBundleSize,
    checkDangerousExec,
    checkUnsafeHtml,
    checkDependencyAudit,
    checkRawSql,
    checkTenantScoping,
    checkPaginationEnvelope,
    checkRequiredIndexes,
    checkBoundedCaches,
    checkI18nKeyParity,
    checkA11yAxeCore,
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

// ─── Check 19: i18n key parity (Task #28) ────────────────────────────────────
// Re-runs the standalone `pnpm --filter @workspace/scripts run i18n-check`
// gate so the translation parity contract is enforced as part of tier review.
function checkI18nKeyParity(): CheckResult {
  const { ok, output } = run("pnpm --filter @workspace/scripts run i18n-check");
  if (ok) {
    return {
      name: "Translation key parity",
      passed: true,
      message: "All locale bundles mirror the English key set",
    };
  }
  const detail = output
    .split("\n")
    .filter((l) => l.includes("missing") || l.includes("stray") || l.startsWith("✗"))
    .slice(0, 15);
  return {
    name: "Translation key parity",
    passed: false,
    message: "One or more locale bundles diverged from English",
    detail,
  };
}

// ─── Check 20: axe-core rendered accessibility audit (Task #28) ─────────────
// Runs the artifact-local `pnpm --filter @workspace/omninity-website run
// a11y-check` gate, which renders the marketing landing and operator
// settings routes through React + the full provider stack and audits the
// resulting DOM with axe-core. Fails on any moderate/serious/critical
// WCAG 2.1 AA violation.
function checkA11yAxeCore(): CheckResult {
  const { ok, output } = run(
    "pnpm --filter @workspace/omninity-website run a11y-check",
  );
  if (ok) {
    return {
      name: "axe-core accessibility",
      passed: true,
      message: "No serious/critical WCAG 2.1 AA violations",
    };
  }
  const detail = output
    .split("\n")
    .filter(
      (l) =>
        l.includes("[moderate]") ||
        l.includes("[serious]") ||
        l.includes("[critical]") ||
        l.includes("a11y-check failed"),
    )
    .slice(0, 15);
  return {
    name: "axe-core accessibility",
    passed: false,
    message: "Serious or critical accessibility violations detected",
    detail,
  };
}

// ─── Check 21: Compiled .d.ts in sync with generated source (Task #112) ──────
// Project-reference consumers (e.g. omninity-website -> api-client-react) read
// type declarations from `lib/*/dist/generated/*.d.ts`. If `tsc --build` is
// not re-run after orval regenerates `src/generated/*.ts`, the consumer's
// typecheck silently sees a stale API surface — that exact trap broke the
// Communications page on Task #11/#112. The api-spec codegen script already
// chains `pnpm -w run typecheck:libs` (`tsc --build`), so any regression here
// means someone bypassed codegen and edited generated source by hand. This
// check enforces dist freshness via a cheap mtime comparison: for each lib
// package that ships both `src/generated/` and `dist/generated/`, the newest
// `.d.ts` mtime must be >= the newest `src/generated/*` mtime.
function checkGeneratedDeclarationsFresh(): CheckResult {
  const candidates = [
    path.join(ROOT, "lib", "api-client-react"),
    path.join(ROOT, "lib", "api-zod"),
  ];
  // Verify each candidate's dist/generated/*.d.ts EXPORTS every identifier
  // declared in src/generated/*.ts. We extract the names with a cheap regex
  // (top-level `export {function|const|type|interface|class|enum|var|let}
  // Name`) — far cheaper than running tsc and immune to mtime jitter from
  // orval re-touching byte-identical output.
  const NAME_RE =
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|type|interface|class|enum|var|let)\s+([A-Za-z_$][\w$]*)/gm;

  function exportedNames(file: string): Set<string> {
    const names = new Set<string>();
    const text = fs.readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = NAME_RE.exec(text)) !== null) names.add(m[1]);
    return names;
  }

  const checked: string[] = [];
  const missing: string[] = [];

  for (const pkgRoot of candidates) {
    const srcDir = path.join(pkgRoot, "src", "generated");
    const distDir = path.join(pkgRoot, "dist", "generated");
    if (!fs.existsSync(srcDir)) continue;
    // Some lib packages don't emit declarations (consumed via source path
    // mappings). Skip those — this check only guards project-reference
    // consumers that read from dist.
    if (!fs.existsSync(distDir)) continue;

    const srcFiles = collectFiles(srcDir, [".ts", ".tsx"]).filter(
      (f) => !f.endsWith(".d.ts"),
    );
    const dtsFiles = collectFiles(distDir, [".ts"]).filter((f) =>
      f.endsWith(".d.ts"),
    );
    if (srcFiles.length === 0 || dtsFiles.length === 0) continue;

    const distNames = new Set<string>();
    for (const f of dtsFiles) {
      for (const n of exportedNames(f)) distNames.add(n);
    }

    const rel = path.relative(ROOT, pkgRoot);
    checked.push(rel);

    const missingHere: string[] = [];
    for (const f of srcFiles) {
      for (const n of exportedNames(f)) {
        if (!distNames.has(n)) missingHere.push(n);
      }
    }
    if (missingHere.length > 0) {
      // Show at most 5 names per package to keep output bounded.
      const shown = missingHere.slice(0, 5).join(", ");
      const more =
        missingHere.length > 5 ? ` (+${missingHere.length - 5} more)` : "";
      missing.push(
        `${rel} — dist/generated/*.d.ts is missing ${missingHere.length} export(s) declared in src/generated: ${shown}${more}; run \`pnpm --filter @workspace/api-spec run codegen\``,
      );
    }
  }

  if (checked.length === 0) {
    return {
      name: "Generated .d.ts in sync",
      passed: true,
      skipped: true,
      message: "No lib packages with dist/generated — skipped",
    };
  }
  if (missing.length === 0) {
    return {
      name: "Generated .d.ts in sync",
      passed: true,
      message: `${checked.length} package(s) up to date — ${checked.join(", ")}`,
    };
  }
  return {
    name: "Generated .d.ts in sync",
    passed: false,
    message: `${missing.length} package(s) have stale compiled declarations`,
    detail: missing,
  };
}

// Only auto-execute when this file is the direct entry point, not when imported
const _isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("tier-review.ts");
if (_isMain) {
  main();
}
