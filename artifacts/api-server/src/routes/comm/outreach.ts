/**
 * /api/comm/outreach — multi-step email outreach sequences with reply-stop.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  createSequence,
  enrolContact,
  getEnrolment,
  getSequence,
  listEnrolments,
  listSequences,
  runDueSteps,
  setSequenceStatus,
} from "../../services/comm/outreach.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const SequenceListSchema = PageSchema.extend({
  status: z.enum(["active", "paused", "archived"]).optional(),
});

const StepSchema = z.object({
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(200_000),
  delayDays: z.number().int().min(0).max(365),
});

const CreateSequenceSchema = z.object({
  accountId: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2_000).optional(),
  steps: z.array(StepSchema).min(1).max(20),
});

const SequenceStatusSchema = z.object({
  status: z.enum(["active", "paused", "archived"]),
});

const EnrolSchema = z.object({
  sequenceId: z.string().min(1).max(80),
  contactId: z.string().min(1).max(80),
  startAt: z.number().int().positive().optional(),
});

const EnrolmentListSchema = PageSchema.extend({
  sequenceId: z.string().min(1).max(80).optional(),
  status: z
    .enum(["active", "completed", "replied", "paused", "stopped"])
    .optional(),
});

const RunSchema = z.object({
  now: z.number().int().positive().optional(),
});

router.get("/sequences", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SequenceListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const page = await listSequences(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/sequences", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSequenceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid sequence payload"));
      return;
    }
    const row = await createSequence(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/sequences/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getSequence(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Sequence not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/sequences/:id/status", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SequenceStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid status"));
      return;
    }
    const row = await setSequenceStatus(ctx, String(req.params.id), parsed.data.status);
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Sequence not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/enrolments", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = EnrolmentListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const page = await listEnrolments(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/enrolments", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = EnrolSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid enrolment payload"));
      return;
    }
    const row = await enrolContact(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/enrolments/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getEnrolment(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Enrolment not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/run", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid run payload"));
      return;
    }
    const result = await runDueSteps(ctx, parsed.data.now);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
