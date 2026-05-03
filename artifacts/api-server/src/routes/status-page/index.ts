/**
 * /api/status-page — public service status snapshot for the in-app status
 * indicator (Task #34).
 *
 * Reads are unauthenticated — the snapshot is platform-wide and contains
 * only marketing-safe data (component health, active incident headlines).
 * Writes are OP-team paths protected by network placement.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import {
  createIncident,
  getPublicStatus,
  StatusValidationError,
  updateComponentStatus,
  updateIncident,
} from "../../services/status-page.service";

const router: IRouter = Router();

const ComponentSchema = z.object({
  status: z.string().min(1).max(40),
  message: z.string().max(2000).optional(),
});

const IncidentCreateSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(8000).optional(),
  severity: z.enum(["none", "minor", "major", "critical"]).optional(),
  affectedComponents: z.array(z.string().max(80)).optional(),
});

const IncidentUpdateSchema = z.object({
  status: z.enum(["investigating", "identified", "monitoring", "resolved"]).optional(),
  body: z.string().max(8000).optional(),
  severity: z.enum(["none", "minor", "major", "critical"]).optional(),
});

function handleErr(e: unknown, res: import("express").Response): boolean {
  if (e instanceof StatusValidationError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  return false;
}

router.get("/", async (_req, res, next) => {
  try {
    const snapshot = await getPublicStatus();
    res.json(ok(snapshot));
  } catch (e) {
    next(e);
  }
});

router.put("/components/:key", async (req, res, next) => {
  try {
    const parsed = ComponentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid component payload"));
      return;
    }
    const component = await updateComponentStatus({
      componentKey: String(req.params["key"]),
      ...parsed.data,
    });
    res.json(ok({ component }));
  } catch (e) {
    if (handleErr(e, res)) return;
    next(e);
  }
});

router.post("/incidents", async (req, res, next) => {
  try {
    const parsed = IncidentCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid incident payload"));
      return;
    }
    const incident = await createIncident(parsed.data);
    res.json(ok({ incident }));
  } catch (e) {
    if (handleErr(e, res)) return;
    next(e);
  }
});

router.post("/incidents/:id", async (req, res, next) => {
  try {
    const parsed = IncidentUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid incident payload"));
      return;
    }
    const incident = await updateIncident({
      id: String(req.params["id"]),
      ...parsed.data,
    });
    res.json(ok({ incident }));
  } catch (e) {
    if (handleErr(e, res)) return;
    next(e);
  }
});

export default router;
