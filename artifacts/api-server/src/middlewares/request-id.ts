/**
 * Request-ID middleware.
 *
 * Honours a client-supplied `X-Request-ID` header so a trace can flow
 * across hops; otherwise mints a fresh nanoid. Echoes the value back on
 * the response so callers can correlate logs end-to-end.
 *
 * Stored on `res.locals.requestId` for later middleware (tenant context,
 * error handler) and exposed to Pino via the per-request log binding
 * configured in `../app.ts`.
 */
import type { NextFunction, Request, Response } from "express";
import { nanoid } from "nanoid";

const HEADER = "x-request-id";

export function requestId() {
  return function requestIdMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const incoming = req.header(HEADER);
    const id = incoming && incoming.length > 0 ? incoming : nanoid(21);
    res.locals["requestId"] = id;
    res.setHeader("X-Request-ID", id);
    next();
  };
}
