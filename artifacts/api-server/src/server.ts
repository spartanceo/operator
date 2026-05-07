/**
 * Embeddable server bootstrap — used by both the standalone process entry
 * (`index.ts`) and the Electron main process (`@workspace/omninity-desktop`).
 *
 * `startServer(port)` is the single function callers need:
 *   - Runs schema migrations (safe-mode on failure).
 *   - Binds Express to the given port and host.
 *   - Starts the task scheduler.
 *   - Triggers crash-detection and archive-purge side effects.
 *   - Returns a `ServerHandle` with `close()` for orderly shutdown.
 */
import type { Server } from "node:http";

import {
  getMigrationStatus,
  getRawSqlite,
  getSafeMode,
  runMigrations,
} from "@workspace/db";

import app from "./app";
import { bootstrapRuntimeSecret } from "./lib/bootstrap-secret";
import { logger } from "./lib/logger";
import { bindHost } from "./lib/security";
import {
  findInterruptedTasks,
  purgeArchivedCheckpoints,
} from "./services/crash-recovery.service";
import { startScheduler } from "./services/schedules.service";

export interface ServerHandle {
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

/**
 * Start the Express API server on `port`.
 *
 * Resolves once the server is accepting connections. Rejects if the port is
 * already in use or the server fails to bind.
 *
 * Always calls bootstrapRuntimeSecret() first so that both the standalone
 * process (index.ts) and the Electron main process (omninity-desktop/main.ts)
 * get the key injected before any routes register. This is safe to call
 * multiple times — subsequent calls exit immediately if a secret is already set.
 */
export async function startServer(port: number): Promise<ServerHandle> {
  await bootstrapRuntimeSecret();

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

  return new Promise<ServerHandle>((resolve, reject) => {
    let httpServer: Server;

    const onError = (err: Error) => {
      logger.error({ err }, "Error binding server port");
      reject(err);
    };

    httpServer = app.listen(port, host, () => {
        httpServer.removeListener("error", onError);

        if (getSafeMode().active) {
          logger.warn("Scheduler not started — booting in SAFE MODE");
        } else {
          startScheduler();
          logger.info("Scheduler started");
        }

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
          .catch((e: unknown) => {
            logger.error(
              { err: e instanceof Error ? e.message : String(e) },
              "Crash detection probe failed",
            );
          });

        purgeArchivedCheckpoints().catch((e: unknown) =>
          logger.warn(
            { err: e instanceof Error ? e.message : String(e) },
            "Checkpoint archive purge failed",
          ),
        );

        logger.info({ host, port }, "Server listening");

        resolve({
          port,
          host,
          close(): Promise<void> {
            return new Promise<void>((res) => {
              httpServer.close(() => res());
              setTimeout(() => res(), 5000).unref();
            });
          },
        });
      },
    );

    httpServer.once("error", onError);
  });
}
