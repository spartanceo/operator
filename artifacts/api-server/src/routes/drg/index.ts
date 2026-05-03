/**
 * /api/drg — Dynamic Resource Governor surface (Task #36).
 *
 *   GET  /status                  — full state (config + memory + phase + throttle)
 *   GET  /memory                  — live memory probe
 *   PUT  /config                  — update ceiling / unload-idle / mode override
 *   POST /throttle/acknowledge    — clear a pending throttle event
 *   POST /throttle/trigger        — test/diagnostic hook (gated by env)
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  acknowledgeThrottle,
  getDrgState,
  InvalidCeilingError,
  snapshotMemory,
  tickMemoryMonitor,
  triggerThrottle,
  updateDrgConfig,
} from "../../services/drg.service";

const router: IRouter = Router();

const UpdateConfigSchema = z.object({
  ceilingBytes: z.number().int().positive().optional(),
  unloadIdleMs: z.number().int().min(0).optional(),
  modeOverride: z.enum(["sequential", "hybrid", "parallel"]).nullable().optional(),
});

router.get("/status", requireTenant(), async (_req, res, next) => {
  try {
    res.json(ok(getDrgState()));
  } catch (e) {
    next(e);
  }
});

router.get("/memory", requireTenant(), async (_req, res, next) => {
  try {
    // Tick the monitor on read so a probe also auto-raises throttle when
    // the system is under pressure — the menu-bar refresher exercises this.
    tickMemoryMonitor();
    res.json(ok(snapshotMemory()));
  } catch (e) {
    next(e);
  }
});

router.put("/config", requireTenant(), async (req, res, next) => {
  try {
    const parsed = UpdateConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid DRG config payload"));
      return;
    }
    const next_ = updateDrgConfig(parsed.data);
    res.json(ok(next_));
  } catch (e) {
    if (e instanceof InvalidCeilingError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post("/throttle/acknowledge", requireTenant(), async (_req, res, next) => {
  try {
    const cleared = acknowledgeThrottle();
    res.json(ok({ cleared }));
  } catch (e) {
    next(e);
  }
});

const TriggerSchema = z.object({ reason: z.string().min(1).max(500) });

router.post("/throttle/trigger", requireTenant(), async (req, res, next) => {
  try {
    if (process.env["NODE_ENV"] === "production") {
      res.status(403).json(err("FORBIDDEN", "Throttle trigger is dev-only"));
      return;
    }
    const parsed = TriggerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid throttle payload"));
      return;
    }
    res.json(ok(triggerThrottle(parsed.data.reason)));
  } catch (e) {
    next(e);
  }
});

export default router;
