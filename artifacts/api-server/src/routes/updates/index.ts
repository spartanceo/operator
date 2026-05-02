/**
 * /api/updates — desktop application update channel.
 *
 * Read-only and tenant-scoped (so an unauthenticated curl can't probe the
 * release surface). The check returns a deterministic envelope even when
 * no `OMNINITY_LATEST_VERSION` env var is configured — in that case
 * `updateAvailable=false` and the chat header simply omits the banner.
 */
import { Router, type IRouter } from "express";

import { ok } from "../../lib/api-envelope";
import { requireTenant } from "../../middlewares/tenant-context";
import { checkForUpdates } from "../../services/updates.service";

const router: IRouter = Router();

router.get("/check", requireTenant(), async (_req, res, next) => {
  try {
    const result = checkForUpdates();
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
