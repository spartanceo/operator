/**
 * /api/security/telemetry — read + update telemetry consent toggles.
 *
 * Standard 12: every channel is OFF by default. The PUT body is partial —
 * any unspecified channel keeps its current value.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  getTelemetryConsent,
  updateTelemetryConsent,
} from "../../services/telemetry-consent.service";

const router: IRouter = Router();

const UpdateSchema = z.object({
  crashReportsEnabled: z.boolean().optional(),
  usageMetricsEnabled: z.boolean().optional(),
  productImprovementEnabled: z.boolean().optional(),
});

router.get("/telemetry", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await getTelemetryConsent(ctx)));
  } catch (e) {
    next(e);
  }
});

router.put("/telemetry", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid telemetry payload"));
      return;
    }
    res.json(ok(await updateTelemetryConsent(ctx, parsed.data)));
  } catch (e) {
    next(e);
  }
});

export default router;
