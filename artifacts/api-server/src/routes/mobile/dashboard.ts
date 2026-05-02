/**
 * /api/mobile — dashboard (status, approvals, activity, quick tasks).
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  createQuickTask,
  getStatus,
  listActivity,
  listPendingApprovals,
  listQuickTasks,
} from "../../services/mobile/dashboard.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const QuickTaskSchema = z.object({
  body: z.string().min(1).max(4000),
  deviceId: z.string().min(1).max(200),
});

router.get("/status", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await getStatus(ctx)));
  } catch (e) {
    next(e);
  }
});

router.get("/approvals", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listPendingApprovals(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/activity", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const limit = req.query["limit"]
      ? Number(req.query["limit"])
      : undefined;
    res.json(ok(await listActivity(ctx, limit ? { limit } : {})));
  } catch (e) {
    next(e);
  }
});

router.get("/quick-tasks", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listQuickTasks(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/quick-tasks", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = QuickTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid task payload"));
      return;
    }
    res.json(ok(await createQuickTask(ctx, parsed.data)));
  } catch (e) {
    if (e instanceof Error && /not paired/i.test(e.message)) {
      res.status(400).json(err("DEVICE_INVALID", e.message));
      return;
    }
    next(e);
  }
});

export default router;
