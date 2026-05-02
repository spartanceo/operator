/**
 * Express app composition.
 *
 * Middleware order (each layer is in this order for a reason):
 *   1. helmet            — security headers BEFORE any handler runs.
 *   2. cors              — explicit allowlist; never `*` (Standard 12).
 *   3. requestId         — assign trace id used by every later log line.
 *   4. pinoHttp          — structured request log with the trace id bound.
 *   5. defaultLimiter    — coarse rate limit before parsing.
 *   6. body parsers      — bounded sizes; reject oversize payloads early.
 *   7. session           — express-session (cookie + memory store).
 *   8. tenantContext     — populate AsyncLocalStorage from headers.
 *   9. /api router       — application routes.
 *  10. notFoundHandler   — final 404 in canonical envelope.
 *  11. errorHandler      — catch-all error in canonical envelope.
 */
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";

import { logger } from "./lib/logger";
import { allowedOrigins, cspDirectives } from "./lib/security";
import {
  defaultLimiter,
  errorHandler,
  notFoundHandler,
  requestId,
  safeModeGuard,
  tenantContext,
} from "./middlewares";
import { sessionMiddleware } from "./middlewares/session";
import router from "./routes";

const app: Express = express();

app.set("trust proxy", 1);

// 1. Security headers + locked-down CSP.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: cspDirectives(),
    },
    crossOriginEmbedderPolicy: false,
  }),
);

// 2. CORS allowlist — Standard 12 forbids `*` / `true`.
const origins = allowedOrigins();
app.use(
  cors({
    origin: (incoming, cb) => {
      // Same-origin (no Origin header) is always allowed.
      if (!incoming) {
        cb(null, true);
        return;
      }
      cb(null, origins.includes(incoming));
    },
    credentials: true,
  }),
);

// 3 + 4. Request id then structured logging — id is bound on res.locals
// so the pino serializer can pick it up.
app.use(requestId());
app.use(
  pinoHttp({
    logger,
    customProps: (_req, res) => ({
      requestId: res.locals["requestId"],
    }),
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// 5. Coarse rate limit — auth + LLM routes layer their own limits later.
app.use(defaultLimiter);

// 6. Body parsers with explicit size caps (Standard 12 — bounded inputs).
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// 7. Session cookie — must run before any auth-bearing route reads it.
app.use(sessionMiddleware());

// 8. Populate AsyncLocalStorage tenant context from headers.
app.use(tenantContext());

// 8b. Safe-mode guard — when migrations have failed, reject any
//     mutating request with 503 + SAFE_MODE error so the user can still
//     read data and back things up.
app.use(safeModeGuard());

// 9. Application routes.
app.use("/api", router);

// 10 + 11. 404 + error envelope.
app.use(notFoundHandler());
app.use(errorHandler());

export default app;
