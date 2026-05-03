/**
 * /api/admin/super — Super Admin (OP team) endpoints.
 *
 * All routes flow through the tight `adminLimiter` so brute-force or
 * runaway clients are throttled. The "actor" string used in audit
 * entries comes from the request session if present, otherwise the
 * caller-supplied `X-Admin-Actor` header — the OP team's own auth
 * proxy must populate this header in production deployments.
 */
import { Router, type IRouter } from "express";

import { ok, err, pageOk } from "../../lib/api-envelope";
import { adminLimiter } from "../../middlewares/rate-limit";
import {
  approveSkillSubmission,
  banCreator,
  createAbuseReport,
  getCurrentAppVersion,
  getPlatformOverview,
  getRevenueOverview,
  getSkillAnalytics,
  listAbuseReports,
  listAppVersions,
  listCreators,
  listFeatureFlags,
  listModerationQueue,
  publishAppVersion,
  rejectSkillSubmission,
  removeStoreSkill,
  resolveAbuseReport,
  upsertFeatureFlag,
} from "../../services/super-admin.service";

const router: IRouter = Router();

function actor(req: { headers: Record<string, unknown>; session?: { user?: { email?: string } } }): string {
  const headerActor = req.headers["x-admin-actor"];
  if (typeof headerActor === "string" && headerActor.length > 0) return headerActor;
  return req.session?.user?.email ?? "super_admin";
}

router.get("/super/overview", adminLimiter, async (_req, res) => {
  const data = await getPlatformOverview();
  res.json(ok(data));
});

router.get("/super/revenue", adminLimiter, async (_req, res) => {
  const data = await getRevenueOverview();
  res.json(ok(data));
});

router.get("/super/skill-analytics", adminLimiter, async (_req, res) => {
  const data = await getSkillAnalytics();
  res.json(ok(data));
});

router.get("/super/moderation/queue", adminLimiter, async (req, res) => {
  const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : null;
  const limit = req.query["limit"] ? Number(req.query["limit"]) : undefined;
  const page = await listModerationQueue({ cursor, limit });
  res.json(pageOk(page.items, page.nextCursor));
});

router.post("/super/moderation/:id/approve", adminLimiter, async (req, res) => {
  const reviewer = actor(req as never);
  const notes = typeof req.body?.notes === "string" ? req.body.notes : undefined;
  const result = await approveSkillSubmission({ draftId: String(req.params["id"]), reviewer, notes });
  res.json(ok(result));
});

router.post("/super/moderation/:id/reject", adminLimiter, async (req, res) => {
  const reviewer = actor(req as never);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "No reason provided";
  const result = await rejectSkillSubmission({ draftId: String(req.params["id"]), reviewer, reason });
  res.json(ok(result));
});

router.post("/super/moderation/store/:id/remove", adminLimiter, async (req, res) => {
  const reviewer = actor(req as never);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Removed by moderator";
  const result = await removeStoreSkill({ storeSkillId: String(req.params["id"]), reviewer, reason });
  res.json(ok(result));
});

router.get("/super/creators", adminLimiter, async (req, res) => {
  const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : null;
  const limit = req.query["limit"] ? Number(req.query["limit"]) : undefined;
  const page = await listCreators({ cursor, limit });
  res.json(pageOk(page.items, page.nextCursor));
});

router.post("/super/creators/:id/ban", adminLimiter, async (req, res) => {
  const reviewer = actor(req as never);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Policy violation";
  const result = await banCreator({ creatorId: String(req.params["id"]), reviewer, reason });
  res.json(ok(result));
});

router.get("/super/feature-flags", adminLimiter, async (_req, res) => {
  const items = await listFeatureFlags();
  res.json(ok({ items }));
});

router.put("/super/feature-flags/:key", adminLimiter, async (req, res) => {
  const reviewer = actor(req as never);
  const body = req.body ?? {};
  if (typeof body.enabled !== "boolean") {
    res.status(400).json(err("INVALID_BODY", "`enabled` must be a boolean"));
    return;
  }
  const row = await upsertFeatureFlag({
    flagKey: String(req.params["key"]),
    enabled: body.enabled,
    segment: typeof body.segment === "string" ? body.segment : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    rolloutPercent:
      typeof body.rolloutPercent === "number" ? body.rolloutPercent : undefined,
    reviewer,
  });
  res.json(ok(row));
});

router.get("/super/versions", adminLimiter, async (_req, res) => {
  const items = await listAppVersions();
  res.json(ok({ items }));
});

router.post("/super/versions", adminLimiter, async (req, res) => {
  const reviewer = actor(req as never);
  const body = req.body ?? {};
  if (typeof body.versionString !== "string" || body.versionString.length === 0) {
    res.status(400).json(err("INVALID_BODY", "`versionString` is required"));
    return;
  }
  const row = await publishAppVersion({
    versionString: body.versionString,
    channel: typeof body.channel === "string" ? body.channel : undefined,
    isCurrent: Boolean(body.isCurrent),
    isMinRequired: Boolean(body.isMinRequired),
    notes: typeof body.notes === "string" ? body.notes : undefined,
    reviewer,
  });
  res.json(ok(row));
});

router.get("/super/versions/current", adminLimiter, async (req, res) => {
  const channel = typeof req.query["channel"] === "string" ? req.query["channel"] : "stable";
  const row = await getCurrentAppVersion(channel);
  if (!row) {
    res.status(404).json(err("NO_CURRENT_VERSION", `No current version on channel ${channel}`));
    return;
  }
  res.json(ok(row));
});

router.get("/super/abuse", adminLimiter, async (req, res) => {
  const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
  const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : null;
  const limit = req.query["limit"] ? Number(req.query["limit"]) : undefined;
  const page = await listAbuseReports({ status, cursor, limit });
  res.json(pageOk(page.items, page.nextCursor));
});

router.post("/super/abuse", adminLimiter, async (req, res) => {
  const body = req.body ?? {};
  if (typeof body.targetType !== "string" || typeof body.targetId !== "string" || typeof body.reason !== "string") {
    res.status(400).json(err("INVALID_BODY", "`targetType`, `targetId`, `reason` are required"));
    return;
  }
  const row = await createAbuseReport({
    targetType: body.targetType,
    targetId: body.targetId,
    targetLabel: typeof body.targetLabel === "string" ? body.targetLabel : undefined,
    reason: body.reason,
    severity: typeof body.severity === "string" ? body.severity : undefined,
    reporterLabel: typeof body.reporterLabel === "string" ? body.reporterLabel : undefined,
  });
  res.json(ok(row));
});

router.post("/super/abuse/:id/resolve", adminLimiter, async (req, res) => {
  const reviewer = actor(req as never);
  const body = req.body ?? {};
  const status = body.status === "dismissed" ? "dismissed" : "resolved";
  const result = await resolveAbuseReport({
    reportId: String(req.params["id"]),
    status,
    notes: typeof body.notes === "string" ? body.notes : undefined,
    reviewer,
  });
  res.json(ok(result));
});

export default router;
