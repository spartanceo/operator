/**
 * /api/security/jwt — issue and rotate the short-expiry admin token pair.
 *
 * Issuance is gated by a session cookie (the user must already be
 * signed in via /api/auth/login). Rotation accepts only the opaque
 * refresh token and rejects re-use through `jwt.service`.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { authLimiter } from "../../middlewares/auth-rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  issueTokenPair,
  JwtError,
  revokeRefreshToken,
  rotateRefreshToken,
} from "../../services/jwt.service";

const router: IRouter = Router();

const IssueSchema = z.object({
  userId: z.string().min(1).max(120),
  role: z.string().min(1).max(40).default("admin"),
});

const RotateSchema = z.object({
  refreshToken: z.string().min(8).max(2048),
  role: z.string().min(1).max(40).default("admin"),
});

const RevokeSchema = z.object({
  refreshToken: z.string().min(8).max(2048),
});

router.post("/jwt/issue", authLimiter, requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = IssueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid issue payload"));
      return;
    }
    const result = await issueTokenPair(ctx, parsed.data);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/jwt/rotate", authLimiter, requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RotateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid rotate payload"));
      return;
    }
    const result = await rotateRefreshToken(
      ctx,
      parsed.data.refreshToken,
      parsed.data.role,
    );
    res.json(ok(result));
  } catch (e) {
    if (e instanceof JwtError) {
      res.status(e.status).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post("/jwt/revoke", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RevokeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid revoke payload"));
      return;
    }
    const result = await revokeRefreshToken(ctx, parsed.data.refreshToken);
    res.json(ok({ revoked: result }));
  } catch (e) {
    next(e);
  }
});

export default router;
