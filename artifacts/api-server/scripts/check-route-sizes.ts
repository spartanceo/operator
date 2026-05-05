/**
 * check-route-sizes.ts
 *
 * Guardrail: walks src/routes/**\/*.ts and flags any file that exceeds
 *   - 800 lines, OR
 *   - 15 HTTP handler calls (router.get/post/put/patch/delete)
 *
 * Files that were already over the ceiling when this check was introduced
 * are explicitly allowlisted so they don't produce false failures. The check
 * only catches net-new violations going forward.
 *
 * Usage:
 *   pnpm --filter api-server check:routes
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LINE_LIMIT = 800;
const HANDLER_LIMIT = 15;

/**
 * Files that were already over the ceiling before this guardrail was added.
 * Paths are relative to src/routes/.
 * Do NOT add new files here — fix the file instead.
 * Using a frozen plain object (not a Set) to keep this a fixed-size lookup.
 */
const ALLOWLIST: Readonly<Record<string, true>> = Object.freeze({
  "skills/index.ts": true,        // 32 handlers (769 lines) at introduction
  "dr/index.ts": true,            // 24 handlers (512 lines) at introduction
  "creator-legal.ts": true,       // 19 handlers (679 lines) at introduction
  "custom-models/index.ts": true, // 19 handlers (405 lines) at introduction
  "admin/super.ts": true,         // 17 handlers (194 lines) at introduction
  "privacy/index.ts": true,       // 16 handlers (343 lines) at introduction
  "mdm/index.ts": true,           // 15 handlers (301 lines) at introduction
});

const HANDLER_RE = /router\.(get|post|put|patch|delete)\s*\(/g;

interface Violation {
  relPath: string;
  lines: number;
  handlers: number;
  reasons: string[];
}

function collectRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRouteFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

function checkFile(absPath: string, routesRoot: string): Violation | null {
  const relPath = path.relative(routesRoot, absPath).replace(/\\/g, "/");

  if (Object.prototype.hasOwnProperty.call(ALLOWLIST, relPath)) {
    return null;
  }

  const content = fs.readFileSync(absPath, "utf8");
  const lines = content.split("\n").length;
  const handlers = (content.match(HANDLER_RE) ?? []).length;

  const reasons: string[] = [];
  if (lines > LINE_LIMIT) {
    reasons.push(`${lines} lines (limit ${LINE_LIMIT})`);
  }
  if (handlers > HANDLER_LIMIT) {
    reasons.push(`${handlers} HTTP handlers (limit ${HANDLER_LIMIT})`);
  }

  if (reasons.length === 0) return null;

  return { relPath, lines, handlers, reasons };
}

function out(msg: string): void {
  process.stdout.write(msg + "\n");
}

function err(msg: string): void {
  process.stderr.write(msg + "\n");
}

function main(): void {
  const routesRoot = path.resolve(__dirname, "../src/routes");

  if (!fs.existsSync(routesRoot)) {
    err(`[check-route-sizes] routes directory not found: ${routesRoot}`);
    process.exit(1);
  }

  const files = collectRouteFiles(routesRoot);
  const violations: Violation[] = [];

  for (const file of files) {
    const v = checkFile(file, routesRoot);
    if (v) violations.push(v);
  }

  if (violations.length === 0) {
    out(
      `[check-route-sizes] OK — all ${files.length} route file(s) are within limits ` +
      `(<= ${LINE_LIMIT} lines, <= ${HANDLER_LIMIT} handlers).`,
    );
    process.exit(0);
  }

  err(`[check-route-sizes] FAIL — ${violations.length} route file(s) exceed the size ceiling.\n`);
  err(`  Limits: ${LINE_LIMIT} lines, ${HANDLER_LIMIT} HTTP handlers per file.\n`);
  err(`  Violations:\n`);

  for (const v of violations) {
    err(`  • src/routes/${v.relPath}`);
    for (const reason of v.reasons) {
      err(`      - ${reason}`);
    }
  }

  err(
    `\n  To fix: split the file into smaller focused route modules.\n` +
    `  Do NOT add the file to the ALLOWLIST in scripts/check-route-sizes.ts — ` +
    `the allowlist is for legacy files only.`,
  );

  process.exit(1);
}

main();
