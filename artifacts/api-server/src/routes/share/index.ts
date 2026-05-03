/**
 * /api/share — skill share links + cards, post-task share text generator,
 * post-task satisfaction ratings.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  buildSkillShareLinks,
  buildTaskShareCard,
  getSkillShareCard,
  listSatisfactionRatings,
  listShareEvents,
  recordSatisfaction,
  recordShareEvent,
} from "../../services/share.service";

const router: IRouter = Router();

const ShareEventSchema = z.object({
  targetKind: z.enum(["skill", "task", "creator"]),
  targetId: z.string().min(1).max(200),
  channel: z
    .enum(["twitter", "linkedin", "whatsapp", "copy", "native", "email"])
    .optional(),
  label: z.string().max(200).optional(),
});

const TaskShareSchema = z.object({
  goal: z.string().min(1).max(1_000),
  summary: z.string().min(1).max(2_000),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
});

const SatisfactionSchema = z.object({
  runId: z.string().min(1).max(120).optional(),
  rating: z.enum(["up", "down"]),
  summary: z.string().max(2_000).optional(),
});

router.post("/events", requireTenant(), async (req, res, next) => {
  try {
    const parsed = ShareEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid share event"));
      return;
    }
    const ctx = requireTenantContext();
    const event = await recordShareEvent(ctx, parsed.data);
    res.json(ok({ event }));
  } catch (e) {
    next(e);
  }
});

router.get("/events", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const targetKind = req.query["targetKind"];
    const targetId = req.query["targetId"];
    const filters: { targetKind?: "skill" | "task" | "creator"; targetId?: string } = {};
    if (
      targetKind === "skill" ||
      targetKind === "task" ||
      targetKind === "creator"
    ) {
      filters.targetKind = targetKind;
    }
    if (typeof targetId === "string" && targetId.length > 0) {
      filters.targetId = targetId;
    }
    const events = await listShareEvents(ctx, filters);
    res.json(ok({ events }));
  } catch (e) {
    next(e);
  }
});

router.get("/skill/:identifier", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const ident = String(req.params["identifier"] ?? "");
    const card = await getSkillShareCard(ctx, ident);
    if (!card) {
      res.status(404).json(err("SKILL_NOT_FOUND", "Skill not found"));
      return;
    }
    res.json(ok({ card }));
  } catch (e) {
    next(e);
  }
});

router.get("/skill/:slug/links", async (req, res, next) => {
  try {
    const slug = String(req.params["slug"] ?? "").trim();
    if (!slug) {
      res.status(400).json(err("VALIDATION", "slug required"));
      return;
    }
    const links = buildSkillShareLinks(slug);
    res.json(ok({ links }));
  } catch (e) {
    next(e);
  }
});

router.post("/task-card", requireTenant(), async (req, res, next) => {
  try {
    const parsed = TaskShareSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid task share payload"));
      return;
    }
    const card = buildTaskShareCard(parsed.data);
    res.json(ok({ card }));
  } catch (e) {
    next(e);
  }
});

router.post("/satisfaction", requireTenant(), async (req, res, next) => {
  try {
    const parsed = SatisfactionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid satisfaction payload"));
      return;
    }
    const ctx = requireTenantContext();
    const rating = await recordSatisfaction(ctx, parsed.data);
    res.json(ok({ rating }));
  } catch (e) {
    next(e);
  }
});

router.get("/satisfaction", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const runId = req.query["runId"];
    const filters: { runId?: string } = {};
    if (typeof runId === "string" && runId.length > 0) filters.runId = runId;
    const ratings = await listSatisfactionRatings(ctx, filters);
    res.json(ok({ ratings }));
  } catch (e) {
    next(e);
  }
});

export default router;
