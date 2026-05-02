/**
 * /api/security/auto-lock — inactivity policy + heartbeat + unlock.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  configureAutoLock,
  getAutoLockState,
  recordActivity,
  unlock,
} from "../../services/auto-lock.service";

const router: IRouter = Router();

const ConfigureSchema = z.object({
  inactivityMinutes: z.coerce.number().int().min(1).max(480).optional(),
  requireBiometric: z.boolean().optional(),
});

router.get("/auto-lock", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await getAutoLockState(ctx)));
  } catch (e) {
    next(e);
  }
});

router.post("/auto-lock", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ConfigureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid auto-lock payload"));
      return;
    }
    res.json(ok(await configureAutoLock(ctx, parsed.data)));
  } catch (e) {
    next(e);
  }
});

router.post("/auto-lock/heartbeat", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await recordActivity(ctx)));
  } catch (e) {
    next(e);
  }
});

router.post("/auto-lock/unlock", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await unlock(ctx)));
  } catch (e) {
    next(e);
  }
});

export default router;
