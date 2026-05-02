/**
 * Final error handler — every uncaught error is converted to the canonical
 * `{ success: false, error: { code, message } }` envelope (Standard 1).
 *
 * Internal error details are NOT returned to the client per Standard 12
 * (`Forbidden Patterns → Secret leakage`). The full error is logged with
 * the request context; the client gets a stable `code` and a safe `message`.
 */
import type { ErrorRequestHandler, RequestHandler } from "express";

import { err } from "../lib/api-envelope";
import { logger } from "../lib/logger";

interface AppError {
  code?: string;
  status?: number;
  statusCode?: number;
  expose?: boolean;
  message?: string;
}

export function errorHandler(): ErrorRequestHandler {
  return function errorHandlerMiddleware(error, req, res, _next) {
    const e = (error ?? {}) as AppError;
    const status = e.status ?? e.statusCode ?? 500;
    const code = e.code ?? (status === 404 ? "NOT_FOUND" : "INTERNAL");
    const safeMessage =
      e.expose && e.message ? e.message : status >= 500 ? "Internal server error" : e.message ?? "Bad request";

    logger.error(
      {
        err: error,
        requestId: res.locals["requestId"],
        method: req.method,
        url: req.url.split("?")[0],
        status,
      },
      "Request failed",
    );

    res.status(status).json(err(code, safeMessage));
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
    res
      .status(404)
      .json(err("NOT_FOUND", `No route matches ${req.method} ${req.url.split("?")[0]}`));
  };
}
