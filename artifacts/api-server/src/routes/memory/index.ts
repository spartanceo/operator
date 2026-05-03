/**
 * /api/memory — long-lived user memories.
 *
 * Task #49 expanded the surface from CRUD to a full long-term memory loop:
 * search, retrieval, post-message extraction, settings, stats, export and
 * the "forget everything" privacy lever.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  createMemory,
  deleteMemory,
  exportMemories,
  extractMemories,
  forgetAllMemories,
  getMemory,
  getMemorySettings,
  getMemoryStats,
  listMemories,
  MEMORY_CATEGORIES,
  MEMORY_CONFIDENCES,
  pruneMemories,
  retrieveRelevantMemories,
  updateMemory,
  updateMemorySettings,
} from "../../services/memory.service";

const router: IRouter = Router();

const CategoryEnum = z.enum(MEMORY_CATEGORIES);
const ConfidenceEnum = z.enum(MEMORY_CONFIDENCES);

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  category: CategoryEnum.optional(),
  confidence: ConfidenceEnum.optional(),
  q: z.string().min(1).max(200).optional(),
});

const CreateSchema = z.object({
  kind: z.string().min(1).max(80).optional(),
  category: CategoryEnum.optional(),
  confidence: ConfidenceEnum.optional(),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(32_000),
  importance: z.number().int().min(0).max(100).optional(),
  source: z.string().min(1).max(500).optional(),
  sourceConversationId: z.string().min(1).max(200).nullable().optional(),
  pinned: z.boolean().optional(),
});

const UpdateSchema = z.object({
  category: CategoryEnum.optional(),
  confidence: ConfidenceEnum.optional(),
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(32_000).optional(),
  importance: z.number().int().min(0).max(100).optional(),
  source: z.string().max(500).nullable().optional(),
  pinned: z.boolean().optional(),
});

const RetrieveSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().positive().max(20).optional(),
});

const ExtractSchema = z.object({
  text: z.string().min(1).max(20_000),
  conversationId: z.string().min(1).max(200).nullable().optional(),
});

const SettingsSchema = z.object({
  capacityBytes: z.number().int().min(1024 * 1024).max(1024 * 1024 * 1024).optional(),
  autoExtract: z.boolean().optional(),
});

const ExportQuerySchema = z.object({
  format: z.enum(["json", "markdown"]).optional(),
});

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listMemories(ctx, parsed.data);
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
      res.status(400).json(err("VALIDATION", "Invalid memory payload"));
      return;
    }
    const row = await createMemory(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.delete("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const confirm = String(req.query["confirm"] ?? "");
    if (confirm !== "FORGET_EVERYTHING") {
      res
        .status(400)
        .json(
          err(
            "CONFIRMATION_REQUIRED",
            "Pass ?confirm=FORGET_EVERYTHING to wipe all memories",
          ),
        );
      return;
    }
    const result = await forgetAllMemories(ctx);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/stats", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const stats = await getMemoryStats(ctx);
    res.json(ok(stats));
  } catch (e) {
    next(e);
  }
});

router.get("/settings", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const settings = await getMemorySettings(ctx);
    res.json(ok(settings));
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
    const settings = await updateMemorySettings(ctx, parsed.data);
    res.json(ok(settings));
  } catch (e) {
    next(e);
  }
});

router.get("/export", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid export format"));
      return;
    }
    const fmt = parsed.data.format ?? "json";
    const result = await exportMemories(ctx, fmt);
    res.json(
      ok({
        format: result.format,
        mediaType: result.mediaType,
        body: result.body,
        count: result.count,
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.post("/retrieve", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RetrieveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid retrieve payload"));
      return;
    }
    const items = await retrieveRelevantMemories(ctx, parsed.data.query, {
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    });
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post("/extract", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ExtractSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid extract payload"));
      return;
    }
    const result = await extractMemories(ctx, {
      text: parsed.data.text,
      conversationId: parsed.data.conversationId ?? null,
    });
    res.json(ok({ created: result.created, skipped: result.skipped }));
  } catch (e) {
    next(e);
  }
});

router.post("/prune", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await pruneMemories(ctx);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getMemory(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Memory not found"));
      return;
    }
    res.json(ok(row));
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
    const row = await updateMemory(ctx, String(req.params.id), parsed.data);
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Memory not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteMemory(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
