/**
 * Server entrypoint.
 *
 * Binds to the host returned by `bindHost()` — `127.0.0.1` by default per
 * Standard 12. The Replit preview proxy reaches the artifact via loopback
 * inside the same container, so `127.0.0.1` is correct in dev and prod.
 *
 * On startup we apply versioned schema migrations against the SQLite database
 * `@workspace/db` resolves to (env-var override or `./data/omninity.db`).
 * `runMigrations({ safeMode: true })` returns a result envelope: on failure
 * it sets the global safe-mode flag and we boot anyway — the safe-mode
 * middleware will reject mutating requests so the user can inspect data,
 * back it up, or downgrade the app version.
 */
import {
  getMigrationStatus,
  getRawSqlite,
  getSafeMode,
  runMigrations,
} from "@workspace/db";

import app from "./app";
import { logger } from "./lib/logger";
import { bindHost } from "./lib/security";
import {
  findInterruptedTasks,
  pauseRunningTasksForShutdown,
  purgeArchivedCheckpoints,
  recordCleanShutdown,
} from "./services/crash-recovery.service";
import { startScheduler } from "./services/schedules.service";

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

const host = bindHost();

const sqlite = getRawSqlite();
const migrationResult = runMigrations(sqlite, { safeMode: true });
const status = getMigrationStatus(sqlite);

if (migrationResult.success) {
  logger.info(
    {
      applied: migrationResult.applied,
      skipped: migrationResult.skipped,
      currentVersion: status.currentVersion,
      latestVersion: status.latestVersion,
    },
    "Database migrations applied",
  );
} else {
  const safe = getSafeMode();
  logger.error(
    {
      failure: migrationResult.failure,
      currentVersion: status.currentVersion,
      latestVersion: status.latestVersion,
      safeMode: safe,
    },
    "Database migration failed — booting in SAFE MODE (read-only). Mutating requests will return 503.",
  );
}

const server = app.listen(port, host, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  // Boot the scheduled-tasks engine (Task #45). The interval is unref'd
  // so it never holds the process open during graceful shutdown.
  if (getSafeMode().active) {
    logger.warn("Scheduler not started — booting in SAFE MODE");
  } else {
    startScheduler();
    logger.info("Scheduler started");
  }

  // Task #58 — Crash detection on startup. Anything still in `running`
  // whose updatedAt comes after the last clean-shutdown row was either
  // crashed or paused at shutdown. We only LOG here; the recovery
  // prompt is delivered via the /api/recovery/interrupted endpoint that
  // the desktop UI hits before showing the main interface.
  findInterruptedTasks()
    .then((interrupted) => {
      if (interrupted.length === 0) return;
      logger.warn(
        {
          count: interrupted.length,
          taskIds: interrupted.map((i) => i.taskId),
        },
        "Crash detection: interrupted tasks found from previous session — surfaced via /api/recovery",
      );
    })
    .catch((e) => {
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        "Crash detection probe failed",
      );
    });

  // Best-effort archive purge (30 day retention).
  purgeArchivedCheckpoints().catch((e) =>
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "Checkpoint archive purge failed",
    ),
  );

  logger.info({ host, port }, "Server listening");
});

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
    server.close(() => process.exit(0));
    // Hard cap: if Express doesn't drain in 5s, exit anyway so the OS
    // sees a clean exit code rather than killing us with SIGKILL.
    setTimeout(() => process.exit(0), 5000).unref();
  }
}

process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
