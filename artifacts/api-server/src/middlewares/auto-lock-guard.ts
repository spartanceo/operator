/**
 * Auto-lock guard middleware.
 *
 * Evaluates the tenant's inactivity policy on every request through a
 * protected route. If the inactivity window has elapsed since the last
 * `recordActivity()` ping, the request is rejected with 401 LOCKED so
 * the client redirects the user to the master-password unlock screen.
 *
 * The middleware is opt-in — apply it only to routes that read or
 * mutate sensitive data (vault, security report, data nuke). Public
 * routes (health, version) bypass it.
 */
import type { NextFunction, Request, Response } from "express";

import { err } from "../lib/api-envelope";
import { getTenantContext } from "../lib/tenant-context";
import { evaluateLock } from "../services/auto-lock.service";

export function autoLockGuard() {
  return async function autoLockGuardMiddleware(
    _req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const ctx = getTenantContext();
    if (!ctx) {
      next();
      return;
    }
    try {
      const state = await evaluateLock(ctx);
      if (state.locked) {
        res.status(401).json(err("LOCKED", "Session is locked due to inactivity"));
        return;
      }
      next();
    } catch (e) {
      // Auto-lock failures must not lock users out of their own data —
      // log via the central error handler but pass through.
      next(e);
    }
  };
}
