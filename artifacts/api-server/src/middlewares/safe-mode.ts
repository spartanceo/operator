/**
 * Safe-mode middleware.
 *
 * When schema migrations fail at startup, `runMigrations({ safeMode: true })`
 * sets a process-wide flag in `@workspace/db` and the API server boots
 * anyway so the user can inspect their data. This middleware enforces the
 * "read-only" half of safe mode: any mutating request (POST/PUT/PATCH/DELETE)
 * gets a 503 with a SAFE_MODE error code; reads pass through unchanged.
 *
 * Health and admin diagnostics endpoints stay reachable so the user can
 * see the failure surface and decide what to do next.
 */
import type { NextFunction, Request, Response } from "express";

import { getSafeMode } from "@workspace/db";

// tier-review: bounded — fixed 3-element constant set, never written to.
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function safeModeGuard() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const state = getSafeMode();
    if (!state.active) {
      next();
      return;
    }
    if (READ_METHODS.has(req.method)) {
      next();
      return;
    }
    res.status(503).json({
      success: false,
      error: {
        code: "SAFE_MODE",
        message: "Database is in safe (read-only) mode after a migration failure. Restore from backup or downgrade the app to write again.",
        detail: {
          reason: state.reason,
          failedMigrationId: state.failedMigrationId,
          failedAt: state.failedAt,
        },
      },
    });
  };
}
