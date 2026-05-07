/**
 * /api/capabilities — capability runtime switcher surface.
 *
 *   GET    /                            — list all capability types with their backends + health
 *   GET    /:type                       — get active backend for one capability type
 *   POST   /:type/active                — set active backend for one capability type
 *   POST   /:type/:id/credentials       — store encrypted API key for a backend
 *   DELETE /:type/:id/credentials       — remove API key for a backend
 *   GET    /detect                      — run local service probe, return detected backend ids
 *   POST   /image-gen/generate          — generate an image via the active image-gen backend
 *
 * Capability types: image-gen | web-search | tts | embeddings | code-sandbox
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import { ALL_CAPABILITY_TYPES, getCapabilityBackend } from "../../services/capability/registry";
import type { CapabilityType } from "../../services/capability/types";
import {
  deleteCapabilityCredential,
  detectLocalCapabilityBackends,
  getActiveCapabilityInfo,
  listAllCapabilityInfo,
  setActiveCapabilityBackend,
  setCapabilityCredential,
  generateImage,
} from "../../services/capability.service";

const router: IRouter = Router();

// tier-review: bounded — fixed-size 5-element enum built from the static ALL_CAPABILITY_TYPES tuple, never mutated
const VALID_TYPES = new Set<CapabilityType>(ALL_CAPABILITY_TYPES);

function parseType(raw: string): CapabilityType | null {
  return VALID_TYPES.has(raw as CapabilityType) ? (raw as CapabilityType) : null;
}

const SetActiveSchema = z.object({
  backendId: z.string().min(1).max(80).nullable(),
});

const SetCredentialSchema = z.object({
  apiKey: z.string().min(8).max(2000),
  label: z.string().max(200).nullable().optional(),
});

router.get("/detect", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const detected = await detectLocalCapabilityBackends(ctx);
    res.json(ok({ detectedBackendIds: detected }));
  } catch (e) {
    next(e);
  }
});

router.get("/", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listAllCapabilityInfo(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.get("/:type", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const capabilityType = parseType(String(req.params.type));
    if (!capabilityType) {
      res.status(404).json(err("NOT_FOUND", `Unknown capability type "${req.params.type}"`));
      return;
    }
    const info = await getActiveCapabilityInfo(ctx, capabilityType);
    res.json(ok(info));
  } catch (e) {
    next(e);
  }
});

router.post("/:type/active", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const capabilityType = parseType(String(req.params.type));
    if (!capabilityType) {
      res.status(404).json(err("NOT_FOUND", `Unknown capability type "${req.params.type}"`));
      return;
    }
    const parsed = SetActiveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid backend selection payload"));
      return;
    }
    const { backendId } = parsed.data;
    if (backendId !== null && !getCapabilityBackend(backendId)) {
      res.status(404).json(err("NOT_FOUND", `Unknown capability backend "${backendId}"`));
      return;
    }
    const result = await setActiveCapabilityBackend(ctx, capabilityType, backendId);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/:type/:id/credentials", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const capabilityType = parseType(String(req.params.type));
    if (!capabilityType) {
      res.status(404).json(err("NOT_FOUND", `Unknown capability type "${req.params.type}"`));
      return;
    }
    const id = String(req.params.id);
    const backend = getCapabilityBackend(id);
    if (!backend || backend.capabilityType !== capabilityType) {
      res.status(404).json(err("NOT_FOUND", `Unknown backend "${id}" for type "${capabilityType}"`));
      return;
    }
    if (!backend.requiresApiKey) {
      res.status(400).json(err("VALIDATION", `Backend "${id}" does not accept API keys`));
      return;
    }
    const parsed = SetCredentialSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid credential payload"));
      return;
    }
    const result = await setCapabilityCredential(
      ctx,
      id,
      parsed.data.apiKey,
      parsed.data.label ?? null,
    );
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.delete("/:type/:id/credentials", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const capabilityType = parseType(String(req.params.type));
    if (!capabilityType) {
      res.status(404).json(err("NOT_FOUND", `Unknown capability type "${req.params.type}"`));
      return;
    }
    const id = String(req.params.id);
    const backend = getCapabilityBackend(id);
    if (!backend || backend.capabilityType !== capabilityType) {
      res.status(404).json(err("NOT_FOUND", `Unknown backend "${id}" for type "${capabilityType}"`));
      return;
    }
    const result = await deleteCapabilityCredential(ctx, id);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

const GenerateImageSchema = z.object({
  prompt: z.string().min(1).max(2000),
  negativePrompt: z.string().max(2000).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(1).max(30).optional(),
  seed: z.number().int().nullable().optional(),
  checkpoint: z.string().max(255).optional(),
});

router.post("/image-gen/generate", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = GenerateImageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid image generation payload"));
      return;
    }
    const result = await generateImage(ctx, parsed.data);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
