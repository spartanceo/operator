/**
 * /api/browser — Tier 1 stubs for screenshot + extract.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import { extract, screenshot } from "../../services/browser.service";

const router: IRouter = Router();

const ScreenshotSchema = z.object({
  url: z.string().url(),
  viewport: z.string().min(1).max(80).optional(),
});

const ExtractSchema = z.object({
  url: z.string().url(),
  selector: z.string().min(1).max(500),
});

router.post("/screenshot", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ScreenshotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid screenshot payload"));
      return;
    }
    const result = await screenshot(ctx, parsed.data.url, parsed.data.viewport);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/extract", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ExtractSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid extract payload"));
      return;
    }
    const result = await extract(ctx, parsed.data.url, parsed.data.selector);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
