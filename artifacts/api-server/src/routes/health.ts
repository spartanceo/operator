/**
 * Health probes — both `/healthz` (legacy) and `/api/health`.
 *
 * Returns the canonical envelope (Standard 1). Reports the running version
 * (from `npm_package_version` injected by pnpm at runtime, falling back to
 * `0.0.0` for dev) and the current server time so callers can detect clock
 * skew.
 *
 * This route is intentionally cheap — no DB hit. A deeper readiness probe
 * that pings the DB and Ollama lives in Task #36 (Resource Governor).
 */
import { Router, type IRouter } from "express";

import { ok } from "../lib/api-envelope";

const router: IRouter = Router();

function healthPayload() {
  return ok({
    status: "ok" as const,
    version: process.env["npm_package_version"] ?? "0.0.0",
    time: new Date().toISOString(),
  });
}

router.get("/healthz", (_req, res) => {
  res.json(healthPayload());
});

router.get("/health", (_req, res) => {
  res.json(healthPayload());
});

export default router;
