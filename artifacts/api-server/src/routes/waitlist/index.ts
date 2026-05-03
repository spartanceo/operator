/**
 * /api/waitlist — public marketing-site email capture.
 *
 * The POST endpoint is intentionally unauthenticated — public marketing
 * visitors don't have a tenant. Admin reads (GET /) require tenant
 * context so an operator user can see signups for their feature areas.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  createWaitlistSignup,
  listWaitlistSignups,
  listWaitlistStats,
  WaitlistValidationError,
} from "../../services/waitlist.service";

const router: IRouter = Router();

const CreateSchema = z.object({
  feature: z.string().min(1).max(80),
  email: z.string().email().max(200),
  name: z.string().min(1).max(120).optional(),
  source: z.string().min(1).max(120).optional(),
  referralCode: z.string().min(1).max(120).optional(),
});

router.post("/", async (req, res, next) => {
  try {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid waitlist signup"));
      return;
    }
    const result = await createWaitlistSignup(parsed.data);
    res.json(ok(result));
  } catch (e) {
    if (e instanceof WaitlistValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.get("/stats", async (_req, res, next) => {
  try {
    const stats = await listWaitlistStats();
    res.json(ok({ stats }));
  } catch (e) {
    next(e);
  }
});

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const cursor =
      typeof req.query["cursor"] === "string" ? req.query["cursor"] : undefined;
    const limit =
      typeof req.query["limit"] === "string"
        ? Number(req.query["limit"])
        : undefined;
    const feature =
      typeof req.query["feature"] === "string"
        ? req.query["feature"]
        : undefined;
    const page = await listWaitlistSignups(ctx, { cursor, limit, feature });
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

export default router;
