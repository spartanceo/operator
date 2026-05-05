#!/usr/bin/env node
/**
 * package.mjs — Electron packaging helper for Omninity Desktop
 *
 * Handles:
 *   1. Web frontend build (injects required PORT + BASE_PATH env vars)
 *   2. Electron main/preload esbuild
 *   3. better-sqlite3 Node.js ABI binary backup  (before electron-builder)
 *   4. electron-builder  (npmRebuild compiles binary for Electron ABI)
 *   5. better-sqlite3 restore  (copies backup back → Node.js ABI restored)
 *
 * The backup/restore step is necessary because electron-builder's npmRebuild
 * rewrites the shared pnpm-store binary for the Electron ABI.  Restoring the
 * backup does NOT affect the packaged app — the Electron-ABI binary was
 * already bundled into the asar during step 4.
 *
 * Usage:
 *   node package.mjs [linux|mac|win]   (defaults to linux)
 */

import { execSync, spawnSync } from "child_process";
import { copyFileSync, existsSync } from "fs";
import { createRequire } from "module";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dir, "../..");

const platform = process.argv[2] || "linux";
if (!["linux", "mac", "win"].includes(platform)) {
  console.error(`Unknown platform: ${platform}. Use linux | mac | win.`);
  process.exit(1);
}

// ── 1. Build web frontend ──────────────────────────────────────────────────
const PORT = process.env.PORT || "20599";
const BASE_PATH = process.env.BASE_PATH || "/omninity-operator/";
console.log(`→ Building web frontend (PORT=${PORT} BASE_PATH=${BASE_PATH})...`);
execSync("pnpm --filter @workspace/omninity-website run build", {
  stdio: "inherit",
  cwd: workspaceRoot,
  env: {
    ...process.env,
    PORT,
    BASE_PATH,
    NODE_ENV: "production",
  },
});

// ── 2. Build Electron main / preload ──────────────────────────────────────
console.log("→ Building Electron main process...");
execSync("node build.mjs", { stdio: "inherit", cwd: __dir });

// ── 3. Back up the Node.js ABI binary ─────────────────────────────────────
const wsRequire = createRequire(resolve(workspaceRoot, "package.json"));
let binaryPath;
try {
  binaryPath = wsRequire.resolve(
    "better-sqlite3/build/Release/better_sqlite3.node"
  );
} catch {
  binaryPath = resolve(
    workspaceRoot,
    "node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  );
}

const backupPath = binaryPath + ".abi-backup";
if (existsSync(binaryPath)) {
  console.log("→ Backing up better-sqlite3 Node.js ABI binary...");
  copyFileSync(binaryPath, backupPath);
} else {
  console.warn("⚠  better-sqlite3 binary not found — skipping backup");
  binaryPath = null;
}

// ── 4. Run electron-builder ───────────────────────────────────────────────
const platformFlags = { linux: "--linux", mac: "--mac", win: "--win" };
const ebArgs = `${platformFlags[platform]} --publish never`;
console.log(`→ Running electron-builder ${ebArgs}...`);

const ebEnv = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  NODE_ENV: "production",
};

try {
  execSync(`electron-builder ${ebArgs}`, { stdio: "inherit", env: ebEnv, cwd: __dir });
} finally {
  // ── 5. Restore Node.js ABI binary ─────────────────────────────────────
  if (binaryPath && existsSync(backupPath)) {
    console.log("→ Restoring better-sqlite3 Node.js ABI binary...");
    copyFileSync(backupPath, binaryPath);
    console.log("✓  better-sqlite3 restored for Node.js (ABI 137)");
  }
}
