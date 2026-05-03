/**
 * /admin/tenant-data — GDPR data portability + erasure.
 *
 * GET    → returns the requesting tenant's snapshot (data export).
 * DELETE → soft-deletes the tenant (data erasure receipt).
 *
 * Both routes:
 *   - require a tenant context (`requireTenant()`),
 *   - flow through the tight admin rate limiter (5 req/min),
 *   - delegate the actual database work to the admin service so the route
 *     handler stays a thin envelope-translation layer.
 */
import { Router, type IRouter } from "express";

import { ok, err } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { adminLimiter } from "../../middlewares/rate-limit";
import { requireTenant, requireRole } from "../../middlewares/tenant-context";
import {
  eraseTenantData,
  exportTenantData,
} from "../../services/admin.service";

const router: IRouter = Router();

router.get("/tenant-data", adminLimiter, requireTenant(), requireRole("owner", "admin"), async (_req, res) => {
  const ctx = requireTenantContext();
  const snapshot = await exportTenantData(ctx);
  if (!snapshot) {
    res.status(404).json(err("TENANT_NOT_FOUND", "Tenant has no data to export"));
    return;
  }
  res.json(ok(snapshot));
});

router.delete(
  "/tenant-data",
  adminLimiter,
  requireTenant(),
  requireRole("owner"),
  async (_req, res) => {
    const ctx = requireTenantContext();
    const receipt = await eraseTenantData(ctx);
    if (!receipt) {
      res
        .status(404)
        .json(err("TENANT_NOT_FOUND", "No tenant matched the request context"));
      return;
    }
    res.json(ok(receipt));
  },
);

export default router;
