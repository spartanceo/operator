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
import { isFeatureEnabled } from "../../lib/feature-flags";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  buildModelInstallPlan,
  clearHardwareCache,
  evaluateMinimumSpec,
  getDefaultVision,
  getEffectiveModelPreferences,
  getHardwareProfile,
  getInstallState,
  getSelectableModelEntry,
  getVisionLifecycle,
  MODEL_CATALOGUE,
  OLLAMA_LIBRARY,
  startInstall,
  timeoutForMode,
  UnknownModelError,
  upsertModelPreferences,
  type InstallPlanItem,
  type InstallState,
} from "../../services/hardware";
import { getModel, listModels, pullModel } from "../../services/ollama.service";

const router: IRouter = Router();

/**
 * Express middleware: 404 on the hardware-aware recommendation routes when
 * the `feature.hardware_aware_recommendation` flag is off. Returning a
 * structured FEATURE_DISABLED envelope (rather than a generic 404) lets
 * the wizard distinguish "feature off" from "endpoint typo" and fall back
 * to the legacy /api/onboarding/hardware path cleanly.
 */
function requireHardwareAwareFlag(
  _req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  if (!isFeatureEnabled("feature.hardware_aware_recommendation")) {
    res
      .status(404)
      .json(
        err(
          "FEATURE_DISABLED",
          "feature.hardware_aware_recommendation is disabled on this host",
        ),
      );
    return;
  }
  next();
}

const PullSchema = z.object({ name: z.string().min(1).max(200) });

const SelectSchema = z.object({
  primaryModel: z.string().min(1).max(200),
  visionLifecycleMode: z
    .enum(["aggressive", "balanced", "warm"])
    .optional(),
  visionIdleTimeoutMs: z.number().int().min(0).max(86_400_000).optional(),
});

const InstallSchema = z.object({
  primaryModel: z.string().min(1).max(200),
  // Default true — the product invariant is "every install includes the
  // bundled vision". Tests and power-user flows can opt out explicitly.
  includeVision: z.boolean().optional().default(true),
});

function serialiseInstallState(state: InstallState) {
  return {
    status: state.status,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    models: state.models.map((m) => ({
      modelId: m.modelId,
      role: m.role,
      status: m.status,
      percent: m.percent,
      error: m.error,
    })),
  };
}

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
//
// All four routes below are gated behind `feature.hardware_aware_recommendation`.
// When the flag is off they return 404 FEATURE_DISABLED so the wizard can
// fall back to the legacy /api/onboarding/hardware path.

router.get(
  "/hardware",
  requireHardwareAwareFlag,
  requireTenant(),
  async (_req, res, next) => {
    try {
      const hardware = getHardwareProfile();
      const plan = buildModelInstallPlan(hardware);
      const minimumSpec = evaluateMinimumSpec(hardware);
      res.json(ok({ hardware, plan, minimumSpec }));
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/hardware/redetect",
  requireHardwareAwareFlag,
  requireTenant(),
  async (_req, res, next) => {
    try {
      // Drop the cached snapshot (in-memory + on-disk) and probe again.
      // Same response shape as GET /models/hardware so the Settings UI
      // can swap the rendered hardware/plan without a follow-up request.
      clearHardwareCache();
      const hardware = getHardwareProfile();
      const plan = buildModelInstallPlan(hardware);
      const minimumSpec = evaluateMinimumSpec(hardware);
      res.json(ok({ hardware, plan, minimumSpec }));
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/catalogue",
  requireHardwareAwareFlag,
  requireTenant(),
  async (_req, res, next) => {
    try {
      // `items` is the curated recommendation set (drives the engine).
      // `library` is the broader Ollama library exposed to power users
      // who want to step outside the curated set — these entries are
      // NOT auto-recommended; they only appear in the "Power user: see
      // all models" disclosure with a fit annotation computed by the
      // frontend against the detected hardware (Task #64 "Done looks
      // like": power-user mode exposes the full Ollama library).
      res.json(ok({ items: MODEL_CATALOGUE, library: OLLAMA_LIBRARY }));
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/recommended",
  requireHardwareAwareFlag,
  requireTenant(),
  async (_req, res, next) => {
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
  },
);

router.post(
  "/select",
  requireHardwareAwareFlag,
  requireTenant(),
  async (req, res, next) => {
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
      // Apply the persisted preference to the live VisionLifecycle
      // controller so the new idle-timeout takes effect immediately —
      // without this, the toggle in Settings would only influence the
      // *next* process start. The actual ollama load/unload bridge ships
      // in Task #30; the controller already owns the timer + state
      // machine, so reconfiguring here is the wiring contract this task
      // owes the runtime layer.
      const lifecycle = getVisionLifecycle(getHardwareProfile().tier);
      lifecycle.configure({
        visionModelId: preferences.visionLifecycle.visionModelId,
        mode: preferences.visionLifecycle.mode,
        idleTimeoutMs:
          preferences.visionLifecycle.idleTimeoutMs ||
          timeoutForMode(preferences.visionLifecycle.mode),
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

// ─── Install orchestration (Task #64 "one-click install") ────────────────
//
// `POST /install` kicks off (or returns the existing) install run for the
// selected primary + the bundled vision companion. The request returns
// 202 + the current state envelope; the wizard then polls
// `GET /install/status` until the run reaches a terminal status. The
// orchestrator runs the actual `ollama pull` calls in the background so
// the HTTP request never holds open the multi-minute pull stream.

router.post(
  "/install",
  requireHardwareAwareFlag,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = InstallSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json(err("VALIDATION", "Invalid install payload"));
        return;
      }
      const primary = await getSelectableModelEntry(parsed.data.primaryModel);
      if (!primary) {
        res
          .status(400)
          .json(
            err("INVALID_MODEL", `Unknown primary model "${parsed.data.primaryModel}"`),
          );
        return;
      }
      const items: InstallPlanItem[] = [
        { modelId: primary.id, role: "primary" },
      ];
      if (parsed.data.includeVision) {
        const vision = getDefaultVision();
        if (vision) {
          items.push({ modelId: vision.id, role: "vision" });
        }
      }
      const state = startInstall(ctx, items);
      res.status(202).json(ok(serialiseInstallState(state)));
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/install/status",
  requireHardwareAwareFlag,
  requireTenant(),
  async (_req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const state = getInstallState(ctx);
      if (!state) {
        // No install ever started for this tenant — return an empty
        // envelope so the frontend can distinguish "never started" from
        // a terminal state without a separate 404 round trip.
        res.json(
          ok({
            status: "idle" as const,
            startedAt: null,
            completedAt: null,
            models: [],
          }),
        );
        return;
      }
      res.json(ok(serialiseInstallState(state)));
    } catch (e) {
      next(e);
    }
  },
);

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
