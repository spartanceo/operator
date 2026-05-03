/**
 * /api/events — Developer SDK event stream (Task #14).
 *
 * Polling endpoint over the in-process event bus. Returns the most
 * recent events for the calling tenant, optionally filtered by type
 * and afterId so SDK / CLI clients can implement long-polling.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { getRecentEvents } from "../../lib/event-bus";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";

const router: IRouter = Router();

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  afterId: z.string().min(1).max(120).optional(),
  type: z.string().min(1).max(80).optional(),
});

router.get("/recent", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid event query"));
      return;
    }
    const items = getRecentEvents(ctx, {
      limit: parsed.data.limit,
      afterId: parsed.data.afterId,
      // Cast — service rejects unknown types by returning [].
      type: parsed.data.type as never,
    });
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

export default router;
