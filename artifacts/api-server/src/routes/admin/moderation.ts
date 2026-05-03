/**
 * /api/admin/super/moderation/* — Skill Moderation pipeline endpoints
 * for the Super Admin (Trust & Safety) portal (Task #57).
 *
 * Read-mostly routes for the queue + per-submission detail; mutating
 * routes for approve/reject/escalate, appeal decisions, emergency
 * suspension, and triggering the scheduled dependency rescan.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { adminLimiter } from "../../middlewares/rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  approveSubmission,
  decideAppeal,
  emergencySuspendStoreSkill,
  escalateSubmission,
  flagAnomaly,
  getSubmission,
  listAppeals,
  listOverdueQueue,
  listRescans,
  listSubmissions,
  ModerationError,
  rejectSubmission,
  rescanForVulnerabilities,
  suspendOnUserReport,
  type ModerationStatus,
  type SubmissionPriority,
} from "../../services/skill-moderation.service";

const router: IRouter = Router();

function actor(req: {
  headers: Record<string, unknown>;
  session?: { user?: { email?: string } };
}): string {
  const headerActor = req.headers["x-admin-actor"];
  if (typeof headerActor === "string" && headerActor.length > 0) return headerActor;
  return req.session?.user?.email ?? "super_admin";
}

function handle(e: unknown, res: import("express").Response): boolean {
  if (e instanceof ModerationError) {
    res.status(e.status).json(err(e.code, e.message));
    return true;
  }
  return false;
}

const ListSchema = z.object({
  status: z
    .enum([
      "pending",
      "static_running",
      "static_failed",
      "dynamic_running",
      "dynamic_failed",
      "awaiting_review",
      "approved",
      "rejected",
      "suspended",
    ])
    .optional(),
  priority: z.enum(["standard", "verified"]).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.get(
  "/super/moderation/submissions",
  adminLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = ListSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid query"));
        return;
      }
      const page = await listSubmissions(ctx, {
        status: parsed.data.status as ModerationStatus | undefined,
        priority: parsed.data.priority as SubmissionPriority | undefined,
        cursor: parsed.data.cursor ?? null,
        limit: parsed.data.limit,
      });
      res.json(pageOk(page.items, page.nextCursor));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

router.get(
  "/super/moderation/submissions/queue-stats",
  adminLimiter,
  requireTenant(),
  async (_req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const stats = await listOverdueQueue(ctx);
      res.json(ok(stats));
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/super/moderation/submissions/:id",
  adminLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const row = await getSubmission(ctx, String(req.params["id"]));
      res.json(ok(row));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

const ApproveSchema = z.object({ notes: z.string().max(2_000).optional() });

router.post(
  "/super/moderation/submissions/:id/approve",
  adminLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = ApproveSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid body"));
        return;
      }
      const row = await approveSubmission(ctx, String(req.params["id"]), {
        reviewer: actor(req as never),
        ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
      });
      res.json(ok(row));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

const RejectSchema = z.object({
  reason: z.string().min(1).max(2_000),
  notes: z.string().max(2_000).optional(),
});

router.post(
  "/super/moderation/submissions/:id/reject",
  adminLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = RejectSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "`reason` is required"));
        return;
      }
      const row = await rejectSubmission(ctx, String(req.params["id"]), {
        reviewer: actor(req as never),
        reason: parsed.data.reason,
        ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
      });
      res.json(ok(row));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

router.post(
  "/super/moderation/submissions/:id/escalate",
  adminLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = ApproveSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid body"));
        return;
      }
      const row = await escalateSubmission(ctx, String(req.params["id"]), {
        reviewer: actor(req as never),
        ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
      });
      res.json(ok(row));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

const EmergencySuspendSchema = z.object({ reason: z.string().min(1).max(2_000) });

router.post(
  "/super/moderation/store/:id/emergency-suspend",
  adminLimiter,
  async (req, res, next) => {
    try {
      const parsed = EmergencySuspendSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "`reason` is required"));
        return;
      }
      const row = await emergencySuspendStoreSkill({
        storeSkillId: String(req.params["id"]),
        reviewer: actor(req as never),
        reason: parsed.data.reason,
      });
      res.json(ok(row));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

router.post(
  "/super/moderation/store/:id/anomaly",
  adminLimiter,
  async (req, res, next) => {
    try {
      const Body = z.object({
        finding: z.string().min(1).max(500),
        multiplier: z.number().positive().max(1_000),
      });
      const parsed = Body.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid anomaly payload"));
        return;
      }
      const row = await flagAnomaly({
        storeSkillId: String(req.params["id"]),
        finding: parsed.data.finding,
        multiplier: parsed.data.multiplier,
      });
      res.json(ok(row));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

router.post(
  "/super/moderation/store/:id/user-report",
  adminLimiter,
  async (req, res, next) => {
    try {
      const Body = z.object({
        reportId: z.string().min(1).max(120),
        reporter: z.string().min(1).max(120),
        reason: z.string().min(1).max(2_000),
      });
      const parsed = Body.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid user-report payload"));
        return;
      }
      const row = await suspendOnUserReport({
        storeSkillId: String(req.params["id"]),
        reportId: parsed.data.reportId,
        reporter: parsed.data.reporter,
        reason: parsed.data.reason,
      });
      res.json(ok(row));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

router.post(
  "/super/moderation/rescan",
  adminLimiter,
  async (_req, res, next) => {
    try {
      const result = await rescanForVulnerabilities();
      res.json(ok(result));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

router.get(
  "/super/moderation/rescans",
  adminLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const Query = z.object({
        storeSkillId: z.string().min(1).max(120).optional(),
        cursor: z.string().min(1).max(2048).optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
      });
      const parsed = Query.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid query"));
        return;
      }
      const page = await listRescans(ctx, {
        storeSkillId: parsed.data.storeSkillId,
        cursor: parsed.data.cursor ?? null,
        limit: parsed.data.limit,
      });
      res.json(pageOk(page.items, page.nextCursor));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

/* ─── Appeals ───────────────────────────────────────────────────────── */

const ListAppealsSchema = z.object({
  status: z.enum(["pending", "upheld", "denied"]).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.get(
  "/super/moderation/appeals",
  adminLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = ListAppealsSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid query"));
        return;
      }
      const page = await listAppeals(ctx, {
        status: parsed.data.status,
        cursor: parsed.data.cursor ?? null,
        limit: parsed.data.limit,
      });
      res.json(pageOk(page.items, page.nextCursor));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

const DecideAppealSchema = z.object({
  decision: z.enum(["upheld", "denied"]),
  notes: z.string().max(2_000).optional(),
});

router.post(
  "/super/moderation/appeals/:id/decide",
  adminLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = DecideAppealSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid decision payload"));
        return;
      }
      const row = await decideAppeal(ctx, String(req.params["id"]), {
        decision: parsed.data.decision,
        seniorReviewer: actor(req as never),
        ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
      });
      res.json(ok(row));
    } catch (e) {
      if (handle(e, res)) return;
      next(e);
    }
  },
);

export default router;
