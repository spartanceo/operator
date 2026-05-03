/**
 * /api/subscription — billing, gating, and usage endpoints (Task #6).
 *
 * Stripe integration is offline-stub by default; flip on by setting
 * `OMNINITY_STRIPE_SECRET` and `OMNINITY_STRIPE_PRICE_ID`. The route
 * surface is identical in both modes so the operator UI doesn't branch.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../lib/api-envelope";
import { requireTenantContext } from "../lib/tenant-context";
import { requireTenant } from "../middlewares/tenant-context";
import {
  cancel,
  confirmCheckout,
  createCheckoutSession,
  getStatus,
  handleWebhook,
  listMonthlyUsage,
  reactivate,
} from "../services/subscription.service";

const router: IRouter = Router();

router.get("/status", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await getStatus(ctx)));
  } catch (e) {
    next(e);
  }
});

const CheckoutSchema = z.object({
  successPath: z.string().min(1).max(500).optional(),
  cancelPath: z.string().min(1).max(500).optional(),
});

router.post("/checkout", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CheckoutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid checkout payload"));
      return;
    }
    res.json(ok(await createCheckoutSession(ctx, parsed.data)));
  } catch (e) {
    next(e);
  }
});

const ConfirmSchema = z.object({ sessionId: z.string().min(1).max(200) });

router.post("/checkout/confirm", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Missing sessionId"));
      return;
    }
    res.json(ok(await confirmCheckout(ctx, parsed.data.sessionId)));
  } catch (e) {
    next(e);
  }
});

router.post("/cancel", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await cancel(ctx)));
  } catch (e) {
    next(e);
  }
});

router.post("/reactivate", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await reactivate(ctx)));
  } catch (e) {
    next(e);
  }
});

const WebhookSchema = z.object({
  type: z.string().min(1).max(120),
  data: z.record(z.unknown()).optional(),
});

router.post("/webhook", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = WebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid webhook payload"));
      return;
    }
    res.json(ok(await handleWebhook(ctx, parsed.data)));
  } catch (e) {
    next(e);
  }
});

router.get("/usage", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await listMonthlyUsage(ctx)));
  } catch (e) {
    next(e);
  }
});

export default router;
