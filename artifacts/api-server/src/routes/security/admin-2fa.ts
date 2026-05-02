/**
 * /api/security/admin-2fa — TOTP enrollment + verification for admins.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { authLimiter } from "../../middlewares/auth-rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  AdminTwoFactorError,
  confirm2fa,
  revoke2fa,
  setup2fa,
  verify2fa,
} from "../../services/admin-2fa.service";

const router: IRouter = Router();

const SetupSchema = z.object({
  userId: z.string().min(1).max(120),
  accountLabel: z.string().min(1).max(200),
});

const ConfirmSchema = z.object({
  userId: z.string().min(1).max(120),
  code: z.string().regex(/^\d{6}$/),
});

const VerifySchema = ConfirmSchema;

const RevokeSchema = z.object({
  userId: z.string().min(1).max(120),
});

router.post("/admin-2fa/setup", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SetupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid setup payload"));
      return;
    }
    const result = await setup2fa(ctx, parsed.data.userId, parsed.data.accountLabel);
    res.json(ok(result));
  } catch (e) {
    if (e instanceof AdminTwoFactorError) {
      res.status(e.status).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post(
  "/admin-2fa/confirm",
  authLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = ConfirmSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid confirm payload"));
        return;
      }
      const result = await confirm2fa(ctx, parsed.data.userId, parsed.data.code);
      res.json(ok(result));
    } catch (e) {
      if (e instanceof AdminTwoFactorError) {
        res.status(e.status).json(err(e.code, e.message));
        return;
      }
      next(e);
    }
  },
);

router.post(
  "/admin-2fa/verify",
  authLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = VerifySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid verify payload"));
        return;
      }
      const result = await verify2fa(ctx, parsed.data.userId, parsed.data.code);
      res.json(ok(result));
    } catch (e) {
      if (e instanceof AdminTwoFactorError) {
        res.status(e.status).json(err(e.code, e.message));
        return;
      }
      next(e);
    }
  },
);

router.post("/admin-2fa/revoke", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RevokeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid revoke payload"));
      return;
    }
    await revoke2fa(ctx, parsed.data.userId);
    res.json(ok({ revoked: true }));
  } catch (e) {
    next(e);
  }
});

export default router;
