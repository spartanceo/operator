/**
 * /api/mobile/notifications — per-workspace push notification preferences.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  getNotificationPrefs,
  setNotificationPrefs,
} from "../../services/mobile/push.service";

const router: IRouter = Router();

const PrefsSchema = z.object({
  taskCompleted: z.boolean().optional(),
  approvalNeeded: z.boolean().optional(),
  taskFailed: z.boolean().optional(),
  longTaskProgress: z.boolean().optional(),
});

router.get("/prefs", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await getNotificationPrefs(ctx)));
  } catch (e) {
    next(e);
  }
});

router.post("/prefs", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PrefsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid preferences payload"));
      return;
    }
    res.json(ok(await setNotificationPrefs(ctx, parsed.data)));
  } catch (e) {
    next(e);
  }
});

export default router;
