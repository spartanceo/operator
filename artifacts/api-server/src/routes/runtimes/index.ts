/**
 * /api/runtimes — model runtime registry surface.
 *
 *   GET    /                       — list runtimes (descriptor + health)
 *   GET    /active                 — active selection + residency signal
 *   POST   /active                 — hot-switch active runtime
 *   GET    /:id/models             — paginated model list for the runtime
 *   POST   /:id/credentials        — set encrypted API key (cloud only)
 *   DELETE /:id/credentials        — remove API key
 *   POST   /:id/confirm-session    — per-session cloud opt-in
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { paginated } from "@workspace/db";

import { err, ok } from "../../lib/api-envelope";
import {
  isRuntimeCloudConfirmed,
  listConfirmedRuntimeIds,
  setRuntimeCloudConfirmed,
} from "../../lib/cloud-session";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import { RuntimeKeySecretMissingError } from "../../services/runtime/credentials";
import { getRuntime } from "../../services/runtime/registry";
import {
  deleteRuntimeCredential,
  getActiveRuntimeInfo,
  listRuntimeModels,
  listRuntimesWithHealth,
  setActiveRuntime,
  setRuntimeCredential,
} from "../../services/runtime.service";

const router: IRouter = Router();

const SetActiveSchema = z.object({
  runtimeId: z.string().min(1).max(60),
  defaultModel: z.string().max(200).nullable().optional(),
});

const SetCredentialSchema = z.object({
  apiKey: z.string().min(8).max(2000),
  label: z.string().max(200).nullable().optional(),
});

const ConfirmSessionSchema = z.object({
  confirmed: z.boolean(),
});

router.get("/", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listRuntimesWithHealth(ctx);
    res.json(ok(paginated(items, null)));
  } catch (e) {
    next(e);
  }
});

router.get("/active", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const info = await getActiveRuntimeInfo(ctx, listConfirmedRuntimeIds(req));
    res.json(ok(info));
  } catch (e) {
    next(e);
  }
});

router.post("/active", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SetActiveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid runtime selection payload"));
      return;
    }
    const adapter = getRuntime(parsed.data.runtimeId);
    if (!adapter) {
      res.status(404).json(err("NOT_FOUND", `Unknown runtime "${parsed.data.runtimeId}"`));
      return;
    }
    const result = await setActiveRuntime(
      ctx,
      parsed.data.runtimeId,
      parsed.data.defaultModel ?? null,
    );
    res.json(
      ok({
        activeRuntimeId: result.activeRuntimeId,
        defaultModel: result.defaultModel,
        residency: adapter.residency,
        cloudConfirmedThisSession: isRuntimeCloudConfirmed(req, parsed.data.runtimeId),
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.get("/:id/models", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = String(req.params.id);
    if (!getRuntime(id)) {
      res.status(404).json(err("NOT_FOUND", `Unknown runtime "${id}"`));
      return;
    }
    const models = await listRuntimeModels(ctx, id);
    res.json(ok(paginated(models, null)));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/credentials", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = String(req.params.id);
    const adapter = getRuntime(id);
    if (!adapter) {
      res.status(404).json(err("NOT_FOUND", `Unknown runtime "${id}"`));
      return;
    }
    if (!adapter.requiresApiKey) {
      res.status(400).json(err("VALIDATION", `Runtime "${id}" does not accept API keys`));
      return;
    }
    const parsed = SetCredentialSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid credential payload"));
      return;
    }
    const result = await setRuntimeCredential(
      ctx,
      id,
      parsed.data.apiKey,
      parsed.data.label ?? null,
    );
    res.json(ok(result));
  } catch (e) {
    if (e instanceof RuntimeKeySecretMissingError) {
      res.status(503).json(err("RUNTIME_KEY_SECRET_MISSING",
        "Omninity is still initialising encryption — wait a moment and try again."));
      return;
    }
    next(e);
  }
});

router.delete("/:id/credentials", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = String(req.params.id);
    const adapter = getRuntime(id);
    if (!adapter) {
      res.status(404).json(err("NOT_FOUND", `Unknown runtime "${id}"`));
      return;
    }
    const result = await deleteRuntimeCredential(ctx, id);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/confirm-session", requireTenant(), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const adapter = getRuntime(id);
    if (!adapter) {
      res.status(404).json(err("NOT_FOUND", `Unknown runtime "${id}"`));
      return;
    }
    if (adapter.residency === "local") {
      res
        .status(400)
        .json(err("VALIDATION", `Runtime "${id}" is local — no session confirmation needed`));
      return;
    }
    const parsed = ConfirmSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid confirmation payload"));
      return;
    }
    // Per-runtime confirmation — confirming OpenAI does NOT implicitly
    // authorise Anthropic. The Privacy Meter and chat preflight both
    // read this set, so the consent boundary stays user-visible.
    setRuntimeCloudConfirmed(req, id, parsed.data.confirmed);
    res.json(
      ok({
        runtimeId: id,
        residency: adapter.residency,
        cloudConfirmedThisSession: parsed.data.confirmed,
        confirmedRuntimeIds: listConfirmedRuntimeIds(req),
      }),
    );
  } catch (e) {
    next(e);
  }
});

export default router;
