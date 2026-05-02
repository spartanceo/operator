/**
 * /api/tools — tool catalogue + direct invocation.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  invokeTool,
  listTools,
  ToolNotFoundError,
  ToolValidationError,
} from "../../services/tools.service";

const router: IRouter = Router();

const InvokeSchema = z.object({
  input: z.record(z.unknown()),
});

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listTools(parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/:name/invoke", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = InvokeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid invoke payload"));
      return;
    }
    const result = await invokeTool(ctx, String(req.params.name), parsed.data.input);
    res.json(ok(result));
  } catch (e) {
    if (e instanceof ToolNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    if (e instanceof ToolValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

export default router;
