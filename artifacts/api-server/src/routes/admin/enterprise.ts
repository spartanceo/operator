/**
 * /api/admin/enterprise — per-tenant Enterprise Admin endpoints.
 *
 * Every route runs inside the calling tenant's context. RBAC is enforced
 * at the tenant boundary by `tenantScope`; the route handler never sees
 * another org's rows.
 */
import { Router, type IRouter } from "express";

import { ok, err, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { adminLimiter } from "../../middlewares/rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  buildUsageCsv,
  exportAuditCsv,
  getOrCreateOrg,
  getUsageReport,
  getWhitelist,
  inviteSeat,
  listOrgAuditLog,
  listSeats,
  removeSeat,
  SeatLimitExceededError,
  setWhitelistEntry,
  updateOrg,
  updateSeat,
} from "../../services/enterprise-admin.service";

const router: IRouter = Router();

function actor(req: { headers: Record<string, unknown>; session?: { user?: { email?: string } } }): string {
  const headerActor = req.headers["x-admin-actor"];
  if (typeof headerActor === "string" && headerActor.length > 0) return headerActor;
  return req.session?.user?.email ?? "enterprise_admin";
}

router.get("/enterprise/org", adminLimiter, requireTenant(), async (_req, res) => {
  const ctx = requireTenantContext();
  const org = await getOrCreateOrg(ctx);
  res.json(ok(org));
});

router.patch("/enterprise/org", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = req.body ?? {};
  const updated = await updateOrg(ctx, actor(req as never), {
    name: typeof body.name === "string" ? body.name : undefined,
    logoUrl: body.logoUrl === null ? null : typeof body.logoUrl === "string" ? body.logoUrl : undefined,
    primaryColor: typeof body.primaryColor === "string" ? body.primaryColor : undefined,
    plan: typeof body.plan === "string" ? body.plan : undefined,
    seatLimit: typeof body.seatLimit === "number" ? body.seatLimit : undefined,
    airGapped: typeof body.airGapped === "boolean" ? body.airGapped : undefined,
    ssoProvider: body.ssoProvider === null ? null : typeof body.ssoProvider === "string" ? body.ssoProvider : undefined,
    ssoDomain: body.ssoDomain === null ? null : typeof body.ssoDomain === "string" ? body.ssoDomain : undefined,
  });
  res.json(ok(updated));
});

router.get("/enterprise/seats", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : null;
  const limit = req.query["limit"] ? Number(req.query["limit"]) : undefined;
  const page = await listSeats(ctx, { cursor, limit });
  res.json(pageOk(page.items, page.nextCursor));
});

router.post("/enterprise/seats", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = req.body ?? {};
  if (typeof body.email !== "string" || body.email.length === 0) {
    res.status(400).json(err("INVALID_BODY", "`email` is required"));
    return;
  }
  try {
    const seat = await inviteSeat(ctx, actor(req as never), {
      email: body.email,
      displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      role: typeof body.role === "string" ? body.role as "admin" | "standard" | "readonly" : undefined,
    });
    res.json(ok(seat));
  } catch (e) {
    if (e instanceof SeatLimitExceededError) {
      res.status(409).json(err(e.code, e.message));
      return;
    }
    throw e;
  }
});

router.patch("/enterprise/seats/:id", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = req.body ?? {};
  const updated = await updateSeat(ctx, actor(req as never), String(req.params["id"]), {
    role: typeof body.role === "string" ? body.role : undefined,
    status: typeof body.status === "string" ? body.status : undefined,
    displayName: typeof body.displayName === "string" ? body.displayName : undefined,
  });
  if (!updated) {
    res.status(404).json(err("SEAT_NOT_FOUND", "Seat not found"));
    return;
  }
  res.json(ok(updated));
});

router.delete("/enterprise/seats/:id", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const result = await removeSeat(ctx, actor(req as never), String(req.params["id"]));
  res.json(ok(result));
});

router.get("/enterprise/whitelist", adminLimiter, requireTenant(), async (_req, res) => {
  const ctx = requireTenantContext();
  const items = await getWhitelist(ctx);
  res.json(ok({ items }));
});

router.put("/enterprise/whitelist/:slug", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = req.body ?? {};
  if (typeof body.allowed !== "boolean") {
    res.status(400).json(err("INVALID_BODY", "`allowed` must be a boolean"));
    return;
  }
  const entry = await setWhitelistEntry(ctx, actor(req as never), {
    skillSlug: String(req.params["slug"]),
    skillName: typeof body.skillName === "string" ? body.skillName : undefined,
    allowed: body.allowed,
  });
  res.json(ok(entry));
});

router.get("/enterprise/audit", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : null;
  const limit = req.query["limit"] ? Number(req.query["limit"]) : undefined;
  const page = await listOrgAuditLog(ctx, { cursor, limit });
  res.json(pageOk(page.items, page.nextCursor));
});

router.get("/enterprise/audit/export.csv", adminLimiter, requireTenant(), async (_req, res) => {
  const ctx = requireTenantContext();
  const csv = await exportAuditCsv(ctx);
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", 'attachment; filename="audit-log.csv"');
  res.send(csv);
});

router.get("/enterprise/usage", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const days = req.query["days"] ? Number(req.query["days"]) : undefined;
  const report = await getUsageReport(ctx, days);
  res.json(ok(report));
});

router.get("/enterprise/usage/export.csv", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const days = req.query["days"] ? Number(req.query["days"]) : undefined;
  const report = await getUsageReport(ctx, days);
  const csv = buildUsageCsv(report);
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", 'attachment; filename="usage-report.csv"');
  res.send(csv);
});

export default router;
