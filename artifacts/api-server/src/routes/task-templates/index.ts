/**
 * /api/task-templates — Task Templates & Reusable Workflows (Task #46).
 *
 * Endpoints:
 *   GET    /                             — list templates (paginated, search/filter).
 *   POST   /                             — create a template (often "save this run").
 *   GET    /pinned                       — quick-launch row (max 5).
 *   GET    /categories                   — list categories.
 *   POST   /categories                   — create a category.
 *   DELETE /categories/:id               — delete a category (templates detach).
 *   GET    /:id                          — fetch one template.
 *   PATCH  /:id                          — edit name/prompt/variables/etc.
 *   DELETE /:id                          — delete a template.
 *   POST   /:id/run                      — substitute variables, bump usage.
 *   POST   /:id/pin                      — pin / unpin (quick-launch).
 *   GET    /:id/export                   — export as portable file.
 *   POST   /import                       — import a previously-exported file.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  TemplateConflictError,
  createCategory,
  createTemplate,
  deleteCategory,
  deleteTemplate,
  exportTemplate,
  getTemplate,
  importTemplate,
  listCategories,
  listPinnedTemplates,
  listTemplates,
  runTemplate,
  setPinned,
  updateTemplate,
} from "../../services/task-templates.service";

const router: IRouter = Router();

const VariableSchema = z.object({
  name: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  defaultValue: z.string().max(2000).optional(),
  required: z.boolean().optional(),
});

const SkillConfigSchema = z
  .object({
    agentMode: z.boolean().optional(),
    model: z.string().max(200).optional(),
    conversationId: z.string().nullable().optional(),
  })
  .passthrough();

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  prompt: z.string().min(1).max(20_000),
  variables: z.array(VariableSchema).max(32).optional(),
  skillConfig: SkillConfigSchema.optional(),
  categoryId: z.string().min(1).max(120).nullable().optional(),
  sourceRunId: z.string().min(1).max(200).nullable().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  prompt: z.string().min(1).max(20_000).optional(),
  variables: z.array(VariableSchema).max(32).optional(),
  skillConfig: SkillConfigSchema.optional(),
  categoryId: z.string().min(1).max(120).nullable().optional(),
});

const RunSchema = z.object({
  values: z.record(z.string(), z.string().max(4000)).optional(),
});

const PinSchema = z.object({ pinned: z.boolean() });

const CategoryCreateSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().max(40).nullable().optional(),
  icon: z.string().max(40).nullable().optional(),
});

const ImportSchema = z.object({
  template: z.unknown(),
  name: z.string().min(1).max(120).optional(),
});

const ListQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  categoryId: z.string().min(1).max(120).optional(),
  pinnedOnly: z
    .union([z.literal("true"), z.literal("1"), z.literal("false"), z.literal("0")])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  q: z.string().min(1).max(200).optional(),
});

function mapConflictStatus(code: TemplateConflictError["code"]): number {
  switch (code) {
    case "INVALID_TEMPLATE":
    case "INVALID_NAME":
      return 400;
    case "MISSING_VARIABLE":
      return 422;
    case "PIN_LIMIT_REACHED":
      return 409;
    case "CATEGORY_NOT_FOUND":
      return 404;
    default:
      return 409;
  }
}

function handleConflict(e: unknown, res: Parameters<Parameters<IRouter["post"]>[1]>[1]): boolean {
  if (e instanceof TemplateConflictError) {
    res.status(mapConflictStatus(e.code)).json(err(e.code, e.message));
    return true;
  }
  return false;
}

// ── Categories ────────────────────────────────────────────────────────────

router.get("/categories", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listCategories(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post("/categories", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CategoryCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid category payload"));
      return;
    }
    const row = await createCategory(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleConflict(e, res)) return;
    next(e);
  }
});

router.delete("/categories/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteCategory(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// ── Pinned (quick-launch) ─────────────────────────────────────────────────

router.get("/pinned", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listPinnedTemplates(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

// ── Import (must precede /:id) ────────────────────────────────────────────

router.post("/import", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ImportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid import payload"));
      return;
    }
    const created = await importTemplate(ctx, parsed.data.template, {
      name: parsed.data.name,
    });
    res.json(ok(created));
  } catch (e) {
    if (handleConflict(e, res)) return;
    next(e);
  }
});

// ── Templates ─────────────────────────────────────────────────────────────

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid list params"));
      return;
    }
    const page = await listTemplates(ctx, parsed.data);
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
      res.status(400).json(err("VALIDATION", "Invalid template payload"));
      return;
    }
    const row = await createTemplate(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleConflict(e, res)) return;
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getTemplate(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Template not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.patch("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid template patch"));
      return;
    }
    const row = await updateTemplate(ctx, String(req.params.id), parsed.data);
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Template not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    if (handleConflict(e, res)) return;
    next(e);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteTemplate(ctx, String(req.params.id));
    if (!result.deleted) {
      res.status(404).json(err("NOT_FOUND", "Template not found"));
      return;
    }
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/run", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RunSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid run payload"));
      return;
    }
    const result = await runTemplate(
      ctx,
      String(req.params.id),
      parsed.data.values ?? {},
    );
    if (!result) {
      res.status(404).json(err("NOT_FOUND", "Template not found"));
      return;
    }
    res.json(ok(result));
  } catch (e) {
    if (handleConflict(e, res)) return;
    next(e);
  }
});

router.post("/:id/pin", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PinSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pin payload"));
      return;
    }
    const row = await setPinned(ctx, String(req.params.id), parsed.data.pinned);
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Template not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    if (handleConflict(e, res)) return;
    next(e);
  }
});

router.get("/:id/export", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const exportPayload = await exportTemplate(ctx, String(req.params.id));
    if (!exportPayload) {
      res.status(404).json(err("NOT_FOUND", "Template not found"));
      return;
    }
    res.json(ok(exportPayload));
  } catch (e) {
    next(e);
  }
});

export default router;
