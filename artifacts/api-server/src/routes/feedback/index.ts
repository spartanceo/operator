/**
 * /api/feedback — public feature-request board, upvotes, status
 * notifications, and in-app thumbs up/down feedback (Task #34).
 *
 * Feature-request reads are public (no tenant required) so the marketing
 * website can render the community roadmap. Vote casting is also public —
 * the email address is the de-duplication key. In-app thumbs feedback
 * requires tenant context so we attribute it correctly.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  castVote,
  createFeatureRequest,
  FeedbackValidationError,
  getFeatureRequest,
  getFeedbackSentiment,
  listFeatureRequests,
  listRecentFeedback,
  submitFeatureFeedback,
  updateFeatureRequestStatus,
  withdrawVote,
} from "../../services/feedback.service";

const router: IRouter = Router();

const CreateRequestSchema = z.object({
  title: z.string().min(1).max(160),
  description: z.string().max(4000).optional(),
  category: z.string().max(40).optional(),
  submitterEmail: z.string().email(),
  submitterLabel: z.string().max(120).optional(),
});

const VoteSchema = z.object({
  voterEmail: z.string().email(),
  voterLabel: z.string().max(120).optional(),
  notifyOnChange: z.boolean().optional(),
});

const StatusSchema = z.object({
  status: z.string().min(1).max(40),
  statusNote: z.string().max(4000).optional(),
});

const ThumbSchema = z.object({
  featureKey: z.string().min(1).max(80),
  sentiment: z.enum(["up", "down"]),
  comment: z.string().max(2000).optional(),
  submitterLabel: z.string().max(120).optional(),
});

function handleErr(e: unknown, res: import("express").Response): boolean {
  if (e instanceof FeedbackValidationError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  return false;
}

// ─── Feature requests (public) ───────────────────────────────────────────────

router.get("/requests", async (req, res, next) => {
  try {
    const status =
      typeof req.query["status"] === "string" ? req.query["status"] : undefined;
    const category =
      typeof req.query["category"] === "string"
        ? req.query["category"]
        : undefined;
    const cursor =
      typeof req.query["cursor"] === "string" ? req.query["cursor"] : undefined;
    const limit =
      typeof req.query["limit"] === "string"
        ? Number(req.query["limit"])
        : undefined;
    const page = await listFeatureRequests({ status, category, cursor, limit });
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/requests", async (req, res, next) => {
  try {
    const parsed = CreateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid feature request"));
      return;
    }
    const request = await createFeatureRequest(parsed.data);
    res.json(ok({ request }));
  } catch (e) {
    if (handleErr(e, res)) return;
    next(e);
  }
});

router.get("/requests/:slug", async (req, res, next) => {
  try {
    const fr = await getFeatureRequest(String(req.params["slug"]));
    if (!fr) {
      res.status(404).json(err("NOT_FOUND", "Feature request not found"));
      return;
    }
    res.json(ok({ request: fr }));
  } catch (e) {
    next(e);
  }
});

router.post("/requests/:id/vote", async (req, res, next) => {
  try {
    const parsed = VoteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid vote payload"));
      return;
    }
    const result = await castVote({
      featureRequestId: String(req.params["id"]),
      ...parsed.data,
    });
    res.json(ok(result));
  } catch (e) {
    if (handleErr(e, res)) return;
    next(e);
  }
});

router.post("/requests/:id/withdraw", async (req, res, next) => {
  try {
    const email =
      typeof req.body?.voterEmail === "string" ? req.body.voterEmail : "";
    const result = await withdrawVote({
      featureRequestId: String(req.params["id"]),
      voterEmail: email,
    });
    res.json(ok(result));
  } catch (e) {
    if (handleErr(e, res)) return;
    next(e);
  }
});

router.post("/requests/:id/status", async (req, res, next) => {
  try {
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid status payload"));
      return;
    }
    const result = await updateFeatureRequestStatus({
      featureRequestId: String(req.params["id"]),
      ...parsed.data,
    });
    res.json(ok(result));
  } catch (e) {
    if (handleErr(e, res)) return;
    next(e);
  }
});

// ─── In-app thumbs feedback ──────────────────────────────────────────────────

router.post("/thumbs", requireTenant(), async (req, res, next) => {
  try {
    const parsed = ThumbSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid feedback payload"));
      return;
    }
    const ctx = requireTenantContext();
    const event = await submitFeatureFeedback(ctx, parsed.data);
    res.json(ok({ event }));
  } catch (e) {
    if (handleErr(e, res)) return;
    next(e);
  }
});

router.get("/sentiment", async (_req, res, next) => {
  try {
    const items = await getFeedbackSentiment();
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.get("/recent", async (req, res, next) => {
  try {
    const limit =
      typeof req.query["limit"] === "string" ? Number(req.query["limit"]) : 50;
    const items = await listRecentFeedback(limit);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

export default router;
