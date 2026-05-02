/**
 * HMAC verification middleware for inbound webhooks.
 *
 * The route caller specifies the `endpoint` string the secret was
 * registered under (e.g. "stripe", "resend"). The middleware:
 *
 *   1. Captures the raw body (Express has already parsed JSON, so we
 *      re-serialise canonically — the producer must sign the same
 *      canonical form OR the route opts-in to `rawBody` mode).
 *   2. Reads `X-Webhook-Signature` (or a configured alternative).
 *   3. Calls `verifyInboundPayload()` against every active secret for
 *      the endpoint; rejects with 401 + INVALID_SIGNATURE on miss.
 *
 * For producers that sign the literal byte stream (Stripe-style), mount
 * `express.raw({ type: "*\/*" })` BEFORE this middleware on the
 * matching route so `req.body` is a Buffer.
 */
import type { NextFunction, Request, Response } from "express";

import { err } from "../lib/api-envelope";
import { requireTenantContext } from "../lib/tenant-context";
import { verifyInboundPayload } from "../services/webhook.service";

export interface HmacVerifyOptions {
  readonly endpoint: string;
  readonly headerName?: string;
}

export function hmacVerify(opts: HmacVerifyOptions) {
  const headerName = (opts.headerName ?? "x-webhook-signature").toLowerCase();
  return async function hmacVerifyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const ctx = requireTenantContext();
      const signature = req.header(headerName);
      if (!signature) {
        res.status(401).json(err("MISSING_SIGNATURE", `Missing ${headerName} header`));
        return;
      }
      const payload =
        Buffer.isBuffer(req.body)
          ? req.body.toString("utf8")
          : typeof req.body === "string"
            ? req.body
            : JSON.stringify(req.body ?? {});
      const result = await verifyInboundPayload(ctx, opts.endpoint, payload, signature);
      if (!result.valid) {
        res.status(401).json(err("INVALID_SIGNATURE", "Webhook signature did not match"));
        return;
      }
      res.locals["webhookSecretId"] = result.secretId;
      next();
    } catch (e) {
      next(e);
    }
  };
}
