/**
 * esbuild script for the Electron main process and preload script.
 *
 * Produces:
 *   dist/main.js     — Electron main process (CJS, Node target)
 *   dist/preload.js  — Preload script (CJS, Node target)
 *
 * Both bundles mark `electron` and native `.node` modules as external.
 * `better-sqlite3` is listed in package.json#dependencies so electron-builder
 * rebuilds it for the Electron ABI and includes it in the installer.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");

const external = [
  "electron",
  "better-sqlite3",
  "*.node",
  // Packages that use dynamic require / native bindings — exclude from bundle
  "fsevents",
  "bcrypt",
  "canvas",
  "sharp",
];

const alias = {
  "@workspace/api-server/server": path.resolve(
    __dirname,
    "..",
    "api-server",
    "src",
    "server.ts",
  ),
  "@workspace/db": path.resolve(root, "lib", "db", "src", "index.ts"),
  "@workspace/errors": path.resolve(root, "lib", "errors", "src", "index.ts"),
  "@workspace/types": path.resolve(root, "lib", "types", "src", "index.ts"),
};

const sharedConfig = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external,
  alias,
  conditions: ["workspace"],
  tsconfig: path.resolve(__dirname, "tsconfig.json"),
  logLevel: "info",
  sourcemap: true,
  plugins: [esbuildPluginPino({ transports: [] })],
};

await rm(path.resolve(__dirname, "dist"), { recursive: true, force: true });

await Promise.all([
  esbuild({
    ...sharedConfig,
    entryPoints: [path.resolve(__dirname, "src", "main.ts")],
    outfile: path.resolve(__dirname, "dist", "main.js"),
  }),
  esbuild({
    ...sharedConfig,
    entryPoints: [path.resolve(__dirname, "src", "preload.ts")],
    outfile: path.resolve(__dirname, "dist", "preload.js"),
  }),
]);
