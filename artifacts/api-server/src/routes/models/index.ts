/**
 * /api/models — Ollama model lifecycle.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { paginated } from "@workspace/db";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import { getModel, listModels, pullModel } from "../../services/ollama.service";

const router: IRouter = Router();

const PullSchema = z.object({ name: z.string().min(1).max(200) });

router.get("/", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const models = await listModels(ctx);
    // Tier 1: Ollama returns the full set in one shot — no real cursor yet.
    res.json(ok(paginated(models, null)));
  } catch (e) {
    next(e);
  }
});

router.post("/pull", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PullSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pull payload"));
      return;
    }
    const receipt = await pullModel(ctx, parsed.data.name);
    res.json(ok(receipt));
  } catch (e) {
    next(e);
  }
});

router.get("/:name", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const name = String(req.params.name);
    const model = await getModel(ctx, name);
    if (!model) {
      res.status(404).json(err("NOT_FOUND", `Model "${name}" not found`));
      return;
    }
    res.json(ok(model));
  } catch (e) {
    next(e);
  }
});

export default router;
