/**
 * /api/creators — public creator profiles, embeddable badges, leaderboard,
 * milestones.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  buildCreatorBadge,
  CreatorProfileValidationError,
  dismissMilestone,
  getCreatorProfileBySlug,
  getLeaderboard,
  getMyCreatorProfile,
  listMilestones,
  syncMilestones,
  upsertCreatorProfile,
  type LeaderboardKind,
} from "../../services/creator-profiles.service";

const router: IRouter = Router();

const HttpUrl = z.string().url().max(500);

const ProfileSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  handle: z.string().min(1).max(80).optional(),
  slug: z.string().min(1).max(80).optional(),
  bio: z.string().max(4_000).optional(),
  websiteUrl: HttpUrl.optional(),
  twitterUrl: HttpUrl.optional(),
  githubUrl: HttpUrl.optional(),
  avatarUrl: HttpUrl.optional(),
  badgeEnabled: z.boolean().optional(),
  published: z.boolean().optional(),
});

router.get("/me", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const profile = await getMyCreatorProfile(ctx);
    res.json(ok({ profile }));
  } catch (e) {
    next(e);
  }
});

router.put("/me", requireTenant(), async (req, res, next) => {
  try {
    const parsed = ProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid profile payload"));
      return;
    }
    const ctx = requireTenantContext();
    const profile = await upsertCreatorProfile(ctx, parsed.data);
    res.json(ok({ profile }));
  } catch (e) {
    if (e instanceof CreatorProfileValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.get("/me/badge", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const profile = await getMyCreatorProfile(ctx);
    if (!profile) {
      res.status(404).json(err("CREATOR_PROFILE_NOT_FOUND", "Create a profile first"));
      return;
    }
    const badge = buildCreatorBadge(profile);
    res.json(ok({ badge }));
  } catch (e) {
    next(e);
  }
});

router.get("/leaderboard", async (req, res, next) => {
  try {
    const kindRaw = String(req.query["kind"] ?? "most_used");
    const kind: LeaderboardKind =
      kindRaw === "top_earners" || kindRaw === "highest_rated"
        ? kindRaw
        : "most_used";
    const limit = Math.max(
      1,
      Math.min(100, Number(req.query["limit"] ?? 25) || 25),
    );
    const entries = await getLeaderboard(kind, limit);
    res.json(ok({ kind, entries }));
  } catch (e) {
    next(e);
  }
});

router.get("/milestones", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const includeDismissed = req.query["includeDismissed"] === "true";
    const milestones = await listMilestones(ctx, { includeDismissed });
    res.json(ok({ milestones }));
  } catch (e) {
    next(e);
  }
});

router.post("/milestones/sync", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const created = await syncMilestones(ctx);
    res.json(ok({ created }));
  } catch (e) {
    next(e);
  }
});

router.post("/milestones/:id/dismiss", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = String(req.params["id"] ?? "");
    const milestone = await dismissMilestone(ctx, id);
    res.json(ok({ milestone }));
  } catch (e) {
    next(e);
  }
});

router.get("/:slug", async (req, res, next) => {
  try {
    const slug = String(req.params["slug"] ?? "").trim();
    const profile = await getCreatorProfileBySlug(slug);
    if (!profile) {
      res.status(404).json(err("CREATOR_PROFILE_NOT_FOUND", "Creator not found"));
      return;
    }
    const badge = profile.badgeEnabled ? buildCreatorBadge(profile) : null;
    res.json(ok({ profile, badge }));
  } catch (e) {
    next(e);
  }
});

export default router;
