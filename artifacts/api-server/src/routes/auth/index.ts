/**
 * /api/auth — local sign-in / sign-up routes.
 *
 * Tier 1 keeps the JSON contract minimal: register / login both create a
 * `sessions` row and stamp the session id onto express-session. Logout
 * destroys both sides.
 *
 * Auth-bearing routes elsewhere read the session id from `req.session` and
 * resolve the row through `getSession` — never trust the cookie's claim
 * alone.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  AuthError,
  destroySession,
  getSession,
  login,
  registerOwner,
} from "../../services/auth.service";

const router: IRouter = Router();

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(256),
  displayName: z.string().min(1).max(120),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
});

declare module "express-session" {
  interface SessionData {
    sessionId?: string;
  }
}

router.post("/register", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid register payload"));
      return;
    }
    const result = await registerOwner(ctx, parsed.data);
    if (req.session) req.session.sessionId = result.sessionId;
    res.json(
      ok({
        user: result.user,
        expiresAt: result.expiresAt,
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.post("/login", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid login payload"));
      return;
    }
    const result = await login(ctx, parsed.data);
    if (req.session) req.session.sessionId = result.sessionId;
    res.json(ok({ user: result.user, expiresAt: result.expiresAt }));
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(e.status).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const sid = req.session?.sessionId;
    const tenantId = req.header("x-tenant-id");
    if (sid && tenantId) {
      await destroySession({ tenantId, requestId: "logout" }, sid);
    }
    if (req.session) {
      await new Promise<void>((resolve) => {
        req.session.destroy(() => resolve());
      });
    }
    res.json(ok({ loggedOut: true }));
  } catch (e) {
    next(e);
  }
});

router.get("/me", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const sid = req.session?.sessionId;
    if (!sid) {
      res.status(401).json(err("UNAUTHENTICATED", "No active session"));
      return;
    }
    const session = await getSession(ctx, sid);
    if (!session) {
      res.status(401).json(err("UNAUTHENTICATED", "Session expired or unknown"));
      return;
    }
    res.json(ok({ user: session.user, expiresAt: session.expiresAt }));
  } catch (e) {
    next(e);
  }
});

export default router;
