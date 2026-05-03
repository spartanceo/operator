/**
 * /api/voice — speech-to-text + text-to-speech.
 *
 * Tier 1 backs both endpoints with deterministic stubs (see
 * `services/voice.service.ts`); the route shape is final so the UI and
 * tests can be built today and the runtime swap is transparent.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  MAX_TEXT_CHARS,
  VoicePayloadError,
  listVoices,
  synthesize,
  transcribe,
} from "../../services/voice.service";

const router: IRouter = Router();

const TranscribeSchema = z.object({
  audio: z.string().min(1),
  mimeType: z.string().min(1).max(100).optional(),
  language: z.string().min(2).max(20).optional(),
});

const SynthesizeSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_CHARS),
  voice: z.string().min(1).max(80).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  format: z.literal("wav").optional(),
});

const ListVoicesQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

router.post("/transcribe", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = TranscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid transcribe payload"));
      return;
    }
    const result = await transcribe(ctx, parsed.data);
    res.json(ok(result));
  } catch (e) {
    if (e instanceof VoicePayloadError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post("/synthesize", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SynthesizeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid synthesize payload"));
      return;
    }
    const result = await synthesize(ctx, parsed.data);
    res.json(ok(result));
  } catch (e) {
    if (e instanceof VoicePayloadError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.get("/voices", requireTenant(), (req, res, next) => {
  try {
    const parsed = ListVoicesQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid voices query"));
      return;
    }
    const page = listVoices(parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

export default router;
