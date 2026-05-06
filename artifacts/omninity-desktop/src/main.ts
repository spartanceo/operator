/**
 * Electron main process — Omninity Operator desktop app.
 *
 * Responsibilities:
 *   1. Find a free port and start the embedded Express API server.
 *   2. Create a BrowserWindow that loads the Omninity Operator UI.
 *   3. Manage the system tray icon (show/hide window, Quit).
 *   4. Implement the "close to tray" pattern — closing the window hides it
 *      rather than terminating the process.
 *   5. Handle graceful shutdown on before-quit: stop the API server cleanly.
 */
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";

import { app, BrowserWindow, ipcMain, Menu, nativeImage, systemPreferences, Tray } from "electron";

import type { ServerHandle } from "@workspace/api-server/server";
import { startServer } from "@workspace/api-server/server";

// ─── Crash logger (writes to userData before pino is up) ─────────────────────

function crashLog(msg: string): void {
  try {
    const logDir = app.getPath("userData");
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, "crash.log");
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    writeFileSync(logFile, line, { flag: "a" });
    process.stderr.write(line);
  } catch {
    process.stderr.write(`[omninity-desktop] ${msg}\n`);
  }
}

process.on("uncaughtException", (err) => {
  crashLog(`UncaughtException: ${err?.stack ?? err}`);
});

process.on("unhandledRejection", (reason) => {
  crashLog(`UnhandledRejection: ${reason}`);
});

// ─── Free port discovery ──────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createTcpServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not determine bound port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ─── State ────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverHandle: ServerHandle | null = null;
let quitting = false;

// ─── Tray icon (inline 16×16 RGBA — no external image file required) ─────────

function buildTrayIcon(): Electron.NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = 75; // R
    buf[i * 4 + 1] = 85; // G
    buf[i * 4 + 2] = 99; // B
    buf[i * 4 + 3] = 255; // A
  }

  const assetPath = join(
    app.isPackaged ? process.resourcesPath : join(__dirname, "..", "assets"),
    "tray-icon.png",
  );

  try {
    const fromFile = nativeImage.createFromPath(assetPath);
    if (!fromFile.isEmpty()) return fromFile;
  } catch {
    // fall through to programmatic icon
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

// ─── Static renderer file server (production only, pure Node.js) ──────────────

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStaticDir(rendererDir: string): Promise<number> {
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const rawPath = req.url?.split("?")[0] ?? "/";
    // Strip leading slash so path.join resolves relative to rendererDir, not filesystem root
    const stripped = rawPath.replace(/^\/+/, "").replace(/\.\./g, "");
    let filePath = join(rendererDir, stripped === "" ? "index.html" : stripped);

    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) filePath = join(filePath, "index.html");
      statSync(filePath); // confirm file exists
    } catch {
      filePath = join(rendererDir, "index.html");
    }

    const mime = MIME[extname(filePath)] ?? "application/octet-stream";
    res.setHeader("Content-Type", mime);
    createReadStream(filePath)
      .on("error", () => {
        res.writeHead(500);
        res.end("Internal Server Error");
      })
      .pipe(res);
  });

  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not determine renderer server port"));
        return;
      }
      resolve(addr.port);
    });
  });
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow(apiPort: number): BrowserWindow {
  const preloadPath = join(__dirname, "preload.js");

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Omninity Operator",
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  process.env["ELECTRON_API_PORT"] = String(apiPort);

  if (!app.isPackaged) {
    const devUrl = process.env["RENDERER_DEV_URL"] ?? "http://127.0.0.1:20599/";
    win.loadURL(devUrl).catch(() => {
      if (!win.isDestroyed()) win.loadURL(`http://127.0.0.1:${apiPort}/`);
    });
  } else {
    const rendererDir = join(process.resourcesPath, "renderer");
    serveStaticDir(rendererDir)
      .then((rPort) => {
        if (!win.isDestroyed()) win.loadURL(`http://127.0.0.1:${rPort}/`);
      })
      .catch((err: unknown) => {
        crashLog(`serveStaticDir failed: ${err} — falling back to loadFile`);
        if (!win.isDestroyed()) {
          win.loadFile(join(process.resourcesPath, "renderer", "index.html")).catch((e: unknown) => {
            crashLog(`loadFile fallback also failed: ${e}`);
          });
        }
      });
  }

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });

  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    {
      label: "Show Omninity",
      click() {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          if (!mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("tray-action", "show");
          }
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click() {
        app.quit();
      },
    },
  ]);
}

function createTray(): Tray {
  const icon = buildTrayIcon();
  const t = new Tray(icon);
  t.setToolTip("Omninity Operator");
  t.setContextMenu(buildTrayMenu());

  t.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return t;
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Point the DB at the user's writable app-data directory (not the read-only
  // app bundle) so SQLite can create / open the database in a packaged build.
  if (app.isPackaged && !process.env["SQLITE_PATH"]) {
    const userDataDir = app.getPath("userData");
    mkdirSync(userDataDir, { recursive: true });
    process.env["SQLITE_PATH"] = join(userDataDir, "omninity.db");
    crashLog(`Using SQLITE_PATH: ${process.env["SQLITE_PATH"]}`);
  }

  // On macOS packaged builds, request Accessibility permission on first launch.
  // nut-js keyboard/mouse control requires it.  Passing `true` triggers the
  // macOS permission dialog automatically; subsequent launches skip the prompt
  // if the user has already granted access.
  if (process.platform === "darwin" && app.isPackaged) {
    systemPreferences.isTrustedAccessibilityClient(true);
  }

  process.env["ELECTRON_RUNTIME"] = "1";

  findFreePort()
    .then((apiPort) => startServer(apiPort))
    .then((handle) => {
      serverHandle = handle;
      mainWindow = createWindow(handle.port);
      tray = createTray();
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      crashLog(`Fatal startup error: ${msg}`);
      app.quit();
    });
});

app.on("window-all-closed", () => {
  // Intentionally do nothing — the tray keeps the app alive.
  // The process exits only on explicit "Quit" from the tray menu.
});

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("before-quit", (event) => {
  if (serverHandle && !quitting) {
    event.preventDefault();
    quitting = true;
    serverHandle.close().finally(() => {
      app.quit();
    });
  }
});

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle("get-api-port", () => {
  return serverHandle?.port ?? null;
});
