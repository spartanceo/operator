/**
 * /api/security/webhook-secrets — manage HMAC keys for inbound /
 * outbound webhooks.
 *
 * The created secret is returned in plaintext exactly once (POST /).
 * Subsequent reads return only metadata; the stored value is never
 * surfaced again by the API.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  createWebhookSecret,
  listWebhookSecrets,
  revokeWebhookSecret,
  WebhookError,
} from "../../services/webhook.service";

const router: IRouter = Router();

const CreateSchema = z.object({
  endpoint: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
});

const ListQuery = z.object({
  endpoint: z.string().min(1).max(120).optional(),
});

router.get("/webhook-secrets", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query params"));
      return;
    }
    const items = await listWebhookSecrets(ctx, parsed.data.endpoint);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post("/webhook-secrets", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid webhook-secret payload"));
      return;
    }
    const created = await createWebhookSecret(ctx, parsed.data);
    res.json(ok(created));
  } catch (e) {
    if (e instanceof WebhookError) {
      res.status(e.status).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.delete("/webhook-secrets/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = typeof req.params["id"] === "string" ? req.params["id"] : "";
    const result = await revokeWebhookSecret(ctx, id);
    res.json(ok(result));
  } catch (e) {
    if (e instanceof WebhookError) {
      res.status(e.status).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

export default router;
