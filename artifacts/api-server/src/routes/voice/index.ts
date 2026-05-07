/**
 * /api/voice — speech-to-text, text-to-speech, and Piper voice model management.
 *
 * TTS routing uses the tenant's configured capability backend (Piper /
 * ElevenLabs / OpenAI TTS) with a procedural stub fallback. STT remains on
 * the Replicate Whisper path with a deterministic stub fallback.
 *
 * GET /voices returns the voice catalogue for the active TTS backend. For
 * ElevenLabs it fetches account-specific voices (including premium/cloned).
 * When no backend is active it returns the stub catalogue.
 *
 * Piper model management routes (no user data involved):
 *   GET  /piper/models        — list all bundled voices + install status
 *   POST /piper/models/:id/install — download .onnx + .onnx.json from HuggingFace
 *   DELETE /piper/models/:id  — delete local model files to free space
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
import {
  PIPER_VOICES,
  PIPER_RELEASES_URL,
} from "../../services/capability/tts/piper";
import {
  isModelInstalled,
  downloadVoiceModel,
  deleteVoiceModel,
  getModelsDir,
} from "../../services/capability/tts/piper-models";
import { logPrivacyEvent } from "../../services/privacy.service";

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

const VoiceIdParam = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
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

router.get("/voices", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListVoicesQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid voices query"));
      return;
    }
    const page = await listVoices(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Piper voice model management
// ---------------------------------------------------------------------------

/**
 * GET /api/voice/piper/models
 * Returns all bundled Piper voice entries annotated with install status.
 * No user data is involved — all info is local filesystem state.
 */
router.get("/piper/models", requireTenant(), (_req, res) => {
  const models = PIPER_VOICES.map((v) => ({
    id: v.id,
    label: v.label,
    language: v.language,
    gender: v.gender,
    sampleRate: v.sampleRate,
    installed: isModelInstalled(v.id),
    modelsDir: getModelsDir(),
    releasesUrl: PIPER_RELEASES_URL,
  }));
  res.json(ok({ items: models, releasesUrl: PIPER_RELEASES_URL }));
});

/**
 * POST /api/voice/piper/models/:id/install
 * Downloads the .onnx + .onnx.json model files from HuggingFace.
 * Privacy: downloads from huggingface.co — no audio/text data sent.
 */
router.post("/piper/models/:id/install", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const paramParsed = VoiceIdParam.safeParse(req.params);
    if (!paramParsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid voice model ID"));
      return;
    }
    const voiceId = paramParsed.data.id;
    const known = PIPER_VOICES.find((v) => v.id === voiceId);
    if (!known) {
      res.status(404).json(err("NOT_FOUND", `Unknown Piper voice: ${voiceId}`));
      return;
    }
    if (isModelInstalled(voiceId)) {
      res.json(ok({ voiceId, installed: true, message: "Already installed" }));
      return;
    }
    await downloadVoiceModel(voiceId, ctx);
    res.json(ok({ voiceId, installed: true, message: "Voice model installed" }));
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/voice/piper/models/:id
 * Removes local model files to free disk space.
 */
router.delete("/piper/models/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const paramParsed = VoiceIdParam.safeParse(req.params);
    if (!paramParsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid voice model ID"));
      return;
    }
    const voiceId = paramParsed.data.id;
    await logPrivacyEvent(ctx, {
      eventType: "voice.piper.model.delete",
      actor: ctx.userId ?? ctx.tenantId,
      target: voiceId,
      severity: "low",
      detail: "removing local model files",
    });
    deleteVoiceModel(voiceId);
    res.json(ok({ voiceId, installed: false, message: "Voice model removed" }));
  } catch (e) {
    next(e);
  }
});

export default router;
