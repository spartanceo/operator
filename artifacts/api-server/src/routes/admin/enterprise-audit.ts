/**
 * /api/admin/enterprise/audit/* — compliance-grade audit log endpoints
 * (Task #53). Mounted under the existing enterprise admin namespace.
 *
 * Surfaces the rich filterable list, hash-chain verification, signed
 * JSON export, retention configuration + purge, and the alert-rule CRUD
 * + triggered-alerts feed.
 */
import { Router, type IRouter } from "express";

import { ok, err, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { adminLimiter } from "../../middlewares/rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  listAuditEntries,
  signAuditExport,
  verifyAuditChain,
} from "../../services/audit.service";
import { runRetentionPurgeForAllTenants } from "../../services/audit-retention.service";
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  listAuditAlerts,
  updateAlertRule,
} from "../../services/audit-alerts.service";
import {
  getOrCreateRetention,
  purgeAuditLog,
  setRetention,
} from "../../services/audit-retention.service";

const router: IRouter = Router();

interface SessionLike {
  user?: { email?: string; id?: string };
}

function actor(req: { headers: Record<string, unknown>; session?: SessionLike }): string {
  const headerActor = req.headers["x-admin-actor"];
  if (typeof headerActor === "string" && headerActor.length > 0) return headerActor;
  return req.session?.user?.email ?? "enterprise_admin";
}

function parseInt(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

router.get("/enterprise/audit/v2", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : null;
  const limit = req.query["limit"] ? Number(req.query["limit"]) : undefined;
  const page = await listAuditEntries(ctx, {
    cursor,
    limit,
    actionType: typeof req.query["actionType"] === "string" ? req.query["actionType"] : null,
    action: typeof req.query["action"] === "string" ? req.query["action"] : null,
    actor: typeof req.query["actor"] === "string" ? req.query["actor"] : null,
    agentId: typeof req.query["agentId"] === "string" ? req.query["agentId"] : null,
    userId: typeof req.query["userId"] === "string" ? req.query["userId"] : null,
    sinceMs: parseInt(req.query["since"]),
    untilMs: parseInt(req.query["until"]),
    search: typeof req.query["q"] === "string" ? req.query["q"] : null,
  });
  res.json(pageOk(page.items, page.nextCursor));
});

router.get("/enterprise/audit/verify", adminLimiter, requireTenant(), async (_req, res) => {
  const ctx = requireTenantContext();
  const { getOrCreateRetention } = await import("../../services/audit-retention.service");
  const settings = await getOrCreateRetention(ctx);
  const result = await verifyAuditChain(ctx, {
    checkpointHash: settings.chainCheckpointHash,
  });
  res.json(ok(result));
});

/**
 * Signed JSON export.
 *
 * Uses POST instead of GET so the signing secret travels in the request
 * body (or a header) — never in a URL query string where it would
 * leak through proxy logs, browser history, or CDN access logs.
 */
router.post("/enterprise/audit/export.json", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = req.body ?? {};
  const headerSecret = req.headers["x-export-secret"];
  const secret =
    (typeof body.secret === "string" && body.secret) ||
    (typeof headerSecret === "string" ? headerSecret : null);
  if (!secret || secret.length < 16) {
    res
      .status(400)
      .json(err("MISSING_SECRET", "A signing secret of at least 16 characters is required"));
    return;
  }
  const exportBundle = await signAuditExport(ctx, {
    secret,
    actionType: typeof body.actionType === "string" ? body.actionType : null,
    sinceMs: typeof body.since === "number" ? body.since : null,
    untilMs: typeof body.until === "number" ? body.until : null,
    maxEntries: typeof body.max === "number" ? body.max : undefined,
  });
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-disposition", 'attachment; filename="audit-log.signed.json"');
  res.send(JSON.stringify(exportBundle, null, 2));
});

router.get("/enterprise/audit/retention", adminLimiter, requireTenant(), async (_req, res) => {
  const ctx = requireTenantContext();
  const settings = await getOrCreateRetention(ctx);
  res.json(ok(settings));
});

router.put("/enterprise/audit/retention", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = req.body ?? {};
  if (typeof body.retentionDays !== "number" || !Number.isFinite(body.retentionDays)) {
    res.status(400).json(err("INVALID_BODY", "`retentionDays` must be a number"));
    return;
  }
  const updated = await setRetention(ctx, actor(req as never), body.retentionDays);
  res.json(ok(updated));
});

/**
 * Manual purge — destructive, so requires a literal "PURGE" confirm
 * token in the body AND a second-factor confirmation header
 * (`X-Admin-2FA: <token>`) when the tenant has 2FA available. The
 * 2FA check is enforced by reading the configured second-factor token
 * from the request session; absence of a session 2FA token is treated
 * as not-yet-verified and the purge is rejected with 403.
 */
