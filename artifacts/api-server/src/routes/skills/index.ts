/**
 * /api/skills — Skills Marketplace CRUD + install/import/export/invoke.
 *
 * Reads & writes are tenant-scoped through the service layer; this file
 * is a thin Zod-validated boundary around `skill.service`.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import { createAgentRun } from "../../services/agent.service";
import draftsRouter from "./drafts";
import {
  applySkillUpdate,
  createSkill,
  deleteSkill,
  dismissSkillUpdate,
  exportSkill,
  getAdoptionStats,
  getSkill,
  importSkill,
  installSkill,
  listSkills,
  listSkillsWithUpdates,
  listSkillVersions,
  publishSkillVersion,
  rollbackSkill,
  setAutoUpdate,
  type SkillSort,
  SkillNotFoundError,
  SkillValidationError,
  uninstallSkill,
  updateSkill,
} from "../../services/skill.service";
import {
  flagReview,
  getRatingSummary,
  getSkillBadges,
  listFlaggedReviews,
  listSimilarSkills,
  listSkillReviews,
  listTrendingSkills,
  moderateReview,
  recordSkillUsage,
  respondToReview,
  ReviewError,
  setSkillTrustFlags,
  submitRating,
  voteHelpful,
  type ReviewSort,
} from "../../services/skill-reviews.service";

const router: IRouter = Router();

// Mount the wizard sub-router FIRST so `/drafts/*` matches before
// `/:id`-style fall-through routes below.
router.use("/drafts", draftsRouter);

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  category: z.string().min(1).max(80).optional(),
  installed: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  search: z.string().min(1).max(200).optional(),
  sort: z
    .enum(["popular", "highest-rated", "most-used", "newest", "recently-updated"])
    .optional(),
});

const RatingSchema = z.object({
  stars: z.number().int().min(1).max(5),
  reviewText: z.string().max(4_000).optional().nullable(),
});

const ReviewListSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  sort: z.enum(["helpful", "recent", "highest", "lowest"]).optional(),
  includeHidden: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

const HelpfulSchema = z.object({ helpful: z.boolean() });

const ResponseSchema = z.object({ body: z.string().min(1).max(4_000) });

const FlagSchema = z.object({
  reason: z.string().min(1).max(200),
  detail: z.string().max(1_000).optional().nullable(),
});

const ModerationSchema = z.object({
  action: z.enum(["hide", "restore", "remove", "dismiss"]),
  resolution: z.string().max(500).optional(),
});

const TrustFlagsSchema = z.object({
  verifiedByOp: z.boolean().optional(),
  editorialPick: z.boolean().optional(),
});

const UsageSchema = z.object({
  runId: z.string().min(1).max(120).optional(),
});

const FlaggedListSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  status: z.enum(["open", "dismissed", "upheld"]).optional(),
});

function handleReviewError(
  res: import("express").Response,
  e: unknown,
): boolean {
  if (e instanceof ReviewError) {
    res.status(e.httpStatus).json(err(e.code, e.message));
    return true;
  }
  return false;
}

const StringArray = z.array(z.string().min(1).max(120)).max(50);

const CreateSchema = z.object({
  slug: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  content: z.string().min(1).max(64_000),
  modelTags: StringArray.optional(),
  triggers: StringArray.optional(),
  category: z.string().min(1).max(80).optional(),
  author: z.string().min(1).max(120).optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).optional(),
  content: z.string().min(1).max(64_000).optional(),
  modelTags: StringArray.optional(),
  triggers: StringArray.optional(),
  category: z.string().min(1).max(80).optional(),
});

const ManifestSchema = z.object({
  omninitySkillVersion: z.literal(1),
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000),
  content: z.string().min(1).max(64_000),
  modelTags: StringArray,
  triggers: StringArray,
  category: z.string().min(1).max(80),
  author: z.string().min(1).max(120),
  version: z.number().int().min(1).max(1_000_000),
  semver: z.string().max(40).optional(),
  changelog: z.string().max(8_000).optional(),
  breakingChange: z.boolean().optional(),
  minOpVersion: z.string().max(40).optional(),
});

const ImportSchema = z.object({
  manifest: ManifestSchema,
  install: z.boolean().optional(),
});

const InvokeSchema = z.object({
  goal: z.string().min(1).max(4_000),
  modelName: z.string().min(1).max(200).optional(),
});

const SemverSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/, "Must be a semantic version like 1.2.3");

const PublishSchema = z.object({
  version: SemverSchema,
  changelog: z.string().min(1).max(8_000),
  breakingChange: z.boolean().optional(),
  minOpVersion: SemverSchema.optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).optional(),
  content: z.string().min(1).max(64_000).optional(),
  modelTags: StringArray.optional(),
  triggers: StringArray.optional(),
  category: z.string().min(1).max(80).optional(),
});

const RollbackSchema = z.object({
  version: SemverSchema,
});

const ApplyUpdateSchema = z.object({
  acceptBreaking: z.boolean().optional(),
});

const AutoUpdateSchema = z.object({
  enabled: z.boolean(),
});

function handleSkillError(
  e: unknown,
  res: import("express").Response,
): boolean {
  if (e instanceof SkillNotFoundError) {
    res.status(404).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof SkillValidationError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  return false;
}

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listSkills(ctx, parsed.data as { sort?: SkillSort });
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

// ─── Trending discovery ────────────────────────────────────────────────
router.get("/trending", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const limit = Math.max(1, Math.min(50, Number(req.query["limit"] ?? 10)));
    const items = await listTrendingSkills(ctx, limit);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.get("/similar", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const limit = Math.max(1, Math.min(20, Number(req.query["limit"] ?? 5)));
    const items = await listSimilarSkills(ctx, limit);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

// ─── Admin moderation queue ───────────────────────────────────────────
router.get("/admin/flagged", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = FlaggedListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const page = await listFlaggedReviews(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post(
  "/admin/ratings/:ratingId/moderate",
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = ModerationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid moderation payload"));
        return;
      }
      const row = await moderateReview(
        ctx,
        String(req.params.ratingId),
        parsed.data.action,
        parsed.data.resolution,
      );
      res.json(ok(row));
    } catch (e) {
      if (handleReviewError(res, e)) return;
      next(e);
    }
  },
);

// ─── Per-rating actions (helpful, response, flag) ──────────────────────
router.post(
  "/ratings/:ratingId/helpful",
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = HelpfulSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid helpful payload"));
        return;
      }
      const row = await voteHelpful(
        ctx,
        String(req.params.ratingId),
        parsed.data.helpful,
      );
      res.json(ok(row));
    } catch (e) {
      if (handleReviewError(res, e)) return;
      next(e);
    }
  },
);

router.post(
  "/ratings/:ratingId/response",
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = ResponseSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid response payload"));
        return;
      }
      const row = await respondToReview(
        ctx,
        String(req.params.ratingId),
        parsed.data.body,
      );
      res.json(ok(row));
    } catch (e) {
      if (handleReviewError(res, e)) return;
      next(e);
    }
  },
);

router.post(
  "/ratings/:ratingId/flag",
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = FlagSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid flag payload"));
        return;
      }
      const row = await flagReview(
        ctx,
        String(req.params.ratingId),
        parsed.data.reason,
        parsed.data.detail ?? undefined,
      );
      res.json(ok(row));
    } catch (e) {
      if (handleReviewError(res, e)) return;
      next(e);
    }
  },
);

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid skill payload"));
      return;
    }
    const row = await createSkill(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/updates", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listSkillsWithUpdates(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post("/import", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ImportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid skill manifest"));
      return;
    }
    const opts = parsed.data.install !== undefined ? { install: parsed.data.install } : {};
    const row = await importSkill(ctx, parsed.data.manifest, opts);
    res.json(ok(row));
  } catch (e) {
    if (e instanceof SkillValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getSkill(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Skill not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid skill payload"));
      return;
    }
    const row = await updateSkill(ctx, String(req.params.id), parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (e instanceof SkillNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteSkill(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/install", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await installSkill(ctx, String(req.params.id));
    res.json(ok(row));
  } catch (e) {
    if (e instanceof SkillNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post("/:id/uninstall", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await uninstallSkill(ctx, String(req.params.id));
    res.json(ok(row));
  } catch (e) {
    if (e instanceof SkillNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

async function handleExport(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): Promise<void> {
  try {
    const ctx = requireTenantContext();
    const manifest = await exportSkill(ctx, String(req.params.id));
    res.json(ok(manifest));
  } catch (e) {
    if (e instanceof SkillNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
}

router.post("/:id/publish", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PublishSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid publish payload"));
      return;
    }
    const row = await publishSkillVersion(ctx, String(req.params.id), parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.get("/:id/versions", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listSkillVersions(ctx, String(req.params.id));
    res.json(ok({ items }));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.post("/:id/rollback", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RollbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid rollback payload"));
      return;
    }
    const row = await rollbackSkill(ctx, String(req.params.id), parsed.data.version);
    res.json(ok(row));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.post("/:id/apply-update", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ApplyUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid apply-update payload"));
      return;
    }
    const row = await applySkillUpdate(ctx, String(req.params.id), parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.post("/:id/dismiss-update", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await dismissSkillUpdate(ctx, String(req.params.id));
    res.json(ok(row));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.patch("/:id/auto-update", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = AutoUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid auto-update payload"));
      return;
    }
    const row = await setAutoUpdate(ctx, String(req.params.id), parsed.data.enabled);
    res.json(ok(row));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.get("/:id/adoption", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await getAdoptionStats(ctx, String(req.params.id));
    res.json(ok({ items }));
  } catch (e) {
    if (handleSkillError(e, res)) return;
    next(e);
  }
});

router.get("/:id/export", requireTenant(), handleExport);
// Spec-mandated alternate path shape: GET /api/skills/export/:id
router.get("/export/:id", requireTenant(), handleExport);

// ─── Per-skill review surface ──────────────────────────────────────────
router.post("/:id/usage", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UsageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid usage payload"));
      return;
    }
    const skill = await getSkill(ctx, String(req.params.id));
    if (!skill) {
      res.status(404).json(err("NOT_FOUND", "Skill not found"));
      return;
    }
    const opts = parsed.data.runId !== undefined ? { runId: parsed.data.runId } : {};
    await recordSkillUsage(ctx, skill.id, opts);
    res.json(ok({ recorded: true }));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/ratings", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RatingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid rating payload"));
      return;
    }
    const row = await submitRating(ctx, String(req.params.id), parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleReviewError(res, e)) return;
    next(e);
  }
});

router.get("/:id/ratings", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ReviewListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const page = await listSkillReviews(
      ctx,
      String(req.params.id),
      parsed.data as { sort?: ReviewSort },
    );
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/:id/rating-summary", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const summary = await getRatingSummary(ctx, String(req.params.id));
    res.json(ok(summary));
  } catch (e) {
    if (handleReviewError(res, e)) return;
    next(e);
  }
});

router.get("/:id/badges", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getSkillBadges(ctx, String(req.params.id));
    res.json(ok(row));
  } catch (e) {
    if (handleReviewError(res, e)) return;
    next(e);
  }
});

router.post("/:id/trust-flags", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = TrustFlagsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid trust-flags payload"));
      return;
    }
    const row = await setSkillTrustFlags(ctx, String(req.params.id), parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleReviewError(res, e)) return;
    next(e);
  }
});

router.post("/:id/invoke", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = InvokeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid invoke payload"));
      return;
    }
    const skill = await getSkill(ctx, String(req.params.id));
    if (!skill) {
      res.status(404).json(err("NOT_FOUND", "Skill not found"));
      return;
    }
    const run = await createAgentRun(ctx, {
      goal: parsed.data.goal,
      ...(parsed.data.modelName !== undefined ? { modelName: parsed.data.modelName } : {}),
      skillId: skill.id,
    });
    res.json(ok(run));
  } catch (e) {
    next(e);
  }
});

export default router;
