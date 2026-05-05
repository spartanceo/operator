/**
 * esbuild script for the Electron main process and preload script.
 *
 * Produces:
 *   dist/main.js     — Electron main process (CJS, Node target)
 *   dist/preload.js  — Preload script (CJS, Node target)
 *
 * Both bundles mark `electron`, native `.node` modules, and pino (+ its
 * runtime deps) as external.  electron-builder packages the `dependencies`
 * listed in package.json into the installer, so these are available at
 * runtime without being bundled.
 *
 * NOTE: esbuild-plugin-pino is intentionally NOT used here.  That plugin is
 * only needed when pino is fully inlined into the bundle (which breaks its
 * internal worker-thread file paths).  By keeping pino external we avoid the
 * plugin and its transitive peer-dep requirements (thread-stream, pino-pretty)
 * at build time while getting correct runtime behaviour.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

import { build as esbuild } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");

const external = [
  "electron",
  "better-sqlite3",
  "*.node",
  // pino and its runtime deps — kept in node_modules, packaged by electron-builder
  "pino",
  "pino-abstract-transport",
  "pino-std-serializers",
  "thread-stream",
  "sonic-boom",
  "atomic-sleep",
  "on-exit-leak-free",
  "real-require",
  "safe-stable-stringify",
  "quick-format-unescaped",
  "fast-redact",
  "process-warning",
  "pino-http",
  "pino-pretty",
  // Other packages that use dynamic require / native bindings
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
  // Replace import.meta.url with the CJS equivalent so that source files
  // that use fileURLToPath(import.meta.url) continue to resolve paths
  // correctly from the bundled dist/main.js location.
  // esbuild define only accepts identifiers, so we inject a banner variable
  // and reference it by name.
  banner: {
    js: 'const __importMetaUrl = require("url").pathToFileURL(__filename).toString();',
  },
  define: {
    "import.meta.url": "__importMetaUrl",
  },
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
