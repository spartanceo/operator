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

app.listen(port, host, (err) => {
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

  logger.info({ host, port }, "Server listening");
});
