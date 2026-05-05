# Omninity Operator — Desktop Packaging Guide

Omninity Operator ships as a native desktop app for macOS and Windows built
with Electron. The web UI and embedded API server are bundled into a single
self-contained installer — no internet connection, cloud account, or external
runtime required.

## Quick start

From the **workspace root**, run one command for your target platform:

```sh
# Linux unpacked directory — fast, CI-testable (default)
pnpm run package:linux

# Linux .deb installer (needs dpkg-deb)
pnpm run package:linux:deb

# macOS .dmg (must run on macOS)
pnpm run package:mac

# Windows .exe installer (must run on Windows)
pnpm run package:win
```

`pnpm run package` is an alias for `pnpm run package:linux`.

Output lands in `artifacts/omninity-desktop/release/`.

## Build pipeline (what `pnpm run package:linux` does)

1. **Website build** — Vite compiles the Omninity Operator React UI into
   `artifacts/omninity-website/dist/public/`. `PORT` and `BASE_PATH` are
   injected automatically by `package.mjs`.
2. **Electron bundle** — `esbuild` bundles `src/main.ts` and `src/preload.ts`
   into `dist/main.js` and `dist/preload.js` (CommonJS, Node target).
3. **Binary backup** — the `better-sqlite3` native binary is backed up to
   `/tmp/` before electron-builder runs (see "Native module ABI" below).
4. **electron-builder packaging** — reads `electron-builder.yml`, rebuilds
   `better-sqlite3` for the Electron ABI, copies renderer assets, and packages
   everything into the target format.
5. **Binary restore** — the backup is restored unconditionally (even on
   failure) so the dev API server binary stays at the correct Node.js ABI.

## Platform requirements

| Installer | Build on | Notes |
|-----------|----------|-------|
| Linux `dir` (unpacked) | Linux | No extra tools. Fast. Used for CI. |
| Linux `.deb` | Linux | Requires `dpkg-deb` (standard on Debian/Ubuntu). |
| macOS `.dmg` (x64 + arm64) | macOS | No code-signing cert needed for dev builds. Users see a Gatekeeper warning — right-click → Open to bypass. |
| Windows `.exe` (NSIS) | Windows | Cross-compilation from Linux is not supported. Use a `windows-latest` CI runner. |

## Output files

```
artifacts/omninity-desktop/release/
  linux-unpacked/                           # unpacked Linux app (dir target)
    omninity-operator                       # main executable
    resources/
      app.asar                              # bundled app code
      renderer/                             # built web frontend
  Omninity Operator-0.0.1-amd64.deb        # Debian installer (deb target)
  Omninity Operator-0.0.1.dmg              # macOS disk image (mac target)
  Omninity Operator-0.0.1-arm64.dmg        # Apple Silicon (mac target)
  Omninity Operator Setup 0.0.1.exe        # Windows installer (win target)
```

## Installing the app

### macOS
1. Open the `.dmg` file.
2. Drag **Omninity Operator** to your Applications folder.
3. On first launch, right-click → **Open** to bypass the Gatekeeper warning
   (unsigned build). After that, double-click works normally.

### Windows
1. Run `Omninity Operator Setup 0.0.1.exe`.
2. One-click NSIS installer — installs to `%LOCALAPPDATA%`, creates a Start
   Menu shortcut.
3. SmartScreen may warn about an unknown publisher — click **More info → Run
   anyway**.

### Linux
- **deb package**: `sudo dpkg -i "Omninity Operator-0.0.1-amd64.deb"`
- **Unpacked**: run `linux-unpacked/omninity-operator` directly.

## Code signing (deferred — task #218)

This MVP build is **unsigned**. Users will see OS security warnings on first
launch. To remove them for public distribution:

- **macOS**: requires an Apple Developer ID certificate and notarisation.
  Set `CSC_LINK`, `CSC_KEY_PASSWORD`, and notarisation env vars before building.
- **Windows**: requires an EV or OV code-signing certificate.
  Set `CSC_LINK` and `CSC_KEY_PASSWORD` before building.

## Native module ABI (better-sqlite3)

`better-sqlite3` is compiled C++ and must match the correct ABI:

| Consumer | ABI needed |
|----------|-----------|
| Packaged Electron app | Electron ABI (v135 for Electron 36) |
| Dev API server (Node.js 24) | Node.js ABI v137 |

`electron-builder` rebuilds the module for Electron ABI during packaging, but
since pnpm uses a shared binary store this also affects the dev API server.

`package.mjs` handles this transparently with a backup/restore strategy:
the binary is copied to `/tmp/` before packaging and restored afterwards.

### Manual rebuild (if binary gets stuck after an interrupted build)

```bash
BSQ_DIR="node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3"
NODE_DIR="/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0"
NODEGHP="node_modules/.pnpm/node_modules/.bin/node-gyp"

cd "$BSQ_DIR"
"$NODEGHP" configure --nodedir="$NODE_DIR"
JOBS=max make -C build BUILDTYPE=Release
```

Then restart the API server workflow.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `PORT env var required` during build | Use `node package.mjs linux` — it injects PORT automatically |
| `better-sqlite3` ABI mismatch after build | Rebuild manually (see above) |
| `electron-builder: command not found` | Use `pnpm run package:linux` from workspace root |
| `dpkg-deb` not found for deb target | Use `pnpm run package:linux` (dir target) instead |
| macOS build fails: `No identity found` | Set `CSC_IDENTITY_AUTO_DISCOVERY=false` in your shell |
| App shows blank white screen | Renderer failed to load — open DevTools (Cmd+Opt+I / Ctrl+Shift+I) |
