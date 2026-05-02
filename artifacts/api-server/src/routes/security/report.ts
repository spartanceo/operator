/**
 * /api/security/report — 30-day rolling security summary.
 */
import { Router, type IRouter } from "express";

import { ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import { generateSecurityReport } from "../../services/security-report.service";

const router: IRouter = Router();

router.get("/report", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await generateSecurityReport(ctx)));
  } catch (e) {
    next(e);
  }
});

export default router;
