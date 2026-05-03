/**
 * Minimal development preview server for the Replit preview pane.
 *
 * In a real desktop environment, `pnpm run dev` launches Electron directly.
 * In Replit (no display server), this script instead serves a simple HTML
 * status page explaining that the Electron desktop app must be built and run
 * locally on macOS or Windows.
 *
 * This script is used as the Replit artifact "dev" command so the artifact
 * appears in the preview dropdown without crashing.
 */
import { createServer } from "node:http";

const PORT = Number(process.env["PORT"] ?? "8099");

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Omninity Operator — Desktop App</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: oklch(0.145 0 0);
      color: oklch(0.875 0 0);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .card {
      background: oklch(0.205 0 0);
      border: 1px solid oklch(0.27 0 0);
      border-radius: 12px;
      padding: 2.5rem;
      max-width: 580px;
      width: 100%;
    }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
    .badge {
      display: inline-block;
      background: oklch(0.4 0 0);
      color: oklch(0.87 0 0);
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 999px;
      margin-bottom: 1.5rem;
    }
    p { color: oklch(0.65 0 0); line-height: 1.6; margin-bottom: 1rem; }
    code {
      background: oklch(0.145 0 0);
      border: 1px solid oklch(0.27 0 0);
      border-radius: 6px;
      padding: 0.75rem 1rem;
      display: block;
      font-size: 0.875rem;
      color: oklch(0.75 0.15 220);
      white-space: pre;
      overflow-x: auto;
      margin-bottom: 1rem;
    }
    .section-title {
      font-size: 0.875rem;
      font-weight: 500;
      color: oklch(0.78 0 0);
      margin-bottom: 0.5rem;
    }
    ul { color: oklch(0.65 0 0); padding-left: 1.25rem; line-height: 1.8; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Desktop / Electron</span>
    <h1>Omninity Operator</h1>
    <p>
      This artifact contains the Electron desktop shell for Omninity Operator.
      It targets macOS (.dmg) and Windows (.exe) and cannot be previewed in a
      browser.
    </p>
    <p class="section-title">Build installers locally:</p>
    <code>pnpm --filter @workspace/omninity-desktop run build</code>
    <p class="section-title">Installer output:</p>
    <ul>
      <li>macOS: <code>dist/Omninity Operator-*.dmg</code></li>
      <li>Windows: <code>dist/Omninity Operator Setup *.exe</code></li>
    </ul>
    <br />
    <p class="section-title">Run in development (requires local display):</p>
    <code>pnpm --filter @workspace/omninity-desktop run dev</code>
  </div>
</body>
</html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(HTML);
});

server.on("error", (err) => {
  process.stderr.write(`[omninity-desktop] Server error: ${err.message}\n`);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`[omninity-desktop] Preview server listening on port ${PORT}\n`);
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`[omninity-desktop] Uncaught exception: ${err.message}\n${err.stack ?? ""}\n`);
  process.exit(1);
});
