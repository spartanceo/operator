/**
 * /api/store/moderation/* — Creator-facing moderation endpoints
 * (Task #57). Lets a creator submit a skill for review, poll the
 * status of their own submissions, and file an appeal against a
 * rejection.
 *
 * Authentication: every endpoint requires a creator API token, either
 * in the `Authorization: Bearer <token>` header or as `apiToken` in the
 * body. The authenticated creator's id and handle are the source of
 * truth — body-supplied creatorId / creatorHandle / priority fields are
 * IGNORED to prevent impersonation and SLA-tier escalation. Submission
 * priority always defaults to "standard" on this public route; the
 * verified-creator queue is reserved for the admin-mediated path.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  authenticateCreatorByApiToken,
  CreatorAuthError,
} from "../../services/store.service";
import {
  getSubmission,
  ModerationError,
  submitAppeal,
  submitSkillForModeration,
} from "../../services/skill-moderation.service";

const router: IRouter = Router();

function handle(e: unknown, res: import("express").Response): boolean {
  if (e instanceof ModerationError) {
    res.status(e.status).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof CreatorAuthError) {
    res.status(401).json(err("UNAUTHORIZED", e.message));
    return true;
  }
  return false;
}

function readBearer(req: import("express").Request): string | null {
  const h = req.headers["authorization"];
  if (typeof h === "string") {
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  const body = (req.body ?? {}) as { apiToken?: unknown };
  if (typeof body.apiToken === "string" && body.apiToken.length > 0) return body.apiToken;
  return null;
}

const ManifestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  version: z.string().min(1).max(40).optional(),
  description: z.string().max(2_000).optional(),
  purpose: z.string().max(2_000).optional(),
  minOpVersion: z.string().min(1).max(40).optional(),
  permissions: z.array(z.string().min(1).max(80)).max(40).optional(),
  networkHosts: z.array(z.string().min(1).max(255)).max(40).optional(),
  fileScopes: z.array(z.string().min(1).max(500)).max(40).optional(),
  dependencies: z.record(z.string(), z.string().max(80)).optional(),
});

const SubmitSchema = z.object({
  source: z.string().min(1).max(1_000_000),
  manifest: ManifestSchema,
  draftId: z.string().min(1).max(120).optional(),
  slug: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(120).optional(),
  currentOpVersion: z.string().min(1).max(40).optional(),
  apiToken: z.string().min(1).max(200).optional(),
});

router.post("/moderation/submit", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const creator = await authenticateCreatorByApiToken(readBearer(req));
    const parsed = SubmitSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid moderation submission"));
      return;
    }
    const row = await submitSkillForModeration(ctx, {
      source: parsed.data.source,
      manifest: parsed.data.manifest,
      ...(parsed.data.draftId ? { draftId: parsed.data.draftId } : {}),
      creatorId: creator.id,
      creatorHandle: creator.handle,
      ...(parsed.data.slug ? { slug: parsed.data.slug } : {}),
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      // Priority is always "standard" on the public route — the
      // verified queue is reserved for the admin-mediated path so a
      // creator cannot self-promote into the 24h SLA tier.
      priority: "standard",
      ...(parsed.data.currentOpVersion
        ? { currentOpVersion: parsed.data.currentOpVersion }
        : {}),
    });
    res.json(ok(row));
  } catch (e) {
    if (handle(e, res)) return;
    next(e);
  }
});

router.get(
  "/moderation/submissions/:id",
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const creator = await authenticateCreatorByApiToken(readBearer(req));
      const row = await getSubmission(ctx, String(req.params["id"]));
      // Ownership check — the authenticated creator must own this row.
      if (row.creatorHandle !== creator.handle) {
        res
          .status(404)
          .json(err("NOT_FOUND", `Submission not found: ${req.params["id"]}`));
        return;
      }
      res.json(ok(row));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

const AppealSchema = z.object({
  submissionId: z.string().min(1).max(120),
  reason: z.string().min(10).max(4_000),
  apiToken: z.string().min(1).max(200).optional(),
});

router.post("/moderation/appeals", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const creator = await authenticateCreatorByApiToken(readBearer(req));
    const parsed = AppealSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid appeal payload"));
      return;
    }
    // Verify the submission belongs to the authenticated creator before
    // letting them appeal it.
    const target = await getSubmission(ctx, parsed.data.submissionId);
    if (target.creatorHandle !== creator.handle) {
      res
        .status(404)
        .json(err("NOT_FOUND", `Submission not found: ${parsed.data.submissionId}`));
      return;
    }
    const row = await submitAppeal(ctx, {
      submissionId: parsed.data.submissionId,
      reason: parsed.data.reason,
      creatorId: creator.id,
      creatorHandle: creator.handle,
    });
    res.json(ok(row));
  } catch (e) {
    if (handle(e, res)) return;
    next(e);
  }
});

export default router;
