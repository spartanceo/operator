/**
 * Final error handler — every uncaught error is converted to the canonical
 * `{ success: false, error: { code, message } }` envelope (Standard 1).
 *
 * Internal error details are NOT returned to the client per Standard 12
 * (`Forbidden Patterns → Secret leakage`). The full error is logged with
 * the request context; the client gets a stable `code` and a safe `message`
 * sourced from the @workspace/errors catalog (Step 6 of Task #31).
 *
 * Every captured error is also recorded in the diagnostics ring buffer so
 * the help-panel "Diagnostics" tab can show recent failures, and so the
 * persistent-error escalator can promote repeat failures to the
 * notification centre.
 */
import type { ErrorRequestHandler, RequestHandler } from "express";

import { toApiError } from "@workspace/errors";

import { err } from "../lib/api-envelope";
import { getTenantContext } from "../lib/tenant-context";
import { logger } from "../lib/logger";
import { recordErrorEvent } from "../services/diagnostics.service";

export function errorHandler(): ErrorRequestHandler {
  return function errorHandlerMiddleware(error, req, res, _next) {
    const triple = toApiError(error);
    const ctx = getTenantContext();
    const requestId = (res.locals["requestId"] as string | undefined) ?? null;
    const path = req.url.split("?")[0] ?? null;

    logger.error(
      {
        err: triple.cause,
        requestId,
        method: req.method,
        url: path,
        status: triple.status,
        code: triple.code,
        details: triple.details,
      },
      "Request failed",
    );

    try {
      recordErrorEvent({
        code: triple.code,
        httpStatus: triple.status,
        tenantId: ctx?.tenantId ?? null,
        requestId,
        path,
        method: req.method,
        cause: triple.cause,
      });
    } catch (recordErr) {
      // Diagnostics MUST never become a new failure source.
      logger.warn({ err: recordErr }, "Diagnostic recording failed");
    }

    const payload = triple.details
      ? err(triple.code, triple.message, triple.details)
      : err(triple.code, triple.message);

    res.status(triple.status).json(payload);
  };
}

/**
 * 404 handler — terminal middleware that returns the canonical envelope
 * for any path the router didn't match.
 *
 * MUST be a 3-arg `RequestHandler` (not 4-arg `ErrorRequestHandler`):
 * Express treats any middleware with arity 4 as an *error* middleware
 * and only invokes it when an error has been forwarded. Registering
 * this as an error handler caused thrown route errors to incorrectly
 * surface as 404s instead of being delegated to `errorHandler` below it.
 */
export function notFoundHandler(): RequestHandler {
  return function notFoundMiddleware(req, res, _next) {
    const ctx = getTenantContext();
    const requestId = (res.locals["requestId"] as string | undefined) ?? null;
    const path = req.url.split("?")[0] ?? null;
    try {
      recordErrorEvent({
        code: "NOT_FOUND",
        httpStatus: 404,
        tenantId: ctx?.tenantId ?? null,
        requestId,
        path,
        method: req.method,
        cause: new Error(`No route matches ${req.method} ${path ?? ""}`),
      });
    } catch (recordErr) {
      logger.warn({ err: recordErr }, "Diagnostic recording failed");
    }
    res
      .status(404)
      .json(err("NOT_FOUND", `No route matches ${req.method} ${path}`));
  };
}
