# Omninity Operator — Desktop Packaging Guide

Omninity Operator ships as a native desktop app for macOS and Windows built
with Electron. The web UI and embedded API server are bundled into a single
self-contained installer — no internet connection, cloud account, or external
runtime required.

## Quick start

From the **workspace root**, run one command for your target platform:

```sh
# Current platform (Linux → .deb + unpacked dir)
pnpm run package

# macOS .dmg (must run on macOS)
pnpm run package:mac

# Windows .exe installer (must run on Windows or Linux + Wine)
pnpm run package:win

# Linux .deb + unpacked dir (run on Linux)
pnpm run package:linux
```

Output lands in `artifacts/omninity-desktop/release/`.

## Build pipeline (what `pnpm run package` does)

1. **Website build** — Vite compiles the Omninity Operator React UI into
   `artifacts/omninity-website/dist/public/`.
2. **Electron bundle** — `esbuild` bundles `src/main.ts` and `src/preload.ts`
   into `dist/main.js` and `dist/preload.js` (CommonJS, Node target).
3. **electron-builder packaging** — reads `electron-builder.yml`, rebuilds
   native modules (`better-sqlite3`) for the correct Electron ABI, copies the
   renderer assets into `resources/renderer/`, and packages everything into a
   platform-specific installer.

## Platform requirements

| Installer | Build on | Notes |
|-----------|----------|-------|
| macOS `.dmg` (x64 + arm64) | macOS | No code-signing cert needed for development builds (`CSC_IDENTITY_AUTO_DISCOVERY=false` is set). Users will see a Gatekeeper warning — right-click → Open to bypass it. |
| Windows `.exe` (NSIS) | Windows or Linux + Wine | Wine must have `winetricks`, `mono`, and the .NET SDK. Without Wine, use a Windows CI runner. |
| Linux `.deb` + unpacked | Linux | Works natively; no extra tools required. |

## Output files

After a successful build:

```
artifacts/omninity-desktop/release/
  Omninity Operator-0.0.1.dmg           # macOS disk image (macOS build)
  Omninity Operator-0.0.1-arm64.dmg     # Apple Silicon (macOS build)
  Omninity Operator Setup 0.0.1.exe     # Windows installer (Windows build)
  omninity-operator_0.0.1_amd64.deb    # Debian/Ubuntu package (Linux build)
  linux-unpacked/                        # Unpacked Linux app (Linux build)
```

## Installing the app

### macOS
1. Open the `.dmg` file.
2. Drag **Omninity Operator** to your Applications folder.
3. On first launch, right-click the app → **Open** to bypass the Gatekeeper
   warning (unsigned build). After that, double-click works normally.

### Windows
1. Run `Omninity Operator Setup 0.0.1.exe`.
2. The installer is a one-click NSIS setup — it installs to `%LOCALAPPDATA%`
   and creates a Start Menu shortcut.
3. SmartScreen may warn about an unknown publisher (unsigned build) — click
   **More info → Run anyway**.

### Linux
- **deb package**: `sudo dpkg -i omninity-operator_0.0.1_amd64.deb`
- **Unpacked**: run `linux-unpacked/omninity-operator` directly.

## Code signing (deferred)

This MVP build is **unsigned**. Users will see OS security warnings on first
launch. To remove those warnings for distribution:

- **macOS**: requires an Apple Developer ID certificate and notarisation via
  `xcrun notarytool`. Set `CSC_LINK`, `CSC_KEY_PASSWORD`, and
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` env vars before building.
- **Windows**: requires an EV or OV code-signing certificate. Set `CSC_LINK`
  and `CSC_KEY_PASSWORD` before building.

## Native module rebuild

`better-sqlite3` is compiled C++ and must match the Electron ABI. The build
pipeline handles this automatically via `electron-builder`'s `npmRebuild: true`
option — it downloads the correct Electron headers and recompiles the binding
before packaging. No manual steps needed.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Cannot find module 'pino'` during `node build.mjs` | Run `pnpm install --filter @workspace/omninity-desktop` first |
| `better-sqlite3` crash on launch | Delete `artifacts/omninity-desktop/node_modules/better-sqlite3/build` and re-run the build — electron-builder will rebuild it |
| macOS build fails: `No identity found` | The `CSC_IDENTITY_AUTO_DISCOVERY=false` flag should suppress this; if still failing, export `CSC_IDENTITY_AUTO_DISCOVERY=false` manually in your shell |
| Windows build on Linux fails | Install Wine (`brew install --cask wine-stable` or `apt install wine`) and `winetricks dotnet40` |
| App shows blank white screen | The renderer server failed to start — check the console log in DevTools (Cmd+Opt+I / Ctrl+Shift+I) |