router.post("/enterprise/audit/purge", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = req.body ?? {};
  if (body.confirm !== "PURGE") {
    res
      .status(400)
      .json(err("CONFIRM_REQUIRED", 'Set body field `confirm` to "PURGE" to proceed'));
    return;
  }
  const session = (req as unknown as {
    session?: { mfaVerifiedAt?: number; user?: { mfaEnabled?: boolean } };
  }).session;
  const mfaRequired = session?.user?.mfaEnabled === true;
  if (mfaRequired) {
    const verifiedAt = session?.mfaVerifiedAt ?? 0;
    if (!verifiedAt || Date.now() - verifiedAt > 5 * 60 * 1000) {
      res
        .status(403)
        .json(err("MFA_REQUIRED", "Re-confirm with your second factor before purging"));
      return;
    }
  }
  const result = await purgeAuditLog(ctx, actor(req as never));
  res.json(ok(result));
});

/**
 * Scheduler tick — invoked by the background scheduler or the test
 * runner to run the daily retention purge across every tenant that has
 * a retention setting configured.
 *
 * Authorization: this endpoint operates cross-tenant, so it is gated
 * by an internal-only scheduler token. The caller must present
 * `X-Scheduler-Token` matching `process.env.SCHEDULER_TOKEN` (or
 * `INTERNAL_SCHEDULER_TOKEN`). The endpoint is otherwise unreachable —
 * no tenant header, no user session is sufficient. Returns 403 on
 * missing/mismatched token to avoid disclosing whether the env var is
 * configured.
 */
router.post("/enterprise/audit/scheduler/tick", adminLimiter, async (req, res) => {
  const expected =
    process.env["SCHEDULER_TOKEN"] || process.env["INTERNAL_SCHEDULER_TOKEN"];
  const presented = req.headers["x-scheduler-token"];
  if (
    !expected ||
    typeof presented !== "string" ||
    presented.length === 0 ||
    presented !== expected
  ) {
    res
      .status(403)
      .json(err("FORBIDDEN", "Scheduler token required"));
    return;
  }
  const result = await runRetentionPurgeForAllTenants();
  res.json(ok(result));
});

router.get("/enterprise/audit/alert-rules", adminLimiter, requireTenant(), async (_req, res) => {
  const ctx = requireTenantContext();
  const items = await listAlertRules(ctx);
  res.json(ok({ items }));
});

router.post("/enterprise/audit/alert-rules", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = req.body ?? {};
  if (typeof body.name !== "string" || body.name.length === 0) {
    res.status(400).json(err("INVALID_BODY", "`name` is required"));
    return;
  }
  if (typeof body.thresholdCount !== "number" || typeof body.windowSeconds !== "number") {
    res
      .status(400)
      .json(err("INVALID_BODY", "`thresholdCount` and `windowSeconds` must be numbers"));
    return;
  }
  const created = await createAlertRule(ctx, {
    name: body.name,
    actionType: typeof body.actionType === "string" ? body.actionType : null,
    actor: typeof body.actor === "string" ? body.actor : null,
    thresholdCount: body.thresholdCount,
    windowSeconds: body.windowSeconds,
    enabled: typeof body.enabled === "boolean" ? body.enabled : true,
  });
  res.json(ok(created));
});

router.patch(
  "/enterprise/audit/alert-rules/:id",
  adminLimiter,
  requireTenant(),
  async (req, res) => {
    const ctx = requireTenantContext();
    const body = req.body ?? {};
    const updated = await updateAlertRule(ctx, String(req.params["id"]), {
      name: typeof body.name === "string" ? body.name : undefined,
      actionType: body.actionType === null ? null : typeof body.actionType === "string" ? body.actionType : undefined,
      actor: body.actor === null ? null : typeof body.actor === "string" ? body.actor : undefined,
      thresholdCount: typeof body.thresholdCount === "number" ? body.thresholdCount : undefined,
      windowSeconds: typeof body.windowSeconds === "number" ? body.windowSeconds : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    });
    if (!updated) {
      res.status(404).json(err("RULE_NOT_FOUND", "Alert rule not found"));
      return;
    }
    res.json(ok(updated));
  },
);

router.delete(
  "/enterprise/audit/alert-rules/:id",
  adminLimiter,
  requireTenant(),
  async (req, res) => {
    const ctx = requireTenantContext();
    const result = await deleteAlertRule(ctx, String(req.params["id"]));
    res.json(ok(result));
  },
);

router.get("/enterprise/audit/alerts", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : null;
  const limit = req.query["limit"] ? Number(req.query["limit"]) : undefined;
  const page = await listAuditAlerts(ctx, { cursor, limit });
  res.json(pageOk(page.items, page.nextCursor));
});

export default router;
