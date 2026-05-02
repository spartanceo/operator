/**
 * /api/security/audit — read access to the tamper-evident audit log
 * and an explicit chain-verification endpoint.
 *
 * Append is not exposed via HTTP — every server-side action that
 * deserves an audit row appends through the service directly. The
 * read-side endpoints here are for the Settings → Security panel.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  listAuditEntries,
  verifyAuditChain,
} from "../../services/audit.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.get("/audit", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listAuditEntries(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/audit/verify", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await verifyAuditChain(ctx);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
