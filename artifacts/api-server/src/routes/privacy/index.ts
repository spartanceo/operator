/**
 * /api/privacy/events — audit log read + manual append.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  listPrivacyEvents,
  logPrivacyEvent,
} from "../../services/privacy.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const CreateSchema = z.object({
  eventType: z.string().min(1).max(120),
  actor: z.string().min(1).max(200),
  target: z.string().min(1).max(500),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  detail: z.string().max(4000).optional(),
});

router.get("/events", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listPrivacyEvents(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/events", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid privacy-event payload"));
      return;
    }
    const row = await logPrivacyEvent(ctx, parsed.data);
    if (!row) {
      res.status(500).json(err("PERSIST_FAILED", "Failed to record privacy event"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

export default router;
