#!/usr/bin/env tsx
/**
 * Flaky test detector.
 *
 * Runs `pnpm test` (or a per-package `test` script) N times and flags any
 * package whose result oscillates between pass/fail across runs. A package
 * that consistently fails is NOT flaky — it is broken; this tool is for
 * intermittent failures that pass on retry.
 *
 * Output: a Markdown summary at `coverage/flaky.md` plus a console table.
 * Exits non-zero only when a flaky package is detected; consistently-broken
 * packages are reported but do NOT cause a non-zero exit (run the regular
 * test suite for those — this tool's job is flake detection only).
 *
 * Usage:
 *   pnpm flaky-detect              # 5 runs, all packages
 *   pnpm flaky-detect --runs=10    # custom run count
 *   pnpm flaky-detect --pkg=@workspace/db  # one package only
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

interface CliArgs {
  runs: number;
  pkg?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { runs: 5 };
  for (const arg of argv) {
    const m = /^--runs=(\d+)$/.exec(arg);
    if (m) args.runs = parseInt(m[1]!, 10);
    const p = /^--pkg=(.+)$/.exec(arg);
    if (p) args.pkg = p[1]!;
  }
  if (args.runs < 2) args.runs = 2;
  return args;
}

interface PkgInfo {
  name: string;
  dir: string;
}

function discoverTestablePackages(): PkgInfo[] {
  const pkgs: PkgInfo[] = [];
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

function runOnce(pkg: PkgInfo): boolean {
  try {
    execSync("pnpm run test", {
      cwd: pkg.dir,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

interface PkgResult {
  name: string;
  passes: number;
  fails: number;
  flaky: boolean;
  consistentlyBroken: boolean;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allPkgs = discoverTestablePackages();
  const pkgs = args.pkg ? allPkgs.filter((p) => p.name === args.pkg) : allPkgs;

  if (pkgs.length === 0) {
    process.stderr.write(`No matching packages found.\n`);
    process.exit(1);
  }

  process.stdout.write(
    `\nFlaky-test detector — ${pkgs.length} package(s) × ${args.runs} runs\n\n`,
  );

  const results = new Map<string, PkgResult>();
  for (const pkg of pkgs) {
    results.set(pkg.name, {
      name: pkg.name,
      passes: 0,
      fails: 0,
      flaky: false,
      consistentlyBroken: false,
    });
  }

  for (let run = 1; run <= args.runs; run++) {
    process.stdout.write(`Run ${run}/${args.runs}:\n`);
    for (const pkg of pkgs) {
      process.stdout.write(`  • ${pkg.name} ... `);
      const ok = runOnce(pkg);
      const r = results.get(pkg.name)!;
      if (ok) r.passes++;
      else r.fails++;
      process.stdout.write(ok ? "pass\n" : "FAIL\n");
    }
  }

  let flakyCount = 0;
  for (const r of results.values()) {
    r.flaky = r.passes > 0 && r.fails > 0;
    r.consistentlyBroken = r.passes === 0;
    if (r.flaky) flakyCount++;
  }

  // Render report.
  const md: string[] = [];
  md.push("# Flaky-Test Detector Report");
  md.push("");
  md.push(`Runs per package: **${args.runs}**`);
  md.push("");
  md.push("| Package | Passes | Fails | Verdict |");
  md.push("|---|---:|---:|---|");
  for (const r of results.values()) {
    const verdict = r.flaky
      ? "🟡 FLAKY"
      : r.consistentlyBroken
        ? "🔴 BROKEN"
        : "🟢 stable";
    md.push(`| \`${r.name}\` | ${r.passes} | ${r.fails} | ${verdict} |`);
  }
  md.push("");

  const outDir = path.join(ROOT, "coverage");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "flaky.md");
  writeFileSync(outFile, md.join("\n"));

  // Quarantine list: a machine-readable JSON of every package the
  // detector flagged as flaky. Future tooling (CI annotations, the
  // QA orchestrator's "quarantined" badge, etc.) can read this file
  // without re-parsing the Markdown report.
  const quarantineFile = path.join(outDir, "quarantine.json");
  const quarantineEntries = [...results.values()]
    .filter((r) => r.flaky)
    .map((r) => ({
      pkg: r.name,
      passes: r.passes,
      fails: r.fails,
      runs: args.runs,
      flakeRate: r.fails / (r.passes + r.fails),
      detectedAt: new Date().toISOString(),
      action: "quarantine — investigate before re-enabling on PR gate",
    }));
  writeFileSync(
    quarantineFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runsPerPackage: args.runs,
        quarantined: quarantineEntries,
      },
      null,
      2,
    ),
  );

  process.stdout.write(
    `\nReport: ${path.relative(ROOT, outFile)}\nQuarantine list: ${path.relative(ROOT, quarantineFile)}\n\n`,
  );
  for (const r of results.values()) {
    const verdict = r.flaky
      ? "FLAKY"
      : r.consistentlyBroken
        ? "BROKEN"
        : "stable";
    process.stdout.write(
      `  ${r.name.padEnd(30)} ${verdict.padStart(8)}  (${r.passes}P/${r.fails}F)\n`,
    );
  }

  if (flakyCount > 0) {
    process.stdout.write(
      `\n✗ ${flakyCount} package(s) flagged as flaky — quarantine and investigate.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`\n✓ No flaky packages detected.\n`);
}

main().catch((e) => {
  process.stderr.write(
    `flaky-detect failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
