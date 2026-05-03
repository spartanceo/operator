/**
 * /api/privacy/residency — real-time data residency signal.
 *
 * Returned shape feeds the website's Privacy Meter directly. The residency
 * value reflects the *currently active runtime* for this tenant (not just
 * the install default), so switching from Ollama to OpenAI immediately
 * flips the meter from "Local" to "Cloud-required".
 */
import { Router, type IRouter } from "express";

import { ok } from "../../lib/api-envelope";
import { listConfirmedRuntimeIds } from "../../lib/cloud-session";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import { getActiveRuntimeInfo } from "../../services/runtime.service";

const router: IRouter = Router();

router.get("/residency", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const info = await getActiveRuntimeInfo(ctx, listConfirmedRuntimeIds(req));
    res.json(
      ok({
        runtimeId: info.activeRuntimeId,
        residency: info.residency,
        cloudConfirmedThisSession: info.cloudConfirmedThisSession,
        confirmedRuntimeIds: info.confirmedRuntimeIds,
        detectedRuntimeIds: info.detectedRuntimeIds,
      }),
    );
  } catch (e) {
    next(e);
  }
});

export default router;
