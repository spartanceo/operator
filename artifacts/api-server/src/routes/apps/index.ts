/**
 * /api/apps — Universal App Understanding & Capability Indexer (Task #70).
 *
 * Endpoints:
 *   GET    /apps/feature              — feature flag + cache stats.
 *   GET    /apps                      — paginated app profiles.
 *   GET    /apps/:id                  — singleton profile lookup.
 *   GET    /apps/:id/commands         — paginated capability commands.
 *   POST   /apps/scan                 — re-scan installed apps (idempotent).
 *   POST   /apps/:id/deep-learn       — queue documentation ingestion.
 *   POST   /apps/:id/mcp/connect      — connect MCP server.
 *   POST   /apps/:id/mcp/disconnect   — disconnect MCP server.
 *   POST   /apps/:id/install-skill    — bind a community App Skill.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  AppNotFoundError,
  connectMcp,
  disconnectMcp,
  getFeatureStatus,
  getProfile,
  getProfileByAppId,
  installAppSkill,
  listCommands,
  listProfiles,
  scanInstalledApps,
  startDeepLearn,
} from "../../services/app-capability.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const CommandsPageSchema = PageSchema.extend({
  kind: z.enum(["command", "menu", "shortcut", "mcp_tool", "skill_action"]).optional(),
});

const DeepLearnSchema = z.object({
  rootUrl: z.string().url().max(2048).optional(),
});

const McpConnectSchema = z.object({
  endpoint: z.string().url().max(2048).optional(),
});

const InstallSkillSchema = z.object({
  skillId: z.string().min(1).max(200),
});

router.get("/feature", requireTenant(), async (_req, res, next) => {
  try {
    res.json(ok(getFeatureStatus()));
  } catch (e) {
    next(e);
  }
});

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listProfiles(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/scan", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const profiles = await scanInstalledApps(ctx);
    res.json(ok({ profiles, scanned: profiles.length }));
  } catch (e) {
    next(e);
  }
});

router.get("/by-app-id/:appId", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const profile = await getProfileByAppId(ctx, String(req.params.appId));
    if (!profile) {
      res.status(404).json(err("NOT_FOUND", "App profile not found"));
      return;
    }
    res.json(ok(profile));
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const profile = await getProfile(ctx, String(req.params.id));
    if (!profile) {
      res.status(404).json(err("NOT_FOUND", "App profile not found"));
      return;
    }
    res.json(ok(profile));
  } catch (e) {
    next(e);
  }
});

router.get("/:id/commands", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CommandsPageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid commands query"));
      return;
    }
    const page = await listCommands(ctx, String(req.params.id), parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/deep-learn", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = DeepLearnSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid deep-learn payload"));
      return;
    }
    const job = await startDeepLearn(
      ctx,
      String(req.params.id),
      parsed.data.rootUrl,
    );
    res.json(ok(job));
  } catch (e) {
    if (e instanceof AppNotFoundError) {
      res.status(404).json(err("NOT_FOUND", "App profile not found"));
      return;
    }
    next(e);
  }
});

router.post("/:id/mcp/connect", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = McpConnectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid MCP connect payload"));
      return;
    }
    const conn = await connectMcp(
      ctx,
      String(req.params.id),
      parsed.data.endpoint,
    );
    res.json(ok(conn));
  } catch (e) {
    if (e instanceof AppNotFoundError) {
      res.status(404).json(err("NOT_FOUND", "App profile not found"));
      return;
    }
    if (e instanceof Error && e.message.includes("MCP endpoint")) {
      res.status(400).json(err("MCP_ENDPOINT_MISSING", e.message));
      return;
    }
    next(e);
  }
});

router.post("/:id/mcp/disconnect", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const conn = await disconnectMcp(ctx, String(req.params.id));
    if (!conn) {
      res.status(404).json(err("NOT_FOUND", "No active MCP connection"));
      return;
    }
    res.json(ok(conn));
  } catch (e) {
    if (e instanceof AppNotFoundError) {
      res.status(404).json(err("NOT_FOUND", "App profile not found"));
      return;
    }
    next(e);
  }
});

router.post("/:id/install-skill", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = InstallSkillSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid install-skill payload"));
      return;
    }
    const profile = await installAppSkill(
      ctx,
      String(req.params.id),
      parsed.data.skillId,
    );
    res.json(ok(profile));
  } catch (e) {
    if (e instanceof AppNotFoundError) {
      res.status(404).json(err("NOT_FOUND", "App profile not found"));
      return;
    }
    if (e instanceof Error && e.message.includes("Skill")) {
      res.status(404).json(err("SKILL_NOT_FOUND", e.message));
      return;
    }
    next(e);
  }
});

export default router;
