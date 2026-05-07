/**
 * /api/media — local media generation pipeline (Tier 1 stubs).
 *
 * Routes mirror `lib/api-spec/openapi.yaml` exactly. Every handler validates
 * the request body / params with Zod before invoking the service so a bad
 * payload becomes a 400 envelope rather than a 500.
 *
 * The `/media/assets/{id}/file` endpoint is the only route in the API that
 * does NOT return the JSON envelope — it streams binary bytes with the
 * asset's recorded `Content-Type` so `<img>` / `<audio>` / `<video>` tags
 * can embed it directly.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  deleteAsset,
  generateAudio,
  generateImage,
  generateVideo,
  getAsset,
  listAssets,
  MediaCapabilityNotConfiguredError,
  MediaNotFoundError,
  MediaValidationError,
  probeHardware,
  readAssetBytes,
  removeBackground,
  upscaleImage,
} from "../../services/media.service";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const ListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  kind: z.enum(["image", "audio", "video"]).optional(),
});

const GenerateImageSchema = z.object({
  prompt: z.string().min(1).max(2000),
  style: z
    .enum(["photorealistic", "illustration", "watercolor", "pixel", "neon", "sketch"])
    .optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
});

const GenerateAudioSchema = z.object({
  prompt: z.string().min(1).max(2000),
  kind: z.enum(["music", "tts", "sfx"]).optional(),
  durationMs: z.number().int().min(250).max(30000).optional(),
});

const GenerateVideoSchema = z.object({
  prompt: z.string().min(1).max(2000),
  durationMs: z.number().int().min(500).max(10000).optional(),
  sourceAssetId: z.string().optional(),
});

const UpscaleSchema = z.object({
  scale: z.union([z.literal(2), z.literal(4)]).optional(),
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

router.get("/assets", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query parameters"));
      return;
    }
    const opts: {
      cursor?: string;
      limit?: number;
      kind?: "image" | "audio" | "video";
    } = {};
    if (parsed.data.cursor !== undefined) opts.cursor = parsed.data.cursor;
    if (parsed.data.limit !== undefined) opts.limit = parsed.data.limit;
    if (parsed.data.kind !== undefined) opts.kind = parsed.data.kind;
    const page = await listAssets(ctx, opts);
    res.json(ok(page));
  } catch (e) {
    next(e);
  }
});

router.get("/assets/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = String(req.params["id"] ?? "");
    const asset = await getAsset(ctx, id);
    if (!asset) {
      res.status(404).json(err("MEDIA_NOT_FOUND", `Media asset "${id}" not found`));
      return;
    }
    res.json(ok(asset));
  } catch (e) {
    next(e);
  }
});

router.delete("/assets/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = String(req.params["id"] ?? "");
    const result = await deleteAsset(ctx, id);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/assets/:id/file", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = String(req.params["id"] ?? "");
    const asset = await getAsset(ctx, id);
    if (!asset) {
      res.status(404).json(err("MEDIA_NOT_FOUND", `Media asset "${id}" not found`));
      return;
    }
    const bytes = await readAssetBytes(ctx, asset);
    res.setHeader("Content-Type", asset.mimeType || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("Content-Length", String(bytes.byteLength));
    res.status(200).end(bytes);
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

router.post("/images/generate", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = GenerateImageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid image-generation payload"));
      return;
    }
    const asset = await generateImage(ctx, parsed.data);
    res.json(ok(asset));
  } catch (e) {
    if (e instanceof MediaCapabilityNotConfiguredError) {
      res.status(422).json(err(e.code, e.message));
      return;
    }
    if (e instanceof MediaValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post("/audio/generate", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = GenerateAudioSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid audio-generation payload"));
      return;
    }
    const asset = await generateAudio(ctx, parsed.data);
    res.json(ok(asset));
  } catch (e) {
    if (e instanceof MediaCapabilityNotConfiguredError) {
      res.status(422).json(err(e.code, e.message));
      return;
    }
    if (e instanceof MediaValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post("/video/generate", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = GenerateVideoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid video-generation payload"));
      return;
    }
    const asset = await generateVideo(ctx, parsed.data);
    res.json(ok(asset));
  } catch (e) {
    if (e instanceof MediaValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post("/images/:id/upscale", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = String(req.params["id"] ?? "");
    const parsed = UpscaleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid upscale payload"));
      return;
    }
    const asset = await upscaleImage(ctx, id, parsed.data);
    res.json(ok(asset));
  } catch (e) {
    if (e instanceof MediaNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    if (e instanceof MediaValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post(
  "/images/:id/remove-background",
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const id = String(req.params["id"] ?? "");
      const asset = await removeBackground(ctx, id);
      res.json(ok(asset));
    } catch (e) {
      if (e instanceof MediaNotFoundError) {
        res.status(404).json(err(e.code, e.message));
        return;
      }
      if (e instanceof MediaValidationError) {
        res.status(400).json(err(e.code, e.message));
        return;
      }
      next(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Hardware probe
// ---------------------------------------------------------------------------

router.get("/hardware", requireTenant(), async (_req, res, next) => {
  try {
    const caps = probeHardware();
    res.json(ok(caps));
  } catch (e) {
    next(e);
  }
});

export default router;
