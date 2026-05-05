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
 * Why backup/restore?
 *   electron-builder's `npmRebuild: true` rewrites the better-sqlite3 native
 *   binary for the Electron ABI.  Because pnpm uses a shared content-
 *   addressable store, this also breaks the binary for the dev API server.
 *   The restore step copies the pre-packaging binary back.  The packaged app
 *   is not affected — its Electron-ABI binary was already bundled into the
 *   asar during step 4 before the restore happens.
 *
 * Backup location: /tmp/   (NOT inside node_modules, which would get packed)
 *
 * Usage:
 *   node package.mjs [linux|mac|win]   (defaults to linux)
 */

import { execSync } from "child_process";
import { copyFileSync, existsSync, readdirSync } from "fs";
import { createRequire } from "module";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __dir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dir, "../..");

// Supported platform tokens:
//   linux       → --linux dir  (fast, CI-testable unpacked directory)
//   linux:deb   → --linux deb  (generates .deb installer; needs dpkg-deb)
//   mac         → --mac dmg    (needs macOS + Xcode)
//   win         → --win nsis   (needs Windows)
//
// When no argument is given, the current OS is auto-detected so that
// `pnpm run package` produces the native installer on each CI runner:
//   - Linux   → linux (unpacked dir)
//   - macOS   → mac   (.dmg)
//   - Windows → win   (.exe)
const osPlatform = process.platform; // 'linux' | 'darwin' | 'win32'
const nativePlatform =
  osPlatform === "darwin" ? "mac" : osPlatform === "win32" ? "win" : "linux";
const platform = process.argv[2] || nativePlatform;
if (!["linux", "linux:deb", "mac", "win"].includes(platform)) {
  console.error(`Unknown platform: ${platform}. Use linux | linux:deb | mac | win.`);
  process.exit(1);
}
console.log(`→ Packaging for platform: ${platform} (OS: ${osPlatform})`);

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

// ── 3. Locate better-sqlite3 binary and back it up ────────────────────────
// Resolve from this package's own context — better-sqlite3 is listed as a
// direct dependency of @workspace/omninity-desktop so import.meta.url-based
// resolution finds it via pnpm's virtual store symlinks.
const ownRequire = createRequire(import.meta.url);
let binaryPath = null;
try {
  binaryPath = ownRequire.resolve(
    "better-sqlite3/build/Release/better_sqlite3.node"
  );
} catch {
  // Fallback: derive path from the known pnpm store structure
  const bsqRoot = resolve(
    workspaceRoot,
    "node_modules/.pnpm"
  );
  if (existsSync(bsqRoot)) {
    const entry = readdirSync(bsqRoot).find((d) =>
      d.startsWith("better-sqlite3@")
    );
    if (entry) {
      const candidate = resolve(
        bsqRoot,
        entry,
        "node_modules/better-sqlite3/build/Release/better_sqlite3.node"
      );
      if (existsSync(candidate)) binaryPath = candidate;
    }
  }
}

// Store the backup in /tmp so it is never accidentally packed into the asar
const backupPath = resolve(tmpdir(), "better_sqlite3.node.abi-backup");
if (binaryPath && existsSync(binaryPath)) {
  console.log("→ Backing up better-sqlite3 Node.js ABI binary to /tmp ...");
  copyFileSync(binaryPath, backupPath);
  console.log(`  backed up: ${binaryPath}`);
} else {
  console.warn(
    `⚠  better-sqlite3 binary not found (binaryPath=${binaryPath}) — ` +
      "ABI backup skipped; the dev server may need manual rebuild after packaging"
  );
  binaryPath = null;
}

// ── 4. Run electron-builder ───────────────────────────────────────────────
const platformFlags = {
  linux: "--linux dir",
  "linux:deb": "--linux deb",
  mac: "--mac",
  win: "--win",
};
const ebArgs = `${platformFlags[platform]} --publish never`;
console.log(`→ Running electron-builder ${ebArgs}...`);

const ebEnv = {
  ...process.env,
  // Disable code signing on all platforms — the developer must configure
  // CSC_LINK + CSC_KEY_PASSWORD (or APPLE_API_KEY etc.) for signed releases.
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  NODE_ENV: "production",
};

let packagingError = null;
try {
  // Use the local electron-builder binary (it is a devDependency of this
  // package, so it is available at ./node_modules/.bin/electron-builder when
  // run via `pnpm --filter` or `node package.mjs` from this directory).
  // Using the full relative path avoids relying on it being in $PATH.
  execSync(`./node_modules/.bin/electron-builder ${ebArgs}`, { stdio: "inherit", env: ebEnv, cwd: __dir });
} catch (err) {
  packagingError = err;
} finally {
  // ── 5. Restore Node.js ABI binary ───────────────────────────────────────
  if (binaryPath && existsSync(backupPath)) {
    console.log("→ Restoring better-sqlite3 Node.js ABI binary...");
    copyFileSync(backupPath, binaryPath);
    console.log("✓  better-sqlite3 restored (Node.js ABI)");
  }
}

if (packagingError) {
  console.error("\n✗  electron-builder failed:", packagingError.message);
  process.exit(1);
}
