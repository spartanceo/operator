/**
 * /api/security/master-password — set / verify / status / biometric.
 *
 * Setting the password is rate-limited at the auth tier (Standard 12)
 * because a brute-force loop here is the most attractive attack surface.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { authLimiter } from "../../middlewares/auth-rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  getMasterPasswordStatus,
  MasterPasswordError,
  setBiometricEnabled,
  setMasterPassword,
  unlockWithBiometric,
  verifyMasterPassword,
} from "../../services/master-password.service";

const router: IRouter = Router();

const SetSchema = z.object({
  newPassword: z.string().min(12).max(256),
  currentPassword: z.string().min(1).max(256).optional(),
});

const VerifySchema = z.object({
  password: z.string().min(1).max(256),
});

const BiometricSchema = z.object({
  enabled: z.boolean(),
});

router.get("/master-password/status", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await getMasterPasswordStatus(ctx)));
  } catch (e) {
    next(e);
  }
});

router.post(
  "/master-password",
  authLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = SetSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid master-password payload"));
        return;
      }
      const status = await getMasterPasswordStatus(ctx);
      if (status.isSet) {
        if (!parsed.data.currentPassword) {
          res.status(400).json(err("VALIDATION", "currentPassword required to rotate"));
          return;
        }
        const verify = await verifyMasterPassword(ctx, parsed.data.currentPassword);
        if (!verify.success) {
          res.status(401).json(err("INVALID_CURRENT_PASSWORD", "Current password is incorrect"));
          return;
        }
      }
      const result = await setMasterPassword(ctx, parsed.data.newPassword);
      res.json(ok(result));
    } catch (e) {
      if (e instanceof MasterPasswordError) {
        res.status(e.status).json(err(e.code, e.message));
        return;
      }
      next(e);
    }
  },
);

router.post(
  "/master-password/verify",
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
      const result = await verifyMasterPassword(ctx, parsed.data.password);
      res.json(ok(result));
    } catch (e) {
      if (e instanceof MasterPasswordError) {
        res.status(e.status).json(err(e.code, e.message));
        return;
      }
      next(e);
    }
  },
);

router.post(
  "/master-password/biometric",
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = BiometricSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid biometric payload"));
        return;
      }
      const result = await setBiometricEnabled(ctx, parsed.data.enabled);
      res.json(ok(result));
    } catch (e) {
      if (e instanceof MasterPasswordError) {
        res.status(e.status).json(err(e.code, e.message));
        return;
      }
      next(e);
    }
  },
);

router.post(
  "/master-password/biometric/unlock",
  requireTenant(),
  async (_req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const result = await unlockWithBiometric(ctx);
      res.json(ok(result));
    } catch (e) {
      if (e instanceof MasterPasswordError) {
        res.status(e.status).json(err(e.code, e.message));
        return;
      }
      next(e);
    }
  },
);

export default router;
