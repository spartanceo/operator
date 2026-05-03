/**
 * /api/workspaces — Task #42 workspace switcher backend.
 *
 * Reads / writes flow through `workspaces.service` so route handlers stay
 * thin envelope-translation layers. Every route is tenant-scoped via the
 * standard `requireTenant()` middleware.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  WorkspaceConflictError,
  createWorkspace,
  deleteWorkspace,
  exportWorkspaceTemplate,
  getWorkspace,
  getWorkspaceOverview,
  importWorkspaceTemplate,
  listWorkspaces,
  touchLastActive,
  updateWorkspace,
} from "../../services/workspaces.service";

const router: IRouter = Router();

const NameSchema = z.string().min(1).max(80);
const DescSchema = z.string().max(500).nullable().optional();
const ColorSchema = z.string().min(1).max(40).nullable().optional();
const IconSchema = z.string().min(1).max(40).nullable().optional();

const CreateSchema = z.object({
  name: NameSchema,
  description: z.string().max(500).optional(),
  color: z.string().min(1).max(40).optional(),
  icon: z.string().min(1).max(40).optional(),
  isDefault: z.boolean().optional(),
});

const UpdateSchema = z.object({
  name: NameSchema.optional(),
  description: DescSchema,
  color: ColorSchema,
  icon: IconSchema,
  isDefault: z.boolean().optional(),
});

const ImportSchema = z.object({
  template: z.unknown(),
  name: z.string().min(1).max(80).optional(),
});

const DeleteQuerySchema = z.object({
  confirm: z
    .union([z.literal("true"), z.literal("1")])
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

function mapConflictStatus(code: WorkspaceConflictError["code"]): number {
  switch (code) {
    case "INVALID_TEMPLATE":
    case "DUPLICATE_NAME":
      return 400;
    case "SYSTEM_WORKSPACE":
      return 403;
    default:
      return 409;
  }
}

router.get("/", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listWorkspaces(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid workspace payload"));
      return;
    }
    const row = await createWorkspace(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (e instanceof WorkspaceConflictError) {
      res.status(mapConflictStatus(e.code)).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getWorkspace(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Workspace not found"));
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
      res.status(400).json(err("VALIDATION", "Invalid workspace patch"));
      return;
    }
    const row = await updateWorkspace(ctx, String(req.params.id), parsed.data);
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Workspace not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    if (e instanceof WorkspaceConflictError) {
      res.status(mapConflictStatus(e.code)).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsedQuery = DeleteQuerySchema.safeParse(req.query);
    const confirm = parsedQuery.success && parsedQuery.data.confirm === true;
    if (!confirm) {
      res
        .status(400)
        .json(
          err(
            "CONFIRMATION_REQUIRED",
            "Pass ?confirm=true to delete this workspace and lose its data",
          ),
        );
      return;
    }
    const result = await deleteWorkspace(ctx, String(req.params.id));
    if (!result.deleted) {
      res.status(404).json(err("NOT_FOUND", "Workspace not found"));
      return;
    }
    res.json(ok(result));
  } catch (e) {
    if (e instanceof WorkspaceConflictError) {
      res.status(mapConflictStatus(e.code)).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post("/:id/activate", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await touchLastActive(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Workspace not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/:id/overview", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const overview = await getWorkspaceOverview(ctx, String(req.params.id));
    if (!overview) {
      res.status(404).json(err("NOT_FOUND", "Workspace not found"));
      return;
    }
    res.json(ok(overview));
  } catch (e) {
    next(e);
  }
});

router.get("/:id/export", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const template = await exportWorkspaceTemplate(ctx, String(req.params.id));
    if (!template) {
      res.status(404).json(err("NOT_FOUND", "Workspace not found"));
      return;
    }
    res.json(ok(template));
  } catch (e) {
    next(e);
  }
});

router.post("/import", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ImportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid import payload"));
      return;
    }
    const created = await importWorkspaceTemplate(ctx, parsed.data.template, {
      name: parsed.data.name,
    });
    res.json(ok(created));
  } catch (e) {
    if (e instanceof WorkspaceConflictError) {
      res.status(mapConflictStatus(e.code)).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

export default router;
