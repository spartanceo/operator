/**
 * /api/comm/voip — Twilio call placement, recording, transcript, summary.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  getCall,
  listCalls,
  placeCall,
  recordCall,
  summariseCall,
  transcribeCall,
  updateCallStatus,
} from "../../services/comm/voip.service";

const router: IRouter = Router();

const ListSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  accountId: z.string().min(1).max(80).optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
});

const PlaceSchema = z.object({
  accountId: z.string().min(1).max(80),
  toNumber: z.string().min(3).max(50),
  contactId: z.string().min(1).max(80).optional(),
});

const RecordSchema = z.object({
  accountId: z.string().min(1).max(80),
  direction: z.enum(["inbound", "outbound"]),
  fromNumber: z.string().min(3).max(50),
  toNumber: z.string().min(3).max(50),
  status: z
    .enum(["queued", "ringing", "in_progress", "completed", "failed", "no_answer"])
    .optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  startedAt: z.number().int().positive().optional(),
  completedAt: z.number().int().positive().optional(),
  recordingPath: z.string().min(1).max(500).optional(),
  transcript: z.string().min(1).max(200_000).optional(),
  summary: z.string().min(1).max(20_000).optional(),
  contactId: z.string().min(1).max(80).optional(),
});

const StatusSchema = z.object({
  status: z
    .enum(["queued", "ringing", "in_progress", "completed", "failed", "no_answer"])
    .optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().positive().optional(),
  recordingPath: z.string().min(1).max(500).optional(),
});

const TranscribeSchema = z.object({
  transcript: z.string().min(1).max(200_000),
});

const SummariseSchema = z.object({
  summary: z.string().min(1).max(20_000),
});

router.get("/calls", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const page = await listCalls(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/calls", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PlaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid call payload"));
      return;
    }
    const row = await placeCall(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/calls/record", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RecordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid call record"));
      return;
    }
    const row = await recordCall(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/calls/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getCall(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Call not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/calls/:id/status", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid status payload"));
      return;
    }
    const row = await updateCallStatus(ctx, String(req.params.id), parsed.data);
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Call not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/calls/:id/transcribe", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = TranscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid transcript"));
      return;
    }
    const row = await transcribeCall(ctx, String(req.params.id), parsed.data.transcript);
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Call not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/calls/:id/summarise", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SummariseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid summary"));
      return;
    }
    const row = await summariseCall(ctx, String(req.params.id), parsed.data.summary);
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Call not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

export default router;
