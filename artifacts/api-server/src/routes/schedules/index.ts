/**
 * /api/schedules — scheduled & recurring tasks (Task #45).
 *
 * Endpoints:
 *   GET    /                              — list paginated schedules.
 *   POST   /                              — create a new schedule.
 *   POST   /preview                       — parse NL / cron and return next 3 fires.
 *   GET    /:id                           — fetch one schedule.
 *   PATCH  /:id                           — update / re-cron a schedule.
 *   DELETE /:id                           — delete a schedule + its history.
 *   POST   /:id/run-now                   — trigger one execution immediately.
 *   POST   /:id/pause                     — toggle a per-row pause.
 *   GET    /:id/runs                      — paginated execution history.
 *   GET    /settings                      — global pause + last-tick.
 *   PUT    /settings                      — update global pause.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  createSchedule,
  CronParseError,
  deleteSchedule,
  getSchedule,
  getScheduleSettings,
  listScheduleRuns,
  listSchedules,
  previewSchedule,
  ScheduleNotFoundError,
  ScheduleParseError,
  setGlobalPause,
  triggerScheduleNow,
  updateSchedule,
} from "../../services/schedules.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const CreateSchema = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(8000),
  cronExpression: z.string().min(1).max(200).optional(),
  naturalLanguage: z.string().min(1).max(400).optional(),
  tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
  timezone: z.string().min(1).max(80).optional(),
  taskContext: z.unknown().optional(),
  recurrenceKind: z
    .enum(["minutely", "hourly", "daily", "weekly", "monthly", "custom"])
    .optional(),
});

const UpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(8000).optional(),
  cronExpression: z.string().min(1).max(200).optional(),
  naturalLanguage: z.string().min(1).max(400).optional(),
  tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
  timezone: z.string().min(1).max(80).optional(),
  taskContext: z.unknown().optional(),
  paused: z.boolean().optional(),
  recurrenceKind: z
    .enum(["minutely", "hourly", "daily", "weekly", "monthly", "custom"])
    .optional(),
});

const PreviewSchema = z.object({
  cronExpression: z.string().min(1).max(200).optional(),
  naturalLanguage: z.string().min(1).max(400).optional(),
  tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
});

const PauseSchema = z.object({
  paused: z.boolean(),
});

const SettingsSchema = z.object({
  globalPaused: z.boolean(),
});

function handleParseError(
  e: unknown,
  res: Parameters<Parameters<IRouter["post"]>[1]>[1],
): boolean {
  if (e instanceof ScheduleParseError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof CronParseError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof ScheduleNotFoundError) {
    res.status(404).json(err(e.code, e.message));
    return true;
  }
  return false;
}

router.get("/settings", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const settings = await getScheduleSettings(ctx);
    res.json(ok({ settings }));
  } catch (e) {
    next(e);
  }
});

router.put("/settings", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid settings payload"));
      return;
    }
    const settings = await setGlobalPause(ctx, parsed.data.globalPaused);
    res.json(ok({ settings }));
  } catch (e) {
    next(e);
  }
});

router.post("/preview", requireTenant(), async (req, res, next) => {
  try {
    const parsed = PreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid preview payload"));
      return;
    }
    const tz = parsed.data.tzOffsetMinutes ?? 0;
    const preview = previewSchedule(
      parsed.data.naturalLanguage,
      parsed.data.cronExpression,
      tz,
    );
    res.json(ok({ preview }));
  } catch (e) {
    if (handleParseError(e, res)) return;
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
    const page = await listSchedules(ctx, parsed.data);
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
      res.status(400).json(err("VALIDATION", "Invalid schedule payload"));
      return;
    }
    const row = await createSchedule(ctx, parsed.data);
    res.json(ok({ schedule: row }));
  } catch (e) {
    if (handleParseError(e, res)) return;
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getSchedule(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Schedule not found"));
      return;
    }
    res.json(ok({ schedule: row }));
  } catch (e) {
    next(e);
  }
});

router.patch("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid update payload"));
      return;
    }
    const row = await updateSchedule(ctx, String(req.params.id), parsed.data);
    res.json(ok({ schedule: row }));
  } catch (e) {
    if (handleParseError(e, res)) return;
    next(e);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteSchedule(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    if (handleParseError(e, res)) return;
    next(e);
  }
});

router.post("/:id/run-now", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const run = await triggerScheduleNow(ctx, String(req.params.id));
    res.json(ok({ run }));
  } catch (e) {
    if (handleParseError(e, res)) return;
    next(e);
  }
});

router.post("/:id/pause", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PauseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pause payload"));
      return;
    }
    const row = await updateSchedule(ctx, String(req.params.id), {
      paused: parsed.data.paused,
    });
    res.json(ok({ schedule: row }));
  } catch (e) {
    if (handleParseError(e, res)) return;
    next(e);
  }
});

router.get("/:id/runs", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listScheduleRuns(
      ctx,
      String(req.params.id),
      parsed.data,
    );
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

export default router;
