/**
 * Server entrypoint — standalone process launcher.
 *
 * Reads PORT from the environment, delegates all startup logic to
 * `startServer()` (which is also called by the Electron main process), and
 * wires the POSIX signal handlers for graceful shutdown.
 *
 * Before starting the server we call bootstrapRuntimeSecret() to ensure
 * RUNTIME_KEY_SECRET is always set on local desktop installs. The function
 * generates a fresh key on first launch, persists it to ~/.omninity/.runtime-key,
 * and loads it on all subsequent starts — so users never need to configure it.
 */
import { getSafeMode } from "@workspace/db";

import { bootstrapRuntimeSecret } from "./lib/bootstrap-secret";
import { logger } from "./lib/logger";
import {
  pauseRunningTasksForShutdown,
  recordCleanShutdown,
} from "./services/crash-recovery.service";
import { startServer } from "./server";
import type { ServerHandle } from "./server";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

let handle: ServerHandle | null = null;

// Task #58 — Clean shutdown handler. Pauses any running queue rows then
// writes a clean_shutdown_log row before exiting. The next process to
// boot sees the row and will not flag those tasks as crashed.
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown initiated");
  try {
    const pausedIds = await pauseRunningTasksForShutdown(`shutdown:${signal}`);
    const reason: "user_quit" | "system_restart" | "normal" =
      signal === "SIGINT"
        ? "user_quit"
        : signal === "SIGTERM"
          ? "system_restart"
          : "normal";
    await recordCleanShutdown({ reason, pausedTaskIds: pausedIds });
    logger.info(
      { pausedCount: pausedIds.length, reason },
      "Clean shutdown record written",
    );
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e.message : String(e) },
      "Clean shutdown handler failed — next launch may flag tasks as crashed",
    );
  } finally {
    if (handle) {
      await handle.close();
    }
    setTimeout(() => process.exit(0), 5000).unref();
    process.exit(0);
  }
}

process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));

bootstrapRuntimeSecret()
  .then(() => startServer(port))
  .then((h) => {
    handle = h;
    if (getSafeMode().active) {
      logger.warn("Running in SAFE MODE — mutating requests blocked");
    }
  })
  .catch((err: unknown) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Server failed to start",
    );
    process.exit(1);
  });
