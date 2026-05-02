/**
 * /api/mobile/devices — list, revoke, heartbeat, push subscription.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  getDevice,
  heartbeatDevice,
  listDevices,
  revokeDevice,
} from "../../services/mobile/pairing.service";
import { registerPushSubscription } from "../../services/mobile/push.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const PushSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  p256dh: z.string().min(1).max(512),
  auth: z.string().min(1).max(512),
});

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listDevices(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getDevice(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Device not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await revokeDevice(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/heartbeat", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await heartbeatDevice(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Device not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/push", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PushSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid push subscription payload"));
      return;
    }
    const sub = await registerPushSubscription(ctx, String(req.params.id), parsed.data);
    res.json(ok(sub));
  } catch (e) {
    next(e);
  }
});

export default router;
