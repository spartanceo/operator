/**
 * /api/custom-models — fine-tuned model + LoRA adapter registry (Task #47).
 *
 *   Custom models:
 *     GET    /                          — list imported GGUF models
 *     POST   /                          — register a new GGUF model from disk
 *     PATCH  /:id                       — enable / disable
 *     DELETE /:id                       — unregister
 *
 *   Adapters:
 *     GET    /adapters                  — list LoRA adapters
 *     POST   /adapters                  — register a new LoRA adapter
 *     GET    /adapters/:id/compatibility — base-model compatibility check
 *     PATCH  /adapters/:id              — enable / disable
 *     DELETE /adapters/:id              — unregister + clear assignments
 *
 *   Workspace adapter binding:
 *     GET    /assignments               — list workspace → adapter bindings
 *     PUT    /assignments               — set / clear an adapter for a model
 *
 *   Skill adapter declarations:
 *     GET    /skill-preferences         — list skill-slug → adapter mappings
 *     PUT    /skill-preferences         — upsert mapping
 *     DELETE /skill-preferences/:slug   — remove mapping
 *
 *   Enterprise distribution registry:
 *     GET    /enterprise                — list approved/pending fleet assets
 *     POST   /enterprise                — register a new asset for review
 *     POST   /enterprise/:id/approve    — admin approve
 *     POST   /enterprise/:id/reject     — admin reject (reason required)
 *     DELETE /enterprise/:id            — admin remove
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  CustomModelError,
  checkAdapterCompatibility,
  deleteCustomModel,
  deleteEnterpriseAsset,
  deleteLoraAdapter,
  deleteSkillAdapterPreference,
  importCustomModel,
  importLoraAdapter,
  listCustomModels,
  listEnterpriseAssets,
  listLoraAdapters,
  listSkillAdapterPreferences,
  listWorkspaceAdapterAssignments,
  registerEnterpriseAsset,
  setCustomModelStatus,
  setEnterpriseAssetStatus,
  setLoraAdapterStatus,
  setSkillAdapterPreference,
  setWorkspaceAdapterAssignment,
} from "../../services/custom-models.service";

const router: IRouter = Router();

const ImportModelSchema = z.object({
  name: z.string().min(1).max(128),
  filePath: z.string().min(1).max(2048),
  displayName: z.string().max(128).optional(),
  description: z.string().max(2000).optional(),
  architecture: z.string().max(64).optional(),
  parameterCount: z.string().max(32).optional(),
  quantization: z.string().max(32).optional(),
  importedBy: z.string().max(128).optional(),
  skipFingerprint: z.boolean().optional(),
});

const ImportAdapterSchema = z.object({
  name: z.string().min(1).max(128),
  filePath: z.string().min(1).max(2048),
  baseModel: z.string().min(1).max(128),
  displayName: z.string().max(128).optional(),
  description: z.string().max(2000).optional(),
  rank: z.number().int().min(0).max(4096).optional(),
  alpha: z.number().int().min(0).max(4096).optional(),
  importedBy: z.string().max(128).optional(),
  skipFingerprint: z.boolean().optional(),
});

const StatusPatchSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

const AssignmentSchema = z.object({
  baseModel: z.string().min(1).max(128),
  adapterId: z.string().min(1).max(128).nullable(),
});

const SkillPrefSchema = z.object({
  skillSlug: z.string().min(1).max(64),
  baseModel: z.string().max(128).optional(),
  adapterName: z.string().min(1).max(128),
});

const EnterpriseAssetSchema = z.object({
  kind: z.enum(["model", "adapter"]),
  name: z.string().min(1).max(128),
  displayName: z.string().max(128).optional(),
  description: z.string().max(2000).optional(),
  baseModel: z.string().max(128).optional(),
  sourcePath: z.string().min(1).max(2048),
  fileSize: z.number().int().min(0).optional(),
  sha256: z.string().max(128).optional(),
});

const RejectSchema = z.object({
  reason: z.string().min(1).max(2000),
});

function statusForCode(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "DUPLICATE_NAME":
      return 409;
    default:
      return 400;
  }
}

function handle(e: unknown, res: import("express").Response, next: import("express").NextFunction): void {
  if (e instanceof CustomModelError) {
    res.status(statusForCode(e.code)).json(err(e.code, e.message));
    return;
  }
  next(e);
}

// ─── Custom models ───────────────────────────────────────────────────────

router.get("/", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listCustomModels(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ImportModelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid model import payload"));
      return;
    }
    const row = await importCustomModel(ctx, parsed.data);
    res.status(201).json(ok(row));
  } catch (e) {
    handle(e, res, next);
  }
});

router.patch("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = StatusPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "status must be 'active' or 'disabled'"));
      return;
    }
    const row = await setCustomModelStatus(ctx, String(req.params["id"]), parsed.data.status);
    res.json(ok(row));
  } catch (e) {
    handle(e, res, next);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteCustomModel(ctx, String(req.params["id"]));
    res.json(ok(result));
  } catch (e) {
    handle(e, res, next);
  }
});

// ─── Adapters ────────────────────────────────────────────────────────────

router.get("/adapters", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const baseModel = typeof req.query["baseModel"] === "string"
      ? req.query["baseModel"]
      : undefined;
    const items = await listLoraAdapters(ctx, baseModel);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post("/adapters", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ImportAdapterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid adapter import payload"));
      return;
    }
    const row = await importLoraAdapter(ctx, parsed.data);
    res.status(201).json(ok(row));
  } catch (e) {
    handle(e, res, next);
  }
});

router.get("/adapters/:id/compatibility", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await checkAdapterCompatibility(ctx, String(req.params["id"]));
    res.json(ok(result));
  } catch (e) {
    handle(e, res, next);
  }
});

router.patch("/adapters/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = StatusPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "status must be 'active' or 'disabled'"));
      return;
    }
    const row = await setLoraAdapterStatus(ctx, String(req.params["id"]), parsed.data.status);
    res.json(ok(row));
  } catch (e) {
    handle(e, res, next);
  }
});

router.delete("/adapters/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteLoraAdapter(ctx, String(req.params["id"]));
    res.json(ok(result));
  } catch (e) {
    handle(e, res, next);
  }
});

// ─── Workspace assignments ───────────────────────────────────────────────

router.get("/assignments", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listWorkspaceAdapterAssignments(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.put("/assignments", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = AssignmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid assignment payload"));
      return;
    }
    const row = await setWorkspaceAdapterAssignment(
      ctx,
      parsed.data.baseModel,
      parsed.data.adapterId,
    );
    res.json(ok(row));
  } catch (e) {
    handle(e, res, next);
  }
});

// ─── Skill adapter preferences ───────────────────────────────────────────

router.get("/skill-preferences", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listSkillAdapterPreferences(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.put("/skill-preferences", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SkillPrefSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid skill preference payload"));
      return;
    }
    const row = await setSkillAdapterPreference(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    handle(e, res, next);
  }
});

router.delete("/skill-preferences/:slug", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteSkillAdapterPreference(ctx, String(req.params["slug"]));
    res.json(ok(result));
  } catch (e) {
    handle(e, res, next);
  }
});

// ─── Enterprise distribution ─────────────────────────────────────────────

router.get("/enterprise", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const statusRaw = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
    const status =
      statusRaw === "pending" || statusRaw === "approved" || statusRaw === "rejected" || statusRaw === "all"
        ? statusRaw
        : undefined;
    const items = await listEnterpriseAssets(ctx, { status });
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post("/enterprise", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = EnterpriseAssetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid enterprise asset payload"));
      return;
    }
    const row = await registerEnterpriseAsset(ctx, parsed.data);
    res.status(201).json(ok(row));
  } catch (e) {
    handle(e, res, next);
  }
});

router.post("/enterprise/:id/approve", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const reviewer = typeof req.headers["x-admin-actor"] === "string"
      ? (req.headers["x-admin-actor"] as string)
      : "enterprise_admin";
    const row = await setEnterpriseAssetStatus(
      ctx,
      String(req.params["id"]),
      "approved",
      reviewer,
    );
    res.json(ok(row));
  } catch (e) {
    handle(e, res, next);
  }
});

router.post("/enterprise/:id/reject", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RejectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "reason is required"));
      return;
    }
    const reviewer = typeof req.headers["x-admin-actor"] === "string"
      ? (req.headers["x-admin-actor"] as string)
      : "enterprise_admin";
    const row = await setEnterpriseAssetStatus(
      ctx,
      String(req.params["id"]),
      "rejected",
      reviewer,
      parsed.data.reason,
    );
    res.json(ok(row));
  } catch (e) {
    handle(e, res, next);
  }
});

router.delete("/enterprise/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteEnterpriseAsset(ctx, String(req.params["id"]));
    res.json(ok(result));
  } catch (e) {
    handle(e, res, next);
  }
});

export default router;
