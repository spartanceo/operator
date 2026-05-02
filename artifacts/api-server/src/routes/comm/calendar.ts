/**
 * /api/comm/calendar — events read/write and free-slot finder.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  createEvent,
  deleteEvent,
  findFreeSlots,
  getEvent,
  listEvents,
  updateEvent,
} from "../../services/comm/calendar.service";

const router: IRouter = Router();

const ListSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  accountId: z.string().min(1).max(80).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
});

const AttendeeSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200).optional(),
  response: z
    .enum(["accepted", "declined", "tentative", "needs_action"])
    .optional(),
});

const CreateSchema = z.object({
  accountId: z.string().min(1).max(80),
  title: z.string().min(1).max(500),
  startsAt: z.number().int().nonnegative(),
  endsAt: z.number().int().nonnegative(),
  description: z.string().min(1).max(20_000).optional(),
  location: z.string().min(1).max(500).optional(),
  attendees: z.array(AttendeeSchema).max(100).optional(),
});

const UpdateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20_000).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  attendees: z.array(AttendeeSchema).max(100).optional(),
  startsAt: z.number().int().nonnegative().optional(),
  endsAt: z.number().int().nonnegative().optional(),
  status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
});

const FreeSlotSchema = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().nonnegative(),
  durationMinutes: z.coerce.number().int().positive().max(480),
  workStartHour: z.coerce.number().int().min(0).max(23).optional(),
  workEndHour: z.coerce.number().int().min(1).max(24).optional(),
  maxResults: z.coerce.number().int().positive().max(50).optional(),
  accountId: z.string().min(1).max(80).optional(),
});

router.get("/events", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const page = await listEvents(ctx, parsed.data);
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
      res.status(400).json(err("VALIDATION", "Invalid event payload"));
      return;
    }
    const row = await createEvent(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/events/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getEvent(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Event not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.patch("/events/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid event payload"));
      return;
    }
    const row = await updateEvent(ctx, String(req.params.id), parsed.data);
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Event not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.delete("/events/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteEvent(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/free-slots", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = FreeSlotSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const slots = await findFreeSlots(ctx, parsed.data);
    res.json(ok({ slots }));
  } catch (e) {
    next(e);
  }
});

export default router;
