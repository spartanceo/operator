/**
 * /api/skills — Skills Marketplace CRUD + install/import/export/invoke.
 *
 * Reads & writes are tenant-scoped through the service layer; this file
 * is a thin Zod-validated boundary around `skill.service`.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import { createAgentRun } from "../../services/agent.service";
import draftsRouter from "./drafts";
import {
  applySkillUpdate,
  createSkill,
  deleteSkill,
  dismissSkillUpdate,
  exportSkill,
  getAdoptionStats,
  getSkill,
  importSkill,
  installSkill,
  listSkills,
  listSkillsWithUpdates,
  listSkillVersions,
  publishSkillVersion,
  rollbackSkill,
  setAutoUpdate,
  SkillNotFoundError,
  SkillValidationError,
  uninstallSkill,
  updateSkill,
} from "../../services/skill.service";

const router: IRouter = Router();

// Mount the wizard sub-router FIRST so `/drafts/*` matches before
// `/:id`-style fall-through routes below.
router.use("/drafts", draftsRouter);

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  category: z.string().min(1).max(80).optional(),
  installed: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  search: z.string().min(1).max(200).optional(),
});

const StringArray = z.array(z.string().min(1).max(120)).max(50);

const CreateSchema = z.object({
  slug: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  content: z.string().min(1).max(64_000),
  modelTags: StringArray.optional(),
  triggers: StringArray.optional(),
  category: z.string().min(1).max(80).optional(),
  author: z.string().min(1).max(120).optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).optional(),
  content: z.string().min(1).max(64_000).optional(),
  modelTags: StringArray.optional(),
  triggers: StringArray.optional(),
  category: z.string().min(1).max(80).optional(),
});

const ManifestSchema = z.object({
  omninitySkillVersion: z.literal(1),
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000),
  content: z.string().min(1).max(64_000),
  modelTags: StringArray,
  triggers: StringArray,
  category: z.string().min(1).max(80),
  author: z.string().min(1).max(120),
  version: z.number().int().min(1).max(1_000_000),
  semver: z.string().max(40).optional(),
  changelog: z.string().max(8_000).optional(),
  breakingChange: z.boolean().optional(),
  minOpVersion: z.string().max(40).optional(),
});

const ImportSchema = z.object({
  manifest: ManifestSchema,
  install: z.boolean().optional(),
});

const InvokeSchema = z.object({
  goal: z.string().min(1).max(4_000),
  modelName: z.string().min(1).max(200).optional(),
});

const SemverSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/, "Must be a semantic version like 1.2.3");

const PublishSchema = z.object({
  version: SemverSchema,
  changelog: z.string().min(1).max(8_000),
  breakingChange: z.boolean().optional(),
  minOpVersion: SemverSchema.optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).optional(),
  content: z.string().min(1).max(64_000).optional(),
  modelTags: StringArray.optional(),
  triggers: StringArray.optional(),
  category: z.string().min(1).max(80).optional(),
});

const RollbackSchema = z.object({
  version: SemverSchema,
});

const ApplyUpdateSchema = z.object({
  acceptBreaking: z.boolean().optional(),
});

const AutoUpdateSchema = z.object({
  enabled: z.boolean(),
});

function handleSkillError(
  e: unknown,
  res: import("express").Response,
): boolean {
  if (e instanceof SkillNotFoundError) {
    res.status(404).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof SkillValidationError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  return false;
}

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listSkills(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid skill payload"));
      return;
    }
    const row = await createSkill(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/updates", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listSkillsWithUpdates(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post("/import", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ImportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid skill manifest"));
      return;
    }
    const opts = parsed.data.install !== undefined ? { install: parsed.data.install } : {};
    const row = await importSkill(ctx, parsed.data.manifest, opts);
    res.json(ok(row));
  } catch (e) {
    if (e instanceof SkillValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getSkill(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Skill not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid skill payload"));
      return;
    }
    const row = await updateSkill(ctx, String(req.params.id), parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (e instanceof SkillNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteSkill(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/install", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await installSkill(ctx, String(req.params.id));
    res.json(ok(row));
  } catch (e) {
    if (e instanceof SkillNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post("/:id/uninstall", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await uninstallSkill(ctx, String(req.params.id));
    res.json(ok(row));
  } catch (e) {
    if (e instanceof SkillNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

async function handleExport(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): Promise<void> {
  try {
    const ctx = requireTenantContext();
    const manifest = await exportSkill(ctx, String(req.params.id));
    res.json(ok(manifest));
  } catch (e) {
    if (e instanceof SkillNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
}

router.post("/:id/publish", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PublishSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid publish payload"));
      return;
    }
    const row = await publishSkillVersion(ctx, String(req.params.id), parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.get("/:id/versions", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listSkillVersions(ctx, String(req.params.id));
    res.json(ok({ items }));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.post("/:id/rollback", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RollbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid rollback payload"));
      return;
    }
    const row = await rollbackSkill(ctx, String(req.params.id), parsed.data.version);
    res.json(ok(row));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.post("/:id/apply-update", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ApplyUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid apply-update payload"));
      return;
    }
    const row = await applySkillUpdate(ctx, String(req.params.id), parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.post("/:id/dismiss-update", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await dismissSkillUpdate(ctx, String(req.params.id));
    res.json(ok(row));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.patch("/:id/auto-update", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = AutoUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid auto-update payload"));
      return;
    }
    const row = await setAutoUpdate(ctx, String(req.params.id), parsed.data.enabled);
    res.json(ok(row));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.get("/:id/adoption", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await getAdoptionStats(ctx, String(req.params.id));
    res.json(ok({ items }));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.get("/:id/export", requireTenant(), handleExport);
// Spec-mandated alternate path shape: GET /api/skills/export/:id
router.get("/export/:id", requireTenant(), handleExport);

router.post("/:id/invoke", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = InvokeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid invoke payload"));
      return;
    }
    const skill = await getSkill(ctx, String(req.params.id));
    if (!skill) {
      res.status(404).json(err("NOT_FOUND", "Skill not found"));
      return;
    }
    const run = await createAgentRun(ctx, {
      goal: parsed.data.goal,
      ...(parsed.data.modelName !== undefined ? { modelName: parsed.data.modelName } : {}),
      skillId: skill.id,
    });
    res.json(ok(run));
  } catch (e) {
    next(e);
  }
});

export default router;
