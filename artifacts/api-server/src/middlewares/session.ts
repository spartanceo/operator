/**
 * express-session configuration.
 *
 * Session ids live in a signed cookie and are validated against the
 * `sessions` table on every request. Cookie flags follow Standard 12:
 *   - httpOnly: true
 *   - sameSite: "lax" (allows the same-origin renderer; rejects xsite)
 *   - secure: true in production (renderer + server share an https origin
 *     under the Replit proxy; HTTP only in local dev)
 *
 * The session secret comes from `SESSION_SECRET`. We refuse to start
 * without it in production — silent fallback to a random secret would
 * invalidate every cookie on every restart.
 */
import session from "express-session";
import type { RequestHandler } from "express";

function sessionSecret(): string {
  const fromEnv = process.env["SESSION_SECRET"];
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "SESSION_SECRET environment variable is required in production (>=16 chars).",
    );
  }
  // Dev-only deterministic fallback — explicitly NOT a secret.
  return "omninity-dev-session-secret-not-for-prod";
}

export function sessionMiddleware(): RequestHandler {
  const isProd = process.env["NODE_ENV"] === "production";
  return session({
    name: "omninity.sid",
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 12, // 12h, matches the DB session TTL
    },
  });
}
