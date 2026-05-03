/**
 * /api/diagnostics — local diagnostic surface area.
 *
 * Two complementary concern sets share this prefix:
 *
 *   Task #31 — Error Handling & Graceful Degradation:
 *     GET    /errors        recent error events recorded for this tenant
 *     DELETE /errors        clear the tenant's error log
 *     GET    /disk          free-space report + warning/critical thresholds
 *     GET    /catalog       full error-message catalog (UI uses this so it
 *                           never has to inline plain-English copy)
 *
 *   Task #40 — Structured Logging, Log Rotation & Local Diagnostics:
 *     GET    /logs            recent in-memory log records, filterable by
 *                             level, module, and since-timestamp
 *     GET    /domains         list of structured-log domains
 *     GET    /bundle/preview  manifest for the support bundle without
 *                             building it
 *     POST   /bundle          build + stream the ZIP bundle
 *     POST   /crash-report    opt-in remote crash reporter (no-op unless
 *                             OP_CRASH_REPORTING=1)
 *
 * The Task #40 endpoints are operator-local (no tenant required) — they
 * surface logs from the running OP instance for the user troubleshooting
 * their own setup. Cross-tenant audit lives in the Compliance-Grade Audit
 * Log task downstream.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { knownErrorCodes, getUserMessage } from "@workspace/errors";

import { err, ok } from "../../lib/api-envelope";
import {
  LOG_DOMAIN_NAMES,
  recentLogs,
  type LogRecord,
} from "../../lib/logging";
import {
  buildBundle,
  previewBundle,
  type BundleSources,
} from "../../lib/logging/bundle";
import { reportCrash } from "../../lib/logging/crash-reporter";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  clearErrorEvents,
  getDiskHealth,
  listErrorEvents,
} from "../../services/diagnostics.service";

function diagnosticsDiskPath(): string {
  return process.env["OMNINITY_DATA_DIR"] ?? process.cwd();
}

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Task #31 — error events, disk health, catalog
// ---------------------------------------------------------------------------

const ListSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

router.get("/errors", requireTenant(), (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("INVALID_INPUT", "Invalid query parameters"));
      return;
    }
    const items = listErrorEvents({
      tenantId: ctx.tenantId,
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    });
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.delete("/errors", requireTenant(), (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = clearErrorEvents(ctx.tenantId);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/disk", requireTenant(), async (_req, res, next) => {
  try {
    const report = await getDiskHealth(diagnosticsDiskPath());
    res.json(ok(report));
  } catch (e) {
    next(e);
  }
});

router.get("/catalog", (_req, res, next) => {
  try {
    const codes = knownErrorCodes();
    const entries = codes.map((code) => ({
      code,
      ...getUserMessage(code),
    }));
    res.json(ok({ items: entries }));
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Task #40 — structured logs, support bundle, crash reporter
// ---------------------------------------------------------------------------

const LEVEL_VALUES = ["debug", "info", "warn", "error", "fatal"] as const;

const LogQuerySchema = z.object({
  level: z.enum(LEVEL_VALUES).optional(),
  modules: z.string().max(500).optional(), // comma-separated
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

router.get("/logs", (req, res) => {
  const parsed = LogQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", "Invalid log query"));
    return;
  }
  const q = parsed.data;
  const records: LogRecord[] = recentLogs.query({
    level: q.level,
    modules: q.modules
      ? q.modules
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    since: q.since,
    limit: q.limit ?? 200,
  });
  res.json(
    ok({
      domains: LOG_DOMAIN_NAMES,
      total: recentLogs.length,
      records,
    }),
  );
});

router.get("/domains", (_req, res) => {
  res.json(ok({ domains: LOG_DOMAIN_NAMES }));
});

let _testSources: BundleSources | null = null;
/** Tests inject deterministic skill/model lists via this hook. */
export function _setBundleSources(s: BundleSources | null): void {
  _testSources = s;
}

router.get("/bundle/preview", async (_req, res, next) => {
  try {
    const manifest = await previewBundle(_testSources ?? {});
    res.json(ok(manifest));
  } catch (e) {
    next(e);
  }
});

router.post("/bundle", async (_req, res, next) => {
  try {
    const built = await buildBundle(_testSources ?? {});
    res.setHeader("content-type", "application/zip");
    res.setHeader(
      "content-disposition",
      `attachment; filename="${built.filename}"`,
    );
    res.setHeader("x-bundle-sha256-prefix", built.sha256Prefix);
    res.send(built.buffer);
  } catch (e) {
    next(e);
  }
});

const CrashSchema = z.object({
  context: z.record(z.string(), z.unknown()).optional(),
});

router.post("/crash-report", async (req, res, next) => {
  try {
    const parsed = CrashSchema.safeParse(req.body ?? {});
    const errorRecords = recentLogs.query({ level: "error", limit: 50 });
    const result = await reportCrash(
      errorRecords,
      parsed.success ? (parsed.data.context ?? {}) : {},
    );
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
