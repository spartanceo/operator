/**
 * /api/comm/accounts — connected Gmail / Outlook / Calendar / Twilio rows.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  connectAccount,
  disconnectAccount,
  getAccount,
  listAccounts,
} from "../../services/comm/accounts.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const ConnectSchema = z.object({
  provider: z.enum([
    "gmail",
    "outlook",
    "google_calendar",
    "apple_calendar",
    "twilio",
  ]),
  label: z.string().min(1).max(200),
  accessToken: z.string().min(1).max(8000).optional(),
  refreshToken: z.string().min(1).max(8000).optional(),
  tokenExpiresAt: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
});

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listAccounts(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ConnectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid account payload"));
      return;
    }
    const row = await connectAccount(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getAccount(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Account not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await disconnectAccount(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
