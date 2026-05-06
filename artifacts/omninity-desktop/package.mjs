#!/usr/bin/env node
/**
 * package.mjs — Electron packaging helper for Omninity Desktop
 *
 * Build pipeline:
 *   1. Web frontend build  (omninity-website → dist/public)
 *   2. Electron main/preload esbuild  (→ dist/main.js, dist/preload.js)
 *   3. pnpm deploy --prod  — materialise a staging dir with a real flat
 *      node_modules.  pnpm's default layout stores every package as a symlink
 *      into its virtual store (../../../node_modules/.pnpm/…).  electron-
 *      builder's asar packer stores those as symlinks inside the archive, but
 *      the symlink targets do not exist on the end-user's machine, so every
 *      runtime require() fails.  pnpm deploy resolves ALL transitive deps
 *      (no symlinks) into an isolated directory that electron-builder can pack
 *      correctly.
 *   4. Populate staging dir with build artefacts + config.
 *   5. electron-builder  — builds the installer from the staging dir.
 *   6. Clean up staging dir.
 *
 * Why no better-sqlite3 backup/restore?
 *   With the pnpm-deploy approach, electron-builder operates on an isolated
 *   COPY of node_modules (not the shared pnpm store).  npmRebuild rewrites
 *   the binary inside the staging copy only; the dev environment's binary is
 *   untouched.  The original backup/restore logic is therefore unnecessary.
 *
 * Usage:
 *   node package.mjs [linux|linux:deb|mac|win]   (defaults to current OS)
 */

import { execSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __dir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dir, "../..");

// Supported platform tokens:
//   linux       → --linux dir  (fast, CI-testable unpacked directory)
//   linux:deb   → --linux deb  (generates .deb installer; needs dpkg-deb)
//   mac         → --mac dmg    (needs macOS + Xcode CLT)
//   win         → --win nsis   (needs Windows)
//
// When no argument is given, the current OS is auto-detected.
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
const BASE_PATH = process.env.BASE_PATH || "/";
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

// ── 3. pnpm deploy — resolve all production deps into a staging dir ────────
//
// pnpm stores every dependency as a symlink into its virtual store:
//   node_modules/multer → ../../../node_modules/.pnpm/multer@2.1.1/…
//
// electron-builder's asar packer preserves these as symlinks.  When the
// packaged app runs on the user's machine the symlink targets do not exist,
// so every require() for an external module fails with "Cannot find module".
//
// `pnpm deploy --prod` resolves the FULL transitive dependency graph and
// copies real files (no symlinks) into an isolated directory.
const deployDir = resolve(tmpdir(), `omninity-desktop-deploy-${process.pid}`);
console.log(`→ Staging production deployment at ${deployDir} ...`);
if (existsSync(deployDir)) rmSync(deployDir, { recursive: true, force: true });

// --legacy: pnpm v10 requires inject-workspace-packages=true by default for
// deploy.  --legacy restores the pre-v10 behaviour (self-contained flat
// node_modules, no injection required).  Safe because omninity-desktop has
// no workspace:* packages in its dependencies (everything from api-server is
// bundled into dist/main.js by esbuild before this step runs).
execSync(
  `pnpm --filter @workspace/omninity-desktop deploy --prod --legacy "${deployDir}"`,
  { stdio: "inherit", cwd: workspaceRoot },
);

// ── 4. Populate staging dir with build artefacts + config ─────────────────
console.log("→ Copying build artefacts into staging dir...");

// Electron main/preload (pnpm deploy only copies workspace source files, not
// generated dist/).
cpSync(resolve(__dir, "dist"), resolve(deployDir, "dist"), {
  recursive: true,
  dereference: true,
});

// electron-builder config — write a modified copy with the renderer path
// made absolute so it resolves correctly from inside the staging dir.
const rendererAbsPath = resolve(
  workspaceRoot,
  "artifacts/omninity-website/dist/public",
);
let ebYml = readFileSync(resolve(__dir, "electron-builder.yml"), "utf8");
// Replace the workspace-relative renderer path with an absolute path.
ebYml = ebYml.replace(
  /from:\s*["']\.\.\/omninity-website\/dist\/public["']/,
  `from: "${rendererAbsPath}"`,
);
writeFileSync(resolve(deployDir, "electron-builder.yml"), ebYml);

// macOS entitlements plist and app icon (referenced by electron-builder.yml).
for (const subdir of ["build", "assets"]) {
  const src = resolve(__dir, subdir);
  if (existsSync(src)) {
    cpSync(src, resolve(deployDir, subdir), { recursive: true });
  }
}

// Stub electron package.json so electron-builder can determine the Electron
// version for npmRebuild (it reads node_modules/electron/package.json).
// We only need the version field — the full binary is not required here.
const electronPkgPath = resolve(__dir, "node_modules/electron/package.json");
if (existsSync(electronPkgPath)) {
  const electronPkg = JSON.parse(readFileSync(electronPkgPath, "utf8"));
  const stubDir = resolve(deployDir, "node_modules/electron");
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    resolve(stubDir, "package.json"),
    JSON.stringify({ name: "electron", version: electronPkg.version }),
  );
}

// ── 5. Run electron-builder ───────────────────────────────────────────────
const platformFlags = {
  linux: "--linux dir",
  "linux:deb": "--linux deb",
  mac: "--mac",
  win: "--win",
};

// Output always goes to __dir/release/ regardless of the staging cwd.
const releaseDir = resolve(__dir, "release");
const ebArgs = [
  platformFlags[platform],
  "--publish never",
  `-c.directories.output="${releaseDir}"`,
].join(" ");

console.log(`→ Running electron-builder ${ebArgs}...`);

const ebEnv = {
  ...process.env,
  // Disable code signing — configure CSC_LINK + CSC_KEY_PASSWORD for signed releases.
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  NODE_ENV: "production",
};

let packagingError = null;
try {
  // Run electron-builder from the staging dir so it finds the resolved
  // node_modules.  Use the binary from __dir's devDependencies since the
  // staging dir (--prod) does not include it.
  execSync(
    `"${resolve(__dir, "node_modules/.bin/electron-builder")}" ${ebArgs}`,
    { stdio: "inherit", env: ebEnv, cwd: deployDir },
  );
} catch (err) {
  packagingError = err;
} finally {
  // ── 6. Clean up staging dir ─────────────────────────────────────────────
  try {
    rmSync(deployDir, { recursive: true, force: true });
    console.log("→ Staging dir cleaned up.");
  } catch {
    console.warn(`⚠  Could not remove staging dir: ${deployDir}`);
  }
}

if (packagingError) {
  console.error("\n✗  electron-builder failed:", packagingError.message);
  process.exit(1);
}

console.log(`\n✓  Packaging complete. Output: ${releaseDir}`);
