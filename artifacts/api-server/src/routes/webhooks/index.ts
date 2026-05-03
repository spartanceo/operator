/**
 * /api/webhooks — Developer SDK outbound webhook subscriptions (Task #14).
 *
 * Each subscription is a local URL that should receive a POST whenever
 * the in-process event bus publishes an event matching the
 * subscription's filter. Distinct from `/api/security/webhook-secrets`
 * which holds HMAC keys used to verify INBOUND provider webhooks.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  WebhookSubscriptionNotFoundError,
  WebhookSubscriptionValidationError,
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription,
} from "../../services/webhook-subscriptions.service";

const router: IRouter = Router();

const CreateSchema = z.object({
  url: z.string().min(1).max(2_048),
  label: z.string().max(200).optional(),
  eventTypes: z.array(z.string().min(1).max(80)).max(64).optional(),
  secret: z.string().min(8).max(512).optional(),
});

const UpdateSchema = z.object({
  url: z.string().min(1).max(2_048).optional(),
  label: z.string().max(200).optional(),
  eventTypes: z.array(z.string().min(1).max(80)).max(64).optional(),
  enabled: z.boolean().optional(),
  secret: z.string().min(8).max(512).nullable().optional(),
});

function handleError(e: unknown, res: import("express").Response): boolean {
  if (e instanceof WebhookSubscriptionValidationError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof WebhookSubscriptionNotFoundError) {
    res.status(404).json(err(e.code, e.message));
    return true;
  }
  return false;
}

router.get("/subscriptions", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listSubscriptions(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post("/subscriptions", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid subscription payload"));
      return;
    }
    const row = await createSubscription(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.get("/subscriptions/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getSubscription(ctx, String(req.params.id));
    if (!row) {
      res
        .status(404)
        .json(err("WEBHOOK_SUB_NOT_FOUND", `Unknown subscription ${req.params.id}`));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.patch("/subscriptions/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid subscription patch"));
      return;
    }
    const row = await updateSubscription(ctx, String(req.params.id), parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.delete("/subscriptions/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteSubscription(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
