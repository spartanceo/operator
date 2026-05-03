/**
 * /api/plugins — Developer SDK plugin tool registry (Task #14).
 *
 * Custom tools registered here appear in the unified tool catalogue
 * exposed by the agent loop and are subject to the same approval gate
 * as built-in tools.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  PluginToolInvokeError,
  PluginToolNotFoundError,
  PluginToolValidationError,
  deletePluginTool,
  getPluginTool,
  invokePluginTool,
  listPluginTools,
  registerPluginTool,
  updatePluginTool,
} from "../../services/plugin-tools.service";

const router: IRouter = Router();

const RiskLevel = z.enum(["low", "medium", "high", "critical"]);
const SchemaObject = z.record(z.unknown());

const RegisterSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(2_000).optional(),
  riskLevel: RiskLevel.optional(),
  inputSchema: SchemaObject.optional(),
  invokeUrl: z.string().min(1).max(2_048),
  authToken: z.string().max(512).optional(),
});

const UpdateSchema = z.object({
  description: z.string().max(2_000).optional(),
  riskLevel: RiskLevel.optional(),
  inputSchema: SchemaObject.optional(),
  invokeUrl: z.string().min(1).max(2_048).optional(),
  authToken: z.string().max(512).nullable().optional(),
  enabled: z.boolean().optional(),
});

const InvokeSchema = z.object({
  input: z.record(z.unknown()),
});

function handleError(e: unknown, res: import("express").Response): boolean {
  if (e instanceof PluginToolValidationError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof PluginToolNotFoundError) {
    res.status(404).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof PluginToolInvokeError) {
    res.status(502).json(err(e.code, e.message));
    return true;
  }
  return false;
}

router.get("/tools", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listPluginTools(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post("/tools", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid plugin tool payload"));
      return;
    }
    const row = await registerPluginTool(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.get("/tools/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getPluginTool(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("PLUGIN_TOOL_NOT_FOUND", `Unknown plugin tool ${req.params.id}`));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.patch("/tools/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid plugin tool patch"));
      return;
    }
    const row = await updatePluginTool(ctx, String(req.params.id), parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.delete("/tools/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deletePluginTool(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/tools/:id/invoke", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = InvokeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid invoke payload"));
      return;
    }
    const result = await invokePluginTool(ctx, String(req.params.id), parsed.data.input);
    res.json(ok(result));
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

export default router;
