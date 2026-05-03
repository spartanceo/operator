#!/usr/bin/env tsx
/**
 * Workspace coverage runner — uses Node's built-in V8 coverage capture
 * (NODE_V8_COVERAGE env var) and rolls per-package coverage into a single
 * line/function summary.
 *
 * Why no c8 / nyc: zero new dependencies. Node 20+ writes one JSON file per
 * spawned process to `NODE_V8_COVERAGE` directory; each file contains
 * V8's `Profiler.takePreciseCoverage` output. We walk those files, map
 * the URLs back to source files, and aggregate hit/miss counts.
 *
 * Outputs:
 *   coverage/v8/<pkg>/*.json           — raw v8 coverage
 *   coverage/summary.json              — machine-readable rollup
 *   coverage/summary.md                — human-readable Markdown table
 *
 * Exits non-zero in `--check` mode if any in-scope `lib/**` package falls
 * below COVERAGE_MIN_PCT (default 80).
 *
 * Usage:
 *   pnpm coverage              # generate report
 *   pnpm coverage:check        # generate + enforce 80% on lib/**
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const COVERAGE_DIR = path.join(ROOT, "coverage");
const V8_DIR = path.join(COVERAGE_DIR, "v8");
const COVERAGE_MIN_PCT = Number(process.env["COVERAGE_MIN_PCT"] ?? "80");

// Packages excluded from the coverage gate. `@workspace/types` is almost
// entirely TypeScript type/interface declarations — V8 reports those as
// "untouched lines" because they erase to nothing at runtime, which
// would falsely fail the gate. Function coverage on this package is
// already at 100%; the line metric here is not meaningful.
const COVERAGE_GATE_EXCLUDE = new Set<string>(["@workspace/types"]);

const args = process.argv.slice(2);
const CHECK_MODE = args.includes("--check");

interface PackageCoverage {
  pkg: string;
  files: number;
  linesCovered: number;
  linesTotal: number;
  fnsCovered: number;
  fnsTotal: number;
  perFile: Array<{
    file: string;
    linesPct: number;
    fnsPct: number;
  }>;
}

interface V8FunctionCoverage {
  functionName: string;
  isBlockCoverage: boolean;
  ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
}

interface V8ScriptCoverage {
  scriptId: string;
  url: string;
  functions: V8FunctionCoverage[];
}

interface V8CoverageFile {
  result: V8ScriptCoverage[];
}

/**
 * Walk a directory recursively and return all matching files.
 */
