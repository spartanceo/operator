/**
 * /api/desktop — desktop control session API surface.
 *
 * Endpoints:
 *   GET    /feature                       — feature flag + adapter status.
 *   GET    /sessions                      — paginated session history.
 *   POST   /sessions                      — plan + (optionally) execute.
 *   GET    /sessions/:id                  — singleton session lookup.
 *   POST   /sessions/:id/stop             — halt a running session.
 *   GET    /sessions/:id/steps            — paginated steps audit.
 *   GET    /sessions/:id/screen           — latest captured frame.
 *   POST   /steps/:id/execute             — run a single step (LAV).
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  createSession,
  executeStep,
  getFeatureStatus,
  getLatestScreen,
  getSession,
  listSessions,
  listSteps,
  stopSession,
} from "../../services/desktop.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const CreateSessionSchema = z.object({
  goal: z.string().min(1).max(4000),
  modelName: z.string().min(1).max(200).optional(),
  autoExecute: z.boolean().optional(),
});

router.get("/feature", requireTenant(), async (_req, res, next) => {
  try {
    const status = getFeatureStatus();
    res.json(ok(status));
  } catch (e) {
    next(e);
  }
});

router.get("/sessions", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listSessions(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/sessions", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid desktop session payload"));
      return;
    }
    const session = await createSession(ctx, parsed.data);
    res.json(ok(session));
  } catch (e) {
    next(e);
  }
});

router.get("/sessions/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const session = await getSession(ctx, String(req.params.id));
    if (!session) {
      res.status(404).json(err("NOT_FOUND", "Desktop session not found"));
      return;
    }
    res.json(ok(session));
  } catch (e) {
    next(e);
  }
});

router.post("/sessions/:id/stop", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const session = await stopSession(ctx, String(req.params.id));
    if (!session) {
      res.status(404).json(err("NOT_FOUND", "Desktop session not found"));
      return;
    }
    res.json(ok(session));
  } catch (e) {
    next(e);
  }
});

router.get("/sessions/:id/steps", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listSteps(ctx, String(req.params.id), parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/sessions/:id/screen", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const session = await getSession(ctx, String(req.params.id));
    if (!session) {
      res.status(404).json(err("NOT_FOUND", "Desktop session not found"));
      return;
    }
    const frame = await getLatestScreen(ctx, session.id);
    res.json(ok(frame));
  } catch (e) {
    next(e);
  }
});

router.post("/steps/:id/execute", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const step = await executeStep(ctx, String(req.params.id));
    if (!step) {
      res.status(404).json(err("NOT_FOUND", "Desktop step not found"));
      return;
    }
    res.json(ok(step));
  } catch (e) {
    next(e);
  }
});

export default router;
