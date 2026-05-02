/**
 * /api/diagnostics — local diagnostic surface area for Task #31
 * (Error Handling & Graceful Degradation).
 *
 * Routes:
 *   GET    /errors        recent error events recorded for this tenant
 *   DELETE /errors        clear the tenant's error log
 *   GET    /disk          free-space report + warning/critical thresholds
 *   GET    /catalog       full error-message catalog (UI uses this so it
 *                         never has to inline plain-English copy)
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { knownErrorCodes, getUserMessage } from "@workspace/errors";

import { err, ok } from "../../lib/api-envelope";
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

export default router;