function walk(dir: string, predicate: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      out.push(...walk(full, predicate));
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Discover workspace packages with a `test` script. Returns list of
 * `{ name, dir }` tuples in deterministic alphabetical order.
 */
function discoverTestablePackages(): Array<{ name: string; dir: string }> {
  const pkgs: Array<{ name: string; dir: string }> = [];
  for (const root of [path.join(ROOT, "lib"), path.join(ROOT, "artifacts")]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const pkgJsonPath = path.join(dir, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (pkgJson.scripts?.test) {
        pkgs.push({ name: pkgJson.name ?? entry.name, dir });
      }
    }
  }
  return pkgs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Aggregate v8 coverage JSON files into per-source-file line + function
 * coverage. Filters to files inside `pkgDir/src` so we don't count
 * dependencies or test fixtures.
 *
 * V8 coverage works in offsets (byte positions in the source). We compute
 * line coverage by reading each source file, walking its newlines, and
 * marking each line as "hit" if any byte on that line falls inside a
 * covered range with count > 0.
 */
function aggregateV8Coverage(
  v8Files: string[],
  pkgDir: string,
): Pick<
  PackageCoverage,
  | "files"
  | "linesCovered"
  | "linesTotal"
  | "fnsCovered"
  | "fnsTotal"
  | "perFile"
> {
  const srcRoot = path.join(pkgDir, "src");
  const perFile = new Map<
    string,
    {
      covered: Set<number>;
      total: number;
      fnsCovered: number;
      fnsTotal: number;
    }
  >();

  for (const v8File of v8Files) {
    let parsed: V8CoverageFile;
    try {
      parsed = JSON.parse(readFileSync(v8File, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.result)) continue;

    for (const script of parsed.result) {
      // V8 reports URLs as `file://` for ESM; strip the prefix.
      let url = script.url;
      if (url.startsWith("file://")) url = fileURLToPath(url);
      // Skip everything outside our src folder.
      if (!url.startsWith(srcRoot)) continue;
      // Skip test/spec/bench files — they shouldn't count toward coverage.
      if (/\.(test|spec|bench)\.(ts|tsx|js|mjs)$/.test(url)) continue;
      // Skip non-source extensions.
      if (!/\.(ts|tsx|js|mjs)$/.test(url)) continue;

      const src = (() => {
        try {
          return readFileSync(url, "utf8");
        } catch {
          return null;
        }
      })();
      if (src === null) continue;

      // Build a lookup: byte offset → line number.
      const lineStarts: number[] = [0];
      for (let i = 0; i < src.length; i++) {
        if (src[i] === "\n") lineStarts.push(i + 1);
      }
      const totalLines = lineStarts.length;

      function offsetToLine(offset: number): number {
        // Binary search.
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (lineStarts[mid]! <= offset) lo = mid;
          else hi = mid - 1;
        }
        return lo;
      }

      const entry = perFile.get(url) ?? {
        covered: new Set<number>(),
        total: totalLines,
        fnsCovered: 0,
        fnsTotal: 0,
      };

      let fnsCovered = 0;
      let fnsTotal = 0;

      for (const fn of script.functions) {
        // The first range of every function is the whole function body.
        const wholeFn = fn.ranges[0];
        if (wholeFn) {
          fnsTotal++;
          if (wholeFn.count > 0) fnsCovered++;
        }
        // Mark every line that falls inside any range with count > 0 as hit.
        for (const range of fn.ranges) {
          if (range.count <= 0) continue;
          const startLine = offsetToLine(range.startOffset);
          const endLine = offsetToLine(
            Math.max(range.startOffset, range.endOffset - 1),
          );
          for (let line = startLine; line <= endLine; line++) {
            entry.covered.add(line);
          }
        }
      }

      entry.fnsCovered = Math.max(entry.fnsCovered, fnsCovered);
      entry.fnsTotal = Math.max(entry.fnsTotal, fnsTotal);
      perFile.set(url, entry);
    }
  }

  // Files in src/ that V8 never saw still count toward total — they are
  // 0% covered. Discover them separately.
  if (existsSync(srcRoot)) {
    const allSrcFiles = walk(
      srcRoot,
      (f) => /\.(ts|tsx)$/.test(f) && !/\.(test|spec|bench)\.(ts|tsx)$/.test(f),
    );
    for (const f of allSrcFiles) {
      if (perFile.has(f)) continue;
      const totalLines = readFileSync(f, "utf8").split("\n").length;
      perFile.set(f, {
        covered: new Set(),
        total: totalLines,
        fnsCovered: 0,
        fnsTotal: 0,
      });
    }
  }

  let linesCovered = 0;
  let linesTotal = 0;
  let fnsCovered = 0;
  let fnsTotal = 0;
  const perFileReport: PackageCoverage["perFile"] = [];

  for (const [file, entry] of perFile) {
    const linesPct =
      entry.total === 0 ? 100 : (entry.covered.size / entry.total) * 100;
    const fnsPct =
      entry.fnsTotal === 0 ? 100 : (entry.fnsCovered / entry.fnsTotal) * 100;
    linesCovered += entry.covered.size;
    linesTotal += entry.total;
    fnsCovered += entry.fnsCovered;
    fnsTotal += entry.fnsTotal;
    perFileReport.push({
      file: path.relative(ROOT, file),
      linesPct,
      fnsPct,
    });
  }

  perFileReport.sort((a, b) => a.linesPct - b.linesPct);

  return {
    files: perFile.size,
    linesCovered,
    linesTotal,
    fnsCovered,
    fnsTotal,
    perFile: perFileReport,
  };
}

function runPackageWithCoverage(pkg: {
  name: string;
  dir: string;
}): PackageCoverage {
  const v8Out = path.join(V8_DIR, pkg.name.replace(/[/@]/g, "_"));
  if (existsSync(v8Out)) rmSync(v8Out, { recursive: true, force: true });
  mkdirSync(v8Out, { recursive: true });

  const env = {
    ...process.env,
    NODE_V8_COVERAGE: v8Out,
    // Tests already gate on this being absent — keep it absent for accuracy.
    NODE_OPTIONS: process.env["NODE_OPTIONS"] ?? "",
  };

  process.stdout.write(`  • ${pkg.name} ... `);
  let ok = true;
  try {
    execSync("pnpm run test", {
      cwd: pkg.dir,
      stdio: "pipe",
      env,
    });
  } catch {
    ok = false;
  }
  process.stdout.write(ok ? "ok\n" : "FAIL\n");

  const v8Files = walk(v8Out, (f) => f.endsWith(".json"));
  const agg = aggregateV8Coverage(v8Files, pkg.dir);
  return { pkg: pkg.name, ...agg };
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 100;
  return (num / denom) * 100;
}

function pctStr(p: number): string {
  return `${p.toFixed(1)}%`;
}

function renderMarkdown(report: PackageCoverage[]): string {
  const lines: string[] = [];
  lines.push("# Coverage Summary");
  lines.push("");
  lines.push(
    `Generated by \`pnpm coverage\` — minimum threshold: ${COVERAGE_MIN_PCT}% on \`lib/**\` packages.`,
  );
  lines.push("");
  lines.push("| Package | Files | Lines | Functions |");
  lines.push("|---|---:|---:|---:|");
  for (const r of report) {
    const linesPct = pct(r.linesCovered, r.linesTotal);
    const fnsPct = pct(r.fnsCovered, r.fnsTotal);
    lines.push(
      `| \`${r.pkg}\` | ${r.files} | ${pctStr(linesPct)} (${r.linesCovered}/${r.linesTotal}) | ${pctStr(fnsPct)} (${r.fnsCovered}/${r.fnsTotal}) |`,
    );
  }
  lines.push("");

  // Worst-covered files per package, top 5.
  for (const r of report) {
    if (r.perFile.length === 0) continue;
    lines.push(`## ${r.pkg} — lowest-coverage files`);
    lines.push("");
    lines.push("| File | Lines | Functions |");
    lines.push("|---|---:|---:|");
    for (const f of r.perFile.slice(0, 5)) {
      lines.push(
        `| \`${f.file}\` | ${pctStr(f.linesPct)} | ${pctStr(f.fnsPct)} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  if (existsSync(COVERAGE_DIR))
    rmSync(COVERAGE_DIR, { recursive: true, force: true });
  mkdirSync(V8_DIR, { recursive: true });

  const pkgs = discoverTestablePackages();
  process.stdout.write(`\nCoverage — ${pkgs.length} package(s) with tests:\n`);

  const report: PackageCoverage[] = [];
  for (const pkg of pkgs) {
    report.push(runPackageWithCoverage(pkg));
  }

  const summaryJson = path.join(COVERAGE_DIR, "summary.json");
  const summaryMd = path.join(COVERAGE_DIR, "summary.md");
  writeFileSync(
    summaryJson,
    JSON.stringify(
      report.map((r) => ({
        pkg: r.pkg,
        files: r.files,
        lines: {
          covered: r.linesCovered,
          total: r.linesTotal,
          pct: pct(r.linesCovered, r.linesTotal),
        },
        functions: {
          covered: r.fnsCovered,
          total: r.fnsTotal,
          pct: pct(r.fnsCovered, r.fnsTotal),
        },
      })),
      null,
      2,
    ),
  );
  writeFileSync(summaryMd, renderMarkdown(report));

  process.stdout.write(
    `\nSummary written to ${path.relative(ROOT, summaryMd)}\n`,
  );
  for (const r of report) {
    const linesPct = pct(r.linesCovered, r.linesTotal);
    process.stdout.write(
      `  ${r.pkg.padEnd(30)} lines ${pctStr(linesPct).padStart(7)}  fns ${pctStr(pct(r.fnsCovered, r.fnsTotal)).padStart(7)}\n`,
    );
  }

  if (CHECK_MODE) {
    const failures: string[] = [];
    for (const r of report) {
      // Only enforce on lib/** packages — artifacts include integration code
      // (route handlers tested via supertest) where v8 line coverage is noisy.
      if (!r.pkg.startsWith("@workspace/")) continue;
      if (COVERAGE_GATE_EXCLUDE.has(r.pkg)) continue;
      const isLib = pkgs
        .find((p) => p.name === r.pkg)
        ?.dir.includes(`${path.sep}lib${path.sep}`);
      if (!isLib) continue;
      const linesPct = pct(r.linesCovered, r.linesTotal);
      if (linesPct < COVERAGE_MIN_PCT) {
        failures.push(
          `  ✗ ${r.pkg} — line coverage ${pctStr(linesPct)} < ${COVERAGE_MIN_PCT}%`,
        );
      }
    }
    if (failures.length > 0) {
      process.stderr.write(`\nCoverage gate FAILED:\n${failures.join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write(
      `\n✓ All lib/** packages meet the ${COVERAGE_MIN_PCT}% line coverage threshold.\n`,
    );
  }
}

main().catch((e) => {
  process.stderr.write(
    `coverage runner failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
