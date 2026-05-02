/**
 * /api/models — Ollama model lifecycle + hardware-aware recommendation.
 *
 * Three groups of routes share this router:
 *  - Lifecycle  (`GET /`, `POST /pull`, `GET /:name`)              — Task #16/#30
 *  - Recommendation (`GET /hardware`, `/catalogue`, `/recommended`) — Task #64
 *  - Selection  (`POST /select`)                                    — Task #64
 *
 * The hardware-aware routes are mounted BEFORE the catch-all `GET /:name`
 * because Express matches routes in declaration order — `/hardware` would
 * otherwise be swallowed by the `:name` param.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { paginated } from "@workspace/db";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  buildModelInstallPlan,
  evaluateMinimumSpec,
  getEffectiveModelPreferences,
  getHardwareProfile,
  MODEL_CATALOGUE,
  UnknownModelError,
  upsertModelPreferences,
} from "../../services/hardware";
import { getModel, listModels, pullModel } from "../../services/ollama.service";

const router: IRouter = Router();

const PullSchema = z.object({ name: z.string().min(1).max(200) });

const SelectSchema = z.object({
  primaryModel: z.string().min(1).max(200),
  visionLifecycleMode: z
    .enum(["aggressive", "balanced", "warm"])
    .optional(),
  visionIdleTimeoutMs: z.number().int().min(0).max(86_400_000).optional(),
});

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

// ─── Hardware-aware recommendation (Task #64) ────────────────────────────

router.get("/hardware", requireTenant(), async (_req, res, next) => {
  try {
    const hardware = getHardwareProfile();
    const plan = buildModelInstallPlan(hardware);
    const minimumSpec = evaluateMinimumSpec(hardware);
    res.json(ok({ hardware, plan, minimumSpec }));
  } catch (e) {
    next(e);
  }
});

router.get("/catalogue", requireTenant(), async (_req, res, next) => {
  try {
    res.json(ok({ items: MODEL_CATALOGUE }));
  } catch (e) {
    next(e);
  }
});

router.get("/recommended", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const hardware = getHardwareProfile();
    const plan = buildModelInstallPlan(hardware);
    const minimumSpec = evaluateMinimumSpec(hardware);
    const preferences = await getEffectiveModelPreferences(ctx);
    res.json(ok({ hardware, plan, minimumSpec, preferences }));
  } catch (e) {
    next(e);
  }
});

router.post("/select", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SelectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid model selection payload"));
      return;
    }
    const nextInput = parsed.data;
    try {
      const preferences = await upsertModelPreferences(ctx, {
        primaryModel: nextInput.primaryModel,
        catalogueChoiceMade: true,
        ...(nextInput.visionLifecycleMode
          ? { visionLifecycleMode: nextInput.visionLifecycleMode }
          : {}),
        ...(nextInput.visionIdleTimeoutMs !== undefined
          ? { visionIdleTimeoutMs: nextInput.visionIdleTimeoutMs }
          : {}),
      });
      res.json(ok(preferences));
    } catch (e) {
      // Only the typed UnknownModelError maps to 400. Any DB / runtime
      // failure must bubble to the global error handler so the operator
      // sees a 5xx + structured log instead of a silent 400.
      if (e instanceof UnknownModelError) {
        res.status(400).json(err(e.code, e.message));
        return;
      }
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

// ─── Catch-all by name — declared LAST so the static paths win ───────────

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
