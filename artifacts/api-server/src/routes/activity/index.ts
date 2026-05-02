/**
 * /api/activity — append-only activity feed for the activity centre UI.
 *
 * Routes:
 *   GET   /events           paginated, filterable feed.
 *   POST  /events           append a manual entry (used by services).
 *   GET   /events/:id       singleton lookup for the detail drawer.
 *   GET   /export.csv       CSV export of the filtered feed.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  exportActivityCsv,
  getActivityEvent,
  listActivityEvents,
  recordActivity,
} from "../../services/activity.service";

const router: IRouter = Router();

const EventTypeSchema = z.enum([
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "tool.invoked",
  "skill.executed",
  "approval.requested",
  "approval.decided",
  "system",
]);

const ListSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  eventType: EventTypeSchema.optional(),
  agent: z.string().min(1).max(120).optional(),
  search: z.string().min(1).max(200).optional(),
  fromMs: z.coerce.number().int().nonnegative().optional(),
  toMs: z.coerce.number().int().nonnegative().optional(),
});

const CreateSchema = z.object({
  eventType: EventTypeSchema,
  actor: z.string().min(1).max(200),
  agent: z.string().max(120).optional(),
  skillName: z.string().max(200).optional(),
  runId: z.string().max(120).optional(),
  toolCallId: z.string().max(120).optional(),
  approvalId: z.string().max(120).optional(),
  summary: z.string().min(1).max(2000),
  outcome: z.enum(["success", "failure", "cancelled", "pending"]).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

router.get("/events", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid filter params"));
      return;
    }
    const page = await listActivityEvents(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/events", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid activity payload"));
      return;
    }
    const row = await recordActivity(ctx, parsed.data);
    if (!row) {
      res.status(500).json(err("PERSIST_FAILED", "Failed to record activity event"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/events/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getActivityEvent(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Activity event not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/export.csv", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListSchema.omit({ cursor: true, limit: true }).safeParse(
      req.query,
    );
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid filter params"));
      return;
    }
    const csv = await exportActivityCsv(ctx, parsed.data);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="omninity-activity-${Date.now()}.csv"`,
    );
    res.send(csv);
  } catch (e) {
    next(e);
  }
});

export default router;
