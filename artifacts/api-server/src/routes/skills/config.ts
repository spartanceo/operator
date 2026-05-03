/**
 * /api/skills/:id/config & /api/skills/config/import — per-workspace
 * configuration panel (Task #43).
 *
 * Thin Zod-validated boundary around `skill-config.service`. The
 * service layer owns every invariant (schema validation, vault
 * sealing, first-run gate); this file only translates HTTP semantics.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  bulkImportSkillConfig,
  ConfigSchemaError,
  ConfigValueError,
  getSkillConfig,
  resetSkillConfig,
  setSkillConfig,
  SkillNotConfiguredError,
  type BulkConfigTemplate,
} from "../../services/skill-config.service";

const router: IRouter = Router();

const ValueSchema = z.union([
  z.string().max(8_192),
  z.number(),
  z.boolean(),
  z.null(),
]);

const PutConfigSchema = z.object({
  values: z.record(z.string().min(1).max(64), ValueSchema),
  masterPassword: z.string().min(1).max(512).optional(),
});

const TemplateEntrySchema = z
  .object({
    slug: z.string().min(1).max(80).optional(),
    skillId: z.string().min(1).max(120).optional(),
    values: z.record(z.string().min(1).max(64), ValueSchema),
  })
  .refine((v) => Boolean(v.slug || v.skillId), {
    message: "Each entry needs a slug or skillId",
  });

const ImportTemplateSchema = z.object({
  template: z.object({
    omninityConfigTemplateVersion: z.literal(1),
    entries: z.array(TemplateEntrySchema).min(1).max(100),
  }),
  masterPassword: z.string().min(1).max(512).optional(),
});

function handleConfigError(
  e: unknown,
  res: import("express").Response,
): boolean {
  if (e instanceof SkillNotConfiguredError) {
    res
      .status(409)
      .json(
        err(
          "SKILL_NOT_CONFIGURED",
          e.message,
          { skillId: e.skillId, missingKeys: e.missingKeys },
        ),
      );
    return true;
  }
  if (e instanceof ConfigSchemaError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof ConfigValueError) {
    res
      .status(400)
      .json(
        err(
          e.code,
          e.message,
          e.fieldKey ? { fieldKey: e.fieldKey } : undefined,
        ),
      );
    return true;
  }
  return false;
}

router.get("/:id/config", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const status = await getSkillConfig(ctx, String(req.params.id));
    if (!status) {
      res.status(404).json(err("NOT_FOUND", "Skill not found"));
      return;
    }
    res.json(ok(status));
  } catch (e) {
    if (handleConfigError(e, res)) return;
    next(e);
  }
});

router.get("/:id/config/status", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const status = await getSkillConfig(ctx, String(req.params.id));
    if (!status) {
      res.status(404).json(err("NOT_FOUND", "Skill not found"));
      return;
    }
    res.json(
      ok({
        skillId: status.skillId,
        configured: status.configured,
        missingRequired: status.missingRequired,
        configuredAt: status.configuredAt,
      }),
    );
  } catch (e) {
    if (handleConfigError(e, res)) return;
    next(e);
  }
});

router.put("/:id/config", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PutConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid configuration payload"));
      return;
    }
    const input: Parameters<typeof setSkillConfig>[2] = {
      values: parsed.data.values,
    };
    if (parsed.data.masterPassword !== undefined) {
      input.masterPassword = parsed.data.masterPassword;
    }
    const status = await setSkillConfig(ctx, String(req.params.id), input);
    res.json(ok(status));
  } catch (e) {
    if (handleConfigError(e, res)) return;
    next(e);
  }
});

router.delete("/:id/config", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const status = await resetSkillConfig(ctx, String(req.params.id));
    res.json(ok(status));
  } catch (e) {
    if (handleConfigError(e, res)) return;
    next(e);
  }
});

router.post("/config/import", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ImportTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid configuration template"));
      return;
    }
    const result = await bulkImportSkillConfig(
      ctx,
      parsed.data.template as BulkConfigTemplate,
      parsed.data.masterPassword,
    );
    res.json(ok(result));
  } catch (e) {
    if (handleConfigError(e, res)) return;
    next(e);
  }
});

export default router;
